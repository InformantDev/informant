import { expect, test } from "bun:test";
import {
  dockerRunArguments,
  ensurePreparedContainer,
  preparedContainerImage,
  runInDocker,
} from "./docker.ts";
import type { JobConfig, Repository } from "./types.ts";

test("builds a bounded Docker invocation without putting secrets in arguments", () => {
  const args = dockerRunArguments({
    name: "informant-job",
    image: "oven/bun:1",
    workspace: "/tmp/workspace",
    command: "bun test",
    environment: { CI: "true" },
    mounts: [{ source: "/tmp/cache", target: "/mnt/shared/cache-0" }],
    secretNames: ["TOKEN"],
    cpu: 1.5,
    memoryMb: 512,
  });
  expect(args).toEqual([
    "docker",
    "run",
    "--rm",
    "--init",
    "--name",
    "informant-job",
    "--workdir",
    "/workspace",
    "--mount",
    "type=bind,source=/tmp/workspace,target=/workspace",
    "--mount",
    "type=bind,source=/tmp/cache,target=/mnt/shared/cache-0",
    "--env",
    "CI=true",
    "--env",
    "TOKEN",
    "--cpus",
    "1.5",
    "--memory",
    "512m",
    "oven/bun:1",
    "/bin/sh",
    "-lc",
    "bun test",
  ]);
  expect(args.join(" ")).not.toContain("secret-value");
});

test("quotes commas in Docker bind mount fields", () => {
  expect(
    dockerRunArguments({
      name: "informant-job",
      image: "image",
      workspace: "/tmp/workspace,one",
      command: "true",
      environment: {},
    }),
  ).toContain('type=bind,"source=/tmp/workspace,one",target=/workspace');
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
    command: async (args) => {
      invocations.push(args);
      if (args[1] === "image") return result(1);
      return result(0);
    },
  });

  expect(image).toBe(prepared);
  expect(invocations[1]).toEqual([
    "docker",
    "run",
    "--name",
    expect.stringMatching(/^informant-prepare-/),
    "--cpus",
    "2",
    "--memory",
    "1024m",
    "oven/bun:1",
    "/bin/sh",
    "-lc",
    runtime.prepare,
  ]);
  expect(invocations[2]?.slice(0, 2)).toEqual(["docker", "commit"]);
  expect(invocations[2]?.at(-1)).toBe(prepared);
  expect(invocations[3]?.slice(0, 4)).toEqual(["docker", "rm", "--force", "--volumes"]);

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
  expect(reused).toEqual([["docker", "image", "inspect", prepared]]);
});

test("serializes concurrent preparation of the same container image", async () => {
  const runtime = { type: "container" as const, image: "base", prepare: "install tools" };
  let tail = Promise.resolve();
  let imageExists = false;
  let preparations = 0;
  let commits = 0;
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
      if (args[1] === "run") preparations++;
      if (args[1] === "commit") {
        commits++;
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
  expect(preparations).toBe(1);
  expect(commits).toBe(1);
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
  const success = await runInDocker(
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
  expect(invocations[1]?.args.slice(0, 3)).toEqual(["docker", "rm", "--force"]);
  expect(output.join("")).toContain("[REDACTED]");
  expect(output.join("")).not.toContain("line one");
});
