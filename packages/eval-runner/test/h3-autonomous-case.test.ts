import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { h3AutonomousCases, h3SanitizeInteractionFamily, h3VerifierDigest } from "../src/index.js";

describe("h3 autonomous seed cases", () => {
  it("binds one concise autonomous prompt to each frozen case", () => {
    expect(h3AutonomousCases).toHaveLength(3);
    expect(h3AutonomousCases.map((entry) => entry.snapshot.category)).toEqual(["coding", "coding", "work"]);
    expect(h3AutonomousCases.map((entry) => entry.definition.caseType)).toEqual([
      "single-turn",
      "in-turn-steered",
      undefined,
    ]);
    expect(h3AutonomousCases.map((entry) => entry.definition.interactionVariant)).toEqual([
      "single-turn",
      "multi-turn",
      undefined,
    ]);
    expect(h3AutonomousCases.every((entry) => entry.snapshot.authoringStatus === "candidate")).toBe(true);
    expect(h3AutonomousCases.every((entry) => entry.definition.autonomous)).toBe(true);
    expect(h3AutonomousCases.every((entry) => (
      entry.definition.threads.length === 1 && entry.definition.threads[0]!.prompts.length === 1
    ))).toBe(true);
    expect(JSON.stringify(h3AutonomousCases.map((entry) => entry.catalogSnapshot))).not.toContain("sealedPath");
  });

  it("keeps the steered H3 repair on the same verifier as the one-shot repair", () => {
    const single = h3AutonomousCases[0]!;
    const steered = h3AutonomousCases[1]!;
    expect(h3SanitizeInteractionFamily.familyId).toBe("autonomous.h3.sanitize-status-code");
    expect(h3SanitizeInteractionFamily.executableInRelayerEval).toBe(true);
    expect(h3SanitizeInteractionFamily.members["single-turn"].caseId).toBe(single.definition.id);
    expect(h3SanitizeInteractionFamily.members["in-turn-steered"].caseId).toBe(steered.definition.id);
    expect(h3SanitizeInteractionFamily.members["in-turn-steered"].caseType).toBe("in-turn-steered");
    expect(steered.definition.id).toBe("autonomous.h3.sanitize-status-code.multi-turn");
    expect(steered.definition.caseType).toBe("in-turn-steered");
    expect(steered.definition.requiredJudgeConfigurationIds).toEqual(["simulated-user", "simulated-user-sol-high"]);
    expect(steered.definition.simulatedUserBrief).toContain("200.5");
    expect(steered.definition.maxHumanTurns).toBe(6);
    expect(steered.definition.threads[0]!.prompts[0]).not.toBe(single.definition.threads[0]!.prompts[0]);
    expect(steered.snapshot.artifacts.verifier.contentDigest).toBe(single.snapshot.artifacts.verifier.contentDigest);
    expect(steered.snapshot.artifacts.workspace.contentDigest).toBe(single.snapshot.artifacts.workspace.contentDigest);
    expect(steered.snapshotDigest).not.toBe(single.snapshotDigest);
  });

  it("pins the sealed reference and verifier descriptors to the checked-in artifacts", async () => {
    const repositoryRoot = resolve(import.meta.dirname, "../../..");
    for (const entry of h3AutonomousCases) {
      const reference = entry.snapshot.artifacts.reference;
      const contents = await readFile(resolve(repositoryRoot, reference.sealedPath));
      expect(`sha256:${createHash("sha256").update(contents).digest("hex")}`).toBe(reference.contentDigest);
      expect(entry.snapshot.artifacts.verifier.contentDigest).toBe(h3VerifierDigest());
    }
  });
});
