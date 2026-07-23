export interface JobConfig {
  name: string;
  command: string;
  timeoutMinutes: number;
  environment: Record<string, string>;
  needs: string[];
  cache?: Array<{
    paths: string[];
    keyFiles: string[];
  }>;
}

export interface InformantConfig {
  version: number;
  pollIntervalSeconds: number;
  branches: string[];
  vm: {
    image: string;
    user: string;
    password: string;
    cpu?: number;
    memoryMb?: number;
    prepare?: string;
  };
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
  logPath: string;
  checkUrl?: string;
}
