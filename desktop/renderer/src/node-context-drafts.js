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
    resolving: null,
    needsReconcile: false,
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
      await Promise.all([...localDrafts.values()].map((draft) => (
        draft.inFlight?.catch(() => null)
      )));
      const drafts = new Map();
      const retryNodeIds = [];
      for (const draft of response?.drafts || []) {
        const key = nodeKey(draft.target.nodeId);
        const local = localDrafts.get(key);
        if (!local || (local.editVersion === 0 && !local.resolving)) {
          if (local?.timer != null) cancel(local.timer);
          drafts.set(key, hydratedDraft(draft));
          continue;
        }
        if (local.timer != null) cancel(local.timer);
        Object.assign(local, hydratedDraft(draft), {
          text: local.text,
          editVersion: local.editVersion,
          resolving: local.resolving,
          status: local.text === draft.text ? "saved" : "unsaved",
        });
        drafts.set(key, local);
        if (local.status === "unsaved") retryNodeIds.push(draft.target.nodeId);
      }
      for (const [key, local] of localDrafts) {
        if (drafts.has(key)) continue;
        if (local.needsReconcile) {
          local.status = "error";
          local.error = "This draft changed or was resolved elsewhere. Reload before continuing.";
          local.needsReconcile = false;
        }
        drafts.set(key, local);
      }
      draftsByThread.set(threadKey(threadId), drafts);
      for (const nodeId of retryNodeIds) {
        const draft = controller.draftForNode(threadId, nodeId);
        draft.timer = schedule(() => controller.flush(threadId, nodeId));
      }
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
          resolving: null,
          needsReconcile: false,
        };
        draft.timer = schedule(() => controller.flush(threadId, target.nodeId));
        drafts.set(key, draft);
        changed();
      }
      return drafts.get(key);
    },
    update(threadId, nodeId, text) {
      const draft = controller.draftForNode(threadId, nodeId);
      if (!draft || draft.resolving) return null;
      if (draft.timer != null) cancel(draft.timer);
      draft.text = text;
      draft.editVersion += 1;
      draft.status = "unsaved";
      draft.error = null;
      draft.timer = schedule(() => controller.flush(threadId, nodeId));
      changed();
      return draft;
    },
    async flush(threadId, nodeId, { allowResolving = false, allowReconcile = true } = {}) {
      const draft = controller.draftForNode(threadId, nodeId);
      if (!draft || (draft.resolving && !allowResolving)) return null;
      if (draft.inFlight) {
        await draft.inFlight.catch(() => null);
        const current = controller.draftForNode(threadId, nodeId);
        return current?.status === "unsaved"
          ? controller.flush(threadId, nodeId, { allowResolving, allowReconcile })
          : current;
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
      let revisionConflict = false;
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
          const conflict = error.code === "context_draft_revision_conflict";
          revisionConflict = conflict && allowReconcile;
          current.needsReconcile = revisionConflict;
          current.status = conflict
            ? (allowReconcile ? "saving" : "error")
            : (current.editVersion === savingVersion ? "error" : "unsaved");
          current.error = conflict
            ? (allowReconcile ? null : "This draft changed again while recovering. Retry save.")
            : (current.editVersion !== savingVersion ? null : error.message);
          changed();
        }
      } finally {
        const current = controller.draftForNode(threadId, nodeId);
        if (current?.inFlight === savePromise) current.inFlight = null;
      }
      if (revisionConflict) {
        try {
          await controller.load(threadId);
          const reconciled = controller.draftForNode(threadId, nodeId);
          return reconciled?.status === "unsaved"
            ? controller.flush(threadId, nodeId, { allowReconcile: false })
            : reconciled;
        } catch (error) {
          const current = controller.draftForNode(threadId, nodeId);
          if (current) {
            current.status = "error";
            current.error = `Could not reload this changed draft: ${error.message}`;
            current.needsReconcile = false;
            changed();
          }
        }
      }
      return null;
    },
    async confirm(threadId, nodeId) {
      const draft = controller.draftForNode(threadId, nodeId);
      if (!draft) return null;
      if (draft.resolving) return null;
      const confirmationPromise = (async () => {
        if (draft.status !== "saved") await controller.flush(threadId, nodeId);
        const current = controller.draftForNode(threadId, nodeId);
        if (!current || current.status !== "saved" || current.revision == null) return null;
        const confirmation = await api.confirm(threadId, current);
        threadDrafts(threadId).delete(nodeKey(nodeId));
        changed();
        return confirmation;
      })();
      draft.resolving = { kind: "confirm", promise: confirmationPromise };
      changed();
      try {
        const confirmation = await confirmationPromise;
        if (!confirmation) {
          const unresolved = controller.draftForNode(threadId, nodeId);
          if (unresolved?.resolving?.promise === confirmationPromise) unresolved.resolving = null;
          changed();
        }
        return confirmation;
      } catch (error) {
        const unresolved = controller.draftForNode(threadId, nodeId);
        if (unresolved?.resolving?.promise === confirmationPromise) unresolved.resolving = null;
        changed();
        throw error;
      }
    },
    async discard(threadId, nodeId) {
      let draft = controller.draftForNode(threadId, nodeId);
      if (!draft) return false;
      if (draft.resolving) return false;
      const operation = { kind: "discard" };
      draft.resolving = operation;
      changed();
      try {
        if (draft.timer != null) cancel(draft.timer);
        draft.timer = null;
        if (draft.inFlight) await draft.inFlight.catch(() => null);
        draft = controller.draftForNode(threadId, nodeId);
        if (!draft) return true;
        if (draft?.revision == null && draft?.status === "error") {
          await controller.flush(threadId, nodeId, { allowResolving: true });
          draft = controller.draftForNode(threadId, nodeId);
        }
        if (!draft) return true;
        if (draft?.revision == null && draft?.status === "error") {
          throw new Error("The saved draft state is uncertain. Retry discard when persistence recovers.");
        }
        if (draft.revision != null) await api.discard(threadId, draft);
        threadDrafts(threadId).delete(nodeKey(nodeId));
        changed();
        return true;
      } catch (error) {
        const unresolved = controller.draftForNode(threadId, nodeId);
        if (unresolved?.resolving === operation) unresolved.resolving = null;
        changed();
        throw error;
      }
    },
  };
  return controller;
}
