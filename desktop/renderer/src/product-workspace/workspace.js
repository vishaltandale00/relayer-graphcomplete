import { environmentProjectForThread } from "../environment-context.js";
import { interactionGraph, renderInteractionGraph } from "./interaction-graph.js";
import { createWorkspaceLayout } from "./workspace-layout.js";
import { preferredLayerNode, rememberedLayerSelection, rememberLayerSelection } from "./layer-selection.js";
import { escapeHtml, toast } from "../ui.js";
import { artifactNoteLabel } from "../artifact-viewer.js";
import { isDurableActionInvocation, isRejectedActionPreparation, recoverableActionInvocation, actionCanRetry, actionWasInvoked, actionReviewKind, singleCallResultDestination } from "../action-invocation-state.js";
import { setControlActivationCompletion } from "../control-activation.js";
import {
  composerSendTitle,
  createModelPicker,
  selectionForNextInteraction,
} from "../model-picker.js";
import { pickerSelectionPayload } from "../model-picker-model.js";
import {
  interactionForThread,
  responseNodesForThread,
  workspaceBreadcrumbItems,
  workspaceModeCapabilities,
  humanTurns,
  workspaceTurns,
  nativeInvocationCurrentPresentation,
} from "./model.js";
import { createLucideIcon, createRelayerIcon as createSymbolIcon, relayerIconFamily, renderThreadTitle } from "./icons.js";
import { createImageIcon, imageIconReference } from "./image-icons.js";
import { interactionActivity, NODE_RUN_STATE, nodeRunState, THREAD_ACTIVITY } from "./run-state.js";
import { graphLayoutSignature, nodesInReadingOrder, projectLayerNodePositions } from "./graph-layout.js";
import { graphEdgePath, graphFollowWaypoints, graphLayerCircle, graphRoutedEdgePath, resolveEdgeShape } from "./edge-shapes.js";
import { renderMarkdown } from "./markdown.js";
import { isResolvedInvokeAction, mountCompiledNodeDetail } from "./node-detail-runtime.js";
import { productWorkspaceMarkup } from "./view.js";
import { createSharePublishController } from "../share-publish-ui.js";
import { boundInputAttachment, connectedInvokeInputs, invokeInputGroups, invokeInputIssue } from "./invoke-inputs.js";
import {
  confirmationRestorationKey,
  restoredDraftForInteraction,
} from "../interaction-failure-model.js";
import { createNodeContextDraftController } from "../node-context-drafts.js";
import { createLiveAnswerController } from "../live-answers.js";
import {
  captureTextControlState,
  committedInputAttachment,
  createInputOccurrence,
  createNodeInputDraftController,
  createNodeInputDraftLoadQueue,
  createInputDraftLoadRetryScheduler,
  createInputMutationTracker,
  initialInputStageValue,
  inputActionReviewRef,
  inputKeyBelongsToThread,
  inspectedInputDraftRevision,
  inputOccurrenceKey,
  inputStageValuesEqual,
  restoreTextControlState,
  summarizeInputStage,
  threadHasPendingInputMutation,
  threadInputOccurrenceKey,
  validateInputStage,
} from "../node-input-controls.js";
import {
  captureComposerSubmission,
  settleComposerSubmission,
} from "./composer-submission.js";
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
  shouldRevealApprovalHistory,
  pendingApprovalsForThread,
  resolvedApprovalHistoryForThread,
  selectedPendingApproval,
} from "../approval-model.js";
import {
  clearThreadFollowupDraft,
  followupTextDigest,
  persistSentThreadFollowup,
  persistThreadFollowupDraft,
  sentThreadFollowup,
  threadFollowupDraft,
  threadFollowupRestoration,
} from "../composer-drafts.js";

export const GRAPH_MIN_ZOOM = 0.4;
export const GRAPH_MAX_ZOOM = 2;
export const COMPOSER_MIN_HEIGHT = 42;
export const COMPOSER_MAX_HEIGHT = 126;

function appendCompatibilityNodeDetail(container, node) {
  const compatibility = container.ownerDocument.createElement("div");
  compatibility.className = "node-detail-compatibility-content";
  renderMarkdown(compatibility, node?.detail || node?.summary || node?.content || "No details supplied.");
  container.append(compatibility);
}

export async function renderProductNodeDetail({
  container,
  node,
  mountKey,
  existing,
  compatibilityIssue,
  resolveAsset,
  resolveAction,
  onNavigate,
  onInvoke,
  onInput,
  onInputEdit,
  capabilityState,
}) {
  if (!node?.authoredDetail) {
    existing?.dispose?.();
    container.replaceChildren();
    renderMarkdown(container, node?.detail || node?.summary || node?.content || "No details supplied.");
    return Object.freeze({ authored: false, status: "legacy" });
  }
  if (compatibilityIssue) {
    existing?.dispose?.();
    container.replaceChildren();
    const fallback = container.ownerDocument.createElement("p");
    fallback.className = "node-detail-runtime-fallback";
    fallback.setAttribute("role", "status");
    fallback.textContent = compatibilityIssue;
    container.append(fallback);
    appendCompatibilityNodeDetail(container, node);
    return Object.freeze({ authored: false, status: "fallback", error: compatibilityIssue });
  }
  const adapters = { resolveAction, onNavigate, onInvoke, onInput, onInputEdit };
  if (existing?.authored === true
    && existing.status === "mounted"
    && existing.mountKey === mountKey
    && existing.host?.isConnected) {
    await existing.updateAdapters(adapters);
    for (const [id, state] of Object.entries(capabilityState ?? {})) {
      existing.updateCapability(id, state);
    }
    return existing;
  }
  existing?.dispose?.();
  container.replaceChildren();
  const host = container.ownerDocument.createElement("div");
  host.className = "node-detail-runtime-host";
  host.dataset.nodeDetailRuntime = "";
  host.setAttribute("aria-label", `${node.title || "Selected node"} authored detail`);
  container.append(host);
  const runtime = await mountCompiledNodeDetail({
    host,
    detail: node.authoredDetail,
    resolveAsset,
    resolveAction,
    onNavigate,
    onInvoke,
    onInput,
    onInputEdit,
    capabilityState,
  });
  if (runtime.status !== "mounted") {
    appendCompatibilityNodeDetail(container, node);
    return Object.freeze({ authored: false, mountKey, host, ...runtime });
  }
  return Object.freeze({ authored: true, mountKey, host, ...runtime });
}

export function observeAutomaticGraphFitOnResize({
  graphStage,
  graphWindow,
  getCameraRevision,
  getGraphNodes,
  hasActiveGesture,
  refit,
}) {
  const Observer = graphWindow?.ResizeObserver;
  if (!Observer) return { flush: () => {}, dispose: () => {} };
  const initialRect = graphStage.getBoundingClientRect();
  let previousSize = { width: initialRect.width, height: initialRect.height };
  let pending = false;
  let disposed = false;
  const flush = () => {
    if (disposed || !pending || hasActiveGesture()) return;
    pending = false;
    if (getGraphNodes().length > 0 && getCameraRevision() === 0) refit();
  };
  const observer = new Observer(() => {
    if (disposed) return;
    const { width, height } = graphStage.getBoundingClientRect();
    const changed = Math.abs(width - previousSize.width) > 0.5 || Math.abs(height - previousSize.height) > 0.5;
    previousSize = { width, height };
    pending ||= changed;
    flush();
  });
  observer.observe(graphStage);
  return { flush, dispose: () => { disposed = true; pending = false; observer.disconnect(); } };
}

const GRAPH_NODE_HALF_WIDTH = 82;
// Sticker pills are anchored at their centre; 18 is half the 36px pill.
const GRAPH_NODE_HALF_HEIGHT = 18;
// A state caption sits 6px below the pill and is 16px tall.
const GRAPH_NODE_CAPTION_HEIGHT = 22;
const GRAPH_FIT_PADDING = 48;
// Sticker pills stay readable without looking oversized when a layer has few nodes (H geometry fitCap).
const GRAPH_FIT_MAX_ZOOM = 1.25;
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

export function historicalContextSelectionOptions(contextTarget, origin) {
  return {
    notify: false,
    userInitiated: true,
    focusInspector: true,
    contextTarget,
    origin,
  };
}

export function turnReviewKind(current) {
  return current ? "control" : "turn";
}

export function focusedTurnIdForRerender(popoverOpen, activeElement) {
  if (!popoverOpen) return null;
  return activeElement?.closest?.("[data-turn-id]")?.dataset?.turnId ?? null;
}

export function approvalHistoryRenderIdentity(workspaceMode, threadId, dockMode) {
  return JSON.stringify([String(workspaceMode), String(threadId), String(dockMode)]);
}

export function approvalHistoryReceiptIdentity(history) {
  return JSON.stringify((history || []).map((receipt) => [
    String(receipt?.request?.requestId ?? ""),
    String(receipt?.resolution?.resolvedAt ?? ""),
    String(receipt?.resolution?.outcome ?? ""),
    String(receipt?.resolution?.decision ?? ""),
  ]));
}

export function approvalHistoryRenderTransition({
  previousIdentity,
  identity,
  previousReceiptIdentity,
  receiptIdentity,
  dockMode,
  wasHidden,
  wasHistoryOnly,
  open,
  scrollTop,
}) {
  const identityChanged = previousIdentity !== identity;
  const revealHistory = shouldRevealApprovalHistory({
    dockMode,
    wasHidden,
    wasHistoryOnly,
    threadChanged: identityChanged,
  });
  return {
    open: identityChanged ? dockMode === "history" : revealHistory ? true : open,
    scrollTop: identityChanged
      || previousReceiptIdentity !== receiptIdentity
      || revealHistory ? 0 : scrollTop,
  };
}

export function graphNodeLayoutBounds(width, height, caption = 0) {
  return {
    halfWidth: Math.max(GRAPH_NODE_HALF_WIDTH, width / 2),
    top: Math.max(GRAPH_NODE_HALF_HEIGHT, height / 2),
    bottom: Math.max(GRAPH_NODE_HALF_HEIGHT, height / 2) + caption,
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
    GRAPH_FIT_MAX_ZOOM,
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

export { graphEdgeSegment, graphPillExit } from "./edge-shapes.js";

export function graphEdgeStrokeWidth(zoom) {
  return 1.5 * zoom;
}

export function graphTurnNavigationDelta(event, graphFocused) {
  if (!graphFocused || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (event.key === "ArrowLeft") return -1;
  if (event.key === "ArrowRight") return 1;
  return null;
}

export { humanTurns, workspaceTurns } from "./model.js";

export function productStopTarget(state, thread) {
  return humanTurns(state, thread).findLast((turn) => ["submitted", "running", "waiting_for_approval"].includes(turn.completionStatus)) || null;
}

export function turnStatusPresentation(status) {
  if (status === "stopping") return { kind: "running", label: "Stopping…" };
  if (status === "waiting_for_approval") {
    return { kind: "approval", label: "Needs approval" };
  }
  if (["not_started", "running", "submitted"].includes(status)) {
    return { kind: "running", label: status === "not_started" ? "Waiting" : "Running" };
  }
  if (["accepted", "succeeded"].includes(status)) {
    return { kind: "accepted", label: "", hidden: true };
  }
  if (status === "failed") return { kind: "failed", label: "Failed" };
  if (status === "cancelled") return { kind: "cancelled", label: "Cancelled" };
  if (status === "stopped") return { kind: "stopped", label: "Stopped" };
  return { kind: "unknown", label: status ? String(status).replaceAll("_", " ") : "Unknown" };
}

export function environmentPresentation(environment, project, selectedThreadId = null) {
  if (!project?.id) {
    return { mode: "message", message: "No project folder", busy: false };
  }
  if (!environment || String(environment.projectId) !== String(project.id)
    || (selectedThreadId != null && String(environment.threadId) !== String(selectedThreadId))) {
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

const TERMINAL_TEMPORAL_LIFECYCLES = ["succeeded", "stopped", "failed"];

/** Product Stop waits for native settlement; otherwise terminal graph state can lead product projection. */
export function viewedInteractionStatus(interaction, fallbackStatus = "idle", temporalLifecycle = null) {
  if (interaction?.stopRequested) {
    return PENDING_COMPLETION_STATUSES.has(interaction.completionStatus) && !interaction.stopError
      ? "stopping"
      : interaction.completionStatus || fallbackStatus;
  }
  return TERMINAL_TEMPORAL_LIFECYCLES.includes(temporalLifecycle)
    ? temporalLifecycle
    : interaction?.completionStatus || fallbackStatus;
}

/** Changes whenever the shown status would, including a graph lifecycle ahead of the product status. */
export function interactionStatusRenderKey(interaction, fallbackStatus = "idle", temporalLifecycle = null) {
  const key = `${interaction?.id ?? "none"}:${interaction?.completionStatus || fallbackStatus}`;
  if (interaction?.stopRequested) return `${key}:${viewedInteractionStatus(interaction, fallbackStatus, temporalLifecycle)}`;
  return TERMINAL_TEMPORAL_LIFECYCLES.includes(temporalLifecycle) ? `${key}:${temporalLifecycle}` : key;
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

export function contextDraftSendWarningPresentation(drafts = []) {
  const count = drafts.length;
  return Object.freeze({
    count,
    countLabel: `${count} unconfirmed ${count === 1 ? "draft" : "drafts"}`,
    items: Object.freeze(drafts.map((draft) => Object.freeze({
      id: String(draft.id),
      title: String(draft.targetNode?.title || "Untitled node"),
    }))),
  });
}

export function sendIntentIsCurrentThread(currentThreadId, attemptedThreadId) {
  return String(currentThreadId) === String(attemptedThreadId);
}

export async function continueDraftOverrideAfterPersistence({
  controller,
  threadId,
  attempt,
  readCurrentThreadId,
  readCurrentAttempt,
  continueSend,
}) {
  await controller.persistAll(threadId);
  if (!sendIntentIsCurrentThread(readCurrentThreadId(), threadId)
    || readCurrentAttempt() !== attempt) return false;
  await continueSend();
  return true;
}

export function sendAttemptBlocksThread(pendingThreadId, currentThreadId) {
  return pendingThreadId != null && String(pendingThreadId) === String(currentThreadId);
}

export function threadHasInFlightSend(inFlightThreadIds, threadId) {
  return inFlightThreadIds.has(String(threadId));
}

export function releaseInFlightSend(inFlightSends, attempt) {
  if (!attempt || inFlightSends.get(String(attempt.threadId)) !== attempt) return false;
  inFlightSends.delete(String(attempt.threadId));
  return true;
}

export function confirmationSendReplayIntent({
  intent,
  threadId,
  draftScopeKey,
  promptRevision,
  contextRevision,
  replayContextRevision,
  modelSelection,
  inputDraftRevision = null,
  inputCompositionRevision = 0,
}) {
  if (!intent?.contextConfirmationIds?.length && intent?.inputDraftRevision == null) return null;
  if (!sendIntentIsCurrentThread(threadId, intent.threadId)) return null;
  if (intent.draftScopeKey !== draftScopeKey) return null;
  if (!Object.is(intent.submission.prompt.revision, promptRevision)) return null;
  if (!Object.is(replayContextRevision, contextRevision)) return null;
  if (!Object.is(intent.inputDraftRevision ?? null, inputDraftRevision)) return null;
  if (!Object.is(intent.inputCompositionRevision ?? 0, inputCompositionRevision)) return null;
  return JSON.stringify(intent.modelSelection ?? null) === JSON.stringify(modelSelection ?? null)
    ? intent
    : null;
}

export function confirmationSendReplayIntentWithoutInputAuthority({
  intent,
  threadId,
  draftScopeKey,
  promptRevision,
  contextRevision,
  replayContextRevision,
  modelSelection,
}) {
  return confirmationSendReplayIntent({
    intent,
    threadId,
    draftScopeKey,
    promptRevision,
    contextRevision,
    replayContextRevision,
    modelSelection,
    inputDraftRevision: intent?.inputDraftRevision,
    inputCompositionRevision: intent?.inputCompositionRevision,
  });
}

export async function selectInteractionSendIntentAfterInputReconciliation({
  awaitInputDraft,
  selectionIsCurrent,
  replayIntent,
  rebuildIntent,
}) {
  await awaitInputDraft();
  if (!selectionIsCurrent()) return null;
  return replayIntent() || rebuildIntent();
}

export function rebuildInteractionSendIntentAfterInputReconciliation({
  clickedIntent,
  currentIntent,
  inputDraftRevision,
  inputCompositionRevision,
}) {
  return Object.freeze({
    ...(clickedIntent || currentIntent),
    contextConfirmationIds: currentIntent.contextConfirmationIds,
    inputDraftRevision,
    ...(inputCompositionRevision === undefined ? {} : { inputCompositionRevision }),
  });
}

export function confirmationSendFailureMayHaveCommitted(error) {
  return error?.status == null || Number(error.status) >= 500;
}

export function settleConfirmationSendReplay(replays, {
  threadId,
  intent,
  contextRevision,
  preserve,
}) {
  const next = new Map(replays);
  const key = String(threadId);
  if (preserve) next.set(key, Object.freeze({ intent, contextRevision }));
  else next.delete(key);
  return next;
}

export function interactionSendIntent({
  threadId,
  draftScopeKey,
  promptValue,
  promptRevision = 0,
  contexts,
  contextRevision = 0,
  modelSelection,
  inputDraftRevision = null,
  inputCompositionRevision = 0,
}) {
  const confirmationIds = contextConfirmationIds(contexts);
  return Object.freeze({
    threadId,
    draftScopeKey,
    promptValue,
    text: String(promptValue).trim(),
    contexts,
    contextPayload: Object.freeze(interactionContextPayload(contexts)),
    contextConfirmationIds: Object.freeze(confirmationIds),
    submission: captureComposerSubmission({
      threadId,
      scopeKey: draftScopeKey,
      prompt: { value: promptValue, revision: promptRevision },
      contexts: { value: contexts, revision: contextRevision },
    }),
    modelSelection,
    inputDraftRevision,
    inputCompositionRevision,
  });
}

export function composerSubmissionReady(
  value,
  disabled = false,
  modelReady = true,
  contexts = [],
  editorOpen = false,
  inputAttachments = [],
) {
  return !disabled
    && modelReady
    && !editorOpen
    && (
      Boolean(value.trim())
      || contextDraftHasAnnotation(contexts)
      || inputAttachments.length > 0
    );
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

export function contextConfirmationIds(contexts = []) {
  return contexts.flatMap((context) => (
    context.annotationConfirmations || []
  )).filter(Boolean).map((confirmation) => confirmation.draftId);
}

export function composerContextsFromConfirmations(confirmations = []) {
  const contexts = [];
  for (const confirmation of confirmations) {
    let context = contexts.find((candidate) => (
      String(candidate.target.nodeId) === String(confirmation.target.nodeId)
      && String(candidate.target.sourceInteractionNodeId)
        === String(confirmation.target.sourceInteractionNodeId)
      && String(candidate.target.sourceLayerId) === String(confirmation.target.sourceLayerId)
    ));
    if (!context) {
      context = {
        target: confirmation.target,
        node: confirmation.targetNode,
        annotations: [],
        annotationConfirmations: [],
      };
      contexts.push(context);
    }
    context.annotations.push(confirmation.annotation);
    context.annotationConfirmations.push(confirmation);
  }
  return contexts;
}

export function composerContextsMergedWithConfirmations(contexts, confirmations) {
  const merged = composerContextsFromConfirmations(confirmations);
  for (const context of contexts) {
    for (const [index, annotation] of (context.annotations || []).entries()) {
      if (context.annotationConfirmations?.[index]) continue;
      let target = merged.find((candidate) => (
        String(candidate.target.nodeId) === String(context.target.nodeId)
        && String(candidate.target.sourceInteractionNodeId)
          === String(context.target.sourceInteractionNodeId)
        && String(candidate.target.sourceLayerId) === String(context.target.sourceLayerId)
      ));
      if (!target) {
        target = {
          target: context.target,
          node: context.node,
          annotations: [],
          annotationConfirmations: [],
        };
        merged.push(target);
      }
      target.annotations.push(annotation);
      target.annotationConfirmations.push(null);
    }
  }
  return merged;
}

export function settledComposerContextsWithConfirmations(contexts, confirmations) {
  return {
    ...contexts,
    value: composerContextsMergedWithConfirmations(contexts.value, confirmations),
  };
}

export function composerConfirmationAuthorityChanged(contexts, confirmations) {
  const identity = (confirmation) => JSON.stringify([
    String(confirmation.draftId),
    interactionContextTargetKey(confirmation.target),
    String(confirmation.annotation),
    Number(confirmation.confirmationRevision ?? 0),
  ]);
  const local = contexts.flatMap((context) => (
    context.annotationConfirmations || []
  )).filter(Boolean).map(identity).sort();
  const authoritative = confirmations.map(identity).sort();
  return JSON.stringify(local) !== JSON.stringify(authoritative);
}

export async function refreshComposerContextsAfterFailedConfirmationSend({
  controller,
  threadId,
  currentContextState,
}) {
  await controller.load(threadId);
  const state = currentContextState();
  const confirmations = controller.confirmationsForThread(threadId);
  return composerConfirmationAuthorityChanged(state.value, confirmations)
    ? {
      changed: true,
      sourceValue: state.value,
      sourceRevision: state.revision,
      value: composerContextsMergedWithConfirmations(state.value, confirmations),
    }
    : {
      changed: false,
      sourceValue: state.value,
      sourceRevision: state.revision,
      value: state.value,
    };
}

export function contextEditorCanConfirm(editor) {
  return Boolean(editor) && (
    (editor.attaching && !editor.durable) || Boolean(String(editor.value).trim())
  );
}

export function contextEditorPresentation(editor, stagingDisabled = false, resolving = false) {
  const locked = stagingDisabled || resolving;
  return {
    textareaDisabled: locked,
    controlsDisabled: locked,
    confirmDisabled: locked || !contextEditorCanConfirm(editor),
  };
}

export function contextEditorIdentity(editor) {
  if (!editor) return null;
  return JSON.stringify([
    String(editor.ownerThreadId),
    editor.draftId,
    String(editor.nodeId),
    String(editor.target?.sourceInteractionNodeId),
    String(editor.target?.sourceLayerId),
    editor.annotationIndex,
    editor.attaching,
    editor.durable,
  ]);
}

export function durableContextEditorForDraft(threadId, node, draft, {
  attaching = true,
  error = null,
} = {}) {
  if (!draft || String(draft.target?.nodeId) !== String(node?.id)) return null;
  return {
    ownerThreadId: String(threadId),
    nodeId: node.id,
    draftId: draft.id,
    target: draft.target,
    annotationIndex: null,
    confirmation: null,
    value: draft.text || "",
    attaching,
    durable: true,
    error,
  };
}

export function nodeContextDraftForSelection(draft, node, target) {
  if (!draft || !node || !target) return null;
  return String(draft.target?.nodeId) === String(node.id)
    && interactionContextTargetKey(draft.target) === interactionContextTargetKey(target)
    ? draft
    : null;
}

export function nodeContextDockError(editor, draft) {
  if (editor?.error) return editor.error;
  return draft?.status === "error" ? `Not saved: ${draft.error}` : "";
}

export async function saveContextDraftBeforeSelection({
  controller,
  editor,
  textarea,
}) {
  if (!editor?.durable) return true;
  if (textarea && textarea.value !== editor.value) {
    applyMountedContextEditorInput({
      editor,
      textarea,
      controller,
      threadId: editor.ownerThreadId,
      nodeId: editor.nodeId,
    });
  }
  let draft = controller.draftForNode(editor.ownerThreadId, editor.nodeId);
  if (draft?.status !== "saved" || draft.revision == null) {
    await controller.flush(editor.ownerThreadId, editor.nodeId);
    draft = controller.draftForNode(editor.ownerThreadId, editor.nodeId);
  }
  return Boolean(draft?.status === "saved" && draft.revision != null);
}

export function syncMountedContextEditorControls(textarea, presentation, value) {
  if (!textarea) return;
  textarea.disabled = presentation.textareaDisabled;
  const editor = textarea.closest?.(".node-context-dock")
    || textarea.parentElement;
  const remove = editor?.querySelector('[aria-label^="Discard annotation draft"]');
  const confirm = editor?.querySelector('[aria-label="Confirm annotation"]');
  if (remove) remove.disabled = presentation.controlsDisabled;
  if (confirm) confirm.disabled = presentation.confirmDisabled || !String(value).trim();
}

export function applyMountedContextEditorInput({
  editor,
  textarea,
  controller,
  threadId,
  nodeId,
}) {
  if (textarea.disabled) {
    textarea.value = editor.value;
    return false;
  }
  if (editor.durable && !controller.update(threadId, nodeId, textarea.value)) {
    textarea.value = editor.value;
    return false;
  }
  editor.value = textarea.value;
  return true;
}

export function contextConfirmationDestination(currentThreadId, confirmingThreadId) {
  return String(currentThreadId) === String(confirmingThreadId) ? "current" : "deferred";
}

export function interactionContextTargetKey(target) {
  return JSON.stringify([
    String(target?.nodeId),
    String(target?.sourceInteractionNodeId),
    String(target?.sourceLayerId),
  ]);
}

export function applyContextEditor(contexts, editor, node, target) {
  if (!contextEditorCanConfirm(editor)) return contexts;
  const next = contexts.map((context) => ({
    ...context,
    annotations: [...context.annotations],
    annotationConfirmations: [...(context.annotationConfirmations || [])],
  }));
  const targetKey = interactionContextTargetKey(target);
  let context = next.find((candidate) => (
    interactionContextTargetKey(candidate.target) === targetKey
  ));
  if (!context) {
    context = { target, node, annotations: [], annotationConfirmations: [] };
    next.push(context);
  }
  const value = String(editor.value).trim();
  if (editor.annotationIndex != null) {
    context.annotations[editor.annotationIndex] = value;
    context.annotationConfirmations[editor.annotationIndex] = editor.confirmation || null;
  } else if (value) {
    context.annotations.push(value);
    context.annotationConfirmations.push(editor.confirmation || null);
  }
  return next;
}

export function contextDetachNeedsConfirmation(context) {
  return Boolean(context?.annotations?.length);
}

export function removeContextAnnotation(contexts, target, annotationIndex) {
  const targetKey = interactionContextTargetKey(target);
  return contexts.map((context) => (
    interactionContextTargetKey(context.target) === targetKey
      ? {
        ...context,
        annotations: context.annotations.filter((_, index) => index !== annotationIndex),
        annotationConfirmations: (context.annotationConfirmations || [])
          .filter((_, index) => index !== annotationIndex),
      }
      : context
  ));
}

export function interactionContextTargetForEditor({
  nodeId,
  contextTarget,
  selectedContextTarget,
  sourceInteractionNodeId,
  sourceLayerId,
}) {
  if (contextTarget) return contextTarget;
  if (String(selectedContextTarget?.nodeId) === String(nodeId)) return selectedContextTarget;
  return { nodeId, sourceInteractionNodeId, sourceLayerId };
}

export function createComposerContextState() {
  return {
    value: [],
    revision: 0,
  };
}

export function transitionComposerContextState(state, event) {
  if (event.type === "user_replace") {
    return {
      ...state,
      value: event.value,
      revision: state.revision + 1,
    };
  }
  if (event.type === "settlement") {
    return {
      ...state,
      value: event.field.value,
      revision: event.field.revision,
    };
  }
  if (event.type === "thread_change") {
    const revision = state.revision + 1;
    return {
      value: [],
      revision,
    };
  }
  throw new Error(`Unknown composer context state event: ${String(event.type)}`);
}

export function composerDraftScopeKey(threadId, interactionId) {
  return `${String(threadId)}:${interactionId == null ? "none" : String(interactionId)}`;
}

export function createComposerDraftScopeState() {
  return { activeScopeKey: null, drafts: new Map() };
}

/**
 * The newest unsent follow-up text written this session in an older turn's
 * scope of the same thread, unless it is held, unchanged since Send: the
 * submission in flight, or text a later turn shows was sent. Settlement deletes a sent draft, so what remains in memory is unsent;
 * persisted text from earlier sessions is not moved. `olderScopeKeys` lists
 * the thread's older scopes, newest first.
 */
function unsentOlderDraft(drafts, olderScopeKeys, heldSubmissions) {
  for (const scopeKey of olderScopeKeys) {
    const stored = drafts.get(scopeKey);
    const text = stored?.promptValue || "";
    if (!text) continue;
    const held = heldSubmissions.some((submission) => submission?.scopeKey === scopeKey
      && Object.is(stored?.promptRevision, submission.promptRevision));
    return held ? null : { scopeKey, text };
  }
  return null;
}

export function transitionComposerDraftScope(state, {
  threadId,
  interactionId,
  currentPromptValue,
  currentPromptRevision = 0,
  restoredDraft = null,
  persistedDraftText = null,
  persistedRestorationId = null,
  olderScopeKeys = [],
  inFlightSubmission = null,
  sentDrafts = [],
}) {
  const nextScopeKey = composerDraftScopeKey(threadId, interactionId);
  // A restoration is identified by its interaction and retry attempt, so a
  // later failed attempt of the same interaction restores again (SCP-020).
  const restorationId = restoredDraft?.retryAttemptId != null
    ? `${interactionId}:${restoredDraft.retryAttemptId}`
    : interactionId;
  // A persisted draft that grew from this restoration, before a restart,
  // counts as having applied it, so clearing it leaves the composer empty. A
  // user's own draft with the same text does not (SCP-020).
  const restorationPersisted = Boolean(restoredDraft) && persistedDraftText !== null
    && persistedRestorationId != null && String(persistedRestorationId) === String(restorationId);
  if (state.activeScopeKey === nextScopeKey) {
    const currentDraft = state.drafts.get(nextScopeKey) ?? {
      promptValue: currentPromptValue,
      promptRevision: currentPromptRevision,
      restoredDraftInteractionId: null,
    };
    const restorationArrived = restoredDraft
      && String(currentDraft.restoredDraftInteractionId) !== String(restorationId);
    const persistedDraftChanged = persistedDraftText !== null
      && persistedDraftText !== currentPromptValue;
    // A persisted draft the user wrote wins over a restoration, as it does on
    // entering the scope; otherwise the next render would flip back to it.
    const restores = restorationArrived && !persistedDraftText;
    const promptValue = persistedDraftChanged
      ? persistedDraftText
      : restores ? restoredDraft.text : currentPromptValue;
    const promptRevision = restores || persistedDraftChanged
      ? currentPromptRevision + 1
      : currentPromptRevision;
    const drafts = new Map(state.drafts);
    drafts.set(nextScopeKey, {
      promptValue,
      promptRevision,
      // A restoration the user's draft keeps out stays pending: once the
      // user empties the composer, the retry text returns (SCP-020).
      restoredDraftInteractionId: restores || restorationPersisted
        ? restorationId
        : currentDraft.restoredDraftInteractionId,
    });
    return {
      state: { activeScopeKey: nextScopeKey, drafts },
      promptValue,
      promptRevision,
    };
  }

  const drafts = new Map(state.drafts);
  if (state.activeScopeKey !== null) {
    drafts.set(state.activeScopeKey, {
      promptValue: currentPromptValue,
      promptRevision: currentPromptRevision,
      restoredDraftInteractionId: state.drafts.get(state.activeScopeKey)
        ?.restoredDraftInteractionId ?? null,
    });
  }
  const stored = drafts.get(nextScopeKey);
  // A newer turn's scope starts empty; unsent text typed while the previous
  // turn's scope was active moves into it, so it is not stranded there. It
  // wins over the turn's retry text, as a user's draft does, which leaves
  // the restoration pending (SCP-018, SCP-020).
  const carried = persistedDraftText === null && !stored?.promptValue
    ? unsentOlderDraft(drafts, olderScopeKeys, [inFlightSubmission, ...sentDrafts])
    : null;
  if (carried) {
    drafts.set(nextScopeKey, {
      promptValue: carried.text,
      promptRevision: Math.max(stored?.promptRevision ?? 0, currentPromptRevision) + 1,
      restoredDraftInteractionId: null,
    });
    drafts.delete(carried.scopeKey);
  } else if (restoredDraft && persistedDraftText === null && !stored?.promptValue
    && String(stored?.restoredDraftInteractionId) !== String(restorationId)) {
    // A pending restoration fills an empty composer: an emptied composer
    // holds no draft (SCP-020). An empty value persisted after the user
    // cleared the restored text is a tombstone, and wins.
    drafts.set(nextScopeKey, {
      promptValue: restoredDraft.text,
      promptRevision: Math.max(stored?.promptRevision ?? 0, currentPromptRevision) + 1,
      restoredDraftInteractionId: restorationId,
    });
  } else if (persistedDraftText !== null && stored?.promptValue !== persistedDraftText) {
    // A scope's revision only moves forward, so settlement's revision check
    // can tell an edit from the text it sent. Unchanged text keeps its
    // revision (below); changed text takes one above any it had. The user's
    // draft wins over a restoration, which stays pending; an empty tombstone
    // consumes it.
    drafts.set(nextScopeKey, {
      promptValue: persistedDraftText,
      promptRevision: Math.max(stored?.promptRevision ?? 0, currentPromptRevision) + 1,
      restoredDraftInteractionId: (restoredDraft && !persistedDraftText) || restorationPersisted
        ? restorationId
        : stored?.restoredDraftInteractionId ?? null,
    });
  } else if ((persistedDraftText === "" || restorationPersisted) && restoredDraft) {
    // An unchanged empty tombstone keeps its revision and consumes the restoration.
    drafts.set(nextScopeKey, { ...stored, restoredDraftInteractionId: restorationId });
  } else if (!drafts.has(nextScopeKey)) {
    drafts.set(nextScopeKey, {
      promptValue: "",
      promptRevision: currentPromptRevision + 1,
      restoredDraftInteractionId: null,
    });
  }
  return {
    state: { activeScopeKey: nextScopeKey, drafts },
    promptValue: drafts.get(nextScopeKey).promptValue,
    promptRevision: drafts.get(nextScopeKey).promptRevision,
    carriedFromScopeKey: carried?.scopeKey ?? null,
  };
}

export function clearSubmittedComposerDraft(
  state,
  submittedScopeKey,
  submittedPromptRevision,
  currentPromptRevision,
) {
  const retainedPromptRevision = state.activeScopeKey === submittedScopeKey
    ? currentPromptRevision
    : state.drafts.get(submittedScopeKey)?.promptRevision;
  if (retainedPromptRevision !== submittedPromptRevision) return state;
  const drafts = new Map(state.drafts);
  drafts.delete(submittedScopeKey);
  return { activeScopeKey: state.activeScopeKey, drafts };
}

export function contextStagingDisabledFor(
  status,
  canCompose = true,
  requestDisabled = false,
  restoredDraft = false,
) {
  return requestDisabled || composerDisabledForState(status, canCompose, restoredDraft);
}

export function composerDisabledForState(status, canCompose = true, restoredDraft = false) {
  return !canCompose || (PENDING_COMPLETION_STATUSES.has(status) && !restoredDraft);
}

export function applyComposerCapabilities({ composer, prompt, send, readOnlyMessage }, canCompose) {
  composer.classList.toggle("disabled-composer", !canCompose);
  prompt.classList.toggle("hidden", !canCompose);
  send.classList.toggle("hidden", !canCompose);
  readOnlyMessage.classList.toggle("hidden", canCompose);
}

export function composerStatusForThread(state, thread) {
  return humanTurns(state, thread).at(-1)?.completionStatus || state.status || "idle";
}

/** The latest human turn, which the composer follows up, retries, and inherits a model from. */
export function latestHumanTurn(state, thread) {
  return humanTurns(state, thread).at(-1);
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
    icon: imageIconReference(action?.icon) ?? (typeof action?.icon === "string" && action.icon.trim() ? action.icon : null),
    description: variant === "card" && typeof action?.description === "string"
      ? action.description
      : null,
  };
}

function usesResolvedInvokeDestination(action, imported) {
  // Imported conversions retain binding history, but no native invoke receipt.
  // Their accepted target is ordinary read-only layer navigation. Public shares
  // use their own validated turn mapping and still take the resolved callback.
  const importedConversion = imported && action?.convertedFromInvoke === true
    && !(Number.isSafeInteger(action.resolvedInvokeInteractionId) && action.resolvedInvokeInteractionId > 0);
  return action != null && isResolvedInvokeAction(action) && !importedConversion;
}

export function actionActivationPresentation(
  action,
  { invoked = false, retryable = false, canInvokeMutatingActions = false, imported = false } = {},
) {
  const layerNavigation = action?.kind === "navigate" && action.targetLayerId != null;
  const resolvedInvoke = (action?.kind === "invoke" && action.targetLayerId != null)
    || usesResolvedInvokeDestination(action, imported);
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

export async function navigateWorkspaceAction({
  action,
  activation,
  sourceNode,
  collapseContextPreviews,
  onNavigateResolvedInvoke,
  onNavigateLayer,
}) {
  if (activation.resolvedInvoke) {
    await onNavigateResolvedInvoke(action, { beforeCommit: collapseContextPreviews });
    return;
  }
  await onNavigateLayer(action.targetLayerId, { action, sourceNode });
}


export function resolveCompiledNodeDetailAction(actions, reference, node) {
  const matches = (ref, id, clientKey) => ref != null
    && (ref.id != null || ref.clientKey != null)
    && (ref.id == null || String(ref.id) === String(id))
    && (ref.clientKey == null || ref.clientKey === clientKey);
  if (!reference?.clientKey || !matches(reference.sourceNode, node?.id, node?.clientKey)) return undefined;
  return (actions || []).find((action) => (
    action.clientKey === reference.clientKey
    && action.sourceNodeId != null && String(action.sourceNodeId) === String(node.id)
    && (reference.sourceLayer == null
      ? action.sourceLayerId == null
      : matches(reference.sourceLayer, action.sourceLayerId, action.sourceLayerClientKey))
  ));
}

export function compiledNodeDetailCoversActions(detail, actions, node) {
  const boundActionIds = new Set((detail?.mounts ?? [])
    .filter((mount) => mount.kind === "capability" && mount.capability.kind !== "link")
    .map((mount) => {
      const action = resolveCompiledNodeDetailAction(actions, mount.capability.action, node);
      if (mount.capability.kind === "input" && action?.kind === "input") return action.id;
      if (mount.capability.kind === "invoke" && (action?.kind === "invoke" || (action && isResolvedInvokeAction(action)))) return action.id;
      if ((mount.capability.kind === "expand" || mount.capability.kind === "reference")
        && action?.kind === "navigate"
        && action.relation === mount.capability.kind
        && action.targetLayerId != null) return action.id;
      return undefined;
    })
    .filter((id) => id != null)
    .map(String));
  return (actions ?? []).every((action) => boundActionIds.has(String(action.id)));
}

export function graphCameraForView({
  cachedView,
  cachedLayoutMatches,
  enteringView,
  nodes,
  bounds,
  currentCamera,
  currentCameraRevision,
}) {
  if (cachedView && cachedLayoutMatches) {
    if (cachedView.cameraRevision === 0) {
      return { camera: fitGraphCamera(nodes, bounds), cameraRevision: 0 };
    }
    return {
      camera: { ...cachedView.camera },
      cameraRevision: cachedView.cameraRevision,
    };
  }
  if (enteringView || !cachedLayoutMatches) {
    return { camera: fitGraphCamera(nodes, bounds), cameraRevision: 0 };
  }
  return { camera: currentCamera, cameraRevision: currentCameraRevision };
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

export function contextAnnotationCountLabel(count) {
  return `${count} annotation${count === 1 ? "" : "s"}`;
}

export function inputCommitTargetsCurrentSelection(original, current) {
  const fields = [
    "threadId",
    "nodeId",
    "presentingInteractionNodeId",
    "presentingLayerId",
  ];
  return fields.every((field) => original?.[field] != null
    && current?.[field] != null
    && String(original[field]) === String(current[field]));
}

export function settleNodeInputCommit({
  inputPending,
  stageKey,
  originalSelection,
  currentSelection,
  repaintNodeInputs,
  renderComposer,
}) {
  inputPending.end(stageKey);
  if (inputCommitTargetsCurrentSelection(originalSelection, currentSelection())) {
    repaintNodeInputs();
  }
  renderComposer();
}

export function beginNodeInputMutation({
  inputPending,
  stageKey,
  repaintNodeInputs,
  renderComposer,
}) {
  inputPending.begin(stageKey);
  repaintNodeInputs();
  renderComposer();
}

export function compactSubmittedText(value, limit = 80) {
  const prefix = [];
  let hasContent = false;
  let pendingSpace = false;
  for (const codePoint of value) {
    if (/\s/u.test(codePoint)) {
      if (hasContent) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      prefix.push(" ");
      if (prefix.length > limit) break;
    }
    prefix.push(codePoint);
    hasContent = true;
    pendingSpace = false;
    if (prefix.length > limit) break;
  }
  return prefix.length > limit
    ? `${prefix.slice(0, limit - 1).join("")}…`
    : prefix.join("");
}

export function submittedInputHistoryPresentation(input) {
  const prompt = input?.action?.prompt || "Input";
  if (typeof input?.value?.text === "string") {
    const fullValue = input.value.text;
    const compactValue = compactSubmittedText(fullValue);
    if (fullValue !== compactValue) {
      return Object.freeze({
        kind: "disclosure",
        compactValue,
        fullValue,
        ariaLabel: `Show full submitted value for ${prompt}`,
      });
    }
    return Object.freeze({ kind: "plain", compactValue });
  }
  const compactValue = Array.isArray(input?.value?.selected)
    ? input.value.selected.map((option) => option.label).join(", ")
    : (input?.value?.selectedKeys || []).join(", ");
  return Object.freeze({ kind: "plain", compactValue });
}

// History state is supplied by the renderer integration so Product and Eval use the same
// controls. `onSelectTurn(delta)` remains the keyboard/stepper contract; callers can add
// `onSelectTurnById(id)` for direct popover jumps without changing existing integrations.
// Loads the design's UI and display fonts before the first graph render, so pill
// widths are measured with them. A missing font resolves to the fallback.
export async function loadDesignFonts(documentObject = document) {
  const style = documentObject.defaultView?.getComputedStyle?.(documentObject.documentElement);
  const families = ["--font-ui", "--font-display"].map((name) => style?.getPropertyValue(name).trim()).filter(Boolean);
  await Promise.all(families.map((family) => documentObject.fonts?.load?.(`600 14px ${family}`)?.catch(() => [])));
}

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
  onOpenReadyResult = () => {},
  layerSelectionMemoryOwner = globalThis.window,
  onArchiveThread = null,
  onExportConversation = null,
  shareApi = null,
  onSubmitInteraction = async () => {},
  onStopInteraction = async () => {},
  onOpenSettings = () => {},
  onRefreshModels = null,
  onNavigateLayer = async () => {},
  onNavigateResolvedInvoke = async () => {},
  onNavigateInvocationCurrent = null,
  onNavigateImportedInvocationHistory = null,
  onInvokeAction = async () => {},
  resolveNodeDetailAsset = async () => undefined,
  onDecideApproval = async () => {},
  annotationApi = null,
  contextDraftApi = null,
  inputDraftApi = null,
  isComposerInputOccurrence = null,
  implicitInputAcceptance = false,
  inputEditingState = null,
  inputOperatorAvailable = false,
}) {
  const iconMounts = new Set();
  function createRelayerIcon(value, attributes = {}, owner, context = {}) {
    const icon = imageIconReference(value);
    if (!icon) return createSymbolIcon(value, attributes);
    const state = getState();
    const thread = context.thread ?? getThread();
    const node = owner ?? (state.nodes ?? []).find(candidate => candidate.icon === value)
      ?? (state.nodes ?? []).find(candidate => (state.actions ?? []).some(action => action.icon === value && String(action.sourceNodeId) === String(candidate.id)));
    const interaction = context.interaction ?? interactionForThread(state, thread);
    const layerId = context.layerId ?? state.visibleLayer?.layer?.id ?? interaction?.completionOutput?.rootLayer?.layer?.id;
    const mount = createImageIcon(icon, attributes, asset => resolveNodeDetailAsset(asset, { node, state, thread, interaction, layerId }), { document: graphDocument });
    iconMounts.add(mount);
    return mount;
  }
  function iconSourceContext(target, state = getState(), thread = getThread()) {
    return { thread, layerId: target?.sourceLayerId, interaction: state.interactions?.find(candidate => String(candidate.graphNodeId) === String(target?.sourceInteractionNodeId) && String(candidate.threadId) === String(thread?.id)) };
  }
  function releaseDetachedIcons() {
    for (const mount of iconMounts) if (!mount.isConnected) { mount.disposeIcon(); iconMounts.delete(mount); }
  }
  const capabilities = workspaceModeCapabilities(mode);
  let graphNodes = [];
  let graphEdges = [];
  let graphEdgeShape = resolveEdgeShape(undefined);
  // Agent-authored per-edge routes by edge ID, with waypoints projected into the world plane.
  let graphEdgeRoutes = new Map();
  let graphSignature = "";
  let graphViewKey = "";
  // Advances on every view entry, so a request made in a view the user left
  // is void even after returning to a view with the same key.
  let graphViewEpoch = 0;
  let dragging = null;
  // A layout that changed mid-drag is fitted once the drag ends.
  let fitGraphAfterDrop = false;
  let panning = null;
  let pinching = null;
  let camera = { x: 0, y: 0, zoom: 1 };
  let cameraRevision = 0;
  let inspectorFitRequest = null;
  let inspectorFitFrame = null;
  let turnPopoverOpen = false;
  let settingsMenuOpen = false;
  let inputOperatorCommitted = false;
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
  let renderedWithoutThread = false;
  let annotationRatingTouched = false;
  let editingAnnotation = null;
  let inspectorFocusOrigin = null;
  let composerContextState = createComposerContextState();
  let contextEditor = null;
  let nodeSelectionSequence = 0;
  let mountedAuthoredDetail = null;
  let openComposerContextKey = null;
  let contextPopoverOpen = false;
  const contextNodeOverrides = new Map();
  let selectedContextTarget = null;
  const contextDraftController = contextDraftApi
    ? createNodeContextDraftController({
      api: contextDraftApi,
      onChange: () => {
        settleAdoptedDraftOperations();
        renderContextDraftStatus();
      },
    })
    : null;
  const contextEditorErrors = new Map();
  const contextEditorErrorKey = (editor) => (
    editor?.draftId == null ? null : `${editor.ownerThreadId}:${editor.draftId}`
  );
  const rememberContextEditorError = (editor, error) => {
    const key = contextEditorErrorKey(editor);
    if (key !== null) contextEditorErrors.set(key, error);
    editor.error = error;
  };
  const clearContextEditorError = (editor) => {
    const key = contextEditorErrorKey(editor);
    if (key !== null) contextEditorErrors.delete(key);
    editor.error = null;
  };
  const restoredContextEditorError = (threadId, draftId) => (
    contextEditorErrors.get(`${threadId}:${draftId}`) || null
  );
  const contextDraftLoads = new Map();
  const loadedContextDraftThreads = new Set();
  const inputDraftController = inputDraftApi
    ? createNodeInputDraftController({ api: inputDraftApi })
    : null;
  const liveAnswerController = inputDraftApi?.answer ? createLiveAnswerController({ api: inputDraftApi }) : null;
  const inputDraftLoads = inputDraftController
    ? createNodeInputDraftLoadQueue({ load: (threadId) => inputDraftController.load(threadId) })
    : null;
  const loadedInputDraftThreads = new Set();
  const retainedInputEditingState = inputEditingState?.version === 1 ? structuredClone(inputEditingState) : {};
  const retainedInputEditingKeys = new Set((retainedInputEditingState.stages ?? []).map(([key]) => key));
  const inputStages = new Map(retainedInputEditingState.stages ?? []);
  const implicitInputEntries = new Map(retainedInputEditingState.entries ?? []);
  const inputScopeObservations = new Map(retainedInputEditingState.scopeObservations ?? []);
  const implicitInvokeBoundaries = new Set();
  const implicitSendSnapshots = new Map();
  isComposerInputOccurrence ??= (occurrence) => {
    const threadId = getThread()?.id;
    if (!implicitInputAcceptance) return true;
    const attachment = committedInputAttachment(inputDraftController?.current(threadId), occurrence);
    if (typeof attachment?.composerEligible === "boolean") return attachment.composerEligible;
    const stageKey = threadInputOccurrenceKey(threadId, occurrence);
    const entry = implicitInputEntries.get(stageKey);
    if (entry) return entry.composerEligible;
    if (inputScopeObservations.has(stageKey)) return inputScopeObservations.get(stageKey);
    const state = getState();
    const interaction = currentInteraction(state, getThread());
    if (String(interaction?.graphNodeId) !== String(occurrence.presentingInteractionNodeId)
      || String(currentLayerId(state, getThread())) !== String(occurrence.presentingLayerId)) return false;
    return !(state.actions ?? []).some(action => action.kind === "invoke"
      && action.inputActionIds?.some(id => String(id) === String(occurrence.actionId)));
  };
  const inputEditEpochs = new Map(retainedInputEditingState.editEpochs ?? []);
  const noteInputEdit = (key) => {
    inputEditEpochs.set(key, (inputEditEpochs.get(key) ?? 0) + 1);
    const entry = implicitInputEntries.get(key);
    if (implicitInputAcceptance && entry?.composerEligible) markInputCompositionChanged(JSON.parse(key)[0]);
  };
  const inputErrors = new Map(retainedInputEditingState.errors ?? []);
  const inputTouched = new Set(retainedInputEditingState.touched ?? []);
  const inputPending = createInputMutationTracker();
  // Stage keys whose pending mutation is a commit. Send waits for a commit
  // (through authoredInputCommits) instead of being disabled by it.
  const committingInputStages = new Set();
  // An authored Node Detail input commits on change, and pressing Send blurs
  // it first. Send waits for these commits instead of being disabled by
  // them, so that click is not lost and it carries the committed answer.
  const authoredInputCommits = new Map();
  const composerInputCommits = new WeakMap();
  const authoredCommitOccurrences = new WeakMap();
  const inputKeyBelongsToComposer = (inputKey) => {
    const [presentingInteractionNodeId, presentingLayerId, actionId] = String(inputKey).split("\u0000");
    return isComposerInputOccurrence({ presentingInteractionNodeId, presentingLayerId, actionId });
  };
  // A commit can fail before the click that blurred its input arrives, so an
  // input's latest failed commit is kept until a Send it stops, a newer
  // commit of that input, or detaching that input accounts for it.
  const latestAuthoredInputCommits = new Map();
  const failedAuthoredInputs = new Map();
  // thread and input -> why its latest commit failed, shown again when its
  // Node Detail remounts, until a later commit or detaching it clears it.
  const authoredInputErrors = new Map();
  const authoredInputKey = (occurrence) => [
    occurrence.presentingInteractionNodeId,
    occurrence.presentingLayerId,
    occurrence.actionId,
  ].join("\u0000");
  const trackAuthoredInputCommit = (threadId, inputKey, commit) => {
    const key = String(threadId);
    const inputSlot = `${key}\u0000${inputKey}`;
    const commits = authoredInputCommits.get(key) ?? new Set();
    authoredInputCommits.set(key, commits);
    commits.add(commit);
    composerInputCommits.set(commit, inputKeyBelongsToComposer(inputKey));
    authoredCommitOccurrences.set(commit, inputKey);
    latestAuthoredInputCommits.set(inputSlot, commit);
    failedAuthoredInputs.get(key)?.delete(inputKey);
    void commit.then(() => {
      if (latestAuthoredInputCommits.get(inputSlot) === commit) authoredInputErrors.delete(inputSlot);
    }, (error) => {
      if (latestAuthoredInputCommits.get(inputSlot) !== commit) return;
      authoredInputErrors.set(inputSlot, error?.message || "Input could not be committed.");
      const failed = failedAuthoredInputs.get(key) ?? new Set();
      failedAuthoredInputs.set(key, failed);
      failed.add(inputKey);
    }).finally(() => {
      if (latestAuthoredInputCommits.get(inputSlot) === commit) latestAuthoredInputCommits.delete(inputSlot);
      commits.delete(commit);
      if (!commits.size && authoredInputCommits.get(key) === commits) authoredInputCommits.delete(key);
      syncBoundInvokeControls(getState());
      syncComposer();
    });
    syncComposer();
    return commit;
  };
  // mount key and input -> the thread of an authored text input edited and
  // not yet committed. Pressing Send leaves the field, which commits it, so
  // the answer counts toward Send being ready while its Node Detail shows.
  const authoredInputEdits = new Map();
  const composerInputEdits = new Map();
  // The change that leaves the field starts its commit after an await; until
  // onInput tracks that commit, the submission counts as the commit. One the
  // input refused (a blank answer, or one it cannot commit here) failed, and
  // stops a Send as a failed commit does, until that input is edited again
  // or a later submission of it commits.
  // Keyed by the Node Detail's mount key as well, since mount IDs repeat
  // across Node Details.
  const refusedInputKey = (mountKey, mountId) => `refused\u0000${mountKey}\u0000${mountId}`;
  // refusal key -> the input key of the occurrence it refused, so detaching
  // that input clears it.
  const refusedInputOccurrences = new Map();
  const trackAuthoredInputSubmit = (threadId, submitted, refusalKey, occurrence) => {
    const key = String(threadId);
    const commits = authoredInputCommits.get(key) ?? new Set();
    authoredInputCommits.set(key, commits);
    commits.add(submitted);
    composerInputCommits.set(submitted, occurrence ? isComposerInputOccurrence(occurrence) : true);
    if (occurrence) authoredCommitOccurrences.set(submitted, authoredInputKey(occurrence));
    void submitted.then((committed) => {
      // A later submission that commits (a select reports no edit between
      // them) accounts for the refusal too.
      if (committed !== false) {
        failedAuthoredInputs.get(key)?.delete(refusalKey);
        return;
      }
      const failed = failedAuthoredInputs.get(key) ?? new Set();
      failedAuthoredInputs.set(key, failed);
      failed.add(refusalKey);
    }).finally(() => {
      commits.delete(submitted);
      if (!commits.size && authoredInputCommits.get(key) === commits) authoredInputCommits.delete(key);
      syncComposer();
    });
  };
  const pendingAuthoredInputCommits = (threadId) => {
    const key = String(threadId);
    const mountKey = mountedAuthoredDetail?.host?.isConnected && !$("#inspector").classList.contains("hidden")
      ? mountedAuthoredDetail.mountKey
      : null;
    const edits = [...authoredInputEdits].filter(([editKey, editThreadId]) => (
      editThreadId === key && composerInputEdits.get(editKey) !== false
        && editKey.startsWith(`${mountKey}\u0000`))).length;
    return [...(authoredInputCommits.get(key) ?? [])].filter(commit => composerInputCommits.get(commit) !== false).length + edits;
  };
  // Whether every answer saved. A failure stops this Send only, whether or
  // not its Node Detail is still open; the input shows why, and sending
  // again without the answer is the user's choice.
  const settleAuthoredInputCommits = async (threadId) => {
    const key = String(threadId);
    let commits;
    while ((commits = [...(authoredInputCommits.get(key) ?? [])].filter(commit => composerInputCommits.get(commit) !== false)).length) {
      await Promise.allSettled(commits);
    }
    const failed = failedAuthoredInputs.get(key);
    const composerFailures = [...(failed ?? [])].filter(inputKey => inputKeyBelongsToComposer(refusedInputOccurrences.get(inputKey) ?? inputKey));
    for (const inputKey of composerFailures) failed.delete(inputKey);
    if (!failed?.size) failedAuthoredInputs.delete(key);
    return !composerFailures.length;
  };
  const inputRailScroll = new Map(retainedInputEditingState.railScroll ?? []);
  let inputFocusRequest = null;
  const renderedInputDraftStatusKeys = new Map();
  let openComposerInputKey = null;
  const inputCompositionRevisions = new Map(retainedInputEditingState.compositionRevisions ?? []);
  const recoveredConfirmationThreads = new Set();
  const contextDraftLoadRetryTimers = new Map();
  const contextDraftLoadRetryAttempts = new Map();
  let inputDraftLoadRetries = null;
  let disposed = false;

  const clearInputStagesForThread = (threadId, { composerOnly = false } = {}) => {
    if (implicitInputAcceptance && !composerOnly) return;
    for (const collection of [inputStages, inputErrors, inputRailScroll, inputTouched]) {
      for (const key of collection.keys()) {
        // A read-only Current has no authority to discard the source's local
        // edits when its inspector changes or closes.
        if (mode === "review" && retainedInputEditingKeys.has(key)) continue;
        if (inputKeyBelongsToThread(key, threadId)
          && (!composerOnly || !implicitInputEntries.has(key)
            || isComposerInputOccurrence(implicitInputEntries.get(key).occurrence))) collection.delete(key);
      }
    }
  };
  const currentInputDraftRevision = (threadId) => {
    const draft = inputDraftController?.current(threadId);
    return inspectedInputDraftRevision(draft);
  };
  const currentInputCompositionRevision = (threadId) => (
    inputCompositionRevisions.get(String(threadId)) || 0
  );
  const markInputCompositionChanged = (threadId) => {
    const key = String(threadId);
    inputCompositionRevisions.set(key, currentInputCompositionRevision(key) + 1);
  };
  const ensureInputDraftLoaded = (threadId, { reload = false } = {}) => {
    if (!inputDraftController || threadId == null) return Promise.resolve(null);
    const key = String(threadId);
    if (!reload && loadedInputDraftThreads.has(key) && !inputDraftLoads.has(key)) {
      return Promise.resolve(inputDraftController.current(threadId));
    }
    const load = inputDraftLoads.load(threadId, { reload })
      .then((draft) => {
        if (disposed) return draft;
        loadedInputDraftThreads.add(key);
        inputDraftLoadRetries?.reset(threadId);
        if (String(getThread()?.id) === key) {
          renderComposerContexts();
          if (selection.selectedNodeId != null) {
            void selectNode(getState(), selection.selectedNodeId, { notify: false });
          }
        }
        return draft;
      })
      .catch((error) => {
        loadedInputDraftThreads.delete(key);
        throw error;
      });
    return load;
  };

  inputDraftLoadRetries = inputDraftController ? createInputDraftLoadRetryScheduler({
    setTimeout: (callback, delay) => graphWindow.setTimeout(callback, delay),
    clearTimeout: (timer) => graphWindow.clearTimeout(timer),
    load: (threadId) => ensureInputDraftLoaded(threadId),
    isEligible: (threadId) => !disposed
      && String(getThread()?.id) === String(threadId)
      && !loadedInputDraftThreads.has(String(threadId)),
  }) : null;

  // While an annotation draft resolves (its flush before a switch or a
  // navigation, ✓, or ×), a user's click or navigation waits for it and then
  // proceeds if it is still the latest one, instead of being dropped. When
  // the draft resolves, the selection is re-rendered from the latest state
  // unless a waiting request or the continuing switch will render it.
  let editorResolution = null;
  let userRequestTicket = 0;
  let waitingUserRequests = 0;
  const refreshSelection = () => {
    if (disposed || selection.selectedNodeId == null) return;
    void selectNode(getState(), selection.selectedNodeId, { notify: false });
  };
  const beginEditorResolution = (editor) => {
    editor.resolving = true;
    let settle;
    const resolution = new Promise((resolve) => { settle = resolve; });
    editorResolution = resolution;
    let ended = false;
    return ({ refresh = true } = {}) => {
      if (ended) return;
      ended = true;
      editor.resolving = false;
      if (editorResolution === resolution) editorResolution = null;
      settle();
      if (refresh && !waitingUserRequests) refreshSelection();
    };
  };
  // An editor remounted while its draft's confirm, discard, or reconcile is
  // still in flight (after leaving the thread and returning) resolves until
  // that operation settles, as the editor that started it did.
  // The workspace's own confirm or discard is the stable signal: its promise
  // settles only once any revision-conflict reconciliation and retry are
  // done, while the draft's operation kind passes through idle and saving.
  const draftOperationPending = (draft) => (
    ["confirming", "discarding", "reconciling"].includes(draft?.operation?.kind));
  const workspaceDraftOperations = new Map();
  const draftOperationKey = (threadId, nodeId) => `${threadId}\u0000${nodeId}`;
  const trackDraftOperation = (threadId, nodeId, operation) => {
    const key = draftOperationKey(threadId, nodeId);
    const tracked = Promise.resolve(operation);
    workspaceDraftOperations.set(key, tracked);
    const release = () => {
      if (workspaceDraftOperations.get(key) === tracked) workspaceDraftOperations.delete(key);
    };
    tracked.then(release, release);
    return operation;
  };
  const adoptedDraftOperations = new Set();
  const adoptDraftOperation = (editor, threadId, nodeId) => {
    if (!editor || editor.resolving) return;
    const tracked = workspaceDraftOperations.get(draftOperationKey(threadId, nodeId));
    if (tracked) {
      const end = beginEditorResolution(editor);
      tracked.then(() => end(), () => end());
      return;
    }
    // An operation the workspace did not start: settle once the controller
    // shows it done after the current task, past any transient state.
    if (!draftOperationPending(contextDraftController?.draftForNode(threadId, nodeId))) return;
    adoptedDraftOperations.add({ threadId, nodeId, end: beginEditorResolution(editor) });
  };
  function settleAdoptedDraftOperations() {
    if (!adoptedDraftOperations.size) return;
    queueMicrotask(() => {
      for (const adopted of adoptedDraftOperations) {
        if (draftOperationPending(contextDraftController?.draftForNode(adopted.threadId, adopted.nodeId))) continue;
        adoptedDraftOperations.delete(adopted);
        adopted.end();
      }
    });
  }
  const awaitUserRequestTurn = async () => {
    const ticket = ++userRequestTicket;
    waitingUserRequests += 1;
    try {
      while (editorResolution) await editorResolution;
    } finally {
      waitingUserRequests -= 1;
    }
    return !disposed && ticket === userRequestTicket;
  };

  const prepareNodeContextSelectionChange = async () => {
    const requestSequence = ++nodeSelectionSequence;
    if (contextEditor?.resolving) {
      const viewEpoch = graphViewEpoch;
      if (!await awaitUserRequestTurn()) return false;
      // A request made in a view the workspace has since left is void.
      if (graphViewEpoch !== viewEpoch) {
        refreshSelection();
        return false;
      }
      return prepareNodeContextSelectionChange();
    }
    // A request that proceeds at once voids any still waiting.
    userRequestTicket += 1;
    const editor = contextEditor;
    if (!editor?.durable) return true;
    const endResolution = beginEditorResolution(editor);
    let saved = false;
    try {
      renderNodeContextDock();
      saved = await saveContextDraftBeforeSelection({
        controller: contextDraftController,
        editor,
        textarea: $("#nodeContextDock #contextAnnotationEditor"),
      });
    } catch {
      saved = false;
    } finally {
      const current = requestSequence === nodeSelectionSequence;
      const again = current && contextEditor !== editor && saved;
      const proceeds = current && contextEditor === editor && saved;
      // A proceeding or repeated prepare renders what follows; otherwise the
      // selection is re-rendered now that the draft has resolved.
      endResolution({ refresh: !proceeds && !again });
    }
    if (requestSequence !== nodeSelectionSequence) {
      if (contextEditor === editor) renderComposerContexts();
      return false;
    }
    if (contextEditor !== editor && saved) {
      // The editor was replaced meanwhile; prepare again for the one open now.
      return prepareNodeContextSelectionChange();
    }
    if (contextEditor !== editor || !saved) {
      if (contextEditor === editor) renderComposerContexts();
      return false;
    }
    return true;
  };

  const ensureContextDraftsLoaded = (threadId) => {
    if (!contextDraftController || threadId == null) return Promise.resolve();
    const key = String(threadId);
    if (loadedContextDraftThreads.has(key)) return Promise.resolve();
    if (contextDraftLoads.has(key)) return contextDraftLoads.get(key);
    const expectedRevision = String(getThread()?.id) === String(threadId)
      ? composerContextState.revision
      : null;
    const load = contextDraftController.load(threadId)
      .then(() => {
        if (disposed) return;
        loadedContextDraftThreads.add(key);
        contextDraftLoadRetryAttempts.delete(key);
        hydrateConfirmedComposerContexts(threadId, expectedRevision);
      })
      .catch((error) => {
        contextDraftLoads.delete(key);
        loadedContextDraftThreads.delete(key);
        throw error;
      });
    contextDraftLoads.set(key, load);
    return load;
  };

  const scheduleContextDraftLoadRetry = (threadId) => {
    const key = String(threadId);
    if (disposed || contextDraftLoadRetryTimers.has(key)) return;
    const attempt = contextDraftLoadRetryAttempts.get(key) || 0;
    const delayMs = Math.min(500 * (2 ** Math.min(attempt, 4)), 5_000);
    contextDraftLoadRetryAttempts.set(key, attempt + 1);
    const timer = graphWindow.setTimeout(() => {
      contextDraftLoadRetryTimers.delete(key);
      if (disposed || String(getThread()?.id) !== key || loadedContextDraftThreads.has(key)) {
        contextDraftLoadRetryAttempts.delete(key);
        return;
      }
      void ensureContextDraftsLoaded(threadId).catch((error) => {
        if (!disposed && String(getThread()?.id) === key) {
          scheduleContextDraftLoadRetry(threadId);
        }
      });
    }, delayMs);
    contextDraftLoadRetryTimers.set(key, timer);
  };

  const $ = (selector) => root.querySelector(selector);
  const $$ = (selector) => [...root.querySelectorAll(selector)];

  const threadView = $("#threadView");
  if (!threadView) throw new Error("Product workspace requires a #threadView host.");
  threadView.innerHTML = productWorkspaceMarkup();
  const settingsControl = $("#conversationSettings");
  const settingsButton = $("#conversationSettingsButton");
  const settingsMenu = $("#conversationSettingsMenu");
  const exportButton = $("#exportConversation");
  const archiveButton = $("#archiveConversation");
  const archiveAvailable = mode === "interactive" && typeof onArchiveThread === "function";
  archiveButton.onclick = async () => {
    const thread = getThread();
    if (!thread || archiveButton.disabled) return;
    closeSettingsMenu();
    archiveButton.disabled = true;
    try { await onArchiveThread(thread.id, !thread.archivedAt); }
    catch (error) { toast(error.message); }
    finally { renderExportControl(); }
  };
  const shareAvailable = Boolean(
    shareApi
      && typeof shareApi?.account?.read === "function"
      && typeof shareApi?.account?.login === "function"
      && typeof shareApi?.share?.preflight === "function"
      && typeof shareApi?.share?.create === "function"
  );
  $("#shareConversation")?.classList.toggle("hidden", !shareAvailable);
  $("#shareConversationMenu")?.classList.toggle("hidden", !shareAvailable);
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
    (archiveAvailable ? archiveButton : shareAvailable ? $("#shareConversationMenu") : exportButton).focus();
  };
  const renderExportControl = (thread = getThread()) => {
    archiveButton.classList.toggle("hidden", !archiveAvailable);
    archiveButton.textContent = thread?.archivedAt ? "Unarchive" : "Archive";
    archiveButton.disabled = !thread || (!thread.archivedAt && (thread.archiveBlocked || ["running", "stopping", "needs_approval"].includes(thread.activity)));
    archiveButton.title = archiveButton.disabled ? "Available when work finishes." : "";
    $("#threadArchivedLabel").classList.toggle("hidden", !thread?.archivedAt);
    const available = capabilities.canExportConversation
      && typeof onExportConversation === "function";
    settingsControl.classList.toggle("hidden", !available && !shareAvailable && !archiveAvailable);
    exportButton.classList.toggle("hidden", !available);
    exportButton.disabled = !available || exportPending || thread?.id == null;
    settingsButton.disabled = (!available && !shareAvailable && !archiveAvailable) || exportPending;
    settingsButton.setAttribute("aria-busy", String(exportPending));
    exportButton.setAttribute("aria-busy", String(exportPending));
    exportButton.textContent = exportPending ? "Exporting…" : "Export conversation…";
    if (!available && !shareAvailable && !archiveAvailable) closeSettingsMenu();
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
  const shareController = shareAvailable ? createSharePublishController({
    root,
    getThread,
    getInteractions: () => getState()?.interactions ?? [],
    account: shareApi.account,
    share: shareApi.share,
    clipboard: shareApi.clipboard,
  }) : null;
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
  const readingLayout = createWorkspaceLayout(root, graphWindow);
  $("#openReadyResult").onclick = () => onOpenReadyResult();
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
    // Layer changes can hide and reopen details within one render, leaving no
    // net resize for ResizeObserver. Fit automatic cameras to the final pane
    // only after selectNode has passed its selection/draft-save guards.
    if (!wasOpen && cameraRevision === 0 && graphNodes.length > 0) {
      updateCamera(fitGraphCamera(graphNodes, graphStage.getBoundingClientRect()), false);
    }
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
  const closeInspector = async ({ restoreFocus = true } = {}) => {
    if (!await prepareNodeContextSelectionChange()) return false;
    clearInputStagesForThread(getThread()?.id);
    cancelInspectorFit();
    selection.selectedNodeId = null;
    selectedContextTarget = null;
    contextEditor = null;
    annotationSubject = null;
    annotationThreadId = null;
    resetAnnotationComposer();
    onSelectionChange(null);
    $("#inspector").classList.add("hidden");
    renderComposerContexts();
    releaseDetachedIcons();
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
    return true;
  };
  $("#closeInspector").onclick = () => { void closeInspector(); };
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
    void closeInspector();
  };
  graphDocument.addEventListener("keydown", closeInspectorOnEscape, true);
  const navigateHistory = async (direction) => {
    const history = getNavigationHistory() || {};
    const presentation = historyNavigationPresentation(history);
    if (presentation[direction].disabled) return;
    if (!await prepareNodeContextSelectionChange()) return;
    const beforeCommit = history[`${direction}ChangesTurn`] === true
      ? collapseContextPreviews
      : undefined;
    await onNavigateHistory(direction, { beforeCommit });
  };
  $("#historyBack").onclick = (event) => (
    activateHistoryControl(event.currentTarget, "back", navigateHistory)
  );
  $("#historyForward").onclick = (event) => (
    activateHistoryControl(event.currentTarget, "forward", navigateHistory)
  );
  $("#previousTurn").onclick = async () => {
    if (!await prepareNodeContextSelectionChange()) return;
    closeTurnPopover();
    collapseContextPreviews();
    onSelectTurn(-1);
  };
  $("#nextTurn").onclick = async () => {
    if (!await prepareNodeContextSelectionChange()) return;
    closeTurnPopover();
    collapseContextPreviews();
    onSelectTurn(1);
  };
  const closeContextPopover = ({ restoreFocus = false } = {}) => {
    contextPopoverOpen = false;
    $("#interactionContextPopover").classList.add("hidden");
    $("#interactionContextPill").setAttribute("aria-expanded", "false");
    if (restoreFocus) $("#interactionContextPill").focus();
  };
  const collapseContextPreviews = () => {
    openComposerContextKey = null;
    closeContextPopover();
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
    $("#detailIcon").dataset.family = "neutral";
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
  const fitInteractionGraphPopover = () => {
    const popover = $("#turnPopover");
    if (!turnPopoverOpen || !popover.classList.contains("interaction-graph-popover")) return;
    const banner = $("#interactionBanner").getBoundingClientRect();
    const picker = $("#turnPicker").getBoundingClientRect();
    popover.style.setProperty("--interaction-graph-available-width", `${Math.max(0, picker.right - banner.left - 1)}px`);
    const available = graphDocument.documentElement.clientHeight - popover.getBoundingClientRect().top - 12;
    popover.style.setProperty("--interaction-graph-available-height", `${Math.max(0, available)}px`);
  };
  // The banner changes size when the sidebar toggles or its text wraps.
  const interactionBannerObserver = graphDocument.defaultView.ResizeObserver
    ? new graphDocument.defaultView.ResizeObserver(fitInteractionGraphPopover)
    : null;
  interactionBannerObserver?.observe($("#interactionBanner"));
  graphDocument.defaultView.addEventListener("resize", fitInteractionGraphPopover);
  const openTurnPopover = () => {
    if ($("#turnPickerButton").disabled) return;
    turnPopoverOpen = true;
    $("#turnPopover").classList.remove("hidden");
    $("#turnPickerButton").setAttribute("aria-expanded", "true");
    fitInteractionGraphPopover();
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
  graphStage.onkeydown = async (event) => {
    if (!capabilities.canNavigate) return;
    const delta = graphTurnNavigationDelta(event, graphDocument.activeElement === graphStage);
    if (delta === null) return;
    event.preventDefault();
    const turnButton = delta < 0 ? $("#previousTurn") : $("#nextTurn");
    if (!turnButton.disabled) {
      if (!await prepareNodeContextSelectionChange()) return;
      collapseContextPreviews();
      onSelectTurn(delta);
    }
  };
  const localStagePoint = (event) => {
    const rect = graphStage.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const pointerDistance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

  // The node stays where it was dropped; the view fits the new layout.
  function fitAfterDrop() {
    if (!fitGraphAfterDrop || dragging) return;
    fitGraphAfterDrop = false;
    // An automatic fit, as graphCameraForView makes: camera revision 0.
    cameraRevision = 0;
    updateCamera(fitGraphCamera(graphNodes, graphStage.getBoundingClientRect()), false);
  }

  function updateCamera(nextCamera, manual = true) {
    camera = nextCamera;
    if (manual) {
      cancelInspectorFit();
      cameraRevision += 1;
    }
    drawGraph();
  }

  const automaticGraphFit = observeAutomaticGraphFitOnResize({
    graphStage,
    graphWindow,
    getCameraRevision: () => cameraRevision,
    getGraphNodes: () => graphNodes,
    hasActiveGesture: () => Boolean(dragging || panning || pinching),
    refit: () => updateCamera(fitGraphCamera(graphNodes, graphStage.getBoundingClientRect()), false),
  });

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
    automaticGraphFit.flush();
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
  const pendingStops = new Set();
  const stopErrors = new Map();
  const activeRun = () => {
    const thread = getThread();
    if (mode !== "interactive" || thread?.imported === true || getState().capabilities?.stopRuns !== true) return null;
    return productStopTarget(getState(), thread);
  };
  const contextDraftSendWarning = $("#contextDraftSendWarning");
  const cancelContextDraftSend = $("#cancelContextDraftSend");
  const confirmContextDraftSend = $("#confirmContextDraftSend");
  let sendAttempt = null;
  const inFlightSendThreads = new Map();
  // thread -> the scope and prompt revision of its submission in flight,
  // from the click on Send.
  const inFlightSubmissions = new Map();
  // thread -> the scope typed in since its Send was clicked, before the POST
  // wrote its send record; a newer turn may have moved the composer there.
  const sendEditScopes = new Map();
  // Text left in a turn's scope was sent once a later turn of the thread
  // carries it, as after a send that failed with a network or server error
  // (SCP-019) or one interrupted by a restart. It is neither carried into a
  // newer turn nor handed back.
  // How many of the thread's user turns after scopeKey's turn match.
  const laterUserTurnMatches = (threadId, scopeKey, matches) => {
    // A turn an invoke action created is not the user's follow-up.
    const invoked = new Set((getState().actionInvocations || [])
      .map((invocation) => String(invocation.resultInteractionId)));
    const turns = (getState().interactions || [])
      .filter((turn) => String(turn.threadId) === String(threadId));
    const from = turns.findIndex((turn) => composerDraftScopeKey(threadId, turn.id) === scopeKey);
    return from < 0 ? 0 : turns.slice(from + 1)
      .filter((turn) => !invoked.has(String(turn.id)) && matches(String(turn.text ?? ""))).length;
  };
  const sentByLaterTurn = (threadId, scopeKey, text) => Boolean(String(text ?? "").trim())
    && laterUserTurnMatches(threadId, scopeKey, (turnText) => turnText.trim() === String(text).trim()) > 0;
  // A thread's send whose turn has not loaded is persisted from when its POST
  // starts, so it outlives a restart: the scope its text is in now, the scope
  // it was sent from, a digest of the sent text, whether that scope's draft
  // was typed after Send, and how many Sends of that text from that scope
  // it waits for. Such a draft is kept until every one of those turns
  // loads, even when it repeats the sent text (SCP-018).
  const sentTurnLoaded = (threadId, record) => laterUserTurnMatches(
    threadId,
    record.originScopeKey,
    (turnText) => followupTextDigest(turnText) === record.textDigest,
  ) >= record.sends;
  const editedAfterSendScopeKey = (threadId) => {
    const record = sentThreadFollowup(threadId);
    return record?.edited ? record.scopeKey : null;
  };
  let sendWarningIntent = null;
  let failedConfirmationSends = new Map();
  const establishConfirmationReplayContextRevision = (threadId) => {
    const key = String(threadId);
    const replay = failedConfirmationSends.get(key);
    if (!replay || replay.contextRevision != null
      || String(getThread()?.id) !== key) return;
    failedConfirmationSends = settleConfirmationSendReplay(failedConfirmationSends, {
      threadId: key,
      intent: replay.intent,
      contextRevision: composerContextState.revision,
      preserve: true,
    });
  };
  let pickerInheritanceKey = null;
  let composerDraftScopeState = createComposerDraftScopeState();
  let composerPromptRevision = 0;
  let restoredDraftActive = false;
  // The latest turn's retry restoration, applied when the composer is empty.
  let pendingRestoration = null;
  let modelPicker;
  const replaceComposerContexts = (value) => {
    composerContextState = transitionComposerContextState(composerContextState, {
      type: "user_replace",
      value,
    });
  };
  const contextForTarget = (target) => composerContextState.value.find((context) => (
    interactionContextTargetKey(context.target) === interactionContextTargetKey(target)
  ));
  const contextStagingDisabled = () => {
    const status = composerStatusForThread(getState(), getThread());
    return sendAttemptBlocksThread(sendAttempt?.threadId, getThread()?.id)
      || threadHasInFlightSend(inFlightSendThreads, getThread()?.id)
      || contextStagingDisabledFor(
        status,
        capabilities.canCompose,
        prompt.disabled,
        restoredDraftActive,
      );
  };
  // An accepted node can be annotated while its completion continues. Only
  // the Send request itself freezes annotations into an immutable input.
  const annotationStagingDisabled = () => !capabilities.canCompose
    || sendAttemptBlocksThread(sendAttempt?.threadId, getThread()?.id)
    || threadHasInFlightSend(inFlightSendThreads, getThread()?.id);
  const closeDurableEditor = (ownerThreadId, draftId) => {
    if (contextEditor?.durable
      && contextEditor.ownerThreadId === String(ownerThreadId)
      && contextEditor.draftId === draftId) {
      contextEditor = null;
    }
  };
  const updateAttachContextControl = () => {
    const button = $("#attachNodeContext");
    const node = resolveInteractionContextNode(
      selection.selectedNodeId,
      getState().nodes,
      composerContextState.value,
      contextNodeOverrides,
    );
    const available = capabilities.canCompose
      && Boolean(contextDraftController)
      && Boolean(node);
    button.classList.toggle("hidden", !available);
    button.disabled = !available || annotationStagingDisabled();
  };
  const openContextEditor = (node, contextTarget = null) => {
    if (!node || !contextDraftController || annotationStagingDisabled() || contextEditor) return;
    const context = contextTarget ? contextForTarget(contextTarget) : null;
    const interaction = currentInteraction();
    const sourceTarget = interactionContextTargetForEditor({
      nodeId: node.id,
      contextTarget: context?.target,
      selectedContextTarget,
      sourceInteractionNodeId: interaction?.graphNodeId,
      sourceLayerId: currentLayerId(),
    });
    let durableDraft;
    try {
      durableDraft = contextDraftController.open(getThread()?.id, sourceTarget, {
        id: node.id,
        kind: node.kind,
        icon: node.icon,
        title: node.title,
        detail: node.detail,
        state: node.state || "accepted",
      });
    } catch (error) {
      toast(error.message);
      return;
    }
    openComposerContextKey = null;
    contextEditor = {
      ownerThreadId: String(getThread()?.id),
      nodeId: node.id,
      draftId: durableDraft?.id || null,
      target: durableDraft?.target || sourceTarget,
      annotationIndex: null,
      confirmation: null,
      value: durableDraft.text || "",
      attaching: !context,
      durable: true,
      error: restoredContextEditorError(String(getThread()?.id), durableDraft.id),
    };
    renderComposerContexts();
    $("#contextAnnotationEditor")?.focus();
  };
  const applyConfirmedContextDraft = (confirmation) => {
    replaceComposerContexts(applyContextEditor(
      composerContextState.value,
      {
        attaching: false,
        annotationIndex: null,
        value: confirmation.annotation,
        confirmation,
      },
      confirmation.targetNode,
      confirmation.target,
    ));
    openComposerContextKey = null;
  };
  const hydrateConfirmedComposerContexts = (threadId, expectedRevision = null) => {
    if (String(getThread()?.id) !== String(threadId)) return;
    const confirmations = contextDraftController.confirmationsForThread(threadId);
    replaceComposerContexts(expectedRevision != null
      && composerContextState.revision !== expectedRevision
      ? composerContextsMergedWithConfirmations(composerContextState.value, confirmations)
      : composerContextsFromConfirmations(confirmations));
    establishConfirmationReplayContextRevision(threadId);
    openComposerContextKey = null;
    renderComposerContexts();
  };
  const reconcileConfirmedComposerContexts = async (threadId, { reload = false } = {}) => {
    if (reload) {
      try {
        await contextDraftController.load(threadId);
      } catch {
        // Reconcile successful local dismissals even when the authoritative refresh fails.
      }
    }
    if (String(getThread()?.id) !== String(threadId)) return;
    replaceComposerContexts(composerContextsMergedWithConfirmations(
      composerContextState.value,
      contextDraftController.confirmationsForThread(threadId),
    ));
    renderComposerContexts();
  };
  function renderContextDraftStatus() {
    if (!contextEditor?.durable) return;
    const error = $(".node-context-dock-error");
    if (!error) return;
    const draft = contextDraftController.draftForNode(getThread()?.id, contextEditor.nodeId);
    if (draft) {
      contextEditor.draftId = draft.id;
      contextEditor.target = draft.target;
    }
    const textarea = $("#nodeContextDock #contextAnnotationEditor");
    if (draft?.editVersion === 0
      && textarea
      && (contextEditor.value !== draft.text || textarea.value !== draft.text)) {
      contextEditor.value = draft.text;
      textarea.value = draft.text;
      const confirm = textarea.parentElement?.querySelector('[aria-label="Confirm annotation"]');
      if (confirm) confirm.disabled = !String(draft.text).trim() || annotationStagingDisabled();
    }
    const resolving = Boolean(contextEditor.resolving)
      || ["confirming", "discarding", "reconciling"].includes(draft?.operation?.kind);
    const basePresentation = contextEditorPresentation(
      contextEditor,
      annotationStagingDisabled(),
      resolving,
    );
    const canContinueLocalEditing = capabilities.canCompose
      && contextEditor.ownerThreadId === String(getThread()?.id)
      && !resolving;
    const editorPresentation = {
      ...basePresentation,
      textareaDisabled: basePresentation.textareaDisabled && !canContinueLocalEditing,
    };
    syncMountedContextEditorControls(textarea, editorPresentation, contextEditor.value);
    const message = nodeContextDockError(contextEditor, draft);
    error.textContent = message;
    error.classList.toggle("hidden", !message);
  }

  function renderNodeContextDock() {
    const dock = $("#nodeContextDock");
    const threadId = String(getThread()?.id);
    const selectedNode = resolveInteractionContextNode(
      selection.selectedNodeId,
      getState().nodes,
      composerContextState.value,
      contextNodeOverrides,
    );
    const interaction = currentInteraction();
    const selectedTarget = selectedNode ? interactionContextTargetForEditor({
      nodeId: selectedNode.id,
      selectedContextTarget,
      sourceInteractionNodeId: interaction?.graphNodeId,
      sourceLayerId: currentLayerId(),
    }) : null;
    const selectedDraft = nodeContextDraftForSelection(
      selectedNode && contextDraftController
        ? contextDraftController.draftForNode(threadId, selectedNode.id)
        : null,
      selectedNode,
      selectedTarget,
    );
    if (!contextEditor && selectedDraft) {
      contextEditor = durableContextEditorForDraft(threadId, selectedNode, selectedDraft, {
        attaching: !contextForTarget(selectedDraft.target),
        error: restoredContextEditorError(threadId, selectedDraft.id),
      });
      adoptDraftOperation(contextEditor, threadId, selectedNode.id);
    }
    if (!contextEditor?.durable
      || !selectedNode
      || String(contextEditor.ownerThreadId) !== threadId
      || String(contextEditor.nodeId) !== String(selectedNode.id)
      || interactionContextTargetKey(contextEditor.target)
        !== interactionContextTargetKey(selectedTarget)
      || !selectedDraft) {
      if (contextEditor?.durable) contextEditor = null;
      dock.classList.add("hidden");
      dock.replaceChildren();
      return;
    }

    contextEditor.draftId = selectedDraft.id;
    contextEditor.target = selectedDraft.target;
    const identity = contextEditorIdentity(contextEditor);
    const existingTextarea = dock.querySelector("#contextAnnotationEditor");
    if (existingTextarea?.dataset.contextEditorIdentity === identity
      && existingTextarea.isConnected) {
      const active = graphDocument.activeElement === existingTextarea;
      const value = existingTextarea.value;
      const selectionStart = existingTextarea.selectionStart;
      const selectionEnd = existingTextarea.selectionEnd;
      const selectionDirection = existingTextarea.selectionDirection;
      const scrollTop = existingTextarea.scrollTop;
      const scrollLeft = existingTextarea.scrollLeft;
      contextEditor.value = value;
      const resolving = Boolean(contextEditor.resolving)
        || ["confirming", "discarding", "reconciling"].includes(
          selectedDraft.operation?.kind,
        );
      const presentation = contextEditorPresentation(
        contextEditor,
        annotationStagingDisabled(),
        resolving,
      );
      const canContinueLocalEditing = capabilities.canCompose && !resolving;
      syncMountedContextEditorControls(existingTextarea, {
        ...presentation,
        textareaDisabled: presentation.textareaDisabled && !canContinueLocalEditing,
      }, value);
      const error = dock.querySelector(".node-context-dock-error");
      const message = nodeContextDockError(contextEditor, selectedDraft);
      error.textContent = message;
      error.classList.toggle("hidden", !message);
      existingTextarea.value = value;
      if (!existingTextarea.disabled) {
        existingTextarea.setSelectionRange(
          selectionStart,
          selectionEnd,
          selectionDirection || "none",
        );
        existingTextarea.scrollTop = scrollTop;
        existingTextarea.scrollLeft = scrollLeft;
        if (active) existingTextarea.focus({ preventScroll: true });
      }
      dock.classList.remove("hidden");
      return;
    }

    const resolving = Boolean(contextEditor.resolving)
      || ["confirming", "discarding"].includes(selectedDraft.operation?.kind);
    const presentation = contextEditorPresentation(
      contextEditor,
      annotationStagingDisabled(),
      resolving,
    );
    const textarea = graphDocument.createElement("textarea");
    textarea.id = "contextAnnotationEditor";
    textarea.rows = 4;
    textarea.placeholder = "Add an annotation…";
    textarea.setAttribute("aria-label", `Annotation for ${selectedNode.title}`);
    textarea.dataset.contextEditorIdentity = identity;
    textarea.value = contextEditor.value;
    textarea.disabled = presentation.textareaDisabled;

    const error = graphDocument.createElement("p");
    error.className = "node-context-dock-error";
    error.setAttribute("role", "alert");
    const errorMessage = nodeContextDockError(contextEditor, selectedDraft);
    error.textContent = errorMessage;
    error.classList.toggle("hidden", !errorMessage);

    const actions = graphDocument.createElement("div");
    actions.className = "node-context-dock-actions";

    const discard = graphDocument.createElement("button");
    discard.type = "button";
    discard.textContent = "×";
    discard.title = "Discard draft";
    discard.setAttribute("aria-label", `Discard annotation draft for ${selectedNode.title}`);
    discard.disabled = presentation.controlsDisabled;
    discard.onclick = async () => {
      if (annotationStagingDisabled()) return;
      const discardingEditor = contextEditor;
      const endResolution = beginEditorResolution(discardingEditor);
      try {
        clearContextEditorError(discardingEditor);
        renderNodeContextDock();
        await trackDraftOperation(threadId, selectedNode.id,
          contextDraftController.discard(threadId, selectedNode.id));
        clearContextEditorError(discardingEditor);
        closeDurableEditor(threadId, discardingEditor.draftId);
      } catch (discardError) {
        rememberContextEditorError(discardingEditor, discardError.message);
      } finally {
        endResolution();
      }
      renderComposerContexts();
    };

    const confirm = graphDocument.createElement("button");
    confirm.type = "button";
    confirm.textContent = "✓";
    confirm.title = "Confirm";
    confirm.setAttribute("aria-label", "Confirm annotation");
    confirm.disabled = presentation.confirmDisabled || !String(contextEditor.value).trim();
    let focusComposerAfterConfirmation = false;
    bindComposerKeydown(textarea, () => {
      if (confirm.disabled) return;
      focusComposerAfterConfirmation = true;
      confirm.click();
    });
    confirm.onclick = async () => {
      if (annotationStagingDisabled()) return;
      const confirmingEditor = contextEditor;
      const keyboardConfirmation = focusComposerAfterConfirmation;
      focusComposerAfterConfirmation = false;
      const endResolution = beginEditorResolution(confirmingEditor);
      try {
        clearContextEditorError(confirmingEditor);
        renderNodeContextDock();
        const confirmation = await trackDraftOperation(threadId, selectedNode.id,
          contextDraftController.confirm(threadId, selectedNode.id));
        if (!confirmation) {
          rememberContextEditorError(
            confirmingEditor,
            "This annotation could not be confirmed. Retry after it is saved.",
          );
        } else {
          clearContextEditorError(confirmingEditor);
          if (contextConfirmationDestination(getThread()?.id, threadId) === "current") {
            applyConfirmedContextDraft(confirmation);
            closeDurableEditor(threadId, confirmingEditor.draftId);
            // Chromium blurs a textarea when confirmation disables it. Keep keyboard
            // focus unless the user moved to another control while the request ran.
            if (keyboardConfirmation && (
              graphDocument.activeElement === textarea || graphDocument.activeElement === graphDocument.body
            )) {
              $("#threadPrompt").focus({ preventScroll: true });
            }
          }
        }
      } catch (confirmError) {
        rememberContextEditorError(confirmingEditor, confirmError.message);
      } finally {
        endResolution();
      }
      renderComposerContexts();
      if (keyboardConfirmation && contextEditor === confirmingEditor
        && textarea.isConnected && !textarea.disabled
        && graphDocument.activeElement === graphDocument.body) {
        textarea.focus({ preventScroll: true });
      }
    };

    textarea.oninput = () => {
      clearContextEditorError(contextEditor);
      if (!applyMountedContextEditorInput({
        editor: contextEditor,
        textarea,
        controller: contextDraftController,
        threadId,
        nodeId: selectedNode.id,
      })) return;
      confirm.disabled = contextEditorPresentation(
        contextEditor,
        annotationStagingDisabled(),
      ).confirmDisabled || !textarea.value.trim();
    };

    actions.append(discard, confirm);
    dock.replaceChildren(textarea, error, actions);
    dock.classList.remove("hidden");
  }
  function renderComposerContexts() {
    const tray = $("#composerContextTray");
    const thread = getThread();
    if (!thread) {
      tray.replaceChildren();
      tray.classList.add("hidden");
      return;
    }
    const parts = [];
    if (
      contextEditor
      && contextEditor.ownerThreadId !== String(thread.id)
    ) {
      contextEditor = null;
    }
    const liveDurableDraft = contextEditor?.durable
      ? contextDraftController.draftForNode(contextEditor.ownerThreadId, contextEditor.nodeId)
      : null;
    if (liveDurableDraft) {
      contextEditor.draftId = liveDurableDraft.id;
      contextEditor.target = liveDurableDraft.target;
    }
    const openContext = composerContextState.value.find((context) => (
      interactionContextTargetKey(context.target) === openComposerContextKey
    ));
    if (!openContext) openComposerContextKey = null;

    if (openContext) {
      const preview = graphDocument.createElement("section");
      preview.className = "composer-context-preview";
      preview.setAttribute("aria-live", "polite");
      preview.setAttribute("aria-label", `${openContext.node.title} annotations`);
      const heading = graphDocument.createElement("div");
      heading.className = "composer-context-preview-heading";
      const nodeButton = graphDocument.createElement("button");
      nodeButton.type = "button";
      nodeButton.className = "composer-context-node";
      nodeButton.append(createRelayerIcon(
        openContext.node.icon || openContext.node.metadata?.relayer?.icon, {}, openContext.node, iconSourceContext(openContext.target),
      ));
      const title = graphDocument.createElement("strong");
      title.textContent = openContext.node.title;
      nodeButton.append(title);
      nodeButton.setAttribute("aria-label", `Open ${openContext.node.title} details`);
      nodeButton.onclick = () => {
        void selectNode(getState(), openContext.node.id, {
          contextTarget: openContext.target,
        });
      };
      const close = graphDocument.createElement("button");
      close.type = "button";
      close.className = "context-symbol-button";
      close.textContent = "×";
      close.title = "Close annotations";
      close.setAttribute("aria-label", `Close ${openContext.node.title} annotations`);
      close.onclick = () => {
        if (contextEditor) return;
        openComposerContextKey = null;
        renderComposerContexts();
      };
      close.disabled = Boolean(contextEditor);
      heading.append(nodeButton, close);

      const list = graphDocument.createElement("ol");
      list.className = "composer-context-annotations";
      openContext.annotations.forEach((annotation, index) => {
        const item = graphDocument.createElement("li");
        const text = graphDocument.createElement("span");
        text.textContent = artifactNoteLabel(annotation);
        const remove = graphDocument.createElement("button");
        remove.type = "button";
        remove.className = "context-symbol-button";
        remove.textContent = "🗑";
        remove.title = "Delete annotation";
        remove.setAttribute(
          "aria-label",
          `Delete annotation ${index + 1} for ${openContext.node.title}`,
        );
        remove.onclick = async () => {
          if (contextStagingDisabled() || contextEditor) return;
          const confirmation = openContext.annotationConfirmations?.[index];
          if (confirmation) {
            const removingThreadId = String(getThread()?.id);
            const removingRevision = composerContextState.revision;
            try {
              await contextDraftController.dismissConfirmations(
                removingThreadId,
                [confirmation.draftId],
              );
            } catch (error) {
              await reconcileConfirmedComposerContexts(removingThreadId, { reload: true });
              toast(error.message);
              return;
            }
            if (String(getThread()?.id) !== removingThreadId) return;
            if (composerContextState.revision !== removingRevision) {
              await reconcileConfirmedComposerContexts(removingThreadId);
              return;
            }
          }
          replaceComposerContexts(removeContextAnnotation(
            composerContextState.value,
            openContext.target,
            index,
          ));
          renderComposerContexts();
        };
        remove.disabled = contextStagingDisabled() || Boolean(contextEditor);
        item.append(text, remove);
        list.append(item);
      });
      preview.append(heading, list);
      parts.push(preview);
    }

    if (composerContextState.value.length) {
      const pills = graphDocument.createElement("div");
      pills.className = "composer-context-pills";
      pills.setAttribute("aria-label", "Attached node context");
      composerContextState.value.forEach((context) => {
        const wrap = graphDocument.createElement("div");
        wrap.className = "composer-context-pill-wrap";
        const pill = graphDocument.createElement("button");
        pill.type = "button";
        pill.className = "composer-context-pill";
        pill.setAttribute(
          "aria-expanded",
          String(openComposerContextKey === interactionContextTargetKey(context.target)),
        );
        pill.setAttribute("aria-label", `Show ${context.node.title} annotations`);
        pill.append(createRelayerIcon(context.node.icon || context.node.metadata?.relayer?.icon, {}, context.node, iconSourceContext(context.target)));
        const title = graphDocument.createElement("strong");
        title.textContent = context.node.title;
        const count = graphDocument.createElement("span");
        count.textContent = contextAnnotationCountLabel(context.annotations.length);
        const chevron = graphDocument.createElement("span");
        chevron.textContent = "⌄";
        chevron.setAttribute("aria-hidden", "true");
        pill.append(title, count, chevron);
        pill.onclick = () => {
          if (contextEditor) return;
          openComposerInputKey = null;
          const contextKey = interactionContextTargetKey(context.target);
          openComposerContextKey = openComposerContextKey === contextKey
            ? null
            : contextKey;
          renderComposerContexts();
        };
        pill.disabled = Boolean(contextEditor);
        const detach = graphDocument.createElement("button");
        detach.type = "button";
        detach.className = "composer-context-pill-remove";
        detach.textContent = "×";
        detach.title = "Detach node";
        detach.setAttribute("aria-label", `Detach ${context.node.title}`);
        detach.onclick = async () => {
          if (contextStagingDisabled() || contextEditor) return;
          if (contextDetachNeedsConfirmation(context)
            && !graphWindow.confirm(`Detach ${context.node.title} and its annotations?`)) return;
          const confirmationIds = (context.annotationConfirmations || [])
            .filter(Boolean)
            .map((confirmation) => confirmation.draftId);
          if (confirmationIds.length) {
            const detachingThreadId = String(getThread()?.id);
            const detachingRevision = composerContextState.revision;
            try {
              await contextDraftController.dismissConfirmations(
                detachingThreadId,
                confirmationIds,
              );
            } catch (error) {
              await reconcileConfirmedComposerContexts(detachingThreadId, { reload: true });
              toast(error.message);
              return;
            }
            if (String(getThread()?.id) !== detachingThreadId) return;
            if (composerContextState.revision !== detachingRevision) {
              await reconcileConfirmedComposerContexts(detachingThreadId);
              return;
            }
          }
          replaceComposerContexts(
            composerContextState.value.filter((candidate) => candidate !== context),
          );
          if (openComposerContextKey === interactionContextTargetKey(context.target)) {
            openComposerContextKey = null;
          }
          renderComposerContexts();
        };
        detach.disabled = contextStagingDisabled() || Boolean(contextEditor);
        wrap.append(pill, detach);
        pills.append(wrap);
      });
      parts.push(pills);
    }

    const inputDraft = inputDraftController?.current(thread?.id);
    const inputAttachments = (inputDraft?.attachments || []).filter(attachment => isComposerInputOccurrence(attachment.occurrence));
    const openInput = inputAttachments.find((attachment) => (
      inputOccurrenceKey(attachment.occurrence) === openComposerInputKey
    ));
    if (!openInput) openComposerInputKey = null;
    if (openInput) {
      const preview = graphDocument.createElement("section");
      preview.className = "composer-context-preview composer-input-preview";
      preview.setAttribute("aria-live", "polite");
      const heading = graphDocument.createElement("div");
      heading.className = "composer-context-preview-heading";
      const title = graphDocument.createElement("strong");
      title.textContent = openInput.action.prompt;
      const close = graphDocument.createElement("button");
      close.type = "button";
      close.className = "context-symbol-button";
      close.textContent = "×";
      close.title = "Close input details";
      close.setAttribute("aria-label", `Close ${openInput.action.prompt} input details`);
      close.onclick = () => {
        openComposerInputKey = null;
        renderComposerContexts();
      };
      heading.append(title, close);
      const value = graphDocument.createElement("p");
      value.textContent = summarizeInputStage(
        openInput.action,
        initialInputStageValue(openInput.action, openInput),
      );
      preview.append(heading, value);
      parts.push(preview);
    }
    if (inputAttachments.length) {
      const pills = graphDocument.createElement("div");
      pills.className = "composer-context-pills composer-input-pills";
      pills.setAttribute("aria-label", "Committed node inputs");
      inputAttachments.forEach((attachment) => {
        const occurrenceKey = inputOccurrenceKey(attachment.occurrence);
        const stageKey = threadInputOccurrenceKey(thread.id, attachment.occurrence);
        const wrap = graphDocument.createElement("div");
        wrap.className = "composer-context-pill-wrap";
        const pill = graphDocument.createElement("button");
        pill.type = "button";
        pill.className = "composer-context-pill composer-input-pill";
        pill.setAttribute("aria-expanded", String(openComposerInputKey === occurrenceKey));
        pill.setAttribute("aria-label", `Inspect ${attachment.action.prompt}`);
        const title = graphDocument.createElement("strong");
        title.textContent = attachment.action.prompt;
        const summary = graphDocument.createElement("span");
        summary.textContent = summarizeInputStage(
          attachment.action,
          initialInputStageValue(attachment.action, attachment),
        );
        pill.append(title, summary);
        pill.onclick = () => {
          openComposerContextKey = null;
          openComposerInputKey = openComposerInputKey === occurrenceKey ? null : occurrenceKey;
          renderComposerContexts();
        };
        const detach = graphDocument.createElement("button");
        detach.type = "button";
        detach.className = "composer-context-pill-remove";
        detach.textContent = "×";
        detach.title = "Detach input";
        detach.setAttribute("aria-label", `Detach ${attachment.action.prompt}`);
        detach.disabled = contextStagingDisabled() || inputPending.has(stageKey);
        detach.onclick = async () => {
          // Checked at the click: a Send that began after this pill rendered
          // locks the committed inputs it reserves.
          if (detach.disabled || contextStagingDisabled() || inputPending.has(stageKey)) return;
          beginNodeInputMutation({
            inputPending,
            stageKey,
            repaintNodeInputs: () => {
              if (selection.selectedNodeId != null) {
                void selectNode(getState(), selection.selectedNodeId, { notify: false });
              }
            },
            renderComposer: renderComposerContexts,
          });
          try {
            await inputDraftController.detach(thread.id, attachment.occurrence);
            const detachedInputKey = authoredInputKey(attachment.occurrence);
            failedAuthoredInputs.get(String(thread.id))?.delete(detachedInputKey);
            for (const [refusalKey, inputKey] of refusedInputOccurrences) {
              if (inputKey !== detachedInputKey) continue;
              failedAuthoredInputs.get(String(thread.id))?.delete(refusalKey);
              refusedInputOccurrences.delete(refusalKey);
            }
            authoredInputErrors.delete(`${thread.id}\u0000${authoredInputKey(attachment.occurrence)}`);
            markInputCompositionChanged(thread.id);
            inputStages.delete(stageKey);
            inputErrors.delete(stageKey);
            inputTouched.delete(stageKey);
            if (openComposerInputKey === occurrenceKey) openComposerInputKey = null;
          } catch (error) {
            inputErrors.set(stageKey, error?.message || "Input could not be detached.");
            toast(error?.message || "Input could not be detached.");
          } finally {
            inputPending.end(stageKey);
            renderComposerContexts();
            if (selection.selectedNodeId != null) {
              void selectNode(getState(), selection.selectedNodeId, { notify: false });
            }
          }
        };
        wrap.append(pill, detach);
        pills.append(wrap);
      });
      parts.push(pills);
    }

    tray.replaceChildren(...parts);
    tray.classList.toggle("hidden", parts.length === 0);
    renderNodeContextDock();
    syncComposer();
  }
  const syncComposer = () => {
    resizeComposerTextarea(prompt);
    const thread = getThread();
    if (!thread) {
      send.disabled = true;
      const tray = $("#composerContextTray");
      tray.replaceChildren();
      tray.classList.add("hidden");
      return;
    }
    const run = activeRun();
    const stopping = run && (pendingStops.has(run.id) || (run.stopRequested && !run.stopError));
    send.classList.toggle("stop-button", Boolean(run));
    send.classList.toggle("is-stopping", Boolean(stopping));
    send.textContent = run ? "" : "↑";
    send.setAttribute("aria-busy", String(Boolean(stopping)));
    send.setAttribute("aria-label", run ? (stopping ? "Stopping" : "Stop run") : "Send");
    if (run) {
      send.disabled = Boolean(stopping);
      send.title = stopping ? "Waiting for the run to stop" : "Stop this run";
      const message = $("#composerRetryMessage");
      const error = stopErrors.get(run.id) || run.stopError;
      if (error) { message.textContent = error; message.classList.remove("hidden"); }
      return;
    }
    const contextDraftsReady = !contextDraftController
      || loadedContextDraftThreads.has(String(thread.id));
    const inputThreadId = String(thread.id);
    const inputDraftsReady = !implicitInvokeBoundaries.has(inputThreadId) && (!inputDraftController
      || (loadedInputDraftThreads.has(inputThreadId) && !inputDraftLoads.has(inputThreadId)));
    const committedInputs = (inputDraftController?.current(thread.id)?.attachments || []).filter(attachment => isComposerInputOccurrence(attachment.occurrence));
    // An answer still committing counts: Send waits for it (and stops if it fails).
    const pendingImplicitInputs = implicitInputAcceptance && [...implicitInputEntries].some(([key, entry]) =>
      inputKeyBelongsToThread(key, thread.id) && inputTouched.has(key)
        && isComposerInputOccurrence(entry.occurrence)
        && !validateInputStage(entry.semantic, inputStages.get(key)));
    const inputAttachments = pendingAuthoredInputCommits(thread.id) || pendingImplicitInputs
      ? [...committedInputs, { pending: true }]
      : committedInputs;
    // Send waits for a commit in flight; a detach in flight disables it.
    const pendingInputDetaches = [...inputPending].filter((key) => !committingInputStages.has(key));
    const failedConfirmationSend = failedConfirmationSends.get(String(thread.id));
    const replayIntent = confirmationSendReplayIntent({
      intent: failedConfirmationSend?.intent,
      threadId: thread.id,
      draftScopeKey: composerDraftScopeState.activeScopeKey,
      promptRevision: composerPromptRevision,
      contextRevision: composerContextState.revision,
      replayContextRevision: failedConfirmationSend?.contextRevision,
      modelSelection: pickerSelectionPayload(modelPicker?.getSelection())?.modelSelection,
      inputDraftRevision: currentInputDraftRevision(thread.id),
      inputCompositionRevision: currentInputCompositionRevision(thread.id),
    });
    const replayReady = replayIntent
      && !prompt.disabled
      && (modelPicker?.isReady() ?? false)
      && !contextEditor;
    send.disabled = Boolean(thread.archivedAt) || threadHasInFlightSend(inFlightSendThreads, thread.id)
      || threadHasPendingInputMutation(pendingInputDetaches, thread.id)
      || !contextDraftsReady || !inputDraftsReady || (!replayReady && !composerSubmissionReady(
      prompt.value,
      prompt.disabled,
      modelPicker?.isReady() ?? false,
      composerContextState.value,
      Boolean(contextEditor),
      inputAttachments,
    ));
    send.title = composerSendTitle({
      ready: modelPicker?.isReady() ?? false,
      modelSetup: modelPicker?.modelSetup() ?? null,
      readyTitle: "Send",
    });
    if (thread.archivedAt) send.title = "Unarchive this chat before sending.";
  };
  const releaseSendAttempt = () => {
    sendAttempt = null;
    send.removeAttribute("aria-busy");
    confirmContextDraftSend.disabled = false;
    syncComposer();
    if (selection.selectedNodeId != null) {
      void selectNode(getState(), selection.selectedNodeId, { notify: false });
    }
  };
  const cancelSendAttempt = () => {
    releaseInFlightSend(inFlightSendThreads, sendAttempt);
    releaseSendAttempt();
  };
  const closeContextDraftSendWarning = ({ focusSend = true, cancelAttempt = true } = {}) => {
    const cancelled = cancelAttempt ? sendWarningIntent : null;
    sendWarningIntent = null;
    if (cancelAttempt) cancelSendAttempt();
    // A cancelled Send hands back text a newer turn left in its scope.
    if (cancelled?.submission) {
      restoreStrandedSubmission(cancelled.submission);
      syncComposer();
    }
    if (contextDraftSendWarning.open) contextDraftSendWarning.close();
    if (focusSend) send.focus({ preventScroll: true });
  };
  const positionContextDraftSendWarning = () => {
    const window = graphDocument.defaultView;
    const sendBounds = send.getBoundingClientRect();
    contextDraftSendWarning.style.setProperty(
      "--context-draft-send-warning-right",
      `${Math.max(12, window.innerWidth - sendBounds.right)}px`,
    );
    const anchoredBottom = Math.max(64, window.innerHeight - sendBounds.top + 8);
    contextDraftSendWarning.style.setProperty(
      "--context-draft-send-warning-bottom",
      `${anchoredBottom}px`,
    );
    if (contextDraftSendWarning.open) {
      const dialogHeight = contextDraftSendWarning.getBoundingClientRect().height;
      const fittedBottom = Math.max(12, window.innerHeight - dialogHeight - 12);
      contextDraftSendWarning.style.setProperty(
        "--context-draft-send-warning-bottom",
        `${Math.min(anchoredBottom, fittedBottom)}px`,
      );
    }
  };
  const openContextDraftSendWarning = (drafts, intent) => {
    const presentation = contextDraftSendWarningPresentation(drafts);
    const list = $("#contextDraftSendWarningList");
    list.replaceChildren(...presentation.items.map((item) => {
      const row = graphDocument.createElement("li");
      const marker = graphDocument.createElement("span");
      marker.setAttribute("aria-hidden", "true");
      marker.textContent = "⌘";
      const title = graphDocument.createElement("strong");
      title.textContent = item.title;
      row.append(marker, title);
      return row;
    }));
    $("#contextDraftSendWarningCount").textContent = presentation.countLabel;
    list.setAttribute("aria-label", presentation.countLabel);
    sendWarningIntent = intent;
    positionContextDraftSendWarning();
    contextDraftSendWarning.showModal();
    positionContextDraftSendWarning();
    cancelContextDraftSend.focus({ preventScroll: true });
  };
  const repositionContextDraftSendWarning = () => {
    if (contextDraftSendWarning.open) positionContextDraftSendWarning();
  };
  graphDocument.defaultView.addEventListener("resize", repositionContextDraftSendWarning);
  contextDraftSendWarning.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeContextDraftSendWarning();
  });
  cancelContextDraftSend.onclick = () => closeContextDraftSendWarning();

  // A send that fails after its thread's newer turn arrived leaves its text
  // in the older turn's scope; bring it back into the empty prompt. Text the
  // user typed since wins, and the older text is retired, so it cannot be
  // carried forward later (SCP-021).
  const restoreStrandedSubmission = (submission) => {
    const { activeScopeKey } = composerDraftScopeState;
    const shown = String(getThread()?.id) === String(submission.threadId);
    if (shown && activeScopeKey === submission.scopeKey) return;
    const stored = composerDraftScopeState.drafts.get(submission.scopeKey);
    const stranded = stored?.promptValue;
    if (!stranded) return;
    if (sentByLaterTurn(submission.threadId, submission.scopeKey, stranded)) return;
    // While another thread is shown, the send's thread's newest scope
    // decides: newer text there supersedes the stranded text, and an empty
    // one carries it forward when the thread is shown again.
    const newestTurn = shown ? null : humanTurns(getState(), { id: submission.threadId }).at(-1);
    const newestScopeKey = newestTurn ? composerDraftScopeKey(submission.threadId, newestTurn.id) : null;
    if (!shown && (!newestScopeKey || newestScopeKey === submission.scopeKey
      || !(threadFollowupDraft(newestScopeKey) ?? composerDraftScopeState.drafts.get(newestScopeKey)?.promptValue))) {
      return;
    }
    const drafts = new Map(composerDraftScopeState.drafts);
    drafts.delete(submission.scopeKey);
    composerDraftScopeState = { activeScopeKey, drafts };
    clearThreadFollowupDraft(submission.scopeKey);
    if (!shown || prompt.value) return;
    prompt.value = stranded;
    composerPromptRevision += 1;
    persistThreadFollowupDraft(activeScopeKey, stranded);
  };

  const submitInteraction = async (intent) => {
    const submittedThreadId = intent.threadId;
    const submittedContexts = intent.contexts;
    const submittedConfirmationIds = intent.contextConfirmationIds;
    const submission = intent.submission;
    const inFlightSubmission = Object.freeze({
      scopeKey: submission.scopeKey,
      promptRevision: submission.prompt.revision,
    });
    inFlightSubmissions.set(String(submittedThreadId), inFlightSubmission);
    const sentRecord = String(submission.prompt.value).trim()
      ? {
        scopeKey: submission.scopeKey,
        originScopeKey: submission.scopeKey,
        textDigest: followupTextDigest(submission.prompt.value),
      }
      : null;
    if (sentRecord) {
      // An edit made while Send waited for input commits already counts, in
      // the scope it was made in.
      const editScopeKey = sendEditScopes.get(String(submittedThreadId));
      const scopeRevision = composerDraftScopeState.activeScopeKey === submission.scopeKey
        ? composerPromptRevision
        : composerDraftScopeState.drafts.get(submission.scopeKey)?.promptRevision;
      // An earlier Send of the same text from the same scope whose turn has
      // not loaded is still waited for, so the first of those turns does not
      // end this one's protection.
      const earlier = sentThreadFollowup(submittedThreadId);
      const earlierSends = earlier?.originScopeKey === sentRecord.originScopeKey
        && earlier.textDigest === sentRecord.textDigest ? earlier.sends : 0;
      persistSentThreadFollowup(submittedThreadId, {
        ...sentRecord,
        sends: earlierSends + 1,
        scopeKey: editScopeKey ?? submission.scopeKey,
        edited: editScopeKey != null
          || (scopeRevision !== undefined && scopeRevision !== submission.prompt.revision),
      });
    }
    const ownsSentRecord = () => {
      const record = sentThreadFollowup(submittedThreadId);
      return Boolean(sentRecord) && record?.originScopeKey === sentRecord.originScopeKey
        && record.textDigest === sentRecord.textDigest;
    };
    // The prompt stays editable while the send is pending (SCP-019); Send
    // stays disabled, so one follow-up is in flight per thread.
    send.disabled = true;
    for (const control of $("#nodeInputActions").querySelectorAll("button, textarea")) {
      control.disabled = true;
    }
    renderComposerContexts();
    updateAttachContextControl();
    try {
      await onSubmitInteraction(
        intent.text,
        intent.modelSelection,
        intent.contextPayload,
        submittedConfirmationIds,
        intent.inputDraftRevision,
        currentInputDraftRevision(submittedThreadId),
      );
      if (inputDraftController) {
        try {
          await ensureInputDraftLoaded(submittedThreadId, { reload: true });
          if (implicitInputAcceptance) clearSubmittedImplicitStages(implicitSendSnapshots.get(String(submittedThreadId)));
          else clearInputStagesForThread(submittedThreadId);
          openComposerInputKey = null;
        } catch (refreshError) {
          toast(`Sent, but committed inputs could not be refreshed: ${refreshError.message}`);
        }
      }
      const failedConfirmationSend = failedConfirmationSends.get(String(submittedThreadId));
      if (failedConfirmationSend?.intent === intent) {
        failedConfirmationSends = settleConfirmationSendReplay(failedConfirmationSends, {
          threadId: submittedThreadId,
          intent,
          contextRevision: null,
          preserve: false,
        });
      }
      contextDraftController?.consumeConfirmations(
        submittedThreadId,
        submittedConfirmationIds,
      );
      const currentComposer = {
        threadId: getThread()?.id,
        scopeKey: composerDraftScopeState.activeScopeKey,
        prompt: { value: prompt.value, revision: composerPromptRevision },
        contexts: {
          value: composerContextState.value,
          revision: composerContextState.revision,
        },
      };
      const settlement = settleComposerSubmission({
        submission,
        outcome: "succeeded",
        current: currentComposer,
      });
      const clearedDraftScopeState = clearSubmittedComposerDraft(
        composerDraftScopeState,
        settlement.submittedScopeKey,
        submission.prompt.revision,
        composerPromptRevision,
      );
      if (clearedDraftScopeState !== composerDraftScopeState) {
        clearThreadFollowupDraft(settlement.submittedScopeKey);
      }
      composerDraftScopeState = clearedDraftScopeState;
      if (settlement.current.prompt !== currentComposer.prompt) {
        prompt.value = settlement.current.prompt.value;
        composerPromptRevision = settlement.current.prompt.revision;
      }
      if (submittedConfirmationIds.length
        && String(getThread()?.id) === String(submittedThreadId)) {
        composerContextState = transitionComposerContextState(composerContextState, {
          type: "settlement",
          field: settledComposerContextsWithConfirmations(
            settlement.current.contexts,
            contextDraftController.confirmationsForThread(submittedThreadId),
          ),
        });
        if (composerContextState.value.length === 0) {
          contextEditor = null;
          openComposerContextKey = null;
        }
        renderComposerContexts();
      } else if (settlement.current.contexts !== currentComposer.contexts) {
        composerContextState = transitionComposerContextState(composerContextState, {
          type: "settlement",
          field: settlement.current.contexts,
        });
        if (composerContextState.value.length === 0) {
          contextEditor = null;
          openComposerContextKey = null;
        }
        renderComposerContexts();
      }
    } catch (error) {
      if (inputDraftController) {
        void ensureInputDraftLoaded(submittedThreadId, { reload: true }).catch(() => {});
      }
      const preserveReplay = (submittedConfirmationIds.length || intent.inputDraftRevision != null)
        && confirmationSendFailureMayHaveCommitted(error);
      if (submittedConfirmationIds.length && contextDraftController) {
        try {
          const refreshed = await refreshComposerContextsAfterFailedConfirmationSend({
            controller: contextDraftController,
            threadId: submittedThreadId,
            currentContextState: () => composerContextState,
          });
          if (String(getThread()?.id) === String(submittedThreadId)
            && composerContextState.value === refreshed.sourceValue
            && composerContextState.revision === refreshed.sourceRevision
            && refreshed.changed) {
            replaceComposerContexts(refreshed.value);
            if (composerContextState.value.length === 0) {
              contextEditor = null;
              openComposerContextKey = null;
            }
            renderComposerContexts();
          }
        } catch {
          // Preserve the exact local composition when authority cannot be refreshed.
        }
      }
      failedConfirmationSends = settleConfirmationSendReplay(failedConfirmationSends, {
        threadId: submittedThreadId,
        intent,
        contextRevision: preserveReplay
          && String(getThread()?.id) === String(submittedThreadId)
          ? composerContextState.revision
          : null,
        preserve: preserveReplay,
      });
      // Only a definite rejection: after a network or server error the send
      // may have committed, and the newer turn may be this very submission.
      // A send that may have gone through is handed back too: an unrelated
      // newer turn carries its text forward, and its own turn, once it
      // arrives, shows it was sent (SCP-019).
      restoreStrandedSubmission(submission);
      // A definite rejection creates no turn to wait for.
      if (!confirmationSendFailureMayHaveCommitted(error) && ownsSentRecord()) {
        const record = sentThreadFollowup(submittedThreadId);
        persistSentThreadFollowup(submittedThreadId, record.sends > 1 ? { ...record, sends: record.sends - 1 } : null);
      }
      toast(error.message);
    } finally {
      if (inFlightSubmissions.get(String(submittedThreadId)) === inFlightSubmission) {
        inFlightSubmissions.delete(String(submittedThreadId));
      }
      prompt.disabled = composerDisabledForState(
        getState().status,
        capabilities.canCompose,
        restoredDraftActive,
      );
      renderComposerContexts();
      if (selection.selectedNodeId != null) {
        void selectNode(getState(), selection.selectedNodeId, { notify: false });
      }
      updateAttachContextControl();
      syncComposer();
    }
  };
  const requestInteractionSend = async ({ draftOverride = false } = {}) => {
    if (!draftOverride && (send.disabled || contextDraftSendWarning.open)) return;
    if (draftOverride && (
      !contextDraftSendWarning.open
      || !sendIntentIsCurrentThread(getThread()?.id, sendWarningIntent?.threadId)
    )) return;
    const threadId = getThread()?.id;
    if (implicitInvokeBoundaries.has(String(threadId))) return;
    if (threadHasInFlightSend(inFlightSendThreads, threadId)
      || sendAttemptBlocksThread(sendAttempt?.threadId, threadId)) return;
    const implicitSnapshot = captureImplicitInputs(threadId, { composerOnly: true });
    implicitSendSnapshots.set(String(threadId), implicitSnapshot);
    const sendRequest = draftOverride ? null : {
      failedConfirmationSend: failedConfirmationSends.get(String(threadId)),
      draftScopeKey: composerDraftScopeState.activeScopeKey,
      promptRevision: composerPromptRevision,
      contextRevision: composerContextState.revision,
      modelSelection: pickerSelectionPayload(modelPicker?.getSelection())?.modelSelection,
      inputCompositionRevision: currentInputCompositionRevision(threadId),
      freshIntent: interactionSendIntent({
        threadId,
        draftScopeKey: composerDraftScopeState.activeScopeKey,
        promptValue: prompt.value,
        promptRevision: composerPromptRevision,
        contexts: composerContextState.value,
        contextRevision: composerContextState.revision,
        modelSelection: pickerSelectionPayload(modelPicker?.getSelection())?.modelSelection,
        inputDraftRevision: currentInputDraftRevision(threadId),
        inputCompositionRevision: currentInputCompositionRevision(threadId),
      }),
    };
    let intent = draftOverride ? sendWarningIntent : null;
    let unconfirmedContextDrafts = [];
    const attempt = { threadId: String(threadId) };
    inFlightSendThreads.set(attempt.threadId, attempt);
    sendAttempt = attempt;
    // The text is held from the click, so a newer turn that loads while Send
    // reconciles inputs does not carry it into its scope before it is sent.
    const clickSubmission = draftOverride ? null : Object.freeze({
      scopeKey: sendRequest.draftScopeKey,
      promptRevision: sendRequest.promptRevision,
    });
    if (clickSubmission) {
      inFlightSubmissions.set(attempt.threadId, clickSubmission);
      sendEditScopes.delete(attempt.threadId);
    }
    send.setAttribute("aria-busy", "true");
    for (const control of $("#nodeInputActions").querySelectorAll("button, textarea")) {
      control.disabled = true;
    }
    // The composer's committed-input pills lock with the Send too.
    renderComposerContexts();
    if (selection.selectedNodeId != null) {
      void selectNode(getState(), selection.selectedNodeId, { notify: false });
    }
    try {
      if (!draftOverride && contextDraftController) {
        await ensureContextDraftsLoaded(threadId);
        if (!sendIntentIsCurrentThread(getThread()?.id, threadId) || sendAttempt !== attempt) return;
        unconfirmedContextDrafts = contextDraftController.draftsForThread(threadId);
      }
      if (!draftOverride) {
        const reconciledInputDraftRevision = () => currentInputDraftRevision(threadId);
        const clickTimeIntentWithoutDraftAuthority = () => confirmationSendReplayIntentWithoutInputAuthority({
          intent: sendRequest.failedConfirmationSend?.intent,
          threadId,
          draftScopeKey: sendRequest.draftScopeKey,
          promptRevision: sendRequest.promptRevision,
          contextRevision: sendRequest.contextRevision,
          replayContextRevision: sendRequest.failedConfirmationSend?.contextRevision,
          modelSelection: sendRequest.modelSelection,
        });
        intent = await selectInteractionSendIntentAfterInputReconciliation({
          awaitInputDraft: async () => {
            await flushImplicitInputs(threadId, implicitSnapshot);
            if (!await settleAuthoredInputCommits(threadId)) {
              // The answer the user entered did not save; the input shows why.
              throw new Error("An answer in Node Details could not be saved, so the message was not sent.");
            }
            if (inputDraftController) await ensureInputDraftLoaded(threadId);
          },
          selectionIsCurrent: () => sendIntentIsCurrentThread(getThread()?.id, threadId)
            && sendAttempt === attempt,
          replayIntent: () => confirmationSendReplayIntent({
            intent: sendRequest.failedConfirmationSend?.intent,
            threadId,
            draftScopeKey: sendRequest.draftScopeKey,
            promptRevision: sendRequest.promptRevision,
            contextRevision: sendRequest.contextRevision,
            replayContextRevision: sendRequest.failedConfirmationSend?.contextRevision,
            modelSelection: sendRequest.modelSelection,
            inputDraftRevision: reconciledInputDraftRevision(),
            inputCompositionRevision: sendRequest.inputCompositionRevision,
          }),
          rebuildIntent: () => rebuildInteractionSendIntentAfterInputReconciliation({
            clickedIntent: clickTimeIntentWithoutDraftAuthority(),
            currentIntent: sendRequest.freshIntent,
            inputDraftRevision: reconciledInputDraftRevision(),
            inputCompositionRevision: currentInputCompositionRevision(threadId),
          }),
        });
        if (!intent || !sendIntentIsCurrentThread(threadId, intent.threadId)) return;
        if (unconfirmedContextDrafts.length > 0) {
          openContextDraftSendWarning(unconfirmedContextDrafts, intent);
          return;
        }
      }
      if (!intent || !sendIntentIsCurrentThread(threadId, intent.threadId)) return;
      if (draftOverride && contextDraftController) {
        await continueDraftOverrideAfterPersistence({
          controller: contextDraftController,
          threadId,
          attempt,
          readCurrentThreadId: () => getThread()?.id,
          readCurrentAttempt: () => sendAttempt,
          continueSend: async () => {
            closeContextDraftSendWarning({ focusSend: false, cancelAttempt: false });
            await submitInteraction(intent);
          },
        });
        return;
      }
      if (draftOverride) {
        closeContextDraftSendWarning({ focusSend: false, cancelAttempt: false });
      }
      await submitInteraction(intent);
    } catch (error) {
      toast(error.message);
    } finally {
      if (clickSubmission && inFlightSubmissions.get(attempt.threadId) === clickSubmission) {
        inFlightSubmissions.delete(attempt.threadId);
        // The Send ended without posting. Unless the draft-send warning now
        // holds it, text a newer turn left in its scope comes back.
        if (String(sendWarningIntent?.threadId) !== attempt.threadId) {
          restoreStrandedSubmission({ threadId: attempt.threadId, scopeKey: clickSubmission.scopeKey });
        }
      }
      releaseInFlightSend(inFlightSendThreads, attempt);
      if (sendAttempt === attempt) releaseSendAttempt();
      else syncComposer();
    }
  };
  confirmContextDraftSend.onclick = () => {
    confirmContextDraftSend.disabled = true;
    void requestInteractionSend({ draftOverride: true });
  };
  if (capabilities.canCompose) {
    modelPicker = createModelPicker({
      root: root.querySelector('[data-model-picker="ongoing"]'),
      mode: "ongoing",
      settings: getState().modelSettings,
      onSelectionChange: syncComposer,
      onOpenSettings,
      onRefreshModels,
    });
  }
  prompt.oninput = () => {
    failedConfirmationSends = settleConfirmationSendReplay(failedConfirmationSends, {
      threadId: getThread()?.id,
      intent: null,
      contextRevision: null,
      preserve: false,
    });
    composerPromptRevision += 1;
    // Emptying the composer while a newer draft held a restoration out
    // brings the retry text back at once (SCP-020).
    const activeScopeKey = composerDraftScopeState.activeScopeKey;
    const activeDraft = composerDraftScopeState.drafts.get(activeScopeKey);
    if (!prompt.value && pendingRestoration?.scopeKey === activeScopeKey
      && String(activeDraft?.restoredDraftInteractionId) !== String(pendingRestoration.restorationId)) {
      prompt.value = pendingRestoration.text;
      const drafts = new Map(composerDraftScopeState.drafts);
      drafts.set(activeScopeKey, {
        promptValue: prompt.value,
        promptRevision: composerPromptRevision,
        restoredDraftInteractionId: pendingRestoration.restorationId,
      });
      composerDraftScopeState = { ...composerDraftScopeState, drafts };
    }
    // Typing while a Send's turn has not loaded is an edit after that Send
    // (SCP-018), in whichever scope the composer is in: a newer turn may have
    // moved it on.
    const typingThreadId = String(getThread()?.id);
    if (inFlightSubmissions.has(typingThreadId)) sendEditScopes.set(typingThreadId, activeScopeKey);
    const sentRecord = sentThreadFollowup(typingThreadId);
    if (sentRecord && (!sentRecord.edited || sentRecord.scopeKey !== activeScopeKey)) {
      persistSentThreadFollowup(typingThreadId, { ...sentRecord, scopeKey: activeScopeKey, edited: true });
    }
    // An empty value is kept as a tombstone only when it clears restored
    // retry text that was shown. Clearing a draft that kept a restoration
    // out leaves no draft, so the retry text returns, after a restart too
    // (SCP-020).
    const shownRestorationId = composerDraftScopeState.drafts
      .get(composerDraftScopeState.activeScopeKey)?.restoredDraftInteractionId ?? null;
    const restorationShown = shownRestorationId != null;
    persistThreadFollowupDraft(composerDraftScopeState.activeScopeKey, prompt.value, {
      preserveEmpty: restoredDraftActive && restorationShown,
      // Which restoration this draft grew from, so a restart can tell it from
      // a user's draft with the same text.
      restorationId: shownRestorationId,
    });
    syncComposer();
  };
  bindComposerKeydown(prompt, () => {
    if (!modelPicker?.isReady()) modelPicker?.open("model");
    else send.click();
  });
  send.onclick = async () => {
    const run = activeRun();
    if (!run) { void requestInteractionSend(); return; }
    if (send.disabled || pendingStops.has(run.id)) return;
    const threadId = getThread().id;
    pendingStops.add(run.id);
    stopErrors.delete(run.id);
    syncComposer();
    try { await onStopInteraction(threadId, run.id); }
    catch (error) { stopErrors.set(run.id, error.message || "Stop could not be confirmed. Try again."); }
    finally { pendingStops.delete(run.id); syncComposer(); }
  };
  $("#attachNodeContext").onclick = () => {
    const node = resolveInteractionContextNode(
      selection.selectedNodeId,
      getState().nodes,
      composerContextState.value,
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
    applyComposerCapabilities({
      composer: $("#threadComposer"),
      prompt,
      send,
      readOnlyMessage: $("#readOnlyComposerMessage"),
    }, capabilities.canCompose);
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
    const graph = interactionGraph(turns, interaction?.id);
    $("#turnPicker .turn-stepper").classList.toggle("interaction-graph-stepper", graph !== null);
    $("#previousTurn").classList.toggle("hidden", graph !== null);
    $("#nextTurn").classList.toggle("hidden", graph !== null);
    pickerButton.classList.toggle("interaction-graph-trigger", graph !== null);
    $("#turnPopover").classList.toggle("interaction-graph-popover", graph !== null);
    if (graph) {
      $("#turnPicker .turn-stepper").setAttribute("aria-label", "Interaction navigation");
      pickerButton.disabled = !turns.length;
      pickerButton.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h12M6 6v12m0-6h12"/><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/></svg><b>${graph.contextCount}</b>`;
      pickerButton.setAttribute("aria-label", `Open interaction graph. ${graph.contextCount} attached context nodes`);
      const title = graphDocument.createElement("div"); title.className = "interaction-graph-heading";
      title.textContent = graph.incomplete ? "Interaction graph · Some connections unavailable" : "Interaction graph";
      const viewport = graphDocument.createElement("div"); viewport.className = "interaction-graph-viewport";
      viewport.append(renderInteractionGraph(graphDocument, graph, interaction?.id, async (node) => {
        if (!await prepareNodeContextSelectionChange()) return;
        closeTurnPopover(); collapseContextPreviews();
        if (onSelectTurnById) await onSelectTurnById(node.id, { responseRoot: node.completionStatus === "accepted", threadId: node.threadId });
      }));
      $("#turnPopover").replaceChildren(title, viewport);
      if (focusedTurnId !== null) [...$("#turnPopover").querySelectorAll("[data-turn-id]")].find((row) => row.dataset.turnId === focusedTurnId)?.focus({ preventScroll: true });
      $("#turnPopover").classList.toggle("hidden", !turnPopoverOpen);
      pickerButton.setAttribute("aria-expanded", String(turnPopoverOpen));
      fitInteractionGraphPopover();
      return;
    }
    $("#turnPicker .turn-stepper").setAttribute("aria-label", "Turn navigation");
    pickerButton.disabled = turnIndex < 0 || !turns.length;
    pickerButton.textContent = `Turn ${turnIndex < 0 ? 0 : turnIndex + 1} of ${turns.length}`;
    pickerButton.setAttribute(
      "aria-label",
      turnIndex < 0 ? "Choose a turn" : `Turn ${turnIndex + 1} of ${turns.length}. Choose a turn`,
    );

    const rows = turns.map((turn, index) => {
      const current = index === turnIndex;
      const status = turnStatusPresentation(turn.stopRequested && !turn.stopError && PENDING_COMPLETION_STATUSES.has(turn.completionStatus) ? "stopping" : turn.completionStatus);
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
      row.onclick = async () => {
        const intent = turnSelectionIntent(turns, interaction?.id, turn.id);
        closeTurnPopover();
        if (!intent) return;
        if (!await prepareNodeContextSelectionChange()) return;
        collapseContextPreviews();
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
      button.append(createRelayerIcon(node.icon || node.metadata?.relayer?.icon, {}, node, iconSourceContext(context.target, state)));
      const title = graphDocument.createElement("span");
      title.textContent = node.title;
      button.append(title);
      button.setAttribute("aria-label", `Open ${node.title} details`);
      button.onclick = () => {
        closeContextPopover();
        void selectNode(
          state,
          node.id,
          historicalContextSelectionOptions(context.target, button),
        );
      };
      group.append(button);
      if (context.annotations?.length) {
        const list = graphDocument.createElement("ol");
        for (const annotation of context.annotations) {
          const item = graphDocument.createElement("li");
          // An artifact note names its screenshot for the agent; people see the note.
          item.textContent = artifactNoteLabel(annotation);
          list.append(item);
        }
        group.append(list);
      }
      return group;
    });
    $("#interactionContextPopover").replaceChildren(...groups);
    $("#interactionContextPopover").classList.toggle("hidden", !contextPopoverOpen);
  }

  function renderHistoricalInputs(interaction) {
    const host = $("#interactionInputHistory");
    const inputs = interaction?.submittedInputs || [];
    host.classList.toggle("hidden", inputs.length === 0);
    if (!inputs.length) {
      host.replaceChildren();
      return;
    }
    const heading = graphDocument.createElement("strong");
    heading.textContent = "Submitted inputs";
    const list = graphDocument.createElement("div");
    list.className = "interaction-input-history-list";
    inputs.forEach((input) => {
      const item = graphDocument.createElement("section");
      item.className = "interaction-input-history-item";
      const prompt = graphDocument.createElement("strong");
      prompt.textContent = input.action?.prompt || "Input";
      const presentation = submittedInputHistoryPresentation(input);
      const value = presentation.kind === "disclosure"
        ? (() => {
            const disclosure = graphDocument.createElement("details");
            disclosure.className = "interaction-input-history-disclosure";
            const summary = graphDocument.createElement("summary");
            summary.textContent = presentation.compactValue;
            summary.setAttribute("aria-label", presentation.ariaLabel);
            const full = graphDocument.createElement("p");
            full.textContent = presentation.fullValue;
            disclosure.append(summary, full);
            return disclosure;
          })()
        : (() => {
            const text = graphDocument.createElement("span");
            text.textContent = presentation.compactValue;
            return text;
          })();
      item.append(prompt, value);
      list.append(item);
    });
    host.replaceChildren(heading, list);
  }

  // PRD §8.1: a symbol follows the thread title only while Running, Stopping…, Needs approval or Failed.
  function renderThreadStatusSymbol(activityKey) {
    const symbol = $("#threadStatusSymbol");
    if (!symbol) return;
    const activity = THREAD_ACTIVITY[activityKey];
    symbol.classList.toggle("hidden", !activity);
    if (!activity) {
      delete symbol.dataset.activity;
      symbol.removeAttribute("aria-label");
      symbol.removeAttribute("title");
      symbol.replaceChildren();
      return;
    }
    if (symbol.dataset.activity === activityKey) return;
    symbol.dataset.activity = activityKey;
    symbol.setAttribute("aria-label", activity.label);
    symbol.title = activity.label;
    symbol.replaceChildren(createLucideIcon(activity.icon));
  }

  function render() {
    if (disposed) return;
    const state = getState();
    const thread = getThread();
    if (!thread) {
      nodeSelectionSequence += 1;
      // A request still waiting for a draft belongs to the thread left.
      userRequestTicket += 1;
      contextEditor = null;
      releaseSendAttempt();
      if (contextDraftSendWarning.open) {
        closeContextDraftSendWarning({ focusSend: false, cancelAttempt: false });
      }
      renderedWithoutThread = true;
      openComposerInputKey = null;
      showEmpty();
      return;
    }
    const threadId = String(thread.id);
    const enteringInputDraftEligibility = renderedWithoutThread
      || renderedThreadId !== threadId;
    const enteringLoadedThread = renderedWithoutThread
      && loadedContextDraftThreads.has(threadId);
    renderedWithoutThread = false;
    if (enteringInputDraftEligibility) {
      inputDraftLoadRetries?.beginEligibilityCycle(thread.id);
    }
    if (contextDraftController
      && !contextDraftLoads.has(threadId)
      && !contextDraftLoadRetryTimers.has(threadId)) {
      void ensureContextDraftsLoaded(thread.id).catch((error) => {
        if (disposed) return;
        toast(`Annotation drafts could not be restored: ${error.message}`);
        scheduleContextDraftLoadRetry(thread.id);
      });
    }
    if (inputDraftController
      && !inputDraftLoads.has(threadId)
      && !inputDraftLoadRetries?.suppressesLoad(threadId)) {
      void ensureInputDraftLoaded(thread.id).catch((error) => {
        if (!disposed && String(getThread()?.id) === threadId) {
          toast(`Committed inputs could not be restored: ${error.message}`);
          inputDraftLoadRetries?.schedule(thread.id);
        }
      });
    }
    if (renderedThreadId !== null && renderedThreadId !== threadId) {
      readingLayout.closeEnvironment();
      nodeSelectionSequence += 1;
      // A request still waiting for a draft belongs to the thread left.
      userRequestTicket += 1;
      releaseSendAttempt();
      if (contextDraftSendWarning.open) {
        closeContextDraftSendWarning({ focusSend: false });
      }
      annotationSubject = null;
      annotationThreadId = null;
      resetAnnotationComposer();
      $("#annotationPanel").classList.add("hidden");
      cancelInspectorFit();
      $("#inspector").classList.add("hidden");
      selection.selectedNodeId = null;
      selectedContextTarget = null;
      contextEditor = null;
      composerContextState = transitionComposerContextState(composerContextState, {
        type: "thread_change",
      });
      openComposerContextKey = null;
      openComposerInputKey = null;
      clearInputStagesForThread(renderedThreadId);
      if (contextDraftController.confirmationsForThread(thread.id).length) {
        replaceComposerContexts(composerContextsFromConfirmations(
          contextDraftController.confirmationsForThread(thread.id),
        ));
      }
    }
    if (enteringLoadedThread) {
      replaceComposerContexts(composerContextsMergedWithConfirmations(
        composerContextState.value,
        contextDraftController.confirmationsForThread(thread.id),
      ));
      openComposerContextKey = null;
      renderComposerContexts();
    }
    establishConfirmationReplayContextRevision(thread.id);
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
    shareController?.render();
    void loadAnnotations(thread);
    renderHistoryNavigation();
    renderThreadTitle(root, thread);
    const project = environmentProjectForThread(state.projects, thread);
    const permissionProfile = state.permissionProfiles?.find((item) => item.id === thread.permissionProfileId);
    const permissionLabel = permissionProfile?.label || thread.permissionProfileId;
    const harnessId = thread.harnessId ?? thread.harnessConfigurationName;
    const harness = state.modelSettings?.harnesses?.find((item) => item.id === harnessId);
    const threadScope = `${project?.name || "No folder"} · ${permissionLabel} · ${harness?.label ?? harnessId}`;
    $("#threadScope").textContent = threadScope;
    $("#threadTitle").title = threadScope;
    renderEnvironment(state.environment, project, thread.id);
    const pendingTurn = state.pendingTurn;
    const showPending = pendingTurn && String(pendingTurn.threadId) === String(thread.id)
      && String(pendingTurn.interactionId) !== String(state.currentInteractionId);
    $("#pendingTurnNotice").classList.toggle("hidden", !showPending);
    if (showPending) {
      const pendingInteraction = state.interactions.find((item) => String(item.id) === String(pendingTurn.interactionId));
      const label = pendingTurn.readyLayer ? "Result ready" : turnStatusPresentation(pendingTurn.status).label;
      $("#pendingTurnText").textContent = `Turn ${pendingInteraction?.sequence ?? ""} · ${label}`;
      $("#openReadyResult").classList.toggle("hidden", !pendingTurn.readyLayer);
    }
    const interaction = interactionForThread(state, thread);
    updateCountBadge($("#threadAnnotationBadge"), subjectAnchor("thread", {}, state, thread));
    updateCountBadge($("#turnAnnotationBadge"), subjectAnchor("turn", {}, state, thread));
    const interactionText = interaction?.text || "";
    $("#interactionText").textContent = interactionText;
    $("#interactionText").title = interactionText;
    renderTurnNavigation(state, thread, interaction);
    renderHistoricalContexts(state, interaction);
    renderHistoricalInputs(interaction);
    // A child an agent launched is not a human turn: the composer's scopes follow human turns.
    const turns = humanTurns(state, thread);
    const latestInteraction = turns.at(-1);
    renderThreadStatusSymbol(interactionActivity(latestInteraction));
    if (inputDraftController && latestInteraction) {
      const statusKey = `${latestInteraction.id}:${latestInteraction.completionStatus || ""}`;
      const priorStatusKey = renderedInputDraftStatusKeys.get(threadId);
      renderedInputDraftStatusKeys.set(threadId, statusKey);
      if (priorStatusKey && priorStatusKey !== statusKey
        && !PENDING_COMPLETION_STATUSES.has(latestInteraction.completionStatus)) {
        void ensureInputDraftLoaded(threadId, { reload: true }).catch((error) => {
          if (!disposed && String(getThread()?.id) === threadId) {
            toast(`Restored inputs could not be refreshed: ${error.message}`);
          }
        });
      }
    }
    const restoredDraft = restoredDraftForInteraction(latestInteraction);
    restoredDraftActive = Boolean(restoredDraft);
    pendingRestoration = restoredDraft
      ? {
        scopeKey: composerDraftScopeKey(threadId, latestInteraction?.id),
        restorationId: restoredDraft.retryAttemptId != null
          ? `${latestInteraction?.id}:${restoredDraft.retryAttemptId}`
          : latestInteraction?.id,
        text: restoredDraft.text,
      }
      : null;
    const restoredConfirmationKey = confirmationRestorationKey(threadId, latestInteraction);
    if (restoredConfirmationKey
      && !recoveredConfirmationThreads.has(restoredConfirmationKey)
      && contextDraftController) {
      recoveredConfirmationThreads.add(restoredConfirmationKey);
      contextDraftController.allowConfirmationRestoration(threadId);
      loadedContextDraftThreads.delete(threadId);
      void ensureContextDraftsLoaded(threadId).catch((error) => {
        if (!disposed && String(getThread()?.id) === threadId) {
          toast(`Confirmed context could not be restored: ${error.message}`);
        }
      });
    }
    const retryMessage = $("#composerRetryMessage");
    const stopMessage = latestInteraction?.stopRequested
      ? latestInteraction.stopError || latestInteraction.completionError
      : null;
    retryMessage.classList.toggle("is-stopped", latestInteraction?.completionStatus === "stopped" && !latestInteraction.stopError);
    retryMessage.classList.toggle("hidden", !restoredDraft && !stopMessage);
    retryMessage.textContent = stopMessage || restoredDraft?.message || "";
    // Text an earlier session persisted in an older turn's scope, such as one
    // closed while a send was in flight, can be carried forward too, unless
    // a later turn with that text shows it was sent.
    if (composerDraftScopeState.activeScopeKey !== composerDraftScopeKey(threadId, latestInteraction?.id)) {
      const drafts = new Map(composerDraftScopeState.drafts);
      const editedScopeKey = editedAfterSendScopeKey(threadId);
      turns.slice(0, -1).forEach((turn, index) => {
        const scopeKey = composerDraftScopeKey(threadId, turn.id);
        const text = drafts.has(scopeKey) ? null : threadFollowupDraft(scopeKey);
        if (!text) return;
        // Sent text is not kept (SCP-016), and text a newer turn's draft
        // superseded is retired (SCP-021).
        const superseded = turns.slice(index + 1).some((later) => {
          const laterKey = composerDraftScopeKey(threadId, later.id);
          return Boolean(threadFollowupDraft(laterKey) || drafts.get(laterKey)?.promptValue);
        });
        // What was typed after a Send whose turn had not loaded is kept like
        // any unsent text.
        if ((scopeKey !== editedScopeKey && sentByLaterTurn(threadId, scopeKey, text)) || superseded) {
          clearThreadFollowupDraft(scopeKey);
          return;
        }
        drafts.set(scopeKey, { promptValue: text, promptRevision: -1, restoredDraftInteractionId: null });
      });
      composerDraftScopeState = { ...composerDraftScopeState, drafts };
    }
    // Drafts in older scopes that a later turn shows were sent. The scope of
    // a send still in flight is left to its revision (settlement and the
    // carry's hold), so an edit after Send that repeats the text is kept, as
    // is text typed after a Send whose turn had not loaded when it settled.
    const inFlightScopeKey = inFlightSubmissions.get(threadId)?.scopeKey;
    const editedScopeKey = editedAfterSendScopeKey(threadId);
    const sentDrafts = turns.slice(0, -1).flatMap((turn) => {
      const scopeKey = composerDraftScopeKey(threadId, turn.id);
      if (scopeKey === inFlightScopeKey || scopeKey === editedScopeKey) return [];
      const draft = scopeKey === composerDraftScopeState.activeScopeKey
        ? { promptValue: prompt.value, promptRevision: composerPromptRevision }
        : composerDraftScopeState.drafts.get(scopeKey);
      return draft && sentByLaterTurn(threadId, scopeKey, draft.promptValue)
        ? [{ scopeKey, promptRevision: draft.promptRevision }]
        : [];
    });
    const draftTransition = transitionComposerDraftScope(composerDraftScopeState, {
      threadId,
      interactionId: latestInteraction?.id,
      currentPromptValue: prompt.value,
      currentPromptRevision: composerPromptRevision,
      restoredDraft,
      persistedDraftText: threadFollowupDraft(
        composerDraftScopeKey(threadId, latestInteraction?.id),
      ),
      persistedRestorationId: threadFollowupRestoration(
        composerDraftScopeKey(threadId, latestInteraction?.id),
      ),
      olderScopeKeys: turns.slice(0, -1).reverse()
        .map((turn) => composerDraftScopeKey(threadId, turn.id)),
      // A Send waiting on the draft-send warning still holds its text.
      inFlightSubmission: inFlightSubmissions.get(threadId)
        ?? (String(sendWarningIntent?.threadId) === threadId
          ? {
            scopeKey: sendWarningIntent.submission?.scopeKey,
            promptRevision: sendWarningIntent.submission?.prompt?.revision,
          }
          : null),
      sentDrafts,
    });
    composerDraftScopeState = draftTransition.state;
    // A draft a later turn shows was sent is deleted, in memory and storage
    // (SCP-016). The submission in flight is left to its settlement.
    const settling = inFlightSubmissions.get(threadId);
    const sentBehind = sentDrafts.filter(({ scopeKey, promptRevision }) => (
      scopeKey !== composerDraftScopeState.activeScopeKey
      && !(settling?.scopeKey === scopeKey && Object.is(settling.promptRevision, promptRevision))));
    if (sentBehind.length) {
      const drafts = new Map(composerDraftScopeState.drafts);
      for (const { scopeKey } of sentBehind) {
        drafts.delete(scopeKey);
        clearThreadFollowupDraft(scopeKey);
      }
      composerDraftScopeState = { ...composerDraftScopeState, drafts };
    }
    prompt.value = draftTransition.promptValue;
    composerPromptRevision = draftTransition.promptRevision;
    if (draftTransition.carriedFromScopeKey) {
      persistThreadFollowupDraft(composerDraftScopeState.activeScopeKey, prompt.value);
      clearThreadFollowupDraft(draftTransition.carriedFromScopeKey);
      // An edit made while Send waits moves with its text.
      if (sendEditScopes.get(threadId) === draftTransition.carriedFromScopeKey) {
        sendEditScopes.set(threadId, composerDraftScopeState.activeScopeKey);
      }
    }
    const sentRecord = sentThreadFollowup(threadId);
    if (sentRecord) {
      // The edit moves with its text; once the sent turn has loaded, it has
      // been carried past that turn and needs no more protection.
      if (sentTurnLoaded(threadId, sentRecord)) {
        persistSentThreadFollowup(threadId, null);
      } else if (draftTransition.carriedFromScopeKey === sentRecord.scopeKey) {
        persistSentThreadFollowup(threadId, {
          ...sentRecord,
          scopeKey: composerDraftScopeState.activeScopeKey,
        });
      }
    }
    const inheritanceKey = `${thread.id}:${latestInteraction?.id ?? "none"}`;
    if (modelPicker) {
      const replaceSelection = inheritanceKey !== pickerInheritanceKey;
      modelPicker.setContext({
        settings: { ...state.modelSettings, conversationCompatibility: state.conversationCompatibility?.threadId === Number(thread.id) ? state.conversationCompatibility : { status: "blocked", message: "Checking conversation compatibility…" } },
        pinnedHarnessId: harnessId,
        selection: replaceSelection
          ? selectionForNextInteraction(state.modelSettings, harnessId, latestInteraction)
          : undefined,
        replaceSelection,
      });
      pickerInheritanceKey = inheritanceKey;
    }
    renderInteractionState(state, interaction, Boolean(restoredDraft));
    renderApprovalDock(state, thread);
    renderGraph(state, thread);
    if (selection.selectedNodeId != null) {
      void selectNode(state, selection.selectedNodeId, { notify: false });
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
        const owner = { id: item.sourceNodeId };
        segment.append(createRelayerIcon(item.icon, { class: "breadcrumb-icon" }, owner, { layerId: item.sourceLayerId ?? item.layerId }));
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
          segment.onclick = async () => {
            if (!await prepareNodeContextSelectionChange()) return;
            await onNavigateLayer(item.layerId, {
              restore: true,
              pathIndex: item.pathIndex,
              ...(item.kind === "invoke-origin" ? { invocationOrigin: true } : {}),
            });
          };
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
              if (!await prepareNodeContextSelectionChange()) return;
              await onNavigateLayer(item.layerId, {
                restore: true,
                pathIndex: item.pathIndex,
              ...(item.kind === "invoke-origin" ? { invocationOrigin: true } : {}),
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

  function renderInteractionState(state, interaction, restoredDraft = false) {
    const viewedStatus = viewedInteractionStatus(interaction, state.status || "idle", state.temporalLifecycle);
    const presentation = turnStatusPresentation(viewedStatus);
    const statusElement = $("#interactionStatus");
    const safeReason = interaction?.stopRequested ? null : state.temporalSafeReason || null;
    const statusKey = `${interactionStatusRenderKey(interaction, state.status || "idle", state.temporalLifecycle)}:${safeReason ?? ""}`;
    if (statusKey !== renderedInteractionStatusKey) {
      statusElement.className = presentation.hidden
        ? "interaction-status hidden"
        : `interaction-status interaction-status-${presentation.kind}`;
      statusElement.textContent = safeReason == null
        ? presentation.label
        : `${presentation.label}: ${safeReason}`;
      renderedInteractionStatusKey = statusKey;
    }
    prompt.disabled = composerDisabledForState(
      composerStatusForThread(state, getThread()),
      capabilities.canCompose,
      restoredDraft,
    );
    modelPicker?.setDisabled(prompt.disabled);
    renderComposerContexts();
    updateAttachContextControl();
    syncComposer();
  }

  function renderEnvironment(environment, project, selectedThreadId) {
    const body = $("#environmentBody");
    if (!body) return;
    const presentation = environmentPresentation(environment, project, selectedThreadId);
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
    const historyDisclosure = $("#approvalHistory");
    const historyList = $("#approvalHistoryList");
    const historyIdentity = approvalHistoryRenderIdentity(mode, threadKey, dockMode);
    const receiptIdentity = approvalHistoryReceiptIdentity(history);
    const historyTransition = approvalHistoryRenderTransition({
      previousIdentity: historyDisclosure.dataset.renderIdentity,
      identity: historyIdentity,
      previousReceiptIdentity: historyDisclosure.dataset.receiptIdentity,
      receiptIdentity,
      dockMode,
      wasHidden,
      wasHistoryOnly,
      open: historyDisclosure.open,
      scrollTop: historyList.scrollTop,
    });
    const renderHistory = () => {
      historyDisclosure.classList.toggle("hidden", history.length === 0);
      $("#approvalHistorySummary").textContent = `Approval history (${history.length})`;
      historyList.replaceChildren(...history.map((receipt) => {
        const item = graphDocument.createElement("li");
        item.textContent = `${receipt.request.title} — ${approvalResolutionLabel(receipt)}`;
        return item;
      }));
      historyDisclosure.open = historyTransition.open;
      historyList.scrollTop = historyTransition.scrollTop;
      historyDisclosure.dataset.renderIdentity = historyIdentity;
      historyDisclosure.dataset.receiptIdentity = receiptIdentity;
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
      graphViewEpoch += 1;
      clearInputStagesForThread(thread?.id);
      nodeSelectionSequence += 1;
      cancelInspectorFit();
      if (!preserveHistoricalSelection) $("#inspector").classList.add("hidden");
      // A layout that changed mid-drag is fitted before its view is cached,
      // so returning shows it fitted.
      if (fitGraphAfterDrop) {
        camera = fitGraphCamera(graphNodes, graphStage.getBoundingClientRect());
        cameraRevision = 0;
      }
      saveGraphView();
      // A drag cannot follow its node into another view, which is fitted.
      dragging = null;
      fitGraphAfterDrop = false;
    }
    $("#graphEmpty").classList.toggle("hidden", responseNodes.length > 0);
    $("#graphStage").classList.toggle("hidden", responseNodes.length === 0);
    if (!responseNodes.length) {
      graphViewKey = nextViewKey;
      dragging = null;
      fitGraphAfterDrop = false;
      // Removing the node elements also releases a drag's pointer capture,
      // so its release cannot click a node that is gone.
      $("#nodeLayer").replaceChildren();
      graphNodes = [];
      graphEdges = [];
      graphSignature = "";
      if (graphRenderClearsSelection({
        hasResponseNodes: false,
        enteringView,
        nodeInGraph: false,
        preserveHistoricalSelection,
      })) {
        nodeSelectionSequence += 1;
        clearInputStagesForThread(getThread()?.id);
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
        ? state.temporalSafeReason
          ? `This interaction failed before producing an accepted graph: ${state.temporalSafeReason}`
          : "This interaction failed before producing an accepted graph."
        : "This interaction has no accepted graph yet.";
      return;
    }

    const cachedView = enteringView ? graphViewCache.get(nextViewKey) : null;
    const previous = new Map(
      (cachedView?.nodes ?? (!enteringView ? graphNodes : []))
        .map((node) => [String(node.id), node]),
    );
    graphViewKey = nextViewKey;
    // Keyboard and screen-reader order follow the layer's reading order.
    graphNodes = nodesInReadingOrder(state.visibleLayer, responseNodes).map((node, index) => ({
      ...node,
      x: 0,
      y: 0,
      pinned: false,
      index,
    }));
    // A drag in progress continues on its node's new object and element, so
    // a render while the user drags does not strand the drag on the old ones.
    const draggedFrom = dragging?.node ?? null;
    if (dragging) {
      dragging.node = graphNodes.find((node) => String(node.id) === String(draggedFrom.id));
      if (!dragging.node) dragging = null;
    }
    const dragMoved = Boolean(dragging?.moved);
    // Kept where the user moved it even if the drag ends in this render.
    const draggedNode = dragMoved ? dragging.node : null;
    const ids = graphNodeIdentitySet(graphNodes);
    graphEdges = (state.edges || []).filter((edge) => {
      const [source, target] = edge.endpoints || [edge.source, edge.target];
      return ids.has(String(source)) && ids.has(String(target));
    });
    graphEdgeShape = resolveEdgeShape(state.visibleLayer?.layer?.layout?.edgeShape);
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
      const family = relayerIconFamily(node.icon || node.metadata?.relayer?.icon);
      const imageIcon = imageIconReference(node.icon);
      const runStateKey = nodeRunState(node, state.actions, state.actionInvocations);
      const runState = NODE_RUN_STATE[runStateKey];
      const runStateMarks = runState
        ? `${runState.icon ? '<span class="graph-node-state-badge" aria-hidden="true"></span>' : ""}<span class="graph-node-caption" aria-hidden="true">${runState.label}</span>`
        : "";
      const runStateLabel = runState ? `. ${runState.label}` : "";
      return `<div class="graph-node ${String(node.id) === String(selection.selectedNodeId) ? "selected" : ""}" data-node="${escapeHtml(node.id)}" data-family="${family}"${imageIcon ? ' data-image-icon="true"' : ""}${runState ? ` data-run-state="${runStateKey}"` : ""} data-review-ref="node-${escapeHtml(node.id)}" data-review-kind="node" role="button" tabindex="0" aria-label="Open ${escapeHtml(node.title)}${runStateLabel}${annotationLabel}"><div class="glyph"></div>${badge}<div class="copy"><b>${escapeHtml(node.title)}</b></div>${runStateMarks}</div>`;
    }).join("");
    releaseDetachedIcons();
    $$('[data-node]').forEach((element) => {
      const authoredNode = graphNodes.find((candidate) => String(candidate.id) === element.dataset.node);
      let suppressClickAfterDrag = false;
      element.querySelector(".glyph").replaceChildren(createRelayerIcon(
        authoredNode?.icon || authoredNode?.metadata?.relayer?.icon,
        { class: "relayer-node-icon" }, authoredNode,
      ));
      const runState = NODE_RUN_STATE[element.dataset.runState];
      if (runState?.icon) element.querySelector(".graph-node-state-badge").replaceChildren(createLucideIcon(runState.icon));
      if (authoredNode) {
        authoredNode.layoutBounds = graphNodeLayoutBounds(
          element.offsetWidth,
          element.offsetHeight,
          runState ? GRAPH_NODE_CAPTION_HEIGHT : 0,
        );
        authoredNode.pillBox = { halfWidth: element.offsetWidth / 2, halfHeight: element.offsetHeight / 2 };
      }
      element.onclick = () => {
        if (!shouldActivateGraphNodeAfterPointerGesture(suppressClickAfterDrag)) {
          suppressClickAfterDrag = false;
          return;
        }
        void selectNode(state, element.dataset.node);
      };
      element.onkeydown = (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        void selectNode(state, element.dataset.node);
      };
      element.onpointerdown = (event) => {
        event.preventDefault();
        event.stopPropagation();
        focusGraph();
        const node = graphNodes.find((candidate) => String(candidate.id) === element.dataset.node);
        const stageRect = $("#graphStage").getBoundingClientRect();
        const grab = graphWorldPoint({ x: event.clientX - stageRect.left, y: event.clientY - stageRect.top }, camera);
        dragging = node ? {
          node,
          pointerId: event.pointerId,
          startClientX: event.clientX,
          startClientY: event.clientY,
          // The node keeps its offset from the pointer, so grabbing it off-centre never jumps it.
          offsetX: node.x - grab.x,
          offsetY: node.y - grab.y,
          moved: false,
        } : null;
        element.setPointerCapture(event.pointerId);
      };
      element.onpointermove = (event) => {
        if (!dragging || String(dragging.node.id) !== element.dataset.node) return;
        // No button is pressed: the release was missed, so the drag is over.
        if (!event.buttons) {
          dragging = null;
          fitAfterDrop();
          automaticGraphFit.flush();
          return;
        }
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
        dragging.node.x = point.x + dragging.offsetX;
        dragging.node.y = point.y + dragging.offsetY;
        if (dragging.moved) dragging.node.pinned = true;
        drawGraph();
      };
      element.onpointerup = () => {
        suppressClickAfterDrag = Boolean(dragging?.moved);
        if (suppressClickAfterDrag) {
          graphWindow?.setTimeout?.(() => { suppressClickAfterDrag = false; }, 0);
        }
        dragging = null;
        fitAfterDrop();
        automaticGraphFit.flush();
      };
      element.onpointercancel = () => {
        dragging = null;
        fitAfterDrop();
        automaticGraphFit.flush();
      };
    });
    if (dragging) {
      const element = $$('[data-node]').find((item) => item.dataset.node === String(dragging.node.id));
      try {
        element?.setPointerCapture(dragging.pointerId);
      } catch {
        // The pointer is no longer active, so no pointerup will end the drag.
        dragging = null;
      }
    }
    const projected = projectLayerNodePositions(state.visibleLayer, graphNodes);
    graphEdgeRoutes = new Map((state.visibleLayer?.layer?.layout?.edgeRoutes ?? []).map((route) => [String(route.edgeId), {
      ...route,
      worldWaypoints: (route.waypoints ?? []).map((point) => projected.project(point)),
    }]));
    for (const node of graphNodes) {
      const canonical = projected.positions.get(String(node.id));
      if (!canonical) throw new Error(`Visible graph layout is missing node ${String(node.id)}.`);
      node.canonicalX = canonical.x;
      node.canonicalY = canonical.y;
      node.layoutSource = projected.source;
      const prior = previous.get(String(node.id));
      if (node === draggedNode) {
        // The dragged node stays under the pointer, even in a changed layout.
        node.x = draggedFrom.x;
        node.y = draggedFrom.y;
        node.pinned = true;
      } else if (cachedLayoutMatches && prior?.pinned) {
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
      nodeSelectionSequence += 1;
      clearInputStagesForThread(getThread()?.id);
      selection.selectedNodeId = null;
      $("#inspector").classList.add("hidden");
    }
    if (!preserveHistoricalSelection && !selection.nodeDetailsClosed && (enteringView || (selection.selectedNodeId != null && !ids.has(String(selection.selectedNodeId))))) {
      const previousSelection = selection.selectedNodeId;
      selection.selectedNodeId = preferredLayerNode(state.visibleLayer ?? { nodes: responseNodes }, selection.selectedNodeId,
        rememberedLayerSelection(thread?.id, state.currentInteractionId, state.visibleLayer?.layer?.id, layerSelectionMemoryOwner));
      if (selection.selectedNodeId != null && String(previousSelection) !== String(selection.selectedNodeId)) {
        onSelectionChange(selection.selectedNodeId, { automatic: true });
      }
    }
    if (dragMoved && dragging && !cachedLayoutMatches) {
      // While a node is dragged, the new layout is fitted after the drop.
      fitGraphAfterDrop = true;
    } else {
      const restoredCamera = graphCameraForView({
        cachedView,
        cachedLayoutMatches,
        enteringView,
        nodes: graphNodes,
        bounds: graphStage.getBoundingClientRect(),
        currentCamera: camera,
        currentCameraRevision: cameraRevision,
      });
      camera = restoredCamera.camera;
      cameraRevision = restoredCamera.cameraRevision;
    }
    // A drag that ended in this render, when its pointer could not be
    // captured again, gets its fit now.
    if (fitGraphAfterDrop && !dragging) {
      fitGraphAfterDrop = false;
      camera = fitGraphCamera(graphNodes, graphStage.getBoundingClientRect());
      cameraRevision = 0;
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
    // Arcs orient on the authored layout, so dragging one node never reshapes edges it is not on.
    const layerCircle = graphLayerCircle(graphNodes.map((node) => graphScreenPoint({ x: node.canonicalX ?? node.x, y: node.canonicalY ?? node.y }, camera)));
    $("#edgeCanvas").setAttribute("data-edge-shape", graphEdgeShape);
    $("#edgeCanvas").innerHTML = graphEdges.map((edge) => {
      const [source, target] = edge.endpoints || [edge.source, edge.target];
      const a = graphNodes.find((node) => String(node.id) === String(source));
      const b = graphNodes.find((node) => String(node.id) === String(target));
      if (!a || !b) return "";
      // Edges stop 4px outside each pill (b-structure-spec: clipped outside every drawn shape).
      const pillBox = (node) => {
        const box = node.pillBox ?? { halfWidth: GRAPH_NODE_HALF_HEIGHT, halfHeight: GRAPH_NODE_HALF_HEIGHT };
        // A run-state caption hangs below the pill; an edge leaving downward clears it.
        const bottom = Math.max(box.halfHeight, node.layoutBounds?.bottom ?? 0);
        return { halfWidth: (box.halfWidth + 4) * camera.zoom, halfHeight: (box.halfHeight + 4) * camera.zoom, bottom: (bottom + 4) * camera.zoom };
      };
      const edgeIdentity = edge.id ?? `${source}:${target}`;
      const edgeId = escapeHtml(edgeIdentity);
      const annotatable = annotationEnabled && edge.id != null;
      const anchor = annotatable ? subjectAnchor("edge", { edgeId: edge.id }) : null;
      const count = anchor ? annotationCount(anchor) : 0;
      const route = graphEdgeRoutes.get(String(edge.id));
      const shape = route?.shape ?? graphEdgeShape;
      const routeEnds = route?.ends?.length === 2
        ? route.ends.map((end) => ({ end, node: graphNodes.find((node) => String(node.id) === String(end.nodeId)) }))
        : null;
      const path = routeEnds?.every(({ node }) => node)
        ? graphRoutedEdgePath(shape, {
          start: { point: graphScreenPoint(routeEnds[0].node, camera), box: pillBox(routeEnds[0].node), side: routeEnds[0].end.side },
          end: { point: graphScreenPoint(routeEnds[1].node, camera), box: pillBox(routeEnds[1].node), side: routeEnds[1].end.side },
          waypoints: graphFollowWaypoints(
            route.worldWaypoints.map((point) => graphScreenPoint(point, camera)),
            routeEnds.map(({ node }) => graphScreenPoint({ x: node.canonicalX ?? node.x, y: node.canonicalY ?? node.y }, camera)),
            routeEnds.map(({ node }) => graphScreenPoint(node, camera)),
          ),
        }, { circle: layerCircle, zoom: camera.zoom })
        : graphEdgePath(shape, graphScreenPoint(a, camera), graphScreenPoint(b, camera), {
          sourceBox: pillBox(a),
          targetBox: pillBox(b),
          circle: layerCircle,
          zoom: camera.zoom,
        });
      const middleX = path.middle.x;
      const middleY = path.middle.y;
      return `<g class="graph-edge-group" data-edge="${edgeId}" data-edge-shape="${resolveEdgeShape(shape)}"${route ? " data-edge-routed" : ""}><path class="graph-edge" aria-hidden="true" style="stroke-width:${graphEdgeStrokeWidth(camera.zoom)}" d="${path.d}"/><path class="graph-edge-hit ${annotatable ? "" : "hidden"}" tabindex="0" role="button" aria-label="Open relationship comments" d="${path.d}"/>${annotatable && count ? `<g class="edge-annotation-badge" aria-hidden="true" transform="translate(${middleX} ${middleY})"><circle r="9"></circle><text y="3">${count}</text></g>` : ""}</g>`;
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

  function displayedInputAttachment(draft, input, occurrence) {
    const bound = implicitInputAcceptance && (getState().actions ?? []).some(action => action.kind === "invoke"
      && action.inputActionIds?.some(id => String(id) === String(input.id)));
    return bound ? boundInputAttachment(draft, input, occurrence) : committedInputAttachment(draft, occurrence);
  }

  function captureImplicitInputs(threadId, { composerOnly = false, action = null } = {}) {
    if (!implicitInputAcceptance) return [];
    const state = getState();
    const interaction = currentInteraction(state, getThread());
    const layerId = currentLayerId(state, getThread());
    const draft = inputDraftController?.current(threadId);
    return [...implicitInputEntries].filter(([key, entry]) => inputKeyBelongsToThread(key, threadId)
      && (!composerOnly || isComposerInputOccurrence(entry.occurrence))
      && (!action || (String(entry.occurrence.presentingInteractionNodeId) === String(interaction?.graphNodeId)
        && String(entry.occurrence.presentingLayerId) === String(layerId)
        && action.inputActionIds?.some(id => String(id) === String(entry.occurrence.actionId)))))
      .flatMap(([key, entry]) => {
        const attachment = action ? boundInputAttachment(draft, entry.action, entry.occurrence)
          : committedInputAttachment(draft, entry.occurrence);
        const touched = inputTouched.has(key);
        if (!touched && !attachment) return [];
        const occurrence = touched ? entry.occurrence : attachment.occurrence;
        const sourceKey = threadInputOccurrenceKey(threadId, occurrence);
        return [{ key, ...entry, occurrence, sourceKey, sourceEditEpoch: inputEditEpochs.get(sourceKey) ?? 0,
          value: structuredClone(touched ? inputStages.get(key) : initialInputStageValue(entry.semantic, attachment)),
          editEpoch: inputEditEpochs.get(key) ?? 0,
          pendingCommits: [...(authoredInputCommits.get(String(threadId)) ?? [])]
            .filter(commit => authoredCommitOccurrences.get(commit) === authoredInputKey(entry.occurrence)),
        }];
      });
  }

  async function flushImplicitInputs(threadId, snapshot) {
    if (!implicitInputAcceptance || !inputDraftController) return;
    for (const entry of snapshot) {
      const issue = validateInputStage(entry.semantic, entry.value);
      if (issue) { inputErrors.set(entry.key, issue.message); throw new Error(issue.message); }
    }
    // Queue every captured answer before yielding, including behind saves
    // already owned by these occurrences. Later edits must follow the entire
    // captured boundary instead of slipping between its individual answers.
    const captures = snapshot.map(entry => {
      if (disposed || String(getThread()?.id) !== String(threadId)) throw new Error("Input selection changed before submission. Your answers were preserved.");
      return inputDraftController.commit(threadId, entry.occurrence, entry.semantic, entry.value, { skipIfUnchanged: true });
    });
    const boundaryDraft = inputDraftController.current(threadId);
    const pending = [...new Set(snapshot.flatMap(entry => entry.pendingCommits ?? []))];
    const saved = await Promise.allSettled([...pending, ...captures]);
    const failed = saved.find(result => result.status === "rejected" || result.value === false);
    if (failed) throw failed.reason ?? new Error("A connected input could not be saved.");
    return captures.length ? saved.at(-1).value : boundaryDraft;
  }

  function clearSubmittedImplicitStages(snapshot) {
    for (const entry of snapshot ?? []) {
      if ((inputEditEpochs.get(entry.key) ?? 0) !== entry.editEpoch) continue;
      inputStages.delete(entry.key);
      inputErrors.delete(entry.key);
      inputTouched.delete(entry.key);
    }
  }

  async function invokeWithConfirmedInputs(action) {
    const threadId = getThread()?.id;
    const boundaryKey = String(threadId);
    if (implicitInvokeBoundaries.has(boundaryKey)) return null;
    const recoveringCall = recoverableActionInvocation(getState().actionInvocations, currentInteraction(getState(), getThread())?.id, action.id);
    const sourceInteractionId = currentInteraction(getState(), getThread())?.id;
    const sourceLayerId = currentLayerId(getState(), getThread());
    const snapshot = recoveringCall ? [] : captureImplicitInputs(threadId, { action });
    implicitInvokeBoundaries.add(boundaryKey);
    syncBoundInvokeControls(getState());
    syncComposer();
    try {
    const capturedDraft = await flushImplicitInputs(threadId, snapshot);
    if (disposed || String(getThread()?.id) !== boundaryKey
      || currentInteraction(getState(), getThread())?.id !== sourceInteractionId
      || currentLayerId(getState(), getThread()) !== sourceLayerId) return null;
    const draft = inputDraftController?.current(threadId);
    const submitted = (draft?.attachments ?? []).filter((attachment) =>
      recoveringCall || !implicitInputAcceptance ? action.inputActionIds?.some(id => String(id) === String(attachment.occurrence.actionId))
        : snapshot.some(entry => inputOccurrenceKey(entry.occurrence) === inputOccurrenceKey(attachment.occurrence)))
      .map((attachment) => {
        const captured = snapshot.find(entry => inputOccurrenceKey(entry.occurrence) === inputOccurrenceKey(attachment.occurrence));
        return { attachment, displayKey: captured?.key, displayEditEpoch: captured?.editEpoch,
          editEpoch: captured?.sourceEditEpoch ?? inputEditEpochs.get(threadInputOccurrenceKey(threadId, attachment.occurrence)) ?? 0 };
      });
    const runtime = mountedAuthoredDetail;
    const node = (getState().nodes ?? []).find((candidate) => String(candidate.id) === String(action.sourceNodeId));
    const result = await (recoveringCall ? onInvokeAction(action) : onInvokeAction(action, { inputDraftRevision: capturedDraft?.revision ?? currentInputDraftRevision(threadId) }));
    let responseDraft = result?.inputDraft;
    if (!responseDraft && result?.recovered && submitted.length && inputDraftApi?.get) {
      try {
        responseDraft = await inputDraftApi.get(threadId);
      } catch (error) {
        toast(`Invoked, but committed inputs could not be refreshed: ${error.message}`);
        return result;
      }
    }
    if (!responseDraft || !inputDraftController) return result;
    const current = inputDraftController.adoptResponse(threadId, responseDraft);
    for (const { attachment, editEpoch, displayKey, displayEditEpoch } of submitted) {
      if (committedInputAttachment(current, attachment.occurrence)) continue;
      const semantic = attachment.action;
      const submittedValue = initialInputStageValue(semantic, attachment);
      const stageKey = threadInputOccurrenceKey(threadId, attachment.occurrence);
      if ((inputEditEpochs.get(stageKey) ?? 0) !== editEpoch) continue;
      if (inputStages.has(stageKey) && inputStageValuesEqual(semantic, inputStages.get(stageKey), submittedValue)) {
        inputStages.delete(stageKey);
        inputErrors.delete(stageKey);
        inputTouched.delete(stageKey);
      }
      if (runtime !== mountedAuthoredDetail || String(threadId) !== String(getThread()?.id)
        || (displayKey && (inputEditEpochs.get(displayKey) ?? 0) !== displayEditEpoch)) continue;
      const mount = node?.authoredDetail?.mounts?.find((candidate) => candidate.kind === "capability"
        && candidate.capability.kind === "input"
        && String(resolveCompiledNodeDetailAction(getState().actions, candidate.capability.action, node)?.id) === String(attachment.occurrence.actionId));
      const control = mount && [...(runtime?.host?.shadowRoot?.querySelectorAll("[data-gc-mount]") ?? [])]
        .find((element) => element.dataset.gcMount === mount.id);
      const value = semantic.control === "text" ? control?.value
        : control && [...control.selectedOptions].map((option) => option.value);
      if (control && inputStageValuesEqual(semantic, value, submittedValue)) {
        runtime.updateCapability(mount.id, { value: initialInputStageValue(semantic), busy: false, error: null });
      }
    }
    if (String(threadId) === String(getThread()?.id)) {
      markInputCompositionChanged(threadId);
      renderComposerContexts();
      if (selection.selectedNodeId != null) await selectNode(getState(), selection.selectedNodeId, { notify: false });
    }
    return result;
    } finally {
      implicitInvokeBoundaries.delete(boundaryKey);
      if (!disposed && String(getThread()?.id) === boundaryKey) {
        if (selection.selectedNodeId != null) await selectNode(getState(), selection.selectedNodeId, { notify: false });
        syncBoundInvokeControls(getState());
        syncComposer();
      }
    }
  }

  function inputConsumersExhausted(state, input) {
    if (input.liveInput && liveAnswerController?.receipt(getThread()?.id,
      createInputOccurrence(currentInteraction(state)?.graphNodeId, currentLayerId(state, getThread()), input.id))) return true;
    if (typeof input.inputCanAcceptAnswer === "boolean") return !input.inputCanAcceptAnswer;
    const consumers = (state.actions ?? []).filter(action => action.kind === "invoke"
      && action.inputActionIds?.some(id => String(id) === String(input.id)));
    if (!consumers.length) return false;
    return consumers.every(action => action.reusable === false && (state.actionInvocations ?? []).some(call =>
      String(call.actionId) === String(action.id) && !isRejectedActionPreparation(call)
      && (isDurableActionInvocation(call) || call.invocationKey)));
  }

  function boundInvokeIssue(state, action) {
    if (implicitInvokeBoundaries.has(String(getThread()?.id))) return "Saving inputs…";
    if (!action.inputActionIds?.length) return null;
    if (recoverableActionInvocation(state.actionInvocations, currentInteraction(state, getThread())?.id, action.id)) return null;
    const thread = getThread();
    if (!thread) return "Connected inputs are unavailable in this view.";
    const interaction = currentInteraction(state, thread);
    const layerId = currentLayerId(state, thread);
    const occurrence = (input) => interaction?.graphNodeId != null && layerId != null
      ? createInputOccurrence(interaction.graphNodeId, layerId, input.id) : null;
    if (implicitInputAcceptance && action.inputActionIds.every(id => {
      const input = (state.actions ?? []).find(candidate => String(candidate.id) === String(id));
      const key = input && occurrence(input);
      return key && implicitInputEntries.has(threadInputOccurrenceKey(thread.id, key));
    })) {
      for (const id of action.inputActionIds) {
        const input = (state.actions ?? []).find(candidate => String(candidate.id) === String(id) && candidate.kind === "input");
        if (!input) return "A connected input is unavailable.";
        const key = occurrence(input);
        if (!key) return "Connected inputs are unavailable.";
        const semantic = input.input ?? input;
        const stageKey = threadInputOccurrenceKey(thread.id, key);
        const attachment = boundInputAttachment(inputDraftController?.current(thread.id), input, key);
        const value = inputStages.has(stageKey) ? inputStages.get(stageKey) : initialInputStageValue(semantic, attachment);
        if (validateInputStage(semantic, value)) return `Enter ${semantic.prompt} before invoking.`;
      }
      return null;
    }
    return invokeInputIssue(action, {
      actions: state.actions ?? [],
      draft: inputDraftController?.current(thread?.id),
      occurrence,
      staged: (input) => {
        const key = occurrence(input);
        if (!key) return undefined;
        const plain = inputStages.get(threadInputOccurrenceKey(thread.id, key));
        if (plain !== undefined) return plain;
        const shadow = mountedAuthoredDetail?.host?.shadowRoot;
        const mount = (state.nodes ?? []).find((candidate) => String(candidate.id) === String(action.sourceNodeId))
          ?.authoredDetail?.mounts?.find((candidate) => candidate.kind === "capability"
            && candidate.capability.kind === "input"
            && String(resolveCompiledNodeDetailAction(state.actions, candidate.capability.action,
              (state.nodes ?? []).find((node) => String(node.id) === String(action.sourceNodeId)))?.id) === String(input.id));
        const control = mount && [...(shadow?.querySelectorAll("[data-gc-mount]") ?? [])]
          .find((element) => element.dataset.gcMount === mount.id);
        if (!control) return undefined;
        return (input.input ?? input).control === "text" ? control.value
          : [...control.selectedOptions].map((option) => option.value);
      },
      pending: (input) => {
        const key = occurrence(input);
        return key && (inputPending.has(threadInputOccurrenceKey(thread.id, key))
          || latestAuthoredInputCommits.has(`${thread.id}\u0000${authoredInputKey(key)}`));
      },
    });
  }

  function syncBoundInvokeControls(state) {
    const inspector = $("#inspector");
    if (disposed || !inspector) return;
    for (const button of inspector.querySelectorAll("[data-bound-invoke-id]")) {
      if (button.dataset.invocationResultInteractionId) continue;
      const action = state.actions?.find((item) => String(item.id) === button.dataset.boundInvokeId);
      if (!action) continue;
      const issue = boundInvokeIssue(state, action);
      button.disabled = button.dataset.invokeBaseDisabled === "true" || Boolean(issue);
      button.title = issue || "";
    }
    const shadow = mountedAuthoredDetail?.host?.shadowRoot;
    for (const button of shadow?.querySelectorAll("[data-bound-invoke-id]") ?? []) {
      if (button.dataset.invocationResultInteractionId) continue;
      const action = state.actions?.find((item) => String(item.id) === button.dataset.boundInvokeId);
      if (!action) continue;
      const mountId = button.dataset.gcMount;
      mountedAuthoredDetail.updateCapability(mountId, {
        disabled: button.dataset.invokeBaseDisabled === "true" || Boolean(boundInvokeIssue(state, action)),
      });
    }
  }

  function restoreGroupedInvokeControls() {
    const host = $("#nodeInputActions");
    for (const group of host.querySelectorAll(".invoke-input-group")) {
      for (const wrapper of group.querySelectorAll(".action-annotation-wrap")) $("#detailActions").append(wrapper);
    }
  }

  function groupNodeInvokeInputs(state, node) {
    const host = $("#nodeInputActions");
    const actions = (state.actions ?? []).filter((action) => String(action.sourceNodeId) === String(node.id));
    for (const { inputIds, invokes } of invokeInputGroups(actions)) {
      const fields = [...host.querySelectorAll(".node-input-editor")]
        .filter((field) => inputIds.has(field.dataset.reviewActionId));
      const wrappers = invokes.map((invoke) => [...$("#detailActions").querySelectorAll("[data-action-id]")]
        .find((control) => control.dataset.actionId === String(invoke.id))?.closest(".action-annotation-wrap"))
        .filter(Boolean);
      if (!fields.length || !wrappers.length) continue;
      const group = graphDocument.createElement("section");
      group.className = "invoke-input-group";
      group.setAttribute("aria-label", `Inputs for ${invokes.map((invoke) => invoke.label).join(" and ")}`);
      fields[0].before(group);
      group.append(...fields);
      const rail = graphDocument.createElement("div");
      rail.className = "invoke-input-controls";
      rail.append(...wrappers);
      group.append(rail);
    }
    $("#detailActions").classList.toggle("hidden", !$("#detailActions").children.length);
    syncBoundInvokeControls(state);
  }

  function liveAnswerButton(state, node, action, occurrence) {
    const thread = getThread();
    const interaction = currentInteraction(state, thread);
    const stageKey = threadInputOccurrenceKey(thread.id, occurrence);
    const semantic = action.input ?? action;
    const receipt = action.liveInput?.receipt ?? liveAnswerController?.receipt(thread.id, occurrence);
    const button = graphDocument.createElement("button");
    button.type = "button";
    button.className = "node-input-operator-send";
    button.dataset.inputControlRole = "answer";
    button.dataset.liveAnswerScope = JSON.stringify(occurrence);
    button.textContent = receipt ? "Delivered" : "Answer";
    button.setAttribute("aria-label", `${receipt ? "Delivered answer for" : "Answer"} ${semantic.prompt}`);
    button.disabled = mode !== "interactive" || !capabilities.canCompose || !liveAnswerController || Boolean(receipt)
      || !action.liveInput?.eligible || inputPending.has(stageKey)
      || Boolean(validateInputStage(semantic, inputStages.get(stageKey)));
    button.onclick = async () => {
      if (button.disabled) return;
      const staged = inputStages.get(stageKey);
      const value = semantic.control === "text" ? { text: staged }
        : { selected: semantic.options.filter(option => staged.includes(String(option.key))).sort((a, b) => a.key.localeCompare(b.key)) };
      inputPending.begin(stageKey);
      button.disabled = true;
      inputErrors.delete(stageKey);
      try {
        await liveAnswerController.answer(thread.id, interaction.id, {
          occurrence, attemptId: action.liveInput.attemptId, authorityEpoch: action.liveInput.authorityEpoch,
          expectedRevision: action.liveInput.currentRevision,
        }, value);
        inputTouched.delete(stageKey);
      } catch (error) { inputErrors.set(stageKey, error.message); }
      finally {
        inputPending.end(stageKey);
        if (String(getThread()?.id) === String(thread.id) && String(selection.selectedNodeId) === String(node.id)) {
          await selectNode(getState(), node.id, { notify: false });
        }
      }
    };
    return button;
  }

  function renderAuthoredLiveAnswers(state, node, actions) {
    const thread = getThread();
    const interaction = currentInteraction(state, thread);
    const layerId = currentLayerId(state, thread);
    const host = $("#nodeInputActions");
    const live = actions.filter(action => action.liveInput);
    host.classList.toggle("hidden", !live.length);
    host.replaceChildren(...live.flatMap(action => {
      const occurrence = createInputOccurrence(interaction.graphNodeId, layerId, action.id);
      const error = graphDocument.createElement("p");
      error.className = "node-input-error";
      error.textContent = inputErrors.get(threadInputOccurrenceKey(thread.id, occurrence)) || "";
      return [liveAnswerButton(state, node, action, occurrence), error];
    }));
  }

  function renderNodeInputActions(state, node, actions, { groupInvokes = true } = {}) {
    restoreGroupedInvokeControls();
    const host = $("#nodeInputActions");
    host.classList.toggle("hidden", actions.length === 0);
    if (!actions.length) {
      host.replaceChildren();
      return;
    }
    const thread = getThread();
    const interaction = currentInteraction(state, thread);
    const layerId = currentLayerId(state, thread);
    const immutableReviewInput = mode === "review";
    if ((!inputDraftController || !loadedInputDraftThreads.has(String(thread?.id))) && !immutableReviewInput) {
      const status = graphDocument.createElement("p");
      status.className = "node-input-status";
      status.textContent = inputDraftController
        ? "Loading committed inputs…"
        : "Input editing is unavailable in this view.";
      host.replaceChildren(status);
      return;
    }
    if (interaction?.graphNodeId == null || layerId == null) {
      const status = graphDocument.createElement("p");
      status.className = "node-input-status";
      status.textContent = "This input occurrence is not available in the selected history view.";
      host.replaceChildren(status);
      return;
    }

    const activeControl = graphDocument.activeElement;
    const activeKey = activeControl?.closest?.("[data-input-occurrence-key]")
      ?.dataset.inputOccurrenceKey;
    const activeRole = activeControl?.dataset?.inputControlRole;
    const activeOptionKey = activeControl?.dataset?.optionKey;
    const activeTextState = activeRole === "value"
      ? captureTextControlState(activeControl)
      : null;
    for (const rail of host.querySelectorAll("[data-input-rail-key]")) {
      inputRailScroll.set(rail.dataset.inputRailKey, rail.scrollLeft);
    }
    const draft = immutableReviewInput
      ? { revision: 0, attachments: [] }
      : inputDraftController.current(thread.id);
    const sections = actions.map((action) => {
      // Product state projects the accepted input payload onto the action record. Keep the
      // nested form compatible with direct graph-shaped fixtures and older snapshots.
      const semantic = action.input || action;
      const occurrence = createInputOccurrence(interaction.graphNodeId, layerId, action.id);
      const stageKey = threadInputOccurrenceKey(thread.id, occurrence);
      const attachment = displayedInputAttachment(draft, action, occurrence);
      const liveReceipt = action.liveInput?.receipt ?? liveAnswerController?.receipt(thread.id, occurrence);
      const committedValue = liveReceipt ? (semantic.control === "text" ? liveReceipt.value.text : liveReceipt.value.selected.map(option => String(option.key))) : initialInputStageValue(semantic, attachment);
      implicitInputEntries.set(stageKey, { occurrence, semantic, action,
        composerEligible: !action.liveInput && !(state.actions ?? []).some(candidate => candidate.kind === "invoke"
          && candidate.inputActionIds?.some(id => String(id) === String(action.id))) });
      if (!inputStages.has(stageKey) || !inputTouched.has(stageKey)) inputStages.set(stageKey, committedValue);
      const fieldset = graphDocument.createElement("fieldset");
      fieldset.className = "node-input-editor";
      fieldset.dataset.inputOccurrenceKey = stageKey;
      if (action.liveInput) fieldset.dataset.liveAnswerScope = JSON.stringify(occurrence);
      fieldset.dataset.reviewCapture = inputActionReviewRef(occurrence);
      fieldset.dataset.reviewActionId = String(action.id);
      fieldset.setAttribute("aria-label", `Input action: ${semantic.prompt}`);
      const legend = graphDocument.createElement("legend");
      legend.textContent = semantic.prompt;
      fieldset.append(legend);

      let control;
      if (semantic.control === "text") {
        control = graphDocument.createElement("textarea");
        control.className = "node-input-text";
        control.rows = 3;
        control.value = inputStages.get(stageKey);
        control.setAttribute("aria-label", semantic.prompt);
        control.dataset.inputControlRole = "value";
        fieldset.append(control);
      } else {
        control = graphDocument.createElement("div");
        control.className = "node-input-option-rail";
        control.classList.toggle("node-input-option-rail-compact", (semantic.options || []).length <= 3);
        control.dataset.optionCount = String((semantic.options || []).length);
        control.dataset.inputRailKey = stageKey;
        control.dataset.inputControlRole = "rail";
        control.setAttribute("aria-label", semantic.prompt);
        control.setAttribute("role", semantic.control === "single_select" ? "radiogroup" : "group");
        for (const option of semantic.options || []) {
          const selected = inputStages.get(stageKey).includes(String(option.key));
          const button = graphDocument.createElement("button");
          button.type = "button";
          button.className = "node-input-option";
          button.classList.toggle("selected", selected);
          button.dataset.optionKey = String(option.key);
          button.dataset.inputControlRole = "option";
          button.setAttribute("role", semantic.control === "single_select" ? "radio" : "checkbox");
          button.setAttribute("aria-checked", String(selected));
          const visual = graphDocument.createElement("span");
          visual.className = "node-input-option-visual";
          visual.setAttribute("aria-hidden", "true");
          visual.textContent = String(option.label || option.key).slice(0, 1).toUpperCase();
          const label = graphDocument.createElement("span");
          label.className = "node-input-option-label";
          label.textContent = option.label;
          button.append(visual, label);
          button.onclick = () => {
            if (button.disabled) return;
            noteInputEdit(stageKey);
            const key = String(option.key);
            const current = inputStages.get(stageKey);
            inputStages.set(stageKey, semantic.control === "single_select"
              ? [key]
              : current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
            inputErrors.delete(stageKey);
            inputTouched.add(stageKey);
            renderNodeInputActions(state, node, actions);
            syncComposer();
          };
          button.onkeydown = (event) => {
            if (!new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"])
              .has(event.key)) return;
            event.preventDefault();
            const options = [...control.querySelectorAll("button")];
            const index = options.indexOf(button);
            const nextIndex = event.key === "Home" ? 0
              : event.key === "End" ? options.length - 1
                : (index + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1)
                  + options.length) % options.length;
            const next = options[nextIndex];
            if (semantic.control === "single_select") {
              inputFocusRequest = { stageKey, optionKey: next?.dataset.optionKey };
              next?.click();
            }
            else next?.focus({ preventScroll: true });
            next?.scrollIntoView({ block: "nearest", inline: "nearest" });
          };
          control.append(button);
        }
        fieldset.append(control);
      }

      const footer = graphDocument.createElement("div");
      footer.className = "node-input-editor-footer";
      const error = graphDocument.createElement("p");
      error.className = "node-input-error";
      error.setAttribute("aria-live", "polite");
      const actionsHost = graphDocument.createElement("div");
      actionsHost.className = "node-input-symbols";
      const undo = graphDocument.createElement("button");
      undo.type = "button";
      undo.className = "node-input-symbol node-input-undo";
      undo.textContent = "↶";
      undo.title = `Undo ${semantic.prompt}`;
      undo.setAttribute("aria-label", `Undo ${semantic.prompt}`);
      undo.dataset.inputControlRole = "undo";
      const commit = graphDocument.createElement("button");
      commit.type = "button";
      commit.className = "node-input-symbol node-input-commit";
      commit.textContent = "✓";
      commit.title = `Commit ${semantic.prompt}`;
      commit.setAttribute("aria-label", `Commit ${semantic.prompt}`);
      commit.dataset.inputControlRole = "commit";
      const sync = () => {
        const staged = inputStages.get(stageKey);
        const issue = validateInputStage(semantic, staged);
        const persistedError = inputErrors.get(stageKey);
        error.textContent = persistedError || (inputTouched.has(stageKey) ? issue?.message : "") || "";
        const pending = inputPending.has(stageKey);
        const locked = (action.liveInput ? mode !== "interactive" || !capabilities.canCompose : contextStagingDisabled()) || pending || inputConsumersExhausted(state, action);
        control.disabled = locked;
        for (const option of control.querySelectorAll?.("button") || []) option.disabled = locked;
        undo.disabled = locked || inputStageValuesEqual(semantic, staged, committedValue);
        commit.disabled = locked || Boolean(issue)
          || (attachment && inputStageValuesEqual(semantic, staged, committedValue));
        commit.classList.toggle("node-input-committed", Boolean(attachment)
          && inputStageValuesEqual(semantic, staged, committedValue));
        fieldset.setAttribute("aria-busy", String(pending));
        syncBoundInvokeControls(state);
      };
      if (semantic.control === "text") {
        control.oninput = () => {
          noteInputEdit(stageKey);
          inputStages.set(stageKey, control.value);
          inputErrors.delete(stageKey);
          inputTouched.add(stageKey);
          sync();
          if (action.liveInput) actionsHost.replaceChildren(liveAnswerButton(state, node, action, occurrence));
          syncComposer();
        };
      }
      undo.onclick = () => {
        noteInputEdit(stageKey);
        inputStages.set(stageKey, committedValue);
        inputErrors.delete(stageKey);
        // The answer that failed is gone, with its error, so it stops no Send.
        failedAuthoredInputs.get(String(thread.id))?.delete(authoredInputKey(occurrence));
        authoredInputErrors.delete(`${thread.id}\u0000${authoredInputKey(occurrence)}`);
        inputTouched.delete(stageKey);
        renderNodeInputActions(state, node, actions);
        syncComposer();
      };
      commit.onclick = async () => {
        if (commit.disabled) return;
        const commitSelection = {
          threadId: thread.id,
          nodeId: node.id,
          presentingInteractionNodeId: interaction.graphNodeId,
          presentingLayerId: layerId,
        };
        inputErrors.delete(stageKey);
        committingInputStages.add(stageKey);
        beginNodeInputMutation({
          inputPending,
          stageKey,
          repaintNodeInputs: () => renderNodeInputActions(state, node, actions),
          renderComposer: syncComposer,
        });
        try {
          // A Send clicked meanwhile waits for this answer, and stops if it
          // does not save, as for an authored input.
          const next = await trackAuthoredInputCommit(
            thread.id,
            authoredInputKey(occurrence),
            inputDraftController.commit(
              thread.id,
              occurrence,
              semantic,
              inputStages.get(stageKey),
            ),
          );
          const nextAttachment = committedInputAttachment(next, occurrence);
          inputStages.set(stageKey, initialInputStageValue(semantic, nextAttachment));
          markInputCompositionChanged(thread.id);
        } catch (commitError) {
          inputErrors.set(stageKey, commitError?.message || "Input could not be committed.");
        } finally {
          committingInputStages.delete(stageKey);
          settleNodeInputCommit({
            inputPending,
            stageKey,
            originalSelection: commitSelection,
            currentSelection: () => {
              const currentState = getState();
              const currentThread = getThread();
              return {
                threadId: currentThread?.id,
                nodeId: selection.selectedNodeId,
                presentingInteractionNodeId: currentInteraction(
                  currentState,
                  currentThread,
                )?.graphNodeId,
                presentingLayerId: currentLayerId(currentState, currentThread),
              };
            },
            repaintNodeInputs: () => renderNodeInputActions(getState(), node, actions),
            renderComposer: renderComposerContexts,
          });
        }
      };
      if (action.liveInput) actionsHost.append(liveAnswerButton(state, node, action, occurrence));
      else if (implicitInputAcceptance) actionsHost.append(undo);
      else actionsHost.append(undo, commit);
      footer.append(error, actionsHost);
      fieldset.append(footer);
      sync();
      return fieldset;
    });
    const operatorSend = immutableReviewInput && inputOperatorAvailable
      ? (() => {
          const button = graphDocument.createElement("button");
          button.type = "button";
          button.className = "node-input-operator-send";
          button.dataset.reviewRef = "send-interaction";
          button.dataset.reviewKind = "input-operator-send";
          button.setAttribute("aria-label", "Send committed input answers");
          button.textContent = "Send answers";
          button.disabled = !inputOperatorCommitted;
          return button;
        })()
      : null;
    host.replaceChildren(...sections, ...(operatorSend ? [operatorSend] : []));
    if (groupInvokes) groupNodeInvokeInputs(state, node);
    for (const rail of host.querySelectorAll("[data-input-rail-key]")) {
      rail.scrollLeft = inputRailScroll.get(rail.dataset.inputRailKey) || 0;
    }
    if (activeKey && activeRole) {
      const editor = [...host.querySelectorAll("[data-input-occurrence-key]")]
        .find((item) => item.dataset.inputOccurrenceKey === activeKey);
      const restored = activeRole === "option"
        ? [...editor?.querySelectorAll("[data-option-key]") || []]
          .find((item) => item.dataset.optionKey === activeOptionKey)
        : editor?.querySelector(`[data-input-control-role="${activeRole}"]`);
      restored?.focus({ preventScroll: true });
      restoreTextControlState(restored, activeTextState);
    }
    if (inputFocusRequest) {
      const requested = inputFocusRequest;
      inputFocusRequest = null;
      const editor = [...host.querySelectorAll("[data-input-occurrence-key]")]
        .find((item) => item.dataset.inputOccurrenceKey === requested.stageKey);
      const replacement = [...editor?.querySelectorAll("[data-option-key]") || []]
        .find((item) => item.dataset.optionKey === requested.optionKey);
      replacement?.focus({ preventScroll: true });
      replacement?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  async function selectNode(state, id, {
    notify = true,
    userInitiated = notify,
    focusInspector = false,
    contextTarget,
    origin = null,
  } = {}) {
    const scopeThread = getThread();
    const scopeInteraction = currentInteraction(state, scopeThread);
    const scopeLayer = currentLayerId(state, scopeThread);
    if (scopeThread?.id != null && scopeInteraction?.graphNodeId != null && scopeLayer != null) {
      for (const input of (state.actions ?? []).filter(action => action.kind === "input")) {
        const occurrence = createInputOccurrence(scopeInteraction.graphNodeId, scopeLayer, input.id);
        inputScopeObservations.set(threadInputOccurrenceKey(scopeThread.id, occurrence), !(state.actions ?? []).some(action =>
          action.kind === "invoke" && action.inputActionIds?.some(id => String(id) === String(input.id))));
      }
    }

    if (disposed) return false;
    const options = { notify, userInitiated, focusInspector, contextTarget, origin };
    if (contextEditor?.resolving) {
      // A refresh is dropped: the resolution re-renders the selection when it
      // ends. A user's click waits its turn and uses the state it finds then.
      if (!userInitiated) return false;
      // It supersedes the request in flight, such as a switch waiting on the
      // draft save, so only the newest request selects.
      nodeSelectionSequence += 1;
      const viewEpoch = graphViewEpoch;
      if (!await awaitUserRequestTurn()) return false;
      const latest = getState();
      // A click made in a view the user has since left is void, even after
      // returning to a view with the same key.
      if (graphViewEpoch !== viewEpoch
        || !resolveInteractionContextNode(id, latest.nodes, composerContextState.value, contextNodeOverrides)) {
        refreshSelection();
        return false;
      }
      return selectNode(latest, id, options);
    }
    const requestSequence = ++nodeSelectionSequence;
    // A user's request that proceeds at once voids any still waiting.
    if (userInitiated) userRequestTicket += 1;
    const sourceThread = getThread();
    const sourceThreadId = String(sourceThread?.id);
    const node = resolveInteractionContextNode(
      id,
      state.nodes,
      composerContextState.value,
      contextNodeOverrides,
    );
    if (!node) return false;
    const nextSelectedContextTarget = contextTarget !== undefined
      ? contextTarget || null
      : (notify ? null : selectedContextTarget);
    const interaction = currentInteraction(state, sourceThread);
    const nextTarget = interactionContextTargetForEditor({
      nodeId: node.id,
      selectedContextTarget: nextSelectedContextTarget,
      sourceInteractionNodeId: interaction?.graphNodeId,
      sourceLayerId: currentLayerId(state),
    });
    const switchingDurableDraft = contextEditor?.durable
      && interactionContextTargetKey(contextEditor.target)
        !== interactionContextTargetKey(nextTarget);
    if (switchingDurableDraft) {
      const previousEditor = contextEditor;
      const mountedTextarea = $("#nodeContextDock #contextAnnotationEditor");
      const endResolution = beginEditorResolution(previousEditor);
      let saved = false;
      try {
        renderNodeContextDock();
        saved = await saveContextDraftBeforeSelection({
          controller: contextDraftController,
          editor: previousEditor,
          textarea: mountedTextarea,
        });
      } catch {
        saved = false;
      } finally {
        if (!saved) endResolution();
      }
      if (requestSequence !== nodeSelectionSequence
        || String(getThread()?.id) !== sourceThreadId) {
        endResolution();
        if (contextEditor === previousEditor) renderComposerContexts();
        return false;
      }
      if (!saved) {
        // The switch is refused; the kept node, whose own detail this
        // request superseded, was re-rendered as the draft resolved.
        contextEditor = previousEditor;
        renderComposerContexts();
        return false;
      }
      contextEditor = null;
      endResolution({ refresh: false });
      // Continue from the latest state, not the one read before the save.
      const latest = getState();
      if (!resolveInteractionContextNode(id, latest.nodes, composerContextState.value, contextNodeOverrides)) {
        // The destination is gone: the kept node is shown again, with its
        // saved draft's editor.
        refreshSelection();
        return false;
      }
      return selectNode(latest, id, options);
    }
    if (requestSequence !== nodeSelectionSequence
      || String(getThread()?.id) !== sourceThreadId) return false;
    if (selection.selectedNodeId != null && String(selection.selectedNodeId) !== String(id)) {
      clearInputStagesForThread(getThread()?.id);
    }
    selection.selectedNodeId = id;
    if (state.visibleLayer?.nodes?.some((member) => String(member.id) === String(id))) {
      rememberLayerSelection(getThread()?.id, state.currentInteractionId, state.visibleLayer?.layer?.id, id, layerSelectionMemoryOwner);
    }
    selectedContextTarget = nextSelectedContextTarget;
    if (!contextEditor && contextDraftController) {
      const draft = nodeContextDraftForSelection(
        contextDraftController.draftForNode(getThread()?.id, node.id),
        node,
        nextTarget,
      );
      if (draft) {
        contextEditor = durableContextEditorForDraft(getThread()?.id, node, draft, {
          attaching: !contextForTarget(draft.target),
          error: restoredContextEditorError(String(getThread()?.id), draft.id),
        });
        adoptDraftOperation(contextEditor, getThread()?.id, node.id);
      }
    }
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
    const { reveal } = openInspector({ userInitiated, origin });
    $("#detailIcon").dataset.family = relayerIconFamily(node.icon || node.metadata?.relayer?.icon);
    $("#detailIcon").dataset.imageIcon = String(Boolean(imageIconReference(node.icon)));
    releaseDetachedIcons();
    $("#detailKind").textContent = node.kind;
    $("#detailTitle").textContent = node.title;
    const actions = (state.actions || []).filter((action) => String(action.sourceNodeId) === String(node.id));
    const inputActions = actions.filter((action) => action.kind === "input" && action.control);
    const ordinaryActions = actions.filter((action) => action.kind !== "input");
    const visibleLayer = state.visibleLayer ?? interaction?.completionOutput?.rootLayer;
    const detailContextTarget = String(selectedContextTarget?.nodeId) === String(node.id)
      ? selectedContextTarget : null;
    const assetInteraction = detailContextTarget
      ? state.interactions?.find((candidate) => String(candidate.graphNodeId) === String(detailContextTarget.sourceInteractionNodeId)
        && String(candidate.threadId) === String(sourceThread?.id))
      : interaction;
    const assetThread = sourceThread;
    const assetLayerId = detailContextTarget?.sourceLayerId ?? visibleLayer?.layer?.id;
    $("#detailIcon").replaceChildren(createRelayerIcon(
      node.icon || node.metadata?.relayer?.icon,
      { class: "relayer-detail-icon" }, node, { thread: assetThread, interaction: assetInteraction, layerId: assetLayerId },
    ));
    releaseDetachedIcons();
    const resolveAuthoredAction = (reference) => resolveCompiledNodeDetailAction(
      actions,
      reference,
      node,
    );
    // Register authored occurrences before any Invoke readiness check, including
    // first mounts with no standard-control predecessor.
    if (implicitInputAcceptance && inputDraftController && interaction?.graphNodeId != null && visibleLayer?.layer?.id != null) {
      for (const action of inputActions) {
        const occurrence = createInputOccurrence(interaction.graphNodeId, visibleLayer.layer.id, action.id);
        const key = threadInputOccurrenceKey(getThread()?.id, occurrence);
        implicitInputEntries.set(key, { occurrence, action, semantic: action.input ?? action,
          composerEligible: !action.liveInput && !(state.actions ?? []).some(candidate => candidate.kind === "invoke"
            && candidate.inputActionIds?.some(id => String(id) === String(action.id))) });
        const liveReceipt = action.liveInput?.receipt ?? liveAnswerController?.receipt(getThread()?.id, occurrence);
        if (!inputStages.has(key) || !inputTouched.has(key)) inputStages.set(key, liveReceipt
          ? (action.control === "text" ? liveReceipt.value.text : liveReceipt.value.selected.map(option => String(option.key)))
          : initialInputStageValue(action.input ?? action, displayedInputAttachment(inputDraftController.current(getThread()?.id), action, occurrence)));
      }
    }
    const authoredCapabilityState = {};
    for (const mount of node.authoredDetail?.mounts ?? []) {
      if (mount.kind !== "capability" || mount.capability.kind === "link") continue;
      const action = resolveAuthoredAction(mount.capability.action);
      if (!action) {
        authoredCapabilityState[mount.id] = { disabled: true, error: "This action is unavailable in the accepted detail." };
      } else if (isResolvedInvokeAction(action)) {
        authoredCapabilityState[mount.id] = { disabled: false, busy: false, error: null };
      } else if (action.kind === "invoke") {
        const destination = singleCallResultDestination(state, action, node, actions);
        const invoked = actionWasInvoked(
          state.actionInvocations,
          state.pendingActionInvocations,
          state.currentInteractionId,
          action.id,
          action.reusable,
        );
        authoredCapabilityState[mount.id] = {
          disabled: !destination && (actionActivationPresentation(action, {
            invoked,
            retryable: actionCanRetry(state.actionInvocations, action.id),
            canInvokeMutatingActions: capabilities.canInvokeMutatingActions && state.invocationInventoryAvailable === true,
            imported: getThread()?.imported,
          }).disabled || Boolean(boundInvokeIssue(state, action))),
        };
      } else if (action.kind === "input") {
        const occurrence = interaction?.graphNodeId != null && visibleLayer?.layer?.id != null
          ? createInputOccurrence(interaction.graphNodeId, visibleLayer.layer.id, action.id)
          : null;
        const attachment = occurrence && inputDraftController
          ? displayedInputAttachment(inputDraftController.current(getThread()?.id), action, occurrence)
          : null;
        const failure = occurrence
          ? authoredInputErrors.get(`${getThread()?.id}\u0000${authoredInputKey(occurrence)}`)
          : null;
        authoredCapabilityState[mount.id] = {
          ...(action.liveInput && occurrence ? { liveAnswerScope: JSON.stringify(occurrence) } : {}),
          // A presentation replacement transfers an existing pending standard
          // value. The same occurrence registry continues to own its epoch;
          // authored edit callbacks below keep it current until submission.
          value: occurrence && implicitInputEntries.has(threadInputOccurrenceKey(getThread()?.id, occurrence))
            && inputStages.has(threadInputOccurrenceKey(getThread()?.id, occurrence))
            ? inputStages.get(threadInputOccurrenceKey(getThread()?.id, occurrence))
            : initialInputStageValue(action, attachment),
          ...(failure ? { error: failure } : {}),
          // Locked while a Send is in flight, so no commit races its
          // reservation. A commit during a run goes to the next draft (ADR 0008).
          disabled: inputConsumersExhausted(state, action) || mode === "review"
            || !inputDraftController
            || !loadedInputDraftThreads.has(String(getThread()?.id))
            || occurrence === null
            || sendAttemptBlocksThread(sendAttempt?.threadId, getThread()?.id)
            || threadHasInFlightSend(inFlightSendThreads, getThread()?.id),
        };
      }
    }
    let authoredDetailRuntime;
    const authoredDetailMountKey = [
      assetThread?.id,
      assetInteraction?.id,
      node.id,
      assetLayerId,
      node.authoredDetail?.integritySha256 ?? "legacy",
    ].map(String).join(":");
    const authoredDetailCompatibilityIssue = node.authoredDetail
      && !compiledNodeDetailCoversActions(node.authoredDetail, actions, node)
      ? "This authored detail does not bind every accepted node action."
      : null;
    const authoredDetail = await renderProductNodeDetail({
      container: $("#detailContent"),
      node,
      mountKey: authoredDetailMountKey,
      existing: mountedAuthoredDetail,
      compatibilityIssue: authoredDetailCompatibilityIssue,
      resolveAsset: (asset) => resolveNodeDetailAsset(asset, { node, state, thread: assetThread, interaction: assetInteraction, layerId: assetLayerId }),
      resolveAction: resolveAuthoredAction,
      capabilityState: authoredCapabilityState,
      onNavigate: async (action) => {
        if (!await prepareNodeContextSelectionChange()) return;
        if (usesResolvedInvokeDestination(action, getThread()?.imported)) {
          await onNavigateResolvedInvoke(action, { beforeCommit: collapseContextPreviews });
          return;
        }
        await onNavigateLayer(action.targetLayerId, {
          action,
          sourceNode: node,
          beforeCommit: collapseContextPreviews,
        });
      },
      onInvoke: async (action) => {
        const destination = singleCallResultDestination(getState(), action, node, actions);
        if (destination) {
          if (!await prepareNodeContextSelectionChange()) return;
          await onNavigateLayer(destination.layerId, { action, sourceNode: node });
          return;
        }
        const activation = actionActivationPresentation(action, {
          invoked: actionWasInvoked(
            state.actionInvocations,
            state.pendingActionInvocations,
            state.currentInteractionId,
            action.id,
            action.reusable,
          ),
          retryable: actionCanRetry(state.actionInvocations, action.id),
          canInvokeMutatingActions: capabilities.canInvokeMutatingActions && state.invocationInventoryAvailable === true,
          imported: getThread()?.imported,
        });
        if (activation.navigational) {
          if (!await prepareNodeContextSelectionChange()) return;
          await navigateWorkspaceAction({
            action,
            activation,
            sourceNode: node,
            collapseContextPreviews,
            onNavigateResolvedInvoke,
            onNavigateLayer,
          });
        } else {
          if (activation.disabled) return;
          if (boundInvokeIssue(getState(), action)) return;
          await invokeWithConfirmedInputs(action);
        }
      },
      onInputEdit: (context, value, submitted) => {
        const threadId = String(getThread()?.id);
        const inputMount = node.authoredDetail?.mounts?.find((mount) => mount.id === context.mountId);
        const inputAction = inputMount && resolveAuthoredAction(inputMount.capability?.action);
        if (value !== null && inputAction && interaction?.graphNodeId != null && visibleLayer?.layer?.id != null) {
          const stageKey = threadInputOccurrenceKey(threadId, createInputOccurrence(interaction.graphNodeId, visibleLayer.layer.id, inputAction.id));
          if (implicitInputEntries.has(stageKey)) {
            inputStages.set(stageKey, structuredClone(value));
            inputTouched.add(stageKey);
          }
          noteInputEdit(stageKey);
        }
        const editKey = `${authoredDetailMountKey}\u0000${context.mountId}`;
        const refusalKey = refusedInputKey(authoredDetailMountKey, context.mountId);
        if (typeof value === "string" && failedAuthoredInputs.get(threadId)?.delete(refusalKey)) {
          authoredInputErrors.delete(`${threadId}\u0000${refusedInputOccurrences.get(refusalKey)}`);
        }
        if (typeof value === "string" && value.trim()) authoredInputEdits.set(editKey, threadId);
        else authoredInputEdits.delete(editKey);
        const occurrence = inputAction && interaction?.graphNodeId != null && visibleLayer?.layer?.id != null
          ? createInputOccurrence(interaction.graphNodeId, visibleLayer.layer.id, inputAction.id) : null;
        composerInputEdits.set(editKey, !inputAction?.liveInput && (occurrence ? isComposerInputOccurrence(occurrence) : true));
        // A null edit only clears the authored field's editing bookkeeping.
        // Replacing Answer on blur detaches its pointer-down target before
        // pointer-up, so the browser never dispatches the delivery click.
        if (inputAction?.liveInput && value !== null) renderAuthoredLiveAnswers(getState(), node, inputActions);
        if (submitted) trackAuthoredInputSubmit(threadId, submitted, refusalKey, occurrence);
        syncBoundInvokeControls(getState());
        syncComposer();
      },
      onInput: async (action, value, context) => {
        if (action.liveInput) return;
        const thread = getThread();
        const interactionNodeId = currentInteraction(state, thread)?.graphNodeId;
        const layerId = currentLayerId(state, thread);
        // A refused answer throws, so the runtime shows why and reports it.
        const issue = validateInputStage(action, value);
        if (issue) {
          if (interactionNodeId != null && layerId != null) {
            const inputKey = authoredInputKey(createInputOccurrence(interactionNodeId, layerId, action.id));
            refusedInputOccurrences.set(refusedInputKey(authoredDetailMountKey, context.mountId), inputKey);
            // Shown again if the Node Detail remounts before the Send it stops.
            authoredInputErrors.set(`${thread.id}\u0000${inputKey}`, issue.message);
          }
          throw new Error(issue.message);
        }
        if (!inputDraftController || interactionNodeId == null || layerId == null) {
          authoredDetailRuntime?.updateCapability(context.mountId, { disabled: true });
          throw new Error("Input editing is unavailable in this view.");
        }
        const occurrence = createInputOccurrence(interactionNodeId, layerId, action.id);
        const stageKey = threadInputOccurrenceKey(thread.id, occurrence);
        const saveEpoch = inputEditEpochs.get(stageKey) ?? 0;
        authoredDetailRuntime?.updateCapability(context.mountId, { busy: true, error: null });
        try {
          const draft = await trackAuthoredInputCommit(
            thread.id,
            authoredInputKey(occurrence),
            inputDraftController.commit(thread.id, occurrence, action, value),
          );
          const attachment = committedInputAttachment(draft, occurrence);
          markInputCompositionChanged(thread.id);
          authoredDetailRuntime?.updateCapability(context.mountId, {
            busy: false,
            ...((inputEditEpochs.get(stageKey) ?? 0) === saveEpoch ? { value: initialInputStageValue(action, attachment) } : {}),
            error: null,
          });
          renderComposerContexts();
        } catch (error) {
          authoredDetailRuntime?.updateCapability(context.mountId, {
            busy: false,
            error: error?.message || "Input could not be committed.",
          });
          throw error;
        } finally {
          syncBoundInvokeControls(getState());
        }
      },
    });
    authoredDetailRuntime = authoredDetail;
    if (requestSequence !== nodeSelectionSequence
      || String(getThread()?.id) !== sourceThreadId) {
      if (authoredDetail !== mountedAuthoredDetail) authoredDetail.dispose?.();
      return false;
    }
    // Edits another mount's fields left behind were never committed. This
    // mount's fields can be edited while its assets load, so theirs are kept.
    if (authoredDetail !== mountedAuthoredDetail) {
      for (const editKey of [...authoredInputEdits.keys()]) {
        if (!editKey.startsWith(`${authoredDetailMountKey}\u0000`)) authoredInputEdits.delete(editKey);
      }
    }
    mountedAuthoredDetail = authoredDetail.authored ? authoredDetail : null;
    if (authoredDetail.authored) {
      renderAuthoredLiveAnswers(state, node, inputActions);
      $("#detailActions").replaceChildren();
      $("#detailActions").classList.add("hidden");
    } else {
      renderNodeInputActions(state, node, inputActions, { groupInvokes: false });
      $("#detailActions").classList.toggle("hidden", !ordinaryActions.length);
    }
    if (!authoredDetail.authored) {
      $("#detailActions").replaceChildren(...ordinaryActions.map((action) => {
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
          button.append(createRelayerIcon(presentation.icon, { class: "relayer-action-icon" }, node, { thread: assetThread, interaction: assetInteraction, layerId: assetLayerId }));
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
        const action = ordinaryActions[index];
        const invoked = actionWasInvoked(
          state.actionInvocations,
          state.pendingActionInvocations,
          state.currentInteractionId,
          action.id,
          action.reusable,
        );
        const retryable = actionCanRetry(state.actionInvocations, action.id);
        const activation = actionActivationPresentation(action, {
          invoked,
          retryable,
          canInvokeMutatingActions: capabilities.canInvokeMutatingActions && state.invocationInventoryAvailable === true,
          imported: getThread()?.imported,
        });
        button.querySelector(".action-label").textContent = activation.label;
        button.disabled = activation.disabled;
        if (action.kind === "invoke" && action.inputActionIds?.length) {
          button.dataset.boundInvokeId = String(action.id);
          button.dataset.invokeBaseDisabled = String(activation.disabled);
          const names = connectedInvokeInputs(action, actions).map((input) => (input?.input ?? input)?.prompt || "Unavailable input");
          const hint = graphDocument.createElement("small");
          hint.className = "invoke-input-hint";
          hint.textContent = `Uses: ${names.join(", ")}`;
          button.closest(".action-annotation-wrap").append(hint);
        }
        button.classList.toggle("invoked", invoked);
        button.classList.toggle("retryable", activation.retryableInvoke);
        button.onclick = async () => {
          const destination = singleCallResultDestination(getState(), action, node, actions);
          if (destination) {
            if (!await prepareNodeContextSelectionChange()) return;
            await onNavigateLayer(destination.layerId, { action, sourceNode: node });
            return;
          }
          if (action.kind === "invoke" && actionWasInvoked(getState().actionInvocations,
            getState().pendingActionInvocations, getState().currentInteractionId, action.id, action.reusable)) return;
          if (activation.navigational) {
            if (!await prepareNodeContextSelectionChange()) return;
            button.disabled = true;
            try {
              await navigateWorkspaceAction({
                action,
                activation,
                sourceNode: node,
                collapseContextPreviews,
                onNavigateResolvedInvoke,
                onNavigateLayer,
              });
            } finally {
              if (button.isConnected) button.disabled = false;
            }
            return;
          }
          if (boundInvokeIssue(getState(), action)) return;
          button.disabled = true;
          button.classList.add("invoked");
          await invokeWithConfirmedInputs(action);
        };
      });
      groupNodeInvokeInputs(state, node);
    }
    const callableIds = new Set(ordinaryActions.filter((action) => action.kind === "invoke").map((action) => String(action.id)));
    const calls = (state.actionInvocations || []).filter((call) => isDurableActionInvocation(call) && call.occupancyOnly !== true && String(call.sourceInteractionId) === String(interaction?.id) && callableIds.has(String(call.actionId)));
    const shadow = $("#detailContent").querySelector("[data-node-detail-runtime]")?.shadowRoot;
    if (shadow) {
      for (const mount of node.authoredDetail?.mounts ?? []) {
        if (mount.kind !== "capability" || mount.capability.kind !== "invoke") continue;
        const action = resolveAuthoredAction(mount.capability.action);
        if (action?.kind !== "invoke" || !action.inputActionIds?.length) continue;
        const control = [...shadow.querySelectorAll("[data-gc-mount]")].find((element) => element.dataset.gcMount === mount.id);
        if (!control) continue;
        control.dataset.boundInvokeId = String(action.id);
        control.dataset.invokeBaseDisabled = String(actionActivationPresentation(action, {
          invoked: actionWasInvoked(state.actionInvocations, state.pendingActionInvocations,
            state.currentInteractionId, action.id, action.reusable),
          canInvokeMutatingActions: capabilities.canInvokeMutatingActions && state.invocationInventoryAvailable === true,
          imported: getThread()?.imported,
        }).disabled);
        const inputMounts = (node.authoredDetail.mounts ?? []).filter((candidate) => candidate.kind === "capability"
          && candidate.capability.kind === "input"
          && action.inputActionIds.some((id) => String(id) === String(resolveAuthoredAction(candidate.capability.action)?.id)));
        const inputControls = inputMounts.map((candidate) => [...shadow.querySelectorAll("[data-gc-mount]")]
          .find((element) => element.dataset.gcMount === candidate.id)).filter(Boolean);
        const hintId = `invoke-inputs-${mount.id}`;
        let hint = [...shadow.querySelectorAll("[data-invoke-input-hint]")].find((element) => element.dataset.invokeInputHint === mount.id);
        if (!hint) {
          hint = graphDocument.createElement("small");
          hint.dataset.invokeInputHint = mount.id;
          hint.id = hintId;
          hint.style.cssText = "display:block;font:12px/1.5 system-ui;opacity:.75;margin:4px 0 12px";
          control.after(hint);
        }
        hint.textContent = `Uses: ${connectedInvokeInputs(action, actions).map((input) => (input?.input ?? input)?.prompt || "Unavailable input").join(", ")}`;
        control.setAttribute("aria-describedby", [...new Set([...(control.getAttribute("aria-describedby") || "").split(" ").filter(Boolean), hintId])].join(" "));
        for (const input of inputControls) {
          input.id ||= `invoke-field-${input.dataset.gcMount}`;
          input.setAttribute("aria-describedby", [...new Set([...(input.getAttribute("aria-describedby") || "").split(" ").filter(Boolean), hintId])].join(" "));
        }
        control.setAttribute("aria-controls", inputControls.map((input) => input.id).join(" "));
      }
      syncBoundInvokeControls(state);
    }
    for (const control of shadow?.querySelectorAll("[data-invocation-result-interaction-id]") ?? []) {
      delete control.dataset.invocationResultInteractionId;
      control.classList.remove("invocation-result-control");
    }
    const importedCalls = (state.importedInvocationHistory ?? []).filter(entry => entry.inert === true
      && String(entry.threadId) === String(getThread()?.id)
      && String(entry.presentationSource?.interactionId ?? entry.sourceInteractionId) === String(interaction?.id)
      && String(entry.presentationSource?.nodeId ?? entry.sourceNodeId) === String(node.id));
    if (importedCalls.length) {
      const controls = $("#detailActions");
      controls.classList.remove("hidden");
      for (const entry of importedCalls) {
        const call = entry.record;
        const button = graphDocument.createElement("button");
        button.type = "button";
        button.className = "action-control action-pill imported-invocation-history";
        button.dataset.importedInvocationId = call.id;
        const answers = (call.arguments ?? []).map(input => submittedInputHistoryPresentation(input).compactValue).filter(Boolean).join(" · ");
        button.textContent = `${call.source.label} · ${answers ? `${answers} · ` : ""}${call.lifecycle === "succeeded" ? "Result" : "Current"} · ${call.lifecycle}`;
        const acceptedResult = state.interactions?.some(item => String(item.id) === String(entry.resultInteractionId) && item.completionStatus === "accepted");
        const retainedReturned = entry.resultInteractionId == null && call.returnedLayerId != null
          && call.returnedLayerId === call.current?.rootLayerId && call.currentLayerId === call.returnedLayerId;
        button.disabled = !onNavigateImportedInvocationHistory || (call.lifecycle === "succeeded" ? !acceptedResult && !retainedReturned : !call.current);
        button.onclick = async () => {
          if (!await prepareNodeContextSelectionChange()) return;
          await onNavigateImportedInvocationHistory?.(entry);
        };
        controls.append(button);
      }
    }
    if (calls.length) {
      const controls = $("#detailActions");
      controls.classList.remove("hidden");
      for (const [index, call] of calls.entries()) {
        const nativeCurrent = nativeInvocationCurrentPresentation(call, { threadId: getThread()?.id, sourceInteraction: interaction });
        const currentOnly = call.currentOnly === true || (call.graphOnly === true && nativeCurrent != null);
        const resultInteraction = state.interactions?.find((interaction) => String(interaction.id) === String(call.resultInteractionId));
        const returnedLayerId = call.resultCompletionStatus === "accepted"
          ? resultInteraction?.completionOutput?.rootLayer?.layer?.id : null;
        const navigation = returnedLayerId == null ? null : ordinaryActions.find((action) => (
          action.kind === "navigate"
          && String(action.sourceNodeId) === String(node.id)
          && String(action.targetLayerId) === String(returnedLayerId)
        ));
        const ordinaryControl = navigation && [...controls.querySelectorAll("[data-action-id]")]
          .find((control) => String(control.dataset.actionId) === String(navigation.id));
        const mount = navigation && node.authoredDetail?.mounts?.find((candidate) => (
          candidate.kind === "capability"
          && ["expand", "reference"].includes(candidate.capability.kind)
          && String(resolveAuthoredAction(candidate.capability.action)?.id) === String(navigation.id)
        ));
        const authoredControl = mount && [...(shadow?.querySelectorAll("[data-gc-mount]") ?? [])]
          .find((control) => control.getAttribute("data-gc-mount") === mount.id);
        const sourceAction = ordinaryActions.find((action) => String(action.id) === String(call.actionId));
        const singleDestination = singleCallResultDestination(state, sourceAction, node, actions);
        const sourceMount = singleDestination && node.authoredDetail?.mounts?.find((candidate) => candidate.kind === "capability"
          && candidate.capability.kind === "invoke"
          && String(resolveAuthoredAction(candidate.capability.action)?.id) === String(sourceAction.id));
        const sourceControl = singleDestination && ([...$("#inspector").querySelectorAll("[data-action-id]")]
          .find((control) => String(control.dataset.actionId) === String(sourceAction.id))
          || (sourceMount && [...(shadow?.querySelectorAll("[data-gc-mount]") ?? [])]
            .find((control) => control.dataset.gcMount === sourceMount.id)));
        const canonicalControl = sourceControl || ordinaryControl || authoredControl;
        if (sourceControl) {
          sourceControl.disabled = false;
          sourceControl.title = "Open result";
          if (sourceMount) mountedAuthoredDetail?.updateCapability(sourceMount.id, { disabled: false });
        }
        if (canonicalControl && !canonicalControl.disabled) {
          canonicalControl.classList.add("invocation-result-control");
          canonicalControl.dataset.invocationResultInteractionId = String(call.resultInteractionId);
          continue;
        }
        const button = graphDocument.createElement("button");
        button.type = "button";
        button.className = "action-control action-pill invocation-result-control";
        if (call.resultInteractionId != null) button.dataset.invocationResultInteractionId = String(call.resultInteractionId);
        if (call.graphOnly) button.dataset.graphOwnedInvocationId = String(call.nativeInvocation?.invocation?.id);
        const action = ordinaryActions.find((item) => String(item.id) === String(call.actionId));
        const confirmedInputs = (call.graphOnly ? call.nativeInvocation?.submittedInputs ?? [] : resultInteraction?.submittedInputs || []).map((input) => submittedInputHistoryPresentation(input).compactValue).filter(Boolean);
        const callLabel = confirmedInputs.length ? confirmedInputs.join(" · ") : `Call ${index + 1}`;
        button.textContent = `${call.graphOnly ? call.nativeInvocation?.invocation?.actionSnapshot?.label ?? actionPresentation(action).label : actionPresentation(action).label} · ${callLabel} · ${currentOnly ? call.resultCompletionStatus === "accepted" ? "Result · " : "Current · " : ""}${call.graphOnly ? ({ not_started: "Prepared", running: "Running", accepted: "Completed", stopped: "Stopped", failed: "Failed" }[call.resultCompletionStatus] ?? "Unavailable") : call.resultCompletionStatus}`;
        button.disabled = currentOnly ? !onNavigateInvocationCurrent || (call.graphOnly && !nativeCurrent)
          : call.graphOnly && call.resultInteractionId == null ? true : call.resultCompletionStatus !== "accepted" || !navigation;
        button.onclick = async () => {
          if (!await prepareNodeContextSelectionChange()) return;
          if (currentOnly) return onNavigateInvocationCurrent?.(call);
          if (!navigation) return;
          await onNavigateLayer(navigation.targetLayerId, { action: navigation, sourceNode: node });
        };
        controls.append(button);
      }
      controls.classList.toggle("hidden", controls.childElementCount === 0);
    }
    $$('[data-node]').forEach((element) => {
      element.classList.toggle("selected", element.dataset.node === String(id));
    });
    renderAnnotationList();
    renderBreadcrumb(state, getThread());
    renderComposerContexts();
    updateAttachContextControl();
    reveal();
    if (focusInspector) $("#closeInspector").focus({ preventScroll: true });
    return true;
  }

  function dispose() {
    disposed = true;
    implicitInputEntries.clear();
    inputScopeObservations.clear();
    implicitSendSnapshots.clear();
    implicitInvokeBoundaries.clear();
    for (const mount of iconMounts) mount.disposeIcon();
    iconMounts.clear();
    nodeSelectionSequence += 1;
    contextEditor = null;
    mountedAuthoredDetail?.dispose?.();
    mountedAuthoredDetail = null;
    releaseSendAttempt();
    if (contextDraftSendWarning.open) {
      closeContextDraftSendWarning({ focusSend: false, cancelAttempt: false });
    }
    modelPicker?.dispose();
    shareController?.dispose();
    for (const timer of contextDraftLoadRetryTimers.values()) graphWindow.clearTimeout(timer);
    contextDraftLoadRetryTimers.clear();
    contextDraftLoadRetryAttempts.clear();
    inputDraftLoadRetries?.dispose();
    graphDocument.defaultView.removeEventListener("resize", repositionContextDraftSendWarning);
    graphDocument.defaultView.removeEventListener("resize", fitInteractionGraphPopover);
    interactionBannerObserver?.disconnect();
    automaticGraphFit.dispose();
    cancelInspectorFit();
    graphDocument.removeEventListener("pointerdown", blurGraphFromOutsidePointer, true);
    graphDocument.removeEventListener("pointerdown", closeTurnPopoverFromOutside, true);
    graphDocument.removeEventListener("pointerdown", closeSettingsMenuFromOutside, true);
    readingLayout.dispose();
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

  function setInputOperatorCommitted(committed) {
    inputOperatorCommitted = committed === true;
    const button = $("#nodeInputActions .node-input-operator-send");
    if (button) button.disabled = !inputOperatorCommitted;
  }

  return Object.freeze({
    mode,
    capabilities,
    render,
    // Mode recreation must preserve local edits without saving them or granting
    // the inert Current view access to the mutable draft controller. Only plain
    // occurrence-keyed UI data crosses this boundary; persistence is reloaded.
    captureInputEditingState: () => structuredClone({
      version: 1, stages: [...inputStages], entries: [...implicitInputEntries],
      scopeObservations: [...inputScopeObservations], editEpochs: [...inputEditEpochs],
      errors: [...inputErrors], touched: [...inputTouched], railScroll: [...inputRailScroll],
      compositionRevisions: [...inputCompositionRevisions],
    }),
    setInputOperatorCommitted,
    prepareSelectionChange: prepareNodeContextSelectionChange,
    // Artifact notes are confirmed outside the workspace; pull them into the composer (PRD 6.6.8).
    reloadConfirmedContexts: (threadId) => contextDraftController
      ? reconcileConfirmedComposerContexts(threadId, { reload: true })
      : Promise.resolve(),
    modelSelectionPayload: () => modelPicker?.isReady()
      ? pickerSelectionPayload(modelPicker.getSelection())
      : null,
    dispose,
  });
}

export { actionReviewKind } from "../action-invocation-state.js";
