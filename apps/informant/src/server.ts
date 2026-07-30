import { CONFIG_FILE, JOBS_DIRECTORY, parseConfigFiles } from "./config.ts";
import { startAppleContainerSystem } from "./container.ts";
import { runCommit } from "./coordinator.ts";
import { GitHubApiError, GitHubClient } from "./github.ts";
import { readPollState, savePollState } from "./poll-state.ts";
import { listActiveBuilds, listAllBuilds, saveBuild } from "./store.ts";
import { triggerMatches } from "./triggers.ts";
import type { BuildRecord, InformantConfig, Repository } from "./types.ts";

const COMMENT_CURSOR_OVERLAP_MS = 1_000;
const SEEN_COMMENT_LIMIT = 1_000;
const TAG_POLL_INTERVAL_MS = 5 * 60_000;

async function repositoryConfig(github: GitHubClient, repository: Repository, sha: string) {
  const source = await github.fileContent(repository, sha, CONFIG_FILE);
  const paths = await github.directoryFiles(repository, sha, JOBS_DIRECTORY);
  return parseConfigFiles(
    source,
    await Promise.all(
      paths.map(async (path) => ({
        path,
        source: await github.fileContent(repository, sha, path),
      })),
    ),
    `${repository.fullName}/${CONFIG_FILE}@${sha.slice(0, 7)}`,
  );
}

export interface ServerOptions {
  once?: boolean;
  signal?: AbortSignal;
  onMessage?: (message: string) => void;
  dependencies?: ServerDependencies;
}

export interface ServerDependencies {
  github?: GitHubClient;
  repositoryConfig?: (
    github: GitHubClient,
    repository: Repository,
    sha: string,
  ) => Promise<InformantConfig>;
  runCommit?: typeof runCommit;
  readPollState?: typeof readPollState;
  savePollState?: typeof savePollState;
  recoverInterruptedBuilds?: typeof recoverInterruptedBuilds;
  startAppleContainerSystem?: typeof startAppleContainerSystem;
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
  const sleep = dependencies.sleep ?? Bun.sleep;
  let intervalSeconds = 30;
  let lastPollError: string | undefined;
  let rateLimitUntil = 0;
  const configs = new Map<string, ReturnType<typeof repositoryConfig>>();
  const inFlightRuns = new Map<string, Promise<void>>();
  const automaticLanes = new Map<string, { sha: string; controller: AbortController }>();
  const completedComments = new Set<number>();
  const completedTags = new Set<string>();
  const message = options.onMessage ?? console.log;
  let recoveryPending = true;
  const configAt = (sha: string) => {
    const cached = configs.get(sha);
    if (cached) return cached;
    const pending = loadRepositoryConfig(github, repository, sha);
    configs.set(sha, pending);
    void pending.catch(() => {
      if (configs.get(sha) === pending) configs.delete(sha);
    });
    return pending;
  };
  const errorDetail = (error: unknown) => {
    if (error instanceof GitHubApiError && error.retryAt) {
      rateLimitUntil = Math.max(rateLimitUntil, error.retryAt);
      return `GitHub API rate limit reached; retrying after ${new Date(error.retryAt).toLocaleTimeString()}`;
    }
    return error instanceof Error ? error.message : String(error);
  };
  const abortAutomaticRuns = () => {
    for (const { controller } of automaticLanes.values()) {
      controller.abort("Server shutdown requested.");
    }
    automaticLanes.clear();
  };
  const waitForDelay = async (milliseconds: number) => {
    if (options.signal?.aborted) return false;
    if (!options.signal) {
      await sleep(milliseconds);
      return true;
    }
    let stopWaiting: (() => void) | undefined;
    const aborted = new Promise<false>((resolve) => {
      stopWaiting = () => resolve(false);
      options.signal?.addEventListener("abort", stopWaiting, { once: true });
    });
    try {
      return await Promise.race([sleep(milliseconds).then(() => true as const), aborted]);
    } finally {
      if (stopWaiting) options.signal.removeEventListener("abort", stopWaiting);
    }
  };
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
  do {
    if (recoveryPending) {
      try {
        recoveryPending = await recoverBuilds(github, repository, message);
      } catch (error) {
        message(
          `could not scan interrupted builds: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (rateLimitUntil > Date.now() && !(await waitForDelay(rateLimitUntil - Date.now()))) {
      abortAutomaticRuns();
      await drainRuns();
      return;
    }
    try {
      const defaultBranch = await github.defaultBranch(repository);
      const defaultSha = await github.branchHead(repository, defaultBranch);
      const bootstrap = await configAt(defaultSha);
      intervalSeconds = bootstrap.pollIntervalSeconds;
      const state = await loadPollState(repository.fullName);
      const hasTagTriggers = bootstrap.jobs.some((job) =>
        (job.triggers ?? bootstrap.triggers ?? []).some((rule) => rule.tag !== undefined),
      );
      const shouldPollTags =
        hasTagTriggers &&
        (!state.tagsPolledAt ||
          Date.now() - new Date(state.tagsPolledAt).getTime() >= TAG_POLL_INTERVAL_MS);
      const [branches, tags, prs] = await Promise.all([
        github.branches(repository),
        shouldPollTags ? github.tags(repository) : undefined,
        github.pullRequests(repository),
      ]);
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
      await persistPollState(repository.fullName, state);
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
      const manualRequests = new Map<string, Promise<boolean>>();
      const hasPendingManualRequest = (sha: string) => {
        let pending = manualRequests.get(sha);
        if (!pending) {
          pending = github.hasPendingManualRequest(repository, sha);
          manualRequests.set(sha, pending);
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
          abortAutomaticRuns();
          await drainRuns();
          return;
        }
        const previous = automaticLanes.get(target.lane);
        if (!("tag" in target) && previous && previous.sha !== target.sha) {
          previous.controller.abort(`Superseded by ${target.branch}@${target.sha.slice(0, 7)}.`);
          automaticLanes.delete(target.lane);
        }
        if (inFlightRuns.has(target.eventId)) continue;
        const context = {
          type: "commit" as const,
          branch: target.pullRequest || "tag" in target ? undefined : target.branch,
          tag: "tag" in target && typeof target.tag === "string" ? target.tag : undefined,
          pullRequest: target.pullRequest,
        };
        try {
          const config = applySecretPolicy(await configAt(target.sha), bootstrap, defaultSha);
          const matches = config.jobs.some((job) =>
            (job.triggers ?? config.triggers ?? []).some((rule) => triggerMatches(rule, context)),
          );
          if (!matches) {
            if ("tag" in target) {
              state.pendingTags = state.pendingTags.filter(
                (item) => item.name !== target.tag || item.sha !== target.sha,
              );
              await persistPollState(repository.fullName, state);
              continue;
            }
            if (!(await hasPendingManualRequest(target.sha))) continue;
          }
          if (options.signal?.aborted) {
            abortAutomaticRuns();
            await drainRuns();
            return;
          }
          const controller = new AbortController();
          if (!("tag" in target)) {
            automaticLanes.set(target.lane, { sha: target.sha, controller });
          }
          const run = executeCommit(
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
            "tag" in target ? undefined : controller.signal,
          )
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
              if (
                !("tag" in target) &&
                automaticLanes.get(target.lane)?.controller === controller
              ) {
                automaticLanes.delete(target.lane);
              }
            });
          inFlightRuns.set(target.eventId, run);
        } catch (error) {
          message(`${target.branch}@${target.sha.slice(0, 7)} failed: ${errorDetail(error)}`);
        }
      }

      if (completedComments.size > 0) {
        const completed = new Set(completedComments);
        state.pending = state.pending.filter((item) => !completed.has(item.id));
        await persistPollState(repository.fullName, state);
        for (const id of completed) completedComments.delete(id);
      }
      if (!state.cursor) {
        const latest = await github.latestPullRequestComments(repository);
        state.cursor = latest.reduce(
          (cursor, comment) => (comment.updatedAt > cursor ? comment.updatedAt : cursor),
          new Date(0).toISOString(),
        );
        state.seenCommentIds = latest.map((comment) => comment.id);
        await persistPollState(repository.fullName, state);
      } else {
        const previousCursor = state.cursor;
        const overlap = new Date(
          new Date(previousCursor).getTime() - COMMENT_CURSOR_OVERLAP_MS,
        ).toISOString();
        const comments = await github.pullRequestComments(repository, overlap);
        const known = new Set([...state.seenCommentIds, ...state.pending.map((item) => item.id)]);
        for (const comment of comments) {
          if (comment.updatedAt > state.cursor) state.cursor = comment.updatedAt;
          if (known.has(comment.id) || comment.createdAt < overlap) continue;
          known.add(comment.id);
          state.seenCommentIds.push(comment.id);
          let pr = prs.find((item) => item.number === comment.pullRequestNumber);
          if (!pr) {
            try {
              pr = await github.pullRequest(repository, comment.pullRequestNumber);
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
        await persistPollState(repository.fullName, state);
      }
      for (const pending of [...state.pending]) {
        const eventId = `pr:${pending.pullRequest.number}:comment:${pending.id}`;
        if (inFlightRuns.has(eventId)) continue;
        try {
          const config = applySecretPolicy(await configAt(pending.sha), bootstrap, defaultSha);
          const context = {
            type: "comment" as const,
            pullRequest: pending.pullRequest,
            id: eventId,
          };
          const matches = config.jobs.some((job) =>
            (job.triggers ?? config.triggers ?? []).some((rule) => triggerMatches(rule, context)),
          );
          if (!matches) {
            state.pending = state.pending.filter((item) => item.id !== pending.id);
            await persistPollState(repository.fullName, state);
            continue;
          }
          if (options.signal?.aborted) {
            abortAutomaticRuns();
            await drainRuns();
            return;
          }
          const run = executeCommit(
            github,
            repository,
            pending.sha,
            `pull/${pending.pullRequest.number}`,
            config,
            undefined,
            context,
          )
            .then((result) => {
              if (result !== false) completedComments.add(pending.id);
            })
            .catch((error) => {
              message(`comment ${pending.id} failed: ${errorDetail(error)}`);
            })
            .finally(() => {
              inFlightRuns.delete(eventId);
            });
          inFlightRuns.set(eventId, run);
        } catch (error) {
          message(`comment ${pending.id} failed: ${errorDetail(error)}`);
        }
      }
      lastPollError = undefined;
    } catch (error) {
      const detail = errorDetail(error);
      const pollError =
        detail.startsWith("GitHub 404:") && detail.includes("rest/repos/contents")
          ? `waiting for ${CONFIG_FILE}`
          : detail.startsWith("GitHub 409:") && detail.includes("rest/git/refs")
            ? "waiting for the repository's first commit"
            : `poll failed: ${detail}`;
      if (pollError !== lastPollError) message(pollError);
      lastPollError = pollError;
    }
    if (options.once) {
      await drainRuns();
      return;
    }
    if (!(await waitForDelay(intervalSeconds * 1_000))) {
      abortAutomaticRuns();
      await drainRuns();
      return;
    }
  } while (!options.signal?.aborted);
  abortAutomaticRuns();
  await drainRuns();
}

export async function serveRepositories(
  repositories: Repository[],
  options: ServerOptions = {},
): Promise<void> {
  await (options.dependencies?.startAppleContainerSystem ?? startAppleContainerSystem)();
  const owners = new Set(repositories.map((repository) => repository.owner.toLowerCase()));
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
  await Promise.all(
    repositories.map((repository) =>
      serve(repository, {
        ...options,
        onMessage: (message) => options.onMessage?.(`${repository.fullName} · ${message}`),
      }),
    ),
  );
}
