const PENDING_COMPLETION_STATUSES = new Set(["not_started", "running", "submitted"]);

export function actionWasInvoked(
  invocations = [],
  pendingInvocations = [],
  sourceInteractionId,
  actionId,
) {
  return invocations.some((invocation) => (
    String(invocation.actionId) === String(actionId)
    && invocation.resultCompletionStatus !== "submitted"
  )) || pendingInvocations.some((invocation) => (
    String(invocation.sourceInteractionId) === String(sourceInteractionId)
    && String(invocation.actionId) === String(actionId)
  ));
}

export function actionCanRetry(invocations = [], actionId) {
  return invocations.some((invocation) => (
    String(invocation.actionId) === String(actionId)
    && invocation.resultCompletionStatus === "submitted"
  ));
}

export function withoutPendingActionInvocation(
  pendingInvocations = [],
  sourceInteractionId,
  actionId,
) {
  return pendingInvocations.filter((invocation) => !(
    String(invocation.sourceInteractionId) === String(sourceInteractionId)
    && String(invocation.actionId) === String(actionId)
  ));
}

export function reconcileActionTransitions(interactions, selected, transitions) {
  const remaining = new Map(transitions);
  let nextSelected = selected;
  for (const [resultInteractionId, sourceInteractionId] of transitions) {
    const result = interactions.find((interaction) => (
      String(interaction.id) === String(resultInteractionId)
    ));
    if (!result || PENDING_COMPLETION_STATUSES.has(result.completionStatus)) continue;
    remaining.delete(resultInteractionId);
    if (
      result.completionStatus === "accepted"
      && String(nextSelected?.id) === String(sourceInteractionId)
    ) {
      nextSelected = result;
    }
  }
  return { selected: nextSelected, transitions: remaining };
}

export function visibleLayerAfterRefresh(
  previousInteractionId,
  previousVisibleLayer,
  selectedInteraction,
) {
  const refreshedRoot = selectedInteraction?.completionOutput?.rootLayer ?? null;
  if (
    previousVisibleLayer
    && String(previousInteractionId) === String(selectedInteraction?.id)
  ) {
    if (
      refreshedRoot
      && String(previousVisibleLayer.layer?.id) === String(refreshedRoot.layer?.id)
    ) return refreshedRoot;
    return previousVisibleLayer;
  }
  return refreshedRoot;
}
