import { MissingReviewSubjectsError, computeReviewCoverage, nodeSubjectKey, type ReviewCoverage } from "./coverage.js";
import type {
  Finding,
  NodeEvidence,
  PresentationScoreCeiling,
  ScreenshotEvidenceRef,
  TurnEvidence,
} from "./contracts.js";
import type { LayerRatings, TurnRatings } from "./rubric.js";
import type {
  ActionReviewSubject,
  LayerReviewSubject,
  NodeReviewSubject,
  ReviewSubjectInventory,
} from "./inventory.js";

export const RECURSIVE_PRESENTATION_CONTRACT_VERSION = 2 as const;
export const RECURSIVE_PRESENTATION_CONTRACT_ID = "recursive-presentation-judge-v2" as const;

export type RecursivePresentationRating = 1 | 2 | 3 | 4;
export type AllocationChoice = "expand" | "reference" | "invoke" | "stop";
export type AllocationMargin = "close" | "clearly_better" | "necessary";

export interface RecursiveNodeScore {
  readonly nodeId: string;
  readonly content: RecursivePresentationRating;
  readonly actionAllocation: RecursivePresentationRating;
  readonly actionDelivery: RecursivePresentationRating | null;
  readonly recursiveQuality: RecursivePresentationRating | null;
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
  readonly rank: 1 | 2 | 3 | 4;
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

export interface RecursiveActionReview {
  readonly actionId: string;
  readonly kind: "expand" | "reference" | "invoke";
  readonly allocationStep: number;
  readonly labelAndPlacement: string;
  readonly delivery: string | null;
  readonly recursiveContribution: string | null;
  readonly targetLayerId: string | null;
  readonly reusedLayerId: string | null;
  readonly evidence: readonly ScreenshotEvidenceRef[];
}

export interface RecursiveNodeReview {
  readonly layerId: string;
  readonly nodeId: string;
  readonly evidence: NodeEvidence;
  readonly score: RecursiveNodeScore;
  readonly semantic: RecursiveNodeSemanticSummary;
  readonly allocationSteps: readonly AllocationStepReview[];
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
  readonly layerRatings: LayerRatings;
  readonly layerSummary: string;
  readonly evidence: readonly ScreenshotEvidenceRef[];
}

export interface RecursiveTurnReview {
  readonly turnId: string;
  readonly rootLayerResult: RecursiveLayerResult;
  readonly evidence: TurnEvidence;
  readonly ratings: TurnRatings;
  readonly nullRatingJustifications?: Readonly<Partial<Record<keyof TurnRatings, string>>>;
  readonly summary: string;
  readonly findings: readonly Finding[];
  readonly scoreCeiling: PresentationScoreCeiling;
}

export interface RecursiveReviewRevision<Review> {
  readonly revision: number;
  readonly review: Review;
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
  readonly schemaVersion: 2;
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
    this.#assertMutable();
    const key = nodeSubjectKey(review.layerId, review.nodeId);
    const subject = this.#nodeSubjects.get(key);
    if (subject === undefined) throw new Error(`Unknown node review subject: ${review.layerId}/${review.nodeId}`);
    if (this.#layers.has(review.layerId)) {
      throw new Error(`Layer ${review.layerId} is already finalized; revise its nodes before finalizing the LayerResult`);
    }
    const actionSubjects = this.#actionSubjects.get(key)!;
    validateNodeReview(review, actionSubjects, this.#layers, new Set(this.#layerSubjects.keys()));
    const saved = immutable(review);
    this.#validateEvidence?.({ kind: "node", subject, actionSubjects, review: saved });
    const revision = appendRevision(this.#nodes, key, saved);
    this.#trace.push(immutable({
      sequence: this.#trace.length + 1,
      tool: "reviewNode" as const,
      subjectRevision: revision.revision,
      layerId: review.layerId,
      nodeId: review.nodeId,
    }));
    return revision;
  }

  reviewLayer(review: RecursiveLayerResult): RecursiveReviewRevision<RecursiveLayerResult> {
    this.#assertMutable();
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
    return computeReviewCoverage(this.inventory, {
      reviewedLayerIds: [...this.#layers.keys()],
      reviewedNodes: [...this.#nodes.values()].map(({ current }) => ({
        layerId: current.layerId,
        nodeId: current.nodeId,
        actions: current.actions.map((action) => ({
          actionId: action.actionId,
          kind: action.kind === "invoke" ? "invoke" as const : "navigate" as const,
        })),
      })),
      turnReviewed,
    });
  }

  snapshot(): RecursiveReviewSnapshot {
    return immutable({
      schemaVersion: 2 as const,
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
}

function validateNodeReview(
  review: RecursiveNodeReview,
  subjects: readonly ActionReviewSubject[],
  layers: ReadonlyMap<string, RecursiveReviewHistory<RecursiveLayerResult>>,
  reviewableLayerIds: ReadonlySet<string>,
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
    kind: subject.actionKind === "invoke" ? "invoke" as const : subject.relation!,
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
    if (action.kind === "invoke") {
      if (
        action.delivery !== null || action.recursiveContribution !== null
        || action.targetLayerId !== null || action.reusedLayerId !== null
      ) throw new Error(`Invoke action ${action.actionId} must keep delivery and recursion null`);
    } else {
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
        if (reviewableLayerIds.has(action.targetLayerId!)) {
          if (action.reusedLayerId !== action.targetLayerId) {
            throw new Error(`Reference ${action.actionId} must reuse finalized LayerResult ${action.targetLayerId}`);
          }
          if (reusableResult === undefined) {
            throw new Error(`Reference ${action.actionId} requires existing finalized LayerResult ${action.reusedLayerId}`);
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
  for (const action of review.actions) {
    if (review.allocationSteps[action.allocationStep]?.authoredActionId !== action.actionId) {
      throw new Error(`Action ${action.actionId} allocation step does not identify that action`);
    }
  }

  const hasDelivery = expectedActions.some(({ kind }) => kind === "expand" || kind === "reference");
  const hasExpansion = expectedActions.some(({ kind }) => kind === "expand");
  if ((review.score.actionDelivery === null) === hasDelivery) {
    throw new Error(`Node ${review.nodeId} actionDelivery nullability does not match assessable destinations`);
  }
  if ((review.score.recursiveQuality === null) === hasExpansion) {
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
}

function validateRanking(step: AllocationStepReview, nodeId: string): void {
  const choices = new Set(step.ranking.map(({ choice }) => choice));
  const ranks = new Set(step.ranking.map(({ rank }) => rank));
  if (
    step.ranking.length !== 4 || choices.size !== 4 || ranks.size !== 4
    || !["expand", "reference", "invoke", "stop"].every((choice) => choices.has(choice as AllocationChoice))
    || ![1, 2, 3, 4].every((rank) => ranks.has(rank as 1 | 2 | 3 | 4))
  ) throw new Error(`Node ${nodeId} allocation step ${step.step} must rank each choice exactly once`);
}

function validateScore(score: RecursiveNodeScore): void {
  for (const [key, value] of Object.entries(score)) {
    if (key === "nodeId" || value === null) continue;
    if (![1, 2, 3, 4].includes(value as number)) throw new Error(`Node ${score.nodeId} has invalid ${key} score`);
  }
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
