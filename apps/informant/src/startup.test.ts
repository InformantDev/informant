import { describe, expect, test } from "bun:test";
import type { CommandResult } from "./process.ts";
import { renderStartupService, updateInformant } from "./startup.ts";

const result = (exitCode = 0, stderr = ""): CommandResult => ({
  exitCode,
  stdout: "",
  stderr,
  timedOut: false,
});

describe("startup service", () => {
  test("renders a persistent LaunchAgent with escaped paths and environment", () => {
    const service = renderStartupService(
      "/Applications/Informant & tools/informant",
      { PATH: "/opt/tools&more/bin", INFORMANT_CONFIG_FILE: "/tmp/config.json" },
      "/tmp/informant logs",
    );

    expect(service).toContain("<string>dev.informant.worker</string>");
    expect(service).toContain("<string>/Applications/Informant &amp; tools/informant</string>");
    expect(service).toContain("<string>serve</string>");
    expect(service).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(service).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(service).toContain(
      "<key>SoftResourceLimits</key>\n  <dict>\n    <key>NumberOfFiles</key>\n    <integer>65536</integer>",
    );
    expect(service).toContain("<string>/opt/tools&amp;more/bin</string>");
    expect(service).toContain("<string>/tmp/informant logs/worker.stderr.log</string>");
  });

  test("updates through Homebrew and restarts a loaded service", async () => {
    const invocations: string[][] = [];
    const updated = await updateInformant({
      platform: "darwin",
      uid: 501,
      command: async (argv) => {
        invocations.push(argv);
        return result();
      },
    });

    expect(updated).toEqual({ restarted: true });
    expect(invocations).toEqual([
      ["launchctl", "print", "gui/501/dev.informant.worker"],
      ["brew", "upgrade", "informant-ci/tap/informant"],
      ["launchctl", "kickstart", "-k", "gui/501/dev.informant.worker"],
    ]);
  });

  test("does not start a service that was not loaded before the update", async () => {
    const invocations: string[][] = [];
    const updated = await updateInformant({
      platform: "darwin",
      uid: 501,
      command: async (argv) => {
        invocations.push(argv);
        return argv[1] === "print" ? result(113) : result();
      },
    });

    expect(updated).toEqual({ restarted: false });
    expect(invocations).toEqual([
      ["launchctl", "print", "gui/501/dev.informant.worker"],
      ["brew", "upgrade", "informant-ci/tap/informant"],
    ]);
  });

  test("reports Homebrew and service restart failures separately", async () => {
    await expect(
      updateInformant({
        platform: "darwin",
        uid: 501,
        command: async (argv) =>
          argv[0] === "brew" ? result(1, "formula is not installed") : result(),
      }),
    ).rejects.toThrow("could not update Informant with Homebrew: formula is not installed");

    await expect(
      updateInformant({
        platform: "darwin",
        uid: 501,
        command: async (argv) =>
          argv[1] === "kickstart" ? result(1, "service unavailable") : result(),
      }),
    ).rejects.toThrow(
      "Informant was updated but its service could not be restarted: service unavailable",
    );
  });
});
