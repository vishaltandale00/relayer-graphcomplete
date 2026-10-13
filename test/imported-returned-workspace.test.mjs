import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProductWorkspace } from "../desktop/renderer/src/product-workspace/workspace.js";
import { productWorkspaceMode } from "../desktop/renderer/src/product-workspace/model.js";
import { inertInvocationCurrent } from "../desktop/renderer/src/public-share-viewer/snapshot.js";

const actualFixture = JSON.parse(readFileSync(new URL("./fixtures/inert-returned-call.json", import.meta.url), "utf8"));
afterEach(() => vi.unstubAllGlobals());

describe("actual imported graph-only Returned at the workspace", () => {
  it.each(["retained", "missing-mapped-turn", "wrong-returned-root"])("offers only the actual retained read target (%s)", async scenario => {
    const { detail, sourceLayer } = structuredClone(actualFixture);
    const window = new Window({ url: "http://127.0.0.1:3000" });
    vi.stubGlobal("document", window.document); vi.stubGlobal("window", window);
    vi.stubGlobal("lucide", new Proxy({ Circle: {}, createElement: () => window.document.createElement("svg") }, { get: (target, key) => target[key] ?? {} }));
    window.document.body.innerHTML = '<section id="threadView"></section><div id="toast"></div>';
    const entry = detail.importedInvocationHistory[0];
    if (scenario === "missing-mapped-turn") entry.resultInteractionId = 999;
    if (scenario === "wrong-returned-root") entry.record.returnedLayerId = "layer:foreign";
    const source = detail.interactions.find(item => item.id === entry.sourceInteractionId);
    const state = { ...detail, status: "accepted", currentInteractionId: source.id, visibleLayer: sourceLayer, nodes: sourceLayer.nodes, actions: sourceLayer.actions, projects: [], permissionProfiles: [], modelSettings: { defaults: { harnessId: "fixture" }, harnesses: [{ id: "fixture", available: true }], providers: [], families: [] }, modelCatalog: [], pendingActionInvocations: [] };
    const selection = { currentThreadId: detail.thread.id, currentInteractionId: source.id, selectedNodeId: entry.sourceNodeId, layerPath: [] };
    const onNavigateImportedInvocationHistory = vi.fn(); const onInvokeAction = vi.fn();
    const workspace = createProductWorkspace({ root: window.document, mode: productWorkspaceMode({ thread: detail.thread, interaction: source }), getState: () => state, getThread: () => detail.thread, selection, onNavigateImportedInvocationHistory, onInvokeAction, showThread() {}, showEmpty() {} });
    try {
      workspace.render();
      await vi.waitFor(() => expect(window.document.querySelector(`[data-imported-invocation-id="${entry.record.id}"]`)).not.toBeNull());
      const button = window.document.querySelector(`[data-imported-invocation-id="${entry.record.id}"]`);
      expect(button.textContent).toContain("Result");
      expect(button.disabled).toBe(scenario !== "retained");
      if (scenario === "retained") {
        button.click();
        await vi.waitFor(() => expect(onNavigateImportedInvocationHistory).toHaveBeenCalledExactlyOnceWith(entry));
        const presentation = inertInvocationCurrent(entry.record, { threadId: detail.thread.id, sourceInteractionId: source.id, allowReturned: true });
        state.interactions.push(presentation.interaction);
        state.currentInteractionId = presentation.interaction.id;
        state.visibleLayer = presentation.interaction.completionOutput.rootLayer;
        state.nodes = state.visibleLayer.nodes; state.actions = state.visibleLayer.actions;
        Object.assign(selection, { currentInteractionId: presentation.interaction.id, selectedNodeId: state.nodes[0].id });
        workspace.render();
        expect(window.document.querySelector("#threadView").dataset.canCompose).toBe("false");
        await vi.waitFor(() => expect(window.document.querySelector("#detailTitle").textContent).toContain("Current contribution"));
        expect(onInvokeAction).not.toHaveBeenCalled();
        expect(detail.actionInvocations).toEqual([]);
      }
    } finally { workspace.dispose(); await window.happyDOM.close(); }
  });
});
