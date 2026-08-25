import { request } from "./api.js";
import {
  actionWasInvoked,
  visibleLayerAfterRefresh,
  withoutPendingActionInvocation,
} from "./action-invocation-state.js";
import {
  createAcceptedLayerCache,
  createLatestRequestGate,
  createNavigationHistory,
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
  workspaceTurns,
} from "./product-workspace/model.js";
import {
  descendantLayerIdentities,
  navigationDestinationLabel,
  navigationDestinationMetadata,
  navigationEntryFromView,
  navigationEntryKey,
  resolveNavigationPresentation,
  validateResolvedLayer,
  workspaceUrlForPresentation,
} from "./workspace-navigation.js";
import { appState, productApiAvailable, viewState } from "./state.js";
import { $, threadTitle, toast } from "./ui.js";
import { addLocalThread } from "./thread-model.js";
import { closePermissionMenu } from "./permission-profiles.js";
import { newThreadRequestBody } from "./interaction-request-model.js";
import {
  closeNewThreadModelPicker,
  newThreadModelSelectionPayload,
  newThreadModelSelectionReady,
  setNewThreadModelPickerDisabled,
} from "./composer-model-picker.js";
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
import { onboardingTutorialController } from "./onboarding-tutorial.js";

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

export function updateCreateThreadAvailability() {
  $("#createThread").disabled = creatingFirstThread
    || !$("#newThreadPrompt").value.trim()
    || !viewState.selectedPermissionProfileId
    || (productApiAvailable && !newThreadModelSelectionReady());
}

function currentNavigationEntry() {
  return navigationEntryFromView({
    threadId: viewState.currentThreadId,
    turnId: viewState.currentInteractionId,
    layerPath: viewState.layerPath,
    selectedNodeId: viewState.selectedNodeId,
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
  supersedePendingHistory({ presentationChanged: true, renderAfterCancel: false });
}

function schedulePendingRefresh(threadId, { force = false } = {}) {
  clearTimeout(pendingRefreshTimer);
  pendingRefreshTimer = undefined;
  const thread = appState.threads.find((candidate) => String(candidate.id) === String(threadId));
  if (!threadId || !thread || thread.imported === true) return;
  const hasPendingInteraction = appState.interactions.some((interaction) => (
    String(interaction.threadId) === String(threadId)
    && (
      interaction.projectionFresh === false
      || (["not_started", "running", "submitted", "waiting_for_approval"].includes(interaction.completionStatus)
        && !restoredDraftForInteraction(interaction))
    )
  ))
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
  const requestedThreadId = threadId;
  const state = await request(`/api/state${threadId ? `?threadId=${encodeURIComponent(threadId)}` : ""}`);
  if (
    !refreshGate.isCurrent(refreshToken)
    || (requestedThreadId && String(viewState.currentThreadId) !== String(requestedThreadId))
  ) return false;
  const previousInteractionId = viewState.currentInteractionId;
  const previousVisibleLayer = appState.visibleLayer;
  const nextProjects = state.projects || [];
  const nextThreads = state.threads || [];
  const nextInteractions = state.interactions || [];
  const nextActionInvocations = state.actionInvocations || [];
  const nextApprovals = Array.isArray(state.approvals) ? state.approvals : [];
  const active = nextThreads.find((thread) => thread.active);
  const nextThreadId = threadId ?? active?.id ?? viewState.currentThreadId;
  invalidateResolvedInvokeLayerCache(nextActionInvocations);
  const threadInteractions = nextInteractions.filter((interaction) => (
    String(interaction.threadId) === String(nextThreadId)
  ));
  const selected = threadInteractions.find((interaction) => (
    String(interaction.id) === String(viewState.currentInteractionId)
  )) || threadInteractions.at(-1);
  let refreshedVisibleLayer = visibleLayerAfterRefresh(
    previousInteractionId,
    previousVisibleLayer,
    selected,
  );
  const visibleLayerId = refreshedVisibleLayer?.layer?.id;
  let canonicalRefreshFailed = false;
  if (
    selected
    && visibleLayerId != null
    && layerContainsRefreshableInvokedAction(refreshedVisibleLayer, nextActionInvocations)
  ) {
    const identity = {
      threadId: nextThreadId,
      turnId: selected.id,
      layerId: visibleLayerId,
    };
    try {
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
  appState.projects = nextProjects;
  appState.threads = nextThreads;
  appState.interactions = nextInteractions;
  appState.actionInvocations = nextActionInvocations;
  appState.approvals = nextApprovals;
  appState.capabilities = state.capabilities;
  viewState.currentThreadId = nextThreadId;
  hydrateWorkspace(selected, refreshedVisibleLayer);
  recordCurrentNavigation(historyMode);
  renderSidebar();
  renderScopeMenu();
  if (viewState.mainView === "settings") setMainView("settings");
  else if (viewState.currentThreadId) renderThread();
  else setMainView("new");
  schedulePendingRefresh(viewState.currentThreadId, { force: canonicalRefreshFailed });
  return true;
}

export async function loadThread(threadId) {
  recordCurrentNavigation();
  supersedePendingHistory({ presentationChanged: true });
  viewState.currentThreadId = threadId;
  viewState.currentInteractionId = null;
  viewState.selectedNodeId = null;
  setMainView("thread");
  const url = new URL(location.href);
  url.searchParams.set("threadId", threadId);
  history.replaceState(null, "", url);
  await refreshState(threadId, { historyMode: "push" });
}

export function hydrateWorkspace(
  interaction,
  layer = interaction?.completionOutput?.rootLayer ?? null,
  { layerPath, selectedNodeId } = {},
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
    viewState.selectedNodeId = selectedNodeId ?? null;
  } else if (selectedNodeId !== undefined) {
    viewState.selectedNodeId = selectedNodeId;
  }
  viewState.currentInteractionId = interaction?.id ?? null;
  viewState.layerPath = nextLayerPath;
  appState.currentInteractionId = interaction?.id ?? null;
  appState.status = interaction?.completionStatus || "idle";
  appState.visibleLayer = layer;
  appState.nodes = layer?.nodes ? [...layer.nodes] : [];
  appState.edges = layer?.edges ? [...layer.edges] : [];
  appState.actions = layer?.actions ? [...layer.actions] : [];
  const url = workspaceUrlForPresentation(location.href, {
    threadId: viewState.currentThreadId,
    turnId: interaction?.id,
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

export function selectTurnById(interactionId) {
  const target = appState.interactions.find((interaction) => (
    String(interaction.threadId) === String(viewState.currentThreadId)
    && String(interaction.id) === String(interactionId)
  ));
  if (!target || String(target.id) === String(viewState.currentInteractionId)) return;
  supersedePendingHistory({ presentationChanged: true });
  viewState.selectedNodeId = null;
  hydrateWorkspace(target);
  recordCurrentNavigation("push");
  renderThread();
  schedulePendingRefresh(viewState.currentThreadId);
}

export async function submitInteraction(text, modelSelection) {
  if (!viewState.currentThreadId) throw new Error("Select a thread before sending a follow-up.");
  const threadId = viewState.currentThreadId;
  recordCurrentNavigation();
  const sourceLocationKey = navigationEntryKey(navigationHistory.current);
  supersedePendingHistory({ cancelLayerNavigation: true });
  const thread = appState.threads.find((candidate) => String(candidate.id) === String(threadId));
  const harnessId = thread?.harnessId ?? thread?.harnessConfigurationName;
  if (!modelSelection && !harnessUsesConfigurationModel(appState.modelSettings, harnessId)) {
    setSettingsTab("models");
    setMainView("settings");
    throw new Error("Choose an available model in Settings before sending.");
  }
  let createdInteraction;
  try {
    const latestInteraction = appState.interactions
      .filter((interaction) => String(interaction.threadId) === String(threadId))
      .at(-1);
    const { path, body } = interactionSubmissionTarget(
      threadId,
      latestInteraction,
      text,
      modelSelection,
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
  try {
    await onboardingTutorialController()?.followupSubmitted({
      threadId,
      interactionId: createdInteraction?.id,
    });
  } catch (error) {
    console.error("Tutorial completion failed:", error);
  }
  const current = currentNavigationEntry();
  if (!current || navigationEntryKey(current) !== sourceLocationKey) return createdInteraction;
  supersedePendingHistory({ presentationChanged: true });
  viewState.currentInteractionId = null;
  await refreshState(threadId, { historyMode: "push" });
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
  appState.pendingApprovalDecisions.push(requestKey);
  renderThread();
  try {
    await request(
      `/api/threads/${encodeURIComponent(threadId)}/interactions/${encodeURIComponent(receipt.request.correlation.interactionId)}/approvals/${encodeURIComponent(requestId)}/decision`,
      {
        method: "POST",
        body: JSON.stringify({ decision }),
      },
    );
    if (String(viewState.currentThreadId) === String(threadId)) {
      await refreshState(threadId);
    }
  } catch (error) {
    if (String(viewState.currentThreadId) === String(threadId)) {
      await refreshState(threadId).catch(() => {});
    }
    throw error;
  } finally {
    appState.pendingApprovalDecisions = appState.pendingApprovalDecisions.filter((id) => (
      String(id) !== requestKey
    ));
    if (String(viewState.currentThreadId) === String(threadId)) renderThread();
  }
}

export async function navigateLayer(layerId, navigation = {}) {
  if (!viewState.currentThreadId || !viewState.currentInteractionId) return;
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
    const layerPath = navigation.restore
      ? pendingNavigation.layerPath.slice(0, navigation.pathIndex + 1)
      : appendLayerPath(pendingNavigation.layerPath, navigation.action, navigation.sourceNode);
    viewState.selectedNodeId = null;
    hydrateWorkspace(interaction, layer, { layerPath });
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

export async function navigateResolvedInvoke(action) {
  const sourceThreadId = viewState.currentThreadId;
  const sourceInteractionId = viewState.currentInteractionId;
  if (
    !sourceThreadId
    || !sourceInteractionId
    || action?.kind !== "invoke"
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
      || destination.actionKind !== "invoke"
      || String(destination.targetLayerId) !== String(action.targetLayerId)
      || String(destination.rootLayerId) !== String(action.targetLayerId)
    ) throw new Error("Resolved invoke destination did not match the selected graph action.");
    const resolved = await resolveNavigationPresentation({
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
    refreshGate.invalidate();
    layerNavigationCoordinator.cancel();
    applyResolvedPresentation(resolved);
    recordCurrentNavigation("push");
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
  return Object.freeze({
    canGoBack: Boolean(back),
    canGoForward: Boolean(forward),
    pendingDirection: pendingHistoryTransition?.direction ?? null,
    pendingResolvedInvokeNavigation,
    backLabel: navigationDestinationLabel("back", back?.metadata),
    forwardLabel: navigationDestinationLabel("forward", forward?.metadata),
  });
}

export function replaceCurrentSelection(selectedNodeId) {
  viewState.selectedNodeId = selectedNodeId ?? null;
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
      layerPath: viewState.layerPath,
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

function applyResolvedPresentation(resolved) {
  const existingThread = appState.threads.find((thread) => (
    String(thread.id) === String(resolved.thread.id)
  ));
  const resolvedThread = { ...existingThread, ...resolved.thread };
  appState.threads = existingThread
    ? appState.threads.map((thread) => (
      String(thread.id) === String(resolvedThread.id) ? resolvedThread : thread
    ))
    : [...appState.threads, resolvedThread];
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
    invocation.resultInteractionId,
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
  });
  setMainView("thread");
  renderSidebar();
  renderScopeMenu();
  renderThread();
}

export async function navigateHistory(deltaOrDirection) {
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
    const resolved = await resolveNavigationPresentation(transition.entry, {
      loadThread: (threadId) => request(`/api/threads/${encodeURIComponent(threadId)}`),
      loadLayer: ({ threadId, turnId, layerId }) => request(
        `/api/threads/${encodeURIComponent(threadId)}/interactions/${encodeURIComponent(turnId)}/layers/${encodeURIComponent(layerId)}`,
      ),
      layerCache: acceptedLayerCache,
    });
    if (!navigationHistory.isCurrentTransition(transition)) throw navigationSupersededError();
    sourceSnapshot = captureWorkspaceState();
    refreshGate.invalidate();
    applied = true;
    applyResolvedPresentation(resolved);
    if (!navigationHistory.commit(transition)) throw navigationSupersededError();
    committed = true;
    navigationHistory.replaceCurrent(resolved.entry);
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

export async function invokeAction(action) {
  const threadId = viewState.currentThreadId;
  const sourceInteractionId = viewState.currentInteractionId;
  if (!threadId || !sourceInteractionId || action?.kind !== "invoke" || !action.id) return null;
  if (actionWasInvoked(
    appState.actionInvocations,
    appState.pendingActionInvocations,
    sourceInteractionId,
    action.id,
  )) return null;
  appState.pendingActionInvocations.push({
    sourceInteractionId,
    actionId: action.id,
  });
  recordCurrentNavigation();
  layerNavigationCoordinator.cancel();
  const sourceLocationKey = navigationEntryKey(navigationHistory.current);
  let response;
  try {
    response = await request(
      `/api/threads/${encodeURIComponent(threadId)}/interactions/${encodeURIComponent(sourceInteractionId)}/actions/${encodeURIComponent(action.id)}/invoke`,
      { method: "POST" },
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
    const durable = appState.actionInvocations.find((invocation) => (
      String(invocation.sourceInteractionId) === String(sourceInteractionId)
      && String(invocation.actionId) === String(action.id)
    ));
    appState.pendingActionInvocations = withoutPendingActionInvocation(
      appState.pendingActionInvocations,
      sourceInteractionId,
      action.id,
    );
    const sourceIsStillSelected = (
      currentNavigationEntry()
      && navigationEntryKey(currentNavigationEntry()) === sourceLocationKey
    );
    if (
      durable?.resultInteractionId
      && !invokeResultIsRetryable(durable.resultCompletionStatus)
      && sourceIsStillSelected
    ) {
      onboardingTutorialController()?.actionSucceeded({
        threadId,
        interactionId: sourceInteractionId,
        actionId: action.id,
        resultInteractionId: durable.resultInteractionId,
      });
      supersedePendingHistory({ presentationChanged: true });
      viewState.currentInteractionId = durable.resultInteractionId;
      await refreshState(threadId, { historyMode: "push" }).catch(() => {});
      return { interaction: { id: durable.resultInteractionId }, recovered: true };
    } else {
      renderThread();
      toast(error.message);
    }
    return null;
  }
  if (response.invocation) {
    appState.actionInvocations = appState.actionInvocations.filter((invocation) => !(
      String(invocation.sourceInteractionId) === String(sourceInteractionId)
      && String(invocation.actionId) === String(action.id)
    ));
    appState.actionInvocations.push(response.invocation);
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
  const createdResultCanAdvance = response.created
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
    viewState.currentInteractionId = response.interaction.id;
  }
  if (String(viewState.currentThreadId) === String(threadId)) {
    await refreshState(threadId, {
      historyMode: createdResultCanAdvance ? "push" : "replace",
    });
  }
  return response;
}

async function createOrReuseProject(selectedScope) {
  const input = { path: selectedScope.path, name: selectedScope.label };
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
  if (!promptText || !permissionProfileId || creatingFirstThread) return;
  creatingFirstThread = true;
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
      input.value = "";
      renderSidebar();
      renderThread();
      return;
    }
    let projectId = selectedScope.projectId;
    if (selectedScope.kind === "folder") {
      const project = await createOrReuseProject(selectedScope);
      projectId = project.id;
    }
    const thread = await request("/api/threads", {
      method: "POST",
      body: JSON.stringify(newThreadRequestBody({
        title: threadTitle(promptText),
        initialMessage: promptText,
        permissionProfileId,
        projectId,
        pickerPayload,
      })),
    });
    viewState.currentThreadId = thread.id;
    onboardingTutorialController()?.threadCreated({
      threadId: thread.id,
      interactionId: thread.rootInteractionId,
    });
    input.value = "";
    await loadThread(thread.id);
  } catch (error) {
    await refreshAfterModelSelectionRejection(error);
    toast(error.message);
  } finally {
    creatingFirstThread = false;
    input.disabled = false;
    $("#permissionButton").disabled = !viewState.selectedPermissionProfileId;
    setNewThreadModelPickerDisabled(false);
    updateCreateThreadAvailability();
  }
}

export function connectEvents() {
  // Live harness events are intentionally outside this product-persistence slice.
}
