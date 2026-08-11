import { afterEach, expect, test } from "bun:test";
import { selectCapableJobs, workerCapabilities } from "./capabilities.ts";
import {
  initializeContainerBackend,
  podmanContainerBackend,
  resetContainerBackendReadiness,
} from "./container-backend.ts";
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

afterEach(resetContainerBackendReadiness);

test("worker capabilities include platform defaults and configured labels", () => {
  expect(workerCapabilities({ INFORMANT_CAPABILITIES: "gpu, large" })).toContain("gpu");
  expect(workerCapabilities({ INFORMANT_CAPABILITIES: "gpu, large" })).toContain("self-hosted");
});

test("selects only jobs supported by the worker and their dependencies", () => {
  expect(selectCapableJobs(config, ["linux", "x64"]).jobs.map((job) => job.name)).toEqual([
    "linux",
  ]);
});

test("requires container readiness for container jobs regardless of explicit labels", () => {
  const base = config.jobs[0];
  if (!base) throw new Error("expected base job");
  const containerConfig: InformantConfig = {
    ...config,
    jobs: [
      {
        ...base,
        name: "legacy-container",
        runsOn: ["darwin", "arm64"],
        runtime: { type: "container", image: "docker.io/oven/bun:1" },
      },
      {
        ...base,
        name: "linux-container",
        runsOn: ["linux", "x64"],
        runtime: { type: "container", image: "docker.io/oven/bun:1" },
      },
    ],
  };
  expect(selectCapableJobs(containerConfig, ["darwin", "arm64"]).jobs).toEqual([]);
  expect(selectCapableJobs(containerConfig, ["linux", "x64"]).jobs).toEqual([]);
  expect(
    selectCapableJobs(containerConfig, ["linux", "x64", "container"]).jobs.map((job) => job.name),
  ).toEqual(["linux-container"]);
});

test("advertises container only after the selected backend is healthy", async () => {
  expect(workerCapabilities({ INFORMANT_CAPABILITIES: "container" })).not.toContain("container");
  await initializeContainerBackend(podmanContainerBackend, async (argv) => ({
    exitCode: 0,
    stdout:
      argv[1] === "info"
        ? JSON.stringify({ host: { security: { rootless: true }, cgroupVersion: "v2" } })
        : "",
    stderr: "",
    timedOut: false,
  }));
  expect(workerCapabilities({})).toContain("container");
});
