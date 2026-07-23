import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { dataDirectory } from "./store.ts";
import type { PullRequest } from "./types.ts";

export interface PendingComment {
  id: number;
  sha: string;
  createdAt: string;
  pullRequest: PullRequest;
}
export interface PollState {
  cursor?: string;
  pending: PendingComment[];
  seenCommentIds: number[];
}

function path(repo: string) {
  return join(dataDirectory(), "poll", `${repo.replaceAll("/", "--")}.json`);
}
export async function readPollState(repo: string): Promise<PollState> {
  const file = Bun.file(path(repo));
  if (!(await file.exists())) return { pending: [], seenCommentIds: [] };
  const state = (await file.json()) as Partial<PollState>;
  return {
    cursor: state.cursor,
    pending: state.pending ?? [],
    seenCommentIds: state.seenCommentIds ?? [],
  };
}
export async function savePollState(repo: string, state: PollState): Promise<void> {
  await mkdir(join(dataDirectory(), "poll"), { recursive: true });
  await Bun.write(path(repo), JSON.stringify(state, null, 2));
}
