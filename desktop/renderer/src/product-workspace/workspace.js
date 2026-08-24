import { escapeHtml, toast } from "../ui.js";
import { actionWasInvoked } from "../action-invocation-state.js";
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
import { createGraphSimulationController } from "./graph-simulation.js";
import { renderMarkdown } from "./markdown.js";
import { productWorkspaceMarkup } from "./view.js";

function hash(value) {
  let result = 0;
  for (const character of String(value)) {
    result = ((result << 5) - result + character.charCodeAt(0)) | 0;
  }
  return Math.abs(result);
}

export const GRAPH_NODE_ICON_RADIUS = 24;
export const GRAPH_MIN_ZOOM = 0.4;
export const GRAPH_MAX_ZOOM = 2;
export const COMPOSER_MIN_HEIGHT = 42;
export const COMPOSER_MAX_HEIGHT = 126;

const GRAPH_NODE_HALF_WIDTH = 82;
const GRAPH_NODE_TOP = 28;
const GRAPH_NODE_BOTTOM = 72;
const GRAPH_FIT_PADDING = 48;
const PENDING_COMPLETION_STATUSES = new Set(["not_started", "running", "submitted"]);

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

export function shouldAutoFitSettledGraph(
  autoFitViewKey,
  currentViewKey,
  autoFitRevision,
  currentRevision,
) {
  return autoFitViewKey === currentViewKey && autoFitRevision === currentRevision;
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
  if (["not_started", "running", "submitted"].includes(status)) {
    return { kind: "running", label: status === "not_started" ? "Waiting" : "Running" };
  }
  if (status === "accepted") return { kind: "accepted", label: "Complete" };
  if (status === "failed") return { kind: "failed", label: "Failed" };
  if (status === "cancelled") return { kind: "cancelled", label: "Cancelled" };
  if (status === "stopped") return { kind: "stopped", label: "Stopped" };
  return { kind: "unknown", label: status ? String(status).replaceAll("_", " ") : "Unknown" };
}

export function runStatePresentation(status, { imported = false } = {}) {
  const pending = PENDING_COMPLETION_STATUSES.has(status);
  if (imported && pending) return { pending: false, display: "Unfinished snapshot" };
  return {
    pending,
    display: status === "accepted" ? "Complete"
      : pending ? "…"
        : status === "idle" ? "Ready"
          : status[0].toUpperCase() + status.slice(1),
  };
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

export function captureGraphViewState(
  nodes,
  camera,
  signature,
  settled,
  cameraRevision,
) {
  return {
    camera: { ...camera },
    cameraRevision,
    nodes: nodes.map((node) => ({
      id: node.id,
      x: node.x,
      y: node.y,
      vx: node.vx,
      vy: node.vy,
      pinned: node.pinned,
    })),
    settled,
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
  onInvokeAction = async () => {},
}) {
  const capabilities = workspaceModeCapabilities(mode);
  const graphSimulation = createGraphSimulationController();
  let graphNodes = [];
  let graphEdges = [];
  let graphSignature = "";
  let graphViewKey = "";
  let graphLayoutSettled = false;
  let dragging = null;
  let panning = null;
  let pinching = null;
  let camera = { x: 0, y: 0, zoom: 1 };
  let cameraRevision = 0;
  let turnPopoverOpen = false;
  let exportPending = false;
  const graphViewCache = new Map();
  const activeTouchPointers = new Map();

  const $ = (selector) => root.querySelector(selector);
  const $$ = (selector) => [...root.querySelectorAll(selector)];

  const threadView = $("#threadView");
  if (!threadView) throw new Error("Product workspace requires a #threadView host.");
  threadView.innerHTML = productWorkspaceMarkup();
  const exportButton = $("#exportConversation");
  const renderExportControl = (thread = getThread()) => {
    const available = capabilities.canExportConversation
      && typeof onExportConversation === "function";
    exportButton.classList.toggle("hidden", !available);
    exportButton.disabled = !available || exportPending || thread?.id == null;
    exportButton.setAttribute("aria-busy", String(exportPending));
    exportButton.textContent = exportPending ? "Exporting…" : "Export conversation…";
  };
  exportButton.onclick = async () => {
    const thread = getThread();
    if (
      !capabilities.canExportConversation
      || exportPending
      || thread?.id == null
      || typeof onExportConversation !== "function"
    ) return;
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
  $("#closeInspector").onclick = () => {
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
  const graphStage = $("#graphStage");
  const graphDocument = graphStage.ownerDocument;
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
    if (manual) cameraRevision += 1;
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
    renderRunState(state, thread);
    renderGraph(state, thread);
    if (selection.selectedNodeId != null) {
      selectNode(state, selection.selectedNodeId, { notify: false });
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

  function renderRunState(state, thread) {
    const status = state.status || "idle";
    const { pending, display } = runStatePresentation(status, { imported: thread?.imported === true });
    const runState = $("#runState");
    runState.className = `run-state ${pending ? "running" : ["failed", "cancelled"].includes(status) ? "failed" : ""}`;
    runState.setAttribute("aria-label", pending ? "Waiting for graph" : display);
    runState.querySelector("span").textContent = display;
    prompt.disabled = composerDisabledForState(status, capabilities.canCompose);
    modelPicker?.setDisabled(prompt.disabled);
    syncComposer();
  }

  function renderGraph(state, thread) {
    const responseNodes = responseNodesForThread(state, thread);
    const nextViewKey = graphCameraViewKey(state, thread, responseNodes);
    const enteringView = nextViewKey !== graphViewKey;
    if (enteringView) {
      saveGraphView();
      graphSimulation.cancel();
    }
    $("#graphEmpty").classList.toggle("hidden", responseNodes.length > 0);
    $("#graphStage").classList.toggle("hidden", responseNodes.length === 0);
    if (!responseNodes.length) {
      graphViewKey = nextViewKey;
      graphNodes = [];
      graphEdges = [];
      graphSignature = "";
      graphLayoutSettled = false;
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

    const bounds = $("#graphStage").getBoundingClientRect();
    const cachedView = enteringView ? graphViewCache.get(nextViewKey) : null;
    const previous = new Map(
      (cachedView?.nodes ?? (!enteringView ? graphNodes : []))
        .map((node) => [node.id, node]),
    );
    graphViewKey = nextViewKey;
    graphNodes = responseNodes.map((node, index) => {
      const prior = previous.get(node.id);
      return prior ? {
        ...node,
        x: prior.x,
        y: prior.y,
        vx: prior.vx,
        vy: prior.vy,
        pinned: prior.pinned,
        index,
      } : {
        ...node,
        x: Math.max(120, bounds.width / 2 + ((hash(node.id) % 300) - 150)),
        y: Math.max(90, bounds.height / 2 + ((hash(`${node.id}-y`) % 220) - 110)),
        vx: 0,
        vy: 0,
        pinned: false,
        index,
      };
    });
    const ids = graphNodeIdentitySet(graphNodes);
    graphEdges = (state.edges || []).filter((edge) => {
      const [source, target] = edge.endpoints || [edge.source, edge.target];
      return ids.has(String(source)) && ids.has(String(target));
    });
    const nextSignature = JSON.stringify({
      viewKey: graphViewKey,
      nodes: graphNodes.map((node) => node.id),
      edges: graphEdges.map((edge) => edge.endpoints || [edge.source, edge.target]),
    });
    const topologyChanged = cachedView
      ? cachedView.signature !== nextSignature || !cachedView.settled
      : nextSignature !== graphSignature;
    graphSignature = nextSignature;
    $("#nodeLayer").innerHTML = graphNodes.map((node) => `<div class="graph-node ${String(node.id) === String(selection.selectedNodeId) ? "selected" : ""}" data-node="${escapeHtml(node.id)}" data-review-ref="node-${escapeHtml(node.id)}" data-review-kind="node" role="button" tabindex="0" aria-label="Open ${escapeHtml(node.title)}"><div class="glyph"></div><div class="copy"><b>${escapeHtml(node.title)}</b></div></div>`).join("");
    $$('[data-node]').forEach((element) => {
      const authoredNode = graphNodes.find((candidate) => String(candidate.id) === element.dataset.node);
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
      element.onclick = () => selectNode(state, element.dataset.node);
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
        dragging.node.vx = 0;
        dragging.node.vy = 0;
        if (dragging.moved) dragging.node.pinned = true;
        drawGraph();
      };
      const finishDrag = () => { dragging = null; };
      element.onpointerup = finishDrag;
      element.onpointercancel = finishDrag;
    });
    if (enteringView && !ids.has(String(selection.selectedNodeId))) {
      selection.selectedNodeId = null;
      $("#inspector").classList.add("hidden");
    }
    if (cachedView) {
      camera = { ...cachedView.camera };
      cameraRevision = cachedView.cameraRevision;
      graphLayoutSettled = cachedView.settled;
    } else if (enteringView) {
      camera = { x: 0, y: 0, zoom: 1 };
      graphLayoutSettled = false;
    }
    if (!topologyChanged) {
      drawGraph();
      return;
    }
    graphLayoutSettled = false;
    const autoFitRevision = cameraRevision;
    const autoFitViewKey = enteringView ? graphViewKey : null;
    let ticks = 0;
    graphSimulation.start(() => {
      physicsStep(bounds);
      drawGraph();
      if (++ticks < 220) {
        return true;
      }
      graphLayoutSettled = true;
      if (shouldAutoFitSettledGraph(
        autoFitViewKey,
        graphViewKey,
        autoFitRevision,
        cameraRevision,
      )) {
        updateCamera(fitGraphCamera(graphNodes, bounds), false);
      } else {
        saveGraphView();
      }
      return false;
    });
  }

  function physicsStep(bounds) {
    const centerX = bounds.width / 2;
    const centerY = bounds.height / 2;
    const anchored = (node) => node.pinned || dragging?.node.id === node.id;
    for (let i = 0; i < graphNodes.length; i++) {
      for (let j = i + 1; j < graphNodes.length; j++) {
        const a = graphNodes[i];
        const b = graphNodes[j];
        const dx = b.x - a.x || 0.1;
        const dy = b.y - a.y || 0.1;
        const distance2 = Math.max(400, dx * dx + dy * dy);
        const force = 950 / distance2;
        if (!anchored(a)) {
          a.vx -= dx * force;
          a.vy -= dy * force;
        }
        if (!anchored(b)) {
          b.vx += dx * force;
          b.vy += dy * force;
        }
      }
    }
    for (const edge of graphEdges) {
      const [source, target] = edge.endpoints || [edge.source, edge.target];
      const a = graphNodes.find((node) => node.id === source);
      const b = graphNodes.find((node) => node.id === target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy) || 1;
      const force = (distance - 150) * 0.002;
      if (!anchored(a)) {
        a.vx += dx * force;
        a.vy += dy * force;
      }
      if (!anchored(b)) {
        b.vx -= dx * force;
        b.vy -= dy * force;
      }
    }
    for (const node of graphNodes) {
      if (anchored(node)) {
        node.vx = 0;
        node.vy = 0;
        continue;
      }
      node.vx = (node.vx + (centerX - node.x) * 0.0014) * 0.88;
      node.vy = (node.vy + (centerY - node.y) * 0.0014) * 0.88;
      node.x += node.vx;
      node.y += node.vy;
    }
  }

  function drawGraph() {
    for (const node of graphNodes) {
      const element = $$('[data-node]').find((item) => item.dataset.node === String(node.id));
      if (element) {
        const point = graphScreenPoint(node, camera);
        element.style.left = `${point.x}px`;
        element.style.top = `${point.y}px`;
        element.style.setProperty("--graph-zoom", camera.zoom);
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
      graphLayoutSettled,
      cameraRevision,
    ));
  }

  function selectNode(state, id, { notify = true } = {}) {
    selection.selectedNodeId = id;
    const node = state.nodes.find((item) => String(item.id) === String(id));
    if (!node) return;
    if (notify) onSelectionChange(node.id);
    $("#inspector").classList.remove("hidden");
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
      button.dataset.reviewKind = action.kind === "navigate" ? "navigate-action" : "invoke-action";
      button.dataset.reviewActionId = String(action.id);
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
      const navigational = action?.kind === "navigate" && action.targetLayerId;
      const invoked = actionWasInvoked(
        state.actionInvocations,
        state.pendingActionInvocations,
        state.currentInteractionId,
        action.id,
      );
      button.disabled = invoked || (!navigational && !capabilities.canInvokeMutatingActions);
      button.classList.toggle("invoked", invoked);
      button.onclick = async () => {
        if (navigational) {
          button.disabled = true;
          try {
            await onNavigateLayer(action.targetLayerId, { action, sourceNode: node });
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
    graphSimulation.cancel();
    graphDocument.removeEventListener("pointerdown", blurGraphFromOutsidePointer, true);
    graphDocument.removeEventListener("pointerdown", closeTurnPopoverFromOutside, true);
    graphDocument.removeEventListener("keydown", closeTurnPopoverOnEscape, true);
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
