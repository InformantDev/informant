import { createHmac, createSign, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { hostname, platform } from "node:os";
import { workerCapabilities } from "./capabilities.ts";
import { refreshSelectedContainerBackend } from "./container-backend.ts";
import type { ClaimScheduling, NetworkClaimant } from "./coordinator.ts";
import { currentExecutionCapacity, type ExecutionCapacitySnapshot } from "./execution-capacity.ts";
import {
  clearTailscaleConfig,
  type GitHubCredentials,
  getTailscaleConfig,
  listAllowedMounts,
  listGitHubCredentials,
  listRepositories,
  MAX_ALLOWED_MOUNT_BYTES,
  saveTailscaleConfig,
  type TailscaleConfig,
} from "./machine-config.ts";
import { command } from "./process.ts";
import { type ServerOptions, serveRepositories } from "./server.ts";
import {
  getBuild,
  jobLogPath,
  listActiveBuilds,
  listBuilds,
  reconcileBuildLiveness,
} from "./store.ts";
import type { BuildRecord, Repository } from "./types.ts";

const API = "https://api.github.com";
export const DEFAULT_WORKER_PORT = 7639;
export const DEFAULT_FUNNEL_PORT = 7640;
const REQUEST_TIMEOUT_MS = 2_000;
const PEER_REFRESH_INTERVAL_MS = 10_000;
const MAX_DISPATCH_RETRY_MS = 60_000;
const CLAIM_SCHEDULING_PROTOCOL = "claim-scheduling-v1";
export const MAX_WEBHOOK_BODY_BYTES = 25 * 1024 * 1024;
export const REQUIRED_GITHUB_WEBHOOK_EVENTS = [
  "push",
  "pull_request",
  "issue_comment",
  "check_suite",
] as const;
const MACOS_TAILSCALE = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export interface TailscalePeer {
  id: string;
  hostName: string;
  dnsName?: string;
  addresses: string[];
  online: boolean;
}

export interface TailscaleStatus {
  executable: string;
  online: boolean;
  self: TailscalePeer;
  peers: TailscalePeer[];
}

interface RawNode {
  ID?: string;
  HostName?: string;
  DNSName?: string;
  TailscaleIPs?: string[];
  Online?: boolean;
}

interface RawStatus {
  BackendState?: string;
  Self?: RawNode;
  Peer?: Record<string, RawNode>;
}

export interface NetworkWorker {
  id: string;
  hostName: string;
  address: string;
  capabilities: string[];
  repositories: string[];
  protocols?: string[];
  resources?: ExecutionCapacitySnapshot;
  version?: string;
  local?: boolean;
}

export interface RepositoryDispatch {
  repository: Repository;
  forceTagPoll: boolean;
  claimPlan?: NetworkClaimPlan;
}

export function reconcileKnownWorkers(
  knownWorkers: Map<string, NetworkWorker>,
  discoveredWorkers: NetworkWorker[],
): void {
  const discoveredIds = new Set(discoveredWorkers.map((worker) => worker.id));
  for (const id of knownWorkers.keys()) {
    if (!discoveredIds.has(id)) knownWorkers.delete(id);
  }
  for (const worker of discoveredWorkers) knownWorkers.set(worker.id, worker);
}

export function startupRecoveryRequests(repositories: Repository[]): RepositoryDispatch[] {
  return repositories.map((repository) => ({ repository, forceTagPoll: true }));
}

export function addedRepositoryRecoveryRequests(
  previous: Repository[],
  current: Repository[],
): RepositoryDispatch[] {
  const existing = new Set(previous.map((repository) => repository.fullName.toLowerCase()));
  return startupRecoveryRequests(
    current.filter((repository) => !existing.has(repository.fullName.toLowerCase())),
  );
}

type RetryTimer = ReturnType<typeof setTimeout>;

export class RepositoryScanQueue {
  private readonly registrations = new Map<
    string,
    { repository: Repository; controller: AbortController }
  >();
  private readonly scans = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(
    repositories: Repository[],
    private readonly execute: (
      repository: Repository,
      forceTagPoll: boolean,
      signal: AbortSignal,
      claimScheduling?: ClaimScheduling,
    ) => Promise<void>,
    private readonly serviceSignal?: AbortSignal,
  ) {
    this.reconcile(repositories);
  }

  reconcile(repositories: Repository[]): void {
    if (this.stopped) return;
    const next = new Map(
      repositories.map((repository) => [repository.fullName.toLowerCase(), repository]),
    );
    for (const [key, registration] of this.registrations) {
      if (next.has(key)) continue;
      registration.controller.abort(`${registration.repository.fullName} is no longer registered.`);
      this.registrations.delete(key);
    }
    for (const [key, repository] of next) {
      const registration = this.registrations.get(key);
      if (registration) registration.repository = repository;
      else this.registrations.set(key, { repository, controller: new AbortController() });
    }
  }

  run(
    repository: Repository,
    forceTagPoll = false,
    claimScheduling?: ClaimScheduling,
  ): Promise<void> {
    const key = repository.fullName.toLowerCase();
    const registration = this.registrations.get(key);
    if (this.stopped || !registration) return Promise.resolve();
    const previous = this.scans.get(key) ?? Promise.resolve();
    let next!: Promise<void>;
    next = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.stopped || registration.controller.signal.aborted) return;
        const signal = this.serviceSignal
          ? AbortSignal.any([registration.controller.signal, this.serviceSignal])
          : registration.controller.signal;
        if (signal.aborted) return;
        await this.execute(registration.repository, forceTagPoll, signal, claimScheduling);
      })
      .finally(() => {
        if (this.scans.get(key) === next) this.scans.delete(key);
      });
    this.scans.set(key, next);
    return next;
  }

  async stop(reason: unknown = "Worker shutdown requested."): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      for (const registration of this.registrations.values()) {
        registration.controller.abort(reason);
      }
    }
    await Promise.allSettled(this.scans.values());
    this.registrations.clear();
    this.scans.clear();
  }
}

export class DispatchRetryQueue {
  private readonly entries = new Map<
    string,
    {
      request: RepositoryDispatch;
      attempts: number;
      pending: boolean;
      running?: Promise<void>;
      timer?: RetryTimer;
    }
  >();
  private stopped = false;

  constructor(
    private readonly dispatch: (request: RepositoryDispatch) => Promise<boolean>,
    private readonly onRetry: (request: RepositoryDispatch, delayMs: number) => void = () => {},
    private readonly schedule: (callback: () => void, delayMs: number) => RetryTimer = setTimeout,
    private readonly cancel: (timer: RetryTimer) => void = clearTimeout,
  ) {}

  enqueue(request: RepositoryDispatch): void {
    if (this.stopped) return;
    const key = request.repository.fullName.toLowerCase();
    const existing = this.entries.get(key);
    if (existing) {
      existing.request.forceTagPoll ||= request.forceTagPoll;
      existing.request.claimPlan = request.claimPlan;
      if (existing.running) existing.pending = true;
      return;
    }
    this.entries.set(key, { request, attempts: 0, pending: false });
    this.run(key);
  }

  get size(): number {
    return this.entries.size;
  }

  private run(key: string): void {
    const entry = this.entries.get(key);
    if (!entry || entry.running) return;
    entry.timer = undefined;
    entry.pending = false;
    const request = { ...entry.request };
    entry.request.forceTagPoll = false;
    const retry = () => {
      const current = this.entries.get(key);
      if (!current) return;
      current.running = undefined;
      current.request.forceTagPoll ||= request.forceTagPoll;
      if (this.stopped) return;
      current.attempts++;
      const delayMs = Math.min(1_000 * 2 ** (current.attempts - 1), MAX_DISPATCH_RETRY_MS);
      this.onRetry(current.request, delayMs);
      current.timer = this.schedule(() => this.run(key), delayMs);
    };
    entry.running = this.dispatch(request)
      .then((succeeded) => {
        if (!succeeded) return retry();
        const current = this.entries.get(key);
        if (!current) return;
        current.running = undefined;
        current.attempts = 0;
        if (current.pending && !this.stopped) {
          this.run(key);
          return;
        }
        this.entries.delete(key);
      })
      .catch(retry);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const running: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      if (entry.timer) this.cancel(entry.timer);
      if (entry.running) running.push(entry.running);
    }
    await Promise.allSettled(running);
    this.entries.clear();
  }
}

class WebhookBodyTooLargeError extends Error {}

export async function readWebhookBody(
  request: Request,
  maximumBytes = MAX_WEBHOOK_BODY_BYTES,
): Promise<string> {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new WebhookBodyTooLargeError();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new WebhookBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export function webhookForcesTagPoll(event: string | null, payload: unknown): boolean {
  return (
    event === "push" &&
    typeof (payload as { ref?: unknown })?.ref === "string" &&
    (payload as { ref: string }).ref.startsWith("refs/tags/")
  );
}

export function tailscaleExecutable(
  which: (name: string) => string | null = Bun.which,
  currentPlatform: NodeJS.Platform = platform(),
): string | undefined {
  return (
    which("tailscale") ??
    (currentPlatform === "darwin" && existsSync(MACOS_TAILSCALE) ? MACOS_TAILSCALE : undefined)
  );
}

function nodeFromStatus(id: string, node: RawNode): TailscalePeer {
  return {
    id: node.ID ?? id,
    hostName: node.HostName ?? node.DNSName?.replace(/\.$/, "") ?? id,
    dnsName: node.DNSName?.replace(/\.$/, ""),
    addresses: node.TailscaleIPs ?? [],
    online: node.Online !== false,
  };
}

export function parseTailscaleStatus(executable: string, output: string): TailscaleStatus {
  let value: RawStatus;
  try {
    value = JSON.parse(output) as RawStatus;
  } catch {
    throw new Error("Tailscale returned invalid status JSON");
  }
  if (!value.Self) throw new Error("Tailscale status did not include this machine");
  return {
    executable,
    online: value.BackendState === "Running" && value.Self.Online !== false,
    self: nodeFromStatus("self", value.Self),
    peers: Object.entries(value.Peer ?? {}).map(([id, node]) => nodeFromStatus(id, node)),
  };
}

export async function tailscaleStatus(
  runCommand: typeof command = command,
  resolveExecutable: () => string | undefined = tailscaleExecutable,
): Promise<TailscaleStatus | undefined> {
  const executable = resolveExecutable();
  if (!executable) return undefined;
  const result = await runCommand([executable, "status", "--json"], {
    env: { TERM: Bun.env.TERM ?? "dumb" },
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0) return undefined;
  return parseTailscaleStatus(executable, result.stdout);
}

function firstIpv4(peer: TailscalePeer): string | undefined {
  return peer.addresses.find((address) => /^\d+\.\d+\.\d+\.\d+$/.test(address));
}

function peerUrl(address: string, port: number, path: string): string {
  return `http://${address.includes(":") ? `[${address}]` : address}:${port}${path}`;
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

function requireNetworkSecret(config: TailscaleConfig): string {
  if (!config.networkSecret) {
    throw new Error(
      "Tailscale worker authentication is not configured; re-enable this network role",
    );
  }
  return config.networkSecret;
}

function networkRequestHeaders(config: TailscaleConfig): Record<string, string> {
  return { Authorization: `Bearer ${requireNetworkSecret(config)}` };
}

export function validNetworkAuthorization(value: string | null, secret: string): boolean {
  if (!value?.startsWith("Bearer ")) return false;
  const received = Buffer.from(value.slice("Bearer ".length));
  const expected = Buffer.from(secret);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export type NetworkClaimPlan = Pick<ClaimScheduling, "claimants" | "rotation">;

function parseExecutionCapacity(value: unknown): ExecutionCapacitySnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const resources = value as {
    capacity?: { cpu?: unknown; memoryMb?: unknown };
    used?: { cpu?: unknown; memoryMb?: unknown };
    queued?: { cpu?: unknown; memoryMb?: unknown };
  };
  const values = [
    resources.capacity?.cpu,
    resources.capacity?.memoryMb,
    resources.used?.cpu,
    resources.used?.memoryMb,
    resources.queued?.cpu,
    resources.queued?.memoryMb,
  ];
  if (
    values.some((resource) => !Number.isSafeInteger(resource)) ||
    (resources.capacity?.cpu as number) <= 0 ||
    (resources.capacity?.memoryMb as number) <= 0 ||
    (resources.used?.cpu as number) < 0 ||
    (resources.used?.memoryMb as number) < 0 ||
    (resources.queued?.cpu as number) < 0 ||
    (resources.queued?.memoryMb as number) < 0
  ) {
    return undefined;
  }
  return resources as ExecutionCapacitySnapshot;
}

export function parseNetworkClaimPlan(value: unknown): NetworkClaimPlan | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new Error("invalid claim scheduling");
  const plan = value as { claimants?: unknown; rotation?: unknown };
  if (
    !Number.isSafeInteger(plan.rotation) ||
    (plan.rotation as number) < 0 ||
    !Array.isArray(plan.claimants) ||
    plan.claimants.length === 0 ||
    plan.claimants.length > 64
  ) {
    throw new Error("invalid claim scheduling");
  }
  const ids = new Set<string>();
  const claimants: NetworkClaimant[] = plan.claimants.map((value) => {
    if (!value || typeof value !== "object") throw new Error("invalid claim scheduling");
    const claimant = value as { id?: unknown; capabilities?: unknown; resources?: unknown };
    const resources = parseExecutionCapacity(claimant.resources);
    if (
      typeof claimant.id !== "string" ||
      claimant.id.length === 0 ||
      claimant.id.length > 256 ||
      ids.has(claimant.id) ||
      !Array.isArray(claimant.capabilities) ||
      claimant.capabilities.length > 256 ||
      claimant.capabilities.some(
        (capability) => typeof capability !== "string" || capability.length > 256,
      ) ||
      !resources
    ) {
      throw new Error("invalid claim scheduling");
    }
    ids.add(claimant.id);
    return {
      id: claimant.id,
      capabilities: claimant.capabilities as string[],
      resources,
    };
  });
  return { claimants, rotation: plan.rotation as number };
}

async function advertisedWorkerCapabilities(): Promise<string[]> {
  const mounts = await listAllowedMounts();
  const usableMounts = await Promise.all(
    mounts.map(async (mount) => {
      try {
        const metadata = await lstat(await realpath(mount.source));
        return metadata.isFile() && metadata.size <= MAX_ALLOWED_MOUNT_BYTES
          ? mount.name
          : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return workerCapabilities(
    Bun.env,
    usableMounts.filter((name): name is string => name !== undefined),
  );
}

export async function discoverNetworkWorkers(
  config: TailscaleConfig,
  status: TailscaleStatus,
): Promise<NetworkWorker[]> {
  const workers = await Promise.all(
    status.peers
      .filter((peer) => peer.online)
      .flatMap((peer) => {
        const address = firstIpv4(peer);
        if (!address) return [];
        return [
          fetchWithTimeout(peerUrl(address, config.workerPort, "/v1/health"), {
            headers: networkRequestHeaders(config),
          })
            .then(async (response) => {
              if (!response.ok) return undefined;
              const result = (await response.json()) as Partial<NetworkWorker>;
              if (!Array.isArray(result.capabilities) || !Array.isArray(result.repositories)) {
                return undefined;
              }
              return {
                id: peer.id,
                hostName: result.hostName ?? peer.hostName,
                address,
                capabilities: result.capabilities.map(String),
                repositories: result.repositories.map(String),
                protocols: Array.isArray(result.protocols) ? result.protocols.map(String) : [],
                resources: parseExecutionCapacity(result.resources),
                version: result.version,
              } satisfies NetworkWorker;
            })
            .catch(() => undefined),
        ];
      }),
  );
  return workers.filter(Boolean) as NetworkWorker[];
}

export async function prepareTailscaleFunnel(
  status: TailscaleStatus,
  port = DEFAULT_FUNNEL_PORT,
  runCommand: typeof command = command,
  authorize?: (url: string) => Promise<void> | void,
): Promise<string> {
  let output = "";
  let authorizationUrl: string | undefined;
  const result = await runCommand(
    [status.executable, "funnel", "--bg", "--yes", `http://127.0.0.1:${port}`],
    {
      env: { TERM: Bun.env.TERM ?? "dumb" },
      timeoutMs: 120_000,
      onOutput: async (text) => {
        output = `${output}${text}`.slice(-8_192);
        const url = output.match(/https:\/\/login\.tailscale\.com\/f\/funnel\?[^\s]+(?=\s)/)?.[0];
        if (!url || url === authorizationUrl) return;
        authorizationUrl = url;
        await authorize?.(url);
      },
    },
  );
  if (result.exitCode !== 0 || result.timedOut) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `could not enable Tailscale Funnel${result.timedOut ? " within 2 minutes" : ""}: ${detail || "check that this node is allowed to use Funnel, then retry"}`,
    );
  }
  const dnsName = status.self.dnsName;
  if (!dnsName) throw new Error("Tailscale MagicDNS is required for Funnel");
  return `https://${dnsName}`;
}

export async function resetTailscaleFunnel(
  status: TailscaleStatus,
  runCommand: typeof command = command,
): Promise<void> {
  const result = await runCommand([status.executable, "funnel", "--https=443", "off"], {
    env: { TERM: Bun.env.TERM ?? "dumb" },
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(
      `could not disable Tailscale Funnel: ${result.stderr.trim() || result.stdout.trim() || "command timed out"}`,
    );
  }
}

function appJwt(appId: string, privateKey: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1_000);
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: appId })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url")}`;
}

async function githubAppHeaders(credentials: GitHubCredentials): Promise<Record<string, string>> {
  const privateKey = await readFile(credentials.privateKeyFile, "utf8");
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${appJwt(credentials.appId, privateKey)}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export interface GitHubAppWebhookSettings {
  appId: string;
  name: string;
  events: string[];
  settingsUrl: string;
  permissionsUrl: string;
}

export async function githubAppWebhookSettings(
  credentials: GitHubCredentials,
  request: typeof fetch = fetch,
): Promise<GitHubAppWebhookSettings> {
  const response = await request(`${API}/app`, {
    headers: await githubAppHeaders(credentials),
  });
  if (!response.ok) {
    throw new Error(
      `could not inspect GitHub App ${credentials.appId} settings: ${await response.text()}`,
    );
  }
  const value = await response.json().catch(() => undefined);
  if (!value || typeof value !== "object") {
    throw new Error(`could not inspect GitHub App ${credentials.appId}: invalid API response`);
  }
  const app = value as {
    name?: unknown;
    slug?: unknown;
    events?: unknown;
    owner?: { login?: unknown; type?: unknown };
  };
  if (
    typeof app.name !== "string" ||
    typeof app.slug !== "string" ||
    typeof app.owner?.login !== "string" ||
    (app.owner.type !== "Organization" && app.owner.type !== "User")
  ) {
    throw new Error(`could not inspect GitHub App ${credentials.appId}: invalid API response`);
  }
  const settingsUrl =
    app.owner.type === "Organization"
      ? `https://github.com/organizations/${encodeURIComponent(app.owner.login)}/settings/apps/${encodeURIComponent(app.slug)}`
      : `https://github.com/settings/apps/${encodeURIComponent(app.slug)}`;
  return {
    appId: credentials.appId,
    name: app.name,
    events: Array.isArray(app.events) ? app.events.map(String) : [],
    settingsUrl,
    permissionsUrl: `${settingsUrl}/permissions`,
  };
}

export async function requireGitHubAppWebhookEvents(
  credentials: GitHubCredentials,
  request: typeof fetch = fetch,
): Promise<void> {
  const app = await githubAppWebhookSettings(credentials, request);
  const events = new Set(app.events);
  const missing = REQUIRED_GITHUB_WEBHOOK_EVENTS.filter((event) => !events.has(event));
  if (missing.length > 0) {
    throw new Error(
      `${app.name} (${app.appId}) must subscribe to these webhook events before lead mode can be enabled: ${missing.join(", ")}. Update Permissions & events: ${app.permissionsUrl}`,
    );
  }
}

export async function configureGitHubAppWebhook(
  credentials: GitHubCredentials,
  url: string,
  secret: string,
  request: typeof fetch = fetch,
): Promise<void> {
  const headers = await githubAppHeaders(credentials);
  const configured = await request(`${API}/app/hook/config`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ url: `${url}/webhooks/github`, content_type: "json", secret }),
  });
  if (!configured.ok) {
    throw new Error(`could not configure GitHub App webhook: ${await configured.text()}`);
  }
}

export interface EnableTailscaleOperations {
  configureWebhook?: typeof configureGitHubAppWebhook;
  createNetworkSecret?: () => string;
  createSecret?: () => string;
  getConfig?: typeof getTailscaleConfig;
  listCredentials?: typeof listGitHubCredentials;
  prepareFunnel?: typeof prepareTailscaleFunnel;
  authorizeFunnel?: (url: string) => Promise<void> | void;
  networkSecret?: string;
  saveConfig?: typeof saveTailscaleConfig;
  status?: typeof tailscaleStatus;
  validateWebhook?: typeof requireGitHubAppWebhookEvents;
  webhookReadyConfirmed?: boolean;
}

export async function enableTailscale(
  mode: "lead" | "worker",
  operations: EnableTailscaleOperations = {},
): Promise<TailscaleConfig> {
  const status = await (operations.status ?? tailscaleStatus)();
  if (!status?.online) throw new Error("Tailscale must be installed, connected, and online");
  const suppliedNetworkSecret = operations.networkSecret?.trim();
  if (suppliedNetworkSecret !== undefined && !/^[A-Za-z0-9_-]{32,}$/.test(suppliedNetworkSecret)) {
    throw new Error(
      "the Tailscale worker token must contain at least 32 letters, digits, hyphens, or underscores",
    );
  }
  const base = {
    mode,
    workerPort: DEFAULT_WORKER_PORT,
    funnelPort: DEFAULT_FUNNEL_PORT,
  } satisfies Omit<TailscaleConfig, "networkSecret">;
  const saveConfig = operations.saveConfig ?? saveTailscaleConfig;
  if (mode === "worker") {
    if (!suppliedNetworkSecret) {
      throw new Error("tailscale worker mode requires the token shown by the lead");
    }
    const config = { ...base, networkSecret: suppliedNetworkSecret };
    await saveConfig(config);
    return config;
  }
  if (operations.webhookReadyConfirmed !== true) {
    throw new Error("confirm the GitHub App webhook is active before enabling Tailscale lead mode");
  }
  const existing = await (operations.getConfig ?? getTailscaleConfig)();
  const secret =
    existing?.mode === "lead" && existing.webhookSecret
      ? existing.webhookSecret
      : (operations.createSecret ?? (() => randomBytes(32).toString("hex")))();
  const networkSecret =
    existing?.mode === "lead" && existing.networkSecret
      ? existing.networkSecret
      : (suppliedNetworkSecret ??
        (operations.createNetworkSecret ?? (() => randomBytes(32).toString("hex")))());
  const credentials = await (operations.listCredentials ?? listGitHubCredentials)();
  if (credentials.length === 0) throw new Error("configure a GitHub App before enabling a lead");
  await Promise.all(
    credentials.map((app) => (operations.validateWebhook ?? requireGitHubAppWebhookEvents)(app)),
  );
  const funnelUrl = await (operations.prepareFunnel ?? prepareTailscaleFunnel)(
    status,
    base.funnelPort,
    command,
    operations.authorizeFunnel,
  );
  const config = { ...base, funnelUrl, webhookSecret: secret, networkSecret };
  await saveConfig(config);
  await Promise.all(
    credentials.map((app) =>
      (operations.configureWebhook ?? configureGitHubAppWebhook)(app, funnelUrl, secret),
    ),
  );
  return config;
}

export interface TailscaleDisableResult {
  disabled: boolean;
  funnelResetError?: Error;
}

export async function disableTailscale(
  operations: {
    getConfig?: typeof getTailscaleConfig;
    status?: typeof tailscaleStatus;
    resetFunnel?: typeof resetTailscaleFunnel;
    clearConfig?: typeof clearTailscaleConfig;
  } = {},
): Promise<TailscaleDisableResult> {
  const config = await (operations.getConfig ?? getTailscaleConfig)();
  if (!config) return { disabled: false };
  let funnelResetError: Error | undefined;
  if (config.mode === "lead") {
    try {
      const status = await (operations.status ?? tailscaleStatus)();
      if (status?.online) await (operations.resetFunnel ?? resetTailscaleFunnel)(status);
    } catch (error) {
      funnelResetError = error instanceof Error ? error : new Error(String(error));
    }
  }
  const disabled = await (operations.clearConfig ?? clearTailscaleConfig)();
  return { disabled, funnelResetError };
}

export function validGitHubSignature(
  body: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const received = Buffer.from(signature.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", secret).update(body).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function actionableWebhook(event: string | null, payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const action = (payload as { action?: unknown }).action;
  if (event === "push") return true;
  if (event === "pull_request") return typeof action === "string";
  if (event === "issue_comment") return action === "created";
  if (event === "check_suite") return action === "requested" || action === "rerequested";
  return false;
}

function repositoryFromFullName(fullName: unknown): Repository | undefined {
  if (typeof fullName !== "string") return undefined;
  const [owner, repo, ...rest] = fullName.split("/");
  if (!owner || !repo || rest.length > 0) return undefined;
  return { owner, repo, fullName: `${owner}/${repo}` };
}

function payloadRepository(payload: unknown): Repository | undefined {
  return repositoryFromFullName(
    (payload as { repository?: { full_name?: unknown } })?.repository?.full_name,
  );
}

function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise(() => undefined);
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

export interface TailscaleServeOptions extends ServerOptions {
  version?: string;
}

export interface TailscaleServeOperations {
  getConfig?: typeof getTailscaleConfig;
  serveNetwork?: typeof serveConfiguredWithTailscale;
  servePolling?: typeof serveRepositories;
  status?: typeof tailscaleStatus;
}

export async function serveWithTailscale(
  repositories: Repository[],
  options: TailscaleServeOptions = {},
  operations: TailscaleServeOperations = {},
): Promise<void> {
  const servePolling = operations.servePolling ?? serveRepositories;
  let config: TailscaleConfig | undefined;
  try {
    config = await (operations.getConfig ?? getTailscaleConfig)();
  } catch (error) {
    if (options.signal?.aborted) return;
    options.onMessage?.(
      `Tailscale configuration unavailable; polling GitHub instead: ${error instanceof Error ? error.message : error}`,
    );
    await servePolling(repositories, options);
    return;
  }
  if (!config || options.once) return servePolling(repositories, options);
  try {
    const networkSecret = requireNetworkSecret(config);
    const status = await (operations.status ?? tailscaleStatus)();
    const selfAddress = status && firstIpv4(status.self);
    if (!status?.online || !selfAddress) throw new Error("Tailscale is offline");
    await (operations.serveNetwork ?? serveConfiguredWithTailscale)(
      repositories,
      options,
      config,
      status,
      selfAddress,
      networkSecret,
    );
  } catch (error) {
    if (options.signal?.aborted) return;
    options.onMessage?.(
      `Tailscale coordination unavailable; polling GitHub instead: ${error instanceof Error ? error.message : error}`,
    );
    await servePolling(repositories, options);
  }
}

async function serveConfiguredWithTailscale(
  repositories: Repository[],
  options: TailscaleServeOptions,
  config: TailscaleConfig,
  status: TailscaleStatus,
  selfAddress: string,
  networkSecret: string,
): Promise<void> {
  await refreshSelectedContainerBackend(options.signal);

  let configuredRepositories = repositories;
  const scans = new RepositoryScanQueue(
    repositories,
    (repository, forceTagPoll, signal, claimScheduling) =>
      serveRepositories([repository], {
        ...options,
        once: true,
        forceTagPoll,
        signal,
        throwOnPollError: true,
        claimScheduling,
      }),
    options.signal,
  );

  const knownWorkers = new Map<string, NetworkWorker>();
  const refreshWorkers = async (): Promise<NetworkWorker[]> => {
    const currentStatus = await tailscaleStatus();
    if (!currentStatus?.online) {
      knownWorkers.clear();
      return [];
    }
    const workers = await discoverNetworkWorkers(config, currentStatus);
    reconcileKnownWorkers(knownWorkers, workers);
    return workers;
  };
  let claimRotation = 0;
  const dispatch = async (request: RepositoryDispatch): Promise<boolean> => {
    await refreshWorkers();
    const localRepository = configuredRepositories.find(
      (candidate) => candidate.fullName.toLowerCase() === request.repository.fullName.toLowerCase(),
    );
    const targets: Array<{
      claimant?: NetworkClaimant;
      label: string;
      scheduling: boolean;
      run: (plan?: NetworkClaimPlan) => Promise<unknown>;
    }> = [];
    if (localRepository) {
      targets.push({
        claimant: {
          id: status.self.id,
          capabilities: await advertisedWorkerCapabilities(),
          resources: currentExecutionCapacity(),
        },
        label: hostname(),
        scheduling: true,
        run: (plan) =>
          scans.run(
            localRepository,
            request.forceTagPoll,
            plan ? { ...plan, workerId: status.self.id } : undefined,
          ),
      });
    }
    if (config.mode === "lead") {
      for (const worker of knownWorkers.values()) {
        if (
          !worker.repositories.some(
            (name) => name.toLowerCase() === request.repository.fullName.toLowerCase(),
          )
        ) {
          continue;
        }
        targets.push({
          claimant: worker.resources
            ? { id: worker.id, capabilities: worker.capabilities, resources: worker.resources }
            : undefined,
          label: worker.hostName,
          scheduling:
            worker.protocols?.includes(CLAIM_SCHEDULING_PROTOCOL) === true &&
            worker.resources !== undefined,
          run: (plan) =>
            fetchWithTimeout(peerUrl(worker.address, config.workerPort, "/v1/dispatch"), {
              method: "POST",
              headers: {
                ...networkRequestHeaders(config),
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                repository: request.repository.fullName,
                forceTagPoll: request.forceTagPoll,
                claimPlan: plan,
              }),
            }).then((response) => {
              if (!response.ok) throw new Error(`returned ${response.status}`);
            }),
        });
      }
    }
    if (targets.length === 0) {
      options.onMessage?.(
        `dropping ${request.repository.fullName} dispatch; no registered worker advertises it`,
      );
      return true;
    }
    const generatedPlan =
      !request.claimPlan &&
      targets.length > 1 &&
      targets.every((target) => target.scheduling && target.claimant)
        ? {
            claimants: targets.flatMap((target) => (target.claimant ? [target.claimant] : [])),
            rotation: claimRotation++ % Number.MAX_SAFE_INTEGER,
          }
        : undefined;
    const plan = request.claimPlan ?? generatedPlan;
    const tasks = targets.map((target) => ({ label: target.label, promise: target.run(plan) }));
    const results = await Promise.allSettled(tasks.map((task) => task.promise));
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        options.onMessage?.(
          `network dispatch to ${tasks[index]?.label ?? "worker"} failed: ${result.reason instanceof Error ? result.reason.message : result.reason}`,
        );
      }
    }
    return results.every((result) => result.status === "fulfilled");
  };
  const dispatchQueue = new DispatchRetryQueue(dispatch, (request, delayMs) => {
    options.onMessage?.(
      `retaining ${request.repository.fullName} dispatch; retrying in ${Math.ceil(delayMs / 1_000)}s`,
    );
  });

  const privateServer = Bun.serve({
    hostname: selfAddress,
    port: config.workerPort,
    async fetch(request): Promise<Response> {
      if (!validNetworkAuthorization(request.headers.get("Authorization"), networkSecret)) {
        return new Response("unauthorized", { status: 401 });
      }
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/health") {
        return Response.json({
          id: status.self.id,
          hostName: hostname(),
          capabilities: await advertisedWorkerCapabilities(),
          repositories: configuredRepositories.map((repository) => repository.fullName),
          protocols: [CLAIM_SCHEDULING_PROTOCOL],
          resources: currentExecutionCapacity(),
          version: options.version,
        });
      }
      if (request.method === "GET" && url.pathname === "/v1/builds") {
        const builds =
          url.searchParams.get("all") === "1" ? await listBuilds() : await listActiveBuilds();
        return Response.json({ builds });
      }
      if (request.method === "GET" && url.pathname.startsWith("/v1/logs/")) {
        const id = decodeURIComponent(url.pathname.slice("/v1/logs/".length));
        let build = await getBuild(id);
        if (!build) return new Response("build not found", { status: 404 });
        if (build.status === "running") build = await reconcileBuildLiveness(build);
        const job = url.searchParams.get("job");
        const file = Bun.file(job ? jobLogPath(build, job) : build.logPath);
        if (!(await file.exists())) return new Response("log not found", { status: 404 });
        const requestedOffset = Number(url.searchParams.get("offset") ?? 0);
        const offset =
          Number.isSafeInteger(requestedOffset) &&
          requestedOffset >= 0 &&
          requestedOffset <= file.size
            ? requestedOffset
            : 0;
        return new Response(file.slice(offset), {
          headers: {
            "X-Informant-Build-Status": build.status,
            "X-Informant-Log-Offset": String(file.size),
          },
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/dispatch") {
        const body = (await request.json().catch(() => undefined)) as
          | { repository?: unknown; forceTagPoll?: unknown; claimPlan?: unknown }
          | undefined;
        if (
          typeof body?.repository !== "string" ||
          (body.forceTagPoll !== undefined && typeof body.forceTagPoll !== "boolean")
        )
          return new Response("invalid repository", { status: 400 });
        let claimPlan: NetworkClaimPlan | undefined;
        try {
          claimPlan = parseNetworkClaimPlan(body.claimPlan);
        } catch {
          return new Response("invalid claim scheduling", { status: 400 });
        }
        const requestedRepository = body.repository;
        const repository = configuredRepositories.find(
          (candidate) => candidate.fullName.toLowerCase() === requestedRepository.toLowerCase(),
        );
        if (!repository) return new Response("repository is not registered", { status: 404 });
        dispatchQueue.enqueue({
          repository,
          forceTagPoll: body.forceTagPoll === true,
          claimPlan,
        });
        return new Response(null, { status: 202 });
      }
      return new Response("not found", { status: 404 });
    },
  });

  let funnelServer: Bun.Server<undefined> | undefined;
  const deliveries = new Set<string>();
  const loadRepositories = options.dependencies?.listRepositories ?? listRepositories;
  let advertisedRepositories = new Set<string>();
  let refreshingTopology = false;
  const refreshTopology = async (recoverAll = false) => {
    if (refreshingTopology || config.mode !== "lead") return;
    refreshingTopology = true;
    try {
      const workers = await refreshWorkers();
      const next = new Set<string>();
      for (const worker of workers) {
        for (const fullName of worker.repositories) {
          const repository = repositoryFromFullName(fullName);
          if (!repository) continue;
          const key = `${worker.id}\0${repository.fullName.toLowerCase()}`;
          next.add(key);
          if (recoverAll || !advertisedRepositories.has(key)) {
            dispatchQueue.enqueue({ repository, forceTagPoll: true });
          }
        }
      }
      advertisedRepositories = next;
    } catch (error) {
      options.onMessage?.(
        `could not refresh Tailscale workers: ${error instanceof Error ? error.message : error}`,
      );
    } finally {
      refreshingTopology = false;
    }
  };
  let refreshingRepositories = false;
  const refreshRepositories = setInterval(async () => {
    if (refreshingRepositories) return;
    refreshingRepositories = true;
    try {
      const nextRepositories = await loadRepositories();
      const recoveryRequests = addedRepositoryRecoveryRequests(
        configuredRepositories,
        nextRepositories,
      );
      scans.reconcile(nextRepositories);
      configuredRepositories = nextRepositories;
      for (const request of recoveryRequests) dispatchQueue.enqueue(request);
    } catch (error) {
      options.onMessage?.(
        `could not refresh repositories: ${error instanceof Error ? error.message : error}`,
      );
    } finally {
      refreshingRepositories = false;
    }
  }, 5_000);
  const refreshPeerTopology =
    config.mode === "lead"
      ? setInterval(() => void refreshTopology(), PEER_REFRESH_INTERVAL_MS)
      : undefined;
  try {
    for (const request of startupRecoveryRequests(configuredRepositories)) {
      dispatchQueue.enqueue(request);
    }
    if (config.mode === "lead") {
      if (!config.webhookSecret) throw new Error("lead is missing its GitHub webhook secret");
      funnelServer = Bun.serve({
        hostname: "127.0.0.1",
        port: config.funnelPort,
        async fetch(request): Promise<Response> {
          const url = new URL(request.url);
          if (request.method !== "POST" || url.pathname !== "/webhooks/github") {
            return new Response("not found", { status: 404 });
          }
          let body: string;
          try {
            body = await readWebhookBody(request);
          } catch (error) {
            if (error instanceof WebhookBodyTooLargeError) {
              return new Response("payload too large", { status: 413 });
            }
            throw error;
          }
          if (
            !validGitHubSignature(
              body,
              request.headers.get("X-Hub-Signature-256"),
              config.webhookSecret ?? "",
            )
          ) {
            return new Response("invalid signature", { status: 401 });
          }
          let payload: unknown;
          try {
            payload = JSON.parse(body) as unknown;
          } catch {
            return new Response("invalid JSON", { status: 400 });
          }
          const event = request.headers.get("X-GitHub-Event");
          if (!actionableWebhook(event, payload)) {
            return new Response(null, { status: 204 });
          }
          const delivery = request.headers.get("X-GitHub-Delivery");
          if (delivery && deliveries.has(delivery)) return new Response(null, { status: 202 });
          if (delivery) {
            deliveries.add(delivery);
            if (deliveries.size > 1_000) deliveries.delete(deliveries.values().next().value ?? "");
          }
          const repository = payloadRepository(payload);
          if (!repository) return new Response("invalid repository", { status: 400 });
          dispatchQueue.enqueue({
            repository,
            forceTagPoll: webhookForcesTagPoll(event, payload),
          });
          return new Response(null, { status: 202 });
        },
      });
      const funnelUrl = await prepareTailscaleFunnel(status, config.funnelPort);
      options.onMessage?.(`Tailscale Funnel listening at ${funnelUrl}/webhooks/github`);
      await refreshTopology(true);
    } else {
      options.onMessage?.(
        `Tailscale worker listening on ${selfAddress}:${config.workerPort}; polling disabled`,
      );
    }
    await waitForAbort(options.signal);
  } finally {
    clearInterval(refreshRepositories);
    if (refreshPeerTopology) clearInterval(refreshPeerTopology);
    funnelServer?.stop(true);
    privateServer.stop(true);
    await Promise.all([
      dispatchQueue.stop(),
      scans.stop(options.signal?.reason ?? "Worker shutdown requested."),
    ]);
  }
}

export async function listBuildsAcrossWorkers(includeHistory: boolean): Promise<BuildRecord[]> {
  const local = includeHistory ? await listBuilds() : await listActiveBuilds();
  const config = await getTailscaleConfig();
  const status = config && (await tailscaleStatus());
  if (!config || !status?.online) return local;
  const workers = await discoverNetworkWorkers(config, status);
  const remote = await Promise.all(
    workers.map((worker) =>
      fetchWithTimeout(
        peerUrl(worker.address, config.workerPort, `/v1/builds${includeHistory ? "?all=1" : ""}`),
        { headers: networkRequestHeaders(config) },
      )
        .then(async (response) => {
          if (!response.ok) return [];
          const builds = ((await response.json()) as { builds?: BuildRecord[] }).builds ?? [];
          return builds.map((build) => ({
            ...build,
            networkWorker: {
              hostName: worker.hostName,
              address: worker.address,
              port: config.workerPort,
            },
          }));
        })
        .catch(() => []),
    ),
  );
  const unique = new Map<string, BuildRecord>();
  for (const build of [...local, ...remote.flat()])
    unique.set(`${build.machine}\0${build.id}`, build);
  return [...unique.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export interface RemoteLogChunk {
  bytes: Uint8Array;
  offset: number;
  running: boolean;
  worker: NetworkWorker;
}

export async function remoteBuildLog(
  id: string,
  options: { job?: string; offset?: number; worker?: NetworkWorker } = {},
): Promise<RemoteLogChunk | undefined> {
  const config = await getTailscaleConfig();
  if (!config) return undefined;
  let workers: NetworkWorker[];
  if (options.worker) workers = [options.worker];
  else {
    const status = await tailscaleStatus();
    if (!status?.online) return undefined;
    workers = await discoverNetworkWorkers(config, status);
  }
  for (const worker of workers) {
    const parameters = new URLSearchParams({ offset: String(options.offset ?? 0) });
    if (options.job) parameters.set("job", options.job);
    const path = `/v1/logs/${encodeURIComponent(id)}?${parameters}`;
    const response = await fetchWithTimeout(peerUrl(worker.address, config.workerPort, path), {
      headers: networkRequestHeaders(config),
    }).catch(() => undefined);
    if (!response?.ok) continue;
    const offset = Number(response.headers.get("X-Informant-Log-Offset"));
    if (!Number.isSafeInteger(offset) || offset < 0) continue;
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      offset,
      running: response.headers.get("X-Informant-Build-Status") === "running",
      worker,
    };
  }
  return undefined;
}

export async function networkStatus(): Promise<{
  config?: TailscaleConfig;
  status?: TailscaleStatus;
  workers: NetworkWorker[];
  localResources: ExecutionCapacitySnapshot;
}> {
  const config = await getTailscaleConfig();
  const status = await tailscaleStatus();
  const workers = config && status?.online ? await discoverNetworkWorkers(config, status) : [];
  return { config, status, workers, localResources: currentExecutionCapacity() };
}
