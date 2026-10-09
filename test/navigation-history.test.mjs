import { describe, expect, it, vi } from "vitest";

import {
  createAcceptedLayerCache,
  createLatestRequestGate,
  createNavigationHistory,
  navigationEntriesChangeTurn,
  navigationEntriesEqual,
  normalizeNavigationEntry,
} from "../desktop/renderer/src/navigation-history.js";

function entry({
  threadId = 1,
  turnId = 10,
  navigationPath = [{ layerId: 100, viaActionId: null }],
  selectedNodeId = null,
  temporalCurrent = null,
} = {}) {
  return { threadId, turnId, navigationPath, selectedNodeId, temporalCurrent };
}

function layerIdentity(layerId, threadId = 1, turnId = 10) {
  return { threadId, turnId, layerId };
}

function frozenImportedOrigin() {
  return { kind: "imported", invocationId: "invocation:call-a", invocationKey: "invocation:call-a",
    actionId: "action:invoke", sourceNodeId: "node:parent", presentingLayerId: "source-layer:invocation:call-a",
    sourceEntry: entry({ turnId: "source:invocation:call-a", selectedNodeId: "node:parent",
      navigationPath: [{ layerId: "source-layer:invocation:call-a", viaActionId: null }] }) };
}

describe("frozen imported source history identity", () => {
  it("retains one tagged per-call presentation without changing canonical numeric origins", () => {
    const origin = frozenImportedOrigin();
    const normalized = normalizeNavigationEntry({ ...entry(), invocationOrigin: origin });
    expect(normalized.invocationOrigin).toEqual({ ...origin, sourceEntry: normalizeNavigationEntry(origin.sourceEntry) });
    expect(Object.isFrozen(normalized.invocationOrigin.sourceEntry.navigationPath)).toBe(true);
    const history = createNavigationHistory();
    history.seed(normalized);
    history.push(entry());
    const transition = history.go(-1);
    expect(history.commit(transition)).toBe(true);
    expect(history.current.invocationOrigin).toEqual(normalized.invocationOrigin);
    for (const kind of [undefined, "imported", "graph"]) {
      const canonical = { sourceEntry: entry({ turnId: 9, selectedNodeId: 7 }), actionId: 41,
        sourceNodeId: 7, presentingLayerId: 100, invocationKey: "call-native", ...(kind ? { kind, invocationId: "71" } : {}) };
      expect(normalizeNavigationEntry({ ...entry(), invocationOrigin: canonical }).invocationOrigin).toMatchObject({
        sourceEntry: { turnId: "9" }, actionId: "41", sourceNodeId: "7", presentingLayerId: "100" });
    }
  });

  it.each([
    "swapped-call", "swapped-layer", "wrong-key", "graph-kind", "untagged", "temporal",
    "invalid-action", "invalid-node", "invalid-call", "oversized-call", "selected-node",
    "extra-ancestor", "via-action", "cross-thread", "portable-canonical-turn",
  ])("rejects a frozen source with %s provenance", corruption => {
    const origin = frozenImportedOrigin();
    if (corruption === "swapped-call") origin.invocationId = "invocation:call-b";
    if (corruption === "swapped-layer") origin.presentingLayerId = origin.sourceEntry.navigationPath[0].layerId = "source-layer:invocation:call-b";
    if (corruption === "wrong-key") origin.invocationKey = "invocation:call-b";
    if (corruption === "graph-kind") origin.kind = "graph";
    if (corruption === "untagged") delete origin.kind;
    if (corruption === "temporal") origin.sourceEntry.temporalCurrent = { completionId: "node:parent", revision: 1, mode: "pinned" };
    if (corruption === "invalid-action") origin.actionId = "action:path/to/invoke";
    if (corruption === "invalid-node") origin.sourceNodeId = origin.sourceEntry.selectedNodeId = "node:";
    if (corruption === "invalid-call") origin.invocationId = "invocation:call/a";
    if (corruption === "oversized-call") origin.invocationId = `invocation:${"a".repeat(128)}`;
    if (corruption === "selected-node") origin.sourceEntry.selectedNodeId = "node:other";
    if (corruption === "extra-ancestor") origin.sourceEntry.navigationPath.unshift({ layerId: "source-layer:other", viaActionId: null });
    if (corruption === "via-action") origin.sourceEntry.navigationPath[0].viaActionId = "action:ancestor";
    if (corruption === "cross-thread") origin.sourceEntry.threadId = 2;
    if (corruption === "portable-canonical-turn") origin.sourceEntry.turnId = 9;
    expect(() => normalizeNavigationEntry({ ...entry(), invocationOrigin: origin })).toThrow();
  });
});

describe("navigation history", () => {
  it("preserves exact invocation origin in history while rejecting nested or cross-thread identity", () => {
    const sourceEntry = entry({ turnId: 9, selectedNodeId: 7 });
    const origin = { sourceEntry, actionId: 41, invocationKey: "call-one", sourceNodeId: 7,
      presentingLayerId: 100, label: "Untrusted label", icon: "Untrusted icon" };
    const child = normalizeNavigationEntry({ ...entry(), invocationOrigin: origin });
    expect(child.invocationOrigin).toEqual({ sourceEntry: normalizeNavigationEntry(sourceEntry),
      actionId: "41", invocationKey: "call-one", sourceNodeId: "7", presentingLayerId: "100" });
    sourceEntry.navigationPath[0].layerId = 999;
    expect(child.invocationOrigin.sourceEntry.navigationPath[0].layerId).toBe("100");
    expect(Object.isFrozen(child.invocationOrigin)).toBe(true);
    const history = createNavigationHistory();
    history.seed(entry());
    history.push(child);
    const second = { ...child, invocationOrigin: { ...child.invocationOrigin, invocationKey: "call-two" } };
    history.push(second);
    expect(history.size).toBe(3);
    expect(navigationEntriesEqual(child, second)).toBe(false);
    const back = history.go(-1);
    history.commit(back);
    expect(history.current).toEqual(child);
    const forward = history.go(1);
    history.commit(forward);
    expect(history.current.invocationOrigin.invocationKey).toBe("call-two");
    for (const invalid of [
      { ...child.invocationOrigin, sourceEntry: { ...child.invocationOrigin.sourceEntry, threadId: 2 } },
      { ...child.invocationOrigin, sourceEntry: { ...child.invocationOrigin.sourceEntry, invocationOrigin: origin } },
      { ...child.invocationOrigin, presentingLayerId: 999 },
      { ...child.invocationOrigin, sourceNodeId: null },
      { ...child.invocationOrigin, invocationKey: "legacy" },
    ]) expect(() => normalizeNavigationEntry({ ...entry(), invocationOrigin: invalid })).toThrow();
    expect(normalizeNavigationEntry(entry())).not.toHaveProperty("invocationOrigin");
  });

  it("distinguishes turn changes from navigation within one turn", () => {
    const current = entry();
    expect(navigationEntriesChangeTurn(current, entry({
      navigationPath: [{ layerId: 101, viaActionId: 501 }],
    }))).toBe(false);
    expect(navigationEntriesChangeTurn(current, entry({ turnId: 11 }))).toBe(true);
    expect(navigationEntriesChangeTurn(current, entry({ threadId: 2 }))).toBe(true);
    expect(navigationEntriesChangeTurn(current, entry({ threadId: 2, turnId: 10 }))).toBe(true);
  });

  it("normalizes logical IDs and clones the path into an immutable entry", () => {
    const source = entry({
      navigationPath: [
        { layerId: 100, viaActionId: null },
        { layerId: 101, viaActionId: 501 },
      ],
      selectedNodeId: 7,
    });
    const normalized = normalizeNavigationEntry(source);

    source.navigationPath[1].layerId = 999;
    expect(normalized).toEqual({
      threadId: "1",
      turnId: "10",
      navigationPath: [
        { layerId: "100", viaActionId: null },
        { layerId: "101", viaActionId: "501" },
      ],
      selectedNodeId: "7",
      temporalCurrent: null,
    });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.navigationPath)).toBe(true);
    expect(Object.isFrozen(normalized.navigationPath[0])).toBe(true);
  });

  it("persists normalized temporal follow intent in the history entry", () => {
    const normalized = normalizeNavigationEntry(entry({
      temporalCurrent: { completionId: 42, revision: 3, mode: "following" },
    }));
    expect(normalized.temporalCurrent).toEqual({
      completionId: "42",
      revision: 3,
      mode: "following",
    });
    expect(Object.isFrozen(normalized.temporalCurrent)).toBe(true);
  });

  it("seeds exactly once and deduplicates an adjacent logical presentation", () => {
    const history = createNavigationHistory();

    expect(history.seed(entry())).toBe(true);
    expect(history.seed(entry({ turnId: 11 }))).toBe(false);
    expect(history.push(entry({ threadId: "1", turnId: "10" }))).toBe(false);
    expect(history.size).toBe(1);
    expect(history.index).toBe(0);
    expect(history.canGoBack).toBe(false);
    expect(history.canGoForward).toBe(false);
  });

  it("treats authored paths as identity even when their destination layer matches", () => {
    const left = entry({ navigationPath: [
      { layerId: 100, viaActionId: null },
      { layerId: 200, viaActionId: 501 },
    ] });
    const right = entry({ navigationPath: [
      { layerId: 100, viaActionId: null },
      { layerId: 200, viaActionId: 502 },
    ] });

    expect(navigationEntriesEqual(left, right)).toBe(false);
    const history = createNavigationHistory();
    history.seed(left);
    expect(history.push(right)).toBe(true);
    expect(history.size).toBe(2);
  });

  it("replaces selection in place without adding a step", () => {
    const history = createNavigationHistory();
    history.seed(entry());

    expect(history.replaceSelection(77)).toBe(true);
    expect(history.current.selectedNodeId).toBe("77");
    expect(history.size).toBe(1);
    expect(history.replaceSelection("77")).toBe(false);
    expect(history.replaceSelection(null)).toBe(true);
    expect(history.current.selectedNodeId).toBeNull();
  });

  it("inspects a multi-entry destination and commits it only after resolution", () => {
    const metadata = vi.fn((target, context) => ({
      label: `${context.direction}:${target.threadId}:${target.turnId}`,
    }));
    const history = createNavigationHistory({ destinationMetadata: metadata });
    history.seed(entry({ turnId: 10 }));
    history.push(entry({ turnId: 11 }));
    history.push(entry({ threadId: 2, turnId: 20 }));

    const transition = history.go(-2);
    expect(history.isCurrentTransition(transition)).toBe(true);
    expect(transition).toMatchObject({
      delta: -2,
      direction: "back",
      sourceIndex: 2,
      index: 0,
      entry: { threadId: "1", turnId: "10" },
      metadata: { label: "back:1:10" },
    });
    expect(history.index).toBe(2);
    expect(history.commit(transition)).toBe(true);
    expect(history.isCurrentTransition(transition)).toBe(false);
    expect(history.index).toBe(0);
    expect(history.canGoForward).toBe(true);
    expect(history.go(-1)).toBeNull();
  });

  it("invalidates an inspected transition after a newer navigation intent", () => {
    const history = createNavigationHistory();
    history.seed(entry({ turnId: 10 }));
    history.push(entry({ turnId: 11 }));
    const stale = history.go(-1);

    history.push(entry({ turnId: 12 }));
    expect(history.commit(stale)).toBe(false);
    expect(history.current.turnId).toBe("12");
  });

  it("lets the latest inspected history intent win when async resolutions race", () => {
    const history = createNavigationHistory();
    history.seed(entry({ turnId: 10 }));
    history.push(entry({ turnId: 11 }));
    history.push(entry({ turnId: 12 }));
    const stale = history.go(-1);
    const latest = history.go(-2);

    expect(history.commit(stale)).toBe(false);
    expect(history.commit(latest)).toBe(true);
    expect(history.current.turnId).toBe("10");
  });

  it("lets direct navigation supersede an in-flight restoration", () => {
    const history = createNavigationHistory();
    history.seed(entry({ turnId: 10 }));
    history.push(entry({ turnId: 11 }));
    const pending = history.go(-1);

    history.cancelPending();

    expect(history.commit(pending)).toBe(false);
    expect(history.current.turnId).toBe("11");
  });

  it("leaves cursor and state untouched when a transition is never committed", () => {
    const history = createNavigationHistory();
    history.seed(entry({ turnId: 10 }));
    history.push(entry({ turnId: 11 }));
    const before = history.entries();

    expect(history.go(-1)?.entry.turnId).toBe("10");
    expect(history.index).toBe(1);
    expect(history.entries()).toEqual(before);
  });

  it("truncates Forward only when a distinct semantic navigation is pushed", () => {
    const history = createNavigationHistory();
    history.seed(entry({ turnId: 10 }));
    history.push(entry({ turnId: 11 }));
    history.push(entry({ turnId: 12 }));
    history.commit(history.go(-1));

    expect(history.push(entry({ turnId: "11" }))).toBe(false);
    expect(history.canGoForward).toBe(true);
    expect(history.push(entry({ turnId: 13 }))).toBe(true);
    expect(history.entries().map(({ turnId }) => turnId)).toEqual(["10", "11", "13"]);
    expect(history.canGoForward).toBe(false);
  });

  it("keeps at most twenty total entries including the current entry", () => {
    const history = createNavigationHistory();
    history.seed(entry({ turnId: 0 }));
    for (let turnId = 1; turnId <= 24; turnId += 1) {
      history.push(entry({ turnId }));
    }

    expect(history.size).toBe(20);
    expect(history.index).toBe(19);
    expect(history.entries()[0].turnId).toBe("5");
    expect(history.go(-19)?.entry.turnId).toBe("5");
    expect(history.go(-20)).toBeNull();
  });
});

describe("accepted descendant-layer cache", () => {
  it("deduplicates in-flight loads across numeric and string identities", async () => {
    const cache = createAcceptedLayerCache();
    let resolveLayer;
    const load = vi.fn(() => new Promise((resolve) => {
      resolveLayer = resolve;
    }));

    const first = cache.getOrLoad(layerIdentity(100), load);
    const second = cache.getOrLoad(layerIdentity("100", "1", "10"), load);
    expect(first).toBe(second);
    expect(cache.inFlightSize).toBe(1);

    await Promise.resolve();
    resolveLayer({ layer: { id: 100 } });
    await expect(first).resolves.toEqual({ layer: { id: 100 } });
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.inFlightSize).toBe(0);
    expect(cache.size).toBe(1);
  });

  it("returns accepted cache hits and refreshes least-recently-used order", async () => {
    const cache = createAcceptedLayerCache({ limit: 2 });
    cache.set(layerIdentity(1), { layer: { id: 1 } });
    cache.set(layerIdentity(2), { layer: { id: 2 } });
    expect(cache.get(layerIdentity(1))).toEqual({ layer: { id: 1 } });
    cache.set(layerIdentity(3), { layer: { id: 3 } });

    expect(cache.has(layerIdentity(1))).toBe(true);
    expect(cache.has(layerIdentity(2))).toBe(false);
    expect(cache.identities().map(({ layerId }) => layerId)).toEqual(["1", "3"]);
  });

  it("never evicts protected current-path layers", () => {
    const cache = createAcceptedLayerCache({ limit: 2 });
    cache.set(layerIdentity(1), { layer: { id: 1 } });
    cache.set(layerIdentity(2), { layer: { id: 2 } });
    cache.setProtected([layerIdentity(1), layerIdentity(2)]);
    cache.set(layerIdentity(3), { layer: { id: 3 } });

    expect(cache.has(layerIdentity(1))).toBe(true);
    expect(cache.has(layerIdentity(2))).toBe(true);
    expect(cache.has(layerIdentity(3))).toBe(false);
    expect(cache.size).toBe(2);
  });

  it("temporarily exceeds its cap when every retained layer is protected", () => {
    const cache = createAcceptedLayerCache({ limit: 1 });
    cache.set(layerIdentity(1), { layer: { id: 1 } });
    cache.setProtected([layerIdentity(1), layerIdentity(2)]);
    cache.set(layerIdentity(2), { layer: { id: 2 } });

    expect(cache.size).toBe(2);
    cache.setProtected([layerIdentity(2)]);
    expect(cache.size).toBe(1);
    expect(cache.has(layerIdentity(1))).toBe(false);
    expect(cache.has(layerIdentity(2))).toBe(true);
  });

  it("does not permanently cache failures or unavailable results", async () => {
    const cache = createAcceptedLayerCache();
    const failure = vi.fn()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ layer: { id: 9 } });

    await expect(cache.getOrLoad(layerIdentity(9), failure)).rejects.toThrow("unavailable");
    expect(cache.size).toBe(0);
    await expect(cache.getOrLoad(layerIdentity(9), failure)).resolves.toBeNull();
    expect(cache.size).toBe(0);
    await expect(cache.getOrLoad(layerIdentity(9), failure)).resolves.toEqual({ layer: { id: 9 } });
    expect(failure).toHaveBeenCalledTimes(3);
    expect(cache.size).toBe(1);
  });

  it("does not repopulate from an in-flight request invalidated by clear", async () => {
    const cache = createAcceptedLayerCache();
    let resolveLayer;
    const pending = cache.getOrLoad(layerIdentity(4), () => new Promise((resolve) => {
      resolveLayer = resolve;
    }));
    await Promise.resolve();
    cache.clear();

    resolveLayer({ layer: { id: 4 } });
    await pending;
    expect(cache.size).toBe(0);
  });

  it("allows callers to reject non-accepted values from permanent storage", async () => {
    const cache = createAcceptedLayerCache({
      isCacheable: (value) => value?.status === "accepted",
    });
    const load = vi.fn()
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValueOnce({ status: "accepted", layer: { id: 3 } });

    await cache.getOrLoad(layerIdentity(3), load);
    expect(cache.size).toBe(0);
    await cache.getOrLoad(layerIdentity(3), load);
    expect(cache.size).toBe(1);
  });
});

describe("latest request gate", () => {
  it("rejects older requests and requests invalidated by direct navigation", () => {
    const gate = createLatestRequestGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
    gate.invalidate();
    expect(gate.isCurrent(second)).toBe(false);
    expect(gate.isCurrent(gate.begin())).toBe(true);
  });
});
