import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const DESKTOP_SIGNED_PREVIEW_WORKFLOW_PATH = ".github/workflows/desktop-signed-preview.yml";

function positiveRunId(value, label = "candidate workflow run ID") {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(`Desktop Preview ${label} must be a positive integer.`);
  }
  return normalized;
}

export function parseDesktopPreviewCandidateTag({ objectType, message, version, targets = ["macos-arm64"] } = {}) {
  if (String(objectType || "").trim() !== "tag") {
    throw new Error("Desktop Preview publication requires an annotated release tag.");
  }
  const normalizedVersion = String(version || "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(normalizedVersion)) {
    throw new Error("Desktop Preview tag annotation requires a numeric Desktop version.");
  }
  const lines = String(message || "").replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== `Relayer Desktop ${normalizedVersion}`) {
    throw new Error(`Desktop Preview tag annotation must start with Relayer Desktop ${normalizedVersion}.`);
  }
  const candidateLines = lines.filter((line) => /^\s*candidate-run(?:\s*:|\b)/i.test(line));
  if (candidateLines.length !== 1) {
    throw new Error("Desktop Preview tag annotation must contain exactly one Candidate-Run line.");
  }
  const match = /^Candidate-Run: ([1-9]\d*)\/([1-9]\d*)$/.exec(candidateLines[0]);
  if (!match) {
    throw new Error("Desktop Preview Candidate-Run must use `Candidate-Run: <positive run ID>/<positive run attempt>`.");
  }
  const candidateArtifacts = {};
  for (const target of targets) {
    const field = `Candidate-Artifact-${target}`;
    const fieldLines = lines.filter((line) => new RegExp(`^\\s*${field}(?:\\s*:|\\b)`, "i").test(line));
    if (fieldLines.length !== 1) {
      throw new Error(`Desktop Preview tag annotation must contain exactly one ${field} line.`);
    }
    const artifactMatch = new RegExp(`^${field}: ([1-9]\\d*)/(sha256:[a-f0-9]{64})$`).exec(fieldLines[0]);
    if (!artifactMatch) {
      throw new Error(`Desktop Preview ${field} must pin a positive artifact ID and SHA-256 digest.`);
    }
    candidateArtifacts[target] = { id: artifactMatch[1], digest: artifactMatch[2] };
  }
  return { candidateRunId: match[1], candidateRunAttempt: match[2], candidateArtifacts };
}

export function validateDesktopPreviewCandidateRun({
  run,
  artifacts,
  candidateRunId,
  candidateRunAttempt,
  candidateArtifacts,
  sourceCommit,
  repository,
  targets = ["macos-arm64"],
} = {}) {
  const expectedRunId = positiveRunId(candidateRunId);
  const expectedRunAttempt = positiveRunId(candidateRunAttempt, "candidate workflow run attempt");
  const expectedCommit = String(sourceCommit || "").trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(expectedCommit)) {
    throw new Error("Desktop Preview candidate validation requires a full source commit SHA.");
  }
  const expectedRepository = String(repository || "").trim();
  if (
    String(run?.id ?? "") !== expectedRunId ||
    String(run?.run_attempt ?? "") !== expectedRunAttempt ||
    run?.event !== "workflow_dispatch" ||
    run?.status !== "completed" ||
    run?.conclusion !== "success" ||
    String(run?.head_sha || "").toLowerCase() !== expectedCommit ||
    run?.head_branch !== "main" ||
    run?.path !== DESKTOP_SIGNED_PREVIEW_WORKFLOW_PATH ||
    run?.repository?.full_name !== expectedRepository
  ) {
    throw new Error("Pinned Desktop Preview candidate run is not a successful manual run for this exact main commit and workflow.");
  }
  const listedArtifacts = Array.isArray(artifacts?.artifacts) ? artifacts.artifacts : [];
  const validatedArtifacts = {};
  for (const target of targets) {
    const name = `relayer-desktop-preview-${target}-${expectedCommit}`;
    const pinned = candidateArtifacts?.[target];
    const artifactId = positiveRunId(pinned?.id, "candidate artifact ID");
    const digest = String(pinned?.digest || "").trim().toLowerCase();
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new Error(`Pinned Desktop Preview candidate artifact ${name} must have a GitHub SHA-256 digest.`);
    }
    const matches = listedArtifacts.filter((artifact) => (
      String(artifact?.id ?? "") === artifactId &&
      artifact?.name === name &&
      artifact?.expired === false &&
      String(artifact?.digest || "").trim().toLowerCase() === digest
    ));
    if (matches.length !== 1) {
      throw new Error(`Pinned Desktop Preview candidate run must contain the exact unexpired ${name} artifact ID and digest.`);
    }
    validatedArtifacts[target] = { id: artifactId, digest, name };
  }
  return { candidateRunId: expectedRunId, candidateRunAttempt: expectedRunAttempt, candidateArtifacts: validatedArtifacts };
}

async function readJson(response, label) {
  if (!response.ok) throw new Error(`Unable to read ${label}: GitHub returned HTTP ${response.status}.`);
  return response.json();
}

export async function resolveDesktopPreviewCandidateRun({ environment = process.env, fetchImpl = fetch } = {}) {
  const version = String(environment.RELAYER_DESKTOP_VERSION || "").trim();
  const { candidateRunId, candidateRunAttempt, candidateArtifacts } = parseDesktopPreviewCandidateTag({
    objectType: environment.RELAYER_DESKTOP_TAG_OBJECT_TYPE,
    message: environment.RELAYER_DESKTOP_TAG_MESSAGE,
    version,
  });
  const repository = String(environment.GITHUB_REPOSITORY || "").trim();
  const token = String(environment.GITHUB_TOKEN || "").trim();
  if (!/^[^/]+\/[^/]+$/.test(repository) || !token) {
    throw new Error("Desktop Preview candidate lookup requires GITHUB_REPOSITORY and GITHUB_TOKEN.");
  }
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const baseUrl = `https://api.github.com/repos/${repository}/actions/runs/${candidateRunId}`;
  const runBeforeArtifacts = await fetchImpl(baseUrl, { headers })
    .then((response) => readJson(response, "candidate workflow run"));
  const artifacts = await fetchImpl(`${baseUrl}/artifacts?per_page=100`, { headers })
    .then((response) => readJson(response, "candidate artifacts"));
  const runAfterArtifacts = await fetchImpl(baseUrl, { headers })
    .then((response) => readJson(response, "candidate workflow run after artifact lookup"));
  validateDesktopPreviewCandidateRun({
    run: runBeforeArtifacts,
    artifacts,
    candidateRunId,
    candidateRunAttempt,
    candidateArtifacts,
    sourceCommit: environment.GITHUB_SHA,
    repository,
  });
  return validateDesktopPreviewCandidateRun({
    run: runAfterArtifacts,
    artifacts,
    candidateRunId,
    candidateRunAttempt,
    candidateArtifacts,
    sourceCommit: environment.GITHUB_SHA,
    repository,
  });
}

export async function writeDesktopPreviewCandidateOutputs(outputPath, resolved) {
  if (!outputPath) throw new Error("Desktop Preview candidate resolution requires GITHUB_OUTPUT.");
  await appendFile(outputPath, [
    `candidate_run_id=${resolved.candidateRunId}`,
    `candidate_run_attempt=${resolved.candidateRunAttempt}`,
    `candidate_artifacts=${JSON.stringify(resolved.candidateArtifacts)}`,
    "",
  ].join("\n"), "utf8");
}

async function main() {
  const resolved = await resolveDesktopPreviewCandidateRun();
  await writeDesktopPreviewCandidateOutputs(process.env.GITHUB_OUTPUT, resolved);
  process.stdout.write(`Pinned Desktop Preview candidate workflow run ${resolved.candidateRunId}/${resolved.candidateRunAttempt}.\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
