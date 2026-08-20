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

export function followupRequestBody(text, modelSelection) {
  return { text, modelSelection };
}
