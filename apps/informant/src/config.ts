import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { InformantConfig, JobConfig, Repository, TriggerRule } from "./types.ts";

export const CONFIG_DIRECTORY = ".informant";
export const CONFIG_FILE = `${CONFIG_DIRECTORY}/config.toml`;
export const JOBS_DIRECTORY = `${CONFIG_DIRECTORY}/jobs`;

const defaultDirectoryConfig = `version = 1
timeout_minutes = 30
triggers = [{ event = "commit", branch = { names = ["main"] } }]

[vm]
image = "ghcr.io/cirruslabs/macos-tahoe-base:latest"
user = "admin"
password = "admin"
prepare = """
set -euo pipefail
curl -fsSL https://bun.sh/install | bash
sudo mkdir -p /usr/local/bin
sudo ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun
"""
`;

const defaultJob = `name = "test"
command = """
bun install --frozen-lockfile && bun test
"""
cache = [{ paths = ["~/.bun/install/cache"], shared = true }]
`;

export function directoryConfigTemplate(): string {
  return defaultDirectoryConfig;
}

export function jobTemplate(): string {
  return defaultJob;
}

export function selectJobs(config: InformantConfig, requested: string[]): InformantConfig {
  if (requested.length === 0) return config;
  const jobsByName = new Map(config.jobs.map((job) => [job.name, job]));
  const selected = new Set<string>();
  const include = (name: string) => {
    if (selected.has(name)) return;
    const job = jobsByName.get(name);
    if (!job) throw new Error(`unknown job: ${name}`);
    selected.add(name);
    for (const dependency of job.needs) include(dependency);
  };
  for (const name of requested) include(name);
  return { ...config, jobs: config.jobs.filter((job) => selected.has(job.name)) };
}

export function selectTriggeredJobs(
  config: InformantConfig,
  matches: (rule: TriggerRule) => boolean,
) {
  const roots = config.jobs
    .filter((job) => (job.triggers ?? config.triggers ?? []).some(matches))
    .map((job) => job.name);
  return roots.length ? selectJobs(config, roots) : { ...config, jobs: [] };
}

function parseTriggers(value: unknown, label: string): TriggerRule[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error(`${label}[${index}] must be a table`);
    const raw = item as Record<string, unknown>;
    if (raw.event !== "commit" && raw.event !== "comment")
      throw new Error(`${label}[${index}].event must be commit or comment`);
    const allowed = new Set(["event", "branch", "pull_request"]);
    if (Object.keys(raw).some((key) => !allowed.has(key)))
      throw new Error(`${label}[${index}] contains an unknown field`);
    if (raw.branch !== undefined && raw.pull_request !== undefined)
      throw new Error(`${label}[${index}] cannot use both branch and pull_request`);
    if (raw.event === "comment" && raw.branch !== undefined)
      throw new Error(`${label}[${index}] comment cannot use branch`);
    let branch: TriggerRule["branch"];
    if (raw.branch !== undefined) {
      const table = raw.branch as Record<string, unknown>;
      if (
        !table ||
        typeof table !== "object" ||
        Array.isArray(table) ||
        Object.keys(table).some((key) => key !== "names")
      )
        throw new Error(`${label}[${index}].branch must contain only names`);
      if (
        !Array.isArray(table.names) ||
        table.names.length === 0 ||
        table.names.some((name) => typeof name !== "string" || !name.trim())
      )
        throw new Error(`${label}[${index}].branch.names must contain non-empty strings`);
      branch = { names: table.names as string[] };
    }
    let pullRequest: TriggerRule["pullRequest"];
    if (raw.pull_request !== undefined) {
      const table = raw.pull_request as Record<string, unknown>;
      if (
        !table ||
        typeof table !== "object" ||
        Array.isArray(table) ||
        Object.keys(table).some((key) => !["state", "draft", "base_branches"].includes(key))
      )
        throw new Error(`${label}[${index}].pull_request is invalid`);
      if (table.state !== undefined && !["open", "closed", "all"].includes(String(table.state)))
        throw new Error(`${label}[${index}].pull_request.state must be open, closed, or all`);
      if (table.draft !== undefined && typeof table.draft !== "boolean")
        throw new Error(`${label}[${index}].pull_request.draft must be boolean`);
      if (
        table.base_branches !== undefined &&
        (!Array.isArray(table.base_branches) ||
          table.base_branches.length === 0 ||
          table.base_branches.some((name) => typeof name !== "string" || !name.trim()))
      )
        throw new Error(
          `${label}[${index}].pull_request.base_branches must contain non-empty strings`,
        );
      pullRequest = {
        state: table.state as "open" | "closed" | "all" | undefined,
        draft: table.draft as boolean | undefined,
        baseBranches: table.base_branches as string[] | undefined,
      };
    }
    return { event: raw.event, branch, pullRequest } as TriggerRule;
  });
}

export function parseRepository(value: string): Repository {
  const normalized = value
    .trim()
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/^ssh:\/\/(?:git@)?github\.com\//, "")
    .replace(/\.git$/, "");
  const [owner, repo, ...rest] = normalized.split("/");
  if (!owner || !repo || rest.length > 0) throw new Error(`invalid GitHub repository: ${value}`);
  return { owner, repo, fullName: `${owner}/${repo}` };
}

export function findConfig(start = process.cwd()): string {
  let directory = resolve(start);
  while (true) {
    const config = resolve(directory, CONFIG_FILE);
    if (existsSync(config)) return config;
    const parent = resolve(directory, "..");
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`could not find ${CONFIG_FILE}; run informant init in the repository`);
}

export function parseConfigFiles(
  source: string,
  jobs: Array<{ path: string; source: string }>,
  label = CONFIG_FILE,
): InformantConfig {
  const combined = [source, ...jobs.map((job) => `\n[[jobs]]\n${job.source}`)].join("\n");
  return parseConfig(combined, label);
}

function parseEnvironment(value: unknown, label: string): Record<string, string> {
  const environment = value ?? {};
  if (typeof environment !== "object" || environment === null || Array.isArray(environment)) {
    throw new Error(`${label} must be a table of scalar values`);
  }
  for (const [key, item] of Object.entries(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`${label} key ${JSON.stringify(key)} is not a shell variable`);
    }
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      throw new Error(`${label} must be a table of scalar values`);
    }
  }
  return Object.fromEntries(Object.entries(environment).map(([key, item]) => [key, String(item)]));
}

function parseCaches(value: unknown, label: string, allowEmpty = false): JobConfig["cache"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be a non-empty array of tables`);
  }
  return value.map((item, cacheIndex) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`${label}[${cacheIndex}] must be a table`);
    }
    const entry = item as Record<string, unknown>;
    const paths = entry.paths;
    if (
      !Array.isArray(paths) ||
      paths.length === 0 ||
      paths.some(
        (path) =>
          typeof path !== "string" ||
          !path.startsWith("~/") ||
          path.length <= 2 ||
          path.split("/").includes(".."),
      )
    ) {
      throw new Error(
        `${label}[${cacheIndex}].paths must contain paths starting with ~/ without ..`,
      );
    }
    const keyFiles = entry.key_files ?? [];
    if (
      !Array.isArray(keyFiles) ||
      keyFiles.some(
        (keyFile) =>
          typeof keyFile !== "string" ||
          keyFile.length === 0 ||
          keyFile.startsWith("/") ||
          keyFile.split("/").includes(".."),
      )
    ) {
      throw new Error(`${label}[${cacheIndex}].key_files must be relative paths`);
    }
    const shared = entry.shared ?? false;
    if (typeof shared !== "boolean") {
      throw new Error(`${label}[${cacheIndex}].shared must be a boolean`);
    }
    if (shared && keyFiles.length > 0) {
      throw new Error(`${label}[${cacheIndex}] cannot combine shared and key_files`);
    }
    return { paths, keyFiles, shared };
  });
}

export function parseConfig(source: string, label = CONFIG_FILE): InformantConfig {
  const raw = Bun.TOML.parse(source) as Record<string, unknown>;
  if (raw.version !== 1) {
    throw new Error(`${label} version must be 1`);
  }
  const vm = (raw.vm ?? {}) as Record<string, unknown>;
  const rawJobs = raw.jobs;
  if (raw.branches !== undefined && raw.triggers !== undefined)
    throw new Error("branches and triggers cannot both be set");
  const topTriggers =
    raw.triggers !== undefined
      ? parseTriggers(raw.triggers, "triggers")
      : parseTriggers(
          [{ event: "commit", branch: { names: raw.branches ?? ["main"] } }],
          "triggers",
        );
  if (!Array.isArray(rawJobs) || rawJobs.length === 0) {
    throw new Error(`${label} must contain at least one [[jobs]] entry`);
  }
  const defaultTimeoutMinutes = Number(raw.timeout_minutes ?? 30);
  if (!Number.isFinite(defaultTimeoutMinutes) || defaultTimeoutMinutes <= 0) {
    throw new Error("timeout_minutes must be a positive number");
  }
  const defaultEnvironment = parseEnvironment(raw.environment, "environment");
  const defaultCache = parseCaches(raw.cache, "cache");
  const jobs: JobConfig[] = rawJobs.map((value, index) => {
    const job = value as Record<string, unknown>;
    if (typeof job.name !== "string" || typeof job.command !== "string") {
      throw new Error(`jobs[${index}] must have string name and command fields`);
    }
    if (job.name.trim().length === 0 || job.command.trim().length === 0) {
      throw new Error(`jobs[${index}] name and command fields must be non-empty`);
    }
    const environment = {
      ...defaultEnvironment,
      ...parseEnvironment(job.environment, `jobs[${index}].environment`),
    };
    const secrets = job.secrets ?? [];
    if (
      !Array.isArray(secrets) ||
      secrets.some((name) => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    ) {
      throw new Error(`jobs[${index}].secrets must contain shell variable names`);
    }
    if (new Set(secrets).size !== secrets.length) {
      throw new Error(`jobs[${index}].secrets must not contain duplicates`);
    }
    const conflictingSecret = secrets.find((name) => Object.hasOwn(environment, name));
    if (conflictingSecret) {
      throw new Error(
        `jobs[${index}].secrets contains ${conflictingSecret}, which is also set in environment`,
      );
    }
    const timeoutMinutes = Number(job.timeout_minutes ?? defaultTimeoutMinutes);
    if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
      throw new Error(`jobs[${index}].timeout_minutes must be a positive number`);
    }
    const cache =
      job.cache === undefined ? defaultCache : parseCaches(job.cache, `jobs[${index}].cache`, true);
    return {
      name: job.name,
      command: job.command.trim(),
      timeoutMinutes,
      needs: Array.isArray(job.needs)
        ? job.needs.map(String)
        : job.needs === undefined
          ? []
          : [String(job.needs)],
      environment,
      secrets,
      triggers:
        job.triggers === undefined
          ? topTriggers
          : parseTriggers(job.triggers, `jobs[${index}].triggers`),
      cache,
    };
  });
  const jobNames = new Set(jobs.map((job) => job.name));
  if (jobNames.size !== jobs.length) throw new Error("job names must be unique");
  for (const job of jobs) {
    for (const dependency of job.needs) {
      if (!jobNames.has(dependency)) {
        throw new Error(`job ${job.name} needs unknown job ${dependency}`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string) => {
    if (visiting.has(name)) throw new Error(`job dependency cycle includes ${name}`);
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of jobs.find((job) => job.name === name)?.needs ?? []) visit(dependency);
    visiting.delete(name);
    visited.add(name);
  };
  for (const job of jobs) visit(job.name);
  if (typeof vm.image !== "string" || vm.image.trim().length === 0) {
    throw new Error("vm.image must be a non-empty string");
  }
  const cpu = vm.cpu === undefined ? undefined : Number(vm.cpu);
  if (cpu !== undefined && (!Number.isFinite(cpu) || cpu <= 0 || !Number.isInteger(cpu))) {
    throw new Error("vm.cpu must be a positive integer");
  }
  const memoryMb = vm.memory_mb === undefined ? undefined : Number(vm.memory_mb);
  if (
    memoryMb !== undefined &&
    (!Number.isFinite(memoryMb) || memoryMb <= 0 || !Number.isInteger(memoryMb))
  ) {
    throw new Error("vm.memory_mb must be a positive integer");
  }
  const pollIntervalSeconds = Number(raw.poll_interval_seconds ?? 30);
  if (!Number.isFinite(pollIntervalSeconds) || pollIntervalSeconds <= 0) {
    throw new Error("poll_interval_seconds must be a positive number");
  }
  const user = vm.user ?? "admin";
  const password = vm.password ?? "admin";
  if (typeof user !== "string" || !/^[A-Za-z_][A-Za-z0-9._-]*$/.test(user)) {
    throw new Error("vm.user must be a valid account name");
  }
  if (typeof password !== "string") {
    throw new Error("vm.password must be a string (an empty password is allowed)");
  }
  const rawPrepare = vm.prepare;
  if (
    rawPrepare !== undefined &&
    (typeof rawPrepare !== "string" || rawPrepare.trim().length === 0)
  ) {
    throw new Error("vm.prepare must be a non-empty string");
  }
  const prepare = typeof rawPrepare === "string" ? rawPrepare.trim() : undefined;
  return {
    version: raw.version,
    pollIntervalSeconds: Math.max(5, pollIntervalSeconds),
    triggers: topTriggers,
    vm: {
      image: vm.image,
      user,
      password,
      cpu,
      memoryMb,
      prepare,
    },
    jobs,
  };
}

export async function readConfig(path = findConfig()): Promise<InformantConfig> {
  const jobsDirectory = resolve(path, "..", "jobs");
  const entries = (await readdir(jobsDirectory).catch(() => []))
    .filter((entry) => entry.endsWith(".toml"))
    .sort();
  return parseConfigFiles(
    await Bun.file(path).text(),
    await Promise.all(
      entries.map(async (entry) => ({
        path: resolve(jobsDirectory, entry),
        source: await Bun.file(resolve(jobsDirectory, entry)).text(),
      })),
    ),
    path,
  );
}
