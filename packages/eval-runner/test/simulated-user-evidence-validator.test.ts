import { describe, expect, it } from "vitest";
import type {
  LayerReview,
  NodeReview,
  ScreenshotMetadata,
  TurnReview,
} from "../src/simulated-user/contracts.js";
import {
  ScreenshotEvidenceValidationError,
  createScreenshotEvidenceValidator,
} from "../src/simulated-user/evidence-validator.js";
import { inventoryReviewSubjects } from "../src/simulated-user/inventory.js";
import { IncrementalReviewStore } from "../src/simulated-user/review-store.js";

const digest = `sha256:${"a".repeat(64)}` as const;

function screenshot(
  screenshotId: string,
  layerId: string,
  selectedNodeId: string | null,
  options: {
    readonly turnId?: string;
    readonly viaActionId?: string | null;
    readonly target?: "viewport" | "element";
    readonly mode?: "visible" | "full";
  } = {},
): ScreenshotMetadata {
  const target = options.target ?? "viewport";
  return {
    schemaVersion: 1,
    screenshotId,
    executionId: "execution-1",
    threadId: "thread-1",
    turnId: options.turnId ?? "turn-1",
    layerId,
    selectedNodeId,
    activatedActionId: options.viaActionId ?? null,
    navigationPath: [
      { layerId: "layer-root", viaActionId: null },
      ...(layerId === "layer-root" ? [] : [{ layerId, viaActionId: options.viaActionId ?? null }]),
    ],
    label: screenshotId,
    mode: options.mode ?? "visible",
    viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
    captureTarget: target === "viewport"
      ? { kind: "viewport" }
      : { kind: "element", elementRef: `element-${selectedNodeId}` },
    tileCount: 1,
    tiles: [{ index: 0, width: 1200, height: 800, contentDigest: digest }],
    contentDigest: digest,
  };
}

const rootLayerReview: LayerReview = {
  layerId: "layer-root",
  evidence: { viewport: ["shot-root"] },
  ratings: {
    purpose_clarity: 4,
    cohesion: 4,
    visual_organization: 4,
    relationship_clarity: 4,
    coverage: 4,
  },
  nullRatingJustifications: {},
  summary: "Clear root layer.",
  findings: [],
};

const childLayerReview: LayerReview = {
  ...rootLayerReview,
  layerId: "layer-child",
  evidence: { viewport: ["shot-child"] },
  summary: "Clear child layer.",
};

function rootNodeReview(destination: string): NodeReview {
  return {
    nodeId: "node-root",
    layerId: "layer-root",
    evidence: { context: ["shot-root"], detail: ["shot-root-detail"] },
    ratings: {
      layer_fit: 4,
      title_detail_alignment: 4,
      substance: 4,
      detail_presentation: 4,
    },
    nullRatingJustifications: {},
    actions: [{
      actionId: "action-child",
      kind: "navigate",
      evidence: { source: ["shot-root-detail"], destination: [destination] },
      ratings: { placement: 4, label_expectation: 4, destination_delivery: 4, added_value: 4 },
      nullRatingJustifications: {},
      summary: "The action reaches useful detail.",
      findings: [],
    }],
    structure: {
      rating: 4,
      expansion: { need: "helpful", result: "works" },
      references: { need: "none", result: "absent" },
      invoke: { need: "none", result: "absent" },
      reason: "The child supplies useful detail.",
      evidence: ["shot-root-detail"],
    },
    summary: "Useful root node.",
    findings: [],
  };
}

const childNodeReview: NodeReview = {
  nodeId: "node-child",
  layerId: "layer-child",
  evidence: { context: ["shot-child"], detail: ["shot-child-detail"] },
  ratings: {
    layer_fit: 4,
    title_detail_alignment: 4,
    substance: 4,
    detail_presentation: 4,
  },
  nullRatingJustifications: {},
  actions: [],
  structure: {
    rating: 4,
    expansion: { need: "none", result: "absent" },
    references: { need: "none", result: "absent" },
    invoke: { need: "none", result: "absent" },
    reason: "The node is complete without another action.",
    evidence: ["shot-child-detail"],
  },
  summary: "Useful child node.",
  findings: [],
};

const turnReview: TurnReview = {
  turnId: "turn-1",
  evidence: { representative: ["shot-root", "shot-child", "shot-child-detail"] },
  ratings: {
    answer_quality: 4,
    recursive_coherence: 4,
    navigation_value: 4,
    presentation_quality: 4,
    follow_up_progress: null,
  },
  nullRatingJustifications: { follow_up_progress: "This is the initial turn." },
  summary: "The turn is complete and navigable.",
  findings: [],
  structure: {
    overall: "helps",
    expansion: { need: "helpful", result: "works" },
    references: { need: "none", result: "absent" },
    reason: "The useful child detail keeps the root concise.",
    evidence: ["shot-root", "shot-child"],
  },
  scoreCeiling: {
    maximum: 4,
    reason: "No critical comprehension gap exists.",
    evidence: ["shot-root", "shot-child"],
  },
};

function makeStore(): IncrementalReviewStore {
  const inventory = inventoryReviewSubjects({
    turnId: "turn-1",
    rootLayerId: "layer-root",
    layers: [
      {
        id: "layer-root",
        nodeIds: ["node-root"],
        actions: [{
          id: "action-child",
          sourceNodeId: "node-root",
          kind: "navigate",
          relation: "expand",
          targetLayerId: "layer-child",
        }],
      },
      { id: "layer-child", nodeIds: ["node-child"], actions: [] },
    ],
  });
  const screenshots = [
    screenshot("shot-root", "layer-root", null),
    screenshot("shot-root-detail", "layer-root", "node-root", { target: "element", mode: "full" }),
    screenshot("shot-child", "layer-child", null, { viaActionId: "action-child" }),
    screenshot("shot-child-detail", "layer-child", "node-child", {
      viaActionId: "action-child",
      target: "element",
      mode: "full",
    }),
    screenshot("shot-bad-path", "layer-child", null),
    screenshot("shot-other-turn", "layer-root", null, { turnId: "turn-2" }),
    screenshot("shot-previous-turn", "layer-root", null, { turnId: "turn-0" }),
  ];
  return new IncrementalReviewStore({
    inventory,
    validateEvidence: createScreenshotEvidenceValidator({
      executionId: "execution-1",
      threadId: "thread-1",
      turnId: "turn-1",
      screenshots: new Map(screenshots.map((shot) => [shot.screenshotId, shot])),
    }),
  });
}

describe("screenshot evidence validation", () => {
  it("accepts matching layer, selected-node, traversed-action, and representative turn evidence", () => {
    const store = makeStore();
    store.reviewLayer(rootLayerReview);
    store.reviewLayer(childLayerReview);
    store.reviewNode(rootNodeReview("shot-child"));
    store.reviewNode(childNodeReview);

    const result = store.submitReview(turnReview);
    expect(result.finalized).toBe(true);
    expect(result.coverage.complete).toBe(true);
  });

  it("rejects a navigate destination whose immutable path does not contain the action", () => {
    const store = makeStore();
    store.reviewNode(rootNodeReview("shot-child"));

    expect(() => store.reviewNode(rootNodeReview("shot-bad-path"))).toThrow(ScreenshotEvidenceValidationError);
    try {
      store.reviewNode(rootNodeReview("shot-bad-path"));
    } catch (error) {
      expect((error as ScreenshotEvidenceValidationError).issues).toEqual([
        expect.objectContaining({
          code: "navigation_path_mismatch",
          screenshotId: "shot-bad-path",
          path: ["actions", 0, "evidence", "destination", 0],
        }),
      ]);
    }
    expect(store.snapshot().nodes[0]!.history).toMatchObject({ currentRevision: 1 });
  });

  it("rejects unknown evidence and screenshots bound to a different turn", () => {
    const store = makeStore();
    expect(() => store.reviewLayer({
      ...rootLayerReview,
      evidence: { viewport: ["missing-shot", "shot-other-turn"] },
    })).toThrow(ScreenshotEvidenceValidationError);
    try {
      store.reviewLayer({
        ...rootLayerReview,
        evidence: { viewport: ["missing-shot", "shot-other-turn"] },
      });
    } catch (error) {
      expect((error as ScreenshotEvidenceValidationError).issues.map(({ code }) => code)).toEqual([
        "unknown_evidence",
        "screenshot_state_mismatch",
      ]);
    }
    expect(store.snapshot().layers).toEqual([]);
  });

  it("rejects overall evidence that was not cited by a completed lower-subject review", () => {
    const store = makeStore();
    store.reviewLayer(rootLayerReview);
    store.reviewLayer(childLayerReview);
    store.reviewNode(rootNodeReview("shot-child"));
    store.reviewNode(childNodeReview);

    expect(() => store.submitReview({
      ...turnReview,
      evidence: { representative: ["shot-bad-path"] },
    })).toThrow("Turn evidence must include at least one screenshot used by a completed current-turn lower-subject review");
    expect(store.finalizedResult()).toBeUndefined();
  });

  it("allows explicitly allowlisted prior-turn evidence only for the overall follow-up review", () => {
    const inventory = inventoryReviewSubjects({
      turnId: "turn-1",
      rootLayerId: "layer-root",
      layers: [{ id: "layer-root", nodeIds: ["node-root"], actions: [] }],
    });
    const screenshots = new Map([
      screenshot("shot-root", "layer-root", null),
      screenshot("shot-root-detail", "layer-root", "node-root", { target: "element", mode: "full" }),
      screenshot("shot-previous-turn", "layer-root", null, { turnId: "turn-0" }),
    ].map((shot) => [shot.screenshotId, shot]));
    const store = new IncrementalReviewStore({
      inventory,
      validateEvidence: createScreenshotEvidenceValidator({
        executionId: "execution-1",
        threadId: "thread-1",
        turnId: "turn-1",
        comparisonTurnIds: ["turn-0"],
        screenshots,
      }),
    });

    expect(() => store.reviewLayer({
      ...rootLayerReview,
      evidence: { viewport: ["shot-previous-turn"] },
    })).toThrow("different execution, thread, or turn state");
    store.reviewLayer(rootLayerReview);
    store.reviewNode({
      ...childNodeReview,
      nodeId: "node-root",
      layerId: "layer-root",
      evidence: { context: ["shot-root"], detail: ["shot-root-detail"] },
      structure: { ...childNodeReview.structure, evidence: ["shot-root-detail"] },
    });

    const result = store.submitReview({
      ...turnReview,
      evidence: { representative: ["shot-root", "shot-previous-turn"] },
      structure: { ...turnReview.structure, evidence: ["shot-root"] },
      scoreCeiling: { ...turnReview.scoreCeiling, evidence: ["shot-root"] },
      findings: [{
        type: "strength",
        text: "The follow-up improves on the prior turn.",
        evidence: ["shot-root", "shot-previous-turn"],
      }],
    });
    expect(result.finalized).toBe(true);
  });

  it("requires current-turn lower-review evidence even when comparison turns are allowlisted", () => {
    const store = makeStore();
    store.reviewLayer(rootLayerReview);
    store.reviewLayer(childLayerReview);
    store.reviewNode(rootNodeReview("shot-child"));
    store.reviewNode(childNodeReview);

    expect(() => store.submitReview({
      ...turnReview,
      evidence: { representative: ["shot-other-turn"] },
    })).toThrow("at least one screenshot used by a completed current-turn lower-subject review");
  });
});
