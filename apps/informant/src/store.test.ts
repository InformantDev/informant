import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import {
  claimBuildWorkspace,
  createBuild,
  getBuild,
  jobLogPath,
  removeOrphanedBuildWorkspaces,
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
