const PENDING_COMPLETION_STATUSES = new Set(["not_started", "running", "submitted"]);

export function isDurableActionInvocation(call) {
  return call.durable === true || (call.durable == null && call.reusable === true);
}

// A trusted native refusal spent no call. The immutable failed receipt is
// readable history; a corrected activation needs a fresh key and fresh inputs.
export function isRejectedActionPreparation(call) {
  return call?.preparationRejected === true && call.preparationRecoverable === false
    && call.durable === false && call.resultCompletionStatus === "failed"
    && typeof call.invocationKey === "string" && call.invocationKey.length > 0
    && call.invocationKey !== "legacy";
}

export function recoverableActionInvocation(invocations = [], sourceInteractionId, actionId) {
  return invocations.find(call => call.graphOnly !== true && String(call.sourceInteractionId) === String(sourceInteractionId)
    && String(call.actionId) === String(actionId)
    && call.preparationRecoverable === true
    && ["not_started", "submitted", "failed"].includes(call.resultCompletionStatus)
    && typeof call.invocationKey === "string" && call.invocationKey.length > 0);
}

export function recoverActionInvocation(invocations, sourceInteractionId, actionId, invocationKey) {
  return invocations.find((call) => call.graphOnly !== true && String(call.sourceInteractionId) === String(sourceInteractionId)
    && String(call.actionId) === String(actionId)
    && (isDurableActionInvocation(call) || call.invocationKey ? call.invocationKey === invocationKey : true));
}

export function mergeActionInvocation(invocations, next) {
  return [...invocations.filter((call) => isDurableActionInvocation(next) || next.invocationKey
    ? (next.graphOnly === true || call.graphOnly === true
      ? !(String(call.sourceInteractionId) === String(next.sourceInteractionId)
        && String(call.actionId) === String(next.actionId) && call.invocationKey === next.invocationKey)
      : String(call.resultInteractionId) !== String(next.resultInteractionId))
    : !(String(call.sourceInteractionId) === String(next.sourceInteractionId) && String(call.actionId) === String(next.actionId))), next];
}

export function actionWasInvoked(
  invocations = [],
  pendingInvocations = [],
  sourceInteractionId,
  actionId,
  sourceReusable,
) {
  return invocations.some((invocation) => (
    String(invocation.actionId) === String(actionId)
    && !isRejectedActionPreparation(invocation)
    && (sourceReusable === false || (sourceReusable == null && !isDurableActionInvocation(invocation)))
    && (!recoverableActionInvocation([invocation], sourceInteractionId, actionId)
      && (invocation.resultCompletionStatus !== "submitted" || isDurableActionInvocation(invocation) || invocation.invocationKey))
  )) || pendingInvocations.some((invocation) => (
    String(invocation.sourceInteractionId) === String(sourceInteractionId)
    && String(invocation.actionId) === String(actionId)
  ));
}

// A single-call definition stays an Invoke. Its returned call is a read projection,
// not an accepted action conversion or a second mutable target.
export function singleCallResultDestination(state, action, node, actions) {
  if (action?.kind !== "invoke" || action.reusable !== false) return null;
  const call = (state.actionInvocations ?? []).find((item) =>
    String(item.actionId) === String(action.id) && item.resultCompletionStatus === "accepted");
  const result = call && state.interactions?.find((item) => String(item.id) === String(call.resultInteractionId));
  const layerId = result?.completionOutput?.rootLayer?.layer?.id;
  const navigation = layerId == null ? null : actions.find((item) => item.kind === "navigate"
    && String(item.sourceNodeId) === String(node.id) && String(item.targetLayerId) === String(layerId));
  return navigation ? { call, layerId } : null;
}

export function actionCanRetry(invocations = [], actionId) {
  return invocations.some(invocation => invocation.graphOnly !== true && String(invocation.actionId) === String(actionId)
    && (isDurableActionInvocation(invocation) || invocation.invocationKey
      ? Boolean(recoverableActionInvocation([invocation], invocation.sourceInteractionId, actionId))
      : invocation.resultCompletionStatus === "submitted"));
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

export function actionReviewKind(action) {
  if (action?.kind === "input") return "input-action";
  return (
    action?.kind === "navigate"
    || (action?.kind === "invoke" && action.targetLayerId != null)
  ) ? "navigate-action" : "invoke-action";
}
