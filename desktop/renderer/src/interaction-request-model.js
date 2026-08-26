export function newThreadRequestBody({
  title,
  initialMessage,
  permissionProfileId,
  projectId,
  pickerPayload,
}) {
  return {
    title,
    initialMessage,
    permissionProfileId,
    harnessId: pickerPayload.harnessId,
    modelSelection: pickerPayload.modelSelection,
    ...(projectId ? { projectId } : {}),
  };
}

export function followupRequestBody(text, modelSelection, inputId, contexts = []) {
  if (!inputId) throw new Error("A stable inputId is required for a follow-up send.");
  return { text, inputId, contexts, modelSelection };
}

const pendingFollowupSends = new Map();

export function stableFollowupInputId(threadId, text, modelSelection, contexts = []) {
  const content = JSON.stringify({ threadId: String(threadId), text, modelSelection, contexts });
  const pending = pendingFollowupSends.get(content);
  if (pending) return pending;
  const inputId = crypto.randomUUID();
  pendingFollowupSends.set(content, inputId);
  return inputId;
}

export function markFollowupSendSucceeded(inputId) {
  for (const [content, pendingInputId] of pendingFollowupSends) {
    if (pendingInputId === inputId) {
      pendingFollowupSends.delete(content);
      return;
    }
  }
}
