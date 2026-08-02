import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { CommandResult } from "./process.ts";
import {
  allocatedDirectorySizes,
  assessDiskSpace,
  collectStorageReport,
  diskSpaceThresholds,
  formatBytes,
  formatStorageReport,
  minimumFreeSpace,
} from "./storage.ts";

function result(stdout = "", stderr = "", exitCode = 0): CommandResult {
  return { stdout, stderr, exitCode, timedOut: false };
}

test("allocated directory sizes use bounded multi-path batches", async () => {
  const calls: string[][] = [];
  const sizes = await allocatedDirectorySizes(
    ["/one", "/two", "/three"],
    async (argv) => {
      calls.push(argv);
      return result(
        argv
          .slice(2)
          .map((path) => `1\t${path}`)
          .join("\n"),
      );
    },
    10,
  );

  expect(calls.map((argv) => argv.slice(2))).toEqual([["/one", "/two"], ["/three"]]);
  expect(sizes).toEqual(
    new Map([
      ["/one", 1024],
      ["/two", 1024],
      ["/three", 1024],
    ]),
  );
});

describe("storage reporting", () => {
  test("collects attributable data and shared runtime usage separately", async () => {
    const root = "/tmp/informant-storage-test";
    const sizes = new Map([
      [join(root, "caches"), 12_000_000_000],
      [join(root, "builds"), 5_000_000_000],
      [join(root, "state"), 3_000_000_000],
    ]);
    let measuredPaths: string[] = [];
    const report = await collectStorageReport(root, {
      dataEntries: async () => ["caches", "builds", "state"],
      directorySizes: async (paths) => {
        measuredPaths = paths;
        return new Map(paths.map((path) => [path, sizes.get(path) ?? 0]));
      },
      fileSystemSpace: async () => ({
        availableBytes: 80_000_000_000,
        totalBytes: 1_000_000_000_000,
      }),
      listTartImages: async () => [
        {
          Name: "informant-prepared-0123456789abcdef",
          Source: "local",
          Size: 32,
        },
        { Name: "informant-12345678-abc-0", Source: "local", Size: 4 },
        { Name: "someone-elses-vm", Source: "local", Size: 10 },
        { Name: "informant-prepared-fedcba9876543210", Source: "remote", Size: 20 },
      ],
      runCommand: async (argv) => {
        if (argv.includes("list")) {
          return result(
            [
              "informant-prepared-container:0123456789abcdef",
              "informant-prepared-container:fedcba9876543210",
              "docker.io/library/bun:1",
            ].join("\n"),
          );
        }
        return result(
          JSON.stringify({
            images: { sizeInBytes: 200_000_000_000, reclaimable: 150_000_000_000 },
          }),
        );
      },
    });

    expect(report.data).toEqual({
      totalBytes: 20_000_000_000,
      cacheBytes: 12_000_000_000,
      buildBytes: 5_000_000_000,
      otherBytes: 3_000_000_000,
    });
    expect(measuredPaths).toEqual([
      join(root, "caches"),
      join(root, "builds"),
      join(root, "state"),
    ]);
    expect(report.tart).toMatchObject({
      available: true,
      count: 2,
      preparedCount: 1,
      bytes: 36_000_000_000,
    });
    expect(report.container).toMatchObject({
      available: true,
      preparedCount: 2,
      imageBytes: 200_000_000_000,
      reclaimableImageBytes: 150_000_000_000,
    });

    const output = formatStorageReport(report);
    expect(output).toMatch(/Job caches\s+12\.0 GB/);
    expect(output).toMatch(/Tart VM images\s+36\.0 GB · 2 images · 1 prepared/);
    expect(output).toMatch(/Container images\s+2 prepared · stored in the shared/);
    expect(output).toMatch(/Known total\s+56\.0 GB · excludes shared container data/);
    expect(output).toContain("80.0 GB of 1.0 TB (8.0%)");
    expect(output).toContain("200 GB · 150 GB reclaimable · runtime-wide");
  });

  test("keeps the report useful when optional runtimes are unavailable", async () => {
    const report = await collectStorageReport("/tmp/informant-storage-test", {
      dataEntries: async () => [],
      directorySizes: async () => new Map(),
      fileSystemSpace: async () => ({ availableBytes: 100, totalBytes: 1_000 }),
      listTartImages: async () => {
        throw new Error("tart not found");
      },
      runCommand: async () => result("", "container not running", 1),
    });

    const output = formatStorageReport(report);
    expect(output).toMatch(/Tart VM images\s+unavailable · tart not found/);
    expect(output).toMatch(/Container images\s+unavailable · container not running/);
    expect(output).toContain("excludes unavailable Tart image size and shared container data");
  });
});

describe("disk space health", () => {
  test("uses both absolute capacity and percentage thresholds", () => {
    expect(assessDiskSpace({ availableBytes: 50_000_000_000, totalBytes: 500_000_000_000 })).toBe(
      "healthy",
    );
    expect(assessDiskSpace({ availableBytes: 20_000_000_000, totalBytes: 500_000_000_000 })).toBe(
      "critical",
    );
    expect(assessDiskSpace({ availableBytes: 20_000_000_000, totalBytes: 100_000_000_000 })).toBe(
      "warning",
    );
    expect(assessDiskSpace({ availableBytes: 5_000_000_000, totalBytes: 500_000_000_000 })).toBe(
      "critical",
    );
  });

  test("uses configurable cleanup warning thresholds", () => {
    const thresholds = diskSpaceThresholds({
      INFORMANT_MIN_FREE_SPACE_GB: "40",
      INFORMANT_MIN_FREE_SPACE_PERCENT: "15",
    });
    const disk = { availableBytes: 30_000_000_000, totalBytes: 100_000_000_000 };
    expect(minimumFreeSpace(disk, thresholds)).toBe(40_000_000_000);
    expect(assessDiskSpace(disk, thresholds)).toBe("warning");
  });

  test("formats human-readable decimal units", () => {
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1_500)).toBe("1.5 KB");
    expect(formatBytes(12_000_000_000)).toBe("12.0 GB");
  });
});
