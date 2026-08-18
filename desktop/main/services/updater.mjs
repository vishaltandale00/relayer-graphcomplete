export function createDesktopUpdater({ autoUpdater, app, emit, updateBaseUrl }) {
  let channel = "stable";
  let state = { phase: app.isPackaged ? "idle" : "development", channel, version: app.getVersion() };
  const publish = (patch) => {
    state = { ...state, ...patch, channel, version: app.getVersion() };
    emit(state);
    return state;
  };

  if (app.isPackaged) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.on("checking-for-update", () => publish({ phase: "checking", error: null }));
    autoUpdater.on("update-available", (info) => publish({ phase: "available", availableVersion: info.version, error: null }));
    autoUpdater.on("update-not-available", () => publish({ phase: "idle", availableVersion: null, error: null }));
    autoUpdater.on("download-progress", (progress) => publish({ phase: "downloading", percent: Math.round(progress.percent) }));
    autoUpdater.on("update-downloaded", (info) => publish({ phase: "ready", availableVersion: info.version, percent: 100 }));
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
      return publish({ phase: app.isPackaged ? "idle" : "development", availableVersion: null, error: null });
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
      await autoUpdater.downloadUpdate();
      return state;
    },
    install() {
      if (state.phase !== "ready") throw new Error("No verified update is ready to install.");
      autoUpdater.quitAndInstall(false, true);
    },
  };
}
