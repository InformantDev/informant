import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { command, requireCommand } from "../process.ts";
import { dataDirectory } from "../store.ts";
import type { InformantConfig } from "../types.ts";
import {
  digest,
  provisionVm,
  shellQuote,
  sshCommand,
  startVm,
  stopVm,
  tartImages,
  waitForCleanShutdown,
  withImageLock,
} from "./vm.ts";

export function preparedImageName(config: InformantConfig): string | undefined {
  return config.vm.prepare
    ? `informant-prepared-${digest(`${config.vm.image}\0${config.vm.guestOs}\0${config.vm.user}\0${config.vm.prepare}`).slice(0, 16)}`
    : undefined;
}

async function activatePreparedImageLocked(
  repository: string | undefined,
  prepared: string | undefined,
  onMessage: (message: string) => Promise<void> | void,
  signal?: AbortSignal,
): Promise<void> {
  if (!repository) return;
  const directory = join(dataDirectory(), "prepared-image-references");
  const path = join(directory, digest(repository));
  const previous = (await readFile(path, "utf8").catch(() => "")).trim() || undefined;
  if (previous === prepared) return;

  if (previous) {
    const cleanup = await withImageLock(
      previous,
      async () => {
        const references = await readdir(directory).catch(() => []);
        const values = await Promise.all(
          references
            .filter((entry) => join(directory, entry) !== path)
            .map((entry) => readFile(join(directory, entry), "utf8").catch(() => "")),
        );
        if (values.some((value) => value.trim() === previous)) return "retained";
        if (!(await listPreparedImages(signal)).includes(previous)) return "missing";
        const result = await command(["tart", "delete", previous], { timeoutMs: 30_000 });
        return result.exitCode === 0 ? "deleted" : "failed";
      },
      signal,
    );
    if (cleanup === "failed") {
      await onMessage(`Could not delete superseded Tart image ${previous}; will retry later`);
    }
    if (cleanup === "deleted") await onMessage(`Deleted superseded Tart image ${previous}`);
  }

  await mkdir(directory, { recursive: true });
  if (prepared) await Bun.write(path, `${prepared}\n`);
  else await rm(path, { force: true });
}

async function withPreparedImageReferencesLock<T>(
  callback: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return withImageLock("prepared-image-references", callback, signal);
}

async function activatePreparedImage(
  repository: string | undefined,
  prepared: string | undefined,
  onMessage: (message: string) => Promise<void> | void,
  signal?: AbortSignal,
): Promise<void> {
  await withPreparedImageReferencesLock(
    () => activatePreparedImageLocked(repository, prepared, onMessage, signal),
    signal,
  );
}

async function preparedImageReferences(): Promise<Set<string>> {
  const directory = join(dataDirectory(), "prepared-image-references");
  const references = await readdir(directory).catch(() => []);
  const values = await Promise.all(
    references.map((entry) => readFile(join(directory, entry), "utf8").catch(() => "")),
  );
  return new Set(values.map((value) => value.trim()).filter(Boolean));
}

export async function ensurePreparedImage(
  config: InformantConfig,
  onMessage: (message: string) => Promise<void> | void = console.log,
  repository?: string,
  signal?: AbortSignal,
): Promise<string> {
  const prepared = preparedImageName(config);
  if (!prepared) {
    await activatePreparedImage(repository, undefined, onMessage, signal);
    return config.vm.image;
  }
  if (
    (await tartImages(signal)).some((image) => image.Source === "local" && image.Name === prepared)
  ) {
    await activatePreparedImage(repository, prepared, onMessage, signal);
    return prepared;
  }

  const image = await provisionVm(async () => {
    if (
      (await tartImages(signal)).some(
        (image) => image.Source === "local" && image.Name === prepared,
      )
    ) {
      return prepared;
    }
    await onMessage(`Preparing Tart image ${prepared}`);
    const staging = `${prepared}-staging-${crypto.randomUUID().slice(0, 8)}`;
    let process: ReturnType<typeof Bun.spawn> | undefined;
    try {
      await requireCommand(["tart", "clone", config.vm.image, staging], undefined, { signal });
      const ready = await startVm(
        staging,
        [],
        config,
        30,
        async () => {
          await onMessage("Waiting for an available Tart VM slot to prepare the image");
        },
        signal,
      );
      process = ready.process;
      const result = await sshCommand(
        ready.ip,
        config,
        `/bin/bash -lc ${shellQuote(config.vm.prepare ?? "")}`,
        30 * 60_000,
        { signal },
      );
      if (result.exitCode !== 0 || result.timedOut) {
        throw new Error(`image preparation failed: ${result.stdout}${result.stderr}`.trim());
      }
      await sshCommand(ready.ip, config, "sudo shutdown -h now", 60_000, { signal });
      await waitForCleanShutdown(staging, signal);
      await stopVm(staging, process);
      return withPreparedImageReferencesLock(
        () =>
          withImageLock(
            prepared,
            async () => {
              if (
                (await tartImages(signal)).some(
                  (image) => image.Source === "local" && image.Name === prepared,
                )
              ) {
                await requireCommand(["tart", "delete", staging]);
              } else {
                await requireCommand(
                  ["tart", "rename", staging, prepared],
                  "could not publish prepared image",
                );
              }
              await activatePreparedImageLocked(repository, prepared, onMessage, signal);
              return prepared;
            },
            signal,
          ),
        signal,
      );
    } catch (error) {
      if (process) await stopVm(staging, process);
      await command(["tart", "delete", staging], { timeoutMs: 30_000 });
      throw error;
    }
  }, signal);
  await activatePreparedImage(repository, image, onMessage, signal);
  return image;
}

export async function listPreparedImages(signal?: AbortSignal): Promise<string[]> {
  return (await tartImages(signal))
    .filter(
      (image) => image.Source === "local" && /^informant-prepared-[0-9a-f]{16}$/.test(image.Name),
    )
    .map((image) => image.Name);
}

export async function prunePreparedImages(): Promise<number> {
  return withPreparedImageReferencesLock(async () => {
    const referenced = await preparedImageReferences();
    const images = (await listPreparedImages()).filter((image) => !referenced.has(image));
    for (const image of images) {
      await withImageLock(image, async () => requireCommand(["tart", "delete", image]));
    }
    return images.length;
  });
}

export async function pruneStoppedJobVms(): Promise<number> {
  const vms = (await tartImages()).filter(
    (image) =>
      image.Source === "local" &&
      !image.Running &&
      /^informant-[0-9a-f]{8}-[0-9a-f]{3}-\d+$/.test(image.Name),
  );
  for (const vm of vms) {
    await requireCommand(["tart", "delete", vm.Name], `could not delete stale Tart VM ${vm.Name}`);
  }
  return vms.length;
}
