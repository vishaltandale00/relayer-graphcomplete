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

describe("node input control state", () => {
  it("bounds initial input-draft reloads to five backoff attempts", () => {
    expect([0, 1, 2, 3, 4, 5].map(inputDraftLoadRetryDelay))
      .toEqual([500, 1_000, 2_000, 4_000, 5_000, null]);
  });

  it("retries a failed input-draft load, recovers, and enforces the hard cutoff", async () => {
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
    expect(scheduled.map(({ delay }) => delay)).toEqual([500]);
    await scheduled.shift().callback();
    expect(scheduled.map(({ delay }) => delay)).toEqual([1_000]);
    await scheduled.shift().callback();
    expect(load).toHaveBeenCalledTimes(2);
    expect(scheduler.has(7)).toBe(false);

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
      expect(timer).toBeDefined();
      await timer.callback();
    }
    expect(failingTimers).toEqual([]);
    expect(failing.has(9)).toBe(false);
    expect(failing.suppressesLoad(9)).toBe(true);
    recovered = true;
    failing.beginEligibilityCycle(9);
    expect(failing.suppressesLoad(9)).toBe(false);
    expect(failing.schedule(9)).toBe(true);
    await failingTimers.shift().callback();
    expect(exhaustedLoad).toHaveBeenCalledTimes(6);
    expect(failing.suppressesLoad(9)).toBe(false);
  });
  it("gives every presenting input occurrence a distinct review reference", () => {
    expect(inputActionReviewRef(createInputOccurrence(41, 52, 63))).toBe("input-action-41-52-63");
    expect(inputActionReviewRef(createInputOccurrence(41, 53, 63))).toBe("input-action-41-53-63");
  });

  it("locks send to the inspected revision even when the draft is empty", () => {
    expect(inspectedInputDraftRevision(draft(0))).toBe(0);
    expect(inspectedInputDraftRevision(draft(7))).toBe(7);
    expect(inspectedInputDraftRevision(null)).toBeNull();
  });

  it("preserves textarea selection and scroll across a renderer reconciliation", () => {
    const prior = {
      selectionStart: 3,
      selectionEnd: 8,
      selectionDirection: "backward",
      scrollTop: 24,
      scrollLeft: 5,
    };
    const state = captureTextControlState(prior);
    const restored = {
      scrollTop: 0,
      scrollLeft: 0,
      setSelectionRange: vi.fn(),
    };

    restoreTextControlState(restored, state);

    expect(restored.setSelectionRange).toHaveBeenCalledWith(3, 8, "backward");
    expect(restored).toMatchObject({ scrollTop: 24, scrollLeft: 5 });
  });

  it("keys authority by thread and the exact presenting occurrence", () => {
    expect(inputOccurrenceKey(occurrence)).not.toBe(inputOccurrenceKey(otherOccurrence));
    expect(threadInputOccurrenceKey(7, occurrence)).not.toBe(threadInputOccurrenceKey(8, occurrence));
    expect(createInputOccurrence(41, 52, 63)).toEqual(occurrence);
    expect(() => createInputOccurrence(41, null, 63)).toThrow("presentingLayerId is required");
  });

  it("scopes pending input mutations to their owning thread", () => {
    const pending = createInputMutationTracker();
    pending.begin(threadInputOccurrenceKey("thread-a", occurrence));
    pending.begin(threadInputOccurrenceKey("thread-c", otherOccurrence));

    expect(threadHasPendingInputMutation(pending, "thread-a")).toBe(true);
    expect(threadHasPendingInputMutation(pending, "thread-b")).toBe(false);
    expect(threadHasPendingInputMutation(createInputMutationTracker(), "thread-a")).toBe(false);
    expect(threadHasPendingInputMutation(createInputMutationTracker(), undefined)).toBe(false);
    expect(inputKeyBelongsToThread("not-json", "thread-a")).toBe(false);
  });

  it("retains same-occurrence mutation ownership until every concurrent mutation settles", () => {
    const pending = createInputMutationTracker();
    const stageKey = threadInputOccurrenceKey("thread-a", occurrence);

    pending.begin(stageKey);
    pending.begin(stageKey);
    expect(pending.count(stageKey)).toBe(2);
    expect(pending.end(stageKey)).toBe(true);
    expect(pending.has(stageKey)).toBe(true);
    expect(threadHasPendingInputMutation(pending, "thread-a")).toBe(true);
    expect(pending.end(stageKey)).toBe(false);
    expect(pending.has(stageKey)).toBe(false);
    expect(threadHasPendingInputMutation(pending, "thread-a")).toBe(false);
  });

  it("looks up committed attachments and initializes renderer-local staged values", () => {
    const textAttachment = { occurrence, value: { text: "Exact text" } };
    const selectedAttachment = {
      occurrence: otherOccurrence,
      value: { selectedKeys: ["b", "a"] },
    };
    const current = draft(2, [textAttachment, selectedAttachment]);

    expect(committedInputAttachment(current, occurrence)).toBe(textAttachment);
    expect(initialInputStageValue(textAction, textAttachment)).toBe("Exact text");
    expect(initialInputStageValue(singleAction, selectedAttachment)).toEqual(["b", "a"]);
    expect(initialInputStageValue(textAction)).toBe("");
    expect(initialInputStageValue(singleAction)).toEqual([]);
  });

  it("validates text, selection shape, duplicates, unknown keys, and counts deterministically", () => {
    expect(validateInputStage(textAction, "  ")?.code).toBe("input_text_blank");
    expect(validateInputStage(textAction, "kept")).toBeNull();
    expect(validateInputStage(singleAction, "a")?.code).toBe("input_action_snapshot_mismatch");
    expect(validateInputStage(singleAction, ["a", "a"])?.code).toBe("input_option_duplicate");
    expect(validateInputStage(singleAction, ["missing"])?.code).toBe("input_option_unknown");
    expect(validateInputStage(singleAction, [])?.code).toBe("input_selection_count");
    expect(validateInputStage(singleAction, ["a", "b"])?.code).toBe("input_selection_count");
    expect(validateInputStage(multiAction, ["a"])?.code).toBe("input_selection_count");
    expect(validateInputStage(multiAction, ["b", "a"])).toBeNull();
    expect(validateInputStage({ ...multiAction, minimumSelections: undefined }, [])).toBeNull();
    expect(validateInputStage({ ...multiAction, minimumSelections: 1 }, [])?.code).toBe(
      "input_selection_count",
    );
    expect(validateInputStage({ ...multiAction, minimumSelections: 0 }, [])?.code).toBe(
      "input_selection_count",
    );
    expect(validateInputStage({ ...multiAction, minimumSelections: 1.5 }, ["a", "b"])?.code).toBe(
      "input_selection_count",
    );
    expect(validateInputStage({ control: "slider" }, 3)?.code).toBe(
      "input_action_control_unsupported",
    );
  });

  it("converts valid stages to canonical API values", () => {
    expect(inputStageValueForApi(textAction, " exact ")).toEqual({ text: " exact " });
    expect(inputStageValueForApi(multiAction, ["b", "a"])).toEqual({
      selectedKeys: ["a", "b"],
    });
    let validationError;
    try {
      inputStageValueForApi(singleAction, []);
    } catch (error) {
      validationError = error;
    }
    expect(validationError).toMatchObject({
      name: "InputStageValidationError",
      code: "input_selection_count",
    });
  });

  it("compares select stages without assigning order and summarizes accepted labels", () => {
    expect(inputStageValuesEqual(textAction, "a", "a")).toBe(true);
    expect(inputStageValuesEqual(textAction, "a", " a ")).toBe(false);
    expect(inputStageValuesEqual(multiAction, ["b", "a"], ["a", "b"])).toBe(true);
    expect(summarizeInputStage(textAction, "Exact text")).toBe("Exact text");
    expect(summarizeInputStage(multiAction, ["b", "a"])).toBe("Beta, Alpha");
  });
});

describe("node input draft controller", () => {
  it("queues a forced terminal reload behind an in-flight GET and adopts its restored revision", async () => {
    let releaseInitialLoad;
    const initialLoad = new Promise((resolve) => { releaseInitialLoad = resolve; });
    const api = {
      get: vi.fn()
        .mockImplementationOnce(() => initialLoad)
        .mockResolvedValueOnce(draft(8, [{ occurrence, value: { text: "Restored" } }])),
      commit: vi.fn(),
      detach: vi.fn(),
    };
    const controller = createNodeInputDraftController({ api });
    const loads = createNodeInputDraftLoadQueue({
      load: (threadId) => controller.load(threadId),
    });

    const initial = loads.load(7);
    const terminalReload = loads.load(7, { reload: true });
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));

    releaseInitialLoad(draft(3));
    await initial;
    await terminalReload;

    expect(api.get).toHaveBeenCalledTimes(2);
    expect(controller.current(7)).toEqual(draft(
      8,
      [{ occurrence, value: { text: "Restored" } }],
    ));
  });

  it("loads and applies commit/detach with the latest authoritative CAS revision", async () => {
    const committed = { occurrence, action: singleAction, value: { selectedKeys: ["b"] } };
    const api = {
      get: vi.fn(async () => draft(3)),
      commit: vi.fn(async () => draft(4, [committed])),
      detach: vi.fn(async () => draft(5)),
    };
    const changed = vi.fn();
    const controller = createNodeInputDraftController({ api, onChange: changed });

    await controller.load(7);
    await controller.commit(7, occurrence, singleAction, ["b"]);
    await controller.detach(7, occurrence);

    expect(api.commit).toHaveBeenCalledWith(7, occurrence, { selectedKeys: ["b"] }, 3);
    expect(api.detach).toHaveBeenCalledWith(7, occurrence, 4);
    expect(controller.current(7)).toEqual(draft(5));
    expect(Object.isFrozen(controller.current(7))).toBe(true);
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it("preserves the prior committed snapshot when validation or persistence fails", async () => {
    const priorAttachment = { occurrence, action: textAction, value: { text: "Prior" } };
    const prior = draft(9, [priorAttachment]);
    const api = {
      get: vi.fn(async () => prior),
      commit: vi.fn(async () => { throw new Error("revision conflict"); }),
      detach: vi.fn(async () => { throw new Error("disk unavailable"); }),
    };
    const controller = createNodeInputDraftController({ api });
    await controller.load(7);

    await expect(controller.commit(7, occurrence, textAction, " ")).rejects.toMatchObject({
      code: "input_text_blank",
    });
    expect(api.commit).not.toHaveBeenCalled();
    await expect(controller.commit(7, occurrence, textAction, "Replacement")).rejects.toThrow(
      "revision conflict",
    );
    await expect(controller.detach(7, occurrence)).rejects.toThrow("disk unavailable");
    expect(controller.current(7)).toEqual(prior);
  });

  it("adopts fresh authority after commit and detach revision conflicts", async () => {
    const conflict = () => Object.assign(new Error("revision conflict"), {
      code: "input_draft_revision_conflict",
    });
    const api = {
      get: vi.fn()
        .mockResolvedValueOnce(draft(9))
        .mockResolvedValueOnce(draft(11))
        .mockResolvedValueOnce(draft(13)),
      commit: vi.fn(async () => { throw conflict(); }),
      detach: vi.fn(async () => { throw conflict(); }),
    };
    const controller = createNodeInputDraftController({ api });
    await controller.load(7);

    await expect(controller.commit(7, occurrence, textAction, "staged value"))
      .rejects.toMatchObject({ code: "input_draft_revision_conflict" });
    expect(controller.current(7)).toEqual(draft(11));
    await expect(controller.detach(7, occurrence))
      .rejects.toMatchObject({ code: "input_draft_revision_conflict" });
    expect(controller.current(7)).toEqual(draft(13));
    expect(api.get).toHaveBeenCalledTimes(3);
  });

  it("requires an authoritative load before mutation", async () => {
    const api = { commit: vi.fn(), detach: vi.fn() };
    const controller = createNodeInputDraftController({ api });

    await expect(controller.commit(7, occurrence, textAction, "value")).rejects.toThrow(
      "Load the thread input draft",
    );
    await expect(controller.detach(7, occurrence)).rejects.toThrow(
      "Load the thread input draft",
    );
  });

  it("serializes concurrent mutations against each adopted CAS revision", async () => {
    const api = {
      get: vi.fn(async () => draft(1)),
      commit: vi.fn(async (_threadId, receivedOccurrence, value, revision) => draft(
        revision + 1,
        [{ occurrence: receivedOccurrence, action: singleAction, value }],
      )),
      detach: vi.fn(),
    };
    const controller = createNodeInputDraftController({ api });
    await controller.load(7);

    await Promise.all([
      controller.commit(7, occurrence, singleAction, ["a"]),
      controller.commit(7, otherOccurrence, singleAction, ["b"]),
    ]);

    expect(api.commit.mock.calls.map((call) => call[3])).toEqual([1, 2]);
    expect(controller.current(7).revision).toBe(3);
  });

  it("orders authoritative reloads after an in-flight mutation", async () => {
    let releaseCommit;
    const commitGate = new Promise((resolve) => { releaseCommit = resolve; });
    const api = {
      get: vi.fn(async () => draft(3)),
      commit: vi.fn(async () => {
        await commitGate;
        return draft(4);
      }),
      detach: vi.fn(),
    };
    const controller = createNodeInputDraftController({ api });
    await controller.load(7);
    api.get.mockImplementationOnce(async () => draft(5));
    const committing = controller.commit(7, occurrence, textAction, "next");
    const loading = controller.load(7);
    expect(api.get).toHaveBeenCalledTimes(1);
    releaseCommit();
    await Promise.all([committing, loading]);
    expect(controller.current(7).revision).toBe(5);
  });
});
