import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { inputActionReviewRef, inputOccurrenceKey } from "../renderer/src/node-input-controls.js";

export const LOCAL_SIMULATED_USER_JUDGE_CONFIGURATION = Object.freeze({
  model: "gpt-5.6-sol",
  modelReasoningEffort: "high",
});

export const LOCAL_SIMULATED_USER_AUTORUN_ENV = "RELAYER_EVAL_AUTORUN_H3_SIMULATED_USER";
export const LOCAL_SIMULATED_USER_AUTORUN_FLAG = "--relayer-eval-autorun-h3-simulated-user";
export const PERSONAL_PRESENTATION_AUTORUN_ENV = "RELAYER_EVAL_AUTORUN_PERSONAL_PRESENTATION";
export const PERSONAL_PRESENTATION_AUTORUN_FLAG = "--relayer-eval-autorun-personal-presentation";
export const PRODUCT_PRESENTATION_AUTORUN_ENV = "RELAYER_EVAL_AUTORUN_PRODUCT_PRESENTATION";
export const PRODUCT_PRESENTATION_AUTORUN_FLAG = "--relayer-eval-autorun-product-presentation";
export const INPUT_ROUNDTRIP_AUTORUN_ENV = "RELAYER_EVAL_AUTORUN_INPUT_ROUNDTRIP";
export const INPUT_ROUNDTRIP_AUTORUN_FLAG = "--relayer-eval-autorun-input-roundtrip";

export function operatorInteractionIsTerminal(status) {
  return ["accepted", "failed", "cancelled", "stopped"].includes(status);
}

export function groundingRootNodeIds(interaction) {
  return (interaction?.completionOutput?.rootLayer?.nodes ?? [])
    .map((node) => String(node?.id ?? ""))
    .filter(Boolean);
}

export function groundingCaptureTargets(topology) {
  const layers = new Map((topology?.layers || []).map((layer) => [String(layer.id), layer]));
  const rootLayerId = String(topology?.rootLayerId ?? "");
  if (!rootLayerId || !layers.has(rootLayerId)) return [];
  const pending = [{ layerId: rootLayerId, path: [] }];
  const visited = new Set();
  const targets = [];
  for (let index = 0; index < pending.length; index += 1) {
    const entry = pending[index];
    if (visited.has(entry.layerId)) continue;
    visited.add(entry.layerId);
    const layer = layers.get(entry.layerId);
    targets.push({
      layerId: entry.layerId,
      nodeIds: (layer?.nodeIds || []).map(String),
      path: entry.path,
    });
    for (const action of layer?.actions || []) {
      if (action.kind !== "navigate") continue;
      const targetLayerId = String(action.targetLayerId ?? "");
      if (!layers.has(targetLayerId) || visited.has(targetLayerId)) continue;
      pending.push({
        layerId: targetLayerId,
        path: [...entry.path, {
          sourceNodeId: String(action.sourceNodeId),
          actionId: String(action.id),
        }],
      });
    }
  }
  return targets;
}

export async function buildInputGroundingTopology({ threadId, interaction, loadLayer }) {
  const rootLayerId = interaction?.completionOutput?.rootLayer?.layer?.id;
  if (!rootLayerId) {
    throw new Error("Accepted input response has no visible root layer.");
  }
  return buildAcceptedReviewTopology({
    turnId: interaction.id,
    presentingInteractionNodeId: interaction.graphNodeId,
    rootLayerId,
    loadLayer: (layerId) => loadLayer({
      threadId,
      turnId: interaction.id,
      layerId,
    }),
  });
}

export async function captureGroundingTargets(session, targets) {
  const captures = [];
  const activateNode = async (nodeId) => {
    const state = await session.state();
    if (String(state.selectedNodeId ?? "") === String(nodeId)) return;
    await session.interact({ elementRef: `node-${nodeId}`, activate: true });
  };
  for (const target of targets) {
    for (const step of target.path) {
      await activateNode(step.sourceNodeId);
      await session.interact({ elementRef: `action-${step.actionId}`, activate: true });
    }
    for (const [index, nodeId] of target.nodeIds.entries()) {
      await activateNode(nodeId);
      captures.push(await session.screenshot({
        target: { kind: "element", elementRef: "node-detail" },
        mode: "full",
        label: `Input round-trip response layer ${target.layerId} node ${index + 1}`,
      }));
    }
    if (target.path.length > 0) await session.history({ delta: -target.path.length });
  }
  return captures;
}

export function createInputOperatorLease({ operator, revoke }) {
  if (!operator || typeof revoke !== "function") {
    throw new Error("Input operator lease requires an operator and revocation callback.");
  }
  let released = false;
  let releaseAttempt = null;
  return Object.freeze({
    operator,
    release: async () => {
      if (released) return;
      releaseAttempt ??= Promise.resolve()
        .then(revoke)
        .then(() => { released = true; })
        .finally(() => { releaseAttempt = null; });
      await releaseAttempt;
    },
  });
}

export async function releaseInputOperatorLease(lease) {
  if (!lease?.release) return;
  try {
    await lease.release();
  } catch {
    await lease.release();
  }
}

export function resolveLocalSimulatedUserAutorun({
  environment = process.env,
  arguments: commandLineArguments = process.argv,
  packaged = false,
  availableHarnessConfigurationNames,
} = {}) {
  const personalPresentationEnabled = environment[PERSONAL_PRESENTATION_AUTORUN_ENV] === "1"
    || commandLineArguments.includes(PERSONAL_PRESENTATION_AUTORUN_FLAG);
  const productPresentationEnabled = environment[PRODUCT_PRESENTATION_AUTORUN_ENV] === "1"
    || commandLineArguments.includes(PRODUCT_PRESENTATION_AUTORUN_FLAG);
  const enabled = environment[LOCAL_SIMULATED_USER_AUTORUN_ENV] === "1"
    || commandLineArguments.includes(LOCAL_SIMULATED_USER_AUTORUN_FLAG);
  const inputRoundTripEnabled = environment[INPUT_ROUNDTRIP_AUTORUN_ENV] === "1"
    || commandLineArguments.includes(INPUT_ROUNDTRIP_AUTORUN_FLAG);
  if (!enabled && !personalPresentationEnabled && !productPresentationEnabled && !inputRoundTripEnabled) return null;
  if ([enabled, personalPresentationEnabled, productPresentationEnabled, inputRoundTripEnabled].filter(Boolean).length > 1) {
    throw new Error("Select only one local simulated-user autorun.");
  }
  if (packaged) throw new Error("The simulated-user autorun is available only in a local development checkout.");
  if (inputRoundTripEnabled) {
    const availableHarnesses = availableHarnessConfigurationNames === undefined
      ? null
      : new Set(availableHarnessConfigurationNames);
    if (availableHarnesses !== null && !availableHarnesses.has("codex-basic")) {
      throw new Error("The input round-trip autorun requires codex-basic.");
    }
    return {
      testCaseIds: ["empty-project.node-input-roundtrip.single-turn"],
      harnessConfigurationNames: ["codex-basic"],
      judgeConfigurationName: "simulated-user-sol-high",
    };
  }
  if (productPresentationEnabled) {
    const harnessConfigurationNames = ["codex-basic"];
    const availableHarnesses = availableHarnessConfigurationNames === undefined
      ? null
      : new Set(availableHarnessConfigurationNames);
    if (availableHarnesses !== null && !availableHarnesses.has("codex-basic")) {
      throw new Error("The product presentation autorun requires codex-basic.");
    }
    return {
      testCaseIds: ["empty-project.task-system.single-turn"],
      harnessConfigurationNames,
      judgeConfigurationName: "simulated-user-sol-high",
    };
  }
  if (personalPresentationEnabled) {
    const harnessConfigurationNames = [
      "codex-layered-personal-presentation-v0",
      "codex-layered-personal-presentation-v1",
    ];
    const availableHarnesses = availableHarnessConfigurationNames === undefined
      ? null
      : new Set(availableHarnessConfigurationNames);
    if (availableHarnesses !== null
      && harnessConfigurationNames.some((name) => !availableHarnesses.has(name))) {
      throw new Error("The personal presentation autorun requires both V0 and V1 Eval configurations.");
    }
    return {
      testCaseIds: ["empty-project.task-system.single-turn"],
      harnessConfigurationNames,
      judgeConfigurationName: "simulated-user-sol-high",
    };
  }
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

export function createReviewSessionController(reviewSession, screenshotMetadata, {
  inputOperator,
  inputBindings = new Map(),
  persistInputRatingReceipt,
} = {}) {
  if (!reviewSession?.screenshot || !reviewSession?.interact || !reviewSession?.history) {
    throw new Error("Simulated-user review requires a complete ReviewSession controller.");
  }
  const captureByScreenshot = new Map();
  const commissionedByOccurrence = new Map();
  const committedOccurrences = new Set();
  const operatorEvents = [];
  const inputRatingReceiptRefs = [];
  let pendingRendererAcknowledgement = null;
  const acknowledgeOperatorWrite = async (pending) => {
    pending.event.rendererAcknowledgement = {
      status: "pending",
      attempts: pending.attempts + 1,
    };
    try {
      await reviewSession.setInputOperatorCommitted?.(pending.committed);
      const state = await reviewSession.state();
      pending.attempts += 1;
      pending.event.rendererAcknowledgement = {
        status: "completed",
        attempts: pending.attempts,
      };
      pendingRendererAcknowledgement = null;
      return { ...pending.result, state: reviewUiStateForOperator(state) };
    } catch (error) {
      pending.attempts += 1;
      pending.event.rendererAcknowledgement = {
        status: "failed",
        attempts: pending.attempts,
        error: error instanceof Error ? error.message : String(error),
      };
      pendingRendererAcknowledgement = pending;
      throw new Error(
        `The product ${pending.event.operation} succeeded, but renderer acknowledgement failed; retry this exact interaction to acknowledge it without repeating the write: ${pending.event.rendererAcknowledgement.error}`,
        { cause: error },
      );
    }
  };
  return Object.freeze({
    screenshot: async (input) => {
      const binding = input.target?.kind === "element" ? inputBindings.get(input.target.elementRef) : undefined;
      let operatorCapture = null;
      if (binding && inputOperator) {
        const state = await reviewSession.state();
        operatorCapture = inputOperator.beginCapture({
          occurrence: binding.occurrence,
          action: binding.action,
          threadRevision: state.threadRevision,
        });
      }
      let capturedScreenshotId;
      try {
        const output = await reviewSession.screenshot(input);
        if (!output?.ok) {
          const failedCapture = operatorCapture;
          operatorCapture = null;
          if (failedCapture) inputOperator.failCapture(failedCapture.captureId);
          return { output, images: [] };
        }
        const screenshot = output.screenshot;
        capturedScreenshotId = screenshot.screenshotId;
        if (operatorCapture) {
          captureByScreenshot.set(screenshot.screenshotId, {
            captureId: operatorCapture.captureId,
            occurrence: structuredClone(binding.occurrence),
          });
        }
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
      } catch (error) {
        if (operatorCapture) {
          inputOperator.failCapture(operatorCapture.captureId);
          if (capturedScreenshotId !== undefined) {
            captureByScreenshot.delete(capturedScreenshotId);
            screenshotMetadata.delete(capturedScreenshotId);
          }
        }
        throw error;
      }
    },
    interact: async (input) => {
      const interactionKey = canonicalOperatorInteractionKey(input);
      if (pendingRendererAcknowledgement) {
        if (pendingRendererAcknowledgement.interactionKey !== interactionKey) {
          throw new Error("Retry the operator interaction whose renderer acknowledgement is pending.");
        }
        return acknowledgeOperatorWrite(pendingRendererAcknowledgement);
      }
      if (input.value !== undefined) {
        if (!inputOperator) throw new Error("This review has no separately authorized input operator.");
        const binding = inputBindings.get(input.elementRef);
        if (!binding) throw new Error(`Interact value requires a visible input-action target: ${input.elementRef}`);
        const captureId = commissionedByOccurrence.get(inputOccurrenceKey(binding.occurrence));
        if (!captureId) throw new Error("Input-action quality must be rated before the operator is commissioned.");
        const value = "text" in input.value
          ? { text: input.value.text }
          : "selectedKey" in input.value
            ? { selectedKeys: [input.value.selectedKey] }
            : { selectedKeys: input.value.selectedKeys };
        const committedValue = "text" in value
          ? { text: value.text }
          : {
              selected: binding.action.options
                .filter((option) => value.selectedKeys.includes(option.key))
                .sort((left, right) => Buffer.from(left.key).compare(Buffer.from(right.key))),
            };
        const inputDraftRevision = await inputOperator.commit({ captureId, value });
        committedOccurrences.add(inputOccurrenceKey(binding.occurrence));
        const event = {
          operation: "input_commit",
          elementRef: input.elementRef,
          occurrence: structuredClone(binding.occurrence),
          sourceNodeId: binding.sourceNodeId,
          action: structuredClone(binding.action),
          value: structuredClone(committedValue),
          inputDraftRevision,
        };
        operatorEvents.push(event);
        return acknowledgeOperatorWrite({
          interactionKey,
          committed: true,
          event,
          attempts: 0,
          result: { ok: true, operator: { operation: "input_commit", inputDraftRevision } },
        });
      }
      if (input.elementRef === "send-interaction" && inputOperator) {
        const before = await reviewSession.state();
        const control = before.controls?.find((candidate) => candidate.elementRef === input.elementRef);
        if (!control || control.kind !== "input-operator-send") {
          throw new Error("The production review has no visible operator Send control.");
        }
        if (committedOccurrences.size === 0) {
          throw new Error("The input operator requires at least one committed input before Send.");
        }
        if (control.disabled) throw new Error("The production review operator Send control is disabled.");
        const response = await inputOperator.send({});
        committedOccurrences.clear();
        const event = { operation: "send", response: structuredClone(response) };
        operatorEvents.push(event);
        return acknowledgeOperatorWrite({
          interactionKey,
          committed: false,
          event,
          attempts: 0,
          result: { ok: true, operator: { operation: "send", response } },
        });
      }
      return reviewSession.interact(input);
    },
    history: (input) => reviewSession.history(input),
    recordInputRatings: async ({ review, revision }) => {
      if (!inputOperator) return;
      if (typeof persistInputRatingReceipt !== "function") {
        throw new Error("Input operator commission requires durable rating receipt storage.");
      }
      const commissions = [];
      for (const action of review.actions ?? []) {
        if (action.kind !== "input") continue;
        const screenshotIds = [...new Set([
          ...(action.evidence ?? []),
          ...Object.values(action.inputActionJudgments ?? {}).flatMap((judgment) => judgment.evidence ?? []),
        ])];
        const citedScreenshotIds = new Set(screenshotIds);
        const operatorCaptureState = inputOperator.state?.();
        const activeCaptureIds = new Set((operatorCaptureState?.captures ?? [])
          .filter(({ status }) => status === "capturing")
          .map(({ captureId }) => captureId));
        const capture = [...captureByScreenshot.entries()]
          .filter(([screenshotId, candidate]) => citedScreenshotIds.has(screenshotId)
            && String(candidate.occurrence.actionId) === String(action.actionId)
            && String(candidate.occurrence.presentingLayerId) === String(review.layerId)
            && (operatorCaptureState === undefined || activeCaptureIds.has(candidate.captureId)))
          .map(([, candidate]) => candidate)
          .findLast(() => true);
        if (!capture) throw new Error(`Input action ${action.actionId} has no occurrence-matched versioned capture-and-rate lock.`);
        const { captureId } = capture;
        const capturedScreenshotId = screenshotIds.find((id) => captureByScreenshot.get(id)?.captureId === captureId);
        const metadata = capturedScreenshotId === undefined ? undefined : screenshotMetadata.get(capturedScreenshotId);
        if (!metadata?.threadRevision) {
          throw new Error(`Input action ${action.actionId} rating is missing its captured thread revision.`);
        }
        commissions.push({
          captureId,
          threadRevision: metadata.threadRevision,
          actionId: String(action.actionId),
          occurrence: structuredClone(capture.occurrence),
        });
      }
      if (commissions.length === 0) return;
      const persistedReceipt = await persistInputRatingReceipt({
        schemaVersion: 1,
        reviewRevision: revision,
        review: structuredClone(review),
        captures: commissions.map(({ captureId, threadRevision, actionId, occurrence }) => ({
          captureId,
          threadRevision,
          actionId,
          occurrence,
        })),
      });
      const receiptId = typeof persistedReceipt === "string"
        ? persistedReceipt
        : persistedReceipt?.ref;
      if (typeof receiptId !== "string" || !receiptId) {
        throw new Error("Input rating receipt storage returned no durable reference.");
      }
      try {
        inputOperator.rateCaptures(commissions.map(({ captureId, threadRevision }) => ({
          captureId,
          ratingId: receiptId,
          threadRevision,
        })));
      } catch (error) {
        await persistedReceipt?.discard?.();
        throw error;
      }
      inputRatingReceiptRefs.push(receiptId);
      for (const { occurrence, captureId } of commissions) {
        commissionedByOccurrence.set(inputOccurrenceKey(occurrence), captureId);
      }
    },
    operatorTrace: () => structuredClone(operatorEvents),
    inputRatingReceiptRefs: () => [...inputRatingReceiptRefs],
  });
}

function canonicalOperatorInteractionKey(input) {
  const canonicalize = (value) => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  };
  return JSON.stringify(canonicalize(input));
}

function reviewUiStateForOperator(state) {
  return {
    threadRevision: state.threadRevision,
    turnId: state.turnId,
    layerId: state.layerId,
    selectedNodeId: state.selectedNodeId,
    activatedActionId: state.activatedActionId,
    navigationPath: structuredClone(state.navigationPath),
  };
}

export async function buildAcceptedReviewTopology({ turnId, presentingInteractionNodeId, rootLayerId, loadLayer }) {
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
      if (action.kind === "invoke") return base;
      if (action.kind === "input") {
        if (!["text", "single_select", "multi_select"].includes(action.control)) {
          throw new Error(`Accepted input action has no valid control: ${action.id}`);
        }
        if (typeof action.prompt !== "string" || action.prompt.trim() === "") {
          throw new Error(`Accepted input action has no prompt: ${action.id}`);
        }
        const options = Array.isArray(action.options)
          ? action.options.map((option) => ({ key: String(option.key), label: String(option.label) }))
          : [];
        if (action.control === "text" && options.length !== 0) {
          throw new Error(`Accepted text input action unexpectedly has options: ${action.id}`);
        }
        if (action.control !== "text" && options.length === 0) {
          throw new Error(`Accepted select input action has no options: ${action.id}`);
        }
        const occurrence = presentingInteractionNodeId === undefined ? undefined : {
          presentingInteractionNodeId: Number(presentingInteractionNodeId),
          presentingLayerId: Number(layerId),
          actionId: Number(action.id),
        };
        if (occurrence !== undefined && !Object.values(occurrence).every((id) => Number.isSafeInteger(id) && id > 0)) {
          throw new Error(`Accepted input action ${action.id} has no valid product occurrence identity.`);
        }
        return {
          ...base,
          control: action.control,
          prompt: action.prompt,
          options,
          ...(occurrence === undefined ? {} : { occurrence }),
          ...(action.minimumSelections === null || action.minimumSelections === undefined
            ? {}
            : { minimumSelections: action.minimumSelections }),
        };
      }
      throw new Error(`Unknown accepted action kind: ${action.kind}`);
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
  resolveCodexRuntime,
  runJudge = runSimulatedUserJudge,
  configuration = LOCAL_SIMULATED_USER_JUDGE_CONFIGURATION,
  createInputOperator,
  captureInputRoundTrip,
}) {
  if (typeof loadLayer !== "function" || typeof openReviewSession !== "function"
    || typeof resolveCodexRuntime !== "function" || typeof runJudge !== "function") {
    throw new Error("Local simulated-user judge integration is incomplete.");
  }
  const selectedConfiguration = structuredClone(configuration);
  return async (context) => {
    const rootLayerId = String(context.turn.rootLayerId ?? "");
    if (!rootLayerId) throw new Error("Accepted turn has no root layer for simulated-user review.");
    const topology = await buildAcceptedReviewTopology({
      turnId: context.turn.id,
      presentingInteractionNodeId: context.turn.graphNodeId,
      rootLayerId,
      loadLayer: (layerId) => loadLayer({
        executionId: context.execution.id,
        threadId: context.thread.id,
        turnId: context.turn.id,
        layerId,
      }),
    });
    const inventory = inventoryReviewSubjects(topology);
    const inputBindings = new Map(inventory.actions.flatMap((subject) => (
        subject.actionKind !== "input" || subject.occurrence === undefined ? [] : [[
          inputActionReviewRef(subject.occurrence),
          {
            occurrence: subject.occurrence,
            sourceNodeId: Number(subject.nodeId),
            action: subject.control === "text"
              ? { control: "text", prompt: subject.prompt }
              : {
                  control: subject.control,
                  prompt: subject.prompt,
                  options: subject.options,
                  ...(subject.control === "multi_select" && subject.minimumSelections !== undefined
                    ? { minimumSelections: subject.minimumSelections }
                    : {}),
                },
          },
        ]]
      )));
    const screenshots = new Map();
    let opened;
    let inputOperatorLease;
    let completed = false;
    try {
      inputOperatorLease = typeof createInputOperator === "function" && context.allowInputOperator === true
        ? await createInputOperator({ context, inputBindings })
        : undefined;
      const inputOperator = inputOperatorLease?.operator ?? inputOperatorLease;
      opened = await openReviewSession({
        executionId: context.execution.id,
        threadId: context.thread.id,
        turnId: context.turn.id,
        rootLayerId,
        artifactDirectory: join(context.artifactDirectory, "screenshots"),
        inputOperatorAvailable: Boolean(inputOperator),
      });
      assertExactOpenedTurn(opened.state, {
        executionId: context.execution.id,
        threadId: context.thread.id,
        turnId: context.turn.id,
        rootLayerId,
      });
      const controller = createReviewSessionController(opened.session, screenshots, {
        inputOperator,
        inputBindings,
        persistInputRatingReceipt: (receipt) => persistInputRatingReceipt(context, receipt),
      });
      const rubricVersion = context.rubric?.rubricVersion;
      if (["graph-presentation-rubric-v4", "graph-presentation-rubric-v5", "graph-presentation-rubric-v6", "graph-presentation-rubric-v7", "graph-presentation-rubric-v8", "graph-presentation-rubric-v9", "graph-presentation-rubric-v10"].includes(rubricVersion)) {
        throw new Error(`Historical rubric ${rubricVersion} remains readable but cannot start a new v6 judgment.`);
      }
      const recursiveContract = rubricVersion === "graph-presentation-rubric-v11";
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
        const codexRuntime = await resolveCodexRuntime();
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
          codexPathOverride: codexRuntime.executable,
          environment: codexRuntime.environment,
          inputOperatorAvailable: Boolean(inputOperator),
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
          inputRatingReceiptRefs: controller.inputRatingReceiptRefs(),
        });
      }
      let inputRoundTrip = null;
      if (typeof captureInputRoundTrip === "function") {
        try {
          inputRoundTrip = await captureInputRoundTrip({
            context,
            topology,
            operatorTrace: controller.operatorTrace(),
            artifactDirectory: join(context.artifactDirectory, "input-roundtrip"),
          });
        } catch (error) {
          inputRoundTrip = {
            schemaVersion: 1,
            status: "failed",
            passed: false,
            checks: [],
            detail: "The completed presentation review was retained, but input round-trip evidence capture failed.",
            error: error instanceof Error ? error.message : String(error),
          };
        }
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
        inputRoundTrip,
        inputRatingReceiptRefs: controller.inputRatingReceiptRefs(),
      });
      completed = true;
      return output;
    } finally {
      try {
        await releaseInputOperatorLease(inputOperatorLease);
      } finally {
        if (opened) {
          const lastReview = context.reviewSequence === undefined
            || context.reviewSequence.index === context.reviewSequence.count - 1;
          await opened.release({ close: !completed || lastReview });
        }
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
  inputRoundTrip = null,
  inputRatingReceiptRefs = [],
}) {
  await mkdir(context.artifactDirectory, { recursive: true, mode: 0o700 });
  const artifacts = {
    rubric: "rubric.json",
    configuration: "judge-configuration.json",
    interactionTrace: "interaction-trace.json",
    reviews: "review.json",
    coverage: "coverage.json",
    judgeRun: "judge-run.json",
    ...(inputRoundTrip === null ? {} : { inputRoundTrip: "input-roundtrip.json" }),
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
    ...(inputRoundTrip === null ? [] : [writeJson(
      join(context.artifactDirectory, artifacts.inputRoundTrip),
      inputRoundTrip,
    )]),
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
    ...(inputRoundTrip === null ? {} : {
      inputRoundTripRef: artifacts.inputRoundTrip,
      inputRoundTrip,
    }),
    inputRatingReceiptRefs: [...inputRatingReceiptRefs],
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

export async function parseProductWriteResponse(
  response,
  { requireJson = false, requirePositiveInteractionId = false } = {},
) {
  let value;
  try {
    value = await response.json();
  } catch (error) {
    if (response.ok && requireJson) {
      throw new Error("Input operator product response did not contain valid JSON.", { cause: error });
    }
  }
  if (!response.ok) {
    throw new Error(value?.error || `Input operator product request failed (${response.status}).`);
  }
  if (requirePositiveInteractionId
    && (!Number.isSafeInteger(value?.id) || value.id < 1)) {
    throw new Error("Input operator product response requires a positive interaction id.");
  }
  return value;
}

export async function persistInputRatingReceipt(context, receipt) {
  const nodeId = String(receipt.review?.nodeId ?? "");
  const presentingLayerId = String(receipt.review?.layerId ?? "");
  if (!/^\d+$/.test(nodeId) || !/^\d+$/.test(presentingLayerId)
    || !Number.isSafeInteger(receipt.reviewRevision) || receipt.reviewRevision < 1) {
    throw new Error("Input rating receipt requires a positive presenting layer, node, and review revision.");
  }
  const directoryName = "input-rating-receipts";
  const filename = `layer-${presentingLayerId}-node-${nodeId}-revision-${receipt.reviewRevision}.json`;
  await mkdir(join(context.artifactDirectory, directoryName), { recursive: true, mode: 0o700 });
  const path = join(context.artifactDirectory, directoryName, filename);
  await writeJson(path, {
    ...receipt,
    executionId: String(context.execution.id),
    threadId: String(context.thread.id),
    turnId: String(context.turn.id),
  });
  return {
    ref: `${directoryName}/${filename}`,
    discard: () => rm(path, { force: true }),
  };
}
