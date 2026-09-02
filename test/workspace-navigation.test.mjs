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
  it("derives entry identity, destination labels, and deep links from the view", () => {
    const entry = navigationEntryFromView({
      threadId: 7,
      turnId: 2,
      layerPath: [
        { layerId: 100, actionId: null, label: "Response" },
        { layerId: 101, actionId: 501, label: "Architecture" },
      ],
      selectedNodeId: 11,
    });
    expect(entry, "the view maps to a string-normalized entry").toEqual({
      threadId: "7",
      turnId: "2",
      navigationPath: [
        { layerId: "100", viaActionId: null },
        { layerId: "101", viaActionId: "501" },
      ],
      selectedNodeId: "11",
      temporalCurrent: null,
    });
    expect(navigationEntryKey(entry), "the entry key pins path identity")
      .toBe('["7","2",[["100",null],["101","501"]]]');
    expect(descendantLayerIdentities(entry), "descendant identities exclude the root layer")
      .toEqual([{ threadId: "7", turnId: "2", layerId: "101" }]);

    const { detail, interaction } = fixture();
    const metadata = navigationDestinationMetadata({
      thread: detail.thread,
      interaction,
      interactions: detail.interactions,
      layerPath: [{ layerId: 100, label: "Response" }, { layerId: 101, label: "Architecture" }],
    });
    expect(metadata, "destination metadata is derived, not stored").toEqual({
      threadTitle: "Navigation history",
      turnNumber: 2,
      layerLabel: "Architecture",
    });
    expect(navigationDestinationLabel("back", metadata), "back labels name the destination")
      .toBe("Back to Navigation history · Turn 2 · Architecture");
    expect(navigationDestinationLabel("forward", null), "forward survives missing metadata")
      .toBe("Forward");

    const url = workspaceUrlForPresentation(
      "http://127.0.0.1:43123/?threadId=old&interactionId=before&review=1",
      { threadId: 7, turnId: 2 },
    );
    expect(url.searchParams.get("threadId"), "deep links rewrite the thread").toBe("7");
    expect(url.searchParams.get("interactionId"), "deep links rewrite the interaction").toBe("2");
    expect(url.searchParams.get("review"), "unrelated query parameters survive").toBe("1");
  });

  it("resolves authored navigation presentations through the accepted cache and fails whole", async () => {
    const { child, detail, root } = fixture();
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
    expect(first.layer, "the descendant layer resolves").toBe(child);
    expect(first.layer.layer.layout, "resolved layers keep their layout").toEqual(child.layer.layout);
    expect(first.layerPath.map(({ label }) => label), "labels follow the authored path")
      .toEqual(["Response", "Architecture"]);
    expect(first.entry.selectedNodeId, "selection rides along normalized").toBe("11");
    expect(first.actionInvocations, "action invocations accompany the presentation")
      .toEqual(detail.actionInvocations);
    expect(first.approvals, "approvals accompany the presentation").toEqual(detail.approvals);
    expect(second.layer, "the accepted cache serves the repeat resolution").toBe(child);
    expect(second.layer.layer.layout, "cached layers keep their layout").toEqual(child.layer.layout);
    expect(loadThread, "thread detail is refetched per resolution").toHaveBeenCalledTimes(2);
    expect(loadLayer, "the accepted layer is fetched once").toHaveBeenCalledTimes(1);

    const pathless = await resolveNavigationPresentation({
      threadId: 7,
      turnId: 2,
      navigationPath: [],
      selectedNodeId: null,
    }, {
      loadThread: async () => detail,
      loadLayer: async () => { throw new Error("unexpected descendant load"); },
    });
    expect(pathless.layer, "a pathless entry lands on the current accepted root").toBe(root);
    expect(pathless.entry.navigationPath, "the root path is authored on resolution")
      .toEqual([{ layerId: "100", viaActionId: null }]);

    const stoppedDetail = {
      ...detail,
      interactions: detail.interactions.map((interaction) => (
        String(interaction.id) === "2"
          ? { ...interaction, completionOutput: null, completionStatus: "stopped" }
          : interaction
      )),
    };
    const temporal = await resolveNavigationPresentation({
      threadId: 7,
      turnId: 2,
      navigationPath: [{ layerId: 100, viaActionId: null }],
      selectedNodeId: null,
      temporalCurrent: { completionId: 42, revision: 2, mode: "pinned" },
    }, {
      loadThread: async () => stoppedDetail,
      loadLayer: async () => root,
    });
    expect(temporal.layer, "terminal work restores its retained temporal current").toBe(root);
    expect(temporal.entry.temporalCurrent, "the temporal follow intent survives normalization")
      .toEqual({ completionId: "42", revision: 2, mode: "pinned" });

    const options = {
      loadThread: async () => detail,
      loadLayer: async () => child,
    };
    const rejections = [
      ["a missing turn rejects whole", { threadId: 7, turnId: 99, navigationPath: [], selectedNodeId: null }, "turn is unavailable"],
      ["a missing path layer rejects whole", { threadId: 7, turnId: 2, navigationPath: [{ layerId: 999, viaActionId: null }], selectedNodeId: null }, "layer path is no longer available"],
      ["a missing selection rejects whole", { threadId: 7, turnId: 2, navigationPath: [{ layerId: 100, viaActionId: null }], selectedNodeId: 99 }, "node is unavailable"],
    ];
    expect(rejections, "rejection corpus").toHaveLength(3);
    for (const [label, requested, message] of rejections) {
      await expect(resolveNavigationPresentation(requested, options), label)
        .rejects.toThrow(message);
    }

    const poisonedCache = createAcceptedLayerCache();
    const mismatchedLoad = vi.fn()
      .mockResolvedValueOnce({ ...child, layer: { id: 999 } })
      .mockResolvedValueOnce(child);
    await expect(resolveNavigationPresentation(entry, {
      loadThread: async () => detail,
      loadLayer: mismatchedLoad,
      layerCache: poisonedCache,
    }), "a mismatched descendant response rejects").rejects.toThrow("did not match requested layer");
    expect(poisonedCache.size, "mismatched responses never poison the accepted cache").toBe(0);
    await expect(resolveNavigationPresentation(entry, {
      loadThread: async () => detail,
      loadLayer: mismatchedLoad,
      layerCache: poisonedCache,
    }), "the next resolution recovers cleanly").resolves.toMatchObject({ layer: child });
    expect(mismatchedLoad, "recovery refetches the descendant").toHaveBeenCalledTimes(2);
    expect(validateResolvedLayer({ layerId: 101 }, child), "matching layers validate")
      .toBe(child);
  });
});
