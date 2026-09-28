import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parse } from "yaml";

test.skipIf(process.platform === "win32")("inventory reporter preserves mapping boundaries and independent unknown sections", () => {
  const result = spawnSync("python3", ["-B", "scripts/ci/compiled-inventory/test_report.py"], { encoding: "utf8" });
  expect(result.status, result.stdout + result.stderr).toBe(0);
});

test("hosted inventory qualifies native inputs before compiling and cannot transport cached outputs", () => {
  const workflow = parse(readFileSync(".github/workflows/compiled-inventory.yml", "utf8"));
  expect(workflow.on.push.branches).toEqual(["codex/compiled-inventory-probe"]);
  expect(workflow.on.pull_request).toBeUndefined();
  const steps = workflow.jobs.inventory.steps;
  const identity = steps.find((step) => step.id === "identity");
  expect(identity["continue-on-error"]).toBeUndefined();
  const compile = steps.find((step) => step.name === "Capture full default compilation inventory");
  expect(compile.run).toContain("cargo test --workspace --no-run --message-format=json");
  expect(compile["continue-on-error"]).toBeUndefined();
  expect(steps.some((step) => /actions\/cache/.test(step.uses ?? ""))).toBe(false);
  expect(workflow.env.CARGO_TARGET_DIR).toBe("/home/runner/work/_temp/cargo-target");
  expect(readFileSync(".github/workflows/ci.yml", "utf8")).not.toContain("compiled-inventory");
});
