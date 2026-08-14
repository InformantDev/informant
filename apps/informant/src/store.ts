import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { BuildRecord } from "./types.ts";

export function dataDirectory(): string {
  return Bun.env.INFORMANT_DATA_DIR ?? join(homedir(), ".local", "share", "informant");
}

function buildDirectory(id: string): string {
  return join(dataDirectory(), "builds", id);
}

function activeBuildDirectory(): string {
  return join(dataDirectory(), "active-builds");
}

function activeBuildPath(id: string): string {
  return join(activeBuildDirectory(), id);
}

function cancellationDirectory(id: string): string {
  const key = createHash("sha256").update(id).digest("hex");
  return join(dataDirectory(), "build-cancellations", key);
}

function cancellationRequestDirectory(id: string): string {
  return join(cancellationDirectory(id), "requests");
}

function cancellationRequestPath(id: string, requestId: string): string {
  const key = createHash("sha256").update(requestId).digest("hex");
  return join(cancellationRequestDirectory(id), key);
}

function cancellationAcknowledgementPath(id: string, requestId: string): string {
  const key = createHash("sha256").update(requestId).digest("hex");
  return join(buildDirectory(id), "cancellation-acknowledgements", key);
}

interface CancellationRequest {
  buildId: string;
  job?: string;
  requestId?: string;
  requestedAt: string;
}

function workerStateDirectory(): string {
  return join(dataDirectory(), "workers");
}

function workerStatePath(owner: NonNullable<BuildRecord["owner"]>): string {
  const identity = createHash("sha256").update(`${owner.pid}\0${owner.startedAt}`).digest("hex");
  return join(workerStateDirectory(), `${owner.pid}-${identity}.json`);
}

export function jobLogPath(record: BuildRecord, job: string): string {
  const id = createHash("sha256").update(job).digest("hex");
  return join(dirname(record.logPath), "jobs", `${id}.log`);
}

const WORKSPACE_OWNER = ".owner.json";
const ACTIVE_MARKER_GRACE_MS = 60_000;

interface BuildSaveState {
  revision: number;
  readers: number;
  tail?: Promise<void>;
}

const buildSaveStates = new Map<string, BuildSaveState>();

function buildSaveState(id: string): BuildSaveState {
  const existing = buildSaveStates.get(id);
  if (existing) return existing;
  const state: BuildSaveState = { revision: 0, readers: 0 };
  buildSaveStates.set(id, state);
  return state;
}

function cleanBuildSaveState(id: string, state: BuildSaveState): void {
  if (state.readers === 0 && state.tail === undefined && buildSaveStates.get(id) === state) {
    buildSaveStates.delete(id);
  }
}

function processStartIdentity(pid: number): string | undefined {
  const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return undefined;
  const identity = result.stdout.toString().trim();
  return identity || undefined;
}

export function currentProcessOwner(): BuildRecord["owner"] {
  const startedAt = processStartIdentity(process.pid);
  return startedAt ? { pid: process.pid, startedAt } : undefined;
}

function processOwnerIsLive(owner: unknown): boolean {
  if (!owner || typeof owner !== "object") return false;
  const value = owner as { pid?: unknown; startedAt?: unknown };
  if (!Number.isInteger(value.pid) || (value.pid as number) <= 0) return false;
  if (typeof value.startedAt !== "string" || !value.startedAt) return false;
  try {
    process.kill(value.pid as number, 0);
    return processStartIdentity(value.pid as number) === value.startedAt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
    return processStartIdentity(value.pid as number) === value.startedAt;
  }
}

export async function recordWorkerVersion(version: string): Promise<void> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid worker version: ${version}`);
  const owner = currentProcessOwner();
  if (!owner) throw new Error("Could not determine worker process start identity");
  const path = workerStatePath(owner);
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await Bun.write(
      temporaryPath,
      JSON.stringify({ owner, version, recordedAt: new Date().toISOString() }),
    );
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function runningWorkerVersion(): Promise<string | undefined> {
  const directory = workerStateDirectory();
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const live = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const path = join(directory, entry.name);
        try {
          const value = (await Bun.file(path).json()) as {
            owner?: unknown;
            recordedAt?: unknown;
            version?: unknown;
          };
          if (
            typeof value.version !== "string" ||
            !/^\d+\.\d+\.\d+$/.test(value.version) ||
            typeof value.recordedAt !== "string" ||
            !Number.isFinite(Date.parse(value.recordedAt))
          ) {
            return undefined;
          }
          if (!processOwnerIsLive(value.owner)) {
            await rm(path, { force: true });
            return undefined;
          }
          return { recordedAt: value.recordedAt, version: value.version };
        } catch {
          return undefined;
        }
      }),
  );
  return live
    .filter((value): value is NonNullable<typeof value> => value !== undefined)
    .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))[0]?.version;
}

export async function claimBuildWorkspace(workspace: string): Promise<void> {
  await mkdir(workspace, { recursive: true });
  const startedAt = processStartIdentity(process.pid);
  if (!startedAt) throw new Error("Could not determine worker process start identity");
  await Bun.write(
    join(workspace, WORKSPACE_OWNER),
    JSON.stringify({ pid: process.pid, startedAt }),
  );
}

async function workspaceHasLiveOwner(workspace: string): Promise<boolean> {
  try {
    return processOwnerIsLive(await Bun.file(join(workspace, WORKSPACE_OWNER)).json());
  } catch {
    return false;
  }
}

export async function createBuild(record: BuildRecord): Promise<void> {
  await mkdir(buildDirectory(record.id), { recursive: true });
  await rm(cancellationDirectory(record.id), { recursive: true, force: true });
  await rm(join(buildDirectory(record.id), "cancellation-acknowledgements"), {
    recursive: true,
    force: true,
  });
  await saveBuild(record);
  await Bun.write(record.logPath, "");
}

export async function saveBuild(record: BuildRecord): Promise<void> {
  const path = join(buildDirectory(record.id), "build.json");
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
  const contents = JSON.stringify(record, null, 2);
  const status = record.status;
  const state = buildSaveState(record.id);
  state.revision++;
  const previous = state.tail ?? Promise.resolve();
  const save = previous
    .catch(() => undefined)
    .then(async () => {
      try {
        if (status === "running") {
          await mkdir(activeBuildDirectory(), { recursive: true });
          await Bun.write(activeBuildPath(record.id), "");
        }
        await Bun.write(temporaryPath, contents);
        await rename(temporaryPath, path);
        if (status !== "running") {
          await rm(activeBuildPath(record.id), { force: true });
          await rm(cancellationDirectory(record.id), { recursive: true, force: true });
        }
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    });
  state.tail = save;
  try {
    await save;
  } finally {
    if (state.tail === save) state.tail = undefined;
    cleanBuildSaveState(record.id, state);
  }
}

export async function appendLog(record: BuildRecord, text: string): Promise<void> {
  await appendFile(record.logPath, text);
}

export async function getBuild(id: string): Promise<BuildRecord | undefined> {
  const file = Bun.file(join(buildDirectory(id), "build.json"));
  if (!(await file.exists())) return undefined;
  return file.json() as Promise<BuildRecord>;
}

export async function listBuilds(limit = 100): Promise<BuildRecord[]> {
  const root = join(dataDirectory(), "builds");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const directories = entries.filter((entry) => entry.isDirectory());
  const datedDirectories: { name: string; modifiedAt: number }[] = [];
  for (const entry of directories) {
    const metadata = await stat(join(root, entry.name)).catch(() => undefined);
    if (metadata) datedDirectories.push({ name: entry.name, modifiedAt: metadata.mtimeMs });
  }
  datedDirectories.sort((a, b) => b.modifiedAt - a.modifiedAt);
  const selected = Number.isFinite(limit)
    ? datedDirectories.slice(0, Math.max(0, limit))
    : datedDirectories;
  const builds = await Promise.all(selected.map((entry) => getBuild(entry.name)));
  return builds
    .filter((build): build is BuildRecord => build !== undefined)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function listAllBuilds(): Promise<BuildRecord[]> {
  return listBuilds(Number.POSITIVE_INFINITY);
}

export async function reconcileBuildLiveness(build: BuildRecord): Promise<BuildRecord> {
  if (build.status !== "running" || processOwnerIsLive(build.owner)) return build;
  build.status = "cancelled";
  build.completedAt = new Date().toISOString();
  build.runningJobs = [];
  await saveBuild(build);
  return build;
}

export async function listActiveBuilds(): Promise<BuildRecord[]> {
  const entries = await readdir(activeBuildDirectory(), { withFileTypes: true }).catch(() => []);
  const builds = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const build = await getBuild(entry.name);
        if (!build) {
          const marker = await stat(activeBuildPath(entry.name)).catch(() => undefined);
          if (marker && marker.mtimeMs < Date.now() - ACTIVE_MARKER_GRACE_MS) {
            await rm(activeBuildPath(entry.name), { force: true });
          }
          return undefined;
        }
        if (build.status !== "running") {
          await rm(activeBuildPath(entry.name), { force: true });
          return undefined;
        }
        const reconciled = await reconcileBuildLiveness(build);
        return reconciled.status === "running" ? reconciled : undefined;
      }),
  );
  return builds
    .filter((build): build is BuildRecord => build !== undefined)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function validateCancellationTarget(build: BuildRecord, id: string, job?: string): void {
  if (build.status !== "running") throw new Error(`build is not running: ${id}`);
  if (!job) return;
  const state = build.jobs?.find((item) => item.name === job);
  const legacyRunning = !build.jobs && build.runningJobs?.includes(job);
  if (!state && !legacyRunning) throw new Error(`job not found in build ${id}: ${job}`);
  if (state && state.status !== "queued" && state.status !== "running") {
    throw new Error(`job is not running or queued: ${job}`);
  }
}

export async function requestBuildCancellation(
  id: string,
  job?: string,
  operations: {
    requestId?: string;
    timeoutMs?: number;
    write?: (path: string, contents: string) => Promise<unknown>;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<BuildRecord> {
  let build = await getBuild(id);
  if (!build) throw new Error(`build not found: ${id}`);
  if (build.status === "running") build = await reconcileBuildLiveness(build);
  validateCancellationTarget(build, id, job);
  const requestId = operations.requestId ?? crypto.randomUUID();
  const acknowledgement = cancellationAcknowledgementPath(id, requestId);
  const path = cancellationRequestPath(id, requestId);
  const temporaryPath = join(cancellationDirectory(id), `.request-${crypto.randomUUID()}.tmp`);
  await mkdir(cancellationRequestDirectory(id), { recursive: true });
  const sleep = operations.sleep ?? Bun.sleep;
  try {
    await (operations.write ?? Bun.write)(
      temporaryPath,
      JSON.stringify({ buildId: id, job, requestId, requestedAt: new Date().toISOString() }),
    );
    await mkdir(cancellationRequestDirectory(id), { recursive: true });
    try {
      await rename(temporaryPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const current = await getBuild(id);
        if (!current) throw new Error(`build not found: ${id}`);
        validateCancellationTarget(current, id, job);
      }
      throw error;
    }
    const deadline = Date.now() + (operations.timeoutMs ?? 5_000);
    while (Date.now() < deadline) {
      if (await Bun.file(acknowledgement).exists()) return build;
      const current = await getBuild(id);
      if (!current) throw new Error(`build not found: ${id}`);
      try {
        validateCancellationTarget(current, id, job);
      } catch (error) {
        await rm(path, { force: true });
        throw error;
      }
      await sleep(25);
    }
    await rm(path, { force: true });
    throw new Error(`cancellation request was not acknowledged for ${job ?? id}`);
  } finally {
    await rm(temporaryPath, { force: true });
    await rm(path, { force: true });
    await rm(acknowledgement, { force: true });
  }
}

export interface BuildCancellationMonitor {
  signal: AbortSignal;
  jobSignal: (job: string) => AbortSignal | undefined;
  close: () => Promise<void>;
}

export function monitorBuildCancellation(
  id: string,
  jobs: string[],
  pollIntervalMs = 250,
  operations: {
    readBuild?: typeof getBuild;
    writeAcknowledgement?: (path: string) => Promise<unknown>;
  } = {},
): BuildCancellationMonitor {
  const buildController = new AbortController();
  const jobControllers = new Map(jobs.map((job) => [job, new AbortController()]));
  const requestDirectory = cancellationRequestDirectory(id);
  let open = true;
  let wake: (() => void) | undefined;
  const acknowledge = async (path: string, request: CancellationRequest, build: BuildRecord) => {
    if (!request.requestId || request.buildId !== id) {
      await rm(path, { force: true });
      return;
    }
    const controller = request.job ? jobControllers.get(request.job) : buildController;
    try {
      if (!controller) throw new Error(`job not found in build ${id}: ${request.job}`);
      validateCancellationTarget(build, id, request.job);
    } catch {
      await rm(path, { force: true });
      return;
    }
    const acknowledgement = cancellationAcknowledgementPath(id, request.requestId);
    const temporaryAcknowledgement = join(
      dirname(acknowledgement),
      `.acknowledgement-${crypto.randomUUID()}.tmp`,
    );
    try {
      await mkdir(dirname(acknowledgement), { recursive: true });
      await (operations.writeAcknowledgement ?? ((target) => Bun.write(target, "")))(
        temporaryAcknowledgement,
      );
      await rename(temporaryAcknowledgement, acknowledgement);
    } catch {
      await rm(temporaryAcknowledgement, { force: true }).catch(() => undefined);
      // Leave the request pending so transient publication failures can be retried.
      return;
    }
    controller.abort(
      request.job
        ? `Cancellation requested for ${request.job} from informant builds.`
        : "Cancellation requested from informant builds.",
    );
    await rm(path, { force: true }).catch(() => undefined);
  };
  const task = (async () => {
    while (open) {
      const entries = await readdir(requestDirectory, {
        withFileTypes: true,
      }).catch(() => []);
      const paths = entries
        .filter((entry) => entry.isFile())
        .map((entry) => join(requestDirectory, entry.name));
      if (paths.length > 0) {
        const requests = await Promise.all(
          paths.map(async (path) => ({
            path,
            request: (await Bun.file(path)
              .json()
              .catch(() => undefined)) as CancellationRequest | undefined,
          })),
        );
        const malformed = requests.filter(({ request }) => !request);
        await Promise.all(malformed.map(({ path }) => rm(path, { force: true })));
        const valid = requests.filter(
          (entry): entry is { path: string; request: CancellationRequest } =>
            entry.request !== undefined,
        );
        if (valid.length > 0) {
          const state = buildSaveState(id);
          state.readers++;
          try {
            while (true) {
              const revision = state.revision;
              await state.tail?.catch(() => undefined);
              const build = await (operations.readBuild ?? getBuild)(id);
              if (state.revision !== revision) continue;
              if (build) {
                await Promise.all(
                  valid.map(({ path, request }) => acknowledge(path, request, build)),
                );
              } else {
                await Promise.all(valid.map(({ path }) => rm(path, { force: true })));
              }
              break;
            }
          } finally {
            state.readers--;
            cleanBuildSaveState(id, state);
          }
        }
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        const timeout = setTimeout(resolve, pollIntervalMs);
        const finish = () => {
          clearTimeout(timeout);
          resolve();
        };
        wake = finish;
      });
      wake = undefined;
    }
  })();
  return {
    signal: buildController.signal,
    jobSignal: (job) => jobControllers.get(job)?.signal,
    close: async () => {
      open = false;
      wake?.();
      await task;
    },
  };
}

export async function removeOrphanedBuildWorkspaces(
  olderThan = Date.now() - 24 * 60 * 60 * 1_000,
): Promise<number> {
  const root = join(dataDirectory(), "builds");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspace = join(root, entry.name, "workspace");
    try {
      const metadata = await stat(workspace);
      const hasOwner = await Bun.file(join(workspace, WORKSPACE_OWNER)).exists();
      if (hasOwner && (await workspaceHasLiveOwner(workspace))) continue;
      if (!hasOwner && metadata.mtimeMs >= olderThan) continue;
      await rm(workspace, { recursive: true });
      removed++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return removed;
}
