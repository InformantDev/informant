import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { command, requireCommand } from "../process.ts";
import { dataDirectory } from "../store.ts";
import type { InformantConfig } from "../types.ts";

let vmProvisioning = Promise.resolve();

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export async function provisionVm<T>(
  provision: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
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
    await abortableSleep(1_000, signal);
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
    await abortableSleep(1_000, signal);
  }
  throw new Error("SSH did not become ready within 60 seconds");
}

export function digest(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export async function tartImages(
  signal?: AbortSignal,
): Promise<
  Array<{ Name: string; Source: string; Size?: number; Accessed?: string; Running?: boolean }>
> {
  const output = await requireCommand(["tart", "list", "--format", "json"], undefined, { signal });
  return JSON.parse(output) as Array<{
    Name: string;
    Source: string;
    Size?: number;
    Accessed?: string;
    Running?: boolean;
  }>;
}

export async function startVm(
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
      await abortableSleep(5_000, signal);
    }
  }
}

export async function stopVm(vm: string, process: ReturnType<typeof Bun.spawn>): Promise<void> {
  await command(["tart", "stop", vm], { timeoutMs: 15_000 });
  await Promise.race([process.exited, Bun.sleep(5_000)]);
  if (process.exitCode === null) process.kill("SIGKILL");
  await Promise.race([process.exited, Bun.sleep(5_000)]);
}

export async function waitForCleanShutdown(vm: string, signal?: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    signal?.throwIfAborted();
    const result = await command(["tart", "get", vm, "--format", "json"], { signal });
    if (
      result.exitCode === 0 &&
      (JSON.parse(result.stdout) as { Running?: boolean }).Running === false
    ) {
      return;
    }
    await abortableSleep(1_000, signal);
  }
  throw new Error("prepared VM did not shut down cleanly within 60 seconds");
}

export async function withImageLock<T>(
  image: string,
  callback: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const directory = join(dataDirectory(), "locks");
  const path = join(directory, `${image}.lock`);
  await mkdir(directory, { recursive: true });
  const token = `${process.pid}:${crypto.randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${token}\n`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const observed = await Bun.file(path)
        .text()
        .catch(() => "");
      const owner = Number.parseInt(observed, 10);
      let stale = false;
      if (Number.isSafeInteger(owner) && owner > 0) {
        try {
          process.kill(owner, 0);
        } catch (processError) {
          stale = (processError as NodeJS.ErrnoException).code === "ESRCH";
        }
      } else stale = attempt >= 5;
      if (stale) {
        const reclaimPath = `${path}.reclaim-${digest(observed)}`;
        let reclaim: Awaited<ReturnType<typeof open>> | undefined;
        try {
          reclaim = await open(reclaimPath, "wx", 0o600);
          if (
            (await Bun.file(path)
              .text()
              .catch(() => "")) === observed
          ) {
            await rm(path, { force: true });
          }
        } catch (reclaimError) {
          if ((reclaimError as NodeJS.ErrnoException).code !== "EEXIST") throw reclaimError;
        } finally {
          await reclaim?.close();
          if (reclaim) await rm(reclaimPath, { force: true });
        }
        continue;
      }
    }
    if (attempt >= 600) throw new Error(`timed out waiting for prepared image lock: ${image}`);
    await abortableSleep(1_000, signal);
  }
  try {
    return await callback();
  } finally {
    await handle?.close();
    if (
      (
        await Bun.file(path)
          .text()
          .catch(() => "")
      ).trim() === token
    ) {
      await rm(path, { force: true });
    }
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

export async function sshCommand(
  ip: string,
  config: InformantConfig,
  remote: string,
  timeoutMs: number,
  options: { signal?: AbortSignal; onOutput?: (text: string) => Promise<void> | void } = {},
) {
  const deadline = Date.now() + timeoutMs;
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
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { exitCode: 1, stdout: "", stderr: "", timedOut: true };
    }
    const result = await command(argv, {
      env: { SSHPASS: config.vm.password },
      timeoutMs: remaining,
      signal: options.signal,
      onOutput: options.onOutput,
    });
    if (!isRetryableSshAuthenticationFailure(result) || attempt >= 9) return result;
    await abortableSleep(Math.min(2_000, Math.max(0, deadline - Date.now())), options.signal);
  }
}
