import { createProductWorkspace, loadDesignFonts } from "../product-workspace/index.js";
import { createPublicViewerAdapter } from "./adapter.js";
import { artifactLayerNode, createArtifactViewer } from "../artifact-viewer.js";
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
    const fixed = documentRef.documentElement.dataset.viewerTheme;
    documentRef.documentElement.dataset.theme = fixed === "light" || fixed === "dark"
      ? fixed : query?.matches ? "light" : "dark";
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
  documentRef.querySelector(".public-share-download-card")?.classList.add("hidden");
  const error = documentRef.querySelector("#publicShareError");
  error?.classList.remove("hidden");
  const button = documentRef.querySelector("#publicShareReload");
  if (button) button.onclick = () => reload?.();
}

function securePublicLinks(host) {
  for (const link of host.querySelectorAll("a[href]")) securePublicLink(link);
}

function securePublicLink(link) {
  try {
    const protocol = new URL(link.getAttribute("href")).protocol;
    if (protocol !== "http:" && protocol !== "https:") return;
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noreferrer noopener");
  } catch {
    // Relative and non-URL references keep their existing navigation behavior.
  }
}

export function fitPublicTurnPopover(host, windowRef) {
  const banner = host.querySelector(".interaction-banner");
  const popover = host.querySelector(".turn-popover");
  if (!banner || !popover || popover.classList.contains("interaction-graph-popover")
    || !Number.isFinite(windowRef?.innerHeight)) return;
  const rowHeight = 52;
  const borderHeight = 2;
  const popoverGap = 8;
  const viewportGap = 12;
  const availableHeight = windowRef.innerHeight
    - banner.getBoundingClientRect().bottom
    - popoverGap
    - viewportGap;
  const visibleRows = Math.max(1, Math.min(5, Math.floor((availableHeight - borderHeight) / rowHeight)));
  popover.style.maxHeight = `${visibleRows * rowHeight + borderHeight}px`;
}

// Embed-only layout lifecycle. The browser supplies observation and frame scheduling;
// production graph fitting remains owned by ProductWorkspace's Fit control.
export function observeEmbedInspectorLayout(host, windowRef) {
  if (typeof windowRef?.MutationObserver !== "function") return () => {};
  const inspector = host.querySelector("#inspector");
  let wasOpen = !inspector.classList.contains("hidden");
  let fitFrame = null;
  const cancelFit = () => {
    windowRef.cancelAnimationFrame?.(fitFrame);
    fitFrame = null;
  };
  const scheduleFit = () => {
    const isOpen = !inspector.classList.contains("hidden");
    cancelFit();
    if (windowRef.innerWidth > 1100 || !isOpen) {
      fitFrame = windowRef.requestAnimationFrame(() => {
        fitFrame = null;
        if ((windowRef.innerWidth > 1100 || !isOpen) && isOpen === !inspector.classList.contains("hidden")) {
          host.querySelector("#fitGraph")?.click();
        }
      });
    }
  };
  const observer = new windowRef.MutationObserver(() => {
    const isOpen = !inspector.classList.contains("hidden");
    if (isOpen === wasOpen) return;
    wasOpen = isOpen;
    scheduleFit();
  });
  observer.observe(inspector, { attributes: true, attributeFilter: ["class"] });
  const gestures = ["pointerdown", "wheel", "keydown"];
  for (const type of gestures) host.addEventListener(type, cancelFit, true);
  windowRef.addEventListener?.("resize", scheduleFit);
  const dispose = () => {
    windowRef.removeEventListener?.("resize", scheduleFit);
    observer.disconnect();
    cancelFit();
    for (const type of gestures) host.removeEventListener(type, cancelFit, true);
  };
  dispose.scheduleFit = scheduleFit;
  return dispose;
}

// Let ordinary wheel input reach browser scroll chaining across the iframe.
// Ctrl-wheel (including trackpad pinch) remains an explicit graph zoom gesture.
export function configureEmbedReading(host) {
  const stage = host.querySelector("#graphStage");
  const wheel = (event) => {
    if (!event.ctrlKey && !event.metaKey) event.stopImmediatePropagation();
  };
  stage.addEventListener("wheel", wheel, { capture: true, passive: true });
  stage.tabIndex = 0;
  host.querySelector(".graph-hint").textContent = "Pinch or Ctrl-scroll to zoom · Use controls to fit · Drag to pan";
  const close = host.querySelector("#closeInspector");
  close.textContent = "Back to graph";
  close.setAttribute("aria-label", "Back to graph (close node details)");
  const content = host.querySelector(".inspector-content");
  content.tabIndex = 0;
  content.setAttribute("role", "region");
  content.setAttribute("aria-label", "Node details content");
  return () => stage.removeEventListener("wheel", wheel, true);
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
  let host;
  let linkObserver;
  let onLinkClick;
  let onResize;
  let workspace;
  let stopEmbedLayout = () => {};
  let stopEmbedReading = () => {};
  let artifactViewer = null;
  // The artifact overlay lives under body, outside the host; every teardown closes it.
  const closeArtifactViewer = () => { try { artifactViewer?.close(); } catch {} };
  try {
    const snapshot = parsePublicSnapshot(snapshotLiteral(documentRef));
    const adapter = createPublicViewerAdapter(snapshot);
    host = documentRef.querySelector("#publicViewerHost");
    if (!host) throw new Error("Public viewer host is missing.");
    onLinkClick = (event) => {
      const link = event.target?.closest?.("a[href]");
      if (!link || !host.contains(link)) return;
      securePublicLink(link);
    };
    host.addEventListener("click", onLinkClick, true);
    if (typeof windowRef?.MutationObserver === "function") {
      linkObserver = new windowRef.MutationObserver(() => securePublicLinks(host));
      linkObserver.observe(host, { childList: true, subtree: true });
    }
    const render = () => {
      workspace.render();
      securePublicLinks(host);
      fitPublicTurnPopover(host, windowRef);
      stopEmbedLayout.scheduleFit?.();
    };
    workspace = createProductWorkspace({
      root: host,
      mode: "review",
      getState: () => adapter.state,
      getThread: () => adapter.thread,
      selection: adapter.selection,
      // Portable IDs repeat across shares; remember choices only within this viewer.
      layerSelectionMemoryOwner: {},
      showThread: () => {},
      showEmpty: () => {},
      getNavigationHistory: () => ({ canGoBack: false, canGoForward: false }),
      onNavigateHistory: async () => false,
      onSelectTurn: (delta) => {
        if (adapter.selectTurn(delta)) render();
      },
      onSelectTurnById: (turnId, navigation) => {
        if (adapter.selectTurnById(turnId, navigation)) render();
      },
      onSelectionChange: (nodeId) => {
        adapter.selection.selectedNodeId = nodeId;
      },
      onExportConversation: null,
      onSubmitInteraction: async () => false,
      onOpenSettings: () => {},
      onNavigateLayer: async (layerId, navigation) => {
        // Artifact layers open as a card here; deployed https sites play in a sandboxed frame (PRD 6.6.10).
        const artifactNode = artifactLayerNode(snapshot.layerFor(adapter.selection.currentInteractionId, layerId));
        if (artifactNode !== null) {
          artifactViewer ??= createArtifactViewer({ root: documentRef.body, native: null });
          await artifactViewer.open({ threadId: adapter.thread.id, node: artifactNode });
          return false;
        }
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
      resolveNodeDetailAsset: (asset) => snapshot.resolveNodeDetailAsset(asset),
      onDecideApproval: async () => false,
      annotationApi: null,
      contextDraftApi: null,
      inputDraftApi: null,
      inputOperatorAvailable: false,
    });
    const workspaceLayout = host.querySelector(".workspace-layout");
    const downloadCard = documentRef.querySelector(".public-share-download-card");
    const embedded = documentRef.body.classList.contains("public-share-embed");
    const branding = documentRef.querySelector(".public-share-embed-branding");
    if (!workspaceLayout || (embedded ? !branding : !downloadCard)) {
      throw new Error("Public viewer branding host is missing.");
    }
    workspaceLayout.querySelector(".environment-panel")?.remove();
    if (!embedded) workspaceLayout.querySelector(".thread-header").append(downloadCard);
    if (embedded) {
      stopEmbedLayout = observeEmbedInspectorLayout(host, windowRef);
      stopEmbedReading = configureEmbedReading(host);
    }
    onResize = () => {
      fitPublicTurnPopover(host, windowRef);
      stopEmbedLayout.scheduleFit?.();
    };
    windowRef?.addEventListener?.("resize", onResize);
    render();
    return Object.freeze({
      adapter,
      workspace,
      render,
      dispose() {
        closeArtifactViewer();
        linkObserver?.disconnect();
        stopEmbedLayout();
        stopEmbedReading();
        host.removeEventListener("click", onLinkClick, true);
        windowRef?.removeEventListener?.("resize", onResize);
        workspace.dispose();
        stopTheme();
      },
    });
  } catch (error) {
    closeArtifactViewer();
    workspace?.dispose();
    stopEmbedLayout();
    stopEmbedReading();
    linkObserver?.disconnect();
    host?.removeEventListener("click", onLinkClick, true);
    windowRef?.removeEventListener?.("resize", onResize);
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
  void loadDesignFonts(document).finally(() => bootPublicViewer());
}
