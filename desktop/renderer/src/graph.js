import { setMainView } from "./navigation.js";
import { createProductWorkspace } from "./product-workspace/index.js";
import { activeThread, appState, evalReview, query, viewState } from "./state.js";
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
    onSelectionChange: replaceCurrentSelection,
    onSubmitInteraction: (text) => import("./threads.js").then(({ submitInteraction }) => submitInteraction(text)),
    onNavigateLayer: (layerId, navigation) => import("./threads.js").then(({ navigateLayer }) => navigateLayer(layerId, navigation)),
    onInvokeAction: (action) => import("./threads.js").then(({ invokeAction }) => invokeAction(action)),
  });
  return productWorkspace;
}

export function renderThread() {
  workspace().render();
}
