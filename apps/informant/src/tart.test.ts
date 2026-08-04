import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireCommand } from "./process.ts";
import { cacheMounts } from "./tart/cache.ts";
import {
  appendUtf8Tail,
  BUILD_LOG_TRUNCATION_MARKER,
  boundedLogWriter,
  cachePathIdentity,
  checkoutBuildWorkspace,
  ensurePreparedImage,
  isRetryableSshAuthenticationFailure,
  jobEventLine,
  preparedImageName,
  prunePreparedImages,
  reconcilePreparedImageReferences,
  reconcilePreparedImageRepositories,
  resolveJobSecrets,
  scheduleJobs,
  secretMount,
  streamingSecretRedactor,
  utf8Tail,
  writeWithBestEffortDuplicate,
} from "./tart/index.ts";
import {
  bunCopyfileBackend,
  linuxSharedMountCommand,
  linuxWorkspaceCopyCommand,
  raiseFileDescriptorLimit,
} from "./tart/layout.ts";
import { digest, sshCommand, withImageLock } from "./tart/vm.ts";
import type { InformantConfig } from "./types.ts";

const job = (
  name: string,
  needs: string[] = [],
  optional = false,
): InformantConfig["jobs"][number] => ({
  name,
  needs,
  command: name,
  optional,
  environment: {},
  secrets: [],
  timeoutMinutes: 1,
});

test("resolves only explicitly requested host secrets", async () => {
  const configured = { ...job("review"), secrets: ["AMP_API_KEY", "GITHUB_TOKEN"] };
  expect(
    await resolveJobSecrets(
      configured,
      { GITHUB_TOKEN: "installation-token" },
      {
        INFORMANT_SECRET_AMP_API_KEY: "amp-token",
        UNREQUESTED: "hidden",
      },
    ),
  ).toEqual({ AMP_API_KEY: "amp-token", GITHUB_TOKEN: "installation-token" });
  await expect(resolveJobSecrets(configured, {}, {})).rejects.toThrow(
    "secret AMP_API_KEY is not configured",
  );
});

test("redacts secrets split across streamed log chunks", async () => {
  let output = "";
  const redactor = streamingSecretRedactor(["top-secret"], async (text) => {
    output += text;
  });
  await redactor.write("before top-");
  await redactor.write("secret after");
  await redactor.flush();
  expect(output).toBe("before [REDACTED] after");
});

test("ignores empty values while redacting streamed secrets", async () => {
  let output = "";
  const redactor = streamingSecretRedactor(["", "secret"], async (text) => {
    output += text;
  });
  await redactor.write("before secret after");
  await redactor.flush();
  expect(output).toBe("before [REDACTED] after");
});

test("prepares and cleans up a restricted secret mount", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-secrets-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  try {
    const mount = await secretMount(
      workspace,
      { ...job("review"), secrets: ["TOKEN"] },
      {
        TOKEN: "top secret",
      },
    );
    if (!mount.directory) throw new Error("expected a secret directory");
    const environment = join(mount.directory, "environment");
    expect((await stat(mount.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(environment)).mode & 0o777).toBe(0o600);
    expect(await readFile(environment, "utf8")).toBe("export TOKEN='top secret'\n");
    expect(mount.args).toEqual([`--dir=secrets:${await realpath(mount.directory)}`]);
    expect(mount.source).toContain("/Volumes/My Shared Files/secrets/environment");
    expect(mount.source).toContain("|| exit; rm -f");
    expect(mount.source).toEndWith("|| exit;");

    const linuxMount = await secretMount(
      workspace,
      { ...job("review"), secrets: ["TOKEN"] },
      { TOKEN: "top secret" },
      "linux",
    );
    expect(linuxMount.source).toContain("/mnt/shared/secrets/environment");
    if (linuxMount.directory) await rm(linuxMount.directory, { recursive: true, force: true });

    await rm(mount.directory, { recursive: true, force: true });
    expect(await Bun.file(environment).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes plaintext secrets when mount preparation fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-secrets-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  try {
    await expect(
      secretMount(
        workspace,
        { ...job("review"), secrets: ["TOKEN"] },
        { TOKEN: "top secret" },
        "macos",
        { realpath: async () => Promise.reject(new Error("realpath failed")) },
      ),
    ).rejects.toThrow("realpath failed");
    expect((await Array.fromAsync(new Bun.Glob("secrets-*").scan(root))).length).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isolated workspaces fetch commits that only have remote-tracking refs", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-isolated-checkout-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const repository = join(root, "repository");
  const workspace = join(root, "workspace");
  try {
    await requireCommand(["git", "init", "--quiet", "--bare", remote]);
    await requireCommand(["git", "init", "--quiet", seed]);
    await requireCommand(["git", "config", "user.email", "informant@example.com"], undefined, {
      cwd: seed,
    });
    await requireCommand(["git", "config", "user.name", "Informant"], undefined, { cwd: seed });
    await Bun.write(join(seed, "README.md"), "main\n");
    await requireCommand(["git", "add", "README.md"], undefined, { cwd: seed });
    await requireCommand(["git", "commit", "--quiet", "-m", "main"], undefined, { cwd: seed });
    await requireCommand(["git", "branch", "-M", "main"], undefined, { cwd: seed });
    await requireCommand(["git", "remote", "add", "origin", remote], undefined, { cwd: seed });
    await requireCommand(["git", "push", "--quiet", "origin", "main"], undefined, { cwd: seed });
    await requireCommand(["git", "symbolic-ref", "HEAD", "refs/heads/main"], undefined, {
      cwd: remote,
    });
    await Bun.write(join(seed, "feature.txt"), "feature\n");
    await requireCommand(["git", "add", "feature.txt"], undefined, { cwd: seed });
    await requireCommand(["git", "commit", "--quiet", "-m", "feature"], undefined, { cwd: seed });
    const sha = await requireCommand(["git", "rev-parse", "HEAD"], undefined, { cwd: seed });
    await requireCommand(
      ["git", "push", "--quiet", "origin", `HEAD:refs/heads/feature`],
      undefined,
      {
        cwd: seed,
      },
    );
    await requireCommand(["git", "clone", "--quiet", "--no-checkout", remote, repository]);

    const checkout = await checkoutBuildWorkspace(repository, workspace, sha, true);

    expect(checkout.exitCode).toBe(0);
    expect(await Bun.file(join(workspace, "feature.txt")).text()).toBe("feature\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const config = (prepare?: string): InformantConfig => ({
  version: 1,
  pollIntervalSeconds: 20,
  branches: ["main"],
  vm: {
    type: "vm",
    image: "base",
    guestOs: "macos",
    user: "admin",
    password: "admin",
    prepare,
  },
  jobs: [job("test")],
});

test("prepared image identity changes with its source or preparation", () => {
  expect(preparedImageName(config())).toBeUndefined();
  const first = preparedImageName(config("install bun"));
  expect(first).toStartWith("informant-prepared-");
  expect(preparedImageName(config("install node"))).not.toBe(first);
  expect(
    preparedImageName({
      ...config("install bun"),
      vm: { ...config().vm, image: "other", prepare: "install bun" },
    }),
  ).not.toBe(first);
  expect(
    preparedImageName({
      ...config("install bun"),
      vm: { ...config().vm, user: "builder", prepare: "install bun" },
    }),
  ).not.toBe(first);
  expect(
    preparedImageName({
      ...config("install bun"),
      vm: { ...config().vm, guestOs: "linux", prepare: "install bun" },
    }),
  ).not.toBe(first);
});

test("SSH authentication retries share one cumulative timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-ssh-timeout-"));
  const sshpass = join(root, "sshpass");
  await Bun.write(sshpass, "#!/bin/sh\necho 'Permission denied' >&2\nexit 255\n");
  await chmod(sshpass, 0o755);
  const originalPath = Bun.env.PATH;
  Bun.env.PATH = `${root}:${originalPath}`;
  const started = Date.now();
  try {
    const result = await sshCommand("127.0.0.1", config(), "true", 100);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  } finally {
    if (originalPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("superseded prepared images are deleted after their last repository switches", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-images-"));
  const bin = join(root, "bin");
  const tart = join(bin, "tart");
  const deleted = join(root, "deleted");
  const firstConfig = config("install bun");
  const secondConfig = config("install node");
  const first = preparedImageName(firstConfig);
  const second = preparedImageName(secondConfig);
  if (!first || !second) throw new Error("expected prepared image names");
  await mkdir(bin);
  await Bun.write(
    tart,
    `#!/bin/sh
if [ "$1" = "list" ]; then
  printf '%s\\n' '${JSON.stringify([
    { Name: first, Source: "local" },
    { Name: second, Source: "local" },
  ])}'
elif [ "$1" = "delete" ]; then
  printf '%s\\n' "$2" >> '${deleted}'
fi
`,
  );
  await chmod(tart, 0o755);
  const originalPath = Bun.env.PATH;
  const originalDataDirectory = Bun.env.INFORMANT_DATA_DIR;
  Bun.env.PATH = `${bin}:${originalPath}`;
  Bun.env.INFORMANT_DATA_DIR = join(root, "data");
  try {
    await ensurePreparedImage(firstConfig, () => {}, "owner/one");
    await ensurePreparedImage(firstConfig, () => {}, "owner/two");
    await ensurePreparedImage(secondConfig, () => {}, "owner/one");
    expect(await Bun.file(deleted).exists()).toBe(false);

    await ensurePreparedImage(secondConfig, () => {}, "owner/two");
    expect((await Bun.file(deleted).text()).trim()).toBe(first);

    expect(await prunePreparedImages()).toBe(1);
    expect((await Bun.file(deleted).text()).trim().split("\n")).toEqual([first, first]);
  } finally {
    if (originalPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = originalPath;
    if (originalDataDirectory === undefined) delete Bun.env.INFORMANT_DATA_DIR;
    else Bun.env.INFORMANT_DATA_DIR = originalDataDirectory;
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed superseded image deletion still advances the repository reference", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-image-delete-failure-"));
  const bin = join(root, "bin");
  const tart = join(bin, "tart");
  const failed = join(root, "failed");
  const deleted = join(root, "deleted");
  const firstConfig = config("install bun");
  const secondConfig = config("install node");
  const first = preparedImageName(firstConfig);
  const second = preparedImageName(secondConfig);
  if (!first || !second) throw new Error("expected prepared image names");
  await mkdir(bin);
  await Bun.write(
    tart,
    `#!/bin/sh
if [ "$1" = "list" ]; then
  printf '%s\\n' '${JSON.stringify([
    { Name: first, Source: "local" },
    { Name: second, Source: "local" },
  ])}'
elif [ "$1" = "delete" ]; then
  if [ ! -e '${failed}' ]; then
    touch '${failed}'
    exit 1
  fi
  printf '%s\\n' "$2" >> '${deleted}'
fi
`,
  );
  await chmod(tart, 0o755);
  const originalPath = Bun.env.PATH;
  const originalDataDirectory = Bun.env.INFORMANT_DATA_DIR;
  Bun.env.PATH = `${bin}:${originalPath}`;
  Bun.env.INFORMANT_DATA_DIR = join(root, "data");
  try {
    await ensurePreparedImage(firstConfig, () => {}, "owner/repository");
    const messages: string[] = [];
    await ensurePreparedImage(
      secondConfig,
      (message) => {
        messages.push(message);
      },
      "owner/repository",
    );

    expect(messages).toEqual([`Could not delete superseded Tart image ${first}; will retry later`]);
    expect(await prunePreparedImages()).toBe(1);
    expect((await Bun.file(deleted).text()).trim()).toBe(first);
  } finally {
    if (originalPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = originalPath;
    if (originalDataDirectory === undefined) delete Bun.env.INFORMANT_DATA_DIR;
    else Bun.env.INFORMANT_DATA_DIR = originalDataDirectory;
    await rm(root, { recursive: true, force: true });
  }
});

test("reconciles removed VM job references and the legacy repository reference", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-image-references-"));
  const originalDataDirectory = Bun.env.INFORMANT_DATA_DIR;
  const data = join(root, "data");
  Bun.env.INFORMANT_DATA_DIR = data;
  const repository = "owner/repository";
  const references = join(data, "prepared-image-references");
  const jobs = join(references, `${digest(repository)}.jobs`);
  const active = join(jobs, digest("active"));
  const removed = join(jobs, digest("removed"));
  const legacy = join(references, digest(repository));
  try {
    await mkdir(jobs, { recursive: true });
    await Bun.write(active, "active-image\n");
    await Bun.write(removed, "removed-image\n");
    await Bun.write(legacy, "legacy-image\n");

    expect(await reconcilePreparedImageReferences(repository, ["active"])).toBe(1);

    expect(await Bun.file(active).text()).toBe("active-image\n");
    expect(await Bun.file(removed).exists()).toBe(false);
    expect(await Bun.file(legacy).exists()).toBe(false);

    const orphaned = join(references, `${digest("owner/removed")}.jobs`);
    await mkdir(orphaned, { recursive: true });
    await Bun.write(join(orphaned, digest("job")), "old-image\n");
    expect(await reconcilePreparedImageRepositories([repository])).toBe(1);
    expect(await Bun.file(orphaned).exists()).toBe(false);
  } finally {
    if (originalDataDirectory === undefined) delete Bun.env.INFORMANT_DATA_DIR;
    else Bun.env.INFORMANT_DATA_DIR = originalDataDirectory;
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelling image preparation deletes its staging VM", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-cancel-image-"));
  const bin = join(root, "bin");
  const tart = join(bin, "tart");
  const started = join(root, "started");
  const deleted = join(root, "deleted");
  await mkdir(bin);
  await Bun.write(
    tart,
    `#!/bin/sh
if [ "$1" = "list" ]; then
  printf '[]\\n'
elif [ "$1" = "clone" ]; then
  touch '${started}'
  sleep 30
elif [ "$1" = "delete" ]; then
  printf '%s\\n' "$2" >> '${deleted}'
fi
`,
  );
  await chmod(tart, 0o755);
  const originalPath = Bun.env.PATH;
  Bun.env.PATH = `${bin}:${originalPath}`;
  const controller = new AbortController();
  try {
    const preparation = ensurePreparedImage(
      config("install bun"),
      () => {},
      undefined,
      controller.signal,
    );
    while (!(await Bun.file(started).exists())) await Bun.sleep(10);
    controller.abort(new Error("superseded"));

    await expect(preparation).rejects.toThrow("superseded");
    expect((await Bun.file(deleted).text()).trim()).toMatch(
      /^informant-prepared-[0-9a-f]{16}-staging-/,
    );
  } finally {
    if (originalPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("cache destinations have distinct storage identities", () => {
  expect(cachePathIdentity("admin", "~/.bun/install/cache")).not.toBe(
    cachePathIdentity("admin", "~/.npm"),
  );
  expect(cachePathIdentity("admin", "~/.npm")).not.toBe(cachePathIdentity("builder", "~/.npm"));
});

test("shared caches use one direct host mount across repositories and jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-shared-cache-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const originalDataDirectory = Bun.env.INFORMANT_DATA_DIR;
  Bun.env.INFORMANT_DATA_DIR = join(root, "data");
  const sharedJob = {
    ...job("test"),
    cache: [{ paths: ["~/.bun/install/cache"], keyFiles: [], shared: true }],
  };
  try {
    const first = await cacheMounts(
      { owner: "one", repo: "repo", fullName: "one/repo" },
      workspace,
      sharedJob,
      "admin",
      "macos",
      true,
    );
    const second = await cacheMounts(
      { owner: "two", repo: "other", fullName: "two/other" },
      workspace,
      { ...sharedJob, name: "lint" },
      "admin",
      "macos",
      true,
    );
    expect(first.args).toEqual(second.args);
    expect(first.restore).toContain("ln -s");
    expect(first.save).toBe(":");
    const untrusted = await cacheMounts(
      { owner: "one", repo: "repo", fullName: "one/repo" },
      workspace,
      sharedJob,
      "admin",
      "macos",
    );
    expect(untrusted.args).not.toEqual(first.args);
    expect(untrusted.args[0]).toContain(root);
  } finally {
    if (originalDataDirectory === undefined) delete Bun.env.INFORMANT_DATA_DIR;
    else Bun.env.INFORMANT_DATA_DIR = originalDataDirectory;
    await rm(root, { recursive: true, force: true });
  }
});

test("keyed caches cross builds only for trusted commits", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-keyed-cache-"));
  const trustedWorkspace = join(root, "trusted-workspace");
  const untrustedWorkspace = join(root, "untrusted-workspace");
  await mkdir(trustedWorkspace);
  await mkdir(untrustedWorkspace);
  const originalDataDirectory = Bun.env.INFORMANT_DATA_DIR;
  Bun.env.INFORMANT_DATA_DIR = join(root, "data");
  const keyedJob = {
    ...job("test"),
    cache: [{ paths: ["~/.npm"], keyFiles: [], shared: false }],
  };
  const repository = { owner: "one", repo: "repo", fullName: "one/repo" };
  try {
    const trusted = await cacheMounts(
      repository,
      trustedWorkspace,
      keyedJob,
      "admin",
      "macos",
      true,
    );
    const untrusted = await cacheMounts(repository, untrustedWorkspace, keyedJob, "admin", "macos");

    expect(trusted.args[0]).toContain(join(root, "data", "caches"));
    expect(untrusted.args[0]).toContain(join(root, "keyed-caches"));
    expect(untrusted.args[0]).not.toContain(join(root, "data", "caches"));
    expect(untrusted.args).not.toEqual(trusted.args);
  } finally {
    if (originalDataDirectory === undefined) delete Bun.env.INFORMANT_DATA_DIR;
    else Bun.env.INFORMANT_DATA_DIR = originalDataDirectory;
    await rm(root, { recursive: true, force: true });
  }
});

test("Linux caches use Linux guest paths and separate persistent host storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-linux-cache-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const originalDataDirectory = Bun.env.INFORMANT_DATA_DIR;
  Bun.env.INFORMANT_DATA_DIR = join(root, "data");
  const cachedJob = {
    ...job("test"),
    cache: [{ paths: ["~/.bun/install/cache"], keyFiles: [], shared: true }],
  };
  const repository = { owner: "one", repo: "repo", fullName: "one/repo" };
  try {
    const macos = await cacheMounts(repository, workspace, cachedJob, "admin", "macos", true);
    const linux = await cacheMounts(repository, workspace, cachedJob, "admin", "linux", true);
    const directLinux = await cacheMounts(
      repository,
      workspace,
      cachedJob,
      "root",
      "linux",
      true,
      true,
    );
    expect(macos.args[0]).not.toContain(join("caches", "linux"));
    expect(linux.args[0]).toContain(join("caches", "linux"));
    expect(macos.restore).toContain("/Users/admin/.bun/install/cache");
    expect(macos.restore).toContain("/Volumes/My Shared Files/cache-0");
    expect(macos.installLock).toBe("/Volumes/My Shared Files/cache-0/.informant-install-lock");
    expect(linux.restore).toContain("/home/admin/.bun/install/cache");
    expect(linux.restore).toContain("/mnt/shared/cache-0");
    expect(linux.restore).not.toContain("ln -s");
    expect(linux.save).toContain("cache.tar.gz");
    expect(directLinux.restore).not.toContain("ln -s");
    expect(directLinux.restore).toContain("cache.tar.gz");
    expect(directLinux.save).toContain("cache.tar.gz");
    expect(linux.writablePaths).toHaveLength(1);
    expect(linux.args[0]).toEndWith(linux.writablePaths[0] ?? "");
    expect(linux.installLock).toBe("/mnt/shared/cache-0/.informant-install-lock");
  } finally {
    if (originalDataDirectory === undefined) delete Bun.env.INFORMANT_DATA_DIR;
    else Bun.env.INFORMANT_DATA_DIR = originalDataDirectory;
    await rm(root, { recursive: true, force: true });
  }
});

test("Linux shared mount setup is non-interactive and verifies the workspace", () => {
  expect(linuxSharedMountCommand()).toBe(
    "sudo -n mkdir -p /mnt/shared && (mountpoint -q /mnt/shared || sudo -n mount -t virtiofs com.apple.virtio-fs.automount /mnt/shared) && test -d /mnt/shared/workspace",
  );
});

test("Linux jobs copy the shared workspace onto the guest filesystem", () => {
  expect(linuxWorkspaceCopyCommand("/tmp/informant-workspace")).toBe(
    'rm -rf "/tmp/informant-workspace" && mkdir -p "/tmp/informant-workspace" && cp -a --no-preserve=ownership /mnt/shared/workspace/. "/tmp/informant-workspace"',
  );
});

test("job shells raise their file descriptor limit", () => {
  expect(raiseFileDescriptorLimit()).toBe(
    "if ! ulimit -n 65536 2>/dev/null; then ulimit -n 10240 2>/dev/null || true; fi;",
  );
});

test("Bun package commands use the copyfile backend", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-linux-bun-"));
  const bun = join(root, "bun");
  const calls = join(root, "calls");
  await Bun.write(bun, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\n`);
  await chmod(bun, 0o755);
  const result = Bun.spawnSync(
    [
      "/bin/bash",
      "-c",
      `${bunCopyfileBackend()} bun install --frozen-lockfile; bun test; bun add pkg --backend hardlink`,
    ],
    { env: { ...Bun.env, PATH: `${root}:${Bun.env.PATH}` } },
  );
  try {
    expect(result.exitCode).toBe(0);
    const locked = Bun.spawnSync(
      ["/bin/bash", "-c", `${bunCopyfileBackend(join(root, "lock"))} bun install`],
      { env: { ...Bun.env, PATH: `${root}:${Bun.env.PATH}` } },
    );
    expect(locked.exitCode).toBe(0);
    expect(await Bun.file(calls).text()).toBe(
      "install --frozen-lockfile --backend=copyfile\ntest\nadd pkg --backend hardlink\ninstall --backend=copyfile\n",
    );
    expect(await Bun.file(join(root, "lock")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Linux Bun package commands lease a shared snapshot cache", () => {
  const setup = bunCopyfileBackend("/mnt/shared/cache-0/.informant-install-lock");
  expect(setup).toContain('while ! mkdir "/mnt/shared/cache-0/.informant-install-lock"');
  expect(setup).toContain('rmdir "/mnt/shared/cache-0/.informant-install-lock"');
});

test("retries SSH only when authentication failed before the command started", () => {
  expect(
    isRetryableSshAuthenticationFailure({
      exitCode: 255,
      stdout: "",
      stderr: "admin@host: Permission denied (publickey,password).",
      timedOut: false,
    }),
  ).toBe(true);
  expect(
    isRetryableSshAuthenticationFailure({
      exitCode: 255,
      stdout: "command output",
      stderr: "Permission denied",
      timedOut: false,
    }),
  ).toBe(false);
  expect(
    isRetryableSshAuthenticationFailure({
      exitCode: 1,
      stdout: "",
      stderr: "Permission denied",
      timedOut: false,
    }),
  ).toBe(false);
});

test("job log tails stay within their UTF-8 byte limit", () => {
  const tail = utf8Tail(`prefix${"😀".repeat(20)}`, 17);
  expect(new TextEncoder().encode(tail).length).toBeLessThanOrEqual(17);
  expect(tail).not.toContain("�");
  expect(tail).toBe("😀".repeat(4));
});

test("job log tails can be maintained incrementally", () => {
  let tail: Uint8Array<ArrayBufferLike> = new Uint8Array();
  tail = appendUtf8Tail(tail, "prefix", 17);
  tail = appendUtf8Tail(tail, "😀".repeat(20), 17);
  const value = new TextDecoder().decode(tail);
  expect(tail.length).toBeLessThanOrEqual(17);
  expect(value).not.toContain("�");
  expect(value).toBe("😀".repeat(4));
});

test("persistent build logs stop at their byte quota with a truncation marker", async () => {
  let output = "";
  const write = boundedLogWriter(async (text) => {
    output += text;
  }, 64);

  await write("start 😀 ");
  await write("x".repeat(100));
  await write("ignored after truncation");

  expect(new TextEncoder().encode(output).length).toBe(64);
  expect(output).toEndWith(BUILD_LOG_TRUNCATION_MARKER);
  expect(output).not.toContain("�");
  expect(output).not.toContain("ignored");
});

test("bounded log writes serialize quota accounting", async () => {
  let output = "";
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = boundedLogWriter(
    async (text) => {
      await blocked;
      output += text;
    },
    8,
    "!",
  );

  const writes = [write("123456"), write("abcdef"), write("ghijkl")];
  await Bun.sleep(0);
  release();
  await Promise.all(writes);

  expect(output).toBe("123456a!");
});

test("a failed duplicate log sink does not interrupt parallel jobs", async () => {
  const output: string[] = [];
  const duplicate = boundedLogWriter(async () => {
    throw new Error("too many open files");
  });

  expect(
    await scheduleJobs([job("one"), job("two")], async (current) => {
      await writeWithBestEffortDuplicate(
        async (text) => {
          output.push(text);
        },
        duplicate,
        current.name,
      );
      return true;
    }),
  ).toBe(true);
  expect(new Set(output)).toEqual(new Set(["one", "two"]));
});

test("job event lines timestamp lifecycle changes without changing command output", () => {
  const timestamp = new Date("2026-07-26T12:34:56.789Z");

  expect(jobEventLine("test", "started", timestamp)).toBe(
    "[2026-07-26T12:34:56.789Z] [test] started\n",
  );
  expect(jobEventLine("test", "finished (success)", timestamp)).toBe(
    "[2026-07-26T12:34:56.789Z] [test] finished (success)\n",
  );
  expect(jobEventLine("test", "finished (success)", timestamp, "exit 0")).toBe(
    "[2026-07-26T12:34:56.789Z] [test] finished (success, exit 0)\n",
  );
});

test("stale image lock reclamation cannot admit concurrent successors", async () => {
  const root = await mkdtemp(join(tmpdir(), "informant-lock-"));
  const previous = Bun.env.INFORMANT_DATA_DIR;
  Bun.env.INFORMANT_DATA_DIR = root;
  await mkdir(join(root, "locks"), { recursive: true });
  await Bun.write(join(root, "locks", "shared.lock"), "999999999:stale\n");
  let active = 0;
  let maximum = 0;
  const enter = () =>
    withImageLock("shared", async () => {
      active++;
      maximum = Math.max(maximum, active);
      await Bun.sleep(20);
      active--;
    });
  try {
    await Promise.all([enter(), enter()]);
    expect(maximum).toBe(1);
  } finally {
    if (previous === undefined) delete Bun.env.INFORMANT_DATA_DIR;
    else Bun.env.INFORMANT_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

describe("job scheduler", () => {
  test("starts independent jobs in parallel", async () => {
    const started: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = scheduleJobs([job("one"), job("two")], async (current) => {
      started.push(current.name);
      await blocked;
      return true;
    });
    await Bun.sleep(0);
    expect(started).toEqual(["one", "two"]);
    release();
    expect(await result).toBe(true);
  });

  test("executes a shared dependency once", async () => {
    const calls: string[] = [];
    expect(
      await scheduleJobs(
        [job("base"), job("one", ["base"]), job("two", ["base"])],
        async (current) => {
          calls.push(current.name);
          return true;
        },
      ),
    ).toBe(true);
    expect(calls.filter((name) => name === "base")).toHaveLength(1);
    expect(new Set(calls)).toEqual(new Set(["base", "one", "two"]));
  });

  test("skips downstream jobs after dependency failure", async () => {
    const executed: string[] = [];
    const skipped: string[] = [];
    expect(
      await scheduleJobs(
        [job("base"), job("child", ["base"]), job("grandchild", ["child"])],
        async (current) => {
          executed.push(current.name);
          return current.name !== "base";
        },
        async (current) => {
          skipped.push(current.name);
        },
      ),
    ).toBe(false);
    expect(executed).toEqual(["base"]);
    expect(skipped).toEqual(["child", "grandchild"]);
  });

  test("optional failures do not fail the build or block dependent jobs", async () => {
    const executed: string[] = [];
    expect(
      await scheduleJobs([job("review", [], true), job("publish", ["review"])], async (current) => {
        executed.push(current.name);
        return current.name !== "review";
      }),
    ).toBe(true);
    expect(executed).toEqual(["review", "publish"]);
  });

  test("optional execution errors still fail the build and block dependent jobs", async () => {
    const executed: string[] = [];
    const failed: string[] = [];
    const skipped: string[] = [];
    expect(
      await scheduleJobs(
        [job("review", [], true), job("publish", ["review"])],
        async (current) => {
          executed.push(current.name);
          throw new Error("review crashed");
        },
        async (current) => {
          skipped.push(current.name);
        },
        async (current) => {
          failed.push(current.name);
        },
      ),
    ).toBe(false);
    expect(executed).toEqual(["review"]);
    expect(failed).toEqual(["review"]);
    expect(skipped).toEqual(["publish"]);
  });
});
