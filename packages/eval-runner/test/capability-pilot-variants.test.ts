import { describe, expect, it } from "vitest";

import {
  capabilityPilotFamily,
  capabilityPilotFamilyIds,
  capabilityPilotVariantFamilies,
  capabilityPilotVariantMembers,
  CAPABILITY_PILOT_SUITE_ID,
} from "../src/project-cases/capability-pilot-variants.js";
import {
  buildSimulatedUserSteeringPrompt,
  isSteeredMultiTurn,
  requireSingleOpeningPrompt,
  steeredMaxHumanTurns,
} from "../src/project-cases/interaction-variants.js";

describe("capability-pilot interaction variants", () => {
  it("defines one single-turn and one steered multi-turn member for each of the ten families", () => {
    expect(CAPABILITY_PILOT_SUITE_ID).toBe("harness-capability-pilot-v1");
    expect(capabilityPilotFamilyIds).toHaveLength(10);
    expect(capabilityPilotVariantFamilies.map((entry) => entry.familyId)).toEqual([...capabilityPilotFamilyIds]);
    expect(capabilityPilotVariantMembers).toHaveLength(20);
    expect(capabilityPilotVariantFamilies.filter((entry) => entry.fixtureStatus === "external-admitted")).toHaveLength(5);
    expect(capabilityPilotVariantFamilies.filter((entry) => entry.fixtureStatus === "external-candidate")).toHaveLength(5);

    for (const family of capabilityPilotVariantFamilies) {
      const single = family.members["single-turn"];
      const steered = family.members["in-turn-steered"];
      expect(single.caseId).toBe(`${family.familyId}.single-turn`);
      expect(steered.caseId).toBe(`${family.familyId}.multi-turn`);
      expect(single.caseType).toBe("single-turn");
      expect(steered.caseType).toBe("in-turn-steered");
      expect(single.variant).toBe("single-turn");
      expect(steered.variant).toBe("multi-turn");
      expect(single.executableInRelayerEval).toBe(false);
      expect(steered.executableInRelayerEval).toBe(false);
      expect(single.openingPrompt.length).toBeGreaterThan(80);
      expect(steered.openingPrompt.length).toBeGreaterThan(80);
      expect(single.openingPrompt).not.toBe(steered.openingPrompt);
      expect(single.simulatedUserBrief).toBeUndefined();
      expect(steered.simulatedUserBrief?.length).toBeGreaterThan(80);
      expect(steered.maxHumanTurns).toBeGreaterThanOrEqual(2);
      expect(single.openingPrompt).not.toMatch(/\blayer\b|graph\.submit|verifier/i);
      expect(steered.openingPrompt).not.toMatch(/graph\.submit|verifier/i);
    }
  });

  it("keeps steered follow-ups out of the opening prompt list", () => {
    const httpcore = capabilityPilotFamily("autonomous.httpcore.cancellation-poisoned-pool");
    expect(requireSingleOpeningPrompt([httpcore.members["single-turn"].openingPrompt], "single-turn"))
      .toContain("one-slot connection pool");
    expect(requireSingleOpeningPrompt([httpcore.members["in-turn-steered"].openingPrompt], "in-turn-steered"))
      .toContain("I will follow along");
    expect(() => requireSingleOpeningPrompt(["one", "two"], "in-turn-steered")).toThrow(/exactly one opening prompt/);
    expect(isSteeredMultiTurn({ interactionVariant: "multi-turn" })).toBe(true);
    expect(isSteeredMultiTurn({ interactionVariant: "single-turn" })).toBe(false);
    expect(steeredMaxHumanTurns(httpcore.members["in-turn-steered"])).toBe(6);
    expect(steeredMaxHumanTurns(capabilityPilotFamily("capability.spreadsheet.saas-operating-model").members["in-turn-steered"]))
      .toBe(10);
  });

  it("builds a user-role steering prompt that forbids a second in-flight human root", () => {
    const prompt = buildSimulatedUserSteeringPrompt({
      openingPrompt: "Fix the pool.",
      simulatedUserBrief: "You saw later requests fail after cancel.",
      remainingHumanTurns: 3,
      currentSummary: "The graph names the connect-cancel window.",
      completionStatus: "running",
    });
    expect(prompt).toContain("simulated-user-steering-prompt-v2");
    expect(prompt).toContain("cannot write graph records");
    expect(prompt).toContain("second human-root");
    expect(prompt).toContain("Remaining in-flight actions including wait: 3");
    expect(prompt).toContain("Do not send a composer follow-up");
    expect(prompt).toContain("Visible working state is the live steering surface");
    expect(prompt).not.toContain("You already explored");
    expect(prompt).not.toContain("review tools");
  });
});
