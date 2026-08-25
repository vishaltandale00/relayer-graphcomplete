export const MODEL_RETRYABLE_FAILURES = new Set([
  "model_unavailable",
  "model_denied",
  "provider_disconnected",
  "provider_authentication",
  "authentication",
  "model_not_found",
  "provider_rate_limit",
  "rate_limit",
  "provider_timeout",
  "provider_transport",
  "transport",
  "provider_5xx",
]);

export function interactionReturnsToUnsent(interaction) {
  return interaction?.completionStatus === "not_started"
    && interaction?.latestAttempt?.outcome === "model_failed"
    && interaction?.latestAttempt?.effectBoundary === "none"
    && MODEL_RETRYABLE_FAILURES.has(interaction?.latestAttempt?.failureCategory);
}

export function restoredDraftForInteraction(interaction) {
  if (!interactionReturnsToUnsent(interaction)) return null;
  return {
    text: interaction.text ?? interaction.prompt ?? "",
    modelSelection: interaction.modelSelection ?? interaction.latestAttempt?.modelSelection ?? null,
    failureCategory: interaction.latestAttempt.failureCategory,
    retryAttemptId: interaction.latestAttempt.id,
    message: interaction.latestAttempt.failureMessage ?? "The selected model could not complete this turn. Choose an available model and send again.",
  };
}

export function interactionSubmissionTarget(threadId, latestInteraction, text, modelSelection) {
  const restoredDraft = restoredDraftForInteraction(latestInteraction);
  if (!restoredDraft) {
    return {
      path: `/api/threads/${encodeURIComponent(threadId)}/interactions`,
      body: { text, modelSelection },
    };
  }
  return {
    path: `/api/threads/${encodeURIComponent(threadId)}/interactions/${encodeURIComponent(latestInteraction.id)}/retry`,
    body: {
      attemptId: restoredDraft.retryAttemptId,
      text,
      modelSelection,
    },
  };
}
