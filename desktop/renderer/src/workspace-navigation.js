import { normalizeInvocationOrigin, normalizeNavigationEntry } from "./navigation-history.js";
import {
  layerPathForVisibleLayer,
  restoreLayerPath,
} from "./product-workspace/model.js";

function sameId(left, right) {
  return left != null && right != null && String(left) === String(right);
}

export function navigationEntryFromView({
  threadId,
  turnId,
  layerPath = [],
  selectedNodeId = null,
  temporalCurrent = null,
  invocationOrigin = null,
}) {
  if (threadId == null || turnId == null) return null;
  return normalizeNavigationEntry({
    threadId,
    turnId,
    navigationPath: layerPath.map((entry) => ({
      layerId: entry.layerId,
      viaActionId: entry.viaActionId ?? entry.actionId ?? null,
    })),
    selectedNodeId,
    temporalCurrent,
    ...(invocationOrigin == null ? {} : { invocationOrigin }),
  });
}

export function navigationEntryKey(entry) {
  const normalized = normalizeNavigationEntry(entry);
  const identity = [
    normalized.threadId,
    normalized.turnId,
    normalized.navigationPath.map(({ layerId, viaActionId }) => [layerId, viaActionId]),
  ];
  if (normalized.invocationOrigin != null) identity.push(normalized.invocationOrigin);
  return JSON.stringify(identity);
}

// A reading relationship to an exact call is separate from authored Navigate ancestry.
export function invocationOriginForSource(origin, sourceLayer, actionInvocations, resultTurnId) {
  let identity;
  try {
    identity = normalizeInvocationOrigin(origin, origin?.sourceEntry?.threadId);
  } catch {
    return null;
  }
  if (!identity || resultTurnId == null
    || sameId(resultTurnId, identity.sourceEntry.turnId)
    || !sameId(identity.sourceEntry.selectedNodeId, identity.sourceNodeId)
    || !sameId(sourceLayer?.layer?.id, identity.presentingLayerId)
    || sourceLayer.layer.state !== "accepted") return null;
  const node = sourceLayer.nodes?.find(node => sameId(node.id, identity.sourceNodeId) && node.state === "accepted");
  const action = sourceLayer.actions?.find(action => sameId(action.id, identity.actionId)
    && sameId(action.sourceNodeId, identity.sourceNodeId)
    && action.kind === "invoke" && action.state === "accepted");
  if (!node || !action) return null;
  const calls = (actionInvocations ?? []).filter(call => call.durable === true
    && call.preparationRejected !== true
    && sameId(call.sourceInteractionId, identity.sourceEntry.turnId)
    && sameId(call.actionId, identity.actionId)
    && call.invocationKey === identity.invocationKey
    && sameId(call.presentingLayerId, identity.presentingLayerId)
    && sameId(call.resultInteractionId, resultTurnId)
    && (call.sourceNodeId == null || sameId(call.sourceNodeId, identity.sourceNodeId)));
  if (calls.length !== 1) return null;
  return Object.freeze({ ...identity, label: node.title, icon: node.icon ?? node.metadata?.relayer?.icon ?? null });
}

export function workspaceUrlForPresentation(url, { threadId, turnId }) {
  const next = new URL(url);
  if (threadId != null) next.searchParams.set("threadId", String(threadId));
  else next.searchParams.delete("threadId");
  if (turnId != null) next.searchParams.set("interactionId", String(turnId));
  else next.searchParams.delete("interactionId");
  return next;
}

export function navigationDestinationMetadata({ thread, interaction, interactions, layerPath }) {
  const turnIndex = interactions.findIndex((candidate) => sameId(candidate.id, interaction.id));
  return Object.freeze({
    threadTitle: String(thread?.title || "Thread"),
    turnNumber: turnIndex < 0 ? null : turnIndex + 1,
    layerLabel: String(layerPath.at(-1)?.label || "Response"),
  });
}

export function navigationDestinationLabel(direction, metadata) {
  const prefix = direction === "forward" ? "Forward" : "Back";
  if (!metadata) return prefix;
  const parts = [metadata.threadTitle];
  if (metadata.turnNumber != null) parts.push(`Turn ${metadata.turnNumber}`);
  if (metadata.layerLabel) parts.push(metadata.layerLabel);
  return `${prefix} to ${parts.join(" · ")}`;
}

export function descendantLayerIdentities(entry) {
  const normalized = normalizeNavigationEntry(entry);
  return normalized.navigationPath.slice(1).map(({ layerId }) => ({
    threadId: normalized.threadId,
    turnId: normalized.turnId,
    layerId,
  }));
}

export function validateResolvedLayer(identity, layer) {
  if (!layer?.layer || !sameId(layer.layer.id, identity?.layerId)) {
    throw new Error(`Navigation history layer response did not match requested layer: ${identity?.layerId}`);
  }
  return layer;
}

export async function resolveNavigationPresentation(entry, {
  loadThread,
  loadLayer,
  layerCache,
}) {
  if (typeof loadThread !== "function" || typeof loadLayer !== "function") {
    throw new TypeError("Navigation restoration requires thread and layer loaders.");
  }
  const normalized = normalizeNavigationEntry(entry);
  const detail = await loadThread(normalized.threadId);
  const thread = detail?.thread;
  if (!thread || !sameId(thread.id, normalized.threadId)) {
    throw new Error(`Navigation history thread is unavailable: ${normalized.threadId}`);
  }
  const interactions = Array.isArray(detail.interactions) ? detail.interactions : [];
  const interaction = interactions.find((candidate) => sameId(candidate.id, normalized.turnId));
  if (!interaction) {
    throw new Error(`Navigation history turn is unavailable: ${normalized.turnId}`);
  }

  let rootLayer = interaction.completionOutput?.rootLayer ?? null;
  const loadAcceptedLayer = async (layerId, requireAccepted = false) => {
    const identity = {
      threadId: normalized.threadId,
      turnId: normalized.turnId,
      layerId,
    };
    const validate = layer => {
      const resolved = validateResolvedLayer(identity, layer);
      if (requireAccepted && resolved.layer.state !== "accepted") {
        layerCache?.delete(identity);
        throw new Error("Navigation history Current Layer is not accepted.");
      }
      return resolved;
    };
    const loadValidated = async () => validate(await loadLayer(identity));
    const layer = await (layerCache
      ? layerCache.getOrLoad(identity, loadValidated)
      : loadValidated());
    return validate(layer);
  };

  let restorationInteraction = interaction;
  if (
    normalized.temporalCurrent != null
    && normalized.navigationPath.length > 0
    && !sameId(rootLayer?.layer?.id, normalized.navigationPath[0].layerId)
  ) {
    if (!sameId(normalized.temporalCurrent.completionId, interaction.graphNodeId)) {
      throw new Error("Navigation history Current identity is unavailable.");
    }
    rootLayer = await loadAcceptedLayer(normalized.navigationPath[0].layerId, true);
    restorationInteraction = {
      ...interaction,
      completionOutput: { rootLayer },
    };
  }
  let layer = rootLayer;
  let layerPath = layerPathForVisibleLayer([], restorationInteraction, rootLayer);
  if (normalized.navigationPath.length) {
    const restored = await restoreLayerPath(
      restorationInteraction,
      normalized.navigationPath,
      loadAcceptedLayer,
      { interactions, actionInvocations: detail.actionInvocations ?? [] },
    );
    if (!restored) {
      throw new Error("Navigation history layer path is no longer available.");
    }
    layer = restored.layer;
    layerPath = restored.layerPath;
  }

  if (
    normalized.selectedNodeId !== null
    && !layer?.nodes?.some((node) => sameId(node.id, normalized.selectedNodeId))
  ) {
    throw new Error(`Navigation history node is unavailable: ${normalized.selectedNodeId}`);
  }

  const resolvedEntry = navigationEntryFromView({
    threadId: normalized.threadId,
    turnId: normalized.turnId,
    layerPath,
    selectedNodeId: normalized.selectedNodeId,
    temporalCurrent: normalized.temporalCurrent,
    invocationOrigin: normalized.invocationOrigin,
  });
  let invocationOrigin = null;
  if (normalized.invocationOrigin != null) {
    const source = await resolveNavigationPresentation(normalized.invocationOrigin.sourceEntry, {
      loadThread, loadLayer, layerCache,
    });
    invocationOrigin = invocationOriginForSource(normalized.invocationOrigin, source.layer,
      detail.actionInvocations, normalized.turnId);
    if (!invocationOrigin) throw new Error("Invocation origin source or exact call is no longer available.");
  }
  return Object.freeze({
    entry: resolvedEntry,
    thread,
    interactions,
    actionInvocations: Array.isArray(detail.actionInvocations) ? detail.actionInvocations : [],
    approvals: Array.isArray(detail.approvals) ? detail.approvals : [],
    interaction,
    layer,
    layerPath,
    selectedNodeId: normalized.selectedNodeId,
    ...(invocationOrigin == null ? {} : { invocationOrigin }),
    metadata: navigationDestinationMetadata({ thread, interaction, interactions, layerPath }),
  });
}
