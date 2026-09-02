import { afterEach, describe, expect, it, vi } from "vitest";

async function loadGraphAdapter() {
  vi.resetModules();
  vi.stubGlobal("window", { relayerDesktop: {}, relayerEvalReview: undefined });
  vi.stubGlobal("location", new URL("http://127.0.0.1:43123/?threadId=7&interactionId=11"));

  let workspaceOptions;
  vi.doMock("../desktop/renderer/src/product-workspace/index.js", () => ({
    createProductWorkspace: vi.fn((options) => {
      workspaceOptions = options;
      return {
        mode: "interactive",
        render: vi.fn(),
        modelSelectionPayload: vi.fn(() => null),
      };
    }),
  }));
  vi.doMock("../desktop/renderer/src/navigation.js", () => ({
    setMainView: vi.fn(),
    setSettingsTab: vi.fn(),
  }));
  const replaceCurrentSelection = vi.fn();
  vi.doMock("../desktop/renderer/src/threads.js", () => ({
    getNavigationHistory: vi.fn(() => ({})),
    navigateHistory: vi.fn(),
    replaceCurrentSelection,
    selectTurn: vi.fn(),
    selectTurnById: vi.fn(),
  }));
  vi.doMock("../desktop/renderer/src/ui.js", () => ({ toast: vi.fn() }));
  const tutorialController = { nodeSelected: vi.fn(), syncWorkspace: vi.fn() };
  vi.doMock("../desktop/renderer/src/onboarding-tutorial.js", () => ({
    onboardingTutorialController: () => tutorialController,
  }));

  const graph = await import("../desktop/renderer/src/graph.js");
  graph.renderThread();
  return { replaceCurrentSelection, tutorialController, workspaceOptions };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("onboarding tutorial graph wiring", () => {
  it("forwards every inspector selection outcome to the tutorial state machine", async () => {
    const cases = [
      ["inspector close", null],
      ["selection change", "node-1"],
    ];
    expect(cases, "selection outcome inventory").toHaveLength(2);

    for (const [label, nodeId] of cases) {
      const { replaceCurrentSelection, tutorialController, workspaceOptions } = await loadGraphAdapter();

      workspaceOptions.onSelectionChange(nodeId);

      expect(replaceCurrentSelection, `${label}: current selection replaced`).toHaveBeenCalledWith(nodeId);
      expect(tutorialController.nodeSelected, `${label}: tutorial notified`).toHaveBeenCalledWith({
        threadId: "7",
        interactionId: "11",
        nodeId,
      });
    }
  });
});
