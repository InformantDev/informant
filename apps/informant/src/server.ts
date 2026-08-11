import { CONFIG_FILE, JOBS_DIRECTORY, parseConfigFiles, selectTriggeredJobs } from "./config.ts";
import {
  reconcilePreparedContainerImageReferences,
  type startAppleContainerSystem,
} from "./container.ts";
import { containerBackendReadiness, refreshSelectedContainerBackend } from "./container-backend.ts";
import { runCommit } from "./coordinator.ts";
import { GitHubApiError, GitHubClient } from "./github.ts";
import {
  formatHousekeepingSummary,
  runHousekeeping,
  updateCacheConfiguration,
} from "./housekeeping.ts";
import { listRepositories } from "./machine-config.ts";
import { readPollState, savePollState } from "./poll-state.ts";
import { listActiveBuilds, listAllBuilds, saveBuild } from "./store.ts";
import { reconcilePreparedImageReferences } from "./tart/images.ts";
import { type EventContext, triggerMatches } from "./triggers.ts";
import type { BuildRecord, InformantConfig, Repository } from "./types.ts";

const COMMENT_CURSOR_OVERLAP_MS = 1_000;
const SEEN_COMMENT_LIMIT = 1_000;
const TAG_POLL_INTERVAL_MS = 5 * 60_000;
const REPOSITORY_REFRESH_INTERVAL_MS = 5_000;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 24 * 60 * 60_000;
const MISSING_CONFIG_TTL_MS = 24 * 60 * 60_000;
const MISSING_CONFIG_LIMIT = 256;

class MissingRepositoryConfigError extends Error {}

async function waitForAbortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
  sleep?: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
  if (signal?.aborted) return false;
  if (!signal) {
    await (sleep ?? Bun.sleep)(milliseconds);
    return true;
  }
  if (sleep) {
    let stopWaiting!: () => void;
    const aborted = new Promise<false>((resolve) => {
      stopWaiting = () => resolve(false);
      signal.addEventListener("abort", stopWaiting, { once: true });
    });
    try {
      return await Promise.race([sleep(milliseconds).then(() => true as const), aborted]);
    } finally {
      signal.removeEventListener("abort", stopWaiting);
    }
  }
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => finish(true), milliseconds);
    const abort = () => finish(false);
    const finish = (elapsed: boolean) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      resolve(elapsed);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function unexpiredMissingConfigs(
  entries: Array<{ sha: string; checkedAt: string }>,
  now = Date.now(),
) {
  return entries.filter((entry) => {
    const checkedAt = Date.parse(entry.checkedAt);
    return Number.isFinite(checkedAt) && now - checkedAt < MISSING_CONFIG_TTL_MS;
  });
}

function boundMissingConfigs(
  entries: Array<{ sha: string; checkedAt: string }>,
  retainedShas: ReadonlySet<string>,
) {
  const retained: typeof entries = [];
  const stale: typeof entries = [];
  for (const entry of entries) {
    (retainedShas.has(entry.sha) ? retained : stale).push(entry);
  }
  return [...stale.slice(-MISSING_CONFIG_LIMIT), ...retained];
}

async function repositoryConfig(
  github: GitHubClient,
  repository: Repository,
  sha: string,
  signal?: AbortSignal,
) {
  const source = await github.fileContent(repository, sha, CONFIG_FILE, signal);
  const paths = await github.directoryFiles(repository, sha, JOBS_DIRECTORY, signal);
  return parseConfigFiles(
    source,
    await Promise.all(
      paths.map(async (path) => ({
        path,
        source: await github.fileContent(repository, sha, path, signal),
      })),
    ),
    `${repository.fullName}/${CONFIG_FILE}@${sha.slice(0, 7)}`,
  );
}

export interface ServerOptions {
  once?: boolean;
  signal?: AbortSignal;
  onMessage?: (message: string) => void;
  onIdle?: () => Promise<void> | void;
  shutdownTimeoutMs?: number;
  dependencies?: ServerDependencies;
}

export interface ServerDependencies {
  github?: GitHubClient;
  repositoryConfig?: (
    github: GitHubClient,
    repository: Repository,
    sha: string,
    signal?: AbortSignal,
  ) => Promise<InformantConfig>;
  runCommit?: typeof runCommit;
  readPollState?: typeof readPollState;
  savePollState?: typeof savePollState;
  recoverInterruptedBuilds?: typeof recoverInterruptedBuilds;
  startAppleContainerSystem?: typeof startAppleContainerSystem;
  initializeContainerBackend?: (signal?: AbortSignal) => Promise<boolean>;
  housekeeping?: typeof runHousekeeping;
  updateCacheConfiguration?: typeof updateCacheConfiguration;
  reconcilePreparedImageReferences?: typeof reconcilePreparedImageReferences;
  reconcilePreparedContainerImageReferences?: typeof reconcilePreparedContainerImageReferences;
  listRepositories?: () => Promise<Repository[]>;
  serveRepository?: (repository: Repository, options?: ServerOptions) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
}

function persistedCheckId(build: BuildRecord): number | undefined {
  if (Number.isSafeInteger(build.checkId) && (build.checkId ?? 0) > 0) return build.checkId;
  const match = build.checkUrl?.match(/\/runs\/(\d+)(?:[/?#]|$)/);
  if (!match) return undefined;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export async function recoverInterruptedBuilds(
  github: GitHubClient,
  repository: Repository,
  onMessage: (message: string) => void = console.log,
  dependencies: {
    listActiveBuilds: typeof listActiveBuilds;
    listAllBuilds: typeof listAllBuilds;
    saveBuild: typeof saveBuild;
  } = { listActiveBuilds, listAllBuilds, saveBuild },
): Promise<boolean> {
  await dependencies.listActiveBuilds();
  const builds = (await dependencies.listAllBuilds()).filter(
    (build) =>
      build.repo.toLowerCase() === repository.fullName.toLowerCase() &&
      build.status !== "running" &&
      !build.checksCompletedAt &&
      persistedCheckId(build) !== undefined,
  );
  let retry = false;
  for (const build of builds) {
    if (build.status === "running") continue;
    const checkId = persistedCheckId(build);
    if (!checkId) continue;
    try {
      const recovered = await github.recoverInterruptedCheck(
        repository,
        build.sha,
        checkId,
        build.status,
      );
      build.checkId = checkId;
      build.checksCompletedAt = new Date().toISOString();
      await dependencies.saveBuild(build);
      if (recovered) onMessage(`recovered interrupted build ${build.id}`);
    } catch (error) {
      retry = true;
      onMessage(
        `could not recover interrupted build ${build.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return retry;
}

export function applySecretPolicy(
  config: InformantConfig,
  trusted: InformantConfig,
  trustedSha: string,
): InformantConfig {
  const trustedSecretJobs = trusted.jobs.filter((job) => job.secrets.length > 0);
  const allTrustedByName = new Map(trusted.jobs.map((job) => [job.name, job]));
  const trustedByName = new Map<string, (typeof trusted.jobs)[number]>();
  const includeTrustedJob = (name: string) => {
    if (trustedByName.has(name)) return;
    const job = allTrustedByName.get(name);
    if (!job) return;
    trustedByName.set(name, job);
    for (const dependency of job.needs) includeTrustedJob(dependency);
  };
  for (const job of trustedSecretJobs) includeTrustedJob(job.name);
  const trustedSecretNames = new Set(trustedSecretJobs.map((job) => job.name));
  const blocked = new Set<string>();
  for (const job of config.jobs) {
    if (job.secrets.length > 0 && !trustedSecretNames.has(job.name)) {
      if (allTrustedByName.has(job.name)) includeTrustedJob(job.name);
      else blocked.add(job.name);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const job of config.jobs) {
      if (!blocked.has(job.name) && job.needs.some((dependency) => blocked.has(dependency))) {
        blocked.add(job.name);
        changed = true;
      }
    }
  }
  const included = new Set<string>();
  const jobs = config.jobs
    .filter((job) => !blocked.has(job.name))
    .map((job) => {
      const trustedJob = trustedByName.get(job.name);
      if (!trustedJob) return job;
      included.add(job.name);
      return trustedJob;
    });
  for (const job of trustedByName.values()) {
    if (!included.has(job.name)) jobs.push(job);
  }
  return {
    ...config,
    vm: trustedSecretJobs.length > 0 ? trusted.vm : config.vm,
    jobs,
    trustedSha,
  };
}

export async function serve(repository: Repository, options: ServerOptions = {}): Promise<void> {
  const dependencies = options.dependencies ?? {};
  const github = dependencies.github ?? new GitHubClient({ repository });
  const loadRepositoryConfig = dependencies.repositoryConfig ?? repositoryConfig;
  const executeCommit = dependencies.runCommit ?? runCommit;
  const loadPollState = dependencies.readPollState ?? readPollState;
  const persistPollState = dependencies.savePollState ?? savePollState;
  const recoverBuilds = dependencies.recoverInterruptedBuilds ?? recoverInterruptedBuilds;
  let intervalSeconds = 30;
  let lastPollError: string | undefined;
  let rateLimitUntil = 0;
  const configs = new Map<string, Promise<InformantConfig | undefined>>();
  const inFlightRuns = new Map<string, Promise<void>>();
  const automaticLanes = new Map<string, { sha: string; controller: AbortController }>();
  const shutdownControllers = new Set<AbortController>();
  const admissionControllers = new Set<AbortController>();
  const completedComments = new Set<number>();
  const completedTags = new Set<string>();
  const message = options.onMessage ?? console.log;
  const idle = () => {
    if (inFlightRuns.size > 0 || !options.onIdle) return;
    void Promise.resolve(options.onIdle()).catch((error) => {
      message(`housekeeping failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  let recoveryPending = true;
  const configAt = (
    sha: string,
    state: Awaited<ReturnType<typeof readPollState>>,
    missingConfigShas: Set<string>,
    onMissingConfig: () => Promise<void> | void,
  ) => {
    const now = Date.now();
    if (missingConfigShas.has(sha)) return Promise.resolve(undefined);
    const cached = configs.get(sha);
    if (cached) return cached;
    const pending = loadRepositoryConfig(github, repository, sha, options.signal).catch(
      async (error) => {
        if (error instanceof GitHubApiError && error.status === 404) {
          state.missingConfigs = [
            ...(state.missingConfigs ?? []).filter((entry) => entry.sha !== sha),
            { sha, checkedAt: new Date(now).toISOString() },
          ];
          missingConfigShas.add(sha);
          await onMissingConfig();
          return undefined;
        }
        throw error;
      },
    );
    configs.set(sha, pending);
    void pending.then(
      (config) => {
        if (!config && configs.get(sha) === pending) configs.delete(sha);
      },
      () => {
        if (configs.get(sha) === pending) configs.delete(sha);
      },
    );
    return pending;
  };
  const errorDetail = (error: unknown) => {
    if (error instanceof GitHubApiError && error.retryAt) {
      rateLimitUntil = Math.max(rateLimitUntil, error.retryAt);
      return `GitHub API rate limit reached; retrying after ${new Date(error.retryAt).toLocaleTimeString()}`;
    }
    return error instanceof Error ? error.message : String(error);
  };
  const abortInFlightRuns = () => {
    for (const controller of shutdownControllers) {
      controller.abort("Graceful worker shutdown timed out.");
    }
    shutdownControllers.clear();
    automaticLanes.clear();
  };
  const abortAdmissions = () => {
    for (const controller of admissionControllers) {
      controller.abort(options.signal?.reason ?? "Worker shutdown requested.");
    }
    admissionControllers.clear();
  };
  const waitForDelay = (milliseconds: number) =>
    waitForAbortableDelay(milliseconds, options.signal, dependencies.sleep);
  const drainRuns = async () => {
    await Promise.allSettled(inFlightRuns.values());
    if (completedComments.size > 0 || completedTags.size > 0) {
      const completed = new Set(completedComments);
      const completedTagEvents = new Set(completedTags);
      const state = await loadPollState(repository.fullName);
      state.pending = state.pending.filter((item) => !completed.has(item.id));
      state.pendingTags = state.pendingTags.filter(
        (item) => !completedTagEvents.has(`tag:${item.name}:${item.sha}`),
      );
      await persistPollState(repository.fullName, state);
      for (const id of completed) completedComments.delete(id);
      for (const id of completedTagEvents) completedTags.delete(id);
    }
  };
  const drainForShutdown = async (pendingDrain?: Promise<void>) => {
    abortAdmissions();
    const draining = pendingDrain ?? drainRuns();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<false>((resolve) => {
      timeout = setTimeout(
        () => resolve(false),
        options.shutdownTimeoutMs ?? GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      );
    });
    if ((await Promise.race([draining.then(() => true as const), expired])) === true) {
      if (timeout) clearTimeout(timeout);
      return;
    }
    abortInFlightRuns();
    await draining;
  };
  const drainOnce = async () => {
    const draining = drainRuns();
    const signal = options.signal;
    if (!signal) {
      await draining;
      return;
    }
    if (signal.aborted) {
      await drainForShutdown(draining);
      return;
    }
    let onAbort = () => {};
    const shutdownRequested = new Promise<true>((resolve) => {
      onAbort = () => resolve(true);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      if (await Promise.race([draining.then(() => false as const), shutdownRequested])) {
        await drainForShutdown(draining);
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  };
  do {
    if (recoveryPending) {
      try {
        recoveryPending = await recoverBuilds(github, repository, message);
      } catch (error) {
        if (options.signal?.aborted) {
          await drainForShutdown();
          return;
        }
        message(
          `could not scan interrupted builds: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (rateLimitUntil > Date.now() && !(await waitForDelay(rateLimitUntil - Date.now()))) {
      await drainForShutdown();
      return;
    }
    try {
      const state = await loadPollState(repository.fullName);
      state.missingConfigs = unexpiredMissingConfigs(state.missingConfigs ?? []);
      const missingConfigShas = new Set(state.missingConfigs.map((entry) => entry.sha));
      let missingConfigsDirty = false;
      const persistState = async () => {
        await persistPollState(repository.fullName, state);
        missingConfigsDirty = false;
      };
      const flushMissingConfigs = async () => {
        if (missingConfigsDirty) await persistState();
      };
      const markMissingConfig = async (persistImmediately = false) => {
        missingConfigsDirty = true;
        if (persistImmediately) await persistState();
      };
      const defaultBranch = await github.defaultBranch(repository, options.signal);
      const defaultSha = await github.branchHead(repository, defaultBranch, options.signal);
      const bootstrap = await configAt(defaultSha, state, missingConfigShas, () =>
        markMissingConfig(true),
      );
      if (!bootstrap) throw new MissingRepositoryConfigError();
      const storageReferences = await Promise.allSettled([
        (dependencies.reconcilePreparedImageReferences ?? reconcilePreparedImageReferences)(
          repository.fullName,
          bootstrap.jobs
            .filter(
              (job) =>
                job.runtime?.type !== "container" &&
                job.runtime?.type !== "host" &&
                (job.runtime?.type === "vm" ? job.runtime.prepare : bootstrap.vm.prepare),
            )
            .map((job) => job.name),
          options.signal,
        ),
        (
          dependencies.reconcilePreparedContainerImageReferences ??
          reconcilePreparedContainerImageReferences
        )(
          repository.fullName,
          bootstrap.jobs
            .filter((job) => job.runtime?.type === "container" && job.runtime.prepare)
            .map((job) => job.name),
          options.signal,
        ),
        (dependencies.updateCacheConfiguration ?? updateCacheConfiguration)(
          repository.fullName,
          bootstrap.jobs.filter((job) => (job.cache?.length ?? 0) > 0).map((job) => job.name),
        ),
      ]);
      const removedStorageReferences = storageReferences.reduce(
        (sum, result) => sum + (result.status === "fulfilled" ? result.value : 0),
        0,
      );
      for (const result of storageReferences) {
        if (result.status === "rejected") {
          message(
            `could not reconcile storage references: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
          );
        }
      }
      if (removedStorageReferences > 0) idle();
      intervalSeconds = bootstrap.pollIntervalSeconds;
      const hasTagTriggers = bootstrap.jobs.some((job) =>
        (job.triggers ?? bootstrap.triggers ?? []).some((rule) => rule.tag !== undefined),
      );
      const shouldPollTags =
        hasTagTriggers &&
        (!state.tagsPolledAt ||
          Date.now() - new Date(state.tagsPolledAt).getTime() >= TAG_POLL_INTERVAL_MS);
      const [branches, tags, prs] = await Promise.all([
        github.branches(repository, options.signal),
        shouldPollTags ? github.tags(repository, options.signal) : undefined,
        github.pullRequests(repository, options.signal),
      ]);
      const retainedConfigShas = new Set([
        defaultSha,
        ...branches.map((branch) => branch.sha),
        ...prs.filter((pr) => pr.sameRepository).map((pr) => pr.headSha),
        ...state.pendingTags.map((tag) => tag.sha),
        ...state.pending.map((comment) => comment.sha),
      ]);
      state.missingConfigs = boundMissingConfigs(state.missingConfigs, retainedConfigShas);
      missingConfigShas.clear();
      for (const entry of state.missingConfigs) missingConfigShas.add(entry.sha);
      const completedTagEvents = new Set(completedTags);
      if (completedTagEvents.size > 0) {
        state.pendingTags = state.pendingTags.filter(
          (item) => !completedTagEvents.has(`tag:${item.name}:${item.sha}`),
        );
      }
      if (tags) {
        if (state.tagRefs !== undefined) {
          const previous = new Set(state.tagRefs.map((tag) => `${tag.name}\0${tag.sha}`));
          const pending = new Set(state.pendingTags.map((tag) => `${tag.name}\0${tag.sha}`));
          for (const tag of tags) {
            const key = `${tag.name}\0${tag.sha}`;
            if (!previous.has(key) && !pending.has(key)) {
              state.pendingTags.push(tag);
              pending.add(key);
            }
          }
        }
        state.tagRefs = tags;
        state.tagsPolledAt = new Date().toISOString();
      }
      await persistState();
      for (const id of completedTagEvents) completedTags.delete(id);
      const openBranchLanes = new Set(branches.map((branch) => `branch:${branch.name}`));
      const openPullRequestLanes = new Set(prs.map((pr) => `pr:${pr.number}`));
      for (const [lane, active] of automaticLanes) {
        if (lane.startsWith("branch:") && !openBranchLanes.has(lane)) {
          active.controller.abort(`Branch ${lane.slice(7)} no longer exists.`);
          automaticLanes.delete(lane);
        } else if (lane.startsWith("pr:") && !openPullRequestLanes.has(lane)) {
          active.controller.abort(`Pull request #${lane.slice(3)} is no longer open.`);
          automaticLanes.delete(lane);
        }
      }
      const manualTriggers = new Map<string, Promise<boolean>>();
      const hasPendingManualTrigger = (sha: string, branch: string | undefined, label: string) => {
        const key = `${sha}\0${branch ?? ""}\0${label}`;
        let pending = manualTriggers.get(key);
        if (!pending) {
          pending = github.hasPendingManualTrigger(repository, sha, branch, label, options.signal);
          manualTriggers.set(key, pending);
        }
        return pending;
      };
      for (const target of [
        ...branches.map((branch) => ({
          sha: branch.sha,
          branch: branch.name,
          pullRequest: undefined,
          eventId: `branch:${branch.name}:${branch.sha}`,
          lane: `branch:${branch.name}`,
        })),
        ...prs
          .filter((pr) => pr.sameRepository)
          .map((pullRequest) => ({
            sha: pullRequest.headSha,
            branch: `pull/${pullRequest.number}`,
            pullRequest,
            eventId: `pr:${pullRequest.number}:${pullRequest.headSha}`,
            lane: `pr:${pullRequest.number}`,
          })),
        ...state.pendingTags.map((tag) => ({
          sha: tag.sha,
          branch: tag.name,
          tag: tag.name,
          pullRequest: undefined,
          eventId: `tag:${tag.name}:${tag.sha}`,
          lane: `tag:${tag.name}`,
        })),
      ]) {
        if (options.signal?.aborted) {
          await flushMissingConfigs();
          await drainForShutdown();
          return;
        }
        const previous = automaticLanes.get(target.lane);
        if (!("tag" in target) && previous && previous.sha !== target.sha) {
          previous.controller.abort(`Superseded by ${target.branch}@${target.sha.slice(0, 7)}.`);
          automaticLanes.delete(target.lane);
        }
        if (inFlightRuns.has(target.eventId)) continue;
        const context: EventContext = {
          type: "commit" as const,
          branch: target.pullRequest || "tag" in target ? undefined : target.branch,
          tag: "tag" in target && typeof target.tag === "string" ? target.tag : undefined,
          pullRequest: target.pullRequest,
        };
        try {
          const targetConfig = await configAt(
            target.sha,
            state,
            missingConfigShas,
            markMissingConfig,
          );
          if (!targetConfig) continue;
          const config = applySecretPolicy(targetConfig, bootstrap, defaultSha);
          const matches =
            selectTriggeredJobs(config, (rule) => triggerMatches(rule, context), context.branch)
              .jobs.length > 0;
          if (!matches) {
            if (!(await hasPendingManualTrigger(target.sha, context.branch, target.branch))) {
              if ("tag" in target) {
                state.pendingTags = state.pendingTags.filter(
                  (item) => item.name !== target.tag || item.sha !== target.sha,
                );
                await persistState();
              }
              continue;
            }
          }
          if (options.signal?.aborted) {
            await flushMissingConfigs();
            await drainForShutdown();
            return;
          }
          const controller = new AbortController();
          const admissionController = new AbortController();
          admissionControllers.add(admissionController);
          if (!("tag" in target)) {
            automaticLanes.set(target.lane, { sha: target.sha, controller });
          }
          const result = executeCommit(
            github,
            repository,
            target.sha,
            target.branch,
            config,
            undefined,
            {
              ...context,
              id: target.eventId,
            },
            controller.signal,
            admissionController.signal,
          );
          shutdownControllers.add(controller);
          const run = result
            .then((build) => {
              if (build)
                message(`${build.status} ${build.id} ${target.branch}@${target.sha.slice(0, 7)}`);
              if (
                "tag" in target &&
                build !== false &&
                (!build || (build.event?.id === target.eventId && build.status !== "cancelled"))
              ) {
                completedTags.add(target.eventId);
              }
            })
            .catch((error) => {
              message(`${target.branch}@${target.sha.slice(0, 7)} failed: ${errorDetail(error)}`);
            })
            .finally(() => {
              inFlightRuns.delete(target.eventId);
              shutdownControllers.delete(controller);
              admissionControllers.delete(admissionController);
              if (
                !("tag" in target) &&
                automaticLanes.get(target.lane)?.controller === controller
              ) {
                automaticLanes.delete(target.lane);
              }
              idle();
            });
          inFlightRuns.set(target.eventId, run);
        } catch (error) {
          message(`${target.branch}@${target.sha.slice(0, 7)} failed: ${errorDetail(error)}`);
        }
      }
      await flushMissingConfigs();

      if (completedComments.size > 0) {
        const completed = new Set(completedComments);
        state.pending = state.pending.filter((item) => !completed.has(item.id));
        await persistState();
        for (const id of completed) completedComments.delete(id);
      }
      if (!state.cursor) {
        const latest = await github.latestPullRequestComments(repository, 100, options.signal);
        state.cursor = latest.reduce(
          (cursor, comment) => (comment.updatedAt > cursor ? comment.updatedAt : cursor),
          new Date(0).toISOString(),
        );
        state.seenCommentIds = latest.map((comment) => comment.id);
        await persistState();
      } else {
        const previousCursor = state.cursor;
        const overlap = new Date(
          new Date(previousCursor).getTime() - COMMENT_CURSOR_OVERLAP_MS,
        ).toISOString();
        const comments = await github.pullRequestComments(repository, overlap, options.signal);
        const known = new Set([...state.seenCommentIds, ...state.pending.map((item) => item.id)]);
        for (const comment of comments) {
          if (comment.updatedAt > state.cursor) state.cursor = comment.updatedAt;
          if (known.has(comment.id) || comment.createdAt < overlap) continue;
          known.add(comment.id);
          state.seenCommentIds.push(comment.id);
          let pr = prs.find((item) => item.number === comment.pullRequestNumber);
          if (!pr) {
            try {
              pr = await github.pullRequest(repository, comment.pullRequestNumber, options.signal);
            } catch (error) {
              if (error instanceof Error && error.message.startsWith("GitHub 404")) continue;
              throw error;
            }
          }
          if (pr.sameRepository)
            state.pending.push({
              id: comment.id,
              sha: pr.headSha,
              createdAt: comment.createdAt,
              pullRequest: pr,
            });
        }
        state.seenCommentIds = state.seenCommentIds.slice(-SEEN_COMMENT_LIMIT);
        await persistState();
      }
      for (const pending of [...state.pending]) {
        const eventId = `pr:${pending.pullRequest.number}:comment:${pending.id}`;
        if (inFlightRuns.has(eventId)) continue;
        try {
          const pendingConfig = await configAt(
            pending.sha,
            state,
            missingConfigShas,
            markMissingConfig,
          );
          if (!pendingConfig) continue;
          const config = applySecretPolicy(pendingConfig, bootstrap, defaultSha);
          const context: EventContext & { id: string } = {
            type: "comment" as const,
            pullRequest: pending.pullRequest,
            id: eventId,
          };
          const matches =
            selectTriggeredJobs(config, (rule) => triggerMatches(rule, context), context.branch)
              .jobs.length > 0;
          if (!matches) {
            state.pending = state.pending.filter((item) => item.id !== pending.id);
            await persistState();
            continue;
          }
          if (options.signal?.aborted) {
            await flushMissingConfigs();
            await drainForShutdown();
            return;
          }
          const controller = new AbortController();
          const admissionController = new AbortController();
          admissionControllers.add(admissionController);
          const result = executeCommit(
            github,
            repository,
            pending.sha,
            `pull/${pending.pullRequest.number}`,
            config,
            undefined,
            context,
            controller.signal,
            admissionController.signal,
          );
          shutdownControllers.add(controller);
          const run = result
            .then((result) => {
              if (result !== false) completedComments.add(pending.id);
            })
            .catch((error) => {
              message(`comment ${pending.id} failed: ${errorDetail(error)}`);
            })
            .finally(() => {
              inFlightRuns.delete(eventId);
              shutdownControllers.delete(controller);
              admissionControllers.delete(admissionController);
              idle();
            });
          inFlightRuns.set(eventId, run);
        } catch (error) {
          message(`comment ${pending.id} failed: ${errorDetail(error)}`);
        }
      }
      await flushMissingConfigs();
      lastPollError = undefined;
    } catch (error) {
      if (options.signal?.aborted) {
        await drainForShutdown();
        return;
      }
      const detail = errorDetail(error);
      const pollError =
        error instanceof MissingRepositoryConfigError ||
        (detail.startsWith("GitHub 404:") && detail.includes("rest/repos/contents"))
          ? `waiting for ${CONFIG_FILE}`
          : detail.startsWith("GitHub 409:") && detail.includes("rest/git/refs")
            ? "waiting for the repository's first commit"
            : `poll failed: ${detail}`;
      if (pollError !== lastPollError) message(pollError);
      lastPollError = pollError;
    }
    if (options.once) {
      await drainOnce();
      return;
    }
    if (!(await waitForDelay(intervalSeconds * 1_000))) {
      await drainForShutdown();
      return;
    }
  } while (!options.signal?.aborted);
  await drainForShutdown();
}

export async function serveRepositories(
  repositories: Repository[],
  options: ServerOptions = {},
): Promise<void> {
  if (options.dependencies?.initializeContainerBackend) {
    await options.dependencies.initializeContainerBackend(options.signal);
  } else if (options.dependencies?.startAppleContainerSystem) {
    await options.dependencies.startAppleContainerSystem();
  } else {
    const ready = await refreshSelectedContainerBackend(options.signal);
    const status = containerBackendReadiness();
    if (!ready && status) {
      options.onMessage?.(
        `${status.backend.name} unavailable; container jobs will not be claimed: ${status.error?.message ?? "not ready"}`,
      );
    }
  }
  let configuredRepositories = repositories;
  const performHousekeeping = options.dependencies?.housekeeping ?? runHousekeeping;
  let pendingHousekeeping: Promise<void> | undefined;
  let housekeepingRequested = false;
  const clean = () => {
    housekeepingRequested = true;
    pendingHousekeeping ??= (async () => {
      while (housekeepingRequested) {
        housekeepingRequested = false;
        try {
          const summary = await performHousekeeping(configuredRepositories);
          const result = formatHousekeepingSummary(summary);
          if (result) options.onMessage?.(result);
        } catch (error) {
          options.onMessage?.(
            `housekeeping failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    })().finally(async () => {
      pendingHousekeeping = undefined;
      if (housekeepingRequested) await clean();
    });
    return pendingHousekeeping;
  };
  await clean();
  const validateOwners = (configured: Repository[]) => {
    const owners = new Set(configured.map((repository) => repository.owner.toLowerCase()));
    const hasEnvironmentCredentials = Boolean(
      Bun.env.INFORMANT_GITHUB_TOKEN ||
        Bun.env.GITHUB_TOKEN ||
        Bun.env.INFORMANT_GITHUB_APP_ID ||
        Bun.env.INFORMANT_GITHUB_INSTALLATION_ID ||
        Bun.env.INFORMANT_GITHUB_PRIVATE_KEY ||
        Bun.env.INFORMANT_GITHUB_PRIVATE_KEY_FILE,
    );
    if (owners.size > 1 && hasEnvironmentCredentials && !Bun.env.INFORMANT_GITHUB_ACCOUNT) {
      throw new Error(
        "INFORMANT_GITHUB_ACCOUNT is required when environment credentials serve multiple repository owners",
      );
    }
  };
  validateOwners(configuredRepositories);

  const onIdle = async () => {
    await clean();
    await options.onIdle?.();
  };
  const serveRepository = options.dependencies?.serveRepository ?? serve;
  const repositoryOptions = (repository: Repository, signal = options.signal): ServerOptions => ({
    ...options,
    signal,
    onIdle,
    onMessage: (message) => options.onMessage?.(`${repository.fullName} · ${message}`),
  });
  if (options.once) {
    await Promise.all(
      repositories.map((repository) => serveRepository(repository, repositoryOptions(repository))),
    );
    return;
  }

  const loadRepositories = options.dependencies?.listRepositories ?? listRepositories;
  const workers = new Map<
    string,
    { repository: Repository; controller: AbortController; task: Promise<void> }
  >();
  const waitForRefresh = () =>
    waitForAbortableDelay(
      REPOSITORY_REFRESH_INTERVAL_MS,
      options.signal,
      options.dependencies?.sleep,
    );
  const reconcile = (configured: Repository[]) => {
    const next = new Map(
      configured.map((repository) => [repository.fullName.toLowerCase(), repository]),
    );
    for (const [key, worker] of workers) {
      if (!next.has(key) && !worker.controller.signal.aborted) {
        worker.controller.abort(`${worker.repository.fullName} is no longer registered.`);
      }
    }
    for (const [key, repository] of next) {
      if (workers.has(key)) continue;
      const controller = new AbortController();
      const stop = () => controller.abort(options.signal?.reason);
      if (options.signal?.aborted) stop();
      else options.signal?.addEventListener("abort", stop, { once: true });
      let task!: Promise<void>;
      task = serveRepository(repository, repositoryOptions(repository, controller.signal))
        .catch((error) => {
          if (!controller.signal.aborted) {
            options.onMessage?.(
              `${repository.fullName} · worker stopped: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        })
        .finally(() => {
          options.signal?.removeEventListener("abort", stop);
          if (workers.get(key)?.task === task) workers.delete(key);
        });
      workers.set(key, { repository, controller, task });
    }
  };

  let lastRefreshError: string | undefined;
  try {
    if (!options.signal?.aborted) reconcile(repositories);
    while (await waitForRefresh()) {
      try {
        const configured = await loadRepositories();
        if (options.signal?.aborted) break;
        validateOwners(configured);
        configuredRepositories = configured;
        reconcile(configured);
        lastRefreshError = undefined;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (detail !== lastRefreshError) {
          options.onMessage?.(`could not refresh repository registrations: ${detail}`);
          lastRefreshError = detail;
        }
      }
    }
  } finally {
    for (const worker of workers.values()) {
      worker.controller.abort(options.signal?.reason ?? "Worker shutdown requested.");
    }
    await Promise.allSettled([...workers.values()].map((worker) => worker.task));
  }
}
