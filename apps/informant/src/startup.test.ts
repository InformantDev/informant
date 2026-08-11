import { describe, expect, test } from "bun:test";
import type { CommandResult } from "./process.ts";
import {
  linuxStartupServicePath,
  parseStartupEnvironment,
  renderLinuxStartupService,
  renderStartupService,
  restartStartupWorker,
  startupEnvironment,
  updateInformant,
} from "./startup.ts";

const result = (exitCode = 0, stderr = "", stdout = ""): CommandResult => ({
  exitCode,
  stdout,
  stderr,
  timedOut: false,
});

describe("startup service", () => {
  test("preserves the environment captured in an existing property list", () => {
    expect(
      parseStartupEnvironment(
        JSON.stringify({ PATH: "/captured/bin", INFORMANT_SECRET_TOKEN: "captured-secret" }),
      ),
    ).toEqual({ PATH: "/captured/bin", INFORMANT_SECRET_TOKEN: "captured-secret" });
    expect(() => parseStartupEnvironment("[]")).toThrow("invalid property list");
  });

  test("keeps the Linux unit discoverable while preserving the machine config location", () => {
    expect(
      startupEnvironment(
        {
          PATH: "/usr/local/bin:/usr/bin",
          XDG_CONFIG_HOME: "/srv/informant/config",
          INFORMANT_CAPABILITIES: "linux-builder",
          UNRELATED: "ignored",
        },
        "/home/worker",
      ),
    ).toEqual({
      HOME: "/home/worker",
      PATH: "/usr/local/bin:/usr/bin",
      XDG_CONFIG_HOME: "/srv/informant/config",
      INFORMANT_CAPABILITIES: "linux-builder",
    });
    expect(linuxStartupServicePath("/home/worker")).toBe(
      "/home/worker/.config/systemd/user/informant.service",
    );
  });

  test("uses the default Linux configuration location for invalid XDG paths", () => {
    for (const value of ["", "relative/config"]) {
      expect(startupEnvironment({ XDG_CONFIG_HOME: value }, "/home/worker")).toEqual({
        HOME: "/home/worker",
        PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      });
    }
  });

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
    expect(service).toContain("<key>ExitTimeOut</key>\n  <integer>86400</integer>");
    expect(service).toContain(
      "<key>SoftResourceLimits</key>\n  <dict>\n    <key>NumberOfFiles</key>\n    <integer>65536</integer>",
    );
    expect(service).toContain("<string>/opt/tools&amp;more/bin</string>");
    expect(service).toContain("<string>/tmp/informant logs/worker.stderr.log</string>");
  });

  test("renders a persistent systemd user service with escaped paths and environment", () => {
    const service = renderLinuxStartupService(
      "/opt/Informant tools/informant",
      {
        PATH: "/opt/tools/bin",
        INFORMANT_CONFIG_FILE: '/tmp/config%file".json',
        INFORMANT_GITHUB_PRIVATE_KEY:
          "-----BEGIN PRIVATE KEY-----\nline\tvalue\r\n-----END PRIVATE KEY-----",
      },
      "/tmp/informant logs",
    );

    expect(service).toContain('ExecStart="/opt/Informant tools/informant" serve');
    expect(service).toContain('Environment="INFORMANT_CONFIG_FILE=/tmp/config%%file\\".json"');
    expect(service).toContain(
      'Environment="INFORMANT_GITHUB_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\\nline\\tvalue\\r\\n-----END PRIVATE KEY-----"',
    );
    expect(service).toContain("Restart=always\nRestartSec=10");
    expect(service).toContain("TimeoutStopSec=24h");
    expect(service).toContain("LimitNOFILE=65536");
    expect(service).toContain("StandardOutput=append:/tmp/informant logs/worker.stdout.log");
    expect(service).toContain("StandardError=append:/tmp/informant logs/worker.stderr.log");
    expect(service).toContain("WantedBy=default.target");
  });

  test("restarts an active Linux worker without starting an inactive service", async () => {
    const activeCommands: string[][] = [];
    expect(
      await restartStartupWorker({
        platform: "linux",
        command: async (argv) => {
          activeCommands.push(argv);
          return result();
        },
      }),
    ).toBe(true);
    expect(activeCommands).toEqual([
      ["systemctl", "--user", "is-active", "--quiet", "informant.service"],
      ["systemctl", "--user", "restart", "informant.service"],
    ]);

    const inactiveCommands: string[][] = [];
    expect(
      await restartStartupWorker({
        platform: "linux",
        command: async (argv) => {
          inactiveCommands.push(argv);
          return result(3);
        },
      }),
    ).toBe(false);
    expect(inactiveCommands).toEqual([
      ["systemctl", "--user", "is-active", "--quiet", "informant.service"],
    ]);
  });

  test("updates through Homebrew and restarts a loaded service", async () => {
    const invocations: string[][] = [];
    let serviceChecks = 0;
    let sleeps = 0;
    let definitions = 0;
    const updated = await updateInformant({
      platform: "darwin",
      uid: 501,
      command: async (argv) => {
        invocations.push(argv);
        if (argv[0] === "plutil") {
          return result(0, "", JSON.stringify({ PATH: "/captured/bin" }));
        }
        if (argv[1] === "print") {
          serviceChecks++;
          return result(0, "", `pid = ${serviceChecks < 5 ? 100 : 200}`);
        }
        return result();
      },
      sleep: async () => {
        sleeps++;
      },
      restartTimeoutMs: 5_000,
      writeStartupService: async (environment) => {
        expect(environment).toEqual({ PATH: "/captured/bin" });
        definitions++;
      },
    });

    expect(updated).toEqual({ restarted: true });
    expect(sleeps).toBe(2);
    expect(definitions).toBe(1);
    expect(invocations).toEqual([
      ["launchctl", "print", "gui/501/dev.informant.worker"],
      ["brew", "upgrade", "informantdev/tap/informant"],
      ["launchctl", "print", "gui/501/dev.informant.worker"],
      ["plutil", "-extract", "EnvironmentVariables", "json", "-o", "-", expect.any(String)],
      ["kill", "-TERM", "100"],
      ["launchctl", "print", "gui/501/dev.informant.worker"],
      ["launchctl", "print", "gui/501/dev.informant.worker"],
      ["launchctl", "print", "gui/501/dev.informant.worker"],
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
      ["brew", "upgrade", "informantdev/tap/informant"],
    ]);
  });

  test("updates through Homebrew and restarts an active Linux service", async () => {
    const invocations: string[][] = [];
    const updated = await updateInformant({
      platform: "linux",
      command: async (argv) => {
        invocations.push(argv);
        return result();
      },
    });

    expect(updated).toEqual({ restarted: true });
    expect(invocations).toEqual([
      ["systemctl", "--user", "is-active", "--quiet", "informant.service"],
      ["brew", "upgrade", "informantdev/tap/informant"],
      ["systemctl", "--user", "restart", "informant.service"],
    ]);
  });

  test("does not start an inactive Linux service after updating", async () => {
    const invocations: string[][] = [];
    const updated = await updateInformant({
      platform: "linux",
      command: async (argv) => {
        invocations.push(argv);
        return argv[2] === "is-active" ? result(3) : result();
      },
    });

    expect(updated).toEqual({ restarted: false });
    expect(invocations).toEqual([
      ["systemctl", "--user", "is-active", "--quiet", "informant.service"],
      ["brew", "upgrade", "informantdev/tap/informant"],
    ]);
  });

  test("reports Linux service restart failures after updating", async () => {
    await expect(
      updateInformant({
        platform: "linux",
        command: async (argv) =>
          argv[2] === "restart" ? result(1, "user manager unavailable") : result(),
      }),
    ).rejects.toThrow(
      "Informant was updated but its service could not be restarted: user manager unavailable",
    );
  });

  test("starts and verifies a loaded service that temporarily has no worker PID", async () => {
    const invocations: string[][] = [];
    let serviceChecks = 0;
    const updated = await updateInformant({
      platform: "darwin",
      uid: 501,
      command: async (argv) => {
        invocations.push(argv);
        if (argv[0] === "plutil") return result(0, "", "{}");
        if (argv[1] !== "print") return result();
        serviceChecks++;
        return result(0, "", serviceChecks === 2 ? "" : `pid = ${serviceChecks === 1 ? 100 : 200}`);
      },
      writeStartupService: async () => {},
    });

    expect(updated).toEqual({ restarted: true });
    expect(invocations).toContainEqual(["launchctl", "kickstart", "gui/501/dev.informant.worker"]);
  });

  test("fails when the replacement worker does not start before the graceful restart deadline", async () => {
    const invocations: string[][] = [];
    await expect(
      updateInformant({
        platform: "darwin",
        uid: 501,
        command: async (argv) => {
          invocations.push(argv);
          return argv[0] === "plutil"
            ? result(0, "", "{}")
            : argv[1] === "print"
              ? result(0, "", "pid = 100")
              : result();
        },
        sleep: async () => {},
        restartTimeoutMs: 2_000,
        writeStartupService: async () => {},
      }),
    ).rejects.toThrow("graceful restart did not complete within 2 seconds");
    expect(invocations).toContainEqual(["kill", "-KILL", "100"]);
  });

  test("reports Homebrew and service restart failures separately", async () => {
    await expect(
      updateInformant({
        platform: "darwin",
        uid: 501,
        command: async (argv) =>
          argv[0] === "brew" ? result(1, "formula is not installed") : result(0, "", "pid = 100"),
      }),
    ).rejects.toThrow("could not update Informant with Homebrew: formula is not installed");

    await expect(
      updateInformant({
        platform: "darwin",
        uid: 501,
        command: async (argv) =>
          argv[0] === "plutil"
            ? result(0, "", "{}")
            : argv[0] === "kill"
              ? result(1, "service unavailable")
              : result(0, "", "pid = 100"),
        writeStartupService: async () => {},
      }),
    ).rejects.toThrow(
      "Informant was updated but its service could not be restarted: service unavailable",
    );
  });
});
