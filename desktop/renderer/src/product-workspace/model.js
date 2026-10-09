import { singleCallResultDestination } from "../action-invocation-state.js";

export function interactionForThread(state, thread) {
  const interactions = (state.interactions || []).filter((interaction) => (
    String(interaction.threadId) === String(thread?.id)
  ));
  const interactionId = state.currentInteractionId
    ?? interactions.at(-1)?.id
    ?? thread?.rootInteractionId
    ?? thread?.rootNodeId;
  return interactions.find((interaction) => String(interaction.id) === String(interactionId))
    || state.nodes.find((node) => String(node.id) === String(interactionId));
}

export function workspaceTurns(state, thread) {
  return (state.interactions || [])
    .filter((interaction) => String(interaction.threadId) === String(thread?.id))
    .map((interaction, sourceIndex) => ({ interaction, sourceIndex }))
    .sort((left, right) => {
      const leftSequence = Number(left.interaction.sequence);
      const rightSequence = Number(right.interaction.sequence);
      if (Number.isFinite(leftSequence) && Number.isFinite(rightSequence)) {
        return leftSequence - rightSequence || left.sourceIndex - right.sourceIndex;
      }
      return left.sourceIndex - right.sourceIndex;
    })
    .map(({ interaction }) => interaction);
}

/** The results an agent launched as semantic children. They are not human turns. */
export function agentChildIds(state) {
  return new Set([
    ...(state.actionInvocations || []).filter(invocation => invocation.agentInvoked === true).map(invocation => String(invocation.resultInteractionId)),
    ...(state.importedInvocationHistory || []).filter(history => history.inert === true && history.record?.activator === "agent")
      .map(history => String(history.resultInteractionId)),
  ]);
}

/**
 * The thread's human turns in order: its messages and the user's invoke actions. A child an
 * agent launched runs beside them, so it never decides the composer's state, the next
 * turn's inherited model, or what Stop targets.
 */
export function humanTurns(state, thread) {
  const children = agentChildIds(state);
  return workspaceTurns(state, thread).filter(turn => !turn.inertInvocationCurrent && !turn.inertInvocationSource && !children.has(String(turn.id)));
}

function sameId(left, right) {
  return left != null && right != null && String(left) === String(right);
}

export function reconcileCurrentProjection(view, event) {
  if (!view || !event || !sameId(view.completionId, event.completionId)) {
    return { kind: "unrelated", view };
  }
  const knownRevision = Number(view.revision);
  const revision = Number(event.revision);
  if (!Number.isSafeInteger(revision) || revision <= knownRevision) {
    return { kind: "stale", view };
  }
  if (Number(event.previousRevision) !== knownRevision) {
    return { kind: "resync", view };
  }
  const nextTarget = event.currentLayerId == null
    ? { kind: "anchor", completionId: event.completionId, revision }
    : { kind: "layer", completionId: event.completionId, layerId: event.currentLayerId };
  const wasFollowing = view.mode === "following"
    && sameId(view.visibleTarget?.completionId, view.completionId)
    && (view.visibleTarget?.kind === "anchor"
      ? view.visibleTarget.revision === knownRevision
      : sameId(view.visibleTarget?.layerId, view.currentLayerId));
  const nextNodeIds = Array.isArray(event.currentNodeIds)
    ? new Set(event.currentNodeIds.map(String))
    : null;
  return {
    kind: wasFollowing ? "followed" : "pinned",
    history: wasFollowing ? "replace" : "unchanged",
    view: {
      ...view,
      revision,
      lifecycle: event.lifecycle,
      currentLayerId: event.currentLayerId ?? null,
      finalLayerId: event.finalLayerId ?? null,
      safeReason: event.safeReason ?? null,
      visibleTarget: wasFollowing ? nextTarget : view.visibleTarget,
      selectedNodeId: wasFollowing && view.selectedNodeId != null && nextNodeIds != null
        && !nextNodeIds.has(String(view.selectedNodeId)) ? null : view.selectedNodeId,
    },
  };
}

export function createLayerNavigationCoordinator() {
  let latestRequestId = 0;
  return Object.freeze({
    cancel() {
      latestRequestId += 1;
    },
    begin({ threadId, interactionId, layerId, layerPath }) {
      return Object.freeze({
        requestId: ++latestRequestId,
        threadId,
        interactionId,
        layerId,
        layerPath: (layerPath || []).map((entry) => ({ ...entry })),
      });
    },
    isCurrent(request, current) {
      return request?.requestId === latestRequestId
        && sameId(request.threadId, current?.threadId)
        && sameId(request.interactionId, current?.interactionId)
        && sameId(request.layerId, current?.layerId);
    },
  });
}

export function rootLayerPath(interaction) {
  const layerId = interaction?.completionOutput?.rootLayer?.layer?.id;
  return layerId == null ? [] : [{
    layerId,
    label: interaction?.completionOutput?.rootAction?.label || "Response",
    icon: interaction?.completionOutput?.rootAction?.icon || "messages-square",
    actionId: null,
    sourceNodeId: interaction?.graphNodeId ?? interaction?.id ?? null,
  }];
}

export function appendLayerPath(path, action, sourceNode, invocationResultLayerId = null) {
  const layerId = action?.kind === "navigate" ? action.targetLayerId
    : action?.kind === "invoke" && action.reusable === false ? invocationResultLayerId : null;
  if (layerId == null) return [...(path || [])];
  return [...(path || []), {
    layerId,
    label: sourceNode?.title || action.label || "Layer",
    icon: sourceNode?.icon || sourceNode?.metadata?.relayer?.icon || null,
    actionId: action.id ?? null,
    sourceNodeId: action.sourceNodeId ?? sourceNode?.id ?? null,
  }];
}

export async function restoreLayerPath(interaction, navigationPath, loadLayer, invocationState = {}) {
  const rootLayer = interaction?.completionOutput?.rootLayer;
  const path = rootLayerPath(interaction);
  if (!rootLayer || !path.length || !Array.isArray(navigationPath)) return null;
  if (!sameId(navigationPath[0]?.layerId, rootLayer.layer.id)) return null;
  let layer = rootLayer;
  for (const step of navigationPath.slice(1)) {
    const action = layer.actions?.find((candidate) => sameId(candidate.id, step.viaActionId));
    const sourceNode = layer.nodes?.find((candidate) => sameId(candidate.id, action?.sourceNodeId));
    const result = action?.kind === "invoke" && sourceNode
      ? singleCallResultDestination(invocationState, action, sourceNode, layer.actions ?? []) : null;
    if (action?.kind === "navigate" ? !sameId(action.targetLayerId, step.layerId)
      : !result || !sameId(result.layerId, step.layerId)) return null;
    path.push(appendLayerPath([], action, sourceNode, result?.layerId)[0]);
    layer = await loadLayer(step.layerId);
  }
  return { layer, layerPath: path };
}

export function layerPathForVisibleLayer(path, interaction, layer) {
  const layerId = layer?.layer?.id;
  const rootPath = rootLayerPath(interaction);
  if (layerId != null && sameId(path?.at(-1)?.layerId, layerId)) {
    // Current can be displayed before terminal output supplies its authored
    // presentation. Refresh that root entry while retaining navigated ancestry,
    // including reference paths which return to the root itself.
    return path.map((entry, index) => index === 0 && sameId(entry.layerId, rootPath[0]?.layerId)
      ? rootPath[0] : entry);
  }
  if (layerId == null || sameId(rootPath[0]?.layerId, layerId)) return rootPath;
  return [{
    layerId,
    label: "Response",
    icon: "messages-square",
    actionId: null,
    sourceNodeId: null,
  }];
}

export function workspaceBreadcrumbItems(state, thread, selection) {
  if (!thread) return [];
  const interaction = interactionForThread(state, thread);
  const path = layerPathForVisibleLayer(selection?.layerPath, interaction, state.visibleLayer);
  const origin = selection?.invocationOrigin;
  const originItems = origin == null ? [] : [{
    key: `invoke-origin:${origin.sourceEntry.turnId}:${origin.actionId}:${origin.invocationKey}`,
    kind: "invoke-origin",
    label: origin.label,
    icon: origin.icon,
    interactive: true,
    invocationOrigin: true,
    sourceEntry: origin.sourceEntry,
    layerId: origin.presentingLayerId,
    sourceLayerId: origin.presentingLayerId,
    sourceNodeId: origin.sourceNodeId,
    current: false,
  }];
  return [...originItems, ...path.map((entry, pathIndex) => ({
    key: `layer:${pathIndex}:${entry.layerId}`,
    kind: "layer",
    label: entry.label,
    icon: entry.icon,
    interactive: pathIndex < path.length - 1,
    pathIndex,
    layerId: entry.layerId,
    actionId: entry.actionId,
    sourceNodeId: entry.sourceNodeId,
    sourceLayerId: entry.sourceLayerId ?? (pathIndex === 0 ? entry.layerId : path[pathIndex - 1]?.layerId),
    current: pathIndex === path.length - 1,
  }))];
}

export function responseNodesForThread(state, thread) {
  if (state.visibleLayer?.nodes) return state.visibleLayer.nodes;
  if (state.status !== "accepted") return [];
  const interaction = interactionForThread(state, thread);
  return state.nodes.filter((node) => node.metadata?.relayer?.responseLayerOwnerNodeId === interaction?.id);
}

export function workspaceModeCapabilities(mode) {
  if (mode === "interactive") {
    return {
      canNavigate: true,
      canCompose: true,
      canInvokeMutatingActions: true,
      canExportConversation: true,
      canResolveApprovals: true,
    };
  }
  if (mode === "review") {
    return {
      canNavigate: true,
      canCompose: false,
      canInvokeMutatingActions: false,
      canExportConversation: false,
      canResolveApprovals: false,
    };
  }
  throw new Error(`Unknown product workspace mode: ${mode}`);
}

export function productWorkspaceMode({ evalReviewContext, reviewRequested, thread, interaction }) {
  return evalReviewContext || reviewRequested || thread?.imported === true
    || interaction?.inertInvocationCurrent === true || interaction?.inertInvocationSource === true ? "review" : "interactive";
}

// A graph-owned call can publish accepted progress without a Product launch row.
// This is a read presentation of that coherent native snapshot, never a Product
// interaction, execution receipt, or permission to launch/continue the child.
export function nativeInvocationCurrentPresentation(call, { threadId, sourceInteraction } = {}) {
  const native = call?.nativeInvocation;
  const invocation = native?.invocation;
  const current = native?.current;
  if (call?.graphOnly !== true || call.occupancyOnly === true || !invocation || !current
    || !sameId(sourceInteraction?.threadId, threadId)
    || !sameId(sourceInteraction?.id, call.sourceInteractionId)
    || !sameId(sourceInteraction?.graphNodeId, invocation.sourceCompletionId)
    || !sameId(invocation.sourceActionId, call.actionId)
    || invocation.invocationKey !== call.invocationKey
    || !sameId(native.sourceAction?.id, invocation.sourceActionId)
    || !sameId(native.sourceAction?.sourceNodeId, invocation.parentNodeId)
    || !sameId(native.parentNode?.id, invocation.parentNodeId)
    || !sameId(invocation.actionSnapshot?.actionId, invocation.sourceActionId)
    || !sameId(invocation.actionSnapshot?.sourceNodeId, invocation.parentNodeId)
    || !sameId(invocation.state?.completionId, invocation.childInteractionNodeId)
    || !sameId(current.nodeId, invocation.childInteractionNodeId)
    || !sameId(current.rootLayerId, invocation.state?.currentLayerId)) return null;
  const layers = new Map((current.layers ?? []).map(layer => [String(layer.layer?.id), layer]));
  const rootLayer = layers.get(String(current.rootLayerId));
  if (!rootLayer || [...layers.values()].some(layer => layer.layer?.state !== "accepted")) return null;
  const lifecycleStatus = { active: "running", succeeded: "accepted", stopped: "stopped", failed: "failed" }[invocation.state.lifecycle];
  if (!lifecycleStatus || lifecycleStatus !== call.resultCompletionStatus) return null;
  return {
    interaction: {
      id: `native-current:${invocation.id}`, threadId,
      inertInvocationCurrent: true, nativeInvocationCurrent: true,
      invocationId: invocation.id, invocationKey: invocation.invocationKey,
      invocationSourceInteractionId: call.sourceInteractionId,
      graphNodeId: invocation.childInteractionNodeId,
      sequence: sourceInteraction.sequence,
      text: `${invocation.actionSnapshot.label || native.sourceAction.label || "Invoke"} · ${lifecycleStatus === "accepted" ? "Result" : "Current"}`,
      completionStatus: lifecycleStatus,
      completionOutput: { nodeId: current.nodeId, rootAction: current.rootAction, rootLayer },
      submittedInputs: native.submittedInputs ?? [], safeReason: invocation.state.safeReason ?? null,
      interactionGraph: { enabled: true, complete: true, sources: [{
        interactionId: sourceInteraction.id, threadId, invocationActionId: call.actionId,
        contexts: [], message: invocation.actionSnapshot.label || native.sourceAction.label || "Invoke",
      }] },
    },
    layers,
  };
}

export function productWorkspaceNeedsRecreation(currentMode, nextMode) {
  return currentMode !== undefined && currentMode !== nextMode;
}

export function shouldPollThreadInteractions(thread, interactions) {
  if (!thread || thread.imported === true) return false;
  return (interactions || []).some((interaction) => (
    String(interaction.threadId) === String(thread.id)
    && ["not_started", "running", "submitted", "waiting_for_approval"].includes(interaction.completionStatus)
  ));
}
