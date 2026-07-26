import { chmod, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { requireCommand } from "./process.ts";

const START_MARKER = "# informant push accelerator";
const END_MARKER = "# end informant push accelerator";
const HOOK_BODY = `if command -v informant >/dev/null 2>&1; then
  while read -r local_ref local_sha remote_ref remote_sha; do
    case "$local_sha" in 0000000000000000000000000000000000000000) continue ;; esac
    case "$remote_ref" in refs/heads/*) ;; *) continue ;; esac
    branch="\${remote_ref#refs/heads/}"
    nohup informant run --ref "$local_sha" --branch "$branch" --wait-for-github </dev/null >>/tmp/informant-post-push.log 2>&1 &
  done
fi
`;
const LEGACY_HOOK_BODY = HOOK_BODY.replace(
  '    case "$remote_ref" in refs/heads/*) ;; *) continue ;; esac\n',
  "",
);

export function removeInformantHook(source: string): { source: string; removed: boolean } {
  const start = source.indexOf(START_MARKER);
  if (start === -1) return { source, removed: false };

  const markedEnd = source.indexOf(END_MARKER, start);
  let end: number;
  if (markedEnd !== -1) {
    const followingNewline = source.indexOf("\n", markedEnd + END_MARKER.length);
    end = followingNewline === -1 ? source.length : followingNewline + 1;
  } else {
    const legacyBlock = [HOOK_BODY, LEGACY_HOOK_BODY]
      .map((body) => `${START_MARKER}\n${body}`)
      .find((block) => source.startsWith(block, start));
    if (!legacyBlock) {
      throw new Error("the Informant hook section was modified; remove it manually");
    }
    end = start + legacyBlock.length;
  }

  const before = source.slice(0, start).trimEnd();
  const after = source.slice(end).trim();
  const updated = [before, after].filter(Boolean).join("\n\n");
  return { source: updated ? `${updated}\n` : "", removed: true };
}

export async function installPostPushHook(repo = process.cwd()): Promise<string> {
  const hooksDirectory = await requireCommand(
    ["git", "rev-parse", "--git-path", "hooks"],
    undefined,
    { cwd: repo },
  );
  const path = join(
    isAbsolute(hooksDirectory) ? hooksDirectory : resolve(repo, hooksDirectory),
    "pre-push",
  );
  await mkdir(dirname(path), { recursive: true });
  const existing = await Bun.file(path)
    .text()
    .catch(() => "#!/bin/sh\n");
  const unmanaged = removeInformantHook(existing).source;
  const source = `${unmanaged.trimEnd()}\n\n${START_MARKER}\n${HOOK_BODY}${END_MARKER}\n`;
  await Bun.write(path, source);
  await chmod(path, 0o755);
  return path;
}

export async function uninstallPostPushHook(
  repo = process.cwd(),
): Promise<{ path: string; removed: boolean }> {
  const hooksDirectory = await requireCommand(
    ["git", "rev-parse", "--git-path", "hooks"],
    undefined,
    { cwd: repo },
  );
  const path = join(
    isAbsolute(hooksDirectory) ? hooksDirectory : resolve(repo, hooksDirectory),
    "pre-push",
  );
  const existing = await Bun.file(path)
    .text()
    .catch(() => "");
  const result = removeInformantHook(existing);
  if (result.removed) await Bun.write(path, result.source);
  return { path, removed: result.removed };
}
