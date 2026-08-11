import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, stat, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  claimBuildWorkspace,
  createBuild,
  currentProcessOwner,
  getBuild,
  jobLogPath,
  listActiveBuilds,
  monitorBuildCancellation,
  removeOrphanedBuildWorkspaces,
  requestBuildCancellation,
  saveBuild,
} from "./store.ts";
import type { BuildRecord } from "./types.ts";

const originalDataDirectory = Bun.env.INFORMANT_DATA_DIR;
const roots: string[] = [];

test("job log paths are fixed-length and case-sensitive on every filesystem", () => {
  const record = { logPath: "/tmp/build/build.log" } as BuildRecord;
  const lower = jobLogPath(record, "test");
  const upper = jobLogPath(record, "Test");
  const long = jobLogPath(record, "a".repeat(1_000));
  expect(lower).not.toBe(upper);
  expect(lower).toStartWith("/tmp/build/jobs/");
  expect(long.split("/").at(-1)).toHaveLength(68);
});

test("build saves preserve invocation order and complete JSON", async () => {
  const root = join(import.meta.dir, `.store-test-${crypto.randomUUID()}`);
  roots.push(root);
  Bun.env.INFORMANT_DATA_DIR = root;
  const record: BuildRecord = {
    id: "ordered",
    repo: "owner/repo",
    sha: "sha",
    branch: "main",
    machine: "machine",
    startedAt: new Date().toISOString(),
    status: "running",
    runningJobs: ["first"],
    logPath: join(root, "builds", "ordered", "build.log"),
  };
  await createBuild(record);

  const first = saveBuild(record);
  record.runningJobs = ["second"];
  const second = saveBuild(record);
  await Promise.all([first, second]);

  expect((await getBuild(record.id))?.runningJobs).toEqual(["second"]);
});

test("active builds are indexed and dead owners are reconciled", async () => {
  const root = join(import.meta.dir, `.store-test-${crypto.randomUUID()}`);
  roots.push(root);
  Bun.env.INFORMANT_DATA_DIR = root;
  const owner = currentProcessOwner();
  if (!owner) throw new Error("expected the current process to have an identity");
  const live: BuildRecord = {
    id: "live",
    repo: "owner/repo",
    sha: "live-sha",
    branch: "main",
    machine: "machine",
    startedAt: new Date().toISOString(),
    status: "running",
    runningJobs: ["test"],
    owner,
    logPath: join(root, "builds", "live", "build.log"),
  };
  const dead: BuildRecord = {
    ...live,
    id: "dead",
    sha: "dead-sha",
    owner: { pid: 2_147_483_647, startedAt: "dead" },
    logPath: join(root, "builds", "dead", "build.log"),
  };
  await Promise.all([createBuild(live), createBuild(dead)]);

  expect((await listActiveBuilds()).map((build) => build.id)).toEqual(["live"]);
  expect((await getBuild(dead.id))?.status).toBe("cancelled");
  live.status = "success";
  live.completedAt = new Date().toISOString();
  await saveBuild(live);
  expect(await listActiveBuilds()).toEqual([]);
});

test("fresh marker-only builds survive the writer window and abandoned markers expire", async () => {
  const root = join(import.meta.dir, `.store-test-${crypto.randomUUID()}`);
  roots.push(root);
  Bun.env.INFORMANT_DATA_DIR = root;
  const activeRoot = join(root, "active-builds");
  const marker = join(activeRoot, "writer-race");
  await mkdir(activeRoot, { recursive: true });
  await Bun.write(marker, "");

  expect(await listActiveBuilds()).toEqual([]);
  expect(await Bun.file(marker).exists()).toBe(true);

  const owner = currentProcessOwner();
  if (!owner) throw new Error("expected the current process to have an identity");
  const record: BuildRecord = {
    id: "writer-race",
    repo: "owner/repo",
    sha: "sha",
    branch: "main",
    machine: "machine",
    startedAt: new Date().toISOString(),
    status: "running",
    runningJobs: [],
    owner,
    logPath: join(root, "builds", "writer-race", "build.log"),
  };
  await mkdir(join(root, "builds", record.id), { recursive: true });
  await Bun.write(join(root, "builds", record.id, "build.json"), JSON.stringify(record));
  expect((await listActiveBuilds()).map((build) => build.id)).toEqual([record.id]);

  const abandoned = join(activeRoot, "abandoned");
  await Bun.write(abandoned, "");
  await utimes(abandoned, new Date(0), new Date(0));
  await listActiveBuilds();
  expect(await Bun.file(abandoned).exists()).toBe(false);
});

test("cancellation requests target a running build or one active job", async () => {
  const root = join(import.meta.dir, `.store-test-${crypto.randomUUID()}`);
  roots.push(root);
  Bun.env.INFORMANT_DATA_DIR = root;
  const record: BuildRecord = {
    id: "cancellable",
    repo: "owner/repo",
    sha: "sha",
    branch: "main",
    machine: "machine",
    startedAt: new Date().toISOString(),
    status: "running",
    runningJobs: ["test"],
    jobs: [
      { name: "test", status: "running" },
      { name: "deploy", status: "queued" },
      { name: "lint", status: "success" },
    ],
    owner: currentProcessOwner(),
    logPath: join(root, "builds", "cancellable", "build.log"),
  };
  await createBuild(record);
  const monitor = monitorBuildCancellation(record.id, ["test", "deploy", "lint"], 5);
  try {
    await requestBuildCancellation(record.id, "test");
    for (let attempt = 0; attempt < 50 && !monitor.jobSignal("test")?.aborted; attempt++) {
      await Bun.sleep(5);
    }
    expect(monitor.jobSignal("test")?.aborted).toBe(true);
    expect(monitor.signal.aborted).toBe(false);
    await requestBuildCancellation(record.id, "test");
    await expect(requestBuildCancellation(record.id, "lint")).rejects.toThrow(
      "job is not running or queued: lint",
    );

    await requestBuildCancellation(record.id);
    for (let attempt = 0; attempt < 50 && !monitor.signal.aborted; attempt++) await Bun.sleep(5);
    expect(monitor.signal.aborted).toBe(true);
    expect(String(monitor.signal.reason)).toContain("informant builds");
    await requestBuildCancellation(record.id);
  } finally {
    await monitor.close();
  }

  record.status = "cancelled";
  record.completedAt = new Date().toISOString();
  await saveBuild(record);
  await expect(requestBuildCancellation(record.id)).rejects.toThrow("build is not running");
});

test("cancellation reconciles a build whose owning worker exited", async () => {
  const root = join(import.meta.dir, `.store-test-${crypto.randomUUID()}`);
  roots.push(root);
  Bun.env.INFORMANT_DATA_DIR = root;
  const record: BuildRecord = {
    id: "dead-cancellation",
    repo: "owner/repo",
    sha: "sha",
    branch: "main",
    machine: "machine",
    startedAt: new Date().toISOString(),
    status: "running",
    runningJobs: ["test"],
    owner: { pid: 2_147_483_647, startedAt: "dead" },
    logPath: join(root, "builds", "dead-cancellation", "build.log"),
  };
  await createBuild(record);

  await expect(requestBuildCancellation(record.id)).rejects.toThrow("build is not running");
  expect((await getBuild(record.id))?.status).toBe("cancelled");
  expect(await listActiveBuilds()).toEqual([]);
});

test("cancellation reports completion that races marker creation", async () => {
  const root = join(import.meta.dir, `.store-test-${crypto.randomUUID()}`);
  roots.push(root);
  Bun.env.INFORMANT_DATA_DIR = root;
  const owner = currentProcessOwner();
  if (!owner) throw new Error("expected the current process to have an identity");
  const record: BuildRecord = {
    id: "completion-race",
    repo: "owner/repo",
    sha: "sha",
    branch: "main",
    machine: "machine",
    startedAt: new Date().toISOString(),
    status: "running",
    runningJobs: ["test"],
    jobs: [{ name: "test", status: "running" }],
    owner,
    logPath: join(root, "builds", "completion-race", "build.log"),
  };
  await createBuild(record);

  await expect(
    requestBuildCancellation(record.id, undefined, {
      requestId: "raced-request",
      write: async (path, contents) => {
        record.status = "success";
        record.runningJobs = [];
        record.jobs = [{ name: "test", status: "success" }];
        record.completedAt = new Date().toISOString();
        await saveBuild(record);
        await mkdir(dirname(path), { recursive: true });
        await Bun.write(path, contents);
      },
    }),
  ).rejects.toThrow("build is not running: completion-race");

  const monitor = monitorBuildCancellation(record.id, ["test"], 5);
  try {
    await Bun.sleep(20);
    expect(monitor.signal.aborted).toBeFalse();
    expect(monitor.jobSignal("test")?.aborted).toBeFalse();
  } finally {
    await monitor.close();
  }
});

afterEach(async () => {
  if (originalDataDirectory === undefined) delete Bun.env.INFORMANT_DATA_DIR;
  else Bun.env.INFORMANT_DATA_DIR = originalDataDirectory;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("build workspace cleanup", () => {
  test("does not remove an old workspace owned by a live worker", async () => {
    const root = join(import.meta.dir, `.store-test-${crypto.randomUUID()}`);
    roots.push(root);
    Bun.env.INFORMANT_DATA_DIR = root;
    const workspace = join(root, "builds", "active", "workspace");
    await claimBuildWorkspace(workspace);
    await utimes(workspace, new Date(0), new Date(0));

    expect(await removeOrphanedBuildWorkspaces(Date.now())).toBe(0);
    expect((await stat(workspace)).isDirectory()).toBe(true);
  });

  test("removes old workspaces without a live owner", async () => {
    const root = join(import.meta.dir, `.store-test-${crypto.randomUUID()}`);
    roots.push(root);
    Bun.env.INFORMANT_DATA_DIR = root;
    const workspace = join(root, "builds", "orphaned", "workspace");
    await mkdir(workspace, { recursive: true });
    await Bun.write(join(workspace, ".owner.json"), JSON.stringify({ pid: 2_147_483_647 }));
    await utimes(workspace, new Date(0), new Date(0));

    expect(await removeOrphanedBuildWorkspaces(Date.now())).toBe(1);
    expect(await Bun.file(workspace).exists()).toBe(false);
  });

  test("immediately removes a claimed workspace whose worker died", async () => {
    const root = join(import.meta.dir, `.store-test-${crypto.randomUUID()}`);
    roots.push(root);
    Bun.env.INFORMANT_DATA_DIR = root;
    const workspace = join(root, "builds", "recent-orphan", "workspace");
    await mkdir(workspace, { recursive: true });
    await Bun.write(
      join(workspace, ".owner.json"),
      JSON.stringify({ pid: 2_147_483_647, startedAt: "dead worker" }),
    );

    expect(await removeOrphanedBuildWorkspaces(0)).toBe(1);
    expect(await Bun.file(workspace).exists()).toBe(false);
  });

  test("preserves a recent workspace that has not been claimed yet", async () => {
    const root = join(import.meta.dir, `.store-test-${crypto.randomUUID()}`);
    roots.push(root);
    Bun.env.INFORMANT_DATA_DIR = root;
    const workspace = join(root, "builds", "being-created", "workspace");
    await mkdir(workspace, { recursive: true });

    expect(await removeOrphanedBuildWorkspaces(0)).toBe(0);
    expect((await stat(workspace)).isDirectory()).toBe(true);
  });

  test("removes an old workspace when its owner PID has been reused", async () => {
    const root = join(import.meta.dir, `.store-test-${crypto.randomUUID()}`);
    roots.push(root);
    Bun.env.INFORMANT_DATA_DIR = root;
    const workspace = join(root, "builds", "reused-pid", "workspace");
    await mkdir(workspace, { recursive: true });
    await Bun.write(
      join(workspace, ".owner.json"),
      JSON.stringify({ pid: process.pid, startedAt: "not-this-process" }),
    );
    await utimes(workspace, new Date(0), new Date(0));

    expect(await removeOrphanedBuildWorkspaces(Date.now())).toBe(1);
    expect(await Bun.file(workspace).exists()).toBe(false);
  });
});
