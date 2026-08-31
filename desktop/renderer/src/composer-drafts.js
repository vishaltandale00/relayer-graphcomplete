const STORAGE_KEY = "relayerComposerDraftsV1";
let desktopState = emptyState();
let desktopInitialized = false;

function emptyState() {
  return { pendingNewThread: null, threadFollowups: {} };
}

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readState() {
  if (window.relayerDesktop?.drafts && desktopInitialized) return structuredClone(desktopState);
  const target = storage();
  if (!target) return emptyState();
  try {
    const value = JSON.parse(target.getItem(STORAGE_KEY) || "null");
    if (!value || typeof value !== "object") return emptyState();
    return {
      pendingNewThread: value.pendingNewThread && typeof value.pendingNewThread === "object"
        ? value.pendingNewThread
        : null,
      threadFollowups: value.threadFollowups && typeof value.threadFollowups === "object"
        ? value.threadFollowups
        : {},
    };
  } catch {
    return emptyState();
  }
}

function writeState(value) {
  if (window.relayerDesktop?.drafts) {
    desktopState = structuredClone(value);
    void window.relayerDesktop.drafts.write(desktopState).catch(() => undefined);
    return;
  }
  const target = storage();
  if (!target) return;
  try {
    target.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Draft persistence is best-effort; the composer remains usable without storage.
  }
}

export async function initializeComposerDrafts() {
  if (!window.relayerDesktop?.drafts) return;
  try {
    const value = await window.relayerDesktop.drafts.read();
    desktopState = {
      pendingNewThread: value?.pendingNewThread ?? null,
      threadFollowups: value?.threadFollowups ?? {},
    };
  } finally {
    desktopInitialized = true;
  }
}

export function pendingNewThreadDraft() {
  const draft = readState().pendingNewThread;
  if (!draft || typeof draft.text !== "string") return null;
  return { text: draft.text, scope: draft.scope ?? null };
}

export function persistPendingNewThreadDraft(text, scope) {
  const state = readState();
  if (!text) state.pendingNewThread = null;
  else state.pendingNewThread = { text, scope };
  writeState(state);
}

export function clearPendingNewThreadDraft() {
  const state = readState();
  state.pendingNewThread = null;
  writeState(state);
}

export function threadFollowupDraft(scopeKey) {
  if (!scopeKey) return null;
  const value = readState().threadFollowups[scopeKey];
  return typeof value === "string" ? value : null;
}

export function persistThreadFollowupDraft(scopeKey, text, { preserveEmpty = false } = {}) {
  if (!scopeKey) return;
  const state = readState();
  if (text || preserveEmpty) state.threadFollowups[scopeKey] = text;
  else delete state.threadFollowups[scopeKey];
  writeState(state);
}

export function clearThreadFollowupDraft(scopeKey) {
  if (!scopeKey) return;
  const state = readState();
  delete state.threadFollowups[scopeKey];
  writeState(state);
}
