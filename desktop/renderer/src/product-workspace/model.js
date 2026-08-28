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
    label: "Response",
    icon: interaction?.completionOutput?.rootAction?.icon || "messages-square",
    actionId: null,
    sourceNodeId: interaction?.graphNodeId ?? interaction?.id ?? null,
  }];
}

export function appendLayerPath(path, action, sourceNode) {
  if (action?.kind !== "navigate" || action.targetLayerId == null) return [...(path || [])];
  return [...(path || []), {
    layerId: action.targetLayerId,
    label: sourceNode?.title || action.label || "Layer",
    icon: sourceNode?.icon || sourceNode?.metadata?.relayer?.icon || null,
    actionId: action.id ?? null,
    sourceNodeId: action.sourceNodeId ?? sourceNode?.id ?? null,
  }];
}

export async function restoreLayerPath(interaction, navigationPath, loadLayer) {
  const rootLayer = interaction?.completionOutput?.rootLayer;
  const path = rootLayerPath(interaction);
  if (!rootLayer || !path.length || !Array.isArray(navigationPath)) return null;
  if (!sameId(navigationPath[0]?.layerId, rootLayer.layer.id)) return null;
  let layer = rootLayer;
  for (const step of navigationPath.slice(1)) {
    const action = layer.actions?.find((candidate) => sameId(candidate.id, step.viaActionId));
    if (
      action?.kind !== "navigate"
      || !sameId(action.targetLayerId, step.layerId)
    ) return null;
    const sourceNode = layer.nodes?.find((candidate) => sameId(candidate.id, action.sourceNodeId));
    path.push(appendLayerPath([], action, sourceNode)[0]);
    layer = await loadLayer(step.layerId);
  }
  return { layer, layerPath: path };
}

export function layerPathForVisibleLayer(path, interaction, layer) {
  const layerId = layer?.layer?.id;
  if (layerId != null && sameId(path?.at(-1)?.layerId, layerId)) return [...path];
  const rootPath = rootLayerPath(interaction);
  if (layerId == null || sameId(rootPath[0]?.layerId, layerId)) return rootPath;
  return [{
    layerId,
    label: "Layer",
    icon: null,
    actionId: null,
    sourceNodeId: null,
  }];
}

export function workspaceBreadcrumbItems(state, thread, selection) {
  if (!thread) return [];
  const interaction = interactionForThread(state, thread);
  const path = layerPathForVisibleLayer(selection?.layerPath, interaction, state.visibleLayer);
  return path.map((entry, pathIndex) => ({
    key: `layer:${pathIndex}:${entry.layerId}`,
    kind: "layer",
    label: entry.label,
    icon: entry.icon,
    interactive: pathIndex < path.length - 1,
    pathIndex,
    layerId: entry.layerId,
    actionId: entry.actionId,
    sourceNodeId: entry.sourceNodeId,
    current: pathIndex === path.length - 1,
  }));
}

export function responseNodesForThread(state, thread) {
  if (state.status !== "accepted") return [];
  if (state.visibleLayer?.nodes) return state.visibleLayer.nodes;
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

export function productWorkspaceMode({ evalReviewContext, reviewRequested, thread }) {
  return evalReviewContext || reviewRequested || thread?.imported === true ? "review" : "interactive";
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
