import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli.ts";

test("cache prune preserves shared caches and cache clear removes the cache root", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-cli-cache-"));
  const cacheRoot = join(root, "caches");
  const originalDataDirectory = Bun.env.INFORMANT_DATA_DIR;
  Bun.env.INFORMANT_DATA_DIR = root;
  try {
    await mkdir(join(cacheRoot, "shared", "shared-entry"), { recursive: true });
    await mkdir(join(cacheRoot, "repository", "keyed-entry"), { recursive: true });

    await main(["cache", "prune"]);
    expect(await readdir(cacheRoot)).toEqual(["shared"]);

    await main(["cache", "clear"]);
    expect(await Bun.file(cacheRoot).exists()).toBe(false);
  } finally {
    if (originalDataDirectory === undefined) delete Bun.env.INFORMANT_DATA_DIR;
    else Bun.env.INFORMANT_DATA_DIR = originalDataDirectory;
    await rm(root, { recursive: true, force: true });
  }
});
