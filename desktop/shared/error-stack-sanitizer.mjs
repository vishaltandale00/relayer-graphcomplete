const JAVASCRIPT_ROOT = Object.freeze({
  renderer: "desktop/renderer/",
  "electron-main": "desktop/main/",
  "node-harness-host": "packages/harness-host/",
});

const RUST_ROOT = Object.freeze({
  "rust-app-server": "crates/relayer-app-server/",
  "rust-graph-server": "crates/relayer-graph-server/",
});
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

function exactFrame(frame) {
  return frame !== null
    && typeof frame === "object"
    && !Array.isArray(frame)
    && Object.keys(frame).sort().join("\0") === "column\0line\0module";
}

function frameLocation(line) {
  const match = /(?:\(|\s)(.+):(\d+):(\d+)\)?$/u.exec(line);
  if (!match) return null;
  const lineNumber = Number(match[2]);
  const column = Number(match[3]);
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 1
    || !Number.isSafeInteger(column) || column < 1) return null;
  return { path: match[1], line: lineNumber, column };
}

function sourceTreeModule(path, component) {
  const root = JAVASCRIPT_ROOT[component];
  if (!root) return null;
  let normalized = path.replace(/^file:\/\//u, "").replaceAll("\\", "/");
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    return null;
  }
  if (/[\0?#]/u.test(normalized)) return null;
  const inputSegments = normalized.split("/");
  if (inputSegments.some((segment) => segment === "." || segment === "..")) return null;
  const marker = `/${root}`;
  const index = normalized.lastIndexOf(marker);
  if (index >= 0) {
    const prefixSegments = normalized.slice(0, index).split("/");
    if (prefixSegments.some((segment) => segment === "node_modules" || segment === "vendor")) return null;
    const module = normalized.slice(index + 1);
    return validJavaScriptModule(module, root) ? module : null;
  }
  const packagedRoot = {
    "electron-main": "/app.asar/main/",
    "node-harness-host": "/app.asar/node_modules/@relayer/harness-host/",
  }[component];
  if (packagedRoot) {
    const packagedIndex = normalized.lastIndexOf(packagedRoot);
    if (packagedIndex >= 0) {
      const module = `${root}${normalized.slice(packagedIndex + packagedRoot.length)}`;
      return validJavaScriptModule(module, root) ? module : null;
    }
  }
  if (component === "renderer") {
    const packagedRenderer = /\/(?:Resources|resources)\/renderer\//gu;
    let packagedMatch = null;
    for (const match of normalized.matchAll(packagedRenderer)) packagedMatch = match;
    if (packagedMatch) {
      const module = `${root}${normalized.slice(packagedMatch.index + packagedMatch[0].length)}`;
      return validJavaScriptModule(module, root) ? module : null;
    }
  }
  return null;
}

function validJavaScriptModule(module, root) {
  const segments = module.split("/");
  return module.startsWith(root)
    && module.length <= 256
    && /^[A-Za-z0-9._/-]+$/u.test(module)
    && !segments.some((segment) => segment === "." || segment === ".." || segment === "node_modules" || segment === "vendor")
    && /\.(?:[cm]?js|ts)$/u.test(module);
}

export function sanitizeJavaScriptErrorFrames({ component, error } = {}) {
  let stack;
  try {
    stack = error?.stack;
  } catch {
    return Object.freeze([]);
  }
  if (typeof stack !== "string" || !boundedStack(stack)) return Object.freeze([]);
  const frames = [];
  for (const line of stack.split("\n")) {
    const location = frameLocation(line);
    if (!location) continue;
    const module = sourceTreeModule(location.path, component);
    if (!module) continue;
    frames.push(Object.freeze({ module, line: location.line, column: location.column }));
    if (frames.length === 32) break;
  }
  return Object.freeze(frames);
}

export function sanitizeRustFrames({ component, frames } = {}) {
  const root = RUST_ROOT[component];
  if (!root || !Array.isArray(frames)) return Object.freeze([]);
  const sanitized = [];
  try {
    for (const frame of frames.slice(0, 256)) {
      const segments = typeof frame?.module === "string" ? frame.module.split("/") : [];
      if (!exactFrame(frame)
        || frame.module.length === 0
        || frame.module.length > 256
        || !frame.module.startsWith(root)
        || !frame.module.endsWith(".rs")
        || !/^[A-Za-z0-9._/-]+$/u.test(frame.module)
        || segments.some((segment) => segment === "." || segment === ".." || segment === "node_modules" || segment === "vendor")
        || !Number.isSafeInteger(frame.line)
        || frame.line < 1
        || !Number.isSafeInteger(frame.column)
        || frame.column < 1) continue;
      sanitized.push(Object.freeze({ module: frame.module, line: frame.line, column: frame.column }));
      if (sanitized.length === 32) break;
    }
  } catch {
    return Object.freeze([]);
  }
  return Object.freeze(sanitized);
}

export function parseRustDiagnosticFrames({ component, text } = {}) {
  const root = RUST_ROOT[component];
  if (!root || typeof text !== "string") return Object.freeze([]);
  const candidates = [];
  const pattern = /(?:^|[^A-Za-z0-9._/-])(crates\/[A-Za-z0-9._/-]+\.rs):(\d+):(\d+)/gmu;
  for (const match of text.matchAll(pattern)) {
    candidates.push({ module: match[1], line: Number(match[2]), column: Number(match[3]) });
    if (candidates.length === 32) break;
  }
  return sanitizeRustFrames({ component, frames: candidates });
}
