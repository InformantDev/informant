import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
const installer = resolve(import.meta.dir, "../../../install.sh");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  options: {
    architecture?: string;
    runnable?: boolean;
    validChecksum?: boolean;
    version?: string;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "informant-installer-test-"));
  roots.push(root);
  const bin = join(root, "bin");
  const release = join(root, "release");
  const install = join(root, "install");
  await Promise.all([mkdir(bin), mkdir(release), mkdir(install)]);

  const target = ["aarch64", "arm64"].includes(options.architecture ?? "") ? "arm64" : "x64";
  const asset = `informant-linux-${target}`;
  const binary =
    options.runnable === false
      ? "#!/bin/sh\nexit 1\n"
      : `#!/bin/sh\nprintf '${options.version ?? "9.9.9"}\\n'\n`;
  await writeFile(join(release, asset), binary);
  await chmod(join(release, asset), 0o755);
  const digest = new Bun.CryptoHasher("sha256").update(binary).digest("hex");
  await writeFile(
    join(release, "SHA256SUMS"),
    `${options.validChecksum === false ? "0".repeat(64) : digest}  ${asset}\n`,
  );

  await writeFile(
    join(bin, "uname"),
    `#!/bin/sh\ncase "$1" in\n  -s) echo Linux ;;\n  -m) echo ${options.architecture ?? "x86_64"} ;;\nesac\n`,
  );
  await writeFile(
    join(bin, "curl"),
    `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--output" ]; then destination=$2; shift 2; continue; fi\n  url=$1; shift\ndone\ncp "$FAKE_RELEASE_DIR/\${url##*/}" "$destination"\n`,
  );
  await writeFile(
    join(bin, "systemctl"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FAKE_SYSTEMCTL_LOG"\nif [ "$2" = "is-active" ]; then exit "\${FAKE_SERVICE_ACTIVE:-3}"; fi\nexit 0\n`,
  );
  await Promise.all([
    chmod(join(bin, "uname"), 0o755),
    chmod(join(bin, "curl"), 0o755),
    chmod(join(bin, "systemctl"), 0o755),
  ]);

  return { root, bin, release, install, systemctlLog: join(root, "systemctl.log") };
}

async function runInstaller(
  paths: Awaited<ReturnType<typeof fixture>>,
  environment: Record<string, string> = {},
) {
  return Bun.$`sh ${installer}`
    .env({
      ...process.env,
      PATH: `${paths.bin}:${process.env.PATH}`,
      HOME: paths.root,
      INFORMANT_INSTALL_DIR: paths.install,
      INFORMANT_RELEASE_ROOT: "https://example.invalid/releases",
      FAKE_RELEASE_DIR: paths.release,
      FAKE_SYSTEMCTL_LOG: paths.systemctlLog,
      ...environment,
    })
    .quiet()
    .nothrow();
}

describe("Linux installer", () => {
  test("selects, verifies, and atomically installs the x64 binary", async () => {
    const paths = await fixture();
    const result = await runInstaller(paths);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(`Installed Informant 9.9.9 to ${paths.install}`);
    expect(await readFile(join(paths.install, "informant"), "utf8")).toContain("9.9.9");
    expect((await stat(join(paths.install, "informant"))).mode & 0o777).toBe(0o755);
  });

  test("does not replace an existing installation when verification fails", async () => {
    const paths = await fixture({ validChecksum: false });
    const installed = join(paths.install, "informant");
    await writeFile(installed, "existing installation");

    const result = await runInstaller(paths);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("checksum verification failed");
    expect(await readFile(installed, "utf8")).toBe("existing installation");
  });

  test("does not replace an existing installation when the downloaded binary cannot run", async () => {
    const paths = await fixture({ runnable: false });
    const installed = join(paths.install, "informant");
    await writeFile(installed, "existing installation");

    const result = await runInstaller(paths);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("the downloaded binary could not run");
    expect(await readFile(installed, "utf8")).toBe("existing installation");
  });

  test("does not install a binary that differs from the explicitly requested version", async () => {
    const paths = await fixture({ version: "9.9.9" });
    const installed = join(paths.install, "informant");
    await writeFile(installed, "existing installation");

    const result = await runInstaller(paths, { INFORMANT_VERSION: "v0.1.2" });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "the downloaded binary reports version 9.9.9 instead of 0.1.2",
    );
    expect(await readFile(installed, "utf8")).toBe("existing installation");
  });

  test("normalizes the v prefix when verifying an explicitly requested version", async () => {
    const paths = await fixture({ version: "0.1.2" });
    const result = await runInstaller(paths, { INFORMANT_VERSION: "v0.1.2" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Installed Informant 0.1.2");
  });

  test("restarts an active systemd user service after installing", async () => {
    const paths = await fixture();
    const result = await runInstaller(paths, { FAKE_SERVICE_ACTIVE: "0" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Restarted the active Informant worker");
    expect(await readFile(paths.systemctlLog, "utf8")).toBe(
      "--user is-active --quiet informant.service\n--user restart informant.service\n",
    );
  });

  test("selects the ARM64 release on aarch64 Linux", async () => {
    const paths = await fixture({ architecture: "aarch64" });
    const result = await runInstaller(paths);

    expect(result.exitCode).toBe(0);
    expect(await readFile(join(paths.install, "informant"), "utf8")).toContain("9.9.9");
  });

  test("rejects unsupported Linux architectures before downloading", async () => {
    const paths = await fixture({ architecture: "riscv64" });
    const result = await runInstaller(paths);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("unsupported architecture: riscv64");
  });
});
