import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  pruneKnownPreparedContainerImages,
  type prunePreparedContainerImages,
  reconcilePreparedContainerImageRepositories,
} from "./container.ts";
import {
  allocatedDirectorySize,
  type FileSystemSpace,
  fileSystemSpace,
  minimumFreeSpace,
} from "./storage.ts";
import { dataDirectory, listActiveBuilds } from "./store.ts";
import { prunePreparedImages, reconcilePreparedImageRepositories } from "./tart/images.ts";
import { digest, withImageLock } from "./tart/vm.ts";
import type { Repository } from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;
const GIGABYTE = 1_000_000_000;

export interface HousekeepingPolicy {
  buildRetentionMs: number;
  buildHistoryLimit: number;
  pressureBuildHistoryLimit: number;
  keyedCacheMaxBytes: number;
  cacheVersionRetentionMs: number;
}

export interface HousekeepingSummary {
  skipped: boolean;
  builds: number;
  cacheRepositories: number;
  cacheJobs: number;
  cacheVersions: number;
  sharedCaches: number;
  tartImages: number;
  containerImages: number;
  pressure: boolean;
}

interface HousekeepingOperations {
  dataPath?: string;
  now?: number;
  activeBuildIds?: () => Promise<string[]>;
  directorySize?: (path: string) => Promise<number>;
  diskSpace?: (path: string) => Promise<FileSystemSpace>;
  withLock?: typeof withImageLock;
  reconcileTartRepositories?: typeof reconcilePreparedImageRepositories;
  reconcileContainerRepositories?: typeof reconcilePreparedContainerImageRepositories;
  pruneTartImages?: typeof prunePreparedImages;
  pruneContainerImages?: typeof prunePreparedContainerImages;
}

interface DirectoryEntry {
  name: string;
  path: string;
  modifiedAt: number;
}

function environmentNumber(
  environment: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const value = Number(environment[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function housekeepingPolicy(
  environment: Record<string, string | undefined> = Bun.env,
): HousekeepingPolicy {
  return {
    buildRetentionMs: environmentNumber(environment, "INFORMANT_BUILD_RETENTION_DAYS", 30) * DAY_MS,
    buildHistoryLimit: environmentNumber(environment, "INFORMANT_BUILD_HISTORY_LIMIT", 100),
    pressureBuildHistoryLimit: environmentNumber(
      environment,
      "INFORMANT_PRESSURE_BUILD_HISTORY_LIMIT",
      20,
    ),
    keyedCacheMaxBytes:
      environmentNumber(environment, "INFORMANT_KEYED_CACHE_MAX_GB", 20) * GIGABYTE,
    cacheVersionRetentionMs: 7 * DAY_MS,
  };
}

async function childDirectories(path: string): Promise<DirectoryEntry[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  const directories = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const child = join(path, entry.name);
        const metadata = await stat(child).catch(() => undefined);
        return metadata
          ? { name: entry.name, path: child, modifiedAt: metadata.mtimeMs }
          : undefined;
      }),
  );
  return directories.filter((entry): entry is DirectoryEntry => entry !== undefined);
}

async function removeDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

async function pruneBuildHistory(
  root: string,
  active: Set<string>,
  now: number,
  policy: HousekeepingPolicy,
): Promise<number> {
  const builds = (await childDirectories(root))
    .filter((build) => !active.has(build.name))
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  const stale = builds
    .slice(policy.buildHistoryLimit)
    .filter((build) => build.modifiedAt < now - policy.buildRetentionMs);
  await Promise.all(stale.map((build) => removeDirectory(build.path)));
  return stale.length;
}

function cacheRoots(dataPath: string): string[] {
  return [join(dataPath, "caches"), join(dataPath, "caches", "linux")];
}

async function pruneOrphanedCacheRepositories(
  dataPath: string,
  repositories: Repository[],
): Promise<number> {
  const active = new Set(
    repositories.map((repository) => digest(repository.fullName).slice(0, 16)),
  );
  let removed = 0;
  for (const root of cacheRoots(dataPath)) {
    const entries = await childDirectories(root);
    const stale = entries.filter(
      (entry) => entry.name !== "shared" && entry.name !== "linux" && !active.has(entry.name),
    );
    await Promise.all(stale.map((entry) => removeDirectory(entry.path)));
    removed += stale.length;
  }
  const configurations = join(dataPath, "cache-configurations");
  const entries = await readdir(configurations, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && !active.has(entry.name))
      .map((entry) => rm(join(configurations, entry.name), { force: true })),
  );
  return removed;
}

function cacheConfigurationPath(dataPath: string, repository: string): string {
  return join(dataPath, "cache-configurations", digest(repository).slice(0, 16));
}

export async function updateCacheConfiguration(
  repository: string,
  cacheJobs: string[],
  dataPath = dataDirectory(),
): Promise<number> {
  const path = cacheConfigurationPath(dataPath, repository);
  const previousSource = await readFile(path, "utf8").catch(() => undefined);
  const current = new Set(cacheJobs.map((job) => digest(job).slice(0, 16)));
  const source = `${[...current].sort().join("\n")}\n`;
  const changed = previousSource !== source;
  if (!changed) return 0;
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await mkdir(join(dataPath, "cache-configurations"), { recursive: true });
  try {
    await Bun.write(temporary, source);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return 1;
}

async function pruneOrphanedCacheJobs(
  dataPath: string,
  repositories: Repository[],
): Promise<number> {
  let removed = 0;
  for (const repository of repositories) {
    const source = await readFile(
      cacheConfigurationPath(dataPath, repository.fullName),
      "utf8",
    ).catch(() => undefined);
    if (source === undefined) continue;
    const active = new Set(source.split("\n").filter(Boolean));
    const repositoryId = digest(repository.fullName).slice(0, 16);
    for (const root of cacheRoots(dataPath)) {
      const jobs = await childDirectories(join(root, repositoryId));
      const stale = jobs.filter((job) => !active.has(job.name));
      await Promise.all(stale.map((job) => removeDirectory(job.path)));
      removed += stale.length;
    }
  }
  return removed;
}

async function keyedCacheVersions(dataPath: string): Promise<DirectoryEntry[]> {
  const versions: DirectoryEntry[] = [];
  for (const root of cacheRoots(dataPath)) {
    for (const repository of await childDirectories(root)) {
      if (repository.name === "shared" || repository.name === "linux") continue;
      for (const job of await childDirectories(repository.path)) {
        for (const cache of await childDirectories(job.path)) {
          versions.push(...(await childDirectories(cache.path)));
        }
      }
    }
  }
  return versions;
}

async function pruneStaleCacheVersions(
  dataPath: string,
  now: number,
  policy: HousekeepingPolicy,
): Promise<number> {
  let removed = 0;
  for (const root of cacheRoots(dataPath)) {
    for (const repository of await childDirectories(root)) {
      if (repository.name === "shared" || repository.name === "linux") continue;
      for (const job of await childDirectories(repository.path)) {
        for (const cache of await childDirectories(job.path)) {
          const versions = (await childDirectories(cache.path)).sort(
            (left, right) => right.modifiedAt - left.modifiedAt,
          );
          const stale = versions
            .slice(2)
            .filter((version) => version.modifiedAt < now - policy.cacheVersionRetentionMs);
          await Promise.all(stale.map((version) => removeDirectory(version.path)));
          removed += stale.length;
        }
      }
    }
  }
  return removed;
}

async function pruneCacheQuota(
  dataPath: string,
  maximumBytes: number,
  measure: (path: string) => Promise<number>,
): Promise<{ removed: number; freedBytes: number }> {
  const entries: Array<DirectoryEntry & { bytes: number }> = [];
  for (const entry of await keyedCacheVersions(dataPath)) {
    entries.push({ ...entry, bytes: await measure(entry.path) });
  }
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  let removed = 0;
  let freedBytes = 0;
  for (const entry of entries.sort((left, right) => left.modifiedAt - right.modifiedAt)) {
    if (total <= maximumBytes) break;
    await removeDirectory(entry.path);
    total -= entry.bytes;
    freedBytes += entry.bytes;
    removed++;
  }
  return { removed, freedBytes };
}

async function pruneDirectoriesForSpace(
  entries: DirectoryEntry[],
  bytesNeeded: number,
  measure: (path: string) => Promise<number>,
): Promise<{ removed: number; freedBytes: number }> {
  let removed = 0;
  let freedBytes = 0;
  for (const entry of entries.sort((left, right) => left.modifiedAt - right.modifiedAt)) {
    if (freedBytes >= bytesNeeded) break;
    const bytes = await measure(entry.path);
    await removeDirectory(entry.path);
    freedBytes += bytes;
    removed++;
  }
  return { removed, freedBytes };
}

async function pressureCleanup(
  dataPath: string,
  active: Set<string>,
  bytesNeeded: number,
  policy: HousekeepingPolicy,
  measure: (path: string) => Promise<number>,
): Promise<{ builds: number; cacheVersions: number; sharedCaches: number }> {
  let remaining = bytesNeeded;
  const builds = (await childDirectories(join(dataPath, "builds")))
    .filter((build) => !active.has(build.name))
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .slice(policy.pressureBuildHistoryLimit);
  const buildResult = await pruneDirectoriesForSpace(builds, remaining, measure);
  remaining = Math.max(0, remaining - buildResult.freedBytes);

  const cacheResult = await pruneDirectoriesForSpace(
    await keyedCacheVersions(dataPath),
    remaining,
    measure,
  );
  remaining = Math.max(0, remaining - cacheResult.freedBytes);

  const shared = (
    await Promise.all(cacheRoots(dataPath).map((root) => childDirectories(join(root, "shared"))))
  ).flat();
  const sharedResult = await pruneDirectoriesForSpace(shared, remaining, measure);
  return {
    builds: buildResult.removed,
    cacheVersions: cacheResult.removed,
    sharedCaches: sharedResult.removed,
  };
}

export async function runHousekeeping(
  repositories: Repository[],
  operations: HousekeepingOperations = {},
  policy = housekeepingPolicy(),
): Promise<HousekeepingSummary> {
  const dataPath = operations.dataPath ?? dataDirectory();
  const measure = operations.directorySize ?? allocatedDirectorySize;
  const inspectDisk = operations.diskSpace ?? fileSystemSpace;
  const lock = operations.withLock ?? withImageLock;
  return lock("housekeeping", async () => {
    const active = new Set(
      await (
        operations.activeBuildIds ?? (async () => (await listActiveBuilds()).map(({ id }) => id))
      )(),
    );
    const empty: HousekeepingSummary = {
      skipped: active.size > 0,
      builds: 0,
      cacheRepositories: 0,
      cacheJobs: 0,
      cacheVersions: 0,
      sharedCaches: 0,
      tartImages: 0,
      containerImages: 0,
      pressure: false,
    };
    if (active.size > 0) return empty;

    const now = operations.now ?? Date.now();
    empty.builds += await pruneBuildHistory(join(dataPath, "builds"), active, now, policy);
    empty.cacheRepositories += await pruneOrphanedCacheRepositories(dataPath, repositories);
    empty.cacheJobs += await pruneOrphanedCacheJobs(dataPath, repositories);
    empty.cacheVersions += await pruneStaleCacheVersions(dataPath, now, policy);
    const quota = await pruneCacheQuota(dataPath, policy.keyedCacheMaxBytes, measure);
    empty.cacheVersions += quota.removed;

    const repositoryNames = repositories.map((repository) => repository.fullName);
    await (operations.reconcileTartRepositories ?? reconcilePreparedImageRepositories)(
      repositoryNames,
    );
    await (
      operations.reconcileContainerRepositories ?? reconcilePreparedContainerImageRepositories
    )(repositoryNames);
    empty.tartImages = await (operations.pruneTartImages ?? prunePreparedImages)().catch(() => 0);
    empty.containerImages = await (
      operations.pruneContainerImages ?? (() => pruneKnownPreparedContainerImages())
    )().catch(() => 0);

    const space = await inspectDisk(dataPath);
    const bytesNeeded = Math.max(0, minimumFreeSpace(space) - space.availableBytes);
    if (bytesNeeded > 0) {
      empty.pressure = true;
      const pressure = await pressureCleanup(dataPath, active, bytesNeeded, policy, measure);
      empty.builds += pressure.builds;
      empty.cacheVersions += pressure.cacheVersions;
      empty.sharedCaches += pressure.sharedCaches;
    }
    return empty;
  });
}

export function formatHousekeepingSummary(summary: HousekeepingSummary): string | undefined {
  if (summary.skipped) return undefined;
  const parts: string[] = [];
  if (summary.builds > 0) parts.push(`${summary.builds} old builds`);
  if (summary.cacheRepositories > 0)
    parts.push(`${summary.cacheRepositories} orphaned cache repositories`);
  if (summary.cacheJobs > 0) parts.push(`${summary.cacheJobs} removed-job caches`);
  if (summary.cacheVersions > 0) parts.push(`${summary.cacheVersions} cache versions`);
  if (summary.sharedCaches > 0) parts.push(`${summary.sharedCaches} shared caches`);
  const images = summary.tartImages + summary.containerImages;
  if (images > 0) parts.push(`${images} prepared images`);
  if (parts.length === 0) return undefined;
  return `Cleaned up ${parts.join(", ")}${summary.pressure ? " to recover low disk space" : ""}`;
}
