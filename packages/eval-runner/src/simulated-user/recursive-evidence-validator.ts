import type { ReviewValidationIssue, ScreenshotId, ScreenshotMetadata } from "./contracts.js";
import { ScreenshotEvidenceValidationError, type ScreenshotEvidenceValidatorOptions } from "./evidence-validator.js";
import type { RecursiveEvidenceValidationRequest } from "./recursive-review.js";

/** Binds every semantic-tree write to immutable screenshots from the exact review turn. */
export function createRecursiveScreenshotEvidenceValidator(
  options: ScreenshotEvidenceValidatorOptions,
): (request: RecursiveEvidenceValidationRequest) => void {
  return (request) => {
    const issues: ReviewValidationIssue[] = [];
    const validate = (
      references: readonly ScreenshotId[],
      path: readonly (string | number)[],
      predicate: (screenshot: ScreenshotMetadata) => boolean,
      message: string,
    ): void => {
      const seen = new Set<string>();
      references.forEach((screenshotId, index) => {
        const evidencePath = [...path, index];
        if (seen.has(screenshotId)) {
          issues.push({ code: "invalid_input", path: evidencePath, message: `Duplicate screenshot evidence: ${screenshotId}`, screenshotId });
          return;
        }
        seen.add(screenshotId);
        const screenshot = options.screenshots.get(screenshotId);
        if (screenshot === undefined) {
          issues.push({ code: "unknown_evidence", path: evidencePath, message: `Unknown screenshot evidence: ${screenshotId}`, screenshotId });
        } else if (
          screenshot.executionId !== options.executionId
          || screenshot.threadId !== options.threadId
          || screenshot.turnId !== options.turnId
        ) {
          issues.push({ code: "screenshot_state_mismatch", path: evidencePath, message: `Screenshot ${screenshotId} belongs to a different review turn`, screenshotId });
        } else if (!predicate(screenshot)) {
          issues.push({ code: "evidence_subject_mismatch", path: evidencePath, message, screenshotId });
        }
      });
    };

    if (request.kind === "layer") {
      validate(
        request.review.evidence,
        ["evidence"],
        (shot) => shot.layerId === request.subject.layerId,
        `LayerResult evidence must show layer ${request.subject.layerId}`,
      );
    } else if (request.kind === "node") {
      const isNode = (shot: ScreenshotMetadata): boolean => shot.layerId === request.subject.layerId
        && (shot.selectedNodeId === null || shot.selectedNodeId === request.subject.nodeId);
      validate(request.review.evidence.context, ["evidence", "context"], isNode, `Node evidence must show ${request.subject.nodeId}`);
      validate(
        request.review.evidence.detail,
        ["evidence", "detail"],
        (shot) => shot.layerId === request.subject.layerId && shot.selectedNodeId === request.subject.nodeId,
        `Node detail evidence must show selected node ${request.subject.nodeId}`,
      );
      validate(request.review.semantic.evidence, ["semantic", "evidence"], () => true, "Semantic evidence must belong to the current turn");
      request.review.allocationSteps.forEach((step, index) => validate(
        step.evidence,
        ["allocationSteps", index, "evidence"],
        isNode,
        `Allocation evidence must show source node ${request.subject.nodeId}`,
      ));
      (request.review.missingActionOpportunities ?? []).forEach((opportunity, index) => validate(
        opportunity.evidence,
        ["missingActionOpportunities", index, "evidence"],
        isNode,
        `Missing-action evidence must show source node ${request.subject.nodeId}`,
      ));
      request.review.actions.forEach((action, index) => {
        const subject = request.actionSubjects.find((candidate) => candidate.actionId === action.actionId);
        const actionScreenshots = action.evidence.map((screenshotId) => options.screenshots.get(screenshotId));
        if (action.kind !== "invoke") {
          const hasSource = actionScreenshots.some((shot) => shot !== undefined && isNode(shot));
          const hasDestination = actionScreenshots.some((shot) => (
            shot !== undefined
            && subject?.targetLayerId !== undefined
            && shot.layerId === subject.targetLayerId
            && shot.navigationPath.some((entry) => entry.viaActionId === action.actionId)
          ));
          if (!hasSource || !hasDestination) {
            issues.push({
              code: "evidence_subject_mismatch",
              path: ["actions", index, "evidence"],
              message: `Navigate action ${action.actionId} requires both source and traversed destination evidence`,
            });
          }
        }
        validate(
          action.evidence,
          ["actions", index, "evidence"],
          (shot) => isNode(shot) || (
            subject?.targetLayerId !== undefined
            && shot.layerId === subject.targetLayerId
            && shot.navigationPath.some((entry) => entry.viaActionId === action.actionId)
          ),
          `Action evidence must show source node ${request.subject.nodeId} or its traversed destination`,
        );
      });
      request.review.findings.forEach((finding, index) => validate(
        finding.evidence,
        ["findings", index, "evidence"],
        () => true,
        "Node findings must cite the current review turn",
      ));
    } else {
      const lowerEvidence = new Set([
        ...request.currentLayerReviews.flatMap((layer) => layer.evidence),
        ...request.currentNodeReviews.flatMap((node) => [
          ...node.evidence.context,
          ...node.evidence.detail,
          ...node.semantic.evidence,
          ...node.allocationSteps.flatMap((step) => step.evidence),
          ...(node.missingActionOpportunities ?? []).flatMap((opportunity) => opportunity.evidence),
          ...node.actions.flatMap((action) => action.evidence),
        ]),
      ]);
      const isLower = (shot: ScreenshotMetadata): boolean => lowerEvidence.has(shot.screenshotId);
      validate(request.review.evidence.representative, ["evidence", "representative"], isLower, "Turn evidence must reuse lower-tree evidence");
      validate(request.review.scoreCeiling.evidence, ["scoreCeiling", "evidence"], isLower, "Score ceiling must reuse lower-tree evidence");
      request.review.findings.forEach((finding, index) => validate(
        finding.evidence,
        ["findings", index, "evidence"],
        isLower,
        "Turn findings must reuse lower-tree evidence",
      ));
    }
    if (issues.length > 0) throw new ScreenshotEvidenceValidationError(issues);
  };
}
