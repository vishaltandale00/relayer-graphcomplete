import { describe, expect, it, vi } from "vitest";
import {
  InputOperatorController,
  type InputActionSnapshot,
  type InputOperatorTransport,
} from "../src/simulated-user/input-operator.js";

const occurrence = {
  presentingInteractionNodeId: 11,
  presentingLayerId: 12,
  actionId: 13,
};

const actions = {
  text: { control: "text", prompt: "Name the constraint" },
  single: {
    control: "single_select",
    prompt: "Choose a route",
    options: [{ key: "b", label: "Route B" }, { key: "a", label: "Route A" }],
  },
  multi: {
    control: "multi_select",
    prompt: "Choose evidence",
    options: [{ key: "proof-b", label: "Proof B" }, { key: "proof-a", label: "Proof A" }],
    minimumSelections: 2,
  },
} satisfies Record<string, InputActionSnapshot>;

describe("InputOperatorController", () => {
  it("commits text, single-select, and canonical multi-select values through the exact product route", async () => {
    const requests: { path: string; request: { method: string; body?: Readonly<Record<string, unknown>> } }[] = [];
    let revision = 4;
    const controller = createController(async (path, request) => {
      requests.push({ path, request });
      const nextRevision = ++revision;
      const action = [actions.text, actions.single, actions.multi][Number(request.body?.occurrence && (request.body.occurrence as typeof occurrence).actionId) - occurrence.actionId]!;
      return draftResponse(action, request, nextRevision);
    });

    for (const [index, [action, value]] of ([
      [actions.text, { text: "Preserve occurrence identity" }],
      [actions.single, { selectedKeys: ["b"] }],
      [actions.multi, { selectedKeys: ["proof-b", "proof-a"] }],
    ] as const).entries()) {
      const capture = controller.beginCapture({ occurrence: { ...occurrence, actionId: occurrence.actionId + index }, action, threadRevision: `thread-r${index}` });
      controller.rateCapture({ ...capture, ratingId: `rating-${index}` });
      revision = await controller.commit({ captureId: capture.captureId, value, expectedRevision: revision });
    }

    expect(requests.map(({ path }) => path)).toEqual([
      "/api/threads/thread%20one/input-draft/attachments",
      "/api/threads/thread%20one/input-draft/attachments",
      "/api/threads/thread%20one/input-draft/attachments",
    ]);
    expect(requests[0]!.request).toEqual({
      method: "PUT",
      body: { occurrence, value: { text: "Preserve occurrence identity" }, expectedRevision: 4 },
    });
    expect(requests[1]!.request.body!.value).toEqual({ selectedKeys: ["b"] });
    expect(requests[2]!.request.body!.value).toEqual({ selectedKeys: ["proof-a", "proof-b"] });
  });

  it("rejects wrong shapes, blank text, duplicate and unknown keys, and insufficient selection counts before transport", async () => {
    const request = vi.fn<InputOperatorTransport["request"]>();
    const invalid = [
      [actions.text, { selectedKeys: ["a"] }, "input_text_blank"],
      [actions.text, { text: "  " }, "input_text_blank"],
      [actions.single, { selectedKeys: ["a", "b"] }, "input_selection_count"],
      [actions.single, { selectedKeys: ["missing"] }, "input_option_unknown"],
      [actions.multi, { selectedKeys: ["proof-a", "proof-a"] }, "input_option_duplicate"],
      [actions.multi, { selectedKeys: ["proof-a"] }, "input_selection_count"],
    ] as const;
    for (const [index, [action, value, code]] of invalid.entries()) {
      const controller = createController(request);
      const capture = controller.beginCapture({ occurrence, action, threadRevision: `r-${index}` });
      controller.rateCapture({ ...capture, ratingId: `rating-${index}` });
      await expect(controller.commit({ captureId: capture.captureId, value, expectedRevision: 0 }))
        .rejects.toMatchObject({ code });
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("posts Send only after a commissioned commit and carries the returned draft revision", async () => {
    const requests: { path: string; request: unknown }[] = [];
    const controller = createController(async (path, request) => {
      requests.push({ path, request });
      return path.endsWith("attachments") ? draftResponse(actions.text, request, 8) : { id: 99 };
    });
    await expect(controller.send({ inputId: "attempt-1" })).rejects.toMatchObject({ code: "input_operator_commit_required" });
    const capture = controller.beginCapture({ occurrence, action: actions.text, threadRevision: "thread-r1" });
    controller.rateCapture({ ...capture, ratingId: "rating-1" });
    await controller.commit({ captureId: capture.captureId, value: { text: "Exact" }, expectedRevision: 7 });
    await expect(controller.send({ inputId: "attempt-1" })).resolves.toEqual({ id: 99 });
    expect(requests[1]).toEqual({
      path: "/api/threads/thread%20one/interactions",
      request: {
        method: "POST",
        body: { text: "", inputId: "attempt-1", inputDraftRevision: 8 },
      },
    });
    await expect(controller.send({ inputId: "attempt-1" })).rejects.toMatchObject({ code: "input_operator_commit_required" });
  });

  it("reuses its generated Send identity after an ambiguous response loss", async () => {
    const sendBodies: Readonly<Record<string, unknown>>[] = [];
    let sendAttempts = 0;
    const controller = createController(async (path, request) => {
      if (path.endsWith("attachments")) return draftResponse(actions.text, request, 8);
      sendBodies.push(request.body!);
      sendAttempts += 1;
      if (sendAttempts === 1) throw new Error("response lost after product acceptance");
      return { id: 99 };
    });
    const capture = controller.beginCapture({ occurrence, action: actions.text, threadRevision: "thread-r1" });
    controller.rateCapture({ ...capture, ratingId: "rating-1" });
    await controller.commit({ captureId: capture.captureId, value: { text: "Exact" }, expectedRevision: 7 });

    await expect(controller.send({})).rejects.toThrow("response lost after product acceptance");
    await expect(controller.send({})).resolves.toEqual({ id: 99 });
    expect(sendBodies).toHaveLength(2);
    expect(sendBodies[0]!.inputId).toBe("capture-2");
    expect(sendBodies[1]!.inputId).toBe(sendBodies[0]!.inputId);
  });

  it("reserves the Send write fence while an active capture is still settling", async () => {
    const transport = vi.fn(async (path, request) => (
      path.endsWith("attachments") ? draftResponse(actions.text, request, 8) : { id: 99 }
    ));
    const controller = createController(transport);
    const commissioned = controller.beginCapture({ occurrence, action: actions.text, threadRevision: "thread-r1" });
    controller.rateCapture({ ...commissioned, ratingId: "rating-1" });
    await controller.commit({ captureId: commissioned.captureId, value: { text: "Exact" }, expectedRevision: 7 });
    const blocking = controller.beginCapture({
      occurrence: { ...occurrence, actionId: 14 },
      action: actions.text,
      threadRevision: "thread-r1",
    });

    const send = controller.send({});
    await Promise.resolve();
    expect(controller.state().writeInFlight).toBe(true);
    await expect(controller.send({})).rejects.toMatchObject({ code: "input_operator_write_active" });

    controller.rateCapture({ ...blocking, ratingId: "rating-2" });
    await expect(send).resolves.toEqual({ id: 99 });
  });

  it("reads the current draft revision before an operator-commissioned optimistic commit", async () => {
    const requests: { path: string; method: string; body?: Readonly<Record<string, unknown>> }[] = [];
    const controller = createController(async (path, request) => {
      requests.push({ path, method: request.method, ...(request.body === undefined ? {} : { body: request.body }) });
      return path.endsWith("input-draft") ? { revision: 7 } : draftResponse(actions.text, request, 8);
    });
    const capture = controller.beginCapture({ occurrence, action: actions.text, threadRevision: "thread-r1" });
    controller.rateCapture({ ...capture, ratingId: "rating-1" });

    await expect(controller.commit({ captureId: capture.captureId, value: { text: "Exact" } })).resolves.toBe(8);
    expect(requests).toEqual([
      { path: "/api/threads/thread%20one/input-draft", method: "GET" },
      {
        path: "/api/threads/thread%20one/input-draft/attachments",
        method: "PUT",
        body: { occurrence, value: { text: "Exact" }, expectedRevision: 7 },
      },
    ]);
  });

  it("refuses commission when the product response omits the exact committed attachment", async () => {
    const controller = createController(async () => ({ revision: 8, attachments: [] }));
    const capture = controller.beginCapture({ occurrence, action: actions.text, threadRevision: "thread-r1" });
    controller.rateCapture({ ...capture, ratingId: "rating-1" });

    await expect(controller.commit({
      captureId: capture.captureId,
      value: { text: "Exact" },
      expectedRevision: 7,
    })).rejects.toMatchObject({ code: "input_operator_commit_unobserved" });
    expect(controller.state().committedDraftRevision).toBeNull();
  });

  it("holds a commit through capture, releases it after rating, and prevents capture/write interleaving", async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const transport = vi.fn(async (_path, request) => {
      await writeGate;
      return draftResponse(actions.text, request, 1);
    });
    const controller = createController(transport);
    const capture = controller.beginCapture({ occurrence, action: actions.text, threadRevision: "thread-r1" });
    const commit = controller.commit({ captureId: capture.captureId, value: { text: "Exact" }, expectedRevision: 0 });
    await Promise.resolve();
    expect(transport).not.toHaveBeenCalled();
    controller.rateCapture({ ...capture, ratingId: "rating-1" });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    expect(() => controller.beginCapture({ occurrence, action: actions.text, threadRevision: "thread-r2" }))
      .toThrow(expect.objectContaining({ code: "input_operator_write_active" }));
    releaseWrite();
    await commit;
  });

  it("reserves the write fence before waiting for an already-active capture", async () => {
    const transport = vi.fn(async (_path, request) => draftResponse(actions.text, request, 1));
    const controller = createController(transport);
    const commissioned = controller.beginCapture({ occurrence, action: actions.text, threadRevision: "thread-r1" });
    controller.rateCapture({ ...commissioned, ratingId: "rating-1" });
    const blocking = controller.beginCapture({
      occurrence: { ...occurrence, actionId: 14 },
      action: actions.text,
      threadRevision: "thread-r1",
    });

    const commit = controller.commit({ captureId: commissioned.captureId, value: { text: "Exact" }, expectedRevision: 0 });
    await Promise.resolve();
    expect(() => controller.beginCapture({
      occurrence: { ...occurrence, actionId: 15 },
      action: actions.text,
      threadRevision: "thread-r1",
    })).toThrow(expect.objectContaining({ code: "input_operator_write_active" }));
    expect(transport).not.toHaveBeenCalled();

    controller.rateCapture({ ...blocking, ratingId: "rating-2" });
    await expect(commit).resolves.toBe(1);
  });

  it("holds independent capture locks for two input actions on one node and commissions them atomically", async () => {
    const controller = createController(async (_path, request) => draftResponse(actions.text, request, 1));
    const first = controller.beginCapture({ occurrence, action: actions.text, threadRevision: "thread-r1" });
    const secondOccurrence = { ...occurrence, actionId: occurrence.actionId + 1 };
    const second = controller.beginCapture({ occurrence: secondOccurrence, action: actions.text, threadRevision: "thread-r1" });

    expect(controller.state().activeCaptureIds).toEqual([first.captureId, second.captureId]);
    expect(() => controller.rateCaptures([
      { ...first, ratingId: "receipt-1" },
      { ...second, ratingId: "" },
    ])).toThrow(expect.objectContaining({ code: "input_operator_rating_required" }));
    expect(controller.state().captures).toEqual(expect.arrayContaining([
      expect.objectContaining({ captureId: first.captureId, status: "capturing" }),
      expect.objectContaining({ captureId: second.captureId, status: "capturing" }),
    ]));

    controller.rateCaptures([
      { ...first, ratingId: "receipt-1" },
      { ...second, ratingId: "receipt-1" },
    ]);
    expect(controller.state().activeCaptureIds).toEqual([]);
    expect(controller.state().captures).toEqual(expect.arrayContaining([
      expect.objectContaining({ captureId: first.captureId, status: "commissioned" }),
      expect.objectContaining({ captureId: second.captureId, status: "commissioned" }),
    ]));
  });

  it("releases failed and timed-out captures without commissioning writes", async () => {
    vi.useFakeTimers();
    try {
      const transport = vi.fn<InputOperatorTransport["request"]>();
      const failedController = createController(transport);
      const failed = failedController.beginCapture({ occurrence, action: actions.text, threadRevision: "thread-r1" });
      const failedCommit = expect(failedController.commit({ captureId: failed.captureId, value: { text: "Exact" }, expectedRevision: 0 }))
        .rejects.toMatchObject({ code: "input_operator_not_commissioned" });
      failedController.failCapture(failed.captureId);
      await failedCommit;
      expect(failedController.state().captures[0]).toMatchObject({ status: "failed", failure: "capture_failed" });

      const timedController = createController(transport, 10);
      const timed = timedController.beginCapture({ occurrence, action: actions.text, threadRevision: "thread-r2" });
      const timedCommit = expect(timedController.commit({ captureId: timed.captureId, value: { text: "Exact" }, expectedRevision: 0 }))
        .rejects.toMatchObject({ code: "input_operator_not_commissioned" });
      await vi.advanceTimersByTimeAsync(10);
      await timedCommit;
      expect(timedController.state()).toMatchObject({
        activeCaptureId: null,
        captures: [{ status: "failed", failure: "capture_timeout" }],
      });
      expect(transport).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a rating against any revision other than the captured revision", () => {
    const controller = createController(async () => ({ revision: 1 }));
    const capture = controller.beginCapture({ occurrence, action: actions.text, threadRevision: "thread-r1" });
    expect(() => controller.rateCapture({ captureId: capture.captureId, ratingId: "rating-1", threadRevision: "thread-r2" }))
      .toThrow(expect.objectContaining({ code: "input_operator_revision_mismatch" }));
    expect(controller.state().activeCaptureId).toBe(capture.captureId);
    controller.failCapture(capture.captureId);
  });
});

function createController(
  request: InputOperatorTransport["request"],
  captureTimeoutMs = 1_000,
): InputOperatorController {
  return new InputOperatorController({
    authority: { kind: "scoped_product_write", threadId: "thread one", authorityId: "operator-test" },
    transport: { request },
    captureTimeoutMs,
    createId: (() => { let id = 0; return () => `capture-${++id}`; })(),
  });
}

function draftResponse(
  action: InputActionSnapshot,
  request: { readonly body?: Readonly<Record<string, unknown>> },
  revision: number,
) {
  const actionSnapshot = action.control === "text"
    ? { control: action.control, prompt: action.prompt }
    : {
        control: action.control,
        prompt: action.prompt,
        options: action.options,
        ...(action.control === "multi_select" && action.minimumSelections !== undefined
          ? { minimumSelections: action.minimumSelections }
          : {}),
      };
  return {
    revision,
    attachments: [{
      occurrence: request.body!.occurrence,
      action: actionSnapshot,
      value: request.body!.value,
      draftRevision: revision,
    }],
  };
}
