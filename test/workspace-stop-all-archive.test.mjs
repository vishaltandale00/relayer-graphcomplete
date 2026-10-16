import { Window } from "happy-dom";
import { afterEach, expect, it, vi } from "vitest";
import { createProductWorkspace } from "../desktop/renderer/src/product-workspace/workspace.js";

afterEach(() => vi.unstubAllGlobals());

// ARC-002 with parallel runs (#719, #721): active runs block archive, so the thread menu greys
// Archive and offers "Stop all and archive". It stops every run, then archives once the app
// server reports no active work.
it("stops every run from the thread menu and archives once they have stopped", async () => {
  const window = new Window({ url: "http://127.0.0.1:3000" });
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("lucide", new Proxy({ createElement: () => window.document.createElement("svg") }, { get: (t, k) => t[k] ?? {} }));
  window.document.body.innerHTML = '<section id="threadView"></section>';
  const layer = { layer: { id: 201, nodes: [], state: "accepted" }, nodes: [], edges: [], actions: [] };
  const thread = { id: 10, title: "Busy chat", harnessId: "fixture", activity: "running", archiveBlocked: true };
  const message = (id, completionStatus, extra = {}) => ({ id, threadId: 10, sequence: id, text: `Message ${id}`, completionStatus, ...extra });
  const state = {
    status: "running", currentInteractionId: 3, capabilities: { stopRuns: true },
    conversationCompatibility: { threadId: 10, status: "unrestricted", harnessId: "fixture" },
    interactions: [
      message(1, "accepted", { graphNodeId: 901, completionOutput: { rootLayer: layer } }),
      message(2, "running"),
      message(3, "running"),
      message(4, "queued", { queueReason: "capacity" }),
      // An agent's child is never the product's to stop.
      message(5, "running"),
    ],
    actionInvocations: [{ sourceInteractionId: 1, actionId: 31, resultInteractionId: 5, resultCompletionStatus: "running", agentInvoked: true }],
    visibleLayer: layer, nodes: [], actions: [], projects: [], permissionProfiles: [],
    modelSettings: { defaults: { harnessId: "fixture" }, harnesses: [{ id: "fixture", available: true }], providers: [], families: [] },
    modelCatalog: [], pendingActionInvocations: [],
  };
  const stopped = [];
  const onStopInteraction = vi.fn(async (_threadId, id) => { stopped.push(id); });
  // The app server refuses archive while runs are still stopping, then accepts it.
  let archiveCalls = 0;
  const onArchiveThread = vi.fn(async () => {
    archiveCalls += 1;
    if (archiveCalls === 1) throw Object.assign(new Error("Available when work finishes."), { code: "thread_archive_busy" });
    return { ...thread, archivedAt: "now" };
  });
  const selection = { currentThreadId: 10, currentInteractionId: 3, selectedNodeId: null, layerPath: [] };
  const workspace = createProductWorkspace({
    root: window.document, getState: () => state, getThread: () => thread, selection,
    onStopInteraction, onArchiveThread, mode: "interactive", showThread() {}, showEmpty() {},
  });
  try {
    workspace.render();
    await window.happyDOM.waitUntilComplete();
    const archive = window.document.querySelector("#archiveConversation");
    const stopAll = window.document.querySelector("#stopAllRuns");
    const stopAllAndArchive = window.document.querySelector("#stopAllAndArchive");
    expect(archive.disabled).toBe(true);
    expect(stopAll.textContent).toBe("Stop all runs (3)");
    expect(stopAllAndArchive.classList.contains("hidden")).toBe(false);
    expect(stopAllAndArchive.disabled).toBe(false);

    stopAllAndArchive.click();
    await vi.waitFor(() => expect(stopped.sort()).toEqual([2, 3, 4]));
    expect(stopAllAndArchive.disabled).toBe(true);
    expect(stopAllAndArchive.textContent).toBe("Archiving once runs stop…");
    await vi.waitFor(() => expect(onArchiveThread).toHaveBeenCalledTimes(2), { timeout: 3_000 });
    expect(onArchiveThread).toHaveBeenLastCalledWith(10, true);
    expect(onStopInteraction).not.toHaveBeenCalledWith(10, 5);

    // With nothing active, the menu offers plain Archive again.
    for (const id of [2, 3, 4]) state.interactions[id - 1] = message(id, "stopped");
    Object.assign(thread, { activity: null, archiveBlocked: false });
    workspace.render();
    await window.happyDOM.waitUntilComplete();
    expect(stopAll.classList.contains("hidden")).toBe(true);
    expect(stopAllAndArchive.classList.contains("hidden")).toBe(true);
    expect(archive.disabled).toBe(false);
  } finally {
    workspace.dispose();
    await window.happyDOM.close();
  }
});
