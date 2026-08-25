import { setMainView, setSettingsTab } from "./navigation.js";
import { createProductWorkspace } from "./product-workspace/index.js";
import {
  productWorkspaceMode,
  productWorkspaceNeedsRecreation,
} from "./product-workspace/model.js";
import { activeThread, appState, desktop, evalReview, query, viewState } from "./state.js";
import { toast } from "./ui.js";
import { onboardingTutorialController } from "./onboarding-tutorial.js";
import { createAnnotationApi } from "./annotation-api.js";
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
    showThread: () => setMainView("thread"),
    showEmpty: () => setMainView("new"),
    getNavigationHistory,
    onNavigateHistory: async (direction) => {
      try {
        await navigateHistory(direction);
      } catch (error) {
        if (error.code !== "navigation_superseded") toast(error.message);
      }
    },
    onSelectTurn: selectTurn,
    onSelectTurnById: selectTurnById,
    onSelectionChange: (nodeId) => {
      replaceCurrentSelection(nodeId);
      onboardingTutorialController()?.nodeSelected({
        threadId: viewState.currentThreadId,
        interactionId: viewState.currentInteractionId,
        nodeId,
      });
    },
    onExportConversation: desktop?.conversation?.export
      ? (threadId) => desktop.conversation.export(threadId)
      : null,
    onSubmitInteraction: (text, modelSelection) => import("./threads.js").then(({ submitInteraction }) => submitInteraction(text, modelSelection)),
    onOpenSettings: () => {
      setSettingsTab("models");
      document.querySelector("#settingsButton")?.click();
    },
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
    onNavigateResolvedInvoke: (action) => import("./threads.js").then(({ navigateResolvedInvoke }) => navigateResolvedInvoke(action)),
    onInvokeAction: (action) => import("./threads.js").then(({ invokeAction }) => invokeAction(action)),
    onDecideApproval: (requestId, decision) => import("./threads.js").then(({ decideApproval }) => decideApproval(requestId, decision)),
    annotationApi,
  });
  return productWorkspace;
}

export function renderThread() {
  workspace().render();
  onboardingTutorialController()?.syncWorkspace();
}

export function currentThreadModelSelectionPayload() {
  return workspace().modelSelectionPayload();
}
