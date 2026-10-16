import { Window } from "happy-dom";
import { afterEach, expect, it, vi } from "vitest";
import { createProductWorkspace } from "../desktop/renderer/src/product-workspace/workspace.js";

afterEach(() => vi.unstubAllGlobals());

// Thread messages run in parallel (#719): a node can be annotated, and the annotation sent with
// the next message, while the follow-up it came from still runs.
it.each(["running", "accepted", "read-only"])("allows annotations on a %s follow-up and sends them with the next message", async (status) => {
  const window = new Window({ url: "http://127.0.0.1:3000" });
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("lucide", new Proxy({ createElement: () => window.document.createElement("svg") }, { get: (t, k) => t[k] ?? {} }));
  window.document.body.innerHTML = '<section id="threadView"></section>';
  const node = { id: 21, kind: "concept", icon: "box", title: "Follow-up result", detail: "Body", state: "accepted" };
  const layer = { layer: { id: 201, nodes: [21], state: "accepted" }, nodes: [node], edges: [], actions: [] };
  const thread = { id: 10, title: "Saved chat", harnessId: "fixture" };
  const state = {
    status, currentInteractionId: 2,
    conversationCompatibility: { threadId: 10, status: "unrestricted", harnessId: "fixture" },
    interactions: [
      { id: 1, graphNodeId: 901, threadId: 10, sequence: 1, text: "Original", completionStatus: "accepted" },
      { id: 2, graphNodeId: 902, threadId: 10, sequence: 2, text: "Follow-up", completionStatus: status, completionOutput: { rootLayer: layer } },
    ],
    visibleLayer: layer, nodes: [node], actions: [], projects: [], permissionProfiles: [],
    modelSettings: { defaults: { harnessId: "fixture" }, harnesses: [{ id: "fixture", available: true }], providers: [], families: [] },
    modelCatalog: [], actionInvocations: [], pendingActionInvocations: [],
  };
  const saved = [];
  const confirmations = [];
  const api = {
    list: async () => ({ drafts: [], confirmations }),
    discard: vi.fn(async () => {}),
    save: async (_threadId, draft) => {
      saved.push(draft);
      return { ...draft, revision: 1 };
    },
    confirm: async (_threadId, draft) => {
      const confirmation = { draftId: draft.id, target: draft.target, targetNode: draft.targetNode, annotation: draft.text, confirmationRevision: 1 };
      confirmations.push(confirmation);
      return confirmation;
    },
  };
  let finishSend;
  const sendResult = new Promise((resolve) => { finishSend = resolve; });
  const submit = vi.fn(() => sendResult);
  const selection = { currentThreadId: 10, currentInteractionId: 2, selectedNodeId: 21, layerPath: [] };
  const workspace = createProductWorkspace({ root: window.document, getState: () => state, getThread: () => thread, selection, contextDraftApi: api, onSubmitInteraction: submit, mode: status === "read-only" ? "review" : "interactive", showThread() {}, showEmpty() {} });
  try {
    workspace.render();
    await window.happyDOM.waitUntilComplete();
    const plus = window.document.querySelector("#attachNodeContext");
    if (status === "read-only") {
      expect(plus.classList.contains("hidden")).toBe(true);
      plus.click();
      expect(window.document.querySelector("#contextAnnotationEditor")).toBeNull();
      expect(saved).toHaveLength(0);
      return;
    }
    expect(plus.classList.contains("hidden")).toBe(false);
    expect(plus.disabled).toBe(false);
    if (status === "running") {
      plus.click();
      const discardedEditor = window.document.querySelector("#contextAnnotationEditor");
      discardedEditor.value = "Discard me";
      discardedEditor.dispatchEvent(new window.Event("input", { bubbles: true }));
      // Wait for the real controller autosave before discarding.
      await vi.waitFor(() => expect(saved).toHaveLength(1));
      window.document.querySelector('[aria-label="Discard annotation draft for Follow-up result"]').click();
      await window.happyDOM.waitUntilComplete();
      expect(api.discard).toHaveBeenCalled();
      expect(window.document.querySelector("#contextAnnotationEditor")).toBeNull();
    }
    plus.click();
    const editor = window.document.querySelector("#contextAnnotationEditor");
    expect(editor).not.toBeNull();
    expect(editor.disabled).toBe(false);
    editor.value = "Expand this point";
    editor.dispatchEvent(new window.Event("input", { bubbles: true }));
    const confirm = window.document.querySelector('[aria-label="Confirm annotation"]');
    expect(confirm.disabled).toBe(false);
    confirm.click();
    await window.happyDOM.waitUntilComplete();
    expect(confirmations).toHaveLength(1);
    expect(saved[0].target).toEqual({ nodeId: 21, sourceInteractionNodeId: 902, sourceLayerId: 201 });
    expect(confirmations[0].annotation).toBe("Expand this point");
    expect(window.document.querySelector("#contextAnnotationEditor")).toBeNull();
    if (status === "running") {
      // The message box never locks, and Send stays Send, while the follow-up runs.
      expect(window.document.querySelector("#threadPrompt").disabled).toBe(false);
      expect(window.document.querySelector("#sendInteraction").getAttribute("aria-label")).toBe("Send");
    }
    workspace.render();
    await window.happyDOM.waitUntilComplete();
    expect(window.document.querySelector("#composerContextTray").textContent).toContain("1");
    {
      const prompt = window.document.querySelector("#threadPrompt");
      prompt.value = "Next follow-up";
      prompt.dispatchEvent(new window.Event("input", { bubbles: true }));
      const send = window.document.querySelector("#sendInteraction");
      expect(send.disabled).toBe(false);
      send.click();
      await vi.waitFor(() => expect(submit).toHaveBeenCalled());
      // The Send snapshots exactly its own annotation and consumes its confirmation.
      const [text, , contexts, confirmationIds] = submit.mock.calls[0];
      expect(text).toBe("Next follow-up");
      expect(JSON.stringify(contexts)).toContain("Expand this point");
      expect(confirmationIds).toEqual([confirmations[0].draftId]);
      const duringSend = window.document.querySelector("#attachNodeContext");
      expect(duringSend.classList.contains("hidden")).toBe(false);
      expect(duringSend.disabled).toBe(true);
      duringSend.click();
      expect(window.document.querySelector("#contextAnnotationEditor")).toBeNull();
      finishSend({});
      await window.happyDOM.waitUntilComplete();
      await vi.waitFor(() => expect(duringSend.disabled).toBe(false));
    }
  } finally {
    finishSend({});
    workspace.dispose();
    await window.happyDOM.close();
  }
});
