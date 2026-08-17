import { apiUrl, request } from "./api.js";
import { renderThread } from "./graph.js";
import { renderScopeMenu, renderSidebar, setMainView } from "./navigation.js";
import { appState, productApiAvailable, viewState } from "./state.js";
import { $, threadTitle, toast } from "./ui.js";
import { addLocalThread } from "./thread-model.js";

let eventSource;

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
  Object.assign(appState, state);
  const active = state.threads.find((thread) => thread.active);
  if (threadId || active) viewState.currentThreadId = threadId || active.id;
  renderSidebar();
  renderScopeMenu();
  if (viewState.mainView === "settings") setMainView("settings");
  else if (viewState.currentThreadId) renderThread();
  else setMainView("new");
}

export async function loadThread(threadId) {
  viewState.currentThreadId = threadId;
  const url = new URL(location.href);
  url.searchParams.set("threadId", threadId);
  history.replaceState(null, "", url);
  await refreshState(threadId);
}

export async function createFirstThread() {
  const input = $("#newThreadPrompt");
  const promptText = input.value.trim();
  if (!promptText) return;
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
      const project = await request("/api/projects", {
        method: "POST",
        body: JSON.stringify({ path: selectedScope.path, name: selectedScope.label }),
      });
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
    await request(`/api/threads/${encodeURIComponent(thread.id)}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: promptText, selectedNodeIds: [] }),
    });
    input.value = "";
    await loadThread(thread.id);
  } catch (error) {
    toast(error.message);
  } finally {
    $("#createThread").disabled = false;
  }
}

export function connectEvents() {
  if (!productApiAvailable) return;
  eventSource?.close();
  eventSource = new EventSource(apiUrl("/api/events"));
  const productEvents = new Set([
    "project.created",
    "thread.created",
    "turn.started",
    "turn.submitted",
    "turn.accepted",
    "turn.stopped",
    "turn.failed",
    "turn.cancelled",
  ]);
  eventSource.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.threadId && message.threadId !== viewState.currentThreadId) return;
      if (productEvents.has(message.type)) void refreshState(viewState.currentThreadId);
    } catch {}
  };
}
