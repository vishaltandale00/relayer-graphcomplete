import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  DEFAULT_SIMULATED_USER_RUBRIC,
  IncrementalReviewStore,
  RecursivePresentationReviewStore,
  createScreenshotEvidenceValidator,
  createRecursiveScreenshotEvidenceValidator,
  inventoryReviewSubjects,
  runSimulatedUserJudge,
} from "@relayer/eval-runner";

export const LOCAL_SIMULATED_USER_JUDGE_CONFIGURATION = Object.freeze({
  model: "gpt-5.6-sol",
  modelReasoningEffort: "high",
});

export const LOCAL_SIMULATED_USER_AUTORUN_ENV = "RELAYER_EVAL_AUTORUN_H3_SIMULATED_USER";
export const LOCAL_SIMULATED_USER_AUTORUN_FLAG = "--relayer-eval-autorun-h3-simulated-user";

export function resolveLocalSimulatedUserAutorun({
  environment = process.env,
  arguments: commandLineArguments = process.argv,
  packaged = false,
  availableHarnessConfigurationNames,
} = {}) {
  const enabled = environment[LOCAL_SIMULATED_USER_AUTORUN_ENV] === "1"
    || commandLineArguments.includes(LOCAL_SIMULATED_USER_AUTORUN_FLAG);
  if (!enabled) return null;
  if (packaged) throw new Error("The simulated-user H3 autorun is available only in a local development checkout.");
  const requestedHarnesses = [
    "codex-layered-navigation-luna",
    "prime-agent-layered-navigation-luna",
  ];
  const availableHarnesses = availableHarnessConfigurationNames === undefined
    ? null
    : new Set(availableHarnessConfigurationNames);
  const harnessConfigurationNames = availableHarnesses === null
    ? requestedHarnesses
    : requestedHarnesses.filter((name) => availableHarnesses.has(name));
  if (!harnessConfigurationNames.includes("codex-layered-navigation-luna")) {
    throw new Error("The simulated-user H3 autorun requires codex-layered-navigation-luna.");
  }
  return {
    testCaseIds: ["project.h3.sanitize-status-code"],
    harnessConfigurationNames,
    judgeConfigurationName: "simulated-user-sol-high",
  };
}

export function createReviewSessionController(reviewSession, screenshotMetadata) {
  if (!reviewSession?.screenshot || !reviewSession?.interact || !reviewSession?.history) {
    throw new Error("Simulated-user review requires a complete ReviewSession controller.");
  }
  return Object.freeze({
    screenshot: async (input) => {
      const output = await reviewSession.screenshot(input);
      if (!output?.ok) return { output, images: [] };
      const screenshot = output.screenshot;
      screenshotMetadata.set(screenshot.screenshotId, structuredClone(screenshot));
      const directory = reviewSession.artifactDirectoryFor(screenshot.screenshotId);
      if (!directory) throw new Error(`Screenshot artifact directory is missing: ${screenshot.screenshotId}`);
      const images = await Promise.all([...screenshot.tiles]
        .sort((left, right) => left.index - right.index)
        .map(async (tile) => ({
          data: (await readFile(join(
            directory,
            `${screenshot.screenshotId}-${String(tile.index + 1).padStart(3, "0")}.png`,
          ))).toString("base64"),
          mimeType: "image/png",
        })));
      if (images.length !== screenshot.tileCount) {
        throw new Error(`Screenshot tile count does not match metadata: ${screenshot.screenshotId}`);
      }
      return { output, images };
    },
    interact: (input) => reviewSession.interact(input),
    history: (input) => reviewSession.history(input),
  });
}

export async function buildAcceptedReviewTopology({ turnId, rootLayerId, loadLayer }) {
  if (!turnId || !rootLayerId || typeof loadLayer !== "function") {
    throw new Error("Accepted review topology requires a turn, root layer, and layer loader.");
  }
  const pending = [String(rootLayerId)];
  const scheduled = new Set(pending);
  const layers = [];
  for (let index = 0; index < pending.length; index += 1) {
    const requestedLayerId = pending[index];
    const resolved = await loadLayer(requestedLayerId);
    const layerId = String(resolved?.layer?.id ?? "");
    if (layerId !== requestedLayerId) {
      throw new Error(`Accepted graph returned layer ${layerId || "<missing>"} for ${requestedLayerId}.`);
    }
    if (resolved.layer.state !== "accepted") {
      throw new Error(`Review topology layer is not accepted: ${layerId}`);
    }
    if (!Array.isArray(resolved.nodes) || !Array.isArray(resolved.edges) || !Array.isArray(resolved.actions)) {
      throw new Error(`Accepted review layer is unresolved: ${layerId}`);
    }
    const declaredNodeIds = (resolved.layer.nodes || []).map(String);
    const resolvedNodeIds = resolved.nodes.map((node) => String(node.id));
    const declaredEdgeIds = (resolved.layer.edges || []).map(String);
    const resolvedEdgeIds = resolved.edges.map((edge) => String(edge.id));
    if (JSON.stringify(declaredNodeIds) !== JSON.stringify(resolvedNodeIds)
      || JSON.stringify(declaredEdgeIds) !== JSON.stringify(resolvedEdgeIds)) {
      throw new Error(`Accepted review layer membership is unresolved or mismatched: ${layerId}`);
    }
    if (resolved.nodes.some((node) => node.state !== "accepted")) {
      throw new Error(`Review topology layer contains a non-accepted node: ${layerId}`);
    }
    if (resolved.edges.some((edge) => (
      edge.state !== "accepted"
      || !Array.isArray(edge.endpoints)
      || edge.endpoints.some((nodeId) => !declaredNodeIds.includes(String(nodeId)))
    ))) {
      throw new Error(`Review topology layer contains a non-accepted or out-of-layer edge: ${layerId}`);
    }
    if (resolved.actions.some((action) => action.state !== "accepted")) {
      throw new Error(`Review topology layer contains a non-accepted action: ${layerId}`);
    }
    const actions = resolved.actions.map((action) => {
      const base = {
        id: String(action.id),
        sourceNodeId: String(action.sourceNodeId),
        kind: action.kind,
      };
      if (!declaredNodeIds.includes(base.sourceNodeId)) {
        throw new Error(`Accepted action source is outside its layer: ${action.id}`);
      }
      if (action.kind === "navigate") {
        if (action.targetLayerId === null || action.targetLayerId === undefined) {
          throw new Error(`Accepted navigate action has no target layer: ${action.id}`);
        }
        const targetLayerId = String(action.targetLayerId);
        if (action.relation !== "expand" && action.relation !== "reference") {
          throw new Error(`Accepted navigate action has no valid relation: ${action.id}`);
        }
        if (!scheduled.has(targetLayerId)) {
          scheduled.add(targetLayerId);
          pending.push(targetLayerId);
        }
        return { ...base, relation: action.relation, targetLayerId };
      }
      if (action.kind !== "invoke") throw new Error(`Unknown accepted action kind: ${action.kind}`);
      return base;
    });
    const nodes = resolved.nodes.map((node) => ({ id: String(node.id), title: node.title, detail: node.detail }));
    layers.push({
      id: layerId,
      nodeIds: resolvedNodeIds,
      ...(nodes.some((node) => typeof node.title === "string" || typeof node.detail === "string") ? { nodes } : {}),
      edgeIds: resolvedEdgeIds,
      actions,
    });
  }
  return {
    turnId: String(turnId),
    rootLayerId: String(rootLayerId),
    layers,
  };
}

export function gradeAcceptedReviewTopology(topology, { requireGrandchild = false } = {}) {
  const layers = Array.isArray(topology?.layers) ? topology.layers : [];
  const rootLayerId = String(topology?.rootLayerId ?? "");
  const byId = new Map(layers.map((layer) => [String(layer.id), layer]));
  const pending = rootLayerId && byId.has(rootLayerId) ? [{ layerId: rootLayerId, depth: 0 }] : [];
  const visited = new Set();
  let maxExpansionDepth = -1;
  let closureError = rootLayerId ? null : "The accepted topology has no root layer ID.";
  if (rootLayerId && !byId.has(rootLayerId)) closureError = `The accepted topology omits root layer ${rootLayerId}.`;

  for (let index = 0; index < pending.length && closureError === null; index += 1) {
    const { layerId, depth } = pending[index];
    if (visited.has(layerId)) continue;
    visited.add(layerId);
    const layer = byId.get(layerId);
    const nodeIds = new Set((layer?.nodeIds ?? []).map(String));
    for (const action of layer?.actions ?? []) {
      if (!nodeIds.has(String(action.sourceNodeId))) {
        closureError = `Action ${action.id} has a source outside layer ${layerId}.`;
        break;
      }
      if (action.kind !== "navigate") continue;
      const targetLayerId = String(action.targetLayerId ?? "");
      if (!targetLayerId || !byId.has(targetLayerId)) {
        closureError = `Navigate action ${action.id} has no resolved accepted destination.`;
        break;
      }
      pending.push({ layerId: targetLayerId, depth: depth + 1 });
    }
  }

  const expansionPending = rootLayerId && byId.has(rootLayerId)
    ? [{ layerId: rootLayerId, depth: 0 }]
    : [];
  const expansionVisited = new Set();
  for (let index = 0; index < expansionPending.length; index += 1) {
    const { layerId, depth } = expansionPending[index];
    if (expansionVisited.has(layerId)) continue;
    expansionVisited.add(layerId);
    maxExpansionDepth = Math.max(maxExpansionDepth, depth);
    for (const action of byId.get(layerId)?.actions ?? []) {
      if (action.kind === "navigate" && action.relation === "expand") {
        expansionPending.push({ layerId: String(action.targetLayerId), depth: depth + 1 });
      }
    }
  }

  if (closureError === null && visited.size !== byId.size) {
    closureError = `Topology contains ${byId.size - visited.size} layer(s) outside the root's reachable closure.`;
  }
  const closurePassed = closureError === null && visited.size > 0;
  const checks = [{
    name: "graph:accepted-reachable-closure",
    passed: closurePassed,
    detail: closurePassed
      ? `${visited.size} accepted layer(s) and their actions form the complete reachable closure.`
      : closureError ?? "The accepted reachable closure is empty.",
  }];
  if (requireGrandchild) {
    checks.push({
      name: "graph:root-child-grandchild",
      passed: closurePassed && maxExpansionDepth >= 2,
      detail: closurePassed && maxExpansionDepth >= 2
        ? `The accepted response reaches expansion depth ${maxExpansionDepth} from its root.`
        : `The accepted response reaches expansion depth ${Math.max(maxExpansionDepth, 0)}; architecture requires at least 2.`,
    });
  }
  return checks;
}

export function createLocalSimulatedUserJudgeRunner({
  loadLayer,
  openReviewSession,
  runJudge = runSimulatedUserJudge,
  configuration = LOCAL_SIMULATED_USER_JUDGE_CONFIGURATION,
}) {
  if (typeof loadLayer !== "function" || typeof openReviewSession !== "function" || typeof runJudge !== "function") {
    throw new Error("Local simulated-user judge integration is incomplete.");
  }
  const selectedConfiguration = structuredClone(configuration);
  return async (context) => {
    const rootLayerId = String(context.turn.rootLayerId ?? "");
    if (!rootLayerId) throw new Error("Accepted turn has no root layer for simulated-user review.");
    const topology = await buildAcceptedReviewTopology({
      turnId: context.turn.id,
      rootLayerId,
      loadLayer: (layerId) => loadLayer({
        executionId: context.execution.id,
        threadId: context.thread.id,
        turnId: context.turn.id,
        layerId,
      }),
    });
    const inventory = inventoryReviewSubjects(topology);
    const screenshots = new Map();
    let opened;
    let completed = false;
    try {
      opened = await openReviewSession({
        executionId: context.execution.id,
        threadId: context.thread.id,
        turnId: context.turn.id,
        rootLayerId,
        artifactDirectory: join(context.artifactDirectory, "screenshots"),
      });
      assertExactOpenedTurn(opened.state, {
        executionId: context.execution.id,
        threadId: context.thread.id,
        turnId: context.turn.id,
        rootLayerId,
      });
      const controller = createReviewSessionController(opened.session, screenshots);
      const recursiveContract = ["graph-presentation-rubric-v4", "graph-presentation-rubric-v5"]
        .includes(context.rubric?.rubricVersion);
      const evidenceOptions = {
        executionId: String(context.execution.id),
        threadId: String(context.thread.id),
        turnId: String(context.turn.id),
        comparisonTurnIds: (context.request.comparisonTurnIds ?? []).map(String),
        screenshots,
      };
      const store = recursiveContract ? new RecursivePresentationReviewStore({
        inventory,
        validateEvidence: createRecursiveScreenshotEvidenceValidator(evidenceOptions),
      }) : new IncrementalReviewStore({
        inventory,
        validateEvidence: createScreenshotEvidenceValidator(evidenceOptions),
      });
      let record;
      try {
        record = await runJudge({
          executionId: String(context.execution.id),
          originalRequest: context.request.text,
          configuration: { ...selectedConfiguration, rubric: context.rubric },
          controller,
          reviewStore: store,
          artifact: context.artifact,
          workingDirectory: context.artifact?.workingDirectory || context.artifactDirectory,
          artifactEvidence: context.artifactEvidence,
          additionalDirectories: [],
        });
      } catch (error) {
        return persistJudgeArtifacts({
          context,
          configuration: selectedConfiguration,
          rubric: context.rubric ?? DEFAULT_SIMULATED_USER_RUBRIC,
          screenshots,
          sessionTrace: opened.session.trace(),
          toolTrace: [],
          review: store.snapshot(),
          coverage: store.coverage(),
          status: "partial",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const output = await persistJudgeArtifacts({
        context,
        configuration: selectedConfiguration,
        rubric: record.rubric,
        screenshots,
        sessionTrace: opened.session.trace(),
        toolTrace: record.toolTrace,
        review: record.review,
        coverage: record.review.coverage,
        judgeRecord: record,
        status: "completed",
        error: null,
      });
      completed = true;
      return output;
    } finally {
      if (opened) {
        const lastReview = context.reviewSequence === undefined
          || context.reviewSequence.index === context.reviewSequence.count - 1;
        await opened.release({ close: !completed || lastReview });
      }
    }
  };
}

function assertExactOpenedTurn(state, expected) {
  if (
    String(state?.executionId) !== String(expected.executionId)
    || String(state?.threadId) !== String(expected.threadId)
    || String(state?.turnId) !== String(expected.turnId)
    || String(state?.layerId) !== String(expected.rootLayerId)
  ) {
    throw new Error("The production review window did not open the exact accepted turn and root layer.");
  }
}

async function persistJudgeArtifacts({
  context,
  configuration,
  rubric,
  screenshots,
  sessionTrace,
  toolTrace,
  review,
  coverage,
  judgeRecord = null,
  status,
  error,
}) {
  await mkdir(context.artifactDirectory, { recursive: true, mode: 0o700 });
  const artifacts = {
    rubric: "rubric.json",
    configuration: "judge-configuration.json",
    interactionTrace: "interaction-trace.json",
    reviews: "review.json",
    coverage: "coverage.json",
    judgeRun: "judge-run.json",
  };
  await Promise.all([
    writeJson(join(context.artifactDirectory, artifacts.rubric), rubric),
    writeJson(join(context.artifactDirectory, artifacts.configuration), configuration),
    writeJson(join(context.artifactDirectory, artifacts.interactionTrace), {
      schemaVersion: 1,
      session: sessionTrace,
      tools: toolTrace,
      codex: judgeRecord?.codexTrace ?? [],
      ...(error ? { error } : {}),
    }),
    writeJson(join(context.artifactDirectory, artifacts.reviews), review),
    writeJson(join(context.artifactDirectory, artifacts.coverage), coverage),
    writeJson(join(context.artifactDirectory, artifacts.judgeRun), judgeRecord ?? {
      schemaVersion: 1,
      executionId: context.execution.id,
      status,
      error,
    }),
  ]);
  const screenshotRefs = [...screenshots.keys()].map(
    (screenshotId) => ["screenshots", screenshotId, "metadata.json"].join("/"),
  );
  return {
    status,
    rubricRef: artifacts.rubric,
    configurationRef: artifacts.configuration,
    interactionTraceRef: artifacts.interactionTrace,
    screenshotRefs,
    reviewRef: artifacts.reviews,
    coverageRef: artifacts.coverage,
    review,
    coverage,
    summary: status === "completed" ? review.turn.summary : null,
    error,
  };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}
