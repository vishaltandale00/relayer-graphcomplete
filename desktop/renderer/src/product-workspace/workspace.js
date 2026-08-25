import { escapeHtml, toast } from "../ui.js";
import { actionCanRetry, actionWasInvoked } from "../action-invocation-state.js";
import { setControlActivationCompletion } from "../control-activation.js";
import {
  createModelPicker,
  interactionModelSelection,
  modelSelectionLabels,
  selectionForNextInteraction,
} from "../model-picker.js";
import { pickerSelectionPayload } from "../model-picker-model.js";
import {
  interactionForThread,
  responseNodesForThread,
  workspaceBreadcrumbItems,
  workspaceModeCapabilities,
  workspaceTurns,
} from "./model.js";
import { createRelayerIcon } from "./icons.js";
import { graphLayoutSignature, projectLayerNodePositions } from "./graph-layout.js";
import { renderMarkdown } from "./markdown.js";
import { productWorkspaceMarkup } from "./view.js";
import {
  approvalActionPresentation,
  approvalDockMode,
  approvalQueueKeyIntent,
  approvalQueueTarget,
  approvalResolutionLabel,
  pendingApprovalsForThread,
  resolvedApprovalHistoryForThread,
  selectedPendingApproval,
} from "../approval-model.js";

export const GRAPH_NODE_ICON_RADIUS = 24;
export const GRAPH_MIN_ZOOM = 0.4;
export const GRAPH_MAX_ZOOM = 2;
export const COMPOSER_MIN_HEIGHT = 42;
export const COMPOSER_MAX_HEIGHT = 126;

const GRAPH_NODE_HALF_WIDTH = 82;
const GRAPH_NODE_TOP = 28;
const GRAPH_NODE_BOTTOM = 72;
const GRAPH_FIT_PADDING = 48;
const PENDING_COMPLETION_STATUSES = new Set([
  "not_started",
  "running",
  "submitted",
  "waiting_for_approval",
]);

export function graphNodeIdentitySet(nodes) {
  return new Set((nodes || []).map((node) => String(node.id)));
}

export function turnReviewKind(current) {
  return current ? "control" : "turn";
}

export function focusedTurnIdForRerender(popoverOpen, activeElement) {
  if (!popoverOpen) return null;
  return activeElement?.closest?.("[data-turn-id]")?.dataset?.turnId ?? null;
}

export function graphNodeLayoutBounds(width, height) {
  return {
    halfWidth: Math.max(GRAPH_NODE_HALF_WIDTH, width / 2),
    top: GRAPH_NODE_TOP,
    bottom: Math.max(GRAPH_NODE_BOTTOM, height - 23),
  };
}

export function clampGraphZoom(zoom) {
  return Math.min(GRAPH_MAX_ZOOM, Math.max(GRAPH_MIN_ZOOM, zoom));
}

export function graphScreenPoint(point, camera) {
  const zoom = camera.zoom ?? 1;
  return { x: point.x * zoom + camera.x, y: point.y * zoom + camera.y };
}

export function graphWorldPoint(point, camera) {
  const zoom = camera.zoom ?? 1;
  return { x: (point.x - camera.x) / zoom, y: (point.y - camera.y) / zoom };
}

export function zoomGraphCameraAt(camera, zoom, anchor) {
  const nextZoom = clampGraphZoom(zoom);
  const worldAnchor = graphWorldPoint(anchor, camera);
  return {
    x: anchor.x - worldAnchor.x * nextZoom,
    y: anchor.y - worldAnchor.y * nextZoom,
    zoom: nextZoom,
  };
}

function graphContentBounds(nodes) {
  if (!nodes.length) return null;
  return nodes.reduce((result, node) => {
    const layoutBounds = node.layoutBounds ?? graphNodeLayoutBounds(0, 0);
    return {
      minX: Math.min(result.minX, node.x - layoutBounds.halfWidth),
      maxX: Math.max(result.maxX, node.x + layoutBounds.halfWidth),
      minY: Math.min(result.minY, node.y - layoutBounds.top),
      maxY: Math.max(result.maxY, node.y + layoutBounds.bottom),
    };
  }, {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
  });
}

export function recenterGraphCamera(nodes, bounds, zoom = 1) {
  const content = graphContentBounds(nodes);
  const nextZoom = clampGraphZoom(zoom);
  if (!content) return { x: bounds.width / 2, y: bounds.height / 2, zoom: nextZoom };
  const centerX = (content.minX + content.maxX) / 2;
  const centerY = (content.minY + content.maxY) / 2;
  return {
    x: bounds.width / 2 - centerX * nextZoom,
    y: bounds.height / 2 - centerY * nextZoom,
    zoom: nextZoom,
  };
}

export function fitGraphCamera(nodes, bounds, padding = GRAPH_FIT_PADDING) {
  const content = graphContentBounds(nodes);
  if (!content) return { x: bounds.width / 2, y: bounds.height / 2, zoom: 1 };
  const availableWidth = Math.max(1, bounds.width - padding * 2);
  const availableHeight = Math.max(1, bounds.height - padding * 2);
  const contentWidth = Math.max(1, content.maxX - content.minX);
  const contentHeight = Math.max(1, content.maxY - content.minY);
  const zoom = clampGraphZoom(Math.min(
    availableWidth / contentWidth,
    availableHeight / contentHeight,
  ));
  return recenterGraphCamera(nodes, bounds, zoom);
}

export function graphCameraViewKey(state, thread, responseNodes) {
  const interaction = interactionForThread(state, thread);
  const layerId = state.visibleLayer?.layer?.id
    ?? interaction?.completionOutput?.rootLayer?.layer?.id
    ?? responseNodes.map((node) => node.id).join(",");
  return `${thread.id}:${interaction?.id ?? ""}:${layerId}`;
}

export function shouldFitInspectorOpen(previousOpen, nextOpen, viewportWidth) {
  return previousOpen === false && nextOpen === true && viewportWidth > 760;
}

export function shouldFitInspectorDock(previousOverlay, nextOverlay, inspectorOpen) {
  return inspectorOpen && previousOverlay && !nextOverlay;
}

export function shouldActivateGraphNodeAfterPointerGesture(moved) {
  return !moved;
}

export function inspectorFitRequestIsCurrent(request, {
  cameraRevision,
  graphViewKey,
  inspectorOpen,
  viewportWidth,
}) {
  return request !== null
    && request.graphViewKey === graphViewKey
    && request.cameraRevision === cameraRevision
    && inspectorOpen
    && viewportWidth > 760;
}

export function graphEdgeSegment(source, target, radius = GRAPH_NODE_ICON_RADIUS) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.hypot(dx, dy);
  if (!distance) {
    return { x1: source.x, y1: source.y, x2: target.x, y2: target.y };
  }
  const offsetX = (dx / distance) * radius;
  const offsetY = (dy / distance) * radius;
  return {
    x1: source.x + offsetX,
    y1: source.y + offsetY,
    x2: target.x - offsetX,
    y2: target.y - offsetY,
  };
}

export function graphEdgeStrokeWidth(zoom) {
  return 1.5 * zoom;
}

export function graphTurnNavigationDelta(event, graphFocused) {
  if (!graphFocused || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (event.key === "ArrowLeft") return -1;
  if (event.key === "ArrowRight") return 1;
  return null;
}

export { workspaceTurns } from "./model.js";

export function turnStatusPresentation(status) {
  if (status === "waiting_for_approval") {
    return { kind: "approval", label: "Needs approval" };
  }
  if (["not_started", "running", "submitted"].includes(status)) {
    return { kind: "running", label: status === "not_started" ? "Waiting" : "Running" };
  }
  if (status === "accepted") return { kind: "accepted", label: "Complete" };
  if (status === "failed") return { kind: "failed", label: "Failed" };
  if (status === "cancelled") return { kind: "cancelled", label: "Cancelled" };
  if (status === "stopped") return { kind: "stopped", label: "Stopped" };
  return { kind: "unknown", label: status ? String(status).replaceAll("_", " ") : "Unknown" };
}

export function turnSelectionIntent(turns, currentInteractionId, targetInteractionId) {
  const currentIndex = turns.findIndex((turn) => (
    String(turn.id) === String(currentInteractionId)
  ));
  const targetIndex = turns.findIndex((turn) => (
    String(turn.id) === String(targetInteractionId)
  ));
  if (targetIndex < 0 || targetIndex === currentIndex) return null;
  return {
    interactionId: turns[targetIndex].id,
    offset: targetIndex - currentIndex,
  };
}

export function historyNavigationPresentation(history = {}) {
  const pendingDirection = ["back", "forward"].includes(history.pendingDirection)
    ? history.pendingDirection
    : null;
  return {
    pendingDirection,
    back: {
      disabled: pendingDirection !== null || !history.canGoBack,
      label: history.backLabel || "Back",
      loading: pendingDirection === "back",
    },
    forward: {
      disabled: pendingDirection !== null || !history.canGoForward,
      label: history.forwardLabel || "Forward",
      loading: pendingDirection === "forward",
    },
  };
}

export function activateHistoryControl(button, direction, navigateHistory) {
  if (!button || typeof navigateHistory !== "function") {
    throw new TypeError("History control activation requires a button and navigator.");
  }
  const completion = navigateHistory(direction);
  setControlActivationCompletion(button, completion);
  void completion.catch(() => {});
  return completion;
}

export function composerKeydownIntent(event) {
  if (event.key !== "Enter") return null;
  if (event.isComposing || event.keyCode === 229) return "composing";
  if (event.repeat) return "repeat";
  if (event.metaKey || event.ctrlKey) return "submit";
  if (event.shiftKey) return "newline";
  if (event.altKey) return null;
  return "submit";
}

export function handleComposerKeydown(event, submit) {
  const intent = composerKeydownIntent(event);
  if (intent === "repeat") {
    event.preventDefault();
    return intent;
  }
  if (intent === "submit") {
    event.preventDefault();
    submit();
  }
  return intent;
}

export function bindComposerKeydown(textarea, submit) {
  textarea.onkeydown = (event) => handleComposerKeydown(event, submit);
}

export function composerSubmissionReady(value, disabled = false, modelReady = true) {
  return !disabled && modelReady && Boolean(value.trim());
}

export function composerDisabledForState(status, canCompose = true) {
  return !canCompose || PENDING_COMPLETION_STATUSES.has(status);
}

export function composerFocusRestoration(
  pendingThreadId,
  { activeWasInside, dockThreadId, threadId, canCompose, promptDisabled },
) {
  const currentThreadId = String(threadId);
  let nextThreadId = pendingThreadId;
  if (activeWasInside && String(dockThreadId) === currentThreadId) {
    nextThreadId = currentThreadId;
  } else if (String(dockThreadId) !== currentThreadId) {
    nextThreadId = null;
  }
  const shouldFocus = String(nextThreadId) === currentThreadId
    && canCompose
    && !promptDisabled;
  return {
    pendingThreadId: shouldFocus ? null : nextThreadId,
    shouldFocus,
  };
}

const ACTION_VARIANTS = new Set(["chip", "pill", "wide", "card"]);

export function actionPresentation(action) {
  const variant = ACTION_VARIANTS.has(action?.variant) ? action.variant : "pill";
  return {
    variant,
    label: String(action?.label || action?.title || "Action"),
    icon: typeof action?.icon === "string" && action.icon.trim() ? action.icon : null,
    description: variant === "card" && typeof action?.description === "string"
      ? action.description
      : null,
  };
}

export function actionActivationPresentation(
  action,
  { invoked = false, retryable = false, canInvokeMutatingActions = false } = {},
) {
  const layerNavigation = action?.kind === "navigate" && action.targetLayerId != null;
  const resolvedInvoke = action?.kind === "invoke" && action.targetLayerId != null;
  const navigational = layerNavigation || resolvedInvoke;
  const retryableInvoke = action?.kind === "invoke" && !navigational && retryable;
  return Object.freeze({
    layerNavigation,
    resolvedInvoke,
    navigational,
    retryableInvoke,
    label: retryableInvoke ? `Retry ${actionPresentation(action).label}` : actionPresentation(action).label,
    disabled: navigational ? false : invoked || !canInvokeMutatingActions,
  });
}

export function actionReviewKind(action) {
  return (
    action?.kind === "navigate"
    || (action?.kind === "invoke" && action.targetLayerId != null)
  ) ? "navigate-action" : "invoke-action";
}

export function captureGraphViewState(
  nodes,
  camera,
  signature,
  cameraRevision,
) {
  return {
    camera: { ...camera },
    cameraRevision,
    nodes: nodes.map((node) => ({
      id: node.id,
      x: node.x,
      y: node.y,
      pinned: node.pinned,
    })),
    settled: true,
    signature,
  };
}

export function resizeComposerTextarea(textarea) {
  textarea.style.height = "auto";
  const contentHeight = Math.max(COMPOSER_MIN_HEIGHT, textarea.scrollHeight);
  textarea.style.height = `${Math.min(contentHeight, COMPOSER_MAX_HEIGHT)}px`;
  textarea.style.overflowY = contentHeight > COMPOSER_MAX_HEIGHT ? "auto" : "hidden";
}

// History state is supplied by the renderer integration so Product and Eval use the same
// controls. `onSelectTurn(delta)` remains the keyboard/stepper contract; callers can add
// `onSelectTurnById(id)` for direct popover jumps without changing existing integrations.
export function createProductWorkspace({
  root = document,
  mode = "interactive",
  getState,
  getThread,
  selection,
  showThread,
  showEmpty,
  getNavigationHistory = () => ({}),
  onNavigateHistory = async () => {},
  onSelectTurn = () => {},
  onSelectTurnById,
  onSelectionChange = () => {},
  onExportConversation = null,
  onSubmitInteraction = async () => {},
  onOpenSettings = () => {},
  onNavigateLayer = async () => {},
  onNavigateResolvedInvoke = async () => {},
  onInvokeAction = async () => {},
  onDecideApproval = async () => {},
}) {
  const capabilities = workspaceModeCapabilities(mode);
  let graphNodes = [];
  let graphEdges = [];
  let graphSignature = "";
  let graphViewKey = "";
  let dragging = null;
  let panning = null;
  let pinching = null;
  let camera = { x: 0, y: 0, zoom: 1 };
  let cameraRevision = 0;
  let inspectorFitRequest = null;
  let inspectorFitFrame = null;
  let turnPopoverOpen = false;
  let settingsMenuOpen = false;
  let exportPending = false;
  const approvalSelections = new Map();
  const approvalErrors = new Map();
  const approvalDecisionsInFlight = new Set();
  let restoreComposerFocusThreadId = null;
  const graphViewCache = new Map();
  const activeTouchPointers = new Map();

  const $ = (selector) => root.querySelector(selector);
  const $$ = (selector) => [...root.querySelectorAll(selector)];

  const threadView = $("#threadView");
  if (!threadView) throw new Error("Product workspace requires a #threadView host.");
  threadView.innerHTML = productWorkspaceMarkup();
  const settingsControl = $("#conversationSettings");
  const settingsButton = $("#conversationSettingsButton");
  const settingsMenu = $("#conversationSettingsMenu");
  const exportButton = $("#exportConversation");
  const closeSettingsMenu = ({ restoreFocus = false } = {}) => {
    settingsMenuOpen = false;
    settingsMenu.classList.add("hidden");
    settingsButton.setAttribute("aria-expanded", "false");
    if (restoreFocus) settingsButton.focus();
  };
  const openSettingsMenu = () => {
    if (settingsButton.disabled) return;
    settingsMenuOpen = true;
    settingsMenu.classList.remove("hidden");
    settingsButton.setAttribute("aria-expanded", "true");
    exportButton.focus();
  };
  const renderExportControl = (thread = getThread()) => {
    const available = capabilities.canExportConversation
      && typeof onExportConversation === "function";
    settingsControl.classList.toggle("hidden", !available);
    exportButton.classList.toggle("hidden", !available);
    exportButton.disabled = !available || exportPending || thread?.id == null;
    settingsButton.disabled = !available || exportPending;
    settingsButton.setAttribute("aria-busy", String(exportPending));
    exportButton.setAttribute("aria-busy", String(exportPending));
    exportButton.textContent = exportPending ? "Exporting…" : "Export conversation…";
    if (!available) closeSettingsMenu();
  };
  settingsButton.onclick = () => {
    if (settingsMenuOpen) closeSettingsMenu();
    else openSettingsMenu();
  };
  exportButton.onclick = async () => {
    const thread = getThread();
    if (
      !capabilities.canExportConversation
      || exportPending
      || thread?.id == null
      || typeof onExportConversation !== "function"
    ) return;
    closeSettingsMenu();
    exportPending = true;
    renderExportControl(thread);
    try {
      const result = await onExportConversation(thread.id);
      if (result?.status === "saved") toast("Conversation exported.");
      else if (result?.status === "canceled") toast("Export canceled.");
      else throw new Error("Conversation export returned an unknown status.");
    } catch (error) {
      toast(error.message);
    } finally {
      exportPending = false;
      renderExportControl();
    }
  };
  const graphStage = $("#graphStage");
  const graphDocument = graphStage.ownerDocument;
  const graphWindow = graphDocument.defaultView;
  const closeSettingsMenuFromOutside = (event) => {
    if (settingsMenuOpen && !settingsControl.contains(event.target)) closeSettingsMenu();
  };
  const closeSettingsMenuOnEscape = (event) => {
    if (event.key !== "Escape" || !settingsMenuOpen) return;
    closeSettingsMenu({ restoreFocus: true });
  };
  graphDocument.addEventListener("pointerdown", closeSettingsMenuFromOutside, true);
  graphDocument.addEventListener("keydown", closeSettingsMenuOnEscape, true);
  const narrowInspectorMedia = graphWindow?.matchMedia?.("(max-width: 760px)");
  let inspectorUsesOverlay = narrowInspectorMedia?.matches
    ?? (graphWindow?.innerWidth ?? 0) <= 760;
  const cancelInspectorFit = () => {
    if (inspectorFitFrame !== null) {
      graphDocument.defaultView?.cancelAnimationFrame?.(inspectorFitFrame);
      inspectorFitFrame = null;
    }
    inspectorFitRequest = null;
  };
  const scheduleInspectorFit = () => {
    cancelInspectorFit();
    const request = { graphViewKey, cameraRevision };
    inspectorFitRequest = request;
    inspectorFitFrame = graphWindow?.requestAnimationFrame?.(() => {
      inspectorFitFrame = null;
      if (!inspectorFitRequestIsCurrent(request, {
        cameraRevision,
        graphViewKey,
        inspectorOpen: !$("#inspector").classList.contains("hidden"),
        viewportWidth: graphWindow?.innerWidth ?? 0,
      })) {
        if (inspectorFitRequest === request) inspectorFitRequest = null;
        return;
      }
      updateCamera(fitGraphCamera(graphNodes, graphStage.getBoundingClientRect()), false);
      inspectorFitRequest = null;
    }) ?? null;
  };
  const handleInspectorLayoutChange = (event) => {
    const previouslyUsedOverlay = inspectorUsesOverlay;
    inspectorUsesOverlay = event.matches;
    const inspectorOpen = !$("#inspector").classList.contains("hidden");
    const shouldFit = shouldFitInspectorDock(
      previouslyUsedOverlay,
      event.matches,
      inspectorOpen,
    );
    if (shouldFit) scheduleInspectorFit();
  };
  narrowInspectorMedia?.addEventListener?.("change", handleInspectorLayoutChange);
  $("#closeInspector").onclick = () => {
    cancelInspectorFit();
    selection.selectedNodeId = null;
    onSelectionChange(null);
    $("#inspector").classList.add("hidden");
    $$('[data-node]').forEach((element) => element.classList.remove("selected"));
    renderBreadcrumb();
  };
  const navigateHistory = async (direction) => {
    const history = getNavigationHistory() || {};
    const presentation = historyNavigationPresentation(history);
    if (presentation[direction].disabled) return;
    await onNavigateHistory(direction);
  };
  $("#historyBack").onclick = (event) => (
    activateHistoryControl(event.currentTarget, "back", navigateHistory)
  );
  $("#historyForward").onclick = (event) => (
    activateHistoryControl(event.currentTarget, "forward", navigateHistory)
  );
  $("#previousTurn").onclick = () => {
    closeTurnPopover();
    onSelectTurn(-1);
  };
  $("#nextTurn").onclick = () => {
    closeTurnPopover();
    onSelectTurn(1);
  };
  const closeTurnPopover = () => {
    turnPopoverOpen = false;
    $("#turnPopover").classList.add("hidden");
    $("#turnPickerButton").setAttribute("aria-expanded", "false");
  };
  const openTurnPopover = () => {
    if ($("#turnPickerButton").disabled) return;
    turnPopoverOpen = true;
    $("#turnPopover").classList.remove("hidden");
    $("#turnPickerButton").setAttribute("aria-expanded", "true");
    const current = $("#turnPopover [aria-current='true']");
    current?.scrollIntoView?.({ block: "nearest" });
    current?.focus?.({ preventScroll: true });
  };
  $("#turnPickerButton").onclick = () => {
    if (turnPopoverOpen) closeTurnPopover();
    else openTurnPopover();
  };
  const closeTurnPopoverFromOutside = (event) => {
    if (turnPopoverOpen && !$("#turnPicker").contains(event.target)) closeTurnPopover();
  };
  const closeTurnPopoverOnEscape = (event) => {
    if (event.key !== "Escape" || !turnPopoverOpen) return;
    closeTurnPopover();
    $("#turnPickerButton").focus();
  };
  graphDocument.addEventListener("pointerdown", closeTurnPopoverFromOutside, true);
  graphDocument.addEventListener("keydown", closeTurnPopoverOnEscape, true);
  const focusGraph = () => graphStage.focus({ preventScroll: true });
  const blurGraphFromOutsidePointer = (event) => {
    if (!graphStage.contains(event.target) && graphDocument.activeElement === graphStage) {
      graphStage.blur();
    }
  };
  graphDocument.addEventListener("pointerdown", blurGraphFromOutsidePointer, true);
  graphStage.onkeydown = (event) => {
    if (!capabilities.canNavigate) return;
    const delta = graphTurnNavigationDelta(event, graphDocument.activeElement === graphStage);
    if (delta === null) return;
    event.preventDefault();
    const turnButton = delta < 0 ? $("#previousTurn") : $("#nextTurn");
    if (!turnButton.disabled) onSelectTurn(delta);
  };
  const localStagePoint = (event) => {
    const rect = graphStage.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const pointerDistance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

  function updateCamera(nextCamera, manual = true) {
    camera = nextCamera;
    if (manual) {
      cancelInspectorFit();
      cameraRevision += 1;
    }
    drawGraph();
  }

  function zoomAt(zoom, anchor = {
    x: graphStage.getBoundingClientRect().width / 2,
    y: graphStage.getBoundingClientRect().height / 2,
  }) {
    updateCamera(zoomGraphCameraAt(camera, zoom, anchor));
  }

  graphStage.onwheel = (event) => {
    if (event.target.closest?.("button")) return;
    event.preventDefault();
    zoomAt(camera.zoom * Math.exp(-event.deltaY * 0.002), localStagePoint(event));
  };
  graphStage.onpointerdown = (event) => {
    if (event.button === 0 && !event.target.closest?.("button")) focusGraph();
    if (event.target.closest?.(".graph-node, button") || event.button !== 0) return;
    if (event.pointerType === "touch") {
      activeTouchPointers.set(event.pointerId, localStagePoint(event));
    }
    graphStage.setPointerCapture(event.pointerId);
    if (activeTouchPointers.size >= 2) {
      const [firstId, secondId] = [...activeTouchPointers.keys()].slice(0, 2);
      const first = activeTouchPointers.get(firstId);
      const second = activeTouchPointers.get(secondId);
      const anchor = midpoint(first, second);
      pinching = {
        pointerIds: [firstId, secondId],
        startDistance: Math.max(1, pointerDistance(first, second)),
        startZoom: camera.zoom,
        worldAnchor: graphWorldPoint(anchor, camera),
      };
      panning = null;
      graphStage.classList.add("panning");
      return;
    }
    panning = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startCameraX: camera.x,
      startCameraY: camera.y,
    };
    graphStage.classList.add("panning");
  };
  graphStage.onpointermove = (event) => {
    if (activeTouchPointers.has(event.pointerId)) {
      activeTouchPointers.set(event.pointerId, localStagePoint(event));
    }
    if (pinching && pinching.pointerIds.includes(event.pointerId)) {
      const [first, second] = pinching.pointerIds.map((pointerId) => activeTouchPointers.get(pointerId));
      if (!first || !second) return;
      const anchor = midpoint(first, second);
      const zoom = clampGraphZoom(
        pinching.startZoom * pointerDistance(first, second) / pinching.startDistance,
      );
      updateCamera({
        x: anchor.x - pinching.worldAnchor.x * zoom,
        y: anchor.y - pinching.worldAnchor.y * zoom,
        zoom,
      });
      return;
    }
    if (!panning || panning.pointerId !== event.pointerId) return;
    cancelInspectorFit();
    camera.x = panning.startCameraX + event.clientX - panning.startClientX;
    camera.y = panning.startCameraY + event.clientY - panning.startClientY;
    cameraRevision += 1;
    drawGraph();
  };
  const finishPan = (event) => {
    activeTouchPointers.delete(event.pointerId);
    if (pinching?.pointerIds.includes(event.pointerId)) {
      pinching = null;
      panning = null;
    } else if (panning?.pointerId === event.pointerId) {
      panning = null;
    }
    if (!panning && !pinching) graphStage.classList.remove("panning");
  };
  graphStage.onpointerup = finishPan;
  graphStage.onpointercancel = finishPan;
  $("#zoomOutGraph").onclick = () => zoomAt(camera.zoom / 1.25);
  $("#zoomInGraph").onclick = () => zoomAt(camera.zoom * 1.25);
  $("#fitGraph").onclick = () => updateCamera(
    fitGraphCamera(graphNodes, graphStage.getBoundingClientRect()),
  );
  $("#recenterGraph").onclick = () => {
    updateCamera(recenterGraphCamera(
      graphNodes,
      graphStage.getBoundingClientRect(),
      camera.zoom,
    ));
  };
  const prompt = $("#threadPrompt");
  const send = $("#sendInteraction");
  let pickerInheritanceKey = null;
  let modelPicker;
  const syncComposer = () => {
    resizeComposerTextarea(prompt);
    send.disabled = !composerSubmissionReady(
      prompt.value,
      prompt.disabled,
      modelPicker?.isReady() ?? false,
    );
    send.title = modelPicker?.isReady()
      ? "Send"
      : "Choose an available model in Settings before sending";
  };
  if (capabilities.canCompose) {
    modelPicker = createModelPicker({
      root: root.querySelector('[data-model-picker="ongoing"]'),
      mode: "ongoing",
      settings: getState().modelSettings,
      onSelectionChange: syncComposer,
      onOpenSettings,
    });
  }
  prompt.oninput = syncComposer;
  bindComposerKeydown(prompt, () => {
    if (!modelPicker?.isReady()) modelPicker?.open("model");
    else send.click();
  });
  send.onclick = async () => {
    const text = prompt.value.trim();
    if (!text || send.disabled) return;
    prompt.disabled = true;
    send.disabled = true;
    try {
      const modelSelection = pickerSelectionPayload(modelPicker?.getSelection())?.modelSelection;
      await onSubmitInteraction(text, modelSelection);
      prompt.value = "";
    } catch (error) {
      toast(error.message);
    } finally {
      prompt.disabled = composerDisabledForState(
        getState().status,
        capabilities.canCompose,
      );
      syncComposer();
    }
  };
  syncComposer();

  const approvalDock = $("#approvalDock");
  const selectApproval = (intent) => {
    const state = getState();
    const thread = getThread();
    const pending = pendingApprovalsForThread(state, thread);
    const current = approvalSelections.get(String(thread?.id));
    const target = approvalQueueTarget(pending, current, intent);
    if (target == null) return;
    approvalSelections.set(String(thread.id), String(target));
    renderApprovalDock(state, thread);
  };
  $("#previousApproval").onclick = () => selectApproval(-1);
  $("#nextApproval").onclick = () => selectApproval(1);
  approvalDock.onkeydown = (event) => {
    const intent = approvalQueueKeyIntent(event, graphDocument.activeElement === approvalDock);
    if (intent === null) return;
    event.preventDefault();
    selectApproval(intent);
  };
  const decideSelectedApproval = async (decision) => {
    const state = getState();
    const thread = getThread();
    const pending = pendingApprovalsForThread(state, thread);
    const selected = selectedPendingApproval(
      pending,
      approvalSelections.get(String(thread?.id)),
    );
    const requestId = selected?.request.requestId;
    if (!capabilities.canResolveApprovals || requestId == null) return;
    const key = String(requestId);
    if (approvalDecisionsInFlight.has(key)) return;
    approvalDecisionsInFlight.add(key);
    approvalErrors.delete(key);
    renderApprovalDock(state, thread);
    try {
      await onDecideApproval(requestId, decision);
    } catch (error) {
      if (String(getThread()?.id) === String(thread.id)) {
        approvalErrors.set(key, error?.message || "Approval decision failed.");
      }
    } finally {
      approvalDecisionsInFlight.delete(key);
      if (String(getThread()?.id) === String(thread.id)) {
        renderApprovalDock(getState(), getThread());
      }
    }
  };
  $("#denyApproval").onclick = () => decideSelectedApproval("deny");
  $("#approveOnce").onclick = () => decideSelectedApproval("approve_once");
  $("#approveAlways").onclick = () => decideSelectedApproval("approve_always");

  function applyMode() {
    threadView.dataset.workspaceMode = mode;
    threadView.dataset.canNavigate = String(capabilities.canNavigate);
    threadView.dataset.canCompose = String(capabilities.canCompose);
    threadView.dataset.canInvokeMutatingActions = String(capabilities.canInvokeMutatingActions);
    threadView.dataset.canExportConversation = String(capabilities.canExportConversation);
    $("#threadComposer").classList.toggle("disabled-composer", !capabilities.canCompose);
    prompt.classList.toggle("hidden", !capabilities.canCompose);
    send.classList.toggle("hidden", !capabilities.canCompose);
    if (!capabilities.canCompose) $("#threadComposer").textContent = "Read-only evaluation result";
  }

  function renderHistoryNavigation() {
    const history = getNavigationHistory() || {};
    const presentation = historyNavigationPresentation(history);
    for (const [direction, selector] of [["back", "#historyBack"], ["forward", "#historyForward"]]) {
      const button = $(selector);
      const state = presentation[direction];
      button.disabled = state.disabled;
      button.title = state.label;
      button.setAttribute("aria-label", state.loading ? `${state.label} (loading)` : state.label);
      button.setAttribute("aria-busy", String(state.loading));
      button.classList.toggle("loading", state.loading);
      button.querySelector("span").classList.toggle("hidden", state.loading);
      button.querySelector(".history-spinner").classList.toggle("hidden", !state.loading);
    }
  }

  function renderTurnNavigation(state, thread, interaction) {
    const focusedTurnId = focusedTurnIdForRerender(
      turnPopoverOpen,
      graphDocument.activeElement,
    );
    const turns = workspaceTurns(state, thread);
    const turnIndex = turns.findIndex((item) => String(item.id) === String(interaction?.id));
    $("#previousTurn").disabled = turnIndex <= 0;
    $("#nextTurn").disabled = turnIndex < 0 || turnIndex >= turns.length - 1;
    const pickerButton = $("#turnPickerButton");
    pickerButton.disabled = turnIndex < 0 || !turns.length;
    pickerButton.textContent = `Turn ${turnIndex < 0 ? 0 : turnIndex + 1} of ${turns.length}`;
    pickerButton.setAttribute(
      "aria-label",
      turnIndex < 0 ? "Choose a turn" : `Turn ${turnIndex + 1} of ${turns.length}. Choose a turn`,
    );

    const rows = turns.map((turn, index) => {
      const current = index === turnIndex;
      const status = turnStatusPresentation(turn.completionStatus);
      const row = graphDocument.createElement("button");
      row.type = "button";
      row.className = `turn-option turn-status-${status.kind}`;
      row.dataset.turnId = String(turn.id);
      row.dataset.reviewRef = `turn-${turn.id}`;
      row.dataset.reviewKind = turnReviewKind(current);
      if (current) row.setAttribute("aria-current", "true");

      const sequence = graphDocument.createElement("span");
      sequence.className = "turn-option-number";
      sequence.textContent = `Turn ${index + 1}`;
      const promptText = graphDocument.createElement("span");
      promptText.className = "turn-option-prompt";
      promptText.textContent = turn.text || turn.summary || turn.content || "Untitled interaction";
      const statusText = graphDocument.createElement("span");
      statusText.className = "turn-option-status";
      statusText.textContent = status.label;
      row.append(sequence, promptText, statusText);
      row.onclick = () => {
        closeTurnPopover();
        const intent = turnSelectionIntent(turns, interaction?.id, turn.id);
        if (!intent) return;
        if (onSelectTurnById) onSelectTurnById(intent.interactionId);
        else onSelectTurn(intent.offset);
      };
      return row;
    });
    $("#turnPopover").replaceChildren(...rows);
    if (focusedTurnId !== null) {
      [...$("#turnPopover").querySelectorAll("[data-turn-id]")]
        .find((row) => row.dataset.turnId === focusedTurnId)
        ?.focus({ preventScroll: true });
    }
    $("#turnPopover").classList.toggle("hidden", !turnPopoverOpen || !turns.length);
    pickerButton.setAttribute("aria-expanded", String(turnPopoverOpen && turns.length > 0));
    if (!turns.length) turnPopoverOpen = false;
  }

  function render() {
    const state = getState();
    const thread = getThread();
    if (!thread) {
      showEmpty();
      return;
    }
    applyMode();
    showThread();
    renderExportControl(thread);
    renderHistoryNavigation();
    $("#threadTitle").textContent = thread.title;
    const project = state.projects.find((item) => String(item.id) === String(thread.projectId));
    const permissionProfile = state.permissionProfiles?.find((item) => item.id === thread.permissionProfileId);
    const permissionLabel = permissionProfile?.label || thread.permissionProfileId;
    const harnessId = thread.harnessId ?? thread.harnessConfigurationName;
    const harness = state.modelSettings?.harnesses?.find((item) => item.id === harnessId);
    $("#threadScope").textContent = `${project?.name || "No folder"} · ${permissionLabel} · ${harness?.label ?? harnessId}`;
    const interaction = interactionForThread(state, thread);
    $("#interactionText").textContent = interaction?.text
      || interaction?.summary
      || interaction?.content
      || thread.title;
    renderTurnNavigation(state, thread, interaction);
    const turns = (state.interactions || []).filter((item) => String(item.threadId) === String(thread.id));
    const latestInteraction = turns.at(-1);
    const inheritanceKey = `${thread.id}:${latestInteraction?.id ?? "none"}`;
    if (modelPicker) {
      const replaceSelection = inheritanceKey !== pickerInheritanceKey;
      modelPicker.setContext({
        settings: state.modelSettings,
        pinnedHarnessId: harnessId,
        selection: replaceSelection
          ? selectionForNextInteraction(state.modelSettings, harnessId, latestInteraction)
          : undefined,
        replaceSelection,
      });
      pickerInheritanceKey = inheritanceKey;
    }
    const interactionSelection = interactionModelSelection(interaction);
    const identityLabels = interactionSelection
      ? modelSelectionLabels(state.modelSettings, { harnessId, ...interactionSelection })
      : null;
    const identity = $("#interactionModelIdentity");
    identity.textContent = identityLabels ? ` · ${identityLabels.compact}` : "";
    identity.title = identityLabels
      ? `${identityLabels.provider}: ${identityLabels.model}`
      : "";
    identity.classList.toggle("hidden", !identityLabels);
    renderInteractionState(state);
    renderApprovalDock(state, thread);
    renderGraph(state, thread);
    if (selection.selectedNodeId != null) {
      selectNode(state, selection.selectedNodeId, { notify: false });
    } else if (!$("#inspector").classList.contains("hidden")) {
      cancelInspectorFit();
      $("#inspector").classList.add("hidden");
    }
    renderBreadcrumb(state, thread);
  }

  function renderBreadcrumb(state = getState(), thread = getThread()) {
    const breadcrumb = $("#workspaceBreadcrumb");
    const items = workspaceBreadcrumbItems(state, thread, selection);
    const children = [];
    items.forEach((item, index) => {
      if (index > 0) {
        const separator = graphDocument.createElement("span");
        separator.className = "breadcrumb-separator";
        separator.setAttribute("aria-hidden", "true");
        separator.textContent = "/";
        children.push(separator);
      }
      const segment = graphDocument.createElement(item.interactive ? "button" : "span");
      segment.className = `breadcrumb-segment breadcrumb-${item.kind}`;
      segment.append(createRelayerIcon(item.icon, { class: "breadcrumb-icon" }));
      const label = graphDocument.createElement("span");
      label.className = "breadcrumb-label";
      label.textContent = item.label;
      segment.append(label);
      segment.title = item.description
        ? `${item.label}: ${item.description}`
        : item.label;
      if (item.current) segment.setAttribute("aria-current", "location");
      if (item.interactive) {
        segment.type = "button";
        segment.setAttribute("aria-label", `Go to ${item.label}`);
        segment.dataset.reviewRef = `breadcrumb-${item.key}`;
        segment.dataset.reviewKind = "layer-navigation";
        segment.dataset.reviewPathIndex = String(item.pathIndex);
        segment.onclick = () => onNavigateLayer(item.layerId, {
          restore: true,
          pathIndex: item.pathIndex,
        });
      }
      children.push(segment);
    });
    breadcrumb.replaceChildren(...children);
    breadcrumb.scrollLeft = breadcrumb.scrollWidth;
  }

  function renderInteractionState(state) {
    const status = state.status || "idle";
    prompt.disabled = composerDisabledForState(status, capabilities.canCompose);
    modelPicker?.setDisabled(prompt.disabled);
    syncComposer();
  }

  function renderApprovalDock(state, thread) {
    const pending = pendingApprovalsForThread(state, thread);
    const threadKey = String(thread?.id);
    const priorRequestId = approvalSelections.get(threadKey);
    const selected = selectedPendingApproval(pending, priorRequestId);
    const activeWasInside = approvalDock.contains(graphDocument.activeElement);
    const wasHidden = approvalDock.classList.contains("hidden");
    const wasHistoryOnly = approvalDock.classList.contains("history-only");
    const history = resolvedApprovalHistoryForThread(state, thread);
    const dockMode = approvalDockMode(pending, history);
    const renderHistory = () => {
      $("#approvalHistory").classList.toggle("hidden", history.length === 0);
      $("#approvalHistorySummary").textContent = `Approval history (${history.length})`;
      $("#approvalHistoryList").replaceChildren(...history.map((receipt) => {
        const item = graphDocument.createElement("li");
        item.textContent = `${receipt.request.title} — ${approvalResolutionLabel(receipt)}`;
        return item;
      }));
    };
    if (!selected) {
      approvalSelections.delete(threadKey);
      const focus = composerFocusRestoration(restoreComposerFocusThreadId, {
        activeWasInside,
        dockThreadId: approvalDock.dataset.threadId,
        threadId: threadKey,
        canCompose: capabilities.canCompose,
        promptDisabled: prompt.disabled,
      });
      restoreComposerFocusThreadId = focus.pendingThreadId;
      approvalDock.classList.toggle("hidden", dockMode === "hidden");
      approvalDock.classList.toggle("history-only", dockMode === "history");
      approvalDock.removeAttribute("aria-busy");
      approvalDock.dataset.threadId = threadKey;
      $("#threadComposer").classList.remove("hidden");
      if (dockMode === "history") {
        approvalDock.setAttribute("aria-describedby", "approvalHistorySummary");
        $("#approvalStatusIcon").textContent = "✓";
        $("#approvalEyebrow").textContent = "Resolved";
        $("#approvalTitle").textContent = "Approval history";
        $("#approvalQueueControls").classList.add("hidden");
        $("#approvalReason").classList.add("hidden");
        $(".approval-action-summary").classList.add("hidden");
        $(".approval-metadata").classList.add("hidden");
        $("#approvalError").classList.add("hidden");
        $(".approval-actions").classList.add("hidden");
        renderHistory();
      }
      if (focus.shouldFocus) {
        prompt.focus({ preventScroll: true });
      }
      return;
    }
    const request = selected.request;
    const requestId = String(request.requestId);
    const selectedDisappeared = priorRequestId != null
      && !pending.some((receipt) => String(receipt.request.requestId) === String(priorRequestId));
    approvalSelections.set(threadKey, requestId);
    approvalDock.classList.remove("hidden");
    approvalDock.classList.remove("history-only");
    approvalDock.setAttribute(
      "aria-describedby",
      "approvalReason approvalActionValue approvalScopeDescription",
    );
    approvalDock.dataset.threadId = threadKey;
    $("#threadComposer").classList.add("hidden");
    approvalDock.dataset.requestId = requestId;
    $("#approvalStatusIcon").textContent = "!";
    $("#approvalEyebrow").textContent = "Needs approval";
    $("#approvalTitle").textContent = request.title;
    $("#approvalReason").classList.remove("hidden");
    $("#approvalReason").textContent = request.reason;
    $(".approval-action-summary").classList.remove("hidden");
    $(".approval-metadata").classList.remove("hidden");
    $(".approval-actions").classList.remove("hidden");
    $("#approvalScopeDescription").textContent = request.scopeDescription;
    const action = approvalActionPresentation(request.action);
    $("#approvalActionLabel").textContent = action.label;
    $("#approvalActionValue").textContent = action.value;
    $("#approvalWorkingDirectoryRow").classList.toggle("hidden", !action.workingDirectory);
    $("#approvalWorkingDirectory").textContent = action.workingDirectory || "";
    $("#approvalAffectedFilesRow").classList.toggle("hidden", action.affectedFiles.length === 0);
    $("#approvalAffectedFiles").textContent = action.affectedFiles.join(", ");
    const index = pending.findIndex((receipt) => String(receipt.request.requestId) === requestId);
    $("#approvalQueuePosition").textContent = `${index + 1} of ${pending.length}`;
    $("#approvalQueueControls").classList.toggle("hidden", pending.length < 2);
    renderHistory();
    const error = approvalErrors.get(requestId);
    $("#approvalError").classList.toggle("hidden", !error);
    $("#approvalError").textContent = error || "";
    const decisionPending = approvalDecisionsInFlight.has(requestId)
      || state.pendingApprovalDecisions?.some((id) => String(id) === requestId);
    approvalDock.setAttribute("aria-busy", String(decisionPending));
    for (const selector of ["#denyApproval", "#approveOnce", "#approveAlways"]) {
      $(selector).disabled = decisionPending || !capabilities.canResolveApprovals;
    }
    if (wasHidden || wasHistoryOnly || selectedDisappeared) {
      approvalDock.focus({ preventScroll: true });
    }
  }

  function renderGraph(state, thread) {
    const responseNodes = responseNodesForThread(state, thread);
    const nextViewKey = graphCameraViewKey(state, thread, responseNodes);
    const enteringView = nextViewKey !== graphViewKey;
    if (enteringView) {
      cancelInspectorFit();
      $("#inspector").classList.add("hidden");
      saveGraphView();
    }
    $("#graphEmpty").classList.toggle("hidden", responseNodes.length > 0);
    $("#graphStage").classList.toggle("hidden", responseNodes.length === 0);
    if (!responseNodes.length) {
      graphViewKey = nextViewKey;
      graphNodes = [];
      graphEdges = [];
      graphSignature = "";
      selection.selectedNodeId = null;
      $("#inspector").classList.add("hidden");
      const pending = thread?.imported !== true && PENDING_COMPLETION_STATUSES.has(state.status);
      $("#thinkingDots").classList.toggle("hidden", !pending);
      $("#graphEmptyMessage").classList.toggle("hidden", pending);
      $("#graphEmptyMessage").textContent = thread?.imported === true && PENDING_COMPLETION_STATUSES.has(state.status)
        ? "This imported interaction was unfinished and has no accepted graph."
        : state.status === "failed"
        ? "This interaction failed before producing an accepted graph."
        : "This interaction has no accepted graph yet.";
      return;
    }

    const cachedView = enteringView ? graphViewCache.get(nextViewKey) : null;
    const previous = new Map(
      (cachedView?.nodes ?? (!enteringView ? graphNodes : []))
        .map((node) => [String(node.id), node]),
    );
    graphViewKey = nextViewKey;
    graphNodes = responseNodes.map((node, index) => ({
      ...node,
      x: 0,
      y: 0,
      pinned: false,
      index,
    }));
    const ids = graphNodeIdentitySet(graphNodes);
    graphEdges = (state.edges || []).filter((edge) => {
      const [source, target] = edge.endpoints || [edge.source, edge.target];
      return ids.has(String(source)) && ids.has(String(target));
    });
    const nextSignature = graphLayoutSignature(state.visibleLayer, graphNodes, graphEdges);
    const cachedLayoutMatches = cachedView
      ? cachedView.signature === nextSignature
      : !enteringView && graphSignature === nextSignature;
    graphSignature = nextSignature;
    $("#nodeLayer").innerHTML = graphNodes.map((node) => `<div class="graph-node ${String(node.id) === String(selection.selectedNodeId) ? "selected" : ""}" data-node="${escapeHtml(node.id)}" data-review-ref="node-${escapeHtml(node.id)}" data-review-kind="node" role="button" tabindex="0" aria-label="Open ${escapeHtml(node.title)}"><div class="glyph"></div><div class="copy"><b>${escapeHtml(node.title)}</b></div></div>`).join("");
    $$('[data-node]').forEach((element) => {
      const authoredNode = graphNodes.find((candidate) => String(candidate.id) === element.dataset.node);
      let suppressClickAfterDrag = false;
      element.querySelector(".glyph").replaceChildren(createRelayerIcon(
        authoredNode?.icon || authoredNode?.metadata?.relayer?.icon,
        { class: "relayer-node-icon" },
      ));
      if (authoredNode) {
        authoredNode.layoutBounds = graphNodeLayoutBounds(
          element.offsetWidth,
          element.offsetHeight,
        );
      }
      element.onclick = () => {
        if (!shouldActivateGraphNodeAfterPointerGesture(suppressClickAfterDrag)) {
          suppressClickAfterDrag = false;
          return;
        }
        selectNode(state, element.dataset.node);
      };
      element.onkeydown = (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        selectNode(state, element.dataset.node);
      };
      element.onpointerdown = (event) => {
        event.preventDefault();
        event.stopPropagation();
        focusGraph();
        const node = graphNodes.find((candidate) => String(candidate.id) === element.dataset.node);
        dragging = node ? {
          node,
          startClientX: event.clientX,
          startClientY: event.clientY,
          moved: false,
        } : null;
        element.setPointerCapture(event.pointerId);
      };
      element.onpointermove = (event) => {
        if (!dragging || String(dragging.node.id) !== element.dataset.node) return;
        const rect = $("#graphStage").getBoundingClientRect();
        const distance = Math.hypot(
          event.clientX - dragging.startClientX,
          event.clientY - dragging.startClientY,
        );
        dragging.moved ||= distance >= 3;
        const point = graphWorldPoint({
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        }, camera);
        dragging.node.x = point.x;
        dragging.node.y = point.y;
        if (dragging.moved) dragging.node.pinned = true;
        drawGraph();
      };
      element.onpointerup = () => {
        suppressClickAfterDrag = Boolean(dragging?.moved);
        if (suppressClickAfterDrag) {
          graphWindow?.setTimeout?.(() => { suppressClickAfterDrag = false; }, 0);
        }
        dragging = null;
      };
      element.onpointercancel = () => { dragging = null; };
    });
    const projected = projectLayerNodePositions(state.visibleLayer, graphNodes);
    for (const node of graphNodes) {
      const canonical = projected.positions.get(String(node.id));
      if (!canonical) throw new Error(`Visible graph layout is missing node ${String(node.id)}.`);
      node.canonicalX = canonical.x;
      node.canonicalY = canonical.y;
      node.layoutSource = projected.source;
      const prior = previous.get(String(node.id));
      if (cachedLayoutMatches && prior?.pinned) {
        node.x = prior.x;
        node.y = prior.y;
        node.pinned = true;
      } else {
        node.x = canonical.x;
        node.y = canonical.y;
      }
    }
    if (enteringView && !ids.has(String(selection.selectedNodeId))) {
      selection.selectedNodeId = null;
      $("#inspector").classList.add("hidden");
    }
    if (cachedView && cachedLayoutMatches) {
      camera = { ...cachedView.camera };
      cameraRevision = cachedView.cameraRevision;
    } else if (enteringView || !cachedLayoutMatches) {
      camera = fitGraphCamera(graphNodes, graphStage.getBoundingClientRect());
    }
    drawGraph();
  }

  function drawGraph() {
    for (const node of graphNodes) {
      const element = $$('[data-node]').find((item) => item.dataset.node === String(node.id));
      if (element) {
        const point = graphScreenPoint(node, camera);
        element.style.left = `${point.x}px`;
        element.style.top = `${point.y}px`;
        element.style.setProperty("--graph-zoom", camera.zoom);
        element.dataset.worldX = String(node.x);
        element.dataset.worldY = String(node.y);
        element.dataset.canonicalWorldX = String(node.canonicalX);
        element.dataset.canonicalWorldY = String(node.canonicalY);
        element.dataset.layoutSource = node.layoutSource;
      }
    }
    $("#edgeCanvas").innerHTML = graphEdges.map((edge) => {
      const [source, target] = edge.endpoints || [edge.source, edge.target];
      const a = graphNodes.find((node) => String(node.id) === String(source));
      const b = graphNodes.find((node) => String(node.id) === String(target));
      if (!a || !b) return "";
      const segment = graphEdgeSegment(
        graphScreenPoint(a, camera),
        graphScreenPoint(b, camera),
        GRAPH_NODE_ICON_RADIUS * camera.zoom,
      );
      return `<line class="graph-edge" style="stroke-width:${graphEdgeStrokeWidth(camera.zoom)}" x1="${segment.x1}" y1="${segment.y1}" x2="${segment.x2}" y2="${segment.y2}"/>`;
    }).join("");
    graphStage.style.backgroundSize = `${22 * camera.zoom}px ${22 * camera.zoom}px`;
    graphStage.style.backgroundPosition = `${camera.x}px ${camera.y}px`;
    $("#graphZoomLevel").textContent = `${Math.round(camera.zoom * 100)}%`;
    $("#zoomOutGraph").disabled = camera.zoom <= GRAPH_MIN_ZOOM;
    $("#zoomInGraph").disabled = camera.zoom >= GRAPH_MAX_ZOOM;
    saveGraphView();
  }

  function saveGraphView() {
    if (!graphViewKey || !graphNodes.length) return;
    graphViewCache.set(graphViewKey, captureGraphViewState(
      graphNodes,
      camera,
      graphSignature,
      cameraRevision,
    ));
  }

  function selectNode(state, id, { notify = true } = {}) {
    selection.selectedNodeId = id;
    const node = state.nodes.find((item) => String(item.id) === String(id));
    if (!node) return;
    if (notify) onSelectionChange(node.id);
    const inspector = $("#inspector");
    const wasOpen = !inspector.classList.contains("hidden");
    inspectorUsesOverlay = narrowInspectorMedia?.matches
      ?? (graphWindow?.innerWidth ?? 0) <= 760;
    inspector.classList.remove("hidden");
    const viewportWidth = graphDocument.defaultView?.innerWidth ?? 0;
    if (shouldFitInspectorOpen(wasOpen, true, viewportWidth)) {
      scheduleInspectorFit();
    }
    $("#detailIcon").replaceChildren(createRelayerIcon(
      node.icon || node.metadata?.relayer?.icon,
      { class: "relayer-detail-icon" },
    ));
    $("#detailKind").textContent = node.kind;
    $("#detailTitle").textContent = node.title;
    renderMarkdown($("#detailContent"), node.detail || node.summary || node.content || "No details supplied.");
    const actions = (state.actions || []).filter((action) => String(action.sourceNodeId) === String(node.id));
    $("#detailActions").classList.toggle("hidden", !actions.length);
    $("#detailActions").replaceChildren(...actions.map((action) => {
      const presentation = actionPresentation(action);
      const button = graphDocument.createElement("button");
      button.type = "button";
      button.className = `action-control action-${presentation.variant}`;
      button.dataset.actionId = String(action.id);
      button.dataset.reviewRef = `action-${action.id}`;
      button.dataset.reviewKind = actionReviewKind(action);
      button.dataset.reviewActionId = String(action.id);
      if (action.targetLayerId != null) {
        button.dataset.reviewTargetLayerId = String(action.targetLayerId);
      }
      if (presentation.icon) {
        button.append(createRelayerIcon(presentation.icon, { class: "relayer-action-icon" }));
      }
      const copy = graphDocument.createElement("span");
      copy.className = "action-copy";
      const label = graphDocument.createElement(presentation.variant === "card" ? "strong" : "span");
      label.className = "action-label";
      label.textContent = presentation.label;
      copy.append(label);
      if (presentation.description) {
        const description = graphDocument.createElement("small");
        description.textContent = presentation.description;
        copy.append(description);
      }
      button.append(copy);
      return button;
    }));
    [...$("#detailActions").querySelectorAll("button")].forEach((button, index) => {
      const action = actions[index];
      const invoked = actionWasInvoked(
        state.actionInvocations,
        state.pendingActionInvocations,
        state.currentInteractionId,
        action.id,
      );
      const retryable = actionCanRetry(state.actionInvocations, action.id);
      const activation = actionActivationPresentation(action, {
        invoked,
        retryable,
        canInvokeMutatingActions: capabilities.canInvokeMutatingActions,
      });
      button.querySelector(".action-label").textContent = activation.label;
      button.disabled = activation.disabled;
      button.classList.toggle("invoked", invoked);
      button.classList.toggle("retryable", activation.retryableInvoke);
      button.onclick = async () => {
        if (activation.navigational) {
          button.disabled = true;
          try {
            if (activation.resolvedInvoke) await onNavigateResolvedInvoke(action);
            else await onNavigateLayer(action.targetLayerId, { action, sourceNode: node });
          } finally {
            if (button.isConnected) button.disabled = false;
          }
          return;
        }
        button.disabled = true;
        button.classList.add("invoked");
        await onInvokeAction(action);
      };
    });
    $$('[data-node]').forEach((element) => {
      element.classList.toggle("selected", element.dataset.node === String(id));
    });
    renderBreadcrumb(state, getThread());
  }

  function dispose() {
    modelPicker?.dispose();
    cancelInspectorFit();
    graphDocument.removeEventListener("pointerdown", blurGraphFromOutsidePointer, true);
    graphDocument.removeEventListener("pointerdown", closeTurnPopoverFromOutside, true);
    graphDocument.removeEventListener("pointerdown", closeSettingsMenuFromOutside, true);
    graphDocument.removeEventListener("keydown", closeTurnPopoverOnEscape, true);
    graphDocument.removeEventListener("keydown", closeSettingsMenuOnEscape, true);
    narrowInspectorMedia?.removeEventListener?.("change", handleInspectorLayoutChange);
    dragging = null;
    panning = null;
    pinching = null;
    activeTouchPointers.clear();
    camera = { x: 0, y: 0, zoom: 1 };
    graphNodes = [];
    graphEdges = [];
    graphSignature = "";
    graphViewKey = "";
    graphViewCache.clear();
  }

  return Object.freeze({
    mode,
    capabilities,
    render,
    modelSelectionPayload: () => modelPicker?.isReady()
      ? pickerSelectionPayload(modelPicker.getSelection())
      : null,
    dispose,
  });
}
