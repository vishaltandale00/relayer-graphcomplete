import { readFileSync } from "node:fs";
import { humanTurns } from "../desktop/renderer/src/product-workspace/model.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let requestImplementation;
let rendered;
let renderObserver;
let throwOnRender;
let tutorialActionSucceeded;
let tutorialFollowupSubmitted;
const ownedControllers = new Set();
const invocationKey = "70c6e3d5-cc62-4b10-8588-9e21f091f851";

function retireOwnedControllers() {
  for (const controller of ownedControllers) controller.cancelNavigationHistory();
  ownedControllers.clear();
}

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
    invocationInventoryAvailable: true,
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
  const controller = { ...state, ...threads };
  ownedControllers.add(controller);
  return controller;
}

describe("workspace navigation integration", () => {
  it.each([true, false])("retains the invoking Node when a result is followed, refreshed and restored (reuse %s)", async (reusable) => {
    const root = rootLayer(101, 11);
    root.nodes[0].title = "Choose a vacation destination";
    root.actions = [
      { id: 501, kind: "invoke", sourceNodeId: 11, label: "Analyze destination", reusable },
      { id: 502, kind: "navigate", relation: "reference", sourceNodeId: 11, targetLayerId: 201, label: "Overall analysis · Kyoto" },
    ];
    const result = rootLayer(201, 21);
    const source = interaction(1, 10, root);
    const child = interaction(2, 10, result, 2);
    const state = productState([{ id: 10, title: "Vacation comparison" }], [source, child]);
    state.actionInvocations = [{ reusable: true, sourceInteractionId: 1, actionId: 501, resultInteractionId: 2, resultCompletionStatus: "accepted" }];
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) return state;
      if (path === "/api/threads/10") return { invocationInventoryAvailable: state.invocationInventoryAvailable, thread: state.threads[0], interactions: state.interactions, actionInvocations: state.actionInvocations };
      if (path.endsWith("/layers/201")) return result;
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();
    await controller.loadThread(10);
    controller.selectTurnById(1);
    await controller.navigateLayer(201, { action: root.actions[reusable ? 1 : 0], sourceNode: root.nodes[0] });
    const expectOrigin = () => {
      expect(controller.appState.visibleLayer.layer.id).toBe(201);
      expect(controller.viewState.layerPath.map(({ layerId }) => layerId)).toEqual([101, 201]);
      expect(controller.viewState.layerPath[1]).toMatchObject({ label: "Choose a vacation destination", sourceNodeId: 11, actionId: reusable ? 502 : 501 });
      expect(controller.appState.currentInteractionId).toBe(1);
    };
    expectOrigin();
    await controller.refreshState(10);
    expectOrigin();
    await controller.navigateHistory("back");
    expect(controller.appState.visibleLayer.layer.id).toBe(101);
    await controller.navigateHistory("forward");
    expectOrigin();
    expect(state.interactions).toHaveLength(2);
    expect(requestImplementation.mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);
  });
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(invocationKey);
  });

  afterEach(() => {
    try {
      retireOwnedControllers();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["columns-3", undefined])("refreshes an annotation-only follow-up breadcrumb on acceptance (icon %s)", async (icon) => {
    const root = rootLayer(201, 21);
    const turn = { ...interaction(2, 10, null, 2), graphNodeId: 902, text: "",
      completionStatus: "running", completionOutput: null,
      contexts: [{ target: { id: 11 }, annotations: ["and what do you prefer a chat or a graph"] }] };
    const state = productState([{ id: 10, title: "Chat or graph" }], [turn]);
    state.currentProjection = { cursor: 1, hasMore: false, events: [], states: [{
      completionId: 902, headRevision: 1, lifecycle: "active", currentLayerId: 201,
      finalLayerId: null, safeReason: null, temporalFeatures: { projectionUi: true },
    }] };
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) return state;
      if (path.endsWith("/layers/201")) return root;
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();
    await controller.loadThread(10);
    expect(controller.viewState.layerPath[0]).toMatchObject({ label: "Response", icon: "messages-square" });
    controller.replaceCurrentSelection(21);
    const historyBefore = controller.getNavigationHistory();

    turn.completionStatus = "accepted";
    turn.completionOutput = { rootLayer: root, rootAction: { label: "Chat or graph?", icon } };
    Object.assign(state.currentProjection.states[0], { headRevision: 2, lifecycle: "succeeded", finalLayerId: 201 });
    state.currentProjection.cursor = 2;
    await controller.refreshState(10);

    expect(controller.viewState.layerPath[0]).toMatchObject({
      layerId: 201, label: "Chat or graph?", icon: icon ?? "messages-square",
    });
    expect(controller.viewState.selectedNodeId).toBe(21);
    expect(controller.getNavigationHistory().canGoBack).toBe(historyBefore.canGoBack);
    expect(controller.getNavigationHistory().canGoForward).toBe(historyBefore.canGoForward);
  });

  it("keeps accepted product status while rendering its succeeded temporal current", async () => {
    const root = rootLayer(101, 11);
    const turn = { ...interaction(1, 10, root), graphNodeId: 901 };
    const state = productState([{ id: 10, title: "Accepted temporal result" }], [turn]);
    state.currentProjection = {
      cursor: 1,
      hasMore: false,
      events: [],
      states: [{
        completionId: 901,
        headRevision: 1,
        lifecycle: "succeeded",
        currentLayerId: 101,
        finalLayerId: 101,
        safeReason: null,
        temporalFeatures: { projectionUi: true },
      }],
    };
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) return state;
      if (path.endsWith("/interactions/1/layers/101")) return root;
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();

    await controller.loadThread(10);

    expect(controller.appState.status).toBe("accepted");
    expect(controller.appState.temporalLifecycle).toBe("succeeded");
    expect(controller.appState.visibleLayer).toBe(root);
    expect(controller.appState.nodes.map(({ id }) => id)).toEqual([11]);
  });

  it("opens the authored default and restores the user's choice on sidebar reopen", async () => {
    const layer = { ...rootLayer(101, 11), layer: { id: 101, nodes: [11, 12], defaultNodeId: 12 }, nodes: [{ id: 11, title: "Other" }, { id: 12, title: "Default" }] };
    const turn = interaction(1, 10, layer);
    const other = interaction(2, 20, rootLayer(201, 21));
    const threads = [{ id: 10, title: "First" }, { id: 20, title: "Second" }];
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) return productState(threads, [turn]);
      if (path.startsWith("/api/state?threadId=20")) return productState(threads, [other]);
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();
    await controller.loadThread(10);
    expect(controller.viewState.selectedNodeId).toBe(12);
    controller.replaceCurrentSelection(11);
    await controller.loadThread(20);
    await controller.loadThread(10);
    expect(String(controller.viewState.selectedNodeId)).toBe("11");
    // Explicit history restoration wins over the most recent per-layer choice.
    controller.hydrateWorkspace(turn, layer, { selectedNodeId: 12 });
    expect(controller.viewState.selectedNodeId).toBe(12);
  });

  it("restores thread, turn, path, numeric node selection, and deep-link URL", async () => {
    const layer1 = rootLayer(101, 11);
    const layer2 = rootLayer(201, 21);
    const turn1 = interaction(1, 10, layer1);
    const turn2 = interaction(2, 20, layer2);
    const state1 = productState([{ id: 10, title: "First", projectId: 7 }, { id: 20, title: "Second" }], [turn1]);
    const state2 = productState([{ id: 10, title: "First", projectId: 7 }, { id: 20, title: "Second" }], [turn2]);
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) return state1;
      if (path.startsWith("/api/state?threadId=20")) return state2;
      if (path === "/api/threads/10") {
        return { thread: state1.threads[0], interactions: [turn1], actionInvocations: [] };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();

    const preference = await import("../desktop/renderer/src/project-sidebar.js");
    preference.setProjectCollapsed(7, true);
    await controller.loadThread(10);
    expect(preference.projectCollapsed(7)).toBe(false);
    controller.replaceCurrentSelection(11);
    await controller.loadThread(20);
    preference.setProjectCollapsed(7, true);
    await controller.navigateHistory(-1);
    expect(preference.projectCollapsed(7)).toBe(false);

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

  it("restores explicitly closed details with Back and Forward", async () => {
    const turns = [interaction(1, 10, rootLayer(101, 11)), interaction(2, 20, rootLayer(201, 21))];
    const threads = [{ id: 10, title: "First" }, { id: 20, title: "Second" }];
    requestImplementation = vi.fn(async (path) => {
      const id = path.includes("threadId=20") || path === "/api/threads/20" ? 20 : 10;
      const selected = turns.filter((turn) => turn.threadId === id);
      return path.startsWith("/api/state") ? productState(threads, selected)
        : { thread: threads.find((thread) => thread.id === id), interactions: selected, actionInvocations: [] };
    });
    const controller = await loadModules();
    await controller.loadThread(10);
    expect(controller.viewState.selectedNodeId).toBe(11);
    controller.replaceCurrentSelection(null);
    await controller.loadThread(20);
    expect(controller.viewState.selectedNodeId).toBe(21);
    controller.replaceCurrentSelection(null);
    await controller.navigateHistory(-1);
    expect(controller.viewState).toMatchObject({ selectedNodeId: null, nodeDetailsClosed: true });
    await controller.navigateHistory(1);
    expect(controller.viewState).toMatchObject({ selectedNodeId: null, nodeDetailsClosed: true });
    await controller.loadThread(10);
    expect(String(controller.viewState.selectedNodeId)).toBe("11");
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
    expect(controller.viewState.currentInteractionId).toBe(1);
    expect(controller.appState.pendingTurn).toMatchObject({ interactionId: 2, status: "submitted" });
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
    expect(controller.viewState.currentInteractionId).toBe(1);
    expect(controller.appState.pendingTurn).toMatchObject({ interactionId: 2, status: "submitted" });
  });

  it("lets a newer turn choice cancel a slower history restoration", async () => {
    const layer1 = rootLayer(101, 11);
    const layer2 = rootLayer(201, 21);
    const turn1 = interaction(1, 10, layer1);
    const turn2a = interaction(2, 20, layer2, 1);
    const turn2b = interaction(3, 20, layer2, 2);
    const state1 = productState([{ id: 10, title: "First", projectId: 7 }, { id: 20, title: "Second" }], [turn1]);
    const state2 = productState([{ id: 10, title: "First", projectId: 7 }, { id: 20, title: "Second" }], [turn2a, turn2b]);
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

    const preference = await import("../desktop/renderer/src/project-sidebar.js");
    preference.setProjectCollapsed(7, true);
    const beforeCommit = vi.fn();
    const pending = controller.navigateHistory(-1, { beforeCommit });
    await vi.waitFor(() => expect(controller.getNavigationHistory().pendingDirection).toBe("back"));
    controller.selectTurnById(2);
    expect(controller.getNavigationHistory().pendingDirection).toBeNull();
    restore.resolve({ thread: state1.threads[0], interactions: [turn1], actionInvocations: [] });

    await expect(pending).rejects.toMatchObject({ code: "navigation_superseded" });
    expect(preference.projectCollapsed(7)).toBe(true);
    expect(beforeCommit).not.toHaveBeenCalled();
    expect(controller.viewState).toMatchObject({ currentThreadId: 20, currentInteractionId: 2 });
  });

  it("restores archived resolved-invoke destinations and archived cross-thread history without duplicate invocations", async () => {
    const sourceLayer = rootLayer(101, 11);
    const action = { id: 501, kind: "invoke", sourceNodeId: 11, targetLayerId: 201 };
    sourceLayer.actions = [action];
    const destinationLayer = rootLayer(201, 21);
    const source = interaction(1, 10, sourceLayer);
    const destination = interaction(2, 20, destinationLayer);
    const sourceState = productState([{ id: 10, title: "Source" }, { id: 20, title: "Result", projectId: 8 }], [source]);
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
    let destinationArchived = true;
    let sourceArchived = false;
    requestImplementation = vi.fn(async (path, options) => {
      if (path === "/api/threads/20/archive") { expect(JSON.parse(options.body)).toEqual({ archived: false }); destinationArchived = false; return { id: 20, title: "Result", archivedAt: null }; }
      if (path === "/api/threads/10/archive") { sourceArchived = false; return { id: 10, title: "Source", archivedAt: null }; }
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
          thread: { id: 20, title: "Result", projectId: 8, archivedAt: destinationArchived ? "1" : null },
          interactions: [destination],
          actionInvocations: [acceptedInvocation],
        };
      }
      if (path === "/api/threads/10") {
        return {
          thread: { id: 10, title: "Source", archivedAt: sourceArchived ? "2" : null },
          interactions: [source],
          actionInvocations: [acceptedInvocation],
        };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();
    await controller.loadThread(10);
    const preference = await import("../desktop/renderer/src/project-sidebar.js");
    preference.setProjectCollapsed(8, true);
    const beforeInvokeCommit = vi.fn();

    await expect(controller.navigateResolvedInvoke(action, {
      beforeCommit: beforeInvokeCommit,
    })).resolves.toBe(true);
    expect(preference.projectCollapsed(8)).toBe(false);
    expect(beforeInvokeCommit).toHaveBeenCalledOnce();
    expect(controller.viewState).toMatchObject({
      currentThreadId: 20,
      currentInteractionId: 2,
      selectedNodeId: 21,
    });
    expect(controller.viewState.layerPath.map(({ layerId }) => layerId)).toEqual([201]);
    expect(controller.getNavigationHistory().canGoBack).toBe(true);
    expect(controller.appState.actionInvocations).toEqual([acceptedInvocation]);

    expect(destinationArchived).toBe(false);
    sourceArchived = true;
    const beforeHistoryCommit = vi.fn();
    await controller.navigateHistory("back", { beforeCommit: beforeHistoryCommit });
    expect(beforeHistoryCommit).toHaveBeenCalledOnce();
    expect(sourceArchived).toBe(false);
    expect(controller.appState.threads.find((thread) => thread.id === 10).archivedAt).toBeNull();
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

  it("keeps Stop pending when a pre-Stop poll arrives late and continues terminal polling", async () => {
    vi.useFakeTimers();
    try {
      const turn = { ...interaction(1, 10, rootLayer(101, 11)), completionStatus: "running", stopRequested: false };
      const initial = productState([{ id: 10, title: "Running" }], [turn]);
      const stale = deferred();
      let reads = 0;
      requestImplementation = vi.fn(async (path) => {
        if (path.endsWith("/interactions/1/stop")) return { ...turn, stopRequested: true };
        if (path.startsWith("/api/state?threadId=10")) {
          reads++;
          if (reads === 1) return structuredClone(initial);
          if (reads === 2) return stale.promise;
          return productState(initial.threads, [{ ...turn, stopRequested: true, completionStatus: "stopped" }]);
        }
        throw new Error(`Unexpected request: ${path}`);
      });
      const controller = await loadModules();
      await controller.loadThread(10);
      const polling = controller.refreshState(10);
      await controller.stopInteraction(10, 1);
      stale.resolve(initial);
      expect(await polling).toBe(false);
      expect(controller.appState.interactions[0].stopRequested).toBe(true);
      await vi.advanceTimersByTimeAsync(500);
      expect(controller.appState.interactions[0].completionStatus).toBe("stopped");
    } finally {
      retireOwnedControllers();
      vi.useRealTimers();
    }
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

  it("does not reread a canonical temporal descendant after reconciling selection", async () => {
    const root = rootLayer(101, 11);
    const child = rootLayer(102, 12);
    const turn = { ...interaction(1, 10, root), graphNodeId: 901 };
    const state = productState([{ id: 10, title: "Temporal" }], [turn]);
    state.currentProjection = { cursor: 1, hasMore: false, events: [], states: [{
      completionId: 901, headRevision: 1, lifecycle: "succeeded", currentLayerId: 102,
      finalLayerId: 102, safeReason: null, temporalFeatures: { projectionUi: true },
    }] };
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) return state;
      if (path.endsWith("/layers/102")) return child;
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();
    await controller.loadThread(10);
    expect(controller.appState.visibleLayer).toBe(child);
    expect(requestImplementation.mock.calls.filter(([path]) => path.endsWith("/layers/102"))).toHaveLength(1);
  });

  it("preserves a newer node selection while a canonical descendant refresh is pending", async () => {
    const root = rootLayer(101, 11);
    root.actions = [{ id: 501, kind: "navigate", sourceNodeId: 11, targetLayerId: 102 }];
    const child = rootLayer(102, 12);
    const turn = interaction(1, 10, root);
    const state = productState([{ id: 10, title: "Source" }], [turn]);
    const pending = deferred();
    let reads = 0;
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) return state;
      if (path.endsWith("/layers/102")) return ++reads === 1 ? child : pending.promise;
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();
    await controller.loadThread(10);
    await controller.navigateLayer(102, { action: root.actions[0], sourceNode: root.nodes[0] });
    const refresh = controller.refreshState(10);
    await vi.waitFor(() => expect(reads).toBe(2));
    controller.replaceCurrentSelection(12);
    pending.resolve(child);
    await refresh;
    expect(controller.viewState.selectedNodeId).toBe(12);
    expect(controller.appState.visibleLayer).toBe(child);
  });

  it.each(["refresh", "navigation", "history"])("revalidates an omitted legacy descendant action on %s without invocation metadata", async (entry) => {
    const root = rootLayer(101, 11);
    root.actions = [{ id: 501, kind: "navigate", relation: "reference", sourceNodeId: 11, targetLayerId: 102 }];
    const staleChild = rootLayer(102, 12);
    const canonicalChild = rootLayer(102, 12);
    canonicalChild.actions = [{ id: 777, kind: "navigate", relation: "expand", sourceNodeId: 12,
      targetLayerId: 303, resolvedInvokeInteractionId: 99, state: "accepted" }];
    const turn = interaction(1, 10, root);
    const state = productState([{ id: 10, title: "Source" }], [turn]);
    let layerReads = 0;
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) return state;
      if (path === "/api/threads/10") return { thread: state.threads[0], interactions: [turn], actionInvocations: [] };
      if (path.endsWith("/layers/102")) return ++layerReads === 1 ? staleChild : canonicalChild;
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();
    await controller.loadThread(10);
    const navigation = { action: root.actions[0], sourceNode: root.nodes[0] };
    await controller.navigateLayer(102, navigation);
    expect(controller.appState.visibleLayer.actions).toEqual([]);
    if (entry === "refresh") {
      await controller.refreshState(10);
    } else {
      await controller.navigateLayer(101, { restore: true, pathIndex: 0 });
      if (entry === "history") await controller.navigateHistory("back");
      else await controller.navigateLayer(102, navigation);
    }
    expect(controller.appState.visibleLayer.actions).toEqual(canonicalChild.actions);
    expect(layerReads).toBe(2);
    expect(controller.appState.actionInvocations).toEqual([]);
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

  it("retires pending polling before the next controller owns its request mock", async () => {
    vi.useFakeTimers();
    let readTwoSettled = false;
    let resolveReadTwo;
    const readTwo = new Promise((resolve) => {
      resolveReadTwo = (value) => {
        readTwoSettled = true;
        resolve(value);
      };
    });
    const pendingTurn = {
      id: 1,
      threadId: 10,
      sequence: 1,
      text: "Pending turn",
      completionStatus: "submitted",
      completionOutput: null,
    };
    const pendingState = productState([{ id: 10, title: "Pending" }], [pendingTurn]);
    try {
      requestImplementation = vi.fn(async (path) => {
        if (path.startsWith("/api/state?threadId=10")) return pendingState;
        throw new Error(`Unexpected retired-controller request: ${path}`);
      });
      const retiredController = await loadModules();
      await retiredController.loadThread(10);

      retireOwnedControllers();

      let stateReads = 0;
      requestImplementation = vi.fn(async (path) => {
        if (path.startsWith("/api/state?threadId=10")) {
          stateReads += 1;
          if (stateReads === 2) return readTwo;
          return pendingState;
        }
        throw new Error(`Unexpected current-controller request: ${path}`);
      });
      const currentController = await loadModules();
      await currentController.loadThread(10);
      expect(stateReads).toBe(1);

      await vi.advanceTimersByTimeAsync(500);

      expect(stateReads).toBe(2);
      expect(readTwoSettled).toBe(false);
      resolveReadTwo(pendingState);
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      try {
        retireOwnedControllers();
      } finally {
        vi.useRealTimers();
      }
    }
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
      try {
        retireOwnedControllers();
      } finally {
        vi.useRealTimers();
      }
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
      try {
        retireOwnedControllers();
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it.each([["created", false], ["response-loss", false], ["already-accepted", false], ["created", true]])("shows the distinct invoke result without overriding explicit source navigation (%s, back=%s)", async (outcome, backToSource) => {
    const sourceRoot = rootLayer(7, 22);
    const action = { id: 6, kind: "invoke", sourceNodeId: 22, targetLayerId: null, interactionText: "Prepare launch" };
    sourceRoot.actions = [action];
    const source = interaction(1, 10, sourceRoot);
    const resultRoot = rootLayer(8, 26);
    resultRoot.nodes.push({ id: 27, title: "Observe" }, { id: 28, title: "Decide" });
    resultRoot.layer.defaultNodeId = 27;
    const result = { ...interaction(2, 10, resultRoot, 2), completionStatus: "running", completionOutput: null };
    const state = productState([{ id: 10, title: "Launch" }], [source]);
    let invoked = false;
    let accepted = false;
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) {
        if (!invoked) return state;
        return { ...state, interactions: [source, accepted ? interaction(2, 10, resultRoot, 2) : result],
          actionInvocations: [{ sourceInteractionId: 1, actionId: 6, resultInteractionId: 2,
            resultCompletionStatus: accepted ? "accepted" : "running" }] };
      }
      if (path === "/api/threads/10/interactions/1/actions/6/invoke") {
        invoked = true;
        if (outcome === "response-loss") throw new Error("response lost after durable creation");
        if (outcome === "already-accepted") accepted = true;
        return { created: true, interaction: accepted ? interaction(2, 10, resultRoot, 2) : result,
          invocation: { sourceInteractionId: 1, actionId: 6, resultInteractionId: 2, resultCompletionStatus: "running" } };
      }
      if (path.endsWith("/layers/7")) return sourceRoot;
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();
    await controller.loadThread(10);
    controller.viewState.mainView = "thread";
    controller.replaceCurrentSelection(22);
    expect(controller.viewState.layerPath.map(({ layerId }) => layerId)).toEqual([7]);
    await controller.invokeAction(action);
    await vi.waitFor(() => expect(controller.appState.interactions.some(turn => turn.id === 2)).toBe(true));
    expect(controller.viewState.currentInteractionId).toBe(outcome === "already-accepted" ? 2 : 1);
    expect(controller.appState.visibleLayer.layer.id).toBe(outcome === "already-accepted" ? 8 : 7);
    if (backToSource) {
      // Pending work now preserves the source. Exercise actual browsing to the
      // pending turn and back, not a no-op selection of the already-open source.
      controller.selectTurnById(2);
      controller.selectTurnById(1);
    }
    accepted = true;
    sourceRoot.actions = [{ ...action, kind: "navigate", relation: "expand", targetLayerId: 8,
      resolvedInvokeInteractionId: 25, interactionText: null, state: "accepted" }];
    await controller.refreshState(10);
    expect(controller.appState.status).toBe("accepted");
    expect(controller.viewState.currentInteractionId).toBe(backToSource ? 1 : 2);
    expect(controller.appState.visibleLayer.layer.id).toBe(backToSource ? 7 : 8);
    expect(controller.viewState.layerPath.map(({ layerId }) => layerId)).toEqual([backToSource ? 7 : 8]);
    expect(controller.appState.nodes.map(({ id }) => id)).toEqual(backToSource ? [22] : [26, 27, 28]);
    expect(String(controller.viewState.selectedNodeId)).toBe(backToSource ? "22" : "27");
    controller.selectTurnById(1);
    expect(controller.appState.visibleLayer.layer.id).toBe(7);
    expect(controller.appState.actions[0]).toMatchObject({ id: 6, kind: "navigate", targetLayerId: 8 });
  });

  it.each([true, false])("recovers response loss only for the exact reusable Invocation key (matches=%s)", async (matches) => {
    vi.useFakeTimers();
    const sourceRoot = rootLayer(7, 22);
    const action = { id: 6, kind: "invoke", sourceNodeId: 22, targetLayerId: null };
    sourceRoot.actions = [action];
    const source = interaction(1, 10, sourceRoot);
    const result = interaction(2, 10, rootLayer(8, 26), 2);
    const state = { ...productState([{ id: 10, title: "Recover exact call" }], [source]), inputDraftRevision: 12 };
    let posted = false;
    requestImplementation = vi.fn(async (path, options) => {
      if (path.startsWith("/api/state?threadId=10")) return posted ? {
        ...state, interactions: [source, result], actionInvocations: [{
          reusable: true, invocationKey: matches ? invocationKey : "another-call",
          sourceInteractionId: 1, actionId: 6, resultInteractionId: 2, resultCompletionStatus: "accepted",
        }],
      } : state;
      if (path === "/api/threads/10/interactions/1/actions/6/invoke") {
        expect(options).toEqual({ method: "POST", headers: { "Idempotency-Key": invocationKey }, body: JSON.stringify({ inputDraftRevision: 13, presentingLayerId: 7 }) });
        posted = true;
        throw new Error("response lost");
      }
      if (path.endsWith("/layers/7")) return sourceRoot;
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();
    const toast = { textContent: "", classList: { add: vi.fn(), remove: vi.fn() } };
    document.querySelector = (selector) => selector === "#toast" ? toast : null;
    await controller.loadThread(10);
    controller.viewState.mainView = "thread";
    const recovered = await controller.invokeAction(action, { inputDraftRevision: 13 });
    expect(recovered).toEqual(matches ? { interaction: { id: 2 }, recovered: true } : null);
    expect(controller.viewState.currentInteractionId).toBe(matches ? 2 : 1);
    expect(tutorialActionSucceeded).toHaveBeenCalledTimes(matches ? 1 : 0);
    expect(controller.appState.pendingActionInvocations).toEqual([]);
  });

  it.each(["503", "held", "browsed"])("returns the exact acknowledged Invoke before optional %s refresh, without activating twice", async refreshMode => {
    const root = rootLayer(7, 22); root.layer.state = "accepted"; root.nodes[0].state = "accepted";
    const action = { id: 6, kind: "invoke", sourceNodeId: 22, state: "accepted", reusable: false };
    root.actions = [action];
    const source = interaction(1, 10, root);
    const state = productState([{ id: 10, title: "Acknowledged activation" }], [source]);
    const acknowledgment = { created: true, interaction: { id: 2, threadId: 10, completionStatus: "running" },
      invocation: { durable: true, reusable: false, invocationKey, sourceInteractionId: 1, actionId: 6, sourceNodeId: 22,
        presentingLayerId: 7, resultInteractionId: 2, resultCompletionStatus: "running" },
      inputDraft: { threadId: 10, revision: 5, attachments: [{ occurrence: { actionId: 14 }, value: { text: "Unrelated notes" } }] } };
    let activated = false;
    const stateRead = deferred();
    const resultRoot = rootLayer(8, 26);
    requestImplementation = vi.fn(async (path, options) => {
      if (path.startsWith("/api/state?threadId=10")) {
        if (activated) {
          if (refreshMode === "503") throw Object.assign(new Error("State temporarily unavailable"), { status: 503 });
          return stateRead.promise;
        }
        return state;
      }
      if (path === "/api/threads/10/interactions/1/actions/6/invoke") {
        expect(options.headers["Idempotency-Key"]).toBe(invocationKey);
        expect(JSON.parse(options.body)).toEqual({ inputDraftRevision: 4, presentingLayerId: 7 });
        activated = true; return acknowledgment;
      }
      if (path.endsWith("/layers/7")) return root;
      if (path.endsWith("/layers/8")) return resultRoot;
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();
    await controller.loadThread(10);
    controller.viewState.mainView = "thread";
    const response = await controller.invokeAction(action, { inputDraftRevision: 4 });
    expect(response).toBe(acknowledgment);
    expect(response.inputDraft).toBe(acknowledgment.inputDraft);
    expect(controller.appState.actionInvocations).toEqual([acknowledgment.invocation]);
    expect(controller.appState.pendingActionInvocations).toEqual([]);
    expect(controller.appState.pendingTurn).toMatchObject({ interactionId: 2, invocationSource: { origin: {
      invocationKey, sourceNodeId: 22, presentingLayerId: 7, sourceEntry: { turnId: "1", selectedNodeId: 22 },
    } } });
    expect(controller.viewState.currentInteractionId).toBe(1);
    expect(controller.appState.visibleLayer).toBe(root);
    expect(tutorialActionSucceeded).toHaveBeenCalledTimes(1);
    expect(await controller.invokeAction(action, { inputDraftRevision: 5 })).toBeNull();
    expect(requestImplementation.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    if (refreshMode !== "503") {
      if (refreshMode === "browsed") controller.replaceCurrentSelection(22);
      stateRead.resolve({ ...state, interactions: [source, interaction(2, 10, resultRoot, 2)],
        actionInvocations: [{ ...acknowledgment.invocation, resultCompletionStatus: "accepted" }] });
      if (refreshMode === "browsed") {
        await vi.waitFor(() => expect(controller.appState.pendingTurn?.readyLayer?.layer.id).toBe(8));
        expect(controller.viewState.currentInteractionId).toBe(1);
        expect(controller.openReadyResult()).toBe(true);
      } else await vi.waitFor(() => expect(controller.viewState.currentInteractionId).toBe(2));
      expect(controller.appState.visibleLayer.layer.id).toBe(8);
      expect(controller.viewState.invocationOrigin).toMatchObject({ sourceNodeId: "22", presentingLayerId: "7", invocationKey });
      expect(requestImplementation.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    }
  });

  it("retains a native preparation rejection and sends a corrected activation with a fresh key", async () => {
    const root = rootLayer(7, 22);
    const action = { id: 6, kind: "invoke", sourceNodeId: 22, reusable: false };
    root.actions = [action];
    const source = interaction(1, 10, root);
    const refused = { sourceInteractionId: 1, actionId: 6, resultInteractionId: 2,
      durable: false, reusable: false, invocationKey, resultCompletionStatus: "failed",
      preparationRecoverable: false, preparationRejected: true };
    const failed = { ...interaction(2, 10, null, 2), completionStatus: "failed", completionOutput: null };
    const initial = productState([{ id: 10, title: "Correct a refused preparation" }], [source]);
    const rejected = { ...initial, interactions: [source, failed], actionInvocations: [refused] };
    const nextKey = "fresh-corrected-gesture";
    const prepared = { ...refused, durable: true, invocationKey: nextKey, resultInteractionId: 3,
      preparationRejected: false, resultCompletionStatus: "running" };
    const running = { ...interaction(3, 10, null, 3), completionStatus: "running", completionOutput: null };
    let attempts = 0;
    requestImplementation = vi.fn(async (path, options) => {
      if (path.startsWith("/api/state?threadId=10")) return attempts === 0 ? initial : attempts === 1 ? rejected
        : { ...initial, interactions: [source, failed, running], actionInvocations: [refused, prepared] };
      if (path.endsWith("/layers/7")) return root;
      if (path === "/api/threads/10/interactions/1/actions/6/invoke") {
        attempts += 1;
        expect(options.headers["Idempotency-Key"]).toBe(attempts === 1 ? invocationKey : nextKey);
        expect(JSON.parse(options.body)).toEqual({ inputDraftRevision: attempts === 1 ? 13 : 14, presentingLayerId: 7 });
        if (attempts === 1) throw new Error("Native preparation rejected invalid arguments");
        return { created: true, invocation: prepared, interaction: running };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();
    const toast = { textContent: "", classList: { add: vi.fn(), remove: vi.fn() } };
    document.querySelector = selector => selector === "#toast" ? toast : null;
    await controller.loadThread(10);
    expect(await controller.invokeAction(action, { inputDraftRevision: 13 })).toBeNull();
    expect(toast.textContent).toBe("Native preparation rejected invalid arguments");
    expect(controller.appState.actionInvocations).toEqual([refused]);
    expect(controller.appState.pendingActionInvocations).toEqual([]);
    expect(controller.viewState.currentInteractionId).toBe(1);
    expect(tutorialActionSucceeded).not.toHaveBeenCalled();
    vi.mocked(globalThis.crypto.randomUUID).mockReturnValue(nextKey);
    await controller.invokeAction(action, { inputDraftRevision: 14 });
    expect(attempts).toBe(2);
    expect(controller.appState.actionInvocations).toEqual([refused, prepared]);
    expect(controller.viewState.currentInteractionId).toBe(1);
    expect(tutorialActionSucceeded).toHaveBeenCalledTimes(1);
  });

  it("opens actual native archived Returned without inventing a Product result turn", async () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/inert-returned-call.json", import.meta.url), "utf8"));
    const { detail, sourceLayer } = fixture;
    const entry = detail.importedInvocationHistory[0];
    const source = detail.interactions.find(item => item.id === entry.sourceInteractionId);
    expect(fixture.nativeProductResultBound).toBe(false);
    expect(entry.record.lifecycle).toBe("succeeded");
    expect(entry.resultInteractionId).toBeNull();
    expect(detail.actionInvocations).toEqual([]);
    const state = { ...productState([detail.thread], detail.interactions), importedInvocationHistory: detail.importedInvocationHistory };
    requestImplementation = vi.fn(async path => {
      if (path === `/api/threads/${detail.thread.id}`) return detail;
      if (path.startsWith(`/api/state?threadId=${detail.thread.id}`)) return state;
      if (path.endsWith(`/layers/${sourceLayer.layer.id}`)) return sourceLayer;
      throw new Error(`Unexpected execution or synthetic request: ${path}`);
    });
    const controller = await loadModules();
    await controller.loadThread(detail.thread.id);
    controller.viewState.mainView = "thread";
    controller.selectTurnById(source.id);
    controller.replaceCurrentSelection(entry.sourceNodeId);
    const expected = `current:${entry.record.id}`;
    requestImplementation.mockClear();
    expect(await controller.navigateImportedInvocationHistory(entry)).toBe(true);
    const expectReturned = () => {
      expect(controller.viewState.currentInteractionId).toBe(expected);
      expect(controller.appState.visibleLayer.layer.id).toBe(entry.record.returnedLayerId);
      expect(controller.appState.interactions.find(item => item.id === expected)).toMatchObject({ inertInvocationCurrent: true, completionStatus: "accepted", invocationSourceInteractionId: source.id });
      expect(controller.viewState.invocationOrigin).toMatchObject({ kind: "imported", sourceNodeId: String(entry.sourceNodeId), actionId: String(entry.sourceActionId), presentingLayerId: String(entry.presentingLayerId), label: "Source" });
    };
    expectReturned();
    await expect(controller.submitInteraction("Do not launch", { familyId: 1 })).rejects.toThrow("read only");
    expect(await controller.invokeAction(sourceLayer.actions[0])).toBeNull();
    expect(requestImplementation).not.toHaveBeenCalled();
    await controller.refreshState(detail.thread.id);
    expectReturned();
    requestImplementation.mockClear();
    expect(await controller.navigateLayer(null, { invocationOrigin: true })).toBe(true);
    expect(controller.viewState.currentInteractionId).toBe(source.id);
    expect(controller.viewState.selectedNodeId).toBe(String(entry.sourceNodeId));
    expect(controller.appState.visibleLayer.layer.id).toBe(sourceLayer.layer.id);
    await controller.navigateHistory("back"); expectReturned();
    await controller.navigateHistory("forward");
    expect(controller.viewState.currentInteractionId).toBe(source.id);
    expect(requestImplementation).not.toHaveBeenCalled();
    expect(controller.appState.actionInvocations).toEqual([]);
    expect(controller.appState.interactions.filter(item => typeof item.id === "number")).toEqual(detail.interactions);
    const missingProductAssociation = { ...entry, resultInteractionId: 999 };
    controller.appState.importedInvocationHistory = [missingProductAssociation];
    expect(await controller.navigateImportedInvocationHistory(missingProductAssociation)).toBe(false);
  });

  it.each(["stopped", "succeeded", "native", "native-changed", "native-missing"])("retains the exact source occurrence for inert %s history through refresh, source, Back and Forward", async (kind) => {
    const isNative = kind.startsWith("native");
    const root = rootLayer(7, 22);
    root.layer.state = "accepted"; root.nodes[0].state = "accepted";
    root.nodes[0].title = "Plan a trip";
    const invoke = { id: 6, sourceNodeId: 22, sourceLayerId: 7, kind: "invoke", state: "accepted", label: "Build itinerary" };
    const expand = { id: 60, sourceNodeId: 22, kind: "navigate", state: "accepted", relation: "reference", targetLayerId: 9, label: "Second occurrence" };
    root.actions = [invoke, expand];
    const presenting = { ...root, layer: { id: 9, state: "accepted" }, actions: [invoke] };
    const source = { ...interaction(1, 10, root), graphNodeId: 50 };
    const thread = { id: 10, title: "Exact inert origin", imported: !isNative };
    const currentLayer = { layer: { id: "layer:current", state: "accepted" }, nodes: [{ id: "node:current", state: "accepted", title: "Lisbon itinerary" }], edges: [], actions: [] };
    const returned = interaction(2, 10, rootLayer(8, 23), 2);
    const entry = { inert: true, threadId: 10, sourceInteractionId: 1, sourceNodeId: 22, sourceActionId: 6, presentingLayerId: 9,
      resultInteractionId: kind === "succeeded" ? 2 : null, record: { id: "invocation:history", childInteractionNodeId: "node:child", lifecycle: kind,
        source: { actionId: "action:invoke", layerId: "layer:definition", presentingLayerId: "layer:presenting", label: "Build itinerary" }, arguments: [],
        currentLayerId: "layer:current", current: kind === "succeeded" ? null : { rootLayerId: "layer:current", layers: [currentLayer] } } };
    const nativeLayer = { ...currentLayer, layer: { id: 71, state: "accepted" }, nodes: [{ id: 72, state: "accepted", title: "Native retained Current" }] };
    const call = { graphOnly: true, durable: true, invocationKey: "native-call", sourceInteractionId: 1, actionId: 6, presentingLayerId: 9,
      resultInteractionId: null, resultCompletionStatus: "stopped", nativeInvocation: {
        invocation: { id: 70, invocationKey: "native-call", sourceCompletionId: 50, sourceActionId: 6, parentNodeId: 22, childInteractionNodeId: 700,
          actionSnapshot: { actionId: 6, sourceNodeId: 22, presentingLayerId: 9, label: "Build itinerary" }, state: { completionId: 700, currentLayerId: 71, lifecycle: "stopped" } },
        sourceAction: invoke, parentNode: root.nodes[0], submittedInputs: [], current: { nodeId: 700, rootLayerId: 71, layers: [nativeLayer] },
      } };
    const state = { ...productState([thread], kind === "succeeded" ? [source, returned] : [source]),
      actionInvocations: isNative ? [call] : [], importedInvocationHistory: isNative ? [] : [entry] };
    requestImplementation = vi.fn(async path => {
      if (path.startsWith("/api/state?threadId=10")) return state;
      if (path === "/api/threads/10") return { thread, interactions: state.interactions,
        actionInvocations: state.actionInvocations, importedInvocationHistory: state.importedInvocationHistory };
      if (path.endsWith("/layers/7")) return root;
      if (path.endsWith("/layers/9")) return presenting;
      throw new Error(`Unexpected execution or synthetic request: ${path}`);
    });
    const controller = await loadModules();
    await controller.loadThread(10);
    controller.viewState.mainView = "thread";
    controller.selectTurnById(1);
    await controller.navigateLayer(9, { action: expand, sourceNode: root.nodes[0] });
    const storage = new Map();
    window.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
    const drafts = await import("../desktop/renderer/src/composer-drafts.js");
    drafts.persistThreadFollowupDraft("10:1", "Unsent follow-up");
    requestImplementation.mockClear();
    expect(await (isNative ? controller.navigateInvocationCurrent(call) : controller.navigateImportedInvocationHistory(entry))).toBe(true);
    const target = kind === "succeeded" ? 2 : isNative ? "native-current:70" : "current:invocation:history";
    const expectOrigin = () => {
      expect(controller.viewState.currentInteractionId).toBe(target);
      expect(controller.viewState.invocationOrigin).toMatchObject({ kind: isNative ? "graph" : "imported", sourceNodeId: "22", actionId: "6", presentingLayerId: "9", label: "Plan a trip",
        sourceEntry: { threadId: "10", turnId: "1", selectedNodeId: "22", navigationPath: [{ layerId: "7", viaActionId: null }, { layerId: "9", viaActionId: "60" }] } });
    };
    expectOrigin();
    await expect(controller.submitInteraction("Unsent follow-up", { familyId: 1 })).rejects.toThrow("read only");
    expect(await controller.invokeAction(invoke)).toBeNull();
    expect(drafts.threadFollowupDraft("10:1")).toBe("Unsent follow-up");
    expect(requestImplementation).not.toHaveBeenCalled();
    await controller.refreshState(10);
    expectOrigin();
    requestImplementation.mockClear();
    expect(await controller.navigateLayer(null, { invocationOrigin: true })).toBe(true);
    expect(controller.viewState.currentInteractionId).toBe(1);
    expect(controller.appState.visibleLayer.layer.id).toBe(9);
    expect(controller.viewState.selectedNodeId).toBe("22");
    await controller.navigateHistory("back"); expectOrigin();
    await controller.navigateHistory("back");
    expect(controller.viewState.currentInteractionId).toBe(1);
    await controller.navigateHistory("forward"); expectOrigin();
    await controller.navigateHistory("forward");
    expect(controller.appState.visibleLayer.layer.id).toBe(9);
    expect(drafts.threadFollowupDraft("10:1")).toBe("Unsent follow-up");
    expect(requestImplementation).not.toHaveBeenCalled();
    expect(controller.appState.actionInvocations).toHaveLength(isNative ? 1 : 0);
    if (kind === "native-changed" || kind === "native-missing") {
      await controller.navigateHistory("back"); expectOrigin();
      const later = interaction(9, 10, rootLayer(909, 919), 9);
      state.interactions = [source, later];
      const updated = structuredClone(call);
      updated.nativeInvocation.invocation.state.currentLayerId = 77;
      state.actionInvocations = kind === "native-missing" ? [] : [updated];
      await controller.refreshState(10);
      expect(controller.viewState.currentInteractionId).toBe(1);
      expect(controller.appState.visibleLayer.layer.id).toBe(9);
      expect(controller.viewState.selectedNodeId).toBe("22");
      expect(controller.viewState.invocationOrigin).toBeNull();
      expect(controller.viewState.layerPath.map(step => step.layerId)).toEqual([7, 9]);
      expect(drafts.threadFollowupDraft("10:1")).toBe("Unsent follow-up");
      expect(controller.appState.interactions.some(item => item.id === "native-current:70")).toBe(false);
      await expect(controller.navigateHistory("back")).rejects.toThrow("turn is unavailable");
      expect(requestImplementation.mock.calls.every(([path]) => !path.includes("native-current"))).toBe(true);
    }
  });

  it("reads imported Current and restores its local history without native requests or Invoke", async () => {
    const sourceRoot = rootLayer(7, 22);
    sourceRoot.layer.state = "accepted";
    Object.assign(sourceRoot.nodes[0], { state: "accepted", kind: "concept", icon: "box", detail: "Source" });
    sourceRoot.actions.push({ id: 41, kind: "invoke", sourceNodeId: 22, sourceLayerId: 7,
      interactionText: "Explore", label: "Explore", state: "accepted", variant: "pill", inputActionIds: [], reusable: true });
    const source = interaction(1, 10, sourceRoot);
    const imported = { id: 10, title: "Inert imported call", imported: true };
    const currentLayer = { layer: { id: "layer:current" }, nodes: [{ id: "node:current", title: "Current draft", detail: "Read only" }], edges: [],
      actions: [{ id: "action:detail", sourceNodeId: "node:current", kind: "navigate", relation: "reference", label: "Detail", targetLayerId: "layer:detail" }] };
    const detailLayer = { layer: { id: "layer:detail" }, nodes: [{ id: "node:detail", title: "Current detail", detail: "Read only" }], edges: [], actions: [] };
    const entry = { inert: true, threadId: 10, sourceInteractionId: 1, sourceNodeId: 22, sourceActionId: 41, presentingLayerId: 7, resultInteractionId: null,
      record: { id: "invocation:history", childInteractionNodeId: "node:child", lifecycle: "stopped", currentLayerId: "layer:current", returnedLayerId: null,
        source: { interactionNodeId: "node:source", actionId: "action:explore", parentNodeId: "node:source-parent",
          layerId: "layer:source", presentingLayerId: "layer:source", captureState: "accepted", instruction: "Explore", label: "Explore",
          description: null, icon: null, iconAsset: null, variant: "pill", inputActionIds: [], inputBindingsDefined: true,
          reusable: true, parentTitle: "Node 22", parentDetail: "Source", state: "accepted" },
        arguments: [], safeReason: "Stopped", current: { rootLayerId: "layer:current", layers: [currentLayer, detailLayer] } } };
    const agentResult = interaction(2, 10, rootLayer(8, 23), 2);
    const agentHistory = { ...entry, resultInteractionId: 2, record: { ...entry.record, id: "invocation:agent", activator: "agent", lifecycle: "succeeded", current: null } };
    const state = { ...productState([imported], [source, agentResult]), importedInvocationHistory: [entry, agentHistory] };
    requestImplementation = vi.fn(async path => {
      if (path.startsWith("/api/state?threadId=10")) return state;
      if (path.endsWith("/layers/7")) return sourceRoot;
      throw new Error(`Unexpected native request: ${path}`);
    });
    const controller = await loadModules();
    await controller.loadThread(10);
    controller.viewState.mainView = "thread";
    requestImplementation.mockClear();
    expect(await controller.navigateImportedInvocationHistory(entry)).toBe(true);
    expect(controller.viewState.currentInteractionId).toBe("current:invocation:history");
    expect(controller.appState.status).toBe("stopped");
    expect(controller.appState.actionInvocations).toEqual([]);
    expect(humanTurns(controller.appState, imported).map(turn => turn.id)).toEqual([1]);
    expect(String(location.href)).not.toContain("current%3A");
    requestImplementation.mockClear();
    await controller.refreshState(10);
    expect(controller.viewState.currentInteractionId).toBe("current:invocation:history");
    expect(controller.appState.visibleLayer.layer.id).toBe("layer:current");
    expect(humanTurns(controller.appState, imported).map(turn => turn.id)).toEqual([1]);
    expect(requestImplementation.mock.calls.every(([path]) => path.startsWith("/api/state?threadId=10") && !path.includes("current%3A"))).toBe(true);
    requestImplementation.mockClear();
    const currentAction = controller.appState.actions[0];
    expect(await controller.navigateLayer("layer:detail", { action: currentAction, sourceNode: currentLayer.nodes[0] })).toBe(true);
    expect(await controller.navigateLayer("layer:unknown")).toBe(false);
    await controller.navigateHistory("back");
    expect(controller.appState.visibleLayer.layer.id).toBe("layer:current");
    await controller.navigateHistory("back");
    expect(controller.viewState.currentInteractionId).toBe(1);
    await controller.navigateHistory("forward");
    expect(controller.appState.visibleLayer.layer.id).toBe("layer:current");
    await controller.navigateHistory("forward");
    expect(controller.appState.visibleLayer.layer.id).toBe("layer:detail");
    expect(await controller.invokeAction({ id: "action:mutation", kind: "invoke" })).toBeNull();
    expect(await controller.navigateImportedInvocationHistory({ record: { id: "invocation:forged" } })).toBe(false);
    expect(requestImplementation).not.toHaveBeenCalled();
  });

  it.each([false, "reservation", "not_started", "submitted", "failed"])("recovers submitted invocation without replacing a durable key (durable=%s)", async (durable) => {
    vi.useFakeTimers();
    try {
      const root = rootLayer(101, 11);
      root.layer.state = "accepted"; root.nodes[0].state = "accepted";
      const action = {
        state: "accepted",
        id: 777,
        kind: "invoke",
        sourceNodeId: 11,
        targetLayerId: null,
        interactionText: "Resume the leased result",
        ...(durable ? { reusable: false } : {}),
      };
      const navigate = { id: 778, kind: "navigate", state: "accepted", sourceNodeId: 11, targetLayerId: 202 };
      root.actions = [action, navigate];
      const original = { ...root, layer: { ...root.layer, id: 202 }, actions: [action] };
      const source = interaction(1, 10, root);
      const submitted = productState([{ id: 10, title: "Recovery source" }], [source]);
      submitted.actionInvocations = [{
        sourceInteractionId: durable ? 1 : 99,
        ...(durable ? { durable: durable !== "reservation", reusable: false, invocationKey: "saved-gesture", preparationRecoverable: true, presentingLayerId: 202 } : {}),
        actionId: 777,
        resultInteractionId: 100,
        resultCompletionStatus: durable === "reservation" ? "not_started" : durable || "submitted",
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
        if (path.endsWith("/layers/202")) return original;
        if (path === "/api/threads/10") return { invocationInventoryAvailable: true, thread: submitted.threads[0], interactions: [source], actionInvocations: submitted.actionInvocations };
        if (path === "/api/threads/10/interactions/1/actions/777/invoke") {
          expect(options).toEqual({ method: "POST", headers: { "Idempotency-Key": durable ? "saved-gesture" : invocationKey }, body: JSON.stringify({ presentingLayerId: durable ? 202 : 101 }) });
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
      if (durable) {
        await controller.navigateLayer(202, { action: navigate, sourceNode: root.nodes[0] });
        await controller.navigateLayer(101, { restore: true, pathIndex: 0 });
      }
      await controller.invokeAction(action, { inputDraftRevision: durable ? 999 : undefined });

      expect(retried).toBe(true);
      expect(requestImplementation).toHaveBeenCalledWith(
        "/api/threads/10/interactions/1/actions/777/invoke",
        { method: "POST", headers: { "Idempotency-Key": durable ? "saved-gesture" : invocationKey }, body: JSON.stringify({ presentingLayerId: durable ? 202 : 101 }) },
      );
      expect(controller.appState.actionInvocations[0].resultCompletionStatus).toBe("running");
      expect(controller.viewState).toMatchObject({ currentThreadId: 10, currentInteractionId: 1 });
    } finally {
      try {
        retireOwnedControllers();
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it.each([
    ["submitted", false, 1],
    ["running", true, 1],
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
          expect(options).toEqual({ method: "POST", headers: { "Idempotency-Key": invocationKey }, body: JSON.stringify({ presentingLayerId: 101 }) });
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
      try {
        retireOwnedControllers();
      } finally {
        vi.useRealTimers();
      }
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
        try {
          retireOwnedControllers();
        } finally {
          vi.useRealTimers();
        }
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
      try {
        retireOwnedControllers();
      } finally {
        vi.useRealTimers();
      }
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
      try {
        retireOwnedControllers();
      } finally {
        vi.useRealTimers();
      }
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

  it("revalidates a descendant loaded by direct navigation when Back restores it", async () => {
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
    // Native keys and genuine Product result IDs are separate namespaces.
    const calls = [
      { sourceInteractionId: 1, actionId: 502, resultInteractionId: 42, durable: true, invocationKey: "human-key" },
      { sourceInteractionId: 1, actionId: 502, resultInteractionId: null, durable: true, graphOnly: true, invocationKey: "42" },
    ];
    state.actionInvocations = calls;
    const originalRequest = requestImplementation;
    requestImplementation = vi.fn(async (path, options) => path === "/api/threads/10"
      ? { thread: state.threads[0], interactions: [turn], actionInvocations: calls, invocationInventoryAvailable: true }
      : originalRequest(path, options));
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
    expect(controller.appState.actionInvocations).toEqual(calls);
    expect(requestImplementation.mock.calls.filter(([path]) => path.endsWith("/layers/102")))
      .toHaveLength(2);
  });

  it.each([true, false])("rolls back the presentation without advancing the cursor when application fails (inventory=%s)", async (priorAvailable) => {
    const turn1 = interaction(1, 10, rootLayer(101, 11));
    const turn2 = interaction(2, 20, rootLayer(201, 21));
    const state1 = productState([{ id: 10, title: "First" }, { id: 20, title: "Second" }], [turn1]);
    const state2 = productState([{ id: 10, title: "First" }, { id: 20, title: "Second" }], [turn2]);
    state2.invocationInventoryAvailable = priorAvailable;
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) return state1;
      if (path.startsWith("/api/state?threadId=20")) return state2;
      if (path === "/api/threads/10") {
        return { thread: state1.threads[0], interactions: [turn1], actionInvocations: [], invocationInventoryAvailable: !priorAvailable };
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
    expect(controller.appState.invocationInventoryAvailable).toBe(priorAvailable);

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
      try {
        retireOwnedControllers();
      } finally {
        vi.useRealTimers();
      }
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
      try {
        retireOwnedControllers();
      } finally {
        vi.useRealTimers();
      }
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
        const stateMatch = path.match(/^\/api\/state\?threadId=(\d+)(?:&|$)/);
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
      expect(requestImplementation.mock.calls.filter(([path]) => path.startsWith("/api/state?threadId=30")))
        .toHaveLength(1);
      restoreFirst.resolve({ thread: threads[0], interactions: [turn1], actionInvocations: [] });

      await expect(latest).resolves.toMatchObject({ threadId: "10", turnId: "1" });
      expect(controller.viewState.currentThreadId).toBe(10);
    } finally {
      try {
        retireOwnedControllers();
      } finally {
        vi.useRealTimers();
      }
    }
  });
});

it("interaction graph selection reloads the current response root and retains Back to the descendant", async()=>{
 const root=rootLayer(101,11);root.layer.defaultNodeId=11;
 const child=rootLayer(102,12);const action={id:501,kind:"navigate",relation:"expand",sourceNodeId:11,targetLayerId:102};root.actions=[action];const turn=interaction(1,10,root);
 const state=productState([{id:10,title:"Thread"}],[turn]);
 requestImplementation=vi.fn(async(path)=>{
  if(path.startsWith("/api/state?threadId=10"))return state;
  if(path==="/api/threads/10/interactions/1/layers/102")return child;
  if(path==="/api/threads/10")return {thread:state.threads[0],interactions:[turn],actionInvocations:[]};
  throw new Error(`Unexpected request: ${path}`);
 });
 const controller=await loadModules();
 try {
  await controller.loadThread(10);await controller.navigateLayer(102,{action,sourceNode:root.nodes[0]});
  expect(controller.appState.visibleLayer.layer.id).toBe(102);
  controller.selectTurnById(1,{responseRoot:true});
  expect(controller.appState.visibleLayer.layer.id).toBe(101);
  expect(controller.getNavigationHistory().canGoBack).toBe(true);
  await controller.navigateHistory(-1);
  expect(controller.appState.visibleLayer.layer.id).toBe(102);
 }finally{controller.cancelNavigationHistory();}
});

it("interaction graph cross-chat selection commits only a loaded response and preserves Back", async () => {
  const source = interaction(1, 10, rootLayer(101, 11));
  const target = interaction(2, 20, rootLayer(201, 21));
  const threads = [{ id: 10, title: "Source" }, { id: 20, title: "Owner", projectId: 8 }];
  let fail = true;
  requestImplementation = vi.fn(async (path) => {
    if (path.startsWith("/api/state?threadId=10")) return productState(threads, [source]);
    if (path.startsWith("/api/state?threadId=20")) return productState(threads, [target]);
    if (path === "/api/threads/20") {
      if (fail) throw new Error("owner unavailable");
      return { thread: threads[1], interactions: [target], actionInvocations: [] };
    }
    if (path === "/api/threads/10") return { thread: threads[0], interactions: [source], actionInvocations: [] };
    throw new Error(`Unexpected request: ${path}`);
  });
  const controller = await loadModules();
  try {
    await controller.loadThread(10);
    const preference = await import("../desktop/renderer/src/project-sidebar.js");
    preference.setProjectCollapsed(8, true);
    const url = location.href;
    await expect(controller.selectTurnById(2, { responseRoot: true, threadId: 20 })).rejects.toThrow("owner unavailable");
    expect(preference.projectCollapsed(8)).toBe(true);
    expect(controller.viewState.currentThreadId).toBe(10);
    expect(controller.viewState.currentInteractionId).toBe(1);
    expect(controller.appState.visibleLayer.layer.id).toBe(101);
    expect(location.href).toBe(url);
    fail = false;
    target.completionStatus = "running";
    const acceptedOutput = target.completionOutput;
    target.completionOutput = null;
    await expect(controller.selectTurnById(2, { responseRoot: true, threadId: 20 })).resolves.toBe(false);
    expect(controller.viewState.currentThreadId).toBe(10);
    expect(controller.appState.visibleLayer.layer.id).toBe(101);
    expect(location.href).toBe(url);
    target.completionStatus = "accepted";
    target.completionOutput = acceptedOutput;
    await controller.selectTurnById(2, { responseRoot: true, threadId: 20 });
    expect(preference.projectCollapsed(8)).toBe(false);
    expect(controller.viewState.currentThreadId).toBe(20);
    expect(controller.appState.visibleLayer.layer.id).toBe(201);
    await controller.navigateHistory(-1);
    expect(controller.viewState.currentThreadId).toBe(10);
    expect(controller.appState.visibleLayer.layer.id).toBe(101);
  } finally { controller.cancelNavigationHistory(); }
});

it("keeps the workspace when a graph origin has current state but no response", async () => {
  const current = rootLayer(101, 11);
  const source = { ...interaction(1, 10, current), graphNodeId: 901, completionStatus: "running", completionOutput: null };
  const state = productState([{ id: 10 }], [source]);
  requestImplementation = vi.fn(async () => state);
  const controller = await loadModules();
  try {
    await controller.loadThread(10);
    controller.appState.visibleLayer = current;
    controller.appState.currentProjections.set("901", { completionId: 901, headRevision: 1, lifecycle: "active", currentLayerId: 101 });
    controller.selectTurnById(1, { responseRoot: true });
    expect(controller.appState.visibleLayer).toEqual(current);
    expect(controller.getNavigationHistory().canGoBack).toBe(false);
  } finally { controller.cancelNavigationHistory(); }
});


it.each(["failed", "stopped", "running", "pending"])("navigates to a local %s interaction without retaining the accepted response", async (status) => {
  const accepted = interaction(1, 10, rootLayer(101, 11));
  const unfinished = { ...interaction(2, 10, null, 2), completionStatus: status, completionOutput: null };
  const state = productState([{ id: 10, title: "Thread" }], [accepted, unfinished]);
  requestImplementation = vi.fn(async (path) => {
    if (path.startsWith("/api/state?threadId=10")) return state;
    if (path === "/api/threads/10") return { invocationInventoryAvailable: state.invocationInventoryAvailable, thread: state.threads[0], interactions: state.interactions, actionInvocations: [] };
    throw new Error(`Unexpected request: ${path}`);
  });
  const controller = await loadModules();
  try {
    await controller.loadThread(10);
    controller.selectTurnById(1, { responseRoot: true });
    expect(controller.appState.visibleLayer.layer.id).toBe(101);
    controller.selectTurnById(2, { responseRoot: false, threadId: 10 });
    expect(controller.viewState.currentInteractionId).toBe(2);
    expect(controller.appState.visibleLayer).toBeNull();
    await controller.navigateHistory(-1);
    expect(controller.appState.visibleLayer.layer.id).toBe(101);
    await controller.navigateHistory(1);
    expect(controller.viewState.currentInteractionId).toBe(2);
    expect(controller.appState.visibleLayer).toBeNull();
  } finally { controller.cancelNavigationHistory(); }
});
