import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { access, chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { arch, homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { xdgConfigHome } from "./config-home.ts";
import { command } from "./process.ts";
import { updateInformant } from "./startup.ts";
import { dataDirectory } from "./store.ts";

const RELEASES_API = "https://api.github.com/repos/InformantDev/informant/releases/latest";
const UPDATE_LABEL = "dev.informant.updater";
const UPDATE_INTERVAL_SECONDS = 6 * 60 * 60;

interface ReleaseAsset {
  name: string;
  url: string;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface InformantRelease {
  tag: string;
  version: string;
  assets: ReleaseAsset[];
}

function versionParts(value: string): { core: number[]; prerelease?: string } | undefined {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4],
  };
}

export function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) throw new Error(`could not compare Informant versions ${left} and ${right}`);
  for (let index = 0; index < 3; index++) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true });
}

export async function latestInformantRelease(request: Fetch = fetch): Promise<InformantRelease> {
  const response = await request(RELEASES_API, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Informant updater",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`could not check for Informant updates: GitHub returned ${response.status}`);
  }
  const value = (await response.json()) as {
    tag_name?: unknown;
    draft?: unknown;
    prerelease?: unknown;
    assets?: Array<{ name?: unknown; browser_download_url?: unknown }>;
  };
  if (value.draft || value.prerelease || typeof value.tag_name !== "string") {
    throw new Error("could not check for Informant updates: invalid latest release");
  }
  const parsed = versionParts(value.tag_name);
  if (!parsed) throw new Error("could not check for Informant updates: invalid release version");
  const assets = (value.assets ?? []).flatMap((asset) =>
    typeof asset.name === "string" && typeof asset.browser_download_url === "string"
      ? [{ name: asset.name, url: asset.browser_download_url }]
      : [],
  );
  return { tag: value.tag_name, version: value.tag_name.replace(/^v/, ""), assets };
}

function releaseAsset(release: InformantRelease, name: string): ReleaseAsset {
  const asset = release.assets.find((candidate) => candidate.name === name);
  if (!asset) throw new Error(`Informant ${release.tag} does not include ${name}`);
  return asset;
}

async function download(asset: ReleaseAsset, request: Fetch): Promise<Uint8Array> {
  const response = await request(asset.url, { headers: { "User-Agent": "Informant updater" } });
  if (!response.ok) throw new Error(`could not download ${asset.name}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function installedExecutable(configured?: string): string {
  if (configured) return configured;
  if (basename(process.execPath) === "informant") return process.execPath;
  const executable = Bun.which("informant");
  if (executable) return executable;
  throw new Error("could not locate the installed Informant executable");
}

function updaterEnvironment(): Record<string, string> {
  const home = homedir();
  const environment: Record<string, string> = {
    HOME: home,
    PATH: Bun.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
  };
  if (Bun.env.XDG_CONFIG_HOME === xdgConfigHome(Bun.env, home)) {
    environment.XDG_CONFIG_HOME = Bun.env.XDG_CONFIG_HOME;
  }
  return environment;
}

export async function installLinuxRelease(
  release: InformantRelease,
  options: {
    arch?: string;
    executable?: string;
    fetch?: Fetch;
  } = {},
): Promise<void> {
  const machineArchitecture = options.arch ?? arch();
  if (machineArchitecture !== "x64" && machineArchitecture !== "arm64") {
    throw new Error(`Informant does not publish Linux updates for ${machineArchitecture}`);
  }
  const name = `informant-linux-${machineArchitecture}`;
  const binaryAsset = releaseAsset(release, name);
  const checksumAsset = releaseAsset(release, "SHA256SUMS");
  const request = options.fetch ?? fetch;
  const [binary, checksumBytes] = await Promise.all([
    download(binaryAsset, request),
    download(checksumAsset, request),
  ]);
  const checksums = new TextDecoder().decode(checksumBytes);
  const expected = checksums
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts.at(-1)?.replace(/^\*/, "") === name)?.[0];
  if (!expected || !/^[a-f\d]{64}$/i.test(expected)) {
    throw new Error(`Informant ${release.tag} does not include a valid checksum for ${name}`);
  }
  const actual = createHash("sha256").update(binary).digest("hex");
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`checksum verification failed for ${name}`);
  }

  const executable = installedExecutable(options.executable);
  const temporary = join(
    dirname(executable),
    `.${basename(executable)}.update-${crypto.randomUUID()}`,
  );
  try {
    await writeFile(temporary, binary, { flag: "wx", mode: 0o755 });
    await rename(temporary, executable);
  } catch (error) {
    throw new Error(
      `could not install Informant ${release.version} at ${executable}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await rm(temporary, { force: true });
  }
}

async function installMacRelease(
  release: InformantRelease,
  run: typeof command,
  onOutput?: (text: string) => Promise<void> | void,
): Promise<void> {
  const upgraded = await run(["brew", "upgrade", "informantdev/tap/informant"], { onOutput });
  if (upgraded.exitCode !== 0) {
    throw new Error(
      `could not update Informant with Homebrew: ${upgraded.stderr.trim() || `exit ${upgraded.exitCode}`}`,
    );
  }
  const installed = await run(["informant", "--version"]);
  if (
    installed.exitCode !== 0 ||
    !versionParts(installed.stdout.trim()) ||
    compareVersions(installed.stdout.trim(), release.version) < 0
  ) {
    throw new Error(
      `Homebrew did not install Informant ${release.version}; the formula may still be updating`,
    );
  }
}

export async function updateInformantIfAvailable(
  currentVersion: string,
  options: {
    command?: typeof command;
    executable?: string;
    fetch?: Fetch;
    installLinux?: (release: InformantRelease) => Promise<void>;
    onOutput?: (text: string) => Promise<void> | void;
    platform?: string;
    restartTimeoutMs?: number;
    sleep?: (milliseconds: number) => Promise<unknown>;
    uid?: number;
  } = {},
): Promise<{ updated: boolean; restarted: boolean; version: string }> {
  const release = await latestInformantRelease(options.fetch);
  if (compareVersions(release.version, currentVersion) <= 0) {
    return { updated: false, restarted: false, version: currentVersion };
  }
  const currentPlatform = options.platform ?? process.platform;
  const run = options.command ?? command;
  const install =
    currentPlatform === "linux"
      ? () =>
          options.installLinux?.(release) ??
          installLinuxRelease(release, {
            executable: options.executable,
            fetch: options.fetch,
          })
      : currentPlatform === "darwin"
        ? () => installMacRelease(release, run, options.onOutput)
        : undefined;
  const result = await updateInformant({
    command: run,
    install,
    onOutput: options.onOutput,
    platform: currentPlatform,
    restartTimeoutMs: options.restartTimeoutMs,
    sleep: options.sleep,
    uid: options.uid,
  });
  return { updated: true, restarted: result.restarted, version: release.version };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeSystemd(value: string): string {
  return value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function automaticUpdateServicePath(home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${UPDATE_LABEL}.plist`);
}

export function linuxAutomaticUpdatePaths(
  home = homedir(),
  environment: Record<string, string | undefined> = Bun.env,
): {
  service: string;
  timer: string;
} {
  const directory = join(xdgConfigHome(environment, home), "systemd", "user");
  return {
    service: join(directory, "informant-update.service"),
    timer: join(directory, "informant-update.timer"),
  };
}

export function renderAutomaticUpdateService(
  executable: string,
  environment: Record<string, string>,
  logs = dataDirectory(),
): string {
  const environmentXml = Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, value]) =>
        `      <key>${escapeXml(key)}</key>\n      <string>${escapeXml(value)}</string>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${UPDATE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(executable)}</string>
    <string>update</string>
    <string>--automatic</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${environmentXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${UPDATE_INTERVAL_SECONDS}</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(logs, "updater.stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(logs, "updater.stderr.log"))}</string>
</dict>
</plist>
`;
}

export function renderLinuxAutomaticUpdateService(
  executable: string,
  environment: Record<string, string>,
): string {
  const environmentLines = Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `Environment="${key}=${escapeSystemd(value)}"`)
    .join("\n");
  return `[Unit]
Description=Update Informant when a new release is available
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart="${escapeSystemd(executable)}" update --automatic
${environmentLines}
TimeoutStartSec=24h
`;
}

export function renderLinuxAutomaticUpdateTimer(): string {
  return `[Unit]
Description=Check for Informant updates

[Timer]
OnBootSec=5m
OnUnitInactiveSec=${UPDATE_INTERVAL_SECONDS}s
Persistent=true
Unit=informant-update.service

[Install]
WantedBy=timers.target
`;
}

async function existingDefinition(path: string): Promise<Uint8Array | undefined> {
  const file = Bun.file(path);
  return (await file.exists()) ? new Uint8Array(await file.arrayBuffer()) : undefined;
}

async function restoreDefinition(path: string, source: Uint8Array | undefined): Promise<void> {
  if (!source) {
    await rm(path, { force: true });
    return;
  }
  await writeFile(path, source, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function enableAutomaticUpdates(
  options: {
    command?: typeof command;
    environment?: Record<string, string>;
    executable?: string;
    home?: string;
    logs?: string;
    platform?: string;
    uid?: number;
  } = {},
): Promise<string> {
  const currentPlatform = options.platform ?? process.platform;
  const run = options.command ?? command;
  const executable = installedExecutable(options.executable);
  const environment = options.environment ?? updaterEnvironment();
  if (currentPlatform === "darwin") {
    const path = automaticUpdateServicePath(options.home);
    const logs = options.logs ?? dataDirectory();
    const previous = await existingDefinition(path);
    await mkdir(dirname(path), { recursive: true });
    await mkdir(logs, { recursive: true });
    await Bun.write(path, renderAutomaticUpdateService(executable, environment, logs));
    await chmod(path, 0o600);
    const uid = options.uid ?? process.getuid?.();
    if (uid === undefined) throw new Error("could not determine the current user ID");
    const domain = `gui/${uid}`;
    await run(["launchctl", "bootout", domain, path]);
    const loaded = await run(["launchctl", "bootstrap", domain, path]);
    if (loaded.exitCode !== 0) {
      await restoreDefinition(path, previous);
      if (previous) await run(["launchctl", "bootstrap", domain, path]);
      throw new Error(
        `could not enable automatic Informant updates: ${loaded.stderr.trim() || "launchctl failed"}`,
      );
    }
    return path;
  }
  if (currentPlatform === "linux") {
    try {
      await access(dirname(executable), constants.W_OK);
    } catch {
      throw new Error(
        `automatic Informant updates require a user-writable install; reinstall Informant under ${join(options.home ?? homedir(), ".local", "bin")}`,
      );
    }
    const paths = linuxAutomaticUpdatePaths(options.home, environment);
    await mkdir(dirname(paths.service), { recursive: true });
    const [previousService, previousTimer] = await Promise.all([
      existingDefinition(paths.service),
      existingDefinition(paths.timer),
    ]);
    await Bun.write(paths.service, renderLinuxAutomaticUpdateService(executable, environment));
    await Bun.write(paths.timer, renderLinuxAutomaticUpdateTimer());
    await Promise.all([chmod(paths.service, 0o600), chmod(paths.timer, 0o600)]);
    const reloaded = await run(["systemctl", "--user", "daemon-reload"]);
    let failure = reloaded;
    if (reloaded.exitCode === 0) {
      const enabled = await run([
        "systemctl",
        "--user",
        "enable",
        "--now",
        "informant-update.timer",
      ]);
      if (enabled.exitCode === 0) return paths.timer;
      failure = enabled;
    }
    await Promise.all([
      restoreDefinition(paths.service, previousService),
      restoreDefinition(paths.timer, previousTimer),
    ]);
    await run(["systemctl", "--user", "daemon-reload"]);
    throw new Error(
      `could not enable automatic Informant updates: Linux requires a running systemd user manager (${failure.stderr.trim() || "systemctl failed"})`,
    );
  }
  throw new Error("automatic Informant updates are supported only on macOS and Linux");
}

export async function disableAutomaticUpdates(
  options: {
    command?: typeof command;
    environment?: Record<string, string | undefined>;
    home?: string;
    platform?: string;
    uid?: number;
  } = {},
): Promise<boolean> {
  const currentPlatform = options.platform ?? process.platform;
  const run = options.command ?? command;
  if (currentPlatform === "darwin") {
    const path = automaticUpdateServicePath(options.home);
    const existed = existsSync(path);
    const uid = options.uid ?? process.getuid?.();
    if (uid === undefined) throw new Error("could not determine the current user ID");
    const domain = `gui/${uid}`;
    const result = await run(["launchctl", "bootout", domain, path]);
    if (result.exitCode !== 0) {
      if (!existed) return false;
      throw new Error(
        `could not disable automatic Informant updates: ${result.stderr.trim() || `launchctl exited ${result.exitCode}`}`,
      );
    }
    await rm(path, { force: true });
    return true;
  }
  if (currentPlatform === "linux") {
    const paths = linuxAutomaticUpdatePaths(options.home, options.environment);
    const existed = existsSync(paths.service) || existsSync(paths.timer);
    const result = await run(["systemctl", "--user", "disable", "--now", "informant-update.timer"]);
    if (result.exitCode !== 0) {
      if (!existed) return false;
      throw new Error(
        `could not disable automatic Informant updates: ${result.stderr.trim() || `systemctl exited ${result.exitCode}`}`,
      );
    }
    await Promise.all([rm(paths.service, { force: true }), rm(paths.timer, { force: true })]);
    await run(["systemctl", "--user", "daemon-reload"]);
    return true;
  }
  throw new Error("automatic Informant updates are supported only on macOS and Linux");
}
