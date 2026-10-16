/**
 * Opt-in live video of parallel sends (issue #719). Spends real inference; never part of
 * `npm run check`.
 *
 * Everything a person sends from the thread runs at once: a plain message, a message carrying a
 * node annotation, and a message carrying an answered node question, beside an invoked run. It
 * drives the production renderer in an Electron window as a person would, and checks that each
 * send carries exactly its own annotation or answer. Frames come from the app window only.
 * Stretches where the model is working play at 5× speed, and the caption says so.
 *
 *   RELAYER_PARALLEL_INVOKE_LIVE_RUN=1 RELAYER_LIVE_PROFILE=prime-openrouter \
 *     ./node_modules/.bin/electron scripts/record-parallel-sends-video.mjs
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
const output = resolve(process.env.RELAYER_PARALLEL_VIDEO_DIR ?? join(repositoryRoot, ".relayer", "evidence", "parallel-sends-video"));
const ffmpeg = process.env.RELAYER_EVIDENCE_FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
const ACTIVE = new Set(["not_started", "queued", "submitted", "running", "waiting_for_approval"]);
const TERMINAL = new Set(["accepted", "failed", "stopped"]);
// Overlap counts only runs that started: a queued or still-starting run is not running beside
// the others, so it cannot satisfy the side-by-side check.
const RUNNING = new Set(["running", "waiting_for_approval"]);
const INVOKE_LABEL = "Plan a first week";
const QUESTION_LABEL = "Daily minutes";
const ROOT_TASK = [
  "Compare three ways to learn a new programming language: building a small project, working",
  "through exercises, and reading other people's code. Present one node per approach. Give the",
  `"working through exercises" node an invoke action labelled "${INVOKE_LABEL}" whose interaction`,
  "text asks for a seven-day plan. Give the \"building a small project\" node a text input action",
  `labelled "${QUESTION_LABEL}" that asks how many minutes a day I can practise. Leave the invoke`,
  "for me to click and the question for me to answer; do not run or answer them yourself.",
].join(" ");
const PLAIN = "In one sentence, which approach is quickest to start?";
const ANNOTATION = "I already know Python, so lean on that.";
const WITH_ANNOTATION = "Given my note on this node, what should my first project be?";
const ANSWER = "20";
const WITH_ANSWER = "Using my answer on daily minutes, adjust the plan for that node.";
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
    issues: [719],
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
      body: JSON.stringify({ title: "Parallel sends", initialMessage: ROOT_TASK, harnessId: profile.harness, permissionProfileId: "auto", modelSelection }),
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
    const actions = root.completionOutput?.rootLayer?.actions ?? [];
    const invoke = actions.find((action) => action.kind === "invoke" && action.targetLayerId == null && action.label.includes(INVOKE_LABEL));
    const question = actions.find((action) => action.kind === "input" && (action.label ?? "").includes(QUESTION_LABEL));
    const nodes = (root.completionOutput?.rootLayer?.nodes ?? []).map((node) => String(node.id));
    if (!invoke || !question) throw new Error(`The first answer is missing the invoke (${Boolean(invoke)}) or the question (${Boolean(question)}).`);
    const annotated = nodes.find((id) => id !== String(invoke.sourceNodeId) && id !== String(question.sourceNodeId)) ?? String(invoke.sourceNodeId);
    record.actions = { invoke: { id: invoke.id, sourceNodeId: invoke.sourceNodeId }, question: { id: question.id, sourceNodeId: question.sourceNodeId }, annotatedNode: annotated };
    recorder.live();
    await page(`import('./src/threads.js').then(m => m.loadThread(${thread.id}))`);
    await until("the answer graph", () => page("document.querySelectorAll('[data-node]').length >= 3"), 60_000);
    recorder.caption("The answer: an invoke on one node, a question on another");
    await recorder.hold(3500);

    // After each Send the view follows the new run, so go back to the first answer's layer
    // before acting on its nodes.
    const selectNode = async (id) => {
      const visible = await page(`Boolean(document.querySelector('[data-node="${id}"]'))`);
      if (!visible) {
        await page(`import('./src/threads.js').then(m => m.selectTurnById(${thread.rootInteractionId}))`);
        await until(`node ${id} on the first answer`, () => page(`Boolean(document.querySelector('[data-node="${id}"]'))`), 30_000);
        await recorder.hold(800);
      }
      await page(`document.querySelector('[data-node="${id}"]').click()`);
      await recorder.hold(1200);
    };
    const typeAndSend = async (text) => {
      await page(`(() => { const prompt = document.querySelector('#threadPrompt'); prompt.focus(); prompt.value = ${JSON.stringify(text)}; prompt.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await recorder.hold(1500);
      await until("an enabled Send", () => page("(() => { const send = document.querySelector('#sendInteraction'); return send && !send.disabled; })()"), 30_000);
      await page("document.querySelector('#sendInteraction').click()");
      await recorder.hold(2000);
    };

    recorder.caption(`2. Click "${INVOKE_LABEL}": an invoked run starts`);
    await selectNode(invoke.sourceNodeId);
    await until("the invoke button", () => page(`(() => {
      const roots = [document.querySelector('#inspectorContent')];
      const seen = [];
      while (roots.length) {
        const root = roots.shift();
        if (!root) continue;
        for (const element of root.querySelectorAll('*')) {
          if (element.shadowRoot) roots.push(element.shadowRoot);
          if (element.matches('button, [role="button"], a') && !element.disabled && element.textContent.includes(${JSON.stringify(INVOKE_LABEL)})) seen.push(element);
        }
      }
      const target = seen.at(-1);
      if (!target) return false;
      target.click();
      return true;
    })()`), 30_000);
    await recorder.hold(2000);

    recorder.caption("3. Send a plain message");
    await typeAndSend(PLAIN);

    recorder.caption("4. While it runs, annotate a node and send a second message");
    await selectNode(annotated);
    await until("the annotate button", () => page("!document.querySelector('#attachNodeContext')?.classList.contains('hidden') && !document.querySelector('#attachNodeContext')?.disabled"), 30_000);
    await page("document.querySelector('#attachNodeContext').click()");
    await until("the annotation editor", () => page("Boolean(document.querySelector('#contextAnnotationEditor'))"), 30_000);
    await page(`(() => { const editor = document.querySelector('#contextAnnotationEditor'); editor.focus(); editor.value = ${JSON.stringify(ANNOTATION)}; editor.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await recorder.hold(1500);
    await page(`document.querySelector('[aria-label="Confirm annotation"]').click()`);
    await until("the annotation pill", () => page("document.querySelector('.composer-context-pill span')?.textContent === '1 annotation'"), 30_000);
    await recorder.hold(1500);
    await typeAndSend(WITH_ANNOTATION);

    recorder.caption("5. While both run, answer a node's question and send a third message");
    await selectNode(question.sourceNodeId);
    await until("the question field", () => page(`(() => {
      // The question's field is drawn in the node's details, possibly inside its authored view.
      const roots = [document.querySelector('#nodeInputActions'), document.querySelector('#inspectorContent')];
      while (roots.length) {
        const root = roots.shift();
        if (!root) continue;
        for (const element of root.querySelectorAll('*')) {
          if (element.shadowRoot) roots.push(element.shadowRoot);
          if (element.matches('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea')
            && !element.disabled && !element.readOnly && element.id !== 'contextAnnotationEditor' && element.id !== 'threadPrompt') {
            element.focus();
            element.value = ${JSON.stringify(ANSWER)};
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
            element.blur();
            return true;
          }
        }
      }
      return false;
    })()`), 30_000);
    // The answer is committed by the Send that carries it; its pill is shown when present.
    await until("the answer pill", () => page("document.querySelectorAll('.composer-input-pill').length >= 1"), 5_000).catch(() => null);
    await recorder.hold(1500);
    await typeAndSend(WITH_ANSWER);

    const runs = await until("all four runs admitted", async () => {
      const state = await productRequest(session, `/api/state?threadId=${thread.id}`);
      const invoked = (state.actionInvocations ?? []).find((item) => String(item.actionId) === String(invoke.id) && item.agentInvoked !== true)?.resultInteractionId;
      const anyInvocation = new Set((state.actionInvocations ?? []).map(({ resultInteractionId }) => String(resultInteractionId)));
      const sent = (state.interactions ?? []).filter((turn) => turn.threadId === thread.id && turn.id !== thread.rootInteractionId && !anyInvocation.has(String(turn.id)));
      const byText = (text) => sent.find((turn) => turn.text === text);
      const ids = { invoke: invoked, plain: byText(PLAIN)?.id, annotated: byText(WITH_ANNOTATION)?.id, answered: byText(WITH_ANSWER)?.id };
      return Object.values(ids).every((id) => id != null) && ids;
    }, 30_000);

    recorder.caption("Three sends and an invoke, all running at once");
    await recorder.hold(3500);
    recorder.lapse();
    await until("all four runs to settle", async () => {
      const turns = await interactions();
      const statuses = Object.fromEntries(Object.entries(runs).map(([name, id]) => [name, turns.find((turn) => turn.id === id)?.completionStatus]));
      samples.push({ atMs: Date.now(), statuses });
      const active = Object.values(statuses).filter((status) => ACTIVE.has(status)).length;
      recorder.caption(`${active} of 4 running`);
      return active === 0;
    });
    recorder.live();
    const settled = await interactions();
    const turn = (name) => settled.find((item) => item.id === runs[name]);
    record.runs = Object.keys(runs).map((name) => ({ name, interactionId: runs[name], completionStatus: turn(name)?.completionStatus }));
    const annotationsOf = (name) => (turn(name)?.contexts ?? []).flatMap((context) => context.annotations ?? []);
    const answersOf = (name) => (turn(name)?.submittedInputs ?? []).map((input) => JSON.stringify(input));
    record.snapshots = Object.fromEntries(Object.keys(runs).map((name) => [name, { annotations: annotationsOf(name), answers: answersOf(name) }]));
    record.checks = {
      allAdmitted: Object.keys(runs).length === 4,
      threeSendsRanTogether: samples.some(({ statuses }) => ["plain", "annotated", "answered"].every((name) => RUNNING.has(statuses[name]))),
      sendsRanBesideTheInvoke: samples.some(({ statuses }) => RUNNING.has(statuses.invoke) && ["plain", "annotated", "answered"].some((name) => RUNNING.has(statuses[name]))),
      plainSendCarriedNothing: annotationsOf("plain").length === 0 && answersOf("plain").length === 0,
      annotatedSendCarriedOnlyItsAnnotation: annotationsOf("annotated").length === 1 && annotationsOf("annotated")[0] === ANNOTATION && answersOf("annotated").length === 0,
      answeredSendCarriedOnlyItsAnswer: answersOf("answered").length === 1 && answersOf("answered")[0].includes(JSON.stringify(ANSWER).slice(1, -1)) && annotationsOf("answered").length === 0,
      allAccepted: record.runs.every(({ completionStatus }) => completionStatus === "accepted"),
    };
    record.passed = Object.values(record.checks).every(Boolean);

    // The ending only shows the results; a hiccup here never changes the checks above.
    try {
      recorder.caption("All four runs accepted");
      await recorder.hold(4000);
    } catch (error) {
      record.endingError = error instanceof Error ? error.message : String(error);
    }
  } catch (error) {
    record.passed = false;
    record.failure = error instanceof Error ? error.message : String(error);
    if (window && !window.isDestroyed()) await writeFile(join(output, "failure.png"), (await window.webContents.capturePage()).toPNG()).catch(() => {});
  } finally {
    if (recorder) {
      const video = join(output, "parallel-sends.mp4");
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
const profileDirectory = mkdtempSync(join(tmpdir(), "relayer-parallel-sends-video-profile-"));
app.setPath("userData", profileDirectory);
app.setName("Relayer parallel sends video");
app.commandLine.appendSwitch("disable-gpu");
void app.whenReady().then(main).then(
  (code) => { rmSync(profileDirectory, { recursive: true, force: true }); app.exit(code); },
  (error) => { console.error(error); rmSync(profileDirectory, { recursive: true, force: true }); app.exit(1); },
);
