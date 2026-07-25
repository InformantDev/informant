import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { command, requireCommand } from "../process.ts";
import { dataDirectory } from "../store.ts";
import type { InformantConfig } from "../types.ts";

let vmProvisioning = Promise.resolve();

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

export function digest(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export async function tartImages(
  signal?: AbortSignal,
): Promise<Array<{ Name: string; Source: string; Accessed?: string; Running?: boolean }>> {
  const output = await requireCommand(["tart", "list", "--format", "json"], undefined, { signal });
  return JSON.parse(output) as Array<{
    Name: string;
    Source: string;
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
      await Bun.sleep(5_000);
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
    await Bun.sleep(1_000);
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

export async function sshCommand(
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
