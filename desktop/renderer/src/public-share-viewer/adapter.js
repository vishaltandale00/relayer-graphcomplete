import {
  appendLayerPath,
  layerPathForVisibleLayer,
  workspaceTurns,
} from "../product-workspace/model.js";

function sameId(left, right) {
  return left != null && right != null && String(left) === String(right);
}

/**
 * Keep the public browser read model deliberately boring: it owns selection
 * and navigation state, while ProductWorkspace remains the renderer of record.
 * No method below can submit an interaction, invoke an action, or change the
 * browser URL.
 */
export function createPublicViewerAdapter(snapshot) {
  if (!snapshot?.thread || !Array.isArray(snapshot.interactions) || !snapshot.interactions.length) {
    throw new Error("A public viewer requires an accepted conversation snapshot.");
  }
  const state = snapshot.state;
  const thread = snapshot.thread;
  const selection = {
    selectedScope: { kind: "standalone", label: snapshot.projectName ?? "No folder" },
    selectedPermissionProfileId: thread.permissionProfileId,
    currentThreadId: thread.id,
    currentInteractionId: state.currentInteractionId,
    mainView: "thread",
    selectedNodeId: null,
    layerPath: [],
    temporalCurrent: null,
    evalContext: null,
  };

  function turns() {
    return workspaceTurns(state, thread);
  }

  function hydrate(interaction, layer = interaction?.completionOutput?.rootLayer ?? null, layerPath = null) {
    const sameTurn = sameId(selection.currentInteractionId, interaction?.id);
    selection.layerPath = layerPath ?? layerPathForVisibleLayer(
      sameTurn ? selection.layerPath : [],
      interaction,
      layer,
    );
    if (!sameTurn) selection.selectedNodeId = null;
    selection.currentThreadId = thread.id;
    selection.currentInteractionId = interaction?.id ?? null;
    selection.temporalCurrent = null;
    state.currentInteractionId = interaction?.id ?? null;
    state.status = interaction?.completionStatus ?? "idle";
    state.visibleLayer = layer;
    state.nodes = layer?.nodes ? [...layer.nodes] : [];
    state.edges = layer?.edges ? [...layer.edges] : [];
    state.actions = layer?.actions ? [...layer.actions] : [];
  }

  function selectTurnById(interactionId) {
    const target = turns().find((interaction) => sameId(interaction.id, interactionId));
    if (!target || sameId(target.id, selection.currentInteractionId)) return false;
    hydrate(target);
    return true;
  }

  function selectTurn(delta) {
    const list = turns();
    const currentIndex = list.findIndex((interaction) => sameId(
      interaction.id,
      selection.currentInteractionId,
    ));
    const target = list[(currentIndex < 0 ? 0 : currentIndex) + delta];
    return target ? selectTurnById(target.id) : false;
  }

  async function navigateLayer(layerId, navigation = {}) {
    const interaction = turns().find((candidate) => sameId(
      candidate.id,
      selection.currentInteractionId,
    ));
    const layer = snapshot.layerFor(interaction?.id, layerId);
    if (!interaction || !layer) return false;
    const layerPath = navigation.restore
      ? selection.layerPath.slice(0, Number(navigation.pathIndex) + 1)
      : appendLayerPath(selection.layerPath, navigation.action, navigation.sourceNode);
    selection.selectedNodeId = null;
    hydrate(interaction, layer, layerPath);
    navigation.beforeCommit?.();
    return true;
  }

  async function navigateResolvedInvoke(action, { beforeCommit } = {}) {
    const sourceTurn = snapshot.turnContainingLayer(action?.targetLayerId);
    const interaction = turns().find((candidate) => sameId(candidate.id, sourceTurn?.id));
    const layer = snapshot.layerFor(sourceTurn?.id, action?.targetLayerId);
    if (!interaction || !layer) return false;
    selection.selectedNodeId = null;
    hydrate(interaction, layer);
    beforeCommit?.();
    return true;
  }

  hydrate(snapshot.interactions[0]);

  return Object.freeze({
    state,
    thread,
    selection,
    turns,
    hydrate,
    selectTurn,
    selectTurnById,
    navigateLayer,
    navigateResolvedInvoke,
    onInvokeAction: async () => false,
    onSubmitInteraction: async () => false,
    onExportConversation: null,
    readOnly: true,
  });
}
