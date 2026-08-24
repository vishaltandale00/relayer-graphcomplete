import { setMainView, setSettingsTab } from "./navigation.js";
import { createProductWorkspace } from "./product-workspace/index.js";
import {
  productWorkspaceMode,
  productWorkspaceNeedsRecreation,
} from "./product-workspace/model.js";
import { activeThread, appState, desktop, evalReview, query, viewState } from "./state.js";
import { toast } from "./ui.js";
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
    onSelectionChange: replaceCurrentSelection,
    onExportConversation: desktop?.conversation?.export
      ? (threadId) => desktop.conversation.export(threadId)
      : null,
    onSubmitInteraction: (text, modelSelection) => import("./threads.js").then(({ submitInteraction }) => submitInteraction(text, modelSelection)),
    onOpenSettings: () => {
      setSettingsTab("models");
      document.querySelector("#settingsButton")?.click();
    },
    onNavigateLayer: (layerId, navigation) => import("./threads.js").then(({ navigateLayer }) => navigateLayer(layerId, navigation)),
    onNavigateResolvedInvoke: (action) => import("./threads.js").then(({ navigateResolvedInvoke }) => navigateResolvedInvoke(action)),
    onInvokeAction: (action) => import("./threads.js").then(({ invokeAction }) => invokeAction(action)),
    onDecideApproval: (requestId, decision) => import("./threads.js").then(({ decideApproval }) => decideApproval(requestId, decision)),
  });
  return productWorkspace;
}

export function renderThread() {
  workspace().render();
}

export function currentThreadModelSelectionPayload() {
  return workspace().modelSelectionPayload();
}
