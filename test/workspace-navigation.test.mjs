import { describe, expect, it, vi } from "vitest";

import { createAcceptedLayerCache } from "../desktop/renderer/src/navigation-history.js";
import {
  descendantLayerIdentities,
  invocationOriginForSource,
  navigationDestinationLabel,
  navigationDestinationMetadata,
  navigationEntryFromView,
  navigationEntryKey,
  resolveNavigationPresentation,
  validateResolvedLayer,
  workspaceUrlForPresentation,
} from "../desktop/renderer/src/workspace-navigation.js";
import { workspaceBreadcrumbItems } from "../desktop/renderer/src/product-workspace/model.js";

function fixture() {
  const root = {
    layer: {
      id: 100,
      layout: { version: 1, placements: [{ nodeId: 10, x: 0.25, y: 0.5 }] },
    },
    nodes: [{ id: 10, title: "Architecture" }],
    actions: [{ id: 501, kind: "navigate", sourceNodeId: 10, targetLayerId: 101 }],
  };
  const child = {
    layer: {
      id: 101,
      layout: { version: 1, placements: [{ nodeId: 11, x: 0.75, y: 0.5 }] },
    },
    nodes: [{ id: 11, title: "API" }],
    actions: [],
  };
  const interaction = {
    id: 2,
    threadId: 7,
    completionStatus: "accepted",
    completionOutput: { rootLayer: root },
  };
  const detail = {
    thread: { id: 7, title: "Navigation history" },
    interactions: [{ id: 1, threadId: 7 }, interaction],
    actionInvocations: [{ sourceInteractionId: 1, actionId: 9 }],
    approvals: [{ request: { requestId: "approval-1" } }],
  };
  return { child, detail, interaction, root };
}

describe("workspace navigation presentation", () => {
  function invocationFixture(current = false) {
    const { root, child: sourceLayer, detail } = fixture();
    root.layer.state = "accepted";
    sourceLayer.layer.state = "accepted";
    sourceLayer.nodes[0] = { ...sourceLayer.nodes[0], state: "accepted", icon: "route" };
    sourceLayer.actions = [{ id: 777, kind: "invoke", state: "accepted", sourceNodeId: 11,
      sourceLayerId: 100, reusable: true }];
    const resultLayer = { layer: { id: 301, state: "accepted" },
      nodes: [{ id: 31, state: "accepted", title: "Result" }], actions: [] };
    detail.interactions.push({ id: 3, threadId: 7, graphNodeId: 303,
      completionStatus: current ? "running" : "accepted",
      ...(current ? {} : { completionOutput: { rootLayer: resultLayer } }) });
    detail.actionInvocations = [{ durable: true, sourceInteractionId: 2, actionId: 777,
      invocationKey: "call-a", presentingLayerId: 101, resultInteractionId: 3 }];
    const sourceEntry = navigationEntryFromView({ threadId: 7, turnId: 2,
      layerPath: [{ layerId: 100 }, { layerId: 101, actionId: 501 }], selectedNodeId: 11 });
    const origin = { sourceEntry, actionId: 777, invocationKey: "call-a", sourceNodeId: 11,
      presentingLayerId: 101, label: "Forged label", icon: "Forged icon" };
    const childEntry = navigationEntryFromView({ threadId: 7, turnId: 3,
      layerPath: [{ layerId: 301 }], selectedNodeId: 31, invocationOrigin: origin,
      temporalCurrent: current ? { completionId: 303, revision: 1, mode: "following" } : null });
    const loadLayer = vi.fn(async ({ turnId, layerId }) => {
      if (String(turnId) === "2" && String(layerId) === "101") return sourceLayer;
      if (String(turnId) === "3" && String(layerId) === "301") return resultLayer;
      throw new Error("Layer not visible");
    });
    return { detail, sourceLayer, resultLayer, origin, childEntry,
      options: { loadThread: vi.fn(async () => detail), loadLayer } };
  }

  it.each([false, true])("restores independent child and exact invoking source paths (Current=%s)", async current => {
    const { detail, sourceLayer, resultLayer, origin, childEntry, options } = invocationFixture(current);
    const restored = await resolveNavigationPresentation(JSON.parse(JSON.stringify(childEntry)), options);
    expect(restored.layer).toBe(resultLayer);
    expect(restored.layerPath.map(step => step.layerId)).toEqual([301]);
    expect(restored.invocationOrigin).toMatchObject({ label: "API", icon: "route", sourceNodeId: "11",
      presentingLayerId: "101", invocationKey: "call-a" });
    expect(restored.entry.invocationOrigin).not.toHaveProperty("label");
    expect(restored.entry.temporalCurrent).toEqual(childEntry.temporalCurrent);
    expect(navigationEntryKey(childEntry)).not.toBe(navigationEntryKey({ ...childEntry, invocationOrigin: undefined }));
    const breadcrumbs = workspaceBreadcrumbItems({ interactions: detail.interactions, nodes: [],
      currentInteractionId: 3, visibleLayer: resultLayer }, detail.thread,
    { layerPath: restored.layerPath, invocationOrigin: restored.invocationOrigin });
    expect(breadcrumbs.map(item => item.kind)).toEqual(["invoke-origin", "layer"]);
    expect(breadcrumbs[0]).toMatchObject({ label: "API", interactive: true, invocationOrigin: true,
      sourceNodeId: "11", layerId: "101", sourceEntry: childEntry.invocationOrigin.sourceEntry });
    expect(breadcrumbs[1]).toMatchObject({ pathIndex: 0, layerId: 301, current: true });
    const source = await resolveNavigationPresentation(restored.invocationOrigin.sourceEntry, options);
    expect(source.layer).toBe(sourceLayer);
    expect(source.selectedNodeId).toBe("11");
    expect(source.layerPath.map(step => step.layerId)).toEqual([100, 101]);
    expect(source).not.toHaveProperty("invocationOrigin");
    expect(invocationOriginForSource(origin, sourceLayer, detail.actionInvocations, 3)).toEqual(restored.invocationOrigin);
  });

  it("restores exact source and child Current history after both return different root Layers", async () => {
    const { detail, sourceLayer, resultLayer, childEntry, options } = invocationFixture(true);
    const source = detail.interactions.find(turn => turn.id === 2);
    const previousSourceRoot = source.completionOutput.rootLayer;
    source.graphNodeId = 202;
    source.completionOutput = { rootLayer: { layer: { id: 400, state: "accepted" }, nodes: [], actions: [] } };
    detail.interactions[2].completionStatus = "accepted";
    detail.interactions[2].completionOutput = { rootLayer: { layer: { id: 500, state: "accepted" }, nodes: [], actions: [] } };
    const entry = { ...childEntry, invocationOrigin: { ...childEntry.invocationOrigin,
      sourceEntry: { ...childEntry.invocationOrigin.sourceEntry,
        temporalCurrent: { completionId: 202, revision: 1, mode: "pinned" } },
    } };
    const loadLayer = vi.fn(async identity => String(identity.layerId) === "100"
      ? previousSourceRoot : options.loadLayer(identity));
    const loaders = { ...options, loadLayer };
    const restored = await resolveNavigationPresentation(entry, loaders);
    expect(restored.layer).toBe(resultLayer);
    expect(restored.invocationOrigin.label).toBe("API");
    const restoredSource = await resolveNavigationPresentation(restored.invocationOrigin.sourceEntry, loaders);
    expect(restoredSource.layer).toBe(sourceLayer);
    expect(restoredSource.selectedNodeId).toBe("11");
    expect(restoredSource.entry.temporalCurrent).toMatchObject({ completionId: "202", mode: "pinned" });
    expect(loadLayer).toHaveBeenCalledWith({ threadId: "7", turnId: "2", layerId: "100" });
    await expect(resolveNavigationPresentation({ ...entry, temporalCurrent: null }, loaders))
      .rejects.toThrow("layer path is no longer available");
    await expect(resolveNavigationPresentation({ ...entry, temporalCurrent: { completionId: 999,
      revision: 1, mode: "pinned" } }, loaders)).rejects.toThrow("Current identity is unavailable");
    const layerCache = createAcceptedLayerCache();
    await expect(resolveNavigationPresentation(entry, { ...loaders, layerCache, loadLayer: async identity =>
      String(identity.layerId) === "301" ? { ...resultLayer, layer: { id: 301, state: "draft" } }
        : loadLayer(identity) })).rejects.toThrow("Current Layer is not accepted");
    expect(layerCache.get({ threadId: 7, turnId: 3, layerId: 301 })).toBeUndefined();
    await expect(resolveNavigationPresentation(entry, { ...loaders, layerCache })).resolves.toMatchObject({ layer: resultLayer });
  });

  it.each(["wrong-key", "wrong-result", "wrong-occurrence", "non-durable", "wrong-node", "missing-action", "draft-source", "ambiguous-call", "wrong-path", "wrong-selection"])("refuses unsupported invocation origin without inventing navigation (%s)", async scenario => {
    const { detail, sourceLayer, childEntry, options } = invocationFixture();
    const call = detail.actionInvocations[0];
    if (scenario === "wrong-key") call.invocationKey = "another-call";
    if (scenario === "wrong-result") call.resultInteractionId = 4;
    if (scenario === "wrong-occurrence") call.presentingLayerId = 100;
    if (scenario === "non-durable") call.durable = false;
    if (scenario === "wrong-node") sourceLayer.actions[0].sourceNodeId = 12;
    if (scenario === "missing-action") sourceLayer.actions = [];
    if (scenario === "draft-source") sourceLayer.nodes[0].state = "draft";
    if (scenario === "ambiguous-call") detail.actionInvocations.push({ ...call });
    if (scenario === "wrong-selection") sourceLayer.nodes.push({ id: 12, state: "accepted", title: "Other Node" });
    const entry = scenario === "wrong-selection" ? { ...childEntry, invocationOrigin: {
      ...childEntry.invocationOrigin, sourceEntry: { ...childEntry.invocationOrigin.sourceEntry, selectedNodeId: 12 },
    } } : scenario === "wrong-path" ? { ...childEntry, invocationOrigin: {
      ...childEntry.invocationOrigin, sourceEntry: { ...childEntry.invocationOrigin.sourceEntry,
        navigationPath: [{ layerId: 100 }, { layerId: 101, viaActionId: 999 }] },
    } } : childEntry;
    await expect(resolveNavigationPresentation(entry, options)).rejects.toThrow(
      scenario === "wrong-path" ? "layer path is no longer available" : "Invocation origin source or exact call");
    expect(detail.interactions[2].completionOutput.rootLayer.layer.id).toBe(301);
    expect(sourceLayer.actions.some(action => action.kind === "navigate")).toBe(false);
  });

  it.each(["returned", "running", "wrong-call", "wrong-target", "missing-navigation", "wrong-source", "reusable"])("restores only an exactly supported returned single-call path (%s)", async (scenario) => {
    const { root, child, detail } = fixture();
    root.actions.push({ id: 502, kind: "invoke", sourceNodeId: 10, reusable: scenario === "reusable", label: "Analyze" });
    detail.interactions.push({ id: 3, threadId: 7, completionStatus: "accepted", completionOutput: { rootLayer: child } });
    detail.actionInvocations = [{ reusable: true, sourceInteractionId: 2, actionId: scenario === "wrong-call" ? 999 : 502, resultInteractionId: 3, resultCompletionStatus: scenario === "running" ? "running" : "accepted" }];
    if (scenario === "wrong-target") root.actions[0].targetLayerId = 999;
    if (scenario === "missing-navigation") root.actions.shift();
    if (scenario === "wrong-source") root.actions[0].sourceNodeId = 999;
    const loadLayer = vi.fn(async () => child);
    const pending = resolveNavigationPresentation({ threadId: 7, turnId: 2, navigationPath: [{ layerId: 100, viaActionId: null }, { layerId: 101, viaActionId: 502 }] }, { loadThread: async () => detail, loadLayer });
    if (scenario === "returned") {
      const restored = await pending;
      expect(restored.layerPath[1]).toMatchObject({ layerId: 101, actionId: 502, sourceNodeId: 10 });
      expect(root.actions[1]).toMatchObject({ kind: "invoke", reusable: false });
      expect(root.actions[1].targetLayerId).toBeUndefined();
    } else {
      await expect(pending).rejects.toThrow("Navigation history layer path is no longer available");
      expect(loadLayer).not.toHaveBeenCalled();
    }
  });
  it("captures stable identity from the renderer layer path", () => {
    const entry = navigationEntryFromView({
      threadId: 7,
      turnId: 2,
      layerPath: [
        { layerId: 100, actionId: null, label: "Response" },
        { layerId: 101, actionId: 501, label: "Architecture" },
      ],
      selectedNodeId: 11,
    });

    expect(entry).toEqual({
      threadId: "7",
      turnId: "2",
      navigationPath: [
        { layerId: "100", viaActionId: null },
        { layerId: "101", viaActionId: "501" },
      ],
      selectedNodeId: "11",
      temporalCurrent: null,
    });
    expect(navigationEntryKey(entry)).toBe('['
      + '"7","2",[["100",null],["101","501"]]]');
    expect(descendantLayerIdentities(entry)).toEqual([
      { threadId: "7", turnId: "2", layerId: "101" },
    ]);
  });

  it("derives concise destination labels without storing presentation copy in entries", () => {
    const { detail, interaction } = fixture();
    const metadata = navigationDestinationMetadata({
      thread: detail.thread,
      interaction,
      interactions: detail.interactions,
      layerPath: [{ layerId: 100, label: "Response" }, { layerId: 101, label: "Architecture" }],
    });
    expect(metadata).toEqual({
      threadTitle: "Navigation history",
      turnNumber: 2,
      layerLabel: "Architecture",
    });
    expect(navigationDestinationLabel("back", metadata))
      .toBe("Back to Navigation history · Turn 2 · Architecture");
    expect(navigationDestinationLabel("forward", null)).toBe("Forward");
  });

  it("rewrites both thread and interaction deep-link identity", () => {
    const url = workspaceUrlForPresentation(
      "http://127.0.0.1:43123/?threadId=old&interactionId=before&review=1",
      { threadId: 7, turnId: 2 },
    );
    expect(url.searchParams.get("threadId")).toBe("7");
    expect(url.searchParams.get("interactionId")).toBe("2");
    expect(url.searchParams.get("review")).toBe("1");
  });

  it("resolves and validates an authored descendant path through the accepted cache", async () => {
    const { child, detail } = fixture();
    const loadThread = vi.fn(async () => detail);
    const loadLayer = vi.fn(async () => child);
    const layerCache = createAcceptedLayerCache();
    const entry = {
      threadId: 7,
      turnId: 2,
      navigationPath: [
        { layerId: 100, viaActionId: null },
        { layerId: 101, viaActionId: 501 },
      ],
      selectedNodeId: 11,
    };

    const first = await resolveNavigationPresentation(entry, { loadThread, loadLayer, layerCache });
    const second = await resolveNavigationPresentation(entry, { loadThread, loadLayer, layerCache });

    expect(first.layer).toBe(child);
    expect(first.layer.layer.layout).toEqual(child.layer.layout);
    expect(first.layerPath.map(({ label }) => label)).toEqual(["Response", "Architecture"]);
    expect(first.entry.selectedNodeId).toBe("11");
    expect(first.actionInvocations).toEqual(detail.actionInvocations);
    expect(first.approvals).toEqual(detail.approvals);
    expect(second.layer).toBe(child);
    expect(second.layer.layer.layout).toEqual(child.layer.layout);
    expect(loadThread).toHaveBeenCalledTimes(2);
    expect(loadLayer).toHaveBeenCalledTimes(1);
  });

  it("uses the current accepted root when an earlier pending entry had no layer path", async () => {
    const { detail, root } = fixture();
    const result = await resolveNavigationPresentation({
      threadId: 7,
      turnId: 2,
      navigationPath: [],
      selectedNodeId: null,
    }, {
      loadThread: async () => detail,
      loadLayer: async () => { throw new Error("unexpected descendant load"); },
    });

    expect(result.layer).toBe(root);
    expect(result.entry.navigationPath).toEqual([{ layerId: "100", viaActionId: null }]);
  });

  it("restores a retained temporal current when terminal work has no final output", async () => {
    const { detail, root } = fixture();
    root.layer.state = "accepted";
    const stoppedDetail = {
      ...detail,
      interactions: detail.interactions.map((interaction) => (
        String(interaction.id) === "2"
          ? { ...interaction, graphNodeId: 42, completionOutput: null, completionStatus: "stopped" }
          : interaction
      )),
    };
    const result = await resolveNavigationPresentation({
      threadId: 7,
      turnId: 2,
      navigationPath: [{ layerId: 100, viaActionId: null }],
      selectedNodeId: null,
      temporalCurrent: { completionId: 42, revision: 2, mode: "pinned" },
    }, {
      loadThread: async () => stoppedDetail,
      loadLayer: async () => root,
    });

    expect(result.layer).toBe(root);
    expect(result.entry.temporalCurrent).toEqual({
      completionId: "42",
      revision: 2,
      mode: "pinned",
    });
  });

  it("fails without returning a partial presentation for missing turns, paths, or nodes", async () => {
    const { child, detail } = fixture();
    const options = {
      loadThread: async () => detail,
      loadLayer: async () => child,
    };
    await expect(resolveNavigationPresentation({
      threadId: 7,
      turnId: 99,
      navigationPath: [],
      selectedNodeId: null,
    }, options)).rejects.toThrow("turn is unavailable");
    await expect(resolveNavigationPresentation({
      threadId: 7,
      turnId: 2,
      navigationPath: [{ layerId: 999, viaActionId: null }],
      selectedNodeId: null,
    }, options)).rejects.toThrow("layer path is no longer available");
    await expect(resolveNavigationPresentation({
      threadId: 7,
      turnId: 2,
      navigationPath: [{ layerId: 100, viaActionId: null }],
      selectedNodeId: 99,
    }, options)).rejects.toThrow("node is unavailable");
  });

  it("rejects a mismatched descendant response without poisoning the accepted cache", async () => {
    const { child, detail } = fixture();
    const layerCache = createAcceptedLayerCache();
    const loadLayer = vi.fn()
      .mockResolvedValueOnce({ ...child, layer: { id: 999 } })
      .mockResolvedValueOnce(child);
    const entry = {
      threadId: 7,
      turnId: 2,
      navigationPath: [
        { layerId: 100, viaActionId: null },
        { layerId: 101, viaActionId: 501 },
      ],
      selectedNodeId: null,
    };

    await expect(resolveNavigationPresentation(entry, {
      loadThread: async () => detail,
      loadLayer,
      layerCache,
    })).rejects.toThrow("did not match requested layer");
    expect(layerCache.size).toBe(0);
    await expect(resolveNavigationPresentation(entry, {
      loadThread: async () => detail,
      loadLayer,
      layerCache,
    })).resolves.toMatchObject({ layer: child });
    expect(loadLayer).toHaveBeenCalledTimes(2);
    expect(validateResolvedLayer({ layerId: 101 }, child)).toBe(child);
  });
});
