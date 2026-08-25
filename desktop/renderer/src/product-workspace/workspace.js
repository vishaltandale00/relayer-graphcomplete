import { escapeHtml, toast } from "../ui.js";
import { actionCanRetry, actionWasInvoked } from "../action-invocation-state.js";
import { setControlActivationCompletion } from "../control-activation.js";
import {
  createModelPicker,
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
  annotationNavigationContext,
  annotationRatingLabel,
  annotationSubjectContextChanged,
  annotationTimestamp,
  annotationsForAnchor,
  latestAnnotationRevision,
  sameAnnotationAnchor,
} from "./annotations.js";
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

export function resolveInteractionContextNode(nodeId, nodes, contexts, overrides) {
  return (nodes || []).find((node) => String(node.id) === String(nodeId))
    || (contexts || []).find((context) => (
      String(context.target.nodeId) === String(nodeId)
    ))?.node
    || overrides?.get(String(nodeId));
}

export function hasHistoricalContextSelection(nodeId, contextTarget, overrides) {
  return contextTarget != null
    && String(contextTarget.nodeId) === String(nodeId)
    && overrides?.has(String(nodeId));
}

export function graphRenderClearsSelection({
  hasResponseNodes,
  enteringView,
  nodeInGraph,
  preserveHistoricalSelection,
}) {
  return !preserveHistoricalSelection
    && (!hasResponseNodes || (enteringView && !nodeInGraph));
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
  return false;
}

export function shouldFitInspectorDock(previousOverlay, nextOverlay, inspectorOpen) {
  return false;
}

export function shouldRevealStackedInspector(viewportWidth, userInitiated = true) {
  return userInitiated && viewportWidth > 0 && viewportWidth <= 1100;
}

export function inspectorFocusRestorationTarget(
  origin,
  graph,
  fallbacks = [],
  isAvailable = (candidate) => candidate != null,
) {
  return [origin, graph, ...fallbacks].find((candidate) => isAvailable(candidate)) ?? null;
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
  if (status === "accepted") return { kind: "accepted", label: "", hidden: true };
  if (status === "failed") return { kind: "failed", label: "Failed" };
  if (status === "cancelled") return { kind: "cancelled", label: "Cancelled" };
  if (status === "stopped") return { kind: "stopped", label: "Stopped" };
  return { kind: "unknown", label: status ? String(status).replaceAll("_", " ") : "Unknown" };
}

export function environmentPresentation(environment, project) {
  if (!project?.id) {
    return { mode: "message", message: "No project folder", busy: false };
  }
  if (!environment || String(environment.projectId) !== String(project.id)) {
    return { mode: "loading", message: "Loading project context…", busy: true };
  }
  if (environment.status === "loading" && !environment.snapshot) {
    return { mode: "loading", message: "Loading project context…", busy: true };
  }
  if (environment.status === "error" && !environment.snapshot) {
    return {
      mode: "message",
      message: environment.error || "Project context is temporarily unavailable.",
      busy: false,
    };
  }
  const snapshot = environment.snapshot;
  if (!snapshot) {
    return { mode: "message", message: "Project context is unavailable.", busy: false };
  }
  const worktreeLabel = snapshot.worktreeLabel || project.name || "Project folder";
  const stale = environment.status === "error";
  const staleMessage = stale
    ? environment.error || "Refresh failed. Showing the last local snapshot."
    : null;
  if (snapshot.kind === "folder") {
    return {
      mode: "facts",
      kind: "folder",
      worktreeLabel,
      message: "Not a Git repository",
      observedAt: snapshot.observedAt,
      stale,
      staleMessage,
      busy: false,
    };
  }
  if (snapshot.kind === "unavailable") {
    return {
      mode: "facts",
      kind: "unavailable",
      worktreeLabel,
      message: snapshot.unavailableReason?.message || "Project context is temporarily unavailable.",
      observedAt: snapshot.observedAt,
      stale,
      staleMessage,
      busy: false,
    };
  }
  const changes = snapshot.changes || {};
  return {
    mode: "facts",
    kind: "git",
    worktreeLabel,
    branch: snapshot.detached ? "Detached HEAD" : (snapshot.branch || "Branch unavailable"),
    additions: Number.isFinite(changes.additions) ? changes.additions : 0,
    deletions: Number.isFinite(changes.deletions) ? changes.deletions : 0,
    trackedFiles: Number.isFinite(changes.trackedFiles) ? changes.trackedFiles : 0,
    untrackedFiles: Number.isFinite(changes.untrackedFiles) ? changes.untrackedFiles : 0,
    observedAt: snapshot.observedAt,
    busy: environment.status === "loading",
    stale,
    staleMessage,
  };
}

export function trackedChangesLabel({ additions = 0, deletions = 0, trackedFiles = 0 }) {
  if (additions !== 0 || deletions !== 0 || trackedFiles <= 0) return "";
  return `· ${trackedFiles} tracked ${trackedFiles === 1 ? "file" : "files"}`;
}

export function untrackedFilesLabel(count = 0) {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

export function interactionStatusRenderKey(interaction, fallbackStatus = "idle") {
  return `${interaction?.id ?? "none"}:${interaction?.completionStatus || fallbackStatus}`;
}

export function inspectorEscapeShouldClose({
  key,
  settingsMenuOpen,
  turnPopoverOpen,
  modelPickerOpen,
  approvalOwnsFocus,
  annotationRatingExpanded = false,
  inspectorOpen,
}) {
  return key === "Escape"
    && !settingsMenuOpen
    && !turnPopoverOpen
    && !modelPickerOpen
    && !approvalOwnsFocus
    && !annotationRatingExpanded
    && inspectorOpen;
}

export function workspaceBreadcrumbShouldRender(items = []) {
  const [onlyItem] = items;
  return items.length > 0 && !(
    items.length === 1
    && onlyItem.kind === "layer"
    && onlyItem.label === "Response"
    && onlyItem.pathIndex === 0
    && onlyItem.actionId == null
  );
}

export function workspaceRootAnnotationShouldRender(items = [], annotationEnabled = false) {
  return annotationEnabled && items.length === 1 && !workspaceBreadcrumbShouldRender(items);
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

export function contextDraftHasAnnotation(contexts = []) {
  return contexts.some((context) => (
    (context.annotations || []).some((annotation) => Boolean(String(annotation).trim()))
  ));
}

export function composerSubmissionReady(
  value,
  disabled = false,
  modelReady = true,
  contexts = [],
  editorOpen = false,
) {
  return !disabled
    && modelReady
    && !editorOpen
    && (Boolean(value.trim()) || contextDraftHasAnnotation(contexts));
}

export function interactionContextPayload(contexts = []) {
  return contexts.map((context) => ({
    target: {
      nodeId: context.target.nodeId,
      sourceInteractionNodeId: context.target.sourceInteractionNodeId,
      sourceLayerId: context.target.sourceLayerId,
    },
    annotations: (context.annotations || []).map((annotation) => String(annotation).trim()),
  }));
}

export function contextEditorCanConfirm(editor) {
  return Boolean(editor) && (editor.attaching || Boolean(String(editor.value).trim()));
}

export function contextEditorPresentation(editor, stagingDisabled = false) {
  return {
    textareaDisabled: stagingDisabled,
    confirmDisabled: stagingDisabled || !contextEditorCanConfirm(editor),
  };
}

export function applyContextEditor(contexts, editor, node, target) {
  if (!contextEditorCanConfirm(editor)) return contexts;
  const next = contexts.map((context) => ({ ...context, annotations: [...context.annotations] }));
  let context = next.find((candidate) => String(candidate.target.nodeId) === String(node.id));
  if (!context) {
    context = { target, node, annotations: [] };
    next.push(context);
  }
  const value = String(editor.value).trim();
  if (editor.annotationIndex != null) context.annotations[editor.annotationIndex] = value;
  else if (value) context.annotations.push(value);
  return next;
}

export function contextDetachNeedsConfirmation(context) {
  return Boolean(context?.annotations?.length);
}

export function removeContextAnnotation(contexts, nodeId, annotationIndex) {
  return contexts.map((context) => (
    String(context.target.nodeId) === String(nodeId)
      ? {
        ...context,
        annotations: context.annotations.filter((_, index) => index !== annotationIndex),
      }
      : context
  ));
}

export function interactionContextDraftTransition(draft, event) {
  if (event === "durable_send" || event === "thread_change") {
    return { contexts: [], editor: null };
  }
  if (event === "send_failure") return draft;
  throw new Error(`Unknown interaction context draft event: ${event}`);
}

export function contextStagingDisabledFor(status, canCompose = true, requestDisabled = false) {
  return requestDisabled || composerDisabledForState(status, canCompose);
}

export function composerDisabledForState(status, canCompose = true) {
  return !canCompose || PENDING_COMPLETION_STATUSES.has(status);
}

export function composerStatusForThread(state, thread) {
  return workspaceTurns(state, thread).at(-1)?.completionStatus || state.status || "idle";
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
  annotationApi = null,
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
  let renderedInteractionStatusKey = null;
  const approvalSelections = new Map();
  const approvalErrors = new Map();
  const approvalDecisionsInFlight = new Set();
  let restoreComposerFocusThreadId = null;
  const graphViewCache = new Map();
  const activeTouchPointers = new Map();
  const annotationCache = new Map();
  const annotationLoads = new Map();
  const annotationLoadRevisions = new Map();
  let annotationSubject = null;
  let annotationThreadId = null;
  let renderedThreadId = null;
  let annotationRatingTouched = false;
  let editingAnnotation = null;
  let inspectorFocusOrigin = null;
  let composerContexts = [];
  let contextEditor = null;
  let contextPopoverOpen = false;
  const contextNodeOverrides = new Map();
  let selectedContextTarget = null;

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
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
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
  const inspectorFocusTargetIsAvailable = (element) => {
    if (!element?.isConnected || typeof element.focus !== "function" || element.disabled) return false;
    if (element.classList?.contains("hidden") || element.closest?.(".hidden,[hidden],[aria-hidden='true']")) {
      return false;
    }
    const style = graphWindow?.getComputedStyle?.(element);
    return style?.display !== "none" && style?.visibility !== "hidden";
  };
  const openInspector = ({ userInitiated = true, origin = null } = {}) => {
    if (userInitiated) inspectorFocusOrigin = origin;
    const inspector = $("#inspector");
    const wasOpen = !inspector.classList.contains("hidden");
    inspectorUsesOverlay = narrowInspectorMedia?.matches
      ?? (graphWindow?.innerWidth ?? 0) <= 760;
    inspector.classList.remove("hidden");
    const viewportWidth = graphWindow?.innerWidth ?? 0;
    if (shouldFitInspectorOpen(wasOpen, true, viewportWidth)) scheduleInspectorFit();
    return {
      inspector,
      reveal: () => {
        if (shouldRevealStackedInspector(viewportWidth, userInitiated)) {
          inspector.scrollIntoView({ block: "start" });
        }
      },
    };
  };
  const closeInspector = ({ restoreFocus = true } = {}) => {
    cancelInspectorFit();
    selection.selectedNodeId = null;
    selectedContextTarget = null;
    annotationSubject = null;
    annotationThreadId = null;
    resetAnnotationComposer();
    onSelectionChange(null);
    $("#inspector").classList.add("hidden");
    $$('[data-node]').forEach((element) => element.classList.remove("selected"));
    renderBreadcrumb();
    const focusTarget = restoreFocus
      ? inspectorFocusRestorationTarget(
        inspectorFocusOrigin,
        graphStage,
        [$("#threadAnnotationBadge"), $("#turnAnnotationBadge"), settingsButton],
        inspectorFocusTargetIsAvailable,
      )
      : null;
    inspectorFocusOrigin = null;
    focusTarget?.focus({ preventScroll: true });
  };
  $("#closeInspector").onclick = () => closeInspector();
  const closeInspectorOnEscape = (event) => {
    if (!inspectorEscapeShouldClose({
      key: event.key,
      settingsMenuOpen,
      turnPopoverOpen,
      modelPickerOpen: !$("[data-model-picker-popover]")?.classList.contains("hidden"),
      approvalOwnsFocus: approvalDock.contains(graphDocument.activeElement),
      annotationRatingExpanded: $("#annotationRating")?.classList.contains("expanded"),
      inspectorOpen: !$("#inspector").classList.contains("hidden"),
    })) return;
    event.preventDefault();
    closeInspector();
  };
  graphDocument.addEventListener("keydown", closeInspectorOnEscape, true);
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
  const closeContextPopover = ({ restoreFocus = false } = {}) => {
    contextPopoverOpen = false;
    $("#interactionContextPopover").classList.add("hidden");
    $("#interactionContextPill").setAttribute("aria-expanded", "false");
    if (restoreFocus) $("#interactionContextPill").focus();
  };
  const closeContextPopoverFromOutside = (event) => {
    if (!contextPopoverOpen || $("#turnPicker").contains(event.target)) return;
    closeContextPopover();
  };
  const closeContextPopoverOnEscape = (event) => {
    if (!contextPopoverOpen || event.key !== "Escape") return;
    event.preventDefault();
    closeContextPopover({ restoreFocus: true });
  };
  graphDocument.addEventListener("pointerdown", closeContextPopoverFromOutside, true);
  graphDocument.addEventListener("keydown", closeContextPopoverOnEscape, true);
  $("#interactionContextPill").onclick = () => {
    closeTurnPopover();
    contextPopoverOpen = !contextPopoverOpen;
    $("#interactionContextPopover").classList.toggle("hidden", !contextPopoverOpen);
    $("#interactionContextPill").setAttribute("aria-expanded", String(contextPopoverOpen));
  };
  const annotationEnabled = Boolean(annotationApi);
  const ratingSurface = $("#annotationRating");
  const ratingInput = $("#annotationRatingInput");
  const ratingOutput = $("#annotationRatingOutput");

  function setAnnotationRating(value, { touched = true } = {}) {
    const normalized = Math.min(4, Math.max(1, Number(value) || 2));
    ratingInput.value = String(normalized);
    ratingSurface.style.setProperty("--annotation-rating", String(normalized));
    ratingSurface.style.setProperty(
      "--annotation-rating-progress",
      `${(normalized - 1) * 33.333}%`,
    );
    annotationRatingTouched = touched;
    const label = touched ? annotationRatingLabel(normalized) : null;
    ratingInput.setAttribute("aria-valuetext", label || "No rating selected");
    ratingOutput.textContent = label || "";
  }

  function setRatingExpanded(expanded) {
    ratingSurface.classList.toggle("expanded", expanded);
  }

  setAnnotationRating(2, { touched: false });
  ratingInput.onfocus = () => setRatingExpanded(true);
  ratingInput.onpointerdown = () => setRatingExpanded(true);
  ratingInput.oninput = () => setAnnotationRating(ratingInput.value);
  ratingInput.onkeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setRatingExpanded(false);
      ratingInput.blur();
    }
  };
  ratingSurface.onfocusout = () => graphDocument.defaultView.setTimeout(() => {
    if (!ratingSurface.contains(graphDocument.activeElement)) setRatingExpanded(false);
  }, 0);
  ratingSurface.querySelectorAll("[data-rating]").forEach((button) => {
    button.onclick = () => {
      setAnnotationRating(button.dataset.rating);
      ratingInput.focus({ preventScroll: true });
    };
  });
  $("#annotationComment").oninput = () => {
    $("#submitAnnotation").disabled = !$("#annotationComment").value.trim();
  };

  function currentInteraction(state = getState(), thread = getThread()) {
    return interactionForThread(state, thread);
  }

  function currentLayerId(state = getState(), thread = getThread()) {
    return state.visibleLayer?.layer?.id
      ?? currentInteraction(state, thread)?.completionOutput?.rootLayer?.layer?.id
      ?? null;
  }

  function subjectAnchor(kind, identity = {}, state = getState(), thread = getThread()) {
    const interactionId = currentInteraction(state, thread)?.id;
    const layerId = currentLayerId(state, thread);
    if (kind === "thread") return { kind: "thread" };
    if (kind === "turn") return { kind: "turn", interactionId };
    if (kind === "layer") return { kind: "layer", interactionId, layerId };
    if (kind === "node") return { kind: "node", interactionId, layerId, nodeId: identity.nodeId };
    if (kind === "edge") return { kind: "edge", interactionId, layerId, edgeId: identity.edgeId };
    if (kind === "action") return {
      kind: "action",
      interactionId,
      presentationLayerId: layerId,
      sourceLayerId: identity.sourceLayerId,
      nodeId: identity.nodeId,
      actionId: identity.actionId,
    };
    throw new Error(`Unknown annotation subject: ${kind}`);
  }

  function annotationsForCurrentThread() {
    const thread = getThread();
    return thread ? annotationCache.get(String(thread.id)) ?? [] : [];
  }

  function isCurrentAnnotationContext(threadId, anchor) {
    return String(getThread()?.id) === String(threadId)
      && String(annotationThreadId) === String(threadId)
      && sameAnnotationAnchor(annotationSubject?.anchor, anchor);
  }

  function annotationCount(anchor) {
    return annotationsForAnchor(annotationsForCurrentThread(), anchor).length;
  }

  function updateCountBadge(element, anchor) {
    const count = annotationCount(anchor);
    element.textContent = count ? String(count) : "✎";
    element.classList.toggle("hidden", !annotationEnabled);
    element.dataset.annotationKind = anchor.kind;
    element.setAttribute("aria-label", count
      ? `Open ${count} ${anchor.kind} comment${count === 1 ? "" : "s"}`
      : `Add ${anchor.kind} comment`);
  }

  async function loadAnnotations(thread, { force = false } = {}) {
    if (!annotationEnabled || !thread) return;
    const key = String(thread.id);
    if (!force && (annotationCache.has(key) || annotationLoads.has(key))) return;
    const loadRevision = (annotationLoadRevisions.get(key) || 0) + 1;
    annotationLoadRevisions.set(key, loadRevision);
    const loading = Promise.resolve(annotationApi.list(thread.id))
      .then((result) => {
        if (annotationLoadRevisions.get(key) !== loadRevision) return;
        annotationCache.set(key, Array.isArray(result?.annotations) ? result.annotations : []);
        if (String(getThread()?.id) === key) render();
      })
      .catch((error) => {
        if (
          annotationLoadRevisions.get(key) === loadRevision
          && String(getThread()?.id) === key
        ) {
          $("#annotationError").textContent = error.message;
          $("#annotationError").classList.remove("hidden");
        }
      })
      .finally(() => {
        if (annotationLoadRevisions.get(key) === loadRevision) annotationLoads.delete(key);
      });
    annotationLoads.set(key, loading);
    await loading;
  }

  function resetAnnotationComposer() {
    editingAnnotation = null;
    $("#annotationComment").value = "";
    $("#submitAnnotation").disabled = true;
    $("#annotationError").classList.add("hidden");
    setAnnotationRating(2, { touched: false });
    setRatingExpanded(false);
  }

  function renderAnnotationList() {
    const panel = $("#annotationPanel");
    panel.classList.toggle("hidden", !annotationEnabled || !annotationSubject);
    if (!annotationEnabled || !annotationSubject) return;
    const annotations = annotationsForAnchor(annotationsForCurrentThread(), annotationSubject.anchor);
    $("#annotationCount").textContent = String(annotations.length);
    const rows = annotations.map((annotation) => {
      const revision = latestAnnotationRevision(annotation);
      const article = graphDocument.createElement("article");
      article.className = "annotation-item";
      const meta = graphDocument.createElement("div");
      meta.className = "annotation-meta";
      const author = graphDocument.createElement("span");
      author.textContent = revision.authorDisplayName || "Annotator";
      const time = graphDocument.createElement("time");
      const createdAt = annotationTimestamp(revision.createdAt);
      time.dateTime = createdAt?.toISOString() || "";
      time.textContent = createdAt
        ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(createdAt)
        : "";
      meta.append(author, time);
      if (revision.rating != null) {
        const rating = graphDocument.createElement("span");
        rating.className = "annotation-item-rating";
        rating.textContent = annotationRatingLabel(revision.rating);
        meta.append(rating);
      }
      const comment = graphDocument.createElement("p");
      comment.textContent = revision.comment;
      const controls = graphDocument.createElement("div");
      controls.className = "annotation-item-controls";
      const edit = graphDocument.createElement("button");
      edit.type = "button";
      edit.textContent = "Edit";
      edit.onclick = () => {
        editingAnnotation = annotation;
        $("#annotationComment").value = revision.comment;
        $("#submitAnnotation").disabled = false;
        setAnnotationRating(revision.rating ?? 2, { touched: revision.rating != null });
        $("#annotationComment").focus();
      };
      const retract = graphDocument.createElement("button");
      retract.type = "button";
      retract.textContent = "Retract";
      retract.onclick = async () => {
        const operationThread = getThread();
        const operationAnchor = annotationSubject.anchor;
        if (String(operationThread?.id) !== String(annotationThreadId)) return;
        retract.disabled = true;
        try {
          await annotationApi.retract(operationThread.id, annotation.id, {
            expectedRevision: annotation.latestRevision,
            navigationContext: annotationNavigationContext(selection, operationAnchor),
            evidenceRefs: [],
          });
          annotationCache.delete(String(operationThread.id));
          await loadAnnotations(operationThread, { force: true });
        } catch (error) {
          if (isCurrentAnnotationContext(operationThread.id, operationAnchor)) {
            $("#annotationError").textContent = error.message;
            $("#annotationError").classList.remove("hidden");
            retract.disabled = false;
          }
        }
      };
      controls.append(edit, retract);
      article.append(meta, comment, controls);
      if ((annotation.revisions?.length ?? 0) > 1) {
        const history = graphDocument.createElement("details");
        const summary = graphDocument.createElement("summary");
        summary.textContent = `${annotation.revisions.length} revisions`;
        const list = graphDocument.createElement("ol");
        for (const prior of annotation.revisions.slice(0, -1).toReversed()) {
          const item = graphDocument.createElement("li");
          item.textContent = prior.comment || "Retracted";
          list.append(item);
        }
        history.append(summary, list);
        article.append(history);
      }
      return article;
    });
    $("#annotationList").replaceChildren(...rows);
    $("#annotationList").classList.toggle("empty", !rows.length);
  }

  function openAnnotationSubject(
    state,
    anchor,
    { title, kind, icon = "annotation", origin = null } = {},
  ) {
    const threadId = getThread()?.id;
    const subjectChanged = annotationSubjectContextChanged(
      annotationThreadId,
      annotationSubject?.anchor,
      threadId,
      anchor,
    );
    if (subjectChanged) resetAnnotationComposer();
    annotationThreadId = threadId;
    annotationSubject = { anchor, title, kind };
    selection.selectedNodeId = anchor.kind === "node" ? anchor.nodeId : null;
    onSelectionChange(selection.selectedNodeId);
    const { reveal } = openInspector({ origin });
    $("#detailIcon").textContent = icon === "annotation" ? "✎" : icon;
    $("#detailKind").textContent = kind || anchor.kind;
    $("#detailTitle").textContent = title || `${anchor.kind} comments`;
    $("#detailContent").replaceChildren();
    $("#detailActions").classList.add("hidden");
    $("#detailActions").replaceChildren();
    $$('[data-node]').forEach((element) => element.classList.remove("selected"));
    renderAnnotationList();
    reveal();
  }

  $("#threadAnnotationBadge").onclick = (event) => openAnnotationSubject(
    getState(), subjectAnchor("thread"), {
      title: getThread()?.title,
      kind: "THREAD",
      origin: event.currentTarget,
    },
  );
  $("#turnAnnotationBadge").onclick = (event) => openAnnotationSubject(
    getState(), subjectAnchor("turn"), {
      title: "Turn comments",
      kind: "TURN",
      origin: event.currentTarget,
    },
  );
  $("#annotationComposer").onsubmit = async (event) => {
    event.preventDefault();
    const comment = $("#annotationComment").value.trim();
    if (!comment || !annotationSubject || !annotationEnabled) return;
    const thread = getThread();
    if (String(thread?.id) !== String(annotationThreadId)) {
      annotationSubject = null;
      annotationThreadId = null;
      resetAnnotationComposer();
      $("#annotationPanel").classList.add("hidden");
      return;
    }
    const operationAnchor = structuredClone(annotationSubject.anchor);
    const operationEditing = editingAnnotation;
    const payload = {
      comment,
      rating: annotationRatingTouched ? Number(ratingInput.value) : null,
      navigationContext: annotationNavigationContext(selection, operationAnchor),
      evidenceRefs: [],
    };
    $("#submitAnnotation").disabled = true;
    $("#annotationError").classList.add("hidden");
    try {
      if (operationEditing) {
        await annotationApi.revise(thread.id, operationEditing.id, {
          ...payload,
          expectedRevision: operationEditing.latestRevision,
        });
      } else {
        await annotationApi.create(thread.id, { anchor: operationAnchor, ...payload });
      }
      annotationCache.delete(String(thread.id));
      await loadAnnotations(thread, { force: true });
      if (isCurrentAnnotationContext(thread.id, operationAnchor)) resetAnnotationComposer();
    } catch (error) {
      if (isCurrentAnnotationContext(thread.id, operationAnchor)) {
        $("#annotationError").textContent = error.message;
        $("#annotationError").classList.remove("hidden");
        $("#submitAnnotation").disabled = false;
      }
    }
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
    closeContextPopover();
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
  const contextForNode = (nodeId) => composerContexts.find((context) => (
    String(context.target.nodeId) === String(nodeId)
  ));
  const contextStagingDisabled = () => {
    const status = composerStatusForThread(getState(), getThread());
    return contextStagingDisabledFor(status, capabilities.canCompose, prompt.disabled);
  };
  const closeContextEditor = () => {
    contextEditor = null;
    renderComposerContexts();
  };
  const updateAttachContextControl = () => {
    const button = $("#attachNodeContext");
    const node = resolveInteractionContextNode(
      selection.selectedNodeId,
      getState().nodes,
      composerContexts,
      contextNodeOverrides,
    );
    const status = composerStatusForThread(getState(), getThread());
    const available = capabilities.canCompose
      && !composerDisabledForState(status, true)
      && !prompt.disabled
      && Boolean(node);
    button.classList.toggle("hidden", !available);
    button.disabled = !available;
  };
  const openContextEditor = (node, annotationIndex = null) => {
    if (!node || contextStagingDisabled() || contextEditor) return;
    const context = contextForNode(node.id);
    contextEditor = {
      nodeId: node.id,
      annotationIndex,
      value: annotationIndex == null ? "" : context?.annotations?.[annotationIndex] || "",
      attaching: !context,
    };
    renderComposerContexts();
    $("#contextAnnotationEditor")?.focus();
  };
  function renderComposerContexts() {
    const tray = $("#composerContextTray");
    const groups = composerContexts.map((context) => {
      const group = graphDocument.createElement("section");
      group.className = "composer-context-group";
      const heading = graphDocument.createElement("div");
      heading.className = "composer-context-heading";
      const nodeButton = graphDocument.createElement("button");
      nodeButton.type = "button";
      nodeButton.className = "composer-context-node";
      nodeButton.append(createRelayerIcon(context.node.icon || context.node.metadata?.relayer?.icon));
      const title = graphDocument.createElement("span");
      title.textContent = context.node.title;
      nodeButton.append(title);
      nodeButton.setAttribute("aria-label", `Open ${context.node.title} details`);
      nodeButton.onclick = () => selectNode(getState(), context.node.id);
      const add = graphDocument.createElement("button");
      add.type = "button";
      add.className = "context-symbol-button";
      add.textContent = "+";
      add.title = "Add annotation";
      add.setAttribute("aria-label", `Add annotation to ${context.node.title}`);
      add.onclick = () => openContextEditor(context.node);
      add.disabled = contextStagingDisabled() || Boolean(contextEditor);
      const detach = graphDocument.createElement("button");
      detach.type = "button";
      detach.className = "context-symbol-button";
      detach.textContent = "×";
      detach.title = "Detach node";
      detach.setAttribute("aria-label", `Detach ${context.node.title}`);
      detach.onclick = () => {
        if (contextStagingDisabled() || contextEditor) return;
        if (contextDetachNeedsConfirmation(context)
          && !graphWindow.confirm(`Detach ${context.node.title} and its annotations?`)) return;
        composerContexts = composerContexts.filter((candidate) => candidate !== context);
        if (String(contextEditor?.nodeId) === String(context.node.id)) contextEditor = null;
        renderComposerContexts();
      };
      detach.disabled = contextStagingDisabled() || Boolean(contextEditor);
      heading.append(nodeButton, add, detach);
      group.append(heading);
      if (context.annotations.length) {
        const list = graphDocument.createElement("ol");
        list.className = "composer-context-annotations";
        context.annotations.forEach((annotation, index) => {
          const item = graphDocument.createElement("li");
          const text = graphDocument.createElement("span");
          text.textContent = annotation;
          const edit = graphDocument.createElement("button");
          edit.type = "button";
          edit.className = "context-symbol-button";
          edit.textContent = "✎";
          edit.title = "Edit annotation";
          edit.setAttribute("aria-label", `Edit annotation ${index + 1} for ${context.node.title}`);
          edit.onclick = () => openContextEditor(context.node, index);
          edit.disabled = contextStagingDisabled() || Boolean(contextEditor);
          const remove = graphDocument.createElement("button");
          remove.type = "button";
          remove.className = "context-symbol-button";
          remove.textContent = "🗑";
          remove.title = "Delete annotation";
          remove.setAttribute("aria-label", `Delete annotation ${index + 1} for ${context.node.title}`);
          remove.onclick = () => {
            if (contextStagingDisabled() || contextEditor) return;
            composerContexts = removeContextAnnotation(composerContexts, context.node.id, index);
            if (String(contextEditor?.nodeId) === String(context.node.id)
              && contextEditor.annotationIndex === index) contextEditor = null;
            renderComposerContexts();
          };
          remove.disabled = contextStagingDisabled() || Boolean(contextEditor);
          item.append(text, edit, remove);
          list.append(item);
        });
        group.append(list);
      }
      return group;
    });
    if (contextEditor) {
      const node = resolveInteractionContextNode(
        contextEditor.nodeId,
        getState().nodes,
        composerContexts,
        contextNodeOverrides,
      );
      if (node) {
        const editorPresentation = contextEditorPresentation(
          contextEditor,
          contextStagingDisabled(),
        );
        const editor = graphDocument.createElement("section");
        editor.className = "composer-context-editor";
        const heading = graphDocument.createElement("div");
        heading.className = "composer-context-heading";
        heading.append(createRelayerIcon(node.icon || node.metadata?.relayer?.icon));
        const title = graphDocument.createElement("strong");
        title.textContent = node.title;
        heading.append(title);
        const textarea = graphDocument.createElement("textarea");
        textarea.id = "contextAnnotationEditor";
        textarea.rows = 2;
        textarea.placeholder = "Add a note (optional for a new node)…";
        textarea.setAttribute("aria-label", `Annotation for ${node.title}`);
        textarea.value = contextEditor.value;
        textarea.disabled = editorPresentation.textareaDisabled;
        textarea.oninput = () => {
          contextEditor.value = textarea.value;
          confirm.disabled = contextEditorPresentation(
            contextEditor,
            contextStagingDisabled(),
          ).confirmDisabled;
        };
        const controls = graphDocument.createElement("div");
        controls.className = "composer-context-editor-actions";
        const cancel = graphDocument.createElement("button");
        cancel.type = "button";
        cancel.textContent = "×";
        cancel.title = "Cancel";
        cancel.setAttribute("aria-label", "Cancel annotation edit");
        cancel.onclick = closeContextEditor;
        const confirm = graphDocument.createElement("button");
        confirm.type = "button";
        confirm.textContent = "✓";
        confirm.title = "Confirm";
        confirm.setAttribute("aria-label", "Confirm annotation");
        confirm.disabled = editorPresentation.confirmDisabled;
        confirm.onclick = () => {
          if (contextStagingDisabled()) return;
          const interaction = currentInteraction();
          const sourceTarget = String(selectedContextTarget?.nodeId) === String(node.id)
            ? selectedContextTarget
            : null;
          composerContexts = applyContextEditor(
            composerContexts,
            contextEditor,
            node,
            sourceTarget || {
              nodeId: node.id,
              sourceInteractionNodeId: interaction?.graphNodeId,
              sourceLayerId: currentLayerId(),
            },
          );
          closeContextEditor();
        };
        controls.append(cancel, confirm);
        editor.append(heading, textarea, controls);
        groups.push(editor);
      }
    }
    tray.replaceChildren(...groups);
    tray.classList.toggle("hidden", groups.length === 0);
    syncComposer();
  }
  const syncComposer = () => {
    resizeComposerTextarea(prompt);
    send.disabled = !composerSubmissionReady(
      prompt.value,
      prompt.disabled,
      modelPicker?.isReady() ?? false,
      composerContexts,
      Boolean(contextEditor),
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
    if (send.disabled) return;
    prompt.disabled = true;
    send.disabled = true;
    renderComposerContexts();
    updateAttachContextControl();
    try {
      const modelSelection = pickerSelectionPayload(modelPicker?.getSelection())?.modelSelection;
      await onSubmitInteraction(text, modelSelection, interactionContextPayload(composerContexts));
      prompt.value = "";
      ({ contexts: composerContexts, editor: contextEditor } = interactionContextDraftTransition(
        { contexts: composerContexts, editor: contextEditor },
        "durable_send",
      ));
      renderComposerContexts();
    } catch (error) {
      toast(error.message);
    } finally {
      prompt.disabled = composerDisabledForState(
        getState().status,
        capabilities.canCompose,
      );
      renderComposerContexts();
      updateAttachContextControl();
      syncComposer();
    }
  };
  $("#attachNodeContext").onclick = () => {
    const node = resolveInteractionContextNode(
      selection.selectedNodeId,
      getState().nodes,
      composerContexts,
      contextNodeOverrides,
    );
    openContextEditor(node);
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
      row.className = `turn-option${status && !status.hidden ? ` turn-status-${status.kind}` : ""}`;
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
      statusText.textContent = status?.label || "";
      let commentsText = null;
      if (annotationEnabled) {
        const count = annotationCount({ kind: "turn", interactionId: turn.id });
        if (count) {
          commentsText = graphDocument.createElement("span");
          commentsText.className = "turn-option-comments";
          commentsText.textContent = `${count} comment${count === 1 ? "" : "s"}`;
        }
      }
      row.append(sequence, promptText);
      if (statusText.textContent || commentsText) {
        const meta = graphDocument.createElement("span");
        meta.className = "turn-option-meta";
        if (statusText.textContent) meta.append(statusText);
        if (commentsText) meta.append(commentsText);
        row.append(meta);
      }
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

  function renderHistoricalContexts(state, interaction) {
    const contexts = interaction?.contexts || [];
    contextNodeOverrides.clear();
    const pill = $("#interactionContextPill");
    pill.classList.toggle("hidden", contexts.length === 0);
    $("#interactionContextCount").textContent = String(contexts.length);
    pill.setAttribute(
      "aria-label",
      `Show ${contexts.length} connected node${contexts.length === 1 ? "" : "s"}`,
    );
    if (!contexts.length) {
      closeContextPopover();
      $("#interactionContextPopover").replaceChildren();
      return;
    }
    const groups = contexts.map((context) => {
      const node = context.targetNode;
      contextNodeOverrides.set(String(node.id), node);
      const group = graphDocument.createElement("section");
      group.className = "interaction-context-group";
      const button = graphDocument.createElement("button");
      button.type = "button";
      button.className = "interaction-context-node";
      button.append(createRelayerIcon(node.icon || node.metadata?.relayer?.icon));
      const title = graphDocument.createElement("span");
      title.textContent = node.title;
      button.append(title);
      button.setAttribute("aria-label", `Open ${node.title} details`);
      button.onclick = () => {
        closeContextPopover();
        selectNode(state, node.id, { notify: false, contextTarget: context.target });
      };
      group.append(button);
      if (context.annotations?.length) {
        const list = graphDocument.createElement("ol");
        for (const annotation of context.annotations) {
          const item = graphDocument.createElement("li");
          item.textContent = annotation;
          list.append(item);
        }
        group.append(list);
      }
      return group;
    });
    $("#interactionContextPopover").replaceChildren(...groups);
    $("#interactionContextPopover").classList.toggle("hidden", !contextPopoverOpen);
  }

  function render() {
    const state = getState();
    const thread = getThread();
    if (!thread) {
      showEmpty();
      return;
    }
    const threadId = String(thread.id);
    if (renderedThreadId !== null && renderedThreadId !== threadId) {
      annotationSubject = null;
      annotationThreadId = null;
      resetAnnotationComposer();
      $("#annotationPanel").classList.add("hidden");
      cancelInspectorFit();
      $("#inspector").classList.add("hidden");
      selection.selectedNodeId = null;
      selectedContextTarget = null;
      ({ contexts: composerContexts, editor: contextEditor } = interactionContextDraftTransition(
        { contexts: composerContexts, editor: contextEditor },
        "thread_change",
      ));
    }
    renderedThreadId = threadId;
    if (annotationSubject?.anchor.kind !== "thread") {
      const interactionId = currentInteraction(state, thread)?.id;
      const layerId = currentLayerId(state, thread);
      const anchor = annotationSubject?.anchor;
      const anchorLayerId = anchor?.layerId ?? anchor?.presentationLayerId;
      const wrongTurn = anchor?.interactionId != null
        && String(anchor.interactionId) !== String(interactionId);
      const wrongLayer = !["turn", undefined].includes(anchor?.kind)
        && anchorLayerId != null
        && String(anchorLayerId) !== String(layerId);
      if (wrongTurn || wrongLayer) {
        annotationSubject = null;
        $("#annotationPanel").classList.add("hidden");
      }
    }
    applyMode();
    showThread();
    renderExportControl(thread);
    void loadAnnotations(thread);
    renderHistoryNavigation();
    $("#threadTitle").textContent = thread.title;
    const project = state.projects.find((item) => String(item.id) === String(thread.projectId));
    const permissionProfile = state.permissionProfiles?.find((item) => item.id === thread.permissionProfileId);
    const permissionLabel = permissionProfile?.label || thread.permissionProfileId;
    const harnessId = thread.harnessId ?? thread.harnessConfigurationName;
    const harness = state.modelSettings?.harnesses?.find((item) => item.id === harnessId);
    const threadScope = `${project?.name || "No folder"} · ${permissionLabel} · ${harness?.label ?? harnessId}`;
    $("#threadScope").textContent = threadScope;
    $("#threadTitle").title = threadScope;
    renderEnvironment(state.environment, project);
    const interaction = interactionForThread(state, thread);
    updateCountBadge($("#threadAnnotationBadge"), subjectAnchor("thread", {}, state, thread));
    updateCountBadge($("#turnAnnotationBadge"), subjectAnchor("turn", {}, state, thread));
    const interactionText = interaction?.text || "";
    $("#interactionText").textContent = interactionText;
    $("#interactionText").title = interactionText;
    renderTurnNavigation(state, thread, interaction);
    renderHistoricalContexts(state, interaction);
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
    renderInteractionState(state, interaction);
    renderApprovalDock(state, thread);
    renderGraph(state, thread);
    if (selection.selectedNodeId != null) {
      selectNode(state, selection.selectedNodeId, { notify: false });
    } else if (annotationSubject) {
      renderAnnotationList();
    } else if (!$("#inspector").classList.contains("hidden")) {
      cancelInspectorFit();
      $("#inspector").classList.add("hidden");
    }
    renderBreadcrumb(state, thread);
  }

  function renderBreadcrumb(state = getState(), thread = getThread()) {
    const breadcrumb = $("#workspaceBreadcrumb");
    const items = workspaceBreadcrumbItems(state, thread, selection);
    const visible = workspaceBreadcrumbShouldRender(items);
    const rootAnnotationOnly = workspaceRootAnnotationShouldRender(items, annotationEnabled);
    breadcrumb.classList.toggle("hidden", !visible && !rootAnnotationOnly);
    breadcrumb.classList.toggle("root-annotation-only", rootAnnotationOnly);
    if (!visible && !rootAnnotationOnly) {
      breadcrumb.replaceChildren();
      return;
    }
    const children = [];
    items.forEach((item, index) => {
      if (visible && index > 0) {
        const separator = graphDocument.createElement("span");
        separator.className = "breadcrumb-separator";
        separator.setAttribute("aria-hidden", "true");
        separator.textContent = "/";
        children.push(separator);
      }
      if (visible) {
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
      }
      if (annotationEnabled) {
        const anchor = {
          kind: "layer",
          interactionId: currentInteraction(state, thread)?.id,
          layerId: item.layerId,
        };
        const badge = graphDocument.createElement("button");
        badge.type = "button";
        badge.className = "annotation-count-badge breadcrumb-annotation-badge";
        updateCountBadge(badge, anchor);
        badge.onclick = async () => {
          badge.disabled = true;
          try {
            if (!item.current) {
              await onNavigateLayer(item.layerId, {
                restore: true,
                pathIndex: item.pathIndex,
              });
            }
            if (String(getThread()?.id) !== String(thread?.id)) return;
            openAnnotationSubject(getState(), anchor, {
              title: item.label,
              kind: "LAYER",
              origin: badge,
            });
          } catch (error) {
            toast(error.message);
          } finally {
            if (badge.isConnected) badge.disabled = false;
          }
        };
        children.push(badge);
      }
    });
    breadcrumb.replaceChildren(...children);
    breadcrumb.scrollLeft = breadcrumb.scrollWidth;
  }

  function renderInteractionState(state, interaction) {
    const viewedStatus = interaction?.completionStatus || state.status || "idle";
    const presentation = turnStatusPresentation(viewedStatus);
    const statusElement = $("#interactionStatus");
    const statusKey = interactionStatusRenderKey(interaction, state.status || "idle");
    if (statusKey !== renderedInteractionStatusKey) {
      statusElement.className = presentation.hidden
        ? "interaction-status hidden"
        : `interaction-status interaction-status-${presentation.kind}`;
      statusElement.textContent = presentation.label;
      renderedInteractionStatusKey = statusKey;
    }
    prompt.disabled = composerDisabledForState(
      composerStatusForThread(state, getThread()),
      capabilities.canCompose,
    );
    modelPicker?.setDisabled(prompt.disabled);
    renderComposerContexts();
    updateAttachContextControl();
    syncComposer();
  }

  function renderEnvironment(environment, project) {
    const presentation = environmentPresentation(environment, project);
    const body = $("#environmentBody");
    const loading = $("#environmentLoading");
    const facts = $("#environmentFacts");
    const message = $("#environmentMessage");
    body.setAttribute("aria-busy", String(presentation.busy));
    loading.classList.toggle("hidden", presentation.mode !== "loading");
    facts.classList.toggle("hidden", presentation.mode !== "facts");
    message.classList.toggle("hidden", presentation.mode === "loading" || presentation.mode === "facts");
    message.textContent = presentation.message || "";
    $("#environmentObserved").textContent = presentation.stale
      ? "Stale snapshot"
      : presentation.observedAt ? "Local snapshot" : "";
    $("#environmentObserved").classList.toggle("environment-stale", Boolean(presentation.stale));
    $("#environmentObserved").title = presentation.staleMessage || "";
    if (presentation.mode !== "facts") return;
    $("#environmentWorktree").textContent = presentation.worktreeLabel;
    $("#environmentWorktree").title = presentation.worktreeLabel;
    const git = presentation.kind === "git";
    $("#environmentBranchRow").classList.remove("hidden");
    $("#environmentChangesRow").classList.toggle("hidden", !git);
    $("#environmentUntrackedRow").classList.toggle("hidden", !git);
    $("#environmentBranchLabel").textContent = git
      ? "Branch"
      : presentation.kind === "folder" ? "Repository" : "Status";
    $("#environmentBranch").textContent = git ? presentation.branch : presentation.message;
    $("#environmentBranch").title = $("#environmentBranch").textContent;
    $("#environmentAdditions").textContent = `+${presentation.additions ?? 0}`;
    $("#environmentDeletions").textContent = `−${presentation.deletions ?? 0}`;
    const trackedLabel = trackedChangesLabel(presentation);
    $("#environmentTracked").classList.toggle("hidden", !trackedLabel);
    $("#environmentTracked").textContent = trackedLabel;
    $("#environmentUntracked").textContent = untrackedFilesLabel(presentation.untrackedFiles ?? 0);
    message.textContent = presentation.message || "";
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
      $("#threadComposerShell").classList.remove("hidden");
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
    $("#threadComposerShell").classList.add("hidden");
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
    const preserveHistoricalSelection = hasHistoricalContextSelection(
      selection.selectedNodeId,
      selectedContextTarget,
      contextNodeOverrides,
    );
    if (enteringView) {
      cancelInspectorFit();
      if (!preserveHistoricalSelection) $("#inspector").classList.add("hidden");
      saveGraphView();
    }
    $("#graphEmpty").classList.toggle("hidden", responseNodes.length > 0);
    $("#graphStage").classList.toggle("hidden", responseNodes.length === 0);
    if (!responseNodes.length) {
      graphViewKey = nextViewKey;
      graphNodes = [];
      graphEdges = [];
      graphSignature = "";
      if (graphRenderClearsSelection({
        hasResponseNodes: false,
        enteringView,
        nodeInGraph: false,
        preserveHistoricalSelection,
      })) {
        selection.selectedNodeId = null;
        if (!["thread", "turn"].includes(annotationSubject?.anchor.kind)) {
          annotationSubject = null;
          $("#inspector").classList.add("hidden");
        } else {
          renderAnnotationList();
        }
      }
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
    $("#nodeLayer").innerHTML = graphNodes.map((node) => {
      const count = annotationCount(subjectAnchor("node", { nodeId: node.id }, state, thread));
      const badge = annotationEnabled && count
        ? `<span class="graph-annotation-badge" aria-label="${count} comment${count === 1 ? "" : "s"}">${count}</span>`
        : "";
      const annotationLabel = count ? `. ${count} comment${count === 1 ? "" : "s"}` : "";
      return `<div class="graph-node ${String(node.id) === String(selection.selectedNodeId) ? "selected" : ""}" data-node="${escapeHtml(node.id)}" data-review-ref="node-${escapeHtml(node.id)}" data-review-kind="node" role="button" tabindex="0" aria-label="Open ${escapeHtml(node.title)}${annotationLabel}"><div class="glyph"></div>${badge}<div class="copy"><b>${escapeHtml(node.title)}</b></div></div>`;
    }).join("");
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
    if (graphRenderClearsSelection({
      hasResponseNodes: true,
      enteringView,
      nodeInGraph: ids.has(String(selection.selectedNodeId)),
      preserveHistoricalSelection,
    })) {
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
    const focusedEdgeId = graphDocument.activeElement
      ?.closest?.("[data-edge]")
      ?.dataset.edge ?? null;
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
      const edgeIdentity = edge.id ?? `${source}:${target}`;
      const edgeId = escapeHtml(edgeIdentity);
      const annotatable = annotationEnabled && edge.id != null;
      const anchor = annotatable ? subjectAnchor("edge", { edgeId: edge.id }) : null;
      const count = anchor ? annotationCount(anchor) : 0;
      const middleX = (segment.x1 + segment.x2) / 2;
      const middleY = (segment.y1 + segment.y2) / 2;
      return `<g class="graph-edge-group" data-edge="${edgeId}"><line class="graph-edge" aria-hidden="true" style="stroke-width:${graphEdgeStrokeWidth(camera.zoom)}" x1="${segment.x1}" y1="${segment.y1}" x2="${segment.x2}" y2="${segment.y2}"/><line class="graph-edge-hit ${annotatable ? "" : "hidden"}" tabindex="0" role="button" aria-label="Open relationship comments" x1="${segment.x1}" y1="${segment.y1}" x2="${segment.x2}" y2="${segment.y2}"/>${annotatable && count ? `<g class="edge-annotation-badge" aria-hidden="true" transform="translate(${middleX} ${middleY})"><circle r="9"></circle><text y="3">${count}</text></g>` : ""}</g>`;
    }).join("");
    if (annotationEnabled) {
      $$("[data-edge]").forEach((group) => {
        const edge = graphEdges.find((candidate) => String(candidate.id ?? `${candidate.endpoints?.[0] ?? candidate.source}:${candidate.endpoints?.[1] ?? candidate.target}`) === group.dataset.edge);
        if (!edge || edge.id == null) return;
        const anchor = subjectAnchor("edge", { edgeId: edge.id });
        const open = (event) => {
          event.preventDefault();
          event.stopPropagation();
          openAnnotationSubject(getState(), anchor, {
            title: "Relationship",
            kind: "EDGE",
            origin: event.currentTarget,
          });
        };
        const hit = group.querySelector(".graph-edge-hit");
        hit.onclick = open;
        group.onpointerdown = (event) => event.stopPropagation();
        hit.onkeydown = (event) => {
          if (event.key === "Enter" || event.key === " ") open(event);
        };
        group.querySelector(".edge-annotation-badge")?.addEventListener("click", open);
      });
      if (focusedEdgeId !== null) {
        $$('[data-edge]').find((group) => group.dataset.edge === focusedEdgeId)
          ?.querySelector(".graph-edge-hit")
          ?.focus({ preventScroll: true });
      }
    }
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

  function selectNode(state, id, { notify = true, contextTarget } = {}) {
    selection.selectedNodeId = id;
    if (contextTarget !== undefined || notify) selectedContextTarget = contextTarget || null;
    const node = resolveInteractionContextNode(
      id,
      state.nodes,
      composerContexts,
      contextNodeOverrides,
    );
    if (!node) return;
    const nodeAnchor = annotationEnabled
      ? subjectAnchor("node", { nodeId: node.id }, state, getThread())
      : null;
    const subjectChanged = annotationEnabled && annotationSubjectContextChanged(
      annotationThreadId,
      annotationSubject?.anchor,
      getThread()?.id,
      nodeAnchor,
    );
    if (subjectChanged) resetAnnotationComposer();
    annotationThreadId = annotationEnabled ? getThread()?.id : null;
    annotationSubject = annotationEnabled ? {
      anchor: nodeAnchor,
      title: node.title,
      kind: "NODE",
    } : null;
    if (notify) onSelectionChange(node.id);
    const { reveal } = openInspector({ userInitiated: notify });
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
      const wrapper = graphDocument.createElement("span");
      wrapper.className = "action-annotation-wrap";
      wrapper.append(button);
      if (annotationEnabled) {
        const anchor = subjectAnchor("action", {
          actionId: action.id,
          nodeId: node.id,
          sourceLayerId: action.sourceLayerId,
        }, state, getThread());
        const count = annotationCount(anchor);
        const badge = graphDocument.createElement("button");
        badge.type = "button";
        badge.className = "annotation-count-badge action-annotation-badge";
        badge.textContent = count ? String(count) : "✎";
        badge.setAttribute("aria-label", count
          ? `Open ${count} action comment${count === 1 ? "" : "s"}`
          : "Add action comment");
        badge.onclick = (event) => {
          event.stopPropagation();
          openAnnotationSubject(state, anchor, {
            title: presentation.label,
            kind: "ACTION",
            origin: event.currentTarget,
          });
        };
        wrapper.append(badge);
      }
      return wrapper;
    }));
    [...$("#detailActions").querySelectorAll(".action-control")].forEach((button, index) => {
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
    renderAnnotationList();
    renderBreadcrumb(state, getThread());
    updateAttachContextControl();
    reveal();
  }

  function dispose() {
    modelPicker?.dispose();
    cancelInspectorFit();
    graphDocument.removeEventListener("pointerdown", blurGraphFromOutsidePointer, true);
    graphDocument.removeEventListener("pointerdown", closeTurnPopoverFromOutside, true);
    graphDocument.removeEventListener("pointerdown", closeSettingsMenuFromOutside, true);
    graphDocument.removeEventListener("keydown", closeTurnPopoverOnEscape, true);
    graphDocument.removeEventListener("keydown", closeSettingsMenuOnEscape, true);
    graphDocument.removeEventListener("keydown", closeInspectorOnEscape, true);
    graphDocument.removeEventListener("pointerdown", closeContextPopoverFromOutside, true);
    graphDocument.removeEventListener("keydown", closeContextPopoverOnEscape, true);
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
    contextNodeOverrides.clear();
    selectedContextTarget = null;
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
