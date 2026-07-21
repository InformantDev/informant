import { CONFIG_FILE, parseConfig } from "./config.ts";
import { runCommit } from "./coordinator.ts";
import { GitHubClient } from "./github.ts";
import type { Repository } from "./types.ts";

export interface ServerOptions {
  once?: boolean;
  signal?: AbortSignal;
  onMessage?: (message: string) => void;
}

export async function serve(repository: Repository, options: ServerOptions = {}): Promise<void> {
  const github = new GitHubClient();
  let intervalSeconds = 20;
  const message = options.onMessage ?? console.log;

  do {
    try {
      const defaultBranch = await github.defaultBranch(repository);
      const bootstrapSha = await github.branchHead(repository, defaultBranch);
      const bootstrapConfig = parseConfig(
        await github.fileContent(repository, bootstrapSha, CONFIG_FILE),
        `${repository.fullName}/${CONFIG_FILE}`,
      );
      intervalSeconds = bootstrapConfig.pollIntervalSeconds;
      for (const branch of bootstrapConfig.branches) {
        if (options.signal?.aborted) return;
        const isDefaultBranch = branch === defaultBranch;
        const sha = isDefaultBranch ? bootstrapSha : await github.branchHead(repository, branch);
        const config = isDefaultBranch
          ? bootstrapConfig
          : parseConfig(
              await github.fileContent(repository, sha, CONFIG_FILE),
              `${repository.fullName}/${CONFIG_FILE}@${sha.slice(0, 7)}`,
            );
        const build = await runCommit(github, repository, sha, branch, config);
        if (build) message(`${build.status} ${build.id} ${branch}@${sha.slice(0, 7)}`);
      }
    } catch (error) {
      message(`poll failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (options.once) return;
    await Bun.sleep(intervalSeconds * 1_000);
  } while (!options.signal?.aborted);
}

export async function serveRepositories(
  repositories: Repository[],
  options: ServerOptions = {},
): Promise<void> {
  await Promise.all(
    repositories.map((repository) =>
      serve(repository, {
        ...options,
        onMessage: (message) => options.onMessage?.(`${repository.fullName} · ${message}`),
      }),
    ),
  );
}
