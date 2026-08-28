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
  confirmationRestorationKey,
  restoredDraftForInteraction,
} from "../interaction-failure-model.js";
import { createNodeContextDraftController } from "../node-context-drafts.js";
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

export const GRAPH_NODE_ICON_RADIUS = 24;
export const GRAPH_MIN_ZOOM = 0.4;
export const GRAPH_MAX_ZOOM = 2;
export const COMPOSER_MIN_HEIGHT = 42;
export const COMPOSER_MAX_HEIGHT = 126;
export const CONTEXT_EDITOR_MIN_HEIGHT = 52;
export const CONTEXT_EDITOR_MAX_HEIGHT = 88;

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
  if (["accepted", "succeeded"].includes(status)) {
    return { kind: "accepted", label: "", hidden: true };
  }
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
}) {
  if (!intent?.contextConfirmationIds?.length) return null;
  if (!sendIntentIsCurrentThread(threadId, intent.threadId)) return null;
  if (intent.draftScopeKey !== draftScopeKey) return null;
  if (!Object.is(intent.submission.prompt.revision, promptRevision)) return null;
  if (!Object.is(replayContextRevision, contextRevision)) return null;
  return JSON.stringify(intent.modelSelection ?? null) === JSON.stringify(modelSelection ?? null)
    ? intent
    : null;
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
  });
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

export function syncMountedContextEditorControls(textarea, presentation, value) {
  if (!textarea) return;
  textarea.disabled = presentation.textareaDisabled;
  const cancel = textarea.parentElement?.querySelector('[aria-label="Cancel annotation edit"]');
  const remove = textarea.parentElement?.querySelector('[aria-label^="Discard annotation draft"]');
  const confirm = textarea.parentElement?.querySelector('[aria-label="Confirm annotation"]');
  if (cancel) cancel.disabled = presentation.controlsDisabled;
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

export function contextDraftStatusPresentation(draft) {
  const status = draft?.status || "unsaved";
  return {
    className: `composer-context-draft-status status-${status}`,
    text: status === "error"
      ? `Not saved: ${draft.error}`
      : ({ saving: "Saving…", saved: "Saved", unsaved: "Not saved yet" }[status]
        || "Not saved yet"),
  };
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

export function transitionComposerDraftScope(state, {
  threadId,
  interactionId,
  currentPromptValue,
  currentPromptRevision = 0,
  restoredDraft = null,
}) {
  const nextScopeKey = composerDraftScopeKey(threadId, interactionId);
  if (state.activeScopeKey === nextScopeKey) {
    const currentDraft = state.drafts.get(nextScopeKey) ?? {
      promptValue: currentPromptValue,
      promptRevision: currentPromptRevision,
      restoredDraftInteractionId: null,
    };
    const restorationArrived = restoredDraft
      && String(currentDraft.restoredDraftInteractionId) !== String(interactionId);
    const promptValue = restorationArrived ? restoredDraft.text : currentPromptValue;
    const promptRevision = restorationArrived
      ? currentPromptRevision + 1
      : currentPromptRevision;
    const drafts = new Map(state.drafts);
    drafts.set(nextScopeKey, {
      promptValue,
      promptRevision,
      restoredDraftInteractionId: restorationArrived
        ? interactionId
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
  if (!drafts.has(nextScopeKey)) {
    drafts.set(nextScopeKey, {
      promptValue: restoredDraft?.text ?? "",
      promptRevision: currentPromptRevision + 1,
      restoredDraftInteractionId: restoredDraft ? interactionId : null,
    });
  }
  return {
    state: { activeScopeKey: nextScopeKey, drafts },
    promptValue: drafts.get(nextScopeKey).promptValue,
    promptRevision: drafts.get(nextScopeKey).promptRevision,
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

export function resizeContextEditorTextarea(textarea) {
  textarea.style.height = "auto";
  const contentHeight = Math.max(CONTEXT_EDITOR_MIN_HEIGHT, textarea.scrollHeight);
  textarea.style.height = `${Math.min(contentHeight, CONTEXT_EDITOR_MAX_HEIGHT)}px`;
  textarea.style.overflowY = contentHeight > CONTEXT_EDITOR_MAX_HEIGHT ? "auto" : "hidden";
}

export function contextAnnotationCountLabel(count) {
  return `${count} annotation${count === 1 ? "" : "s"}`;
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
  contextDraftApi = null,
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
  let renderedWithoutThread = false;
  let annotationRatingTouched = false;
  let editingAnnotation = null;
  let inspectorFocusOrigin = null;
  let composerContextState = createComposerContextState();
  let contextEditor = null;
  let openComposerContextKey = null;
  let contextPopoverOpen = false;
  const contextNodeOverrides = new Map();
  let selectedContextTarget = null;
  const contextDraftController = contextDraftApi
    ? createNodeContextDraftController({
      api: contextDraftApi,
      onChange: () => renderContextDraftStatus(),
    })
    : null;
  const contextDraftLoads = new Map();
  const loadedContextDraftThreads = new Set();
  const recoveredConfirmationThreads = new Set();
  const contextDraftLoadRetryTimers = new Map();
  const contextDraftLoadRetryAttempts = new Map();
  let disposed = false;

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
  $("#previousTurn").onclick = () => {
    closeTurnPopover();
    collapseContextPreviews();
    onSelectTurn(-1);
  };
  $("#nextTurn").onclick = () => {
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
    if (!turnButton.disabled) {
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
  const contextDraftSendWarning = $("#contextDraftSendWarning");
  const cancelContextDraftSend = $("#cancelContextDraftSend");
  const confirmContextDraftSend = $("#confirmContextDraftSend");
  let sendAttempt = null;
  const inFlightSendThreads = new Map();
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
    return contextStagingDisabledFor(
      status,
      capabilities.canCompose,
      prompt.disabled,
      restoredDraftActive,
    );
  };
  const closeContextEditor = () => {
    contextEditor = null;
    renderComposerContexts();
  };
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
    const status = composerStatusForThread(getState(), getThread());
    const available = capabilities.canCompose
      && !composerDisabledForState(status, true, restoredDraftActive)
      && !prompt.disabled
      && Boolean(node);
    button.classList.toggle("hidden", !available);
    button.disabled = !available;
  };
  const openContextEditor = (node, annotationIndex = null, contextTarget = null) => {
    if (!node || contextStagingDisabled() || contextEditor) return;
    const context = contextTarget ? contextForTarget(contextTarget) : null;
    const interaction = currentInteraction();
    const sourceTarget = interactionContextTargetForEditor({
      nodeId: node.id,
      contextTarget: context?.target,
      selectedContextTarget,
      sourceInteractionNodeId: interaction?.graphNodeId,
      sourceLayerId: currentLayerId(),
    });
    let durableDraft = null;
    if (annotationIndex == null && contextDraftController) {
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
    }
    openComposerContextKey = null;
    contextEditor = {
      ownerThreadId: String(getThread()?.id),
      nodeId: node.id,
      draftId: durableDraft?.id || null,
      target: durableDraft?.target || sourceTarget,
      annotationIndex,
      confirmation: annotationIndex == null
        ? null
        : context?.annotationConfirmations?.[annotationIndex] || null,
      value: annotationIndex == null
        ? durableDraft?.text || ""
        : context?.annotations?.[annotationIndex] || "",
      attaching: !context,
      durable: Boolean(durableDraft),
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
    const status = $(".composer-context-draft-status");
    if (!status) return;
    const draft = contextDraftController.draftForNode(getThread()?.id, contextEditor.nodeId);
    if (draft) {
      contextEditor.draftId = draft.id;
      contextEditor.target = draft.target;
    }
    const textarea = $("#contextAnnotationEditor");
    if (draft?.editVersion === 0
      && textarea
      && (contextEditor.value !== draft.text || textarea.value !== draft.text)) {
      contextEditor.value = draft.text;
      textarea.value = draft.text;
      resizeContextEditorTextarea(textarea);
      const confirm = textarea.parentElement?.querySelector('[aria-label="Confirm annotation"]');
      if (confirm) confirm.disabled = !String(draft.text).trim() || contextStagingDisabled();
    }
    const resolving = Boolean(contextEditor.resolving)
      || ["confirming", "discarding", "reconciling"].includes(draft?.operation?.kind);
    const basePresentation = contextEditorPresentation(
      contextEditor,
      contextStagingDisabled(),
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
    const presentation = contextDraftStatusPresentation(draft);
    status.className = presentation.className;
    status.textContent = presentation.text;
  }
  function renderComposerContexts() {
    const tray = $("#composerContextTray");
    const parts = [];
    if (
      contextEditor
      && contextEditor.ownerThreadId !== String(getThread()?.id)
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

    const editorIdentity = contextEditor ? JSON.stringify([
      contextEditor.ownerThreadId,
      contextEditor.draftId,
      String(contextEditor.nodeId),
      contextEditor.target?.sourceInteractionNodeId,
      contextEditor.target?.sourceLayerId,
      contextEditor.annotationIndex,
      contextEditor.attaching,
      contextEditor.durable,
    ]) : null;
    const existingTextarea = $("#contextAnnotationEditor");
    if (
      editorIdentity !== null
      && existingTextarea?.dataset.contextEditorIdentity === editorIdentity
      && existingTextarea.isConnected
    ) {
      const active = graphDocument.activeElement === existingTextarea;
      const value = existingTextarea.value;
      const selectionStart = existingTextarea.selectionStart;
      const selectionEnd = existingTextarea.selectionEnd;
      const selectionDirection = existingTextarea.selectionDirection;
      const scrollTop = existingTextarea.scrollTop;
      const scrollLeft = existingTextarea.scrollLeft;
      contextEditor.value = value;
      const resolving = Boolean(contextEditor.resolving)
        || ["confirming", "discarding", "reconciling"]
          .includes(liveDurableDraft?.operation?.kind);
      const editorPresentation = contextEditorPresentation(
        contextEditor,
        contextStagingDisabled(),
        resolving,
      );
      const editorNode = resolveInteractionContextNode(
        contextEditor.nodeId,
        getState().nodes,
        composerContextState.value,
        contextNodeOverrides,
      );
      existingTextarea.placeholder = contextEditor.attaching
        ? "Add a note (optional for a new node)…"
        : "Add an annotation…";
      if (editorNode) {
        existingTextarea.setAttribute("aria-label", `Annotation for ${editorNode.title}`);
      }
      const canContinueLocalEditing = capabilities.canCompose
        && contextEditor.ownerThreadId === String(getThread()?.id)
        && !resolving;
      existingTextarea.disabled = editorPresentation.textareaDisabled && !canContinueLocalEditing;
      const editorBody = existingTextarea.closest(".composer-context-inline-editor");
      const confirm = editorBody?.querySelector('[aria-label="Confirm annotation"]');
      const remove = editorBody?.querySelector(
        '[aria-label^="Delete annotation being edited for "], [aria-label^="Discard annotation draft"]',
      );
      const cancel = editorBody?.querySelector('[aria-label="Cancel annotation edit"]');
      if (confirm) {
        confirm.disabled = editorPresentation.confirmDisabled
          || (contextEditor.durable && !String(value).trim());
      }
      if (cancel) cancel.disabled = editorPresentation.controlsDisabled;
      if (remove) {
        remove.disabled = editorPresentation.controlsDisabled
          || (!contextEditor.durable && contextEditor.annotationIndex == null);
      }
      resizeContextEditorTextarea(existingTextarea);
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
      syncComposer();
      return;
    }

    const createEditorBody = (node) => {
      const durableDraft = contextEditor?.durable
        ? contextDraftController.draftForNode(getThread()?.id, node.id)
        : null;
      const editorPresentation = contextEditorPresentation(
        contextEditor,
        contextStagingDisabled(),
        Boolean(contextEditor.resolving)
          || ["confirming", "discarding"].includes(durableDraft?.operation?.kind),
      );
      const body = graphDocument.createElement("div");
      body.className = "composer-context-inline-editor";
      const textarea = graphDocument.createElement("textarea");
      textarea.id = "contextAnnotationEditor";
      textarea.rows = 2;
      textarea.placeholder = contextEditor.attaching
        ? "Add a note (optional for a new node)…"
        : "Add an annotation…";
      textarea.setAttribute("aria-label", `Annotation for ${node.title}`);
      textarea.dataset.contextEditorIdentity = editorIdentity;
      textarea.value = contextEditor.value;
      textarea.disabled = editorPresentation.textareaDisabled;
      const controls = graphDocument.createElement("div");
      controls.className = "composer-context-editor-actions";
      const cancel = graphDocument.createElement("button");
      cancel.type = "button";
      cancel.textContent = "×";
      cancel.title = "Cancel";
      cancel.setAttribute("aria-label", "Cancel annotation edit");
      cancel.onclick = closeContextEditor;
      cancel.disabled = editorPresentation.controlsDisabled;
      const remove = graphDocument.createElement("button");
      remove.type = "button";
      remove.textContent = "🗑";
      remove.title = contextEditor.durable ? "Discard draft" : "Delete annotation";
      remove.setAttribute("aria-label", contextEditor.durable
        ? `Discard annotation draft for ${node.title}`
        : `Delete annotation being edited for ${node.title}`);
      remove.onclick = async () => {
        if (contextStagingDisabled()) return;
        if (contextEditor?.durable) {
          const discardingEditor = contextEditor;
          try {
            await contextDraftController.discard(discardingEditor.ownerThreadId, node.id);
            closeDurableEditor(discardingEditor.ownerThreadId, discardingEditor.draftId);
            renderComposerContexts();
          } catch (error) {
            toast(error.message);
          }
          return;
        }
        if (contextEditor.annotationIndex != null) {
          const removingEditor = contextEditor;
          const removingThreadId = removingEditor.ownerThreadId;
          if (removingEditor.confirmation) {
            try {
              await contextDraftController.dismissConfirmations(
                removingThreadId,
                [removingEditor.confirmation.draftId],
              );
            } catch (error) {
              await reconcileConfirmedComposerContexts(removingThreadId, { reload: true });
              toast(error.message);
              return;
            }
          }
          if (contextEditor !== removingEditor
            || String(getThread()?.id) !== String(removingThreadId)) return;
          replaceComposerContexts(removeContextAnnotation(
            composerContextState.value,
            removingEditor.target,
            removingEditor.annotationIndex,
          ));
          contextEditor = null;
          renderComposerContexts();
        }
      };
      remove.disabled = editorPresentation.controlsDisabled
        || (!contextEditor.durable && contextEditor?.annotationIndex == null);
      const confirm = graphDocument.createElement("button");
      confirm.type = "button";
      confirm.textContent = "✓";
      confirm.title = "Confirm";
      confirm.setAttribute("aria-label", "Confirm annotation");
      confirm.disabled = editorPresentation.confirmDisabled
        || (contextEditor.durable && !String(contextEditor.value).trim());
      confirm.onclick = async () => {
        if (contextStagingDisabled()) return;
        if (contextEditor.durable) {
          const confirmingEditor = contextEditor;
          const confirmingThreadId = String(getThread()?.id);
          confirm.disabled = true;
          try {
            const confirmation = await contextDraftController.confirm(
              confirmingThreadId,
              node.id,
            );
            if (!confirmation) {
              renderComposerContexts();
              return;
            }
            if (contextConfirmationDestination(getThread()?.id, confirmingThreadId) === "current") {
              applyConfirmedContextDraft(confirmation);
              closeDurableEditor(confirmingThreadId, confirmingEditor.draftId);
              renderComposerContexts();
            }
          } catch (error) {
            const resolvedElsewhere = contextDraftController
              .confirmationsForThread(confirmingThreadId)
              .some((item) => item.draftId === confirmingEditor.draftId);
            if (resolvedElsewhere
              && !contextDraftController.draftForNode(confirmingThreadId, node.id)) {
              closeDurableEditor(confirmingThreadId, confirmingEditor.draftId);
              await reconcileConfirmedComposerContexts(confirmingThreadId);
            }
            toast(error.message);
            renderComposerContexts();
          }
          return;
        }
        if (contextEditor.confirmation) {
          const updatingEditor = contextEditor;
          const updatingThreadId = updatingEditor.ownerThreadId;
          const updatingRevision = composerContextState.revision;
          const submittedValue = updatingEditor.value;
          const confirmationId = updatingEditor.confirmation.draftId;
          updatingEditor.resolving = true;
          confirm.disabled = true;
          renderComposerContexts();
          const reprojectUpdatingEditor = () => {
            const authoritativeConfirmations = contextDraftController
              .confirmationsForThread(updatingThreadId);
            const refreshed = authoritativeConfirmations
              .find((item) => item.draftId === confirmationId) || null;
            updatingEditor.confirmation = refreshed;
            if (contextEditor !== updatingEditor
              || String(getThread()?.id) !== String(updatingThreadId)) return;
            let reconciledContexts = composerContextsMergedWithConfirmations(
              composerContextState.value,
              authoritativeConfirmations,
            );
            if (!refreshed) {
              reconciledContexts = applyContextEditor(
                reconciledContexts,
                {
                  ...updatingEditor,
                  annotationIndex: null,
                  value: submittedValue,
                  confirmation: null,
                },
                node,
                updatingEditor.target,
              );
            }
            const reboundContext = reconciledContexts.find((context) => (
              interactionContextTargetKey(context.target)
                === interactionContextTargetKey(updatingEditor.target)
            ));
            updatingEditor.annotationIndex = refreshed
              ? reboundContext?.annotationConfirmations?.findIndex((confirmation) => (
                confirmation?.draftId === confirmationId
              ))
              : (reboundContext?.annotations?.length ?? 0) - 1;
            replaceComposerContexts(reconciledContexts);
          };
          try {
            const updatedConfirmation = await contextDraftController.updateConfirmation(
              updatingThreadId,
              confirmationId,
              submittedValue,
            );
            if (!updatedConfirmation) {
              reprojectUpdatingEditor();
              updatingEditor.resolving = false;
              if (contextEditor === updatingEditor) renderComposerContexts();
              return;
            }
            updatingEditor.confirmation = updatedConfirmation;
          } catch (error) {
            updatingEditor.resolving = false;
            let reconciled = false;
            try {
              await contextDraftController.load(updatingThreadId);
              reconciled = true;
            } catch {
              // Keep the typed value available for retry even if reconciliation also fails.
            }
            if (contextEditor === updatingEditor) {
              if (reconciled) reprojectUpdatingEditor();
              renderComposerContexts();
            }
            toast(error.message);
            return;
          }
          if (!updatingEditor.confirmation
            || contextEditor !== updatingEditor
            || String(getThread()?.id) !== String(updatingThreadId)
            || composerContextState.revision !== updatingRevision) {
            updatingEditor.resolving = false;
            if (contextEditor === updatingEditor) renderComposerContexts();
            return;
          }
          updatingEditor.value = submittedValue;
          updatingEditor.resolving = false;
        }
        replaceComposerContexts(applyContextEditor(
          composerContextState.value,
          contextEditor,
          node,
          contextEditor.target,
        ));
        openComposerContextKey = null;
        contextEditor = null;
        renderComposerContexts();
      };
      textarea.oninput = () => {
        if (!applyMountedContextEditorInput({
          editor: contextEditor,
          textarea,
          controller: contextDraftController,
          threadId: getThread()?.id,
          nodeId: node.id,
        })) return;
        resizeContextEditorTextarea(textarea);
        confirm.disabled = contextEditorPresentation(
          contextEditor,
          contextStagingDisabled(),
        ).confirmDisabled || (contextEditor.durable && !textarea.value.trim());
      };
      if (contextEditor.annotationIndex != null) controls.append(remove);
      else if (contextEditor.durable) controls.append(remove);
      controls.append(cancel, confirm);
      body.append(textarea, controls);
      if (contextEditor.durable) {
        const draft = contextDraftController.draftForNode(getThread()?.id, node.id);
        const status = graphDocument.createElement("small");
        const presentation = contextDraftStatusPresentation(draft);
        status.className = presentation.className;
        status.setAttribute("aria-live", "polite");
        status.textContent = presentation.text;
        body.append(status);
      }
      return body;
    };

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
        openContext.node.icon || openContext.node.metadata?.relayer?.icon,
      ));
      const title = graphDocument.createElement("strong");
      title.textContent = openContext.node.title;
      nodeButton.append(title);
      nodeButton.setAttribute("aria-label", `Open ${openContext.node.title} details`);
      nodeButton.onclick = () => selectNode(getState(), openContext.node.id);
      const add = graphDocument.createElement("button");
      add.type = "button";
      add.className = "context-symbol-button";
      add.textContent = "+";
      add.title = "Add annotation";
      add.setAttribute("aria-label", `Add annotation to ${openContext.node.title}`);
      add.onclick = () => openContextEditor(openContext.node, null, openContext.target);
      add.disabled = contextStagingDisabled() || Boolean(contextEditor);
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
      heading.append(nodeButton, add, close);

      const list = graphDocument.createElement("ol");
      list.className = "composer-context-annotations";
      openContext.annotations.forEach((annotation, index) => {
        const item = graphDocument.createElement("li");
        const editing = interactionContextTargetKey(contextEditor?.target)
            === interactionContextTargetKey(openContext.target)
          && contextEditor.annotationIndex === index;
        if (editing) {
          item.className = "editing";
          item.append(createEditorBody(openContext.node));
        } else {
          const text = graphDocument.createElement("span");
          text.textContent = annotation;
          const edit = graphDocument.createElement("button");
          edit.type = "button";
          edit.className = "context-symbol-button";
          edit.textContent = "✎";
          edit.title = "Edit annotation";
          edit.setAttribute(
            "aria-label",
            `Edit annotation ${index + 1} for ${openContext.node.title}`,
          );
          edit.onclick = () => openContextEditor(openContext.node, index, openContext.target);
          edit.disabled = contextStagingDisabled() || Boolean(contextEditor);
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
          item.append(text, edit, remove);
        }
        list.append(item);
      });
      const adding = interactionContextTargetKey(contextEditor?.target)
          === interactionContextTargetKey(openContext.target)
        && contextEditor.annotationIndex == null
        && !contextEditor.attaching;
      if (adding) {
        const item = graphDocument.createElement("li");
        item.className = "editing";
        item.append(createEditorBody(openContext.node));
        list.append(item);
      }
      preview.append(heading, list);
      parts.push(preview);
    }

    const attachingNode = contextEditor?.attaching
      ? resolveInteractionContextNode(
        contextEditor.nodeId,
        getState().nodes,
        composerContextState.value,
        contextNodeOverrides,
      )
      : null;
    if (attachingNode) {
      const editor = graphDocument.createElement("section");
      editor.className = "composer-context-editor";
      const heading = graphDocument.createElement("div");
      heading.className = "composer-context-heading";
      heading.append(createRelayerIcon(
        attachingNode.icon || attachingNode.metadata?.relayer?.icon,
      ));
      const title = graphDocument.createElement("strong");
      title.textContent = attachingNode.title;
      heading.append(title);
      editor.append(heading, createEditorBody(attachingNode));
      parts.push(editor);
    }

    const standaloneEditorContext = !contextEditor?.attaching && !openContext
      ? contextForTarget(contextEditor?.target)
      : null;
    if (standaloneEditorContext) {
      const editor = graphDocument.createElement("section");
      editor.className = "composer-context-editor";
      const heading = graphDocument.createElement("div");
      heading.className = "composer-context-heading";
      heading.append(createRelayerIcon(
        standaloneEditorContext.node.icon
          || standaloneEditorContext.node.metadata?.relayer?.icon,
      ));
      const title = graphDocument.createElement("strong");
      title.textContent = standaloneEditorContext.node.title;
      heading.append(title);
      editor.append(heading, createEditorBody(standaloneEditorContext.node));
      parts.push(editor);
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
        pill.append(createRelayerIcon(context.node.icon || context.node.metadata?.relayer?.icon));
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

    tray.replaceChildren(...parts);
    tray.classList.toggle("hidden", parts.length === 0);
    const renderedEditor = $("#contextAnnotationEditor");
    if (renderedEditor) resizeContextEditorTextarea(renderedEditor);
    syncComposer();
  }
  const syncComposer = () => {
    resizeComposerTextarea(prompt);
    const contextDraftsReady = !contextDraftController
      || loadedContextDraftThreads.has(String(getThread()?.id));
    const failedConfirmationSend = failedConfirmationSends.get(String(getThread()?.id));
    const replayIntent = confirmationSendReplayIntent({
      intent: failedConfirmationSend?.intent,
      threadId: getThread()?.id,
      draftScopeKey: composerDraftScopeState.activeScopeKey,
      promptRevision: composerPromptRevision,
      contextRevision: composerContextState.revision,
      replayContextRevision: failedConfirmationSend?.contextRevision,
      modelSelection: pickerSelectionPayload(modelPicker?.getSelection())?.modelSelection,
    });
    const replayReady = replayIntent
      && !prompt.disabled
      && (modelPicker?.isReady() ?? false)
      && !contextEditor;
    send.disabled = threadHasInFlightSend(inFlightSendThreads, getThread()?.id)
      || !contextDraftsReady || (!replayReady && !composerSubmissionReady(
      prompt.value,
      prompt.disabled,
      modelPicker?.isReady() ?? false,
      composerContextState.value,
      Boolean(contextEditor),
    ));
    send.title = modelPicker?.isReady()
      ? "Send"
      : "Choose an available model in Settings before sending";
  };
  const releaseSendAttempt = () => {
    sendAttempt = null;
    send.removeAttribute("aria-busy");
    confirmContextDraftSend.disabled = false;
    syncComposer();
  };
  const cancelSendAttempt = () => {
    releaseInFlightSend(inFlightSendThreads, sendAttempt);
    releaseSendAttempt();
  };
  const closeContextDraftSendWarning = ({ focusSend = true, cancelAttempt = true } = {}) => {
    sendWarningIntent = null;
    if (cancelAttempt) cancelSendAttempt();
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

  const submitInteraction = async (intent) => {
    const submittedThreadId = intent.threadId;
    const submittedContexts = intent.contexts;
    const submittedConfirmationIds = intent.contextConfirmationIds;
    const submission = intent.submission;
    prompt.disabled = true;
    send.disabled = true;
    renderComposerContexts();
    updateAttachContextControl();
    try {
      await onSubmitInteraction(
        intent.text,
        intent.modelSelection,
        intent.contextPayload,
        submittedConfirmationIds,
      );
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
      composerDraftScopeState = clearSubmittedComposerDraft(
        composerDraftScopeState,
        settlement.submittedScopeKey,
        submission.prompt.revision,
        composerPromptRevision,
      );
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
      const preserveReplay = submittedConfirmationIds.length
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
      toast(error.message);
    } finally {
      prompt.disabled = composerDisabledForState(
        getState().status,
        capabilities.canCompose,
        restoredDraftActive,
      );
      renderComposerContexts();
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
    if (threadHasInFlightSend(inFlightSendThreads, threadId)
      || sendAttemptBlocksThread(sendAttempt?.threadId, threadId)) return;
    const failedConfirmationSend = failedConfirmationSends.get(String(threadId));
    const replayIntent = confirmationSendReplayIntent({
      intent: failedConfirmationSend?.intent,
      threadId,
      draftScopeKey: composerDraftScopeState.activeScopeKey,
      promptRevision: composerPromptRevision,
      contextRevision: composerContextState.revision,
      replayContextRevision: failedConfirmationSend?.contextRevision,
      modelSelection: pickerSelectionPayload(modelPicker?.getSelection())?.modelSelection,
    });
    const intent = draftOverride
      ? sendWarningIntent
      : replayIntent || interactionSendIntent({
        threadId,
        draftScopeKey: composerDraftScopeState.activeScopeKey,
        promptValue: prompt.value,
        promptRevision: composerPromptRevision,
        contexts: composerContextState.value,
        contextRevision: composerContextState.revision,
        modelSelection: pickerSelectionPayload(modelPicker?.getSelection())?.modelSelection,
      });
    if (!intent || !sendIntentIsCurrentThread(threadId, intent.threadId)) return;
    const attempt = { threadId: String(threadId) };
    inFlightSendThreads.set(attempt.threadId, attempt);
    sendAttempt = attempt;
    send.setAttribute("aria-busy", "true");
    try {
      if (!draftOverride && contextDraftController) {
        await ensureContextDraftsLoaded(threadId);
        if (!sendIntentIsCurrentThread(getThread()?.id, threadId) || sendAttempt !== attempt) return;
        const drafts = contextDraftController.draftsForThread(threadId);
        if (drafts.length > 0) {
          openContextDraftSendWarning(drafts, intent);
          return;
        }
      }
      if (draftOverride && contextDraftController) {
        await contextDraftController.persistAll(threadId);
        if (!sendIntentIsCurrentThread(getThread()?.id, threadId) || sendAttempt !== attempt) return;
      }
      if (draftOverride) {
        closeContextDraftSendWarning({ focusSend: false, cancelAttempt: false });
      }
      await submitInteraction(intent);
    } catch (error) {
      toast(error.message);
    } finally {
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
    syncComposer();
  };
  bindComposerKeydown(prompt, () => {
    if (!modelPicker?.isReady()) modelPicker?.open("model");
    else send.click();
  });
  send.onclick = () => { void requestInteractionSend(); };
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
        const intent = turnSelectionIntent(turns, interaction?.id, turn.id);
        closeTurnPopover();
        if (!intent) return;
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
      button.append(createRelayerIcon(node.icon || node.metadata?.relayer?.icon));
      const title = graphDocument.createElement("span");
      title.textContent = node.title;
      button.append(title);
      button.setAttribute("aria-label", `Open ${node.title} details`);
      button.onclick = () => {
        closeContextPopover();
        selectNode(
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
      releaseSendAttempt();
      if (contextDraftSendWarning.open) {
        closeContextDraftSendWarning({ focusSend: false, cancelAttempt: false });
      }
      renderedWithoutThread = true;
      showEmpty();
      return;
    }
    const threadId = String(thread.id);
    const enteringLoadedThread = renderedWithoutThread
      && loadedContextDraftThreads.has(threadId);
    renderedWithoutThread = false;
    if (contextDraftController
      && !contextDraftLoads.has(threadId)
      && !contextDraftLoadRetryTimers.has(threadId)) {
      void ensureContextDraftsLoaded(thread.id).catch((error) => {
        if (disposed) return;
        toast(`Annotation drafts could not be restored: ${error.message}`);
        scheduleContextDraftLoadRetry(thread.id);
      });
    }
    if (renderedThreadId !== null && renderedThreadId !== threadId) {
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
    const restoredDraft = restoredDraftForInteraction(latestInteraction);
    restoredDraftActive = Boolean(restoredDraft);
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
    retryMessage.classList.toggle("hidden", !restoredDraft);
    retryMessage.textContent = restoredDraft?.message ?? "";
    const draftTransition = transitionComposerDraftScope(composerDraftScopeState, {
      threadId,
      interactionId: latestInteraction?.id,
      currentPromptValue: prompt.value,
      currentPromptRevision: composerPromptRevision,
      restoredDraft,
    });
    composerDraftScopeState = draftTransition.state;
    prompt.value = draftTransition.promptValue;
    composerPromptRevision = draftTransition.promptRevision;
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
    renderInteractionState(state, interaction, Boolean(restoredDraft));
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

  function renderInteractionState(state, interaction, restoredDraft = false) {
    const viewedStatus = ["succeeded", "stopped", "failed"].includes(state.temporalLifecycle)
      ? state.temporalLifecycle
      : interaction?.completionStatus || state.status || "idle";
    const presentation = turnStatusPresentation(viewedStatus);
    const statusElement = $("#interactionStatus");
    const safeReason = state.temporalSafeReason || null;
    const statusKey = `${interactionStatusRenderKey(interaction, state.status || "idle")}:${safeReason ?? ""}`;
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

  function selectNode(state, id, {
    notify = true,
    userInitiated = notify,
    focusInspector = false,
    contextTarget,
    origin = null,
  } = {}) {
    selection.selectedNodeId = id;
    if (contextTarget !== undefined || notify) selectedContextTarget = contextTarget || null;
    const node = resolveInteractionContextNode(
      id,
      state.nodes,
      composerContextState.value,
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
    const { reveal } = openInspector({ userInitiated, origin });
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
    if (focusInspector) $("#closeInspector").focus({ preventScroll: true });
  }

  function dispose() {
    disposed = true;
    releaseSendAttempt();
    if (contextDraftSendWarning.open) {
      closeContextDraftSendWarning({ focusSend: false, cancelAttempt: false });
    }
    modelPicker?.dispose();
    for (const timer of contextDraftLoadRetryTimers.values()) graphWindow.clearTimeout(timer);
    contextDraftLoadRetryTimers.clear();
    contextDraftLoadRetryAttempts.clear();
    graphDocument.defaultView.removeEventListener("resize", repositionContextDraftSendWarning);
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
