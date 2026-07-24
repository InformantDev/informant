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

function harness(
  options: { claim?: boolean; success?: boolean; error?: Error; manualRequest?: boolean } = {},
) {
  const updates: Array<{ id: number; values: Record<string, unknown> }> = [];
  const jobChecks: string[] = [];
  const remoteChecks: Array<{
    id: number;
    name: string;
    status: "queued" | "in_progress" | "completed";
    conclusion?: string;
  }> = [];
  const saved: BuildRecord[] = [];
  const aggregateCheck: {
    id: number;
    name: string;
    status: "in_progress" | "completed";
    conclusion?: string;
    html_url: string;
  } = {
    id: 42,
    name: "Informant CI",
    status: "in_progress",
    html_url: "https://example.test/check",
  };
  let nextCheckId = 100;
  const github = {
    claim: async () =>
      options.claim === false
        ? undefined
        : {
            check: aggregateCheck,
            requestedJobs: [],
            manualRequest: options.manualRequest ?? false,
          },
    createJobCheck: async (
      _repository: Repository,
      _sha: string,
      _claimId: number,
      name: string,
    ) => {
      jobChecks.push(name);
      const jobCheck = {
        id: nextCheckId++,
        name: `Informant / ${name}`,
        status: "queued" as const,
      };
      remoteChecks.push(jobCheck);
      return jobCheck;
    },
    jobChecks: async () => remoteChecks,
    checks: async () => [aggregateCheck],
    updateCheck: async (_repository: Repository, id: number, values: Record<string, unknown>) => {
      updates.push({ id, values });
      const jobCheck = remoteChecks.find((item) => item.id === id);
      if (jobCheck && values.status) {
        jobCheck.status = values.status as "queued" | "in_progress" | "completed";
        if (values.conclusion) jobCheck.conclusion = String(values.conclusion);
      }
      if (id === aggregateCheck.id && values.status === "completed") {
        aggregateCheck.status = "completed";
        aggregateCheck.conclusion = String(values.conclusion);
      }
      return {};
    },
  } as unknown as GitHubClient;
  const dependencies: CoordinatorDependencies = {
    createBuild: async () => {},
    saveBuild: async (record) => {
      saved.push({ ...record });
    },
    runInTart: async (_repository, _sha, selectedConfig, _record, observer) => {
      if (options.error) throw options.error;
      const success = options.success ?? true;
      for (const job of selectedConfig.jobs) {
        await observer?.started?.(job);
        await observer?.completed?.(job, {
          outcome: success ? "success" : "failure",
          log: `${job.name} output`,
        });
      }
      return success;
    },
    readLogTail: async () => "build output",
  };
  return { github, dependencies, updates, jobChecks, saved };
}

describe("runCommit", () => {
  test("returns without persistence when no claim is available", async () => {
    const context = harness({ claim: false });
    expect(
      await runCommit(context.github, repository, "sha", "main", config, context.dependencies),
    ).toBeUndefined();
    expect(context.updates).toEqual([]);
    expect(context.jobChecks).toEqual([]);
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
    if (!record) throw new Error("expected a build record");
    expect(record.status).toBe(status);
    expect(context.jobChecks).toEqual(["test"]);
    expect(context.updates.find((update) => update.id === 100)?.values).toMatchObject({
      status: "in_progress",
    });
    expect(
      context.updates.find((update) => update.id === 100 && update.values.status === "completed")
        ?.values,
    ).toMatchObject({ status: "completed", conclusion, text: "```text\ntest output\n```" });
    const aggregate = context.updates.find((update) => update.id === 42)?.values;
    expect(aggregate).toMatchObject({
      status: "completed",
      conclusion,
    });
    expect(aggregate?.text).toBeUndefined();
    expect(context.saved.at(-1)?.status).toBe(status);
  });

  test("reports, persists, and rethrows execution failures", async () => {
    const context = harness({ error: new Error("tart broke") });
    await expect(
      runCommit(context.github, repository, "sha", "main", config, context.dependencies),
    ).rejects.toThrow("tart broke");
    expect(context.updates.find((update) => update.id === 42)?.values).toMatchObject({
      status: "completed",
      conclusion: "failure",
      summary: "tart broke",
    });
    expect(context.saved.at(-1)?.status).toBe("failure");
  });

  test("persists failure when the terminal check update throws", async () => {
    const context = harness();
    const attemptedIds: number[] = [];
    context.github.updateCheck = async (_target, id) => {
      attemptedIds.push(id);
      throw new Error("update failed");
    };
    await expect(
      runCommit(context.github, repository, "sha", "main", config, context.dependencies),
    ).rejects.toThrow("update failed; additionally, GitHub reporting failed: update failed");
    expect(attemptedIds).not.toContain(42);
    expect(context.saved.at(-1)?.status).toBe("failure");
  });

  test("retries a failed terminal job update without changing the execution result", async () => {
    const context = harness();
    const updateCheck = context.github.updateCheck.bind(context.github);
    let terminalAttempts = 0;
    context.github.updateCheck = async (target, id, values) => {
      if (id === 100 && values.status === "completed" && terminalAttempts++ < 2) {
        throw new Error("temporary GitHub error");
      }
      return updateCheck(target, id, values);
    };

    const record = await runCommit(
      context.github,
      repository,
      "sha",
      "main",
      config,
      context.dependencies,
    );

    expect(terminalAttempts).toBe(3);
    if (!record) throw new Error("expected a build record");
    expect(record.status).toBe("success");
    expect(
      context.updates.find((update) => update.id === 100 && update.values.status === "completed")
        ?.values,
    ).toMatchObject({ conclusion: "success", text: "```text\ntest output\n```" });
  });

  test("preserves success when the aggregate completion response is lost", async () => {
    const context = harness();
    const updateCheck = context.github.updateCheck.bind(context.github);
    let loseResponse = true;
    context.github.updateCheck = async (target, id, values) => {
      const result = await updateCheck(target, id, values);
      if (id === 42 && values.status === "completed" && loseResponse) {
        loseResponse = false;
        throw new Error("response lost");
      }
      return result;
    };

    const record = await runCommit(
      context.github,
      repository,
      "sha",
      "main",
      config,
      context.dependencies,
    );

    if (!record) throw new Error("expected a build record");
    expect(record.status).toBe("success");
    expect(context.saved.at(-1)?.status).toBe("success");
    expect(context.updates.filter((update) => update.id === 42)).toHaveLength(1);
    expect(context.updates.find((update) => update.id === 42)?.values.conclusion).toBe("success");
  });

  test("an all-jobs manual request bypasses automatic trigger filters", async () => {
    const context = harness({ manualRequest: true });
    const manualOnly = {
      ...config,
      triggers: [{ event: "commit" as const }],
      jobs: config.jobs.map((job) => ({ ...job, triggers: [] })),
    };

    const record = await runCommit(
      context.github,
      repository,
      "sha",
      "main",
      manualOnly,
      context.dependencies,
      { type: "commit", branch: "main", id: "branch:main:sha" },
    );

    if (!record) throw new Error("expected a build record");
    expect(record.status).toBe("success");
    expect(record.event?.type).toBe("manual");
    expect(context.jobChecks).toEqual(["test"]);
  });

  test("cancels created job checks when later check creation fails", async () => {
    const context = harness();
    const createJobCheck = context.github.createJobCheck.bind(context.github);
    context.github.createJobCheck = async (target, sha, claimId, name) => {
      const created = await createJobCheck(target, sha, claimId, name);
      if (name === "lint") throw new Error("could not create lint check");
      return created;
    };
    let executed = false;
    context.dependencies.runInTart = async () => {
      executed = true;
      return true;
    };
    const multipleJobs = {
      ...config,
      jobs: [
        ...config.jobs,
        { name: "lint", command: "lint", timeoutMinutes: 1, environment: {}, needs: [] },
      ],
    };

    await expect(
      runCommit(context.github, repository, "sha", "main", multipleJobs, context.dependencies),
    ).rejects.toThrow("could not create lint check");
    expect(executed).toBe(false);
    expect(
      context.updates.find(
        (update) => update.id === 100 && update.values.conclusion === "cancelled",
      ),
    ).toBeDefined();
    expect(
      context.updates.find(
        (update) => update.id === 101 && update.values.conclusion === "cancelled",
      ),
    ).toBeDefined();
  });

  test("publishes job output while the job is running", async () => {
    const context = harness();
    context.dependencies.runInTart = async (
      _repository,
      _sha,
      selectedConfig,
      _record,
      observer,
    ) => {
      const [job] = selectedConfig.jobs;
      if (!job) throw new Error("expected a job");
      await observer?.started?.(job);
      await observer?.progress?.(job, "live output");
      await Bun.sleep(5);
      await observer?.completed?.(job, { outcome: "success", log: "final output" });
      return true;
    };

    await runCommit(context.github, repository, "sha", "main", config, context.dependencies);

    const progress = context.updates.find(
      (update) => update.id === 100 && update.values.status === undefined && update.values.text,
    );
    expect(progress?.values).toMatchObject({
      title: "test is running",
      text: "```text\nlive output\n```",
    });
    expect(
      context.updates.find((update) => update.id === 100 && update.values.status === "completed")
        ?.values.text,
    ).toBe("```text\nfinal output\n```");
  });

  test("coalesces progress while a GitHub update is in flight", async () => {
    const context = harness();
    const updateCheck = context.github.updateCheck.bind(context.github);
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const progressStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    context.github.updateCheck = async (target, id, values) => {
      if (id === 100 && values.status === undefined && values.text) {
        started();
        await blocked;
      }
      return updateCheck(target, id, values);
    };
    context.dependencies.runInTart = async (
      _repository,
      _sha,
      selectedConfig,
      _record,
      observer,
    ) => {
      const [job] = selectedConfig.jobs;
      if (!job) throw new Error("expected a job");
      await observer?.started?.(job);
      await observer?.progress?.(job, "first");
      await progressStarted;
      await observer?.progress?.(job, "second");
      await observer?.progress?.(job, "third");
      release();
      await Bun.sleep(5);
      await observer?.completed?.(job, { outcome: "success", log: "final" });
      return true;
    };

    await runCommit(context.github, repository, "sha", "main", config, context.dependencies);

    const progress = context.updates.filter(
      (update) => update.id === 100 && update.values.status === undefined && update.values.text,
    );
    expect(progress).toHaveLength(1);
    expect(
      context.updates.find((update) => update.id === 100 && update.values.status === "completed")
        ?.values.text,
    ).toBe("```text\nfinal\n```");
  });

  test("cancels an automatic build when its signal is aborted", async () => {
    const context = harness();
    const controller = new AbortController();
    const automaticConfig = { ...config, triggers: [{ event: "commit" as const }] };
    context.dependencies.runInTart = async (
      _repository,
      _sha,
      selectedConfig,
      _record,
      observer,
      signal,
    ) => {
      const [job] = selectedConfig.jobs;
      if (!job || !signal) throw new Error("expected an abortable job");
      await observer?.started?.(job);
      controller.abort("Superseded by main@new-sha.");
      await observer?.completed?.(job, { outcome: "cancelled", log: "cancelled output" });
      return false;
    };

    const record = await runCommit(
      context.github,
      repository,
      "old-sha",
      "main",
      automaticConfig,
      context.dependencies,
      { type: "commit", branch: "main", id: "branch:main:old-sha" },
      controller.signal,
    );

    if (!record) throw new Error("expected a build record");
    expect(record.status).toBe("cancelled");
    expect(context.saved.at(-1)?.status).toBe("cancelled");
    expect(
      context.updates.find((update) => update.id === 100 && update.values.status === "completed")
        ?.values,
    ).toMatchObject({ conclusion: "cancelled", summary: "Superseded by main@new-sha." });
    expect(context.updates.find((update) => update.id === 42)?.values).toMatchObject({
      conclusion: "cancelled",
      summary: "Superseded by main@new-sha.",
    });
  });

  test("replaces a raced successful job conclusion when cancelling", async () => {
    const context = harness();
    const controller = new AbortController();
    const automaticConfig = { ...config, triggers: [{ event: "commit" as const }] };
    const updateCheck = context.github.updateCheck.bind(context.github);
    let cancellationAttempts = 0;
    context.github.updateCheck = async (target, id, values) => {
      if (id === 100 && values.conclusion === "cancelled" && cancellationAttempts++ === 0) {
        throw new Error("temporary update failure");
      }
      return updateCheck(target, id, values);
    };
    context.dependencies.runInTart = async (
      _repository,
      _sha,
      selectedConfig,
      _record,
      observer,
    ) => {
      const [job] = selectedConfig.jobs;
      if (!job) throw new Error("expected a job");
      await observer?.started?.(job);
      await observer?.completed?.(job, { outcome: "success", log: "finished" });
      controller.abort("Superseded by main@new-sha.");
      return true;
    };

    const record = await runCommit(
      context.github,
      repository,
      "old-sha",
      "main",
      automaticConfig,
      context.dependencies,
      { type: "commit", branch: "main", id: "branch:main:old-sha" },
      controller.signal,
    );

    if (!record) throw new Error("expected a build record");
    expect(record.status).toBe("cancelled");
    expect(cancellationAttempts).toBe(2);
    expect(
      context.updates.find(
        (update) => update.id === 100 && update.values.conclusion === "cancelled",
      ),
    ).toBeDefined();
  });

  test("does not cancel a manually requested build", async () => {
    const context = harness({ manualRequest: true });
    const controller = new AbortController();
    controller.abort("superseded");

    const record = await runCommit(
      context.github,
      repository,
      "sha",
      "main",
      config,
      context.dependencies,
      { type: "commit", branch: "main", id: "branch:main:sha" },
      controller.signal,
    );

    if (!record) throw new Error("expected a build record");
    expect(record.status).toBe("success");
    expect(record.event?.type).toBe("manual");
  });
});
