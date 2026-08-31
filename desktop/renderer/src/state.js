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
  approvals: [],
  inputDraftRevision: null,
  pendingApprovalDecisions: [],
  permissionProfiles: [],
  defaultPermissionProfileId: null,
  modelSettings: null,
  nodes: [],
  edges: [],
  actions: [],
  visibleLayer: null,
  status: "idle",
  environment: null,
  currentProjectionCursor: 0,
  currentProjections: new Map(),
  temporalSafeReason: null,
  temporalLifecycle: null,
};

export const viewState = {
  selectedScope: { kind: "standalone", label: "No folder" },
  selectedPermissionProfileId: null,
  currentThreadId: query.get("threadId"),
  currentInteractionId: query.get("interactionId"),
  mainView: query.get("threadId") ? "thread" : "new",
  previousMainView: query.get("threadId") ? "thread" : "new",
  settingsTab: "appearance",
  selectedNodeId: null,
  layerPath: [],
  temporalCurrent: null,
  evalContext: null,
};

export function activeThread() {
  return appState.threads.find((thread) => String(thread.id) === String(viewState.currentThreadId))
    || appState.threads.find((thread) => thread.active);
}
