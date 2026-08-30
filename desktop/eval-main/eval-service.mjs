import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { cp, link, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import {
  basicEvalCaseId,
  basicEvalFollowUpPrompt,
  basicEvalPrompt,
  buildGraphPresentationGrade,
  buildRecursiveGraphPresentationGrade,
  buildTaskOutcomeGrade,
  canonicalJson,
  checkNodeNavigation,
  checkBasicOutput,
  GRAPH_PRESENTATION_RUBRIC_V10,
  expandTestRun,
  gradeH3Workspace,
  gradeFrontierProjectWorkspace,
  H3_AUTONOMOUS_FIX_CASE_ID,
  H3_AUTONOMOUS_INVESTIGATION_CASE_ID,
  H3_PROJECT_CASE_ID,
  H3_UPSTREAM_COMMIT,
  h3ProjectEvalCase,
  h3AutonomousCases,
  frontierAutonomousCases,
  frontierAutonomousCaseIds,
  calibrationAutonomousCases,
  calibrationAutonomousCaseIds,
  materializeCalibrationFixture,
  gradeCalibrationWorkspace,
  graphMemoryEvalCaseId,
  graphMemoryEvalPrompts,
  graphMemoryAnchor,
  checkGraphMemoryFirstTurn,
  checkGraphMemorySecondTurn,
  readGraphMemoryEvidence,
  materializeFrontierProjectFixture,
  materializeH3ProjectFixture,
  projectDeterministicChecksToOutcome,
  selectStandalonePermissionProfile,
} from "@relayer/eval-runner";
import { loadHarnessConfigurations } from "@relayer/harness-host";
import { firstAvailableSelection, harnessUsesConfigurationModel } from "../renderer/src/model-picker-model.js";
import {
  buildAcceptedReviewTopology,
  gradeAcceptedReviewTopology,
} from "./simulated-user-judge.mjs";

export const evalCases = Object.freeze([
  Object.freeze({
    id: graphMemoryEvalCaseId,
    name: "Graph memory · prior accepted reference",
    description: "Searches a prior accepted layer in a second turn and retains the typed reference in one real product thread.",
    promptsForRun: graphMemoryEvalPrompts,
    gradeExecution: gradeGraphMemoryExecution,
  }),
  Object.freeze({
    id: basicEvalCaseId,
    name: "Task system · two turns",
    description: "Explains a queue, two-worker pool, and results store, then follows up in the same thread.",
    prompts: Object.freeze([basicEvalPrompt, basicEvalFollowUpPrompt]),
  }),
  Object.freeze({
    id: "empty-project.task-system.single-turn",
    name: "Task system · one turn",
    description: "Explains the same task system in a fresh standalone thread.",
    prompts: Object.freeze([basicEvalPrompt]),
  }),
  Object.freeze({
    id: "empty-project.hierarchical-overview.single-turn",
    name: "Hierarchical overview · one turn",
    description: "Tests whether a broad overview uses a useful child layer without forcing every node to navigate.",
    prompts: Object.freeze([
      "Create a concise map of how a transformer language model is trained, from raw text through deployment. Keep the overview readable while preserving deeper technical detail where it belongs.",
    ]),
    requiredChecks: Object.freeze(["node-navigation"]),
  }),
  h3ProjectEvalCase,
  ...h3AutonomousCases.map((entry) => Object.freeze({
    ...entry.definition,
    caseSnapshot: entry.catalogSnapshot,
    caseSnapshotDigest: entry.snapshotDigest,
  })),
  ...frontierAutonomousCases.map((entry) => Object.freeze({
    ...entry.definition,
    caseSnapshot: entry.catalogSnapshot,
    caseSnapshotDigest: entry.snapshotDigest,
  })),
  ...calibrationAutonomousCases.map((entry) => Object.freeze({
    ...entry.definition,
    caseSnapshot: entry.catalogSnapshot,
    caseSnapshotDigest: entry.snapshotDigest,
  })),
]);

const evalAblations = Object.freeze([Object.freeze({
  id: "graph-search-query-v1",
  name: "Graph search · query-v1",
  description: "Run the same graph-memory case with indexing-only baselines and explicit query-v1 search treatments.",
  testCaseIds: Object.freeze([graphMemoryEvalCaseId]),
  harnessPairs: Object.freeze([
    Object.freeze({ provider: "Codex", control: "codex-basic", treatment: "codex-basic-graph-search" }),
    Object.freeze({ provider: "Claude", control: "claude-basic", treatment: "claude-basic-graph-search" }),
    Object.freeze({ provider: "Prime Agent", control: "prime-agent-basic", treatment: "prime-agent-basic-graph-search" }),
  ]),
})]);

export function resolveEvalCasePrompts(definition, testRunId) {
  if (!definition) throw new Error("Cannot resolve prompts for an unknown Eval case.");
  const prompts = typeof definition.promptsForRun === "function"
    ? definition.promptsForRun(testRunId)
    : definition.prompts;
  if (!Array.isArray(prompts) || prompts.length === 0 || prompts.some((prompt) => typeof prompt !== "string" || prompt.trim() === "")) {
    throw new Error(`Eval case ${definition.id} has no valid prompts.`);
  }
  return [...prompts];
}

async function gradeGraphMemoryExecution({ execution, interactions, loadGraphOperations }) {
  if (interactions.length !== 2) throw new Error("Graph-memory grading requires exactly two product turns.");
  const [first, second] = interactions.map(({ interaction }) => interaction);
  if (!first.completionOutput || !second.completionOutput) {
    throw new Error("Graph-memory grading requires two completed graph outputs.");
  }
  const firstEvents = await loadGraphOperations(execution.turns[0]);
  const secondEvents = await loadGraphOperations(execution.turns[1]);
  const auditEvents = [...firstEvents, ...secondEvents].sort((left, right) => left.sequence - right.sequence);
  const secondTurnStartSequence = firstEvents.reduce((maximum, event) => Math.max(maximum, event.sequence), 0);
  const evidence = readGraphMemoryEvidence(
    graphMemoryAnchor(execution.testRunId),
    first.completionOutput,
    second.completionOutput,
    auditEvents,
    secondTurnStartSequence,
  );
  return {
    turns: [
      { checks: checkGraphMemoryFirstTurn(first.completionOutput, graphMemoryAnchor(execution.testRunId), first.graphNodeId) },
      { checks: checkGraphMemorySecondTurn(second.completionOutput, first.completionOutput, evidence, second.graphNodeId, false), evidence },
    ],
  };
}

const h3CaseIds = new Set([
  H3_PROJECT_CASE_ID,
  H3_AUTONOMOUS_FIX_CASE_ID,
  H3_AUTONOMOUS_INVESTIGATION_CASE_ID,
]);
const projectCaseIds = new Set([...h3CaseIds, ...frontierAutonomousCaseIds, ...calibrationAutonomousCaseIds]);

export const evalJudges = Object.freeze([
  Object.freeze({ id: "deterministic-graph-contract", name: "Deterministic graph contract" }),
  Object.freeze({ id: "simulated-user", name: "Screenshot-grounded simulated user" }),
  Object.freeze({ id: "simulated-user-sol-high", name: "Screenshot-grounded simulated user · Sol high" }),
]);

const deterministicJudgeId = "deterministic-graph-contract";
const simulatedUserJudgeId = "simulated-user";
const simulatedUserJudgeIds = new Set([simulatedUserJudgeId, "simulated-user-sol-high"]);
const MAX_CONVERSATION_IMPORT_BYTES = 256 * 1024 * 1024;
const ANNOTATION_EXPORT_EXECUTION_STATUSES = new Set(["passed", "failed", "imported"]);
const ANNOTATION_EXPORT_TURN_STATUSES = new Set(["accepted", "failed", "stopped"]);
const execFileAsync = promisify(execFile);

function copy(value) {
  return structuredClone(value);
}

export function evalModelSelectionRequest(selectedModel, productModelSelection = true) {
  return selectedModel === null || !productModelSelection ? {} : {
    modelSelection: {
      familyId: selectedModel.familyId,
      providerId: selectedModel.providerId,
      modelId: selectedModel.modelId,
    },
  };
}

function outcomeGradeFromChecks(checks, caseSnapshot = null) {
  const criteria = caseSnapshot?.artifacts?.outcomeRubric?.criteria || [];
  const criterionGrades = criteria.map((criterion) => ({
      criterionId: criterion.id,
      rating: null,
      weight: criterion.weight,
      rationale: "No lead outcome-judge rating has been recorded; mandatory verifier evidence remains available independently.",
      evidenceRefs: [],
    }));
  const declarations = caseSnapshot?.artifacts?.verifier?.mandatoryGates;
  if (!Array.isArray(declarations)) {
    const grade = projectDeterministicChecksToOutcome(checks);
    return { ...grade, criteria: criterionGrades };
  }
  const mandatoryGates = declarations.map((gate) => mandatoryGateReceipt(gate, checks));
  return {
    ...buildTaskOutcomeGrade({
    status: criterionGrades.length > 0 ? "partial" : "completed",
    mandatoryGates,
    criteria: criterionGrades,
    }),
    evidenceRefs: [...new Set(mandatoryGates.flatMap((gate) => gate.evidenceRefs))],
    verifierId: caseSnapshot.artifacts.verifier.verifierId,
    verifierDigest: caseSnapshot.artifacts.verifier.contentDigest,
    rubricVersion: caseSnapshot.artifacts.outcomeRubric.rubricVersion,
  };
}

function mandatoryGateReceipt(gate, checks) {
  const patterns = {
    "functional-behavior": ["behavior-lower-boundary", "behavior-upper-boundary", "behavior-decimal-number", "behavior-integer-numeric-string", "behavior-decimal-numeric-string", "behavior-custom-fallback"],
    "regression-safety": ["implementation-build", "implementation-typecheck", "implementation-focused-tests"],
    "scoped-clean-commit": ["focused-files", "meaningful-commit", "implementation-clean"],
    "read-only-workspace": ["baseline-head", "zero-diff"],
    "independent-reproduction": ["diagnosis-reproduces-seeded-failure"],
    "hidden-behavior": ["validation-build", "hidden-behavior"],
    "scoped-delivery": ["required-delivery-files", "delivery-commit", "delivery-clean"],
  }[gate.id];
  const matched = Array.isArray(patterns)
    ? checks.filter((check) => patterns.some((pattern) => check.name.includes(pattern)))
    : [];
  if (matched.length === 0 || patterns.some((pattern) => !matched.some((check) => check.name.includes(pattern)))) {
    return {
      schemaVersion: 1,
      gateId: gate.id,
      name: gate.label,
      mandatory: true,
      status: "failed",
      passed: null,
      detail: `Verifier ${gate.id} did not emit every required check.`,
      evidenceRefs: matched.map((check) => `deterministic-check:${check.name}`),
    };
  }
  return {
    schemaVersion: 1,
    gateId: gate.id,
    name: gate.label,
    mandatory: true,
    status: "completed",
    passed: matched.every((check) => check.passed),
    detail: matched.map((check) => `${check.name}: ${check.detail}`).join("\n"),
    evidenceRefs: matched.map((check) => `deterministic-check:${check.name}`),
  };
}

export function presentationGradeFromTurns(turns, requested) {
  if (!requested) {
    return buildGraphPresentationGrade({ status: "unjudged" });
  }
  // Rejudging supersedes the prior attempt for a turn. Never average duplicate
  // attempts or mix legacy 1-4 results with the current 1-8 contract.
  const results = turns.flatMap((turn) => {
    const attempts = turn.judgeResults || [];
    return attempts.length > 0 ? [attempts.at(-1)] : [];
  });
  const completed = results.filter((result) => result.status === "completed");
  const failed = results.filter((result) => result.status === "failed");
  const terminalWithoutReview = turns.filter((turn) => (
    ["accepted", "failed", "stopped"].includes(turn.status)
    && (turn.judgeResults || []).length === 0
  ));
  const status = results.length === 0
    ? terminalWithoutReview.length > 0 ? "failed" : "unjudged"
    : completed.length === results.length && terminalWithoutReview.length === 0 ? "completed"
      : failed.length === results.length ? "failed" : "partial";
  const recursive = completed.length > 0 && completed.every((result) => (
    [2, 3, 4, 5].includes(result.review?.schemaVersion)
    && ["recursive-presentation-judge-v2", "recursive-presentation-judge-v3", "recursive-presentation-judge-v4", "recursive-presentation-judge-v5"].includes(result.review?.contractId)
  ));
  if (recursive) {
    const scales = completed.map((result) => result.review?.schemaVersion === 5 ? 8 : 4);
    const scoreScaleMaximum = scales.includes(8) ? 8 : 4;
    const turnScore = (result, criterion) => {
      const scale = result.review?.schemaVersion === 5 ? 8 : 4;
      const score = scale === 8
        ? result.review?.turn?.criterionJudgments?.[criterion]?.score ?? null
        : result.review?.turn?.ratings?.[criterion] ?? null;
      return score !== null && scale !== scoreScaleMaximum
        ? score * (scoreScaleMaximum / scale)
        : score;
    };
    const scoreCeiling = (result) => {
      const maximum = result.review?.turn?.scoreCeiling?.maximum;
      const scale = result.review?.schemaVersion === 5 ? 8 : 4;
      return [1, 2, 3, 4, 5, 6, 7, 8].includes(maximum)
        ? maximum * (scoreScaleMaximum / scale)
        : null;
    };
    return buildRecursiveGraphPresentationGrade({
      status,
      layers: presentationLayers(completed),
      presentationRatings: completed.map((result) => turnScore(result, "presentation_quality")),
      comprehensionRatings: completed.map((result) => turnScore(result, "answer_quality")),
      scoreCeilings: completed.flatMap((result) => {
        const maximum = scoreCeiling(result);
        return maximum === null ? [] : [maximum];
      }),
      scoreScaleMaximum,
      rootLayerResultIds: completed.flatMap((result) => {
        const layerId = result.review?.rootLayerResult?.layerId;
        return typeof layerId === "string" && layerId ? [layerId] : [];
      }),
    });
  }
  return buildGraphPresentationGrade({
    status,
    layers: presentationLayers(completed),
    depthDecay: 0.5,
    comprehensionRatings: completed.map((result) => result.review?.turn?.ratings?.answer_quality ?? null),
    scoreCeilings: completed.flatMap((result) => {
      const maximum = result.review?.turn?.scoreCeiling?.maximum;
      return [1, 2, 3, 4].includes(maximum) ? [maximum] : [];
    }),
  });
}

function presentationLayers(results) {
  return results.flatMap((result) => {
    const inventory = result.review?.inventory?.layers || [];
    const records = result.review?.layers || [];
    const nodeRecords = result.review?.nodes || [];
    return records.map((record, index) => {
      const current = record?.history?.current || record?.review || record;
      const layerId = String(record?.subject?.layerId ?? current?.layerId ?? `layer-${index + 1}`);
      const inventoryLayer = inventory.find((candidate) => String(candidate.layerId) === layerId);
      const findings = current?.findings || [];
      const nodes = nodeRecords.flatMap((nodeRecord) => {
        const node = nodeRecord?.history?.current || nodeRecord?.review || nodeRecord;
        const nodeLayerId = String(nodeRecord?.subject?.layerId ?? node?.layerId ?? "");
        if (nodeLayerId !== layerId) return [];
        return [{
          nodeId: String(nodeRecord?.subject?.nodeId ?? node?.nodeId ?? ""),
          ratings: node?.score
            ? copy(Object.fromEntries(Object.entries(node.score).filter(([key]) => key !== "nodeId").map(([key, value]) => [
                key,
                value && typeof value === "object" && "score" in value ? value.score : value,
              ])))
            : {
                ...copy(node?.ratings || {}),
                recursive_disclosure: [1, 2, 3, 4].includes(node?.structure?.rating)
                  ? node.structure.rating
                  : null,
              },
          summary: typeof node?.summary === "string"
            ? node.summary
            : typeof node?.semantic?.effectOnLayer === "string" ? node.semantic.effectOnLayer : "",
          evidenceRefs: [...new Set([
            ...(node?.evidence?.context || []),
            ...(node?.evidence?.detail || []),
            ...(node?.structure?.evidence || []),
            ...(node?.semantic?.evidence || []),
            ...(node?.allocationSteps || []).flatMap((step) => step?.evidence || []),
            ...(node?.missingActionOpportunities || []).flatMap((opportunity) => opportunity?.evidence || []),
            ...(node?.actions || []).flatMap((action) => action?.evidence || []),
            ...(node?.findings || []).flatMap((finding) => finding?.evidence || []),
          ])],
        }];
      });
      return {
        layerId,
        depth: Number.isInteger(inventoryLayer?.depth) ? inventoryLayer.depth : Number(record?.subject?.depth ?? index),
        ratings: copy(current?.criterionJudgments
          ? Object.fromEntries(Object.entries(current.criterionJudgments).map(([key, value]) => [key, value?.score ?? null]))
          : current?.layerRatings || current?.ratings || {}),
        summary: typeof current?.layerSummary === "string"
          ? current.layerSummary
          : typeof current?.summary === "string" ? current.summary : "",
        materiallyMisleading: current?.materiallyMisleading === true
          || findings.some((finding) => finding?.severity === "critical")
          || nodeRecords.some((nodeRecord) => {
            const node = nodeRecord?.history?.current || nodeRecord?.review || nodeRecord;
            const nodeLayerId = String(nodeRecord?.subject?.layerId ?? node?.layerId ?? "");
            return nodeLayerId === layerId
              && (node?.findings || []).some((finding) => finding?.severity === "critical");
          }),
        nodes,
        evidenceRefs: [...new Set([
          ...(Array.isArray(current?.evidence) ? current.evidence : current?.evidence?.viewport || []),
          ...findings.flatMap((finding) => finding?.evidence || []),
        ])],
      };
    });
  });
}

function failedOutcomeGrade(error) {
  return { schemaVersion: 1, kind: "task_outcome_grade", status: "failed", qualified: null, score: null, mandatoryGates: [], criteria: [], error };
}

function failedPresentationGrade(error) {
  return { ...buildGraphPresentationGrade({ status: "failed" }), error };
}

function completeExecutionLifecycle(execution, status = "complete") {
  const completedAt = new Date().toISOString();
  const startedAt = execution.lifecycle?.startedAt || completedAt;
  execution.lifecycle = {
    status,
    startedAt,
    completedAt,
    durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
  };
}

function validateFixtureAgainstCaseSnapshot(execution, fixture) {
  const workspace = execution.caseSnapshot?.artifacts?.workspace;
  if (!workspace) return;
  const actualRevision = fixture.sourceRevision ?? (fixture.seededTree ? `git-tree:${fixture.seededTree}` : null);
  if (workspace.source !== fixture.repositoryUrl || workspace.revision !== actualRevision) {
    throw new Error(
      `Materialized fixture identity does not match case ${execution.testCaseId}: `
      + `${fixture.repositoryUrl || "<missing>"}/${actualRevision || "<missing>"}.`,
    );
  }
}

export function judgeArtifactForExecution(execution, turn = null) {
  if (turn?.artifact?.kind === "git_workspace") return copy(turn.artifact);
  const fixture = execution?.fixture;
  if (typeof fixture?.workspaceDirectory !== "string" || fixture.workspaceDirectory.length === 0) return undefined;
  const baseRevision = fixture.seededCommit ?? fixture.upstreamCommit;
  return {
    kind: "git_workspace",
    workingDirectory: fixture.workspaceDirectory,
    ...(typeof baseRevision === "string" && baseRevision.length > 0 ? { baseRevision } : {}),
  };
}

async function captureTurnArtifactSnapshot(execution, workspaceDirectory, interactionId) {
  const snapshotDirectory = join(
    dirname(execution.fixture?.workspaceDirectory || workspaceDirectory),
    "turn-artifacts",
    encodeURIComponent(String(interactionId)),
    "workspace",
  );
  await mkdir(dirname(snapshotDirectory), { recursive: true, mode: 0o700 });
  await rm(snapshotDirectory, { recursive: true, force: true });
  let headOutput;
  try {
    ({ stdout: headOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspaceDirectory, encoding: "utf8" }));
  } catch {
    await cp(workspaceDirectory, snapshotDirectory, { recursive: true });
    return {
      kind: "filesystem_artifact",
      workingDirectory: snapshotDirectory,
      contentDigest: sha256(`filesystem-snapshot:${interactionId}`),
    };
  }
  const headRevision = headOutput.trim();
  await execFileAsync("git", ["clone", "--local", "--no-hardlinks", "--no-checkout", workspaceDirectory, snapshotDirectory]);
  await execFileAsync("git", ["checkout", "--detach", headRevision], { cwd: snapshotDirectory });
  const { stdout: patch } = await execFileAsync("git", ["diff", "--binary", "HEAD", "--"], { cwd: workspaceDirectory, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (patch.length > 0) {
    const patchPath = join(dirname(snapshotDirectory), "working-tree.patch");
    await writeFile(patchPath, patch, "utf8");
    await execFileAsync("git", ["apply", "--whitespace=nowarn", patchPath], { cwd: snapshotDirectory });
  }
  const { stdout: untrackedOutput } = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: workspaceDirectory, encoding: "utf8" });
  const untrackedDigests = [];
  for (const relativePath of untrackedOutput.split("\0").filter(Boolean)) {
    await mkdir(dirname(join(snapshotDirectory, relativePath)), { recursive: true });
    await cp(join(workspaceDirectory, relativePath), join(snapshotDirectory, relativePath), { recursive: true });
    const { stdout: objectDigest } = await execFileAsync("git", ["hash-object", "--no-filters", "--", relativePath], { cwd: workspaceDirectory, encoding: "utf8" });
    untrackedDigests.push(`${relativePath}:${objectDigest.trim()}`);
  }
  return {
    kind: "git_workspace",
    workingDirectory: snapshotDirectory,
    baseRevision: execution.fixture?.seededCommit ?? execution.fixture?.upstreamCommit,
    headRevision,
    contentDigest: sha256(`${headRevision}\n${patch}\n${untrackedDigests.join("\n")}`),
  };
}

export function judgeArtifactEvidenceForExecution(execution, turn = null) {
  const outcome = execution?.outcomeGrade || {};
  const checks = Array.isArray(turn?.deterministicChecks)
    ? turn.deterministicChecks
    : Array.isArray(execution?.checks) ? execution.checks : [];
  const mandatoryFacts = (turn === null && Array.isArray(outcome.mandatoryGates) ? outcome.mandatoryGates : []).map(
      (gate) => `${gate.passed ? "PASS" : "FAIL"} mandatory gate ${gate.name}: ${gate.detail}`,
    );
  const criterionFacts = (turn === null && Array.isArray(outcome.criteria) ? outcome.criteria : []).map(
      (criterion) => `Outcome criterion ${criterion.criterionId}: ${criterion.rationale}`,
    );
  const checkFacts = checks.map((check) => `${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  const allFacts = [...mandatoryFacts, ...criterionFacts, ...checkFacts];
  const facts = allFacts.slice(0, 64).map((fact) => String(fact).slice(0, 2_000));
  return {
    schemaVersion: 1,
    source: "bounded_host_packet",
    summary: facts.length
      ? `Host-authored task evidence contains ${facts.length} of ${allFacts.length} verifier and outcome facts.`
      : "No deterministic verifier or outcome facts were available for this turn.",
    facts,
  };
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function finalizedAnnotationCoverage(execution) {
  if (!ANNOTATION_EXPORT_EXECUTION_STATUSES.has(execution?.status)) return false;
  const threadIds = [...new Set(execution.threadIds || [])];
  if (!threadIds.length || !(execution.turns?.length > 0)) return false;
  const covered = new Set();
  for (const turn of execution.turns) {
    if (
      turn?.threadId == null
      || turn?.interactionId == null
      || !threadIds.some((threadId) => String(threadId) === String(turn.threadId))
      || !ANNOTATION_EXPORT_TURN_STATUSES.has(turn.status)
    ) return false;
    covered.add(String(turn.threadId));
  }
  return threadIds.every((threadId) => covered.has(String(threadId)));
}

function summarize(run) {
  if (run.kind === "imported-conversation") {
    const finished = run.executions.filter((execution) => ["passed", "failed", "error", "imported"].includes(execution.status));
    const passed = run.executions.filter((execution) => execution.status === "passed").length;
    return {
      passed,
      total: run.executions.length,
      byHarness: [{ name: "External conversation", passed, total: run.executions.length, finished: finished.length }],
    };
  }
  const byHarness = run.harnessConfigurationNames.map((name) => {
    const executions = run.executions.filter((execution) => execution.harnessConfigurationName === name);
    const finished = executions.filter((execution) => ["passed", "failed", "error"].includes(execution.status));
    const passed = executions.filter((execution) => execution.status === "passed").length;
    return {
      name,
      passed,
      total: executions.length,
      finished: finished.length,
      completed: executions.filter((execution) => execution.lifecycle
        ? execution.lifecycle.status === "complete"
        : ["passed", "failed", "imported"].includes(execution.status)).length,
      outcomeQualified: executions.filter((execution) => execution.outcomeGrade?.qualified === true).length,
      outcomeJudged: executions.filter((execution) => execution.outcomeGrade?.status === "completed").length,
      presentationJudged: executions.filter((execution) => execution.presentationGrade?.status === "completed").length,
    };
  });
  const passed = run.executions.filter((execution) => execution.status === "passed").length;
  return { passed, total: run.executions.length, byHarness };
}

export class EvalService {
  constructor({
    stateFile,
    productSession,
    configurationPaths,
    onChanged = () => {},
    simulatedUserJudgeRunner = null,
    projectFixtureMaterializer = materializeH3ProjectFixture,
    workspaceGrader = gradeH3Workspace,
    frontierProjectFixtureMaterializer = materializeFrontierProjectFixture,
    frontierWorkspaceGrader = gradeFrontierProjectWorkspace,
    calibrationFixtureMaterializer = materializeCalibrationFixture,
    calibrationWorkspaceGrader = gradeCalibrationWorkspace,
    acceptedTopologyBuilder = buildAcceptedReviewTopology,
    acceptedTopologyGrader = gradeAcceptedReviewTopology,
    candidateTraceExporter = null,
    candidateTraceAttributionLoader = null,
    candidateTraceRequired = false,
    ensureModelCatalog = async () => {},
    conversationImportEnabled = false,
    conversationImportMaxBytes = MAX_CONVERSATION_IMPORT_BYTES,
    annotationSnapshotLoader = null,
    platform = process.platform,
  }) {
    this.stateFile = stateFile;
    this.productSession = productSession;
    this.configurationPaths = configurationPaths;
    this.onChanged = onChanged;
    this.simulatedUserJudgeRunner = simulatedUserJudgeRunner;
    this.projectFixtureMaterializer = projectFixtureMaterializer;
    this.workspaceGrader = workspaceGrader;
    this.frontierProjectFixtureMaterializer = frontierProjectFixtureMaterializer;
    this.frontierWorkspaceGrader = frontierWorkspaceGrader;
    this.calibrationFixtureMaterializer = calibrationFixtureMaterializer;
    this.calibrationWorkspaceGrader = calibrationWorkspaceGrader;
    this.acceptedTopologyBuilder = acceptedTopologyBuilder;
    this.acceptedTopologyGrader = acceptedTopologyGrader;
    this.candidateTraceExporter = candidateTraceExporter;
    this.candidateTraceAttributionLoader = candidateTraceAttributionLoader;
    this.candidateTraceRequired = candidateTraceRequired;
    this.ensureModelCatalog = ensureModelCatalog;
    this.conversationImportEnabled = conversationImportEnabled;
    this.conversationImportMaxBytes = conversationImportMaxBytes;
    this.annotationSnapshotLoader = annotationSnapshotLoader;
    this.platform = platform;
    this.runs = [];
    this.configurations = new Map();
    this.running = new Map();
    this.persistTail = Promise.resolve();
  }

  async open() {
    this.configurations = await loadHarnessConfigurations(this.configurationPaths);
    await rm(join(dirname(this.stateFile), "import-staging"), { recursive: true, force: true });
    try {
      const persisted = JSON.parse(await readFile(this.stateFile, "utf8"));
      if (persisted?.schemaVersion === 1 && Array.isArray(persisted.runs)) this.runs = persisted.runs;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (this.conversationImportEnabled) {
      const publishedImports = await this.#productRequest("/api/internal/conversation-imports");
      for (const receipt of publishedImports.imports || []) {
        if (!this.runs.some((run) => run.importId === receipt.importId)) {
          this.runs.unshift(importedRun(receipt, true));
        }
      }
      await this.#reconcilePendingImportDirectories(publishedImports.imports || []);
    }
    for (const run of this.runs) {
      if (run.status === "running" || run.status === "queued") {
        run.status = "interrupted";
        for (const execution of run.executions) {
          if (execution.status === "running" || execution.status === "queued") {
            execution.status = "interrupted";
            completeExecutionLifecycle(execution, "failed");
          }
        }
      }
      for (const execution of run.executions || []) {
        for (const turn of execution.turns || []) {
          for (const judgeResult of turn.judgeResults || []) {
            if (judgeResult.status === "running" || judgeResult.status === "queued") {
              judgeResult.status = "partial";
              judgeResult.completedAt = new Date().toISOString();
              judgeResult.error ||= "Simulated-user review was interrupted before finalization.";
            }
          }
        }
        if ((execution.turns || []).some((turn) => (turn.judgeResults || []).length > 0)) {
          execution.presentationGrade = presentationGradeFromTurns(execution.turns, true);
        }
      }
      if (["passed", "failed", "error", "interrupted"].includes(run.status) && !run.bundleRef) {
        await this.#writeRunBundle(run);
      }
    }
    await this.#persist();
    return this;
  }

  catalog() {
    const availableConfigurations = new Set(this.configurations.keys());
    return {
      cases: copy(evalCases.map(({ promptsForRun: _promptsForRun, gradeExecution: _gradeExecution, ...definition }) => definition)),
      harnessConfigurations: [...this.configurations.values()].map((configuration) => ({
        name: configuration.name,
        implementation: configuration.implementation,
        settings: copy(configuration.settings),
        graphCapabilityProfile: copy(configuration.graphCapabilityProfile ?? { search: "disabled" }),
      })),
      ablations: copy(evalAblations.map((ablation) => ({
        ...ablation,
        harnessPairs: ablation.harnessPairs.filter(({ control, treatment }) => (
          availableConfigurations.has(control) && availableConfigurations.has(treatment)
        )),
      })).filter(({ harnessPairs }) => harnessPairs.length > 0)),
      judges: copy(evalJudges.filter((judge) => (
        judge.id === deterministicJudgeId || this.simulatedUserJudgeRunner !== null
      ))),
    };
  }

  listRuns() {
    return copy(this.runs.map((run) => ({ ...run, summary: summarize(run) })));
  }

  getRun(runId) {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (!run) throw new Error(`Unknown test run: ${runId}`);
    return copy({ ...run, summary: summarize(run) });
  }

  async judgeImportedConversation(executionId, judgeConfigurationName) {
    const located = this.#findExecution(executionId);
    if (located.run.kind !== "imported-conversation" || located.execution.kind !== "imported-conversation") {
      throw new Error("Only imported conversation executions can use this judge action.");
    }
    if (!evalJudges.some((judge) => judge.id === judgeConfigurationName)) {
      throw new Error("Unknown judge configuration.");
    }
    if (simulatedUserJudgeIds.has(judgeConfigurationName) && this.simulatedUserJudgeRunner === null) {
      throw new Error("Simulated-user judge is not available in this EvalService.");
    }
    if (this.running.has(located.run.id)) throw new Error("This imported conversation is already being judged.");

    const operation = this.#judgeImportedExecution({
      ...located,
      judgeConfigurationName,
    }).finally(() => this.running.delete(located.run.id));
    this.running.set(located.run.id, operation);
    await operation;
    return this.getRun(located.run.id);
  }

  async rejudgeExecution(executionId, judgeConfigurationName) {
    const located = this.#findExecution(executionId);
    if (!simulatedUserJudgeIds.has(judgeConfigurationName)) {
      throw new Error("Judge-only reruns require a simulated-user judge configuration.");
    }
    if (this.simulatedUserJudgeRunner === null) {
      throw new Error("Simulated-user judge is not available in this EvalService.");
    }
    const operationKey = `rejudge:${executionId}`;
    if (this.running.has(operationKey)) throw new Error("This execution is already being rejudged.");

    const operation = (async () => {
      const executionForJudge = {
        ...located.execution,
        judgeConfiguration: { name: judgeConfigurationName },
      };
      const accepted = [];
      for (const turn of located.execution.turns || []) {
        if (turn.threadId == null || turn.interactionId == null) continue;
        const detail = await this.#productRequest(`/api/threads/${encodeURIComponent(turn.threadId)}`);
        const interaction = (detail.interactions || []).find(
          (candidate) => String(candidate.id) === String(turn.interactionId),
        );
        if (interaction?.completionStatus !== "accepted" || !interaction.completionOutput) continue;
        accepted.push({ thread: detail.thread, interaction, turn });
      }
      if (accepted.length === 0) throw new Error("This execution has no accepted turns eligible for rejudging.");

      const results = [];
      for (const [index, candidate] of accepted.entries()) {
        results.push(await this.#judgeAcceptedTurn({
          execution: executionForJudge,
          ...candidate,
          reviewSequence: { index, count: accepted.length },
        }));
      }
      located.execution.presentationGrade = presentationGradeFromTurns(located.execution.turns, true);
      await this.#changed();
      return copy({ executionId, judgeConfigurationName, results });
    })().finally(() => this.running.delete(operationKey));
    this.running.set(operationKey, operation);
    return operation;
  }

  #findExecution(executionId) {
    for (const run of this.runs) {
      const execution = run.executions.find((candidate) => candidate.id === executionId);
      if (execution) return { run, execution };
    }
    throw new Error(`Unknown execution: ${executionId}`);
  }

  async candidateTraceContext(executionId, interactionId) {
    for (const run of this.runs) {
      const execution = run.executions.find((candidate) => candidate.id === executionId);
      if (!execution) continue;
      const turn = interactionId === undefined || interactionId === null
        ? execution.turns[0]
        : execution.turns.find((candidate) => String(candidate.interactionId) === String(interactionId));
      if (!turn) throw new Error(`Unknown Eval turn: ${interactionId}`);
      const expectedRef = [
        "executions",
        encodeURIComponent(execution.id),
        "turns",
        encodeURIComponent(String(turn.interactionId)),
        "candidate-trace",
        "manifest.json",
      ].join("/");
      if (turn.candidateTrace?.ref !== expectedRef) {
        return {
          execution: copy(execution),
          turn: copy(turn),
          manifest: null,
          events: [],
          graphOperations: [],
          graphOperationsEvidence: {
            status: "unavailable",
            error: "Candidate trace artifact is unavailable for this turn.",
            descriptor: copy(turn.candidateTrace?.graphOperations ?? null),
          },
        };
      }
      const directory = join(dirname(this.stateFile), "runs", encodeURIComponent(run.id), ...expectedRef.split("/").slice(0, -1));
      const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
      const events = (await readFile(join(directory, "events.jsonl"), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      let graphOperations = [];
      let graphOperationsEvidence;
      try {
        graphOperations = await this.#loadGraphOperations(execution, turn);
        graphOperationsEvidence = {
          status: "complete",
          error: null,
          descriptor: copy(turn.candidateTrace.graphOperations),
        };
      } catch (error) {
        const descriptor = turn.candidateTrace?.graphOperations;
        graphOperationsEvidence = {
          status: descriptor?.status === "complete" ? "invalid" : "unavailable",
          error: error instanceof Error ? error.message : String(error),
          descriptor: copy(descriptor ?? null),
        };
      }
      return {
        run: { id: run.id },
        execution: {
          id: execution.id,
          testCaseId: execution.testCaseId,
          harnessConfigurationName: execution.harnessConfigurationName,
          turns: execution.turns.map((candidate) => ({
            interactionId: candidate.interactionId,
            turnIndex: candidate.turnIndex,
            prompt: candidate.prompt,
            candidateTrace: copy(candidate.candidateTrace),
          })),
        },
        turn: copy(turn),
        manifest,
        events,
        graphOperations,
        graphOperationsEvidence,
      };
    }
    throw new Error(`Unknown execution: ${executionId}`);
  }

  async createRun(selection) {
    const testCaseIds = selection?.testCaseIds;
    const harnessConfigurationNames = selection?.harnessConfigurationNames;
    const judgeConfigurationName = selection?.judgeConfigurationName;
    if (!Array.isArray(testCaseIds) || testCaseIds.some((id) => !evalCases.some((item) => item.id === id))) {
      throw new Error("Test run contains an unknown test case.");
    }
    if (testCaseIds.some((id) => projectCaseIds.has(id)) && this.platform !== "darwin") {
      throw new Error("Pinned project cases are local Mac only.");
    }
    if (simulatedUserJudgeIds.has(judgeConfigurationName) && this.simulatedUserJudgeRunner === null) {
      throw new Error("Simulated-user judge is not available in this EvalService.");
    }
    if (!evalJudges.some((judge) => judge.id === judgeConfigurationName)) {
      throw new Error("Unknown judge configuration.");
    }
    const id = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const plans = expandTestRun({
      testRunId: id,
      testCaseIds,
      harnessConfigurationNames,
      judgeConfiguration: { name: judgeConfigurationName },
    }, this.configurations);
    for (const plan of plans) validateEvalPermissionProfiles(plan);
    const run = {
      schemaVersion: 1,
      id,
      createdAt: new Date().toISOString(),
      completedAt: null,
      bundleRef: null,
      status: "queued",
      testCaseIds: [...testCaseIds],
      harnessConfigurationNames: [...harnessConfigurationNames],
      judgeConfigurationName,
      executions: plans.map((plan) => {
        const definition = evalCases.find((candidate) => candidate.id === plan.testCaseId);
        return {
        id: randomUUID(),
        testRunId: id,
        testCaseId: plan.testCaseId,
        harnessConfigurationName: plan.harnessConfigurationName,
        harnessConfiguration: plan.harnessConfiguration,
        harnessConfigurationDigest: plan.harnessConfigurationDigest,
        caseSnapshot: copy(definition?.caseSnapshot || null),
        caseSnapshotDigest: definition?.caseSnapshotDigest || null,
        judgeConfiguration: plan.judgeConfiguration,
        status: "queued",
        lifecycle: {
          status: "queued",
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
        threadIds: [],
        turns: [],
        candidateTraceCaptures: {},
        checks: [],
        outcomeGrade: {
          schemaVersion: 1,
          kind: "task_outcome_grade",
          status: "pending",
          qualified: null,
          score: null,
          mandatoryGates: [],
          criteria: [],
        },
        presentationGrade: buildGraphPresentationGrade({ status: "pending" }),
        passed: null,
        promotable: true,
        error: null,
        };
      }),
    };
    this.runs.unshift(run);
    await this.#changed();
    const operation = this.#run(run).catch(async (error) => {
      run.status = "error";
      run.completedAt = new Date().toISOString();
      run.error = error instanceof Error ? error.message : String(error);
      await this.#changed();
    }).finally(() => this.running.delete(id));
    this.running.set(id, operation);
    return this.getRun(id);
  }

  async importConversation(sourcePath) {
    if (!this.conversationImportEnabled) throw new Error("Conversation import is not enabled.");
    if (typeof sourcePath !== "string" || !sourcePath) throw new Error("Conversation import requires a JSONL file path.");
    const stagingDirectory = join(dirname(this.stateFile), "import-staging");
    const stagedSource = join(stagingDirectory, `${randomUUID()}.jsonl`);
    await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
    await stageBoundedSource(sourcePath, stagedSource, this.conversationImportMaxBytes);
    let receipt;
    try {
      const response = await fetch(new URL("/api/internal/conversation-imports", this.productSession.origin), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-ndjson",
          Cookie: `${this.productSession.cookie.name}=${this.productSession.cookie.value}`,
        },
        body: createReadStream(stagedSource),
        duplex: "half",
      });
      receipt = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(receipt?.error || `Conversation import failed (${response.status}).`);
    } catch (error) {
      await rm(stagedSource, { force: true });
      throw error;
    }
    const run = importedRun({
      importId: receipt.importId,
      sourceSha256: receipt.sourceSha256,
      header: { conversation: { title: receipt.title }, producer: receipt.producer },
      threadId: receipt.threadId,
      turns: receipt.turns.map((turn) => ({
        sourceTurnId: turn.sourceTurnId,
        interactionId: turn.interactionId,
        graphNodeId: turn.graphNodeId,
        completionStatus: turn.completionStatus,
      })),
    });
    const sourceRef = ["runs", encodeURIComponent(run.id), "conversation.jsonl"].join("/");
    const sourceFile = join(dirname(this.stateFile), ...sourceRef.split("/"));
    const pendingMarker = join(dirname(sourceFile), "pending-import.json");
    try {
      await mkdir(dirname(sourceFile), { recursive: true });
      await link(stagedSource, sourceFile);
      await rm(stagedSource, { force: true });
      run.sourceRef = sourceRef;
      await this.#writeRunBundle(run);
      await writeFile(pendingMarker, `${JSON.stringify({ importId: receipt.importId })}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      await this.#removeStagedImport(receipt.importId).catch(() => undefined);
      await rm(stagedSource, { force: true });
      await rm(dirname(sourceFile), { recursive: true, force: true });
      throw error;
    }
    let publish;
    try {
      publish = await fetch(new URL("/api/internal/conversation-imports", this.productSession.origin), {
        method: "PUT",
        headers: { Accept: "application/json", "Content-Type": "application/json", Cookie: `${this.productSession.cookie.name}=${this.productSession.cookie.value}` },
        body: JSON.stringify({ importId: receipt.importId }),
      });
    } catch (error) {
      const published = await this.#findPublishedImport(receipt.importId);
      if (!published) {
        try {
          await this.#removeStagedImport(receipt.importId);
        } catch (cleanupError) {
          const publishedAfterCleanup = await this.#findPublishedImport(receipt.importId);
          if (!publishedAfterCleanup) throw cleanupError;
          publish = new Response(null, { status: 200 });
        }
        if (!publish) {
          await rm(dirname(sourceFile), { recursive: true, force: true });
          throw error;
        }
      } else {
        publish = new Response(null, { status: 200 });
      }
    }
    if (!publish.ok) {
      const detail = await publish.json().catch(() => ({}));
      await this.#removeStagedImport(receipt.importId).catch(() => undefined);
      await rm(dirname(sourceFile), { recursive: true, force: true });
      throw new Error(detail?.error || `Conversation publication failed (${publish.status}).`);
    }
    await rm(pendingMarker, { force: true });
    this.runs.unshift(run);
    await this.#changed();
    return this.getRun(run.id);
  }

  async #removeStagedImport(importId) {
    const response = await fetch(new URL("/api/internal/conversation-imports", this.productSession.origin), {
      method: "DELETE",
      headers: { Accept: "application/json", "Content-Type": "application/json", Cookie: `${this.productSession.cookie.name}=${this.productSession.cookie.value}` },
      body: JSON.stringify({ importId }),
    });
    if (!response.ok) throw new Error(`Conversation import cleanup failed (${response.status}).`);
  }

  async #findPublishedImport(importId) {
    const value = await this.#productRequest("/api/internal/conversation-imports");
    return (value.imports || []).find((item) => item.importId === importId) || null;
  }

  async #reconcilePendingImportDirectories(publishedImports) {
    const runsDirectory = join(dirname(this.stateFile), "runs");
    let entries;
    try {
      entries = await readdir(runsDirectory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    const publishedIds = new Set(publishedImports.map((item) => item.importId));
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("import-")) continue;
      const directory = join(runsDirectory, entry.name);
      const marker = join(directory, "pending-import.json");
      let pending;
      try {
        pending = JSON.parse(await readFile(marker, "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      if (publishedIds.has(pending.importId)) {
        await rm(marker, { force: true });
      } else {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }

  reviewContext(executionId) {
    for (const run of this.runs) {
      const selected = run.executions.find((execution) => execution.id === executionId);
      if (!selected) continue;
      const caseIds = run.kind === "imported-conversation"
        ? ["external-conversation"]
        : run.testCaseIds;
      const cases = caseIds.map((caseId) => {
        const definition = evalCases.find((candidate) => candidate.id === caseId);
        const execution = run.kind === "imported-conversation"
          ? selected
          : run.executions.find((candidate) => (
            candidate.testCaseId === caseId
            && candidate.harnessConfigurationName === selected.harnessConfigurationName
          ));
        const threadIds = execution?.threadIds || [];
        const name = run.kind === "imported-conversation"
          ? selected.title || run.title || "Imported conversation"
          : definition?.name || caseId;
        return {
          id: caseId,
          name,
          executionId: execution?.id || null,
          status: execution?.status || "missing",
          threadIds,
          threads: threadIds.map((threadId, index) => ({
            id: threadId,
            name: definition?.threads?.[index]?.name || name,
          })),
        };
      });
      return copy({
        runId: run.id,
        harnessConfigurationName: selected.harnessConfigurationName,
        selectedExecutionId: selected.id,
        selectedCaseId: run.kind === "imported-conversation" ? null : selected.testCaseId,
        readOnly: true,
        origin: copy(selected.origin || run.origin || { kind: "local-eval" }),
        cases,
      });
    }
    throw new Error(`Unknown execution: ${executionId}`);
  }

  async #judgeImportedExecution({ run, execution, judgeConfigurationName }) {
    run.status = "judging";
    run.judgeConfigurationName = judgeConfigurationName;
    execution.status = "judging";
    execution.judgeConfiguration = { name: judgeConfigurationName };
    execution.error = null;
    await this.#changed();

    try {
      const threadId = execution.threadIds?.[0];
      if (threadId == null) throw new Error("Imported execution has no product thread.");
      const detail = await this.#productRequest(`/api/threads/${encodeURIComponent(threadId)}`);
      if (detail.thread?.imported !== true) {
        throw new Error("The product thread is not server-authored imported state.");
      }
      const interactions = new Map((detail.interactions || []).map((interaction) => [String(interaction.id), interaction]));
      const accepted = [];
      const checks = [];
      for (const turn of execution.turns) {
        const interaction = interactions.get(String(turn.interactionId));
        if (!interaction) throw new Error(`Imported product turn ${turn.interactionId} is missing.`);
        turn.threadId = detail.thread.id;
        turn.prompt = interaction.text;
        turn.rootLayerId = interaction.completionOutput?.rootLayer?.layer?.id ?? null;
        turn.status = interaction.completionStatus;
        turn.graphNodeId = interaction.graphNodeId;
        turn.judgeEligible = interaction.completionStatus === "accepted" && Boolean(interaction.completionOutput);
        turn.deterministicChecks = [];
        turn.deterministicPassed = null;
        turn.deterministicJudge = null;
        if (!turn.judgeEligible) continue;

        const prefix = `turn-${interaction.sequence}`;
        const turnChecks = checkBasicOutput(
          interaction.completionOutput,
          interaction.graphNodeId,
          { allowLegacyLayout: true },
        ).map((check) => ({
          ...check,
          name: `${prefix}:${check.name}`,
        }));
        try {
          const topology = await this.acceptedTopologyBuilder({
            turnId: interaction.id,
            rootLayerId: interaction.completionOutput.rootLayer.layer.id,
            loadLayer: (layerId) => this.#productRequest(
              `/api/threads/${encodeURIComponent(detail.thread.id)}`
                + `/interactions/${encodeURIComponent(interaction.id)}`
                + `/layers/${encodeURIComponent(layerId)}`,
            ),
          });
          turnChecks.push(...this.acceptedTopologyGrader(topology).map((check) => ({
            ...check,
            name: `${prefix}:${check.name}`,
          })));
        } catch (error) {
          turnChecks.push({
            name: `${prefix}:graph:accepted-reachable-closure`,
            passed: false,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
        turn.deterministicChecks = turnChecks;
        turn.deterministicPassed = turnChecks.length > 0 && turnChecks.every((check) => check.passed);
        const provenance = importedJudgeProvenance(run, turn);
        turn.deterministicJudge = {
          schemaVersion: 1,
          judge: deterministicJudgeId,
          status: "completed",
          passed: turn.deterministicPassed,
          completedAt: new Date().toISOString(),
          provenance,
          checks: copy(turnChecks),
        };
        checks.push(...turnChecks);
        accepted.push({ thread: detail.thread, interaction, turn, provenance });
      }
      if (accepted.length === 0) throw new Error("This imported conversation has no accepted turns eligible for result judging.");

      execution.checks = checks;
      let passed = accepted.every(({ turn }) => turn.deterministicPassed);
      if (simulatedUserJudgeIds.has(judgeConfigurationName)) {
        const eligible = accepted.filter(({ turn }) => turn.deterministicPassed);
        for (const [index, candidate] of eligible.entries()) {
          const result = await this.#judgeAcceptedTurn({
            execution,
            ...candidate,
            reviewSequence: { index, count: eligible.length },
          });
          if (result.status !== "completed" || result.passed === false) passed = false;
        }
        if (eligible.length === 0) passed = false;
      }
      execution.presentationGrade = presentationGradeFromTurns(
        execution.turns,
        simulatedUserJudgeIds.has(judgeConfigurationName),
      );
      execution.passed = passed;
      execution.status = passed ? "passed" : "failed";
      run.status = execution.status;
      run.completedAt = new Date().toISOString();
      await this.#writeImportedJudgeArtifact(run, execution);
      await this.#changed();
    } catch (error) {
      execution.status = "error";
      execution.passed = false;
      execution.error = error instanceof Error ? error.message : String(error);
      run.status = "error";
      run.completedAt = new Date().toISOString();
      await this.#writeImportedJudgeArtifact(run, execution);
      await this.#changed();
      throw error;
    }
  }

  async exportAnnotatedExecution(executionId) {
    if (typeof this.annotationSnapshotLoader !== "function") {
      throw new Error("Annotation export is unavailable in this EvalService.");
    }
    const run = this.runs.find((candidate) => (
      candidate.executions.some((execution) => execution.id === executionId)
    ));
    const execution = run?.executions.find((candidate) => candidate.id === executionId);
    if (!run || !execution) throw new Error(`Unknown execution: ${executionId}`);
    if (!finalizedAnnotationCoverage(execution)) {
      throw new Error("Annotation export requires a terminal execution with finalized thread and turn coverage.");
    }
    const durableExecution = await this.#durableExecutionForAnnotationExport(run, executionId);
    if (!finalizedAnnotationCoverage(durableExecution)) {
      throw new Error("The durable source run bundle does not contain finalized execution coverage.");
    }
    const threadIds = [...new Set(durableExecution.threadIds)];
    if (canonicalJson(threadIds) !== canonicalJson([...new Set(execution.threadIds)])) {
      throw new Error("The execution thread coverage does not match its durable source run bundle.");
    }
    const annotationSnapshot = await this.annotationSnapshotLoader(threadIds);
    if (
      annotationSnapshot?.schemaVersion !== 1
      || annotationSnapshot?.kind !== "relayer_eval_annotation_snapshot_set"
      || typeof annotationSnapshot?.annotationsSha256 !== "string"
      || !annotationSnapshot.annotationsSha256.startsWith("sha256:")
    ) {
      throw new Error("Annotation snapshot loader returned an invalid atomic snapshot set.");
    }
    const annotationThreads = annotationSnapshot?.threads;
    if (!Array.isArray(annotationThreads) || annotationThreads.length !== threadIds.length) {
      throw new Error("Annotation snapshot loader returned incomplete thread coverage.");
    }
    const missingThreadIds = new Set(threadIds.map(String));
    for (const snapshot of annotationThreads) {
      if (!missingThreadIds.delete(String(snapshot?.threadId))) {
        throw new Error("Annotation snapshot loader returned an unexpected or duplicate thread.");
      }
    }
    if (missingThreadIds.size) {
      throw new Error("Annotation snapshot loader omitted an execution thread.");
    }

    const exportedAt = new Date().toISOString();
    // The backend hashes only the ordered thread histories, not exportedAt.
    // Preserve that transaction-bound digest so identical histories have an
    // identical material identity even when captured at different times.
    const annotationMaterialSha256 = annotationSnapshot.annotationsSha256;
    const fixedGraphReferences = durableExecution.turns.map((turn) => ({
      threadId: turn.threadId,
      interactionId: turn.interactionId,
      graphNodeId: turn.graphNodeId,
      rootLayerId: turn.rootLayerId,
      completionStatus: turn.status,
    }));
    const unsigned = {
      bundleSchemaVersion: 1,
      kind: "relayer_eval_annotated_execution_bundle",
      testRunId: run.id,
      executionId: execution.id,
      exportedAt,
      sourceRunBundleRef: run.bundleRef,
      execution: copy(durableExecution),
      fixedGraphReferences,
      annotationMaterialSha256,
      annotationSnapshot: copy(annotationSnapshot),
    };
    const bundle = {
      ...unsigned,
      integritySha256: sha256(canonicalJson(unsigned)),
    };
    const exportId = `${exportedAt.replace(/[:.]/g, "-")}-${randomUUID()}`;
    const bundleRef = [
      "runs",
      encodeURIComponent(run.id),
      "annotation-exports",
      encodeURIComponent(execution.id),
      exportId,
      "bundle.json",
    ].join("/");
    const bundleFile = join(dirname(this.stateFile), ...bundleRef.split("/"));
    await mkdir(dirname(bundleFile), { recursive: true });
    await writeFile(bundleFile, `${JSON.stringify(bundle, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return copy({
      bundleRef,
      exportedAt,
      annotationMaterialSha256,
      integritySha256: bundle.integritySha256,
    });
  }

  async #durableExecutionForAnnotationExport(run, executionId) {
    const expectedBundleRef = ["runs", encodeURIComponent(run.id), "bundle.json"].join("/");
    if (run.bundleRef !== expectedBundleRef) {
      throw new Error("Annotation export requires a durable source run bundle.");
    }
    let bundle;
    try {
      bundle = JSON.parse(await readFile(
        join(dirname(this.stateFile), ...expectedBundleRef.split("/")),
        "utf8",
      ));
    } catch {
      throw new Error("Annotation export could not read the durable source run bundle.");
    }
    if (
      bundle?.kind !== "relayer_eval_run_bundle"
      || bundle?.testRunId !== run.id
      || bundle?.run?.bundleRef !== expectedBundleRef
    ) {
      throw new Error("Annotation export found an invalid durable source run bundle.");
    }
    const execution = bundle.run.executions?.find((candidate) => candidate.id === executionId);
    if (!execution) throw new Error("The durable source run bundle omits this execution.");
    return execution;
  }

  async #run(run) {
    run.status = "running";
    await this.#changed();
    for (const execution of run.executions) {
      await this.#execute(execution);
      await this.#changed();
    }
    const terminalStatus = run.executions.some((execution) => execution.status === "error")
      ? "error"
      : run.executions.every((execution) => execution.status === "passed") ? "passed" : "failed";
    run.completedAt = new Date().toISOString();
    await this.#writeRunBundle(run, terminalStatus);
    run.status = terminalStatus;
    await this.#changed();
  }

  async #execute(execution) {
    execution.status = "running";
    execution.lifecycle = {
      status: "running",
      startedAt: new Date().toISOString(),
      completedAt: null,
      durationMs: null,
    };
    execution.error = null;
    await this.#changed();
    const definition = evalCases.find((candidate) => candidate.id === execution.testCaseId);
    try {
      if (!definition) throw new Error(`Unknown test case: ${execution.testCaseId}`);
      const executedThreads = projectCaseIds.has(definition.id)
        ? await this.#executeProjectCase(execution, definition)
        : [await this.#executeStandaloneCase(execution, definition)];
      execution.threadIds = executedThreads.map(({ thread }) => thread.id);
      const interactions = executedThreads.flatMap(({ thread, threadDefinition, permissionResolution, detail, workspaceChecks, workspaceArtifacts }) => (
        detail.interactions.map((interaction, threadTurnIndex) => ({
          thread,
          threadDefinition,
          permissionResolution,
          interaction,
          threadTurnIndex,
          workspaceChecks: workspaceChecks.get(String(interaction.id)) || [],
          artifact: workspaceArtifacts?.get(String(interaction.id)) || null,
        }))
      ));
      execution.turns = interactions.map(({ thread, threadDefinition, permissionResolution, interaction, threadTurnIndex, artifact }, turnIndex) => ({
        threadId: thread.id,
        threadDefinitionId: threadDefinition?.id || null,
        interactionId: interaction.id,
        graphNodeId: interaction.graphNodeId,
        rootLayerId: interaction.completionOutput?.rootLayer?.layer?.id ?? null,
        permissionProfileId: interaction.permissionProfileId,
        requestedPermissionProfileId: permissionResolution?.requestedProfileId ?? interaction.permissionProfileId,
        permissionProfileOverride: permissionResolution?.overridden
          ? copy(permissionResolution)
          : null,
        effectiveExecutionDigest: interaction.effectiveExecutionDigest,
        personalPresentationVersionId: execution.candidateTraceCaptures?.[String(interaction.id)]?.personalPresentationVersionId ?? null,
        modelSelection: copy(interaction.modelSelection || null),
        effectivePermissionReceipt: copy(interaction.effectivePermissionReceipt),
        status: interaction.completionStatus,
        prompt: interaction.text,
        turnIndex,
        threadTurnIndex,
        deterministicChecks: [],
        deterministicPassed: false,
        judgeResults: [],
        candidateTrace: copy(execution.candidateTraceCaptures?.[String(interaction.id)] || disabledCandidateTrace()),
        ...(artifact === null ? {} : { artifact: copy(artifact) }),
      }));
      delete execution.candidateTraceCaptures;
      execution.promotable = execution.turns.every((turn) => !this.candidateTraceRequired || turn.candidateTrace.status === "complete");
      let caseGrade = null;
      if (typeof definition.gradeExecution === "function") {
        try {
          caseGrade = await definition.gradeExecution({
            execution,
            interactions,
            loadGraphOperations: (turn) => this.#loadGraphOperations(execution, turn),
          });
        } catch (error) {
          execution.promotable = false;
          caseGrade = {
            turns: execution.turns.map(() => ({
              checks: [{
                name: "case-evidence",
                passed: false,
                detail: error instanceof Error ? error.message : String(error),
              }],
            })),
          };
        }
      }
      const checks = [];
      for (const [turnIndex, executedTurn] of interactions.entries()) {
        const { interaction, threadDefinition, workspaceChecks } = executedTurn;
        const turn = execution.turns[turnIndex];
        const turnChecks = [];
        const checkPrefix = threadDefinition
          ? `${threadDefinition.id}:turn-${interaction.sequence}`
          : `turn-${interaction.sequence}`;
        if (interaction.completionStatus !== "accepted" || !interaction.completionOutput) {
          turnChecks.push({
            name: `${checkPrefix}:accepted`,
            passed: false,
            detail: interaction.completionError || `Turn ended as ${interaction.completionStatus}.`,
          });
        } else {
          const caseChecks = caseGrade?.turns?.[turnIndex]?.checks;
          turnChecks.push(...(Array.isArray(caseChecks) ? caseChecks : checkBasicOutput(interaction.completionOutput, interaction.graphNodeId)).map((check) => ({
            ...check,
            name: `${checkPrefix}:${check.name}`,
          })));
          const caseEvidence = caseGrade?.turns?.[turnIndex]?.evidence;
          if (caseEvidence !== undefined) turn.caseEvidence = copy(caseEvidence);
          if (definition.requiredChecks?.includes("node-navigation")) {
            turnChecks.push(...checkNodeNavigation(interaction.completionOutput).map((check) => ({
              ...check,
              name: `${checkPrefix}:${check.name}`,
            })));
          }
          if (projectCaseIds.has(definition.id)) {
            try {
              const topology = await this.acceptedTopologyBuilder({
                turnId: interaction.id,
                rootLayerId: interaction.completionOutput.rootLayer.layer.id,
                loadLayer: (layerId) => this.#productRequest(
                  `/api/threads/${encodeURIComponent(executedTurn.thread.id)}`
                    + `/interactions/${encodeURIComponent(interaction.id)}`
                    + `/layers/${encodeURIComponent(layerId)}`,
                ),
              });
              turnChecks.push(...this.acceptedTopologyGrader(topology).map((check) => ({
                ...check,
                name: `${checkPrefix}:${check.name}`,
              })));
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              turnChecks.push({
                name: `${checkPrefix}:graph:accepted-reachable-closure`,
                passed: false,
                detail,
              });
            }
          }
        }
        if (projectCaseIds.has(definition.id)) {
          const permissionResolution = executedTurn.permissionResolution;
          const expectedProfileId = permissionResolution.effectiveProfileId;
          turnChecks.push({
            name: `${checkPrefix}:permission-profile`,
            passed: interaction.permissionProfileId === expectedProfileId,
            detail: permissionResolution.overridden
              ? `The case requested ${permissionResolution.requestedProfileId}; ${execution.harnessConfigurationName} explicitly used ${expectedProfileId}. Product recorded ${interaction.permissionProfileId || "none"}.`
              : `Expected ${expectedProfileId}; product recorded ${interaction.permissionProfileId || "none"}.`,
          });
          turnChecks.push({
            name: `${checkPrefix}:effective-execution-receipt`,
            passed: typeof interaction.effectiveExecutionDigest === "string"
              && interaction.effectiveExecutionDigest.startsWith("sha256:")
              && interaction.effectivePermissionReceipt?.permissionProfileId === expectedProfileId,
            detail: interaction.effectiveExecutionDigest
              ? "The accepted turn records its effective execution identity and normalized permission receipt."
              : "The accepted turn is missing its effective execution identity.",
          });
          if (expectedProfileId === "full") {
            turnChecks.push({
              name: `${checkPrefix}:full-access-disclosure`,
              passed: interaction.effectivePermissionReceipt?.unconfinedHostAccess === true
                && typeof interaction.effectivePermissionReceipt?.disclosure === "string",
              detail: interaction.effectivePermissionReceipt?.disclosure || "Full access lacks the required host-confinement disclosure.",
            });
          }
        }
        turnChecks.push(...workspaceChecks.map((check) => ({
          ...check,
          name: `${checkPrefix}:${check.name}`,
        })));
        turn.deterministicChecks = turnChecks;
        turn.deterministicPassed = turnChecks.length > 0 && turnChecks.every((check) => check.passed);
        checks.push(...turnChecks);
      }
      execution.checks = checks;
      const deterministicPassed = checks.length > 0 && checks.every((check) => check.passed);
      const outcomeChecks = execution.caseSnapshot
        ? checks.filter((check) => check.name.includes(":workspace:"))
        : checks;
      execution.outcomeGrade = outcomeGradeFromChecks(outcomeChecks, execution.caseSnapshot);
      let simulatedUserCompleted = true;
      if (simulatedUserJudgeIds.has(execution.judgeConfiguration.name)) {
        const eligibleTurns = interactions
          .map(({ thread, interaction }, turnIndex) => ({ thread, interaction, turn: execution.turns[turnIndex] }))
          .filter(({ interaction }) => (
            interaction.completionStatus === "accepted"
            && interaction.completionOutput
          ));
        for (const [index, { thread, interaction, turn }] of eligibleTurns.entries()) {
          const result = await this.#judgeAcceptedTurn({
            execution,
            thread,
            interaction,
            turn,
            reviewSequence: { index, count: eligibleTurns.length },
          });
          if (result.status !== "completed") simulatedUserCompleted = false;
        }
        if (eligibleTurns.length === 0) simulatedUserCompleted = false;
      }
      execution.presentationGrade = presentationGradeFromTurns(
        execution.turns,
        simulatedUserJudgeIds.has(execution.judgeConfiguration.name),
      );
      execution.passed = deterministicPassed && simulatedUserCompleted;
      execution.status = execution.passed ? "passed" : "failed";
      completeExecutionLifecycle(execution);
    } catch (error) {
      execution.status = "error";
      execution.passed = false;
      execution.error = error instanceof Error ? error.message : String(error);
      execution.outcomeGrade = failedOutcomeGrade(execution.error);
      execution.presentationGrade = failedPresentationGrade(execution.error);
      completeExecutionLifecycle(execution, "failed");
    }
  }

  async #executeStandaloneCase(execution, definition) {
    const thread = await this.#createAndRunThread({
      execution,
      title: definition.name,
      prompts: resolveEvalCasePrompts(definition, execution.testRunId),
      permissionProfileId: selectStandalonePermissionProfile(execution.harnessConfiguration),
    });
    const detail = await this.#productRequest(`/api/threads/${thread.id}`);
    return { thread, threadDefinition: null, detail, workspaceChecks: new Map() };
  }

  async #executeProjectCase(execution, definition) {
    const executionDirectory = join(
      dirname(this.stateFile),
      "runs",
      encodeURIComponent(execution.testRunId),
      "executions",
      encodeURIComponent(execution.id),
    );
    const workspaceDirectory = join(executionDirectory, "workspace");
    const isH3 = h3CaseIds.has(definition.id);
    const isCalibration = calibrationAutonomousCaseIds.has(definition.id);
    const fixture = isH3
      ? await this.projectFixtureMaterializer({
        cacheDirectory: join(dirname(this.stateFile), "fixtures", `h3-${H3_UPSTREAM_COMMIT}`),
        workspaceDirectory,
        platform: this.platform,
      })
      : isCalibration ? await this.calibrationFixtureMaterializer({
        caseId: definition.id,
        workspaceDirectory,
        platform: this.platform,
      }) : await this.frontierProjectFixtureMaterializer({
        caseId: definition.id,
        cacheDirectory: join(dirname(this.stateFile), "fixtures", `${definition.id}-${definition.fixture.upstreamCommit}`),
        workspaceDirectory,
        platform: this.platform,
      });
    validateFixtureAgainstCaseSnapshot(execution, fixture);
    const project = await this.#productRequest("/api/projects", {
      method: "POST",
      body: {
        name: `${definition.name} · ${execution.id.slice(0, 8)}`,
        path: workspaceDirectory,
      },
    });
    execution.projectId = project.id;
    execution.fixture = copy(fixture);
    execution.permissionProfileResolutions = definition.threads.map((threadDefinition) => ({
      threadDefinitionId: threadDefinition.id,
      ...resolveH3PermissionProfile(execution.harnessConfiguration, threadDefinition.permissionProfileId),
    }));
    const executedThreads = [];
    for (const [threadIndex, threadDefinition] of definition.threads.entries()) {
      const workspaceChecks = new Map();
      const workspaceArtifacts = new Map();
      const permissionResolution = execution.permissionProfileResolutions[threadIndex];
      const thread = await this.#createAndRunThread({
        execution,
        title: `${definition.name} · ${threadDefinition.name}`,
        prompts: threadDefinition.prompts,
        projectId: project.id,
        permissionProfileId: permissionResolution.effectiveProfileId,
        afterTurn: async (interactionId, promptIndex) => {
          workspaceArtifacts.set(String(interactionId), await captureTurnArtifactSnapshot(
            execution,
            workspaceDirectory,
            interactionId,
          ));
          if (threadDefinition.mutationPolicy === "read-only" || promptIndex === threadDefinition.prompts.length - 1) {
            workspaceChecks.set(String(interactionId), isH3
              ? await this.workspaceGrader({ workspaceDirectory, grade: threadDefinition.workspaceGrade })
              : isCalibration
                ? await this.calibrationWorkspaceGrader({ caseId: definition.id, workspaceDirectory, baseRevision: fixture.seededCommit })
                : await this.frontierWorkspaceGrader({ caseId: definition.id, workspaceDirectory }));
          }
        },
      });
      const detail = await this.#productRequest(`/api/threads/${thread.id}`);
      executedThreads.push({ thread, threadDefinition, permissionResolution, detail, workspaceChecks, workspaceArtifacts });
    }
    return executedThreads;
  }

  async #createAndRunThread({ execution, title, prompts, projectId = null, permissionProfileId = "auto", afterTurn = async () => {} }) {
    if (!Array.isArray(prompts) || prompts.length === 0) throw new Error(`Eval thread ${title} has no prompts.`);
    let selectedModel;
    let productModelSelection;
    if (execution.harnessConfiguration.implementation === "claude.basic") {
      selectedModel = await this.#productRequest(
        `/api/model-selection/default?harnessId=${encodeURIComponent(execution.harnessConfigurationName)}`,
      );
      productModelSelection = true;
      if (selectedModel === null) {
        throw new Error("claude-basic has no connected compatible model; connect Claude or Anthropic before running this matrix cell.");
      }
    } else {
      if (execution.harnessConfiguration.implementation === "codex.basic") {
        await this.ensureModelCatalog(execution.harnessConfigurationName);
      }
      const modelSettings = await this.#productRequest("/api/model-settings");
      selectedModel = firstAvailableSelection(modelSettings, execution.harnessConfigurationName);
      productModelSelection = !harnessUsesConfigurationModel(
        modelSettings,
        execution.harnessConfigurationName,
      );
      const modelLessEvalFixture = execution.harnessConfiguration.implementation.startsWith("fixture.");
      if (productModelSelection && selectedModel === null && !modelLessEvalFixture) {
        throw new Error(`Eval has no available model for ${execution.harnessConfigurationName}.`);
      }
    }
    const thread = await this.#productRequest("/api/threads", {
      method: "POST",
      body: {
        title,
        initialMessage: prompts[0],
        harnessConfigurationName: execution.harnessConfigurationName,
        permissionProfileId,
        ...evalModelSelectionRequest(selectedModel, productModelSelection),
        ...(projectId === null ? {} : { projectId }),
      },
    });
    execution.threadIds.push(thread.id);
    const rootInteraction = await this.#waitForInteraction(thread.id, thread.rootInteractionId);
    await this.#captureCandidateTrace(execution, rootInteraction);
    await afterTurn(thread.rootInteractionId, 0);
    for (const [offset, prompt] of prompts.slice(1).entries()) {
      const interaction = await this.#productRequest(`/api/threads/${thread.id}/interactions`, {
        method: "POST",
        body: {
          text: prompt,
          ...evalModelSelectionRequest(selectedModel, productModelSelection),
        },
      });
      const completedInteraction = await this.#waitForInteraction(thread.id, interaction.id);
      await this.#captureCandidateTrace(execution, completedInteraction);
      await afterTurn(interaction.id, offset + 1);
    }
    return thread;
  }

  async #judgeAcceptedTurn({ execution, thread, interaction, turn, reviewSequence, provenance = null }) {
    const judgeConfigurationId = execution.judgeConfiguration.name;
    const judgeResultId = randomUUID();
    const previousTurnIds = execution.turns
      .filter((candidate) => (
        String(candidate.threadId) === String(turn.threadId)
        && candidate.turnIndex < turn.turnIndex
      ))
      .map((candidate) => String(candidate.interactionId));
    const artifactDirectory = join(
      dirname(this.stateFile),
      "runs",
      encodeURIComponent(execution.testRunId),
      "executions",
      encodeURIComponent(execution.id),
      "turns",
      encodeURIComponent(String(interaction.id)),
      judgeConfigurationId,
      judgeResultId,
    );
    await mkdir(artifactDirectory, { recursive: true });
    const judgeResult = {
      schemaVersion: 1,
      id: judgeResultId,
      judge: judgeConfigurationId,
      status: "running",
      passed: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      artifactDirectory,
      artifactAuthority: "references",
      rubricVersion: GRAPH_PRESENTATION_RUBRIC_V10.rubricVersion,
      judgeConfiguration: copy(execution.judgeConfiguration),
      references: emptyJudgeReferences(),
      review: null,
      coverage: null,
      summary: null,
      error: null,
      ...(provenance === null ? {} : { provenance: copy(provenance) }),
    };
    turn.judgeResults.push(judgeResult);
    await this.#changed();

    try {
      const context = {
        schemaVersion: 1,
        artifactDirectory,
        execution: {
          id: execution.id,
          testRunId: execution.testRunId,
          testCaseId: execution.testCaseId,
          harnessConfigurationName: execution.harnessConfigurationName,
          harnessConfigurationDigest: execution.harnessConfigurationDigest,
        },
        thread: { id: String(thread.id) },
        turn: {
          id: String(interaction.id),
          turnIndex: turn.turnIndex,
          sequence: interaction.sequence,
          graphNodeId: interaction.graphNodeId,
          rootLayerId: interaction.completionOutput?.rootLayer?.layer?.id ?? null,
          status: interaction.completionStatus,
        },
        reviewSequence: copy(reviewSequence),
        request: {
          text: interaction.text,
          followUp: previousTurnIds.length > 0,
          previousTurnIds,
          comparisonTurnIds: previousTurnIds.slice(-1),
        },
        artifact: judgeArtifactForExecution(execution, turn),
        artifactEvidence: judgeArtifactEvidenceForExecution(execution, turn),
        rubric: copy(GRAPH_PRESENTATION_RUBRIC_V10),
        judgeConfiguration: copy(execution.judgeConfiguration),
        ...(provenance === null ? {} : { provenance: copy(provenance) }),
      };
      const output = await invokeSimulatedUserJudge(this.simulatedUserJudgeRunner, context);
      Object.assign(judgeResult, normalizeJudgeOutput(output, judgeResult));
    } catch (error) {
      judgeResult.status = "failed";
      judgeResult.passed = null;
      judgeResult.error = error instanceof Error ? error.message : String(error);
    }
    judgeResult.completedAt = new Date().toISOString();
    await this.#changed();
    return judgeResult;
  }

  async #waitForInteraction(threadId, interactionId) {
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      const detail = await this.#productRequest(`/api/threads/${threadId}`);
      const interaction = detail.interactions.find((candidate) => candidate.id === interactionId);
      if (!interaction) throw new Error(`Product interaction ${interactionId} disappeared.`);
      if (!["not_started", "running", "submitted"].includes(interaction.completionStatus)) return interaction;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    throw new Error(`Product interaction ${interactionId} did not finish within 10 minutes.`);
  }

  async #captureCandidateTrace(execution, interaction) {
    if (this.candidateTraceExporter === null) {
      execution.candidateTraceCaptures ||= {};
      execution.candidateTraceCaptures[String(interaction.id)] = disabledCandidateTrace();
      await this.#changed();
      return;
    }
    const ref = [
      "executions",
      encodeURIComponent(execution.id),
      "turns",
      encodeURIComponent(String(interaction.id)),
      "candidate-trace",
      "manifest.json",
    ].join("/");
    const targetDirectory = join(
      dirname(this.stateFile),
      "runs",
      encodeURIComponent(execution.testRunId),
      ...ref.split("/").slice(0, -1),
    );
    let pinnedPersonalPresentationVersionId;
    try {
      const candidate = await this.candidateTraceAttributionLoader?.(interaction.id);
      if (Number.isSafeInteger(candidate) && candidate > 0) {
        pinnedPersonalPresentationVersionId = candidate;
      }
    } catch {
      // Export remains authoritative when an optional pre-export lookup is unavailable.
    }
    try {
      const descriptor = await this.candidateTraceExporter(interaction.id, targetDirectory, {
        runId: execution.testRunId,
        executionId: execution.id,
        interactionId: String(interaction.id),
        harnessConfigurationName: execution.harnessConfigurationName,
        model: candidateModel(execution.harnessConfiguration),
      });
      execution.candidateTraceCaptures ||= {};
      execution.candidateTraceCaptures[String(interaction.id)] = {
        ...copy(descriptor),
        ...(descriptor.personalPresentationVersionId === undefined
          && pinnedPersonalPresentationVersionId !== undefined
          ? { personalPresentationVersionId: pinnedPersonalPresentationVersionId }
          : {}),
        ref,
        promotable: descriptor.status === "complete",
      };
    } catch (error) {
      const personalPresentationVersionId = error?.personalPresentationVersionId
        ?? pinnedPersonalPresentationVersionId;
      execution.candidateTraceCaptures ||= {};
      execution.candidateTraceCaptures[String(interaction.id)] = {
        status: "failed",
        format: "relayer-harness-trace-v1",
        coverage: emptyTraceCoverage(),
        ...(Number.isSafeInteger(personalPresentationVersionId) && personalPresentationVersionId > 0
          ? { personalPresentationVersionId }
          : {}),
        error: error instanceof Error ? error.message : String(error),
        ref: null,
        promotable: false,
      };
    }
    await this.#changed();
  }

  async #loadGraphOperations(execution, turn) {
    const descriptor = turn?.candidateTrace?.graphOperations;
    if (descriptor?.status !== "complete" || descriptor.format !== "relayer-graph-operations-v1"
      || descriptor.ref !== "graph-operations.jsonl" || descriptor.truncated !== false) {
      throw new Error("Candidate trace lacks a complete graph-operation ledger.");
    }
    const path = join(
      dirname(this.stateFile),
      "runs",
      encodeURIComponent(execution.testRunId),
      "executions",
      encodeURIComponent(execution.id),
      "turns",
      encodeURIComponent(String(turn.interactionId)),
      "candidate-trace",
      descriptor.ref,
    );
    const bytes = await readFile(path);
    if (bytes.byteLength !== descriptor.byteLength || sha256(bytes) !== descriptor.sha256) {
      throw new Error("Candidate trace graph-operation ledger failed digest validation.");
    }
    const lines = bytes.toString("utf8").split("\n").filter(Boolean);
    if (lines.length !== descriptor.eventCount) {
      throw new Error("Candidate trace graph-operation ledger event count does not match its descriptor.");
    }
    return lines.map((line) => {
      const event = JSON.parse(line);
      if (event?.schemaVersion !== 1 || !Number.isSafeInteger(event.sequence) || event.sequence < 1
        || event.interactionNodeId !== turn.graphNodeId || typeof event.method !== "string"
        || typeof event.path !== "string" || !Number.isSafeInteger(event.status)) {
        throw new Error("Candidate trace graph-operation ledger contains an invalid receipt.");
      }
      return event;
    });
  }

  async #productRequest(path, options = {}) {
    const response = await fetch(new URL(path, this.productSession.origin), {
      method: options.method || "GET",
      headers: {
        Accept: "application/json",
        Cookie: `${this.productSession.cookie.name}=${this.productSession.cookie.value}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value?.error || `Product request failed (${response.status}).`);
    return value;
  }

  async #changed() {
    await this.#persist();
    this.onChanged(this.listRuns());
  }

  #persist() {
    const serialized = `${JSON.stringify({ schemaVersion: 1, runs: this.runs }, null, 2)}\n`;
    const operation = this.persistTail.then(() => this.#writeState(serialized));
    this.persistTail = operation.catch(() => undefined);
    return operation;
  }

  async #writeState(serialized) {
    await mkdir(dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.stateFile);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async #writeRunBundle(run, durableStatus = run.status) {
    if (run.bundleRef) return;
    const bundleRef = ["runs", encodeURIComponent(run.id), "bundle.json"].join("/");
    const bundleFile = join(dirname(this.stateFile), ...bundleRef.split("/"));
    const bundle = {
      bundleSchemaVersion: 1,
      kind: "relayer_eval_run_bundle",
      testRunId: run.id,
      run: { ...copy(run), status: durableStatus, bundleRef },
    };
    await mkdir(dirname(bundleFile), { recursive: true });
    try {
      await writeFile(bundleFile, `${JSON.stringify(bundle, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = JSON.parse(await readFile(bundleFile, "utf8"));
      if (existing?.kind !== "relayer_eval_run_bundle" || existing?.testRunId !== run.id) {
        throw new Error(`Immutable Eval bundle conflicts with test run ${run.id}.`);
      }
    }
    run.bundleRef = bundleRef;
  }

  async #writeImportedJudgeArtifact(run, execution) {
    const artifactId = `judge-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
    const artifactRef = [
      "runs",
      encodeURIComponent(run.id),
      "judges",
      `${artifactId}.json`,
    ].join("/");
    const artifactFile = join(dirname(this.stateFile), ...artifactRef.split("/"));
    const temporary = `${artifactFile}.${process.pid}.${randomUUID()}.tmp`;
    const artifact = {
      schemaVersion: 1,
      kind: "relayer_imported_conversation_judge",
      id: artifactId,
      createdAt: new Date().toISOString(),
      runId: run.id,
      executionId: execution.id,
      judgeConfigurationName: run.judgeConfigurationName,
      source: {
        kind: "external-conversation-export",
        importId: run.importId,
        sourceSha256: run.sourceSha256,
        producer: copy(run.producer || {}),
        sourceRef: run.sourceRef,
        importBundleRef: run.bundleRef,
      },
      execution: copy(execution),
    };
    await mkdir(dirname(artifactFile), { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, artifactFile);
    } finally {
      await rm(temporary, { force: true });
    }
    run.judgeArtifacts ||= [];
    run.judgeArtifacts.push({
      id: artifactId,
      ref: artifactRef,
      judgeConfigurationName: run.judgeConfigurationName,
      createdAt: artifact.createdAt,
    });
    execution.latestJudgeArtifactRef = artifactRef;
  }
}

export async function stageBoundedSource(sourcePath, targetPath, limit, { afterOpen } = {}) {
  const source = await open(sourcePath, "r");
  let total = 0;
  try {
    const metadata = await source.stat();
    if (!metadata.isFile() || metadata.size > limit) {
      throw new Error("Conversation export exceeds the 256 MiB import limit.");
    }
    await afterOpen?.(source);
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        total += chunk.length;
        if (total > limit) {
          callback(new Error("Conversation export exceeds the 256 MiB import limit."));
        } else {
          callback(null, chunk);
        }
      },
    });
    await pipeline(
      source.createReadStream({ autoClose: false }),
      limiter,
      createWriteStream(targetPath, { flags: "wx", mode: 0o600 }),
    );
    return total;
  } catch (error) {
    await rm(targetPath, { force: true });
    throw error;
  } finally {
    await source.close();
  }
}

function importedRun(receipt, recovered = false) {
  const id = `import-${receipt.importId}`;
  const executionId = `execution-${receipt.importId}`;
  const title = receipt.header?.conversation?.title || "Imported conversation";
  const turns = (receipt.turns || []).map((turn, index) => ({
    threadId: receipt.threadId,
    interactionId: turn.interactionId,
    sourceTurnId: turn.sourceTurnId,
    turnIndex: index,
    prompt: null,
    status: turn.completionStatus,
    graphNodeId: turn.graphNodeId,
    rootLayerId: null,
    deterministicPassed: null,
    deterministicJudge: null,
    judgeEligible: turn.completionStatus === "accepted",
    judgeResults: [],
    candidateTrace: null,
  }));
  return {
    schemaVersion: 1,
    kind: "imported-conversation",
    importId: receipt.importId,
    sourceSha256: receipt.sourceSha256,
    producer: copy(receipt.header?.producer || {}),
    origin: {
      kind: "external-conversation-export",
      importId: receipt.importId,
      sourceSha256: receipt.sourceSha256,
    },
    id,
    title,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    bundleRef: recovered ? ["runs", encodeURIComponent(id), "bundle.json"].join("/") : null,
    sourceRef: recovered ? ["runs", encodeURIComponent(id), "conversation.jsonl"].join("/") : null,
    status: "imported",
    testCaseIds: [],
    harnessConfigurationNames: [],
    judgeConfigurationName: null,
    executions: [{
      kind: "imported-conversation",
      id: executionId,
      testRunId: id,
      testCaseId: "external-conversation",
      harnessConfigurationName: null,
      harnessConfiguration: null,
      harnessConfigurationDigest: null,
      judgeConfiguration: null,
      origin: {
        kind: "external-conversation-export",
        importId: receipt.importId,
        sourceSha256: receipt.sourceSha256,
      },
      status: "imported",
      threadIds: [receipt.threadId],
      turns,
      checks: [],
      passed: null,
      promotable: false,
      error: null,
      title,
    }],
  };
}

function importedJudgeProvenance(run, turn) {
  return {
    kind: "external-conversation-export",
    importId: run.importId,
    sourceSha256: run.sourceSha256,
    sourceTurnId: turn.sourceTurnId,
    producer: copy(run.producer || {}),
  };
}

function emptyTraceCoverage() {
  return {
    prompt: "none",
    messages: "none",
    reasoningSummaries: "none",
    modelCalls: "none",
    toolCalls: "none",
    usage: "none",
    childStreams: "none",
    nativeArtifacts: "none",
  };
}

function disabledCandidateTrace() {
  return {
    status: "disabled",
    format: "relayer-harness-trace-v1",
    coverage: emptyTraceCoverage(),
    ref: null,
    promotable: true,
  };
}

function candidateModel(configuration) {
  const model = configuration?.settings?.model;
  if (typeof model === "string") return model;
  if (model && typeof model.provider === "string" && typeof model.id === "string") return `${model.provider}/${model.id}`;
  return undefined;
}

function validateEvalPermissionProfiles(execution) {
  if (!projectCaseIds.has(execution.testCaseId)) {
    selectStandalonePermissionProfile(execution.harnessConfiguration);
    return;
  }
  const definition = evalCases.find((candidate) => candidate.id === execution.testCaseId);
  for (const thread of definition.threads) {
    resolveH3PermissionProfile(execution.harnessConfiguration, thread.permissionProfileId);
  }
}

export function resolveH3PermissionProfile(configuration, requestedProfileId) {
  const profiles = Object.keys(configuration.permissionBindings);
  if (profiles.includes(requestedProfileId)) {
    return {
      requestedProfileId,
      effectiveProfileId: requestedProfileId,
      overridden: false,
      reason: null,
    };
  }
  if (requestedProfileId === "ask" && profiles.length === 1 && profiles[0] === "full") {
    return {
      requestedProfileId,
      effectiveProfileId: "full",
      overridden: true,
      reason: "Harness supports only Full access; the local Eval fixture is disposable and the unrestricted authority is recorded.",
    };
  }
  throw new Error(
    `Eval case ${H3_PROJECT_CASE_ID} requests permission profile ${requestedProfileId}, which is not supported by ${configuration.name}. Only an Ask-profile case may explicitly fall back to a sole Full access binding; evaluator-owned verifier cases require confined authority.`,
  );
}

async function invokeSimulatedUserJudge(runner, context) {
  if (typeof runner === "function") return runner(copy(context));
  if (runner && typeof runner.run === "function") return runner.run(copy(context));
  throw new Error("Simulated-user judge runner must be a function or expose run(context).");
}

function normalizeJudgeOutput(output, initial) {
  if (!output || !["completed", "partial", "failed"].includes(output.status)) {
    return {
      status: "failed",
      passed: null,
      error: "Simulated-user judge returned an invalid status.",
    };
  }
  const references = {
    rubric: optionalReference(output.rubricRef),
    configuration: optionalReference(output.configurationRef),
    interactionTrace: optionalReference(output.interactionTraceRef),
    screenshots: Array.isArray(output.screenshotRefs)
      ? output.screenshotRefs.filter((reference) => typeof reference === "string" && reference.length > 0)
      : [],
    reviews: optionalReference(output.reviewRef),
    coverage: optionalReference(output.coverageRef),
  };
  const requiredReferences = [
    references.rubric,
    references.configuration,
    references.interactionTrace,
    references.reviews,
    references.coverage,
  ];
  const completeReferences = requiredReferences.every((reference) => reference !== null)
    && references.screenshots.length > 0;
  const requestedStatus = output.status;
  const status = requestedStatus === "completed" && !completeReferences ? "partial" : requestedStatus;
  const missingReferenceError = requestedStatus === "completed" && !completeReferences
    ? "Completed simulated-user review omitted one or more immutable artifact references."
    : null;
  return {
    status,
    // Completion is lifecycle state, not a hidden presentation-quality pass.
    passed: null,
    rubricVersion: initial.rubricVersion,
    judgeConfiguration: copy(initial.judgeConfiguration),
    references,
    review: output.review && typeof output.review === "object" ? copy(output.review) : null,
    coverage: output.coverage && typeof output.coverage === "object" ? copy(output.coverage) : null,
    summary: typeof output.summary === "string" ? output.summary : null,
    error: missingReferenceError
      ?? (typeof output.error === "string" && output.error.length > 0
        ? output.error
        : status === "partial" ? "Simulated-user review ended without finalization."
          : status === "failed" ? "Simulated-user judge reported failure."
            : null),
  };
}

function optionalReference(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function emptyJudgeReferences() {
  return {
    rubric: null,
    configuration: null,
    interactionTrace: null,
    screenshots: [],
    reviews: null,
    coverage: null,
  };
}
