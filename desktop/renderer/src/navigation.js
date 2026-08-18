import { appState, desktop, viewState } from "./state.js";
import { $, $$, escapeHtml } from "./ui.js";

export function setMainView(view) {
  viewState.mainView = view;
  $("#newThreadView").classList.toggle("hidden", view !== "new");
  $("#threadView").classList.toggle("hidden", view !== "thread");
  $("#settingsView").classList.toggle("hidden", view !== "settings");
  $("#settingsButton").classList.toggle("active", view === "settings");
}

function threadEntry(thread) {
  return `<button class="entry ${String(thread.id) === String(viewState.currentThreadId) ? "active" : ""}" data-thread="${escapeHtml(thread.id)}"><span class="entry-icon">◌</span><span>${escapeHtml(thread.title)}</span></button>`;
}

export function renderSidebar() {
  const standalone = appState.threads.filter((thread) => !thread.projectId);
  $("#chatList").innerHTML = standalone.length
    ? standalone.map(threadEntry).join("")
    : `<div class="entry"><span class="entry-icon">—</span><span>No chats yet</span></div>`;
  $("#projectList").innerHTML = appState.projects.map((project) => {
    const threads = appState.threads.filter((thread) => String(thread.projectId) === String(project.id));
    return `<div><button class="project-button"><i></i><span>${escapeHtml(project.name)}</span><span>${threads.length}</span></button><div class="project-threads">${threads.map(threadEntry).join("")}</div></div>`;
  }).join("");
}

export function selectScope(scope) {
  viewState.selectedScope = scope;
  $("#scopeLabel").textContent = scope.label;
  const summary = $("#folderSummary");
  if (scope.path) {
    summary.classList.remove("hidden");
    summary.innerHTML = `<b>${scope.git ? `Git · ${escapeHtml(scope.branch || "repository")}` : "Local folder"}</b>${escapeHtml(scope.path)}`;
  } else {
    summary.classList.add("hidden");
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
  const label = folder.path.split("/").filter(Boolean).at(-1) || folder.path;
  selectScope({ kind: "folder", label, ...folder });
}

export function renderScopeMenu() {
  const projectItems = appState.projects.map((project) => `<button data-scope="project" data-project="${escapeHtml(project.id)}"><span>${escapeHtml(project.name)}</span><small>${escapeHtml(project.path)}</small></button>`).join("");
  $("#scopeMenu").innerHTML = `<button data-scope="standalone"><span>No folder</span><small>Start without a project folder</small></button>${projectItems}<button data-scope="folder"><span>Open another folder…</span><small>Create a local project when you send</small></button>`;
  $$('[data-scope]', $("#scopeMenu")).forEach((button) => {
    button.onclick = async () => {
      if (button.dataset.scope === "standalone") selectScope({ kind: "standalone", label: "No folder" });
      if (button.dataset.scope === "project") {
        const project = appState.projects.find((item) => String(item.id) === button.dataset.project);
        if (project) selectScope({ kind: "project", projectId: project.id, label: project.name, path: project.path });
      }
      if (button.dataset.scope === "folder") await chooseFolder();
      $("#scopeMenu").classList.add("hidden");
    };
  });
}
