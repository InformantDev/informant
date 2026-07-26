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
  vm: { image: "image", guestOs: "macos", user: "user", password: "password" },
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
  tags?: () => Promise<Array<{ name: string; sha: string }>>;
  pullRequests?: () => Promise<PullRequest[]>;
  manual?: (sha: string) => Promise<boolean>;
}) {
  return {
    defaultBranch: async () => "main",
    branchHead: options.branchHead ?? (async () => "default-sha"),
    branches: options.branches ?? (async () => []),
    tags: options.tags ?? (async () => []),
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
      state.tagRefs = next.tagRefs ? [...next.tagRefs] : undefined;
      state.pendingTags = [...next.pendingTags];
    },
    sleep,
  };
}

describe("serve polling orchestration", () => {
  const tagConfig: InformantConfig = {
    ...config,
    triggers: [{ event: "commit", tag: { patterns: ["v*"] } }],
    jobs: config.jobs.map((job) => ({
      ...job,
      triggers: [{ event: "commit", tag: { patterns: ["v*"] } }],
    })),
  };

  test("baselines existing tags on the first poll without launching them", async () => {
    const state: PollState = { pending: [], seenCommentIds: [], pendingTags: [] };
    let launches = 0;
    const deps = dependencies(
      github({ tags: async () => [{ name: "v1", sha: "old" }] }),
      state,
      async () => {
        launches++;
        return undefined;
      },
    );
    deps.repositoryConfig = async () => tagConfig;
    await serve(repository, {
      once: true,
      dependencies: deps,
    });
    expect(launches).toBe(0);
    expect(state.tagRefs).toEqual([{ name: "v1", sha: "old" }]);
    expect(state.tagsPolledAt).toBeDefined();
  });

  test("skips tag enumeration without trusted tag triggers and between tag polls", async () => {
    let tagPolls = 0;
    const client = github({
      tags: async () => {
        tagPolls++;
        return [];
      },
    });
    await serve(repository, {
      once: true,
      dependencies: dependencies(
        client,
        { pending: [], seenCommentIds: [], pendingTags: [] },
        async () => undefined,
      ),
    });
    const state: PollState = {
      pending: [],
      seenCommentIds: [],
      pendingTags: [],
      tagRefs: [],
      tagsPolledAt: new Date().toISOString(),
    };
    const deps = dependencies(client, state, async () => undefined);
    deps.repositoryConfig = async () => tagConfig;
    await serve(repository, { once: true, dependencies: deps });
    expect(tagPolls).toBe(0);
  });

  test("launches new matching tags with tag context and durable acknowledgement", async () => {
    const state: PollState = { pending: [], seenCommentIds: [], pendingTags: [], tagRefs: [] };
    let branch = "";
    let event: unknown;
    const deps = dependencies(
      github({ tags: async () => [{ name: "v2/release", sha: "new-sha" }] }),
      state,
      async (_github, _repository, _sha, displayBranch, _config, _deps, receivedEvent) => {
        branch = displayBranch;
        event = receivedEvent;
        return undefined;
      },
    );
    deps.repositoryConfig = async () => tagConfig;
    await serve(repository, { once: true, dependencies: deps });
    expect(branch).toBe("v2/release");
    expect(event).toMatchObject({
      type: "commit",
      tag: "v2/release",
      branch: undefined,
      id: "tag:v2/release:new-sha",
    });
    expect(state.pendingTags).toEqual([]);
  });

  test("acknowledges nonmatching tags and retains false or rejected matching tags", async () => {
    const nonmatching: PollState = {
      pending: [],
      seenCommentIds: [],
      tagRefs: [],
      pendingTags: [{ name: "notes", sha: "sha" }],
    };
    await serve(repository, {
      once: true,
      dependencies: dependencies(github({}), nonmatching, async () => undefined),
    });
    expect(nonmatching.pendingTags).toEqual([]);

    for (const outcome of ["false", "reject"] as const) {
      const state: PollState = {
        pending: [],
        seenCommentIds: [],
        tagRefs: [],
        pendingTags: [{ name: "v3", sha: "sha" }],
      };
      const deps = dependencies(github({}), state, async () => {
        if (outcome === "reject") throw new Error("temporary");
        return false;
      });
      deps.repositoryConfig = async () => tagConfig;
      await serve(repository, { once: true, dependencies: deps });
      expect(state.pendingTags).toEqual([{ name: "v3", sha: "sha" }]);
    }
  });

  test("retains a tag when a manual request consumes its claim or it is cancelled", async () => {
    for (const event of [
      { type: "manual" as const, id: "manual" },
      { type: "commit" as const, id: "tag:v3:sha" },
    ]) {
      const state: PollState = {
        pending: [],
        seenCommentIds: [],
        tagRefs: [],
        pendingTags: [{ name: "v3", sha: "sha" }],
      };
      const deps = dependencies(github({}), state, async () => {
        return {
          event,
          status: event.type === "manual" ? "success" : "cancelled",
        } as BuildRecord;
      });
      deps.repositoryConfig = async () => tagConfig;
      await serve(repository, { once: true, dependencies: deps });
      expect(state.pendingTags).toEqual([{ name: "v3", sha: "sha" }]);
    }
  });

  test("does not cancel durable tag events when the same tag moves", async () => {
    const state: PollState = {
      pending: [],
      seenCommentIds: [],
      tagRefs: [{ name: "v4", sha: "old" }],
      pendingTags: [{ name: "v4", sha: "old" }],
    };
    const signals: Array<AbortSignal | undefined> = [];
    const events: string[] = [];
    const deps = dependencies(
      github({ tags: async () => [{ name: "v4", sha: "new" }] }),
      state,
      async (_github, _repository, _sha, _branch, _config, _deps, event, signal) => {
        signals.push(signal);
        events.push(event?.id ?? "");
        return undefined;
      },
    );
    deps.repositoryConfig = async () => tagConfig;
    await serve(repository, { once: true, dependencies: deps });
    expect(events).toEqual(["tag:v4:old", "tag:v4:new"]);
    expect(signals).toEqual([undefined, undefined]);
    expect(state.pendingTags).toEqual([]);
  });

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
      vm: { image: "trusted-image", guestOs: "macos" },
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
        { cursor: "2026-01-01T00:00:00.000Z", pending: [], seenCommentIds: [], pendingTags: [] },
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
        { cursor: "2026-01-01T00:00:00.000Z", pending: [], seenCommentIds: [], pendingTags: [] },
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
        { cursor: "2026-01-01T00:00:00.000Z", pending: [], seenCommentIds: [], pendingTags: [] },
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
        { cursor: "2026-01-01T00:00:00.000Z", pending: [], seenCommentIds: [], pendingTags: [] },
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
        { cursor: "2026-01-01T00:00:00.000Z", pending: [], seenCommentIds: [], pendingTags: [] },
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
      pendingTags: [],
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
        pendingTags: [],
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
      pendingTags: [],
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
