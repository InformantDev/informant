export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  killProcessGroup?: boolean;
  onOutput?: (text: string) => Promise<void> | void;
}

const MAX_CAPTURE_CHARS = 1024 * 1024;

async function captureTail(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onOutput?: (text: string) => Promise<void> | void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  const abort = () => void reader.cancel();
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      tail += text;
      if (tail.length > MAX_CAPTURE_CHARS) tail = tail.slice(-MAX_CAPTURE_CHARS);
      await onOutput?.(text);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
  tail += decoder.decode();
  return tail.length > MAX_CAPTURE_CHARS ? tail.slice(-MAX_CAPTURE_CHARS) : tail;
}

export async function command(
  argv: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  options.signal?.throwIfAborted();
  const spawned = (() => {
    try {
      return Bun.spawn(argv, {
        cwd: options.cwd,
        env: { ...(options.inheritEnv === false ? {} : Bun.env), ...options.env },
        stdout: "pipe",
        stderr: "pipe",
        detached: options.killProcessGroup === true && process.platform !== "win32",
      });
    } catch {
      return undefined;
    }
  })();
  if (!spawned) {
    const error = `could not start command: ${argv[0] ?? "unknown"}`;
    return { exitCode: 127, stdout: "", stderr: String(error), timedOut: false };
  }
  const child = spawned;
  const processGroup =
    options.killProcessGroup === true && process.platform !== "win32" && child.pid > 0;
  let timedOut = false;
  let stopping = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let groupTermination: Promise<void> | undefined;
  const captureController = new AbortController();
  const kill = (signal: NodeJS.Signals) => {
    if (processGroup) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      }
    }
    child.kill(signal);
  };
  const groupIsAlive = () => {
    if (!processGroup) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    kill("SIGTERM");
    if (processGroup) {
      groupTermination ??= new Promise<void>((resolve) => {
        const deadline = Date.now() + 2_000;
        const check = () => {
          if (!groupIsAlive()) {
            resolve();
            return;
          }
          if (Date.now() >= deadline) {
            kill("SIGKILL");
            captureController.abort();
            resolve();
            return;
          }
          killTimer = setTimeout(check, 25);
        };
        killTimer = setTimeout(check, 25);
      });
      return;
    }
    killTimer ??= setTimeout(() => {
      kill("SIGKILL");
      captureController.abort();
    }, 2_000);
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        stop();
      }, options.timeoutMs)
    : undefined;
  const stdout = captureTail(child.stdout, captureController.signal, options.onOutput);
  const stderr = captureTail(child.stderr, captureController.signal, options.onOutput);
  try {
    const [capturedStdout, capturedStderr, exitCode] = await Promise.all([
      stdout,
      stderr,
      child.exited,
    ]);
    if (groupTermination) await groupTermination;
    options.signal?.throwIfAborted();
    return { stdout: capturedStdout, stderr: capturedStderr, exitCode, timedOut };
  } catch (error) {
    stop();
    await Promise.allSettled([stdout, stderr, child.exited]);
    if (groupTermination) await groupTermination;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    options.signal?.removeEventListener("abort", stop);
  }
}

export async function requireCommand(
  argv: string[],
  errorMessage?: string,
  options?: CommandOptions,
): Promise<string> {
  const result = await command(argv, options);
  if (result.exitCode !== 0) {
    throw new Error(errorMessage ?? result.stderr.trim() ?? `${argv[0]} failed`);
  }
  return result.stdout.trim();
}
