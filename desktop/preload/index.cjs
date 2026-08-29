const { contextBridge, ipcRenderer } = require("electron");

// Electron sandboxed preloads resolve only electron, events, timers and
// url. A relative require throws here and aborts the whole preload before
// contextBridge runs, so this logic is inlined rather than imported.

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


if (typeof window !== "undefined" && contextBridge) {
  installRendererErrorReporting({
    windowTarget: window,
    locationTarget: location,
    send: (record) => ipcRenderer.send("relayer:renderer-unhandled-error", record),
  });
}

function subscribe(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

if (contextBridge) contextBridge.exposeInMainWorld("relayerDesktop", {
  platform: process.platform,
  account: {
    read: () => ipcRenderer.invoke("relayer:account-read"),
    login: () => ipcRenderer.invoke("relayer:account-login"),
    logout: () => ipcRenderer.invoke("relayer:account-logout"),
    onChanged: (callback) => subscribe("relayer:account-changed", callback),
  },
  folder: {
    choose: () => ipcRenderer.invoke("relayer:folder-choose"),
  },
  conversation: {
    export: (threadId) => ipcRenderer.invoke("relayer:conversation-export", threadId),
  },
  models: {
    settingsOpened: () => ipcRenderer.invoke("relayer:model-catalog-settings-open"),
    refresh: (providerId) => ipcRenderer.invoke("relayer:model-catalog-refresh", providerId),
  },
  providers: {
    status: () => ipcRenderer.invoke("relayer:provider-status"),
    connect: (input) => ipcRenderer.invoke("relayer:provider-connect", input),
    completeConnection: (connectionId) => ipcRenderer.invoke("relayer:provider-connect-complete", { connectionId }),
    cancelConnection: (connectionId) => ipcRenderer.invoke("relayer:provider-connect-cancel", { connectionId }),
    rename: (id, label) => ipcRenderer.invoke("relayer:provider-rename", { id, label }),
    logout: (id) => ipcRenderer.invoke("relayer:provider-logout", { id }),
    reconnect: (id) => ipcRenderer.invoke("relayer:provider-reconnect", { id }),
    remove: (id) => ipcRenderer.invoke("relayer:provider-remove", { id }),
    completeOnboarding: () => ipcRenderer.invoke("relayer:provider-onboarding-complete"),
    onChanged: (callback) => subscribe("relayer:providers-changed", callback),
  },
  appearance: {
    read: () => ipcRenderer.invoke("relayer:appearance-read"),
    set: (appearance) => ipcRenderer.invoke("relayer:appearance-set", appearance),
  },
  tutorial: {
    read: (context) => ipcRenderer.invoke("relayer:tutorial-read", context),
    beginAutomatic: (context) => ipcRenderer.invoke("relayer:tutorial-begin-automatic", context),
    beginManual: () => ipcRenderer.invoke("relayer:tutorial-begin-manual"),
    dismiss: () => ipcRenderer.invoke("relayer:tutorial-dismiss"),
    complete: () => ipcRenderer.invoke("relayer:tutorial-complete"),
  },
  updater: {
    status: () => ipcRenderer.invoke("relayer:update-status"),
    check: () => ipcRenderer.invoke("relayer:update-check"),
    download: () => ipcRenderer.invoke("relayer:update-download"),
    install: () => ipcRenderer.invoke("relayer:update-install"),
    setChannel: (channel) => ipcRenderer.invoke("relayer:update-channel", channel),
    onChanged: (callback) => subscribe("relayer:update-changed", callback),
  },
});

module.exports = { installRendererErrorReporting, sameOriginFrames };
