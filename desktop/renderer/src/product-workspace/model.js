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
