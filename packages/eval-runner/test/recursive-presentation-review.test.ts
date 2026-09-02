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

function screenshotMetadata(
  screenshotId: string,
  layerId: string,
  selectedNodeId: string | null,
  viaActionId: string | null,
  captureTarget: ScreenshotMetadata["captureTarget"] = { kind: "viewport" },
  mode: ScreenshotMetadata["mode"] = "visible",
): ScreenshotMetadata {
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
    mode,
    viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
    captureTarget,
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
  it("records an input-action review against rendered-control evidence and a navigate review against traversed-destination evidence", () => {
    const inventory = inventoryReviewSubjects({
      turnId: "turn-input",
      rootLayerId: "layer-input",
      layers: [{
        id: "layer-input",
        nodeIds: ["node-input"],
        actions: [{
          id: "63",
          sourceNodeId: "node-input",
          kind: "input",
          control: "text",
          prompt: "What deployment window should we use?",
          options: [],
          occurrence: {
            presentingInteractionNodeId: 41,
            presentingLayerId: 52,
            actionId: 63,
          },
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
          authoredActionId: "63",
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
        actionId: "63",
        kind: "input",
        allocationStep: 0,
        labelAndPlacement: "The question is presented at its decision point.",
        delivery: null,
        recursiveContribution: null,
        targetLayerId: null,
        reusedLayerId: null,
        evidence: ["shot-input"],
        inputActionJudgments: {
          prompt_answerability: judgment(8, ["shot-input-criterion"]),
          option_set_quality: judgment(8, ["shot-input"]),
          control_fit: judgment(8, ["shot-input"]),
        },
      }],
      findings: [],
    };

    const prepared = store.prepareNodeReview(review);
    expect(() => store.reviewNode(review), "a prepared node review blocks node writes").toThrow("blocked by a prepared node review");
    expect(() => store.reviewLayer({} as never), "a prepared node review blocks layer writes").toThrow("blocked by a prepared node review");
    expect(() => store.submitReview({} as never), "a prepared node review blocks submit").toThrow("blocked by a prepared node review");
    expect(store.snapshot().nodes, "a prepared review persists nothing").toEqual([]);
    prepared.cancel();
    store.reviewNode(review);
    expect(store.snapshot(), "the v6 contract records a source-only unanswered input action").toMatchObject({
      schemaVersion: 6,
      contractId: "recursive-presentation-judge-v6",
      nodes: [{ history: { current: { actions: [{ kind: "input" }] } } }],
    });
    const { inputActionJudgments: _omitted, ...withoutJudgments } = review.actions[0]!;
    expect(() => new RecursivePresentationReviewStore({ inventory }).reviewNode({
      ...review,
      actions: [withoutJudgments],
    }), "input-action reviews require the three v11 quality judgments").toThrow("requires input-action judgments");

    const selected = { ...screenshotMetadata("shot-input", "layer-input", "node-input", null), turnId: "turn-input" };
    const capturedControl = {
      ...screenshotMetadata(
        "shot-input",
        "layer-input",
        "node-input",
        null,
        { kind: "element", elementRef: "input-action-41-52-63" },
        "full",
      ),
      turnId: "turn-input",
    };
    const capturedCriterion = { ...capturedControl, screenshotId: "shot-input-criterion" };
    const layerOnly = { ...selected, selectedNodeId: null };
    const subject = inventory.nodes[0]!;
    const actionSubjects = inventory.actions;
    const validator = (shot: ScreenshotMetadata) => createRecursiveScreenshotEvidenceValidator({
      executionId: "execution-1",
      threadId: "thread-1",
      turnId: "turn-input",
      screenshots: new Map([[shot.screenshotId, shot]]),
    });
    expect(() => validator(layerOnly)({ kind: "node", subject, actionSubjects, review }), "a layer-only shot misses the rendered controls").toThrow(
      "rendered controls",
    );
    expect(() => validator(selected)({ kind: "node", subject, actionSubjects, review }), "a selected-node shot misses the rendered controls").toThrow(
      "rendered controls",
    );
    const otherOccurrence = {
      ...capturedControl,
      captureTarget: { kind: "element" as const, elementRef: "input-action-42-52-63" },
    };
    expect(() => validator(otherOccurrence)({ kind: "node", subject, actionSubjects, review }), "a different occurrence identity misses the rendered controls").toThrow(
      "rendered controls",
    );
    const captured = createRecursiveScreenshotEvidenceValidator({
      executionId: "execution-1",
      threadId: "thread-1",
      turnId: "turn-input",
      screenshots: new Map([
        [capturedControl.screenshotId, capturedControl],
        [capturedCriterion.screenshotId, capturedCriterion],
      ]),
    });
    expect(() => captured({ kind: "node", subject, actionSubjects, review }), "the captured rendered control satisfies input-action evidence").not.toThrow();

    const representative = {
      ...turnReview(layerResult("layer-input", 0, review)),
      evidence: { representative: ["shot-input-criterion"] },
      scoreCeiling: { maximum: 8 as const, reason: "No critical omission.", evidence: ["shot-input-criterion"] },
    };
    expect(() => captured({
      kind: "turn",
      review: representative,
      currentLayerReviews: [],
      currentNodeReviews: [review],
    }), "the captured control also satisfies turn representative evidence").not.toThrow();

    const navigateInventory = inventoryReviewSubjects(topology);
    const source = screenshotMetadata("shot-root", "root", "root-node", null);
    const destination = screenshotMetadata("shot-child", "child", null, "expand-a");
    const navigateValidate = createRecursiveScreenshotEvidenceValidator({
      executionId: "execution-1",
      threadId: "thread-1",
      turnId: "turn-1",
      screenshots: new Map([[source.screenshotId, source], [destination.screenshotId, destination]]),
    });
    const navigateSubject = navigateInventory.nodes.find(({ nodeId }) => nodeId === "root-node")!;
    const navigateActionSubjects = navigateInventory.actions.filter(({ nodeId }) => nodeId === "root-node");
    const sourceOnly = {
      ...rootNodeReview(),
      actions: rootNodeReview().actions.map((action) => action.kind === "expand"
        ? { ...action, evidence: ["shot-root"] }
        : action),
    };
    expect(() => navigateValidate({ kind: "node", subject: navigateSubject, actionSubjects: navigateActionSubjects, review: sourceOnly }), "navigate delivery requires both source and traversed destination evidence").toThrow(
      "requires both source and traversed destination evidence",
    );
    expect(() => navigateValidate({ kind: "node", subject: navigateSubject, actionSubjects: navigateActionSubjects, review: rootNodeReview() }), "complete source and destination evidence is accepted").not.toThrow();
  });

  it("walks one bottom-up lifecycle, rejecting every invalid node, layer, and turn review along the way", () => {
    const store = new RecursivePresentationReviewStore({ inventory: inventoryReviewSubjects(topology) });
    expect(
      () => store.reviewNode(rootNodeReview()),
      "a parent node cannot be reviewed before its expansion child layer is finalized",
    ).toThrow("requires finalized expansion child layer child");

    const invalidNode = { ...leafNodeReview(), score: { ...leafNodeReview().score, content: judgment(null) } };
    expect(
      () => store.reviewNode(invalidNode),
      "an occupied node criterion requires a score",
    ).toThrow("Node child-node content must have a score");

    const child = leafNodeReview();
    store.reviewNode(child);

    const childLayer = layerResult("child", 1, child);
    const invalidLayer = {
      ...childLayer,
      criterionJudgments: { ...childLayer.criterionJudgments, cohesion: judgment(null) },
    };
    expect(
      () => store.reviewLayer(invalidLayer),
      "an occupied layer criterion requires a score",
    ).toThrow("Layer child cohesion must have a score");

    const finalizedChild = store.reviewLayer(childLayer);
    expect(finalizedChild.review.nodeScores, "the LayerResult preserves an eight-slot vector").toHaveLength(8);
    expect(finalizedChild.review.nodeScores[0]?.nodeId, "the occupied slot carries the reviewed node").toBe("child-node");
    expect(finalizedChild.review.nodeSemantics[1], "unused slots stay null").toBeNull();

    const missingAction = { ...rootNodeReview(), actions: rootNodeReview().actions.slice(0, 1) };
    expect(
      () => store.reviewNode(missingAction),
      "every authored action requires a review",
    ).toThrow("Missing authored action review: invoke-a");

    const baseInvalidInvoke = rootNodeReview();
    const invalidInvoke = {
      ...baseInvalidInvoke,
      actions: baseInvalidInvoke.actions.map((action, index) => index === 1
        ? { ...action, delivery: "Not actually delivered." }
        : action),
    };
    expect(
      () => store.reviewNode(invalidInvoke),
      "invoke actions keep delivery and recursion null",
    ).toThrow("Invoke action invoke-a must keep delivery and recursion null");

    const baseDuplicateRanks = rootNodeReview();
    const duplicateRanks = {
      ...baseDuplicateRanks,
      allocationSteps: baseDuplicateRanks.allocationSteps.map((step, index) => index === 0
        ? { ...step, ranking: step.ranking.map((entry, rankIndex) => rankIndex === 1 ? { ...entry, rank: 1 as const } : entry) }
        : step),
    };
    expect(
      () => store.reviewNode(duplicateRanks),
      "every allocation step ranks each choice exactly once",
    ).toThrow("must rank each choice exactly once");

    const rootNode = rootNodeReview();
    store.reviewNode(rootNode);

    const baseMisaligned = layerResult("root", 0, rootNode);
    const misaligned = {
      ...baseMisaligned,
      nodeSemantics: [semantic("wrong-node"), ...baseMisaligned.nodeSemantics.slice(1)],
    } as unknown as RecursiveLayerResult;
    expect(() => store.reviewLayer(misaligned), "misaligned score and semantic slots are rejected").toThrow("score and semantic slots must align");

    const root = store.reviewLayer(layerResult("root", 0, rootNode)).review;
    const stale = { ...root, layerSummary: "stale copy" };
    expect(
      () => store.submitReview(turnReview(stale)),
      "the final turn judgment must consume the current root result",
    ).toThrow("must consume the current root LayerResult");

    const baseTurn = turnReview(root);
    const invalidTurn = {
      ...baseTurn,
      criterionJudgments: { ...baseTurn.criterionJudgments, answer_quality: judgment(null) },
    };
    expect(
      () => store.submitReview(invalidTurn),
      "an occupied turn criterion requires a score",
    ).toThrow("Turn answer_quality must have a score");

    const flatStore = new RecursivePresentationReviewStore({ inventory: inventoryReviewSubjects({
      turnId: "flat-turn",
      rootLayerId: "flat-layer",
      layers: [{ id: "flat-layer", nodeIds: ["flat-node"], actions: [] }],
    }) });
    const flatNode = { ...leafNodeReview(), layerId: "flat-layer", nodeId: "flat-node", score: score("flat-node"), semantic: semantic("flat-node", ["shot-flat"]), evidence: { context: ["shot-flat"], detail: ["shot-flat"] }, allocationSteps: [{ ...leafNodeReview().allocationSteps[0]!, evidence: ["shot-flat"] }] };
    flatStore.reviewNode(flatNode);
    const flatResult = layerResult("flat-layer", 0, flatNode);
    const nullable = { ...flatResult, criterionJudgments: { ...ratings, coverage: { score: null, reason: "", evidence: ["shot-flat"] } } } as RecursiveLayerResult;
    expect(
      () => flatStore.reviewLayer(nullable),
      "a null recursive layer judgment is rejected even with an empty reason",
    ).toThrow("coverage must have a score");
    expect(
      () => flatStore.reviewLayer({ ...nullable, criterionJudgments: { ...nullable.criterionJudgments, coverage: judgment(null, ["shot-flat"]) } }),
      "a null recursive layer judgment is rejected even with a fixture reason",
    ).toThrow("coverage must have a score");

    const result = store.submitReview(baseTurn);
    expect(result.rootLayerResult, "the turn result carries the submitted root LayerResult").toEqual(root);
    expect(result.layers.map(({ subject }) => subject.layerId), "every reviewed layer is finalized").toEqual(["root", "child"]);
    expect(
      result.nodes.every(({ history }) => Array.isArray(history.current.missingActionOpportunities)),
      "every node records a missing-action opportunity list",
    ).toBe(true);
    expect(result.coverage.complete, "complete lower-subject coverage completes the turn").toBe(true);
    expect(Object.isFrozen(result), "the finalized result is immutable").toBe(true);
  });

  it("reuses finalized reference destinations without regrading them and tolerates back-references", () => {
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
    expect(referenceInventory.layers.map(({ layerId }) => layerId), "a shared reference destination is inventoried once").toEqual(["root", "shared"]);
    expect(referenceInventory.layers.filter(({ layerId }) => layerId === "shared"), "the shared layer appears exactly once").toHaveLength(1);

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
    expect(
      () => store.reviewNode(root),
      "a reference to an unfinalized shared layer still requires that layer",
    ).toThrow("requires finalized expansion child layer shared");
    store.reviewNode(shared);
    store.reviewLayer(layerResult("shared", 1, shared));
    expect(
      store.reviewNode(root).review.actions[1],
      "a reference reuses the existing finalized LayerResult instead of regrading",
    ).toMatchObject({
      kind: "reference",
      reusedLayerId: "shared",
    });

    const referenceOnlyInventory = inventoryReviewSubjects({
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
    expect(
      referenceOnlyInventory.layers.map(({ layerId }) => layerId),
      "a reference-only destination is never inventoried for recursive grading",
    ).toEqual(["root"]);

    const referenceOnlyStore = new RecursivePresentationReviewStore({ inventory: referenceOnlyInventory });
    const referenceOnlyReview: RecursiveNodeReview = {
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
    expect(
      referenceOnlyStore.reviewNode(referenceOnlyReview).review.actions[0],
      "a reference-only destination is graded without inventing a recursive LayerResult",
    ).toMatchObject({
      kind: "reference",
      targetLayerId: "prior",
      reusedLayerId: null,
    });

    const cycleStore = new RecursivePresentationReviewStore({ inventory: inventoryReviewSubjects({
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
    }) });
    const backReference: RecursiveNodeReview = {
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
    expect(
      cycleStore.reviewNode(backReference).review.actions[0]?.reusedLayerId,
      "a child back-reference does not wait for its unfinished ancestor LayerResult",
    ).toBeNull();
    expect(
      cycleStore.reviewLayer(layerResult("child", 1, backReference)).review.layerId,
      "the child layer finalizes despite the back-reference",
    ).toBe("child");
  });

  it("caps allocation and presentation scores for missing-action opportunities", () => {
    const flatInventory = () => inventoryReviewSubjects({
      turnId: "flat-turn",
      rootLayerId: "flat-layer",
      layers: [{ id: "flat-layer", nodeIds: ["flat-node"], actions: [] }],
    });
    const flatNode = (overrides: {
      preferred: "expand" | "stop";
      margin: "close" | "clearly_better" | "necessary";
      actionAllocation: number;
      effect: string;
      opportunities?: RecursiveNodeReview["missingActionOpportunities"];
    }): RecursiveNodeReview => ({
      layerId: "flat-layer",
      nodeId: "flat-node",
      evidence: { context: ["shot-flat"], detail: ["shot-flat"] },
      score: score("flat-node", { actionAllocation: overrides.actionAllocation }),
      semantic: { ...semantic("flat-node", ["shot-flat"]), effectOnLayer: overrides.effect },
      allocationSteps: [{
        step: 0,
        ranking: ranking(overrides.preferred),
        preferredChoice: overrides.preferred,
        authoredChoice: "stop",
        authoredActionId: null,
        margin: overrides.margin,
        selectionFinding: overrides.effect,
        evidence: ["shot-flat"],
      }],
      ...(overrides.opportunities === undefined ? {} : { missingActionOpportunities: overrides.opportunities }),
      actions: [],
      findings: [],
    });
    const materialOpportunity = (preferred: "expand", margin: "clearly_better" | "necessary") => [{
      allocationStep: 0,
      preferredChoice: preferred,
      importance: margin === "necessary" ? "critical" as const : "material" as const,
      unansweredQuestion: "What mechanism or evidence supports this status claim?",
      expectedContribution: "Explain the distinct causal or evidentiary depth omitted from the root node.",
      artifactEvidence: ["src/example.ts"],
      evidence: ["shot-flat"],
    }];

    const consequences: readonly [label: string, preferred: "expand" | "stop", margin: "close" | "clearly_better" | "necessary", actionAllocation: number, effect: string][] = [
      ["flat stop", "stop", "close", 4, "Atomic answer should stop."],
      ["missed useful expansion", "expand", "clearly_better", 2, "A useful expansion was missed."],
      ["missed required expansion", "expand", "necessary", 1, "A required expansion was missed."],
    ];
    expect(consequences, "every flat allocation consequence is a named row").toHaveLength(3);
    for (const [label, preferred, margin, actionAllocation, effect] of consequences) {
      const store = new RecursivePresentationReviewStore({ inventory: flatInventory() });
      const node = flatNode({
        preferred,
        margin,
        actionAllocation,
        effect,
        opportunities: preferred === "stop" ? [] : materialOpportunity("expand", margin === "necessary" ? "necessary" : "clearly_better"),
      });
      store.reviewNode(node);
      expect.soft(
        store.reviewLayer(layerResult("flat-layer", 0, node)).review.nodeScores[0]?.actionAllocation.score,
        `${label}: allocation score reflects the missed opportunity`,
      ).toBe(actionAllocation);
    }

    const perfectStore = new RecursivePresentationReviewStore({ inventory: flatInventory() });
    const perfectNode = {
      ...flatNode({
        preferred: "expand",
        margin: "clearly_better",
        actionAllocation: 8,
        effect: "The mechanism is missing.",
      }),
      score: score("flat-node", { actionAllocation: 8 }),
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
    } as const satisfies RecursiveNodeReview;
    expect(
      () => perfectStore.reviewNode(perfectNode),
      "a perfect allocation score is rejected while a material opportunity is missing",
    ).toThrow("material missing-action opportunity caps actionAllocation at 4");

    const findingStore = new RecursivePresentationReviewStore({ inventory: flatInventory() });
    expect(
      () => findingStore.reviewNode(flatNode({
        preferred: "expand",
        margin: "clearly_better",
        actionAllocation: 2,
        effect: "The status claim omits the failure mechanism.",
      })),
      "a materially better absent expansion requires a first-class missing-action finding",
    ).toThrow("materially preferred absent expand action requires a missing-action opportunity");

    const coherenceStore = new RecursivePresentationReviewStore({ inventory: flatInventory() });
    const coherenceNode = flatNode({
      preferred: "expand",
      margin: "clearly_better",
      actionAllocation: 2,
      effect: "The mechanism is missing.",
      opportunities: [{
        allocationStep: 0,
        preferredChoice: "expand",
        importance: "material",
        unansweredQuestion: "How does the failure reach the response boundary?",
        expectedContribution: "Trace the causal path from input to failure.",
        artifactEvidence: ["src/utils/sanitize.ts", "src/response.ts"],
        evidence: ["shot-flat"],
      }],
    });
    coherenceStore.reviewNode(coherenceNode);
    const coherenceRoot = coherenceStore.reviewLayer(layerResult("flat-layer", 0, coherenceNode)).review;
    const coherenceTurn: RecursiveTurnReview = {
      turnId: "flat-turn",
      rootLayerResult: coherenceRoot,
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
    expect(
      () => coherenceStore.submitReview(coherenceTurn),
      "a material missing expansion cannot receive perfect recursive coherence",
    ).toThrow("material missing-action opportunity caps recursive_coherence at 6");
    const cappedResult = coherenceStore.submitReview({
      ...coherenceTurn,
      criterionJudgments: {
        ...coherenceTurn.criterionJudgments,
        recursive_coherence: judgment(6, ["shot-flat"]),
        navigation_value: judgment(6, ["shot-flat"]),
        presentation_quality: judgment(6, ["shot-flat"]),
      },
    });
    expect(cappedResult.coverage.allocations, "the capped turn records the missing-opportunity allocation").toEqual({
      required: 1,
      reviewed: 1,
      missing: 0,
      authoredActions: 0,
      missingOpportunities: 1,
      correctStops: 0,
    });

    const criticalStore = new RecursivePresentationReviewStore({ inventory: inventoryReviewSubjects({
      turnId: "critical-turn",
      rootLayerId: "critical-layer",
      layers: [{ id: "critical-layer", nodeIds: ["critical-node"], actions: [] }],
    }) });
    const criticalNode: RecursiveNodeReview = {
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
    criticalStore.reviewNode(criticalNode);
    const criticalRoot = criticalStore.reviewLayer(layerResult("critical-layer", 0, criticalNode)).review;
    const criticalTurn: RecursiveTurnReview = {
      turnId: "critical-turn",
      rootLayerResult: criticalRoot,
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
    expect(
      () => criticalStore.submitReview(criticalTurn),
      "a necessary absent action caps the whole presentation",
    ).toThrow("Critical missing-action opportunity caps the presentation score at 4");
    expect(
      criticalStore.submitReview({
        ...criticalTurn,
        scoreCeiling: { maximum: 4, reason: "The main explanation is absent.", evidence: ["shot-critical"] },
      }).turn.scoreCeiling.maximum,
      "the accepted ceiling records the cap",
    ).toBe(4);
  });

  it("compresses nested delivery quality through expansion boundaries without losing the child signal", () => {
    const compressions: readonly [label: string, rootContent: number, rootEffect: string][] = [
      ["local deep weakness", 4, "The deep weakness remains local after two semantic compression boundaries."],
      ["parent-impacting deep finding", 1, "The deep failure is reinterpreted because it undermines the root promise."],
    ];
    expect(compressions, "each nested compression consequence is a named row").toHaveLength(2);
    for (const [label, rootContent, rootEffect] of compressions) {
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
      const root = expandingNode("nested-root", "root-node", "to-middle", "middle", rootEffect, rootContent as 1 | 4);
      store.reviewNode(root);
      const rootResult = store.reviewLayer(layerResult("nested-root", 0, root)).review;

      expect.soft(rootResult.nodeSemantics[0]?.effectOnLayer, `${label}: the root effect survives compression`).toBe(rootEffect);
      expect.soft(rootResult.nodeScores[0]?.content.score, `${label}: the root content score survives compression`).toBe(rootContent);
      expect.soft(store.snapshot().trace.map(({ layerId }) => layerId), `${label}: the trace is strictly bottom-up`).toEqual([
        "deep", "deep", "middle", "middle", "nested-root", "nested-root",
      ]);
    }

    const repeatedStore = new RecursivePresentationReviewStore({ inventory: inventoryReviewSubjects({
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
    }) });
    const repeatedNode: RecursiveNodeReview = {
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
    repeatedStore.reviewNode(repeatedNode);
    expect(
      repeatedStore.reviewLayer(layerResult("multi-layer", 0, repeatedNode)).review.nodeScores[0]?.actionAllocation.score,
      "repeated action kinds distinguish useful work from unnecessary extras",
    ).toBe(3);

    const failedStore = new RecursivePresentationReviewStore({ inventory: inventoryReviewSubjects(topology) });
    const failedChild = {
      ...leafNodeReview(),
      score: score("child-node", { content: 1 }),
      semantic: { ...semantic("child-node", ["shot-child"]), limitations: "The child does not deliver the promised implementation." },
    };
    failedStore.reviewNode(failedChild);
    failedStore.reviewLayer(layerResult("child", 1, failedChild));
    const failedRoot = {
      ...rootNodeReview(),
      score: score("root-node", { actionDelivery: 1, recursiveQuality: 1 }),
      semantic: { ...semantic("root-node", ["shot-root", "shot-child"]), limitations: "The expansion promise fails." },
    };
    failedStore.reviewNode(failedRoot);
    expect(
      failedStore.reviewLayer(layerResult("root", 0, failedRoot)).review.nodeScores[0],
      "a failed child delivery is represented in the parent while the child keeps its own signal",
    ).toMatchObject({
      actionDelivery: { score: 1 },
      recursiveQuality: { score: 1 },
    });
  });
});
