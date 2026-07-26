import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink } from "node:fs/promises";
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
  tagRefs?: Array<{ name: string; sha: string }>;
  pendingTags: Array<{ name: string; sha: string }>;
}

function path(repo: string) {
  return join(dataDirectory(), "poll", `${repo.replaceAll("/", "--")}.json`);
}
export async function readPollState(repo: string): Promise<PollState> {
  const file = Bun.file(path(repo));
  if (!(await file.exists())) return { pending: [], seenCommentIds: [], pendingTags: [] };
  const state = (await file.json()) as Partial<PollState>;
  return {
    cursor: state.cursor,
    pending: state.pending ?? [],
    seenCommentIds: state.seenCommentIds ?? [],
    tagRefs: state.tagRefs,
    pendingTags: state.pendingTags ?? [],
  };
}
export async function savePollState(repo: string, state: PollState): Promise<void> {
  const directory = join(dataDirectory(), "poll");
  await mkdir(directory, { recursive: true });
  const destination = path(repo);
  const temporary = join(
    directory,
    `.${repo.replaceAll("/", "--")}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await Bun.write(temporary, JSON.stringify(state, null, 2));
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
