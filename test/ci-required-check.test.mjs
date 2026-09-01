import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

test("the sccache wrapper does not retry or mask a wrapped compiler failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "relayer-sccache-wrapper-"));
  try {
    const trace = join(directory, "trace.txt");
    const compiler = join(directory, "rustc");
    const sccache = join(directory, "sccache");
    writeFileSync(compiler, '#!/bin/sh\necho "direct:$*" >> "$TRACE"\n');
    writeFileSync(sccache, '#!/bin/sh\necho "cache:$*" >> "$TRACE"\nexit 86\n');
    chmodSync(compiler, 0o755);
    chmodSync(sccache, 0o755);

    const result = spawnSync(join(repositoryRoot, "scripts", "ci", "sccache-wrapper.sh"), [
      compiler,
      "--crate-name",
      "example",
    ], {
      encoding: "utf8",
      env: { ...process.env, RELAYER_SCCACHE_ENABLED: "true", SCCACHE_PATH: sccache, TRACE: trace },
    });

    expect(result.status).toBe(86);
    expect(readFileSync(trace, "utf8").trim()).toBe(`cache:${compiler} --crate-name example`);
    expect(result.stderr).not.toContain("retrying directly with rustc");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the sccache wrapper invokes the compiler directly when setup is unavailable", () => {
  const directory = mkdtempSync(join(tmpdir(), "relayer-sccache-fallback-"));
  try {
    const trace = join(directory, "trace.txt");
    const compiler = join(directory, "rustc");
    writeFileSync(compiler, '#!/bin/sh\necho "direct:$*" >> "$TRACE"\n');
    chmodSync(compiler, 0o755);

    const result = spawnSync(
      join(repositoryRoot, "scripts", "ci", "sccache-wrapper.sh"),
      [compiler, "--crate-name", "example"],
      {
        encoding: "utf8",
        env: { ...process.env, SCCACHE_PATH: join(directory, "missing-sccache"), TRACE: trace },
      },
    );

    expect(result.status).toBe(0);
    expect(readFileSync(trace, "utf8").trim()).toBe("direct:--crate-name example");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
    const dependencySave = saves.find((step) => step.name === "Save trusted Rust dependency downloads");
    expect(dependencySave.with.path).not.toContain("target");
    const targetSaves = saves.filter(
      (step) => step !== dependencySave && (step.name.includes("Rust") || step.name.includes("packaging")),
    );
    for (const save of targetSaves) expect(save.with.path).toContain("target");
  });

  test("canaries automatic pull-request sccache only in the Rust chapter", () => {
    const rustSteps = workflow.jobs.rust.steps;
    const sccacheStepsByJob = Object.fromEntries(
      Object.entries(workflow.jobs).map(([jobName, job]) => [
        jobName,
        (job.steps ?? []).filter((step) => step.uses?.includes("sccache-action")),
      ]),
    );
    const setup = rustSteps.find((step) => step.id === "sccache-setup");
    const start = rustSteps.find((step) => step.id === "sccache-start");
    const rustRun = rustSteps.find((step) => step.name === "Selected Rust compilation, checks, and tests");
    const report = rustSteps.find((step) => step.name === "Report sccache compiler statistics");
    const dependencyCache = rustSteps.find((step) => step.id === "rust-dependency-cache");

    expect(setup.uses).toMatch(/^mozilla-actions\/sccache-action@[0-9a-f]{40}$/);
    expect(setup.with.version).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(setup.if).toBe(
      "${{ github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository }}",
    );
    expect(setup["continue-on-error"]).toBe(true);
    expect(setup.with.disable_annotations).toBe(true);
    expect(start.if).toBe("${{ steps.sccache-setup.outcome == 'success' }}");
    expect(start["continue-on-error"]).toBe(true);
    expect(rustRun.env.CARGO_INCREMENTAL).toBe("0");
    expect(rustRun.env.RELAYER_SCCACHE_ENABLED).toBe("${{ steps.sccache-start.outputs.enabled }}");
    expect(rustRun.env.RUSTC_WRAPPER).toBe("${{ github.workspace }}/scripts/ci/sccache-wrapper.sh");
    expect(rustRun.env.SCCACHE_GHA_RW_MODE).toBe("READ_WRITE");
    expect(rustRun.env.SCCACHE_IGNORE_SERVER_IO_ERROR).toBe("1");
    expect(report.if).toContain("always()");
    expect(report["continue-on-error"]).toBe(true);
    expect(report.run).toContain('[ "$SCCACHE_START_OUTCOME" = "success" ]');
    expect(report.run).not.toContain("every selected test ran");
    expect(report.run).toContain("never substitutes for fresh test execution");
    const rustArchivePaths = rustSteps
      .filter((step) => step.uses?.startsWith("actions/cache/"))
      .map((step) => step.with.path);
    expect(rustArchivePaths.length).toBeGreaterThan(0);
    for (const path of rustArchivePaths) expect(path.split("\n")).not.toContain("target");
    expect(dependencyCache.with.path).not.toContain("target");
    expect(Object.entries(sccacheStepsByJob).filter(([, steps]) => steps.length > 0).map(([name]) => name)).toEqual([
      "rust",
    ]);
  });

  test("builds runtime prerequisites before executing the fresh Vitest portfolio", () => {
    const steps = workflow.jobs.vitest.steps;
    const prerequisiteIndex = steps.findIndex((step) => step.name === "Build Vitest runtime prerequisites");
    const testIndex = steps.findIndex((step) => step.name === "Run fresh Vitest and secret-boundary tests");
    const cacheRestore = steps.find((step) => step.id === "rust-cache");
    const cacheSave = steps.find((step) => step.name === "Save trusted Vitest runtime compilation acceleration");

    expect(prerequisiteIndex).toBeGreaterThan(-1);
    expect(testIndex).toBeGreaterThan(prerequisiteIndex);
    expect(cacheSave.with.key).toBe("${{ steps.rust-cache.outputs.cache-primary-key }}");
    expect(cacheSave.with.path).toBe(cacheRestore.with.path);
    expect(cacheSave.if).toContain("github.event_name == 'push'");
    expect(readFileSync(join(repositoryRoot, "scripts", "ci", "run-chapter.mjs"), "utf8")).toContain(
      "plan.vitestRustPackages",
    );
  });

  test("preserves PR parent history for complete Vitest evidence checks", () => {
    for (const jobName of ["vitest", "full"]) {
      const checkout = workflow.jobs[jobName].steps.find((step) => step.uses?.startsWith("actions/checkout@"));
      expect(checkout.with["fetch-depth"]).toBe(0);
    }
  });
});
