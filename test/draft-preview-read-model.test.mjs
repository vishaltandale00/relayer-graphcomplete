import { describe, expect, it } from "vitest";
import { createPublicViewerAdapter } from "../desktop/renderer/src/public-share-viewer/adapter.js";
import { draftPreviewReadModel } from "../desktop/renderer/src/draft-preview/snapshot.js";

const node = (id) => ({ id, kind: "concept", icon: "list", title: `Node ${id}`, detail: "Detail", state: "draft" });

describe("draft preview read model", () => {
  it("presents a draft layer as the user will see it once accepted", () => {
    const model = draftPreviewReadModel({
      version: 1,
      target: { kind: "layer", layerId: 3 },
      layer: { id: 3, nodes: [1, 2], edges: [5], state: "draft" },
      nodes: [node(1), node(2)],
      edges: [{ id: 5, endpoints: [1, 2], state: "draft" }],
      assets: [],
    });
    const { rootLayer } = model.interactions[0].completionOutput;
    expect([rootLayer.layer, ...rootLayer.nodes, ...rootLayer.edges].map(({ state }) => state)).toEqual(Array(4).fill("accepted"));
    expect(model.state.visibleLayer).toBe(rootLayer);
  });

  it("hydrates and navigates the production adapter without adding execution authority", async () => {
    const model = draftPreviewReadModel({ version: 1, layer: { id: 6, nodes: [1], edges: [], state: "draft" }, nodes: [node(1)], edges: [], assets: [] });
    const root = model.interactions[0].completionOutput.rootLayer;
    root.actions.push({ id: 9, state: "draft" });
    const adapter = createPublicViewerAdapter(model);
    expect(adapter.state.actions).toEqual([]);
    expect(await adapter.navigateLayer(6)).toBe(true);
    expect(adapter.selectTurnById(model.interactions[0].id, { responseRoot: true })).toBe(true);
    expect(adapter.state.visibleLayer).toBe(root);
    expect(adapter.state.actions).toEqual([]);
    expect(await adapter.onInvokeAction({ id: 9 })).toBe(false);
    expect(await adapter.onSubmitInteraction()).toBe(false);
    expect(adapter.readOnly).toBe(true);
  });

  it("shows a node target as a one-node layer that opens its Node Details", () => {
    const model = draftPreviewReadModel({ version: 1, target: { kind: "node", nodeId: 7 }, layer: null, nodes: [node(7)], edges: [], assets: [] });
    const { layer } = model.interactions[0].completionOutput.rootLayer;
    expect(layer).toMatchObject({ nodes: [7], defaultNodeId: 7, state: "accepted" });
  });
});
