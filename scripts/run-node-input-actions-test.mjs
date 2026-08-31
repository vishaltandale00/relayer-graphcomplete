import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import electron from "electron";

const resultDirectory = await mkdtemp(join(tmpdir(), "relayer-node-input-result-"));
const resultFile = join(resultDirectory, "result.json");
const timeoutMs = 120_000;

try {
  const exit = await new Promise((resolve, reject) => {
    let timedOut = false;
    const child = spawn(electron, [
      fileURLToPath(new URL("./test-desktop-node-input-actions.mjs", import.meta.url)),
    ], {
      stdio: "inherit",
      env: { ...process.env, RELAYER_NODE_INPUT_RESULT_FILE: resultFile },
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timeout.unref();
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) reject(new Error(`Node-input Electron proof exceeded ${timeoutMs}ms`));
      else resolve({ code, signal });
    });
  });
  const result = JSON.parse(await readFile(resultFile, "utf8").catch(() => "null"));
  if (exit.code !== 0 || exit.signal || result?.passed !== true) {
    if (result?.error) process.stderr.write(`${result.error}\n`);
    throw new Error(`Node-input Electron proof failed: ${JSON.stringify({ exit, result })}`);
  }
} finally {
  await rm(resultDirectory, { recursive: true, force: true });
}
