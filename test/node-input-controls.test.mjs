import { describe, expect, it, vi } from "vitest";

import {
  captureTextControlState,
  committedInputAttachment,
  createInputOccurrence,
  createNodeInputDraftController,
  createNodeInputDraftLoadQueue,
  initialInputStageValue,
  inspectedInputDraftRevision,
  inputActionReviewRef,
  inputOccurrenceKey,
  inputStageValueForApi,
  inputStageValuesEqual,
  summarizeInputStage,
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
