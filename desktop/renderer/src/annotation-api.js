import { request } from "./api.js";

export function createAnnotationApi() {
  return Object.freeze({
    async list(threadId) {
      return request(`/api/threads/${encodeURIComponent(threadId)}/annotations`);
    },
    async create(threadId, payload) {
      return request(`/api/threads/${encodeURIComponent(threadId)}/annotations`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },
    async revise(threadId, annotationId, payload) {
      return request(
        `/api/threads/${encodeURIComponent(threadId)}/annotations/${encodeURIComponent(annotationId)}/revisions`,
        { method: "POST", body: JSON.stringify(payload) },
      );
    },
    async retract(threadId, annotationId, payload) {
      return request(
        `/api/threads/${encodeURIComponent(threadId)}/annotations/${encodeURIComponent(annotationId)}/retract`,
        { method: "POST", body: JSON.stringify(payload) },
      );
    },
  });
}
