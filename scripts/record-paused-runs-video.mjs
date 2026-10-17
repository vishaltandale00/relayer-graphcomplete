/**
 * Opt-in live video of paused runs after a restart (issue #722). Spends real inference; never
 * part of `npm run check`.
 *
 * It clicks three invoke actions on one node, so one runs and two queue behind it, then quits
 * the app server and runtime mid-run and starts them again on the same data. It shows that
 * nothing starts on its own: the running run is Interrupted by restart and the queued runs are
 * Paused, with the thread's paused badge and the restart notice. It discards one run, resumes
 * the node's chain, and checks that the chain runs in order. Frames come from the app window.
 * Stretches where the model is working play at 5× speed, and the caption says so.
 *
 *   RELAYER_PARALLEL_INVOKE_LIVE_RUN=1 RELAYER_LIVE_PROFILE=prime-openrouter \
 *     ./node_modules/.bin/electron scripts/record-paused-runs-video.mjs
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
const output = resolve(process.env.RELAYER_PARALLEL_VIDEO_DIR ?? join(repositoryRoot, ".relayer", "evidence", "paused-runs-video"));
const ffmpeg = process.env.RELAYER_EVIDENCE_FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
const ACTIVE = new Set(["not_started", "queued", "submitted", "running", "waiting_for_approval"]);
const HELD = new Set(["paused", "interrupted"]);
const TERMINAL = new Set(["accepted", "failed", "stopped"]);
// Overlap counts only runs that started: a queued or still-starting run is not running beside
// the others, so it cannot satisfy the side-by-side check.
const RUNNING = new Set(["running", "waiting_for_approval"]);
const LABELS = ["Plan a first week", "List three starter resources", "Suggest a practice project"];
const ROOT_TASK = [
  "Compare three ways to learn a new programming language: building a small project, working",
  "through exercises, and reading other people's code. Present one node per approach. Give the",
  `"building a small project" node three invoke actions labelled "${LABELS[0]}", "${LABELS[1]}"`,
  `and "${LABELS[2]}", each asking for that piece of work for that approach. Leave those invoke`,
  "actions for me to click; do not run them yourself.",
].join(" ");
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
  const dataDirectory = mkdtempSync(join(tmpdir(), "relayer-paused-video-"));
  const record = {
    schemaVersion: 1,
    issues: [722],
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
  try {
    let resolver;
    ({ runtime, productServer, resolver, executables } = await startLiveProduct({ profile, configurationPath, dataDirectory }));
    record.executables = executables;
    record.temporalFeatures = runtime.temporalFeatures;
    let session = await productServer.start();
    const family = await prepareRoute({ session, productServer, runtime, resolver, profile });
    const modelSelection = { familyId: family.id, providerId: profile.providerId, modelId: profile.modelId };

    window = new BrowserWindow({ width: WIDTH, height: 900, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
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
    const attach = async () => {
      await window.webContents.session.cookies.set({ url: session.origin, name: session.cookie.name, value: session.cookie.value, httpOnly: true, sameSite: "strict" });
      await window.loadURL(session.origin);
      await until("renderer boot", () => page("import('./src/state.js').then(m => Boolean(m.appState.modelSettings))"), 120_000);
    };
    await attach();
    recorder = createRecorder(window, framesDirectory);
    recorder.start();

    recorder.caption("1. Ask a question in a new thread");
    const thread = await productRequest(session, "/api/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Paused runs", initialMessage: ROOT_TASK, harnessId: profile.harness, permissionProfileId: "auto", modelSelection }),
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
    const actions = (root.completionOutput?.rootLayer?.actions ?? []).filter((action) => action.kind === "invoke" && action.targetLayerId == null);
    const byLabel = LABELS.map((label) => actions.find((action) => action.label.includes(label)));
    if (byLabel.some((action) => !action) || new Set(byLabel.map((action) => String(action.sourceNodeId))).size !== 1) {
      throw new Error(`The first answer did not give one node all three invoke actions: ${JSON.stringify(actions.map(({ label, sourceNodeId }) => ({ label, sourceNodeId })))}`);
    }
    const nodeId = byLabel[0].sourceNodeId;
    record.actions = byLabel.map(({ id, label, sourceNodeId }) => ({ id, label, sourceNodeId }));
    recorder.live();
    await page(`import('./src/threads.js').then(m => m.loadThread(${thread.id}))`);
    await until("the answer graph", () => page("document.querySelectorAll('[data-node]').length >= 3"), 60_000);
    recorder.caption("The answer: one node offers three invoke actions");
    await recorder.hold(3000);

    const clickInvoke = async (label) => {
      await page(`document.querySelector('[data-node="${nodeId}"]').click()`);
      await recorder.hold(1000);
      return until(`the "${label}" button`, () => page(`(() => {
        const roots = [document.querySelector('#inspectorContent')];
        const seen = [];
        while (roots.length) {
          const root = roots.shift();
          if (!root) continue;
          for (const element of root.querySelectorAll('*')) {
            if (element.shadowRoot) roots.push(element.shadowRoot);
            if (element.matches('button, [role="button"], a') && !element.disabled && element.textContent.includes(${JSON.stringify(label)})) seen.push(element);
          }
        }
        const target = seen.at(-1);
        if (!target) return false;
        target.click();
        return true;
      })()`), 30_000);
    };
    recorder.caption("2. Click all three on the same node: one runs, two queue behind it");
    for (const label of LABELS) {
      record.clicked = [...(record.clicked ?? []), await clickInvoke(label)];
      await recorder.hold(1500);
    }
    const runs = await until("all three runs admitted", async () => {
      const state = await productRequest(session, `/api/state?threadId=${thread.id}`);
      const ids = byLabel.map((action) => (state.actionInvocations ?? []).find((item) => String(item.actionId) === String(action.id) && item.agentInvoked !== true)?.resultInteractionId);
      return ids.every((id) => id != null) && ids;
    }, 30_000);
    record.runIds = runs;
    const statuses = async () => {
      const turns = await interactions();
      return runs.map((id) => turns.find((turn) => turn.id === id)?.completionStatus);
    };
    const texts = async () => {
      const turns = await interactions();
      return runs.map((id) => turns.find((turn) => turn.id === id)?.text);
    };
    record.beforeRestart = await until("one running and two queued", async () => {
      const now = await statuses();
      return now[0] === "running" && now[1] === "queued" && now[2] === "queued" && now;
    }, 120_000);
    record.textsBefore = await texts();
    await recorder.hold(2500);

    recorder.caption("3. Quit Relayer while the first run is working");
    await recorder.hold(1500);
    await productServer.close();
    await runtime.close();
    await recorder.hold(2000);
    recorder.caption("Relayer starts again on the same data");
    ({ runtime, productServer, resolver } = await startLiveProduct({ profile, configurationPath, dataDirectory }));
    session = await productServer.start();
    try {
      await prepareRoute({ session, productServer, runtime, resolver, profile });
    } catch (error) {
      record.reconnectNote = error instanceof Error ? error.message : String(error);
    }
    await attach();
    await page(`import('./src/threads.js').then(m => m.loadThread(${thread.id}))`);
    record.afterRestart = await until("the restarted runs", async () => {
      const now = await statuses();
      return now.every((status) => status !== undefined) && now;
    }, 60_000);
    recorder.caption("4. After the restart nothing starts on its own");
    const heldAt = Date.now();
    const heldSamples = [];
    while (Date.now() - heldAt < 12_000) {
      heldSamples.push(await statuses());
      await sleep(1000);
    }
    record.heldSamples = heldSamples;
    record.pausedBadge = await page(`document.querySelector('[data-thread="${thread.id}"] .thread-paused-badge')?.textContent?.trim() ?? null`);

    recorder.caption("5. Open the interaction graph: the restart notice and paused runs");
    await page("document.querySelector('#turnPickerButton').click()");
    await until("the run view", () => page("Boolean(document.querySelector('#turnPopover .interaction-graph-card'))"), 30_000);
    record.restartNotice = await page("document.querySelector('.interaction-graph-restart-notice')?.textContent?.trim().replace(/\\s+/g, ' ') ?? null");
    await recorder.hold(4000);

    recorder.caption("6. Discard the last run; its text is kept");
    const control = (action, id) => `(() => {
      const deck = document.querySelector('[data-deck-for="${runs[0]}"]');
      if (deck && deck.getAttribute('aria-expanded') === 'false') deck.click();
      const button = document.querySelector('[data-run-action="${action}"][data-run-id="${id}"]');
      if (!button) return false;
      button.closest('.interaction-graph-card, li')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      button.focus();
      button.click();
      return true;
    })()`;
    await until("the Discard control", () => page(control("discard", runs[2])), 30_000);
    await until("the discarded run to stop", async () => (await statuses())[2] === "stopped", 60_000);
    await recorder.hold(3000);

    recorder.caption("7. Resume the node's chain: its runs start again in order");
    await until("the Resume control", () => page(control("resume", runs[0])), 30_000);
    await recorder.hold(2500);
    recorder.lapse();
    const resumedSamples = [];
    await until("the resumed chain to finish", async () => {
      const now = await statuses();
      resumedSamples.push({ atMs: Date.now(), now });
      recorder.caption(`Resumed: first ${now[0]}, second ${now[1]}`);
      return TERMINAL.has(now[0]) && TERMINAL.has(now[1]);
    });
    recorder.live();
    record.resumedSamples = resumedSamples.length;
    record.final = await statuses();
    record.textsAfter = await texts();
    const firstEnded = resumedSamples.findIndex(({ now }) => TERMINAL.has(now[0]));
    const secondStarted = resumedSamples.findIndex(({ now }) => now[1] === "running" || TERMINAL.has(now[1]));
    record.checks = {
      allClickedInTheUi: (record.clicked ?? []).length === 3 && record.clicked.every(Boolean),
      oneRanAndTwoQueuedBeforeRestart: true,
      restartInterruptedTheRunAndPausedTheQueue: record.afterRestart[0] === "interrupted" && record.afterRestart[1] === "paused" && record.afterRestart[2] === "paused",
      nothingStartedOnItsOwn: heldSamples.every((sample) => sample.every((status) => HELD.has(status))),
      pausedBadgeShown: typeof record.pausedBadge === "string" && /\d/.test(record.pausedBadge),
      restartNoticeShown: typeof record.restartNotice === "string" && record.restartNotice.length > 0,
      discardStoppedTheRunAndKeptItsText: record.final[2] === "stopped" && record.textsAfter[2] === record.textsBefore[2] && Boolean(record.textsAfter[2]),
      resumeRanTheChainInOrder: firstEnded >= 0 && secondStarted >= firstEnded,
      resumedRunsAccepted: record.final[0] === "accepted" && record.final[1] === "accepted",
    };
    record.passed = Object.values(record.checks).every(Boolean);
    recorder.caption("The resumed runs are accepted; the discarded run stays stopped");
    await recorder.hold(4000);
  } catch (error) {
    record.passed = false;
    record.failure = error instanceof Error ? error.message : String(error);
    if (window && !window.isDestroyed()) await writeFile(join(output, "failure.png"), (await window.webContents.capturePage()).toPNG()).catch(() => {});
  } finally {
    if (recorder) {
      const video = join(output, "paused-runs.mp4");
      await recorder.stop(video).catch((error) => { record.videoError = String(error); });
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
const profileDirectory = mkdtempSync(join(tmpdir(), "relayer-paused-runs-video-profile-"));
app.setPath("userData", profileDirectory);
app.setName("Relayer paused runs video");
app.commandLine.appendSwitch("disable-gpu");
void app.whenReady().then(main).then(
  (code) => { rmSync(profileDirectory, { recursive: true, force: true }); app.exit(code); },
  (error) => { console.error(error); rmSync(profileDirectory, { recursive: true, force: true }); app.exit(1); },
);
