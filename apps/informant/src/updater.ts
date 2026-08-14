import { createHash } from "node:crypto";
import { constants, existsSync, realpathSync } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { basename, dirname, join } from "node:path";
import { exchangeFilePaths } from "./atomic-rename.ts";
import { xdgConfigHome } from "./config-home.ts";
import { command } from "./process.ts";
import { updateInformant } from "./startup.ts";
import { dataDirectory } from "./store.ts";

const RELEASES_API = "https://api.github.com/repos/InformantDev/informant/releases/latest";
const HOMEBREW_FORMULA = "informantdev/tap/informant";
const UPDATE_LABEL = "dev.informant.updater";
const UPDATE_INTERVAL_SECONDS = 6 * 60 * 60;
const UPDATE_HTTP_TIMEOUT_MS = 60_000;
const HOMEBREW_UPGRADE_TIMEOUT_MS = 60 * 60_000;
const UPDATE_LOCK_RETRY_MS = 100;

export const automaticUpdateLockPath = (home = homedir()) =>
  join(home, ".cache", "informant", "updater.lock");

interface ReleaseAsset {
  name: string;
  url: string;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function updaterTimeoutError(action: string, cause: unknown): Error {
  return new Error(`${action} timed out after ${UPDATE_HTTP_TIMEOUT_MS / 1_000} seconds`, {
    cause,
  });
}

async function boundedFetch(
  request: Fetch,
  input: string | URL | Request,
  init: RequestInit,
  action: string,
): Promise<{ response: Response; signal: AbortSignal }> {
  const signal = AbortSignal.timeout(UPDATE_HTTP_TIMEOUT_MS);
  try {
    return { response: await request(input, { ...init, signal }), signal };
  } catch (error) {
    if (signal.aborted) throw updaterTimeoutError(action, error);
    throw error;
  }
}

async function readBoundedResponse<T>(
  signal: AbortSignal,
  action: string,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (signal.aborted) throw updaterTimeoutError(action, error);
    throw error;
  }
}

interface UpdateLockOwner {
  pid: number;
  processIdentity: string;
  token: string;
}

async function processIdentity(pid: number): Promise<string | undefined> {
  if (platform() === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const startTime = fields[19];
      return startTime ? `linux:${startTime}` : undefined;
    } catch {
      return undefined;
    }
  }
  const result = await command(["ps", "-p", String(pid), "-o", "lstart="]);
  const startedAt = result.exitCode === 0 ? result.stdout.trim() : "";
  return startedAt ? `${platform()}:${startedAt}` : undefined;
}

async function updateLockOwner(path: string): Promise<UpdateLockOwner | undefined> {
  try {
    const value = (await Bun.file(join(path, "owner.json")).json()) as {
      pid?: unknown;
      processIdentity?: unknown;
      token?: unknown;
    };
    return Number.isSafeInteger(value.pid) &&
      typeof value.processIdentity === "string" &&
      typeof value.token === "string"
      ? {
          pid: value.pid as number,
          processIdentity: value.processIdentity,
          token: value.token,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function sameUpdateLockOwner(
  left: UpdateLockOwner | undefined,
  right: UpdateLockOwner | undefined,
): boolean {
  return (
    left?.pid === right?.pid &&
    left?.processIdentity === right?.processIdentity &&
    left?.token === right?.token
  );
}

async function acquireUpdateLock(path: string): Promise<string> {
  const token = crypto.randomUUID();
  const identity = await processIdentity(process.pid);
  if (!identity) throw new Error("could not determine updater process identity");
  const candidate = `${path}.${token}`;
  while (true) {
    await mkdir(candidate, { mode: 0o700 });
    try {
      await Bun.write(
        join(candidate, "owner.json"),
        JSON.stringify({ pid: process.pid, processIdentity: identity, token }),
      );
      try {
        await rename(candidate, path);
        return token;
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          throw error;
        }
      }

      const expected = await updateLockOwner(path);
      if (expected && (await processIdentity(expected.pid)) === expected.processIdentity) {
        await Bun.sleep(UPDATE_LOCK_RETRY_MS);
        continue;
      }

      // Exchange keeps the lock pathname continuously occupied. If another
      // process replaced the stale generation after it was inspected, restore
      // that generation atomically instead of displacing its live lock.
      try {
        exchangeFilePaths(path, candidate);
      } catch (error) {
        if (sameUpdateLockOwner(await updateLockOwner(path), expected)) throw error;
        continue;
      }
      const displaced = await updateLockOwner(candidate);
      if (sameUpdateLockOwner(displaced, expected)) return token;
      exchangeFilePaths(path, candidate);
      await Bun.sleep(UPDATE_LOCK_RETRY_MS);
    } finally {
      await rm(candidate, { recursive: true, force: true });
    }
  }
}

async function withUpdateLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const token = await acquireUpdateLock(path);
  // Older versions used this bare directory as a recovery mutex. It is safe to
  // remove after acquiring the owned lock, and it must not block new updates.
  await rm(`${path}.recovery`, { recursive: true, force: true });
  try {
    return await operation();
  } finally {
    if ((await updateLockOwner(path))?.token === token) {
      await rm(path, { recursive: true, force: true });
    }
  }
}

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

export function reportedInformantVersion(output: string): string | undefined {
  const firstLine = output.split(/\r?\n/, 1)[0]?.trim();
  return firstLine && versionParts(firstLine) ? firstLine : undefined;
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
  const { response, signal } = await boundedFetch(
    request,
    RELEASES_API,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Informant updater",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
    "checking for Informant updates",
  );
  if (!response.ok) {
    throw new Error(`could not check for Informant updates: GitHub returned ${response.status}`);
  }
  const value = await readBoundedResponse(
    signal,
    "checking for Informant updates",
    async () =>
      (await response.json()) as {
        tag_name?: unknown;
        draft?: unknown;
        prerelease?: unknown;
        assets?: Array<{ name?: unknown; browser_download_url?: unknown }>;
      },
  );
  if (value.draft || value.prerelease || typeof value.tag_name !== "string") {
    throw new Error("could not check for Informant updates: invalid latest release");
  }
  const parsed = versionParts(value.tag_name);
  if (!parsed || parsed.prerelease) {
    throw new Error("could not check for Informant updates: invalid stable release version");
  }
  const assets = (value.assets ?? []).flatMap((asset) =>
    typeof asset.name === "string" && typeof asset.browser_download_url === "string"
      ? [{ name: asset.name, url: asset.browser_download_url }]
      : [],
  );
  return {
    tag: value.tag_name,
    version: value.tag_name.replace(/^v/, ""),
    assets,
  };
}

function releaseAsset(release: InformantRelease, name: string): ReleaseAsset {
  const asset = release.assets.find((candidate) => candidate.name === name);
  if (!asset) throw new Error(`Informant ${release.tag} does not include ${name}`);
  return asset;
}

async function download(asset: ReleaseAsset, request: Fetch): Promise<Uint8Array> {
  const { response, signal } = await boundedFetch(
    request,
    asset.url,
    { headers: { "User-Agent": "Informant updater" } },
    `downloading ${asset.name}`,
  );
  if (!response.ok) throw new Error(`could not download ${asset.name}: HTTP ${response.status}`);
  return new Uint8Array(
    await readBoundedResponse(signal, `downloading ${asset.name}`, () => response.arrayBuffer()),
  );
}

export function resolveInformantExecutable(
  platform: string,
  configured?: string,
  operations: {
    processExecutable?: string;
    which?: (name: string) => string | null;
  } = {},
): string {
  if (configured) return configured;
  const running = operations.processExecutable ?? process.execPath;
  const executable = (operations.which ?? Bun.which)("informant");
  if (executable) {
    try {
      if (realpathSync(running) === realpathSync(executable)) return executable;
    } catch {
      // Missing or inaccessible candidates fall through to the platform defaults below.
    }
  }
  if (platform === "darwin" && executable) return executable;
  if (basename(running) === "informant") return running;
  if (executable) return executable;
  throw new Error("could not locate the installed Informant executable");
}

export function updaterEnvironment(
  source: Record<string, string | undefined> = Bun.env,
  home = homedir(),
): Record<string, string> {
  const environment: Record<string, string> = {
    HOME: home,
    PATH: source.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
  };
  if (source.XDG_CONFIG_HOME === xdgConfigHome(source, home)) {
    environment.XDG_CONFIG_HOME = source.XDG_CONFIG_HOME;
  }
  if (source.INFORMANT_DATA_DIR !== undefined) {
    environment.INFORMANT_DATA_DIR = source.INFORMANT_DATA_DIR;
  }
  return environment;
}

export async function installLinuxRelease(
  release: InformantRelease,
  options: {
    arch?: string;
    command?: typeof command;
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

  const executable = resolveInformantExecutable("linux", options.executable);
  const temporary = join(
    dirname(executable),
    `.${basename(executable)}.update-${crypto.randomUUID()}`,
  );
  try {
    const temporaryFile = await open(temporary, "wx", 0o755);
    try {
      await temporaryFile.writeFile(binary);
      await temporaryFile.sync();
    } finally {
      await temporaryFile.close();
    }
    const validation = await (options.command ?? command)([temporary, "--version"], {
      timeoutMs: 30_000,
    });
    const reportedVersion = reportedInformantVersion(validation.stdout);
    if (validation.exitCode !== 0 || validation.timedOut || reportedVersion !== release.version) {
      throw new Error(
        `downloaded binary reported ${reportedVersion || validation.stdout.trim() || validation.stderr.trim() || `exit ${validation.exitCode}`} instead of ${release.version}`,
      );
    }
    await rename(temporary, executable);
    await syncDirectory(dirname(executable));
  } catch (error) {
    throw new Error(
      `could not install Informant ${release.version} at ${executable}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await rm(temporary, { force: true });
  }
}

async function homebrewInformantExecutable(
  executable: string,
  run: typeof command,
): Promise<string | undefined> {
  const installed = await realpath(executable).catch((error) => {
    throw new Error(`could not inspect the installed Informant executable at ${executable}`, {
      cause: error,
    });
  });
  const appearsHomebrewManaged = installed.split("/").includes("Cellar");
  const prefixResult = await run(["brew", "--prefix", HOMEBREW_FORMULA]);
  const prefix = prefixResult.stdout.trim();
  if (prefixResult.exitCode !== 0 || !prefix) {
    if (appearsHomebrewManaged) {
      throw new Error(
        `could not inspect the Homebrew Informant installation: ${prefixResult.stderr.trim() || `brew --prefix exited ${prefixResult.exitCode}`}`,
      );
    }
    return undefined;
  }
  const homebrewExecutable = join(prefix, "bin", "informant");
  const candidate = await realpath(homebrewExecutable).catch((error) => {
    if (appearsHomebrewManaged) {
      throw new Error(`could not inspect the Homebrew executable at ${homebrewExecutable}`, {
        cause: error,
      });
    }
    return undefined;
  });
  return installed === candidate ? homebrewExecutable : undefined;
}

async function syncDirectory(path: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directory = await open(path, "r");
    await directory.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally {
    await directory?.close();
  }
}

async function installHomebrewRelease(
  release: InformantRelease,
  run: typeof command,
  onOutput?: (text: string) => Promise<void> | void,
  executable = "informant",
): Promise<void> {
  const upgraded = await run(["brew", "upgrade", HOMEBREW_FORMULA], {
    onOutput,
    timeoutMs: HOMEBREW_UPGRADE_TIMEOUT_MS,
  });
  if (upgraded.exitCode !== 0 || upgraded.timedOut) {
    throw new Error(
      `could not update Informant with Homebrew: ${upgraded.timedOut ? `timed out after ${HOMEBREW_UPGRADE_TIMEOUT_MS / 60_000} minutes` : upgraded.stderr.trim() || `exit ${upgraded.exitCode}`}`,
    );
  }
  const installed = await run([executable, "--version"]);
  const installedVersion = reportedInformantVersion(installed.stdout);
  if (
    installed.exitCode !== 0 ||
    !installedVersion ||
    compareVersions(installedVersion, release.version) !== 0
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
    pendingRestartFile?: string;
    platform?: string;
    restartTimeoutMs?: number;
    sleep?: (milliseconds: number) => Promise<unknown>;
    uid?: number;
    updateLockDirectory?: string;
  } = {},
): Promise<{ updated: boolean; restarted: boolean; version: string }> {
  const pendingRestartFile =
    options.pendingRestartFile ?? join(dataDirectory(), "update-pending-restart");
  const lockDirectory = options.updateLockDirectory ?? automaticUpdateLockPath();
  return withUpdateLock(lockDirectory, async () => {
    const release = await latestInformantRelease(options.fetch);
    const currentPlatform = options.platform ?? process.platform;
    const run = options.command ?? command;
    const pendingRestartState = Bun.file(pendingRestartFile);
    const pendingRestart = (await pendingRestartState.exists())
      ? await pendingRestartState.text()
      : undefined;
    const updateAvailable = compareVersions(release.version, currentVersion) > 0;
    const retryRestart = !updateAvailable && pendingRestart?.trim() === currentVersion;
    if (!updateAvailable && !retryRestart) {
      return { updated: false, restarted: false, version: currentVersion };
    }
    const install = retryRestart
      ? async () => {}
      : currentPlatform === "linux"
        ? async () => {
            if (options.installLinux) return options.installLinux(release);
            const executable = resolveInformantExecutable("linux", options.executable);
            const homebrewExecutable = await homebrewInformantExecutable(executable, run);
            if (homebrewExecutable) {
              return installHomebrewRelease(release, run, options.onOutput, homebrewExecutable);
            }
            return installLinuxRelease(release, {
              command: run,
              executable,
              fetch: options.fetch,
            });
          }
        : currentPlatform === "darwin"
          ? () => installHomebrewRelease(release, run, options.onOutput)
          : undefined;
    if (!retryRestart) {
      await mkdir(dirname(pendingRestartFile), { recursive: true });
      await Bun.write(pendingRestartFile, `${release.version}\n`);
    }
    const result = await updateInformant({
      command: run,
      install,
      onOutput: options.onOutput,
      platform: currentPlatform,
      restartTimeoutMs: options.restartTimeoutMs,
      sleep: options.sleep,
      uid: options.uid,
    });
    await rm(pendingRestartFile, { force: true });
    return {
      updated: !retryRestart,
      restarted: result.restarted,
      version: retryRestart ? currentVersion : release.version,
    };
  });
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
  return value
    .replaceAll("%", "%%")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
}

function escapeSystemdCommand(value: string): string {
  return escapeSystemd(value).replaceAll("$", () => "$$");
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
ExecStart="${escapeSystemdCommand(executable)}" update --automatic
${environmentLines}
TimeoutStartSec=25h
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
  const executable = resolveInformantExecutable(currentPlatform, options.executable);
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
    const previouslyEnabled =
      (await run(["systemctl", "--user", "is-enabled", "informant-update.timer"])).exitCode === 0;
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
      if (!previouslyEnabled) {
        await run(["systemctl", "--user", "disable", "--now", "informant-update.timer"]);
      }
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
      const message = result.stderr.toLowerCase();
      const alreadyUnloaded =
        result.exitCode === 3 ||
        message.includes("no such process") ||
        message.includes("could not find service") ||
        message.includes("not loaded") ||
        message.includes("not found");
      if (!alreadyUnloaded) {
        throw new Error(
          `could not disable automatic Informant updates: ${result.stderr.trim() || `launchctl exited ${result.exitCode}`}`,
        );
      }
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
