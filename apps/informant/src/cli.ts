#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { mkdir, readdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { SelectPrompt } from "@clack/core";
import { cancel, intro, isCancel, outro, select, spinner, text } from "@clack/prompts";
import packageJson from "../package.json" with { type: "json" };
import {
  CONFIG_FILE,
  directoryConfigTemplate,
  JOBS_DIRECTORY,
  jobTemplate,
  parseConfigFiles,
  parseRepository,
  readConfig,
  selectJobs,
} from "./config.ts";
import { prunePreparedContainerImages } from "./container.ts";
import {
  containerBackendReadiness,
  initializeContainerBackend,
  selectContainerBackend,
} from "./container-backend.ts";
import { runCommit, runLocalCommit } from "./coordinator.ts";
import { GitHubClient } from "./github.ts";
import { installPostPushHook, uninstallPostPushHook } from "./hook.ts";
import { formatHousekeepingSummary, runHousekeeping } from "./housekeeping.ts";
import {
  addRepository,
  allowMount,
  listAllowedMounts,
  listGitHubCredentials,
  listRepositories,
  removeAllowedMount,
  removeRepository,
} from "./machine-config.ts";
import { command, requireCommand } from "./process.ts";
import { serveRepositories } from "./server.ts";
import { setup } from "./setup.ts";
import { disableStartup, enableStartup, updateInformant } from "./startup.ts";
import {
  assessDiskSpace,
  collectStorageReport,
  fileSystemSpace,
  formatBytes,
  formatStorageReport,
} from "./storage.ts";
import {
  dataDirectory,
  getBuild,
  jobLogPath,
  listActiveBuilds,
  listBuilds,
  reconcileBuildLiveness,
  removeOrphanedBuildWorkspaces,
} from "./store.ts";
import { ensurePreparedImage, listPreparedImages, prunePreparedImages } from "./tart/index.ts";
import type { Repository } from "./types.ts";

const HELP = `Informant ${packageJson.version} — background CI on your Linux and macOS machines

Usage:
  informant setup                        Add a private GitHub App for an account
  informant init                         Create .informant/ and register origin
  informant repo add [owner/repo]         Register a repository on this machine
  informant repo list                     List registered repositories
  informant repo remove [owner/repo]      Stop handling a repository
  informant mount allow <name> <file>     Allow jobs to request a host file by name
  informant mount list                    List allowed host file mounts
  informant mount remove <name>           Remove a host file from the allowlist
  informant serve [--once]                Poll all registered repositories
  informant run --local [--ref <ref>] [--job <name>]
                                        Run all or selected jobs locally
  informant trigger [--ref <ref>] [--job <name>]
                                        Trigger reported jobs for a commit
  informant image prepare                Prepare this repository's configured VM job images
  informant image list                   List Informant-prepared VM images
  informant image prune                  Delete unused prepared runtime images
  informant cache path                   Print the persistent job cache directory
  informant cache prune                  Delete keyed caches while preserving shared caches
  informant cache clear                  Delete all persistent job caches
  informant startup enable               Start the worker now and at login
  informant startup disable              Stop and remove the startup worker
  informant hook install                 Accelerate pushes with a pre-push hook
  informant hook uninstall               Remove Informant from the pre-push hook
  informant builds [--all]               List running builds or recent history
  informant logs [<build-id>]             Tail a build's logs or select a running job
  informant update                       Update with Homebrew and restart a running worker
  informant storage                      Show Informant disk usage and available space
  informant doctor                       Check host dependencies, auth, and disk space
  informant --version
`;

function parseArgs(argv: string[]): {
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
} {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  const setFlag = (name: string, value: string | boolean) => {
    if (name !== "job" || typeof value !== "string") {
      flags[name] = value;
      return;
    }
    const existing = flags[name];
    if (typeof existing === "string") flags[name] = [existing, value];
    else if (Array.isArray(existing)) existing.push(value);
    else flags[name] = value;
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (!value) continue;
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const [name, inline] = value.slice(2).split("=", 2);
    if (!name) continue;
    if (inline !== undefined) setFlag(name, inline);
    else {
      const next = argv[index + 1];
      if (next && !next.startsWith("-")) {
        setFlag(name, next);
        index++;
      } else setFlag(name, true);
    }
  }
  return { positional, flags };
}

function requestedJobs(value: string | boolean | string[] | undefined): string[] {
  if (value === undefined) return [];
  if (value === true) throw new Error("--job requires a job name");
  if (value === false) return [];
  return (Array.isArray(value) ? value : [value])
    .flatMap((item) => item.split(","))
    .map((item) => item.trim())
    .filter(Boolean);
}

export function cleanOrphanedBuildWorkspacesInBackground(
  cleanup: () => Promise<number> = removeOrphanedBuildWorkspaces,
  onMessage: (message: string) => void = console.log,
): void {
  void cleanup()
    .then((removed) => {
      if (removed > 0) {
        onMessage(
          `Cleaned ${removed} orphaned build ${removed === 1 ? "workspace" : "workspaces"}`,
        );
      }
    })
    .catch((error) => {
      onMessage(
        `Could not clean orphaned build workspaces: ${error instanceof Error ? error.message : error}`,
      );
    });
}

async function repositoryFromGit(): Promise<ReturnType<typeof parseRepository>> {
  const remote = await requireCommand(["git", "remote", "get-url", "origin"]);
  return parseRepository(remote.replace(/^git@github\.com:/, ""));
}

async function init(): Promise<void> {
  const path = resolve(CONFIG_FILE);
  if (existsSync(path)) throw new Error("Informant configuration already exists");
  const repository = await repositoryFromGit();
  intro("Informant setup");
  let jobs = "bun install --frozen-lockfile && bun test";
  if (process.stdin.isTTY) {
    const commandValue = await text({
      message: "What should the first CI job run?",
      initialValue: jobs,
      validate: (value) => (value?.trim() ? undefined : "A command is required"),
    });
    if (isCancel(commandValue)) {
      cancel("Setup cancelled.");
      return;
    }
    jobs = commandValue;
  }
  await mkdir(resolve(JOBS_DIRECTORY), { recursive: true });
  await Bun.write(path, directoryConfigTemplate());
  await Bun.write(
    resolve(JOBS_DIRECTORY, "test.toml"),
    jobTemplate().replace("bun install --frozen-lockfile && bun test", jobs),
  );
  const added = await addRepository(repository);
  outro(
    added
      ? `Created ${path} and registered ${repository.fullName}`
      : `Created ${path}; ${repository.fullName} was already registered`,
  );
}

async function configAtGitRef(sha: string) {
  const current = await command(["git", "show", `${sha}:${CONFIG_FILE}`]);
  if (current.exitCode === 0) {
    const entries = (
      await requireCommand(["git", "ls-tree", "-r", "--name-only", sha, "--", JOBS_DIRECTORY])
    )
      .split("\n")
      .filter((entry) => entry.endsWith(".toml"))
      .sort();
    return parseConfigFiles(
      current.stdout,
      await Promise.all(
        entries.map(async (path) => ({
          path,
          source: await requireCommand(["git", "show", `${sha}:${path}`]),
        })),
      ),
      `${CONFIG_FILE}@${sha.slice(0, 7)}`,
    );
  }
  throw new Error(`could not find ${CONFIG_FILE} at ${sha.slice(0, 7)}`);
}

export async function runManualHousekeeping(
  repository: Repository,
  operations: {
    listRepositories?: typeof listRepositories;
    housekeeping?: typeof runHousekeeping;
    onMessage?: (message: string) => void;
  } = {},
): Promise<void> {
  try {
    const repositories = await (operations.listRepositories ?? listRepositories)();
    if (!repositories.some((configured) => configured.fullName === repository.fullName)) {
      repositories.push(repository);
    }
    const summary = await (operations.housekeeping ?? runHousekeeping)(repositories);
    const message = formatHousekeepingSummary(summary);
    if (message) (operations.onMessage ?? console.log)(message);
  } catch {
    // Cleanup is best-effort, but must not run with an incomplete repository list.
  }
}

async function localRun(ref: string, branchOverride?: string, jobs: string[] = []): Promise<void> {
  if (branchOverride?.startsWith("refs/tags/")) {
    throw new Error("tag pushes are handled by the Informant service");
  }
  const repository = await repositoryFromGit();
  const sha = await requireCommand(["git", "rev-parse", ref]);
  const symbolicRef = await requireCommand(["git", "rev-parse", "--symbolic-full-name", ref]);
  const github = new GitHubClient({ repository });
  const config = await configAtGitRef(sha);
  selectJobs(config, jobs);
  const progress = spinner();
  progress.start(`Running ${repository.fullName}@${sha.slice(0, 7)}`);
  const clean = () => runManualHousekeeping(repository);
  const build = await runLocalCommit(
    repository,
    sha,
    branchOverride || executionLabelFromRef(ref, symbolicRef.trim()),
    config,
    {
      requestedJobs: jobs,
      runtimeSecrets: { GITHUB_TOKEN: () => github.createJobAccessToken(repository) },
    },
  );
  progress.stop(`${build.status}: ${build.id}`);
  await clean();
  if (build.status !== "success") process.exitCode = 1;
}

export function branchNameFromSymbolicRef(ref: string): string | undefined {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined;
}

export function executionLabelFromRef(ref: string, symbolicRef: string): string {
  return branchNameFromSymbolicRef(symbolicRef) || ref;
}

export function runInvocationType(local: boolean): "local" | "trigger" {
  return local ? "local" : "trigger";
}

async function manualTrigger(
  ref: string,
  branchOverride?: string,
  waitForGitHub = false,
  jobs: string[] = [],
): Promise<void> {
  if (branchOverride?.startsWith("refs/tags/")) {
    throw new Error("tag pushes are handled by the Informant service");
  }
  const repository = await repositoryFromGit();
  const sha = await requireCommand(["git", "rev-parse", ref]);
  const symbolicRef = await requireCommand(["git", "rev-parse", "--symbolic-full-name", ref]);
  const contextBranch = branchOverride || branchNameFromSymbolicRef(symbolicRef.trim());
  const displayBranch = branchOverride || executionLabelFromRef(ref, symbolicRef.trim());
  const github = new GitHubClient({ repository });
  if (waitForGitHub) await github.waitForCommit(repository, sha);
  const config = await configAtGitRef(sha);
  selectJobs(config, jobs);
  await github.createManualTrigger(repository, sha, jobs, contextBranch, displayBranch);
  const progress = spinner();
  progress.start(`Triggering ${repository.fullName}@${sha.slice(0, 7)}`);
  const clean = () => runManualHousekeeping(repository);
  const build = await runCommit(github, repository, sha, displayBranch, config, undefined, {
    type: "commit",
    branch: contextBranch,
    id: contextBranch ? `branch:${contextBranch}:${sha}` : `ref:${sha}`,
  });
  if (!build) {
    progress.stop("No work was claimed locally; another eligible worker may run this request.");
    await clean();
    return;
  }
  progress.stop(`${build.status}: ${build.id}`);
  await clean();
  if (build.status !== "success") process.exitCode = 1;
}

function githubUrl(build: NonNullable<Awaited<ReturnType<typeof getBuild>>>): string {
  return build.pullRequest
    ? `https://github.com/${build.repo}/pull/${build.pullRequest}`
    : `https://github.com/${build.repo}/commit/${build.sha}`;
}

async function showBuilds(includeHistory: boolean): Promise<void> {
  if (process.stdin.isTTY) return browseBuilds(includeHistory);
  const builds = includeHistory ? await listBuilds() : await listActiveBuilds();
  console.log(buildList(builds, includeHistory));
}

type Build = NonNullable<Awaited<ReturnType<typeof getBuild>>>;

function jobsForBuild(build: Build): NonNullable<Build["jobs"]> {
  if (build.jobs) return build.jobs;
  return (build.runningJobs ?? []).map((name) => ({ name, status: "running" as const }));
}

function formatElapsedTime(startedAt: string, completedAt?: string): string {
  const elapsedSeconds = Math.max(
    0,
    Math.floor(
      ((completedAt ? Date.parse(completedAt) : Date.now()) - Date.parse(startedAt)) / 1_000,
    ),
  );
  const hours = Math.floor(elapsedSeconds / 3_600);
  const minutes = Math.floor((elapsedSeconds % 3_600) / 60);
  const seconds = elapsedSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function buildTiming(build: Build): string {
  return `started ${new Date(build.startedAt).toLocaleString()} · ${formatElapsedTime(build.startedAt, build.completedAt)} elapsed`;
}

function buildList(builds: Build[], includeHistory: boolean): string {
  if (builds.length === 0) return includeHistory ? "No local builds yet." : "No builds running.";
  return builds
    .map((build) => {
      const jobs = jobsForBuild(build);
      const lines = [
        `● ${build.repo} · ${build.branch}@${build.sha.slice(0, 7)} · ${build.status}`,
        `  ${build.id} · ${buildTiming(build)} · ${build.machine}`,
        `  ${githubUrl(build)}`,
      ];
      for (const [index, job] of jobs.entries()) {
        lines.push(`  ${index === jobs.length - 1 ? "└─" : "├─"} ${job.name} · ${job.status}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

interface BrowserOption {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

const terminalColor = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[93m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  orange: "\x1b[33m",
  lightGreen: "\x1b[92m",
  gray: "\x1b[90m",
};

function coloredStatus(status: string): string {
  const color =
    status === "success"
      ? terminalColor.green
      : status === "failure"
        ? terminalColor.red
        : status === "running"
          ? terminalColor.lightGreen
          : status === "queued"
            ? terminalColor.orange
            : status === "cancelled"
              ? terminalColor.gray
              : terminalColor.yellow;
  return `${color}${status}${terminalColor.reset}`;
}

function statusBarColors(status: string): string {
  if (status === "running") return "\x1b[102m\x1b[30m";
  if (status === "queued") return "\x1b[43m\x1b[30m";
  if (status === "success") return "\x1b[42m\x1b[30m";
  if (status === "failure") return "\x1b[41m\x1b[30m";
  if (status === "skipped") return "\x1b[103m\x1b[30m";
  return "\x1b[100m\x1b[97m";
}

function highlightMatches(text: string, query: string): string {
  if (!query) return text;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let result = "";
  let offset = 0;
  while (offset < text.length) {
    const match = lowerText.indexOf(lowerQuery, offset);
    if (match < 0) return result + text.slice(offset);
    result += `${text.slice(offset, match)}\x1b[7m${text.slice(match, match + query.length)}\x1b[27m`;
    offset = match + query.length;
  }
  return result;
}

function statusFooter(left: string, status: string, width: number): string {
  const right = `${status.toUpperCase()}  `;
  if (right.length >= width) return right.slice(-width);
  return left.slice(0, width - right.length).padEnd(width - right.length) + right;
}

function buildBrowserOptions(builds: Build[]): BrowserOption[] {
  if (builds.length === 0) return [{ value: "none", label: "No builds available", disabled: true }];
  return builds.flatMap((build) => [
    {
      value: build.id,
      label: `${terminalColor.bold}${build.repo}${terminalColor.reset} · ${terminalColor.blue}${build.branch}@${build.sha.slice(0, 7)}${terminalColor.reset}`,
      hint: `${coloredStatus(build.status)} · ${buildTiming(build)} · ${terminalColor.dim}${build.id}${terminalColor.reset}`,
    },
    ...jobsForBuild(build).map((job) => ({
      value: `${build.id}\0${job.name}`,
      label: `  ${terminalColor.dim}↳${terminalColor.reset} ${job.name}`,
      hint: coloredStatus(job.status),
    })),
  ]);
}

async function liveBuildSelect(includeHistory: boolean): Promise<string | symbol> {
  const load = async () =>
    buildBrowserOptions(includeHistory ? await listBuilds() : await listActiveBuilds());
  const options = await load();
  const prompt = new SelectPrompt<BrowserOption>({
    options,
    render() {
      const active = this.options[this.cursor];
      if (this.state === "submit") return `◆  ${active?.label ?? "Builds"}`;
      if (this.state === "cancel") return "◇  Back";
      const rows = Math.max(5, (process.stdout.rows ?? 20) - 2);
      const start = Math.max(
        0,
        Math.min(this.cursor - Math.floor(rows / 2), this.options.length - rows),
      );
      const visible = this.options.slice(start, start + rows);
      const lines = visible.map((option, index) => {
        const selected = start + index === this.cursor;
        const marker = option.disabled
          ? `${terminalColor.dim}─${terminalColor.reset}`
          : selected
            ? `${terminalColor.cyan}◆${terminalColor.reset}`
            : `${terminalColor.dim}◇${terminalColor.reset}`;
        return `│  ${marker} ${option.label}${option.hint ? `  (${option.hint})` : ""}`;
      });
      const title = includeHistory ? "Recent builds" : "Running builds";
      return `${terminalColor.cyan}◆${terminalColor.reset}  ${terminalColor.bold}${title}${terminalColor.reset}\n${lines.join("\n")}\n└  ${terminalColor.dim}↑/↓ navigate · Enter open logs · Esc back${terminalColor.reset}`;
    },
  });
  let open = true;
  let refreshing = false;
  const refresh = setInterval(async () => {
    if (!open || refreshing) return;
    refreshing = true;
    try {
      const selected = prompt.value;
      const next = await load();
      prompt.options.splice(0, prompt.options.length, ...next);
      const selectedIndex = next.findIndex((option) => option.value === selected);
      prompt.cursor = selectedIndex >= 0 ? selectedIndex : Math.min(prompt.cursor, next.length - 1);
      prompt.value = prompt.options[prompt.cursor]?.value;
      (prompt as unknown as { render: () => void }).render();
    } catch {
      // The next refresh retries transient filesystem reads.
    } finally {
      refreshing = false;
    }
  }, 1_000);
  try {
    const selection = (await prompt.prompt()) ?? Symbol.for("informant:no-selection");
    process.stdout.write("\x1b[1A\x1b[2K\r");
    return selection;
  } finally {
    open = false;
    clearInterval(refresh);
  }
}

async function logTail(path: string, maximumBytes = 256 * 1024): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) return "Waiting for log output…";
  const start = Math.max(0, file.size - maximumBytes);
  const bytes = new Uint8Array(await file.slice(start, file.size).arrayBuffer());
  let offset = 0;
  while (offset < bytes.length && ((bytes[offset] ?? 0) & 0xc0) === 0x80) offset++;
  return new TextDecoder().decode(bytes.subarray(offset));
}

async function browseLog(buildId: string, job?: string): Promise<"back" | "exit"> {
  const initial = await getBuild(buildId);
  if (!initial) throw new Error(`build not found: ${buildId}`);
  const path = job ? jobLogPath(initial, job) : initial.logPath;
  let action: "view" | "back" | "exit" = "view";
  let search = "";
  let editingSearch = false;
  let matchCursor = -1;
  let previous = "";
  let livenessCheckedAt = 0;
  const input = process.stdin;
  const output = process.stdout;
  emitKeypressEvents(input);
  const keypress = (
    character: string | undefined,
    key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean },
  ) => {
    if (key.ctrl && key.name === "c") action = "exit";
    else if (editingSearch) {
      if (key.name === "escape") {
        editingSearch = false;
        search = "";
        matchCursor = -1;
      } else if (key.name === "return") editingSearch = false;
      else if (key.name === "backspace") {
        search = search.slice(0, -1);
        matchCursor = -1;
      } else if (character && !key.ctrl && !key.meta && character >= " ") {
        search += character;
        matchCursor = -1;
      }
    } else if (character === "/") editingSearch = true;
    else if (search && key.name === "n") matchCursor += key.shift ? -1 : 1;
    else if (search && key.name === "escape") {
      search = "";
      matchCursor = -1;
    } else if (key.name === "escape" || key.name === "backspace") action = "back";
  };
  input.on("keypress", keypress);
  input.setRawMode?.(true);
  input.resume();
  output.write("\x1b[?1049h\x1b[?25l");
  try {
    while (action === "view") {
      let build = await getBuild(buildId);
      if (build?.status === "running" && Date.now() - livenessCheckedAt >= 2_000) {
        build = await reconcileBuildLiveness(build);
        livenessCheckedAt = Date.now();
      }
      if (!build) return "back";
      const contents = await logTail(path);
      const availableRows = Math.max(1, (output.rows ?? 24) - 5);
      const lines = contents.trimEnd().split("\n");
      const matches = search
        ? lines.flatMap((line, index) =>
            line.toLowerCase().includes(search.toLowerCase()) ? [index] : [],
          )
        : [];
      let visibleLines: string[];
      if (matches.length > 0) {
        matchCursor = ((matchCursor % matches.length) + matches.length) % matches.length;
        const target = matches[matchCursor] ?? matches.at(-1) ?? lines.length - 1;
        const start = Math.max(
          0,
          Math.min(target - Math.floor(availableRows / 2), lines.length - availableRows),
        );
        visibleLines = lines.slice(start, start + availableRows);
      } else {
        visibleLines = lines.slice(-availableRows);
      }
      const visible = highlightMatches(visibleLines.join("\n"), search);
      const title = job
        ? `${job} · ${build.repo} · ${build.branch}@${build.sha.slice(0, 7)}`
        : `${build.repo} · ${build.branch}@${build.sha.slice(0, 7)}`;
      const jobStatus = job
        ? jobsForBuild(build).find((item) => item.name === job)?.status
        : undefined;
      const status = jobStatus ?? build.status;
      const footerWidth = Math.max(1, output.columns ?? 80);
      const searchSummary = search
        ? `${matches.length} match${matches.length === 1 ? "" : "es"}`
        : "";
      const footerLeft = editingSearch
        ? `  Search: ${search}█`
        : search
          ? `  / ${search} · ${searchSummary}    n/N Next/Previous    Esc Back`
          : "  / Search    Esc Back to list    Ctrl-C Exit";
      const footer = statusFooter(footerLeft, status, footerWidth);
      const footerRow = Math.max(1, output.rows ?? 24);
      const frame = `◆ ${title}\n  ${coloredStatus(status)} · ${build.id}\n\n${visible}\x1b[${footerRow};1H${statusBarColors(status)}${footer}\x1b[0m`;
      if (frame !== previous) {
        output.write(`\x1b[2J\x1b[H${frame}`);
        previous = frame;
      }
      await Bun.sleep(250);
    }
    return action;
  } finally {
    input.off("keypress", keypress);
    input.setRawMode?.(false);
    output.write("\x1b[?25h\x1b[?1049l");
  }
}

async function browseBuilds(includeHistory: boolean, initialBuildId?: string): Promise<void> {
  let initial = initialBuildId;
  while (true) {
    if (initial) {
      if ((await browseLog(initial)) === "exit") return;
      initial = undefined;
    }
    const choice = await liveBuildSelect(includeHistory);
    if (isCancel(choice) || typeof choice !== "string" || choice === "none") return;
    const [buildId, job] = choice.split("\0", 2);
    if (buildId && (await browseLog(buildId, job)) === "exit") return;
  }
}

async function tailLog(
  buildId: string,
  path: string,
  running: (build: NonNullable<Awaited<ReturnType<typeof getBuild>>>) => boolean,
): Promise<void> {
  let offset = 0;
  let livenessCheckedAt = 0;
  const decoder = new TextDecoder();
  const drain = async () => {
    const file = Bun.file(path);
    if (await file.exists()) {
      if (file.size < offset) offset = 0;
      if (file.size > offset) {
        const bytes = new Uint8Array(await file.slice(offset, file.size).arrayBuffer());
        offset = file.size;
        process.stdout.write(decoder.decode(bytes, { stream: true }));
      }
    }
  };
  while (true) {
    await drain();
    let current = await getBuild(buildId);
    if (current?.status === "running" && Date.now() - livenessCheckedAt >= 2_000) {
      current = await reconcileBuildLiveness(current);
      livenessCheckedAt = Date.now();
    }
    if (!current || !running(current)) {
      await drain();
      const remainder = decoder.decode();
      if (remainder) process.stdout.write(remainder);
      return;
    }
    await Bun.sleep(250);
  }
}

async function showLogs(id?: string): Promise<void> {
  if (id) {
    const build = await getBuild(id);
    if (!build) throw new Error(`build not found: ${id}`);
    if (process.stdin.isTTY) return browseBuilds(true, id);
    return tailLog(build.id, build.logPath, (current) => current.status === "running");
  }
  if (!process.stdin.isTTY)
    throw new Error("logs requires a build ID when input is not interactive");
  return browseBuilds(true);
}

export async function pruneRuntimeImages(
  operations: { tart?: () => Promise<number>; container?: () => Promise<number> } = {},
): Promise<number> {
  const runtimes = [
    { label: "Tart images", prune: operations.tart ?? prunePreparedImages },
    {
      label: `${selectContainerBackend()?.name ?? "Container"} images`,
      prune: operations.container ?? prunePreparedContainerImages,
    },
  ];
  const results = await Promise.allSettled(runtimes.map(({ prune }) => prune()));
  const count = results.reduce(
    (total, result) => total + (result.status === "fulfilled" ? result.value : 0),
    0,
  );
  const failures = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [
          `${runtimes[index]?.label ?? "runtime images"}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        ]
      : [],
  );
  if (failures.length > 0) {
    const images = count === 1 ? "image" : "images";
    throw new Error(
      `Deleted ${count} unused prepared ${images}, but failed to prune ${failures.join("; ")}`,
    );
  }
  return count;
}

async function manageImages(action?: string): Promise<void> {
  if (action === "prepare") {
    const repository = await repositoryFromGit();
    const config = await readConfig();
    const vmJobs = config.jobs.filter((job) => job.runtime?.type === "vm");
    if (vmJobs.length === 0) throw new Error("configuration has no VM jobs to prepare");
    const images = new Set<string>();
    for (const job of vmJobs) {
      if (job.runtime?.type !== "vm") continue;
      images.add(
        await ensurePreparedImage(
          { ...config, vm: job.runtime },
          console.log,
          `${repository.fullName}\0${job.name}`,
        ),
      );
    }
    outro(`Prepared ${[...images].join(", ")}`);
    return;
  }
  if (action === "list" || !action) {
    const images = await listPreparedImages();
    console.log(images.length > 0 ? images.join("\n") : "No prepared Informant images.");
    return;
  }
  if (action === "prune") {
    const count = await pruneRuntimeImages();
    outro(`Deleted ${count} unused prepared ${count === 1 ? "image" : "images"}`);
    return;
  }
  throw new Error("image action must be one of: prepare, list, prune");
}

async function manageCaches(action?: string): Promise<void> {
  const path = join(dataDirectory(), "caches");
  if (action === "path" || !action) {
    console.log(path);
    return;
  }
  if (action === "prune") {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    const linuxPath = join(path, "linux");
    const linuxEntries = await readdir(linuxPath, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      [
        ...entries
          .filter((entry) => entry.name !== "shared" && entry.name !== "linux")
          .map((entry) => join(path, entry.name)),
        ...linuxEntries
          .filter((entry) => entry.name !== "shared")
          .map((entry) => join(linuxPath, entry.name)),
      ].map((entry) => rm(entry, { recursive: true, force: true })),
    );
    outro("Deleted keyed job caches; preserved shared caches");
    return;
  }
  if (action === "clear") {
    await rm(path, { recursive: true, force: true });
    outro("Deleted all persistent job caches");
    return;
  }
  throw new Error("cache action must be one of: path, prune, clear");
}

async function repositoryArgument(value?: string): Promise<ReturnType<typeof parseRepository>> {
  if (value) return parseRepository(value);
  try {
    return await repositoryFromGit();
  } catch {
    throw new Error("specify owner/repository or run this command inside a GitHub repository");
  }
}

async function manageRepositories(action?: string, value?: string): Promise<void> {
  if (action === "list" || !action) {
    const repositories = await listRepositories();
    console.log(
      repositories.length
        ? repositories.map((repository) => repository.fullName).join("\n")
        : "No repositories registered. Run informant repo add owner/repository.",
    );
    return;
  }
  const repository = await repositoryArgument(value);
  if (action === "add") {
    const added = await addRepository(repository);
    outro(
      added ? `Registered ${repository.fullName}` : `${repository.fullName} is already registered`,
    );
    return;
  }
  if (action === "remove") {
    const removed = await removeRepository(repository);
    outro(removed ? `Removed ${repository.fullName}` : `${repository.fullName} was not registered`);
    return;
  }
  throw new Error("repo action must be one of: add, list, remove");
}

async function manageMounts(action?: string, name?: string, source?: string): Promise<void> {
  if (action === "list" || !action) {
    const mounts = await listAllowedMounts();
    console.log(
      mounts.length
        ? mounts.map((mount) => `${mount.name}\t${mount.source}`).join("\n")
        : "No host files are allowed for job mounts.",
    );
    return;
  }
  if (action === "allow") {
    if (!name || !source) throw new Error("usage: informant mount allow <name> <file>");
    await allowMount(name, source);
    outro(`Allowed ${name} to mount ${await realpath(source)}`);
    return;
  }
  if (action === "remove") {
    if (!name || source) throw new Error("usage: informant mount remove <name>");
    const removed = await removeAllowedMount(name);
    outro(removed ? `Removed allowed mount ${name}` : `Allowed mount ${name} was not configured`);
    return;
  }
  throw new Error("mount action must be one of: allow, list, remove");
}

async function doctor(): Promise<void> {
  const requiredChecks: Array<[string, string[]]> = [
    ["git", ["git", "--version"]],
    ["GitHub CLI", ["gh", "auth", "status"]],
  ];
  let failed = false;
  for (const [label, argv] of requiredChecks) {
    const result = await command(argv);
    const okay = result.exitCode === 0;
    failed ||= !okay;
    console.log(
      `${okay ? "✓" : "✗"} ${label}${okay ? "" : ` — ${result.stderr.trim() || "not found"}`}`,
    );
  }
  try {
    const disk = await fileSystemSpace(dataDirectory());
    const status = assessDiskSpace(disk);
    const detail = `${formatBytes(disk.availableBytes)} free of ${formatBytes(disk.totalBytes)}`;
    if (status === "healthy") console.log(`✓ disk space — ${detail}`);
    else if (status === "warning")
      console.log(`○ disk space — ${detail}; space is getting low, run informant storage`);
    else {
      console.log(`✗ disk space — ${detail}; free space is critically low, run informant storage`);
      failed = true;
    }
  } catch (error) {
    console.log(`✗ disk space — ${error instanceof Error ? error.message : error}`);
    failed = true;
  }
  const selectedContainer = selectContainerBackend();
  const containerReady = await initializeContainerBackend(selectedContainer);
  const containerStatus = containerBackendReadiness();
  const tart = await command(["tart", "--version"]);
  const sshpass = await command(["sshpass", "-V"]);
  const tartHost = process.platform === "darwin" && process.arch === "arm64";
  const tartReady = tart.exitCode === 0 && sshpass.exitCode === 0 && tartHost;
  const hostReady = process.platform === "linux" || process.platform === "darwin";
  console.log(
    `${containerReady ? "✓" : "○"} ${selectedContainer?.name ?? "container runtime"}${containerReady ? "" : ` — ${containerStatus?.error?.message ?? "not supported on this host"}`}`,
  );
  console.log(
    `${tart.exitCode === 0 ? "✓" : "○"} Tart${tart.exitCode === 0 ? "" : ` — ${tart.stderr.trim() || "not found"}`}`,
  );
  console.log(
    `${sshpass.exitCode === 0 ? "✓" : "○"} sshpass${sshpass.exitCode === 0 ? "" : ` — ${sshpass.stderr.trim() || "not found"}`}`,
  );
  console.log(
    `${tartHost ? "✓" : "○"} ${tartHost ? "macOS on Apple Silicon" : "host — Tart requires macOS on Apple Silicon"}`,
  );
  console.log(`${hostReady ? "✓" : "○"} native host jobs — ${process.platform}/${process.arch}`);
  if (!containerReady && !tartReady && !hostReady) {
    console.log(
      "✗ runtime — run informant setup for container jobs or install Tart and sshpass for VM jobs",
    );
    failed = true;
  }
  try {
    const apps = await listGitHubCredentials();
    if (apps.length === 0) throw new Error("run informant setup");
    for (const credentials of apps) {
      await new GitHubClient({ credentials }).authenticate();
      console.log(
        `✓ GitHub App credentials${credentials.account ? ` · ${credentials.account}` : ""}`,
      );
    }
  } catch (error) {
    console.log(`✗ GitHub App credentials — ${error instanceof Error ? error.message : error}`);
    failed = true;
  }
  if (failed) process.exitCode = 1;
}

export async function main(argv = Bun.argv.slice(2)): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const [subcommand, action, id, value] = positional;
  if (flags.version || subcommand === "--version") {
    console.log(packageJson.version);
    return;
  }
  if (!subcommand || flags.help || subcommand === "help") {
    console.log(HELP);
    return;
  }
  if (subcommand === "init") return init();
  if (subcommand === "setup") return setup();
  if (subcommand === "doctor") return doctor();
  if (subcommand === "storage") {
    if (action) throw new Error("storage does not accept arguments");
    console.log(formatStorageReport(await collectStorageReport()));
    return;
  }
  if (subcommand === "update") {
    if (action) throw new Error("update does not accept arguments");
    const updated = await updateInformant({
      onOutput: (output) => {
        process.stdout.write(output);
      },
    });
    outro(
      updated.restarted
        ? "Updated Informant and restarted the worker"
        : "Updated Informant; the startup worker is not running",
    );
    return;
  }
  if (subcommand === "repo") return manageRepositories(action, id);
  if (subcommand === "mount") return manageMounts(action, id, value);
  if (subcommand === "image") return manageImages(action);
  if (subcommand === "cache") return manageCaches(action);
  if (subcommand === "serve") {
    if (action) throw new Error("serve does not accept a repository; use informant repo add first");
    const repositories = await listRepositories();
    if (repositories.length === 0) {
      throw new Error("no repositories registered; run informant repo add owner/repository");
    }
    intro(
      `Informant worker · ${repositories.length} ${repositories.length === 1 ? "repository" : "repositories"}`,
    );
    cleanOrphanedBuildWorkspacesInBackground();
    const shutdown = new AbortController();
    const stop = () => shutdown.abort("Worker shutdown requested.");
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    try {
      return await serveRepositories(repositories, {
        once: flags.once === true,
        signal: shutdown.signal,
        onMessage: console.log,
      });
    } finally {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
    }
  }
  if (subcommand === "run") {
    if (runInvocationType(flags.local === true) === "local") {
      if (flags["wait-for-github"] === true) {
        throw new Error("--local cannot be combined with --wait-for-github");
      }
      return localRun(
        typeof flags.ref === "string" ? flags.ref : "HEAD",
        typeof flags.branch === "string" ? flags.branch : undefined,
        requestedJobs(flags.job),
      );
    }
    if (flags["wait-for-github"] !== true) {
      console.warn(
        "informant run reports GitHub checks for compatibility; use informant trigger, or pass --local for an unreported local run",
      );
    }
    return manualTrigger(
      typeof flags.ref === "string" ? flags.ref : "HEAD",
      typeof flags.branch === "string" ? flags.branch : undefined,
      flags["wait-for-github"] === true,
      requestedJobs(flags.job),
    );
  }
  if (subcommand === "trigger") {
    if (flags.local === true) throw new Error("trigger does not accept --local");
    return manualTrigger(
      typeof flags.ref === "string" ? flags.ref : "HEAD",
      typeof flags.branch === "string" ? flags.branch : undefined,
      flags["wait-for-github"] === true,
      requestedJobs(flags.job),
    );
  }
  if (subcommand === "startup" && action === "enable") {
    outro(`Enabled Informant startup service at ${await enableStartup()}`);
    return;
  }
  if (subcommand === "startup" && action === "disable") {
    const result = await disableStartup();
    outro(
      result.disabled ? "Disabled Informant startup service" : "Startup service is not enabled",
    );
    return;
  }
  if (subcommand === "startup") throw new Error("startup action must be one of: enable, disable");
  if (subcommand === "hook" && action === "install") {
    outro(`Installed ${await installPostPushHook()}`);
    return;
  }
  if (subcommand === "hook" && action === "uninstall") {
    const result = await uninstallPostPushHook();
    outro(
      result.removed ? `Removed Informant from ${result.path}` : "Informant hook is not installed",
    );
    return;
  }
  if (subcommand === "hook") throw new Error("hook action must be one of: install, uninstall");
  if (subcommand === "logs") return showLogs(action);
  if (subcommand === "builds" && action === "logs")
    throw new Error("builds logs has moved to informant logs [<build-id>]");
  if (subcommand === "builds") {
    if (process.stdin.isTTY) return browseBuilds(flags.all === true);
    return showBuilds(flags.all === true);
  }

  if (process.stdin.isTTY) {
    const choice = await select({
      message: `Unknown command: ${subcommand}`,
      options: [{ value: "help", label: "Show help" }],
    });
    if (!isCancel(choice)) console.log(HELP);
    return;
  }
  throw new Error(`unknown command: ${subcommand}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`informant: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
