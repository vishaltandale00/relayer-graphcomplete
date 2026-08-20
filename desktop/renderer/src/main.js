import { connectCodex, refreshAccount, showApplication, showAuth } from "./auth.js";
import { selectScope, setMainView } from "./navigation.js";
import {
  closePermissionMenu,
  loadPermissionProfiles,
  togglePermissionMenu,
} from "./permission-profiles.js";
import { appState, desktop, evalReview, viewState } from "./state.js";
import {
  connectEvents,
  createFirstThread,
  loadThread,
  refreshState,
  restoreReviewPresentation,
  updateCreateThreadAvailability,
} from "./threads.js";
import { bindComposerKeydown } from "./product-workspace/workspace.js";
import { createReviewPresentationAdapter } from "./review-tools.js";
import { $, applyAppearance, toast } from "./ui.js";
import { renderUpdate, updateAction } from "./updates.js";

function applyPlatformCopy() {
  const isMac = desktop?.platform === "darwin";
  $("#newThreadShortcut").textContent = isMac ? "⌘N" : "Ctrl+N";
  const device = isMac ? "Mac" : desktop?.platform === "win32" ? "Windows PC" : "computer";
  $("#appearanceDescription").textContent = `Choose how Relayer looks on this ${device}.`;
}

function bindEvents() {
  $("#connectCodex").onclick = connectCodex;
  $("#newThread").onclick = () => {
    viewState.currentThreadId = null;
    selectScope({ kind: "standalone", label: "No folder" });
    setMainView("new");
    $("#newThreadPrompt").focus();
  };
  $("#scopeButton").onclick = () => {
    closePermissionMenu();
    const menu = $("#scopeMenu");
    const opening = menu.classList.contains("hidden");
    menu.classList.toggle("hidden", !opening);
    $("#scopeButton").setAttribute("aria-expanded", String(opening));
  };
  $("#permissionButton").onclick = () => {
    $("#scopeMenu").classList.add("hidden");
    $("#scopeButton").setAttribute("aria-expanded", "false");
    togglePermissionMenu();
  };
  $("#createThread").onclick = createFirstThread;
  $("#newThreadPrompt").oninput = () => {
    updateCreateThreadAvailability();
  };
  bindComposerKeydown($("#newThreadPrompt"), () => $("#createThread").click());
  $("#collapseSidebar").onclick = () => {
    const collapsed = document.body.classList.toggle("sidebar-collapsed");
    const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
    $("#collapseSidebar").title = label;
    $("#collapseSidebar").setAttribute("aria-label", label);
  };
  $("#settingsButton").onclick = () => setMainView("settings");
  $("#disconnectCodex").onclick = async () => {
    await desktop?.account.logout();
    await refreshAccount();
  };
  $("#updateButton").onclick = () => $("#updatePopover").classList.toggle("hidden");
  $("#closeUpdate").onclick = () => $("#updatePopover").classList.add("hidden");
  $("#updateAction").onclick = updateAction;
  $("#checkUpdates").onclick = async () => {
    if (!desktop) return toast("Updates are available in the desktop app.");
    try {
      renderUpdate(await desktop.updater.check());
    } catch (error) {
      toast(error.message);
    }
  };
  $("#updateChannel").onchange = async (event) => {
    if (!desktop) return;
    try {
      renderUpdate(await desktop.updater.setChannel(event.target.value));
    } catch (error) {
      toast(error.message);
    }
  };
  $("#appearanceSelect").onchange = async (event) => {
    applyAppearance(event.target.value);
    if (!desktop?.appearance) return;
    try {
      applyAppearance((await desktop.appearance.set(event.target.value)).appearance);
    } catch (error) {
      toast(error.message);
    }
  };
  document.addEventListener("click", (event) => {
    const threadButton = event.target.closest("[data-thread]");
    if (threadButton) void loadThread(threadButton.dataset.thread);
    if (!event.target.closest(".scope-control")) {
      $("#scopeMenu").classList.add("hidden");
      $("#scopeButton").setAttribute("aria-expanded", "false");
    }
    if (!event.target.closest(".permission-control")) closePermissionMenu();
  });
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
      event.preventDefault();
      $("#newThread").click();
    }
    if (event.key === "Escape") {
      $("#scopeMenu").classList.add("hidden");
      $("#scopeButton").setAttribute("aria-expanded", "false");
      closePermissionMenu();
    }
  });
}

async function boot() {
  if (evalReview) viewState.evalContext = await evalReview.context();
  applyPlatformCopy();
  bindEvents();
  desktop?.account.onChanged((event) => {
    if (event?.status === "unavailable") showAuth(event.error || "Codex is unavailable.");
    else void refreshAccount();
  });
  desktop?.updater.onChanged(renderUpdate);
  if (desktop?.appearance) applyAppearance((await desktop.appearance.read()).appearance);
  else applyAppearance(document.documentElement.dataset.theme);
  if (desktop) renderUpdate(await desktop.updater.status());
  await refreshAccount();
  await loadPermissionProfiles();
  updateCreateThreadAvailability();
  await refreshState(viewState.currentThreadId);
  if (evalReview) {
    evalReview.registerPresentationAdapter(createReviewPresentationAdapter({
      executionId: viewState.evalContext.selectedExecutionId,
      getPresentationState: () => ({
        threadId: viewState.currentThreadId,
        turnId: viewState.currentInteractionId,
        layerId: appState.visibleLayer?.layer?.id ?? null,
        selectedNodeId: viewState.selectedNodeId,
      }),
      restorePresentationState: restoreReviewPresentation,
    }));
  }
  connectEvents();
}

void boot().catch((error) => {
  showApplication();
  toast(error.message);
});
