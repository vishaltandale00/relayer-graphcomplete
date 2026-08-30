import { MissingReviewSubjectsError, computeReviewCoverage, nodeSubjectKey, type ReviewCoverage } from "./coverage.js";
import type {
  Finding,
  NodeEvidence,
  ScreenshotEvidenceRef,
  TurnEvidence,
} from "./contracts.js";
import type { InputActionCriterionKey, LayerCriterionKey, TurnCriterionKey } from "./rubric.js";
import type {
  ActionReviewSubject,
  LayerReviewSubject,
  NodeReviewSubject,
  ReviewSubjectInventory,
} from "./inventory.js";

export const RECURSIVE_PRESENTATION_CONTRACT_VERSION = 6 as const;
export const RECURSIVE_PRESENTATION_CONTRACT_ID = "recursive-presentation-judge-v6" as const;

export type RecursivePresentationRating = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export interface RecursiveCriterionJudgment {
  readonly score: RecursivePresentationRating | null;
  readonly reason: string;
  readonly evidence: readonly ScreenshotEvidenceRef[];
}
export type RecursiveCriterionJudgments<Key extends string> = Readonly<Record<Key, RecursiveCriterionJudgment>>;
export type AllocationChoice = "expand" | "reference" | "invoke" | "input" | "stop";
export type AllocationMargin = "close" | "clearly_better" | "necessary";

export interface RecursiveNodeScore {
  readonly nodeId: string;
  readonly content: RecursiveCriterionJudgment;
  readonly actionAllocation: RecursiveCriterionJudgment;
  readonly actionDelivery: RecursiveCriterionJudgment;
  readonly recursiveQuality: RecursiveCriterionJudgment;
  /** Basic rendered integrity only; never semantic, navigational, or task-quality credit. */
  readonly polish: RecursiveCriterionJudgment;
}

export interface RecursiveNodeSemanticSummary {
  readonly nodeId: string;
  readonly meaning: string;
  readonly delivered: string;
  readonly limitations: string;
  readonly effectOnLayer: string;
  readonly evidence: readonly ScreenshotEvidenceRef[];
}

export interface AllocationRank {
  readonly choice: AllocationChoice;
  readonly rank: 1 | 2 | 3 | 4 | 5;
}

export interface AllocationStepReview {
  readonly step: number;
  readonly ranking: readonly AllocationRank[];
  readonly preferredChoice: AllocationChoice;
  readonly authoredChoice: AllocationChoice;
  readonly authoredActionId: string | null;
  readonly margin: AllocationMargin;
  readonly selectionFinding: string;
  readonly evidence: readonly ScreenshotEvidenceRef[];
}

export interface MissingActionOpportunity {
  readonly allocationStep: number;
  readonly preferredChoice: Exclude<AllocationChoice, "stop">;
  readonly importance: "material" | "critical";
  readonly unansweredQuestion: string;
  readonly expectedContribution: string;
  readonly artifactEvidence: readonly string[];
  readonly evidence: readonly ScreenshotEvidenceRef[];
}

export interface RecursiveActionReview {
  readonly actionId: string;
  readonly kind: "expand" | "reference" | "invoke" | "input";
  readonly allocationStep: number;
  readonly labelAndPlacement: string;
  readonly delivery: string | null;
  readonly recursiveContribution: string | null;
  readonly targetLayerId: string | null;
  readonly reusedLayerId: string | null;
  readonly evidence: readonly ScreenshotEvidenceRef[];
  /** Present and complete only for an immutable, unanswered input action review. */
  readonly inputActionJudgments?: RecursiveCriterionJudgments<InputActionCriterionKey>;
}

export interface RecursiveNodeReview {
  readonly layerId: string;
  readonly nodeId: string;
  readonly evidence: NodeEvidence;
  readonly score: RecursiveNodeScore;
  readonly semantic: RecursiveNodeSemanticSummary;
  readonly allocationSteps: readonly AllocationStepReview[];
  readonly missingActionOpportunities?: readonly MissingActionOpportunity[];
  readonly actions: readonly RecursiveActionReview[];
  readonly findings: readonly Finding[];
}

export type EightSlots<Value> = readonly [
  Value | null,
  Value | null,
  Value | null,
  Value | null,
  Value | null,
  Value | null,
  Value | null,
  Value | null,
];

export interface RecursiveLayerResult {
  readonly layerId: string;
  readonly depth: number;
  readonly nodeScores: EightSlots<RecursiveNodeScore>;
  readonly nodeSemantics: EightSlots<RecursiveNodeSemanticSummary>;
  readonly criterionJudgments: RecursiveCriterionJudgments<LayerCriterionKey>;
  readonly materiallyMisleading: boolean;
  readonly layerSummary: string;
  readonly evidence: readonly ScreenshotEvidenceRef[];
}

export interface RecursiveTurnReview {
  readonly turnId: string;
  readonly rootLayerResult: RecursiveLayerResult;
  readonly evidence: TurnEvidence;
  readonly criterionJudgments: RecursiveCriterionJudgments<TurnCriterionKey>;
  readonly summary: string;
  readonly findings: readonly Finding[];
  readonly scoreCeiling: {
    readonly maximum: RecursivePresentationRating;
    readonly reason: string;
    readonly evidence: readonly ScreenshotEvidenceRef[];
  };
}

export interface RecursiveReviewRevision<Review> {
  readonly revision: number;
  readonly review: Review;
}

export interface PreparedRecursiveNodeReview {
  readonly revision: number;
  commit(): RecursiveReviewRevision<RecursiveNodeReview>;
  cancel(): void;
}

export interface RecursiveReviewHistory<Review> {
  readonly currentRevision: number;
  readonly current: Review;
  readonly revisions: readonly RecursiveReviewRevision<Review>[];
}

export interface RecursiveLayerReviewState {
  readonly subject: LayerReviewSubject;
  readonly history: RecursiveReviewHistory<RecursiveLayerResult>;
}

export interface RecursiveNodeReviewState {
  readonly subject: NodeReviewSubject;
  readonly actionSubjects: readonly ActionReviewSubject[];
  readonly history: RecursiveReviewHistory<RecursiveNodeReview>;
}

export type RecursiveReviewTraceEntry = {
  readonly sequence: number;
  readonly tool: "reviewNode" | "reviewLayer";
  readonly subjectRevision: number;
  readonly layerId: string;
  readonly nodeId?: string;
};

export interface RecursiveReviewSnapshot {
  readonly schemaVersion: 6;
  readonly contractId: typeof RECURSIVE_PRESENTATION_CONTRACT_ID;
  readonly inventory: ReviewSubjectInventory;
  readonly layers: readonly RecursiveLayerReviewState[];
  readonly nodes: readonly RecursiveNodeReviewState[];
  readonly trace: readonly RecursiveReviewTraceEntry[];
  readonly coverage: ReviewCoverage;
}

export interface FinalizedRecursiveReview extends RecursiveReviewSnapshot {
  readonly rootLayerResult: RecursiveLayerResult;
  readonly turn: RecursiveTurnReview;
  readonly finalized: true;
}

export type RecursiveEvidenceValidationRequest =
  | { readonly kind: "layer"; readonly subject: LayerReviewSubject; readonly review: RecursiveLayerResult }
  | {
      readonly kind: "node";
      readonly subject: NodeReviewSubject;
      readonly actionSubjects: readonly ActionReviewSubject[];
      readonly review: RecursiveNodeReview;
    }
  | {
      readonly kind: "turn";
      readonly review: RecursiveTurnReview;
      readonly currentLayerReviews: readonly RecursiveLayerResult[];
      readonly currentNodeReviews: readonly RecursiveNodeReview[];
    };

export interface RecursivePresentationReviewStoreOptions {
  readonly inventory: ReviewSubjectInventory;
  readonly validateEvidence?: (request: RecursiveEvidenceValidationRequest) => void;
}

/**
 * Persists the judge-authored semantic tree while enforcing only structural
 * integrity. Scores, compression, importance, and depth effects remain model
 * judgments; this store never computes or propagates them arithmetically.
 */
export class RecursivePresentationReviewStore {
  readonly inventory: ReviewSubjectInventory;
  readonly #validateEvidence: RecursivePresentationReviewStoreOptions["validateEvidence"];
  readonly #layerSubjects = new Map<string, LayerReviewSubject>();
  readonly #nodeSubjects = new Map<string, NodeReviewSubject>();
  readonly #actionSubjects = new Map<string, readonly ActionReviewSubject[]>();
  readonly #layers = new Map<string, RecursiveReviewHistory<RecursiveLayerResult>>();
  readonly #nodes = new Map<string, RecursiveReviewHistory<RecursiveNodeReview>>();
  readonly #trace: RecursiveReviewTraceEntry[] = [];
  #finalized: FinalizedRecursiveReview | undefined;
  #pendingNodePreparation: symbol | undefined;

  constructor(options: RecursivePresentationReviewStoreOptions) {
    this.inventory = immutable(options.inventory);
    this.#validateEvidence = options.validateEvidence;
    for (const layer of this.inventory.layers) {
      const nodeCount = this.inventory.nodes.filter((node) => node.layerId === layer.layerId).length;
      if (nodeCount > 8) throw new Error(`Layer ${layer.layerId} exceeds the recursive review capacity of eight nodes`);
      this.#layerSubjects.set(layer.layerId, layer);
    }
    for (const node of this.inventory.nodes) {
      const key = nodeSubjectKey(node.layerId, node.nodeId);
      this.#nodeSubjects.set(key, node);
      this.#actionSubjects.set(key, this.inventory.actions.filter(
        (action) => action.layerId === node.layerId && action.nodeId === node.nodeId,
      ));
    }
  }

  reviewNode(review: RecursiveNodeReview): RecursiveReviewRevision<RecursiveNodeReview> {
    return this.prepareNodeReview(review).commit();
  }

  prepareNodeReview(review: RecursiveNodeReview): PreparedRecursiveNodeReview {
    this.#assertMutable();
    this.#assertNoPendingNodePreparation();
    const normalizedReview: RecursiveNodeReview = {
      ...review,
      missingActionOpportunities: review.missingActionOpportunities ?? [],
    };
    const key = nodeSubjectKey(normalizedReview.layerId, normalizedReview.nodeId);
    const subject = this.#nodeSubjects.get(key);
    if (subject === undefined) throw new Error(`Unknown node review subject: ${normalizedReview.layerId}/${normalizedReview.nodeId}`);
    if (this.#layers.has(normalizedReview.layerId)) {
      throw new Error(`Layer ${normalizedReview.layerId} is already finalized; revise its nodes before finalizing the LayerResult`);
    }
    const actionSubjects = this.#actionSubjects.get(key)!;
    validateNodeReview(normalizedReview, actionSubjects, this.#layers, this.#layerSubjects);
    const saved = immutable(normalizedReview);
    this.#validateEvidence?.({ kind: "node", subject, actionSubjects, review: saved });
    const expectedCurrentRevision = this.#nodes.get(key)?.currentRevision ?? 0;
    const proposedRevision = expectedCurrentRevision + 1;
    const reservation = Symbol(key);
    this.#pendingNodePreparation = reservation;
    let committed = false;
    let cancelled = false;
    return Object.freeze({
      revision: proposedRevision,
      commit: () => {
        if (committed) throw new Error(`Node review ${key} preparation was already committed`);
        if (cancelled) throw new Error(`Node review ${key} preparation was cancelled`);
        this.#assertMutable();
        if (this.#pendingNodePreparation !== reservation) {
          throw new Error(`Node review ${key} lost its mutation reservation`);
        }
        if (this.#layers.has(normalizedReview.layerId)) {
          throw new Error(`Layer ${normalizedReview.layerId} is already finalized; revise its nodes before finalizing the LayerResult`);
        }
        if ((this.#nodes.get(key)?.currentRevision ?? 0) !== expectedCurrentRevision) {
          throw new Error(`Node review ${key} changed after preparation`);
        }
        const revision = appendRevision(this.#nodes, key, saved);
        this.#trace.push(immutable({
          sequence: this.#trace.length + 1,
          tool: "reviewNode" as const,
          subjectRevision: revision.revision,
          layerId: normalizedReview.layerId,
          nodeId: normalizedReview.nodeId,
        }));
        this.#pendingNodePreparation = undefined;
        committed = true;
        return revision;
      },
      cancel: () => {
        if (committed || cancelled) return;
        if (this.#pendingNodePreparation === reservation) this.#pendingNodePreparation = undefined;
        cancelled = true;
      },
    });
  }

  reviewLayer(review: RecursiveLayerResult): RecursiveReviewRevision<RecursiveLayerResult> {
    this.#assertMutable();
    this.#assertNoPendingNodePreparation();
    const subject = this.#layerSubjects.get(review.layerId);
    if (subject === undefined) throw new Error(`Unknown layer review subject: ${review.layerId}`);
    if (this.#layers.has(review.layerId) && this.#isLayerConsumed(review.layerId)) {
      throw new Error(`LayerResult ${review.layerId} has already been consumed by a parent node`);
    }
    validateLayerResult(review, subject, this.inventory, this.#nodes);
    const saved = immutable(review);
    this.#validateEvidence?.({ kind: "layer", subject, review: saved });
    const revision = appendRevision(this.#layers, review.layerId, saved);
    this.#trace.push(immutable({
      sequence: this.#trace.length + 1,
      tool: "reviewLayer" as const,
      subjectRevision: revision.revision,
      layerId: review.layerId,
    }));
    return revision;
  }

  coverage(turnReviewed = false): ReviewCoverage {
    const currentNodes = [...this.#nodes.values()].map(({ current }) => current);
    return computeReviewCoverage(this.inventory, {
      reviewedLayerIds: [...this.#layers.keys()],
      reviewedNodes: currentNodes.map((current) => ({
        layerId: current.layerId,
        nodeId: current.nodeId,
        actions: current.actions.map((action) => ({
          actionId: action.actionId,
          kind: action.kind === "invoke"
            ? "invoke" as const
            : action.kind === "input" ? "input" as const : "navigate" as const,
        })),
      })),
      allocationDecisions: {
        reviewed: currentNodes.reduce((total, node) => total + node.allocationSteps.length, 0),
        missingOpportunities: currentNodes.reduce(
          (total, node) => total + (node.missingActionOpportunities?.length ?? 0),
          0,
        ),
        correctStops: currentNodes.filter((node) => {
          const finalStep = node.allocationSteps.at(-1);
          return finalStep?.authoredChoice === "stop" && finalStep.preferredChoice === "stop";
        }).length,
      },
      turnReviewed,
    });
  }

  snapshot(): RecursiveReviewSnapshot {
    return immutable({
      schemaVersion: 6 as const,
      contractId: RECURSIVE_PRESENTATION_CONTRACT_ID,
      inventory: this.inventory,
      layers: this.inventory.layers.flatMap((subject) => {
        const history = this.#layers.get(subject.layerId);
        return history === undefined ? [] : [{ subject, history }];
      }),
      nodes: this.inventory.nodes.flatMap((subject) => {
        const key = nodeSubjectKey(subject.layerId, subject.nodeId);
        const history = this.#nodes.get(key);
        return history === undefined ? [] : [{ subject, actionSubjects: this.#actionSubjects.get(key)!, history }];
      }),
      trace: this.#trace,
      coverage: this.coverage(),
    });
  }

  submitReview(review: RecursiveTurnReview): FinalizedRecursiveReview {
    this.#assertMutable();
    this.#assertNoPendingNodePreparation();
    if (review.turnId !== this.inventory.turn.turnId) {
      throw new Error(`Turn review subject ${review.turnId} does not match ${this.inventory.turn.turnId}`);
    }
    const missing = this.coverage(true).missingSubjects.filter((subject) => subject.kind !== "turn");
    if (missing.length > 0) throw new MissingReviewSubjectsError(missing);
    const rootLayer = this.inventory.layers.find((layer) => layer.depth === 0);
    const currentRoot = rootLayer === undefined ? undefined : this.#layers.get(rootLayer.layerId)?.current;
    if (currentRoot === undefined || !deepEqual(review.rootLayerResult, currentRoot)) {
      throw new Error("Final turn judgment must consume the current root LayerResult");
    }
    const missingOpportunities = [...this.#nodes.values()].flatMap(
      ({ current }) => current.missingActionOpportunities ?? [],
    );
    const criticalOpportunity = missingOpportunities.some(({ importance }) => importance === "critical");
    const materialOpportunityCount = missingOpportunities.filter(({ importance }) => importance === "material").length;
    const materialOpportunity = materialOpportunityCount > 0;
    const repeatedMaterialOpportunity = materialOpportunityCount >= 2;
    const recursiveCeiling = criticalOpportunity || repeatedMaterialOpportunity ? 4 : materialOpportunity ? 6 : 8;
    if (missingOpportunities.length > 0 && (
      review.criterionJudgments.recursive_coherence.score === null || review.criterionJudgments.recursive_coherence.score > recursiveCeiling
    )) {
      const importance = criticalOpportunity ? "critical" : "material";
      throw new Error(`${importance} missing-action opportunity caps recursive_coherence at ${recursiveCeiling}`);
    }
    const experienceCeiling = criticalOpportunity || repeatedMaterialOpportunity ? 4 : materialOpportunity ? 6 : 8;
    if (missingOpportunities.length > 0) {
      for (const criterion of ["navigation_value", "presentation_quality"] as const) {
        const rating = review.criterionJudgments[criterion].score;
        if (rating === null || rating > experienceCeiling) {
          throw new Error(`${missingOpportunities.length} missing-action opportunity(s) cap ${criterion} at ${experienceCeiling}`);
        }
      }
    }
    if (criticalOpportunity && review.scoreCeiling.maximum > 4) {
      throw new Error("Critical missing-action opportunity caps the presentation score at 4");
    }
    validateCriterionJudgments(review.criterionJudgments, "Turn", new Set(["follow_up_progress"]));
    const saved = immutable(review);
    this.#validateEvidence?.({
      kind: "turn",
      review: saved,
      currentLayerReviews: [...this.#layers.values()].map(({ current }) => current),
      currentNodeReviews: [...this.#nodes.values()].map(({ current }) => current),
    });
    this.#finalized = immutable({
      ...this.snapshot(),
      coverage: this.coverage(true),
      rootLayerResult: currentRoot,
      turn: saved,
      finalized: true as const,
    });
    return this.#finalized;
  }

  finalizedResult(): FinalizedRecursiveReview | undefined {
    return this.#finalized;
  }

  #isLayerConsumed(layerId: string): boolean {
    return [...this.#nodes.values()].some(({ current }) => current.actions.some(
      (action) => action.targetLayerId === layerId || action.reusedLayerId === layerId,
    ));
  }

  #assertMutable(): void {
    if (this.#finalized !== undefined) throw new Error("Review is already finalized");
  }

  #assertNoPendingNodePreparation(): void {
    if (this.#pendingNodePreparation !== undefined) {
      throw new Error("Review mutation is blocked by a prepared node review");
    }
  }
}

function validateNodeReview(
  review: RecursiveNodeReview,
  subjects: readonly ActionReviewSubject[],
  layers: ReadonlyMap<string, RecursiveReviewHistory<RecursiveLayerResult>>,
  reviewableLayers: ReadonlyMap<string, LayerReviewSubject>,
): void {
  if (review.score.nodeId !== review.nodeId || review.semantic.nodeId !== review.nodeId) {
    throw new Error(`Node ${review.nodeId} score and semantic IDs must match the reviewed node`);
  }
  validateScore(review.score);
  requireText(review.semantic.meaning, "Node semantic meaning");
  requireText(review.semantic.delivered, "Node semantic delivery");
  requireText(review.semantic.limitations, "Node semantic limitations");
  requireText(review.semantic.effectOnLayer, "Node semantic layer effect");
  requireEvidence(review.semantic.evidence, "Node semantic evidence");

  const expectedActions = subjects.map((subject) => ({
    subject,
    kind: subject.actionKind === "invoke"
      ? "invoke" as const
      : subject.actionKind === "input" ? "input" as const : subject.relation!,
  }));
  const seen = new Set<string>();
  for (const action of review.actions) {
    if (seen.has(action.actionId)) throw new Error(`Duplicate authored action review: ${action.actionId}`);
    seen.add(action.actionId);
    const expected = expectedActions.find(({ subject }) => subject.actionId === action.actionId);
    if (expected === undefined) throw new Error(`Unknown authored action review: ${action.actionId}`);
    if (action.kind !== expected.kind) {
      throw new Error(`Action ${action.actionId} has kind ${action.kind}; expected ${expected.kind}`);
    }
    if (action.allocationStep < 0 || !Number.isInteger(action.allocationStep)) {
      throw new Error(`Action ${action.actionId} requires a non-negative allocation step`);
    }
    requireText(action.labelAndPlacement, `Action ${action.actionId} label and placement`);
    requireEvidence(action.evidence, `Action ${action.actionId} evidence`);
    if (action.kind === "invoke" || action.kind === "input") {
      if (
        action.delivery !== null || action.recursiveContribution !== null
        || action.targetLayerId !== null || action.reusedLayerId !== null
      ) throw new Error(`${action.kind === "input" ? "Input" : "Invoke"} action ${action.actionId} must keep delivery and recursion null`);
      if (action.kind === "input") {
        validateInputActionJudgments(action.inputActionJudgments, action.actionId);
      } else if (action.inputActionJudgments !== undefined) {
        throw new Error(`Invoke action ${action.actionId} cannot carry input-action judgments`);
      }
    } else {
      if (action.inputActionJudgments !== undefined) {
        throw new Error(`Navigate action ${action.actionId} cannot carry input-action judgments`);
      }
      if (action.targetLayerId !== expected.subject.targetLayerId) {
        throw new Error(`Action ${action.actionId} must target layer ${expected.subject.targetLayerId}`);
      }
      requireText(action.delivery, `Action ${action.actionId} delivery`);
      if (action.kind === "expand") {
        const child = layers.get(action.targetLayerId!)?.current;
        if (child === undefined) {
          throw new Error(`Node ${review.nodeId} requires finalized expansion child layer ${action.targetLayerId}`);
        }
        requireText(action.recursiveContribution, `Expansion ${action.actionId} recursive contribution`);
        if (action.reusedLayerId !== null) throw new Error(`Expansion ${action.actionId} cannot reuse a reference result`);
      } else {
        if (action.recursiveContribution !== null) throw new Error(`Reference ${action.actionId} cannot create recursive contribution`);
        const reusableResult = layers.get(action.targetLayerId!)?.current;
        if (reviewableLayers.has(action.targetLayerId!)) {
          const sourceDepth = reviewableLayers.get(review.layerId)!.depth;
          const targetDepth = reviewableLayers.get(action.targetLayerId!)!.depth;
          const backReference = reusableResult === undefined && targetDepth <= sourceDepth;
          if (backReference) {
            if (action.reusedLayerId !== null) {
              throw new Error(`Back-reference ${action.actionId} cannot consume an unfinished ancestor LayerResult`);
            }
          } else {
            if (action.reusedLayerId !== action.targetLayerId) {
              throw new Error(`Reference ${action.actionId} must reuse finalized LayerResult ${action.targetLayerId}`);
            }
            if (reusableResult === undefined) {
              throw new Error(`Reference ${action.actionId} requires existing finalized LayerResult ${action.reusedLayerId}`);
            }
          }
        } else if (action.reusedLayerId !== null) {
          throw new Error(`Reference-only destination ${action.targetLayerId} has no recursive LayerResult to reuse`);
        }
      }
    }
  }
  for (const { subject } of expectedActions) {
    if (!seen.has(subject.actionId)) throw new Error(`Missing authored action review: ${subject.actionId}`);
  }

  if (review.allocationSteps.length !== expectedActions.length + 1) {
    throw new Error(`Node ${review.nodeId} requires one allocation step per authored action plus implicit stop`);
  }
  review.allocationSteps.forEach((step, index) => {
    if (step.step !== index) throw new Error(`Node ${review.nodeId} allocation steps must be contiguous from zero`);
    validateRanking(step, review.nodeId);
    const expected = expectedActions[index];
    const expectedChoice = expected?.kind ?? "stop";
    const expectedActionId = expected?.subject.actionId ?? null;
    if (step.authoredChoice !== expectedChoice || step.authoredActionId !== expectedActionId) {
      throw new Error(`Node ${review.nodeId} allocation step ${index} does not match authored action order`);
    }
    if (step.preferredChoice !== step.ranking.find(({ rank }) => rank === 1)?.choice) {
      throw new Error(`Node ${review.nodeId} allocation step ${index} preferred choice must be ranked first`);
    }
    requireText(step.selectionFinding, `Node ${review.nodeId} allocation selection finding`);
    requireEvidence(step.evidence, `Node ${review.nodeId} allocation evidence`);
  });
  const missingOpportunities = review.missingActionOpportunities ?? [];
  const opportunitySteps = new Set<number>();
  for (const opportunity of missingOpportunities) {
    if (opportunitySteps.has(opportunity.allocationStep)) {
      throw new Error(`Node ${review.nodeId} has duplicate missing-action opportunities for step ${opportunity.allocationStep}`);
    }
    opportunitySteps.add(opportunity.allocationStep);
    const step = review.allocationSteps[opportunity.allocationStep];
    if (
      step === undefined
      || step.authoredChoice !== "stop"
      || step.preferredChoice !== opportunity.preferredChoice
      || step.margin === "close"
    ) {
      throw new Error(`Node ${review.nodeId} missing-action opportunity ${opportunity.allocationStep} does not match a materially preferred absent action`);
    }
    const expectedImportance = step.margin === "necessary" ? "critical" : "material";
    if (opportunity.importance !== expectedImportance) {
      throw new Error(`Node ${review.nodeId} missing-action opportunity ${opportunity.allocationStep} importance must be ${expectedImportance}`);
    }
    requireText(opportunity.unansweredQuestion, `Node ${review.nodeId} missing-action unanswered question`);
    requireText(opportunity.expectedContribution, `Node ${review.nodeId} missing-action expected contribution`);
    requireEvidence(opportunity.artifactEvidence, `Node ${review.nodeId} missing-action artifact evidence`);
    requireEvidence(opportunity.evidence, `Node ${review.nodeId} missing-action screenshot evidence`);
  }
  for (const step of review.allocationSteps) {
    if (
      step.authoredChoice === "stop"
      && step.preferredChoice !== "stop"
      && step.margin !== "close"
      && !missingOpportunities.some((opportunity) => (
        opportunity.allocationStep === step.step
        && opportunity.preferredChoice === step.preferredChoice
      ))
    ) {
      throw new Error(
        `Node ${review.nodeId} materially preferred absent ${step.preferredChoice} action requires a missing-action opportunity`,
      );
    }
  }
  const criticalOpportunity = missingOpportunities.some(({ importance }) => importance === "critical");
  const materialOpportunity = missingOpportunities.some(({ importance }) => importance === "material");
  const allocationCeiling = criticalOpportunity ? 2 : materialOpportunity ? 4 : 8;
  if (review.score.actionAllocation.score === null || review.score.actionAllocation.score > allocationCeiling) {
    const importance = criticalOpportunity ? "critical" : "material";
    throw new Error(`Node ${review.nodeId} ${importance} missing-action opportunity caps actionAllocation at ${allocationCeiling}`);
  }
  for (const action of review.actions) {
    if (review.allocationSteps[action.allocationStep]?.authoredActionId !== action.actionId) {
      throw new Error(`Action ${action.actionId} allocation step does not identify that action`);
    }
  }

  const hasDelivery = expectedActions.some(({ kind }) => kind === "expand" || kind === "reference");
  const hasExpansion = expectedActions.some(({ kind }) => kind === "expand");
  if ((review.score.actionDelivery.score === null) === hasDelivery) {
    throw new Error(`Node ${review.nodeId} actionDelivery nullability does not match assessable destinations`);
  }
  if ((review.score.recursiveQuality.score === null) === hasExpansion) {
    throw new Error(`Node ${review.nodeId} recursiveQuality nullability does not match expansion children`);
  }
}

function validateLayerResult(
  review: RecursiveLayerResult,
  subject: LayerReviewSubject,
  inventory: ReviewSubjectInventory,
  nodes: ReadonlyMap<string, RecursiveReviewHistory<RecursiveNodeReview>>,
): void {
  if (review.depth !== subject.depth) throw new Error(`Layer ${review.layerId} depth must be ${subject.depth}`);
  if (review.nodeScores.length !== 8 || review.nodeSemantics.length !== 8) {
    throw new Error(`Layer ${review.layerId} score and semantic vectors must contain exactly eight slots`);
  }
  const nodeSubjects = inventory.nodes.filter((node) => node.layerId === review.layerId);
  for (let index = 0; index < 8; index += 1) {
    const nodeSubject = nodeSubjects[index];
    const node = nodeSubject === undefined ? undefined : nodes.get(nodeSubjectKey(review.layerId, nodeSubject.nodeId))?.current;
    const score = review.nodeScores[index];
    const semantic = review.nodeSemantics[index];
    if (node === undefined) {
      if (nodeSubject !== undefined) throw new Error(`Layer ${review.layerId} requires node review ${nodeSubject.nodeId}`);
      if (score !== null || semantic !== null) throw new Error(`Layer ${review.layerId} unused slots must be explicit nulls`);
      continue;
    }
    if (score === undefined || semantic === undefined || score === null || semantic === null || score.nodeId !== semantic.nodeId) {
      throw new Error(`Layer ${review.layerId} score and semantic slots must align`);
    }
    if (!deepEqual(score, node.score) || !deepEqual(semantic, node.semantic)) {
      throw new Error(`Layer ${review.layerId} slots must preserve current node score and semantic results`);
    }
  }
  requireText(review.layerSummary, `Layer ${review.layerId} summary`);
  requireEvidence(review.evidence, `Layer ${review.layerId} evidence`);
  validateCriterionJudgments(review.criterionJudgments, `Layer ${review.layerId}`);
}

function validateCriterionJudgments(
  judgments: Readonly<Record<string, RecursiveCriterionJudgment>>,
  label: string,
  nullableCriteria: ReadonlySet<string> = new Set(),
): void {
  for (const [criterion, judgment] of Object.entries(judgments)) {
    if (judgment.score === null && !nullableCriteria.has(criterion)) {
      throw new Error(`${label} ${criterion} must have a score`);
    }
    validateCriterionJudgment(judgment, `${label} ${criterion}`);
  }
}

function validateRanking(step: AllocationStepReview, nodeId: string): void {
  const choices = new Set(step.ranking.map(({ choice }) => choice));
  const ranks = new Set(step.ranking.map(({ rank }) => rank));
  if (
    step.ranking.length !== 5 || choices.size !== 5 || ranks.size !== 5
    || !["expand", "reference", "invoke", "input", "stop"].every((choice) => choices.has(choice as AllocationChoice))
    || ![1, 2, 3, 4, 5].every((rank) => ranks.has(rank as 1 | 2 | 3 | 4 | 5))
  ) throw new Error(`Node ${nodeId} allocation step ${step.step} must rank each choice exactly once`);
}

const inputActionCriterionKeys = [
  "prompt_answerability",
  "option_set_quality",
  "control_fit",
] as const satisfies readonly InputActionCriterionKey[];

function validateInputActionJudgments(
  judgments: RecursiveCriterionJudgments<InputActionCriterionKey> | undefined,
  actionId: string,
): void {
  if (judgments === undefined) throw new Error(`Input action ${actionId} requires input-action judgments`);
  const actual = Object.keys(judgments);
  if (
    actual.length !== inputActionCriterionKeys.length
    || inputActionCriterionKeys.some((key) => !(key in judgments))
    || actual.some((key) => !inputActionCriterionKeys.includes(key as InputActionCriterionKey))
  ) throw new Error(`Input action ${actionId} requires exactly the v11 input-action criteria`);
  validateCriterionJudgments(judgments, `Input action ${actionId}`);
}

function validateScore(score: RecursiveNodeScore): void {
  for (const [key, value] of Object.entries(score)) {
    if (key === "nodeId") continue;
    const judgment = value as RecursiveCriterionJudgment;
    if (judgment.score === null && key !== "actionDelivery" && key !== "recursiveQuality") {
      throw new Error(`Node ${score.nodeId} ${key} must have a score`);
    }
    validateCriterionJudgment(judgment, `Node ${score.nodeId} ${key}`);
  }
}

function validateCriterionJudgment(judgment: RecursiveCriterionJudgment, label: string): void {
  if (judgment.score !== null && ![1, 2, 3, 4, 5, 6, 7, 8].includes(judgment.score)) {
    throw new Error(`${label} has an invalid score`);
  }
  requireText(judgment.reason, `${label} reason`);
  requireEvidence(judgment.evidence, `${label} evidence`);
}

function appendRevision<Review>(
  records: Map<string, RecursiveReviewHistory<Review>>,
  key: string,
  review: Review,
): RecursiveReviewRevision<Review> {
  const previous = records.get(key);
  const revision = immutable({ revision: (previous?.currentRevision ?? 0) + 1, review });
  records.set(key, immutable({
    currentRevision: revision.revision,
    current: review,
    revisions: [...(previous?.revisions ?? []), revision],
  }));
  return revision;
}

function requireText(value: string | null, label: string): void {
  if (value === null || value.trim() === "") throw new Error(`${label} must not be empty`);
}

function requireEvidence(value: readonly string[], label: string): void {
  if (value.length === 0 || value.some((entry) => entry.trim() === "")) throw new Error(`${label} must not be empty`);
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function immutable<Value>(value: Value): Value {
  const clone = structuredClone(value);
  deepFreeze(clone);
  return clone;
}

function deepFreeze(value: unknown): void {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
}
