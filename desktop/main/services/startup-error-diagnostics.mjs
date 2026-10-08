import { sanitizeJavaScriptErrorFrames } from "../../shared/error-stack-sanitizer.mjs";
import { isApprovedTelemetryModule } from "../../shared/telemetry-module-inventory.mjs";
import { validShareNetworkCode } from "./share-error-diagnostics.mjs";

const STAGES = new Set(["initialization", "runtime-start", "product-server-start", "window-load"]);
const CHROMIUM_NETWORK_CODES = new Set([
  "ERR_FAILED", "ERR_CONNECTION_REFUSED", "ERR_CONNECTION_RESET", "ERR_CONNECTION_CLOSED",
  "ERR_CONNECTION_TIMED_OUT", "ERR_TIMED_OUT", "ERR_ABORTED", "ERR_NAME_NOT_RESOLVED",
  "ERR_INTERNET_DISCONNECTED",
]);

export function validStartupStage(value) { return STAGES.has(value); }
export function validStartupNetworkCode(value) {
  return value === null || CHROMIUM_NETWORK_CODES.has(value) || validShareNetworkCode(value);
}

function read(error, key) {
  try { return error?.[key]; } catch { return undefined; }
}

export function captureStartupErrorDiagnostics(error) {
  let frames = [];
  let networkCode = null;
  const seen = new Set();
  for (let depth = 0; depth < 4 && error && !seen.has(error); depth += 1) {
    seen.add(error);
    if (frames.length === 0) {
      frames = sanitizeJavaScriptErrorFrames({ component: "electron-main", error })
        .filter((frame) => isApprovedTelemetryModule("electron-main", frame.module));
    }
    const code = read(error, "code");
    if (networkCode === null && code !== null && validStartupNetworkCode(code)) networkCode = code;
    if (networkCode === null && read(error, "name") === "TimeoutError") networkCode = "TIMEOUT";
    // Electron loadURL errors can expose the fixed Chromium code only in their message.
    const message = read(error, "message");
    if (networkCode === null && typeof message === "string" && message.length <= 64 * 1024) {
      const token = /^(ERR_[A-Z_]+)(?:\s|$)/u.exec(message)?.[1];
      if (CHROMIUM_NETWORK_CODES.has(token)) networkCode = token;
    }
    error = read(error, "cause");
  }
  return Object.freeze({ frames: Object.freeze(frames), networkCode });
}
