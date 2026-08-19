import { request } from "./api.js";
import {
  actionWasInvoked,
  reconcileActionTransitions,
  visibleLayerAfterRefresh,
} from "./action-invocation-state.js";
import { renderThread } from "./graph.js";
import { renderScopeMenu, renderSidebar, setMainView } from "./navigation.js";
import {
  appendLayerPath,
  layerPathForVisibleLayer,
  restoreLayerPath,
} from "./product-workspace/model.js";
import { appState, productApiAvailable, viewState } from "./state.js";
import { $, threadTitle, toast } from "./ui.js";
import { addLocalThread } from "./thread-model.js";

let creatingFirstThread = false;
let pendingRefreshTimer;
const PENDING_REFRESH_INTERVAL_MS = 500;
const pendingActionTransitions = new Map();

function abandonActionTransition(sourceInteractionId) {
  for (const [resultInteractionId, sourceId] of pendingActionTransitions) {
    if (String(sourceId) === String(sourceInteractionId)) {
      pendingActionTransitions.delete(resultInteractionId);
    }
  }
}

function schedulePendingRefresh(threadId) {
  clearTimeout(pendingRefreshTimer);
  pendingRefreshTimer = undefined;
  const hasPendingInteraction = appState.interactions.some((interaction) => (
    String(interaction.threadId) === String(threadId)
    && ["not_started", "running", "submitted"].includes(interaction.completionStatus)
  ));
  if (!threadId || !hasPendingInteraction) return;
  pendingRefreshTimer = setTimeout(() => {
    if (String(viewState.currentThreadId) !== String(threadId)) return;
    void refreshState(threadId).catch(() => schedulePendingRefresh(threadId));
  }, PENDING_REFRESH_INTERVAL_MS);
}

export async function refreshState(threadId = viewState.currentThreadId) {
  if (!productApiAvailable) {
    renderSidebar();
    renderScopeMenu();
    if (viewState.mainView === "settings") setMainView("settings");
    else if (viewState.currentThreadId) renderThread();
    else setMainView("new");
    return;
  }
  const previousInteractionId = viewState.currentInteractionId;
  const previousVisibleLayer = appState.visibleLayer;
  const state = await request(`/api/state${threadId ? `?threadId=${encodeURIComponent(threadId)}` : ""}`);
  appState.projects = state.projects || [];
  appState.threads = state.threads || [];
  appState.interactions = state.interactions || [];
  appState.actionInvocations = state.actionInvocations || [];
  appState.nodes = [];
  appState.edges = [];
  appState.actions = [];
  appState.visibleLayer = null;
  appState.status = "idle";
  appState.capabilities = state.capabilities;
  const active = state.threads.find((thread) => thread.active);
  if (threadId || active) viewState.currentThreadId = threadId ?? active?.id;
  const threadInteractions = appState.interactions.filter((interaction) => (
    String(interaction.threadId) === String(viewState.currentThreadId)
  ));
  let selected = threadInteractions.find((interaction) => (
    String(interaction.id) === String(viewState.currentInteractionId)
  )) || threadInteractions.at(-1);
  const reconciled = reconcileActionTransitions(
    threadInteractions,
    selected,
    pendingActionTransitions,
  );
  selected = reconciled.selected;
  pendingActionTransitions.clear();
  for (const [resultInteractionId, sourceInteractionId] of reconciled.transitions) {
    pendingActionTransitions.set(resultInteractionId, sourceInteractionId);
  }
  hydrateWorkspace(
    selected,
    visibleLayerAfterRefresh(previousInteractionId, previousVisibleLayer, selected),
  );
  renderSidebar();
  renderScopeMenu();
  if (viewState.mainView === "settings") setMainView("settings");
  else if (viewState.currentThreadId) renderThread();
  else setMainView("new");
  schedulePendingRefresh(viewState.currentThreadId);
}

export async function loadThread(threadId) {
  abandonActionTransition(viewState.currentInteractionId);
  viewState.currentThreadId = threadId;
  viewState.currentInteractionId = null;
  viewState.selectedNodeId = null;
  setMainView("thread");
  const url = new URL(location.href);
  url.searchParams.set("threadId", threadId);
  history.replaceState(null, "", url);
  await refreshState(threadId);
}

export function hydrateWorkspace(
  interaction,
  layer = interaction?.completionOutput?.rootLayer ?? null,
  { layerPath } = {},
) {
  const previousInteractionId = viewState.currentInteractionId;
  const previousLayerId = viewState.layerPath.at(-1)?.layerId;
  const nextLayerPath = layerPath ?? layerPathForVisibleLayer(
    String(previousInteractionId) === String(interaction?.id) ? viewState.layerPath : [],
    interaction,
    layer,
  );
  const nextLayerId = nextLayerPath.at(-1)?.layerId;
  if (
    String(previousInteractionId) !== String(interaction?.id)
    || String(previousLayerId) !== String(nextLayerId)
  ) {
    viewState.selectedNodeId = null;
  }
  viewState.currentInteractionId = interaction?.id ?? null;
  viewState.layerPath = nextLayerPath;
  appState.currentInteractionId = interaction?.id ?? null;
  appState.status = interaction?.completionStatus || "idle";
  appState.visibleLayer = layer;
  appState.nodes = layer?.nodes ? [...layer.nodes] : [];
  appState.edges = layer?.edges ? [...layer.edges] : [];
  appState.actions = layer?.actions ? [...layer.actions] : [];
  const url = new URL(location.href);
  if (interaction?.id) url.searchParams.set("interactionId", interaction.id);
  else url.searchParams.delete("interactionId");
  history.replaceState(null, "", url);
}

export function selectTurn(offset) {
  const turns = appState.interactions.filter((interaction) => (
    String(interaction.threadId) === String(viewState.currentThreadId)
  ));
  const current = turns.findIndex((interaction) => (
    String(interaction.id) === String(viewState.currentInteractionId)
  ));
  const target = turns[current + offset];
  if (!target) return;
  abandonActionTransition(viewState.currentInteractionId);
  viewState.selectedNodeId = null;
  hydrateWorkspace(target);
  renderThread();
}

export async function submitInteraction(text) {
  if (!viewState.currentThreadId) throw new Error("Select a thread before sending a follow-up.");
  abandonActionTransition(viewState.currentInteractionId);
  await request(`/api/threads/${encodeURIComponent(viewState.currentThreadId)}/interactions`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
  viewState.currentInteractionId = null;
  await refreshState(viewState.currentThreadId);
}

export async function navigateLayer(layerId, navigation = {}) {
  if (!viewState.currentThreadId || !viewState.currentInteractionId) return;
  const layer = await request(`/api/threads/${encodeURIComponent(viewState.currentThreadId)}/interactions/${encodeURIComponent(viewState.currentInteractionId)}/layers/${encodeURIComponent(layerId)}`);
  const interaction = appState.interactions.find((item) => String(item.id) === String(viewState.currentInteractionId));
  const layerPath = navigation.restore
    ? viewState.layerPath.slice(0, navigation.pathIndex + 1)
    : appendLayerPath(viewState.layerPath, navigation.action, navigation.sourceNode);
  viewState.selectedNodeId = null;
  hydrateWorkspace(interaction, layer, { layerPath });
  renderThread();
}

export async function restoreReviewPresentation({
  threadId,
  turnId,
  layerId,
  selectedNodeId,
  navigationPath,
}) {
  if (!threadId || !turnId) throw new Error("Review history is missing its thread or turn.");
  if (String(viewState.currentThreadId) !== String(threadId)) {
    viewState.currentThreadId = threadId;
    await refreshState(threadId);
  }
  const interaction = appState.interactions.find((item) => (
    String(item.threadId) === String(threadId) && String(item.id) === String(turnId)
  ));
  if (!interaction) throw new Error(`Review history turn is unavailable: ${turnId}`);
  const loadLayer = (targetLayerId) => request(`/api/threads/${encodeURIComponent(threadId)}/interactions/${encodeURIComponent(turnId)}/layers/${encodeURIComponent(targetLayerId)}`);
  const restoredPath = await restoreLayerPath(interaction, navigationPath, loadLayer);
  let layer = restoredPath?.layer ?? interaction.completionOutput?.rootLayer ?? null;
  let layerPath = restoredPath?.layerPath;
  if (layerId && String(layerId) !== String(layer?.layer?.id)) {
    layer = await loadLayer(layerId);
    layerPath = layerPathForVisibleLayer([], interaction, layer);
  }
  viewState.selectedNodeId = null;
  hydrateWorkspace(interaction, layer, { layerPath });
  renderThread();
  if (selectedNodeId) {
    const node = [...document.querySelectorAll("[data-node]")]
      .find((element) => String(element.dataset.node) === String(selectedNodeId));
    if (!node) throw new Error(`Review history node is unavailable: ${selectedNodeId}`);
    node.click();
  }
}

export async function invokeAction(action) {
  const threadId = viewState.currentThreadId;
  const sourceInteractionId = viewState.currentInteractionId;
  if (!threadId || !sourceInteractionId || action?.kind !== "invoke" || !action.id) return;
  if (actionWasInvoked(
    appState.actionInvocations,
    appState.pendingActionInvocations,
    sourceInteractionId,
    action.id,
  )) return;
  appState.pendingActionInvocations.push({
    sourceInteractionId,
    actionId: action.id,
  });
  let response;
  try {
    response = await request(
      `/api/threads/${encodeURIComponent(threadId)}/interactions/${encodeURIComponent(sourceInteractionId)}/actions/${encodeURIComponent(action.id)}/invoke`,
      { method: "POST" },
    );
  } catch {
    if (String(viewState.currentThreadId) !== String(threadId)) return;
    await refreshState(threadId).catch(() => {});
    const durable = appState.actionInvocations.find((invocation) => (
      String(invocation.sourceInteractionId) === String(sourceInteractionId)
      && String(invocation.actionId) === String(action.id)
    ));
    const sourceIsStillSelected = (
      String(viewState.currentInteractionId) === String(sourceInteractionId)
    );
    if (durable?.resultInteractionId && sourceIsStillSelected) {
      pendingActionTransitions.set(durable.resultInteractionId, sourceInteractionId);
      await refreshState(threadId).catch(() => {});
    }
    return;
  }
  if (response.invocation) {
    appState.actionInvocations = appState.actionInvocations.filter((invocation) => !(
      String(invocation.sourceInteractionId) === String(sourceInteractionId)
      && String(invocation.actionId) === String(action.id)
    ));
    appState.actionInvocations.push(response.invocation);
    appState.pendingActionInvocations = appState.pendingActionInvocations.filter((invocation) => !(
      String(invocation.sourceInteractionId) === String(sourceInteractionId)
      && String(invocation.actionId) === String(action.id)
    ));
  }
  const sourceIsStillSelected = (
    String(viewState.currentThreadId) === String(threadId)
    && String(viewState.currentInteractionId) === String(sourceInteractionId)
  );
  if (response.created && response.interaction?.id && sourceIsStillSelected) {
    pendingActionTransitions.set(response.interaction.id, sourceInteractionId);
  }
  if (String(viewState.currentThreadId) === String(threadId)) {
    await refreshState(threadId);
  }
}

async function createOrReuseProject(selectedScope) {
  const input = { path: selectedScope.path, name: selectedScope.label };
  try {
    return await request("/api/projects", {
      method: "POST",
      body: JSON.stringify(input),
    });
  } catch (error) {
    if (error.code !== "project_exists" || !error.details?.existingProject) throw error;
    const existing = error.details.existingProject;
    const confirmed = window.confirm(`“${existing.name}” already uses this folder. Use the existing project?`);
    if (!confirmed) throw new Error("Project selection was cancelled. Your draft is unchanged.");
    return request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ ...input, reuseExisting: true }),
    });
  }
}

export async function createFirstThread() {
  const input = $("#newThreadPrompt");
  const promptText = input.value.trim();
  if (!promptText || creatingFirstThread) return;
  creatingFirstThread = true;
  input.disabled = true;
  $("#createThread").disabled = true;
  try {
    const selectedScope = viewState.selectedScope;
    if (!productApiAvailable) {
      const thread = addLocalThread(appState, {
        selectedScope,
        prompt: promptText,
        title: threadTitle(promptText),
        createId: () => crypto.randomUUID(),
      });
      viewState.currentThreadId = thread.id;
      input.value = "";
      renderSidebar();
      renderThread();
      return;
    }
    let projectId = selectedScope.projectId;
    if (selectedScope.kind === "folder") {
      const project = await createOrReuseProject(selectedScope);
      projectId = project.id;
    }
    const thread = await request("/api/threads", {
      method: "POST",
      body: JSON.stringify({
        title: threadTitle(promptText),
        initialMessage: promptText,
        ...(projectId ? { projectId } : {}),
      }),
    });
    viewState.currentThreadId = thread.id;
    input.value = "";
    await loadThread(thread.id);
  } catch (error) {
    toast(error.message);
  } finally {
    creatingFirstThread = false;
    input.disabled = false;
    $("#createThread").disabled = !input.value.trim();
  }
}

export function connectEvents() {
  // Live harness events are intentionally outside this product-persistence slice.
}
