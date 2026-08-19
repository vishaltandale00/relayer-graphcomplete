import {
  MissingReviewSubjectsError,
  computeReviewCoverage,
  nodeSubjectKey,
  type ReviewActionReference,
  type ReviewCoverage,
  type ReviewCoverageState,
} from "./coverage.js";
import type {
  ActionReviewSubject,
  LayerReviewSubject,
  NodeReviewSubject,
  ReviewSubjectId,
  ReviewSubjectInventory,
  TurnReviewSubject,
} from "./inventory.js";
import type {
  LayerReview as ContractLayerReview,
  NodeReview as ContractNodeReview,
  TurnReview as ContractTurnReview,
} from "./contracts.js";

export interface LayerReviewRecord {
  readonly layerId: ReviewSubjectId;
}

export interface NodeActionReviewRecord extends ReviewActionReference {}

export interface NodeReviewRecord {
  readonly layerId: ReviewSubjectId;
  readonly nodeId: ReviewSubjectId;
  readonly actions: readonly NodeActionReviewRecord[];
}

export interface TurnReviewRecord {
  readonly turnId: ReviewSubjectId;
}

export interface ReviewRevision<Review> {
  readonly revision: number;
  readonly review: Review;
}

export interface ReviewSubjectHistory<Review> {
  readonly currentRevision: number;
  readonly current: Review;
  readonly revisions: readonly ReviewRevision<Review>[];
}

export interface LayerReviewState<Review extends LayerReviewRecord> {
  readonly subject: LayerReviewSubject;
  readonly history: ReviewSubjectHistory<Review>;
}

export interface NodeReviewState<Review extends NodeReviewRecord> {
  readonly subject: NodeReviewSubject;
  readonly actionSubjects: readonly ActionReviewSubject[];
  readonly history: ReviewSubjectHistory<Review>;
}

export type ReviewWriteTraceEntry<LayerReview, NodeReview> =
  | {
      readonly sequence: number;
      readonly tool: "reviewLayer";
      readonly subjectRevision: number;
      readonly review: LayerReview;
    }
  | {
      readonly sequence: number;
      readonly tool: "reviewNode";
      readonly subjectRevision: number;
      readonly review: NodeReview;
    };

export interface IncrementalReviewSnapshot<
  LayerReview extends LayerReviewRecord,
  NodeReview extends NodeReviewRecord,
> {
  readonly inventory: ReviewSubjectInventory;
  readonly layers: readonly LayerReviewState<LayerReview>[];
  readonly nodes: readonly NodeReviewState<NodeReview>[];
  readonly trace: readonly ReviewWriteTraceEntry<LayerReview, NodeReview>[];
  readonly coverage: ReviewCoverage;
}

export interface FinalizedReviewResult<
  LayerReview extends LayerReviewRecord,
  NodeReview extends NodeReviewRecord,
  TurnReview extends TurnReviewRecord,
> extends IncrementalReviewSnapshot<LayerReview, NodeReview> {
  readonly turn: TurnReview;
  readonly finalized: true;
}

export type ReviewEvidenceValidationRequest<LayerReview, NodeReview, TurnReview> =
  | {
      readonly kind: "layer";
      readonly subject: LayerReviewSubject;
      readonly review: LayerReview;
    }
  | {
      readonly kind: "node";
      readonly subject: NodeReviewSubject;
      readonly actionSubjects: readonly ActionReviewSubject[];
      readonly review: NodeReview;
    }
  | {
      readonly kind: "turn";
      readonly subject: TurnReviewSubject;
      readonly review: TurnReview;
      readonly currentLayerReviews: readonly LayerReview[];
      readonly currentNodeReviews: readonly NodeReview[];
    };

export type ReviewEvidenceValidator<LayerReview, NodeReview, TurnReview> = (
  request: ReviewEvidenceValidationRequest<LayerReview, NodeReview, TurnReview>,
) => void;

export interface IncrementalReviewStoreOptions<LayerReview, NodeReview, TurnReview> {
  readonly inventory: ReviewSubjectInventory;
  readonly validateEvidence?: ReviewEvidenceValidator<LayerReview, NodeReview, TurnReview>;
}

/**
 * Owns the incremental review records for one turn. The runner remains
 * responsible for screenshot storage; a validator hook binds each write to
 * runner-authored screenshot metadata before this store changes state.
 */
export class IncrementalReviewStore<
  LayerReview extends LayerReviewRecord = ContractLayerReview,
  NodeReview extends NodeReviewRecord = ContractNodeReview,
  TurnReview extends TurnReviewRecord = ContractTurnReview,
> {
  readonly inventory: ReviewSubjectInventory;
  readonly #validateEvidence: ReviewEvidenceValidator<LayerReview, NodeReview, TurnReview> | undefined;
  readonly #layerSubjects = new Map<string, LayerReviewSubject>();
  readonly #nodeSubjects = new Map<string, NodeReviewSubject>();
  readonly #actionSubjects = new Map<string, readonly ActionReviewSubject[]>();
  readonly #layers = new Map<string, ReviewSubjectHistory<LayerReview>>();
  readonly #nodes = new Map<string, ReviewSubjectHistory<NodeReview>>();
  readonly #trace: ReviewWriteTraceEntry<LayerReview, NodeReview>[] = [];
  #finalized: FinalizedReviewResult<LayerReview, NodeReview, TurnReview> | undefined;

  constructor(options: IncrementalReviewStoreOptions<LayerReview, NodeReview, TurnReview>) {
    this.inventory = immutableClone(options.inventory);
    this.#validateEvidence = options.validateEvidence;
    for (const subject of this.inventory.layers) this.#layerSubjects.set(idKey(subject.layerId), subject);
    for (const subject of this.inventory.nodes) {
      const key = nodeSubjectKey(subject.layerId, subject.nodeId);
      this.#nodeSubjects.set(key, subject);
      this.#actionSubjects.set(
        key,
        this.inventory.actions.filter(
          (action) => action.layerId === subject.layerId && action.nodeId === subject.nodeId,
        ),
      );
    }
  }

  reviewLayer(review: LayerReview): ReviewRevision<LayerReview> {
    this.#assertMutable();
    const subject = this.#layerSubjects.get(idKey(review.layerId));
    if (subject === undefined) throw new Error(`Unknown layer review subject: ${formatId(review.layerId)}`);
    const savedReview = immutableClone(review);
    this.#validateEvidence?.({ kind: "layer", subject, review: savedReview });
    const revision = appendRevision(this.#layers, idKey(review.layerId), savedReview);
    this.#trace.push(immutableClone({
      sequence: this.#trace.length + 1,
      tool: "reviewLayer" as const,
      subjectRevision: revision.revision,
      review: savedReview,
    }));
    return revision;
  }

  reviewNode(review: NodeReview): ReviewRevision<NodeReview> {
    this.#assertMutable();
    const key = nodeSubjectKey(review.layerId, review.nodeId);
    const subject = this.#nodeSubjects.get(key);
    if (subject === undefined) {
      throw new Error(`Unknown node review subject: ${formatId(review.layerId)}/${formatId(review.nodeId)}`);
    }
    const actionSubjects = this.#actionSubjects.get(key)!;
    validateNestedActionReviews(review.actions, actionSubjects);
    const savedReview = immutableClone(review);
    this.#validateEvidence?.({ kind: "node", subject, actionSubjects, review: savedReview });
    const revision = appendRevision(this.#nodes, key, savedReview);
    this.#trace.push(immutableClone({
      sequence: this.#trace.length + 1,
      tool: "reviewNode" as const,
      subjectRevision: revision.revision,
      review: savedReview,
    }));
    return revision;
  }

  coverage(): ReviewCoverage {
    return computeReviewCoverage(this.inventory, this.#coverageState(false));
  }

  snapshot(): IncrementalReviewSnapshot<LayerReview, NodeReview> {
    return immutableClone({
      inventory: this.inventory,
      layers: this.inventory.layers.flatMap((subject) => {
        const history = this.#layers.get(idKey(subject.layerId));
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

  submitReview(review: TurnReview): FinalizedReviewResult<LayerReview, NodeReview, TurnReview> {
    this.#assertMutable();
    if (review.turnId !== this.inventory.turn.turnId) {
      throw new Error(
        `Turn review subject ${formatId(review.turnId)} does not match ${formatId(this.inventory.turn.turnId)}`,
      );
    }

    const missing = computeReviewCoverage(this.inventory, this.#coverageState(true)).missingSubjects;
    if (missing.length > 0) throw new MissingReviewSubjectsError(missing);

    const savedReview = immutableClone(review);
    this.#validateEvidence?.({
      kind: "turn",
      subject: this.inventory.turn,
      review: savedReview,
      currentLayerReviews: [...this.#layers.values()].map((history) => history.current),
      currentNodeReviews: [...this.#nodes.values()].map((history) => history.current),
    });
    const snapshot = this.snapshot();
    const coverage = computeReviewCoverage(this.inventory, this.#coverageState(true));
    this.#finalized = immutableClone({
      ...snapshot,
      coverage,
      turn: savedReview,
      finalized: true as const,
    });
    return this.#finalized;
  }

  finalizedResult(): FinalizedReviewResult<LayerReview, NodeReview, TurnReview> | undefined {
    return this.#finalized;
  }

  #coverageState(turnReviewed: boolean): ReviewCoverageState {
    return {
      reviewedLayerIds: [...this.#layers.values()].map((history) => history.current.layerId),
      reviewedNodes: [...this.#nodes.values()].map((history) => history.current),
      turnReviewed,
    };
  }

  #assertMutable(): void {
    if (this.#finalized !== undefined) throw new Error("Review is already finalized");
  }
}

function validateNestedActionReviews(
  reviews: readonly NodeActionReviewRecord[],
  subjects: readonly ActionReviewSubject[],
): void {
  const seen = new Set<string>();
  for (const review of reviews) {
    const key = idKey(review.actionId);
    if (seen.has(key)) throw new Error(`Duplicate action review: ${formatId(review.actionId)}`);
    seen.add(key);
    const subject = subjects.find((candidate) => candidate.actionId === review.actionId);
    if (subject === undefined) throw new Error(`Unknown action review subject: ${formatId(review.actionId)}`);
    if (subject.actionKind !== review.kind) {
      throw new Error(
        `Action review ${formatId(review.actionId)} has kind ${review.kind}; expected ${subject.actionKind}`,
      );
    }
  }
}

function appendRevision<Review>(
  records: Map<string, ReviewSubjectHistory<Review>>,
  key: string,
  review: Review,
): ReviewRevision<Review> {
  const previous = records.get(key);
  const revision = immutableClone({ revision: (previous?.currentRevision ?? 0) + 1, review });
  records.set(key, immutableClone({
    currentRevision: revision.revision,
    current: review,
    revisions: [...(previous?.revisions ?? []), revision],
  }));
  return revision;
}

function immutableClone<Value>(value: Value): Value {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function idKey(id: ReviewSubjectId): string {
  return JSON.stringify([typeof id, id]);
}

function formatId(id: ReviewSubjectId): string {
  return JSON.stringify(id);
}
