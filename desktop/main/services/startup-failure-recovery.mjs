import { captureStartupErrorDiagnostics } from "./startup-error-diagnostics.mjs";
import { startupErrorAlreadyReported } from "./startup-report-status.mjs";
import { settleShutdownWithin } from "./update-restart.mjs";

export const STARTUP_REPORT_BUDGET_MS = 2_500;
export const STARTUP_LOGIN_BUDGET_MS = 120_000;

// A child may stop while loadURL is outstanding. A successful paint does not
// make a dead service usable; both sides of that await belong to startup.
export async function completeDesktopStartupWindow({ createWindow, productSession, hasFatalServiceFailure }) {
  if (hasFatalServiceFailure()) throw new Error("Relayer local service stopped during startup.");
  const window = await createWindow(productSession);
  if (hasFatalServiceFailure()) {
    window.destroy();
    throw new Error("Relayer local service stopped during startup.");
  }
  return window;
}

// Native setup belongs to the same fallback as dialog recovery. Construction
// may fail before a parent exists; presentation may fail after it was allocated.
export async function runDesktopStartupFailureRecovery({
  createWindow, presentWindow, recover, shutdown, exit, onFailure, clearWindow,
  shutdownBudgetMs = 10_000,
}) {
  let window;
  try {
    window = createWindow();
    presentWindow(window);
    return await recover();
  } catch (error) {
    onFailure(error);
    await settleShutdownWithin({ shutdown, budgetMs: shutdownBudgetMs });
    exit(1);
    return "failed";
  } finally {
    try {
      if (window && !window.isDestroyed()) window.destroy();
    } catch (error) {
      onFailure(error);
    } finally {
      clearWindow();
    }
  }
}

// One deadline covers identity restoration, child attribution, and report delivery.
// Ending the wait also revokes admission; a late promise cannot initiate a report.
async function bounded(operation, budgetMs, signal, onEnd = () => {}) {
  const controller = new AbortController();
  let timer;
  let abort;
  const ended = new Promise((resolve) => {
    abort = () => { controller.abort(); resolve({ status: "cancelled" }); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    timer = setTimeout(() => { controller.abort(); resolve({ status: "timeout" }); }, budgetMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => controller.signal.aborted ? { status: "cancelled" } : operation(controller.signal))
        .then((value) => ({ status: "settled", value }), () => ({ status: "failed" })),
      ended,
    ]);
  } finally {
    controller.abort();
    onEnd();
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export async function reportDesktopStartupFailure({
  error, startupStage, accountStartup, account, reporting, priorReport,
  budgetMs = STARTUP_REPORT_BUDGET_MS, signal,
}) {
  let reporter;
  return bounded(async (deadline) => {
    // This is the saved-login promise only. Recovery login never calls this path.
    const restored = await accountStartup;
    const identity = account?.telemetryIdentity();
    if (deadline.aborted || restored?.status !== "signed-in" || !identity || identity.subject !== restored.subject) return;
    if (await startupErrorAlreadyReported(error) || (await priorReport)?.accepted === true || deadline.aborted) return;
    const current = account.telemetryIdentity();
    if (current?.generation !== identity.generation || current?.subject !== identity.subject) return;
    reporter = reporting?.issueStartupFailureReporter({ generation: identity.generation });
    if (!reporter || deadline.aborted) return;
    return reporter.report({
      code: "electron_main.startup_failure", startupStage,
      ...captureStartupErrorDiagnostics(error),
    });
  }, budgetMs, signal, () => reporter?.revoke());
}

async function signInForRecovery({ account, showDialog, budgetMs, signal }) {
  const progress = new AbortController();
  const result = await bounded(async (deadline) => {
    // The dialog remains cancellable while browser launch itself is outstanding.
    const cancellation = Promise.resolve().then(() => showDialog({
      type: "info", title: "Sign in to Relayer", message: "Finish signing in in your browser.",
      detail: "Relayer will restart after sign-in is verified.",
      buttons: ["Cancel sign-in", "Quit"], defaultId: 0, cancelId: 0, noLink: true,
      signal: progress.signal,
    })).then(({ response }) => ({ action: response === 1 ? "quit" : "cancel" }));
    const verification = (async () => {
      await account.login({ signal: deadline });
      if (deadline.aborted) return { action: "cancel" };
      const state = await account.waitForIdle();
      if (deadline.aborted) return { action: "cancel" };
      return state?.status === "signed-in" && account.telemetryIdentity()
        ? { action: "restart", identity: account.telemetryIdentity() }
        : { action: "failed" };
    })();
    return Promise.race([verification, cancellation]);
  }, budgetMs, signal, () => progress.abort());
  if (result.status !== "settled" || result.value.action !== "restart") {
    // Invalidate an in-flight callback before returning to recovery choices.
    // This also fences a browser launch that settles after the deadline.
    await bounded(() => account.cancelLogin(), 1_000);
    return result.status === "settled" ? result.value : { action: "failed" };
  }
  return result.value;
}

export async function recoverDesktopStartupFailure({
  error, startupStage, accountStartup, account, reporting, priorReport, showDialog,
  shutdown, relaunch, exit, signal,
  reportBudgetMs = STARTUP_REPORT_BUDGET_MS,
  loginBudgetMs = STARTUP_LOGIN_BUDGET_MS,
  shutdownBudgetMs = 10_000,
}) {
  await reportDesktopStartupFailure({ error, startupStage, accountStartup, account, reporting, priorReport, budgetMs: reportBudgetMs, signal });
  let detail = "Relayer could not open its workspace. Retry restarts the app.";
  const canLogin = typeof account?.login === "function" && typeof account?.waitForIdle === "function"
    && typeof account?.telemetryIdentity === "function" && typeof account?.cancelLogin === "function";
  while (!signal?.aborted) {
    const buttons = canLogin ? ["Retry", "Sign in and retry", "Quit"] : ["Retry", "Quit"];
    const { response } = await showDialog({
      type: "error", title: "Relayer could not start", message: "Relayer could not start",
      detail, buttons, defaultId: 0, cancelId: buttons.length - 1, noLink: true, signal,
    });
    if (signal?.aborted || response === buttons.length - 1) break;
    if (response === 0) {
      await settleShutdownWithin({ shutdown, budgetMs: shutdownBudgetMs });
      if (!signal?.aborted) relaunch();
      exit(1);
      return "retry";
    }
    if (canLogin && response === 1) {
      const login = await signInForRecovery({ account, showDialog, budgetMs: loginBudgetMs, signal });
      if (login.action === "quit" || signal?.aborted) break;
      if (login.action === "restart") {
        // A late logout/replacement cannot turn browser-launch success into restart.
        const identity = account.telemetryIdentity();
        if (identity?.generation === login.identity.generation && identity?.subject === login.identity.subject) {
          await settleShutdownWithin({ shutdown, budgetMs: shutdownBudgetMs });
          if (!signal?.aborted) relaunch();
          exit(1);
          return "signed-in-retry";
        }
      }
      detail = login.action === "cancel" ? "Sign-in was cancelled. You can retry or quit."
        : "Sign-in could not be verified. You can try again, retry, or quit.";
    }
  }
  await settleShutdownWithin({ shutdown, budgetMs: shutdownBudgetMs });
  exit(1);
  return "quit";
}
