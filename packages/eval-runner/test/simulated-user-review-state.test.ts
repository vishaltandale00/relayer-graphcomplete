import { describe, expect, it, vi } from "vitest";
import {
  MissingReviewSubjectsError,
  formatMissingSubject,
} from "../src/simulated-user/coverage.js";
import {
  inventoryReviewSubjects,
  type ReviewTopology,
} from "../src/simulated-user/inventory.js";
import {
  IncrementalReviewStore,
  type LayerReviewRecord,
  type NodeReviewRecord,
  type TurnReviewRecord,
} from "../src/simulated-user/review-store.js";

interface TestLayerReview extends LayerReviewRecord {
  readonly evidence: readonly string[];
  readonly summary: string;
}

interface TestNodeReview extends NodeReviewRecord {
  readonly evidence: readonly string[];
  readonly summary: string;
}

interface TestTurnReview extends TurnReviewRecord {
  readonly evidence: readonly string[];
  readonly summary: string;
}

const topology: ReviewTopology = {
  turnId: "turn-1",
  rootLayerId: "layer-root",
  layers: [
    {
      id: "layer-root",
      nodeIds: ["node-a", "node-b"],
      actions: [
        { id: "action-child", sourceNodeId: "node-a", kind: "navigate", relation: "expand", targetLayerId: "layer-child" },
        { id: "action-shared", sourceNodeId: "node-b", kind: "navigate", relation: "reference", targetLayerId: "layer-deep" },
        { id: "action-invoke", sourceNodeId: "node-b", kind: "invoke" },
      ],
    },
    {
      id: "layer-child",
      nodeIds: ["node-c"],
      actions: [
        { id: "action-deep", sourceNodeId: "node-c", kind: "navigate", relation: "expand", targetLayerId: "layer-deep" },
      ],
    },
    { id: "layer-deep", nodeIds: ["node-d"], actions: [] },
    {
      id: "layer-unreachable",
      nodeIds: ["node-hidden"],
      actions: [
        { id: "action-hidden", sourceNodeId: "node-hidden", kind: "navigate", relation: "expand", targetLayerId: "layer-deep" },
      ],
    },
  ],
};

function layerReview(layerId: string, summary = layerId): TestLayerReview {
  return { layerId, evidence: [`shot-${layerId}`], summary };
}

function nodeReview(
  layerId: string,
  nodeId: string,
  actions: TestNodeReview["actions"] = [],
  summary = nodeId,
): TestNodeReview {
  return { layerId, nodeId, actions, evidence: [`shot-${nodeId}`], summary };
}

describe("recursive simulated-user review state", () => {
  it("inventories recursive review subjects from the immutable topology", () => {
    const inventory = inventoryReviewSubjects(topology);

    expect(inventory.layers, "expansion subjects are inventoried recursively with depth and provenance").toEqual([
      { kind: "layer", layerId: "layer-root", depth: 0, incomingActionIds: [] },
      { kind: "layer", layerId: "layer-child", depth: 1, incomingActionIds: ["action-child"] },
      {
        kind: "layer",
        layerId: "layer-deep",
        depth: 2,
        incomingActionIds: ["action-deep"],
      },
    ]);
    expect(
      inventory.nodes.map(({ layerId, nodeId, actionIds }) => ({ layerId, nodeId, actionIds })),
      "every reachable node is inventoried once with its action subjects",
    ).toEqual([
      { layerId: "layer-root", nodeId: "node-a", actionIds: ["action-child"] },
      { layerId: "layer-root", nodeId: "node-b", actionIds: ["action-shared", "action-invoke"] },
      { layerId: "layer-child", nodeId: "node-c", actionIds: ["action-deep"] },
      { layerId: "layer-deep", nodeId: "node-d", actionIds: [] },
    ]);
    expect(
      inventory.actions.map(({ layerId, nodeId, actionId, actionKind }) => ({ layerId, nodeId, actionId, actionKind })),
      "reference inclusion is graded from its source action, not from unreachable layers",
    ).toEqual([
      { layerId: "layer-root", nodeId: "node-a", actionId: "action-child", actionKind: "navigate" },
      { layerId: "layer-root", nodeId: "node-b", actionId: "action-shared", actionKind: "navigate" },
      { layerId: "layer-root", nodeId: "node-b", actionId: "action-invoke", actionKind: "invoke" },
      { layerId: "layer-child", nodeId: "node-c", actionId: "action-deep", actionKind: "navigate" },
    ]);

    const inputInventory = inventoryReviewSubjects({
      turnId: "turn-input",
      rootLayerId: "layer-input",
      layers: [{
        id: "layer-input",
        nodeIds: ["node-input"],
        actions: [
          {
            id: "input-text",
            sourceNodeId: "node-input",
            kind: "input",
            control: "text",
            prompt: "What constraint is missing?",
            options: [],
          },
          {
            id: "input-single",
            sourceNodeId: "node-input",
            kind: "input",
            control: "single_select",
            prompt: "Which environment?",
            options: [{ key: "preview", label: "Preview" }, { key: "stable", label: "Stable" }],
          },
          {
            id: "input-multi",
            sourceNodeId: "node-input",
            kind: "input",
            control: "multi_select",
            prompt: "Which platforms?",
            options: [{ key: "mac", label: "macOS" }, { key: "win", label: "Windows" }],
            minimumSelections: 1,
          },
        ],
      }],
    });
    expect(inputInventory.actions, "immutable text, single-select, and multi-select snapshots are inventoried as action subjects").toEqual([
      expect.objectContaining({ actionId: "input-text", actionKind: "input", control: "text", options: [] }),
      expect.objectContaining({
        actionId: "input-single",
        actionKind: "input",
        control: "single_select",
        options: [{ key: "preview", label: "Preview" }, { key: "stable", label: "Stable" }],
      }),
      expect.objectContaining({
        actionId: "input-multi",
        actionKind: "input",
        control: "multi_select",
        minimumSelections: 1,
      }),
    ]);
    const inputStore = new IncrementalReviewStore<TestLayerReview, TestNodeReview, TestTurnReview>({ inventory: inputInventory });
    expect(
      inputStore.coverage().missingSubjects.map(formatMissingSubject),
      "unreviewed input actions are reported as missing coverage subjects",
    ).toContain("input-action(\"layer-input\"/\"node-input\"/\"input-text\")");

    expect(
      () => inventoryReviewSubjects({
        turnId: "turn-1",
        rootLayerId: "layer-a",
        layers: [
          {
            id: "layer-a",
            nodeIds: ["node-a"],
            actions: [{ id: "action-ab", sourceNodeId: "node-a", kind: "navigate", relation: "expand", targetLayerId: "layer-b" }],
          },
          {
            id: "layer-b",
            nodeIds: ["node-b"],
            actions: [{ id: "action-ba", sourceNodeId: "node-b", kind: "navigate", relation: "expand", targetLayerId: "layer-a" }],
          },
        ],
      }),
      "expansion cycles are rejected instead of silently looping recursive coverage",
    ).toThrow("Review expansion topology must be acyclic; found \"layer-a\" -> \"layer-b\" -> \"layer-a\"");

    const cyclicReference = inventoryReviewSubjects({
      turnId: "turn-1",
      rootLayerId: "layer-a",
      layers: [
        {
          id: "layer-a",
          nodeIds: ["node-a"],
          actions: [{ id: "action-ab", sourceNodeId: "node-a", kind: "navigate", relation: "reference", targetLayerId: "layer-b" }],
        },
        {
          id: "layer-b",
          nodeIds: ["node-b"],
          actions: [{ id: "action-ba", sourceNodeId: "node-b", kind: "navigate", relation: "reference", targetLayerId: "layer-a" }],
        },
      ],
    });
    expect(cyclicReference.layers.map((layer) => layer.layerId), "reference cycles stop at the source layer").toEqual(["layer-a"]);
    expect(cyclicReference.nodes.map((node) => node.nodeId), "reference cycles do not regrade destination nodes").toEqual(["node-a"]);
    expect(cyclicReference.actions.map((action) => action.actionId), "reference cycles do not regrade destination actions").toEqual(["action-ab"]);
  });

  it("tracks revisions, validates evidence, reports coverage, and finalizes exactly once", () => {
    const inventory = inventoryReviewSubjects(topology);
    const validator = vi.fn((request: { review: { evidence: readonly string[] } }) => {
      if (request.review.evidence.includes("shot-unrelated")) throw new Error("screenshot state does not match subject");
    });
    const store = new IncrementalReviewStore<TestLayerReview, TestNodeReview, TestTurnReview>({
      inventory,
      validateEvidence: validator,
    });

    expect(store.reviewLayer(layerReview("layer-root", "first")).revision, "the first review is revision 1").toBe(1);
    expect(store.reviewLayer(layerReview("layer-root", "revised")).revision, "a revised review is revision 2").toBe(2);
    expect(() => store.reviewLayer({
      layerId: "layer-child",
      evidence: ["shot-unrelated"],
      summary: "invalid",
    }), "evidence validation runs before any state mutation").toThrow("screenshot state does not match subject");

    const invalidActions: readonly [label: string, review: TestNodeReview, message: string][] = [
      ["unknown action subject", nodeReview("layer-root", "node-b", [{ actionId: "missing", kind: "invoke" }]), "Unknown action review subject: \"missing\""],
      ["duplicate action subject", nodeReview("layer-root", "node-b", [
        { actionId: "action-shared", kind: "navigate" },
        { actionId: "action-shared", kind: "navigate" },
      ]), "Duplicate action review: \"action-shared\""],
      ["wrong action kind", nodeReview("layer-root", "node-b", [{ actionId: "action-invoke", kind: "navigate" }]), "Action review \"action-invoke\" has kind navigate; expected invoke"],
    ];
    for (const [label, review, message] of invalidActions) {
      expect(() => store.reviewNode(review), `${label} is rejected`).toThrow(message);
    }

    const snapshot = store.snapshot();
    expect(snapshot.layers, "an invalid review leaves prior revisions intact").toHaveLength(1);
    expect(snapshot.layers[0]!.history.current.summary, "the current revision is the latest accepted review").toBe("revised");
    expect(
      snapshot.layers[0]!.history.revisions.map(({ revision, review }) => [revision, review.summary]),
      "every accepted revision is preserved",
    ).toEqual([
      [1, "first"],
      [2, "revised"],
    ]);
    expect(
      snapshot.trace.map(({ sequence, tool, subjectRevision }) => ({ sequence, tool, subjectRevision })),
      "the tool trace records each accepted revision",
    ).toEqual([
      { sequence: 1, tool: "reviewLayer", subjectRevision: 1 },
      { sequence: 2, tool: "reviewLayer", subjectRevision: 2 },
    ]);
    expect(validator, "evidence validation ran for every attempted review").toHaveBeenCalledTimes(3);

    store.reviewNode(nodeReview("layer-root", "node-a", [
      { actionId: "action-child", kind: "navigate" },
    ]));
    store.reviewNode(nodeReview("layer-root", "node-b", [
      { actionId: "action-shared", kind: "navigate" },
    ]));

    expect(store.coverage().missingSubjects.map(formatMissingSubject), "coverage reports the exact missing subjects").toEqual([
      "layer(\"layer-child\")",
      "layer(\"layer-deep\")",
      "node(\"layer-child\"/\"node-c\")",
      "node(\"layer-deep\"/\"node-d\")",
      "invoke-action(\"layer-root\"/\"node-b\"/\"action-invoke\")",
      "navigate-action(\"layer-child\"/\"node-c\"/\"action-deep\")",
      "turn(\"turn-1\")",
    ]);

    try {
      store.submitReview({ turnId: "turn-1", evidence: ["shot-root"], summary: "overall" });
      throw new Error("expected incomplete coverage");
    } catch (error) {
      expect(error, "an incomplete submit names every missing lower subject").toBeInstanceOf(MissingReviewSubjectsError);
      expect((error as MissingReviewSubjectsError).missingSubjects.map(formatMissingSubject)).toEqual([
        "layer(\"layer-child\")",
        "layer(\"layer-deep\")",
        "node(\"layer-child\"/\"node-c\")",
        "node(\"layer-deep\"/\"node-d\")",
        "invoke-action(\"layer-root\"/\"node-b\"/\"action-invoke\")",
        "navigate-action(\"layer-child\"/\"node-c\"/\"action-deep\")",
      ]);
    }

    for (const subject of inventory.layers) store.reviewLayer(layerReview(String(subject.layerId)));
    store.reviewNode(nodeReview("layer-root", "node-b", [
      { actionId: "action-shared", kind: "navigate" },
      { actionId: "action-invoke", kind: "invoke" },
    ]));
    store.reviewNode(nodeReview("layer-child", "node-c", [
      { actionId: "action-deep", kind: "navigate" },
    ]));
    store.reviewNode(nodeReview("layer-deep", "node-d"));

    expect(store.coverage(), "the turn remains the only missing subject before submit").toMatchObject({
      complete: false,
      turn: { required: 1, reviewed: 0, missing: 1 },
    });
    const result = store.submitReview({ turnId: "turn-1", evidence: ["shot-root"], summary: "complete" });
    expect(result.coverage, "submitting with complete coverage finalizes").toMatchObject({
      complete: true,
      turn: { required: 1, reviewed: 1, missing: 0 },
    });
    expect(
      result.nodes.find(({ subject }) => subject.nodeId === "node-b")!.history.current.actions,
      "the finalized result preserves every accepted action review",
    ).toEqual([
      { actionId: "action-shared", kind: "navigate" },
      { actionId: "action-invoke", kind: "invoke" },
    ]);
    expect(Object.isFrozen(result), "the finalized result is immutable").toBe(true);
    expect(
      () => store.reviewLayer(layerReview("layer-root", "too late")),
      "a finalized review rejects further layer reviews",
    ).toThrow("Review is already finalized");
    expect(
      () => store.submitReview({ turnId: "turn-1", evidence: [], summary: "twice" }),
      "a finalized review rejects a second submit",
    ).toThrow("Review is already finalized");
  });

  it("enforces authored disclosure results and required-missing ceilings", () => {
    const store = new IncrementalReviewStore<TestLayerReview, TestNodeReview, TestTurnReview>({
      inventory: inventoryReviewSubjects(topology),
    });
    expect(() => store.reviewNode({
      ...nodeReview("layer-root", "node-a", [{ actionId: "action-child", kind: "navigate" }]),
      structure: {
        rating: 3,
        expansion: { need: "helpful", result: "absent" },
        references: { need: "none", result: "absent" },
        invoke: { need: "none", result: "absent" },
      },
    }), "disclosure results must agree with the authored action inventory").toThrow(
      "expansion disclosure exists in inventory and cannot be rated absent",
    );

    const inventory = inventoryReviewSubjects({
      turnId: "turn-required",
      rootLayerId: "layer-required",
      layers: [{ id: "layer-required", nodeIds: ["node-required"], actions: [] }],
    });
    const requiredStore = new IncrementalReviewStore<TestLayerReview, TestNodeReview, TestTurnReview>({ inventory });
    requiredStore.reviewLayer(layerReview("layer-required"));
    const missingExpansion = {
      expansion: { need: "required", result: "absent" },
      references: { need: "none", result: "absent" },
      invoke: { need: "none", result: "absent" },
    } as const;
    expect(() => requiredStore.reviewNode({
      ...nodeReview("layer-required", "node-required"),
      structure: { rating: 4, ...missingExpansion },
    }), "a required missing disclosure caps its parent node rating at 2").toThrow(
      "cannot receive a recursive-disclosure rating above 2",
    );
    requiredStore.reviewNode({
      ...nodeReview("layer-required", "node-required"),
      structure: { rating: 2, ...missingExpansion },
    });
    expect(() => requiredStore.submitReview({
      turnId: "turn-required",
      evidence: ["shot-root"],
      summary: "Missing required detail.",
      scoreCeiling: { maximum: 4 },
    }), "a required missing disclosure caps the whole-turn presentation ceiling at 2").toThrow(
      "requires a whole-turn presentation ceiling of 2 or lower",
    );
  });
});
