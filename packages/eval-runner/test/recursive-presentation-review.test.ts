import { describe, expect, it } from "vitest";
import { inventoryReviewSubjects } from "../src/simulated-user/inventory.js";
import { createRecursiveScreenshotEvidenceValidator } from "../src/simulated-user/recursive-evidence-validator.js";
import type { ScreenshotMetadata } from "../src/simulated-user/contracts.js";
import {
  RecursivePresentationReviewStore,
  type RecursiveLayerResult,
  type RecursiveNodeReview,
  type RecursiveNodeScore,
  type RecursiveTurnReview,
} from "../src/simulated-user/recursive-review.js";

function judgment(score: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | null, evidence = ["shot-root"]) {
  return { score, reason: score === null ? "Not assessable in this fixture." : `Fixture judgment ${score}.`, evidence } as const;
}

const ratings = {
  purpose_clarity: judgment(8),
  cohesion: judgment(8),
  visual_organization: judgment(8),
  relationship_clarity: judgment(8),
  coverage: judgment(8),
} as const;
const screenshotDigest = `sha256:${"a".repeat(64)}` as const;

function screenshotMetadata(screenshotId: string, layerId: string, selectedNodeId: string | null, viaActionId: string | null): ScreenshotMetadata {
  return {
    schemaVersion: 1,
    screenshotId,
    executionId: "execution-1",
    threadId: "thread-1",
    turnId: "turn-1",
    layerId,
    selectedNodeId,
    activatedActionId: viaActionId,
    navigationPath: [
      { layerId: "root", viaActionId: null },
      ...(layerId === "root" ? [] : [{ layerId, viaActionId }]),
    ],
    label: screenshotId,
    mode: "visible",
    viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
    captureTarget: { kind: "viewport" },
    tileCount: 1,
    tiles: [{ index: 0, width: 1200, height: 800, contentDigest: screenshotDigest }],
    contentDigest: screenshotDigest,
  };
}

const topology = {
  turnId: "turn-1",
  rootLayerId: "root",
  layers: [
    {
      id: "root",
      nodeIds: ["root-node"],
      actions: [
        { id: "expand-a", sourceNodeId: "root-node", kind: "navigate" as const, relation: "expand" as const, targetLayerId: "child" },
        { id: "invoke-a", sourceNodeId: "root-node", kind: "invoke" as const },
      ],
    },
    { id: "child", nodeIds: ["child-node"], actions: [] },
  ],
};

function semantic(nodeId: string, evidence = [`shot-${nodeId}`]) {
  return {
    nodeId,
    meaning: `${nodeId} meaning`,
    delivered: `${nodeId} delivery`,
    limitations: "None observed.",
    effectOnLayer: "Supports the layer.",
    evidence,
  };
}

function score(nodeId: string, overrides: Partial<Record<Exclude<keyof RecursiveNodeScore, "nodeId">, number | null>> = {}): RecursiveNodeScore {
  const value = (key: Exclude<keyof RecursiveNodeScore, "nodeId">, fallback: number | null) =>
    judgment((overrides[key] ?? fallback) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | null, [`shot-${nodeId}`]);
  return {
    nodeId,
    content: value("content", 8),
    actionAllocation: value("actionAllocation", 8),
    actionDelivery: value("actionDelivery", null),
    recursiveQuality: value("recursiveQuality", null),
    polish: value("polish", 8),
  };
}

function ranking(preferred: "expand" | "reference" | "invoke" | "input" | "stop") {
  const choices = ["expand", "reference", "invoke", "input", "stop"] as const;
  return choices.map((choice) => ({ choice, rank: (choice === preferred ? 1 : choices.indexOf(choice) + 2) }))
    .sort((left, right) => left.rank - right.rank)
    .map((entry, index) => ({ ...entry, rank: (index + 1) as 1 | 2 | 3 | 4 | 5 }));
}

function leafNodeReview(): RecursiveNodeReview {
  return {
    layerId: "child",
    nodeId: "child-node",
    evidence: { context: ["shot-child"], detail: ["shot-child"] },
    score: score("child-node"),
    semantic: semantic("child-node", ["shot-child"]),
    allocationSteps: [{
      step: 0,
      ranking: ranking("stop"),
      preferredChoice: "stop",
      authoredChoice: "stop",
      authoredActionId: null,
      margin: "close",
      selectionFinding: "The atomic explanation should stop here.",
      evidence: ["shot-child"],
    }],
    actions: [],
    findings: [],
  };
}

function layerResult(layerId: string, depth: number, nodeReview: RecursiveNodeReview): RecursiveLayerResult {
  return {
    layerId,
    depth,
    nodeScores: [nodeReview.score, null, null, null, null, null, null, null],
    nodeSemantics: [nodeReview.semantic, null, null, null, null, null, null, null],
    criterionJudgments: ratings,
    materiallyMisleading: false,
    layerSummary: `${layerId} summary`,
    evidence: [...nodeReview.evidence.context],
  };
}

function rootNodeReview(): RecursiveNodeReview {
  return {
    layerId: "root",
    nodeId: "root-node",
    evidence: { context: ["shot-root"], detail: ["shot-root"] },
    score: score("root-node", { actionDelivery: 4, recursiveQuality: 4 }),
    semantic: semantic("root-node", ["shot-root", "shot-child"]),
    allocationSteps: [
      {
        step: 0,
        ranking: ranking("expand"),
        preferredChoice: "expand",
        authoredChoice: "expand",
        authoredActionId: "expand-a",
        margin: "close",
        selectionFinding: "Expansion is the best first allocation.",
        evidence: ["shot-root"],
      },
      {
        step: 1,
        ranking: ranking("stop"),
        preferredChoice: "stop",
        authoredChoice: "invoke",
        authoredActionId: "invoke-a",
        margin: "clearly_better",
        selectionFinding: "The invocation is an unnecessary extra.",
        evidence: ["shot-root"],
      },
      {
        step: 2,
        ranking: ranking("stop"),
        preferredChoice: "stop",
        authoredChoice: "stop",
        authoredActionId: null,
        margin: "close",
        selectionFinding: "No more allocation is useful.",
        evidence: ["shot-root"],
      },
    ],
    actions: [
      {
        actionId: "expand-a",
        kind: "expand",
        allocationStep: 0,
        labelAndPlacement: "Clear expansion.",
        delivery: "The child delivers implementation detail.",
        recursiveContribution: "The child result materially supports the root promise.",
        targetLayerId: "child",
        reusedLayerId: null,
        evidence: ["shot-root", "shot-child"],
      },
      {
        actionId: "invoke-a",
        kind: "invoke",
        allocationStep: 1,
        labelAndPlacement: "Understandable but unnecessary.",
        delivery: null,
        recursiveContribution: null,
        targetLayerId: null,
        reusedLayerId: null,
        evidence: ["shot-root"],
      },
    ],
    findings: [],
  };
}

function turnReview(root: RecursiveLayerResult): RecursiveTurnReview {
  return {
    turnId: "turn-1",
    rootLayerResult: root,
    evidence: { representative: ["shot-root"] },
    criterionJudgments: {
      answer_quality: judgment(8),
      recursive_coherence: judgment(8),
      navigation_value: judgment(6),
      presentation_quality: judgment(8),
      follow_up_progress: judgment(null),
    },
    summary: "The root result is a complete handoff.",
    findings: [],
    scoreCeiling: { maximum: 8, reason: "No critical omission.", evidence: ["shot-root"] },
  };
}

describe("recursive semantic presentation review", () => {
  it("records a source-only unanswered input action with exactly three v11 quality judgments", () => {
    const inventory = inventoryReviewSubjects({
      turnId: "turn-input",
      rootLayerId: "layer-input",
      layers: [{
        id: "layer-input",
        nodeIds: ["node-input"],
        actions: [{
          id: "action-input",
          sourceNodeId: "node-input",
          kind: "input",
          control: "text",
          prompt: "What deployment window should we use?",
          options: [],
        }],
      }],
    });
    const store = new RecursivePresentationReviewStore({ inventory });
    const review: RecursiveNodeReview = {
      layerId: "layer-input",
      nodeId: "node-input",
      evidence: { context: ["shot-input"], detail: ["shot-input"] },
      score: score("node-input"),
      semantic: semantic("node-input", ["shot-input"]),
      allocationSteps: [
        {
          step: 0,
          ranking: ranking("input"),
          preferredChoice: "input",
          authoredChoice: "input",
          authoredActionId: "action-input",
          margin: "necessary",
          selectionFinding: "The user owns the deployment-window decision.",
          evidence: ["shot-input"],
        },
        {
          step: 1,
          ranking: ranking("stop"),
          preferredChoice: "stop",
          authoredChoice: "stop",
          authoredActionId: null,
          margin: "close",
          selectionFinding: "No additional allocation is useful.",
          evidence: ["shot-input"],
        },
      ],
      actions: [{
        actionId: "action-input",
        kind: "input",
        allocationStep: 0,
        labelAndPlacement: "The question is presented at its decision point.",
        delivery: null,
        recursiveContribution: null,
        targetLayerId: null,
        reusedLayerId: null,
        evidence: ["shot-input"],
        inputActionJudgments: {
          prompt_answerability: judgment(8, ["shot-input"]),
          option_set_quality: judgment(8, ["shot-input"]),
          control_fit: judgment(8, ["shot-input"]),
        },
      }],
      findings: [],
    };

    const prepared = store.prepareNodeReview(review);
    expect(() => store.reviewNode(review)).toThrow("blocked by a prepared node review");
    expect(() => store.reviewLayer({} as never)).toThrow("blocked by a prepared node review");
    expect(() => store.submitReview({} as never)).toThrow("blocked by a prepared node review");
    expect(store.snapshot().nodes).toEqual([]);
    prepared.cancel();
    store.reviewNode(review);
    expect(store.snapshot()).toMatchObject({
      schemaVersion: 6,
      contractId: "recursive-presentation-judge-v6",
      nodes: [{ history: { current: { actions: [{ kind: "input" }] } } }],
    });
    const { inputActionJudgments: _omitted, ...withoutJudgments } = review.actions[0]!;
    expect(() => new RecursivePresentationReviewStore({ inventory }).reviewNode({
      ...review,
      actions: [withoutJudgments],
    })).toThrow("requires input-action judgments");

    const selected = { ...screenshotMetadata("shot-input", "layer-input", "node-input", null), turnId: "turn-input" };
    const layerOnly = { ...selected, selectedNodeId: null };
    const subject = inventory.nodes[0]!;
    const actionSubjects = inventory.actions;
    const validator = (shot: ScreenshotMetadata) => createRecursiveScreenshotEvidenceValidator({
      executionId: "execution-1",
      threadId: "thread-1",
      turnId: "turn-input",
      screenshots: new Map([[shot.screenshotId, shot]]),
    });
    expect(() => validator(layerOnly)({ kind: "node", subject, actionSubjects, review })).toThrow(
      "rendered controls",
    );
    expect(() => validator(selected)({ kind: "node", subject, actionSubjects, review })).not.toThrow();
  });

  it("requires bottom-up LayerResults and preserves aligned eight-slot vectors", () => {
    const store = new RecursivePresentationReviewStore({ inventory: inventoryReviewSubjects(topology) });
    expect(() => store.reviewNode(rootNodeReview())).toThrow("requires finalized expansion child layer child");

    const child = leafNodeReview();
    store.reviewNode(child);
    const finalizedChild = store.reviewLayer(layerResult("child", 1, child));
    expect(finalizedChild.review.nodeScores).toHaveLength(8);
    expect(finalizedChild.review.nodeScores[0]?.nodeId).toBe("child-node");
    expect(finalizedChild.review.nodeSemantics[1]).toBeNull();

    const rootNode = rootNodeReview();
    store.reviewNode(rootNode);
    const root = store.reviewLayer(layerResult("root", 0, rootNode)).review;
    const result = store.submitReview(turnReview(root));

    expect(result.rootLayerResult).toEqual(root);
    expect(result.layers.map(({ subject }) => subject.layerId)).toEqual(["root", "child"]);
    expect(result.nodes.every(({ history }) => Array.isArray(history.current.missingActionOpportunities))).toBe(true);
    expect(result.coverage.complete).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("validates allocation order, full rankings, every authored action, and invoke nullability", () => {
    const store = new RecursivePresentationReviewStore({ inventory: inventoryReviewSubjects(topology) });
    const child = leafNodeReview();
    store.reviewNode(child);
    store.reviewLayer(layerResult("child", 1, child));

    const missingAction = { ...rootNodeReview(), actions: rootNodeReview().actions.slice(0, 1) };
    expect(() => store.reviewNode(missingAction)).toThrow("Missing authored action review: invoke-a");

    const baseInvalidInvoke = rootNodeReview();
    const invalidInvoke = {
      ...baseInvalidInvoke,
      actions: baseInvalidInvoke.actions.map((action, index) => index === 1
        ? { ...action, delivery: "Not actually delivered." }
        : action),
    };
    expect(() => store.reviewNode(invalidInvoke)).toThrow("Invoke action invoke-a must keep delivery and recursion null");

    const baseDuplicateRanks = rootNodeReview();
    const duplicateRanks = {
      ...baseDuplicateRanks,
      allocationSteps: baseDuplicateRanks.allocationSteps.map((step, index) => index === 0
        ? { ...step, ranking: step.ranking.map((entry, rankIndex) => rankIndex === 1 ? { ...entry, rank: 1 as const } : entry) }
        : step),
    };
    expect(() => store.reviewNode(duplicateRanks)).toThrow("must rank each choice exactly once");
  });

  it("requires scores for occupied node, layer, and turn criteria except inapplicable node destinations", () => {
    const nodeStore = new RecursivePresentationReviewStore({ inventory: inventoryReviewSubjects(topology) });
    const baseNode = leafNodeReview();
    const invalidNode = { ...baseNode, score: { ...baseNode.score, content: judgment(null) } };
    expect(() => nodeStore.reviewNode(invalidNode)).toThrow("Node child-node content must have a score");

    const store = new RecursivePresentationReviewStore({ inventory: inventoryReviewSubjects(topology) });
    const child = leafNodeReview();
    store.reviewNode(child);
    const childLayer = layerResult("child", 1, child);
    const invalidLayer = {
      ...childLayer,
      criterionJudgments: { ...childLayer.criterionJudgments, cohesion: judgment(null) },
    };
    expect(() => store.reviewLayer(invalidLayer)).toThrow("Layer child cohesion must have a score");

    store.reviewLayer(childLayer);
    const rootNode = rootNodeReview();
    store.reviewNode(rootNode);
    const root = store.reviewLayer(layerResult("root", 0, rootNode)).review;
    const baseTurn = turnReview(root);
    const invalidTurn = {
      ...baseTurn,
      criterionJudgments: { ...baseTurn.criterionJudgments, answer_quality: judgment(null) },
    };
    expect(() => store.submitReview(invalidTurn)).toThrow("Turn answer_quality must have a score");
  });

  it("requires both source and traversed destination evidence for navigate delivery", () => {
    const inventory = inventoryReviewSubjects(topology);
    const source = screenshotMetadata("shot-root", "root", "root-node", null);
    const destination = screenshotMetadata("shot-child", "child", null, "expand-a");
    const validate = createRecursiveScreenshotEvidenceValidator({
      executionId: "execution-1",
      threadId: "thread-1",
      turnId: "turn-1",
      screenshots: new Map([[source.screenshotId, source], [destination.screenshotId, destination]]),
    });
    const subject = inventory.nodes.find(({ nodeId }) => nodeId === "root-node")!;
    const actionSubjects = inventory.actions.filter(({ nodeId }) => nodeId === "root-node");
    const sourceOnly = {
      ...rootNodeReview(),
      actions: rootNodeReview().actions.map((action) => action.kind === "expand"
        ? { ...action, evidence: ["shot-root"] }
        : action),
    };

    expect(() => validate({ kind: "node", subject, actionSubjects, review: sourceOnly })).toThrow(
      "requires both source and traversed destination evidence",
    );
    expect(() => validate({ kind: "node", subject, actionSubjects, review: rootNodeReview() })).not.toThrow();
  });

  it("does not recursively grade references and reuses an existing finalized LayerResult", () => {
    const referenceInventory = inventoryReviewSubjects({
      turnId: "turn-ref",
      rootLayerId: "root",
      layers: [
        {
          id: "root",
          nodeIds: ["root-node"],
          actions: [
            { id: "expand-a", sourceNodeId: "root-node", kind: "navigate", relation: "expand", targetLayerId: "shared" },
            { id: "reference-a", sourceNodeId: "root-node", kind: "navigate", relation: "reference", targetLayerId: "shared" },
          ],
        },
        { id: "shared", nodeIds: ["shared-node"], actions: [] },
      ],
    });
    expect(referenceInventory.layers.map(({ layerId }) => layerId)).toEqual(["root", "shared"]);
    expect(referenceInventory.layers.filter(({ layerId }) => layerId === "shared")).toHaveLength(1);

    const store = new RecursivePresentationReviewStore({ inventory: referenceInventory });
    const shared = { ...leafNodeReview(), layerId: "shared", nodeId: "shared-node", score: score("shared-node"), semantic: semantic("shared-node") };
    const base = rootNodeReview();
    const root = {
      ...base,
      allocationSteps: base.allocationSteps.map((step, index) => index === 1 ? {
        ...step,
        ranking: ranking("reference"),
        preferredChoice: "reference" as const,
        authoredChoice: "reference" as const,
        authoredActionId: "reference-a",
        margin: "close" as const,
        selectionFinding: "The finalized shared result is useful without regrading it.",
      } : step),
      actions: [
        { ...base.actions[0]!, targetLayerId: "shared", evidence: ["shot-root", "shot-shared"] },
        {
          actionId: "reference-a",
          kind: "reference" as const,
          allocationStep: 1,
          labelAndPlacement: "The reference is clear.",
          delivery: "The shared LayerResult supports the source node.",
          recursiveContribution: null,
          targetLayerId: "shared",
          reusedLayerId: "shared",
          evidence: ["shot-root", "shot-shared"],
        },
      ],
    };
    expect(() => store.reviewNode(root)).toThrow("requires finalized expansion child layer shared");
    store.reviewNode(shared);
    store.reviewLayer(layerResult("shared", 1, shared));
    expect(store.reviewNode(root).review.actions[1]).toMatchObject({
      kind: "reference",
      reusedLayerId: "shared",
    });
  });

  it("grades a reference-only destination without inventing a recursive LayerResult", () => {
    const inventory = inventoryReviewSubjects({
      turnId: "turn-ref-only",
      rootLayerId: "root",
      layers: [
        {
          id: "root",
          nodeIds: ["root-node"],
          actions: [
            { id: "reference-a", sourceNodeId: "root-node", kind: "navigate", relation: "reference", targetLayerId: "prior" },
          ],
        },
        { id: "prior", nodeIds: ["prior-node"], actions: [] },
      ],
    });
    expect(inventory.layers.map(({ layerId }) => layerId)).toEqual(["root"]);

    const store = new RecursivePresentationReviewStore({ inventory });
    const review: RecursiveNodeReview = {
      layerId: "root",
      nodeId: "root-node",
      evidence: { context: ["shot-root"], detail: ["shot-root", "shot-prior"] },
      score: score("root-node", { actionDelivery: 4 }),
      semantic: semantic("root-node", ["shot-root", "shot-prior"]),
      allocationSteps: [
        {
          step: 0,
          ranking: ranking("reference"),
          preferredChoice: "reference",
          authoredChoice: "reference",
          authoredActionId: "reference-a",
          margin: "clearly_better",
          selectionFinding: "The prior result provides useful supporting evidence.",
          evidence: ["shot-root", "shot-prior"],
        },
        {
          step: 1,
          ranking: ranking("stop"),
          preferredChoice: "stop",
          authoredChoice: "stop",
          authoredActionId: null,
          margin: "close",
          selectionFinding: "No further allocation is useful.",
          evidence: ["shot-root"],
        },
      ],
      actions: [{
        actionId: "reference-a",
        kind: "reference",
        allocationStep: 0,
        labelAndPlacement: "The reference is clearly placed.",
        delivery: "The traversed prior layer delivers the promised evidence.",
        recursiveContribution: null,
        targetLayerId: "prior",
        reusedLayerId: null,
        evidence: ["shot-root", "shot-prior"],
      }],
      findings: [],
    };

    expect(store.reviewNode(review).review.actions[0]).toMatchObject({
      kind: "reference",
      targetLayerId: "prior",
      reusedLayerId: null,
    });
  });

  it("allows a child back-reference without waiting for its unfinished ancestor LayerResult", () => {
    const inventory = inventoryReviewSubjects({
      turnId: "turn-cycle",
      rootLayerId: "root",
      layers: [
        { id: "root", nodeIds: ["root-node"], actions: [
          { id: "expand-child", sourceNodeId: "root-node", kind: "navigate", relation: "expand", targetLayerId: "child" },
        ] },
        { id: "child", nodeIds: ["child-node"], actions: [
          { id: "reference-root", sourceNodeId: "child-node", kind: "navigate", relation: "reference", targetLayerId: "root" },
        ] },
      ],
    });
    const store = new RecursivePresentationReviewStore({ inventory });
    const child: RecursiveNodeReview = {
      layerId: "child",
      nodeId: "child-node",
      evidence: { context: ["shot-child"], detail: ["shot-child"] },
      score: score("child-node", { actionDelivery: 4 }),
      semantic: semantic("child-node", ["shot-child"]),
      allocationSteps: [
        { step: 0, ranking: ranking("reference"), preferredChoice: "reference", authoredChoice: "reference", authoredActionId: "reference-root", margin: "close", selectionFinding: "The root remains useful context.", evidence: ["shot-child"] },
        { step: 1, ranking: ranking("stop"), preferredChoice: "stop", authoredChoice: "stop", authoredActionId: null, margin: "close", selectionFinding: "Stop after the back-reference.", evidence: ["shot-child"] },
      ],
      actions: [{
        actionId: "reference-root",
        kind: "reference",
        allocationStep: 0,
        labelAndPlacement: "Clear return to overview.",
        delivery: "The root restores the overview.",
        recursiveContribution: null,
        targetLayerId: "root",
        reusedLayerId: null,
        evidence: ["shot-child", "shot-root"],
      }],
      findings: [],
    };
    expect(store.reviewNode(child).review.actions[0]?.reusedLayerId).toBeNull();
    expect(store.reviewLayer(layerResult("child", 1, child)).review.layerId).toBe("child");
  });

  it("rejects null recursive layer judgments even when they have a reason", () => {
    const store = new RecursivePresentationReviewStore({ inventory: inventoryReviewSubjects({
      turnId: "flat-turn",
      rootLayerId: "flat-layer",
      layers: [{ id: "flat-layer", nodeIds: ["flat-node"], actions: [] }],
    }) });
    const node = { ...leafNodeReview(), layerId: "flat-layer", nodeId: "flat-node", score: score("flat-node"), semantic: semantic("flat-node", ["shot-flat"]), evidence: { context: ["shot-flat"], detail: ["shot-flat"] }, allocationSteps: [{ ...leafNodeReview().allocationSteps[0]!, evidence: ["shot-flat"] }] };
    store.reviewNode(node);
    const result = layerResult("flat-layer", 0, node);
    const nullable = { ...result, criterionJudgments: { ...ratings, coverage: { score: null, reason: "", evidence: ["shot-flat"] } } } as RecursiveLayerResult;
    expect(() => store.reviewLayer(nullable)).toThrow("coverage must have a score");
    expect(() => store.reviewLayer({ ...nullable, criterionJudgments: { ...nullable.criterionJudgments, coverage: judgment(null, ["shot-flat"]) } })).toThrow("coverage must have a score");
  });

  it("rejects misaligned vectors and final turn judgments that do not consume the current root result", () => {
    const store = new RecursivePresentationReviewStore({ inventory: inventoryReviewSubjects(topology) });
    const child = leafNodeReview();
    store.reviewNode(child);
    store.reviewLayer(layerResult("child", 1, child));
    const rootNode = rootNodeReview();
    store.reviewNode(rootNode);

    const baseMisaligned = layerResult("root", 0, rootNode);
    const misaligned = {
      ...baseMisaligned,
      nodeSemantics: [semantic("wrong-node"), ...baseMisaligned.nodeSemantics.slice(1)],
    } as unknown as RecursiveLayerResult;
    expect(() => store.reviewLayer(misaligned)).toThrow("score and semantic slots must align");

    const root = store.reviewLayer(layerResult("root", 0, rootNode)).review;
    const stale = { ...root, layerSummary: "stale copy" };
    expect(() => store.submitReview(turnReview(stale))).toThrow("must consume the current root LayerResult");
  });

  it.each([
    ["flat stop", "stop", "close", 4, "Atomic answer should stop."],
    ["missed useful expansion", "expand", "clearly_better", 2, "A useful expansion was missed."],
    ["missed required expansion", "expand", "necessary", 1, "A required expansion was missed."],
  ] as const)("represents %s with a coherent allocation consequence", (_name, preferred, margin, actionAllocation, effect) => {
    const inventory = inventoryReviewSubjects({
      turnId: "flat-turn",
      rootLayerId: "flat-layer",
      layers: [{ id: "flat-layer", nodeIds: ["flat-node"], actions: [] }],
    });
    const store = new RecursivePresentationReviewStore({ inventory });
    const node: RecursiveNodeReview = {
      layerId: "flat-layer",
      nodeId: "flat-node",
      evidence: { context: ["shot-flat"], detail: ["shot-flat"] },
      score: score("flat-node", { actionAllocation }),
      semantic: { ...semantic("flat-node", ["shot-flat"]), effectOnLayer: effect },
      allocationSteps: [{
        step: 0,
        ranking: ranking(preferred),
        preferredChoice: preferred,
        authoredChoice: "stop",
        authoredActionId: null,
        margin,
        selectionFinding: effect,
        evidence: ["shot-flat"],
      }],
      missingActionOpportunities: preferred === "stop" ? [] : [{
        allocationStep: 0,
        preferredChoice: preferred,
        importance: margin === "necessary" ? "critical" : "material",
        unansweredQuestion: "What mechanism or evidence supports this status claim?",
        expectedContribution: "Explain the distinct causal or evidentiary depth omitted from the root node.",
        artifactEvidence: ["src/example.ts"],
        evidence: ["shot-flat"],
      }],
      actions: [],
      findings: [],
    };
    store.reviewNode(node);
    expect(store.reviewLayer(layerResult("flat-layer", 0, node)).review.nodeScores[0]?.actionAllocation.score).toBe(actionAllocation);
  });

  it("rejects a perfect allocation score when a material expansion opportunity is missing", () => {
    const inventory = inventoryReviewSubjects({
      turnId: "flat-turn",
      rootLayerId: "flat-layer",
      layers: [{ id: "flat-layer", nodeIds: ["flat-node"], actions: [] }],
    });
    const store = new RecursivePresentationReviewStore({ inventory });
    const node = {
      layerId: "flat-layer",
      nodeId: "flat-node",
      evidence: { context: ["shot-flat"], detail: ["shot-flat"] },
      score: score("flat-node", { actionAllocation: 8 }),
      semantic: semantic("flat-node", ["shot-flat"]),
      allocationSteps: [{
        step: 0,
        ranking: ranking("expand"),
        preferredChoice: "expand",
        authoredChoice: "stop",
        authoredActionId: null,
        margin: "clearly_better",
        selectionFinding: "The mechanism is missing.",
        evidence: ["shot-flat"],
      }],
      missingActionOpportunities: [{
        allocationStep: 0,
        preferredChoice: "expand",
        importance: "material",
        unansweredQuestion: "How does the failure reach the response boundary?",
        expectedContribution: "Trace the causal path from input to failure.",
        artifactEvidence: ["src/utils/sanitize.ts", "src/response.ts"],
        evidence: ["shot-flat"],
      }],
      actions: [],
      findings: [],
    } as const satisfies RecursiveNodeReview;

    expect(() => store.reviewNode(node)).toThrow(
      "material missing-action opportunity caps actionAllocation at 4",
    );
  });

  it("requires a first-class finding when a materially better expansion is absent", () => {
    const inventory = inventoryReviewSubjects({
      turnId: "flat-turn",
      rootLayerId: "flat-layer",
      layers: [{ id: "flat-layer", nodeIds: ["flat-node"], actions: [] }],
    });
    const store = new RecursivePresentationReviewStore({ inventory });
    const node: RecursiveNodeReview = {
      layerId: "flat-layer",
      nodeId: "flat-node",
      evidence: { context: ["shot-flat"], detail: ["shot-flat"] },
      score: score("flat-node", { actionAllocation: 2 }),
      semantic: semantic("flat-node", ["shot-flat"]),
      allocationSteps: [{
        step: 0,
        ranking: ranking("expand"),
        preferredChoice: "expand",
        authoredChoice: "stop",
        authoredActionId: null,
        margin: "clearly_better",
        selectionFinding: "The status claim omits the failure mechanism.",
        evidence: ["shot-flat"],
      }],
      actions: [],
      findings: [],
    };

    expect(() => store.reviewNode(node)).toThrow(
      "materially preferred absent expand action requires a missing-action opportunity",
    );
  });

  it("prevents a material missing expansion from receiving perfect recursive coherence", () => {
    const inventory = inventoryReviewSubjects({
      turnId: "flat-turn",
      rootLayerId: "flat-layer",
      layers: [{ id: "flat-layer", nodeIds: ["flat-node"], actions: [] }],
    });
    const store = new RecursivePresentationReviewStore({ inventory });
    const node: RecursiveNodeReview = {
      layerId: "flat-layer",
      nodeId: "flat-node",
      evidence: { context: ["shot-flat"], detail: ["shot-flat"] },
      score: score("flat-node", { actionAllocation: 2 }),
      semantic: semantic("flat-node", ["shot-flat"]),
      allocationSteps: [{
        step: 0,
        ranking: ranking("expand"),
        preferredChoice: "expand",
        authoredChoice: "stop",
        authoredActionId: null,
        margin: "clearly_better",
        selectionFinding: "The mechanism is missing.",
        evidence: ["shot-flat"],
      }],
      missingActionOpportunities: [{
        allocationStep: 0,
        preferredChoice: "expand",
        importance: "material",
        unansweredQuestion: "How does the failure reach the response boundary?",
        expectedContribution: "Trace the causal path from input to failure.",
        artifactEvidence: ["src/utils/sanitize.ts", "src/response.ts"],
        evidence: ["shot-flat"],
      }],
      actions: [],
      findings: [],
    };
    store.reviewNode(node);
    const root = store.reviewLayer(layerResult("flat-layer", 0, node)).review;
    const turn: RecursiveTurnReview = {
      turnId: "flat-turn",
      rootLayerResult: root,
      evidence: { representative: ["shot-flat"] },
      criterionJudgments: {
        answer_quality: judgment(8, ["shot-flat"]),
        recursive_coherence: judgment(8, ["shot-flat"]),
        navigation_value: judgment(8, ["shot-flat"]),
        presentation_quality: judgment(8, ["shot-flat"]),
        follow_up_progress: judgment(null, ["shot-flat"]),
      },
      summary: "A flat handoff with a material missing expansion.",
      findings: [],
      scoreCeiling: { maximum: 8, reason: "No critical omission.", evidence: ["shot-flat"] },
    };

    expect(() => store.submitReview(turn)).toThrow(
      "material missing-action opportunity caps recursive_coherence at 6",
    );
    const result = store.submitReview({
      ...turn,
      criterionJudgments: {
        ...turn.criterionJudgments,
        recursive_coherence: judgment(6, ["shot-flat"]),
        navigation_value: judgment(6, ["shot-flat"]),
        presentation_quality: judgment(6, ["shot-flat"]),
      },
    });
    expect(result.coverage.allocations).toEqual({
      required: 1,
      reviewed: 1,
      missing: 0,
      authoredActions: 0,
      missingOpportunities: 1,
      correctStops: 0,
    });
  });

  it("caps the whole presentation when an absent action is necessary", () => {
    const inventory = inventoryReviewSubjects({
      turnId: "critical-turn",
      rootLayerId: "critical-layer",
      layers: [{ id: "critical-layer", nodeIds: ["critical-node"], actions: [] }],
    });
    const store = new RecursivePresentationReviewStore({ inventory });
    const node: RecursiveNodeReview = {
      layerId: "critical-layer",
      nodeId: "critical-node",
      evidence: { context: ["shot-critical"], detail: ["shot-critical"] },
      score: score("critical-node", { actionAllocation: 1 }),
      semantic: semantic("critical-node", ["shot-critical"]),
      allocationSteps: [{
        step: 0,
        ranking: ranking("expand"),
        preferredChoice: "expand",
        authoredChoice: "stop",
        authoredActionId: null,
        margin: "necessary",
        selectionFinding: "The main result cannot be understood without the missing explanation.",
        evidence: ["shot-critical"],
      }],
      missingActionOpportunities: [{
        allocationStep: 0,
        preferredChoice: "expand",
        importance: "critical",
        unansweredQuestion: "What was actually changed and why does it solve the request?",
        expectedContribution: "Explain the otherwise absent main result.",
        artifactEvidence: ["src/change.ts"],
        evidence: ["shot-critical"],
      }],
      actions: [],
      findings: [],
    };
    store.reviewNode(node);
    const root = store.reviewLayer(layerResult("critical-layer", 0, node)).review;
    const turn: RecursiveTurnReview = {
      turnId: "critical-turn",
      rootLayerResult: root,
      evidence: { representative: ["shot-critical"] },
      criterionJudgments: {
        answer_quality: judgment(4, ["shot-critical"]),
        recursive_coherence: judgment(4, ["shot-critical"]),
        navigation_value: judgment(4, ["shot-critical"]),
        presentation_quality: judgment(4, ["shot-critical"]),
        follow_up_progress: judgment(null, ["shot-critical"]),
      },
      summary: "The main explanation is absent.",
      findings: [],
      scoreCeiling: { maximum: 8, reason: "No ceiling applied.", evidence: ["shot-critical"] },
    };

    expect(() => store.submitReview(turn)).toThrow(
      "Critical missing-action opportunity caps the presentation score at 4",
    );
    expect(store.submitReview({
      ...turn,
      scoreCeiling: { maximum: 4, reason: "The main explanation is absent.", evidence: ["shot-critical"] },
    }).turn.scoreCeiling.maximum).toBe(4);
  });

  it.each([
    ["local deep weakness", 4, "The deep weakness remains local after two semantic compression boundaries."],
    ["parent-impacting deep finding", 1, "The deep failure is reinterpreted because it undermines the root promise."],
  ] as const)("compresses a %s through real nested expansion boundaries", (_name, rootContent, rootEffect) => {
    const nestedTopology = {
      turnId: "nested-turn",
      rootLayerId: "nested-root",
      layers: [
        { id: "nested-root", nodeIds: ["root-node"], actions: [{ id: "to-middle", sourceNodeId: "root-node", kind: "navigate" as const, relation: "expand" as const, targetLayerId: "middle" }] },
        { id: "middle", nodeIds: ["middle-node"], actions: [{ id: "to-deep", sourceNodeId: "middle-node", kind: "navigate" as const, relation: "expand" as const, targetLayerId: "deep" }] },
        { id: "deep", nodeIds: ["deep-node"], actions: [] },
      ],
    };
    const store = new RecursivePresentationReviewStore({ inventory: inventoryReviewSubjects(nestedTopology) });
    const deep: RecursiveNodeReview = {
      layerId: "deep",
      nodeId: "deep-node",
      evidence: { context: ["shot-deep"], detail: ["shot-deep"] },
      score: score("deep-node", { content: 1 }),
      semantic: { ...semantic("deep-node", ["shot-deep"]), limitations: "A concrete deep defect is visible." },
      allocationSteps: [{ step: 0, ranking: ranking("stop"), preferredChoice: "stop", authoredChoice: "stop", authoredActionId: null, margin: "close", selectionFinding: "No deeper allocation is useful.", evidence: ["shot-deep"] }],
      actions: [],
      findings: [],
    };
    store.reviewNode(deep);
    store.reviewLayer(layerResult("deep", 2, deep));

    const expandingNode = (layerId: string, nodeId: string, actionId: string, targetLayerId: string, effectOnLayer: string, content: 1 | 4): RecursiveNodeReview => ({
      layerId,
      nodeId,
      evidence: { context: [`shot-${layerId}`], detail: [`shot-${layerId}`] },
      score: score(nodeId, { content, actionDelivery: content, recursiveQuality: content }),
      semantic: { ...semantic(nodeId, [`shot-${layerId}`, `shot-${targetLayerId}`]), effectOnLayer },
      allocationSteps: [
        { step: 0, ranking: ranking("expand"), preferredChoice: "expand", authoredChoice: "expand", authoredActionId: actionId, margin: "close", selectionFinding: "Expansion is appropriate.", evidence: [`shot-${layerId}`] },
        { step: 1, ranking: ranking("stop"), preferredChoice: "stop", authoredChoice: "stop", authoredActionId: null, margin: "close", selectionFinding: "Allocation ends.", evidence: [`shot-${layerId}`] },
      ],
      actions: [{
        actionId,
        kind: "expand",
        allocationStep: 0,
        labelAndPlacement: "The expansion promise is clear.",
        delivery: "The finalized child result is inspectable.",
        recursiveContribution: `The ${targetLayerId} LayerResult is compressed into ${nodeId}.`,
        targetLayerId,
        reusedLayerId: null,
        evidence: [`shot-${layerId}`, `shot-${targetLayerId}`],
      }],
      findings: [],
    });
    const middle = expandingNode("middle", "middle-node", "to-deep", "deep", "The child defect is compressed at the middle boundary.", 1);
    store.reviewNode(middle);
    store.reviewLayer(layerResult("middle", 1, middle));
    const root = expandingNode("nested-root", "root-node", "to-middle", "middle", rootEffect, rootContent);
    store.reviewNode(root);
    const rootResult = store.reviewLayer(layerResult("nested-root", 0, root)).review;

    expect(rootResult.nodeSemantics[0]?.effectOnLayer).toBe(rootEffect);
    expect(rootResult.nodeScores[0]?.content.score).toBe(rootContent);
    expect(store.snapshot().trace.map(({ layerId }) => layerId)).toEqual([
      "deep", "deep", "middle", "middle", "nested-root", "nested-root",
    ]);
  });

  it("accepts multiple repeated action kinds and distinguishes useful from unnecessary extras", () => {
    const inventory = inventoryReviewSubjects({
      turnId: "multi-turn",
      rootLayerId: "multi-layer",
      layers: [{
        id: "multi-layer",
        nodeIds: ["multi-node"],
        actions: [
          { id: "invoke-useful", sourceNodeId: "multi-node", kind: "invoke" },
          { id: "invoke-extra", sourceNodeId: "multi-node", kind: "invoke" },
        ],
      }],
    });
    const store = new RecursivePresentationReviewStore({ inventory });
    const node: RecursiveNodeReview = {
      layerId: "multi-layer",
      nodeId: "multi-node",
      evidence: { context: ["shot-multi"], detail: ["shot-multi"] },
      score: score("multi-node", { actionAllocation: 3 }),
      semantic: semantic("multi-node", ["shot-multi"]),
      allocationSteps: [
        { step: 0, ranking: ranking("invoke"), preferredChoice: "invoke", authoredChoice: "invoke", authoredActionId: "invoke-useful", margin: "close", selectionFinding: "Useful optional deferred work.", evidence: ["shot-multi"] },
        { step: 1, ranking: ranking("stop"), preferredChoice: "stop", authoredChoice: "invoke", authoredActionId: "invoke-extra", margin: "clearly_better", selectionFinding: "Stop was clearly better; inspect this as an extra.", evidence: ["shot-multi"] },
        { step: 2, ranking: ranking("stop"), preferredChoice: "stop", authoredChoice: "stop", authoredActionId: null, margin: "close", selectionFinding: "Allocation ends.", evidence: ["shot-multi"] },
      ],
      actions: ["invoke-useful", "invoke-extra"].map((actionId, allocationStep) => ({
        actionId,
        kind: "invoke" as const,
        allocationStep,
        labelAndPlacement: `${actionId} is visibly described.`,
        delivery: null,
        recursiveContribution: null,
        targetLayerId: null,
        reusedLayerId: null,
        evidence: ["shot-multi"],
      })),
      findings: [],
    };
    store.reviewNode(node);
    expect(store.reviewLayer(layerResult("multi-layer", 0, node)).review.nodeScores[0]?.actionAllocation.score).toBe(3);
  });

  it("represents failed child delivery in the parent while preserving the child semantic signal", () => {
    const store = new RecursivePresentationReviewStore({ inventory: inventoryReviewSubjects(topology) });
    const child = {
      ...leafNodeReview(),
      score: score("child-node", { content: 1 }),
      semantic: { ...semantic("child-node", ["shot-child"]), limitations: "The child does not deliver the promised implementation." },
    };
    store.reviewNode(child);
    store.reviewLayer(layerResult("child", 1, child));
    const root = {
      ...rootNodeReview(),
      score: score("root-node", { actionDelivery: 1, recursiveQuality: 1 }),
      semantic: { ...semantic("root-node", ["shot-root", "shot-child"]), limitations: "The expansion promise fails." },
    };
    store.reviewNode(root);
    expect(store.reviewLayer(layerResult("root", 0, root)).review.nodeScores[0]).toMatchObject({
      actionDelivery: { score: 1 },
      recursiveQuality: { score: 1 },
    });
  });
});
