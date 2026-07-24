import { CONFIG_FILE, JOBS_DIRECTORY, parseConfigFiles } from "./config.ts";
import { runCommit } from "./coordinator.ts";
import { GitHubApiError, GitHubClient } from "./github.ts";
import { readPollState, savePollState } from "./poll-state.ts";
import { triggerMatches } from "./triggers.ts";
import type { Repository } from "./types.ts";

const COMMENT_CURSOR_OVERLAP_MS = 1_000;
const SEEN_COMMENT_LIMIT = 1_000;

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
}

export async function serve(repository: Repository, options: ServerOptions = {}): Promise<void> {
  const github = new GitHubClient({ repository });
  let intervalSeconds = 30;
  let lastPollError: string | undefined;
  let rateLimitUntil = 0;
  const configs = new Map<string, ReturnType<typeof repositoryConfig>>();
  const inFlightRuns = new Map<string, Promise<void>>();
  const message = options.onMessage ?? console.log;
  const configAt = (sha: string) => {
    const cached = configs.get(sha);
    if (cached) return cached;
    const pending = repositoryConfig(github, repository, sha);
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
  const drainRuns = async () => {
    await Promise.allSettled(inFlightRuns.values());
  };
  do {
    if (rateLimitUntil > Date.now()) await Bun.sleep(rateLimitUntil - Date.now());
    try {
      const defaultBranch = await github.defaultBranch(repository);
      const defaultSha = await github.branchHead(repository, defaultBranch);
      const bootstrap = await configAt(defaultSha);
      intervalSeconds = bootstrap.pollIntervalSeconds;
      const [branches, prs] = await Promise.all([
        github.branches(repository),
        github.pullRequests(repository),
      ]);
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
        })),
        ...prs
          .filter((pr) => pr.sameRepository)
          .map((pullRequest) => ({
            sha: pullRequest.headSha,
            branch: `pull/${pullRequest.number}`,
            pullRequest,
            eventId: `pr:${pullRequest.number}:${pullRequest.headSha}`,
          })),
      ]) {
        if (options.signal?.aborted) {
          await drainRuns();
          return;
        }
        if (inFlightRuns.has(target.eventId)) continue;
        const context = {
          type: "commit" as const,
          branch: target.pullRequest ? undefined : target.branch,
          pullRequest: target.pullRequest,
        };
        try {
          const config = await configAt(target.sha);
          const matches = config.jobs.some((job) =>
            (job.triggers ?? config.triggers ?? []).some((rule) => triggerMatches(rule, context)),
          );
          if (!matches && !(await hasPendingManualRequest(target.sha))) continue;
          const run = runCommit(github, repository, target.sha, target.branch, config, undefined, {
            ...context,
            id: target.eventId,
          })
            .then((build) => {
              if (build)
                message(`${build.status} ${build.id} ${target.branch}@${target.sha.slice(0, 7)}`);
            })
            .catch((error) => {
              message(`${target.branch}@${target.sha.slice(0, 7)} failed: ${errorDetail(error)}`);
            })
            .finally(() => {
              inFlightRuns.delete(target.eventId);
            });
          inFlightRuns.set(target.eventId, run);
        } catch (error) {
          message(`${target.branch}@${target.sha.slice(0, 7)} failed: ${errorDetail(error)}`);
        }
      }

      const state = await readPollState(repository.fullName);
      if (!state.cursor) {
        const latest = await github.latestPullRequestComments(repository);
        state.cursor = latest.reduce(
          (cursor, comment) => (comment.updatedAt > cursor ? comment.updatedAt : cursor),
          new Date(0).toISOString(),
        );
        state.seenCommentIds = latest.map((comment) => comment.id);
        await savePollState(repository.fullName, state);
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
        await savePollState(repository.fullName, state);
      }
      for (const pending of [...state.pending]) {
        try {
          const config = await configAt(pending.sha);
          const context = {
            type: "comment" as const,
            pullRequest: pending.pullRequest,
            id: `pr:${pending.pullRequest.number}:comment:${pending.id}`,
          };
          if (
            config.jobs.some((job) =>
              (job.triggers ?? config.triggers ?? []).some((rule) => triggerMatches(rule, context)),
            )
          ) {
            const result = await runCommit(
              github,
              repository,
              pending.sha,
              `pull/${pending.pullRequest.number}`,
              config,
              undefined,
              context,
            );
            if (result === false) continue;
          }
          state.pending = state.pending.filter((item) => item.id !== pending.id);
          await savePollState(repository.fullName, state);
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
    await Bun.sleep(intervalSeconds * 1_000);
  } while (!options.signal?.aborted);
  await drainRuns();
}

export async function serveRepositories(
  repositories: Repository[],
  options: ServerOptions = {},
): Promise<void> {
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
