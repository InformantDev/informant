export interface VmRuntime {
  type: "vm";
  image: string;
  guestOs: "macos" | "linux";
  user: string;
  password: string;
  cpu?: number;
  memoryMb?: number;
  prepare?: string;
}

export interface ContainerRuntime {
  type: "container";
  image: string;
  cpu?: number;
  memoryMb?: number;
  prepare?: string;
  prepareInputs?: string[];
}

export interface HostRuntime {
  type: "host";
}

export type JobRuntime = VmRuntime | ContainerRuntime | HostRuntime;

export interface JobConfig {
  name: string;
  command: string;
  optional: boolean;
  timeoutMinutes: number;
  environment: Record<string, string>;
  secrets: string[];
  needs: string[];
  runsOn?: string[];
  runtime?: JobRuntime;
  triggers?: TriggerRule[];
  cache?: Array<{
    paths: string[];
    keyFiles: string[];
    shared: boolean;
  }>;
}

export type TriggerEvent = "commit" | "comment";
export interface PullRequestFilter {
  state?: "open" | "closed" | "all";
  draft?: boolean;
  baseBranches?: string[];
}
export interface TriggerRule {
  event: TriggerEvent;
  branch?: { names: string[] };
  tag?: { patterns: string[] };
  pullRequest?: PullRequestFilter;
}

export interface PullRequest {
  number: number;
  state: "open" | "closed";
  draft: boolean;
  baseBranch: string;
  headSha: string;
  sameRepository: boolean;
}

export interface PullRequestComment {
  id: number;
  pullRequestNumber: number;
  createdAt: string;
  updatedAt: string;
}

export interface InformantConfig {
  version: number;
  pollIntervalSeconds: number;
  /** Default-branch commit that authorized secret-bearing jobs. */
  trustedSha?: string;
  triggers?: TriggerRule[];
  /** Legacy input compatibility; normalized configs omit this field. */
  branches?: string[];
  vm: VmRuntime;
  jobs: JobConfig[];
}

export interface Repository {
  owner: string;
  repo: string;
  fullName: string;
}

export interface CheckRun {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?: string | null;
  external_id?: string | null;
  started_at?: string | null;
  html_url?: string;
  output?: { title?: string; summary?: string; text?: string };
}

export interface BuildRecord {
  id: string;
  repo: string;
  sha: string;
  branch: string;
  machine: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "success" | "failure" | "cancelled";
  runningJobs?: string[];
  jobs?: Array<{
    name: string;
    status: "queued" | "running" | "success" | "failure" | "skipped" | "cancelled";
  }>;
  owner?: { pid: number; startedAt: string };
  pullRequest?: number;
  logPath: string;
  checkId?: number;
  checkUrl?: string;
  checksCompletedAt?: string;
  event?: { type: TriggerEvent | "manual"; id: string };
}
