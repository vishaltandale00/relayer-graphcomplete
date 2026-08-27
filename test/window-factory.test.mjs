import { describe, expect, it, vi } from "vitest";

import { createWindowFactory } from "../desktop/main/window.mjs";

describe("createWindowFactory", () => {
  it("exposes the BrowserWindow before asynchronous initialization can hang", async () => {
    let releaseCookie;
    const cookiePending = new Promise((resolve) => { releaseCookie = resolve; });
    class FakeBrowserWindow {
      constructor() {
        this.webContents = {
          on: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          session: { cookies: { set: vi.fn(() => cookiePending) } },
        };
        this.loadURL = vi.fn(async () => undefined);
      }
    }
    let exposedWindow;
    const createWindow = createWindowFactory({
      BrowserWindow: FakeBrowserWindow,
      desktopDirectory: "/immutable-desktop",
      getAppearance: () => "dark",
      updater: { status: () => ({ phase: "development" }) },
      onWindowCreated: (window) => { exposedWindow = window; },
    });

    const pendingWindow = createWindow({
      origin: "http://127.0.0.1:4321/session",
      cookie: { name: "session", value: "private" },
    });
    expect(exposedWindow).toBeInstanceOf(FakeBrowserWindow);
    expect(exposedWindow.webContents.session.cookies.set).toHaveBeenCalledOnce();
    expect(exposedWindow.loadURL).not.toHaveBeenCalled();

    releaseCookie();
    await expect(pendingWindow).resolves.toBe(exposedWindow);
    expect(exposedWindow.loadURL).toHaveBeenCalledWith("http://127.0.0.1:4321");
  });
});
