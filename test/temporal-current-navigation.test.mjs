import { describe, expect, it } from "vitest";

import { reconcileCurrentProjection } from "../desktop/renderer/src/product-workspace/model.js";

const event = {
  completionId: 7,
  previousRevision: 1,
  revision: 2,
  lifecycle: "active",
  currentLayerId: 12,
  finalLayerId: null,
  safeReason: null,
  currentNodeIds: [3],
};

describe("temporal current navigation", () => {
  it("reconciles the temporal current pointer across follow, pin, gap, and stale events", () => {
    const followed = reconcileCurrentProjection({
      completionId: 7,
      revision: 1,
      lifecycle: "active",
      currentLayerId: 11,
      finalLayerId: null,
      mode: "following",
      visibleTarget: { kind: "layer", completionId: 7, layerId: 11 },
      selectedNodeId: 2,
    }, event);
    expect(followed.kind, "followed pointer advances in place").toBe("followed");
    expect(followed.history, "followed pointer replaces history instead of pushing").toBe("replace");
    expect(followed.view.visibleTarget.layerId, "followed pointer tracks the current layer").toBe(12);
    expect(followed.view.selectedNodeId, "selection absent from the new layer is dropped").toBeNull();

    const pinned = { kind: "layer", completionId: 7, layerId: 9 };
    const pinnedResult = reconcileCurrentProjection({
      completionId: 7,
      revision: 1,
      lifecycle: "active",
      currentLayerId: 11,
      finalLayerId: null,
      mode: "pinned",
      visibleTarget: pinned,
      selectedNodeId: 2,
    }, event);
    expect(pinnedResult.kind, "pinned view is not displaced by pointer truth").toBe("pinned");
    expect(pinnedResult.history, "pinned view leaves history unchanged").toBe("unchanged");
    expect(pinnedResult.view.visibleTarget, "pinned layer target is retained").toBe(pinned);
    expect(pinnedResult.view.currentLayerId, "pointer truth still updates under a pin").toBe(12);

    const view = { completionId: 7, revision: 1 };
    expect(reconcileCurrentProjection(view, { ...event, previousRevision: 0 }).kind,
      "predecessor gap requests a resync").toBe("resync");
    expect(reconcileCurrentProjection(view, { ...event, revision: 1 }).kind,
      "duplicate revision is ignored as stale").toBe("stale");
  });
});
