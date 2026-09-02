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
  it("commits text, single-select, and multi-select values through the exact product route", async () => {
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

    expect(requests.map(({ path }) => path), "every commit uses the input-draft attachment route").toEqual([
      "/api/threads/thread%20one/input-draft/attachments",
      "/api/threads/thread%20one/input-draft/attachments",
      "/api/threads/thread%20one/input-draft/attachments",
    ]);
    expect(requests[0]!.request, "text commits carry the occurrence identity and expected revision").toEqual({
      method: "PUT",
      body: { occurrence, value: { text: "Preserve occurrence identity" }, expectedRevision: 4 },
    });
    expect(requests[1]!.request.body!.value, "single-select commits carry the selected key").toEqual({ selectedKeys: ["b"] });
    expect(requests[2]!.request.body!.value, "multi-select commits are canonicalized").toEqual({ selectedKeys: ["proof-a", "proof-b"] });

    const optimisticRequests: { path: string; method: string; body?: Readonly<Record<string, unknown>> }[] = [];
    const optimistic = createController(async (path, request) => {
      optimisticRequests.push({ path, method: request.method, ...(request.body === undefined ? {} : { body: request.body }) });
      return path.endsWith("input-draft") ? { revision: 7 } : draftResponse(actions.text, request, 8);
    });
    const optimisticCapture = optimistic.beginCapture({ occurrence, action: actions.text, threadRevision: "thread-r1" });
    optimistic.rateCapture({ ...optimisticCapture, ratingId: "rating-1" });
    await expect(
      optimistic.commit({ captureId: optimisticCapture.captureId, value: { text: "Exact" } }),
      "a commit without an expected revision reads the current draft revision first",
    ).resolves.toBe(8);
    expect(optimisticRequests, "the optimistic commit is GET input-draft then PUT attachment").toEqual([
      { path: "/api/threads/thread%20one/input-draft", method: "GET" },
      {
        path: "/api/threads/thread%20one/input-draft/attachments",
        method: "PUT",
        body: { occurrence, value: { text: "Exact" }, expectedRevision: 7 },
      },
    ]);

    const unobserved = createController(async () => ({ revision: 8, attachments: [] }));
    const unobservedCapture = unobserved.beginCapture({ occurrence, action: actions.text, threadRevision: "thread-r1" });
    unobserved.rateCapture({ ...unobservedCapture, ratingId: "rating-1" });
    await expect(unobserved.commit({
      captureId: unobservedCapture.captureId,
      value: { text: "Exact" },
      expectedRevision: 7,
    }), "commission is refused when the product response omits the exact committed attachment").rejects.toMatchObject({
      code: "input_operator_commit_unobserved",
    });
    expect(unobserved.state().committedDraftRevision, "an unobserved commit records no draft revision").toBeNull();
  });

  it("sends only after a commissioned commit and retries with a stable Send identity", async () => {
    const requests: { path: string; request: unknown }[] = [];
    const controller = createController(async (path, request) => {
      requests.push({ path, request });
      return path.endsWith("attachments") ? draftResponse(actions.text, request, 8) : { id: 99 };
    });
    await expect(
      controller.send({ inputId: "attempt-1" }),
      "send before any commissioned commit is rejected",
    ).rejects.toMatchObject({ code: "input_operator_commit_required" });
    const capture = controller.beginCapture({ occurrence, action: actions.text, threadRevision: "thread-r1" });
    controller.rateCapture({ ...capture, ratingId: "rating-1" });
    await controller.commit({ captureId: capture.captureId, value: { text: "Exact" }, expectedRevision: 7 });
    await expect(controller.send({ inputId: "attempt-1" }), "send after a commissioned commit succeeds").resolves.toEqual({ id: 99 });
    expect(requests[1], "the Send body carries the returned draft revision").toEqual({
      path: "/api/threads/thread%20one/interactions",
      request: {
        method: "POST",
        body: { text: "", inputId: "attempt-1", inputDraftRevision: 8 },
      },
    });
    await expect(
      controller.send({ inputId: "attempt-1" }),
      "the same commit cannot be sent twice",
    ).rejects.toMatchObject({ code: "input_operator_commit_required" });

    const sendBodies: Readonly<Record<string, unknown>>[] = [];
    let sendAttempts = 0;
    const retryController = createController(async (path, request) => {
      if (path.endsWith("attachments")) return draftResponse(actions.text, request, 8);
      sendBodies.push(request.body!);
      sendAttempts += 1;
      if (sendAttempts === 1) throw new Error("response lost after product acceptance");
      return { id: 99 };
    });
    const retryCapture = retryController.beginCapture({ occurrence, action: actions.text, threadRevision: "thread-r1" });
    retryController.rateCapture({ ...retryCapture, ratingId: "rating-1" });
    await retryController.commit({ captureId: retryCapture.captureId, value: { text: "Exact" }, expectedRevision: 7 });
    await expect(
      retryController.send({}),
      "an ambiguous response loss surfaces the transport error",
    ).rejects.toThrow("response lost after product acceptance");
    await expect(retryController.send({}), "the retry succeeds").resolves.toEqual({ id: 99 });
    expect(sendBodies, "exactly one Send identity is generated across the retry").toHaveLength(2);
    expect(sendBodies[0]!.inputId, "the generated Send identity").toBe("capture-2");
    expect(sendBodies[1]!.inputId, "the retry reuses the generated Send identity").toBe(sendBodies[0]!.inputId);
    expect(sendBodies[1]!.inputDraftRevision, "the retry reuses the committed draft revision").toBe(sendBodies[0]!.inputDraftRevision);

    const fenceController = createController(async (path, request) => (
      path.endsWith("attachments") ? draftResponse(actions.text, request, 8) : { id: 99 }
    ));
    const commissioned = fenceController.beginCapture({ occurrence, action: actions.text, threadRevision: "thread-r1" });
    fenceController.rateCapture({ ...commissioned, ratingId: "rating-1" });
    await fenceController.commit({ captureId: commissioned.captureId, value: { text: "Exact" }, expectedRevision: 7 });
    const blocking = fenceController.beginCapture({
      occurrence: { ...occurrence, actionId: 14 },
      action: actions.text,
      threadRevision: "thread-r1",
    });

    const send = fenceController.send({});
    await Promise.resolve();
    expect(fenceController.state().writeInFlight, "the write fence is reserved while the capture settles").toBe(true);
    await expect(
      fenceController.send({}),
      "a concurrent Send is rejected while the fence is held",
    ).rejects.toMatchObject({ code: "input_operator_write_active" });
    fenceController.rateCapture({ ...blocking, ratingId: "rating-2" });
    await expect(send, "the fenced Send resolves once the blocking capture settles").resolves.toEqual({ id: 99 });
  });

  it("gates captures and writes behind rating, identity, and selection rules", async () => {
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
      await expect(
        controller.commit({ captureId: capture.captureId, value, expectedRevision: 0 }),
        `invalid value (${code}) is rejected before transport`,
      ).rejects.toMatchObject({ code });
    }
    expect(request, "no invalid value ever reaches transport").not.toHaveBeenCalled();

    const optional: InputActionSnapshot = {
      control: "multi_select",
      prompt: "Choose optional evidence",
      options: [{ key: "proof", label: "Proof" }],
    };
    const optionalRequest = vi.fn<InputOperatorTransport["request"]>(async (_path, requestBody) => (
      draftResponse(optional, requestBody, 1)
    ));
    const optionalController = createController(optionalRequest);
    const optionalCapture = optionalController.beginCapture({ occurrence, action: optional, threadRevision: "optional-r0" });
    optionalController.rateCapture({ ...optionalCapture, ratingId: "optional-rating" });
    await expect(optionalController.commit({
      captureId: optionalCapture.captureId,
      value: { selectedKeys: [] },
      expectedRevision: 0,
    }), "an optional multi-select accepts an empty selection").resolves.toBe(1);
    expect(optionalRequest, "the empty selection reaches transport").toHaveBeenCalledWith(
      "/api/threads/thread%20one/input-draft/attachments",
      expect.objectContaining({ body: expect.objectContaining({ value: { selectedKeys: [] } }) }),
    );

    const requiredRequest = vi.fn<InputOperatorTransport["request"]>();
    const requiredController = createController(requiredRequest);
    const requiredCapture = requiredController.beginCapture({ occurrence, action: actions.multi, threadRevision: "required-r0" });
    requiredController.rateCapture({ ...requiredCapture, ratingId: "required-rating" });
    await expect(requiredController.commit({
      captureId: requiredCapture.captureId,
      value: { selectedKeys: [] },
      expectedRevision: 0,
    }), "an authored minimum selection count is enforced").rejects.toMatchObject({ code: "input_selection_count" });
    expect(requiredRequest, "an under-minimum selection never reaches transport").not.toHaveBeenCalled();

    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const heldTransport = vi.fn(async (_path, writeRequest) => {
      await writeGate;
      return draftResponse(actions.text, writeRequest, 1);
    });
    const heldController = createController(heldTransport);
    const heldCapture = heldController.beginCapture({ occurrence, action: actions.text, threadRevision: "thread-r1" });
    const heldCommit = heldController.commit({ captureId: heldCapture.captureId, value: { text: "Exact" }, expectedRevision: 0 });
    await Promise.resolve();
    expect(heldTransport, "an unrated capture holds its commit at the write fence").not.toHaveBeenCalled();
    heldController.rateCapture({ ...heldCapture, ratingId: "rating-1" });
    await vi.waitFor(() => expect(heldTransport, "rating releases the held commit").toHaveBeenCalledTimes(1));
    expect(
      () => heldController.beginCapture({ occurrence, action: actions.text, threadRevision: "thread-r2" }),
      "a new capture cannot interleave an in-flight write",
    ).toThrow(expect.objectContaining({ code: "input_operator_write_active" }));
    releaseWrite();
    await heldCommit;

    const orderedTransport = vi.fn(async (_path, orderedRequest) => draftResponse(actions.text, orderedRequest, 1));
    const orderedController = createController(orderedTransport);
    const orderedCommissioned = orderedController.beginCapture({ occurrence, action: actions.text, threadRevision: "thread-r1" });
    orderedController.rateCapture({ ...orderedCommissioned, ratingId: "rating-1" });
    const orderedBlocking = orderedController.beginCapture({
      occurrence: { ...occurrence, actionId: 14 },
      action: actions.text,
      threadRevision: "thread-r1",
    });
    const orderedCommit = orderedController.commit({ captureId: orderedCommissioned.captureId, value: { text: "Exact" }, expectedRevision: 0 });
    await Promise.resolve();
    expect(
      () => orderedController.beginCapture({ occurrence: { ...occurrence, actionId: 15 }, action: actions.text, threadRevision: "thread-r1" }),
      "the write fence is reserved before waiting for an already-active capture",
    ).toThrow(expect.objectContaining({ code: "input_operator_write_active" }));
    expect(orderedTransport, "the fenced commit waits for the active capture").not.toHaveBeenCalled();
    orderedController.rateCapture({ ...orderedBlocking, ratingId: "rating-2" });
    await expect(orderedCommit, "the commit completes once every active capture is rated").resolves.toBe(1);

    const dualController = createController(async (_path, dualRequest) => draftResponse(actions.text, dualRequest, 1));
    const first = dualController.beginCapture({ occurrence, action: actions.text, threadRevision: "thread-r1" });
    const secondOccurrence = { ...occurrence, actionId: occurrence.actionId + 1 };
    const second = dualController.beginCapture({ occurrence: secondOccurrence, action: actions.text, threadRevision: "thread-r1" });
    expect(dualController.state().activeCaptureIds, "two input actions on one node hold independent capture locks").toEqual([first.captureId, second.captureId]);
    expect(
      () => dualController.rateCaptures([
        { ...first, ratingId: "receipt-1" },
        { ...second, ratingId: "" },
      ]),
      "every capture in a batch requires a rating receipt",
    ).toThrow(expect.objectContaining({ code: "input_operator_rating_required" }));
    expect(dualController.state().captures, "a failed batch rating leaves both captures active").toEqual(expect.arrayContaining([
      expect.objectContaining({ captureId: first.captureId, status: "capturing" }),
      expect.objectContaining({ captureId: second.captureId, status: "capturing" }),
    ]));
    dualController.rateCaptures([
      { ...first, ratingId: "receipt-1" },
      { ...second, ratingId: "receipt-1" },
    ]);
    expect(dualController.state().activeCaptureIds, "rated captures release their locks atomically").toEqual([]);
    expect(dualController.state().captures, "both captures are commissioned together").toEqual(expect.arrayContaining([
      expect.objectContaining({ captureId: first.captureId, status: "commissioned" }),
      expect.objectContaining({ captureId: second.captureId, status: "commissioned" }),
    ]));

    const revisionController = createController(async () => ({ revision: 1 }));
    const revisionCapture = revisionController.beginCapture({ occurrence, action: actions.text, threadRevision: "thread-r1" });
    expect(
      () => revisionController.rateCapture({ captureId: revisionCapture.captureId, ratingId: "rating-1", threadRevision: "thread-r2" }),
      "a rating against any revision other than the captured revision is rejected",
    ).toThrow(expect.objectContaining({ code: "input_operator_revision_mismatch" }));
    expect(revisionController.state().activeCaptureId, "the mismatched rating leaves the capture active").toBe(revisionCapture.captureId);
    revisionController.failCapture(revisionCapture.captureId);

    vi.useFakeTimers();
    try {
      const silentTransport = vi.fn<InputOperatorTransport["request"]>();
      const failedController = createController(silentTransport);
      const failed = failedController.beginCapture({ occurrence, action: actions.text, threadRevision: "thread-r1" });
      const failedCommit = expect(
        failedController.commit({ captureId: failed.captureId, value: { text: "Exact" }, expectedRevision: 0 }),
        "a failed capture releases its pending commit",
      ).rejects.toMatchObject({ code: "input_operator_not_commissioned" });
      failedController.failCapture(failed.captureId);
      await failedCommit;
      expect(failedController.state().captures[0], "the failed capture is recorded without commissioning").toMatchObject({
        status: "failed",
        failure: "capture_failed",
      });

      const timedController = createController(silentTransport, 10);
      const timed = timedController.beginCapture({ occurrence, action: actions.text, threadRevision: "thread-r2" });
      const timedCommit = expect(
        timedController.commit({ captureId: timed.captureId, value: { text: "Exact" }, expectedRevision: 0 }),
        "a timed-out capture releases its pending commit",
      ).rejects.toMatchObject({ code: "input_operator_not_commissioned" });
      await vi.advanceTimersByTimeAsync(10);
      await timedCommit;
      expect(timedController.state(), "the timeout releases the capture without commissioning").toMatchObject({
        activeCaptureId: null,
        captures: [{ status: "failed", failure: "capture_timeout" }],
      });
      expect(silentTransport, "failed and timed-out captures never reach transport").not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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
