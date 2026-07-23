import { CONFIG_FILE, parseConfig } from "./config.ts";
import { runCommit } from "./coordinator.ts";
import { GitHubClient } from "./github.ts";
import { readPollState, savePollState } from "./poll-state.ts";
import { triggerMatches } from "./triggers.ts";
import type { Repository } from "./types.ts";

const COMMENT_CURSOR_OVERLAP_MS = 1_000;
const SEEN_COMMENT_LIMIT = 1_000;

export interface ServerOptions {
  once?: boolean;
  signal?: AbortSignal;
  onMessage?: (message: string) => void;
}

export async function serve(repository: Repository, options: ServerOptions = {}): Promise<void> {
  const github = new GitHubClient({ repository });
  let intervalSeconds = 20;
  let lastPollError: string | undefined;
  const message = options.onMessage ?? console.log;
  do {
    try {
      const defaultBranch = await github.defaultBranch(repository);
      const defaultSha = await github.branchHead(repository, defaultBranch);
      const bootstrap = parseConfig(
        await github.fileContent(repository, defaultSha, CONFIG_FILE),
        `${repository.fullName}/${CONFIG_FILE}`,
      );
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
        if (options.signal?.aborted) return;
        const context = {
          type: "commit" as const,
          branch: target.pullRequest ? undefined : target.branch,
          pullRequest: target.pullRequest,
        };
        try {
          const config = parseConfig(
            await github.fileContent(repository, target.sha, CONFIG_FILE),
            `${repository.fullName}/${CONFIG_FILE}@${target.sha.slice(0, 7)}`,
          );
          const matches = config.jobs.some((job) =>
            (job.triggers ?? config.triggers ?? []).some((rule) => triggerMatches(rule, context)),
          );
          if (!matches && !(await hasPendingManualRequest(target.sha))) continue;
          const build = await runCommit(
            github,
            repository,
            target.sha,
            target.branch,
            config,
            undefined,
            { ...context, id: target.eventId },
          );
          if (build)
            message(`${build.status} ${build.id} ${target.branch}@${target.sha.slice(0, 7)}`);
        } catch (error) {
          message(
            `${target.branch}@${target.sha.slice(0, 7)} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
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
          const config = parseConfig(
            await github.fileContent(repository, pending.sha, CONFIG_FILE),
            `${repository.fullName}/${CONFIG_FILE}@${pending.sha.slice(0, 7)}`,
          );
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
          message(
            `comment ${pending.id} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      lastPollError = undefined;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const pollError =
        detail.startsWith("GitHub 404:") && detail.includes("rest/repos/contents")
          ? `waiting for ${CONFIG_FILE}`
          : detail.startsWith("GitHub 409:") && detail.includes("rest/git/refs")
            ? "waiting for the repository's first commit"
            : `poll failed: ${detail}`;
      if (pollError !== lastPollError) message(pollError);
      lastPollError = pollError;
    }
    if (options.once) return;
    await Bun.sleep(intervalSeconds * 1_000);
  } while (!options.signal?.aborted);
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
