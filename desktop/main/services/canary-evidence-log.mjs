import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function disabledLog() {
  return Object.freeze({
    enabled: false,
    path: null,
    write: async () => {},
    flush: async () => {},
  });
}

export function createCanaryEvidenceLog({
  environment = process.env,
  appIsPackaged,
  releaseMetadata,
  platform = process.platform,
  architecture = process.arch,
  processId = process.pid,
  now = () => new Date(),
  append = appendFile,
  makeDirectory = mkdir,
} = {}) {
  const configuredPath = String(environment.RELAYER_DESKTOP_CANARY_LOG || "").trim();
  if (!configuredPath || !appIsPackaged || !releaseMetadata?.targetKey) return disabledLog();

  const outputPath = resolve(configuredPath);
  let pending = Promise.resolve();
  const write = (state) => {
    const record = {
      schemaVersion: 1,
      capturedAt: now().toISOString(),
      processId,
      target: releaseMetadata.targetKey,
      platform,
      architecture,
      state: { ...state },
    };
    pending = pending.then(async () => {
      await makeDirectory(dirname(outputPath), { recursive: true });
      await append(outputPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    });
    return pending;
  };

  return Object.freeze({
    enabled: true,
    path: outputPath,
    write,
    flush: () => pending,
  });
}
