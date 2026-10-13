/**
 * Opt-in live video of parallel invoke runs (issue #717). Spends real inference; never part of
 * `npm run check`.
 *
 * It boots the GraphComplete runtime and app server the desktop uses, opens the production
 * renderer in an Electron window, and drives it as a person would: it clicks two invoke actions
 * on different nodes, then sends a follow-up message while they run. The video shows all three
 * running at once, each run's Stop on its own node, and the results. Frames come from the app
 * window only. Stretches where the model is working play at 5× speed, and the caption says so.
 *
 *   RELAYER_PARALLEL_INVOKE_LIVE_RUN=1 RELAYER_LIVE_PROFILE=prime-openrouter \
 *     ./node_modules/.bin/electron scripts/record-parallel-invoke-video.mjs
 */
import { app, BrowserWindow } from "electron";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

import { preparePrimeEnvironment, prepareRoute, readProfile, startLiveProduct } from "./live-run-setup.mjs";
import { productRequest } from "./recursive-live-run-transport.mjs";
import { workspaceProvenance, writeJsonAtomic } from "./recursive-live-run-provenance.mjs";

const OPT_IN = "RELAYER_PARALLEL_INVOKE_LIVE_RUN";
const repositoryRoot = resolve(import.meta.dirname, "..");
const output = resolve(process.env.RELAYER_PARALLEL_VIDEO_DIR ?? join(repositoryRoot, ".relayer", "evidence", "parallel-invoke-video"));
const ffmpeg = process.env.RELAYER_EVIDENCE_FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
const ACTIVE = new Set(["not_started", "submitted", "running", "waiting_for_approval"]);
// Overlap counts only runs that started: a queued or still-starting run is not running beside
// the others, so it cannot satisfy the side-by-side check.
const RUNNING = new Set(["running", "waiting_for_approval"]);
const INVOKE_LABEL = "Plan a first week";
const ROOT_TASK = [
  "Compare three ways to learn a new programming language: building a small project, working",
  "through exercises, and reading other people's code. Present one node per approach. Give each",
  `node an invoke action labelled "${INVOKE_LABEL}" whose interaction text asks for a`,
  "seven-day plan for that approach. Leave those invoke actions for me to click; do not run them",
  "yourself.",
].join(" ");
const FOLLOW_UP = "In one sentence, which approach suits someone with only twenty minutes a day?";
const FPS = 5;
const WIDTH = 1440;
const TIMEOUT_MS = 20 * 60 * 1000;

const run = promisify(execFile);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const escapeXml = (text) => text.replace(/[&<>"]/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Frames of the app window. Live mode captures in real time; lapse mode keeps one frame a second. */
function createRecorder(window, framesDirectory) {
  let caption = "";
  let mode = "live";
  let index = 0;
  let running = false;
  let loop = null;
  async function frame() {
    const image = sharp((await window.webContents.capturePage()).toPNG()).resize({ width: WIDTH });
    const { data, info } = await image.png().toBuffer({ resolveWithObject: true });
    const text = mode === "lapse" ? `${caption}   (5× speed while the model works)` : caption;
    if (!text) return data;
    const bar = Buffer.from(`<svg width="${info.width}" height="60" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#000" fill-opacity="0.8"/><text x="50%" y="39" text-anchor="middle" fill="#fff" font-family="-apple-system, Helvetica, sans-serif" font-size="24">${escapeXml(text)}</text></svg>`);
    return sharp(data).composite([{ input: bar, left: 0, top: info.height - 60 }]).png().toBuffer();
  }
  return {
    start() {
      running = true;
      loop = (async () => {
        while (running) {
          const started = Date.now();
          try {
            await writeFile(join(framesDirectory, `${String(index++).padStart(6, "0")}.png`), await frame());
          } catch {
            index -= 1;
          }
          // Live: one frame per 1/FPS second. Lapse: one frame per second, played at FPS.
          const interval = mode === "lapse" ? 1000 : 1000 / FPS;
          await sleep(Math.max(0, interval - (Date.now() - started)));
        }
      })();
    },
    caption(text) { caption = text; },
    live() { mode = "live"; },
    lapse() { mode = "lapse"; },
    async hold(ms) { await sleep(ms); },
    async stop(video) {
      running = false;
      await loop;
      await run(ffmpeg, ["-y", "-framerate", String(FPS), "-i", join(framesDirectory, "%06d.png"), "-vf", "fps=30,pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "24", "-movflags", "+faststart", video], { maxBuffer: 8 * 1024 * 1024 });
    },
  };
}

async function main() {
  if (process.env[OPT_IN] !== "1") throw new Error(`This live video spends real inference. Set ${OPT_IN}=1.`);
  const { profile, configurationPath } = await readProfile(
    resolve(process.env.RELAYER_LIVE_CREDENTIALS ?? "live-run.local.json"),
    process.env.RELAYER_LIVE_PROFILE ?? "",
  );
  if (profile.implementation === "prime.agent") await preparePrimeEnvironment();
  mkdirSync(output, { recursive: true });
  const framesDirectory = join(output, "frames");
  rmSync(framesDirectory, { recursive: true, force: true });
  mkdirSync(framesDirectory, { recursive: true });
  const dataDirectory = mkdtempSync(join(tmpdir(), "relayer-parallel-video-"));
  const record = {
    schemaVersion: 1,
    issue: 717,
    runId: randomUUID(),
    profile: profile.name,
    harness: profile.harness,
    modelId: profile.modelId,
    source: workspaceProvenance(repositoryRoot),
    startedAt: new Date().toISOString(),
  };
  let runtime;
  let productServer;
  let window;
  let recorder;
  const samples = [];
  try {
    let resolver;
    ({ runtime, productServer, resolver } = await startLiveProduct({ profile, configurationPath, dataDirectory }));
    record.temporalFeatures = runtime.temporalFeatures;
    const session = await productServer.start();
    const family = await prepareRoute({ session, productServer, runtime, resolver, profile });
    const modelSelection = { familyId: family.id, providerId: profile.providerId, modelId: profile.modelId };

    window = new BrowserWindow({ width: WIDTH, height: 900, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await window.webContents.session.cookies.set({ url: session.origin, name: session.cookie.name, value: session.cookie.value, httpOnly: true, sameSite: "strict" });
    await window.loadURL(session.origin);
    const page = (script) => window.webContents.executeJavaScript(script);
    const until = async (label, check, timeoutMs = TIMEOUT_MS) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
        await sleep(250);
      }
    };
    await until("renderer boot", () => page("import('./src/state.js').then(m => Boolean(m.appState.modelSettings))"));
    recorder = createRecorder(window, framesDirectory);
    recorder.start();

    recorder.caption("1. Ask a question in a new thread");
    const thread = await productRequest(session, "/api/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Learning a new language", initialMessage: ROOT_TASK, harnessId: profile.harness, permissionProfileId: "auto", modelSelection }),
    });
    await page(`import('./src/threads.js').then(m => m.loadThread(${thread.id}))`);
    await recorder.hold(2500);
    recorder.lapse();
    const interactions = async () => (await productRequest(session, `/api/threads/${thread.id}`)).interactions ?? [];
    const root = await until("the first answer", async () => {
      const turn = (await interactions()).find(({ id }) => id === thread.rootInteractionId);
      if (turn && ["failed", "stopped"].includes(turn.completionStatus)) throw new Error(`The first turn ended ${turn.completionStatus}`);
      return turn?.completionStatus === "accepted" && turn;
    });
    const invokeActions = (root.completionOutput?.rootLayer?.actions ?? []).filter((action) => action.kind === "invoke" && action.targetLayerId == null);
    const sources = [...new Map(invokeActions.map((action) => [String(action.sourceNodeId), action])).values()];
    if (sources.length < 2) throw new Error(`The first answer authored invoke actions on ${sources.length} nodes; two are needed.`);
    record.invokeActions = invokeActions.map(({ id, label, sourceNodeId }) => ({ id, label, sourceNodeId }));
    recorder.live();
    await page(`import('./src/threads.js').then(m => m.loadThread(${thread.id}))`);
    await until("the answer graph", () => page("document.querySelectorAll('[data-node]').length >= 2"), 60_000);
    recorder.caption("The answer: one node per approach, each with an invoke action");
    await recorder.hold(3500);

    // Click the node, then the invoke button in its details, as a person does.
    const clickInvoke = async (action, step) => {
      recorder.caption(`${step}. Select a node and click "${action.label}"`);
      await page(`document.querySelector('[data-node="${action.sourceNodeId}"]').click()`);
      await recorder.hold(1500);
      const clicked = await until(`the invoke button on node ${action.sourceNodeId}`, () => page(`(() => {
        const roots = [document.querySelector('#inspectorContent')];
        const seen = [];
        while (roots.length) {
          const root = roots.shift();
          if (!root) continue;
          for (const element of root.querySelectorAll('*')) {
            if (element.shadowRoot) roots.push(element.shadowRoot);
            const clickable = element.matches('button, [role="button"], a');
            if (clickable && !element.disabled && element.textContent.includes(${JSON.stringify(action.label)})) seen.push(element);
          }
        }
        const target = seen.at(-1);
        if (!target) return false;
        target.click();
        return true;
      })()`), 30_000);
      record.clickedInvokes = [...(record.clickedInvokes ?? []), { actionId: action.id, sourceNodeId: action.sourceNodeId, clicked }];
      await until("the run's Stop on its node", () => page("document.querySelectorAll('#nodeRunBar .node-run-row').length >= 1"), 30_000);
      await recorder.hold(2500);
    };
    await clickInvoke(sources[0], 2);
    await clickInvoke(sources[1], 3);

    recorder.caption("4. While both run, send a follow-up message");
    await page(`(() => { const prompt = document.querySelector('#threadPrompt'); prompt.focus(); prompt.value = ${JSON.stringify(FOLLOW_UP)}; prompt.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await recorder.hold(2000);
    await until("an enabled Send", () => page("(() => { const send = document.querySelector('#sendInteraction'); return send && !send.disabled && !send.classList.contains('stop-button'); })()"), 30_000);
    const sentAtMs = Date.now();
    await page("document.querySelector('#sendInteraction').click()");
    // Exactly the clicked invokes' results and the sent message. With recursion on, the thread
    // can also hold agent children, which are not these runs.
    const runIds = await until("all three runs admitted", async () => {
      const state = await productRequest(session, `/api/state?threadId=${thread.id}`);
      const clicked = new Set((record.clickedInvokes ?? []).map(({ actionId }) => String(actionId)));
      const invoked = (state.actionInvocations ?? [])
        .filter((invocation) => clicked.has(String(invocation.actionId)) && invocation.agentInvoked !== true)
        .map((invocation) => invocation.resultInteractionId);
      const anyInvocation = new Set((state.actionInvocations ?? []).map(({ resultInteractionId }) => String(resultInteractionId)));
      const message = (state.interactions ?? [])
        .filter((turn) => turn.threadId === thread.id && turn.id !== thread.rootInteractionId && !anyInvocation.has(String(turn.id)))
        .at(-1);
      return invoked.length === 2 && message && [...invoked, message.id];
    }, 30_000);
    record.admittedWithinMs = Date.now() - sentAtMs;

    recorder.caption("Two invokes and a message, all running at once");
    await page(`document.querySelector('[data-node="${sources[0].sourceNodeId}"]').click()`);
    await recorder.hold(3000);
    record.nodeRunRowsDuringRuns = await page("document.querySelectorAll('#nodeRunBar .node-run-row').length");
    recorder.lapse();
    await until("all three runs to settle", async () => {
      const turns = await interactions();
      const statuses = Object.fromEntries(turns.filter(({ id }) => runIds.includes(id)).map(({ id, completionStatus }) => [id, completionStatus]));
      samples.push({ atMs: Date.now(), statuses });
      const active = Object.values(statuses).filter((status) => ACTIVE.has(status)).length;
      recorder.caption(`${active} of 3 running`);
      return active === 0;
    });
    recorder.live();
    const settled = (await interactions()).filter(({ id }) => runIds.includes(id));
    record.runs = settled.map(({ id, completionStatus }) => ({ interactionId: id, completionStatus }));
    const maxActiveAtOnce = Math.max(0, ...samples.map(({ statuses }) => Object.values(statuses).filter((status) => RUNNING.has(status)).length));
    record.maxActiveAtOnce = maxActiveAtOnce;
    record.allActiveTogetherMs = samples.reduce((total, sample, index) => {
      const next = samples[index + 1];
      const all = Object.values(sample.statuses).length === 3 && Object.values(sample.statuses).every((status) => RUNNING.has(status));
      return next && all ? total + (next.atMs - sample.atMs) : total;
    }, 0);
    record.checks = {
      bothInvokesClickedInTheUi: (record.clickedInvokes ?? []).length === 2 && record.clickedInvokes.every(({ clicked }) => clicked),
      allAdmitted: runIds.length === 3,
      ranSideBySide: maxActiveAtOnce >= 3 && record.allActiveTogetherMs > 0,
      nodeShowedItsOwnStop: record.nodeRunRowsDuringRuns === 1,
      allAccepted: record.runs.every(({ completionStatus }) => completionStatus === "accepted"),
    };
    record.passed = Object.values(record.checks).every(Boolean);

    // The ending only shows the results; a hiccup here never changes the checks above.
    try {
      recorder.caption("The follow-up message's answer opened, as a message's answer does");
      await recorder.hold(3500);
      recorder.caption("Back on the first answer, each invoked node now opens its own result");
      await page(`import('./src/threads.js').then(m => m.selectTurnById(${thread.rootInteractionId}))`);
      await until("the first answer's nodes", () => page(`Boolean(document.querySelector('[data-node="${sources[0].sourceNodeId}"]'))`), 30_000);
      await recorder.hold(1500);
      await page(`document.querySelector('[data-node="${sources[0].sourceNodeId}"]').click()`);
      await recorder.hold(2500);
      const opened = await page(`(() => {
        const roots = [document.querySelector('#inspectorContent')];
        const seen = [];
        while (roots.length) {
          const root = roots.shift();
          if (!root) continue;
          for (const element of root.querySelectorAll('*')) {
            if (element.shadowRoot) roots.push(element.shadowRoot);
            if (element.matches('button, [role="button"], a') && !element.disabled && element.textContent.includes(${JSON.stringify(sources[0].label)})) seen.push(element);
          }
        }
        const target = seen[0];
        if (!target) return false;
        target.click();
        return true;
      })()`);
      record.openedResult = opened;
      recorder.caption(opened ? "The invoked run's result: a seven-day plan" : "The invoked node with its finished run");
      await recorder.hold(5000);
    } catch (error) {
      record.endingError = error instanceof Error ? error.message : String(error);
    }
  } catch (error) {
    record.passed = false;
    record.failure = error instanceof Error ? error.message : String(error);
    if (window && !window.isDestroyed()) await writeFile(join(output, "failure.png"), (await window.webContents.capturePage()).toPNG()).catch(() => {});
  } finally {
    if (recorder) {
      await recorder.stop(join(output, "parallel-invokes.mp4")).catch((error) => { record.videoError = String(error); });
    }
    rmSync(framesDirectory, { recursive: true, force: true });
    record.finishedAt = new Date().toISOString();
    writeJsonAtomic(join(output, "video-run.json"), record);
    console.log(JSON.stringify(record, null, 2));
    window?.destroy();
    await productServer?.close().catch(() => {});
    await runtime?.close().catch(() => {});
    rmSync(dataDirectory, { recursive: true, force: true });
  }
  return record.passed ? 0 : 1;
}

// An isolated profile: the run never reads or writes the person's own app data.
const profileDirectory = mkdtempSync(join(tmpdir(), "relayer-parallel-video-profile-"));
app.setPath("userData", profileDirectory);
app.setName("Relayer parallel invoke video");
app.commandLine.appendSwitch("disable-gpu");
void app.whenReady().then(main).then(
  (code) => { rmSync(profileDirectory, { recursive: true, force: true }); app.exit(code); },
  (error) => { console.error(error); rmSync(profileDirectory, { recursive: true, force: true }); app.exit(1); },
);
