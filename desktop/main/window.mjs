import { join } from "node:path";

const UNEXPECTED_RENDERER_TERMINATIONS = new Set([
  "abnormal-exit",
  "crashed",
  "oom",
  "launch-failed",
  "integrity-failure",
]);

export function createWindowFactory({
  BrowserWindow,
  desktopDirectory,
  getAppearance,
  updater,
  onWindowCreated = () => {},
  issueErrorReporter = () => null,
}) {
  let rendererGeneration = 0;
  let activeReporterState = null;
  const revokeReporter = (state) => {
    if (state === null || state.revoked) return;
    state.revoked = true;
    try { state.reporter?.revoke(); } catch {}
    if (activeReporterState === state) activeReporterState = null;
  };
  return async function createWindow(productSession) {
    revokeReporter(activeReporterState);
    rendererGeneration += 1;
    let reporter = null;
    try { reporter = issueErrorReporter("renderer", rendererGeneration); } catch {}
    const reporterState = {
      reporter,
      revoked: false,
    };
    activeReporterState = reporterState;
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
    const reportRendererTermination = (_event, details) => {
      if (!UNEXPECTED_RENDERER_TERMINATIONS.has(details?.reason)) return;
      Promise.resolve(reporterState.reporter?.report({
        code: "renderer.unhandled_crash",
        exceptionClass: null,
        frames: [],
      })).catch(() => undefined);
    };
    const reportRendererUnhandledError = (_event, channel, record) => {
      if (channel !== "relayer:renderer-unhandled-error") return;
      Promise.resolve(reporterState.reporter?.report(record)).catch(() => undefined);
    };
    window.webContents.on("render-process-gone", reportRendererTermination);
    window.webContents.on("ipc-message", reportRendererUnhandledError);
    window.once?.("closed", () => {
      window.webContents.removeListener?.("render-process-gone", reportRendererTermination);
      window.webContents.removeListener?.("ipc-message", reportRendererUnhandledError);
      revokeReporter(reporterState);
    });
    onWindowCreated(window);
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
