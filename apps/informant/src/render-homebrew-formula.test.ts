import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const generator = join(import.meta.dir, "../../../scripts/render-homebrew-formula.sh");
const assets = [
  "informant-darwin-arm64",
  "informant-darwin-x64",
  "informant-linux-arm64",
  "informant-linux-x64",
] as const;

async function render(checksums: string) {
  const directory = await mkdtemp(join(tmpdir(), "informant-formula-test-"));
  const checksumFile = join(directory, "SHA256SUMS");
  const output = join(directory, "informant.rb");
  await Bun.write(checksumFile, checksums);
  const process = Bun.spawn(["/bin/sh", generator, "v1.2.3", checksumFile, output], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ]);
  return { directory, exitCode, output, stderr };
}

test("renders every platform URL and checksum in the Homebrew formula", async () => {
  const checksums = assets
    .map((asset, index) => `${String(index + 1).repeat(64)}  ${asset}`)
    .join("\n");
  const result = await render(`${checksums}\n`);
  try {
    expect(result.exitCode).toBe(0);
    const formula = await Bun.file(result.output).text();
    expect(formula).toContain('version "1.2.3"');
    for (const [index, asset] of assets.entries()) {
      expect(formula).toContain(
        `url "https://github.com/InformantDev/informant/releases/download/v#{version}/${asset}"`,
      );
      expect(formula).toContain(`sha256 "${String(index + 1).repeat(64)}"`);
    }
  } finally {
    await rm(result.directory, { recursive: true, force: true });
  }
});

test("rejects missing and malformed Homebrew checksums", async () => {
  const valid = assets.map((asset) => `${"a".repeat(64)}  ${asset}`);
  const missing = await render(`${valid.slice(0, -1).join("\n")}\n`);
  try {
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("missing or invalid checksum for informant-linux-x64");
  } finally {
    await rm(missing.directory, { recursive: true, force: true });
  }

  valid[2] = `${"b".repeat(63)}  informant-linux-arm64`;
  const malformed = await render(`${valid.join("\n")}\n`);
  try {
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.stderr).toContain("missing or invalid checksum for informant-linux-arm64");
  } finally {
    await rm(malformed.directory, { recursive: true, force: true });
  }
});
