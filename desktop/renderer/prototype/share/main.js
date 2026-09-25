// PROTOTYPE - throwaway. Question: does the finalized title -> publish -> copy/open
// -> read-only graph journey feel right when driven against a real export, including
// sign-in, active work, failures, retry identity, quota, and oversize boundaries?
//
// Real seams: conversation-export v1 data, the production ProductWorkspace, nested
// graph navigation, and Node Details. Local fakes: Auth0, share service/storage,
// metrics, and Sentry. Nothing here is production implementation or deployment proof.

import { createProductWorkspace } from "../../src/product-workspace/index.js";
import {
  appendLayerPath,
  layerPathForVisibleLayer,
  workspaceTurns,
} from "../../src/product-workspace/model.js";
import { parseConversationExport, scenarioInteractions } from "./snapshot.js";

const $ = (selector) => document.querySelector(selector);
const params = new URLSearchParams(location.search);
const mode = params.get("mode") === "viewer" ? "viewer" : "desktop";
const scenarios = new Set([
  "success",
  "active-response",
  "no-accepted",
  "publish-failure",
  "lost-response",
  "account-change",
  "quota",
  "oversize",
]);
let scenario = scenarios.has(params.get("scenario")) ? params.get("scenario") : "success";
let toastTimer;

document.body.dataset.mode = mode;

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.add("hidden"), 2600);
}

function compactId(value) {
  return value ? String(value).split("-").at(-1).slice(-8).toUpperCase() : "—";
}

function newIdentity(prefix) {
  const raw = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `${prefix}-${raw}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function shareLinkFor(state) {
  const url = new URL("/share-prototype.html", location.origin);
  url.searchParams.set("mode", "viewer");
  url.searchParams.set("id", state.shareId);
  return url.href;
}

function acceptedInteractions(interactions) {
  return interactions.filter((interaction) => (
    interaction.completionStatus === "accepted" && interaction.completionOutput?.rootLayer
  ));
}

function shareEligible() {
  return thread?.imported !== true && acceptedInteractions(appState.interactions).length > 0;
}

function initialShareState({ signedIn = false } = {}) {
  return {
    phase: "closed",
    signedIn,
    title: "",
    attemptId: null,
    referenceId: null,
    shareId: null,
    attemptNumber: 0,
    frozenTitle: null,
    frozenTurns: null,
    frozenSourceJsonl: null,
    link: null,
    errorKind: null,
    preflightError: null,
  };
}

function shareReducer(state, action) {
  switch (action.type) {
    case "SET_SIGNED_IN":
      return !action.value && state.phase !== "closed"
        ? { ...state, signedIn: false, phase: "error", errorKind: "account-change" }
        : { ...state, signedIn: action.value };
    case "START":
      if (!action.eligible) return state;
      return {
        ...state,
        phase: state.signedIn
          ? (action.preflightError ? "error" : "title")
          : "signin",
        errorKind: state.signedIn ? action.preflightError : null,
        preflightError: action.preflightError,
        referenceId: action.preflightError === "oversize"
          ? (state.referenceId ?? action.referenceId)
          : state.referenceId,
      };
    case "SIGN_IN":
      return {
        ...state,
        signedIn: true,
        phase: state.preflightError ? "error" : "title",
        errorKind: state.preflightError,
      };
    case "SET_TITLE":
      return { ...state, title: action.value.slice(0, 120) };
    case "CREATE": {
      if (!state.title.trim()) return state;
      const attemptId = state.attemptId ?? newIdentity("attempt");
      const shareId = state.shareId ?? newIdentity("share");
      return {
        ...state,
        phase: "creating",
        attemptId,
        referenceId: state.referenceId ?? `SHR-${compactId(attemptId)}`,
        shareId,
        attemptNumber: state.attemptNumber + 1,
        frozenTitle: state.frozenTitle ?? state.title,
        frozenTurns: state.frozenTurns ?? action.acceptedTurnCount,
        frozenSourceJsonl: state.frozenSourceJsonl ?? action.sourceJsonl,
        link: state.link ?? shareLinkFor({ shareId, frozenTitle: state.frozenTitle ?? state.title }),
        errorKind: null,
      };
    }
    case "RESULT":
      return action.outcome === "success"
        ? { ...state, phase: "ready", errorKind: null }
        : { ...state, phase: "error", errorKind: action.outcome };
    case "RETRY":
      return {
        ...state,
        phase: "creating",
        attemptNumber: state.attemptNumber + 1,
        errorKind: null,
      };
    case "RESTORE_ACCOUNT":
      return state.attemptId
        ? {
          ...state,
          signedIn: true,
          phase: "creating",
          attemptNumber: state.attemptNumber + 1,
          errorKind: null,
        }
        : { ...state, signedIn: true, phase: "title", errorKind: null };
    case "DISMISS":
      return initialShareState({ signedIn: state.signedIn });
    default:
      return state;
  }
}

function outcomeFor(currentScenario, attemptNumber) {
  if (currentScenario === "publish-failure" && attemptNumber === 1) return "publish-failure";
  if (currentScenario === "lost-response" && attemptNumber === 1) return "lost-response";
  if (currentScenario === "account-change" && attemptNumber === 1) return "account-change";
  if (currentScenario === "quota") return "quota";
  if (currentScenario === "oversize") return "oversize";
  return "success";
}

function preflightErrorFor(currentScenario) {
  return currentScenario === "quota" || currentScenario === "oversize"
    ? currentScenario
    : null;
}

let snapshot;
let thread;
let sourceJsonl;
let shareState = initialShareState({ signedIn: params.get("signedIn") === "1" });
let resultTimer;
let dialogReturnFocus = null;

const appState = {
  projects: [],
  threads: [],
  interactions: [],
  actionInvocations: [],
  pendingActionInvocations: [],
  approvals: [],
  inputDraftRevision: null,
  pendingApprovalDecisions: [],
  permissionProfiles: [],
  defaultPermissionProfileId: null,
  modelSettings: null,
  capabilities: { annotations: false },
  currentInteractionId: null,
  nodes: [],
  edges: [],
  actions: [],
  visibleLayer: null,
  status: "idle",
  environment: null,
  currentProjectionCursor: 0,
  currentProjections: new Map(),
  temporalSafeReason: null,
  temporalLifecycle: null,
};

const selection = {
  selectedScope: { kind: "standalone", label: "No folder" },
  selectedPermissionProfileId: null,
  currentThreadId: null,
  currentInteractionId: null,
  mainView: "thread",
  selectedNodeId: null,
  layerPath: [],
  temporalCurrent: null,
  evalContext: null,
};

function turns() {
  return workspaceTurns(appState, thread);
}

function hydrate(interaction, layer = interaction?.completionOutput?.rootLayer ?? null, layerPath = null) {
  const sameTurn = String(selection.currentInteractionId) === String(interaction?.id);
  selection.layerPath = layerPath ?? layerPathForVisibleLayer(
    sameTurn ? selection.layerPath : [],
    interaction,
    layer,
  );
  if (!sameTurn) selection.selectedNodeId = null;
  selection.currentThreadId = thread?.id ?? null;
  selection.currentInteractionId = interaction?.id ?? null;
  selection.temporalCurrent = null;
  appState.currentInteractionId = interaction?.id ?? null;
  appState.status = interaction?.completionStatus ?? "idle";
  appState.visibleLayer = layer;
  appState.nodes = layer?.nodes ? [...layer.nodes] : [];
  appState.edges = layer?.edges ? [...layer.edges] : [];
  appState.actions = layer?.actions ? [...layer.actions] : [];
}

function selectTurnById(interactionId) {
  const target = turns().find((interaction) => String(interaction.id) === String(interactionId));
  if (!target || String(target.id) === String(selection.currentInteractionId)) return;
  hydrate(target);
  workspace.render();
  installPublisherControls();
  installViewerCta();
}

function selectTurn(delta) {
  const list = turns();
  const index = list.findIndex((interaction) => String(interaction.id) === String(selection.currentInteractionId));
  const target = list[index + delta];
  if (target) selectTurnById(target.id);
}

async function navigateLayer(layerId, navigation = {}) {
  const interaction = turns().find((candidate) => String(candidate.id) === String(selection.currentInteractionId));
  const layer = snapshot.layerFor(interaction?.id, layerId);
  if (!interaction || !layer) return false;
  const layerPath = navigation.restore
    ? selection.layerPath.slice(0, navigation.pathIndex + 1)
    : appendLayerPath(selection.layerPath, navigation.action, navigation.sourceNode);
  selection.selectedNodeId = null;
  hydrate(interaction, layer, layerPath);
  navigation.beforeCommit?.();
  workspace.render();
  installPublisherControls();
  installViewerCta();
  return true;
}

async function navigateResolvedInvoke(action, { beforeCommit } = {}) {
  const sourceTurn = snapshot.turnContainingLayer(action?.targetLayerId);
  const interaction = turns().find((candidate) => String(candidate.id) === String(sourceTurn?.id));
  const layer = snapshot.layerFor(sourceTurn?.id, action?.targetLayerId);
  if (!interaction || !layer) return false;
  selection.selectedNodeId = null;
  hydrate(interaction, layer);
  beforeCommit?.();
  workspace.render();
  installPublisherControls();
  installViewerCta();
  return true;
}

const workspace = createProductWorkspace({
  root: $("#shareWorkspaceHost"),
  mode: "review",
  getState: () => appState,
  getThread: () => thread,
  selection,
  showThread: () => {},
  showEmpty: () => {},
  getNavigationHistory: () => ({ canGoBack: false, canGoForward: false }),
  onSelectTurn: selectTurn,
  onSelectTurnById: selectTurnById,
  onSelectionChange: (nodeId) => { selection.selectedNodeId = nodeId; },
  onNavigateLayer: navigateLayer,
  onNavigateResolvedInvoke: navigateResolvedInvoke,
  onInvokeAction: async () => toast("This shared snapshot is read-only."),
});

function updateUrlScenario() {
  if (mode !== "desktop") return;
  const url = new URL(location.href);
  url.searchParams.set("scenario", scenario);
  if (shareState.signedIn) url.searchParams.set("signedIn", "1");
  else url.searchParams.delete("signedIn");
  history.replaceState(null, "", url);
}

function renderPrototypeState() {
  const acceptedCount = acceptedInteractions(appState.interactions).length;
  const values = {
    mode,
    scenario,
    signedIn: shareState.signedIn,
    eligible: shareEligible(),
    phase: shareState.phase,
    attempt: shareState.attemptId ? compactId(shareState.attemptId) : "—",
    "frozen turns": shareState.frozenTurns ?? "—",
    "active turns": appState.interactions.filter((item) => item.completionStatus !== "accepted").length,
    result: shareState.errorKind ?? (shareState.phase === "ready" ? "link ready" : "—"),
  };
  $("#prototypeState").innerHTML = Object.entries(values)
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("");
}

function dispatchShare(action) {
  shareState = shareReducer(shareState, action);
  renderShareDialog();
  updateShareControls();
  renderPrototypeState();
  updateUrlScenario();
  clearTimeout(resultTimer);
  if (shareState.phase === "creating") {
    resultTimer = setTimeout(() => void settlePublish(), 850);
  }
}

async function storeFrozenShare() {
  const response = await fetch("/__prototype/shares", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      attemptId: shareState.attemptId,
      shareId: shareState.shareId,
      title: shareState.frozenTitle,
      sourceJsonl: shareState.frozenSourceJsonl,
    }),
  });
  if (!response.ok) throw new Error(await response.text());
  const result = await response.json();
  if (result.shareId !== shareState.shareId || result.title !== shareState.frozenTitle) {
    throw new Error("Local fake service returned a different immutable share identity.");
  }
}

async function settlePublish() {
  const outcome = outcomeFor(scenario, shareState.attemptNumber);
  try {
    if (outcome === "account-change") {
      shareState = shareReducer(shareState, { type: "SET_SIGNED_IN", value: false });
      $("#prototypeSignedIn").checked = false;
      renderShareDialog();
      updateShareControls();
      renderPrototypeState();
      updateUrlScenario();
      return;
    }
    if (outcome === "success" || outcome === "lost-response") await storeFrozenShare();
    dispatchShare({ type: "RESULT", outcome });
  } catch (error) {
    console.error("Local fake share service failed:", error);
    dispatchShare({ type: "RESULT", outcome: "publish-failure" });
  }
}

function errorCopy(kind) {
  const nextUtcMidnight = new Date();
  nextUtcMidnight.setUTCHours(24, 0, 0, 0);
  if (kind === "quota") return {
    title: "Daily share limit reached",
    body: `You can create more shared links after ${nextUtcMidnight.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}.`,
    reference: false,
  };
  if (kind === "account-change") return {
    title: "Sign in to continue",
    body: "This publishing attempt belongs to the account that started it. Sign in to that account to continue.",
    reference: false,
  };
  return {
    title: "We couldn’t create the link",
    body: "Try again. If the problem continues, share the reference below with support.",
    reference: true,
  };
}

function setBackgroundInert(inert) {
  for (const selector of [".prototype-banner", ".share-topbar", ".share-body", ".share-footer"]) {
    const element = $(selector);
    if (element) element.inert = inert;
  }
}

function focusDialog(selector) {
  queueMicrotask(() => $("#sharerDialog")?.querySelector(selector)?.focus());
}

function renderShareDialog({ refocus = false } = {}) {
  const dialog = $("#sharerDialog");
  dialog.classList.toggle("hidden", shareState.phase === "closed");
  setBackgroundInert(shareState.phase !== "closed");
  if (shareState.phase === "closed") {
    dialog.replaceChildren();
    if (dialogReturnFocus?.isConnected) dialogReturnFocus.focus();
    dialogReturnFocus = null;
    return;
  }

  if (shareState.phase === "signin") {
    dialog.innerHTML = `<section class="sharer-dialog" role="dialog" aria-modal="true" aria-labelledby="shareDialogTitle" tabindex="-1">
      <h2 id="shareDialogTitle">Share this thread</h2>
      <p>Anyone with the link can view a frozen, read-only copy.</p>
      <p class="sharer-dialog-note">Sign in first. Signing in will not publish anything.</p>
      <div class="sharer-dialog-actions"><button data-act="cancel" type="button">Cancel</button><button class="primary" data-act="signin" type="button">Sign in to share</button></div>
    </section>`;
    focusDialog('[data-act="signin"]');
    return;
  }

  if (shareState.phase === "title") {
    const blank = !shareState.title.trim();
    dialog.innerHTML = `<section class="sharer-dialog" role="dialog" aria-modal="true" aria-labelledby="shareDialogTitle" tabindex="-1">
      <h2 id="shareDialogTitle">Share this thread</h2>
      <p>Choose the title people will see. Your local thread title will not change.</p>
      <label>Share title
        <input class="sharer-title-input" id="shareTitle" type="text" maxlength="120" autocomplete="off" value="${escapeHtml(shareState.title)}" />
      </label>
      <div class="sharer-title-meta"><span class="${blank && shareState.title.length ? "sharer-title-error" : ""}">${blank && shareState.title.length ? "Enter non-whitespace text" : "Required"}</span><span>${shareState.title.length}/120</span></div>
      <p class="sharer-dialog-note">Create link freezes the ${acceptedInteractions(appState.interactions).length} accepted turns available now. Known secrets and private paths are removed; review other sensitive content yourself.</p>
      <div class="sharer-dialog-actions"><button data-act="cancel" type="button">Cancel</button><button class="primary" data-act="create" type="button" ${blank ? "disabled" : ""}>Create link</button></div>
    </section>`;
    focusDialog("#shareTitle");
    if (refocus) queueMicrotask(() => {
      const input = $("#shareTitle");
      input?.setSelectionRange(input.value.length, input.value.length);
    });
    return;
  }

  if (shareState.phase === "creating") {
    dialog.innerHTML = `<section class="sharer-dialog" role="dialog" aria-modal="true" aria-labelledby="shareDialogTitle" tabindex="-1">
      <h2 id="shareDialogTitle">Creating link…</h2>
      <p>Freezing ${shareState.frozenTurns} accepted turns and publishing the read-only snapshot.</p>
      <div class="sharer-progress" aria-label="Creating link"><span></span></div>
      <p class="sharer-dialog-note">Attempt ${escapeHtml(compactId(shareState.attemptId))} · this step cannot be cancelled</p>
    </section>`;
    focusDialog(".sharer-dialog");
    return;
  }

  if (shareState.phase === "ready") {
    dialog.innerHTML = `<section class="sharer-dialog" role="dialog" aria-modal="true" aria-labelledby="shareDialogTitle" tabindex="-1">
      <div class="sharer-dialog-header"><h2 id="shareDialogTitle">Link ready</h2><button class="sharer-close" data-act="close-ready" type="button" aria-label="Close">×</button></div>
      <p>${shareState.frozenTurns} accepted turns were frozen with the title “${escapeHtml(shareState.frozenTitle)}”.</p>
      <div class="sharer-link-row"><input type="text" readonly value="${escapeHtml(shareState.link)}" aria-label="Share link" /><button class="primary" data-act="copy" type="button">Copy</button></div>
      <p class="sharer-dialog-note">Read-only snapshot · known secrets and paths removed</p>
    </section>`;
    focusDialog('[data-act="copy"]');
    return;
  }

  const copy = errorCopy(shareState.errorKind);
  const retry = shareState.errorKind === "quota" || shareState.errorKind === "oversize"
    ? ""
    : shareState.errorKind === "account-change"
      ? '<button class="primary" data-act="restore-account" type="button">Sign in to original account</button>'
      : '<button class="primary" data-act="retry" type="button">Retry</button>';
  dialog.innerHTML = `<section class="sharer-dialog" role="dialog" aria-modal="true" aria-labelledby="shareDialogTitle" tabindex="-1">
    <h2 id="shareDialogTitle">${escapeHtml(copy.title)}</h2>
    <p>${escapeHtml(copy.body)}</p>
    ${copy.reference ? `<p class="sharer-dialog-note">Reference <span class="sharer-reference">${escapeHtml(shareState.referenceId)}</span></p>` : ""}
    <div class="sharer-dialog-actions"><button data-act="close-error" type="button">Close</button>${retry}</div>
  </section>`;
  focusDialog(".sharer-dialog-actions button:last-child");
}

function startShare() {
  closeShareMenu();
  dialogReturnFocus = document.activeElement;
  const preflightError = preflightErrorFor(scenario);
  dispatchShare({
    type: "START",
    eligible: shareEligible(),
    preflightError,
    referenceId: preflightError === "oversize"
      ? `SHR-${compactId(newIdentity("attempt"))}`
      : null,
  });
}

function closeShareMenu() {
  $("#sharerMenu")?.classList.add("hidden");
  $("#sharerMenuButton")?.setAttribute("aria-expanded", "false");
}

function installDesktopHistoryNavigation() {
  for (const direction of ["Back", "Forward"]) {
    const source = $(`#shareWorkspaceHost #history${direction}`);
    const proxy = $(`#prototypeHistory${direction}`);
    if (!source || !proxy) continue;
    proxy.disabled = source.disabled;
    proxy.innerHTML = source.innerHTML;
    proxy.className = source.className;
    if (proxy.dataset.wired) continue;
    proxy.dataset.wired = "true";
    proxy.addEventListener("click", () => {
      $(`#shareWorkspaceHost #history${direction}`)?.click();
    });
  }
}

function installPublisherControls() {
  if (mode !== "desktop") return;
  installDesktopHistoryNavigation();
  const titleGroup = $("#shareWorkspaceHost .thread-title-group");
  if (!titleGroup || $("#sharerControls")) {
    updateShareControls();
    return;
  }
  const controls = document.createElement("div");
  controls.className = "sharer-controls";
  controls.id = "sharerControls";
  controls.innerHTML = `
    <div class="sharer-menu-wrap">
      <button type="button" class="conversation-settings-button" id="sharerMenuButton" aria-haspopup="menu" aria-expanded="false" title="Conversation settings">•••</button>
      <div class="sharer-menu hidden" id="sharerMenu" role="menu">
        <button type="button" role="menuitem" id="sharerMenuShare">Share…</button>
        <button type="button" role="menuitem">Export conversation…</button>
        <button type="button" role="menuitem" disabled>Shared links (0)</button>
      </div>
    </div>
    <button type="button" class="sharer-share-button" id="sharerShare" title="Share" aria-label="Share">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
      <span>Share</span>
    </button>`;
  titleGroup.append(controls);
  $("#sharerShare").addEventListener("click", startShare);
  $("#sharerMenuShare").addEventListener("click", startShare);
  $("#sharerMenuButton").addEventListener("click", () => {
    const menu = $("#sharerMenu");
    const hidden = menu.classList.toggle("hidden");
    $("#sharerMenuButton").setAttribute("aria-expanded", String(!hidden));
  });
  updateShareControls();
}

function installViewerCta() {
  if (mode !== "viewer" || $("#shareViewerCta")) return;
  const layout = $("#shareWorkspaceHost .workspace-layout");
  if (!layout) return;
  const cell = document.createElement("aside");
  cell.className = "share-cta-cell";
  cell.id = "shareViewerCta";
  cell.innerHTML = `<div class="share-app-card">
    <span class="logo" aria-hidden="true"></span>
    <div><strong>Relayer for Mac</strong><small>Explore this thread, then build your own.</small></div>
    <a class="share-install" href="#">Download</a>
  </div><small class="share-app-card-alt">Also for Windows</small>`;
  cell.querySelector("a").addEventListener("click", (event) => {
    event.preventDefault();
    toast("Install CTA preview; no download starts in this prototype.");
  });
  layout.append(cell);
}

function updateShareControls() {
  const eligible = shareEligible();
  for (const control of [$("#sharerShare"), $("#sharerMenuShare")].filter(Boolean)) {
    control.disabled = !eligible;
  }
}

function resetScenario(nextScenario = scenario) {
  clearTimeout(resultTimer);
  scenario = nextScenario;
  shareState = initialShareState({ signedIn: shareState.signedIn });
  appState.interactions = mode === "viewer"
    ? acceptedInteractions(snapshot.interactions)
    : scenarioInteractions(snapshot, scenario);
  const target = mode === "viewer" ? appState.interactions[0] : appState.interactions.at(-1);
  hydrate(target);
  workspace.render();
  installPublisherControls();
  installViewerCta();
  renderShareDialog();
  updateShareControls();
  renderPrototypeState();
  updateUrlScenario();
  requestAnimationFrame(() => $("#fitGraph")?.click());
}

$("#sharerDialog").addEventListener("input", (event) => {
  if (event.target.id === "shareTitle") {
    shareState = shareReducer(shareState, { type: "SET_TITLE", value: event.target.value });
    renderShareDialog({ refocus: true });
    renderPrototypeState();
  }
});

$("#sharerDialog").addEventListener("keydown", (event) => {
  if (event.key === "Escape" && shareState.phase !== "creating") {
    event.preventDefault();
    dispatchShare({ type: "DISMISS" });
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [...$("#sharerDialog").querySelectorAll(
    'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
  )];
  if (!focusable.length) {
    event.preventDefault();
    $("#sharerDialog .sharer-dialog")?.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

$("#sharerDialog").addEventListener("click", async (event) => {
  const action = event.target.closest("[data-act]")?.dataset.act;
  if (!action) return;
  if (action === "cancel" || action === "close-ready" || action === "close-error") dispatchShare({ type: "DISMISS" });
  if (action === "signin") {
    toast("Simulated Auth0 browser sign-in completed.");
    dispatchShare({ type: "SIGN_IN" });
    $("#prototypeSignedIn").checked = true;
  }
  if (action === "create") dispatchShare({
    type: "CREATE",
    acceptedTurnCount: acceptedInteractions(appState.interactions).length,
    sourceJsonl,
  });
  if (action === "retry") dispatchShare({ type: "RETRY" });
  if (action === "restore-account") {
    $("#prototypeSignedIn").checked = true;
    dispatchShare({ type: "RESTORE_ACCOUNT" });
  }
  if (action === "copy") {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(shareState.link);
      toast("Link copied.");
    } catch {
      toast("Copy failed. Select and copy the link manually.");
    }
  }
});

$("#prototypeScenario").addEventListener("change", (event) => resetScenario(event.target.value));
$("#prototypeSignedIn").addEventListener("change", (event) => {
  dispatchShare({ type: "SET_SIGNED_IN", value: event.target.checked });
});
$("#prototypeTheme").addEventListener("change", (event) => {
  document.documentElement.dataset.theme = event.target.value;
  localStorage.setItem("relayerAppearance", event.target.value);
});
$("#prototypeReset").addEventListener("click", () => resetScenario());
$("#shareInstall").addEventListener("click", (event) => {
  event.preventDefault();
  toast("Install CTA preview; no download starts in this prototype.");
});

async function start() {
  try {
    const shareId = params.get("id");
    if (mode === "viewer" && !shareId) throw new Error("Shared thread id is required.");
    const sourceUrl = mode === "viewer"
      ? `/__prototype/shares/${encodeURIComponent(shareId)}`
      : "/__prototype/export";
    const response = await fetch(sourceUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(await response.text());
    const source = mode === "viewer" ? await response.json() : { jsonl: await response.text() };
    sourceJsonl = source.jsonl;
    snapshot = parseConversationExport(source.jsonl);
    const shareTitle = source.title || snapshot.thread.title;
    thread = {
      ...snapshot.thread,
      title: mode === "viewer" ? shareTitle : snapshot.thread.title,
    };
    appState.threads = [thread];
    appState.projects = snapshot.projectName
      ? [{ id: thread.projectId, name: snapshot.projectName }]
      : [];
    selection.currentThreadId = thread.id;
    selection.selectedScope = snapshot.projectName
      ? { kind: "project", id: thread.projectId, label: snapshot.projectName }
      : { kind: "standalone", label: "No folder" };
    $("#prototypeScenario").value = scenario;
    $("#prototypeScenario").disabled = mode === "viewer";
    $("#prototypeSignedIn").checked = shareState.signedIn;
    $("#prototypeSignedIn").disabled = mode === "viewer";
    $("#prototypeTheme").value = document.documentElement.dataset.theme || "dark";
    $("#shareTopbarTitle").textContent = thread.title;
    $("#prototypeSidebarCurrent").textContent = thread.title;
    document.querySelector('meta[property="og:title"]').content = thread.title;
    document.querySelector('meta[property="og:description"]').content = snapshot.projectName
      ? `A frozen, read-only Relayer thread from ${snapshot.projectName}.`
      : "A frozen, read-only Relayer thread.";
    document.title = mode === "viewer"
      ? `${thread.title} · Relayer`
      : `${thread.title} · Share prototype`;
    resetScenario();
    $("#prototypeLoadState").classList.add("hidden");
  } catch (error) {
    if (mode === "viewer") {
      document.title = "Shared thread unavailable · Relayer";
      $("#prototypeLoadState").innerHTML = `<div class="prototype-viewer-error">
        <strong>This shared thread couldn’t be loaded</strong>
        <button type="button" id="reloadSharedThread">Reload</button>
      </div>`;
      $("#reloadSharedThread").addEventListener("click", () => location.reload());
    } else {
      $("#prototypeLoadState").textContent = "The local prototype export couldn’t be loaded. Check the server terminal and try again.";
      console.error(error);
    }
  }
}

void start();
