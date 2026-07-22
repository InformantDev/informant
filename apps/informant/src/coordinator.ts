import { hostname } from "node:os";
import { join } from "node:path";
import { selectJobs, selectTriggeredJobs } from "./config.ts";
import type { GitHubClient } from "./github.ts";
import { createBuild, dataDirectory, saveBuild } from "./store.ts";
import { runInTart } from "./tart.ts";
import { type EventContext, triggerMatches } from "./triggers.ts";
import type { BuildRecord, InformantConfig, Repository } from "./types.ts";

type RunEvent = (EventContext | { type: "manual" }) & { id: string };

export interface CoordinatorDependencies {
  createBuild: typeof createBuild;
  saveBuild: typeof saveBuild;
  runInTart: typeof runInTart;
  readLogTail: (path: string) => Promise<string>;
}

const CHECK_LOG_CHARACTERS = 55_000;
const CHECK_LOG_BYTES = CHECK_LOG_CHARACTERS * 4;

export async function readLogTail(path: string): Promise<string> {
  const file = Bun.file(path);
  const bytes = new Uint8Array(
    await file.slice(Math.max(0, file.size - CHECK_LOG_BYTES), file.size).arrayBuffer(),
  );
  let start = 0;
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  return Array.from(new TextDecoder().decode(bytes.subarray(start)))
    .slice(-CHECK_LOG_CHARACTERS)
    .join("");
}

const defaultDependencies: CoordinatorDependencies = {
  createBuild,
  saveBuild,
  runInTart,
  readLogTail,
};

export async function runCommit(
  github: GitHubClient,
  repository: Repository,
  sha: string,
  branch: string,
  config: InformantConfig,
  dependencies: CoordinatorDependencies = defaultDependencies,
  event?: RunEvent,
): Promise<BuildRecord | false | undefined> {
  const id = crypto.randomUUID().slice(0, 12);
  const machine = `${hostname()}:${process.pid}:${id}`;
  const claim = await github.claim(
    repository,
    sha,
    machine,
    event ? { type: event.type, id: event.id } : undefined,
  );
  if (claim?.retry) return false;
  if (!claim?.check) return undefined;
  const { check } = claim;
  config = claim.manualRequest
    ? selectJobs(config, claim.requestedJobs)
    : event && event.type !== "manual"
      ? selectTriggeredJobs(config, (rule) => triggerMatches(rule, event))
      : config;
  if (config.jobs.length === 0) {
    await github.updateCheck(repository, check.id, {
      status: "completed",
      conclusion: "neutral",
      title: "No jobs matched",
      summary: `No jobs are configured for this ${event?.type ?? "manual"} event.`,
    });
    return undefined;
  }

  const record: BuildRecord = {
    id,
    repo: repository.fullName,
    sha,
    branch,
    machine: hostname(),
    startedAt: new Date().toISOString(),
    status: "running",
    logPath: join(dataDirectory(), "builds", id, "build.log"),
    checkUrl: check.html_url,
    event: claim.manualRequest
      ? { type: "manual", id: check.id.toString() }
      : event
        ? { type: event.type, id: event.id }
        : { type: "manual", id: check.id.toString() },
  };
  try {
    await dependencies.createBuild(record);
    const success = await dependencies.runInTart(repository, sha, config, record);
    record.status = success ? "success" : "failure";
    record.completedAt = new Date().toISOString();
    const logs = await dependencies.readLogTail(record.logPath);
    await github.updateCheck(repository, check.id, {
      status: "completed",
      conclusion: success ? "success" : "failure",
      title: success ? "All jobs passed" : "A job failed",
      summary: `${config.jobs.length} job${config.jobs.length === 1 ? "" : "s"} ran on ${record.machine}.`,
      text: `\`\`\`text\n${logs}\n\`\`\``,
    });
  } catch (error) {
    record.status = "failure";
    record.completedAt = new Date().toISOString();
    await github.updateCheck(repository, check.id, {
      status: "completed",
      conclusion: "failure",
      title: "Informant failed to run",
      summary: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await dependencies.saveBuild(record).catch(() => undefined);
  }
  return record;
}
