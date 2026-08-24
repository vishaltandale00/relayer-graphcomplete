import { describe, expect, it } from "vitest";

import { runPanelCopy } from "../desktop/eval-renderer/run-model.js";

describe("Eval dashboard run presentation", () => {
  it("presents imported runs as external conversation review", () => {
    expect(runPanelCopy({ kind: "imported-conversation" })).toEqual({
      title: "Conversation review",
      description: "Open the immutable external conversation in the read-only production workspace or review its eligible judge results.",
    });
  });

  it("retains case and harness language for local matrix runs", () => {
    expect(runPanelCopy({ kind: "local-eval" })).toEqual({
      title: "Test cases",
      description: "Open the judge review or the read-only production workspace for one case × harness execution.",
    });
  });
});
