import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerGraphClient, NodeObject, LayerObject, LayerLayoutObject, NodePlacementObject } from "@relayer/graph-client";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";

// Inference-free joined desktop proof. A deterministic harness accepts real graphs;
// archive, read, search and restoration use production APIs and the full main.js.
const root = resolve(import.meta.dirname, "..");
const output = resolve(process.env.RELAYER_ARCHIVE_EVIDENCE_DIR ?? join(root, ".relayer/evidence/thread-archive"));
const binary = join(process.env.CARGO_TARGET_DIR ?? join(root, "target"), "debug/relayer-app-server");
const sourceFiles = ["desktop/renderer/index.html", "desktop/renderer/styles.css", "desktop/renderer/src/main.js", "desktop/renderer/src/thread-archive.js", "desktop/renderer/src/navigation.js", "desktop/renderer/src/threads.js", "desktop/renderer/src/ui.js", "desktop/renderer/src/graph.js", "desktop/renderer/src/product-workspace/view.js", "desktop/renderer/src/product-workspace/model.js", "desktop/renderer/src/product-workspace/workspace.js", "crates/relayer-app-server/src/api/threads.rs", "crates/relayer-app-server/src/product/service.rs", "crates/relayer-app-server/src/storage/sqlite/threads.rs", "crates/relayer-app-server/src/storage/sqlite/migrations/0042_thread_archive.sql", "scripts/capture-thread-archive-evidence.mjs"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digest = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, hash(await readFile(join(root, file)))])));
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
app.on("window-all-closed", () => {});
let window, service, runtime, directory;
async function main() {
  const startHashes = await digest();
  directory = await mkdtemp(join(tmpdir(), "relayer-archive-evidence-"));
  await mkdir(output, { recursive: true });
  const frames = join(output, "frames"); await mkdir(frames, { recursive: true });
  const configuration = join(directory, "archive.yaml");
  await writeFile(configuration, "schemaVersion: 1\nname: fixture-archive\nimplementation: fixture.archive\nimplementationVersion: 1\npermissionBindings:\n  ask: {}\n  auto: {}\n  full: {}\nmodelCompatibility:\n  - providerId: codex\nexecutionAccessContracts: [managed-runtime@1]\nsettings: {}\n");
  runtime = new GraphCompleteRuntimeService({
    userDataDirectory: directory,
    graphServerBinary: join(process.env.CARGO_TARGET_DIR ?? join(root,"target"),"debug/relayer-graph-server"),
    configurationPaths: [configuration],
    additionalImplementations: { "fixture.archive": () => ({
      state: () => ({}),
      async complete(context, signal) {
        if (context.inputGraph.detail === "PENDING_ARCHIVE_FIXTURE") {
          await new Promise((done) => { if (signal.aborted) done(); else signal.addEventListener("abort",done,{once:true}); });
          throw new Error("Synthetic fixture cancelled");
        }
        const graph = new RelayerGraphClient(context.graph.acquireCapability());
        const node = new NodeObject("info", "Saved milestones", "Confirm owners, review progress, and prepare the next milestone. This graph remains intact when the chat is archived.", "clipboard-check", "milestones");
        await graph.submitNode(node);
        const layer = new LayerObject([node], [], new LayerLayoutObject([new NodePlacementObject(node,0.5,0.5)],"default"), "milestones-layer");
        await graph.submitLayer(layer);
        await graph.addAction(context.inputGraph.id,{kind:"navigate",relation:"expand",label:"Response",target:layer,clientKey:"response"});
        await graph.submit(context.inputGraph.id);
      },
    }) },
    acquireProviderExecution: async () => ({
      definition: { id:"codex",adapterId:"codex-subscription",accessContract:"managed-runtime@1" },
      descriptor: {adapterId:"codex-subscription",accessContract:"managed-runtime@1",implementationVersion:"1"},
      runtime: { async executionAccess() { return {kind:"managed-runtime",environment:{}}; } },
      async release() {},
    }),
  });
  const runtimeSession = await runtime.start();
  const serviceOptions = { userDataDirectory: directory, binaryPath: binary, webDirectory: join(root, "desktop/renderer"), permissionCatalogPath: join(root, "permissions/desktop.json"), enableReadOnlySession: true, runtimeSession, defaultHarnessConfiguration:"fixture-archive", allowHarnessOverride:true };
  service = new RelayerAppServerService(serviceOptions);
  let session = await service.start();
  await service.seedProviderCatalog({providerId:"codex",label:"Fixture provider",connected:true,models:[{id:"fixture-model",label:"Fixture model",order:0,visible:true,available:true,providerDefault:true,metadata:{}}],systemFamily:{key:"codex",name:"Codex",modelIds:["fixture-model"]}});
  const api = async (path, options = {}, readOnly = false) => {
    const cookie = readOnly ? session.readOnlyCookie : session.cookie;
    const response = await fetch(session.origin + path, { ...options, headers: { Cookie: `${cookie.name}=${cookie.value}`, ...(options.body ? { "Content-Type": "application/json" } : {}) } });
    return { status: response.status, body: await response.json() };
  };
  const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });
  const family = (await post("/api/model-families", {name:"Archive fixture",enabled:true,members:[{providerId:"codex",modelId:"fixture-model"}]})).body;
  const modelSelection = {familyId:family.id,providerId:"codex",modelId:"fixture-model"};
  const createFixture = async (body) => { const result = await post("/api/threads", {...body,harnessId:"fixture-archive",modelSelection}); assert.equal(result.status,201,JSON.stringify(result.body)); return result.body; };
  const project = (await post("/api/projects", { path: directory, name: "Demo project" })).body;
  const standalone = await createFixture({ title: "Quarterly planning", initialMessage: "Review the quarterly milestones." });
  const projectThread = await createFixture({ title: "Release checklist", projectId: project.id, initialMessage: "Prepare the release checklist." });
  const busy = await createFixture({ title: "Background analysis", initialMessage: "PENDING_ARCHIVE_FIXTURE" });
  assert.ok(standalone.id && projectThread.id && busy.id, "Fixture threads were created through the real API");
  for (const id of [standalone.id, projectThread.id]) {
    const deadline = Date.now()+15000;
    while (true) {
      const detail = (await api(`/api/threads/${id}`)).body;
      if (detail.interactions[0].completionStatus === "accepted" && !detail.thread.archiveBlocked) break;
      if (detail.interactions[0].completionStatus === "failed") throw new Error(detail.interactions[0].completionError);
      assert.ok(Date.now()<deadline,"Fixture accepted graph settled"); await wait(50);
    }
  }
  const busyRefusal = await post(`/api/threads/${busy.id}/archive`, { archived: true });
  assert.equal(busyRefusal.status, 409); assert.equal(busyRefusal.body.code, "thread_archive_busy");
  const readOnlyRefusal = await api(`/api/threads/${standalone.id}/archive`, { method: "POST", body: JSON.stringify({ archived: true }) }, true);
  assert.equal(readOnlyRefusal.status, 403);
  await app.whenReady();
  window = new BrowserWindow({ width: 1280, height: 840, useContentSize: true, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, partition: `archive-${Date.now()}` } });
  await window.webContents.session.cookies.set({ url: session.origin, ...session.cookie });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  const waitFor = async (label, source) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { if (await evaluate(source)) return; await wait(50); }
    await writeFile(join(output, "failure.png"), (await window.webContents.capturePage()).toPNG());
    throw new Error(`Missing checkpoint: ${label}; ${await evaluate("JSON.stringify({text:document.body.innerText.slice(0,1000),toast:document.querySelector('#toast').textContent})")}`);
  };
  window.webContents.on("console-message", (event, ...args) => console.log("Renderer:", event.message ?? args[1]));
  await window.loadURL(`${session.origin}/?threadId=${standalone.id}`);
  await waitFor("full application boot", `document.querySelector('#threadTitle')?.textContent === 'Quarterly planning' && document.querySelector('[data-archive-thread="${standalone.id}"]')`);
  window.webContents.debugger.attach("1.3");
  // capturePage omits the OS cursor. This noninteractive marker follows the
  // actual CDP pointer coordinates so the hover journey is visible in video.
  const move = async (point) => {
    await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await evaluate(`(() => {let e=document.getElementById('archiveEvidencePointer');if(!e){e=document.createElement('div');e.id='archiveEvidencePointer';e.style.cssText='position:fixed;width:12px;height:18px;background:white;clip-path:polygon(0 0,100% 65%,55% 68%,35% 100%);filter:drop-shadow(0 0 2px black);z-index:201;pointer-events:none';document.body.append(e);}e.style.left=${JSON.stringify(`${point.x}px`)};e.style.top=${JSON.stringify(`${point.y}px`)};})()`);
  };
  const click = async (selector) => {
    const point = await evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw Error('Missing click target'); e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await move(point);
    assert.equal(await evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});return Number(getComputedStyle(e).opacity)>0 && e.contains(document.elementFromPoint(${point.x},${point.y}));})()`), true, `Visible pointer target: ${selector}`);
    for (const type of ["mousePressed", "mouseReleased"]) await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
  };
  let frame = 0;
  const checkpoints = [];
  const capture = async (name, caption) => {
    await evaluate(`(() => { let e=document.getElementById('archiveEvidenceCaption'); if(!e) { e=document.createElement('div');e.id='archiveEvidenceCaption';e.style.cssText='position:fixed;right:24px;bottom:24px;padding:10px 14px;border-radius:8px;background:#17212b;color:white;font:14px system-ui;z-index:200;pointer-events:none';document.body.append(e); } e.textContent=${JSON.stringify(caption)}; })()`);
    await wait(250);
    for (let n = 0; n < 15; n++) {
      const image = (await window.webContents.capturePage()).toPNG();
      await writeFile(join(frames, `${String(frame++).padStart(4, "0")}.png`), image);
      if (n === 5) await writeFile(join(output, `${name}.png`), image);
      await wait(150);
    }
    checkpoints.push({ name, verdict: "passed", caption });
    console.log(`PASS ${name}`);
  };
  await evaluate(`const p=document.querySelector('#threadPrompt');p.value='Keep this unsent follow-up';p.dispatchEvent(new Event('input',{bubbles:true}));`);
  for (const id of [standalone.id, projectThread.id]) {
    assert.equal(await evaluate(`(() => {const b=document.querySelector('[data-archive-thread="${id}"]');return b.firstElementChild?.outerHTML === lucide.createElement(lucide.Trash2, {'aria-hidden':'true',focusable:'false'}).outerHTML && b.parentElement.lastElementChild === b && Math.abs(b.getBoundingClientRect().right-b.parentElement.getBoundingClientRect().right)<1;})()`), true);
  }
  checkpoints.push({ name: "direct-rightmost-trashcan", verdict: "passed" });
  const allIconsHidden = `Array.from(document.querySelectorAll('.thread-archive-button')).every(b=>Number(getComputedStyle(b).opacity)===0)`;
  await move({ x: 650, y: 160 });
  await evaluate("document.activeElement.blur()");
  assert.equal(await evaluate(allIconsHidden), true, "Archive icons hidden at rest");
  await capture("01-before", "Pointer away: archive icons stay hidden");
  for (const [id, name] of [[standalone.id, "selected"], [projectThread.id, "project"]]) {
    const point = await evaluate(`(() => {const r=document.querySelector('[data-thread="${id}"]').getBoundingClientRect();return {x:r.x+20,y:r.y+r.height/2};})()`);
    await move(point);
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('.thread-archive-button')).every(b=>Number(getComputedStyle(b).opacity)===(b.dataset.archiveThread===${JSON.stringify(String(id))}?1:0))`), true, "Only hovered row reveals Archive");
    await capture(`hover-${name}`, `Hover ${name} chat: only its archive icon appears`);
  }
  await move({ x: 650, y: 160 });
  assert.equal(await evaluate(allIconsHidden), true, "Archive icons hide after pointer leaves");
  await capture("hover-away", "Move away: archive icons hide again");
  const hoverDuration = frame / 6;
  const busyDisabled = await evaluate(`document.querySelector('[data-archive-thread="${busy.id}"]').disabled`); assert.equal(busyDisabled, true);
  await click(`[data-archive-thread="${projectThread.id}"]`);
  await waitFor("project archive hidden", `!document.querySelector('#projectList [data-thread="${projectThread.id}"]')`);
  await capture("02-project-archived", "2. The red trashcan archives a chat; Undo is available");
  await click("#toast button");
  await waitFor("undo restored project", `Boolean(document.querySelector('#projectList [data-thread="${projectThread.id}"]'))`);
  await capture("03-undo", "3. Undo restores the same project chat");
  await click("#conversationSettingsButton");
  await waitFor("thread archive menu", `document.querySelector('#archiveConversation').checkVisibility()`);
  await capture("04-thread-menu", "4. Archive is also available in the open chat menu");
  const readingPosition = await evaluate(`JSON.stringify({selected:[...document.querySelectorAll('#nodeLayer .selected')].map(e=>e.dataset.node),layer:document.querySelector('#workspaceBreadcrumb').textContent,camera:[document.querySelector('#graphStage').style.backgroundPosition,document.querySelector('#graphStage').style.backgroundSize,document.querySelector('#graphZoomLevel').textContent],scroll:document.querySelector('#graphStage').scrollTop})`);
  await click("#archiveConversation");
  await waitFor("retained archived workspace", `document.querySelector('#threadArchivedLabel').checkVisibility() && !document.querySelector('#chatList [data-thread="${standalone.id}"]')`);
  assert.equal(await evaluate(`document.querySelector('#threadPrompt').value`), "Keep this unsent follow-up");
  assert.equal(await evaluate(`document.querySelector('#sendInteraction').disabled`), true);
  assert.equal(await evaluate(`JSON.stringify({selected:[...document.querySelectorAll('#nodeLayer .selected')].map(e=>e.dataset.node),layer:document.querySelector('#workspaceBreadcrumb').textContent,camera:[document.querySelector('#graphStage').style.backgroundPosition,document.querySelector('#graphStage').style.backgroundSize,document.querySelector('#graphZoomLevel').textContent],scroll:document.querySelector('#graphStage').scrollTop})`), readingPosition);
  checkpoints.push({ name: "retained-reading-position-and-disabled-send", verdict: "passed" });
  await capture("05-current-archived", "5. The archived workspace stays open, with its draft intact");
  await click("#settingsButton"); await click('[data-settings-tab="archived"]');
  await waitFor("settings listing", `Boolean(document.querySelector('#archivedChatList [data-thread="${standalone.id}"]'))`);
  await evaluate(`const s=document.querySelector('#archivedChatSearch');s.value='quarterly';s.dispatchEvent(new Event('input',{bubbles:true}));`);
  await capture("06-settings", "6. Find archived chats only in Settings");
  await click(`#archivedChatList [data-thread="${standalone.id}"]`);
  await waitFor("explicit open restores", `document.querySelector('#threadTitle')?.textContent === 'Quarterly planning' && !document.querySelector('#threadArchivedLabel').checkVisibility() && document.querySelector('#chatList [data-thread="${standalone.id}"]')`);
  assert.equal(await evaluate(`document.querySelector('#threadPrompt').value`), "Keep this unsent follow-up");
  await capture("07-open-restores", "7. Opening restores the chat and preserves its draft");
  const beforeOrder = (await api("/api/threads")).body.threads.map((t) => t.id);
  await post(`/api/threads/${projectThread.id}/archive`, { archived: true });
  const archiveTime = (await api("/api/threads/archived")).body.threads[0].archivedAt;
  // A real app-server process restart preserves archive state; reads do not restore it.
  window.webContents.debugger.detach(); window.destroy(); window = null;
  await service.close();
  service = new RelayerAppServerService(serviceOptions);
  session = await service.start();
  assert.equal((await api("/api/threads/archived")).body.threads[0].archivedAt, archiveTime);
  await api(`/api/state?threadId=${projectThread.id}`);
  assert.equal((await api("/api/threads/archived")).body.threads[0].archivedAt, archiveTime);
  await post(`/api/threads/${projectThread.id}/archive`, { archived: false });
  assert.deepEqual((await api("/api/threads")).body.threads.map((t) => t.id), beforeOrder);
  checkpoints.push({ name: "process-reopen-and-order", verdict: "passed" }, { name: "busy-api-and-read-only-authority", verdict: "passed" });
  const video = join(output, "archive-demo.mp4");
  const ffmpeg = spawnSync(process.env.RELAYER_EVIDENCE_FFMPEG ?? "/opt/homebrew/bin/ffmpeg", ["-y", "-framerate", "6", "-i", join(frames, "%04d.png"), "-vf", "fps=12,format=yuv420p", "-c:v", "libx264", "-crf", "21", "-movflags", "+faststart", video], { encoding: "utf8" });
  if (ffmpeg.status !== 0) throw new Error(`Video encoding failed: ${ffmpeg.stderr.slice(-1000)}`);
  const hoverVideo = join(output, "hover-demo.mp4");
  const hoverEncoding = spawnSync(process.env.RELAYER_EVIDENCE_FFMPEG ?? "/opt/homebrew/bin/ffmpeg", ["-y", "-i", video, "-t", String(hoverDuration), "-c", "copy", "-movflags", "+faststart", hoverVideo], { encoding: "utf8" });
  if (hoverEncoding.status !== 0) throw new Error(`Hover video encoding failed: ${hoverEncoding.stderr.slice(-1000)}`);
  const endHashes = await digest(); assert.deepEqual(endHashes, startHashes, "Sources remained stable throughout capture");
  await writeFile(join(output, "manifest.json"), JSON.stringify({ version: 1, sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), sourceFiles: startHashes, workspaceDigest: hash(JSON.stringify(startHashes)), binarySha256: hash(await readFile(binary)), videoSha256: hash(await readFile(video)), hoverVideoSha256: hash(await readFile(hoverVideo)), checkpoints, syntheticFixture: "Real accepted graphs created by a deterministic inference-free harness; third completion held pending until cleanup", pointerMarker: "Noninteractive overlay follows actual CDP pointer coordinates", paidInferenceCalls: 0, platform: process.platform, architecture: process.arch, humanAcceptance: "pending" }, null, 2) + "\n");
  await rm(frames, { recursive: true, force: true });
  console.log(`PASS archive desktop evidence: ${video}`);
}
let exitCode = 0;
main().catch((error) => { console.error(error); exitCode = 1; })
  .finally(async () => { window?.destroy(); await service?.close(); await runtime?.close(); if (directory) await rm(directory, { recursive: true, force: true }); })
  .then(() => app.exit(exitCode));
