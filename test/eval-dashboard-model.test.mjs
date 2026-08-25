import { describe, expect, it } from "vitest";

import { annotatedExecutionExportable, runPanelCopy } from "../desktop/eval-renderer/run-model.js";

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

  it("enables annotation export only for durable terminal execution coverage", () => {
    const run = { bundleRef: "runs/run-1/bundle.json" };
    const execution = {
      status: "passed",
      threadIds: [41],
      turns: [{ threadId: 41, interactionId: 51, status: "accepted" }],
    };
    expect(annotatedExecutionExportable(run, execution)).toBe(true);
    expect(annotatedExecutionExportable({ bundleRef: null }, execution)).toBe(false);
    expect(annotatedExecutionExportable(run, { ...execution, status: "running" })).toBe(false);
    expect(annotatedExecutionExportable(run, {
      ...execution,
      turns: [{ threadId: 41, interactionId: 51, status: "submitted" }],
    })).toBe(false);
    expect(annotatedExecutionExportable(run, {
      ...execution,
      threadIds: [41, 42],
    })).toBe(false);
  });
});
