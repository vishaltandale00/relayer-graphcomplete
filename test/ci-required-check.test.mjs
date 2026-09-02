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
  // A selected chapter is required: skipping its runner must fail the
  // aggregate rather than passing vacuously.
  expect(
    evaluateRequiredJobs(fullPlan, {
      plan: "success",
      quick: "success",
      rust: "success",
      typescript: "success",
      vitest: "skipped",
      python: "success",
      receipts: "success",
      prd: "success",
      packaging: "success",
    }),
  ).toEqual({ ok: false, failures: ["vitest: skipped"] });
});

test("a failed planner with no output still names the first actionable failure", () => {
  expect(
    evaluateRequiredInputs("", JSON.stringify({ plan: { result: "failure" } })),
  ).toEqual({
    ok: false,
    failures: ["plan: failure"],
  });
});

test("the Rust aggregate drops the runtime lane when the digest cache replaced it", () => {
  const plan = {
    chapters: { rust: true },
    rustCrash: true,
    runtimeRustPackages: ["relayer-graph-server"],
  };
  const laneResults = {
    "rust-clippy": "success",
    "rust-tests": "success",
    "rust-crash": "success",
    "rust-runtime": "skipped",
  };
  expect(evaluateRustJobs(plan, laneResults)).toEqual({
    ok: false,
    failures: ["rust-runtime: skipped"],
  });
  expect(
    evaluateRustJobs(plan, laneResults, { runtimeCacheHit: true }),
  ).toEqual({ ok: true, failures: [] });
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

  test("stops gating the parallel chapters on quick while check still requires it", () => {
    // Policy: a formatting failure still fails the required check through
    // quick, but it no longer short-circuits the Rust and chapter spend.
    expect(workflow.jobs.check.needs).toContain("quick");
    expect(workflow.jobs.quick.needs).toBe("plan");
    for (const jobName of [
      "lbug-prebuilt",
      "rust",
      "typescript",
      "vitest",
      "python",
      "receipts",
      "prd",
      "packaging",
    ]) {
      const job = workflow.jobs[jobName];
      expect(job.needs, jobName).not.toContain("quick");
      expect(JSON.stringify(job.if ?? ""), jobName).not.toContain("quick");
      expect(JSON.stringify(job.needs), jobName).toContain("plan");
    }
  });

  test("keeps every acceleration cache key on one trusted expression", () => {
    const installRuntime = parse(
      readFileSync(
        join(
          repositoryRoot,
          ".github",
          "actions",
          "install-rust-runtime",
          "action.yml",
        ),
        "utf8",
      ),
    );
    const installLbug = parse(
      readFileSync(
        join(
          repositoryRoot,
          ".github",
          "actions",
          "install-lbug-bundle",
          "action.yml",
        ),
        "utf8",
      ),
    );
    // The sites differ only in where the rustc release, the Rust input
    // digest, and the package set come from; normalize those sources before
    // comparing so a drift in any one site fails.
    const normalize = (key) =>
      key
        .replace(
          /\$\{\{ (steps\.[a-z-]+\.outputs\.(rustc-release|release)|inputs\.rustc-release) \}\}/g,
          "RELEASE",
        )
        .replace(
          /(\$\{\{ hashFiles\('crates\/\*\*', 'Cargo\.toml', 'Cargo\.lock', '\.cargo\/\*\*'\) \}\}|\$\{\{ inputs\.rust-input-digest \}\})/g,
          "DIGEST",
        )
        .replace(
          /\$\{\{ (steps\.plan\.outputs\.runtime_packages_key|needs\.plan\.outputs\.runtime_packages_key|inputs\.runtime-packages-key) \}\}/g,
          "PKGKEY",
        );
    const planJob = workflow.jobs.plan;
    const lbugLookup = planJob.steps.find((step) => step.id === "lbug-lookup");
    const runtimeLookup = planJob.steps.find(
      (step) => step.id === "runtime-lookup",
    );
    expect(lbugLookup.with["lookup-only"]).toBe(true);
    expect(runtimeLookup.with["lookup-only"]).toBe(true);
    // A cache-service error must read as a miss, never fail the plan or a
    // lane into a red aggregate.
    expect(lbugLookup["continue-on-error"]).toBe(true);
    expect(runtimeLookup["continue-on-error"]).toBe(true);
    expect(planJob.outputs.lbug_cached).toBe(
      "${{ steps.lookups.outputs.lbug_cached }}",
    );
    expect(planJob.outputs.runtime_cache_hit).toBe(
      "${{ steps.lookups.outputs.runtime_cache_hit }}",
    );
    expect(planJob.outputs.runtime_packages_key).toBe(
      "${{ steps.plan.outputs.runtime_packages_key }}",
    );

    // One Ladybug key serves the plan lookup, the prebuilt job, every lane
    // (through the shared install action), and the runtime fallback.
    const lbugKeys = [
      lbugLookup.with.key,
      workflow.jobs["lbug-prebuilt"].steps.find(
        (step) => step.id === "lbug-cache",
      ).with.key,
      installLbug.runs.steps.find(
        (step) => step.id === "lbug-cache-restore",
      ).with.key,
      installRuntime.runs.steps.find(
        (step) => step.id === "fallback-lbug-cache",
      ).with.key,
    ].map(normalize);
    expect(new Set(lbugKeys).size).toBe(1);
    expect(lbugKeys[0]).toContain("-v1-${{ hashFiles('Cargo.lock') }}");

    // One runtime key serves the plan lookup, the trusted save, and the
    // shard restore; it binds the Rust input digest and the sealed package
    // set so an under-covering bundle can never hit.
    const runtimeKeys = [
      runtimeLookup.with.key,
      workflow.jobs["rust-runtime"].steps.find(
        (step) => step.name === "Save trusted Rust runtime bundle",
      ).with.key,
      installRuntime.runs.steps.find(
        (step) => step.id === "runtime-cache",
      ).with.key,
    ].map(normalize);
    expect(new Set(runtimeKeys).size).toBe(1);
    expect(runtimeKeys[0]).toContain("-debug-default-v1-DIGEST-PKGKEY");

    // The shard restore shares the other steps' gate and never unpacks a
    // bundle the plan did not select.
    const shardRestore = installRuntime.runs.steps.find(
      (step) => step.id === "runtime-cache",
    );
    expect(shardRestore.if).toBe(
      "${{ inputs.rust-runtime-selected == 'true' && inputs.runtime-cache-hit == 'true' }}",
    );
    expect(shardRestore["continue-on-error"]).toBe(true);

    // Every lane installs the bundle through the shared action, so the four
    // former copies cannot drift apart.
    for (const lane of [
      "rust-clippy",
      "rust-tests",
      "rust-crash",
      "rust-runtime",
    ]) {
      const install = workflow.jobs[lane].steps.find(
        (step) => step.name === "Install prebuilt Ladybug library",
      );
      expect(install.uses, lane).toBe("./.github/actions/install-lbug-bundle");
      expect(install.with["lbug-cached"], lane).toBe(
        "${{ needs.plan.outputs.lbug_cached }}",
      );
      expect(install.with["rustc-release"], lane).toBe(
        "${{ steps.rust-setup.outputs.rustc-release }}",
      );
    }

    // The Rust aggregate must see the same cache-hit flag that skipped the
    // runtime lane.
    const aggregate = workflow.jobs.rust.steps.find(
      (step) => step.name === "Assert every selected Rust lane passed",
    );
    expect(aggregate.env.CI_RUNTIME_CACHE_HIT).toBe(
      "${{ needs.plan.outputs.runtime_cache_hit }}",
    );
  });

  test("restores acceleration caches on PRs and saves them only from trusted runs", () => {
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
    const installRuntimeAction = parse(
      readFileSync(
        join(
          repositoryRoot,
          ".github",
          "actions",
          "install-rust-runtime",
          "action.yml",
        ),
        "utf8",
      ),
    );
    const cacheSteps = [
      ...allSteps,
      ...setupAction.runs.steps,
      ...rustSetupAction.runs.steps,
      ...installRuntimeAction.runs.steps,
    ];
    const restores = cacheSteps.filter((step) =>
      step.uses?.startsWith("actions/cache/restore@"),
    );
    const saves = cacheSteps.filter((step) =>
      step.uses?.startsWith("actions/cache/save@"),
    );

    expect(restores.length).toBeGreaterThan(0);
    expect(saves.length).toBeGreaterThan(0);
    // Restores are unconditional or gated by the plan's lookup-only
    // results, the runtime cache-hit input, or the fail-open fallback
    // condition; no other gate may starve a lane of an available entry.
    const allowedRestoreGates = [
      /^\$\{\{ \(?steps\.plan\.outputs\./,
      /^\$\{\{ needs\.plan\.outputs\.lbug_cached == 'true' \}\}$/,
      /^\$\{\{ inputs\.rust-runtime-selected == 'true' && inputs\.runtime-cache-hit == 'true' \}\}$/,
      /^\$\{\{ inputs\.rust-runtime-selected == 'true' && steps\.runtime-install\.outcome != 'success'/,
    ];
    for (const restore of restores) {
      if (restore.if === undefined) continue;
      expect(
        allowedRestoreGates.some((gate) => gate.test(restore.if)),
        restore.if,
      ).toBe(true);
    }
    for (const save of saves) {
      expect(save.if).toContain("github.event_name == 'push'");
    }
    // The Ladybug bundle may also be saved by same-repository pull requests,
    // matching the sccache trust model; fork pull requests never save.
    const lbugSave = saves.find(
      (step) => step.name === "Save trusted prebuilt Ladybug bundle",
    );
    expect(lbugSave.if).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    // The runtime bundle is seeded only by trusted main pushes; the Vitest
    // jobs restore it by digest.
    const runtimeSave = saves.find(
      (step) => step.name === "Save trusted Rust runtime bundle",
    );
    expect(runtimeSave.if).toContain("github.ref == 'refs/heads/main'");
    expect(runtimeSave["continue-on-error"]).toBe(true);
    expect(runtimeSave.with.path).not.toContain("target");
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

  test("installs the digest-bound Rust runtime before executing both fresh Vitest shards", () => {
    const runtimeAction = parse(
      readFileSync(
        join(
          repositoryRoot,
          ".github",
          "actions",
          "install-rust-runtime",
          "action.yml",
        ),
        "utf8",
      ),
    );
    const upload = workflow.jobs["rust-runtime"].steps.find(
      (step) => step.name === "Upload selected Rust runtime",
    );
    const rustInputDigest =
      "${{ hashFiles('crates/**', 'Cargo.toml', 'Cargo.lock', '.cargo/**') }}";

    for (const jobName of ["vitest"]) {
      const steps = workflow.jobs[jobName].steps;
      const installIndex = steps.findIndex(
        (step) => step.name === "Install selected Rust runtime",
      );
      const prerequisiteIndex = steps.findIndex(
        (step) => step.name === "Build non-Rust Vitest prerequisites",
      );
      const testIndex = steps.findIndex((step) =>
        step.name.startsWith("Run fresh Vitest"),
      );
      const install = steps[installIndex];

      expect(workflow.jobs[jobName].needs).toContain("rust-runtime");
      expect(installIndex).toBeGreaterThan(-1);
      expect(prerequisiteIndex).toBeGreaterThan(installIndex);
      expect(testIndex).toBeGreaterThan(prerequisiteIndex);
      expect(install.uses).toBe("./.github/actions/install-rust-runtime");
      expect(install.with["rust-runtime-selected"]).toBe(
        "${{ needs.plan.outputs.rust_runtime }}",
      );
      expect(install.with["runtime-cache-hit"]).toBe(
        "${{ needs.plan.outputs.runtime_cache_hit }}",
      );
      expect(install.with["rustc-release"]).toBe(
        "${{ steps.rust-toolchain.outputs.release }}",
      );
      expect(install.with["rustc-host"]).toBe(
        "${{ steps.rust-toolchain.outputs.host }}",
      );
      expect(install.with["rust-input-digest"]).toBe(rustInputDigest);
      expect(install.with["runtime-packages-key"]).toBe(
        "${{ needs.plan.outputs.runtime_packages_key }}",
      );
      expect(install.with["artifact-name"]).toBe(upload.with.name);
      expect(install.with["lbug-artifact-name"]).toBe(
        "lbug-prebuilt-${{ github.sha }}-${{ runner.os }}-${{ runner.arch }}",
      );
      expect(install.with["plan-json"]).toBe(
        "${{ needs.plan.outputs.plan }}",
      );
      // No shard restores a raw target directory.
      expect(
        steps.some(
          (step) =>
            step.uses?.startsWith("actions/cache/") &&
            step.with?.path?.includes("target"),
        ),
      ).toBe(false);
    }

    // The shared action restores the trusted cache on a hit, downloads the
    // lane artifact on a miss, verifies by digest, and fails open to an
    // in-lane build; acceleration trouble never fails the fresh chapters.
    const restore = runtimeAction.runs.steps.find(
      (step) => step.id === "runtime-cache",
    );
    const download = runtimeAction.runs.steps.find(
      (step) => step.name === "Download selected Rust runtime",
    );
    const verify = runtimeAction.runs.steps.find(
      (step) => step.name === "Verify and install selected Rust runtime",
    );
    const fallback = runtimeAction.runs.steps.find(
      (step) =>
        step.name === "Build selected Rust runtime in lane after acceleration failure",
    );
    expect(restore.uses).toMatch(/^actions\/cache\/restore@/);
    expect(restore.if).toBe(
      "${{ inputs.rust-runtime-selected == 'true' && inputs.runtime-cache-hit == 'true' }}",
    );
    expect(download.uses).toMatch(/^actions\/download-artifact@[0-9a-f]{40}$/);
    expect(download.if).toBe(
      "${{ inputs.rust-runtime-selected == 'true' && inputs.runtime-cache-hit != 'true' }}",
    );
    expect(download["continue-on-error"]).toBe(true);
    expect(verify["continue-on-error"]).toBe(true);
    for (const identity of [
      "--rust-input-digest",
      "--platform",
      "--rustc-release",
      "--cargo-profile",
    ]) {
      expect(verify.run).toContain(identity);
    }
    // The digest replaced the source-commit binding: trusted cache entries
    // built by an earlier main commit must install for the current checkout.
    // The plan JSON makes verify assert the bundle covers the consuming
    // plan's runtime packages.
    expect(verify.run).not.toContain("--source-commit");
    expect(verify.run).toContain("--plan-json");
    // The fail-open path rebuilds with the lane's compilation inputs: the
    // trusted Ladybug bundle (cache first, artifact second) and the Cargo
    // dependency archive. A cold CMake floor would be a cliff on both
    // shards at once.
    const fallbackGate =
      "${{ inputs.rust-runtime-selected == 'true' && steps.runtime-install.outcome != 'success' }}";
    const fallbackLbugCache = runtimeAction.runs.steps.find(
      (step) => step.id === "fallback-lbug-cache",
    );
    const fallbackLbugDownload = runtimeAction.runs.steps.find(
      (step) => step.id === "fallback-lbug-download",
    );
    const fallbackLbugInstall = runtimeAction.runs.steps.find(
      (step) => step.id === "fallback-lbug-install",
    );
    const fallbackDependencies = runtimeAction.runs.steps.find(
      (step) =>
        step.name ===
        "Restore Cargo dependency downloads for the runtime fallback",
    );
    expect(fallbackLbugCache.if).toBe(fallbackGate);
    expect(fallbackLbugCache["continue-on-error"]).toBe(true);
    expect(fallbackLbugDownload.if).toBe(
      "${{ inputs.rust-runtime-selected == 'true' && steps.runtime-install.outcome != 'success' && steps.fallback-lbug-cache.outputs.cache-hit != 'true' }}",
    );
    expect(fallbackLbugDownload["continue-on-error"]).toBe(true);
    expect(fallbackLbugInstall.if).toBe(fallbackGate);
    expect(fallbackLbugInstall.run).toContain("scripts/ci/lbug-artifact.mjs verify");
    expect(fallbackLbugInstall.run).toContain('--github-env "$GITHUB_ENV"');
    expect(fallbackDependencies.if).toBe(fallbackGate);
    expect(fallbackDependencies.with.path).toContain("~/.cargo/registry/cache");
    expect(fallback.if).toBe(fallbackGate);
    expect(fallback.run).toContain("scripts/ci/run-chapter.mjs rust-runtime");
    // The summary surfaces the fallback: it is the most expensive path this
    // workflow can take, and telemetry must not read it as a benign fail-open.
    const summary = runtimeAction.runs.steps.find(
      (step) => step.name === "Record runtime acceleration outcome",
    );
    expect(summary.run).toContain("In-lane fallback build");
    expect(summary.env.FALLBACK_BUILD).toBe(
      "${{ steps.runtime-fallback-build.outcome }}",
    );
    // Artifacts are immutable per workflow run; overwrite lets "re-run all
    // jobs" replace the first attempt's bytes while a stable name keeps
    // partial re-runs able to download the original upload.
    expect(upload.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
    expect(upload.with.overwrite).toBe(true);
    // The seal step must read the binaries from the same target directory
    // the lanes build into; a drift here fails late (ENOENT) without this
    // pin. It binds the same Rust input digest that keys the cache.
    const seal = workflow.jobs["rust-runtime"].steps.find(
      (step) => step.name === "Seal selected Rust runtime",
    );
    expect(seal.run).toContain('--target-dir "$RUNNER_TEMP/cargo-target/debug"');
    expect(seal.run).toContain("--rust-input-digest");
    expect(seal.run).toContain(
      "hashFiles('crates/**', 'Cargo.toml', 'Cargo.lock', '.cargo/**')",
    );
    // Only trusted main pushes seed the runtime bundle cache.
    const runtimeSave = workflow.jobs["rust-runtime"].steps.find(
      (step) => step.name === "Save trusted Rust runtime bundle",
    );
    expect(runtimeSave.uses).toMatch(/^actions\/cache\/save@/);
    expect(runtimeSave.if).toContain("github.event_name == 'push'");
    expect(runtimeSave.if).toContain("github.ref == 'refs/heads/main'");
    expect(runtimeSave.with.path).toBe(
      "${{ runner.temp }}/relayer-rust-runtime",
    );
    expect(runtimeSave.with.key).toContain(
      "hashFiles('crates/**', 'Cargo.toml', 'Cargo.lock', '.cargo/**')",
    );
    expect(
      readFileSync(
        join(repositoryRoot, "scripts", "ci", "run-chapter.mjs"),
        "utf8",
      ),
    ).not.toContain('run("Build selected Vitest Rust runtime"');
  });

  test("builds the Ladybug library once and verifies it before every Rust lane links it", () => {
    const job = workflow.jobs["lbug-prebuilt"];
    // Warm runs skip the prebuilt hop: the plan lookup proved the bundle
    // cache entry exists and the lanes restore it directly.
    expect(job.if).toBe(
      "${{ needs.plan.outputs.lbug_cached != 'true' && (needs.plan.outputs.rust == 'true' || needs.plan.outputs.rust_runtime == 'true' || needs.plan.outputs.rust_crash == 'true') }}",
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
    expect(save.if).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
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
      expect(laneJob.needs).toEqual(["plan", "lbug-prebuilt"]);
      // A failed acceleration job must never skip the lanes into a red
      // aggregate: the gates re-derive from the plan result only, and the
      // lanes' restore/verify steps fail open to the source build. Quick no
      // longer gates the lanes, so a formatting failure cannot short-circuit
      // the Rust spend; the check aggregator still fails the run.
      expect(laneJob.if).toBe(
        lane === "rust-crash"
          ? "${{ always() && needs.plan.result == 'success' && needs.plan.outputs.rust_crash == 'true' }}"
          : lane === "rust-runtime"
            ? "${{ always() && needs.plan.result == 'success' && needs.plan.outputs.rust_runtime == 'true' && needs.plan.outputs.runtime_cache_hit != 'true' }}"
            : "${{ always() && needs.plan.result == 'success' && needs.plan.outputs.rust == 'true' }}",
      );
      // Every lane installs the bundle through one shared action; the
      // former four copies can no longer drift apart, including the cache
      // key that must match the plan lookup.
      const install = laneJob.steps.find(
        (step) => step.name === "Install prebuilt Ladybug library",
      );
      expect(install.uses).toBe("./.github/actions/install-lbug-bundle");
      expect(install.with["lbug-cached"]).toBe(
        "${{ needs.plan.outputs.lbug_cached }}",
      );
      expect(install.with["rustc-release"]).toBe(
        "${{ steps.rust-setup.outputs.rustc-release }}",
      );
      expect(install.with["artifact-name"]).toBe(upload.with.name);
    }

    // Warm runs restore straight from the cache; cold runs download the
    // prebuilt job's artifact. Both paths converge on one directory that
    // the shared verify step rejects or installs; a missing or rejected
    // bundle fails open to the lane's source build.
    const installLbug = parse(
      readFileSync(
        join(
          repositoryRoot,
          ".github",
          "actions",
          "install-lbug-bundle",
          "action.yml",
        ),
        "utf8",
      ),
    );
    const cacheRestore = installLbug.runs.steps.find(
      (step) => step.id === "lbug-cache-restore",
    );
    const download = installLbug.runs.steps.find(
      (step) => step.name === "Download prebuilt Ladybug library",
    );
    const verify = installLbug.runs.steps.find(
      (step) => step.name === "Verify and install prebuilt Ladybug library",
    );
    expect(cacheRestore.uses).toMatch(/^actions\/cache\/restore@/);
    expect(cacheRestore.if).toBe("${{ inputs.lbug-cached == 'true' }}");
    expect(cacheRestore.with.path).toBe("${{ runner.temp }}/lbug-prebuilt");
    expect(cacheRestore["continue-on-error"]).toBe(true);
    expect(download.if).toBe("${{ inputs.lbug-cached != 'true' }}");
    expect(download.with.path).toBe("${{ runner.temp }}/lbug-prebuilt");
    expect(download.with.name).toBe("${{ inputs.artifact-name }}");
    expect(download["continue-on-error"]).toBe(true);
    expect(verify["continue-on-error"]).toBe(true);
    expect(verify.run).toContain("scripts/ci/lbug-artifact.mjs verify");
    expect(verify.run).toContain('--artifact-dir "$RUNNER_TEMP/lbug-prebuilt"');
    expect(verify.run).toContain('--github-env "$GITHUB_ENV"');
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
