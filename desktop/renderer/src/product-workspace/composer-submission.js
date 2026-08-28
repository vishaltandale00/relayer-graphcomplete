function settledRevision(submittedRevision) {
  if (typeof submittedRevision === "number") return submittedRevision + 1;
  return Object.freeze({ settledFrom: submittedRevision });
}

function clearedField(submissionField) {
  return {
    value: Array.isArray(submissionField.value) ? [] : "",
    revision: submissionField.settledRevision,
  };
}

function fieldMatchesSubmission(field, submissionField) {
  return Object.is(field?.revision, submissionField.revision);
}

function clearMatchingFields(draft, submission, { requirePromptScope = false } = {}) {
  const clearPrompt = (!requirePromptScope || draft.scopeKey === submission.scopeKey)
    && fieldMatchesSubmission(draft.prompt, submission.prompt);
  const clearContexts = fieldMatchesSubmission(draft.contexts, submission.contexts);
  if (!clearPrompt && !clearContexts) return draft;
  return {
    ...draft,
    prompt: clearPrompt ? clearedField(submission.prompt) : draft.prompt,
    contexts: clearContexts ? clearedField(submission.contexts) : draft.contexts,
  };
}

export function captureComposerSubmission({ threadId, scopeKey, prompt, contexts }) {
  return Object.freeze({
    threadId,
    scopeKey,
    prompt: Object.freeze({
      value: prompt.value,
      revision: prompt.revision,
      settledRevision: settledRevision(prompt.revision),
    }),
    contexts: Object.freeze({
      value: contexts.value,
      revision: contexts.revision,
      settledRevision: settledRevision(contexts.revision),
    }),
  });
}

export function settleComposerSubmission({ submission, outcome, current }) {
  if (outcome === "failed") return { current, submittedScopeKey: null };
  if (outcome !== "succeeded") {
    throw new Error(`Unknown composer submission outcome: ${String(outcome)}`);
  }

  const settledCurrent = String(current.threadId) === String(submission.threadId)
    ? clearMatchingFields(current, submission, { requirePromptScope: true })
    : current;
  return { current: settledCurrent, submittedScopeKey: submission.scopeKey };
}
