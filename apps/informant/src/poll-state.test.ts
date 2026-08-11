import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPollState } from "./poll-state.ts";

const originalDataDirectory = Bun.env.INFORMANT_DATA_DIR;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  if (originalDataDirectory === undefined) delete Bun.env.INFORMANT_DATA_DIR;
  else Bun.env.INFORMANT_DATA_DIR = originalDataDirectory;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

test("migrates legacy missing config entries as expired", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-poll-state-"));
  temporaryDirectories.push(root);
  Bun.env.INFORMANT_DATA_DIR = root;
  await mkdir(join(root, "poll"), { recursive: true });
  await Bun.write(
    join(root, "poll", "owner--repo.json"),
    JSON.stringify({
      pending: [],
      seenCommentIds: [],
      pendingTags: [],
      missingConfigShas: ["legacy-sha"],
    }),
  );

  const state = await readPollState("owner/repo");

  expect(state.missingConfigs).toEqual([
    { sha: "legacy-sha", checkedAt: "1970-01-01T00:00:00.000Z" },
  ]);
});
