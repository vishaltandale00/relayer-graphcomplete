import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { productWorkspaceMarkup } from "../desktop/renderer/src/product-workspace/view.js";
import {
  COMPOSER_MAX_HEIGHT,
  COMPOSER_MIN_HEIGHT,
  CONTEXT_EDITOR_MAX_HEIGHT,
  CONTEXT_EDITOR_MIN_HEIGHT,
  applyContextEditor,
  bindComposerKeydown,
  composerDisabledForState,
  composerDraftMatchesSubmission,
  composerDraftScopeKey,
  composerFocusRestoration,
  composerKeydownIntent,
  composerSubmissionReady,
  composerStatusForThread,
  contextDraftHasAnnotation,
  contextAnnotationCountLabel,
  contextDetachNeedsConfirmation,
  contextEditorCanConfirm,
  contextEditorPresentation,
  contextStagingDisabledFor,
  createComposerDraftScopeState,
  graphTurnNavigationDelta,
  graphRenderClearsSelection,
  hasHistoricalContextSelection,
  historicalContextSelectionOptions,
  handleComposerKeydown,
  resizeComposerTextarea,
  resizeContextEditorTextarea,
  interactionContextPayload,
  interactionContextDraftTransition,
  removeContextAnnotation,
  resolveInteractionContextNode,
  transitionComposerDraftScope,
} from "../desktop/renderer/src/product-workspace/workspace.js";

describe("product workspace keyboard behavior", () => {
  it("navigates turns only for unmodified arrows while the graph owns focus", () => {
    expect(graphTurnNavigationDelta({ key: "ArrowLeft" }, true)).toBe(-1);
    expect(graphTurnNavigationDelta({ key: "ArrowRight" }, true)).toBe(1);
    expect(graphTurnNavigationDelta({ key: "ArrowLeft" }, false)).toBeNull();
    expect(graphTurnNavigationDelta({ key: "ArrowRight", shiftKey: true }, true)).toBeNull();
    expect(graphTurnNavigationDelta({ key: "ArrowRight", metaKey: true }, true)).toBeNull();
    expect(graphTurnNavigationDelta({ key: "ArrowLeft", ctrlKey: true }, true)).toBeNull();
    expect(graphTurnNavigationDelta({ key: "ArrowLeft", altKey: true }, true)).toBeNull();
    expect(graphTurnNavigationDelta({ key: "Enter" }, true)).toBeNull();
  });

  it("makes the graph pointer-focusable without adding it to tab order", () => {
    const markup = productWorkspaceMarkup();
    expect(markup).toContain('id="graphStage" tabindex="-1"');
    expect(markup).not.toContain('id="graphStage" tabindex="0"');
  });

  it("maps Enter shortcuts while preserving multiline and IME input", () => {
    expect(composerKeydownIntent({ key: "Enter" })).toBe("submit");
    expect(composerKeydownIntent({ key: "Enter", shiftKey: true })).toBe("newline");
    expect(composerKeydownIntent({ key: "Enter", metaKey: true })).toBe("submit");
    expect(composerKeydownIntent({ key: "Enter", ctrlKey: true })).toBe("submit");
    expect(composerKeydownIntent({ key: "Enter", repeat: true })).toBe("repeat");
    expect(composerKeydownIntent({ key: "Enter", isComposing: true })).toBe("composing");
    expect(composerKeydownIntent({ key: "Enter", keyCode: 229 })).toBe("composing");
    expect(composerKeydownIntent({ key: "a" })).toBeNull();
  });

  it("submits through the bound send action on plain Enter", () => {
    let submitted = 0;
    const plainEnter = { key: "Enter", preventDefault: () => { plainEnter.prevented = true; } };
    expect(handleComposerKeydown(plainEnter, () => { submitted += 1; })).toBe("submit");
    expect(plainEnter.prevented).toBe(true);
    expect(submitted).toBe(1);

    const shiftedEnter = { key: "Enter", shiftKey: true, preventDefault: () => {} };
    expect(handleComposerKeydown(shiftedEnter, () => { submitted += 1; })).toBe("newline");
    expect(submitted).toBe(1);
  });

  it("binds plain Enter to send while leaving Shift+Enter as a newline", () => {
    const textarea = {};
    const send = { click: vi.fn() };
    bindComposerKeydown(textarea, () => send.click());

    const shiftedEnter = { key: "Enter", shiftKey: true, preventDefault: vi.fn() };
    textarea.onkeydown(shiftedEnter);
    expect(shiftedEnter.preventDefault).not.toHaveBeenCalled();
    expect(send.click).not.toHaveBeenCalled();

    const plainEnter = { key: "Enter", preventDefault: vi.fn() };
    textarea.onkeydown(plainEnter);
    expect(plainEnter.preventDefault).toHaveBeenCalledOnce();
    expect(send.click).toHaveBeenCalledOnce();
  });

  it("rejects empty and disabled submissions", () => {
    expect(composerSubmissionReady("Ask a follow-up")).toBe(true);
    expect(composerSubmissionReady("  \n ")).toBe(false);
    expect(composerSubmissionReady("Ask a follow-up", true)).toBe(false);
    const contexts = [{
      target: { nodeId: 3, sourceInteractionNodeId: 2, sourceLayerId: 1 },
      annotations: ["  note  "],
      node: { id: 3, title: "Context" },
    }];
    expect(contextDraftHasAnnotation(contexts)).toBe(true);
    expect(composerSubmissionReady("", false, true, contexts)).toBe(true);
    expect(composerSubmissionReady("", false, true, [{ ...contexts[0], annotations: [] }]))
      .toBe(false);
    expect(composerSubmissionReady("message", false, true, contexts, true)).toBe(false);
    expect(interactionContextPayload(contexts)).toEqual([{
      target: { nodeId: 3, sourceInteractionNodeId: 2, sourceLayerId: 1 },
      annotations: ["note"],
    }]);
    expect(composerDisabledForState("running")).toBe(true);
    expect(composerDisabledForState("not_started", true, true)).toBe(false);
    expect(composerDisabledForState("waiting_for_approval")).toBe(true);
    expect(composerDisabledForState("accepted")).toBe(false);
    expect(composerDisabledForState("accepted", false)).toBe(true);
  });

  it("attaches an unannotated node only after confirmation and preserves annotation order", () => {
    const node = { id: 3, title: "Context" };
    const target = { nodeId: 3, sourceInteractionNodeId: 2, sourceLayerId: 1 };
    const attaching = { attaching: true, annotationIndex: null, value: "" };
    expect(contextEditorCanConfirm(attaching)).toBe(true);
    const attached = applyContextEditor([], attaching, node, target);
    expect(attached).toEqual([{ target, node, annotations: [] }]);
    expect(composerSubmissionReady("", false, true, attached)).toBe(false);

    const first = applyContextEditor(attached, {
      attaching: false,
      annotationIndex: null,
      value: " first ",
    }, node, target);
    const second = applyContextEditor(first, {
      attaching: false,
      annotationIndex: null,
      value: "second",
    }, node, target);
    expect(second[0].annotations).toEqual(["first", "second"]);
    const edited = applyContextEditor(second, {
      attaching: false,
      annotationIndex: 0,
      value: "revised",
    }, node, target);
    expect(edited[0].annotations).toEqual(["revised", "second"]);
    expect(contextEditorCanConfirm({ attaching: false, annotationIndex: null, value: "  " }))
      .toBe(false);
    expect(contextDetachNeedsConfirmation(edited[0])).toBe(true);
    const afterFirstDelete = removeContextAnnotation(edited, 3, 0);
    const afterLastDelete = removeContextAnnotation(afterFirstDelete, 3, 0);
    expect(afterLastDelete).toHaveLength(1);
    expect(afterLastDelete[0].annotations).toEqual([]);
    expect(contextDetachNeedsConfirmation(afterLastDelete[0])).toBe(false);
  });

  it("keeps compact context counts and long annotation editors bounded", () => {
    expect(contextAnnotationCountLabel(0)).toBe("0 annotations");
    expect(contextAnnotationCountLabel(1)).toBe("1 annotation");
    expect(contextAnnotationCountLabel(7)).toBe("7 annotations");

    const textarea = { scrollHeight: 64, style: {} };
    resizeContextEditorTextarea(textarea);
    expect(textarea.style).toMatchObject({ height: "64px", overflowY: "hidden" });

    textarea.scrollHeight = CONTEXT_EDITOR_MAX_HEIGHT + 100;
    resizeContextEditorTextarea(textarea);
    expect(textarea.style).toMatchObject({
      height: `${CONTEXT_EDITOR_MAX_HEIGHT}px`,
      overflowY: "auto",
    });

    textarea.scrollHeight = 0;
    resizeContextEditorTextarea(textarea);
    expect(textarea.style.height).toBe(`${CONTEXT_EDITOR_MIN_HEIGHT}px`);
  });

  it("keeps deletion available while an annotation is being edited", async () => {
    const [workspace, styles] = await Promise.all([
      readFile(new URL("../desktop/renderer/src/product-workspace/workspace.js", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/styles.css", import.meta.url), "utf8"),
    ]);
    expect(workspace).toContain("Delete annotation being edited for ${node.title}");
    expect(workspace).toContain("if (contextEditor.annotationIndex != null) controls.append(remove);");
    expect(styles).toContain(".composer-context-pills{display:flex;flex-wrap:nowrap;gap:7px;overflow-x:auto");
  });

  it("resolves a historical context node while reopening it for the next message", () => {
    const historical = { id: 7, title: "Historical target" };
    const overrides = new Map([["7", historical]]);
    expect(resolveInteractionContextNode(7, [], [], overrides)).toBe(historical);

    const attached = { id: 8, title: "Attached draft" };
    expect(resolveInteractionContextNode(8, [], [{
      target: { nodeId: 8 },
      node: attached,
    }], overrides)).toBe(attached);
    expect(hasHistoricalContextSelection(7, { nodeId: 7 }, overrides)).toBe(true);
    expect(hasHistoricalContextSelection(7, null, overrides)).toBe(false);
    expect(hasHistoricalContextSelection(8, { nodeId: 8 }, overrides)).toBe(false);
    expect(graphRenderClearsSelection({
      hasResponseNodes: false,
      enteringView: true,
      nodeInGraph: false,
      preserveHistoricalSelection: true,
    })).toBe(false);
    expect(graphRenderClearsSelection({
      hasResponseNodes: false,
      enteringView: true,
      nodeInGraph: false,
      preserveHistoricalSelection: false,
    })).toBe(true);
    const origin = { id: "context-node" };
    expect(historicalContextSelectionOptions({ nodeId: 7 }, origin)).toEqual({
      notify: false,
      userInitiated: true,
      focusInspector: true,
      contextTarget: { nodeId: 7 },
      origin,
    });
  });

  it("keeps context controls symbol-first and accessible", () => {
    const markup = productWorkspaceMarkup();
    expect(markup).toContain('id="composerContextTray" aria-label="Connected node draft"');
    expect(markup).toContain('id="attachNodeContext"');
    expect(markup).toContain('aria-label="Connect node to next message">+</button>');
    expect(markup).toContain('id="interactionContextPill"');
    expect(markup.indexOf('id="interactionContextPill"')).toBeLessThan(
      markup.indexOf('id="turnPickerButton"'),
    );
  });

  it("preserves failed drafts but clears them after durable send or a thread switch", () => {
    const draft = {
      contexts: [{ target: { nodeId: 3 }, annotations: ["note"] }],
      editor: { nodeId: 3, value: "unsaved" },
    };
    expect(interactionContextDraftTransition(draft, "send_failure")).toBe(draft);
    expect(interactionContextDraftTransition(draft, "durable_send"))
      .toEqual({ contexts: [], editor: null });
    expect(interactionContextDraftTransition(draft, "thread_change"))
      .toEqual({ contexts: [], editor: null });
    expect(contextStagingDisabledFor("running", true, false)).toBe(true);
    expect(contextStagingDisabledFor("accepted", true, true)).toBe(true);
    expect(contextStagingDisabledFor("failed", true, false)).toBe(false);
    expect(contextEditorPresentation({ attaching: true, value: "" }, true)).toEqual({
      textareaDisabled: true,
      confirmDisabled: true,
    });
    expect(contextEditorPresentation({ attaching: true, value: "" }, false)).toEqual({
      textareaDisabled: false,
      confirmDisabled: false,
    });
    expect(composerStatusForThread({
      status: "accepted",
      interactions: [
        { id: 1, threadId: 10, sequence: 1, completionStatus: "accepted" },
        { id: 2, threadId: 10, sequence: 2, completionStatus: "running" },
      ],
    }, { id: 10 })).toBe("running");
  });

  it("only clears the exact composer draft whose send completed", () => {
    const submittedContexts = [{ target: { nodeId: 3 }, annotations: ["note"] }];
    const submittedDraftScopeKey = composerDraftScopeKey(10, 100);
    expect(composerDraftMatchesSubmission({
      currentThreadId: 10,
      submittedThreadId: 10,
      currentDraftScopeKey: submittedDraftScopeKey,
      submittedDraftScopeKey,
      currentPromptValue: "send A",
      submittedPromptValue: "send A",
      currentContexts: submittedContexts,
      submittedContexts,
    })).toBe(true);
    expect(composerDraftMatchesSubmission({
      currentThreadId: 11,
      submittedThreadId: 10,
      currentDraftScopeKey: composerDraftScopeKey(11, 200),
      submittedDraftScopeKey,
      currentPromptValue: "send B",
      submittedPromptValue: "send A",
      currentContexts: [],
      submittedContexts,
    })).toBe(false);
    expect(composerDraftMatchesSubmission({
      currentThreadId: 10,
      submittedThreadId: 10,
      currentDraftScopeKey: submittedDraftScopeKey,
      submittedDraftScopeKey,
      currentPromptValue: "send B",
      submittedPromptValue: "send A",
      currentContexts: submittedContexts,
      submittedContexts,
    })).toBe(false);
    expect(composerDraftMatchesSubmission({
      currentThreadId: 10,
      submittedThreadId: 10,
      currentDraftScopeKey: submittedDraftScopeKey,
      submittedDraftScopeKey,
      currentPromptValue: "send A",
      submittedPromptValue: "send A",
      currentContexts: [...submittedContexts],
      submittedContexts,
    })).toBe(false);
    expect(composerDraftMatchesSubmission({
      currentThreadId: 10,
      submittedThreadId: 10,
      currentDraftScopeKey: composerDraftScopeKey(10, 101),
      submittedDraftScopeKey,
      currentPromptValue: "send A",
      submittedPromptValue: "send A",
      currentContexts: submittedContexts,
      submittedContexts,
    })).toBe(false);
  });

  it("scopes restored and user-authored drafts across A to B to A switches", () => {
    let state = createComposerDraftScopeState();
    let transition = transitionComposerDraftScope(state, {
      threadId: "thread-a",
      interactionId: "interaction-a",
      currentPromptValue: "",
      restoredDraft: { text: "retry A" },
    });
    state = transition.state;
    expect(transition.promptValue).toBe("retry A");
    expect(state.drafts.get(composerDraftScopeKey("thread-a", "interaction-a")))
      .toMatchObject({ restoredDraftInteractionId: "interaction-a" });

    transition = transitionComposerDraftScope(state, {
      threadId: "thread-b",
      interactionId: "interaction-b",
      currentPromptValue: "edited retry A",
    });
    state = transition.state;
    expect(transition.promptValue).toBe("");
    expect(state.drafts.get(composerDraftScopeKey("thread-b", "interaction-b")))
      .toEqual({ promptValue: "", restoredDraftInteractionId: null });

    transition = transitionComposerDraftScope(state, {
      threadId: "thread-a",
      interactionId: "interaction-a",
      currentPromptValue: "draft B",
      restoredDraft: { text: "retry A" },
    });
    state = transition.state;
    expect(transition.promptValue).toBe("edited retry A");
    expect(state.drafts.get(composerDraftScopeKey("thread-b", "interaction-b")))
      .toEqual({ promptValue: "draft B", restoredDraftInteractionId: null });
  });

  it("never exposes another interaction's restored prompt as the active send value", () => {
    let state = createComposerDraftScopeState();
    let transition = transitionComposerDraftScope(state, {
      threadId: 10,
      interactionId: 100,
      currentPromptValue: "",
      restoredDraft: { text: "stale A" },
    });
    state = transition.state;
    expect(transition.promptValue).toBe("stale A");

    transition = transitionComposerDraftScope(state, {
      threadId: 11,
      interactionId: 200,
      currentPromptValue: transition.promptValue,
    });
    expect(transition.promptValue).toBe("");
    expect(composerSubmissionReady(transition.promptValue, false, true)).toBe(false);

    transition = transitionComposerDraftScope(transition.state, {
      threadId: 11,
      interactionId: 200,
      currentPromptValue: "send B",
    });
    expect(transition.promptValue).toBe("send B");
    expect(composerSubmissionReady(transition.promptValue, false, true)).toBe(true);
  });

  it("clears a restored draft when the latest interaction changes in the same thread", () => {
    let transition = transitionComposerDraftScope(createComposerDraftScopeState(), {
      threadId: 10,
      interactionId: 100,
      currentPromptValue: "",
      restoredDraft: { text: "retry interaction 100" },
    });
    transition = transitionComposerDraftScope(transition.state, {
      threadId: 10,
      interactionId: 101,
      currentPromptValue: transition.promptValue,
    });
    expect(transition.promptValue).toBe("");
    expect(transition.state.drafts.get(composerDraftScopeKey(10, 101)))
      .toEqual({ promptValue: "", restoredDraftInteractionId: null });
  });

  it("applies a model-failed restoration that arrives after the running interaction rendered", () => {
    let transition = transitionComposerDraftScope(createComposerDraftScopeState(), {
      threadId: 10,
      interactionId: 100,
      currentPromptValue: "",
    });
    expect(transition.promptValue).toBe("");

    transition = transitionComposerDraftScope(transition.state, {
      threadId: 10,
      interactionId: 100,
      currentPromptValue: "",
      restoredDraft: { text: "retry after model failure" },
    });
    expect(transition.promptValue).toBe("retry after model failure");
    expect(transition.state.drafts.get(composerDraftScopeKey(10, 100)))
      .toEqual({
        promptValue: "retry after model failure",
        restoredDraftInteractionId: 100,
      });

    transition = transitionComposerDraftScope(transition.state, {
      threadId: 10,
      interactionId: 100,
      currentPromptValue: "user edited the restored prompt",
      restoredDraft: { text: "stale server retry text" },
    });
    expect(transition.promptValue).toBe("user edited the restored prompt");
    expect(transition.state.drafts.get(composerDraftScopeKey(10, 100)))
      .toEqual({
        promptValue: "user edited the restored prompt",
        restoredDraftInteractionId: 100,
      });
  });

  it("starts at one line, grows to its cap, and then enables vertical scrolling", async () => {
    expect(productWorkspaceMarkup()).toContain('id="threadPrompt" rows="1"');
    const textarea = { scrollHeight: 84, style: {} };
    resizeComposerTextarea(textarea);
    expect(textarea.style).toMatchObject({ height: "84px", overflowY: "hidden" });

    textarea.scrollHeight = COMPOSER_MAX_HEIGHT + 40;
    resizeComposerTextarea(textarea);
    expect(textarea.style).toMatchObject({
      height: `${COMPOSER_MAX_HEIGHT}px`,
      overflowY: "auto",
    });

    textarea.scrollHeight = 0;
    resizeComposerTextarea(textarea);
    expect(textarea.style.height).toBe(`${COMPOSER_MIN_HEIGHT}px`);

    const styles = await readFile(new URL("../desktop/renderer/styles.css", import.meta.url), "utf8");
    expect(styles).toContain(".thread-composer textarea{flex:1;height:42px;min-height:42px;max-height:126px;resize:none;overflow-y:hidden");
    expect(styles).not.toContain(".thread-composer textarea{flex:1;min-height:42px;max-height:126px;resize:vertical");
  });

  it("places an accessible approval dock below the graph and above the composer", async () => {
    const markup = productWorkspaceMarkup();
    expect(markup.indexOf('id="graphStage"')).toBeLessThan(markup.indexOf('id="approvalDock"'));
    expect(markup.indexOf('id="approvalDock"')).toBeLessThan(markup.indexOf('id="threadComposer"'));
    expect(markup).toContain('id="approvalDock" tabindex="-1" aria-labelledby="approvalTitle"');
    expect(markup).toContain('role="group" aria-label="Resolve approval request"');
    expect(markup).toContain('id="denyApproval"');
    expect(markup).toContain('id="approveOnce"');
    expect(markup).toContain('id="approveAlways"');
    expect(markup).toContain('<small>this session</small>');
    expect(markup).toContain('id="approvalHistoryList" tabindex="0" aria-label="Resolved approval requests"');
    expect(markup).toContain('id="inspector"');
    expect(markup).not.toContain("right-chat");

    const styles = await readFile(new URL("../desktop/renderer/styles.css", import.meta.url), "utf8");
    expect(styles).toContain(".thread-workspace{grid-column:1 / -1;grid-row:3;display:grid;grid-template-columns:minmax(0,1fr) var(--inspector)");
    expect(styles).toContain(".approval-dock{flex:none;border-top:1px solid var(--line-strong)");
    expect(styles).toContain(".approval-always small{font-size:8px");
    expect(styles).not.toContain(".approval-dock{position:absolute");
    expect(styles).toContain(".approval-dock.history-only{padding-block:9px}");
    expect(styles).toContain(".approval-history ol{height:64px;");
    expect(styles).toContain("overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable");
    expect(styles).toContain(".approval-history ol:focus-visible{outline:1px solid var(--blue)");
    expect(styles).toContain(".approval-history ol::-webkit-scrollbar{width:8px}");
  });

  it("defers same-thread composer focus until completion is no longer running", () => {
    const waiting = composerFocusRestoration(null, {
      activeWasInside: true,
      dockThreadId: "10",
      threadId: "10",
      canCompose: true,
      promptDisabled: true,
    });
    expect(waiting).toEqual({ pendingThreadId: "10", shouldFocus: false });
    expect(composerFocusRestoration(waiting.pendingThreadId, {
      activeWasInside: false,
      dockThreadId: "10",
      threadId: "10",
      canCompose: true,
      promptDisabled: false,
    })).toEqual({ pendingThreadId: null, shouldFocus: true });
    expect(composerFocusRestoration("10", {
      activeWasInside: false,
      dockThreadId: "10",
      threadId: "11",
      canCompose: true,
      promptDisabled: false,
    })).toEqual({ pendingThreadId: null, shouldFocus: false });
  });
});
