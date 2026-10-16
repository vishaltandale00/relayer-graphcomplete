/**
 * Opt-in live video of parallel runs with the same-node queue (issues #717, #718). Spends real
 * inference; never part of `npm run check`.
 *
 * It boots the GraphComplete runtime and app server the desktop uses, opens the production
 * renderer in an Electron window, and drives it as a person would. It clicks one invoke on node
 * A, a second invoke on the same node A, and one invoke on node B, then sends a follow-up
 * message. Node A's second run waits as Queued and starts only after A's first run ends, while
 * node B's run and the message run beside it. Frames come from the app window only. Stretches
 * where the model is working play at 5× speed, and the caption says so.
 *
 *   RELAYER_PARALLEL_INVOKE_LIVE_RUN=1 RELAYER_LIVE_PROFILE=prime-openrouter \
 *     ./node_modules/.bin/electron scripts/record-parallel-queue-video.mjs
 */
import { app, BrowserWindow } from "electron";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
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
const output = resolve(process.env.RELAYER_PARALLEL_VIDEO_DIR ?? join(repositoryRoot, ".relayer", "evidence", "parallel-queue-video"));
const ffmpeg = process.env.RELAYER_EVIDENCE_FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
const ACTIVE = new Set(["not_started", "queued", "submitted", "running", "waiting_for_approval"]);
const TERMINAL = new Set(["accepted", "failed", "stopped"]);
// Overlap counts only runs that started: a queued or still-starting run is not running beside
// the others, so it cannot satisfy the side-by-side check.
const RUNNING = new Set(["running", "waiting_for_approval"]);
const INVOKE_LABEL = "Plan a first week";
const SECOND_LABEL = "List three starter resources";
const ROOT_TASK = [
  "Compare three ways to learn a new programming language: building a small project, working",
  "through exercises, and reading other people's code. Present one node per approach. Give each",
  `node two invoke actions: one labelled "${INVOKE_LABEL}" whose interaction text asks for a`,
  `seven-day plan for that approach, and one labelled "${SECOND_LABEL}" whose interaction text`,
  "asks for three concrete starter resources for that approach. Leave those invoke actions for me",
  "to click; do not run them yourself.",
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
    issues: [717, 718],
    runId: randomUUID(),
    profile: profile.name,
    harness: profile.harness,
    modelId: profile.modelId,
    source: workspaceProvenance(repositoryRoot),
    startedAt: new Date().toISOString(),
  };
  let runtime;
  let productServer;
  let executables;
  let window;
  let recorder;
  const samples = [];
  try {
    let resolver;
    ({ runtime, productServer, resolver, executables } = await startLiveProduct({ profile, configurationPath, dataDirectory }));
    // The servers that ran, rebuilt from this source and named by hash.
    record.executables = executables;
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
    const byNode = new Map();
    for (const action of invokeActions) {
      const list = byNode.get(String(action.sourceNodeId)) ?? [];
      list.push(action);
      byNode.set(String(action.sourceNodeId), list);
    }
    const labelled = (actions, label) => actions.find((action) => action.label.includes(label));
    const nodes = [...byNode.values()].filter((actions) => labelled(actions, INVOKE_LABEL) && labelled(actions, SECOND_LABEL));
    if (nodes.length < 2) throw new Error(`The first answer gave both invoke actions to ${nodes.length} nodes; two are needed.`);
    const firstOnA = labelled(nodes[0], INVOKE_LABEL);
    const secondOnA = labelled(nodes[0], SECOND_LABEL);
    const firstOnB = labelled(nodes[1], INVOKE_LABEL);
    record.invokeActions = invokeActions.map(({ id, label, sourceNodeId }) => ({ id, label, sourceNodeId }));
    recorder.live();
    await page(`import('./src/threads.js').then(m => m.loadThread(${thread.id}))`);
    await until("the answer graph", () => page("document.querySelectorAll('[data-node]').length >= 2"), 60_000);
    recorder.caption("The answer: one node per approach, each with two invoke actions");
    await recorder.hold(3500);

    // Click the node, then the invoke button in its details, as a person does.
    const clickInvoke = async (action, caption, rows) => {
      recorder.caption(caption);
      await page(`document.querySelector('[data-node="${action.sourceNodeId}"]').click()`);
      await recorder.hold(1500);
      const clicked = await until(`the "${action.label}" button on node ${action.sourceNodeId}`, () => page(`(() => {
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
      record.clickedInvokes = [...(record.clickedInvokes ?? []), { actionId: action.id, label: action.label, sourceNodeId: action.sourceNodeId, clicked }];
      await until(`${rows} run row(s) on the node`, () => page(`document.querySelectorAll('#nodeRunBar .node-run-row').length >= ${rows}`), 30_000);
      await recorder.hold(2500);
    };
    await clickInvoke(firstOnA, `2. On node A, click "${firstOnA.label}": it starts running`, 1);
    await clickInvoke(secondOnA, `3. On the same node A, click "${secondOnA.label}": it waits as Queued`, 2);
    record.nodeARowsWhileQueued = await page("[...document.querySelectorAll('#nodeRunBar .node-run-row')].map((row) => row.textContent.trim().replace(/\\s+/g, ' '))");
    await recorder.hold(2000);
    await clickInvoke(firstOnB, `4. On a different node B, click "${firstOnB.label}": it runs at once`, 1);

    recorder.caption("5. While they run, send a follow-up message");
    await page(`(() => { const prompt = document.querySelector('#threadPrompt'); prompt.focus(); prompt.value = ${JSON.stringify(FOLLOW_UP)}; prompt.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await recorder.hold(2000);
    await until("an enabled Send", () => page("(() => { const send = document.querySelector('#sendInteraction'); return send && !send.disabled && !send.classList.contains('stop-button'); })()"), 30_000);
    const sentAtMs = Date.now();
    await page("document.querySelector('#sendInteraction').click()");
    // Exactly the clicked invokes' results and the sent message. With recursion on, the thread
    // can also hold agent children, which are not these runs.
    const runs = await until("all four runs admitted", async () => {
      const state = await productRequest(session, `/api/state?threadId=${thread.id}`);
      const resultOf = (action) => (state.actionInvocations ?? [])
        .find((invocation) => String(invocation.actionId) === String(action.id) && invocation.agentInvoked !== true)?.resultInteractionId;
      const anyInvocation = new Set((state.actionInvocations ?? []).map(({ resultInteractionId }) => String(resultInteractionId)));
      const message = (state.interactions ?? [])
        .filter((turn) => turn.threadId === thread.id && turn.id !== thread.rootInteractionId && !anyInvocation.has(String(turn.id)))
        .at(-1);
      const ids = { a1: resultOf(firstOnA), a2: resultOf(secondOnA), b: resultOf(firstOnB), message: message?.id };
      return Object.values(ids).every((id) => id != null) && ids;
    }, 30_000);
    record.admittedWithinMs = Date.now() - sentAtMs;
    const runIds = Object.values(runs);

    recorder.caption("Node A: one run Running, the next Queued behind it");
    await page(`document.querySelector('[data-node="${firstOnA.sourceNodeId}"]').click()`);
    await recorder.hold(3500);
    recorder.lapse();
    await until("all four runs to settle", async () => {
      const turns = await interactions();
      const statuses = Object.fromEntries(Object.entries(runs).map(([name, id]) => [name, turns.find((turn) => turn.id === id)?.completionStatus]));
      samples.push({ atMs: Date.now(), statuses });
      const active = Object.values(statuses).filter((status) => ACTIVE.has(status)).length;
      recorder.caption(`${active} of 4 active · node A second run: ${statuses.a2 === "queued" ? "Queued" : statuses.a2}`);
      return active === 0;
    });
    recorder.live();
    const settled = await interactions();
    record.runs = Object.entries(runs).map(([name, id]) => ({ name, interactionId: id, completionStatus: settled.find((turn) => turn.id === id)?.completionStatus }));
    record.samples = samples.length;
    const firstIndex = (test) => samples.findIndex(test);
    const a2Started = firstIndex(({ statuses }) => RUNNING.has(statuses.a2) || TERMINAL.has(statuses.a2));
    const a1Ended = firstIndex(({ statuses }) => TERMINAL.has(statuses.a1));
    record.checks = {
      allInvokesClickedInTheUi: (record.clickedInvokes ?? []).length === 3 && record.clickedInvokes.every(({ clicked }) => clicked),
      allAdmitted: runIds.length === 4,
      secondRunOnNodeQueued: samples.some(({ statuses }) => statuses.a2 === "queued" && ACTIVE.has(statuses.a1) && !TERMINAL.has(statuses.a1)),
      secondRunOnNodeStartedOnlyAfterTheFirstEnded: a1Ended >= 0 && a2Started >= a1Ended,
      differentNodesRanTogether: samples.some(({ statuses }) => RUNNING.has(statuses.a1) && RUNNING.has(statuses.b)),
      messageRanBesideTheInvokes: samples.some(({ statuses }) => RUNNING.has(statuses.message) && (RUNNING.has(statuses.a1) || RUNNING.has(statuses.b))),
      allAccepted: record.runs.every(({ completionStatus }) => completionStatus === "accepted"),
    };
    record.passed = Object.values(record.checks).every(Boolean);

    // The ending only shows the results; a hiccup here never changes the checks above.
    try {
      recorder.caption("All four runs accepted");
      await recorder.hold(3500);
      recorder.caption("Back on the first answer, each invoked node now opens its own results");
      await page(`import('./src/threads.js').then(m => m.selectTurnById(${thread.rootInteractionId}))`);
      await until("the first answer's nodes", () => page(`Boolean(document.querySelector('[data-node="${firstOnA.sourceNodeId}"]'))`), 30_000);
      await recorder.hold(1500);
      await page(`document.querySelector('[data-node="${firstOnA.sourceNodeId}"]').click()`);
      await recorder.hold(2500);
      const opened = await page(`(() => {
        const roots = [document.querySelector('#inspectorContent')];
        const seen = [];
        while (roots.length) {
          const root = roots.shift();
          if (!root) continue;
          for (const element of root.querySelectorAll('*')) {
            if (element.shadowRoot) roots.push(element.shadowRoot);
            if (element.matches('button, [role="button"], a') && !element.disabled && element.textContent.includes(${JSON.stringify(firstOnA.label)})) seen.push(element);
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
      const video = join(output, "parallel-queue.mp4");
      await recorder.stop(video).catch((error) => { record.videoError = String(error); });
      // The video is the evidence: a run whose recording or encoding failed does not pass.
      if (record.videoError === undefined && !(existsSync(video) && statSync(video).size > 0)) {
        record.videoError = "The encoder produced no video.";
      }
    } else {
      record.videoError ??= "The recorder never started.";
    }
    if (record.videoError !== undefined) record.passed = false;
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
const profileDirectory = mkdtempSync(join(tmpdir(), "relayer-parallel-queue-video-profile-"));
app.setPath("userData", profileDirectory);
app.setName("Relayer parallel queue video");
app.commandLine.appendSwitch("disable-gpu");
void app.whenReady().then(main).then(
  (code) => { rmSync(profileDirectory, { recursive: true, force: true }); app.exit(code); },
  (error) => { console.error(error); rmSync(profileDirectory, { recursive: true, force: true }); app.exit(1); },
);
