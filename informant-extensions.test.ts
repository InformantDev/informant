import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DefaultResourceLoader,
  ExtensionAPI,
  ExtensionContext,
  ModelRuntime,
  ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import {
  SubagentCapacity,
  SubagentManager,
  snapshotGithubReviewThreads,
  staffFilesTool,
  staffThreadsTool,
} from "./informant-subagents.ts";

type StaffFilesPayload = {
  files?: Array<{ path: string; status: string }>;
  nextCursor?: number | null;
  totalFiles?: number;
  file?: {
    path: string;
    status: string;
    side: "old" | "new";
    offsetBytes: number;
    nextOffsetBytes: number | null;
    totalBytes: number;
    content: string | null;
  };
};

function payload(result: { content: Array<{ type: string; text?: string }> }): StaffFilesPayload {
  const text = result.content[0]?.text;
  if (!text) throw new Error("staff_files returned no text payload");
  return JSON.parse(text) as StaffFilesPayload;
}

test("staff_files exposes a Google-compatible side enum", () => {
  const side = staffFilesTool().parameters.properties.side;
  expect(side as unknown).toEqual({ type: "string", enum: ["old", "new"] });
});

test("staff_files lists and reads immutable diff sides in bounded UTF-8 pages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "informant-staff-files-"));
  const snapshotPath = join(directory, "snapshot.json");
  const snapshotEnvironment = "INFORMANT_STAFF_FILES";
  const previousSnapshotPath = process.env[snapshotEnvironment];
  await writeFile(
    snapshotPath,
    JSON.stringify({
      files: [
        {
          path: "alpha.ts",
          status: "modified",
          oldContent: "old🙂data",
          newContent: "new🙂data",
        },
        {
          path: "added.ts",
          status: "added",
          oldContent: null,
          newContent: "added",
        },
      ],
    }),
  );
  process.env[snapshotEnvironment] = snapshotPath;

  try {
    const tool = staffFilesTool();
    const firstList = payload(await tool.execute("list-1", { limit: 1 }));
    expect(firstList).toEqual({
      files: [{ path: "alpha.ts", status: "modified" }],
      nextCursor: 1,
      totalFiles: 2,
    });
    expect(payload(await tool.execute("list-2", { cursor: firstList.nextCursor ?? 0 }))).toEqual({
      files: [{ path: "added.ts", status: "added" }],
      nextCursor: null,
      totalFiles: 2,
    });

    for (const [side, expected] of [
      ["old", "old🙂data"],
      ["new", "new🙂data"],
    ] as const) {
      let offset: number | null = 0;
      let content = "";
      while (offset !== null) {
        const page: StaffFilesPayload["file"] = payload(
          await tool.execute(`read-${side}-${offset}`, {
            path: "alpha.ts",
            side,
            offsetBytes: offset,
            maxBytes: 4,
          }),
        ).file;
        if (!page) throw new Error("staff_files returned no file page");
        content += page.content ?? "";
        offset = page.nextOffsetBytes;
      }
      expect(content).toBe(expected);
    }

    expect(
      payload(await tool.execute("read-missing-side", { path: "added.ts", side: "old" })).file,
    ).toMatchObject({ content: null, totalBytes: 0, nextOffsetBytes: null });
    await expect(
      tool.execute("read-invalid-offset", {
        path: "alpha.ts",
        side: "new",
        offsetBytes: 2,
      }),
    ).rejects.toThrow("offsetBytes must be 0 or a value returned by nextOffsetBytes");
  } finally {
    if (previousSnapshotPath === undefined) delete process.env[snapshotEnvironment];
    else process.env[snapshotEnvironment] = previousSnapshotPath;
    await rm(directory, { recursive: true, force: true });
  }
});

type StaffThreadsPayload = {
  threads?: Array<{ id: string; isResolved: boolean; rootComment: { bodyPreview: string } }>;
  comments?: Array<{ id: string; bodyPreview: string }>;
  nextCursor?: number | null;
  totalThreads?: number;
  totalComments?: number;
  comment?: {
    id: string;
    threadId: string;
    offsetBytes: number;
    nextOffsetBytes: number | null;
    totalBytes: number;
    body: string;
  };
};

function threadPayload(result: {
  content: Array<{ type: string; text?: string }>;
}): StaffThreadsPayload {
  const text = result.content[0]?.text;
  if (!text) throw new Error("staff_threads returned no text payload");
  return JSON.parse(text) as StaffThreadsPayload;
}

test("snapshots all GitHub review-thread and nested comment pages", async () => {
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const requestSignals: AbortSignal[] = [];
  const request = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    if (!init?.signal) throw new Error("GitHub request omitted its deadline signal");
    requestSignals.push(init.signal);
    requests.push(body);
    if (body.variables.id === "thread-1") {
      return Response.json({
        data: {
          node: {
            comments: {
              nodes: [{ id: "comment-2", body: "reply" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    }
    const secondThreadPage = body.variables.cursor === "thread-page-2";
    return Response.json({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: secondThreadPage
              ? {
                  nodes: [
                    {
                      id: "thread-2",
                      isResolved: true,
                      comments: {
                        nodes: [{ id: "comment-3", body: "settled" }],
                        pageInfo: { hasNextPage: false, endCursor: null },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                }
              : {
                  nodes: [
                    {
                      id: "thread-1",
                      isResolved: false,
                      comments: {
                        nodes: [{ id: "comment-1", body: "open" }],
                        pageInfo: { hasNextPage: true, endCursor: "comment-page-2" },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: true, endCursor: "thread-page-2" },
                },
          },
        },
      },
    });
  };

  const snapshot = await snapshotGithubReviewThreads(
    { repository: "owner/repo", pullRequest: 38, token: "secret" },
    request,
  );

  expect(snapshot.threads).toHaveLength(2);
  expect(snapshot.threads[0]?.comments).toEqual([
    { id: "comment-1", body: "open" },
    { id: "comment-2", body: "reply" },
  ]);
  expect(snapshot.threads[1]?.isResolved).toBe(true);
  expect(requests.map(({ variables }) => variables)).toEqual([
    { owner: "owner", name: "repo", number: 38, cursor: null },
    { id: "thread-1", cursor: "comment-page-2" },
    { owner: "owner", name: "repo", number: 38, cursor: "thread-page-2" },
  ]);
  expect(requestSignals).toHaveLength(3);
  expect(requestSignals.every((signal) => !signal.aborted)).toBe(true);
});

test("GitHub review snapshots compose caller cancellation with per-request deadlines", async () => {
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const request = (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requestSignal = init?.signal ?? undefined;
    return new Promise((_resolve, reject) => {
      if (!requestSignal) return reject(new Error("GitHub request omitted its deadline signal"));
      requestSignal.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
    });
  };

  const snapshot = snapshotGithubReviewThreads(
    {
      repository: "owner/repo",
      pullRequest: 38,
      token: "secret",
      signal: controller.signal,
      requestTimeoutMs: 10_000,
    },
    request,
  );
  controller.abort(new Error("caller cancelled"));

  await expect(snapshot).rejects.toThrow("caller cancelled");
  expect(requestSignal?.aborted).toBe(true);
});

test("GitHub review snapshot requests have a bounded timeout", async () => {
  let requestSignal: AbortSignal | undefined;
  const request = (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requestSignal = init?.signal ?? undefined;
    return new Promise((_resolve, reject) => {
      if (!requestSignal) return reject(new Error("GitHub request omitted its deadline signal"));
      requestSignal.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
    });
  };

  await expect(
    snapshotGithubReviewThreads(
      {
        repository: "owner/repo",
        pullRequest: 38,
        token: "secret",
        requestTimeoutMs: 10,
      },
      request,
    ),
  ).rejects.toThrow();
  expect(requestSignal?.aborted).toBe(true);
});

test("staff_threads lists existing threads and pages full comment bodies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "informant-staff-threads-"));
  const snapshotPath = join(directory, "threads.json");
  const snapshotEnvironment = "INFORMANT_STAFF_THREADS";
  const previousSnapshotPath = process.env[snapshotEnvironment];
  await writeFile(
    snapshotPath,
    JSON.stringify({
      threads: [
        {
          id: "thread-1",
          isResolved: false,
          isOutdated: false,
          path: "alpha.ts",
          line: 4,
          diffSide: "RIGHT",
          comments: [
            {
              id: "comment-1",
              databaseId: 1,
              url: "https://github.test/discussion_r1",
              body: "first🙂body",
              author: { login: "reviewer" },
            },
          ],
        },
        {
          id: "thread-2",
          isResolved: true,
          comments: [{ id: "comment-2", body: "settled" }],
        },
      ],
    }),
  );
  process.env[snapshotEnvironment] = snapshotPath;

  try {
    const tool = staffThreadsTool();
    const firstList = threadPayload(await tool.execute("list", { limit: 1 }));
    expect(firstList.threads?.[0]).toMatchObject({
      id: "thread-1",
      isResolved: false,
      rootComment: { bodyPreview: "first🙂body" },
    });
    expect(firstList.nextCursor).toBe(1);
    expect(firstList.totalThreads).toBe(2);
    expect(
      threadPayload(await tool.execute("comments", { threadId: "thread-1" })).comments,
    ).toEqual([expect.objectContaining({ id: "comment-1", bodyPreview: "first🙂body" })]);

    let offset: number | null = 0;
    let body = "";
    while (offset !== null) {
      const page: StaffThreadsPayload["comment"] = threadPayload(
        await tool.execute(`body-${offset}`, {
          threadId: "thread-1",
          commentId: "comment-1",
          offsetBytes: offset,
          maxBytes: 4,
        }),
      ).comment;
      if (!page) throw new Error("staff_threads returned no comment page");
      body += page.body;
      offset = page.nextOffsetBytes;
    }
    expect(body).toBe("first🙂body");
    await expect(
      tool.execute("invalid-offset", {
        threadId: "thread-1",
        commentId: "comment-1",
        offsetBytes: 2,
      }),
    ).rejects.toThrow("offsetBytes must be 0 or a value returned by nextOffsetBytes");
  } finally {
    if (previousSnapshotPath === undefined) delete process.env[snapshotEnvironment];
    else process.env[snapshotEnvironment] = previousSnapshotPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("subagent capacity reserves concurrent creations before they await", () => {
  const capacity = new SubagentCapacity(2);
  const releaseFirst = capacity.reserve(0);
  const releaseSecond = capacity.reserve(0);

  expect(() => capacity.reserve(0)).toThrow("At most 2 live subagent sessions");
  releaseFirst();
  releaseFirst();
  const releaseReplacement = capacity.reserve(0);

  releaseSecond();
  releaseReplacement();
});

type LoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];
type SessionFactory = NonNullable<
  ConstructorParameters<typeof SubagentManager>[1]
>["sessionFactory"];

const testModel = {
  provider: "test-provider",
  id: "test-model",
  name: "Test model",
} as NonNullable<ExtensionContext["model"]>;

function managerHarness(
  cwd: string,
  sessionFactory: SessionFactory,
  onLoaderOptions: (options: LoaderOptions) => void = () => {},
) {
  const pi = {
    getActiveTools: () => [
      "read",
      "grep",
      "find",
      "ls",
      "staff_files",
      "staff_threads",
      "bash",
      "edit",
    ],
  } as unknown as ExtensionAPI;
  const runtime = {
    getAvailable: async () => [testModel],
  } as unknown as ModelRuntime;
  const manager = new SubagentManager(pi, {
    sessionFactory,
    modelRuntimeFactory: async () => runtime,
    resourceLoaderFactory: (options) => {
      onLoaderOptions(options);
      return { reload: async () => {} } as unknown as ResourceLoader;
    },
  });
  const ctx = {
    cwd,
    model: testModel,
    thinkingLevel: "medium",
    scopedModels: [],
  } as unknown as ExtensionContext;
  return { manager, ctx };
}

function fakeSession(onDispose: () => void = () => {}) {
  return {
    model: testModel,
    thinkingLevel: "medium",
    subscribe: () => () => {},
    prompt: async () => {},
    abort: async () => {},
    dispose: onDispose,
  };
}

test("subagent creation isolates child tools, resources, skills, and workspace paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "informant-subagent-session-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const canonicalWorkspace = await realpath(workspace);
  await writeFile(join(directory, "outside.txt"), "secret");
  await writeFile(join(workspace, "inside.txt"), "safe");
  await symlink(join(directory, "outside.txt"), join(workspace, "outside-link.txt"));
  let loaderOptions: LoaderOptions | undefined;
  let sessionOptions: Parameters<NonNullable<SessionFactory>>[0] | undefined;
  const session = fakeSession();
  const sessionFactory = (async (options) => {
    sessionOptions = options;
    return { session } as unknown as Awaited<ReturnType<NonNullable<SessionFactory>>>;
  }) satisfies NonNullable<SessionFactory>;
  const { manager, ctx } = managerHarness(workspace, sessionFactory, (options) => {
    loaderOptions = options;
  });

  try {
    const agent = await manager.create(ctx, {
      prompt: "Use staff-review-find to inspect this diff",
      name: "isolated",
    });
    expect(agent.cwd).toBe(canonicalWorkspace);
    expect(sessionOptions?.cwd).toBe(canonicalWorkspace);
    expect(sessionOptions?.tools).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "staff_files",
      "staff_threads",
    ]);
    expect(sessionOptions?.customTools?.map((tool) => tool.name)).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "staff_files",
      "staff_threads",
    ]);
    expect(loaderOptions).toMatchObject({
      cwd: canonicalWorkspace,
      additionalSkillPaths: ["/opt/informant/skills/staff-review-find/SKILL.md"],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
    });

    const readTool = sessionOptions?.customTools?.find((tool) => tool.name === "read");
    if (!readTool) throw new Error("child read tool was not configured");
    await expect(
      readTool.execute("outside", { path: "../outside.txt" }, undefined, undefined, ctx),
    ).rejects.toThrow("Staff Review tools may only access the workspace or trusted review skills");

    const findTool = sessionOptions?.customTools?.find((tool) => tool.name === "find");
    if (!findTool) throw new Error("child find tool was not configured");
    await expect(
      findTool.execute("absolute", { pattern: "/etc/*" }, undefined, undefined, ctx),
    ).rejects.toThrow("Find patterns must be relative");
    await expect(
      findTool.execute("parent", { pattern: "../*" }, undefined, undefined, ctx),
    ).rejects.toThrow("Find patterns must be relative");
    const findResult = await findTool.execute("safe", { pattern: "*" }, undefined, undefined, ctx);
    const findText = findResult.content.find((item) => item.type === "text")?.text;
    expect(findText).toContain("inside.txt");
    expect(findText).not.toContain("outside-link.txt");
  } finally {
    await manager.terminateAll();
    await rm(directory, { recursive: true, force: true });
  }
});

test("terminating a creating subagent disposes a session that arrives afterward", async () => {
  const directory = await mkdtemp(join(tmpdir(), "informant-subagent-terminate-"));
  let releaseFactory: ((value: ReturnType<typeof fakeSession>) => void) | undefined;
  let factoryStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    factoryStarted = resolve;
  });
  const pendingSession = new Promise<ReturnType<typeof fakeSession>>((resolve) => {
    releaseFactory = resolve;
  });
  let disposals = 0;
  const sessionFactory = (async () => {
    factoryStarted?.();
    const session = await pendingSession;
    return { session } as unknown as Awaited<ReturnType<NonNullable<SessionFactory>>>;
  }) satisfies NonNullable<SessionFactory>;
  const { manager, ctx } = managerHarness(directory, sessionFactory);

  try {
    const creation = manager.create(ctx, {
      prompt: "Use staff-review-verify to verify this finding",
      name: "race",
    });
    await started;
    await manager.terminate("race");
    releaseFactory?.(fakeSession(() => disposals++));

    await expect(creation).rejects.toThrow("Subagent creation was terminated");
    expect(manager.getAgent("race").status).toBe("terminated");
    expect(manager.getAgent("race").session).toBeUndefined();
    expect(disposals).toBe(1);
  } finally {
    await manager.terminateAll();
    await rm(directory, { recursive: true, force: true });
  }
});
