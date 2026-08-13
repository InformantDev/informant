import { describe, expect, test } from "bun:test";
import { parseConfig, selectManuallyTriggeredJobs, selectTriggeredJobs } from "./config.ts";
import { triggerMatches } from "./triggers.ts";

const source = (triggers: string, jobTriggers = "") => `version = 1
triggers = ${triggers}
[vm]
image = "image"
[[jobs]]
name = "dependency"
command = "dep"
triggers = []
[[jobs]]
name = "root"
command = "root"
needs = ["dependency"]
${jobTriggers}`;

describe("trigger configuration", () => {
  test("jobs inherit, replace, and explicitly disable top-level triggers", () => {
    const inherited = parseConfig(source('[{ event = "comment" }]'));
    expect(inherited.jobs[1]?.triggers).toEqual(inherited.triggers);
    const replaced = parseConfig(
      source('[{ event = "commit" }]', 'triggers = [{ event = "comment" }]'),
    );
    expect(replaced.jobs[1]?.triggers?.[0]?.event).toBe("comment");
    expect(inherited.jobs[0]?.triggers).toEqual([]);
  });

  test("validates event and mutually exclusive context", () => {
    expect(() => parseConfig(source('[{ event = "push" }]'))).toThrow("commit or comment");
    expect(() =>
      parseConfig(source('[{ event = "comment", branch = { names = ["main"] } }]')),
    ).toThrow("comment cannot use branch");
    expect(() =>
      parseConfig(
        source('[{ event = "commit", branch = { names = ["main"] }, pull_request = {} }]'),
      ),
    ).toThrow("more than one");
    const tagged = parseConfig(source('[{ event = "commit", tag = { patterns = ["v*"] } }]'));
    expect(tagged.triggers?.[0]?.tag?.patterns).toEqual(["v*"]);
    expect(() =>
      parseConfig(source('[{ event = "comment", tag = { patterns = ["v*"] } }]')),
    ).toThrow("only be used with commit");
    for (const tag of ["{}", "{ patterns = [] }", '{ patterns = [""] }', '{ names = ["v*"] }']) {
      expect(() => parseConfig(source(`[{ event = "commit", tag = ${tag} }]`))).toThrow();
    }
  });

  test("legacy branches normalize and cannot coexist with triggers", () => {
    const legacy = parseConfig(
      source('[{ event = "commit" }]').replace(
        'triggers = [{ event = "commit" }]',
        'branches = ["release"]',
      ),
    );
    expect(legacy.triggers?.[0]?.branch?.names).toEqual(["release"]);
    expect(() =>
      parseConfig(source("[]").replace("triggers = []", 'triggers = []\nbranches = ["main"]')),
    ).toThrow("cannot both");
  });
});

test("matching roots include needs and PR filters are exact", () => {
  const config = parseConfig(
    source(
      '[{ event = "comment", pull_request = { state = "open", draft = false, base_branches = ["main"] } }]',
    ),
  );
  const pr = {
    number: 1,
    state: "open" as const,
    draft: false,
    baseBranch: "main",
    headSha: "sha",
    sameRepository: true,
  };
  const context = { type: "comment" as const, pullRequest: pr };
  const rule = config.triggers?.[0];
  expect(rule && triggerMatches(rule, context)).toBe(true);
  expect(
    selectTriggeredJobs(config, (rule) => triggerMatches(rule, context), "pull/1").jobs.map(
      (job) => job.name,
    ),
  ).toEqual(["dependency", "root"]);
  expect(
    rule &&
      triggerMatches(rule, {
        ...context,
        pullRequest: { ...pr, sameRepository: false },
      }),
  ).toBe(false);
});

test("job filters constrain automatic roots before dependencies are selected", () => {
  const config = parseConfig(
    source('[{ event = "commit" }]', 'filters = [{ branch = { names = ["main", "release"] } }]'),
  );
  const context = { type: "commit" as const, branch: "feature" };
  expect(
    selectTriggeredJobs(config, (rule) => triggerMatches(rule, context), "feature").jobs,
  ).toEqual([]);
  expect(
    selectTriggeredJobs(config, (rule) => triggerMatches(rule, context), context.branch).jobs.map(
      (job) => job.name,
    ),
  ).toEqual([]);
  const main = { ...context, branch: "main" };
  expect(
    selectTriggeredJobs(config, (rule) => triggerMatches(rule, main), main.branch).jobs.map(
      (job) => job.name,
    ),
  ).toEqual(["dependency", "root"]);
  for (const branch of [undefined, "pull/7"]) {
    expect(selectTriggeredJobs(config, () => true, branch).jobs).toEqual([]);
  }
  const unfiltered = {
    ...config,
    jobs: config.jobs.map((job) => ({ ...job, filters: [] })),
  };
  expect(
    selectTriggeredJobs(unfiltered, () => true, undefined).jobs.map((job) => job.name),
  ).toEqual(["dependency", "root"]);
});

test("commit context is optional and PR state, draft, and base filters compose", () => {
  const branchless = { event: "commit" as const };
  expect(triggerMatches(branchless, { type: "commit", branch: "release" })).toBe(true);

  const pullRequest = {
    number: 2,
    state: "closed" as const,
    draft: true,
    baseBranch: "release",
    headSha: "sha",
    sameRepository: true,
  };
  expect(
    triggerMatches(
      {
        event: "comment",
        pullRequest: { state: "all", draft: true, baseBranches: ["release"] },
      },
      { type: "comment", pullRequest },
    ),
  ).toBe(true);
  expect(
    triggerMatches(
      { event: "comment", pullRequest: { state: "open" } },
      { type: "comment", pullRequest },
    ),
  ).toBe(false);
});

test("manual branch runs exclude tag and comment triggers", () => {
  const config = parseConfig(`version = 1
triggers = []
[vm]
image = "image"
[[jobs]]
name = "generic"
command = "generic"
triggers = [{ event = "commit" }]
[[jobs]]
name = "feature"
command = "feature"
triggers = [{ event = "commit", branch = { names = ["feature"] } }]
[[jobs]]
name = "release"
command = "release"
triggers = [{ event = "commit", tag = { patterns = ["v*"] } }]
[[jobs]]
name = "pull-request"
command = "pull-request"
triggers = [{ event = "commit", pull_request = { state = "open" } }]
[[jobs]]
name = "comment"
command = "comment"
triggers = [{ event = "comment", pull_request = { state = "open" } }]
`);

  expect(selectManuallyTriggeredJobs(config, [], "feature").jobs.map((job) => job.name)).toEqual([
    "generic",
    "feature",
    "pull-request",
  ]);
  expect(selectManuallyTriggeredJobs(config, ["release"], "feature").jobs).toEqual([]);
});

test("tag triggers opt in and use whole-name case-sensitive globs across slashes", () => {
  const context = { type: "commit" as const, tag: "release/v1.2+final" };
  expect(triggerMatches({ event: "commit" }, context)).toBe(false);
  expect(
    triggerMatches({ event: "commit", branch: { names: ["release/v1.2+final"] } }, context),
  ).toBe(false);
  expect(triggerMatches({ event: "commit", tag: { patterns: ["release/v?.2+*"] } }, context)).toBe(
    true,
  );
  expect(triggerMatches({ event: "commit", tag: { patterns: ["v*"] } }, context)).toBe(false);
  expect(triggerMatches({ event: "commit", tag: { patterns: ["RELEASE/*"] } }, context)).toBe(
    false,
  );
});
