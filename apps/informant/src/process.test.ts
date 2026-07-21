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
