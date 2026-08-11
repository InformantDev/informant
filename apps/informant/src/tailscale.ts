import { createHmac, createSign, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { hostname, platform } from "node:os";
import { workerCapabilities } from "./capabilities.ts";
import { refreshSelectedContainerBackend } from "./container-backend.ts";
import {
  clearTailscaleConfig,
  type GitHubCredentials,
  getTailscaleConfig,
  listGitHubCredentials,
  listRepositories,
  saveTailscaleConfig,
  type TailscaleConfig,
} from "./machine-config.ts";
import { type CommandResult, command } from "./process.ts";
import { type ServerOptions, serveRepositories } from "./server.ts";
import { getBuild, jobLogPath, listActiveBuilds, listBuilds } from "./store.ts";
import type { BuildRecord, Repository } from "./types.ts";

const API = "https://api.github.com";
export const DEFAULT_WORKER_PORT = 7639;
export const DEFAULT_FUNNEL_PORT = 7640;
const REQUEST_TIMEOUT_MS = 2_000;
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
  version?: string;
  local?: boolean;
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
  runCommand: (argv: string[]) => Promise<CommandResult> = command,
): Promise<TailscaleStatus | undefined> {
  const executable = tailscaleExecutable();
  if (!executable) return undefined;
  const result = await runCommand([executable, "status", "--json"]);
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
          fetchWithTimeout(peerUrl(address, config.workerPort, "/v1/health"))
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
  runCommand: (argv: string[]) => Promise<CommandResult> = command,
): Promise<string> {
  const result = await runCommand([
    status.executable,
    "funnel",
    "--bg",
    "--yes",
    `http://127.0.0.1:${port}`,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `could not enable Tailscale Funnel: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  const dnsName = status.self.dnsName;
  if (!dnsName) throw new Error("Tailscale MagicDNS is required for Funnel");
  return `https://${dnsName}`;
}

export async function resetTailscaleFunnel(
  status: TailscaleStatus,
  runCommand: (argv: string[]) => Promise<CommandResult> = command,
): Promise<void> {
  const result = await runCommand([status.executable, "funnel", "--https=443", "off"]);
  if (result.exitCode !== 0) {
    throw new Error(
      `could not disable Tailscale Funnel: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
}

function appJwt(appId: string, privateKey: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1_000);
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: appId })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url")}`;
}

export async function configureGitHubAppWebhook(
  credentials: GitHubCredentials,
  url: string,
  secret: string,
  request: typeof fetch = fetch,
): Promise<void> {
  const privateKey = await readFile(credentials.privateKeyFile, "utf8");
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${appJwt(credentials.appId, privateKey)}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const enabled = await request(`${API}/app`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ webhook_active: true, webhook_url: `${url}/webhooks/github` }),
  });
  if (!enabled.ok) {
    throw new Error(`could not enable GitHub App webhook: ${await enabled.text()}`);
  }
  const configured = await request(`${API}/app/hook/config`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ url: `${url}/webhooks/github`, content_type: "json", secret }),
  });
  if (!configured.ok) {
    throw new Error(`could not configure GitHub App webhook: ${await configured.text()}`);
  }
}

export async function enableTailscale(mode: "lead" | "worker"): Promise<TailscaleConfig> {
  const status = await tailscaleStatus();
  if (!status?.online) throw new Error("Tailscale must be installed, connected, and online");
  const base: TailscaleConfig = {
    mode,
    workerPort: DEFAULT_WORKER_PORT,
    funnelPort: DEFAULT_FUNNEL_PORT,
  };
  if (mode === "worker") {
    await saveTailscaleConfig(base);
    return base;
  }
  const secret = randomBytes(32).toString("hex");
  const funnelUrl = await prepareTailscaleFunnel(status, base.funnelPort);
  const credentials = await listGitHubCredentials();
  if (credentials.length === 0) throw new Error("configure a GitHub App before enabling a lead");
  await Promise.all(credentials.map((app) => configureGitHubAppWebhook(app, funnelUrl, secret)));
  const config = { ...base, funnelUrl, webhookSecret: secret };
  await saveTailscaleConfig(config);
  return config;
}

export async function disableTailscale(): Promise<boolean> {
  const config = await getTailscaleConfig();
  if (!config) return false;
  const status = await tailscaleStatus();
  if (config.mode === "lead" && status?.online) await resetTailscaleFunnel(status);
  return clearTailscaleConfig();
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

function payloadRepository(payload: unknown): Repository | undefined {
  const fullName = (payload as { repository?: { full_name?: unknown } })?.repository?.full_name;
  if (typeof fullName !== "string") return undefined;
  const [owner, repo, ...rest] = fullName.split("/");
  if (!owner || !repo || rest.length > 0) return undefined;
  return { owner, repo, fullName: `${owner}/${repo}` };
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

export async function serveWithTailscale(
  repositories: Repository[],
  options: TailscaleServeOptions = {},
): Promise<void> {
  const config = await getTailscaleConfig();
  if (!config || options.once) return serveRepositories(repositories, options);
  const status = await tailscaleStatus();
  const selfAddress = status && firstIpv4(status.self);
  if (!status?.online || !selfAddress) {
    throw new Error(
      "Tailscale coordination is configured but unavailable; reconnect Tailscale or run informant tailscale disable to restore polling",
    );
  }
  await refreshSelectedContainerBackend(options.signal);

  let configuredRepositories = repositories;
  const scans = new Map<string, Promise<void>>();
  const scan = (repository: Repository) => {
    const key = repository.fullName.toLowerCase();
    const previous = scans.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => serveRepositories([repository], { ...options, once: true }))
      .finally(() => {
        if (scans.get(key) === next) scans.delete(key);
      });
    scans.set(key, next);
    return next;
  };

  const dispatch = async (repository: Repository) => {
    const tasks: Promise<unknown>[] = [];
    const localRepository = configuredRepositories.find(
      (candidate) => candidate.fullName.toLowerCase() === repository.fullName.toLowerCase(),
    );
    if (localRepository) tasks.push(scan(localRepository));
    if (config.mode === "lead") {
      const workers = await discoverNetworkWorkers(config, status);
      for (const worker of workers) {
        if (
          !worker.repositories.some(
            (name) => name.toLowerCase() === repository.fullName.toLowerCase(),
          )
        ) {
          continue;
        }
        tasks.push(
          fetchWithTimeout(peerUrl(worker.address, config.workerPort, "/v1/dispatch"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ repository: repository.fullName }),
          }).then((response) => {
            if (!response.ok) throw new Error(`${worker.hostName} returned ${response.status}`);
          }),
        );
      }
    }
    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === "rejected") {
        options.onMessage?.(
          `network dispatch failed: ${result.reason instanceof Error ? result.reason.message : result.reason}`,
        );
      }
    }
  };

  const privateServer = Bun.serve({
    hostname: selfAddress,
    port: config.workerPort,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/health") {
        return Response.json({
          id: status.self.id,
          hostName: hostname(),
          capabilities: await workerCapabilities(),
          repositories: configuredRepositories.map((repository) => repository.fullName),
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
        const build = await getBuild(id);
        if (!build) return new Response("build not found", { status: 404 });
        const job = url.searchParams.get("job");
        const file = Bun.file(job ? jobLogPath(build, job) : build.logPath);
        if (!(await file.exists())) return new Response("log not found", { status: 404 });
        return new Response(file);
      }
      if (request.method === "POST" && url.pathname === "/v1/dispatch") {
        const body = (await request.json().catch(() => undefined)) as
          | { repository?: unknown }
          | undefined;
        if (typeof body?.repository !== "string")
          return new Response("invalid repository", { status: 400 });
        const requestedRepository = body.repository;
        const repository = configuredRepositories.find(
          (candidate) => candidate.fullName.toLowerCase() === requestedRepository.toLowerCase(),
        );
        if (!repository) return new Response("repository is not registered", { status: 404 });
        void scan(repository);
        return new Response(null, { status: 202 });
      }
      return new Response("not found", { status: 404 });
    },
  });

  let funnelServer: Bun.Server<undefined> | undefined;
  const deliveries = new Set<string>();
  const loadRepositories = options.dependencies?.listRepositories ?? listRepositories;
  let refreshingRepositories = false;
  const refreshRepositories = setInterval(async () => {
    if (refreshingRepositories) return;
    refreshingRepositories = true;
    try {
      configuredRepositories = await loadRepositories();
    } catch (error) {
      options.onMessage?.(
        `could not refresh repositories: ${error instanceof Error ? error.message : error}`,
      );
    } finally {
      refreshingRepositories = false;
    }
  }, 5_000);
  try {
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
          const body = await request.text();
          if (
            !validGitHubSignature(
              body,
              request.headers.get("X-Hub-Signature-256"),
              config.webhookSecret ?? "",
            )
          ) {
            return new Response("invalid signature", { status: 401 });
          }
          const payload = JSON.parse(body) as unknown;
          if (!actionableWebhook(request.headers.get("X-GitHub-Event"), payload)) {
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
          void dispatch(repository);
          return new Response(null, { status: 202 });
        },
      });
      const funnelUrl = await prepareTailscaleFunnel(status, config.funnelPort);
      options.onMessage?.(`Tailscale Funnel listening at ${funnelUrl}/webhooks/github`);
      for (const repository of configuredRepositories) void dispatch(repository);
    } else {
      options.onMessage?.(
        `Tailscale worker listening on ${selfAddress}:${config.workerPort}; polling disabled`,
      );
    }
    await waitForAbort(options.signal);
    await Promise.allSettled(scans.values());
  } finally {
    clearInterval(refreshRepositories);
    funnelServer?.stop(true);
    privateServer.stop(true);
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

export async function remoteBuildLog(id: string, job?: string): Promise<string | undefined> {
  const config = await getTailscaleConfig();
  const status = config && (await tailscaleStatus());
  if (!config || !status?.online) return undefined;
  const workers = await discoverNetworkWorkers(config, status);
  for (const worker of workers) {
    const path = `/v1/logs/${encodeURIComponent(id)}${job ? `?job=${encodeURIComponent(job)}` : ""}`;
    const response = await fetchWithTimeout(peerUrl(worker.address, config.workerPort, path)).catch(
      () => undefined,
    );
    if (response?.ok) return response.text();
  }
  return undefined;
}

export async function networkStatus(): Promise<{
  config?: TailscaleConfig;
  status?: TailscaleStatus;
  workers: NetworkWorker[];
}> {
  const config = await getTailscaleConfig();
  const status = await tailscaleStatus();
  const workers = config && status?.online ? await discoverNetworkWorkers(config, status) : [];
  return { config, status, workers };
}
