import { createHash } from "node:crypto";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProductWorkspace } from "../desktop/renderer/src/product-workspace/workspace.js";
import { nativeInvocationCurrentPresentation, productWorkspaceMode, humanTurns } from "../desktop/renderer/src/product-workspace/model.js";

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);

function fixture(lifecycle, compiled) {
  const action = { id: 12, clientKey: "analyze", sourceNodeId: 7, kind: "invoke", label: "Analyze destination", interactionText: "Analyze", reusable: false, state: "accepted" };
  const node = { id: 7, clientKey: "destination", kind: "concept", title: "Choose a vacation destination", detail: "Compare candidates", state: "accepted" };
  if (compiled) {
    const content = { version: 1, components: [{ id: "page", order: 0, html: '<button data-gc-mount="analyze">Analyze destination</button>', css: "" }], mounts: [{ id: "analyze", componentId: "page", kind: "capability", host: "button", capability: { kind: "invoke", action: { clientKey: action.clientKey, sourceNode: { clientKey: node.clientKey } } } }], assets: [] };
    node.authoredDetail = { ...content, integritySha256: createHash("sha256").update(canonical(content)).digest("hex") };
  }
  const layer = { layer: { id: 101, state: "accepted" }, nodes: [node], edges: [], actions: [action] };
  const source = { id: 5, threadId: 3, graphNodeId: 50, sequence: 1, text: "Compare", completionStatus: "accepted", completionOutput: { rootLayer: layer } };
  const childLayer = { layer: { id: 701, state: "accepted" }, nodes: [{ id: 702, title: "Accepted child progress", state: "accepted" }], edges: [], actions: [{ id: 703, sourceNodeId: 702, kind: "invoke", label: "Child action", interactionText: "Continue", reusable: false }] };
  const call = { graphOnly: true, durable: true, agentInvoked: true, reusable: false, sourceInteractionId: 5, actionId: 12,
    invocationKey: "native-call", resultInteractionId: null, resultCompletionStatus: { active: "running", succeeded: "accepted", stopped: "stopped", failed: "failed" }[lifecycle],
    nativeInvocation: { invocation: { id: 9, invocationKey: "native-call", sourceCompletionId: 50, sourceActionId: 12, parentNodeId: 7, childInteractionNodeId: 700,
      actionSnapshot: { actionId: 12, sourceNodeId: 7, label: "Frozen analysis" }, state: { completionId: 700, lifecycle, headRevision: 1, currentLayerId: 701, finalLayerId: lifecycle === "succeeded" ? 701 : null, safeReason: ["stopped", "failed"].includes(lifecycle) ? "Interrupted" : null } },
    sourceAction: action, parentNode: node, submittedInputs: [{ action: { control: "text", prompt: "Destination" }, value: { text: "Lisbon" } }], current: { nodeId: 700, rootLayerId: 701, layers: [childLayer] } } };
  const thread = { id: 3, rootInteractionId: 5, harnessId: "fixture" };
  const state = { invocationInventoryAvailable: true, conversationCompatibility: { threadId: 3, status: "unrestricted", harnessId: "fixture" }, status: "accepted", currentInteractionId: 5, interactions: [source], visibleLayer: layer, nodes: [node], actions: [action], projects: [], permissionProfiles: [], modelSettings: { defaults: { harnessId: "fixture" }, harnesses: [{ id: "fixture", available: true }], providers: [], families: [] }, modelCatalog: [], actionInvocations: [call], pendingActionInvocations: [] };
  return { action, node, layer, source, call, thread, state };
}

afterEach(() => vi.unstubAllGlobals());

describe("graph-owned Current at the actual workspace", () => {
  it.each([false, true].flatMap(compiled => ["active", "stopped", "failed", "succeeded"].map(lifecycle => [compiled, lifecycle])))
    ("opens accepted native progress without manufacturing a launch (compiled=%s, lifecycle=%s)", async (compiled, lifecycle) => {
      const window = new Window({ url: "http://127.0.0.1:3000" });
      vi.stubGlobal("document", window.document); vi.stubGlobal("window", window);
      vi.stubGlobal("lucide", new Proxy({ Circle: {}, createElement: () => window.document.createElement("svg") }, { get: (target, key) => target[key] ?? {} }));
      window.document.body.innerHTML = '<section id="threadView"></section><div id="toast"></div>';
      const { state, thread, source, call } = fixture(lifecycle, compiled);
      const onInvokeAction = vi.fn(); const onNavigateInvocationCurrent = vi.fn();
      const selection = { currentThreadId: 3, currentInteractionId: 5, selectedNodeId: 7, layerPath: [] };
      let workspace = createProductWorkspace({ root: window.document, mode: "interactive", getState: () => state, getThread: () => thread, selection, onInvokeAction, onNavigateInvocationCurrent, showThread() {}, showEmpty() {} });
      try {
        workspace.render();
        const control = () => compiled ? window.document.querySelector("[data-node-detail-runtime]")?.shadowRoot?.querySelector('[data-gc-mount="analyze"]') : window.document.querySelector('[data-action-id="12"]');
        await vi.waitFor(() => expect(control()?.disabled).toBe(true));
        const current = window.document.querySelector('[data-graph-owned-invocation-id="9"]');
        expect(current.disabled).toBe(false);
        expect(current.textContent).toContain(lifecycle === "succeeded" ? "Result" : "Current");
        expect(current.textContent).toContain("Lisbon");
        current.click();
        await vi.waitFor(() => expect(onNavigateInvocationCurrent).toHaveBeenCalledExactlyOnceWith(call));
        expect(onInvokeAction).not.toHaveBeenCalled();
        expect(state.interactions).toEqual([source]);
        const presentation = nativeInvocationCurrentPresentation(call, { threadId: thread.id, sourceInteraction: source });
        expect(presentation.interaction.id).toBe("native-current:9");
        expect(humanTurns({ interactions: [source, presentation.interaction], actionInvocations: [call] }, thread)).toEqual([source]);
        expect(productWorkspaceMode({ thread, interaction: presentation.interaction })).toBe("review");
        workspace.dispose();
        state.interactions.push(presentation.interaction); state.currentInteractionId = presentation.interaction.id;
        state.visibleLayer = presentation.interaction.completionOutput.rootLayer; state.nodes = state.visibleLayer.nodes; state.actions = state.visibleLayer.actions;
        Object.assign(selection, { currentInteractionId: presentation.interaction.id, selectedNodeId: 702 });
        workspace = createProductWorkspace({ root: window.document, mode: productWorkspaceMode({ thread, interaction: presentation.interaction }), getState: () => state, getThread: () => thread, selection, onInvokeAction, showThread() {}, showEmpty() {} });
        workspace.render();
        await vi.waitFor(() => expect(window.document.querySelector('[data-action-id="703"]')?.disabled).toBe(true));
        expect(window.document.querySelector("#threadView").dataset.canCompose).toBe("false");
        expect(onInvokeAction).not.toHaveBeenCalled();
      } finally { workspace.dispose(); await window.happyDOM.close(); }
    });

  it.each(["missing-current", "occupancy", "wrong-source", "wrong-key", "wrong-child", "wrong-root", "draft-layer"])
    ("rejects unavailable or mismatched read projections (%s)", scenario => {
      const { call, source } = fixture("active", false);
      if (scenario === "missing-current") call.nativeInvocation.current = null;
      if (scenario === "occupancy") call.occupancyOnly = true;
      if (scenario === "wrong-source") call.nativeInvocation.invocation.sourceCompletionId = 999;
      if (scenario === "wrong-key") call.nativeInvocation.invocation.invocationKey = "foreign";
      if (scenario === "wrong-child") call.nativeInvocation.current.nodeId = 999;
      if (scenario === "wrong-root") call.nativeInvocation.current.rootLayerId = 999;
      if (scenario === "draft-layer") call.nativeInvocation.current.layers[0].layer.state = "draft";
      expect(nativeInvocationCurrentPresentation(call, { threadId: 3, sourceInteraction: source })).toBeNull();
    });
});
