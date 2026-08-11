import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregatePartitionResults,
  type CoordinatorDependencies,
  partitionJobGraphs,
  readLogTail,
  runCommit,
  runLocalCommit,
} from "./coordinator.ts";
import { createExecutionSlotAcquirer } from "./execution-capacity.ts";
import type { GitHubClient } from "./github.ts";
import type { BuildRecord, InformantConfig, Repository } from "./types.ts";

const repository: Repository = { owner: "owner", repo: "repo", fullName: "owner/repo" };
const config: InformantConfig = {
  version: 1,
  pollIntervalSeconds: 10,
  branches: ["main"],
  vm: { type: "vm", image: "image", guestOs: "macos", user: "user", password: "password" },
  jobs: [
    {
      name: "test",
      command: "test",
      optional: false,
      timeoutMinutes: 1,
      environment: {},
      secrets: [],
      needs: [],
    },
  ],
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
  options: {
    claim?: boolean;
    success?: boolean;
    error?: Error;
    manualTrigger?: boolean;
    manualTriggerBranch?: string | null;
    manualTriggerLabel?: string;
    requestedJobs?: string[];
    originalPullRequest?: number;
  } = {},
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
  let receivedRuntimeSecrets: Record<string, string> | undefined;
  let receivedConfiguredVmJobs: string[] | undefined;
  const receivedBranches: string[] = [];
  let jobCheckListings = 0;
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
    hasPendingManualTrigger: async () => options.manualTrigger ?? false,
    claim: async () =>
      options.claim === false
        ? undefined
        : {
            check: aggregateCheck,
            requestedJobs: options.requestedJobs ?? [],
            manualTrigger: options.manualTrigger ?? false,
            manualTriggerBranch: options.manualTriggerBranch,
            manualTriggerLabel: options.manualTriggerLabel,
            originalPullRequest: options.originalPullRequest,
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
    jobChecks: async () => {
      jobCheckListings++;
      return remoteChecks;
    },
    checks: async () => [aggregateCheck],
    createJobAccessToken: async () => "installation-token",
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
    housekeepingBarrier: async (callback) => callback(),
    refreshContainerBackend: async () => true,
    saveBuild: async (record) => {
      saved.push({ ...record });
    },
    runInTart: async (
      _repository,
      _sha,
      selectedConfig,
      record,
      observer,
      _signal,
      runtimeSecrets,
      configuredVmJobs,
    ) => {
      receivedBranches.push(record.branch);
      receivedConfiguredVmJobs = configuredVmJobs;
      receivedRuntimeSecrets = {};
      for (const [name, value] of Object.entries(runtimeSecrets ?? {})) {
        receivedRuntimeSecrets[name] = typeof value === "function" ? await value() : value;
      }
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
  return {
    github,
    dependencies,
    updates,
    jobChecks,
    saved,
    receivedRuntimeSecrets: () => receivedRuntimeSecrets,
    receivedConfiguredVmJobs: () => receivedConfiguredVmJobs,
    receivedBranches,
    jobCheckListings: () => jobCheckListings,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("runCommit", () => {
  test("partitions independent jobs while keeping dependency graphs together", () => {
    const base = config.jobs[0];
    if (!base) throw new Error("expected test job");
    const jobs = [
      base,
      { ...base, name: "unit" },
      { ...base, name: "package", needs: ["unit"] },
      { ...base, name: "publish", needs: ["package"] },
    ];

    expect(partitionJobGraphs(jobs).map((partition) => partition.map((job) => job.name))).toEqual([
      ["test"],
      ["unit", "package", "publish"],
    ]);
  });

  test("claims independent jobs concurrently while worker capacity is available", async () => {
    const context = harness();
    const base = config.jobs[0];
    if (!base) throw new Error("expected test job");
    const entered = deferred<void>();
    const blocked = deferred<void>();
    const runInTart = context.dependencies.runInTart;
    let executions = 0;
    context.dependencies.runInTart = async (...args) => {
      if (++executions === 2) entered.resolve();
      await blocked.promise;
      return runInTart(...args);
    };
    context.dependencies.acquireExecutionSlot = createExecutionSlotAcquirer({
      cpu: 2,
      memoryMb: 2048,
    });
    let claims = 0;
    const claim = context.github.claim.bind(context.github);
    context.github.claim = async (...args) => {
      claims++;
      return claim(...args);
    };
    const build = runCommit(
      context.github,
      repository,
      "sha",
      "main",
      {
        ...config,
        vm: { ...config.vm, cpu: 1, memoryMb: 1024 },
        jobs: [base, { ...base, name: "lint" }],
      },
      context.dependencies,
    );

    await entered.promise;
    try {
      await Bun.sleep(0);
      expect(claims).toBe(2);
      expect(context.jobChecks.sort()).toEqual(["lint", "test"]);
    } finally {
      blocked.resolve();
    }
    await build;
    expect(claims).toBe(2);
  });

  test("does not claim another suite until the worker has an available run slot", async () => {
    const first = harness();
    const second = harness();
    const entered = deferred<void>();
    const blocked = deferred<void>();
    const firstRun = first.dependencies.runInTart;
    const acquireExecutionSlot = createExecutionSlotAcquirer({ cpu: 1, memoryMb: 1024 });
    first.dependencies.acquireExecutionSlot = acquireExecutionSlot;
    second.dependencies.acquireExecutionSlot = acquireExecutionSlot;
    first.dependencies.runInTart = async (...args) => {
      entered.resolve();
      await blocked.promise;
      return firstRun(...args);
    };
    let secondClaims = 0;
    const secondClaim = second.github.claim.bind(second.github);
    second.github.claim = async (...args) => {
      secondClaims++;
      return secondClaim(...args);
    };

    const firstBuild = runCommit(
      first.github,
      repository,
      "first-sha",
      "main",
      config,
      first.dependencies,
    );
    await entered.promise;
    const secondBuild = runCommit(
      second.github,
      repository,
      "second-sha",
      "feature",
      config,
      second.dependencies,
    );
    await Bun.sleep(0);

    expect(secondClaims).toBe(0);
    expect(second.jobChecks).toEqual([]);

    blocked.resolve();
    await firstBuild;
    await secondBuild;
    expect(secondClaims).toBe(1);
    expect(second.jobChecks).toEqual(["test"]);
  });

  test("drops unclaimed suites immediately when worker shutdown starts", async () => {
    const active = harness();
    const waiting = harness();
    const entered = deferred<void>();
    const blocked = deferred<void>();
    const activeRun = active.dependencies.runInTart;
    const acquireExecutionSlot = createExecutionSlotAcquirer({ cpu: 1, memoryMb: 1024 });
    active.dependencies.acquireExecutionSlot = acquireExecutionSlot;
    waiting.dependencies.acquireExecutionSlot = acquireExecutionSlot;
    active.dependencies.runInTart = async (...args) => {
      entered.resolve();
      await blocked.promise;
      return activeRun(...args);
    };
    let waitingClaims = 0;
    const waitingClaim = waiting.github.claim.bind(waiting.github);
    waiting.github.claim = async (...args) => {
      waitingClaims++;
      return waitingClaim(...args);
    };
    const execution = new AbortController();
    const admission = new AbortController();

    const activeBuild = runCommit(
      active.github,
      repository,
      "active-sha",
      "main",
      config,
      active.dependencies,
    );
    await entered.promise;
    const waitingBuild = runCommit(
      waiting.github,
      repository,
      "waiting-sha",
      "feature",
      config,
      waiting.dependencies,
      { type: "commit", id: "branch:feature:waiting-sha", branch: "feature" },
      execution.signal,
      admission.signal,
    );
    await Bun.sleep(0);

    admission.abort("Worker shutdown requested.");

    expect(await waitingBuild).toBeFalse();
    expect(waitingClaims).toBe(0);
    expect(execution.signal.aborted).toBe(false);
    blocked.resolve();
    await activeBuild;
  });

  test("treats an interrupted GitHub claim as unclaimed work", async () => {
    const context = harness();
    const enteredClaim = deferred<void>();
    const execution = new AbortController();
    const admission = new AbortController();
    context.github.claim = async (...args) => {
      const signal = args[8];
      if (!signal) throw new Error("expected an admission signal");
      expect(args[9]).toBe(execution.signal);
      enteredClaim.resolve();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };

    const build = runCommit(
      context.github,
      repository,
      "waiting-sha",
      "feature",
      config,
      context.dependencies,
      { type: "commit", id: "branch:feature:waiting-sha", branch: "feature" },
      execution.signal,
      admission.signal,
    );
    await enteredClaim.promise;
    admission.abort("Worker shutdown requested.");

    expect(await build).toBeFalse();
    expect(execution.signal.aborted).toBe(false);
  });

  test("drops superseded automatic suites while they wait for a run slot", async () => {
    const first = harness();
    const superseded = harness();
    const current = harness();
    const entered = deferred<void>();
    const blocked = deferred<void>();
    const firstRun = first.dependencies.runInTart;
    const acquireExecutionSlot = createExecutionSlotAcquirer({ cpu: 1, memoryMb: 1024 });
    first.dependencies.acquireExecutionSlot = acquireExecutionSlot;
    superseded.dependencies.acquireExecutionSlot = acquireExecutionSlot;
    current.dependencies.acquireExecutionSlot = acquireExecutionSlot;
    first.dependencies.runInTart = async (...args) => {
      entered.resolve();
      await blocked.promise;
      return firstRun(...args);
    };
    let supersededClaims = 0;
    const supersededClaim = superseded.github.claim.bind(superseded.github);
    superseded.github.claim = async (...args) => {
      supersededClaims++;
      return supersededClaim(...args);
    };
    const controller = new AbortController();

    const firstBuild = runCommit(
      first.github,
      repository,
      "first-sha",
      "main",
      config,
      first.dependencies,
    );
    await entered.promise;
    const oldBuild = runCommit(
      superseded.github,
      repository,
      "old-sha",
      "feature",
      config,
      superseded.dependencies,
      { type: "commit", id: "branch:feature:old-sha", branch: "feature" },
      controller.signal,
    );
    const currentBuild = runCommit(
      current.github,
      repository,
      "current-sha",
      "feature",
      config,
      current.dependencies,
    );
    controller.abort("Superseded by feature@current-sha.");

    expect(await oldBuild).toBeFalse();
    expect(supersededClaims).toBe(0);
    blocked.resolve();
    await Promise.all([firstBuild, currentBuild]);
    expect(current.jobChecks).toEqual(["test"]);
  });

  test("does not claim work cancelled as an execution slot is granted", async () => {
    const context = harness();
    const controller = new AbortController();
    let claims = 0;
    let releases = 0;
    const claim = context.github.claim.bind(context.github);
    context.github.claim = async (...args) => {
      claims++;
      return claim(...args);
    };
    context.dependencies.acquireExecutionSlot = async () => {
      controller.abort("superseded");
      return () => {
        releases++;
      };
    };

    expect(
      await runCommit(
        context.github,
        repository,
        "sha",
        "main",
        config,
        context.dependencies,
        { type: "commit", id: "branch:main:sha", branch: "main" },
        controller.signal,
      ),
    ).toBeFalse();
    expect(claims).toBe(0);
    expect(releases).toBe(1);
  });

  test("manual suites retain their existing claim behavior while automatic work is running", async () => {
    const first = harness();
    const manual = harness({ manualTrigger: true });
    const entered = deferred<void>();
    const blocked = deferred<void>();
    const firstRun = first.dependencies.runInTart;
    first.dependencies.runInTart = async (...args) => {
      entered.resolve();
      await blocked.promise;
      return firstRun(...args);
    };
    const controller = new AbortController();

    const firstBuild = runCommit(
      first.github,
      repository,
      "first-sha",
      "main",
      config,
      first.dependencies,
    );
    await entered.promise;
    const manualBuild = runCommit(
      manual.github,
      repository,
      "manual-sha",
      "feature",
      config,
      manual.dependencies,
      { type: "commit", id: "branch:feature:manual-sha", branch: "feature" },
      controller.signal,
    );
    controller.abort("superseded");
    const result = await manualBuild;
    expect(typeof result === "object" ? result.status : result).toBe("success");
    expect(manual.jobChecks).toEqual(["test"]);

    blocked.resolve();
    await firstBuild;
  });

  test("does not execute automatic fallback after a preflight manual request is consumed", async () => {
    let requireManualTrigger: unknown;
    let executed = false;
    const github = {
      hasPendingManualTrigger: async () => true,
      claim: async (...args: unknown[]) => {
        requireManualTrigger = args[7];
        return {
          check: { id: 42 },
          requestedJobs: [],
          manualTrigger: false,
        };
      },
    } as unknown as GitHubClient;
    const dependencies = harness().dependencies;
    dependencies.runInTart = async () => {
      executed = true;
      return true;
    };

    const result = await runCommit(github, repository, "sha", "main", config, dependencies, {
      type: "commit",
      id: "branch:main:sha",
      branch: "main",
    });

    expect(result).toBeFalse();
    expect(requireManualTrigger).toBeTrue();
    expect(executed).toBeFalse();
  });

  test("partitions overlapping worker capabilities into non-overlapping claim scopes", async () => {
    const claims: Array<{ event?: { type: string; id: string }; jobs?: string[] }> = [];
    const github = {
      hasPendingManualTrigger: async () => false,
      claim: async (
        _repository: Repository,
        _sha: string,
        _machine: string,
        event?: { type: string; id: string },
        jobs?: string[],
      ) => {
        claims.push({ event, jobs });
        return undefined;
      },
    } as unknown as GitHubClient;
    const baseJob = config.jobs[0];
    if (!baseJob) throw new Error("expected test job");
    const capabilityConfig: InformantConfig = {
      ...config,
      jobs: [
        {
          ...baseJob,
          runsOn: [process.platform, process.arch],
          runtime: { type: "host" },
        },
        {
          ...baseJob,
          name: "gpu-test",
          runsOn: [process.platform, process.arch, "gpu"],
          runtime: { type: "host" },
        },
      ],
    };
    const event = { type: "commit" as const, id: "branch:main:sha", branch: "main" };

    delete Bun.env.INFORMANT_CAPABILITIES;
    await runCommit(
      github,
      repository,
      "sha",
      "main",
      capabilityConfig,
      harness().dependencies,
      event,
    );
    Bun.env.INFORMANT_CAPABILITIES = "gpu";
    try {
      await runCommit(
        github,
        repository,
        "sha",
        "main",
        capabilityConfig,
        harness().dependencies,
        event,
      );
    } finally {
      delete Bun.env.INFORMANT_CAPABILITIES;
    }

    expect(claims).toHaveLength(3);
    expect(claims[0]?.event?.id).toBe(claims[1]?.event?.id);
    expect(claims[0]?.jobs).toEqual(["test"]);
    expect(claims[1]?.jobs).toEqual(["test"]);
    expect(claims[2]?.jobs).toEqual(["gpu-test"]);
    expect(claims[2]?.event?.id).not.toBe(claims[1]?.event?.id);
  });

  test("returns retryable before claiming selected portable container work when unavailable", async () => {
    let claims = 0;
    const github = {
      hasPendingManualTrigger: async () => false,
      claim: async () => {
        claims++;
        return undefined;
      },
    } as unknown as GitHubClient;
    const baseJob = config.jobs[0];
    if (!baseJob) throw new Error("expected test job");
    const containerConfig: InformantConfig = {
      ...config,
      jobs: [
        {
          ...baseJob,
          runsOn: ["container"],
          runtime: { type: "container", image: "docker.io/oven/bun:1" },
          triggers: [{ event: "comment" }],
        },
      ],
    };
    const dependencies = harness().dependencies;
    let ready = false;
    let refreshes = 0;
    const signals: Array<AbortSignal | undefined> = [];
    dependencies.refreshContainerBackend = async (signal) => {
      refreshes++;
      signals.push(signal);
      return ready;
    };
    const event = { type: "comment" as const, id: "pr:1:comment:7" };

    expect(
      await runCommit(github, repository, "sha", "main", containerConfig, dependencies, event),
    ).toBeFalse();
    expect(refreshes).toBe(1);
    expect(claims).toBe(0);

    ready = true;
    const controller = new AbortController();
    await runCommit(
      github,
      repository,
      "sha",
      "main",
      containerConfig,
      dependencies,
      event,
      controller.signal,
    );
    expect(refreshes).toBe(2);
    expect(claims).toBe(1);
    expect(signals).toEqual([undefined, controller.signal]);
  });

  test("interrupts portable container readiness before claiming during shutdown", async () => {
    let claims = 0;
    const github = {
      hasPendingManualTrigger: async () => false,
      claim: async () => {
        claims++;
        return undefined;
      },
    } as unknown as GitHubClient;
    const baseJob = config.jobs[0];
    if (!baseJob) throw new Error("expected test job");
    const dependencies = harness().dependencies;
    const enteredReadiness = deferred<void>();
    dependencies.refreshContainerBackend = async (signal) => {
      if (!signal) throw new Error("expected an admission signal");
      enteredReadiness.resolve();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const execution = new AbortController();
    const admission = new AbortController();
    const build = runCommit(
      github,
      repository,
      "sha",
      "main",
      {
        ...config,
        jobs: [
          {
            ...baseJob,
            runsOn: ["container"],
            runtime: { type: "container", image: "docker.io/oven/bun:1" },
          },
        ],
      },
      dependencies,
      { type: "commit", id: "branch:main:sha", branch: "main" },
      execution.signal,
      admission.signal,
    );
    await enteredReadiness.promise;
    admission.abort("Worker shutdown requested.");

    expect(await build).toBeFalse();
    expect(claims).toBe(0);
    expect(execution.signal.aborted).toBe(false);
  });

  test("does not execute a partial host subset when selected container work is unavailable", async () => {
    let claims = 0;
    let executions = 0;
    const github = {
      hasPendingManualTrigger: async () => false,
      claim: async () => {
        claims++;
        return undefined;
      },
    } as unknown as GitHubClient;
    const baseJob = config.jobs[0];
    if (!baseJob) throw new Error("expected test job");
    const dependencies = harness().dependencies;
    dependencies.workerCapabilities = () => ["self-hosted", "linux", "x64"];
    dependencies.refreshContainerBackend = async () => false;
    dependencies.runInTart = async () => {
      executions++;
      return true;
    };
    const result = await runCommit(
      github,
      repository,
      "sha",
      "main",
      {
        ...config,
        jobs: [
          { ...baseJob, runsOn: ["linux", "x64"], runtime: { type: "host" } },
          {
            ...baseJob,
            name: "container",
            runsOn: ["linux", "x64"],
            runtime: { type: "container", image: "docker.io/oven/bun:1" },
          },
        ],
      },
      dependencies,
    );
    expect(result).toBeFalse();
    expect(claims).toBe(0);
    expect(executions).toBe(0);
  });

  test("does not retry incompatible Darwin-only container work on a Linux worker", async () => {
    let claims = 0;
    let refreshes = 0;
    const github = {
      hasPendingManualTrigger: async () => false,
      claim: async () => {
        claims++;
        return undefined;
      },
    } as unknown as GitHubClient;
    const baseJob = config.jobs[0];
    if (!baseJob) throw new Error("expected test job");
    const dependencies = harness().dependencies;
    dependencies.workerCapabilities = () => ["self-hosted", "linux", "x64"];
    dependencies.refreshContainerBackend = async () => {
      refreshes++;
      return false;
    };
    const result = await runCommit(
      github,
      repository,
      "sha",
      "main",
      {
        ...config,
        jobs: [
          {
            ...baseJob,
            runsOn: ["darwin", "arm64"],
            runtime: { type: "container", image: "docker.io/oven/bun:1" },
          },
        ],
      },
      dependencies,
    );
    expect(result).toBeUndefined();
    expect(refreshes).toBe(0);
    expect(claims).toBe(0);
  });

  test("does not probe container readiness for VM or host-only configs", async () => {
    const github = {
      hasPendingManualTrigger: async () => false,
      claim: async () => undefined,
    } as unknown as GitHubClient;
    const baseJob = config.jobs[0];
    if (!baseJob) throw new Error("expected test job");
    const dependencies = harness().dependencies;
    let refreshes = 0;
    dependencies.refreshContainerBackend = async () => {
      refreshes++;
      return true;
    };
    await runCommit(github, repository, "vm", "main", config, dependencies);
    await runCommit(
      github,
      repository,
      "host",
      "main",
      {
        ...config,
        jobs: [
          {
            ...baseJob,
            runsOn: [process.platform, process.arch],
            runtime: { type: "host" },
          },
        ],
      },
      dependencies,
    );
    expect(refreshes).toBe(0);
  });

  test("legacy capability scopes cover every label group before trigger selection", async () => {
    const claims: Array<{ jobs?: string[]; legacyScopes?: string[] }> = [];
    const github = {
      hasPendingManualTrigger: async () => false,
      claim: async (...args: unknown[]) => {
        claims.push({ jobs: args[4] as string[], legacyScopes: args[6] as string[] });
        return undefined;
      },
    } as unknown as GitHubClient;
    const baseJob = config.jobs[0];
    if (!baseJob) throw new Error("expected test job");
    const labels = [process.platform, process.arch].sort();
    const gpuLabels = [...labels, "gpu"].sort();
    const event = { type: "commit" as const, id: "branch:main:sha", branch: "main" };

    Bun.env.INFORMANT_CAPABILITIES = "gpu";
    try {
      await runCommit(
        github,
        repository,
        "sha",
        "main",
        {
          ...config,
          jobs: [
            {
              ...baseJob,
              runsOn: labels,
              runtime: { type: "host" },
              triggers: [{ event: "commit" }],
            },
            {
              ...baseJob,
              name: "lint",
              runsOn: labels,
              runtime: { type: "host" },
              triggers: [{ event: "comment" }],
            },
            {
              ...baseJob,
              name: "gpu-test",
              needs: ["test"],
              runsOn: gpuLabels,
              runtime: { type: "host" },
              triggers: [{ event: "commit" }],
            },
          ],
        },
        harness().dependencies,
        event,
      );
    } finally {
      delete Bun.env.INFORMANT_CAPABILITIES;
    }

    const baseScope = `commit:${event.id}`;
    const legacyScopes = [
      `${baseScope}:jobs:${Buffer.from("gpu-test\0test").toString("base64url")}`,
      `${baseScope}:jobs:${Buffer.from(labels.join("\0")).toString("base64url")}`,
      `${baseScope}:jobs:${Buffer.from(labels.join("\0")).toString("base64url")}:jobs:${Buffer.from("lint\0test").toString("base64url")}`,
      `${baseScope}:jobs:${Buffer.from(gpuLabels.join("\0")).toString("base64url")}`,
      `${baseScope}:jobs:${Buffer.from(gpuLabels.join("\0")).toString("base64url")}:jobs:${Buffer.from("gpu-test").toString("base64url")}`,
    ];
    expect(claims).toEqual([{ jobs: ["test", "gpu-test"], legacyScopes }]);
  });

  test("job component scopes cannot collide with legacy runs-on label scopes", async () => {
    const claims: Array<{
      event?: { type: string; id: string; branch?: string; label?: string };
      legacyScopes?: string[];
    }> = [];
    const github = {
      hasPendingManualTrigger: async () => false,
      claim: async (...args: unknown[]) => {
        claims.push({
          event: args[3] as { type: string; id: string; branch?: string; label?: string },
          legacyScopes: args[6] as string[],
        });
        return undefined;
      },
    } as unknown as GitHubClient;
    const baseJob = config.jobs[0];
    if (!baseJob) throw new Error("expected test job");
    const event = { type: "commit" as const, id: "branch:main:sha", branch: "main" };
    const encodedGpu = Buffer.from("gpu").toString("base64url");

    Bun.env.INFORMANT_CAPABILITIES = "gpu";
    try {
      await runCommit(
        github,
        repository,
        "sha",
        "main",
        {
          ...config,
          jobs: [
            {
              ...baseJob,
              name: "gpu",
              runsOn: ["gpu"],
              runtime: { type: "host" },
              triggers: [{ event: "commit" }],
            },
          ],
        },
        harness().dependencies,
        event,
      );
    } finally {
      delete Bun.env.INFORMANT_CAPABILITIES;
    }

    const currentScope = `commit:${event.id}:job-set:${encodedGpu}`;
    const legacyLabelScope = `commit:${event.id}:jobs:${encodedGpu}`;
    expect(claims).toEqual([
      {
        event: { ...event, id: `${event.id}:job-set:${encodedGpu}`, label: "main" },
        legacyScopes: [legacyLabelScope, `${legacyLabelScope}:jobs:${encodedGpu}`],
      },
    ]);
    expect(currentScope).not.toBe(legacyLabelScope);
  });

  test("retries the event when any capability partition loses its claim", async () => {
    let claims = 0;
    const github = {
      hasPendingManualTrigger: async () => false,
      claim: async () => (++claims === 1 ? { retry: true } : undefined),
    } as unknown as GitHubClient;
    const baseJob = config.jobs[0];
    if (!baseJob) throw new Error("expected test job");
    Bun.env.INFORMANT_CAPABILITIES = "gpu";
    try {
      expect(
        await runCommit(
          github,
          repository,
          "sha",
          "main",
          {
            ...config,
            jobs: [
              { ...baseJob, runsOn: [process.platform, process.arch] },
              {
                ...baseJob,
                name: "gpu-test",
                runsOn: [process.platform, process.arch, "gpu"],
              },
            ],
          },
          harness().dependencies,
          { type: "commit", id: "branch:main:sha", branch: "main" },
        ),
      ).toBeFalse();
    } finally {
      delete Bun.env.INFORMANT_CAPABILITIES;
    }
  });

  test("returns a failed record when any capability partition fails", () => {
    const record = (status: BuildRecord["status"]): BuildRecord => ({
      id: status,
      repo: repository.fullName,
      sha: "sha",
      branch: "main",
      machine: "worker",
      startedAt: "2026-08-04T00:00:00Z",
      status,
      logPath: `/tmp/${status}.log`,
    });
    const result = aggregatePartitionResults([record("success"), record("failure")]);
    expect(typeof result === "object" ? result.status : result).toBe("failure");
  });

  test("keeps the complete VM job inventory when selecting one manually triggered job", async () => {
    const baseJob = config.jobs[0];
    if (!baseJob) throw new Error("expected test job");
    const selectedConfig: InformantConfig = {
      ...config,
      jobs: [
        baseJob,
        {
          name: "macos-e2e",
          command: "test e2e",
          optional: false,
          timeoutMinutes: 1,
          environment: {},
          secrets: [],
          needs: [],
        },
      ],
    };
    const context = harness({ manualTrigger: true, requestedJobs: ["test"] });

    await runCommit(
      context.github,
      repository,
      "sha",
      "main",
      selectedConfig,
      context.dependencies,
    );

    expect(context.jobChecks).toEqual(["test"]);
    expect(context.receivedConfiguredVmJobs()).toEqual(["test", "macos-e2e"]);
  });

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
    expect(context.jobCheckListings()).toBe(0);
  });

  test("reports an optional failure as neutral without failing the build", async () => {
    const context = harness();
    const optionalConfig: InformantConfig = {
      ...config,
      jobs: config.jobs.map((job) => ({ ...job, optional: true })),
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
      await observer?.completed?.(job, { outcome: "failure", log: "review failed" });
      return true;
    };

    const record = await runCommit(
      context.github,
      repository,
      "sha",
      "main",
      optionalConfig,
      context.dependencies,
    );

    expect(record).toMatchObject({
      status: "success",
      jobs: [{ name: "test", status: "failure" }],
    });
    expect(
      context.updates.find((update) => update.id === 100 && update.values.status === "completed")
        ?.values,
    ).toMatchObject({
      conclusion: "neutral",
      title: "test failed (optional)",
      summary: "This optional job failed without failing the build.",
    });
    expect(context.updates.find((update) => update.id === 42)?.values).toMatchObject({
      conclusion: "success",
      title: "All required jobs passed",
      summary: expect.stringContaining("1 optional failure"),
    });
  });

  test("persists the jobs that are currently running", async () => {
    const context = harness();

    await runCommit(context.github, repository, "sha", "main", config, context.dependencies);

    expect(context.saved.some((record) => record.runningJobs?.includes("test"))).toBe(true);
    expect(
      context.saved.some((record) =>
        record.jobs?.some((job) => job.name === "test" && job.status === "running"),
      ),
    ).toBe(true);
    expect(context.saved.at(-1)?.runningJobs).toEqual([]);
    expect(context.saved.at(-1)?.jobs).toEqual([{ name: "test", status: "success" }]);
  });

  test("persists the terminal outcome before completing the aggregate check", async () => {
    const context = harness();
    const updateCheck = context.github.updateCheck.bind(context.github);
    let persistedBeforeAggregate: BuildRecord | undefined;
    context.github.updateCheck = async (target, id, values) => {
      if (id === 42 && values.status === "completed") {
        persistedBeforeAggregate = context.saved.at(-1);
      }
      return updateCheck(target, id, values);
    };

    await runCommit(context.github, repository, "sha", "main", config, context.dependencies);

    expect(persistedBeforeAggregate).toMatchObject({ status: "success" });
    expect(persistedBeforeAggregate?.checksCompletedAt).toBeUndefined();
  });

  test("job check updates continue when running-job persistence fails", async () => {
    const context = harness();
    context.dependencies.saveBuild = async () => {
      throw new Error("disk full");
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
    expect(
      context.updates.find((update) => update.id === 100 && update.values.conclusion === "success"),
    ).toBeDefined();
  });

  test("records an explicit pull request target", async () => {
    const context = harness();
    const pullRequestConfig: InformantConfig = {
      ...config,
      jobs: config.jobs.map((job) => ({
        ...job,
        triggers: [{ event: "commit", pullRequest: {} }],
      })),
    };

    const record = await runCommit(
      context.github,
      repository,
      "sha",
      "pull/7",
      pullRequestConfig,
      context.dependencies,
      {
        type: "commit",
        id: "pr:7:sha",
        pullRequest: {
          number: 7,
          state: "open",
          draft: false,
          baseBranch: "main",
          headSha: "sha",
          sameRepository: true,
        },
      },
    );

    if (!record) throw new Error("expected a build record");
    expect(record.pullRequest).toBe(7);
  });

  test("preserves the pull request environment when its check is rerun", async () => {
    const initial = harness();
    const rerun = harness({
      manualTrigger: true,
      originalPullRequest: 7,
    });
    const pullRequestConfig: InformantConfig = {
      ...config,
      jobs: config.jobs.map((job) => ({
        ...job,
        triggers: [{ event: "commit", pullRequest: {} }],
      })),
    };
    const pullRequestEvent = {
      type: "commit" as const,
      id: "pr:7:sha",
      pullRequest: {
        number: 7,
        state: "open" as const,
        draft: false,
        baseBranch: "main",
        headSha: "sha",
        sameRepository: true,
      },
    };

    const initialRecord = await runCommit(
      initial.github,
      repository,
      "sha",
      "pull/7",
      pullRequestConfig,
      initial.dependencies,
      pullRequestEvent,
    );
    const rerunRecord = await runCommit(
      rerun.github,
      repository,
      "sha",
      "feature-branch",
      pullRequestConfig,
      rerun.dependencies,
      { type: "commit", id: "branch:feature-branch:sha", branch: "feature-branch" },
    );

    if (!initialRecord || !rerunRecord) throw new Error("expected both build records");
    expect(initial.receivedBranches).toEqual(["pull/7"]);
    expect(rerun.receivedBranches).toEqual(initial.receivedBranches);
    expect(initialRecord.pullRequest).toBe(7);
    expect(rerunRecord.pullRequest).toBe(7);
  });

  test("supplies the GitHub App token only when a job requests it", async () => {
    const context = harness();
    const job = config.jobs[0];
    if (!job) throw new Error("expected a configured job");
    const reviewConfig = {
      ...config,
      jobs: [{ ...job, secrets: ["AMP_API_KEY", "GITHUB_TOKEN"] }],
    };
    await runCommit(
      context.github,
      repository,
      "sha",
      "pull/1",
      reviewConfig,
      context.dependencies,
    );
    expect(context.receivedRuntimeSecrets()).toEqual({ GITHUB_TOKEN: "installation-token" });
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

  test("an all-jobs manual trigger retains job filters", async () => {
    const context = harness({ manualTrigger: true });
    const testJob = config.jobs[0];
    if (!testJob) throw new Error("expected a test job");
    const manualOnly = {
      ...config,
      triggers: [{ event: "commit" as const }],
      jobs: [
        ...config.jobs.map((job) => ({ ...job, triggers: [] })),
        {
          ...testJob,
          name: "deploy",
          triggers: [{ event: "commit" as const }],
          filters: [{ branch: { names: ["main"] } }],
        },
      ],
    };

    const record = await runCommit(
      context.github,
      repository,
      "sha",
      "feature",
      manualOnly,
      context.dependencies,
      { type: "commit", branch: "feature", id: "branch:feature:sha" },
    );

    if (!record) throw new Error("expected a build record");
    expect(record.status).toBe("success");
    expect(record.event?.type).toBe("manual_trigger");
    expect(context.jobChecks).toEqual(["test"]);
  });

  test("an explicitly requested manual trigger retains job filters", async () => {
    const context = harness({
      manualTrigger: true,
      manualTriggerBranch: null,
      requestedJobs: ["test"],
    });
    const branchFiltered = {
      ...config,
      jobs: config.jobs.map((job) => ({
        ...job,
        triggers: [{ event: "commit" as const }],
        filters: [{ branch: { names: ["main"] } }],
      })),
    };

    const record = await runCommit(
      context.github,
      repository,
      "sha",
      "feature",
      branchFiltered,
      context.dependencies,
      { type: "commit", branch: "feature", id: "branch:feature:sha" },
    );

    expect(record).toBeUndefined();
    expect(context.jobChecks).toEqual([]);
    expect(context.updates.at(-1)?.values).toMatchObject({
      conclusion: "neutral",
      title: "No jobs matched",
    });
  });

  test("a manual trigger uses its encoded branch instead of the polling target", async () => {
    const context = harness({
      manualTrigger: true,
      manualTriggerBranch: "release",
      requestedJobs: ["test"],
    });
    const filtered = {
      ...config,
      jobs: config.jobs.map((job) => ({
        ...job,
        filters: [{ branch: { names: ["release"] } }],
      })),
    };

    const record = await runCommit(
      context.github,
      repository,
      "sha",
      "main",
      filtered,
      context.dependencies,
      { type: "commit", branch: "main", id: "branch:main:sha" },
    );

    if (!record) throw new Error("expected a build record");
    expect(record.status).toBe("success");
    expect(context.jobChecks).toEqual(["test"]);
    expect(context.receivedBranches).toEqual(["release"]);
  });

  test("a pull request rerun discovered through a branch does not satisfy its filter", async () => {
    const context = harness({ manualTrigger: true, originalPullRequest: 7 });
    const filtered = {
      ...config,
      jobs: config.jobs.map((job) => ({
        ...job,
        filters: [{ branch: { names: ["feature"] } }],
      })),
    };

    const record = await runCommit(
      context.github,
      repository,
      "sha",
      "feature",
      filtered,
      context.dependencies,
      { type: "commit", branch: "feature", id: "branch:feature:sha" },
    );

    expect(record).toBeUndefined();
    expect(context.jobChecks).toEqual([]);
  });

  test("a tag suite rerun retains its execution label when discovered through a branch", async () => {
    const context = harness({
      manualTrigger: true,
      manualTriggerBranch: null,
      manualTriggerLabel: "v2",
    });

    const record = await runCommit(
      context.github,
      repository,
      "sha",
      "main",
      config,
      context.dependencies,
      { type: "commit", branch: "main", id: "branch:main:sha" },
    );

    if (!record) throw new Error("expected a build record");
    expect(context.receivedBranches).toEqual(["v2"]);
  });

  test("a local manual run bypasses job filters", async () => {
    const context = harness();
    const filtered = {
      ...config,
      jobs: config.jobs.map((job) => ({
        ...job,
        filters: [{ branch: { names: ["main"] } }],
      })),
    };

    const record = await runLocalCommit(repository, "sha", "feature", filtered, {
      requestedJobs: ["test"],
      dependencies: context.dependencies,
    });

    expect(record.status).toBe("success");
    expect(record.event?.type).toBe("manual_run");
    expect(context.jobChecks).toEqual([]);
    expect(context.updates).toEqual([]);
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
        {
          name: "lint",
          command: "lint",
          optional: false,
          timeoutMinutes: 1,
          environment: {},
          secrets: [],
          needs: ["test"],
        },
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

  test("rate-limits sequential progress updates and publishes the latest tail", async () => {
    const context = harness();
    const realNow = Date.now;
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    let now = 10_000;
    let nextTimer = 1;
    const timers = new Map<number, { at: number; callback: () => void }>();
    const advance = async (milliseconds: number) => {
      now += milliseconds;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        due[1].callback();
        await Promise.resolve();
      }
    };
    Date.now = () => now;
    globalThis.setTimeout = ((callback: () => void, delay = 0) => {
      const id = nextTimer++;
      timers.set(id, { at: now + delay, callback });
      return id;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => {
      timers.delete(id);
    }) as typeof clearTimeout;
    try {
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
        observer?.progress?.(job, "first");
        await advance(0);
        await Promise.resolve();
        observer?.progress?.(job, "second");
        observer?.progress?.(job, "latest");
        await advance(9_999);
        expect(
          context.updates.filter(
            (update) =>
              update.id === 100 && update.values.status === undefined && update.values.text,
          ),
        ).toHaveLength(1);
        await advance(1);
        await Promise.resolve();
        await Promise.resolve();
        return true;
      };

      await runCommit(context.github, repository, "sha", "main", config, context.dependencies);

      const progress = context.updates.filter(
        (update) => update.id === 100 && update.values.status === undefined && update.values.text,
      );
      expect(progress).toHaveLength(2);
      expect(progress[1]?.values.text).toBe("```text\nlatest\n```");
    } finally {
      Date.now = realNow;
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
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

  test("does not cancel a manually triggered build", async () => {
    const context = harness({ manualTrigger: true });
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
    expect(record.event?.type).toBe("manual_trigger");
  });
});
