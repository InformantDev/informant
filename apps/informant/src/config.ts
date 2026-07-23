import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { InformantConfig, JobConfig, Repository } from "./types.ts";

export const CONFIG_FILE = ".informant.toml";

const defaultConfig = `version = 1
poll_interval_seconds = 20
branches = ["main"]

[vm]
image = "ghcr.io/cirruslabs/macos-tahoe-base:latest"
user = "admin"
password = "admin"
prepare = "curl -fsSL https://bun.sh/install | bash && sudo mkdir -p /usr/local/bin && sudo ln -sf $HOME/.bun/bin/bun /usr/local/bin/bun"

[[jobs]]
name = "test"
command = "bun install --frozen-lockfile && bun test"
timeout_minutes = 30
cache = [{ paths = ["~/.bun/install/cache"], key_files = ["bun.lock"] }]
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
    const cache = job.cache;
    if (cache !== undefined && (!Array.isArray(cache) || cache.length === 0)) {
      throw new Error(`jobs[${index}].cache must be a non-empty array of tables`);
    }
    const caches = (cache ?? []).map((value, cacheIndex) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`jobs[${index}].cache[${cacheIndex}] must be a table`);
      }
      const entry = value as Record<string, unknown>;
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
          `jobs[${index}].cache[${cacheIndex}].paths must contain paths starting with ~/ without ..`,
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
        throw new Error(`jobs[${index}].cache[${cacheIndex}].key_files must be relative paths`);
      }
      return { paths, keyFiles };
    });
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
      cache: cache === undefined ? undefined : caches,
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
  const branches = Array.isArray(raw.branches) ? raw.branches : ["main"];
  if (
    branches.length === 0 ||
    branches.some((branch) => typeof branch !== "string" || branch.trim().length === 0)
  ) {
    throw new Error("branches must contain at least one non-empty string");
  }
  const user = vm.user ?? "admin";
  const password = vm.password ?? "admin";
  if (typeof user !== "string" || !/^[A-Za-z_][A-Za-z0-9._-]*$/.test(user)) {
    throw new Error("vm.user must be a valid account name");
  }
  if (typeof password !== "string") {
    throw new Error("vm.password must be a string (an empty password is allowed)");
  }
  const prepare = vm.prepare;
  if (prepare !== undefined && (typeof prepare !== "string" || prepare.trim().length === 0)) {
    throw new Error("vm.prepare must be a non-empty string");
  }
  return {
    version: raw.version,
    pollIntervalSeconds: Math.max(5, pollIntervalSeconds),
    branches,
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
  return parseConfig(await Bun.file(path).text(), path);
}
