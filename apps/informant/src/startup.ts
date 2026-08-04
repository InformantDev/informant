import { existsSync } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { command } from "./process.ts";
import { dataDirectory } from "./store.ts";

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

export function linuxStartupServicePath(): string {
  return join(homedir(), ".config", "systemd", "user", "informant.service");
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
  return value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"');
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

function startupEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {
    HOME: homedir(),
    PATH: Bun.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
  };
  for (const [key, value] of Object.entries(Bun.env)) {
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

export async function updateInformant(
  options: {
    command?: typeof command;
    platform?: string;
    uid?: number;
    onOutput?: (text: string) => Promise<void> | void;
    sleep?: (milliseconds: number) => Promise<unknown>;
    restartTimeoutMs?: number;
    writeStartupService?: (environment: Record<string, string>) => Promise<unknown>;
  } = {},
): Promise<{ restarted: boolean }> {
  if ((options.platform ?? process.platform) !== "darwin")
    throw new Error("Homebrew updates are supported only on macOS");
  const run = options.command ?? command;
  const domain = launchDomain(options.uid);
  const service = `${domain}/${LABEL}`;
  const initialService = await run(["launchctl", "print", service]);
  const loaded = initialService.exitCode === 0;
  const upgraded = await run(["brew", "upgrade", "informant-ci/tap/informant"], {
    onOutput: options.onOutput,
  });
  if (upgraded.exitCode !== 0) {
    throw new Error(
      `could not update Informant with Homebrew: ${upgraded.stderr.trim() || `exit ${upgraded.exitCode}`}`,
    );
  }
  if (!loaded) return { restarted: false };
  const currentService = await run(["launchctl", "print", service]);
  const previousPid = currentService.exitCode === 0 ? servicePid(currentService.stdout) : undefined;
  await migrateStartupServiceDefinition(run, options.writeStartupService);
  const restartCommand = previousPid
    ? ["kill", "-TERM", String(previousPid)]
    : ["launchctl", "kickstart", service];
  const restarted = await run(restartCommand);
  if (restarted.exitCode !== 0) {
    throw new Error(
      `Informant was updated but its service could not be restarted: ${restarted.stderr.trim() || `exit ${restarted.exitCode}`}`,
    );
  }
  const timeoutMs = options.restartTimeoutMs ?? GRACEFUL_RESTART_TIMEOUT_MS;
  const sleep = options.sleep ?? Bun.sleep;
  let elapsed = 0;
  while (true) {
    const current = await run(["launchctl", "print", service]);
    const currentPid = current.exitCode === 0 ? servicePid(current.stdout) : undefined;
    if (currentPid && (!previousPid || currentPid !== previousPid)) return { restarted: true };
    if (elapsed >= timeoutMs) break;
    const delay = Math.min(RESTART_POLL_INTERVAL_MS, timeoutMs - elapsed);
    await sleep(delay);
    elapsed += delay;
  }
  if (previousPid) await run(["kill", "-KILL", String(previousPid)]);
  throw new Error(
    `Informant was updated but its graceful restart did not complete within ${Math.ceil(timeoutMs / 1_000)} seconds`,
  );
}
