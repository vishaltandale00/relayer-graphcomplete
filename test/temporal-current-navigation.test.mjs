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
  it("replaces the followed pointer without adding history and drops absent selection", () => {
    const result = reconcileCurrentProjection({
      completionId: 7,
      revision: 1,
      lifecycle: "active",
      currentLayerId: 11,
      finalLayerId: null,
      mode: "following",
      visibleTarget: { kind: "layer", completionId: 7, layerId: 11 },
      selectedNodeId: 2,
    }, event);
    expect(result.kind).toBe("followed");
    expect(result.history).toBe("replace");
    expect(result.view.visibleTarget.layerId).toBe(12);
    expect(result.view.selectedNodeId).toBeNull();
  });

  it("updates pointer truth without displacing an explicitly pinned view", () => {
    const pinned = { kind: "layer", completionId: 7, layerId: 9 };
    const result = reconcileCurrentProjection({
      completionId: 7,
      revision: 1,
      lifecycle: "active",
      currentLayerId: 11,
      finalLayerId: null,
      mode: "pinned",
      visibleTarget: pinned,
      selectedNodeId: 2,
    }, event);
    expect(result.kind).toBe("pinned");
    expect(result.history).toBe("unchanged");
    expect(result.view.visibleTarget).toBe(pinned);
    expect(result.view.currentLayerId).toBe(12);
  });

  it("requests resync for a predecessor gap and ignores duplicate revisions", () => {
    const view = { completionId: 7, revision: 1 };
    expect(reconcileCurrentProjection(view, { ...event, previousRevision: 0 }).kind).toBe("resync");
    expect(reconcileCurrentProjection(view, { ...event, revision: 1 }).kind).toBe("stale");
  });
});
