export const desktop = window.relayerDesktop;
export const evalReview = window.relayerEvalReview;
export const query = new URLSearchParams(location.search);
export const productApiAvailable = location.protocol === "http:" || location.protocol === "https:";

export const appState = {
  projects: [],
  threads: [],
  interactions: [],
  actionInvocations: [],
  pendingActionInvocations: [],
  permissionProfiles: [],
  defaultPermissionProfileId: null,
  nodes: [],
  edges: [],
  actions: [],
  visibleLayer: null,
  status: "idle",
};

export const viewState = {
  selectedScope: { kind: "standalone", label: "No folder" },
  selectedPermissionProfileId: null,
  currentThreadId: query.get("threadId"),
  currentInteractionId: query.get("interactionId"),
  mainView: query.get("threadId") ? "thread" : "new",
  selectedNodeId: null,
  layerPath: [],
  evalContext: null,
};

export function activeThread() {
  return appState.threads.find((thread) => String(thread.id) === String(viewState.currentThreadId))
    || appState.threads.find((thread) => thread.active);
}
