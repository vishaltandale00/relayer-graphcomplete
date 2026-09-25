import { createProductWorkspace } from "../product-workspace/index.js";
import { createPublicViewerAdapter } from "./adapter.js";
import { parsePublicSnapshot } from "./snapshot.js";

// Public viewer boundary inventory: there is intentionally no fetch,
// XMLHttpRequest, WebSocket, cookie, localStorage, sendBeacon, analytics SDK,
// or error-reporting client in this module. The snapshot is the only input.
export const PUBLIC_VIEWER_CLIENT_TELEMETRY = Object.freeze({
  networkClient: false,
  cookies: false,
  visitorIdentity: false,
  analytics: false,
  errorReporting: false,
});

function setTheme(documentRef, windowRef) {
  const query = windowRef?.matchMedia?.("(prefers-color-scheme: light)");
  const apply = () => {
    documentRef.documentElement.dataset.theme = query?.matches ? "light" : "dark";
  };
  apply();
  query?.addEventListener?.("change", apply);
  return () => query?.removeEventListener?.("change", apply);
}

function snapshotLiteral(documentRef) {
  const script = documentRef.querySelector("#relayerPublicSnapshot");
  if (!script) throw new Error("Public snapshot script is missing.");
  const value = JSON.parse(script.textContent || "null");
  if (typeof value !== "string") throw new Error("Public snapshot script is invalid.");
  return value;
}

function showRenderFailure(documentRef, reload) {
  documentRef.querySelector("#publicViewerHost")?.classList.add("hidden");
  const error = documentRef.querySelector("#publicShareError");
  error?.classList.remove("hidden");
  const button = documentRef.querySelector("#publicShareReload");
  if (button) button.onclick = () => reload?.();
}

function securePublicLinks(host) {
  for (const link of host.querySelectorAll('a[href^="https://"], a[href^="http://"]')) {
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noreferrer noopener");
  }
}

/**
 * Mount the production public viewer into the server-rendered shell. This is
 * exported for the deterministic fixture harness; the browser entry point
 * below invokes it once for the real page.
 */
export function bootPublicViewer({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  reload = () => windowRef?.location?.reload?.(),
  onRenderError = () => {},
} = {}) {
  const stopTheme = setTheme(documentRef, windowRef);
  try {
    const snapshot = parsePublicSnapshot(snapshotLiteral(documentRef));
    const adapter = createPublicViewerAdapter(snapshot);
    const host = documentRef.querySelector("#publicViewerHost");
    if (!host) throw new Error("Public viewer host is missing.");
    let workspace;
    const render = () => {
      workspace.render();
      securePublicLinks(host);
    };
    workspace = createProductWorkspace({
      root: host,
      mode: "review",
      getState: () => adapter.state,
      getThread: () => adapter.thread,
      selection: adapter.selection,
      showThread: () => {},
      showEmpty: () => {},
      getNavigationHistory: () => ({ canGoBack: false, canGoForward: false }),
      onNavigateHistory: async () => false,
      onSelectTurn: (delta) => {
        if (adapter.selectTurn(delta)) render();
      },
      onSelectTurnById: (turnId) => {
        if (adapter.selectTurnById(turnId)) render();
      },
      onSelectionChange: (nodeId) => {
        adapter.selection.selectedNodeId = nodeId;
      },
      onExportConversation: null,
      onSubmitInteraction: async () => false,
      onOpenSettings: () => {},
      onNavigateLayer: async (layerId, navigation) => {
        const changed = await adapter.navigateLayer(layerId, navigation);
        if (changed) render();
        return changed;
      },
      onNavigateResolvedInvoke: async (action, navigation) => {
        const changed = await adapter.navigateResolvedInvoke(action, navigation);
        if (changed) render();
        return changed;
      },
      onInvokeAction: adapter.onInvokeAction,
      resolveNodeDetailAsset: async () => undefined,
      onDecideApproval: async () => false,
      annotationApi: null,
      contextDraftApi: null,
      inputDraftApi: null,
      inputOperatorAvailable: false,
    });
    render();
    return Object.freeze({
      adapter,
      workspace,
      render,
      dispose() {
        workspace.dispose();
        stopTheme();
      },
    });
  } catch (error) {
    stopTheme();
    onRenderError(error);
    showRenderFailure(documentRef, reload);
    return null;
  }
}

if (
  typeof window !== "undefined"
  && typeof document !== "undefined"
  && document.querySelector("#relayerPublicSnapshot")
) {
  bootPublicViewer();
}
