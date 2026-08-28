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
    operation: { kind: "idle" },
  };
}

const isResolving = (draft) => ["confirming", "discarding"].includes(draft?.operation?.kind);
const isReconciling = (draft) => draft?.operation?.kind === "reconciling";
const currentSave = (draft) => draft?.operation?.kind === "saving"
  ? draft.operation.promise
  : null;

function draftSnapshot(draft) {
  return Object.freeze({
    id: draft.id,
    threadId: draft.threadId,
    target: Object.freeze({ ...draft.target }),
    targetNode: Object.freeze({ ...draft.targetNode }),
    text: draft.text,
    revision: draft.revision,
    status: draft.status,
    error: draft.error,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  });
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
  const settleCurrentSave = async (drafts, key) => {
    while (true) {
      const save = currentSave(drafts.get(key));
      if (!save) return drafts.get(key) || null;
      await save.catch(() => null);
      await Promise.resolve();
    }
  };

  const controller = {
    async load(threadId) {
      const response = await api.list(threadId);
      const localDrafts = threadDrafts(threadId);
      const responseBaseline = new Map([...localDrafts].map(([key, draft]) => [key, {
        draft,
        editVersion: draft.editVersion,
        operation: draft.operation,
      }]));
      const drafts = new Map();
      const retryNodeIds = new Set();
      const observedLocal = new Map();
      for (const draft of response?.drafts || []) {
        const key = nodeKey(draft.target.nodeId);
        const local = await settleCurrentSave(localDrafts, key);
        const baseline = responseBaseline.get(key);
        if (local && (!baseline || (
          baseline.operation?.kind !== "saving"
          && (baseline.draft !== local
            || baseline.editVersion !== local.editVersion
            || baseline.operation !== local.operation)
        ))) {
          drafts.set(key, local);
          observedLocal.set(key, {
            draft: local,
            editVersion: local.editVersion,
            operation: local.operation,
          });
          continue;
        }
        observedLocal.set(key, local && {
          draft: local,
          editVersion: local.editVersion,
          operation: local.operation,
        });
        if (!local || (
          local.editVersion === 0 && !isResolving(local) && !isReconciling(local)
        )) {
          if (local?.timer != null) cancel(local.timer);
          drafts.set(key, hydratedDraft(draft));
          continue;
        }
        if (local.timer != null) cancel(local.timer);
        const operation = local.operation;
        Object.assign(local, hydratedDraft(draft), {
          text: local.text,
          editVersion: local.editVersion,
          operation: isResolving({ operation }) ? operation : { kind: "idle" },
          status: local.text === draft.text ? "saved" : "unsaved",
        });
        drafts.set(key, local);
        if (local.status === "unsaved") retryNodeIds.add(draft.target.nodeId);
      }
      for (const [key, local] of localDrafts) {
        if (drafts.has(key)) continue;
        await settleCurrentSave(localDrafts, key);
        observedLocal.set(key, {
          draft: local,
          editVersion: local.editVersion,
          operation: local.operation,
        });
        if (isReconciling(local)) {
          local.status = "error";
          local.error = "This draft changed or was resolved elsewhere. Reload before continuing.";
          local.operation = { kind: "idle" };
        }
        drafts.set(key, local);
      }
      for (const [key, current] of localDrafts) {
        const observed = observedLocal.get(key);
        if (!observed
          || observed.draft !== current
          || observed.editVersion !== current.editVersion
          || observed.operation !== current.operation) {
          drafts.set(key, current);
          if (current.status === "unsaved") retryNodeIds.add(current.target.nodeId);
        }
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
    draftsForThread(threadId) {
      return Object.freeze([...threadDrafts(threadId).values()].map(draftSnapshot));
    },
    async persistAll(threadId) {
      const drafts = controller.draftsForThread(threadId);
      await Promise.all(drafts
        .filter((draft) => draft.status !== "saved" || draft.revision == null)
        .map((draft) => controller.flush(threadId, draft.target.nodeId)));
      const unresolved = controller.draftsForThread(threadId).filter((draft) => (
        draft.status !== "saved" || draft.revision == null
      ));
      if (unresolved.length > 0) {
        throw new Error(
          `${unresolved.length} annotation ${unresolved.length === 1 ? "draft is" : "drafts are"} not saved yet. Retry before sending without drafts.`,
        );
      }
      return controller.draftsForThread(threadId);
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
          operation: { kind: "idle" },
        };
        draft.timer = schedule(() => controller.flush(threadId, target.nodeId));
        drafts.set(key, draft);
        changed();
      }
      return drafts.get(key);
    },
    update(threadId, nodeId, text) {
      const draft = controller.draftForNode(threadId, nodeId);
      if (!draft || isResolving(draft)) return null;
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
      if (!draft || (isResolving(draft) && !allowResolving)) return null;
      const parentOperation = isResolving(draft) && allowResolving ? draft.operation : null;
      const existingSave = currentSave(draft);
      if (existingSave) {
        await existingSave.catch(() => null);
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
      const saveOperation = { kind: "saving", promise: savePromise };
      draft.operation = parentOperation || saveOperation;
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
          const ownsOperation = current.operation === saveOperation;
          revisionConflict = conflict && allowReconcile && ownsOperation;
          if (ownsOperation) {
            current.operation = revisionConflict
              ? { kind: "reconciling" }
              : { kind: "idle" };
          }
          current.status = conflict
            ? (revisionConflict ? "saving" : "error")
            : (current.editVersion === savingVersion ? "error" : "unsaved");
          current.error = conflict
            ? (revisionConflict ? null : "This draft changed again while recovering. Retry save.")
            : (current.editVersion !== savingVersion ? null : error.message);
          changed();
        }
      } finally {
        const current = controller.draftForNode(threadId, nodeId);
        if (current?.operation === saveOperation) current.operation = { kind: "idle" };
      }
      if (revisionConflict) {
        try {
          await controller.load(threadId);
          const reconciled = controller.draftForNode(threadId, nodeId);
          return reconciled?.status === "unsaved"
            ? controller.flush(threadId, nodeId, {
              allowResolving,
              allowReconcile: false,
            })
            : reconciled;
        } catch (error) {
          const current = controller.draftForNode(threadId, nodeId);
          if (current) {
            current.status = "error";
            current.error = `Could not reload this changed draft: ${error.message}`;
            current.operation = { kind: "idle" };
            changed();
          }
        }
      }
      return null;
    },
    async confirm(threadId, nodeId, { allowReconcile = true } = {}) {
      let draft = controller.draftForNode(threadId, nodeId);
      if (!draft) return null;
      if (isResolving(draft)) return null;
      if (draft.status !== "saved") await controller.flush(threadId, nodeId);
      draft = controller.draftForNode(threadId, nodeId);
      if (!draft || isResolving(draft) || draft.status !== "saved" || draft.revision == null) {
        return null;
      }
      const confirmationPromise = api.confirm(threadId, { ...draft }).then((confirmation) => {
        threadDrafts(threadId).delete(nodeKey(nodeId));
        changed();
        return confirmation;
      });
      const confirmationOperation = { kind: "confirming", promise: confirmationPromise };
      draft.operation = confirmationOperation;
      changed();
      try {
        const confirmation = await confirmationPromise;
        if (!confirmation) {
          const unresolved = controller.draftForNode(threadId, nodeId);
          if (unresolved?.operation === confirmationOperation) unresolved.operation = { kind: "idle" };
          changed();
        }
        return confirmation;
      } catch (error) {
        const unresolved = controller.draftForNode(threadId, nodeId);
        if (unresolved?.operation === confirmationOperation) unresolved.operation = { kind: "idle" };
        changed();
        if (error.code === "context_draft_revision_conflict" && allowReconcile && unresolved) {
          const staleRevision = unresolved.revision;
          unresolved.operation = { kind: "reconciling" };
          await controller.load(threadId);
          let reconciled = controller.draftForNode(threadId, nodeId);
          if (!reconciled || reconciled.revision === staleRevision || reconciled.status === "error") {
            throw error;
          }
          if (reconciled.status === "unsaved") {
            await controller.flush(threadId, nodeId, { allowReconcile: false });
            reconciled = controller.draftForNode(threadId, nodeId);
          }
          if (reconciled?.status === "saved") {
            return controller.confirm(threadId, nodeId, { allowReconcile: false });
          }
        }
        throw error;
      }
    },
    async discard(threadId, nodeId, { allowReconcile = true } = {}) {
      let draft = controller.draftForNode(threadId, nodeId);
      if (!draft) return false;
      if (isResolving(draft)) return false;
      const pendingSave = currentSave(draft);
      const operation = { kind: "discarding" };
      draft.operation = operation;
      changed();
      try {
        if (draft.timer != null) cancel(draft.timer);
        draft.timer = null;
        let pendingSaveError = null;
        if (pendingSave) {
          await pendingSave.catch((error) => {
            pendingSaveError = error;
          });
        }
        draft = controller.draftForNode(threadId, nodeId);
        if (!draft) return true;
        if (pendingSaveError?.code === "context_draft_revision_conflict") {
          await controller.load(threadId);
          draft = controller.draftForNode(threadId, nodeId);
        }
        if (!draft) return true;
        if (draft?.revision == null && draft?.status === "error") {
          await controller.flush(threadId, nodeId, { allowResolving: true });
          draft = controller.draftForNode(threadId, nodeId);
        }
        if (!draft) return true;
        if (draft?.revision == null && draft?.status === "error") {
          throw new Error("The saved draft state is uncertain. Retry discard when persistence recovers.");
        }
        if (draft.revision != null) await api.discard(threadId, { ...draft });
        threadDrafts(threadId).delete(nodeKey(nodeId));
        changed();
        return true;
      } catch (error) {
        const unresolved = controller.draftForNode(threadId, nodeId);
        if (unresolved?.operation === operation) unresolved.operation = { kind: "idle" };
        changed();
        if (error.code === "context_draft_revision_conflict" && allowReconcile && unresolved) {
          const staleRevision = unresolved.revision;
          unresolved.operation = { kind: "reconciling" };
          await controller.load(threadId);
          const reconciled = controller.draftForNode(threadId, nodeId);
          if (reconciled && reconciled.revision !== staleRevision && reconciled.status !== "error") {
            return controller.discard(threadId, nodeId, { allowReconcile: false });
          }
        }
        throw error;
      }
    },
  };
  return controller;
}
