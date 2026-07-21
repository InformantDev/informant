import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CoordinatorDependencies, readLogTail, runCommit } from "./coordinator.ts";
import type { GitHubClient } from "./github.ts";
import type { BuildRecord, InformantConfig, Repository } from "./types.ts";

const repository: Repository = { owner: "owner", repo: "repo", fullName: "owner/repo" };
const config: InformantConfig = {
  version: 1,
  pollIntervalSeconds: 10,
  branches: ["main"],
  vm: { image: "image", user: "user", password: "password" },
  jobs: [{ name: "test", command: "test", timeoutMinutes: 1, environment: {}, needs: [] }],
};

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

test("readLogTail reads a bounded Unicode-safe tail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "informant-coordinator-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "build.log");
  await Bun.write(path, `${"x".repeat(220_001)}${"😀".repeat(55_000)}`);

  const tail = await readLogTail(path);

  expect(Array.from(tail)).toHaveLength(55_000);
  expect(tail).not.toContain("�");
  expect(tail).toBe("😀".repeat(55_000));
});

function harness(options: { claim?: boolean; success?: boolean; error?: Error } = {}) {
  const updates: Array<Record<string, unknown>> = [];
  const saved: BuildRecord[] = [];
  const github = {
    claim: async () =>
      options.claim === false
        ? undefined
        : { check: { id: 42, html_url: "https://example.test/check" }, requestedJobs: [] },
    updateCheck: async (_repository: Repository, _id: number, values: Record<string, unknown>) => {
      updates.push(values);
      return {};
    },
  } as unknown as GitHubClient;
  const dependencies: CoordinatorDependencies = {
    createBuild: async () => {},
    saveBuild: async (record) => {
      saved.push({ ...record });
    },
    runInTart: async () => {
      if (options.error) throw options.error;
      return options.success ?? true;
    },
    readLogTail: async () => "build output",
  };
  return { github, dependencies, updates, saved };
}

describe("runCommit", () => {
  test("returns without persistence when no claim is available", async () => {
    const context = harness({ claim: false });
    expect(
      await runCommit(context.github, repository, "sha", "main", config, context.dependencies),
    ).toBeUndefined();
    expect(context.updates).toEqual([]);
    expect(context.saved).toEqual([]);
  });

  test.each([
    [true, "success", "success"],
    [false, "failure", "failure"],
  ] as const)("records and reports a %s execution", async (success, status, conclusion) => {
    const context = harness({ success });
    const record = await runCommit(
      context.github,
      repository,
      "sha",
      "main",
      config,
      context.dependencies,
    );
    expect(record?.status).toBe(status);
    expect(context.updates[0]).toMatchObject({ status: "completed", conclusion });
    expect(context.saved.at(-1)?.status).toBe(status);
  });

  test("reports, persists, and rethrows execution failures", async () => {
    const context = harness({ error: new Error("tart broke") });
    await expect(
      runCommit(context.github, repository, "sha", "main", config, context.dependencies),
    ).rejects.toThrow("tart broke");
    expect(context.updates[0]).toMatchObject({
      status: "completed",
      conclusion: "failure",
      summary: "tart broke",
    });
    expect(context.saved.at(-1)?.status).toBe("failure");
  });

  test("persists failure when the terminal check update throws", async () => {
    const context = harness();
    context.github.updateCheck = async () => {
      throw new Error("update failed");
    };
    await expect(
      runCommit(context.github, repository, "sha", "main", config, context.dependencies),
    ).rejects.toThrow("update failed");
    expect(context.saved.at(-1)?.status).toBe("failure");
  });
});
