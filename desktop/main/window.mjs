import { join } from "node:path";

export function createWindowFactory({ BrowserWindow, app, desktopDirectory, getAppearance, updater }) {
  const rendererPath = (relativePath) => join(
    app.isPackaged ? app.getAppPath() : desktopDirectory,
    "renderer",
    relativePath,
  );

  return async function createWindow() {
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
    if (!app.isPackaged) {
      window.webContents.on("did-fail-load", (_event, code, description) => {
        console.error(`Renderer load failed (${code}): ${description}`);
      });
    }
    await window.loadFile(rendererPath("index.html"));
    if (updater.status().phase !== "development") {
      setTimeout(() => { void updater.check().catch(() => undefined); }, 5_000);
    }
    return window;
  };
}
