import { describe, expect, it } from "vitest";
import { appendLayerPath } from "../desktop/renderer/src/product-workspace/model.js";
import {
  actionCanRetry,
  recoverableActionInvocation,
  recoverActionInvocation,
  mergeActionInvocation,
  actionWasInvoked,
  reconcileActionTransitions,
  visibleLayerAfterRefresh,
  withoutPendingActionInvocation,
} from "../desktop/renderer/src/action-invocation-state.js";

describe("durable action invocation renderer state", () => {
  it("retains the canonical single-call Invoke breadcrumb without changing its definition", () => {
    const action = { id: 2, kind: "invoke", sourceNodeId: 7, label: "Analyze", reusable: false };
    const source = { id: 7, title: "Comparison" };
    expect(appendLayerPath([], action, source, 201)).toEqual([{ layerId: 201, label: "Comparison", icon: null, actionId: 2, sourceNodeId: 7 }]);
    expect(action.targetLayerId).toBeUndefined();
    expect(appendLayerPath([], { ...action, reusable: true }, source, 201)).toEqual([]);
    expect(appendLayerPath([], action, source)).toEqual([]);
  });
  it("locks explicit single-call sources without reinterpreting historical durable call flags", () => {
    for (const resultCompletionStatus of ["submitted", "running", "accepted", "failed", "stopped"]) {
      const calls = [{ actionId: 2, reusable: true, resultCompletionStatus }];
      expect(actionWasInvoked(calls, [], 1, 2, false)).toBe(true);
      expect(actionWasInvoked(calls, [], 1, 2, true)).toBe(false);
      expect(actionWasInvoked(calls, [], 1, 2, undefined)).toBe(false);
      expect(actionWasInvoked(calls, [], 1, 3, false)).toBe(false);
    }
  });
  it("recovers the exact gesture key even when another call completes concurrently", () => {
    const first = {sourceInteractionId:1,actionId:2,resultInteractionId:10,reusable:true,invocationKey:"call-a"};
    const other = {...first,resultInteractionId:11,invocationKey:"call-b"};
    expect(recoverActionInvocation([other,first],1,2,"call-a")).toBe(first);
    expect(recoverActionInvocation([other],1,2,"call-a")).toBeUndefined();
    expect(mergeActionInvocation([first],other)).toEqual([first,other]);
    expect(mergeActionInvocation([first,other],{...first,resultCompletionStatus:"accepted"})).toHaveLength(2);
  });
  it("identifies durable single calls independently of their reuse policy", () => {
    const first = { sourceInteractionId: 1, actionId: 2, resultInteractionId: 10, durable: true, reusable: false, invocationKey: "first", preparationRecoverable: true, resultCompletionStatus: "submitted" };
    const other = { ...first, resultInteractionId: 11, invocationKey: "other" };
    expect(recoverActionInvocation([other, first], 1, 2, "first")).toBe(first);
    expect(recoverActionInvocation([other], 1, 2, "first")).toBeUndefined();
    expect(mergeActionInvocation([first], other)).toEqual([first, other]);
    expect(actionCanRetry([first], 2)).toBe(true);
    expect(actionWasInvoked([first], [], 1, 2, false)).toBe(false);
    expect(actionWasInvoked([first], [], 9, 2, false)).toBe(true);
    expect(actionWasInvoked([{ ...first, invocationKey: undefined }], [], 1, 2, false)).toBe(true);
    expect(actionWasInvoked([{ ...first, preparationRecoverable: undefined }], [], 1, 2, false)).toBe(true);
    expect(actionWasInvoked([first], [], 1, 2, true)).toBe(false);
  });
  it("recovers only trusted no-effect preparation failures with their frozen key", () => {
    const call = { sourceInteractionId: 1, actionId: 2, durable: true, reusable: false,
      resultCompletionStatus: "failed", invocationKey: "frozen", preparationRecoverable: true };
    expect(actionCanRetry([call], 2)).toBe(true);
    expect(actionWasInvoked([call], [], 1, 2, false)).toBe(false);
    for (const change of [{ preparationRecoverable: false }, { invocationKey: undefined }, { resultCompletionStatus: "stopped" }]) {
      expect(actionCanRetry([{ ...call, ...change }], 2)).toBe(false);
      expect(actionWasInvoked([{ ...call, ...change }], [], 1, 2, false)).toBe(true);
    }
  });
  it("allows a fresh corrected request only for a proven unprepared rejection", () => {
    const rejected = { sourceInteractionId: 1, actionId: 2, resultInteractionId: 10, durable: false,
      reusable: false, invocationKey: "rejected-key", preparationRejected: true,
      preparationRecoverable: false, resultCompletionStatus: "failed" };
    expect(actionWasInvoked([rejected], [], 1, 2, false)).toBe(false);
    expect(actionCanRetry([rejected], 2)).toBe(false);
    expect(recoverableActionInvocation([rejected], 1, 2)).toBeUndefined();
    expect(actionWasInvoked([rejected], [{ sourceInteractionId: 1, actionId: 2 }], 1, 2, false)).toBe(true);
    for (const change of [{ preparationRejected: undefined }, { durable: true },
      { invocationKey: "legacy" }, { invocationKey: undefined }, { resultCompletionStatus: "stopped" },
      { resultCompletionStatus: "running" }]) {
      expect(actionWasInvoked([{ ...rejected, ...change }], [], 1, 2, false)).toBe(true);
    }
    const spent = { ...rejected, preparationRejected: false, invocationKey: "spent", durable: true };
    expect(actionWasInvoked([rejected, spent], [], 1, 2, false)).toBe(true);
    const corrected = { ...spent, resultInteractionId: 11 };
    expect(mergeActionInvocation([rejected], corrected)).toEqual([rejected, corrected]);
  });
  it("keeps reusable calls independently readable without locking their callable", () => {
    const calls = [
      { actionId: 2, resultInteractionId: 10, resultCompletionStatus: "accepted", reusable: true },
      { actionId: 2, resultInteractionId: 11, resultCompletionStatus: "running", reusable: true },
    ];
    expect(actionWasInvoked(calls, [], 1, 2)).toBe(false);
    expect(actionCanRetry(calls, 2)).toBe(false);
    expect(actionWasInvoked(calls, [{ sourceInteractionId: 1, actionId: 2 }], 1, 2)).toBe(true);
  });
  it("treats optimistic and durable records as one-shot locks", () => {
    expect(actionWasInvoked(
      [{ sourceInteractionId: 1, actionId: 2 }],
      [],
      1,
      2,
    )).toBe(true);
    expect(actionWasInvoked(
      [],
      [{ sourceInteractionId: 1, actionId: 2 }],
      1,
      2,
    )).toBe(true);
    expect(actionWasInvoked([], [], 1, 2)).toBe(false);
    expect(actionWasInvoked(
      [{ sourceInteractionId: 9, actionId: 2 }],
      [],
      1,
      2,
    )).toBe(true);
  });

  it("unlocks only submitted durable invocations for source-pair recovery", () => {
    expect(actionWasInvoked(
      [{ sourceInteractionId: 1, actionId: 2, resultCompletionStatus: "submitted" }],
      [],
      1,
      2,
    )).toBe(false);
    expect(actionCanRetry(
      [{ sourceInteractionId: 9, actionId: 2, resultCompletionStatus: "submitted" }],
      2,
    )).toBe(true);
    for (const resultCompletionStatus of ["running", "waiting_for_approval", "accepted", "failed", "stopped"]) {
      const invocations = [{ sourceInteractionId: 1, actionId: 2, resultCompletionStatus }];
      expect(actionWasInvoked(invocations, [], 1, 2)).toBe(true);
      expect(actionCanRetry(invocations, 2)).toBe(false);
    }
  });

  it("clears only the rejected action's optimistic lock", () => {
    expect(withoutPendingActionInvocation([
      { sourceInteractionId: 1, actionId: 2 },
      { sourceInteractionId: 1, actionId: 3 },
      { sourceInteractionId: 4, actionId: 2 },
    ], "1", "2")).toEqual([
      { sourceInteractionId: 1, actionId: 3 },
      { sourceInteractionId: 4, actionId: 2 },
    ]);
  });

  it("keeps the source selected while running and advances it only on acceptance", () => {
    const source = { id: 1, completionStatus: "accepted" };
    const running = { id: 2, completionStatus: "running" };
    const transitions = new Map([[2, 1]]);
    const pending = reconcileActionTransitions([source, running], source, transitions);
    expect(pending.selected).toBe(source);
    expect(pending.transitions.size).toBe(1);

    const accepted = { ...running, completionStatus: "accepted" };
    const completed = reconcileActionTransitions([source, accepted], source, transitions);
    expect(completed.selected).toBe(accepted);
    expect(completed.transitions.size).toBe(0);
  });

  it("does not pull the user back after navigation and does not advance failures", () => {
    const source = { id: 1, completionStatus: "accepted" };
    const elsewhere = { id: 3, completionStatus: "accepted" };
    const accepted = { id: 2, completionStatus: "accepted" };
    const failed = { id: 2, completionStatus: "failed" };
    const transitions = new Map([[2, 1]]);

    expect(
      reconcileActionTransitions([source, accepted, elsewhere], elsewhere, transitions).selected,
    ).toBe(elsewhere);
    expect(reconcileActionTransitions([source, failed], source, transitions).selected).toBe(source);
  });

  it("keeps a nested source layer during polling but resets it after a turn transition", () => {
    const nested = { layer: { id: 22 }, nodes: [{ id: 8 }] };
    const source = {
      id: 1,
      completionOutput: { rootLayer: { layer: { id: 11 }, nodes: [{ id: 7 }] } },
    };
    const result = {
      id: 2,
      completionOutput: { rootLayer: { layer: { id: 33 }, nodes: [{ id: 9 }] } },
    };
    expect(visibleLayerAfterRefresh(1, nested, source)).toBe(nested);
    expect(visibleLayerAfterRefresh(1, nested, result)).toBe(result.completionOutput.rootLayer);
  });

  it("replaces a visible root with its canonical resolved-action refresh", () => {
    const staleRoot = {
      layer: { id: 11 },
      actions: [{ id: 4, kind: "invoke", targetLayerId: null }],
    };
    const canonicalRoot = {
      layer: { id: 11 },
      actions: [{ id: 4, kind: "invoke", targetLayerId: 33 }],
    };
    const selected = {
      id: 1,
      completionOutput: { rootLayer: canonicalRoot },
    };
    expect(visibleLayerAfterRefresh(1, staleRoot, selected)).toBe(canonicalRoot);
  });
});
