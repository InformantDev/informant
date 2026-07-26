import { expect, test } from "bun:test";
import { prepareAppleContainer } from "./setup.ts";

const success = (stdout = "") => ({
  exitCode: 0,
  stdout,
  stderr: "",
  timedOut: false,
});

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
