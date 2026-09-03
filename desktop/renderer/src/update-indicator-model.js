// The sidebar update indicator is one button across four phases, so its
// accessible name has to follow the phase. A fixed "update available" would
// misreport a failed check and would never announce a staged, verified update.
// Kept free of DOM access so the naming can be exercised directly.
export function updateIndicatorName(state) {
  const phase = state?.phase;
  if (phase === "ready") return "Update ready to install. Restart Relayer";
  if (phase === "failed") return "Update failed. Try again";
  if (phase === "downloading") return `Downloading update · ${state?.percent || 0}%`;
  if (phase === "available") {
    return state?.availableVersion
      ? `Version ${state.availableVersion} available. Download update`
      : "Application update available";
  }
  return "Application update status";
}
