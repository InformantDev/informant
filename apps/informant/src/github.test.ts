import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { GitHubApiError, GitHubClient, MANUAL_TRIGGER_REQUEST_NAME } from "./github.ts";
import type { CheckRun } from "./types.ts";

test("job access tokens are freshly minted and downscoped to one repository", async () => {
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  });
  let requestBody: Record<string, unknown> | undefined;
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ token: "job-token", expires_at: "2099-01-01T00:00:00Z" });
  }) as typeof globalThis.fetch;
  const repository = { owner: "acme", repo: "widgets", fullName: "acme/widgets" };
  const github = new GitHubClient({
    token: "static-token-that-must-not-be-reused",
    fetch,
    repository,
    credentials: {
      appId: "123",
      installationId: "456",
      privateKey: String(privateKey),
    },
  });

  expect(await github.createJobAccessToken(repository)).toBe("job-token");
  expect(requestBody).toEqual({
    repositories: ["widgets"],
    permissions: { pull_requests: "write" },
  });
});

test("rate limit errors preserve GitHub's reset time", async () => {
  const reset = Math.floor(Date.now() / 1_000);
  const fetch = (async () =>
    new Response('{"message":"API rate limit exceeded"}', {
      status: 403,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(reset),
      },
    })) as unknown as typeof globalThis.fetch;

  const error = await new GitHubClient({ token: "installation-token", fetch })
    .defaultBranch({ owner: "acme", repo: "widgets", fullName: "acme/widgets" })
    .catch((value) => value);

  expect(error).toBeInstanceOf(GitHubApiError);
  expect(error.status).toBe(403);
  expect(error.retryAt).toBe(reset * 1_000);
});

test("rate limited requests wait and retry once", async () => {
  let requests = 0;
  const fetch = (async () => {
    requests++;
    if (requests === 1) {
      return new Response('{"message":"API rate limit exceeded"}', {
        status: 403,
        headers: { "retry-after": "0" },
      });
    }
    return Response.json({ default_branch: "main" });
  }) as unknown as typeof globalThis.fetch;

  const branch = await new GitHubClient({ token: "installation-token", fetch }).defaultBranch({
    owner: "retry-test",
    repo: "widgets",
    fullName: "retry-test/widgets",
  });

  expect(branch).toBe("main");
  expect(requests).toBe(2);
});

test("shutdown interrupts a rate limit wait before retrying", async () => {
  const shutdown = new AbortController();
  let requests = 0;
  const fetch = (async () => {
    requests++;
    return new Response('{"message":"API rate limit exceeded"}', {
      status: 403,
      headers: { "retry-after": "60" },
    });
  }) as unknown as typeof globalThis.fetch;
  const repository = { owner: "abort-test", repo: "widgets", fullName: "abort-test/widgets" };
  const pending = new GitHubClient({
    token: "installation-token",
    fetch,
    repository,
  }).defaultBranch(repository, shutdown.signal);

  while (requests === 0) await Bun.sleep(1);
  shutdown.abort("Worker shutdown requested.");

  expect(await pending.catch((error) => error)).toBe("Worker shutdown requested.");
  expect(requests).toBe(1);
});

test("suite rerun detection forwards its cancellation signal", async () => {
  let suiteSignal: AbortSignal | null | undefined;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/check-suites")) {
      suiteSignal = init?.signal;
      return Response.json({ check_suites: [{ status: "queued" }] });
    }
    const name = url.searchParams.get("check_name");
    return Response.json({
      check_runs:
        name === MANUAL_TRIGGER_REQUEST_NAME
          ? []
          : [{ id: 1, name: "Informant CI", status: "completed" }],
    });
  }) as typeof globalThis.fetch;
  const repository = { owner: "rerun-signal", repo: "widgets", fullName: "rerun-signal/widgets" };
  const shutdown = new AbortController();

  expect(
    await new GitHubClient({ token: "installation-token", fetch }).hasPendingManualTrigger(
      repository,
      "abc123",
      "main",
      "main",
      shutdown.signal,
    ),
  ).toBe(true);
  expect(suiteSignal).toBe(shutdown.signal);
});

test("post-claim election ignores admission cancellation but honors forced shutdown", async () => {
  let reads = 0;
  let candidateSignal: AbortSignal | null | undefined;
  let cleanupSignal: AbortSignal | null | undefined;
  let cleanupBody:
    | { status?: string; conclusion?: string; output?: { title?: string } }
    | undefined;
  let electionSignal: AbortSignal | null | undefined;
  let enterElection!: () => void;
  const enteredElection = new Promise<void>((resolve) => {
    enterElection = resolve;
  });
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      cleanupSignal = init.signal;
      cleanupBody = JSON.parse(String(init.body));
      return Response.json({ id: 1, name: "Informant CI", status: "completed" });
    }
    if (init?.method === "POST") {
      candidateSignal = init.signal;
      return Response.json({
        id: 1,
        name: "Informant CI",
        status: "in_progress",
        external_id: "worker:event:commit:branch:main:abc123",
      });
    }
    reads++;
    if (reads <= 2) return Response.json({ check_runs: [] });
    electionSignal = init?.signal;
    enterElection();
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return reject(new Error("expected an execution signal"));
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as typeof globalThis.fetch;
  const repository = {
    owner: "election-signal",
    repo: "widgets",
    fullName: "election-signal/widgets",
  };
  const admission = new AbortController();
  const execution = new AbortController();
  const pending = new GitHubClient({ token: "installation-token", fetch }).claim(
    repository,
    "abc123",
    "worker",
    { type: "commit", id: "branch:main:abc123", branch: "main" },
    undefined,
    true,
    [],
    false,
    admission.signal,
    execution.signal,
  );

  await enteredElection;
  admission.abort("Worker shutdown requested.");
  expect(candidateSignal).toBe(execution.signal);
  expect(electionSignal).toBe(execution.signal);
  expect(electionSignal?.aborted).toBe(false);
  execution.abort("Graceful worker shutdown timed out.");

  expect(await pending.catch((error) => error)).toBe("Graceful worker shutdown timed out.");
  expect(cleanupSignal).not.toBe(admission.signal);
  expect(cleanupSignal).not.toBe(execution.signal);
  expect(cleanupBody).toMatchObject({
    status: "completed",
    conclusion: "cancelled",
    output: { title: "Claim interrupted" },
  });
});

test("candidate creation finishes before honoring admission cancellation", async () => {
  let candidateSignal: AbortSignal | null | undefined;
  let cleanupBody:
    | { status?: string; conclusion?: string; output?: { title?: string } }
    | undefined;
  let enterCandidate!: () => void;
  let resolveCandidate!: (response: Response) => void;
  const enteredCandidate = new Promise<void>((resolve) => {
    enterCandidate = resolve;
  });
  const candidateResponse = new Promise<Response>((resolve) => {
    resolveCandidate = resolve;
  });
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      cleanupBody = JSON.parse(String(init.body));
      return Response.json({ id: 1, name: "Informant CI", status: "completed" });
    }
    if (init?.method === "POST") {
      candidateSignal = init.signal;
      enterCandidate();
      return candidateResponse;
    }
    return Response.json({ check_runs: [] });
  }) as typeof globalThis.fetch;
  const repository = {
    owner: "candidate-signal",
    repo: "widgets",
    fullName: "candidate-signal/widgets",
  };
  const admission = new AbortController();
  const execution = new AbortController();
  const pending = new GitHubClient({ token: "installation-token", fetch }).claim(
    repository,
    "abc123",
    "worker",
    { type: "commit", id: "branch:main:abc123", branch: "main" },
    undefined,
    true,
    [],
    false,
    admission.signal,
    execution.signal,
  );

  await enteredCandidate;
  expect(candidateSignal).toBe(execution.signal);
  admission.abort("Worker shutdown requested.");
  resolveCandidate(
    Response.json({
      id: 1,
      name: "Informant CI",
      status: "in_progress",
      external_id: "worker:event:commit:branch:main:abc123",
    }),
  );

  expect(await pending.catch((error) => error)).toBe("Worker shutdown requested.");
  expect(execution.signal.aborted).toBe(false);
  expect(cleanupBody).toMatchObject({
    status: "completed",
    conclusion: "cancelled",
    output: { title: "Claim interrupted" },
  });
});

test("uncertain candidate creation is reconciled after forced shutdown", async () => {
  const candidate = {
    id: 7,
    name: "Informant CI",
    status: "in_progress",
    external_id: "worker:event:commit:branch:main:abc123",
  } satisfies CheckRun;
  let enteredCandidate!: () => void;
  let cleanupBody:
    | { status?: string; conclusion?: string; output?: { title?: string } }
    | undefined;
  const candidateStarted = new Promise<void>((resolve) => {
    enteredCandidate = resolve;
  });
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      cleanupBody = JSON.parse(String(init.body));
      return Response.json({ ...candidate, status: "completed" });
    }
    if (init?.method === "POST") {
      enteredCandidate();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        if (!signal) return reject(new Error("expected an execution signal"));
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    return Response.json({ check_runs: [candidate] });
  }) as typeof globalThis.fetch;
  const repository = {
    owner: "candidate-reconcile",
    repo: "widgets",
    fullName: "candidate-reconcile/widgets",
  };
  const admission = new AbortController();
  const execution = new AbortController();
  const pending = new GitHubClient({ token: "installation-token", fetch }).claim(
    repository,
    "abc123",
    "worker",
    { type: "commit", id: "branch:main:abc123", branch: "main" },
    undefined,
    true,
    [],
    false,
    admission.signal,
    execution.signal,
  );

  await candidateStarted;
  execution.abort("Graceful worker shutdown timed out.");

  expect(await pending.catch((error) => error)).toBe("Graceful worker shutdown timed out.");
  expect(cleanupBody).toMatchObject({
    status: "completed",
    conclusion: "cancelled",
    output: { title: "Claim interrupted" },
  });
});

test("interrupted claims do not suppress a later retry", async () => {
  const interrupted: CheckRun = {
    id: 1,
    name: "Informant CI",
    status: "completed",
    conclusion: "cancelled",
    external_id: "old-worker:event:commit:branch:main:abc123",
    output: { title: "Claim interrupted" },
  };
  let candidate: CheckRun | undefined;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      candidate = { id: 2, ...body } as CheckRun;
      return Response.json(candidate);
    }
    if (url.pathname.endsWith("/check-suites")) {
      return Response.json({ check_suites: [{ status: "completed" }] });
    }
    if (url.searchParams.get("check_name") === MANUAL_TRIGGER_REQUEST_NAME) {
      return Response.json({ check_runs: [] });
    }
    return Response.json({ check_runs: [interrupted, ...(candidate ? [candidate] : [])] });
  }) as typeof globalThis.fetch;

  const claim = await new GitHubClient({ token: "installation-token", fetch }).claim(
    { owner: "claim-retry", repo: "widgets", fullName: "claim-retry/widgets" },
    "abc123",
    "new-worker",
    { type: "commit", id: "branch:main:abc123", branch: "main" },
  );

  expect(claim?.check?.id).toBe(2);
});

test("check output strips terminal control sequences", async () => {
  let requestBody: { output?: { text?: string } } | undefined;
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ id: 1, name: "Informant / test", status: "in_progress" });
  }) as typeof globalThis.fetch;

  await new GitHubClient({ token: "installation-token", fetch }).updateCheck(
    { owner: "acme", repo: "widgets", fullName: "acme/widgets" },
    1,
    {
      title: "\x1b[1mtest\x1b[0m",
      summary: "\x1b[33mrunning\x1b[0m",
      text: "```text\r\n\x1b[31mfailed\x1b[0m\r\n```",
    },
  );

  expect(requestBody?.output).toMatchObject({ title: "test", summary: "running" });
  expect(requestBody?.output?.text).toBe("```text\nfailed\n```");
});

test("directory files returns sorted TOML files only", async () => {
  let requested = "";
  const fetch = (async (input: string | URL | Request) => {
    requested = String(input);
    return Response.json([
      { name: "test.toml", path: ".informant/jobs/test.toml", type: "file" },
      { name: "notes.md", path: ".informant/jobs/notes.md", type: "file" },
      { name: "build.toml", path: ".informant/jobs/build.toml", type: "file" },
      { name: "nested.toml", path: ".informant/jobs/nested.toml", type: "dir" },
    ]);
  }) as typeof globalThis.fetch;
  const files = await new GitHubClient({ token: "installation-token", fetch }).directoryFiles(
    { owner: "acme", repo: "widgets", fullName: "acme/widgets" },
    "abc123",
    ".informant/jobs",
  );

  expect(files).toEqual([".informant/jobs/build.toml", ".informant/jobs/test.toml"]);
  expect(requested).toContain("/contents/.informant%2Fjobs?ref=abc123");
});

test("claim elects the oldest active check using the full check history", async () => {
  const urls: string[] = [];
  let reads = 0;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (init?.method === "POST") {
      return Response.json({
        id: 10,
        name: "Informant CI",
        status: "in_progress",
        external_id: "machine",
      });
    }
    reads++;
    return Response.json({
      check_runs:
        reads === 1
          ? []
          : [{ id: 10, name: "Informant CI", status: "in_progress", external_id: "machine" }],
    });
  }) as typeof globalThis.fetch;

  const github = new GitHubClient({ token: "installation-token", fetch });
  const claim = await github.claim(
    { owner: "acme", repo: "widgets", fullName: "acme/widgets" },
    "abc123",
    "machine",
  );

  expect(claim?.check?.id).toBe(10);
  expect(claim?.requestedJobs).toEqual([]);
  expect(urls.filter((url) => url.includes("check-runs"))).toHaveLength(4);
  expect(urls.some((url) => url.includes("filter=all") && url.includes("per_page=100"))).toBe(true);
});

test("checks paginates through the complete check history", async () => {
  const pages: number[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const page = Number(new URL(String(input)).searchParams.get("page"));
    pages.push(page);
    const count = page === 1 ? 100 : 1;
    return Response.json({
      check_runs: Array.from({ length: count }, (_, index) => ({
        id: (page - 1) * 100 + index,
        name: "Informant CI",
        status: "completed",
      })),
    });
  }) as typeof globalThis.fetch;

  const checks = await new GitHubClient({ token: "installation-token", fetch }).checks(
    { owner: "acme", repo: "widgets", fullName: "acme/widgets" },
    "abc123",
  );

  expect(checks).toHaveLength(101);
  expect(pages).toEqual([1, 2]);
});

test("tags paginate and map dereferenced commit SHAs", async () => {
  const pages: number[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const page = Number(new URL(String(input)).searchParams.get("page"));
    pages.push(page);
    const count = page === 1 ? 100 : 1;
    return Response.json(
      Array.from({ length: count }, (_, index) => ({
        name: `v${(page - 1) * 100 + index}`,
        commit: { sha: `commit-${page}-${index}` },
      })),
    );
  }) as typeof globalThis.fetch;

  const tags = await new GitHubClient({ token: "installation-token", fetch }).tags({
    owner: "acme",
    repo: "widgets",
    fullName: "acme/widgets",
  });
  expect(tags).toHaveLength(101);
  expect(tags[100]).toEqual({ name: "v100", sha: "commit-2-0" });
  expect(pages).toEqual([1, 2]);
});

test("queued checks encode selected jobs in the request", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ id: 1, name: "Informant CI", status: "queued" });
  }) as typeof globalThis.fetch;
  await new GitHubClient({ token: "installation-token", fetch }).createCheck(
    { owner: "acme", repo: "widgets", fullName: "acme/widgets" },
    "abc123",
    "request",
    "queued",
    ["test", "lint"],
  );

  const encoded = String(requestBody?.external_id).split(":jobs:")[1] ?? "";
  expect(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))).toEqual(["test", "lint"]);
});

test("manual trigger context and jobs stay within GitHub's external ID limit", async () => {
  let nextId = 1;
  const checks: CheckRun[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("check-suites")) {
      return Response.json({ check_suites: [{ status: "queued" }] });
    }
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      const check = { id: nextId++, ...body } as CheckRun;
      checks.push(check);
      return Response.json(check);
    }
    if (init?.method === "PATCH") {
      const id = Number(String(input).split("/").at(-1));
      const check = checks.find((item) => item.id === id);
      if (check) Object.assign(check, JSON.parse(String(init.body)));
      return Response.json(check ?? {});
    }
    return Response.json({ check_runs: checks });
  }) as typeof globalThis.fetch;
  const github = new GitHubClient({ token: "installation-token", fetch });
  const repository = { owner: "acme", repo: "widgets", fullName: "acme/widgets" };
  const branch = `release-${"x".repeat(240)}`;
  const jobs = Array.from({ length: 20 }, (_, index) => `job-${index}`);

  const request = await github.createManualTrigger(repository, "abc123", jobs, branch, branch);
  expect(request.name).toBe(MANUAL_TRIGGER_REQUEST_NAME);
  expect(request.status).toBe("in_progress");
  expect(request.external_id?.length).toBeLessThanOrEqual(255);

  const claim = await github.claim(repository, "abc123", "worker", {
    type: "commit",
    id: `branch:${branch}:abc123`,
    branch,
    label: branch,
  });
  expect(claim?.check?.external_id?.length).toBeLessThanOrEqual(255);
  expect(claim?.manualTriggerBranch).toBe(branch);
  expect(claim?.manualTriggerLabel).toBe(branch);
  expect(claim?.requestedJobs).toEqual(jobs);

  if (!claim?.check) throw new Error("expected the manual trigger to be claimed");
  const completed = checks.find((check) => check.id === claim.check?.id);
  if (!completed) throw new Error("expected the claimed check to be persisted");
  completed.status = "completed";
  completed.conclusion = "success";
  const rerun = await github.claim(repository, "abc123", "worker", {
    type: "commit",
    id: "branch:main:abc123",
    branch: "main",
    label: "main",
  });
  expect(rerun?.manualTriggerBranch).toBe(branch);
  expect(rerun?.manualTriggerLabel).toBe(branch);
  expect(rerun?.check?.external_id?.length).toBeLessThanOrEqual(255);
});

test("claim does not fall back to automatic work when manual mode is required", async () => {
  let posts = 0;
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") posts++;
    return Response.json({ check_runs: [] });
  }) as typeof globalThis.fetch;

  const claim = await new GitHubClient({ token: "installation-token", fetch }).claim(
    { owner: "acme", repo: "widgets", fullName: "acme/widgets" },
    "abc123",
    "worker",
    { type: "commit", id: "branch:main:abc123", branch: "main" },
    undefined,
    true,
    [],
    true,
  );

  expect(claim).toEqual({ requestedJobs: [], manualTrigger: false, retry: true });
  expect(posts).toBe(0);
});

test("job checks are separate queued runs correlated to the aggregate claim", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ id: 2, name: "Informant / test", status: "queued" });
  }) as typeof globalThis.fetch;

  await new GitHubClient({ token: "installation-token", fetch }).createJobCheck(
    { owner: "acme", repo: "widgets", fullName: "acme/widgets" },
    "abc123",
    42,
    "test",
  );

  expect(requestBody).toMatchObject({
    name: "Informant / test",
    head_sha: "abc123",
    status: "queued",
    external_id: "informant-job:42:dGVzdA",
  });
});

test("claim unions targeted requests unless an all-jobs request takes precedence", async () => {
  const requestSets = [["test"], ["lint", "test"]];
  const run = async (includeAllJobs: boolean) => {
    let nextId = 100;
    const checks = [...requestSets, ...(includeAllJobs ? [[]] : [])].map((jobs, index) => ({
      id: index + 1,
      name: "Informant CI",
      status: "queued",
      external_id: `request-${index}:jobs:${Buffer.from(JSON.stringify(jobs)).toString("base64url")}`,
    }));
    const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        const check = {
          id: nextId++,
          name: body.name,
          status: body.status,
          external_id: body.external_id,
        };
        checks.push(check);
        return Response.json(check);
      }
      if (init?.method === "PATCH") return Response.json({});
      return Response.json({ check_runs: checks });
    }) as typeof globalThis.fetch;
    return new GitHubClient({ token: "installation-token", fetch }).claim(
      { owner: "acme", repo: "widgets", fullName: "acme/widgets" },
      "abc123",
      "machine",
    );
  };

  expect((await run(false))?.requestedJobs).toEqual(["test", "lint"]);
  expect((await run(true))?.requestedJobs).toEqual([]);
});

test("workers ignore manual requests for jobs outside their capabilities", async () => {
  const run = async (eligibleJobs: string[]) => {
    let posted = false;
    const checks = [
      {
        id: 1,
        name: "Informant CI",
        status: "queued",
        external_id: `request:jobs:${Buffer.from(JSON.stringify(["macos"])).toString("base64url")}`,
      },
    ];
    const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        posted = true;
        const body = JSON.parse(String(init.body));
        const check = {
          id: 2,
          name: body.name,
          status: body.status,
          external_id: body.external_id,
        };
        checks.push(check);
        return Response.json(check);
      }
      if (init?.method === "PATCH") return Response.json({});
      return Response.json({ check_runs: checks });
    }) as typeof globalThis.fetch;
    const claim = await new GitHubClient({ token: "installation-token", fetch }).claim(
      { owner: "acme", repo: "widgets", fullName: "acme/widgets" },
      "abc123",
      "machine",
      { type: "commit", id: "branch:main:abc123" },
      eligibleJobs,
    );
    return { claim, posted };
  };

  expect(await run(["linux"])).toEqual({ claim: undefined, posted: false });
  expect((await run(["macos"])).claim?.requestedJobs).toEqual(["macos"]);
});

test("manual claims defer to an active old-worker eligible-job scope", async () => {
  let posts = 0;
  const encodedJobs = Buffer.from(JSON.stringify(["gpu"])).toString("base64url");
  const encodedScope = Buffer.from("gpu").toString("base64url");
  const checks: CheckRun[] = [
    {
      id: 1,
      name: "Informant CI",
      status: "queued",
      external_id: `request:jobs:${encodedJobs}`,
    },
    {
      id: 2,
      name: "Informant CI",
      status: "in_progress",
      started_at: new Date().toISOString(),
      external_id: `old-worker:event:manual:abc123:jobs:${encodedScope}`,
    },
  ];
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") posts++;
    return Response.json({ check_runs: checks });
  }) as typeof globalThis.fetch;

  const claim = await new GitHubClient({ token: "installation-token", fetch }).claim(
    { owner: "acme", repo: "widgets", fullName: "acme/widgets" },
    "abc123",
    "new-worker",
    undefined,
    ["gpu"],
  );

  expect(claim).toEqual({ requestedJobs: [], manualTrigger: true, retry: true });
  expect(posts).toBe(0);
});

test("suite reruns defer to an active old-worker eligible-job scope", async () => {
  let posts = 0;
  const encodedScope = Buffer.from("gpu").toString("base64url");
  const aggregates: CheckRun[] = [
    {
      id: 1,
      name: "Informant CI",
      status: "completed",
      conclusion: "failure",
      external_id: "original-worker:event:commit:pr:43:abc123",
    },
    {
      id: 2,
      name: "Informant CI",
      status: "in_progress",
      started_at: new Date().toISOString(),
      external_id: `old-worker:event:commit:pr:43:abc123:jobs:${encodedScope}`,
    },
  ];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") posts++;
    if (url.includes("check-suites"))
      return Response.json({ check_suites: [{ status: "queued" }] });
    const checkName = new URL(url).searchParams.get("check_name");
    if (checkName === MANUAL_TRIGGER_REQUEST_NAME) return Response.json({ check_runs: [] });
    if (checkName) return Response.json({ check_runs: aggregates });
    return Response.json({
      check_runs: [
        {
          id: 10,
          name: "Informant / gpu",
          status: "completed",
          conclusion: "failure",
          external_id: "informant-job:1:Z3B1",
        },
      ],
    });
  }) as typeof globalThis.fetch;

  const claim = await new GitHubClient({ token: "installation-token", fetch }).claim(
    { owner: "acme", repo: "widgets", fullName: "acme/widgets" },
    "abc123",
    "new-worker",
    undefined,
    ["gpu"],
  );

  expect(claim).toEqual({ requestedJobs: [], manualTrigger: true, retry: true });
  expect(posts).toBe(0);
});

test("completed old-worker eligible-job scopes suppress election duplicates", async () => {
  let reads = 0;
  const updates: Array<{ id: number; conclusion?: string }> = [];
  const encodedJobs = Buffer.from(JSON.stringify(["gpu"])).toString("base64url");
  const encodedScope = Buffer.from("gpu").toString("base64url");
  const request: CheckRun = {
    id: 1,
    name: "Informant CI",
    status: "queued",
    external_id: `request:jobs:${encodedJobs}`,
  };
  let candidate: CheckRun | undefined;
  const historical: CheckRun = {
    id: 2,
    name: "Informant CI",
    status: "completed",
    conclusion: "success",
    external_id: `old-worker:event:manual:abc123:jobs:${encodedScope}`,
  };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      candidate = { id: 3, ...body } as CheckRun;
      return Response.json(candidate);
    }
    if (init?.method === "PATCH") {
      updates.push({
        id: Number(String(input).split("/").at(-1)),
        conclusion: JSON.parse(String(init.body)).conclusion,
      });
      return Response.json({});
    }
    reads++;
    return Response.json({
      check_runs: reads >= 3 ? [request, historical, ...(candidate ? [candidate] : [])] : [request],
    });
  }) as typeof globalThis.fetch;

  const claim = await new GitHubClient({ token: "installation-token", fetch }).claim(
    { owner: "acme", repo: "widgets", fullName: "acme/widgets" },
    "abc123",
    "new-worker",
    undefined,
    ["gpu"],
  );

  expect(claim).toBeUndefined();
  expect(updates).toContainEqual({ id: 3, conclusion: "cancelled" });
});

test("manual eligible-job claim IDs retain the historical jobs namespace", async () => {
  const encodedJobs = Buffer.from(JSON.stringify(["gpu"])).toString("base64url");
  const checks: CheckRun[] = [
    {
      id: 1,
      name: "Informant CI",
      status: "queued",
      external_id: `request:jobs:${encodedJobs}`,
    },
  ];
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      const check = { id: 2, ...body } as CheckRun;
      checks.push(check);
      return Response.json(check);
    }
    if (init?.method === "PATCH") return Response.json({});
    return Response.json({ check_runs: checks });
  }) as typeof globalThis.fetch;

  const claim = await new GitHubClient({ token: "installation-token", fetch }).claim(
    { owner: "acme", repo: "widgets", fullName: "acme/widgets" },
    "abc123",
    "new-worker",
    undefined,
    ["gpu"],
  );

  expect(claim?.check?.external_id).toBe("new-worker:event:manual:abc123:jobs:Z3B1");
});

test("automatic job claims do not consume a manual suite request", async () => {
  const updates: number[] = [];
  const checks = [
    {
      id: 1,
      name: "Informant CI",
      status: "queued",
      external_id: `request:jobs:${Buffer.from(JSON.stringify([])).toString("base64url")}`,
    },
  ];
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      const check = {
        id: 2,
        name: body.name,
        status: body.status,
        external_id: body.external_id,
      };
      checks.push(check);
      return Response.json(check);
    }
    if (init?.method === "PATCH") {
      const id = Number(String(_input).match(/check-runs\/(\d+)/)?.[1]);
      updates.push(id);
      return Response.json({});
    }
    return Response.json({ check_runs: checks });
  }) as typeof globalThis.fetch;

  const claim = await new GitHubClient({ token: "installation-token", fetch }).claim(
    { owner: "acme", repo: "widgets", fullName: "acme/widgets" },
    "abc123",
    "machine",
    { type: "commit", id: "branch:main:abc123:jobs:dGVzdA" },
    ["test"],
    false,
  );

  expect(claim?.manualTrigger).toBeFalse();
  expect(claim?.requestedJobs).toEqual([]);
  expect(updates).not.toContain(1);
});

test("job-set claims honor completed and active legacy component scopes", async () => {
  const run = async (status: "completed" | "in_progress") => {
    let posted = false;
    const checks = [
      {
        id: 1,
        name: "Informant CI",
        status,
        conclusion: status === "completed" ? "success" : undefined,
        started_at: new Date().toISOString(),
        external_id: "old-worker:event:commit:branch:main:abc123:jobs:dGVzdA",
      },
    ];
    const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") posted = true;
      return Response.json({ check_runs: checks });
    }) as typeof globalThis.fetch;
    const claim = await new GitHubClient({ token: "installation-token", fetch }).claim(
      { owner: "acme", repo: "widgets", fullName: "acme/widgets" },
      "abc123",
      "machine",
      { type: "commit", id: "branch:main:abc123:job-set:dGVzdA" },
      ["test"],
      false,
      ["commit:branch:main:abc123:jobs:dGVzdA"],
    );
    return { claim, posted };
  };

  expect(await run("completed")).toEqual({ claim: undefined, posted: false });
  expect((await run("in_progress")).claim?.retry).toBeTrue();
});

test("claim replaces a stale claim after its accepted request was completed", async () => {
  let nextId = 100;
  const checks: Array<Record<string, unknown>> = [
    { id: 1, name: "Informant CI", status: "completed", conclusion: "neutral" },
    {
      id: 2,
      name: "Informant CI",
      status: "in_progress",
      started_at: "2000-01-01T00:00:00.000Z",
    },
    {
      id: 3,
      name: "Informant / test",
      status: "in_progress",
      external_id: "informant-job:2:dGVzdA",
    },
  ];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("check-suites")) {
      return Response.json({ check_suites: [{ status: "completed" }] });
    }
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      const check = {
        id: nextId++,
        name: body.name,
        status: body.status,
        external_id: body.external_id,
      };
      checks.push(check);
      return Response.json(check);
    }
    if (init?.method === "PATCH") {
      const id = Number(String(input).split("/").at(-1));
      const check = checks.find((item) => item.id === id);
      if (check) Object.assign(check, JSON.parse(String(init.body)));
      return Response.json(check ?? {});
    }
    return Response.json({ check_runs: checks });
  }) as typeof globalThis.fetch;

  const claim = await new GitHubClient({ token: "installation-token", fetch }).claim(
    { owner: "acme", repo: "widgets", fullName: "acme/widgets" },
    "abc123",
    "replacement",
  );

  expect(claim?.check?.id).toBe(100);
  expect(checks.find((check) => check.id === 3)).toMatchObject({
    status: "completed",
    conclusion: "cancelled",
  });
});

test("stale recovery leaves the aggregate active when a child cannot be cancelled", async () => {
  let created = false;
  let aggregateCancelled = false;
  const checks = [
    {
      id: 2,
      name: "Informant CI",
      status: "in_progress",
      started_at: "2000-01-01T00:00:00.000Z",
    },
    {
      id: 3,
      name: "Informant / test",
      status: "in_progress",
      external_id: "informant-job:2:dGVzdA",
    },
  ];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") created = true;
    if (init?.method === "PATCH") {
      const id = Number(String(input).split("/").at(-1));
      if (id === 2) aggregateCancelled = true;
      if (id === 3) return new Response("unavailable", { status: 503 });
    }
    return Response.json({ check_runs: checks });
  }) as typeof globalThis.fetch;

  await expect(
    new GitHubClient({ token: "installation-token", fetch }).claim(
      { owner: "acme", repo: "widgets", fullName: "acme/widgets" },
      "abc123",
      "replacement",
    ),
  ).rejects.toThrow("GitHub 503");
  expect(aggregateCancelled).toBe(false);
  expect(created).toBe(false);
});

test("interrupted build recovery cancels only correlated children before the aggregate", async () => {
  const updates: number[] = [];
  const metadata = "<!-- informant-request:dGVzdA -->";
  const checks: Array<Record<string, unknown>> = [
    { id: 2, name: "Informant CI", status: "in_progress", output: { text: metadata } },
    {
      id: 3,
      name: "Informant / test",
      status: "in_progress",
      external_id: "informant-job:2:dGVzdA",
    },
    {
      id: 4,
      name: "Informant / unrelated",
      status: "in_progress",
      external_id: "informant-job:99:dGVzdA",
    },
  ];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PATCH") {
      const id = Number(url.split("/").at(-1));
      updates.push(id);
      const check = checks.find((item) => item.id === id);
      if (check) Object.assign(check, JSON.parse(String(init.body)));
      return Response.json(check ?? {});
    }
    if (/\/check-runs\/2$/.test(url)) return Response.json(checks[0]);
    return Response.json({ check_runs: checks });
  }) as typeof globalThis.fetch;
  const github = new GitHubClient({ token: "installation-token", fetch });
  const repository = { owner: "acme", repo: "widgets", fullName: "acme/widgets" };

  expect(await github.recoverInterruptedCheck(repository, "abc123", 2)).toBe(true);
  expect(updates).toEqual([3, 2]);
  expect(checks[0]?.output).toMatchObject({ text: metadata });
  expect(await github.recoverInterruptedCheck(repository, "abc123", 2)).toBe(false);
  expect(updates).toEqual([3, 2]);
});

test("claim treats a queued failed check suite as a failed-jobs re-run request", async () => {
  let jobCheckReads = 0;
  const checks: Array<Record<string, unknown>> = [
    {
      id: 0,
      name: "Informant CI",
      status: "completed",
      conclusion: "failure",
      external_id: "other-worker:event:commit:pr:44:abc123",
    },
    {
      id: 1,
      name: "Informant CI",
      status: "completed",
      conclusion: "failure",
      external_id: "original-worker:event:commit:pr:43:abc123:jobs:dHlwZWNoZWNr",
    },
    {
      id: 2,
      name: "Informant CI",
      status: "completed",
      conclusion: "failure",
      external_id: "second-worker:event:commit:pr:43:abc123:jobs:ZGVwbG95",
    },
    {
      id: 3,
      name: "Informant CI",
      status: "completed",
      conclusion: "success",
      external_id: "retry-worker:event:commit:pr:43:abc123:jobs:dHlwZWNoZWNr",
    },
  ];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      const check = {
        id: 4,
        name: body.name,
        status: body.status,
        external_id: body.external_id,
      };
      checks.push(check);
      return Response.json(check);
    }
    if (url.includes("check-suites")) {
      return Response.json({ check_suites: [{ status: "queued" }] });
    }
    if (!new URL(url).searchParams.has("check_name")) {
      jobCheckReads++;
      return Response.json({
        check_runs: [
          {
            id: 10,
            name: "Informant / lint",
            status: "completed",
            conclusion: "failure",
            external_id: "informant-job:1:bGludA",
          },
          {
            id: 11,
            name: "Informant / typecheck",
            status: "completed",
            conclusion: "failure",
            external_id: "informant-job:1:dHlwZWNoZWNr",
          },
          {
            id: 12,
            name: "Informant / deploy",
            status: "completed",
            conclusion: "skipped",
            external_id: "informant-job:2:ZGVwbG95",
          },
          {
            id: 13,
            name: "Informant / cleanup",
            status: "completed",
            conclusion: "cancelled",
            external_id: "informant-job:2:Y2xlYW51cA",
          },
          {
            id: 14,
            name: "Informant / typecheck",
            status: "completed",
            conclusion: "success",
            external_id: "informant-job:3:dHlwZWNoZWNr",
          },
        ],
      });
    }
    return Response.json({ check_runs: checks });
  }) as typeof globalThis.fetch;

  const claim = await new GitHubClient({ token: "installation-token", fetch }).claim(
    { owner: "acme", repo: "widgets", fullName: "acme/widgets" },
    "abc123",
    "machine",
    undefined,
    ["cleanup", "deploy", "lint"],
  );

  expect(claim?.check?.id).toBe(4);
  expect(claim?.requestedJobs).toEqual(["deploy", "cleanup", "lint"]);
  expect(claim?.originalPullRequest).toBe(43);
  const eligibleScope = Buffer.from("cleanup\0deploy\0lint").toString("base64url");
  expect(checks.at(-1)?.external_id).toBe(
    `machine:event:commit:pr:43:abc123:jobs:${eligibleScope}`,
  );
  expect(jobCheckReads).toBe(1);
});

test("claim falls back to all jobs when a queued suite has no failed job history", async () => {
  const checks: Array<Record<string, unknown>> = [
    {
      id: 1,
      name: "Informant CI",
      status: "completed",
      conclusion: "success",
      external_id: "worker:event:commit:branch:release:abc123",
    },
  ];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      const check = { id: 2, name: body.name, status: body.status, external_id: body.external_id };
      checks.push(check);
      return Response.json(check);
    }
    if (url.includes("check-suites"))
      return Response.json({ check_suites: [{ status: "queued" }] });
    if (!new URL(url).searchParams.has("check_name")) return Response.json({ check_runs: [] });
    return Response.json({ check_runs: checks });
  }) as typeof globalThis.fetch;

  const claim = await new GitHubClient({ token: "installation-token", fetch }).claim(
    { owner: "acme", repo: "widgets", fullName: "acme/widgets" },
    "abc123",
    "machine",
    { type: "commit", id: "branch:main:abc123", branch: "main" },
  );

  expect(claim?.requestedJobs).toEqual([]);
  expect(claim?.originalPullRequest).toBeUndefined();
  expect(claim?.manualTriggerBranch).toBe("release");
  expect(checks.at(-1)?.external_id).toContain("machine:event:manual:abc123:context:");
});

test("a tag suite rerun recovers its branchless context and execution label", async () => {
  const checks: Array<Record<string, unknown>> = [
    {
      id: 1,
      name: "Informant CI",
      status: "completed",
      conclusion: "success",
      external_id: "worker:event:commit:tag:v2:abc123:job-set:dGVzdA:jobs:dGVzdA",
    },
  ];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      const check = { id: 2, name: body.name, status: body.status, external_id: body.external_id };
      checks.push(check);
      return Response.json(check);
    }
    if (url.includes("check-suites"))
      return Response.json({ check_suites: [{ status: "queued" }] });
    if (!new URL(url).searchParams.has("check_name")) return Response.json({ check_runs: [] });
    return Response.json({ check_runs: checks });
  }) as typeof globalThis.fetch;

  const claim = await new GitHubClient({ token: "installation-token", fetch }).claim(
    { owner: "acme", repo: "widgets", fullName: "acme/widgets" },
    "abc123",
    "machine",
    { type: "commit", id: "branch:main:abc123", branch: "main", label: "main" },
  );

  expect(claim?.manualTriggerBranch).toBeNull();
  expect(claim?.manualTriggerLabel).toBe("v2");
});

test("claim does not repeat a completed check suite", async () => {
  let created = false;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") created = true;
    if (String(input).includes("check-suites")) {
      return Response.json({ check_suites: [{ status: "completed" }] });
    }
    return Response.json({
      check_runs: [{ id: 1, name: "Informant CI", status: "completed", conclusion: "success" }],
    });
  }) as typeof globalThis.fetch;

  const claim = await new GitHubClient({ token: "installation-token", fetch }).claim(
    { owner: "acme", repo: "widgets", fullName: "acme/widgets" },
    "abc123",
    "machine",
  );

  expect(claim).toBeUndefined();
  expect(created).toBe(false);
});

test("pre-minted installation tokens retain their App ID check filter", async () => {
  const previousToken = Bun.env.INFORMANT_GITHUB_TOKEN;
  const previousAppId = Bun.env.INFORMANT_GITHUB_APP_ID;
  const previousAccount = Bun.env.INFORMANT_GITHUB_ACCOUNT;
  Bun.env.INFORMANT_GITHUB_TOKEN = "installation-token";
  Bun.env.INFORMANT_GITHUB_APP_ID = "123";
  Bun.env.INFORMANT_GITHUB_ACCOUNT = "acme";
  let requestUrl = "";
  const fetch = (async (input: string | URL | Request) => {
    requestUrl = String(input);
    return Response.json({ check_runs: [] });
  }) as typeof globalThis.fetch;

  try {
    await new GitHubClient({
      repository: { owner: "acme", repo: "widgets", fullName: "acme/widgets" },
      fetch,
    }).checks({ owner: "acme", repo: "widgets", fullName: "acme/widgets" }, "abc123");
    expect(new URL(requestUrl).searchParams.get("app_id")).toBe("123");
  } finally {
    if (previousToken === undefined) delete Bun.env.INFORMANT_GITHUB_TOKEN;
    else Bun.env.INFORMANT_GITHUB_TOKEN = previousToken;
    if (previousAppId === undefined) delete Bun.env.INFORMANT_GITHUB_APP_ID;
    else Bun.env.INFORMANT_GITHUB_APP_ID = previousAppId;
    if (previousAccount === undefined) delete Bun.env.INFORMANT_GITHUB_ACCOUNT;
    else Bun.env.INFORMANT_GITHUB_ACCOUNT = previousAccount;
  }
});

test("event scopes match exactly and legacy checks do not suppress PR commits", async () => {
  let nextId = 100;
  const checks: Array<Record<string, unknown>> = [
    {
      id: 1,
      name: "Informant CI / comment",
      status: "completed",
      external_id: "worker:event:comment:pr:1:comment:10",
    },
    { id: 2, name: "Informant CI", status: "completed", external_id: "legacy-worker" },
  ];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("check-suites")) {
      return Response.json({ check_suites: [{ status: "completed" }] });
    }
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      const check = {
        id: nextId++,
        name: body.name,
        status: body.status,
        external_id: body.external_id,
      };
      checks.push(check);
      return Response.json(check);
    }
    if (init?.method === "PATCH") return Response.json({});
    return Response.json({ check_runs: checks });
  }) as typeof globalThis.fetch;
  const github = new GitHubClient({ token: "installation-token", fetch });
  const repository = { owner: "acme", repo: "widgets", fullName: "acme/widgets" };

  const comment = await github.claim(repository, "abc123", "worker", {
    type: "comment",
    id: "pr:1:comment:1",
  });
  const pullRequest = await github.claim(repository, "abc123", "worker", {
    type: "commit",
    id: "pr:1:abc123",
  });

  expect(comment?.check?.id).toBe(100);
  expect(pullRequest?.check?.id).toBe(101);
});

test("queued work elects in a canonical manual scope", async () => {
  let createdExternalId = "";
  const context = Buffer.from(JSON.stringify({ branch: "release" })).toString("base64url");
  const otherContext = Buffer.from(JSON.stringify({ branch: "main" })).toString("base64url");
  const checks: Array<Record<string, unknown>> = [
    {
      id: 1,
      name: "Informant CI",
      status: "queued",
      external_id: `request:context:${context}:job-set:${Buffer.from("[]").toString("base64url")}`,
    },
    {
      id: 3,
      name: "Informant CI",
      status: "queued",
      external_id: `request:context:${otherContext}:jobs:${Buffer.from("[]").toString("base64url")}`,
    },
  ];
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      createdExternalId = body.external_id;
      const check = { id: 2, name: body.name, status: body.status, external_id: body.external_id };
      checks.push(check);
      return Response.json(check);
    }
    if (init?.method === "PATCH") {
      const id = Number(String(_input).split("/").at(-1));
      const check = checks.find((item) => item.id === id);
      if (check) Object.assign(check, JSON.parse(String(init.body)));
      return Response.json(check ?? {});
    }
    return Response.json({ check_runs: checks });
  }) as typeof globalThis.fetch;

  const claim = await new GitHubClient({ token: "installation-token", fetch }).claim(
    { owner: "acme", repo: "widgets", fullName: "acme/widgets" },
    "abc123",
    "worker",
    { type: "commit", id: "branch:release:abc123", branch: "release" },
  );

  expect(createdExternalId).toContain(":event:manual:abc123:context:");
  expect(claim?.manualTrigger).toBe(true);
  expect(claim?.manualTriggerBranch).toBe("release");
  expect(checks.find((check) => check.id === 1)?.status).toBe("completed");
  expect(checks.find((check) => check.id === 3)?.status).toBe("queued");
});

test("compact claims do not race an active legacy manual claim", async () => {
  let created = false;
  const context = Buffer.from(JSON.stringify({ branch: "release", label: "release" })).toString(
    "base64url",
  );
  const checks: CheckRun[] = [
    {
      id: 1,
      name: "Informant CI",
      status: "queued",
      external_id: `request:context:${context}:jobs:${Buffer.from("[]").toString("base64url")}`,
    },
    {
      id: 2,
      name: "Informant CI",
      status: "in_progress",
      started_at: new Date().toISOString(),
      external_id: `legacy-worker:event:manual:abc123:context:${context}`,
    },
  ];
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") created = true;
    return Response.json({ check_runs: checks });
  }) as typeof globalThis.fetch;

  const claim = await new GitHubClient({ token: "installation-token", fetch }).claim(
    { owner: "acme", repo: "widgets", fullName: "acme/widgets" },
    "abc123",
    "new-worker",
    { type: "commit", id: "branch:release:abc123", branch: "release", label: "release" },
  );

  expect(claim?.retry).toBe(true);
  expect(created).toBe(false);
});

test("legacy manual requests keep a shared mixed-version election scope", async () => {
  const context = Buffer.from(JSON.stringify({ branch: "release", label: "release" })).toString(
    "base64url",
  );
  const checks: CheckRun[] = [
    {
      id: 1,
      name: "Informant CI",
      status: "queued",
      external_id: `request:context:${context}:jobs:${Buffer.from("[]").toString("base64url")}`,
    },
  ];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      const candidate = { id: 2, ...body } as CheckRun;
      checks.push(candidate, {
        id: 3,
        name: "Informant CI",
        status: "in_progress",
        started_at: new Date().toISOString(),
        external_id: `legacy-worker:event:manual:abc123:context:${context}`,
      });
      return Response.json(candidate);
    }
    if (init?.method === "PATCH") {
      const id = Number(String(input).split("/").at(-1));
      const check = checks.find((item) => item.id === id);
      if (check) Object.assign(check, JSON.parse(String(init.body)));
      return Response.json(check ?? {});
    }
    return Response.json({ check_runs: checks });
  }) as typeof globalThis.fetch;

  const claim = await new GitHubClient({ token: "installation-token", fetch }).claim(
    { owner: "acme", repo: "widgets", fullName: "acme/widgets" },
    "abc123",
    "new-worker",
    { type: "commit", id: "branch:release:abc123", branch: "release", label: "release" },
  );

  expect(claim?.check?.id).toBe(2);
  expect(checks.find((check) => check.id === 3)?.status).toBe("in_progress");
});

test("an active event claim is retryable rather than terminal", async () => {
  const fetch = (async (_input: string | URL | Request) =>
    Response.json({
      check_runs: [
        {
          id: 1,
          name: "Informant CI / comment",
          status: "in_progress",
          started_at: new Date().toISOString(),
          external_id: "worker:event:comment:pr:1:comment:2",
        },
      ],
    })) as typeof globalThis.fetch;

  const claim = await new GitHubClient({ token: "installation-token", fetch }).claim(
    { owner: "acme", repo: "widgets", fullName: "acme/widgets" },
    "abc123",
    "worker",
    { type: "comment", id: "pr:1:comment:2" },
  );

  expect(claim?.retry).toBe(true);
});

test("a repeated queued manual trigger can replace historical manual completion", async () => {
  const checks: Array<Record<string, unknown>> = [
    {
      id: 1,
      name: "Informant CI",
      status: "completed",
      external_id: "old-worker:event:manual:abc123",
    },
    {
      id: 2,
      name: "Informant CI",
      status: "queued",
      external_id: `request:jobs:${Buffer.from("[]").toString("base64url")}`,
    },
  ];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      const check = {
        id: 3,
        name: body.name,
        status: body.status,
        external_id: body.external_id,
      };
      checks.push(check);
      return Response.json(check);
    }
    if (init?.method === "PATCH") {
      const id = Number(String(input).split("/").at(-1));
      const check = checks.find((item) => item.id === id);
      if (check) Object.assign(check, JSON.parse(String(init.body)));
      return Response.json(check ?? {});
    }
    return Response.json({ check_runs: checks });
  }) as typeof globalThis.fetch;

  const claim = await new GitHubClient({ token: "installation-token", fetch }).claim(
    { owner: "acme", repo: "widgets", fullName: "acme/widgets" },
    "abc123",
    "new-worker",
    { type: "commit", id: "branch:main:abc123" },
  );

  expect(claim?.check?.id).toBe(3);
  expect(claim?.manualTrigger).toBe(true);
  expect(checks.find((check) => check.id === 2)).toMatchObject({
    status: "completed",
    conclusion: "neutral",
  });
});

test("an event-scoped stale claim and its children are replaced", async () => {
  const metadata = "<!-- informant-request:dGVzdA -->";
  const checks: Array<Record<string, unknown>> = [
    {
      id: 1,
      name: "Informant CI",
      status: "in_progress",
      started_at: "2000-01-01T00:00:00.000Z",
      external_id: "old-worker:event:commit:branch:main:abc123",
      output: { text: metadata },
    },
    {
      id: 2,
      name: "Informant / test",
      status: "in_progress",
      external_id: "informant-job:1:dGVzdA",
    },
  ];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      const check = {
        id: 3,
        name: body.name,
        status: body.status,
        external_id: body.external_id,
      };
      checks.push(check);
      return Response.json(check);
    }
    if (init?.method === "PATCH") {
      const id = Number(String(input).split("/").at(-1));
      const check = checks.find((item) => item.id === id);
      if (check) Object.assign(check, JSON.parse(String(init.body)));
      return Response.json(check ?? {});
    }
    return Response.json({ check_runs: checks });
  }) as typeof globalThis.fetch;

  const claim = await new GitHubClient({ token: "installation-token", fetch }).claim(
    { owner: "acme", repo: "widgets", fullName: "acme/widgets" },
    "abc123",
    "replacement",
    { type: "commit", id: "branch:main:abc123" },
  );

  expect(claim?.check?.id).toBe(3);
  expect(checks.find((check) => check.id === 1)).toMatchObject({
    status: "completed",
    conclusion: "cancelled",
    output: { text: metadata },
  });
  expect(checks.find((check) => check.id === 2)).toMatchObject({
    status: "completed",
    conclusion: "cancelled",
  });
});
