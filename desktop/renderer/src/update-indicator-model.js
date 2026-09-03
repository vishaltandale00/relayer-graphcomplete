// The sidebar update indicator is one button across four phases, so its
// accessible name has to follow the phase. A fixed "update available" would
// misreport a failed check and would never announce a staged, verified update.
//
// The name states the phase and then the operation this button performs, which
// is opening the update details. Restarting, retrying and downloading are the
// nested action inside that popover, so promising them here would be a lie.
// Kept free of DOM access so the naming can be exercised directly.
export function updateIndicatorName(state) {
  const phase = state?.phase;
  if (phase === "ready") return "Update ready to install. Open update details";
  if (phase === "failed") return "Update failed. Open update details";
  if (phase === "downloading") return `Downloading update · ${state?.percent || 0}%. Open update details`;
  if (phase === "available") {
    return state?.availableVersion
      ? `Version ${state.availableVersion} available. Open update details`
      : "Application update available. Open update details";
  }
  return "Application update status";
}
