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
  GRAPH_PRESENTATION_RUBRIC_V11,
  expandTestRun,
  gradeH3Workspace,
  gradeFrontierProjectWorkspace,
  H3_AUTONOMOUS_FIX_CASE_ID,
  H3_AUTONOMOUS_FIX_MULTI_TURN_CASE_ID,
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
  graphMemorySearchRequestMode,
  checkGraphMemoryFirstTurn,
  checkGraphMemorySecondTurn,
  readGraphMemoryEvidence,
  materializeFrontierProjectFixture,
  materializeH3ProjectFixture,
  projectDeterministicChecksToOutcome,
  recursiveCompleteEvalCase,
  RECURSIVE_COMPLETE_EVAL_CASE_ID,
  recursiveGraphMemoryEvalCase,
  RECURSIVE_GRAPH_MEMORY_CASE_ID,
  RECURSIVE_GRAPH_MEMORY_HARNESS_QUARTET,
  selectStandalonePermissionProfile,
  isSteeredMultiTurn,
  steeredMaxHumanTurns,
  parseSteeringDecision,
  requireSingleOpeningPrompt,
  resolvePublishedCurrentTarget,
  runSteeredInteractionLoop,
  summarizePublishedCurrent,
} from "@relayer/eval-runner";
import { loadHarnessConfigurations } from "@relayer/harness-host";
import { firstAvailableSelection, harnessUsesConfigurationModel } from "../renderer/src/model-picker-model.js";
import { RECURSIVE_TEMPORAL_FEATURES } from "../main/services/graphcomplete-runtime.mjs";
import {
  buildAcceptedReviewTopology,
  gradeAcceptedReviewTopology,
} from "./simulated-user-judge.mjs";
import { GRAPH_SEARCH_EVAL_TARGET } from "./configuration-paths.mjs";

export const evalCases = Object.freeze([
  Object.freeze({
    id: graphMemoryEvalCaseId,
    name: "Graph memory · prior accepted reference",
    description: "Searches a prior accepted layer in a second turn and retains the typed reference in one real product thread.",
    defaultSelected: false,
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
  recursiveCompleteEvalCase,
  Object.freeze({
    id: "empty-project.node-input-roundtrip.single-turn",
    name: "Node input · authored round trip",
    description: "Asks the model to author text, single-select, and multi-select inputs, then lets the simulated user answer all three through the product.",
    prompts: Object.freeze([
      "Help me prepare a deployment plan. Before planning, I still need to supply the exact deployment window, choose either Canary or Full rollout, and choose at least two validation signals from Health metrics, Logs, and Synthetic checks. Do not make those decisions for me. Ask for the three decisions together and wait for my response. Once I respond, produce a concise deployment plan that names and visibly applies the exact window, selected strategy, and each selected validation signal.",
    ]),
    requiredChecks: Object.freeze(["input-roundtrip"]),
    requiredJudgeConfigurationIds: Object.freeze(["simulated-user", "simulated-user-sol-high"]),
  }),
  Object.freeze({
    ...recursiveGraphMemoryEvalCase,
    gradeExecution: gradeRecursiveGraphMemoryExecution,
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
    first.completionOutput,
    second.completionOutput,
    auditEvents,
    secondTurnStartSequence,
  );
  const deterministicFixture = execution.harnessConfiguration?.implementation === "fixture.graph-memory";
  return {
    turns: [
      { checks: checkGraphMemoryFirstTurn(first.completionOutput, first.graphNodeId) },
      {
        checks: checkGraphMemorySecondTurn(second.completionOutput, first.completionOutput, evidence, second.graphNodeId, {
          requireDraftDecoy: deterministicFixture,
          searchRequestMode: graphMemorySearchRequestMode(execution.harnessConfiguration.implementation),
        }),
        evidence,
      },
    ],
  };
}

export async function gradeRecursiveGraphMemoryExecution({ execution, interactions, loadGraphOperations }) {
  if (interactions.length !== 3) {
    throw new Error("Recursive graph-memory grading requires exactly three product turns.");
  }
  const productTurns = interactions.map(({ interaction }) => interaction);
  if (productTurns.some((interaction) => !interaction.completionOutput)) {
    throw new Error("Recursive graph-memory grading requires three completed graph outputs.");
  }
  const eventSets = await Promise.all(execution.turns.map((turn) => loadGraphOperations(turn)));
  const roots = productTurns.map((interaction) => interaction.completionOutput.rootLayer.layer.id);
  const priorTopics = ["Offline recovery covenant", "Constrained recovery revision"];
  const searchEnabled = execution.harnessConfiguration?.graphCapabilityProfile?.search === "query-v1";
  const recursionEnabled = execution.harnessConfiguration?.complete?.agentAuthored === true;
  const turns = productTurns.map((interaction, index) => {
    const output = interaction.completionOutput;
    const checks = [
      ...checkBasicOutput(output, interaction.graphNodeId),
      {
        name: "completion-broker-authority",
        passed: execution.turns[index]?.candidateTrace?.completionBrokerAvailable === recursionEnabled,
        detail: `Recursion is ${recursionEnabled ? "enabled" : "disabled"}; the portable Candidate Trace must record matching agent-authored Complete authority.`,
      },
    ];
    const requiredHeading = priorTopics[index];
    if (requiredHeading !== undefined) {
      checks.push({
        name: "requested-decision-section",
        passed: output.rootLayer.nodes.filter((node) => node.title === requiredHeading).length === 1,
        detail: `Turn ${index + 1} must retain exactly one requested “${requiredHeading}” decision section in its accepted root.`,
      });
    }
    if (index === 0) return { checks };

    const events = eventSets[index];
    const searches = events.filter((event) => (
      event.method === "POST"
      && event.path === "/api/graph/search"
      && event.status >= 200
      && event.status < 300
    ));
    const requiredPriorRoots = index === 1 ? [roots[0]] : [roots[0], roots[1]];
    const acceptedReferences = output.rootLayer.actions.filter((action) => (
      action.state === "accepted"
      && action.kind === "navigate"
      && action.relation === "reference"
      && action.sourceLayerId === output.rootLayer.layer.id
      && requiredPriorRoots.includes(action.targetLayerId)
    ));
    const acknowledgement = events.filter((event) => (
      event.method === "POST"
      && (event.path === "/api/graph/submit" || event.path === "/api/graph/current/transitions")
      && event.status >= 200
      && event.status < 300
      && (event.path !== "/api/graph/submit" || event.completionNodeId === output.nodeId)
    )).at(-1);
    const evidenceByRoot = requiredPriorRoots.map((root, rootIndex) => {
      const search = searches.find((event) => matchesBoundedPriorWorkSearch(
        event,
        priorTopics[rootIndex],
        root,
      ));
      const acceptedReference = acceptedReferences.find((action) => action.targetLayerId === root);
      const referenceEvent = acceptedReference === undefined ? undefined : events.find((event) => (
        event.method === "POST"
        && event.path === "/api/graph/actions"
        && event.status >= 200
        && event.status < 300
        && event.recordId === acceptedReference.id
        && event.actionKind === acceptedReference.kind
        && event.actionRelation === acceptedReference.relation
        && event.actionSourceNodeId === acceptedReference.sourceNodeId
        && event.actionSourceLayerId === acceptedReference.sourceLayerId
        && event.actionTargetLayerId === acceptedReference.targetLayerId
      ));
      return { root, search, acceptedReference, referenceEvent };
    });
    const matchedSearches = evidenceByRoot.map(({ search }) => search).filter(Boolean);
    const exactSearchSet = matchedSearches.length === searches.length
      && new Set(matchedSearches).size === searches.length;
    const searchedLayerIds = evidenceByRoot.flatMap(({ search }) => search?.searchLayerIds || []);
    if (searchEnabled) {
      checks.push({
        name: "prior-work-search",
        passed: exactSearchSet && evidenceByRoot.every(({ search }) => search !== undefined),
        detail: `Follow-up ${index} must use bounded parameterized search to recover ${requiredPriorRoots.length} required prior accepted root${requiredPriorRoots.length === 1 ? "" : "s"}.`,
      }, {
        name: "prior-work-references",
        passed: evidenceByRoot.every(({ acceptedReference, referenceEvent }) => (
          acceptedReference !== undefined && referenceEvent !== undefined
        )),
        detail: "Every required searched root must remain attached to the accepted follow-up as typed supporting context.",
      }, {
        name: "search-reference-submit-order",
        passed: acknowledgement !== undefined && evidenceByRoot.every(({ search, referenceEvent }) => (
          search !== undefined
          && referenceEvent !== undefined
          && search.sequence < referenceEvent.sequence
          && referenceEvent.sequence < acknowledgement.sequence
        )),
        detail: "Candidate Trace must show successful search before the matching accepted references and final acknowledgement.",
      });
    } else {
      checks.push({
        name: "graph-search-disabled",
        passed: searches.length === 0,
        detail: `Search is disabled for this cell; observed ${searches.length} successful graph-search operation${searches.length === 1 ? "" : "s"}.`,
      });
    }
    if (index === 2) {
      const allChildren = execution.semanticChildren || [];
      const finalChildren = allChildren.filter((child) => (
        String(child.sourceInteractionId) === String(interaction.id)
      ));
      const attachedFinalChildren = finalChildren.filter((child) => output.rootLayer.actions.some((action) => (
        action.state === "accepted"
        && action.kind === "invoke"
        && action.id === child.sourceActionId
        && action.sourceLayerId === output.rootLayer.layer.id
        && action.targetLayerId === child.rootLayerId
      )));
      const childStopConditions = finalChildren.flatMap((child) => (
        child.acceptedRootNodes || []
      )).filter((node) => node.title === "Red-team stop condition" && node.detail.trim() !== "");
      const parentStopConditions = output.rootLayer.nodes.filter((node) => (
        node.title === "Red-team stop condition" && node.detail.trim() !== ""
      ));
      checks.push({
        name: "final-red-team-stop-condition",
        passed: parentStopConditions.length === 1,
        detail: "Every cell must expose exactly one falsifiable Red-team stop condition in the final accepted memo.",
      });
      if (recursionEnabled) {
        checks.push({
          name: "semantic-child-observation",
          passed: true,
          detail: `Recursion was available; observed ${allChildren.length} descendant execution${allChildren.length === 1 ? "" : "s"}, ${finalChildren.length} from the final turn. Child creation remains observed behavior.`,
        }, {
          name: "final-child-attached",
          passed: attachedFinalChildren.length === finalChildren.length,
          detail: "Any claimed final specialist contribution must retain its settled result through an exact action-bound resolved invoke.",
        }, {
          name: "child-result-text-aligned",
          passed: finalChildren.length === 0 || (childStopConditions.some((child) => (
            parentStopConditions.length === 1 && child.detail === parentStopConditions[0].detail
          ))
          ),
          detail: "The final memo and specialist result must expose the same falsifiable stop condition. This is semantic alignment evidence, not broker-delivery proof.",
        });
      } else {
        const resolvedInvokes = productTurns.flatMap((turn) => turn.completionOutput.rootLayer.actions).filter((action) => (
          action.state === "accepted"
          && action.kind === "invoke"
          && action.targetLayerId !== null
          && action.targetLayerId !== undefined
        ));
        checks.push({
          name: "recursion-disabled-no-semantic-child",
          passed: allChildren.length === 0,
          detail: `Recursion is disabled for this cell; observed ${allChildren.length} semantic child execution${allChildren.length === 1 ? "" : "s"}.`,
        }, {
          name: "recursion-disabled-no-resolved-invoke",
          passed: resolvedInvokes.length === 0,
          detail: `Recursion is disabled for this cell; observed ${resolvedInvokes.length} accepted resolved invoke action${resolvedInvokes.length === 1 ? "" : "s"}.`,
        });
      }
    }
    return {
      checks,
      evidence: {
        successfulSearchCount: searches.length,
        searchedLayerIds,
        requiredPriorRoots,
        referenceActionIds: evidenceByRoot.map(({ referenceEvent }) => referenceEvent?.recordId).filter(Number.isSafeInteger),
      },
    };
  });
  return { turns };
}

function matchesBoundedPriorWorkSearch(event, topic, rootLayerId) {
  if (event.queryContractVersion !== 1
    || event.target !== undefined
    || event.resultTruncated !== false
    || typeof event.query !== "string"
    || event.parameters === null
    || typeof event.parameters !== "object"
    || Array.isArray(event.parameters)
    || (event.budget !== undefined && (
      event.budget === null
      || typeof event.budget !== "object"
      || Array.isArray(event.budget)
    ))
    || !Array.isArray(event.searchLayerIds)
    || event.searchLayerIds.length !== 1
    || event.searchLayerIds[0] !== rootLayerId) return false;
  const parameterEntries = Object.entries(event.parameters);
  if (parameterEntries.length !== 1) return false;
  const [parameterName, parameter] = parameterEntries[0];
  if (parameter === null
    || typeof parameter !== "object"
    || Array.isArray(parameter)
    || parameter.type !== "string"
    || parameter.value !== topic) return false;
  const escapedName = parameterName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const resultRows = event.budget?.resultRows;
  return (resultRows === undefined || (
    Number.isSafeInteger(resultRows)
    && resultRows >= 1
    && resultRows <= 5
  ))
    && isNaturalPriorWorkQueryShape(event.query, escapedName);
}

function isNaturalPriorWorkQueryShape(query, escapedParameterName) {
  const identifier = "[A-Za-z_][A-Za-z0-9_]*";
  const layer = `(?<layer>${identifier})`;
  const content = `(?<content>${identifier})`;
  const relationship = `\\[\\s*(?:${identifier}\\s*)?:\\s*CONTAINS(?:\\s*\\{[^}]*\\})?\\s*\\]`;
  const contains = `\\s*-\\s*${relationship}\\s*->\\s*`;
  const containedBy = `\\s*<-\\s*${relationship}\\s*-\\s*`;
  const layerNode = `\\(\\s*${layer}\\s*:\\s*Layer\\s*\\)`;
  const contentNode = `\\(\\s*${content}\\s*:\\s*Content\\s*\\)`;
  const titleProperty = "\\k<content>\\s*\\.\\s*title";
  const parameter = `\\$${escapedParameterName}`;
  const predicate = `\\s+WHERE\\s+(?:${titleProperty}\\s*=\\s*${parameter}|${parameter}\\s*=\\s*${titleProperty})`;
  const projection = `\\s+RETURN\\s+(?:DISTINCT\\s+)?\\k<layer>(?:\\s+AS\\s+${identifier})?`;
  const orderingExpression = `${identifier}(?:\\s*\\.\\s*${identifier})?`;
  const ordering = `(?:\\s+ORDER\\s+BY\\s+${orderingExpression}(?:\\s+(?:ASC|DESC))?)?`;
  const limit = "(?:\\s+LIMIT\\s+[1-8])?\\s*;?\\s*$";
  const pathBinding = `(?:${identifier}\\s*=\\s*)?`;
  const forward = new RegExp(`^\\s*MATCH\\s+${pathBinding}${layerNode}${contains}${contentNode}${predicate}${projection}${ordering}${limit}`, "iu");
  const reverse = new RegExp(`^\\s*MATCH\\s+${pathBinding}${contentNode}${containedBy}${layerNode}${predicate}${projection}${ordering}${limit}`, "iu");
  return forward.test(query) || reverse.test(query);
}

const h3CaseIds = new Set([
  H3_PROJECT_CASE_ID,
  H3_AUTONOMOUS_FIX_CASE_ID,
  H3_AUTONOMOUS_FIX_MULTI_TURN_CASE_ID,
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
const IN_PROGRESS_COMPLETION_STATUSES = new Set([
  "not_started", "running", "submitted", "preparing", "draft", "waiting_for_approval",
]);
const MAX_CONVERSATION_IMPORT_BYTES = 256 * 1024 * 1024;
const ANNOTATION_EXPORT_EXECUTION_STATUSES = new Set(["passed", "failed", "imported"]);
const ANNOTATION_EXPORT_TURN_STATUSES = new Set(["accepted", "failed", "stopped"]);
const SEMANTIC_CHILD_DISCOVERY_TIMEOUT_MS = 5_000;
const execFileAsync = promisify(execFile);

export function semanticChildDiscoveryObservation({
  previousSignature = null,
  stableSince,
  signature,
  now,
  discoveryDeadline,
  boundedObservation = true,
}) {
  const nextStableSince = signature === previousSignature ? stableSince : now;
  return {
    signature,
    stableSince: nextStableSince,
    stable: !boundedObservation || (
      now >= discoveryDeadline
      && now - nextStableSince >= SEMANTIC_CHILD_DISCOVERY_TIMEOUT_MS
    ),
  };
}

export function semanticChildDiscoveryIsBounded(harnessConfiguration) {
  return typeof harnessConfiguration?.complete?.agentAuthored === "boolean";
}

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

function recursiveGraphMemoryOutcomeGrade() {
  return {
    schemaVersion: 1,
    kind: "task_outcome_grade",
    status: "unjudged",
    qualified: null,
    score: null,
    mandatoryGates: [],
    criteria: [
      "Prior-work retention across all three turns",
      "Constraint revision and identification of the failed assumption",
      "Five ranked launch risks",
      "Measurable launch, rollback, and stop thresholds with six-week owners",
      "Specialist contribution when one was actually created",
    ].map((label, index) => ({
      criterionId: `lantern-outcome-${index + 1}`,
      label,
      rating: null,
      weight: 1,
      rationale: "Compare this visible accepted result in the read-only product workspace; mechanism checks do not judge answer quality.",
      evidenceRefs: [],
    })),
    reviewRequired: true,
  };
}

function descendantInvocations(detail, rootInteractionIds) {
  const reachable = new Set(rootInteractionIds.map(String));
  const selected = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const invocation of detail.actionInvocations || []) {
      if (!reachable.has(String(invocation.sourceInteractionId))) continue;
      if (selected.some((candidate) => (
        String(candidate.sourceInteractionId) === String(invocation.sourceInteractionId)
        && String(candidate.actionId) === String(invocation.actionId)
        && String(candidate.resultInteractionId) === String(invocation.resultInteractionId)
      ))) continue;
      selected.push(invocation);
      if (!reachable.has(String(invocation.resultInteractionId))) {
        reachable.add(String(invocation.resultInteractionId));
        changed = true;
      }
    }
  }
  return selected;
}

function combinedComparisonConfigurationIdentity(configuration) {
  const normalized = copy(configuration);
  delete normalized.name;
  delete normalized.complete;
  delete normalized.settings?.personalPresentationVersion;
  return canonicalJson(normalized);
}

function recursiveGraphMemoryConfigurationIdentity(configuration) {
  const normalized = copy(configuration);
  delete normalized.name;
  delete normalized.complete;
  delete normalized.graphCapabilityProfile;
  return canonicalJson(normalized);
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

export function recursiveCompleteChecks(execution, { requireChildWhenEnabled = true } = {}) {
  const enabled = execution.harnessConfiguration?.complete?.agentAuthored === true;
  const root = execution.turns[0];
  const children = execution.semanticChildren || [];
  const observedBroker = root?.candidateTrace?.completionBrokerAvailable;
  const checks = [{
    name: "agent-authored-complete:broker-authority",
    passed: observedBroker === enabled,
    detail: `Configuration requested agent-authored Complete ${enabled ? "enabled" : "disabled"}; root trace recorded broker authority ${String(observedBroker)}.`,
  }, {
    name: "agent-authored-complete:semantic-child-count",
    passed: enabled ? (!requireChildWhenEnabled || children.length > 0) : children.length === 0,
    detail: enabled
      ? requireChildWhenEnabled
        ? `Expected at least one agent-authored semantic child within the ${SEMANTIC_CHILD_DISCOVERY_TIMEOUT_MS} ms post-root discovery window; observed ${children.length}.`
        : `Agent-authored Complete was available; child creation remains observed behavior and ${children.length} semantic child execution${children.length === 1 ? " was" : "s were"} recorded.`
      : `Expected no semantic children without broker authority; observed ${children.length}.`,
  }];
  if (!enabled) return checks;
  checks.push({
    name: "agent-authored-complete:child-provenance",
    passed: children.every((child) => (
      Number.isSafeInteger(child.sourceInteractionId)
      && Number.isSafeInteger(child.sourceActionId)
      && Number.isSafeInteger(child.interactionId)
      && Number.isSafeInteger(child.graphNodeId)
    )),
    detail: "Every semantic child must retain the exact source interaction, action, product interaction, and graph completion identities.",
  }, {
    name: "agent-authored-complete:child-terminal",
    passed: children.length === 0 ? !requireChildWhenEnabled : children.every(childHasAcceptedResultSequence),
    detail: "Every semantic child must publish a current layer and settle as an accepted succeeded result with an ordered durable projection sequence.",
  }, {
    name: "agent-authored-complete:child-execution",
    passed: children.length === 0 ? !requireChildWhenEnabled : children.every((child) => childHasDurableExecution(
      child,
      execution.harnessConfiguration,
      execution.harnessConfigurationDigest,
    )),
    detail: "Every semantic child must retain an exact attached and successfully settled provider execution binding.",
  }, {
    name: "agent-authored-complete:child-trace",
    passed: children.length === 0 ? !requireChildWhenEnabled : children.every((child) => (
      child.candidateTrace?.status === "complete"
      && child.candidateTrace?.completionBrokerAvailable === true
    )),
    detail: "Every semantic child must have a complete portable candidate trace that records nested completion-broker authority.",
  });
  return checks;
}

function childHasAcceptedResultSequence(child) {
  const observations = [...(child.projectionObservations || [])]
    .sort((left, right) => left.sequence - right.sequence);
  const activeRoot = observations.find((observation) => (
    observation.revision === 0 && observation.lifecycle === "active"
  ));
  const published = observations.find((observation) => (
    observation.revision >= 1
    && observation.lifecycle === "active"
    && Number.isSafeInteger(observation.currentLayerId)
  ));
  const terminal = observations.at(-1);
  return child.status === "accepted"
    && child.resultCompletionStatus === "accepted"
    && Number.isSafeInteger(child.rootLayerId)
    && activeRoot !== undefined
    && published !== undefined
    && terminal?.lifecycle === "succeeded"
    && terminal.currentLayerId === child.rootLayerId
    && observations.every((observation, index) => {
      if (index === 0) {
        return observation.revision === 0 && observation.previousRevision === null;
      }
      const previous = observations[index - 1];
      return observation.sequence > previous.sequence
        && observation.revision === previous.revision + 1
        && observation.previousRevision === previous.revision;
    });
}

function expectedAttachmentProvider(configuration) {
  if (configuration?.implementation === "codex.basic") return "codex";
  if (configuration?.implementation === "claude.basic") return "claude";
  if (configuration?.implementation === "prime.agent") return "prime-agent";
  if (configuration?.implementation === "fixture.task-system") return "fixture";
  return null;
}

function childHasDurableExecution(child, configuration, configurationDigest) {
  const evidence = child.execution;
  const expectedProvider = expectedAttachmentProvider(configuration);
  return evidence?.interactionId === child.interactionId
    && evidence?.graphCompletionId === child.graphNodeId
    && evidence?.harnessConfigurationName === configuration?.name
    && evidence?.harnessConfigurationDigest === configurationDigest
    && typeof evidence?.modelExecutionDigest === "string"
    && evidence.modelExecutionDigest.startsWith("sha256:")
    && evidence?.phase === "settled"
    && evidence?.attached === true
    && evidence?.attachmentSchemaVersion === 1
    && evidence?.attachmentProvider === expectedProvider
    && evidence?.settled === true
    && evidence?.safeReason === null
    && evidence?.settlementNodeId === child.graphNodeId
    && evidence?.settlementRootLayerId === child.rootLayerId;
}

export async function validateCandidateTrace(directory, descriptor, interaction, correlation, { requireComplete = false } = {}) {
  const eventsBytes = await readFile(join(directory, "events.jsonl"));
  const eventLines = eventsBytes.toString("utf8").trim().split("\n").filter(Boolean);
  const events = eventLines.map((line) => JSON.parse(line));
  const eventsSha256 = `sha256:${createHash("sha256").update(eventsBytes).digest("hex")}`;
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  const eventsArtifact = manifest?.artifacts?.events;
  const declaredCoverage = manifest?.declaredCoverage || {};
  const achievedCoverage = manifest?.achievedCoverage || {};
  const declaredCoverageSatisfied = Object.entries(declaredCoverage).every(([feature, level]) => (
    level !== "full" || achievedCoverage[feature] === "full"
  ));
  const failures = [
    [!requireComplete || descriptor.status === "complete", "descriptor-status"],
    [!requireComplete || descriptor.truncated !== true, "not-truncated"],
    [descriptor.sha256 === eventsSha256, "descriptor-sha"],
    [descriptor.byteLength === eventsBytes.byteLength, "descriptor-bytes"],
    [descriptor.eventCount === eventLines.length, "descriptor-events"],
    [manifest?.schemaVersion === 1, "manifest-schema"],
    [manifest?.format === descriptor.format, "manifest-format"],
    [manifest?.status === descriptor.status, "manifest-status"],
    [manifest?.traceId === descriptor.traceId, "manifest-trace"],
    [manifest?.productInteractionId === interaction.id, "product-interaction"],
    [manifest?.interactionNodeId === interaction.graphNodeId, "graph-completion"],
    [Object.entries(correlation).every(([key, value]) => manifest?.correlation?.[key] === value), "correlation"],
    [eventsArtifact?.ref === "events.jsonl", "event-ref"],
    [eventsArtifact?.sha256 === eventsSha256, "event-sha"],
    [eventsArtifact?.byteLength === eventsBytes.byteLength, "event-bytes"],
    [eventsArtifact?.eventCount === eventLines.length, "event-count"],
    [!requireComplete || declaredCoverageSatisfied, "declared-coverage"],
  ].filter(([passed]) => !passed).map(([, name]) => name);
  if (failures.length > 0) {
    throw new Error(`Candidate trace ${interaction.id} failed integrity checks: ${failures.join(", ")}.`);
  }
  const scopeEvents = events.filter((event) => event.type === "execution.scope");
  const marker = scopeEvents[0]?.data?.completionBrokerAvailable;
  if (scopeEvents.length !== 1 || typeof marker !== "boolean") {
    throw new Error(`Candidate trace ${interaction.id} did not record exactly one valid broker-scope marker.`);
  }
  return marker;
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
    [2, 3, 4, 5, 6].includes(result.review?.schemaVersion)
    && ["recursive-presentation-judge-v2", "recursive-presentation-judge-v3", "recursive-presentation-judge-v4", "recursive-presentation-judge-v5", "recursive-presentation-judge-v6"].includes(result.review?.contractId)
  ));
  if (recursive) {
    const contractIds = [...new Set(completed.map((result) => result.review.contractId))].sort();
    if (contractIds.includes("recursive-presentation-judge-v6") && contractIds.length > 1) {
      return {
        ...buildRecursiveGraphPresentationGrade({ status: "partial", scoreScaleMaximum: 8 }),
        comparability: {
          status: "incompatible",
          contractIds,
          reason: "Rubric v11 changes input-action judgment and cannot be aggregated with earlier recursive contracts.",
        },
      };
    }
    const scales = completed.map((result) => [5, 6].includes(result.review?.schemaVersion) ? 8 : 4);
    const scoreScaleMaximum = scales.includes(8) ? 8 : 4;
    const turnScore = (result, criterion) => {
      const scale = [5, 6].includes(result.review?.schemaVersion) ? 8 : 4;
      const score = scale === 8
        ? result.review?.turn?.criterionJudgments?.[criterion]?.score ?? null
        : result.review?.turn?.ratings?.[criterion] ?? null;
      return score !== null && scale !== scoreScaleMaximum
        ? score * (scoreScaleMaximum / scale)
        : score;
    };
    const scoreCeiling = (result) => {
      const maximum = result.review?.turn?.scoreCeiling?.maximum;
      const scale = [5, 6].includes(result.review?.schemaVersion) ? 8 : 4;
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
    steeringDecisionRunner = null,
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
    targetKey = null,
  }) {
    this.stateFile = stateFile;
    this.productSession = productSession;
    this.configurationPaths = configurationPaths;
    this.onChanged = onChanged;
    this.simulatedUserJudgeRunner = simulatedUserJudgeRunner;
    this.steeringDecisionRunner = steeringDecisionRunner;
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
    this.targetKey = targetKey;
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
        complete: copy(configuration.complete ?? { agentAuthored: false }),
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
      const traceCandidates = [...(execution.turns || []), ...(execution.semanticChildren || [])];
      const turn = interactionId === undefined || interactionId === null
        ? execution.turns[0]
        : traceCandidates.find((candidate) => String(candidate.interactionId) === String(interactionId));
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
          semanticChildren: copy(execution.semanticChildren || []),
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
    const incompatibleJudgeCase = evalCases.find((item) => (
      testCaseIds.includes(item.id)
      && Array.isArray(item.requiredJudgeConfigurationIds)
      && !item.requiredJudgeConfigurationIds.includes(judgeConfigurationName)
    ));
    if (incompatibleJudgeCase) {
      throw new Error("Selected cases require a compatible simulated-user judge configuration.");
    }
    const selectsGraphSearch = Array.isArray(harnessConfigurationNames)
      && harnessConfigurationNames.some((name) => (
        this.configurations.get(name)?.graphCapabilityProfile?.search === "query-v1"
      ));
    if (selectsGraphSearch && this.targetKey !== GRAPH_SEARCH_EVAL_TARGET) {
      throw new Error("Graph-search Eval treatments are qualified only for macOS Apple Silicon.");
    }
    if (testCaseIds.includes(RECURSIVE_COMPLETE_EVAL_CASE_ID)) {
      const comparison = evalCases.find((item) => item.id === RECURSIVE_COMPLETE_EVAL_CASE_ID);
      if (!sameJson(testCaseIds, [RECURSIVE_COMPLETE_EVAL_CASE_ID])
        || !sameJson(harnessConfigurationNames, comparison.requiredHarnessConfigurationNames)) {
        throw new Error(`The agent-authored Complete comparison must run alone with its exact ordered Codex pair: ${comparison.requiredHarnessConfigurationNames.join(", ")}.`);
      }
      const pair = comparison.requiredHarnessConfigurationNames.map((name) => (
        this.configurations.get(name)
      ));
      if (pair.some((configuration) => configuration === undefined)
        || pair[0]?.complete?.agentAuthored !== false
        || pair[1]?.complete?.agentAuthored !== true
        || pair[0]?.settings?.personalPresentationVersion !== "personal-presentation-v1"
        || pair[1]?.settings?.personalPresentationVersion !== "personal-presentation-v2"
        || combinedComparisonConfigurationIdentity(pair[0]) !== combinedComparisonConfigurationIdentity(pair[1])) {
        throw new Error("The visible-working-state recursive configurations differ outside their approved V1/off and V2/on experience pair.");
      }
      const liveProviderExecutions = pair.filter(({ implementation }) => implementation !== "fixture.task-system").length;
      if (liveProviderExecutions > 0 && (
        selection?.liveAuthorization?.confirmed !== true
        || selection.liveAuthorization.credentialReference !== "connected-product-provider"
        || selection.liveAuthorization.rootProviderExecutions !== liveProviderExecutions
        || selection.liveAuthorization.agentAuthoredChildren !== true
      )) {
        throw new Error(`Live agent-authored Complete comparison requires explicit confirmation, a connected provider credential reference, exactly ${liveProviderExecutions} root executions, and authorization for agent-authored child execution.`);
      }
    }
    if (testCaseIds.includes(RECURSIVE_GRAPH_MEMORY_CASE_ID)) {
      const definition = evalCases.find((item) => item.id === RECURSIVE_GRAPH_MEMORY_CASE_ID);
      if (!sameJson(testCaseIds, [RECURSIVE_GRAPH_MEMORY_CASE_ID])
        || !sameJson(harnessConfigurationNames, RECURSIVE_GRAPH_MEMORY_HARNESS_QUARTET)) {
        throw new Error(`The recursive graph-memory experiment must run alone with its exact ordered Codex quartet: ${RECURSIVE_GRAPH_MEMORY_HARNESS_QUARTET.join(", ")}.`);
      }
      const configurations = RECURSIVE_GRAPH_MEMORY_HARNESS_QUARTET.map((name) => this.configurations.get(name));
      const factors = configurations.map((configuration) => ({
        search: configuration?.graphCapabilityProfile?.search,
        agentAuthored: configuration?.complete?.agentAuthored,
      }));
      const expectedFactors = [
        { search: "disabled", agentAuthored: false },
        { search: "query-v1", agentAuthored: false },
        { search: "disabled", agentAuthored: true },
        { search: "query-v1", agentAuthored: true },
      ];
      if (configurations.some((configuration) => configuration === undefined)
        || !sameJson(factors, expectedFactors)
        || configurations.some((configuration) => configuration?.implementation !== "codex.basic")
        || configurations.some((configuration) => (
          recursiveGraphMemoryConfigurationIdentity(configuration)
            !== recursiveGraphMemoryConfigurationIdentity(configurations[0])
        ))) {
        throw new Error("The recursive graph-memory quartet must be one normalized Codex 2x2 varying only graph search and agent-authored Complete.");
      }
      const rootProviderExecutions = resolveEvalCasePrompts(definition, "authorization").length
        * configurations.length;
      if (selection?.liveAuthorization?.confirmed !== true
        || selection.liveAuthorization.credentialReference !== "connected-product-provider"
        || selection.liveAuthorization.rootProviderExecutions !== rootProviderExecutions
        || selection.liveAuthorization.agentAuthoredChildren !== true) {
        throw new Error(`The recursive graph-memory experiment requires explicit authorization for ${rootProviderExecutions} live roots and additional model-controlled agent-authored child execution.`);
      }
    }
    if (testCaseIds.some((id) => projectCaseIds.has(id)) && this.platform !== "darwin") {
      throw new Error("Pinned project cases are local Mac only.");
    }
    if (simulatedUserJudgeIds.has(judgeConfigurationName) && this.simulatedUserJudgeRunner === null) {
      throw new Error("Simulated-user judge is not available in this EvalService.");
    }
    if (testCaseIds.some((id) => evalCaseIsSteered(evalCases.find((item) => item.id === id)))
      && typeof this.steeringDecisionRunner !== "function") {
      throw new Error("Steered multi-turn cases require a simulated-user steering decision runner.");
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
      liveAuthorization: testCaseIds.includes(RECURSIVE_COMPLETE_EVAL_CASE_ID)
        || testCaseIds.includes(RECURSIVE_GRAPH_MEMORY_CASE_ID)
        ? copy(selection?.liveAuthorization || null)
        : null,
      comparison: testCaseIds.includes(RECURSIVE_COMPLETE_EVAL_CASE_ID) ? {
        kind: "agent-authored-complete-pair",
        temporalRuntimeFeatures: copy(RECURSIVE_TEMPORAL_FEATURES),
        controlledFields: [
          "task",
          "implementation",
          "settings except personalPresentationVersion",
          "permissionBindings",
          "providerModelSelection",
          "temporalRuntimeFeatures",
        ],
        variedField: "combined personalPresentationVersion and complete.agentAuthored experience",
        passed: null,
      } : testCaseIds.includes(RECURSIVE_GRAPH_MEMORY_CASE_ID) ? {
        kind: "graph-search-recursion-2x2",
        temporalRuntimeFeatures: copy(RECURSIVE_TEMPORAL_FEATURES),
        controlledFields: [
          "task",
          "implementation",
          "settings",
          "permissionBindings",
          "providerModelSelection",
          "temporalRuntimeFeatures",
        ],
        variedFields: ["graphCapabilityProfile.search", "complete.agentAuthored"],
        passed: null,
      } : null,
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
        semanticChildren: [],
        currentProjectionEvidence: { cursor: 0, observations: [] },
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
    let controlledComparisonModelResolution;
    for (const execution of run.executions) {
      const controlledComparison = execution.testCaseId === RECURSIVE_COMPLETE_EVAL_CASE_ID
        || execution.testCaseId === RECURSIVE_GRAPH_MEMORY_CASE_ID;
      if (controlledComparison && controlledComparisonModelResolution !== undefined) {
        execution.pinnedModelResolution = copy(controlledComparisonModelResolution);
      }
      await this.#execute(execution);
      if (controlledComparison
        && controlledComparisonModelResolution === undefined
        && execution.modelResolution !== undefined) {
        controlledComparisonModelResolution = copy(execution.modelResolution);
      }
      await this.#changed();
    }
    if (run.comparison?.kind === "agent-authored-complete-pair") {
      this.#finalizeRecursiveComparison(run);
      await this.#changed();
    }
    if (run.comparison?.kind === "graph-search-recursion-2x2") {
      this.#finalizeRecursiveGraphMemoryComparison(run);
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

  #finalizeRecursiveComparison(run) {
    const executions = run.executions.filter(({ testCaseId }) => testCaseId === RECURSIVE_COMPLETE_EVAL_CASE_ID);
    const [control, treatment] = executions;
    const controlled = executions.length === 2
      && control?.harnessConfigurationName === "codex-eval-complete-disabled"
      && treatment?.harnessConfigurationName === "codex-eval-complete-enabled"
      && sameJson(control?.modelResolution, treatment?.modelResolution)
      && sameJson(control?.turns?.map(({ prompt }) => prompt), treatment?.turns?.map(({ prompt }) => prompt))
      && sameJson(control?.turns?.map(({ modelSelection }) => modelSelection), treatment?.turns?.map(({ modelSelection }) => modelSelection))
      && sameJson(control?.turns?.map(({ permissionProfileId }) => permissionProfileId), treatment?.turns?.map(({ permissionProfileId }) => permissionProfileId))
      && sameJson(control?.turns?.map(({ effectivePermissionReceipt }) => effectivePermissionReceipt), treatment?.turns?.map(({ effectivePermissionReceipt }) => effectivePermissionReceipt));
    const check = {
      name: "agent-authored-complete:controlled-pair",
      passed: controlled,
      detail: controlled
        ? "The exact V1/off and V2/on cells used one pinned provider/model resolution and identical task and permission inputs."
        : "The combined-experience cells drifted outside their controlled provider, task, or permission inputs.",
    };
    for (const execution of executions) {
      execution.checks.push(copy(check));
      if (!controlled && execution.status !== "error") {
        execution.status = "failed";
        execution.passed = false;
      }
    }
    run.comparison = {
      ...run.comparison,
      sourceRuntime: "single-eval-desktop-process",
      providerModelResolution: copy(control?.modelResolution || null),
      passed: controlled,
      check,
    };
  }

  #finalizeRecursiveGraphMemoryComparison(run) {
    const executions = run.executions.filter(({ testCaseId }) => testCaseId === RECURSIVE_GRAPH_MEMORY_CASE_ID);
    const control = executions[0];
    const workspaceThreadIds = executions.flatMap((execution) => execution.threadIds || []);
    const controlled = executions.length === RECURSIVE_GRAPH_MEMORY_HARNESS_QUARTET.length
      && sameJson(executions.map(({ harnessConfigurationName }) => harnessConfigurationName), RECURSIVE_GRAPH_MEMORY_HARNESS_QUARTET)
      && executions.every((execution) => execution.threadIds?.length === 1)
      && new Set(workspaceThreadIds.map(String)).size === RECURSIVE_GRAPH_MEMORY_HARNESS_QUARTET.length
      && executions.every((execution) => sameJson(execution.modelResolution, control?.modelResolution))
      && executions.every((execution) => sameJson(
        execution.turns?.map(({ prompt }) => prompt),
        control?.turns?.map(({ prompt }) => prompt),
      ))
      && executions.every((execution) => sameJson(
        execution.turns?.map(({ modelSelection }) => modelSelection),
        control?.turns?.map(({ modelSelection }) => modelSelection),
      ))
      && executions.every((execution) => sameJson(
        execution.turns?.map(({ permissionProfileId }) => permissionProfileId),
        control?.turns?.map(({ permissionProfileId }) => permissionProfileId),
      ))
      && executions.every((execution) => sameJson(
        execution.turns?.map(({ effectivePermissionReceipt }) => effectivePermissionReceipt),
        control?.turns?.map(({ effectivePermissionReceipt }) => effectivePermissionReceipt),
      ));
    const check = {
      name: "graph-search-recursion:controlled-2x2",
      passed: controlled,
      detail: controlled
        ? "All four cells used the exact ordered factor matrix, one pinned provider/model resolution, and identical task and permission inputs."
        : "The four-cell experiment drifted outside its controlled factor, provider, task, model, or permission inputs.",
    };
    for (const execution of executions) {
      execution.checks.push(copy(check));
      if (!controlled && execution.status !== "error") {
        execution.status = "failed";
        execution.passed = false;
      }
    }
    run.comparison = {
      ...run.comparison,
      sourceRuntime: "single-eval-desktop-process",
      providerModelResolution: copy(control?.modelResolution || null),
      passed: controlled,
      check,
    };
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
      execution.semanticChildren = executedThreads.flatMap(({ semanticChildren = [] }) => semanticChildren);
      const interactions = executedThreads.flatMap(({ thread, humanInteractionIds, threadDefinition, permissionResolution, detail, workspaceChecks, workspaceArtifacts }) => (
        detail.interactions
          .filter((interaction) => humanInteractionIds.some((id) => String(id) === String(interaction.id)))
          .map((interaction, threadTurnIndex) => ({
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
      if (definition.requiredChecks?.includes("agent-authored-complete")) {
        execution.promotable = execution.promotable
          && execution.semanticChildren.every((child) => (
            !this.candidateTraceRequired || child.candidateTrace?.status === "complete"
          ));
      }
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
      if (definition.requiredChecks?.includes("agent-authored-complete")) {
        checks.push(...recursiveCompleteChecks(execution, {
          requireChildWhenEnabled: definition.id !== RECURSIVE_GRAPH_MEMORY_CASE_ID,
        }));
      }
      execution.checks = checks;
      let simulatedUserCompleted = true;
      let inputRoundTripCompleted = !definition.requiredChecks?.includes("input-roundtrip");
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
            allowInputOperator: definition.requiredChecks?.includes("input-roundtrip") === true,
          });
          if (result.status !== "completed") simulatedUserCompleted = false;
          if (definition.requiredChecks?.includes("input-roundtrip")) {
            inputRoundTripCompleted = result.inputRoundTrip?.passed === true;
            const roundTripChecks = (result.inputRoundTrip?.checks ?? []).map((check) => ({
              ...copy(check),
              name: `turn-${interaction.sequence}:${check.name}`,
            }));
            if (roundTripChecks.length === 0) {
              roundTripChecks.push({
                name: `turn-${interaction.sequence}:input-roundtrip:exercised`,
                passed: false,
                detail: result.inputRoundTrip?.detail || "The input round-trip live gate was not exercised.",
              });
            }
            turn.deterministicChecks.push(...roundTripChecks);
            execution.checks.push(...roundTripChecks);
            turn.deterministicPassed = turn.deterministicChecks.length > 0
              && turn.deterministicChecks.every((check) => check.passed);
          }
        }
        if (eligibleTurns.length === 0) simulatedUserCompleted = false;
      }
      const deterministicPassed = execution.checks.length > 0
        && execution.checks.every((check) => check.passed);
      const outcomeChecks = execution.caseSnapshot
        ? execution.checks.filter((check) => check.name.includes(":workspace:"))
        : execution.checks;
      execution.outcomeGrade = definition.id === RECURSIVE_GRAPH_MEMORY_CASE_ID
        ? recursiveGraphMemoryOutcomeGrade()
        : outcomeGradeFromChecks(outcomeChecks, execution.caseSnapshot);
      execution.presentationGrade = presentationGradeFromTurns(
        execution.turns,
        simulatedUserJudgeIds.has(execution.judgeConfiguration.name),
      );
      execution.passed = deterministicPassed && simulatedUserCompleted && inputRoundTripCompleted;
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
    const executed = await this.#createAndRunThread({
      execution,
      title: definition.name,
      prompts: resolveEvalCasePrompts(definition, execution.testRunId),
      permissionProfileId: selectStandalonePermissionProfile(execution.harnessConfiguration),
    });
    return { ...executed, threadDefinition: null, workspaceChecks: new Map() };
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
      const steered = evalCaseIsSteered(definition) || isSteeredMultiTurn(threadDefinition);
      if (steered) {
        if (!simulatedUserJudgeIds.has(execution.judgeConfiguration.name)) {
          throw new Error("Steered multi-turn cases require a simulated-user judge configuration.");
        }
        if (typeof this.steeringDecisionRunner !== "function") {
          throw new Error("Steered multi-turn cases require a simulated-user steering decision runner.");
        }
      }
      const executed = await this.#createAndRunThread({
        execution,
        title: `${definition.name} · ${threadDefinition.name}`,
        prompts: threadDefinition.prompts,
        projectId: project.id,
        permissionProfileId: permissionResolution.effectiveProfileId,
        steeredPolicy: steered
          ? {
            interactionVariant: "multi-turn",
            openingPrompt: requireSingleOpeningPrompt(threadDefinition.prompts, "multi-turn"),
            simulatedUserBrief: definition.simulatedUserBrief || threadDefinition.simulatedUserBrief || "",
            maxHumanTurns: steeredMaxHumanTurns(definition),
          }
          : null,
        afterTurn: async (interactionId, promptIndex) => {
          workspaceArtifacts.set(String(interactionId), await captureTurnArtifactSnapshot(
            execution,
            workspaceDirectory,
            interactionId,
          ));
          if (
            !steered
            && (
              threadDefinition.mutationPolicy === "read-only"
              || promptIndex === threadDefinition.prompts.length - 1
            )
          ) {
            workspaceChecks.set(String(interactionId), await gradeProjectWorkspace({
              isH3,
              isCalibration,
              definition,
              threadDefinition,
              workspaceDirectory,
              fixture,
              workspaceGrader: this.workspaceGrader,
              calibrationWorkspaceGrader: this.calibrationWorkspaceGrader,
              frontierWorkspaceGrader: this.frontierWorkspaceGrader,
            }));
          }
        },
      });
      if (steered) {
        const lastInteractionId = executed.humanInteractionIds.at(-1);
        workspaceChecks.set(String(lastInteractionId), await gradeProjectWorkspace({
          isH3,
          isCalibration,
          definition,
          threadDefinition,
          workspaceDirectory,
          fixture,
          workspaceGrader: this.workspaceGrader,
          calibrationWorkspaceGrader: this.calibrationWorkspaceGrader,
          frontierWorkspaceGrader: this.frontierWorkspaceGrader,
        }));
      }
      executedThreads.push({ ...executed, threadDefinition, permissionResolution, workspaceChecks, workspaceArtifacts });
    }
    return executedThreads;
  }

  async #createAndRunThread({
    execution,
    title,
    prompts,
    projectId = null,
    permissionProfileId = "auto",
    afterTurn = async () => {},
    steeredPolicy = null,
  }) {
    if (!Array.isArray(prompts) || prompts.length === 0) throw new Error(`Eval thread ${title} has no prompts.`);
    let selectedModel = execution.pinnedModelResolution?.selectedModel;
    let productModelSelection = execution.pinnedModelResolution?.productModelSelection;
    if (execution.pinnedModelResolution !== undefined) {
      // The treatment cell uses the control cell's exact provider/model resolution.
    } else if (execution.harnessConfiguration.implementation === "claude.basic") {
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
    execution.modelResolution = {
      selectedModel: copy(selectedModel ?? null),
      productModelSelection,
    };
    const startThread = async (initialMessage) => {
      const thread = await this.#productRequest("/api/threads", {
        method: "POST",
        body: {
          title,
          initialMessage,
          harnessConfigurationName: execution.harnessConfigurationName,
          permissionProfileId,
          ...evalModelSelectionRequest(selectedModel, productModelSelection),
          ...(projectId === null ? {} : { projectId }),
        },
      });
      execution.threadIds.push(thread.id);
      return thread;
    };
    const finishTurn = async (threadId, interactionId, promptIndex) => {
      const interaction = await this.#waitForInteraction(execution, threadId, interactionId);
      await this.#captureCandidateTrace(execution, interaction);
      await afterTurn(interactionId, promptIndex);
      return interaction;
    };
    const postFollowUp = async (threadId, text) => this.#productRequest(`/api/threads/${threadId}/interactions`, {
      method: "POST",
      body: {
        text,
        ...evalModelSelectionRequest(selectedModel, productModelSelection),
      },
    });

    if (steeredPolicy) {
      if (typeof this.steeringDecisionRunner !== "function") {
        throw new Error("Steered multi-turn cases require a simulated-user steering decision runner.");
      }
      let thread = null;
      const humanInteractionIds = [];
      let publishedSurface = null;
      let lastCurrentSummary = "";
      const steeredLoop = await runSteeredInteractionLoop(steeredPolicy, {
        startOpening: async (prompt) => {
          thread = await startThread(prompt);
          humanInteractionIds.push(thread.rootInteractionId);
          return { interactionId: String(thread.rootInteractionId) };
        },
        observe: async (interactionId) => {
          const detail = await this.#productRequest(`/api/threads/${thread.id}`);
          await this.#observeCurrentProjections(execution, detail);
          const interaction = detail.interactions.find((candidate) => String(candidate.id) === String(interactionId));
          if (!interaction) throw new Error(`Product interaction ${interactionId} disappeared.`);
          publishedSurface = await this.#loadPublishedCurrentSurface(thread.id, interaction);
          lastCurrentSummary = summarizePublishedCurrent(interaction.completionStatus, publishedSurface);
          return {
            interactionId: String(interaction.id),
            completionStatus: interaction.completionStatus,
            terminal: !IN_PROGRESS_COMPLETION_STATUSES.has(interaction.completionStatus),
            currentSummary: lastCurrentSummary,
          };
        },
        decide: async (observation) => {
          const decision = parseSteeringDecision(await this.steeringDecisionRunner({
            openingPrompt: observation.openingPrompt,
            simulatedUserBrief: observation.simulatedUserBrief,
            remainingHumanTurns: observation.remainingHumanTurns,
            currentSummary: observation.snapshot.currentSummary,
            completionStatus: observation.snapshot.completionStatus,
            interactionId: observation.snapshot.interactionId,
          }));
          execution.steeringDecisions = [...(execution.steeringDecisions || []), copy(decision)];
          return decision;
        },
        apply: async (decision, snapshot) => {
          const attempt = {
            interactionId: snapshot.interactionId,
            completionStatus: snapshot.completionStatus,
            decision,
            status: "applied",
            error: null,
          };
          try {
            await this.#applyPublishedCurrentDecision(thread.id, publishedSurface, decision);
          } catch (error) {
            if (decision.kind === "abandon") throw error;
            attempt.status = "rejected";
            attempt.error = error instanceof Error ? error.message : String(error);
          }
          execution.steeringActions = [...(execution.steeringActions || []), copy(attempt)];
        },
        waitForChange: async (interactionId) => {
          const previous = lastCurrentSummary;
          const deadline = Date.now() + 2_000;
          while (Date.now() < deadline) {
            await new Promise((resolveWait) => setTimeout(resolveWait, 50));
            const detail = await this.#productRequest(`/api/threads/${thread.id}`);
            const interaction = detail.interactions.find((candidate) => String(candidate.id) === String(interactionId));
            if (!interaction || !IN_PROGRESS_COMPLETION_STATUSES.has(interaction.completionStatus)) return;
            const surface = await this.#loadPublishedCurrentSurface(thread.id, interaction);
            if (summarizePublishedCurrent(interaction.completionStatus, surface) !== previous) return;
          }
        },
      });
      await finishTurn(thread.id, thread.rootInteractionId, 0);
      execution.steeredLoop = {
        terminal: steeredLoop.terminal,
        decisionCount: steeredLoop.decisions.length,
        inFlightActionCount: (execution.steeringActions || []).length,
      };
      const { detail, semanticChildren } = await this.#waitForSemanticChildren(
        execution,
        thread.id,
        humanInteractionIds,
      );
      return { thread, humanInteractionIds, detail, semanticChildren };
    }

    const thread = await startThread(prompts[0]);
    const humanInteractionIds = [thread.rootInteractionId];
    await finishTurn(thread.id, thread.rootInteractionId, 0);
    for (const [offset, prompt] of prompts.slice(1).entries()) {
      const interaction = await postFollowUp(thread.id, prompt);
      humanInteractionIds.push(interaction.id);
      await finishTurn(thread.id, interaction.id, offset + 1);
    }
    const { detail, semanticChildren } = await this.#waitForSemanticChildren(
      execution,
      thread.id,
      humanInteractionIds,
    );
    return { thread, humanInteractionIds, detail, semanticChildren };
  }

  async #judgeAcceptedTurn({
    execution,
    thread,
    interaction,
    turn,
    reviewSequence,
    provenance = null,
    allowInputOperator = false,
  }) {
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
      rubricVersion: GRAPH_PRESENTATION_RUBRIC_V11.rubricVersion,
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
        allowInputOperator,
        request: {
          text: interaction.text,
          followUp: previousTurnIds.length > 0,
          previousTurnIds,
          comparisonTurnIds: previousTurnIds.slice(-1),
        },
        artifact: judgeArtifactForExecution(execution, turn),
        artifactEvidence: judgeArtifactEvidenceForExecution(execution, turn),
        rubric: copy(GRAPH_PRESENTATION_RUBRIC_V11),
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

  async #waitForInteraction(execution, threadId, interactionId) {
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      const detail = await this.#productRequest(`/api/threads/${threadId}`);
      await this.#observeCurrentProjections(execution, detail);
      const interaction = detail.interactions.find((candidate) => candidate.id === interactionId);
      if (!interaction) throw new Error(`Product interaction ${interactionId} disappeared.`);
      if (!IN_PROGRESS_COMPLETION_STATUSES.has(interaction.completionStatus)) return interaction;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    throw new Error(`Product interaction ${interactionId} did not finish within 10 minutes.`);
  }

  async #waitForSemanticChildren(execution, threadId, humanInteractionIds) {
    const deadline = Date.now() + 10 * 60_000;
    const discoveryDeadline = Date.now() + SEMANTIC_CHILD_DISCOVERY_TIMEOUT_MS;
    const boundedObservation = semanticChildDiscoveryIsBounded(execution.harnessConfiguration);
    let discoveryObservation = {
      signature: null,
      stableSince: Date.now(),
      stable: false,
    };
    for (;;) {
      const detail = await this.#productRequest(`/api/threads/${threadId}`);
      await this.#observeCurrentProjections(execution, detail);
      const invocations = descendantInvocations(detail, humanInteractionIds);
      const interactionsById = new Map((detail.interactions || []).map((interaction) => [
        String(interaction.id),
        interaction,
      ]));
      const pending = invocations.filter((invocation) => {
        const child = interactionsById.get(String(invocation.resultInteractionId));
        return child === undefined || IN_PROGRESS_COMPLETION_STATUSES.has(child.completionStatus);
      });
      const signature = canonicalJson(invocations.map((invocation) => ({
        sourceInteractionId: invocation.sourceInteractionId,
        actionId: invocation.actionId,
        resultInteractionId: invocation.resultInteractionId,
        completionStatus: interactionsById.get(String(invocation.resultInteractionId))?.completionStatus ?? null,
      })));
      discoveryObservation = semanticChildDiscoveryObservation({
        previousSignature: discoveryObservation.signature,
        stableSince: discoveryObservation.stableSince,
        signature,
        now: Date.now(),
        discoveryDeadline,
        boundedObservation,
      });
      if (pending.length === 0 && discoveryObservation.stable) {
        const semanticChildren = [];
        for (const invocation of invocations) {
          const child = interactionsById.get(String(invocation.resultInteractionId));
          if (!child) throw new Error(`Semantic child ${invocation.resultInteractionId} disappeared.`);
          await this.#backfillCurrentProjection(execution, child);
          await this.#captureCandidateTrace(execution, child);
          semanticChildren.push({
            threadId,
            sourceInteractionId: invocation.sourceInteractionId,
            sourceActionId: invocation.actionId,
            interactionId: child.id,
            graphNodeId: child.graphNodeId,
            status: child.completionStatus,
            rootLayerId: child.completionOutput?.rootLayer?.layer?.id ?? null,
            acceptedRootNodes: copy((child.completionOutput?.rootLayer?.nodes || []).map((node) => ({
              id: node.id,
              title: node.title,
              detail: node.detail,
            }))),
            resultCompletionStatus: invocation.resultCompletionStatus,
            execution: copy(invocation.execution || null),
            candidateTrace: copy(execution.candidateTraceCaptures?.[String(child.id)] || disabledCandidateTrace()),
            projectionObservations: copy(
              execution.currentProjectionEvidence?.observations?.filter((observation) => (
                String(observation.completionId) === String(child.graphNodeId)
              )) || [],
            ),
          });
        }
        return { detail, semanticChildren };
      }
      if (Date.now() >= deadline) {
        throw new Error(`Semantic children did not settle within 10 minutes: ${pending.map(({ resultInteractionId }) => resultInteractionId).join(", ")}.`);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }

  async #observeCurrentProjections(execution, detail) {
    const definition = evalCases.find((candidate) => candidate.id === execution.testCaseId);
    if (!definition?.requiredChecks?.includes("agent-authored-complete")) return;
    const evidence = execution.currentProjectionEvidence ||= { cursor: 0, observations: [] };
    const completionIds = new Set((detail.interactions || [])
      .map((interaction) => interaction.graphNodeId)
      .filter((id) => Number.isSafeInteger(id))
      .map(String));
    if (completionIds.size === 0) return;
    const state = await this.#productRequest(`/api/state?currentProjectionAfter=${evidence.cursor}`);
    const observedAt = new Date().toISOString();
    const statuses = new Map((detail.interactions || []).map((interaction) => [
      String(interaction.graphNodeId),
      interaction.completionStatus,
    ]));
    for (const event of state.currentProjection?.events || []) {
      if (!completionIds.has(String(event.completionId))) continue;
      evidence.observations.push({
        observedAt,
        completionId: event.completionId,
        sequence: event.sequence,
        revision: event.revision,
        previousRevision: event.previousRevision ?? null,
        lifecycle: event.lifecycle,
        currentLayerId: event.currentLayerId ?? null,
        productStatus: statuses.get(String(event.completionId)) ?? "unknown",
        observedPreTerminal: IN_PROGRESS_COMPLETION_STATUSES.has(
          statuses.get(String(event.completionId)),
        ),
      });
    }
    evidence.cursor = state.currentProjection?.cursor ?? evidence.cursor;
  }

  async #backfillCurrentProjection(execution, interaction) {
    if (!Number.isSafeInteger(interaction.graphNodeId)) return;
    const evidence = execution.currentProjectionEvidence ||= { cursor: 0, observations: [] };
    const completionId = String(interaction.graphNodeId);
    const existingSequences = new Set(evidence.observations
      .filter((observation) => String(observation.completionId) === completionId)
      .map((observation) => observation.sequence));
    const state = await this.#productRequest(
      `/api/state?currentProjectionAfter=0&currentProjectionCompletionId=${completionId}`,
    );
    const observedAt = new Date().toISOString();
    for (const event of state.currentProjection?.events || []) {
      if (existingSequences.has(event.sequence)) continue;
      evidence.observations.push({
        observedAt,
        completionId: event.completionId,
        sequence: event.sequence,
        revision: event.revision,
        previousRevision: event.previousRevision ?? null,
        lifecycle: event.lifecycle,
        currentLayerId: event.currentLayerId ?? null,
        productStatus: interaction.completionStatus,
        observedPreTerminal: false,
        recoveredAfterDiscovery: true,
      });
    }
  }

  async #loadPublishedCurrentSurface(threadId, interaction) {
    const accepted = publishedSurfaceFromResolvedLayer(
      threadId,
      interaction,
      interaction?.completionOutput?.rootLayer,
    );
    let currentLayerId = accepted.layerId;
    if (Number.isSafeInteger(interaction?.graphNodeId)) {
      try {
        const state = await this.#productRequest(
          `/api/state?currentProjectionAfter=0&currentProjectionCompletionId=${encodeURIComponent(interaction.graphNodeId)}`,
        );
        const events = state.currentProjection?.events || [];
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = events[index];
          if (String(event?.completionId) !== String(interaction.graphNodeId)) continue;
          if (event.currentLayerId != null) {
            currentLayerId = event.currentLayerId;
            break;
          }
        }
      } catch {
        // Projection may be absent in fixture products; accepted or empty current still steers.
      }
    }
    if (currentLayerId == null) return accepted;
    try {
      const resolved = await this.#productRequest(
        `/api/threads/${encodeURIComponent(threadId)}/interactions/${encodeURIComponent(interaction.id)}/layers/${encodeURIComponent(currentLayerId)}`,
      );
      return publishedSurfaceFromResolvedLayer(threadId, interaction, resolved, currentLayerId);
    } catch {
      return accepted.layerId == null ? { ...accepted, layerId: currentLayerId } : accepted;
    }
  }

  async #applyPublishedCurrentDecision(threadId, surface, decision) {
    if (surface == null) {
      throw new Error("Published current is not available yet.");
    }
    if (decision.kind === "navigate") {
      const resolved = resolvePublishedCurrentTarget(surface, decision.target, "navigate");
      const layerId = resolved.action?.targetLayerId ?? surface.layerId;
      if (layerId == null) {
        throw new Error(`Published current has no navigable layer for ${decision.target}.`);
      }
      await this.#productRequest(
        `/api/threads/${encodeURIComponent(threadId)}/interactions/${encodeURIComponent(surface.interactionId)}/layers/${encodeURIComponent(layerId)}`,
      );
      return;
    }
    if (decision.kind === "commit-input") {
      const resolved = resolvePublishedCurrentTarget(surface, decision.target, "input");
      if (resolved.action == null || surface.graphNodeId == null || surface.layerId == null) {
        throw new Error(`Published current has no input action for ${decision.target}.`);
      }
      const draft = await this.#productRequest(`/api/threads/${encodeURIComponent(threadId)}/input-draft`);
      const control = String(resolved.action.control ?? "text");
      const value = control === "text" || control === ""
        ? { text: decision.text }
        : { selectedKeys: [decision.text] };
      await this.#productRequest(`/api/threads/${encodeURIComponent(threadId)}/input-draft/attachments`, {
        method: "PUT",
        body: {
          occurrence: {
            presentingInteractionNodeId: surface.graphNodeId,
            presentingLayerId: surface.layerId,
            actionId: resolved.action.id,
          },
          value,
          expectedRevision: draft.revision ?? 1,
        },
      });
      return;
    }
    if (decision.kind === "invoke") {
      const resolved = resolvePublishedCurrentTarget(surface, decision.target, "invoke");
      if (resolved.action == null) {
        throw new Error(`Published current has no invoke action for ${decision.target}.`);
      }
      await this.#productRequest(
        `/api/threads/${encodeURIComponent(threadId)}/interactions/${encodeURIComponent(surface.interactionId)}/actions/${encodeURIComponent(resolved.action.id)}/invoke`,
        { method: "POST" },
      );
      return;
    }
    if (decision.kind === "abandon") {
      if (surface.graphNodeId == null) {
        throw new Error("Published current has no completion identity to stop.");
      }
      await this.#productRequest(`/api/completions/${encodeURIComponent(surface.graphNodeId)}/stop`, {
        method: "POST",
        body: { reason: decision.reason.slice(0, 200) },
      });
    }
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
      const correlation = {
        runId: execution.testRunId,
        executionId: execution.id,
        interactionId: String(interaction.id),
        harnessConfigurationName: execution.harnessConfigurationName,
        model: candidateModel(execution.harnessConfiguration),
      };
      const deadline = Date.now() + 30_000;
      let descriptor;
      for (;;) {
        try {
          descriptor = await this.candidateTraceExporter(interaction.id, targetDirectory, correlation);
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message !== `No candidate trace exists for product interaction ${interaction.id}`
            || Date.now() >= deadline) throw error;
          await new Promise((wait) => setTimeout(wait, 50));
        }
      }
      const completionBrokerAvailable = await validateCandidateTrace(
        targetDirectory,
        descriptor,
        interaction,
        correlation,
        {
          requireComplete: execution.testCaseId === RECURSIVE_COMPLETE_EVAL_CASE_ID
            || execution.testCaseId === RECURSIVE_GRAPH_MEMORY_CASE_ID,
        },
      );
      execution.candidateTraceCaptures ||= {};
      execution.candidateTraceCaptures[String(interaction.id)] = {
        ...copy(descriptor),
        completionBrokerAvailable,
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

function evalCaseIsSteered(definition) {
  if (!definition) return false;
  if (isSteeredMultiTurn(definition)) return true;
  return Array.isArray(definition.threads)
    && definition.threads.some((thread) => isSteeredMultiTurn(thread));
}

async function gradeProjectWorkspace({
  isH3,
  isCalibration,
  definition,
  threadDefinition,
  workspaceDirectory,
  fixture,
  workspaceGrader,
  calibrationWorkspaceGrader,
  frontierWorkspaceGrader,
}) {
  if (isH3) return workspaceGrader({ workspaceDirectory, grade: threadDefinition.workspaceGrade });
  if (isCalibration) {
    return calibrationWorkspaceGrader({
      caseId: definition.id,
      workspaceDirectory,
      baseRevision: fixture.seededCommit,
    });
  }
  return frontierWorkspaceGrader({ caseId: definition.id, workspaceDirectory });
}

function publishedSurfaceFromResolvedLayer(threadId, interaction, resolved, layerId = resolved?.layer?.id ?? null) {
  const nodes = [];
  for (const node of resolved?.nodes || []) {
    if (node && typeof node === "object" && !Array.isArray(node)) {
      nodes.push({
        id: node.id ?? node.node?.id,
        title: node.title ?? node.node?.title,
        detail: node.detail ?? node.node?.detail,
      });
    } else if (node != null) {
      nodes.push({ id: node });
    }
  }
  return {
    threadId,
    interactionId: interaction?.id,
    graphNodeId: interaction?.graphNodeId ?? null,
    layerId: layerId ?? resolved?.layer?.id ?? null,
    nodes,
    actions: [...(resolved?.actions || resolved?.layer?.actions || [])],
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
    ...(output.inputRoundTripRef === undefined ? {} : {
      inputRoundTrip: optionalReference(output.inputRoundTripRef),
    }),
    ...(Array.isArray(output.inputRatingReceiptRefs) && output.inputRatingReceiptRefs.length > 0 ? {
      inputRatings: output.inputRatingReceiptRefs
        .filter((reference) => typeof reference === "string" && reference.length > 0),
    } : {}),
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
    ...(output.inputRoundTrip === undefined ? {} : {
      inputRoundTrip: output.inputRoundTrip && typeof output.inputRoundTrip === "object"
        ? copy(output.inputRoundTrip)
        : null,
    }),
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
