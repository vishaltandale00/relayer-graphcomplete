import { Window } from "happy-dom";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it("preserves unsubmitted standard Input edits and Undo through the production graph wrapper Current/source recreation", async () => {
  vi.resetModules();
  const window = new Window({ url: "http://127.0.0.1:3000/?threadId=3&interactionId=5" });
  vi.stubGlobal("window", window); vi.stubGlobal("document", window.document);
  vi.stubGlobal("location", window.location); vi.stubGlobal("history", window.history);
  vi.stubGlobal("lucide", new Proxy({ Circle: {}, createElement: () => window.document.createElement("svg") }, { get: (target, key) => target[key] ?? {} }));
  window.document.body.innerHTML = '<section id="threadView"></section><div id="toast"></div>';
  vi.doMock("../desktop/renderer/src/navigation.js", () => ({ setMainView: vi.fn(), setSettingsTab: vi.fn(), renderScopeMenu: vi.fn(), renderSidebar: vi.fn() }));
  vi.doMock("../desktop/renderer/src/onboarding-tutorial.js", () => ({ onboardingTutorialController: () => null }));
  const sourceNode = { id: 7, clientKey: "source", kind: "concept", title: "Plan a trip", state: "accepted" };
  const invoke = { id: 12, sourceNodeId: 7, sourceLayerId: 101, kind: "invoke", label: "Analyze", interactionText: "Analyze", state: "accepted", reusable: false, inputActionIds: [] };
  const otherInvoke = { id: 15, sourceNodeId: 7, sourceLayerId: 101, kind: "invoke", label: "Estimate", interactionText: "Estimate", state: "accepted", reusable: false, inputActionIds: [13] };
  const destination = { id: 13, sourceNodeId: 7, kind: "input", control: "text", prompt: "Destination", state: "accepted" };
  const notes = { id: 14, sourceNodeId: 7, kind: "input", control: "text", prompt: "Notes", state: "accepted" };
  const layer = { layer: { id: 101, state: "accepted", nodes: [7] }, nodes: [sourceNode], actions: [invoke, otherInvoke, destination, notes], edges: [] };
  const source = { id: 5, graphNodeId: 50, threadId: 3, sequence: 1, text: "Plan", completionStatus: "accepted", completionOutput: { rootLayer: layer } };
  const currentLayer = { layer: { id: 701, state: "accepted", nodes: [702] }, nodes: [{ id: 702, title: "Progress", state: "accepted" }], actions: [{ id: 704, sourceNodeId: 702, kind: "input", control: "text", prompt: "Child notes", state: "accepted" }], edges: [] };
  const call = { graphOnly: true, durable: true, reusable: false, sourceInteractionId: 5, actionId: 12, presentingLayerId: 101, invocationKey: "native-call", resultInteractionId: null, resultCompletionStatus: "running",
    nativeInvocation: { sourceAction: invoke, parentNode: sourceNode, submittedInputs: [], current: { nodeId: 700, rootLayerId: 701, layers: [currentLayer] }, invocation: { id: 9, invocationKey: "native-call", sourceCompletionId: 50, sourceActionId: 12, parentNodeId: 7, childInteractionNodeId: 700, actionSnapshot: { actionId: 12, sourceNodeId: 7, presentingLayerId: 101, label: "Analyze" }, state: { completionId: 700, lifecycle: "active", headRevision: 1, currentLayerId: 701, finalLayerId: null } } } };
  const thread = { id: 3, rootInteractionId: 5, harnessId: "fixture" };
  const draft = { threadId: 3, revision: 4, updatedAt: "2026-10-08T00:00:00Z", attachments: [destination, notes].map(action => ({ occurrence: { presentingInteractionNodeId: 50, presentingLayerId: 101, actionId: action.id }, sourceNodeId: 7, action: { control: "text", prompt: action.prompt }, value: { text: action.id === 13 ? "Saved destination" : "Saved notes" }, draftRevision: 4, committedAt: "2026-10-08T00:00:00Z", composerEligible: action.id === 14 })) };
  const request = vi.fn(async (path, options) => {
    if (options?.method && options.method !== "GET") throw new Error(`Unexpected mutation during read navigation: ${path}`);
    if (path === "/api/threads/3/input-draft") return structuredClone(draft);
    if (path === "/api/threads/3/context-drafts") return { drafts: [], confirmations: [] };
    if (path === "/api/threads/3") return { thread, interactions: [source], actionInvocations: [call], invocationInventoryAvailable: true };
    if (path === "/api/threads/3/interactions/5/layers/101") return layer;
    throw new Error(`Unexpected read: ${path}`);
  });
  vi.doMock("../desktop/renderer/src/api.js", () => ({ request }));
  const { appState, viewState } = await import("../desktop/renderer/src/state.js");
  const controller = await import("../desktop/renderer/src/threads.js");
  const { renderThread } = await import("../desktop/renderer/src/graph.js");
  Object.assign(appState, { threads: [thread], interactions: [source], status: "accepted", currentInteractionId: 5, visibleLayer: layer, nodes: layer.nodes, actions: layer.actions, actionInvocations: [call], invocationInventoryAvailable: true, conversationCompatibility: { threadId: 3, status: "unrestricted", harnessId: "fixture" }, modelSettings: { defaults: { harnessId: "fixture" }, harnesses: [{ id: "fixture", available: true }], providers: [], families: [] } });
  Object.assign(viewState, { currentThreadId: 3, currentInteractionId: 5, selectedNodeId: 7, mainView: "thread", layerPath: [{ layerId: 101, label: "Response", sourceNodeId: 50, actionId: null }] });
  const field = prompt => window.document.querySelector(`textarea[aria-label="${prompt}"]`);
  try {
    renderThread();
    await vi.waitFor(() => expect(field("Notes")?.value).toBe("Saved notes"));
    expect(window.document.querySelector('[data-action-id="12"]').disabled).toBe(true);
    field("Notes").value = "Unsubmitted notes"; field("Notes").dispatchEvent(new window.Event("input", { bubbles: true }));
    field("Destination").value = "Unsubmitted destination"; field("Destination").dispatchEvent(new window.Event("input", { bubbles: true }));
    window.document.querySelector('[data-graph-owned-invocation-id="9"]').click();
    await vi.waitFor(() => expect(viewState.currentInteractionId).toBe("native-current:9"));
    await vi.waitFor(() => expect(field("Child notes")?.disabled).toBe(true));
    expect(field("Child notes").value).toBe("");
    expect(window.document.querySelector("#threadView").dataset.canCompose).toBe("false");
    window.document.querySelector("button.breadcrumb-invoke-origin").click();
    await vi.waitFor(() => expect(viewState.currentInteractionId).toBe(5));
    await vi.waitFor(() => expect(field("Notes")?.value).toBe("Unsubmitted notes"));
    expect(field("Destination").value).toBe("Unsubmitted destination");
    expect(window.document.querySelector('[data-action-id="12"]').disabled).toBe(true);
    expect(window.document.querySelector("#threadView").dataset.canCompose).toBe("true");
    window.document.querySelector('[aria-label="Undo Notes"]').click();
    await vi.waitFor(() => expect(field("Notes")?.value).toBe("Saved notes"));
    expect(field("Destination").value).toBe("Unsubmitted destination");
    window.document.querySelector('[aria-label="Undo Destination"]').click();
    await vi.waitFor(() => expect(field("Destination")?.value).toBe("Saved destination"));
    expect(field("Notes").value).toBe("Saved notes");
    expect(request.mock.calls.filter(([, options]) => options?.method && options.method !== "GET")).toEqual([]);
    expect(appState.interactions.filter(interaction => !interaction.inertInvocationCurrent)).toEqual([source]);
    expect(draft.revision).toBe(4);
  } finally { controller.cancelNavigationHistory(); await window.happyDOM.close(); }
});
