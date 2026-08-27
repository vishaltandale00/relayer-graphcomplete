import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import electron from "electron";

const resultDirectory = await mkdtemp(join(tmpdir(), "relayer-interaction-context-result-"));
const resultFile = join(resultDirectory, "result.json");
const smokeTimeoutMs = 120_000;

try {
  const exit = await new Promise((resolve, reject) => {
    let timedOut = false;
    let forceKillTimer = null;
    const child = spawn(electron, [
      fileURLToPath(new URL("./test-interaction-context-lifecycle.mjs", import.meta.url)),
    ], {
      stdio: "inherit",
      env: { ...process.env, RELAYER_INTERACTION_CONTEXT_RESULT_FILE: resultFile },
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      forceKillTimer.unref();
    }, smokeTimeoutMs);
    timeout.unref();
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (timedOut) {
        reject(new Error(`Interaction-context Electron smoke exceeded ${smokeTimeoutMs}ms`));
        return;
      }
      resolve({ code, signal });
    });
  });
  const result = JSON.parse(await readFile(resultFile, "utf8").catch(() => "null"));
  if (exit.code !== 0 || exit.signal || result?.passed !== true) {
    if (result?.error) process.stderr.write(`${result.error}\n`);
    throw new Error(`Interaction-context Electron smoke failed: ${JSON.stringify({ exit, result: result && { passed: result.passed } })}`);
  }
} finally {
  await rm(resultDirectory, { recursive: true, force: true });
}
