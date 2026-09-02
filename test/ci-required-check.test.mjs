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
      // Every lane runs on its own fresh runner, so the lanes share one
      // target-directory path without any filesystem overlap. The identical
      // path keeps sccache keys stable across lanes, which matters for the
      // Ladybug CMake build whose generated-header paths would otherwise
      // fragment the C/C++ cache per lane.
      expect(run.env.CARGO_TARGET_DIR).toBe(
        "\${{ runner.temp }}/cargo-target",
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
    for (const writerLane of ["rust-clippy", "rust-tests", "rust-crash"]) {
      const run = workflow.jobs[writerLane].steps.find((step) =>
        step.name.startsWith("Run "),
      );
      expect(run.env.SCCACHE_GHA_RW_MODE).toBe("READ_WRITE");
      expect(workflow.jobs[writerLane].steps.find((step) => step.id === "rust-setup").with["sccache-mode"]).toBeUndefined();
    }
    // The runtime lane only builds uncachable binary links on top of units
    // seeded by the default-test lane, so it reads without writing while the
    // writer lanes run. On runtime-only plans no writer lane exists, so it
    // writes to keep the namespace from going cold.
    const conditionalRuntimeMode =
      "${{ needs.plan.outputs.rust == 'true' && 'READ_ONLY' || 'READ_WRITE' }}";
    const runtimeRun = workflow.jobs["rust-runtime"].steps.find((step) =>
      step.name.startsWith("Run "),
    );
    expect(runtimeRun.env.SCCACHE_GHA_RW_MODE).toBe(conditionalRuntimeMode);
    expect(
      workflow.jobs["rust-runtime"].steps.find((step) => step.id === "rust-setup")
        .with["sccache-mode"],
    ).toBe(conditionalRuntimeMode);
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
    // The writer lanes rely on the composite action defaulting to read-write;
    // a silent default change would stop seeding without tripping the
    // per-lane env pins above.
    expect(rustSetup.inputs["sccache-mode"].default).toBe("READ_WRITE");
    expect(
      rustSetup.runs.steps.find((step) => step.id === "sccache-start").env
        .SCCACHE_GHA_RW_MODE,
    ).toBe("${{ inputs.sccache-mode }}");
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
    // Artifacts are immutable per workflow run; overwrite lets "re-run all
    // jobs" replace the first attempt's bytes while a stable name keeps
    // partial re-runs able to download the original upload.
    expect(upload.with.overwrite).toBe(true);
    for (const identity of [
      "--source-commit",
      "--platform",
      "--rustc-release",
      "--cargo-profile",
    ]) {
      expect(verify.run).toContain(identity);
    }
    // The seal step must read the binaries from the same target directory
    // the lanes build into; a drift here fails late (ENOENT) without this pin.
    const seal = workflow.jobs["rust-runtime"].steps.find(
      (step) => step.name === "Seal selected Rust runtime",
    );
    expect(seal.run).toContain('--target-dir "$RUNNER_TEMP/cargo-target/debug"');
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

  test("builds the Ladybug library once and verifies it before every Rust lane links it", () => {
    const job = workflow.jobs["lbug-prebuilt"];
    expect(job.if).toBe(
      "${{ needs.quick.result == 'success' && (needs.plan.outputs.rust == 'true' || needs.plan.outputs.rust_runtime == 'true' || needs.plan.outputs.rust_crash == 'true') }}",
    );
    expect(
      job.steps.find((step) => step.id === "rust-setup").uses,
    ).toBe("./.github/actions/setup-rust-compilation");
    const restore = job.steps.find((step) => step.id === "lbug-cache");
    expect(restore.uses).toMatch(/^actions\/cache\/restore@/);
    expect(restore.if).toBeUndefined();
    const build = job.steps.find(
      (step) => step.name === "Build Ladybug from the pinned bundled source",
    );
    expect(build.if).toBe("${{ steps.lbug-cache.outputs.cache-hit != 'true' }}");
    expect(build.run).toContain("cargo build -p lbug");
    expect(build.run).toContain("scripts/ci/lbug-artifact.mjs create");
    const upload = job.steps.find(
      (step) => step.name === "Upload prebuilt Ladybug library",
    );
    expect(upload.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
    expect(upload.with.overwrite).toBe(true);
    const save = job.steps.find(
      (step) => step.name === "Save trusted prebuilt Ladybug bundle",
    );
    expect(save.if).toContain("github.event_name == 'push'");
    expect(save.with.key).toBe("${{ steps.lbug-cache.outputs.cache-primary-key }}");
    // The job that does the steady-state C++ compiling stays visible to the
    // cache-evidence chain like every other compiling lane.
    const report = job.steps.find(
      (step) => step.name === "Report Ladybug build compiler cache",
    );
    expect(report.if).toBe("${{ always() }}");
    expect(report["continue-on-error"]).toBe(true);
    expect(report.with.lane).toBe("lbug-prebuilt");
    expect(build.run).toContain("--timings");
    expect(build.env.RELAYER_CARGO_TIMINGS_DIR).toBe(
      "${{ runner.temp }}/cargo-timings-lbug-prebuilt",
    );

    for (const lane of [
      "rust-clippy",
      "rust-tests",
      "rust-crash",
      "rust-runtime",
    ]) {
      const laneJob = workflow.jobs[lane];
      expect(laneJob.needs).toContain("lbug-prebuilt");
      // A failed acceleration job must never skip the lanes into a red
      // aggregate: the gates re-derive from plan/quick results only, and the
      // lanes' download/verify steps fail open to the source build.
      expect(laneJob.if).toBe(
        lane === "rust-crash"
          ? "${{ always() && needs.plan.result == 'success' && needs.quick.result == 'success' && needs.plan.outputs.rust_crash == 'true' }}"
          : lane === "rust-runtime"
            ? "${{ always() && needs.plan.result == 'success' && needs.quick.result == 'success' && needs.plan.outputs.rust_runtime == 'true' }}"
            : "${{ always() && needs.plan.result == 'success' && needs.quick.result == 'success' && needs.plan.outputs.rust == 'true' }}",
      );
      const download = laneJob.steps.find(
        (step) => step.name === "Download prebuilt Ladybug library",
      );
      const verify = laneJob.steps.find(
        (step) => step.name === "Verify and install prebuilt Ladybug library",
      );
      // Fail-open: a missing or rejected bundle falls back to the source build.
      expect(download["continue-on-error"]).toBe(true);
      expect(verify["continue-on-error"]).toBe(true);
      expect(download.with.name).toBe(upload.with.name);
      expect(verify.run).toContain("scripts/ci/lbug-artifact.mjs verify");
      expect(verify.run).toContain('--github-env "$GITHUB_ENV"');
    }
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
