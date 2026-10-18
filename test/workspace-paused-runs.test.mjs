import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { interactionGraph, interactionGraphStatus, interactionGraphStatusChips } from "../desktop/renderer/src/product-workspace/interaction-graph.js";
import { createProductWorkspace, turnStatusPresentation } from "../desktop/renderer/src/product-workspace/workspace.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const graphEnabled = { enabled: true, complete: true, sources: [] };
const invokedFrom = (source) => ({ enabled: true, complete: true, sources: [{ interactionId: source, threadId: 10, text: "Plan", completionStatus: "accepted", layers: [], invocationActionId: 31 }] });

// After a restart (#722): node 21's run that was executing is interrupted and the two queued
// behind it are paused; a message that waited for capacity is paused; node 22 still has a run.
function restartTurns() {
  const run = (id, completionStatus, extra = {}) => ({ id, threadId: 10, sequence: id, text: `Run ${id}`, completionStatus, interactionGraph: invokedFrom(1), ...extra });
  return [
    { id: 1, threadId: 10, sequence: 1, text: "Plan", completionStatus: "accepted", graphNodeId: 901, interactionGraph: graphEnabled },
    run(5, "interrupted", { runNodeId: 21 }),
    run(6, "paused", { runNodeId: 21 }),
    run(7, "paused", { runNodeId: 21 }),
    { id: 8, threadId: 10, sequence: 8, text: "Waited for a slot", completionStatus: "paused", interactionGraph: graphEnabled },
    run(9, "running", { runNodeId: 22 }),
  ];
}

describe("the interaction graph as the run view (#721, #722)", () => {
  it("folds a node's runs into its head card, and only the head resumes the chain in order", () => {
    const graph = interactionGraph(restartTurns(), 1, { controllable: true, nodeLabels: new Map([["21", "Tiers table"]]) });
    const card = (id) => graph.nodes.find((node) => node.id === id);
    // The chain folds into its head as a deck; queued runs have no response to view.
    expect(graph.nodes.map((node) => node.id)).toEqual(["1", "5", "8", "9"]);
    expect(card("5").deck.map((run) => run.id)).toEqual(["6", "7"]);
    expect(card("5").deckLabel).toBe("Tiers table");
    expect(card("5").deckPaused).toBe(true);
    // The head's Resume says it resumes the whole chain; the rest of the chain offers Discard.
    expect(card("5").controls.map((control) => [control.action, control.icon, control.label])).toEqual([
      ["resume", "▶ 3", "Resume 3 in order"],
      ["discard", "✕", "Discard: mark it stopped. Its text is kept."],
    ]);
    expect(card("5").deck.map((run) => run.controls.map((control) => control.action))).toEqual([["discard"], ["discard"]]);
    // A run that is not on a node resumes on its own; a running run offers Stop.
    expect(card("8").controls.map((control) => control.icon)).toEqual(["▶", "✕"]);
    expect(card("9").controls.map((control) => control.action)).toEqual(["stop"]);
    // The runs that need the user: each chain head and each standalone run.
    expect(graph.nodes.filter((node) => node.needsAttention).map((node) => node.id)).toEqual(["5", "8"]);
    expect(graph.attention).toBe(4);
    expect(interactionGraphStatusChips(graph).map((chip) => chip.text)).toEqual(["1 running", "3 paused", "1 interrupted"]);
    // Read-only views show the same statuses with no controls.
    expect(interactionGraph(restartTurns(), 1).nodes.every((node) => !node.controls?.length)).toBe(true);
    // Discarding the head makes the next paused run the head, still paused.
    const discarded = restartTurns().map((turn) => (turn.id === 5 ? { ...turn, completionStatus: "stopped" } : turn));
    const after = interactionGraph(discarded, 1, { controllable: true });
    expect(after.nodes.find((node) => node.id === "6").controls.map((control) => control.label)).toEqual(["Resume 2 in order", "Discard: mark it stopped. Its text is kept."]);
  });

  it("keeps a running run out of a deck and shows the run view for a turn with no graph yet", () => {
    // After a restart the user starts a new run on node 21, which runs at once beside the
    // chain, and another that waits behind it. The waiting run folds under the run that holds
    // the node, not under the paused chain.
    const turns = [...restartTurns(),
      { id: 10, threadId: 10, sequence: 10, text: "New run", completionStatus: "running", runNodeId: 21, interactionGraph: invokedFrom(1) },
      { id: 11, threadId: 10, sequence: 11, text: "Behind it", completionStatus: "queued", queueReason: "node", runNodeId: 21, interactionGraph: invokedFrom(1) }];
    const graph = interactionGraph(turns, 7, { controllable: true });
    const card = (id) => graph.nodes.find((node) => node.id === id);
    expect(card("5").deck.map((run) => run.id)).toEqual(["6", "7"]);
    expect(card("5").deckPaused).toBe(true);
    expect(card("10").controls.map((control) => control.action)).toEqual(["stop"]);
    expect(card("10").deck.map((run) => run.id)).toEqual(["11"]);
    expect(card("10").deckPaused).toBe(false);
    // A selected run inside a deck is not drawn a second time.
    expect(graph.nodes.filter((node) => node.id === "7")).toHaveLength(0);
    // A preparation waiting for its action's Retry has only that Retry: no Stop, not counted.
    const retry = interactionGraph([...restartTurns(), { id: 12, threadId: 10, sequence: 12, text: "Retry me", completionStatus: "submitted", runNodeId: 23, interactionGraph: invokedFrom(1) }], 1, {
      controllable: true, invocations: [{ sourceInteractionId: 1, actionId: 50, resultInteractionId: 12, preparationRecoverable: true }],
    });
    expect(retry.nodes.find((node) => node.id === "12").controls).toEqual([]);
    expect(interactionGraphStatus(retry.nodes.find((node) => node.id === "12"))).toBe("Waiting for Retry");
    expect(retry.counts.running).toBe(1);
    // A thread whose only message paused before it was prepared still gets its run view.
    const lone = [{ id: 1, threadId: 10, sequence: 1, text: "Waited for a slot", completionStatus: "paused" }];
    expect(interactionGraph(lone, 1, { controllable: true }).nodes[0].controls.map((control) => control.action)).toEqual(["resume", "discard"]);
    expect(interactionGraph([{ id: 1, threadId: 10, completionStatus: "failed" }], 1)).toBeNull();
  });

  it("collapses an agent's children under their parent, apart from an earlier attempt's", () => {
    const parent = { id: 2, threadId: 10, sequence: 2, text: "Audit", completionStatus: "running", runNodeId: 23, latestAttempt: { startedAt: "2000" }, interactionGraph: invokedFrom(1) };
    const child = (id, completionStatus, createdAt, extra = {}) => ({ id, threadId: 10, sequence: id, text: `Child ${id}`, completionStatus, createdAt, ...extra });
    const turns = [
      { id: 1, threadId: 10, sequence: 1, text: "Plan", completionStatus: "accepted", interactionGraph: graphEnabled },
      parent,
      child(3, "failed", "1000", { latestAttempt: { failureCategory: "application_restart" } }),
      child(4, "failed", "1100", { completionError: "Interrupted when Relayer restarted." }),
      child(5, "running", "2100"),
    ];
    const invocations = [3, 4, 5].map((id) => ({ sourceInteractionId: 2, actionId: 40 + id, resultInteractionId: id, agentInvoked: true }));
    const graph = interactionGraph(turns, 1, { invocations, controllable: true });
    const chips = graph.nodes.filter((node) => node.kind === "chip");
    expect(chips.map((chip) => [chip.id, chip.label])).toEqual([
      ["previous:2", "previous attempt · 2 agent runs · 2 interrupted"],
      ["agents:2", "+1 agent run · 1 running"],
    ]);
    // Children never pause and the product never stops them: only their parent agent may.
    expect(graph.nodes.some((node) => node.kind === "turn" && ["3", "4", "5"].includes(node.id))).toBe(false);
    const open = interactionGraph(turns, 1, { invocations, controllable: true, expanded: new Set(["agents:2"]) });
    expect(open.nodes.find((node) => node.id === "5")).toMatchObject({ agentRun: true, controls: [] });
    expect(open.nodes.find((node) => node.id === "agents:2").label).toBe("▾ hide agent runs");
  });
});

it("labels a paused or interrupted turn in amber on its prompt card", () => {
  expect(turnStatusPresentation("paused")).toEqual({ kind: "paused", label: "Paused" });
  expect(turnStatusPresentation("interrupted")).toEqual({ kind: "paused", label: "Interrupted by restart" });
});

it("shows a relaunch's paused runs and resumes them from the graph popover", async () => {
  const window = new Window({ url: "http://127.0.0.1:3000" });
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("lucide", new Proxy({ createElement: () => window.document.createElement("svg") }, { get: (t, k) => t[k] ?? {} }));
  window.document.body.innerHTML = '<section id="threadView"></section>';
  const node = { id: 21, kind: "concept", icon: "box", title: "Tiers table", detail: "Pricing tiers.", state: "accepted" };
  const layer = { layer: { id: 201, nodes: [21], state: "accepted" }, nodes: [node], edges: [], actions: [] };
  const turns = restartTurns();
  turns[0].completionOutput = { rootLayer: layer };
  const state = {
    status: "accepted", currentInteractionId: 1, capabilities: { stopRuns: true }, invocationInventoryAvailable: true,
    conversationCompatibility: { threadId: 10, status: "unrestricted", harnessId: "fixture" },
    interactions: turns,
    actionInvocations: [5, 6, 7, 9].map((id) => ({ sourceInteractionId: 1, actionId: 30 + id, resultInteractionId: id, resultCompletionStatus: turns.find((turn) => turn.id === id).completionStatus, agentInvoked: false })),
    visibleLayer: layer, nodes: [node], actions: [], projects: [], permissionProfiles: [],
    modelSettings: { defaults: { harnessId: "fixture" }, harnesses: [{ id: "fixture", available: true }], providers: [], families: [] },
    modelCatalog: [], pendingActionInvocations: [],
  };
  const thread = { id: 10, title: "Pricing page", harnessId: "fixture" };
  const onResumeInteraction = vi.fn(async () => {});
  const onDiscardInteraction = vi.fn(async () => {});
  const onResumeAllRuns = vi.fn(async () => {});
  const onStopInteraction = vi.fn(async () => {});
  const selection = { currentThreadId: 10, currentInteractionId: 1, selectedNodeId: null, layerPath: [] };
  const workspace = createProductWorkspace({
    root: window.document, getState: () => state, getThread: () => thread, selection, mode: "interactive",
    onStopInteraction, onResumeInteraction, onDiscardInteraction, onResumeAllRuns, showThread() {}, showEmpty() {},
  });
  try {
    workspace.render();
    await window.happyDOM.waitUntilComplete();
    const trigger = window.document.querySelector("#turnPickerButton");
    const popover = window.document.querySelector("#turnPopover");
    // Nothing opens on its own; the trigger's amber count says how many runs wait.
    expect(popover.classList.contains("hidden")).toBe(true);
    expect(trigger.querySelector("b.needs-attention").textContent).toBe("4");
    expect(trigger.getAttribute("aria-label")).toContain("4 paused runs waiting for you");

    trigger.click();
    await window.happyDOM.waitUntilComplete();
    const notice = popover.querySelector(".interaction-graph-restart-notice");
    expect(notice.textContent).toContain("Relayer restarted. 4 runs stopped where they were. Nothing resumes until you do.");
    // The notice is the only place Resume all appears.
    expect(popover.querySelectorAll(".interaction-graph-resume-all")).toHaveLength(1);
    expect(notice.querySelector(".interaction-graph-resume-all").textContent).toBe("Resume all (4)");
    expect([...popover.querySelectorAll(".interaction-graph-status-chip")].map((chip) => chip.textContent))
      .toEqual(["1 running", "3 paused", "1 interrupted"]);
    // Opening it brings the first run that needs the user into view, in reading order, and
    // highlights it: the paused message in the first column.
    const first = popover.querySelector('.interaction-graph-card[data-card-id="8"]');
    expect(first.classList.contains("attention-flash")).toBe(true);
    expect(window.document.activeElement).toBe(first.querySelector(".interaction-graph-node"));
    expect(first.querySelector(".interaction-graph-node small").textContent).toBe("Paused");
    const head = popover.querySelector('.interaction-graph-card[data-card-id="5"]');
    expect(head.dataset.needsAttention).toBe("true");
    expect(head.querySelector(".interaction-graph-node small").textContent).toBe("Interrupted by restart");
    expect(head.querySelector(".interaction-graph-deck-toggle").textContent).toBe("▸ then 2 more on Tiers table · paused");
    // The corner icons carry tooltips and names; Resume on the head resumes the chain.
    const resume = head.querySelector('[data-run-action="resume"]');
    expect(resume.textContent).toBe("▶ 3");
    expect(resume.title).toBe("Resume 3 in order");
    resume.click();
    await window.happyDOM.waitUntilComplete();
    expect(onResumeInteraction).toHaveBeenCalledWith(10, 5);

    // Expanding the deck lists the runs behind the head in order, numbered from 2, each with
    // its own Discard; it keeps the popover open and the toggle focused.
    popover.querySelector('[data-deck-for="5"]').click();
    await window.happyDOM.waitUntilComplete();
    const deck = popover.querySelector(".interaction-graph-deck");
    expect(deck.start).toBe(2);
    expect([...deck.querySelectorAll("li")].map((item) => item.dataset.runId)).toEqual(["6", "7"]);
    expect([...deck.querySelectorAll("li button")].map((button) => button.dataset.runAction)).toEqual(["discard", "discard"]);
    expect(popover.classList.contains("hidden")).toBe(false);
    deck.querySelector('[data-run-id="7"][data-run-action="discard"]').click();
    await window.happyDOM.waitUntilComplete();
    expect(onDiscardInteraction).toHaveBeenCalledWith(10, 7);
    // Once the discarded run leaves the deck, focus moves to its own card.
    state.interactions.find((turn) => turn.id === 7).completionStatus = "stopped";
    popover.querySelector('[data-run-id="7"][data-run-action="discard"]').focus();
    workspace.render();
    await window.happyDOM.waitUntilComplete();
    expect(popover.querySelector('[data-run-id="7"]')).toBeNull();
    expect(window.document.activeElement?.dataset.turnId).toBe("7");

    // A running run's corner control stops it; Resume all resumes what is left.
    popover.querySelector('.interaction-graph-card[data-card-id="9"] [data-run-action="stop"]').click();
    await window.happyDOM.waitUntilComplete();
    expect(onStopInteraction).toHaveBeenCalledWith(10, 9);
    popover.querySelector(".interaction-graph-resume-all").click();
    await window.happyDOM.waitUntilComplete();
    expect(onResumeAllRuns).toHaveBeenCalledWith(10);

    // Once nothing waits, the notice and the amber count go away.
    for (const turn of state.interactions) if (["paused", "interrupted"].includes(turn.completionStatus)) turn.completionStatus = "stopped";
    workspace.render();
    await window.happyDOM.waitUntilComplete();
    expect(popover.querySelector(".interaction-graph-restart-notice")).toBeNull();
    expect(trigger.querySelector("b.needs-attention")).toBeNull();
  } finally {
    workspace.dispose?.();
    await window.happyDOM.close();
  }
});

it("returns focus to the trigger when the last run needing the user leaves the run view", async () => {
  const window = new Window({ url: "http://127.0.0.1:3000" });
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("lucide", new Proxy({ createElement: () => window.document.createElement("svg") }, { get: (t, k) => t[k] ?? {} }));
  window.document.body.innerHTML = '<section id="threadView"></section>';
  // A thread whose only message paused before it was ever prepared: no graph projection.
  const only = { id: 1, threadId: 10, sequence: 1, text: "Waited for a slot", completionStatus: "paused" };
  const state = {
    status: "idle", currentInteractionId: 1, capabilities: { stopRuns: true }, invocationInventoryAvailable: true,
    conversationCompatibility: { threadId: 10, status: "unrestricted", harnessId: "fixture" },
    interactions: [only], actionInvocations: [], nodes: [], actions: [], projects: [], permissionProfiles: [],
    modelSettings: { defaults: { harnessId: "fixture" }, harnesses: [{ id: "fixture", available: true }], providers: [], families: [] },
    modelCatalog: [], pendingActionInvocations: [],
  };
  const selection = { currentThreadId: 10, currentInteractionId: 1, selectedNodeId: null, layerPath: [] };
  const workspace = createProductWorkspace({
    root: window.document, getState: () => state, getThread: () => ({ id: 10, title: "New", harnessId: "fixture" }), selection, mode: "interactive",
    onResumeInteraction: async () => {}, onDiscardInteraction: async () => {}, onResumeAllRuns: async () => {}, showThread() {}, showEmpty() {},
  });
  try {
    workspace.render();
    await window.happyDOM.waitUntilComplete();
    const trigger = window.document.querySelector("#turnPickerButton");
    trigger.click();
    await window.happyDOM.waitUntilComplete();
    const popover = window.document.querySelector("#turnPopover");
    popover.querySelector('[data-run-action="discard"][data-run-id="1"]').focus();
    only.completionStatus = "stopped";
    workspace.render();
    await window.happyDOM.waitUntilComplete();
    expect(popover.classList.contains("hidden")).toBe(true);
    expect(window.document.activeElement).toBe(trigger);
  } finally {
    workspace.dispose?.();
    await window.happyDOM.close();
  }
});

it("counts a thread's paused and interrupted runs in the thread list", async () => {
  const { Window: Browser } = await import("happy-dom");
  const browser = new Browser({ url: "http://127.0.0.1:43123/" });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", browser.document);
  vi.stubGlobal("location", browser.location);
  vi.stubGlobal("lucide", { Circle: "Circle", LoaderCircle: "LoaderCircle", createElement: () => browser.document.createElement("svg") });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  document.body.innerHTML = `<div class="sidebar-title"><strong>Relayer</strong></div><button id="newThread"></button>
    <section class="side-section"><div class="section-label"></div><div id="chatList"></div></section>
    <section class="side-section"><div class="section-label"></div><div id="projectList"></div></section><button id="settingsButton"></button>`;
  const { renderSidebar } = await import("../desktop/renderer/src/navigation.js");
  const { appState, viewState } = await import("../desktop/renderer/src/state.js");
  viewState.evalContext = null;
  appState.projects = [];
  appState.threads = [
    { id: 1, title: "Pricing page", pausedRuns: 3 },
    { id: 2, title: "Notes", pausedRuns: 0 },
    { id: 3, title: "Build", activity: "running", pausedRuns: 1 },
  ];
  renderSidebar();
  const row = (id) => document.querySelector(`[data-thread="${id}"]`);
  expect(row(1).querySelector(".thread-paused-badge").textContent).toBe("3 paused");
  expect(row(1).getAttribute("aria-label")).toBe("Pricing page, 3 paused");
  // Paused runs are not active: the thread shows no activity symbol for them.
  expect(row(1).dataset.activity).toBeUndefined();
  expect(row(2).querySelector(".thread-paused-badge")).toBeNull();
  expect(row(3).getAttribute("title")).toBe("Build · Running · 1 paused");
  browser.happyDOM.abort();
});
