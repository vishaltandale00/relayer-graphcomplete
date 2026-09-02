import { describe, expect, it } from "vitest";
import {
  actionCanRetry,
  actionWasInvoked,
  reconcileActionTransitions,
  visibleLayerAfterRefresh,
  withoutPendingActionInvocation,
} from "../desktop/renderer/src/action-invocation-state.js";

describe("durable action invocation renderer state", () => {
  it("locks invocations once, unlocks only submitted durable results, and clears a single rejected lock", () => {
    expect(actionWasInvoked(
      [{ sourceInteractionId: 1, actionId: 2 }],
      [],
      1,
      2,
    ), "optimistic record locks").toBe(true);
    expect(actionWasInvoked(
      [],
      [{ sourceInteractionId: 1, actionId: 2 }],
      1,
      2,
    ), "durable record locks").toBe(true);
    expect(actionWasInvoked([], [], 1, 2), "no records leave the action unlocked").toBe(false);
    expect(actionWasInvoked(
      [{ sourceInteractionId: 9, actionId: 2 }],
      [],
      1,
      2,
    ), "any source interaction locks the action").toBe(true);

    expect(actionWasInvoked(
      [{ sourceInteractionId: 1, actionId: 2, resultCompletionStatus: "submitted" }],
      [],
      1,
      2,
    ), "submitted durable result unlocks its source pair").toBe(false);
    expect(actionCanRetry(
      [{ sourceInteractionId: 9, actionId: 2, resultCompletionStatus: "submitted" }],
      2,
    ), "submitted result from another source allows retry").toBe(true);
    for (const resultCompletionStatus of ["running", "waiting_for_approval", "accepted", "failed", "stopped"]) {
      const invocations = [{ sourceInteractionId: 1, actionId: 2, resultCompletionStatus }];
      expect(actionWasInvoked(invocations, [], 1, 2), `in-flight ${resultCompletionStatus} keeps the lock`).toBe(true);
      expect(actionCanRetry(invocations, 2), `in-flight ${resultCompletionStatus} blocks retry`).toBe(false);
    }

    expect(withoutPendingActionInvocation([
      { sourceInteractionId: 1, actionId: 2 },
      { sourceInteractionId: 1, actionId: 3 },
      { sourceInteractionId: 4, actionId: 2 },
    ], "1", "2"), "only the rejected action's optimistic lock is cleared").toEqual([
      { sourceInteractionId: 1, actionId: 3 },
      { sourceInteractionId: 4, actionId: 2 },
    ]);
  });

  it("holds selection through action transitions and refreshes the visible layer without pulling the user back", () => {
    const source = { id: 1, completionStatus: "accepted" };
    const running = { id: 2, completionStatus: "running" };
    const transitions = new Map([[2, 1]]);
    const pending = reconcileActionTransitions([source, running], source, transitions);
    expect(pending.selected, "source stays selected while the result runs").toBe(source);
    expect(pending.transitions.size, "pending transition retained").toBe(1);

    const accepted = { ...running, completionStatus: "accepted" };
    const completed = reconcileActionTransitions([source, accepted], source, transitions);
    expect(completed.selected, "acceptance advances selection to the result").toBe(accepted);
    expect(completed.transitions.size, "transition consumed").toBe(0);

    const elsewhere = { id: 3, completionStatus: "accepted" };
    const acceptedElsewhere = { id: 2, completionStatus: "accepted" };
    const failed = { id: 2, completionStatus: "failed" };
    expect(
      reconcileActionTransitions([source, acceptedElsewhere, elsewhere], elsewhere, transitions).selected,
      "navigation away is respected",
    ).toBe(elsewhere);
    expect(
      reconcileActionTransitions([source, failed], source, transitions).selected,
      "failure never advances selection",
    ).toBe(source);

    const nested = { layer: { id: 22 }, nodes: [{ id: 8 }] };
    const nestedSource = {
      id: 1,
      completionOutput: { rootLayer: { layer: { id: 11 }, nodes: [{ id: 7 }] } },
    };
    const nestedResult = {
      id: 2,
      completionOutput: { rootLayer: { layer: { id: 33 }, nodes: [{ id: 9 }] } },
    };
    expect(visibleLayerAfterRefresh(1, nested, nestedSource), "nested layer kept while polling the source").toBe(nested);
    expect(visibleLayerAfterRefresh(1, nested, nestedResult), "nested layer replaced once the result arrives").toBe(nestedResult.completionOutput.rootLayer);

    const staleRoot = {
      layer: { id: 11 },
      actions: [{ id: 4, kind: "invoke", targetLayerId: null }],
    };
    const canonicalRoot = {
      layer: { id: 11 },
      actions: [{ id: 4, kind: "invoke", targetLayerId: 33 }],
    };
    const resolvedSource = {
      id: 1,
      completionOutput: { rootLayer: canonicalRoot },
    };
    expect(visibleLayerAfterRefresh(1, staleRoot, resolvedSource), "visible root replaced by the canonical resolved-action refresh").toBe(canonicalRoot);
  });
});
