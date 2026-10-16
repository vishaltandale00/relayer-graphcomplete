import { app, BrowserWindow } from "electron";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stopRunFixture, waitFor } from "../test/support/stop-run-fixture.mjs";
import assert from "node:assert/strict";

const evidence = resolve(process.env.RELAYER_STOP_EVIDENCE_DIR || ".relayer/evidence/issue-506-stop");
const profile = process.env.RELAYER_STOP_ELECTRON_PROFILE || mkdtempSync(join(tmpdir(), "relayer-stop-electron-"));
const resultFile = process.env.RELAYER_STOP_RESULT_FILE;
app.setPath("userData", profile);
app.setName("Relayer Stop verification");
app.commandLine.appendSwitch("disable-gpu");
// The final window closes before asynchronous fixture reset. Only the explicit
// exit below may finish this proof, after its final receipt is written.
app.on("window-all-closed", () => {});
let window;
let fixture;
let exitCode = 1;
const results = [];
async function capture(name) {
  if (!name.startsWith("failure")) {
    const offset = await window.webContents.executeJavaScript(`(() => {
      const input=document.querySelector('#threadPrompt').getBoundingClientRect();
      const button=document.querySelector('#sendInteraction').getBoundingClientRect();
      return Math.abs(input.top+input.height/2-button.top-button.height/2);
    })()`);
    assert.ok(offset <= 1, `Composer button must be vertically centered; offset=${offset}`);
  }
  await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await writeFile(join(evidence, `${name}.png`), (await window.webContents.capturePage()).toPNG());
}
async function main() {
  await mkdir(evidence, { recursive: true });
  fixture = await stopRunFixture();
  // Production renderer and HTTP authority in an isolated Electron window.
  // OS/account integrations are outside this cancellation evidence runner.
  window = new BrowserWindow({ width: 1280, height: 880, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.webContents.session.cookies.set({ url: fixture.session.origin, name: fixture.session.cookie.name, value: fixture.session.cookie.value, httpOnly: true, sameSite: "strict" });
  await window.loadURL(fixture.session.origin);
  await waitFor("renderer boot", () => window.webContents.executeJavaScript("import('./src/state.js').then(m => Boolean(m.appState.modelSettings))"));
  window.setSize(1280, 880);
  window.show(); window.focus();
  for (const provider of ["codex", "prime"]) {
    const thread = await fixture.create(provider, `Inspect ${provider} tool work`);
    const turn = await waitFor("provider running", async () => {
      const t = (await fixture.request(`/api/threads/${thread.id}`)).interactions[0];
      if (["failed", "not_started"].includes(t.completionStatus)) throw new Error(JSON.stringify(t));
      return fixture.controls.has(t.graphNodeId) && t;
    });
    const control = fixture.controls.get(turn.graphNodeId);
    await control.started.promise;
    await window.webContents.executeJavaScript(`import('./src/threads.js').then(m => m.loadThread(${thread.id}))`);
    // #719: each run's Stop lives on its interaction node (the prompt card), and the composer's
    // Send stays Send while the run is active.
    await waitFor("visible Stop", () => window.webContents.executeJavaScript(`(() => { const b=document.querySelector('#interactionRunStop'); const s=document.querySelector('#sendInteraction'); return b?.getAttribute('aria-label')==='Stop this run' && b.textContent==='Stop' && !b.disabled && b.offsetParent!==null && s?.getAttribute('aria-label')==='Send' && !document.querySelector('#threadPrompt').disabled; })()`));
    await capture(`${provider}-01-running`);
    await window.webContents.executeJavaScript(`document.querySelector('#interactionRunStop').click();document.querySelector('#interactionRunStop').click()`);
    await control.aborted.promise;
    assert.equal(control.aborts, 1);
    await waitFor("visible Stopping", () => window.webContents.executeJavaScript(`(() => { const b=document.querySelector('#interactionRunStop'); return b?.getAttribute('aria-label')==='Stopping this run' && b.disabled && b.getAttribute('aria-busy')==='true'; })()`));
    assert.equal((await fixture.request(`/api/threads/${thread.id}`)).interactions[0].completionStatus, "running");
    await capture(`${provider}-02-stopping`);
    control.settled.resolve();
    await waitFor("visible Stopped", () => window.webContents.executeJavaScript(`document.querySelector('#interactionStatus')?.textContent==='Stopped' && !document.querySelector('#threadPrompt').disabled && document.querySelector('#sendInteraction')?.textContent==='↑' && document.querySelector('#interactionRunStop').classList.contains('hidden')`));
    assert.equal(await window.webContents.executeJavaScript(`(() => { const m=document.querySelector('#composerRetryMessage'); return m.classList.contains('is-stopped') && getComputedStyle(m).color===getComputedStyle(document.querySelector('#interactionStatus')).color; })()`), true);
    await capture(`${provider}-03-stopped`);
    const result = (await fixture.request(`/api/threads/${thread.id}`)).interactions[0];
    assert.equal(result.completionStatus, "stopped");
    assert.equal(result.completionOutput, null);
    results.push({ provider, duplicateClickAbortCount: control.aborts, lifecycle: result.completionStatus, attempt: result.latestAttempt.outcome });
  }
  await writeFile(join(evidence, "result.json"), JSON.stringify({ passed: true, inference: false, results }, null, 2));
  console.log(JSON.stringify({ passed: true, evidence, results }));
  exitCode = 0;
}
void app.whenReady().then(async () => {
  if (resultFile) await writeFile(resultFile, JSON.stringify({ passed: false, error: "Stop proof teardown has not completed." }));
  await main();
}).catch(async (error) => {
  console.error(error);
  if (window && !window.isDestroyed()) await capture("failure").catch(() => {});
}).finally(async () => {
  window?.destroy();
  await fixture?.close();
  if (!process.env.RELAYER_STOP_ELECTRON_PROFILE) await rm(profile, { recursive: true, force: true });
  if (resultFile) await writeFile(resultFile, JSON.stringify({ passed: exitCode === 0 }));
  app.exit(exitCode);
});
