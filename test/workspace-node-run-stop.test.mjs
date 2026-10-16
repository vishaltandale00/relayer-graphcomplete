import { Window } from "happy-dom";
import { afterEach, expect, it, vi } from "vitest";
import { createProductWorkspace } from "../desktop/renderer/src/product-workspace/workspace.js";

afterEach(() => vi.unstubAllGlobals());

// Invoked runs run beside the message turns (#717): each run's Stop lives on the node it came
// from, and the composer stays a Send for the next message. Runs on one node run in order (#718).
// A queued run waits behind its node or for capacity (#720), and its Remove keeps its text (#721).
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
  const actions = [action(31, "Plan a week"), action(32, "List pitfalls"), action(33, "Find a mentor")];
  const layer = { layer: { id: 201, nodes: [21], state: "accepted" }, nodes: [node], edges: [], actions };
  const thread = { id: 10, title: "Learning plan", harnessId: "fixture" };
  const run = (id, completionStatus, queueReason) => ({ id, threadId: 10, sequence: id, text: "Invoked", completionStatus, queueReason });
  const state = {
    status: "accepted", currentInteractionId: 1, capabilities: { stopRuns: true },
    conversationCompatibility: { threadId: 10, status: "unrestricted", harnessId: "fixture" },
    interactions: [
      { id: 1, graphNodeId: 901, threadId: 10, sequence: 1, text: "Compare approaches", completionStatus: "accepted", completionOutput: { rootLayer: layer } },
      run(5, "running"),
      run(6, "queued", "node"),
      run(7, "queued", "node"),
    ],
    actionInvocations: [
      { sourceInteractionId: 1, actionId: 31, resultInteractionId: 5, resultCompletionStatus: "running", agentInvoked: false },
      { sourceInteractionId: 1, actionId: 32, resultInteractionId: 6, resultCompletionStatus: "queued", agentInvoked: false },
      { sourceInteractionId: 1, actionId: 33, resultInteractionId: 7, resultCompletionStatus: "queued", agentInvoked: false },
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
    expect(rows().map((row) => row.dataset.interactionId)).toEqual(["5", "6", "7"]);
    // Runs on one node run in order (#718): the later ones show queued, each with its own Remove.
    expect(rows().map((row) => row.querySelector(".node-run-status").textContent))
      .toEqual(["Plan a week · Running", "List pitfalls · Queued", "Find a mentor · Queued"]);
    expect(rows().map((row) => row.querySelector(".node-run-stop").textContent)).toEqual(["Stop", "Remove", "Remove"]);
    expect(rows()[2].querySelector(".node-run-stop").getAttribute("aria-label")).toBe("Remove Find a mentor");
    expect(rows()[2].querySelector(".node-run-stop").disabled).toBe(false);
    // The composer stays a Send while runs are active (#719).
    expect(window.document.querySelector("#sendInteraction").getAttribute("aria-label")).toBe("Send");

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
    rows()[2].querySelector(".node-run-stop").click();
    await vi.waitFor(() => expect(onStopInteraction).toHaveBeenCalledWith(10, 7));

    // A settled run leaves the bar, and the run behind it takes the node. Every slot under the
    // app's limit is taken, so it now waits for capacity, while the last still waits for the node.
    state.interactions[1] = run(5, "accepted");
    state.actionInvocations[0] = { ...state.actionInvocations[0], resultCompletionStatus: "accepted" };
    state.interactions[2] = run(6, "queued", "capacity");
    workspace.render();
    await window.happyDOM.waitUntilComplete();
    expect(rows().map((row) => row.dataset.interactionId)).toEqual(["6", "7"]);
    expect(rows()[0].querySelector(".node-run-stop")).toBe(stopSecond);
    expect(rows().map((row) => row.querySelector(".node-run-status").textContent))
      .toEqual(["List pitfalls · Waiting for capacity", "Find a mentor · Queued"]);
    expect(stopSecond.textContent).toBe("Remove");

    // A slot frees, and the run starts; the rows stay in place.
    state.interactions[2] = run(6, "running");
    state.actionInvocations[1] = { ...state.actionInvocations[1], resultCompletionStatus: "running" };
    workspace.render();
    await window.happyDOM.waitUntilComplete();
    expect(rows().map((row) => row.dataset.interactionId)).toEqual(["6", "7"]);
    expect(rows()[0].querySelector(".node-run-stop")).toBe(stopSecond);
    expect(rows().map((row) => row.querySelector(".node-run-status").textContent))
      .toEqual(["List pitfalls · Running", "Find a mentor · Queued"]);
    expect(stopSecond.textContent).toBe("Stop");

    // Messages run in parallel (#719): a message turn waiting for capacity (#720) leaves the
    // composer a Send. Read from an older turn, the pending notice says it waits for capacity.
    // Its pending entry was seeded as running; the run's own row says it waits for capacity.
    state.interactions.push({ ...run(8, "queued", "capacity"), text: "Also check the FAQ" });
    state.pendingTurn = { threadId: 10, interactionId: 8, status: "running" };
    workspace.render();
    await window.happyDOM.waitUntilComplete();
    const send = window.document.querySelector("#sendInteraction");
    expect(send.getAttribute("aria-label")).toBe("Send");
    expect(window.document.querySelector("#pendingTurnText").textContent).toContain("Waiting for capacity");
    const runStop = window.document.querySelector("#interactionRunStop");
    expect(runStop.classList.contains("hidden")).toBe(true);

    // Each message's status and Stop live on its own interaction node: viewed, the waiting
    // message offers Remove, and a running one offers Stop.
    state.currentInteractionId = 8;
    workspace.render();
    await window.happyDOM.waitUntilComplete();
    expect(runStop.classList.contains("hidden")).toBe(false);
    expect(runStop.textContent).toBe("Remove");
    // A double click stops once.
    runStop.click();
    runStop.click();
    await vi.waitFor(() => expect(onStopInteraction).toHaveBeenCalledWith(10, 8));
    expect(onStopInteraction.mock.calls.filter(([, id]) => id === 8)).toHaveLength(1);
    state.interactions.push({ ...run(9, "running"), text: "And the pricing page" });
    state.currentInteractionId = 9;
    workspace.render();
    await window.happyDOM.waitUntilComplete();
    expect(runStop.textContent).toBe("Stop");
    expect(runStop.getAttribute("aria-label")).toBe("Stop this run");
    expect(send.getAttribute("aria-label")).toBe("Send");
    // A Stop that fails says so in text beside the control, announced to assistive technology.
    onStopInteraction.mockRejectedValueOnce(new Error("Stop could not reach the run."));
    runStop.click();
    const runError = window.document.querySelector("#interactionRunError");
    await vi.waitFor(() => expect(runError.textContent).toBe("Stop could not reach the run."));
    expect(runError.classList.contains("hidden")).toBe(false);
    expect(runError.getAttribute("role")).toBe("status");
    expect(runStop.getAttribute("aria-describedby")).toBe("interactionRunError");

    // The thread menu stops every running run and removes every queued one (#721).
    onStopInteraction.mockClear();
    const stopAll = window.document.querySelector("#stopAllRuns");
    expect(stopAll.classList.contains("hidden")).toBe(false);
    expect(stopAll.textContent).toBe("Stop all runs (4)");
    stopAll.click();
    await vi.waitFor(() => expect(onStopInteraction).toHaveBeenCalledTimes(4));
    expect(onStopInteraction.mock.calls.map(([, id]) => id).sort()).toEqual([6, 7, 8, 9]);
  } finally {
    workspace.dispose();
    await window.happyDOM.close();
  }
});
