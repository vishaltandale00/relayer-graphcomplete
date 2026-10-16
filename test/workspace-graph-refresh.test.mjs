import { Window } from "happy-dom";
import { afterEach, expect, it, vi } from "vitest";
import { createProductWorkspace } from "../desktop/renderer/src/product-workspace/workspace.js";

afterEach(() => vi.unstubAllGlobals());

const imageIcon = { kind: "image", assetId: "destination", digestSha256: "a".repeat(64), mediaType: "image/png" };
it.each(["box", imageIcon])("keeps an observed graph node and its icon mounted through refresh, but retires a changed view (%j)", async icon => {
  const window = new Window({ url: "http://127.0.0.1:3000" });
  vi.stubGlobal("document", window.document); vi.stubGlobal("window", window);
  vi.stubGlobal("lucide", new Proxy({ Circle: {}, createElement: () => window.document.createElement("svg") }, { get: (target, key) => target[key] ?? {} }));
  window.document.body.innerHTML = '<section id="threadView"></section>';
  const node = { id: 7, icon, title: "Choose a destination", detail: "Compare routes", state: "accepted" };
  const layer = { layer: { id: 101, state: "accepted" }, nodes: [node], edges: [], actions: [] };
  const turn = { id: 5, threadId: 3, graphNodeId: 50, text: "Plan a trip", completionStatus: "running", contexts: [], completionOutput: { rootLayer: layer } };
  let state = { status: "running", currentInteractionId: 5, interactions: [turn], visibleLayer: layer, nodes: [node], actions: [], projects: [], permissionProfiles: [], modelSettings: { defaults: { harnessId: "fixture" }, harnesses: [{ id: "fixture", available: true }], providers: [], families: [] }, modelCatalog: [], actionInvocations: [], pendingActionInvocations: [] };
  const selection = { currentThreadId: 3, currentInteractionId: 5, selectedNodeId: null, nodeDetailsClosed: true, layerPath: [] };
  const navigate = vi.fn(async () => {});
  const resolutions = [];
  const resolveAsset = vi.fn(async (_asset, context) => {
    const release = vi.fn(); resolutions.push({ context, release });
    return { url: resolutions.length === 1 ? undefined : "blob:accepted", digestSha256: imageIcon.digestSha256, mediaType: "image/png", release };
  });
  const workspace = createProductWorkspace({ root: window.document, getState: () => state, getThread: () => ({ id: 3, harnessId: "fixture" }), selection, onNavigateLayer: navigate, resolveNodeDetailAsset: resolveAsset, showThread() {}, showEmpty() {} });
  try {
    workspace.render();
    const observed = window.document.querySelector('.graph-node[data-node="7"]');
    let glyph = observed.querySelector(".glyph").firstElementChild;
    observed.focus();
    if (icon === imageIcon) {
      expect(await glyph.readyIcon).toBe("fallback");
      expect(resolutions[0].release).toHaveBeenCalledOnce();
      workspace.render();
      expect(observed.isConnected).toBe(true);
      expect(window.document.activeElement).toBe(observed);
      glyph = observed.querySelector(".glyph").firstElementChild;
      await vi.waitFor(() => expect(resolveAsset).toHaveBeenCalledTimes(2));
    }
    for (let i = 0; i < 3; i++) {
      state = structuredClone(state);
      workspace.render();
      expect(observed.isConnected).toBe(true);
      expect(window.document.activeElement).toBe(observed);
      expect(observed.querySelector(".glyph").firstElementChild).toBe(glyph);
    }
    if (icon === imageIcon) {
      expect(resolveAsset).toHaveBeenCalledTimes(2);
      expect(resolutions[1].context).toMatchObject({ node: { id: 7 }, thread: { id: 3 }, interaction: { id: 5, graphNodeId: 50 }, layerId: 101 });
      expect(resolutions[1].release).not.toHaveBeenCalled();
    }
    observed.setPointerCapture = vi.fn();
    observed.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: 100, clientY: 100 }));
    observed.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, buttons: 1, pointerId: 1, clientX: 110, clientY: 100 }));
    workspace.render();
    observed.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    workspace.render();
    observed.click();
    expect(selection.selectedNodeId).toBeNull();
    observed.click();
    await vi.waitFor(() => expect(selection.selectedNodeId).toBe("7"));
    workspace.render();
    expect(window.document.querySelector('.graph-node[data-node="7"]')).toBe(observed);
    state = structuredClone(state);
    state.nodes[0].detail = "Updated route evidence";
    state.visibleLayer.nodes[0].detail = "Updated route evidence";
    state.actions = [{ id: 8, sourceNodeId: 7, sourceLayerId: 101, kind: "navigate", relation: "expand", label: "Route evidence", targetLayerId: 201 }];
    workspace.render();
    observed.click();
    await vi.waitFor(() => expect(window.document.querySelector("#detailContent").textContent).toContain("Updated route evidence"));
    window.document.querySelector('[data-action-id="8"]').click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(201, expect.objectContaining({ sourceNode: expect.objectContaining({ id: 7 }) })));
    state.nodes[0].title = "Updated destination";
    state.visibleLayer.nodes[0].title = "Updated destination";
    workspace.render();
    const updated = window.document.querySelector('.graph-node[data-node="7"]');
    expect(updated.getAttribute("aria-label")).toContain("Updated destination");
    expect(observed.isConnected).toBe(false);
    if (icon === imageIcon) expect(resolutions[1].release).toHaveBeenCalledOnce();
    state.visibleLayer.layer.id = 102;
    workspace.render();
    expect(updated.isConnected).toBe(false);
    expect(window.document.querySelector('.graph-node[data-node="7"]')).not.toBe(updated);
  } finally { workspace.dispose(); await window.happyDOM.close(); }
});
