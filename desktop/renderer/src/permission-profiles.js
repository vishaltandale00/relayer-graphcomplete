import { request } from "./api.js";
import {
  permissionPickerDisabled,
  permissionProfileDescription,
  resolvePermissionSelection,
} from "./permission-profile-model.js";
import { appState, productApiAvailable, viewState } from "./state.js";
import { $, $$, escapeHtml, escapeHtmlAttribute } from "./ui.js";

export function closePermissionMenu() {
  $("#permissionMenu").classList.add("hidden");
  $("#permissionButton").setAttribute("aria-expanded", "false");
}

export function renderPermissionPicker() {
  const profiles = appState.permissionProfiles || [];
  const selected = profiles.find((profile) => profile.id === viewState.selectedPermissionProfileId);
  const button = $("#permissionButton");
  $("#permissionLabel").textContent = selected?.label || "Permissions";
  button.disabled = permissionPickerDisabled(profiles);
  button.title = selected ? `Permission profile: ${selected.label}` : "No permission profile is available";
  $("#permissionMenu").innerHTML = profiles.map((profile) => `
    <button type="button" role="menuitemradio" data-permission-profile="${escapeHtmlAttribute(profile.id)}" aria-checked="${profile.id === selected?.id}" ${profile.available ? "" : "disabled"} class="${profile.id === "full" ? "full-access" : ""}">
      <span><b>${escapeHtml(profile.label)}</b>${profile.id === selected?.id ? "<i>Selected</i>" : ""}</span>
      <small>${escapeHtml(permissionProfileDescription(profile))}</small>
    </button>
  `).join("");
  $$('[data-permission-profile]', $("#permissionMenu")).forEach((option) => {
    option.onclick = () => {
      const profile = profiles.find((candidate) => candidate.id === option.dataset.permissionProfile);
      if (!profile?.available) return;
      viewState.selectedPermissionProfileId = profile.id;
      renderPermissionPicker();
      closePermissionMenu();
    };
  });
}

export function togglePermissionMenu() {
  if ($("#permissionButton").disabled) return;
  const menu = $("#permissionMenu");
  const opening = menu.classList.contains("hidden");
  menu.classList.toggle("hidden", !opening);
  $("#permissionButton").setAttribute("aria-expanded", String(opening));
}

function permissionProfilesPath(harnessId) {
  return harnessId
    ? `/api/permission-profiles?harnessId=${encodeURIComponent(harnessId)}`
    : "/api/permission-profiles";
}

export async function preparePermissionProfiles(harnessId = null) {
  if (!productApiAvailable) return () => {};
  const response = await request(permissionProfilesPath(harnessId));
  const selectedPermissionProfileId = resolvePermissionSelection(
    response,
    viewState.selectedPermissionProfileId,
  );
  return () => {
    appState.permissionProfiles = response.profiles;
    appState.defaultPermissionProfileId = response.defaultProfile;
    viewState.selectedPermissionProfileId = selectedPermissionProfileId;
    renderPermissionPicker();
  };
}

export async function loadPermissionProfiles(harnessId = null) {
  try {
    const apply = await preparePermissionProfiles(harnessId);
    apply?.();
  } catch (error) {
    viewState.selectedPermissionProfileId = null;
    renderPermissionPicker();
    throw error;
  }
}
