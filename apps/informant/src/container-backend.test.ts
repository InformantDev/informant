import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appleContainerBackend,
  containerBackendReadiness,
  initializeContainerBackend,
  podmanContainerBackend,
  refreshContainerBackend,
  requireContainerBackend,
  resetContainerBackendReadiness,
  selectContainerBackend,
  validateRootlessPodmanInfo,
  verifyPodman,
} from "./container-backend.ts";

const result = (exitCode = 0, stdout = "", stderr = "") => ({
  exitCode,
  stdout,
  stderr,
  timedOut: false,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
    mounts: [
      { source: "/tmp/cache", target: "/mnt/shared/cache-0" },
      { source: "/tmp/credential", target: "/mnt/credential", readOnly: true },
    ],
    command: "bun test",
    environment: { CI: "true" },
    cpu: 2,
    memoryMb: 1024,
  });
  expect(run).toContain("no-new-privileges");
  expect(run).not.toContain("label=disable");
  expect(run).toContain("/tmp/workspace:/workspace:Z");
  expect(run).toContain("/tmp/cache:/mnt/shared/cache-0:z");
  expect(run).toContain("/tmp/credential:/mnt/credential:z,ro");
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

test("keeps Podman smoke bind mounts outside a service-private temporary directory", async () => {
  const dataPath = await mkdtemp(join(tmpdir(), "informant-podman-data-"));
  let workspace: string | undefined;
  try {
    await verifyPodman(
      async (argv) => {
        if (argv[0] === "podman" && argv[1] === "run") {
          const volume = argv.find((value) => value.endsWith(":/workspace:Z"));
          if (!volume) throw new Error("missing smoke workspace mount");
          workspace = volume.slice(0, -":/workspace:Z".length);
          await Bun.write(join(workspace, "informant-smoke-test"), "ready");
        }
        return result();
      },
      undefined,
      dataPath,
    );

    expect(workspace?.startsWith(join(dataPath, "container-smoke", "podman-"))).toBe(true);
    expect(workspace && (await Bun.file(workspace).exists())).toBe(false);
  } finally {
    await rm(dataPath, { recursive: true, force: true });
  }
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

test("cancels a caller that joins an in-flight readiness probe", async () => {
  const blocked = deferred<void>();
  const runCommand = async (argv: string[]) => {
    if (argv[1] === "info") {
      await blocked.promise;
      return result(
        0,
        JSON.stringify({ host: { security: { rootless: true }, cgroupVersion: "v2" } }),
      );
    }
    return result();
  };
  const probe = refreshContainerBackend(30_000, podmanContainerBackend, runCommand, 1_000);
  const controller = new AbortController();
  const joined = requireContainerBackend(podmanContainerBackend, runCommand, controller.signal);
  controller.abort(new Error("job cancelled"));
  await expect(joined).rejects.toThrow("job cancelled");
  blocked.resolve();
  expect(await probe).toBe(true);
});

test("starts a fresh probe instead of joining an aborted unsettled refresh", async () => {
  const firstProbe = deferred<void>();
  let probes = 0;
  const runCommand = async (argv: string[]) => {
    if (argv[1] === "info") {
      probes++;
      if (probes === 1) await firstProbe.promise;
      return result(
        0,
        JSON.stringify({ host: { security: { rootless: true }, cgroupVersion: "v2" } }),
      );
    }
    return result();
  };
  const controller = new AbortController();
  const abandoned = refreshContainerBackend(
    30_000,
    podmanContainerBackend,
    runCommand,
    1_000,
    controller.signal,
  );
  while (probes === 0) await Bun.sleep(0);
  controller.abort(new Error("caller left"));
  await expect(abandoned).rejects.toThrow("caller left");

  expect(await refreshContainerBackend(30_000, podmanContainerBackend, runCommand, 1_000)).toBe(
    true,
  );
  expect(probes).toBe(2);
  firstProbe.resolve();
});

test("an abandoned probe cannot overwrite a newer readiness result", async () => {
  const firstProbe = deferred<void>();
  let probes = 0;
  const backend = {
    ...podmanContainerBackend,
    async initialize() {
      probes++;
      if (probes === 1) {
        await firstProbe.promise;
        return;
      }
      throw new Error("replacement probe failed");
    },
  };
  const controller = new AbortController();
  const abandoned = refreshContainerBackend(30_000, backend, undefined, 1_000, controller.signal);
  while (probes === 0) await Bun.sleep(0);
  controller.abort(new Error("caller left"));
  await expect(abandoned).rejects.toThrow("caller left");

  expect(await refreshContainerBackend(30_000, backend, undefined, 2_000)).toBe(false);
  firstProbe.resolve();
  await Bun.sleep(0);

  expect(containerBackendReadiness()).toMatchObject({
    backend,
    ready: false,
    error: new Error("replacement probe failed"),
  });
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

test("keeps execution smoke failures unhealthy until a later execution probe passes", async () => {
  let executionFails = true;
  const backend = {
    ...podmanContainerBackend,
    initialize: async () => undefined,
    verifyExecution: async () => {
      if (executionFails) throw new Error("prepared image smoke failed");
    },
  };

  expect(
    await initializeContainerBackend(backend, async () => result(), 1_000, undefined, true),
  ).toBe(false);
  expect(containerBackendReadiness()?.error?.message).toBe("prepared image smoke failed");
  expect(await initializeContainerBackend(backend, async () => result(), 2_000)).toBe(false);
  expect(containerBackendReadiness()?.ready).toBe(false);

  executionFails = false;
  expect(
    await initializeContainerBackend(backend, async () => result(), 3_000, undefined, true),
  ).toBe(true);
  expect(containerBackendReadiness()?.ready).toBe(true);
});

test("a basic runtime outage invalidates prior execution qualification", async () => {
  let basicFails = false;
  const backend = {
    ...podmanContainerBackend,
    initialize: async () => {
      if (basicFails) throw new Error("runtime unavailable");
    },
    verifyExecution: async () => undefined,
  };

  expect(
    await initializeContainerBackend(backend, async () => result(), 1_000, undefined, true),
  ).toBe(true);
  expect(containerBackendReadiness()?.ready).toBe(true);
  basicFails = true;
  expect(await initializeContainerBackend(backend, async () => result(), 2_000)).toBe(false);
  basicFails = false;
  expect(await initializeContainerBackend(backend, async () => result(), 3_000)).toBe(true);
  expect(containerBackendReadiness()?.ready).toBe(false);
});

test("accepts healthy rootless Podman basic readiness without qualifying execution", async () => {
  const commands: string[][] = [];
  expect(
    await initializeContainerBackend(podmanContainerBackend, async (argv) => {
      commands.push(argv);
      if (argv[0] === "podman" && argv[1] === "--version") return result(0, "podman version 5.4.2");
      return argv[1] === "info"
        ? result(0, JSON.stringify({ host: { security: { rootless: true }, cgroupVersion: "v2" } }))
        : result();
    }),
  ).toBe(true);
  expect(commands).toEqual([
    ["podman", "--version"],
    ["pasta", "--version"],
    ["podman", "info", "--format", "json"],
  ]);
  expect(containerBackendReadiness()).toMatchObject({
    backend: podmanContainerBackend,
    ready: false,
  });
});

test("rejects Podman without its default rootless network helper", async () => {
  expect(
    await initializeContainerBackend(podmanContainerBackend, async (argv) => {
      if (argv[0] === "podman") return result(0, "podman version 5.4.2");
      return argv[0] === "pasta" ? result(127, "", "not found") : result();
    }),
  ).toBe(false);
  expect(containerBackendReadiness()?.error?.message).toContain("install passt");
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
  ).toThrow("requires cgroups v2");
  expect(() =>
    validateRootlessPodmanInfo(
      JSON.stringify({ Host: { Security: { Rootless: true }, CgroupVersion: "V2" } }),
    ),
  ).not.toThrow();
});

test("rejects misleading or contradictory Podman security fields", () => {
  expect(() =>
    validateRootlessPodmanInfo(
      JSON.stringify({
        host: { security: { rootless: false }, cgroupVersion: "v1" },
        store: { security: { rootless: true }, cgroupVersion: "v2" },
      }),
    ),
  ).toThrow("not running rootless");
  expect(() =>
    validateRootlessPodmanInfo(
      '{"host":{"security":{"rootless":true},"cgroupVersion":"v2"},"Host":{"Security":{"Rootless":false},"CgroupVersion":"v1"}}',
    ),
  ).toThrow("not running rootless");
  expect(() =>
    validateRootlessPodmanInfo(
      JSON.stringify({ host: { security: { rootless: "true" }, cgroupVersion: "v2" } }),
    ),
  ).toThrow("not running rootless");
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

test("keeps a shared readiness probe healthy when its initiating caller cancels", async () => {
  const blocked = deferred<void>();
  const probing = deferred<void>();
  const controller = new AbortController();
  const signals: Array<AbortSignal | undefined> = [];
  const runCommand = async (argv: string[], options?: { signal?: AbortSignal }) => {
    signals.push(options?.signal);
    if (argv[1] === "info") {
      probing.resolve();
      await blocked.promise;
      return result(
        0,
        JSON.stringify({ host: { security: { rootless: true }, cgroupVersion: "v2" } }),
      );
    }
    return result();
  };
  const initiating = requireContainerBackend(podmanContainerBackend, runCommand, controller.signal);
  await probing.promise;
  const joined = requireContainerBackend(podmanContainerBackend, runCommand);
  controller.abort(new Error("initiating job cancelled"));
  await expect(initiating).rejects.toThrow("initiating job cancelled");
  blocked.resolve();
  expect(await joined).toBe(podmanContainerBackend);
  expect(signals).toHaveLength(2);
  expect(signals[0]).toBe(signals[1]);
  expect(signals[0]).not.toBe(controller.signal);
  expect(signals[0]?.aborted).toBe(false);
  expect(containerBackendReadiness()).toMatchObject({
    backend: podmanContainerBackend,
    ready: false,
  });
});

test("cancels the underlying readiness probe when its last waiter leaves", async () => {
  const probing = deferred<void>();
  const controller = new AbortController();
  let probeSignal: AbortSignal | undefined;
  const runCommand = async (argv: string[], options?: { signal?: AbortSignal }) => {
    if (argv[1] !== "info") return result();
    probeSignal = options?.signal;
    probing.resolve();
    return new Promise<ReturnType<typeof result>>((_resolve, reject) => {
      const signal = options?.signal;
      if (!signal) return reject(new Error("expected a shared readiness signal"));
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const pending = refreshContainerBackend(
    30_000,
    podmanContainerBackend,
    runCommand,
    1_000,
    controller.signal,
  );
  await probing.promise;
  controller.abort(new Error("worker shutdown requested"));

  await expect(pending).rejects.toThrow("worker shutdown requested");
  expect(probeSignal).not.toBe(controller.signal);
  expect(probeSignal?.aborted).toBe(true);
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
