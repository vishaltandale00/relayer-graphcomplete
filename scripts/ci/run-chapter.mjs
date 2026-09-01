#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [chapter] = process.argv.slice(2);
const plan = JSON.parse(process.env.CI_PLAN_JSON ?? "{}");
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const portfolio = JSON.parse(
  readFileSync(join(scriptDirectory, "verification-portfolio.v1.json"), "utf8"),
);
const cargoTimingsDirectory = process.env.RELAYER_CARGO_TIMINGS_DIR ?? "";

function cargoTimingArguments(args) {
  if (!cargoTimingsDirectory) return args;
  const separatorIndex = args.indexOf("--");
  if (separatorIndex === -1) return [...args, "--timings"];
  return [
    ...args.slice(0, separatorIndex),
    "--timings",
    ...args.slice(separatorIndex),
  ];
}

// Cargo writes its report to $CARGO_TARGET_DIR/cargo-timings/cargo-timing.html.
// Harvesting is measurement evidence only; it must never fail a lane, but it
// must run on failed compilations too: those are exactly the runs the report
// exists to diagnose.
function harvestCargoTimingReport() {
  if (!cargoTimingsDirectory) return;
  try {
    const targetDirectory = resolve(scriptDirectory, "..", "..", process.env.CARGO_TARGET_DIR || "target");
    const report = join(targetDirectory, "cargo-timings", "cargo-timing.html");
    if (!existsSync(report)) return;
    mkdirSync(cargoTimingsDirectory, { recursive: true });
    const destination = join(cargoTimingsDirectory, `${chapter}.html`);
    copyFileSync(report, destination);
    rmSync(report);
  } catch (error) {
    console.warn(`warning: could not harvest the Cargo timing report: ${error.message}`);
  }
}

function run(label, command, args, environment = {}, options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...environment },
  });
  if (options.harvestCargoTiming) harvestCargoTimingReport();
  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const outcome = result.status === 0 ? "passed" : "failed";
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `- ${label}: **${outcome}** in ${elapsedSeconds}s\n`,
    );
    if (result.status !== 0) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `- First actionable failure: **${label}**\n`,
      );
    }
  }
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runDeclared(role, id, label, command, args, environment = {}, options = {}) {
  const chapterContract = portfolio.chapters?.[chapter];
  const field = role === "authority" ? "authorities" : "prerequisites";
  if (!chapterContract?.[field]?.includes(id)) {
    throw new Error(`${chapter}: undeclared ${role} invocation ${id}`);
  }
  if (process.env.CI_INVOCATION_TRACE) {
    appendFileSync(
      process.env.CI_INVOCATION_TRACE,
      `${JSON.stringify({ chapter, role, id })}\n`,
    );
  }
  run(label, command, args, environment, options);
}

function runAuthority(id, label, command, args, environment = {}, options = {}) {
  runDeclared("authority", id, label, command, args, environment, options);
}

function runPrerequisite(id, label, command, args, environment = {}) {
  runDeclared("prerequisite", id, label, command, args, environment);
}

function packageArguments(packages) {
  return packages.flatMap((name) => ["-p", name]);
}

const npmBuildOrder = [
  "@relayer/graph-client",
  "@relayer/harness-host",
  "@relayer/eval-runner",
];

if (chapter === "quick") {
  run("Verification portfolio ownership", "node", [
    "scripts/ci/verification-portfolio.mjs",
  ]);
  runAuthority("clean-dist", "Clean generated build outputs", "node", [
    "scripts/clean-dist.mjs",
  ]);
  runAuthority("rust-format", "Rust formatting", "cargo", [
    "fmt",
    "--all",
    "--",
    "--check",
  ]);
  runAuthority("renderer-prepare", "Generated renderer consistency", "npm", [
    "run",
    "prepare:renderer",
  ]);
  run("Generated-file diff", "git", [
    "diff",
    "--exit-code",
    "--",
    "desktop/renderer/vendor/marked.umd.js",
    "desktop/renderer/vendor/lucide.min.js",
  ]);
} else if (chapter === "rust-clippy") {
  const packages = packageArguments(plan.rustPackages);
  runAuthority(
    "rust-clippy",
    "Rust Clippy",
    "cargo",
    cargoTimingArguments([
      "clippy",
      ...packages,
      "--all-targets",
      "--all-features",
      "--",
      "-D",
      "warnings",
    ]),
    {},
    { harvestCargoTiming: true },
  );
} else if (chapter === "rust-tests") {
  const packages = packageArguments(plan.rustPackages);
  runAuthority(
    "rust-tests",
    "Fresh Rust tests",
    "cargo",
    cargoTimingArguments(["test", ...packages]),
    {},
    { harvestCargoTiming: true },
  );
} else if (chapter === "rust-crash") {
  runAuthority("rust-crash", "Graph crash reconciliation", "npm", [
    "run",
    "check:graph-crash-reconciliation",
  ]);
} else if (chapter === "rust-runtime") {
  runAuthority(
    "rust-runtime",
    "Selected Rust runtime build",
    "cargo",
    cargoTimingArguments(["build", ...packageArguments(plan.runtimeRustPackages)]),
    {},
    { harvestCargoTiming: true },
  );
} else if (chapter === "typescript") {
  for (const workspace of npmBuildOrder.filter((name) =>
    plan.npmBuildWorkspaces.includes(name),
  )) {
    runAuthority("typescript-packages", `Build ${workspace}`, "npm", [
      "run",
      "build",
      "-w",
      workspace,
    ]);
  }
  for (const workspace of npmBuildOrder.filter((name) =>
    plan.npmWorkspaces.includes(name),
  )) {
    runAuthority(
      "typescript-workspaces",
      `Affected typecheck ${workspace}`,
      "npm",
      ["run", "check", "-w", workspace],
    );
  }
  if (plan.rootTypeScript)
    runAuthority("typescript-root-check", "Root TypeScript check", "npx", [
      "tsc",
      "--noEmit",
    ]);
} else if (chapter === "vitest-prerequisites") {
  for (const workspace of npmBuildOrder.filter((name) =>
    plan.npmBuildWorkspaces.includes(name),
  )) {
    runPrerequisite(
      "typescript-packages",
      `Build Vitest dependency ${workspace}`,
      "npm",
      ["run", "build", "-w", workspace],
    );
  }
  if (plan.rootTypeScript)
    runAuthority(
      "typescript-root-build",
      "Build root Vitest TypeScript runtime",
      "npx",
      ["tsc", "-p", "tsconfig.build.json"],
    );
} else if (chapter === "vitest") {
  const selectedFiles = plan.mode === "full" ? [] : plan.vitestFiles;
  runAuthority("vitest", "Fresh mapped Vitest tests", "npx", [
    "vitest",
    "run",
    "--maxWorkers=1",
    ...selectedFiles,
  ]);
  if (
    plan.mode === "full" ||
    selectedFiles.some((path) => path.startsWith("packages/harness-host/"))
  ) {
    runAuthority("codex-secret-boundary", "Codex secret boundary", "npm", [
      "run",
      "test:codex-secret-boundary",
    ]);
  }
} else if (chapter === "python") {
  runAuthority(
    "python",
    "Fresh Python tests",
    "python3",
    ["-m", "unittest", "discover", "-s", "python/relayer-graph/tests"],
    { PYTHONPATH: "python/relayer-graph/src" },
  );
} else if (chapter === "receipts") {
  runAuthority("receipts", "Receipt integrity", "npm", [
    "run",
    "lint:ladybug-receipt",
  ]);
} else if (chapter === "prd") {
  runAuthority("prd", "PRD readability", "npm", [
    "run",
    "prd:check-readability",
  ]);
} else {
  throw new Error(`Unsupported CI chapter: ${chapter}`);
}
