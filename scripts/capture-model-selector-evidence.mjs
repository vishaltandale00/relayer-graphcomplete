import { app, BrowserWindow, ipcMain } from "electron";
import { mkdirSync, mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { taskSystemFixtureFactory } from "@relayer/eval-runner";

import { CodexCredentialAdapter } from "../desktop/main/credentials/codex-credential-adapter.mjs";
import { CodexModelCatalogAdapter } from "../desktop/main/models/codex-model-catalog-adapter.mjs";
import { startModelCatalogRefreshServer } from "../desktop/main/models/model-catalog-refresh-server.mjs";
import { ModelCatalogService } from "../desktop/main/models/model-catalog-service.mjs";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { createWindowFactory } from "../desktop/main/window.mjs";

const CAPTURE_OPT_IN = "RELAYER_CAPTURE_MODEL_SELECTOR_EVIDENCE";
const repositoryRoot = resolve(import.meta.dirname, "..");
const outputDirectory = join(repositoryRoot, "docs", "prd", "assets", "evidence", "model-picker");
const settingsOutputDirectory = join(repositoryRoot, "docs", "prd", "assets", "evidence", "model-settings");
const dataDirectory = mkdtempSync(join(tmpdir(), "relayer-model-selector-evidence-"));
const services = [];
const ipcChannels = [];
const screenshots = {};
let mainWindow;
let exitCode = 1;
let appearance = "dark";

if (process.env[CAPTURE_OPT_IN] !== "1") {
  throw new Error(`Live catalog evidence capture is opt-in. Set ${CAPTURE_OPT_IN}=1 to run it.`);
}

app.setName("Relayer Model Selector Evidence");
const electronProfileDirectory = join(dataDirectory, "electron-profile");
mkdirSync(electronProfileDirectory, { recursive: true });
app.setPath("userData", electronProfileDirectory);
app.commandLine.appendSwitch("disable-gpu");

function registerIpc(channel, handler) {
  ipcMain.handle(channel, handler);
  ipcChannels.push(channel);
}

function registerEvidenceIpc(modelCatalog) {
  registerIpc("relayer:account-read", () => ({
    status: "connected",
    account: { email: "catalog-verified@relayer.test", planType: "Evidence" },
  }));
  registerIpc("relayer:account-login", () => ({ status: "connected" }));
  registerIpc("relayer:account-logout", () => ({ status: "disconnected" }));
  registerIpc("relayer:model-catalog-settings-open", () => modelCatalog.settingsOpened());
  registerIpc("relayer:model-catalog-refresh", (_event, providerId) => modelCatalog.explicitRefresh(providerId));
  registerIpc("relayer:folder-choose", () => null);
  registerIpc("relayer:appearance-read", () => ({ appearance }));
  registerIpc("relayer:appearance-set", (_event, value) => {
    appearance = value === "light" ? "light" : "dark";
    mainWindow?.setBackgroundColor(appearance === "light" ? "#fafafa" : "#0b0c0d");
    return { appearance };
  });
  registerIpc("relayer:update-status", () => ({
    phase: "development",
    channel: "stable",
    version: "evidence",
    availableVersion: null,
    percent: null,
    error: null,
  }));
  registerIpc("relayer:update-check", () => ({ phase: "development" }));
  registerIpc("relayer:update-download", () => ({ phase: "development" }));
  registerIpc("relayer:update-install", () => ({ installing: false }));
  registerIpc("relayer:update-channel", () => ({ phase: "development" }));
}

async function waitFor(label, check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function productRequest(session, path, init = {}) {
  const response = await fetch(new URL(path, session.origin), {
    ...init,
    headers: {
      Cookie: `${session.cookie.name}=${session.cookie.value}`,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value?.error?.message || JSON.stringify(value));
  return value;
}

async function evaluate(expression) {
  return mainWindow.webContents.executeJavaScript(expression);
}

async function capture(name, requirements) {
  // Let Chromium commit the last picker/tab render before capturePage reads it.
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  const path = join(outputDirectory, `${name}.png`);
  await writeFile(path, (await mainWindow.webContents.capturePage()).toPNG());
  screenshots[name] = { file: `${name}.png`, requirements };
  process.stdout.write(`Captured ${path}\n`);
}

async function captureSettings(name) {
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  const path = join(settingsOutputDirectory, `${name}.jpg`);
  await writeFile(path, (await mainWindow.webContents.capturePage()).toJPEG(92));
  process.stdout.write(`Captured ${path}\n`);
}

async function openPicker(rootSelector, tab = "model") {
  await evaluate(`document.querySelector(${JSON.stringify(`${rootSelector} [data-model-picker-trigger]`)})?.click()`);
  await waitFor(`${rootSelector} picker to open`, () => evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(rootSelector)});
    const popover = root?.querySelector('[data-model-picker-popover]');
    return Boolean(popover && !popover.classList.contains('hidden'));
  })()`));
  await evaluate(`(() => {
    const tab = document.querySelector(${JSON.stringify(`${rootSelector} [data-model-picker-tab="${tab}"]`)});
    tab?.focus();
    tab?.click();
  })()`);
  await waitFor(`${rootSelector} ${tab} tab`, () => evaluate(`document.querySelector(${JSON.stringify(`${rootSelector} [data-model-picker-tab="${tab}"]`)})?.getAttribute('aria-selected') === 'true'`));
}

async function closePicker(rootSelector) {
  const expanded = await evaluate(`document.querySelector(${JSON.stringify(`${rootSelector} [data-model-picker-trigger]`)})?.getAttribute('aria-expanded') === 'true'`);
  if (expanded) await evaluate(`document.querySelector(${JSON.stringify(`${rootSelector} [data-model-picker-trigger]`)})?.click()`);
}

async function acceptedThread(productSession, interactionCount) {
  return waitFor(`${interactionCount} accepted interactions`, async () => {
    const state = await productRequest(productSession, "/api/state");
    if (state.threads.length !== 1) return false;
    const detail = await productRequest(productSession, `/api/threads/${state.threads[0].id}`);
    if (detail.interactions.length !== interactionCount) return false;
    return detail.interactions.every((interaction) => interaction.completionStatus === "accepted")
      ? detail
      : false;
  }, 20_000);
}

async function run() {
  await mkdir(outputDirectory, { recursive: true });
  await mkdir(settingsOutputDirectory, { recursive: true });

  const credentials = new CodexCredentialAdapter();
  services.push(credentials);
  const runtime = new GraphCompleteRuntimeService({
    userDataDirectory: dataDirectory,
    graphServerBinary: join(repositoryRoot, "target", "debug", "relayer-graph-server"),
    configurationPaths: [
      join(repositoryRoot, "harnesses", "codex-basic.yaml"),
      join(repositoryRoot, "harnesses", "codex-basic-high.yaml"),
    ],
    // Deliberately execute the deterministic fixture behind the real codex-basic
    // product harness identity. Catalog discovery below is live; completion is not.
    additionalImplementations: { "codex.basic": taskSystemFixtureFactory },
  });
  services.push(runtime);
  const runtimeSession = await runtime.start();
  let product;
  const modelCatalog = new ModelCatalogService({
    adapters: [new CodexModelCatalogAdapter({ credentials })],
    publishSnapshot: (snapshot) => {
      if (!product) throw new Error("Relayer app server is not ready to accept a provider catalog.");
      return product.publishProviderCatalog(snapshot);
    },
  });
  const modelCatalogRefreshServer = await startModelCatalogRefreshServer({
    refresh: () => modelCatalog.beforeInference(),
  });
  services.push(modelCatalogRefreshServer);
  product = new RelayerAppServerService({
    userDataDirectory: dataDirectory,
    binaryPath: join(repositoryRoot, "target", "debug", "relayer-app-server"),
    webDirectory: join(repositoryRoot, "desktop", "renderer"),
    permissionCatalogPath: join(repositoryRoot, "permissions", "desktop.json"),
    runtimeSession,
    providerCatalogRefreshSession: modelCatalogRefreshServer.session,
    defaultHarnessConfiguration: "codex-basic",
  });
  services.push(product);
  const productSession = await product.start();
  const [catalog] = await modelCatalog.startup();
  if (catalog.provider.status !== "available" || catalog.systemFamily.modelIds.length < 2) {
    throw new Error("Evidence capture requires a connected Codex account with at least two visible models.");
  }
  registerEvidenceIpc(modelCatalog);

  const createWindow = createWindowFactory({
    BrowserWindow,
    desktopDirectory: join(repositoryRoot, "desktop"),
    getAppearance: () => appearance,
    updater: { status: () => ({ phase: "development" }) },
  });
  mainWindow = await createWindow(productSession);
  mainWindow.setSize(1420, 900);
  mainWindow.show();
  if (process.platform === "darwin") app.focus({ steal: true });
  mainWindow.focus();

  await waitFor("new-thread model selection", () => evaluate(`(() => {
    const control = document.querySelector('#newModelControl');
    const button = control?.querySelector('[data-model-picker-trigger]');
    const label = control?.querySelector('[data-model-picker-label]')?.textContent;
    return Boolean(button && !button.disabled && label && label !== 'Model' && label !== 'Set up models');
  })()`));
  await openPicker("#newModelControl");
  await waitFor("new-thread model options", () => evaluate(`document.querySelectorAll('#newModelControl [data-model-option]').length >= 2`));
  await capture("dark-new-thread-model", [
    "Model control is immediately left of Submit",
    "Folder and Permissions remain separate controls on the left",
    "Model tab selects family and then model",
  ]);

  await evaluate(`(() => {
    const tab = document.querySelector('#newModelControl [data-model-picker-tab="advanced"]');
    tab?.focus();
    tab?.click();
  })()`);
  await waitFor("both new-thread Advanced harness options", () => evaluate(`(() => {
    const advanced = document.querySelector('#newModelControl [data-model-picker-tab="advanced"]');
    return advanced?.getAttribute('aria-selected') === 'true'
      && document.querySelectorAll('#newModelControl [data-harness-option]').length >= 2;
  })()`));
  await capture("dark-new-thread-advanced", [
    "Advanced is a tab inside the Model picker",
    "Advanced selects the harness before thread creation",
  ]);
  await closePicker("#newModelControl");

  await evaluate(`(() => {
    const prompt = document.querySelector('#newThreadPrompt');
    prompt.value = 'Show the deterministic task system.';
    prompt.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  })()`);
  await waitFor("enabled new-thread submission", () => evaluate(`document.querySelector('#createThread')?.disabled === false`));
  await evaluate(`document.querySelector('#createThread')?.click()`);
  const firstThread = await acceptedThread(productSession, 1);
  await waitFor("visible enabled ongoing composer", () => evaluate(`(() => {
    const view = document.querySelector('#threadView');
    const prompt = document.querySelector('#threadPrompt');
    const trigger = document.querySelector('.model-control-ongoing [data-model-picker-trigger]');
    return Boolean(view && !view.classList.contains('hidden') && prompt && !prompt.disabled && trigger && !trigger.disabled);
  })()`));

  await openPicker(".model-control-ongoing");
  await waitFor("ongoing model choices", () => evaluate(`document.querySelectorAll('.model-control-ongoing [data-model-option]').length >= 2`));
  const selectedModel = await evaluate(`(() => {
    const options = [...document.querySelectorAll('.model-control-ongoing [data-model-option]')];
    const next = options.find((option) => option.getAttribute('aria-checked') !== 'true');
    if (!next) return null;
    next.click();
    return { providerId: next.dataset.providerId, modelId: next.dataset.modelId };
  })()`);
  if (!selectedModel) throw new Error("A second available Codex model is required for nth-turn evidence.");
  await closePicker(".model-control-ongoing");
  await evaluate(`(() => {
    const prompt = document.querySelector('#threadPrompt');
    prompt.value = 'Show the same system as a follow-up.';
    prompt.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  })()`);
  await waitFor("enabled follow-up submission", () => evaluate(`document.querySelector('#sendInteraction')?.disabled === false`));
  await evaluate(`document.querySelector('#sendInteraction')?.click()`);
  const secondThread = await acceptedThread(productSession, 2);
  await evaluate(`document.querySelector(${JSON.stringify(`[data-thread="${secondThread.id}"]`)})?.click()`);
  await waitFor("rendered nth-turn model identity and enabled composer", () => evaluate(`(() => {
    const identity = document.querySelector('#interactionModelIdentity');
    const prompt = document.querySelector('#threadPrompt');
    return document.querySelector('#interactionText')?.textContent === 'Show the same system as a follow-up.'
      && identity && !identity.classList.contains('hidden') && identity.textContent.trim()
      && prompt && !prompt.disabled;
  })()`));

  await openPicker(".model-control-ongoing");
  await capture("dark-nth-turn-model", [
    "Follow-ups inherit and may change model selection",
    "The accepted interaction shows its recorded model identity",
    "The ongoing composer keeps Model immediately left of Submit",
  ]);
  await evaluate(`(() => {
    const tab = document.querySelector('.model-control-ongoing [data-model-picker-tab="advanced"]');
    tab?.focus();
    tab?.click();
  })()`);
  await waitFor("pinned ongoing harness", () => evaluate(`(() => {
    const advanced = document.querySelector('.model-control-ongoing [data-model-picker-tab="advanced"]');
    return advanced?.getAttribute('aria-selected') === 'true'
      && Boolean(document.querySelector('.model-control-ongoing .pinned-harness'));
  })()`));
  await capture("dark-nth-turn-advanced", [
    "Advanced remains inside the Model picker on ongoing turns",
    "The thread harness is pinned and read-only after creation",
  ]);

  await closePicker(".model-control-ongoing");
  await evaluate(`document.querySelector('#newThread')?.click()`);
  await evaluate(`(() => {
    const select = document.querySelector('#appearanceSelect');
    select.value = 'light';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor("light appearance", () => evaluate(`document.documentElement.dataset.theme === 'light'`));
  await openPicker("#newModelControl");
  await capture("light-new-thread-model", [
    "The Model picker and composer controls remain legible in light mode",
  ]);

  await closePicker("#newModelControl");
  await evaluate(`document.querySelector('#settingsButton')?.click()`);
  await evaluate(`(() => {
    const tab = document.querySelector('[data-settings-tab="models"]');
    tab?.click();
    tab?.focus();
  })()`);
  await waitFor("loaded light model settings", () => evaluate(`(() => {
    const view = document.querySelector('#settingsView');
    return Boolean(view && !view.classList.contains('hidden') && document.querySelector('.family-card'));
  })()`));
  await captureSettings("light-defaults-and-system-family");

  await evaluate(`(() => {
    const select = document.querySelector('#appearanceSelect');
    select.value = 'dark';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor("dark Settings appearance", () => evaluate(`document.documentElement.dataset.theme === 'dark'`));
  await captureSettings("dark-defaults-and-system-family");

  await evaluate(`(() => {
    const select = document.querySelector('#appearanceSelect');
    select.value = 'light';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor("light Settings appearance", () => evaluate(`document.documentElement.dataset.theme === 'light'`));
  mainWindow.setSize(700, 900);
  await evaluate(`document.querySelector('#newModelFamily')?.click()`);
  await waitFor("narrow new-family editor", () => evaluate(`Boolean(document.querySelector('#familyNameInput'))`));
  await captureSettings("narrow-new-family-editor");

  const interactionModels = secondThread.interactions.map((interaction) => interaction.modelSelection);
  if (interactionModels[1]?.modelId !== selectedModel.modelId) {
    throw new Error(`Second interaction did not persist selected model ${selectedModel.modelId}.`);
  }
  if (secondThread.thread.harnessId !== "codex-basic") {
    throw new Error(`Thread did not retain pinned codex-basic harness: ${secondThread.thread.harnessId}`);
  }
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      product: "The real Electron product renderer and Rust app server",
      discovery: "Live Codex account/read and paginated model/list through CodexCredentialAdapter",
      completion: "Deterministic taskSystemFixtureFactory registered under the codex.basic implementation key",
      paidInferenceCalls: 0,
    },
    provider: {
      id: catalog.provider.id,
      status: catalog.provider.status,
      discoveredModelCount: catalog.models.length,
      visibleModelCount: catalog.models.filter((model) => model.visible).length,
      systemFamilyModelIds: catalog.systemFamily.modelIds,
    },
    thread: {
      id: secondThread.thread.id,
      harnessId: secondThread.thread.harnessId,
      interactionCount: secondThread.interactions.length,
      interactionModels,
      firstInteractionId: firstThread.interactions[0].id,
    },
    relatedScope: {
      issue54: "Intra-conversation approval prompt lifecycle is related work, not an Issue #34 dependency.",
      issue58: "An ongoing per-interaction approval-profile selector is related work, not an Issue #34 dependency.",
    },
    settingsScreenshots: {
      "dark-defaults-and-system-family": {
        file: "../model-settings/dark-defaults-and-system-family.jpg",
        requirements: ["Defaults contains only Harness and Provider", "One complete system family is visible in dark mode"],
      },
      "light-defaults-and-system-family": {
        file: "../model-settings/light-defaults-and-system-family.jpg",
        requirements: ["Defaults and model families remain legible in light mode"],
      },
      "narrow-new-family-editor": {
        file: "../model-settings/narrow-new-family-editor.jpg",
        requirements: ["New family appends an inline editable slide at the end of the horizontal carousel"],
      },
    },
    automatedEvidence: {
      discovery: "test/model-catalog.test.mjs",
      familySettings: "test/model-family-settings.test.mjs",
      pickerLogic: "test/model-picker-model.test.mjs",
      pickerUx: "test/model-picker-ui.test.mjs",
      rustCatalog: "crates/relayer-app-server/tests/model_catalog_flow.rs",
      rustRuntimePersistence: "crates/relayer-app-server/tests/product_persistence_flow.rs",
      zeroInferenceFirstMessage: "test/first-message-composer-integration.test.mjs",
    },
    screenshots,
  };
  await writeFile(join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`RELAYER_MODEL_SELECTOR_EVIDENCE ${JSON.stringify({
    passed: true,
    outputDirectory,
    provider: catalog.provider.id,
    systemFamilyModels: catalog.systemFamily.modelIds,
    interactionModels,
    harnessId: secondThread.thread.harnessId,
    paidInferenceCalls: 0,
    screenshots: Object.keys(screenshots),
  })}\n`);
  exitCode = 0;
}

async function shutdown() {
  mainWindow?.destroy();
  for (const channel of ipcChannels) ipcMain.removeHandler(channel);
  for (const service of services.reverse()) {
    try {
      await service.close();
    } catch (error) {
      process.stderr.write(`${error.stack || error.message}\n`);
      exitCode = 1;
    }
  }
  await rm(dataDirectory, { recursive: true, force: true });
  app.exit(exitCode);
}

process.stdout.write("Starting isolated model-selector evidence capture...\n");
void app.whenReady()
  .then(run)
  .catch((error) => process.stderr.write(`${error.stack || error.message}\n`))
  .finally(shutdown);
