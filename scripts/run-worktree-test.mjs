import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import electron from "electron";

const smokeTimeoutMs = 120_000;
const passMarker = "RELAYER_WORKTREES ";
let stdout = "";

const exit = await new Promise((resolve, reject) => {
  let timedOut = false;
  let forceKillTimer = null;
  const child = spawn(electron, [
    fileURLToPath(new URL("./test-desktop-worktrees.mjs", import.meta.url)),
  ], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
    forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    forceKillTimer.unref();
  }, smokeTimeoutMs);
  timeout.unref();
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    stdout += text;
    process.stdout.write(text);
  });
  child.stderr.pipe(process.stderr);
  child.once("error", (error) => {
    clearTimeout(timeout);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    reject(error);
  });
  child.once("exit", (code, signal) => {
    clearTimeout(timeout);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    if (timedOut) {
      reject(new Error(`Worktree Electron smoke exceeded ${smokeTimeoutMs}ms`));
      return;
    }
    resolve({ code, signal });
  });
});

const markerLine = stdout.split("\n").find((line) => line.startsWith(passMarker));
const result = markerLine ? JSON.parse(markerLine.slice(passMarker.length)) : null;
if (exit.code !== 0 || exit.signal || result?.passed !== true || result?.restartPersistence !== true || Object.keys(result?.checkpoints || {}).length !== 17 || Object.values(result.checkpoints).some(passed => passed !== true)) {
  throw new Error(`Worktree Electron smoke failed: ${JSON.stringify({
    exit,
    result: result && {
      passed: result.passed,
      restartPersistence: result.restartPersistence,
    },
    passMarkerPresent: Boolean(markerLine),
  })}`);
}
