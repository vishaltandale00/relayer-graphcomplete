import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Chromium may still write its profile while Electron exits. The parent owns
// that directory through process exit, independently of product-fixture reset.
export async function runElectronProof({ executable, script, label, resultVariable, profileVariable, timeoutMs = 120_000 }) {
  const directory = await mkdtemp(join(tmpdir(), "relayer-electron-proof-"));
  const resultFile = join(directory, "result.json");
  const profile = join(directory, "electron-profile");
  let retainProfile = false;
  try {
    await mkdir(profile);
    const exit = await new Promise((resolve, reject) => {
      let timedOut = false;
      let killSettlementTimeout;
      const child = spawn(executable, [script], {
        stdio: "inherit",
        env: { ...process.env, [resultVariable]: resultFile, [profileVariable]: profile },
      });
      const timeout = setTimeout(() => {
        timedOut = true;
        // Killing Electron main cannot certify that Chromium descendants have
        // stopped writing. Keep their profile available on every timeout.
        retainProfile = true;
        let killed;
        try { killed = child.kill("SIGKILL"); }
        catch (error) {
          reject(new Error(`${label} could not terminate its child; profile retained at ${directory}`, { cause: error }));
          return;
        }
        if (!killed) {
          reject(new Error(`${label} could not terminate its child; profile retained at ${directory}`));
          return;
        }
        killSettlementTimeout = setTimeout(() => {
          reject(new Error(`${label} child exit remains unconfirmed; profile retained at ${directory}`));
        }, 2_000);
        killSettlementTimeout.unref();
      }, timeoutMs);
      timeout.unref();
      child.once("error", (error) => {
        clearTimeout(timeout); clearTimeout(killSettlementTimeout);
        reject(retainProfile ? new Error(`${label} process failure; profile retained at ${directory}`, { cause: error }) : error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        clearTimeout(killSettlementTimeout);
        if (signal) retainProfile = true;
        if (timedOut) reject(new Error(`${label} exceeded ${timeoutMs}ms; profile retained at ${directory}`));
        else resolve({ code, signal });
      });
    });
    const result = JSON.parse(await readFile(resultFile, "utf8").catch(() => "null"));
    if (exit.code !== 0 || exit.signal || result?.passed !== true) {
      if (result?.error) process.stderr.write(`${result.error}\n`);
      throw new Error(`${label} failed: ${JSON.stringify({ exit, result })}${retainProfile ? `; profile retained at ${directory}` : ""}`);
    }
  } finally {
    if (!retainProfile) await rm(directory, { recursive: true, force: true });
  }
}
