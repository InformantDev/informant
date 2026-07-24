import { mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { command, requireCommand } from "./process.ts";
import { appendLog, dataDirectory } from "./store.ts";
import type { BuildRecord, InformantConfig, Repository } from "./types.ts";

let vmProvisioning = Promise.resolve();

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function provisionVm<T>(provision: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let started = false;
  const run = () => {
    started = true;
    signal?.throwIfAborted();
    return provision();
  };
  const result = vmProvisioning.then(run, run);
  vmProvisioning = result.then(
    () => undefined,
    () => undefined,
  );
  if (!signal) return result;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      if (started) return;
      try {
        signal.throwIfAborted();
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    result.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

async function exitedVmError(
  process: ReturnType<typeof Bun.spawn>,
  stderr: Promise<string>,
): Promise<Error | undefined> {
  if (process.exitCode === null) return undefined;
  const detail = (await stderr).trim();
  return new Error(
    `Tart VM exited before becoming ready with status ${process.exitCode}${detail ? `: ${detail}` : ""}`,
  );
}

async function waitForIp(
  vm: string,
  process: ReturnType<typeof Bun.spawn>,
  stderr: Promise<string>,
  signal?: AbortSignal,
): Promise<string> {
  for (let attempt = 0; attempt < 60; attempt++) {
    signal?.throwIfAborted();
    const exitError = await exitedVmError(process, stderr);
    if (exitError) throw exitError;
    const result = await command(["tart", "ip", vm], { signal });
    if (result.exitCode === 0 && result.stdout.trim()) return result.stdout.trim();
    await Bun.sleep(1_000);
  }
  throw new Error("Tart VM did not acquire an IP address within 60 seconds");
}

async function waitForSsh(
  ip: string,
  user: string,
  password: string,
  process: ReturnType<typeof Bun.spawn>,
  stderr: Promise<string>,
  signal?: AbortSignal,
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    signal?.throwIfAborted();
    const exitError = await exitedVmError(process, stderr);
    if (exitError) throw exitError;
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
        "-o",
        "PreferredAuthentications=password",
        "-o",
        "PubkeyAuthentication=no",
        "-o",
        "NumberOfPasswordPrompts=1",
        `${user}@${ip}`,
        "true",
      ],
      { env: { SSHPASS: password }, signal },
    );
    if (result.exitCode === 0) return;
    await Bun.sleep(1_000);
  }
  throw new Error("SSH did not become ready within 60 seconds");
}

function digest(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

async function tartImages(
  signal?: AbortSignal,
): Promise<Array<{ Name: string; Source: string; Accessed?: string }>> {
  const output = await requireCommand(["tart", "list", "--format", "json"], undefined, { signal });
  return JSON.parse(output) as Array<{ Name: string; Source: string; Accessed?: string }>;
}

async function startVm(
  vm: string,
  args: string[],
  config: InformantConfig,
  timeoutMinutes: number,
  onCapacity: () => Promise<void>,
  signal?: AbortSignal,
): Promise<{ process: ReturnType<typeof Bun.spawn>; ip: string }> {
  const capacityDeadline = Date.now() + timeoutMinutes * 60_000;
  let waitingForCapacity = false;
  while (true) {
    signal?.throwIfAborted();
    const process = Bun.spawn(["tart", "run", "--no-graphics", ...args, vm], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const stderr =
      process.stderr instanceof ReadableStream
        ? new Response(process.stderr).text()
        : Promise.resolve("");
    try {
      const ip = await waitForIp(vm, process, stderr, signal);
      await waitForSsh(ip, config.vm.user, config.vm.password, process, stderr, signal);
      return { process, ip };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("The number of VMs exceeds the system limit")) {
        await stopVm(vm, process);
        throw error;
      }
      if (!waitingForCapacity) {
        await onCapacity();
        waitingForCapacity = true;
      }
      if (Date.now() >= capacityDeadline) {
        throw new Error(
          `Tart VM capacity was unavailable for ${timeoutMinutes} minutes: ${message}`,
        );
      }
      await Bun.sleep(5_000);
    }
  }
}

async function stopVm(vm: string, process: ReturnType<typeof Bun.spawn>): Promise<void> {
  await command(["tart", "stop", vm], { timeoutMs: 15_000 });
  await Promise.race([process.exited, Bun.sleep(5_000)]);
  if (process.exitCode === null) process.kill("SIGKILL");
  await Promise.race([process.exited, Bun.sleep(5_000)]);
}

async function waitForCleanShutdown(vm: string, signal?: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    signal?.throwIfAborted();
    const result = await command(["tart", "get", vm, "--format", "json"], { signal });
    if (
      result.exitCode === 0 &&
      (JSON.parse(result.stdout) as { Running?: boolean }).Running === false
    ) {
      return;
    }
    await Bun.sleep(1_000);
  }
  throw new Error("prepared VM did not shut down cleanly within 60 seconds");
}

async function withImageLock<T>(
  image: string,
  callback: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const directory = join(dataDirectory(), "locks");
  const path = join(directory, `${image}.lock`);
  await mkdir(directory, { recursive: true });
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const lock = await command(["shlock", "-f", path, "-p", String(process.pid)], { signal });
    if (lock.exitCode === 0) break;
    if (attempt >= 600) throw new Error(`timed out waiting for prepared image lock: ${image}`);
    await Bun.sleep(1_000);
  }
  try {
    return await callback();
  } finally {
    await rm(path, { force: true });
  }
}

export function isRetryableSshAuthenticationFailure(result: {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}): boolean {
  return (
    result.exitCode === 255 &&
    !result.timedOut &&
    result.stdout.length === 0 &&
    result.stderr.includes("Permission denied")
  );
}

async function sshCommand(
  ip: string,
  config: InformantConfig,
  remote: string,
  timeoutMs: number,
  options: { signal?: AbortSignal; onOutput?: (text: string) => Promise<void> | void } = {},
) {
  const argv = [
    "sshpass",
    "-e",
    "ssh",
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "PreferredAuthentications=password",
    "-o",
    "PubkeyAuthentication=no",
    "-o",
    "NumberOfPasswordPrompts=1",
    `${config.vm.user}@${ip}`,
    remote,
  ];
  for (let attempt = 0; ; attempt++) {
    const result = await command(argv, {
      env: { SSHPASS: config.vm.password },
      timeoutMs,
      signal: options.signal,
      onOutput: options.onOutput,
    });
    if (!isRetryableSshAuthenticationFailure(result) || attempt >= 9) return result;
    await Bun.sleep(2_000);
  }
}

export function preparedImageName(config: InformantConfig): string | undefined {
  return config.vm.prepare
    ? `informant-prepared-${digest(`${config.vm.image}\0${config.vm.user}\0${config.vm.prepare}`).slice(0, 16)}`
    : undefined;
}

async function activatePreparedImageLocked(
  repository: string | undefined,
  prepared: string | undefined,
  onMessage: (message: string) => Promise<void> | void,
  signal?: AbortSignal,
): Promise<void> {
  if (!repository) return;
  const directory = join(dataDirectory(), "prepared-image-references");
  const path = join(directory, digest(repository));
  const previous = (await readFile(path, "utf8").catch(() => "")).trim() || undefined;
  if (previous === prepared) return;

  if (previous) {
    const cleanup = await withImageLock(
      previous,
      async () => {
        const references = await readdir(directory).catch(() => []);
        const values = await Promise.all(
          references
            .filter((entry) => join(directory, entry) !== path)
            .map((entry) => readFile(join(directory, entry), "utf8").catch(() => "")),
        );
        if (values.some((value) => value.trim() === previous)) return "retained";
        if (!(await listPreparedImages(signal)).includes(previous)) return "missing";
        const result = await command(["tart", "delete", previous], { timeoutMs: 30_000 });
        return result.exitCode === 0 ? "deleted" : "failed";
      },
      signal,
    );
    if (cleanup === "failed") {
      await onMessage(`Could not delete superseded Tart image ${previous}; will retry later`);
      return;
    }
    if (cleanup === "deleted") await onMessage(`Deleted superseded Tart image ${previous}`);
  }

  await mkdir(directory, { recursive: true });
  if (prepared) await Bun.write(path, `${prepared}\n`);
  else await rm(path, { force: true });
}

async function withPreparedImageReferencesLock<T>(
  callback: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return withImageLock("prepared-image-references", callback, signal);
}

async function activatePreparedImage(
  repository: string | undefined,
  prepared: string | undefined,
  onMessage: (message: string) => Promise<void> | void,
  signal?: AbortSignal,
): Promise<void> {
  await withPreparedImageReferencesLock(
    () => activatePreparedImageLocked(repository, prepared, onMessage, signal),
    signal,
  );
}

async function preparedImageReferences(): Promise<Set<string>> {
  const directory = join(dataDirectory(), "prepared-image-references");
  const references = await readdir(directory).catch(() => []);
  const values = await Promise.all(
    references.map((entry) => readFile(join(directory, entry), "utf8").catch(() => "")),
  );
  return new Set(values.map((value) => value.trim()).filter(Boolean));
}

export async function ensurePreparedImage(
  config: InformantConfig,
  onMessage: (message: string) => Promise<void> | void = console.log,
  repository?: string,
  signal?: AbortSignal,
): Promise<string> {
  const prepared = preparedImageName(config);
  if (!prepared) {
    await activatePreparedImage(repository, undefined, onMessage, signal);
    return config.vm.image;
  }
  if (
    (await tartImages(signal)).some((image) => image.Source === "local" && image.Name === prepared)
  ) {
    await activatePreparedImage(repository, prepared, onMessage, signal);
    return prepared;
  }

  const image = await provisionVm(async () => {
    if (
      (await tartImages(signal)).some(
        (image) => image.Source === "local" && image.Name === prepared,
      )
    ) {
      return prepared;
    }
    await onMessage(`Preparing Tart image ${prepared}`);
    const staging = `${prepared}-staging-${crypto.randomUUID().slice(0, 8)}`;
    let process: ReturnType<typeof Bun.spawn> | undefined;
    try {
      await requireCommand(["tart", "clone", config.vm.image, staging], undefined, { signal });
      const ready = await startVm(
        staging,
        [],
        config,
        30,
        async () => {
          await onMessage("Waiting for an available Tart VM slot to prepare the image");
        },
        signal,
      );
      process = ready.process;
      const result = await sshCommand(
        ready.ip,
        config,
        `/bin/bash -lc ${shellQuote(config.vm.prepare ?? "")}`,
        30 * 60_000,
        { signal },
      );
      if (result.exitCode !== 0 || result.timedOut) {
        throw new Error(`image preparation failed: ${result.stdout}${result.stderr}`.trim());
      }
      await sshCommand(ready.ip, config, "sudo shutdown -h now", 60_000, { signal });
      await waitForCleanShutdown(staging, signal);
      await stopVm(staging, process);
      return withPreparedImageReferencesLock(
        () =>
          withImageLock(
            prepared,
            async () => {
              if (
                (await tartImages(signal)).some(
                  (image) => image.Source === "local" && image.Name === prepared,
                )
              ) {
                await requireCommand(["tart", "delete", staging]);
              } else {
                await requireCommand(
                  ["tart", "rename", staging, prepared],
                  "could not publish prepared image",
                );
              }
              await activatePreparedImageLocked(repository, prepared, onMessage, signal);
              return prepared;
            },
            signal,
          ),
        signal,
      );
    } catch (error) {
      if (process) await stopVm(staging, process);
      await command(["tart", "delete", staging], { timeoutMs: 30_000 });
      throw error;
    }
  }, signal);
  await activatePreparedImage(repository, image, onMessage, signal);
  return image;
}

export async function listPreparedImages(signal?: AbortSignal): Promise<string[]> {
  return (await tartImages(signal))
    .filter(
      (image) => image.Source === "local" && /^informant-prepared-[0-9a-f]{16}$/.test(image.Name),
    )
    .map((image) => image.Name);
}

export async function prunePreparedImages(): Promise<number> {
  return withPreparedImageReferencesLock(async () => {
    const referenced = await preparedImageReferences();
    const images = (await listPreparedImages()).filter((image) => !referenced.has(image));
    for (const image of images) {
      await withImageLock(image, async () => requireCommand(["tart", "delete", image]));
    }
    return images.length;
  });
}

export function cachePathIdentity(user: string, path: string): string {
  return digest(`${user}\0${path}`).slice(0, 16);
}

async function cacheMounts(
  repository: Repository,
  workspace: string,
  job: InformantConfig["jobs"][number],
  user: string,
) {
  if (!job.cache) return { args: [] as string[], restore: "", save: "" };
  const workspaceRoot = await realpath(workspace);
  const root = join(
    dataDirectory(),
    "caches",
    digest(repository.fullName).slice(0, 16),
    digest(job.name).slice(0, 16),
  );
  const args: string[] = [];
  const restore: string[] = [];
  const save: string[] = [];
  let mountIndex = 0;
  for (const cache of job.cache) {
    const key = new Bun.CryptoHasher("sha256");
    for (const keyFile of cache.keyFiles) {
      key.update(keyFile).update("\0");
      let resolved: string;
      try {
        resolved = await realpath(join(workspaceRoot, keyFile));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          key.update("missing").update("\0");
          continue;
        }
        throw error;
      }
      const location = relative(workspaceRoot, resolved);
      if (location.startsWith("..") || location.startsWith("/")) {
        throw new Error(`cache key file escapes the workspace: ${keyFile}`);
      }
      const metadata = await stat(resolved);
      if (!metadata.isFile() || metadata.size > 16 * 1024 * 1024) {
        throw new Error(`cache key file must be a regular file no larger than 16 MiB: ${keyFile}`);
      }
      key.update(await readFile(resolved));
      key.update("\0");
    }
    const cacheKey = cache.keyFiles.length > 0 ? key.digest("hex").slice(0, 24) : "default";
    for (const path of cache.paths) {
      const host = join(root, cachePathIdentity(user, path), cacheKey);
      await mkdir(host, { recursive: true });
      args.push(`--dir=cache-${mountIndex}:${await realpath(host)}`);
      const guest = `/Users/${user}/${path.slice(2)}`;
      const shared = `/Volumes/My Shared Files/cache-${mountIndex}`;
      const temporary = `${shared}/cache-${crypto.randomUUID().slice(0, 8)}.tmp`;
      restore.push(
        `mkdir -p ${shellQuote(guest)} && if [ -f ${shellQuote(`${shared}/cache.tar`)} ]; then tar -xpf ${shellQuote(`${shared}/cache.tar`)} -C ${shellQuote(guest)}; fi`,
      );
      save.push(
        `tar -cpf ${shellQuote(temporary)} -C ${shellQuote(guest)} . && mv -f ${shellQuote(temporary)} ${shellQuote(`${shared}/cache.tar`)}`,
      );
      mountIndex++;
    }
  }
  return { args, restore: restore.join(" && "), save: save.join(" && ") };
}

async function runJob(
  vm: string,
  image: string,
  repository: Repository,
  workspace: string,
  config: InformantConfig,
  job: InformantConfig["jobs"][number],
  log: (text: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<boolean> {
  let vmCreated = false;
  let tart: ReturnType<typeof Bun.spawn> | undefined;

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
      const caches = await cacheMounts(repository, workspace, job, config.vm.user);
      const started = await startVm(
        vm,
        [`--dir=workspace:${sharedWorkspace}`, ...caches.args],
        config,
        job.timeoutMinutes,
        async () => {
          await log(`[${job.name}] waiting for an available Tart VM slot\n`);
        },
        signal,
      );
      tart = started.process;
      return { ip: started.ip, cacheRestore: caches.restore, cacheSave: caches.save };
    }, signal);
    await log(`[${job.name}] $ ${job.command}\n`);
    const env = Object.entries(job.environment)
      .map(([key, value]) => `export ${key}=${shellQuote(value)};`)
      .join(" ");
    const execute = `cd ${shellQuote("/Volumes/My Shared Files/workspace")} && /bin/bash -lc ${shellQuote(`${env} ${job.command}`)}`;
    const jobCommand = ready.cacheRestore
      ? `${ready.cacheRestore} && ${execute}; informant_job_status=$?; ${ready.cacheSave}; informant_cache_status=$?; if [ $informant_job_status -ne 0 ]; then exit $informant_job_status; fi; exit $informant_cache_status`
      : execute;
    const result = await sshCommand(ready.ip, config, jobCommand, job.timeoutMinutes * 60_000, {
      signal,
      onOutput: log,
    });
    let output = `\n[${job.name}: exit ${result.exitCode}]\n`;
    if (result.timedOut) output += `[${job.name}: timed out after ${job.timeoutMinutes}m]\n`;
    await log(output);
    return result.exitCode === 0 && !result.timedOut;
  } finally {
    if (tart) await stopVm(vm, tart);
    if (vmCreated) {
      const deleted = await command(["tart", "delete", vm], { timeoutMs: 30_000 });
      if (deleted.exitCode !== 0) {
        await log(`[${job.name}] could not delete Tart VM ${vm}: ${deleted.stderr}\n`);
      }
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
): Promise<boolean> {
  const root = join(record.logPath, "..", "workspace");
  const repositoryPath = join(root, "repository");
  const workspaces = config.jobs.map((_, index) => join(root, `job-${index}`));
  const jobLogs = new Map<string, string>();
  const logJob = async (job: InformantConfig["jobs"][number], text: string) => {
    jobLogs.set(job.name, utf8Tail(`${jobLogs.get(job.name) ?? ""}${text}`));
    await appendLog(record, text);
    await notify(() => observer.progress?.(job, jobLogs.get(job.name) ?? ""));
  };
  const notify = async (callback: (() => Promise<void> | void) | undefined) => {
    if (!callback) return;
    try {
      await callback();
    } catch {
      // Check reporting is observational and must not change dependency execution.
    }
  };

  try {
    signal?.throwIfAborted();
    await mkdir(root, { recursive: true });
    await appendLog(record, `$ cloning ${repository.fullName} at ${sha}\n`);
    const image = await ensurePreparedImage(
      config,
      async (message) => {
        await appendLog(record, `$ ${message}\n`);
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
      const checkout = await command(["git", "worktree", "add", "--detach", workspace, sha], {
        cwd: repositoryPath,
        timeoutMs: 60_000,
        signal,
      });
      if (checkout.exitCode !== 0) {
        const job = config.jobs[index];
        throw new Error(
          `could not check out ${sha}${job ? ` for ${job.name}` : ""}: ${checkout.stderr}`,
        );
      }
    }
    return await scheduleJobs(
      config.jobs,
      async (job, index) => {
        await notify(() => observer.started?.(job));
        const workspace = workspaces[index];
        if (!workspace) throw new Error(`workspace missing for job ${job.name}`);
        const success = await runJob(
          `informant-${record.id}-${index}`,
          image,
          repository,
          workspace,
          config,
          job,
          (text) => logJob(job, text),
          signal,
        );
        const outcome = signal?.aborted ? "cancelled" : success ? "success" : "failure";
        await notify(() =>
          observer.completed?.(job, {
            outcome,
            log: jobLogs.get(job.name) ?? "",
          }),
        );
        return success;
      },
      async (job) => {
        await logJob(job, `\n━━ ${job.name} ━━\n[skipped: dependency failed]\n`);
        await notify(() =>
          observer.completed?.(job, {
            outcome: signal?.aborted ? "cancelled" : "skipped",
            log: jobLogs.get(job.name) ?? "",
          }),
        );
      },
      async (job, error) => {
        const message = error instanceof Error ? error.message : String(error);
        await logJob(
          job,
          signal?.aborted ? `\n[${job.name}: cancelled]\n` : `\n[${job.name}: ${message}]\n`,
        );
        await notify(() =>
          observer.completed?.(job, {
            outcome: signal?.aborted ? "cancelled" : "failure",
            log: jobLogs.get(job.name) ?? "",
          }),
        );
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
