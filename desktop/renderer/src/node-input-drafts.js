import { request } from "./api.js";

export function createNodeInputDraftApi() {
  const base = (threadId) => `/api/threads/${encodeURIComponent(threadId)}/input-draft`;
  return Object.freeze({
    get: (threadId) => request(base(threadId)),
    commit: (threadId, occurrence, value, expectedRevision) => request(
      `${base(threadId)}/attachments`,
      {
        method: "PUT",
        body: JSON.stringify({ occurrence, value, expectedRevision }),
      },
    ),
    detach: (threadId, occurrence, expectedRevision) => request(
      `${base(threadId)}/attachments/${encodeURIComponent(occurrence.presentingInteractionNodeId)}/${encodeURIComponent(occurrence.presentingLayerId)}/${encodeURIComponent(occurrence.actionId)}?expectedRevision=${encodeURIComponent(expectedRevision)}`,
      { method: "DELETE" },
    ),
  });
}
