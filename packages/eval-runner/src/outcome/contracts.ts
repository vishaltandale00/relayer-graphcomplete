export const OUTCOME_GRADING_CONTRACT_VERSION = 1 as const;
export const DEFAULT_PRESENTATION_DEPTH_DECAY = 0.5 as const;

/** A failed status describes the grader, not a candidate that failed a gate. */
export type GradingStatus = "pending" | "running" | "completed" | "partial" | "failed" | "unjudged";
export type PresentationGradingStatus = GradingStatus | "not_applicable";
export type OutcomeRubricRating = 1 | 2 | 3 | 4 | null;
export type PresentationRating = 1 | 2 | 3 | 4 | null;

export interface MandatoryGateReceipt {
  readonly schemaVersion: 1;
  readonly gateId: string;
  readonly name: string;
  readonly mandatory: true;
  /** Failed means the verifier could not complete; a completed gate may pass or fail. */
  readonly status: "completed" | "failed";
  readonly passed: boolean | null;
  readonly detail: string;
  readonly evidenceRefs: readonly string[];
}

export interface OutcomeRubricCriterionGrade {
  readonly criterionId: string;
  readonly rating: OutcomeRubricRating;
  readonly weight: number;
  readonly rationale: string;
  readonly evidenceRefs: readonly string[];
}

export interface TaskOutcomeGrade {
  readonly schemaVersion: 1;
  readonly kind: "task_outcome_grade";
  readonly status: GradingStatus;
  /** Qualification is determined only by mandatory gates, never by rubric score. */
  readonly qualified: boolean | null;
  /** Weighted mean on the rubric's 1-4 scale; null when no criterion is assessable. */
  readonly score: number | null;
  readonly mandatoryGates: readonly MandatoryGateReceipt[];
  readonly criteria: readonly OutcomeRubricCriterionGrade[];
  readonly evidenceRefs?: readonly string[];
  readonly verifierId?: string;
  readonly verifierDigest?: string;
  readonly rubricVersion?: string;
}

export interface PresentationLayerGrade {
  readonly layerId: string;
  readonly depth: number;
  readonly ratings: Readonly<Record<string, PresentationRating>>;
  readonly summary: string;
  readonly materiallyMisleading: boolean;
  readonly evidenceRefs: readonly string[];
  readonly nodes?: readonly PresentationNodeGrade[];
}

export interface PresentationNodeGrade {
  readonly nodeId: string;
  readonly ratings: Readonly<Record<string, PresentationRating>>;
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
}

export interface PresentationLayerAggregation {
  readonly layerId: string;
  readonly depth: number;
  readonly score: number | null;
  /** The depth mass, normalized across present depths, divided among layers at this depth. */
  readonly assignedWeight: number;
  /** Weight used in the aggregate after excluding wholly unassessable layers. */
  readonly aggregateWeight: number;
}

export interface WorstPresentationLayer {
  readonly layerId: string;
  readonly depth: number;
  readonly score: number;
}

export interface GraphPresentationGrade {
  readonly schemaVersion: 1;
  readonly kind: "graph_presentation_grade";
  readonly status: PresentationGradingStatus;
  /** Weighted mean on the 1-4 scale; never combined with task-outcome score. */
  readonly score: number | null;
  /** Whole-turn task-grounded handoff comprehension before visual aggregation. */
  readonly comprehensionScore?: number | null;
  /** Depth-decayed layer/node rendered experience. */
  readonly renderedScore?: number | null;
  readonly rawScore?: number | null;
  readonly scoreCeiling?: 1 | 2 | 3 | 4 | null;
  readonly depthDecay: number;
  readonly layers: readonly PresentationLayerGrade[];
  readonly aggregation: readonly PresentationLayerAggregation[];
  readonly worstLayer: WorstPresentationLayer | null;
  readonly hasMateriallyMisleadingLayer: boolean;
  readonly aggregationMethod?: "legacy_depth_weighted" | "recursive_semantic_root";
  readonly rootLayerResultIds?: readonly string[];
}
