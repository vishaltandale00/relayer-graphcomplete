import { Window } from "happy-dom";
import { afterEach, expect, it, vi } from "vitest";
import { createProductWorkspace } from "../desktop/renderer/src/product-workspace/workspace.js";

afterEach(() => vi.unstubAllGlobals());

function mount(mode = "interactive") {
  const window = new Window({ url: "http://127.0.0.1:3000" });
  vi.stubGlobal("document", window.document);vi.stubGlobal("window", window);
  vi.stubGlobal("lucide", new Proxy({ createElement: () => window.document.createElement("svg") }, { get: (target, key) => target[key] ?? {} }));
  window.document.body.innerHTML = '<section id="threadView"></section>';
  let thread = { id: 10, title: "Saved chat", harnessId: "codex-basic" };
  const layer = { layer: { id: 201, nodes: [], state: "accepted" }, nodes: [], edges: [], actions: [] };
  const state = {
    status: "accepted", currentInteractionId: 1,
    interactions: [{ id: 1, threadId: 10, sequence: 1, text: "Prompt", completionStatus: "accepted", completionOutput: { rootLayer: layer } }],
    visibleLayer: layer, nodes: [], actions: [], projects: [], permissionProfiles: [], modelCatalog: [], actionInvocations: [], pendingActionInvocations: [],
    modelSettings: { defaults: { harnessId: "claude-basic" }, harnesses: [{ id: "codex-basic", label: "Codex Basic", available: false }, { id: "claude-basic", label: "Claude Basic", available: true }], providers: [], families: [] },
  };
  const workspace = createProductWorkspace({ root: window.document, mode, getState: () => state, getThread: () => thread,
    contextDraftApi: { list: async () => ({ drafts: [], confirmations: [] }) },
    selection: { currentThreadId: 10, currentInteractionId: 1, selectedNodeId: null, layerPath: [] }, showThread() {}, showEmpty() {} });
  workspace.render();
  return { window, document: window.document, workspace, state, setThread: value => { thread = value; } };
}

it("shows the recorded harness read-only, updates metadata, and closes on thread changes", async () => {
  const view = mount();const { document, workspace, state } = view;
  try {
    document.querySelector("#conversationSettingsButton").click();
    document.querySelector("#openThreadDetails").click();
    const dialog = document.querySelector("#threadDetailsDialog");
    expect(dialog.open).toBe(true);
    expect(dialog.querySelector("#threadDetailsHarness").textContent).toBe("Codex Basic");
    expect(dialog.querySelectorAll("select,input,[role=radio]")).toHaveLength(0);
    state.modelSettings.defaults.harnessId = "other";
    state.modelSettings.harnesses = [];
    workspace.render();
    expect(dialog.querySelector("#threadDetailsHarness").textContent).toBe("codex-basic");
    document.querySelector("#closeThreadDetails").click();
    await view.window.happyDOM.waitUntilComplete();
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(document.querySelector("#conversationSettingsButton"));
    document.querySelector("#openThreadDetails").click();
    view.setThread({ id: 11, title: "Another chat", harnessConfigurationName: "claude-basic" });workspace.render();
    expect(dialog.open).toBe(false);
    document.querySelector("#openThreadDetails").click();
    expect(dialog.querySelector("#threadDetailsHarness").textContent).toBe("claude-basic");
    document.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dialog.open).toBe(false);
    view.setThread({ id: 11, title: '<img src=x onerror="bad()">' });workspace.render();document.querySelector("#openThreadDetails").click();
    expect(dialog.querySelector("#threadDetailsHarness").textContent).toBe("Unknown");
    expect(dialog.querySelector("#threadDetailsName").textContent).toContain("<img");expect(dialog.querySelector("img")).toBeNull();
    view.setThread(null);workspace.render();expect(dialog.open).toBe(false);
    view.setThread({ id: 12, title: "Final chat", harnessId: "codex-basic" });workspace.render();
    document.querySelector("#openThreadDetails").click();
    workspace.dispose();expect(dialog.open).toBe(false);
  } finally { workspace.dispose();await view.window.happyDOM.abort(); }
});

it("keeps the native thread-details entry out of read-only/public workspaces", async () => {
  const view = mount("review");
  try { expect(view.document.querySelector("#openThreadDetails").classList.contains("hidden")).toBe(true);expect(view.document.querySelector("#conversationSettings").classList.contains("hidden")).toBe(true); }
  finally { view.workspace.dispose();await view.window.happyDOM.abort(); }
});
