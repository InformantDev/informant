import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { command } from "./process.ts";
import { dataDirectory } from "./store.ts";
import { cacheMounts } from "./tart/cache.ts";
import { type RuntimeSecrets, resolveJobSecrets, streamingSecretRedactor } from "./tart/index.ts";
import { withImageLock } from "./tart/vm.ts";
import type { ContainerRuntime, JobConfig, Repository } from "./types.ts";

const MAX_CONCURRENT_CONTAINERS = 2;
let activeContainers = 0;
const containerWaiters: Array<{
  signal?: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  abort?: () => void;
}> = [];

function releaseContainerSlot(): void {
  activeContainers--;
  while (containerWaiters.length > 0) {
    const waiter = containerWaiters.shift();
    if (!waiter) return;
    if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
    if (waiter.signal?.aborted) {
      waiter.reject(waiter.signal.reason);
      continue;
    }
    activeContainers++;
    waiter.resolve(releaseContainerSlot);
    return;
  }
}

async function acquireContainerSlot(signal?: AbortSignal): Promise<() => void> {
  signal?.throwIfAborted();
  if (activeContainers < MAX_CONCURRENT_CONTAINERS) {
    activeContainers++;
    return releaseContainerSlot;
  }
  return new Promise<() => void>((resolve, reject) => {
    const waiter: (typeof containerWaiters)[number] = { signal, resolve, reject };
    waiter.abort = () => {
      const index = containerWaiters.indexOf(waiter);
      if (index >= 0) containerWaiters.splice(index, 1);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", waiter.abort, { once: true });
    containerWaiters.push(waiter);
  });
}

function containerVolume(source: string, target: string): string {
  if (source.includes(":"))
    throw new Error(`Apple Container cannot mount a host path containing a colon: ${source}`);
  return `${source}:${target}`;
}

export function preparedContainerImage(runtime: ContainerRuntime): string | undefined {
  return runtime.prepare
    ? `informant-prepared-container:${new Bun.CryptoHasher("sha256")
        .update(`${runtime.image}\0${runtime.prepare}`)
        .digest("hex")
        .slice(0, 16)}`
    : undefined;
}

export interface ContainerPreparationOperations {
  command?: typeof command;
  withImageLock?: typeof withImageLock;
}

export async function ensurePreparedContainer(
  runtime: ContainerRuntime,
  onMessage: (message: string) => Promise<void> | void = console.log,
  signal?: AbortSignal,
  operations: ContainerPreparationOperations = {},
): Promise<string> {
  const prepared = preparedContainerImage(runtime);
  const preparationCommand = runtime.prepare;
  if (!prepared || !preparationCommand) return runtime.image;
  const runCommand = operations.command ?? command;
  const lock = operations.withImageLock ?? withImageLock;
  return lock(
    "container-builder",
    async () => {
      const existing = await runCommand(["container", "image", "inspect", prepared], { signal });
      if (existing.exitCode === 0) return prepared;

      const contextRoot = join(dataDirectory(), "build-contexts");
      await mkdir(contextRoot, { recursive: true });
      const context = await mkdtemp(join(contextRoot, "informant-container-build-"));
      await onMessage(`Preparing container image ${prepared}`);
      try {
        await Bun.write(join(context, "informant-prepare.sh"), `${preparationCommand}\n`);
        await Bun.write(
          join(context, "Dockerfile"),
          `FROM ${runtime.image}\nUSER 0\nCOPY informant-prepare.sh /tmp/informant-prepare.sh\nRUN /bin/sh -lc '. /tmp/informant-prepare.sh' && rm -f /tmp/informant-prepare.sh\n`,
        );
        const args = [
          "container",
          "build",
          "--file",
          "Dockerfile",
          "--tag",
          prepared,
          "--progress",
          "plain",
        ];
        if (runtime.cpu) args.push("--cpus", String(runtime.cpu));
        if (runtime.memoryMb) args.push("--memory", `${runtime.memoryMb}M`);
        args.push(".");
        const preparation = await runCommand(args, {
          cwd: context,
          signal,
          onOutput: onMessage,
        });
        if (preparation.exitCode !== 0 || preparation.timedOut)
          throw new Error(
            `container image preparation failed: ${preparation.stderr.trim() || `exit ${preparation.exitCode}`}`,
          );
        return prepared;
      } finally {
        await rm(context, { recursive: true, force: true });
      }
    },
    signal,
  );
}

export function containerRunArguments(options: {
  name: string;
  image: string;
  workspace: string;
  command: string;
  environment: Record<string, string>;
  mounts?: Array<{ source: string; target: string }>;
  secretNames?: string[];
  cpu?: number;
  memoryMb?: number;
}): string[] {
  const args = [
    "container",
    "run",
    "--rm",
    "--init",
    "--name",
    options.name,
    "--workdir",
    "/workspace",
    "--user",
    "0:0",
    "--entrypoint",
    "/bin/sh",
  ];
  args.push("--volume", containerVolume(options.workspace, "/workspace"));
  for (const mount of options.mounts ?? [])
    args.push("--volume", containerVolume(mount.source, mount.target));
  for (const [key, value] of Object.entries(options.environment))
    args.push("--env", `${key}=${value}`);
  for (const name of options.secretNames ?? []) args.push("--env", name);
  if (options.cpu) args.push("--cpus", String(options.cpu));
  if (options.memoryMb) args.push("--memory", `${options.memoryMb}M`);
  args.push(options.image, "-lc", options.command);
  return args;
}

export async function runInContainer(
  repository: Repository,
  sha: string,
  branch: string,
  trustedSha: string,
  trustedCaches: boolean,
  workspace: string,
  job: JobConfig,
  log: (text: string) => Promise<void>,
  started: () => Promise<void>,
  runtimeSecrets: RuntimeSecrets,
  signal?: AbortSignal,
  operations: { command?: typeof command } = {},
): Promise<boolean> {
  if (job.runtime?.type !== "container")
    throw new Error("container runner requires a container runtime");
  const runtime = job.runtime;
  const name = `informant-${crypto.randomUUID().slice(0, 12)}`;
  const timeoutMs = job.timeoutMinutes * 60_000;
  const deadline = new AbortController();
  const timeout = setTimeout(
    () => deadline.abort(new Error(`${job.name} timed out after ${job.timeoutMinutes} minutes`)),
    timeoutMs,
  );
  const executionSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const runCommand = operations.command ?? command;
  let releaseSlot: (() => void) | undefined;
  try {
    executionSignal.throwIfAborted();
    if (activeContainers >= MAX_CONCURRENT_CONTAINERS)
      await log(`[${job.name}] waiting for an available Apple Container slot\n`);
    releaseSlot = await acquireContainerSlot(executionSignal);
    const secrets = await resolveJobSecrets(job, runtimeSecrets);
    executionSignal.throwIfAborted();
    const caches = await cacheMounts(
      repository,
      workspace,
      job,
      "root",
      "linux",
      trustedCaches,
      true,
    );
    const environment = {
      ...job.environment,
      INFORMANT_REPOSITORY: repository.fullName,
      INFORMANT_SHA: sha,
      INFORMANT_BRANCH: branch,
      INFORMANT_TRUSTED_SHA: trustedSha,
      HOME: "/home/root",
    };
    const execute = `${caches.restore ? `${caches.restore} && ` : ""}${job.command}`;
    const wrapped = caches.save
      ? `${execute}; status=$?; ${caches.save}; cache_status=$?; test $status -eq 0 && exit $cache_status; exit $status`
      : execute;
    const image = await ensurePreparedContainer(runtime, log, executionSignal, {
      command: runCommand,
    });
    const args = containerRunArguments({
      name,
      image,
      workspace: await realpath(workspace),
      command: wrapped,
      environment,
      mounts: caches.mounts.map((mount) => ({
        source: mount.path,
        target: `/mnt/shared/${mount.name}`,
      })),
      secretNames: Object.keys(secrets),
      cpu: runtime.cpu,
      memoryMb: runtime.memoryMb,
    });
    await started();
    await log(`\n━━ ${job.name} ━━\n[${job.name}] $ ${job.command}\n`);
    const redactor = streamingSecretRedactor(Object.values(secrets), log);
    const result = await runCommand(args, {
      env: secrets,
      signal: executionSignal,
      onOutput: redactor.write,
    });
    await redactor.flush();
    let output = `\n[${job.name}: exit ${result.exitCode}]\n`;
    if (result.timedOut) output += `[${job.name}: timed out after ${job.timeoutMinutes}m]\n`;
    await log(output);
    return result.exitCode === 0 && !result.timedOut;
  } catch (error) {
    if (deadline.signal.aborted && !signal?.aborted) throw deadline.signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
    if (releaseSlot) {
      try {
        await runCommand(["container", "delete", "--force", name], { timeoutMs: 30_000 });
      } finally {
        releaseSlot();
      }
    }
  }
}
