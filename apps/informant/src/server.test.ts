import { describe, expect, test } from "bun:test";
import type { GitHubClient } from "./github.ts";
import type { PollState } from "./poll-state.ts";
import {
  applySecretPolicy,
  recoverInterruptedBuilds,
  type ServerDependencies,
  serve,
  serveRepositories,
} from "./server.ts";
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

test("starts Apple Container when the repository worker starts", async () => {
  let starts = 0;
  let cleanups = 0;
  await serveRepositories([], {
    once: true,
    dependencies: {
      startAppleContainerSystem: async () => {
        starts++;
        return true;
      },
      housekeeping: async () => {
        cleanups++;
        return {
          skipped: false,
          builds: 0,
          cacheRepositories: 0,
          cacheJobs: 0,
          cacheVersions: 0,
          sharedCaches: 0,
          tartImages: 0,
          containerImages: 0,
          pressure: false,
        };
      },
    },
  });

  expect(starts).toBe(1);
  expect(cleanups).toBe(1);
});

test("continues serving host jobs when container backend initialization fails", async () => {
  let served = false;
  let readinessSignal: AbortSignal | undefined;
  const controller = new AbortController();
  await serveRepositories([repository], {
    once: true,
    signal: controller.signal,
    dependencies: {
      initializeContainerBackend: async (signal) => {
        readinessSignal = signal;
        return false;
      },
      housekeeping: async () => ({
        skipped: false,
        builds: 0,
        cacheRepositories: 0,
        cacheJobs: 0,
        cacheVersions: 0,
        sharedCaches: 0,
        tartImages: 0,
        containerImages: 0,
        pressure: false,
      }),
      serveRepository: async () => {
        served = true;
      },
    },
  });
  expect(served).toBe(true);
  expect(readinessSignal).toBe(controller.signal);
});

test("refreshes repository registrations without restarting the worker", async () => {
  const outer = new AbortController();
  const added: Repository = { owner: "owner", repo: "added", fullName: "owner/added" };
  const started: string[] = [];
  const stopped: string[] = [];
  let refreshes = 0;

  await serveRepositories([repository], {
    signal: outer.signal,
    dependencies: {
      startAppleContainerSystem: async () => true,
      housekeeping: async () => ({
        skipped: false,
        builds: 0,
        cacheRepositories: 0,
        cacheJobs: 0,
        cacheVersions: 0,
        sharedCaches: 0,
        tartImages: 0,
        containerImages: 0,
        pressure: false,
      }),
      sleep: async () => {},
      listRepositories: async () => {
        refreshes++;
        if (refreshes === 1) return [repository, added];
        if (refreshes === 2) return [added];
        outer.abort();
        return [added];
      },
      serveRepository: async (current, options) => {
        started.push(current.fullName);
        const signal = options?.signal;
        if (!signal) throw new Error("expected a repository abort signal");
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        stopped.push(current.fullName);
      },
    },
  });

  expect(started).toEqual([repository.fullName, added.fullName]);
  expect(stopped).toEqual([repository.fullName, added.fullName]);
});

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
    hasPendingManualTrigger: async (
      _repository: Repository,
      sha: string,
      _branch?: string,
      _label?: string,
    ) => options.manual?.(sha) ?? false,
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
    recoverInterruptedBuilds: async () => false,
    reconcilePreparedImageReferences: async () => 0,
    reconcilePreparedContainerImageReferences: async () => 0,
    updateCacheConfiguration: async () => 0,
    sleep,
  };
}

test("serveRepositories preserves caller idle notifications after housekeeping", async () => {
  const state: PollState = { pending: [], seenCommentIds: [], pendingTags: [] };
  const deps = dependencies(github({}), state, async () => undefined);
  let cleanups = 0;
  let idleNotifications = 0;
  deps.startAppleContainerSystem = async () => true;
  deps.housekeeping = async () => {
    cleanups++;
    return {
      skipped: false,
      builds: 0,
      cacheRepositories: 0,
      cacheJobs: 0,
      cacheVersions: 0,
      sharedCaches: 0,
      tartImages: 0,
      containerImages: 0,
      pressure: false,
    };
  };
  deps.reconcilePreparedImageReferences = async () => 1;

  await serveRepositories([repository], {
    once: true,
    dependencies: deps,
    onIdle: () => {
      idleNotifications++;
    },
  });
  while (idleNotifications === 0) await Bun.sleep(1);

  expect(cleanups).toBe(2);
  expect(idleNotifications).toBe(1);
});

test("serveRepositories reruns housekeeping requested while the current run settles", async () => {
  const summary = {
    skipped: false,
    builds: 0,
    cacheRepositories: 0,
    cacheJobs: 0,
    cacheVersions: 0,
    sharedCaches: 0,
    tartImages: 0,
    containerImages: 0,
    pressure: false,
  };
  const settling = deferred<typeof summary>();
  let cleanups = 0;
  let idle: (() => Promise<void> | void) | undefined;
  const deps: ServerDependencies = {
    startAppleContainerSystem: async () => true,
    housekeeping: () => {
      cleanups++;
      return cleanups === 2 ? settling.promise : Promise.resolve(summary);
    },
    serveRepository: async (_repository, options) => {
      idle = options?.onIdle;
    },
  };

  await serveRepositories([repository], { once: true, dependencies: deps });
  expect(cleanups).toBe(1);
  if (!idle) throw new Error("expected an idle callback");

  const first = Promise.resolve(idle());
  while (cleanups < 2) await Bun.sleep(1);
  settling.resolve(summary);
  const late = new Promise<void>((resolve, reject) => {
    queueMicrotask(() => Promise.resolve(idle?.()).then(() => resolve(), reject));
  });
  await Promise.all([first, late]);

  expect(cleanups).toBe(3);
});

test("startup recovers old URL-only cancelled builds and leaves failures retryable", async () => {
  const recovered: number[] = [];
  const saved: BuildRecord[] = [];
  const messages: string[] = [];
  const builds: BuildRecord[] = [
    {
      id: "interrupted",
      repo: repository.fullName,
      sha: "sha-1",
      branch: "main",
      machine: "machine",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: "cancelled",
      logPath: "/tmp/interrupted.log",
      checkUrl: "https://github.com/owner/repo/runs/123",
    },
    {
      id: "retry",
      repo: repository.fullName,
      sha: "sha-2",
      branch: "main",
      machine: "machine",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: "cancelled",
      logPath: "/tmp/retry.log",
      checkId: 456,
    },
    {
      id: "live",
      repo: repository.fullName,
      sha: "sha-3",
      branch: "main",
      machine: "machine",
      startedAt: new Date().toISOString(),
      status: "running",
      logPath: "/tmp/live.log",
      checkId: 789,
    },
  ];
  const client = {
    recoverInterruptedCheck: async (
      _repository: Repository,
      _sha: string,
      id: number,
      _conclusion: "success" | "failure" | "cancelled",
    ) => {
      recovered.push(id);
      if (id === 456) throw new Error("temporary outage");
      return true;
    },
  } as unknown as GitHubClient;

  const retry = await recoverInterruptedBuilds(
    client,
    repository,
    (message) => messages.push(message),
    {
      listActiveBuilds: async () => [],
      listAllBuilds: async () => builds,
      saveBuild: async (build) => {
        saved.push({ ...build });
      },
    },
  );

  expect(retry).toBe(true);
  expect(recovered).toEqual([123, 456]);
  expect(saved.map((build) => build.id)).toEqual(["interrupted"]);
  expect(saved[0]).toMatchObject({ checkId: 123 });
  expect(saved[0]?.checksCompletedAt).toBeDefined();
  expect(messages).toContain("recovered interrupted build interrupted");
  expect(messages.some((message) => message.includes("temporary outage"))).toBe(true);
  expect(builds[1]?.checksCompletedAt).toBeUndefined();
});

describe("serve polling orchestration", () => {
  const tagConfig: InformantConfig = {
    ...config,
    triggers: [{ event: "commit", tag: { patterns: ["v*"] } }],
    jobs: config.jobs.map((job) => ({
      ...job,
      triggers: [{ event: "commit", tag: { patterns: ["v*"] } }],
    })),
  };

  test("job filters prevent nonmatching automatic events from being claimed", async () => {
    const state: PollState = { pending: [], seenCommentIds: [], pendingTags: [] };
    const launched: string[] = [];
    const deps = dependencies(
      github({
        branches: async () => [
          { name: "main", sha: "main-sha" },
          { name: "feature", sha: "feature-sha" },
        ],
      }),
      state,
      async (_github, _repository, _sha, branch) => {
        launched.push(branch);
        return undefined;
      },
    );
    deps.repositoryConfig = async () => ({
      ...config,
      jobs: config.jobs.map((job) => ({
        ...job,
        filters: [{ branch: { names: ["main"] } }],
      })),
    });

    await serve(repository, { once: true, dependencies: deps });

    expect(launched).toEqual(["main"]);
  });

  test("reconciles only configured caches and prepared runtime jobs", async () => {
    const state: PollState = { pending: [], seenCommentIds: [], pendingTags: [] };
    const deps = dependencies(github({}), state, async () => undefined);
    const baseJob = config.jobs[0];
    if (!baseJob) throw new Error("expected a job");
    deps.repositoryConfig = async () => ({
      ...config,
      vm: { ...config.vm, prepare: "install vm tools" },
      jobs: [
        { ...baseJob, name: "vm" },
        {
          ...baseJob,
          name: "container",
          runtime: { type: "container", image: "base", prepare: "install container tools" },
        },
        {
          ...baseJob,
          name: "plain-container",
          runtime: { type: "container", image: "base" },
        },
        {
          ...baseJob,
          name: "cached",
          cache: [{ paths: ["~/.cache/test"], keyFiles: [], shared: false }],
        },
      ],
    });
    let vmJobs: string[] = [];
    let containerJobs: string[] = [];
    let cacheJobs: string[] = [];
    deps.reconcilePreparedImageReferences = async (_repository, jobs) => {
      vmJobs = jobs;
      return 0;
    };
    deps.reconcilePreparedContainerImageReferences = async (_repository, jobs) => {
      containerJobs = jobs;
      return 0;
    };
    deps.updateCacheConfiguration = async (_repository, jobs) => {
      cacheJobs = jobs;
      return 0;
    };

    await serve(repository, { once: true, dependencies: deps });

    expect(vmJobs).toEqual(["vm", "cached"]);
    expect(containerJobs).toEqual(["container"]);
    expect(cacheJobs).toEqual(["cached"]);
  });

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

  test("retries interrupted-build recovery without blocking polling", async () => {
    const outer = new AbortController();
    let recoveries = 0;
    let polls = 0;
    const deps = dependencies(
      github({
        branches: async () => {
          polls++;
          return [];
        },
      }),
      { pending: [], seenCommentIds: [], pendingTags: [] },
      async () => undefined,
      async () => {
        if (recoveries >= 2) outer.abort();
      },
    );
    deps.recoverInterruptedBuilds = async () => ++recoveries === 1;

    await serve(repository, { signal: outer.signal, dependencies: deps });

    expect(recoveries).toBe(2);
    expect(polls).toBe(2);
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

  test("a pending manual trigger is not discarded with a nonmatching tag", async () => {
    const state: PollState = {
      pending: [],
      seenCommentIds: [],
      tagRefs: [],
      pendingTags: [{ name: "notes", sha: "sha" }],
    };
    let launches = 0;
    const deps = dependencies(github({ manual: async () => true }), state, async () => {
      launches++;
      return { event: { type: "manual_trigger", id: "manual" }, status: "success" } as BuildRecord;
    });

    await serve(repository, { once: true, dependencies: deps });

    expect(launches).toBe(1);
    expect(state.pendingTags).toEqual([{ name: "notes", sha: "sha" }]);
  });

  test("retains a tag when a manual trigger consumes its claim or it is cancelled", async () => {
    for (const event of [
      { type: "manual_trigger" as const, id: "manual" },
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
          status: event.type === "manual_trigger" ? "success" : "cancelled",
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
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal?.aborted === false)).toBe(true);
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
      runtime: { type: "container" as const, image: "trusted-container" },
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
        {
          ...trustedJob,
          command: "steal secrets",
          runtime: { type: "container" as const, image: "attacker-container" },
        },
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
          runtime: { type: "container", image: "trusted-container" },
        },
      ],
    });
    expect(
      applySecretPolicy({ ...untrusted, jobs: [trustedJob] }, trusted, "trusted-sha").jobs,
    ).toEqual([trustedJob, setupJob]);
  });

  test("pins or omits unauthorized secret jobs without blocking independent jobs", () => {
    const configuredJob = config.jobs[0];
    if (!configuredJob) throw new Error("expected a configured job");
    const trustedCoverage = { ...configuredJob, name: "coverage", command: "trusted coverage" };
    const lint = { ...configuredJob, name: "lint", command: "lint pull request" };
    const publish = {
      ...configuredJob,
      name: "publish",
      command: "publish",
      secrets: ["GITHUB_TOKEN"],
    };
    const report = { ...configuredJob, name: "report", command: "report", needs: ["publish"] };
    const summary = { ...configuredJob, name: "summary", command: "summary", needs: ["report"] };
    const result = applySecretPolicy(
      {
        ...config,
        jobs: [
          lint,
          { ...trustedCoverage, command: "post coverage", secrets: ["GITHUB_TOKEN"] },
          publish,
          report,
          summary,
        ],
      },
      { ...config, jobs: [trustedCoverage, lint] },
      "trusted-sha",
    );

    expect(result.jobs).toEqual([lint, trustedCoverage]);
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
    expect(signals[1]?.aborted).toBe(false);
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

  test("drains automatic runs without cancelling them during shutdown", async () => {
    const outer = new AbortController();
    const run = deferred<BuildRecord | false | undefined>();
    let receivedSignal: AbortSignal | undefined;
    const client = github({ branches: async () => [{ name: "main", sha: "sha" }] });

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
          outer.abort();
          await Promise.resolve();
          expect(receivedSignal?.aborted).toBe(false);
          run.resolve(undefined);
        },
      ),
    });

    expect(receivedSignal?.aborted).toBe(false);
  });

  test("cancels automatic runs that exceed the graceful shutdown deadline", async () => {
    const outer = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const client = github({ branches: async () => [{ name: "main", sha: "sha" }] });

    await serve(repository, {
      signal: outer.signal,
      shutdownTimeoutMs: 0,
      dependencies: dependencies(
        client,
        { cursor: "2026-01-01T00:00:00.000Z", pending: [], seenCommentIds: [], pendingTags: [] },
        async (_github, _repository, _sha, _branch, _config, _deps, _event, signal) => {
          receivedSignal = signal;
          return new Promise((resolve) =>
            signal?.addEventListener("abort", () => resolve(undefined), { once: true }),
          );
        },
        async () => outer.abort(),
      ),
    });

    expect(receivedSignal?.aborted).toBe(true);
    expect(receivedSignal?.reason).toBe("Graceful worker shutdown timed out.");
  });

  test("interrupts the polling interval and drains automatic runs on shutdown", async () => {
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
          return runSettled.promise;
        },
        async () => sleepStarted,
      ),
    });

    await Promise.resolve();
    while (!receivedSignal) await Promise.resolve();
    outer.abort();
    await Promise.resolve();
    expect(receivedSignal.aborted).toBe(false);
    runSettled.resolve(undefined);
    await server;
    releaseSleep();

    expect(receivedSignal.aborted).toBe(false);
  });

  test("does not claim automatic work when shutdown arrives during config loading", async () => {
    const outer = new AbortController();
    const pending = deferred<InformantConfig>();
    const loading = deferred<void>();
    let launches = 0;
    const deps = dependencies(
      github({ branches: async () => [{ name: "main", sha: "next-sha" }] }),
      { pending: [], seenCommentIds: [], pendingTags: [] },
      async () => {
        launches++;
        return undefined;
      },
    );
    deps.repositoryConfig = async (_github, _repository, sha) => {
      if (sha === "default-sha") return config;
      loading.resolve();
      return pending.promise;
    };

    const running = serve(repository, { signal: outer.signal, dependencies: deps });
    await loading.promise;
    outer.abort();
    pending.resolve(config);
    await running;

    expect(launches).toBe(0);
  });

  test("does not claim comment work when shutdown arrives during config loading", async () => {
    const outer = new AbortController();
    const pendingConfig = deferred<InformantConfig>();
    const loading = deferred<void>();
    let launches = 0;
    const deps = dependencies(
      github({}),
      {
        pending: [
          {
            id: 10,
            sha: "comment-sha",
            createdAt: new Date().toISOString(),
            pullRequest,
          },
        ],
        seenCommentIds: [],
        pendingTags: [],
      },
      async () => {
        launches++;
        return undefined;
      },
    );
    deps.repositoryConfig = async (_github, _repository, sha) => {
      if (sha === "default-sha") return config;
      loading.resolve();
      return pendingConfig.promise;
    };

    const running = serve(repository, { signal: outer.signal, dependencies: deps });
    await loading.promise;
    outer.abort();
    pendingConfig.resolve(config);
    await running;

    expect(launches).toBe(0);
  });

  test("does not cancel comment runs during normal draining", async () => {
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

    expect(receivedSignal?.aborted).toBe(false);
    expect(state.pending).toEqual([]);
  });

  test("cancels comment runs that exceed the graceful shutdown deadline", async () => {
    const outer = new AbortController();
    const state: PollState = {
      cursor: "2026-01-01T00:00:00.000Z",
      pending: [{ id: 42, sha: pullRequest.headSha, createdAt: "2026-01-01", pullRequest }],
      seenCommentIds: [42],
      pendingTags: [],
    };
    let receivedSignal: AbortSignal | undefined;

    await serve(repository, {
      signal: outer.signal,
      shutdownTimeoutMs: 0,
      dependencies: dependencies(
        github({}),
        state,
        async (...args) => {
          receivedSignal = args[7];
          return new Promise((resolve) =>
            receivedSignal?.addEventListener("abort", () => resolve(undefined), { once: true }),
          );
        },
        async () => outer.abort(),
      ),
    });

    expect(receivedSignal?.aborted).toBe(true);
    expect(receivedSignal?.reason).toBe("Graceful worker shutdown timed out.");
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
