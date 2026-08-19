import { describe, expect, it } from "vitest";
import {
  SIMULATED_USER_JUDGE_CONTRACT_V1,
  type LayerReview,
  type NodeReview,
  type ScreenshotMetadata,
} from "../src/simulated-user/contracts.js";
import {
  DEFAULT_SIMULATED_USER_RUBRIC,
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

  it("binds screenshot evidence to immutable review state and tiled content", () => {
    const screenshot: ScreenshotMetadata = {
      schemaVersion: 1,
      screenshotId: "shot-21",
      executionId: "execution-1",
      threadId: "thread-1",
      turnId: "turn-1",
      layerId: "layer-child",
      selectedNodeId: "node-22",
      activatedActionId: "action-6",
      navigationPath: [
        { layerId: "layer-parent", viaActionId: null },
        { layerId: "layer-child", viaActionId: "action-6" },
      ],
      label: "Navigate destination",
      mode: "full",
      viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
      captureTarget: { kind: "element", elementRef: "node-detail" },
      tileCount: 2,
      tiles: [
        { index: 0, width: 800, height: 1200, contentDigest: `sha256:${"a".repeat(64)}` },
        { index: 1, width: 800, height: 800, contentDigest: `sha256:${"b".repeat(64)}` },
      ],
      contentDigest: `sha256:${"c".repeat(64)}`,
    };

    expect(screenshot.navigationPath.at(-1)).toEqual({ layerId: "layer-child", viaActionId: "action-6" });
    expect(screenshot.tiles).toHaveLength(screenshot.tileCount);
  });

  it("models layer and node review evidence separately from ratings", () => {
    const layer: LayerReview = {
      layerId: "layer-8",
      evidence: { viewport: ["shot-16"] },
      ratings: {
        purpose_clarity: 4,
        cohesion: 4,
        visual_organization: 3,
        relationship_clarity: 3,
        coverage: 4,
      },
      summary: "The layer is coherent and readable.",
      findings: [],
    };
    const node: NodeReview = {
      nodeId: "node-22",
      layerId: layer.layerId,
      evidence: { context: ["shot-16"], detail: ["shot-17"] },
      ratings: {
        layer_fit: 4,
        title_detail_alignment: 3,
        substance: 4,
        detail_presentation: 2,
      },
      actions: [{
        actionId: "action-6",
        kind: "navigate",
        evidence: { source: ["shot-17"], destination: ["shot-21"] },
        ratings: { placement: 4, label_expectation: 3, destination_delivery: 4, added_value: 4 },
        summary: "The destination is valuable, though the label is vague.",
        findings: [],
      }],
      summary: "Useful content with a dense detail layout.",
      findings: [{
        type: "issue",
        severity: "material",
        text: "The final table column is unreadable.",
        evidence: ["shot-17"],
      }],
    };

    expect(layer.evidence.viewport).toEqual(["shot-16"]);
    expect(node.actions[0]?.kind).toBe("navigate");
  });
});

describe("recursive simulated-user rubric", () => {
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
