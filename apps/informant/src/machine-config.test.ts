import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  addRepository,
  getGitHubCredentials,
  listGitHubCredentials,
  listRepositories,
  removeRepository,
  saveGitHubCredentials,
} from "./machine-config.ts";

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

test("saving GitHub credentials preserves registered repositories", async () => {
  const path = join(import.meta.dir, `.machine-config-${crypto.randomUUID()}.json`);
  const repository = { owner: "acme", repo: "widgets", fullName: "acme/widgets" };
  const credentials = {
    account: "acme",
    appId: "123",
    installationId: "456",
    privateKeyFile: "/tmp/informant.pem",
  };

  try {
    await addRepository(repository, path);
    await saveGitHubCredentials(credentials, path);
    expect(await getGitHubCredentials(repository, path)).toEqual(credentials);
    expect((await listRepositories(path)).map((value) => value.fullName)).toEqual(["acme/widgets"]);
  } finally {
    await Bun.file(path).delete();
  }
});

test("stores and selects private GitHub Apps by repository owner", async () => {
  const path = join(import.meta.dir, `.machine-config-${crypto.randomUUID()}.json`);
  const acme = { account: "Acme", appId: "1", installationId: "10", privateKeyFile: "/a.pem" };
  const octo = { account: "Octo", appId: "2", installationId: "20", privateKeyFile: "/o.pem" };

  try {
    await saveGitHubCredentials(acme, path);
    await saveGitHubCredentials(octo, path);
    expect(await listGitHubCredentials(path)).toEqual([acme, octo]);
    expect(
      await getGitHubCredentials(
        { owner: "octo", repo: "widgets", fullName: "octo/widgets" },
        path,
      ),
    ).toEqual(octo);
    expect(
      getGitHubCredentials({ owner: "other", repo: "widgets", fullName: "other/widgets" }, path),
    ).rejects.toThrow("configured accounts: Acme, Octo");
  } finally {
    await Bun.file(path).delete();
  }
});

test("uses a legacy single App until it is migrated", async () => {
  const path = join(import.meta.dir, `.machine-config-${crypto.randomUUID()}.json`);
  const credentials = { appId: "1", installationId: "10", privateKeyFile: "/legacy.pem" };
  try {
    await Bun.write(
      path,
      `${JSON.stringify({ version: 1, repositories: [], github: credentials })}\n`,
    );
    expect(
      await getGitHubCredentials(
        { owner: "acme", repo: "widgets", fullName: "acme/widgets" },
        path,
      ),
    ).toEqual(credentials);
    const migrated = {
      account: "acme",
      appId: "2",
      installationId: "20",
      privateKeyFile: "/acme.pem",
    };
    await saveGitHubCredentials(migrated, path);
    expect(await listGitHubCredentials(path)).toEqual([credentials, migrated]);
  } finally {
    await Bun.file(path).delete();
  }
});
