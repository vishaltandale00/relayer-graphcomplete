export const desktop = window.relayerDesktop;
export const query = new URLSearchParams(location.search);
export const productApiAvailable = location.protocol === "http:" || location.protocol === "https:";

export const appState = {
  projects: [],
  threads: [],
  nodes: [],
  edges: [],
  status: "idle",
};

export const viewState = {
  selectedScope: { kind: "standalone", label: "No folder" },
  currentThreadId: query.get("threadId"),
  mainView: query.get("threadId") ? "thread" : "new",
  selectedNodeId: null,
};

export function activeThread() {
  return appState.threads.find((thread) => thread.id === viewState.currentThreadId)
    || appState.threads.find((thread) => thread.active);
}
