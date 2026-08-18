export const DEFAULT_DESKTOP_HARNESS_CONFIGURATION = "codex-basic";

export function resolveDesktopHarnessConfiguration({
  isPackaged,
  environment = process.env,
} = {}) {
  if (isPackaged) return DEFAULT_DESKTOP_HARNESS_CONFIGURATION;
  const requested = String(environment.RELAYER_DESKTOP_HARNESS_CONFIGURATION || "").trim();
  if (!requested) return DEFAULT_DESKTOP_HARNESS_CONFIGURATION;
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(requested)) {
    throw new Error("RELAYER_DESKTOP_HARNESS_CONFIGURATION must be a harness configuration name.");
  }
  return requested;
}
