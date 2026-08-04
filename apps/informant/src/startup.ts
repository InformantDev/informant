import { existsSync } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
  const executable = Bun.which("informant");
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

async function migrateStartupServiceDefinition(): Promise<string> {
  const path = startupServicePath();
  const captured = await command([
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
  return writeStartupServiceDefinition(parseStartupEnvironment(captured.stdout));
}

export async function enableStartup(): Promise<string> {
  if (process.platform !== "darwin")
    throw new Error("startup services are supported only on macOS");
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
  if (process.platform !== "darwin")
    throw new Error("startup services are supported only on macOS");
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
    writeServiceDefinition?: () => Promise<unknown>;
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
  if (!previousPid) {
    throw new Error("Informant was updated but its loaded startup service has no running worker");
  }
  await (options.writeServiceDefinition ?? migrateStartupServiceDefinition)();
  const restarted = await run(["kill", "-TERM", String(previousPid)]);
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
    if (currentPid && currentPid !== previousPid) return { restarted: true };
    if (elapsed >= timeoutMs) break;
    const delay = Math.min(RESTART_POLL_INTERVAL_MS, timeoutMs - elapsed);
    await sleep(delay);
    elapsed += delay;
  }
  throw new Error(
    `Informant was updated but its graceful restart did not complete within ${Math.ceil(timeoutMs / 1_000)} seconds`,
  );
}
