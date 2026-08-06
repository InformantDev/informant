import { afterEach, expect, test } from "bun:test";
import {
  appleContainerBackend,
  containerBackendReadiness,
  initializeContainerBackend,
  podmanContainerBackend,
  refreshContainerBackend,
  resetContainerBackendReadiness,
  selectContainerBackend,
  validateRootlessPodmanInfo,
} from "./container-backend.ts";

const result = (exitCode = 0, stdout = "", stderr = "") => ({
  exitCode,
  stdout,
  stderr,
  timedOut: false,
});

afterEach(resetContainerBackendReadiness);

test("selects Apple Container on Apple silicon and Podman on Linux", () => {
  expect(selectContainerBackend("darwin", "arm64")).toBe(appleContainerBackend);
  expect(selectContainerBackend("linux", "x64")).toBe(podmanContainerBackend);
  expect(selectContainerBackend("darwin", "x64")).toBeUndefined();
});

test("builds Podman run and image lifecycle commands", () => {
  const run = podmanContainerBackend.runArguments({
    name: "informant-job",
    image: "docker.io/oven/bun:1",
    workspace: "/tmp/workspace",
    mounts: [{ source: "/tmp/cache", target: "/mnt/shared/cache-0" }],
    command: "bun test",
    environment: { CI: "true" },
    cpu: 2,
    memoryMb: 1024,
  });
  expect(run).toContain("no-new-privileges");
  expect(run).not.toContain("label=disable");
  expect(run).toContain("/tmp/workspace:/workspace:Z");
  expect(run).toContain("/tmp/cache:/mnt/shared/cache-0:z");
  expect(run).toContain("--cpus");
  expect(run).toContain("--memory");
  expect(podmanContainerBackend.buildArguments("prepared", 2, 1024)).toEqual([
    "podman",
    "build",
    "--file",
    "Dockerfile",
    "--tag",
    "prepared",
    "--progress",
    "plain",
    "--force-rm",
    "--cpu-period",
    "100000",
    "--cpu-quota",
    "200000",
    "--memory",
    "1024M",
    ".",
  ]);
  expect(podmanContainerBackend.listImagesArguments()).toEqual([
    "podman",
    "image",
    "ls",
    "--format",
    "{{.Repository}}:{{.Tag}}",
  ]);
  expect(podmanContainerBackend.removeImageArguments("prepared")).toEqual([
    "podman",
    "image",
    "rm",
    "prepared",
  ]);
  expect(podmanContainerBackend.removeContainerArguments("job")).toEqual([
    "podman",
    "rm",
    "--force",
    "job",
  ]);
  expect(podmanContainerBackend.systemDfArguments()).toEqual([
    "podman",
    "system",
    "df",
    "--format",
    "json",
  ]);
});

test("refreshes cached readiness only after the maximum age", async () => {
  let probes = 0;
  const runCommand = async (argv: string[]) => {
    if (argv[1] === "info") probes++;
    return argv[1] === "info"
      ? result(0, JSON.stringify({ host: { security: { rootless: true }, cgroupVersion: "v2" } }))
      : result();
  };
  expect(await refreshContainerBackend(30_000, podmanContainerBackend, runCommand, 1_000)).toBe(
    true,
  );
  expect(await refreshContainerBackend(30_000, podmanContainerBackend, runCommand, 30_999)).toBe(
    true,
  );
  expect(probes).toBe(1);
  expect(await refreshContainerBackend(30_000, podmanContainerBackend, runCommand, 31_000)).toBe(
    true,
  );
  expect(probes).toBe(2);
});

test("coalesces concurrent stale readiness probes", async () => {
  let probes = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runCommand = async (argv: string[]) => {
    if (argv[1] === "info") {
      probes++;
      await blocked;
      return result(
        0,
        JSON.stringify({ host: { security: { rootless: true }, cgroupVersion: "v2" } }),
      );
    }
    return result();
  };
  const first = refreshContainerBackend(30_000, podmanContainerBackend, runCommand, 1_000);
  const second = refreshContainerBackend(30_000, podmanContainerBackend, runCommand, 1_000);
  release();
  expect(await Promise.all([first, second])).toEqual([true, true]);
  expect(probes).toBe(1);
});

test("re-probes stale success and allows stale failure to recover", async () => {
  let rootless = true;
  const runCommand = async (argv: string[]) =>
    argv[1] === "info"
      ? result(0, JSON.stringify({ host: { security: { rootless }, cgroupVersion: "v2" } }))
      : result();
  expect(await refreshContainerBackend(30_000, podmanContainerBackend, runCommand, 0)).toBe(true);
  rootless = false;
  expect(await refreshContainerBackend(30_000, podmanContainerBackend, runCommand, 30_000)).toBe(
    false,
  );
  rootless = true;
  expect(await refreshContainerBackend(30_000, podmanContainerBackend, runCommand, 60_000)).toBe(
    true,
  );
});

test("accepts healthy rootless Podman and caches readiness", async () => {
  const commands: string[][] = [];
  expect(
    await initializeContainerBackend(podmanContainerBackend, async (argv) => {
      commands.push(argv);
      return argv[1] === "info"
        ? result(0, JSON.stringify({ host: { security: { rootless: true }, cgroupVersion: "v2" } }))
        : result();
    }),
  ).toBe(true);
  expect(commands).toEqual([
    ["podman", "--version"],
    ["podman", "info", "--format", "json"],
  ]);
  expect(containerBackendReadiness()).toMatchObject({
    backend: podmanContainerBackend,
    ready: true,
  });
});

test("rejects rootful and malformed Podman information", async () => {
  expect(() => validateRootlessPodmanInfo(JSON.stringify({ host: { rootless: false } }))).toThrow(
    "not running rootless",
  );
  expect(() => validateRootlessPodmanInfo("not json")).toThrow("invalid information");
  expect(
    await initializeContainerBackend(podmanContainerBackend, async (argv) =>
      argv[1] === "info"
        ? result(0, JSON.stringify({ Host: { Security: { Rootless: false } } }))
        : result(),
    ),
  ).toBe(false);
  expect(containerBackendReadiness()?.error?.message).toContain("rootless");
});

test("rejects rootless Podman without cgroups v2", () => {
  expect(() =>
    validateRootlessPodmanInfo(
      JSON.stringify({ Host: { Security: { Rootless: true }, CgroupVersion: "v1" } }),
    ),
  ).toThrow("requires cgroups v2");
  expect(() =>
    validateRootlessPodmanInfo(
      JSON.stringify({ Host: { Security: { Rootless: true }, CgroupVersion: 2 } }),
    ),
  ).not.toThrow();
});

test("treats timed-out readiness commands as unhealthy", async () => {
  expect(
    await initializeContainerBackend(podmanContainerBackend, async () => ({
      ...result(),
      timedOut: true,
    })),
  ).toBe(false);
});

test("bounds and forwards cancellation to readiness commands", async () => {
  const controller = new AbortController();
  const options: Array<{ timeoutMs?: number; signal?: AbortSignal }> = [];
  await initializeContainerBackend(
    podmanContainerBackend,
    async (argv, commandOptions) => {
      options.push(commandOptions ?? {});
      return argv[1] === "info"
        ? result(0, JSON.stringify({ host: { security: { rootless: true }, cgroupVersion: "v2" } }))
        : result();
    },
    0,
    controller.signal,
  );
  expect(options).toEqual([
    { timeoutMs: 15_000, signal: controller.signal },
    { timeoutMs: 15_000, signal: controller.signal },
  ]);
});

test("bounds every Apple Container readiness and start command", async () => {
  const controller = new AbortController();
  const commands: Array<{
    argv: string[];
    options?: { timeoutMs?: number; signal?: AbortSignal };
  }> = [];
  let statuses = 0;
  await appleContainerBackend.initialize(async (argv, options) => {
    commands.push({ argv, options });
    if (argv[1] === "system" && argv[2] === "status" && statuses++ === 0) return result(1);
    return result();
  }, controller.signal);
  expect(commands.map(({ argv }) => argv)).toEqual([
    ["container", "--version"],
    ["container", "system", "status", "--format", "json"],
    ["container", "system", "start", "--enable-kernel-install"],
    ["container", "system", "status", "--format", "json"],
  ]);
  expect(commands.every(({ options }) => options?.timeoutMs === 15_000)).toBe(true);
  expect(commands.every(({ options }) => options?.signal === controller.signal)).toBe(true);
});
