import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseRepository } from "./config.ts";
import type { Repository } from "./types.ts";

export interface GitHubCredentials {
  appId: string;
  installationId: string;
  privateKeyFile: string;
}

interface MachineConfig {
  version: 1;
  repositories: string[];
  github?: GitHubCredentials;
}

export function machineConfigPath(): string {
  const configHome = Bun.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return Bun.env.INFORMANT_CONFIG_FILE ?? join(configHome, "informant", "config.json");
}

async function readMachineConfig(path = machineConfigPath()): Promise<MachineConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { version: 1, repositories: [] };
  const value = (await file.json()) as Partial<MachineConfig>;
  if (value.version !== 1) {
    throw new Error(
      `unsupported Informant config version in ${path}; upgrade Informant to continue`,
    );
  }
  if (!Array.isArray(value.repositories)) throw new Error(`invalid Informant config: ${path}`);
  return {
    version: value.version,
    repositories: value.repositories.map(String),
    github: value.github,
  };
}

async function writeMachineConfig(
  config: MachineConfig,
  path = machineConfigPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(config, null, 2)}\n`);
}

export async function listRepositories(path = machineConfigPath()): Promise<Repository[]> {
  const config = await readMachineConfig(path);
  return config.repositories.map(parseRepository);
}

export async function addRepository(
  repository: Repository,
  path = machineConfigPath(),
): Promise<boolean> {
  const config = await readMachineConfig(path);
  if (config.repositories.includes(repository.fullName)) return false;
  config.repositories.push(repository.fullName);
  config.repositories.sort();
  await writeMachineConfig(config, path);
  return true;
}

export async function removeRepository(
  repository: Repository,
  path = machineConfigPath(),
): Promise<boolean> {
  const config = await readMachineConfig(path);
  const repositories = config.repositories.filter((value) => value !== repository.fullName);
  if (repositories.length === config.repositories.length) return false;
  await writeMachineConfig({ ...config, repositories }, path);
  return true;
}

export async function getGitHubCredentials(
  path = machineConfigPath(),
): Promise<GitHubCredentials | undefined> {
  return (await readMachineConfig(path)).github;
}

export async function saveGitHubCredentials(
  credentials: GitHubCredentials,
  path = machineConfigPath(),
): Promise<void> {
  const config = await readMachineConfig(path);
  await writeMachineConfig({ ...config, github: credentials }, path);
}

export async function configureMachine(
  credentials: GitHubCredentials,
  repositories: Repository[],
  path = machineConfigPath(),
): Promise<void> {
  await writeMachineConfig(
    {
      version: 1,
      github: credentials,
      repositories: repositories.map((repository) => repository.fullName).sort(),
    },
    path,
  );
}
