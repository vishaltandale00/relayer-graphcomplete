import { beforeEach, describe, expect, it, vi } from "vitest";

let requestImplementation;
let rendered;
let renderObserver;
let throwOnRender;

function rootLayer(id, nodeId) {
  return {
    layer: { id },
    nodes: [{ id: nodeId, title: `Node ${nodeId}` }],
    edges: [],
    actions: [],
  };
}

function interaction(id, threadId, layer, sequence = 1) {
  return {
    id,
    threadId,
    sequence,
    text: `Turn ${id}`,
    completionStatus: "accepted",
    completionOutput: { rootLayer: layer },
  };
}

function productState(threads, interactions) {
  return {
    projects: [],
    threads,
    interactions,
    actionInvocations: [],
    capabilities: { canCompose: true },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function loadModules(url = "http://127.0.0.1:43123/") {
  vi.resetModules();
  rendered = 0;
  renderObserver = null;
  throwOnRender = null;
  Object.assign(globalThis, {
    document: { querySelector: () => null },
    location: new URL(url),
    window: { relayerDesktop: undefined, relayerEvalReview: undefined },
  });
  globalThis.history = {
    replaceState: vi.fn((_state, _title, nextUrl) => {
      globalThis.location = new URL(nextUrl);
    }),
  };
  vi.doMock("../desktop/renderer/src/api.js", () => ({
    request: (...args) => requestImplementation(...args),
  }));
  vi.doMock("../desktop/renderer/src/graph.js", () => ({
    renderThread: () => {
      rendered += 1;
      renderObserver?.();
      if (rendered === throwOnRender) throw new Error("injected render failure");
    },
  }));
  vi.doMock("../desktop/renderer/src/navigation.js", () => ({
    renderScopeMenu: vi.fn(),
    renderSidebar: vi.fn(),
    setMainView: vi.fn(),
  }));
  const state = await import("../desktop/renderer/src/state.js");
  const threads = await import("../desktop/renderer/src/threads.js");
  return { ...state, ...threads };
}

describe("workspace navigation integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("restores thread, turn, path, numeric node selection, and deep-link URL", async () => {
    const layer1 = rootLayer(101, 11);
    const layer2 = rootLayer(201, 21);
    const turn1 = interaction(1, 10, layer1);
    const turn2 = interaction(2, 20, layer2);
    const state1 = productState([{ id: 10, title: "First" }, { id: 20, title: "Second" }], [turn1]);
    const state2 = productState([{ id: 10, title: "First" }, { id: 20, title: "Second" }], [turn2]);
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) return state1;
      if (path.startsWith("/api/state?threadId=20")) return state2;
      if (path === "/api/threads/10") {
        return { thread: state1.threads[0], interactions: [turn1], actionInvocations: [] };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();

    await controller.loadThread(10);
    controller.replaceCurrentSelection(11);
    await controller.loadThread(20);
    await controller.navigateHistory(-1);

    expect(controller.viewState).toMatchObject({
      currentThreadId: 10,
      currentInteractionId: 1,
      selectedNodeId: "11",
    });
    expect(controller.viewState.layerPath.map(({ layerId }) => layerId)).toEqual([101]);
    expect(globalThis.location.searchParams.get("threadId")).toBe("10");
    expect(globalThis.location.searchParams.get("interactionId")).toBe("1");
    expect(controller.getNavigationHistory()).toMatchObject({
      canGoBack: false,
      canGoForward: true,
      pendingDirection: null,
    });
  });

  it("lets a newer turn choice cancel a slower history restoration", async () => {
    const layer1 = rootLayer(101, 11);
    const layer2 = rootLayer(201, 21);
    const turn1 = interaction(1, 10, layer1);
    const turn2a = interaction(2, 20, layer2, 1);
    const turn2b = interaction(3, 20, layer2, 2);
    const state1 = productState([{ id: 10, title: "First" }, { id: 20, title: "Second" }], [turn1]);
    const state2 = productState([{ id: 10, title: "First" }, { id: 20, title: "Second" }], [turn2a, turn2b]);
    const restore = deferred();
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) return state1;
      if (path.startsWith("/api/state?threadId=20")) return state2;
      if (path === "/api/threads/10") return restore.promise;
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();
    await controller.loadThread(10);
    await controller.loadThread(20);

    const pending = controller.navigateHistory(-1);
    await vi.waitFor(() => expect(controller.getNavigationHistory().pendingDirection).toBe("back"));
    controller.selectTurnById(2);
    expect(controller.getNavigationHistory().pendingDirection).toBeNull();
    restore.resolve({ thread: state1.threads[0], interactions: [turn1], actionInvocations: [] });

    await expect(pending).rejects.toMatchObject({ code: "navigation_superseded" });
    expect(controller.viewState).toMatchObject({ currentThreadId: 20, currentInteractionId: 2 });
  });

  it("cancels a pending restoration without re-rendering when the shell takes focus", async () => {
    const turn1 = interaction(1, 10, rootLayer(101, 11));
    const turn2 = interaction(2, 20, rootLayer(201, 21));
    const state1 = productState([{ id: 10, title: "First" }, { id: 20, title: "Second" }], [turn1]);
    const state2 = productState([{ id: 10, title: "First" }, { id: 20, title: "Second" }], [turn2]);
    const restore = deferred();
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) return state1;
      if (path.startsWith("/api/state?threadId=20")) return state2;
      if (path === "/api/threads/10") return restore.promise;
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();
    await controller.loadThread(10);
    await controller.loadThread(20);
    const pending = controller.navigateHistory(-1);
    await vi.waitFor(() => expect(controller.getNavigationHistory().pendingDirection).toBe("back"));
    const beforeCancelRenders = rendered;

    controller.cancelNavigationHistory();
    expect(rendered).toBe(beforeCancelRenders);
    restore.resolve({ thread: state1.threads[0], interactions: [turn1], actionInvocations: [] });

    await expect(pending).rejects.toMatchObject({ code: "navigation_superseded" });
    expect(rendered).toBe(beforeCancelRenders);
    expect(controller.viewState).toMatchObject({ currentThreadId: 20, currentInteractionId: 2 });
  });

  it("discards a stale poll that resolves after direct descendant navigation", async () => {
    const root = rootLayer(101, 11);
    root.actions = [{ id: 501, kind: "navigate", sourceNodeId: 11, targetLayerId: 102 }];
    const child = rootLayer(102, 12);
    const turn = interaction(1, 10, root);
    const state = productState([{ id: 10, title: "First" }], [turn]);
    const staleRefresh = deferred();
    let stateReads = 0;
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) {
        stateReads += 1;
        return stateReads === 1 ? state : staleRefresh.promise;
      }
      if (path.endsWith("/layers/102")) return child;
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();
    await controller.loadThread(10);
    const polling = controller.refreshState(10);
    await controller.navigateLayer(102, {
      action: root.actions[0],
      sourceNode: root.nodes[0],
    });
    staleRefresh.resolve(state);

    await expect(polling).resolves.toBe(false);
    expect(controller.appState.visibleLayer.layer.id).toBe(102);
    expect(controller.viewState.layerPath.map(({ layerId }) => layerId)).toEqual([101, 102]);
  });

  it("reuses a descendant loaded by direct navigation when Back restores it", async () => {
    const root = rootLayer(101, 11);
    root.actions = [{ id: 501, kind: "navigate", sourceNodeId: 11, targetLayerId: 102 }];
    const child = rootLayer(102, 12);
    const turn = interaction(1, 10, root);
    const state = productState([{ id: 10, title: "First" }], [turn]);
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) return state;
      if (path === "/api/threads/10") {
        return { thread: state.threads[0], interactions: [turn], actionInvocations: [] };
      }
      if (path.endsWith("/layers/102")) return child;
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();
    await controller.loadThread(10);
    await controller.navigateLayer(102, {
      action: root.actions[0],
      sourceNode: root.nodes[0],
    });
    await controller.navigateLayer(101, { restore: true, pathIndex: 0 });
    await controller.navigateHistory(-1);

    expect(controller.appState.visibleLayer.layer.id).toBe(102);
    expect(requestImplementation.mock.calls.filter(([path]) => path.endsWith("/layers/102")))
      .toHaveLength(1);
  });

  it("rolls back the presentation without advancing the cursor when application fails", async () => {
    const turn1 = interaction(1, 10, rootLayer(101, 11));
    const turn2 = interaction(2, 20, rootLayer(201, 21));
    const state1 = productState([{ id: 10, title: "First" }, { id: 20, title: "Second" }], [turn1]);
    const state2 = productState([{ id: 10, title: "First" }, { id: 20, title: "Second" }], [turn2]);
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) return state1;
      if (path.startsWith("/api/state?threadId=20")) return state2;
      if (path === "/api/threads/10") {
        return { thread: state1.threads[0], interactions: [turn1], actionInvocations: [] };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();
    await controller.loadThread(10);
    await controller.loadThread(20);
    throwOnRender = rendered + 2;

    await expect(controller.navigateHistory(-1)).rejects.toThrow("injected render failure");

    expect(controller.viewState).toMatchObject({ currentThreadId: 20, currentInteractionId: 2 });
    expect(controller.getNavigationHistory()).toMatchObject({
      canGoBack: true,
      canGoForward: false,
      pendingDirection: null,
    });
  });

  it("lets Back win over a source poll that was already in flight", async () => {
    const turn1 = interaction(1, 10, rootLayer(101, 11));
    const runningTurn = {
      id: 2,
      threadId: 20,
      sequence: 1,
      text: "Running turn",
      completionStatus: "running",
      completionOutput: null,
    };
    const acceptedTurn = interaction(2, 20, rootLayer(201, 21));
    const state1 = productState([{ id: 10, title: "First" }, { id: 20, title: "Second" }], [turn1]);
    const runningState = productState(state1.threads, [runningTurn]);
    const acceptedState = productState(state1.threads, [acceptedTurn]);
    const sourcePoll = deferred();
    const restore = deferred();
    let thread20Reads = 0;
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) return state1;
      if (path.startsWith("/api/state?threadId=20")) {
        thread20Reads += 1;
        return thread20Reads === 1 ? runningState : sourcePoll.promise;
      }
      if (path === "/api/threads/10") return restore.promise;
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();
    await controller.loadThread(10);
    await controller.loadThread(20);
    const polling = controller.refreshState(20);
    const pendingBack = controller.navigateHistory(-1);

    sourcePoll.resolve(acceptedState);
    await expect(polling).resolves.toBe(false);
    restore.resolve({ thread: state1.threads[0], interactions: [turn1], actionInvocations: [] });
    await expect(pendingBack).resolves.toMatchObject({ threadId: "10", turnId: "1" });
    expect(controller.viewState).toMatchObject({ currentThreadId: 10, currentInteractionId: 1 });
  });

  it("rejects an old layer response after a turn-away-and-back ABA sequence", async () => {
    const root = rootLayer(101, 11);
    root.actions = [{ id: 501, kind: "navigate", sourceNodeId: 11, targetLayerId: 102 }];
    const child = rootLayer(102, 12);
    const turn1 = interaction(1, 10, root, 1);
    const turn2 = interaction(2, 10, rootLayer(201, 21), 2);
    const state = productState([{ id: 10, title: "First" }], [turn1, turn2]);
    const layerRequest = deferred();
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) return state;
      if (path.endsWith("/layers/102")) return layerRequest.promise;
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules(
      "http://127.0.0.1:43123/?threadId=10&interactionId=1",
    );
    await controller.loadThread(10);
    controller.selectTurnById(1);
    const pendingLayer = controller.navigateLayer(102, {
      action: root.actions[0],
      sourceNode: root.nodes[0],
    });
    controller.selectTurnById(2);
    controller.selectTurnById(1);
    layerRequest.resolve(child);

    await expect(pendingLayer).resolves.toBeUndefined();
    expect(controller.viewState.currentInteractionId).toBe(1);
    expect(controller.appState.visibleLayer.layer.id).toBe(101);
    expect(controller.viewState.layerPath.map(({ layerId }) => layerId)).toEqual([101]);
  });

  it("keeps an explicit turn choice when an earlier scheduled poll resolves later", async () => {
    vi.useFakeTimers();
    try {
      const acceptedTurn = interaction(1, 10, rootLayer(101, 11), 1);
      const runningTurn = {
        id: 2,
        threadId: 10,
        sequence: 2,
        text: "Running turn",
        completionStatus: "running",
        completionOutput: null,
      };
      const threads = [{ id: 10, title: "First" }];
      const initialState = productState(threads, [acceptedTurn, runningTurn]);
      const staleState = productState(threads, [acceptedTurn]);
      const stalePoll = deferred();
      let stateReads = 0;
      requestImplementation = vi.fn(async (path) => {
        if (path.startsWith("/api/state?threadId=10")) {
          stateReads += 1;
          if (stateReads === 1) return initialState;
          if (stateReads === 2) return stalePoll.promise;
          return initialState;
        }
        throw new Error(`Unexpected request: ${path}`);
      });
      const controller = await loadModules();
      await controller.loadThread(10);
      let timersDuringExplicitRender;
      renderObserver = () => {
        timersDuringExplicitRender = vi.getTimerCount();
      };
      controller.selectTurnById(1);
      renderObserver = null;
      expect(timersDuringExplicitRender).toBe(0);

      await vi.advanceTimersByTimeAsync(500);
      expect(stateReads).toBe(2);

      controller.selectTurnById(2);
      stalePoll.resolve(staleState);
      await vi.advanceTimersByTimeAsync(0);

      expect(controller.viewState).toMatchObject({
        currentThreadId: 10,
        currentInteractionId: 2,
      });
      await vi.advanceTimersByTimeAsync(499);
      expect(stateReads).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(stateReads).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes pending polling after descendant navigation supersedes an in-flight poll", async () => {
    vi.useFakeTimers();
    try {
      const root = rootLayer(101, 11);
      root.actions = [{ id: 501, kind: "navigate", sourceNodeId: 11, targetLayerId: 102 }];
      const child = rootLayer(102, 12);
      const runningTurn = {
        id: 1,
        threadId: 10,
        sequence: 1,
        text: "Running turn",
        completionStatus: "running",
        completionOutput: null,
      };
      const acceptedTurn = interaction(2, 10, root, 2);
      const threads = [{ id: 10, title: "First" }];
      const state = productState(threads, [runningTurn, acceptedTurn]);
      const stalePoll = deferred();
      const layerRequest = deferred();
      let stateReads = 0;
      requestImplementation = vi.fn(async (path) => {
        if (path.startsWith("/api/state?threadId=10")) {
          stateReads += 1;
          if (stateReads === 2) return stalePoll.promise;
          return state;
        }
        if (path.endsWith("/layers/102")) return layerRequest.promise;
        throw new Error(`Unexpected request: ${path}`);
      });
      const controller = await loadModules();
      await controller.loadThread(10);
      await vi.advanceTimersByTimeAsync(500);
      expect(stateReads).toBe(2);

      const pendingLayer = controller.navigateLayer(102, {
        action: root.actions[0],
        sourceNode: root.nodes[0],
      });
      layerRequest.resolve(child);
      await pendingLayer;
      stalePoll.resolve(state);
      await vi.advanceTimersByTimeAsync(0);

      expect(controller.appState.visibleLayer.layer.id).toBe(102);
      expect(controller.viewState.layerPath.map(({ layerId }) => layerId)).toEqual([101, 102]);
      await vi.advanceTimersByTimeAsync(499);
      expect(stateReads).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(stateReads).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restart source polling from a stale overlapping history transition", async () => {
    vi.useFakeTimers();
    try {
      const turn1 = interaction(1, 10, rootLayer(101, 11));
      const turn2 = interaction(2, 20, rootLayer(201, 21));
      const runningTurn = {
        id: 3,
        threadId: 30,
        sequence: 1,
        text: "Running turn",
        completionStatus: "running",
        completionOutput: null,
      };
      const threads = [
        { id: 10, title: "First" },
        { id: 20, title: "Second" },
        { id: 30, title: "Third" },
      ];
      const states = new Map([
        ["10", productState(threads, [turn1])],
        ["20", productState(threads, [turn2])],
        ["30", productState(threads, [runningTurn])],
      ]);
      const restoreFirst = deferred();
      const restoreSecond = deferred();
      requestImplementation = vi.fn(async (path) => {
        const stateMatch = path.match(/^\/api\/state\?threadId=(\d+)$/);
        if (stateMatch) return states.get(stateMatch[1]);
        if (path === "/api/threads/10") return restoreFirst.promise;
        if (path === "/api/threads/20") return restoreSecond.promise;
        throw new Error(`Unexpected request: ${path}`);
      });
      const controller = await loadModules();
      await controller.loadThread(10);
      await controller.loadThread(20);
      await controller.loadThread(30);

      const stale = controller.navigateHistory(-1);
      const latest = controller.navigateHistory(-2);
      restoreSecond.resolve({ thread: threads[1], interactions: [turn2], actionInvocations: [] });
      await expect(stale).rejects.toMatchObject({ code: "navigation_superseded" });
      await vi.advanceTimersByTimeAsync(600);
      expect(requestImplementation.mock.calls.filter(([path]) => path === "/api/state?threadId=30"))
        .toHaveLength(1);
      restoreFirst.resolve({ thread: threads[0], interactions: [turn1], actionInvocations: [] });

      await expect(latest).resolves.toMatchObject({ threadId: "10", turnId: "1" });
      expect(controller.viewState.currentThreadId).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });
});
