import { join } from "node:path";

export function createWindowFactory({ BrowserWindow, desktopDirectory, getAppearance, updater }) {
  return async function createWindow(productSession) {
    const productOrigin = new URL(productSession.origin).origin;
    const window = new BrowserWindow({
      width: 1420,
      height: 900,
      minWidth: 960,
      minHeight: 640,
      titleBarStyle: "hiddenInset",
      backgroundColor: getAppearance() === "light" ? "#fafafa" : "#0b0c0d",
      webPreferences: {
        preload: join(desktopDirectory, "preload", "index.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.webContents.on("did-fail-load", (_event, code, description) => {
      console.error(`Renderer load failed (${code}): ${description}`);
    });
    const preventUntrustedNavigation = (event, target) => {
      try {
        if (new URL(target).origin === productOrigin) return;
      } catch {}
      event.preventDefault();
    };
    window.webContents.on("will-navigate", preventUntrustedNavigation);
    window.webContents.on("will-redirect", preventUntrustedNavigation);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    await window.webContents.session.cookies.set({
      url: productSession.origin,
      name: productSession.cookie.name,
      value: productSession.cookie.value,
      httpOnly: true,
      sameSite: "strict",
      secure: false,
    });
    await window.loadURL(productOrigin);
    if (updater.status().phase !== "development") {
      setTimeout(() => { void updater.check().catch(() => undefined); }, 5_000);
    }
    return window;
  };
}
