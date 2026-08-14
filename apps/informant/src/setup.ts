import { createSign, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { arch, homedir, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { confirm, intro, isCancel, outro, select, spinner, text } from "@clack/prompts";
import { appleContainerInstalled, ensureAppleContainerSystem } from "./container.ts";
import { podmanContainerBackend } from "./container-backend.ts";
import {
  automaticUpdatesPreference,
  getTailscaleConfig,
  listGitHubCredentials,
  listRepositories,
  machineConfigPath,
  saveAutomaticUpdatesPreference,
  saveGitHubCredentials,
  saveTailscaleConfig,
} from "./machine-config.ts";
import { command } from "./process.ts";
import {
  configureGitHubAppWebhook,
  DEFAULT_FUNNEL_PORT,
  DEFAULT_WORKER_PORT,
  prepareTailscaleFunnel,
  REQUIRED_GITHUB_WEBHOOK_EVENTS,
  serveWithTailscale,
  tailscaleStatus,
} from "./tailscale.ts";
import { disableAutomaticUpdates, enableAutomaticUpdates } from "./updater.ts";

const API = "https://api.github.com";
const APP_URL = "https://github.com/InformantDev/informant";
const CONTAINER_RELEASE = {
  version: "1.1.0",
  url: "https://github.com/apple/container/releases/download/1.1.0/container-1.1.0-installer-signed.pkg",
  sha256: "0ca1c42a2269c2557efb1d82b1b38ac553e6a3a3da1b1179c439bcee1e7d6714",
};

interface ContainerSetupOperations {
  command?: typeof command;
  installPackage?: (path: string) => Promise<void>;
  platform?: NodeJS.Platform;
  arch?: string;
}

interface PodmanSetupOperations {
  command?: typeof command;
  installPackages?: (commands: string[][]) => Promise<void>;
  osRelease?: string;
}

async function installPackage(path: string): Promise<void> {
  const process = Bun.spawn(["sudo", "/usr/sbin/installer", "-pkg", path, "-target", "/"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await process.exited) !== 0) throw new Error("Apple Container installer failed");
}

export async function installPrivilegedPackages(
  commands: string[][],
  operations: {
    uid?: number;
    run?: (argv: string[]) => Promise<number>;
  } = {},
): Promise<void> {
  const run =
    operations.run ??
    (async (argv: string[]) => {
      const child = Bun.spawn(argv, {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      return child.exited;
    });
  const uid = operations.uid ?? process.getuid?.();
  for (const argv of commands) {
    if ((await run(uid === 0 ? argv : ["sudo", ...argv])) !== 0)
      throw new Error(`${argv[0]} failed to install Podman`);
  }
}

function podmanInstallCommands(osRelease: string): string[][] {
  const id = osRelease
    .match(/^ID=(?:"([^"]+)"|([^\n]+))$/m)
    ?.slice(1)
    .find(Boolean)
    ?.trim();
  const like =
    osRelease
      .match(/^ID_LIKE=(?:"([^"]+)"|([^\n]+))$/m)
      ?.slice(1)
      .find(Boolean) ?? "";
  const family = `${id ?? ""} ${like}`.toLowerCase();
  const packages = ["podman", "uidmap", "slirp4netns", "fuse-overlayfs"];
  if (/(debian|ubuntu)/.test(family)) {
    return [
      ["apt-get", "update"],
      ["apt-get", "install", "-y", ...packages],
    ];
  }
  if (/(fedora|rhel|centos|rocky|almalinux)/.test(family)) {
    return [["dnf", "install", "-y", "podman", "shadow-utils", "slirp4netns", "fuse-overlayfs"]];
  }
  throw new Error(
    "automatic Podman installation supports Debian/Ubuntu and Fedora/RHEL; install rootless Podman with your package manager",
  );
}

function commandError(action: string, result: Awaited<ReturnType<typeof command>>): Error {
  return new Error(
    `${action}: ${result.timedOut ? "timed out" : result.stderr.trim() || `exit ${result.exitCode}`}`,
  );
}

export async function prepareAppleContainer(
  operations: ContainerSetupOperations = {},
): Promise<void> {
  const runCommand = operations.command ?? command;
  const installed = await appleContainerInstalled(runCommand);
  if (!installed) {
    if (
      (operations.platform ?? platform()) !== "darwin" ||
      (operations.arch ?? arch()) !== "arm64"
    ) {
      throw new Error("Apple Container requires macOS on Apple silicon");
    }

    const directory = await mkdtemp(join(tmpdir(), "informant-container-install-"));
    const packagePath = join(directory, `container-${CONTAINER_RELEASE.version}.pkg`);
    try {
      const download = await runCommand([
        "/usr/bin/curl",
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        "--output",
        packagePath,
        CONTAINER_RELEASE.url,
      ]);
      if (download.exitCode !== 0)
        throw commandError("could not download Apple Container", download);

      const checksum = await runCommand(["/usr/bin/shasum", "-a", "256", packagePath]);
      if (checksum.exitCode !== 0)
        throw commandError("could not verify Apple Container download", checksum);
      if (checksum.stdout.trim().split(/\s+/)[0] !== CONTAINER_RELEASE.sha256) {
        throw new Error("Apple Container download checksum did not match the official release");
      }

      await (operations.installPackage ?? installPackage)(packagePath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  await ensureAppleContainerSystem(runCommand);

  const smokeTest = await runCommand([
    "container",
    "run",
    "--rm",
    "oven/bun:1",
    "bun",
    "--version",
  ]);
  if (smokeTest.exitCode !== 0)
    throw commandError("Apple Container could not run the Informant default image", smokeTest);
}

export async function preparePodman(operations: PodmanSetupOperations = {}): Promise<void> {
  const runCommand = operations.command ?? command;
  const installed = await runCommand(["podman", "--version"]);
  if (installed.exitCode !== 0) {
    const source = operations.osRelease ?? (await readFile("/etc/os-release", "utf8"));
    await (operations.installPackages ?? installPrivilegedPackages)(podmanInstallCommands(source));
  }
  await podmanContainerBackend.initialize(runCommand);
  const workspace = await mkdtemp(join(tmpdir(), "informant-podman-smoke-"));
  const marker = join(workspace, "informant-smoke-test");
  try {
    const smokeTest = await runCommand(
      [
        "podman",
        "run",
        "--rm",
        "--init",
        "--ulimit",
        "nofile=65536:65536",
        "--workdir",
        "/workspace",
        "--user",
        "0:0",
        "--cpus",
        "1",
        "--memory",
        "256M",
        "--security-opt",
        "no-new-privileges",
        "--volume",
        `${workspace}:/workspace:Z`,
        "--entrypoint",
        "/bin/sh",
        "docker.io/oven/bun:1",
        "-lc",
        "bun --version && touch /workspace/informant-smoke-test",
      ],
      { timeoutMs: 120_000 },
    );
    if (smokeTest.exitCode !== 0 || smokeTest.timedOut)
      throw commandError("rootless Podman could not run the Informant default image", smokeTest);
    if (!(await Bun.file(marker).exists())) {
      throw new Error("rootless Podman could not write to a bind-mounted workspace");
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function setupAppleContainer(): Promise<void> {
  if (!(await appleContainerInstalled())) {
    const install = await confirm({
      message: "Install Apple Container for container jobs? (requires an administrator password)",
      initialValue: true,
    });
    if (isCancel(install) || !install) return;
  }
  console.log("Preparing Apple Container…");
  await prepareAppleContainer();
  console.log("Apple Container is ready.");
}

async function setupPodman(): Promise<void> {
  const installed = (await command(["podman", "--version"])).exitCode === 0;
  if (!installed) {
    const install = await confirm({
      message: "Install rootless Podman for container jobs? (requires administrator privileges)",
      initialValue: true,
    });
    if (isCancel(install) || !install) return;
  }
  console.log("Preparing rootless Podman…");
  await preparePodman();
  console.log("Rootless Podman is ready.");
}

interface ManifestApp {
  id: number;
  slug: string;
  pem: string;
  webhook_secret?: string;
}

function appJwt(appId: number | string, privateKey: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1_000);
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url")}`;
}

interface Installation {
  id: number;
  account: { login: string };
}

async function installations(app: ManifestApp): Promise<Installation[]> {
  const response = await fetch(`${API}/app/installations`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${appJwt(app.id, app.pem)}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok)
    throw new Error(`could not check GitHub App installation: ${await response.text()}`);
  return response.json() as Promise<Installation[]>;
}

async function installation(
  appId: string,
  installationId: string,
  privateKey: string,
): Promise<Installation> {
  const response = await fetch(`${API}/app/installations/${installationId}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${appJwt(appId, privateKey)}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok)
    throw new Error(`could not validate GitHub App installation: ${await response.text()}`);
  return response.json() as Promise<Installation>;
}

async function migrateLegacyApp(): Promise<void> {
  const legacy = (await listGitHubCredentials()).find((credentials) => !credentials.account);
  if (!legacy) return;
  const privateKey = await readFile(legacy.privateKeyFile, "utf8");
  const current = await installation(legacy.appId, legacy.installationId, privateKey);
  await saveGitHubCredentials({ ...legacy, account: current.account.login });
}

async function storeInstallation(
  appId: string,
  current: Installation,
  privateKey: string,
): Promise<void> {
  await migrateLegacyApp();
  const keyPath = join(
    dirname(machineConfigPath()),
    `app-${appId}-${crypto.randomUUID().slice(0, 8)}.pem`,
  );
  await mkdir(dirname(keyPath), { recursive: true });
  await writeFile(keyPath, privateKey, { mode: 0o600, flag: "wx" });
  try {
    await saveGitHubCredentials({
      account: current.account.login,
      appId,
      installationId: String(current.id),
      privateKeyFile: keyPath,
    });
  } catch (error) {
    await rm(keyPath, { force: true });
    throw error;
  }
}

async function openBrowser(url: string): Promise<void> {
  const result = await command([platform() === "linux" ? "xdg-open" : "open", url]);
  if (result.exitCode !== 0) throw new Error(`could not open browser: ${result.stderr}`);
}

async function createApp(owner?: string, webhookUrl?: string): Promise<ManifestApp> {
  const state = crypto.randomUUID();
  let resolveApp!: (app: ManifestApp) => void;
  let rejectApp!: (error: Error) => void;
  const appPromise = new Promise<ManifestApp>((resolve, reject) => {
    resolveApp = resolve;
    rejectApp = reject;
  });

  let server: Bun.Server<undefined>;
  server = Bun.serve({
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/callback") {
        if (url.searchParams.get("state") !== state)
          return new Response("Invalid setup state", { status: 400 });
        const code = url.searchParams.get("code");
        if (!code) return new Response("GitHub did not return a setup code", { status: 400 });
        try {
          const response = await fetch(
            `${API}/app-manifests/${encodeURIComponent(code)}/conversions`,
            {
              method: "POST",
              headers: {
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
              },
            },
          );
          if (!response.ok) throw new Error(await response.text());
          resolveApp((await response.json()) as ManifestApp);
          return new Response("Informant created the GitHub App. You can return to the terminal.");
        } catch (error) {
          rejectApp(error instanceof Error ? error : new Error(String(error)));
          return new Response("GitHub App setup failed. Return to the terminal.", { status: 500 });
        }
      }

      const callback = `http://127.0.0.1:${server.port}/callback`;
      const manifest = JSON.stringify({
        name: `Informant ${crypto.randomUUID().slice(0, 8)}`,
        url: APP_URL,
        redirect_url: callback,
        public: false,
        default_permissions: {
          checks: "write",
          contents: "read",
          issues: "read",
          pull_requests: "write",
        },
        default_events: webhookUrl ? [...REQUIRED_GITHUB_WEBHOOK_EVENTS] : [],
        hook_attributes: { url: webhookUrl ?? APP_URL, active: Boolean(webhookUrl) },
      })
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;");
      const action = owner
        ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new?state=${state}`
        : `https://github.com/settings/apps/new?state=${state}`;
      return new Response(
        `<!doctype html><title>Informant setup</title><form id="setup" method="post" action="${action}"><input type="hidden" name="manifest" value="${manifest}"></form><p>Opening GitHub…</p><script>document.getElementById('setup').submit()</script>`,
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });

  try {
    await openBrowser(`http://127.0.0.1:${server.port}`);
    return await Promise.race([
      appPromise,
      Bun.sleep(10 * 60_000).then(() => {
        throw new Error("GitHub App creation was not completed within 10 minutes");
      }),
    ]);
  } finally {
    server.stop(true);
  }
}

async function connectExistingApp(): Promise<string | undefined> {
  const appId = await text({
    message: "GitHub App ID",
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  if (isCancel(appId)) return undefined;
  const installationId = await text({
    message: "GitHub App installation ID",
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  if (isCancel(installationId)) return undefined;
  const privateKeyPath = await text({
    message: "Path to this machine's GitHub App private key",
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  if (isCancel(privateKeyPath)) return undefined;

  const path = resolve(privateKeyPath.trim().replace(/^~(?=\/)/, homedir()));
  const privateKey = await readFile(path, "utf8");
  const current = await installation(appId.trim(), installationId.trim(), privateKey);
  await storeInstallation(appId.trim(), current, privateKey);
  return current.account.login;
}

export async function configureAutomaticUpdatesDuringSetup(
  operations: {
    disable?: () => Promise<unknown>;
    enable?: () => Promise<unknown>;
    preference?: () => Promise<boolean | undefined>;
    prompt?: (options: { message: string; initialValue: boolean }) => Promise<boolean | symbol>;
    promptCancelled?: (value: boolean | symbol) => boolean;
    savePreference?: (enabled: boolean) => Promise<unknown>;
    warn?: (message: string) => void;
  } = {},
): Promise<void> {
  const preference = operations.preference ?? automaticUpdatesPreference;
  if ((await preference()) !== undefined) return;
  const prompt = operations.prompt ?? ((options) => confirm(options));
  const automaticUpdates = await prompt({
    message: "Automatically install new Informant versions and restart the startup worker?",
    initialValue: true,
  });
  if ((operations.promptCancelled ?? isCancel)(automaticUpdates)) return;
  const savePreference = operations.savePreference ?? saveAutomaticUpdatesPreference;
  if (!automaticUpdates) {
    await (operations.disable ?? disableAutomaticUpdates)();
    await savePreference(false);
    return;
  }
  try {
    await (operations.enable ?? enableAutomaticUpdates)();
  } catch (error) {
    await savePreference(false);
    (operations.warn ?? console.warn)(
      `Automatic updates were not enabled: ${error instanceof Error ? error.message : String(error)}. Run informant auto-update enable after resolving the service-manager issue.`,
    );
    return;
  }
  await savePreference(true);
}

async function finishSetup(account: string): Promise<void> {
  const repositories = await listRepositories();
  await configureAutomaticUpdatesDuringSetup();
  const start = await confirm({ message: "Start the worker now?", initialValue: true });
  outro(`GitHub App configured for ${account}.`);
  if (!isCancel(start) && start) {
    await serveWithTailscale(repositories, { onMessage: console.log });
  }
}

export async function setup(): Promise<void> {
  intro("Informant setup");
  if (platform() === "darwin" && arch() === "arm64") await setupAppleContainer();
  if (platform() === "linux") await setupPodman();
  const setupType = await select({
    message: "How should this machine be configured?",
    options: [
      { value: "create", label: "Create a private App for another account" },
      { value: "connect", label: "Connect an existing App used by another machine" },
    ],
  });
  if (isCancel(setupType)) return;
  if (setupType === "connect") {
    const account = await connectExistingApp();
    if (!account) return;
    await finishSetup(account);
    return;
  }

  const ownerType = await select({
    message: "Who should own the GitHub App?",
    options: [
      { value: "personal", label: "My personal account" },
      { value: "organization", label: "An organization" },
    ],
  });
  if (isCancel(ownerType)) return;
  let owner: string | undefined;
  if (ownerType === "organization") {
    const value = await text({
      message: "GitHub organization name",
      validate: (input) => (input?.trim() ? undefined : "Required"),
    });
    if (isCancel(value)) return;
    owner = value.trim();
  }

  const progress = spinner();
  const existingTailscale = await getTailscaleConfig();
  let funnelUrl = existingTailscale?.mode === "lead" ? existingTailscale.funnelUrl : undefined;
  const tailStatus = await tailscaleStatus();
  if (!funnelUrl && tailStatus?.online) {
    try {
      funnelUrl = await prepareTailscaleFunnel(
        tailStatus,
        DEFAULT_FUNNEL_PORT,
        command,
        openBrowser,
      );
      console.log(`Tailscale Funnel ready at ${funnelUrl}/webhooks/github`);
    } catch (error) {
      console.warn(
        `Could not enable Tailscale Funnel; setup will use polling: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  progress.start("Waiting for GitHub App creation in your browser");
  const app = await createApp(owner, funnelUrl ? `${funnelUrl}/webhooks/github` : undefined);
  progress.stop("GitHub App created");

  await openBrowser(`https://github.com/apps/${app.slug}/installations/new`);
  progress.start("Waiting for you to install the App on repositories");
  let installation: Installation | undefined;
  for (let attempt = 0; attempt < 300; attempt++) {
    installation = (await installations(app))[0];
    if (installation) break;
    await Bun.sleep(1_000);
  }
  if (!installation) throw new Error("GitHub App was not installed within 5 minutes");

  await storeInstallation(String(app.id), installation, app.pem);
  if (funnelUrl && existingTailscale?.mode === "lead" && existingTailscale.webhookSecret) {
    const credentials = (await listGitHubCredentials()).find(
      (candidate) => candidate.appId === String(app.id),
    );
    if (!credentials) throw new Error("could not reload the new GitHub App credentials");
    await configureGitHubAppWebhook(credentials, funnelUrl, existingTailscale.webhookSecret);
  } else if (funnelUrl && app.webhook_secret) {
    const networkSecret = randomBytes(32).toString("hex");
    await saveTailscaleConfig({
      mode: "lead",
      funnelUrl,
      webhookSecret: app.webhook_secret,
      networkSecret,
      workerPort: DEFAULT_WORKER_PORT,
      funnelPort: DEFAULT_FUNNEL_PORT,
    });
    console.log(`Tailscale worker token: ${networkSecret}`);
  } else if (funnelUrl) {
    console.warn("GitHub did not return a webhook secret; polling remains enabled.");
  }
  progress.stop(`GitHub App configured for ${installation.account.login}`);
  await finishSetup(installation.account.login);
}
