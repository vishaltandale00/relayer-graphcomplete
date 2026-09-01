import { describe, expect, it, vi } from "vitest";

import { extractSteeringDecisionJson, runSimulatedUserSteeringDecision } from "../src/simulated-user/steering-runner.js";

describe("simulated-user steering runner", () => {
  it("parses a JSON decision from a Codex final response without starting a second complete", async () => {
    const run = vi.fn(async () => ({
      finalResponse: "Here you go\n{\"kind\":\"follow-up\",\"text\":\"Please commit the sanitizer fix.\",\"reason\":\"The graph shows the repair but no commit.\"}\n",
    }));
    const decision = await runSimulatedUserSteeringDecision({
      observation: {
        openingPrompt: "Fix the decimal status bug.",
        simulatedUserBrief: "You reported 200.5 failures.",
        humanTurnCount: 1,
        remainingHumanTurns: 5,
        lastTurn: { turnIndex: 0, interactionId: "i0", accepted: true, summary: "Diagnosis of sanitize.ts" },
        steeringPrompt: "Choose the next ordinary product action.",
      },
      threadFactory: { start: () => ({ run }) },
    });
    expect(decision).toEqual({
      kind: "follow-up",
      text: "Please commit the sanitizer fix.",
      reason: "The graph shows the repair but no commit.",
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(String(run.mock.calls.at(0)?.at(0))).toContain("Choose the next ordinary product action.");
  });

  it("rejects a non-object response", () => {
    expect(() => extractSteeringDecisionJson("I think we are done.")).toThrow(/JSON object/);
  });
});
