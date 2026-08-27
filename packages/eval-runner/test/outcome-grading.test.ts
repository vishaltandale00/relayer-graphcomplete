import { describe, expect, it } from "vitest";

import {
  aggregatePresentationLayers,
  buildGraphPresentationGrade,
  buildRecursiveGraphPresentationGrade,
  buildTaskOutcomeGrade,
  projectDeterministicChecksToOutcome,
  type PresentationLayerGrade,
} from "../src/index.js";

describe("task-outcome grading", () => {
  it("keeps mandatory qualification independent from the weighted rubric score", () => {
    const result = buildTaskOutcomeGrade({
      status: "completed",
      mandatoryGates: [{
        schemaVersion: 1,
        gateId: "hidden-tests",
        name: "Hidden behavior tests",
        mandatory: true,
        status: "completed",
        passed: false,
        detail: "One behavior failed.",
        evidenceRefs: ["gate/hidden-tests.json"],
      }],
      criteria: [
        { criterionId: "coverage", rating: 4, weight: 3, rationale: "Broad coverage.", evidenceRefs: [] },
        { criterionId: "quality", rating: 2, weight: 1, rationale: "Material weakness.", evidenceRefs: [] },
      ],
    });

    expect(result.qualified).toBe(false);
    expect(result.score).toBe(3.5);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("projects deterministic checks into mandatory receipts without inventing a score", () => {
    const result = projectDeterministicChecksToOutcome([
      { name: "workspace:hidden behavior", passed: true, detail: "Passed." },
      { name: "workspace:clean", passed: true, detail: "Clean." },
    ]);

    expect(result).toMatchObject({ status: "completed", qualified: true, score: null });
    expect(result.mandatoryGates.map((gate) => gate.gateId)).toEqual([
      "workspace:hidden-behavior",
      "workspace:clean",
    ]);
    expect(projectDeterministicChecksToOutcome([])).toMatchObject({
      status: "unjudged",
      qualified: null,
      score: null,
    });
  });

  it("leaves qualification undetermined while semantic rubric grading is partial", () => {
    const result = buildTaskOutcomeGrade({
      status: "partial",
      mandatoryGates: [{
        schemaVersion: 1,
        gateId: "artifact",
        name: "Artifact integrity",
        mandatory: true,
        status: "completed",
        passed: true,
        detail: "The artifact exists.",
        evidenceRefs: ["artifact/report.md"],
      }],
      criteria: [{
        criterionId: "accuracy",
        rating: null,
        weight: 1,
        rationale: "No semantic judge rating has been recorded.",
        evidenceRefs: [],
      }],
    });

    expect(result).toMatchObject({ status: "partial", qualified: null, score: null });
  });

  it("does not confuse verifier infrastructure failure with a failed candidate gate", () => {
    const result = buildTaskOutcomeGrade({
      status: "completed",
      mandatoryGates: [{
        schemaVersion: 1,
        gateId: "verifier",
        name: "Verifier",
        mandatory: true,
        status: "failed",
        passed: null,
        detail: "Verifier process crashed.",
        evidenceRefs: [],
      }],
    });
    expect(result.qualified).toBe(false);
    expect(() => buildTaskOutcomeGrade({
      status: "completed",
      mandatoryGates: [{
        schemaVersion: 1,
        gateId: "bad",
        name: "Bad",
        mandatory: true,
        status: "failed",
        passed: false,
        detail: "Invalid receipt.",
        evidenceRefs: [],
      }],
    })).toThrow("must use a null result");
  });
});

describe("graph-presentation grading", () => {
  it("normalizes decay mass across present depths and divides it within each depth", () => {
    const layers = [
      layer("root", 0, [4, 4]),
      layer("child-a", 1, [2, 2]),
      layer("child-b", 1, [4, 4]),
      layer("grandchild", 2, [1, 1], true),
    ];
    const aggregation = aggregatePresentationLayers(layers);

    // Depth masses at decay .5 are 1, .5, .25 => 4/7, 2/7, 1/7.
    expect(aggregation).toEqual([
      expect.objectContaining({ layerId: "root", score: 4, assignedWeight: 0.571429 }),
      expect.objectContaining({ layerId: "child-a", score: 2, assignedWeight: 0.142857 }),
      expect.objectContaining({ layerId: "child-b", score: 4, assignedWeight: 0.142857 }),
      expect.objectContaining({ layerId: "grandchild", score: 1, assignedWeight: 0.142857 }),
    ]);

    const result = buildGraphPresentationGrade({ status: "completed", layers });
    expect(result.score).toBeCloseTo(23 / 7, 5);
    expect(result.worstLayer).toEqual({ layerId: "grandchild", depth: 2, score: 1 });
    expect(result.hasMateriallyMisleadingLayer).toBe(true);
  });

  it("renormalizes assessable layer weights while preserving assigned depth weights", () => {
    const aggregation = aggregatePresentationLayers([
      layer("root", 0, [4]),
      layer("child", 1, [null]),
    ]);
    expect(aggregation).toEqual([
      expect.objectContaining({ layerId: "root", assignedWeight: 0.666667, aggregateWeight: 1 }),
      expect.objectContaining({ layerId: "child", score: null, assignedWeight: 0.333333, aggregateWeight: 0 }),
    ]);
  });

  it("represents vanilla harness presentation as not applicable, never as zero", () => {
    expect(buildGraphPresentationGrade({ status: "not_applicable" })).toMatchObject({
      status: "not_applicable",
      score: null,
      worstLayer: null,
      hasMateriallyMisleadingLayer: false,
    });
  });

  it("combines turn comprehension with recursive layer and node quality, then applies omissions", () => {
    const polishedButIncomplete = buildGraphPresentationGrade({
      status: "completed",
      comprehensionRatings: [2],
      scoreCeilings: [2],
      layers: [{
        ...layer("root", 0, [4, 4, 4, 4]),
        nodes: [node("status", [4, 4, 2, 4]), node("checks", [4, 4, 3, 4])],
      }],
    });

    expect(polishedButIncomplete).toMatchObject({
      comprehensionScore: 2,
      renderedScore: 3.8875,
      rawScore: 2.660625,
      scoreCeiling: 2,
      score: 2,
    });

    const conciseComplete = buildGraphPresentationGrade({
      status: "completed",
      comprehensionRatings: [4],
      scoreCeilings: [4],
      layers: [{ ...layer("root", 0, [4, 4, 4, 4]), nodes: [node("handoff", [4, 4, 4, 4])] }],
    });
    expect(conciseComplete.score).toBe(4);
  });

  it("uses the LLM-authored final turn rating without reaggregating descendant vectors", () => {
    const result = buildRecursiveGraphPresentationGrade({
      status: "completed",
      presentationRatings: [3],
      comprehensionRatings: [4],
      scoreCeilings: [3],
      rootLayerResultIds: ["root"],
      layers: [layer("root", 0, [1]), layer("deep", 4, [1])],
    });

    expect(result).toMatchObject({
      score: 3,
      rawScore: 3,
      comprehensionScore: 4,
      renderedScore: null,
      scoreCeiling: 3,
      aggregationMethod: "recursive_semantic_root",
      rootLayerResultIds: ["root"],
      aggregation: [],
      worstLayer: null,
    });
  });
});

function node(nodeId: string, values: readonly (1 | 2 | 3 | 4 | null)[]) {
  return {
    nodeId,
    ratings: Object.fromEntries(values.map((value, index) => [`criterion-${index + 1}`, value])),
    summary: `${nodeId} review.`,
    evidenceRefs: [],
  };
}

function layer(
  layerId: string,
  depth: number,
  values: readonly (1 | 2 | 3 | 4 | null)[],
  materiallyMisleading = false,
): PresentationLayerGrade {
  return {
    layerId,
    depth,
    ratings: Object.fromEntries(values.map((value, index) => [`criterion-${index + 1}`, value])),
    summary: `${layerId} review.`,
    materiallyMisleading,
    evidenceRefs: [],
  };
}
