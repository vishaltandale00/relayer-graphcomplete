import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { productWorkspaceMarkup } from "../desktop/renderer/src/product-workspace/view.js";
import {
  COMPOSER_MAX_HEIGHT,
  COMPOSER_MIN_HEIGHT,
  applyComposerCapabilities,
  applyContextEditor,
  applyMountedContextEditorInput,
  beginNodeInputMutation,
  bindComposerKeydown,
  clearSubmittedComposerDraft,
  composerDisabledForState,
  confirmationSendFailureMayHaveCommitted,
  confirmationSendReplayIntent,
  confirmationSendReplayIntentWithoutInputAuthority,
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
  rebuildInteractionSendIntentAfterInputReconciliation,
  resolveInteractionContextNode,
  sendIntentIsCurrentThread,
  sendAttemptBlocksThread,
  releaseInFlightSend,
  settleNodeInputCommit,
  selectInteractionSendIntentAfterInputReconciliation,
  settleConfirmationSendReplay,
  compactSubmittedText,
  submittedInputHistoryPresentation,
  threadHasInFlightSend,
  settledComposerContextsWithConfirmations,
  transitionComposerDraftScope,
} from "../desktop/renderer/src/product-workspace/workspace.js";
import {
  createNodeInputDraftController,
  createNodeInputDraftLoadQueue,
  createInputMutationTracker,
  threadHasPendingInputMutation,
} from "../desktop/renderer/src/node-input-controls.js";

describe("product workspace keyboard behavior", () => {
  it("wires bounded input-draft retries and replays send intents only while every authority is unchanged", async () => {
    const source = await readFile(new URL(
      "../desktop/renderer/src/product-workspace/workspace.js",
      import.meta.url,
    ), "utf8");
    expect(source, "the retry scheduler is constructed").toContain("createInputDraftLoadRetryScheduler({");
    expect(source, "retries are scheduled per thread").toContain("inputDraftLoadRetries?.schedule(thread.id);");
    expect(source, "suppressed retries skip eligibility").toContain("!inputDraftLoadRetries?.suppressesLoad(threadId)");
    expect(source.indexOf("inputDraftLoadRetries?.beginEligibilityCycle(thread.id);"),
      "the eligibility cycle begins before the suppression check")
      .toBeLessThan(source.indexOf("!inputDraftLoadRetries?.suppressesLoad(threadId)"));
    expect(source, "the retry scheduler is disposed").toContain("inputDraftLoadRetries?.dispose();");

    let releaseReconciliation;
    const reconciliation = new Promise((resolve) => { releaseReconciliation = resolve; });
    const api = {
      get: vi.fn()
        .mockResolvedValueOnce({
          threadId: 7,
          revision: 7,
          attachments: [],
          updatedAt: "revision-7",
        })
        .mockImplementationOnce(() => reconciliation),
      commit: vi.fn(),
      detach: vi.fn(),
    };
    const controller = createNodeInputDraftController({ api });
    const loads = createNodeInputDraftLoadQueue({
      load: (threadId) => controller.load(threadId),
    });
    await loads.load(7);
    const forcedReload = loads.load(7, { reload: true });
    const staleIntent = interactionSendIntent({
      threadId: 7,
      draftScopeKey: "7:turn-a",
      promptValue: "",
      contexts: [],
      modelSelection: { providerId: "fixture", modelId: "deterministic" },
      inputDraftRevision: 7,
    });
    const readReplay = vi.fn(() => confirmationSendReplayIntent({
      intent: staleIntent,
      threadId: 7,
      draftScopeKey: "7:turn-a",
      promptRevision: 0,
      contextRevision: 0,
      replayContextRevision: 0,
      modelSelection: staleIntent.modelSelection,
      inputDraftRevision: controller.current(7).revision,
    }));
    const rebuild = vi.fn(() => ({
      rebuilt: true,
      inputDraftRevision: controller.current(7).revision,
    }));

    const selecting = selectInteractionSendIntentAfterInputReconciliation({
      awaitInputDraft: () => loads.load(7),
      selectionIsCurrent: () => true,
      replayIntent: readReplay,
      rebuildIntent: rebuild,
    });
    await Promise.resolve();
    expect(readReplay, "replay waits for forced input reconciliation").not.toHaveBeenCalled();
    expect(rebuild, "rebuild waits for forced input reconciliation").not.toHaveBeenCalled();

    releaseReconciliation({
      threadId: 7,
      revision: 8,
      attachments: [],
      updatedAt: "revision-8",
    });
    await forcedReload;
    await expect(selecting, "reconciliation settles with the rebuilt intent")
      .resolves.toEqual({ rebuilt: true, inputDraftRevision: 8 });
    expect(readReplay, "replay runs once after reconciliation").toHaveBeenCalledOnce();
    expect(rebuild, "rebuild runs once after reconciliation").toHaveBeenCalledOnce();

    const contexts = [{
      target: { nodeId: 7, sourceInteractionNodeId: 3, sourceLayerId: 5 },
      annotations: ["Original context"],
    }];
    const snapshotted = interactionSendIntent({
      threadId: "thread-a",
      draftScopeKey: "thread-a:none",
      promptValue: "  Original prompt  ",
      contexts,
      modelSelection: { providerId: "fixture", modelId: "deterministic" },
    });
    contexts[0].annotations[0] = "Edited while loading";
    expect(snapshotted, "the submitted payload snapshots before asynchronous draft restoration")
      .toMatchObject({
        threadId: "thread-a",
        promptValue: "  Original prompt  ",
        text: "Original prompt",
        contextPayload: [{
          target: { nodeId: 7, sourceInteractionNodeId: 3, sourceLayerId: 5 },
          annotations: ["Original context"],
        }],
      });
    expect(Object.isFrozen(snapshotted), "the snapshot is frozen").toBe(true);

    const confirmation = {
      draftId: "confirmation-a",
      target: { nodeId: 7, sourceInteractionNodeId: 3, sourceLayerId: 5 },
      annotation: "Original context",
    };
    const confirmedIntent = interactionSendIntent({
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
    const replayBase = {
      intent: confirmedIntent,
      threadId: "thread-a",
      draftScopeKey: "thread-a:turn-a",
      promptRevision: 4,
      contextRevision: 9,
      replayContextRevision: 9,
      modelSelection: confirmedIntent.modelSelection,
      inputDraftRevision: 3,
    };
    const replayCases = [
      ["matching authorities replay the exact intent", replayBase, confirmedIntent],
      ["a prompt revision change blocks replay", { ...replayBase, promptRevision: 5 }, null],
      ["a draft scope change blocks replay", { ...replayBase, draftScopeKey: "thread-a:turn-b" }, null],
      ["a context revision beyond the replayed one blocks replay", { ...replayBase, contextRevision: 10 }, null],
      ["a model selection change blocks replay", { ...replayBase, modelSelection: { providerId: "fixture", modelId: "other" } }, null],
      ["an input authority change blocks replay", { ...replayBase, inputDraftRevision: 4, inputCompositionRevision: 1 }, null],
    ];
    expect(replayCases, "confirmed replay authority inventory").toHaveLength(6);
    for (const [label, params, expected] of replayCases) {
      expect.soft(confirmationSendReplayIntent(params), label).toBe(expected);
    }

    const inputIntent = interactionSendIntent({
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
    const inputBase = {
      intent: inputIntent,
      threadId: "thread-a",
      draftScopeKey: "thread-a:turn-a",
      promptRevision: 2,
      contextRevision: 0,
      replayContextRevision: 0,
      modelSelection: inputIntent.modelSelection,
      inputDraftRevision: 7,
      inputCompositionRevision: 3,
    };
    expect.soft(confirmationSendReplayIntent(inputBase),
      "unchanged durable draft authority replays the input send").toBe(inputIntent);
    expect.soft(confirmationSendReplayIntent({ ...inputBase, inputDraftRevision: 8 }),
      "a post-commit draft revision blocks the replay").toBeNull();
    expect.soft(confirmationSendReplayIntent({ ...inputBase, inputDraftRevision: 9 }),
      "a post-detach draft revision blocks the replay").toBeNull();
    expect.soft(confirmationSendReplayIntent({ ...inputBase, inputCompositionRevision: 4 }),
      "a composition revision blocks the replay").toBeNull();

    expect.soft(confirmationSendFailureMayHaveCommitted(new Error("network lost")),
      "network loss may have committed").toBe(true);
    expect.soft(confirmationSendFailureMayHaveCommitted({ status: 503 }),
      "a 503 may have committed").toBe(true);
    expect.soft(confirmationSendFailureMayHaveCommitted({ status: 409 }),
      "a 409 did not commit").toBe(false);

    const clicked = interactionSendIntent({
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
      inputDraftRevision: 7,
      inputCompositionRevision: 3,
    });
    const current = interactionSendIntent({
      threadId: "thread-a",
      draftScopeKey: "thread-a:turn-a",
      promptValue: "Original prompt",
      promptRevision: 4,
      contexts: [],
      contextRevision: 9,
      modelSelection: clicked.modelSelection,
      inputDraftRevision: 10,
      inputCompositionRevision: 4,
    });
    expect(confirmationSendReplayIntentWithoutInputAuthority({
      intent: clicked,
      threadId: "thread-a",
      draftScopeKey: "thread-a:turn-a",
      promptRevision: 4,
      contextRevision: 9,
      replayContextRevision: 9,
      modelSelection: clicked.modelSelection,
    }), "unchanged prompt authority replays without input authority").toBe(clicked);
    expect(confirmationSendReplayIntentWithoutInputAuthority({
      intent: clicked,
      threadId: "thread-a",
      draftScopeKey: "thread-a:turn-a",
      promptRevision: 5,
      contextRevision: 9,
      replayContextRevision: 9,
      modelSelection: clicked.modelSelection,
    }), "a prompt revision change blocks the authority-less replay").toBeNull();
    expect(rebuildInteractionSendIntentAfterInputReconciliation({
      clickedIntent: clicked,
      currentIntent: current,
      inputDraftRevision: 10,
    }), "the response-loss retry rebuilds from the click-time snapshot and current authority")
      .toMatchObject({
        text: "Original prompt",
        contextPayload: [{
          target: confirmation.target,
          annotations: ["Original context"],
        }],
        contextConfirmationIds: [],
        modelSelection: clicked.modelSelection,
        inputDraftRevision: 10,
      });

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
    expect(replays.get("thread-b"),
      "one thread's discarded replay never clobbers another's preserved replay")
      .toEqual({ intent: intentB, contextRevision: 12 });
    replays = settleConfirmationSendReplay(replays, {
      threadId: "thread-a",
      intent: intentA,
      contextRevision: 7,
      preserve: true,
    });
    expect(replays.get("thread-b"), "cross-thread settlements stay isolated (b)")
      .toEqual({ intent: intentB, contextRevision: 12 });
    expect(replays.get("thread-a"), "cross-thread settlements stay isolated (a)")
      .toEqual({ intent: intentA, contextRevision: 7 });

    const target = { nodeId: 7, sourceInteractionNodeId: 3, sourceLayerId: 5 };
    const submitted = { draftId: "submitted", target, annotation: "Submitted note" };
    const remaining = { draftId: "remaining", target, annotation: "Other authoritative note" };
    const newerContexts = {
      revision: 9,
      value: [{
        target,
        annotations: [submitted.annotation, "Newer unsent note"],
        annotationConfirmations: [submitted, null],
      }],
    };
    expect(settledComposerContextsWithConfirmations(newerContexts, [remaining]),
      "submitted confirmations settle without discarding newer composer work").toEqual({
      revision: 9,
      value: [{
        target,
        node: undefined,
        annotations: ["Other authoritative note", "Newer unsent note"],
        annotationConfirmations: [remaining, null],
      }],
    });
  }, 10_000);

  it("scopes node-input mutation locks and send attempts to the owning thread", async () => {
    const inputPending = createInputMutationTracker();
    const stageKey = JSON.stringify(["thread-a", "41", "52", "63"]);
    const renderComposer = vi.fn();
    const repaintNodeInputs = vi.fn();

    beginNodeInputMutation({ inputPending, stageKey, renderComposer, repaintNodeInputs });
    expect(repaintNodeInputs, "detach start repaints node controls").toHaveBeenCalledOnce();
    expect(renderComposer, "detach start re-renders the composer").toHaveBeenCalledOnce();

    beginNodeInputMutation({ inputPending, stageKey, renderComposer, repaintNodeInputs });
    settleNodeInputCommit({
      inputPending,
      stageKey,
      originalSelection: { threadId: "thread-a", nodeId: 7, presentingInteractionNodeId: 41, presentingLayerId: 52 },
      currentSelection: () => ({ threadId: "thread-a", nodeId: 7, presentingInteractionNodeId: 41, presentingLayerId: 52 }),
      repaintNodeInputs: vi.fn(),
      renderComposer: vi.fn(),
    });
    expect(inputPending.has(stageKey), "an overlapping mutation keeps its lock after one settlement").toBe(true);
    expect(threadHasPendingInputMutation(inputPending, "thread-a"),
      "the owning thread reports the pending mutation").toBe(true);
    expect(inputPending.end(stageKey), "the final settlement releases the lock").toBe(false);
    expect(threadHasPendingInputMutation(inputPending, "thread-a"),
      "the owning thread clears after the final settlement").toBe(false);

    const original = {
      threadId: "thread-a",
      nodeId: 7,
      presentingInteractionNodeId: 41,
      presentingLayerId: 52,
    };
    const changes = [
      { threadId: "thread-b" },
      { nodeId: 8 },
      { presentingInteractionNodeId: 42 },
      { presentingLayerId: 53 },
    ];
    expect(changes, "selection-change corpus").toHaveLength(4);
    for (const change of changes) {
      let releaseCommit;
      const pendingCommit = new Promise((resolve) => { releaseCommit = resolve; });
      const pendingTracker = createInputMutationTracker();
      pendingTracker.begin("input-stage");
      const staleRepaint = vi.fn();
      const staleRender = vi.fn();
      let currentSelection = { ...original };
      const committing = pendingCommit.finally(() => settleNodeInputCommit({
        inputPending: pendingTracker,
        stageKey: "input-stage",
        originalSelection: original,
        currentSelection: () => currentSelection,
        repaintNodeInputs: staleRepaint,
        renderComposer: staleRender,
      }));

      currentSelection = { ...currentSelection, ...change };
      releaseCommit();
      await committing;

      expect(staleRepaint, `${JSON.stringify(change)} never repaints a stale selection occurrence`)
        .not.toHaveBeenCalled();
      expect(staleRender, `${JSON.stringify(change)} still re-renders the composer`)
        .toHaveBeenCalledOnce();
      expect(pendingTracker.has("input-stage"), `${JSON.stringify(change)} settles the pending mutation`)
        .toBe(false);
    }

    const unchangedRepaint = vi.fn();
    settleNodeInputCommit({
      inputPending: (() => {
        const pending = createInputMutationTracker();
        pending.begin("input-stage");
        return pending;
      })(),
      stageKey: "input-stage",
      originalSelection: original,
      currentSelection: () => ({ ...original }),
      repaintNodeInputs: unchangedRepaint,
      renderComposer: vi.fn(),
    });
    expect(unchangedRepaint, "an unchanged selection repaints node inputs").toHaveBeenCalledOnce();

    expect(sendIntentIsCurrentThread("thread-a", "thread-a"), "same-thread intents survive").toBe(true);
    expect(sendIntentIsCurrentThread("thread-b", "thread-a"), "thread switches drop pending intents").toBe(false);
    expect(sendIntentIsCurrentThread(null, "thread-a"), "missing threads drop pending intents").toBe(false);

    const cancelCases = [
      ["send attempt", null, "thread-a"],
      ["thread authority", "same", "thread-b"],
    ];
    expect(cancelCases, "held-persistence cancellation inventory").toHaveLength(2);
    for (const [boundary, nextAttempt, nextThreadId] of cancelCases) {
      const draft = {
        id: "draft-held",
        target: { nodeId: 7, sourceInteractionNodeId: 3, sourceLayerId: 5 },
        text: "Keep this exact pending annotation.",
        revision: 1,
      };
      const originalDraftIdentity = draft;
      let releasePersistence;
      const persistenceHeld = new Promise((resolve) => { releasePersistence = resolve; });
      const overrideController = {
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
        controller: overrideController,
        threadId: "thread-a",
        attempt,
        readCurrentThreadId: () => currentThreadId,
        readCurrentAttempt: () => currentAttempt,
        continueSend,
      });
      currentAttempt = nextAttempt === "same" ? attempt : nextAttempt;
      currentThreadId = nextThreadId;
      releasePersistence();

      await expect(settlement, `${boundary} change cancels Send without drafts`).resolves.toBe(false);
      expect(overrideController.persistAll, `${boundary} change still persists the drafts`)
        .toHaveBeenCalledWith("thread-a");
      expect(continueSend, `${boundary} change never continues the send`).not.toHaveBeenCalled();
      expect(draft, `${boundary} change keeps the draft identity`).toBe(originalDraftIdentity);
      expect(draft, `${boundary} change persists the exact draft text`).toEqual({
        id: "draft-held",
        target: { nodeId: 7, sourceInteractionNodeId: 3, sourceLayerId: 5 },
        text: "Keep this exact pending annotation.",
        revision: 2,
      });
    }

    expect(sendAttemptBlocksThread("thread-a", "thread-a"), "the owning attempt blocks its thread").toBe(true);
    expect(sendAttemptBlocksThread("thread-a", "thread-b"), "attempts never block other threads").toBe(false);
    expect(sendAttemptBlocksThread(null, "thread-a"), "released attempts block nothing").toBe(false);

    const workspaceSource = await readFile(new URL(
      "../desktop/renderer/src/product-workspace/workspace.js",
      import.meta.url,
    ), "utf8");
    const stagingStart = workspaceSource.indexOf("const contextStagingDisabled = () => {");
    const stagingEnd = workspaceSource.indexOf("const closeDurableEditor", stagingStart);
    const stagingSeam = workspaceSource.slice(stagingStart, stagingEnd);
    expect(stagingSeam, "staging disables per attempt-owning thread")
      .toContain("sendAttemptBlocksThread(sendAttempt?.threadId, getThread()?.id)");
    expect(stagingSeam, "staging disables per in-flight send thread")
      .toContain("threadHasInFlightSend(inFlightSendThreads, getThread()?.id)");
    expect(stagingSeam, "staging never blocks on any attempt globally")
      .not.toContain("Boolean(sendAttempt)");

    const composerStart = workspaceSource.indexOf("const syncComposer = () => {");
    const composerEnd = workspaceSource.indexOf("const releaseSendAttempt", composerStart);
    const composerSeam = workspaceSource.slice(composerStart, composerEnd);
    expect(composerSeam, "the composer gates on the owning thread's pending mutations")
      .toContain("threadHasPendingInputMutation(inputPending, getThread()?.id)");
    expect(composerSeam, "the composer never gates on global mutation size")
      .not.toContain("inputPending.size > 0");

    const attemptA1 = { threadId: "thread-a" };
    const inFlightThreadIds = new Map([["thread-a", attemptA1]]);
    expect(threadHasInFlightSend(inFlightThreadIds, "thread-a"),
      "the owning thread's in-flight lock holds across navigation").toBe(true);
    expect(threadHasInFlightSend(inFlightThreadIds, "thread-b"), "other threads are not locked").toBe(false);
    expect(sendAttemptBlocksThread(null, "thread-a"),
      "a released attempt pointer cannot clear the in-flight lock").toBe(false);
    expect(threadHasInFlightSend(inFlightThreadIds, "thread-a"),
      "the lock survives while another thread renders").toBe(true);
    expect(releaseInFlightSend(inFlightThreadIds, attemptA1), "the owning attempt releases its lock").toBe(true);
    expect(threadHasInFlightSend(inFlightThreadIds, "thread-a"), "the lock clears after release").toBe(false);

    const replacementA1 = { threadId: "thread-a" };
    const replacementA2 = { threadId: "thread-a" };
    const inFlightSends = new Map([["thread-a", replacementA1]]);
    expect(releaseInFlightSend(inFlightSends, replacementA1),
      "preflight cleanup releases its own lock").toBe(true);
    inFlightSends.set("thread-a", replacementA2);
    expect(releaseInFlightSend(inFlightSends, replacementA1),
      "cancelled preflight cleanup cannot release its replacement's lock").toBe(false);
    expect(inFlightSends.get("thread-a"), "the replacement lock stays registered").toBe(replacementA2);
    expect(threadHasInFlightSend(inFlightSends, "thread-a"), "the replacement thread stays locked").toBe(true);
  }, 10_000);

  it("projects, merges, and reprojects confirmation contexts without dropping newer local work", async () => {
    const target = { nodeId: 7, sourceInteractionNodeId: 3, sourceLayerId: 5 };
    const targetNode = { id: 7, title: "Queue" };
    const confirmations = [
      { draftId: "a", target, targetNode, annotation: "FIFO", draftRevision: 1 },
      { draftId: "b", target, targetNode, annotation: "Bounded", draftRevision: 2 },
    ];
    const contexts = composerContextsFromConfirmations(confirmations);
    expect(contexts, "durable confirmations group by target occurrence").toEqual([{
      target,
      node: targetNode,
      annotations: ["FIFO", "Bounded"],
      annotationConfirmations: confirmations,
    }]);
    expect(contextConfirmationIds(contexts), "confirmation identities ride in order").toEqual(["a", "b"]);

    const separate = composerContextsFromConfirmations([
      { draftId: "a", target, targetNode, annotation: "First" },
      {
        draftId: "b",
        target: { ...target, sourceInteractionNodeId: 9, sourceLayerId: 12 },
        targetNode,
        annotation: "Second",
      },
    ]);
    expect(separate, "repeated node IDs stay separate across source occurrences").toHaveLength(2);

    const ephemeral = [{
      target,
      node: targetNode,
      annotations: ["Newer"],
      annotationConfirmations: [null],
    }];
    const restoredConfirmation = { draftId: "a", target, targetNode, annotation: "Restored" };
    expect(composerContextsMergedWithConfirmations(ephemeral, [restoredConfirmation]),
      "late restored confirmations merge without clearing newer ephemeral work").toEqual([{
      target,
      node: targetNode,
      annotations: ["Restored", "Newer"],
      annotationConfirmations: [restoredConfirmation, null],
    }]);

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
    expect(composerConfirmationAuthorityChanged(current, [obsolete]),
      "unchanged authoritative confirmations change nothing").toBe(false);
    expect(composerConfirmationAuthorityChanged(current, []),
      "a consumed confirmation changes authority").toBe(true);
    expect(composerContextsMergedWithConfirmations(current, []),
      "consuming a confirmation keeps newer local notes").toEqual([{
      target,
      node: targetNode,
      annotations: ["Newer unsent note"],
      annotationConfirmations: [null],
    }]);

    const edited = { ...obsolete, annotation: "Authoritative edit", confirmationRevision: 2 };
    expect(composerConfirmationAuthorityChanged(current, [edited]),
      "an authoritative edit changes authority").toBe(true);
    expect(composerContextsMergedWithConfirmations(current, [edited]),
      "authoritative edits merge ahead of newer local notes").toEqual([{
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
    expect(load, "failed sends reload the thread confirmations").toHaveBeenCalledWith("thread-a");
    expect(refreshed, "failed sends reproject conflicts without dropping newer local work").toEqual({
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
    }), "offline reprojection surfaces the load failure").rejects.toThrow("offline");
  });

  it("binds, gates, and locks the durable node-details editor and restores selections", async () => {
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
    expect(editor, "durable drafts bind to the selected node-details editor identity").toMatchObject({
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
    expect(contextEditorIdentity(editor), "editor identity pins every discriminating field")
      .toBe(JSON.stringify([
        "thread-a",
        "draft-queue",
        String(targetNode.id),
        String(target.sourceInteractionNodeId),
        String(target.sourceLayerId),
        null,
        false,
        true,
      ]));
    expect(durableContextEditorForDraft("thread-a", { ...targetNode, id: 8 }, draft),
      "another node's selection binds no editor").toBeNull();

    const dockNode = { id: 7, title: "Queue" };
    const dockDraft = { id: "draft-queue", target, text: "Keep FIFO", status: "saved" };
    expect(nodeContextDraftForSelection(dockDraft, dockNode, target),
      "matching occurrences restore the dock draft").toBe(dockDraft);
    expect(nodeContextDraftForSelection(dockDraft, dockNode, { ...target, sourceLayerId: 6 }),
      "other source occurrences restore nothing").toBeNull();
    expect(nodeContextDraftForSelection(dockDraft, { ...dockNode, id: 8 }, target),
      "other nodes restore nothing").toBeNull();

    const saveDraft = { revision: null, status: "unsaved", text: "Before selection changes" };
    const saveController = {
      update: vi.fn((_threadId, _nodeId, value) => {
        saveDraft.text = value;
        return saveDraft;
      }),
      draftForNode: vi.fn(() => saveDraft),
      flush: vi.fn(async () => {
        expect(saveDraft.text, "the flush sees the pre-selection text").toBe("Before selection changes");
        saveDraft.revision = 1;
        saveDraft.status = "saved";
      }),
    };
    const saveEditor = {
      ownerThreadId: "thread-a",
      nodeId: 7,
      value: "Before selection changes",
      durable: true,
    };
    await expect(saveContextDraftBeforeSelection({
      controller: saveController,
      editor: saveEditor,
      textarea: { value: "Before selection changes", disabled: false },
    }), "selection transitions wait for the durable save").resolves.toBe(true);
    expect(saveController.flush, "the draft-save gate flushes exactly once").toHaveBeenCalledOnce();

    saveDraft.status = "error";
    saveDraft.revision = null;
    saveController.flush.mockImplementationOnce(async () => {});
    await expect(saveContextDraftBeforeSelection({ controller: saveController, editor: saveEditor, textarea: null }),
      "failed saves release the transition").resolves.toBe(false);
    expect(nodeContextDockError(saveEditor, { status: "error", error: "disk full" }),
      "dock errors name the failure").toBe("Not saved: disk full");

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
    expect(textarea.disabled, "durable saved editors lock the textarea").toBe(true);
    expect(controls, "durable saved editors lock both mounted controls").toEqual({
      remove: { disabled: true },
      confirm: { disabled: true },
    });

    const lockedEditor = { durable: true, value: "saved" };
    expect(applyMountedContextEditorInput({
      editor: lockedEditor,
      textarea,
      controller: { update: vi.fn(() => null) },
      threadId: 1,
      nodeId: 7,
    }), "racing input events are rejected on locked editors").toBe(false);
    expect(textarea.value, "locked editors restore the saved value").toBe("saved");
    expect(lockedEditor.value, "locked editors keep their saved value").toBe("saved");

    const confirmCases = [
      ["ephemeral attach editors confirm while empty", { attaching: true, durable: false, value: "" }, true],
      ["empty durable attach editors stay disabled across reconciliation", { attaching: true, durable: true, value: "" }, false],
      ["durable attach editors confirm once text exists", { attaching: true, durable: true, value: "note" }, true],
    ];
    expect(confirmCases, "confirm-gate inventory").toHaveLength(3);
    for (const [label, editorState, expected] of confirmCases) {
      expect.soft(contextEditorCanConfirm(editorState), label).toBe(expected);
    }

    const selectedTarget = { nodeId: 7, sourceInteractionNodeId: 31, sourceLayerId: 41 };
    expect(interactionContextTargetForEditor({
      nodeId: 7,
      selectedContextTarget: selectedTarget,
      sourceInteractionNodeId: 99,
      sourceLayerId: 100,
    }), "opening editors pin the captured selection occurrence").toBe(selectedTarget);
    const existingTarget = { nodeId: 7, sourceInteractionNodeId: 11, sourceLayerId: 12 };
    expect(interactionContextTargetForEditor({
      nodeId: 7,
      contextTarget: existingTarget,
      selectedContextTarget: selectedTarget,
      sourceInteractionNodeId: 99,
      sourceLayerId: 100,
    }), "open editors keep their existing occurrence").toBe(existingTarget);
    expect(interactionContextTargetForEditor({
      nodeId: 7,
      sourceInteractionNodeId: 21,
      sourceLayerId: 22,
    }), "editors without a captured occurrence use their own").toEqual({
      nodeId: 7,
      sourceInteractionNodeId: 21,
      sourceLayerId: 22,
    });

    const historical = { id: 7, title: "Historical target" };
    const overrides = new Map([["7", historical]]);
    expect(resolveInteractionContextNode(7, [], [], overrides),
      "historical overrides resolve the context node").toBe(historical);
    const attachedNode = { id: 8, title: "Attached draft" };
    expect(resolveInteractionContextNode(8, [], [{
      target: { nodeId: 8 },
      node: attachedNode,
    }], overrides), "attached drafts resolve their own node").toBe(attachedNode);
    expect(hasHistoricalContextSelection(7, { nodeId: 7 }, overrides),
      "historical selections are recognized").toBe(true);
    expect(hasHistoricalContextSelection(7, null, overrides),
      "missing selections are not historical").toBe(false);
    expect(hasHistoricalContextSelection(8, { nodeId: 8 }, overrides),
      "non-historical nodes are not historical selections").toBe(false);
    expect(graphRenderClearsSelection({
      hasResponseNodes: false,
      enteringView: true,
      nodeInGraph: false,
      preserveHistoricalSelection: true,
    }), "historical selections survive graph renders").toBe(false);
    expect(graphRenderClearsSelection({
      hasResponseNodes: false,
      enteringView: true,
      nodeInGraph: false,
      preserveHistoricalSelection: false,
    }), "plain missing nodes clear on render").toBe(true);
    const origin = { id: "context-node" };
    expect(historicalContextSelectionOptions({ nodeId: 7 }, origin),
      "reopening historical selections focuses the inspector silently").toEqual({
      notify: false,
      userInitiated: true,
      focusInspector: true,
      contextTarget: { nodeId: 7 },
      origin,
    });

    const waiting = composerFocusRestoration(null, {
      activeWasInside: true,
      dockThreadId: "10",
      threadId: "10",
      canCompose: true,
      promptDisabled: true,
    });
    expect(waiting, "same-thread composer focus waits while completion runs")
      .toEqual({ pendingThreadId: "10", shouldFocus: false });
    expect(composerFocusRestoration(waiting.pendingThreadId, {
      activeWasInside: false,
      dockThreadId: "10",
      threadId: "10",
      canCompose: true,
      promptDisabled: false,
    }), "focus restores once completion stops running")
      .toEqual({ pendingThreadId: null, shouldFocus: true });
    expect(composerFocusRestoration("10", {
      activeWasInside: false,
      dockThreadId: "10",
      threadId: "11",
      canCompose: true,
      promptDisabled: false,
    }), "focus never chases another thread").toEqual({ pendingThreadId: null, shouldFocus: false });
  });

  it("stages node-context annotations through the composer gate in exact order", () => {
    expect(contextStagingDisabledFor("running", true, false), "running composers disable staging").toBe(true);
    expect(contextStagingDisabledFor("accepted", true, true), "in-flight accepted composers disable staging").toBe(true);
    expect(contextStagingDisabledFor("failed", true, false), "failed composers keep staging enabled").toBe(false);
    expect(contextEditorPresentation({ attaching: true, value: "" }, true),
      "disabled composers lock the editor presentation").toEqual({
      textareaDisabled: true,
      controlsDisabled: true,
      confirmDisabled: true,
    });
    expect(contextEditorPresentation({ attaching: true, value: "" }, false),
      "available composers unlock the editor presentation").toEqual({
      textareaDisabled: false,
      controlsDisabled: false,
      confirmDisabled: false,
    });
    expect(contextEditorPresentation({ attaching: false, value: "note" }, false, true),
      "locked mounted editors present fully disabled").toEqual({
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
    }, { id: 10 }), "the thread's live interaction owns the composer status").toBe("running");

    expect(contextConfirmationDestination("thread-b", "thread-a"),
      "confirmations resolving after a thread switch defer").toBe("deferred");
    expect(contextConfirmationDestination("thread-a", "thread-a"),
      "confirmations resolving in-thread land current").toBe("current");

    const node = { id: 3, title: "Context" };
    const target = { nodeId: 3, sourceInteractionNodeId: 2, sourceLayerId: 1 };
    const attaching = { attaching: true, annotationIndex: null, value: "" };
    expect(contextEditorCanConfirm(attaching), "unannotated attaches can confirm").toBe(true);
    const attached = applyContextEditor([], attaching, node, target);
    expect(attached, "attach creates an empty context entry").toEqual([{
      target,
      node,
      annotations: [],
      annotationConfirmations: [],
    }]);
    expect(composerSubmissionReady("", false, true, attached), "empty attaches cannot send").toBe(false);

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
    expect(second[0].annotations, "annotations keep their authored order, trimmed")
      .toEqual(["first", "second"]);
    const edited = applyContextEditor(second, {
      attaching: false,
      annotationIndex: 0,
      value: "revised",
    }, node, target);
    expect(edited[0].annotations, "edits replace the indexed annotation in place")
      .toEqual(["revised", "second"]);
    expect(contextEditorCanConfirm({ attaching: false, annotationIndex: null, value: "  " }),
      "blank annotations cannot confirm").toBe(false);
    expect(contextDetachNeedsConfirmation(edited[0]),
      "annotated contexts need confirmation to detach").toBe(true);
    const afterFirstDelete = removeContextAnnotation(edited, target, 0);
    const afterLastDelete = removeContextAnnotation(afterFirstDelete, target, 0);
    expect(afterLastDelete, "deleting the last annotation keeps the attached context").toHaveLength(1);
    expect(afterLastDelete[0].annotations, "all annotations are gone").toEqual([]);
    expect(contextDetachNeedsConfirmation(afterLastDelete[0]),
      "annotation-free contexts detach silently").toBe(false);

    const repeatedNode = { id: 3, title: "Repeated context" };
    const firstTarget = { nodeId: 3, sourceInteractionNodeId: 2, sourceLayerId: 1 };
    const secondTarget = { nodeId: 3, sourceInteractionNodeId: 8, sourceLayerId: 9 };
    const firstOccurrence = applyContextEditor([], {
      attaching: false,
      annotationIndex: null,
      value: "first occurrence",
    }, repeatedNode, firstTarget);
    const bothOccurrences = applyContextEditor(firstOccurrence, {
      attaching: false,
      annotationIndex: null,
      value: "second occurrence",
    }, repeatedNode, secondTarget);
    const editedOccurrence = applyContextEditor(bothOccurrences, {
      attaching: false,
      annotationIndex: 0,
      value: "edited second occurrence",
    }, repeatedNode, secondTarget);
    expect(editedOccurrence.map((context) => context.annotations),
      "edits hit only the exact repeated occurrence").toEqual([
      ["first occurrence"],
      ["edited second occurrence"],
    ]);
    const removedOccurrence = removeContextAnnotation(editedOccurrence, secondTarget, 0);
    expect(removedOccurrence.map((context) => context.annotations),
      "deletes hit only the exact repeated occurrence").toEqual([
      ["first occurrence"],
      [],
    ]);

    const confirmation = { draftId: "confirmed-a" };
    const confirmedContexts = [{
      target,
      node,
      annotations: ["stale text"],
      annotationConfirmations: [confirmation],
    }];
    expect(applyContextEditor(confirmedContexts, {
      attaching: false,
      annotationIndex: 0,
      value: "new local text",
      confirmation: null,
    }, node, target), "edits preserve text while clearing remotely consumed confirmation identities")
      .toEqual([{
        target,
        node,
        annotations: ["new local text"],
        annotationConfirmations: [null],
      }]);

    expect(contextAnnotationCountLabel(0), "zero counts stay plural-stable").toBe("0 annotations");
    expect(contextAnnotationCountLabel(1), "single counts are singular").toBe("1 annotation");
    expect(contextAnnotationCountLabel(7), "larger counts stay plural").toBe("7 annotations");

    const stagedContexts = [{
      target: { nodeId: 3, sourceInteractionNodeId: 2, sourceLayerId: 1 },
      annotations: ["  note  "],
      node: { id: 3, title: "Context" },
    }];
    expect(contextDraftHasAnnotation(stagedContexts), "trimmed annotations count as draft work").toBe(true);
    expect(interactionContextPayload(stagedContexts), "the send payload trims annotation whitespace")
      .toEqual([{
        target: { nodeId: 3, sourceInteractionNodeId: 2, sourceLayerId: 1 },
        annotations: ["note"],
      }]);
  });

  it("maps composer and graph keyboard intents and submits only ready payloads", async () => {
    const graphCases = [
      ["plain ArrowLeft steps back while the graph owns focus", { key: "ArrowLeft" }, true, -1],
      ["plain ArrowRight steps forward while the graph owns focus", { key: "ArrowRight" }, true, 1],
      ["arrows do nothing off focus", { key: "ArrowLeft" }, false, null],
      ["shifted arrows do not navigate", { key: "ArrowRight", shiftKey: true }, true, null],
      ["meta arrows do not navigate", { key: "ArrowRight", metaKey: true }, true, null],
      ["ctrl arrows do not navigate", { key: "ArrowLeft", ctrlKey: true }, true, null],
      ["alt arrows do not navigate", { key: "ArrowLeft", altKey: true }, true, null],
      ["Enter never navigates turns", { key: "Enter" }, true, null],
    ];
    expect(graphCases, "graph turn navigation inventory").toHaveLength(8);
    for (const [label, event, ownsFocus, expected] of graphCases) {
      expect.soft(graphTurnNavigationDelta(event, ownsFocus), label).toBe(expected);
    }

    const composerCases = [
      ["plain Enter submits", { key: "Enter" }, "submit"],
      ["Shift+Enter keeps the newline", { key: "Enter", shiftKey: true }, "newline"],
      ["meta Enter submits", { key: "Enter", metaKey: true }, "submit"],
      ["ctrl Enter submits", { key: "Enter", ctrlKey: true }, "submit"],
      ["held Enter repeats without resubmitting", { key: "Enter", repeat: true }, "repeat"],
      ["IME composition swallows Enter", { key: "Enter", isComposing: true }, "composing"],
      ["keyCode 229 swallows Enter", { key: "Enter", keyCode: 229 }, "composing"],
      ["other keys are ignored", { key: "a" }, null],
    ];
    expect(composerCases, "composer keydown intent inventory").toHaveLength(8);
    for (const [label, event, expected] of composerCases) {
      expect.soft(composerKeydownIntent(event), label).toBe(expected);
    }

    let submitted = 0;
    const plainEnter = { key: "Enter", preventDefault: () => { plainEnter.prevented = true; } };
    expect(handleComposerKeydown(plainEnter, () => { submitted += 1; }),
      "plain Enter handles as submit").toBe("submit");
    expect(plainEnter.prevented, "submitting Enter prevents the default").toBe(true);
    expect(submitted, "the send action runs once").toBe(1);

    const shiftedEnter = { key: "Enter", shiftKey: true, preventDefault: () => {} };
    expect(handleComposerKeydown(shiftedEnter, () => { submitted += 1; }),
      "Shift+Enter handles as newline").toBe("newline");
    expect(submitted, "newlines never submit").toBe(1);

    const textarea = {};
    const send = { click: vi.fn() };
    bindComposerKeydown(textarea, () => send.click());

    const boundShifted = { key: "Enter", shiftKey: true, preventDefault: vi.fn() };
    textarea.onkeydown(boundShifted);
    expect(boundShifted.preventDefault, "bound Shift+Enter is not prevented").not.toHaveBeenCalled();
    expect(send.click, "bound Shift+Enter does not click send").not.toHaveBeenCalled();

    const boundPlain = { key: "Enter", preventDefault: vi.fn() };
    textarea.onkeydown(boundPlain);
    expect(boundPlain.preventDefault, "bound plain Enter is prevented").toHaveBeenCalledOnce();
    expect(send.click, "bound plain Enter clicks send").toHaveBeenCalledOnce();

    const annotatedContexts = [{
      target: { nodeId: 3, sourceInteractionNodeId: 2, sourceLayerId: 1 },
      annotations: ["  note  "],
      node: { id: 3, title: "Context" },
    }];
    const emptyAnnotationContext = { ...annotatedContexts[0], annotations: [] };
    const submissionCases = [
      ["non-empty prompts are ready", ["Ask a follow-up"], true],
      ["whitespace-only prompts are not ready", ["  \n "], false],
      ["disabled composers are not ready", ["Ask a follow-up", true], false],
      ["annotated contexts send without prompt text", ["", false, true, annotatedContexts], true],
      ["annotation-free contexts cannot carry an empty prompt", ["", false, true, [emptyAnnotationContext]], false],
      ["in-flight sends block ready payloads", ["message", false, true, annotatedContexts, true], false],
      ["committed node inputs send without prompt text", ["", false, true, [], false, [{ id: "input" }]], true],
      ["empty payloads without node inputs are not ready", ["", false, true, [], false, []], false],
      ["disabled composers block node-input payloads", ["", true, true, [], false, [{ id: "input" }]], false],
    ];
    expect(submissionCases, "submission readiness inventory").toHaveLength(9);
    for (const [label, args, expected] of submissionCases) {
      expect.soft(composerSubmissionReady(...args), label).toBe(expected);
    }

    const disabledCases = [
      ["running composers disable", ["running"], true],
      ["composable not-started composers enable", ["not_started", true, true], false],
      ["approval-waiting composers disable", ["waiting_for_approval"], true],
      ["accepted composers enable", ["accepted"], false],
      ["accepted composers without compose capability disable", ["accepted", false], true],
    ];
    expect(disabledCases, "composer state gating inventory").toHaveLength(5);
    for (const [label, args, expected] of disabledCases) {
      expect.soft(composerDisabledForState(...args), label).toBe(expected);
    }

    const element = () => ({ classList: { toggle: vi.fn() } });
    const composer = element();
    const prompt = element();
    const sendButton = element();
    const readOnlyMessage = element();
    applyComposerCapabilities({ composer, prompt, send: sendButton, readOnlyMessage }, false);
    expect(composer.classList.toggle, "disabled composers mark the composer shell")
      .toHaveBeenCalledWith("disabled-composer", true);
    expect(prompt.classList.toggle, "disabled composers hide the prompt")
      .toHaveBeenCalledWith("hidden", true);
    expect(sendButton.classList.toggle, "disabled composers hide send")
      .toHaveBeenCalledWith("hidden", true);
    expect(readOnlyMessage.classList.toggle, "disabled composers show the read-only message")
      .toHaveBeenCalledWith("hidden", false);
    expect(productWorkspaceMarkup(), "the retry message element stays mounted")
      .toContain('id="composerRetryMessage"');
    expect(productWorkspaceMarkup(), "the read-only message element stays mounted")
      .toContain('id="readOnlyComposerMessage"');

    expect(productWorkspaceMarkup(), "the composer starts as one line")
      .toContain('id="threadPrompt" rows="1"');
    const resizable = { scrollHeight: 84, style: {} };
    resizeComposerTextarea(resizable);
    expect(resizable.style, "short composers hide overflow").toMatchObject({
      height: "84px",
      overflowY: "hidden",
    });
    resizable.scrollHeight = COMPOSER_MAX_HEIGHT + 40;
    resizeComposerTextarea(resizable);
    expect(resizable.style, "oversized composers cap and enable scrolling").toMatchObject({
      height: `${COMPOSER_MAX_HEIGHT}px`,
      overflowY: "auto",
    });
    resizable.scrollHeight = 0;
    resizeComposerTextarea(resizable);
    expect(resizable.style.height, "empty composers collapse to the minimum")
      .toBe(`${COMPOSER_MIN_HEIGHT}px`);

    const styles = await readFile(new URL("../desktop/renderer/styles.css", import.meta.url), "utf8");
    expect(styles, "composer textarea CSS pins the grow band")
      .toContain(".thread-composer textarea{flex:1;height:42px;min-height:42px;max-height:126px;resize:none;overflow-y:hidden");
    expect(styles, "no manual vertical resize")
      .not.toContain(".thread-composer textarea{flex:1;min-height:42px;max-height:126px;resize:vertical");

    expect(productWorkspaceMarkup(), "the graph stage is pointer-focusable")
      .toContain('id="graphStage" tabindex="-1"');
    expect(productWorkspaceMarkup(), "the graph stage stays out of the tab order")
      .not.toContain('id="graphStage" tabindex="0"');
  });

  it("scopes, restores, and clears composer drafts across thread and interaction transitions", () => {
    let state = createComposerDraftScopeState();
    let transition = transitionComposerDraftScope(state, {
      threadId: "thread-a",
      interactionId: "interaction-a",
      currentPromptValue: "",
      restoredDraft: { text: "retry A" },
    });
    state = transition.state;
    expect(transition.promptValue, "restored drafts surface in their own scope").toBe("retry A");
    expect(state.drafts.get(composerDraftScopeKey("thread-a", "interaction-a")),
      "the restoration records its interaction")
      .toMatchObject({ restoredDraftInteractionId: "interaction-a" });

    transition = transitionComposerDraftScope(state, {
      threadId: "thread-b",
      interactionId: "interaction-b",
      currentPromptValue: "edited retry A",
      currentPromptRevision: transition.promptRevision + 1,
    });
    state = transition.state;
    expect(transition.promptValue, "fresh scopes start empty").toBe("");
    expect(state.drafts.get(composerDraftScopeKey("thread-b", "interaction-b")),
      "new scopes carry no restoration")
      .toMatchObject({ promptValue: "", restoredDraftInteractionId: null });

    transition = transitionComposerDraftScope(state, {
      threadId: "thread-a",
      interactionId: "interaction-a",
      currentPromptValue: "draft B",
      currentPromptRevision: transition.promptRevision + 1,
      restoredDraft: { text: "retry A" },
    });
    state = transition.state;
    expect(transition.promptValue, "returning restores the user's latest text over the stale draft")
      .toBe("edited retry A");
    expect(state.drafts.get(composerDraftScopeKey("thread-b", "interaction-b")),
      "departing scopes keep the text typed there")
      .toMatchObject({ promptValue: "draft B", restoredDraftInteractionId: null });

    const rerenderSeed = transitionComposerDraftScope(createComposerDraftScopeState(), {
      threadId: 10,
      interactionId: 100,
      currentPromptValue: "",
      currentPromptRevision: 0,
    });
    const rerendered = transitionComposerDraftScope(rerenderSeed.state, {
      threadId: 10,
      interactionId: 100,
      currentPromptValue: "same text retyped",
      currentPromptRevision: rerenderSeed.promptRevision + 1,
    });
    expect(rerendered.promptRevision, "unrelated rerenders keep the newer prompt revision")
      .toBe(rerenderSeed.promptRevision + 1);
    expect(rerendered.state.drafts.get(rerendered.state.activeScopeKey),
      "retyped text rides with the newer revision")
      .toMatchObject({ promptValue: "same text retyped", promptRevision: rerendered.promptRevision });

    let sentTransition = transitionComposerDraftScope(createComposerDraftScopeState(), {
      threadId: "thread-a",
      interactionId: "interaction-a",
      currentPromptValue: "",
      restoredDraft: { text: "retry A" },
    });
    const submittedScopeKey = sentTransition.state.activeScopeKey;
    const submittedPromptRevision = sentTransition.promptRevision;
    sentTransition = transitionComposerDraftScope(sentTransition.state, {
      threadId: "thread-b",
      interactionId: "interaction-b",
      currentPromptValue: "retry A",
      currentPromptRevision: submittedPromptRevision,
    });
    const cleared = clearSubmittedComposerDraft(
      sentTransition.state,
      submittedScopeKey,
      submittedPromptRevision,
      sentTransition.promptRevision,
    );
    sentTransition = transitionComposerDraftScope(cleared, {
      threadId: "thread-a",
      interactionId: "interaction-a",
      currentPromptValue: "draft B",
      currentPromptRevision: sentTransition.promptRevision + 1,
    });
    expect(sentTransition.promptValue, "durably sent inactive drafts never resurrect").toBe("");

    const editedAgain = transitionComposerDraftScope(sentTransition.state, {
      threadId: "thread-a",
      interactionId: "interaction-a",
      currentPromptValue: "",
      restoredDraft: { text: "retry A again" },
    });
    const preserved = clearSubmittedComposerDraft(
      editedAgain.state,
      editedAgain.state.activeScopeKey,
      editedAgain.promptRevision,
      editedAgain.promptRevision + 1,
    );
    expect(preserved.drafts.get(editedAgain.state.activeScopeKey).promptValue,
      "new edits after a clear are preserved").toBe("retry A again");

    let leakTransition = transitionComposerDraftScope(createComposerDraftScopeState(), {
      threadId: 10,
      interactionId: 100,
      currentPromptValue: "",
      restoredDraft: { text: "stale A" },
    });
    expect(leakTransition.promptValue, "restorations surface in their own interaction").toBe("stale A");
    leakTransition = transitionComposerDraftScope(leakTransition.state, {
      threadId: 11,
      interactionId: 200,
      currentPromptValue: leakTransition.promptValue,
    });
    expect(leakTransition.promptValue, "another interaction never sends a restored prompt").toBe("");
    expect(composerSubmissionReady(leakTransition.promptValue, false, true),
      "the leaked prompt is not sendable").toBe(false);
    leakTransition = transitionComposerDraftScope(leakTransition.state, {
      threadId: 11,
      interactionId: 200,
      currentPromptValue: "send B",
    });
    expect(leakTransition.promptValue, "freshly typed text sends normally").toBe("send B");
    expect(composerSubmissionReady(leakTransition.promptValue, false, true),
      "typed text is sendable").toBe(true);

    let interactionChange = transitionComposerDraftScope(createComposerDraftScopeState(), {
      threadId: 10,
      interactionId: 100,
      currentPromptValue: "",
      restoredDraft: { text: "retry interaction 100" },
    });
    interactionChange = transitionComposerDraftScope(interactionChange.state, {
      threadId: 10,
      interactionId: 101,
      currentPromptValue: interactionChange.promptValue,
    });
    expect(interactionChange.promptValue,
      "newer interactions in the same thread clear the restored draft").toBe("");
    expect(interactionChange.state.drafts.get(composerDraftScopeKey(10, 101)),
      "the newer interaction records no restoration")
      .toMatchObject({ promptValue: "", restoredDraftInteractionId: null });

    let lateRestore = transitionComposerDraftScope(createComposerDraftScopeState(), {
      threadId: 10,
      interactionId: 100,
      currentPromptValue: "",
    });
    expect(lateRestore.promptValue, "running interactions render empty without drafts").toBe("");
    lateRestore = transitionComposerDraftScope(lateRestore.state, {
      threadId: 10,
      interactionId: 100,
      currentPromptValue: "",
      restoredDraft: { text: "retry after model failure" },
    });
    expect(lateRestore.promptValue, "model-failed restorations apply after the running render")
      .toBe("retry after model failure");
    expect(lateRestore.state.drafts.get(composerDraftScopeKey(10, 100)),
      "late restorations record their interaction")
      .toMatchObject({
        promptValue: "retry after model failure",
        restoredDraftInteractionId: 100,
      });
    lateRestore = transitionComposerDraftScope(lateRestore.state, {
      threadId: 10,
      interactionId: 100,
      currentPromptValue: "user edited the restored prompt",
      restoredDraft: { text: "stale server retry text" },
    });
    expect(lateRestore.promptValue, "user edits beat stale server restorations")
      .toBe("user edited the restored prompt");
    expect(lateRestore.state.drafts.get(composerDraftScopeKey(10, 100)),
      "the user's edited text is retained")
      .toMatchObject({
        promptValue: "user edited the restored prompt",
        restoredDraftInteractionId: 100,
      });

    const tombstone = transitionComposerDraftScope(createComposerDraftScopeState(), {
      threadId: 10,
      interactionId: 100,
      currentPromptValue: "",
      restoredDraft: { text: "do not resurrect this failed prompt" },
      persistedDraftText: "",
    });
    expect(tombstone.promptValue, "explicit empty follow-up tombstones beat failed restorations").toBe("");
    expect(tombstone.state.drafts.get(composerDraftScopeKey(10, 100)),
      "the tombstone records its interaction")
      .toMatchObject({ promptValue: "", restoredDraftInteractionId: 100 });
  });

  it("pins the workspace layout, draft-save gate, and warning modal contracts", async () => {
    const [styles, workspaceSource, graphSource, mainSource] = await Promise.all([
      readFile(new URL("../desktop/renderer/styles.css", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/src/product-workspace/workspace.js", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/src/graph.js", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/src/main.js", import.meta.url), "utf8"),
    ]);
    const markup = productWorkspaceMarkup();

    const exact = `First line\n${"x".repeat(160)}`;
    const presentation = submittedInputHistoryPresentation({
      action: { prompt: "Deployment rationale" },
      value: { text: exact },
    });
    expect(presentation, "submitted history discloses the exact full value accessibly").toMatchObject({
      kind: "disclosure",
      fullValue: exact,
      ariaLabel: "Show full submitted value for Deployment rationale",
    });
    expect([...presentation.compactValue], "compact history truncates at eighty code points").toHaveLength(80);
    expect(presentation.compactValue.endsWith("…"), "compact history ends with the ellipsis").toBe(true);

    let iteratedCodePoints = 0;
    const boundedSource = {
      *[Symbol.iterator]() {
        while (true) {
          iteratedCodePoints += 1;
          if (iteratedCodePoints > 81) {
            throw new Error("compact history consumed beyond its bounded prefix");
          }
          yield iteratedCodePoints <= 79 ? "😀" : iteratedCodePoints === 80 ? "Z" : "x";
        }
      },
    };
    expect(compactSubmittedText(boundedSource), "compaction iterates only the bounded prefix")
      .toBe(`${"😀".repeat(79)}…`);
    expect(iteratedCodePoints, "compaction stops at its lookahead boundary").toBe(81);

    const huge = `${"😀".repeat(79)}Z${"x".repeat(4 * 1024 * 1024)}`;
    expect(submittedInputHistoryPresentation({
      action: { prompt: "Large rationale" },
      value: { text: huge },
    }), "huge values compact without copying the tail").toMatchObject({
      kind: "disclosure",
      compactValue: `${"😀".repeat(79)}…`,
      fullValue: huge,
    });
    expect(submittedInputHistoryPresentation({
      action: { prompt: "Release channel" },
      value: { selected: [{ key: "preview", label: "Preview" }] },
    }), "choice values present plain").toEqual({ kind: "plain", compactValue: "Preview" });
    expect(styles, "the disclosure summary truncates with an ellipsis")
      .toContain(".interaction-input-history-disclosure>summary{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap");
    expect(styles, "the disclosure body scrolls")
      .toContain(".interaction-input-history-disclosure>p{max-width:240px;max-height:160px;overflow:auto;white-space:pre-wrap");

    const detailContent = markup.indexOf('id="inspectorContent"');
    const dock = markup.indexOf('id="nodeContextDock"');
    const evaluationPanel = markup.indexOf('id="annotationPanel"');
    const composerTray = markup.slice(
      markup.indexOf('id="composerContextTray"'),
      markup.indexOf('id="threadComposer"'),
    );
    expect(detailContent, "the inspector content anchor exists").toBeGreaterThan(-1);
    expect(markup, "review capture pins the inspector content")
      .toContain('id="inspectorContent" data-review-capture="node-detail"');
    expect(markup, "no retired inspector capture id")
      .not.toContain('id="inspector" data-review-capture="node-detail"');
    expect(detailContent, "the annotation dock sits below the detail content").toBeLessThan(dock);
    expect(dock, "the annotation dock sits above the evaluation panel").toBeLessThan(evaluationPanel);
    expect(markup, "the annotation editor is accessibly labelled")
      .toContain('aria-label="Node context annotation editor"');
    expect(composerTray, "the composer tray never mounts the annotation editor")
      .not.toContain("contextAnnotationEditor");
    expect(styles, "the dock reserves a third of the inspector")
      .toContain(".node-context-dock{height:33.333%;min-height:0");
    expect(styles, "the hidden dock keeps its space invisibly")
      .toContain(".inspector-content{min-height:0}.inspector>.node-context-dock.hidden{display:flex!important;visibility:hidden;pointer-events:none;border-top-color:transparent}");
    expect(styles, "the dock clears the account corner")
      .toContain(".app-shell:has(.desktop-account-corner-control:not(.hidden)) .node-context-dock-actions{padding-right:112px}");
    expect(styles, "the dock textarea flexes")
      .toContain(".node-context-dock textarea{min-height:0;flex:1;resize:none;overflow:auto");
    expect(styles, "the dock honors forced colors").toContain("@media(forced-colors:active){.node-context-dock");
    expect(styles, "the dock honors reduced motion").toContain("@media(prefers-reduced-motion:reduce){.node-context-dock *");

    const seam = (start, end) => workspaceSource.slice(
      workspaceSource.indexOf(start),
      workspaceSource.indexOf(end, workspaceSource.indexOf(start)),
    );
    const gateSeams = [
      ["close", seam("const closeInspector = async", "const closeInspectorOnEscape")],
      ["history", seam("const navigateHistory = async", '$("#historyBack")')],
      ["previous turn", seam('$("#previousTurn").onclick', '$("#nextTurn").onclick')],
      ["next turn", seam('$("#nextTurn").onclick', "const openTurnPopover")],
      ["graph keyboard", seam("graphStage.onkeydown", "graphStage.onpointerdown")],
      ["turn picker", seam("row.onclick = async", "list.append(row)")],
      ["breadcrumb", seam("segment.onclick = async", "children.push(segment)")],
      ["breadcrumb annotation", seam("badge.onclick = async", "children.push(badge)")],
      ["navigational action", seam("if (activation.navigational)", "button.disabled = true")],
    ];
    expect(gateSeams, "draft-save gate seam inventory").toHaveLength(9);
    for (const [label, seamSource] of gateSeams) {
      expect(seamSource, `${label} routes through the draft-save gate`)
        .toContain("prepareNodeContextSelectionChange()");
    }
    expect(workspaceSource, "the workspace exposes the gate as prepareSelectionChange")
      .toContain("prepareSelectionChange: prepareNodeContextSelectionChange");
    expect(graphSource, "the graph calls the workspace gate")
      .toContain("productWorkspace?.prepareSelectionChange()");
    expect(mainSource.match(/prepareCurrentWorkspaceTransition\(\)/g),
      "every shell transition runs the gate").toHaveLength(4);

    const drafts = Array.from({ length: 12 }, (_, index) => ({
      id: `draft-${index}`,
      targetNode: { title: index === 11 ? "" : `Node ${index}` },
    }));
    const warning = contextDraftSendWarningPresentation(drafts);
    expect(warning.countLabel, "the warning counts every unconfirmed draft").toBe("12 unconfirmed drafts");
    expect(warning.items, "the warning lists every draft").toHaveLength(12);
    expect(warning.items[0], "draft items keep stable identity").toEqual({ id: "draft-0", title: "Node 0" });
    expect(warning.items[11], "untitled nodes get a stable fallback title")
      .toEqual({ id: "draft-11", title: "Untitled node" });
    expect(contextDraftSendWarningPresentation([drafts[0]]).countLabel,
      "singular counts stay grammatical").toBe("1 unconfirmed draft");

    const modal = markup.slice(
      markup.indexOf('id="contextDraftSendWarning"'),
      markup.indexOf("</dialog>") + "</dialog>".length,
    );
    expect(modal, "the warning is a modal dialog").toContain('role="dialog" aria-modal="true"');
    expect(modal, "the dialog itself stays out of tab order").toContain('tabindex="-1"');
    expect(modal, "the draft list is focusable").toContain('data-context-draft-warning-list tabindex="0"');
    expect(modal.match(/<button/g), "the warning offers exactly two choices").toHaveLength(2);
    expect(modal, "the retreat choice reads Go back").toContain(">Go back</button>");
    expect(modal, "the override choice reads Send without drafts").toContain(">Send without drafts</button>");

    expect(workspaceSource, "no inline editor is mounted for confirmed previews")
      .not.toContain("composer-context-inline-editor");
    expect(workspaceSource, "confirmed preview deletion stays available")
      .toContain("Delete annotation ${index + 1} for ${openContext.node.title}");
    expect(styles, "confirmed previews render as non-wrapping pills")
      .toContain(".composer-context-pills{display:flex;flex-wrap:nowrap;gap:7px;overflow-x:auto");

    expect(markup, "the composer tray is accessibly labelled")
      .toContain('id="composerContextTray" aria-label="Composer attachments"');
    expect(markup, "the attach control exists").toContain('id="attachNodeContext"');
    expect(markup, "the attach control uses the plus symbol")
      .toContain('aria-label="Connect node to next message">+</button>');
    expect(markup, "the context pill template exists").toContain('id="interactionContextPill"');
    expect(markup.indexOf('id="interactionContextPill"'), "the pill precedes the turn picker")
      .toBeLessThan(markup.indexOf('id="turnPickerButton"'));

    expect(markup.indexOf('id="graphStage"'), "the approval dock sits below the graph")
      .toBeLessThan(markup.indexOf('id="approvalDock"'));
    expect(markup.indexOf('id="approvalDock"'), "the approval dock sits above the composer")
      .toBeLessThan(markup.indexOf('id="threadComposer"'));
    expect(markup, "the dock is focusable with a title")
      .toContain('id="approvalDock" tabindex="-1" aria-labelledby="approvalTitle"');
    expect(markup, "the resolution group is labelled")
      .toContain('role="group" aria-label="Resolve approval request"');
    expect(markup, "deny exists").toContain('id="denyApproval"');
    expect(markup, "approve-once exists").toContain('id="approveOnce"');
    expect(markup, "approve-always exists").toContain('id="approveAlways"');
    expect(markup, "always-approval clarifies its scope").toContain('<small>this session</small>');
    expect(markup, "approval history is a focusable labelled list")
      .toContain('id="approvalHistoryList" tabindex="0" aria-label="Resolved approval requests"');
    expect(markup, "the inspector survives").toContain('id="inspector"');
    expect(markup, "no retired right-chat region").not.toContain("right-chat");
    expect(styles, "the workspace grid spans under the dock")
      .toContain(".thread-workspace{grid-column:1 / -1;grid-row:3;display:grid;grid-template-columns:minmax(0,1fr) var(--inspector)");
    expect(styles, "the dock borders its region")
      .toContain(".approval-dock{flex:none;border-top:1px solid var(--line-strong)");
    expect(styles, "always-approval session text is tiny").toContain(".approval-always small{font-size:8px");
    expect(styles, "the dock never floats").not.toContain(".approval-dock{position:absolute");
    expect(styles, "history-only docks pad themselves").toContain(".approval-dock.history-only{padding-block:9px}");
    expect(styles, "approval history scrolls within a fixed height").toContain(".approval-history ol{height:64px;");
    expect(styles, "approval history scrollbars are contained")
      .toContain("overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable");
    expect(styles, "approval history focus is visible")
      .toContain(".approval-history ol:focus-visible{outline:1px solid var(--blue)");
    expect(styles, "approval history scrollbars are styled").toContain(".approval-history ol::-webkit-scrollbar{width:8px}");
  }, 10_000);
});
