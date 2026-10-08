import { setMainView, setSettingsTab } from "./navigation.js";
import { createProductWorkspace } from "./product-workspace/index.js";
import {
  productWorkspaceMode,
  productWorkspaceNeedsRecreation,
} from "./product-workspace/model.js";
import { activeThread, appState, desktop, evalReview, query, viewState } from "./state.js";
import { resolveAcceptedNodeDetailAsset } from "./node-detail-assets.js";
import { toast } from "./ui.js";
import { onboardingTutorialController } from "./onboarding-tutorial.js";
import { createAnnotationApi } from "./annotation-api.js";
import { createNodeContextDraftApi } from "./node-context-drafts.js";
import { createNodeInputDraftApi } from "./node-input-drafts.js";
import { projectComposerGate } from "./project-composer-navigation.js";
import { providerModelsRefreshAction } from "./provider-models-refresh.js";
import {
  getNavigationHistory,
  navigateHistory,
  replaceCurrentSelection,
  selectTurn,
  selectTurnById,
} from "./threads.js";

let productWorkspace;

function workspace() {
  const nextMode = productWorkspaceMode({
    evalReviewContext: evalReview,
    reviewRequested: query.get("review") === "1",
    thread: activeThread(),
  });
  if (productWorkspaceNeedsRecreation(productWorkspace?.mode, nextMode)) {
    productWorkspace.dispose();
    productWorkspace = undefined;
  }
  const annotationApi = appState.capabilities?.annotations === true
    ? createAnnotationApi()
    : null;
  productWorkspace ??= createProductWorkspace({
    mode: nextMode,
    getState: () => appState,
    getThread: activeThread,
    selection: viewState,
    resolveNodeDetailAsset: (asset, { node, thread, interaction, layerId }) => resolveAcceptedNodeDetailAsset(asset, {
      threadId: thread?.id,
      interactionId: interaction?.id,
      nodeId: node.id,
      layerId,
    }),
    showThread: () => setMainView("thread"),
    showEmpty: () => setMainView("new"),
    getNavigationHistory,
    onOpenReadyResult: () => import("./threads.js").then(({ openReadyResult }) => openReadyResult()),
    onNavigateHistory: async (direction, navigation) => {
      try {
        await navigateHistory(direction, navigation);
      } catch (error) {
        if (error.code !== "navigation_superseded") toast(error.message);
      }
    },
    onSelectTurn: (delta) => {
      projectComposerGate.invalidate();
      return selectTurn(delta);
    },
    onSelectTurnById: async (turnId, options) => {
      projectComposerGate.invalidate();
      try { return await selectTurnById(turnId, options); }
      catch (error) { toast(error.message); return false; }
    },
    onSelectionChange: (nodeId, options) => {
      if (options) replaceCurrentSelection(nodeId, options);
      else replaceCurrentSelection(nodeId);
      onboardingTutorialController()?.nodeSelected({
        threadId: viewState.currentThreadId,
        interactionId: viewState.currentInteractionId,
        nodeId,
      });
    },
    onArchiveThread: viewState.evalContext ? null : (threadId, archived) => import("./thread-archive.js").then((module) => archived ? module.archiveThread(threadId) : module.setThreadArchived(threadId, false)),
    onExportConversation: desktop?.conversation?.export
      ? (threadId) => desktop.conversation.export(threadId)
      : null,
    shareApi: desktop?.share && desktop?.account ? {
      account: desktop.account,
      share: desktop.share,
      clipboard: navigator.clipboard,
    } : null,
    onStopInteraction: (threadId, interactionId) => import("./threads.js").then(({ stopInteraction }) => stopInteraction(threadId, interactionId)),
    onSubmitInteraction: (
      text,
      modelSelection,
      contexts,
      contextConfirmationIds,
      inputIdentityRevision,
      inputDraftRevision,
    ) => import("./threads.js").then(({ submitInteraction }) => submitInteraction(
      text,
      modelSelection,
      contexts,
      contextConfirmationIds,
      inputIdentityRevision,
      inputDraftRevision,
    )),
    onOpenSettings: (tab = "models") => {
      setSettingsTab(tab);
      document.querySelector("#settingsButton")?.click();
    },
    onRefreshModels: providerModelsRefreshAction(),
    onNavigateLayer: async (layerId, navigation) => {
      const { navigateLayer } = await import("./threads.js");
      const source = {
        threadId: viewState.currentThreadId,
        interactionId: viewState.currentInteractionId,
      };
      const navigated = await navigateLayer(layerId, navigation);
      if (navigated === true) {
        onboardingTutorialController()?.actionSucceeded({
          ...source,
          actionId: navigation?.action?.id,
        });
      }
      return navigated;
    },
    onNavigateResolvedInvoke: (action, navigation) => import("./threads.js").then(
      ({ navigateResolvedInvoke }) => navigateResolvedInvoke(action, navigation),
    ),
    onInvokeAction: (action, options) => import("./threads.js").then(({ invokeAction }) => invokeAction(action, options)),
    onDecideApproval: (requestId, decision) => import("./threads.js").then(({ decideApproval }) => decideApproval(requestId, decision)),
    annotationApi,
    contextDraftApi: nextMode === "interactive" ? createNodeContextDraftApi() : null,
    implicitInputAcceptance: nextMode === "interactive",
    inputDraftApi: nextMode === "interactive" ? createNodeInputDraftApi() : null,
    inputOperatorAvailable: nextMode === "review" && query.get("inputOperator") === "1",
  });
  return productWorkspace;
}

/** Refresh the composer's attached contexts after artifact notes changed them. */
export function reloadComposerContexts(threadId) {
  return productWorkspace?.reloadConfirmedContexts?.(threadId) ?? Promise.resolve();
}

export function renderThread() {
  workspace().render();
  onboardingTutorialController()?.syncWorkspace();
}

export function currentThreadModelSelectionPayload() {
  return workspace().modelSelectionPayload();
}

export function prepareCurrentWorkspaceTransition() {
  return productWorkspace?.prepareSelectionChange() ?? Promise.resolve(true);
}
