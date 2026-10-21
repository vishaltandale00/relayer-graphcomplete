import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { parse } from "yaml";

test.skipIf(process.platform === "win32")("compiled-output pilot rejects wrong inputs and unsafe inventory before install", () => {
  const result = spawnSync(process.platform === "win32" ? "python" : "python3", ["-B", "scripts/ci/compiled-test-pilot/test_bundle.py"], { encoding: "utf8" });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
});

test.skipIf(process.platform === "win32")("pilot runner preserves inner compile and test failures in receipts and process status", () => {
  const directory = mkdtempSync(join(tmpdir(), "compiled-test-pilot-"));
  try {
    writeFileSync(join(directory, "cargo"), '#!/bin/sh\nif [ "$1" = metadata ]; then\n  echo \'{"packages":[{"id":"p","name":"p"}],"workspace_members":["p"]}\'\nelse\n  exit 23\nfi\n');
    writeFileSync(join(directory, "node"), "#!/bin/sh\nexit 19\n");
    for (const name of ["cargo", "node"]) chmodSync(join(directory, name), 0o755);
    for (const [phase, status] of [["compile", 23], ["test", 19]]) {
      const result = spawnSync(process.execPath, [resolve("scripts/ci/compiled-test-pilot/run.mjs"), phase], {
        env: { ...process.env, PATH: directory, PILOT_EVIDENCE: directory }, encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(status);
      expect(JSON.parse(readFileSync(join(directory, `${phase}.json`), "utf8")).status).toBe(status);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pilot is separate from required CI and executes the production default chapter after restore", () => {
  const workflow = parse(readFileSync(".github/workflows/compiled-test-cache-pilot.yml", "utf8"));
  expect(workflow.on.push.branches).toEqual(["codex/compiled-test-cache-pilot"]);
  expect(workflow.on.pull_request).toBeUndefined();
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.defaults.run.shell).toBe("bash");
  for (const name of ["producer", "consumer"]) {
    const steps = workflow.jobs[name].steps;
    const testStep = steps.find((s) => s.name === "Run every default-feature Rust test freshly");
    expect(testStep.if).toBeUndefined();
    expect(testStep.run).toContain("node scripts/ci/compiled-test-pilot/run.mjs test");
    expect(testStep["continue-on-error"]).toBeUndefined();
  }
  const script = readFileSync("scripts/ci/compiled-test-pilot/run.mjs", "utf8");
  expect(script).toContain('["scripts/ci/run-chapter.mjs", "rust-tests"]');
  expect(script).toContain("resolved.workspace_members.includes(p.id)");
  const required = readFileSync(".github/workflows/ci.yml", "utf8");
  expect(required).not.toContain("compiled-test-pilot");
});
