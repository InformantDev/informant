import { createSign } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { confirm, intro, isCancel, outro, select, spinner, text } from "@clack/prompts";
import { GitHubClient } from "./github.ts";
import { configureMachine, machineConfigPath } from "./machine-config.ts";
import { command } from "./process.ts";
import { serveRepositories } from "./server.ts";

const API = "https://api.github.com";

interface ManifestApp {
  id: number;
  slug: string;
  pem: string;
}

function appJwt(appId: number, privateKey: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1_000);
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url")}`;
}

async function installations(app: ManifestApp): Promise<Array<{ id: number }>> {
  const response = await fetch(`${API}/app/installations`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${appJwt(app.id, app.pem)}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok)
    throw new Error(`could not check GitHub App installation: ${await response.text()}`);
  return response.json() as Promise<Array<{ id: number }>>;
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
        url: "https://github.com/informant-ci/informant",
        redirect_url: callback,
        public: false,
        default_permissions: { checks: "write", contents: "read", pull_requests: "read" },
        default_events: [],
        hook_attributes: { url: callback, active: false },
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

export async function setup(): Promise<void> {
  intro("Informant setup");
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
  let installation: { id: number } | undefined;
  for (let attempt = 0; attempt < 300; attempt++) {
    installation = (await installations(app))[0];
    if (installation) break;
    await Bun.sleep(1_000);
  }
  if (!installation) throw new Error("GitHub App was not installed within 5 minutes");

  const github = new GitHubClient({
    credentials: {
      appId: String(app.id),
      installationId: String(installation.id),
      privateKey: app.pem,
    },
  });
  const repositories = await github.installationRepositories();

  const keyPath = join(dirname(machineConfigPath()), `app-${app.id}.pem`);
  await mkdir(dirname(keyPath), { recursive: true });
  await writeFile(keyPath, app.pem, { mode: 0o600, flag: "wx" });
  try {
    await configureMachine(
      {
        appId: String(app.id),
        installationId: String(installation.id),
        privateKeyFile: keyPath,
      },
      repositories,
    );
  } catch (error) {
    await rm(keyPath, { force: true });
    throw error;
  }
  progress.stop(
    `Configured ${repositories.length} ${repositories.length === 1 ? "repository" : "repositories"}`,
  );

  const start = await confirm({ message: "Start the worker now?", initialValue: true });
  outro("Setup complete.");
  if (!isCancel(start) && start) {
    await serveRepositories(repositories, { onMessage: console.log });
  }
}
