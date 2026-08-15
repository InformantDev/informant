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
        ? capacity.cpu
        : runtime.type === "vm"
          ? (runtime.cpu ?? capacity.cpu)
          : (runtime.cpu ?? DEFAULT_EXECUTION_RESOURCES.cpu),
    memoryMb:
      runtime.type === "host"
        ? capacity.memoryMb
        : runtime.type === "vm"
          ? (runtime.memoryMb ?? capacity.memoryMb)
          : (runtime.memoryMb ?? DEFAULT_EXECUTION_RESOURCES.memoryMb),
  };
}

interface FlowEdge {
  to: number;
  reverse: number;
  capacity: number;
}

function maximumFlow(graph: FlowEdge[][], source: number, sink: number): number {
  let total = 0;
  while (true) {
    const levels = Array<number>(graph.length).fill(-1);
    levels[source] = 0;
    const queue = [source];
    for (let index = 0; index < queue.length; index++) {
      const node = queue[index];
      if (node === undefined) continue;
      const level = levels[node];
      if (level === undefined) continue;
      for (const edge of graph[node] ?? []) {
        if (edge.capacity > 0 && levels[edge.to] === -1) {
          levels[edge.to] = level + 1;
          queue.push(edge.to);
        }
      }
    }
    if (levels[sink] === -1) return total;

    const next = Array<number>(graph.length).fill(0);
    const send = (node: number, available: number): number => {
      if (node === sink) return available;
      const edges = graph[node] ?? [];
      const level = levels[node];
      if (level === undefined) return 0;
      let edgeIndex = next[node] ?? 0;
      while (edgeIndex < edges.length) {
        const edge = edges[edgeIndex];
        if (edge && edge.capacity > 0 && levels[edge.to] === level + 1) {
          const sent = send(edge.to, Math.min(available, edge.capacity));
          if (sent > 0) {
            edge.capacity -= sent;
            const reverse = graph[edge.to]?.[edge.reverse];
            if (reverse) reverse.capacity += sent;
            return sent;
          }
        }
        edgeIndex++;
        next[node] = edgeIndex;
      }
      return 0;
    };

    while (true) {
      const sent = send(source, Number.POSITIVE_INFINITY);
      if (sent === 0) break;
      total += sent;
    }
  }
}

function maximumAntichainWeight(weights: number[], precedence: Array<[number, number]>): number {
  const count = weights.length;
  const source = count * 2;
  const sink = source + 1;
  const graph = Array.from({ length: sink + 1 }, () => [] as FlowEdge[]);
  const addEdge = (from: number, to: number, capacity: number) => {
    const forward = { to, reverse: graph[to]?.length ?? 0, capacity };
    const reverse = { to: from, reverse: graph[from]?.length ?? 0, capacity: 0 };
    graph[from]?.push(forward);
    graph[to]?.push(reverse);
  };
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  for (let index = 0; index < count; index++) {
    const weight = weights[index] ?? 0;
    addEdge(source, index, weight);
    addEdge(count + index, sink, weight);
  }
  for (const [before, after] of precedence) addEdge(before, count + after, totalWeight);
  return totalWeight - maximumFlow(graph, source, sink);
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

  const precedence: Array<[number, number]> = [];
  for (let before = 0; before < jobs.length; before++) {
    const dependency = jobs[before];
    if (!dependency) continue;
    for (let after = 0; after < jobs.length; after++) {
      const job = jobs[after];
      if (job && dependsOn(job, dependency.name)) precedence.push([before, after]);
    }
  }
  const resources = jobs.map((job) => runtimeResources(job.runtime ?? config.vm, capacity));

  // Runnable jobs form an antichain in the dependency order. Weighted
  // Dilworth reduces its exact maximum weight to a capacitated bipartite
  // matching, avoiding order-dependent and unnecessarily large chain covers.
  return {
    cpu: maximumAntichainWeight(
      resources.map((resource) => resource.cpu),
      precedence,
    ),
    memoryMb: maximumAntichainWeight(
      resources.map((resource) => resource.memoryMb),
      precedence,
    ),
  };
}

interface ExecutionWaiter {
  resources: ExecutionResources;
  signal?: AbortSignal;
  resolve: (release: (() => void) | undefined) => void;
  abort?: () => void;
}

export interface ExecutionCapacitySnapshot {
  capacity: ExecutionResources;
  used: ExecutionResources;
  queued: ExecutionResources;
}

export interface AcquireExecutionSlot {
  (config: InformantConfig, signal?: AbortSignal): Promise<(() => void) | undefined>;
  reserve?: (config: InformantConfig) => () => void;
  snapshot?: () => ExecutionCapacitySnapshot;
}

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

  const acquire: AcquireExecutionSlot = async (config, signal) => {
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
  acquire.reserve = (config) => reserve(claimExecutionResources(config, config.jobs, capacity));
  acquire.snapshot = () => ({
    capacity: { ...capacity },
    used: { ...active },
    queued: waiters.reduce(
      (total, waiter) => ({
        cpu: total.cpu + waiter.resources.cpu,
        memoryMb: total.memoryMb + waiter.resources.memoryMb,
      }),
      { cpu: 0, memoryMb: 0 },
    ),
  });
  return acquire;
}

export const acquireExecutionSlot = createExecutionSlotAcquirer();

export function currentExecutionCapacity(): ExecutionCapacitySnapshot {
  return (
    acquireExecutionSlot.snapshot?.() ?? {
      capacity: executionCapacity(),
      used: { cpu: 0, memoryMb: 0 },
      queued: { cpu: 0, memoryMb: 0 },
    }
  );
}
