// Canonical Product projection only. Sequence orders cards; it never creates edges.
//
// The graph is also the run view (#721, #722). A node's runs fold into its head card as a deck,
// an agent's children collapse under their parent as a chip, and each card carries corner
// controls for its run: Stop, Remove, or Resume and Discard after a restart.

// Statuses a restart leaves for the user to resume or discard (#722). Neither is active work.
export const RESUMABLE_STATUSES = new Set(["paused", "interrupted"]);
// Runs that are still part of their node's queue: running, waiting, or stopped by a restart.
const CHAIN_STATUSES = new Set(["not_started", "submitted", "queued", "running", "waiting_for_approval", ...RESUMABLE_STATUSES]);
const RUNNING_STATUSES = new Set(["submitted", "running", "waiting_for_approval"]);
const CARD_HEIGHT = 70;
const ROW_GAP = 28;
const DECK_TOGGLE_HEIGHT = 26;
const DECK_ROW_HEIGHT = 24;
const DECK_LIST_PADDING = 12;
const CHIP_HEIGHT = 30;

const chainKey = (turn) => `${turn.threadId}:${turn.runNodeId}`;
const bySequence = (left, right) => (Number(left.sequence) - Number(right.sequence)) || (Number(left.id) - Number(right.id));

/** Each agent-launched child's parent run, by child id. Only its parent agent may stop it. */
export function agentChildParents(invocations = []) {
  return new Map(invocations
    .filter((invocation) => invocation.agentInvoked === true && invocation.resultInteractionId != null)
    .map((invocation) => [String(invocation.resultInteractionId), String(invocation.sourceInteractionId)]));
}

// A child belongs to its parent's latest attempt unless it was created before that attempt
// started: a resumed parent runs a fresh attempt on its interaction, and the children of its
// earlier attempt are history. Both times are durable, so the grouping survives a restart.
function childAttempt(child, parent) {
  const started = Number(parent?.latestAttempt?.startedAt);
  const created = Number(child.createdAt);
  if (!Number.isFinite(started) || !Number.isFinite(created)) return "current";
  return created < started ? "previous" : "current";
}

const interruptedChild = (child) => child.latestAttempt?.failureCategory === "application_restart"
  || (child.completionStatus === "failed" && /interrupted|restart/i.test(child.completionError ?? ""));

// An invoke whose preparation failed before anything ran waits for its action's Retry, its only
// control; it is neither running nor part of its node's queue.
function preparationsAwaitingRetry(invocations = []) {
  return new Set(invocations
    .filter((invocation) => invocation.preparationRecoverable === true && invocation.resultInteractionId != null)
    .map((invocation) => String(invocation.resultInteractionId)));
}

/**
 * The human runs on each node, in creation order, that are still part of its queue: running,
 * waiting, or stopped by a restart.
 */
export function nodeRunChains(turns = [], invocations = []) {
  const children = agentChildParents(invocations);
  const awaitingRetry = preparationsAwaitingRetry(invocations);
  const chains = new Map();
  for (const turn of [...turns].sort(bySequence)) {
    if (turn.runNodeId == null || children.has(String(turn.id)) || awaitingRetry.has(String(turn.id))
      || !CHAIN_STATUSES.has(turn.completionStatus)) continue;
    const key = chainKey(turn);
    if (!chains.has(key)) chains.set(key, []);
    chains.get(key).push(turn);
  }
  return chains;
}

// The runs a restart stopped on the run's node, in creation order. The first is the head: only
// it resumes, and the paused runs behind it resume with it, in order (#722).
function restartChain(turn, chains) {
  if (turn.runNodeId == null) return [turn];
  return (chains.get(chainKey(turn)) ?? [turn]).filter((run) => RESUMABLE_STATUSES.has(run.completionStatus));
}

/** Whether a run is one the user must resume or discard first: a standalone run or a chain head. */
export function runNeedsAttention(turn, chains) {
  return RESUMABLE_STATUSES.has(turn.completionStatus) && String(restartChain(turn, chains)[0]?.id) === String(turn.id);
}

/** What the user can do with a run from its card (#721): Stop, Remove, or Resume and Discard. */
export function runControls(turn, { chains = new Map(), children = new Map(), controllable = true, awaitingRetry = new Set() } = {}) {
  // An agent's child is never stopped or resumed by the product: only its parent agent may. A
  // preparation waiting for its action's Retry has only that Retry.
  if (!controllable || children.has(String(turn.id)) || awaitingRetry.has(String(turn.id))) return [];
  const status = turn.completionStatus;
  const stopping = Boolean(turn.stopRequested && !turn.stopError);
  if (status === "queued") return [{ action: "remove", label: "Remove: take it out of the queue. Its text is kept.", icon: "✕", disabled: stopping }];
  if (RUNNING_STATUSES.has(status)) return [{ action: "stop", label: stopping ? "Stopping this run" : "Stop this run", icon: "■", disabled: stopping }];
  if (!RESUMABLE_STATUSES.has(status)) return [];
  const discard = { action: "discard", label: "Discard: mark it stopped. Its text is kept.", icon: "✕" };
  const chain = restartChain(turn, chains);
  if (String(chain[0]?.id) !== String(turn.id)) return [discard];
  const count = chain.length;
  return [
    { action: "resume", label: count > 1 ? `Resume ${count} in order` : "Resume", icon: count > 1 ? `▶ ${count}` : "▶", count },
    discard,
  ];
}

/**
 * The graph popover's model. `invocations` names the agent's children, `expanded` the decks and
 * chips the user opened, `nodeLabels` the node titles for decks, and `controllable` whether
 * cards offer run controls.
 */
export function interactionGraph(turns, selectedId, options = {}) {
  const selected = turns.find((turn) => String(turn.id) === String(selectedId));
  // A run a restart stopped needs its controls even when the selected turn has no graph
  // projection, such as a thread whose only message paused before it was prepared (#722).
  if (selected?.interactionGraph?.enabled !== true
    && !(selected && turns.some((turn) => RESUMABLE_STATUSES.has(turn.completionStatus)))) return null;
  const { invocations = [], expanded = new Set(), nodeLabels = new Map(), controllable = false } = options;
  const children = agentChildParents(invocations);
  const awaitingRetry = preparationsAwaitingRetry(invocations);
  const chains = nodeRunChains(turns, invocations);
  const local = new Map(turns.map((turn) => [String(turn.id), turn]));
  // A node's queue folds into its head card as a deck; queued runs have no response to view.
  // The live queue and a restart's chain are separate: runs waiting behind the run that holds
  // the node fold into that run's card, and paused runs into their chain's head. A running run
  // is never folded: its response is there to view.
  const folded = new Map();
  const fold = (head, behind) => { if (head && behind.length) folded.set(String(head.id), [...(folded.get(String(head.id)) ?? []), ...behind]); };
  for (const chain of chains.values()) {
    const restart = chain.filter((run) => RESUMABLE_STATUSES.has(run.completionStatus));
    fold(restart[0], restart.slice(1));
    const live = chain.filter((run) => !RESUMABLE_STATUSES.has(run.completionStatus));
    fold(live[0], live.slice(1).filter((run) => run.completionStatus === "queued"));
  }
  const foldedIds = new Set([...folded.values()].flat().map((turn) => String(turn.id)));
  // An agent's children collapse under their parent as a chip: one for the parent's current
  // attempt and one for its previous attempt. Expanding a chip shows its children.
  const chips = new Map();
  for (const [childId, parentId] of children) {
    const child = local.get(childId);
    if (!child || !local.has(parentId)) continue;
    const attempt = childAttempt(child, local.get(parentId));
    const id = `${attempt === "previous" ? "previous" : "agents"}:${parentId}`;
    if (!chips.has(id)) chips.set(id, { id, kind: "chip", parentId, attempt, children: [] });
    chips.get(id).children.push(child);
  }
  const shownChildren = new Set([...chips.values()]
    .filter((chip) => expanded.has(chip.id))
    .flatMap((chip) => chip.children.map((child) => String(child.id))));
  const nodes = new Map();
  for (const turn of turns) {
    const id = String(turn.id);
    // A folded run shows in its head's deck only; a selected child shows beside its chip.
    const hiddenChild = children.has(id) && local.has(children.get(id)) && !shownChildren.has(id);
    if (foldedIds.has(id) || (hiddenChild && id !== String(selectedId))) continue;
    nodes.set(id, { ...turn, id, kind: "turn", localTurn: true });
  }
  const edges = [];
  for (const turn of turns) {
    const target = String(turn.id);
    if (!nodes.has(target)) continue;
    for (const source of turn.interactionGraph?.sources ?? []) {
      if (source.interactionId == null || source.threadId == null) continue;
      const id = String(source.interactionId);
      if (!nodes.has(id) && !local.has(id)) nodes.set(id, { ...source, id, kind: "turn", localTurn: false });
      if (!nodes.has(id)) continue;
      const layers = source.layers ?? [];
      if (!layers.length && source.invocationActionId == null) continue;
      edges.push({ source: id, target, layers, invocationActionId: source.invocationActionId ?? null });
    }
  }
  // An expanded child hangs off its parent by an invoke edge, even before its own graph
  // interaction names its source.
  for (const childId of shownChildren) {
    const parentId = children.get(childId);
    if (!nodes.has(childId) || !nodes.has(parentId)) continue;
    if (edges.some((edge) => edge.source === parentId && edge.target === childId)) continue;
    edges.push({ source: parentId, target: childId, layers: [], invocationActionId: null, chip: true });
  }
  for (const chip of chips.values()) {
    if (!nodes.has(chip.parentId)) continue;
    const running = chip.children.filter((child) => RUNNING_STATUSES.has(child.completionStatus)).length;
    const interrupted = chip.children.filter(interruptedChild).length;
    const open = expanded.has(chip.id);
    const summary = `${chip.children.length} agent run${chip.children.length === 1 ? "" : "s"}${running ? ` · ${running} running` : ""}${interrupted ? ` · ${interrupted} interrupted` : ""}`;
    const label = chip.attempt === "previous"
      ? `${open ? "▾ hide previous attempt" : `previous attempt · ${summary}`}`
      : `${open ? "▾ hide agent runs" : `+${summary}`}`;
    nodes.set(chip.id, { ...chip, open, label, summary });
    edges.push({ source: chip.parentId, target: chip.id, layers: [], invocationActionId: null, chip: true });
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
  const counts = { running: 0, queued: 0, capacity: 0, paused: 0, interrupted: 0 };
  for (const turn of turns) {
    if (children.has(String(turn.id)) || awaitingRetry.has(String(turn.id))) continue;
    const status = turn.completionStatus;
    if (RUNNING_STATUSES.has(status)) counts.running += 1;
    else if (status === "queued") counts[turn.queueReason === "capacity" ? "capacity" : "queued"] += 1;
    else if (status === "paused") counts.paused += 1;
    else if (status === "interrupted") counts.interrupted += 1;
  }
  const columns = new Map();
  const positioned = [...nodes.values()].map((node) => {
    const level = levels.get(node.id);
    const deck = node.kind === "turn" ? (folded.get(node.id) ?? []) : [];
    const deckOpen = deck.length > 0 && expanded.has(`deck:${node.id}`);
    const height = node.kind === "chip" ? CHIP_HEIGHT
      : CARD_HEIGHT + (deck.length ? DECK_TOGGLE_HEIGHT : 0) + (deckOpen ? DECK_LIST_PADDING + deck.length * DECK_ROW_HEIGHT : 0);
    const y = columns.get(level) ?? 20;
    columns.set(level, y + height + ROW_GAP);
    const placed = { ...node, x: 20 + level * 224, y, height };
    if (node.kind !== "turn") return placed;
    return {
      ...placed,
      agentRun: children.has(node.id),
      preparationRecoverable: awaitingRetry.has(node.id),
      deck: deck.map((run) => ({ ...run, id: String(run.id), controls: runControls(run, { chains, children, controllable, awaitingRetry }) })),
      deckOpen,
      deckLabel: deck.length ? nodeLabels.get(String(node.runNodeId)) ?? "this node" : null,
      deckPaused: deck.some((run) => RESUMABLE_STATUSES.has(run.completionStatus)),
      controls: node.localTurn ? runControls(node, { chains, children, controllable, awaitingRetry }) : [],
      needsAttention: node.localTurn && !children.has(node.id) && runNeedsAttention(node, chains),
    };
  });
  return {
    nodes: positioned,
    edges,
    incomplete: turns.some((turn) => turn.interactionGraph?.complete === false),
    contextCount: selected.contexts?.length ?? 0,
    counts,
    // Paused and interrupted runs wait for the user (#722). The trigger shows their amber count.
    attention: counts.paused + counts.interrupted,
    // Resume all resumes every queue head and every standalone run (#721).
    resumable: counts.paused + counts.interrupted,
    width: Math.max(448, ...positioned.map((node) => node.x + 212)),
    height: Math.max(160, ...positioned.map((node) => node.y + node.height + 20)),
  };
}

// The status every card shows without hover. The amber Paused and Interrupted by restart tell a
// user which cards need them after a relaunch (#721).
export function interactionGraphStatus(node) {
  const status = node.completionStatus;
  if (status === "accepted") return "Response ready";
  if (node.preparationRecoverable && ["not_started", "submitted"].includes(status)) return "Waiting for Retry";
  if (CHAIN_STATUSES.has(status) && !RESUMABLE_STATUSES.has(status) && node.stopRequested && !node.stopError) return "Stopping…";
  if (status === "queued" && node.queueReason === "capacity") return "Waiting for capacity";
  if (status === "queued") return "Queued";
  if (status === "paused") return "Paused";
  if (status === "interrupted") return "Interrupted by restart";
  if (status === "running" || status === "submitted") return "Running";
  if (status === "waiting_for_approval") return "Needs approval";
  if (status === "failed") return "Failed";
  if (status === "stopped") return "Stopped";
  return status || "Interaction";
}

// The header's status chips, in the order the popover shows them (#721).
export function interactionGraphStatusChips(graph) {
  return [
    ["running", graph.counts.running, "running"],
    ["queued", graph.counts.queued, "queued"],
    ["capacity", graph.counts.capacity, "waiting for capacity"],
    ["paused", graph.counts.paused, "paused"],
    ["interrupted", graph.counts.interrupted, "interrupted"],
  ].filter(([, count]) => count > 0).map(([kind, count, label]) => ({ kind, count, text: `${count} ${label}` }));
}

const statusClass = (status) => (RESUMABLE_STATUSES.has(status) ? "needs-resume" : RUNNING_STATUSES.has(status) ? "running" : status === "queued" ? "queued" : "");

function controlButton(document, control, run, act) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `interaction-graph-control ${control.action}`;
  button.dataset.runAction = control.action;
  button.dataset.runId = String(run.id);
  button.textContent = control.icon;
  button.title = control.label;
  button.setAttribute("aria-label", `${control.label} ${run.text || "Interaction"}`);
  button.disabled = Boolean(control.disabled);
  button.onclick = (event) => { event.stopPropagation(); if (!button.disabled) act?.(control.action, run); };
  return button;
}

export function renderInteractionGraph(document, graph, selectedId, select, controls = {}) {
  const root = document.createElement("div");
  root.className = "interaction-graph-surface";
  root.style.width = `${graph.width}px`; root.style.height = `${graph.height}px`;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", graph.width); svg.setAttribute("height", graph.height); svg.setAttribute("aria-hidden", "true");
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const edge of graph.edges) {
    const from = byId.get(edge.source); const to = byId.get(edge.target);
    const path = document.createElementNS(svg.namespaceURI, "path");
    const x = from.x + 192; const y = from.y + 34; const tx = to.x; const ty = to.y + (to.kind === "chip" ? 15 : 34);
    path.setAttribute("d", `M${x} ${y} C${x + 28} ${y}, ${tx - 28} ${ty}, ${tx} ${ty}`);
    path.setAttribute("class", edge.chip ? "invoke-connection agent-connection" : edge.invocationActionId == null ? "context-connection" : "invoke-connection");
    svg.append(path);
  }
  root.append(svg);
  for (const node of graph.nodes) {
    if (node.kind === "chip") {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `interaction-graph-chip${node.attempt === "previous" ? " previous-attempt" : ""}`;
      chip.dataset.chipId = node.id;
      chip.style.left = `${node.x}px`; chip.style.top = `${node.y}px`;
      chip.textContent = node.label;
      chip.setAttribute("aria-expanded", String(node.open));
      chip.setAttribute("aria-label", node.attempt === "previous" ? `Previous attempt: ${node.summary}` : `Agent runs: ${node.summary}`);
      chip.onclick = () => controls.onToggle?.(node.id);
      root.append(chip);
      continue;
    }
    const card = document.createElement("div");
    card.className = `interaction-graph-card${node.deck.length ? " deck" : ""}${node.needsAttention ? " needs-attention" : ""}${node.agentRun ? " agent-run" : ""}`;
    card.dataset.cardId = node.id;
    if (node.needsAttention) card.dataset.needsAttention = "true";
    card.style.left = `${node.x}px`; card.style.top = `${node.y}px`;
    const button = document.createElement("button");
    button.type = "button"; button.className = "interaction-graph-node";
    button.dataset.turnId = node.id;
    if (String(selectedId) === node.id) button.setAttribute("aria-current", "true");
    const label = document.createElement("span"); label.className = "interaction-graph-node-label";
    label.textContent = node.text || "Interaction";
    const status = document.createElement("small"); status.textContent = interactionGraphStatus(node);
    const kind = statusClass(node.completionStatus);
    if (kind) status.className = `interaction-graph-status ${kind}`;
    const incoming = graph.edges.filter((edge) => edge.target === node.id);
    const relationships = incoming.map((edge) => {
      const source = byId.get(edge.source)?.text || "Interaction";
      const kinds = [];
      if (edge.layers.length) kinds.push("attached context from");
      if (edge.invocationActionId != null) kinds.push("invoked from");
      return `${kinds.join(" and ")} ${source}`;
    });
    const queue = node.deck.length ? ` Then ${node.deck.length} more on ${node.deckLabel}${node.deckPaused ? ", paused" : ""}.` : "";
    button.setAttribute("aria-label", `${label.textContent}. ${status.textContent}.${relationships.length ? ` ${relationships.join("; ")}.` : ""}${queue}`);
    button.disabled = !node.localTurn && node.completionStatus !== "accepted";
    button.append(label, status); button.onclick = () => { if (!button.disabled) select(node); };
    card.append(button);
    // Controls are corner icons revealed on hover or keyboard focus. They reserve no space and
    // never float outside the card; each has a tooltip and an accessible name.
    if (node.controls.length) {
      const corner = document.createElement("div");
      corner.className = "interaction-graph-controls";
      for (const control of node.controls) corner.append(controlButton(document, control, node, controls.onRun));
      card.append(corner);
    }
    if (node.deck.length) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "interaction-graph-deck-toggle";
      toggle.dataset.deckFor = node.id;
      toggle.setAttribute("aria-expanded", String(node.deckOpen));
      toggle.textContent = `${node.deckOpen ? "▾" : "▸"} then ${node.deck.length} more on ${node.deckLabel}${node.deckPaused ? " · paused" : ""}`;
      toggle.onclick = () => controls.onToggle?.(`deck:${node.id}`);
      card.append(toggle);
      if (node.deckOpen) {
        const list = document.createElement("ol");
        list.className = "interaction-graph-deck";
        list.start = 2;
        for (const run of node.deck) {
          const item = document.createElement("li");
          item.dataset.runId = run.id;
          const text = document.createElement("span");
          text.className = "interaction-graph-deck-text";
          text.textContent = run.text || "Interaction";
          text.title = `${run.text || "Interaction"} · ${interactionGraphStatus(run)}`;
          item.append(text);
          for (const control of run.controls) item.append(controlButton(document, control, run, controls.onRun));
          list.append(item);
        }
        card.append(list);
      }
    }
    root.append(card);
  }
  return root;
}
