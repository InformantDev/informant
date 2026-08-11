import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CommandResult } from "./process.ts";
import {
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
  resolveInformantExecutable,
  updateInformantIfAvailable,
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
    assets: assets.map((asset) => ({ name: asset.name, browser_download_url: asset.url })),
  });
}

describe("release updates", () => {
  test("compares stable semantic versions", () => {
    expect(compareVersions("0.1.10", "0.1.2")).toBe(1);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-beta.2", "1.0.0")).toBe(-1);
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

  test("does nothing when the installed version is current", async () => {
    let commands = 0;
    expect(
      await updateInformantIfAvailable("0.2.0", {
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
    expect(commands).toEqual([["systemctl", "--user", "is-active", "informant.service"]]);
  });

  test("verifies that Homebrew installed the release before reporting success", async () => {
    const commands: string[][] = [];
    expect(
      await updateInformantIfAvailable("0.1.2", {
        platform: "darwin",
        uid: 501,
        fetch: async () => releaseResponse("0.2.0"),
        command: async (argv) => {
          commands.push(argv);
          if (argv[1] === "print") return result(113);
          if (argv[0] === "informant") return result(0, "", "0.2.0\n");
          return result();
        },
      }),
    ).toEqual({ updated: true, restarted: false, version: "0.2.0" });
    expect(commands).toEqual([
      ["launchctl", "print", "gui/501/dev.informant.worker"],
      ["brew", "upgrade", "informantdev/tap/informant"],
      ["informant", "--version"],
    ]);
  });

  test("waits for the Homebrew formula when it still installs the old version", async () => {
    await expect(
      updateInformantIfAvailable("0.1.2", {
        platform: "darwin",
        uid: 501,
        fetch: async () => releaseResponse("0.2.0"),
        command: async (argv) =>
          argv[1] === "print"
            ? result(113)
            : argv[0] === "informant"
              ? result(0, "", "0.1.2\n")
              : result(),
      }),
    ).rejects.toThrow("formula may still be updating");
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
        command: async () => result(0, "", "0.2.0\n"),
        fetch: async (input) => {
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
    expect(service).toContain("TimeoutStartSec=24h");
    expect(timer).toContain("OnUnitInactiveSec=21600s");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("WantedBy=timers.target");
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

      expect(await disableAutomaticUpdates({ platform: "linux", home, command: run })).toBe(true);
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
        await disableAutomaticUpdates({ platform: "darwin", home, uid: 501, command: run }),
      ).toBe(true);
      expect(await Bun.file(path).exists()).toBe(false);
      expect(commands).toContainEqual(["launchctl", "bootout", "gui/501", path]);
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
      linuxAutomaticUpdatePaths("/home/worker", { XDG_CONFIG_HOME: "relative-config" }),
    ).toEqual({
      service: "/home/worker/.config/systemd/user/informant-update.service",
      timer: "/home/worker/.config/systemd/user/informant-update.timer",
    });
  });

  test("restores existing Linux definitions when re-enabling fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "informant-update-home-"));
    const executable = join(home, "bin", "informant");
    const environment = { HOME: home, PATH: join(home, "bin") };
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
          command: async (argv) =>
            argv[2] === "enable" ? result(1, "temporary user manager failure") : result(),
        }),
      ).rejects.toThrow("temporary user manager failure");
      expect(await Bun.file(timer).text()).toBe(previousTimer);
      expect(await Bun.file(service).text()).toBe(previousService);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
