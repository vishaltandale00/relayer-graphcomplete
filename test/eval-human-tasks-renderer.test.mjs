import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import { expect, it, vi } from "vitest";
import { initializeHumanTasks } from "../desktop/eval-renderer/human-tasks.js";
import { defaultActorSetup } from "../desktop/eval-main/setup-registry.mjs";

it("keeps live work visible, collapses older sessions without deleting them, and reopens their graph review", async () => {
  const window = new Window();
  window.document.documentElement.innerHTML = await readFile(new URL("../desktop/eval-renderer/index.html", import.meta.url), "utf8");
  vi.stubGlobal("window", window); vi.stubGlobal("document", window.document);
  const timer = vi.spyOn(globalThis, "setInterval").mockReturnValue(0);
  try {
    const sessions = ["failed", "interrupted", "completed", "completed", "active", "preparing", "finishing"].map((status, index) => ({
      id: `task-${index}`, testCaseId: index === 2 ? "other-case" : "trip", name: `Saved ${index}`, status, mode: "human", completions: 1, maxCompletions: 3,
      threadIds: [index + 1], step: 0, endpoint: "A reviewed artifact", events: [], annotations: [],
      prepared: { name: `Saved ${index}`, plan: [{ name: "Step", prompts: ["Help me"] }] },
    }));
    const original = structuredClone(sessions);
    const api = { catalog: async () => ({ cases: [{ id: "trip", name: "Trip", description: "Plan a trip" }], harnessConfigurations: [{ name: "fixture", available: true }] }),
      setupRevisions: async () => ({ promotions: [], revisions: [{ ...defaultActorSetup(), id: "actor" }] }),
      calibrationCatalog: async () => ({ sets: [], comparisons: [] }), listRuns: async () => [],
      humanTasks: async () => structuredClone(sessions), humanTask: async id => structuredClone(sessions.find(item => item.id === id)),
      openHumanTask: vi.fn(),
    };
    const toast = vi.fn(); initializeHumanTasks({ api, show: () => {}, toast });
    const document = window.document;
    const ids = selector => [...document.querySelectorAll(`${selector} [data-human-session]`)].map(button => button.dataset.humanSession);
    document.querySelector("#humanGrader").click();
    await vi.waitFor(() => expect(ids("#humanSessions")).toEqual(["task-4", "task-5", "task-6"]));
    expect(ids("#humanHistorySessions")).toEqual(["task-0", "task-1", "task-2", "task-3"]);
    expect(document.querySelector("#humanHistory").open).toBe(false);
    expect(document.querySelector("#humanTools").open).toBe(false);
    document.querySelector('[name="maxCompletions"]').dispatchEvent(new window.Event("invalid"));
    expect(document.querySelector("#humanAdvanced").open).toBe(true);
    document.querySelector("#humanHistory").open = true;
    document.querySelector('[data-human-session="task-1"]').click();
    await vi.waitFor(() => expect(document.querySelector("#humanOpen")?.textContent).toContain("Open graph review"));
    document.querySelector("#humanOpen").click();
    expect(api.openHumanTask).toHaveBeenCalledWith("task-1", true);
    expect(sessions).toEqual(original);
    sessions.splice(4);
    document.querySelector("#humanGrader").click();
    await vi.waitFor(() => expect(ids("#humanSessions")).toEqual(["task-3"]));
    expect(ids("#humanHistorySessions")).toEqual(["task-0", "task-1", "task-2"]);
    expect(toast).not.toHaveBeenCalled();
  } finally { timer.mockRestore(); vi.unstubAllGlobals(); await window.happyDOM.close(); }
});
