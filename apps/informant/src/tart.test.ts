import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheMounts } from "./tart/cache.ts";
import {
  appendUtf8Tail,
  cachePathIdentity,
  ensurePreparedImage,
  isRetryableSshAuthenticationFailure,
  preparedImageName,
  prunePreparedImages,
  resolveJobSecrets,
  scheduleJobs,
  streamingSecretRedactor,
  utf8Tail,
} from "./tart/index.ts";
import type { InformantConfig } from "./types.ts";

const job = (name: string, needs: string[] = []): InformantConfig["jobs"][number] => ({
  name,
  needs,
  command: name,
  environment: {},
  secrets: [],
  timeoutMinutes: 1,
});

test("resolves only explicitly requested host secrets", async () => {
  const configured = { ...job("review"), secrets: ["AMP_API_KEY", "GITHUB_TOKEN"] };
  expect(
    await resolveJobSecrets(
      configured,
      { GITHUB_TOKEN: "installation-token" },
      {
        INFORMANT_SECRET_AMP_API_KEY: "amp-token",
        UNREQUESTED: "hidden",
      },
    ),
  ).toEqual({ AMP_API_KEY: "amp-token", GITHUB_TOKEN: "installation-token" });
  await expect(resolveJobSecrets(configured, {}, {})).rejects.toThrow(
    "secret AMP_API_KEY is not configured",
  );
});

test("redacts secrets split across streamed log chunks", async () => {
  let output = "";
  const redactor = streamingSecretRedactor(["top-secret"], async (text) => {
    output += text;
  });
  await redactor.write("before top-");
  await redactor.write("secret after");
  await redactor.flush();
  expect(output).toBe("before [REDACTED] after");
});

const config = (prepare?: string): InformantConfig => ({
  version: 1,
  pollIntervalSeconds: 20,
  branches: ["main"],
  vm: { image: "base", user: "admin", password: "admin", prepare },
  jobs: [job("test")],
});

test("prepared image identity changes with its source or preparation", () => {
  expect(preparedImageName(config())).toBeUndefined();
  const first = preparedImageName(config("install bun"));
  expect(first).toStartWith("informant-prepared-");
  expect(preparedImageName(config("install node"))).not.toBe(first);
  expect(
    preparedImageName({
      ...config("install bun"),
      vm: { ...config().vm, image: "other", prepare: "install bun" },
    }),
  ).not.toBe(first);
  expect(
    preparedImageName({
      ...config("install bun"),
      vm: { ...config().vm, user: "builder", prepare: "install bun" },
    }),
  ).not.toBe(first);
});

test("superseded prepared images are deleted after their last repository switches", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-images-"));
  const bin = join(root, "bin");
  const tart = join(bin, "tart");
  const deleted = join(root, "deleted");
  const firstConfig = config("install bun");
  const secondConfig = config("install node");
  const first = preparedImageName(firstConfig);
  const second = preparedImageName(secondConfig);
  if (!first || !second) throw new Error("expected prepared image names");
  await mkdir(bin);
  await Bun.write(
    tart,
    `#!/bin/sh
if [ "$1" = "list" ]; then
  printf '%s\\n' '${JSON.stringify([
    { Name: first, Source: "local" },
    { Name: second, Source: "local" },
  ])}'
elif [ "$1" = "delete" ]; then
  printf '%s\\n' "$2" >> '${deleted}'
fi
`,
  );
  await chmod(tart, 0o755);
  const originalPath = Bun.env.PATH;
  const originalDataDirectory = Bun.env.INFORMANT_DATA_DIR;
  Bun.env.PATH = `${bin}:${originalPath}`;
  Bun.env.INFORMANT_DATA_DIR = join(root, "data");
  try {
    await ensurePreparedImage(firstConfig, () => {}, "owner/one");
    await ensurePreparedImage(firstConfig, () => {}, "owner/two");
    await ensurePreparedImage(secondConfig, () => {}, "owner/one");
    expect(await Bun.file(deleted).exists()).toBe(false);

    await ensurePreparedImage(secondConfig, () => {}, "owner/two");
    expect((await Bun.file(deleted).text()).trim()).toBe(first);

    expect(await prunePreparedImages()).toBe(1);
    expect((await Bun.file(deleted).text()).trim().split("\n")).toEqual([first, first]);
  } finally {
    if (originalPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = originalPath;
    if (originalDataDirectory === undefined) delete Bun.env.INFORMANT_DATA_DIR;
    else Bun.env.INFORMANT_DATA_DIR = originalDataDirectory;
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed superseded image deletion still advances the repository reference", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-image-delete-failure-"));
  const bin = join(root, "bin");
  const tart = join(bin, "tart");
  const failed = join(root, "failed");
  const deleted = join(root, "deleted");
  const firstConfig = config("install bun");
  const secondConfig = config("install node");
  const first = preparedImageName(firstConfig);
  const second = preparedImageName(secondConfig);
  if (!first || !second) throw new Error("expected prepared image names");
  await mkdir(bin);
  await Bun.write(
    tart,
    `#!/bin/sh
if [ "$1" = "list" ]; then
  printf '%s\\n' '${JSON.stringify([
    { Name: first, Source: "local" },
    { Name: second, Source: "local" },
  ])}'
elif [ "$1" = "delete" ]; then
  if [ ! -e '${failed}' ]; then
    touch '${failed}'
    exit 1
  fi
  printf '%s\\n' "$2" >> '${deleted}'
fi
`,
  );
  await chmod(tart, 0o755);
  const originalPath = Bun.env.PATH;
  const originalDataDirectory = Bun.env.INFORMANT_DATA_DIR;
  Bun.env.PATH = `${bin}:${originalPath}`;
  Bun.env.INFORMANT_DATA_DIR = join(root, "data");
  try {
    await ensurePreparedImage(firstConfig, () => {}, "owner/repository");
    const messages: string[] = [];
    await ensurePreparedImage(
      secondConfig,
      (message) => {
        messages.push(message);
      },
      "owner/repository",
    );

    expect(messages).toEqual([`Could not delete superseded Tart image ${first}; will retry later`]);
    expect(await prunePreparedImages()).toBe(1);
    expect((await Bun.file(deleted).text()).trim()).toBe(first);
  } finally {
    if (originalPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = originalPath;
    if (originalDataDirectory === undefined) delete Bun.env.INFORMANT_DATA_DIR;
    else Bun.env.INFORMANT_DATA_DIR = originalDataDirectory;
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelling image preparation deletes its staging VM", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-cancel-image-"));
  const bin = join(root, "bin");
  const tart = join(bin, "tart");
  const started = join(root, "started");
  const deleted = join(root, "deleted");
  await mkdir(bin);
  await Bun.write(
    tart,
    `#!/bin/sh
if [ "$1" = "list" ]; then
  printf '[]\\n'
elif [ "$1" = "clone" ]; then
  touch '${started}'
  sleep 30
elif [ "$1" = "delete" ]; then
  printf '%s\\n' "$2" >> '${deleted}'
fi
`,
  );
  await chmod(tart, 0o755);
  const originalPath = Bun.env.PATH;
  Bun.env.PATH = `${bin}:${originalPath}`;
  const controller = new AbortController();
  try {
    const preparation = ensurePreparedImage(
      config("install bun"),
      () => {},
      undefined,
      controller.signal,
    );
    while (!(await Bun.file(started).exists())) await Bun.sleep(10);
    controller.abort(new Error("superseded"));

    await expect(preparation).rejects.toThrow("superseded");
    expect((await Bun.file(deleted).text()).trim()).toMatch(
      /^informant-prepared-[0-9a-f]{16}-staging-/,
    );
  } finally {
    if (originalPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("cache destinations have distinct storage identities", () => {
  expect(cachePathIdentity("admin", "~/.bun/install/cache")).not.toBe(
    cachePathIdentity("admin", "~/.npm"),
  );
  expect(cachePathIdentity("admin", "~/.npm")).not.toBe(cachePathIdentity("builder", "~/.npm"));
});

test("shared caches use one direct host mount across repositories and jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-shared-cache-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const originalDataDirectory = Bun.env.INFORMANT_DATA_DIR;
  Bun.env.INFORMANT_DATA_DIR = join(root, "data");
  const sharedJob = {
    ...job("test"),
    cache: [{ paths: ["~/.bun/install/cache"], keyFiles: [], shared: true }],
  };
  try {
    const first = await cacheMounts(
      { owner: "one", repo: "repo", fullName: "one/repo" },
      workspace,
      sharedJob,
      "admin",
      true,
    );
    const second = await cacheMounts(
      { owner: "two", repo: "other", fullName: "two/other" },
      workspace,
      { ...sharedJob, name: "lint" },
      "admin",
      true,
    );
    expect(first.args).toEqual(second.args);
    expect(first.restore).toContain("ln -s");
    expect(first.save).toBe(":");
    const untrusted = await cacheMounts(
      { owner: "one", repo: "repo", fullName: "one/repo" },
      workspace,
      sharedJob,
      "admin",
    );
    expect(untrusted.args).not.toEqual(first.args);
    expect(untrusted.args[0]).toContain(root);
  } finally {
    if (originalDataDirectory === undefined) delete Bun.env.INFORMANT_DATA_DIR;
    else Bun.env.INFORMANT_DATA_DIR = originalDataDirectory;
    await rm(root, { recursive: true, force: true });
  }
});

test("retries SSH only when authentication failed before the command started", () => {
  expect(
    isRetryableSshAuthenticationFailure({
      exitCode: 255,
      stdout: "",
      stderr: "admin@host: Permission denied (publickey,password).",
      timedOut: false,
    }),
  ).toBe(true);
  expect(
    isRetryableSshAuthenticationFailure({
      exitCode: 255,
      stdout: "command output",
      stderr: "Permission denied",
      timedOut: false,
    }),
  ).toBe(false);
  expect(
    isRetryableSshAuthenticationFailure({
      exitCode: 1,
      stdout: "",
      stderr: "Permission denied",
      timedOut: false,
    }),
  ).toBe(false);
});

test("job log tails stay within their UTF-8 byte limit", () => {
  const tail = utf8Tail(`prefix${"😀".repeat(20)}`, 17);
  expect(new TextEncoder().encode(tail).length).toBeLessThanOrEqual(17);
  expect(tail).not.toContain("�");
  expect(tail).toBe("😀".repeat(4));
});

test("job log tails can be maintained incrementally", () => {
  let tail: Uint8Array<ArrayBufferLike> = new Uint8Array();
  tail = appendUtf8Tail(tail, "prefix", 17);
  tail = appendUtf8Tail(tail, "😀".repeat(20), 17);
  const value = new TextDecoder().decode(tail);
  expect(tail.length).toBeLessThanOrEqual(17);
  expect(value).not.toContain("�");
  expect(value).toBe("😀".repeat(4));
});

describe("job scheduler", () => {
  test("starts independent jobs in parallel", async () => {
    const started: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = scheduleJobs([job("one"), job("two")], async (current) => {
      started.push(current.name);
      await blocked;
      return true;
    });
    await Bun.sleep(0);
    expect(started).toEqual(["one", "two"]);
    release();
    expect(await result).toBe(true);
  });

  test("executes a shared dependency once", async () => {
    const calls: string[] = [];
    expect(
      await scheduleJobs(
        [job("base"), job("one", ["base"]), job("two", ["base"])],
        async (current) => {
          calls.push(current.name);
          return true;
        },
      ),
    ).toBe(true);
    expect(calls.filter((name) => name === "base")).toHaveLength(1);
    expect(new Set(calls)).toEqual(new Set(["base", "one", "two"]));
  });

  test("skips downstream jobs after dependency failure", async () => {
    const executed: string[] = [];
    const skipped: string[] = [];
    expect(
      await scheduleJobs(
        [job("base"), job("child", ["base"]), job("grandchild", ["child"])],
        async (current) => {
          executed.push(current.name);
          return current.name !== "base";
        },
        async (current) => {
          skipped.push(current.name);
        },
      ),
    ).toBe(false);
    expect(executed).toEqual(["base"]);
    expect(skipped).toEqual(["child", "grandchild"]);
  });
});
