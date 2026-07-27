import { chmod, copyFile, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { command } from "./process.ts";
import { dataDirectory } from "./store.ts";
import { cacheMounts } from "./tart/cache.ts";
import { type RuntimeSecrets, resolveJobSecrets, streamingSecretRedactor } from "./tart/index.ts";
import { bunCopyfileBackend, raiseFileDescriptorLimit } from "./tart/layout.ts";
import { withImageLock } from "./tart/vm.ts";
import type { ContainerRuntime, JobConfig, Repository } from "./types.ts";

interface ContainerResources {
  cpu: number;
  memoryMb: number;
}

const DEFAULT_CONTAINER_RESOURCES: ContainerResources = { cpu: 1, memoryMb: 1024 };

export function containerJobCommand(
  command: string,
  cache: { restore: string; save: string; installLock?: string },
): string {
  const runtimeSetup = cache.installLock ? `${bunCopyfileBackend(cache.installLock, false)} ` : "";
  const setup = `${raiseFileDescriptorLimit()} ${runtimeSetup}${command}`;
  const execute = cache.restore ? `${cache.restore} && { ${setup}\n}` : setup;
  return cache.save
    ? `( ${execute}\n); status=$?; if [ $status -ne 0 ]; then exit $status; fi; ${cache.save}`
    : execute;
}

export function containerCapacity(
  hostCpu = availableParallelism(),
  hostMemoryMb = Math.floor(totalmem() / 1024 / 1024),
): ContainerResources {
  return {
    cpu: Math.max(1, hostCpu - 2),
    memoryMb: Math.max(1024, Math.floor(hostMemoryMb * 0.75)),
  };
}

const capacity = containerCapacity();
const activeResources: ContainerResources = { cpu: 0, memoryMb: 0 };
const containerWaiters: Array<{
  resources: ContainerResources;
  signal?: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  abort?: () => void;
}> = [];

function hasContainerCapacity(resources: ContainerResources): boolean {
  return (
    activeResources.cpu + resources.cpu <= capacity.cpu &&
    activeResources.memoryMb + resources.memoryMb <= capacity.memoryMb
  );
}

function reserveContainerResources(resources: ContainerResources): () => void {
  activeResources.cpu += resources.cpu;
  activeResources.memoryMb += resources.memoryMb;
  return () => releaseContainerResources(resources);
}

function releaseContainerResources(resources: ContainerResources): void {
  activeResources.cpu -= resources.cpu;
  activeResources.memoryMb -= resources.memoryMb;
  while (containerWaiters.length > 0) {
    const waiter = containerWaiters[0];
    if (!waiter) return;
    if (waiter.signal?.aborted) {
      containerWaiters.shift();
      if (waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.reject(waiter.signal.reason);
      continue;
    }
    if (!hasContainerCapacity(waiter.resources) && activeResources.cpu > 0) return;
    containerWaiters.shift();
    if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
    waiter.resolve(reserveContainerResources(waiter.resources));
  }
}

async function acquireContainerResources(
  resources: ContainerResources,
  signal?: AbortSignal,
): Promise<() => void> {
  signal?.throwIfAborted();
  if (hasContainerCapacity(resources) || activeResources.cpu === 0)
    return reserveContainerResources(resources);
  return new Promise<() => void>((resolve, reject) => {
    const waiter: (typeof containerWaiters)[number] = { resources, signal, resolve, reject };
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

export function preparedContainerImage(
  runtime: ContainerRuntime,
  prepareInputsDigest?: string,
): string | undefined {
  return runtime.prepare
    ? `informant-prepared-container:${new Bun.CryptoHasher("sha256")
        .update(
          `${runtime.image}\0${runtime.prepare}${prepareInputsDigest ? `\0prepareInputs\0${prepareInputsDigest}` : ""}`,
        )
        .digest("hex")
        .slice(0, 16)}`
    : undefined;
}

interface PreparedContainerInput {
  path: string;
  source: string;
  mode: number;
}

function containedPath(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

async function snapshotPreparedContainerInputs(
  runtime: ContainerRuntime,
  context: string,
  workspace?: string,
): Promise<string | undefined> {
  if (!runtime.prepareInputs) return undefined;
  if (!workspace) throw new Error("container.prepareInputs requires a job workspace");
  const root = await realpath(workspace);
  const files = new Map<string, PreparedContainerInput>();
  for (const pattern of runtime.prepareInputs) {
    const matches = await Array.fromAsync(
      new Bun.Glob(pattern).scan({ cwd: root, dot: true, onlyFiles: true }),
    );
    if (matches.length === 0)
      throw new Error(`container.prepareInputs pattern matched no files: ${pattern}`);
    for (const path of matches) {
      const source = resolve(root, path);
      if (!containedPath(root, source))
        throw new Error(`container.prepareInputs escaped the job workspace: ${path}`);
      const canonical = await realpath(source);
      if (!containedPath(root, canonical) || canonical !== source)
        throw new Error(`container.prepareInputs cannot traverse a symbolic link: ${path}`);
      const metadata = await lstat(source);
      if (metadata.isSymbolicLink())
        throw new Error(`container.prepareInputs cannot include a symbolic link: ${path}`);
      if (!metadata.isFile())
        throw new Error(`container.prepareInputs can only include files: ${path}`);
      files.set(relative(root, source), {
        path: relative(root, source),
        source,
        mode: metadata.mode,
      });
    }
  }
  const sorted = [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
  const inputRoot = join(context, "informant-prepare-inputs");
  const records: Array<[string, number, string]> = [];
  for (const file of sorted) {
    const destination = join(inputRoot, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(file.source, destination);
    const mode = file.mode & 0o7777;
    await chmod(destination, mode);
    records.push([
      file.path,
      mode,
      new Bun.CryptoHasher("sha256")
        .update(await Bun.file(destination).arrayBuffer())
        .digest("hex"),
    ]);
  }
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(records)).digest("hex");
}

export interface ContainerPreparationOperations {
  command?: typeof command;
  withImageLock?: typeof withImageLock;
}

export async function ensurePreparedContainer(
  runtime: ContainerRuntime,
  workspace?: string,
  onMessage: (message: string) => Promise<void> | void = console.log,
  signal?: AbortSignal,
  operations: ContainerPreparationOperations = {},
): Promise<string> {
  const preparationCommand = runtime.prepare;
  if (!preparationCommand) return runtime.image;
  const runCommand = operations.command ?? command;
  const lock = operations.withImageLock ?? withImageLock;
  const contextRoot = join(dataDirectory(), "build-contexts");
  await mkdir(contextRoot, { recursive: true });
  const context = await mkdtemp(join(contextRoot, "informant-container-build-"));
  try {
    const inputDigest = await snapshotPreparedContainerInputs(runtime, context, workspace);
    const prepared = preparedContainerImage(runtime, inputDigest);
    if (!prepared) return runtime.image;
    await Bun.write(join(context, "informant-prepare.sh"), `${preparationCommand}\n`);
    const inputSetup = inputDigest
      ? "COPY informant-prepare-inputs /informant/prepare-inputs\nENV HOME=/home/root\n"
      : "";
    const preparationLayer = inputDigest
      ? `RUN INFORMANT_PREPARE_ROOT=/informant/prepare-inputs /bin/sh -lc 'cd "$INFORMANT_PREPARE_ROOT" && . /tmp/informant-prepare.sh' && rm -rf /informant/prepare-inputs /tmp/informant-prepare.sh\n`
      : "RUN /bin/sh -lc '. /tmp/informant-prepare.sh' && rm -f /tmp/informant-prepare.sh\n";
    await Bun.write(
      join(context, "Dockerfile"),
      `FROM ${runtime.image}\nUSER 0\nCOPY informant-prepare.sh /tmp/informant-prepare.sh\n${inputSetup}${preparationLayer}`,
    );
    return await lock(
      "container-builder",
      async () => {
        const existing = await runCommand(["container", "image", "inspect", prepared], { signal });
        if (existing.exitCode === 0) return prepared;

        await onMessage(`Preparing container image ${prepared}`);
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
      },
      signal,
    );
  } finally {
    await rm(context, { recursive: true, force: true });
  }
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
): Promise<{ success: boolean; exitCode: number; timedOut: boolean }> {
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
  const resources = {
    cpu: runtime.cpu ?? DEFAULT_CONTAINER_RESOURCES.cpu,
    memoryMb: runtime.memoryMb ?? DEFAULT_CONTAINER_RESOURCES.memoryMb,
  };
  let releaseSlot: (() => void) | undefined;
  try {
    executionSignal.throwIfAborted();
    if (!hasContainerCapacity(resources) && activeResources.cpu > 0)
      await log(`[${job.name}] waiting for an available Apple Container slot\n`);
    releaseSlot = await acquireContainerResources(resources, executionSignal);
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
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      FORCE_COLOR: "3",
      CLICOLOR_FORCE: "1",
      ...job.environment,
      INFORMANT_REPOSITORY: repository.fullName,
      INFORMANT_SHA: sha,
      INFORMANT_BRANCH: branch,
      INFORMANT_TRUSTED_SHA: trustedSha,
      HOME: "/home/root",
    };
    const wrapped = containerJobCommand(job.command, caches);
    const image = await ensurePreparedContainer(runtime, workspace, log, executionSignal, {
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
      cpu: resources.cpu,
      memoryMb: resources.memoryMb,
    });
    await started();
    await log(`\n[${job.name}] $ ${job.command}\n`);
    const redactor = streamingSecretRedactor(Object.values(secrets), log);
    const result = await runCommand(args, {
      env: secrets,
      signal: executionSignal,
      onOutput: redactor.write,
    });
    await redactor.flush();
    return {
      success: result.exitCode === 0 && !result.timedOut,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    };
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
