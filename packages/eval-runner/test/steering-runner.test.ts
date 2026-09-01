import { describe, expect, it, vi } from "vitest";

import { extractSteeringDecisionJson, runSimulatedUserSteeringDecision } from "../src/simulated-user/steering-runner.js";

describe("simulated-user steering runner", () => {
  it("parses a JSON decision from a Codex final response without starting a second complete", async () => {
    const run = vi.fn(async () => ({
      finalResponse: "Here you go\n{\"kind\":\"commit-input\",\"target\":\"node:status-example\",\"text\":\"200.5 fails in production\",\"reason\":\"The current asks which statuses fail.\"}\n",
    }));
    const decision = await runSimulatedUserSteeringDecision({
      observation: {
        openingPrompt: "Fix the decimal status bug.",
        simulatedUserBrief: "You reported 200.5 failures.",
        remainingHumanTurns: 5,
        snapshot: {
          interactionId: "i0",
          completionStatus: "running",
          terminal: false,
          currentSummary: "Diagnosis of sanitize.ts",
        },
        steeringPrompt: "Choose the next ordinary product action.",
      },
      threadFactory: { start: () => ({ run }) },
    });
    expect(decision).toEqual({
      kind: "commit-input",
      target: "node:status-example",
      text: "200.5 fails in production",
      reason: "The current asks which statuses fail.",
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(String(run.mock.calls.at(0)?.at(0))).toContain("Choose the next ordinary product action.");
  });

  it("rejects a non-object response", () => {
    expect(() => extractSteeringDecisionJson("I think we are done.")).toThrow(/JSON object/);
  });
});
