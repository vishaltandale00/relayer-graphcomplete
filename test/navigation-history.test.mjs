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

describe("navigation history", () => {
  it("normalizes entries into immutable identities where authored paths matter", () => {
    const current = entry();
    const turnChangeCases = [
      ["layer navigation within one turn stays on the turn", entry({ navigationPath: [{ layerId: 101, viaActionId: 501 }] }), false],
      ["a turn step changes the turn", entry({ turnId: 11 }), true],
      ["a thread change changes the turn", entry({ threadId: 2 }), true],
      ["same turn in another thread changes the turn", entry({ threadId: 2, turnId: 10 }), true],
    ];
    expect(turnChangeCases, "turn-change corpus").toHaveLength(4);
    for (const [label, next, expected] of turnChangeCases) {
      expect.soft(navigationEntriesChangeTurn(current, next), label).toBe(expected);
    }

    const source = entry({
      navigationPath: [
        { layerId: 100, viaActionId: null },
        { layerId: 101, viaActionId: 501 },
      ],
      selectedNodeId: 7,
    });
    const normalized = normalizeNavigationEntry(source);
    source.navigationPath[1].layerId = 999;
    expect(normalized, "normalization stringifies logical IDs").toEqual({
      threadId: "1",
      turnId: "10",
      navigationPath: [
        { layerId: "100", viaActionId: null },
        { layerId: "101", viaActionId: "501" },
      ],
      selectedNodeId: "7",
      temporalCurrent: null,
    });
    expect(Object.isFrozen(normalized), "entries are frozen").toBe(true);
    expect(Object.isFrozen(normalized.navigationPath), "the path is frozen").toBe(true);
    expect(Object.isFrozen(normalized.navigationPath[0]), "path steps are frozen").toBe(true);

    const temporal = normalizeNavigationEntry(entry({
      temporalCurrent: { completionId: 42, revision: 3, mode: "following" },
    }));
    expect(temporal.temporalCurrent, "temporal follow intent normalizes with the entry")
      .toEqual({ completionId: "42", revision: 3, mode: "following" });
    expect(Object.isFrozen(temporal.temporalCurrent), "temporal intent is frozen").toBe(true);

    const left = entry({ navigationPath: [
      { layerId: 100, viaActionId: null },
      { layerId: 200, viaActionId: 501 },
    ] });
    const right = entry({ navigationPath: [
      { layerId: 100, viaActionId: null },
      { layerId: 200, viaActionId: 502 },
    ] });
    expect(navigationEntriesEqual(left, right),
      "authored paths are identity even when the destination layer matches").toBe(false);
  });

  it("walks the history cursor through seeding, supersession, and capacity", () => {
    const metadata = vi.fn((target, context) => ({
      label: `${context.direction}:${target.threadId}:${target.turnId}`,
    }));
    const history = createNavigationHistory({ destinationMetadata: metadata });

    expect(history.seed(entry()), "the first seed lands").toBe(true);
    expect(history.seed(entry({ turnId: 11 })), "seeding happens exactly once").toBe(false);
    expect(history.push(entry({ threadId: "1", turnId: "10" })), "adjacent duplicates are rejected").toBe(false);
    expect(history.size, "the seed is the only entry").toBe(1);
    expect(history.index, "the cursor sits on the seed").toBe(0);
    expect(history.canGoBack, "a single entry cannot go back").toBe(false);
    expect(history.canGoForward, "a single entry cannot go forward").toBe(false);

    const left = entry({ navigationPath: [
      { layerId: 100, viaActionId: null },
      { layerId: 200, viaActionId: 501 },
    ] });
    const right = entry({ navigationPath: [
      { layerId: 100, viaActionId: null },
      { layerId: 200, viaActionId: 502 },
    ] });
    expect(history.push(left), "an authored path is a new step").toBe(true);
    expect(history.push(right), "the same destination via another action is another step").toBe(true);
    expect(history.size, "authored paths accumulate").toBe(3);

    expect(history.replaceSelection(77), "selection replaces in place").toBe(true);
    expect(history.current.selectedNodeId, "selection normalizes").toBe("77");
    expect(history.size, "selection replacement adds no step").toBe(3);
    expect(history.replaceSelection("77"), "identical selection is a no-op").toBe(false);
    expect(history.replaceSelection(null), "clearing the selection replaces in place").toBe(true);
    expect(history.current.selectedNodeId, "selection clears").toBeNull();

    expect(history.push(entry({ threadId: 2, turnId: 20 })), "another turn extends the stack").toBe(true);
    const transition = history.go(-2);
    expect(history.isCurrentTransition(transition), "inspected transitions are tracked").toBe(true);
    expect(transition, "inspection exposes destination and metadata before commit").toMatchObject({
      delta: -2,
      direction: "back",
      sourceIndex: 3,
      index: 1,
      entry: { threadId: "1", turnId: "10" },
      metadata: { label: "back:1:10" },
    });
    expect(history.index, "the cursor does not move on inspection").toBe(3);
    expect(history.commit(transition), "resolution commits the inspected transition").toBe(true);
    expect(history.isCurrentTransition(transition), "committed transitions retire").toBe(false);
    expect(history.index, "commit moves the cursor").toBe(1);
    expect(history.canGoForward, "committing back opens forward").toBe(true);
    expect(history.go(-2), "walking past the beginning is refused").toBeNull();

    const staleForward = history.go(1);
    history.push(entry({ turnId: 12 }));
    expect(history.commit(staleForward), "a newer intent invalidates the inspected transition").toBe(false);
    expect(history.current.turnId, "the newest push owns the cursor").toBe("12");

    expect(history.push(entry({ turnId: 13 })), "the stack extends for the race").toBe(true);
    const stale = history.go(-1);
    const latest = history.go(-2);
    expect(history.commit(stale), "the older racing intent loses").toBe(false);
    expect(history.commit(latest), "the latest inspected intent wins").toBe(true);
    expect(history.index, "the winner lands on its destination").toBe(1);
    expect(history.current.turnId, "the winning intent restores its authored turn").toBe("10");
    expect(history.current.navigationPath, "the winning entry keeps its authored path").toHaveLength(2);

    const pending = history.go(1);
    history.cancelPending();
    expect(history.commit(pending), "direct navigation supersedes an in-flight restoration").toBe(false);
    expect(history.index, "the cursor stays put after cancellation").toBe(1);

    const before = history.entries();
    expect(history.go(1)?.entry.turnId, "uncommitted inspection still previews").toBe("12");
    expect(history.index, "uncommitted inspection leaves the cursor untouched").toBe(1);
    expect(history.entries(), "uncommitted inspection leaves entries untouched").toEqual(before);

    expect(history.commit(history.go(1)), "step forward to truncate later").toBe(true);
    expect(history.push(entry({ turnId: 12 })), "pushing the current entry is a no-op").toBe(false);
    expect(history.canGoForward, "no-op pushes keep Forward intact").toBe(true);
    expect(history.push(entry({ turnId: 14 })), "a distinct push truncates Forward").toBe(true);
    expect(history.entries().map(({ turnId }) => turnId), "the truncated stack keeps the new branch")
      .toEqual(["10", "10", "12", "14"]);
    expect(history.canGoForward, "Forward closes after truncation").toBe(false);

    const capped = createNavigationHistory();
    capped.seed(entry({ turnId: 0 }));
    for (let turnId = 1; turnId <= 24; turnId += 1) {
      capped.push(entry({ turnId }));
    }
    expect(capped.size, "history caps at twenty entries including the current one").toBe(20);
    expect(capped.index, "the cursor rides the newest entry").toBe(19);
    expect(capped.entries()[0].turnId, "the oldest surviving entry is evicted in order").toBe("5");
    expect(capped.go(-19)?.entry.turnId, "the full back span resolves").toBe("5");
    expect(capped.go(-20), "beyond the cap is refused").toBeNull();
  });
});

describe("accepted descendant-layer cache", () => {
  it("dedupes in-flight loads, evicts by LRU, protects the current path, and rejects uncacheable results", async () => {
    const cache = createAcceptedLayerCache();
    let resolveLayer;
    const load = vi.fn(() => new Promise((resolve) => {
      resolveLayer = resolve;
    }));
    const first = cache.getOrLoad(layerIdentity(100), load);
    const second = cache.getOrLoad(layerIdentity("100", "1", "10"), load);
    expect(first, "numeric and string identities share one in-flight load").toBe(second);
    expect(cache.inFlightSize, "one in-flight load serves both identities").toBe(1);
    await Promise.resolve();
    resolveLayer({ layer: { id: 100 } });
    await expect(first, "the shared load resolves").resolves.toEqual({ layer: { id: 100 } });
    expect(load, "the loader runs once").toHaveBeenCalledTimes(1);
    expect(cache.inFlightSize, "the in-flight slot clears").toBe(0);
    expect(cache.size, "the resolution is cached").toBe(1);

    const lru = createAcceptedLayerCache({ limit: 2 });
    lru.set(layerIdentity(1), { layer: { id: 1 } });
    lru.set(layerIdentity(2), { layer: { id: 2 } });
    expect(lru.get(layerIdentity(1)), "hits return the accepted value").toEqual({ layer: { id: 1 } });
    lru.set(layerIdentity(3), { layer: { id: 3 } });
    expect(lru.has(layerIdentity(1)), "recently used layers survive eviction").toBe(true);
    expect(lru.has(layerIdentity(2)), "least-recently-used layers evict first").toBe(false);
    expect(lru.identities().map(({ layerId }) => layerId), "retention order follows use")
      .toEqual(["1", "3"]);

    const protectedCache = createAcceptedLayerCache({ limit: 2 });
    protectedCache.set(layerIdentity(1), { layer: { id: 1 } });
    protectedCache.set(layerIdentity(2), { layer: { id: 2 } });
    protectedCache.setProtected([layerIdentity(1), layerIdentity(2)]);
    protectedCache.set(layerIdentity(3), { layer: { id: 3 } });
    expect(protectedCache.has(layerIdentity(1)), "protected current-path layers never evict").toBe(true);
    expect(protectedCache.has(layerIdentity(2)), "every protected layer survives").toBe(true);
    expect(protectedCache.has(layerIdentity(3)), "unprotected newcomers yield to protection").toBe(false);
    expect(protectedCache.size, "the cap holds against unprotected writes").toBe(2);

    const overflowing = createAcceptedLayerCache({ limit: 1 });
    overflowing.set(layerIdentity(1), { layer: { id: 1 } });
    overflowing.setProtected([layerIdentity(1), layerIdentity(2)]);
    overflowing.set(layerIdentity(2), { layer: { id: 2 } });
    expect(overflowing.size, "all-protected caches temporarily exceed the cap").toBe(2);
    overflowing.setProtected([layerIdentity(2)]);
    expect(overflowing.size, "releasing protection trims back to the cap").toBe(1);
    expect(overflowing.has(layerIdentity(1)), "released layers evict").toBe(false);
    expect(overflowing.has(layerIdentity(2)), "still-protected layers remain").toBe(true);


    const flaky = createAcceptedLayerCache();
    const failure = vi.fn()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ layer: { id: 9 } });
    await expect(flaky.getOrLoad(layerIdentity(9), failure), "load failures surface")
      .rejects.toThrow("unavailable");
    expect(flaky.size, "failures are not cached").toBe(0);
    await expect(flaky.getOrLoad(layerIdentity(9), failure), "unavailable results surface as null")
      .resolves.toBeNull();
    expect(flaky.size, "unavailable results are not cached").toBe(0);
    await expect(flaky.getOrLoad(layerIdentity(9), failure), "later success resolves")
      .resolves.toEqual({ layer: { id: 9 } });
    expect(failure, "each miss refetches").toHaveBeenCalledTimes(3);
    expect(flaky.size, "success finally caches").toBe(1);

    const cleared = createAcceptedLayerCache();
    let resolveCleared;
    const pending = cleared.getOrLoad(layerIdentity(4), () => new Promise((resolve) => {
      resolveCleared = resolve;
    }));
    await Promise.resolve();
    cleared.clear();
    resolveCleared({ layer: { id: 4 } });
    await pending;
    expect(cleared.size, "clear invalidates in-flight repopulation").toBe(0);

    const picky = createAcceptedLayerCache({
      isCacheable: (value) => value?.status === "accepted",
    });
    const pickyLoad = vi.fn()
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValueOnce({ status: "accepted", layer: { id: 3 } });
    await picky.getOrLoad(layerIdentity(3), pickyLoad);
    expect(picky.size, "non-accepted values pass through without caching").toBe(0);
    await picky.getOrLoad(layerIdentity(3), pickyLoad);
    expect(picky.size, "accepted values cache").toBe(1);
  });
});

describe("latest request gate", () => {
  it("rejects older requests and requests invalidated by direct navigation", () => {
    const gate = createLatestRequestGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(gate.isCurrent(first), "a newer request supersedes the older one").toBe(false);
    expect(gate.isCurrent(second), "the newest request is current").toBe(true);
    gate.invalidate();
    expect(gate.isCurrent(second), "direct navigation invalidates the in-flight request").toBe(false);
    expect(gate.isCurrent(gate.begin()), "a fresh request after invalidation is current").toBe(true);
  });
});
