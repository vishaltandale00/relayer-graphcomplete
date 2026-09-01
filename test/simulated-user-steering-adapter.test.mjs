import { describe, expect, it, vi } from "vitest";

import { createLocalSimulatedUserSteeringRunner } from "../desktop/eval-main/simulated-user-judge.mjs";

describe("local Electron simulated-user steering adapter", () => {
  it("turns a published-current summary into a Codex in-flight steering decision", async () => {
    const runSteering = vi.fn(async (input) => {
      expect(input.codexPathOverride).toBe("/managed/codex");
      expect(input.observation.steeringPrompt).toContain("simulated-user-steering-prompt-v2");
      expect(input.observation.snapshot.currentSummary).toContain("sanitize.ts");
      expect(input.observation.snapshot.completionStatus).toBe("running");
      return {
        kind: "commit-input",
        target: "node:status-example",
        text: "200.5 fails",
        reason: "The current asks which statuses fail.",
      };
    });
    const decide = createLocalSimulatedUserSteeringRunner({
      resolveCodexRuntime: async () => ({ executablePath: "/managed/codex" }),
      runSteering,
    });
    await expect(decide({
      openingPrompt: "Fix the decimal status bug.",
      simulatedUserBrief: "You reported 200.5 failures.",
      remainingHumanTurns: 4,
      currentSummary: "The graph names sanitize.ts.",
      completionStatus: "running",
      interactionId: "turn-1",
    })).resolves.toEqual({
      kind: "commit-input",
      target: "node:status-example",
      text: "200.5 fails",
      reason: "The current asks which statuses fail.",
    });
    expect(runSteering).toHaveBeenCalledTimes(1);
  });
});
