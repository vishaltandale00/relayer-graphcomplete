import { describe, expect, it } from "vitest";
import {
  actionWasInvoked,
  reconcileActionTransitions,
  visibleLayerAfterRefresh,
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
    )).toBe(false);
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
});
