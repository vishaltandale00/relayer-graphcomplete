import { Window } from "happy-dom";
import { afterEach, expect, it, vi } from "vitest";
import { createProductWorkspace } from "../desktop/renderer/src/product-workspace/workspace.js";

afterEach(() => vi.unstubAllGlobals());

// Invoked runs run beside the message turns (#717): each run's Stop lives on the node it came
// from, and the composer stays a Send for the next message.
it("gives every run invoked from a node its own Stop, kept in place across refreshes", async () => {
  const window = new Window({ url: "http://127.0.0.1:3000" });
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("lucide", new Proxy({ createElement: () => window.document.createElement("svg") }, { get: (t, k) => t[k] ?? {} }));
  window.document.body.innerHTML = '<section id="threadView"></section>';
  const node = { id: 21, kind: "concept", icon: "box", title: "Projects", detail: "Build something small.", state: "accepted" };
  const action = (id, label) => ({
    id, kind: "invoke", sourceNodeId: 21, label, interactionText: `${label} in detail`, state: "accepted", targetLayerId: null,
  });
  const actions = [action(31, "Plan a week"), action(32, "List pitfalls")];
  const layer = { layer: { id: 201, nodes: [21], state: "accepted" }, nodes: [node], edges: [], actions };
  const thread = { id: 10, title: "Learning plan", harnessId: "fixture" };
  const run = (id, completionStatus) => ({ id, threadId: 10, sequence: id, text: "Invoked", completionStatus });
  const state = {
    status: "accepted", currentInteractionId: 1, capabilities: { stopRuns: true },
    conversationCompatibility: { threadId: 10, status: "unrestricted", harnessId: "fixture" },
    interactions: [
      { id: 1, graphNodeId: 901, threadId: 10, sequence: 1, text: "Compare approaches", completionStatus: "accepted", completionOutput: { rootLayer: layer } },
      run(5, "running"),
      run(6, "running"),
    ],
    actionInvocations: [
      { sourceInteractionId: 1, actionId: 31, resultInteractionId: 5, resultCompletionStatus: "running", agentInvoked: false },
      { sourceInteractionId: 1, actionId: 32, resultInteractionId: 6, resultCompletionStatus: "running", agentInvoked: false },
    ],
    visibleLayer: layer, nodes: [node], actions, projects: [], permissionProfiles: [],
    modelSettings: { defaults: { harnessId: "fixture" }, harnesses: [{ id: "fixture", available: true }], providers: [], families: [] },
    modelCatalog: [], pendingActionInvocations: [],
  };
  const onStopInteraction = vi.fn(async () => {});
  const selection = { currentThreadId: 10, currentInteractionId: 1, selectedNodeId: 21, layerPath: [] };
  const workspace = createProductWorkspace({
    root: window.document, getState: () => state, getThread: () => thread, selection,
    onStopInteraction, mode: "interactive", showThread() {}, showEmpty() {},
  });
  try {
    workspace.render();
    await window.happyDOM.waitUntilComplete();
    const bar = window.document.querySelector("#nodeRunBar");
    const rows = () => [...bar.querySelectorAll(".node-run-row")];
    expect(bar.classList.contains("hidden")).toBe(false);
    expect(rows().map((row) => row.dataset.interactionId)).toEqual(["5", "6"]);
    expect(rows().map((row) => row.querySelector(".node-run-status").textContent))
      .toEqual(["Plan a week · Running", "List pitfalls · Running"]);
    // The composer follows message turns: invoked runs leave it a Send.
    expect(window.document.querySelector("#sendInteraction").classList.contains("stop-button")).toBe(false);

    // A refresh updates the rows in place, so a focused Stop keeps its focus.
    const stopSecond = rows()[1].querySelector(".node-run-stop");
    stopSecond.focus();
    workspace.render();
    await window.happyDOM.waitUntilComplete();
    expect(rows()[1].querySelector(".node-run-stop")).toBe(stopSecond);
    expect(window.document.activeElement).toBe(stopSecond);

    stopSecond.click();
    await vi.waitFor(() => expect(onStopInteraction).toHaveBeenCalledWith(10, 6));
    expect(onStopInteraction).toHaveBeenCalledTimes(1);

    // A settled run leaves the bar; the other run keeps its row.
    state.interactions[1] = run(5, "accepted");
    state.actionInvocations[0] = { ...state.actionInvocations[0], resultCompletionStatus: "accepted" };
    workspace.render();
    await window.happyDOM.waitUntilComplete();
    expect(rows().map((row) => row.dataset.interactionId)).toEqual(["6"]);
    expect(rows()[0].querySelector(".node-run-stop")).toBe(stopSecond);
  } finally {
    workspace.dispose();
    await window.happyDOM.close();
  }
});
