import { escapeHtml } from "../ui.js";
import {
  interactionForThread,
  responseNodesForThread,
  workspaceModeCapabilities,
} from "./model.js";
import { renderMarkdown } from "./markdown.js";
import { productWorkspaceMarkup } from "./view.js";

function hash(value) {
  let result = 0;
  for (const character of String(value)) {
    result = ((result << 5) - result + character.charCodeAt(0)) | 0;
  }
  return Math.abs(result);
}

export const GRAPH_NODE_ICON_RADIUS = 24;

export function graphEdgeSegment(source, target, radius = GRAPH_NODE_ICON_RADIUS) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.hypot(dx, dy);
  if (!distance) {
    return { x1: source.x, y1: source.y, x2: target.x, y2: target.y };
  }
  const offsetX = (dx / distance) * radius;
  const offsetY = (dy / distance) * radius;
  return {
    x1: source.x + offsetX,
    y1: source.y + offsetY,
    x2: target.x - offsetX,
    y2: target.y - offsetY,
  };
}

export function createProductWorkspace({
  root = document,
  mode = "interactive",
  getState,
  getThread,
  selection,
  showThread,
  showEmpty,
  onSelectTurn = () => {},
  onSubmitInteraction = async () => {},
  onNavigateLayer = async () => {},
  onInvokeAction = async () => {},
}) {
  const capabilities = workspaceModeCapabilities(mode);
  let physicsFrame;
  let graphNodes = [];
  let graphEdges = [];
  let graphSignature = "";
  let graphThreadId = "";
  let dragging = null;

  const $ = (selector) => root.querySelector(selector);
  const $$ = (selector) => [...root.querySelectorAll(selector)];

  const threadView = $("#threadView");
  if (!threadView) throw new Error("Product workspace requires a #threadView host.");
  threadView.innerHTML = productWorkspaceMarkup();
  $("#closeInspector").onclick = () => $("#inspector").classList.add("hidden");
  $("#previousTurn").onclick = () => onSelectTurn(-1);
  $("#nextTurn").onclick = () => onSelectTurn(1);
  const prompt = $("#threadPrompt");
  const send = $("#sendInteraction");
  prompt.oninput = () => { send.disabled = !prompt.value.trim(); };
  prompt.onkeydown = (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      send.click();
    }
  };
  send.onclick = async () => {
    const text = prompt.value.trim();
    if (!text || send.disabled) return;
    prompt.disabled = true;
    send.disabled = true;
    try {
      await onSubmitInteraction(text);
      prompt.value = "";
    } finally {
      prompt.disabled = false;
      send.disabled = !prompt.value.trim();
    }
  };

  function applyMode() {
    threadView.dataset.workspaceMode = mode;
    threadView.dataset.canNavigate = String(capabilities.canNavigate);
    threadView.dataset.canCompose = String(capabilities.canCompose);
    threadView.dataset.canInvokeMutatingActions = String(capabilities.canInvokeMutatingActions);
    $("#threadComposer").classList.toggle("disabled-composer", !capabilities.canCompose);
    prompt.classList.toggle("hidden", !capabilities.canCompose);
    send.classList.toggle("hidden", !capabilities.canCompose);
    if (!capabilities.canCompose) $("#threadComposer").textContent = "Read-only evaluation result";
  }

  function render() {
    const state = getState();
    const thread = getThread();
    if (!thread) {
      showEmpty();
      return;
    }
    applyMode();
    showThread();
    $("#threadTitle").textContent = thread.title;
    const project = state.projects.find((item) => String(item.id) === String(thread.projectId));
    $("#threadScope").textContent = project?.name || "No folder";
    const interaction = interactionForThread(state, thread);
    $("#interactionText").textContent = interaction?.text
      || interaction?.summary
      || interaction?.content
      || thread.title;
    const turns = (state.interactions || []).filter((item) => String(item.threadId) === String(thread.id));
    const turnIndex = turns.findIndex((item) => String(item.id) === String(interaction?.id));
    $("#previousTurn").disabled = turnIndex <= 0;
    $("#nextTurn").disabled = turnIndex < 0 || turnIndex >= turns.length - 1;
    renderRunState(state);
    renderGraph(state, thread);
  }

  function renderRunState(state) {
    const status = state.status || "idle";
    const display = status === "accepted" ? "Complete"
      : status === "submitted" ? "Submitted"
        : status === "running" ? "Thinking"
          : status === "idle" ? "Ready"
            : status[0].toUpperCase() + status.slice(1);
    const runState = $("#runState");
    runState.className = `run-state ${status === "running" ? "running" : ["failed", "cancelled"].includes(status) ? "failed" : ""}`;
    runState.querySelector("span").textContent = display;
  }

  function renderGraph(state, thread) {
    const responseNodes = responseNodesForThread(state, thread);
    $("#graphEmpty").classList.toggle("hidden", responseNodes.length > 0);
    $("#graphStage").classList.toggle("hidden", responseNodes.length === 0);
    if (!responseNodes.length) {
      const message = state.status === "failed" ? "This interaction failed before producing an accepted graph."
        : state.status === "running" ? "Relayer is building the graph…"
          : "This interaction has no accepted graph yet.";
      $("#graphEmpty p").textContent = message;
      return;
    }

    const bounds = $("#graphStage").getBoundingClientRect();
    const nextThreadId = String(thread.id);
    const previous = nextThreadId === graphThreadId
      ? new Map(graphNodes.map((node) => [node.id, node]))
      : new Map();
    graphThreadId = nextThreadId;
    graphNodes = responseNodes.map((node, index) => {
      const prior = previous.get(node.id);
      return prior ? {
        ...node,
        x: prior.x,
        y: prior.y,
        vx: prior.vx,
        vy: prior.vy,
        pinned: prior.pinned,
        index,
      } : {
        ...node,
        x: Math.max(120, bounds.width / 2 + ((hash(node.id) % 300) - 150)),
        y: Math.max(90, bounds.height / 2 + ((hash(`${node.id}-y`) % 220) - 110)),
        vx: 0,
        vy: 0,
        pinned: false,
        index,
      };
    });
    const ids = new Set(graphNodes.map((node) => node.id));
    graphEdges = (state.edges || []).filter((edge) => {
      const [source, target] = edge.endpoints || [edge.source, edge.target];
      return ids.has(source) && ids.has(target);
    });
    const nextSignature = JSON.stringify({
      threadId: graphThreadId,
      nodes: graphNodes.map((node) => node.id),
      edges: graphEdges.map((edge) => edge.endpoints || [edge.source, edge.target]),
    });
    const topologyChanged = nextSignature !== graphSignature;
    graphSignature = nextSignature;
    $("#nodeLayer").innerHTML = graphNodes.map((node) => `<div class="graph-node ${String(node.id) === String(selection.selectedNodeId) ? "selected" : ""}" data-node="${escapeHtml(node.id)}"><div class="glyph">${escapeHtml(node.icon || node.metadata?.relayer?.icon || String(node.kind || "N")[0].toUpperCase())}</div><div class="copy"><b>${escapeHtml(node.title)}</b></div></div>`).join("");
    $$('[data-node]').forEach((element) => {
      element.onclick = () => selectNode(state, element.dataset.node);
      element.onpointerdown = (event) => {
        event.preventDefault();
        const node = graphNodes.find((candidate) => String(candidate.id) === element.dataset.node);
        dragging = node ? {
          node,
          startClientX: event.clientX,
          startClientY: event.clientY,
          moved: false,
        } : null;
        element.setPointerCapture(event.pointerId);
      };
      element.onpointermove = (event) => {
        if (!dragging || String(dragging.node.id) !== element.dataset.node) return;
        const rect = $("#graphStage").getBoundingClientRect();
        const distance = Math.hypot(
          event.clientX - dragging.startClientX,
          event.clientY - dragging.startClientY,
        );
        dragging.moved ||= distance >= 3;
        dragging.node.x = Math.max(82, Math.min(rect.width - 82, event.clientX - rect.left));
        dragging.node.y = Math.max(32, Math.min(rect.height - 76, event.clientY - rect.top));
        dragging.node.vx = 0;
        dragging.node.vy = 0;
        if (dragging.moved) dragging.node.pinned = true;
        drawGraph();
      };
      const finishDrag = () => { dragging = null; };
      element.onpointerup = finishDrag;
      element.onpointercancel = finishDrag;
    });
    cancelAnimationFrame(physicsFrame);
    if (!topologyChanged) {
      drawGraph();
      return;
    }
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
    const anchored = (node) => node.pinned || dragging?.node.id === node.id;
    for (let i = 0; i < graphNodes.length; i++) {
      for (let j = i + 1; j < graphNodes.length; j++) {
        const a = graphNodes[i];
        const b = graphNodes[j];
        const dx = b.x - a.x || 0.1;
        const dy = b.y - a.y || 0.1;
        const distance2 = Math.max(400, dx * dx + dy * dy);
        const force = 950 / distance2;
        if (!anchored(a)) {
          a.vx -= dx * force;
          a.vy -= dy * force;
        }
        if (!anchored(b)) {
          b.vx += dx * force;
          b.vy += dy * force;
        }
      }
    }
    for (const edge of graphEdges) {
      const [source, target] = edge.endpoints || [edge.source, edge.target];
      const a = graphNodes.find((node) => node.id === source);
      const b = graphNodes.find((node) => node.id === target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy) || 1;
      const force = (distance - 150) * 0.002;
      if (!anchored(a)) {
        a.vx += dx * force;
        a.vy += dy * force;
      }
      if (!anchored(b)) {
        b.vx -= dx * force;
        b.vy -= dy * force;
      }
    }
    for (const node of graphNodes) {
      if (anchored(node)) {
        node.vx = 0;
        node.vy = 0;
        continue;
      }
      node.vx = (node.vx + (centerX - node.x) * 0.0014) * 0.88;
      node.vy = (node.vy + (centerY - node.y) * 0.0014) * 0.88;
      node.x = Math.max(82, Math.min(bounds.width - 82, node.x + node.vx));
      node.y = Math.max(32, Math.min(bounds.height - 76, node.y + node.vy));
    }
  }

  function drawGraph() {
    for (const node of graphNodes) {
      const element = $$('[data-node]').find((item) => item.dataset.node === String(node.id));
      if (element) {
        element.style.left = `${node.x}px`;
        element.style.top = `${node.y}px`;
      }
    }
    $("#edgeCanvas").innerHTML = graphEdges.map((edge) => {
      const [source, target] = edge.endpoints || [edge.source, edge.target];
      const a = graphNodes.find((node) => String(node.id) === String(source));
      const b = graphNodes.find((node) => String(node.id) === String(target));
      if (!a || !b) return "";
      const segment = graphEdgeSegment(a, b);
      return `<line class="graph-edge" x1="${segment.x1}" y1="${segment.y1}" x2="${segment.x2}" y2="${segment.y2}"/>`;
    }).join("");
  }

  function selectNode(state, id) {
    selection.selectedNodeId = id;
    const node = state.nodes.find((item) => String(item.id) === String(id));
    if (!node) return;
    $("#inspector").classList.remove("hidden");
    $("#detailIcon").textContent = node.icon || node.metadata?.relayer?.icon || String(node.kind || "N")[0].toUpperCase();
    $("#detailKind").textContent = node.kind;
    $("#detailTitle").textContent = node.title;
    renderMarkdown($("#detailContent"), node.detail || node.summary || node.content || "No details supplied.");
    const actions = (state.actions || []).filter((action) => String(action.sourceNodeId) === String(node.id));
    $("#detailActions").classList.toggle("hidden", !actions.length);
    $("#detailActions").innerHTML = actions.map((action) => `<button>${escapeHtml(action.label || action.title || "Action")}</button>`).join("");
    [...$("#detailActions").querySelectorAll("button")].forEach((button, index) => {
      const action = actions[index];
      const navigational = action?.kind === "navigate" && action.targetLayerId;
      button.disabled = !navigational && !capabilities.canInvokeMutatingActions;
      button.onclick = () => navigational
        ? onNavigateLayer(action.targetLayerId)
        : onInvokeAction(action);
    });
    $$('[data-node]').forEach((element) => {
      element.classList.toggle("selected", element.dataset.node === String(id));
    });
  }

  function dispose() {
    cancelAnimationFrame(physicsFrame);
    dragging = null;
    graphNodes = [];
    graphEdges = [];
    graphSignature = "";
    graphThreadId = "";
  }

  return Object.freeze({
    mode,
    capabilities,
    render,
    dispose,
  });
}
