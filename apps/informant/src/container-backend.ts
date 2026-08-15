import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { type CommandResult, command } from "./process.ts";

export type ContainerCommandRunner = typeof command;
export const CONTAINER_READINESS_MAX_AGE_MS = 30_000;
export const CONTAINER_READINESS_TIMEOUT_MS = 15_000;
export const CONTAINER_EXECUTION_READINESS_MAX_AGE_MS = 5 * 60_000;

export interface ContainerRunOptions {
  name: string;
  image: string;
  workspace: string;
  command: string;
  environment: Record<string, string>;
  mounts?: Array<{ source: string; target: string; readOnly?: boolean }>;
  secretNames?: string[];
  cpu?: number;
  memoryMb?: number;
  preparedWorkspace?: boolean;
}

export interface ContainerBackend {
  kind: "apple" | "podman";
  name: string;
  sharedStorageDescription: string;
  globalPruneCommand?: string;
  initialize(runCommand?: ContainerCommandRunner, signal?: AbortSignal): Promise<void>;
  verifyExecution?(runCommand?: ContainerCommandRunner, signal?: AbortSignal): Promise<void>;
  runArguments(options: ContainerRunOptions): string[];
  buildArguments(image: string, cpu?: number, memoryMb?: number): string[];
  inspectImageArguments(image: string): string[];
  listImagesArguments(): string[];
  removeImageArguments(image: string): string[];
  removeContainerArguments(name: string): string[];
  systemDfArguments(): string[];
  normalizeImageName(name: string): string;
}

function commandError(action: string, result: CommandResult): Error {
  return new Error(
    `${action}: ${result.timedOut ? "timed out" : result.stderr.trim() || `exit ${result.exitCode}`}`,
  );
}

function volume(
  source: string,
  target: string,
  runtime: string,
  label?: "Z" | "z",
  readOnly = false,
): string {
  if (source.includes(":"))
    throw new Error(`${runtime} cannot mount a host path containing a colon: ${source}`);
  const options = [label, readOnly ? "ro" : undefined].filter(Boolean).join(",");
  return `${source}:${target}${options ? `:${options}` : ""}`;
}

function commonRunArguments(
  executable: string,
  options: ContainerRunOptions,
  runtime: string,
  labels?: { workspace: "Z"; mount: "z" },
): string[] {
  const args = [
    executable,
    "run",
    "--rm",
    "--init",
    "--ulimit",
    "nofile=65536:65536",
    "--name",
    options.name,
    "--workdir",
    "/workspace",
    "--user",
    "0:0",
    "--entrypoint",
    "/bin/sh",
  ];
  args.push(
    "--volume",
    volume(
      options.workspace,
      options.preparedWorkspace ? options.workspace : "/workspace",
      runtime,
      labels?.workspace,
    ),
  );
  for (const mount of options.mounts ?? [])
    args.push(
      "--volume",
      volume(mount.source, mount.target, runtime, labels?.mount, mount.readOnly),
    );
  for (const [key, value] of Object.entries(options.environment))
    args.push("--env", `${key}=${value}`);
  for (const name of options.secretNames ?? []) args.push("--env", name);
  if (options.cpu) args.push("--cpus", String(options.cpu));
  if (options.memoryMb) args.push("--memory", `${options.memoryMb}M`);
  return args;
}

export const appleContainerBackend: ContainerBackend = {
  kind: "apple",
  name: "Apple Container",
  sharedStorageDescription: "the shared Apple Container runtime",
  globalPruneCommand: "container image prune --all",
  async initialize(runCommand = command, signal) {
    const options = { timeoutMs: CONTAINER_READINESS_TIMEOUT_MS, signal };
    const installed = await runCommand(["container", "--version"], options);
    if (installed.exitCode !== 0 || installed.timedOut)
      throw commandError("Apple Container is not installed", installed);
    let status = await runCommand(["container", "system", "status", "--format", "json"], options);
    if (status.exitCode === 0 && !status.timedOut) return;
    const start = await runCommand(
      ["container", "system", "start", "--enable-kernel-install"],
      options,
    );
    if (start.exitCode !== 0 || start.timedOut)
      throw commandError("could not start Apple Container", start);
    status = await runCommand(["container", "system", "status", "--format", "json"], options);
    if (status.exitCode !== 0 || status.timedOut)
      throw commandError("Apple Container is not ready", status);
  },
  runArguments(options) {
    const args = commonRunArguments("container", options, "Apple Container");
    args.push(options.image, "-lc", options.command);
    return args;
  },
  buildArguments(image, cpu, memoryMb) {
    const args = [
      "container",
      "build",
      "--file",
      "Dockerfile",
      "--tag",
      image,
      "--progress",
      "plain",
    ];
    if (cpu) args.push("--cpus", String(cpu));
    if (memoryMb) args.push("--memory", `${memoryMb}M`);
    args.push(".");
    return args;
  },
  inspectImageArguments: (image) => ["container", "image", "inspect", image],
  listImagesArguments: () => ["container", "image", "list", "--quiet"],
  removeImageArguments: (image) => ["container", "image", "delete", image],
  removeContainerArguments: (name) => ["container", "delete", "--force", name],
  systemDfArguments: () => ["container", "system", "df", "--format", "json"],
  normalizeImageName: (name) => name,
};

function caseInsensitiveField(value: unknown, name: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const matches = Object.entries(value).filter(([key]) => key.toLowerCase() === name.toLowerCase());
  return matches.length === 1 ? matches[0]?.[1] : undefined;
}

export function podmanRequiresPasta(versionOutput: string): boolean {
  const major = Number(versionOutput.match(/\bpodman\s+version\s+(\d+)/i)?.[1]);
  return Number.isSafeInteger(major) && major >= 5;
}

export function validateRootlessPodmanInfo(source: string): void {
  let info: unknown;
  try {
    info = JSON.parse(source);
  } catch {
    throw new Error("Podman returned invalid information; run `podman info` to diagnose it");
  }
  const host = caseInsensitiveField(info, "host");
  const security = caseInsensitiveField(host, "security");
  const rootless = caseInsensitiveField(security, "rootless");
  if (rootless !== true) {
    throw new Error(
      "Podman is not running rootless; configure rootless Podman for this user and verify `podman info --format json` reports rootless=true",
    );
  }
  const cgroupVersion = caseInsensitiveField(host, "cgroupVersion");
  if (typeof cgroupVersion !== "string" || cgroupVersion.toLowerCase() !== "v2") {
    throw new Error(
      "Podman requires cgroups v2 for bounded container jobs; configure cgroups v2 and verify `podman info --format json` reports cgroupVersion=v2",
    );
  }
}

function podmanSmokeError(action: string, result: CommandResult): Error {
  const error = commandError(action, result);
  if (/\/proc\/sys\/.+read-only file system/i.test(result.stderr)) {
    return new Error(
      `${error.message}; the worker service makes /proc/sys read-only—run \`informant doctor\` as the worker user and set ProtectKernelTunables=no on the reported service unit`,
    );
  }
  return error;
}

export async function verifyPodman(
  runCommand: ContainerCommandRunner = command,
  signal?: AbortSignal,
): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "informant-podman-smoke-"));
  const marker = join(workspace, "informant-smoke-test");
  const nonce = randomBytes(8).toString("hex");
  const image = `informant-podman-smoke:${nonce}`;
  try {
    signal?.throwIfAborted();
    const runSmoke = await runCommand(
      podmanContainerBackend.runArguments({
        name: `informant-podman-smoke-${nonce}`,
        image: "docker.io/oven/bun:1",
        workspace,
        command: "bun --version && touch /workspace/informant-smoke-test",
        environment: {},
        cpu: 1,
        memoryMb: 256,
      }),
      { timeoutMs: 120_000, signal },
    );
    if (runSmoke.exitCode !== 0 || runSmoke.timedOut) {
      throw podmanSmokeError("rootless Podman could not run the Informant default image", runSmoke);
    }
    if (!(await Bun.file(marker).exists())) {
      throw new Error("rootless Podman could not write to a bind-mounted workspace");
    }

    await writeFile(
      join(workspace, "Dockerfile"),
      `FROM docker.io/oven/bun:1\nRUN bun --version && printf '%s' '${nonce}' > /tmp/informant-build-smoke-test\n`,
    );
    const buildSmoke = await runCommand(podmanContainerBackend.buildArguments(image, 1, 256), {
      cwd: workspace,
      timeoutMs: 120_000,
      signal,
    });
    if (buildSmoke.exitCode !== 0 || buildSmoke.timedOut) {
      throw podmanSmokeError("rootless Podman could not build a prepared job image", buildSmoke);
    }
  } finally {
    await runCommand(["podman", "image", "rm", "--force", image], { timeoutMs: 30_000 }).catch(
      () => undefined,
    );
    await rm(workspace, { recursive: true, force: true });
  }
}

export const podmanContainerBackend: ContainerBackend = {
  kind: "podman",
  name: "rootless Podman",
  sharedStorageDescription: "the rootless Podman image store",
  async initialize(runCommand = command, signal) {
    const options = { timeoutMs: CONTAINER_READINESS_TIMEOUT_MS, signal };
    const installed = await runCommand(["podman", "--version"], options);
    if (installed.exitCode !== 0 || installed.timedOut)
      throw commandError("Podman is not installed; run `informant setup` to install it", installed);
    if (podmanRequiresPasta(installed.stdout)) {
      const pasta = await runCommand(["pasta", "--version"], options);
      if (pasta.exitCode !== 0 || pasta.timedOut) {
        throw commandError(
          "Podman's rootless network helper is unavailable; run `informant setup` to install passt",
          pasta,
        );
      }
    }
    const info = await runCommand(["podman", "info", "--format", "json"], options);
    if (info.exitCode !== 0 || info.timedOut)
      throw commandError(
        "rootless Podman is unavailable; run `podman info` as the worker user",
        info,
      );
    validateRootlessPodmanInfo(info.stdout);
  },
  verifyExecution: verifyPodman,
  runArguments(options) {
    const args = commonRunArguments("podman", options, "Podman", {
      workspace: "Z",
      mount: "z",
    });
    args.push("--security-opt", "no-new-privileges", options.image, "-lc", options.command);
    return args;
  },
  buildArguments(image, cpu, memoryMb) {
    const args = [
      "podman",
      "build",
      "--file",
      "Dockerfile",
      "--tag",
      image,
      "--progress",
      "plain",
      "--force-rm",
    ];
    if (cpu) args.push("--cpu-period", "100000", "--cpu-quota", String(cpu * 100_000));
    if (memoryMb) args.push("--memory", `${memoryMb}M`);
    args.push(".");
    return args;
  },
  inspectImageArguments: (image) => ["podman", "image", "inspect", image],
  listImagesArguments: () => ["podman", "image", "ls", "--format", "{{.Repository}}:{{.Tag}}"],
  removeImageArguments: (image) => ["podman", "image", "rm", image],
  removeContainerArguments: (name) => ["podman", "rm", "--force", name],
  systemDfArguments: () => ["podman", "system", "df", "--format", "json"],
  normalizeImageName: (name) => name.replace(/^localhost\/(?=informant-prepared-container:)/, ""),
};

export function selectContainerBackend(
  hostPlatform: NodeJS.Platform = platform(),
  hostArch = arch(),
): ContainerBackend | undefined {
  if (hostPlatform === "darwin" && hostArch === "arm64") return appleContainerBackend;
  if (hostPlatform === "linux") return podmanContainerBackend;
  return undefined;
}

interface BackendReadiness {
  backend: ContainerBackend;
  checkedAt: number;
  basicError?: Error;
  executionCheckedAt?: number;
  executionError?: Error;
}

let readiness: BackendReadiness | undefined;
interface ReadinessRefresh {
  backend: ContainerBackend;
  controller: AbortController;
  result: Promise<boolean>;
  settled: boolean;
  waiters: number;
  verifyExecution: boolean;
}

function readinessError(value: BackendReadiness | undefined): Error | undefined {
  return value?.basicError ?? value?.executionError;
}
let refreshInFlight: ReadinessRefresh | undefined;

function waitForReadiness(refresh: ReadinessRefresh, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  refresh.waiters++;
  let waiting = true;
  const release = () => {
    if (!waiting) return;
    waiting = false;
    refresh.waiters--;
    if (refresh.waiters === 0 && !refresh.settled) {
      refresh.controller.abort("Container readiness probe no longer needed.");
    }
  };
  if (!signal) return refresh.result.finally(release);
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = <T>(callback: (value: T) => void, value: T) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", abort);
      release();
      callback(value);
    };
    const abort = () => finish(reject, signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    refresh.result.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

export async function initializeContainerBackend(
  backend = selectContainerBackend(),
  runCommand: ContainerCommandRunner = command,
  now = Date.now(),
  signal?: AbortSignal,
  verifyExecution = false,
): Promise<boolean> {
  if (!backend) {
    readiness = undefined;
    return false;
  }
  const previous = readiness?.backend === backend ? readiness : undefined;
  try {
    await backend.initialize(runCommand, signal);
    signal?.throwIfAborted();
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    readiness = {
      backend,
      checkedAt: now,
      basicError: error instanceof Error ? error : new Error(String(error)),
      executionCheckedAt: previous?.executionError ? previous.executionCheckedAt : undefined,
      executionError: previous?.executionError,
    };
    return false;
  }

  let executionCheckedAt = previous?.executionCheckedAt;
  let executionError = previous?.executionError;
  if (verifyExecution) {
    executionCheckedAt = now;
    try {
      await backend.verifyExecution?.(runCommand, signal);
      signal?.throwIfAborted();
      executionError = undefined;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      executionError = error instanceof Error ? error : new Error(String(error));
    }
  }
  readiness = { backend, checkedAt: now, executionCheckedAt, executionError };
  return executionError === undefined;
}

export async function refreshContainerBackend(
  maxAgeMs = CONTAINER_READINESS_MAX_AGE_MS,
  backend = selectContainerBackend(),
  runCommand: ContainerCommandRunner = command,
  now = Date.now(),
  signal?: AbortSignal,
  verifyExecution = false,
): Promise<boolean> {
  if (
    backend &&
    readiness?.backend === backend &&
    now - readiness.checkedAt >= 0 &&
    now - readiness.checkedAt < maxAgeMs &&
    !verifyExecution
  ) {
    return readinessError(readiness) === undefined;
  }
  if (!backend)
    return initializeContainerBackend(backend, runCommand, now, signal, verifyExecution);
  if (
    refreshInFlight?.backend === backend &&
    !refreshInFlight.settled &&
    !refreshInFlight.controller.signal.aborted
  ) {
    if (!verifyExecution || refreshInFlight.verifyExecution) {
      return waitForReadiness(refreshInFlight, signal);
    }
    await waitForReadiness(refreshInFlight, signal);
    return refreshContainerBackend(maxAgeMs, backend, runCommand, now, signal, true);
  }
  if (refreshInFlight?.backend === backend) refreshInFlight = undefined;
  signal?.throwIfAborted();
  const controller = new AbortController();
  let refresh!: ReadinessRefresh;
  const result = initializeContainerBackend(
    backend,
    runCommand,
    now,
    controller.signal,
    verifyExecution,
  ).finally(() => {
    refresh.settled = true;
    if (refreshInFlight === refresh) refreshInFlight = undefined;
  });
  refresh = { backend, controller, result, settled: false, waiters: 0, verifyExecution };
  refreshInFlight = refresh;
  return waitForReadiness(refresh, signal);
}

export function refreshSelectedContainerBackend(signal?: AbortSignal): Promise<boolean> {
  const backend = selectContainerBackend();
  const now = Date.now();
  const current = readiness;
  const executionCheckedAt =
    current && current.backend === backend ? current.executionCheckedAt : undefined;
  const verifyExecution =
    Boolean(backend?.verifyExecution) &&
    (executionCheckedAt === undefined ||
      now - executionCheckedAt < 0 ||
      (Boolean(current?.executionError) &&
        now - executionCheckedAt >= CONTAINER_EXECUTION_READINESS_MAX_AGE_MS));
  return refreshContainerBackend(
    CONTAINER_READINESS_MAX_AGE_MS,
    backend,
    command,
    now,
    signal,
    verifyExecution,
  );
}

export function verifySelectedContainerBackend(signal?: AbortSignal): Promise<boolean> {
  return refreshContainerBackend(0, selectContainerBackend(), command, Date.now(), signal, true);
}

export function verifyContainerBackendExecution(
  backend: ContainerBackend,
  runCommand: ContainerCommandRunner = command,
  signal?: AbortSignal,
): Promise<boolean> {
  return refreshContainerBackend(0, backend, runCommand, Date.now(), signal, true);
}

export async function requireContainerBackend(
  backend = selectContainerBackend(),
  runCommand: ContainerCommandRunner = command,
  signal?: AbortSignal,
): Promise<ContainerBackend> {
  if (!backend) throw new Error(`container jobs are not supported on ${platform()}/${arch()}`);
  await refreshContainerBackend(
    CONTAINER_READINESS_MAX_AGE_MS,
    backend,
    runCommand,
    Date.now(),
    signal,
  );
  const error = readinessError(readiness);
  if (error) throw error;
  return backend;
}

export function containerBackendReadiness():
  | { backend: ContainerBackend; checkedAt: number; ready: boolean; error?: Error }
  | undefined {
  if (!readiness) return undefined;
  return {
    backend: readiness.backend,
    checkedAt: readiness.checkedAt,
    ready:
      readinessError(readiness) === undefined &&
      (!readiness.backend.verifyExecution || readiness.executionCheckedAt !== undefined),
    error: readinessError(readiness),
  };
}

export function resetContainerBackendReadiness(): void {
  readiness = undefined;
  if (refreshInFlight && !refreshInFlight.settled) {
    refreshInFlight.controller.abort("Container readiness state reset.");
  }
  refreshInFlight = undefined;
}
