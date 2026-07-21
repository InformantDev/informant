import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPostPushHook, removeInformantHook, uninstallPostPushHook } from "./hook.ts";
import { requireCommand } from "./process.ts";

describe("hook uninstall", () => {
  test("installs and uninstalls through Git while preserving existing content", async () => {
    const repo = await mkdtemp(join(tmpdir(), "informant-hook-"));
    await requireCommand(["git", "init", "--quiet", repo]);
    const hookPath = join(repo, ".git", "hooks", "pre-push");
    await Bun.write(hookPath, "#!/bin/sh\necho existing\n");

    expect(await installPostPushHook(repo)).toBe(hookPath);
    expect((await Bun.file(hookPath).text()).includes("# informant push accelerator")).toBe(true);
    expect((await stat(hookPath)).mode & 0o111).not.toBe(0);

    expect(await uninstallPostPushHook(repo)).toEqual({ path: hookPath, removed: true });
    expect(await Bun.file(hookPath).text()).toBe("#!/bin/sh\necho existing\n");
  });

  test("uses Git's absolute common hook path from a linked worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "informant-worktree-"));
    const repo = join(root, "main");
    const worktree = join(root, "linked");
    await requireCommand(["git", "init", "--quiet", repo]);
    await requireCommand(["git", "-C", repo, "config", "user.email", "test@example.com"]);
    await requireCommand(["git", "-C", repo, "config", "user.name", "Test"]);
    await Bun.write(join(repo, "README"), "test\n");
    await requireCommand(["git", "-C", repo, "add", "README"]);
    await requireCommand(["git", "-C", repo, "commit", "--quiet", "-m", "initial"]);
    await requireCommand(["git", "-C", repo, "worktree", "add", "--quiet", worktree]);

    const hooksDirectory = (
      await requireCommand(
        ["git", "rev-parse", "--path-format=absolute", "--git-path", "hooks"],
        undefined,
        {
          cwd: worktree,
        },
      )
    ).trim();
    const expected = join(await realpath(hooksDirectory), "pre-push");
    expect(await installPostPushHook(worktree)).toBe(expected);
    expect(await Bun.file(expected).text()).toContain("# informant push accelerator");
    expect(await uninstallPostPushHook(worktree)).toEqual({ path: expected, removed: true });
  });

  test("removes only the managed section", () => {
    const hook = `#!/bin/sh
echo before

# informant push accelerator
echo informant
# end informant push accelerator

echo after
`;
    expect(removeInformantHook(hook)).toEqual({
      source: "#!/bin/sh\necho before\n\necho after\n",
      removed: true,
    });
  });

  test("removes hooks installed before end markers were added", () => {
    const hook = `#!/bin/sh

# informant push accelerator
if command -v informant >/dev/null 2>&1; then
  while read -r local_ref local_sha remote_ref remote_sha; do
    case "$local_sha" in 0000000000000000000000000000000000000000) continue ;; esac
    branch="\${remote_ref#refs/heads/}"
    nohup informant run --ref "$local_sha" --branch "$branch" --wait-for-github </dev/null >>/tmp/informant-post-push.log 2>&1 &
  done
fi
`;
    expect(removeInformantHook(hook)).toEqual({ source: "#!/bin/sh\n", removed: true });
  });

  test("leaves unrelated hooks unchanged", () => {
    const hook = "#!/bin/sh\necho existing\n";
    expect(removeInformantHook(hook)).toEqual({ source: hook, removed: false });
  });
});
