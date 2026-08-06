import { existsSync } from "node:fs";
import { readdir, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  appleContainerBackend,
  type ContainerBackend,
  selectContainerBackend,
} from "./container-backend.ts";
import { type CommandResult, command } from "./process.ts";
import { dataDirectory } from "./store.ts";
import { tartImages } from "./tart/vm.ts";

const GIGABYTE = 1_000_000_000;
const DIRECTORY_SIZE_ARGUMENT_BYTES = 64 * 1024;
const DIRECTORY_SIZE_PATHS_PER_BATCH = 256;

export interface FileSystemSpace {
  availableBytes: number;
  totalBytes: number;
}

export interface StorageReport {
  dataPath: string;
  data: {
    totalBytes: number;
    cacheBytes: number;
    buildBytes: number;
    otherBytes: number;
  };
  tart: {
    available: boolean;
    count: number;
    preparedCount: number;
    bytes?: number;
    error?: string;
  };
  container: {
    backend?: string;
    storageDescription?: string;
    globalPruneCommand?: string;
    available: boolean;
    preparedCount?: number;
    imageBytes?: number;
    reclaimableImageBytes?: number;
    error?: string;
  };
  disk: FileSystemSpace;
}

interface StorageOperations {
  dataEntries?: (path: string) => Promise<string[]>;
  directorySizes?: (paths: string[]) => Promise<Map<string, number>>;
  fileSystemSpace?: (path: string) => Promise<FileSystemSpace>;
  listTartImages?: typeof tartImages;
  runCommand?: (argv: string[]) => Promise<CommandResult>;
  containerBackend?: ContainerBackend;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().split("\n", 1)[0] || "not available";
}

export async function allocatedDirectorySizes(
  paths: string[],
  runCommand: typeof command = command,
  maximumArgumentBytes = DIRECTORY_SIZE_ARGUMENT_BYTES,
): Promise<Map<string, number>> {
  if (paths.length === 0) return new Map();
  const batches: string[][] = [];
  let batch: string[] = [];
  let argumentBytes = 0;
  for (const path of paths) {
    const pathBytes = Buffer.byteLength(path) + 1;
    if (
      batch.length > 0 &&
      (batch.length >= DIRECTORY_SIZE_PATHS_PER_BATCH ||
        argumentBytes + pathBytes > maximumArgumentBytes)
    ) {
      batches.push(batch);
      batch = [];
      argumentBytes = 0;
    }
    batch.push(path);
    argumentBytes += pathBytes;
  }
  if (batch.length > 0) batches.push(batch);

  const sizes = new Map<string, number>();
  for (const paths of batches) {
    const result = await runCommand(["du", "-sk", ...paths]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "could not measure Informant data");
    }
    for (const line of result.stdout.trim().split("\n")) {
      if (!line) continue;
      const match = line.match(/^(\d+)\s+(.+)$/);
      const kibibytes = Number.parseInt(match?.[1] ?? "", 10);
      const path = match?.[2];
      if (!path || !Number.isFinite(kibibytes))
        throw new Error(`could not parse disk usage: ${line}`);
      sizes.set(path, kibibytes * 1024);
    }
  }
  return sizes;
}

export async function allocatedDirectorySize(path: string): Promise<number> {
  if (!existsSync(path)) return 0;
  return (await allocatedDirectorySizes([path])).get(path) ?? 0;
}

export async function fileSystemSpace(path: string): Promise<FileSystemSpace> {
  let candidate = path;
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  const stats = await statfs(candidate);
  return {
    availableBytes: stats.bavail * stats.bsize,
    totalBytes: stats.blocks * stats.bsize,
  };
}

async function tartStorage(listImages: typeof tartImages): Promise<StorageReport["tart"]> {
  try {
    const images = (await listImages()).filter(
      (image) => image.Source === "local" && image.Name.startsWith("informant-"),
    );
    const sizes = images.map((image) => image.Size).filter((size) => size !== undefined);
    return {
      available: true,
      count: images.length,
      preparedCount: images.filter((image) => /^informant-prepared-[0-9a-f]{16}$/.test(image.Name))
        .length,
      bytes:
        sizes.length === images.length
          ? sizes.reduce((total, size) => total + size * GIGABYTE, 0)
          : undefined,
    };
  } catch (error) {
    return { available: false, count: 0, preparedCount: 0, error: errorMessage(error) };
  }
}

function appleContainerDiskUsage(source: string): {
  imageBytes?: number;
  reclaimableImageBytes?: number;
} {
  const value = JSON.parse(source) as {
    images?: { sizeInBytes?: unknown; reclaimable?: unknown };
  };
  const imageBytes = value.images?.sizeInBytes;
  const reclaimableImageBytes = value.images?.reclaimable;
  return {
    imageBytes: typeof imageBytes === "number" ? imageBytes : undefined,
    reclaimableImageBytes:
      typeof reclaimableImageBytes === "number" ? reclaimableImageBytes : undefined,
  };
}

function podmanDiskUsage(source: string): {
  imageBytes?: number;
  reclaimableImageBytes?: number;
} {
  const records = JSON.parse(source) as Array<Record<string, unknown>>;
  if (!Array.isArray(records)) return {};
  const images = records.find((record) => String(record.Type).toLowerCase() === "images");
  if (!images) return {};
  const numeric = (keys: string[]) => {
    for (const key of keys) {
      const value = images[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) {
        return Number(value);
      }
    }
    return undefined;
  };
  return {
    imageBytes: numeric(["RawSize", "rawSize", "Size", "size"]),
    reclaimableImageBytes: numeric([
      "RawReclaimable",
      "rawReclaimable",
      "Reclaimable",
      "reclaimable",
    ]),
  };
}

async function containerStorage(
  runCommand: (argv: string[]) => Promise<CommandResult>,
  backend: ContainerBackend,
): Promise<StorageReport["container"]> {
  const [images, usage] = await Promise.all([
    runCommand(backend.listImagesArguments()),
    runCommand(backend.systemDfArguments()),
  ]);
  if (images.exitCode !== 0 && usage.exitCode !== 0) {
    return {
      available: false,
      backend: backend.name,
      storageDescription: backend.sharedStorageDescription,
      globalPruneCommand: backend.globalPruneCommand,
      preparedCount: 0,
      error: errorMessage(images.stderr || usage.stderr || "not available"),
    };
  }
  const preparedCount =
    images.exitCode === 0
      ? images.stdout
          .split("\n")
          .filter((name) =>
            /^informant-prepared-container:[0-9a-f]{16}$/.test(
              backend.normalizeImageName(name.trim()),
            ),
          ).length
      : undefined;
  try {
    return {
      available: true,
      backend: backend.name,
      storageDescription: backend.sharedStorageDescription,
      globalPruneCommand: backend.globalPruneCommand,
      preparedCount,
      ...(usage.exitCode === 0
        ? backend.kind === "apple"
          ? appleContainerDiskUsage(usage.stdout)
          : podmanDiskUsage(usage.stdout)
        : {}),
    };
  } catch (error) {
    return {
      available: true,
      backend: backend.name,
      storageDescription: backend.sharedStorageDescription,
      globalPruneCommand: backend.globalPruneCommand,
      preparedCount,
      error: errorMessage(error),
    };
  }
}

export async function collectStorageReport(
  path = dataDirectory(),
  operations: StorageOperations = {},
): Promise<StorageReport> {
  const listDataEntries =
    operations.dataEntries ??
    (async (dataPath: string) => {
      try {
        return (await readdir(dataPath, { withFileTypes: true })).map((entry) => entry.name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    });
  const measure = operations.directorySizes ?? allocatedDirectorySizes;
  const measureFileSystem = operations.fileSystemSpace ?? fileSystemSpace;
  const listImages = operations.listTartImages ?? tartImages;
  const runCommand = operations.runCommand ?? command;
  const containerBackend =
    operations.containerBackend ??
    (operations.runCommand ? appleContainerBackend : selectContainerBackend()) ??
    appleContainerBackend;
  const dataPaths = (await listDataEntries(path)).map((entry) => join(path, entry));
  const [dataSizes, tart, container, disk] = await Promise.all([
    measure(dataPaths),
    tartStorage(listImages),
    containerStorage(runCommand, containerBackend),
    measureFileSystem(path),
  ]);
  const cacheBytes = dataSizes.get(join(path, "caches")) ?? 0;
  const buildBytes = dataSizes.get(join(path, "builds")) ?? 0;
  const totalBytes = [...dataSizes.values()].reduce((total, size) => total + size, 0);
  return {
    dataPath: path,
    data: {
      totalBytes,
      cacheBytes,
      buildBytes,
      otherBytes: Math.max(0, totalBytes - cacheBytes - buildBytes),
    },
    tart,
    container,
    disk,
  };
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export type DiskSpaceStatus = "healthy" | "warning" | "critical";

export interface DiskSpaceThresholds {
  minimumFreeBytes: number;
  minimumFreeRatio: number;
  criticalFreeBytes: number;
  criticalFreeRatio: number;
}

function environmentNumber(
  environment: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const value = Number(environment[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function diskSpaceThresholds(
  environment: Record<string, string | undefined> = Bun.env,
): DiskSpaceThresholds {
  return {
    minimumFreeBytes: environmentNumber(environment, "INFORMANT_MIN_FREE_SPACE_GB", 25) * GIGABYTE,
    minimumFreeRatio: environmentNumber(environment, "INFORMANT_MIN_FREE_SPACE_PERCENT", 10) / 100,
    criticalFreeBytes: 10 * GIGABYTE,
    criticalFreeRatio: 0.05,
  };
}

export function minimumFreeSpace(
  space: FileSystemSpace,
  thresholds = diskSpaceThresholds(),
): number {
  return Math.max(thresholds.minimumFreeBytes, space.totalBytes * thresholds.minimumFreeRatio);
}

export function assessDiskSpace(
  space: FileSystemSpace,
  thresholds = diskSpaceThresholds(),
): DiskSpaceStatus {
  const availableRatio = space.totalBytes > 0 ? space.availableBytes / space.totalBytes : 0;
  if (
    space.availableBytes < thresholds.criticalFreeBytes ||
    availableRatio < thresholds.criticalFreeRatio
  )
    return "critical";
  if (
    space.availableBytes < thresholds.minimumFreeBytes ||
    availableRatio < thresholds.minimumFreeRatio
  )
    return "warning";
  return "healthy";
}

function row(label: string, value: string, indent = 2): string {
  return `${" ".repeat(indent)}${label.padEnd(30 - indent)}${value}`;
}

export function formatStorageReport(report: StorageReport): string {
  const lines = [
    "Informant storage",
    row("Data directory", formatBytes(report.data.totalBytes)),
    row("Job caches", formatBytes(report.data.cacheBytes), 4),
    row("Builds and logs", formatBytes(report.data.buildBytes), 4),
    row("Other data", formatBytes(report.data.otherBytes), 4),
  ];
  if (report.tart.available) {
    const count = `${report.tart.count} ${report.tart.count === 1 ? "image" : "images"}`;
    const prepared = `${report.tart.preparedCount} prepared`;
    lines.push(
      row(
        "Tart VM images",
        `${report.tart.bytes === undefined ? "size unavailable" : formatBytes(report.tart.bytes)} · ${count} · ${prepared}`,
      ),
    );
  } else {
    lines.push(row("Tart VM images", `unavailable · ${report.tart.error ?? "not found"}`));
  }
  if (report.container.available) {
    const prepared =
      report.container.preparedCount === undefined
        ? "prepared image count unavailable"
        : `${report.container.preparedCount} prepared`;
    lines.push(
      row(
        "Container images",
        `${prepared} · stored in ${report.container.storageDescription ?? "the selected runtime"}`,
      ),
    );
  } else {
    lines.push(
      row("Container images", `unavailable · ${report.container.error ?? "runtime not running"}`),
    );
  }
  const attributableBytes = report.data.totalBytes + (report.tart.bytes ?? 0);
  const excluded = ["shared container data"];
  if (report.tart.bytes === undefined) excluded.unshift("unavailable Tart image size");
  lines.push(
    row("Known total", `${formatBytes(attributableBytes)} · excludes ${excluded.join(" and ")}`),
    "",
    "Host disk",
    row(
      "Free",
      `${formatBytes(report.disk.availableBytes)} of ${formatBytes(report.disk.totalBytes)} (${report.disk.totalBytes > 0 ? ((report.disk.availableBytes / report.disk.totalBytes) * 100).toFixed(1) : "0.0"}%)`,
    ),
  );
  if (report.container.imageBytes !== undefined) {
    const reclaimable =
      report.container.reclaimableImageBytes === undefined
        ? ""
        : ` · ${formatBytes(report.container.reclaimableImageBytes)} reclaimable`;
    lines.push(
      row(
        `${report.container.backend ?? "Container"} images`,
        `${formatBytes(report.container.imageBytes)}${reclaimable} · runtime-wide`,
      ),
    );
  }
  lines.push(
    "",
    `Data path: ${report.dataPath}`,
    "",
    "Automatic cleanup",
    row("Worker housekeeping", "Runs at startup and whenever all builds are idle"),
    row(
      "Free-space target",
      `${formatBytes(minimumFreeSpace(report.disk))} (${(diskSpaceThresholds().minimumFreeRatio * 100).toFixed(0)}% or configured minimum)`,
    ),
    "",
    "Manage space",
    row("informant cache prune", "Remove keyed caches; keep shared caches"),
    row("informant cache clear", "Remove all persistent job caches"),
    row("informant image prune", "Remove unused prepared runtime images"),
  );
  if (report.container.globalPruneCommand) {
    lines.push(
      row(
        report.container.globalPruneCommand,
        "Remove unused runtime images, including non-Informant images",
      ),
    );
  }
  return lines.join("\n");
}
