// Canonical Product projection only. Sequence orders cards; it never creates edges.
export function interactionGraph(turns, selectedId) {
  const selected = turns.find((turn) => String(turn.id) === String(selectedId));
  if (selected?.interactionGraph?.enabled !== true) return null;
  const nodes = new Map(turns.map((turn) => [String(turn.id), { ...turn, id: String(turn.id), localTurn: true }]));
  const edges = [];
  for (const turn of turns) {
    for (const source of turn.interactionGraph?.sources ?? []) {
      if (source.interactionId == null || source.threadId == null) continue;
      const id = String(source.interactionId);
      if (!nodes.has(id)) nodes.set(id, { ...source, id, localTurn: false });
      const layers = source.layers ?? [];
      if (!layers.length && source.invocationActionId == null) continue;
      edges.push({ source: id, target: String(turn.id), layers, invocationActionId: source.invocationActionId ?? null });
    }
  }
  const levels = new Map([...nodes.keys()].map((id) => [id, 0]));
  for (let pass = 0; pass < nodes.size; pass += 1) {
    let changed = false;
    for (const edge of edges) {
      const next = Math.min(nodes.size - 1, levels.get(edge.source) + 1);
      if (next > levels.get(edge.target)) { levels.set(edge.target, next); changed = true; }
    }
    if (!changed) break;
  }
  const rows = new Map();
  const positioned = [...nodes.values()].map((node) => {
    const level = levels.get(node.id);
    const row = rows.get(level) ?? 0;
    rows.set(level, row + 1);
    return { ...node, x: 20 + level * 224, y: 20 + row * 98 };
  });
  return { nodes: positioned, edges, incomplete: turns.some((turn) => turn.interactionGraph?.complete === false), contextCount: selected.contexts?.length ?? 0,
    width: Math.max(448, ...positioned.map((node) => node.x + 212)),
    height: Math.max(160, ...positioned.map((node) => node.y + 90)) };
}

// A run waiting for capacity (#720) says so, apart from one queued behind its node.
export function interactionGraphStatus(node) {
  if (node.completionStatus === "accepted") return "Response ready";
  if (node.completionStatus === "queued" && node.queueReason === "capacity") return "Waiting for capacity";
  return node.completionStatus || "Interaction";
}

export function renderInteractionGraph(document, graph, selectedId, select) {
  const root = document.createElement("div");
  root.className = "interaction-graph-surface";
  root.style.width = `${graph.width}px`; root.style.height = `${graph.height}px`;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", graph.width); svg.setAttribute("height", graph.height); svg.setAttribute("aria-hidden", "true");
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const edge of graph.edges) {
    const from = byId.get(edge.source); const to = byId.get(edge.target);
    const path = document.createElementNS(svg.namespaceURI, "path");
    const x = from.x + 192; const y = from.y + 34; const tx = to.x; const ty = to.y + 34;
    path.setAttribute("d", `M${x} ${y} C${x + 28} ${y}, ${tx - 28} ${ty}, ${tx} ${ty}`);
    path.setAttribute("class", edge.invocationActionId == null ? "context-connection" : "invoke-connection");
    svg.append(path);
  }
  root.append(svg);
  for (const node of graph.nodes) {
    const button = document.createElement("button");
    button.type = "button"; button.className = "interaction-graph-node";
    button.dataset.turnId = node.id; button.style.left = `${node.x}px`; button.style.top = `${node.y}px`;
    if (String(selectedId) === node.id) button.setAttribute("aria-current", "true");
    const label = document.createElement("span"); label.className = "interaction-graph-node-label";
    label.textContent = node.text || "Interaction";
    const status = document.createElement("small"); status.textContent = interactionGraphStatus(node);
    const incoming = graph.edges.filter((edge) => edge.target === node.id);
    const relationships = incoming.map((edge) => {
      const source = byId.get(edge.source)?.text || "Interaction";
      const kinds = [];
      if (edge.layers.length) kinds.push("attached context from");
      if (edge.invocationActionId != null) kinds.push("invoked from");
      return `${kinds.join(" and ")} ${source}`;
    });
    button.setAttribute("aria-label", `${label.textContent}. ${status.textContent}.${relationships.length ? ` ${relationships.join("; ")}.` : ""}`);
    button.disabled = !node.localTurn && node.completionStatus !== "accepted";
    button.append(label, status); button.onclick = () => { if (!button.disabled) select(node); };
    root.append(button);
  }
  return root;
}
