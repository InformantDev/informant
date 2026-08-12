import { expect, test } from "bun:test";
import {
  configureAutomaticUpdatesDuringSetup,
  installPrivilegedPackages,
  prepareAppleContainer,
  preparePodman,
} from "./setup.ts";

const success = (stdout = "") => ({
  exitCode: 0,
  stdout,
  stderr: "",
  timedOut: false,
});
const rootlessPodmanInfo = JSON.stringify({
  host: { security: { rootless: true }, cgroupVersion: "v2" },
});

test("records automatic updates as disabled when setup has no systemd user manager", async () => {
  const preferences: boolean[] = [];
  const warnings: string[] = [];

  await configureAutomaticUpdatesDuringSetup({
    preference: async () => undefined,
    prompt: async () => true,
    enable: async () => {
      throw new Error("Linux requires a running systemd user manager");
    },
    savePreference: async (enabled) => {
      preferences.push(enabled);
    },
    warn: (message) => warnings.push(message),
  });

  expect(preferences).toEqual([false]);
  expect(warnings).toEqual([
    expect.stringContaining("Run informant auto-update enable after resolving the service-manager"),
  ]);
});

async function completePodmanSmoke(args: string[]): Promise<void> {
  if (args[1] !== "run") return;
  const volume = args[args.indexOf("--volume") + 1];
  const workspace = volume?.slice(0, volume.indexOf(":/workspace"));
  if (workspace) await Bun.write(`${workspace}/informant-smoke-test`, "ready\n");
}

test("installs, starts, and smoke tests Apple Container when missing", async () => {
  const commands: string[][] = [];
  let installedPackage = "";
  await prepareAppleContainer({
    platform: "darwin",
    arch: "arm64",
    installPackage: async (path) => {
      installedPackage = path;
    },
    command: async (args) => {
      commands.push(args);
      if (args[0] === "container" && args[1] === "--version")
        return { ...success(), exitCode: 127 };
      if (args[0] === "/usr/bin/shasum")
        return success(
          "0ca1c42a2269c2557efb1d82b1b38ac553e6a3a3da1b1179c439bcee1e7d6714  package.pkg\n",
        );
      if (args[1] === "system" && args[2] === "status" && commands.length < 6)
        return { ...success(), exitCode: 1 };
      return success();
    },
  });

  expect(installedPackage).toContain("informant-container-install-");
  expect(commands.some((args) => args.includes("--enable-kernel-install"))).toBe(true);
  expect(commands.at(-1)?.slice(0, 4)).toEqual(["container", "run", "--rm", "oven/bun:1"]);
});

test("reuses a healthy Apple Container installation", async () => {
  const commands: string[][] = [];
  let installed = false;
  await prepareAppleContainer({
    installPackage: async () => {
      installed = true;
    },
    command: async (args) => {
      commands.push(args);
      return success();
    },
  });

  expect(installed).toBe(false);
  expect(commands).toEqual([
    ["container", "--version"],
    ["container", "system", "status", "--format", "json"],
    ["container", "run", "--rm", "oven/bun:1", "bun", "--version"],
  ]);
});

test("rejects a modified Apple Container package", async () => {
  expect(
    prepareAppleContainer({
      platform: "darwin",
      arch: "arm64",
      command: async (args) => {
        if (args[0] === "container") return { ...success(), exitCode: 127 };
        if (args[0] === "/usr/bin/shasum") return success("wrong  package.pkg\n");
        return success();
      },
    }),
  ).rejects.toThrow("checksum did not match");
});

test("installs packages directly as root and through sudo otherwise", async () => {
  const rootCommands: string[][] = [];
  await installPrivilegedPackages([["apt-get", "update"]], {
    uid: 0,
    run: async (argv) => {
      rootCommands.push(argv);
      return 0;
    },
  });
  const userCommands: string[][] = [];
  await installPrivilegedPackages([["dnf", "install", "-y", "podman"]], {
    uid: 1000,
    run: async (argv) => {
      userCommands.push(argv);
      return 0;
    },
  });
  expect(rootCommands).toEqual([["apt-get", "update"]]);
  expect(userCommands).toEqual([["sudo", "dnf", "install", "-y", "podman"]]);
});

test("installs Debian rootless Podman packages and smoke tests a qualified image", async () => {
  const commands: string[][] = [];
  let installCommands: string[][] = [];
  await preparePodman({
    osRelease: 'ID=ubuntu\nID_LIKE="debian"\n',
    installPackages: async (value) => {
      installCommands = value;
    },
    command: async (args) => {
      commands.push(args);
      if (args[1] === "--version" && commands.length === 1) return { ...success(), exitCode: 127 };
      if (args[1] === "info") return success(rootlessPodmanInfo);
      await completePodmanSmoke(args);
      return success();
    },
  });
  expect(installCommands).toEqual([
    ["apt-get", "update"],
    ["apt-get", "install", "-y", "podman", "uidmap", "slirp4netns", "fuse-overlayfs"],
  ]);
  expect(commands.at(-1)).toEqual([
    "podman",
    "run",
    "--rm",
    "--init",
    "--ulimit",
    "nofile=65536:65536",
    "--workdir",
    "/workspace",
    "--user",
    "0:0",
    "--cpus",
    "1",
    "--memory",
    "256M",
    "--security-opt",
    "no-new-privileges",
    "--volume",
    expect.stringContaining(":/workspace:Z"),
    "--entrypoint",
    "/bin/sh",
    "docker.io/oven/bun:1",
    "-lc",
    "bun --version && touch /workspace/informant-smoke-test",
  ]);
  const finalCommand = commands.at(-1) ?? [];
  const volume = finalCommand[finalCommand.indexOf("--volume") + 1] ?? "";
  expect(await Bun.file(volume.slice(0, volume.indexOf(":/workspace"))).exists()).toBe(false);
});

test("reuses healthy rootless Podman without installing packages", async () => {
  let installed = false;
  await preparePodman({
    installPackages: async () => {
      installed = true;
    },
    command: async (args) => {
      if (args[1] === "info") return success(rootlessPodmanInfo);
      await completePodmanSmoke(args);
      return success();
    },
  });
  expect(installed).toBe(false);
});

test("installs Fedora rootless Podman packages with dnf", async () => {
  let installCommands: string[][] = [];
  let versions = 0;
  await preparePodman({
    osRelease: "ID=fedora\n",
    installPackages: async (value) => {
      installCommands = value;
    },
    command: async (args) => {
      if (args[1] === "--version" && versions++ === 0) return { ...success(), exitCode: 127 };
      if (args[1] === "info") return success(rootlessPodmanInfo);
      await completePodmanSmoke(args);
      return success();
    },
  });
  expect(installCommands).toEqual([
    ["dnf", "install", "-y", "podman", "shadow-utils", "slirp4netns", "fuse-overlayfs"],
  ]);
});

test("rejects rootful Podman before the smoke test", async () => {
  const commands: string[][] = [];
  await expect(
    preparePodman({
      command: async (args) => {
        commands.push(args);
        return args[1] === "info"
          ? success(JSON.stringify({ host: { security: { rootless: false } } }))
          : success();
      },
    }),
  ).rejects.toThrow("not running rootless");
  expect(commands.some((args) => args[1] === "run")).toBe(false);
});

test("reports a failed Podman smoke test", async () => {
  let workspace = "";
  await expect(
    preparePodman({
      command: async (args) => {
        if (args[1] === "info") return success(rootlessPodmanInfo);
        if (args[1] === "run") {
          const volume = args[args.indexOf("--volume") + 1] ?? "";
          workspace = volume.slice(0, volume.indexOf(":/workspace"));
          return { ...success(), exitCode: 125, stderr: "pull failed" };
        }
        return success();
      },
    }),
  ).rejects.toThrow("rootless Podman could not run the Informant default image: pull failed");
  expect(await Bun.file(workspace).exists()).toBe(false);
});

test("bounds the Podman smoke test and reports a timeout", async () => {
  let timeoutMs: number | undefined;
  await expect(
    preparePodman({
      command: async (args, options) => {
        if (args[1] === "info") return success(rootlessPodmanInfo);
        if (args[1] === "run") {
          timeoutMs = options?.timeoutMs;
          return { ...success(), timedOut: true };
        }
        return success();
      },
    }),
  ).rejects.toThrow("rootless Podman could not run the Informant default image: timed out");
  expect(timeoutMs).toBe(120_000);
});

test("rejects a smoke test that cannot write through the bind mount", async () => {
  await expect(
    preparePodman({
      command: async (args) => (args[1] === "info" ? success(rootlessPodmanInfo) : success()),
    }),
  ).rejects.toThrow("could not write to a bind-mounted workspace");
});
