import { afterEach, describe, expect, it, vi } from "vitest";

async function loadGraphAdapter({ relayerDesktop, relayerEvalReview, review = false }) {
  vi.resetModules();
  vi.stubGlobal("window", { relayerDesktop, relayerEvalReview });
  vi.stubGlobal("location", new URL(`http://127.0.0.1:43123/?threadId=42${review ? "&review=1" : ""}`));

  let workspaceOptions;
  const workspace = {
    mode: review ? "review" : "interactive",
    render: vi.fn(),
    modelSelectionPayload: vi.fn(() => null),
  };
  vi.doMock("../desktop/renderer/src/product-workspace/index.js", () => ({
    createProductWorkspace: vi.fn((options) => {
      workspaceOptions = options;
      return workspace;
    }),
  }));
  vi.doMock("../desktop/renderer/src/navigation.js", () => ({
    setMainView: vi.fn(),
    setSettingsTab: vi.fn(),
  }));
  vi.doMock("../desktop/renderer/src/threads.js", () => ({
    getNavigationHistory: vi.fn(() => ({})),
    navigateHistory: vi.fn(),
    replaceCurrentSelection: vi.fn(),
    selectTurn: vi.fn(),
    selectTurnById: vi.fn(),
  }));
  vi.doMock("../desktop/renderer/src/ui.js", () => ({ toast: vi.fn() }));

  const state = await import("../desktop/renderer/src/state.js");
  state.appState.threads.push({ id: 42, title: "Debug conversation" });
  const graph = await import("../desktop/renderer/src/graph.js");
  graph.renderThread();
  return { workspace, workspaceOptions };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("graph adapter conversation export capability", () => {
  it("injects the ordinary Desktop preload export capability into the rendered workspace", async () => {
    const exportConversation = vi.fn(async (threadId) => ({ status: "saved", threadId }));
    const { workspace, workspaceOptions } = await loadGraphAdapter({
      relayerDesktop: { conversation: { export: exportConversation } },
      relayerEvalReview: undefined,
      review: false,
    });

    expect(workspace.render).toHaveBeenCalledOnce();
    expect(workspaceOptions.mode).toBe("interactive");
    await expect(workspaceOptions.onExportConversation(42)).resolves.toEqual({
      status: "saved",
      threadId: 42,
    });
    expect(exportConversation).toHaveBeenCalledWith(42);
  });

  it("renders Eval review without a Desktop preload or an export capability", async () => {
    const { workspace, workspaceOptions } = await loadGraphAdapter({
      relayerDesktop: undefined,
      relayerEvalReview: { context: vi.fn() },
      review: true,
    });

    expect(workspace.render).toHaveBeenCalledOnce();
    expect(workspaceOptions.mode).toBe("review");
    expect(workspaceOptions.onExportConversation).toBeNull();
  });
});
