import { request } from "./api.js";

export function createNodeContextDraftApi() {
  const base = (threadId) => `/api/threads/${encodeURIComponent(threadId)}/context-drafts`;
  return Object.freeze({
    list: (threadId) => request(base(threadId)),
    save: (threadId, draft) => request(
      `${base(threadId)}/${encodeURIComponent(draft.id)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          target: draft.target,
          targetNode: draft.targetNode,
          text: draft.text,
          expectedRevision: draft.revision,
        }),
      },
    ),
    confirm: (threadId, draft) => request(
      `${base(threadId)}/${encodeURIComponent(draft.id)}/confirm?expectedRevision=${encodeURIComponent(draft.revision)}`,
      { method: "POST" },
    ),
    discard: (threadId, draft) => request(
      `${base(threadId)}/${encodeURIComponent(draft.id)}?expectedRevision=${encodeURIComponent(draft.revision)}`,
      { method: "DELETE" },
    ),
  });
}

const nodeKey = (nodeId) => String(nodeId);
const threadKey = (threadId) => String(threadId);

function hydratedDraft(draft) {
  return {
    ...draft,
    status: "saved",
    error: null,
    editVersion: 0,
    timer: null,
    inFlight: null,
  };
}

export function createNodeContextDraftController({
  api,
  createId = () => globalThis.crypto.randomUUID(),
  schedule = (callback) => globalThis.setTimeout(callback, 350),
  cancel = (timer) => globalThis.clearTimeout(timer),
  onChange = () => {},
} = {}) {
  const draftsByThread = new Map();
  const threadDrafts = (threadId) => {
    const key = threadKey(threadId);
    if (!draftsByThread.has(key)) draftsByThread.set(key, new Map());
    return draftsByThread.get(key);
  };
  const changed = () => onChange();

  const controller = {
    async load(threadId) {
      const response = await api.list(threadId);
      const localDrafts = threadDrafts(threadId);
      const drafts = new Map();
      for (const draft of response?.drafts || []) {
        const key = nodeKey(draft.target.nodeId);
        const local = localDrafts.get(key);
        if (local?.editVersion === 0 && local.timer != null) cancel(local.timer);
        drafts.set(key, local?.editVersion > 0
          ? {
            ...hydratedDraft(draft),
            text: local.text,
            status: "unsaved",
            editVersion: local.editVersion,
            timer: local.timer,
          }
          : hydratedDraft(draft));
      }
      for (const [key, local] of localDrafts) {
        if (!drafts.has(key)) drafts.set(key, local);
      }
      draftsByThread.set(threadKey(threadId), drafts);
      changed();
      return [...drafts.values()];
    },
    draftForNode(threadId, nodeId) {
      return threadDrafts(threadId).get(nodeKey(nodeId)) || null;
    },
    open(threadId, target, targetNode) {
      const drafts = threadDrafts(threadId);
      const key = nodeKey(target.nodeId);
      if (!drafts.has(key)) {
        const draft = {
          id: createId(),
          threadId,
          target: { ...target },
          targetNode: { ...targetNode },
          text: "",
          revision: null,
          status: "unsaved",
          error: null,
          editVersion: 0,
          timer: null,
          inFlight: null,
        };
        draft.timer = schedule(() => controller.flush(threadId, target.nodeId));
        drafts.set(key, draft);
        changed();
      }
      return drafts.get(key);
    },
    update(threadId, nodeId, text) {
      const draft = controller.draftForNode(threadId, nodeId);
      if (!draft) return null;
      if (draft.timer != null) cancel(draft.timer);
      draft.text = text;
      draft.editVersion += 1;
      draft.status = "unsaved";
      draft.error = null;
      draft.timer = schedule(() => controller.flush(threadId, nodeId));
      changed();
      return draft;
    },
    async flush(threadId, nodeId) {
      const draft = controller.draftForNode(threadId, nodeId);
      if (!draft) return null;
      if (draft.inFlight) {
        await draft.inFlight.catch(() => null);
        const current = controller.draftForNode(threadId, nodeId);
        return current?.status === "unsaved" ? controller.flush(threadId, nodeId) : current;
      }
      if (draft.timer != null) cancel(draft.timer);
      draft.timer = null;
      const savingVersion = draft.editVersion;
      const payload = { ...draft };
      draft.status = "saving";
      draft.error = null;
      changed();
      const savePromise = api.save(threadId, payload);
      draft.inFlight = savePromise;
      try {
        const saved = await savePromise;
        const current = controller.draftForNode(threadId, nodeId);
        if (current?.id !== draft.id) return saved;
        current.revision = saved.revision;
        current.createdAt = saved.createdAt;
        current.updatedAt = saved.updatedAt;
        if (current.editVersion === savingVersion && current.text === payload.text) {
          current.status = "saved";
        } else {
          current.status = "unsaved";
        }
        changed();
        return saved;
      } catch (error) {
        const current = controller.draftForNode(threadId, nodeId);
        if (current?.id === draft.id) {
          current.status = current.editVersion === savingVersion ? "error" : "unsaved";
          current.error = current.editVersion === savingVersion ? error.message : null;
          changed();
        }
        return null;
      } finally {
        const current = controller.draftForNode(threadId, nodeId);
        if (current?.inFlight === savePromise) current.inFlight = null;
      }
    },
    async confirm(threadId, nodeId) {
      const draft = controller.draftForNode(threadId, nodeId);
      if (!draft) return null;
      if (draft.status !== "saved") await controller.flush(threadId, nodeId);
      const current = controller.draftForNode(threadId, nodeId);
      if (!current || current.status !== "saved" || current.revision == null) return null;
      const confirmation = await api.confirm(threadId, current);
      threadDrafts(threadId).delete(nodeKey(nodeId));
      changed();
      return confirmation;
    },
    async discard(threadId, nodeId) {
      const draft = controller.draftForNode(threadId, nodeId);
      if (!draft) return false;
      if (draft.timer != null) cancel(draft.timer);
      if (draft.revision != null) await api.discard(threadId, draft);
      threadDrafts(threadId).delete(nodeKey(nodeId));
      changed();
      return true;
    },
  };
  return controller;
}
