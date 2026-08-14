import { expect, test } from "bun:test";
import { command } from "./process.ts";

test("command retains only a bounded diagnostic tail", async () => {
  const result = await command([
    "bun",
    "-e",
    'process.stdout.write("a".repeat(1_100_000) + "stdout-tail"); process.stderr.write("b".repeat(1_100_000) + "stderr-tail")',
  ]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.length).toBeLessThanOrEqual(1024 * 1024);
  expect(result.stderr.length).toBeLessThanOrEqual(1024 * 1024);
  expect(result.stdout.endsWith("stdout-tail")).toBe(true);
  expect(result.stderr.endsWith("stderr-tail")).toBe(true);
});

test("command timeout stops waiting for output inherited by a child process", async () => {
  const started = Date.now();
  const result = await command(["sh", "-c", "sleep 10 & exit 0"], { timeoutMs: 20 });

  expect(result.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(3_000);
});

test("command streams output before the process exits", async () => {
  const output: string[] = [];
  let release!: () => void;
  const received = new Promise<void>((resolve) => {
    release = resolve;
  });
  const result = command(["sh", "-c", "printf first; sleep 1; printf second"], {
    onOutput: (text) => {
      output.push(text);
      if (output.join("").includes("first")) release();
    },
  });

  await received;
  expect(output.join("")).toContain("first");
  expect(await result).toMatchObject({ exitCode: 0, stdout: "firstsecond" });
});

test("command applies backpressure while an output callback is blocked", async () => {
  let callbacks = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const result = command(
    ["bun", "-e", 'for (let i = 0; i < 10_000; i++) process.stdout.write("output\\n")'],
    {
      onOutput: async () => {
        callbacks += 1;
        await blocked;
      },
    },
  );

  await Bun.sleep(50);
  expect(callbacks).toBe(1);
  release();
  expect((await result).exitCode).toBe(0);
});

test("command terminates when its signal is aborted", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const result = command(["sleep", "30"], { signal: controller.signal });
  controller.abort("superseded");

  await expect(result).rejects.toThrow("superseded");
  expect(Date.now() - started).toBeLessThan(3_000);
});

test("command can terminate a cancelled process group", async () => {
  const controller = new AbortController();
  let output = "";
  let descendantPid: number | undefined;
  let reportStarted: (() => void) | undefined;
  const reported = new Promise<void>((resolve) => {
    reportStarted = resolve;
  });
  const result = command(["sh", "-c", 'sleep 30 & echo "$!"; wait'], {
    signal: controller.signal,
    killProcessGroup: true,
    onOutput: (text) => {
      output += text;
      const match = output.match(/^(\d+)\n/);
      if (match?.[1] && descendantPid === undefined) {
        descendantPid = Number(match[1]);
        reportStarted?.();
      }
    },
  });

  try {
    await reported;
    controller.abort("cancel process tree");
    await expect(result).rejects.toThrow("cancel process tree");
    for (let attempt = 0; attempt < 50 && descendantPid !== undefined; attempt++) {
      try {
        process.kill(descendantPid, 0);
        await Bun.sleep(20);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          descendantPid = undefined;
          break;
        }
        throw error;
      }
    }
    expect(descendantPid).toBeUndefined();
  } finally {
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // Best-effort cleanup if the assertion failed before the child was reaped.
      }
    }
  }
});

test("command terminates when its output callback fails", async () => {
  const started = Date.now();
  const result = command(["sh", "-c", "printf output; sleep 30"], {
    onOutput: () => {
      throw new Error("log failed");
    },
  });

  await expect(result).rejects.toThrow("log failed");
  expect(Date.now() - started).toBeLessThan(3_000);
});
