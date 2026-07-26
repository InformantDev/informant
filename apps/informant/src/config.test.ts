import { describe, expect, test } from "bun:test";
import {
  directoryConfigTemplate,
  jobTemplate,
  parseConfig,
  parseConfigFiles,
  parseRepository,
  selectJobs,
} from "./config.ts";

const configTemplate = () => `${directoryConfigTemplate()}
[[jobs]]
name = "test"
command = "bun install --frozen-lockfile && bun test"
cache = [{ paths = ["~/.bun/install/cache"], shared = true }]
`;

const vmConfigTemplate = () =>
  configTemplate().replace(
    '[container]\nimage = "oven/bun:1"',
    `[vm]
image = "ghcr.io/cirruslabs/macos-tahoe-base:latest"
os = "macos"
user = "admin"
password = "admin"
prepare = """
set -euo pipefail
curl -fsSL https://bun.sh/install | bash
sudo mkdir -p /usr/local/bin
sudo ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun
"""`,
  );

describe("configuration", () => {
  test("parses the generated template", () => {
    const config = parseConfig(configTemplate());
    expect(directoryConfigTemplate()).not.toContain("poll_interval_seconds");
    expect(config.pollIntervalSeconds).toBe(30);
    expect(config.vm).toMatchObject({ guestOs: "macos", user: "admin" });
    expect(config.jobs).toEqual([
      {
        name: "test",
        command: "bun install --frozen-lockfile && bun test",
        timeoutMinutes: 60,
        environment: {},
        secrets: [],
        needs: [],
        triggers: [
          { event: "commit", branch: { names: ["main"] }, tag: undefined, pullRequest: undefined },
        ],
        cache: [{ paths: ["~/.bun/install/cache"], keyFiles: [], shared: true }],
        runtime: {
          type: "container",
          image: "oven/bun:1",
          cpu: undefined,
          memoryMb: undefined,
        },
      },
    ]);
  });

  test("combines directory defaults with independently parsed job files", () => {
    const config = parseConfigFiles(directoryConfigTemplate(), [
      { path: ".informant/jobs/test.toml", source: jobTemplate() },
      {
        path: ".informant/jobs/build.toml",
        source: 'name = "build"\ncommand = "bun run build"\nneeds = ["test"]',
      },
    ]);
    expect(config.jobs.map((job) => job.name)).toEqual(["test", "build"]);
    expect(config.jobs[0]?.command).toBe("bun install --frozen-lockfile && bun test");
    expect(config.jobs[1]?.needs).toEqual(["test"]);
    expect(config.jobs.every((job) => job.timeoutMinutes === 60)).toBe(true);
  });

  test("parses GitHub repository forms", () => {
    expect(parseRepository("https://github.com/acme/widgets.git").fullName).toBe("acme/widgets");
    expect(parseRepository("git@github.com:acme/widgets.git").fullName).toBe("acme/widgets");
    expect(parseRepository("ssh://git@github.com/acme/widgets.git").fullName).toBe("acme/widgets");
    expect(parseRepository("acme/widgets").fullName).toBe("acme/widgets");
  });

  test("requires jobs", () => {
    expect(() => parseConfig('version = 1\n[vm]\nimage = "vm"')).toThrow("at least one");
  });

  test("requires non-empty job names and commands", () => {
    expect(() => parseConfig(configTemplate().replace('name = "test"', 'name = "   "'))).toThrow(
      "name and command fields must be non-empty",
    );
    expect(() =>
      parseConfig(
        configTemplate().replace(
          'command = "bun install --frozen-lockfile && bun test"',
          'command = ""',
        ),
      ),
    ).toThrow("name and command fields must be non-empty");
  });

  test("requires configuration version 1", () => {
    expect(() =>
      parseConfig(configTemplate().replace("version = 1", 'version = "invalid"')),
    ).toThrow("version must be 1");
    expect(() => parseConfig(configTemplate().replace("version = 1", "version = 2"))).toThrow(
      "version must be 1",
    );
  });

  test("requires positive integer VM resources", () => {
    for (const [field, value] of [
      ["cpu", "-1"],
      ["cpu", '"invalid"'],
      ["memory_mb", "1.5"],
      ["memory_mb", "0"],
    ]) {
      expect(() =>
        parseConfig(vmConfigTemplate().replace("[vm]", `[vm]\n${field} = ${value}`)),
      ).toThrow(`vm.${field} must be a positive integer`);
    }
  });

  test("requires a non-empty VM image", () => {
    expect(() =>
      parseConfig(
        vmConfigTemplate().replace(
          'image = "ghcr.io/cirruslabs/macos-tahoe-base:latest"',
          'image = "   "',
        ),
      ),
    ).toThrow("vm.image must be a non-empty string");
  });

  test("defaults the guest OS to macOS and accepts Linux", () => {
    expect(parseConfig(vmConfigTemplate().replace('os = "macos"\n', "")).vm.guestOs).toBe("macos");
    expect(parseConfig(vmConfigTemplate().replace('os = "macos"', 'os = "linux"')).vm.guestOs).toBe(
      "linux",
    );
    expect(() => parseConfig(vmConfigTemplate().replace('os = "macos"', 'os = "windows"'))).toThrow(
      'vm.os must be "macos" or "linux"',
    );
  });

  test("validates VM credentials while allowing an explicitly empty password", () => {
    expect(
      parseConfig(
        vmConfigTemplate().replace(
          'user = "admin"\npassword = "admin"',
          'user = "builder"\npassword = ""',
        ),
      ).vm,
    ).toMatchObject({ user: "builder", password: "" });
    expect(() =>
      parseConfig(vmConfigTemplate().replace('user = "admin"', 'user = "-oProxyCommand=bad"')),
    ).toThrow("vm.user must be a valid account name");
    expect(() => parseConfig(vmConfigTemplate().replace('user = "admin"', "user = [1]"))).toThrow(
      "vm.user must be a valid account name",
    );
    expect(() =>
      parseConfig(vmConfigTemplate().replace('password = "admin"', "password = { value = 1 }")),
    ).toThrow("vm.password must be a string");
  });

  test("requires a non-empty VM preparation command", () => {
    expect(() =>
      parseConfig(vmConfigTemplate().replace(/prepare = """[\s\S]*?"""/, 'prepare = ""')),
    ).toThrow("vm.prepare must be a non-empty string");
  });

  test("parses container defaults and per-job VM overrides", () => {
    const source = configTemplate()
      .replace('image = "oven/bun:1"', 'image = "oven/bun:1"\ncpu = 1.5\nmemory_mb = 512')
      .replace(
        'cache = [{ paths = ["~/.bun/install/cache"], shared = true }]',
        'cache = [{ paths = ["~/.bun/install/cache"], shared = true }]\nvm = { image = "macos", os = "macos", cpu = 4 }',
      );
    expect(parseConfig(source).jobs[0]?.runtime).toMatchObject({
      type: "vm",
      image: "macos",
      guestOs: "macos",
      cpu: 4,
    });
    const containerOnly = source.replace(/\nvm = \{[^\n]+\}/, "");
    expect(parseConfig(containerOnly).jobs[0]?.runtime).toEqual({
      type: "container",
      image: "oven/bun:1",
      cpu: 1.5,
      memoryMb: 512,
    });
    expect(() => parseConfig(containerOnly.replace('image = "oven/bun:1"', 'image = ""'))).toThrow(
      "container.image must be a non-empty string",
    );
  });

  test("parses container overrides and validates runtime tables", () => {
    const source = configTemplate().replace(
      'cache = [{ paths = ["~/.bun/install/cache"], shared = true }]',
      'cache = []\ncontainer = { image = "oven/bun:1", cpu = 0.5 }',
    );
    expect(parseConfig(source).jobs[0]?.runtime).toEqual({
      type: "container",
      image: "oven/bun:1",
      cpu: 0.5,
      memoryMb: undefined,
    });
    expect(() =>
      parseConfig(
        source.replace('container = { image = "oven/bun:1", cpu = 0.5 }', "container = true"),
      ),
    ).toThrow("jobs[0].container must be a table");
  });

  test("jobs inherit and can override the top-level timeout", () => {
    expect(
      parseConfig(configTemplate().replace("timeout_minutes = 60", "timeout_minutes = 12")).jobs[0]
        ?.timeoutMinutes,
    ).toBe(12);
    expect(
      parseConfig(
        configTemplate().replace(
          'command = "bun install --frozen-lockfile && bun test"',
          'command = "bun install --frozen-lockfile && bun test"\ntimeout_minutes = 5',
        ),
      ).jobs[0]?.timeoutMinutes,
    ).toBe(5);
    expect(() =>
      parseConfig(configTemplate().replace("timeout_minutes = 60", "timeout_minutes = 0")),
    ).toThrow("timeout_minutes must be a positive number");
  });

  test("jobs inherit top-level environment and caches while allowing overrides", () => {
    const source = configTemplate()
      .replace(
        "timeout_minutes = 60",
        'timeout_minutes = 30\nenvironment = { CI = true, SHARED = "default" }\ncache = [{ paths = ["~/.cache/turbo"], shared = true }]',
      )
      .replace(
        'command = "bun install --frozen-lockfile && bun test"',
        'command = "bun install --frozen-lockfile && bun test"\nenvironment = { SHARED = "job" }',
      )
      .replace('cache = [{ paths = ["~/.bun/install/cache"], shared = true }]\n', "");
    const parsed = parseConfig(source).jobs[0];
    expect(parsed?.environment).toEqual({ CI: "true", SHARED: "job" });
    expect(parsed?.cache).toEqual([{ paths: ["~/.cache/turbo"], keyFiles: [], shared: true }]);
  });

  test("an explicit empty job cache opts out of inherited caches", () => {
    const source = configTemplate()
      .replace(
        "timeout_minutes = 60",
        'timeout_minutes = 30\ncache = [{ paths = ["~/.cache/turbo"], shared = true }]',
      )
      .replace('cache = [{ paths = ["~/.bun/install/cache"], shared = true }]', "cache = []");
    expect(parseConfig(source).jobs[0]?.cache).toEqual([]);
  });

  test("requires job environment to contain scalar values", () => {
    const withEnvironment = configTemplate().replace(
      'command = "bun install --frozen-lockfile && bun test"',
      'command = "bun install --frozen-lockfile && bun test"\nenvironment = { TEXT = "value", COUNT = 2, ENABLED = true }',
    );
    expect(parseConfig(withEnvironment).jobs[0]?.environment).toEqual({
      TEXT: "value",
      COUNT: "2",
      ENABLED: "true",
    });
    expect(() =>
      parseConfig(
        configTemplate().replace('name = "test"', 'name = "test"\nenvironment = ["bad"]'),
      ),
    ).toThrow("environment must be a table of scalar values");
    expect(() =>
      parseConfig(
        configTemplate().replace(
          'command = "bun install --frozen-lockfile && bun test"',
          'command = "bun install --frozen-lockfile && bun test"\nenvironment = { NESTED = { VALUE = "bad" } }',
        ),
      ),
    ).toThrow("environment must be a table of scalar values");
  });

  test("requires job environment keys to be shell variable names", () => {
    expect(() =>
      parseConfig(
        configTemplate().replace(
          'command = "bun install --frozen-lockfile && bun test"',
          'command = "bun install --frozen-lockfile && bun test"\nenvironment = { "BAD KEY" = "value" }',
        ),
      ),
    ).toThrow('environment key "BAD KEY" is not a shell variable');
    expect(() =>
      parseConfig(
        configTemplate().replace(
          'command = "bun install --frozen-lockfile && bun test"',
          'command = "bun install --frozen-lockfile && bun test"\nenvironment = { "$(touch /tmp/bad)" = "value" }',
        ),
      ),
    ).toThrow("is not a shell variable");
  });

  test("parses and validates job secrets", () => {
    const configured = configTemplate().replace(
      'command = "bun install --frozen-lockfile && bun test"',
      'command = "bun install --frozen-lockfile && bun test"\nsecrets = ["AMP_API_KEY", "GITHUB_TOKEN"]',
    );
    expect(parseConfig(configured).jobs[0]?.secrets).toEqual(["AMP_API_KEY", "GITHUB_TOKEN"]);
    expect(() => parseConfig(configured.replace("GITHUB_TOKEN", "BAD KEY"))).toThrow(
      "secrets must contain shell variable names",
    );
    expect(() => parseConfig(configured.replace('"GITHUB_TOKEN"', '"AMP_API_KEY"'))).toThrow(
      "secrets must not contain duplicates",
    );
    expect(() =>
      parseConfig(
        configured.replace("secrets =", 'environment = { AMP_API_KEY = "bad" }\nsecrets ='),
      ),
    ).toThrow("also set in environment");
  });

  test("requires at least one non-empty legacy branch", () => {
    const legacy = configTemplate().replace(
      'triggers = [{ event = "commit", branch = { names = ["main"] } }]',
      'branches = ["main"]',
    );
    expect(() => parseConfig(legacy.replace('branches = ["main"]', "branches = []"))).toThrow(
      "branch.names must contain non-empty strings",
    );
    expect(() => parseConfig(legacy.replace('branches = ["main"]', 'branches = [""]'))).toThrow(
      "branch.names must contain non-empty strings",
    );
    expect(() => parseConfig(legacy.replace('branches = ["main"]', 'branches = ["   "]'))).toThrow(
      "branch.names must contain non-empty strings",
    );
  });

  test("parses and validates persistent job caches", () => {
    expect(parseConfig(configTemplate()).jobs[0]?.cache).toEqual([
      { paths: ["~/.bun/install/cache"], keyFiles: [], shared: true },
    ]);
    expect(
      parseConfig(
        configTemplate().replace(
          'cache = [{ paths = ["~/.bun/install/cache"], shared = true }]',
          'cache = [{ paths = ["~/.bun/install/cache", "~/.cache/example"], key_files = ["bun.lock"] }, { paths = ["~/.cache/toolchain"], key_files = ["toolchain.toml"] }]',
        ),
      ).jobs[0]?.cache,
    ).toEqual([
      {
        paths: ["~/.bun/install/cache", "~/.cache/example"],
        keyFiles: ["bun.lock"],
        shared: false,
      },
      { paths: ["~/.cache/toolchain"], keyFiles: ["toolchain.toml"], shared: false },
    ]);
    expect(() => parseConfig(configTemplate().replace('"~/.bun/install/cache"', '"/tmp"'))).toThrow(
      "paths must contain paths starting with ~/",
    );
    expect(() =>
      parseConfig(configTemplate().replace("shared = true", 'key_files = ["../secret"]')),
    ).toThrow("key_files must be relative paths");
    expect(() =>
      parseConfig(
        configTemplate().replace(
          '{ paths = ["~/.bun/install/cache"], shared = true }',
          '"invalid"',
        ),
      ),
    ).toThrow("must be a table");
    expect(() =>
      parseConfig(configTemplate().replace("shared = true", 'key_files = "bun.lock"')),
    ).toThrow("key_files must be relative paths");
    expect(() => parseConfig(configTemplate().replace("shared = true", 'shared = "yes"'))).toThrow(
      "shared must be a boolean",
    );
    expect(() =>
      parseConfig(
        configTemplate().replace("shared = true", 'shared = true, key_files = ["bun.lock"]'),
      ),
    ).toThrow("cannot combine shared and key_files");
    expect(() =>
      parseConfig(
        configTemplate().replace("timeout_minutes = 60", "timeout_minutes = 30\ncache = []"),
      ),
    ).toThrow("cache must be a non-empty array");
    expect(() =>
      parseConfig(configTemplate().replace('paths = ["~/.bun/install/cache"]', "paths = []")),
    ).toThrow("paths must contain paths starting with ~/");
    expect(() => parseConfig(configTemplate().replace(/cache = .+/, "cache = {}"))).toThrow(
      "cache must be a non-empty array",
    );
  });

  test("parses and validates job dependencies", () => {
    const source = `${configTemplate()}\n[[jobs]]\nname = "build"\ncommand = "bun run build"\nneeds = ["test"]\n`;
    expect(parseConfig(source).jobs[1]?.needs).toEqual(["test"]);
    expect(() => parseConfig(source.replace('["test"]', '["missing"]'))).toThrow("unknown job");
    expect(() => parseConfig(source.replace('needs = ["test"]', 'needs = ["build"]'))).toThrow(
      "dependency cycle",
    );
  });

  test("selects requested jobs and their transitive dependencies", () => {
    const source = `${configTemplate()}
[[jobs]]
name = "lint"
command = "bun run lint"

[[jobs]]
name = "build"
command = "bun run build"
needs = ["test"]

[[jobs]]
name = "deploy"
command = "bun run deploy"
needs = ["build"]
`;
    const config = parseConfig(source);
    expect(selectJobs(config, ["deploy"]).jobs.map((job) => job.name)).toEqual([
      "test",
      "build",
      "deploy",
    ]);
    expect(selectJobs(config, ["test", "lint"]).jobs.map((job) => job.name)).toEqual([
      "test",
      "lint",
    ]);
    expect(() => selectJobs(config, ["missing"])).toThrow("unknown job: missing");
  });
});
