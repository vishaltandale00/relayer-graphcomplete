import { sanitizeJavaScriptErrorFrames } from "../../shared/error-stack-sanitizer.mjs";

const ALLOWED_EXCEPTION_CLASSES = new Set([
  "AggregateError",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

function sanitizedExceptionClass(error) {
  try {
    return ALLOWED_EXCEPTION_CLASSES.has(error?.name) ? error.name : null;
  } catch {
    return null;
  }
}

export function installElectronMainErrorAdapter({
  processTarget = process,
  processGeneration = 1,
  issueErrorReporter = () => null,
} = {}) {
  const reporters = new Map();
  try {
    reporters.set("electron-main", issueErrorReporter("electron-main", processGeneration));
    reporters.set("node-harness-host", issueErrorReporter("node-harness-host", processGeneration));
  } catch {
    // Error reporting must not change Electron-main startup behavior.
  }
  const onUncaughtException = (error) => {
    const harnessFrames = sanitizeJavaScriptErrorFrames({ component: "node-harness-host", error });
    const component = harnessFrames.length > 0 ? "node-harness-host" : "electron-main";
    const frames = component === "node-harness-host"
      ? harnessFrames
      : sanitizeJavaScriptErrorFrames({ component, error });
    Promise.resolve(reporters.get(component)?.report({
      code: component === "node-harness-host"
        ? "node_harness_host.unhandled_crash"
        : "electron_main.unhandled_crash",
      exceptionClass: sanitizedExceptionClass(error),
      frames,
    })).catch(() => undefined);
  };
  processTarget.on("uncaughtExceptionMonitor", onUncaughtException);
  let closed = false;
  return Object.freeze({
    close() {
      if (closed) return;
      closed = true;
      processTarget.removeListener("uncaughtExceptionMonitor", onUncaughtException);
      for (const reporter of reporters.values()) reporter?.revoke();
      reporters.clear();
    },
  });
}
