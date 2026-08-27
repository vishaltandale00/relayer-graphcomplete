import { beforeEach, describe, expect, it, vi } from "vitest";

let requestImplementation;
let rendered;
let renderObserver;
let throwOnRender;
let tutorialActionSucceeded;
let tutorialFollowupSubmitted;

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
  tutorialActionSucceeded = vi.fn();
  tutorialFollowupSubmitted = vi.fn();
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
  vi.doMock("../desktop/renderer/src/onboarding-tutorial.js", () => ({
    onboardingTutorialController: () => ({
      actionSucceeded: tutorialActionSucceeded,
      followupSubmitted: tutorialFollowupSubmitted,
      threadCreated: vi.fn(),
    }),
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
      forwardChangesTurn: true,
      pendingDirection: null,
    });
  });

  it("waits for tutorial completion persistence before refreshing to the submitted follow-up", async () => {
    const root = rootLayer(101, 11);
    const source = interaction(1, 10, root);
    const followup = {
      id: 2,
      threadId: 10,
      sequence: 2,
      text: "A follow-up",
      completionStatus: "submitted",
    };
    const beforeSubmit = productState([{ id: 10, title: "Tutorial" }], [source]);
    const afterSubmit = productState([{ id: 10, title: "Tutorial" }], [source, followup]);
    const completionPersistence = deferred();
    let submitted = false;
    let stateReads = 0;
    requestImplementation = vi.fn(async (path, options) => {
      if (path.startsWith("/api/state?threadId=10")) {
        stateReads += 1;
        return submitted ? afterSubmit : beforeSubmit;
      }
      if (path === "/api/threads/10/interactions") {
        expect(options.method).toBe("POST");
        expect(JSON.parse(options.body)).toEqual({
          text: "A follow-up",
          inputId: expect.any(String),
          contexts: [],
          contextConfirmationIds: [],
          modelSelection: { providerId: "openai", modelId: "gpt-5" },
        });
        submitted = true;
        return followup;
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();
    await controller.loadThread(10);
    tutorialFollowupSubmitted = vi.fn(() => completionPersistence.promise);

    const submitting = controller.submitInteraction(
      "A follow-up",
      { providerId: "openai", modelId: "gpt-5" },
    );
    await vi.waitFor(() => expect(tutorialFollowupSubmitted).toHaveBeenCalledOnce());

    expect(tutorialFollowupSubmitted).toHaveBeenCalledWith({ threadId: 10, interactionId: 2 });
    expect(stateReads).toBe(1);
    expect(controller.viewState.currentInteractionId).toBe(1);

    completionPersistence.resolve(true);
    await expect(submitting).resolves.toEqual(followup);
    expect(stateReads).toBe(2);
    expect(controller.viewState.currentInteractionId).toBe(2);
  });

  it("submits annotation-only context with stable occurrence identity", async () => {
    const source = { ...interaction(1, 10, rootLayer(101, 11)), graphNodeId: 31 };
    const followup = {
      id: 2,
      threadId: 10,
      sequence: 2,
      text: "",
      completionStatus: "submitted",
    };
    const beforeSubmit = productState([{ id: 10, title: "Context" }], [source]);
    const afterSubmit = productState([{ id: 10, title: "Context" }], [source, followup]);
    let submitted = false;
    const contexts = [{
      target: { nodeId: 11, sourceInteractionNodeId: 31, sourceLayerId: 101 },
      annotations: ["Use this node"],
    }];
    requestImplementation = vi.fn(async (path, options) => {
      if (path.startsWith("/api/state?threadId=10")) return submitted ? afterSubmit : beforeSubmit;
      if (path === "/api/threads/10/interactions") {
        expect(options.method).toBe("POST");
        expect(JSON.parse(options.body)).toEqual({
          text: "",
          inputId: expect.any(String),
          contexts,
          contextConfirmationIds: [],
          modelSelection: { providerId: "openai", modelId: "gpt-5" },
        });
        submitted = true;
        return followup;
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();
    await controller.loadThread(10);

    await expect(controller.submitInteraction(
      "",
      { providerId: "openai", modelId: "gpt-5" },
      contexts,
    )).resolves.toEqual(followup);
    expect(controller.viewState.currentInteractionId).toBe(2);
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

    const beforeCommit = vi.fn();
    const pending = controller.navigateHistory(-1, { beforeCommit });
    await vi.waitFor(() => expect(controller.getNavigationHistory().pendingDirection).toBe("back"));
    controller.selectTurnById(2);
    expect(controller.getNavigationHistory().pendingDirection).toBeNull();
    restore.resolve({ thread: state1.threads[0], interactions: [turn1], actionInvocations: [] });

    await expect(pending).rejects.toMatchObject({ code: "navigation_superseded" });
    expect(beforeCommit).not.toHaveBeenCalled();
    expect(controller.viewState).toMatchObject({ currentThreadId: 20, currentInteractionId: 2 });
  });

  it("opens a resolved invoke across threads at its root and delegates Back to workspace history", async () => {
    const sourceLayer = rootLayer(101, 11);
    const action = { id: 501, kind: "invoke", sourceNodeId: 11, targetLayerId: 201 };
    sourceLayer.actions = [action];
    const destinationLayer = rootLayer(201, 21);
    const source = interaction(1, 10, sourceLayer);
    const destination = interaction(2, 20, destinationLayer);
    const sourceState = productState([{ id: 10, title: "Source" }, { id: 20, title: "Result" }], [source]);
    const runningInvocation = {
      sourceInteractionId: 1,
      actionId: 501,
      resultInteractionId: 2,
      resultCompletionStatus: "running",
    };
    const acceptedInvocation = {
      ...runningInvocation,
      resultCompletionStatus: "accepted",
    };
    sourceState.actionInvocations = [runningInvocation];
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) return sourceState;
      if (path === "/api/threads/10/interactions/1/actions/501/destination") {
        return {
          actionId: 501,
          actionKind: "invoke",
          targetLayerId: 201,
          threadId: 20,
          interactionId: 2,
          rootLayerId: 201,
        };
      }
      if (path === "/api/threads/20") {
        return {
          thread: { id: 20, title: "Result" },
          interactions: [destination],
          actionInvocations: [acceptedInvocation],
        };
      }
      if (path === "/api/threads/10") {
        return {
          thread: { id: 10, title: "Source" },
          interactions: [source],
          actionInvocations: [acceptedInvocation],
        };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();
    await controller.loadThread(10);
    const beforeInvokeCommit = vi.fn();

    await expect(controller.navigateResolvedInvoke(action, {
      beforeCommit: beforeInvokeCommit,
    })).resolves.toBe(true);
    expect(beforeInvokeCommit).toHaveBeenCalledOnce();
    expect(controller.viewState).toMatchObject({
      currentThreadId: 20,
      currentInteractionId: 2,
      selectedNodeId: null,
    });
    expect(controller.viewState.layerPath.map(({ layerId }) => layerId)).toEqual([201]);
    expect(controller.getNavigationHistory().canGoBack).toBe(true);
    expect(controller.appState.actionInvocations).toEqual([acceptedInvocation]);

    const beforeHistoryCommit = vi.fn();
    await controller.navigateHistory("back", { beforeCommit: beforeHistoryCommit });
    expect(beforeHistoryCommit).toHaveBeenCalledOnce();
    expect(controller.viewState).toMatchObject({ currentThreadId: 10, currentInteractionId: 1 });
    expect(controller.viewState.layerPath.map(({ layerId }) => layerId)).toEqual([101]);
    expect(controller.appState.actionInvocations).toEqual([acceptedInvocation]);

    await controller.navigateHistory("forward");
    expect(controller.viewState).toMatchObject({ currentThreadId: 20, currentInteractionId: 2 });
    expect(controller.appState.actionInvocations).toEqual([acceptedInvocation]);

    await controller.navigateHistory("back");
    await controller.navigateHistory("forward");
    expect(controller.viewState).toMatchObject({ currentThreadId: 20, currentInteractionId: 2 });
    expect(controller.appState.actionInvocations).toHaveLength(1);
    expect(controller.appState.actionInvocations[0].resultCompletionStatus).toBe("accepted");
  });

  it("does not apply a resolved invoke destination after a newer thread selection wins", async () => {
    const sourceLayer = rootLayer(101, 11);
    const action = { id: 501, kind: "invoke", sourceNodeId: 11, targetLayerId: 201 };
    sourceLayer.actions = [action];
    const source = interaction(1, 10, sourceLayer);
    const other = interaction(3, 30, rootLayer(301, 31));
    const destinationRead = deferred();
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) {
        return productState([{ id: 10, title: "Source" }, { id: 30, title: "Other" }], [source]);
      }
      if (path.startsWith("/api/state?threadId=30")) {
        return productState([{ id: 10, title: "Source" }, { id: 30, title: "Other" }], [other]);
      }
      if (path.endsWith("/actions/501/destination")) return destinationRead.promise;
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();
    await controller.loadThread(10);
    const pending = controller.navigateResolvedInvoke(action);
    await controller.loadThread(30);
    destinationRead.resolve({
      actionId: 501,
      actionKind: "invoke",
      targetLayerId: 201,
      threadId: 20,
      interactionId: 2,
      rootLayerId: 201,
    });

    await expect(pending).resolves.toBe(false);
    expect(controller.viewState).toMatchObject({ currentThreadId: 30, currentInteractionId: 3 });
  });

  it("does not apply a resolved invoke destination after a newer node selection wins", async () => {
    const sourceLayer = rootLayer(101, 11);
    sourceLayer.nodes.push({ id: 12, title: "Node 12" });
    const action = { id: 501, kind: "invoke", sourceNodeId: 11, targetLayerId: 201 };
    sourceLayer.actions = [action];
    const source = interaction(1, 10, sourceLayer);
    const destination = interaction(2, 20, rootLayer(201, 21));
    const destinationRead = deferred();
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) {
        return productState([{ id: 10, title: "Source" }, { id: 20, title: "Result" }], [source]);
      }
      if (path.endsWith("/actions/501/destination")) return destinationRead.promise;
      if (path === "/api/threads/20") {
        return {
          thread: { id: 20, title: "Result" },
          interactions: [destination],
          actionInvocations: [],
        };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();
    await controller.loadThread(10);
    controller.replaceCurrentSelection(11);
    const beforeCommit = vi.fn();

    const pending = controller.navigateResolvedInvoke(action, { beforeCommit });
    expect(controller.getNavigationHistory().pendingResolvedInvokeNavigation).toBe(true);
    controller.replaceCurrentSelection(12);
    expect(controller.getNavigationHistory().pendingResolvedInvokeNavigation).toBe(false);
    destinationRead.resolve({
      actionId: 501,
      actionKind: "invoke",
      targetLayerId: 201,
      threadId: 20,
      interactionId: 2,
      rootLayerId: 201,
    });

    await expect(pending).resolves.toBe(false);
    expect(beforeCommit).not.toHaveBeenCalled();
    expect(controller.viewState).toMatchObject({
      currentThreadId: 10,
      currentInteractionId: 1,
      selectedNodeId: 12,
    });
    expect(requestImplementation).not.toHaveBeenCalledWith("/api/threads/20");
  });

  it("lets a newer Back intent cancel a pending resolved invoke navigation", async () => {
    const previous = interaction(1, 5, rootLayer(51, 6));
    const sourceLayer = rootLayer(101, 11);
    const action = { id: 501, kind: "invoke", sourceNodeId: 11, targetLayerId: 201 };
    sourceLayer.actions = [action];
    const source = interaction(2, 10, sourceLayer);
    const threads = [{ id: 5, title: "Previous" }, { id: 10, title: "Source" }];
    const destinationRead = deferred();
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=5")) return productState(threads, [previous]);
      if (path.startsWith("/api/state?threadId=10")) return productState(threads, [source]);
      if (path.endsWith("/actions/501/destination")) return destinationRead.promise;
      if (path === "/api/threads/5") {
        return { thread: threads[0], interactions: [previous], actionInvocations: [] };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();
    await controller.loadThread(5);
    await controller.loadThread(10);

    const pendingInvoke = controller.navigateResolvedInvoke(action);
    expect(controller.getNavigationHistory().pendingResolvedInvokeNavigation).toBe(true);
    const pendingBack = controller.navigateHistory("back");
    await expect(pendingBack).resolves.toMatchObject({ threadId: "5", turnId: "1" });
    destinationRead.resolve({
      actionId: 501,
      actionKind: "invoke",
      targetLayerId: 201,
      threadId: 20,
      interactionId: 3,
      rootLayerId: 201,
    });

    await expect(pendingInvoke).resolves.toBe(false);
    expect(controller.getNavigationHistory().pendingResolvedInvokeNavigation).toBe(false);
    expect(controller.viewState).toMatchObject({ currentThreadId: 5, currentInteractionId: 1 });
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

  it("refreshes an already-open nested invoke when a project-visible lease resolves", async () => {
    const root = rootLayer(101, 11);
    root.actions = [{ id: 501, kind: "navigate", sourceNodeId: 11, targetLayerId: 102 }];
    const staleChild = rootLayer(102, 12);
    staleChild.actions = [{ id: 777, kind: "invoke", sourceNodeId: 12, targetLayerId: null }];
    const canonicalChild = rootLayer(102, 12);
    canonicalChild.actions = [{ id: 777, kind: "invoke", sourceNodeId: 12, targetLayerId: 303 }];
    const turn = interaction(1, 10, root);
    const initial = productState([{ id: 10, title: "Source" }], [turn]);
    const resolved = productState([{ id: 10, title: "Source" }], [turn]);
    resolved.actionInvocations = [{
      sourceInteractionId: 99,
      actionId: 777,
      resultInteractionId: 100,
    }];
    let stateReads = 0;
    let layerReads = 0;
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) {
        stateReads += 1;
        return stateReads === 1 ? initial : resolved;
      }
      if (path.endsWith("/layers/102")) {
        layerReads += 1;
        return layerReads === 1 ? staleChild : canonicalChild;
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();
    await controller.loadThread(10);
    await controller.navigateLayer(102, {
      action: root.actions[0],
      sourceNode: root.nodes[0],
    });
    expect(controller.appState.visibleLayer.actions[0].targetLayerId).toBeNull();

    await controller.refreshState(10);

    expect(controller.appState.visibleLayer.actions[0]).toMatchObject({
      id: 777,
      kind: "invoke",
      targetLayerId: 303,
    });
    expect(layerReads).toBe(2);
  });

  it("keeps polling an open reused source while its project-visible invoke runs elsewhere", async () => {
    vi.useFakeTimers();
    try {
      const staleRoot = rootLayer(101, 11);
      staleRoot.actions = [{ id: 777, kind: "invoke", sourceNodeId: 11, targetLayerId: null }];
      const resolvedRoot = rootLayer(101, 11);
      resolvedRoot.actions = [{ id: 777, kind: "invoke", sourceNodeId: 11, targetLayerId: 303 }];
      const source = interaction(1, 10, staleRoot);
      const running = productState([{ id: 10, title: "Reused source" }], [source]);
      running.actionInvocations = [{
        sourceInteractionId: 99,
        actionId: 777,
        resultInteractionId: 100,
        resultCompletionStatus: "running",
      }];
      const resolved = productState([{ id: 10, title: "Reused source" }], [source]);
      resolved.actionInvocations = [{
        ...running.actionInvocations[0],
        resultCompletionStatus: "accepted",
      }];
      let stateReads = 0;
      let layerReads = 0;
      requestImplementation = vi.fn(async (path) => {
        if (path.startsWith("/api/state?threadId=10")) {
          stateReads += 1;
          return stateReads === 1 ? running : resolved;
        }
        if (path.endsWith("/layers/101")) {
          layerReads += 1;
          return layerReads === 1 ? staleRoot : resolvedRoot;
        }
        throw new Error(`Unexpected request: ${path}`);
      });
      const controller = await loadModules();

      await controller.loadThread(10);
      expect(controller.appState.interactions).toHaveLength(1);
      expect(controller.appState.interactions[0].id).toBe(1);
      expect(controller.appState.visibleLayer.actions[0].targetLayerId).toBeNull();

      await vi.advanceTimersByTimeAsync(500);

      expect(controller.appState.visibleLayer.actions[0]).toMatchObject({
        id: 777,
        kind: "invoke",
        targetLayerId: 303,
      });
      expect(controller.appState.actionInvocations[0].resultCompletionStatus).toBe("accepted");
      expect(stateReads).toBe(2);
      expect(layerReads).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries an imported thread until its server projection is fresh", async () => {
    vi.useFakeTimers();
    try {
      const turn = interaction(1, 10, rootLayer(101, 11));
      const staleTurn = { ...turn, projectionFresh: false };
      const freshTurn = { ...turn, projectionFresh: true };
      const threads = [{ id: 10, title: "Imported review", imported: true }];
      const stale = productState(threads, [staleTurn]);
      const fresh = productState(threads, [freshTurn]);
      let stateReads = 0;
      requestImplementation = vi.fn(async (path) => {
        if (path.startsWith("/api/state?threadId=10")) {
          stateReads += 1;
          return stateReads === 1 ? stale : fresh;
        }
        throw new Error(`Unexpected request: ${path}`);
      });
      const controller = await loadModules();

      await controller.loadThread(10);
      expect(stateReads).toBe(1);
      expect(controller.appState.interactions[0].projectionFresh).toBe(false);

      await vi.advanceTimersByTimeAsync(500);

      expect(stateReads).toBe(2);
      expect(controller.appState.interactions[0].projectionFresh).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a project-visible submitted invocation through the same source action", async () => {
    vi.useFakeTimers();
    try {
      const root = rootLayer(101, 11);
      const action = {
        id: 777,
        kind: "invoke",
        sourceNodeId: 11,
        targetLayerId: null,
        interactionText: "Resume the leased result",
      };
      root.actions = [action];
      const source = interaction(1, 10, root);
      const submitted = productState([{ id: 10, title: "Recovery source" }], [source]);
      submitted.actionInvocations = [{
        sourceInteractionId: 99,
        actionId: 777,
        resultInteractionId: 100,
        resultCompletionStatus: "submitted",
      }];
      const running = productState([{ id: 10, title: "Recovery source" }], [source]);
      running.actionInvocations = [{
        ...submitted.actionInvocations[0],
        resultCompletionStatus: "running",
      }];
      let retried = false;
      requestImplementation = vi.fn(async (path, options) => {
        if (path.startsWith("/api/state?threadId=10")) return retried ? running : submitted;
        if (path.endsWith("/layers/101")) return root;
        if (path === "/api/threads/10/interactions/1/actions/777/invoke") {
          expect(options).toEqual({ method: "POST" });
          retried = true;
          return {
            created: false,
            invocation: running.actionInvocations[0],
            interaction: { id: 100, threadId: 20, completionStatus: "running" },
          };
        }
        throw new Error(`Unexpected request: ${path}`);
      });
      const controller = await loadModules();

      await controller.loadThread(10);
      await controller.invokeAction(action);

      expect(retried).toBe(true);
      expect(requestImplementation).toHaveBeenCalledWith(
        "/api/threads/10/interactions/1/actions/777/invoke",
        { method: "POST" },
      );
      expect(controller.appState.actionInvocations[0].resultCompletionStatus).toBe("running");
      expect(controller.viewState).toMatchObject({ currentThreadId: 10, currentInteractionId: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["submitted", false, 1],
    ["running", true, 100],
  ])("advances the invoke tutorial only for a non-retryable %s result", async (
    resultCompletionStatus,
    shouldAdvance,
    expectedInteractionId,
  ) => {
    vi.useFakeTimers();
    try {
      const root = rootLayer(101, 11);
      const action = {
        id: 777,
        kind: "invoke",
        sourceNodeId: 11,
        targetLayerId: null,
        interactionText: "Explore this node",
      };
      root.actions = [action];
      const source = interaction(1, 10, root);
      const result = {
        id: 100,
        threadId: 10,
        completionStatus: resultCompletionStatus,
      };
      const beforeInvoke = productState([{ id: 10, title: "Tutorial" }], [source]);
      const afterInvoke = productState([{ id: 10, title: "Tutorial" }], [source, result]);
      afterInvoke.actionInvocations = [{
        sourceInteractionId: 1,
        actionId: 777,
        resultInteractionId: 100,
        resultCompletionStatus,
      }];
      let invoked = false;
      requestImplementation = vi.fn(async (path, options) => {
        if (path.startsWith("/api/state?threadId=10")) return invoked ? afterInvoke : beforeInvoke;
        if (path.endsWith("/layers/101")) return root;
        if (path === "/api/threads/10/interactions/1/actions/777/invoke") {
          expect(options).toEqual({ method: "POST" });
          invoked = true;
          return {
            created: true,
            invocation: afterInvoke.actionInvocations[0],
            interaction: result,
          };
        }
        throw new Error(`Unexpected request: ${path}`);
      });
      const controller = await loadModules();

      await controller.loadThread(10);
      await controller.invokeAction(action);

      expect(tutorialActionSucceeded).toHaveBeenCalledTimes(shouldAdvance ? 1 : 0);
      expect(controller.viewState.currentInteractionId).toBe(expectedInteractionId);
      expect(controller.appState.actionInvocations[0].resultCompletionStatus)
        .toBe(resultCompletionStatus);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["failed", "stopped"])(
    "does not poll an unresolved shared action after its remote result is %s",
    async (resultCompletionStatus) => {
      vi.useFakeTimers();
      try {
        const staleRoot = rootLayer(101, 11);
        staleRoot.actions = [{ id: 777, kind: "invoke", sourceNodeId: 11, targetLayerId: null }];
        const source = interaction(1, 10, staleRoot);
        const state = productState([{ id: 10, title: "Reused source" }], [source]);
        state.actionInvocations = [{
          sourceInteractionId: 99,
          actionId: 777,
          resultInteractionId: 100,
          resultCompletionStatus,
        }];
        requestImplementation = vi.fn(async (path) => {
          if (path.startsWith("/api/state?threadId=10")) return state;
          throw new Error(`Unexpected request: ${path}`);
        });
        const controller = await loadModules();

        await controller.loadThread(10);
        await vi.advanceTimersByTimeAsync(1_500);

        expect(requestImplementation).toHaveBeenCalledTimes(1);
        expect(controller.appState.actionInvocations).toEqual(state.actionInvocations);
        expect(controller.appState.visibleLayer.actions[0].targetLayerId).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("retries a one-shot canonical root failure after the result is already terminal", async () => {
    vi.useFakeTimers();
    try {
      const staleRoot = rootLayer(101, 11);
      staleRoot.actions = [{ id: 777, kind: "invoke", sourceNodeId: 11, targetLayerId: null }];
      const canonicalRoot = rootLayer(101, 11);
      canonicalRoot.actions = [{ id: 777, kind: "invoke", sourceNodeId: 11, targetLayerId: 303 }];
      const source = interaction(1, 10, staleRoot);
      const state = productState([{ id: 10, title: "Source" }], [source]);
      state.actionInvocations = [{ sourceInteractionId: 1, actionId: 777, resultInteractionId: 2 }];
      let layerReads = 0;
      requestImplementation = vi.fn(async (path) => {
        if (path.startsWith("/api/state?threadId=10")) return state;
        if (path.endsWith("/layers/101")) {
          layerReads += 1;
          if (layerReads === 1) throw new Error("one-shot graph read failure");
          return canonicalRoot;
        }
        throw new Error(`Unexpected request: ${path}`);
      });
      const controller = await loadModules();

      await controller.loadThread(10);
      expect(controller.appState.visibleLayer.actions[0].targetLayerId).toBeNull();
      await vi.advanceTimersByTimeAsync(500);

      expect(controller.appState.visibleLayer.actions[0].targetLayerId).toBe(303);
      expect(layerReads).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a one-shot canonical nested-layer failure after the result is terminal", async () => {
    vi.useFakeTimers();
    try {
      const root = rootLayer(101, 11);
      root.actions = [{ id: 501, kind: "navigate", sourceNodeId: 11, targetLayerId: 102 }];
      const staleChild = rootLayer(102, 12);
      staleChild.actions = [{ id: 777, kind: "invoke", sourceNodeId: 12, targetLayerId: null }];
      const canonicalChild = rootLayer(102, 12);
      canonicalChild.actions = [{ id: 777, kind: "invoke", sourceNodeId: 12, targetLayerId: 303 }];
      const source = interaction(1, 10, root);
      const initial = productState([{ id: 10, title: "Source" }], [source]);
      const resolved = productState([{ id: 10, title: "Source" }], [source]);
      resolved.actionInvocations = [{ sourceInteractionId: 1, actionId: 777, resultInteractionId: 2 }];
      let stateReads = 0;
      let layerReads = 0;
      requestImplementation = vi.fn(async (path) => {
        if (path.startsWith("/api/state?threadId=10")) {
          stateReads += 1;
          return stateReads === 1 ? initial : resolved;
        }
        if (path.endsWith("/layers/102")) {
          layerReads += 1;
          if (layerReads === 1) return staleChild;
          if (layerReads === 2) throw new Error("one-shot nested graph read failure");
          return canonicalChild;
        }
        throw new Error(`Unexpected request: ${path}`);
      });
      const controller = await loadModules();
      await controller.loadThread(10);
      await controller.navigateLayer(102, { action: root.actions[0], sourceNode: root.nodes[0] });

      await controller.refreshState(10);
      expect(controller.appState.visibleLayer.actions[0].targetLayerId).toBeNull();
      await vi.advanceTimersByTimeAsync(500);

      expect(controller.appState.visibleLayer.actions[0].targetLayerId).toBe(303);
      expect(layerReads).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a slow nested invoke refresh clobber a newer thread selection", async () => {
    const root = rootLayer(101, 11);
    root.actions = [{ id: 501, kind: "navigate", sourceNodeId: 11, targetLayerId: 102 }];
    const child = rootLayer(102, 12);
    child.actions = [{ id: 777, kind: "invoke", sourceNodeId: 12, targetLayerId: null }];
    const canonicalChildRead = deferred();
    const source = interaction(1, 10, root);
    const other = interaction(2, 20, rootLayer(201, 21));
    const sourceInitial = productState([{ id: 10, title: "Source" }, { id: 20, title: "Other" }], [source]);
    const sourceResolved = productState([{ id: 10, title: "Source" }, { id: 20, title: "Other" }], [source]);
    sourceResolved.actionInvocations = [{ sourceInteractionId: 99, actionId: 777, resultInteractionId: 100 }];
    let sourceReads = 0;
    let layerReads = 0;
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) {
        sourceReads += 1;
        return sourceReads === 1 ? sourceInitial : sourceResolved;
      }
      if (path.startsWith("/api/state?threadId=20")) {
        return productState([{ id: 10, title: "Source" }, { id: 20, title: "Other" }], [other]);
      }
      if (path.endsWith("/layers/102")) {
        layerReads += 1;
        return layerReads === 1 ? child : canonicalChildRead.promise;
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();
    await controller.loadThread(10);
    await controller.navigateLayer(102, { action: root.actions[0], sourceNode: root.nodes[0] });
    const staleRefresh = controller.refreshState(10);
    await vi.waitFor(() => expect(layerReads).toBe(2));
    expect(controller.viewState).toMatchObject({ currentThreadId: 10, currentInteractionId: 1 });
    expect(controller.viewState.layerPath.map(({ layerId }) => layerId)).toEqual([101, 102]);
    expect(controller.appState.visibleLayer).toBe(child);
    expect(controller.appState.visibleLayer.actions[0].targetLayerId).toBeNull();

    await controller.loadThread(20);
    canonicalChildRead.resolve({
      ...child,
      actions: [{ id: 777, kind: "invoke", sourceNodeId: 12, targetLayerId: 303 }],
    });

    await expect(staleRefresh).resolves.toBe(false);
    expect(controller.viewState).toMatchObject({ currentThreadId: 20, currentInteractionId: 2 });
    expect(controller.appState.visibleLayer.layer.id).toBe(201);
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
    expect(controller.getNavigationHistory()).toMatchObject({
      canGoBack: true,
      backChangesTurn: false,
    });
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
    const beforeCommit = vi.fn();

    await expect(controller.navigateHistory(-1, { beforeCommit }))
      .rejects.toThrow("injected render failure");
    expect(beforeCommit).not.toHaveBeenCalled();

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
