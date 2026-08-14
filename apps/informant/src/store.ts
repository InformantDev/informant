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
const buildSaves = new Map<string, Promise<void>>();

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
  await saveBuild(record);
  await Bun.write(record.logPath, "");
}

export async function saveBuild(record: BuildRecord): Promise<void> {
  const path = join(buildDirectory(record.id), "build.json");
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
  const contents = JSON.stringify(record, null, 2);
  const status = record.status;
  const previous = buildSaves.get(record.id) ?? Promise.resolve();
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
        if (status !== "running") await rm(activeBuildPath(record.id), { force: true });
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    });
  buildSaves.set(record.id, save);
  try {
    await save;
  } finally {
    if (buildSaves.get(record.id) === save) buildSaves.delete(record.id);
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
