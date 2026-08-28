import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { productWorkspaceMarkup } from "../desktop/renderer/src/product-workspace/view.js";
import {
  COMPOSER_MAX_HEIGHT,
  COMPOSER_MIN_HEIGHT,
  applyComposerCapabilities,
  applyContextEditor,
  applyMountedContextEditorInput,
  bindComposerKeydown,
  clearSubmittedComposerDraft,
  composerDisabledForState,
  confirmationSendFailureMayHaveCommitted,
  confirmationSendReplayIntent,
  continueDraftOverrideAfterPersistence,
  composerConfirmationAuthorityChanged,
  composerDraftScopeKey,
  composerContextsFromConfirmations,
  composerContextsMergedWithConfirmations,
  composerFocusRestoration,
  composerKeydownIntent,
  composerSubmissionReady,
  composerStatusForThread,
  contextDraftHasAnnotation,
  contextDraftSendWarningPresentation,
  contextConfirmationIds,
  contextAnnotationCountLabel,
  contextDetachNeedsConfirmation,
  contextEditorCanConfirm,
  contextEditorPresentation,
  contextEditorIdentity,
  durableContextEditorForDraft,
  nodeContextDockError,
  nodeContextDraftForSelection,
  saveContextDraftBeforeSelection,
  contextConfirmationDestination,
  contextStagingDisabledFor,
  createComposerDraftScopeState,
  graphTurnNavigationDelta,
  graphRenderClearsSelection,
  hasHistoricalContextSelection,
  historicalContextSelectionOptions,
  handleComposerKeydown,
  resizeComposerTextarea,
  syncMountedContextEditorControls,
  interactionContextPayload,
  interactionSendIntent,
  interactionContextTargetForEditor,
  removeContextAnnotation,
  refreshComposerContextsAfterFailedConfirmationSend,
  resolveInteractionContextNode,
  sendIntentIsCurrentThread,
  sendAttemptBlocksThread,
  releaseInFlightSend,
  settleConfirmationSendReplay,
  threadHasInFlightSend,
  settledComposerContextsWithConfirmations,
  transitionComposerDraftScope,
} from "../desktop/renderer/src/product-workspace/workspace.js";

describe("product workspace keyboard behavior", () => {
  it("projects durable confirmations into grouped composer contexts with exact identities", () => {
    const target = { nodeId: 7, sourceInteractionNodeId: 3, sourceLayerId: 5 };
    const targetNode = { id: 7, title: "Queue" };
    const confirmations = [
      { draftId: "a", target, targetNode, annotation: "FIFO", draftRevision: 1 },
      { draftId: "b", target, targetNode, annotation: "Bounded", draftRevision: 2 },
    ];
    const contexts = composerContextsFromConfirmations(confirmations);
    expect(contexts).toEqual([{
      target,
      node: targetNode,
      annotations: ["FIFO", "Bounded"],
      annotationConfirmations: confirmations,
    }]);
    expect(contextConfirmationIds(contexts)).toEqual(["a", "b"]);
  });

  it("keeps repeated node IDs separate when their source occurrences differ", () => {
    const target = { nodeId: 7, sourceInteractionNodeId: 3, sourceLayerId: 5 };
    const targetNode = { id: 7, title: "Queue" };
    const confirmations = [
      { draftId: "a", target, targetNode, annotation: "First" },
      {
        draftId: "b",
        target: { ...target, sourceInteractionNodeId: 9, sourceLayerId: 12 },
        targetNode,
        annotation: "Second",
      },
    ];
    expect(composerContextsFromConfirmations(confirmations)).toHaveLength(2);
  });

  it("merges late restored confirmations without clearing newer ephemeral work", () => {
    const target = { nodeId: 7, sourceInteractionNodeId: 3, sourceLayerId: 5 };
    const targetNode = { id: 7, title: "Queue" };
    const ephemeral = [{
      target,
      node: targetNode,
      annotations: ["Newer"],
      annotationConfirmations: [null],
    }];
    const confirmation = {
      draftId: "a",
      target,
      targetNode,
      annotation: "Restored",
    };
    expect(composerContextsMergedWithConfirmations(ephemeral, [confirmation])).toEqual([{
      target,
      node: targetNode,
      annotations: ["Restored", "Newer"],
      annotationConfirmations: [confirmation, null],
    }]);
  });

  it("reprojects failed-send confirmation conflicts without dropping newer local work", async () => {
    const target = { nodeId: 7, sourceInteractionNodeId: 3, sourceLayerId: 5 };
    const targetNode = { id: 7, title: "Queue" };
    const obsolete = {
      draftId: "obsolete",
      target,
      targetNode,
      annotation: "Consumed elsewhere",
      confirmationRevision: 1,
    };
    const current = [{
      target,
      node: targetNode,
      annotations: [obsolete.annotation, "Newer unsent note"],
      annotationConfirmations: [obsolete, null],
    }];

    expect(composerConfirmationAuthorityChanged(current, [obsolete])).toBe(false);
    expect(composerConfirmationAuthorityChanged(current, [])).toBe(true);
    expect(composerContextsMergedWithConfirmations(current, [])).toEqual([{
      target,
      node: targetNode,
      annotations: ["Newer unsent note"],
      annotationConfirmations: [null],
    }]);

    const edited = {
      ...obsolete,
      annotation: "Authoritative edit",
      confirmationRevision: 2,
    };
    expect(composerConfirmationAuthorityChanged(current, [edited])).toBe(true);
    expect(composerContextsMergedWithConfirmations(current, [edited])).toEqual([{
      target,
      node: targetNode,
      annotations: ["Authoritative edit", "Newer unsent note"],
      annotationConfirmations: [edited, null],
    }]);

    const load = vi.fn(async () => undefined);
    const refreshed = await refreshComposerContextsAfterFailedConfirmationSend({
      controller: {
        load,
        confirmationsForThread: () => [],
      },
      threadId: "thread-a",
      currentContextState: () => ({ value: current, revision: 7 }),
    });
    expect(load).toHaveBeenCalledWith("thread-a");
    expect(refreshed).toEqual({
      changed: true,
      sourceValue: current,
      sourceRevision: 7,
      value: [{
        target,
        node: targetNode,
        annotations: ["Newer unsent note"],
        annotationConfirmations: [null],
      }],
    });

    await expect(refreshComposerContextsAfterFailedConfirmationSend({
      controller: {
        load: vi.fn(async () => { throw new Error("offline"); }),
        confirmationsForThread: vi.fn(),
      },
      threadId: "thread-a",
      currentContextState: () => ({ value: current, revision: 7 }),
    })).rejects.toThrow("offline");
  });

  it("binds a durable draft to the selected node-details editor identity", () => {
    const target = { nodeId: 7, sourceInteractionNodeId: 3, sourceLayerId: 5 };
    const targetNode = { id: 7, title: "Incoming queue" };
    const draft = {
      id: "draft-queue",
      target,
      targetNode,
      text: "Keep the queue ordered",
      revision: 3,
      status: "saved",
    };
    const editor = durableContextEditorForDraft("thread-a", targetNode, draft, {
      attaching: false,
      error: "Confirmation failed",
    });

    expect(editor).toMatchObject({
      ownerThreadId: "thread-a",
      nodeId: targetNode.id,
      draftId: "draft-queue",
      target,
      value: "Keep the queue ordered",
      annotationIndex: null,
      attaching: false,
      durable: true,
      error: "Confirmation failed",
    });
    expect(contextEditorIdentity(editor)).toBe(JSON.stringify([
      "thread-a",
      "draft-queue",
      String(targetNode.id),
      String(target.sourceInteractionNodeId),
      String(target.sourceLayerId),
      null,
      false,
      true,
    ]));
    expect(durableContextEditorForDraft("thread-a", { ...targetNode, id: 8 }, draft))
      .toBeNull();
  });

  it("restores a dock draft only for the selected source occurrence", () => {
    const node = { id: 7, title: "Queue" };
    const target = { nodeId: 7, sourceInteractionNodeId: 3, sourceLayerId: 5 };
    const draft = { id: "draft-queue", target, text: "Keep FIFO", status: "saved" };

    expect(nodeContextDraftForSelection(draft, node, target)).toBe(draft);
    expect(nodeContextDraftForSelection(draft, node, {
      ...target,
      sourceLayerId: 6,
    })).toBeNull();
    expect(nodeContextDraftForSelection(draft, { ...node, id: 8 }, target)).toBeNull();
  });

  it("waits for a durable save before allowing a node selection transition", async () => {
    const draft = {
      revision: null,
      status: "unsaved",
      text: "Before selection changes",
    };
    const controller = {
      update: vi.fn((_threadId, _nodeId, value) => {
        draft.text = value;
        return draft;
      }),
      draftForNode: vi.fn(() => draft),
      flush: vi.fn(async () => {
        expect(draft.text).toBe("Before selection changes");
        draft.revision = 1;
        draft.status = "saved";
      }),
    };
    const editor = {
      ownerThreadId: "thread-a",
      nodeId: 7,
      value: "Before selection changes",
      durable: true,
    };

    await expect(saveContextDraftBeforeSelection({
      controller,
      editor,
      textarea: { value: "Before selection changes", disabled: false },
    })).resolves.toBe(true);
    expect(controller.flush).toHaveBeenCalledOnce();

    draft.status = "error";
    draft.revision = null;
    controller.flush.mockImplementationOnce(async () => {});
    await expect(saveContextDraftBeforeSelection({ controller, editor, textarea: null }))
      .resolves.toBe(false);
    expect(nodeContextDockError(editor, { status: "error", error: "disk full" }))
      .toBe("Not saved: disk full");
  });

  it("mounts the annotation editor only in the bottom of Node Details", async () => {
    const markup = productWorkspaceMarkup();
    const detailContent = markup.indexOf('id="inspectorContent"');
    const dock = markup.indexOf('id="nodeContextDock"');
    const evaluationPanel = markup.indexOf('id="annotationPanel"');
    const composerTray = markup.slice(
      markup.indexOf('id="composerContextTray"'),
      markup.indexOf('id="threadComposer"'),
    );

    expect(detailContent).toBeGreaterThan(-1);
    expect(detailContent).toBeLessThan(dock);
    expect(dock).toBeLessThan(evaluationPanel);
    expect(markup).toContain('aria-label="Node context annotation editor"');
    expect(composerTray).not.toContain("contextAnnotationEditor");

    const styles = await readFile(new URL("../desktop/renderer/styles.css", import.meta.url), "utf8");
    expect(styles).toContain(".node-context-dock{height:33.333%;min-height:0");
    expect(styles).toContain(".inspector:has(.node-context-dock:not(.hidden)) .inspector-content{min-height:0}");
    expect(styles).toContain(".app-shell:has(.desktop-account-corner-control:not(.hidden)) .node-context-dock-actions{padding-right:112px}");
    expect(styles).toContain(".node-context-dock textarea{min-height:0;flex:1;resize:none;overflow:auto");
    expect(styles).toContain("@media(forced-colors:active){.node-context-dock");
    expect(styles).toContain("@media(prefers-reduced-motion:reduce){.node-context-dock *");
  });

  it("routes every selection-clearing control through the production draft-save gate", async () => {
    const workspaceSource = await readFile(new URL(
      "../desktop/renderer/src/product-workspace/workspace.js",
      import.meta.url,
    ), "utf8");
    const graphSource = await readFile(new URL(
      "../desktop/renderer/src/graph.js",
      import.meta.url,
    ), "utf8");
    const mainSource = await readFile(new URL(
      "../desktop/renderer/src/main.js",
      import.meta.url,
    ), "utf8");
    const seam = (start, end) => workspaceSource.slice(
      workspaceSource.indexOf(start),
      workspaceSource.indexOf(end, workspaceSource.indexOf(start)),
    );

    for (const [label, source] of [
      ["close", seam("const closeInspector = async", "const closeInspectorOnEscape")],
      ["history", seam("const navigateHistory = async", '$("#historyBack")')],
      ["previous turn", seam('$("#previousTurn").onclick', '$("#nextTurn").onclick')],
      ["next turn", seam('$("#nextTurn").onclick', "const openTurnPopover")],
      ["graph keyboard", seam("graphStage.onkeydown", "graphStage.onpointerdown")],
      ["turn picker", seam("row.onclick = async", "list.append(row)")],
      ["breadcrumb", seam("segment.onclick = async", "children.push(segment)")],
      ["breadcrumb annotation", seam("badge.onclick = async", "children.push(badge)")],
      ["navigational action", seam("if (activation.navigational)", "button.disabled = true")],
    ]) {
      expect(source, `${label} bypasses the draft-save gate`)
        .toContain("prepareNodeContextSelectionChange()");
    }
    expect(workspaceSource).toContain("prepareSelectionChange: prepareNodeContextSelectionChange");
    expect(graphSource).toContain("productWorkspace?.prepareSelectionChange()");
    expect(mainSource.match(/prepareCurrentWorkspaceTransition\(\)/g)).toHaveLength(3);
  });

  it("presents every unconfirmed draft with stable accessible identity", () => {
    const drafts = Array.from({ length: 12 }, (_, index) => ({
      id: `draft-${index}`,
      targetNode: { title: index === 11 ? "" : `Node ${index}` },
    }));
    const presentation = contextDraftSendWarningPresentation(drafts);

    expect(presentation.countLabel).toBe("12 unconfirmed drafts");
    expect(presentation.items).toHaveLength(12);
    expect(presentation.items[0]).toEqual({ id: "draft-0", title: "Node 0" });
    expect(presentation.items[11]).toEqual({ id: "draft-11", title: "Untitled node" });
    expect(contextDraftSendWarningPresentation([drafts[0]]).countLabel)
      .toBe("1 unconfirmed draft");
  });

  it("mounts the exact two-choice modal warning at the composer boundary", () => {
    const markup = productWorkspaceMarkup();
    const warning = markup.slice(
      markup.indexOf('id="contextDraftSendWarning"'),
      markup.indexOf("</dialog>") + "</dialog>".length,
    );

    expect(warning).toContain('role="dialog" aria-modal="true"');
    expect(warning).toContain('tabindex="-1"');
    expect(warning).toContain('data-context-draft-warning-list tabindex="0"');
    expect(warning.match(/<button/g)).toHaveLength(2);
    expect(warning).toContain(">Go back</button>");
    expect(warning).toContain(">Send without drafts</button>");
  });

  it("drops a pending send intent when draft loading outlives its thread", () => {
    expect(sendIntentIsCurrentThread("thread-a", "thread-a")).toBe(true);
    expect(sendIntentIsCurrentThread("thread-b", "thread-a")).toBe(false);
    expect(sendIntentIsCurrentThread(null, "thread-a")).toBe(false);
  });

  it.each([
    { boundary: "send attempt", nextAttempt: null, nextThreadId: "thread-a" },
    { boundary: "thread authority", nextAttempt: "same", nextThreadId: "thread-b" },
  ])("cancels Send without drafts when $boundary changes during held persistence", async ({
    nextAttempt,
    nextThreadId,
  }) => {
    const draft = {
      id: "draft-held",
      target: { nodeId: 7, sourceInteractionNodeId: 3, sourceLayerId: 5 },
      text: "Keep this exact pending annotation.",
      revision: 1,
    };
    const originalDraftIdentity = draft;
    let releasePersistence;
    const persistenceHeld = new Promise((resolve) => { releasePersistence = resolve; });
    const controller = {
      persistAll: vi.fn(async () => {
        await persistenceHeld;
        draft.revision = 2;
        return [draft];
      }),
    };
    const attempt = { threadId: "thread-a" };
    let currentAttempt = attempt;
    let currentThreadId = "thread-a";
    const continueSend = vi.fn();

    const settlement = continueDraftOverrideAfterPersistence({
      controller,
      threadId: "thread-a",
      attempt,
      readCurrentThreadId: () => currentThreadId,
      readCurrentAttempt: () => currentAttempt,
      continueSend,
    });
    currentAttempt = nextAttempt === "same" ? attempt : nextAttempt;
    currentThreadId = nextThreadId;
    releasePersistence();

    await expect(settlement).resolves.toBe(false);
    expect(controller.persistAll).toHaveBeenCalledWith("thread-a");
    expect(continueSend).not.toHaveBeenCalled();
    expect(draft).toBe(originalDraftIdentity);
    expect(draft).toEqual({
      id: "draft-held",
      target: { nodeId: 7, sourceInteractionNodeId: 3, sourceLayerId: 5 },
      text: "Keep this exact pending annotation.",
      revision: 2,
    });
  });

  it("scopes an asynchronous send lock to the thread that owns it", () => {
    expect(sendAttemptBlocksThread("thread-a", "thread-a")).toBe(true);
    expect(sendAttemptBlocksThread("thread-a", "thread-b")).toBe(false);
    expect(sendAttemptBlocksThread(null, "thread-a")).toBe(false);
  });

  it("retains the owning thread's in-flight lock across navigation", () => {
    const attemptA1 = { threadId: "thread-a" };
    const inFlightThreadIds = new Map([["thread-a", attemptA1]]);
    expect(threadHasInFlightSend(inFlightThreadIds, "thread-a")).toBe(true);
    expect(threadHasInFlightSend(inFlightThreadIds, "thread-b")).toBe(false);

    // Returning to A cannot start A2 until A1 settles, even when the visible
    // send-attempt pointer was released while B was rendered.
    expect(sendAttemptBlocksThread(null, "thread-a")).toBe(false);
    expect(threadHasInFlightSend(inFlightThreadIds, "thread-a")).toBe(true);
    expect(releaseInFlightSend(inFlightThreadIds, attemptA1)).toBe(true);
    expect(threadHasInFlightSend(inFlightThreadIds, "thread-a")).toBe(false);
  });

  it("does not let cancelled preflight cleanup release its replacement's lock", () => {
    const attemptA1 = { threadId: "thread-a" };
    const attemptA2 = { threadId: "thread-a" };
    const inFlightSends = new Map([["thread-a", attemptA1]]);

    expect(releaseInFlightSend(inFlightSends, attemptA1)).toBe(true);
    inFlightSends.set("thread-a", attemptA2);
    expect(releaseInFlightSend(inFlightSends, attemptA1)).toBe(false);
    expect(inFlightSends.get("thread-a")).toBe(attemptA2);
    expect(threadHasInFlightSend(inFlightSends, "thread-a")).toBe(true);
  });

  it("snapshots the submitted composer payload before asynchronous draft restoration", () => {
    const contexts = [{
      target: { nodeId: 7, sourceInteractionNodeId: 3, sourceLayerId: 5 },
      annotations: ["Original context"],
    }];
    const intent = interactionSendIntent({
      threadId: "thread-a",
      draftScopeKey: "thread-a:none",
      promptValue: "  Original prompt  ",
      contexts,
      modelSelection: { providerId: "fixture", modelId: "deterministic" },
    });
    contexts[0].annotations[0] = "Edited while loading";

    expect(intent).toMatchObject({
      threadId: "thread-a",
      promptValue: "  Original prompt  ",
      text: "Original prompt",
      contextPayload: [{
        target: { nodeId: 7, sourceInteractionNodeId: 3, sourceLayerId: 5 },
        annotations: ["Original context"],
      }],
    });
    expect(Object.isFrozen(intent)).toBe(true);
  });

  it("replays the exact confirmation-bearing intent after ambiguous failure", () => {
    const confirmation = {
      draftId: "confirmation-a",
      target: { nodeId: 7, sourceInteractionNodeId: 3, sourceLayerId: 5 },
      annotation: "Original context",
    };
    const intent = interactionSendIntent({
      threadId: "thread-a",
      draftScopeKey: "thread-a:turn-a",
      promptValue: "Original prompt",
      promptRevision: 4,
      contexts: [{
        target: confirmation.target,
        annotations: [confirmation.annotation],
        annotationConfirmations: [confirmation],
      }],
      contextRevision: 8,
      modelSelection: { providerId: "fixture", modelId: "deterministic" },
      inputDraftRevision: 3,
    });

    expect(confirmationSendReplayIntent({
      intent,
      threadId: "thread-a",
      draftScopeKey: "thread-a:turn-a",
      promptRevision: 4,
      contextRevision: 9,
      replayContextRevision: 9,
      modelSelection: intent.modelSelection,
      inputDraftRevision: 3,
    })).toBe(intent);
    expect(confirmationSendReplayIntent({
      intent,
      threadId: "thread-a",
      draftScopeKey: "thread-a:turn-a",
      promptRevision: 5,
      contextRevision: 9,
      replayContextRevision: 9,
      modelSelection: intent.modelSelection,
      inputDraftRevision: 3,
    })).toBeNull();
    expect(confirmationSendReplayIntent({
      intent,
      threadId: "thread-a",
      draftScopeKey: "thread-a:turn-b",
      promptRevision: 4,
      contextRevision: 9,
      replayContextRevision: 9,
      modelSelection: intent.modelSelection,
      inputDraftRevision: 3,
    })).toBeNull();
    expect(confirmationSendReplayIntent({
      intent,
      threadId: "thread-a",
      draftScopeKey: "thread-a:turn-a",
      promptRevision: 4,
      contextRevision: 10,
      replayContextRevision: 9,
      modelSelection: intent.modelSelection,
      inputDraftRevision: 3,
    })).toBeNull();
    expect(confirmationSendReplayIntent({
      intent,
      threadId: "thread-a",
      draftScopeKey: "thread-a:turn-a",
      promptRevision: 4,
      contextRevision: 9,
      replayContextRevision: 9,
      modelSelection: { providerId: "fixture", modelId: "other" },
      inputDraftRevision: 3,
    })).toBeNull();
    expect(confirmationSendReplayIntent({
      intent,
      threadId: "thread-a",
      draftScopeKey: "thread-a:turn-a",
      promptRevision: 4,
      contextRevision: 9,
      replayContextRevision: 9,
      modelSelection: intent.modelSelection,
      inputDraftRevision: 4,
      inputCompositionRevision: 1,
    })).toBeNull();
    expect(confirmationSendFailureMayHaveCommitted(new Error("network lost"))).toBe(true);
    expect(confirmationSendFailureMayHaveCommitted({ status: 503 })).toBe(true);
    expect(confirmationSendFailureMayHaveCommitted({ status: 409 })).toBe(false);
  });

  it("replays an ambiguous input-bearing send until the user changes the input composition", () => {
    const intent = interactionSendIntent({
      threadId: "thread-a",
      draftScopeKey: "thread-a:turn-a",
      promptValue: "",
      promptRevision: 2,
      contexts: [],
      contextRevision: 0,
      modelSelection: { providerId: "fixture", modelId: "deterministic" },
      inputDraftRevision: 7,
      inputCompositionRevision: 3,
    });
    const current = {
      intent,
      threadId: "thread-a",
      draftScopeKey: "thread-a:turn-a",
      promptRevision: 2,
      contextRevision: 0,
      replayContextRevision: 0,
      modelSelection: intent.modelSelection,
      inputDraftRevision: null,
      inputCompositionRevision: 3,
    };
    expect(confirmationSendReplayIntent(current)).toBe(intent);
    expect(confirmationSendReplayIntent({
      ...current,
      inputCompositionRevision: 4,
    })).toBeNull();
  });

  it("settles overlapping confirmation replays without cross-thread clobbering", () => {
    const intentA = { contextConfirmationIds: ["confirmation-a"] };
    const intentB = { contextConfirmationIds: ["confirmation-b"] };
    let replays = new Map();
    replays = settleConfirmationSendReplay(replays, {
      threadId: "thread-b",
      intent: intentB,
      contextRevision: 12,
      preserve: true,
    });

    replays = settleConfirmationSendReplay(replays, {
      threadId: "thread-a",
      intent: intentA,
      contextRevision: null,
      preserve: false,
    });
    expect(replays.get("thread-b")).toEqual({ intent: intentB, contextRevision: 12 });

    replays = settleConfirmationSendReplay(replays, {
      threadId: "thread-a",
      intent: intentA,
      contextRevision: 7,
      preserve: true,
    });
    expect(replays.get("thread-b")).toEqual({ intent: intentB, contextRevision: 12 });
    expect(replays.get("thread-a")).toEqual({ intent: intentA, contextRevision: 7 });
  });

  it("settles submitted confirmations without discarding newer composer work", () => {
    const target = { nodeId: 7, sourceInteractionNodeId: 3, sourceLayerId: 5 };
    const submitted = {
      draftId: "submitted",
      target,
      annotation: "Submitted note",
    };
    const remaining = {
      draftId: "remaining",
      target,
      annotation: "Other authoritative note",
    };
    const newerContexts = {
      revision: 9,
      value: [{
        target,
        annotations: [submitted.annotation, "Newer unsent note"],
        annotationConfirmations: [submitted, null],
      }],
    };

    expect(settledComposerContextsWithConfirmations(newerContexts, [remaining])).toEqual({
      revision: 9,
      value: [{
        target,
        node: undefined,
        annotations: ["Other authoritative note", "Newer unsent note"],
        annotationConfirmations: [remaining, null],
      }],
    });
  });

  it("locks already-mounted draft controls and rejects a racing input event", () => {
    const controls = {
      remove: { disabled: false },
      confirm: { disabled: false },
    };
    const textarea = {
      value: "racing edit",
      disabled: false,
      parentElement: {
        querySelector: (selector) => ({
          '[aria-label^="Discard annotation draft"]': controls.remove,
          '[aria-label="Confirm annotation"]': controls.confirm,
        }[selector]),
      },
    };
    syncMountedContextEditorControls(
      textarea,
      contextEditorPresentation({ durable: true, value: "saved" }, false, true),
      "saved",
    );
    expect(textarea.disabled).toBe(true);
    expect(controls).toEqual({
      remove: { disabled: true },
      confirm: { disabled: true },
    });

    const editor = { durable: true, value: "saved" };
    expect(applyMountedContextEditorInput({
      editor,
      textarea,
      controller: { update: vi.fn(() => null) },
      threadId: 1,
      nodeId: 7,
    })).toBe(false);
    expect(textarea.value).toBe("saved");
    expect(editor.value).toBe("saved");
  });

  it("defers a context confirmation that resolves after a thread switch", () => {
    expect(contextConfirmationDestination("thread-b", "thread-a")).toBe("deferred");
    expect(contextConfirmationDestination("thread-a", "thread-a")).toBe("current");
  });

  it("keeps an empty durable attach editor disabled across reconciliation", () => {
    expect(contextEditorCanConfirm({ attaching: true, durable: false, value: "" })).toBe(true);
    expect(contextEditorCanConfirm({ attaching: true, durable: true, value: "" })).toBe(false);
    expect(contextEditorCanConfirm({ attaching: true, durable: true, value: "note" })).toBe(true);
  });

  it("pins a context editor to the source occurrence captured when it opens", () => {
    const selectedTarget = {
      nodeId: 7,
      sourceInteractionNodeId: 31,
      sourceLayerId: 41,
    };
    expect(interactionContextTargetForEditor({
      nodeId: 7,
      selectedContextTarget: selectedTarget,
      sourceInteractionNodeId: 99,
      sourceLayerId: 100,
    })).toBe(selectedTarget);
    const existingTarget = {
      nodeId: 7,
      sourceInteractionNodeId: 11,
      sourceLayerId: 12,
    };
    expect(interactionContextTargetForEditor({
      nodeId: 7,
      contextTarget: existingTarget,
      selectedContextTarget: selectedTarget,
      sourceInteractionNodeId: 99,
      sourceLayerId: 100,
    })).toBe(existingTarget);
    expect(interactionContextTargetForEditor({
      nodeId: 7,
      sourceInteractionNodeId: 21,
      sourceLayerId: 22,
    })).toEqual({ nodeId: 7, sourceInteractionNodeId: 21, sourceLayerId: 22 });
  });
  it("keeps composer-owned review elements mounted while disabling composition", () => {
    const element = () => ({ classList: { toggle: vi.fn() } });
    const composer = element();
    const prompt = element();
    const send = element();
    const readOnlyMessage = element();

    applyComposerCapabilities({ composer, prompt, send, readOnlyMessage }, false);

    expect(composer.classList.toggle).toHaveBeenCalledWith("disabled-composer", true);
    expect(prompt.classList.toggle).toHaveBeenCalledWith("hidden", true);
    expect(send.classList.toggle).toHaveBeenCalledWith("hidden", true);
    expect(readOnlyMessage.classList.toggle).toHaveBeenCalledWith("hidden", false);
    expect(productWorkspaceMarkup()).toContain('id="composerRetryMessage"');
    expect(productWorkspaceMarkup()).toContain('id="readOnlyComposerMessage"');
  });

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
    expect(attached).toEqual([{
      target,
      node,
      annotations: [],
      annotationConfirmations: [],
    }]);
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
    const afterFirstDelete = removeContextAnnotation(edited, target, 0);
    const afterLastDelete = removeContextAnnotation(afterFirstDelete, target, 0);
    expect(afterLastDelete).toHaveLength(1);
    expect(afterLastDelete[0].annotations).toEqual([]);
    expect(contextDetachNeedsConfirmation(afterLastDelete[0])).toBe(false);
  });

  it("edits and deletes only the exact repeated node occurrence", () => {
    const node = { id: 3, title: "Repeated context" };
    const firstTarget = { nodeId: 3, sourceInteractionNodeId: 2, sourceLayerId: 1 };
    const secondTarget = { nodeId: 3, sourceInteractionNodeId: 8, sourceLayerId: 9 };
    const first = applyContextEditor([], {
      attaching: false,
      annotationIndex: null,
      value: "first occurrence",
    }, node, firstTarget);
    const both = applyContextEditor(first, {
      attaching: false,
      annotationIndex: null,
      value: "second occurrence",
    }, node, secondTarget);

    const edited = applyContextEditor(both, {
      attaching: false,
      annotationIndex: 0,
      value: "edited second occurrence",
    }, node, secondTarget);
    expect(edited.map((context) => context.annotations)).toEqual([
      ["first occurrence"],
      ["edited second occurrence"],
    ]);

    const removed = removeContextAnnotation(edited, secondTarget, 0);
    expect(removed.map((context) => context.annotations)).toEqual([
      ["first occurrence"],
      [],
    ]);
  });

  it("preserves edited text while clearing a remotely consumed confirmation identity", () => {
    const node = { id: 3, title: "Context" };
    const target = { nodeId: 3, sourceInteractionNodeId: 2, sourceLayerId: 1 };
    const confirmation = { draftId: "confirmed-a" };
    const contexts = [{
      target,
      node,
      annotations: ["stale text"],
      annotationConfirmations: [confirmation],
    }];

    expect(applyContextEditor(contexts, {
      attaching: false,
      annotationIndex: 0,
      value: "new local text",
      confirmation: null,
    }, node, target)).toEqual([{
      target,
      node,
      annotations: ["new local text"],
      annotationConfirmations: [null],
    }]);
  });

  it("keeps compact context counts grammatically stable", () => {
    expect(contextAnnotationCountLabel(0)).toBe("0 annotations");
    expect(contextAnnotationCountLabel(1)).toBe("1 annotation");
    expect(contextAnnotationCountLabel(7)).toBe("7 annotations");
  });

  it("keeps explicit confirmed previews read-only while retaining deletion", async () => {
    const [workspace, styles] = await Promise.all([
      readFile(new URL("../desktop/renderer/src/product-workspace/workspace.js", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/styles.css", import.meta.url), "utf8"),
    ]);
    expect(workspace).not.toContain("composer-context-inline-editor");
    expect(workspace).toContain("Delete annotation ${index + 1} for ${openContext.node.title}");
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
    expect(markup).toContain('id="composerContextTray" aria-label="Composer attachments"');
    expect(markup).toContain('id="attachNodeContext"');
    expect(markup).toContain('aria-label="Connect node to next message">+</button>');
    expect(markup).toContain('id="interactionContextPill"');
    expect(markup.indexOf('id="interactionContextPill"')).toBeLessThan(
      markup.indexOf('id="turnPickerButton"'),
    );
  });

  it("allows a committed node input to submit without prompt text", () => {
    expect(composerSubmissionReady("", false, true, [], false, [{ id: "input" }])).toBe(true);
    expect(composerSubmissionReady("", false, true, [], false, [])).toBe(false);
    expect(composerSubmissionReady("", true, true, [], false, [{ id: "input" }])).toBe(false);
  });

  it("keeps context editing enabled only for an available composer", () => {
    expect(contextStagingDisabledFor("running", true, false)).toBe(true);
    expect(contextStagingDisabledFor("accepted", true, true)).toBe(true);
    expect(contextStagingDisabledFor("failed", true, false)).toBe(false);
    expect(contextEditorPresentation({ attaching: true, value: "" }, true)).toEqual({
      textareaDisabled: true,
      controlsDisabled: true,
      confirmDisabled: true,
    });
    expect(contextEditorPresentation({ attaching: true, value: "" }, false)).toEqual({
      textareaDisabled: false,
      controlsDisabled: false,
      confirmDisabled: false,
    });
    expect(contextEditorPresentation({ attaching: false, value: "note" }, false, true)).toEqual({
      textareaDisabled: true,
      controlsDisabled: true,
      confirmDisabled: true,
    });
    expect(composerStatusForThread({
      status: "accepted",
      interactions: [
        { id: 1, threadId: 10, sequence: 1, completionStatus: "accepted" },
        { id: 2, threadId: 10, sequence: 2, completionStatus: "running" },
      ],
    }, { id: 10 })).toBe("running");
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
      currentPromptRevision: transition.promptRevision + 1,
    });
    state = transition.state;
    expect(transition.promptValue).toBe("");
    expect(state.drafts.get(composerDraftScopeKey("thread-b", "interaction-b")))
      .toMatchObject({ promptValue: "", restoredDraftInteractionId: null });

    transition = transitionComposerDraftScope(state, {
      threadId: "thread-a",
      interactionId: "interaction-a",
      currentPromptValue: "draft B",
      currentPromptRevision: transition.promptRevision + 1,
      restoredDraft: { text: "retry A" },
    });
    state = transition.state;
    expect(transition.promptValue).toBe("edited retry A");
    expect(state.drafts.get(composerDraftScopeKey("thread-b", "interaction-b")))
      .toMatchObject({ promptValue: "draft B", restoredDraftInteractionId: null });
  });

  it("retains a newer prompt revision across unrelated renders in the same scope", () => {
    const initial = transitionComposerDraftScope(createComposerDraftScopeState(), {
      threadId: 10,
      interactionId: 100,
      currentPromptValue: "",
      currentPromptRevision: 0,
    });
    const rerendered = transitionComposerDraftScope(initial.state, {
      threadId: 10,
      interactionId: 100,
      currentPromptValue: "same text retyped",
      currentPromptRevision: initial.promptRevision + 1,
    });

    expect(rerendered.promptRevision).toBe(initial.promptRevision + 1);
    expect(rerendered.state.drafts.get(rerendered.state.activeScopeKey))
      .toMatchObject({ promptValue: "same text retyped", promptRevision: rerendered.promptRevision });
  });

  it("does not restore a durably sent inactive draft after returning to its thread", () => {
    let transition = transitionComposerDraftScope(createComposerDraftScopeState(), {
      threadId: "thread-a",
      interactionId: "interaction-a",
      currentPromptValue: "",
      restoredDraft: { text: "retry A" },
    });
    const submittedScopeKey = transition.state.activeScopeKey;
    const submittedPromptRevision = transition.promptRevision;
    transition = transitionComposerDraftScope(transition.state, {
      threadId: "thread-b",
      interactionId: "interaction-b",
      currentPromptValue: "retry A",
      currentPromptRevision: submittedPromptRevision,
    });
    const cleared = clearSubmittedComposerDraft(
      transition.state,
      submittedScopeKey,
      submittedPromptRevision,
      transition.promptRevision,
    );
    transition = transitionComposerDraftScope(cleared, {
      threadId: "thread-a",
      interactionId: "interaction-a",
      currentPromptValue: "draft B",
      currentPromptRevision: transition.promptRevision + 1,
    });
    expect(transition.promptValue).toBe("");

    const edited = transitionComposerDraftScope(transition.state, {
      threadId: "thread-a",
      interactionId: "interaction-a",
      currentPromptValue: "",
      restoredDraft: { text: "retry A again" },
    });
    const preserved = clearSubmittedComposerDraft(
      edited.state,
      edited.state.activeScopeKey,
      edited.promptRevision,
      edited.promptRevision + 1,
    );
    expect(preserved.drafts.get(edited.state.activeScopeKey).promptValue).toBe("retry A again");
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
      .toMatchObject({ promptValue: "", restoredDraftInteractionId: null });
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
      .toMatchObject({
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
      .toMatchObject({
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
