import {
  DEFAULT_PRESENTATION_DEPTH_DECAY,
  type GraphPresentationGrade,
  type GradingStatus,
  type MandatoryGateReceipt,
  type OutcomeRubricCriterionGrade,
  type PresentationGradingStatus,
  type PresentationLayerAggregation,
  type PresentationLayerGrade,
  type PresentationRating,
  type TaskOutcomeGrade,
  type WorstPresentationLayer,
} from "./contracts.js";

export interface DeterministicCheckLike {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface BuildTaskOutcomeGradeOptions {
  readonly status: GradingStatus;
  readonly mandatoryGates?: readonly MandatoryGateReceipt[];
  readonly criteria?: readonly OutcomeRubricCriterionGrade[];
}

export function buildTaskOutcomeGrade(options: BuildTaskOutcomeGradeOptions): TaskOutcomeGrade {
  const mandatoryGates = [...(options.mandatoryGates ?? [])];
  const criteria = [...(options.criteria ?? [])];
  validateUniqueIds(mandatoryGates.map((gate) => gate.gateId), "mandatory gate");
  validateUniqueIds(criteria.map((criterion) => criterion.criterionId), "outcome criterion");
  for (const gate of mandatoryGates) validateGate(gate);
  for (const criterion of criteria) validateCriterion(criterion);

  const qualified = ["completed", "partial"].includes(options.status) && mandatoryGates.length > 0
    ? mandatoryGates.every((gate) => gate.status === "completed" && gate.passed === true)
    : null;

  return immutable({
    schemaVersion: 1,
    kind: "task_outcome_grade",
    status: options.status,
    qualified,
    score: options.status === "completed" ? weightedCriterionMean(criteria) : null,
    mandatoryGates,
    criteria,
  });
}

/** Projects today's deterministic checks into mandatory gate receipts without inventing a rubric score. */
export function projectDeterministicChecksToOutcome(
  checks: readonly DeterministicCheckLike[],
): TaskOutcomeGrade {
  if (checks.length === 0) return buildTaskOutcomeGrade({ status: "unjudged" });
  return buildTaskOutcomeGrade({
    status: "completed",
    mandatoryGates: checks.map((check, index) => ({
      schemaVersion: 1,
      gateId: stableGateId(check.name, index),
      name: check.name,
      mandatory: true,
      status: "completed",
      passed: check.passed,
      detail: check.detail,
      evidenceRefs: [],
    })),
  });
}

export interface BuildGraphPresentationGradeOptions {
  readonly status: PresentationGradingStatus;
  readonly layers?: readonly PresentationLayerGrade[];
  readonly depthDecay?: number;
  readonly comprehensionRatings?: readonly PresentationRating[];
  readonly scoreCeilings?: readonly (1 | 2 | 3 | 4)[];
}

export function buildGraphPresentationGrade(
  options: BuildGraphPresentationGradeOptions,
): GraphPresentationGrade {
  const depthDecay = options.depthDecay ?? DEFAULT_PRESENTATION_DEPTH_DECAY;
  validateDepthDecay(depthDecay);
  const layers = [...(options.layers ?? [])];
  validatePresentationLayers(layers);
  if (options.status === "not_applicable" && layers.length > 0) {
    throw new Error("A not-applicable graph presentation grade cannot contain layers");
  }

  const aggregation = aggregatePresentationLayers(layers, depthDecay);
  const scorable = aggregation.filter(
    (layer): layer is PresentationLayerAggregation & { readonly score: number } => layer.score !== null,
  );
  const renderedScore = options.status === "completed" && scorable.length > 0
    ? rounded(scorable.reduce((sum, layer) => sum + layer.score * layer.aggregateWeight, 0))
    : null;
  const comprehensionScore = options.status === "completed"
    ? meanRatings(options.comprehensionRatings ?? [])
    : null;
  const rawScore = comprehensionScore === null
    ? renderedScore
    : renderedScore === null
      ? comprehensionScore
      : rounded(comprehensionScore * 0.65 + renderedScore * 0.35);
  const declaredCeiling: 1 | 2 | 3 | 4 | null = options.scoreCeilings?.length
    ? Math.min(...options.scoreCeilings) as 1 | 2 | 3 | 4
    : null;
  const scoreCeiling: 1 | 2 | 3 | 4 | null = declaredCeiling;
  const score = rawScore === null
    ? null
    : rounded(scoreCeiling === null ? rawScore : Math.min(rawScore, scoreCeiling));
  const worstLayer = options.status === "completed" ? selectWorstLayer(scorable) : null;

  return immutable({
    schemaVersion: 1,
    kind: "graph_presentation_grade",
    status: options.status,
    score,
    comprehensionScore,
    renderedScore,
    rawScore,
    scoreCeiling,
    depthDecay,
    layers,
    aggregation,
    worstLayer,
    hasMateriallyMisleadingLayer: layers.some((layer) => layer.materiallyMisleading),
    aggregationMethod: "legacy_depth_weighted" as const,
  });
}

export interface BuildRecursiveGraphPresentationGradeOptions {
  readonly status: PresentationGradingStatus;
  readonly layers?: readonly PresentationLayerGrade[];
  readonly presentationRatings?: readonly PresentationRating[];
  readonly comprehensionRatings?: readonly PresentationRating[];
  readonly scoreCeilings?: readonly (1 | 2 | 3 | 4)[];
  readonly rootLayerResultIds?: readonly string[];
}

/**
 * Projects finalized recursive turn judgments without recomputing their
 * semantic compression. Descendant vectors remain inspectable evidence; the
 * final model-authored presentation rating is the score source.
 */
export function buildRecursiveGraphPresentationGrade(
  options: BuildRecursiveGraphPresentationGradeOptions,
): GraphPresentationGrade {
  const layers = [...(options.layers ?? [])];
  validatePresentationLayers(layers);
  const presentation = options.status === "completed" ? meanRatings(options.presentationRatings ?? []) : null;
  const comprehension = options.status === "completed" ? meanRatings(options.comprehensionRatings ?? []) : null;
  const ceiling = options.scoreCeilings?.length
    ? Math.min(...options.scoreCeilings) as 1 | 2 | 3 | 4
    : null;
  const score = presentation === null ? null : rounded(ceiling === null ? presentation : Math.min(presentation, ceiling));
  const rootLayerResultIds = [...(options.rootLayerResultIds ?? [])];
  validateUniqueIds(rootLayerResultIds, "root LayerResult");
  return immutable({
    schemaVersion: 1,
    kind: "graph_presentation_grade",
    status: options.status,
    score,
    comprehensionScore: comprehension,
    renderedScore: null,
    rawScore: presentation,
    scoreCeiling: ceiling,
    depthDecay: 1,
    layers,
    aggregation: [],
    worstLayer: null,
    hasMateriallyMisleadingLayer: layers.some((layer) => layer.materiallyMisleading),
    aggregationMethod: "recursive_semantic_root" as const,
    rootLayerResultIds,
  });
}

export function aggregatePresentationLayers(
  layers: readonly PresentationLayerGrade[],
  depthDecay: number = DEFAULT_PRESENTATION_DEPTH_DECAY,
): readonly PresentationLayerAggregation[] {
  validateDepthDecay(depthDecay);
  validatePresentationLayers(layers);
  if (layers.length === 0) return immutable([]);

  const countsByDepth = new Map<number, number>();
  for (const layer of layers) countsByDepth.set(layer.depth, (countsByDepth.get(layer.depth) ?? 0) + 1);
  const depths = [...countsByDepth.keys()].sort((left, right) => left - right);
  const rawDepthMass = new Map(depths.map((depth) => [depth, depthDecay ** depth]));
  const totalDepthMass = [...rawDepthMass.values()].reduce((sum, mass) => sum + mass, 0);

  const provisional = layers.map((layer) => {
    const layerScore = meanRatings(Object.values(layer.ratings));
    const nodeScore = meanRatings((layer.nodes ?? []).flatMap((node) => Object.values(node.ratings)));
    const score = layerScore === null
      ? nodeScore
      : nodeScore === null ? layerScore : rounded(layerScore * 0.7 + nodeScore * 0.3);
    const assignedWeight = rawDepthMass.get(layer.depth)! / totalDepthMass / countsByDepth.get(layer.depth)!;
    return { layerId: layer.layerId, depth: layer.depth, score, assignedWeight };
  });
  const assessableWeight = provisional.reduce(
    (sum, layer) => sum + (layer.score === null ? 0 : layer.assignedWeight),
    0,
  );

  return immutable(provisional.map((layer) => ({
    ...layer,
    assignedWeight: rounded(layer.assignedWeight),
    aggregateWeight: layer.score === null || assessableWeight === 0
      ? 0
      : rounded(layer.assignedWeight / assessableWeight),
  })));
}

function meanRatings(ratings: readonly PresentationRating[]): number | null {
  const rated = ratings.filter((rating): rating is 1 | 2 | 3 | 4 => rating !== null);
  return rated.length === 0
    ? null
    : rounded(rated.reduce((sum, rating) => sum + rating, 0) / rated.length);
}

function weightedCriterionMean(criteria: readonly OutcomeRubricCriterionGrade[]): number | null {
  const rated = criteria.filter(
    (criterion): criterion is OutcomeRubricCriterionGrade & { readonly rating: 1 | 2 | 3 | 4 } => (
      criterion.rating !== null
    ),
  );
  const totalWeight = rated.reduce((sum, criterion) => sum + criterion.weight, 0);
  if (totalWeight === 0) return null;
  return rounded(rated.reduce((sum, criterion) => sum + criterion.rating * criterion.weight, 0) / totalWeight);
}

function selectWorstLayer(
  layers: readonly (PresentationLayerAggregation & { readonly score: number })[],
): WorstPresentationLayer | null {
  const worst = [...layers].sort((left, right) => (
    left.score - right.score || left.depth - right.depth || left.layerId.localeCompare(right.layerId)
  ))[0];
  return worst === undefined ? null : { layerId: worst.layerId, depth: worst.depth, score: worst.score };
}

function validateGate(gate: MandatoryGateReceipt): void {
  requireIdentifier(gate.gateId, "mandatory gate ID");
  requireText(gate.name, "mandatory gate name");
  requireText(gate.detail, "mandatory gate detail");
  if (gate.status === "completed" && typeof gate.passed !== "boolean") {
    throw new Error(`Completed mandatory gate ${gate.gateId} requires a boolean result`);
  }
  if (gate.status === "failed" && gate.passed !== null) {
    throw new Error(`Failed mandatory gate ${gate.gateId} must use a null result`);
  }
}

function validateCriterion(criterion: OutcomeRubricCriterionGrade): void {
  requireIdentifier(criterion.criterionId, "outcome criterion ID");
  if (!Number.isFinite(criterion.weight) || criterion.weight <= 0) {
    throw new Error(`Outcome criterion ${criterion.criterionId} requires a positive finite weight`);
  }
  requireText(criterion.rationale, "outcome criterion rationale");
  if (criterion.rating !== null && ![1, 2, 3, 4].includes(criterion.rating)) {
    throw new Error(`Outcome criterion ${criterion.criterionId} has an invalid rating`);
  }
}

function validatePresentationLayers(layers: readonly PresentationLayerGrade[]): void {
  validateUniqueIds(layers.map((layer) => layer.layerId), "presentation layer");
  for (const layer of layers) {
    requireIdentifier(layer.layerId, "presentation layer ID");
    if (!Number.isInteger(layer.depth) || layer.depth < 0) {
      throw new Error(`Presentation layer ${layer.layerId} requires a non-negative integer depth`);
    }
    requireText(layer.summary, "presentation layer summary");
    for (const [criterionId, rating] of Object.entries(layer.ratings)) {
      requireIdentifier(criterionId, "presentation criterion ID");
      if (rating !== null && ![1, 2, 3, 4].includes(rating)) {
        throw new Error(`Presentation criterion ${criterionId} on ${layer.layerId} has an invalid rating`);
      }
    }
    validateUniqueIds((layer.nodes ?? []).map((node) => node.nodeId), `presentation node in ${layer.layerId}`);
    for (const node of layer.nodes ?? []) {
      requireIdentifier(node.nodeId, "presentation node ID");
      requireText(node.summary, "presentation node summary");
      for (const [criterionId, rating] of Object.entries(node.ratings)) {
        requireIdentifier(criterionId, "presentation node criterion ID");
        if (rating !== null && ![1, 2, 3, 4].includes(rating)) {
          throw new Error(`Presentation node criterion ${criterionId} on ${node.nodeId} has an invalid rating`);
        }
      }
    }
  }
}

function validateDepthDecay(decay: number): void {
  if (!Number.isFinite(decay) || decay <= 0 || decay > 1) {
    throw new Error("Presentation depth decay must be greater than zero and at most one");
  }
}

function validateUniqueIds(ids: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`Duplicate ${label} ID: ${id}`);
    seen.add(id);
  }
}

function stableGateId(name: string, index: number): string {
  const normalized = name.trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-").replace(/^-|-$/g, "");
  return normalized || `gate-${index + 1}`;
}

function requireIdentifier(value: string, label: string): void {
  if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(value)) throw new Error(`Invalid ${label}: ${value}`);
}

function requireText(value: string, label: string): void {
  if (value.trim() === "") throw new Error(`${label} must not be empty`);
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function immutable<Value>(value: Value): Value {
  const cloned = structuredClone(value);
  deepFreeze(cloned);
  return cloned;
}

function deepFreeze(value: unknown): void {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
}
