import { expect, test } from "bun:test";
import { join } from "node:path";
import { addRepository, listRepositories, removeRepository } from "./machine-config.ts";

test("registers and removes machine repositories without duplicates", async () => {
  const path = join(import.meta.dir, `.machine-config-${crypto.randomUUID()}.json`);
  const repository = { owner: "acme", repo: "widgets", fullName: "acme/widgets" };

  try {
    expect(await addRepository(repository, path)).toBe(true);
    expect(await addRepository(repository, path)).toBe(false);
    expect((await listRepositories(path)).map((value) => value.fullName)).toEqual(["acme/widgets"]);
    expect(await removeRepository(repository, path)).toBe(true);
    expect(await listRepositories(path)).toEqual([]);
  } finally {
    await Bun.file(path).delete();
  }
});

test("rejects unsupported machine configuration versions before rewriting", async () => {
  const path = join(import.meta.dir, `.machine-config-${crypto.randomUUID()}.json`);
  const repository = { owner: "acme", repo: "widgets", fullName: "acme/widgets" };
  const source = `${JSON.stringify({ version: 2, repositories: [], future: "preserve" }, null, 2)}\n`;

  try {
    await Bun.write(path, source);
    expect(addRepository(repository, path)).rejects.toThrow("upgrade Informant");
    expect(await Bun.file(path).text()).toBe(source);
  } finally {
    await Bun.file(path).delete();
  }
});
