import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cachePathIdentity,
  ensurePreparedImage,
  isRetryableSshAuthenticationFailure,
  preparedImageName,
  prunePreparedImages,
  scheduleJobs,
  utf8Tail,
} from "./tart.ts";
import type { InformantConfig } from "./types.ts";

const job = (name: string, needs: string[] = []): InformantConfig["jobs"][number] => ({
  name,
  needs,
  command: name,
  environment: {},
  timeoutMinutes: 1,
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

test("cache destinations have distinct storage identities", () => {
  expect(cachePathIdentity("admin", "~/.bun/install/cache")).not.toBe(
    cachePathIdentity("admin", "~/.npm"),
  );
  expect(cachePathIdentity("admin", "~/.npm")).not.toBe(cachePathIdentity("builder", "~/.npm"));
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
