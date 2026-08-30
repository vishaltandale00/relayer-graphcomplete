import type {
  ActionReview,
  ExecutionId,
  Finding,
  LayerReview,
  NodeReview,
  ReviewValidationIssue,
  ScreenshotEvidenceRef,
  ScreenshotId,
  ScreenshotMetadata,
  ThreadId,
  TurnId,
  TurnReview,
} from "./contracts.js";
import type { ActionReviewSubject } from "./inventory.js";
import type {
  ReviewEvidenceValidationRequest,
  ReviewEvidenceValidator,
} from "./review-store.js";

export interface ScreenshotEvidenceValidatorOptions {
  readonly executionId: ExecutionId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  /** Prior turns whose screenshots may support only the overall follow-up assessment. */
  readonly comparisonTurnIds?: readonly TurnId[];
  readonly screenshots: ReadonlyMap<ScreenshotId, ScreenshotMetadata>;
}

export class ScreenshotEvidenceValidationError extends Error {
  constructor(readonly issues: readonly ReviewValidationIssue[]) {
    super(issues.map((issue) => issue.message).join("; "));
    this.name = "ScreenshotEvidenceValidationError";
  }
}

export function createScreenshotEvidenceValidator(
  options: ScreenshotEvidenceValidatorOptions,
): ReviewEvidenceValidator<LayerReview, NodeReview, TurnReview> {
  return (request) => {
    const issues = validateScreenshotEvidence(request, options);
    if (issues.length > 0) throw new ScreenshotEvidenceValidationError(issues);
  };
}

export function validateScreenshotEvidence(
  request: ReviewEvidenceValidationRequest<LayerReview, NodeReview, TurnReview>,
  options: ScreenshotEvidenceValidatorOptions,
): readonly ReviewValidationIssue[] {
  const collector = new EvidenceIssueCollector(options);
  switch (request.kind) {
    case "layer":
      collector.requireNonEmpty(request.review.evidence.viewport, ["evidence", "viewport"]);
      collector.references(
        request.review.evidence.viewport,
        ["evidence", "viewport"],
        (shot) => shot.layerId === request.subject.layerId
          && shot.captureTarget.kind === "viewport"
          && shot.mode === "visible",
        `Layer evidence must be a viewport capture of layer ${request.subject.layerId}`,
      );
      collector.findings(
        request.review.findings,
        ["findings"],
        (shot) => shot.layerId === request.subject.layerId,
        `Layer findings must cite layer ${request.subject.layerId}`,
      );
      break;
    case "node":
      validateNodeEvidence(request, collector);
      break;
    case "turn": {
      const lowerReviewEvidence = collectLowerReviewEvidence(
        request.currentLayerReviews,
        request.currentNodeReviews,
      );
      const comparisonTurnIds = new Set(options.comparisonTurnIds ?? []);
      comparisonTurnIds.delete(options.turnId);
      const allowedTurnIds = new Set([options.turnId, ...comparisonTurnIds]);
      collector.requireNonEmpty(request.review.evidence.representative, ["evidence", "representative"]);
      if (!request.review.evidence.representative.some((screenshotId) => lowerReviewEvidence.has(screenshotId))) {
        collector.issues.push({
          code: "unrelated_evidence",
          path: ["evidence", "representative"],
          message: "Turn evidence must include at least one screenshot used by a completed current-turn lower-subject review",
        });
      }
      collector.references(
        request.review.evidence.representative,
        ["evidence", "representative"],
        (shot) => lowerReviewEvidence.has(shot.screenshotId) || comparisonTurnIds.has(shot.turnId),
        "Turn evidence must cite completed current-turn lower-subject reviews or an allowlisted comparison turn",
        undefined,
        undefined,
        allowedTurnIds,
      );
      collector.requireNonEmpty(request.review.structure.evidence, ["structure", "evidence"]);
      collector.references(
        request.review.structure.evidence,
        ["structure", "evidence"],
        (shot) => lowerReviewEvidence.has(shot.screenshotId),
        "Structure evidence must cite completed current-turn lower-subject reviews",
      );
      collector.requireNonEmpty(request.review.scoreCeiling.evidence, ["scoreCeiling", "evidence"]);
      collector.references(
        request.review.scoreCeiling.evidence,
        ["scoreCeiling", "evidence"],
        (shot) => lowerReviewEvidence.has(shot.screenshotId),
        "Score-ceiling evidence must cite completed current-turn lower-subject reviews",
      );
      collector.findings(
        request.review.findings,
        ["findings"],
        (shot) => lowerReviewEvidence.has(shot.screenshotId) || comparisonTurnIds.has(shot.turnId),
        "Turn findings must cite completed current-turn lower-subject reviews or an allowlisted comparison turn",
        allowedTurnIds,
      );
      break;
    }
  }
  return collector.issues;
}

function validateNodeEvidence(
  request: Extract<ReviewEvidenceValidationRequest<LayerReview, NodeReview, TurnReview>, { kind: "node" }>,
  collector: EvidenceIssueCollector,
): void {
  const { review, subject, actionSubjects } = request;
  collector.requireNonEmpty(review.evidence.context, ["evidence", "context"]);
  collector.requireNonEmpty(review.evidence.detail, ["evidence", "detail"]);
  collector.references(
    review.evidence.context,
    ["evidence", "context"],
    (shot) => shot.layerId === subject.layerId
      && (shot.selectedNodeId === null || shot.selectedNodeId === subject.nodeId),
    `Node context must show node ${subject.nodeId} in layer ${subject.layerId}`,
  );
  collector.references(
    review.evidence.detail,
    ["evidence", "detail"],
    (shot) => shot.layerId === subject.layerId
      && shot.selectedNodeId === subject.nodeId
      && shot.captureTarget.kind === "element",
    `Node detail evidence must be an element capture with node ${subject.nodeId} selected`,
  );
  collector.findings(
    review.findings,
    ["findings"],
    (shot) => shot.layerId === subject.layerId
      && (shot.selectedNodeId === null || shot.selectedNodeId === subject.nodeId),
    `Node findings must cite node ${subject.nodeId} or its layer context`,
  );
  collector.requireNonEmpty(review.structure.evidence, ["structure", "evidence"]);
  collector.references(
    review.structure.evidence,
    ["structure", "evidence"],
    (shot) => shot.layerId === subject.layerId
      && (shot.selectedNodeId === null || shot.selectedNodeId === subject.nodeId),
    `Node structure evidence must cite node ${subject.nodeId} or its layer context`,
  );

  review.actions.forEach((action, index) => {
    const actionSubject = actionSubjects.find((candidate) => candidate.actionId === action.actionId);
    if (actionSubject === undefined) {
      collector.issues.push({
        code: "invalid_input",
        path: ["actions", index, "actionId"],
        message: `Unknown action review subject: ${action.actionId}`,
      });
      return;
    }
    validateActionEvidence(action, actionSubject, ["actions", index], collector);
  });
}

function validateActionEvidence(
  review: ActionReview,
  subject: ActionReviewSubject,
  path: readonly (string | number)[],
  collector: EvidenceIssueCollector,
): void {
  if (review.kind !== subject.actionKind) {
    collector.issues.push({
      code: "invalid_input",
      path: [...path, "kind"],
      message: `Action ${subject.actionId} has kind ${review.kind}; expected ${subject.actionKind}`,
    });
    return;
  }
  collector.requireNonEmpty(review.evidence.source, [...path, "evidence", "source"]);
  const isSource = (shot: ScreenshotMetadata): boolean => shot.layerId === subject.layerId
    && shot.selectedNodeId === subject.nodeId;
  collector.references(
    review.evidence.source,
    [...path, "evidence", "source"],
    isSource,
    `Action ${subject.actionId} source evidence must show node ${subject.nodeId} in layer ${subject.layerId}`,
  );

  if (review.kind === "navigate") {
    collector.requireNonEmpty(review.evidence.destination, [...path, "evidence", "destination"]);
    collector.references(
      review.evidence.destination,
      [...path, "evidence", "destination"],
      (shot) => shot.layerId === subject.targetLayerId,
      `Navigate action ${subject.actionId} destination evidence must show layer ${subject.targetLayerId}`,
      (shot) => shot.navigationPath.some((entry) => entry.viaActionId === subject.actionId),
      `Navigate action ${subject.actionId} is absent from the destination navigation path`,
    );
    collector.findings(
      review.findings,
      [...path, "findings"],
      (shot) => isSource(shot) || (
        shot.layerId === subject.targetLayerId
        && shot.navigationPath.some((entry) => entry.viaActionId === subject.actionId)
      ),
      `Navigate action ${subject.actionId} findings must cite its source or traversed destination`,
    );
  } else {
    collector.findings(
      review.findings,
      [...path, "findings"],
      isSource,
      `${review.kind === "input" ? "Input" : "Invoke"} action ${subject.actionId} findings must cite its visible source`,
    );
  }
}

function collectLowerReviewEvidence(
  layerReviews: readonly LayerReview[],
  nodeReviews: readonly NodeReview[],
): ReadonlySet<ScreenshotId> {
  const references = new Set<ScreenshotId>();
  const add = (values: readonly ScreenshotEvidenceRef[]): void => {
    for (const value of values) references.add(value);
  };
  for (const review of layerReviews) {
    add(review.evidence.viewport);
    for (const finding of review.findings) add(finding.evidence);
  }
  for (const review of nodeReviews) {
    add(review.evidence.context);
    add(review.evidence.detail);
    add(review.structure.evidence);
    for (const finding of review.findings) add(finding.evidence);
    for (const action of review.actions) {
      add(action.evidence.source);
      if (action.kind === "navigate") add(action.evidence.destination);
      for (const finding of action.findings) add(finding.evidence);
    }
  }
  return references;
}

class EvidenceIssueCollector {
  readonly issues: ReviewValidationIssue[] = [];

  constructor(private readonly options: ScreenshotEvidenceValidatorOptions) {}

  requireNonEmpty(references: readonly ScreenshotEvidenceRef[], path: readonly (string | number)[]): void {
    if (references.length === 0) {
      this.issues.push({
        code: "invalid_input",
        path,
        message: "Screenshot evidence must contain at least one reference",
      });
    }
  }

  references(
    references: readonly ScreenshotEvidenceRef[],
    path: readonly (string | number)[],
    matchesSubject: (screenshot: ScreenshotMetadata) => boolean,
    mismatchMessage: string,
    matchesNavigation?: (screenshot: ScreenshotMetadata) => boolean,
    navigationMismatchMessage?: string,
    allowedTurnIds: ReadonlySet<TurnId> = new Set([this.options.turnId]),
  ): void {
    const seen = new Set<ScreenshotId>();
    references.forEach((screenshotId, index) => {
      const referencePath = [...path, index];
      if (seen.has(screenshotId)) {
        this.issues.push({
          code: "invalid_input",
          path: referencePath,
          message: `Duplicate screenshot evidence: ${screenshotId}`,
          screenshotId,
        });
        return;
      }
      seen.add(screenshotId);
      const screenshot = this.options.screenshots.get(screenshotId);
      if (screenshot === undefined) {
        this.issues.push({
          code: "unknown_evidence",
          path: referencePath,
          message: `Unknown screenshot evidence: ${screenshotId}`,
          screenshotId,
        });
        return;
      }
      if (
        screenshot.executionId !== this.options.executionId
        || screenshot.threadId !== this.options.threadId
        || !allowedTurnIds.has(screenshot.turnId)
      ) {
        this.issues.push({
          code: "screenshot_state_mismatch",
          path: referencePath,
          message: `Screenshot ${screenshotId} belongs to different execution, thread, or turn state`,
          screenshotId,
        });
        return;
      }
      if (!matchesSubject(screenshot)) {
        this.issues.push({
          code: "evidence_subject_mismatch",
          path: referencePath,
          message: mismatchMessage,
          screenshotId,
        });
      } else if (matchesNavigation !== undefined && !matchesNavigation(screenshot)) {
        this.issues.push({
          code: "navigation_path_mismatch",
          path: referencePath,
          message: navigationMismatchMessage!,
          screenshotId,
        });
      }
    });
  }

  findings(
    findings: readonly Finding[],
    path: readonly (string | number)[],
    matchesSubject: (screenshot: ScreenshotMetadata) => boolean,
    mismatchMessage: string,
    allowedTurnIds?: ReadonlySet<TurnId>,
  ): void {
    findings.forEach((finding, index) => {
      this.requireNonEmpty(finding.evidence, [...path, index, "evidence"]);
      this.references(
        finding.evidence,
        [...path, index, "evidence"],
        matchesSubject,
        mismatchMessage,
        undefined,
        undefined,
        allowedTurnIds,
      );
    });
  }
}
