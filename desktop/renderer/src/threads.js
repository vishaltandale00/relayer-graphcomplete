import { request } from "./api.js";
import { renderThread } from "./graph.js";
import { renderScopeMenu, renderSidebar, setMainView } from "./navigation.js";
import { appState, productApiAvailable, viewState } from "./state.js";
import { $, threadTitle, toast } from "./ui.js";
import { addLocalThread } from "./thread-model.js";

let creatingFirstThread = false;
let pendingRefreshTimer;
const PENDING_REFRESH_INTERVAL_MS = 500;

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
  const state = await request(`/api/state${threadId ? `?threadId=${encodeURIComponent(threadId)}` : ""}`);
  appState.projects = state.projects || [];
  appState.threads = state.threads || [];
  appState.interactions = state.interactions || [];
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
  const selected = threadInteractions.find((interaction) => (
    String(interaction.id) === String(viewState.currentInteractionId)
  )) || threadInteractions.at(-1);
  hydrateWorkspace(selected);
  renderSidebar();
  renderScopeMenu();
  if (viewState.mainView === "settings") setMainView("settings");
  else if (viewState.currentThreadId) renderThread();
  else setMainView("new");
  schedulePendingRefresh(viewState.currentThreadId);
}

export async function loadThread(threadId) {
  viewState.currentThreadId = threadId;
  viewState.currentInteractionId = null;
  const url = new URL(location.href);
  url.searchParams.set("threadId", threadId);
  history.replaceState(null, "", url);
  await refreshState(threadId);
}

export function hydrateWorkspace(interaction, layer = interaction?.completionOutput?.rootLayer ?? null) {
  viewState.currentInteractionId = interaction?.id ?? null;
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
  hydrateWorkspace(target);
  renderThread();
}

export async function submitInteraction(text) {
  if (!viewState.currentThreadId) throw new Error("Select a thread before sending a follow-up.");
  await request(`/api/threads/${encodeURIComponent(viewState.currentThreadId)}/interactions`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
  viewState.currentInteractionId = null;
  await refreshState(viewState.currentThreadId);
}

export async function navigateLayer(layerId) {
  if (!viewState.currentThreadId || !viewState.currentInteractionId) return;
  const layer = await request(`/api/threads/${encodeURIComponent(viewState.currentThreadId)}/interactions/${encodeURIComponent(viewState.currentInteractionId)}/layers/${encodeURIComponent(layerId)}`);
  const interaction = appState.interactions.find((item) => String(item.id) === String(viewState.currentInteractionId));
  hydrateWorkspace(interaction, layer);
  renderThread();
}

export async function invokeAction(action) {
  if (action?.kind !== "invoke" || !action.interactionText) return;
  await submitInteraction(action.interactionText);
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
