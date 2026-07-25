import { expect, test } from "bun:test";
import { changedLines, parseFindings } from "./staff-review.ts";

test("parses structured Amp findings", () => {
  expect(
    parseFindings(
      '```json\n[{"path":"src/example.ts","line":4,"priority":"P2","title":"Bug","body":"Fix it"}]\n```',
    ),
  ).toEqual([
    {
      path: "src/example.ts",
      line: 4,
      priority: "P2",
      title: "Bug",
      body: "Fix it",
    },
  ]);
});

test("extracts right-side changed lines from a zero-context diff", () => {
  const lines = changedLines(
    "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -3,0 +4,2 @@\n+first\n+second\n",
  );
  expect([...(lines.get("src/example.ts") ?? new Set()).values()]).toEqual([4, 5]);
});
