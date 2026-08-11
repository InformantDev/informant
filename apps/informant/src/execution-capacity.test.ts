import { describe, expect, test } from "bun:test";
import {
  claimExecutionResources,
  createExecutionSlotAcquirer,
  executionCapacity,
} from "./execution-capacity.ts";
import type { InformantConfig, JobConfig } from "./types.ts";

const job = (name: string, cpu: number, memoryMb: number, needs: string[] = []): JobConfig => ({
  name,
  command: name,
  optional: false,
  timeoutMinutes: 1,
  environment: {},
  secrets: [],
  needs,
  runtime: { type: "container", image: "image", cpu, memoryMb },
});

const config = (jobs: JobConfig[]): InformantConfig => ({
  version: 1,
  pollIntervalSeconds: 10,
  vm: { type: "vm", image: "image", guestOs: "macos", user: "user", password: "password" },
  jobs,
});

const vmJob = (name: string, cpu?: number, memoryMb?: number): JobConfig => ({
  ...job(name, 1, 1024),
  runtime: {
    type: "vm",
    image: "image",
    guestOs: "macos",
    user: "user",
    password: "password",
    cpu,
    memoryMb,
  },
});

const hostJob = (name: string): JobConfig => ({
  ...job(name, 1, 1024),
  runtime: { type: "host" },
});

describe("execution capacity", () => {
  test("derives capacity while retaining a minimum runnable slot", () => {
    expect(executionCapacity(16, 49_152)).toEqual({ cpu: 14, memoryMb: 36_864 });
    expect(executionCapacity(1, 512)).toEqual({ cpu: 1, memoryMb: 1024 });
  });

  test("bounds both dependency roots and later fan-out", () => {
    expect(
      claimExecutionResources(
        config([
          job("test", 2, 2048),
          job("lint", 1, 1024),
          job("build", 4, 8192, ["test", "lint"]),
        ]),
      ),
    ).toEqual({ cpu: 4, memoryMb: 8192 });
    expect(
      claimExecutionResources(
        config([
          job("setup", 1, 1024),
          job("test", 4, 4096, ["setup"]),
          job("lint", 4, 4096, ["setup"]),
        ]),
      ),
    ).toEqual({ cpu: 8, memoryMb: 8192 });
    expect(
      claimExecutionResources(
        config([
          job("setup", 1, 1024),
          job("test", 2, 2048, ["setup"]),
          job("build", 4, 4096, ["test"]),
        ]),
      ),
    ).toEqual({ cpu: 4, memoryMb: 4096 });
  });

  test("does not over-reserve a join after uneven diamond branches", () => {
    expect(
      claimExecutionResources(
        config([
          job("a", 1, 1024),
          job("b", 1, 1024, ["a"]),
          job("c", 8, 8192, ["a"]),
          job("d", 8, 8192, ["b", "c"]),
        ]),
      ),
    ).toEqual({ cpu: 9, memoryMb: 9216 });
  });

  test("admits concurrent claims up to weighted capacity", async () => {
    const acquire = createExecutionSlotAcquirer({ cpu: 2, memoryMb: 2048 });
    const single = config([job("test", 1, 1024)]);
    const first = await acquire(single);
    const second = await acquire(single);
    let thirdEntered = false;
    const third = acquire(single).then((release) => {
      thirdEntered = true;
      return release;
    });

    await Bun.sleep(0);
    expect(first).toBeFunction();
    expect(second).toBeFunction();
    expect(thirdEntered).toBeFalse();

    first?.();
    const releaseThird = await third;
    expect(releaseThird).toBeFunction();
    second?.();
    releaseThird?.();
  });

  test("an unspecified VM reserves full capacity until release", async () => {
    const capacity = { cpu: 8, memoryMb: 16_384 };
    const vm = config([vmJob("test")]);
    expect(claimExecutionResources(vm, vm.jobs, capacity)).toEqual(capacity);

    const acquire = createExecutionSlotAcquirer(capacity);
    const first = await acquire(vm);
    let secondEntered = false;
    const second = acquire(vm).then((release) => {
      secondEntered = true;
      return release;
    });

    await Bun.sleep(0);
    expect(first).toBeFunction();
    expect(secondEntered).toBeFalse();

    first?.();
    const releaseSecond = await second;
    expect(releaseSecond).toBeFunction();
    releaseSecond?.();
  });

  test("host work reserves full capacity until release", async () => {
    const capacity = { cpu: 8, memoryMb: 16_384 };
    const host = config([hostJob("test")]);
    expect(claimExecutionResources(host, host.jobs, capacity)).toEqual(capacity);

    const acquire = createExecutionSlotAcquirer(capacity);
    const first = await acquire(host);
    let secondEntered = false;
    const second = acquire(host).then((release) => {
      secondEntered = true;
      return release;
    });

    await Bun.sleep(0);
    expect(first).toBeFunction();
    expect(secondEntered).toBeFalse();

    first?.();
    const releaseSecond = await second;
    expect(releaseSecond).toBeFunction();
    releaseSecond?.();
  });

  test("partially specified VMs use explicit values and conservative fallbacks", () => {
    const capacity = { cpu: 8, memoryMb: 16_384 };
    const cpuConfigured = config([vmJob("cpu", 4)]);
    const memoryConfigured = config([vmJob("memory", undefined, 8192)]);

    expect(claimExecutionResources(cpuConfigured, cpuConfigured.jobs, capacity)).toEqual({
      cpu: 4,
      memoryMb: capacity.memoryMb,
    });
    expect(claimExecutionResources(memoryConfigured, memoryConfigured.jobs, capacity)).toEqual({
      cpu: capacity.cpu,
      memoryMb: 8192,
    });
  });
});
