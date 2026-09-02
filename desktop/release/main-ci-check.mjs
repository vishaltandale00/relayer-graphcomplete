import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// Pushes to `main` always select the full verification portfolio
// (scripts/ci/select-mode.mjs), and the `check` aggregator passes only when
// planning, the quick checks, and every selected chapter pass
// (docs/agents/ci.md). A completed, successful push run of ci.yml for the exact
// candidate commit is therefore `npm run check` and `npm run build` executed
// freshly on that source snapshot. The manual signed-candidate job requires that
// run instead of repeating the serial script on a cold runner.

export const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
export const CI_REQUIRED_JOB = "check";

function fullCommit(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(normalized)) {
    throw new Error("Main CI check validation requires a full source commit SHA.");
  }
  return normalized;
}

export function selectMainCiCheckRun({ runs, sourceCommit, repository } = {}) {
  const expectedCommit = fullCommit(sourceCommit);
  const expectedRepository = String(repository || "").trim();
  const listed = Array.isArray(runs?.workflow_runs) ? runs.workflow_runs : [];
  const matches = listed.filter((run) => (
    run?.event === "push" &&
    run?.status === "completed" &&
    run?.conclusion === "success" &&
    run?.head_branch === "main" &&
    String(run?.head_sha || "").toLowerCase() === expectedCommit &&
    run?.path === CI_WORKFLOW_PATH &&
    run?.repository?.full_name === expectedRepository
  ));
  if (matches.length === 0) {
    throw new Error(
      `No completed, successful push run of ${CI_WORKFLOW_PATH} on main exists for commit ${expectedCommit}. ` +
      "Wait for the main CI check to pass before building a signed candidate.",
    );
  }
  return matches.reduce((newest, run) => (Number(run.id) > Number(newest.id) ? run : newest));
}

export function validateMainCiCheckRun({ run, jobs } = {}) {
  const listedJobs = Array.isArray(jobs?.jobs) ? jobs.jobs : [];
  const successful = listedJobs.filter((job) => (
    job?.name === CI_REQUIRED_JOB &&
    job?.status === "completed" &&
    job?.conclusion === "success" &&
    String(job?.run_attempt ?? "") === String(run?.run_attempt ?? "")
  ));
  if (successful.length !== 1) {
    throw new Error(
      `Main CI run ${run?.id} attempt ${run?.run_attempt} does not contain one successful ${CI_REQUIRED_JOB} job.`,
    );
  }
  return { runId: String(run.id), runAttempt: String(run.run_attempt), sourceCommit: String(run.head_sha).toLowerCase() };
}

async function readJson(response, label) {
  if (!response.ok) throw new Error(`Unable to read ${label}: GitHub returned HTTP ${response.status}.`);
  return response.json();
}

export async function resolveMainCiCheckRun({ environment = process.env, fetchImpl = fetch } = {}) {
  const repository = String(environment.GITHUB_REPOSITORY || "").trim();
  const token = String(environment.GITHUB_TOKEN || "").trim();
  if (!/^[^/]+\/[^/]+$/.test(repository) || !token) {
    throw new Error("Main CI check lookup requires GITHUB_REPOSITORY and GITHUB_TOKEN.");
  }
  const sourceCommit = fullCommit(environment.GITHUB_SHA);
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const baseUrl = `https://api.github.com/repos/${repository}/actions`;
  const workflowFile = CI_WORKFLOW_PATH.slice(CI_WORKFLOW_PATH.lastIndexOf("/") + 1);
  const runs = await fetchImpl(
    `${baseUrl}/workflows/${workflowFile}/runs?head_sha=${sourceCommit}&event=push&branch=main&per_page=100`,
    { headers },
  ).then((response) => readJson(response, "main CI workflow runs"));
  const run = selectMainCiCheckRun({ runs, sourceCommit, repository });
  const jobs = await fetchImpl(`${baseUrl}/runs/${run.id}/jobs?per_page=100`, { headers })
    .then((response) => readJson(response, "main CI workflow jobs"));
  return validateMainCiCheckRun({ run, jobs });
}

export async function writeMainCiCheckSummary(summaryPath, resolved) {
  if (!summaryPath) return;
  await appendFile(
    summaryPath,
    `- Main CI \`${CI_REQUIRED_JOB}\`: run ${resolved.runId}/${resolved.runAttempt} for ${resolved.sourceCommit}\n`,
    "utf8",
  );
}

async function main() {
  const resolved = await resolveMainCiCheckRun();
  await writeMainCiCheckSummary(process.env.GITHUB_STEP_SUMMARY, resolved);
  process.stdout.write(
    `Main CI ${CI_REQUIRED_JOB} passed in workflow run ${resolved.runId}/${resolved.runAttempt} for ${resolved.sourceCommit}.\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
