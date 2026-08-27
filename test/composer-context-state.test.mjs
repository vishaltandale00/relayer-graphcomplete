import { describe, expect, it } from "vitest";

import {
  createComposerContextState,
  transitionComposerContextState,
} from "../desktop/renderer/src/product-workspace/workspace.js";

describe("composer context state", () => {
  it("increments revisions for user replacements", () => {
    const value = [{ target: { nodeId: 7 }, node: { id: 7 }, annotations: ["draft"] }];
    const replaced = transitionComposerContextState(createComposerContextState(), {
      type: "user_replace",
      value,
    });

    expect(replaced).toEqual({ value, revision: 1 });
  });

  it("adopts submission settlement values and revisions", () => {
    const settled = transitionComposerContextState(createComposerContextState(), {
      type: "settlement",
      field: { value: [], revision: 4 },
    });

    expect(settled).toEqual({ value: [], revision: 4 });
  });

  it("clears contexts and advances the revision on thread changes", () => {
    const replaced = transitionComposerContextState(createComposerContextState(), {
      type: "user_replace",
      value: [{ target: { nodeId: 7 }, node: { id: 7 }, annotations: [] }],
    });
    const cleared = transitionComposerContextState(replaced, {
      type: "thread_change",
    });

    expect(cleared).toEqual({ value: [], revision: 2 });
  });
});
