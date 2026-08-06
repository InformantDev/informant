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
    ).toEqual({ cpu: 5, memoryMb: 9216 });
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
});
