import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { xdgConfigHome } from "./config-home.ts";
import { command } from "./process.ts";
import { dataDirectory, runningWorkerPids } from "./store.ts";

const LABEL = "dev.informant.worker";
const GRACEFUL_RESTART_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const RESTART_POLL_INTERVAL_MS = 1_000;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function startupServicePath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

export function linuxStartupServicePath(home = homedir()): string {
  return join(home, ".config", "systemd", "user", "informant.service");
}

export interface SystemdPodmanSandboxConflict {
  scope: "system" | "user" | "user-manager";
  unit: string;
  setting: "ProtectKernelTunables" | "ProtectHostname";
  fragmentPath?: string;
}

function systemdProperties(source: string): Record<string, string> {
  return Object.fromEntries(
    source
      .split("\n")
      .map((line) => line.split("=", 2))
      .filter((entry): entry is [string, string] => entry.length === 2 && Boolean(entry[0])),
  );
}

export function systemdWorkerUnitsFromCgroup(
  source: string,
): Array<{ scope: "system" | "user"; unit: string }> {
  const units = new Map<string, { scope: "system" | "user"; unit: string }>();
  for (const line of source.split("\n")) {
    const path = line.slice(line.indexOf("::") + 2);
    if (!path.startsWith("/")) continue;
    const scope = path.includes("/user.slice/") ? "user" : "system";
    for (const unit of path.split("/").filter((part) => part.endsWith(".service"))) {
      if (unit.startsWith("user@")) continue;
      units.set(`${scope}:${unit}`, { scope, unit });
    }
  }
  return [...units.values()];
}

export async function systemdPodmanSandboxConflict(
  options: {
    platform?: NodeJS.Platform;
    uid?: number;
    command?: typeof command;
    workerCgroups?: string[];
  } = {},
): Promise<SystemdPodmanSandboxConflict | undefined> {
  if ((options.platform ?? process.platform) !== "linux") return undefined;
  const run = options.command ?? command;
  const inspect = async (
    scope: "system" | "user",
    unit: string,
  ): Promise<Record<string, string> | undefined> => {
    const result = await run(
      [
        "systemctl",
        `--${scope}`,
        "show",
        unit,
        "--property=LoadState,ActiveState,MainPID,ProtectKernelTunables,ProtectHostname,FragmentPath",
        "--no-pager",
      ],
      { timeoutMs: 5_000 },
    );
    return result.exitCode === 0 && !result.timedOut ? systemdProperties(result.stdout) : undefined;
  };
  const conflict = (
    scope: SystemdPodmanSandboxConflict["scope"],
    unit: string,
    properties: Record<string, string> | undefined,
  ): SystemdPodmanSandboxConflict | undefined => {
    if (
      properties?.LoadState !== "loaded" ||
      properties.ActiveState !== "active" ||
      !Number(properties.MainPID)
    ) {
      return undefined;
    }
    const setting = (["ProtectKernelTunables", "ProtectHostname"] as const).find(
      (name) => properties[name] === "yes",
    );
    return setting
      ? { scope, unit, setting, fragmentPath: properties.FragmentPath || undefined }
      : undefined;
  };

  const system = conflict(
    "system",
    "informant.service",
    await inspect("system", "informant.service"),
  );
  if (system) return system;
  const userProperties = await inspect("user", "informant.service");
  const user = conflict("user", "informant.service", userProperties);
  if (user) return user;
  if (
    userProperties?.LoadState === "loaded" &&
    userProperties.ActiveState === "active" &&
    Number(userProperties.MainPID)
  ) {
    const uid = options.uid ?? process.getuid?.();
    if (uid !== undefined) {
      const managerUnit = `user@${uid}.service`;
      const manager = conflict("user-manager", managerUnit, await inspect("system", managerUnit));
      if (manager) return manager;
    }
  }

  const workerCgroups =
    options.workerCgroups ??
    (await Promise.all(
      (
        await runningWorkerPids()
      ).map((pid) => readFile(`/proc/${pid}/cgroup`, "utf8").catch(() => "")),
    ));
  for (const { scope, unit } of workerCgroups.flatMap(systemdWorkerUnitsFromCgroup)) {
    if (unit === "informant.service") continue;
    const discovered = conflict(scope, unit, await inspect(scope, unit));
    if (discovered) return discovered;
  }
  return undefined;
}

export function systemdPodmanSandboxMessage(conflict: SystemdPodmanSandboxConflict): string {
  const location = conflict.fragmentPath ? ` (${conflict.fragmentPath})` : "";
  const edit =
    conflict.scope === "user"
      ? `systemctl --user edit ${conflict.unit}`
      : `sudo systemctl edit ${conflict.unit}`;
  const restart =
    conflict.scope === "user-manager"
      ? "reload systemd, then restart the user manager (or log out and back in) before restarting the worker"
      : "reload systemd and restart the worker";
  const effect =
    conflict.setting === "ProtectKernelTunables"
      ? "makes /proc/sys read-only"
      : "blocks the nested container hostname syscall";
  return `${conflict.scope} unit ${conflict.unit}${location} sets ${conflict.setting}=yes, which ${effect} inside rootless Podman; set ${conflict.setting}=no with \`${edit}\`, ${restart}`;
}

export function renderStartupService(
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
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(executable)}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${environmentXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ExitTimeOut</key>
  <integer>86400</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>SoftResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key>
    <integer>65536</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(logs, "worker.stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(logs, "worker.stderr.log"))}</string>
</dict>
</plist>
`;
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

export function renderLinuxStartupService(
  executable: string,
  environment: Record<string, string>,
  logs = dataDirectory(),
): string {
  const environmentLines = Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `Environment="${key}=${escapeSystemd(value)}"`)
    .join("\n");
  return `[Unit]
Description=Informant CI worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart="${escapeSystemd(executable)}" serve
${environmentLines}
Restart=always
RestartSec=10
TimeoutStopSec=24h
LimitNOFILE=65536
StandardOutput=append:${escapeSystemd(join(logs, "worker.stdout.log"))}
StandardError=append:${escapeSystemd(join(logs, "worker.stderr.log"))}

[Install]
WantedBy=default.target
`;
}

function launchDomain(configuredUid?: number): string {
  const uid = configuredUid ?? process.getuid?.();
  if (uid === undefined) throw new Error("could not determine the current user ID");
  return `gui/${uid}`;
}

function servicePid(output: string): number | undefined {
  const pid = Number(output.match(/\bpid = (\d+)/)?.[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

export function parseStartupEnvironment(output: string): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("could not preserve Informant startup environment: invalid property list");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.values(value).some((item) => typeof item !== "string")
  ) {
    throw new Error("could not preserve Informant startup environment: invalid property list");
  }
  return value as Record<string, string>;
}

export function startupEnvironment(
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
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith("INFORMANT_") && value !== undefined) environment[key] = value;
  }
  return environment;
}

async function writeStartupServiceDefinition(environment = startupEnvironment()): Promise<string> {
  const executable =
    Bun.which("informant") ??
    (basename(process.execPath) === "informant" ? process.execPath : null);
  if (!executable) {
    throw new Error("informant must be installed on PATH before enabling startup");
  }
  const path = startupServicePath();
  const logs = dataDirectory();
  await mkdir(dirname(path), { recursive: true });
  await mkdir(logs, { recursive: true });
  await Bun.write(path, renderStartupService(executable, environment, logs));
  await chmod(path, 0o600);
  return path;
}

async function writeLinuxStartupServiceDefinition(
  environment = startupEnvironment(),
): Promise<string> {
  const executable =
    Bun.which("informant") ??
    (basename(process.execPath) === "informant" ? process.execPath : null);
  if (!executable) {
    throw new Error("informant must be installed on PATH before enabling startup");
  }
  const path = linuxStartupServicePath();
  const logs = dataDirectory();
  await mkdir(dirname(path), { recursive: true });
  await mkdir(logs, { recursive: true });
  await Bun.write(path, renderLinuxStartupService(executable, environment, logs));
  await chmod(path, 0o600);
  return path;
}

async function migrateStartupServiceDefinition(
  runCommand = command,
  writeDefinition: (
    environment: Record<string, string>,
  ) => Promise<unknown> = writeStartupServiceDefinition,
): Promise<unknown> {
  const path = startupServicePath();
  const captured = await runCommand([
    "plutil",
    "-extract",
    "EnvironmentVariables",
    "json",
    "-o",
    "-",
    path,
  ]);
  if (captured.exitCode !== 0) {
    throw new Error(
      `could not preserve Informant startup environment: ${captured.stderr.trim() || `exit ${captured.exitCode}`}`,
    );
  }
  return writeDefinition(parseStartupEnvironment(captured.stdout));
}

export async function enableStartup(): Promise<string> {
  if (process.platform === "linux") {
    const path = await writeLinuxStartupServiceDefinition();
    const reloaded = await command(["systemctl", "--user", "daemon-reload"]);
    if (reloaded.exitCode !== 0) {
      await rm(path, { force: true });
      throw new Error(
        `could not enable Informant: Linux startup requires a running systemd user manager (${reloaded.stderr.trim() || "systemctl failed"})`,
      );
    }
    const started = await command(["systemctl", "--user", "enable", "--now", "informant.service"]);
    if (started.exitCode !== 0) {
      throw new Error(`could not start Informant: ${started.stderr.trim() || "systemctl failed"}`);
    }
    return path;
  }
  if (process.platform !== "darwin") throw new Error("startup services are not supported here");
  const path = await writeStartupServiceDefinition();

  const domain = launchDomain();
  await command(["launchctl", "bootout", domain, path]);
  await command(["launchctl", "enable", `${domain}/${LABEL}`]);
  const result = await command(["launchctl", "bootstrap", domain, path]);
  if (result.exitCode !== 0) {
    throw new Error(`could not start Informant: ${result.stderr.trim() || "launchctl failed"}`);
  }
  return path;
}

export async function disableStartup(): Promise<{ path: string; disabled: boolean }> {
  if (process.platform === "linux") {
    const path = linuxStartupServicePath();
    const existed = existsSync(path);
    const result = await command(["systemctl", "--user", "disable", "--now", "informant.service"]);
    await rm(path, { force: true });
    await command(["systemctl", "--user", "daemon-reload"]);
    return { path, disabled: existed || result.exitCode === 0 };
  }
  if (process.platform !== "darwin") throw new Error("startup services are not supported here");
  const path = startupServicePath();
  const existed = existsSync(path);
  const result = await command(["launchctl", "bootout", launchDomain(), path]);
  await rm(path, { force: true });
  return { path, disabled: existed || result.exitCode === 0 };
}

export async function restartStartupWorker(
  options: {
    command?: typeof command;
    platform?: string;
    uid?: number;
    sleep?: (milliseconds: number) => Promise<unknown>;
    timeoutMs?: number;
  } = {},
): Promise<boolean> {
  const run = options.command ?? command;
  if ((options.platform ?? process.platform) === "linux") {
    const active = await run(["systemctl", "--user", "is-active", "--quiet", "informant.service"]);
    if (active.exitCode !== 0) return false;
    const restarted = await run(["systemctl", "--user", "restart", "informant.service"]);
    if (restarted.exitCode !== 0) {
      throw new Error(
        `could not restart Informant: ${restarted.stderr.trim() || "systemctl failed"}`,
      );
    }
    return true;
  }
  if ((options.platform ?? process.platform) !== "darwin") return false;
  const service = `${launchDomain(options.uid)}/${LABEL}`;
  const initial = await run(["launchctl", "print", service]);
  if (initial.exitCode !== 0) return false;
  const previousPid = servicePid(initial.stdout);
  const restart = await run(
    previousPid ? ["kill", "-TERM", String(previousPid)] : ["launchctl", "kickstart", service],
  );
  if (restart.exitCode !== 0) {
    throw new Error(
      `could not restart Informant: ${restart.stderr.trim() || `exit ${restart.exitCode}`}`,
    );
  }
  const timeoutMs = options.timeoutMs ?? GRACEFUL_RESTART_TIMEOUT_MS;
  const sleep = options.sleep ?? Bun.sleep;
  let elapsed = 0;
  while (true) {
    const current = await run(["launchctl", "print", service]);
    const currentPid = current.exitCode === 0 ? servicePid(current.stdout) : undefined;
    if (currentPid && (!previousPid || currentPid !== previousPid)) return true;
    if (elapsed >= timeoutMs) break;
    const delay = Math.min(RESTART_POLL_INTERVAL_MS, timeoutMs - elapsed);
    await sleep(delay);
    elapsed += delay;
  }
  throw new Error(
    `Informant restart did not complete within ${Math.ceil(timeoutMs / 1_000)} seconds`,
  );
}

export async function updateInformant(
  options: {
    command?: typeof command;
    install?: () => Promise<void>;
    platform?: string;
    uid?: number;
    onOutput?: (text: string) => Promise<void> | void;
    sleep?: (milliseconds: number) => Promise<unknown>;
    restartTimeoutMs?: number;
    writeStartupService?: (environment: Record<string, string>) => Promise<unknown>;
  } = {},
): Promise<{ restarted: boolean }> {
  const currentPlatform = options.platform ?? process.platform;
  if (currentPlatform !== "darwin" && currentPlatform !== "linux") {
    throw new Error("Informant updates are supported only on macOS and Linux");
  }
  const run = options.command ?? command;
  const domain = currentPlatform === "darwin" ? launchDomain(options.uid) : undefined;
  const service = domain ? `${domain}/${LABEL}` : "informant.service";
  const serviceStatus = () =>
    currentPlatform === "darwin"
      ? run(["launchctl", "print", service])
      : run(["systemctl", "--user", "show", "--property=MainPID", "--value", service]);
  const initialService =
    currentPlatform === "darwin"
      ? await serviceStatus()
      : await run(["systemctl", "--user", "is-active", service]);
  const loaded = initialService.exitCode === 0;
  if (options.install) {
    await options.install();
  } else if (currentPlatform === "darwin") {
    const upgraded = await run(["brew", "upgrade", "informantdev/tap/informant"], {
      onOutput: options.onOutput,
    });
    if (upgraded.exitCode !== 0) {
      throw new Error(
        `could not update Informant with Homebrew: ${upgraded.stderr.trim() || `exit ${upgraded.exitCode}`}`,
      );
    }
  } else {
    throw new Error("a Linux update installer is required");
  }
  const currentService = await serviceStatus();
  const previousPid =
    currentService.exitCode === 0
      ? currentPlatform === "darwin"
        ? servicePid(currentService.stdout)
        : Number(currentService.stdout.trim()) || undefined
      : undefined;
  const currentlyLoaded =
    currentPlatform === "darwin" ? currentService.exitCode === 0 : previousPid !== undefined;
  if (!loaded && !currentlyLoaded) return { restarted: false };
  if (currentPlatform === "darwin") {
    await migrateStartupServiceDefinition(run, options.writeStartupService);
  }
  const restartCommand = previousPid
    ? ["kill", "-TERM", String(previousPid)]
    : currentPlatform === "darwin"
      ? ["launchctl", "kickstart", service]
      : ["systemctl", "--user", "restart", service];
  const restarted = await run(restartCommand);
  if (restarted.exitCode !== 0) {
    throw new Error(
      `Informant was updated but its service could not be restarted: ${restarted.stderr.trim() || `exit ${restarted.exitCode}`}`,
    );
  }
  const timeoutMs = options.restartTimeoutMs ?? GRACEFUL_RESTART_TIMEOUT_MS;
  const sleep = options.sleep ?? Bun.sleep;
  let elapsed = 0;
  let timedOutPid: number | undefined;
  while (true) {
    const current = await serviceStatus();
    const currentPid =
      current.exitCode === 0
        ? currentPlatform === "darwin"
          ? servicePid(current.stdout)
          : Number(current.stdout.trim()) || undefined
        : undefined;
    if (currentPid && (!previousPid || currentPid !== previousPid)) return { restarted: true };
    if (elapsed >= timeoutMs) {
      timedOutPid = currentPid;
      break;
    }
    const delay = Math.min(RESTART_POLL_INTERVAL_MS, timeoutMs - elapsed);
    await sleep(delay);
    elapsed += delay;
  }
  if (previousPid && timedOutPid === previousPid) {
    await run(
      currentPlatform === "darwin"
        ? ["launchctl", "kill", "SIGKILL", service]
        : ["systemctl", "--user", "kill", "--kill-whom=main", "--signal=SIGKILL", service],
    );
  }
  throw new Error(
    `Informant was updated but its graceful restart did not complete within ${Math.ceil(timeoutMs / 1_000)} seconds`,
  );
}
