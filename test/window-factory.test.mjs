import { EventEmitter } from "node:events";

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
      openExternal: vi.fn(async () => undefined),
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

  it("opens safe external node-detail links in the system browser without navigating Relayer", async () => {
    let windowOpenHandler;
    class FakeBrowserWindow {
      constructor() {
        this.webContents = Object.assign(new EventEmitter(), {
          setWindowOpenHandler: vi.fn((handler) => { windowOpenHandler = handler; }),
          session: { cookies: { set: vi.fn(async () => undefined) } },
        });
        this.loadURL = vi.fn(async () => undefined);
      }
    }
    const openExternal = vi.fn(async () => undefined);
    const createWindow = createWindowFactory({
      BrowserWindow: FakeBrowserWindow,
      desktopDirectory: "/immutable-desktop",
      getAppearance: () => "dark",
      updater: { status: () => ({ phase: "development" }) },
      openExternal,
    });
    const window = await createWindow({
      origin: "http://127.0.0.1:4321/session",
      cookie: { name: "session", value: "private" },
    });
    const nflUrl = "https://www.nfl.com/schedules/2026/by-week/week-1";
    const navigation = { preventDefault: vi.fn() };

    window.webContents.emit("will-navigate", navigation, nflUrl);
    await new Promise((resolve) => setImmediate(resolve));

    expect(navigation.preventDefault).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledWith(nflUrl);
    expect(windowOpenHandler({ url: nflUrl })).toEqual({ action: "deny" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(openExternal).toHaveBeenCalledTimes(2);

    openExternal.mockClear();
    const sameOriginNavigation = { preventDefault: vi.fn() };
    window.webContents.emit("will-navigate", sameOriginNavigation, "http://127.0.0.1:4321/threads/5");
    expect(sameOriginNavigation.preventDefault).not.toHaveBeenCalled();

    const unsafeNavigation = { preventDefault: vi.fn() };
    window.webContents.emit("will-navigate", unsafeNavigation, "javascript:alert(1)");
    expect(unsafeNavigation.preventDefault).toHaveBeenCalledOnce();
    expect(windowOpenHandler({ url: "file:///tmp/private" })).toEqual({ action: "deny" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(openExternal).not.toHaveBeenCalled();
  });
});
