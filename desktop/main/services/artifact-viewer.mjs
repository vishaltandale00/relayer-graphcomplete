// The artifact viewer (PRD 6.6, ADR 0014). Agent-made content renders in its own
// WebContentsView on its own partition, never in the main window. Files
// come from the thread folder through the `relayer-artifact:` scheme, which serves
// only paths inside the artifact's folder and answers byte ranges for media.
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";

// The host's own fingerprint, so drift is computed exactly as acceptance pinned it.
import { fingerprintPath } from "@relayer/harness-host";

export const ARTIFACT_SCHEME = "relayer-artifact";
const ORIGIN = `${ARTIFACT_SCHEME}://view`;
const OFFICE_KINDS = new Set(["docx", "xlsx", "pptx"]);
const FILE_KINDS = new Set(["website", "pdf", "video", "image", "markdown", ...OFFICE_KINDS]);
/** Viewer scripts the artifact scheme serves from the renderer's vendor folder. */
const VENDOR_SCRIPTS = Object.freeze({ "/__relayer/marked.js": "marked.umd.js", "/__relayer/office.js": "artifact-office.js" });

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
/** Media in every frame pauses while the user writes a note, then resumes. */
const PAUSE_MEDIA_SCRIPT = `window.__relayerNotePaused = [...document.querySelectorAll("video,audio")].filter((m) => !m.paused); window.__relayerNotePaused.forEach((m) => m.pause());`;
const RESUME_MEDIA_SCRIPT = `(window.__relayerNotePaused || []).forEach((m) => m.play().catch(() => {})); window.__relayerNotePaused = [];`;
async function eachFrame(contents, script) {
  await Promise.all(contents.mainFrame.framesInSubtree.map((frame) => frame.executeJavaScript(script).catch(() => {})));
}

/** Distinct page errors reported per open. */
const MAX_PAGE_ERRORS = 50;

/** A blank page at the artifact's own origin, where its starting state is written before it loads. */
const SEED_PATH = "/__relayer/seed";

/** Encode each path segment, so `?`, `#` and `%` in file names stay part of the path. */
const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");
/** JSON that is safe inside an inline script. */
const scriptJson = (value) => JSON.stringify(value).replace(/</gu, "\\u003c");

/** Deployed sites and web apps are addressed by URL; every other kind is a file in the thread folder. */
export const addressedByUrl = (kind) => kind === "url" || kind === "app";

export function artifactViewPlan(artifact, threadFolder) {
  const kind = artifact?.kind;
  if (addressedByUrl(kind)) {
    const base = String(artifact.source?.url ?? "");
    const route = routePath(artifact.part?.route);
    // A `?` or `#` part replaces the base's own query or fragment; a path resolves against it.
    const parsed = new URL(base);
    if (route.startsWith("?")) parsed.search = route;
    else if (route.startsWith("#")) parsed.hash = route;
    const url = route === "" ? base : route.startsWith("/") ? new URL(route, base).href : parsed.href;
    // A route opens a place in the artifact, never another site.
    if (new URL(url).origin !== new URL(base).origin) throw new TypeError("An artifact route must stay on the artifact's own address.");
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
    if (kind === "pptx" && Number.isSafeInteger(part.slide)) query.set("slide", String(part.slide));
    url = `${ORIGIN}/__relayer/view?${query}`;
  }
  const address = `${file}${kind === "website" ? routePath(part.route) : kind === "pdf" && part.page ? ` · page ${part.page}` : kind === "pptx" && part.slide ? ` · slide ${part.slide}` : ""}`;
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
document.addEventListener("click",(event)=>{const link=event.target.closest?.('a[href^="#"]');if(!link)return;event.preventDefault();document.getElementById(decodeURIComponent(link.getAttribute("href").slice(1)))?.scrollIntoView();});
}).catch((error)=>{doc.textContent=error.message;console.error(error.message);});</script></body>`);
  }
  if (OFFICE_KINDS.has(kind)) {
    const slide = Number(query.get("slide"));
    return shell(`<main id="office"></main><script src="/__relayer/office.js"></script>
<script>relayerOffice.render(${scriptJson(kind)}, ${scriptJson(src)}, { slide: ${Number.isSafeInteger(slide) && slide >= 1 ? slide : "null"} });</script>`, `<style>${OFFICE_STYLES}</style>`);
  }
  return shell(`<p class="center">Unsupported artifact.</p>`);
}

/** Word pages on grey, Excel as a light sheet with tabs, PowerPoint slides scaled to the width. */
const OFFICE_STYLES = `#office[data-kind="docx"] .docx-wrapper{background:#2a2b2e;padding:32px 16px}
#office[data-kind="xlsx"]{min-height:100%;background:#fbfaf7;color:#1d2a2a}
.office-sheet-tabs{position:sticky;top:0;display:flex;gap:4px;padding:10px 16px;background:#eceae4;border-bottom:1px solid #d6d3cb}
.office-sheet-tab{border:1px solid transparent;border-radius:6px;padding:4px 12px;background:none;font:inherit;color:inherit;cursor:pointer}
.office-sheet-tab[aria-selected="true"]{background:#fff;border-color:#d6d3cb;font-weight:600}
.office-sheet{padding:16px;overflow:auto}.office-sheet-limit{margin:0 0 12px;color:#6b6a65}.office-sheet table{border-collapse:collapse;font-variant-numeric:tabular-nums}
.office-sheet td{border:1px solid #dcd9d1;padding:4px 10px;white-space:nowrap}.office-sheet td[data-t="n"]{text-align:right}
#office[data-kind="pptx"]{display:flex;flex-direction:column;align-items:center;padding:24px 0}
.office-slide{zoom:var(--slide-zoom,1);position:relative;width:960px;height:540px;margin-bottom:24px;overflow:hidden;background:#fff;box-shadow:0 8px 30px rgba(0,0,0,.45)}
.office-error{padding:48px;text-align:center}`;

async function respondWithFile(path, request, root) {
  // Open without following a link swapped in after the containment check, then stream
  // from that descriptor, never from the pathname again.
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  const info = await handle.stat();
  // O_NOFOLLOW covers only the last name. The file opened must still be the one at this
  // path inside the folder, so a parent folder swapped for a link meanwhile serves nothing.
  const resolved = await realpath(path).catch(() => null);
  const there = resolved && inside(root, resolved) ? await stat(resolved).catch(() => null) : null;
  if (!info.isFile() || there?.dev !== info.dev || there?.ino !== info.ino) {
    await handle.close();
    return new Response("Not found", { status: 404 });
  }
  const stream = (options = {}) => Readable.toWeb(handle.createReadStream({ ...options, autoClose: true }));
  const type = MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
  const range = /^bytes=(\d*)-(\d*)$/u.exec(request.headers.get("range") ?? "");
  if (range && (range[1] !== "" || range[2] !== "")) {
    const start = range[1] !== "" ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
    const end = range[1] !== "" && range[2] !== "" ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) {
      await handle.close();
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${info.size}` } });
    }
    return new Response(stream({ start, end }), {
      status: 206,
      headers: { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${info.size}`, "Content-Length": String(end - start + 1), "Cache-Control": "no-store" },
    });
  }
  return new Response(stream(), {
    status: 200,
    headers: { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": String(info.size), "Cache-Control": "no-store" },
  });
}

/** Serve one artifact's folder. Every path is resolved through links and must stay inside it. */
/** `vendorDirectory` holds the viewer scripts in VENDOR_SCRIPTS. */
export function createArtifactRequestHandler({ getPlan, vendorDirectory }) {
  return async (request) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
      const plan = getPlan();
      const url = new URL(request.url);
      if (plan === null || url.host !== "view") return new Response("Not found", { status: 404 });
      if (url.pathname === SEED_PATH) {
        return new Response("<!doctype html><title></title>", { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
      }
      if (Object.hasOwn(VENDOR_SCRIPTS, url.pathname)) {
        return new Response(await readFile(join(vendorDirectory, VENDOR_SCRIPTS[url.pathname])), { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
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
        // A single-page site's client route (/pricing) is not a file: serve its entry.
        if (plan.kind !== "website" || extname(decoded) !== "") return new Response("Not found", { status: 404 });
        real = await realpath(resolve(root, plan.entry)).catch(() => null);
        if (real === null) return new Response("Not found", { status: 404 });
      }
      // A folder link serves its index.html, as a web server would.
      if (inside(root, real) && (await stat(real)).isDirectory()) real = await realpath(join(real, "index.html")).catch(() => real);
      if (!inside(root, real) || !(await stat(real)).isFile()) return new Response("Not found", { status: 404 });
      return await respondWithFile(real, request, root);
    } catch {
      return new Response("Not found", { status: 404 });
    }
  };
}

/** Whether the viewer should report this file artifact as missing or changed since acceptance. */
export async function artifactFileStatus(plan, accepted) {
  if (addressedByUrl(plan.kind)) return { state: "ok" };
  try {
    await stat(plan.file);
    // What the viewer would refuse to serve is unavailable, not hashed: a root outside the
    // thread folder, or a file linked out of the folder it is served from.
    const root = await realpath(plan.folder);
    const target = plan.kind === "website" ? root : await realpath(plan.file);
    if (!inside(await realpath(plan.thread), root) || !inside(root, target)) return { state: "missing" };
    let current;
    try {
      current = await fingerprintPath(target);
    } catch (error) {
      // A site root that grew past the host's bounds is shown, but not hashed in main.
      if (error?.code === "artifact_too_large") return { state: "unchecked" };
      throw error;
    }
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

/**
 * A website may load internet assets such as fonts (PRD 6.6.4); every other file kind
 * loads nothing from the network, not even a link an Office document points at.
 */
export function blocksNetwork(plan, url) {
  return plan != null && !addressedByUrl(plan.kind) && plan.kind !== "website" && /^(https?|wss?|ftp):/u.test(url);
}

/**
 * Serve the session's current plan on the artifact scheme, keep file kinds off the network,
 * and refuse every permission and download. The viewer and agent previews both use it.
 */
function hardenArtifactSession(ses, { getPlan, rendererDirectory }) {
  if (hardened.has(ses)) return;
  hardened.add(ses);
  ses.protocol.handle(ARTIFACT_SCHEME, createArtifactRequestHandler({
    getPlan,
    vendorDirectory: join(rendererDirectory, "vendor"),
  }));
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: blocksNetwork(getPlan(), details.url) }));
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
  const allowedOrigin = addressedByUrl(plan.kind) ? new URL(plan.url).origin : ORIGIN;
  try { return new URL(url).origin === allowedOrigin || (!addressedByUrl(plan.kind) && url.startsWith(`${ORIGIN}/`)); } catch { return false; }
}

/** Screen sizes a website or URL may ask for; the renderer's device frame uses the same. */
const ARTIFACT_VIEWPORTS = Object.freeze({ phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 } });

/** The preview's size: the device a site asks for, otherwise the graph frame. */
export function artifactPreviewSize(artifact, size) {
  return ["website", "url", "app"].includes(artifact?.kind) ? ARTIFACT_VIEWPORTS[artifact.viewport] ?? size : size;
}

/**
 * Wait until a loaded artifact is ready to capture. An Office page says when it has drawn,
 * up to 10 s; other kinds settle for a fixed time, since PDFs and video paint late.
 * `evaluate` runs a script in the page.
 */
export async function artifactPreviewSettled(kind, evaluate, timeoutMs = 10_000) {
  if (!OFFICE_KINDS.has(kind)) return new Promise((done) => setTimeout(done, ({ pdf: 1500, video: 1200 })[kind] ?? 600));
  await officeDrawn(evaluate, timeoutMs);
}

/**
 * Wait until an Office page says it has drawn (or failed to), up to `timeoutMs`. A page busy
 * parsing may never answer, so each check races the time left; one still drawing at the
 * deadline throws, so nothing captures a blank or half-drawn document.
 */
async function officeDrawn(evaluate, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    let timer;
    const expired = new Promise((done) => { timer = setTimeout(() => done(null), until - Date.now()); });
    const ready = await Promise.race([evaluate(`document.getElementById("office")?.dataset.ready ?? null`).catch(() => null), expired]);
    clearTimeout(timer);
    if (ready) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("The document did not finish drawing in time.");
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
    if (!addressedByUrl(artifact?.kind) && typeof folder !== "string") throw new Error("The artifact's thread folder is unknown.");
    plan = artifactViewPlan(artifact, folder);
    if (!addressedByUrl(plan.kind) && !(await stat(plan.file).then((info) => info.isFile(), () => false))) throw new Error("The artifact file is missing.");
    await clearSession(ses);
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
          // The agent previews the same starting state the viewer will apply.
          await applySeed(contents, plan, artifact.seed);
          await contents.loadURL(plan.url);
          await artifactPreviewSettled(plan.kind, (script) => contents.executeJavaScript(script));
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
      await clearSession(ses).catch(() => {});
    }
  };
  return function render(input) {
    const pending = previous.then(() => capture(input));
    previous = pending.catch(() => {});
    return pending;
  };
}

/**
 * Starting state (PRD 6.6.7). The view's storage was just cleared; write the seed at
 * the artifact's origin before its own scripts run. Cookies need an http origin, so
 * only web apps take them.
 */
async function applySeed(contents, plan, seed) {
  if (!seed) return;
  // Node gives custom schemes an opaque origin, so file kinds name the viewer's own.
  const origin = addressedByUrl(plan.kind) ? new URL(plan.url).origin : ORIGIN;
  if (addressedByUrl(plan.kind)) {
    for (const cookie of seed.cookies ?? []) {
      await contents.session.cookies.set({ url: `${origin}/`, name: cookie.name, value: cookie.value, path: cookie.path ?? "/" });
    }
  }
  const entries = Object.entries(seed.localStorage ?? {});
  if (entries.length === 0) return;
  const blank = `${origin}${SEED_PATH}`;
  // A web app's server never sees the seed page: this one load is answered here.
  if (addressedByUrl(plan.kind)) contents.session.protocol.handle("http", () => new Response("<!doctype html><title></title>", { headers: { "Content-Type": "text/html" } }));
  try {
    await contents.loadURL(blank);
  } finally {
    if (addressedByUrl(plan.kind)) contents.session.protocol.unhandle("http");
  }
  await contents.executeJavaScript(`(() => { for (const [key, value] of ${scriptJson(entries)}) localStorage.setItem(key, value); })()`);
}

/**
 * Where the user is in an artifact, for a note (PRD 6.6.8): the route and scroll
 * position, the video time, or the heading in view. Runs in the artifact's page;
 * the result is display text only.
 */
const NOTE_LOCATION_SCRIPT = `(() => {
  const video = document.querySelector("video");
  const doc = document.querySelector("#doc");
  const headings = doc ? [...doc.querySelectorAll("h1,h2,h3,h4")].filter((h) => h.getBoundingClientRect().top <= 80) : [];
  const office = typeof window.relayerOfficeLocation === "function" ? window.relayerOfficeLocation() : {};
  return { time: video ? video.currentTime : null, heading: office.heading ?? headings.at(-1)?.textContent ?? null, slide: office.slide ?? null, sheet: office.sheet ?? null, scroll: scrollY };
})()`;

/**
 * The page reports numbers, plus the heading in view for Markdown and Word and the sheet
 * for Excel, each cut to 80 characters; the address comes from the view itself. A site can
 * still choose its own path and hash, so both are bounded.
 */
function noteLocation(plan, reported, url) {
  const time = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const seconds = Number(reported?.time);
  const scroll = Math.max(0, Math.round(Number(reported?.scroll) || 0));
  if (plan.kind === "video") return Number.isFinite(seconds) ? `at ${time(seconds)}` : "in the video";
  if (plan.kind === "image") return "the whole image";
  if (plan.kind === "pdf") return `in ${basename(plan.file)}${/#page=(\d+)/u.test(url) ? `, page ${url.match(/#page=(\d+)/u)[1]}` : ""}`;
  const text = (value) => String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, 80);
  if (plan.kind === "markdown" || plan.kind === "docx") {
    const heading = text(reported?.heading);
    return heading ? `under “${heading}”` : "at the top";
  }
  if (plan.kind === "pptx") {
    const slide = Number(reported?.slide);
    return Number.isSafeInteger(slide) && slide >= 1 ? `on slide ${slide}` : "in the deck";
  }
  if (plan.kind === "xlsx") return text(reported?.sheet) ? `on the “${text(reported.sheet)}” sheet` : "in the spreadsheet";
  let place = url;
  try { const parsed = new URL(url); place = `${parsed.pathname}${parsed.search}${parsed.hash}`; } catch {}
  return `at ${place.slice(0, 160)}${scroll > 0 ? `, scrolled ${scroll} px` : ""}`;
}

export function createArtifactViewerService({
  WebContentsView,
  session,
  shell,
  getWindow,
  resolveThread,
  serverRunner = null,
  rendererDirectory,
  notesDirectory = null,
  devTools = false,
}) {
  const plans = new Map();
  let current = null;
  // Each open or close takes a new token; an open that a later one overtook discards its view.
  let latest = 0;

  const send = (event) => {
    // The seed page is an implementation detail; the address never shows it.
    if (event.type === "address" && new URL(event.url, ORIGIN).pathname === SEED_PATH) return;
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
    // A web app's server starts its idle timer once no viewer shows it.
    if (current?.serverKey) serverRunner?.release(current.serverKey);
    current = null;
    if (!view) return;
    const ses = view.webContents.session;
    try { getWindow()?.contentView.removeChildView(view); } catch {}
    try { view.webContents.close(); } catch {}
    void clearSession(ses).catch(() => {});
  }

  async function open({ threadId, nodeId, artifact, bounds, approveServer = false }) {
    if (!Number.isSafeInteger(threadId) || threadId < 1 || !Number.isSafeInteger(nodeId) || nodeId < 1) {
      throw new TypeError("The artifact viewer needs a thread and node.");
    }
    close();
    const token = latest;
    const window = getWindow();
    if (!window) throw new Error("The Relayer window is not open.");
    const thread = artifact?.kind === "url" ? null : await resolveThread(threadId);
    const plan = artifactViewPlan(artifact, thread?.folder ?? null);
    const status = await artifactFileStatus(plan, artifact.fingerprint);
    const partition = partitionFor(threadId, nodeId);
    if (token !== latest) return { status: { state: "superseded" }, address: plan.address };
    if (status.state === "missing") return { status, address: plan.address };
    let serverKey = null;
    if (plan.kind === "app") {
      if (!serverRunner) return { status: { state: "server-failed", log: "Web apps need Relayer Desktop." }, address: plan.address };
      send({ type: "server-starting", command: artifact.server.command });
      const server = await serverRunner.ensure({
        threadId, nodeId, folder: thread.folder, permissionProfileId: thread.permissionProfileId,
        server: artifact.server, sourceUrl: artifact.source.url, approve: approveServer,
        // A server keeps logging after this open; only this open's starting card shows it.
        onLog: (text) => { if (token === latest) send({ type: "server-log", text }); },
      });
      if (server.state === "approval-required") return { status: { state: "approval-required", command: server.command, permissionProfileId: server.permissionProfileId }, address: plan.address };
      if (server.state === "failed") return { status: { state: "server-failed", log: server.log }, address: plan.address };
      serverKey = server.key;
      if (token !== latest) { serverRunner.release(serverKey); return { status: { state: "superseded" }, address: plan.address }; }
    }
    plans.set(partition, plan);
    try {
      await prepareSession(partition);
    } catch (error) {
      if (serverKey) serverRunner.release(serverKey);
      throw error;
    }
    if (token !== latest) {
      if (serverKey) serverRunner.release(serverKey);
      return { status: { state: "superseded" }, address: plan.address };
    }
    let view;
    try {
      view = new WebContentsView({ webPreferences: artifactWebPreferences(plan, partition, devTools) });
    } catch (error) {
      if (serverKey) serverRunner.release(serverKey);
      throw error;
    }
    const contents = view.webContents;
    // Events reach the renderer only while this view is the one shown; a closed view's
    // late load failure or console output never lands on the next artifact.
    const emit = (event) => { if (current?.view === view) send(event); };
    // The page never opens the user's browser itself. A link out only asks; Relayer's own
    // toolbar then offers it, and the user's click there opens exactly that address.
    const leave = (url) => {
      try {
        const target = new URL(url);
        if (target.protocol !== "http:" && target.protocol !== "https:") return;
        if (current?.view === view) current.pendingLink = target.href;
        emit({ type: "external-request", url: target.href });
      } catch {}
    };
    contents.setWindowOpenHandler(({ url }) => {
      leave(url);
      return { action: "deny" };
    });
    const guard = (event, url) => {
      if (staysOnArtifact(plan, url)) return;
      event.preventDefault();
      leave(url);
    };
    contents.on("will-navigate", guard);
    contents.on("will-redirect", guard);
    contents.on("will-attach-webview", (event) => event.preventDefault());
    // A page can log errors without end; report each distinct one, up to a bound.
    const reportedErrors = new Set();
    contents.on("console-message", (event) => {
      const level = event.level ?? event.params?.level;
      if (level !== "error" || reportedErrors.size >= MAX_PAGE_ERRORS) return;
      const message = String(event.message ?? "").slice(0, 500);
      if (reportedErrors.has(message)) return;
      reportedErrors.add(message);
      emit({ type: "page-error", message });
    });
    contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) emit({ type: "load-failed", message: `${description} (${url})` });
    });
    contents.on("did-navigate-in-page", (_event, url) => emit({ type: "address", url }));
    contents.on("did-navigate", (_event, url) => {
      // Chromium keeps zoom per host; a new page keeps the device's scale.
      if (current?.view === view) contents.setZoomFactor(current.zoom ?? 1);
      emit({ type: "address", url });
    });
    contents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && input.key === "Escape") {
        event.preventDefault();
        emit({ type: "escape" });
      }
    });
    contents.on("render-process-gone", () => emit({ type: "load-failed", message: "The artifact stopped responding." }));
    current = { view, plan, partition, serverKey };
    window.contentView.addChildView(view);
    setBounds(bounds);
    view.setBackgroundColor("#1c1d1f");
    await applySeed(contents, plan, artifact.seed).catch((error) => emit({ type: "load-failed", message: `The starting state could not be applied: ${error.message}` }));
    await contents.loadURL(plan.url).catch((error) => emit({ type: "load-failed", message: error.message }));
    return { status, address: plan.address };
  }

  /**
   * Start a note (PRD 6.6.8): capture what the user sees, say where they are, and
   * pause playing media. The live view hides behind the captured image until endNote.
   */
  async function beginNote() {
    // Pin the view: the user may close or switch artifacts while the capture runs.
    const viewing = current;
    if (!viewing?.view || !notesDirectory) return null;
    const contents = viewing.view.webContents;
    // A capture can stall while Chromium paints no frames, and a busy page may never answer
    // a script; never leave the viewer waiting on either.
    const bounded = (promise) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("The view could not be captured.")), 5_000))]);
    // A note on an Office document captures it once drawn, never half-rendered; one that
    // does not finish drawing fails the note before anything is paused.
    if (OFFICE_KINDS.has(viewing.plan.kind)) await officeDrawn((script) => contents.executeJavaScript(script));
    // Anything that fails after the pause must resume the media it paused.
    let png;
    let digest;
    let created = false;
    let reported;
    try {
      await bounded(eachFrame(contents, PAUSE_MEDIA_SCRIPT));
      try {
        let image = await bounded(contents.capturePage());
        if (image.getSize().width > 1440) image = image.resize({ width: 1440, quality: "best" });
        png = image.toPNG();
      } catch {
        // capturePage needs a presented surface; the DevTools protocol does not.
        const attached = contents.debugger.isAttached();
        try {
          if (!attached) contents.debugger.attach("1.3");
          png = Buffer.from((await bounded(contents.debugger.sendCommand("Page.captureScreenshot", { format: "png" }))).data, "base64");
        } finally {
          if (!attached && contents.debugger.isAttached()) contents.debugger.detach();
        }
      }
      if (current !== viewing) return null;
      digest = createHash("sha256").update(png).digest("hex");
      await mkdir(notesDirectory, { recursive: true });
      // Screenshots are content-addressed: one an earlier note already holds stays its own.
      await writeFile(join(notesDirectory, `${digest}.png`), png, { mode: 0o600, flag: "wx" })
        .then(() => { created = true; }, (error) => { if (error.code !== "EEXIST") throw error; });
      reported = await bounded(contents.executeJavaScript(NOTE_LOCATION_SCRIPT)).catch(() => null);
    } catch (error) {
      if (current === viewing) await endNote();
      throw error;
    }
    if (current !== viewing) return null;
    viewing.noteDigest = created ? digest : null;
    viewing.view.setVisible(false);
    return { location: noteLocation(viewing.plan, reported, contents.getURL()), digest, screenshot: `data:image/png;base64,${png.toString("base64")}` };
  }

  /** End a note session; a screenshot this session wrote and no note kept is deleted. */
  async function endNote({ kept = true } = {}) {
    if (current?.noteDigest && !kept) await rm(join(notesDirectory, `${current.noteDigest}.png`), { force: true }).catch(() => {});
    if (current) current.noteDigest = null;
    if (!current?.view) return;
    current.view.setVisible(true);
    await eachFrame(current.view.webContents, RESUME_MEDIA_SCRIPT);
  }

  /** Open the link the artifact last asked for, after the user chose it in the toolbar. */
  async function openLink(url) {
    if (!current?.pendingLink || current.pendingLink !== url) return false;
    current.pendingLink = null;
    await shell.openExternal(url);
    return true;
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
    // A phone or tablet shown scaled down keeps its screen size in CSS pixels.
    current.zoom = bounds.scale > 0 && bounds.scale <= 1 ? bounds.scale : 1;
    current.view.webContents.setZoomFactor(current.zoom);
  }

  async function openExternally() {
    if (!current) return false;
    const { plan } = current;
    if (addressedByUrl(plan.kind)) {
      await shell.openExternal(plan.url);
      return true;
    }
    // Open only the file that is still inside the thread folder, never what a link now points to.
    const real = await realpath(plan.file).catch(() => null);
    if (real === null || !inside(await realpath(plan.thread), real) || extname(real).toLowerCase() !== extname(plan.file).toLowerCase()) return false;
    const error = await shell.openPath(real);
    return error === "";
  }

  return Object.freeze({ open, close, setBounds, openExternally, openLink, beginNote, endNote, isOpen: () => current !== null, currentPlan: () => current?.plan ?? null, currentContents: () => current?.view.webContents ?? null });
}

export const artifactViewerTesting = Object.freeze({ viewerPage, noteLocation, NOTE_LOCATION_SCRIPT, ORIGIN, basename });
