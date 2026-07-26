import { appendFile, chmod, mkdir, open, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { runInContainer } from "../container.ts";
import { command, requireCommand } from "../process.ts";
import { appendLog, claimBuildWorkspace, jobLogPath } from "../store.ts";
import type { BuildRecord, InformantConfig, Repository } from "../types.ts";
import { cacheMounts } from "./cache.ts";
import {
  ensurePreparedImage,
  pruneStoppedJobVms,
  reconcilePreparedImageReferences,
} from "./images.ts";
import {
  bunCopyfileBackend,
  guestSharedRoot,
  linuxSharedMountCommand,
  linuxWorkspaceCopyCommand,
} from "./layout.ts";
import { provisionVm, shellQuote, sshCommand, startVm, stopVm, withImageLock } from "./vm.ts";

export { cachePathIdentity } from "./cache.ts";
export {
  ensurePreparedImage,
  listPreparedImages,
  preparedImageName,
  prunePreparedImages,
  pruneStoppedJobVms,
  reconcilePreparedImageReferences,
} from "./images.ts";
export { isRetryableSshAuthenticationFailure } from "./vm.ts";

export type RuntimeSecrets = Record<string, string | (() => Promise<string>)>;

let staleVmCleanup: Promise<number> | undefined;

async function cleanStaleVms(): Promise<void> {
  staleVmCleanup ??= pruneStoppedJobVms().catch((error) => {
    staleVmCleanup = undefined;
    throw error;
  });
  await staleVmCleanup;
}

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

export async function secretMount(
  workspace: string,
  job: InformantConfig["jobs"][number],
  runtimeSecrets: RuntimeSecrets,
  guestOs: InformantConfig["vm"]["guestOs"] = "macos",
  operations: {
    write?: typeof Bun.write;
    realpath?: typeof realpath;
  } = {},
): Promise<{ args: string[]; source: string; values: string[]; directory?: string }> {
  const secrets = await resolveJobSecrets(job, runtimeSecrets);
  if (Object.keys(secrets).length === 0) return { args: [], source: "", values: [] };
  const directory = join(workspace, "..", `secrets-${crypto.randomUUID().slice(0, 8)}`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "environment");
    await (operations.write ?? Bun.write)(
      path,
      `${Object.entries(secrets)
        .map(([name, value]) => `export ${name}=${shellQuote(value)}`)
        .join("\n")}\n`,
    );
    await chmod(path, 0o600);
    return {
      args: [`--dir=secrets:${await (operations.realpath ?? realpath)(directory)}`],
      source: `. ${shellQuote(`${guestSharedRoot(guestOs)}/secrets/environment`)} || exit; rm -f ${shellQuote(`${guestSharedRoot(guestOs)}/secrets/environment`)} || exit;`,
      values: Object.values(secrets).filter((value) => value.length > 0),
      directory,
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export function streamingSecretRedactor(
  secrets: string[],
  output: (text: string) => Promise<void>,
): { write: (text: string) => Promise<void>; flush: () => Promise<void> } {
  const values = [...new Set(secrets.filter((value) => value.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
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

export async function checkoutBuildWorkspace(
  repositoryPath: string,
  workspace: string,
  sha: string,
  isolated: boolean,
  signal?: AbortSignal,
) {
  if (!isolated) {
    return command(["git", "worktree", "add", "--detach", workspace, sha], {
      cwd: repositoryPath,
      timeoutMs: 60_000,
      signal,
    });
  }
  const clone = await command(
    ["git", "clone", "--no-local", "--no-checkout", repositoryPath, workspace],
    { timeoutMs: 60_000, signal },
  );
  if (clone.exitCode !== 0) return clone;
  const fetch = await command(["git", "fetch", "--no-tags", repositoryPath, sha], {
    cwd: workspace,
    timeoutMs: 60_000,
    signal,
  });
  if (fetch.exitCode !== 0) return fetch;
  return command(["git", "checkout", "--detach", sha], {
    cwd: workspace,
    timeoutMs: 60_000,
    signal,
  });
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
  runtimeSecrets: RuntimeSecrets,
  signal?: AbortSignal,
): Promise<{ success: boolean; exitCode: number; timedOut: boolean }> {
  const timeoutMs = job.timeoutMinutes * 60_000;
  const deadline = new AbortController();
  const timeout = setTimeout(
    () => deadline.abort(new Error(`${job.name} timed out after ${job.timeoutMinutes} minutes`)),
    timeoutMs,
  );
  const executionSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  let vmCreated = false;
  let tart: ReturnType<typeof Bun.spawn> | undefined;
  let secretDirectory: string | undefined;

  try {
    executionSignal.throwIfAborted();
    const ready = await provisionVm(async () => {
      executionSignal.throwIfAborted();
      await log(`\n━━ ${job.name} ━━\n$ tart clone ${image} ${vm}\n`);
      vmCreated = true;
      const clone = () =>
        requireCommand(["tart", "clone", image, vm], undefined, { signal: executionSignal });
      if (image.startsWith("informant-prepared-"))
        await withImageLock(image, clone, executionSignal);
      else await clone();
      if (config.vm.cpu || config.vm.memoryMb) {
        const args = ["tart", "set", vm];
        if (config.vm.cpu) args.push("--cpu", String(config.vm.cpu));
        if (config.vm.memoryMb) args.push("--memory", String(config.vm.memoryMb));
        await requireCommand(args, undefined, { signal: executionSignal });
      }

      const sharedWorkspace = await realpath(workspace);
      const caches = await cacheMounts(
        repository,
        workspace,
        job,
        config.vm.user,
        config.vm.guestOs,
        config.trustedSha === sha,
      );
      if (config.vm.guestOs === "linux") {
        await requireCommand(
          ["chmod", "a+rwx", sharedWorkspace],
          "could not make the Linux workspace writable",
          { signal: executionSignal },
        );
        if (caches.writablePaths.length > 0) {
          await requireCommand(
            ["chmod", "a+rwx", ...caches.writablePaths],
            "could not make Linux caches writable",
            { signal: executionSignal },
          );
        }
      }
      const secrets = await secretMount(workspace, job, runtimeSecrets, config.vm.guestOs);
      secretDirectory = secrets.directory;
      const started = await startVm(
        vm,
        [`--dir=workspace:${sharedWorkspace}`, ...caches.args, ...secrets.args],
        config,
        job.timeoutMinutes,
        async () => {
          await log(`[${job.name}] waiting for an available Tart VM slot\n`);
        },
        executionSignal,
      );
      tart = started.process;
      if (config.vm.guestOs === "linux") {
        const setup = await sshCommand(started.ip, config, linuxSharedMountCommand(), 60_000, {
          signal: executionSignal,
        });
        if (setup.exitCode !== 0 || setup.timedOut) {
          throw new Error(
            setup.timedOut
              ? "timed out mounting Tart Linux shared directories"
              : `could not mount Tart Linux shared directories: ${setup.stderr.trim() || `exit ${setup.exitCode}`}`,
          );
        }
      }
      return {
        ip: started.ip,
        cacheRestore: caches.restore,
        cacheSave: caches.save,
        installLock: caches.installLock,
        secretSource: secrets.source,
        secretValues: secrets.values,
      };
    }, executionSignal);
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
    const runtimeSetup = bunCopyfileBackend(ready.installLock);
    const mountedWorkspace = `${guestSharedRoot(config.vm.guestOs)}/workspace`;
    const jobWorkspace =
      config.vm.guestOs === "linux" ? "/tmp/informant-workspace" : mountedWorkspace;
    const workspaceSetup =
      config.vm.guestOs === "linux" ? `${linuxWorkspaceCopyCommand(jobWorkspace)} && ` : "";
    const execute = `${workspaceSetup}cd ${shellQuote(jobWorkspace)} && /bin/bash -lc ${shellQuote(`${env} ${ready.secretSource} ${runtimeSetup} ${job.command}`)}`;
    const jobCommand = ready.cacheRestore
      ? `${ready.cacheRestore} && ${execute}; informant_job_status=$?; ${ready.cacheSave}; informant_cache_status=$?; if [ $informant_job_status -ne 0 ]; then exit $informant_job_status; fi; exit $informant_cache_status`
      : execute;
    const redactor = streamingSecretRedactor(ready.secretValues, log);
    const result = await sshCommand(ready.ip, config, jobCommand, timeoutMs, {
      signal: executionSignal,
      onOutput: redactor.write,
    });
    await redactor.flush();
    return {
      success: result.exitCode === 0 && !result.timedOut,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    };
  } catch (error) {
    if (deadline.signal.aborted && !signal?.aborted) throw deadline.signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
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

export function jobEventLine(
  name: string,
  event: "started" | "skipped (dependency failed)" | `finished (${JobOutcome})`,
  at = new Date(),
  detail?: string,
): string {
  const rendered =
    detail && event.startsWith("finished (") ? `${event.slice(0, -1)}, ${detail})` : event;
  return `[${at.toISOString()}] [${name}] ${rendered}\n`;
}

export async function writeWithBestEffortDuplicate(
  primary: (text: string) => Promise<void>,
  duplicate: (text: string) => Promise<void>,
  text: string,
): Promise<void> {
  await Promise.all([primary(text), duplicate(text).catch(() => undefined)]);
}

export interface JobExecutionObserver {
  started?: (job: InformantConfig["jobs"][number]) => Promise<void> | void;
  progress?: (job: InformantConfig["jobs"][number], log: string) => Promise<void> | void;
  completed?: (
    job: InformantConfig["jobs"][number],
    result: { outcome: JobOutcome; log: string },
  ) => Promise<void> | void;
}

const JOB_LOG_BYTES = 55_000;
const BUILD_LOG_BYTES = 10 * 1024 * 1024;
export const BUILD_LOG_TRUNCATION_MARKER = "\n[informant: build log truncated at 10 MiB]\n";

export function boundedLogWriter(
  output: (text: string) => Promise<void>,
  maximumBytes = BUILD_LOG_BYTES,
  marker = BUILD_LOG_TRUNCATION_MARKER,
): (text: string) => Promise<void> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const markerBytes = encoder.encode(marker);
  if (markerBytes.length > maximumBytes) throw new Error("log truncation marker exceeds quota");
  let writtenBytes = 0;
  let truncated = false;
  let writes = Promise.resolve();
  return (text) => {
    writes = writes.then(async () => {
      if (truncated) return;
      const bytes = encoder.encode(text);
      const contentLimit = maximumBytes - markerBytes.length;
      if (writtenBytes + bytes.length <= contentLimit) {
        writtenBytes += bytes.length;
        await output(text);
        return;
      }
      let length = Math.max(0, contentLimit - writtenBytes);
      while (length > 0 && length < bytes.length && ((bytes[length] ?? 0) & 0xc0) === 0x80)
        length--;
      if (length > 0) await output(decoder.decode(bytes.subarray(0, length)));
      await output(marker);
      writtenBytes += length + markerBytes.length;
      truncated = true;
    });
    return writes;
  };
}

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
  configuredVmJobs = config.jobs
    .filter((job) => job.runtime?.type !== "container")
    .map((job) => job.name),
): Promise<boolean> {
  await reconcilePreparedImageReferences(repository.fullName, configuredVmJobs, signal);
  if (config.jobs.some((job) => job.runtime?.type !== "container")) await cleanStaleVms();
  const root = join(record.logPath, "..", "workspace");
  const repositoryPath = join(root, "repository");
  const workspaces = config.jobs.map((_, index) => join(root, `job-${index}`));
  const jobLogs = new Map<string, Uint8Array>();
  const jobLogWriters = new Map<string, ReturnType<typeof boundedLogWriter>>();
  const decoder = new TextDecoder();
  let logHandle: Awaited<ReturnType<typeof open>> | undefined;
  let writes = Promise.resolve();
  const writeLog = boundedLogWriter((text) => {
    writes = writes.then(async () => {
      if (logHandle) await logHandle.appendFile(text);
      else await appendLog(record, text);
    });
    return writes;
  });
  const progressTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const flushProgress = async (job: InformantConfig["jobs"][number]) => {
    const timer = progressTimers.get(job.name);
    if (timer) clearTimeout(timer);
    progressTimers.delete(job.name);
    await notify(() => observer.progress?.(job, decoder.decode(jobLogs.get(job.name))));
  };
  const logJob = async (job: InformantConfig["jobs"][number], text: string) => {
    jobLogs.set(job.name, appendUtf8Tail(jobLogs.get(job.name) ?? new Uint8Array(), text));
    let writeJobLog = jobLogWriters.get(job.name);
    if (!writeJobLog) {
      writeJobLog = boundedLogWriter((value) => appendFile(jobLogPath(record, job.name), value));
      jobLogWriters.set(job.name, writeJobLog);
    }
    await writeWithBestEffortDuplicate(writeLog, writeJobLog, text);
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
    await claimBuildWorkspace(root);
    await mkdir(join(record.logPath, "..", "jobs"), { recursive: true });
    logHandle = await open(record.logPath, "a");
    await writeLog(`$ cloning ${repository.fullName} at ${sha}\n`);
    await requireCommand(
      ["gh", "repo", "clone", repository.fullName, repositoryPath, "--", "--no-checkout"],
      `could not clone ${repository.fullName}`,
      { signal },
    );
    for (const [index, workspace] of workspaces.entries()) {
      const job = config.jobs[index];
      const checkout = await checkoutBuildWorkspace(
        repositoryPath,
        workspace,
        sha,
        Boolean(job?.secrets.length),
        signal,
      );
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
        await logJob(job, jobEventLine(job.name, "started"));
        await notify(() => observer.started?.(job));
        const runtime = job.runtime ?? config.vm;
        const execution =
          runtime.type === "container"
            ? await runInContainer(
                repository,
                sha,
                record.branch,
                config.trustedSha ?? sha,
                config.trustedSha === sha,
                workspace,
                job,
                (text) => logJob(job, text),
                async () => {},
                runtimeSecrets,
                signal,
              )
            : await runJob(
                `informant-${record.id}-${index}`,
                await ensurePreparedImage(
                  { ...config, vm: runtime },
                  async (message) => writeLog(`$ ${message}\n`),
                  `${repository.fullName}\0${job.name}`,
                  signal,
                ),
                repository,
                sha,
                record.branch,
                workspace,
                { ...config, vm: runtime },
                job,
                (text) => logJob(job, text),
                runtimeSecrets,
                signal,
              );
        const outcome = signal?.aborted ? "cancelled" : execution.success ? "success" : "failure";
        const detail = execution.timedOut
          ? `exit ${execution.exitCode}, timed out after ${job.timeoutMinutes}m`
          : `exit ${execution.exitCode}`;
        await logJob(job, jobEventLine(job.name, `finished (${outcome})`, new Date(), detail));
        await writes;
        await flushProgress(job);
        await notify(() =>
          observer.completed?.(job, {
            outcome,
            log: decoder.decode(jobLogs.get(job.name)),
          }),
        );
        return execution.success;
      },
      async (job) => {
        await logJob(
          job,
          `\n━━ ${job.name} ━━\n${jobEventLine(job.name, signal?.aborted ? "finished (cancelled)" : "skipped (dependency failed)")}`,
        );
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
        const outcome = signal?.aborted ? "cancelled" : "failure";
        await logJob(
          job,
          `${signal?.aborted ? `\n[${job.name}: cancelled]\n` : `\n[${job.name}: ${message}]\n`}${jobEventLine(job.name, `finished (${outcome})`)}`,
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
    // Large node_modules trees can take minutes to unlink; that housekeeping must not hold CI open.
    void rm(root, { recursive: true, force: true }).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      await appendLog(record, `\n[workspace cleanup: ${message}]\n`).catch(() => {});
    });
  }
  if (runFailed) throw runError;
  if (cleanupError !== undefined) throw cleanupError;
  if (result === undefined) throw new Error("job scheduler did not return a result");
  return result;
}
