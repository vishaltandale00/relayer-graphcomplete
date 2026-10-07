// PROTOTYPE — throwaway (issue #684). Not production code: no tests, minimal
// error handling. Runs the artifact viewer prototype against a fixture thread.
//
//   npm run prototype:artifact-viewer
//
// Three things run here:
// 1. A workspace origin (127.0.0.1) serving the real desktop renderer, the
//    prototype page, the case matrix, and stub endpoints (server invoke,
//    screenshots, fixture edits).
// 2. An artifact origin per artifact node (n-<slug>.localhost), standing in for
//    an isolated Electron partition. Agent content runs only there.
// 3. Child processes for the apps the server invoke starts.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative, resolve, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const rendererRoot = join(repositoryRoot, "desktop/renderer");
const fixtureRoot = join(repositoryRoot, "scripts/fixtures/artifact-viewer-prototype");
const threadFolder = join(fixtureRoot, "thread-folder");
const libCache = join(tmpdir(), "relayer-artifact-viewer-prototype-libs");
const IDLE_MS = Number(process.env.PROTO_IDLE_MS || 60_000);
const SPEC_IDLE_MS = 60 * 60 * 1000;

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".pdf": "application/pdf", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".md": "text/markdown; charset=utf-8", ".json": "application/json", ".woff2": "font/woff2", ".jsonl": "application/x-ndjson",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

// Spec: supported kinds and the extensions each accepts (issue #684, D35).
const KIND_EXTENSIONS = {
  website: [".html"], pdf: [".pdf"], image: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"],
  video: [".mp4", ".webm", ".mov"], markdown: [".md"], docx: [".docx"], xlsx: [".xlsx"], pptx: [".pptx"],
};

const LIBS = {
  "pdf.mjs": "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs",
  "pdf.worker.mjs": "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs",
  "jszip.js": "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js",
  "docx-preview.js": "https://cdn.jsdelivr.net/npm/docx-preview@0.3.5/dist/docx-preview.min.js",
  "xlsx.js": "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
  "pptx-preview.js": "https://cdn.jsdelivr.net/npm/pptx-preview@1.0.7/dist/pptx-preview.umd.js",
};

async function freePort() {
  return new Promise((done, fail) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
    server.on("error", fail);
  });
}

// ---------------------------------------------------------------- integrity

async function hashPath(absolute) {
  const hash = createHash("sha256");
  const info = await stat(absolute);
  if (info.isFile()) {
    hash.update(await readFile(absolute));
    return `sha256:${hash.digest("hex")}`;
  }
  const files = [];
  async function walk(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  await walk(absolute);
  for (const file of files) {
    hash.update(relative(absolute, file));
    hash.update("\0");
    hash.update(await readFile(file));
  }
  return `sha256:${hash.digest("hex")}`;
}

// Deterministic submission rules (D22, D31): run when the agent submits the node.
async function resolveInside(relativePath) {
  if (typeof relativePath !== "string" || !relativePath || isAbsolute(relativePath)) {
    return { error: { code: "artifact_path_not_relative", message: `The artifact path "${relativePath}" must be relative to the thread folder.` } };
  }
  const lexical = resolve(threadFolder, relativePath);
  if (!lexical.startsWith(threadFolder + sep)) {
    return { error: { code: "artifact_path_outside_thread", message: `"${relativePath}" resolves outside the thread folder.` } };
  }
  if (!existsSync(lexical)) {
    return { error: { code: "artifact_file_missing", message: `"${relativePath}" does not exist in the thread folder.` } };
  }
  const real = await realpath(lexical);
  const realRoot = await realpath(threadFolder);
  if (!real.startsWith(realRoot + sep)) {
    return { error: { code: "artifact_path_outside_thread", message: `"${relativePath}" is a link that resolves outside the thread folder (${relative(realRoot, real)}).` } };
  }
  return { absolute: real };
}

async function validateArtifactLayer(resolvedLayer) {
  if (resolvedLayer.layer.renderer !== "artifact") return { ok: true };
  if (resolvedLayer.nodes.length !== 1) {
    return { ok: false, code: "artifact_layer_member_count", message: `An artifact layer must have exactly one member node; this one has ${resolvedLayer.nodes.length}.` };
  }
  const artifact = resolvedLayer.nodes[0].artifact;
  if (!artifact) return { ok: false, code: "artifact_details_missing", message: "The member node has no artifact details." };
  if (artifact.kind === "url") {
    let url;
    try { url = new URL(artifact.source.url); } catch { return { ok: false, code: "artifact_url_invalid", message: "The URL is not valid." }; }
    const loopback = ["localhost", "127.0.0.1"].includes(url.hostname);
    if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return { ok: true };
    return { ok: false, code: "artifact_url_scheme", message: `${url.protocol}// URLs are not allowed; use https, or http only for localhost.` };
  }
  if (artifact.kind === "app") {
    const url = new URL(artifact.source.app.readyUrl);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname)) {
      return { ok: false, code: "artifact_app_ready_url", message: "An app's ready URL must be http on localhost or 127.0.0.1." };
    }
    return { ok: true };
  }
  const allowed = KIND_EXTENSIONS[artifact.kind];
  const file = artifact.source.file;
  if (!allowed) return { ok: false, code: "artifact_kind_unsupported", message: `Unsupported artifact kind "${artifact.kind}".` };
  // Authority first: where the path points, then whether it is a supported type.
  const resolvedFile = await resolveInside(file);
  if (resolvedFile.error) return { ok: false, ...resolvedFile.error };
  if (!allowed.includes(extname(file ?? "").toLowerCase())) {
    return { ok: false, code: "artifact_type_unsupported", message: `"${file}" is not a supported ${artifact.kind} file (${allowed.join(", ")}).` };
  }
  if (artifact.source.root) {
    const root = await resolveInside(artifact.source.root);
    if (root.error) return { ok: false, ...root.error };
    if (!resolvedFile.absolute.startsWith(root.absolute + sep)) {
      return { ok: false, code: "artifact_entry_outside_root", message: "The entry file must be inside the site root." };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------- fixture graph

const ports = { app: await freePort(), kitchen: await freePort(), broken: await freePort() };

function layout(ids) {
  const spots = [[0.5, 0.18], [0.2, 0.42], [0.8, 0.42], [0.32, 0.74], [0.68, 0.74], [0.08, 0.86], [0.92, 0.86], [0.5, 0.95]];
  return { version: 1, placements: ids.map((nodeId, index) => ({ nodeId, x: spots[index][0], y: spots[index][1] })) };
}

function nav(id, sourceNodeId, sourceLayerId, targetLayerId, label, relation = "expand") {
  return { id, sourceNodeId, sourceLayerId, kind: "navigate", relation, label, variant: "pill", targetLayerId, state: "accepted" };
}

function serverInvoke(nodeSlug, { command, port, timeoutMs = 15_000 }) {
  return {
    id: `action:server-${nodeSlug}`, sourceNodeId: `node:${nodeSlug}`, sourceLayerId: `layer:${nodeSlug}`,
    kind: "invoke", invoke: "server", label: "Run the app", variant: "pill", interactionText: "Run the app", state: "accepted",
    server: { command, env: { PORT: String(port) }, readyUrl: `http://localhost:${port}/`, timeoutMs, idleTimeoutMs: SPEC_IDLE_MS },
  };
}

// One artifact layer = renderer decorator + exactly one artifact node (D30, D32, D34).
function artifactLayer(slug, { title, icon, artifact, actions = [] }) {
  const nodeId = `node:${slug}`;
  const layerId = `layer:${slug}`;
  return {
    layer: { id: layerId, nodes: [nodeId], edges: [], layout: layout([nodeId]), state: "accepted", renderer: "artifact" },
    nodes: [{ id: nodeId, kind: "artifact", icon, title, detail: "", state: "accepted", artifact }],
    edges: [],
    actions: actions.map((action) => ({ ...action, sourceNodeId: nodeId, sourceLayerId: layerId })),
  };
}

const cartSeed = JSON.stringify([
  { name: "Harbour Espresso", price: 4, qty: 2 },
  { name: "Kelp Cold Brew", price: 5.5, qty: 1 },
]);

const brandGuide = await readFile(join(threadFolder, "docs/brand-guide.md"), "utf8");
const staleBrandGuideHash = `sha256:${createHash("sha256").update(brandGuide.replace("Warm, plain and specific", "Bold, loud and playful")).digest("hex")}`;

async function buildFixture() {
  const site = { file: "site/index.html", root: "site" };
  const artifactLayers = [
    artifactLayer("art-site", { title: "Landing page", icon: "globe",
      artifact: { kind: "website", source: site, part: { route: "/" }, viewport: "desktop", state: null },
      actions: [
        nav("action:site-to-phone", null, null, "layer:art-site-phone", "Pricing on a phone"),
        nav("action:site-to-cart", null, null, "layer:art-site-cart", "Cart as a member"),
        nav("action:site-notes", null, null, "layer:site-notes", "Design notes", "reference"),
      ] }),
    artifactLayer("art-site-phone", { title: "Pricing on a phone", icon: "smartphone",
      artifact: { kind: "website", source: site, part: { route: "#pricing" }, viewport: "phone", state: null },
      actions: [nav("action:phone-notes", null, null, "layer:site-notes", "Design notes", "reference")] }),
    artifactLayer("art-site-cart", { title: "Cart as a signed-in member", icon: "shopping-cart",
      artifact: { kind: "website", source: site, part: { route: "#/cart" }, viewport: "desktop",
        state: { localStorage: { "tidewater.cart": cartSeed }, cookies: { tw_member: "Maya" } } } }),
    artifactLayer("art-app", { title: "Ordering app", icon: "app-window",
      artifact: { kind: "app", source: { app: { readyUrl: `http://localhost:${ports.app}/` } }, part: { route: "/" }, viewport: "desktop",
        state: { localStorage: { "tidewater.barista": "Maya (test account)" } } },
      actions: [serverInvoke("art-app", { command: "node ordering-app/server.mjs", port: ports.app })] }),
    artifactLayer("art-kitchen", { title: "Kitchen display (agent left it running)", icon: "server",
      artifact: { kind: "app", source: { app: { readyUrl: `http://localhost:${ports.kitchen}/` } }, part: { route: "/" }, viewport: "tablet", state: null },
      actions: [serverInvoke("art-kitchen", { command: "node ordering-app/server.mjs", port: ports.kitchen })] }),
    artifactLayer("art-pdf", { title: "Investor brief", icon: "file-text",
      artifact: { kind: "pdf", source: { file: "docs/investor-brief.pdf" }, part: { page: 1 } },
      actions: [nav("action:pdf-to-p4", null, null, "layer:art-pdf-p4", "Use of funds (page 4)")] }),
    artifactLayer("art-pdf-p4", { title: "Use of funds", icon: "file-text",
      artifact: { kind: "pdf", source: { file: "docs/investor-brief.pdf" }, part: { page: 4 } } }),
    artifactLayer("art-video", { title: "Promo video", icon: "clapperboard",
      artifact: { kind: "video", source: { file: "media/promo.webm" }, part: {} },
      actions: [nav("action:video-to-ship", null, null, "layer:art-video-ship", "Ship chapter (0:10–0:15)")] }),
    artifactLayer("art-video-ship", { title: "Ship chapter", icon: "video",
      artifact: { kind: "video", source: { file: "media/promo.mp4" }, part: { start: 10, end: 15 } } }),
    artifactLayer("art-hero", { title: "Hero image", icon: "image",
      artifact: { kind: "image", source: { file: "brand/hero.png" }, part: {} } }),
    artifactLayer("art-logo", { title: "Logo", icon: "palette",
      artifact: { kind: "image", source: { file: "site/logo.svg" }, part: {} } }),
    artifactLayer("art-guide", { title: "Brand guide", icon: "book-open",
      artifact: { kind: "markdown", source: { file: "docs/brand-guide.md" }, part: {} },
      actions: [nav("action:guide-to-colour", null, null, "layer:art-guide-colour", "Colour section")] }),
    artifactLayer("art-guide-colour", { title: "Brand colours", icon: "palette",
      artifact: { kind: "markdown", source: { file: "docs/brand-guide.md" }, part: { anchor: "colour" } } }),
    artifactLayer("art-docx", { title: "Wholesale proposal", icon: "file-text",
      artifact: { kind: "docx", source: { file: "docs/wholesale-proposal.docx" }, part: {} } }),
    artifactLayer("art-xlsx", { title: "2027 budget", icon: "table",
      artifact: { kind: "xlsx", source: { file: "docs/budget-2027.xlsx" }, part: {} } }),
    artifactLayer("art-pptx", { title: "Seed pitch deck", icon: "presentation",
      artifact: { kind: "pptx", source: { file: "docs/seed-pitch.pptx" }, part: {} } }),
    artifactLayer("art-url", { title: "Deployed site", icon: "link",
      artifact: { kind: "url", source: { url: "https://example.com/" }, part: {} } }),
    artifactLayer("art-drift", { title: "Brand guide (edited after acceptance)", icon: "file-question",
      artifact: { kind: "markdown", source: { file: "docs/brand-guide.md" }, part: {}, fingerprint: staleBrandGuideHash, prototypeAcceptedEarlier: true } }),
    artifactLayer("art-missing", { title: "Price list (deleted after acceptance)", icon: "file-x",
      artifact: { kind: "pdf", source: { file: "docs/price-list.pdf" }, part: {}, fingerprint: "sha256:0b1f…(file existed at acceptance)", prototypeAcceptedEarlier: true } }),
    artifactLayer("art-broken-app", { title: "Loyalty app (fails to start)", icon: "bug",
      artifact: { kind: "app", source: { app: { readyUrl: `http://localhost:${ports.broken}/` } }, part: {}, viewport: "desktop", state: null },
      actions: [serverInvoke("art-broken-app", { command: "node broken-app/server.mjs", port: ports.broken, timeoutMs: 8_000 })] }),
    artifactLayer("art-js-error", { title: "Menu board (page error)", icon: "triangle-alert",
      artifact: { kind: "website", source: { file: "site-broken/index.html", root: "site-broken" }, part: {}, viewport: "desktop", state: null } }),
  ];

  // Fingerprints are taken at acceptance (D36): files and site roots only.
  for (const resolved of artifactLayers) {
    const artifact = resolved.nodes[0].artifact;
    if (artifact.fingerprint || !artifact.source.file) continue;
    artifact.fingerprint = await hashPath(join(threadFolder, artifact.source.root ?? artifact.source.file));
  }

  const notes = {
    layer: { id: "layer:site-notes", nodes: ["node:notes-hero", "node:notes-pricing"], edges: ["edge:notes"], layout: layout(["node:notes-hero", "node:notes-pricing"]), state: "accepted" },
    nodes: [
      { id: "node:notes-hero", kind: "concept", icon: "layout-template", title: "Hero leads with freshness", detail: "Freshness is the top churn reason, so the hero promises a 72-hour roast-to-door window.", state: "accepted" },
      { id: "node:notes-pricing", kind: "concept", icon: "coffee", title: "Regular plan is featured", detail: "Two bags a month matches the median subscriber, so the Regular plan is highlighted.", state: "accepted" },
    ],
    edges: [{ id: "edge:notes", endpoints: ["node:notes-hero", "node:notes-pricing"], state: "accepted" }],
    actions: [],
  };

  const rootNodes = [
    ["node:website", "globe", "Landing page", "A static site in `site/` with home, menu, subscriptions and a cart that remembers items.", [
      ["layer:art-site", "Open the site"], ["layer:art-site-phone", "Pricing on a phone"], ["layer:art-site-cart", "Cart as a member"]]],
    ["node:app", "app-window", "Ordering app", "A small web app with an orders API. Relayer starts it when you open it.", [
      ["layer:art-app", "Open the app"], ["layer:art-kitchen", "Kitchen display"]]],
    ["node:brief", "file-text", "Investor brief", "A five-page PDF for the seed round.", [
      ["layer:art-pdf", "Read the brief"], ["layer:art-pdf-p4", "Use of funds (page 4)"]]],
    ["node:video", "clapperboard", "Promo video", "A 20-second promo in four chapters.", [
      ["layer:art-video", "Watch it"], ["layer:art-video-ship", "Ship chapter"]]],
    ["node:brand", "palette", "Brand assets", "Hero image, logo and the brand guide.", [
      ["layer:art-hero", "Hero image"], ["layer:art-logo", "Logo"], ["layer:art-guide", "Brand guide"], ["layer:art-guide-colour", "Colours"]]],
    ["node:docs", "book-open", "Office documents", "A Word proposal, an Excel budget and a PowerPoint deck.", [
      ["layer:art-docx", "Proposal (.docx)"], ["layer:art-xlsx", "Budget (.xlsx)"], ["layer:art-pptx", "Pitch deck (.pptx)"]]],
    ["node:live", "link", "Deployed site", "The preview deployment, reachable over https.", [["layer:art-url", "Open the deployment"]]],
    ["node:issues", "triangle-alert", "Things to check", "Artifacts that changed, disappeared or broke after the agent finished.", [
      ["layer:art-drift", "Edited after acceptance"], ["layer:art-missing", "Deleted file"], ["layer:art-broken-app", "App that fails to start"], ["layer:art-js-error", "Page with a script error"]]],
  ];
  const root = {
    layer: { id: "layer:root", nodes: rootNodes.map(([id]) => id), edges: [], layout: layout(rootNodes.map(([id]) => id)), state: "accepted" },
    nodes: rootNodes.map(([id, icon, title, detail]) => ({ id, kind: "concept", icon, title, detail, state: "accepted" })),
    edges: [],
    actions: rootNodes.flatMap(([id, , , , targets]) => targets.map(([targetLayerId, label], index) => nav(`action:${id.slice(5)}-${index}`, id, "layer:root", targetLayerId, label))),
  };
  for (const [left, right] of [["node:website", "node:app"], ["node:website", "node:brand"], ["node:brief", "node:video"], ["node:brief", "node:docs"], ["node:website", "node:live"], ["node:app", "node:issues"]]) {
    const id = `edge:${left.slice(5)}-${right.slice(5)}`;
    root.edges.push({ id, endpoints: [left, right], state: "accepted" });
    root.layer.edges.push(id);
  }

  const layers = [root, notes, ...artifactLayers];
  const header = {
    recordType: "header", exportVersion: 1, exportedAt: "2026-10-06T00:00:00Z",
    producer: { desktopVersion: "prototype", buildCommit: "prototype", platform: "darwin", architecture: "arm64" },
    conversation: { id: "conversation:artifact-viewer-prototype", title: "Tidewater launch kit", createdAt: "2026-10-06T00:00:00Z",
      projectName: "tidewater-launch", harnessConfigurationName: "prototype-fixture", permissionProfileId: "auto" },
    turns: [{ id: "turn:1", sequence: 1 }],
  };
  const turn = {
    recordType: "turn", id: "turn:1", sequence: 1, createdAt: "2026-10-06T00:01:00Z",
    text: "Build a launch kit for Tidewater Coffee: a website, an ordering app, an investor brief, a promo video, brand assets and the documents.",
    interactionNodeId: "node:interaction-1", origin: { kind: "user" },
    completion: { status: "accepted", permissionProfileId: "auto", harnessConfigurationName: "prototype-fixture", modelSelection: { providerId: "fixture", modelId: "fixture-model", modelFamilyId: 1 } },
    contexts: [], submittedInputs: [],
    acceptedView: {
      interactionNodeId: "node:interaction-1",
      rootAction: { id: "action:response-1", sourceNodeId: "node:interaction-1", sourceLayerId: null, kind: "navigate", relation: "expand", label: "Response", variant: "pill", targetLayerId: "layer:root", state: "accepted" },
      rootLayerId: "layer:root",
      layers,
    },
  };
  const snapshot = `${JSON.stringify(header)}\n${JSON.stringify(turn)}\n`;

  // Submission-time integrity cases the agent would get back as repairable errors.
  const rejected = [
    ["R1", "Path escapes with ..", artifactLayer("bad-escape", { title: "Secret", icon: "file-x", artifact: { kind: "markdown", source: { file: "../outside-thread/secret.txt" }, part: {} } })],
    ["R2", "Symlink that leaves the folder", artifactLayer("bad-link", { title: "Linked secret", icon: "file-x", artifact: { kind: "website", source: { file: "shared/secret.html", root: "shared" }, part: {} } })],
    ["R3", "Missing file", artifactLayer("bad-missing", { title: "Forecast", icon: "file-x", artifact: { kind: "pdf", source: { file: "docs/q3-forecast.pdf" }, part: {} } })],
    ["R4", "Unsupported type", artifactLayer("bad-type", { title: "Installer", icon: "file-x", artifact: { kind: "video", source: { file: "media/installer.exe" }, part: {} } })],
    ["R5", "Absolute path", artifactLayer("bad-absolute", { title: "Hosts", icon: "file-x", artifact: { kind: "markdown", source: { file: "/etc/hosts" }, part: {} } })],
    ["R6", "Plain http to a remote host", artifactLayer("bad-http", { title: "Insecure", icon: "link", artifact: { kind: "url", source: { url: "http://tidewater.example/" }, part: {} } })],
    ["R7", "App ready URL not on localhost", artifactLayer("bad-app", { title: "Remote app", icon: "server", artifact: { kind: "app", source: { app: { readyUrl: "https://tidewater.example/" } }, part: {} } })],
    ["R8", "Artifact layer with two nodes", (() => {
      const layer = artifactLayer("bad-two", { title: "Two things", icon: "file-x", artifact: { kind: "image", source: { file: "brand/hero.png" }, part: {} } });
      layer.nodes.push({ id: "node:bad-two-b", kind: "artifact", icon: "image", title: "Logo", detail: "", state: "accepted", artifact: { kind: "image", source: { file: "site/logo.svg" }, part: {} } });
      layer.layer.nodes.push("node:bad-two-b");
      return layer;
    })()],
  ];
  // R2 needs a real file behind the link so only the link rule can catch it.
  await writeFile(join(fixtureRoot, "outside-thread/secret.html"), "<h1>Outside the thread folder</h1>");
  const submission = [];
  for (const resolved of artifactLayers) {
    const artifact = resolved.nodes[0].artifact;
    const result = artifact.prototypeAcceptedEarlier ? { ok: true, note: "accepted before the file changed" } : await validateArtifactLayer(resolved);
    submission.push({ id: resolved.nodes[0].id, title: resolved.nodes[0].title, ...result });
  }
  const rejections = [];
  for (const [id, label, resolved] of rejected) rejections.push({ id, label, artifact: resolved.nodes[0].artifact, nodes: resolved.nodes.length, ...(await validateArtifactLayer(resolved)) });
  return { snapshot, layers, submission, rejections };
}

let fixture = await buildFixture();
const artifactNodes = new Map(fixture.layers.filter((resolved) => resolved.layer.renderer === "artifact").map((resolved) => [resolved.nodes[0].id, resolved]));
const slugFor = (nodeId) => nodeId.replace(/^node:/, "");
const nodeForSlug = (slug) => artifactNodes.get(`node:${slug}`);

// ---------------------------------------------------------------- server invoke

const approvals = new Set();
const processes = new Map();

function serverActionFor(nodeId) {
  return artifactNodes.get(nodeId)?.actions.find((action) => action.kind === "invoke" && action.invoke === "server");
}

async function reachable(url) {
  return new Promise((done) => {
    const req = httpRequest(url, { method: "GET", timeout: 700 }, (res) => { res.resume(); done(true); });
    req.on("error", () => done(false));
    req.on("timeout", () => { req.destroy(); done(false); });
    req.end();
  });
}

function startProcess(nodeId, action, startedBy) {
  const [program, ...args] = action.server.command.split(" ");
  const child = spawn(program === "node" ? process.execPath : program, args, { cwd: threadFolder, env: { ...process.env, ...action.server.env } });
  const entry = { nodeId, command: action.server.command, readyUrl: action.server.readyUrl, startedBy, status: "starting", log: [`$ ${action.server.command}`], pid: child.pid, startedAt: Date.now(), lastSeen: Date.now(), child, exitCode: null };
  processes.set(nodeId, entry);
  const onData = (chunk) => { for (const line of String(chunk).split("\n").filter(Boolean)) entry.log.push(line); entry.log = entry.log.slice(-40); };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", (code) => {
    entry.exitCode = code;
    if (entry.status === "starting" || entry.status === "ready") {
      entry.status = entry.status === "starting" ? "failed" : "exited";
      entry.log.push(`Process exited with code ${code}.`);
    }
  });
  const deadline = Date.now() + action.server.timeoutMs;
  (async () => {
    while (entry.status === "starting") {
      if (await reachable(action.server.readyUrl)) { entry.status = "ready"; entry.readyAt = Date.now(); return; }
      if (Date.now() > deadline) { entry.status = "failed"; entry.log.push(`Timed out after ${action.server.timeoutMs / 1000}s waiting for ${action.server.readyUrl}`); child.kill(); return; }
      await new Promise((done) => setTimeout(done, 250));
    }
  })();
  return entry;
}

function publicProcess(entry) {
  if (!entry) return null;
  const { child, ...rest } = entry;
  return { ...rest, idleMs: IDLE_MS, idleRemainingMs: entry.startedBy === "relayer" && entry.status === "ready" ? Math.max(0, IDLE_MS - (Date.now() - entry.lastSeen)) : null };
}

// "If the server is running, use it; if not, start it." (D37) No model, no graph record.
async function ensureServer(nodeId, { retry = false, poll = false } = {}) {
  const action = serverActionFor(nodeId);
  if (!action) return { status: "no_server_invoke" };
  const existing = processes.get(nodeId);
  // Polling reports progress; it never restarts a start that failed (Retry does).
  if (existing && poll) { existing.lastSeen = Date.now(); return publicProcess(existing); }
  if (existing && !retry && ["starting", "ready"].includes(existing.status)) {
    existing.lastSeen = Date.now();
    return publicProcess(existing);
  }
  if (!retry && await reachable(action.server.readyUrl)) {
    const entry = existing?.status === "ready" ? existing : { nodeId, command: action.server.command, readyUrl: action.server.readyUrl, startedBy: existing?.startedBy ?? "someone else", status: "ready", log: existing?.log ?? ["Ready URL answered; reusing the running server."], lastSeen: Date.now() };
    processes.set(nodeId, entry);
    return publicProcess(entry);
  }
  const approvalKey = `${action.server.command}\0${threadFolder}`;
  if (!approvals.has(approvalKey)) return { status: "needs_approval", command: action.server.command, folder: "tidewater-launch/", readyUrl: action.server.readyUrl };
  if (existing?.child && existing.exitCode == null) existing.child.kill();
  return publicProcess(startProcess(nodeId, action, "relayer"));
}

setInterval(() => {
  for (const entry of processes.values()) {
    if (entry.startedBy === "relayer" && entry.status === "ready" && Date.now() - entry.lastSeen > IDLE_MS) {
      entry.status = "stopped";
      entry.log.push(`Stopped after ${Math.round(IDLE_MS / 1000)}s idle (prototype setting; spec default about 1 hour).`);
      entry.child?.kill();
    }
  }
}, 2_000).unref();

// The agent started the kitchen display during its own testing and left it running.
{
  const action = serverActionFor("node:art-kitchen");
  startProcess("node:art-kitchen", action, "agent").log.unshift("(started by the agent during its turn)");
}

// ---------------------------------------------------------------- screenshots

let browserPromise = null;
async function screenshot({ url, width, height, scrollY = 0 }) {
  browserPromise ??= import("playwright").then(({ chromium }) => chromium.launch());
  const browser = await browserPromise;
  const page = await browser.newPage({ viewport: { width: Math.max(320, Math.min(1600, width | 0)), height: Math.max(240, Math.min(1000, height | 0)) } });
  try {
    await page.goto(url, { waitUntil: "load", timeout: 15_000 });
    await page.waitForFunction(() => window.__relayerReady !== false, null, { timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(250);
    if (scrollY) await page.evaluate((y) => window.scrollTo(0, y), scrollY);
    await page.waitForTimeout(150);
    const png = await page.screenshot({ type: "jpeg", quality: 72 });
    return `data:image/jpeg;base64,${png.toString("base64")}`;
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------- artifact origin

async function lib(name) {
  const source = LIBS[name];
  if (!source) return null;
  await mkdir(libCache, { recursive: true });
  const cached = join(libCache, name);
  if (existsSync(cached)) return readFile(cached);
  const response = await fetch(source);
  if (!response.ok) throw new Error(`Could not fetch ${source}`);
  const body = Buffer.from(await response.arrayBuffer());
  await writeFile(cached, body);
  return body;
}

const reporter = `(() => {
  // Injected by Relayer into artifact pages. Reports where the viewer is so
  // annotations can record it. Talks only to the parent viewer.
  const post = (extra = {}) => parent.postMessage({ source: "relayer-artifact", href: location.pathname + location.search + location.hash, scrollY: Math.round(scrollY), title: document.title, ...extra }, "*");
  addEventListener("error", (event) => post({ error: String(event.message || event.error || "Script error") }));
  addEventListener("unhandledrejection", (event) => post({ error: "Unhandled promise rejection: " + (event.reason?.message || event.reason) }));
  addEventListener("load", () => post());
  addEventListener("hashchange", () => post());
  addEventListener("popstate", () => post());
  let timer;
  addEventListener("scroll", () => { clearTimeout(timer); timer = setTimeout(() => post(), 150); }, { passive: true });
  // Links to another site leave the artifact: the viewer opens them in the user's browser.
  addEventListener("click", (event) => {
    const link = event.target.closest?.("a[href]");
    if (!link) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin) { event.preventDefault(); post({ openExternal: url.href }); }
  }, true);
  // The viewer pauses playing media while a note is written, then resumes it.
  let paused = [];
  addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.source !== "relayer-viewer") return;
    if (event.data.command === "pause") { paused = [...document.querySelectorAll("video, audio")].filter((media) => !media.paused); paused.forEach((media) => media.pause()); }
    if (event.data.command === "resume") { paused.forEach((media) => media.play().catch(() => {})); paused = []; }
  });
  window.__relayerReport = post;
})();`;

function injectReporter(html) {
  const tag = `<script src="/__relayer/reporter.js"></script>`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (match) => `${match}${tag}`) : `${tag}${html}`;
}

function seedPage(resolved, to) {
  const state = resolved.nodes[0].artifact.state ?? {};
  // Reset this artifact's private storage to the agent's seed on every open (D23).
  return `<!doctype html><meta charset="utf-8"><script>
  const problems = [];
  const seed = ${JSON.stringify(state)};
  try { localStorage.clear(); sessionStorage.clear(); } catch (error) { problems.push("storage: " + error.message); }
  try { for (const pair of document.cookie.split("; ").filter(Boolean)) document.cookie = pair.split("=")[0] + "=; Max-Age=0; path=/"; } catch (error) { problems.push("cookies: " + error.message); }
  try { for (const [key, value] of Object.entries(seed.localStorage ?? {})) localStorage.setItem(key, value); } catch (error) { problems.push("seed storage: " + error.message); }
  try { for (const [key, value] of Object.entries(seed.cookies ?? {})) { document.cookie = key + "=" + encodeURIComponent(value) + "; path=/"; document.cookie = key + "=" + encodeURIComponent(value) + "; path=/; SameSite=None; Secure"; } } catch (error) { problems.push("seed cookies: " + error.message); }
  if (problems.length && (seed.localStorage || seed.cookies)) parent.postMessage({ source: "relayer-artifact", error: "Could not seed state in this browser (prototype frame): " + problems.join("; ") }, "*");
  location.replace(${JSON.stringify(to)});
  </script>`;
}

function viewerPage(resolved) {
  const { kind, part, source } = resolved.nodes[0].artifact;
  const title = resolved.nodes[0].title;
  const shell = (body, head = "") => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><script src="/__relayer/reporter.js"></script>
  <style>html,body{margin:0;height:100%;background:#2a2c2e;color:#e8e6e3;font:15px/1.5 system-ui,sans-serif}.center{min-height:100%;display:grid;place-items:center}.err{padding:40px;color:#f3c9a8}</style>
  <script>window.__relayerReady = false; const params = new URLSearchParams(location.search); const fail = (message) => { document.body.innerHTML = '<div class="center"><p class="err">' + message + '</p></div>'; window.__relayerReport({ error: message }); window.__relayerReady = true; };</script>${head}</head><body>${body}`;
  if (kind === "image") {
    return shell(`<div class="center"><img id="img" src="/__relayer/file" alt="${title}" style="max-width:100%;max-height:100vh;object-fit:contain;cursor:zoom-in"></div>
    <script>img.onclick = () => { const fit = img.style.maxWidth === "100%"; img.style.maxWidth = fit ? "none" : "100%"; img.style.maxHeight = fit ? "none" : "100vh"; img.style.cursor = fit ? "zoom-out" : "zoom-in"; };
    img.onload = () => { window.__relayerReport({ location: "Whole image · " + img.naturalWidth + "×" + img.naturalHeight }); window.__relayerReady = true; }; img.onerror = () => fail("The image could not be decoded.");</script>`);
  }
  if (kind === "video") {
    const hasRange = part.start != null;
    return shell(`<div class="center" style="padding:24px;box-sizing:border-box"><div style="width:min(100%,1100px)">
      <video id="v" controls preload="auto" style="width:100%;border-radius:10px;background:#000" src="/__relayer/file"></video>
      ${hasRange ? `<p id="seg" style="opacity:.8">Showing ${fmt(part.start)}–${fmt(part.end)} · <a href="#" id="full" style="color:#9fd8d2">Play the whole video</a></p>` : ""}</div></div>
    <script>const fmt = (s) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
    const range = ${hasRange ? JSON.stringify([part.start, part.end]) : "null"};
    const at = params.get("t");
    // A screenshot shows the frame, not the player controls or a buffering spinner.
    if (params.has("snap")) v.removeAttribute("controls");
    let segment = range;
    const seekToStart = () => { v.currentTime = at != null ? Number(at) : segment ? segment[0] : 0; };
    if (v.readyState >= 1) seekToStart(); else v.addEventListener("loadedmetadata", seekToStart, { once: true });
    v.addEventListener("seeked", () => { setTimeout(() => { window.__relayerReady = true; }, 250); }, { once: true });
    v.addEventListener("loadeddata", () => { if (!at && !segment) window.__relayerReady = true; });
    v.addEventListener("timeupdate", () => {
      if (segment && v.currentTime >= segment[1]) { v.pause(); v.currentTime = segment[1]; }
      window.__relayerReport({ location: "At " + fmt(v.currentTime) + " of " + fmt(v.duration) + (segment ? " (segment " + fmt(segment[0]) + "–" + fmt(segment[1]) + ")" : ""), time: v.currentTime });
    });
    v.addEventListener("play", () => { if (segment && (v.currentTime < segment[0] || v.currentTime >= segment[1])) v.currentTime = segment[0]; });
    v.addEventListener("error", () => fail("This video could not be decoded."));
    document.getElementById("full")?.addEventListener("click", (e) => { e.preventDefault(); segment = null; v.currentTime = 0; v.play(); document.getElementById("seg").textContent = "Playing the whole video"; });</script>`);
  }
  if (kind === "pdf") {
    return shell(`<div id="pages" style="display:flex;flex-direction:column;align-items:center;gap:16px;padding:24px 0"></div>`, `<style>canvas{box-shadow:0 4px 18px rgba(0,0,0,.45);background:#fff;max-width:calc(100% - 32px);height:auto}</style>`)
      + `<script type="module">
      import * as pdfjs from "/__relayer/lib/pdf.mjs";
      pdfjs.GlobalWorkerOptions.workerSrc = "/__relayer/lib/pdf.worker.mjs";
      try {
        const doc = await pdfjs.getDocument("/__relayer/file").promise;
        const first = (await doc.getPage(1)).getViewport({ scale: 1.6 });
        const canvases = [];
        // Lay out every page at its size first, jump to the requested page, render it first.
        for (let n = 1; n <= doc.numPages; n += 1) {
          const canvas = document.createElement("canvas");
          canvas.width = first.width; canvas.height = first.height; canvas.style.width = first.width / 1.6 + "px"; canvas.dataset.page = n;
          pages.append(canvas); canvases.push(canvas);
        }
        const start = Math.min(doc.numPages, Number(params.get("page") || ${part.page ?? 1}));
        canvases[start - 1].scrollIntoView();
        let current = start;
        const report = () => window.__relayerReport({ location: "Page " + current + " of " + doc.numPages, page: current });
        const order = [start, ...canvases.map((_, i) => i + 1).filter((n) => n !== start)];
        for (const n of order) {
          const page = await doc.getPage(n);
          const viewport = page.getViewport({ scale: 1.6 });
          await page.render({ canvasContext: canvases[n - 1].getContext("2d"), viewport }).promise;
          if (n === start) { canvases[start - 1].scrollIntoView(); window.__relayerReady = true; report(); }
        }
        const io = new IntersectionObserver((entries) => {
          for (const e of entries) if (e.isIntersecting) { current = Number(e.target.dataset.page); report(); }
        }, { threshold: 0.5 });
        canvases.forEach((c) => io.observe(c));
      } catch (error) { fail("This PDF could not be opened: " + error.message); }
      </script>`;
  }
  if (kind === "markdown") {
    return shell(`<article id="doc" style="max-width:760px;margin:0 auto;padding:48px 28px 70vh;background:#fbfaf7;color:#1d2a2a;min-height:100%;box-sizing:border-box"></article>`,
      `<style>body{background:#fbfaf7}#doc h1{font-size:34px;letter-spacing:-.02em}#doc table{border-collapse:collapse}#doc td,#doc th{border:1px solid #ddd;padding:6px 10px}#doc code{background:#eee;padding:1px 5px;border-radius:4px}</style><script src="/__relayer/lib-local/marked.js"></script>`)
      + `<script>
      fetch("/__relayer/file").then((r) => { if (!r.ok) throw new Error(r.status === 404 ? "The file no longer exists." : "HTTP " + r.status); return r.text(); }).then((text) => {
        doc.innerHTML = marked.parse(text);
        for (const h of doc.querySelectorAll("h1,h2,h3")) h.id = h.textContent.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        const anchor = params.get("anchor") || ${JSON.stringify(part.anchor ?? "")};
        if (anchor) document.getElementById(anchor)?.scrollIntoView();
        const headings = [...doc.querySelectorAll("h2")];
        // Until the reader scrolls, the location is the section the node asked for.
        let readerScrolled = !anchor;
        for (const type of ["wheel", "keydown", "touchmove", "mousedown"]) addEventListener(type, () => { readerScrolled = true; }, { passive: true });
        const report = () => {
          const h = readerScrolled ? headings.filter((x) => x.getBoundingClientRect().top < 160).pop() : document.getElementById(anchor);
          window.__relayerReport({ location: h ? "Section: " + h.textContent : "Top of document", anchor: h?.id });
        };
        addEventListener("scroll", report, { passive: true }); report();
        window.__relayerReady = true;
      }).catch((e) => fail(e.message));</script>`;
  }
  if (kind === "docx") {
    return shell(`<div id="doc" style="padding:24px 0"></div>`, `<script src="/__relayer/lib/jszip.js"></script><script src="/__relayer/lib/docx-preview.js"></script><style>body{background:#e9e7e3}.docx-wrapper{background:#e9e7e3!important}</style>`)
      + `<script>fetch("/__relayer/file").then((r) => r.blob()).then((blob) => docx.renderAsync(blob, doc)).then(() => { window.__relayerReady = true; window.__relayerReport({ location: "Whole document" }); }).catch((e) => fail("Word renderer failed: " + e.message));</script>`;
  }
  if (kind === "xlsx") {
    return shell(`<nav id="tabs" style="display:flex;gap:6px;padding:12px 16px;background:#1f2123"></nav><div id="sheet" style="padding:16px;overflow:auto;background:#fff;color:#111;min-height:calc(100% - 60px)"></div>`,
      `<script src="/__relayer/lib/xlsx.js"></script><style>#sheet table{border-collapse:collapse;font:13px system-ui}#sheet td{border:1px solid #d0d0d0;padding:4px 10px;min-width:60px}#tabs button{font:inherit;border:0;border-radius:6px;padding:4px 10px;background:#34383b;color:#ddd}#tabs button[aria-pressed=true]{background:#0f6e6a;color:#fff}</style>`)
      + `<script>fetch("/__relayer/file").then((r) => r.arrayBuffer()).then((data) => {
        const book = XLSX.read(data);
        const show = (name) => { sheet.innerHTML = XLSX.utils.sheet_to_html(book.Sheets[name]); for (const b of tabs.children) b.setAttribute("aria-pressed", String(b.textContent === name)); window.__relayerReport({ location: "Sheet: " + name }); };
        for (const name of book.SheetNames) { const b = document.createElement("button"); b.textContent = name; b.onclick = () => show(name); tabs.append(b); }
        show(book.SheetNames[0]); window.__relayerReady = true;
      }).catch((e) => fail("Excel renderer failed: " + e.message));</script>`;
  }
  if (kind === "pptx") {
    return shell(`<div id="deck" style="display:flex;justify-content:center;padding:24px"></div>`, `<script src="/__relayer/lib/pptx-preview.js"></script>
      <style>.pptx-preview-wrapper{height:auto!important;overflow:visible!important;background:transparent!important}.pptx-preview-slide-wrapper{margin:0 auto 20px!important;box-shadow:0 6px 24px rgba(0,0,0,.45)}</style>`)
      + `<script>fetch("/__relayer/file").then((r) => r.arrayBuffer()).then(async (data) => {
        const width = Math.min(960, innerWidth - 48);
        const previewer = pptxPreview.init(deck, { width, height: Math.round(width * 9 / 16) });
        await previewer.preview(data);
        // All slides stack in one scroll; the location is the slide in view.
        const slides = [...document.querySelectorAll(".pptx-preview-slide-wrapper")];
        const report = (n) => window.__relayerReport({ location: "Slide " + n + " of " + slides.length, slide: n });
        const io = new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) report(slides.indexOf(e.target) + 1); }, { threshold: 0.6 });
        slides.forEach((slide) => io.observe(slide));
        const start = Number(params.get("slide") || 1);
        slides[start - 1]?.scrollIntoView();
        report(start);
        window.__relayerReady = true;
      }).catch((e) => fail("PowerPoint renderer failed: " + e.message));</script>`;
  }
  return shell(`<p class="err">Unsupported kind ${kind}</p>`);
}

function fmt(seconds) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

// Media seeking needs byte ranges: without them a video cannot jump to a segment.
async function sendFile(response, absolute, transform, request) {
  const body = await readFile(absolute);
  const type = MIME[extname(absolute).toLowerCase()] ?? "application/octet-stream";
  const range = /^bytes=(\d*)-(\d*)$/.exec(request?.headers.range ?? "");
  if (range && !type.startsWith("text/html")) {
    const start = range[1] ? Number(range[1]) : body.length - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
    response.writeHead(206, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${body.length}`, "Content-Length": end - start + 1, "Cache-Control": "no-store" });
    response.end(body.subarray(start, end + 1));
    return;
  }
  const html = transform && type.startsWith("text/html");
  response.writeHead(200, { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-store", ...(html ? {} : { "Content-Length": body.length }) });
  response.end(html ? transform(String(body)) : body);
}

function proxyToApp(request, response, readyUrl) {
  const target = new URL(request.url, readyUrl);
  const upstream = httpRequest(target, { method: request.method, headers: { ...request.headers, host: target.host } }, (upstreamResponse) => {
    const type = upstreamResponse.headers["content-type"] ?? "";
    if (!type.includes("text/html")) {
      response.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
      upstreamResponse.pipe(response);
      return;
    }
    let html = "";
    upstreamResponse.on("data", (chunk) => { html += chunk; });
    upstreamResponse.on("end", () => {
      const headers = { ...upstreamResponse.headers };
      delete headers["content-length"];
      response.writeHead(upstreamResponse.statusCode, headers);
      response.end(injectReporter(html));
    });
  });
  upstream.on("error", () => { response.writeHead(502, { "Content-Type": "text/plain" }); response.end("The app is not running."); });
  request.pipe(upstream);
}

const artifactServer = createServer(async (request, response) => {
  try {
    const host = (request.headers.host ?? "").split(":")[0];
    const match = /^n-([a-z0-9-]+)\.localhost$/u.exec(host);
    const resolved = match && nodeForSlug(match[1]);
    if (!resolved) { response.writeHead(404); response.end("Unknown artifact origin."); return; }
    const url = new URL(request.url, "http://artifact");
    const artifact = resolved.nodes[0].artifact;
    if (url.pathname === "/__relayer/reporter.js") { response.writeHead(200, { "Content-Type": "text/javascript" }); response.end(reporter); return; }
    if (url.pathname === "/__relayer/open") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(seedPage(resolved, url.searchParams.get("to") || "/")); return; }
    if (url.pathname.startsWith("/__relayer/lib/")) {
      const body = await lib(url.pathname.slice("/__relayer/lib/".length));
      if (!body) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "max-age=3600" });
      response.end(body);
      return;
    }
    if (url.pathname === "/__relayer/lib-local/marked.js") { await sendFile(response, join(repositoryRoot, "node_modules/marked/lib/marked.umd.js")); return; }
    if (url.pathname === "/__relayer/view") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(viewerPage(resolved)); return; }
    if (url.pathname === "/__relayer/file") {
      const inside = await resolveInside(artifact.source.file);
      if (inside.error) { response.writeHead(404, { "Content-Type": "text/plain" }); response.end(inside.error.message); return; }
      await sendFile(response, inside.absolute, null, request);
      return;
    }
    if (artifact.kind === "app") { proxyToApp(request, response, artifact.source.app.readyUrl); return; }
    if (artifact.kind === "website") {
      const root = await resolveInside(artifact.source.root);
      const decoded = decodeURIComponent(url.pathname === "/" ? `/${relative(artifact.source.root, artifact.source.file)}` : url.pathname);
      const file = resolve(root.absolute, `.${decoded}`);
      // The viewer serves only the site root (D35).
      if (!file.startsWith(root.absolute + sep) || !existsSync(file)) { response.writeHead(404, { "Content-Type": "text/plain" }); response.end("Not found in the site root."); return; }
      await sendFile(response, file, injectReporter, request);
      return;
    }
    response.writeHead(404);
    response.end();
  } catch (error) {
    response.writeHead(500, { "Content-Type": "text/plain" });
    response.end(String(error?.message ?? error));
  }
});
await new Promise((done) => artifactServer.listen(Number(process.env.PROTO_ARTIFACT_PORT || 4685), "127.0.0.1", done));
const artifactPort = artifactServer.address().port;

// ---------------------------------------------------------------- workspace origin

async function json(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
}

function reply(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

async function artifactStatus(nodeId) {
  const resolved = artifactNodes.get(nodeId);
  const artifact = resolved?.nodes[0].artifact;
  if (!artifact?.source.file) return { fingerprint: null, exists: true, matches: null };
  const inside = await resolveInside(artifact.source.root ?? artifact.source.file);
  if (inside.error) return { exists: false, matches: null, error: inside.error.message };
  const fileInside = await resolveInside(artifact.source.file);
  if (fileInside.error) return { exists: false, matches: null, error: fileInside.error.message };
  const current = await hashPath(inside.absolute);
  return { exists: true, fingerprint: artifact.fingerprint, current, matches: current === artifact.fingerprint };
}

let workspacePort;
const workspaceCsp = () => [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self'",
  `frame-src http://*.localhost:${artifactPort} https:`, "connect-src 'self'", "object-src 'none'", "base-uri 'none'",
].join("; ");

const workspaceServer = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    const path = url.pathname;
    if (path === "/") { response.writeHead(302, { Location: "/artifact-viewer.prototype.html" }); response.end(); return; }
    if (path === "/matrix") { response.writeHead(302, { Location: "/artifact-viewer-matrix.prototype.html" }); response.end(); return; }
    if (path === "/proto/snapshot.jsonl") { response.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" }); response.end(fixture.snapshot); return; }
    if (path === "/proto/config") {
      reply(response, 200, { artifactPort, idleMs: IDLE_MS, specIdleMs: SPEC_IDLE_MS, submission: fixture.submission, rejections: fixture.rejections, ports });
      return;
    }
    if (path === "/proto/status") { reply(response, 200, await artifactStatus(url.searchParams.get("node"))); return; }
    if (path === "/proto/invoke/ensure" && request.method === "POST") { const body = await json(request); reply(response, 200, await ensureServer(body.nodeId, body)); return; }
    if (path === "/proto/invoke/approve" && request.method === "POST") {
      const body = await json(request);
      const action = serverActionFor(body.nodeId);
      approvals.add(`${action.server.command}\0${threadFolder}`);
      reply(response, 200, await ensureServer(body.nodeId));
      return;
    }
    if (path === "/proto/invoke/heartbeat" && request.method === "POST") {
      const body = await json(request);
      const entry = processes.get(body.nodeId);
      if (entry) entry.lastSeen = Date.now();
      reply(response, 200, publicProcess(entry));
      return;
    }
    if (path === "/proto/processes") {
      reply(response, 200, { idleMs: IDLE_MS, approvals: [...approvals].map((key) => key.split("\0")[0]), processes: [...processes.values()].map(publicProcess) });
      return;
    }
    if (path === "/proto/reset-approvals" && request.method === "POST") { approvals.clear(); reply(response, 200, { ok: true }); return; }
    if (path === "/proto/stop" && request.method === "POST") {
      const body = await json(request);
      const entry = processes.get(body.nodeId);
      if (entry?.child && entry.startedBy === "relayer") { entry.status = "stopped"; entry.log.push("Stopped from the matrix."); entry.child.kill(); }
      reply(response, 200, publicProcess(entry));
      return;
    }
    if (path.startsWith("/proto/captures/")) {
      const name = path.slice("/proto/captures/".length);
      const file = join(fixtureRoot, "captures", name);
      if (!/^[A-Za-z0-9._-]+$/.test(name) || !existsSync(file)) { reply(response, 404, { error: "No capture yet. Run capture-cases.mjs." }); return; }
      await sendFile(response, file);
      return;
    }
    if (path === "/proto/screenshot" && request.method === "POST") { const body = await json(request); reply(response, 200, { image: await screenshot(body) }); return; }
    if (path === "/proto/touch" && request.method === "POST") {
      // Simulate someone editing the site after acceptance.
      const file = join(threadFolder, "site/styles.css");
      const css = await readFile(file, "utf8");
      const marker = "/* edited after acceptance */\n";
      await writeFile(file, css.startsWith(marker) ? css.slice(marker.length) : marker + css);
      reply(response, 200, await artifactStatus("node:art-site"));
      return;
    }
    // Static renderer files (the real product renderer plus the prototype page).
    const decoded = decodeURIComponent(path);
    const file = resolve(rendererRoot, `.${decoded}`);
    if (decoded.includes("\0") || !file.startsWith(rendererRoot + sep) || !existsSync(file)) { response.writeHead(404); response.end("not found"); return; }
    const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
    const headers = { "Content-Type": type, "Cache-Control": "no-store" };
    if (type.startsWith("text/html")) headers["Content-Security-Policy"] = workspaceCsp();
    response.writeHead(200, headers);
    response.end(await readFile(file));
  } catch (error) {
    reply(response, 500, { error: String(error?.message ?? error) });
  }
});
workspacePort = Number(process.env.PROTO_PORT || 4684);
await new Promise((done) => workspaceServer.listen(workspacePort, "127.0.0.1", done));
workspacePort = workspaceServer.address().port;

const origin = `http://127.0.0.1:${workspacePort}`;
process.stdout.write(`
Artifact viewer prototype (issue #684) — throwaway
  Prototype:  ${origin}/artifact-viewer.prototype.html
  Case matrix: ${origin}/artifact-viewer-matrix.prototype.html
  Artifact origins: http://n-<artifact>.localhost:${artifactPort}
  Idle stop for apps Relayer starts: ${IDLE_MS / 1000}s (PROTO_IDLE_MS; the spec default is about 1 hour)
`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const entry of processes.values()) entry.child?.kill();
    process.exit(0);
  });
}
