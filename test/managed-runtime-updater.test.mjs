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
  it("prefetches runtimes from update metadata without ever failing the application download", async () => {
    const prefetchRuntimeUpdate = vi.fn(async () => {});
    const { autoUpdater, updater } = fixture({ prefetchRuntimeUpdate });
    const info = {
      version: "0.2.15",
      relayerManagedRuntimes: { claude: "0.3.250", codex: "0.147.0" },
    };
    autoUpdater.emit("update-available", info);

    await updater.download();

    expect(prefetchRuntimeUpdate, "runtime prefetch receives the incoming update metadata")
      .toHaveBeenCalledWith(info);
    expect(autoUpdater.downloadUpdate, "the application download still starts").toHaveBeenCalledOnce();

    const failure = new Error("runtime registry unavailable");
    const reported = vi.fn();
    const failing = fixture({
      prefetchRuntimeUpdate: async () => { throw failure; },
      onRuntimePrefetchFailure: reported,
    });
    failing.autoUpdater.emit("update-available", { version: "0.2.15", relayerManagedRuntimes: {} });

    await expect(failing.updater.download(), "a failed runtime prefetch never fails the application download")
      .resolves.toMatchObject({ channel: "stable" });
    await vi.waitFor(() => expect(reported, "the prefetch failure is reported separately")
      .toHaveBeenCalledWith(failure));
  });
});
