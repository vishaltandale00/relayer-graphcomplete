import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, test } from "vitest";

import { evaluateRequiredInputs, evaluateRequiredJobs } from "../scripts/ci/assert-required-jobs.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const affectedPlan = {
  mode: "affected",
  chapters: {
    rust: true,
    typescript: false,
    vitest: true,
    python: false,
    receipts: false,
    prd: false,
    packaging: false,
  },
};

test("the required check rejects failed and unexpectedly skipped selected chapters", () => {
  expect(
    evaluateRequiredJobs(affectedPlan, {
      plan: "success",
      quick: "success",
      rust: "failure",
      vitest: "skipped",
    }),
  ).toEqual({
    ok: false,
    failures: ["rust: failure", "vitest: skipped"],
  });
});

test("the required check allows unselected chapters to be skipped", () => {
  expect(
    evaluateRequiredJobs(affectedPlan, {
      plan: "success",
      quick: "success",
      rust: "success",
      typescript: "skipped",
      vitest: "success",
      python: "skipped",
      receipts: "skipped",
      prd: "skipped",
      packaging: "skipped",
      full: "skipped",
    }),
  ).toEqual({ ok: true, failures: [] });
});

test("the full portfolio requires the repository full gate", () => {
  const fullPlan = {
    mode: "full",
    chapters: Object.fromEntries(Object.keys(affectedPlan.chapters).map((chapter) => [chapter, true])),
  };

  expect(
    evaluateRequiredJobs(fullPlan, {
      plan: "success",
      quick: "success",
      rust: "success",
      typescript: "success",
      vitest: "success",
      python: "success",
      receipts: "success",
      prd: "success",
      packaging: "success",
      full: "skipped",
    }).failures,
  ).toContain("full: skipped");
});

test("a failed planner with no output still names the first actionable failure", () => {
  expect(evaluateRequiredInputs("", JSON.stringify({ plan: { result: "failure" } }))).toEqual({
    ok: false,
    failures: ["plan: failure"],
  });
});

describe("CI workflow contract", () => {
  const workflow = parse(readFileSync(join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8"));

  test("cancels superseded PR runs and warms integration branches", () => {
    expect(workflow.concurrency["cancel-in-progress"]).toBe(true);
    expect(workflow.on.push.branches).toContain("integration/**");
    expect(workflow.jobs.plan.steps.find((step) => step.id === "plan").run).toContain("select-mode.mjs");
  });

  test("keeps one stable always-running required check aggregator", () => {
    expect(workflow.jobs.check.name).toBe("check");
    expect(workflow.jobs.check.if).toBe("always()");
    expect(workflow.jobs.check.needs).toEqual(
      expect.arrayContaining(["plan", "quick", "rust", "typescript", "vitest", "python", "receipts", "prd", "packaging", "full"]),
    );
  });

  test("restores compilation caches on PRs but saves them only on trusted branch pushes", () => {
    const allSteps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
    const setupAction = parse(
      readFileSync(join(repositoryRoot, ".github", "actions", "setup-node-dependencies", "action.yml"), "utf8"),
    );
    const cacheSteps = [...allSteps, ...setupAction.runs.steps];
    const restores = cacheSteps.filter((step) => step.uses?.startsWith("actions/cache/restore@"));
    const saves = cacheSteps.filter((step) => step.uses?.startsWith("actions/cache/save@"));

    expect(restores.length).toBeGreaterThan(0);
    expect(saves.length).toBeGreaterThan(0);
    for (const restore of restores) expect(restore.if).toBeUndefined();
    for (const save of saves) {
      expect(save.if).toContain("github.event_name == 'push'");
    }
    const rustSaves = saves.filter((step) => step.name.includes("Rust") || step.name.includes("packaging"));
    for (const save of rustSaves) expect(save.with.path).toContain("target");
  });

  test("builds runtime prerequisites before executing the fresh Vitest portfolio", () => {
    const steps = workflow.jobs.vitest.steps;
    const prerequisiteIndex = steps.findIndex((step) => step.name === "Build Vitest runtime prerequisites");
    const testIndex = steps.findIndex((step) => step.name === "Run fresh Vitest and secret-boundary tests");

    expect(prerequisiteIndex).toBeGreaterThan(-1);
    expect(testIndex).toBeGreaterThan(prerequisiteIndex);
  });

  test("preserves PR parent history for complete Vitest evidence checks", () => {
    for (const jobName of ["vitest", "full"]) {
      const checkout = workflow.jobs[jobName].steps.find((step) => step.uses?.startsWith("actions/checkout@"));
      expect(checkout.with["fetch-depth"]).toBe(0);
    }
  });
});
