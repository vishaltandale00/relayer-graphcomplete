import { setMainView, setSettingsTab } from "./navigation.js";
import { createProductWorkspace } from "./product-workspace/index.js";
import { activeThread, appState, evalReview, query, viewState } from "./state.js";
import { toast } from "./ui.js";
import { onboardingTutorialController } from "./onboarding-tutorial.js";
import {
  getNavigationHistory,
  navigateHistory,
  replaceCurrentSelection,
  selectTurn,
  selectTurnById,
} from "./threads.js";

let productWorkspace;

function workspace() {
  productWorkspace ??= createProductWorkspace({
    mode: evalReview || query.get("review") === "1" ? "review" : "interactive",
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
    onSubmitInteraction: async (text, modelSelection) => {
      const { submitInteraction } = await import("./threads.js");
      return submitInteraction(text, modelSelection);
    },
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
    onInvokeAction: async (action) => {
      const { invokeAction } = await import("./threads.js");
      const source = {
        threadId: viewState.currentThreadId,
        interactionId: viewState.currentInteractionId,
      };
      const response = await invokeAction(action);
      const resultInteractionId = response?.interaction?.id;
      if (resultInteractionId != null) {
        onboardingTutorialController()?.actionSucceeded({
          ...source,
          actionId: action.id,
          resultInteractionId,
        });
      }
      return response;
    },
    onDecideApproval: (requestId, decision) => import("./threads.js").then(({ decideApproval }) => decideApproval(requestId, decision)),
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
