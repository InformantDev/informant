import { hostname } from "node:os";
import { join } from "node:path";
import { selectJobs } from "./config.ts";
import type { GitHubClient } from "./github.ts";
import { createBuild, dataDirectory, saveBuild } from "./store.ts";
import { runInTart } from "./tart.ts";
import type { BuildRecord, InformantConfig, Repository } from "./types.ts";

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
): Promise<BuildRecord | undefined> {
  const id = crypto.randomUUID().slice(0, 12);
  const machine = `${hostname()}:${process.pid}:${id}`;
  const claim = await github.claim(repository, sha, machine);
  if (!claim) return undefined;
  const { check } = claim;
  config = selectJobs(config, claim.requestedJobs);

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
