#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function evaluateRequiredJobs(plan, results) {
  const required = ["plan", "quick"];
  for (const [chapter, selected] of Object.entries(plan.chapters)) {
    if (selected) required.push(chapter);
  }
  const failures = [...new Set(required)]
    .filter((job) => results[job] !== "success")
    .map((job) => `${job}: ${results[job] ?? "missing"}`);
  return { ok: failures.length === 0, failures };
}

export function evaluateRustJobs(plan, results) {
  const required = ["rust-clippy", "rust-tests"];
  if (plan.rustCrash) required.push("rust-crash");
  if ((plan.runtimeRustPackages ?? []).length > 0)
    required.push("rust-runtime");
  const failures = required
    .filter((job) => results[job] !== "success")
    .map((job) => `${job}: ${results[job] ?? "missing"}`);
  return { ok: failures.length === 0, failures };
}

export function evaluateRequiredInputs(planJson, needsJson) {
  let needs;
  try {
    needs = JSON.parse(needsJson);
  } catch {
    return { ok: false, failures: ["check: malformed needs input"] };
  }
  if (!needs.plan || needs.plan.result !== "success") {
    return {
      ok: false,
      failures: [`plan: ${needs.plan?.result ?? "missing"}`],
    };
  }
  let plan;
  try {
    plan = JSON.parse(planJson);
  } catch {
    return { ok: false, failures: ["plan: missing or malformed output"] };
  }
  const results = Object.fromEntries(
    Object.entries(needs).map(([job, value]) => [job, value.result]),
  );
  return evaluateRequiredJobs(plan, results);
}

function main() {
  let evaluation;
  if (process.env.CI_AGGREGATE === "rust") {
    try {
      const plan = JSON.parse(process.env.CI_PLAN_JSON ?? "");
      const needs = JSON.parse(process.env.CI_NEEDS_JSON ?? "{}");
      evaluation = evaluateRustJobs(
        plan,
        Object.fromEntries(
          Object.entries(needs).map(([job, value]) => [job, value.result]),
        ),
      );
    } catch {
      evaluation = { ok: false, failures: ["rust: malformed aggregate input"] };
    }
  } else {
    evaluation = evaluateRequiredInputs(
      process.env.CI_PLAN_JSON ?? "",
      process.env.CI_NEEDS_JSON ?? "{}",
    );
  }
  const summary = evaluation.ok
    ? "All selected required CI chapters passed."
    : `First actionable failure: ${evaluation.failures[0]}\nRequired CI failures: ${evaluation.failures.join(", ")}`;
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Required check\n\n${summary}\n`,
    );
  process.stdout.write(`${summary}\n`);
  if (!evaluation.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
