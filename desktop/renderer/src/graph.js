import { activeThread, appState, viewState } from "./state.js";
import { setMainView } from "./navigation.js";
import { $, $$, escapeHtml } from "./ui.js";
import { interactionForThread, responseNodesForThread } from "./thread-model.js";

let physicsFrame;
let graphNodes = [];
let graphEdges = [];
let dragging = null;

export function renderThread() {
  const thread = activeThread();
  if (!thread) {
    setMainView("new");
    return;
  }
  setMainView("thread");
  $("#threadTitle").textContent = thread.title;
  const project = appState.projects.find((item) => String(item.id) === String(thread.projectId));
  $("#threadScope").textContent = project?.name || "No folder";
  const interaction = interactionForThread(appState, thread);
  $("#interactionText").textContent = interaction?.text || interaction?.summary || interaction?.content || thread.title;
  renderRunState();
  renderGraph();
}

function renderRunState() {
  const status = appState.status || "idle";
  const display = status === "accepted" ? "Complete"
    : status === "submitted" ? "Submitted"
    : status === "running" ? "Thinking"
      : status === "idle" ? "Ready"
        : status[0].toUpperCase() + status.slice(1);
  $("#runState").className = `run-state ${status === "running" ? "running" : ["failed", "cancelled"].includes(status) ? "failed" : ""}`;
  $("#runState span").textContent = display;
  $("#stopRun").classList.toggle("hidden", status !== "running");
  $("#retryRun").classList.toggle("hidden", !["failed", "cancelled", "blocked"].includes(status));
}

function hash(value) {
  let result = 0;
  for (const character of value) result = ((result << 5) - result + character.charCodeAt(0)) | 0;
  return Math.abs(result);
}

function renderGraph() {
  const thread = activeThread();
  const responseNodes = responseNodesForThread(appState, thread);
  $("#graphEmpty").classList.toggle("hidden", responseNodes.length > 0);
  $("#graphStage").classList.toggle("hidden", responseNodes.length === 0);
  if (!responseNodes.length) return;

  const bounds = $("#graphStage").getBoundingClientRect();
  const previous = new Map(graphNodes.map((node) => [node.id, node]));
  graphNodes = responseNodes.map((node, index) => previous.get(node.id) || {
    ...node,
    x: Math.max(120, bounds.width / 2 + ((hash(node.id) % 300) - 150)),
    y: Math.max(90, bounds.height / 2 + ((hash(`${node.id}-y`) % 220) - 110)),
    vx: 0,
    vy: 0,
    index,
  });
  const ids = new Set(graphNodes.map((node) => node.id));
  graphEdges = (appState.edges || []).filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  $("#nodeLayer").innerHTML = graphNodes.map((node) => `<div class="graph-node ${node.id === viewState.selectedNodeId ? "selected" : ""}" data-node="${escapeHtml(node.id)}"><div class="glyph">${escapeHtml(node.metadata?.relayer?.icon || String(node.kind || "N")[0].toUpperCase())}</div><div class="copy"><b>${escapeHtml(node.title)}</b><small>${escapeHtml(node.kind)}</small></div></div>`).join("");
  $$('[data-node]').forEach((element) => {
    element.onclick = () => selectNode(element.dataset.node);
    element.onpointerdown = (event) => {
      event.preventDefault();
      dragging = graphNodes.find((node) => node.id === element.dataset.node);
      element.setPointerCapture(event.pointerId);
    };
    element.onpointermove = (event) => {
      if (!dragging || dragging.id !== element.dataset.node) return;
      const rect = $("#graphStage").getBoundingClientRect();
      dragging.x = event.clientX - rect.left;
      dragging.y = event.clientY - rect.top;
      dragging.vx = 0;
      dragging.vy = 0;
      drawGraph();
    };
    element.onpointerup = () => { dragging = null; };
  });
  cancelAnimationFrame(physicsFrame);
  let ticks = 0;
  const simulate = () => {
    physicsStep(bounds);
    drawGraph();
    if (++ticks < 220) physicsFrame = requestAnimationFrame(simulate);
  };
  simulate();
}

function physicsStep(bounds) {
  const centerX = bounds.width / 2;
  const centerY = bounds.height / 2;
  for (let i = 0; i < graphNodes.length; i++) {
    for (let j = i + 1; j < graphNodes.length; j++) {
      const a = graphNodes[i];
      const b = graphNodes[j];
      const dx = b.x - a.x || 0.1;
      const dy = b.y - a.y || 0.1;
      const distance2 = Math.max(400, dx * dx + dy * dy);
      const force = 950 / distance2;
      a.vx -= dx * force;
      a.vy -= dy * force;
      b.vx += dx * force;
      b.vy += dy * force;
    }
  }
  for (const edge of graphEdges) {
    const a = graphNodes.find((node) => node.id === edge.source);
    const b = graphNodes.find((node) => node.id === edge.target);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const distance = Math.hypot(dx, dy) || 1;
    const force = (distance - 150) * 0.002;
    a.vx += dx * force;
    a.vy += dy * force;
    b.vx -= dx * force;
    b.vy -= dy * force;
  }
  for (const node of graphNodes) {
    if (dragging?.id === node.id) continue;
    node.vx = (node.vx + (centerX - node.x) * 0.0014) * 0.88;
    node.vy = (node.vy + (centerY - node.y) * 0.0014) * 0.88;
    node.x = Math.max(85, Math.min(bounds.width - 85, node.x + node.vx));
    node.y = Math.max(55, Math.min(bounds.height - 55, node.y + node.vy));
  }
}

function drawGraph() {
  for (const node of graphNodes) {
    const element = $(`[data-node="${CSS.escape(node.id)}"]`);
    if (element) {
      element.style.left = `${node.x}px`;
      element.style.top = `${node.y}px`;
    }
  }
  $("#edgeCanvas").innerHTML = graphEdges.map((edge) => {
    const a = graphNodes.find((node) => node.id === edge.source);
    const b = graphNodes.find((node) => node.id === edge.target);
    return a && b ? `<line class="graph-edge" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>` : "";
  }).join("");
}

function selectNode(id) {
  viewState.selectedNodeId = id;
  const node = appState.nodes.find((item) => item.id === id);
  if (!node) return;
  $("#inspector").classList.remove("hidden");
  $("#detailIcon").textContent = node.metadata?.relayer?.icon || String(node.kind || "N")[0].toUpperCase();
  $("#detailKind").textContent = node.kind;
  $("#detailTitle").textContent = node.title;
  $("#detailContent").textContent = node.summary || node.content || "No details supplied.";
  const actions = Array.isArray(node.metadata?.actions) ? node.metadata.actions : [];
  $("#detailActions").classList.toggle("hidden", !actions.length);
  $("#detailActions").innerHTML = actions.map((action) => `<button>${escapeHtml(action.label || action.title || "Action")}</button>`).join("");
  renderGraph();
}
