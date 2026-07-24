import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { dataDirectory } from "./store.ts";
import { digest, shellQuote } from "./tart-vm.ts";
import type { InformantConfig, Repository } from "./types.ts";

export function cachePathIdentity(user: string, path: string): string {
  return digest(`${user}\0${path}`).slice(0, 16);
}

export async function cacheMounts(
  repository: Repository,
  workspace: string,
  job: InformantConfig["jobs"][number],
  user: string,
) {
  if (!job.cache) return { args: [] as string[], restore: "", save: "" };
  const workspaceRoot = await realpath(workspace);
  const root = join(
    dataDirectory(),
    "caches",
    digest(repository.fullName).slice(0, 16),
    digest(job.name).slice(0, 16),
  );
  const args: string[] = [];
  const restore: string[] = [];
  const save: string[] = [];
  let mountIndex = 0;
  for (const cache of job.cache) {
    const key = new Bun.CryptoHasher("sha256");
    for (const keyFile of cache.keyFiles) {
      key.update(keyFile).update("\0");
      let resolved: string;
      try {
        resolved = await realpath(join(workspaceRoot, keyFile));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          key.update("missing").update("\0");
          continue;
        }
        throw error;
      }
      const location = relative(workspaceRoot, resolved);
      if (location === ".." || location.startsWith(`..${sep}`) || isAbsolute(location)) {
        throw new Error(`cache key file escapes the workspace: ${keyFile}`);
      }
      const metadata = await stat(resolved);
      if (!metadata.isFile() || metadata.size > 16 * 1024 * 1024) {
        throw new Error(`cache key file must be a regular file no larger than 16 MiB: ${keyFile}`);
      }
      key.update(await readFile(resolved));
      key.update("\0");
    }
    const cacheKey = cache.keyFiles.length > 0 ? key.digest("hex").slice(0, 24) : "default";
    for (const path of cache.paths) {
      const host = join(root, cachePathIdentity(user, path), cacheKey);
      await mkdir(host, { recursive: true });
      args.push(`--dir=cache-${mountIndex}:${await realpath(host)}`);
      const guest = `/Users/${user}/${path.slice(2)}`;
      const shared = `/Volumes/My Shared Files/cache-${mountIndex}`;
      const temporary = `${shared}/cache-${crypto.randomUUID().slice(0, 8)}.tmp`;
      restore.push(
        `mkdir -p ${shellQuote(guest)} && if [ -f ${shellQuote(`${shared}/cache.tar`)} ]; then tar -xpf ${shellQuote(`${shared}/cache.tar`)} -C ${shellQuote(guest)}; fi`,
      );
      save.push(
        `tar -cpf ${shellQuote(temporary)} -C ${shellQuote(guest)} . && mv -f ${shellQuote(temporary)} ${shellQuote(`${shared}/cache.tar`)}`,
      );
      mountIndex++;
    }
  }
  return { args, restore: restore.join(" && "), save: save.join(" && ") };
}
