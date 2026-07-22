import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { InformantConfig, JobConfig, Repository, TriggerRule } from "./types.ts";

export const CONFIG_FILE = ".informant.toml";

const defaultConfig = `version = 1
poll_interval_seconds = 20
triggers = [{ event = "commit", branch = { names = ["main"] } }]

[vm]
image = "ghcr.io/cirruslabs/macos-tahoe-base:latest"
user = "admin"
password = "admin"

[[jobs]]
name = "test"
command = "bun install --frozen-lockfile && bun test"
timeout_minutes = 30
`;

export function configTemplate(): string {
  return defaultConfig;
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
    const candidate = resolve(directory, CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(directory, "..");
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`could not find ${CONFIG_FILE}; run informant init in the repository`);
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
  const jobs: JobConfig[] = rawJobs.map((value, index) => {
    const job = value as Record<string, unknown>;
    if (typeof job.name !== "string" || typeof job.command !== "string") {
      throw new Error(`jobs[${index}] must have string name and command fields`);
    }
    if (job.name.trim().length === 0 || job.command.trim().length === 0) {
      throw new Error(`jobs[${index}] name and command fields must be non-empty`);
    }
    const environment = job.environment ?? {};
    if (typeof environment !== "object" || environment === null || Array.isArray(environment)) {
      throw new Error(`jobs[${index}].environment must be a table of scalar values`);
    }
    for (const value of Object.values(environment)) {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw new Error(`jobs[${index}].environment must be a table of scalar values`);
      }
    }
    for (const key of Object.keys(environment)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(
          `jobs[${index}].environment key ${JSON.stringify(key)} is not a shell variable`,
        );
      }
    }
    const timeoutMinutes = Number(job.timeout_minutes ?? 30);
    if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
      throw new Error(`jobs[${index}].timeout_minutes must be a positive number`);
    }
    return {
      name: job.name,
      command: job.command,
      timeoutMinutes,
      needs: Array.isArray(job.needs)
        ? job.needs.map(String)
        : job.needs === undefined
          ? []
          : [String(job.needs)],
      environment: Object.fromEntries(
        Object.entries(environment).map(([key, item]) => [key, String(item)]),
      ),
      triggers:
        job.triggers === undefined
          ? topTriggers
          : parseTriggers(job.triggers, `jobs[${index}].triggers`),
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
  const pollIntervalSeconds = Number(raw.poll_interval_seconds ?? 20);
  if (!Number.isFinite(pollIntervalSeconds) || pollIntervalSeconds <= 0) {
    throw new Error("poll_interval_seconds must be a positive number");
  }
  const user = vm.user ?? "admin";
  const password = vm.password ?? "admin";
  if (typeof user !== "string" || user.trim().length === 0) {
    throw new Error("vm.user must be a non-empty string");
  }
  if (typeof password !== "string") {
    throw new Error("vm.password must be a string (an empty password is allowed)");
  }
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
    },
    jobs,
  };
}

export async function readConfig(path = findConfig()): Promise<InformantConfig> {
  return parseConfig(await Bun.file(path).text(), path);
}
