export const REVIEW_WORKSPACE_READY_CHANNEL = "relayer-eval:review-workspace-ready";

export function loadReadyReviewWorkspace({
  window,
  ipc,
  url,
  expected,
  timeoutMs = 30_000,
}) {
  if (!window?.webContents || typeof window.loadURL !== "function") {
    throw new Error("Review workspace readiness requires an Electron window.");
  }
  if (!ipc?.on || !ipc?.removeListener) {
    throw new Error("Review workspace readiness requires Electron ipcMain.");
  }
  if (!url || !expected?.executionId || !expected?.threadId || !expected?.navigationToken) {
    throw new Error("Review workspace readiness requires an exact navigation identity.");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Review workspace readiness timeout must be positive.");
  }

  const webContents = window.webContents;
  return new Promise((resolve, reject) => {
    let loadCompleted = false;
    let readyPayload = null;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      ipc.removeListener(REVIEW_WORKSPACE_READY_CHANNEL, onReady);
      webContents.removeListener?.("render-process-gone", onRendererGone);
      window.removeListener?.("closed", onClosed);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(structuredClone(readyPayload));
    };
    const maybeFinish = () => {
      if (loadCompleted && readyPayload) finish();
    };
    const onReady = (event, payload) => {
      if (event?.sender !== webContents) return;
      if (!matchesExpected(payload, expected)) return;
      readyPayload = payload;
      maybeFinish();
    };
    const onRendererGone = (_event, details) => {
      finish(new Error(`Review workspace renderer stopped before readiness: ${details?.reason || "unknown"}.`));
    };
    const onClosed = () => {
      finish(new Error("Review workspace closed before readiness."));
    };
    const timer = setTimeout(() => {
      finish(new Error(`Review workspace did not become ready within ${timeoutMs}ms.`));
    }, timeoutMs);

    ipc.on(REVIEW_WORKSPACE_READY_CHANNEL, onReady);
    webContents.on?.("render-process-gone", onRendererGone);
    window.on?.("closed", onClosed);
    Promise.resolve(window.loadURL(url)).then(() => {
      loadCompleted = true;
      maybeFinish();
    }, (error) => {
      finish(new Error(`Review workspace failed to load: ${error instanceof Error ? error.message : String(error)}`));
    });
  });
}

function matchesExpected(payload, expected) {
  return payload
    && String(payload.executionId) === String(expected.executionId)
    && String(payload.threadId) === String(expected.threadId)
    && (expected.turnId == null || String(payload.turnId) === String(expected.turnId))
    && String(payload.navigationToken) === String(expected.navigationToken);
}
