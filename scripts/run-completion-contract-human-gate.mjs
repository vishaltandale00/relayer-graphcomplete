import { app, BrowserWindow, ipcMain } from "electron";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GraphCompleteRuntimeService, RECURSIVE_TEMPORAL_FEATURES } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { createWindowFactory } from "../desktop/main/window.mjs";
import { registerWorkspaceLayoutIpc, registerProjectSidebarIpc, registerLayerSelectionIpc } from "../desktop/main/ipc/register-ipc.mjs";
import { completionContractFixtureFactory } from "./fixtures/completion-contract-harness.mjs";
import { createElectronWorkspaceDriver } from "./electron-workspace-driver.mjs";

const repository = resolve(import.meta.dirname, "..");
const dataIndex = process.argv.indexOf("--data-dir");
const dataDirectory = dataIndex < 0 ? await mkdtemp(join(tmpdir(), "relayer-completion-review-")) : resolve(process.argv[dataIndex + 1]);
const record = process.argv.includes("--record");
const vacation = process.argv.includes("--vacation");
const multiple = process.argv.includes("--multiple");
const evidenceDirectory = join(dataDirectory, "evidence");
const savedTrialPath = join(dataDirectory, "human-gate.json");
let savedTrial;
try { savedTrial = JSON.parse(await readFile(savedTrialPath, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
if (record && savedTrial) throw new Error("Recording requires a fresh trial directory; the existing trial is preserved.");
await mkdir(join(dataDirectory, "electron-profile"), { recursive: true });
await mkdir(evidenceDirectory, { recursive: true });
app.setName("Relayer Completion Contract Review");
app.setPath("userData", join(dataDirectory, "electron-profile"));
const observed = { errors: [], contracts: [], invocations: [], advances: [], results: [] };
let runtime, product, window, productSession, closing = false;
let capturing = false, frameNumber = 0, timer, captureError;
const frames = [];
const sleep = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
const driver = createElectronWorkspaceDriver({ getWindow: () => window, getProductSession: () => productSession });

function fixtureIpc() {
  let composerDrafts = {};
  let preferences = {};
  const settings = { async read() { return preferences; }, async update(transform) { preferences = transform(preferences); } };
  registerWorkspaceLayoutIpc({ ipcMain, settings });
  registerProjectSidebarIpc({ ipcMain, settings });
  registerLayerSelectionIpc({ ipcMain, settings });
  ipcMain.handle("relayer:account-read", () => ({ status: "signed-in", channel: "stable", subject: "fixture|completion-contract" }));
  ipcMain.handle("relayer:provider-status", () => ({ adapters: [], definitions: [], hasCompletedOnboarding: true }));
  ipcMain.handle("relayer:appearance-read", () => ({ appearance: "dark" }));
  ipcMain.handle("relayer:tutorial-read", () => ({ status: "dismissed", automaticEligible: false }));
  ipcMain.handle("relayer:update-status", () => ({ phase: "development", channel: "stable", version: "review", availableVersion: null, percent: null, error: null }));
  ipcMain.handle("relayer:share-pending", () => null);
  ipcMain.handle("relayer:composer-drafts-read", () => composerDrafts);
  ipcMain.handle("relayer:composer-drafts-write", (_event, value) => { composerDrafts = value; return value; });
  ipcMain.handle("relayer:folder-choose", () => null);
}

async function request(path, options = {}) {
  const response = await fetch(new URL(path, productSession.origin), {
    ...options,
    headers: { Accept: "application/json", Cookie: `${productSession.cookie.name}=${productSession.cookie.value}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${path}: ${JSON.stringify(result)}`);
  return result;
}

async function start() {
  fixtureIpc();
  const config = join(dataDirectory, "fixture-completion-contract.yaml");
  await writeFile(config, [
    "schemaVersion: 1", "name: fixture-completion-contract", "implementation: fixture.completion-contract",
    "implementationVersion: 1", "complete:", "  agentAuthored: true", "permissionBindings:",
    "  ask: {}", "  auto: {}", "  full: {}", "modelCompatibility:", "  - providerId: codex",
    "executionAccessContracts: [managed-runtime@1]", "settings: {}", "",
  ].join("\n"));
  runtime = new GraphCompleteRuntimeService({
    userDataDirectory: dataDirectory,
    graphServerBinary: join(repository, "target", "debug", "relayer-graph-server"),
    configurationPaths: [config], temporalFeatures: RECURSIVE_TEMPORAL_FEATURES, interactionPermissions: true,
    additionalImplementations: { "fixture.completion-contract": completionContractFixtureFactory(observed, { multiple }) },
    acquireProviderExecution: async (providerId) => ({
      definition: { id: providerId, adapterId: "codex-subscription", accessContract: "managed-runtime@1" },
      descriptor: { adapterId: "codex-subscription", accessContract: "managed-runtime@1", implementationVersion: "1" },
      runtime: { executionAccess: async () => ({ kind: "managed-runtime", environment: {} }) },
      async release() {},
    }),
  });
  const runtimeSession = await runtime.start();
  product = new RelayerAppServerService({
    userDataDirectory: dataDirectory, binaryPath: join(repository, "target", "debug", "relayer-app-server"),
    webDirectory: join(repository, "desktop", "renderer"), permissionCatalogPath: join(repository, "permissions", "desktop.json"),
    runtimeSession, defaultHarnessConfiguration: "fixture-completion-contract", enableReadOnlySession: true,
  });
  productSession = await product.start();
  await product.seedProviderCatalog({
    providerId: "codex", label: "Deterministic review fixture", connected: true,
    models: [{ id: "fixture-model", label: "Deterministic review fixture", order: 0, visible: true, available: true, providerDefault: true, metadata: {} }],
    systemFamily: { key: "codex", name: "Review fixture", modelIds: ["fixture-model"] },
  });
  const family = savedTrial ? null : await request("/api/model-families", { method: "POST", body: JSON.stringify({
    name: "Review fixture", enabled: true, members: [{ providerId: "codex", modelId: "fixture-model" }],
  }) });
  const createWindow = createWindowFactory({ BrowserWindow, desktopDirectory: join(repository, "desktop"),
    getAppearance: () => "dark", updater: { status: () => ({ phase: "development" }) },
    openExternal: async () => { throw new Error("External links are unavailable in the deterministic review fixture."); },
  });
  window = await createWindow(productSession);
  window.setTitle("Relayer — deterministic completion contract trial (no model)");
  window.webContents.setBackgroundThrottling(false);
  window.show(); window.focus(); app.focus({ steal: true });
  if (savedTrial) {
    if (savedTrial.schemaVersion !== 1 || !Number.isSafeInteger(savedTrial.threadId)) throw new Error("Invalid saved trial identity.");
    await request(`/api/threads/${savedTrial.threadId}`);
    await window.loadURL(`${productSession.origin}/?threadId=${encodeURIComponent(savedTrial.threadId)}`);
    process.stdout.write(`HUMAN_GATE_READY ${JSON.stringify({ dataDirectory, threadId: savedTrial.threadId, fixture: true, inference: false, reopened: true })}\n`);
    return;
  }
  if (record) {
    await driver.waitFor("renderer ready for capture", () => driver.evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('#newThreadPrompt, #threadPrompt'))`));
    await sleep(250);
    timer = setInterval(() => { void capture().catch((error) => { captureError ??= error; }); }, 250);
    await capture();
  }
  const created = await request("/api/threads", { method: "POST", body: JSON.stringify({
    title: multiple ? "Multiple input actions" : vacation ? "Vacation comparison trial" : "Completion contract trial", initialMessage: multiple ? "Plan a trip with two separately scoped Invokes and an ordinary input." : vacation ? "Help compare vacation destinations using a confirmed input and Invoke." : "Compare two approaches and show the findings.",
    harnessId: "fixture-completion-contract", permissionProfileId: "auto",
    modelSelection: { familyId: family.id, providerId: "codex", modelId: "fixture-model" },
  }) });
  const threadId = created.thread?.id ?? created.id;
  if (!Number.isSafeInteger(threadId)) throw new Error("Thread creation did not return an exact thread identity.");
  await window.loadURL(`${productSession.origin}/?threadId=${encodeURIComponent(threadId)}`);
  if (record) await window.webContents.executeJavaScript(`(() => {
    const caption = document.createElement('div');
    caption.textContent = 'Deterministic production-seam demonstration — no model inference';
    caption.style.cssText = 'position:fixed;top:4px;left:50%;transform:translateX(-50%);z-index:1000;padding:6px 12px;border-radius:8px;background:#20252d;color:#f1f2f3;font:13px system-ui;pointer-events:none';
    document.body.append(caption);
  })()`);
  if (multiple) {
    let detail = await driver.waitFor("multiple inputs accepted", async () => {
      if (observed.errors.length) throw new Error(observed.errors.join("\n"));
      const value = await request(`/api/threads/${threadId}`);
      return value.interactions.length === 1 && value.interactions[0].completionStatus === "accepted" ? value : false;
    }, 45000);
    if (record) {
      await driver.waitFor("Plan a trip visible", () => driver.evaluate("document.querySelector('.graph-node b')?.textContent === 'Plan a trip'"));
      await driver.clickNode("Plan a trip");
      await driver.waitFor("five actual product input controls", () => driver.evaluate("document.querySelectorAll('.node-input-text').length === 5"));
      if (await driver.evaluate("Boolean(document.querySelector('[aria-label^=\"Commit \" ]'))")) throw new Error("Standard fields still expose confirmation controls.");
      await driver.setValue('[aria-label="Destination"]', "Temporary edit");
      await driver.waitFor("edited Destination enables Undo", () => driver.evaluate("document.querySelector('[aria-label=\"Undo Destination\"]')?.disabled === false"));
      await driver.click('[aria-label="Undo Destination"]');
      if (await driver.evaluate("document.querySelector('[aria-label=Destination]').value") !== "") throw new Error("Undo did not restore the empty baseline.");
      for (const [prompt, value] of [["Destination", "Lisbon"], ["Trip pace", "Relaxed"], ["Budget", "1500"], ["Days", "7"], ["Unrelated notes", "Prefer morning departures"]]) {
        await driver.evaluate(`document.querySelector(${JSON.stringify(`[aria-label='${prompt}']`)}).scrollIntoView({ block: 'center' })`);
        await driver.setValue(`[aria-label='${prompt}']`, value);
        await sleep(750);
      }
      await driver.waitFor("valid values enable both single-call Invokes", () => driver.evaluate("[...document.querySelectorAll('[data-bound-invoke-id]')].filter(b => !b.disabled).length === 2"));
      await sleep(750);
      await driver.click("#sendInteraction");
      detail = await driver.waitFor("ordinary input accepted separately", async () => {
        const value = await request(`/api/threads/${threadId}`);
        if (observed.errors.length) throw new Error(observed.errors.join("\n"));
        return value.interactions.length === 2 && value.interactions.every(i => i.completionStatus === "accepted") ? value : false;
      }, 45000);
      const ordinary = observed.contracts.find(c => c.interactionNodeId === detail.interactions[1].graphNodeId);
      if (JSON.stringify(ordinary.input.answers.map(a => [a.question.prompt, a.value.text])) !== JSON.stringify([["Unrelated notes", "Prefer morning departures"]])) throw new Error("Ordinary Send received bound inputs.");
      // Stay in this workspace: pending values deliberately survive navigation,
      // whereas a fresh process starts from the saved authoritative draft.
      if (await driver.evaluate("document.querySelector('.graph-node b')?.textContent !== 'Plan a trip'")) {
        await driver.click("#turnPickerButton");
        await driver.click(`#turnPopover [data-turn-id='${detail.interactions[0].id}']`);
        await driver.waitFor("source after Send", () => driver.evaluate("document.querySelector('.graph-node b')?.textContent === 'Plan a trip'"));
      }
      await driver.clickNode("Plan a trip");
      await driver.waitFor("bound stages retained outside ordinary Send", () => driver.evaluate("document.querySelector('[aria-label=Destination]')?.value === 'Lisbon' && document.querySelector('[aria-label=Budget]')?.value === '1500'"));
      await driver.waitFor("ordinary Input source response Navigate", () => driver.evaluate(`Boolean([...document.querySelectorAll('#inspector button')].find(b => b.textContent.includes('Open Notes response') && !b.disabled))`));
      await driver.evaluate(`(() => { const b = [...document.querySelectorAll('#inspector button')].find(b => b.textContent.includes('Open Notes response')); b.scrollIntoView({ block: 'center' }); })()`);
      await sleep(1000);
      await driver.evaluate(`(() => { const b = [...document.querySelectorAll('#inspector button')].find(b => b.textContent.includes('Open Notes response')); b.click(); })()`);
      await driver.waitFor("ordinary input source Navigate opens exact response", () => driver.evaluate("document.querySelector('.graph-node b')?.textContent === 'Notes response'"));
      await driver.clickNode("Notes response");
      await sleep(1000);
      await driver.click("#historyBack");
      await driver.waitFor("source after ordinary Navigate", () => driver.evaluate("document.querySelector('.graph-node b')?.textContent === 'Plan a trip'"));
      await driver.clickNode("Plan a trip");
      for (const [index, label, expected] of [[0, "Build itinerary", [["Destination", "Lisbon"], ["Trip pace", "Relaxed"]]], [1, "Estimate budget", [["Budget", "1500"], ["Days", "7"]]]]) {
        await driver.evaluate(`(() => { const b = [...document.querySelectorAll('[data-bound-invoke-id]')].find(b => b.textContent.includes(${JSON.stringify(label)})); b.scrollIntoView({ block: 'center' }); })()`);
        await sleep(1000);
        await driver.evaluate(`(() => { const b = [...document.querySelectorAll('[data-bound-invoke-id]')].find(b => b.textContent.includes(${JSON.stringify(label)})); if (!b || b.disabled) throw new Error('Invoke unavailable'); b.click(); })()`);
        detail = await driver.waitFor(`${label} returned and integrated`, async () => {
          const value = await request(`/api/threads/${threadId}`);
          if (observed.errors.length) throw new Error(observed.errors.join("\n"));
          return value.interactions.length === index + 3 && value.interactions.every(i => i.completionStatus === "accepted") ? value : false;
        }, 45000);
        const call = observed.contracts.find(c => c.interactionNodeId === detail.interactions.at(-1).graphNodeId);
        if (JSON.stringify(call.input.answers.map(a => [a.question.prompt, a.value.text])) !== JSON.stringify(expected)) throw new Error("Invoke captured another consumer's inputs.");
        if (await driver.evaluate("document.querySelector('.graph-node b')?.textContent !== 'Plan a trip'")) {
          await driver.click("#turnPickerButton");
          await driver.click(`#turnPopover [data-turn-id='${detail.interactions[0].id}']`);
          await driver.waitFor("source after Invoke", () => driver.evaluate("document.querySelector('.graph-node b')?.textContent === 'Plan a trip'"));
          await driver.clickNode("Plan a trip");
        }
        await driver.waitFor("consumed fields clear", () => driver.evaluate(`document.querySelector('[aria-label=${index === 0 ? "Destination" : "Budget"}]')?.value === ''`));
        if (index === 0 && await driver.evaluate("document.querySelector('[aria-label=Budget]').value") !== "1500") throw new Error("Itinerary consumed budget stage.");
        await sleep(750);
      }
      const source = await request(`/api/threads/${threadId}/interactions/${detail.interactions[0].id}/layers/${detail.interactions[0].completionOutput.rootLayer.layer.id}`);
      const result = source.actions.find(a => a.kind === "navigate" && a.label === "Open Itinerary — Lisbon");
      if (!result) throw new Error("Source lacks the Navigate action to the exact itinerary response.");
      await driver.evaluate(`(() => { const b = [...document.querySelectorAll('#inspector button')].find(b => b.dataset.actionId === ${JSON.stringify(String(result.id))} || b.textContent.includes('Open Itinerary — Lisbon')); if (!b || b.disabled) throw new Error('Source response control unavailable'); b.click(); })()`);
      await driver.waitFor("source Navigate opens accepted itinerary response", () => driver.evaluate("document.querySelector('.graph-node b')?.textContent === 'Itinerary — Lisbon'"));
      await driver.clickNode("Itinerary — Lisbon");
      await sleep(1000);
      await driver.click("#historyBack");
      await driver.waitFor("source controls restored", () => driver.evaluate("document.querySelector('.graph-node b')?.textContent === 'Plan a trip'"));
      await driver.clickNode("Plan a trip");
      await sleep(750);
      await finishRecording(detail);
    }
    await writeFile(savedTrialPath, JSON.stringify({ schemaVersion: 1, threadId, familyId: family.id }));
    process.stdout.write(`HUMAN_GATE_READY ${JSON.stringify({ dataDirectory, threadId, fixture: true, inference: false, scenario: "multiple-single-call-inputs", video: record ? join(evidenceDirectory, "completion-contract.mp4") : null })}\n`);
    if (record) { await close(); app.exit(0); }
    return;
  }

  if (vacation) {
    let detail = await driver.waitFor("vacation input ready", async () => {
      if (observed.errors.length) throw new Error(observed.errors.join("\n"));
      const candidate = await request(`/api/threads/${threadId}`);
      return candidate.interactions.length === 1 && candidate.interactions[0].completionStatus === "accepted" ? candidate : false;
    }, 45000);
    if (record) {
      const parentId = detail.interactions[0].id;
      for (const [index, destination] of ["Lisbon", "Kyoto"].entries()) {
        await window.loadURL(`${productSession.origin}/?threadId=${threadId}&interactionId=${parentId}`);
        await driver.waitFor("vacation parent", () => driver.evaluate(`document.querySelector('.graph-node b')?.textContent === 'Choose a vacation destination'`));
        await driver.clickNode("Choose a vacation destination");
        await driver.waitFor("destination field", () => driver.evaluate(`Boolean(document.querySelector('.node-input-text'))`));
        if (await driver.evaluate(`document.querySelector('.node-input-text').value !== ''`)) throw new Error('Successful submission must leave a fresh empty destination field');
        await driver.setValue(".node-input-text", destination);
        await driver.evaluate(`(() => {
          const group = document.querySelector('.invoke-input-group');
          const invoke = group?.querySelector('[data-bound-invoke-id]');
          if (!group?.querySelector('.node-input-text') || invoke?.disabled) throw new Error('Current valid destination must enable Invoke');
        })()`);
        await driver.evaluate(`(() => {
          const invoke = [...document.querySelectorAll('.invoke-input-group button')].find((item) => item.textContent.includes('Analyze destination'));
          if (!invoke || invoke.disabled) throw new Error('Vacation Invoke is not available');
          invoke.click();
        })()`);
        detail = await driver.waitFor(`${destination} integrated`, async () => {
          if (observed.errors.length) throw new Error(observed.errors.join("\n"));
          const candidate = await request(`/api/threads/${threadId}`);
          return candidate.interactions.length === index + 2 && candidate.interactions.every((interaction) => interaction.completionStatus === "accepted") ? candidate : false;
        }, 45000);
        const consumedDraft = await request(`/api/threads/${threadId}/input-draft`);
        if (consumedDraft.attachments.length !== 0) throw new Error('Submitted destination remained attached to Send');
        await sleep(1500);
      }
      await window.loadURL(`${productSession.origin}/?threadId=${threadId}&interactionId=${parentId}`);
      await driver.waitFor("vacation source restored", () => driver.evaluate(`document.querySelector('.graph-node b')?.textContent === 'Choose a vacation destination'`));
      await driver.clickNode("Choose a vacation destination");
      await driver.waitFor("distinct vacation results beside Invoke", () => driver.evaluate(`(() => {
        const controls = [...document.querySelectorAll('.invocation-result-control:not(:disabled)')];
        return controls.length === 2 && new Set(controls.map((control) => control.dataset.invocationResultInteractionId)).size === 2 && document.querySelectorAll('#inspector .action-control').length === 3 && document.querySelector('.invoke-input-group [data-bound-invoke-id]');
      })()`));
      const answers = observed.contracts.filter((contract) => contract.input.invocationReferences.length).map((contract) => contract.input.answers[0]?.value.text);
      if (JSON.stringify(answers) !== JSON.stringify(["Lisbon", "Kyoto"])) throw new Error(`Distinct vacation inputs were not sealed: ${JSON.stringify(answers)}`);
      await driver.waitFor("named destination result controls", () => driver.evaluate(`(() => {
        const labels = [...document.querySelectorAll('.invocation-result-control')].map((control) => control.textContent);
        return labels.some((label) => label.includes('Lisbon')) && labels.some((label) => label.includes('Kyoto'));
      })()`));
      const latestResultId = detail.interactions.at(-1).id;
      await driver.click(`.invocation-result-control[data-invocation-result-interaction-id='${latestResultId}']`);
      await driver.waitFor("Kyoto overall comparison", () => driver.evaluate(`document.querySelector('.graph-node b')?.textContent === 'Vacation comparison — Kyoto'`));
      await driver.waitFor("invoking destination Node in breadcrumb", () => driver.evaluate(`[...document.querySelectorAll('.breadcrumb-label')].some(label => label.textContent === 'Choose a vacation destination')`));
      await driver.clickNode("Vacation comparison — Kyoto");
      await driver.waitFor("earlier Lisbon incorporated", () => driver.evaluate(`document.querySelector('#inspectorContent')?.textContent.includes('Lisbon')`));
      await sleep(1000);
      await driver.evaluate(`(() => {
        const brief = [...document.querySelectorAll('#detailActions button')].find((control) => control.textContent === 'Kyoto brief');
        if (!brief) throw new Error('Missing nested Kyoto brief');
        brief.click();
      })()`);
      await driver.waitFor("nested Kyoto detail", () => driver.evaluate(`document.querySelector('.graph-node b')?.textContent === 'Kyoto brief'`));
      await driver.clickNode("Kyoto brief");
      await sleep(1000);
      await driver.click("#historyBack");
      await driver.waitFor("Kyoto analysis restored", () => driver.evaluate(`document.querySelector('.graph-node b')?.textContent === 'Vacation comparison — Kyoto'`));
      await driver.waitFor("restored invoking Node breadcrumb", () => driver.evaluate(`[...document.querySelectorAll('.breadcrumb-label')].some(label => label.textContent === 'Choose a vacation destination')`));
      await driver.click("#historyBack");
      await driver.waitFor("vacation controls restored", () => driver.evaluate(`document.querySelector('.graph-node b')?.textContent === 'Choose a vacation destination'`));
      await driver.clickNode("Choose a vacation destination");
      await sleep(1500);
      await finishRecording(detail);
    }
    await writeFile(savedTrialPath, JSON.stringify({ schemaVersion: 1, threadId, familyId: family.id }));
    process.stdout.write(`HUMAN_GATE_READY ${JSON.stringify({ dataDirectory, threadId, fixture: true, inference: false, scenario: "vacation", video: record ? join(evidenceDirectory, "completion-contract.mp4") : null })}\n`);
    return;
  }
  const deadline = Date.now() + 45000;
  let detail;
  while (Date.now() < deadline) {
    const state = await request("/api/state");
    const id = threadId ?? state.threads[0]?.id;
    if (id) detail = await request(`/api/threads/${id}`);
    if (observed.errors.length) throw new Error(observed.errors.join("\n"));
    if (detail?.interactions?.length >= 2 && detail.interactions.every((interaction) => interaction.completionStatus === "accepted")) break;
    await sleep(100);
  }
  if (!detail?.interactions?.every((interaction) => interaction.completionStatus === "accepted") || observed.results.length !== 1) {
    throw new Error(`Demo did not produce one integrated returned child graph: ${JSON.stringify(detail)}`);
  }
  await sleep(1500);
  if (record) {
    await driver.waitFor("returned conclusion", () => driver.evaluate(`document.querySelector('.graph-node b')?.textContent === 'Start small, then verify'`));
    await driver.clickNode("Start small, then verify");
    await driver.evaluate(`(() => {
      const control = [...document.querySelectorAll('#detailActions button')].find((item) => item.textContent.includes('Earlier view and comparisons'));
      if (!control) throw new Error('Missing earlier-view navigation control');
      control.click();
    })()`);
    await driver.waitFor("earlier view", () => driver.evaluate(`document.querySelector('.graph-node b')?.textContent === 'A useful first direction'`));
    await driver.clickNode("A useful first direction");
    const resultIds = await driver.waitFor("one call result control", () => driver.evaluate(`(() => {
      const ids = [...document.querySelectorAll('.invocation-result-control:not(:disabled)')].map((item) => item.dataset.invocationResultInteractionId);
      return ids.length === 1 ? ids : false;
    })()`));
    for (const resultId of resultIds) {
      await driver.click(`.invocation-result-control[data-invocation-result-interaction-id='${resultId}']`);
      await driver.waitFor("updated overall analysis", () => driver.evaluate(`document.querySelector('.graph-node b')?.textContent === 'Updated overall analysis'`));
      await driver.clickNode("Updated overall analysis");
      await driver.evaluate(`(() => {
        const control = [...document.querySelectorAll('#detailActions button')].find((item) => item.textContent.includes('Inspect the supporting comparison'));
        if (!control) throw new Error('Missing nested supporting comparison');
        control.click();
      })()`);
      await driver.waitFor("nested comparison", () => driver.evaluate(`document.querySelector('.graph-node b')?.textContent === 'Approach comparison'`));
      await driver.clickNode("Approach comparison");
      await sleep(1000);
      await driver.click("#historyBack");
      await driver.waitFor("overall analysis restored", () => driver.evaluate(`document.querySelector('.graph-node b')?.textContent === 'Updated overall analysis'`));
      await driver.click("#historyBack");
      await driver.waitFor("comparison source", () => driver.evaluate(`document.querySelector('.graph-node b')?.textContent === 'A useful first direction'`));
      await driver.clickNode("A useful first direction");
    }
    await driver.waitFor("published parent integration control", () => driver.evaluate(`Boolean([...document.querySelectorAll('#detailActions button')].find((item) => item.textContent.includes('See the new response')))`));
    await driver.click("#historyBack");
    await driver.waitFor("conclusion restored", () => driver.evaluate(`document.querySelector('.graph-node b')?.textContent === 'Start small, then verify'`));
    await driver.clickNode("Start small, then verify");
    await driver.click("#attachNodeContext");
    await driver.setValue("#contextAnnotationEditor", "Use this finding when comparing the next steps.");
    await driver.click("[aria-label='Confirm annotation']");
    await driver.setValue("#threadPrompt", "Use the attached finding to compare the next steps.");
    await driver.waitFor("follow-up Send enabled", () => driver.evaluate(`document.querySelector('#sendInteraction')?.disabled === false`));
    await sleep(1000);
    await driver.click("#sendInteraction");
    detail = await driver.waitFor("four accepted interactions", async () => {
      const candidate = await request(`/api/threads/${threadId}`);
      if (observed.errors.length) throw new Error(observed.errors.join("\n"));
      return candidate.interactions.length === 4 && candidate.interactions.every((interaction) => interaction.completionStatus === "accepted") ? candidate : false;
    }, 45000);
    if (!observed.contracts.some((contract) => contract.returnRequirements.length > 0) || observed.results.length !== 2) {
      throw new Error("Recorded follow-up did not exercise accepted-history requirements and two integrated child results.");
    }
    const followup = detail.interactions.find((interaction) => interaction.id !== 1 && interaction.originKind === "message") ?? detail.interactions[2];
    await window.loadURL(`${productSession.origin}/?threadId=${threadId}&interactionId=${followup.id}`);
    await driver.waitFor("follow-up returned root visible", () => driver.evaluate(`document.querySelector('.graph-node b')?.textContent === 'Start small, then verify'`));
    await driver.clickNode("Start small, then verify");
    await sleep(1500);
    await driver.click("#interactionContextPill");
    await driver.waitFor("attached source inspection", () => driver.evaluate(`Boolean(document.querySelector('#interactionContextPopover .interaction-context-node'))`));
    await driver.click("#interactionContextPopover .interaction-context-node");
    await sleep(1000);
    await driver.clickNode("Start small, then verify");
    await driver.click("#turnPickerButton");
    await driver.click(`#turnPopover [data-turn-id='${detail.interactions[0].id}']`);
    await driver.waitFor("annotation source interaction selected", () => driver.evaluate(`new URL(location.href).searchParams.get('interactionId') === '${detail.interactions[0].id}' && document.querySelector('#turnPopover').classList.contains('hidden')`));
    await driver.clickNode("Start small, then verify");
    await driver.waitFor("annotation source response Navigate", () => driver.evaluate(`Boolean([...document.querySelectorAll('#detailActions button')].find(b => b.textContent.includes('See the new response') && !b.disabled))`));
    await driver.evaluate(`(() => { const b = [...document.querySelectorAll('#detailActions button')].find(b => b.textContent.includes('See the new response')); if (!b || b.disabled) throw new Error('Annotation source response Navigate unavailable'); b.scrollIntoView({ block: 'center' }); })()`);
    await sleep(1000);
    await driver.evaluate(`(() => { [...document.querySelectorAll('#detailActions button')].find(b => b.textContent.includes('See the new response')).click(); })()`);
    await driver.waitFor("annotation source Navigate opens returned response", () => driver.evaluate(`document.querySelector('.graph-node b')?.textContent === 'Start small, then verify' && !document.querySelector('#historyBack').disabled`));
    await driver.clickNode("Start small, then verify");
    await sleep(1000);
  }
  if (record) await finishRecording(detail);
  await writeFile(savedTrialPath, JSON.stringify({ schemaVersion: 1, threadId, familyId: family.id }));
  process.stdout.write(`HUMAN_GATE_READY ${JSON.stringify({
    dataDirectory, fixture: true, inference: false, threadId: detail.thread.id,
    instruction: "Inspect the returned response and earlier view, navigate the updated overall analysis and its supporting comparison, then attach an earlier node and send a follow-up. This fixture exercises graph mechanics, not model quality.",
    video: record ? join(evidenceDirectory, "completion-contract.mp4") : null,
    reopen: `cd '${repository}' && ./node_modules/.bin/electron scripts/run-completion-contract-human-gate.mjs --data-dir '${dataDirectory}'`,
  })}\n`);
}

async function capture() {
  if (capturing || !window || window.isDestroyed()) return;
  capturing = true;
  try {
    const file = join(evidenceDirectory, `frame-${String(++frameNumber).padStart(5, "0")}.png`);
    const png = (await window.webContents.capturePage()).toPNG();
    await writeFile(file, png);
    frames.push({ file, capturedAt: Date.now(), sha256: createHash("sha256").update(png).digest("hex") });
  } catch (error) {
    throw new Error(`Native frame capture ${frameNumber} failed: ${error.message}`, { cause: error });
  } finally { capturing = false; }
}

async function finishRecording(detail) {
  clearInterval(timer);
  while (capturing) await sleep(25);
  if (captureError) throw captureError;
  const video = join(evidenceDirectory, "completion-contract.mp4");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-framerate", "4", "-i",
    join(evidenceDirectory, "frame-%05d.png"), "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", video]);
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
  const sourceFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: repository, encoding: "utf8" }).split("\0").filter(Boolean).sort();
  const sourceHash = createHash("sha256");
  for (const file of sourceFiles) { sourceHash.update(file).update("\0"); sourceHash.update(await readFile(join(repository, file))); }
  const binaries = {};
  for (const name of ["relayer-graph-server", "relayer-app-server"]) binaries[name] = createHash("sha256").update(await readFile(join(repository, "target", "debug", name))).digest("hex");
  await writeFile(join(evidenceDirectory, "manifest.json"), JSON.stringify({
    schemaVersion: 1, demonstration: "deterministic production services and renderer", inference: false,
    sourceCommit, sourceDigest: sourceHash.digest("hex"), binaries,
    video: { path: video, sha256: createHash("sha256").update(await readFile(video)).digest("hex") },
    frames, observed, acceptedInteractionIds: detail.interactions.map((interaction) => interaction.id),
    humanVerdict: "pending", modelExecutionProof: "not claimed",
  }, null, 2));
}

async function close() { clearInterval(timer); if (product) await product.close(); if (runtime) await runtime.close(); }
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (closing) return;
  event.preventDefault(); closing = true;
  void close().finally(() => app.exit(0));
});
void app.whenReady().then(start).catch(async (error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  await close(); app.exit(1);
});
