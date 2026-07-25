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
