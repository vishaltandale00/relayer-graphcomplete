import { describe, expect, it } from "vitest";
import {
  GRAPH_WORLD_HEIGHT,
  GRAPH_WORLD_WIDTH,
  graphLayoutSignature,
  projectLayerNodePositions,
} from "../desktop/renderer/src/product-workspace/graph-layout.js";

const bounds = { halfWidth: 82, top: 28, bottom: 72 };
const nodes = [
  { id: 3, layoutBounds: bounds },
  { id: 1, layoutBounds: bounds },
  { id: 2, layoutBounds: bounds },
];

function authoredLayer(placements) {
  return {
    layer: {
      id: 9,
      layout: { version: 1, placements },
    },
  };
}

describe("product workspace graph layout", () => {
  it("projects authored normalized coordinates into one stable node-padded world plane", () => {
    const layer = authoredLayer([
      { nodeId: 1, x: 0, y: 0 },
      { nodeId: 2, x: 0.5, y: 0.5 },
      { nodeId: 3, x: 1, y: 1 },
    ]);
    const projected = projectLayerNodePositions(layer, nodes);

    expect(projected.source).toBe("authored");
    expect(projected.positions.get("1")).toEqual({ x: 114, y: 60 });
    expect(projected.positions.get("2")).toEqual({ x: 480, y: 298 });
    expect(projected.positions.get("3")).toEqual({ x: 846, y: 536 });
    expect(GRAPH_WORLD_WIDTH).toBe(960);
    expect(GRAPH_WORLD_HEIGHT).toBe(640);
  });

  it("preserves authored alignment and is independent of node and placement order", () => {
    const placements = [
      { nodeId: 1, x: 0.2, y: 0.4 },
      { nodeId: 2, x: 0.5, y: 0.4 },
      { nodeId: 3, x: 0.8, y: 0.4 },
    ];
    const first = projectLayerNodePositions(authoredLayer(placements), nodes);
    const second = projectLayerNodePositions(
      authoredLayer([...placements].reverse()),
      [...nodes].reverse(),
    );

    expect([...first.positions]).toEqual([...second.positions].reverse());
    expect(new Set([...first.positions.values()].map((point) => point.y)).size).toBe(1);
  });

  it("uses the largest rendered node bounds globally without warping authored relationships", () => {
    const layer = authoredLayer([
      { nodeId: 1, x: 0, y: 0 },
      { nodeId: 2, x: 1, y: 1 },
    ]);
    const projected = projectLayerNodePositions(layer, [
      { id: 1, layoutBounds: { halfWidth: 40, top: 20, bottom: 40 } },
      { id: 2, layoutBounds: { halfWidth: 120, top: 35, bottom: 180 } },
    ]);

    expect(projected.positions.get("1")).toEqual({ x: 152, y: 67 });
    expect(projected.positions.get("2")).toEqual({ x: 808, y: 428 });
  });

  it("centers a legacy one-node layer and deterministically places larger legacy layers", () => {
    const one = projectLayerNodePositions({ layer: { id: 1 } }, [{ id: "only", layoutBounds: bounds }]);
    expect(one.source).toBe("legacy");
    expect(one.positions.get("only")).toEqual({ x: 480, y: 298 });

    const first = projectLayerNodePositions({ layer: { id: 2 } }, nodes);
    const second = projectLayerNodePositions({ layer: { id: 2 } }, [...nodes].reverse());
    expect(Object.fromEntries(first.positions)).toEqual(Object.fromEntries(second.positions));
    expect(new Set([...first.positions.values()].map(({ x, y }) => `${x}:${y}`)).size).toBe(3);
  });

  it("canonicalizes node, edge, and placement order in the view signature", () => {
    const placements = [
      { nodeId: 1, x: 0.2, y: 0.4 },
      { nodeId: 2, x: 0.8, y: 0.4 },
    ];
    const layer = authoredLayer(placements);
    const reverseLayer = authoredLayer([...placements].reverse());
    const edges = [{ endpoints: [1, 2] }];

    expect(graphLayoutSignature(layer, [{ id: 1 }, { id: 2 }], edges)).toBe(
      graphLayoutSignature(reverseLayer, [{ id: 2 }, { id: 1 }], [{ endpoints: [2, 1] }]),
    );
    expect(graphLayoutSignature(
      authoredLayer([{ nodeId: 1, x: 0.3, y: 0.4 }, placements[1]]),
      [{ id: 1 }, { id: 2 }],
      edges,
    )).not.toBe(graphLayoutSignature(layer, [{ id: 1 }, { id: 2 }], edges));
  });

  it("fails closed for malformed accepted authored layouts instead of using legacy placement", () => {
    expect(() => projectLayerNodePositions(
      authoredLayer([{ nodeId: 1, x: 0.5, y: 0.5 }]),
      [{ id: 1 }, { id: 2 }],
    )).toThrow("exactly one placement");
    expect(() => projectLayerNodePositions(
      authoredLayer([{ nodeId: 1, x: Number.NaN, y: 0.5 }]),
      [{ id: 1 }],
    )).toThrow("invalid normalized coordinate");
    expect(() => projectLayerNodePositions(
      { layer: { layout: { version: 2, placements: [] } } },
      [{ id: 1 }],
    )).toThrow("Unsupported accepted graph layout version");
  });
});
