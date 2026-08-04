import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOnHost } from "./host.ts";

test("runs a host job in its disposable checkout with an isolated home", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "informant-host-"));
  const output: string[] = [];
  Bun.env.INFORMANT_TEST_UNDECLARED = "must-not-leak";
  try {
    const result = await runOnHost(
      { owner: "owner", repo: "repo", fullName: "owner/repo" },
      "abc123",
      "main",
      "abc123",
      workspace,
      {
        name: "test",
        command: `printf "%s\\n%s\\n%s\\n" "$INFORMANT_REPOSITORY" "$HOME" "\${INFORMANT_TEST_UNDECLARED:-missing}" > result`,
        optional: false,
        timeoutMinutes: 1,
        environment: {},
        secrets: [],
        needs: [],
        runsOn: ["linux"],
        runtime: { type: "host" },
      },
      async (text) => void output.push(text),
      async () => {},
      {},
    );
    expect(result.success).toBeTrue();
    expect(await readFile(join(workspace, "result"), "utf8")).toBe(
      `owner/repo\n${join(workspace, ".informant-home")}\nmissing\n`,
    );
    expect(output.join("")).toContain("$ printf");
  } finally {
    delete Bun.env.INFORMANT_TEST_UNDECLARED;
    await rm(workspace, { recursive: true, force: true });
  }
});
