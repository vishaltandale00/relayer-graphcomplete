import { CalibrationService } from "../desktop/eval-main/calibration-service.mjs";
import { SetupRegistry, setupDigest } from "../desktop/eval-main/setup-registry.mjs";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { loadAtomicAnnotationSnapshots } from "../desktop/eval-main/annotation-snapshot-loader.mjs";
import { spawn, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { mkdtemp, rm, readFile, writeFile, access, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { taskSystemFixtureFactory, nodeDetailFixtureFactory, h3AutonomousFixCase, createAutonomousCaseSnapshot, bindAutonomousCaseSnapshot, validateEvalCatalogV1 } from "@relayer/eval-runner";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { HumanTaskService } from "../desktop/eval-main/human-task-service.mjs";
import { TaskActorService } from "../desktop/eval-main/task-actor-service.mjs";
import { openTaskActorBrowser } from "../desktop/eval-main/task-actor-browser.mjs";
import { EvalService } from "../desktop/eval-main/eval-service.mjs";
import { createEvalDashboard, createSettingsSurface, createHumanTaskSurface, openHumanReview } from "../desktop/eval-main/web-host.mjs";
import { createEvalProviderSetup } from "../desktop/eval-main/provider-setup.mjs";
import { createProviderAdapterRegistry } from "../desktop/main/providers/provider-adapter-contract.mjs";
import { unavailableModelCatalogSnapshot } from "../desktop/main/models/model-catalog-adapter.mjs";
import { openBrowserReview } from "../desktop/eval-main/browser-review.mjs";

const directory = await mkdtemp(join(tmpdir(), "relayer-eval-web-proof-"));
const resources = [];
const shutdownShim = join(directory, "shutdown-shim.mjs");
await writeFile(shutdownShim, 'process.on("message", (message) => { if (message === "shutdown") process.emit("SIGINT"); });\n');
const { scripts } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(scripts["eval-app:dev"], "node desktop/eval-main/index.mjs", "Eval launch must not build or package");
assert.equal(scripts["eval:input-roundtrip:live"], "RELAYER_EVAL_AUTORUN_INPUT_ROUNDTRIP=1 node desktop/eval-main/index.mjs");
const hostArguments = ["--import", pathToFileURL(shutdownShim).href, scripts["eval-app:dev"].slice("node ".length)];
function requestShutdown(child) {
  // Windows kill(SIGINT) terminates rather than dispatching the Node handler.
  if (process.platform === "win32") child.send("shutdown");
  else child.kill("SIGINT");
}
const selection = { testCaseIds: ["empty-project.task-system.two-turn"], harnessConfigurationNames: ["fixture-task-system"], judgeConfigurationName: "deterministic-graph-contract" };
async function until(fn, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise((resolvePromise) => setTimeout(resolvePromise, 100)); }
  throw new Error(`Timed out: ${label}`);
}
async function launchHost() {
  const child = spawn(process.execPath, hostArguments, {
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RELAYER_EVAL_AUTORUN"))), RELAYER_EVAL_USER_DATA_DIR: join(directory, "host"), RELAYER_EVAL_PRIME_PROFILE_FILE: "", RELAYER_EVAL_AUTORUN_INPUT_ROUNDTRIP: "" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let log = "";
  child.stdout.on("data", (bytes) => { log += bytes; });
  child.stderr.on("data", (bytes) => { log += bytes; });
  const exited = once(child, "exit");
  const close = async () => {
    if (child.exitCode !== null) return;
    requestShutdown(child);
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
  const waitingBinary = join(directory, process.platform === "win32" ? "waiting-server.exe" : "waiting-server");
  const marker = join(directory, "waiting-server.pid");
  const waitingSource = join(directory, "waiting_server.rs");
  await writeFile(waitingSource, `fn main() {
    std::fs::write(std::env::var_os("RELAYER_EVAL_TEST_PID_FILE").unwrap(), std::process::id().to_string()).unwrap();
    loop { std::thread::sleep(std::time::Duration::from_secs(1)); }
  }`);
  execFileSync("rustc", [waitingSource, "-o", waitingBinary], { stdio: "pipe" });
  const interruptedProfile = join(directory, "interrupted");
  const pending = spawn(process.execPath, hostArguments, {
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RELAYER_EVAL_AUTORUN"))), RELAYER_EVAL_USER_DATA_DIR: interruptedProfile, RELAYER_EVAL_PRIME_PROFILE_FILE: "", RELAYER_GRAPH_SERVER_BIN: waitingBinary, RELAYER_EVAL_TEST_PID_FILE: marker }, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const pendingExit = once(pending, "exit");
  const timeout = setTimeout(() => pending.kill("SIGKILL"), 15_000);
  try {
    const pid = await until(async () => { try { return Number(await readFile(marker, "utf8")); } catch { return null; } }, "pending native startup", 10_000);
    requestShutdown(pending);
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
  await page.locator('input[name="cases"]').first().waitFor().catch(async (error) => {
    console.error("Case picker diagnostic", JSON.stringify({ pageErrors, body: await page.locator("body").innerText() }));
    throw error;
  });
  const catalog = await rpc(host.url, "catalog", []);
  if (process.env.RELAYER_EVAL_REQUIRE_EXTERNAL_CATALOG === "1") {
    assert.ok(catalog.suites.length > 0, "configured external catalog exposes a suite");
    for (const suite of catalog.suites) {
      assert.equal(suite.available, true, `external suite unavailable: ${suite.unavailableReason}`);
      console.log(`EXTERNAL_SUITE ${JSON.stringify({ suiteId: suite.suiteId, suiteDigest: suite.suiteDigest, memberIds: suite.members.map(({ caseId }) => caseId) })}`);
      const selectedInput = page.locator(`input[name="suites"][value="${suite.suiteId}"]`);
      await selectedInput.waitFor();
      assert.equal(await selectedInput.isDisabled(), false);
      await selectedInput.check();
      const selectedCases = await page.locator('input[name="cases"]:checked').evaluateAll((inputs) => inputs.map(({ value }) => value));
      assert.deepEqual(selectedCases.sort(), suite.members.map(({ caseId }) => caseId).sort());
      await page.locator('input[name="cases"]').first().click();
      assert.equal(await selectedInput.isChecked(), false);
    }
  }
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
  await observer.locator(`[data-execution-detail="${execution.id}"]`).click();
  const reliability = observer.locator(".dossier-block").filter({ has: observer.getByRole("heading", { name: "Authoring errors per turn" }) });
  await reliability.waitFor();
  await reliability.locator(".finding-row").nth(1).waitFor(); // Wait for the observer's terminal-run polling snapshot.
  assert.equal(await reliability.locator(".finding-row").count(), 2);
  assert.ok((await reliability.textContent()).includes("Total: unknown"));
  assert.ok((await reliability.textContent()).includes("0 observed"));
  await observer.getByRole("heading", { name: "Send to backend publication, per turn" }).waitFor();
  // Historical child evidence exercises the production dossier without new inference.
  const childMetrics = await browser.newPage();
  await childMetrics.route("**/eval-api/listRuns", async (route) => {
    const response = await route.fetch();
    const runs = await response.json();
    const fixtureExecution = runs.find((entry) => entry.id === run.id).executions.find((entry) => entry.id === execution.id);
    fixtureExecution.authoringErrorMetrics = { 9003: { schemaVersion: 1, observed: 1, total: null, coverage: "partial", byCause: { server_rejection: 1 }, reasons: [] } };
    fixtureExecution.semanticChildren = [
      { interactionId: 9001, sourceInteractionId: execution.turns[0].interactionId, sourceActionId: 77,
        authoringErrors: { schemaVersion: 1, observed: 2, total: null, coverage: "partial", byCause: { compiler: 2 }, reasons: [] } },
      { interactionId: 9002, sourceInteractionId: execution.turns[1].interactionId, sourceActionId: 78 },
    ];
    await route.fulfill({ response, json: runs });
  });
  await childMetrics.goto(host.url);
  await childMetrics.locator(`[data-execution-detail="${execution.id}"]`).click();
  const childReliability = childMetrics.locator(".dossier-block").filter({ has: childMetrics.getByRole("heading", { name: "Authoring errors per turn" }) });
  await childReliability.getByText("Child completion 9001: 2 observed", { exact: true }).waitFor();
  await childReliability.getByText("Child completion 9002: Not recorded", { exact: true }).waitFor();
  await childReliability.getByText("Captured completion 9003: 1 observed", { exact: true }).waitFor();
  assert.equal(await childReliability.locator(".finding-row").count(), 5);
  assert.ok((await childReliability.textContent()).includes(`From turn ${execution.turns[0].interactionId} · action 77`));
  assert.equal(await childReliability.getByText("0 observed", { exact: false }).count(), 2);
  await childMetrics.close();
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
  assert.deepEqual(await review.evaluate(async () => Promise.all([
    fetch("/api/model-settings/defaults", { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" }).then((response) => response.status),
    fetch("/eval-api/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: "[]" }).then((response) => response.status),
  ])), [403, 404], "review authority cannot change provider/model setup");
  // The real index owns startup, RPC composition, shutdown and restart. This
  // receiptless fixture proves one opening response only; continuation is covered
  // below with an admitted provider route, without bypassing AGT-011.
  const hostTaskSelection = { testCaseId: "empty-project.task-system.two-turn", harnessConfigurationName: "fixture-human-task", maxCompletions: 1, endpoint: "Inspect the initial task-system graph" };
  const tasksBeforeRejectedActor = await rpc(host.url, "humanTasks");
  const rejectedActor = await dashboard.evaluate(async (selection) => {
    try { await window.relayerEval.createHumanTask({ ...selection, mode: "simulated" }); return null; }
    catch (error) { return error.message; }
  }, hostTaskSelection);
  assert.match(rejectedActor, /Actor authentication is unavailable/i);
  assert.deepEqual(await rpc(host.url, "humanTasks"), tasksBeforeRejectedActor, "missing actor authentication must fail before creating or spending a candidate session");
  const hostTask = await rpc(host.url, "createHumanTask", [hostTaskSelection]);
  const hostTaskUrl = await rpc(host.url, "openHumanTask", [hostTask.id]);
  const hostTaskPage = await browser.newPage();
  await hostTaskPage.goto(hostTaskUrl);
  await until(async () => (await rpc(host.url, "humanTask", [hostTask.id])).events.some(({ kind, snapshot }) => kind === "presentation" && snapshot.graphVisible && snapshot.completionStatus === "accepted"), "real index human opening graph");
  const hostTaskFinished = await rpc(host.url, "finishHumanTask", [hostTask.id, { reason: "budget_exhausted", satisfaction: 3, comment: "Persist this host-owned human review." }]);
  assert.equal(hostTaskFinished.status, "completed");
  assert.equal(hostTaskFinished.completions, 1);
  const hostTaskExport = await rpc(host.url, "exportHumanTask", [hostTask.id]);
  assert.equal(hostTaskExport.bundle.session.satisfaction.comment, "Persist this host-owned human review.");
  await hostTaskPage.close();
  assert.deepEqual(pageErrors, []);
  await host.close();
  await assert.rejects(fetch(new URL("/eval-api/context", reviewUrl)));
  const restarted = await launchHost();
  assert.equal((await rpc(restarted.url, "getRun", [run.id])).status, "passed");
  const reopenedHostTask = await rpc(restarted.url, "humanTask", [hostTask.id]);
  assert.equal(reopenedHostTask.status, "completed");
  assert.equal(reopenedHostTask.completions, 1);
  assert.equal(reopenedHostTask.satisfaction.comment, "Persist this host-owned human review.");
  const reopenedHostExport = await rpc(restarted.url, "exportHumanTask", [hostTask.id]);
  assert.deepEqual(reopenedHostExport.bundle.session.conversations, hostTaskExport.bundle.session.conversations);
  const reopenedHostReview = await browser.newPage();
  await reopenedHostReview.goto(await rpc(restarted.url, "reviewHumanTask", [hostTask.id]));
  await reopenedHostReview.locator(".graph-node").first().waitFor({ state: "visible" });
  assert.equal(await reopenedHostReview.evaluate(async (threadId) => (await fetch(`/api/threads/${threadId}/interactions`, { method: "POST", body: "{}" })).status, hostTask.threadIds[0]), 403);
  await reopenedHostReview.close();
  console.log("PASS real index human lifecycle: initial graph, finish/export RPCs, process restart, persisted task/read-only review; disconnected actor rejected before candidate creation");
  await restarted.close();
  console.log("PASS host: real fixture, tab independence, review authority, judge/trace pages, shutdown and restart");

  // Exercise the actual judge adapter against the real product server, without inference.
  const root = resolve(".");
  const binaries = resolve(process.env.CARGO_TARGET_DIR || "target", "debug");
  const configurationPaths = [join(root, "harnesses/fixture-task-system.yaml"), join(root, "harnesses/fixture-node-detail.yaml"), join(root, "harnesses/codex-basic.yaml")];
  const data = join(directory, "judge");
  const runtime = new GraphCompleteRuntimeService({ userDataDirectory: data, graphServerBinary: join(binaries, "relayer-graph-server"), configurationPaths, additionalImplementations: { "fixture.task-system": taskSystemFixtureFactory, "fixture.node-detail": nodeDetailFixtureFactory },
    acquireProviderExecution: async (providerId) => ({
      definition: { id: providerId, adapterId: "codex-subscription", accessContract: "managed-runtime@1" },
      descriptor: { adapterId: "codex-subscription", accessContract: "managed-runtime@1", implementationVersion: "1" },
      runtime: { executionAccess: async () => ({ kind: "managed-runtime", environment: {} }) },
      async release() {},
    }),
  });
  resources.push(runtime);
  const productOptions = { userDataDirectory: data, binaryPath: join(binaries, "relayer-app-server"), webDirectory: join(root, "desktop/renderer"), permissionCatalogPath: join(root, "permissions/desktop.json"), runtimeSession: await runtime.start(), defaultHarnessConfiguration: "fixture-task-system", allowHarnessOverride: true, evalMode: true, enableReadOnlySession: true };
  const product = new RelayerAppServerService(productOptions);
  resources.push(product);
  const productSession = await product.start();
  await proveProductionSettings({ browser, product, productSession, runtime, data });
  const privateInteraction = { schemaVersion: 1, participantBrief: "PRIVATE_BROWSER_PERSONA", reviewerRubric: { version: "v1", criteria: ["PRIVATE_BROWSER_RUBRIC"] }, endpoint: "An explained task system and a refined response", maxCompletions: 2, research: "case-defined" };
  const externalDefinition = { ...h3AutonomousFixCase.definition, id: "fixture.external-human", name: "External human fixture", description: "Production external Human Grader fixture" };
  const externalBound = bindAutonomousCaseSnapshot(externalDefinition, createAutonomousCaseSnapshot({ ...h3AutonomousFixCase.snapshot,
    id: externalDefinition.id, name: externalDefinition.name, description: externalDefinition.description, interactive: privateInteraction }));
  const externalCatalog = { ...validateEvalCatalogV1({ schemaVersion: 1, suites: [], cases: [{
    boundCase: externalBound, definition: { ...externalDefinition, caseSnapshot: externalBound.catalogSnapshot, caseSnapshotDigest: externalBound.snapshotDigest }, available: true, unavailableReason: null,
    materialize: async ({ workspaceDirectory }) => { await mkdir(workspaceDirectory, { recursive: true }); return { workspaceDirectory, repositoryUrl: externalBound.snapshot.artifacts.workspace.source, sourceRevision: externalBound.snapshot.artifacts.workspace.revision }; },
    grade: async () => [{ name: "external-fixture", passed: true, detail: "External callback reached" }],
    evaluateMandatoryGate: (_gate, checks) => ({ complete: true, passed: checks.every(c => c.passed), matched: checks }),
  }] }), identity: { commit: "browser-fixture" }, assertUnchanged: async () => {} };
  const service = await new EvalService({ stateFile: join(data, "eval-data/test-runs.json"), productSession, configurationPaths, externalCatalog }).open();
  assert.ok(!JSON.stringify(service.catalog()).includes("PRIVATE_BROWSER"));
  // Deterministic execution still uses real provider admission and successful receipts.
  // Configuration-only fixture history is correctly blocked by AGT-011 as unverified.
  await product.seedProviderCatalog({ providerId: "codex", label: "Fixture Codex", connected: true,
    models: [{ id: "fixture-model", label: "Fixture model", order: 0, visible: true, available: true, providerDefault: true, metadata: {} }],
    systemFamily: { key: "codex", name: "Fixture Codex", modelIds: ["fixture-model"] },
  });
  // Settings proved a different family. Explicitly select this execution fixture;
  // family-only resolution must never fall back from that saved default.
  const controlHeaders = { Cookie: `${productSession.cookie.name}=${productSession.cookie.value}` };
  const fixtureSettings = await (await fetch(new URL("/api/model-settings", productSession.origin), { headers: controlHeaders })).json();
  const fixtureFamily = fixtureSettings.families.find((family) => family.members.some((member) => member.providerId === "codex" && member.roles.some((role) => role.name === "orchestrator")));
  assert.ok(fixtureFamily);
  const fixtureDefaults = await fetch(new URL("/api/model-settings/defaults", productSession.origin), { method: "PUT", headers: { ...controlHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ familyId: fixtureFamily.id, harnessId: "fixture-task-system", providerId: "codex" }) });
  assert.equal(fixtureDefaults.status, 200);
  const humanProof = await proveHumanTask({ browser, service, productSession, data });
  await proveTaskActor({ browser, service, productSession, data });
  await proveTaskActorInputs({ browser, service, productSession, data });
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
  // Opening a layer may already select its default node (PRD NDT-003).
  const nodeControl = initial.controls.find((control) => control.kind === "node" && !control.disabled
    && control.elementRef !== `node-${initial.selectedNodeId}`);
  assert.ok(nodeControl, "The review fixture must expose a different selectable node");
  await opened.session.interact({ elementRef: nodeControl.elementRef, activate: true });
  const selected = await opened.session.state();
  assert.ok(selected.selectedNodeId);
  assert.notEqual(selected.selectedNodeId, initial.selectedNodeId);
  assert.equal(`node-${selected.selectedNodeId}`, nodeControl.elementRef);
  // Native threads use the production interaction graph (PRD 7.2B).
  // Exercise its visible controls through the judge adapter, preserving the
  // same turn-selection and history boundary formerly covered by the arrows.
  const navigator = (await opened.session.state()).controls.find((control) => control.name.startsWith("Open interaction graph.") && !control.disabled);
  assert.ok(navigator);
  await opened.session.interact({ elementRef: navigator.elementRef, activate: true });
  const nextTurn = (await opened.session.state()).controls.find((control) => control.name.startsWith("Follow up in the same thread:") && !control.disabled);
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
  await product.close();
  const reopenedProduct = new RelayerAppServerService(productOptions);
  resources.push(reopenedProduct);
  const reopenedSession = await reopenedProduct.start();
  const reopenedTasks = await new HumanTaskService({ stateFile: join(data, "human-tasks.json"), evalService: service, productSession: reopenedSession }).open();
  const reopenedHuman = reopenedTasks.get(humanProof.id);
  assert.equal(reopenedHuman.status, "completed");
  assert.equal(reopenedHuman.annotations.at(-1).comment, "First useful map.");
  const reopenedState = await productJson(reopenedSession, `/api/state?threadId=${humanProof.threadId}`);
  assert.equal(reopenedState.conversationCompatibility.status, "compatible");
  assert.equal(reopenedState.interactions.filter(({ completionStatus }) => completionStatus === "accepted").length, 2);
  console.log("PASS human persistence: native product restart, task-service reopen, accepted turns and verified route preserved");
} finally {
  const errors = [];
  for (const resource of resources.reverse()) { try { await resource.close(); } catch (error) { errors.push(error); } }
  await rm(directory, { recursive: true, force: true });
  if (errors.length) throw new AggregateError(errors, "Eval browser proof cleanup failed");
}

async function proveProductionSettings({ browser, product, productSession, runtime, data }) {
  const connected = new Set();
  let pendingDefinitionId;
  let loginCount = 0;
  let closeCount = 0;
  let discoveryCount = 0;
  const registry = createProviderAdapterRegistry([{
    adapterId: "codex-subscription", implementationVersion: "1", label: "Fixture subscription",
    accessContract: "managed-runtime@1", connection: { mode: "managed-login" },
    create: ({ definition, environment }) => ({
      providerId: definition.id,
      credentials: {
        login: async () => { pendingDefinitionId = definition.id; loginCount++; return { authUrl: "https://provider.example/login" }; },
        account: async () => ({ status: connected.has(definition.id) ? "connected" : "disconnected" }),
        logout: async () => { connected.delete(definition.id); return { status: "disconnected" }; },
      },
      discover: async () => {
        discoveryCount++;
        if (!connected.has(definition.id)) return unavailableModelCatalogSnapshot({ providerId: definition.id, providerLabel: definition.label }, "Fixture subscription is disconnected.");
        return { provider: { id: definition.id, label: definition.label, status: "available" },
          systemFamily: { id: definition.id, label: definition.label, modelIds: ["fixture-model"] },
          models: [{ id: "fixture-model", executionModel: "fixture-model", label: "Fixture model", availability: "available", visible: true,
            description: "Deterministic settings fixture", unavailableReason: null, availabilityNotice: null, isDefault: true,
            replacementModelId: null, upgradeInfo: null, supportedEfforts: [], defaultEffort: null,
            inputModalities: ["text"], supportsPersonality: false, serviceTiers: [], defaultServiceTier: null }],
        };
      },
      executionAccess: async () => ({ kind: "managed-runtime", runtimeId: "codex", environment }),
      close: async () => { closeCount++; },
    }),
  }]);
  const descriptor = { runtimeId: "codex", version: "0.147.0", executable: "/fixture/codex" };
  const providerSetup = createEvalProviderSetup({ userDataDirectory: data, productServer: product, productSession,
    runtimeSession: await runtime.start(), graphRuntime: runtime, registry,
    runtimeResolver: { get: async () => descriptor, prepare: async () => descriptor },
  });
  resources.push(providerSetup);
  await providerSetup.start();
  const settingsSurface = await createSettingsSurface({ productSession, providerSetup });
  resources.push(settingsSurface);
  const dashboardSurface = await createEvalDashboard({ rendererDirectory: resolve("desktop/eval-renderer"),
    service: { catalog: () => ({ cases: [], harnessConfigurations: [], judges: [] }), listRuns: () => [] },
    openSettings: () => settingsSurface.url,
  });
  resources.push(dashboardSurface);
  const context = await browser.newContext();
  const pageErrors = [];
  context.on("page", (page) => page.on("pageerror", (error) => pageErrors.push(error.message)));
  await context.route("https://provider.example/**", (route) => route.fulfill({ contentType: "text/html", body: "Fixture authorization" }));
  const dashboard = await context.newPage(); await dashboard.goto(dashboardSurface.url);
  const popup = context.waitForEvent("page"); await dashboard.locator("#evalSettings").click();
  const page = await popup; await page.waitForLoadState();
  await page.waitForFunction(() => typeof document.querySelector("#newProviderDefinition")?.onclick === "function", null, { timeout: 10_000 }).catch(async (error) => { console.error(await page.locator("#settingsView").textContent(), pageErrors); throw error; });
  async function beginLogin() {
    await page.locator("#newProviderDefinition").click();
    await page.locator('[data-provider-adapter="codex-subscription"]').click();
    await page.locator("#providerField-label").fill("Eval fixture");
    await page.locator("[data-provider-dialog-connect]").click();
    await until(async () => (await page.locator("#providerDialogStatus").textContent()).includes("Complete sign-in"), "provider pending login");
  }
  const initialDefinitions = (await providerSetup.status()).definitions;
  await beginLogin();
  const cancelled = page.waitForResponse((response) => response.url().endsWith("/eval-api/cancelConnection"));
  await page.getByRole("button", { name: "Close provider dialog", exact: true }).click();
  assert.equal((await cancelled).status(), 200);
  await until(() => closeCount > 0, "provider login cancellation releases runtime");
  assert.deepEqual((await providerSetup.status()).definitions, initialDefinitions);
  await beginLogin();
  connected.add(pendingDefinitionId);
  await until(async () => (await page.locator("#providerSettingsStatus").textContent()).includes("Provider connected"), "provider login and discovery");
  assert.equal(loginCount, 2);
  const definition = (await providerSetup.status()).definitions.find((value) => value.label === "Eval fixture");
  assert.equal(definition.connected, true);
  const previousDiscoveryCount = discoveryCount;
  await page.locator("#refreshProviderCatalogs").click();
  await until(() => discoveryCount > previousDiscoveryCount, "provider refresh");
  await until(async () => (await page.locator("#providerSettingsStatus").textContent()) === "Provider models refreshed.", "provider refresh UI settled before editing families");
  await page.locator('[data-settings-tab="models"]').click();
  await page.locator("#newModelFamily").click();
  await page.locator("#familyNameInput").fill("My eval models");
  assert.equal(await page.locator('[data-member-model="0"]').inputValue(), "fixture-model");
  await page.locator('[data-member-orchestrator="0"]').check();
  await page.locator("#saveFamilyEdit").click();
  await until(async () => (await productSettings()).families.some((family) => family.name === "My eval models"), "custom family persisted through production API");
  const customFamily = (await productSettings()).families.find((family) => family.name === "My eval models");
  assert.equal(customFamily.members[0].providerId, definition.id);
  await page.locator("#defaultHarnessSelect").selectOption("codex-basic");
  await until(async () => (await page.locator("#modelSettingsStatus").textContent()) === "Saved", "default harness saved");
  await page.locator("#defaultProviderSelect").selectOption(definition.id);
  await until(async () => { const settings = await productSettings(); return settings.defaults.harnessId === "codex-basic" && settings.defaults.providerId === definition.id; }, "model defaults persisted");
  await page.locator("#evalDefaultFamilySelect").selectOption(String(customFamily.id));
  await until(async () => (await productSettings()).defaults.familyId === customFamily.id, "default custom family persisted");
  await page.locator('[data-settings-tab="harnesses"]').click();
  await page.locator('[data-harness-configuration="codex-basic"]').waitFor({ state: "visible" });
  assert.ok((await page.locator('[data-harness-configuration="codex-basic"]').textContent()).includes("Default harness"));
  await page.reload();
  await page.locator('[data-settings-tab="models"]').click();
  await until(async () => (await page.locator("#defaultHarnessSelect").inputValue()) === "codex-basic", "settings reload default");
  await until(async () => (await page.locator("#defaultProviderSelect").inputValue()) === definition.id, "settings reload provider").catch(async (error) => { console.error(JSON.stringify(await productSettings())); throw error; });
  await until(async () => (await page.locator("#evalDefaultFamilySelect").inputValue()) === String(customFamily.id), "settings reload selected family");
  assert.equal((await productSettings()).defaults.familyId, customFamily.id);
  // Copy the visible URL into a separate browser session with no shared storage.
  const otherBrowser = await browser.newContext();
  try {
    const copiedPage = await otherBrowser.newPage();
    const rootSettingsUrl = new URL(page.url()); rootSettingsUrl.search = "";
    await copiedPage.goto(rootSettingsUrl.href);
    await copiedPage.locator("#newProviderDefinition").waitFor({ state: "visible" });
    await until(async () => await copiedPage.locator("#newProviderDefinition").isEnabled(), "copied settings link authorized");
    await copiedPage.locator("#newProviderDefinition").click();
    await copiedPage.locator("#providerDialog").waitFor({ state: "visible" });
    await copiedPage.getByRole("button", { name: "Close provider dialog", exact: true }).click();
    await copiedPage.locator('[data-settings-tab="models"]').click();
    await until(async () => (await copiedPage.locator("#evalDefaultFamilySelect").inputValue()) === String(customFamily.id), "copied settings family");
    await copiedPage.getByRole("button", { name: "Back to Eval", exact: true }).click();
    await copiedPage.locator("#emptyNewRun").waitFor({ state: "visible" });
    assert.equal(new URL(copiedPage.url()).origin, dashboardSurface.origin);
    const returnedRuns = await copiedPage.evaluate(() => window.relayerEval.listRuns());
    assert.deepEqual(returnedRuns, [], "return navigation retains dashboard authorization in fresh storage");
  } finally { await otherBrowser.close(); }
  const selected = await providerSetup.select("codex-basic");
  assert.equal(selected.familyId, customFamily.id);
  assert.equal(selected.providerId, definition.id);
  assert.equal(selected.modelId, "fixture-model");
  await page.locator('[data-settings-tab="providers"]').click();
  await page.locator(`[data-provider-logout="${definition.id}"]`).click();
  await until(async () => (await providerSetup.status()).definitions.find((value) => value.id === definition.id).connected === false, "provider logout");
  await page.locator(`[data-provider-reconnect="${definition.id}"]`).click();
  await until(() => loginCount === 3, "provider reconnect login");
  connected.add(pendingDefinitionId);
  await until(async () => (await providerSetup.status()).definitions.find((value) => value.id === definition.id).connected === true, "provider reconnect complete");
  assert.deepEqual(pageErrors, []);
  await context.close();
  console.log("PASS Eval Settings: production Providers, login/cancel/reconnect, model refresh, persisted families/defaults and Harnesses (fake provider; no inference)");
  async function productSettings() {
    const response = await fetch(new URL("/api/model-settings", productSession.origin), { headers: { Cookie: `${productSession.cookie.name}=${productSession.cookie.value}` } });
    assert.equal(response.status, 200); return response.json();
  }
}

async function proveTaskActor({ browser, service, productSession, data }) {
  let tasks;
  const setupRegistry = await new SetupRegistry({ stateFile: join(data, "actor-setups.json"), feedbackLoader: (ref) => tasks.feedbackReference(ref) }).open();
  tasks = await new HumanTaskService({ stateFile: join(data, "actor-tasks.json"), evalService: service, productSession, setupRegistry }).open();
  let decision = 0;
  const snapshots = [];
  let controlPage;
  let completionAssessments = 0;
  const diagnosticDirectory = join(data, "actor-diagnostics-proof");
  let actorCapability;
  const actors = new TaskActorService({ tasks, setupRegistry, resolveRuntime: async () => ({}),
    resolveCompletionJudgeRuntime: async (spec) => { assert.equal(spec.model, "gpt-5.6-sol"); return {}; },
    createCompletionJudge: async ({ config }) => ({ close: async () => {}, evaluate: async (evidence) => {
      assert.ok(evidence.screenshot, "completion reviewer receives current rendered screenshot");
      assert.ok(!JSON.stringify(evidence).includes(diagnosticDirectory), "diagnostic artifacts never enter completion-judge input");
      completionAssessments++;
      if (config.evidenceContract?.id === "completion-evidence-v2") return { verdict: "uncertain", evidenceExplanation: "Participant measurements are unavailable; endpoint not confirmed.", continuationHint: "Please check fit when measurements are available.", usage: null };
      return completionAssessments === 1
        ? { verdict: "incomplete", evidenceExplanation: "Fixture reviewer requires one more visible graph inspection.", continuationHint: "Could I check one more part of the plan?", usage: null }
        : { verdict: "complete", evidenceExplanation: "Fixture reviewer accepts the plan after the additional graph inspection.", continuationHint: "", usage: null };
    } }),
    openBrowser: async (sessionId, signal, observationContract) => {
      const controller = await openTaskActorBrowser({ tasks, sessionId, productSession, browser, signal, observationContract, diagnosticDirectory });
      const actorPage = browser.contexts().flatMap((context) => context.pages()).find((page) => new URL(page.url()).searchParams.get("taskActor") === "1");
      controlPage = actorPage;
      actorCapability = new URL(actorPage.url()).hash.slice(1);
      await actorPage.locator(".graph-node").first().waitFor({ state: "visible" });
      try {
      // Force the actual renderer's refresh in the gap after preflight, before
      // native click. This is intentionally later than the rebind tests below.
      {
        const observed = await controller.observe();
        const original = await actorPage.locator(".graph-node").first().elementHandle();
        const label = await original.getAttribute("aria-label");
        const ref = observed.controls.find(control => control.name === label).ref;
        const prototype = Object.getPrototypeOf(original);
        const nativeClick = prototype.click;
        let inject = true;
        prototype.click = async function (options) {
          if (inject) {
            inject = false;
            await actorPage.evaluate(async () => { const { refreshState } = await import("/src/threads.js"); await refreshState(window.__taskActorPresentation.threadId); });
            await until(() => original.evaluate(element => !element.isConnected), "pre-dispatch renderer refresh detached target");
          }
          return nativeClick.call(this, options);
        };
        try {
          await assert.rejects(controller.act({ kind: "click", ref }), { code: "actor_control_unavailable", actionDispatched: false });
        } finally { prototype.click = nativeClick; await original.dispose(); }
        const fresh = await controller.observe();
        await controller.act({ kind: "click", ref: fresh.controls.find(control => control.name === label).ref });
        // Even the same error text is terminal after a real trusted activation.
        const after = await controller.observe();
        const activated = await actorPage.locator(".graph-node").first().elementHandle();
        const activeLabel = await activated.getAttribute("aria-label");
        prototype.click = async function (options) {
          await nativeClick.call(this, options);
          await this.evaluate(element => element.remove());
          throw new Error("Element is not attached to the DOM");
        };
        try {
          await assert.rejects(controller.act({ kind: "click", ref: after.controls.find(control => control.name === activeLabel).ref }), error => {
            assert.equal(error.actionDispatched, undefined); assert.equal(error.code, undefined);
            assert.match(error.message, /not attached/); return true;
          });
        } finally { prototype.click = nativeClick; await activated.dispose(); }
        await actorPage.evaluate(async () => { const { refreshState } = await import("/src/threads.js"); await refreshState(window.__taskActorPresentation.threadId); });
        // A trusted scroll can run product handlers even without pointer input.
        const beforeScroll = await controller.observe();
        const scrollTarget = await actorPage.locator(".graph-node").first().elementHandle();
        const scrollLabel = await scrollTarget.getAttribute("aria-label");
        prototype.click = async function () {
          await actorPage.evaluate(async () => {
            const scroller = document.createElement("div");
            scroller.style.cssText = "position:fixed;top:0;left:0;width:40px;height:10px;overflow:scroll;display:block;z-index:999999;scroll-behavior:auto";
            const content = document.createElement("div");
            content.style.cssText = "display:block;width:20px;height:100px;min-height:100px";
            scroller.append(content); document.body.append(scroller);
            try {
              await new Promise(resolve => requestAnimationFrame(resolve));
              if (scroller.scrollHeight <= scroller.clientHeight) throw new Error("Scroll proof fixture has no overflow.");
              await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error(`Trusted scroll proof timed out: ${scroller.scrollTop}/${scroller.scrollHeight}/${scroller.clientHeight}`)), 2000);
                scroller.addEventListener("scroll", event => { clearTimeout(timeout); event.isTrusted ? resolve() : reject(new Error("Scroll proof was synthetic.")); }, { once: true });
                scroller.scrollTop = 40;
              });
            } finally { scroller.remove(); }
          });
          await this.evaluate(element => element.remove());
          throw new Error("Element is not attached to the DOM");
        };
        try {
          await assert.rejects(controller.act({ kind: "click", ref: beforeScroll.controls.find(control => control.name === scrollLabel).ref }), error => {
            assert.equal(error.actionDispatched, undefined); assert.match(error.message, /not attached/); return true;
          });
        } finally { prototype.click = nativeClick; await scrollTarget.dispose(); }
        await actorPage.evaluate(async () => { const { refreshState } = await import("/src/threads.js"); await refreshState(window.__taskActorPresentation.threadId); });
        // document.open can clear listeners without replacing the Document.
        // Use another disposable surface so this negative cannot contaminate the actor.
        const rewriteController = await openTaskActorBrowser({ tasks, sessionId, productSession, browser, signal, observationContract });
        try {
          const rewritePage = browser.contexts().flatMap(context => context.pages()).at(-1);
          await rewritePage.locator(".graph-node").first().waitFor({ state: "visible" });
          const rewriteObservation = await rewriteController.observe();
          const rewriteName = await rewritePage.locator(".graph-node").first().getAttribute("aria-label");
          prototype.click = async function () {
            await rewritePage.evaluate(() => { document.open(); document.write('<html><body>replaced</body></html>'); document.close(); });
            throw new Error("Element is not attached to the DOM");
          };
          await assert.rejects(rewriteController.act({ kind: "click", ref: rewriteObservation.controls.find(control => control.name === rewriteName).ref }), error => {
            assert.equal(error.actionDispatched, undefined); assert.match(error.message, /not attached/); return true;
          });
        } finally { prototype.click = nativeClick; await rewriteController.close(); }
        console.log("PASS actor dispatch race: real renderer redraw requires fresh observation; trusted activation, scroll and document rewrite failures stay terminal");
      }
      // A native popup is outside Chromium screenshot pixels: its opened-only
      // accessible option names are a separately authorized observation.
      await actorPage.evaluate(() => {
        const field = document.createElement("select"); field.id = "actor-native-select";
        field.setAttribute("aria-label", "Budget proof");
        field.style.cssText = "position:fixed;top:100px;left:900px;z-index:99999";
        field.innerHTML = '<option value="a">Small</option><option value="b">Targeted</option><option disabled>Disabled secret</option><option hidden>Hidden secret</option><option>Duplicate</option><option>Duplicate</option><optgroup disabled><option>Group secret</option></optgroup>';
        field.addEventListener("input", () => { window.actorSelectInput = (window.actorSelectInput || 0) + 1; });
        field.addEventListener("change", () => { window.actorSelectChange = (window.actorSelectChange || 0) + 1; });
        document.querySelector(".workspace-layout").append(field);
      });
      let menu = await controller.observe();
      let budget = menu.controls.find(control => control.name === "Budget proof");
      assert.equal(budget.options, undefined, "closed native options stay private");
      await assert.rejects(controller.act({ kind: "select", ref: budget.ref, value: "Targeted" }), { code: "actor_control_unavailable", actionDispatched: false }).catch(error => { console.error("Native menu boundary:", error); throw error; });
      await controller.act({ kind: "click", ref: budget.ref });
      assert.equal(await actorPage.locator("#actor-native-select").evaluate(element => element.matches(":open")), true);
      menu = await controller.observe(); budget = menu.controls.find(control => control.name === "Budget proof");
      assert.deepEqual(budget.options, ["Small", "Targeted"]);
      assert.equal(budget.optionObservation, "opened-native-select-accessibility");
      for (const value of ["Guessed", "Disabled secret", "Hidden secret", "Duplicate", "Group secret"]) {
        await assert.rejects(controller.act({ kind: "select", ref: budget.ref, value }), { code: "actor_control_unavailable", actionDispatched: false });
      }
      await controller.act({ kind: "select", ref: budget.ref, value: "Targeted" });
      assert.deepEqual(await actorPage.evaluate(() => [document.querySelector("#actor-native-select").value, window.actorSelectInput, window.actorSelectChange]), ["b", 1, 1]);
      assert.equal(await actorPage.locator("#actor-native-select").evaluate(element => element.matches(":open")), false, "selection closes native popup");
      menu = await controller.observe(); budget = menu.controls.find(control => control.name === "Budget proof");
      assert.equal(budget.options, undefined);
      await controller.act({ kind: "click", ref: budget.ref });
      assert.equal(await actorPage.locator("#actor-native-select").evaluate(element => element.matches(":open")), true, "next ordinary click opens the menu rather than dismissing a leftover popup");
      menu = await controller.observe(); budget = menu.controls.find(control => control.name === "Budget proof");
      assert.deepEqual(budget.options, ["Small", "Targeted"]);
      await actorPage.locator("#actor-native-select option").nth(1).evaluate(element => { element.textContent = "Changed"; });
      await assert.rejects(controller.act({ kind: "select", ref: budget.ref, value: "Targeted" }), { code: "actor_control_unavailable", actionDispatched: false });
      await actorPage.keyboard.press("Escape");
      // Closing or changing presentation invalidates an otherwise observed name.
      menu = await controller.observe(); budget = menu.controls.find(control => control.name === "Budget proof");
      await controller.act({ kind: "click", ref: budget.ref });
      menu = await controller.observe(); budget = menu.controls.find(control => control.name === "Budget proof");
      await actorPage.keyboard.press("Escape");
      assert.equal(await actorPage.locator("#actor-native-select").evaluate(element => element.matches(":open")), false);
      await assert.rejects(controller.act({ kind: "select", ref: budget.ref, value: "Small" }), { code: "actor_control_unavailable", actionDispatched: false });
      menu = await controller.observe(); budget = menu.controls.find(control => control.name === "Budget proof");
      await actorPage.locator("#actor-native-select").click();
      assert.equal((await controller.observe()).controls.find(control => control.name === "Budget proof").options, undefined, "unowned opening grants no option observation");
      await actorPage.keyboard.press("Escape");
      menu = await controller.observe(); budget = menu.controls.find(control => control.name === "Budget proof");
      await controller.act({ kind: "click", ref: budget.ref });
      menu = await controller.observe(); budget = menu.controls.find(control => control.name === "Budget proof");
      const menuTurn = await actorPage.evaluate(() => window.__taskActorPresentation.turnId);
      await actorPage.evaluate(() => { window.__taskActorPresentation.turnId = "changed-menu-turn"; });
      await assert.rejects(controller.act({ kind: "select", ref: budget.ref, value: "Small" }), { code: "actor_control_unavailable", actionDispatched: false });
      assert.equal((await controller.observe()).controls.find(control => control.name === "Budget proof").options, undefined);
      await actorPage.evaluate(turnId => { window.__taskActorPresentation.turnId = turnId; }, menuTurn);
      await actorPage.keyboard.press("Escape");
      menu = await controller.observe(); budget = menu.controls.find(control => control.name === "Budget proof");
      await controller.act({ kind: "click", ref: budget.ref });
      menu = await controller.observe(); budget = menu.controls.find(control => control.name === "Budget proof");
      await actorPage.locator("#actor-native-select").evaluate(element => element.replaceWith(element.cloneNode(true)));
      await assert.rejects(controller.act({ kind: "select", ref: budget.ref, value: "Small" }), { code: "actor_control_unavailable", actionDispatched: false });
      assert.equal((await controller.observe()).controls.find(control => control.name === "Budget proof").options, undefined, "replacement cannot inherit menu authority");
      await actorPage.locator("#actor-native-select").evaluate(element => { element.innerHTML = Array.from({ length: 33 }, (_, i) => `<option>Choice ${i}</option>`).join(""); });
      menu = await controller.observe(); budget = menu.controls.find(control => control.name === "Budget proof");
      await controller.act({ kind: "click", ref: budget.ref });
      menu = await controller.observe(); budget = menu.controls.find(control => control.name === "Budget proof");
      assert.equal(budget.options, undefined, "oversized native menus fail closed");
      await assert.rejects(controller.act({ kind: "select", ref: budget.ref, value: "Choice 0" }), { code: "actor_control_unavailable", actionDispatched: false });
      await actorPage.keyboard.press("Escape");
      console.log("PASS actor native select: opened-only explicit accessibility, exact enabled unique labels, normal input/change, closed/unowned/stale/presentation/oversized rejection");
      await actorPage.locator("#actor-native-select").evaluate(element => element.remove());
      } catch (error) { console.error("Native select browser proof failed:", error); throw error; }
      const beforeRefresh = await controller.observe();
      const nodeChoice = beforeRefresh.controls.find(control => control.name.includes("Two-worker"));
      assert.ok(nodeChoice, "real graph node is observed before model latency");
      const observedNode = await actorPage.locator('.graph-node').filter({ hasText: "Two-worker" }).elementHandle();
      await observedNode.evaluate(element => {
        // renderGraph replaces nodeLayer children. Reproduce that same DOM
        // replacement while retaining the real product activation callback.
        const replacement = element.cloneNode(true);
        replacement.onclick = element.onclick;
        element.replaceWith(replacement);
      });
      const replacementNode = actorPage.locator('.graph-node').filter({ hasText: "Two-worker" });
      const originalLabel = await replacementNode.getAttribute("aria-label");
      await replacementNode.evaluate(element => element.setAttribute("aria-label", "Different meaning"));
      await assert.rejects(controller.act({ kind: "click", ref: nodeChoice.ref }), { code: "actor_control_unavailable", actionDispatched: false, message: /no longer visible/ });
      await replacementNode.evaluate((element, label) => element.setAttribute("aria-label", label), originalLabel);
      await replacementNode.evaluate(element => { const duplicate = element.cloneNode(true); duplicate.id = "actor-duplicate-node"; element.after(duplicate); });
      await assert.rejects(controller.act({ kind: "click", ref: nodeChoice.ref }), /no longer visible/);
      await actorPage.locator("#actor-duplicate-node").evaluate(element => element.remove());
      const originalTurn = await actorPage.evaluate(() => window.__taskActorPresentation.turnId);
      await actorPage.evaluate(() => { window.__taskActorPresentation.turnId = "other-turn"; });
      await assert.rejects(controller.act({ kind: "click", ref: nodeChoice.ref }), /no longer visible/);
      await actorPage.evaluate(turnId => { window.__taskActorPresentation.turnId = turnId; }, originalTurn);
      await replacementNode.evaluate(element => { element.hidden = true; });
      await assert.rejects(controller.act({ kind: "click", ref: nodeChoice.ref }), /no longer visible/);
      await replacementNode.evaluate(element => { element.hidden = false; });
      const expectedNodeId = await replacementNode.getAttribute("data-node");
      await controller.act({ kind: "click", ref: nodeChoice.ref });
      await until(async () => String(await actorPage.evaluate(() => window.__taskActorPresentation.selectedNodeId)) === expectedNodeId, "rebound click selects the observed graph node");
      await observedNode.dispose();
      // Use the ordinary renderer refresh, which rebuilds fallback actions and
      // breadcrumbs even while the accepted presentation remains unchanged.
      const rootControls = await controller.observe();
      await controller.act({ kind: "click", ref: rootControls.controls.find(control => control.name.includes("Incoming queue")).ref });
      for (const kind of ["action", "breadcrumb"]) {
        const selector = kind === "action" ? "#detailActions button.action-control" : "#workspaceBreadcrumb button.breadcrumb-segment";
        await actorPage.locator(selector).first().waitFor({ state: "visible" });
        const observed = await controller.observe();
        const choice = observed.controls.find(control => kind === "action" ? control.name.includes("See queue behavior") : control.name.startsWith("Go to "));
        assert.ok(choice, `${kind} observed before refresh`);
        const oldControl = await actorPage.locator(selector).first().elementHandle();
        await actorPage.evaluate(async () => { const { refreshState } = await import("/src/threads.js"); await refreshState(window.__taskActorPresentation.threadId); });
        await until(() => oldControl.evaluate(element => !element.isConnected), `${kind} replaced by production refresh`);
        const replacement = actorPage.locator(selector).first();
        const rejectsReplacement = () => assert.rejects(controller.act({ kind: "click", ref: choice.ref }), { code: "actor_control_unavailable", actionDispatched: false });
        await replacement.evaluate(element => { const duplicate = element.cloneNode(true); duplicate.id = "duplicate-actor-control"; element.after(duplicate); });
        await rejectsReplacement(); await actorPage.locator("#duplicate-actor-control").evaluate(element => element.remove());
        const attributes = kind === "action" ? ["data-action-id", "data-review-kind", "data-review-target-layer-id"] : ["data-review-ref", "data-review-path-index", "data-review-kind"];
        for (const attribute of attributes) {
          const previous = await replacement.getAttribute(attribute);
          await replacement.evaluate((element, attribute) => element.setAttribute(attribute, "changed"), attribute);
          await rejectsReplacement();
          await replacement.evaluate((element, { attribute, previous }) => previous === null ? element.removeAttribute(attribute) : element.setAttribute(attribute, previous), { attribute, previous });
        }
        const html = await replacement.innerHTML();
        await replacement.evaluate(element => { element.textContent = "Different control"; }); await rejectsReplacement();
        await replacement.evaluate((element, html) => { element.innerHTML = html; }, html);
        const path = await actorPage.evaluate(() => window.__taskActorPresentation.navigationPath);
        await actorPage.evaluate(() => { window.__taskActorPresentation.navigationPath = [{ layerId: "changed" }]; });
        await rejectsReplacement();
        await actorPage.evaluate(path => { window.__taskActorPresentation.navigationPath = path; }, path);
        await replacement.evaluate(element => { element.hidden = true; }); await rejectsReplacement();
        await replacement.evaluate(element => { element.hidden = false; });
        await controller.act({ kind: "click", ref: choice.ref });
        await oldControl.dispose();
        console.log(`PASS actor redraw ${kind}: production refresh detached the original and exact replacement activation succeeded`);
      }

      assert.equal(await actorPage.locator("#humanTaskGrading").count(), 0);
      assert.equal(await actorPage.evaluate(async () => (await (await fetch("/api/capabilities")).json()).annotations), false);
      await actorPage.evaluate(() => {
        const root = document.querySelector(".workspace-layout");
        const hidden = document.createElement("div");
        hidden.id = "actor-hidden-test"; hidden.style.cssText = "position:fixed;left:0;top:0;width:10px;height:10px;overflow:hidden";
        const button = document.createElement("button"); button.textContent = "HIDDEN EVALUATOR FEEDBACK"; button.style.cssText = "position:absolute;top:100px";
        hidden.append(button); root.append(hidden);
        const fields = document.createElement("div"); fields.id = "actor-fields-test";
        fields.style.cssText = "position:fixed;left:400px;top:200px;z-index:9999;background:white;color:black";
        fields.innerHTML = '<label>Choice<select><option>Visible choice</option><option value="INTERNAL_OPTION">CLOSED_OPTION_SENTINEL</option></select></label><label>Note<textarea style="width:40px;height:20px">CLIPPED_VALUE_SENTINEL</textarea></label>';
        root.append(fields);
      });
      await actorPage.route("**/api/threads/1/interactions/1/actions/1/destination", async route => {
        await new Promise(resolve => setTimeout(resolve, 350));
        await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      });
      await actorPage.evaluate(() => {
        const button = document.createElement("button"); button.textContent = "Delayed navigation";
        button.onclick = async () => { await fetch("/api/threads/1/interactions/1/actions/1/destination"); button.textContent = "Navigation settled"; };
        document.querySelector("#actor-fields-test").append(button);
      });
      const navigation = await controller.observe();
      await controller.act({ kind: "click", ref: navigation.controls.find(control => control.name === "Delayed navigation").ref });
      assert.equal(await actorPage.getByRole("button", { name: "Navigation settled", exact: true }).count(), 1, "action waits for navigation GET completion");
      const first = await controller.observe();
      assert.ok(first.controls.some(control => control.name === "Choice"));
      assert.ok(!JSON.stringify(first.controls).match(/CLOSED_OPTION_SENTINEL|INTERNAL_OPTION|CLIPPED_VALUE_SENTINEL/));
      await actorPage.locator("#actor-fields-test").evaluate(element => element.remove());
      assert.ok(first.controls.every((control) => !control.name.includes("HIDDEN EVALUATOR FEEDBACK")));
      await controller.observe();
      if (first.controls[0]) await assert.rejects(controller.act({ kind: "click", ref: first.controls[0].ref }), /stale/);
      await assert.rejects(controller.act({ kind: "click", ref: "forged" }), { code: "actor_control_stale", actionDispatched: false, message: /stale/ });
      await actorPage.locator("#actor-hidden-test").evaluate((element) => element.remove());
      return controller;
    },
    createActor: async () => ({ close: async () => {}, decide: async (observation) => {
      snapshots.push(observation);
      if (decision <= 1) {
        const active = tasks.get(tasks.list()[0].id);
        assert.equal(active.status, "active");
        const review = await openHumanReview({ executionId: active.id,
          productSession: async () => productSession, assertRunning: () => {},
          registerAnnotations: (session, scope) => productJson(session, "/api/internal/annotation-sessions", {
            method: "POST", body: { ...scope, authorId: "actor-review-proof", authorDisplayName: "Actor review proof" },
          }),
          humanGrading: { task: () => tasks.get(active.id), grade: (input) => tasks.grade(active.id, input), annotate: (input) => tasks.annotate(active.id, input) },
          reviewContext: () => ({ readOnly: true, selectedExecutionId: active.id, harnessConfigurationName: active.prepared.execution.harnessConfigurationName,
            cases: [{ executionId: active.id, name: active.prepared.name, status: "active", threadIds: active.threadIds,
              threads: active.threadIds.map((id) => ({ id, name: "Active simulated task" })) }] }),
        });
        const reviewer = await browser.newPage();
        try {
          await reviewer.goto(review.url);
          await reviewer.locator("#humanTaskGrading summary").first().click();
          assert.equal(await reviewer.getByRole("button", { name: "Finish task", exact: true }).count(), 0);
          await reviewer.locator('#humanTaskGrading [name="satisfaction"]').selectOption("1");
          await reviewer.locator('#humanTaskGrading [data-session-grade] [name="comment"]').fill("Independent human feedback");
          await reviewer.getByRole("button", { name: "Save grade", exact: true }).click();
          await until(async () => (await reviewer.locator("[data-grade-status]").textContent()).includes("Grade saved"), "active actor human grade saved");
          assert.equal(await reviewer.evaluate(async (threadId) => (await fetch(`/api/threads/${threadId}/interactions`, { method: "POST", body: "{}" })).status, active.currentThreadId), 403);
          assert.equal(tasks.get(active.id).status, "active");
          if (decision === 1) {
            const actionEvent = tasks.get(active.id).events.find(event => event.kind === "actor_action");
            await reviewer.locator('#humanTaskGrading [name="eventId"]').selectOption(actionEvent.id);
            await reviewer.locator('#humanTaskGrading form:not([data-session-grade]) [name="comment"]').fill("Unnecessary exploration: review this actor choice.");
            await reviewer.getByRole("button", { name: "Save moment annotation", exact: true }).click();
            await until(async () => (await reviewer.locator("[data-grade-status]").textContent()).includes("Moment annotation saved"), "actor action annotation saved");
            assert.equal(tasks.get(active.id).annotations.at(-1).eventId, actionEvent.id);
          }
        } finally { await reviewer.close(); await review.close(); }
      }
      if (process.env.RELAYER_EVAL_ACTOR_SCREENSHOT) await writeFile(process.env.RELAYER_EVAL_ACTOR_SCREENSHOT, Buffer.from(observation.screenshot, "base64"));
      assert.ok(Buffer.from(observation.screenshot, "base64").readUInt32BE(16) > 0);
      assert.ok(!JSON.stringify(observation.controls).includes("Review & grade"));
      const action = { kind: "finish", ref: "", value: "", reason: "satisfied", satisfaction: 3, comment: "The follow-up is good enough.", endpointStatus: "incomplete", remainingWork: "Further choices remain." };
      if ([5, 7].includes(decision)) Object.assign(action, { reason: "endpoint_reached", endpointStatus: "reached", remainingWork: "" });
      const find = (predicate) => { const control = observation.controls.find(predicate); assert.ok(control, JSON.stringify(observation.controls)); return control.ref; };
      if (decision === 0) Object.assign(action, { kind: "click", ref: find((control) => control.name.includes("Two-worker")) });
      if (decision === 1) Object.assign(action, { kind: "fill", ref: find((control) => control.role === "textarea"), value: "Explain how the workers coordinate." });
      if (decision === 2) Object.assign(action, { kind: "click", ref: find((control) => ["Send", "↑"].includes(control.name)) });
      if (decision === 3) Object.assign(action, { kind: "click", ref: find((control) => control.name.includes("Results store")) });
      if (decision === 4) {
        Object.assign(action, { kind: "click", ref: find((control) => control.name.includes("Plan the next improvement")) });
        const oldInvoke = await controlPage.locator("#detailActions button.action-control").filter({ hasText: "Plan the next improvement" }).elementHandle();
        await controlPage.evaluate(async () => { const { refreshState } = await import("/src/threads.js"); await refreshState(window.__taskActorPresentation.threadId); });
        await until(() => oldInvoke.evaluate(element => !element.isConnected), "invoke button replaced by production refresh");
        await oldInvoke.dispose();
      }
      if (decision === 6) {
        assert.equal(observation.completionJudgeFeedback, "Could I check one more part of the plan?");
        assert.ok(!observation.availableActions.includes("finish"), "judge rejection requires an ordinary interaction first");
        const label = await controlPage.locator(".graph-node").first().getAttribute("aria-label");
        Object.assign(action, { kind: "click", ref: find(control => control.name === label) });
      }
      decision++;
      return { action, usage: null };
    } }),
  });
  resources.push(actors);
  const calibration = await new CalibrationService({ stateFile: join(data, "actor-calibration.json"), setups: setupRegistry, tasks, evalService: service, author: tasks.annotator }).open();
  const surface = await createEvalDashboard({ service, humanTasks: tasks, taskActors: actors, setupRegistry, calibration, rendererDirectory: resolve("desktop/eval-renderer") });
  resources.push(surface);
  const page = await browser.newPage();
  try {
    await page.goto(surface.url);
    await page.locator("#humanGrader").click();
    assert.equal(await page.locator("#humanHarness").isVisible(), false);
    assert.equal(await page.locator("#setupEditor").isVisible(), false);
    await page.locator("#humanAllCases").check();
    await page.locator("#humanAdvanced > summary").click();
    await page.locator("#taskMode").selectOption("simulated");
    assert.equal(await page.locator("#humanActorNotice").isVisible(), true);
    assert.equal(await page.locator("#actorSettings").isVisible(), true);
    await page.locator("#humanCase").selectOption("empty-project.task-system.two-turn");
    await page.locator("#humanHarness").selectOption("fixture-task-system");
    await page.locator('[name="maxCompletions"]').fill("4");
    await page.locator("#humanEndpoint").fill("An understandable task system");
    await page.locator("#humanCreate button").click();
    await until(() => tasks.list().length > 0, "actor session created through dashboard");
    const task = await until(() => { const task = tasks.get(tasks.list()[0].id); return ["completed", "interrupted", "failed"].includes(task.status) ? task : null; }, "actor session terminal");
    assert.equal(task.status, "completed", JSON.stringify(task.events.map(({ kind, ...event }) => ({ kind, ...(kind === "actor_error" ? event : {}) }))));
    assert.equal(task.completions, 3);
    await actors.running.get(task.id)?.done;
    const attempts = await readdir(diagnosticDirectory);
    assert.equal(attempts.length, 1);
    const diagnosticRoot = join(diagnosticDirectory, attempts[0]);
    const diagnosticFiles = await readdir(diagnosticRoot);
    assert.ok(!diagnosticFiles.some(name => name.startsWith(".trace-")), "raw trace scratch removed");
    const diagnosticText = await readFile(join(diagnosticRoot, "events.jsonl"), "utf8");
    const diagnosticEvents = diagnosticText.trim().split("\n").map(line => JSON.parse(line));
    assert.ok(!actorCapability || !diagnosticText.includes(actorCapability), "capability absent from diagnostic events");
    const recoveries = diagnosticEvents.filter(event => event.type === "click_recovery");
    assert.ok(recoveries.some(event => event.eligible && event.reason === "proven_nondispatch"));
    assert.ok(recoveries.filter(event => !event.eligible && event.checks?.untouchedInput === false).length >= 2,
      "delivered click and trusted scroll each explain refused recovery");
    assert.ok(diagnosticEvents.some(event => event.type === "action_error" && event.stage === "dispatch_click" && /not attached/.test(event.error.message)));
    assert.ok(diagnosticEvents.some(event => event.type === "navigation"));
    const correlated = diagnosticEvents.filter(event => event.type === "action_started" && event.actionEventId);
    assert.equal(correlated.length, task.events.filter(event => event.kind === "actor_action" && ["click", "fill", "select", "scroll"].includes(event.action.kind)).length);
    for (const event of correlated) {
      assert.ok(task.events.some(item => item.id === event.actionEventId && item.kind === "actor_action"));
      assert.ok(task.events.some(item => item.id === event.observationEventId && item.kind === "actor_observation"));
    }
    assert.ok(diagnosticFiles.some(name => name.endsWith(".png")), "failure screenshots persisted");
    const traceText = execFileSync("python3", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert set(z.namelist()) == {'trace.trace','trace.network'}; print(z.read('trace.trace').decode())", join(diagnosticRoot, "trace.zip")], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    assert.ok(!actorCapability || !traceText.includes(actorCapability));
    const traceEvents = traceText.trim().split("\n").map(line => JSON.parse(line));
    assert.ok(traceEvents.some(event => event.type === "before" && event.method === "click"));
    assert.ok(traceEvents.some(event => event.type === "after" && event.error));
    console.log("PASS actor diagnostic capture: actual Playwright archive, errors, recovery decisions, action correlation and failure screenshots; no raw capability");

    await until(async () => (await page.locator("#humanTaskDetail").textContent()).includes("Completion reviewer: gpt-5.6-sol"), "pinned completion reviewer visible in task details");
    assert.ok((await page.locator("#humanTaskDetail").textContent()).includes("high reasoning"));
    assert.equal(decision, 8);
    assert.equal(completionAssessments, 2);
    const judgments = task.events.filter(event => event.kind === "actor_completion_judgment");
    assert.deepEqual(judgments.map(event => event.verdict), ["incomplete", "complete"]);
    for (const judgment of judgments) {
      assert.ok(task.events.some(event => event.id === judgment.actorActionEventId && event.kind === "actor_action" && event.action.kind === "finish"));
      assert.ok(task.events.some(event => event.id === judgment.observationEventId && event.kind === "actor_observation"));
      assert.ok(task.events.some(event => event.id === judgment.evidenceEventId && event.kind === "actor_completion_evidence"));
    }
    assert.ok(task.events.some(event => event.kind === "actor_action_completed" && event.sequence > judgments[0].sequence && event.sequence < judgments[1].sequence), "real browser interaction separates rejected and accepted finish");
    assert.equal(task.termination.completionJudgeEventId, judgments[1].id);
    assert.equal(task.termination.reason, "endpoint_reached");
    assert.ok(task.events.some((event) => event.kind === "submission" && event.path?.endsWith("/invoke")));
    const lastTurn = (await tasks.detail(task.currentThreadId)).interactions.at(-1);
    assert.equal(String(task.events.findLast(event => event.kind === "presentation").snapshot.turnId), String(lastTurn.id), "latest completed response is painted before actor finishes");
    for (const snapshot of snapshots) {
      assert.deepEqual(Object.keys(snapshot).sort(), [...["availableActions", "controls", "screenshot", "text"], ...(snapshot.completionJudgeFeedback ? ["completionJudgeFeedback"] : [])].sort());
      assert.deepEqual(snapshot.availableActions, ["click", "fill", "select", "scroll", ...(snapshot === snapshots[6] ? [] : ["finish"])]);
      for (const control of snapshot.controls) assert.deepEqual(Object.keys(control).sort(), ["name", "ref", "role"]);
    }
    assert.ok(task.events.filter(event => event.kind === "actor_observation").every(event => !event.observation.screenshot && event.observation.screenshotArtifact));
    assert.equal(task.events.filter((event) => event.kind === "actor_satisfaction").length, 2);
    assert.equal(task.satisfaction.value, 1, "human grade saved during the active actor session stays separate from actor satisfaction");
    const exported = await tasks.export(task.id);
    assert.equal(exported.bundle.session.events.filter((event) => event.kind === "actor_observation").length, 8);
    assert.equal(exported.bundle.session.satisfaction.value, 1);
    assert.equal(exported.bundle.actorScreenshots.length, 8);
    assert.ok(!JSON.stringify(exported.bundle).includes(diagnosticDirectory), "diagnostics excluded from ordinary evidence exports");
    assert.equal(exported.bundle.session.termination.completionJudgeEventId, judgments[1].id);
    assert.equal(await page.locator("#actorSettings [name=actorModel]").inputValue(), "gpt-5.6-luna");
    assert.ok(snapshots.every((snapshot) => !JSON.stringify(snapshot).includes("Independent human feedback") && !JSON.stringify(snapshot).includes("Unnecessary exploration")));
    const baseline = setupRegistry.selected("actor");
    await page.locator("#humanTools > summary").click();
    await page.locator("#setupPredecessor").selectOption(baseline.id);
    await until(async () => (await page.locator("#setupEditor").textContent()).includes("Completion reviewer: gpt-5.6-sol"), "pinned reviewer rendered in setup editor");
    assert.ok((await page.locator("#setupEditor").textContent()).includes("Endpoint claims require approval"));
    await page.locator("#setupUseCurrentActor").click();
    assert.ok((await page.locator("#setupCompletionReviewer").textContent()).includes("gpt-5.6-sol"));
    assert.equal(await page.locator('#setupPublish [name="promptVersion"]').inputValue(), setupRegistry.catalog().actorDefinition.promptVersion);
    await page.locator('#setupPublish [name="name"]').fill("Brief user from human feedback");
    await page.locator('#setupPublish [name="promptVersion"]').fill("browser-manual-actor-v1");
    await page.locator('#setupPublish [name="timeoutMinutes"]').fill("60");
    await page.locator('#setupPublish [name="promptTemplate"]').fill(baseline.promptTemplate + "\nKeep replies brief.");
    await page.locator("#setupFeedbackSession").selectOption(task.id);
    await page.locator("#setupFeedbackRecords input").first().check();
    await page.locator("#setupPublish button").click();
    const revision = await until(() => setupRegistry.catalog().revisions.find((item) => item.promptVersion === "browser-manual-actor-v1"), "setup revision published");
    await until(async () => (await page.locator("#setupPublished").textContent()).includes(revision.id), "published revision visible in editor");
    assert.equal(revision.predecessorId, baseline.id);
    assert.equal(revision.settings.timeoutMs, 3600000);
    assert.equal(await page.locator('#setupPublish [name="timeoutMinutes"]').inputValue(), "60");
    assert.ok(revision.feedback[0].feedback.comment.includes("Unnecessary exploration"));
    assert.equal(tasks.get(task.id).actorSetup.id, baseline.id);
    await page.locator("#humanNewTask > summary").click();
    await page.locator("#actorSetupRevision").selectOption(revision.id);
    assert.equal(await page.locator("#actorSetupRevision").inputValue(), revision.id);
    await page.locator('#setupPromote [name="comment"]').fill("Human reviewed the saved action feedback.");
    await page.locator("#setupPromote button").click();
    await until(() => setupRegistry.selected("actor").id === revision.id, "explicit promotion persisted");
    const reopened = await new SetupRegistry({ stateFile: join(data, "actor-setups.json") }).open();
    assert.deepEqual(reopened.get(revision.id), revision);
    assert.deepEqual((await tasks.export(task.id)).bundle.session.actorSetup, baseline);
    if (process.env.RELAYER_EVAL_SETUP_SCREENSHOT) await page.screenshot({ path: process.env.RELAYER_EVAL_SETUP_SCREENSHOT, fullPage: true });
    console.log("PASS setup revisions: actual dashboard publication, predecessor/human lineage, selection, explicit promotion, reopen and original run/export unchanged");
    const judgeBaseline = setupRegistry.selected("judge");
    await page.locator("#setupPredecessor").selectOption(judgeBaseline.id);
    await page.locator("#judgeConfigFile").waitFor({ state: "visible" });
    const config = setupRegistry.judgeConfigs()[0];
    assert.equal(await page.locator("#judgeConfigFile").inputValue(), config.file);
    assert.equal(await page.locator('#setupPublish [name="promptVersion"]').count(), 0);
    assert.equal(await page.locator('#setupPublish input, #setupPublish textarea, #setupPublish select[name="modelReasoningEffort"]').count(), 0);
    assert.ok((await page.locator("#setupEditor").textContent()).includes(config.path));
    assert.ok((await page.locator("#setupPublish").textContent()).includes(config.digest));
    await page.locator("#setupFeedbackSession").selectOption(task.id);
    await page.locator("#setupFeedbackRecords input").first().check();
    await page.locator("#setupPublish button").click();
    const fileJudge = await until(() => setupRegistry.catalog().revisions.find((item) => item.kind === "judge" && item.predecessorId === judgeBaseline.id), "judge config published through dashboard");
    assert.equal(fileJudge.configSource.digest, config.digest);
    assert.equal(fileJudge.configSource.contents, config.definition.configSource.contents);
    assert.equal(fileJudge.promptTemplate, config.definition.promptTemplate);
    await until(async () => (await page.locator("#setupPublished").textContent()).includes(fileJudge.id), "graph config publication lifecycle rendered");
    console.log("PASS judge config file: selected repository YAML, file-only configuration, exact file snapshot and motivating feedback publication");
    const completionBaseline = setupRegistry.catalog().revisions.find((item) => item.kind === "completion-judge");
    await page.locator("#setupPredecessor").selectOption(completionBaseline.id);
    await until(async () => (await page.locator("#setupEditor").textContent()).includes("Completion judge config file"), "completion config editor rendered");
    assert.equal(await page.locator('#setupPublish [name="model"], #setupPublish [name="exploration"]').count(), 0);
    assert.equal(await page.locator("#setupPromote").count(), 0);
    await page.locator("#judgeConfigFile").selectOption("completion-judge-v2.yaml");
    await until(async () => (await page.locator("#setupEditor").textContent()).includes("completion-judge-v2.yaml"), "v2 completion file selection rendered");
    await page.locator("#setupFeedbackSession").selectOption(task.id);
    await page.locator("#setupFeedbackRecords input").first().check();
    await page.locator("#setupPublish button").click();
    const completionRevision = await until(() => setupRegistry.catalog().revisions.find((item) => item.kind === "completion-judge" && item.predecessorId === completionBaseline.id), "completion config published");
    await until(async () => (await page.locator("#setupPublished").textContent()).includes(completionRevision.id), "completion config publication lifecycle rendered");
    const promotionsBeforeRelease = setupRegistry.catalog().promotions.length;
    await page.locator('#evaluatorReleasePublish [name="name"]').fill("Frozen browser evaluator");
    for (const [name, id] of [["actorRevisionId", revision.id], ["completionJudgeRevisionId", completionRevision.id], ["judgeRevisionId", fileJudge.id]]) {
      await page.locator(`#evaluatorReleasePublish [name="${name}"]`).selectOption(id);
    }
    await page.locator("#evaluatorReleasePublish button").click();
    const evaluatorRelease = await until(() => setupRegistry.catalog().evaluatorReleases.find((item) => item.name === "Frozen browser evaluator"), "evaluator release published");
    assert.equal(setupRegistry.catalog().promotions.length, promotionsBeforeRelease);
    await until(async () => (await page.locator("#evaluatorReleasePublished").textContent()).includes(evaluatorRelease.id), "release publication lifecycle rendered");
    for (const id of ["humanNewTask", "humanAdvanced"]) {
      if (await page.locator(`#${id}`).getAttribute("open") === null) await page.locator(`#${id} > summary`).click();
    }
    await page.locator("#taskMode").selectOption("simulated");
    await page.locator("#evaluatorRelease").selectOption(evaluatorRelease.id);
    assert.equal(await page.locator("#completionJudgeRevision").isDisabled(), true);
    assert.equal(await page.locator("#completionJudgeRevision").inputValue(), completionRevision.id);
    assert.equal(await page.locator("#actorSetupRevision").isDisabled(), true);
    assert.equal(await page.locator("#actorSetupRevision").inputValue(), revision.id);
    await page.locator('#evaluatorReleasePublish [name="name"]').fill("Refresh while release selected");
    for (const [name, id] of [["actorRevisionId", revision.id], ["completionJudgeRevisionId", completionRevision.id], ["judgeRevisionId", fileJudge.id]]) await page.locator(`#evaluatorReleasePublish [name="${name}"]`).selectOption(id);
    await page.locator("#evaluatorReleasePublish button").click();
    await until(() => setupRegistry.catalog().evaluatorReleases.some(item => item.name === "Refresh while release selected"), "catalog refresh while release pinned");
    await until(async () => (await page.locator("#evaluatorReleasePublished").textContent()).includes("Published"), "release refresh publication rendered");
    assert.equal(await page.locator("#evaluatorRelease").inputValue(), evaluatorRelease.id);
    const tasksBeforeRelease = new Set(tasks.list().map(item => item.id));
    await page.locator("#humanCreate button").click();
    const releaseTask = await until(() => {
      const created = tasks.list().find(item => !tasksBeforeRelease.has(item.id));
      return created && ["completed", "interrupted", "failed"].includes(created.status) ? tasks.get(created.id) : null;
    }, "release-selected task completed through actual dashboard form");
    assert.equal(releaseTask.status, "completed", JSON.stringify(releaseTask.events.filter(event => event.kind === "actor_error")));
    await actors.running.get(releaseTask.id)?.done;
    assert.deepEqual(releaseTask.evaluatorRelease, evaluatorRelease);
    assert.deepEqual(releaseTask.actorSetup, revision);
    assert.deepEqual(releaseTask.completionJudgeSetup, completionRevision);
    assert.deepEqual(releaseTask.evaluatorRelease.judgeSetup, fileJudge);
    const releaseExport = await tasks.export(releaseTask.id);
    assert.deepEqual(releaseExport.bundle.session.evaluatorRelease, evaluatorRelease);
    const packets = releaseExport.bundle.session.events.filter(event => event.kind === "actor_completion_evidence");
    assert.equal(packets.length, 1);
    assert.equal(packets[0].inputDigest, setupDigest(await tasks.completionJudgeInput(releaseTask.id, packets[0].id)));
    assert.deepEqual(packets[0].judge, completionRevision.spec);
    assert.equal(packets[0].input.actorFinish.kind, "finish");
    assert.equal(packets[0].evidenceContract, "completion-evidence-v2");
    assert.equal(releaseTask.termination.reason, "satisfied");
    assert.equal(releaseTask.termination.endpointAttainment, "not_claimed");
    assert.equal(releaseTask.events.find(e => e.kind === "actor_completion_judgment").verdict, "uncertain");
    assert.ok(packets[0].input.screenshot, "exact screenshot retained at completion inference seam");
    assert.equal(setupRegistry.catalog().promotions.length, promotionsBeforeRelease);
    assert.equal(setupRegistry.selected("actor").id, revision.id);
    await until(async () => (await page.locator("#humanTaskDetail").textContent()).includes("completed ·"), "release task terminal lifecycle rendered");
    await page.locator("#humanNewTask > summary").click();
    await page.locator("#evaluatorRelease").selectOption("");
    assert.equal(await page.locator("#actorSetupRevision").isDisabled(), false);
    assert.equal(await page.locator("#completionJudgeRevision").isDisabled(), false);
    assert.equal(await page.locator("#completionJudgeRevision").inputValue(), "");
    await page.locator("#completionJudgeRevision").selectOption(completionRevision.id);
    const beforeIndividual = new Set(tasks.list().map(item => item.id));
    await page.locator("#humanCreate button").click();
    const individual = await until(() => {
      const created = tasks.list().find(item => !beforeIndividual.has(item.id));
      return created && ["completed", "interrupted", "failed"].includes(created.status) ? tasks.get(created.id) : null;
    }, "independent completion selection completed through actual form");
    assert.equal(individual.status, "completed");
    assert.equal(individual.evaluatorRelease, undefined);
    assert.deepEqual(individual.completionJudgeSetup, completionRevision);
    const individualExport = await tasks.export(individual.id);
    assert.deepEqual(individualExport.bundle.session.completionJudgeSetup, completionRevision);
    assert.equal(setupRegistry.catalog().promotions.length, promotionsBeforeRelease);
    console.log("PASS independent completion selector: actual form, exact revision/export pin, release locking and unchanged defaults");
    console.log("PASS evaluator release: file-only completion publication, explicit three-revision release, real form submission with frozen run/export pins and exact stopping evidence; unchanged defaults (fixture inference)");
    await page.locator("#calibrationRefresh").click();
    await until(async () => (await page.locator('#calibrationMember [name="source"]').textContent()).includes(task.id), "calibration sources refreshed");
    const originalSource = await page.locator('#calibrationMember [name="source"] option').evaluateAll((options, taskId) => options.find(option => option.textContent.includes(taskId))?.value, task.id);
    assert.ok(originalSource, "original task remains selectable after release run");
    await page.locator('#calibrationMember [name="source"]').selectOption(originalSource);
    const anchor = task.events.find((event) => event.kind === "actor_action").id;
    await page.locator('#calibrationMember [name="subject"]').selectOption(anchor);
    await page.locator('#calibrationMember [name="value"]').fill("2");
    await page.locator('#calibrationMember [name="comment"]').fill("Independent human realism label on recorded behavior");
    await page.locator("#calibrationMember button[type=submit], #calibrationMember button:not([type])").click();
    await page.locator('#calibrationFreeze [name="name"]').fill("Frozen browser calibration");
    await page.locator("#calibrationFreeze button").click();
    const set = await until(() => calibration.catalog().sets[0], "frozen set saved from dashboard");
    assert.equal(set.members[0].membership, "tuning");
    assert.equal(set.members[0].labels[0].scale, "human-actor-realism-1-4");
    await page.locator('#calibrationCompare [name="candidateRevisionId"]').selectOption(revision.id);
    await page.locator("#calibrationCompare button").click();
    const comparison = await until(() => calibration.catalog().comparisons[0], "comparison created on exact frozen set");
    await page.locator('#calibrationObservation [name="revisionId"]').selectOption(baseline.id);
    await page.locator('#calibrationObservation [name="taskId"]').fill(task.id);
    await page.locator('#calibrationObservation [name="value"]').fill("2");
    await page.locator('#calibrationObservation [name="comment"]').fill("Baseline realism reviewed separately from satisfaction");
    await page.locator("#calibrationObservation button:not([type])").click();
    await until(() => calibration.report(comparison.id).rows[0].baseline?.score === 2, "baseline human realism recorded");
    decision = 0;
    await page.locator('#calibrationObservation [name="revisionId"]').selectOption(revision.id);
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#calibrationRunArm").click();
    const revised = await until(() => { const latest = tasks.list()[0]; return latest.id !== task.id && latest.id !== releaseTask.id && latest.status === "completed" ? tasks.get(latest.id) : null; }, "selected actor revision completed in real workspace");
    assert.equal(revised.actorSetup.id, revision.id);
    assert.ok(revised.events.find((event) => event.kind === "actor_started").prompt.includes("Keep replies brief."));
    await page.locator("#calibrationComparison").selectOption(comparison.id);
    await page.locator('#calibrationObservation [name="revisionId"]').selectOption(revision.id);
    await page.locator('#calibrationObservation [name="taskId"]').fill(revised.id);
    await page.locator('#calibrationObservation [name="value"]').fill("3");
    await page.locator('#calibrationObservation [name="comment"]').fill("Candidate realism rated by a human independently");
    await page.locator("#calibrationObservation button:not([type])").click();
    await until(() => calibration.report(comparison.id).status === "completed", "recorded realism comparison complete");
    const report = calibration.report(comparison.id);
    assert.equal(report.comparison.dimension, "actor-realism");
    assert.equal(report.rows[0].candidate.score, 3);
    assert.equal(report.rows[0].candidate.agreesWithHuman, undefined);
    const calibrationBundle = await calibration.export();
    assert.deepEqual(calibrationBundle.sets[0], set);
    assert.equal(calibrationBundle.observations.length, 2);
    const reopenedCalibration = await new CalibrationService({ stateFile: join(data, "actor-calibration.json"), setups: setupRegistry, tasks, evalService: service }).open();
    assert.deepEqual(reopenedCalibration.report(comparison.id), report);
    if (process.env.RELAYER_EVAL_CALIBRATION_SCREENSHOT) { await page.locator("#calibrationReport").scrollIntoViewIfNeeded(); await page.screenshot({ path: process.env.RELAYER_EVAL_CALIBRATION_SCREENSHOT }); }
    console.log("PASS calibration: frozen native human label/evidence, tuning membership, pinned actor comparison, real second selected-revision run, independent human scores, export/reopen");
  } finally { await actors.close(); await page.close(); }
  console.log("PASS task actor: dashboard configuration, production screenshots/node selection/composer/Send/invoke, three-completion admission, active read-only human grading isolated from actor, export (fixture inference)");
}

async function productJson(session, path, options = {}) {
  const response = await fetch(new URL(path, session.origin), { ...options,
    headers: { Cookie: `${session.cookie.name}=${session.cookie.value}`, "Content-Type": "application/json" },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  const value = text ? JSON.parse(text) : null; assert.ok(response.ok, JSON.stringify(value)); return value;
}

async function proveHumanTask({ browser, service, productSession, data }) {
  const localResources = [];
  const registerAnnotations = (session, scope) => productJson(session, "/api/internal/annotation-sessions", {
    method: "POST", body: { ...scope, authorId: "browser-proof", authorDisplayName: "Browser proof" },
  });
  let tasks;
  const setupRegistry = await new SetupRegistry({ stateFile: join(data, "human-setups.json"), feedbackLoader: (ref) => tasks.feedbackReference(ref) }).open();
  tasks = await new HumanTaskService({ stateFile: join(data, "human-tasks.json"), evalService: service, productSession,
    annotationSnapshotLoader: (threadIds) => loadAtomicAnnotationSnapshots({ session: productSession, threadIds,
      token: randomBytes(32).toString("hex"), authorId: "browser-proof", authorDisplayName: "Browser proof" }),
  }).open();
  const surfaceUrl = async (pending) => { const surface = await pending; localResources.push(surface); return surface.url; };
  const calibration = await new CalibrationService({ stateFile: join(data, "human-calibration.json"), setups: setupRegistry, tasks, evalService: service, author: tasks.annotator }).open();
  const host = await createEvalDashboard({ service, humanTasks: tasks, setupRegistry, calibration, rendererDirectory: resolve("desktop/eval-renderer"),
    openHumanTask: (sessionId) => surfaceUrl(createHumanTaskSurface({ tasks, sessionId, productSession, registerAnnotations })),
    reviewHumanTask: (sessionId) => surfaceUrl(openHumanReview({ executionId: sessionId,
      productSession: async () => productSession, registerAnnotations, assertRunning: () => {},
      humanGrading: { task: () => tasks.get(sessionId), grade: (input) => tasks.grade(sessionId, input), annotate: (input) => tasks.annotate(sessionId, input) },
      reviewContext: () => { const task = tasks.get(sessionId); return { readOnly: true, selectedExecutionId: sessionId,
        harnessConfigurationName: task.prepared.execution.harnessConfigurationName,
        cases: [{ executionId: sessionId, name: task.prepared.name, status: task.status, threadIds: task.threadIds,
          threads: task.threadIds.map((id, index) => ({ id, name: task.prepared.plan[index]?.name || `Step ${index + 1}` })) }] }; },
    })),
  });
  localResources.push(host);
  const dashboard = await browser.newPage();
  localResources.push(dashboard);
  const pageErrors = [];
  dashboard.on("pageerror", (error) => pageErrors.push(error.message));
  await dashboard.goto(host.url);
  // Keep a completed run polling while Human Grader is open, as in the child host.
  const run = await service.createRun(selection);
  const sharedRun = await until(() => { const value = service.getRun(run.id); return ["passed", "failed", "error", "interrupted"].includes(value.status) ? value : null; }, "shared dashboard completed run").catch((error) => { console.error(JSON.stringify(service.getRun(run.id))); throw error; });
  assert.equal(sharedRun.status, "passed", JSON.stringify(sharedRun));
  try {
    // Human task slice: the production composer remains writable under separate
    // scope; evidence is captured without paid inference or an alternate renderer.
    await dashboard.locator("#newRun").click();
    assert.equal(await dashboard.locator('#caseOptions input[value="fixture.external-human"]').isDisabled(), true);
    await dashboard.locator("#humanGrader").click();
    assert.equal(await dashboard.locator('#humanCase option[value="empty-project.task-system.two-turn"]').count(), 0);
    assert.equal(await dashboard.locator("#humanHarness").isVisible(), false);
    assert.equal(await dashboard.locator("#calibrationEditor").isVisible(), false);
    await dashboard.locator("#humanCase").selectOption("fixture.external-human");
    await dashboard.locator("#humanAdvanced > summary").click();
    await dashboard.locator("#humanHarness").selectOption("fixture-task-system");
    await dashboard.locator('[name="maxCompletions"]').fill("2");
    assert.equal(await dashboard.locator("#humanEndpoint").inputValue(), "An explained task system and a refined response");
    await dashboard.locator('[name="subscriptionConfirmed"]').check();
    await dashboard.locator("#humanCreate button").click();
    await dashboard.locator("#humanOpen").waitFor();
    assert.equal(await dashboard.locator("#humanCreate").isVisible(), false);
    const humanId = (await rpc(host.url, "humanTasks"))[0].id;
    assert.equal(tasks.get(humanId).prepared.humanBrief, "PRIVATE_BROWSER_PERSONA");
    assert.equal(tasks.get(humanId).prepared.execution.catalogIdentity.commit, "browser-fixture");
    // A completed matrix run continues polling while Human Grader is open.
    // Wait for an actual poll, rather than assuming a timer fired.
    await dashboard.waitForResponse((response) => response.url().endsWith("/eval-api/listRuns"));
    assert.equal(await dashboard.locator("#humanView").isVisible(), true);
    const taskPopup = dashboard.context().waitForEvent("page");
    await dashboard.locator("#humanOpen").click();
    const humanPage = await taskPopup;
    humanPage.on("pageerror", (error) => pageErrors.push(error.message));
    await humanPage.waitForLoadState();
    await until(async () => (await rpc(host.url, "humanTask", [humanId])).events.some((event) => event.kind === "presentation" && event.snapshot.graphVisible), "human first visible graph").catch(async (error) => { console.error(JSON.stringify(tasks.get(humanId)), await dashboard.locator("body").innerText()); throw error; });
    assert.equal(await humanPage.evaluate(() => Boolean(window.relayerEvalReview)), false);
    assert.equal(await humanPage.evaluate(async () => (await (await fetch("/api/capabilities")).json()).annotations), true);
    const pinnedModel = (await rpc(host.url, "humanTask", [humanId])).prepared.execution.modelResolution.selectedModel;
    assert.equal(pinnedModel.providerId, "codex");
    const modelValidation = await humanPage.evaluate(async (selection) => {
      const response = await fetch("/api/model-selection/validate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ harnessId: "fixture-task-system", ...selection }) });
      return { status: response.status, body: await response.json() };
    }, { familyId: pinnedModel.familyId });
    assert.equal(modelValidation.status, 200, "validation must reach the product resolver with scoped control authority: " + JSON.stringify(modelValidation));
    await humanPage.locator(".graph-node").first().click();
    await humanPage.locator("#annotationComment").fill("This node helped me understand the task.");
    await humanPage.locator("#submitAnnotation").click();
    await until(async () => (await humanPage.locator("#annotationList").textContent()).includes("This node helped me understand the task."), "native live node annotation saved");

    await humanPage.evaluate(() => window.relayerHumanTask.workspaceLayout.set(0.64));
    const reopenedTask = await browser.newPage();
    await reopenedTask.goto(await rpc(host.url, "openHumanTask", [humanId]));
    assert.notEqual(new URL(reopenedTask.url()).origin, new URL(humanPage.url()).origin);
    await until(async () => (await reopenedTask.locator("#workspaceDivider").getAttribute("aria-valuenow")) === "64", "live task split restored across origins");
    assert.equal(await reopenedTask.evaluate(() => Boolean(window.relayerEvalReview)), false);
    await reopenedTask.locator(".graph-node").first().click();
    await until(async () => (await reopenedTask.locator("#annotationList").textContent()).includes("This node helped me understand the task."), "native node annotation restored in new live workspace");
    await reopenedTask.close();

    for (const surface of [humanPage]) {
      assert.deepEqual(await surface.evaluate(async () => Promise.all([
        fetch("/api/model-settings/defaults", { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" }).then((response) => response.status),
        fetch("/eval-api/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: "[]" }).then((response) => response.status),
      ])), [403, 404], "task and review authority cannot change provider/model setup");
    }
    await humanPage.locator("#threadPrompt").fill("Explain how the workers coordinate.");
    try { await humanPage.locator("#sendInteraction:not([disabled])").click(); }
    catch (error) { console.error(await humanPage.locator("#sendInteraction").evaluate((element) => element.outerHTML)); throw error; }
    await until(async () => {
      const task = await rpc(host.url, "humanTask", [humanId]);
      return task.events.some((event) => event.kind === "presentation" && event.snapshot.completionStatus === "accepted" && String(event.snapshot.turnId) !== String(task.events.find((item) => item.kind === "thread_started").interactionId));
    }, "human follow-up accepted and observed");
    await humanPage.locator("#humanTaskGrading summary").click();
    await humanPage.locator('#humanTaskGrading [name="satisfaction"]').selectOption("3");
    await humanPage.locator('#humanTaskGrading [data-session-grade] [name="comment"]').fill("The follow-up helped.");
    await humanPage.getByRole("button", { name: "Save grade", exact: true }).click();
    await until(async () => (await humanPage.locator("[data-grade-status]").textContent()).includes("Grade saved"), "nonterminal grade saved");
    assert.equal((await rpc(host.url, "humanTask", [humanId])).status, "active");
    const liveMoment = (await rpc(host.url, "humanTask", [humanId])).events.find(event => event.kind === "presentation");
    await humanPage.locator('#humanTaskGrading [name="eventId"]').selectOption(liveMoment.id);
    await humanPage.locator('#humanTaskGrading form:not([data-session-grade]) [name="comment"]').fill("Live feedback");
    await humanPage.getByRole("button", { name: "Save moment annotation", exact: true }).click();
    await until(async () => (await humanPage.locator("[data-grade-status]").textContent()).includes("Moment annotation saved"), "live annotation saved");
    assert.equal((await rpc(host.url, "humanTask", [humanId])).status, "active");
    await humanPage.locator('#humanTaskGrading [name="reason"]').selectOption("endpoint_reached");
    await humanPage.getByRole("button", { name: "Finish task", exact: true }).click();
    await until(async () => (await humanPage.locator("[data-grade-status]").textContent()).includes("Task finished"), "workspace task finished");
    await until(async () => (await dashboard.locator("#humanOpen").textContent()).includes("Open graph review"), "dashboard switches to graph review after workspace finish");
    assert.equal(await dashboard.locator("#humanFinish").count(), 0);
    const humanFinished = await rpc(host.url, "humanTask", [humanId]);
    assert.equal(humanFinished.satisfaction.value, 3);
    assert.equal(humanFinished.satisfaction.comment, "The follow-up helped.");
    assert.equal(humanFinished.completions, 2);
    assert.equal(humanFinished.termination.success, null);
    assert.equal(humanFinished.responseTimings.length, 2);
    assert.equal(humanFinished.responseTimings[1].observerPresentBeforeSubmission, true);
    const humanMoment = humanFinished.events.find((event) => event.kind === "presentation" && event.snapshot.graphVisible);
    await humanPage.locator('#humanTaskGrading [name="eventId"]').selectOption(humanMoment.id);
    await humanPage.locator('#humanTaskGrading form:not([data-session-grade]) [name="comment"]').fill("First useful map.");
    await humanPage.getByRole("button", { name: "Save moment annotation", exact: true }).click();
    await until(async () => (await humanPage.locator("[data-grade-status]").textContent())  .includes("Moment annotation saved"), "workspace annotation saved");
    const humanReviewUrl = await rpc(host.url, "reviewHumanTask", [humanId]);
    const humanReview = await browser.newPage(); await humanReview.goto(humanReviewUrl);
    await humanReview.waitForFunction(() => Boolean(window.__evalPresentation?.snapshot()?.turnId));
    await humanReview.locator("#humanTaskGrading summary").first().click();
    await humanReview.locator('#humanTaskGrading [data-session-grade] [name="comment"]').fill("Reviewed inside the graph review page.");
    await humanReview.getByRole("button", { name: "Refresh session status", exact: true }).click();
    await until(async () => (await humanReview.locator("[data-grade-status]").textContent()) === "Session completed.", "review status refreshed");
    assert.equal(await humanReview.locator('#humanTaskGrading [data-session-grade] [name="comment"]').inputValue(), "Reviewed inside the graph review page.");
    await humanReview.route("**/eval-api/grade", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary grading failure" }) }));
    await humanReview.getByRole("button", { name: "Save grade", exact: true }).click();
    await until(async () => (await humanReview.locator("[data-grade-status]").textContent()) === "Temporary grading failure", "review save failure visible");
    assert.equal(await humanReview.locator('#humanTaskGrading [data-session-grade] [name="comment"]').inputValue(), "Reviewed inside the graph review page.");
    await humanReview.unroute("**/eval-api/grade");
    await humanReview.getByRole("button", { name: "Save grade", exact: true }).click();
    await until(async () => (await humanReview.locator("[data-grade-status]").textContent()).includes("Grade saved"), "archived graph review grade saved");
    assert.equal((await rpc(host.url, "humanTask", [humanId])).satisfaction.comment, "Reviewed inside the graph review page.");
    assert.equal(await humanReview.getByRole("button", { name: "Finish task", exact: true }).count(), 0);

    assert.equal(await humanReview.evaluate(async (threadId) => (await fetch(`/api/threads/${threadId}/interactions`, { method: "POST", body: '{}' })).status, humanFinished.threadIds[0]), 403);
    const humanExport = await rpc(host.url, "exportHumanTask", [humanId]);
    assert.equal(humanExport.bundle.session.annotations.at(-1).comment, "First useful map.");
    assert.equal(humanExport.bundle.session.conversations.length, 1);
    const graphAnnotation = humanExport.bundle.graphAnnotations.threads.flatMap(({ annotations }) => annotations)
      .find(({ revisions }) => revisions.some(({ comment }) => comment === "This node helped me understand the task."));
    assert.equal(graphAnnotation?.anchor.kind, "node", "native node feedback remains in immutable human-task export");
    assert.ok(humanExport.sha256.startsWith("sha256:"));
    if (process.env.RELAYER_HUMAN_TASK_SCREENSHOT) {
      await dashboard.locator("#humanRefresh").click();
      await dashboard.locator("#humanExport").waitFor();
      await humanReview.screenshot({ path: process.env.RELAYER_HUMAN_TASK_SCREENSHOT, fullPage: true });
    }
    const discoveryTask = await rpc(host.url, "createHumanTask", [{ testCaseId: "interactive.planning.group-europe-trip", harnessConfigurationName: "fixture-task-system", maxCompletions: 3, endpoint: "An agreed itinerary" }]);
    const discoveryUrl = await rpc(host.url, "openHumanTask", [discoveryTask.id]);
    const discoveryPage = await browser.newPage();
    await discoveryPage.goto(discoveryUrl);
    await discoveryPage.locator("#humanTaskGrading summary").first().click();
    await discoveryPage.getByText("Private user brief · not sent to Relayer", { exact: true }).click();
    assert.ok((await discoveryPage.locator("#humanTaskGrading").innerText()).includes("$4,500"));
    assert.equal(await discoveryPage.getByRole("button", { name: "Finish task", exact: true }).isVisible(), true);
    await discoveryPage.close();
    console.log("PASS human task: live composer, recorded graph, two completions, finish, read-only review, annotation and export");

    assert.deepEqual(pageErrors, []);
    const state = await productJson(productSession, `/api/state?threadId=${humanFinished.threadIds[0]}`);
    assert.equal(state.conversationCompatibility.status, "compatible");
    assert.equal(state.conversationCompatibility.providerId, "codex");
    assert.equal(state.interactions.length, 2);
    for (const turn of state.interactions) {
      assert.equal(turn.latestAttempt.outcome, "accepted");
      assert.equal(turn.latestAttempt.modelSelection.providerId, "codex");
      assert.equal(turn.latestAttempt.modelSelection.modelId, "fixture-model");
      assert.ok(turn.latestAttempt.attemptAdmissionId, "each fixture turn has a real admitted execution receipt");
    }
    return { id: humanId, threadId: humanFinished.threadIds[0] };
  } finally { for (const resource of localResources.reverse()) await resource.close(); }
}

async function proveTaskActorInputs({ browser, service, productSession, data }) {
  const tasks = await new HumanTaskService({ stateFile: join(data, "actor-input-tasks.json"), evalService: service, productSession }).open();
  let stage = 0;
  const actors = new TaskActorService({ tasks, resolveRuntime: async () => ({}),
    resolveCompletionJudgeRuntime: async () => ({}),
    createCompletionJudge: async () => ({ close: async () => {}, evaluate: async () => ({ verdict: "complete", evidenceExplanation: "Fixture input was incorporated.", continuationHint: "", usage: null }) }),
    openBrowser: (sessionId, signal) => openTaskActorBrowser({ tasks, sessionId, productSession, browser, signal }),
    createActor: async () => ({ close: async () => {}, decide: async ({ controls }) => {
      const action = { kind: "scroll", ref: "", value: "down", reason: "", satisfaction: null, comment: "", endpointStatus: "incomplete", remainingWork: "Further choices remain." };
      const note = controls.find((control) => control.name === "Review note" && control.role === "input");
      if (stage === 0 && note) { Object.assign(action, { kind: "fill", ref: note.ref, value: "A note entered through the graph" }); stage++; }
      else if (stage === 1) {
        const composer = controls.find((control) => control.role === "textarea");
        assert.ok(composer, "Visible composer after node input");
        Object.assign(action, { kind: "fill", ref: composer.ref, value: "Use my review note to refine this." }); stage++;
      } else if (stage === 2) {
        const send = controls.find((control) => ["Send", "↑"].includes(control.name)); assert.ok(send, "Send enabled after input commitment");
        Object.assign(action, { kind: "click", ref: send.ref }); stage++;
      } else if (stage === 3) { Object.assign(action, { kind: "finish", reason: "satisfied", satisfaction: 3 }); stage++; }
      return { action, usage: null };
    } }),
  });
  resources.push(actors);
  const task = await actors.create({ testCaseId: "empty-project.visual-node-detail.single-turn", harnessConfigurationName: "fixture-node-detail", maxCompletions: 2, endpoint: "A refined visual answer", actor: { maxActions: 25 } });
  await actors.running.get(task.id).done;
  const finished = tasks.get(task.id);
  assert.equal(finished.status, "completed", JSON.stringify(finished.events.filter((event) => event.kind === "actor_error")));
  assert.equal(stage, 4, "Actor reached and committed the authored input");
  assert.equal(finished.completions, 2, "Drafting does not spend a completion");
  assert.ok(finished.events.some((event) => event.kind === "product_action" && event.path.endsWith("/input-draft/attachments") && event.outcome === "accepted"));
  assert.ok(finished.conversations.some((conversation) => conversation.jsonl.includes("A note entered through the graph")));
  console.log("PASS actor input: visible authored input, draft commit and composer Send through real product routes with preserved answer evidence");
}
