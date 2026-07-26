import { realpath } from "node:fs/promises";
import { command } from "./process.ts";
import { cacheMounts } from "./tart/cache.ts";
import { type RuntimeSecrets, resolveJobSecrets, streamingSecretRedactor } from "./tart/index.ts";
import type { JobConfig, Repository } from "./types.ts";

function dockerMount(source: string, target: string): string {
  const field = (value: string) =>
    /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return ["type=bind", `source=${source}`, `target=${target}`].map(field).join(",");
}

export function dockerRunArguments(options: {
  name: string;
  image: string;
  workspace: string;
  command: string;
  environment: Record<string, string>;
  mounts?: Array<{ source: string; target: string }>;
  secretNames?: string[];
  cpu?: number;
  memoryMb?: number;
}): string[] {
  const args = [
    "docker",
    "run",
    "--rm",
    "--init",
    "--name",
    options.name,
    "--workdir",
    "/workspace",
  ];
  args.push("--mount", dockerMount(options.workspace, "/workspace"));
  for (const mount of options.mounts ?? [])
    args.push("--mount", dockerMount(mount.source, mount.target));
  for (const [key, value] of Object.entries(options.environment))
    args.push("--env", `${key}=${value}`);
  for (const name of options.secretNames ?? []) args.push("--env", name);
  if (options.cpu) args.push("--cpus", String(options.cpu));
  if (options.memoryMb) args.push("--memory", `${options.memoryMb}m`);
  args.push(options.image, "/bin/sh", "-lc", options.command);
  return args;
}

export async function runInDocker(
  repository: Repository,
  sha: string,
  branch: string,
  trustedSha: string,
  trustedCaches: boolean,
  workspace: string,
  job: JobConfig,
  log: (text: string) => Promise<void>,
  started: () => Promise<void>,
  runtimeSecrets: RuntimeSecrets,
  signal?: AbortSignal,
  operations: { command?: typeof command } = {},
): Promise<boolean> {
  if (job.runtime?.type !== "container") throw new Error("Docker requires a container runtime");
  const runtime = job.runtime;
  const name = `informant-${crypto.randomUUID().slice(0, 12)}`;
  const timeoutMs = job.timeoutMinutes * 60_000;
  const deadline = new AbortController();
  const timeout = setTimeout(
    () => deadline.abort(new Error(`${job.name} timed out after ${job.timeoutMinutes} minutes`)),
    timeoutMs,
  );
  const executionSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const runCommand = operations.command ?? command;
  try {
    executionSignal.throwIfAborted();
    const secrets = await resolveJobSecrets(job, runtimeSecrets);
    executionSignal.throwIfAborted();
    const caches = await cacheMounts(repository, workspace, job, "root", "linux", trustedCaches);
    const environment = {
      ...job.environment,
      INFORMANT_REPOSITORY: repository.fullName,
      INFORMANT_SHA: sha,
      INFORMANT_BRANCH: branch,
      INFORMANT_TRUSTED_SHA: trustedSha,
      HOME: "/home/root",
    };
    const execute = `${caches.restore ? `${caches.restore} && ` : ""}${job.command}`;
    const wrapped = caches.save
      ? `${execute}; status=$?; ${caches.save}; cache_status=$?; test $status -eq 0 && exit $cache_status; exit $status`
      : execute;
    const args = dockerRunArguments({
      name,
      image: runtime.image,
      workspace: await realpath(workspace),
      command: wrapped,
      environment,
      mounts: caches.mounts.map((mount) => ({
        source: mount.path,
        target: `/mnt/shared/${mount.name}`,
      })),
      secretNames: Object.keys(secrets),
      cpu: runtime.cpu,
      memoryMb: runtime.memoryMb,
    });
    await started();
    await log(`\n━━ ${job.name} ━━\n[${job.name}] $ ${job.command}\n`);
    const redactor = streamingSecretRedactor(Object.values(secrets), log);
    const result = await runCommand(args, {
      env: secrets,
      signal: executionSignal,
      onOutput: redactor.write,
    });
    await redactor.flush();
    let output = `\n[${job.name}: exit ${result.exitCode}]\n`;
    if (result.timedOut) output += `[${job.name}: timed out after ${job.timeoutMinutes}m]\n`;
    await log(output);
    return result.exitCode === 0 && !result.timedOut;
  } catch (error) {
    if (deadline.signal.aborted && !signal?.aborted) throw deadline.signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
    await runCommand(["docker", "rm", "--force", name], { timeoutMs: 30_000 });
  }
}
