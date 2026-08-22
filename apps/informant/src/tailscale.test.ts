import { expect, test } from "bun:test";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptedAutomaticLaneUpdates,
  actionableWebhook,
  addedRepositoryRecoveryRequests,
  automaticLaneUpdatesRefreshRetention,
  configureGitHubAppWebhook,
  DispatchRetryQueue,
  disableTailscale,
  enableTailscale,
  generatedNetworkClaimPlan,
  githubAppWebhookSettings,
  localNetworkExecutionCapacity,
  MAX_WEBHOOK_BODY_BYTES,
  mergeAutomaticLaneUpdates,
  NETWORK_RECONCILIATION_INTERVAL_MS,
  networkReconciliationRequests,
  parseAutomaticLaneUpdates,
  parseNetworkClaimPlan,
  parseTailscaleStatus,
  prepareTailscaleFunnel,
  RepositoryScanQueue,
  readWebhookBody,
  reconcileKnownWorkers,
  requireGitHubAppWebhookEvents,
  retireAutomaticLaneUpdate,
  serveWithTailscale,
  startupRecoveryRequests,
  type TailscaleStatus,
  tailscaleExecutable,
  tailscaleStatus,
  validGitHubSignature,
  validNetworkAuthorization,
  webhookAutomaticLaneUpdates,
  webhookForcesTagPoll,
  webhookScanUpdates,
} from "./tailscale.ts";

test("uses a Tailscale executable available on PATH", () => {
  expect(
    tailscaleExecutable((name) => (name === "tailscale" ? "/usr/local/bin/tailscale" : null)),
  ).toBe("/usr/local/bin/tailscale");
});

test("bounds status and forces Tailscale's CLI mode in background workers", async () => {
  let term: string | undefined;
  let timeoutMs: number | undefined;
  await tailscaleStatus(
    async (_argv, options) => {
      term = options?.env?.TERM;
      timeoutMs = options?.timeoutMs;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          BackendState: "Running",
          Self: { ID: "self-id", HostName: "lead", Online: true, TailscaleIPs: ["100.64.0.1"] },
        }),
        stderr: "",
        timedOut: false,
      };
    },
    () => "/usr/bin/tailscale",
  );
  expect(term).toBe(Bun.env.TERM ?? "dumb");
  expect(timeoutMs).toBe(10_000);
});

test("opens Funnel authorization and times out with Tailscale's actionable output", async () => {
  let timeoutMs: number | undefined;
  let openedBeforeComplete: number | undefined;
  const opened: string[] = [];
  await expect(
    prepareTailscaleFunnel(
      {
        executable: "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        online: true,
        self: {
          id: "self-id",
          hostName: "lead",
          dnsName: "lead.example.ts.net",
          addresses: ["100.64.0.1"],
          online: true,
        },
        peers: [],
      },
      7640,
      async (_argv, options) => {
        timeoutMs = options?.timeoutMs;
        await options?.onOutput?.(
          "Authorize Funnel: https://login.tailscale.com/f/funnel?node=self",
        );
        openedBeforeComplete = opened.length;
        await options?.onOutput?.("-id\n");
        return {
          exitCode: 143,
          stdout: "Authorize Funnel: https://login.tailscale.com/f/funnel?node=self-id",
          stderr: "",
          timedOut: true,
        };
      },
      (url) => {
        opened.push(url);
      },
    ),
  ).rejects.toThrow(
    "could not enable Tailscale Funnel within 2 minutes: Authorize Funnel: https://login.tailscale.com/f/funnel?node=self-id",
  );
  expect(timeoutMs).toBe(120_000);
  expect(openedBeforeComplete).toBe(0);
  expect(opened).toEqual(["https://login.tailscale.com/f/funnel?node=self-id"]);
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
  const app = {
    name: "Informant acme",
    slug: "informant-acme",
    owner: { login: "acme", type: "Organization" },
  };
  try {
    await expect(
      requireGitHubAppWebhookEvents(credentials, (async (_input, _init) =>
        Response.json({ ...app, events: ["push", "pull_request"] })) as typeof fetch),
    ).rejects.toThrow(
      "https://github.com/organizations/acme/settings/apps/informant-acme/permissions",
    );
    await expect(
      requireGitHubAppWebhookEvents(credentials, (async (_input, _init) =>
        Response.json({
          ...app,
          events: ["push", "pull_request", "issue_comment", "check_suite"],
        })) as typeof fetch),
    ).resolves.toBeUndefined();
    await expect(
      githubAppWebhookSettings(credentials, (async (_input, _init) =>
        Response.json({
          ...app,
          owner: { login: "ian", type: "User" },
          events: [],
        })) as typeof fetch),
    ).resolves.toMatchObject({
      settingsUrl: "https://github.com/settings/apps/informant-acme",
      permissionsUrl: "https://github.com/settings/apps/informant-acme/permissions",
    });
    await expect(
      githubAppWebhookSettings(
        credentials,
        (async (_input, _init) => new Response("not JSON")) as typeof fetch,
      ),
    ).rejects.toThrow("GitHub App 123: invalid API response");
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

test("falls back to polling when configured Tailscale coordination is unavailable", async () => {
  const config = {
    mode: "lead" as const,
    workerPort: 7639,
    funnelPort: 7640,
    funnelUrl: "https://lead.example.ts.net",
    webhookSecret: "webhook-secret",
    networkSecret: "network-secret-that-is-at-least-32-characters",
  };
  const messages: string[] = [];
  let pollingStarts = 0;
  const servePolling = async () => {
    pollingStarts++;
  };

  await serveWithTailscale(
    [],
    { onMessage: (message) => messages.push(message) },
    {
      getConfig: async () => {
        throw new Error("invalid Tailscale configuration");
      },
      servePolling,
    },
  );
  await serveWithTailscale(
    [],
    { onMessage: (message) => messages.push(message) },
    {
      getConfig: async () => config,
      status: async () => undefined,
      servePolling,
    },
  );
  await serveWithTailscale(
    [],
    { onMessage: (message) => messages.push(message) },
    {
      getConfig: async () => config,
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
      serveNetwork: async () => {
        throw new Error("Funnel failed");
      },
      servePolling,
    },
  );

  expect(pollingStarts).toBe(3);
  expect(messages).toEqual([
    "Tailscale configuration unavailable; polling GitHub instead: invalid Tailscale configuration",
    "Tailscale coordination unavailable; polling GitHub instead: Tailscale is offline",
    "Tailscale coordination unavailable; polling GitHub instead: Funnel failed",
  ]);
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

test("validates bounded network claim scheduling plans", () => {
  const resources = {
    capacity: { cpu: 4, memoryMb: 8192 },
    used: { cpu: 1, memoryMb: 1024 },
    queued: { cpu: 0, memoryMb: 0 },
  };
  const plan = {
    rotation: 3,
    claimants: [
      { id: "blackbird", capabilities: ["darwin", "container"], resources },
      { id: "watchdog", capabilities: ["linux", "container"], resources },
    ],
  };
  expect(parseNetworkClaimPlan(plan)).toEqual(plan);
  expect(() =>
    parseNetworkClaimPlan({ ...plan, claimants: [...plan.claimants, plan.claimants[0]] }),
  ).toThrow("invalid claim scheduling");
  expect(() => parseNetworkClaimPlan({ ...plan, rotation: -1 })).toThrow(
    "invalid claim scheduling",
  );
  expect(() =>
    parseNetworkClaimPlan({
      ...plan,
      claimants: [
        {
          ...plan.claimants[0],
          resources: { ...resources, capacity: { ...resources.capacity, cpu: 0 } },
        },
      ],
    }),
  ).toThrow("invalid claim scheduling");

  const sixtyFour = Array.from({ length: 64 }, (_, index) => ({
    id: `worker-${index}`,
    capabilities: ["container"],
    resources,
  }));
  const first = sixtyFour[0];
  const second = sixtyFour[1];
  if (!first || !second) throw new Error("expected claimants");
  const sixtyFive = [...sixtyFour, { ...first, id: "worker-64" }];
  expect(generatedNetworkClaimPlan(sixtyFour, 7)).toEqual({ claimants: sixtyFour, rotation: 7 });
  expect(generatedNetworkClaimPlan(sixtyFive, 8)).toBeUndefined();
  expect(() => parseNetworkClaimPlan({ claimants: sixtyFive, rotation: 8 })).toThrow(
    "invalid claim scheduling",
  );

  const excessiveCapabilities = {
    ...second,
    capabilities: Array.from({ length: 257 }, (_, index) => `capability-${index}`),
  };
  const longCapability = {
    ...second,
    capabilities: ["x".repeat(257)],
  };
  const duplicateId = { ...second, id: first.id };
  const longId = { ...second, id: "w".repeat(257) };
  const invalidResources = {
    ...second,
    resources: { ...resources, capacity: { ...resources.capacity, cpu: 0 } },
  };
  for (const invalid of [
    excessiveCapabilities,
    longCapability,
    duplicateId,
    longId,
    invalidResources,
  ]) {
    expect(generatedNetworkClaimPlan([first, invalid], 9)).toBeUndefined();
  }
});

test("queries the running worker for the local resource snapshot", async () => {
  const resources = {
    capacity: { cpu: 8, memoryMb: 16_384 },
    used: { cpu: 5, memoryMb: 6144 },
    queued: { cpu: 2, memoryMb: 2048 },
  };
  const status: TailscaleStatus = {
    executable: "/usr/bin/tailscale",
    online: true,
    self: {
      id: "self",
      hostName: "worker",
      addresses: ["100.64.0.1"],
      online: true,
    },
    peers: [],
  };
  let authorization: string | undefined;
  const result = await localNetworkExecutionCapacity(
    {
      mode: "worker",
      workerPort: 7639,
      funnelPort: 7640,
      networkSecret: "network-secret-that-is-at-least-32-characters",
    },
    status,
    {
      capacity: { cpu: 1, memoryMb: 1024 },
      used: { cpu: 0, memoryMb: 0 },
      queued: { cpu: 0, memoryMb: 0 },
    },
    async (_url, options) => {
      authorization = new Headers(options?.headers).get("Authorization") ?? undefined;
      return Response.json({ resources });
    },
  );
  expect(result).toEqual(resources);
  expect(authorization).toBe("Bearer network-secret-that-is-at-least-32-characters");
});

test("extracts and validates bounded automatic lane updates", () => {
  const oldSha = "a".repeat(40);
  const newSha = "b".repeat(40);
  expect(
    webhookAutomaticLaneUpdates(
      "push",
      {
        ref: "refs/heads/feature/fast",
        before: oldSha,
        after: newSha,
        repository: { pushed_at: 200 },
      },
      "delivery-1",
    ),
  ).toEqual([
    {
      lane: "branch:feature/fast",
      sha: newSha,
      obsoleteShas: [oldSha],
      updatedAt: 200_000,
      revision: "delivery-1",
    },
  ]);
  expect(
    webhookAutomaticLaneUpdates("pull_request", {
      action: "synchronize",
      number: 42,
      before: oldSha,
      pull_request: { head: { sha: newSha }, updated_at: "2026-08-15T00:00:00Z" },
    }),
  ).toEqual([
    {
      lane: "pr:42",
      sha: newSha,
      obsoleteShas: [oldSha],
      updatedAt: Date.parse("2026-08-15T00:00:00Z"),
    },
  ]);
  expect(
    webhookAutomaticLaneUpdates("pull_request", {
      action: "closed",
      number: 42,
    }),
  ).toEqual([{ lane: "pr:42", closed: true }]);
  expect(parseAutomaticLaneUpdates([{ lane: "branch:main", sha: newSha }])).toEqual([
    { lane: "branch:main", sha: newSha },
  ]);
  const retired = { lane: "branch:main", sha: oldSha, revision: "delivery-old" };
  const newer = { lane: "branch:main", sha: newSha, revision: "delivery-new" };
  const other = { lane: "branch:release", sha: newSha, revision: "delivery-release" };
  expect(retireAutomaticLaneUpdate([newer, other], retired)).toEqual([newer, other]);
  expect(retireAutomaticLaneUpdate([retired, other], retired)).toEqual([other]);
  expect(
    mergeAutomaticLaneUpdates(
      [{ ...newer, updatedAt: 300 }],
      [{ lane: "branch:main", closed: true, obsoleteShas: [oldSha], updatedAt: 300 }],
    ),
  ).toEqual([{ ...newer, obsoleteShas: [oldSha], updatedAt: 300 }]);
  const timestampedHead = { ...retired, updatedAt: 300 };
  expect(
    mergeAutomaticLaneUpdates([timestampedHead], [{ lane: "branch:main", sha: oldSha }]),
  ).toEqual([timestampedHead]);
  expect(
    mergeAutomaticLaneUpdates(
      [timestampedHead],
      [{ lane: "branch:main", sha: oldSha, revision: "delivery-redelivered" }],
    ),
  ).toEqual([{ ...timestampedHead, revision: "delivery-redelivered" }]);

  const sameSecondMissedTransition = {
    lane: "branch:main",
    sha: "c".repeat(40),
    obsoleteShas: [newSha],
    updatedAt: 300,
    revision: "delivery-newest",
  };
  const retainedSameSecondTransition = {
    ...sameSecondMissedTransition,
    obsoleteShas: [oldSha, newSha],
  };
  expect(
    mergeAutomaticLaneUpdates([{ ...retired, updatedAt: 300 }], [sameSecondMissedTransition]),
  ).toEqual([retainedSameSecondTransition]);
  expect(
    automaticLaneUpdatesRefreshRetention(
      [{ ...retired, updatedAt: 300 }],
      [sameSecondMissedTransition],
    ),
  ).toBe(true);
  const delayedSameSecondTransition = {
    lane: "branch:main",
    sha: newSha,
    obsoleteShas: [oldSha],
    updatedAt: 300,
    revision: "delivery-delayed",
  };
  expect(
    mergeAutomaticLaneUpdates([retainedSameSecondTransition], [delayedSameSecondTransition]),
  ).toEqual([retainedSameSecondTransition]);
  expect(
    mergeAutomaticLaneUpdates(
      [retainedSameSecondTransition],
      [{ ...retired, updatedAt: 300, revision: "delivery-redelivered-a" }],
    ),
  ).toEqual([retainedSameSecondTransition]);
  expect(
    automaticLaneUpdatesRefreshRetention(
      [retainedSameSecondTransition],
      [delayedSameSecondTransition],
    ),
  ).toBe(false);
  const sameSecondRollback = {
    lane: "branch:main",
    sha: oldSha,
    obsoleteShas: ["c".repeat(40)],
    updatedAt: 300,
    revision: "delivery-rollback",
  };
  expect(mergeAutomaticLaneUpdates([retainedSameSecondTransition], [sameSecondRollback])).toEqual([
    { ...sameSecondRollback, obsoleteShas: [newSha, "c".repeat(40)] },
  ]);
  expect(() => parseAutomaticLaneUpdates([{ lane: "branch:main", sha: "short" }])).toThrow(
    "invalid automatic lane updates",
  );
  expect(
    mergeAutomaticLaneUpdates(
      [
        { lane: "branch:main", sha: oldSha },
        { lane: "branch:release", sha: oldSha },
      ],
      [{ lane: "branch:main", sha: newSha, obsoleteShas: [oldSha] }],
    ),
  ).toEqual([
    { lane: "branch:release", sha: oldSha },
    { lane: "branch:main", sha: newSha, obsoleteShas: [oldSha] },
  ]);
  expect(
    mergeAutomaticLaneUpdates(
      [{ lane: "branch:main", sha: newSha, obsoleteShas: [oldSha] }],
      [{ lane: "branch:main", sha: oldSha, obsoleteShas: ["c".repeat(40)] }],
    ),
  ).toEqual([
    {
      lane: "branch:main",
      sha: newSha,
      obsoleteShas: ["c".repeat(40), oldSha],
    },
  ]);
  expect(
    mergeAutomaticLaneUpdates(
      [
        {
          lane: "branch:main",
          sha: newSha,
          obsoleteShas: [oldSha],
          updatedAt: 200,
        },
      ],
      [
        {
          lane: "branch:main",
          sha: "d".repeat(40),
          obsoleteShas: ["c".repeat(40)],
          updatedAt: 100,
        },
      ],
    ),
  ).toEqual([
    {
      lane: "branch:main",
      sha: newSha,
      obsoleteShas: ["c".repeat(40), "d".repeat(40), oldSha],
      updatedAt: 200,
    },
  ]);

  const retained = Array.from({ length: 64 }, (_, index) => ({
    lane: `branch:lane-${index}`,
    sha: newSha,
    updatedAt: 200,
  }));
  const bounded = mergeAutomaticLaneUpdates(retained, [
    { lane: "branch:lane-0", sha: oldSha, updatedAt: 100 },
    { lane: "branch:lane-64", sha: newSha, updatedAt: 200 },
  ]);
  expect(bounded?.some((update) => update.lane === "branch:lane-0")).toBe(false);
  expect(bounded?.some((update) => update.lane === "branch:lane-1")).toBe(true);

  expect(
    automaticLaneUpdatesRefreshRetention(
      [{ lane: "branch:main", sha: newSha, updatedAt: 200, revision: "current" }],
      [{ lane: "branch:main", sha: oldSha, updatedAt: 100, revision: "stale" }],
    ),
  ).toBe(false);
  expect(
    automaticLaneUpdatesRefreshRetention(
      [{ lane: "branch:main", sha: newSha, updatedAt: 200, revision: "current" }],
      [{ lane: "branch:new", sha: newSha, updatedAt: 200, revision: "new-lane" }],
    ),
  ).toBe(true);
});

test("rejects delayed webhook heads against retained remote ordering", () => {
  const current = {
    lane: "pr:90",
    sha: "b".repeat(40),
    obsoleteShas: ["a".repeat(40)],
    updatedAt: 200,
    revision: "current",
  };
  const delayed = {
    lane: "pr:90",
    sha: "a".repeat(40),
    updatedAt: 100,
    revision: "delayed",
  };
  const newer = {
    lane: "pr:90",
    sha: "c".repeat(40),
    obsoleteShas: [current.sha],
    updatedAt: 300,
    revision: "newer",
  };

  expect(acceptedAutomaticLaneUpdates([current], [delayed])).toEqual([]);
  expect(acceptedAutomaticLaneUpdates([current], [newer])).toEqual([newer]);
});

test("targets signed same-repository webhook heads", () => {
  const repository = { owner: "owner", repo: "repo", fullName: "owner/repo" };
  const update = { lane: "pr:90", sha: "a".repeat(40) };
  const payload = {
    pull_request: { head: { repo: { full_name: "OWNER/REPO" } } },
  };

  expect(webhookScanUpdates("pull_request", payload, repository, [update])).toEqual([update]);
  expect(
    webhookScanUpdates(
      "pull_request",
      { pull_request: { head: { repo: { full_name: "fork/repo" } } } },
      repository,
      [update],
    ),
  ).toBeUndefined();
  expect(
    webhookScanUpdates("pull_request", payload, repository, [
      { lane: "pr:90", closed: true as const },
    ]),
  ).toBeUndefined();
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
  expect(actionableWebhook("check_suite", { action: "requested" })).toBe(false);
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

test("periodic reconciliation covers local and remote-only repositories", () => {
  expect(NETWORK_RECONCILIATION_INTERVAL_MS).toBe(5 * 60_000);
  const local = { owner: "owner", repo: "local", fullName: "owner/local" };
  const remote = {
    id: "remote",
    hostName: "remote",
    address: "100.64.0.2",
    capabilities: [],
    repositories: ["OWNER/LOCAL", "owner/remote"],
  };

  expect(networkReconciliationRequests([local], [remote])).toEqual([
    { repository: local, forceTagPoll: false, fullScan: true },
    {
      repository: { owner: "owner", repo: "remote", fullName: "owner/remote" },
      forceTagPoll: false,
      fullScan: true,
    },
  ]);
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

test("runs another dispatch with its latest claim plan during an active dispatch", async () => {
  const requests: boolean[] = [];
  const plans: Array<number | undefined> = [];
  let finishFirst!: (value: boolean) => void;
  const first = new Promise<boolean>((resolve) => {
    finishFirst = resolve;
  });
  const repository = { owner: "owner", repo: "repo", fullName: "owner/repo" };
  const queue = new DispatchRetryQueue(async (request) => {
    requests.push(request.forceTagPoll);
    plans.push(request.claimPlan?.rotation);
    return requests.length === 1 ? first : true;
  });

  queue.enqueue({ repository, forceTagPoll: false });
  while (requests.length === 0) await Bun.sleep(0);
  queue.enqueue({
    repository,
    forceTagPoll: false,
    claimPlan: {
      rotation: 7,
      claimants: [
        {
          id: "watchdog",
          capabilities: ["linux"],
          resources: {
            capacity: { cpu: 4, memoryMb: 8192 },
            used: { cpu: 0, memoryMb: 0 },
            queued: { cpu: 0, memoryMb: 0 },
          },
        },
      ],
    },
  });
  finishFirst(true);
  while (queue.size > 0) await Bun.sleep(0);

  expect(requests).toEqual([false, false]);
  expect(plans).toEqual([undefined, 7]);
  await queue.stop();
});

test("a successful dispatch does not replay consumed webhook heads", async () => {
  const requests: string[][] = [];
  let finishFirst!: (value: boolean) => void;
  const first = new Promise<boolean>((resolve) => {
    finishFirst = resolve;
  });
  const repository = { owner: "owner", repo: "repo", fullName: "owner/repo" };
  const queue = new DispatchRetryQueue(async (request) => {
    requests.push(request.scanUpdates?.map((update) => update.lane) ?? []);
    return requests.length === 1 ? first : true;
  });

  queue.enqueue({
    repository,
    forceTagPoll: false,
    scanUpdates: [{ lane: "pr:90", sha: "a".repeat(40) }],
  });
  while (requests.length === 0) await Bun.sleep(0);
  queue.enqueue({
    repository,
    forceTagPoll: false,
    scanUpdates: [{ lane: "branch:main", sha: "b".repeat(40) }],
  });
  finishFirst(true);
  while (queue.size > 0) await Bun.sleep(0);

  expect(requests).toEqual([["pr:90"], ["branch:main"]]);
  await queue.stop();
});

test("an unplanned dispatch clears a coalesced stale claim plan", async () => {
  const plans: Array<number | undefined> = [];
  let finishFirst!: (value: boolean) => void;
  const first = new Promise<boolean>((resolve) => {
    finishFirst = resolve;
  });
  const repository = { owner: "owner", repo: "repo", fullName: "owner/repo" };
  const resources = {
    capacity: { cpu: 4, memoryMb: 8192 },
    used: { cpu: 0, memoryMb: 0 },
    queued: { cpu: 0, memoryMb: 0 },
  };
  const queue = new DispatchRetryQueue(async (request) => {
    plans.push(request.claimPlan?.rotation);
    return plans.length === 1 ? first : true;
  });

  queue.enqueue({
    repository,
    forceTagPoll: false,
    claimPlan: {
      rotation: 7,
      claimants: [{ id: "watchdog", capabilities: ["linux"], resources }],
    },
  });
  while (plans.length === 0) await Bun.sleep(0);
  queue.enqueue({ repository, forceTagPoll: false });
  finishFirst(true);
  while (queue.size > 0) await Bun.sleep(0);

  expect(plans).toEqual([7, undefined]);
  await queue.stop();
});

test("retains failed dispatches and preserves queued webhook heads", async () => {
  const callbacks: Array<() => void> = [];
  const requests: Array<{ forceTagPoll: boolean; fullScan: boolean; lanes: string[] }> = [];
  let finishFirst!: (value: boolean) => void;
  const first = new Promise<boolean>((resolve) => {
    finishFirst = resolve;
  });
  const repository = { owner: "owner", repo: "repo", fullName: "owner/repo" };
  const queue = new DispatchRetryQueue(
    async (request) => {
      requests.push({
        forceTagPoll: request.forceTagPoll,
        fullScan: request.fullScan === true,
        lanes: request.scanUpdates?.map((update) => update.lane) ?? [],
      });
      return requests.length === 1 ? first : true;
    },
    () => {},
    (callback) => {
      callbacks.push(callback);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
    () => {},
  );

  queue.enqueue({
    repository,
    forceTagPoll: false,
    scanUpdates: [{ lane: "pr:90", sha: "a".repeat(40) }],
  });
  while (requests.length === 0) await Bun.sleep(0);
  queue.enqueue({
    repository,
    forceTagPoll: true,
    fullScan: true,
    scanUpdates: [{ lane: "branch:main", sha: "b".repeat(40) }],
  });
  finishFirst(false);
  while (callbacks.length === 0) await Bun.sleep(0);
  callbacks.shift()?.();
  while (queue.size > 0) await Bun.sleep(0);

  expect(requests).toEqual([
    { forceTagPoll: false, fullScan: false, lanes: ["pr:90"] },
    { forceTagPoll: true, fullScan: true, lanes: ["pr:90", "branch:main"] },
  ]);
  await queue.stop();
});
