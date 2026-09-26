import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import electron from "electron";

const resultDirectory = await mkdtemp(join(tmpdir(), "relayer-visual-node-detail-result-"));
const resultFile = join(resultDirectory, "result.json");
const timeoutMs = 120_000;
let child;
let forwardedSignal = null;

const forwardSignal = (signal) => {
  forwardedSignal = signal;
  child?.kill(signal);
};
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, forwardSignal);

try {
  const exit = await new Promise((resolve, reject) => {
    let timedOut = false;
    let forceKillTimer;
    child = spawn(electron, [
      fileURLToPath(new URL("./test-desktop-visual-node-details.mjs", import.meta.url)),
    ], {
      stdio: "inherit",
      env: { ...process.env, RELAYER_VISUAL_NODE_DETAIL_RESULT_FILE: resultFile },
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      forceKillTimer.unref();
    }, timeoutMs);
    timeout.unref();
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (timedOut) reject(new Error(`Visual Node Detail Electron proof exceeded ${timeoutMs}ms`));
      else resolve({ code, signal });
    });
  });
  if (forwardedSignal) throw new Error("Visual Node Detail proof cancelled");
  const result = JSON.parse(await readFile(resultFile, "utf8").catch(() => "null"));
  const manifest = result?.manifestPath
    ? JSON.parse(await readFile(result.manifestPath, "utf8").catch(() => "null"))
    : null;
  const valid = exit.code === 0
    && !exit.signal
    && result?.passed === true
    && result.cleanupCompleted === true
    && result.paidInferenceCalls === 0
    && manifest?.schemaVersion === 1
    && manifest?.paidInferenceCalls === 0
    && manifest?.screenshot?.mode === "full"
    && manifest?.screenshot?.tileCount >= 1
    && manifest?.assertions?.serverMutationRejected?.code === "read_only_session"
    && manifest?.assertions?.reopened === true
    && manifest?.assertions?.visualAsset?.renderedAsset?.naturalWidth > 0
    && manifest?.assertions?.visualAssetReopened?.naturalWidth > 0
    && manifest?.assertions?.visualAssetExportImport?.portabilityPending === false
    && manifest?.assertions?.visualAssetExportImport?.renderedAsset?.naturalWidth > 0
    && manifest?.assertions?.visualAssetExportImport?.screenshot?.tileCount >= 1;
  if (!valid) {
    if (result?.error) process.stderr.write(`${result.error}\n`);
    throw new Error(`Visual Node Detail Electron proof failed: ${JSON.stringify({ exit, result, manifest })}`);
  }
  process.stdout.write(`Visual Node Detail Electron proof passed: ${result.manifestPath}\n`);
} catch (error) {
  if (!forwardedSignal) throw error;
} finally {
  for (const signal of ["SIGINT", "SIGTERM"]) process.removeListener(signal, forwardSignal);
  await rm(resultDirectory, { recursive: true, force: true });
}

if (forwardedSignal) process.kill(process.pid, forwardedSignal);
