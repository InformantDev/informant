import { availableParallelism, totalmem } from "node:os";
import type { InformantConfig, JobConfig, JobRuntime } from "./types.ts";

export interface ExecutionResources {
  cpu: number;
  memoryMb: number;
}

const DEFAULT_EXECUTION_RESOURCES: ExecutionResources = { cpu: 1, memoryMb: 1024 };

export function executionCapacity(
  hostCpu = availableParallelism(),
  hostMemoryMb = Math.floor(totalmem() / 1024 / 1024),
): ExecutionResources {
  return {
    cpu: Math.max(1, hostCpu - 2),
    memoryMb: Math.max(1024, Math.floor(hostMemoryMb * 0.75)),
  };
}

function runtimeResources(runtime: JobRuntime, capacity: ExecutionResources): ExecutionResources {
  return {
    cpu:
      runtime.type === "host"
        ? 1
        : runtime.type === "vm"
          ? (runtime.cpu ?? capacity.cpu)
          : (runtime.cpu ?? DEFAULT_EXECUTION_RESOURCES.cpu),
    memoryMb:
      runtime.type === "host"
        ? 1024
        : runtime.type === "vm"
          ? (runtime.memoryMb ?? capacity.memoryMb)
          : (runtime.memoryMb ?? DEFAULT_EXECUTION_RESOURCES.memoryMb),
  };
}

/**
 * A claim unit starts all dependency roots eagerly. Reserve enough capacity for
 * those roots, or for its largest later job when the unit starts with a small
 * dependency. The runtime-specific schedulers continue to arbitrate later DAG
 * fan-out as jobs become runnable.
 */
export function claimExecutionResources(
  config: InformantConfig,
  jobs: JobConfig[] = config.jobs,
  capacity: ExecutionResources = executionCapacity(),
): ExecutionResources {
  const byName = new Map(jobs.map((job) => [job.name, job]));
  const ordered: JobConfig[] = [];
  const visited = new Set<string>();
  const visit = (job: JobConfig) => {
    if (visited.has(job.name)) return;
    visited.add(job.name);
    for (const dependency of job.needs) {
      const required = byName.get(dependency);
      if (required) visit(required);
    }
    ordered.push(job);
  };
  for (const job of jobs) visit(job);

  const dependencyMemo = new Map<string, boolean>();
  const dependsOn = (job: JobConfig, dependency: string): boolean => {
    const key = `${job.name}\0${dependency}`;
    const cached = dependencyMemo.get(key);
    if (cached !== undefined) return cached;
    const result = job.needs.some((name) => {
      if (name === dependency) return true;
      const required = byName.get(name);
      return required ? dependsOn(required, dependency) : false;
    });
    dependencyMemo.set(key, result);
    return result;
  };

  // Partition the DAG into chains. Concurrent jobs form an antichain and can
  // contain at most one job from each chain, so summing each chain's largest
  // request is a safe bound without charging sequential jobs cumulatively.
  const chains: Array<{ last: JobConfig; cpu: number; memoryMb: number }> = [];
  for (const job of ordered) {
    const resources = runtimeResources(job.runtime ?? config.vm, capacity);
    const chain = chains.find((candidate) => dependsOn(job, candidate.last.name));
    if (chain) {
      chain.last = job;
      chain.cpu = Math.max(chain.cpu, resources.cpu);
      chain.memoryMb = Math.max(chain.memoryMb, resources.memoryMb);
    } else {
      chains.push({ last: job, ...resources });
    }
  }
  return chains.reduce(
    (total, chain) => ({
      cpu: total.cpu + chain.cpu,
      memoryMb: total.memoryMb + chain.memoryMb,
    }),
    { cpu: 0, memoryMb: 0 },
  );
}

interface ExecutionWaiter {
  resources: ExecutionResources;
  signal?: AbortSignal;
  resolve: (release: (() => void) | undefined) => void;
  abort?: () => void;
}

export type AcquireExecutionSlot = (
  config: InformantConfig,
  signal?: AbortSignal,
) => Promise<(() => void) | undefined>;

export function createExecutionSlotAcquirer(
  capacity: ExecutionResources = executionCapacity(),
): AcquireExecutionSlot {
  const active: ExecutionResources = { cpu: 0, memoryMb: 0 };
  const waiters: ExecutionWaiter[] = [];

  const hasCapacity = (resources: ExecutionResources) =>
    active.cpu + resources.cpu <= capacity.cpu &&
    active.memoryMb + resources.memoryMb <= capacity.memoryMb;

  const reserve = (resources: ExecutionResources): (() => void) => {
    active.cpu += resources.cpu;
    active.memoryMb += resources.memoryMb;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active.cpu -= resources.cpu;
      active.memoryMb -= resources.memoryMb;
      dispatch();
    };
  };

  const dispatch = () => {
    while (waiters.length > 0) {
      const waiter = waiters[0];
      if (!waiter) return;
      if (waiter.signal?.aborted) {
        waiters.shift();
        if (waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
        waiter.resolve(undefined);
        continue;
      }
      if (!hasCapacity(waiter.resources) && active.cpu > 0) return;
      waiters.shift();
      if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
      waiter.resolve(reserve(waiter.resources));
    }
  };

  return async (config, signal) => {
    if (signal?.aborted) return undefined;
    const resources = claimExecutionResources(config, config.jobs, capacity);
    if ((hasCapacity(resources) || active.cpu === 0) && waiters.length === 0) {
      return reserve(resources);
    }
    return new Promise((resolve) => {
      const waiter: ExecutionWaiter = { resources, signal, resolve };
      waiter.abort = () => {
        const index = waiters.indexOf(waiter);
        if (index !== -1) waiters.splice(index, 1);
        resolve(undefined);
        dispatch();
      };
      signal?.addEventListener("abort", waiter.abort, { once: true });
      waiters.push(waiter);
      if (signal?.aborted) waiter.abort();
    });
  };
}

export const acquireExecutionSlot = createExecutionSlotAcquirer();
