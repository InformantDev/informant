import { mkdir, readdir, readFile, realpath, rm, stat, utimes } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { dataDirectory } from "../store.ts";
import type { InformantConfig, Repository } from "../types.ts";
import { guestHome, guestSharedRoot } from "./layout.ts";
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
  guestOs: InformantConfig["vm"]["guestOs"],
  trusted = false,
  directShared = false,
) {
  if (!job.cache)
    return {
      args: [] as string[],
      mounts: [] as Array<{ name: string; path: string }>,
      restore: "",
      save: "",
      writablePaths: [] as string[],
      installLock: undefined as string | undefined,
    };
  const workspaceRoot = await realpath(workspace);
  const persistentRoot = join(dataDirectory(), "caches", ...(guestOs === "linux" ? ["linux"] : []));
  const root = join(
    persistentRoot,
    digest(repository.fullName).slice(0, 16),
    digest(job.name).slice(0, 16),
  );
  const args: string[] = [];
  const mounts: Array<{ name: string; path: string }> = [];
  const restore: string[] = [];
  const save: string[] = [];
  const writablePaths: string[] = [];
  let installLock: string | undefined;
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
      const direct =
        cache.shared &&
        (guestOs !== "linux" || directShared) &&
        !(directShared && guestOs === "linux" && path === "~/.bun/install/cache");
      if (direct) {
        const host =
          trusted && !cache.buildScoped
            ? join(persistentRoot, "shared", cachePathIdentity(user, path))
            : join(workspace, "..", "shared-caches", cachePathIdentity(user, path));
        await mkdir(host, { recursive: true });
        const resolvedHost = await realpath(host);
        args.push(`--dir=cache-${mountIndex}:${resolvedHost}`);
        mounts.push({ name: `cache-${mountIndex}`, path: resolvedHost });
        writablePaths.push(resolvedHost);
        const guest = `${guestHome(guestOs, user)}/${path.slice(2)}`;
        const parent = guest.slice(0, guest.lastIndexOf("/"));
        const shared = `${guestSharedRoot(guestOs)}/cache-${mountIndex}`;
        if (cache.shared && path === "~/.bun/install/cache")
          installLock = `${shared}/.informant-install-lock`;
        restore.push(
          `mkdir -p ${shellQuote(parent)} && rm -rf ${shellQuote(guest)} && ln -s ${shellQuote(shared)} ${shellQuote(guest)}`,
        );
        mountIndex++;
        continue;
      }
      const parent = cache.shared
        ? trusted && !cache.buildScoped
          ? join(persistentRoot, "shared", cachePathIdentity(user, path))
          : join(workspace, "..", "shared-caches", cachePathIdentity(user, path))
        : trusted
          ? join(root, cachePathIdentity(user, path))
          : join(workspace, "..", "keyed-caches", cachePathIdentity(user, path));
      const host = join(parent, cacheKey);
      await mkdir(host, { recursive: true });
      const now = new Date();
      await utimes(host, now, now);
      await pruneCacheVersions(parent, cacheKey);
      const resolvedHost = await realpath(host);
      args.push(`--dir=cache-${mountIndex}:${resolvedHost}`);
      mounts.push({ name: `cache-${mountIndex}`, path: resolvedHost });
      writablePaths.push(resolvedHost);
      const guest = `${guestHome(guestOs, user)}/${path.slice(2)}`;
      const shared = `${guestSharedRoot(guestOs)}/cache-${mountIndex}`;
      if (cache.shared && guestOs === "linux" && path === "~/.bun/install/cache")
        installLock = `${shared}/.informant-install-lock`;
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
    mounts,
    restore: restore.join(" && "),
    save: save.length > 0 ? save.join(" && ") : restore.length > 0 ? ":" : "",
    writablePaths,
    installLock,
  };
}
