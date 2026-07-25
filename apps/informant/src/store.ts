import { appendFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BuildRecord } from "./types.ts";

export function dataDirectory(): string {
  return Bun.env.INFORMANT_DATA_DIR ?? join(homedir(), ".local", "share", "informant");
}

function buildDirectory(id: string): string {
  return join(dataDirectory(), "builds", id);
}

const WORKSPACE_OWNER = ".owner.json";

function processStartIdentity(pid: number): string | undefined {
  const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return undefined;
  const identity = result.stdout.toString().trim();
  return identity || undefined;
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
    const owner = (await Bun.file(join(workspace, WORKSPACE_OWNER)).json()) as {
      pid?: unknown;
      startedAt?: unknown;
    };
    if (!Number.isInteger(owner.pid) || (owner.pid as number) <= 0) return false;
    if (typeof owner.startedAt !== "string" || !owner.startedAt) return false;
    try {
      process.kill(owner.pid as number, 0);
      return processStartIdentity(owner.pid as number) === owner.startedAt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
      return processStartIdentity(owner.pid as number) === owner.startedAt;
    }
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
  await Bun.write(join(buildDirectory(record.id), "build.json"), JSON.stringify(record, null, 2));
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
      if (metadata.mtimeMs >= olderThan) continue;
      if (await workspaceHasLiveOwner(workspace)) continue;
      await rm(workspace, { recursive: true });
      removed++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return removed;
}
