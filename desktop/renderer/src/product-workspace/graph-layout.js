export const GRAPH_WORLD_WIDTH = 960;
export const GRAPH_WORLD_HEIGHT = 640;

const GRAPH_WORLD_PADDING = 32;

function compareNodeIds(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizedLegacyPlacements(nodes) {
  const ordered = [...nodes].sort((left, right) => compareNodeIds(left.id, right.id));
  if (ordered.length === 1) {
    return new Map([[String(ordered[0].id), { x: 0.5, y: 0.5 }]]);
  }
  const columns = Math.ceil(Math.sqrt(ordered.length));
  const rows = Math.ceil(ordered.length / columns);
  const placements = new Map();
  ordered.forEach((node, index) => {
    const row = Math.floor(index / columns);
    const rowStart = row * columns;
    const rowLength = Math.min(columns, ordered.length - rowStart);
    const column = index - rowStart;
    placements.set(String(node.id), {
      x: (column + 1) / (rowLength + 1),
      y: (row + 1) / (rows + 1),
    });
  });
  return placements;
}

function authoredPlacements(layer, nodes) {
  const layout = layer?.layer?.layout;
  if (!layout) return null;
  if (layout.version !== 1 || !Array.isArray(layout.placements)) {
    throw new Error(`Unsupported accepted graph layout version: ${String(layout.version)}`);
  }
  const placements = new Map(layout.placements.map((placement) => [
    String(placement.nodeId),
    { x: Number(placement.x), y: Number(placement.y) },
  ]));
  if (
    layout.placements.length !== nodes.length
    || placements.size !== nodes.length
    || nodes.some((node) => !placements.has(String(node.id)))
  ) {
    throw new Error("Accepted graph layout does not contain exactly one placement for every visible node.");
  }
  for (const point of placements.values()) {
    if (![point.x, point.y].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
      throw new Error("Accepted graph layout contains an invalid normalized coordinate.");
    }
  }
  return placements;
}

function worldPadding(nodes) {
  return nodes.reduce((padding, node) => {
    const bounds = node.layoutBounds ?? { halfWidth: 0, top: 0, bottom: 0 };
    return {
      horizontal: Math.max(padding.horizontal, bounds.halfWidth + GRAPH_WORLD_PADDING),
      top: Math.max(padding.top, bounds.top + GRAPH_WORLD_PADDING),
      bottom: Math.max(padding.bottom, bounds.bottom + GRAPH_WORLD_PADDING),
    };
  }, {
    horizontal: GRAPH_WORLD_PADDING,
    top: GRAPH_WORLD_PADDING,
    bottom: GRAPH_WORLD_PADDING,
  });
}

export function projectLayerNodePositions(layer, nodes) {
  if (!nodes.length) return { source: layer?.layer?.layout ? "authored" : "legacy", positions: new Map() };
  const authored = authoredPlacements(layer, nodes);
  const normalized = authored ?? normalizedLegacyPlacements(nodes);
  const padding = worldPadding(nodes);
  const usableWidth = Math.max(1, GRAPH_WORLD_WIDTH - padding.horizontal * 2);
  const usableHeight = Math.max(1, GRAPH_WORLD_HEIGHT - padding.top - padding.bottom);
  const positions = new Map([...normalized].map(([nodeId, point]) => [nodeId, {
    x: padding.horizontal + point.x * usableWidth,
    y: padding.top + point.y * usableHeight,
  }]));
  return { source: authored ? "authored" : "legacy", positions };
}

export function graphLayoutSignature(layer, nodes, edges) {
  const layout = layer?.layer?.layout;
  return JSON.stringify({
    layerId: layer?.layer?.id ?? null,
    nodes: nodes.map((node) => String(node.id)).sort(compareNodeIds),
    edges: edges.map((edge) => (edge.endpoints || [edge.source, edge.target])
      .map(String)
      .sort(compareNodeIds))
      .sort((left, right) => compareNodeIds(left.join(":"), right.join(":"))),
    layout: layout ? {
      version: layout.version,
      placements: [...layout.placements]
        .map(({ nodeId, x, y }) => ({ nodeId: String(nodeId), x, y }))
        .sort((left, right) => compareNodeIds(left.nodeId, right.nodeId)),
    } : null,
  });
}
