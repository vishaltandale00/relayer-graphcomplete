/** Opt-in, one-pass live agent behavior baseline. Never run from npm run check. */
import { app, BrowserWindow, ipcMain } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createManagedRuntimeInstaller } from "../desktop/main/managed-runtimes/installer.mjs";
import { CodexCredentialAdapter } from "../desktop/main/credentials/codex-credential-adapter.mjs";
import { CodexModelCatalogAdapter } from "../desktop/main/models/codex-model-catalog-adapter.mjs";
import { productionProviderAdapterRegistry } from "../desktop/main/providers/provider-adapter-registry.mjs";
import { createHarnessReadinessCoordinator } from "../desktop/main/services/harness-readiness.mjs";
import { GraphCompleteRuntimeService, RECURSIVE_TEMPORAL_FEATURES } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { createWindowFactory } from "../desktop/main/window.mjs";
import { registerWorkspaceLayoutIpc, registerProjectSidebarIpc, registerLayerSelectionIpc } from "../desktop/main/ipc/register-ipc.mjs";
import { exportTraceEvidence } from "./recursive-live-run-trace.mjs";
import { productRequest } from "./recursive-live-run-transport.mjs";
import { createElectronWorkspaceDriver } from "./electron-workspace-driver.mjs";
import { workspaceProvenance, executableProvenance } from "./recursive-live-run-provenance.mjs";

const option = (name) => process.argv[process.argv.indexOf(name) + 1];
const setupOnly = process.argv.includes("--setup-only");
const record = process.argv.includes("--record");
const selectedCase = process.argv.includes("--case") ? Number(option("--case")) : undefined;
const cap = Number(option("--cost-cap-usd"));
if (process.env.RELAYER_INVOKE_BEHAVIOR_LIVE !== "1" || !Number.isFinite(cap) || cap <= 0) {
  console.error("Explicit RELAYER_INVOKE_BEHAVIOR_LIVE=1 and positive --cost-cap-usd are required.");
  app.exit(1);
  process.exit(1);
}
const repository = resolve(import.meta.dirname, "..");
const dataDirectory = await mkdtemp(join(tmpdir(), "relayer-invoke-live-"));
const evidence = join(dataDirectory, "evidence");
await mkdir(evidence, { recursive: true });
await mkdir(join(dataDirectory, "electron-profile"), { recursive: true });
app.setPath("userData", join(dataDirectory, "electron-profile"));
const model = "gpt-6-luna";
const harness = "codex-basic";
const facts = "Use only these supplied scenario facts, without browsing: Kyoto has temples, gardens, and a five-day local budget of $900. Lisbon has coastal walks, museums, and a five-day local budget of $650. Flights and accommodation are excluded. These are fictional test facts, not travel advice.";
const cases = [
  { id: 1, title: "One-call Kyoto analysis", prompt: "I’m considering Kyoto for a vacation. Show a short overview and an ‘Analyze this trip’ button. Wait until I click it before doing the detailed analysis.", count: 1, reusable: false },
  { id: 2, title: "Reusable destination comparison", prompt: "Help me compare vacation destinations. Give me a destination field and an ‘Analyze destination’ button so I can try several places. Keep an overall comparison updated as each analysis finishes.", count: 1, reusable: true, destinations: ["Lisbon", "Kyoto"] },
  { id: 4, title: "Separate budget and itinerary calls", prompt: "Help me evaluate a Kyoto trip. Show an overview with separate buttons to analyze the budget and build a five-day itinerary. Don’t do either detailed task until I request it.", count: 2, reusable: false },
];
if (selectedCase !== undefined && !cases.some(({ id }) => id === selectedCase)) throw new Error("Unknown live case");
const receipt = { schemaVersion: 1, model, reasoningEffort: "medium", harness, costCapUsd: cap,
  budgetGuarantee: "target, not provider billing cutoff", paidJudge: false, attemptsPerCase: 1,
  facts, dataDirectory, cases: [], inferenceStarted: false, humanVerdict: "pending", errors: [] };
receipt.budget = { observedEstimateUsd: 0, usageKnown: true, inputUsdPerMillion: 0.10, outputUsdPerMillion: 0.50, cachedDiscountApplied: false,
  priceSource: "https://developers.openai.com/api/docs/models/gpt-6-luna", estimateOnly: true, providerBilling: "not available" };
let runtime, product, session, window, closing = false;
let recordingTimer, capturing = false, captureError;
const frames = [];
const encodeVideo = promisify(execFile);
const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
const request = (path, options = {}) => productRequest(session, path, { ...options, signal: AbortSignal.timeout(20_000) });
const driver = createElectronWorkspaceDriver({ getWindow: () => window, getProductSession: () => session });
async function saveReceipt() { await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2)); }

async function recordFrame() {
  if (capturing || !window || window.isDestroyed()) return;
  capturing = true;
  try {
    const path = join(evidence, `live-frame-${String(frames.length + 1).padStart(5, "0")}.png`);
    const bytes = (await window.webContents.capturePage()).toPNG();
    await writeFile(path, bytes);
    frames.push({ path, capturedAt: Date.now(), sha256: createHash("sha256").update(bytes).digest("hex") });
  } finally { capturing = false; }
}

async function finishRecording() {
  if (!record) return;
  clearInterval(recordingTimer);
  while (capturing) await sleep(25);
  await recordFrame();
  if (captureError) throw captureError;
  const path = join(evidence, "live-input-invoke.mp4");
  const elapsed = Math.max(1, (frames.at(-1).capturedAt - frames[0].capturedAt) / 1000);
  await encodeVideo("/opt/homebrew/bin/ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-framerate", String((frames.length - 1) / elapsed), "-i",
    join(evidence, "live-frame-%05d.png"), "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path]);
  receipt.recording = { path, sha256: createHash("sha256").update(await readFile(path)).digest("hex"), frames,
    capture: "Continuous live Product webContents captures; UI controls automated; real model inference, not fixture", elapsedSeconds: elapsed };
  await saveReceipt();
  console.log(`LIVE_VIDEO_READY ${JSON.stringify({ path, elapsedSeconds: elapsed })}`);
}

async function stopOutstanding(threadId) {
  const detail = await request(`/api/threads/${threadId}`);
  const pending = detail.interactions.filter((interaction) => !["accepted", "failed", "stopped"].includes(interaction.completionStatus));
  for (const interaction of pending) await request(`/api/threads/${threadId}/interactions/${interaction.id}/stop`, { method: "POST" });
  const deadline = Date.now() + 15_000;
  while (pending.length) {
    const current = await request(`/api/threads/${threadId}`);
    if (current.interactions.every((interaction) => ["accepted", "failed", "stopped"].includes(interaction.completionStatus))) return;
    if (Date.now() >= deadline) throw new Error("Stop did not settle; remaining paid cases must not run.");
    await sleep(250);
  }
}

function reviewIpc() {
  let preferences = {}, drafts = {};
  const settings = { async read() { return preferences; }, async update(transform) { return preferences = transform(preferences); } };
  registerWorkspaceLayoutIpc({ ipcMain, settings });
  registerProjectSidebarIpc({ ipcMain, settings });
  registerLayerSelectionIpc({ ipcMain, settings });
  ipcMain.handle("relayer:account-read", () => ({ status: "signed-in", channel: "stable", subject: "local|invoke-review" }));
  ipcMain.handle("relayer:provider-status", () => ({ adapters: [], definitions: [], hasCompletedOnboarding: true }));
  ipcMain.handle("relayer:appearance-read", () => ({ appearance: "dark" }));
  ipcMain.handle("relayer:tutorial-read", () => ({ status: "dismissed", automaticEligible: false }));
  ipcMain.handle("relayer:update-status", () => ({ phase: "development", channel: "stable", version: "live-review" }));
  ipcMain.handle("relayer:share-pending", () => null);
  ipcMain.handle("relayer:composer-drafts-read", () => drafts);
  ipcMain.handle("relayer:composer-drafts-write", (_event, value) => drafts = value);
  ipcMain.handle("relayer:folder-choose", () => null);
}

async function settled(threadId, interactionId) {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const detail = await request(`/api/threads/${threadId}`);
    const interaction = detail.interactions.find((candidate) => candidate.id === interactionId);
    if (interaction && ["accepted", "failed", "stopped"].includes(interaction.completionStatus)) return { detail, interaction };
    if (Date.now() >= deadline) {
      await stopOutstanding(threadId);
      throw new Error(`Interaction ${interactionId} exceeded the 180-second stop threshold; no retry.`);
    }
    await sleep(500);
  }
}

async function closure(threadId, parent) {
  const queue = [parent.completionOutput.rootLayer], layers = [], seen = new Set();
  while (queue.length) {
    const layer = queue.shift();
    if (seen.has(layer.layer.id)) continue;
    seen.add(layer.layer.id); layers.push(layer);
    for (const action of layer.actions ?? []) {
      if (action.kind === "navigate" && action.targetLayerId != null && !seen.has(action.targetLayerId)) {
        queue.push(await request(`/api/threads/${threadId}/interactions/${parent.id}/layers/${action.targetLayerId}`));
      }
    }
    if (seen.size > 100) throw new Error("Authored closure exceeded inspection limit");
  }
  return layers;
}

async function screenshot(threadId, parent, node, name) {
  await window.loadURL(`${session.origin}/?threadId=${threadId}&interactionId=${parent.id}`);
  await driver.waitFor("authored graph ready", () => driver.evaluate("Boolean(document.querySelector('.graph-node b'))"));
  if (node) await driver.clickNode(node.title);
  await sleep(300);
  const path = join(evidence, `${name}.png`);
  const bytes = (await window.webContents.capturePage()).toPNG();
  await writeFile(path, bytes);
  return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function capture(result, threadId, parent, node, name) {
  try { result.screenshots.push(await screenshot(threadId, parent, node, name)); }
  catch (error) { (result.presentationErrors ??= []).push(error.message); }
}

async function archive(threadId, name) {
  const response = await fetch(`${session.origin}/api/threads/${threadId}/export`, { signal: AbortSignal.timeout(20_000), headers: { Cookie: `${session.cookie.name}=${session.cookie.value}` } });
  if (!response.ok) throw new Error(`Local export failed (${response.status})`);
  const path = join(evidence, `${name}.jsonl`);
  await writeFile(path, await response.text());
  return path;
}

async function accountUsage(result, definition) {
  const byThread = new Map();
  let everyTraceHasUsage = Boolean(result.traces?.length);
  for (const trace of result.traces ?? []) {
    let observed = false;
    const lines = (await readFile(join(evidence, `case-${definition.id}-traces`, String(trace.productInteractionId), "events.jsonl"), "utf8")).trim().split("\n").filter(Boolean);
    for (const line of lines) {
      const event = JSON.parse(line);
      if (event.type !== "provider.event" || event.data?.method !== "thread/tokenUsage/updated") continue;
      const params = event.data.params;
      const usage = params?.tokenUsage?.total;
      if (Number.isFinite(usage?.inputTokens) && Number.isFinite(usage?.outputTokens)) {
        observed = true;
        byThread.set(params.threadId ?? trace.productInteractionId, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
      }
    }
    everyTraceHasUsage &&= observed;
  }
  result.usage = [...byThread.values()];
  if (!everyTraceHasUsage) { receipt.budget.usageKnown = false; return; }
  result.estimatedUsd = result.usage.reduce((sum, usage) => sum + (usage.inputTokens * 0.10 + usage.outputTokens * 0.50) / 1_000_000, 0);
  receipt.budget.observedEstimateUsd += result.estimatedUsd;
}

async function runCase(definition, family) {
  if (!receipt.budget.usageKnown || receipt.budget.observedEstimateUsd >= cap) throw new Error("No further paid case: usage is unavailable or the observed budget target was reached.");
  if (workspaceProvenance(repository).workspaceDigest !== receipt.source.workspaceDigest) throw new Error("Source changed after baseline freeze; no further paid case will run.");
  const result = { ...definition, creationRequestId: randomUUID(), status: "running", steps: [], checkpoints: [], screenshots: [] };
  receipt.cases.push(result); await saveReceipt();
  console.log(`LIVE_CASE_START ${definition.id}`);
  try {
    receipt.inferenceStarted = true; await saveReceipt();
    const thread = await request("/api/threads", { method: "POST", body: JSON.stringify({
      title: definition.title, initialMessage: `${definition.prompt}\n\n${facts}`,
      creationRequestId: result.creationRequestId,
      harnessId: harness, permissionProfileId: "auto", modelSelection: { familyId: family.id, providerId: "codex", modelId: model },
    }) });
    result.threadId = thread.id;
    await window.loadURL(`${session.origin}/?threadId=${thread.id}&interactionId=${thread.rootInteractionId}`);
    let { detail, interaction: parent } = await settled(thread.id, thread.rootInteractionId);
    await writeFile(join(evidence, `case-${definition.id}-initial.json`), JSON.stringify(detail, null, 2));
    if (parent.completionStatus !== "accepted") throw new Error(`Initial agent response ${parent.completionStatus}: ${parent.completionError ?? ""}`);
    const layers = await closure(thread.id, parent);
    const invokes = [...new Map(layers.flatMap((layer) => (layer.actions ?? []).filter((action) => action.kind === "invoke").map((action) => [action.id, action]))).values()];
    result.checkpoints.push({ kind: "authored-invokes", expected: definition.count, actual: invokes.length, policies: invokes.map((action) => ({ id: action.id, reusable: action.reusable })) });
    if (detail.interactions.length !== 1) throw new Error("Agent executed deferred work before human activation");
    if (invokes.length !== definition.count || invokes.some((action) => action.reusable !== definition.reusable)) throw new Error("Authored Invoke count or reuse policy did not match the user request");
    const targets = definition.destinations ? definition.destinations.map((destination) => ({ action: invokes[0], destination })) : invokes.map((action) => ({ action }));
    for (const [index, target] of targets.entries()) {
      const layer = layers.find((candidate) => candidate.actions.some((action) => action.id === target.action.id));
      const node = layer.nodes.find((candidate) => candidate.id === target.action.sourceNodeId);
      await capture(result, thread.id, parent, node, `case-${definition.id}-before-${index}`);
      let revision;
      if (target.destination) {
        const bindings = target.action.inputActionIds ?? [];
        if (bindings.length !== 1) throw new Error("Reusable destination action must bind one exact input");
        const input = layers.flatMap((candidate) => candidate.actions).find((action) => action.id === bindings[0] && action.kind === "input" && action.sourceNodeId === node.id);
        if (!input || (input.input ?? input).control !== "text") throw new Error("Connected destination input is unavailable");
        const draft = await request(`/api/threads/${thread.id}/input-draft`);
        const inputMount = node.authoredDetail?.mounts?.find((mount) => mount.kind === "capability" && mount.capability.kind === "input" && mount.capability.action.clientKey === input.clientKey);
        const committed = await driver.evaluate(`(() => {
          const shadow = document.querySelector('[data-node-detail-runtime]')?.shadowRoot;
          const field = document.querySelector('#inspector [data-review-action-id="${input.id}"] .node-input-text')
            || (${JSON.stringify(inputMount?.id ?? null)} && shadow?.querySelector('[data-gc-mount="' + ${JSON.stringify(inputMount?.id ?? "")} + '"]'));
          if (!field) throw new Error('Connected destination control is not mounted');
          field.value = ${JSON.stringify(target.destination)};
          field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(target.destination)} }));
          return field.getRootNode() instanceof ShadowRoot ? 'compiled' : 'plain';
        })()`);
        if (!committed) throw new Error("Could not enter destination");
        await sleep(1000);
        if (committed === "compiled") {
          await driver.evaluate(`document.querySelector('[data-node-detail-runtime]').shadowRoot.querySelector('[data-gc-mount="' + ${JSON.stringify(inputMount.id)} + '"]').dispatchEvent(new Event('change', { bubbles: true }))`);
        } else await driver.click(`#inspector [data-review-action-id="${input.id}"] [data-input-control-role="commit"]`);
        revision = await driver.waitFor("destination confirmed", async () => {
          const current = await request(`/api/threads/${thread.id}/input-draft`);
          return current.revision > draft.revision && current.attachments.some((attachment) => attachment.occurrence.actionId === input.id && attachment.value.text === target.destination) ? current.revision : false;
        });
        await sleep(1000);
      }
      const beforeInvoke = await request(`/api/threads/${thread.id}`);
      const invoked = target.destination ? await (async () => {
        await driver.waitFor("connected Invoke ready", () => driver.evaluate(`(() => {
          const control = document.querySelector('#inspector [data-bound-invoke-id="${target.action.id}"]') || document.querySelector('[data-node-detail-runtime]')?.shadowRoot?.querySelector('[data-bound-invoke-id="${target.action.id}"]');
          return control && !control.disabled;
        })()`));
        await driver.evaluate(`(() => {
          const control = document.querySelector('#inspector [data-bound-invoke-id="${target.action.id}"]') || document.querySelector('[data-node-detail-runtime]')?.shadowRoot?.querySelector('[data-bound-invoke-id="${target.action.id}"]');
          control.click();
        })()`);
        const interaction = await driver.waitFor("UI created invocation", async () => {
          const current = await request(`/api/threads/${thread.id}`);
          return current.interactions.find((candidate) => !beforeInvoke.interactions.some((prior) => prior.id === candidate.id));
        });
        return { interaction };
      })() : await request(`/api/threads/${thread.id}/interactions/${parent.id}/actions/${target.action.id}/invoke`, {
        method: "POST", headers: { "Idempotency-Key": randomUUID() },
        ...(revision === undefined ? {} : { body: JSON.stringify({ inputDraftRevision: revision }) }),
      });
      const completed = await settled(thread.id, invoked.interaction.id);
      detail = completed.detail;
      result.steps.push({ actionId: target.action.id, destination: target.destination ?? null, interaction: completed.interaction });
      if (completed.interaction.completionStatus !== "accepted") throw new Error(`Invoked agent response ${completed.interaction.completionStatus}: ${completed.interaction.completionError ?? ""}`);
      if (target.destination) {
        const answers = completed.interaction.submittedInputs.map((answer) => answer.value.text);
        const draft = await request(`/api/threads/${thread.id}/input-draft`);
        result.checkpoints.push({ kind: "frozen-input-and-clearing", expected: target.destination, answers, remaining: draft.attachments.length });
        if (JSON.stringify(answers) !== JSON.stringify([target.destination]) || draft.attachments.length !== 0) throw new Error("Frozen inputs or successful-submit clearing did not match");
      }
      parent = detail.interactions.find((candidate) => candidate.id === parent.id);
      await capture(result, thread.id, parent, node, `case-${definition.id}-after-${index}`);
      await sleep(1500);
      if (target.destination) {
        const opened = await driver.evaluate(`(() => {
          const selector = '[data-invocation-result-interaction-id="${completed.interaction.id}"]:not(:disabled)';
          const control = document.querySelector('#inspector ' + selector) || document.querySelector('[data-node-detail-runtime]')?.shadowRoot?.querySelector(selector);
          if (!control) return false;
          control.click(); return true;
        })()`);
        if (opened) {
          await sleep(1500);
          const titles = await driver.evaluate(`[...document.querySelectorAll('.graph-node b')].map(node => node.textContent)`);
          if (titles[0]) await driver.clickNode(titles[0]);
          await sleep(2500);
        }
      }
      await writeFile(join(evidence, `case-${definition.id}-step-${index}.json`), JSON.stringify(detail, null, 2));
      await saveReceipt();
    }
    result.status = "mechanical-pass-semantic-review-pending";
  } catch (error) {
    result.status = "failed"; result.error = error.message;
  } finally {
    if (!result.threadId) {
      // A lost create response may conceal a started root. This isolated profile
      // contains only baseline threads; stop all of them and forbid another case.
      receipt.budget.usageKnown = false;
      const inventory = await request("/api/threads");
      for (const thread of inventory.threads) await stopOutstanding(thread.id);
    }
    if (result.threadId) {
      await stopOutstanding(result.threadId);
      const detail = await request(`/api/threads/${result.threadId}`);
      await writeFile(join(evidence, `case-${definition.id}-final.json`), JSON.stringify(detail, null, 2));
      if (result.status === "failed") {
        const parent = detail.interactions[0];
        if (parent?.completionOutput?.rootLayer) {
          const layer = parent.completionOutput.rootLayer;
          await capture(result, result.threadId, parent, layer.nodes[0], `case-${definition.id}-failure`);
          await sleep(2000);
        }
      }
      try { result.archive = await archive(result.threadId, `case-${definition.id}`); } catch (error) { result.exportError = error.message; }
      try { result.traces = await exportTraceEvidence({ runtime, interactions: detail.interactions, directory: join(evidence, `case-${definition.id}-traces`), refPrefix: `case-${definition.id}-traces`, correlation: { runId: `invoke-baseline-${definition.id}`, harnessConfigurationName: harness, model } }); }
      catch (error) { result.traceError = error.message; result.evidenceStatus = "incomplete"; }
      if (!result.traces?.every((trace) => trace.coverageComplete && !trace.truncated && trace.status === "complete")) result.evidenceStatus = "incomplete";
      await accountUsage(result, definition);
    }
    await saveReceipt();
    console.log(`LIVE_CASE_END ${JSON.stringify({ id: definition.id, status: result.status, error: result.error ?? null, evidence })}`);
  }
}

async function start() {
  reviewIpc();
  const installer = createManagedRuntimeInstaller({ root: "/Users/vishaltandale/.relayer/eval-web/managed-runtimes" });
  const native = await installer.validate("codex@0.159.3");
  const environment = { ...process.env, ...native.environment, RELAYER_CODEX_BINARY: native.executable, CODEX_HOME: "/Users/vishaltandale/.relayer/eval-web/codex-home" };
  const credentials = new CodexCredentialAdapter({ environment });
  let catalog;
  try { catalog = await new CodexModelCatalogAdapter({ credentials }).discover(); } finally { await credentials.close(); }
  const available = catalog.models.find((candidate) => candidate.id === model && candidate.visible && candidate.availability === "available");
  if (catalog.provider.status !== "available" || !available?.supportedEfforts.some((effort) => effort.id === "medium")) throw new Error("Authorized Luna/medium route is unavailable");
  receipt.nativeRuntime = { recipe: "codex@0.159.3", executableSha256: createHash("sha256").update(await readFile(native.executable)).digest("hex") };
  receipt.source = workspaceProvenance(repository);
  receipt.binaries = Object.fromEntries(["relayer-graph-server", "relayer-app-server"].map((name) => [name, executableProvenance(join(repository, "target/debug", name))]));
  runtime = new GraphCompleteRuntimeService({ userDataDirectory: dataDirectory,
    graphServerBinary: join(repository, "target/debug/relayer-graph-server"), configurationPaths: [join(repository, "harnesses/codex-basic.yaml")],
    codexPathOverride: native.executable, temporalFeatures: RECURSIVE_TEMPORAL_FEATURES,
    candidateTrace: { directory: join(dataDirectory, "candidate-trace-spool"), policy: { mode: "required", requiredFeatures: {}, includeNativeArtifacts: false, maxBytesPerTurn: 10 * 1024 * 1024, maxEventsPerTurn: 50_000 } },
    acquireProviderExecution: async (providerId) => {
      if (providerId !== "codex") throw new Error("Only the authorized Codex route may execute.");
      return { definition: { id: "codex", adapterId: "codex-subscription", accessContract: "managed-runtime@1" },
      descriptor: { adapterId: "codex-subscription", accessContract: "managed-runtime@1", implementationVersion: productionProviderAdapterRegistry.get("codex-subscription").implementationVersion },
      runtime: { executionAccess: async () => ({ kind: "managed-runtime", runtimeId: "codex", executable: native.executable, version: native.version, environment }) }, release: async () => {},
    }; },
  });
  product = new RelayerAppServerService({ userDataDirectory: dataDirectory, binaryPath: join(repository, "target/debug/relayer-app-server"), webDirectory: join(repository, "desktop/renderer"), permissionCatalogPath: join(repository, "permissions/desktop.json"), runtimeSession: await runtime.start(), defaultHarnessConfiguration: harness });
  session = await product.start();
  await product.seedProviderCatalog({ providerId: "codex", label: "Codex", connected: true, models: [{ id: model, label: available.label, order: 0, visible: true, available: true, providerDefault: true, metadata: {} }] });
  const readiness = createHarnessReadinessCoordinator({ configurations: runtime.session.configurations, digestConfiguration: runtime.session.digestConfiguration, runtimeRequirements: {},
    prepareRecipe: async () => { throw new Error("The baseline may only reuse the already validated runtime."); },
    checkers: { "codex.basic": async () => ({ available: true }) }, publishAvailability: (updates) => product.publishHarnessReadiness(updates) });
  const ready = await readiness.evaluate({ trigger: "connect", providerDefinition: { id: "codex", adapterId: "codex-subscription", accessContract: "managed-runtime@1" }, models: [{ id: model, visible: true, available: true }] });
  if (!ready.readyHarnessIds.includes(harness)) throw new Error("Codex harness failed live route readiness");
  const family = await request("/api/model-families", { method: "POST", body: JSON.stringify({ name: "Luna interaction baseline", enabled: true, members: [{ providerId: "codex", modelId: model }] }) });
  await request("/api/model-selection/validate", { method: "POST", body: JSON.stringify({ harnessId: harness, familyId: family.id, providerId: "codex", modelId: model }) });
  await saveReceipt();
  if (setupOnly) { console.log(`LIVE_SETUP_READY ${JSON.stringify({ dataDirectory, model, inference: false })}`); await close(); app.exit(0); return; }
  window = await createWindowFactory({ BrowserWindow, desktopDirectory: join(repository, "desktop"), getAppearance: () => "dark", updater: { status: () => ({ phase: "development" }) }, openExternal: async () => { throw new Error("External links are not part of this baseline"); } })(session);
  window.setTitle("Relayer — real Luna interaction baseline");
  window.webContents.setBackgroundThrottling(false); window.show();
  if (record) {
    await recordFrame();
    recordingTimer = setInterval(() => { void recordFrame().catch((error) => { captureError ??= error; }); }, 500);
  }
  for (const definition of cases.filter(({ id }) => selectedCase === undefined || id === selectedCase)) await runCase(definition, family);
  await finishRecording();
  console.log(`LIVE_BASELINE_READY ${JSON.stringify({ evidence, dataDirectory, cases: receipt.cases.map(({ id, status }) => ({ id, status })), noAutomaticRetries: true })}`);
}
async function close() { await product?.close(); await runtime?.close(); }
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => { if (closing) return; event.preventDefault(); closing = true; void close().finally(() => app.exit(0)); });
void app.whenReady().then(start).catch(async (error) => { receipt.errors.push(error.message); await saveReceipt(); console.error(error.stack); await close(); app.exit(1); });
