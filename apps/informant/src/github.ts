import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { getGitHubCredentials } from "./machine-config.ts";
import type {
  CheckRun,
  PullRequest,
  PullRequestComment,
  Repository,
  TriggerEvent,
} from "./types.ts";

const API = "https://api.github.com";
export const CLAIM_NAME = "Informant CI";
export const COMMENT_CLAIM_NAME = "Informant CI / comment";
export const JOB_CHECK_PREFIX = "Informant / ";
const STALE_CLAIM_MS = 24 * 60 * 60 * 1_000;
const rateLimitGates = new Map<string, number>();
const RETRYABLE_CHECK_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "skipped",
  "stale",
  "startup_failure",
  "timed_out",
]);

export interface ClaimResult {
  check?: CheckRun;
  requestedJobs: string[];
  manualRequest: boolean;
  originalPullRequest?: number;
  retry?: boolean;
}

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly responseBody: string,
    readonly retryAt?: number,
  ) {
    super(`GitHub ${status}: ${responseBody}`);
    this.name = "GitHubApiError";
  }
}

function rateLimitRetryAt(response: Response, body: string): number | undefined {
  const rateLimited =
    response.status === 429 ||
    response.headers.get("x-ratelimit-remaining") === "0" ||
    /rate limit/i.test(body);
  if (!rateLimited) return undefined;

  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Date.now() + seconds * 1_000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return date;
  }

  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) return reset * 1_000;
  return Date.now() + 60_000;
}

function githubText(value: string): string {
  return stripVTControlCharacters(value).replaceAll("\r\n", "\n");
}

function outputTail(value: string | undefined, maximumBytes = 60_000): string | undefined {
  if (!value) return value;
  const plain = githubText(value);
  const bytes = new TextEncoder().encode(plain);
  if (bytes.length <= maximumBytes) return plain;
  let start = bytes.length - maximumBytes;
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  return new TextDecoder().decode(bytes.subarray(start));
}

interface GitHubOptions {
  token?: string;
  fetch?: typeof globalThis.fetch;
  repository?: Repository;
  credentials?: {
    appId: string;
    installationId: string;
    privateKey?: string;
    privateKeyFile?: string;
  };
}

export class GitHubClient {
  private readonly request: typeof globalThis.fetch;
  private token?: string;
  private tokenExpiresAt = 0;
  private appId?: string;
  private readonly credentials?: GitHubOptions["credentials"];
  private readonly repository?: Repository;
  private readonly rateLimitKey: string;

  constructor(options: GitHubOptions = {}) {
    this.token = options.token;
    if (options.token) this.tokenExpiresAt = Number.POSITIVE_INFINITY;
    this.request = options.fetch ?? globalThis.fetch;
    this.credentials = options.credentials;
    this.repository = options.repository;
    this.rateLimitKey = options.repository?.owner.toLowerCase() ?? "default";
  }

  async authenticate(): Promise<void> {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return;
    const environmentAccount = Bun.env.INFORMANT_GITHUB_ACCOUNT;
    const environmentMatches =
      !this.repository ||
      !environmentAccount ||
      environmentAccount.toLowerCase() === this.repository.owner.toLowerCase();
    const environmentToken =
      !this.credentials && environmentMatches
        ? (Bun.env.INFORMANT_GITHUB_TOKEN ?? Bun.env.GITHUB_TOKEN)
        : undefined;
    this.appId =
      this.credentials?.appId ?? (environmentMatches ? Bun.env.INFORMANT_GITHUB_APP_ID : undefined);
    if (environmentToken) {
      this.token = environmentToken;
      this.tokenExpiresAt = Number.POSITIVE_INFINITY;
      return;
    }

    const hasEnvironmentCredentials = Boolean(
      environmentMatches &&
        Bun.env.INFORMANT_GITHUB_APP_ID &&
        Bun.env.INFORMANT_GITHUB_INSTALLATION_ID &&
        (Bun.env.INFORMANT_GITHUB_PRIVATE_KEY || Bun.env.INFORMANT_GITHUB_PRIVATE_KEY_FILE),
    );
    const stored =
      this.credentials || hasEnvironmentCredentials
        ? undefined
        : await getGitHubCredentials(this.repository);
    this.appId ??= stored?.appId;

    const appId = this.appId;
    const installationId =
      this.credentials?.installationId ??
      (environmentMatches ? Bun.env.INFORMANT_GITHUB_INSTALLATION_ID : undefined) ??
      stored?.installationId;
    const privateKey =
      this.credentials?.privateKey ??
      (await this.privateKey(
        this.credentials?.privateKeyFile ?? stored?.privateKeyFile,
        environmentMatches,
      ));
    if (!appId || !installationId || !privateKey) {
      throw new Error(
        "GitHub App credentials are required; run informant setup or set the INFORMANT_GITHUB_* environment variables",
      );
    }
    const jwt = this.appJwt(appId, privateKey);
    const response = await this.request(
      `${API}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${jwt}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok) throw new Error(`GitHub App authentication failed: ${await response.text()}`);
    const result = (await response.json()) as { token: string; expires_at: string };
    this.token = result.token;
    this.tokenExpiresAt = new Date(result.expires_at).getTime();
  }

  async createJobAccessToken(repository: Repository): Promise<string> {
    const environmentAccount = Bun.env.INFORMANT_GITHUB_ACCOUNT;
    const environmentMatches =
      !environmentAccount || environmentAccount.toLowerCase() === repository.owner.toLowerCase();
    const hasEnvironmentCredentials = Boolean(
      environmentMatches &&
        Bun.env.INFORMANT_GITHUB_APP_ID &&
        Bun.env.INFORMANT_GITHUB_INSTALLATION_ID &&
        (Bun.env.INFORMANT_GITHUB_PRIVATE_KEY || Bun.env.INFORMANT_GITHUB_PRIVATE_KEY_FILE),
    );
    const stored =
      this.credentials || hasEnvironmentCredentials
        ? undefined
        : await getGitHubCredentials(repository);
    const appId =
      this.credentials?.appId ??
      (environmentMatches ? Bun.env.INFORMANT_GITHUB_APP_ID : undefined) ??
      stored?.appId;
    const installationId =
      this.credentials?.installationId ??
      (environmentMatches ? Bun.env.INFORMANT_GITHUB_INSTALLATION_ID : undefined) ??
      stored?.installationId;
    const privateKey =
      this.credentials?.privateKey ??
      (await this.privateKey(
        this.credentials?.privateKeyFile ?? stored?.privateKeyFile,
        environmentMatches,
      ));
    if (!appId || !installationId || !privateKey) {
      throw new Error("job tokens require refreshable GitHub App credentials, not a static token");
    }
    const response = await this.request(
      `${API}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.appJwt(appId, privateKey)}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          repositories: [repository.repo],
          permissions: { pull_requests: "write" },
        }),
      },
    );
    if (!response.ok) throw new Error(`GitHub App job token failed: ${await response.text()}`);
    return ((await response.json()) as { token: string }).token;
  }

  private async privateKey(
    storedPath?: string,
    useEnvironment = true,
  ): Promise<string | undefined> {
    if (useEnvironment && Bun.env.INFORMANT_GITHUB_PRIVATE_KEY) {
      return Bun.env.INFORMANT_GITHUB_PRIVATE_KEY.replaceAll("\\n", "\n");
    }
    const path =
      (useEnvironment ? Bun.env.INFORMANT_GITHUB_PRIVATE_KEY_FILE : undefined) ?? storedPath;
    return path ? readFile(path, "utf8") : undefined;
  }

  private appJwt(appId: string, privateKey: string): string {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1_000);
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: appId })}`;
    return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url")}`;
  }

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    await this.authenticate();
    for (let attempt = 0; ; attempt++) {
      const blockedUntil = rateLimitGates.get(this.rateLimitKey) ?? 0;
      if (blockedUntil > Date.now()) await Bun.sleep(blockedUntil - Date.now());

      const response = await this.request(`${API}${path}`, {
        ...init,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          ...init.headers,
        },
      });
      if (response.ok) return (await response.json()) as T;

      const body = await response.text();
      const retryAt = rateLimitRetryAt(response, body);
      const error = new GitHubApiError(response.status, body, retryAt);
      if (!retryAt || attempt > 0) throw error;
      rateLimitGates.set(this.rateLimitKey, retryAt);
    }
  }

  async branchHead(repository: Repository, branch: string): Promise<string> {
    const ref = await this.api<{ object: { sha: string } }>(
      `/repos/${repository.fullName}/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    return ref.object.sha;
  }

  async branches(repository: Repository): Promise<Array<{ name: string; sha: string }>> {
    const values: Array<{ name: string; commit: { sha: string } }> = [];
    for (let page = 1; ; page++) {
      const pageValues = await this.api<typeof values>(
        `/repos/${repository.fullName}/branches?per_page=100&page=${page}`,
      );
      values.push(...pageValues);
      if (pageValues.length < 100) break;
    }
    return values.map((value) => ({ name: value.name, sha: value.commit.sha }));
  }

  async tags(repository: Repository): Promise<Array<{ name: string; sha: string }>> {
    const values: Array<{ name: string; commit: { sha: string } }> = [];
    for (let page = 1; ; page++) {
      const pageValues = await this.api<typeof values>(
        `/repos/${repository.fullName}/tags?per_page=100&page=${page}`,
      );
      values.push(...pageValues);
      if (pageValues.length < 100) break;
    }
    return values.map((value) => ({ name: value.name, sha: value.commit.sha }));
  }

  private parsePullRequest(
    value: {
      number: number;
      state: "open" | "closed";
      draft: boolean;
      base: { ref: string };
      head: { sha: string; repo: { full_name: string } | null };
    },
    repository: Repository,
  ): PullRequest {
    return {
      number: value.number,
      state: value.state,
      draft: value.draft,
      baseBranch: value.base.ref,
      headSha: value.head.sha,
      sameRepository:
        value.head.repo?.full_name.toLowerCase() === repository.fullName.toLowerCase(),
    };
  }

  async pullRequests(repository: Repository): Promise<PullRequest[]> {
    type Raw = {
      number: number;
      state: "open" | "closed";
      draft: boolean;
      base: { ref: string };
      head: { sha: string; repo: { full_name: string } | null };
    };
    const values: Raw[] = [];
    for (let page = 1; ; page++) {
      const pageValues = await this.api<Raw[]>(
        `/repos/${repository.fullName}/pulls?state=open&per_page=100&page=${page}`,
      );
      values.push(...pageValues);
      if (pageValues.length < 100) break;
    }
    return values.map((value) => this.parsePullRequest(value, repository));
  }

  async pullRequest(repository: Repository, number: number): Promise<PullRequest> {
    const value = await this.api<{
      number: number;
      state: "open" | "closed";
      draft: boolean;
      base: { ref: string };
      head: { sha: string; repo: { full_name: string } | null };
    }>(`/repos/${repository.fullName}/pulls/${number}`);
    return this.parsePullRequest(value, repository);
  }

  async pullRequestComments(repository: Repository, since?: string): Promise<PullRequestComment[]> {
    type Raw = { id: number; issue_url: string; created_at: string; updated_at: string };
    const values: Raw[] = [];
    for (let page = 1; ; page++) {
      const query = since ? `&since=${encodeURIComponent(since)}` : "";
      const pageValues = await this.api<Raw[]>(
        `/repos/${repository.fullName}/issues/comments?sort=created&direction=asc&per_page=100&page=${page}${query}`,
      );
      values.push(...pageValues);
      if (pageValues.length < 100) break;
    }
    return values.map((value) => ({
      id: value.id,
      pullRequestNumber: Number(value.issue_url.split("/").at(-1)),
      createdAt: value.created_at,
      updatedAt: value.updated_at,
    }));
  }

  async latestPullRequestComments(
    repository: Repository,
    limit = 100,
  ): Promise<PullRequestComment[]> {
    type Raw = { id: number; issue_url: string; created_at: string; updated_at: string };
    const values = await this.api<Raw[]>(
      `/repos/${repository.fullName}/issues/comments?sort=updated&direction=desc&per_page=${limit}&page=1`,
    );
    return values.map((value) => ({
      id: value.id,
      pullRequestNumber: Number(value.issue_url.split("/").at(-1)),
      createdAt: value.created_at,
      updatedAt: value.updated_at,
    }));
  }

  async defaultBranch(repository: Repository): Promise<string> {
    const result = await this.api<{ default_branch: string }>(`/repos/${repository.fullName}`);
    return result.default_branch;
  }

  async fileContent(repository: Repository, sha: string, path: string): Promise<string> {
    const result = await this.api<{ content: string; encoding: string }>(
      `/repos/${repository.fullName}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(sha)}`,
    );
    if (result.encoding !== "base64") throw new Error(`unsupported GitHub content encoding`);
    return Buffer.from(result.content.replaceAll("\n", ""), "base64").toString("utf8");
  }

  async directoryFiles(repository: Repository, sha: string, path: string): Promise<string[]> {
    const result = await this.api<Array<{ name: string; path: string; type: string }>>(
      `/repos/${repository.fullName}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(sha)}`,
    );
    return result
      .filter((entry) => entry.type === "file" && entry.name.endsWith(".toml"))
      .map((entry) => entry.path)
      .sort();
  }

  async checks(repository: Repository, sha: string, name = CLAIM_NAME): Promise<CheckRun[]> {
    await this.authenticate();
    const appId = this.appId;
    const appFilter = appId ? `&app_id=${encodeURIComponent(appId)}` : "";
    const checks: CheckRun[] = [];
    for (let page = 1; ; page++) {
      const result = await this.api<{ check_runs: CheckRun[] }>(
        `/repos/${repository.fullName}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}&filter=all&per_page=100&page=${page}${appFilter}`,
      );
      checks.push(...result.check_runs);
      if (result.check_runs.length < 100) break;
    }
    return checks.filter((check) => check.name === name);
  }

  async jobChecks(repository: Repository, sha: string, claimId: number): Promise<CheckRun[]> {
    await this.authenticate();
    const appFilter = this.appId ? `&app_id=${encodeURIComponent(this.appId)}` : "";
    const checks: CheckRun[] = [];
    for (let page = 1; ; page++) {
      const result = await this.api<{ check_runs: CheckRun[] }>(
        `/repos/${repository.fullName}/commits/${sha}/check-runs?filter=all&per_page=100&page=${page}${appFilter}`,
      );
      checks.push(...result.check_runs);
      if (result.check_runs.length < 100) break;
    }
    const prefix = `informant-job:${claimId}:`;
    return checks.filter(
      (check) => check.name.startsWith(JOB_CHECK_PREFIX) && check.external_id?.startsWith(prefix),
    );
  }

  async recoverInterruptedCheck(
    repository: Repository,
    sha: string,
    claimId: number,
    conclusion: "success" | "failure" | "cancelled" = "cancelled",
  ): Promise<boolean> {
    const aggregate = await this.api<CheckRun>(
      `/repos/${repository.fullName}/check-runs/${claimId}`,
    );
    if (aggregate.status === "completed") return false;

    const jobs = (await this.jobChecks(repository, sha, claimId)).filter(
      (job) => job.status !== "completed",
    );
    await Promise.all(
      jobs.map((job) =>
        this.updateCheck(repository, job.id, {
          status: "completed",
          conclusion: "cancelled",
          title: "Interrupted worker job",
          summary: "The worker stopped before this job completed.",
        }),
      ),
    );
    await this.updateCheck(repository, claimId, {
      status: "completed",
      conclusion,
      title:
        conclusion === "success"
          ? "All jobs passed"
          : conclusion === "failure"
            ? "A job failed"
            : "Interrupted worker build",
      summary:
        conclusion === "cancelled"
          ? "The worker stopped before this build completed."
          : "Recovered the final build result after the worker stopped.",
    });
    return true;
  }

  async checkSuiteStatus(
    repository: Repository,
    sha: string,
    name = CLAIM_NAME,
  ): Promise<string | undefined> {
    await this.authenticate();
    const appFilter = this.appId ? `&app_id=${encodeURIComponent(this.appId)}` : "";
    const result = await this.api<{ check_suites: Array<{ status?: string | null }> }>(
      `/repos/${repository.fullName}/commits/${sha}/check-suites?check_name=${encodeURIComponent(name)}&per_page=1${appFilter}`,
    );
    return result.check_suites[0]?.status ?? undefined;
  }

  async hasPendingManualRequest(repository: Repository, sha: string): Promise<boolean> {
    const checks = await this.checks(repository, sha, CLAIM_NAME);
    if (
      checks.some((check) => check.status === "queued" && !check.external_id?.includes(":event:"))
    ) {
      return true;
    }
    return (
      checks.some((check) => check.status === "completed") &&
      (await this.checkSuiteStatus(repository, sha, CLAIM_NAME)) === "queued"
    );
  }

  async installationRepositories(): Promise<Repository[]> {
    const repositories: Array<{ full_name: string }> = [];
    for (let page = 1; ; page++) {
      const result = await this.api<{
        total_count: number;
        repositories: Array<{ full_name: string }>;
      }>(`/installation/repositories?per_page=100&page=${page}`);
      repositories.push(...result.repositories);
      if (repositories.length >= result.total_count || result.repositories.length < 100) break;
    }
    return repositories.map((repository) => {
      const [owner, repo] = repository.full_name.split("/");
      if (!owner || !repo)
        throw new Error(`invalid repository from GitHub: ${repository.full_name}`);
      return { owner, repo, fullName: repository.full_name };
    });
  }

  async waitForCommit(repository: Repository, sha: string, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await this.api(`/repos/${repository.fullName}/commits/${sha}`);
        return;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          (!error.message.startsWith("GitHub 422") && !error.message.startsWith("GitHub 404"))
        ) {
          throw error;
        }
      }
      await Bun.sleep(1_000);
    }
    throw new Error(`commit ${sha.slice(0, 7)} did not appear on GitHub within 2 minutes`);
  }

  async createCheck(
    repository: Repository,
    sha: string,
    externalId: string,
    status: "queued" | "in_progress" = "in_progress",
    requestedJobs: string[] = [],
    name = CLAIM_NAME,
  ): Promise<CheckRun> {
    const requestId =
      status === "queued"
        ? `${externalId}:jobs:${Buffer.from(JSON.stringify(requestedJobs)).toString("base64url")}`
        : externalId;
    return this.api(`/repos/${repository.fullName}/check-runs`, {
      method: "POST",
      body: JSON.stringify({
        name: githubText(name),
        head_sha: sha,
        status,
        external_id: requestId,
        started_at: status === "in_progress" ? new Date().toISOString() : undefined,
        output: { title: "Informant CI", summary: githubText(`Claimed by ${hostname()}`) },
      }),
    });
  }

  async createJobCheck(
    repository: Repository,
    sha: string,
    claimId: number,
    jobName: string,
  ): Promise<CheckRun> {
    return this.api(`/repos/${repository.fullName}/check-runs`, {
      method: "POST",
      body: JSON.stringify({
        name: githubText(`${JOB_CHECK_PREFIX}${jobName}`),
        head_sha: sha,
        status: "queued",
        external_id: `informant-job:${claimId}:${Buffer.from(jobName).toString("base64url")}`,
        output: {
          title: githubText(jobName),
          summary: "Waiting for dependencies and an available worker.",
        },
      }),
    });
  }

  async updateCheck(
    repository: Repository,
    id: number,
    values: {
      status?: "in_progress" | "completed";
      conclusion?: "success" | "failure" | "cancelled" | "neutral" | "skipped";
      title: string;
      summary: string;
      text?: string;
    },
  ): Promise<CheckRun> {
    return this.api(`/repos/${repository.fullName}/check-runs/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: values.status,
        conclusion: values.conclusion,
        started_at: values.status === "in_progress" ? new Date().toISOString() : undefined,
        completed_at: values.status === "completed" ? new Date().toISOString() : undefined,
        output: {
          title: githubText(values.title),
          summary: githubText(values.summary),
          text: outputTail(values.text),
        },
      }),
    });
  }

  async claim(
    repository: Repository,
    sha: string,
    machineId: string,
    event: { type: TriggerEvent | "manual"; id: string } = { type: "commit", id: sha },
  ): Promise<ClaimResult | undefined> {
    const initialName = event.type === "comment" ? COMMENT_CLAIM_NAME : CLAIM_NAME;
    const initialChecks = await this.checks(repository, sha, initialName);
    const requestedChecks =
      event.type === "comment"
        ? []
        : initialChecks.filter(
            (check) => check.status === "queued" && !check.external_id?.includes(":event:"),
          );
    const suiteRerun =
      event.type !== "comment" &&
      requestedChecks.length === 0 &&
      initialChecks.some((check) => check.status === "completed") &&
      (await this.checkSuiteStatus(repository, sha, initialName)) === "queued";
    const previousAggregate = suiteRerun
      ? initialChecks
          .filter((check) => check.status === "completed" && check.conclusion !== "neutral")
          .sort((a, b) => b.id - a.id)[0]
      : undefined;
    const originalPullRequestMatch = previousAggregate?.external_id?.match(
      /:event:commit:pr:(\d+):([^:]+)$/,
    );
    const originalPullRequestNumber = Number(originalPullRequestMatch?.[1]);
    const originalPullRequest =
      Number.isSafeInteger(originalPullRequestNumber) &&
      originalPullRequestNumber > 0 &&
      originalPullRequestMatch?.[2] === sha
        ? originalPullRequestNumber
        : undefined;
    const failedRerunJobs = previousAggregate
      ? [
          ...new Set(
            (await this.jobChecks(repository, sha, previousAggregate.id))
              .filter((check) =>
                check.conclusion ? RETRYABLE_CHECK_CONCLUSIONS.has(check.conclusion) : false,
              )
              .map((check) => check.name.slice(JOB_CHECK_PREFIX.length)),
          ),
        ]
      : [];
    const manualRequest = requestedChecks.length > 0 || suiteRerun;
    const claimEvent = manualRequest
      ? (suiteRerun &&
          originalPullRequest && {
            type: "commit" as const,
            id: `pr:${originalPullRequest}:${sha}`,
          }) || { type: "manual" as const, id: sha }
      : event;
    const name = claimEvent.type === "comment" ? COMMENT_CLAIM_NAME : CLAIM_NAME;
    const scope = `${claimEvent.type}:${claimEvent.id}`;
    const acceptsLegacyCommit =
      claimEvent.type === "commit" &&
      (claimEvent.id === sha || claimEvent.id.startsWith("branch:"));
    const existing = initialChecks.filter(
      (check) =>
        check.external_id?.endsWith(`:event:${scope}`) ||
        requestedChecks.some((request) => request.id === check.id) ||
        (acceptsLegacyCommit && !check.external_id?.includes(":event:")),
    );
    const historicalCompleted = new Set(
      existing.filter((check) => check.status === "completed").map((check) => check.id),
    );
    const active = existing.filter((check) => check.status === "in_progress");
    const stale = active.filter(
      (check) =>
        !check.started_at || Date.now() - new Date(check.started_at).getTime() > STALE_CLAIM_MS,
    );
    const allStale = initialChecks
      .filter((check) => check.status === "in_progress")
      .filter(
        (check) =>
          !check.started_at || Date.now() - new Date(check.started_at).getTime() > STALE_CLAIM_MS,
      );
    await Promise.all(
      allStale.map(async (check) => {
        const jobs = (await this.jobChecks(repository, sha, check.id)).filter(
          (job) => job.status !== "completed",
        );
        await Promise.all(
          jobs.map((job) =>
            this.updateCheck(repository, job.id, {
              status: "completed",
              conclusion: "cancelled",
              title: "Stale worker job",
              summary: "The worker claim expired before this job completed.",
            }),
          ),
        );
        return this.updateCheck(repository, check.id, {
          status: "completed",
          conclusion: "cancelled",
          title: "Stale worker claim",
          summary: "The worker did not complete this claim within 24 hours; it may be retried.",
        });
      }),
    );
    if (active.length > stale.length) return { requestedJobs: [], manualRequest, retry: true };
    const requested = suiteRerun || existing.some((check) => check.status === "queued");
    if (
      !requested &&
      stale.length === 0 &&
      existing.some((check) => check.status === "completed")
    ) {
      return undefined;
    }

    const candidate = await this.createCheck(
      repository,
      sha,
      `${machineId}:event:${scope}`,
      "in_progress",
      [],
      name,
    );
    const election = await this.checks(repository, sha, name);
    const ignoredCompletions = new Set([
      ...stale.map((check) => check.id),
      ...(requested ? historicalCompleted : []),
    ]);
    const completed = election.some(
      (check) =>
        check.status === "completed" &&
        check.external_id?.endsWith(`:event:${scope}`) &&
        !ignoredCompletions.has(check.id),
    );
    const contenders = election
      .filter(
        (check) =>
          check.external_id?.endsWith(`:event:${scope}`) ||
          (acceptsLegacyCommit && !check.external_id?.includes(":event:")),
      )
      .filter((check) => check.status === "in_progress")
      .sort((a, b) => a.id - b.id);
    if (!completed && contenders[0]?.id === candidate.id) {
      const queued = existing.filter((check) => check.status === "queued");
      const jobRequests = queued.map((check) => {
        const encoded = check.external_id?.split(":jobs:")[1];
        if (!encoded) return [];
        try {
          const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
          return Array.isArray(value) ? value.map(String) : [];
        } catch {
          return [];
        }
      });
      const requestedJobs = jobRequests.some((jobs) => jobs.length === 0)
        ? []
        : [...new Set(jobRequests.flat())];
      // GitHub's polling API does not expose whether a queued failed suite was
      // rerequested as "all" or "failed". Prefer retrying its unsuccessful and
      // incomplete jobs; explicit Informant requests still support all jobs.
      if (suiteRerun && failedRerunJobs.length > 0) requestedJobs.push(...failedRerunJobs);
      await Promise.all(
        queued.map((check) =>
          this.updateCheck(repository, check.id, {
            status: "completed",
            conclusion: "neutral",
            title: "Request accepted",
            summary: `Build request accepted by ${hostname()}.`,
          }),
        ),
      );
      return {
        check: candidate,
        requestedJobs,
        manualRequest,
        originalPullRequest,
      };
    }

    await this.updateCheck(repository, candidate.id, {
      status: "completed",
      conclusion: "cancelled",
      title: "Claim lost",
      summary: "Another Informant machine claimed this commit first.",
    });
    return completed ? undefined : { requestedJobs: [], manualRequest, retry: true };
  }
}
