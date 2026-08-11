import type { Dirent } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { listAllowedMounts } from "./machine-config.ts";
import { command } from "./process.ts";
import { dataDirectory } from "./store.ts";
import { cacheMounts } from "./tart/cache.ts";
import { type RuntimeSecrets, resolveJobSecrets, streamingSecretRedactor } from "./tart/index.ts";
import { bunCopyfileBackend, raiseFileDescriptorLimit } from "./tart/layout.ts";
import { digest, shellQuote, withImageLock } from "./tart/vm.ts";
import type { ContainerRuntime, JobConfig, Repository } from "./types.ts";

interface ContainerResources {
  cpu: number;
  memoryMb: number;
}

const DEFAULT_CONTAINER_RESOURCES: ContainerResources = { cpu: 1, memoryMb: 1024 };

function containerCommandError(action: string, result: Awaited<ReturnType<typeof command>>): Error {
  return new Error(`${action}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
}

export async function appleContainerInstalled(runCommand = command): Promise<boolean> {
  return (await runCommand(["container", "--version"])).exitCode === 0;
}

export async function ensureAppleContainerSystem(runCommand = command): Promise<void> {
  let status = await runCommand(["container", "system", "status", "--format", "json"]);
  if (status.exitCode === 0) return;

  const start = await runCommand(["container", "system", "start", "--enable-kernel-install"]);
  if (start.exitCode !== 0) throw containerCommandError("could not start Apple Container", start);
  status = await runCommand(["container", "system", "status", "--format", "json"]);
  if (status.exitCode !== 0) throw containerCommandError("Apple Container is not ready", status);
}

export async function startAppleContainerSystem(runCommand = command): Promise<boolean> {
  if (!(await appleContainerInstalled(runCommand))) return false;
  await ensureAppleContainerSystem(runCommand);
  return true;
}

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
          `${runtime.image}\0${runtime.prepare}${prepareInputsDigest ? `\0preparedWorkspaceV1\0${prepareInputsDigest}` : ""}`,
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
  reference?: string;
  dataPath?: string;
}

type ContainerRunOperations = Pick<
  ContainerPreparationOperations,
  "command" | "withImageLock" | "dataPath"
> & { allowedMounts?: Record<string, string> };

interface StagedFileMount {
  name: string;
  directory: string;
  source: string;
  filename: string;
  target: string;
  writeBack: boolean;
  mode: number;
  values: string[];
}

function credentialStrings(value: unknown): string[] {
  if (typeof value === "string") return value ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(credentialStrings);
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(credentialStrings);
}

async function stageFileMounts(
  requested: NonNullable<JobConfig["mounts"]>,
  configured?: Record<string, string>,
  dataPath = dataDirectory(),
): Promise<StagedFileMount[]> {
  const allowed =
    configured ??
    Object.fromEntries((await listAllowedMounts()).map(({ name, source }) => [name, source]));
  const parent = join(dataPath, "file-mount-staging");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  return Promise.all(
    requested.map(async (mount) => {
      const configuredSource = allowed[mount.source];
      if (!configuredSource)
        throw new Error(
          `mount ${mount.source} is not allowed on this worker; run informant mount allow ${mount.source} <file>`,
        );
      const source = await realpath(configuredSource);
      const metadata = await lstat(source);
      if (!metadata.isFile()) throw new Error(`allowed mount source is not a file: ${source}`);
      const directory = await mkdtemp(join(parent, "job-"));
      const filename = basename(source);
      const staged = join(directory, filename);
      await copyFile(source, staged);
      const mode = metadata.mode & 0o777;
      await chmod(staged, mode);
      const contents = await readFile(source, "utf8").catch(() => "");
      let parsed: unknown;
      try {
        parsed = JSON.parse(contents);
      } catch {
        parsed = undefined;
      }
      return {
        name: mount.source,
        directory,
        source,
        filename,
        target: mount.target,
        writeBack: mount.writeBack,
        mode,
        values: [...(contents ? [contents] : []), ...credentialStrings(parsed)],
      };
    }),
  );
}

async function persistFileMount(mount: StagedFileMount): Promise<void> {
  if (!mount.writeBack) return;
  const staged = join(mount.directory, mount.filename);
  const metadata = await lstat(staged);
  if (!metadata.isFile()) throw new Error(`mounted file was removed: ${mount.name}`);
  const temporary = `${mount.source}.informant-${crypto.randomUUID().slice(0, 8)}`;
  await copyFile(staged, temporary);
  await chmod(temporary, mount.mode);
  await rename(temporary, mount.source);
}

const preparedContainerReferencesDirectory = (dataPath = dataDirectory()) =>
  join(dataPath, "prepared-container-image-references");

const preparedContainerHistoryDirectory = (dataPath = dataDirectory()) =>
  join(dataPath, "prepared-container-image-history");

function preparedContainerHistoryPath(image: string, dataPath?: string): string {
  return join(preparedContainerHistoryDirectory(dataPath), digest(image));
}

function preparedContainerReferencePath(reference: string, dataPath?: string): string {
  const separator = reference.indexOf("\0");
  if (separator < 0) return join(preparedContainerReferencesDirectory(dataPath), digest(reference));
  return join(
    preparedContainerReferencesDirectory(dataPath),
    `${digest(reference.slice(0, separator))}.jobs`,
    digest(reference.slice(separator + 1)),
  );
}

async function preparedContainerReferenceValues(
  excluded?: string,
  directory = preparedContainerReferencesDirectory(),
): Promise<string[]> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const values = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return preparedContainerReferenceValues(excluded, path);
      if (!entry.isFile() || path === excluded) return [];
      return [(await readFile(path, "utf8")).trim()];
    }),
  );
  return values.flat().filter(Boolean);
}

export async function listPreparedContainerImages(
  runCommand: typeof command = command,
  signal?: AbortSignal,
): Promise<string[]> {
  const result = await runCommand(["container", "image", "list", "--quiet"], { signal });
  if (result.exitCode !== 0) throw containerCommandError("could not list container images", result);
  return result.stdout
    .split("\n")
    .map((image) => image.trim())
    .filter((image) => /^informant-prepared-container:[0-9a-f]{16}$/.test(image));
}

async function activatePreparedContainerImage(
  reference: string | undefined,
  prepared: string | undefined,
  onMessage: (message: string) => Promise<void> | void,
  runCommand: typeof command,
  lock: typeof withImageLock,
  signal?: AbortSignal,
  dataPath?: string,
): Promise<void> {
  if (!reference) return;
  await lock(
    "prepared-container-image-references",
    async () => {
      const path = preparedContainerReferencePath(reference, dataPath);
      const previous = (await readFile(path, "utf8").catch(() => "")).trim() || undefined;
      if (prepared) {
        await mkdir(preparedContainerHistoryDirectory(dataPath), { recursive: true });
        await Bun.write(preparedContainerHistoryPath(prepared, dataPath), `${prepared}\n`);
      }
      if (previous === prepared) return;
      if (previous) {
        const referenced = await preparedContainerReferenceValues(
          path,
          preparedContainerReferencesDirectory(dataPath),
        );
        if (!referenced.includes(previous)) {
          const result = await lock(
            `container-${digest(previous).slice(0, 24)}`,
            () => runCommand(["container", "image", "delete", previous], { signal }),
            signal,
          );
          if (result.exitCode === 0) {
            await rm(preparedContainerHistoryPath(previous, dataPath), { force: true });
            await onMessage(`Deleted superseded container image ${previous}`);
          } else
            await onMessage(
              `Could not delete superseded container image ${previous}; will retry later`,
            );
        }
      }
      await mkdir(dirname(path), { recursive: true });
      if (prepared) await Bun.write(path, `${prepared}\n`);
      else await rm(path, { force: true });
    },
    signal,
  );
}

export async function reconcilePreparedContainerImageReferences(
  repository: string,
  containerJobs: string[],
  signal?: AbortSignal,
): Promise<number> {
  return withImageLock(
    "prepared-container-image-references",
    async () => {
      const directory = preparedContainerReferencesDirectory();
      const jobDirectory = join(directory, `${digest(repository)}.jobs`);
      const active = new Set(containerJobs.map(digest));
      const entries = await readdir(jobDirectory, { withFileTypes: true }).catch(() => []);
      const stale = entries.filter((entry) => entry.isFile() && !active.has(entry.name));
      await Promise.all(stale.map((entry) => rm(join(jobDirectory, entry.name), { force: true })));
      await rm(join(directory, digest(repository)), { force: true });
      return stale.length;
    },
    signal,
  );
}

export async function reconcilePreparedContainerImageRepositories(
  repositories: string[],
): Promise<number> {
  return withImageLock("prepared-container-image-references", async () => {
    const directory = preparedContainerReferencesDirectory();
    const active = new Set(
      repositories.flatMap((repository) => [digest(repository), `${digest(repository)}.jobs`]),
    );
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const stale = entries.filter((entry) => !active.has(entry.name));
    await Promise.all(
      stale.map((entry) => rm(join(directory, entry.name), { recursive: true, force: true })),
    );
    return stale.length;
  });
}

export async function prunePreparedContainerImages(
  runCommand: typeof command = command,
  dataPath = dataDirectory(),
  lock: typeof withImageLock = withImageLock,
  knownOnly = false,
): Promise<number> {
  return lock("prepared-container-image-references", async () => {
    const referenced = new Set(
      await preparedContainerReferenceValues(
        undefined,
        preparedContainerReferencesDirectory(dataPath),
      ),
    );
    const known = knownOnly
      ? new Set(
          await preparedContainerReferenceValues(
            undefined,
            preparedContainerHistoryDirectory(dataPath),
          ),
        )
      : undefined;
    const images = (await listPreparedContainerImages(runCommand)).filter(
      (image) => !referenced.has(image) && (!known || known.has(image)),
    );
    let removed = 0;
    for (const image of images) {
      const result = await lock(`container-${digest(image).slice(0, 24)}`, () =>
        runCommand(["container", "image", "delete", image]),
      );
      if (result.exitCode === 0) {
        await rm(preparedContainerHistoryPath(image, dataPath), { force: true });
        removed++;
      }
    }
    return removed;
  });
}

export async function pruneKnownPreparedContainerImages(
  runCommand: typeof command = command,
  dataPath = dataDirectory(),
  lock: typeof withImageLock = withImageLock,
): Promise<number> {
  return prunePreparedContainerImages(runCommand, dataPath, lock, true);
}

export async function ensurePreparedContainer(
  runtime: ContainerRuntime,
  workspace?: string,
  onMessage: (message: string) => Promise<void> | void = console.log,
  signal?: AbortSignal,
  operations: ContainerPreparationOperations = {},
): Promise<string> {
  const runCommand = operations.command ?? command;
  const lock = operations.withImageLock ?? withImageLock;
  const preparationCommand = runtime.prepare;
  if (!preparationCommand) {
    await activatePreparedContainerImage(
      operations.reference,
      undefined,
      onMessage,
      runCommand,
      lock,
      signal,
      operations.dataPath,
    );
    return runtime.image;
  }
  const contextRoot = join(operations.dataPath ?? dataDirectory(), "build-contexts");
  await mkdir(contextRoot, { recursive: true });
  const context = await mkdtemp(join(contextRoot, "informant-container-build-"));
  try {
    const inputDigest = await snapshotPreparedContainerInputs(runtime, context, workspace);
    const prepared = preparedContainerImage(runtime, inputDigest);
    if (!prepared) return runtime.image;
    await Bun.write(join(context, "informant-prepare.sh"), `${preparationCommand}\n`);
    const inputSetup = inputDigest
      ? "COPY informant-prepare-inputs /workspace\nENV HOME=/home/root\n"
      : "";
    const preparationLayer = inputDigest
      ? `RUN INFORMANT_PREPARE_ROOT=/workspace /bin/sh -lc 'cd "$INFORMANT_PREPARE_ROOT" && . /tmp/informant-prepare.sh' && rm -f /tmp/informant-prepare.sh\n`
      : "RUN /bin/sh -lc '. /tmp/informant-prepare.sh' && rm -f /tmp/informant-prepare.sh\n";
    await Bun.write(
      join(context, "Dockerfile"),
      `FROM ${runtime.image}\nUSER 0\nCOPY informant-prepare.sh /tmp/informant-prepare.sh\n${inputSetup}${preparationLayer}`,
    );
    const image = await lock(
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
    await activatePreparedContainerImage(
      operations.reference,
      image,
      onMessage,
      runCommand,
      lock,
      signal,
      operations.dataPath,
    );
    return image;
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
  preparedWorkspace?: boolean;
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
  args.push(
    "--volume",
    containerVolume(
      options.workspace,
      options.preparedWorkspace ? options.workspace : "/workspace",
    ),
  );
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
  operations: ContainerRunOperations = {},
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
    const hostWorkspace = await realpath(workspace);
    const usesPreparedWorkspace = Boolean(runtime.prepareInputs);
    const hasStandaloneGitDirectory =
      usesPreparedWorkspace && (await lstat(join(hostWorkspace, ".git"))).isDirectory();
    const sourceSetup = usesPreparedWorkspace
      ? `cp -R ${shellQuote(hostWorkspace)}/. /workspace/ &&\n${hasStandaloneGitDirectory ? "" : "rm -f /workspace/.git &&\n"}`
      : "";
    const wrapped = containerJobCommand(`${sourceSetup}${job.command}`, caches);
    const image = await ensurePreparedContainer(runtime, workspace, log, executionSignal, {
      command: runCommand,
      withImageLock: operations.withImageLock ?? withImageLock,
      reference: `${repository.fullName}\0${job.name}`,
      dataPath: operations.dataPath,
    });
    const run = async (fileMounts: StagedFileMount[] = []) => {
      const mounts = caches.mounts.map((mount) => ({
        source: mount.path,
        target: `/mnt/shared/${mount.name}`,
      }));
      mounts.push(
        ...fileMounts.map((mount) => ({ source: mount.directory, target: mount.target })),
      );
      const args = containerRunArguments({
        name,
        image,
        workspace: hostWorkspace,
        command: wrapped,
        environment,
        mounts,
        secretNames: Object.keys(secrets),
        cpu: resources.cpu,
        memoryMb: resources.memoryMb,
        preparedWorkspace: usesPreparedWorkspace,
      });
      await started();
      await log(`\n[${job.name}] $ ${job.command}\n`);
      const redactor = streamingSecretRedactor(
        [...Object.values(secrets), ...fileMounts.flatMap((mount) => mount.values)],
        log,
      );
      const result = await runCommand(args, {
        env: secrets,
        signal: executionSignal,
        onOutput: redactor.write,
      });
      await redactor.flush();
      return result;
    };
    const lock = operations.withImageLock ?? withImageLock;
    const executeWithMounts = async () => {
      const staged = await stageFileMounts(
        job.mounts ?? [],
        operations.allowedMounts,
        operations.dataPath,
      );
      try {
        const outcome = await run(staged);
        await Promise.all(staged.map(persistFileMount));
        return outcome;
      } finally {
        await Promise.all(
          staged.map((mount) => rm(mount.directory, { recursive: true, force: true })),
        );
      }
    };
    const writable = [
      ...new Set(
        (job.mounts ?? []).filter((mount) => mount.writeBack).map((mount) => mount.source),
      ),
    ].sort();
    const withMountLocks = (index: number): Promise<Awaited<ReturnType<typeof run>>> => {
      const name = writable[index];
      return name
        ? lock(`host-file-${digest(name)}`, () => withMountLocks(index + 1), executionSignal)
        : executeWithMounts();
    };
    const result = (job.mounts?.length ?? 0) > 0 ? await withMountLocks(0) : await run();
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
