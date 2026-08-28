import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { createDesktopUpdater } from "../desktop/main/services/updater.mjs";

function fixture({ prefetchRuntimeUpdate = async () => {}, onRuntimePrefetchFailure = () => {} } = {}) {
  const autoUpdater = new EventEmitter();
  Object.assign(autoUpdater, {
    checkForUpdates: vi.fn(async () => {}),
    downloadUpdate: vi.fn(async () => {}),
    setFeedURL: vi.fn(),
    quitAndInstall: vi.fn(),
  });
  const updater = createDesktopUpdater({
    autoUpdater,
    app: { isPackaged: true, getVersion: () => "0.2.14" },
    updateBaseUrl: "https://updates.example.test",
    emit: vi.fn(),
    prefetchRuntimeUpdate,
    onRuntimePrefetchFailure,
  });
  return { autoUpdater, updater };
}

describe("managed runtime application-update boundary", () => {
  it("starts runtime prefetch from incoming metadata alongside the application download", async () => {
    const prefetchRuntimeUpdate = vi.fn(async () => {});
    const { autoUpdater, updater } = fixture({ prefetchRuntimeUpdate });
    const info = {
      version: "0.2.15",
      relayerManagedRuntimes: { claude: "0.3.250", codex: "0.147.0" },
    };
    autoUpdater.emit("update-available", info);

    await updater.download();

    expect(prefetchRuntimeUpdate).toHaveBeenCalledWith(info);
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledOnce();
  });

  it("never fails the application download when runtime prefetch fails", async () => {
    const failure = new Error("runtime registry unavailable");
    const reported = vi.fn();
    const { autoUpdater, updater } = fixture({
      prefetchRuntimeUpdate: async () => { throw failure; },
      onRuntimePrefetchFailure: reported,
    });
    autoUpdater.emit("update-available", { version: "0.2.15", relayerManagedRuntimes: {} });

    await expect(updater.download()).resolves.toMatchObject({ channel: "stable" });
    await vi.waitFor(() => expect(reported).toHaveBeenCalledWith(failure));
  });
});
