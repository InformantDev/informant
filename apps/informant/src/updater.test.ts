import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CommandResult } from "./process.ts";
import {
  automaticUpdateLockPath,
  compareVersions,
  disableAutomaticUpdates,
  enableAutomaticUpdates,
  type InformantRelease,
  installLinuxRelease,
  latestInformantRelease,
  linuxAutomaticUpdatePaths,
  renderAutomaticUpdateService,
  renderLinuxAutomaticUpdateService,
  renderLinuxAutomaticUpdateTimer,
  reportedInformantVersion,
  resolveInformantExecutable,
  updateInformantIfAvailable,
  updaterEnvironment,
} from "./updater.ts";

const result = (exitCode = 0, stderr = "", stdout = ""): CommandResult => ({
  exitCode,
  stdout,
  stderr,
  timedOut: false,
});

function releaseResponse(version: string, assets: InformantRelease["assets"] = []): Response {
  return Response.json({
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: assets.map((asset) => ({
      name: asset.name,
      browser_download_url: asset.url,
    })),
  });
}

describe("release updates", () => {
  test("compares stable semantic versions", () => {
    expect(compareVersions("0.1.10", "0.1.2")).toBe(1);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-beta.2", "1.0.0")).toBe(-1);
  });

  test("reads the client version from version output that also reports a server", () => {
    expect(reportedInformantVersion("0.2.0\nserver: 0.1.4\n")).toBe("0.2.0");
    expect(reportedInformantVersion("server: 0.1.4\n")).toBeUndefined();
  });

  test("reads the latest stable GitHub release", async () => {
    const current = await latestInformantRelease(async () =>
      releaseResponse("0.2.0", [{ name: "informant-linux-x64", url: "https://release/binary" }]),
    );
    expect(current).toEqual({
      tag: "v0.2.0",
      version: "0.2.0",
      assets: [{ name: "informant-linux-x64", url: "https://release/binary" }],
    });
  });

  test("bounds release metadata requests with an abort deadline", async () => {
    let signal: AbortSignal | null | undefined;
    await latestInformantRelease(async (_input, init) => {
      signal = init?.signal;
      return releaseResponse("0.2.0");
    });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  test("rejects suffix-tagged releases even when GitHub does not mark them prerelease", async () => {
    await expect(latestInformantRelease(async () => releaseResponse("0.2.0-beta"))).rejects.toThrow(
      "invalid stable release version",
    );
  });

  test("uses Homebrew's stable path on macOS and the running binary on Linux", () => {
    const operations = {
      processExecutable: "/opt/homebrew/Cellar/informant/0.2.0/bin/informant",
      which: () => "/opt/homebrew/bin/informant",
    };
    expect(resolveInformantExecutable("darwin", undefined, operations)).toBe(
      "/opt/homebrew/bin/informant",
    );
    expect(resolveInformantExecutable("linux", undefined, operations)).toBe(
      "/opt/homebrew/Cellar/informant/0.2.0/bin/informant",
    );
  });

  test("uses a stable PATH symlink for the running Linux executable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "informant-path-test-"));
    const cellar = join(directory, "Cellar", "informant", "0.2.0", "bin");
    const bin = join(directory, "bin");
    const running = join(cellar, "informant");
    const stable = join(bin, "informant");
    try {
      await Promise.all([mkdir(cellar, { recursive: true }), mkdir(bin)]);
      await Bun.write(running, "executable");
      await symlink(running, stable);
      expect(
        resolveInformantExecutable("linux", undefined, {
          processExecutable: running,
          which: () => stable,
        }),
      ).toBe(stable);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("does nothing when the installed version is current", async () => {
    let commands = 0;
    expect(
      await updateInformantIfAvailable("0.2.0", {
        pendingRestartFile: join(tmpdir(), `informant-update-${crypto.randomUUID()}`),
        fetch: async () => releaseResponse("0.2.0"),
        command: async () => {
          commands++;
          return result();
        },
      }),
    ).toEqual({ updated: false, restarted: false, version: "0.2.0" });
    expect(commands).toBe(0);
  });

  test("installs a newer Linux release without starting an inactive worker", async () => {
    let installed = "";
    const commands: string[][] = [];
    expect(
      await updateInformantIfAvailable("0.1.2", {
        platform: "linux",
        pendingRestartFile: join(tmpdir(), `informant-update-${crypto.randomUUID()}`),
        fetch: async () => releaseResponse("0.2.0"),
        installLinux: async (release) => {
          installed = release.version;
        },
        command: async (argv) => {
          commands.push(argv);
          return result(3, "inactive");
        },
      }),
    ).toEqual({ updated: true, restarted: false, version: "0.2.0" });
    expect(installed).toBe("0.2.0");
    expect(commands).toEqual([
      ["systemctl", "--user", "is-active", "informant.service"],
      ["systemctl", "--user", "show", "--property=MainPID", "--value", "informant.service"],
    ]);
  });

  test("verifies that Homebrew installed the release before reporting success", async () => {
    const commands: string[][] = [];
    let brewTimeout: number | undefined;
    expect(
      await updateInformantIfAvailable("0.1.2", {
        platform: "darwin",
        uid: 501,
        pendingRestartFile: join(tmpdir(), `informant-update-${crypto.randomUUID()}`),
        fetch: async () => releaseResponse("0.2.0"),
        command: async (argv, options) => {
          commands.push(argv);
          if (argv[0] === "brew") brewTimeout = options?.timeoutMs;
          if (argv[1] === "print") return result(113);
          if (argv[0] === "informant") return result(0, "", "0.2.0\nserver: 0.1.4\n");
          return result();
        },
      }),
    ).toEqual({ updated: true, restarted: false, version: "0.2.0" });
    expect(commands).toEqual([
      ["launchctl", "print", "gui/501/dev.informant.worker"],
      ["brew", "upgrade", "informantdev/tap/informant"],
      ["informant", "--version"],
      ["launchctl", "print", "gui/501/dev.informant.worker"],
    ]);
    expect(brewTimeout).toBe(60 * 60_000);
  });

  test("reports a timed-out Homebrew upgrade", async () => {
    await expect(
      updateInformantIfAvailable("0.1.2", {
        platform: "darwin",
        uid: 501,
        pendingRestartFile: join(tmpdir(), `informant-update-${crypto.randomUUID()}`),
        fetch: async () => releaseResponse("0.2.0"),
        command: async (argv) =>
          argv[1] === "print"
            ? result(113)
            : argv[0] === "brew"
              ? { ...result(143), timedOut: true }
              : result(),
      }),
    ).rejects.toThrow("timed out after 60 minutes");
  });

  test("waits for the Homebrew formula when it still installs the old version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "informant-update-test-"));
    try {
      await expect(
        updateInformantIfAvailable("0.1.2", {
          platform: "darwin",
          uid: 501,
          pendingRestartFile: join(directory, "pending-restart"),
          fetch: async () => releaseResponse("0.2.0"),
          command: async (argv) =>
            argv[1] === "print"
              ? result(113)
              : argv[0] === "informant"
                ? result(0, "", "0.1.2\n")
                : result(),
        }),
      ).rejects.toThrow("formula may still be updating");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("updates a Linux Homebrew installation through Homebrew", async () => {
    const directory = await mkdtemp(join(tmpdir(), "informant-update-test-"));
    const cellar = join(directory, "Cellar", "informant", "0.1.2");
    const prefix = join(directory, "opt", "informant");
    const executable = join(cellar, "bin", "informant");
    const stableExecutable = join(prefix, "bin", "informant");
    const pendingRestartFile = join(directory, "pending-restart");
    const commands: string[][] = [];
    try {
      await mkdir(join(cellar, "bin"), { recursive: true });
      await mkdir(join(directory, "opt"), { recursive: true });
      await Bun.write(executable, "Homebrew-managed executable");
      await symlink(cellar, prefix);

      expect(
        await updateInformantIfAvailable("0.1.2", {
          platform: "linux",
          executable,
          pendingRestartFile,
          fetch: async () => releaseResponse("0.2.0"),
          command: async (argv) => {
            commands.push(argv);
            if (argv[0] === "systemctl") return result(3, "inactive");
            if (argv[0] === "brew" && argv[1] === "--prefix") {
              return result(0, "", `${prefix}\n`);
            }
            if (argv[0] === stableExecutable) {
              return result(0, "", "0.2.0\nserver: 0.1.4\n");
            }
            return result();
          },
        }),
      ).toEqual({ updated: true, restarted: false, version: "0.2.0" });
      expect(commands).toContainEqual(["brew", "--prefix", "informantdev/tap/informant"]);
      expect(commands).toContainEqual(["brew", "upgrade", "informantdev/tap/informant"]);
      expect(commands).toContainEqual([stableExecutable, "--version"]);
      expect(await Bun.file(executable).text()).toBe("Homebrew-managed executable");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("does not replace a Homebrew-managed binary when its probe fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "informant-update-test-"));
    const executable = join(directory, "Cellar", "informant", "0.1.2", "bin", "informant");
    try {
      await mkdir(dirname(executable), { recursive: true });
      await Bun.write(executable, "Homebrew-managed executable");
      await expect(
        updateInformantIfAvailable("0.1.2", {
          platform: "linux",
          executable,
          pendingRestartFile: join(directory, "pending-restart"),
          fetch: async () => releaseResponse("0.2.0"),
          command: async (argv) =>
            argv[0] === "brew" ? result(1, "temporary Homebrew failure") : result(3, "inactive"),
        }),
      ).rejects.toThrow("temporary Homebrew failure");
      expect(await Bun.file(executable).text()).toBe("Homebrew-managed executable");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("serializes concurrent updater transactions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "informant-update-lock-"));
    const pendingRestartFile = join(directory, "pending-restart");
    let requests = 0;
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const request = async () => {
      requests++;
      if (requests === 1) {
        firstEntered();
        await firstBlocked;
      }
      return releaseResponse("0.2.0");
    };
    try {
      const first = updateInformantIfAvailable("0.2.0", {
        pendingRestartFile,
        fetch: request,
      });
      await entered;
      const second = updateInformantIfAvailable("0.2.0", {
        pendingRestartFile,
        fetch: request,
      });
      await Bun.sleep(25);
      expect(requests).toBe(1);
      releaseFirst();
      await Promise.all([first, second]);
      expect(requests).toBe(2);
    } finally {
      releaseFirst();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("serializes updates across different data directories with one per-user lock", async () => {
    const firstData = await mkdtemp(join(tmpdir(), "informant-update-data-a-"));
    const secondData = await mkdtemp(join(tmpdir(), "informant-update-data-b-"));
    const lock = join(tmpdir(), `informant-update-${crypto.randomUUID()}.lock`);
    let requests = 0;
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const request = async () => {
      requests++;
      if (requests === 1) {
        firstEntered();
        await firstBlocked;
      }
      return releaseResponse("0.2.0");
    };
    try {
      const first = updateInformantIfAvailable("0.2.0", {
        pendingRestartFile: join(firstData, "pending-restart"),
        updateLockDirectory: lock,
        fetch: request,
      });
      await entered;
      const second = updateInformantIfAvailable("0.2.0", {
        pendingRestartFile: join(secondData, "pending-restart"),
        updateLockDirectory: lock,
        fetch: request,
      });
      await Bun.sleep(25);
      expect(requests).toBe(1);
      releaseFirst();
      await Promise.all([first, second]);
      expect(requests).toBe(2);
    } finally {
      releaseFirst();
      await Promise.all([
        rm(firstData, { recursive: true, force: true }),
        rm(secondData, { recursive: true, force: true }),
        rm(lock, { recursive: true, force: true }),
      ]);
    }
  });

  test("uses a fixed per-user updater lock independent of the data directory", () => {
    expect(automaticUpdateLockPath("/home/worker")).toBe(
      "/home/worker/.cache/informant/updater.lock",
    );
  });

  test("reclaims stale updater locks without an abandonable recovery mutex", async () => {
    const directory = await mkdtemp(join(tmpdir(), "informant-update-lock-"));
    const lock = join(directory, "update.lock");
    const recovery = `${lock}.recovery`;
    try {
      await mkdir(lock, { mode: 0o700 });
      await Bun.write(
        join(lock, "owner.json"),
        JSON.stringify({ pid: 2_147_483_647, token: "abandoned" }),
      );
      await mkdir(recovery, { mode: 0o700 });

      expect(
        await updateInformantIfAvailable("0.2.0", {
          pendingRestartFile: join(directory, "pending-restart"),
          updateLockDirectory: lock,
          fetch: async () => releaseResponse("0.2.0"),
        }),
      ).toEqual({ updated: false, restarted: false, version: "0.2.0" });
      expect(await Bun.file(lock).exists()).toBe(false);
      expect(await Bun.file(recovery).exists()).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reclaims a lock whose PID was recycled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "informant-update-lock-"));
    const lock = join(directory, "update.lock");
    try {
      await mkdir(lock, { mode: 0o700 });
      await Bun.write(
        join(lock, "owner.json"),
        JSON.stringify({
          pid: process.pid,
          processIdentity: "linux:stale",
          token: "abandoned",
        }),
      );
      expect(
        await updateInformantIfAvailable("0.2.0", {
          pendingRestartFile: join(directory, "pending-restart"),
          updateLockDirectory: lock,
          fetch: async () => releaseResponse("0.2.0"),
        }),
      ).toEqual({ updated: false, restarted: false, version: "0.2.0" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("verifies and atomically installs a published Linux binary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "informant-update-test-"));
    const executable = join(directory, "informant");
    const binary = new TextEncoder().encode("new executable");
    const checksum = createHash("sha256").update(binary).digest("hex");
    const release: InformantRelease = {
      tag: "v0.2.0",
      version: "0.2.0",
      assets: [
        { name: "informant-linux-x64", url: "https://release/binary" },
        { name: "SHA256SUMS", url: "https://release/checksums" },
      ],
    };
    try {
      await Bun.write(executable, "old executable");
      await installLinuxRelease(release, {
        arch: "x64",
        executable,
        command: async () => result(0, "", "0.2.0\nserver: 0.1.4\n"),
        fetch: async (input, init) => {
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          const url = String(input);
          return url.endsWith("binary")
            ? new Response(binary)
            : new Response(`${checksum}  informant-linux-x64\n`);
        },
      });
      expect(await Bun.file(executable).text()).toBe("new executable");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("does not replace Linux with a correctly checksummed but invalid binary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "informant-update-test-"));
    const executable = join(directory, "informant");
    const binary = new TextEncoder().encode("broken executable");
    const checksum = createHash("sha256").update(binary).digest("hex");
    const release: InformantRelease = {
      tag: "v0.2.0",
      version: "0.2.0",
      assets: [
        { name: "informant-linux-x64", url: "https://release/binary" },
        { name: "SHA256SUMS", url: "https://release/checksums" },
      ],
    };
    try {
      await Bun.write(executable, "old executable");
      await expect(
        installLinuxRelease(release, {
          arch: "x64",
          executable,
          command: async () => result(126, "cannot execute"),
          fetch: async (input) =>
            String(input).endsWith("binary")
              ? new Response(binary)
              : new Response(`${checksum}  informant-linux-x64\n`),
        }),
      ).rejects.toThrow("downloaded binary reported cannot execute instead of 0.2.0");
      expect(await Bun.file(executable).text()).toBe("old executable");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("retries a pending worker restart without reinstalling the current version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "informant-update-test-"));
    const pendingRestartFile = join(directory, "pending-restart");
    let installs = 0;
    let phase: "install" | "retry" = "install";
    let retryServiceChecks = 0;
    const run = async (argv: string[]) => {
      if (argv[0] === "systemctl" && argv[2] === "is-active") return result();
      if (argv[0] === "systemctl" && argv[2] === "show") {
        if (phase === "retry") retryServiceChecks++;
        return result(0, "", phase === "retry" && retryServiceChecks > 1 ? "200\n" : "100\n");
      }
      if (argv[0] === "kill" && phase === "install") return result(1, "temporary restart failure");
      return result();
    };
    try {
      await expect(
        updateInformantIfAvailable("0.1.2", {
          platform: "linux",
          pendingRestartFile,
          fetch: async () => releaseResponse("0.2.0"),
          installLinux: async () => {
            installs++;
          },
          command: run,
        }),
      ).rejects.toThrow("temporary restart failure");
      expect(await Bun.file(pendingRestartFile).text()).toBe("0.2.0\n");

      phase = "retry";
      expect(
        await updateInformantIfAvailable("0.2.0", {
          platform: "linux",
          pendingRestartFile,
          fetch: async () => releaseResponse("0.2.0"),
          installLinux: async () => {
            installs++;
          },
          command: run,
          sleep: async () => {},
        }),
      ).toEqual({ updated: false, restarted: true, version: "0.2.0" });
      expect(installs).toBe(1);
      expect(await Bun.file(pendingRestartFile).exists()).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("records a pending restart before installing the replacement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "informant-update-test-"));
    const pendingRestartFile = join(directory, "pending-restart");
    let replacementInstalled = false;
    try {
      await expect(
        updateInformantIfAvailable("0.1.2", {
          platform: "linux",
          pendingRestartFile,
          fetch: async () => releaseResponse("0.2.0"),
          installLinux: async () => {
            replacementInstalled = true;
            expect(await Bun.file(pendingRestartFile).text()).toBe("0.2.0\n");
            throw new Error("simulated crash after replacement");
          },
          command: async () => result(3, "inactive"),
        }),
      ).rejects.toThrow("simulated crash after replacement");
      expect(replacementInstalled).toBe(true);
      expect(await Bun.file(pendingRestartFile).text()).toBe("0.2.0\n");

      expect(
        await updateInformantIfAvailable("0.2.0", {
          platform: "linux",
          pendingRestartFile,
          fetch: async () => releaseResponse("0.2.0"),
          installLinux: async () => {
            throw new Error("must not reinstall while retrying the restart");
          },
          command: async () => result(3, "inactive"),
        }),
      ).toEqual({ updated: false, restarted: false, version: "0.2.0" });
      expect(await Bun.file(pendingRestartFile).exists()).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects a Linux binary that does not match the release checksum", async () => {
    const directory = await mkdtemp(join(tmpdir(), "informant-update-test-"));
    const executable = join(directory, "informant");
    const release: InformantRelease = {
      tag: "v0.2.0",
      version: "0.2.0",
      assets: [
        { name: "informant-linux-x64", url: "https://release/binary" },
        { name: "SHA256SUMS", url: "https://release/checksums" },
      ],
    };
    try {
      await Bun.write(executable, "old executable");
      await expect(
        installLinuxRelease(release, {
          arch: "x64",
          executable,
          fetch: async (input) =>
            String(input).endsWith("binary")
              ? new Response("modified")
              : new Response(`${"0".repeat(64)}  informant-linux-x64\n`),
        }),
      ).rejects.toThrow("checksum verification failed");
      expect(await Bun.file(executable).text()).toBe("old executable");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("automatic update services", () => {
  test("renders a six-hour launchd update check with the captured environment", () => {
    const service = renderAutomaticUpdateService(
      "/opt/Informant & tools/informant",
      { HOME: "/Users/worker", PATH: "/opt/tools&more/bin" },
      "/tmp/informant logs",
    );
    expect(service).toContain("<string>dev.informant.updater</string>");
    expect(service).toContain("<string>/opt/Informant &amp; tools/informant</string>");
    expect(service).toContain("<string>--automatic</string>");
    expect(service).toContain("<key>StartInterval</key>\n  <integer>21600</integer>");
    expect(service).toContain("/tmp/informant logs/updater.stderr.log");
  });

  test("renders a persistent six-hour systemd timer and oneshot updater", () => {
    const service = renderLinuxAutomaticUpdateService("/opt/Informant tools/informant", {
      HOME: "/home/worker",
      PATH: "/usr/local/bin:/usr/bin",
    });
    const timer = renderLinuxAutomaticUpdateTimer();
    expect(service).toContain('ExecStart="/opt/Informant tools/informant" update --automatic');
    expect(service).toContain('Environment="HOME=/home/worker"');
    expect(service).toContain("TimeoutStartSec=25h");
    expect(timer).toContain("OnUnitInactiveSec=21600s");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("WantedBy=timers.target");
  });

  test("escapes control characters and dollar signs in automatic-update systemd values", () => {
    const service = renderLinuxAutomaticUpdateService(
      "/opt/$worker/Informant\n tools\t/informant",
      {
        VALUE: "$worker\nline two\r\ttail",
      },
    );
    expect(service).toContain(
      'ExecStart="/opt/$$worker/Informant\\n tools\\t/informant" update --automatic',
    );
    expect(service).toContain('Environment="VALUE=$worker\\nline two\\r\\ttail"');
  });

  test("preserves a custom data directory in the updater environment", () => {
    expect(
      updaterEnvironment(
        {
          PATH: "/usr/local/bin:/usr/bin",
          INFORMANT_DATA_DIR: "/srv/informant/data",
          INFORMANT_SECRET_TOKEN: "ignored",
        },
        "/home/worker",
      ),
    ).toEqual({
      HOME: "/home/worker",
      PATH: "/usr/local/bin:/usr/bin",
      INFORMANT_DATA_DIR: "/srv/informant/data",
    });
  });

  test("enables and disables the Linux automatic-update timer", async () => {
    const home = await mkdtemp(join(tmpdir(), "informant-update-home-"));
    const executable = join(home, "bin", "informant");
    const commands: string[][] = [];
    const run = async (argv: string[]) => {
      commands.push(argv);
      return result();
    };
    try {
      await mkdir(join(home, "bin"));
      await Bun.write(executable, "executable");
      const timer = await enableAutomaticUpdates({
        platform: "linux",
        home,
        executable,
        environment: { HOME: home, PATH: join(home, "bin") },
        command: run,
      });
      expect(timer).toBe(join(home, ".config/systemd/user/informant-update.timer"));
      expect(await Bun.file(timer).text()).toContain("OnUnitInactiveSec=21600s");
      expect(commands).toContainEqual([
        "systemctl",
        "--user",
        "enable",
        "--now",
        "informant-update.timer",
      ]);

      expect(
        await disableAutomaticUpdates({
          platform: "linux",
          home,
          command: run,
        }),
      ).toBe(true);
      expect(await Bun.file(timer).exists()).toBe(false);
      expect(commands).toContainEqual([
        "systemctl",
        "--user",
        "disable",
        "--now",
        "informant-update.timer",
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("enables and disables the macOS automatic-update agent", async () => {
    const home = await mkdtemp(join(tmpdir(), "informant-update-home-"));
    const executable = join(home, "informant");
    const logs = join(home, "logs");
    const commands: string[][] = [];
    const run = async (argv: string[]) => {
      commands.push(argv);
      return result();
    };
    try {
      await Bun.write(executable, "executable");
      const path = await enableAutomaticUpdates({
        platform: "darwin",
        home,
        logs,
        uid: 501,
        executable,
        environment: { HOME: home, PATH: home },
        command: run,
      });
      expect(path).toBe(join(home, "Library/LaunchAgents/dev.informant.updater.plist"));
      expect(await Bun.file(path).text()).toContain("<string>--automatic</string>");
      expect(commands).toContainEqual(["launchctl", "bootstrap", "gui/501", path]);

      expect(
        await disableAutomaticUpdates({
          platform: "darwin",
          home,
          uid: 501,
          command: run,
        }),
      ).toBe(true);
      expect(await Bun.file(path).exists()).toBe(false);
      expect(commands).toContainEqual(["launchctl", "bootout", "gui/501", path]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("removes an already-unloaded macOS automatic-update agent", async () => {
    const home = await mkdtemp(join(tmpdir(), "informant-update-home-"));
    const path = join(home, "Library/LaunchAgents/dev.informant.updater.plist");
    try {
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, "plist");

      expect(
        await disableAutomaticUpdates({
          platform: "darwin",
          home,
          uid: 501,
          command: async () => result(3, "Boot-out failed: 3: No such process"),
        }),
      ).toBe(true);
      expect(await Bun.file(path).exists()).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("preserves Linux definitions when the timer cannot be stopped", async () => {
    const home = await mkdtemp(join(tmpdir(), "informant-update-home-"));
    const executable = join(home, "bin", "informant");
    try {
      await mkdir(join(home, "bin"));
      await Bun.write(executable, "executable");
      const timer = await enableAutomaticUpdates({
        platform: "linux",
        home,
        executable,
        environment: { HOME: home, PATH: join(home, "bin") },
        command: async () => result(),
      });
      await expect(
        disableAutomaticUpdates({
          platform: "linux",
          home,
          command: async () => result(1, "timer is still active"),
        }),
      ).rejects.toThrow("timer is still active");
      expect(await Bun.file(timer).exists()).toBe(true);
      expect(
        await Bun.file(join(home, ".config/systemd/user/informant-update.service")).exists(),
      ).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("preserves the macOS definition when the agent cannot be stopped", async () => {
    const home = await mkdtemp(join(tmpdir(), "informant-update-home-"));
    const executable = join(home, "informant");
    try {
      await Bun.write(executable, "executable");
      const path = await enableAutomaticUpdates({
        platform: "darwin",
        home,
        logs: join(home, "logs"),
        uid: 501,
        executable,
        environment: { HOME: home, PATH: home },
        command: async () => result(),
      });
      await expect(
        disableAutomaticUpdates({
          platform: "darwin",
          home,
          uid: 501,
          command: async () => result(5, "agent is still loaded"),
        }),
      ).rejects.toThrow("agent is still loaded");
      expect(await Bun.file(path).exists()).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("places Linux units under an absolute XDG configuration home", () => {
    expect(
      linuxAutomaticUpdatePaths("/home/worker", {
        XDG_CONFIG_HOME: "/srv/worker-config",
      }),
    ).toEqual({
      service: "/srv/worker-config/systemd/user/informant-update.service",
      timer: "/srv/worker-config/systemd/user/informant-update.timer",
    });
    expect(
      linuxAutomaticUpdatePaths("/home/worker", {
        XDG_CONFIG_HOME: "relative-config",
      }),
    ).toEqual({
      service: "/home/worker/.config/systemd/user/informant-update.service",
      timer: "/home/worker/.config/systemd/user/informant-update.timer",
    });
  });

  test("restores existing Linux definitions when re-enabling fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "informant-update-home-"));
    const executable = join(home, "bin", "informant");
    const environment = { HOME: home, PATH: join(home, "bin") };
    const commands: string[][] = [];
    try {
      await mkdir(join(home, "bin"));
      await Bun.write(executable, "executable");
      const timer = await enableAutomaticUpdates({
        platform: "linux",
        home,
        executable,
        environment,
        command: async () => result(),
      });
      const service = join(dirname(timer), "informant-update.service");
      const previousTimer = await Bun.file(timer).text();
      const previousService = await Bun.file(service).text();

      await expect(
        enableAutomaticUpdates({
          platform: "linux",
          home,
          executable,
          environment: { ...environment, PATH: "/new/path" },
          command: async (argv) => {
            commands.push(argv);
            return argv[2] === "enable" ? result(1, "temporary user manager failure") : result();
          },
        }),
      ).rejects.toThrow("temporary user manager failure");
      expect(await Bun.file(timer).text()).toBe(previousTimer);
      expect(await Bun.file(service).text()).toBe(previousService);
      expect(commands).not.toContainEqual([
        "systemctl",
        "--user",
        "disable",
        "--now",
        "informant-update.timer",
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("disables a newly enabled Linux timer when starting it fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "informant-update-home-"));
    const executable = join(home, "bin", "informant");
    const commands: string[][] = [];
    try {
      await mkdir(join(home, "bin"));
      await Bun.write(executable, "executable");
      await expect(
        enableAutomaticUpdates({
          platform: "linux",
          home,
          executable,
          environment: { HOME: home, PATH: join(home, "bin") },
          command: async (argv) => {
            commands.push(argv);
            if (argv[2] === "is-enabled") return result(1, "disabled");
            if (argv[2] === "enable") return result(1, "timer failed to start");
            return result();
          },
        }),
      ).rejects.toThrow("timer failed to start");
      expect(commands).toContainEqual([
        "systemctl",
        "--user",
        "disable",
        "--now",
        "informant-update.timer",
      ]);
      expect(
        await Bun.file(join(home, ".config/systemd/user/informant-update.timer")).exists(),
      ).toBe(false);
      expect(
        await Bun.file(join(home, ".config/systemd/user/informant-update.service")).exists(),
      ).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
