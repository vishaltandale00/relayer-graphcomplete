import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  appendLayerPath,
  createLayerNavigationCoordinator,
  layerPathForVisibleLayer,
  restoreLayerPath,
  rootLayerPath,
  workspaceBreadcrumbItems,
} from "../desktop/renderer/src/product-workspace/model.js";
import { productWorkspaceMarkup } from "../desktop/renderer/src/product-workspace/view.js";

function fixture() {
  const rootLayer = {
    layer: { id: 100 },
    nodes: [{ id: 10, title: "Architecture", icon: "network" }],
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
  it("builds graph ancestry only from navigate actions and restores authored labels", async () => {
    const { interaction, rootLayer, state, thread } = fixture();
    let layerPath = rootLayerPath(interaction);
    layerPath = appendLayerPath(layerPath, {
      id: 501,
      kind: "navigate",
      sourceNodeId: 10,
      targetLayerId: 101,
      label: "Inspect architecture",
    }, { id: 10, title: "Architecture", icon: "network" });
    layerPath = appendLayerPath(layerPath, {
      id: 502,
      kind: "navigate",
      sourceNodeId: 11,
      targetLayerId: 102,
      label: "Inspect API",
    }, { id: 11, title: "API", icon: "code" });
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
    expect(items.map((item) => item.label), "breadcrumb shows only the navigate-action path")
      .toEqual(["Response", "Architecture", "API"]);
    expect(items.filter((item) => item.interactive).map((item) => item.label),
      "the current leaf is not interactive").toEqual(["Response", "Architecture"]);
    expect(items.at(-1), "the leaf carries the visible layer identity")
      .toMatchObject({ kind: "layer", current: true, layerId: 102 });
    expect(items.map((item) => item.icon), "each crumb keeps its source icon")
      .toEqual(["messages-square", "network", "code"]);

    const fresh = fixture();
    const evalOnly = workspaceBreadcrumbItems(fresh.state, fresh.thread, {
      layerPath: rootLayerPath(fresh.interaction),
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
    expect(evalOnly.map(({ kind, label }) => ({ kind, label })),
      "product scope, turn history, and node selection never join graph ancestry")
      .toEqual([{ kind: "layer", label: "Response" }]);

    const deepPath = appendLayerPath(rootLayerPath(interaction), {
      id: 501,
      kind: "navigate",
      sourceNodeId: 10,
      targetLayerId: 101,
    }, { id: 10, title: "Architecture" });
    expect(layerPathForVisibleLayer(deepPath, interaction, { layer: { id: 101 } }),
      "a matching visible layer keeps the deep path").toEqual(deepPath);
    expect(layerPathForVisibleLayer(deepPath, interaction, rootLayer),
      "an unrelated visible layer resets to the root path").toEqual(rootLayerPath(interaction));
    expect(deepPath.slice(0, 1), "the root path prefixes every deep path").toEqual(rootLayerPath(interaction));

    const architecture = rootLayer.nodes[0];
    rootLayer.actions = [{
      id: 501,
      kind: "navigate",
      sourceNodeId: architecture.id,
      targetLayerId: 101,
    }];
    const childLayer = {
      layer: { id: 101 },
      nodes: [{ id: 11, title: "API", icon: "code" }],
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
    expect(restored.layer, "Eval restoration lands on the deepest restored layer").toBe(grandchildLayer);
    expect(restored.layerPath.map((entry) => entry.label),
      "Eval restoration rebuilds authored labels").toEqual(["Response", "Architecture", "API"]);

    const coordinator = createLayerNavigationCoordinator();
    const context = {
      threadId: 7,
      interactionId: 2,
      layerId: 100,
      layerPath: [{ layerId: 100, label: "Response" }],
    };
    const first = coordinator.begin(context);
    const second = coordinator.begin(context);
    expect(coordinator.isCurrent(first, context), "a superseded navigation request is stale").toBe(false);
    expect(coordinator.isCurrent(second, context), "the latest request from the same source layer wins").toBe(true);
    expect(coordinator.isCurrent(second, { ...context, layerId: 101 }),
      "a request from a different source layer is rejected").toBe(false);
    expect(second.layerPath, "the coordinator clones the path instead of sharing it").not.toBe(context.layerPath);
  });

  it("renders one shared, accessible breadcrumb host inside the graph column", async () => {
    const markup = productWorkspaceMarkup();
    expect(markup, "a single breadcrumb host exists").toContain('id="workspaceBreadcrumb"');
    expect(markup, "the breadcrumb host is labelled as the graph layer path")
      .toContain('aria-label="Graph layer path"');
    expect(markup.indexOf('class="graph-column"'), "the host lives inside the graph column")
      .toBeLessThan(markup.indexOf('id="workspaceBreadcrumb"'));
    expect(markup.indexOf('id="workspaceBreadcrumb"'), "the host precedes the graph stage")
      .toBeLessThan(markup.indexOf('id="graphStage"'));

    const styles = await readFile(new URL("../desktop/renderer/styles.css", import.meta.url), "utf8");
    expect(styles, "interaction banner keeps its rounded inset").toContain(
      ".interaction-banner{grid-column:1;grid-row:2;margin:8px 0 12px 12px;",
    );
    expect(styles, "the workspace grid reserves the inspector column").toContain(
      ".thread-workspace{grid-column:1 / -1;grid-row:3;display:grid;grid-template-columns:minmax(0,1fr) var(--inspector);column-gap:12px;",
    );
    expect(styles, "the breadcrumb row keeps its fixed height and alignment").toContain(
      ".workspace-breadcrumb{min-height:40px;flex:none;display:flex;align-items:center;justify-content:flex-start;",
    );
  });
});
