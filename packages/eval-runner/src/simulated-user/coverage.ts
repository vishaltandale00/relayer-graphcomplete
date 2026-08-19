import type {
  ActionReviewSubject,
  LayerReviewSubject,
  NodeReviewSubject,
  ReviewSubjectId,
  ReviewSubjectInventory,
  TurnReviewSubject,
} from "./inventory.js";
import type { MissingReviewSubject } from "./contracts.js";

export interface ReviewActionReference {
  readonly actionId: ReviewSubjectId;
  readonly kind: "navigate" | "invoke";
}

export interface ReviewNodeReference {
  readonly layerId: ReviewSubjectId;
  readonly nodeId: ReviewSubjectId;
  readonly actions: readonly ReviewActionReference[];
}

export interface ReviewCoverageState {
  readonly reviewedLayerIds: readonly ReviewSubjectId[];
  readonly reviewedNodes: readonly ReviewNodeReference[];
  readonly turnReviewed: boolean;
}

export type MissingCoverageSubject = MissingReviewSubject;

export interface ReviewCoverageCounts {
  readonly required: number;
  readonly reviewed: number;
  readonly missing: number;
}

export interface ReviewCoverage {
  readonly complete: boolean;
  readonly layers: ReviewCoverageCounts;
  readonly nodes: ReviewCoverageCounts;
  readonly actions: ReviewCoverageCounts;
  readonly turn: ReviewCoverageCounts;
  readonly missingSubjects: readonly MissingCoverageSubject[];
}

export function computeReviewCoverage(
  inventory: ReviewSubjectInventory,
  state: ReviewCoverageState,
): ReviewCoverage {
  const reviewedLayers = new Set(state.reviewedLayerIds.map(subjectIdKey));
  const reviewedNodes = new Map(
    state.reviewedNodes.map((node) => [nodeSubjectKey(node.layerId, node.nodeId), node] as const),
  );

  const missingLayerSubjects = inventory.layers.filter((subject) => !reviewedLayers.has(subjectIdKey(subject.layerId)));
  const missingNodeSubjects = inventory.nodes.filter(
    (subject) => !reviewedNodes.has(nodeSubjectKey(subject.layerId, subject.nodeId)),
  );
  const missingActionSubjects = inventory.actions.filter((subject) => {
    const review = reviewedNodes.get(nodeSubjectKey(subject.layerId, subject.nodeId));
    return review === undefined || !review.actions.some(
      (action) => action.actionId === subject.actionId && action.kind === subject.actionKind,
    );
  });
  const missingLayers: MissingCoverageSubject[] = missingLayerSubjects.map((subject) => ({
    kind: "layer",
    subjectId: subject.layerId,
    layerId: subject.layerId,
  }));
  const missingNodes: MissingCoverageSubject[] = missingNodeSubjects.map((subject) => ({
    kind: "node",
    subjectId: subject.nodeId,
    layerId: subject.layerId,
    nodeId: subject.nodeId,
  }));
  const missingActions: MissingCoverageSubject[] = missingActionSubjects.map((subject) => ({
    kind: subject.actionKind === "navigate" ? "navigate_action" : "invoke_action",
    subjectId: subject.actionId,
    layerId: subject.layerId,
    nodeId: subject.nodeId,
  }));
  const missingTurn: MissingCoverageSubject[] = state.turnReviewed ? [] : [{
    kind: "turn",
    subjectId: inventory.turn.turnId,
  }];
  const missingSubjects: MissingCoverageSubject[] = [
    ...missingLayers,
    ...missingNodes,
    ...missingActions,
    ...missingTurn,
  ];

  return {
    complete: missingSubjects.length === 0,
    layers: counts(inventory.layers.length, missingLayerSubjects.length),
    nodes: counts(inventory.nodes.length, missingNodeSubjects.length),
    actions: counts(inventory.actions.length, missingActionSubjects.length),
    turn: counts(1, missingTurn.length),
    missingSubjects,
  };
}

export class MissingReviewSubjectsError extends Error {
  readonly code = "review_coverage_incomplete";

  constructor(readonly missingSubjects: readonly MissingCoverageSubject[]) {
    super(`Review coverage is incomplete; missing subjects: ${missingSubjects.map(formatMissingSubject).join(", ")}`);
    this.name = "MissingReviewSubjectsError";
  }
}

export function formatMissingSubject(subject: MissingCoverageSubject): string {
  switch (subject.kind) {
    case "layer":
      return `layer(${formatId(subject.subjectId)})`;
    case "node":
      return `node(${formatId(subject.layerId!)}/${formatId(subject.subjectId)})`;
    case "navigate_action":
      return `navigate-action(${formatId(subject.layerId!)}/${formatId(subject.nodeId!)}/${formatId(subject.subjectId)})`;
    case "invoke_action":
      return `invoke-action(${formatId(subject.layerId!)}/${formatId(subject.nodeId!)}/${formatId(subject.subjectId)})`;
    case "turn":
      return `turn(${formatId(subject.subjectId)})`;
  }
}

export function nodeSubjectKey(layerId: ReviewSubjectId, nodeId: ReviewSubjectId): string {
  return JSON.stringify([typedId(layerId), typedId(nodeId)]);
}

function subjectIdKey(id: ReviewSubjectId): string {
  return JSON.stringify(typedId(id));
}

function typedId(id: ReviewSubjectId): readonly ["string", string] | readonly ["number", number] {
  return typeof id === "string" ? ["string", id] : ["number", id];
}

function counts(required: number, missing: number): ReviewCoverageCounts {
  return { required, reviewed: required - missing, missing };
}

function formatId(id: ReviewSubjectId): string {
  return JSON.stringify(id);
}
