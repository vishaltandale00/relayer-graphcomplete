import { Window } from "happy-dom";
import { afterEach, expect, it, vi } from "vitest";
import { createProductWorkspace } from "../desktop/renderer/src/product-workspace/workspace.js";

afterEach(() => vi.unstubAllGlobals());

it.each(["restored", "restored-after-consumption", "restored-after-consumption-visited", "edited", "save-failure", "undo", "snapshot"])("ordinary Send accepts and clears exact input epochs (%s)", async (outcome) => {
  const window = new Window({ url: "http://127.0.0.1:3000" });
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("lucide", new Proxy({ createElement: () => window.document.createElement("svg") }, { get: (t, k) => t[k] ?? {} }));
  window.document.body.innerHTML = '<section id="threadView"></section><div id="toast" class="hidden"></div>';
  const node = { id: 7, kind: "concept", icon: "compass", title: "Plan", detail: "Answer these questions" };
  const actions = [
    { id: 13, sourceNodeId: 7, kind: "input", control: "text", prompt: "Preference" },
    { id: 14, sourceNodeId: 7, kind: "input", control: "text", prompt: "Invoke argument" },
    { id: 15, sourceNodeId: 7, kind: "invoke", label: "Analyze", inputActionIds: [14], reusable: false },
  ];
  const otherNode = { id: 8, kind: "concept", icon: "circle", title: "Selection guard", detail: "Browse while an input is restored" };
  const layer = { layer: { id: 101 }, nodes: [node, otherNode], edges: [], actions };
  const thread = { id: 3, rootInteractionId: 5, harnessId: "fixture" };
  const state = { conversationCompatibility: { threadId: 3, status: "unrestricted", harnessId: "fixture" }, status: "accepted", currentInteractionId: 5, interactions: [{ id: 5, threadId: 3, graphNodeId: 50, text: "Compare", completionStatus: "accepted", completionOutput: { rootLayer: layer } }], visibleLayer: layer, nodes: layer.nodes, actions, projects: [], permissionProfiles: [], modelSettings: { defaults: { harnessId: "fixture" }, harnesses: [{ id: "fixture", available: true }], providers: [], families: [] }, modelCatalog: [], actionInvocations: [], pendingActionInvocations: [] };
  const occurrence = actionId => ({ presentingInteractionNodeId: 50, presentingLayerId: 101, actionId });
  const attachment = (id, text, revision) => ({ occurrence: occurrence(id), sourceNodeId: 7, action: { control: "text", prompt: actions.find(a => a.id === id).prompt }, value: { text }, composerEligible: id === 13, draftRevision: revision, committedAt: "2026-10-07T00:00:00Z" });
  let draft = { threadId: 3, revision: 1, attachments: outcome.startsWith("restored") || outcome === "undo" ? [attachment(13, "Saved preference", 1), attachment(14, "Scoped argument", 1)] : [attachment(14, "Scoped argument", 1)], updatedAt: "2026-10-07T00:00:00Z" };
  let releaseSave;
  const saveGate = outcome === "snapshot" ? new Promise(resolve => { releaseSave = resolve; }) : null;
  const commit = vi.fn(async (_thread, received, value) => {
    if (outcome === "save-failure") throw new Error("Injected save refusal");
    if (saveGate) await saveGate;
    draft = { ...draft, revision: draft.revision + 1, attachments: [...draft.attachments.filter(a => a.occurrence.actionId !== received.actionId), attachment(received.actionId, value.text, draft.revision + 1)] };
    return draft;
  });
  const submit = vi.fn(async () => {
    draft = { ...draft, revision: draft.revision + 1, attachments: draft.attachments.filter(a => !a.composerEligible) };
    return {};
  });
  const selection = { currentThreadId: 3, currentInteractionId: 5, selectedNodeId: 7, layerPath: [] };
  const workspace = createProductWorkspace({ root: window.document, getState: () => state, getThread: () => thread, selection, implicitInputAcceptance: true, inputDraftApi: { get: async () => draft, commit }, onSubmitInteraction: submit, showThread() {}, showEmpty() {} });
  const field = () => window.document.querySelector('[aria-label="Preference"]');
  const edit = value => { field().value = value; field().dispatchEvent(new window.Event("input", { bubbles: true })); };
  try {
    workspace.render();
    await vi.waitFor(() => expect(field()).toBeTruthy());
    expect(window.document.querySelector('[aria-label="Commit Preference"]')).toBeNull();
    if (!outcome.startsWith("restored")) edit("Current preference");
    if (outcome === "undo") {
      window.document.querySelector('[aria-label="Undo Preference"]').click();
      expect(field().value).toBe("Saved preference");
    }
    await vi.waitFor(() => expect(window.document.querySelector('#sendInteraction').disabled).toBe(false));
    window.document.querySelector('#sendInteraction').click();
    if (outcome === "snapshot") {
      await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
      // A programmatic late input also exercises the epoch fence; native controls
      // stay locked while their own Send is in flight.
      edit("Newer preference");
      releaseSave();
    }
    if (outcome === "save-failure") {
      await vi.waitFor(() => expect(window.document.querySelector('#toast').textContent).toContain("Injected save refusal"));
      expect(submit).not.toHaveBeenCalled();
      expect(field().value).toBe("Current preference");
      expect(draft.attachments.map(a => a.occurrence.actionId)).toEqual([14]);
    } else {
      await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
      if (outcome === "restored-after-consumption") {
        window.document.querySelector('.graph-node[data-node="8"]').click();
        await vi.waitFor(() => expect(window.document.querySelector('#detailTitle').textContent).toBe("Selection guard"));
      }
      await vi.waitFor(() => expect(window.document.querySelector('#sendInteraction').disabled).toBe(outcome !== "snapshot"));
      workspace.render();
      if (outcome !== "restored-after-consumption") await vi.waitFor(() => expect(field().value).toBe(outcome === "snapshot" ? "Newer preference" : ""));
      expect(draft.attachments.map(a => a.occurrence.actionId)).toEqual([14]);
      expect(submit.mock.calls[0][4]).toBe(outcome.startsWith("restored") || outcome === "undo" ? 1 : 2);
      expect(commit.mock.calls.map(call => [call[1].actionId, call[2]])).toEqual(outcome.startsWith("restored") || outcome === "undo" ? [] : [[13, { text: "Current preference" }]]);
      if (outcome.startsWith("restored-after-consumption")) {
        if (outcome.endsWith("visited")) {
          window.document.querySelector('.graph-node[data-node="8"]').click();
          await vi.waitFor(() => expect(window.document.querySelector('#detailTitle').textContent).toBe("Selection guard"));
        }
        // The server restores a consumed answer after a stopped attempt. Keeping
        // the source unselected leaves its former renderer stage absent.
        const stoppedTurn = { id: 6, threadId: 3, graphNodeId: 60, text: "", completionStatus: "running" };
        state.interactions.push(stoppedTurn);
        workspace.render();
        draft = { ...draft, revision: 3, attachments: [...draft.attachments, attachment(13, "Saved preference", 3)] };
        stoppedTurn.completionStatus = "stopped";
        workspace.render();
        // Thread restoration takes the real forced input-draft reload path.
        await vi.waitFor(() => expect(window.document.querySelectorAll('.composer-input-pill')).toHaveLength(1));
        expect(field()).toBeNull();
        await vi.waitFor(() => expect(window.document.querySelector('#sendInteraction').disabled).toBe(false));
        window.document.querySelector('#sendInteraction').click();
        await vi.waitFor(() => expect(submit, window.document.querySelector('#toast').textContent).toHaveBeenCalledTimes(2));
        expect(submit.mock.calls[1][4]).toBe(3);
        expect(commit).not.toHaveBeenCalled();
        expect(window.document.querySelector('#detailTitle').textContent).toBe("Selection guard");
      }
    }
  } finally {
    releaseSave?.();
    workspace.dispose();
    await window.happyDOM.close();
  }
});
