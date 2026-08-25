import { connectCodex, refreshAccount, showApplication, showAuth } from "./auth.js";
import { returnFromSettings, selectScope, setMainView, setSettingsTab } from "./navigation.js";
import {
  closePermissionMenu,
  loadPermissionProfiles,
  preparePermissionProfiles,
  togglePermissionMenu,
} from "./permission-profiles.js";
import { appState, desktop, evalReview, productApiAvailable, viewState } from "./state.js";
import {
  closeNewThreadModelPicker,
  initializeNewThreadModelPicker,
  newThreadModelSelectionReady,
  openNewThreadModelPicker,
  refreshNewThreadModelPicker,
  resetNewThreadModelPicker,
} from "./composer-model-picker.js";
import {
  cancelNavigationHistory,
  connectEvents,
  createFirstThread,
  loadThread,
  navigateHistory,
  refreshState,
  updateCreateThreadAvailability,
} from "./threads.js";
import { bindComposerKeydown } from "./product-workspace/workspace.js";
import {
  initializeModelFamilySettings,
  refreshModelFamilySettings,
} from "./model-family-settings.js";
import { createReviewPresentationAdapter } from "./review-tools.js";
import {
  installOnboardingTutorialController,
  onboardingTutorialController,
} from "./onboarding-tutorial.js";
import { $, applyAppearance, toast } from "./ui.js";
import { renderUpdate, updateAction } from "./updates.js";

function applyPlatformCopy() {
  const isMac = desktop?.platform === "darwin";
  $("#newThreadShortcut").textContent = isMac ? "⌘N" : "Ctrl+N";
  const device = isMac ? "Mac" : desktop?.platform === "win32" ? "Windows PC" : "computer";
  $("#appearanceDescription").textContent = `Choose how Relayer looks on this ${device}.`;
}

async function refreshProviderModelUi() {
  if (productApiAvailable) {
    await refreshModelFamilySettings();
    refreshNewThreadModelPicker();
    updateCreateThreadAvailability();
  }
  if (productApiAvailable) await refreshState(viewState.currentThreadId);
}

async function openNewThreadComposer({ prompt = "" } = {}) {
  const applyPermissionProfiles = await preparePermissionProfiles(
    appState.modelSettings?.defaults?.harnessId,
  );
  applyPermissionProfiles?.();
  cancelNavigationHistory();
  viewState.currentThreadId = null;
  viewState.currentInteractionId = null;
  selectScope({ kind: "standalone", label: "No folder" });
  resetNewThreadModelPicker();
  setMainView("new");
  $("#newThreadPrompt").value = prompt;
  updateCreateThreadAvailability();
  $("#newThreadPrompt").focus();
}

async function maybeStartAutomaticTutorial(providerConnected) {
  const tutorial = onboardingTutorialController();
  if (!tutorial || evalReview) return false;
  const ready = Boolean(viewState.selectedPermissionProfileId)
    && (!productApiAvailable || newThreadModelSelectionReady());
  if (!ready) return false;
  return tutorial.maybeStartAutomatic({
    providerConnected,
    threadCount: appState.threads.length,
  });
}

function bindEvents() {
  $("#connectCodex").onclick = connectCodex;
  $("#newThread").onclick = async () => {
    try {
      await openNewThreadComposer();
    } catch (error) {
      toast(error.message);
    }
  };
  $("#scopeButton").onclick = () => {
    closePermissionMenu();
    closeNewThreadModelPicker();
    const menu = $("#scopeMenu");
    const opening = menu.classList.contains("hidden");
    menu.classList.toggle("hidden", !opening);
    $("#scopeButton").setAttribute("aria-expanded", String(opening));
  };
  $("#permissionButton").onclick = () => {
    $("#scopeMenu").classList.add("hidden");
    $("#scopeButton").setAttribute("aria-expanded", "false");
    closeNewThreadModelPicker();
    togglePermissionMenu();
  };
  $("#createThread").onclick = () => createFirstThread();
  $("#newThreadPrompt").oninput = () => {
    updateCreateThreadAvailability();
  };
  bindComposerKeydown($("#newThreadPrompt"), () => {
    if (productApiAvailable && !newThreadModelSelectionReady()) openNewThreadModelPicker("model");
    else $("#createThread").click();
  });
  $("#collapseSidebar").onclick = () => {
    const collapsed = document.body.classList.toggle("sidebar-collapsed");
    const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
    $("#collapseSidebar").title = label;
    $("#collapseSidebar").setAttribute("aria-label", label);
  };
  $("#settingsButton").onclick = async () => {
    cancelNavigationHistory();
    setMainView("settings", { moveFocus: true });
    try {
      if (productApiAvailable) {
        await desktop?.models?.settingsOpened?.();
        await refreshModelFamilySettings();
        refreshNewThreadModelPicker();
      }
    } catch (error) {
      toast(error.message);
    }
  };
  $("#settingsBackButton").onclick = async () => {
    try {
      await returnFromSettings(refreshState);
    } catch (error) {
      toast(error.message);
    }
  };
  $("#settingsTabs").onclick = (event) => {
    const tab = event.target.closest("[data-settings-tab]");
    if (tab) setSettingsTab(tab.dataset.settingsTab);
  };
  $("#settingsTabs").onkeydown = (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const tabs = [...$("#settingsTabs").querySelectorAll("[data-settings-tab]")];
    const currentIndex = tabs.indexOf(event.target.closest("[data-settings-tab]"));
    if (currentIndex < 0) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + tabs.length) % tabs.length;
    setSettingsTab(tabs[nextIndex].dataset.settingsTab);
    tabs[nextIndex].focus();
  };
  $("#startTutorial").onclick = async () => {
    try {
      await onboardingTutorialController()?.startManual();
    } catch (error) {
      toast(error.message);
    }
  };
  $("#disconnectCodex").onclick = async () => {
    await desktop?.account.logout();
    await onboardingTutorialController()?.leave();
    await refreshAccount();
    await refreshProviderModelUi();
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
    void (async () => {
      let account;
      if (event?.status === "unavailable") showAuth(event.error || "Codex is unavailable.");
      else account = await refreshAccount();
      const providerConnected = account?.status === "connected";
      if (!providerConnected) await onboardingTutorialController()?.leave();
      await refreshProviderModelUi();
      await maybeStartAutomaticTutorial(providerConnected);
    })().catch((error) => toast(error.message));
  });
  desktop?.updater.onChanged(renderUpdate);
  if (desktop?.appearance) applyAppearance((await desktop.appearance.read()).appearance);
  else applyAppearance(document.documentElement.dataset.theme);
  if (desktop) renderUpdate(await desktop.updater.status());
  const account = await refreshAccount();
  if (productApiAvailable) await initializeModelFamilySettings();
  await loadPermissionProfiles(appState.modelSettings?.defaults?.harnessId);
  if (productApiAvailable) {
    initializeNewThreadModelPicker({
      onSelectionChange: updateCreateThreadAvailability,
      onOpenSettings: () => {
        setSettingsTab("models");
        $("#settingsButton").click();
      },
    });
  }
  updateCreateThreadAvailability();
  await refreshState(viewState.currentThreadId);
  if (desktop?.tutorial && !evalReview) {
    installOnboardingTutorialController({
      lifecycle: desktop.tutorial,
      getAppState: () => appState,
      getViewState: () => viewState,
      openNewThread: openNewThreadComposer,
    });
    await maybeStartAutomaticTutorial(account?.status === "connected");
  } else {
    $("#startTutorial").disabled = true;
  }
  if (evalReview) {
    evalReview.registerPresentationAdapter(createReviewPresentationAdapter({
      executionId: viewState.evalContext.selectedExecutionId,
      getPresentationState: () => ({
        threadId: viewState.currentThreadId,
        turnId: viewState.currentInteractionId,
        layerId: appState.visibleLayer?.layer?.id ?? null,
        selectedNodeId: viewState.selectedNodeId,
        navigationPath: viewState.layerPath.map((entry) => ({
          layerId: entry.layerId,
          viaActionId: entry.actionId ?? entry.viaActionId ?? null,
        })),
      }),
      navigateHistory,
    }));
  }
  connectEvents();
}

void boot().catch((error) => {
  showApplication();
  toast(error.message);
});
