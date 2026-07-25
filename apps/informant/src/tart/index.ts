import { chmod, mkdir, open, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { command, requireCommand } from "../process.ts";
import { appendLog } from "../store.ts";
import type { BuildRecord, InformantConfig, Repository } from "../types.ts";
import { cacheMounts } from "./cache.ts";
import { ensurePreparedImage } from "./images.ts";
import { provisionVm, shellQuote, sshCommand, startVm, stopVm, withImageLock } from "./vm.ts";

export { cachePathIdentity } from "./cache.ts";
export {
  ensurePreparedImage,
  listPreparedImages,
  preparedImageName,
  prunePreparedImages,
  pruneStoppedJobVms,
} from "./images.ts";
export { isRetryableSshAuthenticationFailure } from "./vm.ts";

export type RuntimeSecrets = Record<string, string | (() => Promise<string>)>;

export async function resolveJobSecrets(
  job: InformantConfig["jobs"][number],
  runtimeSecrets: RuntimeSecrets = {},
  hostEnvironment: Record<string, string | undefined> = Bun.env,
): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      job.secrets.map(async (name) => {
        const runtime = runtimeSecrets[name];
        const value =
          typeof runtime === "function"
            ? await runtime()
            : (runtime ?? hostEnvironment[`INFORMANT_SECRET_${name}`]);
        if (value === undefined) {
          throw new Error(
            `secret ${name} is not configured on this worker; set INFORMANT_SECRET_${name}`,
          );
        }
        return [name, value];
      }),
    ),
  );
}

async function secretMount(
  workspace: string,
  job: InformantConfig["jobs"][number],
  runtimeSecrets: RuntimeSecrets,
): Promise<{ args: string[]; source: string; values: string[]; directory?: string }> {
  const secrets = await resolveJobSecrets(job, runtimeSecrets);
  if (Object.keys(secrets).length === 0) return { args: [], source: "", values: [] };
  const directory = join(workspace, "..", `secrets-${crypto.randomUUID().slice(0, 8)}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "environment");
  await Bun.write(
    path,
    `${Object.entries(secrets)
      .map(([name, value]) => `export ${name}=${shellQuote(value)}`)
      .join("\n")}\n`,
  );
  await chmod(path, 0o600);
  return {
    args: [`--dir=secrets:${await realpath(directory)}`],
    source: `. ${shellQuote("/Volumes/My Shared Files/secrets/environment")}; rm -f ${shellQuote("/Volumes/My Shared Files/secrets/environment")};`,
    values: Object.values(secrets).filter((value) => value.length > 0),
    directory,
  };
}

export function streamingSecretRedactor(
  secrets: string[],
  output: (text: string) => Promise<void>,
): { write: (text: string) => Promise<void>; flush: () => Promise<void> } {
  const values = [...new Set(secrets)].sort((a, b) => b.length - a.length);
  const retainedCharacters = Math.max(0, ...values.map((value) => value.length - 1));
  let pending = "";
  const drain = async (final: boolean) => {
    const safeLength = final ? pending.length : Math.max(0, pending.length - retainedCharacters);
    if (safeLength === 0) return;
    let consumed = 0;
    let redacted = "";
    while (consumed < safeLength) {
      let match: { index: number; value: string } | undefined;
      for (const value of values) {
        const index = pending.indexOf(value, consumed);
        if (index >= 0 && (!match || index < match.index)) match = { index, value };
      }
      if (!match || match.index >= safeLength) {
        redacted += pending.slice(consumed, safeLength);
        consumed = safeLength;
      } else {
        redacted += `${pending.slice(consumed, match.index)}[REDACTED]`;
        consumed = match.index + match.value.length;
      }
    }
    pending = pending.slice(consumed);
    if (redacted) await output(redacted);
  };
  return {
    async write(text) {
      pending += text;
      await drain(false);
    },
    async flush() {
      await drain(true);
    },
  };
}

async function runJob(
  vm: string,
  image: string,
  repository: Repository,
  sha: string,
  branch: string,
  workspace: string,
  config: InformantConfig,
  job: InformantConfig["jobs"][number],
  log: (text: string) => Promise<void>,
  started: () => Promise<void>,
  runtimeSecrets: RuntimeSecrets,
  signal?: AbortSignal,
): Promise<boolean> {
  let vmCreated = false;
  let tart: ReturnType<typeof Bun.spawn> | undefined;
  let secretDirectory: string | undefined;

  try {
    signal?.throwIfAborted();
    const ready = await provisionVm(async () => {
      signal?.throwIfAborted();
      await log(`\n━━ ${job.name} ━━\n$ tart clone ${image} ${vm}\n`);
      vmCreated = true;
      const clone = () => requireCommand(["tart", "clone", image, vm], undefined, { signal });
      if (image.startsWith("informant-prepared-")) await withImageLock(image, clone, signal);
      else await clone();
      if (config.vm.cpu || config.vm.memoryMb) {
        const args = ["tart", "set", vm];
        if (config.vm.cpu) args.push("--cpu", String(config.vm.cpu));
        if (config.vm.memoryMb) args.push("--memory", String(config.vm.memoryMb));
        await requireCommand(args, undefined, { signal });
      }

      const sharedWorkspace = await realpath(workspace);
      const caches = await cacheMounts(
        repository,
        workspace,
        job,
        config.vm.user,
        config.trustedSha === sha,
      );
      const secrets = await secretMount(workspace, job, runtimeSecrets);
      secretDirectory = secrets.directory;
      const started = await startVm(
        vm,
        [`--dir=workspace:${sharedWorkspace}`, ...caches.args, ...secrets.args],
        config,
        job.timeoutMinutes,
        async () => {
          await log(`[${job.name}] waiting for an available Tart VM slot\n`);
        },
        signal,
      );
      tart = started.process;
      return {
        ip: started.ip,
        cacheRestore: caches.restore,
        cacheSave: caches.save,
        secretSource: secrets.source,
        secretValues: secrets.values,
      };
    }, signal);
    await started();
    await log(`[${job.name}] $ ${job.command}\n`);
    const environment = {
      ...job.environment,
      INFORMANT_REPOSITORY: repository.fullName,
      INFORMANT_SHA: sha,
      INFORMANT_BRANCH: branch,
      INFORMANT_TRUSTED_SHA: config.trustedSha ?? sha,
    };
    const env = Object.entries(environment)
      .map(([key, value]) => `export ${key}=${shellQuote(value)};`)
      .join(" ");
    const execute = `cd ${shellQuote("/Volumes/My Shared Files/workspace")} && /bin/bash -lc ${shellQuote(`${env} ${ready.secretSource} ${job.command}`)}`;
    const jobCommand = ready.cacheRestore
      ? `${ready.cacheRestore} && ${execute}; informant_job_status=$?; ${ready.cacheSave}; informant_cache_status=$?; if [ $informant_job_status -ne 0 ]; then exit $informant_job_status; fi; exit $informant_cache_status`
      : execute;
    const redactor = streamingSecretRedactor(ready.secretValues, log);
    const result = await sshCommand(ready.ip, config, jobCommand, job.timeoutMinutes * 60_000, {
      signal,
      onOutput: redactor.write,
    });
    await redactor.flush();
    let output = `\n[${job.name}: exit ${result.exitCode}]\n`;
    if (result.timedOut) output += `[${job.name}: timed out after ${job.timeoutMinutes}m]\n`;
    await log(output);
    return result.exitCode === 0 && !result.timedOut;
  } finally {
    try {
      if (tart) await stopVm(vm, tart);
      if (vmCreated) {
        const deleted = await command(["tart", "delete", vm], { timeoutMs: 30_000 });
        if (deleted.exitCode !== 0) {
          await log(`[${job.name}] could not delete Tart VM ${vm}: ${deleted.stderr}\n`);
        }
      }
    } finally {
      if (secretDirectory) await rm(secretDirectory, { recursive: true, force: true });
    }
  }
}

export type JobOutcome = "success" | "failure" | "skipped" | "cancelled";

export interface JobExecutionObserver {
  started?: (job: InformantConfig["jobs"][number]) => Promise<void> | void;
  progress?: (job: InformantConfig["jobs"][number], log: string) => Promise<void> | void;
  completed?: (
    job: InformantConfig["jobs"][number],
    result: { outcome: JobOutcome; log: string },
  ) => Promise<void> | void;
}

const JOB_LOG_BYTES = 55_000;

export function utf8Tail(value: string, maximumBytes = JOB_LOG_BYTES): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= maximumBytes) return value;
  let start = bytes.length - maximumBytes;
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  return new TextDecoder().decode(bytes.subarray(start));
}

export function appendUtf8Tail(
  tail: Uint8Array,
  value: string,
  maximumBytes = JOB_LOG_BYTES,
): Uint8Array {
  const addition = new TextEncoder().encode(value);
  if (addition.length >= maximumBytes) {
    let start = addition.length - maximumBytes;
    while (start < addition.length && ((addition[start] ?? 0) & 0xc0) === 0x80) start++;
    return addition.slice(start);
  }
  const keep = Math.min(tail.length, maximumBytes - addition.length);
  let start = tail.length - keep;
  while (start < tail.length && ((tail[start] ?? 0) & 0xc0) === 0x80) start++;
  const result = new Uint8Array(tail.length - start + addition.length);
  result.set(tail.subarray(start));
  result.set(addition, tail.length - start);
  return result;
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
  observer: JobExecutionObserver = {},
  signal?: AbortSignal,
  runtimeSecrets: RuntimeSecrets = {},
): Promise<boolean> {
  const root = join(record.logPath, "..", "workspace");
  const repositoryPath = join(root, "repository");
  const workspaces = config.jobs.map((_, index) => join(root, `job-${index}`));
  const jobLogs = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  let logHandle: Awaited<ReturnType<typeof open>> | undefined;
  let writes = Promise.resolve();
  const writeLog = (text: string) => {
    writes = writes.then(async () => {
      if (logHandle) await logHandle.appendFile(text);
      else await appendLog(record, text);
    });
    return writes;
  };
  const progressTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const flushProgress = async (job: InformantConfig["jobs"][number]) => {
    const timer = progressTimers.get(job.name);
    if (timer) clearTimeout(timer);
    progressTimers.delete(job.name);
    await notify(() => observer.progress?.(job, decoder.decode(jobLogs.get(job.name))));
  };
  const logJob = async (job: InformantConfig["jobs"][number], text: string) => {
    jobLogs.set(job.name, appendUtf8Tail(jobLogs.get(job.name) ?? new Uint8Array(), text));
    await writeLog(text);
    if (!progressTimers.has(job.name)) {
      progressTimers.set(
        job.name,
        setTimeout(() => void flushProgress(job), 100),
      );
    }
  };
  const notify = async (callback: (() => Promise<void> | void) | undefined) => {
    if (!callback) return;
    try {
      await callback();
    } catch {
      // Check reporting is observational and must not change dependency execution.
    }
  };

  let runFailed = false;
  let runError: unknown;
  let cleanupError: unknown;
  let result: boolean | undefined;
  try {
    signal?.throwIfAborted();
    await mkdir(root, { recursive: true });
    logHandle = await open(record.logPath, "a");
    await writeLog(`$ cloning ${repository.fullName} at ${sha}\n`);
    const image = await ensurePreparedImage(
      config,
      async (message) => {
        await writeLog(`$ ${message}\n`);
      },
      repository.fullName,
      signal,
    );
    await requireCommand(
      ["gh", "repo", "clone", repository.fullName, repositoryPath, "--", "--no-checkout"],
      `could not clone ${repository.fullName}`,
      { signal },
    );
    for (const [index, workspace] of workspaces.entries()) {
      const job = config.jobs[index];
      const checkout = job?.secrets.length
        ? await command(
            ["git", "clone", "--no-local", "--no-checkout", repositoryPath, workspace],
            { timeoutMs: 60_000, signal },
          ).then(async (clone) => {
            if (clone.exitCode !== 0) return clone;
            return command(["git", "checkout", "--detach", sha], {
              cwd: workspace,
              timeoutMs: 60_000,
              signal,
            });
          })
        : await command(["git", "worktree", "add", "--detach", workspace, sha], {
            cwd: repositoryPath,
            timeoutMs: 60_000,
            signal,
          });
      if (checkout.exitCode !== 0) {
        throw new Error(
          `could not check out ${sha}${job ? ` for ${job.name}` : ""}: ${checkout.stderr}`,
        );
      }
    }
    result = await scheduleJobs(
      config.jobs,
      async (job, index) => {
        const workspace = workspaces[index];
        if (!workspace) throw new Error(`workspace missing for job ${job.name}`);
        const success = await runJob(
          `informant-${record.id}-${index}`,
          image,
          repository,
          sha,
          record.branch,
          workspace,
          config,
          job,
          (text) => logJob(job, text),
          () => notify(() => observer.started?.(job)),
          runtimeSecrets,
          signal,
        );
        const outcome = signal?.aborted ? "cancelled" : success ? "success" : "failure";
        await writes;
        await flushProgress(job);
        await notify(() =>
          observer.completed?.(job, {
            outcome,
            log: decoder.decode(jobLogs.get(job.name)),
          }),
        );
        return success;
      },
      async (job) => {
        await logJob(job, `\n━━ ${job.name} ━━\n[skipped: dependency failed]\n`);
        await writes;
        await flushProgress(job);
        await notify(() =>
          observer.completed?.(job, {
            outcome: signal?.aborted ? "cancelled" : "skipped",
            log: decoder.decode(jobLogs.get(job.name)),
          }),
        );
      },
      async (job, error) => {
        const message = error instanceof Error ? error.message : String(error);
        await logJob(
          job,
          signal?.aborted ? `\n[${job.name}: cancelled]\n` : `\n[${job.name}: ${message}]\n`,
        );
        await writes;
        await flushProgress(job);
        await notify(() =>
          observer.completed?.(job, {
            outcome: signal?.aborted ? "cancelled" : "failure",
            log: decoder.decode(jobLogs.get(job.name)),
          }),
        );
      },
    );
  } catch (error) {
    runFailed = true;
    runError = error;
  } finally {
    for (const timer of progressTimers.values()) clearTimeout(timer);
    try {
      await writes;
    } catch (error) {
      cleanupError = error;
    }
    try {
      await logHandle?.close();
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (runFailed) throw runError;
  if (cleanupError !== undefined) throw cleanupError;
  if (result === undefined) throw new Error("job scheduler did not return a result");
  return result;
}
