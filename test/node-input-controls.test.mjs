import { describe, expect, it, vi } from "vitest";

import {
  captureTextControlState,
  committedInputAttachment,
  createInputOccurrence,
  createInputDraftLoadRetryScheduler,
  createInputMutationTracker,
  createNodeInputDraftController,
  createNodeInputDraftLoadQueue,
  initialInputStageValue,
  inputDraftLoadRetryDelay,
  inspectedInputDraftRevision,
  inputActionReviewRef,
  inputKeyBelongsToThread,
  inputOccurrenceKey,
  inputStageValueForApi,
  inputStageValuesEqual,
  summarizeInputStage,
  threadHasPendingInputMutation,
  threadInputOccurrenceKey,
  validateInputStage,
  restoreTextControlState,
} from "../desktop/renderer/src/node-input-controls.js";

const occurrence = createInputOccurrence(41, 52, 63);
const otherOccurrence = createInputOccurrence(41, 52, 64);
const textAction = { control: "text", prompt: "Explain" };
const singleAction = {
  control: "single_select",
  prompt: "Choose one",
  options: [{ key: "a", label: "Alpha" }, { key: "b", label: "Beta" }],
};
const multiAction = {
  control: "multi_select",
  prompt: "Choose evidence",
  options: [{ key: "a", label: "Alpha" }, { key: "b", label: "Beta" }],
  minimumSelections: 2,
};

function draft(revision, attachments = []) {
  return { threadId: 7, revision, attachments, updatedAt: `revision-${revision}` };
}

function responseAttachment({
  inputOccurrence = occurrence,
  action = textAction,
  value = { text: "Accepted" },
  draftRevision = 1,
} = {}) {
  return {
    occurrence: inputOccurrence,
    sourceNodeId: Number(inputOccurrence.actionId),
    action,
    value,
    draftRevision,
    committedAt: `revision-${draftRevision}`,
  };
}

describe("node input control state", () => {
  it("derives occurrence identity, staged values, validation, and comparison rules", () => {
    expect(inputActionReviewRef(createInputOccurrence(41, 52, 63)), "review reference per occurrence")
      .toBe("input-action-41-52-63");
    expect(inputActionReviewRef(createInputOccurrence(41, 53, 63)), "review reference per layer")
      .toBe("input-action-41-53-63");

    expect(inspectedInputDraftRevision(draft(0)), "revision zero locks send").toBe(0);
    expect(inspectedInputDraftRevision(draft(7)), "revision locks send").toBe(7);
    expect(inspectedInputDraftRevision(null), "missing draft unlocks send").toBeNull();

    const prior = {
      selectionStart: 3,
      selectionEnd: 8,
      selectionDirection: "backward",
      scrollTop: 24,
      scrollLeft: 5,
    };
    const restored = {
      scrollTop: 0,
      scrollLeft: 0,
      setSelectionRange: vi.fn(),
    };
    restoreTextControlState(restored, captureTextControlState(prior));
    expect(restored.setSelectionRange, "textarea selection survives reconciliation")
      .toHaveBeenCalledWith(3, 8, "backward");
    expect(restored, "textarea scroll survives reconciliation").toMatchObject({ scrollTop: 24, scrollLeft: 5 });

    expect(inputOccurrenceKey(occurrence), "occurrence key distinguishes occurrences")
      .not.toBe(inputOccurrenceKey(otherOccurrence));
    expect(threadInputOccurrenceKey(7, occurrence), "occurrence key distinguishes threads")
      .not.toBe(threadInputOccurrenceKey(8, occurrence));
    expect(createInputOccurrence(41, 52, 63), "occurrence shape is stable").toEqual(occurrence);
    expect(() => createInputOccurrence(41, null, 63), "occurrence requires a presenting layer")
      .toThrow("presentingLayerId is required");

    const pending = createInputMutationTracker();
    pending.begin(threadInputOccurrenceKey("thread-a", occurrence));
    pending.begin(threadInputOccurrenceKey("thread-c", otherOccurrence));
    expect(threadHasPendingInputMutation(pending, "thread-a"), "owning thread sees the mutation").toBe(true);
    expect(threadHasPendingInputMutation(pending, "thread-b"), "other threads do not").toBe(false);
    expect(threadHasPendingInputMutation(createInputMutationTracker(), "thread-a"), "fresh tracker is empty").toBe(false);
    expect(threadHasPendingInputMutation(createInputMutationTracker(), undefined), "missing thread is empty").toBe(false);
    expect(inputKeyBelongsToThread("not-json", "thread-a"), "malformed keys belong nowhere").toBe(false);

    const stageKey = threadInputOccurrenceKey("thread-a", occurrence);
    pending.begin(stageKey);
    expect(pending.count(stageKey), "concurrent mutations share one occurrence").toBe(2);
    expect(pending.end(stageKey), "first settle keeps ownership").toBe(true);
    expect(pending.has(stageKey), "ownership retained while a mutation is pending").toBe(true);
    expect(threadHasPendingInputMutation(pending, "thread-a"), "thread still pending").toBe(true);
    expect(pending.end(stageKey), "final settle releases ownership").toBe(false);
    expect(pending.has(stageKey), "occurrence released").toBe(false);
    expect(threadHasPendingInputMutation(pending, "thread-a"), "thread released").toBe(false);

    const textAttachment = { occurrence, value: { text: "Exact text" } };
    const selectedAttachment = {
      occurrence: otherOccurrence,
      value: { selectedKeys: ["b", "a"] },
    };
    const current = draft(2, [textAttachment, selectedAttachment]);
    expect(committedInputAttachment(current, occurrence), "committed attachment lookup").toBe(textAttachment);
    expect(initialInputStageValue(textAction, textAttachment), "staged text from attachment").toBe("Exact text");
    expect(initialInputStageValue(singleAction, selectedAttachment), "staged selection from attachment")
      .toEqual(["b", "a"]);
    expect(initialInputStageValue(textAction), "empty staged text").toBe("");
    expect(initialInputStageValue(singleAction), "empty staged selection").toEqual([]);

    const validationCases = [
      ["blank text", textAction, "  ", "input_text_blank"],
      ["kept text", textAction, "kept", null],
      ["string where a selection belongs", singleAction, "a", "input_action_snapshot_mismatch"],
      ["duplicate option keys", singleAction, ["a", "a"], "input_option_duplicate"],
      ["unknown option key", singleAction, ["missing"], "input_option_unknown"],
      ["empty single selection", singleAction, [], "input_selection_count"],
      ["oversized single selection", singleAction, ["a", "b"], "input_selection_count"],
      ["multi selection under the minimum", multiAction, ["a"], "input_selection_count"],
      ["multi selection at the minimum", multiAction, ["b", "a"], null],
      ["absent minimum accepts empty", { ...multiAction, minimumSelections: undefined }, [], null],
      ["minimum one rejects empty", { ...multiAction, minimumSelections: 1 }, [], "input_selection_count"],
      ["minimum zero rejects empty", { ...multiAction, minimumSelections: 0 }, [], "input_selection_count"],
      ["fractional minimum rejects all", { ...multiAction, minimumSelections: 1.5 }, ["a", "b"], "input_selection_count"],
      ["unsupported control", { control: "slider" }, 3, "input_action_control_unsupported"],
    ];
    expect(validationCases, "validation corpus inventory").toHaveLength(14);
    for (const [label, action, value, code] of validationCases) {
      expect(validateInputStage(action, value)?.code ?? null, `validation: ${label}`).toBe(code);
    }

    expect(inputStageValueForApi(textAction, " exact "), "text keeps its exact bytes").toEqual({ text: " exact " });
    expect(inputStageValueForApi(multiAction, ["b", "a"]), "selections canonicalize to sorted keys").toEqual({
      selectedKeys: ["a", "b"],
    });
    let validationError;
    try {
      inputStageValueForApi(singleAction, []);
    } catch (error) {
      validationError = error;
    }
    expect(validationError, "invalid stages throw a typed validation error").toMatchObject({
      name: "InputStageValidationError",
      code: "input_selection_count",
    });

    expect(inputStageValuesEqual(textAction, "a", "a"), "identical text is equal").toBe(true);
    expect(inputStageValuesEqual(textAction, "a", " a "), "text comparison does not trim whitespace").toBe(false);
    expect(inputStageValuesEqual(multiAction, ["b", "a"], ["a", "b"]), "selection equality ignores order").toBe(true);
    expect(summarizeInputStage(textAction, "Exact text"), "text summary is the text").toBe("Exact text");
    expect(summarizeInputStage(multiAction, ["b", "a"]), "selection summary lists labels").toBe("Beta, Alpha");
  });

  it("bounds input-draft reloads with backoff, retry, and recovery", async () => {
    expect([0, 1, 2, 3, 4, 5].map(inputDraftLoadRetryDelay), "backoff schedule caps at five attempts")
      .toEqual([500, 1_000, 2_000, 4_000, 5_000, null]);

    const scheduled = [];
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(draft(4));
    const scheduler = createInputDraftLoadRetryScheduler({
      setTimeout: (callback, delay) => {
        const timer = { callback, delay };
        scheduled.push(timer);
        return timer;
      },
      clearTimeout: vi.fn(),
      load,
      isEligible: () => true,
    });
    scheduler.schedule(7);
    expect(scheduled.map(({ delay }) => delay), "first retry uses the first backoff").toEqual([500]);
    await scheduled.shift().callback();
    expect(scheduled.map(({ delay }) => delay), "failure schedules the next backoff").toEqual([1_000]);
    await scheduled.shift().callback();
    expect(load, "recovery loads exactly twice").toHaveBeenCalledTimes(2);
    expect(scheduler.has(7), "recovered thread leaves the retry set").toBe(false);

    const failingTimers = [];
    let recovered = false;
    const exhaustedLoad = vi.fn(async () => {
      if (!recovered) throw new Error("offline");
      return draft(9);
    });
    const failing = createInputDraftLoadRetryScheduler({
      setTimeout: (callback, delay) => {
        const timer = { callback, delay };
        failingTimers.push(timer);
        return timer;
      },
      clearTimeout: vi.fn(),
      load: exhaustedLoad,
      isEligible: () => true,
    });
    failing.schedule(9);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const timer = failingTimers.shift();
      expect(timer, `exhaustion attempt ${attempt + 1} scheduled`).toBeDefined();
      await timer.callback();
    }
    expect(failingTimers, "hard cutoff stops scheduling").toEqual([]);
    expect(failing.has(9), "exhausted thread leaves the retry set").toBe(false);
    expect(failing.suppressesLoad(9), "exhaustion suppresses further loads").toBe(true);
    recovered = true;
    failing.beginEligibilityCycle(9);
    expect(failing.suppressesLoad(9), "eligibility cycle lifts suppression").toBe(false);
    expect(failing.schedule(9), "eligibility cycle re-arms scheduling").toBe(true);
    await failingTimers.shift().callback();
    expect(exhaustedLoad, "recovery attempt runs after the cycle").toHaveBeenCalledTimes(6);
    expect(failing.suppressesLoad(9), "successful recovery clears suppression").toBe(false);
  });
});

describe("node input draft controller", () => {
  it("walks the draft mutation lifecycle against authoritative CAS revisions", async () => {
    let releaseInitialLoad;
    const initialLoad = new Promise((resolve) => { releaseInitialLoad = resolve; });
    const queuedApi = {
      get: vi.fn()
        .mockImplementationOnce(() => initialLoad)
        .mockResolvedValueOnce(draft(8, [responseAttachment({
          value: { text: "Restored" },
          draftRevision: 8,
        })])),
      commit: vi.fn(),
      detach: vi.fn(),
    };
    const queuedController = createNodeInputDraftController({ api: queuedApi });
    const loads = createNodeInputDraftLoadQueue({
      load: (threadId) => queuedController.load(threadId),
    });

    const initial = loads.load(7);
    const terminalReload = loads.load(7, { reload: true });
    await vi.waitFor(() => expect(queuedApi.get, "forced reload waits for the in-flight GET").toHaveBeenCalledTimes(1));

    releaseInitialLoad(draft(3));
    await initial;
    await terminalReload;

    expect(queuedApi.get, "terminal reload issues its own GET").toHaveBeenCalledTimes(2);
    expect(queuedController.current(7), "terminal reload adopts the restored revision").toEqual(draft(
      8,
      [responseAttachment({ value: { text: "Restored" }, draftRevision: 8 })],
    ));

    const committed = responseAttachment({
      action: singleAction,
      value: { selectedKeys: ["b"] },
      draftRevision: 4,
    });
    const casApi = {
      get: vi.fn(async () => draft(3)),
      commit: vi.fn(async () => draft(4, [committed])),
      detach: vi.fn(async () => draft(5)),
    };
    const changed = vi.fn();
    const cas = createNodeInputDraftController({ api: casApi, onChange: changed });

    await cas.load(7);
    await cas.commit(7, occurrence, singleAction, ["b"]);
    await cas.detach(7, occurrence);

    expect(casApi.commit, "commit carries the loaded CAS revision").toHaveBeenCalledWith(7, occurrence, { selectedKeys: ["b"] }, 3);
    expect(casApi.detach, "detach carries the commit CAS revision").toHaveBeenCalledWith(7, occurrence, 4);
    expect(cas.current(7), "detach adopts the latest draft").toEqual(draft(5));
    expect(Object.isFrozen(cas.current(7)), "adopted drafts are frozen").toBe(true);
    expect(changed, "every authority change notifies").toHaveBeenCalledTimes(3);

    const idempotentApi = {
      get: vi.fn(async () => draft(4)),
      commit: vi.fn(),
      detach: vi.fn(async () => draft(4)),
    };
    const idempotent = createNodeInputDraftController({ api: idempotentApi });
    await idempotent.load(7);
    await expect(idempotent.detach(7, occurrence), "detach is idempotent for an absent occurrence")
      .resolves.toEqual(draft(4));
    expect(idempotentApi.detach, "idempotent detach sends the loaded revision").toHaveBeenCalledWith(7, occurrence, 4);

    const unloadedApi = { commit: vi.fn(), detach: vi.fn() };
    const unloaded = createNodeInputDraftController({ api: unloadedApi });
    await expect(unloaded.commit(7, occurrence, textAction, "value"), "commit requires an authoritative load")
      .rejects.toThrow("Load the thread input draft");
    await expect(unloaded.detach(7, occurrence), "detach requires an authoritative load")
      .rejects.toThrow("Load the thread input draft");

    const priorAttachment = responseAttachment({
      value: { text: "Prior" },
      draftRevision: 9,
    });
    const prior = draft(9, [priorAttachment]);
    const failingApi = {
      get: vi.fn(async () => prior),
      commit: vi.fn(async () => { throw new Error("revision conflict"); }),
      detach: vi.fn(async () => { throw new Error("disk unavailable"); }),
    };
    const failing = createNodeInputDraftController({ api: failingApi });
    await failing.load(7);

    await expect(failing.commit(7, occurrence, textAction, " "), "validation failure never reaches the server")
      .rejects.toMatchObject({ code: "input_text_blank" });
    expect(failingApi.commit, "validation failure skips the network").not.toHaveBeenCalled();
    await expect(failing.commit(7, occurrence, textAction, "Replacement"), "persistence failure surfaces")
      .rejects.toThrow("revision conflict");
    await expect(failing.detach(7, occurrence), "detach failure surfaces").rejects.toThrow("disk unavailable");
    expect(failing.current(7), "failed mutations preserve the prior snapshot").toEqual(prior);

    const serialApi = {
      get: vi.fn(async () => draft(1)),
      commit: vi.fn(async (_threadId, receivedOccurrence, value, revision) => draft(
        revision + 1,
        [responseAttachment({
          inputOccurrence: receivedOccurrence,
          action: singleAction,
          value,
          draftRevision: revision + 1,
        })],
      )),
      detach: vi.fn(),
    };
    const serial = createNodeInputDraftController({ api: serialApi });
    await serial.load(7);

    await Promise.all([
      serial.commit(7, occurrence, singleAction, ["a"]),
      serial.commit(7, otherOccurrence, singleAction, ["b"]),
    ]);

    expect(serialApi.commit.mock.calls.map((call) => call[3]), "concurrent commits chain CAS revisions")
      .toEqual([1, 2]);
    expect(serial.current(7).revision, "concurrent commits land on the chained revision").toBe(3);

    let releaseCommit;
    const commitGate = new Promise((resolve) => { releaseCommit = resolve; });
    const orderedApi = {
      get: vi.fn(async () => draft(3)),
      commit: vi.fn(async () => {
        await commitGate;
        return draft(4, [responseAttachment({ value: { text: "next" }, draftRevision: 4 })]);
      }),
      detach: vi.fn(),
    };
    const ordered = createNodeInputDraftController({ api: orderedApi });
    await ordered.load(7);
    orderedApi.get.mockImplementationOnce(async () => draft(5));
    const committing = ordered.commit(7, occurrence, textAction, "next");
    const loading = ordered.load(7);
    expect(orderedApi.get, "reload waits behind the in-flight mutation").toHaveBeenCalledTimes(1);
    releaseCommit();
    await Promise.all([committing, loading]);
    expect(ordered.current(7).revision, "queued reload adopts the later authority").toBe(5);
  }, 15_000);

  it("rejects malformed and conflicting mutation results and adopts fresh authority", async () => {
    const conflict = () => Object.assign(new Error("revision conflict"), {
      code: "input_draft_revision_conflict",
    });
    const conflictApi = {
      get: vi.fn()
        .mockResolvedValueOnce(draft(9))
        .mockResolvedValueOnce(draft(11))
        .mockResolvedValueOnce(draft(13)),
      commit: vi.fn(async () => { throw conflict(); }),
      detach: vi.fn(async () => { throw conflict(); }),
    };
    const conflicted = createNodeInputDraftController({ api: conflictApi });
    await conflicted.load(7);

    await expect(conflicted.commit(7, occurrence, textAction, "staged value"), "commit conflict surfaces")
      .rejects.toMatchObject({ code: "input_draft_revision_conflict" });
    expect(conflicted.current(7), "commit conflict adopts fresh authority").toEqual(draft(11));
    await expect(conflicted.detach(7, occurrence), "detach conflict surfaces")
      .rejects.toMatchObject({ code: "input_draft_revision_conflict" });
    expect(conflicted.current(7), "detach conflict adopts fresh authority").toEqual(draft(13));
    expect(conflictApi.get, "each conflict reconciles through a reload").toHaveBeenCalledTimes(3);

    const ambiguousCommitted = responseAttachment({ draftRevision: 10 });
    const ambiguousApi = {
      get: vi.fn()
        .mockResolvedValueOnce(draft(9))
        .mockResolvedValueOnce(draft(10, [ambiguousCommitted]))
        .mockResolvedValueOnce(draft(12)),
      commit: vi.fn(async () => ({})),
      detach: vi.fn(async () => ({ revision: 11, attachments: null })),
    };
    const ambiguous = createNodeInputDraftController({ api: ambiguousApi });
    await ambiguous.load(7);

    await expect(ambiguous.commit(7, occurrence, textAction, "Accepted"), "shapeless commit result rejected")
      .rejects.toMatchObject({ code: "input_draft_response_invalid" });
    expect(ambiguous.current(7), "ambiguous commit state reconciled").toEqual(draft(10, [ambiguousCommitted]));

    await expect(ambiguous.detach(7, occurrence), "shapeless detach result rejected")
      .rejects.toMatchObject({ code: "input_draft_response_invalid" });
    expect(ambiguous.current(7), "ambiguous detach state reconciled").toEqual(draft(12));
    expect(ambiguousApi.commit, "ambiguous commit used the loaded revision")
      .toHaveBeenCalledWith(7, occurrence, { text: "Accepted" }, 9);
    expect(ambiguousApi.detach, "ambiguous detach used the adopted revision").toHaveBeenCalledWith(7, occurrence, 10);
    expect(ambiguousApi.get, "ambiguous results reconcile through reloads").toHaveBeenCalledTimes(3);

    const malformedAttachmentCases = [
      ["a null attachment member", [null]],
      ["a control-incompatible attachment value", [responseAttachment({ value: { selectedKeys: ["a"] }, draftRevision: 5 })]],
      ["a blank text attachment value", [responseAttachment({ value: { text: "   " }, draftRevision: 5 })]],
      ["a select attachment without options", [responseAttachment({
        action: { control: "single_select", prompt: "Choose one", options: [] },
        value: { selectedKeys: ["a"] },
        draftRevision: 5,
      })]],
      ["a select attachment with an unknown key", [responseAttachment({
        action: singleAction,
        value: { selectedKeys: ["unknown"] },
        draftRevision: 5,
      })]],
      ["a select attachment with a malformed option", [responseAttachment({
        action: { control: "single_select", prompt: "Choose one", options: [null] },
        value: { selectedKeys: ["a"] },
        draftRevision: 5,
      })]],
      ["an attachment from a future revision", [responseAttachment({ draftRevision: 6 })]],
    ];
    expect(malformedAttachmentCases, "malformed attachment corpus inventory").toHaveLength(7);
    for (const [label, attachments] of malformedAttachmentCases) {
      const api = {
        get: vi.fn()
          .mockResolvedValueOnce(draft(4))
          .mockResolvedValueOnce(draft(6)),
        commit: vi.fn(async () => draft(5, attachments)),
        detach: vi.fn(),
      };
      const controller = createNodeInputDraftController({ api });
      await controller.load(7);

      await expect(controller.commit(7, occurrence, textAction, "Accepted"), `${label}: commit rejected`)
        .rejects.toMatchObject({ code: "input_draft_response_invalid" });
      expect(controller.current(7), `${label}: authority reconciled`).toEqual(draft(6));
      expect(api.get, `${label}: reconciled through a reload`).toHaveBeenCalledTimes(2);
    }

    const retained = responseAttachment({ draftRevision: 4 });
    const postconditionCases = [
      ["commit without the committed attachment", "commit", [], draft(5)],
      ["commit without a revision advance", "commit", [], draft(4, [responseAttachment({ draftRevision: 4 })])],
      ["detach retaining a stale attachment", "detach", [retained], draft(5, [retained])],
    ];
    expect(postconditionCases, "postcondition corpus inventory").toHaveLength(3);
    for (const [label, operation, initialAttachments, response] of postconditionCases) {
      const api = {
        get: vi.fn()
          .mockResolvedValueOnce(draft(4, initialAttachments))
          .mockResolvedValueOnce(draft(6)),
        commit: vi.fn(async () => response),
        detach: vi.fn(async () => response),
      };
      const controller = createNodeInputDraftController({ api });
      await controller.load(7);

      const mutation = operation === "commit"
        ? controller.commit(7, occurrence, textAction, "Accepted")
        : controller.detach(7, occurrence);
      await expect(mutation, `${label}: ${operation} rejected`).rejects.toMatchObject({
        code: "input_draft_response_invalid",
      });
      expect(controller.current(7), `${label}: authority reconciled`).toEqual(draft(6));
    }
  }, 15_000);
});
