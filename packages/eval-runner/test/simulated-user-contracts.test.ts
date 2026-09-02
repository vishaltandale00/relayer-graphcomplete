import { describe, expect, it } from "vitest";
import {
  SIMULATED_USER_JUDGE_CONTRACT_V1,
} from "../src/simulated-user/contracts.js";
import {
  DEFAULT_SIMULATED_USER_RUBRIC,
  GRAPH_PRESENTATION_RUBRIC_V3,
  GRAPH_PRESENTATION_RUBRIC_V4,
  GRAPH_PRESENTATION_RUBRIC_V5,
  GRAPH_PRESENTATION_RUBRIC_V6,
  GRAPH_PRESENTATION_RUBRIC_V7,
  GRAPH_PRESENTATION_RUBRIC_V8,
  GRAPH_PRESENTATION_RUBRIC_V9,
  GRAPH_PRESENTATION_RUBRIC_V10,
  GRAPH_PRESENTATION_RUBRIC_V11,
  SIMULATED_USER_RUBRIC_V1,
  getRubricCriterionKeys,
  validateRubricRatings,
} from "../src/simulated-user/rubric.js";

describe("simulated-user judge contracts", () => {
  it("pins exactly the six PRD tools in contract version one", () => {
    expect(SIMULATED_USER_JUDGE_CONTRACT_V1).toEqual({
      schemaVersion: 1,
      contractId: "simulated-user-tools-v1",
      toolNames: ["screenshot", "interact", "history", "reviewLayer", "reviewNode", "submitReview"],
      elementReferencesAreEvidence: false,
      submitAcceptsLayerOrNodeReviews: false,
    });
  });

  it("applies one layer schema recursively without root or child distinctions", () => {
    expect(DEFAULT_SIMULATED_USER_RUBRIC).toBe(SIMULATED_USER_RUBRIC_V1);
    expect(SIMULATED_USER_RUBRIC_V1.layerPolicy).toEqual({
      recursive: true,
      rootChildDistinction: false,
      nodeCount: "qualitative_context_only",
      automaticNodeCountThresholds: false,
    });
    expect(getRubricCriterionKeys("layer")).toEqual([
      "purpose_clarity",
      "cohesion",
      "visual_organization",
      "relationship_clarity",
      "coverage",
    ]);
  });

  it("declares the literal criteria for every review subject", () => {
    expect(getRubricCriterionKeys("node")).toEqual([
      "layer_fit",
      "title_detail_alignment",
      "substance",
      "detail_presentation",
    ]);
    expect(getRubricCriterionKeys("navigate_action")).toEqual([
      "placement",
      "label_expectation",
      "destination_delivery",
      "added_value",
    ]);
    expect(getRubricCriterionKeys("invoke_action")).toEqual([
      "placement",
      "label_expectation",
      "apparent_value",
    ]);
    expect(getRubricCriterionKeys("turn")).toEqual([
      "answer_quality",
      "recursive_coherence",
      "navigation_value",
      "presentation_quality",
      "follow_up_progress",
    ]);
  });

  it("defines artifact-grounded recursive presentation guidance in v3", () => {
    expect(GRAPH_PRESENTATION_RUBRIC_V3.rubricVersion).toBe("graph-presentation-rubric-v3");
    expect(GRAPH_PRESENTATION_RUBRIC_V3.subjects.node.criteria.substance.label).toBe("Explanatory value");
    expect(GRAPH_PRESENTATION_RUBRIC_V3.subjects.turn.criteria.answer_quality.description)
      .toContain("Inspect the artifact");
    expect(GRAPH_PRESENTATION_RUBRIC_V3.subjects.turn.criteria.recursive_coherence.description)
      .toContain("At every node");
  });

  it("versions the bottom-up semantic LayerResult contract independently", () => {
    expect(GRAPH_PRESENTATION_RUBRIC_V4.rubricVersion).toBe("graph-presentation-rubric-v4");
    expect(GRAPH_PRESENTATION_RUBRIC_V4.recursiveJudgment).toMatchObject({
      contractId: "recursive-presentation-judge-v2",
      fixedNodeCapacity: 8,
      finalTurnInput: ["original_request", "artifact_evidence", "root_layer_result"],
      arithmeticCompression: false,
    });
  });

  it("versions missing-action-aware recursive judgment independently", () => {
    expect(GRAPH_PRESENTATION_RUBRIC_V5.rubricVersion).toBe("graph-presentation-rubric-v5");
    expect(GRAPH_PRESENTATION_RUBRIC_V5.recursiveJudgment.contractId).toBe("recursive-presentation-judge-v3");
    expect(GRAPH_PRESENTATION_RUBRIC_V5.subjects.turn.criteria.recursive_coherence.description)
      .toContain("first-class missing-action opportunity");
  });

  it("makes interaction choices and relational layout explicit in v6 without changing the recursive data contract", () => {
    expect(GRAPH_PRESENTATION_RUBRIC_V6.rubricVersion).toBe("graph-presentation-rubric-v6");
    expect(GRAPH_PRESENTATION_RUBRIC_V6.recursiveJudgment.contractId).toBe("recursive-presentation-judge-v3");
    expect(GRAPH_PRESENTATION_RUBRIC_V6.subjects.layer.criteria.relationship_clarity.description)
      .toContain("arbitrary row or line");
    expect(GRAPH_PRESENTATION_RUBRIC_V6.subjects.turn.criteria.navigation_value.description)
      .toContain("there is no required action count");
    expect(GRAPH_PRESENTATION_RUBRIC_V6.subjects.turn.criteria.presentation_quality.description)
      .toContain("Do not require media capabilities");
  });

  it("separates human experience from task outcome and anchors weak relationship layouts in v7", () => {
    expect(GRAPH_PRESENTATION_RUBRIC_V7.rubricVersion).toBe("graph-presentation-rubric-v7");
    expect(GRAPH_PRESENTATION_RUBRIC_V7.recursiveJudgment.contractId).toBe("recursive-presentation-judge-v3");
    expect(GRAPH_PRESENTATION_RUBRIC_V7.subjects.turn.criteria.answer_quality.description)
      .toContain("belongs exclusively to the separate outcome grade");
    expect(GRAPH_PRESENTATION_RUBRIC_V7.subjects.layer.criteria.relationship_clarity.description)
      .toContain("score at most 2");
    expect(GRAPH_PRESENTATION_RUBRIC_V7.subjects.turn.criteria.recursive_coherence.description)
      .toContain("never convert an artifact defect");
  });

  it("records polish separately in recursive contract v4 without semantic compensation", () => {
    expect(GRAPH_PRESENTATION_RUBRIC_V8.rubricVersion).toBe("graph-presentation-rubric-v8");
    expect(GRAPH_PRESENTATION_RUBRIC_V8.recursiveJudgment).toMatchObject({
      contractId: "recursive-presentation-judge-v4",
      nodeScoreDimensions: ["content", "actionAllocation", "actionDelivery", "recursiveQuality", "polish"],
    });
    expect(GRAPH_PRESENTATION_RUBRIC_V8.subjects.turn.criteria.presentation_quality.description)
      .toContain("recorded only as polish");
    expect(GRAPH_PRESENTATION_RUBRIC_V8.subjects.layer.criteria.visual_organization.description)
      .toContain("cannot raise this rating");
  });

  it("makes polish evidence exclusive and raises the graph-native bar in v9", () => {
    expect(GRAPH_PRESENTATION_RUBRIC_V9.rubricVersion).toBe("graph-presentation-rubric-v9");
    expect(GRAPH_PRESENTATION_RUBRIC_V9.polishPolicy).toEqual({
      exclusiveEvidence: ["readability", "spacing", "alignment", "clipping", "density", "render_consistency", "icon_consistency"],
      mayAffectOtherRatings: false,
    });
    expect(GRAPH_PRESENTATION_RUBRIC_V9.subjects.layer.criteria.visual_organization.label)
      .toBe("Information architecture");
    expect(GRAPH_PRESENTATION_RUBRIC_V9.subjects.turn.criteria.presentation_quality.label)
      .toBe("Graph experience");
    expect(GRAPH_PRESENTATION_RUBRIC_V9.subjects.turn.criteria.presentation_quality.description)
      .toContain("Static prose-in-boxes is at most 2");
    expect(GRAPH_PRESENTATION_RUBRIC_V9.subjects.layer.criteria.relationship_clarity.description)
      .toContain("Do not infer a sequence from card prose");
  });

  it("uses reasoned 1-8 judgments without canned point meanings in v10", () => {
    expect(GRAPH_PRESENTATION_RUBRIC_V10).toMatchObject({
      rubricVersion: "graph-presentation-rubric-v10",
      ratingScale: {
        minimum: 1,
        maximum: 8,
        direction: "higher_is_better",
        fixedPointMeanings: false,
        reasonRequired: true,
        screenshotEvidenceRequired: true,
      },
      recursiveJudgment: { contractId: "recursive-presentation-judge-v5" },
    });
    expect(GRAPH_PRESENTATION_RUBRIC_V10.subjects.turn.criteria.presentation_quality.description)
      .not.toMatch(/a 3|4 is|at most 2/);
  });

  it("adds immutable input-action quality and five-choice allocation together in v11", () => {
    expect(GRAPH_PRESENTATION_RUBRIC_V11).toMatchObject({
      rubricVersion: "graph-presentation-rubric-v11",
      recursiveJudgment: {
        contractId: "recursive-presentation-judge-v6",
        allocationChoices: ["expand", "reference", "invoke", "input", "stop"],
      },
      subjects: {
        input_action: {
          requiredScreenshotContext: ["visible_source", "presented_input_control_before_answer"],
        },
      },
    });
    expect(getRubricCriterionKeys("input_action")).toEqual([
      "prompt_answerability",
      "option_set_quality",
      "control_fit",
    ]);
    expect(GRAPH_PRESENTATION_RUBRIC_V11.subjects.input_action.criteria.option_set_quality.description)
      .toContain("text action, having no authored options is the correct assessable state");
    expect(JSON.stringify(GRAPH_PRESENTATION_RUBRIC_V11.subjects.input_action.criteria)).not.toContain("necessity");
    expect(GRAPH_PRESENTATION_RUBRIC_V11.subjects.turn.criteria.recursive_coherence.description)
      .toContain("penalizing authored questions that were unnecessary");
  });

  it("reports missing, unknown, and invalid rating keys without inference", () => {
    expect(validateRubricRatings("node", {
      layer_fit: 4,
      title_detail_alignment: 3,
      substance: 5,
      invented_formula: 1,
    })).toEqual([
      {
        code: "missing_rubric_key",
        key: "detail_presentation",
        message: "Missing node rating: detail_presentation",
      },
      {
        code: "invalid_rating",
        key: "substance",
        message: "Invalid node rating for substance",
      },
      {
        code: "unknown_rubric_key",
        key: "invented_formula",
        message: "Unknown node rating: invented_formula",
      },
    ]);
  });
});
