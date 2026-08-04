import { arch, hostname, platform } from "node:os";
import type { InformantConfig } from "./types.ts";

const architectureLabel = (value: string) =>
  value === "x64" ? "x64" : value === "arm64" ? "arm64" : value;

export function workerCapabilities(environment = Bun.env): string[] {
  const configured = (environment.INFORMANT_CAPABILITIES ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return [
    ...new Set([
      "self-hosted",
      platform(),
      architectureLabel(arch()),
      hostname().toLowerCase(),
      ...configured,
    ]),
  ];
}

export function selectCapableJobs(
  config: InformantConfig,
  capabilities: string[],
): InformantConfig {
  const available = new Set(capabilities.map((value) => value.toLowerCase()));
  const selected = new Set(
    config.jobs
      .filter((job) => (job.runsOn ?? []).every((label) => available.has(label.toLowerCase())))
      .map((job) => job.name),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const job of config.jobs) {
      if (selected.has(job.name) && job.needs.some((name) => !selected.has(name))) {
        selected.delete(job.name);
        changed = true;
      }
    }
  }
  return { ...config, jobs: config.jobs.filter((job) => selected.has(job.name)) };
}
