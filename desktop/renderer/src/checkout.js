import { createWorktreeController, checkoutSharingThreads } from "./worktree-controller.js";
import { appState, desktop, viewState, productApiAvailable } from "./state.js";
import { $, escapeHtml, escapeHtmlAttribute } from "./ui.js";
import { persistPendingNewThreadDraftDurably } from "./composer-drafts.js";
import { request } from "./api.js";

let availabilityChanged = () => {};
let scopeChanged = () => {};
let submitting = false;
const BASE_RESULT_LIMIT = 20;
// The current committed checkout and conventional default remain discoverable
// even when a repository has hundreds of generated branches.
function renderBaseOptions(inspection, choice, query = "") {
  const pinned = inspection.bases.filter(base => base.ref === "checkout"
    || base.ref === "refs/remotes/origin/main" || (base.ref || base.name) === choice.base);
  const needle = query.trim().toLocaleLowerCase();
  const matches = inspection.bases.filter(base => !pinned.includes(base)
    && base.name.toLocaleLowerCase().includes(needle));
  pinned.sort((a, b) => (a.ref === "refs/remotes/origin/main" ? -2 : a.ref === "checkout" ? -1 : 0) - (b.ref === "refs/remotes/origin/main" ? -2 : b.ref === "checkout" ? -1 : 0));
  const visible = [...pinned, ...matches.slice(0, BASE_RESULT_LIMIT)];
  const select = $("#worktreeBase");
  select.innerHTML = `<option value="">Choose a base…</option>` + visible.map(base =>
    `<option value="${escapeHtmlAttribute(base.ref || base.name)}">${escapeHtml(base.ref === "checkout" ? "Local checkout" : base.name)}${base.remote ? " · cached" : ""}</option>`).join("");
  select.value = choice.base || "";
  const list = $("#worktreeBaseList");
  list.innerHTML = visible.map(base => {
    const ref = base.ref || base.name;
    const checkout = inspection.worktrees.find(entry => entry.branch === base.name);
    const label = base.ref === "checkout" ? `Local · ${inspection.branch || "Detached HEAD"}` : base.name;
    return `<button type="button" role="option" aria-selected="${ref === choice.base}" data-base-ref="${escapeHtmlAttribute(ref)}"><span>${escapeHtml(label)}</span>${checkout ? `<small>${escapeHtml(checkout.path)}</small>` : ""}</button>`;
  }).join("");
  list.querySelectorAll("[data-base-ref]").forEach(item => {
    item.onclick = () => { select.value = item.dataset.baseRef; select.dispatchEvent(new Event("change", { bubbles: true })); };
  });
  $("#worktreeBaseResults").textContent = matches.length > BASE_RESULT_LIMIT
    ? `Showing ${BASE_RESULT_LIMIT} of ${matches.length} matching branches. Search to narrow the list.`
    : "";
}
const activeStatuses = new Set(["not_started", "preparing", "running", "submitted", "waiting_for_approval"]);
async function refreshSharedCheckout(scope) {
  if (!productApiAvailable || !scope.path) return;
  const checkoutRoot = scope.checkoutRoot;
  const newWorktree = scope.checkout?.newWorktree;
  const results = await Promise.allSettled(checkoutSharingThreads(appState.threads, scope)
    .map((thread) => request(`/api/threads/${encodeURIComponent(thread.id)}`)));
  const state = checkoutController.state;
  if (state?.scope !== scope || scope.checkoutRoot !== checkoutRoot || scope.checkout?.newWorktree !== newWorktree) return;
  state.sharedActive = results.some((result) => result.status === "fulfilled"
    && result.value.interactions?.some((interaction) => activeStatuses.has(interaction.completionStatus)));
  renderCheckout();
}
export const checkoutController = createWorktreeController({
  service: desktop?.worktrees,
  changed: () => { renderCheckout(); scopeChanged(); availabilityChanged(); },
  persist: (scope) => scope ? persistPendingNewThreadDraftDurably($("#newThreadPrompt")?.value || "", scope) : undefined,
});
export const checkoutSelectionLocked = () => submitting || checkoutController.busy;
export function setCheckoutSubmitting(value) {
  submitting = value;
  if ($("#scopeButton")) $("#scopeButton").disabled = value;
  renderCheckout();
}
export async function selectCheckoutScope(scope) {
  const selected = await checkoutController.select(scope);
  if (selected) void refreshSharedCheckout(scope);
  if (selected && scope.git && productApiAvailable) {
    try {
      const result = await request("/api/projects/consolidate", { method: "POST" });
      // Preserve draft identity; grouping aliases are display-only.
      appState.projects = result.projects;
      scopeChanged();
    } catch (error) {
      const state = checkoutController.state;
      if (state?.scope === scope) { state.error = error; renderCheckout(); }
    }
  }
}
export function closeCheckoutMenu() {
  $("#worktreeBasePicker")?.classList.add("hidden");
  $("#worktreeBaseButton")?.setAttribute("aria-expanded", "false");
  $("#checkoutMenu")?.classList.add("hidden");
  $("#checkoutButton")?.setAttribute("aria-expanded", "false");
}
const safely = (operation) => async () => {
  try { await operation(); }
  catch (error) {
    if (checkoutController.state) checkoutController.state.error = error;
    renderCheckout();
  }
};
export function initializeCheckout({ onAvailabilityChanged, onScopeChanged }) {
  availabilityChanged = onAvailabilityChanged;
  scopeChanged = onScopeChanged;
  $("#checkoutButton").onclick = () => {
    const menu = $("#checkoutMenu");
    const open = menu.classList.contains("hidden");
    menu.classList.toggle("hidden", !open);
    $("#checkoutButton").setAttribute("aria-expanded", String(open));
    if (open) $("#scopeMenu")?.classList.add("hidden");
  };
  document.addEventListener("click", (event) => {
    if (!event.composedPath().includes($("#checkoutControl"))) closeCheckoutMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#checkoutMenu")?.classList.contains("hidden")) {
      closeCheckoutMenu(); $("#checkoutButton")?.focus();
    }
  });
}
export function renderCheckout() {
  const control = $("#checkoutControl");
  if (!control) return;
  const state = checkoutController.state;
  const visible = state && (state.status !== "ready" || state.inspection?.git);
  control.classList.toggle("hidden", !visible);
  const notice = $("#checkoutNotice");
  notice.classList.add("hidden");
  if (!visible) return;
  const loading = state.status === "loading";
  const pending = checkoutSelectionLocked();
  const button = $("#checkoutButton");
  button.disabled = loading || pending;
  button.setAttribute("aria-label", loading ? "Loading worktrees" : "Choose checkout");
  $("#checkoutLabel").textContent = loading ? "" : "Checkout";
  const status = $("#checkoutStatus");
  status.textContent = loading ? "" : "⌄";
  status.classList.toggle("checkout-spinner", loading);
  const { scope, inspection } = state;
  const menu = $("#checkoutMenu");
  if (state.status === "failed") {
    menu.innerHTML = '<button type="button" id="retryCheckout">Retry inspection</button>';
    $("#retryCheckout").onclick = safely(() => selectCheckoutScope(scope));
  } else if (inspection?.git) {
    const relative = scope.relativePath || "";
    const project = appState.projects.find((entry) => String(entry.id) === String(scope.projectId));
    const explicitSubfolder = scope.separateSubfolder || (relative && project?.path === scope.path);
    const items = inspection.worktrees.map((entry, index) => {
      const reason = entry.reason || (!entry.exists ? "Missing checkout" : !entry.accessible ? "Checkout unavailable" : "");
      const states = [entry.dirty ? "Uncommitted changes" : "", entry.detached ? "Detached HEAD" : "", entry.locked ? "Locked against removal" : "", reason].filter(Boolean);
      const label = entry.detached ? "Detached HEAD" : entry.branch || "Checkout";
      return `<button type="button" data-checkout-index="${index}" ${reason || pending ? "disabled" : ""}><span>${escapeHtml(label)}</span><small>${escapeHtml(entry.path)}</small>${states.length ? `<small>${escapeHtml(states.join(" · "))}</small>` : ""}</button>`;
    }).join("");
    const planned = scope.checkout?.newWorktree;
    const baseLabel = inspection.bases.find(base => (base.ref || base.name) === scope.checkout?.base);
    menu.innerHTML = `<div class="checkout-list" role="group" aria-label="Registered checkouts" tabindex="0">${items}</div><hr><div class="checkout-new-row"><label class="checkout-checkbox"><input type="checkbox" id="newWorktree" ${planned ? "checked" : ""} ${pending ? "disabled" : ""}>New worktree</label>${planned ? `<button type="button" id="worktreeBaseButton" aria-label="Choose base branch" aria-expanded="false" aria-controls="worktreeBasePicker" ${pending || scope.checkout.planId ? "disabled" : ""}><span>${escapeHtml(baseLabel?.ref === "checkout" ? `Local · ${inspection.branch || "Detached HEAD"}` : baseLabel?.name || "Choose base…")}</span><span aria-hidden="true">›</span></button>` : ""}</div>${planned ? `<div id="worktreeBasePicker" class="worktree-base-picker hidden"><input type="search" id="worktreeBaseSearch" aria-label="Search base branches" placeholder="Search branches…"><div id="worktreeBaseList" role="listbox" aria-label="Base branches"></div><select id="worktreeBase" hidden aria-hidden="true" tabindex="-1"></select><small id="worktreeBaseResults" role="status"></small></div>` : ""}${relative && !explicitSubfolder ? `<hr><button type="button" id="separateSubfolder" ${pending ? "disabled" : ""}>Save as separate project</button>` : ""}`;
    menu.querySelectorAll("[data-checkout-index]").forEach((item) => {
      item.onclick = safely(async () => { await checkoutController.pick(inspection.worktrees[Number(item.dataset.checkoutIndex)]); void refreshSharedCheckout(scope); closeCheckoutMenu(); $("#newThreadPrompt")?.focus(); });
    });
    const focusDraft = () => {
      // Re-rendering replaces the focused control. Restore a useful keyboard
      // destination so the next Enter reaches the existing Send handler.
      if (scope.checkout.newWorktree && !scope.checkout.base) $("#worktreeBaseButton")?.click();
      else { closeCheckoutMenu(); $("#newThreadPrompt")?.focus(); }
    };
    $("#newWorktree").onchange = safely(async () => {
      const saved = checkoutController.setNewWorktree($("#newWorktree").checked);
      // Keep the checkout menu visible so the base remains discoverable.
      // A valid default still leaves Enter at the existing prompt Send seam.
      if (scope.checkout.newWorktree && !scope.checkout.base) $("#worktreeBaseButton")?.focus();
      else $("#newThreadPrompt")?.focus();
      // Persistence must not steal focus after the user opens the base picker.
      await saved;
    });
    if ($("#worktreeBase")) {
      renderBaseOptions(inspection, scope.checkout);
      $("#worktreeBaseButton").onclick = () => {
        const picker = $("#worktreeBasePicker");
        const open = picker.classList.contains("hidden");
        picker.classList.toggle("hidden", !open);
        $("#worktreeBaseButton").setAttribute("aria-expanded", String(open));
        if (open) {
          const rect = $("#worktreeBaseButton").getBoundingClientRect();
          const width = Math.min(280, window.innerWidth - 16);
          picker.style.width = `${width}px`;
          picker.style.left = `${Math.max(8, Math.min(rect.right + 8, window.innerWidth - width - 8))}px`;
          picker.style.top = `${Math.max(8, Math.min(rect.top, window.innerHeight - 300))}px`;
          $("#worktreeBaseSearch").focus();
        }
      };
      $("#worktreeBasePicker").onkeydown = event => {
        const options = Array.from($("#worktreeBaseList").querySelectorAll("button"));
        if (event.key === "Escape") {
          event.preventDefault(); event.stopPropagation();
          $("#worktreeBasePicker").classList.add("hidden");
          $("#worktreeBaseButton").setAttribute("aria-expanded", "false");
          $("#worktreeBaseButton").focus();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const index = options.indexOf(document.activeElement);
          const next = index < 0 ? (event.key === "ArrowDown" ? 0 : options.length - 1)
            : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
          options[next]?.focus();
        }
      };
      $("#worktreeBaseSearch").oninput = () => renderBaseOptions(inspection, scope.checkout, $("#worktreeBaseSearch").value);
      $("#worktreeBase").onchange = safely(async () => {
        await checkoutController.setBase($("#worktreeBase").value);
        focusDraft();
      });
    }
    if ($("#separateSubfolder")) $("#separateSubfolder").onclick = safely(async () => {
      scope.separateSubfolder = true;
      scope.kind = "folder";
      delete scope.projectId;
      scope.label = relative.split("/").pop();
      await persistPendingNewThreadDraftDurably($("#newThreadPrompt").value, scope);
      scopeChanged(); renderCheckout(); closeCheckoutMenu();
    });
  }
  const sharing = !scope.checkout?.newWorktree && (state.sharedActive || checkoutSharingThreads(appState.threads, scope).some((thread) => appState.interactions.some((interaction) => String(interaction.threadId) === String(thread.id) && activeStatuses.has(interaction.completionStatus))));
  if (state.error || sharing) {
    notice.classList.remove("hidden");
    notice.innerHTML = `${escapeHtml((state.error?.message ? state.error.message + (state.changedCheckout ? ` Now ${state.changedCheckout.branch || "Detached HEAD"} · ${state.changedCheckout.commit?.slice(0, 12) || "No commit"}.` : "") : null) || "Another thread is active here. Files and repository state are shared.")}${state.changedCheckout ? ' <button type="button" id="acknowledgeCheckout">Use changed checkout</button>' : state.status === "failed" ? ' <button type="button" id="retryCheckoutNotice">Retry</button>' : ""}`;
    if ($("#acknowledgeCheckout")) $("#acknowledgeCheckout").onclick = safely(() => checkoutController.acknowledgeChange());
    if ($("#retryCheckoutNotice")) $("#retryCheckoutNotice").onclick = safely(() => selectCheckoutScope(scope));
  }
}
