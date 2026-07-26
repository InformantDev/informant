import { expect, test } from "bun:test";
import {
  containerRunArguments,
  ensurePreparedContainer,
  preparedContainerImage,
  runInContainer,
} from "./container.ts";
import type { JobConfig, Repository } from "./types.ts";

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
  const image = await ensurePreparedContainer(runtime, () => {}, undefined, {
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
    await ensurePreparedContainer(runtime, () => {}, undefined, {
      withImageLock: async (_image, callback) => callback(),
      command: async (args) => {
        reused.push(args);
        return result(0);
      },
    }),
  ).toBe(prepared);
  expect(reused).toEqual([["container", "image", "inspect", prepared]]);
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
    ensurePreparedContainer(runtime, () => {}, undefined, operations),
    ensurePreparedContainer(runtime, () => {}, undefined, operations),
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
    () => {},
    undefined,
    operations,
  );
  await ensurePreparedContainer(
    { type: "container", image: "base-b", prepare: "install b" },
    () => {},
    undefined,
    operations,
  );

  expect(locks).toEqual(["container-builder", "container-builder"]);
});

test("passes secrets through the client environment and always removes the container", async () => {
  const invocations: Array<{ args: string[]; environment?: Record<string, string> }> = [];
  const output: string[] = [];
  const repository: Repository = { owner: "owner", repo: "repo", fullName: "owner/repo" };
  const job: JobConfig = {
    name: "test",
    command: "bun test",
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
      command: async (args, options) => {
        invocations.push({ args, environment: options?.env });
        await options?.onOutput?.("line one\nline two");
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      },
    },
  );

  expect(success).toBe(true);
  expect(invocations[0]?.args).toContain("TOKEN");
  expect(invocations[0]?.args.join(" ")).not.toContain("line one");
  expect(invocations[0]?.environment?.TOKEN).toBe("line one\nline two");
  expect(invocations[1]?.args.slice(0, 3)).toEqual(["container", "delete", "--force"]);
  expect(output.join("")).toContain("[REDACTED]");
  expect(output.join("")).not.toContain("line one");
});
