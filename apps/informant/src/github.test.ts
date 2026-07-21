import { expect, test } from "bun:test";
import { GitHubClient } from "./github.ts";

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

  expect(claim?.check.id).toBe(10);
  expect(claim?.requestedJobs).toEqual([]);
  expect(urls.filter((url) => url.includes("check-runs"))).toHaveLength(3);
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
  ];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      const check = { id: nextId++, name: body.name, status: body.status };
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

  expect(claim?.check.id).toBe(100);
});
