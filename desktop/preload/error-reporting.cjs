const EXCEPTION_CLASSES = new Set([
  "AggregateError", "Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError",
]);
const MAX_STACK_BYTES = 64 * 1024;
const MAX_STACK_LINES = 256;

function boundedStack(stack) {
  if (stack.length > MAX_STACK_BYTES) return false;
  if (Buffer.byteLength(stack, "utf8") > MAX_STACK_BYTES) return false;
  let lines = 1;
  for (let index = 0; index < stack.length; index += 1) {
    if (stack.charCodeAt(index) !== 10) continue;
    lines += 1;
    if (lines > MAX_STACK_LINES) return false;
  }
  return true;
}

function sanitizedExceptionClass(error) {
  try { return EXCEPTION_CLASSES.has(error?.name) ? error.name : null; } catch { return null; }
}

function sameOriginFrames(error, origin) {
  let stack;
  try { stack = error?.stack; } catch { return Object.freeze([]); }
  if (typeof stack !== "string" || typeof origin !== "string" || !boundedStack(stack)) return Object.freeze([]);
  const frames = [];
  for (const line of stack.split("\n")) {
    const match = /(?:\(|\s)(https?:\/\/[^\s)]+):(\d+):(\d+)\)?$/u.exec(line);
    if (!match) continue;
    let rawLocation;
    try { rawLocation = decodeURIComponent(match[1]); } catch { continue; }
    if (rawLocation.split(/[?#]/u, 1)[0].split("/").some((segment) => segment === "." || segment === "..")) continue;
    let url;
    try { url = new URL(match[1]); } catch { continue; }
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { continue; }
    const segments = pathname.split("/");
    const lineNumber = Number(match[2]);
    const column = Number(match[3]);
    if (url.origin !== origin
      || !pathname.startsWith("/")
      || !/^[A-Za-z0-9._/-]+$/u.test(pathname)
      || segments.some((segment) => segment === "." || segment === ".." || segment === "node_modules" || segment === "vendor")
      || !/\.(?:[cm]?js|ts)$/u.test(pathname)
      || !Number.isSafeInteger(lineNumber) || lineNumber < 1
      || !Number.isSafeInteger(column) || column < 1) continue;
    const module = `desktop/renderer${pathname}`;
    if (module.length > 256) continue;
    frames.push(Object.freeze({ module, line: lineNumber, column }));
    if (frames.length === 32) break;
  }
  return Object.freeze(frames);
}

function installRendererErrorReporting({ windowTarget, locationTarget, send }) {
  if (typeof windowTarget?.addEventListener !== "function" || typeof send !== "function") {
    throw new TypeError("Renderer error-reporting boundary is invalid.");
  }
  const report = (error) => {
    const frames = sameOriginFrames(error, locationTarget?.origin);
    try {
      Promise.resolve(send({
        code: "renderer.unhandled_crash",
        exceptionClass: sanitizedExceptionClass(error),
        frames,
      })).catch(() => undefined);
    } catch {}
  };
  const onError = (event) => report(event?.error);
  const onUnhandledRejection = (event) => report(event?.reason);
  windowTarget.addEventListener("error", onError);
  windowTarget.addEventListener("unhandledrejection", onUnhandledRejection);
  return Object.freeze({
    close() {
      windowTarget.removeEventListener?.("error", onError);
      windowTarget.removeEventListener?.("unhandledrejection", onUnhandledRejection);
    },
  });
}

module.exports = { installRendererErrorReporting, sameOriginFrames };
