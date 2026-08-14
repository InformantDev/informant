import { expect, test } from "bun:test";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  actionableWebhook,
  addedRepositoryRecoveryRequests,
  configureGitHubAppWebhook,
  DispatchRetryQueue,
  disableTailscale,
  enableTailscale,
  MAX_WEBHOOK_BODY_BYTES,
  parseTailscaleStatus,
  RepositoryScanQueue,
  readWebhookBody,
  reconcileKnownWorkers,
  requireGitHubAppWebhookEvents,
  startupRecoveryRequests,
  type TailscaleStatus,
  tailscaleExecutable,
  validGitHubSignature,
  validNetworkAuthorization,
  webhookForcesTagPoll,
} from "./tailscale.ts";

test("uses a Tailscale executable available on PATH", () => {
  expect(
    tailscaleExecutable((name) => (name === "tailscale" ? "/usr/local/bin/tailscale" : null)),
  ).toBe("/usr/local/bin/tailscale");
});

test("activates and configures the GitHub App webhook with an App JWT", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-tailscale-test-"));
  const privateKeyFile = join(root, "app.pem");
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    format: "pem",
    type: "pkcs8",
  });
  await Bun.write(privateKeyFile, privateKey);
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  try {
    await configureGitHubAppWebhook(
      { appId: "123", installationId: "456", privateKeyFile },
      "https://lead.example.ts.net",
      "shared-secret",
      (async (input, init) => {
        requests.push({ url: String(input), init });
        return Response.json({});
      }) as typeof fetch,
    );
    expect(requests.map((request) => request.url)).toEqual([
      "https://api.github.com/app/hook/config",
    ]);
    expect(requests[0]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      url: "https://lead.example.ts.net/webhooks/github",
      content_type: "json",
      secret: "shared-secret",
    });
    expect(new Headers(requests[0]?.init?.headers).get("Authorization")).toMatch(/^Bearer /);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires existing GitHub Apps to subscribe to every dispatch event", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-tailscale-events-test-"));
  const privateKeyFile = join(root, "app.pem");
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    format: "pem",
    type: "pkcs8",
  });
  await Bun.write(privateKeyFile, privateKey);
  const credentials = { appId: "123", installationId: "456", privateKeyFile };
  try {
    await expect(
      requireGitHubAppWebhookEvents(credentials, (async (_input, _init) =>
        Response.json({ events: ["push", "pull_request"] })) as typeof fetch),
    ).rejects.toThrow("issue_comment, check_suite");
    await expect(
      requireGitHubAppWebhookEvents(credentials, (async (_input, _init) =>
        Response.json({
          events: ["push", "pull_request", "issue_comment", "check_suite"],
        })) as typeof fetch),
    ).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires explicit confirmation that existing App webhooks are active", async () => {
  await expect(
    enableTailscale("lead", {
      status: async () => ({
        executable: "/usr/bin/tailscale",
        online: true,
        self: {
          id: "self-id",
          hostName: "lead",
          addresses: ["100.64.0.1"],
          online: true,
        },
        peers: [],
      }),
    }),
  ).rejects.toThrow("confirm the GitHub App webhook is active");
});

test("keeps polling enabled when an App lacks required webhook events", async () => {
  let saved = false;
  await expect(
    enableTailscale("lead", {
      webhookReadyConfirmed: true,
      status: async () => ({
        executable: "/usr/bin/tailscale",
        online: true,
        self: {
          id: "self-id",
          hostName: "lead",
          addresses: ["100.64.0.1"],
          online: true,
        },
        peers: [],
      }),
      listCredentials: async () => [
        { appId: "one", installationId: "1", privateKeyFile: "/unused/one.pem" },
      ],
      validateWebhook: async () => {
        throw new Error("missing check_suite");
      },
      prepareFunnel: async () => "https://lead.example.ts.net",
      saveConfig: async () => {
        saved = true;
      },
    }),
  ).rejects.toThrow("missing check_suite");
  expect(saved).toBe(false);
});

test("persists and reuses a lead secret when configuring one App fails", async () => {
  const status: TailscaleStatus = {
    executable: "/usr/bin/tailscale",
    online: true,
    self: {
      id: "self-id",
      hostName: "lead",
      dnsName: "lead.example.ts.net",
      addresses: ["100.64.0.1"],
      online: true,
    },
    peers: [],
  };
  const credentials = [
    { appId: "one", installationId: "1", privateKeyFile: "/unused/one.pem" },
    { appId: "two", installationId: "2", privateKeyFile: "/unused/two.pem" },
  ];
  let saved: Awaited<ReturnType<typeof enableTailscale>> | undefined;
  let failSecond = true;
  const configuredSecrets: string[] = [];
  const operations = {
    webhookReadyConfirmed: true,
    status: async () => status,
    getConfig: async () => saved,
    saveConfig: async (config: NonNullable<typeof saved>) => {
      saved = config;
    },
    prepareFunnel: async () => "https://lead.example.ts.net",
    listCredentials: async () => credentials,
    createSecret: () => "recoverable-secret",
    createNetworkSecret: () => "network-secret-that-is-at-least-32-characters",
    validateWebhook: async () => {},
    configureWebhook: async (app: (typeof credentials)[number], _url: string, secret: string) => {
      configuredSecrets.push(secret);
      if (failSecond && app.appId === "two") throw new Error("temporary failure");
    },
  };

  await expect(enableTailscale("lead", operations)).rejects.toThrow("temporary failure");
  expect(saved?.webhookSecret).toBe("recoverable-secret");
  expect(saved?.networkSecret).toBe("network-secret-that-is-at-least-32-characters");
  failSecond = false;
  configuredSecrets.length = 0;
  await enableTailscale("lead", operations);

  expect(configuredSecrets).toEqual(["recoverable-secret", "recoverable-secret"]);
});

test("requires a shared token before disabling polling on a network worker", async () => {
  const status: TailscaleStatus = {
    executable: "/usr/bin/tailscale",
    online: true,
    self: {
      id: "worker-id",
      hostName: "worker",
      addresses: ["100.64.0.2"],
      online: true,
    },
    peers: [],
  };
  let saved: Awaited<ReturnType<typeof enableTailscale>> | undefined;

  await expect(enableTailscale("worker", { status: async () => status })).rejects.toThrow(
    "requires the token shown by the lead",
  );
  await enableTailscale("worker", {
    status: async () => status,
    networkSecret: "network-secret-that-is-at-least-32-characters",
    saveConfig: async (config) => {
      saved = config;
    },
  });
  expect(saved?.networkSecret).toBe("network-secret-that-is-at-least-32-characters");
});

test("disables local coordination when Funnel teardown fails", async () => {
  let cleared = false;
  const result = await disableTailscale({
    getConfig: async () => ({
      mode: "lead",
      workerPort: 7639,
      funnelPort: 7640,
      funnelUrl: "https://lead.example.ts.net",
      webhookSecret: "secret",
    }),
    status: async () => ({
      executable: "/usr/bin/tailscale",
      online: true,
      self: {
        id: "self-id",
        hostName: "lead",
        addresses: ["100.64.0.1"],
        online: true,
      },
      peers: [],
    }),
    resetFunnel: async () => {
      throw new Error("permission denied");
    },
    clearConfig: async () => {
      cleared = true;
      return true;
    },
  });

  expect(cleared).toBe(true);
  expect(result.disabled).toBe(true);
  expect(result.funnelResetError?.message).toBe("permission denied");
});

test("parses this machine and online peers from Tailscale status", () => {
  const status = parseTailscaleStatus(
    "/usr/bin/tailscale",
    JSON.stringify({
      BackendState: "Running",
      Self: {
        ID: "self-id",
        HostName: "lead",
        DNSName: "lead.example.ts.net.",
        TailscaleIPs: ["100.64.0.1", "fd7a::1"],
        Online: true,
      },
      Peer: {
        "peer-key": {
          ID: "worker-id",
          HostName: "worker",
          TailscaleIPs: ["100.64.0.2"],
          Online: true,
        },
      },
    }),
  );

  expect(status.online).toBe(true);
  expect(status.self.dnsName).toBe("lead.example.ts.net");
  expect(status.peers).toEqual([
    {
      id: "worker-id",
      hostName: "worker",
      dnsName: undefined,
      addresses: ["100.64.0.2"],
      online: true,
    },
  ]);
});

test("authenticates private worker API requests with a shared token", () => {
  const secret = "network-secret-that-is-at-least-32-characters";
  expect(validNetworkAuthorization(`Bearer ${secret}`, secret)).toBe(true);
  expect(validNetworkAuthorization("Bearer wrong", secret)).toBe(false);
  expect(validNetworkAuthorization(null, secret)).toBe(false);
});

test("verifies GitHub webhook signatures without accepting malformed values", () => {
  const body = JSON.stringify({ repository: { full_name: "owner/repo" } });
  const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
  expect(validGitHubSignature(body, signature, "secret")).toBe(true);
  expect(validGitHubSignature(body, signature, "different-secret")).toBe(false);
  expect(validGitHubSignature(body, "sha256=not-hex", "secret")).toBe(false);
  expect(validGitHubSignature(body, null, "secret")).toBe(false);
});

test("dispatches only webhook actions that can create trigger work", () => {
  expect(actionableWebhook("push", {})).toBe(true);
  expect(actionableWebhook("pull_request", { action: "synchronize" })).toBe(true);
  expect(actionableWebhook("issue_comment", { action: "created" })).toBe(true);
  expect(actionableWebhook("issue_comment", { action: "edited" })).toBe(false);
  expect(actionableWebhook("check_suite", { action: "rerequested" })).toBe(true);
  expect(actionableWebhook("check_suite", { action: "completed" })).toBe(false);
  expect(actionableWebhook("installation", { action: "created" })).toBe(false);
});

test("bounds webhook bodies at GitHub's supported maximum", async () => {
  expect(MAX_WEBHOOK_BODY_BYTES).toBe(25 * 1024 * 1024);
  await expect(
    readWebhookBody(
      new Request("https://lead.example/webhooks/github", {
        method: "POST",
        headers: { "Content-Length": "10" },
        body: "small",
      }),
      5,
    ),
  ).rejects.toThrow();
  await expect(
    readWebhookBody(
      new Request("https://lead.example/webhooks/github", {
        method: "POST",
        body: "too large",
      }),
      5,
    ),
  ).rejects.toThrow();
  expect(
    await readWebhookBody(
      new Request("https://lead.example/webhooks/github", { method: "POST", body: "okay" }),
      5,
    ),
  ).toBe("okay");
});

test("recognizes tag push webhooks that must bypass the tag throttle", () => {
  expect(webhookForcesTagPoll("push", { ref: "refs/tags/v1" })).toBe(true);
  expect(webhookForcesTagPoll("push", { ref: "refs/heads/main" })).toBe(false);
  expect(webhookForcesTagPoll("pull_request", { ref: "refs/tags/v1" })).toBe(false);
});

test("startup recovery forces a synchronization for every local repository", () => {
  const one = { owner: "owner", repo: "one", fullName: "owner/one" };
  const two = { owner: "owner", repo: "two", fullName: "owner/two" };
  const repositories = [one, two];

  expect(startupRecoveryRequests(repositories)).toEqual([
    { repository: one, forceTagPoll: true },
    { repository: two, forceTagPoll: true },
  ]);
});

test("worker refresh evicts peers absent from the latest successful discovery", () => {
  const healthy = {
    id: "healthy",
    hostName: "old-name",
    address: "100.64.0.2",
    capabilities: [],
    repositories: [],
  };
  const stale = { ...healthy, id: "stale", address: "100.64.0.3" };
  const updated = { ...healthy, hostName: "new-name" };
  const known = new Map([
    [healthy.id, healthy],
    [stale.id, stale],
  ]);

  reconcileKnownWorkers(known, [updated]);
  expect([...known.values()]).toEqual([updated]);
  reconcileKnownWorkers(known, []);
  expect(known.size).toBe(0);
});

test("repository refresh recovers only newly registered repositories", () => {
  const one = { owner: "owner", repo: "one", fullName: "owner/one" };
  const two = { owner: "owner", repo: "two", fullName: "OWNER/TWO" };

  expect(addedRepositoryRecoveryRequests([one], [one, two])).toEqual([
    { repository: two, forceTagPoll: true },
  ]);
  expect(addedRepositoryRecoveryRequests([one, two], [one, two])).toEqual([]);
});

test("repository removal cancels an active scan and suppresses queued scans", async () => {
  const repository = { owner: "owner", repo: "repo", fullName: "owner/repo" };
  const signals: AbortSignal[] = [];
  let starts = 0;
  const scans = new RepositoryScanQueue([repository], async (_repository, _force, signal) => {
    starts++;
    signals.push(signal);
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });

  const active = scans.run(repository);
  while (starts === 0) await Bun.sleep(0);
  const queued = scans.run(repository);
  scans.reconcile([]);
  await Promise.all([active, queued]);

  expect(starts).toBe(1);
  expect(signals[0]?.aborted).toBe(true);
  await scans.stop();
});

test("runs another dispatch when an ordinary webhook arrives during an active dispatch", async () => {
  const requests: boolean[] = [];
  let finishFirst!: (value: boolean) => void;
  const first = new Promise<boolean>((resolve) => {
    finishFirst = resolve;
  });
  const repository = { owner: "owner", repo: "repo", fullName: "owner/repo" };
  const queue = new DispatchRetryQueue(async (request) => {
    requests.push(request.forceTagPoll);
    return requests.length === 1 ? first : true;
  });

  queue.enqueue({ repository, forceTagPoll: false });
  while (requests.length === 0) await Bun.sleep(0);
  queue.enqueue({ repository, forceTagPoll: false });
  finishFirst(true);
  while (queue.size > 0) await Bun.sleep(0);

  expect(requests).toEqual([false, false]);
  await queue.stop();
});

test("retains failed dispatches and preserves a queued tag refresh", async () => {
  const callbacks: Array<() => void> = [];
  const requests: boolean[] = [];
  let finishFirst!: (value: boolean) => void;
  const first = new Promise<boolean>((resolve) => {
    finishFirst = resolve;
  });
  const repository = { owner: "owner", repo: "repo", fullName: "owner/repo" };
  const queue = new DispatchRetryQueue(
    async (request) => {
      requests.push(request.forceTagPoll);
      return requests.length === 1 ? first : true;
    },
    () => {},
    (callback) => {
      callbacks.push(callback);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
    () => {},
  );

  queue.enqueue({ repository, forceTagPoll: false });
  while (requests.length === 0) await Bun.sleep(0);
  queue.enqueue({ repository, forceTagPoll: true });
  finishFirst(false);
  while (callbacks.length === 0) await Bun.sleep(0);
  callbacks.shift()?.();
  while (queue.size > 0) await Bun.sleep(0);

  expect(requests).toEqual([false, true]);
  await queue.stop();
});
