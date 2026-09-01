import { describe, expect, it, vi } from "vitest";

import { parseSteeringDecision, runSteeredInteractionLoop } from "../src/simulated-user/steered-loop.js";

function turn(turnIndex: number, interactionId: string, accepted = true): {
  readonly turnIndex: number;
  readonly interactionId: string;
  readonly accepted: boolean;
  readonly summary: string;
} {
  return { turnIndex, interactionId, accepted, summary: `turn ${turnIndex}` };
}

describe("simulated-user steered interaction loop", () => {
  it("runs one opening complete, then simulated-user follow-ups until done", async () => {
    const runOpening = vi.fn(async () => turn(0, "i0"));
    const runFollowUp = vi.fn(async (text: string) => turn(1, `follow:${text}`));
    const reviewTurn = vi.fn(async (record: { readonly summary: string }) => ({ summary: record.summary }));
    const decide = vi.fn()
      .mockResolvedValueOnce({ kind: "follow-up", text: "Please add the string case and commit.", reason: "Repair is visible but uncommitted." })
      .mockResolvedValueOnce({ kind: "done", reason: "The committed repair matches the visible diagnosis." });

    const result = await runSteeredInteractionLoop({
      interactionVariant: "multi-turn",
      openingPrompt: "Cancellation is poisoning the pool.",
      simulatedUserBrief: "You saw later requests fail after cancel.",
      maxHumanTurns: 4,
    }, { runOpening, runFollowUp, reviewTurn, decide });

    expect(runOpening).toHaveBeenCalledWith("Cancellation is poisoning the pool.");
    expect(runFollowUp).toHaveBeenCalledWith("Please add the string case and commit.");
    expect(result.terminal).toBe("done");
    expect(result.turns.map((entry) => entry.interactionId)).toEqual(["i0", "follow:Please add the string case and commit."]);
    expect(result.decisions.map((entry) => entry.kind)).toEqual(["follow-up", "done"]);
    expect(decide.mock.calls[0]![0].steeringPrompt).toContain("simulated-user-steering-prompt-v1");
    expect(reviewTurn).toHaveBeenCalledTimes(2);
  });

  it("stops without a second complete when the opening turn is not accepted", async () => {
    const result = await runSteeredInteractionLoop({
      interactionVariant: "multi-turn",
      openingPrompt: "Investigate the failure.",
      simulatedUserBrief: "You reported the 200.5 status.",
    }, {
      runOpening: async () => turn(0, "failed", false),
      reviewTurn: async () => ({ summary: "unused" }),
      decide: async () => ({ kind: "follow-up", text: "continue", reason: "should not run" }),
      runFollowUp: async () => turn(1, "should-not-run"),
    });
    expect(result).toMatchObject({ terminal: "unaccepted-turn", decisions: [], turns: [{ interactionId: "failed" }] });
  });

  it("records budget exhaustion after the last allowed human turn", async () => {
    let followUps = 0;
    const result = await runSteeredInteractionLoop({
      interactionVariant: "multi-turn",
      openingPrompt: "Build the planner.",
      simulatedUserBrief: "You will keep asking for the missing exception view.",
      maxHumanTurns: 2,
    }, {
      runOpening: async () => turn(0, "open"),
      reviewTurn: async (record) => ({ summary: record.summary }),
      decide: async () => ({ kind: "follow-up", text: `more-${++followUps}`, reason: "Still missing exceptions." }),
      runFollowUp: async (text) => turn(1, text),
    });
    expect(result.terminal).toBe("budget-exhausted");
    expect(result.turns).toHaveLength(2);
    expect(result.decisions).toHaveLength(1);
  });

  it("rejects malformed steering objects before sending another complete", () => {
    expect(() => parseSteeringDecision({ kind: "follow-up", reason: "x" })).toThrow(/next user message/);
    expect(() => parseSteeringDecision({ kind: "done" })).toThrow(/reason/);
  });
});
