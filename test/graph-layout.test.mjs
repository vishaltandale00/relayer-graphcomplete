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
  it("projects authored layouts into one stable, order-independent world plane and fails closed on malformed layouts", () => {
    expect(GRAPH_WORLD_WIDTH, "world width").toBe(960);
    expect(GRAPH_WORLD_HEIGHT, "world height").toBe(640);

    const projected = projectLayerNodePositions(authoredLayer([
      { nodeId: 1, x: 0, y: 0 },
      { nodeId: 2, x: 0.5, y: 0.5 },
      { nodeId: 3, x: 1, y: 1 },
    ]), nodes);
    expect(projected.source, "authored source").toBe("authored");
    expect(projected.positions.get("1"), "top-left normalized corner").toEqual({ x: 114, y: 60 });
    expect(projected.positions.get("2"), "normalized midpoint").toEqual({ x: 480, y: 298 });
    expect(projected.positions.get("3"), "bottom-right normalized corner").toEqual({ x: 846, y: 536 });

    const alignmentPlacements = [
      { nodeId: 1, x: 0.2, y: 0.4 },
      { nodeId: 2, x: 0.5, y: 0.4 },
      { nodeId: 3, x: 0.8, y: 0.4 },
    ];
    const first = projectLayerNodePositions(authoredLayer(alignmentPlacements), nodes);
    const second = projectLayerNodePositions(
      authoredLayer([...alignmentPlacements].reverse()),
      [...nodes].reverse(),
    );
    expect([...first.positions], "placement and node order independence").toEqual([...second.positions].reverse());
    expect(
      new Set([...first.positions.values()].map((point) => point.y)).size,
      "authored alignment preserved",
    ).toBe(1);

    const globalBounds = projectLayerNodePositions(authoredLayer([
      { nodeId: 1, x: 0, y: 0 },
      { nodeId: 2, x: 1, y: 1 },
    ]), [
      { id: 1, layoutBounds: { halfWidth: 40, top: 20, bottom: 40 } },
      { id: 2, layoutBounds: { halfWidth: 120, top: 35, bottom: 180 } },
    ]);
    expect(globalBounds.positions.get("1"), "largest global bounds applied to the small node").toEqual({ x: 152, y: 67 });
    expect(globalBounds.positions.get("2"), "largest global bounds applied to the large node").toEqual({ x: 808, y: 428 });

    const legacyOne = projectLayerNodePositions({ layer: { id: 1 } }, [{ id: "only", layoutBounds: bounds }]);
    expect(legacyOne.source, "legacy source").toBe("legacy");
    expect(legacyOne.positions.get("only"), "legacy one-node centering").toEqual({ x: 480, y: 298 });
    const legacyFirst = projectLayerNodePositions({ layer: { id: 2 } }, nodes);
    const legacySecond = projectLayerNodePositions({ layer: { id: 2 } }, [...nodes].reverse());
    expect(Object.fromEntries(legacyFirst.positions), "deterministic legacy placement").toEqual(Object.fromEntries(legacySecond.positions));
    expect(
      new Set([...legacyFirst.positions.values()].map(({ x, y }) => `${x}:${y}`)).size,
      "legacy nodes not collapsed",
    ).toBe(3);

    const signaturePlacements = [
      { nodeId: 1, x: 0.2, y: 0.4 },
      { nodeId: 2, x: 0.8, y: 0.4 },
    ];
    const edges = [{ endpoints: [1, 2] }];
    expect(
      graphLayoutSignature(authoredLayer(signaturePlacements), [{ id: 1 }, { id: 2 }], edges),
      "signature canonicalizes node, edge, and placement order",
    ).toBe(graphLayoutSignature(authoredLayer([...signaturePlacements].reverse()), [{ id: 2 }, { id: 1 }], [{ endpoints: [2, 1] }]));
    expect(
      graphLayoutSignature(authoredLayer([{ nodeId: 1, x: 0.3, y: 0.4 }, signaturePlacements[1]]), [{ id: 1 }, { id: 2 }], edges),
      "signature changes with authored coordinates",
    ).not.toBe(graphLayoutSignature(authoredLayer(signaturePlacements), [{ id: 1 }, { id: 2 }], edges));

    expect(() => projectLayerNodePositions(
      authoredLayer([{ nodeId: 1, x: 0.5, y: 0.5 }]),
      [{ id: 1 }, { id: 2 }],
    ), "placement count mismatch").toThrow("exactly one placement");
    expect(() => projectLayerNodePositions(
      authoredLayer([{ nodeId: 1, x: Number.NaN, y: 0.5 }]),
      [{ id: 1 }],
    ), "invalid normalized coordinate").toThrow("invalid normalized coordinate");
    expect(() => projectLayerNodePositions(
      { layer: { layout: { version: 2, placements: [] } } },
      [{ id: 1 }],
    ), "unsupported layout version").toThrow("Unsupported accepted graph layout version");
  });
});
