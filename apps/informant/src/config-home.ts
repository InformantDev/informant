import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export function xdgConfigHome(
  environment: Record<string, string | undefined> = Bun.env,
  home = homedir(),
): string {
  const configuredHome = environment.XDG_CONFIG_HOME;
  return configuredHome && isAbsolute(configuredHome) ? configuredHome : join(home, ".config");
}
