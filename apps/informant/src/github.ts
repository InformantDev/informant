import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { getGitHubCredentials } from "./machine-config.ts";
import type { CheckRun, Repository } from "./types.ts";

const API = "https://api.github.com";
export const CLAIM_NAME = "Informant CI";
export const JOB_CHECK_PREFIX = "Informant / ";
const STALE_CLAIM_MS = 24 * 60 * 60 * 1_000;

function outputTail(value: string | undefined, maximumBytes = 60_000): string | undefined {
  if (!value) return value;
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= maximumBytes) return value;
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

  constructor(options: GitHubOptions = {}) {
    this.token = options.token;
    if (options.token) this.tokenExpiresAt = Number.POSITIVE_INFINITY;
    this.request = options.fetch ?? globalThis.fetch;
    this.credentials = options.credentials;
    this.repository = options.repository;
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
    if (!response.ok) {
      throw new Error(`GitHub ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  async branchHead(repository: Repository, branch: string): Promise<string> {
    const ref = await this.api<{ object: { sha: string } }>(
      `/repos/${repository.fullName}/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    return ref.object.sha;
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

  async checks(repository: Repository, sha: string): Promise<CheckRun[]> {
    await this.authenticate();
    const appId = this.appId;
    const appFilter = appId ? `&app_id=${encodeURIComponent(appId)}` : "";
    const checks: CheckRun[] = [];
    for (let page = 1; ; page++) {
      const result = await this.api<{ check_runs: CheckRun[] }>(
        `/repos/${repository.fullName}/commits/${sha}/check-runs?check_name=${encodeURIComponent(CLAIM_NAME)}&filter=all&per_page=100&page=${page}${appFilter}`,
      );
      checks.push(...result.check_runs);
      if (result.check_runs.length < 100) break;
    }
    return checks.filter((check) => check.name === CLAIM_NAME);
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

  async checkSuiteStatus(repository: Repository, sha: string): Promise<string | undefined> {
    await this.authenticate();
    const appFilter = this.appId ? `&app_id=${encodeURIComponent(this.appId)}` : "";
    const result = await this.api<{ check_suites: Array<{ status?: string | null }> }>(
      `/repos/${repository.fullName}/commits/${sha}/check-suites?check_name=${encodeURIComponent(CLAIM_NAME)}&per_page=1${appFilter}`,
    );
    return result.check_suites[0]?.status ?? undefined;
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
  ): Promise<CheckRun> {
    const requestId =
      status === "queued"
        ? `${externalId}:jobs:${Buffer.from(JSON.stringify(requestedJobs)).toString("base64url")}`
        : externalId;
    return this.api(`/repos/${repository.fullName}/check-runs`, {
      method: "POST",
      body: JSON.stringify({
        name: CLAIM_NAME,
        head_sha: sha,
        status,
        external_id: requestId,
        started_at: status === "in_progress" ? new Date().toISOString() : undefined,
        output: { title: "Informant CI", summary: `Claimed by ${hostname()}` },
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
        name: `${JOB_CHECK_PREFIX}${jobName}`,
        head_sha: sha,
        status: "queued",
        external_id: `informant-job:${claimId}:${Buffer.from(jobName).toString("base64url")}`,
        output: { title: jobName, summary: "Waiting for dependencies and an available worker." },
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
        output: { title: values.title, summary: values.summary, text: outputTail(values.text) },
      }),
    });
  }

  async claim(
    repository: Repository,
    sha: string,
    machineId: string,
  ): Promise<{ check: CheckRun; requestedJobs: string[] } | undefined> {
    const existing = await this.checks(repository, sha);
    const active = existing.filter((check) => check.status === "in_progress");
    const stale = active.filter(
      (check) =>
        !check.started_at || Date.now() - new Date(check.started_at).getTime() > STALE_CLAIM_MS,
    );
    await Promise.all(
      stale.map(async (check) => {
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
    if (active.length > stale.length) return undefined;
    let requested = existing.some((check) => check.status === "queued");
    const completed = existing.some((check) => check.status === "completed");
    if (!requested && completed && stale.length === 0) {
      requested = (await this.checkSuiteStatus(repository, sha)) === "queued";
    }
    if (!requested && stale.length === 0 && completed) {
      return undefined;
    }

    const candidate = await this.createCheck(repository, sha, machineId);
    const contenders = (await this.checks(repository, sha))
      .filter((check) => check.status === "in_progress")
      .sort((a, b) => a.id - b.id);
    if (contenders[0]?.id === candidate.id) {
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
      return { check: candidate, requestedJobs };
    }

    await this.updateCheck(repository, candidate.id, {
      status: "completed",
      conclusion: "cancelled",
      title: "Claim lost",
      summary: "Another Informant machine claimed this commit first.",
    });
    return undefined;
  }
}
