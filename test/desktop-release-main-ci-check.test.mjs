import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  CI_REQUIRED_JOB,
  CI_WORKFLOW_PATH,
  resolveMainCiCheckRun,
  selectMainCiCheckRun,
  validateMainCiCheckRun,
  writeMainCiCheckSummary,
} from "../desktop/release/main-ci-check.mjs";

const repository = "vishaltandale00/relayer-graphcomplete";
const sourceCommit = "a".repeat(40);

function mainRun(overrides = {}) {
  return {
    id: 33589156213,
    run_attempt: 1,
    event: "push",
    status: "completed",
    conclusion: "success",
    head_branch: "main",
    head_sha: sourceCommit,
    path: CI_WORKFLOW_PATH,
    repository: { full_name: repository },
    ...overrides,
  };
}

const checkJob = { name: CI_REQUIRED_JOB, status: "completed", conclusion: "success", run_attempt: 1 };

describe("desktop candidate main CI check", () => {
  it("selects only a completed successful push run of ci.yml on main for the exact commit", () => {
    const run = mainRun();
    expect(selectMainCiCheckRun({ runs: { workflow_runs: [run] }, sourceCommit, repository })).toBe(run);
    expect(selectMainCiCheckRun({
      runs: { workflow_runs: [run, mainRun({ id: run.id + 1, run_attempt: 2 })] },
      sourceCommit: sourceCommit.toUpperCase(),
      repository,
    })).toMatchObject({ id: run.id + 1 });

    for (const rejected of [
      mainRun({ event: "pull_request" }),
      mainRun({ event: "workflow_dispatch" }),
      mainRun({ status: "in_progress", conclusion: null }),
      mainRun({ conclusion: "failure" }),
      mainRun({ head_branch: "integration/train" }),
      mainRun({ head_sha: "b".repeat(40) }),
      mainRun({ path: ".github/workflows/desktop-signed-preview.yml" }),
      mainRun({ repository: { full_name: "someone-else/relayer-graphcomplete" } }),
    ]) {
      expect(() => selectMainCiCheckRun({ runs: { workflow_runs: [rejected] }, sourceCommit, repository }))
        .toThrow("Wait for the main CI check to pass");
    }
    expect(() => selectMainCiCheckRun({ runs: {}, sourceCommit, repository })).toThrow("No completed, successful push run");
    expect(() => selectMainCiCheckRun({ runs: { workflow_runs: [run] }, sourceCommit: "abc123", repository }))
      .toThrow("full source commit SHA");
  });

  it("requires one successful check job from the run's latest attempt", () => {
    const run = mainRun();
    expect(validateMainCiCheckRun({ run, jobs: { jobs: [checkJob] } })).toEqual({
      runId: "33589156213",
      runAttempt: "1",
      sourceCommit,
    });
    for (const jobs of [
      [],
      [{ ...checkJob, conclusion: "failure" }],
      [{ ...checkJob, status: "in_progress", conclusion: null }],
      [{ ...checkJob, name: "Rust checks and fresh tests" }],
      [{ ...checkJob, run_attempt: 2 }],
      [checkJob, { ...checkJob }],
    ]) {
      expect(() => validateMainCiCheckRun({ run, jobs: { jobs } })).toThrow("one successful check job");
    }
  });

  it("resolves the run through the GitHub Actions API and writes a step summary", async () => {
    const environment = { GITHUB_REPOSITORY: repository, GITHUB_TOKEN: "test-token", GITHUB_SHA: sourceCommit };
    const requested = [];
    const fetchImpl = async (url, { headers }) => {
      requested.push(String(url));
      expect(headers.Authorization).toBe("Bearer test-token");
      if (String(url).includes("/runs/33589156213/jobs")) {
        return new Response(JSON.stringify({ jobs: [checkJob] }), { status: 200 });
      }
      return new Response(JSON.stringify({ workflow_runs: [mainRun()] }), { status: 200 });
    };
    const resolved = await resolveMainCiCheckRun({ environment, fetchImpl });
    expect(resolved).toEqual({ runId: "33589156213", runAttempt: "1", sourceCommit });
    expect(requested).toEqual([
      `https://api.github.com/repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sourceCommit}&event=push&branch=main&per_page=100`,
      `https://api.github.com/repos/${repository}/actions/runs/33589156213/jobs?per_page=100`,
    ]);

    const summaryDirectory = await mkdtemp(join(tmpdir(), "relayer-main-ci-check-"));
    try {
      const summaryPath = join(summaryDirectory, "summary.md");
      await writeMainCiCheckSummary(summaryPath, resolved);
      expect(await readFile(summaryPath, "utf8")).toBe(`- Main CI \`check\`: run 33589156213/1 for ${sourceCommit}\n`);
    } finally {
      await rm(summaryDirectory, { recursive: true, force: true });
    }

    await expect(resolveMainCiCheckRun({ environment: { ...environment, GITHUB_TOKEN: "" }, fetchImpl }))
      .rejects.toThrow("GITHUB_REPOSITORY and GITHUB_TOKEN");
    await expect(resolveMainCiCheckRun({ environment: { ...environment, GITHUB_SHA: "main" }, fetchImpl }))
      .rejects.toThrow("full source commit SHA");
    await expect(resolveMainCiCheckRun({
      environment,
      fetchImpl: async () => new Response("unavailable", { status: 503 }),
    })).rejects.toThrow("GitHub returned HTTP 503");
    await expect(resolveMainCiCheckRun({
      environment,
      fetchImpl: async () => new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 }),
    })).rejects.toThrow("Wait for the main CI check to pass");
    await expect(resolveMainCiCheckRun({
      environment,
      fetchImpl: async (url) => new Response(JSON.stringify(
        String(url).includes("/jobs") ? { jobs: [{ ...checkJob, conclusion: "failure" }] } : { workflow_runs: [mainRun()] },
      ), { status: 200 }),
    })).rejects.toThrow("one successful check job");
  });

  it("gates manual signed candidates on the main CI check instead of rerunning npm run check", async () => {
    const workflow = parseYaml(await readFile(
      new URL("../.github/workflows/desktop-signed-preview.yml", import.meta.url),
      "utf8",
    ));
    const steps = workflow.jobs.validate.steps;
    const gate = steps.find((step) => step.run === "node desktop/release/main-ci-check.mjs");
    expect(gate.if).toBe("${{ github.event_name == 'workflow_dispatch' }}");
    expect(gate.env.GITHUB_TOKEN).toBe("${{ github.token }}");
    expect(workflow.permissions.actions).toBe("read");
    expect(steps.some((step) => /npm (ci|run check)\b/.test(step.run ?? ""))).toBe(false);
  });
});
