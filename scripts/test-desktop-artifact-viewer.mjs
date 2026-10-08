// Deterministic Electron evidence for the artifact viewer (PRD 6.6, ART-003..007).
// Runs the actual desktop entry point with the artifact-viewer fixture harness in
// place of codex.basic: no model, no network inference. It sends one message, opens
// every artifact the fixture authored, checks the viewer and saves screenshots.
//
//   npm run test:desktop:artifact-viewer
//
// RELAYER_ARTIFACT_EVIDENCE_DIR overrides where screenshots and results.json go.
import { app, BrowserWindow, shell } from "electron";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";

import { createViewerRecorder } from "./artifact-viewer-video.mjs";

import { artifactViewerFixtureFactory, ORDER_DESK_PORT } from "@relayer/eval-runner";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { ModelCatalogService } from "../desktop/main/models/model-catalog-service.mjs";

const root = resolve(import.meta.dirname, "..");
// The exact source this run tests: a pass is claimed only for that snapshot (AGENTS.md).
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const source = { commit: git("rev-parse", "HEAD"), clean: git("status", "--porcelain", "--untracked-files=no") === "" };
const profile = join(root, ".relayer", `artifact-viewer-evidence-${Date.now()}`);
const output = process.env.RELAYER_ARTIFACT_EVIDENCE_DIR ?? join(root, ".relayer", "evidence", "artifact-viewer");
await rm(output, { recursive: true, force: true });
await mkdir(profile, { recursive: true });
await mkdir(output, { recursive: true });
process.env.RELAYER_DESKTOP_USER_DATA_DIR = profile;
process.env.RELAYER_ARTIFACT_FIXTURE_DIR = join(root, "test", "fixtures", "artifact-viewer", "thread-folder");
process.env.RELAYER_ARTIFACT_PREVIEW_DIR = join(output, "agent-previews");
await writeFile(join(profile, "desktop-settings.json"), JSON.stringify({ tutorial: { version: 1, status: "dismissed" }, appearance: "dark" }));
app.commandLine.appendSwitch("force-device-scale-factor", "1");

// Never open the user's browser or apps from evidence; record the requests instead.
const external = [];
shell.openExternal = async (url) => { external.push({ kind: "url", url }); };
shell.openPath = async (path) => { external.push({ kind: "path", path }); return ""; };

let productSession;
let product;
const startRuntime = GraphCompleteRuntimeService.prototype.start;
GraphCompleteRuntimeService.prototype.start = function () {
  this.startupTimeoutMs = 60_000;
  this.additionalImplementations = { "codex.basic": (context) => {
    const fixture = artifactViewerFixtureFactory(context);
    const complete = fixture.complete.bind(fixture);
    fixture.complete = async (...args) => {
      try { return await complete(...args); } catch (error) { console.error("FIXTURE_ERROR", error?.stack ?? error, JSON.stringify({ status: error?.status, code: error?.code, path: error?.path, issues: error?.issues })); throw error; }
    };
    return fixture;
  } };
  this.validateHarnessRuntime = async () => true;
  this.coordinateHarnessReadiness = false;
  this.acquireProviderExecution = async (providerId) => ({
    definition: { id: providerId, adapterId: "codex-subscription", accessContract: "managed-runtime@1" },
    descriptor: { adapterId: "codex-subscription", accessContract: "managed-runtime@1", implementationVersion: "1" },
    runtime: { async executionAccess() { return { kind: "managed-runtime", environment: {} }; } },
    async release() {},
  });
  return startRuntime.call(this);
};
const startProduct = RelayerAppServerService.prototype.start;
RelayerAppServerService.prototype.start = async function () {
  this.startupTimeoutMs = 60_000;
  const session = await startProduct.call(this);
  product = this;
  productSession = session;
  return session;
};
ModelCatalogService.prototype.startup = async () => [];
ModelCatalogService.prototype.refresh = async () => null;
ModelCatalogService.prototype.beforeInference = async () => [];

const QUESTION = "Build a launch kit for Tidewater Coffee: a website, an investor brief, a promo video and the brand assets. Let me open each one.";
const results = [];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitFor(label, check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await check(); if (last) return last; } catch (error) { last = error; }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}${last instanceof Error ? `: ${last.message}` : ""}`);
}

async function request(path, body, method = "POST") {
  const response = await fetch(new URL(path, productSession.origin), {
    method: body === undefined ? "GET" : method,
    headers: { Cookie: `${productSession.cookie.name}=${productSession.cookie.value}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(value)}`);
  return value;
}

function check(id, ok, observed) {
  results.push({ id, ok: Boolean(ok), observed });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}: ${observed}`);
}

const js = (window, code) => window.webContents.executeJavaScript(code);
const artifactView = (window) => window.contentView.children.find((view) => view.webContents && view.webContents !== window.webContents) ?? null;

// The window capture is in device pixels and omits the native view; paste the view in at that scale.
// capturePage on a child view needs a presented surface, so the view comes from the DevTools protocol.
// Each capture briefly marks a view on a sleeping display visible, and Chromium then pauses silent video
// as hidden; turning off background throttling for captured views keeps playback running.
// The recorder and named screenshots share one view, so captures run one at a time.
let composing = Promise.resolve();
function compose(window) {
  const next = composing.then(() => composeNow(window));
  composing = next.catch(() => {});
  return next;
}

async function composeNow(window) {
  const base = (await window.webContents.capturePage()).toPNG();
  const view = artifactView(window);
  // While Annotate is open the view hides behind its screenshot; show the page as it is.
  if (!view || !view.getVisible()) return base;
  const bounds = view.getBounds();
  const contents = view.webContents;
  if (!contents.debugger.isAttached()) {
    contents.setBackgroundThrottling(false);
    contents.debugger.attach("1.3");
  }
  // A view that was just placed can refuse a capture, or never answer while Chromium
  // paints no frames; retry with a bound on each attempt, then show the window alone.
  const attempt = () => Promise.race([
    contents.debugger.sendCommand("Page.captureScreenshot", { format: "png" }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("capture timed out")), 2_000)),
  ]);
  const captured = await waitFor("view capture", attempt, 8_000).catch(() => null);
  if (!captured) return base;
  const { data } = captured;
  const scale = (await sharp(base).metadata()).width / window.getContentBounds().width;
  const place = (value) => Math.round(value * scale);
  const content = await sharp(Buffer.from(data, "base64")).resize(place(bounds.width), place(bounds.height), { fit: "fill" }).png().toBuffer();
  return sharp(base).composite([{ input: content, left: place(bounds.x), top: place(bounds.y) }]).png().toBuffer();
}

async function shot(window, name) {
  await writeFile(join(output, `${name}.png`), await compose(window));
}

// With RELAYER_ARTIFACT_VIDEO=<file.mp4> the run is paced and recorded with captions.
let recorder = null;
const say = (text) => recorder?.caption(text);
const hold = (ms) => (recorder ? sleep(ms) : undefined);

async function openArtifact(window, groupTitle, label) {
  await js(window, `document.querySelector("#artifactViewerClose")?.click()`);
  const nodeId = await waitFor(`node ${groupTitle}`, () => js(window, `[...document.querySelectorAll("[data-node]")].find((n) => n.textContent.includes(${JSON.stringify(groupTitle)}))?.dataset.node ?? null`));
  await js(window, `document.querySelector('[data-node="${nodeId}"]').click()`);
  await hold(1200);
  await waitFor(`action ${label}`, () => js(window, `[...document.querySelectorAll("[data-action-id]")].some((a) => a.textContent.trim().includes(${JSON.stringify(label)}))`));
  await js(window, `[...document.querySelectorAll("[data-action-id]")].find((a) => a.textContent.trim().includes(${JSON.stringify(label)})).click()`);
  await waitFor(`viewer for ${label}`, () => js(window, `document.querySelector(".artifact-viewer") !== null`));
}

async function viewerLoaded(window) {
  return waitFor("artifact content", () => {
    const view = artifactView(window);
    return view && !view.webContents.isLoading() && view.webContents.getURL() !== "" ? view : null;
  });
}

// Chromium's PDF viewer is an extension frame; it renders only once its element has started.
async function pdfViewerStarted(view) {
  return waitFor("PDF viewer", async () => {
    const frame = view.webContents.mainFrame.framesInSubtree.find((candidate) => candidate.url.startsWith("chrome-extension://"));
    return frame && Number(await frame.executeJavaScript(`document.querySelector("pdf-viewer")?.shadowRoot?.childElementCount ?? 0`)) > 0;
  }, 10_000).catch(() => false);
}

async function closeViewer(window) {
  const view = artifactView(window);
  if (view) view.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  else await js(window, `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await waitFor("viewer to close", () => js(window, `document.querySelector(".artifact-viewer") === null`));
  await waitFor("native view to close", () => artifactView(window) === null);
}

async function run(window) {
  await product.seedProviderCatalog({ providerId: "codex", label: "Codex (fixture)", connected: true, models: [{ id: "gpt-fixture", label: "Fixture model", order: 0, visible: true, available: true, providerDefault: true, metadata: {} }], systemFamily: { key: "codex", name: "Codex", modelIds: ["gpt-fixture"] } });
  const family = await request("/api/model-families", { name: "Codex fixture", enabled: true, members: [{ providerId: "codex", modelId: "gpt-fixture" }] });
  await js(window, `localStorage.setItem('relayerDesktopAccountOnboardingV1', 'skipped')`);
  await window.loadURL(productSession.origin);
  window.setSize(1440, 900);
  if (process.env.RELAYER_ARTIFACT_VIDEO) {
    recorder = createViewerRecorder({ frame: () => compose(window), output: resolve(process.env.RELAYER_ARTIFACT_VIDEO) });
    await recorder.start();
  }

  // Ask the question in the real composer, as a person would.
  say("A person asks Relayer for a launch kit");
  await waitFor("composer", () => js(window, `document.querySelector("#newThreadPrompt")?.offsetParent ? true : null`));
  await hold(1500);
  for (const chunk of (recorder ? QUESTION.match(/.{1,3}/gsu) : [QUESTION])) {
    await js(window, `(() => { const t = document.querySelector("#newThreadPrompt"); t.focus(); t.value += ${JSON.stringify(chunk)}; t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await hold(30);
  }
  await waitFor("send enabled", () => js(window, `document.querySelector("#createThread").disabled ? null : true`), 15_000)
    .catch(async (error) => { throw new Error(`${error.message}: ${await js(window, `document.querySelector("#createThread").title`)}`); });
  await hold(800);
  await js(window, `document.querySelector("#createThread").click()`);
  say("The agent builds the site, brief, video, brand assets and Office documents, and links each one");
  const thread = await waitFor("thread", async () => (await request("/api/threads")).threads.find((candidate) => candidate.title !== undefined) ?? null);
  await waitFor("accepted launch kit", async () => {
    const detail = await request(`/api/threads/${thread.id}`);
    const last = detail.interactions.at(-1);
    if (last?.completionStatus === "failed") throw new Error(JSON.stringify(last));
    return last?.completionStatus === "accepted";
  }, 90_000);
  const folder = (await request(`/api/threads/${thread.id}/artifact-folder`)).folder;
  // ART-005: the agent saw each artifact before acceptance.
  const previews = JSON.parse(await readFile(join(output, "agent-previews", "previews.json"), "utf8"));
  // A web app's preview is advisory: before the user approves it, its server is not running.
  const filePreviews = previews.filter((preview) => !preview.key.startsWith("order-desk"));
  const unrendered = filePreviews.filter((preview) => preview.status !== "rendered" && preview.status !== "cached");
  check("ART-005 agent previews of artifact layers", filePreviews.length === 14 && unrendered.length === 0, `${filePreviews.length - unrendered.length}/${filePreviews.length} rendered${unrendered.length ? `; not: ${unrendered.map((preview) => `${preview.key}=${preview.status}`).join(", ")}` : ""}`);
  await waitFor("graph", () => js(window, `document.querySelectorAll("[data-node]").length >= 5`));
  await sleep(600);
  say("The answer is a graph; each node links to what the agent made");
  await hold(3000);
  await shot(window, "00-graph");

  // Website: live, isolated, address strip, toolbar hides.
  say("Click a node, then its action: the website opens in the viewer");
  await openArtifact(window, "Landing page", "Open the site");
  let view = await viewerLoaded(window);
  await sleep(500);
  check("ART-007 website", view.webContents.getURL().startsWith("relayer-artifact://view/index.html"), view.webContents.getURL());
  const badges = await js(window, `[...document.querySelectorAll("[data-badge]")].map((badge) => badge.title ? badge.textContent + " (" + badge.title + ")" : badge.textContent).join(", ")`);
  check("ART-004 acceptance pins the edited site", badges === "", `badges on first open: "${badges}" (the fixture edited the site after submitting its node)`);
  const strip = await js(window, `document.querySelector(".artifact-strip-text")?.textContent`);
  check("ART-006 address strip", strip === "site/index.html", strip);
  const toolbarItems = await js(window, `[...document.querySelectorAll(".artifact-toolbar button")].map((b) => b.getAttribute("aria-label") || b.textContent.trim())`);
  check("ART-006 no actions in viewer", toolbarItems.join(",") === "Graph,Annotate,More", toolbarItems.join(", "));
  // ART-010: the seeded cart is there on first open; the page then empties it.
  const seededCart = await view.webContents.executeJavaScript(`document.querySelector("#cartCount").textContent`);
  check("ART-010 starting state applied", seededCart === "1", `cart count on open: ${seededCart}`);
  await view.webContents.executeJavaScript(`localStorage.setItem("probe", "first-open"); localStorage.setItem("tidewater.cart", "[]")`);
  await shot(window, "01-website");
  say("The toolbar slides away after 3 seconds; the address strip stays");
  await sleep(3400);
  const hidden = await js(window, `document.querySelector(".artifact-viewer").classList.contains("artifact-toolbar-hidden")`);
  check("ART-006 toolbar hides, strip stays", hidden && await js(window, `document.querySelector(".artifact-strip").offsetHeight > 0`), `hidden=${hidden}`);
  await shot(window, "02-website-toolbar-hidden");
  // The pointer reaching the strip brings the toolbar back. A drag region would swallow
  // that event on macOS, and synthetic input skips the OS hit test, so check both.
  const stripRegion = await js(window, `getComputedStyle(document.querySelector(".artifact-strip")).getPropertyValue("-webkit-app-region") || getComputedStyle(document.querySelector(".artifact-strip")).getPropertyValue("app-region")`);
  const stripBox = await js(window, `(() => { const r = document.querySelector(".artifact-strip").getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  window.webContents.sendInputEvent({ type: "mouseMove", x: stripBox.x, y: stripBox.y + 30 });
  window.webContents.sendInputEvent({ type: "mouseMove", x: stripBox.x, y: stripBox.y });
  const revealed = await waitFor("toolbar revealed", () => js(window, `document.querySelector(".artifact-viewer").classList.contains("artifact-toolbar-hidden") ? null : true`), 3_000).catch(() => false);
  check("ART-006 hovering the strip brings the toolbar back", revealed === true && stripRegion !== "drag", `revealed=${revealed} strip app-region=${stripRegion || "none"}`);
  say("Links out of the artifact open in the browser, not in Relayer");
  await hold(1200);
  // A page cannot open the browser by itself; only the user's own click does.
  await view.webContents.executeJavaScript(`location.href = "https://example.org/"`).catch(() => {});
  const offered = await waitFor("link offer", () => js(window, `document.querySelector('[data-badge="external"]')?.textContent ?? null`), 5_000).catch(() => null);
  check("PRD 6.6.4 the page cannot open the browser by itself", offered === "Open example.org in your browser" && !external.some((entry) => entry.url?.includes("example.org")), String(offered));
  const link = await view.webContents.executeJavaScript(`(() => { document.querySelector("#instagram").scrollIntoView({ block: "center" }); const box = document.querySelector("#instagram").getBoundingClientRect(); return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }; })()`);
  view.webContents.sendInputEvent({ type: "mouseDown", x: link.x, y: link.y, button: "left", clickCount: 1 });
  view.webContents.sendInputEvent({ type: "mouseUp", x: link.x, y: link.y, button: "left", clickCount: 1 });
  await waitFor("instagram offer", () => js(window, `document.querySelector('[data-badge="external"]')?.textContent === "Open www.instagram.com in your browser" ? true : null`), 5_000);
  check("PRD 6.6.4 a link waits for the user's choice", !external.some((entry) => entry.url?.startsWith("https://www.instagram.com")), "offered in the toolbar, not opened");
  await js(window, `document.querySelector('[data-badge="external"]').click()`);
  await waitFor("external link", () => external.some((entry) => entry.url?.startsWith("https://www.instagram.com")));
  check("PRD 6.6.4 external link leaves the artifact", view.webContents.getURL().startsWith("relayer-artifact://view/"), JSON.stringify(external.at(-1)));
  await hold(2500);
  await closeViewer(window);
  check("ART-006 Esc returns to the graph", true, "viewer closed by Escape inside the artifact");

  // Reopen: storage is fresh every time.
  say("Reopening starts fresh, and the artifact cannot reach Relayer (the probe's blocked request shows as a page error)");
  await openArtifact(window, "Landing page", "Open the site");
  view = await viewerLoaded(window);
  const reopened = await view.webContents.executeJavaScript(`localStorage.getItem("probe")`);
  check("PRD 6.6.4 nothing persists between opens", reopened === null, `probe after reopen: ${reopened}`);
  const resetCart = await view.webContents.executeJavaScript(`document.querySelector("#cartCount").textContent`);
  check("ART-010 starting state resets on every open", resetCart === "1", `cart count after the page emptied it and the site reopened: ${resetCart}`);
  const probe = await view.webContents.executeJavaScript(`(async () => {
    const api = await fetch(${JSON.stringify(new URL("/api/threads", productSession.origin).href)}, { credentials: "include" }).then((r) => "read " + r.status, (e) => "blocked (" + e.name + ")");
    return { api, cookie: document.cookie, desktopBridge: typeof window.relayerDesktop, topLevel: window.top === window && window.opener === null, origin: location.origin };
  })()`);
  check("ART-003 isolation", probe.api.startsWith("blocked") && probe.cookie === "" && probe.desktopBridge === "undefined" && probe.topLevel, JSON.stringify(probe));
  const siteStorage = view.webContents.session.getStoragePath();
  await hold(2500);
  await closeViewer(window);

  // Website at a route on a phone screen.
  say("Website at a route, on a phone-sized screen");
  await openArtifact(window, "Landing page", "Pricing on a phone");
  view = await viewerLoaded(window);
  await sleep(500);
  // The page sees the phone's full screen even when the window shows it scaled down.
  const phone = await view.webContents.executeJavaScript("({ width: innerWidth, height: innerHeight, hash: location.hash })");
  check("ART-007 route and phone viewport", phone.width === 390 && phone.height === 844 && phone.hash === "#pricing", JSON.stringify({ ...phone, shown: view.getBounds() }));
  const phoneStorage = view.webContents.session.getStoragePath();
  check("ART-003 no shared storage between artifacts", phoneStorage !== siteStorage && view.webContents.session !== window.webContents.session, `${siteStorage?.split("/").at(-1)} vs ${phoneStorage?.split("/").at(-1)}`);
  await shot(window, "03-website-phone");
  await hold(2500);
  await closeViewer(window);

  // PDF whole, and at page 4.
  say("PDF: the whole investor brief");
  await openArtifact(window, "Investor brief", "Read the brief");
  view = await viewerLoaded(window);
  await sleep(1500);
  const pdfStarted = await pdfViewerStarted(view);
  check("ART-007 PDF", view.webContents.getURL().endsWith("investor-brief.pdf") && pdfStarted, `${view.webContents.getURL()} viewer started=${pdfStarted}`);
  await shot(window, "04-pdf");
  await hold(2500);
  await closeViewer(window);
  say("PDF opened at page 4");
  await openArtifact(window, "Investor brief", "Use of funds");
  view = await viewerLoaded(window);
  await sleep(1500);
  const pageStarted = await pdfViewerStarted(view);
  check("ART-007 PDF page", view.webContents.getURL().endsWith("investor-brief.pdf#page=4") && pageStarted, `${view.webContents.getURL()} viewer started=${pageStarted}`);
  await shot(window, "05-pdf-page-4");
  await hold(2500);
  await closeViewer(window);

  // Video whole, and a segment.
  say("Video");
  await openArtifact(window, "Promo video", "Watch it");
  view = await viewerLoaded(window);
  await sleep(800);
  const whole = await view.webContents.executeJavaScript(`({ duration: document.querySelector("video").duration, error: document.querySelector("video").error?.message ?? null })`);
  check("ART-007 video", whole.duration > 19 && whole.error === null, JSON.stringify(whole));
  // Press play as a person would.
  await view.webContents.executeJavaScript(`document.querySelector("video").play()`);
  await hold(2000);
  await shot(window, "06-video");
  await hold(4000);
  await closeViewer(window);
  say("Video segment: plays seconds 10 to 15 only");
  await openArtifact(window, "Promo video", "Ship chapter");
  view = await viewerLoaded(window);
  const segment = await waitFor("segment start", () => view.webContents.executeJavaScript(`(() => { const v = document.querySelector("video"); return v.readyState >= 1 && Math.abs(v.currentTime - 10) < 0.6 ? v.currentTime : null; })()`), 10_000).catch(() => null);
  check("ART-007 video segment (needs byte ranges)", segment !== null, `currentTime=${segment}`);
  await view.webContents.executeJavaScript(`document.querySelector("video").play()`);
  await sleep(1500);
  await shot(window, "07-video-segment");
  const stopped = await waitFor("segment end", () => view.webContents.executeJavaScript(`(() => { const v = document.querySelector("video"); return v.paused && Math.abs(v.currentTime - 15) < 0.3 ? v.currentTime : null; })()`), 10_000).catch(() => null);
  const videoState = await view.webContents.executeJavaScript(`(() => { const v = document.querySelector("video"); return JSON.stringify({ time: v.currentTime, paused: v.paused }); })()`);
  check("PRD 6.6.3 video segment stops at its end", stopped !== null, `paused at ${stopped} (${videoState})`);
  await hold(1500);
  await closeViewer(window);

  // Image, Markdown and a Markdown heading.
  say("Image");
  await openArtifact(window, "Brand assets", "Hero image");
  view = await viewerLoaded(window);
  await sleep(500);
  const picture = await view.webContents.executeJavaScript(`document.querySelector("img").naturalWidth`);
  check("ART-007 image", picture === 1600, `naturalWidth=${picture}`);
  await shot(window, "08-image");
  await hold(2500);
  await closeViewer(window);
  say("Markdown, opened at its Colour heading");
  await openArtifact(window, "Brand assets", "Colours");
  view = await viewerLoaded(window);
  await waitFor("markdown", () => view.webContents.executeJavaScript(`document.querySelector("#doc h2") !== null`));
  await sleep(300);
  const heading = await view.webContents.executeJavaScript(`Math.round(document.getElementById("colour").getBoundingClientRect().top)`);
  check("ART-007 Markdown heading", heading >= 0 && heading < 80, `Colour heading top=${heading}px`);
  await shot(window, "09-markdown-heading");
  await hold(2500);
  await closeViewer(window);

  // ART-012: Office documents render in the viewer with their own renderers.
  const officeReady = (contents) => waitFor("Office document", () => contents.executeJavaScript(`document.getElementById("office")?.dataset.ready ?? null`), 15_000).catch(() => "timeout");
  say("Word: the wholesale proposal");
  await openArtifact(window, "Office documents", "Proposal");
  view = await viewerLoaded(window);
  const word = { ready: await officeReady(view.webContents), title: await view.webContents.executeJavaScript(`document.getElementById("office").innerText.includes("Wholesale proposal: Harbour Hotel")`) };
  check("ART-012 Word", word.ready === "true" && word.title, JSON.stringify(word));
  await shot(window, "19-word");
  await hold(2500);
  await closeViewer(window);
  say("Excel: every sheet, showing the totals the file saved");
  await openArtifact(window, "Office documents", "Budget");
  view = await viewerLoaded(window);
  const excel = {
    ready: await officeReady(view.webContents),
    tabs: await view.webContents.executeJavaScript(`[...document.querySelectorAll(".office-sheet-tab")].map((tab) => tab.textContent)`),
    total: await view.webContents.executeJavaScript(`[...document.querySelectorAll(".office-sheet tr")].at(-1)?.innerText.replace(/\\s+/g, " ").trim() ?? ""`),
  };
  check("ART-012 Excel", excel.ready === "true" && excel.tabs.join() === "Budget,Notes" && excel.total === "Total 34300 40200 40900 47600", JSON.stringify(excel));
  await shot(window, "20-excel");
  await hold(2500);
  await closeViewer(window);
  say("PowerPoint: the seed deck, opened at its chart slide");
  await openArtifact(window, "Office documents", "Seed deck (slide 3)");
  view = await viewerLoaded(window);
  const deck = {
    ready: await officeReady(view.webContents),
    slides: await view.webContents.executeJavaScript(`document.querySelectorAll(".office-slide").length`),
    bars: await view.webContents.executeJavaScript(`document.querySelectorAll('[data-slide="3"] svg rect').length`),
    address: await js(window, `document.querySelector(".artifact-strip-text")?.textContent`),
  };
  check("ART-012 PowerPoint at a slide, its chart drawn", deck.ready === "true" && deck.slides === 4 && deck.bars === 4 && deck.address === "docs/seed-pitch.pptx · slide 3", JSON.stringify(deck));
  await shot(window, "21-powerpoint");
  say("Annotate on a deck says which slide the note is about");
  await js(window, `document.querySelector('[aria-label="Annotate"]').click()`);
  await waitFor("note panel", () => js(window, `!!document.querySelector(".artifact-note-panel .artifact-note-field")`), 15_000);
  const slideWhere = await js(window, `document.querySelector(".artifact-note-where").textContent`);
  check("ART-012 a note on a deck names its slide", slideWhere === "Where: on slide 3", slideWhere);
  await shot(window, "22-powerpoint-annotate");
  await hold(2000);
  await js(window, `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await waitFor("panel closed", () => js(window, `document.querySelector(".artifact-note-panel") === null`));
  await closeViewer(window);

  // A page whose script fails.
  say("A page whose script fails gets a page-error badge");
  await openArtifact(window, "Things to check", "Menu board");
  await viewerLoaded(window);
  const errors = await waitFor("page error badge", () => js(window, `document.querySelector('[data-badge="errors"]')?.textContent ?? null`), 10_000).catch(() => null);
  check("PRD 6.6.5 page errors", errors === "1 page error", String(errors));
  await shot(window, "10-page-error");
  await hold(2500);
  await closeViewer(window);

  // A deployed https site (needs the network; reported, not required).
  say("A deployed https site");
  await openArtifact(window, "Things to check", "Deployed site");
  view = await viewerLoaded(window).catch(() => null);
  await sleep(1500);
  const address = await js(window, `document.querySelector(".artifact-strip-text")?.textContent`);
  check("ART-007 deployed https site", address.startsWith("https://example.com"), `address=${address} title=${view ? await view.webContents.executeJavaScript("document.title").catch(() => "?") : "no view"}`);
  await shot(window, "11-deployed-site");
  await hold(2500);
  await closeViewer(window);

  // After acceptance: an edited site, then a deleted video.
  await appendFile(join(folder, "site", "styles.css"), "\n/* edited after acceptance */\n");
  say("Edited after acceptance: a badge says so");
  await openArtifact(window, "Landing page", "Open the site");
  await viewerLoaded(window);
  const changed = await waitFor("changed badge", () => js(window, `document.querySelector('[data-badge="changed"]')?.textContent ?? null`), 10_000).catch(() => null);
  check("ART-004 changed since accepted", changed === "Changed since this was accepted", String(changed));
  await shot(window, "12-changed-since-accepted");
  await hold(2500);
  await closeViewer(window);
  await rm(join(folder, "media", "promo.webm"));
  say("Deleted after acceptance: the viewer says so and offers Add to chat");
  await openArtifact(window, "Promo video", "Watch it");
  const missing = await waitFor("missing card", () => js(window, `document.querySelector(".artifact-card:not([hidden]) h2")?.textContent ?? null`), 10_000).catch(() => null);
  check("ART-004 missing file", missing === "This file is no longer in the thread folder" && artifactView(window) === null, String(missing));
  await shot(window, "13-missing-file");
  await hold(2500);
  say("Add to chat drafts a message; nothing is sent until the person presses Enter");
  await js(window, `document.querySelector(".artifact-card-action")?.click()`);
  const drafted = await waitFor("chat draft", () => js(window, `document.querySelector("#threadPrompt")?.value.includes("is no longer in the thread folder") ? true : null`), 5_000).catch(() => false);
  check("PRD 6.6.5 Add to chat", drafted === true, `composer drafted: ${drafted}`);

  // ART-009: a web app starts from its server invoke after one approval, then is reused.
  await js(window, `document.querySelector("#threadPrompt") && (document.querySelector("#threadPrompt").value = "")`);
  say("A web app: Relayer asks once per thread before running its start command");
  await openArtifact(window, "Order desk", "Open the order desk");
  const asked = await waitFor("approval card", () => js(window, `document.querySelector(".artifact-card:not([hidden]) h2")?.textContent === "Start this web app?" ? document.querySelector(".artifact-card-command").textContent : null`), 15_000).catch(() => null);
  check("ART-009 asks before the first run", asked === `node app/server.mjs ${ORDER_DESK_PORT}` && artifactView(window) === null, String(asked));
  await hold(2500);
  await shot(window, "14-app-approval");
  say("Run starts it in the thread folder, confined to it, and the viewer opens it with its starting state");
  await js(window, `document.querySelector(".artifact-card-action").click()`);
  view = await waitFor("app view", () => {
    const candidate = artifactView(window);
    return candidate && !candidate.webContents.isLoading() && candidate.webContents.getURL().startsWith(`http://127.0.0.1:${ORDER_DESK_PORT}/`) ? candidate : null;
  }, 30_000);
  const app = await waitFor("app page", () => view.webContents.executeJavaScript(`(() => { const server = document.querySelector("#server").textContent; return server ? { member: document.querySelector("#member").textContent, count: document.querySelector("#count").textContent, server } : null; })()`), 10_000);
  check("ART-009 starts the app", app.server.startsWith("Served by process"), app.server);
  check("ART-010 web app cookies and storage seeded", app.member === "Signed in as Robin" && app.count === "1 open order", `${app.member}; ${app.count}`);
  await hold(3000);
  await shot(window, "15-app-running");
  await closeViewer(window);
  say("Reopening reuses the running server: no second approval, the same process");
  await openArtifact(window, "Order desk", "Open the order desk");
  view = await waitFor("app view again", () => {
    const candidate = artifactView(window);
    return candidate && !candidate.webContents.isLoading() && candidate.webContents.getURL().startsWith(`http://127.0.0.1:${ORDER_DESK_PORT}/`) ? candidate : null;
  }, 15_000);
  const again = await waitFor("app page again", () => view.webContents.executeJavaScript(`document.querySelector("#server").textContent || null`), 10_000);
  check("ART-009 reuses the server without asking again", again === app.server, `${again} (first open: ${app.server})`);
  await hold(2500);
  await closeViewer(window);
  say("A start command that fails shows its log, with Retry and Add to chat");
  await openArtifact(window, "Order desk", "Broken build");
  await waitFor("broken approval", () => js(window, `document.querySelector(".artifact-card:not([hidden]) h2")?.textContent === "Start this web app?"`), 15_000);
  await js(window, `document.querySelector(".artifact-card-action").click()`);
  const failure = await waitFor("failure card", () => js(window, `document.querySelector(".artifact-card:not([hidden]) h2")?.textContent === "The app did not start" ? { log: document.querySelector(".artifact-card-log")?.textContent ?? "", actions: [...document.querySelectorAll(".artifact-card-actions button")].map((b) => b.textContent) } : null`), 30_000).catch(() => null);
  check("ART-009 reports a failed start with its log", /Cannot find module/u.test(failure?.log ?? "") && failure.actions.join(",") === "Retry,Add to chat", JSON.stringify({ actions: failure?.actions, log: failure?.log.slice(0, 160) }));
  await hold(3000);
  await shot(window, "16-app-failed");
  await js(window, `document.querySelector(".artifact-card-actions button:last-child")?.blur()`);
  await js(window, `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await waitFor("viewer closed", () => js(window, `document.querySelector(".artifact-viewer") === null`));

  // ART-011: notes freeze the view and pause media, join the chat draft, and send as one interaction.
  say("Annotate: the view freezes on a screenshot and the video pauses while you write");
  await openArtifact(window, "Promo video", "Ship chapter");
  view = await viewerLoaded(window);
  await view.webContents.executeJavaScript(`document.querySelector("video").play()`);
  await sleep(1500);
  await js(window, `document.querySelector('[aria-label="Annotate"]').click()`);
  await waitFor("note panel", () => js(window, `!!document.querySelector(".artifact-note-panel .artifact-note-field")`), 15_000);
  const frozen = { paused: await view.webContents.executeJavaScript(`document.querySelector("video").paused`), hidden: !view.getVisible(), where: await js(window, `document.querySelector(".artifact-note-where").textContent`) };
  check("ART-011 Annotate freezes the view and pauses media", frozen.paused && frozen.hidden && /^Where: at 0:1\d$/u.test(frozen.where), JSON.stringify(frozen));
  say("Enter adds the note to the thread's chat draft");
  await js(window, `(() => { const field = document.querySelector(".artifact-note-field"); field.value = "The logo flickers in this shot"; field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
  await waitFor("note listed", () => js(window, `document.querySelectorAll(".artifact-note-list li").length === 1`), 15_000);
  await hold(2500);
  await shot(window, "17-annotate");
  await js(window, `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await waitFor("panel closed", () => js(window, `document.querySelector(".artifact-note-panel") === null`));
  const resumed = await waitFor("media resumed", () => view.webContents.executeJavaScript(`document.querySelector("video").paused ? null : true`), 5_000).catch(() => false);
  check("ART-011 media resumes when the panel closes", resumed === true && view.getVisible(), `playing=${resumed} visible=${view.getVisible()}`);
  await closeViewer(window);
  say("Back in the thread, the note waits as a chip; Send delivers it as one interaction");
  const chip = await waitFor("note chip", () => js(window, `[...document.querySelectorAll(".composer-context-pill")].map((pill) => pill.textContent.trim()).find((label) => label.includes("Ship chapter")) ?? null`), 15_000).catch(() => null);
  check("ART-011 notes join the chat draft", chip !== null, String(chip));
  await hold(2000);
  await shot(window, "18-note-in-composer");
  await js(window, `(() => { const prompt = document.querySelector("#threadPrompt"); prompt.value = "Please fix what I noted."; prompt.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await waitFor("send enabled", () => js(window, `document.querySelector("#sendInteraction").disabled ? null : true`), 15_000);
  await js(window, `document.querySelector("#sendInteraction").click()`);
  const sent = await waitFor("follow-up accepted", async () => {
    const detail = await request(`/api/threads/${thread.id}`);
    const last = detail.interactions.at(-1);
    return detail.interactions.length === 2 && last.completionStatus === "accepted" ? last : null;
  }, 90_000);
  const annotations = sent.contexts?.flatMap((context) => context.annotations ?? []) ?? [];
  check("ART-011 one interaction carries the note with where and its screenshot", annotations.length === 1 && /^The logo flickers in this shot\n— at 0:1\d · screenshot sha256:[0-9a-f]{64}$/u.test(annotations[0]), JSON.stringify(annotations));
  const received = JSON.parse(await readFile(join(output, "agent-previews", `input-${sent.graphNodeId}.json`), "utf8"));
  check("ART-011 the agent can open the note's screenshot", received.length === 1 && received[0].png === true, JSON.stringify(received));
  // A sent note makes the artifact node a context target; exports and shares still validate.
  const auth = { Cookie: `${productSession.cookie.name}=${productSession.cookie.value}`, "Content-Type": "application/json" };
  const exported = await fetch(new URL(`/api/threads/${thread.id}/export`, productSession.origin), { headers: auth });
  const shared = await fetch(new URL(`/api/threads/${thread.id}/share-export`, productSession.origin), { method: "POST", headers: auth, body: JSON.stringify({ title: "Tidewater launch kit" }) });
  const exportText = exported.ok ? await exported.text() : await exported.text().then((body) => body.slice(0, 300));
  check("ART-011 export and share accept artifact nodes and their notes", exported.ok && shared.ok && exportText.includes('"artifact"'), `export ${exported.status}, share ${shared.status}${exported.ok ? "" : `: ${exportText}`}`);
  await hold(2500);

  await hold(3000);
  if (recorder) await recorder.stop();
  const failed = results.filter((result) => !result.ok);
  await writeFile(join(output, "results.json"), JSON.stringify({ at: new Date().toISOString(), source, entryPoint: "desktop/main/index.mjs", inference: false, results, external }, null, 2));
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed. Evidence: ${output}`);
  return failed.length === 0;
}

void import("../desktop/main/index.mjs").then(async () => {
  await app.whenReady();
  const window = await waitFor("Relayer window", () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().startsWith("http://127.0.0.1:")), 120_000);
  await waitFor("desktop startup", () => productSession && !window.webContents.isLoading(), 120_000);
  let ok = false;
  try {
    ok = await run(window);
  } catch (error) {
    console.error(error);
    await writeFile(join(output, "failure.txt"), String(error.stack ?? error));
  }
  if (process.env.RELAYER_ARTIFACT_EVIDENCE_KEEP_OPEN === "1") return;
  app.exit(ok ? 0 : 1);
});
