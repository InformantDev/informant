import { describe, expect, test } from "bun:test";
import type { GitHubClient } from "./github.ts";
import type { PollState } from "./poll-state.ts";
import { applySecretPolicy, type ServerDependencies, serve } from "./server.ts";
import type { BuildRecord, InformantConfig, PullRequest, Repository } from "./types.ts";

const repository: Repository = { owner: "owner", repo: "repo", fullName: "owner/repo" };
const pullRequest: PullRequest = {
  number: 7,
  state: "open",
  draft: false,
  baseBranch: "main",
  headSha: "comment-sha",
  sameRepository: true,
};
const config: InformantConfig = {
  version: 1,
  pollIntervalSeconds: 0,
  triggers: [{ event: "commit" }, { event: "comment" }],
  vm: { image: "image", user: "user", password: "password" },
  jobs: [
    { name: "test", command: "test", timeoutMinutes: 1, environment: {}, secrets: [], needs: [] },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function github(options: {
  branchHead?: () => Promise<string>;
  branches?: () => Promise<Array<{ name: string; sha: string }>>;
  pullRequests?: () => Promise<PullRequest[]>;
  manual?: (sha: string) => Promise<boolean>;
}) {
  return {
    defaultBranch: async () => "main",
    branchHead: options.branchHead ?? (async () => "default-sha"),
    branches: options.branches ?? (async () => []),
    pullRequests: options.pullRequests ?? (async () => []),
    hasPendingManualRequest: async (_repository: Repository, sha: string) =>
      options.manual?.(sha) ?? false,
    latestPullRequestComments: async () => [],
    pullRequestComments: async () => [],
  } as unknown as GitHubClient;
}

function dependencies(
  client: GitHubClient,
  state: PollState,
  execute: NonNullable<ServerDependencies["runCommit"]>,
  sleep: NonNullable<ServerDependencies["sleep"]> = async () => {},
): ServerDependencies {
  return {
    github: client,
    repositoryConfig: async () => config,
    runCommit: execute,
    readPollState: async () => state,
    savePollState: async (_repo, next) => {
      state.cursor = next.cursor;
      state.pending = [...next.pending];
      state.seenCommentIds = [...next.seenCommentIds];
    },
    sleep,
  };
}

describe("serve polling orchestration", () => {
  test("pins secret-bearing jobs and VM configuration to the default branch", () => {
    const configuredJob = config.jobs[0];
    if (!configuredJob) throw new Error("expected a configured job");
    const setupJob = { ...configuredJob, name: "setup", command: "trusted setup" };
    const trustedJob = {
      ...configuredJob,
      name: "review",
      command: "trusted review",
      secrets: ["AMP_API_KEY"],
      needs: ["setup"],
    };
    const trusted = {
      ...config,
      vm: { ...config.vm, image: "trusted-image" },
      jobs: [setupJob, trustedJob],
    };
    const untrusted = {
      ...config,
      vm: { ...config.vm, image: "attacker-image" },
      jobs: [
        { ...setupJob, command: "attacker setup" },
        { ...trustedJob, command: "steal secrets" },
      ],
    };

    expect(applySecretPolicy(untrusted, trusted, "trusted-sha")).toMatchObject({
      trustedSha: "trusted-sha",
      vm: { image: "trusted-image" },
      jobs: [
        { name: "setup", command: "trusted setup", secrets: [] },
        {
          name: "review",
          command: "trusted review",
          secrets: ["AMP_API_KEY"],
          needs: ["setup"],
        },
      ],
    });
    expect(
      applySecretPolicy({ ...untrusted, jobs: [trustedJob] }, trusted, "trusted-sha").jobs,
    ).toEqual([trustedJob, setupJob]);
    expect(() =>
      applySecretPolicy(
        { ...untrusted, jobs: [{ ...trustedJob, name: "steal" }] },
        trusted,
        "trusted-sha",
      ),
    ).toThrow("not authorized on the default branch");
  });

  test("supersedes only the previous automatic lane controller", async () => {
    const outer = new AbortController();
    const first = deferred<BuildRecord | false | undefined>();
    const second = deferred<BuildRecord | false | undefined>();
    const signals: AbortSignal[] = [];
    let poll = 0;
    const client = github({
      branchHead: async () => (poll === 0 ? "sha-one" : "sha-two"),
      branches: async () => [{ name: "main", sha: poll++ === 0 ? "sha-one" : "sha-two" }],
    });
    let sleeps = 0;
    const server = serve(repository, {
      signal: outer.signal,
      dependencies: dependencies(
        client,
        { cursor: "2026-01-01T00:00:00.000Z", pending: [], seenCommentIds: [] },
        async (_github, _repository, _sha, _branch, _config, _deps, _event, signal) => {
          signals.push(signal as AbortSignal);
          return signals.length === 1 ? first.promise : second.promise;
        },
        async () => {
          sleeps++;
          if (sleeps !== 2) return;
          expect(signals).toHaveLength(2);
          expect(signals[0]?.aborted).toBe(true);
          expect(signals[1]?.aborted).toBe(false);
          first.resolve(undefined);
          await Promise.resolve();
          expect(signals[1]?.aborted).toBe(false);
          outer.abort();
          second.resolve(undefined);
        },
      ),
    });

    await server;
    expect(signals[1]?.aborted).toBe(true);
    expect(signals[1]?.reason).toBe("Server shutdown requested.");
  });

  test("cancels an automatic build when its pull request is no longer open", async () => {
    const outer = new AbortController();
    const run = deferred<BuildRecord | false | undefined>();
    let poll = 0;
    let receivedSignal: AbortSignal | undefined;
    const client = github({
      pullRequests: async () => (poll++ === 0 ? [pullRequest] : []),
    });

    await serve(repository, {
      signal: outer.signal,
      dependencies: dependencies(
        client,
        { cursor: "2026-01-01T00:00:00.000Z", pending: [], seenCommentIds: [] },
        async (_github, _repository, _sha, _branch, _config, _deps, _event, signal) => {
          receivedSignal = signal;
          return run.promise;
        },
        async () => {
          if (poll !== 2) return;
          expect(receivedSignal?.aborted).toBe(true);
          expect(receivedSignal?.reason).toBe("Pull request #7 is no longer open.");
          run.resolve(undefined);
          outer.abort();
        },
      ),
    });

    expect(receivedSignal?.aborted).toBe(true);
  });

  test("cancels an automatic build when its branch is deleted", async () => {
    const outer = new AbortController();
    const run = deferred<BuildRecord | false | undefined>();
    let poll = 0;
    let receivedSignal: AbortSignal | undefined;
    const client = github({
      branches: async () => (poll++ === 0 ? [{ name: "topic", sha: "sha" }] : []),
    });

    await serve(repository, {
      signal: outer.signal,
      dependencies: dependencies(
        client,
        { cursor: "2026-01-01T00:00:00.000Z", pending: [], seenCommentIds: [] },
        async (_github, _repository, _sha, _branch, _config, _deps, _event, signal) => {
          receivedSignal = signal;
          return run.promise;
        },
        async () => {
          if (poll !== 2) return;
          expect(receivedSignal?.aborted).toBe(true);
          expect(receivedSignal?.reason).toBe("Branch topic no longer exists.");
          run.resolve(undefined);
          outer.abort();
        },
      ),
    });

    expect(receivedSignal?.aborted).toBe(true);
  });

  test("aborts automatic runs before draining during shutdown", async () => {
    const outer = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const client = github({ branches: async () => [{ name: "main", sha: "sha" }] });

    await serve(repository, {
      signal: outer.signal,
      dependencies: dependencies(
        client,
        { cursor: "2026-01-01T00:00:00.000Z", pending: [], seenCommentIds: [] },
        async (_github, _repository, _sha, _branch, _config, _deps, _event, signal) => {
          receivedSignal = signal;
          return new Promise((resolve) => {
            signal?.addEventListener("abort", () => resolve(undefined), { once: true });
          });
        },
        async () => outer.abort(),
      ),
    });

    expect(receivedSignal?.aborted).toBe(true);
    expect(receivedSignal?.reason).toBe("Server shutdown requested.");
  });

  test("interrupts the polling interval to abort automatic runs on shutdown", async () => {
    const outer = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let releaseSleep!: () => void;
    const sleepStarted = new Promise<void>((resolve) => {
      releaseSleep = resolve;
    });
    const runSettled = deferred<BuildRecord | false | undefined>();
    const server = serve(repository, {
      signal: outer.signal,
      dependencies: dependencies(
        github({ branches: async () => [{ name: "main", sha: "sha" }] }),
        { cursor: "2026-01-01T00:00:00.000Z", pending: [], seenCommentIds: [] },
        async (_github, _repository, _sha, _branch, _config, _deps, _event, signal) => {
          receivedSignal = signal;
          signal?.addEventListener("abort", () => runSettled.resolve(undefined), { once: true });
          return runSettled.promise;
        },
        async () => sleepStarted,
      ),
    });

    await Promise.resolve();
    while (!receivedSignal) await Promise.resolve();
    outer.abort();
    await server;
    releaseSleep();

    expect(receivedSignal.aborted).toBe(true);
    expect(receivedSignal.reason).toBe("Server shutdown requested.");
  });

  test("does not pass an automatic-lane signal to comment runs", async () => {
    const state: PollState = {
      cursor: "2026-01-01T00:00:00.000Z",
      pending: [{ id: 42, sha: pullRequest.headSha, createdAt: "2026-01-01", pullRequest }],
      seenCommentIds: [42],
    };
    let receivedSignal: AbortSignal | undefined;
    await serve(repository, {
      once: true,
      dependencies: dependencies(github({}), state, async (...args) => {
        receivedSignal = args[7];
        return undefined;
      }),
    });

    expect(receivedSignal).toBeUndefined();
    expect(state.pending).toEqual([]);
  });

  test("retains retryable comments and removes successful comments after draining", async () => {
    for (const [result, retained] of [
      [false, true],
      [undefined, false],
    ] as const) {
      const state: PollState = {
        cursor: "2026-01-01T00:00:00.000Z",
        pending: [{ id: 42, sha: pullRequest.headSha, createdAt: "2026-01-01", pullRequest }],
        seenCommentIds: [42],
      };
      await serve(repository, {
        once: true,
        dependencies: dependencies(github({}), state, async () => result),
      });
      expect(state.pending.some((item) => item.id === 42)).toBe(retained);
    }
  });

  test("does not launch the same pending comment during concurrent polls", async () => {
    const outer = new AbortController();
    const run = deferred<BuildRecord | false | undefined>();
    const state: PollState = {
      cursor: "2026-01-01T00:00:00.000Z",
      pending: [{ id: 42, sha: pullRequest.headSha, createdAt: "2026-01-01", pullRequest }],
      seenCommentIds: [42],
    };
    let launches = 0;
    let sleeps = 0;
    await serve(repository, {
      signal: outer.signal,
      dependencies: dependencies(
        github({}),
        state,
        async () => {
          launches++;
          return run.promise;
        },
        async () => {
          if (++sleeps !== 2) return;
          expect(launches).toBe(1);
          outer.abort();
          run.resolve(false);
        },
      ),
    });

    expect(launches).toBe(1);
    expect(state.pending).toHaveLength(1);
  });
});
