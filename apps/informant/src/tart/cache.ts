import { mkdir, readdir, readFile, realpath, rm, stat, utimes } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { dataDirectory } from "../store.ts";
import type { InformantConfig, Repository } from "../types.ts";
import { digest, shellQuote } from "./vm.ts";

export function cachePathIdentity(user: string, path: string): string {
  return digest(`${user}\0${path}`).slice(0, 16);
}

const CACHE_VERSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

async function pruneCacheVersions(parent: string, current: string): Promise<void> {
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
  const versions: Array<{ name: string; modifiedAt: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === current) continue;
    const metadata = await stat(join(parent, entry.name)).catch(() => undefined);
    if (metadata) versions.push({ name: entry.name, modifiedAt: metadata.mtimeMs });
  }
  versions.sort((a, b) => b.modifiedAt - a.modifiedAt);
  const cutoff = Date.now() - CACHE_VERSION_RETENTION_MS;
  await Promise.all(
    versions
      .slice(1)
      .filter((version) => version.modifiedAt < cutoff)
      .map((version) => rm(join(parent, version.name), { recursive: true, force: true })),
  );
}

export async function cacheMounts(
  repository: Repository,
  workspace: string,
  job: InformantConfig["jobs"][number],
  user: string,
  trusted = false,
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
      if (cache.shared) {
        const host = trusted
          ? join(dataDirectory(), "caches", "shared", cachePathIdentity(user, path))
          : join(workspace, "..", "shared-caches", cachePathIdentity(user, path));
        await mkdir(host, { recursive: true });
        args.push(`--dir=cache-${mountIndex}:${await realpath(host)}`);
        const guest = `/Users/${user}/${path.slice(2)}`;
        const parent = guest.slice(0, guest.lastIndexOf("/"));
        const shared = `/Volumes/My Shared Files/cache-${mountIndex}`;
        restore.push(
          `mkdir -p ${shellQuote(parent)} && rm -rf ${shellQuote(guest)} && ln -s ${shellQuote(shared)} ${shellQuote(guest)}`,
        );
        mountIndex++;
        continue;
      }
      const parent = join(root, cachePathIdentity(user, path));
      const host = join(parent, cacheKey);
      await mkdir(host, { recursive: true });
      const now = new Date();
      await utimes(host, now, now);
      await pruneCacheVersions(parent, cacheKey);
      args.push(`--dir=cache-${mountIndex}:${await realpath(host)}`);
      const guest = `/Users/${user}/${path.slice(2)}`;
      const shared = `/Volumes/My Shared Files/cache-${mountIndex}`;
      const temporary = `${shared}/cache-${crypto.randomUUID().slice(0, 8)}.tar.gz.tmp`;
      restore.push(
        `mkdir -p ${shellQuote(guest)} && if [ -f ${shellQuote(`${shared}/cache.tar.gz`)} ]; then tar -xzpf ${shellQuote(`${shared}/cache.tar.gz`)} -C ${shellQuote(guest)}; fi`,
      );
      save.push(
        `tar -czpf ${shellQuote(temporary)} -C ${shellQuote(guest)} . && mv -f ${shellQuote(temporary)} ${shellQuote(`${shared}/cache.tar.gz`)}`,
      );
      mountIndex++;
    }
  }
  return {
    args,
    restore: restore.join(" && "),
    save: save.length > 0 ? save.join(" && ") : restore.length > 0 ? ":" : "",
  };
}
