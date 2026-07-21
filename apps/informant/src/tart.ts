import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { command, requireCommand } from "./process.ts";
import { appendLog } from "./store.ts";
import type { BuildRecord, InformantConfig, Repository } from "./types.ts";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function waitForIp(vm: string): Promise<string> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await command(["tart", "ip", vm]);
    if (result.exitCode === 0 && result.stdout.trim()) return result.stdout.trim();
    await Bun.sleep(1_000);
  }
  throw new Error("Tart VM did not acquire an IP address within 60 seconds");
}

async function waitForSsh(ip: string, user: string, password: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await command(
      [
        "sshpass",
        "-e",
        "ssh",
        "-o",
        "ConnectTimeout=2",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        `${user}@${ip}`,
        "true",
      ],
      { env: { SSHPASS: password } },
    );
    if (result.exitCode === 0) return;
    await Bun.sleep(1_000);
  }
  throw new Error("SSH did not become ready within 60 seconds");
}

async function runJob(
  vm: string,
  workspace: string,
  config: InformantConfig,
  job: InformantConfig["jobs"][number],
  record: BuildRecord,
): Promise<boolean> {
  let vmCreated = false;
  let tart: ReturnType<typeof Bun.spawn> | undefined;

  try {
    await appendLog(record, `\n━━ ${job.name} ━━\n$ tart clone ${config.vm.image} ${vm}\n`);
    await requireCommand(["tart", "clone", config.vm.image, vm]);
    vmCreated = true;
    if (config.vm.cpu || config.vm.memoryMb) {
      const args = ["tart", "set", vm];
      if (config.vm.cpu) args.push("--cpu", String(config.vm.cpu));
      if (config.vm.memoryMb) args.push("--memory", String(config.vm.memoryMb));
      await requireCommand(args);
    }

    tart = Bun.spawn(["tart", "run", "--no-graphics", `--dir=workspace:${workspace}`, vm], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const ip = await waitForIp(vm);
    await waitForSsh(ip, config.vm.user, config.vm.password);
    await appendLog(record, `[${job.name}] $ ${job.command}\n`);
    const env = Object.entries(job.environment)
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .join(" ");
    const remote = `cd ${shellQuote("/Volumes/My Shared Files/workspace")} && ${env ? `${env} ` : ""}/bin/bash -lc ${shellQuote(job.command)}`;
    const result = await command(
      [
        "sshpass",
        "-e",
        "ssh",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        `${config.vm.user}@${ip}`,
        remote,
      ],
      {
        env: { SSHPASS: config.vm.password },
        timeoutMs: job.timeoutMinutes * 60_000,
      },
    );
    let output = `${result.stdout}${result.stderr}\n[${job.name}: exit ${result.exitCode}]\n`;
    if (result.timedOut) output += `[${job.name}: timed out after ${job.timeoutMinutes}m]\n`;
    await appendLog(record, output);
    return result.exitCode === 0 && !result.timedOut;
  } finally {
    if (tart) {
      await command(["tart", "stop", vm], { timeoutMs: 15_000 });
      await Promise.race([tart.exited, Bun.sleep(3_000)]);
      if (!tart.killed) tart.kill("SIGKILL");
    }
    if (vmCreated) await command(["tart", "delete", vm], { timeoutMs: 30_000 });
  }
}

export async function scheduleJobs(
  jobs: InformantConfig["jobs"],
  executeJob: (job: InformantConfig["jobs"][number], index: number) => Promise<boolean>,
  skipJob: (job: InformantConfig["jobs"][number]) => Promise<void> = async () => {},
  failJob: (job: InformantConfig["jobs"][number], error: unknown) => Promise<void> = async () => {},
): Promise<boolean> {
  const jobsByName = new Map(jobs.map((job, index) => [job.name, { job, index }]));
  const executions = new Map<string, Promise<boolean>>();
  const execute = (job: InformantConfig["jobs"][number], index: number): Promise<boolean> => {
    const existing = executions.get(job.name);
    if (existing) return existing;
    const execution = Promise.all(
      job.needs.map((name) => {
        const dependency = jobsByName.get(name);
        if (!dependency) throw new Error(`job ${job.name} needs unknown job ${name}`);
        return execute(dependency.job, dependency.index);
      }),
    )
      .then(async (dependencies) => {
        if (dependencies.some((success) => !success)) {
          await skipJob(job);
          return false;
        }
        return executeJob(job, index);
      })
      .catch(async (error: unknown) => {
        await failJob(job, error);
        return false;
      });
    executions.set(job.name, execution);
    return execution;
  };
  const results = await Promise.all(jobs.map((job, index) => execute(job, index)));
  return results.every(Boolean);
}

export async function runInTart(
  repository: Repository,
  sha: string,
  config: InformantConfig,
  record: BuildRecord,
): Promise<boolean> {
  const root = join(record.logPath, "..", "workspace");
  const repositoryPath = join(root, "repository");
  const workspaces = config.jobs.map((_, index) => join(root, `job-${index}`));

  try {
    await mkdir(root, { recursive: true });
    await appendLog(record, `$ cloning ${repository.fullName} at ${sha}\n`);
    await requireCommand(
      ["gh", "repo", "clone", repository.fullName, repositoryPath, "--", "--no-checkout"],
      `could not clone ${repository.fullName}`,
    );
    return scheduleJobs(
      config.jobs,
      async (job, index) => {
        const workspace = workspaces[index];
        if (!workspace) throw new Error(`workspace missing for job ${job.name}`);
        const checkout = await command(["git", "worktree", "add", "--detach", workspace, sha], {
          cwd: repositoryPath,
          timeoutMs: 60_000,
        });
        if (checkout.exitCode !== 0)
          throw new Error(`could not check out ${sha}: ${checkout.stderr}`);
        return runJob(`informant-${record.id}-${index}`, workspace, config, job, record);
      },
      async (job) => {
        await appendLog(record, `\n━━ ${job.name} ━━\n[skipped: dependency failed]\n`);
      },
      async (job, error) => {
        const message = error instanceof Error ? error.message : String(error);
        await appendLog(record, `\n[${job.name}: ${message}]\n`);
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
