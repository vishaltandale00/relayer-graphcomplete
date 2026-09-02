import { describe, expect, it } from "vitest";

import {
  createComposerContextState,
  transitionComposerContextState,
} from "../desktop/renderer/src/product-workspace/workspace.js";

describe("composer context state", () => {
  it("replaces, clears, and settles contexts through one advancing revision chain", () => {
    const value = [{ target: { nodeId: 7 }, node: { id: 7 }, annotations: ["draft"] }];
    let state = createComposerContextState();
    expect(state, "fresh state").toEqual({ value: [], revision: 0 });

    state = transitionComposerContextState(state, { type: "user_replace", value });
    expect(state, "user replacement increments the revision").toEqual({ value, revision: 1 });

    state = transitionComposerContextState(state, { type: "thread_change" });
    expect(state, "thread change clears contexts and advances the revision").toEqual({ value: [], revision: 2 });

    state = transitionComposerContextState(state, {
      type: "user_replace",
      value: [{ target: { nodeId: 7 }, node: { id: 7 }, annotations: [] }],
    });
    state = transitionComposerContextState(state, {
      type: "settlement",
      field: { value: [], revision: 4 },
    });
    expect(state, "settlement adopts the submitted value and revision").toEqual({ value: [], revision: 4 });

    state = transitionComposerContextState(state, {
      type: "user_replace",
      value: [{ target: { nodeId: 8 }, node: { id: 8 }, annotations: [] }],
    });
    expect(state, "revisions continue from the adopted settlement revision").toEqual({
      value: [{ target: { nodeId: 8 }, node: { id: 8 }, annotations: [] }],
      revision: 5,
    });
  });
});
