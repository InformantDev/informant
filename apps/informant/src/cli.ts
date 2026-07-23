#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cancel, intro, isCancel, outro, select, spinner, text } from "@clack/prompts";
import Table from "cli-table3";
import packageJson from "../package.json" with { type: "json" };
import {
  CONFIG_FILE,
  configTemplate,
  parseConfig,
  parseRepository,
  readConfig,
  selectJobs,
} from "./config.ts";
import { runCommit } from "./coordinator.ts";
import { GitHubClient } from "./github.ts";
import { installPostPushHook, uninstallPostPushHook } from "./hook.ts";
import {
  addRepository,
  listGitHubCredentials,
  listRepositories,
  removeRepository,
} from "./machine-config.ts";
import { command, requireCommand } from "./process.ts";
import { serveRepositories } from "./server.ts";
import { setup } from "./setup.ts";
import { disableStartup, enableStartup } from "./startup.ts";
import { dataDirectory, getBuild, listBuilds } from "./store.ts";
import { ensurePreparedImage, listPreparedImages, prunePreparedImages } from "./tart.ts";

const HELP = `Informant ${packageJson.version} — background CI on your Macs

Usage:
  informant setup                        Add a private GitHub App for an account
  informant init                         Create .informant.toml
  informant repo add [owner/repo]         Register a repository on this machine
  informant repo list                     List registered repositories
  informant repo remove [owner/repo]      Stop handling a repository
  informant serve [--once]                Poll all registered repositories
  informant run [--ref <ref>] [--job <name>]
                                        Manually request all or selected jobs
  informant image prepare                Prepare this repository's cached VM image
  informant image list                   List Informant-prepared VM images
  informant image prune                  Delete Informant-prepared VM images
  informant cache path                   Print the persistent job cache directory
  informant cache prune                  Delete all persistent job caches
  informant startup enable               Start the worker now and at login
  informant startup disable              Stop and remove the startup worker
  informant hook install                 Accelerate pushes with a pre-push hook
  informant hook uninstall               Remove Informant from the pre-push hook
  informant builds                       List builds run on this machine
  informant builds logs <id>             Print a build's log
  informant doctor                       Check host dependencies and auth
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

async function repositoryFromGit(): Promise<ReturnType<typeof parseRepository>> {
  const remote = await requireCommand(["git", "remote", "get-url", "origin"]);
  return parseRepository(remote.replace(/^git@github\.com:/, ""));
}

async function init(): Promise<void> {
  const path = resolve(CONFIG_FILE);
  if (existsSync(path)) throw new Error(`${CONFIG_FILE} already exists`);
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
  await Bun.write(
    path,
    configTemplate().replace("bun install --frozen-lockfile && bun test", jobs),
  );
  outro(`Created ${path}`);
}

async function manualRun(
  ref: string,
  branchOverride?: string,
  waitForGitHub = false,
  jobs: string[] = [],
): Promise<void> {
  const repository = await repositoryFromGit();
  const sha = await requireCommand(["git", "rev-parse", ref]);
  const branch = await command(["git", "branch", "--show-current"]);
  const github = new GitHubClient({ repository });
  if (waitForGitHub) await github.waitForCommit(repository, sha);
  const config = parseConfig(
    await requireCommand(["git", "show", `${sha}:${CONFIG_FILE}`]),
    `${CONFIG_FILE}@${sha.slice(0, 7)}`,
  );
  selectJobs(config, jobs);
  await github.createCheck(repository, sha, `manual:${crypto.randomUUID()}`, "queued", jobs);
  const progress = spinner();
  progress.start(`Claiming ${repository.fullName}@${sha.slice(0, 7)}`);
  const build = await runCommit(
    github,
    repository,
    sha,
    branchOverride || branch.stdout.trim() || ref,
    config,
  );
  if (!build) {
    progress.stop("Another machine is already running this commit.");
    return;
  }
  progress.stop(`${build.status}: ${build.id}`);
  if (build.status !== "success") process.exitCode = 1;
}

async function showBuilds(): Promise<void> {
  const builds = await listBuilds();
  const table = new Table({ head: ["ID", "STATUS", "REPOSITORY", "REF", "STARTED", "MACHINE"] });
  for (const build of builds) {
    table.push([
      build.id,
      build.status,
      build.repo,
      `${build.branch}@${build.sha.slice(0, 7)}`,
      build.startedAt,
      build.machine,
    ]);
  }
  console.log(builds.length ? table.toString() : "No local builds yet.");
}

async function manageImages(action?: string): Promise<void> {
  if (action === "prepare") {
    const image = await ensurePreparedImage(await readConfig());
    outro(`Prepared ${image}`);
    return;
  }
  if (action === "list" || !action) {
    const images = await listPreparedImages();
    console.log(images.length > 0 ? images.join("\n") : "No prepared Informant images.");
    return;
  }
  if (action === "prune") {
    const count = await prunePreparedImages();
    outro(`Deleted ${count} prepared ${count === 1 ? "image" : "images"}`);
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
    await rm(path, { recursive: true, force: true });
    outro("Deleted persistent job caches");
    return;
  }
  throw new Error("cache action must be one of: path, prune");
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

async function doctor(): Promise<void> {
  const checks: Array<[string, string[]]> = [
    ["git", ["git", "--version"]],
    ["GitHub CLI", ["gh", "auth", "status"]],
    ["Tart", ["tart", "--version"]],
    ["sshpass", ["sshpass", "-V"]],
  ];
  let failed = false;
  for (const [label, argv] of checks) {
    const result = await command(argv);
    const okay = result.exitCode === 0;
    failed ||= !okay;
    console.log(
      `${okay ? "✓" : "✗"} ${label}${okay ? "" : ` — ${result.stderr.trim() || "not found"}`}`,
    );
  }
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    console.log("✗ host — Tart requires macOS on Apple Silicon");
    failed = true;
  } else console.log("✓ macOS on Apple Silicon");
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
  const [subcommand, action, id] = positional;
  if (!subcommand || flags.help || subcommand === "help") {
    console.log(HELP);
    return;
  }
  if (flags.version || subcommand === "--version") {
    console.log(packageJson.version);
    return;
  }
  if (subcommand === "init") return init();
  if (subcommand === "setup") return setup();
  if (subcommand === "doctor") return doctor();
  if (subcommand === "repo") return manageRepositories(action, id);
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
    return serveRepositories(repositories, {
      once: flags.once === true,
      onMessage: console.log,
    });
  }
  if (subcommand === "run") {
    return manualRun(
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
  if (subcommand === "builds" && action === "logs") {
    if (!id) throw new Error("builds logs requires a build ID");
    const build = await getBuild(id);
    if (!build) throw new Error(`build not found: ${id}`);
    console.log(await Bun.file(build.logPath).text());
    return;
  }
  if (subcommand === "builds") return showBuilds();

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
