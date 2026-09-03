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

describe("a verified download survives a background check", () => {
  // The window schedules an automatic check five seconds after it opens. When
  // that lands on a freshly downloaded update it used to walk `ready` back to
  // `available`, and the install attempt then failed while the bytes sat on
  // disk. Observed in Preview canary run 33702128267, where `ready` lasted 85ms.
  it("keeps ready when a later check rediscovers the staged version", () => {
    const { autoUpdater, updater } = fixture();
    autoUpdater.emit("update-available", { version: "0.2.30" });
    autoUpdater.emit("update-downloaded", { version: "0.2.30" });
    expect(updater.status().phase).toBe("ready");

    autoUpdater.emit("checking-for-update");
    autoUpdater.emit("update-available", { version: "0.2.30" });

    expect(updater.status()).toMatchObject({ phase: "ready", availableVersion: "0.2.30", percent: 100 });
    expect(() => updater.install()).not.toThrow();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("keeps ready when a later check reports nothing available", () => {
    const { autoUpdater, updater } = fixture();
    autoUpdater.emit("update-available", { version: "0.2.30" });
    autoUpdater.emit("update-downloaded", { version: "0.2.30" });

    autoUpdater.emit("checking-for-update");
    autoUpdater.emit("update-not-available");

    expect(updater.status().phase).toBe("ready");
  });

  it("still surfaces a genuinely newer version over a staged one", () => {
    const { autoUpdater, updater } = fixture();
    autoUpdater.emit("update-available", { version: "0.2.30" });
    autoUpdater.emit("update-downloaded", { version: "0.2.30" });

    autoUpdater.emit("update-available", { version: "0.2.31" });

    expect(updater.status()).toMatchObject({ phase: "available", availableVersion: "0.2.31" });
  });
});
