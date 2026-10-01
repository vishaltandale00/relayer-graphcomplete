import { Window } from "happy-dom";
import { expect, it, vi } from "vitest";
import { initializeHumanTaskGrading } from "../desktop/renderer/src/human-task-grading.js";

it("review refresh exposes the new task step without carrying the old graph selection or discarding feedback", async () => {
  const window = new Window({ url: "http://localhost/?threadId=7&interactionId=71&layerId=3&nodeId=4&review=1#capability" });
  vi.stubGlobal("window", window); vi.stubGlobal("document", window.document); vi.stubGlobal("Option", window.Option);
  try {
    let currentThreadId = 7;
    initializeHumanTaskGrading({ task: async () => ({ mode: "simulated", status: "active", workspaceGrading: 2, currentThreadId, events: [], annotations: [] }) });
    const panel = window.document.querySelector("#humanTaskGrading");
    panel.open = true; panel.dispatchEvent(new window.Event("toggle"));
    await vi.waitFor(() => expect(panel.querySelector('[name="comment"]')).not.toBeNull());
    const draft = panel.querySelector('[name="comment"]'); draft.value = "Still reviewing this graph";
    expect(panel.querySelector("[data-current-step]").hidden).toBe(true);
    currentThreadId = 8;
    panel.querySelector("[data-grade-refresh]").click();
    await vi.waitFor(() => expect(panel.querySelector("[data-current-step]").hidden).toBe(false));
    const link = new URL(panel.querySelector("[data-current-step]").href);
    expect(link.searchParams.get("threadId")).toBe("8");
    expect(["interactionId", "layerId", "nodeId"].some(key => link.searchParams.has(key))).toBe(false);
    expect(link.hash).toBe("#capability");
    expect(panel.querySelector('[name="comment"]').value).toBe("Still reviewing this graph");
  } finally { vi.unstubAllGlobals(); await window.happyDOM.close(); }
});
