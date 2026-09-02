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

  it("loads accepted temporal results and submits follow-ups through tutorial and occurrence gates", async () => {
    const root = rootLayer(101, 11);
    const turn = { ...interaction(1, 10, root), graphNodeId: 901 };
    const followup = {
      id: 2,
      threadId: 10,
      sequence: 2,
      text: "A follow-up",
      completionStatus: "submitted",
    };
    const annotationTurn = {
      id: 3,
      threadId: 10,
      sequence: 3,
      text: "",
      completionStatus: "submitted",
    };
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
    let submissions = 0;
    let stateReads = 0;
    const contexts = [{
      target: { nodeId: 11, sourceInteractionNodeId: 901, sourceLayerId: 101 },
      annotations: ["Use this node"],
    }];
    requestImplementation = vi.fn(async (path, options) => {
      if (path.startsWith("/api/state?threadId=10")) {
        stateReads += 1;
        const interactions = [turn];
        if (submissions >= 1) interactions.push(followup);
        if (submissions >= 2) interactions.push(annotationTurn);
        return { ...state, interactions };
      }
      if (path.endsWith("/interactions/1/layers/101")) return root;
      if (path === "/api/threads/10/interactions") {
        const body = JSON.parse(options.body);
        if (submissions === 0) {
          expect(options.method, "the follow-up posts").toBe("POST");
          expect(body, "the follow-up payload carries the composed model selection").toEqual({
            text: "A follow-up",
            inputId: expect.any(String),
            contexts: [],
            contextConfirmationIds: [],
            modelSelection: { providerId: "openai", modelId: "gpt-5" },
          });
        } else {
          expect(options.method, "the annotation-only follow-up posts").toBe("POST");
          expect(body, "the annotation-only payload keeps stable occurrence identity").toEqual({
            text: "",
            inputId: expect.any(String),
            contexts,
            contextConfirmationIds: [],
            modelSelection: { providerId: "openai", modelId: "gpt-5" },
          });
        }
        submissions += 1;
        return submissions === 1 ? followup : annotationTurn;
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();

    await controller.loadThread(10);
    expect(controller.appState.status, "the accepted product status survives the temporal render")
      .toBe("accepted");
    expect(controller.appState.temporalLifecycle, "the succeeded temporal current renders")
      .toBe("succeeded");
    expect(controller.appState.visibleLayer, "the temporal layer is visible").toBe(root);
    expect(controller.appState.nodes.map(({ id }) => id), "the temporal nodes render")
      .toEqual([11]);

    const completionPersistence = deferred();
    tutorialFollowupSubmitted = vi.fn(() => completionPersistence.promise);
    const readsBeforeFollowup = stateReads;
    const submitting = controller.submitInteraction(
      "A follow-up",
      { providerId: "openai", modelId: "gpt-5" },
    );
    await vi.waitFor(() => expect(
      tutorialFollowupSubmitted,
      "the tutorial observes the submitted follow-up",
    ).toHaveBeenCalledOnce());
    expect(tutorialFollowupSubmitted, "the tutorial receives the follow-up identity")
      .toHaveBeenCalledWith({ threadId: 10, interactionId: 2 });
    expect(stateReads, "no refresh happens before tutorial persistence settles")
      .toBe(readsBeforeFollowup);
    expect(controller.viewState.currentInteractionId, "the cursor holds until persistence settles")
      .toBe(1);

    completionPersistence.resolve(true);
    await expect(submitting, "the submission resolves once persistence settles")
      .resolves.toEqual(followup);
    expect(stateReads, "persistence settlement refreshes exactly once")
      .toBe(readsBeforeFollowup + 1);
    expect(controller.viewState.currentInteractionId, "the cursor follows the submitted follow-up")
      .toBe(2);

    tutorialFollowupSubmitted = vi.fn();
    await expect(controller.submitInteraction(
      "",
      { providerId: "openai", modelId: "gpt-5" },
      contexts,
    ), "annotation-only submissions resolve").resolves.toEqual(annotationTurn);
    expect(controller.viewState.currentInteractionId, "the cursor follows the annotation-only turn")
      .toBe(3);
  }, 20_000);

  it("restores history destinations and lets the newest intent win over slow restorations", async () => {
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
    const restored = await loadModules();

    await restored.loadThread(10);
    restored.replaceCurrentSelection(11);
    await restored.loadThread(20);
    await restored.navigateHistory(-1);
    expect(restored.viewState, "Back restores thread, turn, and numeric node selection")
      .toMatchObject({
        currentThreadId: 10,
        currentInteractionId: 1,
        selectedNodeId: "11",
      });
    expect(restored.viewState.layerPath.map(({ layerId }) => layerId),
      "the restored path is the root layer").toEqual([101]);
    expect(globalThis.location.searchParams.get("threadId"), "the deep link follows the thread")
      .toBe("10");
    expect(globalThis.location.searchParams.get("interactionId"), "the deep link follows the turn")
      .toBe("1");
    expect(restored.getNavigationHistory(), "the cursor can only go forward again")
      .toMatchObject({
        canGoBack: false,
        canGoForward: true,
        forwardChangesTurn: true,
        pendingDirection: null,
      });

    const turn2a = interaction(2, 20, layer2, 1);
    const turn2b = interaction(3, 20, layer2, 2);
    const supersededState2 = productState(
      [{ id: 10, title: "First" }, { id: 20, title: "Second" }],
      [turn2a, turn2b],
    );
    const restoreQueue = [];
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) return state1;
      if (path.startsWith("/api/state?threadId=20")) return supersededState2;
      if (path === "/api/threads/10") {
        const pending = deferred();
        restoreQueue.push(pending);
        return pending.promise;
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const racing = await loadModules();
    await racing.loadThread(10);
    await racing.loadThread(20);

    const beforeCommit = vi.fn();
    const pending = racing.navigateHistory(-1, { beforeCommit });
    await vi.waitFor(() => expect(
      racing.getNavigationHistory().pendingDirection,
      "Back shows as pending while its destination loads",
    ).toBe("back"));
    racing.selectTurnById(2);
    expect(racing.getNavigationHistory().pendingDirection,
      "a newer turn choice clears the pending direction").toBeNull();
    restoreQueue[0].resolve({ thread: state1.threads[0], interactions: [turn1], actionInvocations: [] });
    await expect(pending, "the slower history restoration is superseded")
      .rejects.toMatchObject({ code: "navigation_superseded" });
    expect(beforeCommit, "superseded restorations never commit").not.toHaveBeenCalled();
    expect(racing.viewState, "the newer turn choice owns the view")
      .toMatchObject({ currentThreadId: 20, currentInteractionId: 2 });

    const cancelRestore = deferred();
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) return state1;
      if (path.startsWith("/api/state?threadId=20")) return state2;
      if (path === "/api/threads/10") return cancelRestore.promise;
      throw new Error(`Unexpected request: ${path}`);
    });
    const cancelling = await loadModules();
    await cancelling.loadThread(10);
    await cancelling.loadThread(20);
    const pendingCancel = cancelling.navigateHistory(-1);
    await vi.waitFor(() => expect(
      cancelling.getNavigationHistory().pendingDirection,
      "Back shows as pending while its destination loads",
    ).toBe("back"));
    const beforeCancelRenders = rendered;
    cancelling.cancelNavigationHistory();
    expect(rendered, "shell focus cancellation renders nothing").toBe(beforeCancelRenders);
    cancelRestore.resolve({ thread: state1.threads[0], interactions: [turn1], actionInvocations: [] });
    await expect(pendingCancel, "cancelled restorations are superseded")
      .rejects.toMatchObject({ code: "navigation_superseded" });
    expect(rendered, "the late restoration renders nothing either").toBe(beforeCancelRenders);
    expect(cancelling.viewState, "the view stays with the newest selection")
      .toMatchObject({ currentThreadId: 20, currentInteractionId: 2 });

    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) return state1;
      if (path.startsWith("/api/state?threadId=20")) return state2;
      if (path === "/api/threads/10") {
        return { thread: state1.threads[0], interactions: [turn1], actionInvocations: [] };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const rollback = await loadModules();
    await rollback.loadThread(10);
    await rollback.loadThread(20);
    throwOnRender = rendered + 2;
    const beforeFailedCommit = vi.fn();
    await expect(rollback.navigateHistory(-1, { beforeCommit: beforeFailedCommit }),
      "an application failure rejects the navigation").rejects.toThrow("injected render failure");
    expect(beforeFailedCommit, "failed applications never commit").not.toHaveBeenCalled();
    expect(rollback.viewState, "the presentation rolls back to the previous view")
      .toMatchObject({ currentThreadId: 20, currentInteractionId: 2 });
    expect(rollback.getNavigationHistory(), "the cursor does not advance on failure")
      .toMatchObject({
        canGoBack: true,
        canGoForward: false,
        pendingDirection: null,
      });

    const navRoot = rootLayer(101, 11);
    navRoot.actions = [{ id: 501, kind: "navigate", sourceNodeId: 11, targetLayerId: 102 }];
    const child = rootLayer(102, 12);
    const navTurn = interaction(1, 10, navRoot);
    const navState = productState([{ id: 10, title: "First" }], [navTurn]);
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) return navState;
      if (path === "/api/threads/10") {
        return { thread: navState.threads[0], interactions: [navTurn], actionInvocations: [] };
      }
      if (path.endsWith("/layers/102")) return child;
      throw new Error(`Unexpected request: ${path}`);
    });
    const reuse = await loadModules();
    await reuse.loadThread(10);
    await reuse.navigateLayer(102, {
      action: navRoot.actions[0],
      sourceNode: navRoot.nodes[0],
    });
    await reuse.navigateLayer(101, { restore: true, pathIndex: 0 });
    expect(reuse.getNavigationHistory(), "descendant navigation stays inside the turn")
      .toMatchObject({
        canGoBack: true,
        backChangesTurn: false,
      });
    await reuse.navigateHistory(-1);
    expect(reuse.appState.visibleLayer.layer.id, "Back restores the direct descendant")
      .toBe(102);
    expect(requestImplementation.mock.calls.filter(([path]) => path.endsWith("/layers/102")),
      "the descendant layer is reused, not refetched").toHaveLength(1);
  }, 20_000);

  it("navigates resolved invokes across threads and yields to newer selections and intents", async () => {
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
    }), "a resolved invoke opens its destination").resolves.toBe(true);
    expect(beforeInvokeCommit, "the invoke commits through beforeCommit").toHaveBeenCalledOnce();
    expect(controller.viewState, "the invoke lands at the destination turn without selection")
      .toMatchObject({
        currentThreadId: 20,
        currentInteractionId: 2,
        selectedNodeId: null,
      });
    expect(controller.viewState.layerPath.map(({ layerId }) => layerId),
      "the destination opens at its root layer").toEqual([201]);
    expect(controller.getNavigationHistory().canGoBack, "the invoke is history-navigable")
      .toBe(true);
    expect(controller.appState.actionInvocations, "the destination owns its accepted invocation")
      .toEqual([acceptedInvocation]);

    const beforeHistoryCommit = vi.fn();
    await controller.navigateHistory("back", { beforeCommit: beforeHistoryCommit });
    expect(beforeHistoryCommit, "Back commits through beforeCommit").toHaveBeenCalledOnce();
    expect(controller.viewState, "Back returns to the invoke source")
      .toMatchObject({ currentThreadId: 10, currentInteractionId: 1 });
    expect(controller.viewState.layerPath.map(({ layerId }) => layerId),
      "Back restores the source root layer").toEqual([101]);
    expect(controller.appState.actionInvocations, "Back keeps the destination's invocation state")
      .toEqual([acceptedInvocation]);

    await controller.navigateHistory("forward");
    expect(controller.viewState, "Forward replays the invoke destination")
      .toMatchObject({ currentThreadId: 20, currentInteractionId: 2 });
    expect(controller.appState.actionInvocations, "Forward keeps the accepted invocation")
      .toEqual([acceptedInvocation]);

    await controller.navigateHistory("back");
    await controller.navigateHistory("forward");
    expect(controller.viewState, "repeated Back/Forward stays stable")
      .toMatchObject({ currentThreadId: 20, currentInteractionId: 2 });
    expect(controller.appState.actionInvocations, "invocation state survives history replays")
      .toHaveLength(1);
    expect(controller.appState.actionInvocations[0].resultCompletionStatus,
      "the invocation stays accepted").toBe("accepted");

    const threadSupersededLayer = rootLayer(101, 11);
    const threadSupersededAction = { id: 501, kind: "invoke", sourceNodeId: 11, targetLayerId: 201 };
    threadSupersededLayer.actions = [threadSupersededAction];
    const threadSupersededSource = interaction(1, 10, threadSupersededLayer);
    const other = interaction(3, 30, rootLayer(301, 31));
    const destinationRead = deferred();
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) {
        return productState([{ id: 10, title: "Source" }, { id: 30, title: "Other" }], [threadSupersededSource]);
      }
      if (path.startsWith("/api/state?threadId=30")) {
        return productState([{ id: 10, title: "Source" }, { id: 30, title: "Other" }], [other]);
      }
      if (path.endsWith("/actions/501/destination")) return destinationRead.promise;
      throw new Error(`Unexpected request: ${path}`);
    });
    const threadRacing = await loadModules();
    await threadRacing.loadThread(10);
    const pendingThreadInvoke = threadRacing.navigateResolvedInvoke(threadSupersededAction);
    await threadRacing.loadThread(30);
    destinationRead.resolve({
      actionId: 501,
      actionKind: "invoke",
      targetLayerId: 201,
      threadId: 20,
      interactionId: 2,
      rootLayerId: 201,
    });
    await expect(pendingThreadInvoke, "a newer thread selection beats the invoke destination")
      .resolves.toBe(false);
    expect(threadRacing.viewState, "the newer thread owns the view")
      .toMatchObject({ currentThreadId: 30, currentInteractionId: 3 });

    const nodeSupersededLayer = rootLayer(101, 11);
    nodeSupersededLayer.nodes.push({ id: 12, title: "Node 12" });
    const nodeSupersededAction = { id: 501, kind: "invoke", sourceNodeId: 11, targetLayerId: 201 };
    nodeSupersededLayer.actions = [nodeSupersededAction];
    const nodeSupersededSource = interaction(1, 10, nodeSupersededLayer);
    const nodeDestination = interaction(2, 20, rootLayer(201, 21));
    const nodeDestinationRead = deferred();
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) {
        return productState([{ id: 10, title: "Source" }, { id: 20, title: "Result" }], [nodeSupersededSource]);
      }
      if (path.endsWith("/actions/501/destination")) return nodeDestinationRead.promise;
      if (path === "/api/threads/20") {
        return {
          thread: { id: 20, title: "Result" },
          interactions: [nodeDestination],
          actionInvocations: [],
        };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const nodeRacing = await loadModules();
    await nodeRacing.loadThread(10);
    nodeRacing.replaceCurrentSelection(11);
    const beforeNodeCommit = vi.fn();

    const pendingNodeInvoke = nodeRacing.navigateResolvedInvoke(nodeSupersededAction, {
      beforeCommit: beforeNodeCommit,
    });
    expect(nodeRacing.getNavigationHistory().pendingResolvedInvokeNavigation,
      "the pending invoke navigation is visible while resolving").toBe(true);
    nodeRacing.replaceCurrentSelection(12);
    expect(nodeRacing.getNavigationHistory().pendingResolvedInvokeNavigation,
      "a newer node selection cancels the pending invoke").toBe(false);
    nodeDestinationRead.resolve({
      actionId: 501,
      actionKind: "invoke",
      targetLayerId: 201,
      threadId: 20,
      interactionId: 2,
      rootLayerId: 201,
    });
    await expect(pendingNodeInvoke, "the destination is dropped for the newer selection")
      .resolves.toBe(false);
    expect(beforeNodeCommit, "superseded invokes never commit").not.toHaveBeenCalled();
    expect(nodeRacing.viewState, "the newer selection owns the view")
      .toMatchObject({
        currentThreadId: 10,
        currentInteractionId: 1,
        selectedNodeId: 12,
      });
    expect(requestImplementation, "the superseded destination thread is never loaded")
      .not.toHaveBeenCalledWith("/api/threads/20");

    const backPrevious = interaction(1, 5, rootLayer(51, 6));
    const backSourceLayer = rootLayer(101, 11);
    const backAction = { id: 501, kind: "invoke", sourceNodeId: 11, targetLayerId: 201 };
    backSourceLayer.actions = [backAction];
    const backSource = interaction(2, 10, backSourceLayer);
    const backThreads = [{ id: 5, title: "Previous" }, { id: 10, title: "Source" }];
    const backDestinationRead = deferred();
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=5")) return productState(backThreads, [backPrevious]);
      if (path.startsWith("/api/state?threadId=10")) return productState(backThreads, [backSource]);
      if (path.endsWith("/actions/501/destination")) return backDestinationRead.promise;
      if (path === "/api/threads/5") {
        return { thread: backThreads[0], interactions: [backPrevious], actionInvocations: [] };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const backRacing = await loadModules();
    await backRacing.loadThread(5);
    await backRacing.loadThread(10);

    const pendingBackInvoke = backRacing.navigateResolvedInvoke(backAction);
    expect(backRacing.getNavigationHistory().pendingResolvedInvokeNavigation,
      "the invoke navigation is pending while its destination resolves").toBe(true);
    const pendingBackIntent = backRacing.navigateHistory("back");
    await expect(pendingBackIntent, "a newer Back intent resolves first")
      .resolves.toMatchObject({ threadId: "5", turnId: "1" });
    backDestinationRead.resolve({
      actionId: 501,
      actionKind: "invoke",
      targetLayerId: 201,
      threadId: 20,
      interactionId: 3,
      rootLayerId: 201,
    });
    await expect(pendingBackInvoke, "the Back intent cancels the pending invoke")
      .resolves.toBe(false);
    expect(backRacing.getNavigationHistory().pendingResolvedInvokeNavigation,
      "no invoke navigation remains pending").toBe(false);
    expect(backRacing.viewState, "Back owns the view")
      .toMatchObject({ currentThreadId: 5, currentInteractionId: 1 });
  }, 20_000);

  it("keeps visible layers fresh without letting stale reads clobber newer navigation", async () => {
    const pollRoot = rootLayer(101, 11);
    pollRoot.actions = [{ id: 501, kind: "navigate", sourceNodeId: 11, targetLayerId: 102 }];
    const pollChild = rootLayer(102, 12);
    const pollTurn = interaction(1, 10, pollRoot);
    const pollState = productState([{ id: 10, title: "First" }], [pollTurn]);
    const staleRefresh = deferred();
    let pollStateReads = 0;
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) {
        pollStateReads += 1;
        return pollStateReads === 1 ? pollState : staleRefresh.promise;
      }
      if (path.endsWith("/layers/102")) return pollChild;
      throw new Error(`Unexpected request: ${path}`);
    });
    const pollController = await loadModules();
    await pollController.loadThread(10);
    const polling = pollController.refreshState(10);
    await pollController.navigateLayer(102, {
      action: pollRoot.actions[0],
      sourceNode: pollRoot.nodes[0],
    });
    staleRefresh.resolve(pollState);
    await expect(polling, "a stale poll discards itself after descendant navigation")
      .resolves.toBe(false);
    expect(pollController.appState.visibleLayer.layer.id, "the descendant stays visible")
      .toBe(102);
    expect(pollController.viewState.layerPath.map(({ layerId }) => layerId),
      "the descendant path survives the stale poll").toEqual([101, 102]);

    const leaseRoot = rootLayer(101, 11);
    leaseRoot.actions = [{ id: 501, kind: "navigate", sourceNodeId: 11, targetLayerId: 102 }];
    const staleChild = rootLayer(102, 12);
    staleChild.actions = [{ id: 777, kind: "invoke", sourceNodeId: 12, targetLayerId: null }];
    const canonicalChild = rootLayer(102, 12);
    canonicalChild.actions = [{ id: 777, kind: "invoke", sourceNodeId: 12, targetLayerId: 303 }];
    const leaseTurn = interaction(1, 10, leaseRoot);
    const leaseInitial = productState([{ id: 10, title: "Source" }], [leaseTurn]);
    const leaseResolved = productState([{ id: 10, title: "Source" }], [leaseTurn]);
    leaseResolved.actionInvocations = [{
      sourceInteractionId: 99,
      actionId: 777,
      resultInteractionId: 100,
    }];
    let leaseStateReads = 0;
    let leaseLayerReads = 0;
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) {
        leaseStateReads += 1;
        return leaseStateReads === 1 ? leaseInitial : leaseResolved;
      }
      if (path.endsWith("/layers/102")) {
        leaseLayerReads += 1;
        return leaseLayerReads === 1 ? staleChild : canonicalChild;
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const leaseController = await loadModules();
    await leaseController.loadThread(10);
    await leaseController.navigateLayer(102, {
      action: leaseRoot.actions[0],
      sourceNode: leaseRoot.nodes[0],
    });
    expect(leaseController.appState.visibleLayer.actions[0].targetLayerId,
      "the nested invoke starts unresolved").toBeNull();

    await leaseController.refreshState(10);
    expect(leaseController.appState.visibleLayer.actions[0],
      "a project-visible lease resolution refreshes the open nested invoke")
      .toMatchObject({ id: 777, kind: "invoke", targetLayerId: 303 });
    expect(leaseLayerReads, "the refresh refetches the visible nested layer").toBe(2);

    const clobberRoot = rootLayer(101, 11);
    clobberRoot.actions = [{ id: 501, kind: "navigate", sourceNodeId: 11, targetLayerId: 102 }];
    const clobberChild = rootLayer(102, 12);
    clobberChild.actions = [{ id: 777, kind: "invoke", sourceNodeId: 12, targetLayerId: null }];
    const canonicalChildRead = deferred();
    const clobberSource = interaction(1, 10, clobberRoot);
    const clobberOther = interaction(2, 20, rootLayer(201, 21));
    const clobberInitial = productState(
      [{ id: 10, title: "Source" }, { id: 20, title: "Other" }],
      [clobberSource],
    );
    const clobberResolvedState = productState(
      [{ id: 10, title: "Source" }, { id: 20, title: "Other" }],
      [clobberSource],
    );
    clobberResolvedState.actionInvocations = [{
      sourceInteractionId: 99,
      actionId: 777,
      resultInteractionId: 100,
    }];
    let clobberSourceReads = 0;
    let clobberLayerReads = 0;
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) {
        clobberSourceReads += 1;
        return clobberSourceReads === 1 ? clobberInitial : clobberResolvedState;
      }
      if (path.startsWith("/api/state?threadId=20")) {
        return productState([{ id: 10, title: "Source" }, { id: 20, title: "Other" }], [clobberOther]);
      }
      if (path.endsWith("/layers/102")) {
        clobberLayerReads += 1;
        return clobberLayerReads === 1 ? clobberChild : canonicalChildRead.promise;
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const clobberController = await loadModules();
    await clobberController.loadThread(10);
    await clobberController.navigateLayer(102, {
      action: clobberRoot.actions[0],
      sourceNode: clobberRoot.nodes[0],
    });
    const slowRefresh = clobberController.refreshState(10);
    await vi.waitFor(() => expect(clobberLayerReads, "the refresh refetches the nested layer").toBe(2));
    expect(clobberController.viewState, "the source thread is still visible")
      .toMatchObject({ currentThreadId: 10, currentInteractionId: 1 });
    expect(clobberController.viewState.layerPath.map(({ layerId }) => layerId),
      "the nested path is still open").toEqual([101, 102]);
    expect(clobberController.appState.visibleLayer, "the stale child layer is visible")
      .toBe(clobberChild);
    expect(clobberController.appState.visibleLayer.actions[0].targetLayerId,
      "the nested invoke is still unresolved").toBeNull();

    await clobberController.loadThread(20);
    canonicalChildRead.resolve({
      ...clobberChild,
      actions: [{ id: 777, kind: "invoke", sourceNodeId: 12, targetLayerId: 303 }],
    });
    await expect(slowRefresh, "the slow nested refresh yields to the newer thread")
      .resolves.toBe(false);
    expect(clobberController.viewState, "the newer thread selection survives the slow refresh")
      .toMatchObject({ currentThreadId: 20, currentInteractionId: 2 });
    expect(clobberController.appState.visibleLayer.layer.id, "the new thread's layer is visible")
      .toBe(201);

    const backPollTurn1 = interaction(1, 10, rootLayer(101, 11));
    const runningTurn = {
      id: 2,
      threadId: 20,
      sequence: 1,
      text: "Running turn",
      completionStatus: "running",
      completionOutput: null,
    };
    const acceptedTurn = interaction(2, 20, rootLayer(201, 21));
    const backPollState1 = productState(
      [{ id: 10, title: "First" }, { id: 20, title: "Second" }],
      [backPollTurn1],
    );
    const runningState = productState(backPollState1.threads, [runningTurn]);
    const acceptedState = productState(backPollState1.threads, [acceptedTurn]);
    const sourcePoll = deferred();
    const backRestore = deferred();
    let thread20Reads = 0;
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) return backPollState1;
      if (path.startsWith("/api/state?threadId=20")) {
        thread20Reads += 1;
        return thread20Reads === 1 ? runningState : sourcePoll.promise;
      }
      if (path === "/api/threads/10") return backRestore.promise;
      throw new Error(`Unexpected request: ${path}`);
    });
    const backPollController = await loadModules();
    await backPollController.loadThread(10);
    await backPollController.loadThread(20);
    const inFlightPoll = backPollController.refreshState(20);
    const pendingBack = backPollController.navigateHistory(-1);

    sourcePoll.resolve(acceptedState);
    await expect(inFlightPoll, "the in-flight source poll yields to Back").resolves.toBe(false);
    backRestore.resolve({
      thread: backPollState1.threads[0],
      interactions: [backPollTurn1],
      actionInvocations: [],
    });
    await expect(pendingBack, "Back wins over the source poll")
      .resolves.toMatchObject({ threadId: "10", turnId: "1" });
    expect(backPollController.viewState, "Back owns the view despite the poll")
      .toMatchObject({ currentThreadId: 10, currentInteractionId: 1 });

    const abaRoot = rootLayer(101, 11);
    abaRoot.actions = [{ id: 501, kind: "navigate", sourceNodeId: 11, targetLayerId: 102 }];
    const abaChild = rootLayer(102, 12);
    const abaTurn1 = interaction(1, 10, abaRoot, 1);
    const abaTurn2 = interaction(2, 10, rootLayer(201, 21), 2);
    const abaState = productState([{ id: 10, title: "First" }], [abaTurn1, abaTurn2]);
    const abaLayerRequest = deferred();
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) return abaState;
      if (path.endsWith("/layers/102")) return abaLayerRequest.promise;
      throw new Error(`Unexpected request: ${path}`);
    });
    const abaController = await loadModules(
      "http://127.0.0.1:43123/?threadId=10&interactionId=1",
    );
    await abaController.loadThread(10);
    abaController.selectTurnById(1);
    const pendingLayer = abaController.navigateLayer(102, {
      action: abaRoot.actions[0],
      sourceNode: abaRoot.nodes[0],
    });
    abaController.selectTurnById(2);
    abaController.selectTurnById(1);
    abaLayerRequest.resolve(abaChild);
    await expect(pendingLayer, "the ABA sequence settles the stale layer navigation silently")
      .resolves.toBeUndefined();
    expect(abaController.viewState.currentInteractionId, "the explicit turn choice survives")
      .toBe(1);
    expect(abaController.appState.visibleLayer.layer.id, "the stale layer response is rejected")
      .toBe(101);
    expect(abaController.viewState.layerPath.map(({ layerId }) => layerId),
      "the layer path resets to the root").toEqual([101]);
  }, 20_000);

  it("arbitrates scheduled polling around invoke lifecycles and explicit turn choices", async () => {
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
      expect(controller.appState.interactions, "the reused source loads its turn").toHaveLength(1);
      expect(controller.appState.interactions[0].id, "the loaded turn is current").toBe(1);
      expect(controller.appState.visibleLayer.actions[0].targetLayerId,
        "the invoke starts unresolved").toBeNull();

      await vi.advanceTimersByTimeAsync(500);
      expect(controller.appState.visibleLayer.actions[0],
        "polling resolves the reused source invoke while it runs elsewhere")
        .toMatchObject({ id: 777, kind: "invoke", targetLayerId: 303 });
      expect(controller.appState.actionInvocations[0].resultCompletionStatus,
        "the invocation settles to accepted").toBe("accepted");
      expect(stateReads, "one poll refreshes state").toBe(2);
      expect(layerReads, "one poll refreshes the visible layer").toBe(2);
    } finally {
      vi.useRealTimers();
    }

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
      expect(stateReads, "the import loads once").toBe(1);
      expect(controller.appState.interactions[0].projectionFresh,
        "the imported projection starts stale").toBe(false);

      await vi.advanceTimersByTimeAsync(500);
      expect(stateReads, "the stale import retries until fresh").toBe(2);
      expect(controller.appState.interactions[0].projectionFresh,
        "the retry lands on the fresh projection").toBe(true);
      expect(vi.getTimerCount(), "fresh projections stop retrying").toBe(0);
    } finally {
      vi.useRealTimers();
    }

    vi.useFakeTimers();
    try {
      const retryRoot = rootLayer(101, 11);
      const retryAction = {
        id: 777,
        kind: "invoke",
        sourceNodeId: 11,
        targetLayerId: null,
        interactionText: "Resume the leased result",
      };
      retryRoot.actions = [retryAction];
      const retrySource = interaction(1, 10, retryRoot);
      const submitted = productState([{ id: 10, title: "Recovery source" }], [retrySource]);
      submitted.actionInvocations = [{
        sourceInteractionId: 99,
        actionId: 777,
        resultInteractionId: 100,
        resultCompletionStatus: "submitted",
      }];
      const retryRunning = productState([{ id: 10, title: "Recovery source" }], [retrySource]);
      retryRunning.actionInvocations = [{
        ...submitted.actionInvocations[0],
        resultCompletionStatus: "running",
      }];
      let retried = false;
      requestImplementation = vi.fn(async (path, options) => {
        if (path.startsWith("/api/state?threadId=10")) return retried ? retryRunning : submitted;
        if (path.endsWith("/layers/101")) return retryRoot;
        if (path === "/api/threads/10/interactions/1/actions/777/invoke") {
          expect(options, "the retry posts").toEqual({ method: "POST" });
          retried = true;
          return {
            created: false,
            invocation: retryRunning.actionInvocations[0],
            interaction: { id: 100, threadId: 20, completionStatus: "running" },
          };
        }
        throw new Error(`Unexpected request: ${path}`);
      });
      const controller = await loadModules();

      await controller.loadThread(10);
      await controller.invokeAction(retryAction);
      expect(retried, "a project-visible submitted invocation retries through invoke").toBe(true);
      expect(requestImplementation, "the retry reuses the same source action")
        .toHaveBeenCalledWith("/api/threads/10/interactions/1/actions/777/invoke", { method: "POST" });
      expect(controller.appState.actionInvocations[0].resultCompletionStatus,
        "the retry lands on the running invocation").toBe("running");
      expect(controller.viewState, "the retry stays on the source turn")
        .toMatchObject({ currentThreadId: 10, currentInteractionId: 1 });
    } finally {
      vi.useRealTimers();
    }

    const tutorialCases = [
      ["submitted", false, 1],
      ["running", true, 100],
    ];
    expect(tutorialCases, "tutorial advancement inventory").toHaveLength(2);
    for (const [resultCompletionStatus, shouldAdvance, expectedInteractionId] of tutorialCases) {
      vi.useFakeTimers();
      try {
        const tutorialRoot = rootLayer(101, 11);
        const tutorialAction = {
          id: 777,
          kind: "invoke",
          sourceNodeId: 11,
          targetLayerId: null,
          interactionText: "Explore this node",
        };
        tutorialRoot.actions = [tutorialAction];
        const tutorialSource = interaction(1, 10, tutorialRoot);
        const result = {
          id: 100,
          threadId: 10,
          completionStatus: resultCompletionStatus,
        };
        const beforeInvoke = productState([{ id: 10, title: "Tutorial" }], [tutorialSource]);
        const afterInvoke = productState([{ id: 10, title: "Tutorial" }], [tutorialSource, result]);
        afterInvoke.actionInvocations = [{
          sourceInteractionId: 1,
          actionId: 777,
          resultInteractionId: 100,
          resultCompletionStatus,
        }];
        let invoked = false;
        requestImplementation = vi.fn(async (path, options) => {
          if (path.startsWith("/api/state?threadId=10")) return invoked ? afterInvoke : beforeInvoke;
          if (path.endsWith("/layers/101")) return tutorialRoot;
          if (path === "/api/threads/10/interactions/1/actions/777/invoke") {
            expect(options, "the tutorial invoke posts").toEqual({ method: "POST" });
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
        await controller.invokeAction(tutorialAction);
        expect(tutorialActionSucceeded,
          `the invoke tutorial advances only for a non-retryable ${resultCompletionStatus} result`)
          .toHaveBeenCalledTimes(shouldAdvance ? 1 : 0);
        expect(controller.viewState.currentInteractionId,
          `the ${resultCompletionStatus} result places the cursor`).toBe(expectedInteractionId);
        expect(controller.appState.actionInvocations[0].resultCompletionStatus,
          `the ${resultCompletionStatus} invocation status settles`).toBe(resultCompletionStatus);
      } finally {
        vi.useRealTimers();
      }
    }

    const terminalCases = ["failed", "stopped"];
    expect(terminalCases, "terminal outcome inventory").toHaveLength(2);
    for (const resultCompletionStatus of terminalCases) {
      vi.useFakeTimers();
      try {
        const terminalRoot = rootLayer(101, 11);
        terminalRoot.actions = [{ id: 777, kind: "invoke", sourceNodeId: 11, targetLayerId: null }];
        const terminalSource = interaction(1, 10, terminalRoot);
        const terminalState = productState([{ id: 10, title: "Reused source" }], [terminalSource]);
        terminalState.actionInvocations = [{
          sourceInteractionId: 99,
          actionId: 777,
          resultInteractionId: 100,
          resultCompletionStatus,
        }];
        requestImplementation = vi.fn(async (path) => {
          if (path.startsWith("/api/state?threadId=10")) return terminalState;
          throw new Error(`Unexpected request: ${path}`);
        });
        const controller = await loadModules();

        await controller.loadThread(10);
        await vi.advanceTimersByTimeAsync(1_500);
        expect(requestImplementation,
          `a ${resultCompletionStatus} remote result stops polling`).toHaveBeenCalledTimes(1);
        expect(controller.appState.actionInvocations,
          `the ${resultCompletionStatus} invocation stays untouched`)
          .toEqual(terminalState.actionInvocations);
        expect(controller.appState.visibleLayer.actions[0].targetLayerId,
          `the ${resultCompletionStatus} action stays unresolved`).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    }

    vi.useFakeTimers();
    try {
      const oneShotStaleRoot = rootLayer(101, 11);
      oneShotStaleRoot.actions = [{ id: 777, kind: "invoke", sourceNodeId: 11, targetLayerId: null }];
      const oneShotCanonicalRoot = rootLayer(101, 11);
      oneShotCanonicalRoot.actions = [{ id: 777, kind: "invoke", sourceNodeId: 11, targetLayerId: 303 }];
      const oneShotSource = interaction(1, 10, oneShotStaleRoot);
      const oneShotState = productState([{ id: 10, title: "Source" }], [oneShotSource]);
      oneShotState.actionInvocations = [{ sourceInteractionId: 1, actionId: 777, resultInteractionId: 2 }];
      let oneShotLayerReads = 0;
      requestImplementation = vi.fn(async (path) => {
        if (path.startsWith("/api/state?threadId=10")) return oneShotState;
        if (path.endsWith("/layers/101")) {
          oneShotLayerReads += 1;
          if (oneShotLayerReads === 1) throw new Error("one-shot graph read failure");
          return oneShotCanonicalRoot;
        }
        throw new Error(`Unexpected request: ${path}`);
      });
      const controller = await loadModules();

      await controller.loadThread(10);
      expect(controller.appState.visibleLayer.actions[0].targetLayerId,
        "the failed canonical read leaves the action unresolved").toBeNull();
      await vi.advanceTimersByTimeAsync(500);
      expect(controller.appState.visibleLayer.actions[0].targetLayerId,
        "the one-shot canonical root failure retries after the terminal result").toBe(303);
      expect(oneShotLayerReads, "the retry refetches the root layer").toBe(2);
    } finally {
      vi.useRealTimers();
    }

    vi.useFakeTimers();
    try {
      const nestedRoot = rootLayer(101, 11);
      nestedRoot.actions = [{ id: 501, kind: "navigate", sourceNodeId: 11, targetLayerId: 102 }];
      const nestedStaleChild = rootLayer(102, 12);
      nestedStaleChild.actions = [{ id: 777, kind: "invoke", sourceNodeId: 12, targetLayerId: null }];
      const nestedCanonicalChild = rootLayer(102, 12);
      nestedCanonicalChild.actions = [{ id: 777, kind: "invoke", sourceNodeId: 12, targetLayerId: 303 }];
      const nestedSource = interaction(1, 10, nestedRoot);
      const nestedInitial = productState([{ id: 10, title: "Source" }], [nestedSource]);
      const nestedResolved = productState([{ id: 10, title: "Source" }], [nestedSource]);
      nestedResolved.actionInvocations = [{ sourceInteractionId: 1, actionId: 777, resultInteractionId: 2 }];
      let nestedStateReads = 0;
      let nestedLayerReads = 0;
      requestImplementation = vi.fn(async (path) => {
        if (path.startsWith("/api/state?threadId=10")) {
          nestedStateReads += 1;
          return nestedStateReads === 1 ? nestedInitial : nestedResolved;
        }
        if (path.endsWith("/layers/102")) {
          nestedLayerReads += 1;
          if (nestedLayerReads === 1) return nestedStaleChild;
          if (nestedLayerReads === 2) throw new Error("one-shot nested graph read failure");
          return nestedCanonicalChild;
        }
        throw new Error(`Unexpected request: ${path}`);
      });
      const controller = await loadModules();
      await controller.loadThread(10);
      await controller.navigateLayer(102, {
        action: nestedRoot.actions[0],
        sourceNode: nestedRoot.nodes[0],
      });

      await controller.refreshState(10);
      expect(controller.appState.visibleLayer.actions[0].targetLayerId,
        "the failed nested read leaves the action unresolved").toBeNull();
      await vi.advanceTimersByTimeAsync(500);
      expect(controller.appState.visibleLayer.actions[0].targetLayerId,
        "the one-shot nested failure retries after the terminal result").toBe(303);
      expect(nestedLayerReads, "the retry refetches the nested layer").toBe(3);
    } finally {
      vi.useRealTimers();
    }

    vi.useFakeTimers();
    try {
      const acceptedTurn = interaction(1, 10, rootLayer(101, 11), 1);
      const explicitRunningTurn = {
        id: 2,
        threadId: 10,
        sequence: 2,
        text: "Running turn",
        completionStatus: "running",
        completionOutput: null,
      };
      const threads = [{ id: 10, title: "First" }];
      const initialState = productState(threads, [acceptedTurn, explicitRunningTurn]);
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
      expect(timersDuringExplicitRender,
        "an explicit turn choice schedules no poll of its own").toBe(0);

      await vi.advanceTimersByTimeAsync(500);
      expect(stateReads, "the scheduled poll fires once").toBe(2);

      controller.selectTurnById(2);
      stalePoll.resolve(staleState);
      await vi.advanceTimersByTimeAsync(0);
      expect(controller.viewState, "the explicit turn choice survives the stale poll")
        .toMatchObject({
          currentThreadId: 10,
          currentInteractionId: 2,
        });
      await vi.advanceTimersByTimeAsync(499);
      expect(stateReads, "the stale poll does not reschedule early").toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(stateReads, "polling resumes on its normal cadence").toBe(3);
    } finally {
      vi.useRealTimers();
    }

    vi.useFakeTimers();
    try {
      const resumeRoot = rootLayer(101, 11);
      resumeRoot.actions = [{ id: 501, kind: "navigate", sourceNodeId: 11, targetLayerId: 102 }];
      const resumeChild = rootLayer(102, 12);
      const resumeRunningTurn = {
        id: 1,
        threadId: 10,
        sequence: 1,
        text: "Running turn",
        completionStatus: "running",
        completionOutput: null,
      };
      const resumeAcceptedTurn = interaction(2, 10, resumeRoot, 2);
      const threads = [{ id: 10, title: "First" }];
      const resumeState = productState(threads, [resumeRunningTurn, resumeAcceptedTurn]);
      const resumeStalePoll = deferred();
      const resumeLayerRequest = deferred();
      let stateReads = 0;
      requestImplementation = vi.fn(async (path) => {
        if (path.startsWith("/api/state?threadId=10")) {
          stateReads += 1;
          if (stateReads === 2) return resumeStalePoll.promise;
          return resumeState;
        }
        if (path.endsWith("/layers/102")) return resumeLayerRequest.promise;
        throw new Error(`Unexpected request: ${path}`);
      });
      const controller = await loadModules();
      await controller.loadThread(10);
      await vi.advanceTimersByTimeAsync(500);
      expect(stateReads, "the running turn polls").toBe(2);

      const pendingLayer = controller.navigateLayer(102, {
        action: resumeRoot.actions[0],
        sourceNode: resumeRoot.nodes[0],
      });
      resumeLayerRequest.resolve(resumeChild);
      await pendingLayer;
      resumeStalePoll.resolve(resumeState);
      await vi.advanceTimersByTimeAsync(0);
      expect(controller.appState.visibleLayer.layer.id, "descendant navigation wins the race")
        .toBe(102);
      expect(controller.viewState.layerPath.map(({ layerId }) => layerId),
        "the descendant path commits").toEqual([101, 102]);
      await vi.advanceTimersByTimeAsync(499);
      expect(stateReads, "the superseded poll does not reschedule early").toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(stateReads, "polling resumes after the superseded poll").toBe(3);
    } finally {
      vi.useRealTimers();
    }

    vi.useFakeTimers();
    try {
      const overlapTurn1 = interaction(1, 10, rootLayer(101, 11));
      const overlapTurn2 = interaction(2, 20, rootLayer(201, 21));
      const overlapRunningTurn = {
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
        ["10", productState(threads, [overlapTurn1])],
        ["20", productState(threads, [overlapTurn2])],
        ["30", productState(threads, [overlapRunningTurn])],
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
      restoreSecond.resolve({ thread: threads[1], interactions: [overlapTurn2], actionInvocations: [] });
      await expect(stale, "the stale overlapping transition is superseded")
        .rejects.toMatchObject({ code: "navigation_superseded" });
      await vi.advanceTimersByTimeAsync(600);
      expect(requestImplementation.mock.calls.filter(([path]) => path.startsWith("/api/state?threadId=30")),
        "the stale transition never restarts source polling").toHaveLength(1);
      restoreFirst.resolve({ thread: threads[0], interactions: [overlapTurn1], actionInvocations: [] });

      await expect(latest, "the latest transition still lands")
        .resolves.toMatchObject({ threadId: "10", turnId: "1" });
      expect(controller.viewState.currentThreadId, "the newest intent owns the view").toBe(10);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});
