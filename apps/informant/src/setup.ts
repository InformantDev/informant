import { createSign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { arch, homedir, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { confirm, intro, isCancel, outro, select, spinner, text } from "@clack/prompts";
import { appleContainerInstalled, ensureAppleContainerSystem } from "./container.ts";
import {
  listGitHubCredentials,
  listRepositories,
  machineConfigPath,
  saveGitHubCredentials,
} from "./machine-config.ts";
import { command } from "./process.ts";
import { serveRepositories } from "./server.ts";

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

async function installPackage(path: string): Promise<void> {
  const process = Bun.spawn(["sudo", "/usr/sbin/installer", "-pkg", path, "-target", "/"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await process.exited) !== 0) throw new Error("Apple Container installer failed");
}

function commandError(action: string, result: Awaited<ReturnType<typeof command>>): Error {
  return new Error(`${action}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
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

interface ManifestApp {
  id: number;
  slug: string;
  pem: string;
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
  const result = await command(["open", url]);
  if (result.exitCode !== 0) throw new Error(`could not open browser: ${result.stderr}`);
}

async function createApp(owner?: string): Promise<ManifestApp> {
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
        default_permissions: { checks: "write", contents: "read", pull_requests: "write" },
        default_events: [],
        hook_attributes: { url: APP_URL, active: false },
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

async function finishSetup(account: string): Promise<void> {
  const repositories = await listRepositories();
  const start = await confirm({ message: "Start the worker now?", initialValue: true });
  outro(`GitHub App configured for ${account}.`);
  if (!isCancel(start) && start) {
    await serveRepositories(repositories, { onMessage: console.log });
  }
}

export async function setup(): Promise<void> {
  intro("Informant setup");
  await setupAppleContainer();
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
  progress.start("Waiting for GitHub App creation in your browser");
  const app = await createApp(owner);
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
  progress.stop(`GitHub App configured for ${installation.account.login}`);
  await finishSetup(installation.account.login);
}
