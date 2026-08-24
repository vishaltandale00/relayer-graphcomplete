import { describe, expect, it } from "vitest";
import {
  actionCanRetry,
  actionWasInvoked,
  reconcileActionTransitions,
  visibleLayerAfterRefresh,
  withoutPendingActionInvocation,
} from "../desktop/renderer/src/action-invocation-state.js";

describe("durable action invocation renderer state", () => {
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
