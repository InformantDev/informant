import { hostname } from "node:os";
import { join } from "node:path";
import { selectJobs, selectTriggeredJobs } from "./config.ts";
import type { GitHubClient } from "./github.ts";
import { createBuild, dataDirectory, saveBuild } from "./store.ts";
import { type JobOutcome, type RuntimeSecrets, runInTart } from "./tart/index.ts";
import { type EventContext, triggerMatches } from "./triggers.ts";
import type { BuildRecord, CheckRun, InformantConfig, JobConfig, Repository } from "./types.ts";

type RunEvent = (EventContext | { type: "manual" }) & { id: string };

export interface CoordinatorDependencies {
  createBuild: typeof createBuild;
  saveBuild: typeof saveBuild;
  runInTart: typeof runInTart;
  readLogTail: (path: string) => Promise<string>;
}

const CHECK_LOG_CHARACTERS = 55_000;
const CHECK_LOG_BYTES = CHECK_LOG_CHARACTERS * 4;
const CHECK_LOG_UPDATE_INTERVAL_MS = 10_000;

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
  const id = crypto.randomUUID().slice(0, 12);
  const machine = `${hostname()}:${process.pid}:${id}`;
  const claim = await github.claim(
    repository,
    sha,
    machine,
    event ? { type: event.type, id: event.id } : undefined,
  );
  if (claim?.retry) return false;
  if (!claim?.check) return undefined;
  const { check } = claim;
  const executionSignal = claim.manualRequest ? undefined : signal;
  config = claim.manualRequest
    ? selectJobs(config, claim.requestedJobs)
    : event && event.type !== "manual"
      ? selectTriggeredJobs(config, (rule) => triggerMatches(rule, event))
      : config;
  if (config.jobs.length === 0) {
    await github.updateCheck(repository, check.id, {
      status: "completed",
      conclusion: "neutral",
      title: "No jobs matched",
      summary: `No jobs are configured for this ${event?.type ?? "manual"} event.`,
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
    logPath: join(dataDirectory(), "builds", id, "build.log"),
    checkUrl: check.html_url,
    event: claim.manualRequest
      ? { type: "manual", id: check.id.toString() }
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
  const completedValues = (job: JobConfig, outcome: JobOutcome, log: string): CheckUpdate => ({
    status: "completed",
    conclusion: outcome,
    title:
      outcome === "success"
        ? `${job.name} passed`
        : outcome === "failure"
          ? `${job.name} failed`
          : outcome === "cancelled"
            ? `${job.name} cancelled`
            : `${job.name} skipped`,
    summary:
      outcome === "skipped"
        ? "Skipped because a dependency failed."
        : outcome === "cancelled"
          ? String(executionSignal?.reason || "The build was cancelled.")
          : `Ran on ${record.machine}.`,
    text: log ? `\`\`\`text\n${log}\n\`\`\`` : undefined,
  });
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
    try {
      await github.updateCheck(repository, check.id, values);
    } catch (firstError) {
      try {
        const remote = (await github.checks(repository, sha)).find((item) => item.id === check.id);
        if (remote?.status === "completed" && remote.conclusion === values.conclusion) return;
        await github.updateCheck(repository, check.id, values);
      } catch (retryError) {
        const first = firstError instanceof Error ? firstError : new Error(String(firstError));
        const retry = retryError instanceof Error ? retryError : new Error(String(retryError));
        throw new AggregateError(
          [first, retry],
          `Could not complete the aggregate check: ${first.message}; retry failed: ${retry.message}`,
        );
      }
    }
  };

  let childrenReconciled = false;
  let executionFinished = false;
  try {
    await dependencies.createBuild(record);
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
            await updateJob(state, completedValues(job, result.outcome, result.log), true);
          },
        },
        executionSignal,
        runtimeSecrets,
      );
    } catch (error) {
      executionError = error;
    }

    if (executionSignal?.aborted) {
      record.status = "cancelled";
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
    const skipped = outcomes.filter((outcome) => outcome === "skipped").length;
    executionFinished = true;
    await completeAggregate({
      status: "completed",
      conclusion: success ? "success" : "failure",
      title: success ? "All jobs passed" : "A job failed",
      summary: `${passed} passed, ${failed} failed, and ${skipped} skipped on ${record.machine}.`,
    });
  } catch (error) {
    if (executionFinished) throw error;
    record.status = "failure";
    record.completedAt = new Date().toISOString();
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
