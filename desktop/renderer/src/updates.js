import { desktop } from "./state.js";
import { $, toast } from "./ui.js";

let updateState = { phase: "development", channel: "stable", version: "dev" };

export function renderUpdate(next) {
  updateState = { ...updateState, ...next };
  const visible = ["available", "downloading", "ready", "failed"].includes(updateState.phase);
  $("#updateButton").classList.toggle("hidden", !visible);
  $("#updateChannel").value = updateState.channel || "stable";
  $("#currentVersion").textContent = `Current version ${updateState.version || "development"}`;
  const labels = {
    development: "Updates disabled in development",
    idle: "Up to date",
    checking: "Checking…",
    available: `Version ${updateState.availableVersion} available`,
    downloading: `Downloading · ${updateState.percent || 0}%`,
    ready: "Ready to restart",
    failed: updateState.error || "Update failed",
  };
  $("#updateStatus").textContent = labels[updateState.phase] || updateState.phase;
  $("#updateTitle").textContent = updateState.phase === "ready" ? "Ready to restart"
    : updateState.phase === "failed" ? "Update failed"
      : "Update available";
  $("#updateDetail").textContent = labels[updateState.phase] || "A newer Relayer build is available.";
  $("#updateAction").textContent = updateState.phase === "ready" ? "Restart to update"
    : updateState.phase === "failed" ? "Try again"
      : updateState.phase === "downloading" ? `Downloading ${updateState.percent || 0}%`
        : "Download update";
  $("#updateAction").disabled = updateState.phase === "downloading";
}

export async function updateAction() {
  try {
    if (updateState.phase === "ready") await desktop.updater.install();
    else if (updateState.phase === "failed") await desktop.updater.check();
    else await desktop.updater.download();
  } catch (error) {
    toast(error.message);
  }
}
