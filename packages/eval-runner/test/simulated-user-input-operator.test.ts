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

    const matrix = [
      ["text", actions.text, { text: "Preserve occurrence identity" }],
      ["single-select", actions.single, { selectedKeys: ["b"] }],
      ["multi-select canonicalization", actions.multi, { selectedKeys: ["proof-b", "proof-a"] }],
    ] as const;
    expect(matrix.map(([label]) => label), "valid input inventory").toEqual([
      "text", "single-select", "multi-select canonicalization",
    ]);
    for (const [index, [, action, value]] of matrix.entries()) {
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

  it("validates optional, required, malformed, duplicate, and unknown input values before transport", async () => {
    const optional: InputActionSnapshot = {
      control: "multi_select",
      prompt: "Choose optional evidence",
      options: [{ key: "proof", label: "Proof" }],
    };
    const optionalRequest = vi.fn<InputOperatorTransport["request"]>(async (_path, request) => (
      draftResponse(optional, request, 1)
    ));
    const optionalController = createController(optionalRequest);
    const optionalCapture = optionalController.beginCapture({ occurrence, action: optional, threadRevision: "optional-r0" });
    optionalController.rateCapture({ ...optionalCapture, ratingId: "optional-rating" });

    const invalid = [
      ["required multi empty", actions.multi, { selectedKeys: [] }, "input_selection_count"],
      ["selection value for text", actions.text, { selectedKeys: ["a"] }, "input_text_blank"],
      ["blank text", actions.text, { text: "  " }, "input_text_blank"],
      ["multiple single-select values", actions.single, { selectedKeys: ["a", "b"] }, "input_selection_count"],
      ["unknown single-select option", actions.single, { selectedKeys: ["missing"] }, "input_option_unknown"],
      ["duplicate multi-select option", actions.multi, { selectedKeys: ["proof-a", "proof-a"] }, "input_option_duplicate"],
      ["below multi-select minimum", actions.multi, { selectedKeys: ["proof-a"] }, "input_selection_count"],
    ] as const;
    const results = await Promise.all(invalid.map(async ([label, action, value, code], index) => {
      const transport = vi.fn<InputOperatorTransport["request"]>();
      const controller = createController(transport);
      const capture = controller.beginCapture({ occurrence, action, threadRevision: `r-${index}` });
      controller.rateCapture({ ...capture, ratingId: `rating-${index}` });
      try {
        await controller.commit({ captureId: capture.captureId, value, expectedRevision: 0 });
        return { label, code, observed: null, transportCalls: transport.mock.calls.length };
      } catch (error) {
        return { label, code, observed: (error as { code?: string }).code ?? null, transportCalls: transport.mock.calls.length };
      }
    }));

    await expect(optionalController.commit({
      captureId: optionalCapture.captureId,
      value: { selectedKeys: [] },
      expectedRevision: 0,
    })).resolves.toBe(1);
    expect(optionalRequest).toHaveBeenCalledWith(
      "/api/threads/thread%20one/input-draft/attachments",
      expect.objectContaining({ body: expect.objectContaining({ value: { selectedKeys: [] } }) }),
    );
    expect(invalid.map(([label]) => label), "invalid input inventory").toEqual([
      "required multi empty",
      "selection value for text",
      "blank text",
      "multiple single-select values",
      "unknown single-select option",
      "duplicate multi-select option",
      "below multi-select minimum",
    ]);
    for (const result of results) {
      expect.soft(result.observed, result.label).toBe(result.code);
      expect.soft(result.transportCalls, `${result.label}: pre-transport`).toBe(0);
    }
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
    expect(sendBodies[1]!.inputDraftRevision).toBe(sendBodies[0]!.inputDraftRevision);
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

  it("reads the current revision and requires the exact committed attachment before commissioning", async () => {
    const requests: { path: string; method: string; body?: Readonly<Record<string, unknown>> }[] = [];
    const observedController = createController(async (path, request) => {
      requests.push({ path, method: request.method, ...(request.body === undefined ? {} : { body: request.body }) });
      return path.endsWith("input-draft") ? { revision: 7 } : draftResponse(actions.text, request, 8);
    });
    const observedCapture = observedController.beginCapture({ occurrence, action: actions.text, threadRevision: "thread-r1" });
    observedController.rateCapture({ ...observedCapture, ratingId: "rating-1" });
    const observedCommit = observedController.commit({ captureId: observedCapture.captureId, value: { text: "Exact" } });

    const missingController = createController(async () => ({ revision: 8, attachments: [] }));
    const missingCapture = missingController.beginCapture({ occurrence, action: actions.text, threadRevision: "thread-r1" });
    missingController.rateCapture({ ...missingCapture, ratingId: "rating-1" });
    const missingCommit = missingController.commit({
      captureId: missingCapture.captureId,
      value: { text: "Exact" },
      expectedRevision: 7,
    });

    const [observed, missing] = await Promise.allSettled([observedCommit, missingCommit]);
    expect.soft(observed, "current revision acquisition").toEqual({ status: "fulfilled", value: 8 });
    expect.soft(requests, "current revision request sequence").toEqual([
      { path: "/api/threads/thread%20one/input-draft", method: "GET" },
      {
        path: "/api/threads/thread%20one/input-draft/attachments",
        method: "PUT",
        body: { occurrence, value: { text: "Exact" }, expectedRevision: 7 },
      },
    ]);
    expect.soft(missing.status, "exact committed attachment").toBe("rejected");
    if (missing.status === "rejected") {
      expect.soft(missing.reason, "exact committed attachment error").toMatchObject({ code: "input_operator_commit_unobserved" });
    }
    expect.soft(missingController.state().committedDraftRevision, "unobserved commit state").toBeNull();
  });

  it("reserves one write fence across active captures, rating settlement, and transport", async () => {
    const sameTarget = async () => {
      let releaseWrite!: () => void;
      const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
      const transport = vi.fn(async (_path, request) => {
        await writeGate;
        return draftResponse(actions.text, request, 1);
      });
      const controller = createController(transport);
      const settling = controller.beginCapture({ occurrence, action: actions.text, threadRevision: "thread-r1" });
      const commit = controller.commit({ captureId: settling.captureId, value: { text: "Exact" }, expectedRevision: 0 });
      const commitResult = commit.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason) => ({ status: "rejected" as const, reason }),
      );
      try {
        await Promise.resolve();
        const beforeRating = controller.state();
        const callsBeforeRating = transport.mock.calls.length;
        controller.rateCapture({ ...settling, ratingId: "rating-1" });
        await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
        const captureDuringTransport = settleSync(() => controller.beginCapture({
          occurrence: { ...occurrence, actionId: 15 },
          action: actions.text,
          threadRevision: "thread-r2",
        }));
        releaseWrite();
        return { beforeRating, callsBeforeRating, captureDuringTransport, commit: await commitResult };
      } finally {
        releaseWrite();
      }
    };

    const preWaitFence = async () => {
      let releaseWrite!: () => void;
      const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
      const transport = vi.fn(async (_path, request) => {
        await writeGate;
        return draftResponse(actions.text, request, 1);
      });
      const controller = createController(transport);
      const commissioned = controller.beginCapture({ occurrence, action: actions.text, threadRevision: "thread-r1" });
      controller.rateCapture({ ...commissioned, ratingId: "rating-1" });
      const blocking = controller.beginCapture({
        occurrence: { ...occurrence, actionId: 14 },
        action: actions.text,
        threadRevision: "thread-r1",
      });
      const commit = controller.commit({ captureId: commissioned.captureId, value: { text: "Exact" }, expectedRevision: 0 });
      const commitResult = commit.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason) => ({ status: "rejected" as const, reason }),
      );
      try {
        await Promise.resolve();
        const beforeBlockingRating = controller.state();
        const callsBeforeBlockingRating = transport.mock.calls.length;
        const captureBeforeBlockingRating = settleSync(() => controller.beginCapture({
          occurrence: { ...occurrence, actionId: 15 },
          action: actions.text,
          threadRevision: "thread-r2",
        }));
        controller.rateCapture({ ...blocking, ratingId: "rating-2" });
        await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
        releaseWrite();
        return {
          beforeBlockingRating,
          callsBeforeBlockingRating,
          captureBeforeBlockingRating,
          commit: await commitResult,
        };
      } finally {
        releaseWrite();
      }
    };

    const [sameTargetResult, preWaitResult] = await Promise.allSettled([sameTarget(), preWaitFence()]);
    expect.soft(sameTargetResult.status, "same-target settlement").toBe("fulfilled");
    if (sameTargetResult.status === "fulfilled") {
      expect.soft(sameTargetResult.value.beforeRating, "same-target waits for rating").toMatchObject({
        writeInFlight: false,
        activeCaptureId: "capture-1",
        captures: [{ captureId: "capture-1", status: "capturing" }],
      });
      expect.soft(sameTargetResult.value.callsBeforeRating, "same-target pre-rating transport").toBe(0);
      expect.soft(sameTargetResult.value.captureDuringTransport, "same-target transport fence").toMatchObject({
        status: "rejected",
        reason: { code: "input_operator_write_active" },
      });
      expect.soft(sameTargetResult.value.commit, "same-target commit").toEqual({ status: "fulfilled", value: 1 });
    }
    expect.soft(preWaitResult.status, "pre-wait fence settlement").toBe("fulfilled");
    if (preWaitResult.status === "fulfilled") {
      expect.soft(preWaitResult.value.beforeBlockingRating.writeInFlight, "pre-wait fence reservation").toBe(true);
      expect.soft(preWaitResult.value.callsBeforeBlockingRating, "pre-wait transport exclusion").toBe(0);
      expect.soft(preWaitResult.value.captureBeforeBlockingRating, "pre-wait capture exclusion").toMatchObject({
        status: "rejected",
        reason: { code: "input_operator_write_active" },
      });
      expect.soft(preWaitResult.value.commit, "pre-wait commit").toEqual({ status: "fulfilled", value: 1 });
    }
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

  it("rejects stale ratings and releases failed or timed-out captures without writes", async () => {
    vi.useFakeTimers();
    try {
      const staleTransport = vi.fn<InputOperatorTransport["request"]>();
      const staleController = createController(staleTransport);
      const stale = staleController.beginCapture({ occurrence, action: actions.text, threadRevision: "thread-r1" });
      const staleRating = settleSync(() => staleController.rateCapture({
        captureId: stale.captureId,
        ratingId: "stale-rating",
        threadRevision: "thread-r2",
      }));
      const staleState = staleController.state();
      staleController.failCapture(stale.captureId);

      const failedTransport = vi.fn<InputOperatorTransport["request"]>();
      const failedController = createController(failedTransport);
      const failed = failedController.beginCapture({ occurrence, action: actions.text, threadRevision: "thread-r1" });
      const failedCommit = settlePromise(failedController.commit({
        captureId: failed.captureId,
        value: { text: "Exact" },
        expectedRevision: 0,
      }));

      const timedTransport = vi.fn<InputOperatorTransport["request"]>();
      const timedController = createController(timedTransport, 10);
      const timed = timedController.beginCapture({ occurrence, action: actions.text, threadRevision: "thread-r2" });
      const timedCommit = settlePromise(timedController.commit({
        captureId: timed.captureId,
        value: { text: "Exact" },
        expectedRevision: 0,
      }));

      failedController.failCapture(failed.captureId);
      await vi.advanceTimersByTimeAsync(10);
      const [failedSettlement, timedSettlement] = await Promise.all([failedCommit, timedCommit]);

      expect.soft(staleRating, "captured revision authority").toMatchObject({
        status: "rejected",
        reason: { code: "input_operator_revision_mismatch" },
      });
      expect.soft(staleState, "stale rating preserves capture authority").toMatchObject({
        activeCaptureId: stale.captureId,
        captures: [{ captureId: stale.captureId, status: "capturing", failure: null }],
      });
      expect.soft(failedSettlement, "failed capture commit").toMatchObject({
        status: "rejected",
        reason: { code: "input_operator_not_commissioned" },
      });
      expect.soft(failedController.state().captures[0], "failed capture release").toMatchObject({ status: "failed", failure: "capture_failed" });
      expect.soft(timedSettlement, "timed capture commit").toMatchObject({
        status: "rejected",
        reason: { code: "input_operator_not_commissioned" },
      });
      expect.soft(timedController.state(), "timed capture release").toMatchObject({
        activeCaptureId: null,
        captures: [{ status: "failed", failure: "capture_timeout" }],
      });
      expect.soft(staleTransport, "stale rating transport").not.toHaveBeenCalled();
      expect.soft(failedTransport, "failed capture transport").not.toHaveBeenCalled();
      expect.soft(timedTransport, "timed capture transport").not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

function settleSync<Output>(operation: () => Output):
  | { readonly status: "fulfilled"; readonly value: Output }
  | { readonly status: "rejected"; readonly reason: unknown } {
  try {
    return { status: "fulfilled", value: operation() };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

function settlePromise<Output>(operation: Promise<Output>): Promise<
  | { readonly status: "fulfilled"; readonly value: Output }
  | { readonly status: "rejected"; readonly reason: unknown }
> {
  return operation.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
}

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
