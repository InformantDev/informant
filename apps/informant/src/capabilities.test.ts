import { expect, test } from "bun:test";
import { selectCapableJobs, workerCapabilities } from "./capabilities.ts";
import type { InformantConfig } from "./types.ts";

const config = {
  version: 1,
  pollIntervalSeconds: 30,
  vm: { type: "vm", image: "macos", guestOs: "macos", user: "admin", password: "admin" },
  jobs: [
    { name: "linux", needs: [], runsOn: ["linux", "x64"] },
    { name: "mac", needs: [], runsOn: ["macos", "arm64"] },
    { name: "dependent", needs: ["mac"], runsOn: ["linux", "x64"] },
  ].map((job) => ({
    command: "true",
    optional: false,
    timeoutMinutes: 1,
    environment: {},
    secrets: [],
    ...job,
  })),
} satisfies InformantConfig;

test("worker capabilities include platform defaults and configured labels", () => {
  expect(workerCapabilities({ INFORMANT_CAPABILITIES: "gpu, large" })).toContain("gpu");
  expect(workerCapabilities({ INFORMANT_CAPABILITIES: "gpu, large" })).toContain("self-hosted");
});

test("selects only jobs supported by the worker and their dependencies", () => {
  expect(selectCapableJobs(config, ["linux", "x64"]).jobs.map((job) => job.name)).toEqual([
    "linux",
  ]);
});
