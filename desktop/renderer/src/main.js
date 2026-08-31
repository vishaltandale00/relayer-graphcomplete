import {
  refreshAccount,
  setProviderOnboardingCompletionHandler,
  showApplication,
} from "./auth.js";
import { returnFromSettings, selectScope, setMainView, setSettingsTab } from "./navigation.js";
import {
  closePermissionMenu,
  loadPermissionProfiles,
  preparePermissionProfiles,
  togglePermissionMenu,
} from "./permission-profiles.js";
import { appState, desktop, evalReview, productApiAvailable, query, viewState } from "./state.js";
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
  refreshCurrentEnvironment,
  stopEnvironmentRefresh,
  updateCreateThreadAvailability,
} from "./threads.js";
import { bindComposerKeydown } from "./product-workspace/workspace.js";
import { prepareCurrentWorkspaceTransition } from "./graph.js";
import {
  initializeModelFamilySettings,
  refreshModelFamilySettings,
} from "./model-family-settings.js";
import { createReviewPresentationAdapter } from "./review-tools.js";
import { initializeProviderSettings, refreshProviderSettings } from "./provider-settings.js";
import {
  installOnboardingTutorialController,
  onboardingTutorialController,
} from "./onboarding-tutorial.js";
import { $, applyAppearance, toast } from "./ui.js";
import { renderUpdate, updateAction } from "./updates.js";
import { assertRelayerIconRendererReady } from "./product-workspace/icons.js";
import {
  initializeDesktopAccountUi,
  refreshDesktopAccountUi,
  revealDesktopWorkspace,
} from "./desktop-account.js";
import {
  initializeComposerDrafts,
  pendingNewThreadDraft,
  persistPendingNewThreadDraft,
} from "./composer-drafts.js";

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
    updateTutorialAvailability();
  }
  if (productApiAvailable) await refreshState(viewState.currentThreadId);
}

function tutorialComposerReady() {
  return Boolean(viewState.selectedPermissionProfileId)
    && (!productApiAvailable || newThreadModelSelectionReady());
}

function updateTutorialAvailability() {
  const ready = Boolean(desktop?.tutorial) && !evalReview && tutorialComposerReady();
  $("#startTutorial").disabled = !ready;
  $("#startTutorial").title = ready
    ? "Start tutorial"
    : "Choose an available model and permission profile to start the tutorial";
}

function takeOverPendingAutomaticTutorial() {
  onboardingTutorialController()?.cancelPendingAutomatic();
}

function projectScope(project) {
  return {
    kind: "project",
    projectId: project.id,
    label: project.name,
    path: project.path,
  };
}

async function openNewThreadComposer({
  prompt = "",
  scope = { kind: "standalone", label: "No folder" },
  guard = null,
} = {}) {
  const applyPermissionProfiles = await preparePermissionProfiles(
    appState.modelSettings?.defaults?.harnessId,
  );
  if (guard && !guard()) return false;
  applyPermissionProfiles?.();
  updateTutorialAvailability();
  if (guard && !guard()) return false;
  cancelNavigationHistory();
  viewState.currentThreadId = null;
  viewState.currentInteractionId = null;
  selectScope(scope);
  resetNewThreadModelPicker();
  setMainView("new");
  $("#newThreadPrompt").value = prompt;
  updateCreateThreadAvailability();
  $("#newThreadPrompt").focus();
  return true;
}

async function maybeStartAutomaticTutorial(providerConnected) {
  const tutorial = onboardingTutorialController();
  if (!tutorial || evalReview) return false;
  if (!tutorialComposerReady()) return false;
  return tutorial.maybeStartAutomatic({
    providerConnected,
    threadCount: appState.threads.length,
  });
}

function bindEvents() {
  $("#newThread").onclick = async () => {
    if (!await prepareCurrentWorkspaceTransition()) return;
    takeOverPendingAutomaticTutorial();
    try {
      await openNewThreadComposer();
    } catch (error) {
      toast(error.message);
    }
  };
  $("#projectList").onclick = (event) => {
    const action = event.target.closest("[data-project-new-thread]");
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    void (async () => {
      const project = appState.projects.find((candidate) => (
        String(candidate.id) === action.dataset.projectNewThread
      ));
      if (!project) return;
      if (viewState.mainView === "new"
        && viewState.selectedScope.kind === "project"
        && String(viewState.selectedScope.projectId) === String(project.id)) {
        $("#newThreadPrompt").focus();
        return;
      }
      if (!await prepareCurrentWorkspaceTransition()) return;
      const draft = pendingNewThreadDraft();
      const scope = projectScope(project);
      persistPendingNewThreadDraft(draft?.text ?? "", scope);
      await openNewThreadComposer({ prompt: draft?.text ?? "", scope });
    })().catch((error) => toast(error.message));
  };
  $("#scopeButton").onclick = () => {
    takeOverPendingAutomaticTutorial();
    closePermissionMenu();
    closeNewThreadModelPicker();
    const menu = $("#scopeMenu");
    const opening = menu.classList.contains("hidden");
    menu.classList.toggle("hidden", !opening);
    $("#scopeButton").setAttribute("aria-expanded", String(opening));
  };
  $("#permissionButton").onclick = () => {
    takeOverPendingAutomaticTutorial();
    $("#scopeMenu").classList.add("hidden");
    $("#scopeButton").setAttribute("aria-expanded", "false");
    closeNewThreadModelPicker();
    togglePermissionMenu();
  };
  $("#createThread").onclick = () => createFirstThread();
  $("#newThreadPrompt").oninput = () => {
    takeOverPendingAutomaticTutorial();
    persistPendingNewThreadDraft($("#newThreadPrompt").value, viewState.selectedScope);
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
    takeOverPendingAutomaticTutorial();
    if (!await prepareCurrentWorkspaceTransition()) return;
    cancelNavigationHistory();
    setMainView("settings", { moveFocus: true });
    try {
      if (productApiAvailable) {
        await desktop?.models?.settingsOpened?.();
        await refreshProviderSettings();
        await refreshModelFamilySettings();
        refreshNewThreadModelPicker();
        updateTutorialAvailability();
      }
    } catch (error) {
      toast(error.message);
    }
  };
  const leaveSettings = async () => {
    try {
      await returnFromSettings(refreshState);
    } catch (error) {
      toast(error.message);
    }
  };
  $("#settingsBackButton").onclick = leaveSettings;
  $("#settingsCompactBackButton").onclick = leaveSettings;
  $("#settingsCompactSelect").onchange = (event) => setSettingsTab(event.target.value);
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
      if (!tutorialComposerReady()) {
        updateTutorialAvailability();
        return;
      }
      await onboardingTutorialController()?.startManual();
    } catch (error) {
      toast(error.message);
    }
  };
  const disconnectCodex = $("#disconnectCodex");
  if (disconnectCodex) {
    disconnectCodex.onclick = async () => {
      await desktop?.account.logout();
      await onboardingTutorialController()?.leave();
      await refreshAccount();
      await refreshProviderModelUi();
    };
  }
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
    if (threadButton) {
      event.preventDefault();
      void (async () => {
        if (!await prepareCurrentWorkspaceTransition()) return;
        await loadThread(threadButton.dataset.thread);
      })().catch((error) => toast(error.message));
    }
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
  assertRelayerIconRendererReady();
  if (evalReview) viewState.evalContext = await evalReview.context();
  applyPlatformCopy();
  bindEvents();
  await initializeComposerDrafts();
  window.addEventListener("focus", () => {
    void refreshCurrentEnvironment({ force: true, minimumAgeMs: 1_000 }).catch(() => {});
  });
  window.addEventListener("pagehide", stopEnvironmentRefresh, { once: true });
  desktop?.account.onChanged(() => {
    void (async () => {
      const account = await refreshAccount();
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
  setProviderOnboardingCompletionHandler(async () => {
    await refreshProviderModelUi();
    await loadPermissionProfiles(appState.modelSettings?.defaults?.harnessId);
    resetNewThreadModelPicker();
    updateCreateThreadAvailability();
    updateTutorialAvailability();
    await refreshDesktopAccountUi({ offerOnboarding: true });
  });
  const account = await refreshAccount();
  await initializeProviderSettings();
  if (productApiAvailable) await initializeModelFamilySettings();
  await loadPermissionProfiles(appState.modelSettings?.defaults?.harnessId);
  if (productApiAvailable) {
    initializeNewThreadModelPicker({
      onUserTakeover: takeOverPendingAutomaticTutorial,
      onSelectionChange: () => {
        updateCreateThreadAvailability();
        updateTutorialAvailability();
      },
      onOpenSettings: () => {
        setSettingsTab("models");
        $("#settingsButton").click();
      },
    });
  }
  updateCreateThreadAvailability();
  await refreshState(viewState.currentThreadId);
  const pendingDraft = pendingNewThreadDraft();
  if (pendingDraft?.text && !query.get("threadId")) {
    const scope = pendingDraft.scope?.kind === "project"
      ? appState.projects.find((project) => String(project.id) === String(pendingDraft.scope.projectId))
      : null;
    await openNewThreadComposer({
      prompt: pendingDraft.text,
      scope: scope ? projectScope(scope) : { kind: "standalone", label: "No folder" },
    });
  }
  await initializeDesktopAccountUi({
    desktop,
    offerOnboarding: account?.status === "connected",
    showWorkspace: () => revealDesktopWorkspace(showApplication),
    openSettings: () => {
      setSettingsTab("account");
      $("#settingsButton").click();
    },
  });
  if (desktop?.tutorial && !evalReview) {
    installOnboardingTutorialController({
      lifecycle: desktop.tutorial,
      getAppState: () => appState,
      getViewState: () => viewState,
      isComposerReady: tutorialComposerReady,
      openNewThread: openNewThreadComposer,
    });
    updateTutorialAvailability();
    await maybeStartAutomaticTutorial(account?.status === "connected");
  } else {
    updateTutorialAvailability();
  }
  if (evalReview) {
    evalReview.registerPresentationAdapter(createReviewPresentationAdapter({
      executionId: viewState.evalContext.selectedExecutionId,
      getPresentationState: () => {
        const threadId = viewState.currentThreadId;
        const thread = appState.threads.find((candidate) => String(candidate.id) === String(threadId));
        const interactionRevision = appState.interactions
          .filter((interaction) => String(interaction.threadId) === String(threadId))
          .sort((left, right) => left.sequence - right.sequence)
          .map((interaction) => `${interaction.id}:${interaction.sequence}:${interaction.completionStatus}`)
          .join(",");
        return {
          threadId,
          threadRevision: `thread:${threadId}:updated:${thread?.updatedAt ?? "unknown"}`
            + `:input-draft:${appState.inputDraftRevision ?? "none"}:interactions:${interactionRevision}`,
          turnId: viewState.currentInteractionId,
          layerId: appState.visibleLayer?.layer?.id ?? null,
          selectedNodeId: viewState.selectedNodeId,
          navigationPath: viewState.layerPath.map((entry) => ({
            layerId: entry.layerId,
            viaActionId: entry.actionId ?? entry.viaActionId ?? null,
          })),
        };
      },
      navigateHistory,
      setInputOperatorCommitted: (committed) => workspace().setInputOperatorCommitted(committed),
    }));
  }
  connectEvents();
}

void boot().catch((error) => {
  revealDesktopWorkspace(showApplication);
  toast(error.message);
});
