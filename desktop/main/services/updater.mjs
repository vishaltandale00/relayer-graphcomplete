import { release as systemRelease } from "node:os";

function numericVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value || ""));
  return match ? match.slice(1).map(Number) : null;
}

export function desktopUpdateSupportsSystem(
  updateInfo,
  { platform = process.platform, release = systemRelease() } = {},
) {
  if (platform !== "darwin") return true;
  const current = numericVersion(release);
  const minimum = numericVersion(updateInfo?.minimumSystemVersion);
  if (!current || !minimum) return false;
  for (let index = 0; index < current.length; index += 1) {
    if (current[index] !== minimum[index]) return current[index] > minimum[index];
  }
  return true;
}

export function resolveUpdateChannel(savedChannel) {
  return savedChannel === "preview" ? "preview" : "stable";
}

// Phases where an update is already in the user's hands. Neither a channel
// change nor a background poll may disturb one.
const IN_FLIGHT_UPDATE_PHASES = ["checking", "available", "downloading", "ready"];

// A session left open past a release would otherwise never learn it is behind,
// because the only other checks are one at startup and the Settings button.
export const UPDATE_POLL_INTERVAL_MS = 3 * 60 * 60 * 1000;

// Launch discovery waits for the window to settle before touching the network.
export const UPDATE_LAUNCH_CHECK_DELAY_MS = 5_000;

export function createDesktopUpdater({
  autoUpdater,
  app,
  emit,
  updateBaseUrl,
  prefetchRuntimeUpdate = async () => {},
  onRuntimePrefetchFailure = () => {},
  platform = process.platform,
  release = systemRelease(),
  pollIntervalMs = UPDATE_POLL_INTERVAL_MS,
  launchCheckDelayMs = UPDATE_LAUNCH_CHECK_DELAY_MS,
  setPollTimer = setInterval,
  clearPollTimer = clearInterval,
  setLaunchTimer = setTimeout,
  clearLaunchTimer = clearTimeout,
}) {
  let channel = "stable";
  let availableInfo = null;
  let pollTimer = null;
  let launchTimer = null;
  let launchCheckScheduled = false;
  let displayedDownloadPercent = 0;
  let state = { phase: app.isPackaged ? "idle" : "development", channel, version: app.getVersion() };
  const publish = (patch) => {
    state = { ...state, ...patch, channel, version: app.getVersion() };
    emit(state);
    return state;
  };
  const resetDownloadProgress = () => {
    displayedDownloadPercent = 0;
  };
  const nextDownloadPercent = (reportedPercent) => {
    const roundedPercent = Number.isFinite(reportedPercent) ? Math.round(reportedPercent) : 0;
    // electron-updater can emit a second progress pass while Squirrel stages
    // the update. Keep product progress monotonic and reserve 100% for ready.
    displayedDownloadPercent = Math.max(displayedDownloadPercent, Math.min(99, Math.max(0, roundedPercent)));
    return displayedDownloadPercent;
  };

  if (app.isPackaged) {
    autoUpdater.isUpdateSupported = (updateInfo) => desktopUpdateSupportsSystem(
      updateInfo,
      { platform, release },
    );
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowDowngrade = false;
    // A verified download survives any later check. Without these guards a
    // check lands on a freshly downloaded update, walks `ready` back through
    // `checking` to `available`, and the next install attempt fails with "No
    // verified update is ready to install" while the bytes sit on disk. Progress
    // events already refuse to overwrite `ready`; the check lifecycle must too.
    // Scheduled discovery is guarded earlier, in `backgroundCheck`, so these
    // guards are what protect the phase when the user checks from Settings —
    // that path is deliberately unguarded because the user asked for it.
    autoUpdater.on("checking-for-update", () => {
      if (state.phase === "ready") return;
      resetDownloadProgress();
      publish({ phase: "checking", percent: null, error: null });
    });
    autoUpdater.on("update-available", (info) => {
      availableInfo = info;
      // Rediscovering the version already staged is not new information.
      if (state.phase === "ready" && state.availableVersion === info.version) return;
      resetDownloadProgress();
      publish({ phase: "available", availableVersion: info.version, percent: null, error: null });
    });
    autoUpdater.on("update-not-available", () => {
      if (state.phase === "ready") return;
      availableInfo = null;
      resetDownloadProgress();
      publish({ phase: "idle", availableVersion: null, percent: null, error: null });
    });
    autoUpdater.on("download-progress", (progress) => {
      if (state.phase === "ready") return;
      publish({ phase: "downloading", percent: nextDownloadPercent(progress.percent) });
    });
    autoUpdater.on("update-downloaded", (info) => {
      displayedDownloadPercent = 100;
      publish({ phase: "ready", availableVersion: info.version, percent: 100 });
    });
    autoUpdater.on("error", (error) => publish({ phase: "failed", error: error.message }));
  }

  const configureFeed = () => {
    if (!app.isPackaged || !updateBaseUrl) return;
    const providerChannel = channel === "preview" ? "beta" : "latest";
    autoUpdater.allowPrerelease = channel === "preview";
    autoUpdater.setFeedURL({ provider: "generic", url: updateBaseUrl, channel: providerChannel });
    autoUpdater.channel = providerChannel;
    // electron-updater's channel setter enables downgrades. Relayer channels
    // share one application identity, so restore the release-contract guard
    // after every channel assignment.
    autoUpdater.allowDowngrade = false;
  };

  async function check() {
    if (!app.isPackaged) return publish({ phase: "development", error: null });
    configureFeed();
    try {
      await autoUpdater.checkForUpdates();
      return state;
    } catch (error) {
      return state.phase === "failed" ? state : publish({ phase: "failed", error: error.message });
    }
  }

  // A scheduled discovery never disturbs an update already in the user's
  // hands, and never fails a caller that cannot act on the result.
  async function backgroundCheck() {
    if (IN_FLIGHT_UPDATE_PHASES.includes(state.phase)) return state;
    try {
      return await check();
    } catch {
      return state;
    }
  }

  return {
    status: () => state,
    check,
    startPolling() {
      if (!app.isPackaged || pollTimer !== null) return false;
      // The launch check is a discovery too, so it takes the same guard as the
      // poll instead of calling check() unconditionally. It also fires at most
      // once per process: recreating a window while an update is downloading or
      // staged must not reset that phase back to checking.
      if (!launchCheckScheduled) {
        launchCheckScheduled = true;
        launchTimer = setLaunchTimer(() => { void backgroundCheck(); }, launchCheckDelayMs);
        launchTimer?.unref?.();
      }
      pollTimer = setPollTimer(() => { void backgroundCheck(); }, pollIntervalMs);
      pollTimer?.unref?.();
      return true;
    },
    stopPolling() {
      if (launchTimer !== null) {
        clearLaunchTimer(launchTimer);
        launchTimer = null;
      }
      if (pollTimer === null) return false;
      clearPollTimer(pollTimer);
      pollTimer = null;
      return true;
    },
    setChannel(next) {
      if (next !== "stable" && next !== "preview") throw new Error("Update channel must be stable or preview.");
      if (IN_FLIGHT_UPDATE_PHASES.includes(state.phase)) {
        throw new Error("Finish the current update before changing channels.");
      }
      channel = next;
      availableInfo = null;
      configureFeed();
      resetDownloadProgress();
      return publish({
        phase: app.isPackaged ? "idle" : "development",
        availableVersion: null,
        percent: null,
        error: null,
      });
    },
    async download() {
      if (!app.isPackaged) throw new Error("Updates are available only in packaged builds.");
      resetDownloadProgress();
      if (availableInfo !== null) {
        void Promise.resolve(prefetchRuntimeUpdate(availableInfo)).catch(onRuntimePrefetchFailure);
      }
      await autoUpdater.downloadUpdate();
      return state;
    },
    install() {
      if (state.phase !== "ready") throw new Error("No verified update is ready to install.");
      autoUpdater.quitAndInstall(false, true);
    },
  };
}
