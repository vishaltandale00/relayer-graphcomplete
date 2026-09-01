import { describe, expect, it, vi } from "vitest";

import {
  parseSteeringDecision,
  resolvePublishedCurrentTarget,
  runSteeredInteractionLoop,
  summarizePublishedCurrent,
} from "../src/simulated-user/steered-loop.js";

function snapshot(
  interactionId: string,
  completionStatus: string,
  currentSummary: string,
): {
  readonly interactionId: string;
  readonly completionStatus: string;
  readonly terminal: boolean;
  readonly currentSummary: string;
} {
  return {
    interactionId,
    completionStatus,
    terminal: completionStatus === "accepted" || completionStatus === "failed" || completionStatus === "stopped",
    currentSummary,
  };
}

describe("simulated-user steered interaction loop", () => {
  it("starts one complete and steers on published current before that root accepts", async () => {
    const statuses = ["running", "running", "accepted"];
    const startOpening = vi.fn(async () => ({ interactionId: "root-1" }));
    const observe = vi.fn(async () => snapshot("root-1", statuses.shift() ?? "accepted", "Current names sanitize.ts"));
    const apply = vi.fn(async () => undefined);
    const waitForChange = vi.fn(async () => undefined);
    const decide = vi.fn()
      .mockResolvedValueOnce({
        kind: "commit-input",
        target: "node:status-example",
        text: "200.5 and the string 200.5 both fail",
        reason: "The current asks which statuses fail.",
      })
      .mockResolvedValueOnce({ kind: "wait", reason: "The current is advancing." });

    const result = await runSteeredInteractionLoop({
      interactionVariant: "multi-turn",
      openingPrompt: "Repair the decimal status bug.",
      simulatedUserBrief: "You reported the 200.5 production failure.",
      maxHumanTurns: 4,
    }, { startOpening, observe, decide, apply, waitForChange });

    expect(startOpening).toHaveBeenCalledWith("Repair the decimal status bug.");
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "commit-input", target: "node:status-example" }),
      expect.objectContaining({ completionStatus: "running" }),
    );
    expect(result.terminal).toBe("accepted");
    expect(result.decisions.map((entry) => entry.kind)).toEqual(["commit-input", "wait"]);
    expect(decide.mock.calls[0]![0].steeringPrompt).toContain("simulated-user-steering-prompt-v2");
    expect(decide.mock.calls[0]![0].snapshot.completionStatus).toBe("running");
  });

  it("stops without a second human root when the opening turn fails", async () => {
    const result = await runSteeredInteractionLoop({
      interactionVariant: "multi-turn",
      openingPrompt: "Investigate the failure.",
      simulatedUserBrief: "You reported the 200.5 status.",
    }, {
      startOpening: async () => ({ interactionId: "failed" }),
      observe: async () => snapshot("failed", "failed", "Turn failed."),
      decide: async () => ({ kind: "wait", reason: "should not run" }),
      apply: async () => undefined,
      waitForChange: async () => undefined,
    });
    expect(result).toMatchObject({ terminal: "unaccepted-turn", decisions: [], interactionId: "failed" });
  });

  it("records budget exhaustion after the last allowed in-flight action, then waits for settlement", async () => {
    let observes = 0;
    const result = await runSteeredInteractionLoop({
      interactionVariant: "multi-turn",
      openingPrompt: "Build the planner.",
      simulatedUserBrief: "You will keep answering current inputs.",
      maxHumanTurns: 2,
    }, {
      startOpening: async () => ({ interactionId: "open" }),
      observe: async () => {
        observes += 1;
        return snapshot("open", observes <= 3 ? "running" : "accepted", "Current still open.");
      },
      decide: async () => ({ kind: "wait", reason: "Still missing exceptions." }),
      apply: async () => undefined,
      waitForChange: async () => undefined,
    });
    expect(result.terminal).toBe("budget-exhausted");
    expect(result.decisions).toHaveLength(2);
  });

  it("summarizes many current nodes and actions for in-flight steering", () => {
    const summary = summarizePublishedCurrent("running", {
      threadId: "thread-1",
      interactionId: "root-1",
      graphNodeId: 1,
      layerId: 10,
      nodes: [
        { id: 2, title: "Diagnose sanitize.ts", detail: "Which statuses fail?" },
        { id: 3, title: "Repair plan" },
      ],
      actions: [
        { id: 301, kind: "input", label: "status-example", prompt: "Which statuses fail?", sourceNodeId: 2 },
        { id: 302, kind: "invoke", label: "Run focused tests", sourceNodeId: 3 },
      ],
    });
    expect(summary).toContain("Turn running");
    expect(summary).toContain("Diagnose sanitize.ts");
    expect(summary).toContain("input status-example");
    expect(summary).toContain("invoke Run focused tests");
    expect(resolvePublishedCurrentTarget({
      threadId: "thread-1",
      interactionId: "root-1",
      graphNodeId: 1,
      layerId: 10,
      nodes: [{ id: 2, title: "Diagnose sanitize.ts" }],
      actions: [{ id: 301, kind: "input", label: "status-example", sourceNodeId: 2 }],
    }, "node:status-example", "input").action).toMatchObject({ id: 301, kind: "input" });
  });

  it("rejects composer follow-up objects before sending another complete", () => {
    expect(() => parseSteeringDecision({ kind: "follow-up", text: "continue", reason: "x" }))
      .toThrow(/wait, navigate, commit-input, invoke, or abandon/);
    expect(() => parseSteeringDecision({ kind: "commit-input", reason: "x" })).toThrow(/target/);
    expect(() => parseSteeringDecision({ kind: "wait" })).toThrow(/reason/);
  });
});
