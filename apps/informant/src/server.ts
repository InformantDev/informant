import { CONFIG_FILE, JOBS_DIRECTORY, parseConfigFiles, selectTriggeredJobs } from "./config.ts";
import {
  reconcilePreparedContainerImageReferences,
  type startAppleContainerSystem,
} from "./container.ts";
import { containerBackendReadiness, refreshSelectedContainerBackend } from "./container-backend.ts";
import { type ClaimScheduling, runCommit } from "./coordinator.ts";
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
const DELETED_TAG_HISTORY_LIMIT = 2_048;

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

function compactTagRefs(
  previous: Array<{ name: string; sha: string }>,
  current: Array<{ name: string; sha: string }>,
): Array<{ name: string; sha: string }> {
  const currentKeys = new Set(current.map((tag) => `${tag.name}\0${tag.sha}`));
  const seen = new Set<string>();
  const historical = previous.filter((tag) => {
    const key = `${tag.name}\0${tag.sha}`;
    if (currentKeys.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...historical.slice(-DELETED_TAG_HISTORY_LIMIT), ...current];
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

export interface AutomaticLaneUpdate {
  lane: string;
  /** The latest commit for this lane. Omitted when the branch or pull request closed. */
  sha?: string;
  /** Earlier heads retained so delayed webhook delivery cannot move a lane backward. */
  obsoleteShas?: string[];
  /** Source event time used to order delayed webhook deliveries. */
  updatedAt?: number;
  /** Stable delivery identity used to retire a stale coordination update. */
  revision?: string;
  closed?: boolean;
}

interface ActiveAutomaticRun {
  repository: string;
  lane: string;
  sha: string;
  updatedAt?: number;
  controller: AbortController;
}

const MAX_TRACKED_AUTOMATIC_LANES = 1_024;

export function automaticLaneUpdateIdentity(update: AutomaticLaneUpdate): string {
  return (
    update.revision ??
    JSON.stringify([
      update.lane,
      update.sha ?? null,
      update.closed === true,
      update.updatedAt ?? null,
      update.obsoleteShas ?? [],
    ])
  );
}

export function automaticLaneUpdateSemanticIdentity(update: AutomaticLaneUpdate): string {
  return update.revision
    ? JSON.stringify([update.lane, "revision", update.revision])
    : JSON.stringify([
        update.lane,
        "legacy",
        update.sha ?? null,
        update.closed === true,
        update.updatedAt ?? null,
      ]);
}

export function automaticLaneUpdateIsNewer(
  previous: AutomaticLaneUpdate,
  incoming: AutomaticLaneUpdate,
): boolean {
  if (
    previous.updatedAt !== undefined &&
    incoming.updatedAt !== undefined &&
    previous.updatedAt !== incoming.updatedAt
  ) {
    return incoming.updatedAt > previous.updatedAt;
  }
  if (incoming.sha && previous.obsoleteShas?.includes(incoming.sha)) return false;
  if (previous.sha && incoming.obsoleteShas?.includes(previous.sha)) return true;
  if (incoming.closed && previous.sha && !incoming.obsoleteShas?.includes(previous.sha)) {
    return false;
  }
  return incoming.sha === previous.sha && incoming.closed === previous.closed;
}

interface ExpectedAutomaticUpdate {
  update: AutomaticLaneUpdate;
  sha: string | null;
  obsoleteShas: Set<string>;
  generation: number;
}

/** Coordinates automatic-run supersession across polling cycles and network wakeups. */
export class AutomaticRunRegistry {
  private readonly active = new Map<string, ActiveAutomaticRun>();
  private readonly expected = new Map<string, ExpectedAutomaticUpdate>();
  private readonly retired = new Set<string>();
  private generation = 0;

  constructor(
    private readonly onRetire?: (repository: Repository, update: AutomaticLaneUpdate) => void,
  ) {}

  private key(repository: Repository, lane: string): string {
    return `${repository.fullName.toLowerCase()}\0${lane}`;
  }

  apply(repository: Repository, updates: AutomaticLaneUpdate[]): AutomaticLaneUpdate[] {
    const accepted: AutomaticLaneUpdate[] = [];
    for (const update of updates) {
      const key = this.key(repository, update.lane);
      if (this.retired.has(`${key}\0${automaticLaneUpdateSemanticIdentity(update)}`)) continue;
      const previous = this.expected.get(key);
      const active = this.active.get(key);
      const orderingPrevious =
        previous &&
        active &&
        previous.sha === active.sha &&
        previous.update.updatedAt === undefined &&
        active.updatedAt !== undefined
          ? { ...previous.update, updatedAt: active.updatedAt }
          : previous?.update;
      if (orderingPrevious && !automaticLaneUpdateIsNewer(orderingPrevious, update)) continue;
      const nextSha = update.closed ? null : (update.sha ?? null);
      const expectedActiveUpdatedAt =
        previous && active && previous.sha === active.sha ? previous.update.updatedAt : undefined;
      const activeUpdatedAt = expectedActiveUpdatedAt ?? active?.updatedAt;
      const orderedAfterActive =
        active !== undefined &&
        active.sha !== nextSha &&
        activeUpdatedAt !== undefined &&
        update.updatedAt !== undefined &&
        update.updatedAt > activeUpdatedAt;
      if (
        active &&
        active.sha !== nextSha &&
        !update.obsoleteShas?.includes(active.sha) &&
        !orderedAfterActive
      ) {
        continue;
      }
      const obsoleteShas = new Set(update.obsoleteShas ?? []);
      if (active && active.sha !== nextSha && orderedAfterActive) obsoleteShas.add(active.sha);
      if (previous?.sha === nextSha && Boolean(previous.update.closed) === Boolean(update.closed)) {
        for (const sha of previous.obsoleteShas) obsoleteShas.add(sha);
      }
      const acceptedUpdate =
        obsoleteShas.size > 0 ? { ...update, obsoleteShas: [...obsoleteShas] } : update;
      accepted.push(acceptedUpdate);
      this.expected.delete(key);
      this.expected.set(key, {
        update: acceptedUpdate,
        sha: nextSha,
        obsoleteShas,
        generation: ++this.generation,
      });
      while (this.expected.size > MAX_TRACKED_AUTOMATIC_LANES) {
        this.expected.delete(this.expected.keys().next().value ?? "");
      }
      if (
        active &&
        active.sha === nextSha &&
        update.updatedAt !== undefined &&
        (active.updatedAt === undefined || update.updatedAt > active.updatedAt)
      ) {
        active.updatedAt = update.updatedAt;
      }
      if (active && (update.closed || active.sha !== update.sha)) {
        this.active.delete(key);
        active.controller.abort(
          update.sha
            ? `Superseded by ${update.lane}@${update.sha.slice(0, 7)}.`
            : `${update.lane} is no longer active.`,
        );
      }
    }
    return accepted;
  }

  private retire(repository: Repository, key: string, expected: ExpectedAutomaticUpdate): void {
    this.expected.delete(key);
    const retiredKey = `${key}\0${automaticLaneUpdateSemanticIdentity(expected.update)}`;
    this.retired.delete(retiredKey);
    this.retired.add(retiredKey);
    while (this.retired.size > MAX_TRACKED_AUTOMATIC_LANES) {
      this.retired.delete(this.retired.values().next().value ?? "");
    }
    this.onRetire?.(repository, expected.update);
  }

  snapshotGeneration(): number {
    return this.generation;
  }

  prepare(
    repository: Repository,
    lane: string,
    sha: string,
    observedGeneration = this.generation,
  ): boolean {
    const key = this.key(repository, lane);
    const expected = this.expected.get(key);
    if (expected) {
      if (expected.sha !== null && expected.obsoleteShas.has(sha)) return false;
      if (expected.generation > observedGeneration) return expected.sha === sha;
      if (expected.sha !== sha) {
        // A live branch or open pull request returned by GitHub is authoritative. Retiring
        // this exact update prevents a stale lead from replaying it after the scan recovers.
        this.retire(repository, key, expected);
      }
    }
    const active = this.active.get(key);
    if (active && active.sha !== sha) {
      this.active.delete(key);
      active.controller.abort(`Superseded by ${lane}@${sha.slice(0, 7)}.`);
    }
    return true;
  }

  activate(
    repository: Repository,
    lane: string,
    sha: string,
    controller: AbortController,
    observedGeneration = this.generation,
  ): boolean {
    if (!this.prepare(repository, lane, sha, observedGeneration)) return false;
    const key = this.key(repository, lane);
    const expected = this.expected.get(key);
    this.active.set(key, {
      repository: repository.fullName.toLowerCase(),
      lane,
      sha,
      ...(expected?.sha === sha && expected.update.updatedAt !== undefined
        ? { updatedAt: expected.update.updatedAt }
        : {}),
      controller,
    });
    return true;
  }

  release(repository: Repository, lane: string, controller: AbortController): void {
    const key = this.key(repository, lane);
    if (this.active.get(key)?.controller === controller) this.active.delete(key);
  }

  activeLanes(repository: Repository): Array<{ lane: string; sha: string }> {
    const fullName = repository.fullName.toLowerCase();
    return [...this.active.values()]
      .filter((run) => run.repository === fullName)
      .map(({ lane, sha }) => ({ lane, sha }));
  }

  cancel(repository: Repository, lane: string, reason: string): void {
    const key = this.key(repository, lane);
    const active = this.active.get(key);
    if (!active) return;
    this.active.delete(key);
    active.controller.abort(reason);
  }

  remove(repository: Repository, reason: string): void {
    const prefix = `${repository.fullName.toLowerCase()}\0`;
    for (const key of this.expected.keys()) {
      if (key.startsWith(prefix)) this.expected.delete(key);
    }
    for (const key of this.retired) {
      if (key.startsWith(prefix)) this.retired.delete(key);
    }
    for (const [key, run] of this.active) {
      if (!key.startsWith(prefix)) continue;
      this.active.delete(key);
      run.controller.abort(reason);
    }
  }
}

export interface ServerOptions {
  once?: boolean;
  /** Bypass the periodic tag throttle for a tag-push webhook synchronization. */
  forceTagPoll?: boolean;
  /** Propagate a failed one-shot poll so event-driven callers can retry it. */
  throwOnPollError?: boolean;
  signal?: AbortSignal;
  onMessage?: (message: string) => void;
  onIdle?: () => Promise<void> | void;
  shutdownTimeoutMs?: number;
  claimScheduling?: ClaimScheduling;
  /** Shared by event-driven scans so a newer dispatch can stop an older run immediately. */
  automaticRuns?: AutomaticRunRegistry;
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
  const protectedJob = (job: InformantConfig["jobs"][number]) =>
    job.secrets.length > 0 ||
    (job.mounts?.length ?? 0) > 0 ||
    job.cache?.some((cache) => cache.protectedChannel) ||
    (job.runtime?.type === "container" && job.runtime.trustedPrepareInputs === true);
  const trustedSecretJobs = trusted.jobs.filter(protectedJob);
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
    if (protectedJob(job) && !trustedSecretNames.has(job.name)) {
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
  const automaticRuns = options.automaticRuns ?? new AutomaticRunRegistry();
  const shutdownControllers = new Set<AbortController>();
  const admissionControllers = new Set<AbortController>();
  const admissionSignal = (controller: AbortController) =>
    options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
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
        (options.forceTagPoll ||
          !state.tagsPolledAt ||
          Date.now() - new Date(state.tagsPolledAt).getTime() >= TAG_POLL_INTERVAL_MS);
      const automaticGeneration = automaticRuns.snapshotGeneration();
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
          state.tagRefs = compactTagRefs(state.tagRefs, tags);
        } else {
          // The first complete poll establishes durable history without replaying existing tags.
          state.tagRefs = compactTagRefs([], tags);
        }
        state.tagsPolledAt = new Date().toISOString();
      }
      await persistState();
      for (const id of completedTagEvents) completedTags.delete(id);
      const openBranchLanes = new Set(branches.map((branch) => `branch:${branch.name}`));
      const openPullRequestLanes = new Set(prs.map((pr) => `pr:${pr.number}`));
      for (const { lane } of automaticRuns.activeLanes(repository)) {
        if (lane.startsWith("branch:") && !openBranchLanes.has(lane)) {
          automaticRuns.cancel(repository, lane, `Branch ${lane.slice(7)} no longer exists.`);
        } else if (lane.startsWith("pr:") && !openPullRequestLanes.has(lane)) {
          automaticRuns.cancel(
            repository,
            lane,
            `Pull request #${lane.slice(3)} is no longer open.`,
          );
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
        // Pull requests are the latency-sensitive CI lane. Branch discovery can
        // require loading many distinct configs and checking manual requests,
        // so offer open PR heads to the execution scheduler first.
        ...prs
          .filter((pr) => pr.sameRepository)
          .map((pullRequest) => ({
            sha: pullRequest.headSha,
            branch: `pull/${pullRequest.number}`,
            pullRequest,
            eventId: `pr:${pullRequest.number}:${pullRequest.headSha}`,
            lane: `pr:${pullRequest.number}`,
          })),
        ...branches.map((branch) => ({
          sha: branch.sha,
          branch: branch.name,
          pullRequest: undefined,
          eventId: `branch:${branch.name}:${branch.sha}`,
          lane: `branch:${branch.name}`,
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
        if (
          !("tag" in target) &&
          !automaticRuns.prepare(repository, target.lane, target.sha, automaticGeneration)
        ) {
          continue;
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
          const shutdownController = new AbortController();
          const admissionController = new AbortController();
          if (
            !("tag" in target) &&
            !automaticRuns.activate(
              repository,
              target.lane,
              target.sha,
              controller,
              automaticGeneration,
            )
          ) {
            continue;
          }
          admissionControllers.add(admissionController);
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
            admissionSignal(admissionController),
            shutdownController.signal,
            options.claimScheduling,
          );
          shutdownControllers.add(shutdownController);
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
              shutdownControllers.delete(shutdownController);
              admissionControllers.delete(admissionController);
              if (!("tag" in target)) {
                automaticRuns.release(repository, target.lane, controller);
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
          const shutdownController = new AbortController();
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
            admissionSignal(admissionController),
            shutdownController.signal,
            options.claimScheduling,
          );
          shutdownControllers.add(shutdownController);
          const run = result
            .then((result) => {
              if (result !== false) completedComments.add(pending.id);
            })
            .catch((error) => {
              message(`comment ${pending.id} failed: ${errorDetail(error)}`);
            })
            .finally(() => {
              inFlightRuns.delete(eventId);
              shutdownControllers.delete(shutdownController);
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
      if (options.once && options.throwOnPollError) {
        await drainOnce();
        throw error;
      }
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
