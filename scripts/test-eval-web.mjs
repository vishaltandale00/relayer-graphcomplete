import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { taskSystemFixtureFactory } from "@relayer/eval-runner";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { EvalService } from "../desktop/eval-main/eval-service.mjs";
import { openBrowserReview } from "../desktop/eval-main/browser-review.mjs";

const directory = await mkdtemp(join(tmpdir(), "relayer-eval-web-proof-"));
const resources = [];
const selection = { testCaseIds: ["empty-project.task-system.two-turn"], harnessConfigurationNames: ["fixture-task-system"], judgeConfigurationName: "deterministic-graph-contract" };
async function until(fn, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise((resolvePromise) => setTimeout(resolvePromise, 100)); }
  throw new Error(`Timed out: ${label}`);
}
async function launchHost() {
  const child = spawn(process.execPath, ["desktop/eval-main/index.mjs"], {
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RELAYER_EVAL_AUTORUN"))), RELAYER_EVAL_USER_DATA_DIR: join(directory, "host"), RELAYER_EVAL_PRIME_PROFILE_FILE: "", RELAYER_EVAL_AUTORUN_INPUT_ROUNDTRIP: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (bytes) => { log += bytes; });
  child.stderr.on("data", (bytes) => { log += bytes; });
  const exited = once(child, "exit");
  const close = async () => {
    if (child.exitCode !== null) return;
    child.kill("SIGINT");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try { const [code, signal] = await exited; assert.equal(signal, null, "host required forced shutdown"); assert.equal(code, 0, log); }
    finally { clearTimeout(timeout); }
  };
  resources.push({ close });
  const url = await until(() => {
    if (child.exitCode !== null) throw new Error(log);
    return log.match(/Relayer Eval: (http:\/\/\S+)/)?.[1];
  }, "host ready");
  return { url, close };
}
async function rpc(url, operation, args = []) {
  const response = await fetch(new URL(`/eval-api/${operation}`, url), { method: "POST", headers: { Authorization: `Bearer ${new URL(url).hash.slice(1)}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
  const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
}
try {
  // A native child that never reports readiness exercises interruption during startup.
  const waitingBinary = join(directory, "waiting-server");
  const marker = join(directory, "waiting-server.pid");
  await writeFile(waitingBinary, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const interruptedProfile = join(directory, "interrupted");
  const pending = spawn(process.execPath, ["desktop/eval-main/index.mjs"], {
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RELAYER_EVAL_AUTORUN"))), RELAYER_EVAL_USER_DATA_DIR: interruptedProfile, RELAYER_EVAL_PRIME_PROFILE_FILE: "", RELAYER_GRAPH_SERVER_BIN: waitingBinary }, stdio: "ignore",
  });
  const pendingExit = once(pending, "exit");
  const timeout = setTimeout(() => pending.kill("SIGKILL"), 15_000);
  try {
    const pid = await until(async () => { try { return Number(await readFile(marker, "utf8")); } catch { return null; } }, "pending native startup", 10_000);
    pending.kill("SIGINT");
    const [code, signal] = await pendingExit;
    assert.equal(signal, null); assert.equal(code, 0);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await assert.rejects(access(join(interruptedProfile, "eval-web.lock")), { code: "ENOENT" });
  } finally { clearTimeout(timeout); if (pending.exitCode === null) pending.kill("SIGKILL"); }
  console.log("PASS interrupted startup: pending native child terminated and profile lock released");
  const browser = await chromium.launch(); resources.push(browser);
  const host = await launchHost();
  const duplicate = spawn(process.execPath, ["desktop/eval-main/index.mjs"], {
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RELAYER_EVAL_AUTORUN"))), RELAYER_EVAL_USER_DATA_DIR: join(directory, "host"), RELAYER_EVAL_PRIME_PROFILE_FILE: "" }, stdio: "ignore",
  });
  const [duplicateCode] = await once(duplicate, "exit");
  assert.equal(duplicateCode, 1, "a second host must not open the same profile");
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(host.url);
  await page.locator("#emptyNewRun").click();
  await page.locator('input[name="cases"]').first().waitFor();
  await page.locator('input[name="cases"]').evaluateAll((inputs) => inputs.forEach((input) => { input.checked = input.value === "empty-project.task-system.two-turn"; }));
  await page.locator('input[name="harness"]').evaluateAll((inputs) => inputs.forEach((input) => { input.checked = input.value === "fixture-task-system"; }));
  // Execute only the deterministic fixture through the real dashboard transport.
  const observer = await browser.newPage(); await observer.goto(host.url);
  const created = await page.evaluate((selection) => window.relayerEval.createRun(selection), selection);
  assert.equal(created.status, "running");
  await page.close(); // Closing a tab while execution is pending must not cancel it.
  const run = await until(async () => { const value = await rpc(host.url, "getRun", [created.id]); return ["passed", "failed", "error", "interrupted"].includes(value.status) ? value : null; }, "fixture run");
  assert.equal(run.status, "passed", JSON.stringify(run));
  const execution = run.executions[0];
  assert.equal(execution.turns.length, 2);
  await observer.getByText(run.id, { exact: true }).first().waitFor(); // Polling updates an already-open dashboard.
  assert.equal((await rpc(host.url, "getRun", [run.id])).status, "passed");
  const reviewUrl = await rpc(host.url, "openReview", [execution.id]);
  const secondReviewUrl = await rpc(host.url, "openReview", [execution.id]);
  assert.notEqual(new URL(secondReviewUrl).origin, new URL(reviewUrl).origin);
  const secondContext = await fetch(new URL("/eval-api/context", secondReviewUrl), { headers: { Authorization: `Bearer ${new URL(secondReviewUrl).hash.slice(1)}` } });
  assert.equal(secondContext.status, 200);
  const crossed = await fetch(new URL("/eval-api/context", reviewUrl), { headers: { Authorization: `Bearer ${new URL(secondReviewUrl).hash.slice(1)}` } });
  assert.equal(crossed.status, 401);
  const review = await browser.newPage(); review.on("pageerror", (error) => pageErrors.push(error.message));
  await review.goto(reviewUrl);
  await review.waitForFunction(() => Boolean(window.__evalPresentation?.snapshot()?.turnId));
  const state = await review.evaluate(() => window.__evalPresentation.snapshot());
  assert.equal(state.executionId, execution.id);
  const writeStatus = await review.evaluate(async (threadId) => (await fetch(`/api/threads/${threadId}/interactions`, { method: "POST", body: '{}' })).status, execution.threadIds[0]);
  assert.equal(writeStatus, 403);
  const annotations = await review.evaluate(async (threadId) => { const response = await fetch(`/api/threads/${threadId}/annotations`); return { status: response.status, value: await response.json() }; }, execution.threadIds[0]);
  assert.equal(annotations.status, 200, JSON.stringify(annotations));
  const annotationResult = await review.evaluate(async (threadId) => {
    const request = async (path, body) => {
      const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, value: await response.json() };
    };
    const base = `/api/threads/${threadId}/annotations`;
    const created = await request(base, { anchor: { kind: "thread" }, comment: "Browser proof", rating: 3 });
    if (created.status !== 201 && created.status !== 200) return { created };
    const annotation = created.value.annotation || created.value;
    const revised = await request(`${base}/${annotation.id}/revisions`, { expectedRevision: 1, comment: "Revised browser proof", rating: 4 });
    const retracted = await request(`${base}/${annotation.id}/retract`, { expectedRevision: 2 });
    return { created, revised, retracted };
  }, execution.threadIds[0]);
  for (const name of ["created", "revised", "retracted"]) assert.ok([200, 201].includes(annotationResult[name]?.status), JSON.stringify(annotationResult));
  const exported = await rpc(host.url, "exportAnnotations", [execution.id]);
  const bundle = await readFile(join(directory, "host", "eval-data", exported.bundleRef), "utf8");
  assert.ok(bundle.includes("Revised browser proof"));
  const fresh = await browser.newContext();
  const unauthorized = await fresh.newPage();
  await unauthorized.goto(new URL(reviewUrl).origin);
  assert.equal(await unauthorized.evaluate(async () => (await fetch('/eval-api/context')).status), 401);
  await fresh.close();
  const dashboard = await browser.newPage(); await dashboard.goto(host.url);
  const judgePopup = dashboard.context().waitForEvent("page");
  await dashboard.evaluate((id) => window.relayerEval.openJudgeReview(id), execution.id);
  const judgePage = await judgePopup;
  await judgePage.waitForLoadState();
  await until(async () => !(await judgePage.locator("#app").textContent()).includes("Loading"), "judge evidence");
  assert.ok(!(await judgePage.locator("#app").textContent()).includes("Could not open this analysis"));
  const tracePopup = dashboard.context().waitForEvent("page");
  await dashboard.evaluate(({ id, turn }) => window.relayerEval.openCandidateTrace(id, turn), { id: execution.id, turn: execution.turns[0].interactionId });
  const tracePage = await tracePopup; await tracePage.waitForLoadState();
  await until(async () => (await tracePage.locator("body").textContent()).includes("fixture-task-system"), "candidate trace");
  assert.deepEqual(pageErrors, []);
  await host.close();
  await assert.rejects(fetch(new URL("/eval-api/context", reviewUrl)));
  const restarted = await launchHost();
  assert.equal((await rpc(restarted.url, "getRun", [run.id])).status, "passed");
  await restarted.close();
  console.log("PASS host: real fixture, tab independence, review authority, judge/trace pages, shutdown and restart");

  // Exercise the actual judge adapter against the real product server, without inference.
  const root = resolve(".");
  const binaries = resolve(process.env.CARGO_TARGET_DIR || "target", "debug");
  const configurationPaths = [join(root, "harnesses/fixture-task-system.yaml")];
  const data = join(directory, "judge");
  const runtime = new GraphCompleteRuntimeService({ userDataDirectory: data, graphServerBinary: join(binaries, "relayer-graph-server"), configurationPaths, additionalImplementations: { "fixture.task-system": taskSystemFixtureFactory } });
  resources.push(runtime);
  const product = new RelayerAppServerService({ userDataDirectory: data, binaryPath: join(binaries, "relayer-app-server"), webDirectory: join(root, "desktop/renderer"), permissionCatalogPath: join(root, "permissions/desktop.json"), runtimeSession: await runtime.start(), defaultHarnessConfiguration: "fixture-task-system", allowHarnessOverride: true, enableReadOnlySession: true });
  resources.push(product);
  const productSession = await product.start();
  const service = await new EvalService({ stateFile: join(data, "eval-data/test-runs.json"), productSession, configurationPaths }).open();
  const fixture = await service.createRun(selection);
  const completed = await until(() => { const value = service.getRun(fixture.id); return ["passed", "failed", "error", "interrupted"].includes(value.status) ? value : null; }, "judge fixture");
  assert.equal(completed.status, "passed");
  const candidate = completed.executions[0];
  const turn = candidate.turns[0];
  const opened = await openBrowserReview({ browser, productSession, context: service.reviewContext(candidate.id), executionId: candidate.id, threadId: candidate.threadIds[0], turnId: turn.interactionId, rootLayerId: turn.rootLayerId, artifactDirectory: join(directory, "screenshots") });
  const judgeContext = browser.contexts().find((context) => context.pages().some((page) => page.url().startsWith(productSession.origin)));
  assert.ok(judgeContext);
  assert.deepEqual((await judgeContext.cookies()).map(({ name }) => name), [productSession.readOnlyCookie.name]);
  const denied = await judgeContext.pages()[0].evaluate(async (id) => (await fetch(`/api/threads/${id}/annotations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ anchor: { kind: "thread" }, comment: "forbidden" }) })).status, candidate.threadIds[0]);
  assert.equal(denied, 401);
  const shot = await opened.session.screenshot({ target: { kind: "viewport" }, label: "Fixture review" });
  assert.equal(shot.ok, true); assert.ok(shot.screenshot.tiles[0].width > 0);
  if (process.env.RELAYER_EVAL_WEB_SCREENSHOT) {
    await writeFile(process.env.RELAYER_EVAL_WEB_SCREENSHOT, await readFile(join(opened.session.artifactDirectoryFor(shot.screenshot.screenshotId), `${shot.screenshot.screenshotId}-001.png`)));
  }
  const initial = await opened.session.state();
  const nodeControl = initial.controls.find((control) => control.kind === "node" && !control.disabled);
  assert.ok(nodeControl);
  await opened.session.interact({ elementRef: nodeControl.elementRef, activate: true });
  assert.ok((await opened.session.state()).selectedNodeId);
  const nextTurn = (await opened.session.state()).controls.find((control) => control.kind === "turn" && !control.disabled);
  assert.ok(nextTurn);
  await opened.session.interact({ elementRef: nextTurn.elementRef, activate: true });
  assert.notEqual((await opened.session.state()).turnId, initial.turnId);
  await opened.session.history({ delta: -1 });
  assert.equal((await opened.session.state()).turnId, initial.turnId);
  await opened.session.history({ delta: 1 });
  assert.notEqual((await opened.session.state()).turnId, initial.turnId);
  await opened.session.history({ delta: -1 });
  const region = (await opened.session.state()).controls.find((control) => control.kind === "capture-region");
  assert.ok(region);
  const full = await opened.session.screenshot({ target: { kind: "element", elementRef: region.elementRef }, mode: "full", label: "Full review region" });
  assert.equal(full.ok, true);
  assert.equal((await opened.session.state()).layerId, String(turn.rootLayerId));
  const metadata = JSON.parse(await readFile(join(opened.session.artifactDirectoryFor(shot.screenshot.screenshotId), "metadata.json"), "utf8"));
  assert.equal(metadata.contentDigest, shot.screenshot.contentDigest);
  await opened.release({ close: true });
  console.log("PASS judge: isolated context, exact execution/turn readiness, viewport/full capture and restoration");
} finally {
  const errors = [];
  for (const resource of resources.reverse()) { try { await resource.close(); } catch (error) { errors.push(error); } }
  await rm(directory, { recursive: true, force: true });
  if (errors.length) throw new AggregateError(errors, "Eval browser proof cleanup failed");
}
