import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exchangeFilePaths } from "./atomic-rename.ts";
import {
  containerCapacity,
  containerJobCommand,
  containerRunArguments,
  ensurePreparedContainer,
  listPreparedContainerImages,
  preparedContainerImage,
  pruneKnownPreparedContainerImages,
  prunePreparedContainerImages,
  recoverMountedFileWrites,
  runInContainer,
} from "./container.ts";
import {
  appleContainerBackend,
  initializeContainerBackend,
  podmanContainerBackend,
  resetContainerBackendReadiness,
} from "./container-backend.ts";
import { MAX_ALLOWED_MOUNT_BYTES } from "./machine-config.ts";
import { digest, shellQuote } from "./tart/vm.ts";
import type { JobConfig, Repository } from "./types.ts";

const temporaryDataPaths: string[] = [];

afterEach(async () => {
  resetContainerBackendReadiness();
  await Promise.all(
    temporaryDataPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function temporaryContainerDataPath(): string {
  const path = join(tmpdir(), `informant-container-data-${crypto.randomUUID()}`);
  temporaryDataPaths.push(path);
  return path;
}

const passthroughImageLock = async <T>(_image: string, callback: () => Promise<T>): Promise<T> =>
  callback();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("container cache snapshots are published only after successful jobs", async () => {
  const cache = {
    restore: "restore-cache",
    save: "save-cache",
    installLock: "/mnt/shared/cache-0/.informant-install-lock",
  };
  const script = containerJobCommand("bun install && bun test", cache);

  expect(script).toContain("restore-cache && { if ! ulimit -n 65536");
  expect(script).toContain("bun() {");
  expect(script).toContain('while ! mkdir "/mnt/shared/cache-0/.informant-install-lock"');
  expect(script).toContain('command bun "$@" --backend=copyfile');
  expect(script).toContain("if [ $status -ne 0 ]; then exit $status; fi; save-cache");
  expect(script.indexOf("save-cache")).toBeGreaterThan(script.indexOf("exit $status"));
  expect(script).not.toContain("export -f bun");

  const marker = `/tmp/informant-cache-save-${crypto.randomUUID()}`;
  const commandMarker = `${marker}-command`;
  const save = `touch ${JSON.stringify(marker)}`;
  try {
    const restoreFailed = Bun.spawnSync([
      "/bin/sh",
      "-c",
      containerJobCommand(`touch ${JSON.stringify(commandMarker)}`, { restore: "false", save }),
    ]);
    expect(restoreFailed.exitCode).toBe(1);
    expect(await Bun.file(commandMarker).exists()).toBe(false);
    expect(await Bun.file(marker).exists()).toBe(false);

    const failed = Bun.spawnSync([
      "/bin/sh",
      "-c",
      containerJobCommand("set -e; false", { restore: ":", save }),
    ]);
    expect(failed.exitCode).toBe(1);
    expect(await Bun.file(marker).exists()).toBe(false);

    const succeeded = Bun.spawnSync([
      "/bin/sh",
      "-c",
      containerJobCommand("true", { restore: ":", save }),
    ]);
    expect(succeeded.exitCode).toBe(0);
    expect(await Bun.file(marker).exists()).toBe(true);
  } finally {
    await Promise.all([rm(marker, { force: true }), rm(commandMarker, { force: true })]);
  }
});

test("builds a bounded Apple Container invocation without putting secrets in arguments", () => {
  const args = containerRunArguments({
    name: "informant-job",
    image: "oven/bun:1",
    workspace: "/tmp/workspace",
    command: "bun test",
    environment: { CI: "true" },
    mounts: [{ source: "/tmp/cache", target: "/mnt/shared/cache-0" }],
    secretNames: ["TOKEN"],
    cpu: 2,
    memoryMb: 512,
  });
  expect(args).toEqual([
    "container",
    "run",
    "--rm",
    "--init",
    "--ulimit",
    "nofile=65536:65536",
    "--name",
    "informant-job",
    "--workdir",
    "/workspace",
    "--user",
    "0:0",
    "--entrypoint",
    "/bin/sh",
    "--volume",
    "/tmp/workspace:/workspace",
    "--volume",
    "/tmp/cache:/mnt/shared/cache-0",
    "--env",
    "CI=true",
    "--env",
    "TOKEN",
    "--cpus",
    "2",
    "--memory",
    "512M",
    "oven/bun:1",
    "-lc",
    "bun test",
  ]);
  expect(args.join(" ")).not.toContain("secret-value");
});

test("preserves commas in Apple Container volume paths", () => {
  expect(
    containerRunArguments({
      name: "informant-job",
      image: "image",
      workspace: "/tmp/workspace,one",
      command: "true",
      environment: {},
    }),
  ).toContain("/tmp/workspace,one:/workspace");
});

test("normalizes Podman localhost prepared image names", async () => {
  const commands: string[][] = [];
  const images = await listPreparedContainerImages(
    async (argv) => {
      commands.push(argv);
      return {
        exitCode: 0,
        stdout: "localhost/informant-prepared-container:0123456789abcdef\ndocker.io/oven/bun:1\n",
        stderr: "",
        timedOut: false,
      };
    },
    undefined,
    podmanContainerBackend,
  );
  expect(commands).toEqual([podmanContainerBackend.listImagesArguments()]);
  expect(images).toEqual(["informant-prepared-container:0123456789abcdef"]);
});

test("executes and force-removes jobs with rootless Podman", async () => {
  const invocations: string[][] = [];
  const runCommand = async (args: string[]) => {
    invocations.push(args);
    return {
      exitCode: 0,
      stdout:
        args[1] === "info"
          ? JSON.stringify({ host: { security: { rootless: true }, cgroupVersion: "v2" } })
          : "",
      stderr: "",
      timedOut: false,
    };
  };
  await initializeContainerBackend(podmanContainerBackend, runCommand);
  const result = await runInContainer(
    { owner: "owner", repo: "repo", fullName: "owner/repo" },
    "sha",
    "main",
    "trusted",
    false,
    process.cwd(),
    {
      name: "podman",
      command: "true",
      optional: false,
      timeoutMinutes: 1,
      environment: {},
      secrets: [],
      needs: [],
      runtime: { type: "container", image: "docker.io/oven/bun:1" },
    },
    async () => {},
    async () => {},
    {},
    undefined,
    {
      backend: podmanContainerBackend,
      command: runCommand,
      dataPath: temporaryContainerDataPath(),
    },
  );
  expect(result.success).toBe(true);
  const run = invocations.find((args) => args[1] === "run");
  expect(run).toContain("no-new-privileges");
  expect(run).toContain("--cpus");
  expect(run).toContain("--memory");
  expect(invocations.at(-1)?.slice(0, 3)).toEqual(["podman", "rm", "--force"]);
});

test("prepares and reuses a deterministic container image", async () => {
  const runtime = {
    type: "container" as const,
    image: "oven/bun:1",
    cpu: 2,
    memoryMb: 1024,
    prepare: "apt-get update && apt-get install -y git",
  };
  const prepared = preparedContainerImage(runtime);
  if (!prepared) throw new Error("expected a prepared container image");
  expect(prepared).toMatch(/^informant-prepared-container:[0-9a-f]{16}$/);
  const invocations: string[][] = [];
  const result = (exitCode: number) => ({
    exitCode,
    stdout: "",
    stderr: "",
    timedOut: false,
  });
  const image = await ensurePreparedContainer(runtime, undefined, () => {}, undefined, {
    withImageLock: async (_image, callback) => callback(),
    command: async (args, options) => {
      invocations.push(args);
      if (args[1] === "image") return result(1);
      if (args[1] === "build") {
        expect(options?.cwd).toContain("informant-container-build-");
        expect(await Bun.file(`${options?.cwd}/Dockerfile`).text()).toBe(
          `FROM oven/bun:1\nUSER 0\nCOPY informant-prepare.sh /tmp/informant-prepare.sh\nRUN /bin/sh -lc '. /tmp/informant-prepare.sh' && rm -f /tmp/informant-prepare.sh\n`,
        );
        expect(await Bun.file(`${options?.cwd}/informant-prepare.sh`).text()).toBe(
          `${runtime.prepare}\n`,
        );
      }
      return result(0);
    },
  });

  expect(image).toBe(prepared);
  expect(invocations[1]).toEqual([
    "container",
    "build",
    "--file",
    "Dockerfile",
    "--tag",
    prepared,
    "--progress",
    "plain",
    "--cpus",
    "2",
    "--memory",
    "1024M",
    ".",
  ]);

  const reused: string[][] = [];
  expect(
    await ensurePreparedContainer(runtime, undefined, () => {}, undefined, {
      withImageLock: async (_image, callback) => callback(),
      command: async (args) => {
        reused.push(args);
        return result(0);
      },
    }),
  ).toBe(prepared);
  expect(reused).toEqual([["container", "image", "inspect", prepared]]);
});

test("tracks prepared container image references and prunes images after their last user moves", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-container-references-"));
  const dataPath = join(root, "data");
  const firstRuntime = { type: "container" as const, image: "base", prepare: "install first" };
  const secondRuntime = { type: "container" as const, image: "base", prepare: "install second" };
  const first = preparedContainerImage(firstRuntime);
  const second = preparedContainerImage(secondRuntime);
  const orphan = "informant-prepared-container:aaaaaaaaaaaaaaaa";
  if (!first || !second) throw new Error("expected prepared container image names");
  const images = new Set([first, second, orphan]);
  const deleted: string[] = [];
  const command = async (args: string[]) => {
    if (args[1] === "image" && args[2] === "inspect") {
      return {
        exitCode: images.has(args[3] ?? "") ? 0 : 1,
        stdout: "",
        stderr: "",
        timedOut: false,
      };
    }
    if (args[1] === "image" && args[2] === "list") {
      return { exitCode: 0, stdout: [...images].join("\n"), stderr: "", timedOut: false };
    }
    if (args[1] === "image" && args[2] === "delete") {
      const image = args.at(-1) ?? "";
      images.delete(image);
      deleted.push(image);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    }
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  };
  const withImageLock = async <T>(_image: string, callback: () => Promise<T>) => callback();
  try {
    for (const reference of ["owner/one\0job", "owner/two\0job"])
      await ensurePreparedContainer(firstRuntime, undefined, () => {}, undefined, {
        command,
        withImageLock,
        reference,
        dataPath,
      });
    await ensurePreparedContainer(secondRuntime, undefined, () => {}, undefined, {
      command,
      withImageLock,
      reference: "owner/one\0job",
      dataPath,
    });
    expect(deleted).toEqual([]);
    await ensurePreparedContainer(secondRuntime, undefined, () => {}, undefined, {
      command,
      withImageLock,
      reference: "owner/two\0job",
      dataPath,
    });
    expect(deleted).toEqual([first]);
    expect(
      await pruneKnownPreparedContainerImages(
        command,
        dataPath,
        withImageLock,
        appleContainerBackend,
      ),
    ).toBe(0);
    expect(
      await prunePreparedContainerImages(
        command,
        dataPath,
        withImageLock,
        false,
        appleContainerBackend,
      ),
    ).toBe(1);
    expect(deleted).toEqual([first, orphan]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("container image pruning fails safely when references cannot be enumerated", async () => {
  const dataPath = temporaryContainerDataPath();
  await mkdir(dataPath, { recursive: true });
  await Bun.write(join(dataPath, "prepared-container-image-references"), "not a directory\n");
  let commands = 0;

  await expect(
    prunePreparedContainerImages(
      async () => {
        commands++;
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      },
      dataPath,
      passthroughImageLock,
    ),
  ).rejects.toThrow();
  expect(commands).toBe(0);
});

test("copies preparation inputs and includes their contents in the image identity", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "informant-prepare-inputs-"));
  await mkdir(join(workspace, "packages", "shared"), { recursive: true });
  await Bun.write(join(workspace, "package.json"), '{"name":"workspace"}\n');
  await Bun.write(join(workspace, "packages", "shared", "package.json"), '{"name":"shared"}\n');
  await Bun.write(join(workspace, "bun.lock"), "lock-v1\n");
  const runtime = {
    type: "container" as const,
    image: "oven/bun:1",
    prepare: "bun install --frozen-lockfile --ignore-scripts",
    prepareInputs: ["package.json", "packages/*/package.json", "bun.lock"],
  };
  const result = (exitCode: number) => ({
    exitCode,
    stdout: "",
    stderr: "",
    timedOut: false,
  });
  let expectedLock = "lock-v1\n";
  const build = async (args: string[], options?: { cwd?: string }) => {
    if (args[1] === "image") return result(1);
    if (args[1] === "build") {
      const context = options?.cwd;
      if (!context) throw new Error("missing build context");
      expect(await Bun.file(join(context, "informant-prepare-inputs", "bun.lock")).text()).toBe(
        expectedLock,
      );
      expect(
        await Bun.file(
          join(context, "informant-prepare-inputs", "packages", "shared", "package.json"),
        ).text(),
      ).toBe('{"name":"shared"}\n');
      const dockerfile = await Bun.file(join(context, "Dockerfile")).text();
      expect(dockerfile).toContain(
        "COPY informant-prepare-inputs /workspace\nENV HOME=/home/root\n",
      );
      expect(dockerfile).not.toContain("ENV INFORMANT_PREPARE_ROOT");
      expect(dockerfile).toContain('cd "$INFORMANT_PREPARE_ROOT"');
      expect(dockerfile).not.toContain("rm -rf /workspace");
    }
    return result(0);
  };
  const operations = {
    withImageLock: async <T>(_image: string, callback: () => Promise<T>): Promise<T> => callback(),
    command: build,
  };

  try {
    const first = await ensurePreparedContainer(
      runtime,
      workspace,
      () => {},
      undefined,
      operations,
    );
    expectedLock = "lock-v2\n";
    await Bun.write(join(workspace, "bun.lock"), "lock-v2\n");
    const second = await ensurePreparedContainer(
      runtime,
      workspace,
      () => {},
      undefined,
      operations,
    );
    expect(first).not.toBe(second);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("preparation inputs cannot traverse a symbolic link", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "informant-prepare-workspace-"));
  const outside = await mkdtemp(join(tmpdir(), "informant-prepare-outside-"));
  await Bun.write(join(outside, "secret.txt"), "secret\n");
  await symlink(outside, join(workspace, "leak"));
  try {
    expect(
      ensurePreparedContainer(
        {
          type: "container",
          image: "base",
          prepare: "cat leak/secret.txt",
          prepareInputs: ["leak/secret.txt"],
        },
        workspace,
      ),
    ).rejects.toThrow("container.prepareInputs");
  } finally {
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test("deduplicates concurrent Podman preparation of the same container image", async () => {
  const runtime = { type: "container" as const, image: "base", prepare: "install tools" };
  const tails = new Map<string, Promise<void>>();
  let imageExists = false;
  let builds = 0;
  const operations = {
    backend: podmanContainerBackend,
    withImageLock: async <T>(image: string, callback: () => Promise<T>): Promise<T> => {
      const previous = tails.get(image) ?? Promise.resolve();
      let release = () => {};
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => current);
      tails.set(image, tail);
      await previous;
      try {
        return await callback();
      } finally {
        release();
        if (tails.get(image) === tail) tails.delete(image);
      }
    },
    command: async (args: string[]) => {
      if (args[1] === "image")
        return { exitCode: imageExists ? 0 : 1, stdout: "", stderr: "", timedOut: false };
      if (args[1] === "build") {
        builds++;
        imageExists = true;
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    },
  };

  const images = await Promise.all([
    ensurePreparedContainer(runtime, undefined, () => {}, undefined, operations),
    ensurePreparedContainer(runtime, undefined, () => {}, undefined, operations),
  ]);
  expect(images[0]).toBe(images[1]);
  expect(builds).toBe(1);
});

test("serializes preparation of different images through the shared Apple builder", async () => {
  const locks: string[] = [];
  const operations = {
    withImageLock: async <T>(image: string, callback: () => Promise<T>): Promise<T> => {
      locks.push(image);
      return callback();
    },
    command: async (args: string[]) => ({
      exitCode: args[1] === "image" ? 1 : 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    }),
  };

  await ensurePreparedContainer(
    { type: "container", image: "base-a", prepare: "install a" },
    undefined,
    () => {},
    undefined,
    operations,
  );
  await ensurePreparedContainer(
    { type: "container", image: "base-b", prepare: "install b" },
    undefined,
    () => {},
    undefined,
    operations,
  );

  expect(locks).toEqual(["container-builder", "container-builder"]);
});

test("prepares distinct Podman images concurrently", async () => {
  const tails = new Map<string, Promise<void>>();
  const locks: string[] = [];
  let builds = 0;
  let activeBuilds = 0;
  let maximumActiveBuilds = 0;
  const bothBuilding = deferred<void>();
  const operations = {
    backend: podmanContainerBackend,
    withImageLock: async <T>(image: string, callback: () => Promise<T>): Promise<T> => {
      locks.push(image);
      const previous = tails.get(image) ?? Promise.resolve();
      let release = () => {};
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => current);
      tails.set(image, tail);
      await previous;
      try {
        return await callback();
      } finally {
        release();
        if (tails.get(image) === tail) tails.delete(image);
      }
    },
    command: async (args: string[]) => {
      if (args[1] === "image") return { exitCode: 1, stdout: "", stderr: "", timedOut: false };
      if (args[1] === "build") {
        builds++;
        activeBuilds++;
        maximumActiveBuilds = Math.max(maximumActiveBuilds, activeBuilds);
        if (builds === 2) bothBuilding.resolve();
        if (builds === 1) await Promise.race([bothBuilding.promise, Bun.sleep(100)]);
        activeBuilds--;
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    },
  };

  await Promise.all([
    ensurePreparedContainer(
      { type: "container", image: "base-a", prepare: "install a" },
      undefined,
      () => {},
      undefined,
      operations,
    ),
    ensurePreparedContainer(
      { type: "container", image: "base-b", prepare: "install b" },
      undefined,
      () => {},
      undefined,
      operations,
    ),
  ]);

  expect(new Set(locks).size).toBe(2);
  expect(maximumActiveBuilds).toBe(2);
});

test("passes secrets through the client environment and always removes the container", async () => {
  const invocations: Array<{ args: string[]; environment?: Record<string, string> }> = [];
  const output: string[] = [];
  const locks: string[] = [];
  const repository: Repository = { owner: "owner", repo: "repo", fullName: "owner/repo" };
  const job: JobConfig = {
    name: "test",
    command: "bun test",
    optional: false,
    timeoutMinutes: 1,
    environment: {},
    secrets: ["TOKEN"],
    needs: [],
    runtime: { type: "container", image: "oven/bun:1" },
  };
  const success = await runInContainer(
    repository,
    "commit-sha",
    "feature",
    "trusted-sha",
    false,
    process.cwd(),
    job,
    async (text) => {
      output.push(text);
    },
    async () => {},
    { TOKEN: "line one\nline two" },
    undefined,
    {
      dataPath: temporaryContainerDataPath(),
      withImageLock: async (image, callback) => {
        locks.push(image);
        return callback();
      },
      command: async (args, options) => {
        invocations.push({ args, environment: options?.env });
        await options?.onOutput?.("line one\nline two");
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      },
    },
  );

  expect(success).toEqual({ success: true, exitCode: 0, timedOut: false });
  expect(invocations[0]?.args).toContain("TOKEN");
  expect(invocations[0]?.args.join(" ")).not.toContain("line one");
  const args = invocations[0]?.args ?? [];
  expect(args.slice(args.indexOf("--cpus"), args.indexOf("--cpus") + 2)).toEqual(["--cpus", "1"]);
  expect(args.slice(args.indexOf("--memory"), args.indexOf("--memory") + 2)).toEqual([
    "--memory",
    "1024M",
  ]);
  expect(args).toContain("TERM=xterm-256color");
  expect(args).toContain("COLORTERM=truecolor");
  expect(args).toContain("FORCE_COLOR=3");
  expect(args).toContain("CLICOLOR_FORCE=1");
  expect(invocations[0]?.environment?.TOKEN).toBe("line one\nline two");
  expect(invocations[1]?.args.slice(0, 3)).toEqual(["container", "delete", "--force"]);
  expect(locks).toEqual(["prepared-container-image-references"]);
  expect(output.join("")).toStartWith("\n[test] $ bun test\n");
  expect(output.join("")).not.toContain("━━");
  expect(output.join("")).toContain("[REDACTED]");
  expect(output.join("")).not.toContain("line one");
});

test("mounts, redacts, and writes back an allowed host file", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-file-mount-"));
  const codexHome = join(root, "codex-home");
  await mkdir(codexHome);
  await Bun.write(
    join(codexHome, "auth.json"),
    JSON.stringify({ tokens: { access_token: "access-secret", refresh_token: "refresh-secret" } }),
  );
  const output: string[] = [];
  const locks: string[] = [];
  const lockAttempts: Array<number | undefined> = [];
  const job: JobConfig = {
    name: "review",
    command: "codex exec review",
    optional: true,
    timeoutMinutes: 1,
    environment: { CODEX_HOME: "/mnt/informant-codex" },
    secrets: [],
    mounts: [{ source: "codex-auth", target: "/mnt/informant-codex", writeBack: true }],
    needs: [],
    runtime: { type: "container", image: "oven/bun:1" },
  };
  try {
    const result = await runInContainer(
      { owner: "owner", repo: "repo", fullName: "owner/repo" },
      "commit-sha",
      "pull/1",
      "trusted-sha",
      false,
      process.cwd(),
      job,
      async (text) => {
        output.push(text);
      },
      async () => {},
      {},
      undefined,
      {
        allowedMounts: { "codex-auth": join(codexHome, "auth.json") },
        dataPath: join(root, "data"),
        withImageLock: async (name, callback, _signal, maximumAttempts) => {
          locks.push(name);
          lockAttempts.push(maximumAttempts);
          return callback();
        },
        command: async (args, options) => {
          if (args[1] === "run") {
            const volume = args.find((arg) => arg.endsWith(":/mnt/informant-codex"));
            if (!volume) throw new Error("expected Codex auth mount");
            const source = volume.slice(0, -":/mnt/informant-codex".length);
            await options?.onOutput?.("access-secret intermediate-access refreshed-access");
            await Bun.sleep(75);
            await Bun.write(
              join(source, "auth.json"),
              JSON.stringify({ tokens: { access_token: "refreshed-access" } }),
            );
          }
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
        },
      },
    );
    expect(result).toEqual({ success: true, exitCode: 0, timedOut: false });
    expect(await Bun.file(join(codexHome, "auth.json")).json()).toEqual({
      tokens: { access_token: "refreshed-access" },
    });
    expect(output.join("")).toContain("child output suppressed");
    expect(output.join("")).not.toContain("access-secret");
    expect(output.join("")).not.toContain("intermediate-access");
    expect(output.join("")).not.toContain("refreshed-access");
    expect(locks).toEqual([
      "prepared-container-image-references",
      `host-file-${digest(await realpath(join(codexHome, "auth.json")))}`,
    ]);
    expect(lockAttempts).toEqual([undefined, Number.POSITIVE_INFINITY]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writes back a refreshed mounted file when the container job is interrupted", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-file-interrupt-"));
  const source = join(root, "auth.json");
  await Bun.write(source, JSON.stringify({ token: "original" }));
  const job: JobConfig = {
    name: "review",
    command: "codex exec review",
    optional: true,
    timeoutMinutes: 1,
    environment: { CODEX_HOME: "/mnt/informant-codex" },
    secrets: [],
    mounts: [{ source: "codex-auth", target: "/mnt/informant-codex", writeBack: true }],
    needs: [],
    runtime: { type: "container", image: "oven/bun:1" },
  };
  try {
    await expect(
      runInContainer(
        { owner: "owner", repo: "repo", fullName: "owner/repo" },
        "commit-sha",
        "pull/1",
        "trusted-sha",
        false,
        process.cwd(),
        job,
        async () => {},
        async () => {},
        {},
        undefined,
        {
          allowedMounts: { "codex-auth": source },
          dataPath: join(root, "data"),
          withImageLock: passthroughImageLock,
          command: async (args) => {
            if (args[1] !== "run") return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
            const volume = args.find((arg) => arg.endsWith(":/mnt/informant-codex"));
            if (!volume) throw new Error("expected Codex auth mount");
            const staged = volume.slice(0, -":/mnt/informant-codex".length);
            await Bun.write(join(staged, "auth.json"), JSON.stringify({ token: "refreshed" }));
            throw new Error("interrupted");
          },
        },
      ),
    ).rejects.toThrow("interrupted");
    expect(await Bun.file(source).json()).toEqual({ token: "refreshed" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not overwrite a host file changed during a mounted job", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-file-conflict-"));
  const source = join(root, "auth.json");
  await Bun.write(source, JSON.stringify({ token: "original" }));
  const job: JobConfig = {
    name: "review",
    command: "codex exec review",
    optional: true,
    timeoutMinutes: 1,
    environment: {},
    secrets: [],
    mounts: [{ source: "auth", target: "/mnt/auth", writeBack: true }],
    needs: [],
    runtime: { type: "container", image: "oven/bun:1" },
  };
  try {
    await expect(
      runInContainer(
        { owner: "owner", repo: "repo", fullName: "owner/repo" },
        "commit-sha",
        "pull/1",
        "trusted-sha",
        false,
        process.cwd(),
        job,
        async () => {},
        async () => {},
        {},
        undefined,
        {
          allowedMounts: { auth: source },
          dataPath: join(root, "data"),
          withImageLock: passthroughImageLock,
          command: async (args) => {
            if (args[1] === "run") {
              const volume = args.find((arg) => arg.endsWith(":/mnt/auth"));
              if (!volume) throw new Error("expected auth mount");
              const staged = volume.slice(0, -":/mnt/auth".length);
              await Bun.write(join(staged, "auth.json"), JSON.stringify({ token: "container" }));
              await Bun.write(source, JSON.stringify({ token: "host-refresh" }));
            }
            return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
          },
        },
      ),
    ).rejects.toThrow("allowed host file changed during mounted job");
    expect(await Bun.file(source).json()).toEqual({ token: "host-refresh" });
    expect((await readdir(root)).filter((name) => name.includes(".informant-"))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovers an interrupted atomic mounted-file exchange on startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-file-recovery-"));
  const source = join(root, "auth.json");
  const dataPath = join(root, "data");
  await Bun.write(source, JSON.stringify({ token: "original" }));
  let exchanged = false;
  try {
    await expect(
      runInContainer(
        { owner: "owner", repo: "repo", fullName: "owner/repo" },
        "commit-sha",
        "pull/1",
        "trusted-sha",
        false,
        process.cwd(),
        {
          name: "review",
          command: "true",
          optional: false,
          timeoutMinutes: 1,
          environment: {},
          secrets: [],
          mounts: [{ source: "auth", target: "/mnt/auth", writeBack: true }],
          needs: [],
          runtime: { type: "container", image: "oven/bun:1" },
        },
        async () => {},
        async () => {},
        {},
        undefined,
        {
          allowedMounts: { auth: source },
          dataPath,
          withImageLock: passthroughImageLock,
          command: async (args) => {
            if (args[1] === "run") {
              const volume = args.find((arg) => arg.endsWith(":/mnt/auth"));
              if (!volume) throw new Error("expected auth mount");
              const staged = volume.slice(0, -":/mnt/auth".length);
              await Bun.write(join(staged, "auth.json"), JSON.stringify({ token: "rotated" }));
            }
            return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
          },
          exchange: (left, right) => {
            expect(Bun.file(source).size).toBeGreaterThan(0);
            exchangeFilePaths(left, right);
            exchanged = true;
            throw new Error("simulated interruption after exchange");
          },
        },
      ),
    ).rejects.toThrow("simulated interruption after exchange");
    expect(exchanged).toBe(true);
    expect(await Bun.file(source).json()).toEqual({ token: "rotated" });
    expect(await recoverMountedFileWrites(dataPath)).toBe(1);
    expect(await Bun.file(source).json()).toEqual({ token: "rotated" });
    expect((await readdir(root)).filter((name) => name.includes(".informant-"))).toEqual([]);
    expect(await readdir(join(dataPath, "file-mount-recovery"))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startup mounted-file recovery uses the live write-back lock and re-reads the record", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-file-recovery-lock-"));
  const source = join(root, "auth.json");
  const dataPath = join(root, "data");
  await Bun.write(source, JSON.stringify({ token: "original" }));
  let interrupted = false;
  try {
    await expect(
      runInContainer(
        { owner: "owner", repo: "repo", fullName: "owner/repo" },
        "commit-sha",
        "pull/1",
        "trusted-sha",
        false,
        process.cwd(),
        {
          name: "review",
          command: "true",
          optional: false,
          timeoutMinutes: 1,
          environment: {},
          secrets: [],
          mounts: [{ source: "auth", target: "/mnt/auth", writeBack: true }],
          needs: [],
          runtime: { type: "container", image: "oven/bun:1" },
        },
        async () => {},
        async () => {},
        {},
        undefined,
        {
          allowedMounts: { auth: source },
          dataPath,
          withImageLock: passthroughImageLock,
          command: async (args) => {
            if (args[1] === "run") {
              const volume = args.find((arg) => arg.endsWith(":/mnt/auth"));
              if (!volume) throw new Error("expected auth mount");
              const staged = volume.slice(0, -":/mnt/auth".length);
              await Bun.write(join(staged, "auth.json"), JSON.stringify({ token: "rotated" }));
            }
            return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
          },
          exchange: (left, right) => {
            exchangeFilePaths(left, right);
            if (!interrupted) {
              interrupted = true;
              throw new Error("simulated interruption after exchange");
            }
          },
        },
      ),
    ).rejects.toThrow("simulated interruption after exchange");

    const locks: Array<{ name: string; attempts: number | undefined }> = [];
    expect(
      await recoverMountedFileWrites(
        dataPath,
        exchangeFilePaths,
        async (name, callback, _signal, attempts) => {
          locks.push({ name, attempts });
          return callback();
        },
      ),
    ).toBe(1);
    expect(locks).toEqual([
      { name: `host-file-${digest(await realpath(source))}`, attempts: Number.POSITIVE_INFINITY },
    ]);
    expect(await Bun.file(source).json()).toEqual({ token: "rotated" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounds spooled output for read-only credential mounts", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-file-output-"));
  const source = join(root, "credential.txt");
  const dataPath = join(root, "data");
  await Bun.write(source, "secret-value");
  const output: string[] = [];
  try {
    await runInContainer(
      { owner: "owner", repo: "repo", fullName: "owner/repo" },
      "commit-sha",
      "pull/1",
      "trusted-sha",
      false,
      process.cwd(),
      {
        name: "review",
        command: "true",
        optional: false,
        timeoutMinutes: 1,
        environment: {},
        secrets: [],
        mounts: [{ source: "credential", target: "/mnt/credential", writeBack: false }],
        needs: [],
        runtime: { type: "container", image: "oven/bun:1" },
      },
      async (text) => {
        output.push(text);
      },
      async () => {},
      {},
      undefined,
      {
        allowedMounts: { credential: source },
        dataPath,
        withImageLock: passthroughImageLock,
        command: async (args, options) => {
          if (args[1] === "run") {
            expect(args.some((arg) => arg.endsWith(":/mnt/credential:ro"))).toBe(true);
            await options?.onOutput?.("before secret-");
            await options?.onOutput?.("value after\n");
            await options?.onOutput?.("x".repeat(10 * 1024 * 1024 + 1024));
          }
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
        },
      },
    );
    expect(output.join("")).toContain("mounted job output truncated at 10 MiB");
    expect(output.join("")).toContain("[REDACTED]");
    expect(output.join("")).not.toContain("secret-value");
    expect(Buffer.byteLength(output.join(""))).toBeLessThan(10 * 1024 * 1024 + 1024);
    expect(await Bun.file(join(dataPath, "container-output-spool")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("settles every mounted-file write-back before cleaning staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-file-write-back-"));
  const removedSource = join(root, "removed.txt");
  const persistedSource = join(root, "persisted.txt");
  await Bun.write(removedSource, "removed-original");
  await Bun.write(persistedSource, "persisted-original");
  const persistedValue = "p".repeat(128 * 1024);
  try {
    await expect(
      runInContainer(
        { owner: "owner", repo: "repo", fullName: "owner/repo" },
        "commit-sha",
        "pull/1",
        "trusted-sha",
        false,
        process.cwd(),
        {
          name: "review",
          command: "true",
          optional: true,
          timeoutMinutes: 1,
          environment: {},
          secrets: [],
          mounts: [
            { source: "removed", target: "/mnt/removed", writeBack: true },
            { source: "persisted", target: "/mnt/persisted", writeBack: true },
          ],
          needs: [],
          runtime: { type: "container", image: "oven/bun:1" },
        },
        async () => {},
        async () => {},
        {},
        undefined,
        {
          allowedMounts: { removed: removedSource, persisted: persistedSource },
          dataPath: join(root, "data"),
          withImageLock: passthroughImageLock,
          command: async (args) => {
            if (args[1] === "run") {
              const removed = args.find((arg) => arg.endsWith(":/mnt/removed"));
              const persisted = args.find((arg) => arg.endsWith(":/mnt/persisted"));
              if (!removed || !persisted) throw new Error("expected mounted files");
              await rm(join(removed.slice(0, -":/mnt/removed".length), "removed.txt"));
              await Bun.write(
                join(persisted.slice(0, -":/mnt/persisted".length), "persisted.txt"),
                persistedValue,
              );
            }
            return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
          },
        },
      ),
    ).rejects.toThrow();
    expect(await Bun.file(persistedSource).text()).toBe(persistedValue);
    expect(await readdir(join(root, "data", "file-mount-staging"))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects mounted files that grow beyond the supported size", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-file-size-"));
  const source = join(root, "credential.txt");
  await Bun.write(source, "original");
  try {
    const error = await runInContainer(
      { owner: "owner", repo: "repo", fullName: "owner/repo" },
      "commit-sha",
      "pull/1",
      "trusted-sha",
      false,
      process.cwd(),
      {
        name: "review",
        command: "true",
        optional: true,
        timeoutMinutes: 1,
        environment: {},
        secrets: [],
        mounts: [{ source: "credential", target: "/mnt/credential", writeBack: true }],
        needs: [],
        runtime: { type: "container", image: "oven/bun:1" },
      },
      async () => {},
      async () => {},
      {},
      undefined,
      {
        allowedMounts: { credential: source },
        dataPath: join(root, "data"),
        withImageLock: passthroughImageLock,
        command: async (args, options) => {
          if (args[1] === "run") {
            const volume = args.find((arg) => arg.endsWith(":/mnt/credential"));
            if (!volume) throw new Error("expected credential mount");
            const staged = volume.slice(0, -":/mnt/credential".length);
            await Bun.write(
              join(staged, "credential.txt"),
              Buffer.alloc(MAX_ALLOWED_MOUNT_BYTES + 1),
            );
            await options?.onOutput?.("oversized mounted file output");
          }
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
        },
      },
    ).catch((caught) => caught);
    expect(String(error)).toContain(`exceeds ${MAX_ALLOWED_MOUNT_BYTES} bytes`);
    expect(await Bun.file(source).text()).toBe("original");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serializes different allowlist aliases for the same host file", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-file-alias-"));
  const source = join(root, "credential.json");
  await Bun.write(source, "credential");
  const lockNames: string[] = [];
  const run = (alias: string) =>
    runInContainer(
      { owner: "owner", repo: "repo", fullName: "owner/repo" },
      "commit-sha",
      "pull/1",
      "trusted-sha",
      false,
      process.cwd(),
      {
        name: `review-${alias}`,
        command: "true",
        optional: true,
        timeoutMinutes: 1,
        environment: {},
        secrets: [],
        mounts: [{ source: alias, target: "/mnt/credential", writeBack: true }],
        needs: [],
        runtime: { type: "container", image: "oven/bun:1" },
      },
      async () => {},
      async () => {},
      {},
      undefined,
      {
        allowedMounts: { first: source, second: source },
        dataPath: join(root, "data"),
        withImageLock: async (name, callback) => {
          if (name.startsWith("host-file-")) lockNames.push(name);
          return callback();
        },
        command: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
      },
    );
  try {
    await run("first");
    await run("second");
    const canonicalSource = await realpath(source);
    expect(lockNames).toEqual([
      `host-file-${digest(canonicalSource)}`,
      `host-file-${digest(canonicalSource)}`,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleans staged files when a later mount fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-file-staging-"));
  const first = join(root, "first.txt");
  const second = join(root, "second.txt");
  await Bun.write(first, "first-secret");
  await Bun.write(second, "second-secret");
  let hostLocks = 0;
  try {
    await expect(
      runInContainer(
        { owner: "owner", repo: "repo", fullName: "owner/repo" },
        "commit-sha",
        "pull/1",
        "trusted-sha",
        false,
        process.cwd(),
        {
          name: "review",
          command: "true",
          optional: true,
          timeoutMinutes: 1,
          environment: {},
          secrets: [],
          mounts: [
            { source: "first", target: "/mnt/first", writeBack: true },
            { source: "second", target: "/mnt/second", writeBack: true },
          ],
          needs: [],
          runtime: { type: "container", image: "oven/bun:1" },
        },
        async () => {},
        async () => {},
        {},
        undefined,
        {
          allowedMounts: { first, second },
          dataPath: join(root, "data"),
          withImageLock: async (name, callback) => {
            if (name.startsWith("host-file-") && ++hostLocks === 2) await rm(second);
            return callback();
          },
          command: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
        },
      ),
    ).rejects.toThrow();
    const staging = join(root, "data", "file-mount-staging");
    expect(await readdir(staging)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects repository file mounts that are not allowed by the worker", async () => {
  const invocations: string[][] = [];
  const job: JobConfig = {
    name: "review",
    command: "cat /mnt/credential/token",
    optional: false,
    timeoutMinutes: 1,
    environment: {},
    secrets: [],
    mounts: [{ source: "credential", target: "/mnt/credential", writeBack: false }],
    needs: [],
    runtime: { type: "container", image: "oven/bun:1" },
  };
  await expect(
    runInContainer(
      { owner: "owner", repo: "repo", fullName: "owner/repo" },
      "commit-sha",
      "pull/1",
      "trusted-sha",
      false,
      process.cwd(),
      job,
      async () => {},
      async () => {},
      {},
      undefined,
      {
        allowedMounts: {},
        dataPath: temporaryContainerDataPath(),
        withImageLock: passthroughImageLock,
        command: async (args) => {
          invocations.push(args);
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
        },
      },
    ),
  ).rejects.toThrow("mount credential is not allowed on this worker");
  expect(invocations.some((args) => args[1] === "run")).toBe(false);
});

test("prepared jobs copy source into the baked workspace before running", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "informant-$'-prepared-run-"));
  await Bun.write(join(workspace, "package.json"), '{"name":"test"}\n');
  await Bun.write(join(workspace, ".git"), "gitdir: /outside/worktree\n");
  const invocations: string[][] = [];
  const result = (exitCode = 0) => ({ exitCode, stdout: "", stderr: "", timedOut: false });
  const job: JobConfig = {
    name: "test",
    command: "true",
    optional: false,
    timeoutMinutes: 1,
    environment: {},
    secrets: [],
    needs: [],
    runtime: {
      type: "container",
      image: "base",
      prepare: "prepare dependencies",
      prepareInputs: ["package.json"],
    },
  };

  try {
    await runInContainer(
      { owner: "owner", repo: "repo", fullName: "owner/repo" },
      "commit-sha",
      "main",
      "trusted-sha",
      false,
      workspace,
      job,
      async () => {},
      async () => {},
      {},
      undefined,
      {
        dataPath: temporaryContainerDataPath(),
        withImageLock: passthroughImageLock,
        command: async (args) => {
          invocations.push(args);
          return result();
        },
      },
    );
    const hostWorkspace = await realpath(workspace);
    const run = invocations.find((args) => args[1] === "run");
    expect(run).toBeDefined();
    expect(run).toContain(`${hostWorkspace}:${hostWorkspace}`);
    const script = run?.at(-1) ?? "";
    expect(script).toContain(`cp -R ${shellQuote(hostWorkspace)}/. /workspace/ &&\n`);
    expect(script).toContain("rm -f /workspace/.git &&\ntrue");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("waits for writable mount locks before reserving container capacity", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-file-lock-capacity-"));
  const source = join(root, "credential.txt");
  await Bun.write(source, "credential");
  const mountLockEntered = deferred<void>();
  const releaseMountLock = deferred<void>();
  const unrelatedStarted = deferred<void>();
  const result = () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
  const runtime = {
    type: "container" as const,
    image: "image",
    cpu: containerCapacity().cpu,
    memoryMb: containerCapacity().memoryMb,
  };
  const run = (name: string, mounts: JobConfig["mounts"] = []) =>
    runInContainer(
      { owner: "owner", repo: "repo", fullName: "owner/repo" },
      "commit-sha",
      "main",
      "trusted-sha",
      true,
      process.cwd(),
      {
        name,
        command: "true",
        optional: false,
        timeoutMinutes: 1,
        environment: {},
        secrets: [],
        mounts,
        needs: [],
        runtime,
      },
      async () => {},
      async () => {},
      {},
      undefined,
      {
        allowedMounts: { credential: source },
        dataPath: join(root, "data"),
        withImageLock: async (lockName, callback) => {
          if (lockName.startsWith("host-file-")) {
            mountLockEntered.resolve(undefined);
            await releaseMountLock.promise;
          }
          return callback();
        },
        command: async (args) => {
          if (args[1] === "run" && name === "unrelated") unrelatedStarted.resolve(undefined);
          return result();
        },
      },
    );

  const mounted = run("mounted", [
    { source: "credential", target: "/mnt/credential", writeBack: true },
  ]);
  try {
    await mountLockEntered.promise;
    const unrelated = run("unrelated");
    await Promise.race([
      unrelatedStarted.promise,
      Bun.sleep(1_000).then(() => {
        throw new Error("unrelated job could not acquire container capacity");
      }),
    ]);
    await unrelated;
  } finally {
    releaseMountLock.resolve(undefined);
    await mounted;
    await rm(root, { recursive: true, force: true });
  }
});

test("limits concurrent Apple containers across jobs", async () => {
  const repository: Repository = { owner: "owner", repo: "repo", fullName: "owner/repo" };
  const started: string[] = [];
  const reportedStarted: string[] = [];
  const waiting: string[] = [];
  const result = () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
  const releases = new Map<string, ReturnType<typeof deferred<ReturnType<typeof result>>>>();
  const dataPath = temporaryContainerDataPath();
  const run = (name: string) =>
    runInContainer(
      repository,
      "commit-sha",
      "main",
      "commit-sha",
      true,
      process.cwd(),
      {
        name,
        command: "true",
        optional: false,
        timeoutMinutes: 1,
        environment: {},
        secrets: [],
        needs: [],
        runtime: {
          type: "container",
          image: "image",
          cpu: containerCapacity().cpu,
          memoryMb: containerCapacity().memoryMb,
        },
      },
      async (text) => {
        if (text.includes("waiting for")) waiting.push(name);
      },
      async () => {
        reportedStarted.push(name);
      },
      {},
      undefined,
      {
        dataPath,
        withImageLock: passthroughImageLock,
        command: async (args) => {
          if (args[1] === "run") {
            started.push(name);
            const release = deferred<ReturnType<typeof result>>();
            releases.set(name, release);
            return release.promise;
          }
          return result();
        },
      },
    );

  const names = ["first", "second"];
  const jobs = names.map(run);
  while (started.length < 1) await Bun.sleep(1);
  expect(started).toHaveLength(1);
  expect(reportedStarted).toEqual(started);
  expect(waiting).toHaveLength(1);
  expect(new Set([...started, ...waiting])).toEqual(new Set(names));

  releases.get(started[0] ?? "")?.resolve(result());
  while (started.length < names.length) await Bun.sleep(1);
  expect(new Set(started)).toEqual(new Set(names));
  expect(new Set(reportedStarted)).toEqual(new Set(names));
  for (const release of releases.values()) release.resolve(result());
  await Promise.all(jobs);
});

test("cancelling a queued job does not invoke Apple Container", async () => {
  const repository: Repository = { owner: "owner", repo: "repo", fullName: "owner/repo" };
  const result = () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
  const release = deferred<ReturnType<typeof result>>();
  const invocations = new Map<string, string[][]>();
  const dataPath = temporaryContainerDataPath();
  const run = (name: string, signal?: AbortSignal) =>
    runInContainer(
      repository,
      "commit-sha",
      "main",
      "commit-sha",
      true,
      process.cwd(),
      {
        name,
        command: "true",
        optional: false,
        timeoutMinutes: 1,
        environment: {},
        secrets: [],
        needs: [],
        runtime: {
          type: "container",
          image: "image",
          cpu: containerCapacity().cpu,
          memoryMb: containerCapacity().memoryMb,
        },
      },
      async () => {},
      async () => {},
      {},
      signal,
      {
        dataPath,
        withImageLock: passthroughImageLock,
        command: async (args) => {
          const calls = invocations.get(name) ?? [];
          calls.push(args);
          invocations.set(name, calls);
          if (args[1] === "run" && name !== "queued") {
            return release.promise;
          }
          return result();
        },
      },
    );

  const active = run("active");
  while ((invocations.get("active") ?? []).every((args) => args[1] !== "run")) await Bun.sleep(1);
  const controller = new AbortController();
  const queued = run("queued", controller.signal).catch((error) => error);
  controller.abort("cancelled");

  expect(await queued).toBe("cancelled");
  expect(invocations.get("queued")).toBeUndefined();
  release.resolve(result());
  await active;
});

test("derives Apple Container capacity from host CPU and memory", () => {
  expect(containerCapacity(16, 49_152)).toEqual({ cpu: 14, memoryMb: 36_864 });
  expect(containerCapacity(1, 512)).toEqual({ cpu: 1, memoryMb: 1024 });
});
