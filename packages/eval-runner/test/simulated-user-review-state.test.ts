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
        { id: "action-child", sourceNodeId: "node-a", kind: "navigate", targetLayerId: "layer-child" },
        { id: "action-shared", sourceNodeId: "node-b", kind: "navigate", targetLayerId: "layer-deep" },
        { id: "action-invoke", sourceNodeId: "node-b", kind: "invoke" },
      ],
    },
    {
      id: "layer-child",
      nodeIds: ["node-c"],
      actions: [
        { id: "action-deep", sourceNodeId: "node-c", kind: "navigate", targetLayerId: "layer-deep" },
      ],
    },
    { id: "layer-deep", nodeIds: ["node-d"], actions: [] },
    {
      id: "layer-unreachable",
      nodeIds: ["node-hidden"],
      actions: [
        { id: "action-hidden", sourceNodeId: "node-hidden", kind: "navigate", targetLayerId: "layer-deep" },
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
  it("inventories only root-reachable DAG subjects and keeps actions nested in source-node context", () => {
    const inventory = inventoryReviewSubjects(topology);

    expect(inventory.layers).toEqual([
      { kind: "layer", layerId: "layer-root", depth: 0, incomingActionIds: [] },
      { kind: "layer", layerId: "layer-child", depth: 1, incomingActionIds: ["action-child"] },
      {
        kind: "layer",
        layerId: "layer-deep",
        depth: 1,
        incomingActionIds: ["action-shared", "action-deep"],
      },
    ]);
    expect(inventory.nodes.map(({ layerId, nodeId, actionIds }) => ({ layerId, nodeId, actionIds }))).toEqual([
      { layerId: "layer-root", nodeId: "node-a", actionIds: ["action-child"] },
      { layerId: "layer-root", nodeId: "node-b", actionIds: ["action-shared", "action-invoke"] },
      { layerId: "layer-child", nodeId: "node-c", actionIds: ["action-deep"] },
      { layerId: "layer-deep", nodeId: "node-d", actionIds: [] },
    ]);
    expect(inventory.actions.map(({ layerId, nodeId, actionId, actionKind }) => (
      { layerId, nodeId, actionId, actionKind }
    ))).toEqual([
      { layerId: "layer-root", nodeId: "node-a", actionId: "action-child", actionKind: "navigate" },
      { layerId: "layer-root", nodeId: "node-b", actionId: "action-shared", actionKind: "navigate" },
      { layerId: "layer-root", nodeId: "node-b", actionId: "action-invoke", actionKind: "invoke" },
      { layerId: "layer-child", nodeId: "node-c", actionId: "action-deep", actionKind: "navigate" },
    ]);
  });

  it("rejects cycles instead of silently turning recursive coverage into a loop", () => {
    expect(() => inventoryReviewSubjects({
      turnId: "turn-1",
      rootLayerId: "layer-a",
      layers: [
        {
          id: "layer-a",
          nodeIds: ["node-a"],
          actions: [{ id: "action-ab", sourceNodeId: "node-a", kind: "navigate", targetLayerId: "layer-b" }],
        },
        {
          id: "layer-b",
          nodeIds: ["node-b"],
          actions: [{ id: "action-ba", sourceNodeId: "node-b", kind: "navigate", targetLayerId: "layer-a" }],
        },
      ],
    })).toThrow("Review topology must be acyclic; found \"layer-a\" -> \"layer-b\" -> \"layer-a\"");
  });

  it("preserves revisions and invokes evidence validation before mutating state", () => {
    const inventory = inventoryReviewSubjects(topology);
    const validator = vi.fn((request: { review: { evidence: readonly string[] } }) => {
      if (request.review.evidence.includes("shot-unrelated")) throw new Error("screenshot state does not match subject");
    });
    const store = new IncrementalReviewStore<TestLayerReview, TestNodeReview, TestTurnReview>({
      inventory,
      validateEvidence: validator,
    });

    expect(store.reviewLayer(layerReview("layer-root", "first")).revision).toBe(1);
    expect(store.reviewLayer(layerReview("layer-root", "revised")).revision).toBe(2);
    expect(() => store.reviewLayer({
      layerId: "layer-child",
      evidence: ["shot-unrelated"],
      summary: "invalid",
    })).toThrow("screenshot state does not match subject");

    const snapshot = store.snapshot();
    expect(snapshot.layers).toHaveLength(1);
    expect(snapshot.layers[0]!.history.current.summary).toBe("revised");
    expect(snapshot.layers[0]!.history.revisions.map(({ revision, review }) => [revision, review.summary])).toEqual([
      [1, "first"],
      [2, "revised"],
    ]);
    expect(snapshot.trace.map(({ sequence, tool, subjectRevision }) => ({ sequence, tool, subjectRevision }))).toEqual([
      { sequence: 1, tool: "reviewLayer", subjectRevision: 1 },
      { sequence: 2, tool: "reviewLayer", subjectRevision: 2 },
    ]);
    expect(validator).toHaveBeenCalledTimes(3);
  });

  it("reports the exact missing layer, node, nested action, and turn subjects", () => {
    const inventory = inventoryReviewSubjects(topology);
    const store = new IncrementalReviewStore<TestLayerReview, TestNodeReview, TestTurnReview>({ inventory });
    store.reviewLayer(layerReview("layer-root"));
    store.reviewNode(nodeReview("layer-root", "node-a", [
      { actionId: "action-child", kind: "navigate" },
    ]));
    store.reviewNode(nodeReview("layer-root", "node-b", [
      { actionId: "action-shared", kind: "navigate" },
    ]));

    expect(store.coverage().missingSubjects.map(formatMissingSubject)).toEqual([
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
      expect(error).toBeInstanceOf(MissingReviewSubjectsError);
      expect((error as MissingReviewSubjectsError).missingSubjects.map(formatMissingSubject)).toEqual([
        "layer(\"layer-child\")",
        "layer(\"layer-deep\")",
        "node(\"layer-child\"/\"node-c\")",
        "node(\"layer-deep\"/\"node-d\")",
        "invoke-action(\"layer-root\"/\"node-b\"/\"action-invoke\")",
        "navigate-action(\"layer-child\"/\"node-c\"/\"action-deep\")",
      ]);
    }
  });

  it("finalizes one immutable result only after complete lower-subject coverage", () => {
    const inventory = inventoryReviewSubjects(topology);
    const store = new IncrementalReviewStore<TestLayerReview, TestNodeReview, TestTurnReview>({ inventory });
    for (const subject of inventory.layers) store.reviewLayer(layerReview(String(subject.layerId)));
    store.reviewNode(nodeReview("layer-root", "node-a", [
      { actionId: "action-child", kind: "navigate" },
    ]));
    store.reviewNode(nodeReview("layer-root", "node-b", [
      { actionId: "action-shared", kind: "navigate" },
      { actionId: "action-invoke", kind: "invoke" },
    ]));
    store.reviewNode(nodeReview("layer-child", "node-c", [
      { actionId: "action-deep", kind: "navigate" },
    ]));
    store.reviewNode(nodeReview("layer-deep", "node-d"));

    expect(store.coverage()).toMatchObject({ complete: false, turn: { required: 1, reviewed: 0, missing: 1 } });
    const result = store.submitReview({ turnId: "turn-1", evidence: ["shot-root"], summary: "complete" });
    expect(result.coverage).toMatchObject({ complete: true, turn: { required: 1, reviewed: 1, missing: 0 } });
    expect(result.nodes.find(({ subject }) => subject.nodeId === "node-b")!.history.current.actions).toEqual([
      { actionId: "action-shared", kind: "navigate" },
      { actionId: "action-invoke", kind: "invoke" },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => store.reviewLayer(layerReview("layer-root", "too late"))).toThrow("Review is already finalized");
    expect(() => store.submitReview({ turnId: "turn-1", evidence: [], summary: "twice" })).toThrow(
      "Review is already finalized",
    );
  });

  it("rejects unknown, duplicate, and wrong-kind action reviews", () => {
    const store = new IncrementalReviewStore<TestLayerReview, TestNodeReview, TestTurnReview>({
      inventory: inventoryReviewSubjects(topology),
    });
    expect(() => store.reviewNode(nodeReview("layer-root", "node-b", [
      { actionId: "missing", kind: "invoke" },
    ]))).toThrow("Unknown action review subject: \"missing\"");
    expect(() => store.reviewNode(nodeReview("layer-root", "node-b", [
      { actionId: "action-shared", kind: "navigate" },
      { actionId: "action-shared", kind: "navigate" },
    ]))).toThrow("Duplicate action review: \"action-shared\"");
    expect(() => store.reviewNode(nodeReview("layer-root", "node-b", [
      { actionId: "action-invoke", kind: "navigate" },
    ]))).toThrow("Action review \"action-invoke\" has kind navigate; expected invoke");
  });
});
