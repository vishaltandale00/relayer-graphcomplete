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

function sameId(left, right) {
  return left != null && right != null && String(left) === String(right);
}

export function rootLayerPath(interaction) {
  const layerId = interaction?.completionOutput?.rootLayer?.layer?.id;
  return layerId == null ? [] : [{
    layerId,
    label: "Response",
    actionId: null,
    sourceNodeId: interaction?.graphNodeId ?? interaction?.id ?? null,
  }];
}

export function appendLayerPath(path, action, sourceNode) {
  if (action?.kind !== "navigate" || action.targetLayerId == null) return [...(path || [])];
  return [...(path || []), {
    layerId: action.targetLayerId,
    label: sourceNode?.title || action.label || "Layer",
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
    actionId: null,
    sourceNodeId: null,
  }];
}

function evalLocationForThread(evalContext, threadId) {
  for (const testCase of evalContext?.cases || []) {
    const reviewThread = testCase.threads?.find((candidate) => sameId(candidate.id, threadId));
    if (reviewThread || testCase.threadIds?.some((candidate) => sameId(candidate, threadId))) {
      return { testCase, reviewThread };
    }
  }
  return { testCase: null, reviewThread: null };
}

export function workspaceBreadcrumbItems(state, thread, selection) {
  if (!thread) return [];
  const interaction = interactionForThread(state, thread);
  const turns = (state.interactions || []).filter((candidate) => sameId(candidate.threadId, thread.id));
  const turnIndex = turns.findIndex((candidate) => sameId(candidate.id, interaction?.id));
  const selectedNode = (state.nodes || []).find((node) => sameId(node.id, selection?.selectedNodeId));
  const { testCase: evalCase, reviewThread } = evalLocationForThread(
    selection?.evalContext,
    thread.id,
  );
  const project = (state.projects || []).find((candidate) => sameId(candidate.id, thread.projectId));
  const path = layerPathForVisibleLayer(selection?.layerPath, interaction, state.visibleLayer);
  const hasNode = Boolean(selectedNode);

  const items = [
    {
      key: `scope:${evalCase?.id ?? project?.id ?? "standalone"}`,
      kind: evalCase ? "eval-case" : "project",
      label: evalCase?.name || project?.name || "No project",
      interactive: false,
    },
    {
      key: `thread:${thread.id}`,
      kind: "thread",
      label: reviewThread?.name || thread.title || "Untitled thread",
      interactive: false,
    },
  ];

  if (interaction) {
    items.push({
      key: `turn:${interaction.id}`,
      kind: "turn",
      label: turnIndex >= 0 ? `Turn ${turnIndex + 1}` : "Turn",
      description: interaction.text || interaction.summary || interaction.content || "",
      interactive: path.length > 1 || hasNode,
      pathIndex: 0,
      layerId: path[0]?.layerId ?? null,
    });
  }

  path.forEach((entry, pathIndex) => {
    items.push({
      key: `layer:${pathIndex}:${entry.layerId}`,
      kind: "layer",
      label: entry.label,
      interactive: pathIndex < path.length - 1 || hasNode,
      pathIndex,
      layerId: entry.layerId,
      actionId: entry.actionId,
      sourceNodeId: entry.sourceNodeId,
    });
  });

  if (selectedNode) {
    items.push({
      key: `node:${selectedNode.id}`,
      kind: "node",
      label: selectedNode.title || "Selected node",
      interactive: false,
      nodeId: selectedNode.id,
    });
  }

  return items.map((item, index) => ({
    ...item,
    current: index === items.length - 1,
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
    };
  }
  if (mode === "review") {
    return {
      canNavigate: true,
      canCompose: false,
      canInvokeMutatingActions: false,
    };
  }
  throw new Error(`Unknown product workspace mode: ${mode}`);
}
