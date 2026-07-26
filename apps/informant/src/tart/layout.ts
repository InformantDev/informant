import type { InformantConfig } from "../types.ts";

export type GuestOs = InformantConfig["vm"]["guestOs"];

export function guestSharedRoot(guestOs: GuestOs): string {
  return guestOs === "linux" ? "/mnt/shared" : "/Volumes/My Shared Files";
}

export function guestHome(guestOs: GuestOs, user: string): string {
  return guestOs === "linux" ? `/home/${user}` : `/Users/${user}`;
}

export function linuxSharedMountCommand(): string {
  return "sudo -n mkdir -p /mnt/shared && (mountpoint -q /mnt/shared || sudo -n mount -t virtiofs com.apple.virtio-fs.automount /mnt/shared) && test -d /mnt/shared/workspace";
}

export function linuxWorkspaceCopyCommand(destination: string): string {
  return `rm -rf ${JSON.stringify(destination)} && mkdir -p ${JSON.stringify(destination)} && cp -a --no-preserve=ownership /mnt/shared/workspace/. ${JSON.stringify(destination)}`;
}

export function raiseFileDescriptorLimit(): string {
  return "if ! ulimit -n 65536 2>/dev/null; then ulimit -n 10240 2>/dev/null || true; fi;";
}

export function bunCopyfileBackend(lockDirectory?: string, exportFunction = true): string {
  const acquire = lockDirectory
    ? `while ! mkdir ${JSON.stringify(lockDirectory)} 2>/dev/null; do sleep 1; done; trap 'rmdir ${JSON.stringify(lockDirectory)} 2>/dev/null || true' EXIT TERM INT; `
    : "";
  const release = lockDirectory
    ? `; informant_bun_status=$?; rmdir ${JSON.stringify(lockDirectory)}; trap - EXIT TERM INT; return $informant_bun_status`
    : "";
  return `bun() { case "$1" in install|i|add|remove|update|link|unlink) ${acquire}for arg in "$@"; do case "$arg" in --backend|--backend=*) command bun "$@"${release}; return;; esac; done; command bun "$@" --backend=copyfile${release};; *) command bun "$@";; esac; };${exportFunction ? " export -f bun;" : ""}`;
}
