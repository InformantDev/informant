export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
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
  options: {
    cwd?: string;
    env?: Record<string, string>;
    inheritEnv?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
    onOutput?: (text: string) => Promise<void> | void;
  } = {},
): Promise<CommandResult> {
  options.signal?.throwIfAborted();
  const spawned = (() => {
    try {
      return Bun.spawn(argv, {
        cwd: options.cwd,
        env: { ...(options.inheritEnv === false ? {} : Bun.env), ...options.env },
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch {
      return undefined;
    }
  })();
  if (!spawned) {
    const error = `could not start command: ${argv[0] ?? "unknown"}`;
    return { exitCode: 127, stdout: "", stderr: String(error), timedOut: false };
  }
  const process = spawned;
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const captureController = new AbortController();
  const stop = () => {
    process.kill("SIGTERM");
    killTimer ??= setTimeout(() => {
      process.kill("SIGKILL");
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
  const stdout = captureTail(process.stdout, captureController.signal, options.onOutput);
  const stderr = captureTail(process.stderr, captureController.signal, options.onOutput);
  try {
    const [capturedStdout, capturedStderr, exitCode] = await Promise.all([
      stdout,
      stderr,
      process.exited,
    ]);
    options.signal?.throwIfAborted();
    return { stdout: capturedStdout, stderr: capturedStderr, exitCode, timedOut };
  } catch (error) {
    stop();
    await Promise.allSettled([stdout, stderr, process.exited]);
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
  options?: {
    cwd?: string;
    env?: Record<string, string>;
    inheritEnv?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
    onOutput?: (text: string) => Promise<void> | void;
  },
): Promise<string> {
  const result = await command(argv, options);
  if (result.exitCode !== 0) {
    throw new Error(errorMessage ?? result.stderr.trim() ?? `${argv[0]} failed`);
  }
  return result.stdout.trim();
}
