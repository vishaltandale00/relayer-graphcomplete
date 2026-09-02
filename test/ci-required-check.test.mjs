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

const fullPlan = {
  mode: "full",
  chapters: Object.fromEntries(
    Object.keys(affectedPlan.chapters).map((chapter) => [chapter, true]),
  ),
};

test("the required check evaluates selected chapters, full portfolios, missing inputs, and Rust lanes", () => {
  const cases = [
    [
      "failed and unexpectedly skipped selected chapters are rejected",
      () =>
        evaluateRequiredJobs(affectedPlan, {
          plan: "success",
          quick: "success",
          rust: "failure",
          vitest: "skipped",
        }),
      { ok: false, failures: ["rust: failure", "vitest: skipped"] },
    ],
    [
      "unselected chapters are allowed to be skipped",
      () =>
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
      { ok: true, failures: [] },
    ],
    [
      "the full portfolio is satisfied by its authoritative chapters without a duplicate full gate",
      () =>
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
      { ok: true, failures: [] },
    ],
    [
      "a failed planner with no output still names the first actionable failure",
      () =>
        evaluateRequiredInputs(
          "",
          JSON.stringify({ plan: { result: "failure" } }),
        ),
      { ok: false, failures: ["plan: failure"] },
    ],
    [
      "the Rust aggregate requires every selected fresh lane",
      () =>
        evaluateRustJobs(
          {
            chapters: { rust: true },
            rustCrash: true,
            runtimeRustPackages: ["relayer-graph-server"],
          },
          {
            "rust-clippy": "success",
            "rust-tests": "success",
            "rust-crash": "failure",
            "rust-runtime": "success",
          },
        ),
      { ok: false, failures: ["rust-crash: failure"] },
    ],
  ];
  expect(cases).toHaveLength(5);
  for (const [label, evaluate, expected] of cases) {
    expect.soft(evaluate(), label).toEqual(expected);
  }
});

test("the sccache wrapper propagates cache failures and falls back to direct compilation", () => {
  const directory = mkdtempSync(join(tmpdir(), "relayer-sccache-wrapper-"));
  try {
    const trace = join(directory, "trace.txt");
    const compiler = join(directory, "rustc");
    const sccache = join(directory, "sccache");
    writeFileSync(compiler, '#!/bin/sh\necho "direct:$*" >> "$TRACE"\n');
    writeFileSync(sccache, '#!/bin/sh\necho "cache:$*" >> "$TRACE"\nexit 86\n');
    chmodSync(compiler, 0o755);
    chmodSync(sccache, 0o755);

    // Phase 1: an enabled cache that fails must surface the exact failure
    // without any silent direct retry.
    const cached = spawnSync(
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
    expect(cached.status, "a wrapped compiler failure exits with the cache's status").toBe(86);
    expect(readFileSync(trace, "utf8").trim(), "the invocation went through the cache exactly once").toBe(
      `cache:${compiler} --crate-name example`,
    );
    expect(cached.stderr, "the wrapper never masks the failure with a direct retry").not.toContain("retrying directly with rustc");

    // Phase 2: when the cache binary is unavailable, the compiler runs
    // directly with no argument loss.
    writeFileSync(trace, "");
    const direct = spawnSync(
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
    expect(direct.status, "the direct fallback compiles successfully").toBe(0);
    expect(readFileSync(trace, "utf8").trim(), "the direct fallback drops the wrapper's compiler argument").toBe(
      "direct:--crate-name example",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("CI workflow contract", () => {
  test("pins run routing, the required-check aggregator, cache policy, Rust lanes, runtime artifacts, and the Ladybug chain", () => {
    const workflow = parse(
      readFileSync(
        join(repositoryRoot, ".github", "workflows", "ci.yml"),
        "utf8",
      ),
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

    // 1. Run routing: superseded PR runs cancel; integration branches warm.
    expect(workflow.concurrency["cancel-in-progress"], "superseded runs are cancelled").toBe(true);
    expect(workflow.on.push.branches, "integration branches are warmed on push").toContain("integration/**");
    expect(
      workflow.jobs.plan.steps.find((step) => step.id === "plan").run,
      "the plan job selects the CI mode from the event",
    ).toContain("select-mode.mjs");

    // 2. One stable always-running required check aggregator.
    expect(workflow.jobs.check.name, "the aggregator job keeps its stable name").toBe("check");
    expect(workflow.jobs.check.if, "the aggregator always runs").toBe("always()");
    expect(workflow.jobs.check.needs, "the aggregator needs every chapter gate").toEqual(
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
    expect(workflow.jobs.check.needs, "the aggregator never needs a duplicate full gate").not.toContain("full");
    expect(workflow.jobs.full, "no full gate job exists").toBeUndefined();

    // 3. Cache policy: restores everywhere, saves only on trusted pushes.
    const allSteps = Object.values(workflow.jobs).flatMap(
      (job) => job.steps ?? [],
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
    expect(restores.length, "the workflow restores compilation caches").toBeGreaterThan(0);
    expect(saves.length, "the workflow saves compilation caches").toBeGreaterThan(0);
    for (const restore of restores) {
      expect(restore.if, `restore step ${restore.name ?? restore.uses} runs on every event`).toBeUndefined();
    }
    for (const save of saves) {
      expect(save.if, `save step ${save.name ?? save.uses} only runs on trusted pushes`).toContain("github.event_name == 'push'");
    }
    const rustDependencyRestore = restores.find(
      (step) => step.name === "Restore Rust dependency downloads",
    );
    expect(rustDependencyRestore["continue-on-error"], "a failed dependency restore never fails PRs").toBe(true);
    for (const save of saves.filter((step) =>
      step.name.startsWith("Save trusted Rust dependency downloads"),
    )) {
      expect(save["continue-on-error"], "a failed dependency save never fails trusted pushes").toBe(true);
    }
    const dependencySave = saves.find(
      (step) => step.name === "Save trusted Rust dependency downloads",
    );
    expect(dependencySave.with.path, "dependency downloads never cache the target directory").not.toContain("target");
    const targetSaves = saves.filter(
      (step) => step !== dependencySave && step.name.includes("packaging"),
    );
    for (const save of targetSaves) {
      expect(save.with.path, `packaging save ${save.name} keeps the target directory`).toContain("target");
    }

    // 4. Rust authorities run as isolated parallel lanes sharing one
    // compiler-object namespace.
    const lanes = ["rust-clippy", "rust-tests", "rust-crash", "rust-runtime"];
    for (const lane of lanes) {
      const job = workflow.jobs[lane];
      const setup = job.steps.find((step) => step.id === "rust-setup");
      const run = job.steps.find((step) => step.name.startsWith("Run "));
      expect(setup.uses, `${lane} uses the shared rust setup action`).toBe("./.github/actions/setup-rust-compilation");
      expect(setup.with.lane, `${lane} identifies itself to the setup action`).toBe(lane);
      // Every lane runs on its own fresh runner, so the lanes share one
      // target-directory path without any filesystem overlap. The identical
      // path keeps sccache keys stable across lanes, which matters for the
      // Ladybug CMake build whose generated-header paths would otherwise
      // fragment the C/C++ cache per lane.
      expect(run.env.CARGO_TARGET_DIR, `${lane} shares the one compiler-object namespace`).toBe(
        "\${{ runner.temp }}/cargo-target",
      );
      expect(run.env.CARGO_INCREMENTAL, `${lane} disables incremental builds`).toBe("0");
      expect(run.env.CARGO_PROFILE_DEV_DEBUG, `${lane} pins dev debug info`).toBe("line-tables-only");
      expect(run.env.CARGO_PROFILE_TEST_DEBUG, `${lane} pins test debug info`).toBe("line-tables-only");
      expect(run.env.RUSTC_WRAPPER, `${lane} compiles through the sccache wrapper`).toBe(
        "${{ github.workspace }}/scripts/ci/sccache-wrapper.sh",
      );
      expect(run.env.SCCACHE_GHA_VERSION, `${lane} keys sccache on the setup cache version`).toBe(
        "${{ steps.rust-setup.outputs.cache-version }}",
      );
    }
    for (const cargoLane of ["rust-clippy", "rust-tests", "rust-runtime"]) {
      const run = workflow.jobs[cargoLane].steps.find((step) =>
        step.name.startsWith("Run "),
      );
      expect(run.env.RELAYER_CARGO_TIMINGS_DIR, `${cargoLane} records cargo timings in its own lane directory`).toBe(
        `\${{ runner.temp }}/cargo-timings-${cargoLane}`,
      );
    }
    for (const writerLane of ["rust-clippy", "rust-tests", "rust-crash"]) {
      const run = workflow.jobs[writerLane].steps.find((step) =>
        step.name.startsWith("Run "),
      );
      expect(run.env.SCCACHE_GHA_RW_MODE, `${writerLane} writes to the shared compiler cache`).toBe("READ_WRITE");
      expect(
        workflow.jobs[writerLane].steps.find((step) => step.id === "rust-setup").with["sccache-mode"],
        `${writerLane} inherits the default read-write sccache mode`,
      ).toBeUndefined();
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
    expect(runtimeRun.env.SCCACHE_GHA_RW_MODE, "the runtime lane's cache mode stays conditional").toBe(conditionalRuntimeMode);
    expect(
      workflow.jobs["rust-runtime"].steps.find((step) => step.id === "rust-setup")
        .with["sccache-mode"],
      "the runtime lane passes its conditional sccache mode to setup",
    ).toBe(conditionalRuntimeMode);
    expect(
      workflow.jobs["rust-crash"].steps.find((step) => step.name.startsWith("Run ")).env
        .RELAYER_CARGO_TIMINGS_DIR,
      "the crash lane records no cargo timings",
    ).toBeUndefined();
    expect(workflow.jobs.rust.needs, "the rust aggregate needs every lane").toEqual(
      expect.arrayContaining([
        "plan",
        "rust-clippy",
        "rust-tests",
        "rust-crash",
        "rust-runtime",
      ]),
    );

    // The writer lanes rely on the composite action defaulting to read-write;
    // a silent default change would stop seeding without tripping the
    // per-lane env pins above.
    expect(rustSetupAction.inputs["sccache-mode"].default, "the rust setup action defaults to read-write").toBe("READ_WRITE");
    expect(
      rustSetupAction.runs.steps.find((step) => step.id === "sccache-start").env
        .SCCACHE_GHA_RW_MODE,
      "sccache start consumes the lane's sccache mode",
    ).toBe("${{ inputs.sccache-mode }}");
    const sccache = rustSetupAction.runs.steps.find(
      (step) => step.id === "sccache-setup",
    );
    expect(sccache.uses, "the sccache action stays pinned to a commit").toMatch(
      /^mozilla-actions\/sccache-action@[0-9a-f]{40}$/,
    );
    expect(sccache["continue-on-error"], "sccache setup failure never blocks compilation").toBe(true);
    expect(sccache.if, "fork PRs skip the sccache setup").toBe(
      "${{ github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository }}",
    );
    expect(rustSetupAction.outputs["cache-version"].value, "the cache version output flows from the identity step").toContain(
      "steps.identity.outputs.cache-version",
    );
    expect(
      rustSetupAction.runs.steps.find((step) => step.id === "identity").run,
      "the compilation identity key stays pinned",
    ).toContain("relayer-rust-parallel-line-tables-v1-");

    const report = rustReport.runs.steps.find(
      (step) => step.name === "Record compiler cache statistics",
    );
    const upload = rustReport.runs.steps.find(
      (step) => step.name === "Upload compiler cache statistics",
    );
    expect(report.run, "cache statistics recording tees into the stats file").toContain('| tee "$stats_text"');
    expect(report.run, "cache statistics recording preserves the pipeline status").toContain("text_status=${PIPESTATUS[0]}");
    expect(report.run, "cache statistics recording uses the json stats format").toContain("--show-stats --stats-format json");
    expect(upload.uses, "the stats upload stays pinned to a commit").toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
    expect(upload.if, "the stats upload always runs").toBe("${{ always() }}");
    expect(upload["continue-on-error"], "a failed stats upload never fails the lane").toBe(true);
    expect(upload.with["if-no-files-found"], "missing stats are ignored").toBe("ignore");
    expect(upload.with["retention-days"], "stats retention stays fourteen days").toBe(14);
    const timingsUpload = rustReport.runs.steps.find(
      (step) => step.name === "Upload Cargo timing report",
    );
    expect(timingsUpload.uses, "the timing upload uses the same pinned action").toBe(upload.uses);
    expect(timingsUpload.if, "the timing upload always runs").toBe("${{ always() }}");
    expect(timingsUpload["continue-on-error"], "a failed timing upload never fails the lane").toBe(true);
    expect(timingsUpload.with["if-no-files-found"], "missing timing reports are ignored").toBe("ignore");
    expect(timingsUpload.with["retention-days"], "timing retention stays fourteen days").toBe(14);
    expect(timingsUpload.with.path, "the timing upload reads the lane's timings directory").toBe(
      "${{ runner.temp }}/cargo-timings-${{ inputs.lane }}",
    );

    // 5. The exact Rust runtime artifact is verified before the fresh Vitest
    // portfolio runs.
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
    const uploadRuntime = workflow.jobs["rust-runtime"].steps.find(
      (step) => step.name === "Upload selected Rust runtime",
    );

    expect(workflow.jobs.vitest.needs, "the vitest lane needs the rust runtime lane").toContain("rust-runtime");
    expect(downloadIndex, "the runtime download step exists").toBeGreaterThan(-1);
    expect(verifyIndex, "runtime verification happens after the download").toBeGreaterThan(downloadIndex);
    expect(prerequisiteIndex, "the non-Rust prerequisite build exists").toBeGreaterThan(-1);
    expect(testIndex, "the fresh portfolio runs after the prerequisites").toBeGreaterThan(prerequisiteIndex);
    expect(download.uses, "the runtime download stays pinned to a commit").toMatch(/^actions\/download-artifact@[0-9a-f]{40}$/);
    expect(uploadRuntime.uses, "the runtime upload stays pinned to a commit").toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
    expect(download.with.name, "download and upload share one artifact name").toBe(uploadRuntime.with.name);
    // Artifacts are immutable per workflow run; overwrite lets "re-run all
    // jobs" replace the first attempt's bytes while a stable name keeps
    // partial re-runs able to download the original upload.
    expect(uploadRuntime.with.overwrite, "re-runs may replace the runtime artifact bytes").toBe(true);
    for (const identity of [
      "--source-commit",
      "--platform",
      "--rustc-release",
      "--cargo-profile",
    ]) {
      expect(verify.run, `runtime verification checks ${identity}`).toContain(identity);
    }
    // The seal step must read the binaries from the same target directory
    // the lanes build into; a drift here fails late (ENOENT) without this pin.
    const seal = workflow.jobs["rust-runtime"].steps.find(
      (step) => step.name === "Seal selected Rust runtime",
    );
    expect(seal.run, "the seal step reads the shared lane target directory").toContain('--target-dir "$RUNNER_TEMP/cargo-target/debug"');
    expect(
      steps.some(
        (step) =>
          step.uses?.startsWith("actions/cache/") &&
          step.with?.path?.includes("target"),
      ),
      "the vitest lane never caches target directories",
    ).toBe(false);
    expect(
      readFileSync(
        join(repositoryRoot, "scripts", "ci", "run-chapter.mjs"),
        "utf8",
      ),
      "the chapter runner never rebuilds the vitest runtime itself",
    ).not.toContain('run("Build selected Vitest Rust runtime"');

    // 6. Ladybug is built once and verified before every Rust lane links it.
    const job = workflow.jobs["lbug-prebuilt"];
    expect(job.if, "the prebuilt Ladybug job runs exactly when a Rust consumer runs").toBe(
      "${{ needs.quick.result == 'success' && (needs.plan.outputs.rust == 'true' || needs.plan.outputs.rust_runtime == 'true' || needs.plan.outputs.rust_crash == 'true') }}",
    );
    expect(
      job.steps.find((step) => step.id === "rust-setup").uses,
      "the prebuilt job uses the shared rust setup action",
    ).toBe("./.github/actions/setup-rust-compilation");
    const restore = job.steps.find((step) => step.id === "lbug-cache");
    expect(restore.uses, "the prebuilt job restores its cache").toMatch(/^actions\/cache\/restore@/);
    expect(restore.if, "the prebuilt cache restore runs on every event").toBeUndefined();
    const build = job.steps.find(
      (step) => step.name === "Build Ladybug from the pinned bundled source",
    );
    expect(build.if, "a cache hit skips the Ladybug build").toBe("${{ steps.lbug-cache.outputs.cache-hit != 'true' }}");
    expect(build.run, "the Ladybug build uses the pinned lbug package").toContain("cargo build -p lbug");
    expect(build.run, "the Ladybug build seals its artifact").toContain("scripts/ci/lbug-artifact.mjs create");
    const lbugUpload = job.steps.find(
      (step) => step.name === "Upload prebuilt Ladybug library",
    );
    expect(lbugUpload.uses, "the Ladybug upload stays pinned to a commit").toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
    expect(lbugUpload.with.overwrite, "re-runs may replace the Ladybug artifact").toBe(true);
    const save = job.steps.find(
      (step) => step.name === "Save trusted prebuilt Ladybug bundle",
    );
    expect(save.if, "the Ladybug bundle is saved only on trusted pushes").toContain("github.event_name == 'push'");
    expect(save.with.key, "the Ladybug save reuses the restore primary key").toBe("${{ steps.lbug-cache.outputs.cache-primary-key }}");
    // The job that does the steady-state C++ compiling stays visible to the
    // cache-evidence chain like every other compiling lane.
    const lbugReport = job.steps.find(
      (step) => step.name === "Report Ladybug build compiler cache",
    );
    expect(lbugReport.if, "the Ladybug cache report always runs").toBe("${{ always() }}");
    expect(lbugReport["continue-on-error"], "a failed Ladybug cache report never fails the job").toBe(true);
    expect(lbugReport.with.lane, "the Ladybug cache report names its lane").toBe("lbug-prebuilt");
    expect(build.run, "the Ladybug build records cargo timings").toContain("--timings");
    expect(build.env.RELAYER_CARGO_TIMINGS_DIR, "the Ladybug timings go to the lane directory").toBe(
      "${{ runner.temp }}/cargo-timings-lbug-prebuilt",
    );

    for (const lane of lanes) {
      const laneJob = workflow.jobs[lane];
      expect(laneJob.needs, `${lane} needs the prebuilt Ladybug job`).toContain("lbug-prebuilt");
      // A failed acceleration job must never skip the lanes into a red
      // aggregate: the gates re-derive from plan/quick results only, and the
      // lanes' download/verify steps fail open to the source build.
      expect(laneJob.if, `${lane} re-derives its gate from plan and quick only`).toBe(
        lane === "rust-crash"
          ? "${{ always() && needs.plan.result == 'success' && needs.quick.result == 'success' && needs.plan.outputs.rust_crash == 'true' }}"
          : lane === "rust-runtime"
            ? "${{ always() && needs.plan.result == 'success' && needs.quick.result == 'success' && needs.plan.outputs.rust_runtime == 'true' }}"
            : "${{ always() && needs.plan.result == 'success' && needs.quick.result == 'success' && needs.plan.outputs.rust == 'true' }}",
      );
      const laneDownload = laneJob.steps.find(
        (step) => step.name === "Download prebuilt Ladybug library",
      );
      const laneVerify = laneJob.steps.find(
        (step) => step.name === "Verify and install prebuilt Ladybug library",
      );
      // Fail-open: a missing or rejected bundle falls back to the source build.
      expect(laneDownload["continue-on-error"], `${lane} fails open when the Ladybug download is missing`).toBe(true);
      expect(laneVerify["continue-on-error"], `${lane} fails open when the Ladybug bundle is rejected`).toBe(true);
      expect(laneDownload.with.name, `${lane} downloads the shared Ladybug artifact`).toBe(lbugUpload.with.name);
      expect(laneVerify.run, `${lane} verifies the Ladybug bundle`).toContain("scripts/ci/lbug-artifact.mjs verify");
      expect(laneVerify.run, `${lane} exports the Ladybug link environment`).toContain('--github-env "$GITHUB_ENV"');
    }

    // 7. PR parent history stays complete for Vitest evidence checks.
    for (const jobName of ["vitest"]) {
      const checkout = workflow.jobs[jobName].steps.find((step) =>
        step.uses?.startsWith("actions/checkout@"),
      );
      expect(checkout.with["fetch-depth"], `${jobName} checks out full history for evidence checks`).toBe(0);
    }
  });
});
