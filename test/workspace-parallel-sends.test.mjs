import { Window } from "happy-dom";
import { afterEach, expect, it, vi } from "vitest";
import { createProductWorkspace } from "../desktop/renderer/src/product-workspace/workspace.js";

afterEach(() => vi.unstubAllGlobals());

// #719: everything on the Send layer runs in parallel. While earlier messages run, the user sends
// a plain message, then one carrying a node annotation, then one carrying an answered input. The
// message box, annotations and inputs stay usable throughout, Send stays Send, and each Send
// carries exactly its own text, annotation and answer.
it("sends a plain message, an annotation and an answer while earlier runs are active", async () => {
  const window = new Window({ url: "http://127.0.0.1:3000" });
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("lucide", new Proxy({ createElement: () => window.document.createElement("svg") }, { get: (t, k) => t[k] ?? {} }));
  window.document.body.innerHTML = '<section id="threadView"></section><div id="toast" class="hidden"></div>';
  const node = { id: 7, kind: "concept", icon: "compass", title: "Plan", detail: "Answer these questions", state: "accepted" };
  const actions = [{ id: 13, sourceNodeId: 7, kind: "input", control: "text", prompt: "Preference" }];
  const layer = { layer: { id: 101, nodes: [7], state: "accepted" }, nodes: [node], edges: [], actions };
  const thread = { id: 3, rootInteractionId: 5, harnessId: "fixture", title: "Parallel" };
  const turn = (id, completionStatus, extra = {}) => ({ id, threadId: 3, sequence: id, text: `Turn ${id}`, completionStatus, ...extra });
  const state = {
    conversationCompatibility: { threadId: 3, status: "unrestricted", harnessId: "fixture" },
    status: "accepted", currentInteractionId: 5, capabilities: { stopRuns: true },
    // The thread's first answer is accepted; a later message still runs.
    interactions: [turn(5, "accepted", { graphNodeId: 50, completionOutput: { rootLayer: layer } }), turn(6, "running")],
    visibleLayer: layer, nodes: layer.nodes, actions, projects: [], permissionProfiles: [],
    modelSettings: { defaults: { harnessId: "fixture" }, harnesses: [{ id: "fixture", available: true }], providers: [], families: [] },
    modelCatalog: [], actionInvocations: [], pendingActionInvocations: [],
  };
  const occurrence = { presentingInteractionNodeId: 50, presentingLayerId: 101, actionId: 13 };
  let draft = { threadId: 3, revision: 1, attachments: [], updatedAt: "2026-10-15T00:00:00Z" };
  const commit = vi.fn(async (_thread, received, value) => {
    draft = {
      ...draft, revision: draft.revision + 1,
      attachments: [{ occurrence: received, sourceNodeId: 7, action: { control: "text", prompt: "Preference" }, value, composerEligible: true, draftRevision: draft.revision + 1, committedAt: "2026-10-15T00:00:01Z" }],
    };
    return draft;
  });
  const confirmations = [];
  const contextDraftApi = {
    list: async () => ({ drafts: [], confirmations }),
    discard: vi.fn(async () => {}),
    save: async (_threadId, saved) => ({ ...saved, revision: 1 }),
    confirm: async (_threadId, saved) => {
      const confirmation = { draftId: saved.id, target: saved.target, targetNode: saved.targetNode, annotation: saved.text, confirmationRevision: 1 };
      confirmations.push(confirmation);
      return confirmation;
    },
  };
  let nextTurn = 7;
  // The app server admits every send beside the running ones and consumes what it carried.
  const submit = vi.fn(async (_text, _model, _contexts, confirmationIds) => {
    if (draft.attachments.length && submit.mock.calls.at(-1)[4] === draft.revision) {
      draft = { ...draft, revision: draft.revision + 1, attachments: [] };
    }
    for (const id of confirmationIds) confirmations.splice(confirmations.findIndex((item) => item.draftId === id), 1);
    state.interactions.push(turn(nextTurn, "running"));
    nextTurn += 1;
    return {};
  });
  const selection = { currentThreadId: 3, currentInteractionId: 5, selectedNodeId: 7, layerPath: [] };
  const workspace = createProductWorkspace({
    root: window.document, getState: () => state, getThread: () => thread, selection, mode: "interactive",
    implicitInputAcceptance: true, inputDraftApi: { get: async () => draft, commit }, contextDraftApi,
    onSubmitInteraction: submit, onStopInteraction: vi.fn(async () => {}), showThread() {}, showEmpty() {},
  });
  const prompt = () => window.document.querySelector("#threadPrompt");
  const send = () => window.document.querySelector("#sendInteraction");
  const type = (value) => {
    prompt().value = value;
    prompt().dispatchEvent(new window.Event("input", { bubbles: true }));
  };
  const sendMessage = async (value, calls) => {
    expect(prompt().disabled).toBe(false);
    type(value);
    await vi.waitFor(() => expect(send().disabled).toBe(false));
    expect(send().getAttribute("aria-label")).toBe("Send");
    send().click();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(calls));
    workspace.render();
    await window.happyDOM.waitUntilComplete();
    return submit.mock.calls[calls - 1];
  };
  try {
    workspace.render();
    await window.happyDOM.waitUntilComplete();

    // 1. A plain message while turn 6 runs.
    const [plainText, , plainContexts, plainConfirmations] = await sendMessage("Plain message", 1);
    expect(plainText).toBe("Plain message");
    expect(plainContexts ?? []).toEqual([]);
    expect(plainConfirmations).toEqual([]);

    // 2. While two messages run, annotate the node and send the annotation.
    const attach = window.document.querySelector("#attachNodeContext");
    expect(attach.disabled).toBe(false);
    attach.click();
    const editor = window.document.querySelector("#contextAnnotationEditor");
    editor.value = "Expand this point";
    editor.dispatchEvent(new window.Event("input", { bubbles: true }));
    window.document.querySelector('[aria-label="Confirm annotation"]').click();
    await vi.waitFor(() => expect(confirmations).toHaveLength(1));
    const confirmationId = confirmations[0].draftId;
    workspace.render();
    await window.happyDOM.waitUntilComplete();
    const [annotatedText, , annotatedContexts, annotatedConfirmations, annotatedRevision] = await sendMessage("With annotation", 2);
    expect(annotatedText).toBe("With annotation");
    expect(JSON.stringify(annotatedContexts)).toContain("Expand this point");
    expect(annotatedConfirmations).toEqual([confirmationId]);
    expect(annotatedRevision).toBe(1);

    // 3. While three messages run, answer the node's question and send the answer.
    const field = () => window.document.querySelector('[aria-label="Preference"]');
    await vi.waitFor(() => expect(field()).toBeTruthy());
    expect(field().disabled).toBe(false);
    field().value = "Weekly";
    field().dispatchEvent(new window.Event("input", { bubbles: true }));
    const [answeredText, , answeredContexts, answeredConfirmations, answeredRevision] = await sendMessage("With answer", 3);
    expect(answeredText).toBe("With answer");
    expect(commit.mock.calls.map((call) => [call[1].actionId, call[2]])).toEqual([[13, { text: "Weekly" }]]);
    expect(answeredRevision).toBe(2);
    // The annotation went with the second message only.
    expect(answeredContexts ?? []).toEqual([]);
    expect(answeredConfirmations).toEqual([]);

    // Every message still runs, each with its own Stop on its interaction node.
    expect(state.interactions.filter((item) => item.completionStatus === "running").map((item) => item.id)).toEqual([6, 7, 8, 9]);
    state.currentInteractionId = 8;
    workspace.render();
    await window.happyDOM.waitUntilComplete();
    expect(window.document.querySelector("#interactionRunStop").classList.contains("hidden")).toBe(false);
    expect(window.document.querySelector("#stopAllRuns").textContent).toBe("Stop all runs (4)");
    expect(prompt().disabled).toBe(false);
  } finally {
    workspace.dispose();
    await window.happyDOM.close();
  }
});
