import { describe, it, expect, vi } from "vitest";
import { createLiveAnswerController } from "../desktop/renderer/src/live-answers.js";

const input = { attemptId: 10, authorityEpoch: 1, expectedRevision: 2,
  occurrence: { presentingInteractionNodeId: 7, presentingLayerId: 8, actionId: 9 } };
const receipt = request => ({ ...request, currentRevision: request.expectedRevision, sequence: 1, completionId: 7, question: { control: "text", prompt: "Which city?" } });

describe("explicit live-answer delivery", () => {
  it("freezes one request, single-flights clicks and reconciles response loss without resending", async () => {
    let delivered;
    const api = { answer: vi.fn(async (_thread, _turn, request) => { delivered = receipt(request); throw new Error("response lost"); }),
      liveAnswers: vi.fn(async () => ({ answers: [], currentAnswers: [delivered] })) };
    const controller = createLiveAnswerController({ api, newKey: () => "answer-1" });
    const staged = { text: "Boston" };
    const pending = controller.answer(1, 2, input, staged);
    staged.text = "Chicago";
    const again = controller.answer(1, 2, input, { text: "Boston" });
    expect((await pending).value).toEqual({ text: "Boston" });
    expect((await again).operationKey).toBe("answer-1");
    expect(api.answer).toHaveBeenCalledTimes(1);
    await expect(controller.answer(1, 2, input, { text: "Chicago" })).rejects.toThrow("already has");
    expect(controller.receipt(1, input.occurrence)).toMatchObject({ operationKey: "answer-1", attemptId: 10 });
  });

  it("keeps an unconfirmed identity, rejects replacements and retries only an explicit identical click", async () => {
    const api = { answer: vi.fn(async () => { throw new Error("offline"); }), liveAnswers: vi.fn(async () => ({ answers: [] })) };
    const controller = createLiveAnswerController({ api, newKey: () => "answer-1" });
    await expect(controller.answer(1, 2, input, { text: "Boston" })).rejects.toThrow("unconfirmed");
    await expect(controller.answer(1, 2, input, { text: "Chicago" })).rejects.toThrow("earlier answer");
    expect(api.answer).toHaveBeenCalledTimes(1);
    api.answer.mockImplementation(async (_thread, _turn, request) => receipt(request));
    expect((await controller.answer(1, 2, input, { text: "Boston" })).operationKey).toBe("answer-1");
    expect(api.answer.mock.calls[1][2]).toEqual(api.answer.mock.calls[0][2]);
  });

  it("recognizes canonical set order without changing the frozen retry request", async () => {
    const selected = [{ key: "z", label: "Last" }, { key: "a", label: "First" }];
    const api = { answer: async (_thread, _turn, request) => ({ ...receipt(request), value: { selected: [...selected].reverse() } }) };
    const controller = createLiveAnswerController({ api, newKey: () => "answer-1" });
    expect((await controller.answer(1, 2, input, { selected })).value.selected).toEqual([...selected].reverse());
  });

  it.each([{ authorityEpoch: 2 }, { currentRevision: 3 }, { completionId: 8 }, { value: { text: "Chicago" } }])("rejects mismatched provenance or value %j", async change => {
    const api = { answer: async (_thread, _turn, request) => ({ ...receipt(request), ...change }), liveAnswers: async () => ({ answers: [] }) };
    const controller = createLiveAnswerController({ api, newKey: () => "answer-1" });
    await expect(controller.answer(1, 2, input, { text: "Boston" })).rejects.toThrow("unconfirmed");
    expect(controller.receipt(1, input.occurrence)).toBeNull();
  });

  it("allows repair only after an explicit refusal and never adopts a foreign receipt", async () => {
    let key = 0;
    const api = { answer: vi.fn(async () => { throw Object.assign(new Error("stale"), { status: 422 }); }), liveAnswers: vi.fn() };
    const controller = createLiveAnswerController({ api, newKey: () => `answer-${++key}` });
    await expect(controller.answer(1, 2, input, { text: "Boston" })).rejects.toThrow("stale");
    api.answer.mockImplementation(async (_thread, _turn, request) => ({ ...receipt(request), attemptId: 11 }));
    api.liveAnswers.mockResolvedValue({ answers: [] });
    await expect(controller.answer(1, 2, input, { text: "Chicago" })).rejects.toThrow("unconfirmed");
    expect(api.answer.mock.calls[1][2].operationKey).toBe("answer-2");
    expect(controller.receipt(1, input.occurrence)).toBeNull();
  });
});
