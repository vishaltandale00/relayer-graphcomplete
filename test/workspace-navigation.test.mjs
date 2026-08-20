import { describe, expect, it, vi } from "vitest";

import { createAcceptedLayerCache } from "../desktop/renderer/src/navigation-history.js";
import {
  descendantLayerIdentities,
  navigationDestinationLabel,
  navigationDestinationMetadata,
  navigationEntryFromView,
  navigationEntryKey,
  resolveNavigationPresentation,
  validateResolvedLayer,
  workspaceUrlForPresentation,
} from "../desktop/renderer/src/workspace-navigation.js";

function fixture() {
  const root = {
    layer: { id: 100 },
    nodes: [{ id: 10, title: "Architecture" }],
    actions: [{ id: 501, kind: "navigate", sourceNodeId: 10, targetLayerId: 101 }],
  };
  const child = {
    layer: { id: 101 },
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
  };
  return { child, detail, interaction, root };
}

describe("workspace navigation presentation", () => {
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
    expect(first.layerPath.map(({ label }) => label)).toEqual(["Response", "Architecture"]);
    expect(first.entry.selectedNodeId).toBe("11");
    expect(first.actionInvocations).toEqual(detail.actionInvocations);
    expect(second.layer).toBe(child);
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
