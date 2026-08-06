import { arch, platform } from "node:os";
import { type CommandResult, command } from "./process.ts";

export type ContainerCommandRunner = typeof command;
export const CONTAINER_READINESS_MAX_AGE_MS = 30_000;
export const CONTAINER_READINESS_TIMEOUT_MS = 15_000;

export interface ContainerRunOptions {
  name: string;
  image: string;
  workspace: string;
  command: string;
  environment: Record<string, string>;
  mounts?: Array<{ source: string; target: string }>;
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

function volume(source: string, target: string, runtime: string, label?: "Z" | "z"): string {
  if (source.includes(":"))
    throw new Error(`${runtime} cannot mount a host path containing a colon: ${source}`);
  return `${source}:${target}${label ? `:${label}` : ""}`;
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
    args.push("--volume", volume(mount.source, mount.target, runtime, labels?.mount));
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

function rootlessMarker(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase() === "rootless" && child === true) return true;
    if (rootlessMarker(child)) return true;
  }
  return false;
}

function findCaseInsensitiveField(value: unknown, name: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase() === name.toLowerCase()) return child;
    const nested = findCaseInsensitiveField(child, name);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

export function validateRootlessPodmanInfo(source: string): void {
  let info: unknown;
  try {
    info = JSON.parse(source);
  } catch {
    throw new Error("Podman returned invalid information; run `podman info` to diagnose it");
  }
  if (!rootlessMarker(info)) {
    throw new Error(
      "Podman is not running rootless; configure rootless Podman for this user and verify `podman info --format json` reports rootless=true",
    );
  }
  const cgroupVersion = findCaseInsensitiveField(info, "cgroupVersion");
  if (
    cgroupVersion !== 2 &&
    String(cgroupVersion).toLowerCase() !== "v2" &&
    cgroupVersion !== "2"
  ) {
    throw new Error(
      "Podman requires cgroups v2 for bounded container jobs; configure cgroups v2 and verify `podman info --format json` reports cgroupVersion=v2",
    );
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
    const info = await runCommand(["podman", "info", "--format", "json"], options);
    if (info.exitCode !== 0 || info.timedOut)
      throw commandError(
        "rootless Podman is unavailable; run `podman info` as the worker user",
        info,
      );
    validateRootlessPodmanInfo(info.stdout);
  },
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

let readiness: { backend: ContainerBackend; checkedAt: number; error?: Error } | undefined;
let refreshInFlight: { backend: ContainerBackend; result: Promise<boolean> } | undefined;

export async function initializeContainerBackend(
  backend = selectContainerBackend(),
  runCommand: ContainerCommandRunner = command,
  now = Date.now(),
  signal?: AbortSignal,
): Promise<boolean> {
  if (!backend) {
    readiness = undefined;
    return false;
  }
  try {
    await backend.initialize(runCommand, signal);
    readiness = { backend, checkedAt: now };
    return true;
  } catch (error) {
    readiness = {
      backend,
      checkedAt: now,
      error: error instanceof Error ? error : new Error(String(error)),
    };
    return false;
  }
}

export async function refreshContainerBackend(
  maxAgeMs = CONTAINER_READINESS_MAX_AGE_MS,
  backend = selectContainerBackend(),
  runCommand: ContainerCommandRunner = command,
  now = Date.now(),
  signal?: AbortSignal,
): Promise<boolean> {
  if (
    backend &&
    readiness?.backend === backend &&
    now - readiness.checkedAt >= 0 &&
    now - readiness.checkedAt < maxAgeMs
  ) {
    return readiness.error === undefined;
  }
  if (!backend) return initializeContainerBackend(backend, runCommand, now, signal);
  if (refreshInFlight?.backend === backend) return refreshInFlight.result;
  const result = initializeContainerBackend(backend, runCommand, now, signal).finally(() => {
    if (refreshInFlight?.result === result) refreshInFlight = undefined;
  });
  refreshInFlight = { backend, result };
  return result;
}

export function refreshSelectedContainerBackend(signal?: AbortSignal): Promise<boolean> {
  return refreshContainerBackend(
    CONTAINER_READINESS_MAX_AGE_MS,
    selectContainerBackend(),
    command,
    Date.now(),
    signal,
  );
}

export async function requireContainerBackend(
  backend = selectContainerBackend(),
  runCommand: ContainerCommandRunner = command,
): Promise<ContainerBackend> {
  if (!backend) throw new Error(`container jobs are not supported on ${platform()}/${arch()}`);
  await refreshContainerBackend(CONTAINER_READINESS_MAX_AGE_MS, backend, runCommand);
  if (readiness?.error) throw readiness.error;
  return backend;
}

export function containerBackendReadiness():
  | { backend: ContainerBackend; checkedAt: number; ready: boolean; error?: Error }
  | undefined {
  if (!readiness) return undefined;
  return {
    backend: readiness.backend,
    checkedAt: readiness.checkedAt,
    ready: readiness.error === undefined,
    error: readiness.error,
  };
}

export function resetContainerBackendReadiness(): void {
  readiness = undefined;
  refreshInFlight = undefined;
}
