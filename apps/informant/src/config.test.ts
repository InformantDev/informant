import { describe, expect, test } from "bun:test";
import { configTemplate, parseConfig, parseRepository, selectJobs } from "./config.ts";

describe("configuration", () => {
  test("parses the generated template", () => {
    const config = parseConfig(configTemplate());
    expect(config.vm).toMatchObject({
      user: "admin",
      prepare:
        "curl -fsSL https://bun.sh/install | bash && sudo mkdir -p /usr/local/bin && sudo ln -sf $HOME/.bun/bin/bun /usr/local/bin/bun",
    });
    expect(config.jobs).toEqual([
      {
        name: "test",
        command: "bun install --frozen-lockfile && bun test",
        timeoutMinutes: 30,
        environment: {},
        needs: [],
        triggers: [{ event: "commit", branch: { names: ["main"] }, pullRequest: undefined }],
        cache: [{ paths: ["~/.bun/install/cache"], keyFiles: ["bun.lock"] }],
      },
    ]);
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
        parseConfig(configTemplate().replace("[vm]", `[vm]\n${field} = ${value}`)),
      ).toThrow(`vm.${field} must be a positive integer`);
    }
  });

  test("requires a non-empty VM image", () => {
    expect(() =>
      parseConfig(
        configTemplate().replace(
          'image = "ghcr.io/cirruslabs/macos-tahoe-base:latest"',
          'image = "   "',
        ),
      ),
    ).toThrow("vm.image must be a non-empty string");
  });

  test("validates VM credentials while allowing an explicitly empty password", () => {
    expect(
      parseConfig(
        configTemplate().replace(
          'user = "admin"\npassword = "admin"',
          'user = "builder"\npassword = ""',
        ),
      ).vm,
    ).toMatchObject({ user: "builder", password: "" });
    expect(() =>
      parseConfig(configTemplate().replace('user = "admin"', 'user = "-oProxyCommand=bad"')),
    ).toThrow("vm.user must be a valid account name");
    expect(() => parseConfig(configTemplate().replace('user = "admin"', "user = [1]"))).toThrow(
      "vm.user must be a valid account name",
    );
    expect(() =>
      parseConfig(configTemplate().replace('password = "admin"', "password = { value = 1 }")),
    ).toThrow("vm.password must be a string");
  });

  test("requires a non-empty VM preparation command", () => {
    expect(() => parseConfig(configTemplate().replace(/prepare = .+/, 'prepare = ""'))).toThrow(
      "vm.prepare must be a non-empty string",
    );
  });

  test("requires job environment to contain scalar values", () => {
    const withEnvironment = configTemplate().replace(
      "timeout_minutes = 30",
      'timeout_minutes = 30\nenvironment = { TEXT = "value", COUNT = 2, ENABLED = true }',
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
          "timeout_minutes = 30",
          'timeout_minutes = 30\nenvironment = { NESTED = { VALUE = "bad" } }',
        ),
      ),
    ).toThrow("environment must be a table of scalar values");
  });

  test("requires job environment keys to be shell variable names", () => {
    expect(() =>
      parseConfig(
        configTemplate().replace(
          "timeout_minutes = 30",
          'timeout_minutes = 30\nenvironment = { "BAD KEY" = "value" }',
        ),
      ),
    ).toThrow('environment key "BAD KEY" is not a shell variable');
    expect(() =>
      parseConfig(
        configTemplate().replace(
          "timeout_minutes = 30",
          'timeout_minutes = 30\nenvironment = { "$(touch /tmp/bad)" = "value" }',
        ),
      ),
    ).toThrow("is not a shell variable");
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
      { paths: ["~/.bun/install/cache"], keyFiles: ["bun.lock"] },
    ]);
    expect(
      parseConfig(
        configTemplate().replace(
          'cache = [{ paths = ["~/.bun/install/cache"], key_files = ["bun.lock"] }]',
          'cache = [{ paths = ["~/.bun/install/cache", "~/.cache/example"], key_files = ["bun.lock"] }, { paths = ["~/.cache/toolchain"], key_files = ["toolchain.toml"] }]',
        ),
      ).jobs[0]?.cache,
    ).toEqual([
      {
        paths: ["~/.bun/install/cache", "~/.cache/example"],
        keyFiles: ["bun.lock"],
      },
      { paths: ["~/.cache/toolchain"], keyFiles: ["toolchain.toml"] },
    ]);
    expect(() => parseConfig(configTemplate().replace('"~/.bun/install/cache"', '"/tmp"'))).toThrow(
      "paths must contain paths starting with ~/",
    );
    expect(() =>
      parseConfig(
        configTemplate().replace('key_files = ["bun.lock"]', 'key_files = ["../secret"]'),
      ),
    ).toThrow("key_files must be relative paths");
    expect(() =>
      parseConfig(
        configTemplate().replace(
          '{ paths = ["~/.bun/install/cache"], key_files = ["bun.lock"] }',
          '"invalid"',
        ),
      ),
    ).toThrow("must be a table");
    expect(() => parseConfig(configTemplate().replace('["bun.lock"]', '"bun.lock"'))).toThrow(
      "key_files must be relative paths",
    );
    expect(() => parseConfig(configTemplate().replace(/cache = .+/, "cache = []"))).toThrow(
      "cache must be a non-empty array",
    );
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
