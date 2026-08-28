export function interactionReturnsToUnsent(interaction) {
  return interaction?.completionStatus === "not_started"
    && interaction?.latestAttempt?.outcome === "model_failed";
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

export function confirmationRestorationKey(threadId, interaction) {
  const restoredDraft = restoredDraftForInteraction(interaction);
  if (!restoredDraft) return null;
  return `${threadId}:${interaction.id}:${restoredDraft.retryAttemptId}`;
}

export function interactionSubmissionTarget(
  threadId,
  latestInteraction,
  text,
  modelSelection,
  inputId,
  contexts = [],
  contextConfirmationIds = [],
  inputDraftRevision = null,
) {
  const restoredDraft = restoredDraftForInteraction(latestInteraction);
  if (!restoredDraft) {
    return {
      path: `/api/threads/${encodeURIComponent(threadId)}/interactions`,
      body: {
        text,
        modelSelection,
        ...(inputDraftRevision == null ? {} : { inputDraftRevision }),
      },
    };
  }
  return {
    path: `/api/threads/${encodeURIComponent(threadId)}/interactions/${encodeURIComponent(latestInteraction.id)}/retry`,
    body: {
      attemptId: restoredDraft.retryAttemptId,
      text,
      inputId,
      contexts,
      contextConfirmationIds,
      modelSelection,
      ...(inputDraftRevision == null ? {} : { inputDraftRevision }),
    },
  };
}
