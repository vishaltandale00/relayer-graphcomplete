export const ANNOTATION_RATINGS = Object.freeze([
  Object.freeze({ value: 1, label: "Bad" }),
  Object.freeze({ value: 2, label: "Needs work" }),
  Object.freeze({ value: 3, label: "Good" }),
  Object.freeze({ value: 4, label: "Great" }),
]);

export function annotationRatingLabel(value) {
  return ANNOTATION_RATINGS.find((rating) => rating.value === Number(value))?.label ?? null;
}

export function annotationTimestamp(value) {
  if (value == null || value === "") return null;
  const numeric = typeof value === "number" || /^\d+$/.test(String(value))
    ? Number(value)
    : value;
  const date = new Date(numeric);
  return Number.isNaN(date.valueOf()) ? null : date;
}

export function latestAnnotationRevision(annotation) {
  return annotation?.revisions?.findLast?.(() => true)
    ?? annotation?.revisions?.[annotation.revisions.length - 1]
    ?? null;
}

export function activeAnnotations(annotations = []) {
  return annotations.filter((annotation) => latestAnnotationRevision(annotation)?.state === "active");
}

export function sameAnnotationAnchor(left, right) {
  if (!left || !right || left.kind !== right.kind) return false;
  return [
    "interactionId",
    "layerId",
    "presentationLayerId",
    "sourceLayerId",
    "nodeId",
    "edgeId",
    "actionId",
  ]
    .every((field) => String(left[field] ?? "") === String(right[field] ?? ""));
}

export function annotationsForAnchor(annotations, anchor) {
  return activeAnnotations(annotations).filter((annotation) => (
    sameAnnotationAnchor(annotation.anchor, anchor)
  ));
}

export function annotationSubjectContextChanged(
  currentThreadId,
  currentAnchor,
  nextThreadId,
  nextAnchor,
) {
  return String(currentThreadId ?? "") !== String(nextThreadId ?? "")
    || !sameAnnotationAnchor(currentAnchor, nextAnchor);
}

export function annotationNavigationContext(selection, anchor) {
  return {
    turnId: anchor.interactionId ?? selection.currentInteractionId ?? null,
    layerPath: (selection.layerPath || []).map((entry) => ({
      layerId: entry.layerId,
      viaActionId: entry.actionId ?? entry.viaActionId ?? null,
    })),
    selectedSubject: anchor,
  };
}
