import type { Dirent } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { exchangeFilePaths } from "./atomic-rename.ts";
import {
  appleContainerBackend,
  CONTAINER_READINESS_TIMEOUT_MS,
  type ContainerBackend,
  type ContainerRunOptions,
  requireContainerBackend,
  selectContainerBackend,
} from "./container-backend.ts";
import { listAllowedMounts, MAX_ALLOWED_MOUNT_BYTES } from "./machine-config.ts";
import { command } from "./process.ts";
import { dataDirectory } from "./store.ts";
import { cacheMounts } from "./tart/cache.ts";
import {
  boundedLogWriter,
  type RuntimeSecrets,
  resolveJobSecrets,
  streamingSecretRedactor,
} from "./tart/index.ts";
import { bunCopyfileBackend, raiseFileDescriptorLimit } from "./tart/layout.ts";
import { digest, shellQuote, withImageLock } from "./tart/vm.ts";
import type { ContainerRuntime, JobConfig, Repository } from "./types.ts";

interface ContainerResources {
  cpu: number;
  memoryMb: number;
}

const DEFAULT_CONTAINER_RESOURCES: ContainerResources = { cpu: 1, memoryMb: 1024 };
const MOUNT_OUTPUT_SPOOL_BYTES = 10 * 1024 * 1024;
const MOUNT_OUTPUT_TRUNCATION_MARKER = "\n[informant: mounted job output truncated at 10 MiB]\n";
const WRITABLE_MOUNT_OUTPUT_MARKER =
  "[informant: child output suppressed because a writable credential mount may rotate secrets]\n";
function containerCommandError(action: string, result: Awaited<ReturnType<typeof command>>): Error {
  return new Error(
    `${action}: ${result.timedOut ? "timed out" : result.stderr.trim() || `exit ${result.exitCode}`}`,
  );
}

export async function appleContainerInstalled(
  runCommand = command,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await runCommand(["container", "--version"], {
    timeoutMs: CONTAINER_READINESS_TIMEOUT_MS,
    signal,
  });
  return result.exitCode === 0 && !result.timedOut;
}

export async function ensureAppleContainerSystem(
  runCommand = command,
  signal?: AbortSignal,
): Promise<void> {
  const options = { timeoutMs: CONTAINER_READINESS_TIMEOUT_MS, signal };
  let status = await runCommand(["container", "system", "status", "--format", "json"], options);
  if (status.exitCode === 0 && !status.timedOut) return;
  const start = await runCommand(
    ["container", "system", "start", "--enable-kernel-install"],
    options,
  );
  if (start.exitCode !== 0 || start.timedOut)
    throw containerCommandError("could not start Apple Container", start);
  status = await runCommand(["container", "system", "status", "--format", "json"], options);
  if (status.exitCode !== 0 || status.timedOut)
    throw containerCommandError("Apple Container is not ready", status);
}

export async function startAppleContainerSystem(
  runCommand = command,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!(await appleContainerInstalled(runCommand, signal))) return false;
  await ensureAppleContainerSystem(runCommand, signal);
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
  backend?: ContainerBackend;
}

type ContainerRunOperations = Pick<
  ContainerPreparationOperations,
  "command" | "withImageLock" | "dataPath" | "backend"
> & {
  allowedMounts?: Record<string, string>;
  exchange?: (left: string, right: string) => Promise<void> | void;
};

interface StagedFileMount {
  name: string;
  directory: string;
  source: string;
  filename: string;
  target: string;
  writeBack: boolean;
  mode: number;
  originalDigest: string;
  snapshot: MountedFileSnapshot;
  dataPath: string;
}

interface MountedFileSnapshot {
  version: string;
  values: string[];
}

interface ResolvedFileMount {
  name: string;
  source: string;
  target: string;
  writeBack: boolean;
}

function credentialStrings(value: unknown): string[] {
  if (typeof value === "string") return value ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(credentialStrings);
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(credentialStrings);
}

async function mountedFileSnapshot(
  path: string,
  previous?: MountedFileSnapshot,
): Promise<MountedFileSnapshot> {
  const file = await open(path, "r");
  try {
    const metadata = await file.stat({ bigint: true });
    if (metadata.size > BigInt(MAX_ALLOWED_MOUNT_BYTES))
      throw new Error(`mounted file exceeds ${MAX_ALLOWED_MOUNT_BYTES} bytes: ${path}`);
    const version = `${metadata.mtimeNs}:${metadata.ctimeNs}:${metadata.size}`;
    if (previous?.version === version) return previous;
    const contents = (await readMountedFileHandle(file, path)).toString("utf8");
    if (!contents) return { version, values: [] };
    try {
      return { version, values: [contents, ...credentialStrings(JSON.parse(contents))] };
    } catch {
      return { version, values: [contents] };
    }
  } finally {
    await file.close();
  }
}

async function readMountedFileHandle(
  file: Awaited<ReturnType<typeof open>>,
  path: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  while (size <= MAX_ALLOWED_MOUNT_BYTES) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_ALLOWED_MOUNT_BYTES + 1 - size));
    const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) return Buffer.concat(chunks, size);
    chunks.push(chunk.subarray(0, bytesRead));
    size += bytesRead;
  }
  throw new Error(`mounted file exceeds ${MAX_ALLOWED_MOUNT_BYTES} bytes: ${path}`);
}

async function mountedFileDigest(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    return new Bun.CryptoHasher("sha256")
      .update(await readMountedFileHandle(file, path))
      .digest("hex");
  } finally {
    await file.close();
  }
}

async function resolveFileMounts(
  requested: NonNullable<JobConfig["mounts"]>,
  configured?: Record<string, string>,
): Promise<ResolvedFileMount[]> {
  const allowed =
    configured ??
    Object.fromEntries((await listAllowedMounts()).map(({ name, source }) => [name, source]));
  const resolved = await Promise.all(
    requested.map(async (mount) => {
      const configuredSource = allowed[mount.source];
      if (!configuredSource)
        throw new Error(
          `mount ${mount.source} is not allowed on this worker; run informant mount allow ${mount.source} <file>`,
        );
      const source = await realpath(configuredSource);
      const metadata = await lstat(source);
      if (!metadata.isFile()) throw new Error(`allowed mount source is not a file: ${source}`);
      if (metadata.size > MAX_ALLOWED_MOUNT_BYTES)
        throw new Error(`allowed mount source exceeds ${MAX_ALLOWED_MOUNT_BYTES} bytes: ${source}`);
      return {
        name: mount.source,
        source,
        target: mount.target,
        writeBack: mount.writeBack,
      };
    }),
  );
  if (new Set(resolved.map((mount) => mount.source)).size !== resolved.length)
    throw new Error("job mounts resolve to the same allowed host file");
  return resolved;
}

async function stageFileMounts(
  requested: ResolvedFileMount[],
  dataPath = dataDirectory(),
): Promise<StagedFileMount[]> {
  const parent = join(dataPath, "file-mount-staging");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const stagedMounts: StagedFileMount[] = [];
  const createdDirectories: string[] = [];
  try {
    for (const mount of requested) {
      const metadata = await lstat(mount.source);
      const directory = await mkdtemp(join(parent, "job-"));
      createdDirectories.push(directory);
      const filename = basename(mount.source);
      const staged = join(directory, filename);
      await copyFile(mount.source, staged);
      const mode = metadata.mode & 0o777;
      await chmod(staged, mode);
      stagedMounts.push({
        name: mount.name,
        directory,
        source: mount.source,
        filename,
        target: mount.target,
        writeBack: mount.writeBack,
        mode,
        originalDigest: await mountedFileDigest(staged),
        snapshot: await mountedFileSnapshot(staged),
        dataPath,
      });
    }
    return stagedMounts;
  } catch (error) {
    await Promise.all(
      createdDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
    throw error;
  }
}

interface MountedFileRecoveryRecord {
  version: 1;
  source: string;
  temporary: string;
  originalDigest: string;
  replacementDigest: string;
}

type ExchangeFilePaths = (left: string, right: string) => Promise<void> | void;

const mountedFileRecoveryDirectory = (dataPath = dataDirectory()) =>
  join(dataPath, "file-mount-recovery");

function mountedFileRecoveryPath(source: string, dataPath = dataDirectory()): string {
  return join(mountedFileRecoveryDirectory(dataPath), `${digest(source)}.json`);
}

async function syncDirectory(path: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directory = await open(path, "r");
    await directory.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally {
    await directory?.close();
  }
}

async function writeMountedFileRecoveryRecord(
  path: string,
  record: MountedFileRecoveryRecord,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  let published = false;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(record)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    published = true;
    await syncDirectory(dirname(path));
  } finally {
    if (!published) await rm(temporary, { force: true });
  }
}

async function mountedFileDigestIfPresent(path: string): Promise<string | undefined> {
  try {
    return await mountedFileDigest(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function removeMountedFileRecoveryRecord(
  recordPath: string,
  temporary: string,
): Promise<void> {
  // Keep the recovery metadata until deletion of the displaced credential is durable.
  await rm(temporary, { force: true });
  await syncDirectory(dirname(temporary));
  await rm(recordPath, { force: true });
  await syncDirectory(dirname(recordPath));
}

async function readMountedFileRecoveryRecord(
  recordPath: string,
): Promise<MountedFileRecoveryRecord | undefined> {
  const file = Bun.file(recordPath);
  if (!(await file.exists())) return undefined;
  const record = (await file.json()) as Partial<MountedFileRecoveryRecord>;
  if (
    record.version !== 1 ||
    typeof record.source !== "string" ||
    typeof record.temporary !== "string" ||
    typeof record.originalDigest !== "string" ||
    typeof record.replacementDigest !== "string" ||
    mountedFileRecoveryPath(record.source, dirname(dirname(recordPath))) !== recordPath
  ) {
    throw new Error(`invalid mounted-file recovery record: ${recordPath}`);
  }
  return record as MountedFileRecoveryRecord;
}

async function recoverMountedFileWrite(
  recordPath: string,
  exchange: ExchangeFilePaths = exchangeFilePaths,
  expectedSource?: string,
): Promise<boolean> {
  const record = await readMountedFileRecoveryRecord(recordPath);
  if (!record) return false;
  if (expectedSource !== undefined && record.source !== expectedSource) {
    throw new Error(`mounted-file recovery record changed while locked: ${recordPath}`);
  }

  const sourceDigest = await mountedFileDigestIfPresent(record.source);
  const temporaryDigest = await mountedFileDigestIfPresent(record.temporary);
  if (temporaryDigest === undefined) {
    await rm(recordPath, { force: true });
    await syncDirectory(dirname(recordPath));
    return true;
  }
  if (sourceDigest === undefined) {
    throw new Error(
      `mounted-file recovery requires manual intervention; ${record.source} is missing and the recovery copy is ${record.temporary}`,
    );
  }

  if (sourceDigest === record.replacementDigest && temporaryDigest !== record.originalDigest) {
    // The host changed after the job's initial snapshot but before the exchange. Put the captured
    // host version back without ever removing the live pathname.
    await exchange(record.source, record.temporary);
    await syncDirectory(dirname(record.source));
  } else if (
    temporaryDigest !== record.replacementDigest &&
    temporaryDigest !== record.originalDigest
  ) {
    throw new Error(
      `mounted-file recovery requires manual intervention; preserved files are ${record.source} and ${record.temporary}`,
    );
  }

  await removeMountedFileRecoveryRecord(recordPath, record.temporary);
  return true;
}

export async function recoverMountedFileWrites(
  dataPath = dataDirectory(),
  exchange: ExchangeFilePaths = exchangeFilePaths,
  lock: typeof withImageLock = withImageLock,
): Promise<number> {
  const directory = mountedFileRecoveryDirectory(dataPath);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let recovered = 0;
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    const recordPath = join(directory, entry);
    const observed = await readMountedFileRecoveryRecord(recordPath);
    if (!observed) continue;
    const source = await realpath(observed.source).catch(() => observed.source);
    if (
      await lock(
        `host-file-${digest(source)}`,
        () => recoverMountedFileWrite(recordPath, exchange, observed.source),
        undefined,
        Number.POSITIVE_INFINITY,
      )
    ) {
      recovered++;
    }
  }
  return recovered;
}

async function persistFileMount(
  mount: StagedFileMount,
  exchange: ExchangeFilePaths = exchangeFilePaths,
): Promise<void> {
  if (!mount.writeBack) return;
  const staged = join(mount.directory, mount.filename);
  const metadata = await lstat(staged);
  if (!metadata.isFile()) throw new Error(`mounted file was removed: ${mount.name}`);
  if (metadata.size > MAX_ALLOWED_MOUNT_BYTES)
    throw new Error(`mounted file exceeds ${MAX_ALLOWED_MOUNT_BYTES} bytes: ${mount.name}`);
  const stagedDigest = await mountedFileDigest(staged);
  if (stagedDigest === mount.originalDigest) return;
  const recoveryPath = mountedFileRecoveryPath(mount.source, mount.dataPath);
  await recoverMountedFileWrite(recoveryPath, exchange);
  if ((await mountedFileDigest(mount.source)) !== mount.originalDigest) {
    throw new Error(`allowed host file changed during mounted job: ${mount.name}`);
  }

  const temporary = `${mount.source}.informant-${crypto.randomUUID().slice(0, 8)}`;
  await copyFile(staged, temporary);
  await chmod(temporary, mount.mode);
  const temporaryFile = await open(temporary, "r+");
  try {
    await temporaryFile.sync();
  } finally {
    await temporaryFile.close();
  }
  try {
    await writeMountedFileRecoveryRecord(recoveryPath, {
      version: 1,
      source: mount.source,
      temporary,
      originalDigest: mount.originalDigest,
      replacementDigest: stagedDigest,
    });
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }

  await exchange(mount.source, temporary);
  await syncDirectory(dirname(mount.source));
  if ((await mountedFileDigest(temporary)) !== mount.originalDigest) {
    try {
      await exchange(mount.source, temporary);
      await syncDirectory(dirname(mount.source));
      await removeMountedFileRecoveryRecord(recoveryPath, temporary);
    } catch (recoveryError) {
      throw new AggregateError(
        [new Error(`allowed host file changed during mounted job: ${mount.name}`), recoveryError],
        `mounted file could not be safely written back: ${mount.name}`,
      );
    }
    throw new Error(`allowed host file changed during mounted job: ${mount.name}`);
  }
  await removeMountedFileRecoveryRecord(recoveryPath, temporary);
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
  backend: ContainerBackend = selectContainerBackend() ?? appleContainerBackend,
): Promise<string[]> {
  const result = await runCommand(backend.listImagesArguments(), { signal });
  if (result.exitCode !== 0) throw containerCommandError("could not list container images", result);
  return result.stdout
    .split("\n")
    .map((image) => backend.normalizeImageName(image.trim()))
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
  backend: ContainerBackend = selectContainerBackend() ?? appleContainerBackend,
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
            () => runCommand(backend.removeImageArguments(previous), { signal }),
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
  backend: ContainerBackend = selectContainerBackend() ?? appleContainerBackend,
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
    const images = (await listPreparedContainerImages(runCommand, undefined, backend)).filter(
      (image) => !referenced.has(image) && (!known || known.has(image)),
    );
    let removed = 0;
    for (const image of images) {
      const result = await lock(`container-${digest(image).slice(0, 24)}`, () =>
        runCommand(backend.removeImageArguments(image)),
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
  backend: ContainerBackend = selectContainerBackend() ?? appleContainerBackend,
): Promise<number> {
  return prunePreparedContainerImages(runCommand, dataPath, lock, true, backend);
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
  const backend = operations.backend ?? appleContainerBackend;
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
      backend,
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
      backend.kind === "apple" ? "container-builder" : `container-${digest(prepared).slice(0, 24)}`,
      async () => {
        const existing = await runCommand(backend.inspectImageArguments(prepared), { signal });
        if (existing.exitCode === 0) return prepared;

        await onMessage(`Preparing container image ${prepared}`);
        const args = backend.buildArguments(prepared, runtime.cpu, runtime.memoryMb);
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
      backend,
    );
    return image;
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}

export function containerRunArguments(
  options: ContainerRunOptions,
  backend: ContainerBackend = appleContainerBackend,
): string[] {
  return backend.runArguments(options);
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
  const selectedBackend =
    operations.backend ?? (operations.command ? appleContainerBackend : selectContainerBackend());
  const resources = {
    cpu: runtime.cpu ?? DEFAULT_CONTAINER_RESOURCES.cpu,
    memoryMb: runtime.memoryMb ?? DEFAULT_CONTAINER_RESOURCES.memoryMb,
  };
  let releaseSlot: (() => void) | undefined;
  let backend: ContainerBackend | undefined;
  try {
    backend =
      operations.command && !operations.backend
        ? appleContainerBackend
        : await requireContainerBackend(selectedBackend, runCommand, executionSignal);
    executionSignal.throwIfAborted();
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
      backend,
    });
    const run = async (fileMounts: StagedFileMount[] = []) => {
      if (!hasContainerCapacity(resources) && activeResources.cpu > 0)
        await log(`[${job.name}] waiting for an available container slot\n`);
      releaseSlot = await acquireContainerResources(resources, executionSignal);
      const mounts: NonNullable<ContainerRunOptions["mounts"]> = caches.mounts.map((mount) => ({
        source: mount.path,
        target: `/mnt/shared/${mount.name}`,
      }));
      mounts.push(
        ...fileMounts.map((mount) => ({
          source: mount.directory,
          target: mount.target,
          readOnly: !mount.writeBack,
        })),
      );
      const args = containerRunArguments(
        {
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
        },
        backend,
      );
      await started();
      await log(`\n[${job.name}] $ ${job.command}\n`);
      const redactor = streamingSecretRedactor(
        [...Object.values(secrets), ...fileMounts.flatMap((mount) => mount.snapshot.values)],
        log,
      );
      const refreshMountedValues = async () => {
        for (const mount of fileMounts) {
          mount.snapshot = await mountedFileSnapshot(
            join(mount.directory, mount.filename),
            mount.snapshot,
          );
          redactor.add(mount.snapshot.values);
        }
      };
      const suppressChildOutput = fileMounts.some((mount) => mount.writeBack);
      // Keep delayed output only in memory: it may contain credentials that are not known to the
      // redactor until the mounted process exits, so even a private named spool is too durable.
      const spooledOutput: string[] | undefined =
        fileMounts.length > 0 && !suppressChildOutput ? [] : undefined;
      const writeSpool = spooledOutput
        ? boundedLogWriter(
            async (text) => {
              spooledOutput.push(text);
            },
            MOUNT_OUTPUT_SPOOL_BYTES,
            MOUNT_OUTPUT_TRUNCATION_MARKER,
          )
        : undefined;
      let suppressedOutput = false;
      let result: Awaited<ReturnType<typeof runCommand>> | undefined;
      let commandError: unknown;
      try {
        result = await runCommand(args, {
          env: secrets,
          signal: executionSignal,
          onOutput: async (text) => {
            if (suppressChildOutput) suppressedOutput ||= text.length > 0;
            else if (writeSpool) await writeSpool(text);
            else await redactor.write(text);
          },
        });
      } catch (error) {
        commandError = error;
      }
      let redactionError: unknown;
      try {
        if (spooledOutput) {
          // Mounted credentials may be refreshed immediately after being printed. Do not publish
          // any child output until the process exits and the final credential values are known.
          await refreshMountedValues();
          for (const text of spooledOutput) await redactor.write(text);
        } else if (suppressedOutput) {
          await redactor.write(WRITABLE_MOUNT_OUTPUT_MARKER);
        }
        await redactor.flush();
      } catch (error) {
        redactionError = error;
      }
      if (commandError && redactionError)
        throw new AggregateError(
          [commandError, redactionError],
          "container command failed and mounted output could not be redacted",
        );
      if (commandError) throw commandError;
      if (redactionError) throw redactionError;
      if (!result) throw new Error("container command did not return a result");
      return result;
    };
    const lock = operations.withImageLock ?? withImageLock;
    const resolvedMounts = await resolveFileMounts(job.mounts ?? [], operations.allowedMounts);
    const executeWithMounts = async () => {
      const staged = await stageFileMounts(resolvedMounts, operations.dataPath);
      let outcome: Awaited<ReturnType<typeof run>> | undefined;
      let runError: unknown;
      let persistenceError: unknown;
      try {
        outcome = await run(staged);
      } catch (error) {
        runError = error;
      }
      try {
        const results = await Promise.allSettled(
          staged.map((mount) => persistFileMount(mount, operations.exchange)),
        );
        const errors = results
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => result.reason);
        if (errors.length === 1) persistenceError = errors[0];
        else if (errors.length > 1)
          persistenceError = new AggregateError(
            errors,
            "multiple mounted files could not be written back",
          );
      } finally {
        await Promise.all(
          staged.map((mount) => rm(mount.directory, { recursive: true, force: true })),
        );
      }
      if (runError && persistenceError)
        throw new AggregateError(
          [runError, persistenceError],
          "container job failed and mounted files could not be written back",
        );
      if (runError) throw runError;
      if (persistenceError) throw persistenceError;
      if (!outcome) throw new Error("container job did not return a result");
      return outcome;
    };
    const writable = [
      ...new Set(resolvedMounts.filter((mount) => mount.writeBack).map((mount) => mount.source)),
    ].sort();
    const withMountLocks = (index: number): Promise<Awaited<ReturnType<typeof run>>> => {
      const source = writable[index];
      return source
        ? lock(
            `host-file-${digest(source)}`,
            () => withMountLocks(index + 1),
            executionSignal,
            Number.POSITIVE_INFINITY,
          )
        : executeWithMounts();
    };
    const result = resolvedMounts.length > 0 ? await withMountLocks(0) : await run();
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
        if (backend)
          await runCommand(backend.removeContainerArguments(name), { timeoutMs: 30_000 });
      } finally {
        releaseSlot();
      }
    }
  }
}
