// PROTOTYPE - throwaway. Question: what should the public shared-thread page (#457) look like?
//
// Three variants of a stripped web shell around the UNMODIFIED ProductWorkspace component, switchable via
// ?variant=A|B|C on desktop/renderer/share-prototype.html (sub-shape B: the public page has no existing host).
//   A  Session replica    - looks like the desktop thread view with a thin public top bar.
//   B  Transcript + graph - article-style hero, a transcript column of turns, graph beside it, Node Details as a drawer.
//   C  Graph stage        - full-bleed graph, floating prompt card, Node Details as a slide-over, minimal chrome.
//
// Data: two real threads copied from a local product DB (snapshot.js), root layers only. "Expand" navigation into a
// nested layer is stubbed with a toast because the local graph store had none.
//
// Production (#457) swaps desktop/renderer/src/api.js for a snapshot-backed module. This prototype drives
// createProductWorkspace directly instead, because threads.js also owns sidebar/settings rendering that a public
// page must not load. Everything the workspace needs is the appState/selection shape below.

import { createProductWorkspace } from "../product-workspace/index.js";
import { layerPathForVisibleLayer, workspaceTurns } from "../product-workspace/model.js";
import { toast } from "../ui.js";
import { SNAPSHOTS } from "./snapshot.js";

const VARIANTS = [
  { key: "A", name: "Session replica" },
  { key: "S", name: "Sharer (desktop side)" },
  // B (transcript + graph) and C (graph stage) are still reachable via ?variant=B|C but are out of the cycle:
  // the session-replica base won on 2026-09-16.
];
const CTA_OPTIONS = {
  "1": { name: "Inline row", html: `<div class="share-inline-row"><span class="logo" aria-hidden="true"></span><b>Relayer</b><small>free · macOS &amp; Windows</small><a class="share-install" id="shareInstallCell" href="#">Download</a></div>` },
  "2": { name: "App card", html: `<div class="share-app-card"><span class="logo" aria-hidden="true"></span><div class="share-app-card-copy"><b>Relayer for Mac</b><small>Explore this thread, then build your own.</small></div><a class="share-install" id="shareInstallCell" href="#">Download</a></div><small class="share-app-card-alt">Also for Windows</small>` },
  "3": { name: "Quiet pill", html: `<small class="share-made-with">Made with Relayer</small><a class="share-install share-install-ghost" id="shareInstallCell" href="#"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Get the app</a>` },
};
// Locked in on 2026-09-17: app card (cta=2). Options 1 and 3 stay reachable via ?cta= for the record.
let cta = CTA_OPTIONS[new URLSearchParams(location.search).get("cta")] ? new URLSearchParams(location.search).get("cta") : "2";
const SHARE_OPTIONS = {
  "1": "Button + menu item",
  "2": "Menu item only",
  "3": "Icon button + menu item",
};
let shareOption = SHARE_OPTIONS[new URLSearchParams(location.search).get("share")] ? new URLSearchParams(location.search).get("share") : "1";
let signedIn = new URLSearchParams(location.search).get("signedIn") === "1";

const params = new URLSearchParams(location.search);
const threadKey = SNAPSHOTS[params.get("thread")] ? params.get("thread") : "1";
const snapshot = SNAPSHOTS[threadKey];
let variant = ["A", "B", "C", "S"].includes(params.get("variant")) ? params.get("variant") : "A";

const thread = { ...snapshot.thread, active: true };

const appState = {
  projects: [],
  threads: [thread],
  interactions: snapshot.interactions,
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
  currentThreadId: thread.id,
  currentInteractionId: null,
  mainView: "thread",
  selectedNodeId: null,
  layerPath: [],
  temporalCurrent: null,
  evalContext: null,
};

const $ = (selector) => document.querySelector(selector);
const turns = () => workspaceTurns(appState, thread);

function hydrate(interaction) {
  const layer = interaction?.completionOutput?.rootLayer ?? null;
  const sameTurn = String(selection.currentInteractionId) === String(interaction?.id);
  selection.layerPath = layerPathForVisibleLayer(sameTurn ? selection.layerPath : [], interaction, layer);
  if (!sameTurn) selection.selectedNodeId = null;
  selection.currentInteractionId = interaction?.id ?? null;
  selection.temporalCurrent = null;
  appState.currentInteractionId = interaction?.id ?? null;
  appState.status = interaction?.completionStatus || "idle";
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
  renderChrome();
}

function selectTurn(delta) {
  const list = turns();
  const index = list.findIndex((interaction) => String(interaction.id) === String(selection.currentInteractionId));
  const target = list[index + delta];
  if (target) selectTurnById(target.id);
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
  onSelectionChange: (nodeId) => {
    selection.selectedNodeId = nodeId;
    document.body.classList.toggle("share-node-open", nodeId != null);
  },
  onNavigateLayer: async () => {
    toast("Prototype snapshot has root layers only; nested layers would open here.");
    return false;
  },
  onNavigateResolvedInvoke: async () => false,
  onInvokeAction: async () => {
    toast("Read-only snapshot. Open in Relayer to continue this thread.");
  },
});

// ----- Public-page chrome (outside the workspace component) -----

function formatDate(value) {
  const number = Number(value);
  const date = new Date(Number.isFinite(number) ? number : value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function metaLine() {
  const list = turns();
  const first = list[0];
  const parts = [
    snapshot.projectName ? `Project ${snapshot.projectName}` : "No folder",
    `${list.length} ${list.length === 1 ? "turn" : "turns"}`,
    first?.modelSelection?.modelId ? `Model ${first.modelSelection.modelId}` : null,
    thread.harnessConfigurationName ? `Harness ${thread.harnessConfigurationName}` : null,
    formatDate(thread.createdAt),
  ].filter(Boolean);
  return parts.join(" · ");
}

function renderTranscript() {
  const host = $("#shareTranscript");
  host.replaceChildren();
  for (const [index, interaction] of turns().entries()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "share-turn";
    button.classList.toggle("active", String(interaction.id) === String(selection.currentInteractionId));
    button.dataset.interactionId = interaction.id;
    const nodeCount = interaction.completionOutput?.rootLayer?.nodes?.length ?? 0;
    button.innerHTML = `<small>Turn ${index + 1}</small><p></p><span>${nodeCount} nodes · ${interaction.completionStatus}</span>`;
    button.querySelector("p").textContent = interaction.text;
    button.addEventListener("click", () => selectTurnById(interaction.id));
    host.append(button);
  }
}

function renderChrome() {
  document.body.dataset.variant = variant;
  document.body.dataset.share = shareOption;
  $("#shareTopbarTitle").textContent = thread.title;
  $("#shareHeroTitle").textContent = thread.title;
  $("#shareHeroMeta").textContent = metaLine();
  renderTranscript();
  const entry = VARIANTS.find((item) => item.key === variant) || { key: variant, name: "retired variant" };
  $("#protoLabel").textContent = `${entry.key} · ${entry.name}`;
  document.title = `${thread.title} · Relayer (prototype ${variant})`;
}

function setVariant(next) {
  variant = next;
  const url = new URL(location.href);
  url.searchParams.set("variant", variant);
  history.replaceState(null, "", url);
  renderChrome();
  // The graph camera fits to the stage size; nudge it after the shell re-lays out.
  requestAnimationFrame(() => {
    window.dispatchEvent(new Event("resize"));
    $("#fitGraph")?.click();
  });
}

function cycle(delta) {
  const index = Math.max(0, VARIANTS.findIndex((entry) => entry.key === variant));
  setVariant(VARIANTS[(index + delta + VARIANTS.length) % VARIANTS.length].key);
}

$("#protoPrev").addEventListener("click", () => cycle(-1));
$("#protoNext").addEventListener("click", () => cycle(1));
document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (target instanceof HTMLElement && (target.matches("input, textarea, select") || target.isContentEditable)) return;
  if (event.key === "ArrowLeft") cycle(-1);
  if (event.key === "ArrowRight") cycle(1);
});
$("#protoThread").value = threadKey;
$("#protoThread").addEventListener("change", (event) => {
  const url = new URL(location.href);
  url.searchParams.set("thread", event.target.value);
  location.href = url;
});
$("#protoTheme").value = document.documentElement.dataset.theme || "dark";
$("#protoTheme").addEventListener("change", (event) => {
  document.documentElement.dataset.theme = event.target.value;
  localStorage.setItem("relayerAppearance", event.target.value);
});
// Variant A: the download CTA lives in the empty grid cell above Node Details (column 2, rows 1-2).
const ctaCell = document.createElement("div");
ctaCell.className = "share-cta-cell";
ctaCell.id = "shareCtaCell";
$("#shareWorkspaceHost .workspace-layout").append(ctaCell);
const installToast = (event) => {
  event.preventDefault();
  toast("Install CTA: would open app.relayerlabs.ai/desktop/login (#458).");
};
function renderCta() {
  ctaCell.dataset.cta = cta;
  ctaCell.innerHTML = CTA_OPTIONS[cta].html;
  ctaCell.querySelector("#shareInstallCell").addEventListener("click", installToast);
  $("#protoCta").value = cta;
}
for (const id of ["#shareInstall", "#shareFooterInstall"]) $(id).addEventListener("click", installToast);
$("#protoCta").addEventListener("change", (event) => {
  cta = event.target.value;
  const url = new URL(location.href);
  url.searchParams.set("cta", cta);
  history.replaceState(null, "", url);
  renderCta();
});
renderCta();

// ----- Variant S: the sharer's side (Relayer Desktop). Share control + dialog flow. -----
const titleGroup = $("#shareWorkspaceHost .thread-title-group");
const sharerControls = document.createElement("div");
sharerControls.className = "sharer-controls";
sharerControls.innerHTML = `
  <button type="button" class="sharer-share-button" id="sharerShare" title="Share" aria-label="Share"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg><span class="sharer-share-label">Share</span></button>
  <div class="sharer-menu-wrap">
    <button type="button" class="conversation-settings-button sharer-menu-button" id="sharerMenuButton" aria-haspopup="menu" aria-expanded="false" title="Conversation settings">•••</button>
    <div class="conversation-settings-menu sharer-menu hidden" id="sharerMenu" role="menu">
      <button type="button" role="menuitem" id="sharerMenuShare">Share…</button>
      <button type="button" role="menuitem">Export conversation…</button>
      <button type="button" role="menuitem" disabled>Shared links (0)</button>
    </div>
  </div>`;
titleGroup.append(sharerControls);

const dialog = document.createElement("div");
dialog.className = "sharer-dialog-backdrop hidden";
dialog.id = "sharerDialog";
document.body.append(dialog);
let shareStep = "idle";
const fakeLink = "https://share.relayerlabs.ai/t/8f3c1a9e2b7d4c6e";
function renderShareDialog() {
  dialog.classList.toggle("hidden", shareStep === "idle");
  if (shareStep === "idle") return;
  const steps = {
    signin: `
      <h3>Share this thread</h3>
      <p class="sharer-dialog-note">Anyone with the link can view a read-only copy.</p>
      <div class="sharer-dialog-actions"><button type="button" class="secondary" data-act="cancel">Cancel</button><button type="button" class="primary" data-act="signin">Sign in to share</button></div>`,
    working: `
      <h3>Creating link…</h3>
      <div class="sharer-progress"><span></span></div>`,
    ready: `
      <h3>Link ready</h3>
      <div class="sharer-link-row"><input type="text" readonly value="${fakeLink}" aria-label="Share link" /><button type="button" class="primary" data-act="copy">Copy</button></div>
      <p class="sharer-dialog-note">Read-only snapshot · known secrets and paths removed</p>
      <div class="sharer-dialog-actions"><button type="button" class="secondary" data-act="manage">Shared links</button><button type="button" class="primary" data-act="close">Done</button></div>`,
  };
  dialog.innerHTML = `<div class="sharer-dialog" role="dialog" aria-modal="true">${steps[shareStep]}</div>`;
}
function startShare() {
  closeSharerMenu();
  shareStep = signedIn ? "working" : "signin";
  renderShareDialog();
  if (shareStep === "working") setTimeout(() => { shareStep = "ready"; renderShareDialog(); }, 1400);
}
dialog.addEventListener("click", (event) => {
  const action = event.target.closest("[data-act]")?.dataset.act;
  if (!action && event.target === dialog) { shareStep = "idle"; renderShareDialog(); return; }
  if (action === "cancel" || action === "close") { shareStep = "idle"; renderShareDialog(); }
  if (action === "signin") {
    signedIn = true;
    $("#protoSignedIn").checked = true;
    toast("Browser sign-in (Auth0) would open here and return to Relayer.");
    shareStep = "working"; renderShareDialog();
    setTimeout(() => { shareStep = "ready"; renderShareDialog(); }, 1400);
  }
  if (action === "copy") { toast("Link copied."); }
  if (action === "open") { toast("Would open the public page in the browser (variant A/B/C)."); }
  if (action === "manage") { toast("Would open Settings › Shared links (list + delete)."); }
});
function closeSharerMenu() {
  $("#sharerMenu").classList.add("hidden");
  $("#sharerMenuButton").setAttribute("aria-expanded", "false");
}
$("#sharerShare").addEventListener("click", startShare);
$("#sharerMenuShare").addEventListener("click", startShare);
$("#sharerMenuButton").addEventListener("click", () => {
  const open = $("#sharerMenu").classList.toggle("hidden");
  $("#sharerMenuButton").setAttribute("aria-expanded", String(!open));
});
$("#protoShare").value = shareOption;
$("#protoShare").addEventListener("change", (event) => {
  shareOption = event.target.value;
  const url = new URL(location.href);
  url.searchParams.set("share", shareOption);
  history.replaceState(null, "", url);
  renderChrome();
});
$("#protoSignedIn").checked = signedIn;
$("#protoSignedIn").addEventListener("change", (event) => { signedIn = event.target.checked; });

hydrate(turns()[0]);
workspace.render();
renderChrome();
requestAnimationFrame(() => $("#fitGraph")?.click());
