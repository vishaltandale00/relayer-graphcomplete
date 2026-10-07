// The artifact viewer (PRD 6.6, ADR 0014). Agent-made content renders in its own
// WebContentsView on its own partition, never in the main window. Files
// come from the thread folder through the `relayer-artifact:` scheme, which serves
// only paths inside the artifact's folder and answers byte ranges for media.
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";

import { fingerprintPath } from "./artifact-fingerprint.mjs";

export const ARTIFACT_SCHEME = "relayer-artifact";
const ORIGIN = `${ARTIFACT_SCHEME}://view`;
const FILE_KINDS = new Set(["website", "pdf", "video", "image", "markdown"]);

const MIME = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".avif": "image/avif",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".pdf": "application/pdf",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".md": "text/markdown; charset=utf-8", ".markdown": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm", ".xml": "application/xml",
};

/** Register before app `ready`: a standard, secure scheme with fetch and streaming. */
export function registerArtifactScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{
    scheme: ARTIFACT_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  }]);
}

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(root + sep);
}

function routePath(route) {
  if (typeof route !== "string" || route === "" || route === "/") return "";
  if (route.startsWith("#") || route.startsWith("?")) return route;
  return route;
}

/**
 * What one artifact needs to be served: the folder files may come from, the
 * entry inside it, and the URL the view opens. Pure, so it is testable without Electron.
 */
/** Encode each path segment, so `?`, `#` and `%` in file names stay part of the path. */
const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");
/** JSON that is safe inside an inline script. */
const scriptJson = (value) => JSON.stringify(value).replace(/</gu, "\\u003c");

export function artifactViewPlan(artifact, threadFolder) {
  const kind = artifact?.kind;
  if (kind === "url") {
    const base = String(artifact.source?.url ?? "");
    const route = routePath(artifact.part?.route);
    const url = route === "" ? base : route.startsWith("/") ? new URL(route, base).href : `${base}${route}`;
    return Object.freeze({ kind, url, address: url, folder: null, entry: null });
  }
  if (!FILE_KINDS.has(kind)) throw new TypeError(`Unsupported artifact kind: ${kind}`);
  const file = String(artifact.source?.file ?? "");
  const folder = kind === "website" ? resolve(threadFolder, String(artifact.source?.root ?? ".")) : dirname(resolve(threadFolder, file));
  const entry = relative(folder, resolve(threadFolder, file)).split(sep).join("/");
  const part = artifact.part ?? {};
  let url;
  if (kind === "website") {
    const route = routePath(part.route);
    url = route.startsWith("/") && route !== "" ? `${ORIGIN}${route}` : `${ORIGIN}/${encodePath(entry)}${route}`;
  } else if (kind === "pdf") {
    url = `${ORIGIN}/${encodePath(entry)}${Number.isSafeInteger(part.page) ? `#page=${part.page}` : ""}`;
  } else {
    const query = new URLSearchParams({ kind, file: entry });
    if (kind === "video" && typeof part.start === "number" && typeof part.end === "number") {
      query.set("start", String(part.start));
      query.set("end", String(part.end));
    }
    if (kind === "markdown" && typeof part.heading === "string") query.set("heading", part.heading);
    url = `${ORIGIN}/__relayer/view?${query}`;
  }
  const address = `${file}${kind === "website" ? routePath(part.route) : kind === "pdf" && part.page ? ` · page ${part.page}` : ""}`;
  return Object.freeze({ kind, url, address, folder, entry, file: resolve(threadFolder, file), source: file, thread: resolve(threadFolder) });
}

function viewerPage(kind, file, query) {
  const shell = (body, extraHead = "") => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;background:#1c1d1f;color:#e8e6e3;font:15px/1.55 -apple-system,system-ui,sans-serif}.center{min-height:100%;display:grid;place-items:center}</style>${extraHead}</head><body>${body}</body></html>`;
  const src = `/${encodePath(file)}`;
  if (kind === "image") {
    return shell(`<div class="center"><img id="picture" src="${src}" alt="" style="max-width:100%;max-height:100vh;object-fit:contain;cursor:zoom-in"></div>
<script>picture.onclick=()=>{const fit=picture.style.maxWidth==="100%";picture.style.maxWidth=fit?"none":"100%";picture.style.maxHeight=fit?"none":"100vh";picture.style.cursor=fit?"zoom-out":"zoom-in";};</script>`);
  }
  if (kind === "video") {
    const start = Number(query.get("start"));
    const end = Number(query.get("end"));
    const segment = query.has("start") && Number.isFinite(start) && Number.isFinite(end) && end > start ? [start, end] : null;
    const label = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    return shell(`<div class="center" style="padding:24px;box-sizing:border-box"><div style="width:min(100%,1100px)">
<video id="video" controls preload="auto" style="width:100%;border-radius:10px;background:#000" src="${src}"></video>
${segment ? `<p id="segment" style="opacity:.8">Showing ${label(segment[0])}–${label(segment[1])} · <a href="#" id="whole" style="color:#9fd8d2">Play the whole video</a></p>` : ""}</div></div>
<script>let segment=${JSON.stringify(segment)};
const start=()=>{if(segment)video.currentTime=segment[0];};
if(video.readyState>=1)start();else video.addEventListener("loadedmetadata",start,{once:true});
video.addEventListener("timeupdate",()=>{if(segment&&video.currentTime>=segment[1]){video.pause();video.currentTime=segment[1];}});
video.addEventListener("play",()=>{if(segment&&(video.currentTime<segment[0]||video.currentTime>=segment[1]))video.currentTime=segment[0];});
document.getElementById("whole")?.addEventListener("click",(event)=>{event.preventDefault();segment=null;video.currentTime=0;video.play();document.getElementById("segment").textContent="Playing the whole video";});</script>`);
  }
  if (kind === "markdown") {
    return shell(`<article id="doc" style="max-width:760px;margin:0 auto;padding:48px 28px 70vh;box-sizing:border-box;background:#fbfaf7;color:#1d2a2a;min-height:100%"></article>`,
      `<style>html,body{background:#fbfaf7}#doc h1{font-size:34px;letter-spacing:-.02em}#doc table{border-collapse:collapse}#doc td,#doc th{border:1px solid #ddd;padding:6px 10px}#doc code{background:#eee;padding:1px 5px;border-radius:4px}#doc img{max-width:100%}</style><script src="/__relayer/marked.js"></script><base href="/">`)
      .replace("</body>", `<script>fetch(${scriptJson(src)}).then((r)=>{if(!r.ok)throw new Error("The file is not in the thread folder.");return r.text();}).then((text)=>{doc.innerHTML=marked.parse(text);
for(const h of doc.querySelectorAll("h1,h2,h3,h4"))h.id=h.textContent.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
const heading=${scriptJson(query.get("heading") ?? "")};
if(heading){const want=heading.toLowerCase();const target=[...doc.querySelectorAll("h1,h2,h3,h4")].find((h)=>h.textContent.trim().toLowerCase()===want||h.id===want);target?.scrollIntoView();}
}).catch((error)=>{doc.textContent=error.message;console.error(error.message);});</script></body>`);
  }
  return shell(`<p class="center">Unsupported artifact.</p>`);
}

async function respondWithFile(path, request) {
  const info = await stat(path);
  const type = MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
  const range = /^bytes=(\d*)-(\d*)$/u.exec(request.headers.get("range") ?? "");
  if (range && (range[1] !== "" || range[2] !== "")) {
    const start = range[1] !== "" ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
    const end = range[1] !== "" && range[2] !== "" ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${info.size}` } });
    }
    return new Response(Readable.toWeb(createReadStream(path, { start, end })), {
      status: 206,
      headers: { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${info.size}`, "Content-Length": String(end - start + 1), "Cache-Control": "no-store" },
    });
  }
  return new Response(Readable.toWeb(createReadStream(path)), {
    status: 200,
    headers: { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": String(info.size), "Cache-Control": "no-store" },
  });
}

/** Serve one artifact's folder. Every path is resolved through links and must stay inside it. */
export function createArtifactRequestHandler({ getPlan, markedPath }) {
  return async (request) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
      const plan = getPlan();
      const url = new URL(request.url);
      if (plan === null || url.host !== "view") return new Response("Not found", { status: 404 });
      if (url.pathname === "/__relayer/marked.js") {
        return new Response(await readFile(markedPath), { headers: { "Content-Type": "text/javascript" } });
      }
      if (url.pathname === "/__relayer/view") {
        return new Response(viewerPage(url.searchParams.get("kind"), url.searchParams.get("file") ?? "", url.searchParams), {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      // The root itself must still be inside the thread folder: a folder swapped for a link after acceptance serves nothing.
      const root = await realpath(plan.folder);
      if (!inside(await realpath(plan.thread), root)) return new Response("Not found", { status: 404 });
      const decoded = decodeURIComponent(url.pathname);
      const wanted = resolve(root, `.${decoded === "/" ? `/${plan.entry}` : decoded}`);
      if (decoded.includes("\0") || !inside(root, wanted)) return new Response("Not found", { status: 404 });
      let real;
      try {
        real = await realpath(wanted);
      } catch {
        return new Response("Not found", { status: 404 });
      }
      // A folder link serves its index.html, as a web server would.
      if (inside(root, real) && (await stat(real)).isDirectory()) real = await realpath(join(real, "index.html")).catch(() => real);
      if (!inside(root, real) || !(await stat(real)).isFile()) return new Response("Not found", { status: 404 });
      return await respondWithFile(real, request);
    } catch {
      return new Response("Not found", { status: 404 });
    }
  };
}

/** Whether the viewer should report this file artifact as missing or changed since acceptance. */
export async function artifactFileStatus(plan, accepted) {
  if (plan.kind === "url") return { state: "ok" };
  try {
    const rootOrFile = plan.kind === "website" ? plan.folder : plan.file;
    await stat(plan.file);
    const current = await fingerprintPath(await realpath(rootOrFile));
    return { state: typeof accepted === "string" && accepted !== current ? "changed" : "ok", current };
  } catch {
    return { state: "missing" };
  }
}

// Chromium's PDF viewer does not start in an in-memory session, so artifact partitions
// are persistent and cleared on every open and close instead.
async function clearSession(ses) {
  await ses.clearStorageData();
  await ses.clearCache();
}

const hardened = new WeakSet();

/** Serve the session's current plan on the artifact scheme and refuse every permission and download. */
function hardenArtifactSession(ses, { getPlan, rendererDirectory }) {
  if (hardened.has(ses)) return;
  hardened.add(ses);
  ses.protocol.handle(ARTIFACT_SCHEME, createArtifactRequestHandler({
    getPlan,
    markedPath: join(rendererDirectory, "vendor", "marked.umd.js"),
  }));
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler?.(() => false);
  ses.on("will-download", (event) => event.preventDefault());
}

/** Artifacts never get a preload, Node or webviews; only PDFs get the PDF plugin. */
function artifactWebPreferences(plan, partition, devTools = false) {
  return {
    partition,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    plugins: plan.kind === "pdf",
    spellcheck: false,
    devTools,
  };
}

/** Whether a navigation stays on the artifact: its own site, or the artifact scheme. */
function staysOnArtifact(plan, url) {
  const allowedOrigin = plan.kind === "url" ? new URL(plan.url).origin : ORIGIN;
  try { return new URL(url).origin === allowedOrigin || (plan.kind !== "url" && url.startsWith(`${ORIGIN}/`)); } catch { return false; }
}

/** Screen sizes a website or URL may ask for; the renderer's device frame uses the same. */
const ARTIFACT_VIEWPORTS = Object.freeze({ phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 } });

/** The preview's size: the device a site asks for, otherwise the graph frame. */
export function artifactPreviewSize(artifact, size) {
  return ["website", "url"].includes(artifact?.kind) ? ARTIFACT_VIEWPORTS[artifact.viewport] ?? size : size;
}

/** How long a loaded artifact settles before capture: PDFs and video paint late. */
export function artifactPreviewSettleMs(kind) {
  return ({ pdf: 1500, video: 1200 })[kind] ?? 600;
}

/**
 * Agent previews of artifact layers (PRD 6.6, ART-005): the agent sees the artifact
 * itself before acceptance, captured in a hidden window with the viewer's isolation.
 * Links and popups go nowhere. Captures run one at a time on one cleared partition.
 */
export function createArtifactPreviewCapture({ BrowserWindow, session, rendererDirectory, maxBytes = 2 * 1024 * 1024 }) {
  const partition = "persist:artifact-preview";
  let plan = null;
  let previous = Promise.resolve();
  const capture = async ({ artifact, folder, size }) => {
    const ses = session.fromPartition(partition, { cache: false });
    hardenArtifactSession(ses, { getPlan: () => plan, rendererDirectory });
    if (artifact?.kind !== "url" && typeof folder !== "string") throw new Error("The artifact's thread folder is unknown.");
    plan = artifactViewPlan(artifact, folder);
    if (plan.kind !== "url" && !(await stat(plan.file).then((info) => info.isFile(), () => false))) throw new Error("The artifact file is missing.");
    await clearSession(ses);
    // Like graph previews, a file artifact's preview loads nothing from the network.
    ses.webRequest.onBeforeRequest((details, callback) => callback({
      cancel: plan !== null && plan.kind !== "url" && /^(https?|wss?|ftp):/u.test(details.url),
    }));
    const viewport = artifactPreviewSize(artifact, size);
    const window = new BrowserWindow({
      show: false,
      width: viewport.width,
      height: viewport.height,
      useContentSize: true,
      paintWhenInitiallyHidden: true,
      webPreferences: { ...artifactWebPreferences(plan, partition), backgroundThrottling: false },
    });
    const contents = window.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    const guard = (event, url) => { if (!staysOnArtifact(plan, url)) event.preventDefault(); };
    contents.on("will-navigate", guard);
    contents.on("will-redirect", guard);
    contents.on("will-attach-webview", (event) => event.preventDefault());
    let deadline;
    try {
      return await Promise.race([
        (async () => {
          await contents.loadURL(plan.url);
          await new Promise((done) => setTimeout(done, artifactPreviewSettleMs(plan.kind)));
          // Report logical pixels, like graph previews; a photo-heavy page can exceed the cap, so halve it until it fits.
          let image = await contents.capturePage();
          if (image.getSize().width !== viewport.width) image = image.resize({ width: viewport.width, height: viewport.height, quality: "best" });
          let png = image.toPNG();
          while (png.length > maxBytes && image.getSize().width > 200) {
            image = image.resize({ width: Math.round(image.getSize().width / 2), quality: "best" });
            png = image.toPNG();
          }
          const { width, height } = image.getSize();
          return { png: new Uint8Array(png), width, height };
        })(),
        new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("Artifact preview timed out")), 15_000); }),
      ]);
    } finally {
      clearTimeout(deadline);
      if (!window.isDestroyed()) window.destroy();
      plan = null;
      ses.webRequest.onBeforeRequest(null);
      await clearSession(ses).catch(() => {});
    }
  };
  return function render(input) {
    const pending = previous.then(() => capture(input));
    previous = pending.catch(() => {});
    return pending;
  };
}

export function createArtifactViewerService({
  WebContentsView,
  session,
  shell,
  getWindow,
  resolveThreadFolder,
  rendererDirectory,
  devTools = false,
}) {
  const plans = new Map();
  let current = null;
  // Each open or close takes a new token; an open that a later one overtook discards its view.
  let latest = 0;

  const send = (event) => {
    try { getWindow()?.webContents.send("relayer:artifact-viewer-event", event); } catch {}
  };

  function partitionFor(threadId, nodeId) {
    return `persist:artifact-${threadId}-${nodeId}`;
  }

  async function prepareSession(partition) {
    const ses = session.fromPartition(partition, { cache: false });
    hardenArtifactSession(ses, { getPlan: () => plans.get(partition) ?? null, rendererDirectory });
    // Nothing persists between opens.
    await clearSession(ses);
    return ses;
  }

  function close() {
    latest += 1;
    const view = current?.view;
    if (current) plans.delete(current.partition);
    current = null;
    if (!view) return;
    const ses = view.webContents.session;
    try { getWindow()?.contentView.removeChildView(view); } catch {}
    try { view.webContents.close(); } catch {}
    void clearSession(ses).catch(() => {});
  }

  async function open({ threadId, nodeId, artifact, bounds }) {
    if (!Number.isSafeInteger(threadId) || threadId < 1 || !Number.isSafeInteger(nodeId) || nodeId < 1) {
      throw new TypeError("The artifact viewer needs a thread and node.");
    }
    close();
    const token = latest;
    const window = getWindow();
    if (!window) throw new Error("The Relayer window is not open.");
    const threadFolder = artifact?.kind === "url" ? null : await resolveThreadFolder(threadId);
    const plan = artifactViewPlan(artifact, threadFolder);
    const status = await artifactFileStatus(plan, artifact.fingerprint);
    const partition = partitionFor(threadId, nodeId);
    if (token !== latest) return { status: { state: "superseded" }, address: plan.address };
    plans.set(partition, plan);
    if (status.state === "missing") return { status, address: plan.address };
    await prepareSession(partition);
    if (token !== latest) return { status: { state: "superseded" }, address: plan.address };
    const view = new WebContentsView({ webPreferences: artifactWebPreferences(plan, partition, devTools) });
    const contents = view.webContents;
    const leave = (url) => {
      try {
        const target = new URL(url);
        if (target.protocol === "http:" || target.protocol === "https:") void shell.openExternal(target.href);
      } catch {}
    };
    contents.setWindowOpenHandler(({ url }) => {
      leave(url);
      send({ type: "external", url });
      return { action: "deny" };
    });
    const guard = (event, url) => {
      if (staysOnArtifact(plan, url)) return;
      event.preventDefault();
      leave(url);
      send({ type: "external", url });
    };
    contents.on("will-navigate", guard);
    contents.on("will-redirect", guard);
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("console-message", (event) => {
      const level = event.level ?? event.params?.level;
      if (level === "error") send({ type: "page-error", message: String(event.message ?? "").slice(0, 500) });
    });
    contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) send({ type: "load-failed", message: `${description} (${url})` });
    });
    contents.on("did-navigate-in-page", (_event, url) => send({ type: "address", url }));
    contents.on("did-navigate", (_event, url) => send({ type: "address", url }));
    contents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && input.key === "Escape") {
        event.preventDefault();
        send({ type: "escape" });
      }
    });
    contents.on("render-process-gone", () => send({ type: "load-failed", message: "The artifact stopped responding." }));
    current = { view, plan, partition };
    window.contentView.addChildView(view);
    setBounds(bounds);
    view.setBackgroundColor("#1c1d1f");
    await contents.loadURL(plan.url).catch((error) => send({ type: "load-failed", message: error.message }));
    return { status, address: plan.address };
  }

  function setBounds(bounds) {
    if (!current) return;
    const valid = bounds && ["x", "y", "width", "height"].every((key) => Number.isFinite(bounds[key]) && bounds[key] >= 0);
    if (!valid) return;
    current.view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
    });
  }

  async function openExternally() {
    if (!current) return false;
    const { plan } = current;
    if (plan.kind === "url") {
      await shell.openExternal(plan.url);
      return true;
    }
    // Open only the file that is still inside the thread folder, never what a link now points to.
    const real = await realpath(plan.file).catch(() => null);
    if (real === null || !inside(await realpath(plan.thread), real) || extname(real).toLowerCase() !== extname(plan.file).toLowerCase()) return false;
    const error = await shell.openPath(real);
    return error === "";
  }

  return Object.freeze({ open, close, setBounds, openExternally, isOpen: () => current !== null, currentPlan: () => current?.plan ?? null, currentContents: () => current?.view.webContents ?? null });
}

export const artifactViewerTesting = Object.freeze({ viewerPage, ORIGIN, basename });
