import { expect, test } from "bun:test";
import { dockerRunArguments, runInDocker } from "./docker.ts";
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
