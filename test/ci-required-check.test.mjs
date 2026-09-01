import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, test } from "vitest";

import {
  evaluateRequiredInputs,
  evaluateRequiredJobs,
  evaluateRustJobs,
} from "../scripts/ci/assert-required-jobs.mjs";

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

test("the full portfolio is satisfied by its authoritative chapters without a duplicate full gate", () => {
  const fullPlan = {
    mode: "full",
    chapters: Object.fromEntries(
      Object.keys(affectedPlan.chapters).map((chapter) => [chapter, true]),
    ),
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
    }),
  ).toEqual({ ok: true, failures: [] });
});

test("a failed planner with no output still names the first actionable failure", () => {
  expect(
    evaluateRequiredInputs("", JSON.stringify({ plan: { result: "failure" } })),
  ).toEqual({
    ok: false,
    failures: ["plan: failure"],
  });
});

test("the Rust aggregate requires every selected fresh lane", () => {
  const plan = {
    chapters: { rust: true },
    rustCrash: true,
    runtimeRustPackages: ["relayer-graph-server"],
  };
  expect(
    evaluateRustJobs(plan, {
      "rust-clippy": "success",
      "rust-tests": "success",
      "rust-crash": "failure",
      "rust-runtime": "success",
    }),
  ).toEqual({ ok: false, failures: ["rust-crash: failure"] });
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

    const result = spawnSync(
      join(repositoryRoot, "scripts", "ci", "sccache-wrapper.sh"),
      [compiler, "--crate-name", "example"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          RELAYER_SCCACHE_ENABLED: "true",
          SCCACHE_PATH: sccache,
          TRACE: trace,
        },
      },
    );

    expect(result.status).toBe(86);
    expect(readFileSync(trace, "utf8").trim()).toBe(
      `cache:${compiler} --crate-name example`,
    );
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
        env: {
          ...process.env,
          SCCACHE_PATH: join(directory, "missing-sccache"),
          TRACE: trace,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(readFileSync(trace, "utf8").trim()).toBe(
      "direct:--crate-name example",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("CI workflow contract", () => {
  const workflow = parse(
    readFileSync(
      join(repositoryRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    ),
  );

  test("cancels superseded PR runs and warms integration branches", () => {
    expect(workflow.concurrency["cancel-in-progress"]).toBe(true);
    expect(workflow.on.push.branches).toContain("integration/**");
    expect(
      workflow.jobs.plan.steps.find((step) => step.id === "plan").run,
    ).toContain("select-mode.mjs");
  });

  test("keeps one stable always-running required check aggregator", () => {
    expect(workflow.jobs.check.name).toBe("check");
    expect(workflow.jobs.check.if).toBe("always()");
    expect(workflow.jobs.check.needs).toEqual(
      expect.arrayContaining([
        "plan",
        "quick",
        "rust",
        "typescript",
        "vitest",
        "python",
        "receipts",
        "prd",
        "packaging",
      ]),
    );
    expect(workflow.jobs.check.needs).not.toContain("full");
    expect(workflow.jobs.full).toBeUndefined();
  });

  test("restores compilation caches on PRs but saves them only on trusted branch pushes", () => {
    const allSteps = Object.values(workflow.jobs).flatMap(
      (job) => job.steps ?? [],
    );
    const setupAction = parse(
      readFileSync(
        join(
          repositoryRoot,
          ".github",
          "actions",
          "setup-node-dependencies",
          "action.yml",
        ),
        "utf8",
      ),
    );
    const rustSetupAction = parse(
      readFileSync(
        join(
          repositoryRoot,
          ".github",
          "actions",
          "setup-rust-compilation",
          "action.yml",
        ),
        "utf8",
      ),
    );
    const cacheSteps = [
      ...allSteps,
      ...setupAction.runs.steps,
      ...rustSetupAction.runs.steps,
    ];
    const restores = cacheSteps.filter((step) =>
      step.uses?.startsWith("actions/cache/restore@"),
    );
    const saves = cacheSteps.filter((step) =>
      step.uses?.startsWith("actions/cache/save@"),
    );

    expect(restores.length).toBeGreaterThan(0);
    expect(saves.length).toBeGreaterThan(0);
    for (const restore of restores) expect(restore.if).toBeUndefined();
    for (const save of saves) {
      expect(save.if).toContain("github.event_name == 'push'");
    }
    const rustDependencyRestore = restores.find(
      (step) => step.name === "Restore Rust dependency downloads",
    );
    expect(rustDependencyRestore["continue-on-error"]).toBe(true);
    for (const save of saves.filter((step) =>
      step.name.startsWith("Save trusted Rust dependency downloads"),
    )) {
      expect(save["continue-on-error"]).toBe(true);
    }
    const dependencySave = saves.find(
      (step) => step.name === "Save trusted Rust dependency downloads",
    );
    expect(dependencySave.with.path).not.toContain("target");
    const targetSaves = saves.filter(
      (step) => step !== dependencySave && step.name.includes("packaging"),
    );
    for (const save of targetSaves) expect(save.with.path).toContain("target");
  });

  test("runs Rust authorities in isolated parallel lanes with one shared compiler-object namespace", () => {
    const lanes = ["rust-clippy", "rust-tests", "rust-crash", "rust-runtime"];
    for (const lane of lanes) {
      const job = workflow.jobs[lane];
      const setup = job.steps.find((step) => step.id === "rust-setup");
      const run = job.steps.find((step) => step.name.startsWith("Run "));
      expect(setup.uses).toBe("./.github/actions/setup-rust-compilation");
      expect(setup.with.lane).toBe(lane);
      expect(run.env.CARGO_TARGET_DIR).toBe(
        `\${{ runner.temp }}/cargo-target-${lane}`,
      );
      expect(run.env.CARGO_INCREMENTAL).toBe("0");
      expect(run.env.CARGO_PROFILE_DEV_DEBUG).toBe("line-tables-only");
      expect(run.env.CARGO_PROFILE_TEST_DEBUG).toBe("line-tables-only");
      expect(run.env.RUSTC_WRAPPER).toBe(
        "${{ github.workspace }}/scripts/ci/sccache-wrapper.sh",
      );
      expect(run.env.SCCACHE_GHA_VERSION).toBe(
        "${{ steps.rust-setup.outputs.cache-version }}",
      );
    }
    for (const cargoLane of ["rust-clippy", "rust-tests", "rust-runtime"]) {
      const run = workflow.jobs[cargoLane].steps.find((step) =>
        step.name.startsWith("Run "),
      );
      expect(run.env.RELAYER_CARGO_TIMINGS_DIR).toBe(
        `\${{ runner.temp }}/cargo-timings-${cargoLane}`,
      );
    }
    expect(
      workflow.jobs["rust-crash"].steps.find((step) => step.name.startsWith("Run ")).env
        .RELAYER_CARGO_TIMINGS_DIR,
    ).toBeUndefined();
    expect(workflow.jobs.rust.needs).toEqual(
      expect.arrayContaining([
        "plan",
        "rust-clippy",
        "rust-tests",
        "rust-crash",
        "rust-runtime",
      ]),
    );

    const rustSetup = parse(
      readFileSync(
        join(
          repositoryRoot,
          ".github",
          "actions",
          "setup-rust-compilation",
          "action.yml",
        ),
        "utf8",
      ),
    );
    const sccache = rustSetup.runs.steps.find(
      (step) => step.id === "sccache-setup",
    );
    expect(sccache.uses).toMatch(
      /^mozilla-actions\/sccache-action@[0-9a-f]{40}$/,
    );
    expect(sccache["continue-on-error"]).toBe(true);
    expect(sccache.if).toBe(
      "${{ github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository }}",
    );
    expect(rustSetup.outputs["cache-version"].value).toContain(
      "steps.identity.outputs.cache-version",
    );
    expect(
      rustSetup.runs.steps.find((step) => step.id === "identity").run,
    ).toContain("relayer-rust-parallel-line-tables-v1-");

    const rustReport = parse(
      readFileSync(
        join(
          repositoryRoot,
          ".github",
          "actions",
          "report-rust-compilation",
          "action.yml",
        ),
        "utf8",
      ),
    );
    const report = rustReport.runs.steps.find(
      (step) => step.name === "Record compiler cache statistics",
    );
    const upload = rustReport.runs.steps.find(
      (step) => step.name === "Upload compiler cache statistics",
    );
    expect(report.run).toContain('| tee "$stats_text"');
    expect(report.run).toContain("text_status=${PIPESTATUS[0]}");
    expect(report.run).toContain("--show-stats --stats-format json");
    expect(upload.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
    expect(upload.if).toBe("${{ always() }}");
    expect(upload["continue-on-error"]).toBe(true);
    expect(upload.with["if-no-files-found"]).toBe("ignore");
    expect(upload.with["retention-days"]).toBe(14);
    const timingsUpload = rustReport.runs.steps.find(
      (step) => step.name === "Upload Cargo timing report",
    );
    expect(timingsUpload.uses).toBe(upload.uses);
    expect(timingsUpload.if).toBe("${{ always() }}");
    expect(timingsUpload["continue-on-error"]).toBe(true);
    expect(timingsUpload.with["if-no-files-found"]).toBe("ignore");
    expect(timingsUpload.with["retention-days"]).toBe(14);
    expect(timingsUpload.with.path).toBe(
      "${{ runner.temp }}/cargo-timings-${{ inputs.lane }}",
    );
  });

  test("verifies the exact Rust runtime artifact before executing the fresh Vitest portfolio", () => {
    const steps = workflow.jobs.vitest.steps;
    const downloadIndex = steps.findIndex(
      (step) => step.name === "Download selected Rust runtime",
    );
    const verifyIndex = steps.findIndex(
      (step) => step.name === "Verify and install selected Rust runtime",
    );
    const prerequisiteIndex = steps.findIndex(
      (step) => step.name === "Build non-Rust Vitest prerequisites",
    );
    const testIndex = steps.findIndex(
      (step) => step.name === "Run fresh Vitest and secret-boundary tests",
    );
    const download = steps[downloadIndex];
    const verify = steps[verifyIndex];
    const upload = workflow.jobs["rust-runtime"].steps.find(
      (step) => step.name === "Upload selected Rust runtime",
    );

    expect(workflow.jobs.vitest.needs).toContain("rust-runtime");
    expect(downloadIndex).toBeGreaterThan(-1);
    expect(verifyIndex).toBeGreaterThan(downloadIndex);
    expect(prerequisiteIndex).toBeGreaterThan(-1);
    expect(testIndex).toBeGreaterThan(prerequisiteIndex);
    expect(download.uses).toMatch(/^actions\/download-artifact@[0-9a-f]{40}$/);
    expect(upload.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
    expect(download.with.name).toBe(upload.with.name);
    for (const identity of [
      "--source-commit",
      "--platform",
      "--rustc-release",
      "--cargo-profile",
    ]) {
      expect(verify.run).toContain(identity);
    }
    expect(
      steps.some(
        (step) =>
          step.uses?.startsWith("actions/cache/") &&
          step.with?.path?.includes("target"),
      ),
    ).toBe(false);
    expect(
      readFileSync(
        join(repositoryRoot, "scripts", "ci", "run-chapter.mjs"),
        "utf8",
      ),
    ).not.toContain('run("Build selected Vitest Rust runtime"');
  });

  test("preserves PR parent history for complete Vitest evidence checks", () => {
    for (const jobName of ["vitest"]) {
      const checkout = workflow.jobs[jobName].steps.find((step) =>
        step.uses?.startsWith("actions/checkout@"),
      );
      expect(checkout.with["fetch-depth"]).toBe(0);
    }
  });
});
