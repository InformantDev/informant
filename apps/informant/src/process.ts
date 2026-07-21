export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const MAX_CAPTURE_CHARS = 1024 * 1024;

async function captureTail(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    tail += decoder.decode(value, { stream: true });
    if (tail.length > MAX_CAPTURE_CHARS) tail = tail.slice(-MAX_CAPTURE_CHARS);
  }
  tail += decoder.decode();
  return tail.length > MAX_CAPTURE_CHARS ? tail.slice(-MAX_CAPTURE_CHARS) : tail;
}

export async function command(
  argv: string[],
  options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<CommandResult> {
  const spawned = (() => {
    try {
      return Bun.spawn(argv, {
        cwd: options.cwd,
        env: { ...Bun.env, ...options.env },
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
  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        process.kill("SIGTERM");
        killTimer = setTimeout(() => process.kill("SIGKILL"), 2_000);
      }, options.timeoutMs)
    : undefined;
  const [stdout, stderr, exitCode] = await Promise.all([
    captureTail(process.stdout),
    captureTail(process.stderr),
    process.exited,
  ]);
  if (timer) clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);
  return { stdout, stderr, exitCode, timedOut };
}

export async function requireCommand(
  argv: string[],
  errorMessage?: string,
  options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
): Promise<string> {
  const result = await command(argv, options);
  if (result.exitCode !== 0) {
    throw new Error(errorMessage ?? result.stderr.trim() ?? `${argv[0]} failed`);
  }
  return result.stdout.trim();
}
