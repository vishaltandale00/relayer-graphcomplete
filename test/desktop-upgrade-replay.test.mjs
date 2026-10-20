import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { assertPreserved, runOwned, sha256, verifyArchive, verifyMetadata } from "../scripts/upgrade-replay/contract.mjs";

describe("upgrade replay trust and failure boundaries", () => {
  it("rejects changed predecessor bytes and release identity before execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "upgrade-replay-contract-"));
    try {
      const archive = join(directory, "archive.zip");
      const bytes = Buffer.from("controlled archive bytes");
      const pin = { bytes: bytes.length, sha256: sha256(bytes), version: "0.2.40", sourceCommit: "a".repeat(40), target: "macos-arm64" };
      await writeFile(archive, bytes);
      await verifyArchive(archive, pin);
      const changed = Buffer.from(bytes);
      changed[0] ^= 1;
      await writeFile(archive, changed);
      await expect(verifyArchive(archive, pin)).rejects.toThrow("hash changed");
      await writeFile(archive, Buffer.from("truncated"));
      await expect(verifyArchive(archive, pin)).rejects.toThrow("size changed");
      const metadata = { version: pin.version, relayerReleaseSourceCommit: pin.sourceCommit, relayerReleaseTarget: pin.target };
      verifyMetadata(metadata, pin);
      for (const key of Object.keys(metadata)) expect(() => verifyMetadata({ ...metadata, [key]: "changed" }, pin)).toThrow();
    } finally { await rm(directory, { recursive: true }); }
  });

  it("fails preservation when the saved route, accepted graph, defaults or bytes drift", () => {
    const saved = { thread: { id: 1 }, output: { actionId: 4, targetLayerId: 7 }, fileHash: "abc", defaults: { familyId: 3 }, definitions: [{ id: "codex", connectionGeneration: 1 }] };
    assertPreserved(saved, structuredClone(saved));
    for (const field of Object.keys(saved)) expect(() => assertPreserved(saved, { ...saved, [field]: null })).toThrow("changed across upgrade");
  });

  it.skipIf(process.platform === "win32")("rejects a timed-out worker and removes its owned descendants", async () => {
    // This protects the reset/cleanup boundary, independent of native-service behavior.
    await expect(runOwned(process.execPath, ["-e", "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);setInterval(()=>{},1000)"], { timeoutMs: 250 })).rejects.toThrow(/exceeded|descendants/);
  });

  it("runs the heavy replay after packaging and gates changes to its runner and recipe", async () => {
    const workflow = parse(await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
    const steps = workflow.jobs.packaging.steps;
    const packaging = steps.findIndex(step => step.name === "Build and inspect the actual target ASAR");
    const replay = steps.findIndex(step => step.run?.includes("npm run test:desktop:upgrade-replay"));
    expect(replay).toBeGreaterThan(packaging);
    expect(steps[replay].run).toContain('--candidate-app "desktop/dist/mac-arm64/Relayer Dev.app"');
    expect(steps[replay].continueOnError ?? steps[replay]["continue-on-error"]).toBeUndefined();
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(packageJson.scripts["test:desktop:upgrade-replay"]).toBe("node scripts/test-desktop-upgrade-replay.mjs");
    for (const file of ["scripts/test-desktop-upgrade-replay.mjs", "scripts/upgrade-replay/worker.mjs", "scripts/upgrade-replay/baseline.v1.json"]) {
      const plan = JSON.parse(execFileSync(process.execPath, ["scripts/ci/plan-affected.mjs", "--changed-file", file], { encoding: "utf8" }));
      expect(plan.chapters.packaging).toBe(true);
    }
  });
});
