import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  containerCapacity,
  containerJobCommand,
  containerRunArguments,
  ensurePreparedContainer,
  preparedContainerImage,
  pruneKnownPreparedContainerImages,
  prunePreparedContainerImages,
  runInContainer,
} from "./container.ts";
import { shellQuote } from "./tart/vm.ts";
import type { JobConfig, Repository } from "./types.ts";

const temporaryDataPaths: string[] = [];

afterEach(async () => {
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
    expect(await pruneKnownPreparedContainerImages(command, dataPath, withImageLock)).toBe(0);
    expect(await prunePreparedContainerImages(command, dataPath, withImageLock)).toBe(1);
    expect(deleted).toEqual([first, orphan]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("serializes concurrent preparation of the same container image", async () => {
  const runtime = { type: "container" as const, image: "base", prepare: "install tools" };
  let tail = Promise.resolve();
  let imageExists = false;
  let builds = 0;
  const operations = {
    withImageLock: async <T>(_image: string, callback: () => Promise<T>): Promise<T> => {
      const previous = tail;
      let release = () => {};
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await callback();
      } finally {
        release();
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

test("limits concurrent Apple containers across jobs", async () => {
  const repository: Repository = { owner: "owner", repo: "repo", fullName: "owner/repo" };
  const started: string[] = [];
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
      async () => {},
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
  expect(waiting).toHaveLength(1);
  expect(new Set([...started, ...waiting])).toEqual(new Set(names));

  releases.get(started[0] ?? "")?.resolve(result());
  while (started.length < names.length) await Bun.sleep(1);
  expect(new Set(started)).toEqual(new Set(names));
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
