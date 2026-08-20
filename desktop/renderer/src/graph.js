import { setMainView } from "./navigation.js";
import { createProductWorkspace } from "./product-workspace/index.js";
import { activeThread, appState, evalReview, query, viewState } from "./state.js";

let productWorkspace;

function workspace() {
  productWorkspace ??= createProductWorkspace({
    mode: evalReview || query.get("review") === "1" ? "review" : "interactive",
    getState: () => appState,
    getThread: activeThread,
    selection: viewState,
    showThread: () => setMainView("thread"),
    showEmpty: () => setMainView("new"),
    onSelectTurn: (offset) => import("./threads.js").then(({ selectTurn }) => selectTurn(offset)),
    onSubmitInteraction: (text) => import("./threads.js").then(({ submitInteraction }) => submitInteraction(text)),
    onNavigateLayer: (layerId, navigation) => import("./threads.js").then(({ navigateLayer }) => navigateLayer(layerId, navigation)),
    onInvokeAction: (action) => import("./threads.js").then(({ invokeAction }) => invokeAction(action)),
  });
  return productWorkspace;
}

export function renderThread() {
  workspace().render();
}
