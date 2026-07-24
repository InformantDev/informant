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

test("command terminates when its signal is aborted", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const result = command(["sleep", "30"], { signal: controller.signal });
  controller.abort("superseded");

  await expect(result).rejects.toThrow("superseded");
  expect(Date.now() - started).toBeLessThan(3_000);
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
