import { createHash } from "node:crypto";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProductWorkspace } from "../desktop/renderer/src/product-workspace/workspace.js";
import { invokeInputGroups } from "../desktop/renderer/src/product-workspace/invoke-inputs.js";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

afterEach(() => vi.unstubAllGlobals());

describe("explicit input to Invoke connection", () => {
  it("groups overlapping consumers without duplicating shared inputs", () => {
    const a = { id: 1, kind: "invoke", inputActionIds: [10, 11] };
    const b = { id: 2, kind: "invoke", inputActionIds: [12] };
    const c = { id: 3, kind: "invoke", inputActionIds: [11, 12] };
    const groups = invokeInputGroups([a, b, c, { kind: "invoke" }]);
    expect(groups).toHaveLength(1);
    expect([...groups[0].inputIds].sort()).toEqual(["10", "11", "12"]);
    expect(groups[0].invokes.map((action) => action.id).sort()).toEqual([1, 2, 3]);
  });

  it.each([[false, "consume"], [true, "consume"], [false, "edit"], [true, "edit"], [false, "edit-back"], [true, "edit-back"], [false, "failure"], [true, "failure"], [false, "recovered"], [true, "recovered"], [false, "recovered-edit"], [true, "recovered-edit"]].map(([compiled, outcome]) => [compiled, outcome, false]).concat(["consume", "edit", "edit-back", "failure", "recovered", "recovered-edit", "snapshot", "bridge", "bridge-edit", "bridge-fallback", "bridge-select-fallback", "recovery-adoption", "imported-history", "preparation-rejected"].map(outcome => [false, outcome, true])).concat(["consume", "edit", "edit-back", "failure", "recovered", "recovered-edit", "authored-pending", "authored-refusal", "authored-unblurred", "authored-select", "recovery-adoption", "preparation-rejected"].map(outcome => [true, outcome, true])))("connected fields preserve Invoke submission boundaries (compiled=%s, outcome=%s, implicit=%s)", async (compiled, outcome, implicit) => {
    const window = new Window({ url: "http://127.0.0.1:3000" });
    vi.stubGlobal("document", window.document);
    vi.stubGlobal("window", window);
    vi.stubGlobal("lucide", new Proxy({ Circle: {}, createElement: () => window.document.createElement("svg") }, { get: (target, key) => target[key] ?? {} }));
    window.document.body.innerHTML = '<section id="threadView"></section><div id="toast"></div>';
    const node = { id: 7, clientKey: "destination", kind: "concept", icon: "compass", title: "Choose a vacation destination", detail: "Compare candidates" };
    const actions = [
      { id: 13, clientKey: "destination-input", sourceNodeId: 7, kind: "input", control: "text", prompt: "Destination" },
      { id: 14, clientKey: "notes", sourceNodeId: 7, kind: "input", control: "text", prompt: "Unrelated notes" },
      { id: 12, clientKey: "analyze", sourceNodeId: 7, kind: "invoke", label: "Analyze destination", interactionText: "Analyze", inputActionIds: [13], reusable: false },
      { id: 15, clientKey: "cost", sourceNodeId: 7, kind: "invoke", label: "Estimate costs", interactionText: "Estimate", inputActionIds: [13] },
    ];
    if (["bridge-select-fallback", "authored-select"].includes(outcome)) Object.assign(actions[0], {
      control: "single_select", options: [{ key: "relaxed", label: "Relaxed" }, { key: "packed", label: "Packed" }],
    });
    if (outcome === "snapshot") {
      actions.push({ id: 16, clientKey: "pace", sourceNodeId: 7, kind: "input", control: "text", prompt: "Trip pace" });
      actions[2].inputActionIds.push(16);
    }
    if (compiled) {
      const content = { version: 1, components: [{ id: "page", order: 0, html: '<label>Destination<textarea data-gc-mount="destination"></textarea></label><label>Unrelated notes<textarea data-gc-mount="notes"></textarea></label><button data-gc-mount="analyze">Analyze destination</button><button data-gc-mount="cost">Estimate costs</button>', css: "" }],
        mounts: actions.map((action) => ({ id: ({ 13: "destination", 14: "notes", 12: "analyze", 15: "cost" })[action.id], componentId: "page", kind: "capability", host: action.kind === "input" ? "textarea" : "button", capability: { kind: action.kind, action: { clientKey: action.clientKey, sourceNode: { clientKey: node.clientKey } } } })), assets: [] };
      if (outcome === "authored-select") {
        content.components[0].html = content.components[0].html.replace('<textarea data-gc-mount="destination"></textarea>', '<select data-gc-mount="destination"></select>');
        content.mounts[0].host = "select";
      }
      node.authoredDetail = { ...content, integritySha256: createHash("sha256").update(canonical(content)).digest("hex") };
    }
    const layer = { layer: { id: 101 }, nodes: [node], edges: [], actions };
    const thread = { id: 3, rootInteractionId: 5, harnessId: "fixture" };
    const state = { conversationCompatibility: { threadId: 3, status: "unrestricted", harnessId: "fixture" }, status: "accepted", currentInteractionId: 5, interactions: [{ id: 5, threadId: 3, graphNodeId: 50, text: "Compare", completionStatus: "accepted", completionOutput: { rootLayer: layer } }], visibleLayer: layer, nodes: [node], actions, projects: [], permissionProfiles: [], modelSettings: { defaults: { harnessId: "fixture" }, harnesses: [{ id: "fixture", available: true }], providers: [], families: [] }, modelCatalog: [], actionInvocations: [], pendingActionInvocations: [] };
    let draft = { threadId: 3, revision: 0, attachments: [], updatedAt: "2026-10-04T00:00:00Z" };
    if (outcome === "recovery-adoption") {
      actions[3].inputActionIds = [];
      draft = { ...draft, revision: 7, attachments: [{ occurrence: { presentingInteractionNodeId: 50, presentingLayerId: 101, actionId: 13 },
        sourceNodeId: 7, action: { control: "text", prompt: "Destination" }, value: { text: "Kyoto" }, draftRevision: 7, committedAt: "2026-10-07T00:00:00Z" }] };
      state.actionInvocations = [{ sourceInteractionId: 5, actionId: 12, resultInteractionId: 6,
        durable: true, reusable: false, invocationKey: "saved-gesture", resultCompletionStatus: "not_started", preparationRecoverable: true }];
    }
    if (outcome === "preparation-rejected") {
      actions[3].inputActionIds = [];
      state.actionInvocations = [{ sourceInteractionId: 5, actionId: 12, resultInteractionId: 6,
        durable: false, reusable: false, invocationKey: "rejected-gesture", resultCompletionStatus: "failed",
        preparationRecoverable: false, preparationRejected: true }];
    }
    if (outcome === "imported-history") {
      thread.imported = true;
      const record = { id: "invocation:current", lifecycle: "stopped", source: { label: "Analyze frozen answer" },
        arguments: [{ source: { interactionNodeId: "node:source", layerId: "layer:source", actionId: "action:input", nodeId: "node:parent" }, action: { control: "text", prompt: "Destination" }, value: { kind: "text", text: "Lisbon" } }],
        current: { rootLayerId: "layer:current", layers: [{ layer: { id: "layer:current" }, nodes: [{ id: "node:current", title: "Read-only Current" }], edges: [], actions: [] }] }, safeReason: "Stopped" };
      const current = { inert: true, threadId: 3, sourceInteractionId: 5, sourceNodeId: 7, resultInteractionId: null, record };
      state.interactions.push({ id: 6, threadId: 3, completionStatus: "accepted", completionOutput: { rootLayer: { layer: { id: 201 }, nodes: [], edges: [], actions: [] } } });
      state.importedInvocationHistory = [current, { ...current, resultInteractionId: 6, record: { ...record, id: "invocation:return", lifecycle: "succeeded" } },
        { ...current, threadId: 999, record: { ...record, id: "invocation:wrong-thread" } },
        { ...current, sourceInteractionId: 999, record: { ...record, id: "invocation:wrong-source" } },
        { ...current, sourceNodeId: 999, record: { ...record, id: "invocation:wrong-node" } }];
    }
    let releaseSave;
    const saveGate = ["snapshot", "authored-pending", "authored-refusal"].includes(outcome) ? new Promise(resolve => { releaseSave = resolve; }) : null;
    const commit = vi.fn(async (_threadId, occurrence, value) => {
      if (saveGate && draft.revision === 0) await saveGate;
      if (outcome === "authored-refusal") throw new Error("Save refused");
      const input = actions.find(action => action.id === occurrence.actionId);
      draft = { ...draft, revision: draft.revision + 1, attachments: [...draft.attachments.filter(item => item.occurrence.actionId !== occurrence.actionId), { occurrence, sourceNodeId: 7, action: { control: input.control, prompt: input.prompt, ...(input.options ? { options: input.options } : {}) }, value, draftRevision: draft.revision + 1, committedAt: "2026-10-04T00:00:01Z" }] };
      return draft;
    });
    let settleInvoke;
    const onInvokeAction = vi.fn(() => new Promise((resolve) => { settleInvoke = resolve; }));
    const onNavigateImportedInvocationHistory = vi.fn(async () => true);
    const onSubmitInteraction = vi.fn(async () => ({}));
    const onNavigateLayer = vi.fn();
    const getDraft = vi.fn(async () => draft);
    const workspace = createProductWorkspace({ root: window.document, mode: outcome === "imported-history" ? "review" : "interactive", getState: () => state, getThread: () => thread, selection: { currentThreadId: 3, currentInteractionId: 5, selectedNodeId: 7, layerPath: [] }, inputDraftApi: { get: getDraft, commit }, implicitInputAcceptance: implicit, onInvokeAction, onSubmitInteraction, onNavigateLayer, onNavigateImportedInvocationHistory, showThread() {}, showEmpty() {} });
    try {
      workspace.render();
      const surface = () => compiled ? window.document.querySelector("[data-node-detail-runtime]")?.shadowRoot : window.document;
      const invoke = () => surface()?.querySelector(compiled ? '[data-gc-mount="analyze"]' : '[data-action-id="12"]');
      const cost = () => surface()?.querySelector(compiled ? '[data-gc-mount="cost"]' : '[data-action-id="15"]');
      const field = () => surface()?.querySelector(compiled ? '[data-gc-mount="destination"]' : '[aria-label="Destination"]');
      await vi.waitFor(() => {
        expect(invoke()?.disabled).toBe(outcome !== "recovery-adoption");
        expect(field()).toBeTruthy();
      });
      if (outcome === "imported-history") {
        await vi.waitFor(() => expect(window.document.querySelectorAll(".imported-invocation-history")).toHaveLength(2));
        const current = window.document.querySelector('[data-imported-invocation-id="invocation:current"]');
        const result = window.document.querySelector('[data-imported-invocation-id="invocation:return"]');
        expect(current.textContent).toContain("Lisbon · Current · stopped");
        expect(result.textContent).toContain("Lisbon · Result · succeeded");
        expect(current.disabled).toBe(false);
        expect(result.disabled).toBe(false);
        expect(invoke().disabled).toBe(true);
        invoke().click();
        current.click();
        await vi.waitFor(() => expect(onNavigateImportedInvocationHistory).toHaveBeenCalledExactlyOnceWith(state.importedInvocationHistory[0]));
        result.click();
        await vi.waitFor(() => expect(onNavigateImportedInvocationHistory).toHaveBeenCalledTimes(2));
        expect(onNavigateImportedInvocationHistory.mock.calls[1]).toEqual([state.importedInvocationHistory[1]]);
        expect(onInvokeAction).not.toHaveBeenCalled();
        expect(onSubmitInteraction).not.toHaveBeenCalled();
        expect(commit).not.toHaveBeenCalled();
        return;
      }
      if (outcome === "recovery-adoption") {
        await vi.waitFor(() => expect(field().value).toBe("Kyoto"));
        expect(field().disabled).toBe(true);
        invoke().click();
        await vi.waitFor(() => expect(onInvokeAction).toHaveBeenCalledExactlyOnceWith(actions[2]));
        expect(commit).not.toHaveBeenCalled();
        draft = { ...draft, revision: 8, attachments: [] };
        settleInvoke({ inputDraft: draft });
        await vi.waitFor(() => expect(field().value).toBe(""));
        // The response owns the draft's new revision; future ordinary Send
        // must not retain the pre-recovery attachment or stale draft cursor.
        expect(window.document.querySelector("#composerContextChips")?.textContent ?? "").not.toContain("Kyoto");
        const prompt = window.document.querySelector("#threadPrompt");
        prompt.value = "Continue without a stale bound answer";
        prompt.dispatchEvent(new window.Event("input", { bubbles: true }));
        await vi.waitFor(() => expect(window.document.querySelector("#sendInteraction").disabled).toBe(false));
        window.document.querySelector("#sendInteraction").click();
        await vi.waitFor(() => expect(onSubmitInteraction).toHaveBeenCalledTimes(1));
        expect(onSubmitInteraction.mock.calls[0][4]).toBe(8);
        return;
      }
      if (outcome === "preparation-rejected") {
        const refused = structuredClone(state.actionInvocations[0]);
        expect(field().disabled).toBe(false);
        field().value = "Corrected destination";
        field().dispatchEvent(new window.Event("input", { bubbles: true }));
        expect(invoke().disabled).toBe(false);
        expect(invoke().textContent).not.toContain("Retry");
        invoke().click();
        await vi.waitFor(() => expect(onInvokeAction).toHaveBeenCalledExactlyOnceWith(actions[2], { inputDraftRevision: 1 }));
        expect(commit.mock.calls.map(call => call[2])).toEqual([{ text: "Corrected destination" }]);
        expect(state.actionInvocations[0]).toEqual(refused);
        draft = { ...draft, revision: 2, attachments: [] };
        settleInvoke({ inputDraft: draft });
        await vi.waitFor(() => expect(field().value).toBe(""));
        // A genuinely prepared failure still consumes the single-call slot;
        // the explicit rejection marker must never override durable authority.
        state.actionInvocations.push({ ...refused, durable: true, invocationKey: "prepared-call" });
        workspace.render();
        await vi.waitFor(() => expect(field().disabled).toBe(true));
        expect(invoke().disabled).toBe(true);
        return;
      }
      if (outcome.startsWith("bridge")) {
        const selecting = outcome === "bridge-select-fallback";
        if (selecting) field().querySelector('[data-option-key="relaxed"]').click();
        else {
          field().value = "Lisbon";
          field().dispatchEvent(new window.Event("input", { bubbles: true }));
        }
        const content = { version: 1, components: [{ id: "page", order: 0, html: '<label>Destination<textarea data-gc-mount="destination"></textarea></label><label>Unrelated notes<textarea data-gc-mount="notes"></textarea></label><button data-gc-mount="analyze">Analyze destination</button><button data-gc-mount="cost">Estimate costs</button>', css: "" }],
          mounts: actions.filter(a => outcome !== "bridge-fallback" || a.id !== 15).map(action => ({ id: ({ 13: "destination", 14: "notes", 12: "analyze", 15: "cost" })[action.id], componentId: "page", kind: "capability", host: action.kind === "input" ? "textarea" : "button", capability: { kind: action.kind, action: { clientKey: action.clientKey, sourceNode: { clientKey: node.clientKey } } } })), assets: [] };
        if (selecting) {
          content.components[0].html = content.components[0].html.replace('<textarea data-gc-mount="destination"></textarea>', '<select data-gc-mount="destination"></select>');
          content.mounts[0].host = "select";
        }
        node.authoredDetail = { ...content, integritySha256: createHash("sha256").update(canonical(content)).digest("hex") };
        workspace.render();
        const replacement = () => outcome === "bridge-fallback" ? window.document : window.document.querySelector("[data-node-detail-runtime]")?.shadowRoot;
        const replacementField = () => replacement()?.querySelector(outcome === "bridge-fallback" ? '[aria-label="Destination"]' : '[data-gc-mount="destination"]');
        const replacementInvoke = () => replacement()?.querySelector(outcome === "bridge-fallback" ? '[data-action-id="12"]' : '[data-gc-mount="analyze"]');
        await vi.waitFor(() => expect(replacementField()?.value).toBe(selecting ? "relaxed" : "Lisbon"));
        if (selecting) {
          replacementField().value = "packed";
          replacementField().dispatchEvent(new window.Event("change", { bubbles: true }));
          await vi.waitFor(() => expect(draft.attachments[0]?.value).toEqual({ selectedKeys: ["packed"] }));
          // A later incompatible presentation must preserve the authored selection
          // and hand its exact saved value back to the ordinary control.
          content.mounts = content.mounts.filter(mount => mount.id !== "cost");
          node.authoredDetail = { ...content, integritySha256: createHash("sha256").update(canonical(content)).digest("hex") };
          workspace.render();
          await vi.waitFor(() => expect(window.document.querySelector('[aria-label="Destination"] [data-option-key="packed"]')?.getAttribute("aria-checked")).toBe("true"));
          window.document.querySelector('[data-action-id="12"]').click();
          await vi.waitFor(() => expect(onInvokeAction).toHaveBeenCalledTimes(1));
          expect(commit.mock.calls.map(call => call[2])).toEqual([{ selectedKeys: ["packed"] }]);
          expect(onInvokeAction).toHaveBeenCalledWith(actions[2], { inputDraftRevision: 1 });
          draft = { ...draft, revision: 2, attachments: [] };
          settleInvoke({ inputDraft: draft });
          await vi.waitFor(() => expect(window.document.querySelectorAll('[aria-label="Destination"] [aria-checked="true"]')).toHaveLength(0));
          return;
        }
        if (outcome === "bridge-edit") {
          replacementField().value = "Kyoto";
          replacementField().dispatchEvent(new window.Event("input", { bubbles: true }));
        }
        expect(replacementInvoke().disabled).toBe(false);
        replacementInvoke().click();
        await vi.waitFor(() => expect(onInvokeAction).toHaveBeenCalledTimes(1));
        expect(commit.mock.calls.map(c => c[2])).toEqual([{ text: outcome === "bridge-edit" ? "Kyoto" : "Lisbon" }]);
        draft = { ...draft, revision: 2, attachments: [] };
        settleInvoke({ inputDraft: draft });
        await vi.waitFor(() => expect(replacementField().value).toBe(""));
        return;
      }
      if (outcome === "snapshot") {
        const pace = () => surface().querySelector('[aria-label="Trip pace"]');
        for (const [control, value] of [[field(), "Lisbon"], [pace(), "Relaxed"]]) {
          control.value = value;
          control.dispatchEvent(new window.Event("input", { bubbles: true }));
        }
        expect(window.document.querySelector('#sendInteraction').disabled).toBe(true);
        expect(invoke().disabled).toBe(false);
        invoke().click();
        await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
        expect(invoke().disabled).toBe(true);
        invoke().click();
        pace().value = "Packed";
        pace().dispatchEvent(new window.Event("input", { bubbles: true }));
        releaseSave();
        await vi.waitFor(() => expect(onInvokeAction).toHaveBeenCalledTimes(1));
        expect(commit.mock.calls.map(call => [call[1].actionId, call[2]])).toEqual([[13, { text: "Lisbon" }], [16, { text: "Relaxed" }]]);
        expect(onInvokeAction).toHaveBeenCalledWith(actions[2], { inputDraftRevision: 2 });
        draft = { ...draft, revision: 3, attachments: [] };
        settleInvoke({ inputDraft: draft });
        await vi.waitFor(() => expect(field().value).toBe(""));
        expect(pace().value).toBe("Packed");
        expect(window.document.querySelector('#sendInteraction').disabled).toBe(true);
        return;
      }
      if (outcome.startsWith("authored-")) {
        field().value = outcome === "authored-select" ? "packed" : "Kyoto";
        field().dispatchEvent(new window.Event("input", { bubbles: true }));
        if (outcome !== "authored-unblurred") field().dispatchEvent(new window.Event("change", { bubbles: true }));
        expect(invoke().disabled).toBe(false);
        invoke().click();
        await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
        if (releaseSave) {
          expect(onInvokeAction).not.toHaveBeenCalled();
          field().value = "Lisbon";
          field().dispatchEvent(new window.Event("input", { bubbles: true }));
          releaseSave();
        }
        if (outcome === "authored-refusal") {
          await vi.waitFor(() => expect(invoke().title).toContain("A connected input could not be saved"));
          expect(onInvokeAction).not.toHaveBeenCalled();
          expect(field().value).toBe("Lisbon");
          return;
        }
        await vi.waitFor(() => expect(onInvokeAction).toHaveBeenCalledTimes(1));
        expect(commit.mock.calls.map(call => call[2])).toEqual([outcome === "authored-select" ? { selectedKeys: ["packed"] } : { text: "Kyoto" }]);
        expect(onInvokeAction).toHaveBeenCalledWith(actions[2], { inputDraftRevision: 1 });
        draft = { ...draft, revision: 2, attachments: [] };
        settleInvoke({ inputDraft: draft });
        await vi.waitFor(() => expect(field().value).toBe(outcome === "authored-pending" ? "Lisbon" : outcome === "authored-select" ? "relaxed" : ""));
        return;
      }
      expect(cost().disabled).toBe(true);
      if (!compiled) {
        const group = invoke().closest(".invoke-input-group");
        expect(group.querySelectorAll(".node-input-editor")).toHaveLength(1);
        expect(group.querySelectorAll("[data-bound-invoke-id]")).toHaveLength(2);
        expect(group.textContent).not.toContain("Unrelated notes");
      } else {
        expect(invoke().getAttribute("aria-controls")).toBe(field().id);
        expect(surface().querySelector('[data-invoke-input-hint="analyze"]').textContent).toBe("Uses: Destination");
      }
      field().value = "Kyoto";
      field().dispatchEvent(new window.Event("input", { bubbles: true }));
      expect(invoke().disabled).toBe(!implicit);
      if (implicit) expect(surface().querySelector('[aria-label="Commit Destination"]')).toBeNull();
      if (compiled) field().dispatchEvent(new window.Event("change", { bubbles: true }));
      else if (!implicit) surface().querySelector('[aria-label="Commit Destination"]').click();
      await vi.waitFor(() => expect(invoke().disabled).toBe(false));
      expect(cost().disabled).toBe(false);
      const notes = () => surface()?.querySelector(compiled ? '[data-gc-mount="notes"]' : '[aria-label="Unrelated notes"]');
      notes().value = "Keep this unrelated edit";
      notes().dispatchEvent(new window.Event("input", { bubbles: true }));
      invoke().click();
      await vi.waitFor(() => expect(onInvokeAction).toHaveBeenCalledWith(actions[2], { inputDraftRevision: 1 }));
      if (outcome.includes("edit")) {
        field().value = "Lisbon";
        field().dispatchEvent(new window.Event("input", { bubbles: true }));
        if (outcome === "edit-back") {
          field().value = "Kyoto";
          field().dispatchEvent(new window.Event("input", { bubbles: true }));
        }
      }
      if (outcome !== "failure") {
        draft = { ...draft, revision: 2, attachments: [] };
        settleInvoke(outcome.startsWith("recovered") ? { recovered: true, interaction: { id: 6 } } : { inputDraft: draft });
      } else settleInvoke(null);
      await vi.waitFor(() => expect(field().value).toBe(["consume", "recovered"].includes(outcome) ? "" : outcome.endsWith("edit") ? "Lisbon" : "Kyoto"));
      expect(getDraft).toHaveBeenCalledTimes(outcome.startsWith("recovered") ? 2 : 1);
      if (implicit) await vi.waitFor(() => expect(cost().title).not.toBe("Saving inputs…"));
      expect(notes().value).toBe("Keep this unrelated edit");
      expect(draft.attachments).toHaveLength(outcome === "failure" ? 1 : 0);
      field().value = "Lisbon";
      field().dispatchEvent(new window.Event("input", { bubbles: true }));
      await vi.waitFor(() => expect(cost().disabled).toBe(!implicit));
      if (!compiled) {
        surface().querySelector('[aria-label="Undo Destination"]').click();
        await vi.waitFor(() => expect(cost().disabled).toBe(outcome !== "failure"));
        expect(invoke().closest(".invoke-input-group").querySelectorAll(".node-input-editor")).toHaveLength(1);
      }
      state.actionInvocations = [{ id: 21, reusable: true, sourceInteractionId: 5, actionId: 12, resultInteractionId: 6, resultCompletionStatus: "running" }];
      workspace.render();
      await vi.waitFor(() => expect(invoke()?.disabled).toBe(true));
      // Shared answers remain editable until every consumer's immutable
      // definition is exhausted. An interrupted captured call owns its frozen
      // arguments, so recovery does not unlock the answer field.
      await vi.waitFor(() => expect(field().disabled).toBe(false));
      actions[3].inputActionIds = [];
      workspace.render();
      await vi.waitFor(() => expect(field().disabled).toBe(true));
      actions[0].inputCanAcceptAnswer = true;
      workspace.render();
      await vi.waitFor(() => expect(field().disabled).toBe(false));
      actions[0].inputCanAcceptAnswer = false;
      workspace.render();
      await vi.waitFor(() => expect(field().disabled).toBe(true));
      delete actions[0].inputCanAcceptAnswer;
      if (implicit) {
        state.actionInvocations[0] = { ...state.actionInvocations[0], durable: true, invocationKey: "saved-gesture", preparationRecoverable: true, resultCompletionStatus: "submitted" };
        workspace.render();
        await vi.waitFor(() => expect(invoke()?.disabled).toBe(false));
        expect(field().disabled).toBe(true);
        state.actionInvocations[0].resultCompletionStatus = "running";
      }
      actions[3].inputActionIds = [13];
      workspace.render();
      await vi.waitFor(() => expect(field().disabled).toBe(false));
      const response = { id: 16, clientKey: "returned-analysis", sourceNodeId: 7, kind: "navigate", relation: "expand", label: "Updated analysis", targetLayerId: 201 };
      actions.push(response);
      if (compiled) {
        const content = structuredClone(node.authoredDetail);
        delete content.integritySha256;
        content.components[0].html += '<button data-gc-mount="returned-analysis">Updated analysis</button>';
        content.mounts.push({ id: "returned-analysis", componentId: "page", kind: "capability", host: "button", capability: { kind: "expand", action: { clientKey: response.clientKey, sourceNode: { clientKey: node.clientKey } } } });
        node.authoredDetail = { ...content, integritySha256: createHash("sha256").update(canonical(content)).digest("hex") };
      }
      state.interactions.push({ id: 6, threadId: 3, graphNodeId: 60, completionStatus: "accepted", completionOutput: { rootLayer: { layer: { id: 201 }, nodes: [], edges: [], actions: [] } } });
      state.actionInvocations[0].resultCompletionStatus = "accepted";
      draft = { ...draft, revision: 2, attachments: [] };
      workspace.render();
      await vi.waitFor(() => expect(invoke()?.disabled).toBe(false));
      expect(window.document.querySelectorAll(".invocation-result-control").length
        + (compiled ? surface().querySelectorAll(".invocation-result-control").length : 0)).toBe(1);
      invoke().click();
      await vi.waitFor(() => expect(onNavigateLayer).toHaveBeenCalledWith(201, { action: actions[2], sourceNode: node }));
      expect(onInvokeAction).toHaveBeenCalledTimes(1);
      expect(actions[2].kind).toBe("invoke");
      expect(actions[2].targetLayerId).toBeUndefined();
    } finally { workspace.dispose(); await window.happyDOM.close(); }
  });
});
