import { describe, expect, it } from "vitest";
import type {
  InputActionReview,
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

function completeLowerReviews(store: IncrementalReviewStore): void {
  store.reviewLayer(rootLayerReview);
  store.reviewLayer(childLayerReview);
  store.reviewNode(rootNodeReview("shot-child"));
  store.reviewNode(childNodeReview);
}

describe("screenshot evidence validation", () => {
  it("binds review evidence to immutable screenshot state", () => {
    const accepted = makeStore();
    completeLowerReviews(accepted);
    const result = accepted.submitReview(turnReview);
    expect(result.finalized, "matching layer, selected-node, traversed-action, and representative evidence finalize").toBe(true);
    expect(result.coverage.complete, "complete evidence yields complete coverage").toBe(true);

    const mismatched = makeStore();
    mismatched.reviewNode(rootNodeReview("shot-child"));
    expect(
      () => mismatched.reviewNode(rootNodeReview("shot-bad-path")),
      "a navigate destination whose immutable path does not contain the action is rejected",
    ).toThrow(ScreenshotEvidenceValidationError);
    try {
      mismatched.reviewNode(rootNodeReview("shot-bad-path"));
    } catch (error) {
      expect((error as ScreenshotEvidenceValidationError).issues, "the mismatch names the screenshot and evidence path").toEqual([
        expect.objectContaining({
          code: "navigation_path_mismatch",
          screenshotId: "shot-bad-path",
          path: ["actions", 0, "evidence", "destination", 0],
        }),
      ]);
    }
    expect(mismatched.snapshot().nodes[0]!.history, "a rejected destination review leaves the prior revision intact").toMatchObject({
      currentRevision: 1,
    });

    const unknown = makeStore();
    expect(
      () => unknown.reviewLayer({
        ...rootLayerReview,
        evidence: { viewport: ["missing-shot", "shot-other-turn"] },
      }),
      "unknown evidence and screenshots bound to a different turn are rejected",
    ).toThrow(ScreenshotEvidenceValidationError);
    try {
      unknown.reviewLayer({
        ...rootLayerReview,
        evidence: { viewport: ["missing-shot", "shot-other-turn"] },
      });
    } catch (error) {
      expect(
        (error as ScreenshotEvidenceValidationError).issues.map(({ code }) => code),
        "each invalid screenshot is reported with its exact code",
      ).toEqual(["unknown_evidence", "screenshot_state_mismatch"]);
    }
    expect(unknown.snapshot().layers, "a rejected layer review mutates nothing").toEqual([]);

    const inputInventory = inventoryReviewSubjects({
      turnId: "turn-1",
      rootLayerId: "layer-root",
      layers: [{
        id: "layer-root",
        nodeIds: ["node-root", "node-other"],
        actions: [{
          id: "action-input",
          sourceNodeId: "node-root",
          kind: "input",
          control: "text",
          prompt: "What deployment window should we use?",
          options: [],
        }],
      }],
    });
    const shots = [
      screenshot("shot-root", "layer-root", null),
      screenshot("shot-input", "layer-root", "node-root", { target: "element", mode: "full" }),
      screenshot("shot-other", "layer-root", "node-other", { target: "element", mode: "full" }),
    ];
    const inputStore = new IncrementalReviewStore({
      inventory: inputInventory,
      validateEvidence: createScreenshotEvidenceValidator({
        executionId: "execution-1",
        threadId: "thread-1",
        turnId: "turn-1",
        screenshots: new Map(shots.map((shot) => [shot.screenshotId, shot])),
      }),
    });
    const inputActionReview: InputActionReview = {
      actionId: "action-input",
      kind: "input",
      evidence: { source: ["shot-input"] },
      ratings: { prompt_answerability: 4, option_set_quality: 4, control_fit: 4 },
      summary: "The unanswered text question is well formed.",
      findings: [],
    };
    const inputReview: NodeReview = {
      nodeId: "node-root",
      layerId: "layer-root",
      evidence: { context: ["shot-root"], detail: ["shot-input"] },
      ratings: { layer_fit: 4, title_detail_alignment: 4, substance: 4, detail_presentation: 4 },
      actions: [inputActionReview],
      structure: {
        rating: 4,
        expansion: { need: "none", result: "absent" },
        references: { need: "none", result: "absent" },
        invoke: { need: "none", result: "absent" },
        input: { need: "required", result: "works" },
        reason: "The user-owned decision is collected at its source.",
        evidence: ["shot-input"],
      },
      summary: "The source presents a necessary question.",
      findings: [],
    };

    expect(
      inputStore.reviewNode(inputReview).revision,
      "an input-action rating bound to its selected source node is accepted",
    ).toBe(1);
    expect(() => inputStore.reviewNode({
      ...inputReview,
      actions: [{ ...inputActionReview, evidence: { source: ["shot-other"] } }],
    }), "an input-action rating must be bound to its immutable selected source node").toThrow(
      "Action action-input source evidence must show node node-root in layer layer-root",
    );
  });

  it("requires turn evidence to cite completed lower reviews unless explicitly allowlisted", () => {
    const uncited = makeStore();
    completeLowerReviews(uncited);
    expect(() => uncited.submitReview({
      ...turnReview,
      evidence: { representative: ["shot-bad-path"] },
    }), "overall evidence must be cited by a completed lower-subject review").toThrow(
      "Turn evidence must include at least one screenshot used by a completed current-turn lower-subject review",
    );
    expect(uncited.finalizedResult(), "an uncited turn submit finalizes nothing").toBeUndefined();

    const comparisonInventory = inventoryReviewSubjects({
      turnId: "turn-1",
      rootLayerId: "layer-root",
      layers: [{ id: "layer-root", nodeIds: ["node-root"], actions: [] }],
    });
    const screenshots = new Map([
      screenshot("shot-root", "layer-root", null),
      screenshot("shot-root-detail", "layer-root", "node-root", { target: "element", mode: "full" }),
      screenshot("shot-previous-turn", "layer-root", null, { turnId: "turn-0" }),
    ].map((shot) => [shot.screenshotId, shot]));
    const comparison = new IncrementalReviewStore({
      inventory: comparisonInventory,
      validateEvidence: createScreenshotEvidenceValidator({
        executionId: "execution-1",
        threadId: "thread-1",
        turnId: "turn-1",
        comparisonTurnIds: ["turn-0"],
        screenshots,
      }),
    });

    expect(() => comparison.reviewLayer({
      ...rootLayerReview,
      evidence: { viewport: ["shot-previous-turn"] },
    }), "prior-turn evidence stays forbidden for lower-subject reviews").toThrow("different execution, thread, or turn state");
    comparison.reviewLayer(rootLayerReview);
    comparison.reviewNode({
      ...childNodeReview,
      nodeId: "node-root",
      layerId: "layer-root",
      evidence: { context: ["shot-root"], detail: ["shot-root-detail"] },
      structure: { ...childNodeReview.structure, evidence: ["shot-root-detail"] },
    });

    const followUp = comparison.submitReview({
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
    expect(followUp.finalized, "allowlisted prior-turn evidence is accepted for the overall follow-up review").toBe(true);

    const stillCurrent = makeStore();
    completeLowerReviews(stillCurrent);
    expect(() => stillCurrent.submitReview({
      ...turnReview,
      evidence: { representative: ["shot-other-turn"] },
    }), "comparison turn allowlists never replace current-turn lower-review evidence").toThrow(
      "at least one screenshot used by a completed current-turn lower-subject review",
    );
  });
});
