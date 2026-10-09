import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let requestImplementation;
let controller;
const modelSelection = { providerId: "openai", modelId: "gpt-5" };
const layer = (id, ids) => ({
  layer: { id, nodes: ids },
  nodes: ids.map((nodeId) => ({ id: nodeId, title: `Node ${nodeId}` })),
  edges: [], actions: [],
});
const oldLayer = layer(101, [11, 12]);
const resultLayer = layer(201, [21]);
const source = { id: 1, threadId: 10, graphNodeId: 901, sequence: 1, text: "Original", completionStatus: "accepted", completionOutput: { rootLayer: oldLayer } };
const pending = { id: 2, threadId: 10, graphNodeId: 902, sequence: 2, text: "Follow-up", completionStatus: "running" };
function state(turn = null, projection = null) {
  return {
    projects: [], threads: [{ id: 10, title: "Reading context" }],
    interactions: [source, ...(turn ? [turn] : [])], actionInvocations: [],
    capabilities: { canCompose: true },
    ...(projection ? { currentProjection: { cursor: projection.headRevision, hasMore: false, events: [], states: [projection] } } : {}),
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function setup({ post, readLayer, invokePost } = {}) {
  let current = state();
  requestImplementation = vi.fn(async (path, options) => {
    if (path.startsWith("/api/state?threadId=10")) return current;
    if (path.endsWith("/actions/777/invoke") && invokePost) return invokePost.promise;
    if (path === "/api/threads/10/interactions" && options?.method === "POST") {
      current = state(pending);
      return post ? post.promise : pending;
    }
    if (path.includes("/interactions/2/layers/")) return readLayer ? readLayer(path) : resultLayer;
    throw new Error(`Unexpected request: ${path}`);
  });
  await controller.loadThread(10);
  controller.viewState.mainView = "thread";
  return { setState(next) { current = next; } };
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  Object.assign(globalThis, {
    document: { querySelector: () => null },
    location: new URL("http://127.0.0.1:43123/"),
    window: { relayerDesktop: undefined, relayerEvalReview: undefined },
    history: { replaceState: vi.fn((_state, _title, url) => { globalThis.location = new URL(url); }) },
  });
  vi.doMock("../desktop/renderer/src/api.js", () => ({ request: (...args) => requestImplementation(...args) }));
  vi.doMock("../desktop/renderer/src/graph.js", () => ({ renderThread: vi.fn() }));
  vi.doMock("../desktop/renderer/src/navigation.js", () => ({ renderScopeMenu: vi.fn(), renderSidebar: vi.fn(), setMainView: vi.fn(), setSettingsTab: vi.fn() }));
  vi.doMock("../desktop/renderer/src/onboarding-tutorial.js", () => ({ onboardingTutorialController: () => ({ followupSubmitted: vi.fn(), actionSucceeded: vi.fn() }) }));
  controller = { ...await import("../desktop/renderer/src/state.js"), ...await import("../desktop/renderer/src/threads.js") };
});
afterEach(() => {
  controller?.cancelNavigationHistory();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function expectOldSelection(nodeId = 11) {
  expect(controller.viewState.currentInteractionId).toBe(1);
  expect(controller.appState.visibleLayer).toEqual(oldLayer);
  expect(controller.viewState.selectedNodeId).toBe(nodeId);
}

describe("follow-up reading context at the production thread controller", () => {
  it("preserves reading until accepted output exists, then opens its first node", async () => {
    const fixture = await setup();
    await controller.submitInteraction("Follow-up", modelSelection);
    expectOldSelection();
    fixture.setState(state({ ...pending, completionStatus: "accepted", completionOutput: { rootLayer: resultLayer } }));
    await controller.refreshState(10);
    expect(controller.viewState.currentInteractionId).toBe(2);
    expect(controller.appState.visibleLayer).toEqual(resultLayer);
    expect(controller.viewState.selectedNodeId).toBe(21);
  });

  it("opens accepted intermediate current while the turn still runs", async () => {
    const fixture = await setup();
    await controller.submitInteraction("Follow-up", modelSelection);
    expectOldSelection();
    fixture.setState(state(pending, {
      completionId: 902, headRevision: 1, lifecycle: "active", currentLayerId: 201,
      finalLayerId: null, safeReason: null, temporalFeatures: { projectionUi: true },
    }));
    await controller.refreshState(10);
    expect(controller.viewState.currentInteractionId).toBe(2);
    expect(controller.appState.visibleLayer).toEqual(resultLayer);
    expect(controller.appState.interactions.find(({ id }) => id === 2).completionStatus).toBe("running");
  });

  it("preserves explicit browsing and opens the ready result only on request", async () => {
    const fixture = await setup();
    await controller.submitInteraction("Follow-up", modelSelection);
    controller.replaceCurrentSelection(12);
    fixture.setState(state({ ...pending, completionStatus: "accepted", completionOutput: { rootLayer: resultLayer } }));
    await controller.refreshState(10);
    expectOldSelection(12);
    expect(controller.appState.pendingTurn?.readyLayer).toEqual(resultLayer);
    await controller.openReadyResult();
    expect(controller.viewState.currentInteractionId).toBe(2);
    expect(controller.viewState.selectedNodeId).toBe(21);
  });

  it.each(["failed", "stopped"])("keeps old output when the pending turn becomes %s before readiness", async (completionStatus) => {
    const fixture = await setup();
    await controller.submitInteraction("Follow-up", modelSelection);
    fixture.setState(state({ ...pending, completionStatus }));
    await controller.refreshState(10);
    expectOldSelection();
    expect(controller.appState.interactions.find(({ id }) => id === 2).completionStatus).toBe(completionStatus);
    expect(controller.appState.pendingTurn?.readyLayer ?? null).toBeNull();
  });

  it("honors a node choice made before the send response returns", async () => {
    const post = deferred();
    const fixture = await setup({ post });
    const sending = controller.submitInteraction("Follow-up", modelSelection);
    controller.replaceCurrentSelection(12);
    post.resolve(pending);
    await sending;
    fixture.setState(state({ ...pending, completionStatus: "accepted", completionOutput: { rootLayer: resultLayer } }));
    await controller.refreshState(10);
    expectOldSelection(12);
    expect(controller.appState.pendingTurn?.readyLayer).toEqual(resultLayer);
  });

  it("cancels following when graph selection crosses threads before the POST returns", async () => {
    const post = deferred();
    const fixture = await setup({ post });
    const baseRequest = requestImplementation;
    const ownerLoad = deferred();
    const other = { ...source, id: 3, threadId: 20, completionOutput: { rootLayer: resultLayer } };
    requestImplementation = vi.fn(async (path, options) => {
      if (path === "/api/threads/20") return ownerLoad.promise;
      if (path === "/api/threads/10") return { thread: { id: 10 }, interactions: [source, pending], actionInvocations: [] };
      if (path.startsWith("/api/state?threadId=20")) return { ...state(), interactions: [other] };
      return baseRequest(path, options);
    });
    const sending = controller.submitInteraction("Follow-up", modelSelection);
    const selecting = controller.selectTurnById(3, { responseRoot: true, threadId: 20 });
    post.resolve(pending);
    await sending;
    expect(controller.appState.pendingTurn.auto).toBe(false);
    ownerLoad.resolve({ thread: { id: 20 }, interactions: [other], actionInvocations: [] });
    await selecting;
    await controller.navigateHistory(-1);
    fixture.setState(state({ ...pending, completionStatus: "accepted", completionOutput: { rootLayer: resultLayer } }));
    await controller.refreshState(10);
    expectOldSelection("11");
  });

  it.each([1, 2])("keeps a newer node choice during accepted-layer read %s", async (deferredRead) => {
    const readStarted = deferred();
    const result = deferred();
    let reads = 0;
    const fixture = await setup({ readLayer: () => {
      reads += 1;
      if (reads !== deferredRead) return resultLayer;
      readStarted.resolve();
      return result.promise;
    } });
    await controller.submitInteraction("Follow-up", modelSelection);
    fixture.setState(state(pending, {
      completionId: 902, headRevision: 1, lifecycle: "active", currentLayerId: 201,
      finalLayerId: null, safeReason: null, temporalFeatures: { projectionUi: true },
    }));
    const refreshing = controller.refreshState(10);
    await readStarted.promise;
    controller.replaceCurrentSelection(12);
    result.resolve(resultLayer);
    await refreshing;
    expectOldSelection(12);
    await controller.refreshState(10);
    expectOldSelection(12);
    expect(controller.appState.pendingTurn?.readyLayer).toEqual(resultLayer);
  });


  // The thread tracks one pending turn, for its message turns. Invoked runs run beside each other,
  // so an invoked result stays on its source node and in the turn list instead of a ready prompt.
  it("keeps an invoked result discoverable after browsing during its POST", async () => {
    const invokePost = deferred();
    const fixture = await setup({ invokePost });
    const older = { ...source, id: 3, graphNodeId: 903, sequence: 0 };
    const initial = state();
    initial.interactions = [older, source];
    fixture.setState(initial);
    await controller.refreshState(10);
    const invoking = controller.invokeAction({ id: 777, kind: "invoke", sourceNodeId: 11 });
    controller.selectTurnById(3);
    const result = { ...pending, completionStatus: "accepted", completionOutput: { rootLayer: resultLayer } };
    const updated = state(result);
    updated.interactions = [older, source, result];
    fixture.setState(updated);
    invokePost.resolve({ created: true, interaction: result, invocation: {
      sourceInteractionId: 1, actionId: 777, resultInteractionId: 2, resultCompletionStatus: "accepted",
    } });
    await invoking;
    await controller.refreshState(10);
    expect(controller.viewState.currentInteractionId).toBe(3);
    expect(controller.appState.pendingTurn ?? null).toBeNull();
    controller.selectTurnById(2);
    expect(controller.viewState.currentInteractionId).toBe(2);
  });


  it("opens the latest ready current and continues following later accepted currents", async () => {
    const second = layer(202, [22]);
    const third = layer(203, [23]);
    const outputs = { 201: resultLayer, 202: second, 203: third };
    const fixture = await setup({ readLayer: (path) => outputs[path.split("/").at(-1)] });
    await controller.submitInteraction("Follow-up", modelSelection);
    controller.replaceCurrentSelection(12);
    const projected = (revision, layerId) => state(pending, {
      completionId: 902, headRevision: revision, lifecycle: "active", currentLayerId: layerId,
      finalLayerId: null, safeReason: null, temporalFeatures: { projectionUi: true },
    });
    fixture.setState(projected(1, 201));
    await controller.refreshState(10);
    fixture.setState(projected(2, 202));
    await controller.refreshState(10);
    expectOldSelection(12);
    await controller.openReadyResult();
    expect(controller.appState.visibleLayer).toEqual(second);
    fixture.setState(projected(3, 203));
    await controller.refreshState(10);
    expect(controller.appState.visibleLayer).toEqual(third);
  });


  it("recovers following when the newest ready layer temporarily fails to load", async () => {
    const nextLayer = layer(202, [22]);
    let unavailable = true;
    const fixture = await setup({ readLayer: (path) => {
      if (path.endsWith("/201")) return resultLayer;
      if (unavailable) throw new Error("temporary layer read failure");
      return nextLayer;
    } });
    await controller.submitInteraction("Follow-up", modelSelection);
    controller.replaceCurrentSelection(12);
    const projected = (revision, layerId) => state(pending, {
      completionId: 902, headRevision: revision, lifecycle: "active", currentLayerId: layerId,
      finalLayerId: null, safeReason: null, temporalFeatures: { projectionUi: true },
    });
    fixture.setState(projected(1, 201));
    await controller.refreshState(10);
    fixture.setState(projected(2, 202));
    await controller.refreshState(10);
    expectOldSelection(12);
    await controller.openReadyResult();
    expect(controller.appState.visibleLayer).toEqual(resultLayer);
    unavailable = false;
    await controller.refreshState(10);
    expect(controller.appState.visibleLayer).toEqual(nextLayer);
  });


  it.each(["draft", "stopped", "empty"])("does not treat %s layer data as a ready result", async (kind) => {
    const unsuitable = kind === "empty" ? layer(201, []) : {
      ...resultLayer, layer: { ...resultLayer.layer, state: kind },
    };
    const fixture = await setup();
    await controller.submitInteraction("Follow-up", modelSelection);
    fixture.setState(state({ ...pending, completionOutput: { rootLayer: unsuitable } }));
    await controller.refreshState(10);
    expectOldSelection();
    expect(controller.appState.pendingTurn?.readyLayer ?? null).toBeNull();
    fixture.setState(state({ ...pending, completionStatus: "accepted", completionOutput: { rootLayer: resultLayer } }));
    await controller.refreshState(10);
    expect(controller.appState.visibleLayer).toEqual(resultLayer);
  });

});
