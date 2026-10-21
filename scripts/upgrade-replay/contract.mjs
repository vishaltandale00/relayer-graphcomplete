import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const digest = (value) => sha256(JSON.stringify(value));

export async function verifyArchive(path, baseline) {
  const bytes = await readFile(path);
  assert.equal(bytes.length, baseline.bytes, "Predecessor archive size changed");
  assert.equal(sha256(bytes), baseline.sha256, "Predecessor archive hash changed");
}

export function verifyMetadata(metadata, baseline) {
  assert.equal(metadata.version, baseline.version, "Predecessor version changed");
  assert.equal(metadata.relayerReleaseSourceCommit, baseline.sourceCommit, "Predecessor source changed");
  assert.equal(metadata.relayerReleaseTarget, baseline.target, "Predecessor target changed");
}

export function assertPreserved(expected, observed) {
  assert.deepEqual(observed, expected, "Saved conversation, graph, defaults or artifact changed across upgrade");
}

// All service descendants inherit this private process group. Timeout/failure must
// terminate the whole group before the parent removes its disposable stores.
export async function runOwned(command, args, { cwd, timeoutMs = 90_000 } = {}) {
  const child = spawn(command, args, { cwd, detached: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  let timedOut = false;
  child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-12_000); });
  const kill = (signal) => {
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const timer = setTimeout(() => { timedOut = true; kill("SIGTERM"); }, timeoutMs);
  const killTimer = setTimeout(() => kill("SIGKILL"), timeoutMs + 2_000);
  try {
    const { code, signal } = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    // A nominally successful worker must have closed its descendants too.
    let remaining = false;
    try { process.kill(-child.pid, 0); remaining = true; } catch (error) { if (error.code !== "ESRCH") throw error; }
    if (remaining) kill("SIGKILL");
    await until("owned process group exits", () => {
      try { process.kill(-child.pid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; }
    }, 5_000);
    assert.equal(remaining, false, "Worker left owned descendants running");
    assert.equal(timedOut, false, `Upgrade subprocess exceeded ${timeoutMs}ms`);
    assert.equal(code, 0, `${command} failed (${signal ?? code}): ${stderr}`);
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
  }
}

export async function until(label, check, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Upgrade replay timed out: ${label}`);
}
