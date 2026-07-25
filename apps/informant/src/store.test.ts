import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { claimBuildWorkspace, removeOrphanedBuildWorkspaces } from "./store.ts";

const originalDataDirectory = Bun.env.INFORMANT_DATA_DIR;
const roots: string[] = [];

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
