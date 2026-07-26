import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli.ts";
import type { BuildRecord } from "./types.ts";

test("--version prints the package version without help", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await main(["--version"]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("0.1.0");
  } finally {
    log.mockRestore();
  }
});

test("cache prune preserves shared caches and cache clear removes the cache root", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-cli-cache-"));
  const cacheRoot = join(root, "caches");
  const originalDataDirectory = Bun.env.INFORMANT_DATA_DIR;
  Bun.env.INFORMANT_DATA_DIR = root;
  try {
    await mkdir(join(cacheRoot, "shared", "shared-entry"), { recursive: true });
    await mkdir(join(cacheRoot, "repository", "keyed-entry"), { recursive: true });
    await mkdir(join(cacheRoot, "linux", "shared", "shared-entry"), { recursive: true });
    await mkdir(join(cacheRoot, "linux", "repository", "keyed-entry"), { recursive: true });

    await main(["cache", "prune"]);
    expect((await readdir(cacheRoot)).sort()).toEqual(["linux", "shared"]);
    expect(await readdir(join(cacheRoot, "linux"))).toEqual(["shared"]);

    await main(["cache", "clear"]);
    expect(await Bun.file(cacheRoot).exists()).toBe(false);
  } finally {
    if (originalDataDirectory === undefined) delete Bun.env.INFORMANT_DATA_DIR;
    else Bun.env.INFORMANT_DATA_DIR = originalDataDirectory;
    await rm(root, { recursive: true, force: true });
  }
});

test("builds shows running jobs by default and recent history with --all", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-cli-builds-"));
  const originalDataDirectory = Bun.env.INFORMANT_DATA_DIR;
  Bun.env.INFORMANT_DATA_DIR = root;
  const records: BuildRecord[] = [
    {
      id: "running-build",
      repo: "owner/repo",
      sha: "1111111111111111111111111111111111111111",
      branch: "pull/42",
      machine: "runner-one",
      startedAt: "2026-07-26T12:00:00.000Z",
      status: "running",
      runningJobs: ["test", "lint"],
      logPath: join(root, "builds", "running-build", "build.log"),
    },
    {
      id: "finished-build",
      repo: "owner/repo",
      sha: "2222222222222222222222222222222222222222",
      branch: "main",
      machine: "runner-one",
      startedAt: "2026-07-26T11:00:00.000Z",
      completedAt: "2026-07-26T11:05:00.000Z",
      status: "success",
      logPath: join(root, "builds", "finished-build", "build.log"),
    },
  ];
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    for (const record of records) {
      const directory = join(root, "builds", record.id);
      await mkdir(directory, { recursive: true });
      await Bun.write(join(directory, "build.json"), JSON.stringify(record));
    }

    await main(["builds"]);
    const activeOutput = String(log.mock.calls.at(-1)?.[0]);
    expect(activeOutput).toContain("running-build");
    expect(activeOutput).toContain("test, lint");
    expect(activeOutput).toContain("https://github.com/owner/repo/pull/42");
    expect(activeOutput).not.toContain("finished-build");

    await main(["builds", "--all"]);
    const historyOutput = String(log.mock.calls.at(-1)?.[0]);
    expect(historyOutput).toContain("running-build");
    expect(historyOutput).toContain("finished-build");
    expect(historyOutput).toContain(
      "https://github.com/owner/repo/commit/2222222222222222222222222222222222222222",
    );
  } finally {
    log.mockRestore();
    if (originalDataDirectory === undefined) delete Bun.env.INFORMANT_DATA_DIR;
    else Bun.env.INFORMANT_DATA_DIR = originalDataDirectory;
    await rm(root, { recursive: true, force: true });
  }
});
