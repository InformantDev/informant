import { hostname } from "node:os";
import { join } from "node:path";
import { selectCapableJobs, workerCapabilities } from "./capabilities.ts";
import { selectJobs, selectManuallyTriggeredJobs, selectTriggeredJobs } from "./config.ts";
import type { GitHubClient } from "./github.ts";
import { createBuild, currentProcessOwner, dataDirectory, saveBuild } from "./store.ts";
import { type JobOutcome, type RuntimeSecrets, runInTart } from "./tart/index.ts";
import { withImageLock } from "./tart/vm.ts";
import { type EventContext, triggerMatches } from "./triggers.ts";
import type { BuildRecord, CheckRun, InformantConfig, JobConfig, Repository } from "./types.ts";

type RunEvent = EventContext & { id: string };

export interface CoordinatorDependencies {
  createBuild: typeof createBuild;
  saveBuild: typeof saveBuild;
  runInTart: typeof runInTart;
  readLogTail: (path: string) => Promise<string>;
  housekeepingBarrier?: <T>(callback: () => Promise<T>) => Promise<T>;
}

const CHECK_LOG_CHARACTERS = 55_000;
const CHECK_LOG_BYTES = CHECK_LOG_CHARACTERS * 4;
const CHECK_LOG_UPDATE_INTERVAL_MS = 10_000;

interface RunSlotWaiter {
  signal?: AbortSignal;
  resolve: (release: (() => void) | undefined) => void;
  abort?: () => void;
}

let runSlotHeld = false;
const runSlotWaiters: RunSlotWaiter[] = [];

function dispatchRunSlot(): void {
  if (runSlotHeld) return;
  const waiter = runSlotWaiters.shift();
  if (!waiter) return;
  if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
  runSlotHeld = true;
  waiter.resolve(releaseRunSlot);
}

function releaseRunSlot(): void {
  runSlotHeld = false;
  dispatchRunSlot();
}

async function acquireRunSlot(signal?: AbortSignal): Promise<(() => void) | undefined> {
  if (signal?.aborted) return undefined;
  if (!runSlotHeld && runSlotWaiters.length === 0) {
    runSlotHeld = true;
    return releaseRunSlot;
  }
  return new Promise((resolve) => {
    const waiter: RunSlotWaiter = { signal, resolve };
    waiter.abort = () => {
      const index = runSlotWaiters.indexOf(waiter);
      if (index !== -1) runSlotWaiters.splice(index, 1);
      resolve(undefined);
    };
    signal?.addEventListener("abort", waiter.abort, { once: true });
    runSlotWaiters.push(waiter);
    if (signal?.aborted) waiter.abort();
  });
}

export async function readLogTail(path: string): Promise<string> {
  const file = Bun.file(path);
  const bytes = new Uint8Array(
    await file.slice(Math.max(0, file.size - CHECK_LOG_BYTES), file.size).arrayBuffer(),
  );
  let start = 0;
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  return Array.from(new TextDecoder().decode(bytes.subarray(start)))
    .slice(-CHECK_LOG_CHARACTERS)
    .join("");
}

const defaultDependencies: CoordinatorDependencies = {
  createBuild,
  saveBuild,
  runInTart,
  readLogTail,
};

export function aggregatePartitionResults(
  results: Array<BuildRecord | false | undefined>,
): BuildRecord | false | undefined {
  if (results.includes(false)) return false;
  const records = results.filter((result): result is BuildRecord => typeof result === "object");
  return (
    records.find((record) => record.status === "failure") ??
    records.find((record) => record.status === "cancelled") ??
    records[0]
  );
}

export function partitionJobGraphs(jobs: JobConfig[]): JobConfig[][] {
  const byName = new Map(jobs.map((job) => [job.name, job]));
  const neighbors = new Map(jobs.map((job) => [job.name, new Set<string>()]));
  for (const job of jobs) {
    for (const dependency of job.needs) {
      if (!byName.has(dependency)) continue;
      neighbors.get(job.name)?.add(dependency);
      neighbors.get(dependency)?.add(job.name);
    }
  }
  const visited = new Set<string>();
  const partitions: JobConfig[][] = [];
  for (const job of jobs) {
    if (visited.has(job.name)) continue;
    const pending = [job.name];
    const names = new Set<string>();
    while (pending.length > 0) {
      const name = pending.pop();
      if (!name || visited.has(name)) continue;
      visited.add(name);
      names.add(name);
      pending.push(...(neighbors.get(name) ?? []));
    }
    partitions.push(jobs.filter((candidate) => names.has(candidate.name)));
  }
  return partitions;
}

export async function runLocalCommit(
  repository: Repository,
  sha: string,
  branch: string,
  unselectedConfig: InformantConfig,
  options: {
    requestedJobs?: string[];
    runtimeSecrets?: RuntimeSecrets;
    dependencies?: CoordinatorDependencies;
  } = {},
): Promise<BuildRecord> {
  const dependencies = options.dependencies ?? defaultDependencies;
  const configuredVmJobs = unselectedConfig.jobs
    .filter((job) => job.runtime?.type !== "container")
    .map((job) => job.name);
  const config = selectJobs(unselectedConfig, options.requestedJobs ?? []);
  const id = crypto.randomUUID().slice(0, 12);
  const record: BuildRecord = {
    id,
    repo: repository.fullName,
    sha,
    branch,
    machine: hostname(),
    startedAt: new Date().toISOString(),
    status: "running",
    runningJobs: [],
    jobs: config.jobs.map((job) => ({ name: job.name, status: "queued" })),
    owner: currentProcessOwner(),
    logPath: join(dataDirectory(), "builds", id, "build.log"),
    event: { type: "manual_run", id },
  };

  try {
    await (
      dependencies.housekeepingBarrier ?? ((callback) => withImageLock("housekeeping", callback))
    )(() => dependencies.createBuild(record));
    const success = await dependencies.runInTart(
      repository,
      sha,
      config,
      record,
      {
        started: async (job) => {
          record.runningJobs?.push(job.name);
          record.jobs = record.jobs?.map((item) =>
            item.name === job.name ? { ...item, status: "running" } : item,
          );
          await dependencies.saveBuild(record).catch(() => undefined);
        },
        completed: async (job, result) => {
          record.runningJobs = record.runningJobs?.filter((name) => name !== job.name);
          record.jobs = record.jobs?.map((item) =>
            item.name === job.name ? { ...item, status: result.outcome } : item,
          );
          await dependencies.saveBuild(record).catch(() => undefined);
        },
      },
      undefined,
      options.runtimeSecrets,
      configuredVmJobs,
    );
    record.status = success ? "success" : "failure";
    record.completedAt = new Date().toISOString();
    await dependencies.saveBuild(record);
    return record;
  } catch (error) {
    record.status = "failure";
    record.runningJobs = [];
    record.jobs = record.jobs?.map((job) =>
      job.status === "queued" || job.status === "running" ? { ...job, status: "failure" } : job,
    );
    record.completedAt = new Date().toISOString();
    await dependencies.saveBuild(record).catch(() => undefined);
    throw error;
  }
}

export async function runCommit(
  github: GitHubClient,
  repository: Repository,
  sha: string,
  branch: string,
  config: InformantConfig,
  dependencies: CoordinatorDependencies = defaultDependencies,
  event?: RunEvent,
  signal?: AbortSignal,
): Promise<BuildRecord | false | undefined> {
  const usesCapabilities = config.jobs.some(
    (job) => (job.runsOn?.length ?? 0) > 0 || job.runtime?.type === "host",
  );
  const manualTrigger =
    event?.type === "comment"
      ? false
      : await github.hasPendingManualTrigger(repository, sha, event?.branch, branch);
  const hasTriggers =
    (config.triggers?.length ?? 0) > 0 || config.jobs.some((job) => job.triggers !== undefined);
  const selected =
    !manualTrigger && event && hasTriggers
      ? selectTriggeredJobs(config, (rule) => triggerMatches(rule, event), event.branch)
      : config;
  const capabilities = usesCapabilities ? workerCapabilities() : [];
  const untriggeredCapable = usesCapabilities ? selectCapableJobs(config, capabilities) : config;
  const capable = usesCapabilities ? selectCapableJobs(selected, capabilities) : selected;
  let partitions: JobConfig[][];
  if (manualTrigger && usesCapabilities) {
    const byLabels = new Map<string, JobConfig[]>();
    for (const job of capable.jobs) {
      const key = [...(job.runsOn ?? [])].sort().join("\0");
      const jobs = byLabels.get(key) ?? [];
      jobs.push(job);
      byLabels.set(key, jobs);
    }
    partitions = [...byLabels.values()];
  } else {
    partitions = manualTrigger ? [capable.jobs] : partitionJobGraphs(capable.jobs);
  }
  const jobsByLabels = new Map<string, JobConfig[]>();
  for (const job of untriggeredCapable.jobs) {
    const key = [...(job.runsOn ?? [])].sort().join("\0");
    const jobs = jobsByLabels.get(key) ?? [];
    jobs.push(job);
    jobsByLabels.set(key, jobs);
  }
  const results = await Promise.all(
    partitions.map((jobs) => {
      const baseScope = `${event?.type ?? "commit"}:${event?.id ?? sha}`;
      const labelKeys = new Set<string>();
      for (const job of jobs) {
        labelKeys.add([...(job.runsOn ?? [])].sort().join("\0"));
      }
      const previousScopes = [...labelKeys].map((key) => {
        const previousJobs =
          jobsByLabels.get(key) ??
          jobs.filter((job) => [...(job.runsOn ?? [])].sort().join("\0") === key);
        if (!usesCapabilities) return baseScope;
        const jobsScope = Buffer.from(
          previousJobs
            .map((job) => job.name)
            .sort()
            .join("\0"),
        ).toString("base64url");
        return event
          ? `${baseScope}:jobs:${Buffer.from(key).toString("base64url")}:jobs:${jobsScope}`
          : `${baseScope}:jobs:${jobsScope}`;
      });
      return runCommitPartition(
        github,
        repository,
        sha,
        branch,
        { ...capable, jobs },
        dependencies,
        event,
        signal,
        jobs.map((job) => job.name),
        !manualTrigger,
        manualTrigger ? [] : previousScopes,
      );
    }),
  );
  return aggregatePartitionResults(results);
}

async function runCommitPartition(
  github: GitHubClient,
  repository: Repository,
  sha: string,
  branch: string,
  config: InformantConfig,
  dependencies: CoordinatorDependencies,
  event?: RunEvent,
  signal?: AbortSignal,
  scopeJobs?: string[],
  requireRunSlot = false,
  legacyScopes: string[] = [],
): Promise<BuildRecord | false | undefined> {
  if (config.jobs.length === 0) return undefined;
  const release = requireRunSlot ? await acquireRunSlot(signal) : undefined;
  if (requireRunSlot && !release) return false;
  try {
    return await runCommitPartitionWithSlot(
      github,
      repository,
      sha,
      branch,
      config,
      dependencies,
      event,
      signal,
      scopeJobs,
      !requireRunSlot,
      legacyScopes,
    );
  } finally {
    release?.();
  }
}

async function runCommitPartitionWithSlot(
  github: GitHubClient,
  repository: Repository,
  sha: string,
  branch: string,
  config: InformantConfig,
  dependencies: CoordinatorDependencies,
  event?: RunEvent,
  signal?: AbortSignal,
  scopeJobs?: string[],
  acceptManualTrigger = true,
  legacyScopes: string[] = [],
): Promise<BuildRecord | false | undefined> {
  const id = crypto.randomUUID().slice(0, 12);
  const machine = `${hostname()}:${process.pid}:${id}`;
  const configuredVmJobs = config.jobs
    .filter((job) => job.runtime?.type !== "container" && job.runtime?.type !== "host")
    .map((job) => job.name);
  const scopedEvent =
    event && scopeJobs
      ? {
          ...event,
          id: `${event.id}:jobs:${Buffer.from([...scopeJobs].sort().join("\0")).toString("base64url")}`,
        }
      : event;
  const claim = await github.claim(
    repository,
    sha,
    machine,
    scopedEvent
      ? { type: scopedEvent.type, id: scopedEvent.id, branch: scopedEvent.branch, label: branch }
      : undefined,
    scopeJobs,
    acceptManualTrigger,
    legacyScopes,
    acceptManualTrigger,
  );
  if (acceptManualTrigger && claim && !claim.manualTrigger) return false;
  if (claim?.retry) return false;
  if (!claim?.check) return undefined;
  const { check } = claim;
  const rerunPullRequest = claim.originalPullRequest;
  if (rerunPullRequest !== undefined) branch = `pull/${rerunPullRequest}`;
  else if (claim.manualTrigger && claim.manualTriggerLabel) branch = claim.manualTriggerLabel;
  else if (claim.manualTrigger && typeof claim.manualTriggerBranch === "string")
    branch = claim.manualTriggerBranch;
  const executionSignal = claim.manualTrigger ? undefined : signal;
  const selectionBranch =
    rerunPullRequest !== undefined || claim.manualTriggerBranch === null
      ? undefined
      : (claim.manualTriggerBranch ?? event?.branch);
  config = claim.manualTrigger
    ? selectManuallyTriggeredJobs(config, claim.requestedJobs, selectionBranch)
    : event
      ? selectTriggeredJobs(config, (rule) => triggerMatches(rule, event), event.branch)
      : config;
  if (config.jobs.length === 0) {
    await github.updateCheck(repository, check.id, {
      status: "completed",
      conclusion: "neutral",
      title: "No jobs matched",
      summary: `No jobs are configured for this ${event?.type ?? "manual"} event.`,
      text: check.output?.text,
    });
    return undefined;
  }

  type CheckUpdate = Parameters<GitHubClient["updateCheck"]>[2];
  interface JobCheckState {
    check: CheckRun;
    job: JobConfig;
    desired?: CheckUpdate;
    terminal: boolean;
    progressLog?: string;
    progressTimer?: ReturnType<typeof setTimeout>;
    progressInFlight?: Promise<void>;
    lastProgressAt: number;
  }
  const jobChecks = new Map<string, JobCheckState>();

  const record: BuildRecord = {
    id,
    repo: repository.fullName,
    sha,
    branch,
    machine: hostname(),
    startedAt: new Date().toISOString(),
    status: "running",
    runningJobs: [],
    jobs: config.jobs.map((job) => ({ name: job.name, status: "queued" })),
    owner: currentProcessOwner(),
    pullRequest: rerunPullRequest ?? event?.pullRequest?.number,
    logPath: join(dataDirectory(), "builds", id, "build.log"),
    checkId: check.id,
    checkUrl: check.html_url,
    event: claim.manualTrigger
      ? { type: "manual_trigger", id: check.id.toString() }
      : event
        ? { type: event.type, id: event.id }
        : { type: "manual", id: check.id.toString() },
  };
  const cancelledValues = (name: string): CheckUpdate => ({
    status: "completed",
    conclusion: "cancelled",
    title: `${name} cancelled`,
    summary: executionSignal?.aborted
      ? String(executionSignal.reason || "Superseded by a newer commit.")
      : "The build stopped before this job completed.",
  });
  const completedValues = (job: JobConfig, outcome: JobOutcome, log: string): CheckUpdate => {
    const optionalFailure = outcome === "failure" && job.optional;
    return {
      status: "completed",
      conclusion: optionalFailure ? "neutral" : outcome,
      title:
        outcome === "success"
          ? `${job.name} passed`
          : outcome === "failure"
            ? `${job.name} failed${optionalFailure ? " (optional)" : ""}`
            : outcome === "cancelled"
              ? `${job.name} cancelled`
              : `${job.name} skipped`,
      summary:
        outcome === "skipped"
          ? "Skipped because a dependency failed."
          : outcome === "cancelled"
            ? String(executionSignal?.reason || "The build was cancelled.")
            : optionalFailure
              ? "This optional job failed without failing the build."
              : `Ran on ${record.machine}.`,
      text: log ? `\`\`\`text\n${log}\n\`\`\`` : undefined,
    };
  };
  const updateJob = async (state: JobCheckState, values: CheckUpdate, terminal = false) => {
    if (terminal) {
      state.desired = values;
      if (state.progressTimer) clearTimeout(state.progressTimer);
      await state.progressInFlight;
    }
    try {
      await github.updateCheck(repository, state.check.id, values);
      if (terminal) state.terminal = true;
    } catch {
      // Reconciled after execution; reporting must not alter dependency results.
    }
  };
  const publishProgress = (state: JobCheckState) => {
    if (state.desired || state.progressInFlight || !state.progressLog) return;
    state.lastProgressAt = Date.now();
    const log = state.progressLog;
    const pending = updateJob(state, {
      title: `${state.job.name} is running`,
      summary: `Running on ${record.machine}. Logs update about every 10 seconds.`,
      text: `\`\`\`text\n${log}\n\`\`\``,
    }).finally(() => {
      if (state.progressInFlight !== pending) return;
      state.progressInFlight = undefined;
      if (!state.desired && state.progressLog !== log)
        queueProgress(state, state.progressLog ?? "");
    });
    state.progressInFlight = pending;
  };
  const queueProgress = (state: JobCheckState, log: string) => {
    state.progressLog = log;
    if (state.desired || state.progressTimer) return;
    const delay = Math.max(0, CHECK_LOG_UPDATE_INTERVAL_MS - (Date.now() - state.lastProgressAt));
    state.progressTimer = setTimeout(() => {
      state.progressTimer = undefined;
      publishProgress(state);
    }, delay);
  };
  const reconcileJobChecks = async () => {
    for (const state of jobChecks.values()) {
      state.desired ??= cancelledValues(state.job.name);
      if (state.progressTimer) clearTimeout(state.progressTimer);
      await state.progressInFlight;
      if (!state.terminal) {
        try {
          await github.updateCheck(repository, state.check.id, state.desired);
          state.terminal = true;
        } catch {
          // The correlated remote listing below resolves lost responses and retries active checks.
        }
      }
    }

    if (
      jobChecks.size === config.jobs.length &&
      [...jobChecks.values()].every((state) => state.terminal)
    ) {
      return;
    }

    const remoteChecks = await github.jobChecks(repository, sha, check.id);
    const localById = new Map([...jobChecks.values()].map((state) => [state.check.id, state]));
    for (const remote of remoteChecks) {
      const state = localById.get(remote.id);
      if (
        remote.status === "completed" &&
        (!state || remote.conclusion === state.desired?.conclusion)
      ) {
        if (state) state.terminal = true;
        continue;
      }
      const values = state?.desired ?? cancelledValues(remote.name.replace(/^Informant \/ /, ""));
      await github.updateCheck(repository, remote.id, values);
      if (state) state.terminal = true;
    }

    const unsettled = [...jobChecks.values()].filter((state) => !state.terminal);
    if (unsettled.length > 0) {
      throw new Error(
        `Could not update checks for: ${unsettled.map((state) => state.job.name).join(", ")}.`,
      );
    }
  };

  const completeAggregate = async (values: CheckUpdate) => {
    const preservedValues = check.output?.text
      ? { ...values, text: [values.text, check.output.text].filter(Boolean).join("\n") }
      : values;
    try {
      await github.updateCheck(repository, check.id, preservedValues);
    } catch (firstError) {
      try {
        const remote = (await github.checks(repository, sha)).find((item) => item.id === check.id);
        if (remote?.status === "completed" && remote.conclusion === values.conclusion) return;
        await github.updateCheck(repository, check.id, preservedValues);
      } catch (retryError) {
        const first = firstError instanceof Error ? firstError : new Error(String(firstError));
        const retry = retryError instanceof Error ? retryError : new Error(String(retryError));
        throw new AggregateError(
          [first, retry],
          `Could not complete the aggregate check: ${first.message}; retry failed: ${retry.message}`,
        );
      }
    }
    record.checksCompletedAt = new Date().toISOString();
    await dependencies.saveBuild(record).catch(() => undefined);
  };

  let childrenReconciled = false;
  let executionFinished = false;
  try {
    await (
      dependencies.housekeepingBarrier ?? ((callback) => withImageLock("housekeeping", callback))
    )(() => dependencies.createBuild(record));
    let executionError: unknown;
    let success = false;
    try {
      for (const job of config.jobs) {
        const jobCheck = await github.createJobCheck(repository, sha, check.id, job.name);
        jobChecks.set(job.name, {
          check: jobCheck,
          job,
          terminal: false,
          lastProgressAt: 0,
        });
      }

      const runtimeSecrets: RuntimeSecrets = config.jobs.some((job) =>
        job.secrets.includes("GITHUB_TOKEN"),
      )
        ? { GITHUB_TOKEN: () => github.createJobAccessToken(repository) }
        : {};
      success = await dependencies.runInTart(
        repository,
        sha,
        config,
        record,
        {
          started: async (job) => {
            const state = jobChecks.get(job.name);
            if (!state) return;
            record.runningJobs?.push(job.name);
            record.jobs = record.jobs?.map((item) =>
              item.name === job.name ? { ...item, status: "running" } : item,
            );
            await dependencies.saveBuild(record).catch(() => undefined);
            await updateJob(state, {
              status: "in_progress",
              title: `${job.name} is running`,
              summary: `Running on ${record.machine}.`,
            });
          },
          progress: (job, log) => {
            const state = jobChecks.get(job.name);
            if (state) queueProgress(state, log);
          },
          completed: async (job, result) => {
            const state = jobChecks.get(job.name);
            if (!state) return;
            record.runningJobs = record.runningJobs?.filter((name) => name !== job.name);
            record.jobs = record.jobs?.map((item) =>
              item.name === job.name ? { ...item, status: result.outcome } : item,
            );
            await dependencies.saveBuild(record).catch(() => undefined);
            await updateJob(state, completedValues(job, result.outcome, result.log), true);
          },
        },
        executionSignal,
        runtimeSecrets,
        configuredVmJobs,
      );
    } catch (error) {
      executionError = error;
    }

    if (executionSignal?.aborted) {
      record.status = "cancelled";
      record.runningJobs = [];
      record.jobs = record.jobs?.map((job) =>
        job.status === "queued" || job.status === "running" ? { ...job, status: "cancelled" } : job,
      );
      record.completedAt = new Date().toISOString();
      executionFinished = true;
      await dependencies.saveBuild(record);
      for (const state of jobChecks.values()) {
        state.desired = cancelledValues(state.job.name);
        state.terminal = false;
      }
      let childError: unknown;
      try {
        await reconcileJobChecks().catch(() => reconcileJobChecks());
        childrenReconciled = true;
      } catch (error) {
        childError = error;
      }
      let aggregateError: unknown;
      try {
        await completeAggregate({
          status: "completed",
          conclusion: "cancelled",
          title: "Superseded by a newer commit",
          summary: String(executionSignal.reason || "This build was cancelled."),
        });
      } catch (error) {
        aggregateError = error;
      }
      if (childError || aggregateError) {
        throw new AggregateError(
          [childError, aggregateError].filter((error) => error instanceof Error),
          "The build was cancelled, but one or more GitHub checks could not be updated.",
        );
      }
      return record;
    }
    await reconcileJobChecks().catch(() => reconcileJobChecks());
    childrenReconciled = true;
    if (executionError) throw executionError;

    record.status = success ? "success" : "failure";
    record.completedAt = new Date().toISOString();
    const outcomes = [...jobChecks.values()].map((state) => state.desired?.conclusion);
    const passed = outcomes.filter((outcome) => outcome === "success").length;
    const failed = outcomes.filter((outcome) => outcome === "failure").length;
    const optionalFailures = outcomes.filter((outcome) => outcome === "neutral").length;
    const skipped = outcomes.filter((outcome) => outcome === "skipped").length;
    executionFinished = true;
    await dependencies.saveBuild(record).catch(() => undefined);
    await completeAggregate({
      status: "completed",
      conclusion: success ? "success" : "failure",
      title: success
        ? optionalFailures > 0
          ? "All required jobs passed"
          : "All jobs passed"
        : "A job failed",
      summary: `${passed} passed, ${failed} failed, ${optionalFailures} optional failure${optionalFailures === 1 ? "" : "s"}, and ${skipped} skipped on ${record.machine}.`,
    });
  } catch (error) {
    if (executionFinished) throw error;
    record.status = "failure";
    record.runningJobs = [];
    record.jobs = record.jobs?.map((job) =>
      job.status === "queued" || job.status === "running" ? { ...job, status: "failure" } : job,
    );
    record.completedAt = new Date().toISOString();
    await dependencies.saveBuild(record).catch(() => undefined);
    let reportingError: unknown;
    if (!childrenReconciled) {
      try {
        await reconcileJobChecks();
        childrenReconciled = true;
      } catch (reconciliationError) {
        reportingError = reconciliationError;
      }
    }
    if (childrenReconciled) {
      try {
        await completeAggregate({
          status: "completed",
          conclusion: "failure",
          title: "Informant failed to run",
          summary: error instanceof Error ? error.message : String(error),
        });
      } catch (aggregateError) {
        reportingError = aggregateError;
      }
    }
    if (reportingError) {
      const original = error instanceof Error ? error : new Error(String(error));
      const reporting =
        reportingError instanceof Error ? reportingError : new Error(String(reportingError));
      throw new AggregateError(
        [original, reporting],
        `${original.message}; additionally, GitHub reporting failed: ${reporting.message}`,
      );
    }
    throw error;
  } finally {
    await dependencies.saveBuild(record).catch(() => undefined);
  }
  return record;
}
