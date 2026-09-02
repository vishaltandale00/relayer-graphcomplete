import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { createWindowFactory } from "../desktop/main/window.mjs";

describe("createWindowFactory", () => {
  it("exposes the window before async init can hang and polices navigation to safe external links", async () => {
    let releaseCookie;
    const cookiePending = new Promise((resolve) => { releaseCookie = resolve; });
    let windowOpenHandler;
    class FakeBrowserWindow {
      constructor() {
        this.webContents = Object.assign(new EventEmitter(), {
          setWindowOpenHandler: vi.fn((handler) => { windowOpenHandler = handler; }),
          session: { cookies: { set: vi.fn(() => cookiePending) } },
        });
        this.loadURL = vi.fn(async () => undefined);
      }
    }
    let exposedWindow;
    const openExternal = vi.fn(async () => undefined);
    const createWindow = createWindowFactory({
      BrowserWindow: FakeBrowserWindow,
      desktopDirectory: "/immutable-desktop",
      getAppearance: () => "dark",
      updater: { status: () => ({ phase: "development" }) },
      openExternal,
      onWindowCreated: (window) => { exposedWindow = window; },
    });

    const pendingWindow = createWindow({
      origin: "http://127.0.0.1:4321/session",
      cookie: { name: "session", value: "private" },
    });
    expect(exposedWindow, "window is exposed before cookie init settles").toBeInstanceOf(FakeBrowserWindow);
    expect(exposedWindow.webContents.session.cookies.set, "session cookie write is queued").toHaveBeenCalledOnce();
    expect(exposedWindow.loadURL, "loadURL is held until the cookie settles").not.toHaveBeenCalled();

    releaseCookie();
    await expect(pendingWindow, "factory resolves with the exposed window").resolves.toBe(exposedWindow);
    expect(exposedWindow.loadURL, "origin loads after the cookie settles").toHaveBeenCalledWith("http://127.0.0.1:4321");

    const nflUrl = "https://www.nfl.com/schedules/2026/by-week/week-1";
    const navigation = { preventDefault: vi.fn() };
    exposedWindow.webContents.emit("will-navigate", navigation, nflUrl);
    await new Promise((resolve) => setImmediate(resolve));

    expect(navigation.preventDefault, "external navigation is blocked in-app").toHaveBeenCalledOnce();
    expect(openExternal, "external link is handed to the system browser").toHaveBeenCalledWith(nflUrl);
    expect(windowOpenHandler({ url: nflUrl }), "window.open is denied for external urls").toEqual({ action: "deny" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(openExternal, "denied window.open still routes through the system browser").toHaveBeenCalledTimes(2);

    openExternal.mockClear();
    const sameOriginNavigation = { preventDefault: vi.fn() };
    exposedWindow.webContents.emit("will-navigate", sameOriginNavigation, "http://127.0.0.1:4321/threads/5");
    expect(sameOriginNavigation.preventDefault, "same-origin navigation proceeds").not.toHaveBeenCalled();

    const unsafeNavigation = { preventDefault: vi.fn() };
    exposedWindow.webContents.emit("will-navigate", unsafeNavigation, "javascript:alert(1)");
    expect(unsafeNavigation.preventDefault, "unsafe schemes are blocked").toHaveBeenCalledOnce();
    expect(windowOpenHandler({ url: "file:///tmp/private" }), "window.open is denied for non-http schemes").toEqual({ action: "deny" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(openExternal, "unsafe schemes never reach the system browser").not.toHaveBeenCalled();
  });
});
