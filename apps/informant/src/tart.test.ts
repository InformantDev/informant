import { describe, expect, test } from "bun:test";
import { cachePathIdentity, preparedImageName, scheduleJobs } from "./tart.ts";
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

test("cache destinations have distinct storage identities", () => {
  expect(cachePathIdentity("admin", "~/.bun/install/cache")).not.toBe(
    cachePathIdentity("admin", "~/.npm"),
  );
  expect(cachePathIdentity("admin", "~/.npm")).not.toBe(cachePathIdentity("builder", "~/.npm"));
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
