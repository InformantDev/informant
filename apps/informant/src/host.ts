import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { command } from "./process.ts";
import { type RuntimeSecrets, resolveJobSecrets, streamingSecretRedactor } from "./tart/index.ts";
import type { JobConfig, Repository } from "./types.ts";

export async function runOnHost(
  repository: Repository,
  sha: string,
  branch: string,
  trustedSha: string,
  workspace: string,
  job: JobConfig,
  log: (text: string) => Promise<void>,
  started: () => Promise<void>,
  runtimeSecrets: RuntimeSecrets,
  signal?: AbortSignal,
) {
  if (job.runtime?.type !== "host") throw new Error("host runner requires a host runtime");
  if ((job.cache?.length ?? 0) > 0)
    throw new Error("persistent caches are not supported by the host runtime");
  const home = join(workspace, ".informant-home");
  await mkdir(home, { recursive: true });
  const secrets = await resolveJobSecrets(job, runtimeSecrets);
  const environment = {
    ...job.environment,
    ...secrets,
    INFORMANT_REPOSITORY: repository.fullName,
    INFORMANT_SHA: sha,
    INFORMANT_BRANCH: branch,
    INFORMANT_TRUSTED_SHA: trustedSha,
    HOME: home,
  };
  await started();
  await log(`\n[${job.name}] $ ${job.command}\n`);
  const redactor = streamingSecretRedactor(Object.values(secrets), log);
  const result = await command(["bash", "-lc", job.command], {
    cwd: workspace,
    env: environment,
    timeoutMs: job.timeoutMinutes * 60_000,
    signal,
    onOutput: redactor.write,
  });
  await redactor.flush();
  return {
    success: result.exitCode === 0 && !result.timedOut,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
  };
}
