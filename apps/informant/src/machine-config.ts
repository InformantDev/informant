import { lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { parseRepository } from "./config.ts";
import { xdgConfigHome } from "./config-home.ts";
import type { Repository } from "./types.ts";

export interface GitHubCredentials {
  account?: string;
  appId: string;
  installationId: string;
  privateKeyFile: string;
}

export const MAX_ALLOWED_MOUNT_BYTES = 1024 * 1024;

interface MachineConfig {
  version: 1;
  repositories: string[];
  automaticUpdates?: boolean;
  allowedMounts?: Record<string, string>;
  githubApps?: GitHubCredentials[];
  /** Legacy single-installation configuration. */
  github?: GitHubCredentials;
}

export function machineConfigPath(
  environment: Record<string, string | undefined> = Bun.env,
  home = homedir(),
): string {
  return (
    environment.INFORMANT_CONFIG_FILE ??
    join(xdgConfigHome(environment, home), "informant", "config.json")
  );
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
  if (value.automaticUpdates !== undefined && typeof value.automaticUpdates !== "boolean") {
    throw new Error(`invalid Informant config: ${path}`);
  }
  if (
    value.allowedMounts !== undefined &&
    (!value.allowedMounts ||
      typeof value.allowedMounts !== "object" ||
      Array.isArray(value.allowedMounts) ||
      Object.entries(value.allowedMounts).some(
        ([name, source]) =>
          !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ||
          typeof source !== "string" ||
          !isAbsolute(source),
      ))
  )
    throw new Error(`invalid allowed mounts in Informant config: ${path}`);
  return {
    version: value.version,
    repositories: value.repositories.map(String),
    automaticUpdates: value.automaticUpdates,
    allowedMounts: value.allowedMounts,
    githubApps: Array.isArray(value.githubApps) ? value.githubApps : undefined,
    github: value.github,
  };
}

export async function automaticUpdatesPreference(
  path = machineConfigPath(),
): Promise<boolean | undefined> {
  return (await readMachineConfig(path)).automaticUpdates;
}

export async function saveAutomaticUpdatesPreference(
  enabled: boolean,
  path = machineConfigPath(),
): Promise<void> {
  const config = await readMachineConfig(path);
  await writeMachineConfig({ ...config, automaticUpdates: enabled }, path);
}

export async function listAllowedMounts(
  path = machineConfigPath(),
): Promise<Array<{ name: string; source: string }>> {
  const config = await readMachineConfig(path);
  return Object.entries(config.allowedMounts ?? {})
    .map(([name, source]) => ({ name, source }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function allowMount(
  name: string,
  source: string,
  path = machineConfigPath(),
): Promise<void> {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name))
    throw new Error(
      "mount name must contain only lowercase letters, numbers, dots, underscores, and dashes",
    );
  const canonical = await realpath(source).catch(() => undefined);
  const metadata = canonical ? await lstat(canonical) : undefined;
  if (!canonical || !metadata?.isFile())
    throw new Error(`allowed mount source must be an existing file: ${source}`);
  if (metadata.size > MAX_ALLOWED_MOUNT_BYTES)
    throw new Error(`allowed mount source exceeds ${MAX_ALLOWED_MOUNT_BYTES} bytes: ${source}`);
  const config = await readMachineConfig(path);
  await writeMachineConfig(
    {
      ...config,
      allowedMounts: { ...config.allowedMounts, [name]: canonical },
    },
    path,
  );
}

export async function removeAllowedMount(
  name: string,
  path = machineConfigPath(),
): Promise<boolean> {
  const config = await readMachineConfig(path);
  if (!Object.hasOwn(config.allowedMounts ?? {}, name)) return false;
  const allowedMounts = { ...config.allowedMounts };
  delete allowedMounts[name];
  await writeMachineConfig({ ...config, allowedMounts }, path);
  return true;
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

function configuredApps(config: MachineConfig): GitHubCredentials[] {
  const apps = [...(config.githubApps ?? [])];
  if (
    config.github &&
    !apps.some(
      (credentials) =>
        credentials.appId === config.github?.appId &&
        credentials.installationId === config.github.installationId,
    )
  ) {
    apps.push(config.github);
  }
  return apps;
}

export async function listGitHubCredentials(
  path = machineConfigPath(),
): Promise<GitHubCredentials[]> {
  return configuredApps(await readMachineConfig(path));
}

export async function getGitHubCredentials(
  repository?: Repository,
  path = machineConfigPath(),
): Promise<GitHubCredentials | undefined> {
  const apps = configuredApps(await readMachineConfig(path));
  if (!repository) return apps.length === 1 ? apps[0] : undefined;
  const match = apps.find(
    (credentials) => credentials.account?.toLowerCase() === repository.owner.toLowerCase(),
  );
  if (match) return match;
  if (apps.length === 1 && !apps[0]?.account) return apps[0];
  const accounts = apps.flatMap((credentials) =>
    credentials.account ? [credentials.account] : [],
  );
  throw new Error(
    accounts.length
      ? `no GitHub App configured for ${repository.owner}; configured accounts: ${accounts.join(", ")}`
      : `no GitHub App configured for ${repository.owner}; run informant setup`,
  );
}

export async function saveGitHubCredentials(
  credentials: GitHubCredentials,
  path = machineConfigPath(),
): Promise<void> {
  const config = await readMachineConfig(path);
  const apps = configuredApps(config).filter(
    (existing) =>
      (existing.account === undefined ||
        credentials.account === undefined ||
        existing.account.toLowerCase() !== credentials.account.toLowerCase()) &&
      !(
        existing.appId === credentials.appId &&
        existing.installationId === credentials.installationId
      ),
  );
  apps.push(credentials);
  apps.sort((left, right) => (left.account ?? "").localeCompare(right.account ?? ""));
  const { github: _legacy, ...current } = config;
  await writeMachineConfig({ ...current, githubApps: apps }, path);
}
