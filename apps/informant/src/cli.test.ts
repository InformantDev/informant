import { expect, spyOn, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import {
  branchNameFromSymbolicRef,
  cleanOrphanedBuildWorkspacesInBackground,
  executionLabelFromRef,
  main,
  pruneRuntimeImages,
  runInvocationType,
  runManualHousekeeping,
  updateResultMessage,
} from "./cli.ts";
import { selectContainerBackend } from "./container-backend.ts";
import { createBuild, currentProcessOwner, monitorBuildCancellation, saveBuild } from "./store.ts";
import type { BuildRecord, Repository } from "./types.ts";

test("--version prints the package version without help", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await main(["--version"]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(packageJson.version);
  } finally {
    log.mockRestore();
  }
});

test("only local branch refs provide manual trigger branch context", () => {
  expect(branchNameFromSymbolicRef("refs/heads/release")).toBe("release");
  expect(branchNameFromSymbolicRef("refs/tags/v1")).toBeUndefined();
  expect(branchNameFromSymbolicRef("abc123")).toBeUndefined();
  expect(branchNameFromSymbolicRef("")).toBeUndefined();
});

test("execution labels follow the requested ref instead of the checked out branch", () => {
  expect(executionLabelFromRef("release", "refs/heads/release")).toBe("release");
  expect(executionLabelFromRef("v1", "refs/tags/v1")).toBe("v1");
  expect(executionLabelFromRef("abc123", "")).toBe("abc123");
  expect(executionLabelFromRef("HEAD", "refs/heads/main")).toBe("main");
});

test("run preserves reported triggers unless local execution is explicit", () => {
  expect(runInvocationType(false)).toBe("trigger");
  expect(runInvocationType(true)).toBe("local");
});

test("local and reported trigger flags cannot be mixed", async () => {
  await expect(main(["run", "--local", "--wait-for-github"])).rejects.toThrow(
    "--local cannot be combined with --wait-for-github",
  );
  await expect(main(["trigger", "--local"])).rejects.toThrow("trigger does not accept --local");
});

test("reports recovery of a pending worker restart", () => {
  expect(updateResultMessage({ updated: false, restarted: true, version: "0.2.0" })).toBe(
    "Informant 0.2.0 is already current; restarted the worker after a pending update",
  );
});

test("automatic-update commands reject trailing positional arguments", async () => {
  await expect(main(["auto-update", "enable", "disable"])).rejects.toThrow(
    "auto-update enable does not accept arguments",
  );
  await expect(main(["auto-update", "disable", "enable"])).rejects.toThrow(
    "auto-update disable does not accept arguments",
  );
});

test("orphan cleanup does not block worker startup", async () => {
  let finishCleanup: ((removed: number) => void) | undefined;
  const cleanup = new Promise<number>((resolve) => {
    finishCleanup = resolve;
  });
  const messages: string[] = [];

  cleanOrphanedBuildWorkspacesInBackground(
    () => cleanup,
    (message) => messages.push(message),
  );
  expect(messages).toEqual([]);

  finishCleanup?.(2);
  await cleanup;
  await Bun.sleep(0);
  expect(messages).toEqual(["Cleaned 2 orphaned build workspaces"]);
});

test("manual housekeeping skips cleanup when repository enumeration fails", async () => {
  const repository: Repository = { owner: "owner", repo: "repo", fullName: "owner/repo" };
  let cleanups = 0;

  await runManualHousekeeping(repository, {
    listRepositories: async () => {
      throw new Error("configuration temporarily unavailable");
    },
    housekeeping: async () => {
      cleanups++;
      throw new Error("must not run");
    },
  });

  expect(cleanups).toBe(0);
});

test("image prune reports partial runtime failures and preserves the successful count", async () => {
  await expect(
    pruneRuntimeImages({
      tart: async () => 2,
      container: async () => {
        throw new Error("runtime unavailable");
      },
    }),
  ).rejects.toThrow(
    `Deleted 2 unused prepared images, but failed to prune ${selectContainerBackend()?.name ?? "Container"} images: runtime unavailable`,
  );
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
  const owner = currentProcessOwner();
  if (!owner) throw new Error("expected the current process to have an identity");
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
      owner,
      pullRequest: 42,
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
    {
      id: "branch-shaped-like-pr",
      repo: "owner/repo",
      sha: "3333333333333333333333333333333333333333",
      branch: "pull/99",
      machine: "runner-one",
      startedAt: "2026-07-26T10:00:00.000Z",
      completedAt: "2026-07-26T10:05:00.000Z",
      status: "success",
      logPath: join(root, "builds", "branch-shaped-like-pr", "build.log"),
    },
  ];
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    for (const record of records) {
      await createBuild(record);
      await Bun.write(record.logPath, `${record.id} output\n`);
    }

    await main(["builds"]);
    const activeOutput = String(log.mock.calls.at(-1)?.[0]);
    expect(activeOutput).toContain("running-build");
    expect(activeOutput).toContain("├─ test · running");
    expect(activeOutput).toContain("└─ lint · running");
    expect(activeOutput).toContain("https://github.com/owner/repo/pull/42");
    expect(activeOutput).toContain(
      `started ${new Date("2026-07-26T12:00:00.000Z").toLocaleString()}`,
    );
    expect(activeOutput).toContain(" elapsed");
    expect(activeOutput).not.toContain("finished-build");

    const cancellation = monitorBuildCancellation("running-build", ["test", "lint"], 5);
    try {
      await main(["builds", "cancel", "running-build", "--job", "test"]);
      for (let attempt = 0; attempt < 50 && !cancellation.jobSignal("test")?.aborted; attempt++) {
        await Bun.sleep(5);
      }
      expect(cancellation.jobSignal("test")?.aborted).toBe(true);
      expect(cancellation.signal.aborted).toBe(false);
    } finally {
      await cancellation.close();
    }

    await main(["builds", "--all"]);
    const historyOutput = String(log.mock.calls.at(-1)?.[0]);
    expect(historyOutput).toContain("running-build");
    expect(historyOutput).toContain("finished-build");
    expect(historyOutput).toContain(
      "https://github.com/owner/repo/commit/2222222222222222222222222222222222222222",
    );
    expect(historyOutput).toContain(
      "https://github.com/owner/repo/commit/3333333333333333333333333333333333333333",
    );
    expect(historyOutput).toContain(
      `started ${new Date("2026-07-26T11:00:00.000Z").toLocaleString()} · 5m 0s elapsed`,
    );
    expect(historyOutput).not.toContain("https://github.com/owner/repo/pull/99");

    let output = "";
    const write = spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      const followed = main(["logs", "running-build"]);
      await Bun.sleep(20);
      const running = records[0];
      if (!running) throw new Error("expected a running build");
      await appendFile(running.logPath, "more output\n");
      running.status = "success";
      await saveBuild(running);
      await followed;
      expect(output).toBe("running-build output\nmore output\n");

      output = "";
      await main(["logs", "finished-build"]);
      expect(output).toBe("finished-build output\n");
    } finally {
      write.mockRestore();
    }
  } finally {
    log.mockRestore();
    if (originalDataDirectory === undefined) delete Bun.env.INFORMANT_DATA_DIR;
    else Bun.env.INFORMANT_DATA_DIR = originalDataDirectory;
    await rm(root, { recursive: true, force: true });
  }
});

test("logs stops following a running record when its worker is dead", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-cli-dead-logs-"));
  const originalDataDirectory = Bun.env.INFORMANT_DATA_DIR;
  Bun.env.INFORMANT_DATA_DIR = root;
  const record: BuildRecord = {
    id: "dead-build",
    repo: "owner/repo",
    sha: "sha",
    branch: "main",
    machine: "runner-one",
    startedAt: new Date().toISOString(),
    status: "running",
    runningJobs: ["test"],
    owner: { pid: 2_147_483_647, startedAt: "dead" },
    logPath: join(root, "builds", "dead-build", "build.log"),
  };
  let output = "";
  const write = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  try {
    await createBuild(record);
    await Bun.write(record.logPath, "last output\n");

    await main(["logs", record.id]);

    expect(output).toBe("last output\n");
    expect(await Bun.file(join(root, "builds", record.id, "build.json")).json()).toMatchObject({
      status: "cancelled",
      runningJobs: [],
    });
  } finally {
    write.mockRestore();
    if (originalDataDirectory === undefined) delete Bun.env.INFORMANT_DATA_DIR;
    else Bun.env.INFORMANT_DATA_DIR = originalDataDirectory;
    await rm(root, { recursive: true, force: true });
  }
});
