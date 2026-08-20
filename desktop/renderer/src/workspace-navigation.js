import { normalizeNavigationEntry } from "./navigation-history.js";
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
  });
}

export function navigationEntryKey(entry) {
  const normalized = normalizeNavigationEntry(entry);
  return JSON.stringify([
    normalized.threadId,
    normalized.turnId,
    normalized.navigationPath.map(({ layerId, viaActionId }) => [layerId, viaActionId]),
  ]);
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

  const rootLayer = interaction.completionOutput?.rootLayer ?? null;
  const loadAcceptedLayer = async (layerId) => {
    const identity = {
      threadId: normalized.threadId,
      turnId: normalized.turnId,
      layerId,
    };
    const loadValidated = async () => validateResolvedLayer(identity, await loadLayer(identity));
    return layerCache
      ? layerCache.getOrLoad(identity, loadValidated)
      : loadValidated();
  };

  let layer = rootLayer;
  let layerPath = layerPathForVisibleLayer([], interaction, rootLayer);
  if (normalized.navigationPath.length) {
    const restored = await restoreLayerPath(
      interaction,
      normalized.navigationPath,
      loadAcceptedLayer,
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
  });
  return Object.freeze({
    entry: resolvedEntry,
    thread,
    interactions,
    actionInvocations: Array.isArray(detail.actionInvocations) ? detail.actionInvocations : [],
    interaction,
    layer,
    layerPath,
    selectedNodeId: normalized.selectedNodeId,
    metadata: navigationDestinationMetadata({ thread, interaction, interactions, layerPath }),
  });
}
