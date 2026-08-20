const PROFILE_DESCRIPTIONS = {
  ask: "Ask before actions that need approval.",
  auto: "Relayer reviews approval requests automatically.",
  full: "No approval prompts. Filesystem and network access are not hard-confined.",
};

const UNAVAILABLE_REASONS = {
  disabled_by_desktop_policy: "Disabled by desktop policy",
  runtime_unavailable: "Runtime unavailable",
  unsupported_by_harness: "Unsupported by the selected harness",
};

export function resolvePermissionSelection({ defaultProfile, profiles }, preferredProfileId = null) {
  if (!Array.isArray(profiles)) throw new Error("Permission profile response is invalid.");
  const available = profiles.filter((profile) => profile?.available === true);
  const selected = available.find((profile) => profile.id === preferredProfileId)
    || available.find((profile) => profile.id === defaultProfile)
    || available[0];
  if (!selected) throw new Error("No permission profile is available for this desktop harness.");
  return selected.id;
}

export function permissionPickerDisabled(profiles) {
  if (!Array.isArray(profiles)) throw new Error("Permission profile response is invalid.");
  return profiles.length === 0;
}

export function permissionProfileDescription(profile) {
  if (!profile.available) {
    return UNAVAILABLE_REASONS[profile.unavailableReason] || "Unavailable";
  }
  return PROFILE_DESCRIPTIONS[profile.id] || "Use this permission profile for the thread.";
}
