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

let pendingFollowupSend = null;

export function stableFollowupInputId(threadId, text, modelSelection, contexts = []) {
  const content = JSON.stringify({ threadId: String(threadId), text, modelSelection, contexts });
  if (pendingFollowupSend?.content !== content) {
    pendingFollowupSend = { content, inputId: crypto.randomUUID() };
  }
  return pendingFollowupSend.inputId;
}

export function markFollowupSendSucceeded(inputId) {
  if (pendingFollowupSend?.inputId === inputId) pendingFollowupSend = null;
}
