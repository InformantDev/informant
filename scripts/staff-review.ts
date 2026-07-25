import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute } from "@ampcode/sdk";

interface PullRequest {
  base: { sha: string };
  head: { sha: string };
}

interface Finding {
  path: string;
  line: number;
  priority: "P1" | "P2" | "P3";
  title: string;
  body: string;
}

function required(name: string): string {
  const value = Bun.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function github<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

export function parseFindings(value: string): Finding[] {
  const start = value.indexOf("[");
  const end = value.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("Amp did not return a JSON findings array");
  const parsed = JSON.parse(value.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("Amp findings must be an array");
  return parsed.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`finding ${index} must be an object`);
    }
    const finding = item as Record<string, unknown>;
    if (
      typeof finding.path !== "string" ||
      !finding.path ||
      !Number.isInteger(finding.line) ||
      Number(finding.line) <= 0 ||
      !["P1", "P2", "P3"].includes(String(finding.priority)) ||
      typeof finding.title !== "string" ||
      !finding.title.trim() ||
      typeof finding.body !== "string" ||
      !finding.body.trim()
    ) {
      throw new Error(`finding ${index} is invalid`);
    }
    return {
      path: finding.path,
      line: Number(finding.line),
      priority: finding.priority as Finding["priority"],
      title: finding.title.trim(),
      body: finding.body.trim(),
    };
  });
}

export function changedLines(diff: string): Map<string, Set<number>> {
  const lines = new Map<string, Set<number>>();
  let path: string | undefined;
  for (const line of diff.split("\n")) {
    if (line === "+++ /dev/null") {
      path = undefined;
      continue;
    }
    if (line.startsWith("+++ b/")) {
      path = line.slice(6);
      if (!lines.has(path)) lines.set(path, new Set());
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!path || !hunk) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const changed = lines.get(path);
    for (let number = start; changed && number < start + count; number++) changed.add(number);
  }
  return lines;
}

function validateAnchors(findings: Finding[], lines: Map<string, Set<number>>): Finding[] {
  const unique = new Map<string, Finding>();
  for (const finding of findings) {
    const changed = lines.get(finding.path);
    if (!changed?.has(finding.line)) {
      throw new Error(
        `Amp returned a finding outside the PR's changed lines: ${finding.path}:${finding.line}`,
      );
    }
    unique.set(`${finding.path}:${finding.line}:${finding.body}`, finding);
  }
  return [...unique.values()].slice(0, 50);
}

async function ampReview(baseSha: string, diff: string): Promise<string> {
  const prompt = `You are performing a staff/principal-level code review of a pull request.

Review only the following diff from ${baseSha}...HEAD:

<diff>
${diff}
</diff>

Review only the supplied diff; no repository tools are available. Focus on concrete,
actionable defects: correctness, edge cases, concurrency, security, data integrity, interfaces,
missing tests, maintainability, and material performance problems. Do not report style preferences,
speculation, or issues outside the diff. Every finding must anchor to a line added or changed on the
right side of the diff.

Return only a JSON array. Each item must have exactly:
{"path":"relative/file.ts","line":123,"priority":"P1|P2|P3","title":"short title","body":"concise Markdown explanation and smallest fix"}
Return [] when there are no findings.`;
  const sandbox = await mkdtemp(join(tmpdir(), "informant-review-"));
  const home = join(sandbox, "home");
  await mkdir(home);
  await Bun.write(join(sandbox, "settings.json"), "{}\n");
  try {
    const expectedCwd = await realpath(sandbox);
    let initialized = false;
    for await (const message of execute({
      prompt,
      options: {
        cwd: sandbox,
        mode: "high",
        visibility: "private",
        enabledTools: [],
        settingsFile: join(sandbox, "settings.json"),
        env: {
          HOME: home,
          XDG_CONFIG_HOME: join(home, ".config"),
        },
      },
    })) {
      if (message.type === "system") {
        if (
          initialized ||
          message.tools.length > 0 ||
          message.mcp_servers.length > 0 ||
          (await realpath(message.cwd)) !== expectedCwd
        ) {
          throw new Error("Amp started with unexpected tools or MCP servers");
        }
        initialized = true;
        continue;
      }
      if (!initialized)
        throw new Error("Amp produced output before its initialization was verified");
      if (message.type !== "result") continue;
      if (message.subtype !== "success") throw new Error(message.error);
      return message.result;
    }
    throw new Error("Amp did not return a result");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const repository = required("INFORMANT_REPOSITORY");
  const sha = required("INFORMANT_SHA");
  const branch = required("INFORMANT_BRANCH");
  const pullRequestNumber = branch.match(/^pull\/(\d+)$/)?.[1];
  if (!pullRequestNumber) throw new Error("staff review can only run for a pull request");
  const githubToken = required("GITHUB_TOKEN");
  required("AMP_API_KEY");
  const reviewRoot = required("INFORMANT_REVIEW_ROOT");

  const pull = await github<PullRequest>(
    githubToken,
    `/repos/${repository}/pulls/${pullRequestNumber}`,
  );
  if (pull.head.sha !== sha) throw new Error("pull request head changed before review started");
  const marker = `<!-- informant-staff-review:${sha} -->`;
  for (let page = 1; ; page++) {
    const reviews = await github<Array<{ body?: string; commit_id: string }>>(
      githubToken,
      `/repos/${repository}/pulls/${pullRequestNumber}/reviews?per_page=100&page=${page}`,
    );
    if (reviews.some((review) => review.commit_id === sha && review.body?.includes(marker))) {
      console.log("Staff review already exists for this commit");
      return;
    }
    if (reviews.length < 100) break;
  }

  const diffProcess = Bun.spawn(
    ["git", "diff", "--unified=0", "--no-color", `${pull.base.sha}...HEAD`, "--"],
    {
      cwd: reviewRoot,
      env: Object.fromEntries(
        Object.entries(Bun.env).filter(([name]) => !["AMP_API_KEY", "GITHUB_TOKEN"].includes(name)),
      ),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [diff, diffError, diffExit] = await Promise.all([
    new Response(diffProcess.stdout).text(),
    new Response(diffProcess.stderr).text(),
    diffProcess.exited,
  ]);
  if (diffExit !== 0) throw new Error(`could not read pull request diff: ${diffError}`);

  // The review agent needs the Amp credential, but not GitHub write access.
  delete Bun.env.GITHUB_TOKEN;
  const result = await ampReview(pull.base.sha, diff);
  const findings = validateAnchors(parseFindings(result), changedLines(diff));
  if (findings.length === 0) {
    console.log("Staff review found no actionable issues");
    return;
  }

  await github(githubToken, `/repos/${repository}/pulls/${pullRequestNumber}/reviews`, {
    method: "POST",
    body: JSON.stringify({
      commit_id: sha,
      event: "COMMENT",
      body: `Automated Staff Review by Informant.\n\n${marker}`,
      comments: findings.map((finding) => ({
        path: finding.path,
        line: finding.line,
        side: "RIGHT",
        body: `**${finding.priority}: ${finding.title}**\n\n${finding.body}`,
      })),
    }),
  });
  console.log(`Posted ${findings.length} inline review comment${findings.length === 1 ? "" : "s"}`);
}

if (import.meta.main) await main();
