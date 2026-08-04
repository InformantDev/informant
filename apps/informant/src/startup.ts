import { existsSync } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { command } from "./process.ts";
import { dataDirectory } from "./store.ts";

const LABEL = "dev.informant.worker";

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

export async function enableStartup(): Promise<string> {
  if (process.platform !== "darwin")
    throw new Error("startup services are supported only on macOS");
  const executable = Bun.which("informant");
  if (!executable) {
    throw new Error("informant must be installed on PATH before enabling startup");
  }
  const path = startupServicePath();
  const logs = dataDirectory();
  await mkdir(dirname(path), { recursive: true });
  await mkdir(logs, { recursive: true });
  await Bun.write(path, renderStartupService(executable, startupEnvironment(), logs));
  await chmod(path, 0o600);

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
  } = {},
): Promise<{ restarted: boolean }> {
  if ((options.platform ?? process.platform) !== "darwin")
    throw new Error("Homebrew updates are supported only on macOS");
  const run = options.command ?? command;
  const domain = launchDomain(options.uid);
  const service = `${domain}/${LABEL}`;
  const loaded = (await run(["launchctl", "print", service])).exitCode === 0;
  const upgraded = await run(["brew", "upgrade", "informant-ci/tap/informant"], {
    onOutput: options.onOutput,
  });
  if (upgraded.exitCode !== 0) {
    throw new Error(
      `could not update Informant with Homebrew: ${upgraded.stderr.trim() || `exit ${upgraded.exitCode}`}`,
    );
  }
  if (!loaded) return { restarted: false };
  const restarted = await run(["launchctl", "kill", "SIGTERM", service]);
  if (restarted.exitCode !== 0) {
    throw new Error(
      `Informant was updated but its service could not be restarted: ${restarted.stderr.trim() || `exit ${restarted.exitCode}`}`,
    );
  }
  return { restarted: true };
}
