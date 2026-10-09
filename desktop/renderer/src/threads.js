import { inertInvocationCurrent, inertInvocationSource } from "./public-share-viewer/snapshot.js";
import { expandThreadProject } from "./project-sidebar.js";
import { restoreArchivedForNavigation, threadActivityOrder } from "./thread-archive.js";
import { checkoutController, setCheckoutSubmitting } from "./checkout.js";
import { isResolvedInvokeAction } from "./product-workspace/node-detail-runtime.js";
import { preferredLayerNode, rememberedLayerSelection, rememberLayerSelection } from "./product-workspace/layer-selection.js";
import { request } from "./api.js";
import { artifactLayerNode, createArtifactViewer } from "./artifact-viewer.js";
import { createNodeContextDraftApi } from "./node-context-drafts.js";
import {
  actionWasInvoked,
  isRejectedActionPreparation,
  recoverableActionInvocation,
  recoverActionInvocation,
  mergeActionInvocation,
  visibleLayerAfterRefresh,
  withoutPendingActionInvocation,
} from "./action-invocation-state.js";
import {
  createAcceptedLayerCache,
  createLatestRequestGate,
  createNavigationHistory,
  navigationEntriesChangeTurn,
} from "./navigation-history.js";
import { renderThread } from "./graph.js";
import {
  renderScopeMenu,
  renderSidebar,
  setMainView,
  setSettingsTab,
} from "./navigation.js";
import {
  appendLayerPath,
  createLayerNavigationCoordinator,
  layerPathForVisibleLayer,
  reconcileCurrentProjection,
  humanTurns,
  workspaceTurns,
  nativeInvocationCurrentPresentation,
} from "./product-workspace/model.js";
import {
  descendantLayerIdentities,
  navigationDestinationLabel,
  navigationDestinationMetadata,
  navigationEntryFromView,
  navigationEntryKey,
  invocationOriginForSource,
  resolveNavigationPresentation,
  validateResolvedLayer,
  workspaceUrlForPresentation,
} from "./workspace-navigation.js";
import { appState, productApiAvailable, viewState } from "./state.js";
import { $, threadTitle, toast } from "./ui.js";
import { addLocalThread } from "./thread-model.js";
import { closePermissionMenu } from "./permission-profiles.js";
import {
  followupRequestBody,
  markFollowupSendSucceeded,
  stableNewThreadRequest,
  stableFollowupInputId,
} from "./interaction-request-model.js";
import {
  closeNewThreadModelPicker,
  newThreadModelSelectionPayload,
  newThreadModelSelectionReady,
  newThreadModelSetup,
  setNewThreadModelPickerDisabled,
} from "./composer-model-picker.js";
import { composerSendTitle } from "./model-picker.js";
import { refreshModelFamilySettings } from "./model-family-settings.js";
import {
  harnessUsesConfigurationModel,
  isModelSelectionCatalogError,
} from "./model-picker-model.js";
import {
  interactionSubmissionTarget,
  restoredDraftForInteraction,
} from "./interaction-failure-model.js";
import {
  pendingApprovalsForThread,
  validApprovalDecision,
} from "./approval-model.js";
import {
  createPostFlightRefreshQueue,
  createEnvironmentRefreshScheduler,
  environmentBackoffAfterFailure,
  environmentRefreshNeeded,
  environmentScopeKey,
  interactionReachedTerminal,
  latestInteractionForThread,
  resolveEnvironmentSnapshot,
} from "./environment-context.js";
import { onboardingTutorialController } from "./onboarding-tutorial.js";
import { persistPendingNewThreadDraftDurably, clearPendingNewThreadDraft } from "./composer-drafts.js";
import { projectComposerGate } from "./project-composer-navigation.js";

// A pending result has no authority to replace a newer browsing intent.
let readingIntent = 0;
const pendingTurns = new Map();
function cancelAutomaticTurn() {
  readingIntent += 1;
  for (const pending of pendingTurns.values()) pending.auto = false;
}
function trackPendingTurn(threadId, interactionId, intent, invocationSource = null) {
  const pending = { threadId, interactionId, invocationSource, auto: readingIntent === intent, status: "running", readyLayer: null };
  pendingTurns.set(String(threadId), pending);
  if (String(viewState.currentThreadId) === String(threadId)) appState.pendingTurn = pending;
}
function pendingInvocationOrigin(pending, actionInvocations = appState.actionInvocations) {
  const source = pending?.invocationSource;
  return source == null ? null : invocationOriginForSource(
    source.origin, source.layer, actionInvocations, pending.interactionId,
  );
}
function displayableLayer(layer) {
  return layer?.layer?.id != null && layer.layer.state !== "draft" && layer.layer.state !== "stopped"
    && layer.nodes?.length > 0;
}
export function openReadyResult() {
  const pending = pendingTurns.get(String(viewState.currentThreadId));
  if (!pending?.readyLayer) return false;
  const interaction = appState.interactions.find((item) => String(item.id) === String(pending.interactionId));
  if (!interaction) return false;
  cancelAutomaticTurn();
  refreshGate.invalidate();
  supersedePendingHistory({ presentationChanged: true });
  hydrateWorkspace(interaction, pending.readyLayer, {
    temporalCurrent: pending.temporalCurrent ?? null,
    invocationOrigin: pendingInvocationOrigin(pending),
  });
  pendingTurns.delete(String(pending.threadId));
  appState.pendingTurn = null;
  recordCurrentNavigation("push");
  renderThread();
  schedulePendingRefresh(viewState.currentThreadId);
  return true;
}

let creatingFirstThread = false;
let pendingRefreshTimer;
const PENDING_REFRESH_INTERVAL_MS = 500;
const layerNavigationCoordinator = createLayerNavigationCoordinator();
const navigationMetadata = new Map();
const acceptedLayerCache = createAcceptedLayerCache({
  isCacheable: (layer) => layer?.layer?.id != null,
});
const navigationHistory = createNavigationHistory({
  limit: 20,
  destinationMetadata: (entry) => navigationMetadata.get(navigationEntryKey(entry)) ?? null,
});
let pendingHistoryTransition = null;
const refreshGate = createLatestRequestGate();
const resolvedInvokeNavigationGate = createLatestRequestGate();
let pendingResolvedInvokeNavigation = false;
let environmentRequestSequence = 0;
const environmentRefreshRecords = new Map();
let environmentRequestInFlight = null;
const environmentRefreshScheduler = createEnvironmentRefreshScheduler();
const environmentPostFlightQueue = createPostFlightRefreshQueue();

function activeProjectId() {
  return appState.threads.find((thread) => (
    String(thread.id) === String(viewState.currentThreadId)
  ))?.projectId ?? null;
}

function activeEnvironmentKey() {
  return environmentScopeKey(activeProjectId(), viewState.currentThreadId);
}

function clearEnvironmentRefreshTimer() {
  environmentRefreshScheduler.clear();
}

function environmentWorkspaceFocused() {
  return viewState.mainView === "thread"
    && activeProjectId() != null
    && document.visibilityState !== "hidden"
    && (typeof document.hasFocus !== "function" || document.hasFocus());
}

function scheduleEnvironmentRefresh() {
  clearEnvironmentRefreshTimer();
  if (!environmentWorkspaceFocused()) return;
  const scopeKey = activeEnvironmentKey();
  const refreshRecord = environmentRefreshRecords.get(scopeKey) ?? {
    lastRequestedAt: 0,
    nextAttemptAt: 0,
  };
  environmentRefreshScheduler.schedule({
    eligible: true,
    projectId: scopeKey,
    lastRequestedAt: refreshRecord.lastRequestedAt,
    nextAttemptAt: refreshRecord.nextAttemptAt,
    now: Date.now(),
    refresh: (scheduledScopeKey) => {
      if (
        !environmentWorkspaceFocused()
        || activeEnvironmentKey() !== scheduledScopeKey
      ) return;
      void refreshCurrentEnvironment().catch(() => scheduleEnvironmentRefresh());
    },
  });
}

export async function refreshCurrentEnvironment({ force = false, minimumAgeMs = 0 } = {}) {
  clearEnvironmentRefreshTimer();
  if (viewState.mainView !== "thread") {
    stopEnvironmentRefresh();
    return false;
  }
  const projectId = activeProjectId();
  if (projectId == null) {
    environmentRequestSequence += 1;
    environmentRequestInFlight = null;
    appState.environment = null;
    if (viewState.mainView === "thread") renderThread();
    return false;
  }
  const now = Date.now();
  const threadId = viewState.currentThreadId;
  const scopeKey = environmentScopeKey(projectId, threadId);
  if (environmentScopeKey(appState.environment?.projectId, appState.environment?.threadId) !== scopeKey) {
    environmentRefreshRecords.set(scopeKey, {
      lastRequestedAt: 0,
      failureCount: 0,
      nextAttemptAt: 0,
    });
  }
  const refreshRecord = environmentRefreshRecords.get(scopeKey) ?? {
    lastRequestedAt: 0,
    failureCount: 0,
    nextAttemptAt: 0,
  };
  environmentRefreshRecords.set(scopeKey, refreshRecord);
  if (!environmentRefreshNeeded({
    currentProjectId: appState.environment?.projectId,
    requestedProjectId: projectId,
    currentThreadId: appState.environment?.threadId,
    requestedThreadId: threadId,
    lastRequestedAt: refreshRecord.lastRequestedAt,
    now,
    force,
    minimumAgeMs,
    nextAttemptAt: refreshRecord.nextAttemptAt,
  })) {
    scheduleEnvironmentRefresh();
    return false;
  }
  if (environmentRequestInFlight?.scopeKey === scopeKey) {
    environmentPostFlightQueue.queue(scopeKey, force);
    return environmentRequestInFlight.promise;
  }
  environmentPostFlightQueue.discardExcept(scopeKey);
  const requestSequence = ++environmentRequestSequence;
  refreshRecord.lastRequestedAt = now;
  const previousSnapshot = environmentScopeKey(appState.environment?.projectId, appState.environment?.threadId) === scopeKey
    ? appState.environment?.snapshot ?? null
    : null;
  appState.environment = {
    projectId,
    threadId,
    status: "loading",
    snapshot: previousSnapshot,
    error: null,
  };
  if (!previousSnapshot && viewState.mainView === "thread") renderThread();
  const completion = (async () => {
  try {
    const snapshot = await request(`/api/projects/${encodeURIComponent(projectId)}/environment?threadId=${encodeURIComponent(threadId)}`);
    if (requestSequence !== environmentRequestSequence || activeEnvironmentKey() !== scopeKey) {
      return false;
    }
    const resolved = resolveEnvironmentSnapshot(snapshot, previousSnapshot);
    appState.environment = {
      projectId,
      threadId,
      status: resolved.status,
      snapshot: resolved.snapshot,
      error: resolved.error,
    };
    if (resolved.retryable) {
      Object.assign(
        refreshRecord,
        environmentBackoffAfterFailure(refreshRecord.failureCount, Date.now()),
      );
    } else {
      refreshRecord.failureCount = 0;
      refreshRecord.nextAttemptAt = 0;
    }
  } catch (error) {
    if (requestSequence !== environmentRequestSequence || activeEnvironmentKey() !== scopeKey) {
      return false;
    }
    appState.environment = {
      projectId,
      threadId,
      status: "error",
      snapshot: previousSnapshot,
      error: error?.message || "Project context is temporarily unavailable.",
    };
    Object.assign(
      refreshRecord,
      environmentBackoffAfterFailure(refreshRecord.failureCount, Date.now()),
    );
  }
  if (viewState.mainView === "thread") renderThread();
  return true;
  })();
  environmentRequestInFlight = { scopeKey, promise: completion };
  try {
    return await completion;
  } finally {
    if (environmentRequestInFlight?.promise === completion) {
      environmentRequestInFlight = null;
      if (environmentPostFlightQueue.consume(
        scopeKey,
        activeEnvironmentKey(),
        viewState.mainView === "thread",
      )) {
        void refreshCurrentEnvironment({ force: true }).catch(() => {});
      } else {
        scheduleEnvironmentRefresh();
      }
    }
  }
}

export function stopEnvironmentRefresh() {
  clearEnvironmentRefreshTimer();
  environmentRequestSequence += 1;
  environmentRequestInFlight = null;
  environmentPostFlightQueue.clear();
  environmentRefreshRecords.clear();
}

export function updateCreateThreadAvailability() {
  $("#createThread").disabled = creatingFirstThread
    || !checkoutController.ready
    || !$("#newThreadPrompt").value.trim()
    || !viewState.selectedPermissionProfileId
    || (productApiAvailable && !newThreadModelSelectionReady());
  $("#createThread").title = composerSendTitle({
    ready: !productApiAvailable || newThreadModelSelectionReady(),
    modelSetup: productApiAvailable ? newThreadModelSetup() : null,
    readyTitle: "Create thread and send",
  });
}

function currentNavigationEntry() {
  return navigationEntryFromView({
    threadId: viewState.currentThreadId,
    turnId: viewState.currentInteractionId,
    layerPath: viewState.layerPath,
    selectedNodeId: viewState.selectedNodeId,
    temporalCurrent: viewState.temporalCurrent,
    invocationOrigin: viewState.invocationOrigin,
  });
}

function rememberNavigationMetadata(entry, {
  thread = appState.threads.find((candidate) => String(candidate.id) === String(entry?.threadId)),
  interaction = appState.interactions.find((candidate) => String(candidate.id) === String(entry?.turnId)),
  interactions = appState.interactions.filter((candidate) => String(candidate.threadId) === String(entry?.threadId)),
  layerPath = viewState.layerPath,
} = {}) {
  if (!entry || !thread || !interaction) return;
  navigationMetadata.set(navigationEntryKey(entry), navigationDestinationMetadata({
    thread,
    interaction,
    interactions,
    layerPath,
  }));
}

function protectCurrentLayers(entry = navigationHistory.current) {
  acceptedLayerCache.setProtected(entry ? descendantLayerIdentities(entry) : []);
}

function pruneNavigationMetadata() {
  const retained = new Set(navigationHistory.entries().map(navigationEntryKey));
  for (const key of navigationMetadata.keys()) {
    if (!retained.has(key)) navigationMetadata.delete(key);
  }
}

function recordCurrentNavigation(mode = "replace") {
  const entry = currentNavigationEntry();
  if (!entry) return false;
  rememberNavigationMetadata(entry);
  let changed;
  if (!navigationHistory.current) changed = navigationHistory.seed(entry);
  else if (mode === "push") changed = navigationHistory.push(entry);
  else if (
    String(navigationHistory.current.threadId) === String(entry.threadId)
    && String(navigationHistory.current.turnId) === String(entry.turnId)
  ) changed = navigationHistory.replaceCurrent(entry);
  else changed = false;
  pruneNavigationMetadata();
  protectCurrentLayers();
  return changed;
}

function cancelPendingRefresh() {
  clearTimeout(pendingRefreshTimer);
  pendingRefreshTimer = undefined;
  refreshGate.invalidate();
}

function layerContainsUnresolvedInvokedAction(layer, invocations = appState.actionInvocations) {
  const invokedActionIds = new Set(invocations.map(({ actionId }) => String(actionId)));
  return layer?.actions?.some(({ id, kind, targetLayerId }) => (
    kind === "invoke"
    && targetLayerId == null
    && invokedActionIds.has(String(id))
  )) ?? false;
}

const NONTERMINAL_INVOCATION_STATUSES = new Set([
  "not_started",
  "running",
  "submitted",
  "waiting_for_approval",
]);

function layerContainsPendingInvokedAction(layer, invocations = appState.actionInvocations) {
  return layerContainsUnresolvedInvokedAction(
    layer,
    invocations.filter(({ resultCompletionStatus }) => (
      resultCompletionStatus == null
      || NONTERMINAL_INVOCATION_STATUSES.has(resultCompletionStatus)
    )),
  );
}

function layerContainsRefreshableInvokedAction(layer, invocations = appState.actionInvocations) {
  return layerContainsUnresolvedInvokedAction(
    layer,
    invocations.filter(({ resultCompletionStatus }) => (
      resultCompletionStatus == null
      || resultCompletionStatus === "accepted"
      || NONTERMINAL_INVOCATION_STATUSES.has(resultCompletionStatus)
    )),
  );
}

function invokeResultIsRetryable(completionStatus) {
  return completionStatus === "submitted";
}

function invalidateResolvedInvokeLayerCache(invocations) {
  for (const identity of acceptedLayerCache.identities()) {
    const layer = acceptedLayerCache.get(identity);
    if (layerContainsUnresolvedInvokedAction(layer, invocations)) acceptedLayerCache.delete(identity);
  }
}

function supersedePendingHistory({
  presentationChanged = false,
  renderAfterCancel = true,
  cancelLayerNavigation = presentationChanged,
} = {}) {
  const wasPending = pendingHistoryTransition !== null;
  navigationHistory.cancelPending();
  pendingHistoryTransition = null;
  if (presentationChanged) cancelPendingRefresh();
  if (presentationChanged) {
    resolvedInvokeNavigationGate.invalidate();
    pendingResolvedInvokeNavigation = false;
  }
  if (cancelLayerNavigation) layerNavigationCoordinator.cancel();
  if (wasPending && renderAfterCancel) renderThread();
}

export function cancelNavigationHistory() {
  cancelAutomaticTurn();
  supersedePendingHistory({ presentationChanged: true, renderAfterCancel: false });
}

function schedulePendingRefresh(threadId, { force = false } = {}) {
  clearTimeout(pendingRefreshTimer);
  pendingRefreshTimer = undefined;
  const thread = appState.threads.find((candidate) => String(candidate.id) === String(threadId));
  if (!threadId || !thread) return;
  const hasStaleProjection = appState.interactions.some((interaction) => (
    String(interaction.threadId) === String(threadId)
    && interaction.projectionFresh === false
  ));
  if (thread.imported === true && !hasStaleProjection) return;
  const hasPendingInteraction = appState.interactions.some((interaction) => (
    String(interaction.threadId) === String(threadId)
    && (
      interaction.projectionFresh === false
      || (thread.imported !== true
        && ["not_started", "running", "submitted", "waiting_for_approval"].includes(interaction.completionStatus)
        && !restoredDraftForInteraction(interaction))
    )
  ))
    || hasStaleProjection
    || layerContainsPendingInvokedAction(
      appState.visibleLayer,
      appState.actionInvocations,
    );
  if (!force && !hasPendingInteraction) return;
  pendingRefreshTimer = setTimeout(() => {
    if (String(viewState.currentThreadId) !== String(threadId)) return;
    void refreshState(threadId).catch(() => schedulePendingRefresh(threadId, { force }));
  }, PENDING_REFRESH_INTERVAL_MS);
}

export async function refreshState(
  threadId = viewState.currentThreadId,
  { historyMode = "replace" } = {},
) {
  if (!productApiAvailable) {
    renderSidebar();
    renderScopeMenu();
    if (viewState.mainView === "settings") setMainView("settings");
    else if (viewState.currentThreadId) renderThread();
    else setMainView("new");
    return;
  }
  const refreshToken = refreshGate.begin();
  const refreshReadingIntent = readingIntent;
  const requestedThreadId = threadId;
  const stateQuery = new URLSearchParams();
  if (threadId) stateQuery.set("threadId", threadId);
  stateQuery.set("currentProjectionAfter", String(appState.currentProjectionCursor || 0));
  const pendingBeforeRefresh = pendingTurns.get(String(threadId));
  const visibleInteraction = appState.interactions.find(interaction => String(interaction.id) === String(viewState.currentInteractionId));
  const projectionInteractionId = pendingBeforeRefresh?.interactionId ?? ((visibleInteraction?.inertInvocationSource || visibleInteraction?.inertInvocationCurrent && !visibleInteraction?.nativeInvocationCurrent)
    ? null : visibleInteraction?.inertInvocationCurrent
      ? visibleInteraction.invocationSourceInteractionId : viewState.currentInteractionId);
  // URL-restored inert IDs are local presentation keys, never numeric API routes.
  if (projectionInteractionId != null && /^[1-9][0-9]*$/.test(String(projectionInteractionId))
    && Number.isSafeInteger(Number(projectionInteractionId))) {
    stateQuery.set("currentProjectionInteractionId", String(projectionInteractionId));
  }
  const selectedBeforeRefresh = appState.interactions.find((interaction) => (
    String(interaction.id) === String(projectionInteractionId)
  ));
  if (selectedBeforeRefresh?.graphNodeId != null) {
    stateQuery.set("currentProjectionCompletionId", String(selectedBeforeRefresh.graphNodeId));
  }
  const state = await request(`/api/state?${stateQuery}`);
  if (
    !refreshGate.isCurrent(refreshToken)
    || (requestedThreadId && String(viewState.currentThreadId) !== String(requestedThreadId))
  ) return false;
  projectImportedInvocationSources(state);
  // The visible layer belongs to the hydrated presentation, not a pending
  // turn-selection intent (invoke advances that intent before this refresh).
  const previousInteractionId = appState.currentInteractionId;
  const previousLiveInteraction = latestInteractionForThread(appState.interactions, threadId);
  const previousProjectId = activeProjectId();
  const previousVisibleLayer = appState.visibleLayer;
  const nextProjects = state.projects || [];
  const nextThreads = state.threads || [];
  const nextInteractions = [...(state.interactions || [])];
  const nextImportedHistory = state.importedInvocationHistory ?? [];
  if (visibleInteraction?.nativeInvocationCurrent) {
    const local = inertInvocationPresentations.get(inertPresentationKey(threadId, visibleInteraction.id));
    const previous = local?.detail.actionInvocations.find(call => call.graphOnly === true
      && String(call.nativeInvocation?.invocation?.id) === String(visibleInteraction.invocationId));
    const retained = (state.actionInvocations ?? []).find(call => call.graphOnly === true
      && String(call.nativeInvocation?.invocation?.id) === String(visibleInteraction.invocationId));
    // A refreshed or missing graph Current cannot silently replace the snapshot
    // the reader opened. Changed evidence falls back to the source instead.
    if (previous && retained && JSON.stringify(previous.nativeInvocation) === JSON.stringify(retained.nativeInvocation)) {
      nextInteractions.push(visibleInteraction);
    }
  } else if (visibleInteraction?.inertInvocationCurrent) {
    const retained = nextImportedHistory.find(entry => entry.inert === true
      && String(entry.threadId) === String(threadId)
      && String(entry.presentationSource?.interactionId ?? entry.sourceInteractionId) === String(visibleInteraction.invocationSourceInteractionId)
      && entry.record?.id === visibleInteraction.invocationId);
    const local = inertInvocationPresentations.get(inertPresentationKey(threadId, visibleInteraction.id));
    const previous = local?.detail.importedInvocationHistory.find(entry => entry.record?.id === retained?.record?.id);
    if (nextThreads.some(thread => String(thread.id) === String(threadId) && thread.imported === true)
      && retained && previous && JSON.stringify(retained.record) === JSON.stringify(previous.record)) {
      nextInteractions.push(visibleInteraction);
    }
  }
  for (const [key, local] of inertInvocationPresentations) {
    const threadExists = nextThreads.some(thread => String(thread.id) === String(local.detail.thread.id));
    const retained = local.nativeCall == null
      ? nextImportedHistory.some(entry => String(entry.threadId) === String(local.detail.thread.id)
        && (local.importedCall == null || entry.record?.id === local.importedCall.record?.id
          && JSON.stringify(entry.record) === JSON.stringify(local.importedCall.record)))
      : (state.actionInvocations ?? []).some(call => call.graphOnly === true
        && call.invocationKey === local.nativeCall.invocationKey
        && JSON.stringify(call.nativeInvocation) === JSON.stringify(local.nativeCall.nativeInvocation));
    if (!threadExists || !retained) inertInvocationPresentations.delete(key);
  }
  const nextActionInvocations = state.actionInvocations || [];
  const nextApprovals = Array.isArray(state.approvals) ? state.approvals : [];
  const active = nextThreads.find((thread) => thread.active);
  // The backend active chat restores the initial workspace only. A global
  // refresh cannot supersede a newer client choice to stay in the composer.
  const nextThreadId = threadId ?? viewState.currentThreadId
    ?? (readingIntent === 0 ? active?.id : null);
  invalidateResolvedInvokeLayerCache(nextActionInvocations);
  const threadInteractions = nextInteractions.filter((interaction) => (
    String(interaction.threadId) === String(nextThreadId)
  ));
  const pending = pendingTurns.get(String(nextThreadId));
  let pendingReadFailed = false;
  if (pending) {
    const target = threadInteractions.find((item) => String(item.id) === String(pending.interactionId));
    pending.status = target?.completionStatus ?? pending.status;
    if (displayableLayer(target?.completionOutput?.rootLayer)) {
      pending.readyLayer = target.completionOutput.rootLayer;
    }
    const projection = state.currentProjection?.states?.find((item) => (
      String(item.completionId) === String(target?.graphNodeId) && item.temporalFeatures?.projectionUi === true
    ));
    if (projection?.currentLayerId != null && String(projection.currentLayerId) !== String(pending.readyLayer?.layer?.id)) {
      const intent = readingIntent;
      try {
        const identity = { threadId: nextThreadId, turnId: target.id, layerId: projection.currentLayerId };
        const layer = validateResolvedLayer(identity, await request(
          `/api/threads/${encodeURIComponent(nextThreadId)}/interactions/${encodeURIComponent(target.id)}/layers/${encodeURIComponent(projection.currentLayerId)}`,
        ));
        if (displayableLayer(layer)) {
          pending.readyLayer = layer;
          pending.temporalCurrent = { completionId: projection.completionId, revision: projection.headRevision, mode: "following" };
          acceptedLayerCache.set(identity, layer);
        }
      } catch { pendingReadFailed = true; }
      if (!refreshGate.isCurrent(refreshToken) || readingIntent !== intent
        || String(viewState.currentThreadId) !== String(nextThreadId)) {
        schedulePendingRefresh(viewState.currentThreadId, { force: true });
        return false;
      }
    }
    if (pending.readyLayer && String(projection?.currentLayerId) === String(pending.readyLayer.layer.id)) {
      pending.temporalCurrent = { completionId: projection.completionId, revision: projection.headRevision, mode: "following" };
    }
  }
  const advancePending = pending?.auto && pending.readyLayer && viewState.mainView === "thread";
  const selected = (advancePending ? threadInteractions.find((item) => String(item.id) === String(pending.interactionId)) : null) || threadInteractions.find((interaction) => (
    String(interaction.id) === String(viewState.currentInteractionId)
  )) || (visibleInteraction?.inertInvocationCurrent ? threadInteractions.find(interaction =>
    String(interaction.id) === String(visibleInteraction.invocationSourceInteractionId)) : null)
    || humanTurns({ interactions: threadInteractions, actionInvocations: nextActionInvocations, importedInvocationHistory: nextImportedHistory }, { id: nextThreadId }).at(-1);
  let restoredInvocationSource = null;
  const sourceEntry = visibleInteraction?.inertInvocationCurrent
    && String(selected?.id) === String(visibleInteraction.invocationSourceInteractionId)
    ? viewState.invocationOrigin?.sourceEntry : null;
  if (sourceEntry) {
    try {
      const last = sourceEntry.navigationPath.at(-1);
      if (last) acceptedLayerCache.delete({ threadId: nextThreadId, turnId: selected.id, layerId: last.layerId });
      restoredInvocationSource = await resolveNavigationPresentation(sourceEntry, {
        loadThread: async () => ({ thread: nextThreads.find(thread => String(thread.id) === String(nextThreadId)),
          interactions: threadInteractions, actionInvocations: nextActionInvocations, importedInvocationHistory: nextImportedHistory }),
        loadLayer: ({ threadId, turnId, layerId }) => {
          const local = inertInvocationPresentations.get(inertPresentationKey(threadId, turnId));
          if (local) return local.layers.has(String(layerId)) ? Promise.resolve(local.layers.get(String(layerId)))
            : Promise.reject(new Error("Frozen source Layer is unavailable."));
          return request(`/api/threads/${encodeURIComponent(threadId)}/interactions/${encodeURIComponent(turnId)}/layers/${encodeURIComponent(layerId)}`);
        },
        layerCache: selected?.inertInvocationSource ? null : acceptedLayerCache,
      });
    } catch { /* An unavailable source path falls back to its canonical turn. */ }
    if (!refreshGate.isCurrent(refreshToken) || readingIntent !== refreshReadingIntent
      || String(viewState.currentThreadId) !== String(nextThreadId)) return false;
  }
  let refreshedVisibleLayer = visibleLayerAfterRefresh(
    previousInteractionId,
    previousVisibleLayer,
    selected,
  );
  if (advancePending) refreshedVisibleLayer = pending.readyLayer;
  if (restoredInvocationSource) refreshedVisibleLayer = restoredInvocationSource.layer;
  let temporalSelectedNodeId;
  let temporalCurrent = advancePending ? pending.temporalCurrent ?? null : viewState.temporalCurrent;
  if (restoredInvocationSource) temporalCurrent = restoredInvocationSource.entry.temporalCurrent;
  let temporalProjectionFailed = false;
  let canonicalVisibleLayerRead = false;
  const projectionPage = state.currentProjection;
  const projectionState = projectionPage?.states?.find((projection) => (
    String(projection.completionId) === String(selected?.graphNodeId)
    && projection.temporalFeatures?.projectionUi === true
  ));
  const previousProjection = projectionState == null
    ? null
    : appState.currentProjections.get(String(projectionState.completionId)) ?? null;
  if (projectionState) {
    const previousLayerId = previousProjection?.currentLayerId ?? null;
    const visibleLayerId = previousVisibleLayer?.layer?.id ?? null;
    const selectedChanged = String(previousInteractionId) !== String(selected?.id);
    const wasFollowing = restoredInvocationSource ? false : previousProjection == null
      ? previousVisibleLayer == null || selectedChanged
      : (selectedChanged && viewState.temporalCurrent == null)
        || (
          viewState.temporalCurrent?.mode === "following"
          && String(viewState.temporalCurrent.completionId) === String(projectionState.completionId)
          && Number(viewState.temporalCurrent.revision) === Number(previousProjection.headRevision)
          && String(visibleLayerId) === String(previousLayerId)
        );
    const changed = previousProjection == null
      || Number(projectionState.headRevision) > Number(previousProjection.headRevision);
    if (changed && wasFollowing && projectionState.currentLayerId == null) {
      temporalCurrent = {
        completionId: projectionState.completionId,
        revision: projectionState.headRevision,
        mode: "following",
      };
    } else if (
      changed
      && viewState.temporalCurrent?.mode === "pinned"
      && String(viewState.temporalCurrent.completionId) === String(projectionState.completionId)
    ) {
      temporalCurrent = {
        completionId: projectionState.completionId,
        revision: projectionState.headRevision,
        mode: "pinned",
      };
    }
    if (changed && wasFollowing && projectionState.currentLayerId != null && selected) {
      const identity = {
        threadId: nextThreadId,
        turnId: selected.id,
        layerId: projectionState.currentLayerId,
      };
      try {
        const currentLayer = validateResolvedLayer(identity, await request(
          `/api/threads/${encodeURIComponent(identity.threadId)}/interactions/${encodeURIComponent(identity.turnId)}/layers/${encodeURIComponent(identity.layerId)}`,
        ));
        if (
          !refreshGate.isCurrent(refreshToken)
          || (requestedThreadId && String(viewState.currentThreadId) !== String(requestedThreadId))
        ) return false;
        const reconciled = reconcileCurrentProjection({
          completionId: projectionState.completionId,
          revision: previousProjection?.headRevision ?? 0,
          lifecycle: previousProjection?.lifecycle ?? "active",
          currentLayerId: previousLayerId,
          finalLayerId: previousProjection?.finalLayerId ?? null,
          mode: "following",
          visibleTarget: previousLayerId == null
            ? { kind: "anchor", completionId: projectionState.completionId, revision: previousProjection?.headRevision ?? 0 }
            : { kind: "layer", completionId: projectionState.completionId, layerId: previousLayerId },
          selectedNodeId: viewState.selectedNodeId,
        }, {
          completionId: projectionState.completionId,
          revision: projectionState.headRevision,
          previousRevision: previousProjection?.headRevision ?? 0,
          lifecycle: projectionState.lifecycle,
          currentLayerId: projectionState.currentLayerId,
          finalLayerId: projectionState.finalLayerId,
          safeReason: projectionState.safeReason,
          currentNodeIds: currentLayer.nodes.map(({ id }) => id),
        });
        refreshedVisibleLayer = currentLayer;
        canonicalVisibleLayerRead = true;
        temporalSelectedNodeId = reconciled.view.selectedNodeId;
        temporalCurrent = {
          completionId: projectionState.completionId,
          revision: projectionState.headRevision,
          mode: "following",
        };
        acceptedLayerCache.set(identity, currentLayer);
      } catch {
        temporalProjectionFailed = true;
      }
    }
  }
  const visibleLayerId = refreshedVisibleLayer?.layer?.id;
  let canonicalRefreshFailed = false;
  if (
    selected
    && !selected.inertInvocationCurrent
    && !selected.inertInvocationSource
    && visibleLayerId != null
    // A successful temporal read already supplies this exact canonical layer.
    // Do not add another await after reconciling its node selection.
    && !canonicalVisibleLayerRead
    && ((selected.completionStatus === "accepted"
      && String(visibleLayerId) !== String(selected.completionOutput?.rootLayer?.layer?.id))
      || layerContainsRefreshableInvokedAction(refreshedVisibleLayer, nextActionInvocations))
  ) {
    const identity = {
      threadId: nextThreadId,
      turnId: selected.id,
      layerId: visibleLayerId,
    };
    try {
      // Accepted descendant membership may gain a resolved invoke absent from
      // its old snapshot. Revalidate only the visible layer on an existing refresh.
      acceptedLayerCache.delete(identity);
      const canonicalLayer = validateResolvedLayer(identity, await request(
        `/api/threads/${encodeURIComponent(identity.threadId)}/interactions/${encodeURIComponent(identity.turnId)}/layers/${encodeURIComponent(identity.layerId)}`,
      ));
      if (
        !refreshGate.isCurrent(refreshToken)
        || (requestedThreadId && String(viewState.currentThreadId) !== String(requestedThreadId))
      ) return false;
      refreshedVisibleLayer = canonicalLayer;
      acceptedLayerCache.set(identity, canonicalLayer);
    } catch {
      // Preserve the last durable presentation if the local graph read is temporarily unavailable.
      // The product interaction may already be terminal, so retain an explicit client retry
      // responsibility instead of relying only on completion-status polling.
      canonicalRefreshFailed = true;
    }
  }
  if (
    !refreshGate.isCurrent(refreshToken)
    || (requestedThreadId && String(viewState.currentThreadId) !== String(requestedThreadId))
  ) return false;
  if (advancePending && !pending.auto) {
    schedulePendingRefresh(viewState.currentThreadId, { force: true });
    return false;
  }
  appState.pendingTurn = pending ?? null;
  if (advancePending && pending.auto) {
    pendingTurns.delete(String(nextThreadId));
    appState.pendingTurn = null;
  }
  appState.projects = nextProjects;
  appState.conversationCompatibility = state.conversationCompatibility ?? null;
  appState.threads = nextThreads;
  appState.interactions = nextInteractions;
  appState.actionInvocations = nextActionInvocations;
  appState.invocationInventoryAvailable = state.invocationInventoryAvailable === true;
  appState.importedInvocationHistory = state.importedInvocationHistory ?? [];
  appState.approvals = nextApprovals;
  appState.inputDraftRevision = Number.isSafeInteger(state.inputDraftRevision)
    ? state.inputDraftRevision
    : null;
  appState.capabilities = state.capabilities;
  appState.temporalSafeReason = projectionState?.safeReason ?? null;
  appState.temporalLifecycle = projectionState?.lifecycle ?? null;
  if (projectionPage && !temporalProjectionFailed && !pendingReadFailed) {
    appState.currentProjectionCursor = projectionPage.cursor;
    for (const projection of projectionPage.states || []) {
      appState.currentProjections.set(String(projection.completionId), projection);
    }
  }
  viewState.currentThreadId = nextThreadId;
  hydrateWorkspace(selected, refreshedVisibleLayer, {
    ...(restoredInvocationSource ? { layerPath: restoredInvocationSource.layerPath,
      selectedNodeId: restoredInvocationSource.selectedNodeId, invocationOrigin: null } : {}),
    ...(temporalSelectedNodeId === undefined ? {} : { selectedNodeId: temporalSelectedNodeId }),
    ...(advancePending ? { invocationOrigin: pendingInvocationOrigin(pending, nextActionInvocations) } : {}),
    temporalCurrent,
  });
  recordCurrentNavigation(advancePending || visibleInteraction?.inertInvocationCurrent && !selected?.inertInvocationCurrent ? "push" : historyMode);
  renderSidebar();
  renderScopeMenu();
  if (viewState.mainView === "settings") setMainView("settings");
  else if (viewState.currentThreadId) renderThread();
  else setMainView("new");
  const nextProjectId = activeProjectId();
  const projectChanged = String(previousProjectId) !== String(nextProjectId);
  const nextLiveInteraction = latestInteractionForThread(nextInteractions, nextThreadId);
  const terminalTransition = interactionReachedTerminal(previousLiveInteraction, nextLiveInteraction);
  void refreshCurrentEnvironment({ force: projectChanged || terminalTransition }).catch(() => {});
  schedulePendingRefresh(viewState.currentThreadId, {
    force: pendingReadFailed || canonicalRefreshFailed || temporalProjectionFailed || projectionPage?.hasMore === true,
  });
  return true;
}

export async function loadThread(threadId) {
  cancelAutomaticTurn();
  recordCurrentNavigation();
  supersedePendingHistory({ presentationChanged: true });
  viewState.currentThreadId = threadId;
  viewState.currentInteractionId = null;
  viewState.selectedNodeId = null;
  viewState.temporalCurrent = null;
  viewState.invocationOrigin = null;
  setMainView("thread");
  const url = new URL(location.href);
  url.searchParams.set("threadId", threadId);
  history.replaceState(null, "", url);
  await refreshState(threadId, { historyMode: "push" });
  if (String(viewState.currentThreadId) === String(threadId)) {
    const thread = appState.threads.find((item) => String(item.id) === String(threadId));
    const restored = await restoreArchivedForNavigation(thread);
    if (restored !== thread && String(viewState.currentThreadId) === String(threadId)) {
      appState.threads = appState.threads.map((item) => String(item.id) === String(threadId) ? { ...item, ...restored } : item);
      renderSidebar();
      renderThread();
    }
    expandThreadProject(appState.threads.find((thread) => String(thread.id) === String(threadId)));
    renderSidebar();
  }
}

export function hydrateWorkspace(
  interaction,
  layer = interaction?.completionOutput?.rootLayer ?? null,
  { layerPath, selectedNodeId, temporalCurrent, invocationOrigin, restoreSelection = false } = {},
) {
  const previousInteractionId = viewState.currentInteractionId;
  const previousLayerId = viewState.layerPath.at(-1)?.layerId;
  const nextLayerPath = layerPath ?? layerPathForVisibleLayer(
    String(previousInteractionId) === String(interaction?.id) ? viewState.layerPath : [],
    interaction,
    layer,
  );
  const nextLayerId = nextLayerPath.at(-1)?.layerId;
  if (
    String(previousInteractionId) !== String(interaction?.id)
    || String(previousLayerId) !== String(nextLayerId)
  ) {
    viewState.nodeDetailsClosed = restoreSelection && selectedNodeId === null;
    viewState.selectedNodeId = viewState.nodeDetailsClosed ? null : preferredLayerNode(layer, selectedNodeId, rememberedLayerSelection(
      viewState.currentThreadId, interaction?.id, layer?.layer?.id,
    ));
  } else if (selectedNodeId !== undefined) {
    viewState.nodeDetailsClosed = restoreSelection && selectedNodeId === null;
    viewState.selectedNodeId = selectedNodeId;
  }
  viewState.currentInteractionId = interaction?.id ?? null;
  viewState.layerPath = nextLayerPath;
  if (invocationOrigin !== undefined) viewState.invocationOrigin = invocationOrigin;
  else if (String(previousInteractionId) !== String(interaction?.id)) viewState.invocationOrigin = null;
  if (temporalCurrent !== undefined) viewState.temporalCurrent = temporalCurrent;
  else if (String(previousInteractionId) !== String(interaction?.id)) viewState.temporalCurrent = null;
  appState.currentInteractionId = interaction?.id ?? null;
  appState.status = interaction?.completionStatus || "idle";
  appState.visibleLayer = layer;
  appState.nodes = layer?.nodes ? [...layer.nodes] : [];
  appState.edges = layer?.edges ? [...layer.edges] : [];
  appState.actions = layer?.actions ? [...layer.actions] : [];
  const url = workspaceUrlForPresentation(location.href, {
    threadId: viewState.currentThreadId,
    turnId: interaction?.inertInvocationCurrent ? interaction.invocationSourceInteractionId : interaction?.id,
  });
  history.replaceState(null, "", url);
}

export function selectTurn(offset) {
  const turns = workspaceTurns(appState, { id: viewState.currentThreadId });
  const current = turns.findIndex((interaction) => (
    String(interaction.id) === String(viewState.currentInteractionId)
  ));
  const target = turns[current + offset];
  if (!target) return;
  selectTurnById(target.id);
}

export function selectTurnById(interactionId, { responseRoot = false, threadId = viewState.currentThreadId } = {}) {
  if (String(threadId) !== String(viewState.currentThreadId)) {
    return selectInteractionGraphSource(threadId, interactionId);
  }
  const target = appState.interactions.find((interaction) => (
    String(interaction.threadId) === String(viewState.currentThreadId)
    && String(interaction.id) === String(interactionId)
  ));
  if (responseRoot && !target?.completionOutput?.rootLayer) return;
  if (!target || (!responseRoot && String(target.id) === String(viewState.currentInteractionId))) return;
  cancelAutomaticTurn();
  supersedePendingHistory({ presentationChanged: true });
  viewState.selectedNodeId = null;
  const projection = appState.currentProjections.get(String(target.graphNodeId));
  hydrateWorkspace(target, undefined, {
    invocationOrigin: null,
    temporalCurrent: projection == null ? null : {
      completionId: projection.completionId,
      revision: projection.headRevision,
      mode: "pinned",
    },
  });
  recordCurrentNavigation("push");
  renderThread();
  schedulePendingRefresh(viewState.currentThreadId, { force: true });
}

export async function selectInteractionGraphSource(threadId, interactionId, { invocationOrigin = null } = {}) {
  cancelAutomaticTurn();
  recordCurrentNavigation();
  const sourceLocationKey = navigationEntryKey(currentNavigationEntry());
  supersedePendingHistory({ presentationChanged: true });
  const resultInteractionId = viewState.currentInteractionId;
  const requestToken = resolvedInvokeNavigationGate.begin();
  pendingResolvedInvokeNavigation = true;
  try {
    const cached = inertInvocationPresentations.get(inertPresentationKey(threadId, interactionId));
    const local = invocationOrigin || cached?.detail.interactions.some(item => String(item.id) === String(interactionId)
      && item.inertInvocationSource) ? cached : null;
    let resolved = await resolveNavigationPresentation(invocationOrigin?.sourceEntry ?? {
      threadId, turnId: interactionId, navigationPath: [], selectedNodeId: null,
    }, {
      loadThread: (id) => local ? Promise.resolve(local.detail) : request(`/api/threads/${encodeURIComponent(id)}`),
      loadLayer: ({ threadId, turnId, layerId }) => local ? (local.layers.has(String(layerId))
        ? Promise.resolve(local.layers.get(String(layerId))) : Promise.reject(new Error("Invocation source Layer is unavailable."))) : request(
        `/api/threads/${encodeURIComponent(threadId)}/interactions/${encodeURIComponent(turnId)}/layers/${encodeURIComponent(layerId)}`,
      ),
      layerCache: local ? null : acceptedLayerCache,
    });
    if (!resolved.interaction.completionOutput?.rootLayer && !invocationOrigin) return false;
    if (invocationOrigin && !invocationOriginForSource(
      invocationOrigin, resolved.layer, resolved.actionInvocations, resultInteractionId, resolved.importedInvocationHistory,
    )) throw new Error("The invoking Node is no longer available.");
    if (!resolvedInvokeNavigationGate.isCurrent(requestToken)
      || !currentNavigationEntry()
      || navigationEntryKey(currentNavigationEntry()) !== sourceLocationKey) return false;
    if (String(resolved.thread.id) !== String(viewState.currentThreadId)) {
      resolved = { ...resolved, thread: await restoreArchivedForNavigation(resolved.thread) };
      if (!resolvedInvokeNavigationGate.isCurrent(requestToken)
        || navigationEntryKey(currentNavigationEntry()) !== sourceLocationKey) return false;
    }
    refreshGate.invalidate();
    layerNavigationCoordinator.cancel();
    applyResolvedPresentation(resolved);
    recordCurrentNavigation("push");
    expandThreadProject(appState.threads.find((thread) => String(thread.id) === String(resolved.thread.id)));
    renderSidebar();
    schedulePendingRefresh(viewState.currentThreadId);
    return true;
  } finally {
    if (resolvedInvokeNavigationGate.isCurrent(requestToken)) {
      pendingResolvedInvokeNavigation = false;
      renderThread();
    }
  }
}

export async function submitInteraction(
  text,
  modelSelection,
  contexts = [],
  contextConfirmationIds = [],
  inputIdentityRevision = null,
  inputDraftRevision = null,
) {
  if (!viewState.currentThreadId) throw new Error("Select a thread before sending a follow-up.");
  if (appState.threads.some(thread => String(thread.id) === String(viewState.currentThreadId) && thread.imported === true)
    || appState.interactions.some(interaction => String(interaction.id) === String(viewState.currentInteractionId) && interaction.inertInvocationCurrent)) {
    throw new Error("This Invocation history is read only. Return to the source before sending a follow-up.");
  }
  const threadId = viewState.currentThreadId;
  const intent = readingIntent;
  recordCurrentNavigation();
  supersedePendingHistory({ cancelLayerNavigation: true });
  const thread = appState.threads.find((candidate) => String(candidate.id) === String(threadId));
  const harnessId = thread?.harnessId ?? thread?.harnessConfigurationName;
  if (!modelSelection && !harnessUsesConfigurationModel(appState.modelSettings, harnessId)) {
    setSettingsTab("models");
    setMainView("settings");
    throw new Error("Choose an available model in Settings before sending.");
  }
  let createdInteraction;
  const inputId = stableFollowupInputId(
    threadId,
    text,
    modelSelection,
    contexts,
    contextConfirmationIds,
    inputIdentityRevision,
  );
  try {
    // A child an agent launched is not a human turn: a follow-up or retry never targets it.
    const latestInteraction = humanTurns(appState, { id: threadId }).at(-1);
    const { path, body: retryBody } = interactionSubmissionTarget(
      threadId,
      latestInteraction,
      text,
      modelSelection,
      inputId,
      contexts,
      contextConfirmationIds,
      inputDraftRevision,
    );
    const body = restoredDraftForInteraction(latestInteraction)
      ? retryBody
      : followupRequestBody(
        text,
        modelSelection,
        inputId,
        contexts,
        contextConfirmationIds,
        inputDraftRevision,
      );
    const response = await request(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
    createdInteraction = response?.interaction ?? response;
  } catch (error) {
    await refreshAfterModelSelectionRejection(error, true);
    throw error;
  }
  markFollowupSendSucceeded(inputId);
  try {
    await onboardingTutorialController()?.followupSubmitted({
      threadId,
      interactionId: createdInteraction?.id,
    });
  } catch (error) {
    console.error("Tutorial completion failed:", error);
  }
  trackPendingTurn(threadId, createdInteraction?.id, intent);
  if (String(viewState.currentThreadId) !== String(threadId)) return createdInteraction;
  try {
    await refreshState(threadId, { historyMode: "push" });
  } catch (error) {
    toast("Message sent. Refreshing the new turn…");
    schedulePendingRefresh(threadId, { force: true });
  }
  return createdInteraction;
}

async function refreshAfterModelSelectionRejection(error, renderOngoingPicker = false) {
  if (!isModelSelectionCatalogError(error)) return;
  await refreshModelFamilySettings().catch(() => {});
  if (renderOngoingPicker) renderThread();
}

export async function decideApproval(requestId, decision) {
  if (!validApprovalDecision(decision)) {
    throw new Error(`Unsupported approval decision: ${String(decision)}`);
  }
  const threadId = viewState.currentThreadId;
  const thread = appState.threads.find((candidate) => String(candidate.id) === String(threadId));
  const receipt = pendingApprovalsForThread(appState, thread).find((candidate) => (
    String(candidate.request.requestId) === String(requestId)
  ));
  if (!threadId || !receipt) {
    const error = new Error("This approval request is no longer actionable.");
    error.code = "approval_not_actionable";
    throw error;
  }
  const requestKey = String(requestId);
  if (appState.pendingApprovalDecisions.some((id) => String(id) === requestKey)) return;
  const renderDecisionState = () => {
    try {
      renderThread();
    } catch (error) {
      console.error("Approval presentation refresh failed:", error);
    }
  };
  appState.pendingApprovalDecisions.push(requestKey);
  renderDecisionState();
  try {
    try {
      await request(
        `/api/threads/${encodeURIComponent(threadId)}/interactions/${encodeURIComponent(receipt.request.correlation.interactionId)}/approvals/${encodeURIComponent(requestId)}/decision`,
        {
          method: "POST",
          body: JSON.stringify({ decision }),
        },
      );
    } catch (error) {
      if (String(viewState.currentThreadId) === String(threadId)) {
        await refreshState(threadId).catch(() => {});
      }
      throw error;
    }
    if (String(viewState.currentThreadId) === String(threadId)) {
      await refreshState(threadId).catch((error) => {
        console.error("Approval decision was recorded, but its presentation refresh failed:", error);
        schedulePendingRefresh(threadId, { force: true });
      });
    }
  } finally {
    appState.pendingApprovalDecisions = appState.pendingApprovalDecisions.filter((id) => (
      String(id) !== requestKey
    ));
    if (String(viewState.currentThreadId) === String(threadId)) renderDecisionState();
  }
}

let sharedArtifactViewer = null;
// Artifact notes are confirmed node contexts on the artifact node, so they join the
// thread's one chat draft and send as one interaction (PRD 6.6.8).
const artifactNoteApi = createNodeContextDraftApi();
const artifactNotes = Object.freeze({
  async list({ threadId, node }) {
    const response = await artifactNoteApi.list(threadId);
    return (response?.confirmations ?? [])
      .filter((confirmation) => String(confirmation.target?.nodeId) === String(node.id))
      .map((confirmation) => ({ id: String(confirmation.draftId), text: confirmation.annotation, confirmation }));
  },
  async add({ threadId, node, target, text }) {
    const draft = {
      id: globalThis.crypto.randomUUID(),
      target,
      targetNode: { id: node.id, kind: node.kind, icon: node.icon, title: node.title, detail: node.detail, state: node.state || "accepted" },
      text,
      revision: null,
    };
    const saved = await artifactNoteApi.save(threadId, draft);
    try {
      await artifactNoteApi.confirm(threadId, { id: draft.id, revision: saved.revision });
    } catch (error) {
      // The confirm may have committed with its response lost; never confirm a duplicate.
      const listed = await artifactNoteApi.list(threadId).catch(() => null);
      if (!listed?.confirmations?.some((confirmation) => String(confirmation.draftId) === draft.id)) throw error;
    }
    // The composer has the note before the panel shows it, so an immediate Send includes it.
    const { reloadComposerContexts } = await import("./graph.js");
    await reloadComposerContexts(threadId);
  },
  remove: ({ threadId, note }) => artifactNoteApi.dismissConfirmation(threadId, note.confirmation),
});

function artifactViewer() {
  sharedArtifactViewer ??= createArtifactViewer({
    native: window.relayerDesktop?.artifactViewer ?? null,
    notes: artifactNotes,
    onClose: (threadId) => {
      if (threadId != null) void import("./graph.js").then(({ reloadComposerContexts }) => reloadComposerContexts(threadId)).catch(() => {});
    },
    onAddToChat: (text) => {
      const prompt = $("#threadPrompt");
      if (!prompt) return;
      prompt.value = prompt.value ? `${prompt.value}\n\n${text}` : text;
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
      prompt.focus();
    },
  });
  return sharedArtifactViewer;
}

const inertInvocationPresentations = new Map();
const inertPresentationKey = (threadId, turnId) => `${threadId}\u0000${turnId}`;

// Frozen sources are presentation only. Canonical source IDs from the API stay null.
function projectImportedInvocationSources(state) {
  const interactions = [...(state.interactions ?? [])];
  const history = (state.importedInvocationHistory ?? []).map(entry => {
    const thread = state.threads?.find(thread => thread.imported === true && String(thread.id) === String(entry.threadId));
    if (!thread || entry.inert !== true || !entry.record || entry.sourceInteractionId != null
      && entry.sourceNodeId != null && entry.sourceActionId != null && entry.presentingLayerId != null) return entry;
    const source = inertInvocationSource(entry.record, entry.sourceTurn ? [entry.sourceTurn] : [], thread.id);
    const layer = source.completionOutput.rootLayer;
    interactions.push(source);
    return { ...entry, presentationSource: { interactionId: source.id, nodeId: entry.record.source.parentNodeId,
      actionId: entry.record.source.actionId, layerId: layer.layer.id } };
  });
  state.interactions = interactions;
  state.importedInvocationHistory = history;
  for (const entry of history) {
    if (!entry.presentationSource) continue;
    const source = interactions.find(item => String(item.threadId) === String(entry.threadId) && item.id === entry.presentationSource.interactionId);
    const thread = state.threads.find(thread => String(thread.id) === String(entry.threadId));
    inertInvocationPresentations.set(inertPresentationKey(thread.id, source.id), {
      detail: { thread, interactions: interactions.filter(item => String(item.threadId) === String(thread.id)),
        actionInvocations: state.actionInvocations ?? [], invocationInventoryAvailable: false,
        importedInvocationHistory: history.filter(item => String(item.threadId) === String(thread.id)), approvals: [] },
      layers: new Map([[String(source.completionOutput.rootLayer.layer.id), source.completionOutput.rootLayer]]),
      nativeCall: null, importedCall: entry,
    });
  }
}

function retainInvocationPresentation(thread, source, interaction, layers, origin, nativeCall = null, importedCall = null) {
  const sourceLayers = new Map([source?.completionOutput?.rootLayer, appState.visibleLayer].filter(Boolean).map(layer => [String(layer.layer.id), layer]));
  for (const step of viewState.layerPath) {
    const layer = acceptedLayerCache.get({ threadId: thread.id, turnId: source.id, layerId: step.layerId });
    if (layer) sourceLayers.set(String(step.layerId), layer);
  }
  const interactions = [...appState.interactions.filter(item => String(item.id) !== String(interaction.id)), interaction];
  const detail = { thread, interactions, actionInvocations: appState.actionInvocations,
    invocationInventoryAvailable: appState.invocationInventoryAvailable,
    importedInvocationHistory: appState.importedInvocationHistory, approvals: [] };
  inertInvocationPresentations.set(inertPresentationKey(thread.id, source.id), { detail, layers: sourceLayers, nativeCall, importedCall });
  inertInvocationPresentations.set(inertPresentationKey(thread.id, interaction.id), { detail, layers, nativeCall, importedCall });
  appState.interactions = interactions;
  cancelAutomaticTurn();
  cancelPendingRefresh();
  recordCurrentNavigation();
  supersedePendingHistory({ presentationChanged: true });
  hydrateWorkspace(interaction, undefined, { selectedNodeId: null, invocationOrigin: origin });
  recordCurrentNavigation("push");
  renderThread();
  return true;
}

function retainedInvocationOrigin(thread, source, call, resultId, kind) {
  const presentingLayerId = call.presentationSource?.layerId ?? call.presentingLayerId;
  const sourceNodeId = kind === "graph" ? call.nativeInvocation?.invocation?.parentNodeId : call.presentationSource?.nodeId ?? call.sourceNodeId;
  const actionId = kind === "graph" ? call.actionId : call.presentationSource?.actionId ?? call.sourceActionId;
  const invocationId = kind === "graph" ? call.nativeInvocation?.invocation?.id : call.record?.id;
  const key = kind === "graph" ? call.invocationKey : call.record?.id;
  if (presentingLayerId == null || actionId == null || sourceNodeId == null) return null;
  const current = currentNavigationEntry();
  const entry = String(appState.visibleLayer?.layer?.id) === String(presentingLayerId) ? current
    : navigationHistory.entries().toReversed().find(entry => String(entry.threadId) === String(thread.id)
      && String(entry.turnId) === String(source.id) && entry.navigationPath.at(-1)?.layerId === String(presentingLayerId))
    ?? (String(source.completionOutput?.rootLayer?.layer?.id) === String(presentingLayerId) ? navigationEntryFromView({
      threadId: thread.id, turnId: source.id, layerPath: layerPathForVisibleLayer([], source, source.completionOutput.rootLayer), selectedNodeId: sourceNodeId,
    }) : null);
  if (!entry) return null;
  const sourceEntry = { ...entry, selectedNodeId: sourceNodeId };
  delete sourceEntry.invocationOrigin;
  if (sourceEntry.temporalCurrent) sourceEntry.temporalCurrent = { ...sourceEntry.temporalCurrent, mode: "pinned" };
  const layer = String(appState.visibleLayer?.layer?.id) === String(presentingLayerId) ? appState.visibleLayer
    : String(source.completionOutput?.rootLayer?.layer?.id) === String(presentingLayerId) ? source.completionOutput.rootLayer
      : acceptedLayerCache.get({ threadId: thread.id, turnId: source.id, layerId: presentingLayerId });
  return invocationOriginForSource({ kind, sourceEntry, sourceNodeId, actionId, presentingLayerId, invocationKey: key, invocationId },
    layer, appState.actionInvocations, resultId, appState.importedInvocationHistory);
}

export async function navigateInvocationCurrent(historyEntry) {
  const thread = appState.threads.find(thread => String(thread.id) === String(viewState.currentThreadId));
  const source = appState.interactions.find(item => String(item.id) === String(viewState.currentInteractionId));
  const retained = (appState.actionInvocations ?? []).find(call => call.graphOnly === true && call.occupancyOnly !== true
    && String(call.sourceInteractionId) === String(source?.id) && call.invocationKey === historyEntry?.invocationKey
    && String(call.nativeInvocation?.invocation?.id) === String(historyEntry?.nativeInvocation?.invocation?.id));
  if (!thread || thread.imported || !retained) return false;
  const presentation = nativeInvocationCurrentPresentation(retained, { threadId: thread.id, sourceInteraction: source });
  if (!presentation) return false;
  const origin = retainedInvocationOrigin(thread, source, retained, presentation.interaction.id, "graph");
  return retainInvocationPresentation(thread, source, presentation.interaction, presentation.layers, origin, retained);
}

export async function navigateImportedInvocationHistory(historyEntry) {
  const thread = appState.threads.find(thread => String(thread.id) === String(viewState.currentThreadId));
  const retained = (appState.importedInvocationHistory ?? []).find(entry => entry.inert === true
    && String(entry.threadId) === String(thread?.id)
    && String(entry.presentationSource?.interactionId ?? entry.sourceInteractionId) === String(viewState.currentInteractionId)
    && entry.record?.id === historyEntry?.record?.id);
  if (!thread?.imported || !retained || (retained.presentationSource == null && (retained.sourceInteractionId == null || retained.sourceNodeId == null))) return false;
  const source = appState.interactions.find(interaction => String(interaction.id) === String(retained.presentationSource?.interactionId ?? retained.sourceInteractionId));
  if (!source) return false;
  const result = appState.interactions.find(interaction => String(interaction.threadId) === String(thread.id)
    && String(interaction.id) === String(retained.resultInteractionId) && interaction.completionStatus === "accepted");
  if (retained.record.lifecycle === "succeeded" && result) {
    const layers = new Map([[String(result.completionOutput?.rootLayer?.layer?.id), result.completionOutput?.rootLayer]]);
    const origin = retainedInvocationOrigin(thread, source, retained, result.id, "imported");
    return retainInvocationPresentation(thread, source, result, layers, origin, null, retained);
  }
  if (retained.record.lifecycle === "succeeded" && retained.resultInteractionId != null) return false;
  const current = inertInvocationCurrent(retained.record, { threadId: thread.id,
    id: `current:${retained.record.id}`, sourceInteractionId: source.id, allowReturned: true });
  if (!current) return false;
  const origin = retainedInvocationOrigin(thread, source, retained, current.interaction.id, "imported");
  return retainInvocationPresentation(thread, source, current.interaction, current.layers, origin, null, retained);
}

export async function navigateLayer(layerId, navigation = {}) {
  if (navigation.invocationOrigin) {
    const origin = viewState.invocationOrigin;
    if (!origin) return false;
    return selectInteractionGraphSource(origin.sourceEntry.threadId, origin.sourceEntry.turnId, { invocationOrigin: origin });
  }
  cancelAutomaticTurn();
  if (!viewState.currentThreadId || !viewState.currentInteractionId) return;
  const local = inertInvocationPresentations.get(inertPresentationKey(viewState.currentThreadId, viewState.currentInteractionId));
  const current = appState.interactions.find(interaction => String(interaction.id) === String(viewState.currentInteractionId));
  if (current?.inertInvocationCurrent) {
    const layer = local?.layers.get(String(layerId));
    if (!layer) return false;
    recordCurrentNavigation();
    const layerPath = navigation.restore ? viewState.layerPath.slice(0, Number(navigation.pathIndex) + 1)
      : appendLayerPath(viewState.layerPath, navigation.action, navigation.sourceNode, layerId);
    hydrateWorkspace(current, layer, { selectedNodeId: null, layerPath });
    recordCurrentNavigation("push");
    navigation.beforeCommit?.();
    renderThread();
    return true;
  }
  recordCurrentNavigation();
  supersedePendingHistory({ presentationChanged: true });
  const pendingNavigation = layerNavigationCoordinator.begin({
    threadId: viewState.currentThreadId,
    interactionId: viewState.currentInteractionId,
    layerId: appState.visibleLayer?.layer?.id,
    layerPath: viewState.layerPath,
  });
  const interaction = appState.interactions.find((item) => (
    String(item.id) === String(pendingNavigation.interactionId)
  ));
  const rootLayer = interaction?.completionOutput?.rootLayer ?? null;
  const identity = {
    threadId: pendingNavigation.threadId,
    turnId: pendingNavigation.interactionId,
    layerId,
  };
  let ownedNavigation = false;
  try {
    // User navigation must observe canonical membership, including legacy
    // occurrences that omitted the invoke before its atomic conversion.
    if (String(rootLayer?.layer?.id) !== String(layerId)) acceptedLayerCache.delete(identity);
    const layer = String(rootLayer?.layer?.id) === String(layerId)
      ? rootLayer
      : await acceptedLayerCache.getOrLoad(identity, async () => validateResolvedLayer(
        identity,
        await request(`/api/threads/${encodeURIComponent(pendingNavigation.threadId)}/interactions/${encodeURIComponent(pendingNavigation.interactionId)}/layers/${encodeURIComponent(layerId)}`),
      ));
    ownedNavigation = layerNavigationCoordinator.isCurrent(pendingNavigation, {
      threadId: viewState.currentThreadId,
      interactionId: viewState.currentInteractionId,
      layerId: appState.visibleLayer?.layer?.id,
    });
    if (!ownedNavigation) return;
    // An artifact layer opens full screen in the artifact viewer, not the graph (PRD 6.6).
    const artifactNode = artifactLayerNode(layer);
    if (artifactNode !== null) {
      const interaction = appState.interactions.find((candidate) => String(candidate.id) === String(pendingNavigation.interactionId));
      artifactViewer().open({
        threadId: pendingNavigation.threadId,
        node: artifactNode,
        target: interaction?.graphNodeId == null ? null : { nodeId: artifactNode.id, sourceInteractionNodeId: interaction.graphNodeId, sourceLayerId: layer.layer.id },
      });
      return;
    }
    const layerPath = navigation.restore
      ? pendingNavigation.layerPath.slice(0, navigation.pathIndex + 1)
      : appendLayerPath(pendingNavigation.layerPath, navigation.action, navigation.sourceNode, layerId);
    viewState.selectedNodeId = null;
    const projection = appState.currentProjections.get(String(interaction?.graphNodeId));
    hydrateWorkspace(interaction, layer, {
      layerPath,
      temporalCurrent: projection == null ? null : {
        completionId: projection.completionId,
        revision: projection.headRevision,
        mode: "pinned",
      },
    });
    recordCurrentNavigation("push");
    renderThread();
    return true;
  } finally {
    const stillOwnsSource = layerNavigationCoordinator.isCurrent(pendingNavigation, {
      threadId: viewState.currentThreadId,
      interactionId: viewState.currentInteractionId,
      layerId: appState.visibleLayer?.layer?.id,
    });
    if ((ownedNavigation || stillOwnsSource) && pendingHistoryTransition === null) {
      schedulePendingRefresh(viewState.currentThreadId);
    }
  }
}

export async function navigateResolvedInvoke(action, { beforeCommit } = {}) {
  cancelAutomaticTurn();
  const sourceThreadId = viewState.currentThreadId;
  const sourceInteractionId = viewState.currentInteractionId;
  if (
    !sourceThreadId
    || !sourceInteractionId
    || (action?.kind !== "invoke" && !isResolvedInvokeAction(action))
    || action.targetLayerId == null
    || action.id == null
  ) return false;
  recordCurrentNavigation();
  const sourceEntry = currentNavigationEntry();
  const sourceLocationKey = navigationEntryKey(sourceEntry);
  supersedePendingHistory({ presentationChanged: true });
  const requestToken = resolvedInvokeNavigationGate.begin();
  pendingResolvedInvokeNavigation = true;
  try {
    const destination = await request(
      `/api/threads/${encodeURIComponent(sourceThreadId)}/interactions/${encodeURIComponent(sourceInteractionId)}/actions/${encodeURIComponent(action.id)}/destination`,
    );
    if (
      !resolvedInvokeNavigationGate.isCurrent(requestToken)
      || !currentNavigationEntry()
      || navigationEntryKey(currentNavigationEntry()) !== sourceLocationKey
    ) return false;
    if (
      String(destination.actionId) !== String(action.id)
      || destination.actionKind !== action.kind
      || String(destination.targetLayerId) !== String(action.targetLayerId)
      || String(destination.rootLayerId) !== String(action.targetLayerId)
    ) throw new Error("Resolved invoke destination did not match the selected graph action.");
    let resolved = await resolveNavigationPresentation({
      threadId: destination.threadId,
      turnId: destination.interactionId,
      navigationPath: [{ layerId: destination.rootLayerId, viaActionId: null }],
      selectedNodeId: null,
    }, {
      loadThread: (threadId) => request(`/api/threads/${encodeURIComponent(threadId)}`),
      loadLayer: ({ threadId, turnId, layerId }) => request(
        `/api/threads/${encodeURIComponent(threadId)}/interactions/${encodeURIComponent(turnId)}/layers/${encodeURIComponent(layerId)}`,
      ),
      layerCache: acceptedLayerCache,
    });
    if (
      !resolvedInvokeNavigationGate.isCurrent(requestToken)
      || !currentNavigationEntry()
      || navigationEntryKey(currentNavigationEntry()) !== sourceLocationKey
    ) return false;
    if (String(resolved.thread.id) !== String(viewState.currentThreadId)) {
      resolved = { ...resolved, thread: await restoreArchivedForNavigation(resolved.thread) };
      if (!resolvedInvokeNavigationGate.isCurrent(requestToken)
        || navigationEntryKey(currentNavigationEntry()) !== sourceLocationKey) return false;
    }
    refreshGate.invalidate();
    layerNavigationCoordinator.cancel();
    applyResolvedPresentation(resolved);
    beforeCommit?.();
    recordCurrentNavigation("push");
    expandThreadProject(appState.threads.find((thread) => String(thread.id) === String(resolved.thread.id)));
    renderSidebar();
    schedulePendingRefresh(viewState.currentThreadId);
    return true;
  } finally {
    if (resolvedInvokeNavigationGate.isCurrent(requestToken)) {
      pendingResolvedInvokeNavigation = false;
      renderThread();
    }
  }
}

export function getNavigationHistory() {
  const back = navigationHistory.destination(-1);
  const forward = navigationHistory.destination(1);
  const current = navigationHistory.current;
  return Object.freeze({
    canGoBack: Boolean(back),
    canGoForward: Boolean(forward),
    pendingDirection: pendingHistoryTransition?.direction ?? null,
    pendingResolvedInvokeNavigation,
    backChangesTurn: navigationEntriesChangeTurn(current, back?.entry),
    forwardChangesTurn: navigationEntriesChangeTurn(current, forward?.entry),
    backLabel: navigationDestinationLabel("back", back?.metadata),
    forwardLabel: navigationDestinationLabel("forward", forward?.metadata),
  });
}

export function replaceCurrentSelection(selectedNodeId, { automatic = false } = {}) {
  if (!automatic) cancelAutomaticTurn();
  viewState.nodeDetailsClosed = selectedNodeId == null;
  viewState.selectedNodeId = selectedNodeId ?? null;
  if (appState.visibleLayer?.nodes?.some((node) => String(node.id) === String(selectedNodeId))) {
    rememberLayerSelection(viewState.currentThreadId, viewState.currentInteractionId, appState.visibleLayer?.layer?.id, selectedNodeId);
  }
  // Selecting a node is a newer presentation intent than an invoke destination
  // already being resolved. Selection is intentionally not part of the
  // navigation location key, so explicitly invalidate that async request while
  // leaving background refresh and layer navigation untouched.
  resolvedInvokeNavigationGate.invalidate();
  pendingResolvedInvokeNavigation = false;
  supersedePendingHistory();
  if (!navigationHistory.current) {
    recordCurrentNavigation();
    return;
  }
  navigationHistory.replaceSelection(selectedNodeId);
  rememberNavigationMetadata(navigationHistory.current);
  protectCurrentLayers();
}

function navigationSupersededError() {
  const error = new Error("History navigation was superseded by a newer navigation.");
  error.code = "navigation_superseded";
  return error;
}

function captureWorkspaceState() {
  return {
    app: {
      threads: appState.threads,
      interactions: appState.interactions,
      actionInvocations: appState.actionInvocations,
      invocationInventoryAvailable: appState.invocationInventoryAvailable,
      importedInvocationHistory: appState.importedInvocationHistory,
      approvals: appState.approvals,
      nodes: appState.nodes,
      edges: appState.edges,
      actions: appState.actions,
      visibleLayer: appState.visibleLayer,
      currentInteractionId: appState.currentInteractionId,
      status: appState.status,
    },
    view: {
      currentThreadId: viewState.currentThreadId,
      currentInteractionId: viewState.currentInteractionId,
      selectedNodeId: viewState.selectedNodeId,
      nodeDetailsClosed: viewState.nodeDetailsClosed,
      layerPath: viewState.layerPath,
      temporalCurrent: viewState.temporalCurrent,
      invocationOrigin: viewState.invocationOrigin,
      mainView: viewState.mainView,
    },
    url: location.href,
  };
}

function restoreWorkspaceState(snapshot) {
  Object.assign(appState, snapshot.app);
  Object.assign(viewState, snapshot.view);
  history.replaceState(null, "", snapshot.url);
  setMainView(snapshot.view.mainView);
  renderSidebar();
  renderScopeMenu();
  if (snapshot.view.mainView === "thread") renderThread();
}

function applyResolvedPresentation(resolved, { restoreSelection = false } = {}) {
  const existingThread = appState.threads.find((thread) => (
    String(thread.id) === String(resolved.thread.id)
  ));
  const resolvedThread = { ...existingThread, ...resolved.thread };
  appState.threads = existingThread
    ? appState.threads.map((thread) => (
      String(thread.id) === String(resolvedThread.id) ? resolvedThread : thread
    ))
    : [...appState.threads, resolvedThread];
  appState.threads.sort(threadActivityOrder);
  appState.interactions = [
    ...appState.interactions.filter((interaction) => (
      String(interaction.threadId) !== String(resolved.thread.id)
    )),
    ...resolved.interactions,
  ];
  const resolvedInteractionIds = new Set(
    resolved.interactions.map((interaction) => String(interaction.id)),
  );
  const actionInvocationsByIdentity = new Map();
  const invocationIdentity = (invocation) => [
    invocation.sourceInteractionId,
    invocation.actionId,
    invocation.graphOnly ? `native:${invocation.invocationKey || "occupancy"}` : `product:${invocation.resultInteractionId}`,
  ].map(String).join(":");
  for (const invocation of [
    ...appState.actionInvocations.filter((invocation) => (
      !resolvedInteractionIds.has(String(invocation.sourceInteractionId))
    )),
    ...resolved.actionInvocations,
  ]) {
    actionInvocationsByIdentity.set(invocationIdentity(invocation), invocation);
  }
  appState.actionInvocations = [...actionInvocationsByIdentity.values()];
  appState.invocationInventoryAvailable = resolved.invocationInventoryAvailable === true;
  appState.importedInvocationHistory = resolved.importedInvocationHistory ?? appState.importedInvocationHistory;
  appState.approvals = [
    ...appState.approvals.filter((receipt) => (
      String(receipt.request?.correlation?.threadId) !== String(resolved.thread.id)
    )),
    ...(Array.isArray(resolved.approvals) ? resolved.approvals : []),
  ];
  viewState.currentThreadId = resolved.thread.id;
  viewState.selectedNodeId = resolved.selectedNodeId;
  hydrateWorkspace(resolved.interaction, resolved.layer, {
    layerPath: resolved.layerPath,
    selectedNodeId: resolved.selectedNodeId,
    restoreSelection,
    temporalCurrent: resolved.entry.temporalCurrent,
    invocationOrigin: resolved.invocationOrigin ?? null,
  });
  setMainView("thread");
  renderSidebar();
  renderScopeMenu();
  renderThread();
}

export async function navigateHistory(deltaOrDirection, { beforeCommit } = {}) {
  cancelAutomaticTurn();
  const delta = deltaOrDirection === "back" ? -1
    : deltaOrDirection === "forward" ? 1
      : Number(deltaOrDirection);
  if (!Number.isInteger(delta) || delta === 0) {
    throw new Error("History navigation requires a non-zero integer delta.");
  }
  // History is a newer user navigation intent than any resolved-invoke lookup
  // already in flight. Invalidate it before capturing or restoring history.
  resolvedInvokeNavigationGate.invalidate();
  pendingResolvedInvokeNavigation = false;
  recordCurrentNavigation();
  const transition = navigationHistory.go(delta);
  if (!transition) throw new Error(`History delta ${delta} is outside the workspace history.`);
  cancelPendingRefresh();
  layerNavigationCoordinator.cancel();
  pendingHistoryTransition = transition;
  let sourceSnapshot;
  let applied = false;
  let committed = false;
  try {
    renderThread();
    // Keep ancestor caching, but revalidate the selected descendant on entry.
    const destination = descendantLayerIdentities(transition.entry).at(-1);
    if (destination) acceptedLayerCache.delete(destination);
    const local = inertInvocationPresentations.get(inertPresentationKey(transition.entry.threadId, transition.entry.turnId));
    let resolved = await resolveNavigationPresentation(transition.entry, {
      loadThread: (threadId) => local ? Promise.resolve(local.detail) : request(`/api/threads/${encodeURIComponent(threadId)}`),
      loadLayer: ({ threadId, turnId, layerId }) => {
        const presentation = local ? inertInvocationPresentations.get(inertPresentationKey(threadId, turnId)) : null;
        if (local && presentation?.layers.has(String(layerId))) return Promise.resolve(presentation.layers.get(String(layerId)));
        const target = local?.detail.interactions.find(item => String(item.id) === String(turnId));
        if (local && (!target || target.inertInvocationCurrent || target.inertInvocationSource)) return Promise.reject(new Error("Inert Current layer is unavailable."));
        return request(
          `/api/threads/${encodeURIComponent(threadId)}/interactions/${encodeURIComponent(turnId)}/layers/${encodeURIComponent(layerId)}`,
        );
      },
      layerCache: local ? null : acceptedLayerCache,
    });
    if (local) resolved = { ...resolved, importedInvocationHistory: local.detail.importedInvocationHistory };
    if (!navigationHistory.isCurrentTransition(transition)) throw navigationSupersededError();
    if (String(resolved.thread.id) !== String(viewState.currentThreadId)) {
      resolved = { ...resolved, thread: await restoreArchivedForNavigation(resolved.thread) };
      if (!navigationHistory.isCurrentTransition(transition)) throw navigationSupersededError();
    }
    sourceSnapshot = captureWorkspaceState();
    refreshGate.invalidate();
    applied = true;
    applyResolvedPresentation(resolved, { restoreSelection: true });
    beforeCommit?.();
    if (!navigationHistory.commit(transition)) throw navigationSupersededError();
    committed = true;
    expandThreadProject(appState.threads.find((thread) => String(thread.id) === String(resolved.thread.id)));
    renderSidebar();
    const restoredEntry = resolved.entry.temporalCurrent == null ? resolved.entry : {
      ...resolved.entry,
      temporalCurrent: { ...resolved.entry.temporalCurrent, mode: "pinned" },
    };
    viewState.temporalCurrent = restoredEntry.temporalCurrent;
    navigationHistory.replaceCurrent(restoredEntry);
    rememberNavigationMetadata(navigationHistory.current, resolved);
    pruneNavigationMetadata();
    protectCurrentLayers(navigationHistory.current);
    schedulePendingRefresh(viewState.currentThreadId);
    return navigationHistory.current;
  } catch (error) {
    if (applied && !committed && sourceSnapshot) restoreWorkspaceState(sourceSnapshot);
    throw error;
  } finally {
    if (pendingHistoryTransition === transition) {
      pendingHistoryTransition = null;
      renderThread();
    }
    if (pendingHistoryTransition === null) schedulePendingRefresh(viewState.currentThreadId);
  }
}

export async function invokeAction(action, { inputDraftRevision } = {}) {
  const intent = readingIntent;
  const threadId = viewState.currentThreadId;
  const sourceInteractionId = viewState.currentInteractionId;
  if (!threadId || !sourceInteractionId || action?.kind !== "invoke" || !action.id
    || appState.threads.some(thread => String(thread.id) === String(threadId) && thread.imported === true)
    || appState.interactions.some(interaction => String(interaction.id) === String(sourceInteractionId) && interaction.inertInvocationCurrent)) return null;
  if (appState.invocationInventoryAvailable !== true) { toast("Invoke availability is unavailable. Your inputs were preserved."); return null; }
  const recoveringCall = recoverableActionInvocation(appState.actionInvocations, sourceInteractionId, action.id);
  const invocationKey = recoveringCall?.invocationKey ?? crypto.randomUUID();
  const invocationInput = !recoveringCall && Number.isSafeInteger(inputDraftRevision)
    ? { inputDraftRevision }
    : {};
  const invocationBody = { ...invocationInput, ...(recoveringCall?.presentingLayerId != null
    ? { presentingLayerId: recoveringCall.presentingLayerId }
    : !recoveringCall && appState.visibleLayer?.layer?.id != null ? { presentingLayerId: appState.visibleLayer.layer.id } : {}) };
  if (actionWasInvoked(
    appState.actionInvocations,
    appState.pendingActionInvocations,
    sourceInteractionId,
    action.id,
    action.reusable,
  )) return null;
  appState.pendingActionInvocations.push({
    sourceInteractionId,
    actionId: action.id,
  });
  recordCurrentNavigation();
  layerNavigationCoordinator.cancel();
  const sourceLocationKey = navigationEntryKey(navigationHistory.current);
  // Capture the clicked occurrence before asynchronous execution or browsing.
  let sourceEntry = { ...navigationHistory.current, selectedNodeId: action.sourceNodeId };
  delete sourceEntry.invocationOrigin;
  if (sourceEntry.temporalCurrent) sourceEntry.temporalCurrent = { ...sourceEntry.temporalCurrent, mode: "pinned" };
  let invocationSource = {
    origin: { sourceEntry, actionId: action.id, invocationKey, sourceNodeId: action.sourceNodeId,
      presentingLayerId: invocationBody.presentingLayerId },
    layer: appState.visibleLayer,
  };
  if (recoveringCall && String(invocationSource.layer?.layer?.id) !== String(recoveringCall.presentingLayerId)) {
    const historical = navigationHistory.entries().toReversed().find(entry =>
      String(entry.threadId) === String(threadId) && String(entry.turnId) === String(sourceInteractionId)
      && entry.navigationPath.some(step => String(step.layerId) === String(recoveringCall.presentingLayerId)));
    const sourceInteraction = appState.interactions.find(item => String(item.id) === String(sourceInteractionId));
    const root = sourceInteraction?.completionOutput?.rootLayer;
    sourceEntry = historical ? {
      ...historical,
      navigationPath: historical.navigationPath.slice(0, historical.navigationPath.findIndex(step =>
        String(step.layerId) === String(recoveringCall.presentingLayerId)) + 1),
      selectedNodeId: action.sourceNodeId,
    } : String(root?.layer?.id) === String(recoveringCall.presentingLayerId) ? navigationEntryFromView({
      threadId, turnId: sourceInteractionId,
      layerPath: layerPathForVisibleLayer([], sourceInteraction, root), selectedNodeId: action.sourceNodeId,
    }) : null;
    if (sourceEntry) {
      sourceEntry = { ...sourceEntry }; delete sourceEntry.invocationOrigin;
      if (sourceEntry.temporalCurrent) sourceEntry.temporalCurrent = { ...sourceEntry.temporalCurrent, mode: "pinned" };
    }
    // A reservation retains its original presenting Layer. Unknown session paths
    // cannot be substituted with the currently visible occurrence.
    invocationSource = sourceEntry ? { ...invocationSource, origin: { ...invocationSource.origin, sourceEntry }, layer: null } : null;
  }
  let response;
  try {
    if (invocationSource && invocationSource.layer == null) {
      const resolved = await resolveNavigationPresentation(invocationSource.origin.sourceEntry, {
        loadThread: id => request(`/api/threads/${encodeURIComponent(id)}`),
        loadLayer: ({ threadId, turnId, layerId }) => request(
          `/api/threads/${encodeURIComponent(threadId)}/interactions/${encodeURIComponent(turnId)}/layers/${encodeURIComponent(layerId)}`,
        ),
      }).catch(() => null);
      invocationSource = resolved ? { ...invocationSource, layer: resolved.layer } : null;
    }
    if (recoveringCall && !invocationSource) {
      appState.pendingActionInvocations = withoutPendingActionInvocation(appState.pendingActionInvocations, sourceInteractionId, action.id);
      renderThread();
      toast("The original invoking Node is unavailable. Keep reading here and retry when its source can be opened.");
      return null;
    }
    response = await request(
      `/api/threads/${encodeURIComponent(threadId)}/interactions/${encodeURIComponent(sourceInteractionId)}/actions/${encodeURIComponent(action.id)}/invoke`,
      {
        method: "POST",
        headers: { "Idempotency-Key": invocationKey },
        body: JSON.stringify(invocationBody),
      },
    );
  } catch (error) {
    if (String(viewState.currentThreadId) !== String(threadId)) {
      appState.pendingActionInvocations = withoutPendingActionInvocation(
        appState.pendingActionInvocations,
        sourceInteractionId,
        action.id,
      );
      return null;
    }
    await refreshAfterModelSelectionRejection(error, true);
    await refreshState(threadId).catch(() => {});
    const durable = recoverActionInvocation(appState.actionInvocations, sourceInteractionId, action.id, invocationKey);
    appState.pendingActionInvocations = withoutPendingActionInvocation(
      appState.pendingActionInvocations,
      sourceInteractionId,
      action.id,
    );
    if (
      durable?.resultInteractionId
      && !isRejectedActionPreparation(durable)
      && !invokeResultIsRetryable(durable.resultCompletionStatus)
    ) {
      onboardingTutorialController()?.actionSucceeded({
        threadId,
        interactionId: sourceInteractionId,
        actionId: action.id,
        resultInteractionId: durable.resultInteractionId,
      });
      supersedePendingHistory({ presentationChanged: true });
      trackPendingTurn(threadId, durable.resultInteractionId, intent, invocationSource);
      await refreshState(threadId, { historyMode: "push" }).catch(() => {});
      return { interaction: { id: durable.resultInteractionId }, recovered: true };
    } else {
      renderThread();
      toast(error.message);
    }
    return null;
  }
  if (response.invocation) {
    appState.actionInvocations = mergeActionInvocation(appState.actionInvocations, response.invocation);
    appState.pendingActionInvocations = withoutPendingActionInvocation(
      appState.pendingActionInvocations,
      sourceInteractionId,
      action.id,
    );
  }
  const sourceIsStillSelected = (
    currentNavigationEntry()
    && navigationEntryKey(currentNavigationEntry()) === sourceLocationKey
  );
  const resumedOrCreated = response.created || Boolean(recoveringCall
    && response.invocation?.invocationKey === invocationKey
    && String(response.invocation.resultInteractionId) === String(response.interaction?.id)
    && !isRejectedActionPreparation(response.invocation));
  const createdResultCanAdvance = resumedOrCreated
    && response.interaction?.id
    && !invokeResultIsRetryable(response.interaction.completionStatus)
    && sourceIsStillSelected;
  if (createdResultCanAdvance) {
    onboardingTutorialController()?.actionSucceeded({
      threadId,
      interactionId: sourceInteractionId,
      actionId: action.id,
      resultInteractionId: response.interaction.id,
    });
    supersedePendingHistory({ presentationChanged: true });
  }
  if (resumedOrCreated && response.interaction?.id && !invokeResultIsRetryable(response.interaction.completionStatus)) {
    trackPendingTurn(threadId, response.interaction.id, intent, invocationSource);
  }
  if (String(viewState.currentThreadId) === String(threadId)) {
    void refreshState(threadId, {
      historyMode: createdResultCanAdvance ? "push" : "replace",
    }).catch(() => {
      // The activation is already acknowledged. A failed optional read must
      // not report a failed Invoke or offer a second activation of this key.
      schedulePendingRefresh(threadId, { force: true });
    });
  }
  return response;
}

async function createOrReuseProject(selectedScope) {
  const input = { path: selectedScope.path, name: selectedScope.label, separateSubfolder: selectedScope.separateSubfolder === true };
  try {
    return await request("/api/projects", {
      method: "POST",
      body: JSON.stringify(input),
    });
  } catch (error) {
    if (error.code !== "project_exists" || !error.details?.existingProject) throw error;
    const existing = error.details.existingProject;
    const confirmed = window.confirm(`“${existing.name}” already uses this folder. Use the existing project?`);
    if (!confirmed) throw new Error("Project selection was cancelled. Your draft is unchanged.");
    return request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ ...input, reuseExisting: true }),
    });
  }
}

export async function createFirstThread(pickerPayloadOverride = null) {
  onboardingTutorialController()?.cancelPendingAutomatic();
  const input = $("#newThreadPrompt");
  const promptText = input.value.trim();
  const permissionProfileId = viewState.selectedPermissionProfileId;
  const pickerPayload = productApiAvailable
    ? pickerPayloadOverride ?? newThreadModelSelectionPayload()
    : null;
  if (productApiAvailable && !pickerPayload) {
    setSettingsTab("models");
    setMainView("settings");
    toast("Choose an available model in Settings before sending.");
    return;
  }
  if (!promptText || !permissionProfileId || creatingFirstThread || !checkoutController.ready) return;
  const submission = projectComposerGate.begin();
  const submissionIsCurrent = () => projectComposerGate.isCurrent(submission);
  creatingFirstThread = true;
  setCheckoutSubmitting(true);
  input.disabled = true;
  $("#createThread").disabled = true;
  $("#permissionButton").disabled = true;
  setNewThreadModelPickerDisabled(true);
  closePermissionMenu();
  closeNewThreadModelPicker();
  try {
    const selectedScope = viewState.selectedScope;
    if (!productApiAvailable) {
      const thread = addLocalThread(appState, {
        selectedScope,
        prompt: promptText,
        title: threadTitle(promptText),
        createId: () => crypto.randomUUID(),
      });
      viewState.currentThreadId = thread.id;
      clearSuccessfulNewThreadInput(input);
      renderSidebar();
      renderThread();
      return;
    }
    selectedScope.creationRequestId ??= crypto.randomUUID();
    await persistPendingNewThreadDraftDurably(promptText, selectedScope);
    const execution = checkoutController.state ? await checkoutController.prepareSend() : null;
    if (!submissionIsCurrent()) return;
    let projectId = selectedScope.projectId;
    if (selectedScope.kind === "folder") {
      const project = await createOrReuseProject(selectedScope);
      if (!submissionIsCurrent()) return;
      projectId = project.id;
    }
    const threadRequest = stableNewThreadRequest(selectedScope, {
      title: threadTitle(promptText), initialMessage: promptText, permissionProfileId,
      projectId, pickerPayload, workingDirectory: execution?.workingDirectory || selectedScope.path,
      expectedCheckout: execution?.commonDirectory ? { repositoryIdentity: execution.commonDirectory, checkoutRoot: execution.checkoutRoot, branch: execution.branch === "detached" ? null : execution.branch, commit: execution.commit } : undefined,
    });
    await persistPendingNewThreadDraftDurably(promptText, selectedScope);
    const thread = await request("/api/threads", {
      method: "POST", body: JSON.stringify(threadRequest),
    });
    if (!submissionIsCurrent()) return;
    viewState.currentThreadId = thread.id;
    onboardingTutorialController()?.threadCreated({
      threadId: thread.id,
      interactionId: thread.rootInteractionId,
    });
    clearSuccessfulNewThreadInput(input);
    await loadThread(thread.id);
  } catch (error) {
    if (!submissionIsCurrent()) return;
    checkoutController.reportSendError(error);
    await refreshAfterModelSelectionRejection(error);
    toast(error.message);
  } finally {
    creatingFirstThread = false;
    setCheckoutSubmitting(false);
    input.disabled = false;
    $("#permissionButton").disabled = !viewState.selectedPermissionProfileId;
    setNewThreadModelPickerDisabled(false);
    updateCreateThreadAvailability();
  }
}

function clearSuccessfulNewThreadInput(input) {
  input.value = "";
  clearPendingNewThreadDraft();
  checkoutController.clear();
}

export function connectEvents() {
  // Live harness events are intentionally outside this product-persistence slice.
}

export async function stopInteraction(threadId, interactionId) {
  const interaction = await request(`/api/threads/${threadId}/interactions/${interactionId}/stop`, { method: "POST" });
  cancelPendingRefresh();
  const existing = appState.interactions?.find((turn) => turn.id === interactionId && turn.threadId === threadId);
  if (existing) Object.assign(existing, interaction);
  renderThread();
  schedulePendingRefresh(viewState.currentThreadId);
}
