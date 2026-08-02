import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { housekeepingPolicy, runHousekeeping, updateCacheConfiguration } from "./housekeeping.ts";
import { digest } from "./tart/vm.ts";
import type { Repository } from "./types.ts";

const roots: string[] = [];
const repository: Repository = { owner: "owner", repo: "repo", fullName: "owner/repo" };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function directory(root: string, path: string, modifiedAt: number): Promise<string> {
  const location = join(root, path);
  await mkdir(location, { recursive: true });
  await Bun.write(join(location, "data"), path);
  const time = new Date(modifiedAt);
  await utimes(location, time, time);
  return location;
}

function operations(root: string, diskSpace = { availableBytes: 50e9, totalBytes: 100e9 }) {
  return {
    dataPath: root,
    activeBuildIds: async () => [],
    diskSpace: async () => diskSpace,
    directorySize: async () => 0,
    withLock: async <T>(_name: string, callback: () => Promise<T>) => callback(),
    reconcileTartRepositories: async () => 0,
    reconcileContainerRepositories: async () => 0,
    pruneTartImages: async () => 0,
    pruneContainerImages: async () => 0,
  };
}

describe("automatic housekeeping", () => {
  test("bounds old build history and globally removes stale and orphaned keyed caches", async () => {
    const root = await mkdtemp(join(tmpdir(), "informant-housekeeping-"));
    roots.push(root);
    const now = Date.now();
    for (let index = 0; index < 4; index++) {
      await directory(root, `builds/build-${index}`, now - (index + 1) * 2 * 24 * 60 * 60 * 1_000);
    }
    const repositoryId = digest(repository.fullName).slice(0, 16);
    const activeJob = digest("active").slice(0, 16);
    const cache = `caches/${repositoryId}/${activeJob}/cache`;
    for (let index = 0; index < 4; index++) {
      await directory(
        root,
        `${cache}/version-${index}`,
        now - (index + 1) * 10 * 24 * 60 * 60 * 1_000,
      );
    }
    await directory(
      root,
      `caches/${repositoryId}/${digest("removed").slice(0, 16)}/cache/version`,
      now,
    );
    await updateCacheConfiguration(repository.fullName, ["active"], root);
    await directory(root, "caches/orphaned-repository/job/cache/version", now);
    const shared = await directory(root, "caches/shared/dependencies", now);
    const measuredBatches: string[][] = [];

    const summary = await runHousekeeping(
      [repository],
      {
        ...operations(root),
        now,
        directorySizes: async (paths) => {
          measuredBatches.push(paths);
          return new Map(paths.map((path) => [path, 0]));
        },
      },
      {
        ...housekeepingPolicy({}),
        buildRetentionMs: 24 * 60 * 60 * 1_000,
        buildHistoryLimit: 2,
        keyedCacheMaxBytes: Number.POSITIVE_INFINITY,
      },
    );

    expect(summary).toMatchObject({
      builds: 2,
      cacheRepositories: 1,
      cacheJobs: 1,
      cacheVersions: 2,
      sharedCaches: 0,
      pressure: false,
    });
    expect(await Bun.file(join(root, "builds", "build-0", "data")).exists()).toBe(true);
    expect(await Bun.file(join(root, "builds", "build-3", "data")).exists()).toBe(false);
    expect(measuredBatches).toHaveLength(1);
    expect(new Set(measuredBatches[0])).toEqual(
      new Set([join(root, `${cache}/version-0`), join(root, `${cache}/version-1`)]),
    );
    expect(
      await Bun.file(
        join(root, "caches", "orphaned-repository", "job", "cache", "version", "data"),
      ).exists(),
    ).toBe(false);
    expect(await Bun.file(join(shared, "data")).exists()).toBe(true);
  });

  test("removes old builds, keyed caches, then shared caches when disk space is low", async () => {
    const root = await mkdtemp(join(tmpdir(), "informant-housekeeping-pressure-"));
    roots.push(root);
    const now = Date.now();
    for (let index = 0; index < 3; index++)
      await directory(root, `builds/build-${index}`, now - index * 1_000);
    const repositoryId = digest(repository.fullName).slice(0, 16);
    await directory(root, `caches/${repositoryId}/job/cache/version`, now - 2_000);
    const shared = await directory(root, "caches/shared/dependencies", now - 3_000);
    const measured = new Map<string, number>();
    for (let index = 0; index < 3; index++) measured.set(join(root, `builds/build-${index}`), 5e9);
    measured.set(join(root, `caches/${repositoryId}/job/cache/version`), 5e9);
    measured.set(shared, 20e9);

    const summary = await runHousekeeping(
      [repository],
      {
        ...operations(root, { availableBytes: 1e9, totalBytes: 100e9 }),
        now,
        directorySize: async (path) => measured.get(path) ?? 0,
      },
      {
        ...housekeepingPolicy({}),
        buildHistoryLimit: 100,
        pressureBuildHistoryLimit: 1,
        keyedCacheMaxBytes: Number.POSITIVE_INFINITY,
      },
    );

    expect(summary).toMatchObject({
      builds: 2,
      cacheVersions: 1,
      sharedCaches: 1,
      pressure: true,
    });
    expect(await Bun.file(join(root, "builds", "build-0", "data")).exists()).toBe(true);
    expect(await Bun.file(join(shared, "data")).exists()).toBe(false);
  });

  test("does nothing while any build is active", async () => {
    const root = await mkdtemp(join(tmpdir(), "informant-housekeeping-active-"));
    roots.push(root);
    const build = await directory(root, "builds/old", 0);
    const summary = await runHousekeeping(
      [],
      { ...operations(root), activeBuildIds: async () => ["active"] },
      housekeepingPolicy({}),
    );

    expect(summary.skipped).toBe(true);
    expect(await Bun.file(join(build, "data")).exists()).toBe(true);
  });
});
