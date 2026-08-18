export function resolveUpdateChannel(savedChannel) {
  return savedChannel === "preview" ? "preview" : "stable";
}

export function createDesktopUpdater({ autoUpdater, app, emit, updateBaseUrl }) {
  let channel = "stable";
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
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.on("checking-for-update", () => {
      resetDownloadProgress();
      publish({ phase: "checking", percent: null, error: null });
    });
    autoUpdater.on("update-available", (info) => {
      resetDownloadProgress();
      publish({ phase: "available", availableVersion: info.version, percent: null, error: null });
    });
    autoUpdater.on("update-not-available", () => {
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

  return {
    status: () => state,
    setChannel(next) {
      if (next !== "stable" && next !== "preview") throw new Error("Update channel must be stable or preview.");
      if (["checking", "available", "downloading", "ready"].includes(state.phase)) {
        throw new Error("Finish the current update before changing channels.");
      }
      channel = next;
      configureFeed();
      resetDownloadProgress();
      return publish({
        phase: app.isPackaged ? "idle" : "development",
        availableVersion: null,
        percent: null,
        error: null,
      });
    },
    async check() {
      if (!app.isPackaged) return publish({ phase: "development", error: null });
      configureFeed();
      try {
        await autoUpdater.checkForUpdates();
        return state;
      } catch (error) {
        return state.phase === "failed" ? state : publish({ phase: "failed", error: error.message });
      }
    },
    async download() {
      if (!app.isPackaged) throw new Error("Updates are available only in packaged builds.");
      resetDownloadProgress();
      await autoUpdater.downloadUpdate();
      return state;
    },
    install() {
      if (state.phase !== "ready") throw new Error("No verified update is ready to install.");
      autoUpdater.quitAndInstall(false, true);
    },
  };
}
