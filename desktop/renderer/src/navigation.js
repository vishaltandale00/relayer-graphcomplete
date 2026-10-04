import { projectCollapsed, setProjectCollapsed, projectActivity } from "./project-sidebar.js";
import { threadIconMarkup } from "./product-workspace/icons.js";
import { checkoutSelectionLocked, selectCheckoutScope, closeCheckoutMenu } from "./checkout.js";
import { appState, desktop, viewState } from "./state.js";
import { onboardingTutorialController } from "./onboarding-tutorial.js";
import { $, $$, escapeHtml, escapeHtmlAttribute } from "./ui.js";
import { evalSidebarHeading } from "./navigation-model.js";
import { persistPendingNewThreadDraft } from "./composer-drafts.js";
import { request } from "./api.js";
import { createLucideIcon } from "./product-workspace/icons.js";
import { THREAD_ACTIVITY } from "./product-workspace/run-state.js";

import { sidebarArchiveButton, loadArchivedChats } from "./thread-archive.js";

const settingsTabs = {
  archived: "Archived chats",
  account: "Account",
  providers: "Providers",
  models: "Model families",
  harnesses: "Harnesses",
  appearance: "Appearance",
  updates: "Application updates",
  advanced: "Advanced",
};

export function setMainView(view, { moveFocus = false } = {}) {
  if (view === "settings" && viewState.mainView !== "settings") {
    viewState.previousMainView = viewState.mainView;
  }
  viewState.mainView = view;
  $("#newThreadView").classList.toggle("hidden", view !== "new");
  $("#threadView").classList.toggle("hidden", view !== "thread");
  $("#settingsView").classList.toggle("hidden", view !== "settings");
  $("#settingsButton").classList.toggle("active", view === "settings");
  $("#settingsButton").classList.toggle("hidden", view === "settings" || Boolean(viewState.evalContext));
  $("#appSidebarContent").classList.toggle("hidden", view === "settings");
  $("#settingsSidebarContent").classList.toggle("hidden", view !== "settings");
  if (view === "settings") setSettingsTab(viewState.settingsTab);
  if (moveFocus) {
    const narrow = window.matchMedia?.("(max-width: 760px)").matches;
    if (view === "settings") {
      if (narrow) $("#settingsCompactSelect")?.focus();
      else $(`[data-settings-tab="${viewState.settingsTab}"]`)?.focus();
    } else {
      if (narrow || document.body?.classList.contains("sidebar-collapsed")) {
        $("#collapseSidebar")?.focus();
      } else {
        $("#settingsButton")?.focus();
      }
    }
  }
  onboardingTutorialController()?.presentationChanged();
}

export function setSettingsTab(tab) {
  const selectedTab = Object.hasOwn(settingsTabs, tab) ? tab : "appearance";
  viewState.settingsTab = selectedTab;
  if (selectedTab === "archived") void loadArchivedChats();
  $("#settingsTitle").textContent = settingsTabs[selectedTab];
  const compactSelect = $("#settingsCompactSelect");
  if (compactSelect) compactSelect.value = selectedTab;
  $$('[data-settings-tab]').forEach((button) => {
    const active = button.dataset.settingsTab === selectedTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  $$('[data-settings-panel]').forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.settingsPanel !== selectedTab);
  });
}

export async function returnFromSettings(refreshThread) {
  const previousView = viewState.previousMainView;
  const destination = previousView === "thread" && viewState.currentThreadId ? "thread" : "new";
  setMainView(destination, { moveFocus: true });
  if (destination === "thread" && refreshThread) await refreshThread(viewState.currentThreadId);
  return destination;
}

const THREAD_ACTIVITY_POLL_MS = 2000;
let threadActivityTimer = null;

function threadEntry(thread) {
  const activity = THREAD_ACTIVITY[thread.activity];
  const name = activity ? `${thread.title}, ${activity.label}` : thread.title;
  const tooltip = activity ? `${thread.title} · ${activity.label}` : thread.title;
  return `<div class="thread-entry-row"><button class="entry ${String(thread.id) === String(viewState.currentThreadId) ? "active" : ""}" data-thread="${escapeHtml(thread.id)}"${activity ? ` data-activity="${escapeHtmlAttribute(thread.activity)}"` : ""} data-review-ref="thread-${escapeHtml(thread.id)}" data-review-kind="thread" aria-label="${escapeHtmlAttribute(name)}" title="${escapeHtmlAttribute(tooltip)}"><span class="entry-icon thread-topic-icon" aria-hidden="true">${threadIconMarkup(thread.icon)}</span><span class="thread-entry-title">${escapeHtml(thread.title)}</span><span class="entry-icon thread-activity" aria-hidden="true"></span></button>${sidebarArchiveButton(thread)}</div>`;
}

function renderThreadActivity() {
  $$(".thread-archive-button").forEach((button) => {
    button.replaceChildren(createLucideIcon("Trash2", { "aria-hidden": "true" }));
  });
  $$("[data-thread][data-activity]").forEach((entry) => {
    const activity = THREAD_ACTIVITY[entry.dataset.activity];
    entry.querySelector(".thread-activity")?.replaceChildren(createLucideIcon(activity.icon));
  });
  $$('[data-project-activity]').forEach((entry) => {
    entry.replaceChildren(createLucideIcon(THREAD_ACTIVITY[entry.dataset.projectActivity].icon));
  });
  const live = appState.threads.some((thread) => THREAD_ACTIVITY[thread.activity]?.live || thread.archiveBlocked);
  if (live && threadActivityTimer === null) {
    threadActivityTimer = setTimeout(refreshThreadActivity, THREAD_ACTIVITY_POLL_MS);
  } else if (!live && threadActivityTimer !== null) {
    clearTimeout(threadActivityTimer);
    threadActivityTimer = null;
  }
}

// Background threads keep changing state; refresh only their activity while any is live.
async function refreshThreadActivity() {
  threadActivityTimer = null;
  try {
    const threads = await request("/api/threads");
    const activityById = new Map((Array.isArray(threads) ? threads : threads?.threads ?? []).map((thread) => [String(thread.id), thread]));
    let changed = false;
    appState.threads = appState.threads.map((thread) => {
      const next = activityById.get(String(thread.id));
      if (!next || (next.activity === thread.activity && next.archiveBlocked === thread.archiveBlocked)) return thread;
      changed = true;
      return { ...thread, activity: next.activity, archiveBlocked: next.archiveBlocked };
    });
    if (changed) renderSidebar();
    else renderThreadActivity();
  } catch {
    threadActivityTimer = setTimeout(refreshThreadActivity, THREAD_ACTIVITY_POLL_MS * 2);
  }
}

export function renderSidebar() {
  if (viewState.evalContext) {
    const chatList = $("#chatList");
    const chatSection = chatList.closest(".side-section");
    const projectSection = $("#projectList").closest(".side-section");
    document.querySelector(".sidebar-title strong").textContent = "Eval";
    $("#newThread").classList.add("hidden");
    chatSection.querySelector(".section-label").textContent = evalSidebarHeading(viewState.evalContext);
    chatSection.classList.remove("hidden");
    projectSection.classList.add("hidden");
    $("#settingsButton").classList.add("hidden");
    chatList.innerHTML = viewState.evalContext.cases.map((testCase) => {
      const threads = testCase.threads || [];
      const entries = threads.length
        ? threads.map((thread, index) => `<button class="entry ${String(thread.id) === String(viewState.currentThreadId) ? "active" : ""}" data-thread="${escapeHtml(thread.id)}" data-review-ref="thread-${escapeHtml(thread.id)}" data-review-kind="thread" aria-label="${escapeHtmlAttribute(thread.name)}" title="${escapeHtmlAttribute(thread.name)}"><span class="entry-icon" aria-hidden="true">${index + 1}</span><span>${escapeHtml(thread.name)}</span></button>`).join("")
        : `<div class="entry"><span class="entry-icon">—</span><span>No thread</span></div>`;
      return `<div class="eval-case"><div class="section-label">${escapeHtml(testCase.name)} · ${escapeHtml(testCase.status)}</div>${entries}</div>`;
    }).join("");
    return;
  }
  const standalone = appState.threads.filter((thread) => !thread.archivedAt && !thread.projectId);
  $("#chatList").innerHTML = standalone.length
    ? standalone.map(threadEntry).join("")
    : `<div class="entry"><span class="entry-icon">—</span><span>No chats yet</span></div>`;
  $("#projectList").innerHTML = appState.projects.map((project) => {
    const threads = appState.threads.filter((thread) => !thread.archivedAt && String(thread.groupedProjectId ?? thread.projectId) === String(project.id));
    const collapsed = projectCollapsed(project.id);
    const activity = collapsed ? projectActivity(threads) : null;
    const activityLabel = activity ? `, ${THREAD_ACTIVITY[activity].label}` : "";
    const projectId = escapeHtmlAttribute(project.id);
    const projectName = escapeHtml(project.name);
    const projectNameAttribute = escapeHtmlAttribute(project.name);
    return `<div><div class="project-row" data-project-row="${projectId}"><button class="project-button" type="button" data-project-toggle="${projectId}"${threads.length ? ` aria-expanded="${!collapsed}" aria-controls="project-threads-${projectId}"` : ""} aria-label="${projectNameAttribute}${activityLabel}" title="${projectNameAttribute}${activityLabel}"><i aria-hidden="true"></i>${threads.length ? `<svg class="project-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="${collapsed ? "m9 6 6 6-6 6" : "m6 9 6 6 6-6"}"/></svg>` : ""}<span>${projectName}</span>${activity ? `<span class="project-activity" data-project-activity="${activity}" aria-hidden="true"></span>` : ""}</button><button class="project-new-thread" type="button" data-project-new-thread="${projectId}" aria-label="New thread in ${projectNameAttribute}" title="New thread in ${projectNameAttribute}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.69 4.05 19.95 9.31M4 20l3.75-.75L19.2 7.8a1.75 1.75 0 0 0 0-2.48l-.52-.52a1.75 1.75 0 0 0-2.48 0L4.75 16.25 4 20Z"/><path d="M13 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-7"/></svg></button></div><div id="project-threads-${projectId}" class="project-threads${collapsed ? " hidden" : ""}">${threads.map(threadEntry).join("")}</div></div>`;
  }).join("");
  $$('[data-project-toggle]').forEach((button) => {
    button.onclick = () => {
      const id = button.dataset.projectToggle;
      if (document.body.classList.contains("sidebar-collapsed")) {
        $("#collapseSidebar")?.click();
        setProjectCollapsed(id, false);
      } else if (button.hasAttribute("aria-expanded")) {
        setProjectCollapsed(id, !projectCollapsed(id));
      } else return;
      renderSidebar();
      $(`[data-project-toggle="${id}"]`)?.focus();
    };
  });
  renderThreadActivity();
}

export function selectScope(scope, { userInitiated = false } = {}) {
  if (checkoutSelectionLocked()) return false;
  if (userInitiated) onboardingTutorialController()?.cancelPendingAutomatic();
  viewState.selectedScope = scope;
  closeCheckoutMenu();
  $("#scopeLabel").textContent = scope.label;
  const summary = $("#folderSummary");
  if (scope.path) {
    summary.classList.remove("hidden");
    summary.innerHTML = `<b>${scope.git ? `Git · ${escapeHtml(scope.branch || "repository")}` : "Local folder"}</b>${escapeHtml(scope.path)}`;
  } else {
    summary.classList.add("hidden");
  }
  void selectCheckoutScope(scope);
  if (userInitiated && viewState.mainView === "new") {
    persistPendingNewThreadDraft($("#newThreadPrompt").value, scope);
  }
}

export async function chooseFolder() {
  let folder;
  if (desktop) folder = await desktop.folder.choose();
  else {
    const path = prompt("Absolute path to a local folder");
    folder = path ? { path, git: false } : null;
  }
  if (!folder) return;
  const label = (folder.repositoryRoot || folder.path).split("/").filter(Boolean).at(-1) || folder.path;
  selectScope({ kind: "folder", label, ...folder }, { userInitiated: true });
}

export function renderScopeMenu() {
  const projectItems = appState.projects.map((project) => `<button data-scope="project" data-project="${escapeHtml(project.id)}"><span>${escapeHtml(project.name)}</span><small>${escapeHtml(project.path)}</small></button>`).join("");
  $("#scopeMenu").innerHTML = `<button data-scope="standalone"><span>No folder</span><small>Start without a project folder</small></button>${projectItems}<button data-scope="folder"><span>Open another folder…</span><small>Create a local project when you send</small></button>`;
  $$('[data-scope]', $("#scopeMenu")).forEach((button) => {
    button.onclick = async () => {
      if (button.dataset.scope === "standalone") {
        selectScope({ kind: "standalone", label: "No folder" }, { userInitiated: true });
      }
      if (button.dataset.scope === "project") {
        const project = appState.projects.find((item) => String(item.id) === button.dataset.project);
        if (project) {
          selectScope(
            { kind: "project", projectId: project.id, label: project.name, path: project.path, separateSubfolder: Boolean(project.relativePath) },
            { userInitiated: true },
          );
        }
      }
      if (button.dataset.scope === "folder") await chooseFolder();
      $("#scopeMenu").classList.add("hidden");
      $("#scopeButton").setAttribute("aria-expanded", "false");
    };
  });
}
