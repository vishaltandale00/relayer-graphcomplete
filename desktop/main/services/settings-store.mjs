import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function createSettingsStore(userDataPath) {
  const path = join(userDataPath, "desktop-settings.json");
  let pendingMutation = Promise.resolve();

  async function readFileSettings() {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }

  async function writeFileSettings(settings) {
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  function mutate(operation) {
    const result = pendingMutation.then(operation, operation);
    pendingMutation = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    async read() {
      await pendingMutation;
      return readFileSettings();
    },
    async write(settings) {
      return mutate(() => writeFileSettings(settings));
    },
    async update(updateSettings) {
      if (typeof updateSettings !== "function") throw new TypeError("Settings update must be a function.");
      return mutate(async () => {
        const current = await readFileSettings();
        const next = await updateSettings(current);
        await writeFileSettings(next);
        return next;
      });
    },
    async flush() {
      await pendingMutation;
    },
  };
}
