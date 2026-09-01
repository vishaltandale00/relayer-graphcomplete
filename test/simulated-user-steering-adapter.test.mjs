import { describe, expect, it, vi } from "vitest";

import { createLocalSimulatedUserSteeringRunner } from "../desktop/eval-main/simulated-user-judge.mjs";

describe("local Electron simulated-user steering adapter", () => {
  it("turns an accepted-graph summary into a Codex steering decision", async () => {
    const runSteering = vi.fn(async (input) => {
      expect(input.codexPathOverride).toBe("/managed/codex");
      expect(input.observation.steeringPrompt).toContain("simulated-user-steering-prompt-v1");
      expect(input.observation.lastTurn.summary).toContain("sanitize.ts");
      return { kind: "follow-up", text: "Please add the string case and commit.", reason: "Repair is visible but uncommitted." };
    });
    const decide = createLocalSimulatedUserSteeringRunner({
      resolveCodexRuntime: async () => ({ executablePath: "/managed/codex" }),
      runSteering,
    });
    await expect(decide({
      openingPrompt: "Fix the decimal status bug.",
      simulatedUserBrief: "You reported 200.5 failures.",
      remainingHumanTurns: 4,
      lastTurnSummary: "The graph names sanitize.ts.",
      interactionId: "turn-1",
    })).resolves.toEqual({
      kind: "follow-up",
      text: "Please add the string case and commit.",
      reason: "Repair is visible but uncommitted.",
    });
    expect(runSteering).toHaveBeenCalledTimes(1);
  });
});
