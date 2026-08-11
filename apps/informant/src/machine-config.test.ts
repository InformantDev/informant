import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addRepository,
  allowMount,
  automaticUpdatesPreference,
  getGitHubCredentials,
  listAllowedMounts,
  listGitHubCredentials,
  listRepositories,
  MAX_ALLOWED_MOUNT_BYTES,
  machineConfigPath,
  removeAllowedMount,
  removeRepository,
  saveAutomaticUpdatesPreference,
  saveGitHubCredentials,
} from "./machine-config.ts";
import { startupEnvironment } from "./startup.ts";

test("uses the worker's fallback configuration path for invalid XDG homes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "informant-machine-config-"));
  const repository = { owner: "acme", repo: "widgets", fullName: "acme/widgets" };

  try {
    for (const [index, configuredHome] of ["", "relative/config"].entries()) {
      const home = join(directory, String(index));
      const setupEnvironment = { XDG_CONFIG_HOME: configuredHome };
      const setupPath = machineConfigPath(setupEnvironment, home);
      const workerEnvironment = startupEnvironment(setupEnvironment, home);
      const workerPath = machineConfigPath(workerEnvironment, workerEnvironment.HOME);

      expect(setupPath).toBe(join(home, ".config", "informant", "config.json"));
      expect(workerPath).toBe(setupPath);
      await addRepository(repository, setupPath);
      expect((await listRepositories(workerPath)).map((value) => value.fullName)).toEqual([
        "acme/widgets",
      ]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("allows only named existing host files for repository mounts", async () => {
  const root = join(import.meta.dir, `.machine-mount-${crypto.randomUUID()}`);
  const path = join(root, "config.json");
  const source = join(root, "auth.json");
  try {
    await mkdir(root);
    await Bun.write(source, "credential");
    await allowMount("codex-auth", source, path);
    expect(await listAllowedMounts(path)).toEqual([{ name: "codex-auth", source }]);
    expect(allowMount("bad/name", source, path)).rejects.toThrow("mount name");
    expect(allowMount("missing", join(root, "missing"), path)).rejects.toThrow("existing file");
    await Bun.write(source, Buffer.alloc(MAX_ALLOWED_MOUNT_BYTES + 1));
    expect(allowMount("too-large", source, path)).rejects.toThrow(
      `exceeds ${MAX_ALLOWED_MOUNT_BYTES} bytes`,
    );
    expect(await removeAllowedMount("codex-auth", path)).toBe(true);
    expect(await removeAllowedMount("codex-auth", path)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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

test("stores the initial automatic-update choice without changing machine credentials", async () => {
  const path = join(import.meta.dir, `.machine-config-${crypto.randomUUID()}.json`);
  const credentials = {
    account: "acme",
    appId: "123",
    installationId: "456",
    privateKeyFile: "/tmp/informant.pem",
  };

  try {
    expect(await automaticUpdatesPreference(path)).toBeUndefined();
    await saveGitHubCredentials(credentials, path);
    await saveAutomaticUpdatesPreference(false, path);
    expect(await automaticUpdatesPreference(path)).toBe(false);
    expect(await listGitHubCredentials(path)).toEqual([credentials]);
    await saveAutomaticUpdatesPreference(true, path);
    expect(await automaticUpdatesPreference(path)).toBe(true);
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
