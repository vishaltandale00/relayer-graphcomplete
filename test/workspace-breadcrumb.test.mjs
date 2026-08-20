import { describe, expect, it } from "vitest";

import {
  appendLayerPath,
  layerPathForVisibleLayer,
  restoreLayerPath,
  rootLayerPath,
  workspaceBreadcrumbItems,
} from "../desktop/renderer/src/product-workspace/model.js";
import { productWorkspaceMarkup } from "../desktop/renderer/src/product-workspace/view.js";

function fixture() {
  const rootLayer = {
    layer: { id: 100 },
    nodes: [{ id: 10, title: "Architecture" }],
    edges: [],
    actions: [],
  };
  const interaction = {
    id: 2,
    graphNodeId: 200,
    threadId: 7,
    text: "Implement the breadcrumb",
    completionOutput: { rootLayer },
  };
  const thread = { id: 7, projectId: 4, title: "Breadcrumb work" };
  const state = {
    projects: [{ id: 4, name: "Relayer" }],
    threads: [thread],
    interactions: [
      { id: 1, threadId: 7, text: "Plan the breadcrumb" },
      interaction,
    ],
    currentInteractionId: 2,
    visibleLayer: rootLayer,
    nodes: rootLayer.nodes,
  };
  return { interaction, rootLayer, state, thread };
}

describe("product workspace breadcrumb", () => {
  it("shows only the parent-child path established by navigate actions", () => {
    const { interaction, state, thread } = fixture();
    let layerPath = rootLayerPath(interaction);
    layerPath = appendLayerPath(layerPath, {
      id: 501,
      kind: "navigate",
      sourceNodeId: 10,
      targetLayerId: 101,
      label: "Inspect architecture",
    }, { id: 10, title: "Architecture" });
    layerPath = appendLayerPath(layerPath, {
      id: 502,
      kind: "navigate",
      sourceNodeId: 11,
      targetLayerId: 102,
      label: "Inspect API",
    }, { id: 11, title: "API" });
    state.visibleLayer = {
      layer: { id: 102 },
      nodes: [{ id: 12, title: "Storage" }],
      edges: [],
      actions: [],
    };
    state.nodes = state.visibleLayer.nodes;

    const items = workspaceBreadcrumbItems(state, thread, {
      layerPath,
      selectedNodeId: 12,
      evalContext: null,
    });

    expect(items.map((item) => item.label)).toEqual([
      "Response",
      "Architecture",
      "API",
    ]);
    expect(items.filter((item) => item.interactive).map((item) => item.label)).toEqual([
      "Response",
      "Architecture",
    ]);
    expect(items.at(-1)).toMatchObject({ kind: "layer", current: true, layerId: 102 });
  });

  it("does not mix product scope, turn history, or node selection into graph ancestry", () => {
    const { interaction, state, thread } = fixture();
    const items = workspaceBreadcrumbItems(state, thread, {
      layerPath: rootLayerPath(interaction),
      selectedNodeId: null,
      evalContext: {
        cases: [{
          id: "case-1",
          name: "Architecture case",
          threadIds: [7],
          threads: [{ id: 7, name: "Architecture question" }],
        }],
      },
    });

    expect(items.map(({ kind, label }) => ({ kind, label }))).toEqual([
      { kind: "layer", label: "Response" },
    ]);
  });

  it("preserves a matching deep path and resets an unrelated visible layer", () => {
    const { interaction, rootLayer } = fixture();
    const deepPath = appendLayerPath(rootLayerPath(interaction), {
      id: 501,
      kind: "navigate",
      sourceNodeId: 10,
      targetLayerId: 101,
    }, { id: 10, title: "Architecture" });

    expect(layerPathForVisibleLayer(deepPath, interaction, { layer: { id: 101 } })).toEqual(deepPath);
    expect(layerPathForVisibleLayer(deepPath, interaction, rootLayer)).toEqual(rootLayerPath(interaction));
    expect(deepPath.slice(0, 1)).toEqual(rootLayerPath(interaction));
  });

  it("rebuilds authored labels when Eval history restores a deep layer", async () => {
    const { interaction, rootLayer } = fixture();
    const architecture = rootLayer.nodes[0];
    rootLayer.actions = [{
      id: 501,
      kind: "navigate",
      sourceNodeId: architecture.id,
      targetLayerId: 101,
    }];
    const childLayer = {
      layer: { id: 101 },
      nodes: [{ id: 11, title: "API" }],
      actions: [{
        id: 502,
        kind: "navigate",
        sourceNodeId: 11,
        targetLayerId: 102,
      }],
    };
    const grandchildLayer = { layer: { id: 102 }, nodes: [], actions: [] };
    const layers = new Map([[101, childLayer], [102, grandchildLayer]]);

    const restored = await restoreLayerPath(interaction, [
      { layerId: 100, viaActionId: null },
      { layerId: 101, viaActionId: 501 },
      { layerId: 102, viaActionId: 502 },
    ], async (layerId) => layers.get(layerId));

    expect(restored.layer).toBe(grandchildLayer);
    expect(restored.layerPath.map((entry) => entry.label)).toEqual([
      "Response",
      "Architecture",
      "API",
    ]);
  });

  it("renders one shared, accessible breadcrumb host", () => {
    const markup = productWorkspaceMarkup();
    expect(markup).toContain('id="workspaceBreadcrumb"');
    expect(markup).toContain('aria-label="Graph layer path"');
  });
});
