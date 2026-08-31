#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const [chapter] = process.argv.slice(2);
const plan = JSON.parse(process.env.CI_PLAN_JSON ?? "{}");

function run(label, command, args, environment = {}) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...environment },
  });
  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const outcome = result.status === 0 ? "passed" : "failed";
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${label}: **${outcome}** in ${elapsedSeconds}s\n`);
    if (result.status !== 0) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- First actionable failure: **${label}**\n`);
    }
  }
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function packageArguments(packages) {
  return packages.flatMap((name) => ["-p", name]);
}

const npmBuildOrder = ["@relayer/graph-client", "@relayer/harness-host", "@relayer/eval-runner"];

if (chapter === "quick") {
  run("Rust formatting", "cargo", ["fmt", "--all", "--", "--check"]);
  run("Generated renderer consistency", "npm", ["run", "prepare:renderer"]);
  run("Generated-file diff", "git", [
    "diff",
    "--exit-code",
    "--",
    "desktop/renderer/vendor/marked.umd.js",
    "desktop/renderer/vendor/lucide.min.js",
  ]);
  if (plan.npmWorkspaces.length > 0 || plan.rootTypeScript) {
    run("Build TypeScript dependency declarations", "npm", ["run", "build:packages"]);
  }
  for (const workspace of npmBuildOrder.filter((name) => plan.npmWorkspaces.includes(name))) {
    run(`Affected typecheck ${workspace}`, "npm", ["run", "check", "-w", workspace]);
  }
  if (plan.rootTypeScript) run("Affected root typecheck", "npx", ["tsc", "--noEmit"]);
} else if (chapter === "rust") {
  const packages = packageArguments(plan.rustPackages);
  run("Rust Clippy", "cargo", ["clippy", ...packages, "--all-targets", "--all-features", "--", "-D", "warnings"]);
  run("Fresh Rust tests", "cargo", ["test", ...packages]);
  if (plan.rustPackages.some((name) => name === "relayer-graph-server" || name === "relayer-app-server")) {
    run("Graph crash reconciliation", "npm", ["run", "check:graph-crash-reconciliation"]);
  }
  const servers = plan.rustPackages.filter((name) => name === "relayer-graph-server" || name === "relayer-app-server");
  if (servers.length > 0) run("Affected Rust server builds", "cargo", ["build", ...packageArguments(servers)]);
} else if (chapter === "typescript") {
  for (const workspace of npmBuildOrder.filter((name) => plan.npmBuildWorkspaces.includes(name))) {
    run(`Build ${workspace}`, "npm", ["run", "build", "-w", workspace]);
  }
  if (plan.rootTypeScript) run("Root TypeScript check", "npx", ["tsc", "--noEmit"]);
} else if (chapter === "vitest-prerequisites") {
  for (const workspace of npmBuildOrder.filter((name) => plan.npmBuildWorkspaces.includes(name))) {
    run(`Build Vitest dependency ${workspace}`, "npm", ["run", "build", "-w", workspace]);
  }
  const servers = plan.rustPackages.filter((name) => name === "relayer-graph-server" || name === "relayer-app-server");
  if (servers.length > 0) run("Build selected Vitest Rust runtime", "cargo", ["build", ...packageArguments(servers)]);
  if (plan.rootTypeScript) run("Build root Vitest TypeScript runtime", "npx", ["tsc", "-p", "tsconfig.build.json"]);
} else if (chapter === "vitest") {
  const selectedFiles = plan.mode === "full" ? [] : plan.vitestFiles;
  run("Fresh mapped Vitest tests", "npx", ["vitest", "run", "--maxWorkers=1", ...selectedFiles]);
  if (plan.mode === "full" || selectedFiles.some((path) => path.startsWith("packages/harness-host/"))) {
    run("Codex secret boundary", "npm", ["run", "test:codex-secret-boundary"]);
  }
} else if (chapter === "python") {
  run(
    "Fresh Python tests",
    "python3",
    ["-m", "unittest", "discover", "-s", "python/relayer-graph/tests"],
    { PYTHONPATH: "python/relayer-graph/src" },
  );
} else if (chapter === "receipts") {
  run("Receipt integrity", "npm", ["run", "lint:ladybug-receipt"]);
} else if (chapter === "prd") {
  run("PRD readability", "npm", ["run", "prd:check-readability"]);
} else if (chapter === "full") {
  run("Repository-required check", "npm", ["run", "check"]);
  run("Repository-required build", "npm", ["run", "build"]);
} else {
  throw new Error(`Unsupported CI chapter: ${chapter}`);
}
