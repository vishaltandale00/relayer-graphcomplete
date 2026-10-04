import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import { afterEach, expect, it, vi } from "vitest";
import { createModelAvailabilityPublisher } from "../desktop/main/models/model-availability-publisher.mjs";
import { createHarnessReadinessCoordinator, startPostUpgradeReadiness } from "../desktop/main/services/harness-readiness.mjs";
import { watchModelAvailability } from "../desktop/renderer/src/model-availability-refresh.js";

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

it.each(["publishCatalog", "publishReadiness"])("%s announces only a committed write, independently of window delivery", async (method) => {
  let commit = deferred();
  const send = vi.fn();
  const publish = vi.fn(() => commit.promise);
  const publisher = createModelAvailabilityPublisher({ publishCatalog: publish, publishReadiness: publish, getWindow: () => ({ webContents: { send } }) });
  const input = { fixture: true };
  const options = { connectionGeneration: 4 };
  const success = publisher[method](input, options);
  expect(send).not.toHaveBeenCalled();
  commit.resolve("committed");
  await expect(success).resolves.toBe("committed");
  expect(publish).toHaveBeenCalledWith(input, options);
  expect(send.mock.calls).toEqual([["relayer:models-changed"]]);
  commit = deferred();
  const rejected = publisher[method](input);
  commit.reject(Object.assign(new Error("Superseded"), { code: "provider_connection_superseded" }));
  await expect(rejected).rejects.toMatchObject({ code: "provider_connection_superseded" });
  expect(send).toHaveBeenCalledTimes(1);
  commit = deferred();
  send.mockImplementation(() => { throw new Error("Window closed"); });
  const closed = publisher[method](input);
  commit.resolve("still committed");
  await expect(closed).resolves.toBe("still committed");
});

let window;
let watcher;
afterEach(async () => {
  watcher?.stop();
  watcher = null;
  await window?.happyDOM.close();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function rendererFixture() {
  window = new Window({ url: "http://localhost/" });
  window.document.body.innerHTML = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");
  for (const name of ["window", "document", "location", "navigator", "HTMLElement", "Element"]) {
    vi.stubGlobal(name, name === "window" ? window : window[name]);
  }
  vi.stubGlobal("requestAnimationFrame", (callback) => { callback(); return 0; });
  const settings = {
    defaults: { harnessId: "codex-basic", providerId: "personal", familyId: 1 },
    harnesses: [{ id: "codex-basic", label: "Codex", available: false, unavailableReason: { code: "harness_readiness_pending", message: "Pending" }, compatibleProviderIds: ["personal", "work"] }],
    providers: ["personal", "work"].map((id) => ({ id, label: id, connected: true, models: [{ id: "work-model", label: "Model", available: true, visible: true }] })),
    families: ["personal", "work"].map((providerId, index) => ({ id: index + 1, kind: "system", name: providerId, enabled: true, position: index, members: [{ providerId, modelId: "work-model", position: 0 }] })),
  };
  const read = vi.fn(async () => ({ ok: true, json: async () => structuredClone(settings) }));
  vi.stubGlobal("fetch", vi.fn((url) => {
    expect(url).toBe("/api/model-settings");
    return read();
  }));
  const { appState } = await import("../desktop/renderer/src/state.js");
  const { initializeModelFamilySettings, refreshModelFamilySettings } = await import("../desktop/renderer/src/model-family-settings.js");
  const { initializeNewThreadModelPicker, refreshNewThreadModelPicker, newThreadModelSelectionReady } = await import("../desktop/renderer/src/composer-model-picker.js");
  const { createModelPicker, modelPickerMarkup } = await import("../desktop/renderer/src/model-picker.js");
  await initializeModelFamilySettings();
  const selection = { harnessId: "codex-basic", familyId: 2, providerId: "work", modelId: "work-model" };
  const newPicker = initializeNewThreadModelPicker();
  newPicker.setContext({ selection, replaceSelection: true });
  const root = window.document.createElement("div");
  root.innerHTML = modelPickerMarkup({ mode: "ongoing" });
  window.document.body.append(root);
  const ongoing = createModelPicker({ root, mode: "ongoing", pinnedHarnessId: "codex-basic", settings: appState.modelSettings, selection });
  window.document.querySelector("#newThreadPrompt").value = "Keep my unsent draft";
  let listener;
  const unsubscribe = vi.fn(() => { listener = null; });
  const publisher = createModelAvailabilityPublisher({
    publishCatalog: async () => {},
    publishReadiness: async ([update]) => {
      settings.harnesses[0].available = update.available;
      settings.harnesses[0].unavailableReason = update.available ? null : { code: "harness_readiness_pending", message: "Pending" };
    },
    getWindow: () => ({ webContents: { send: (channel) => { expect(channel).toBe("relayer:models-changed"); listener?.(); } } }),
  });
  const onError = vi.fn();
  function start() {
    watcher = watchModelAvailability({
      subscribe: (callback) => { listener = callback; return unsubscribe; },
      refresh: async () => {
        await refreshModelFamilySettings();
        refreshNewThreadModelPicker();
        ongoing.setContext({ settings: appState.modelSettings });
      },
      onError,
    });
    return watcher.ready;
  }
  return { settings, appState, read, newPicker, ongoing, newThreadModelSelectionReady, selection, publisher, start, onError, unsubscribe };
}

it("automatically restores both composers after background upgrade readiness without changing draft or chosen routes", async () => {
  const f = await rendererFixture();
  await f.start();
  expect(f.newThreadModelSelectionReady()).toBe(false);
  expect(f.ongoing.isReady()).toBe(false);
  const runtime = deferred();
  const configuration = { name: "codex-basic", implementation: "codex.basic", executionAccessContracts: ["managed-runtime@1"], modelRules: { allow: [{ adapterId: "codex-subscription", modelIdRegex: "^work-" }], deny: [] } };
  const readiness = createHarnessReadinessCoordinator({
    configurations: new Map([[configuration.name, configuration]]), digestConfiguration: () => "fixture-upgraded",
    runtimeRequirements: { "codex.basic": { recipeId: "codex@fixture" } }, prepareRecipe: () => runtime.promise,
    checkers: { "codex.basic": async () => ({ available: true }) }, recipeInstalled: async () => true,
    publishAvailability: f.publisher.publishReadiness,
  });
  const upgrade = startPostUpgradeReadiness({ readiness, updatesDue: async () => [configuration.name], routes: async () => [{ providerDefinition: { id: "work", adapterId: "codex-subscription", accessContract: "managed-runtime@1" }, models: f.settings.providers[1].models }] });
  runtime.resolve({});
  await upgrade.evaluation;
  await vi.waitFor(() => expect(f.ongoing.isReady()).toBe(true));
  expect(f.newThreadModelSelectionReady()).toBe(true);
  expect(f.newPicker.getSelection()).toMatchObject(f.selection);
  expect(f.ongoing.getSelection()).toMatchObject(f.selection);
  expect(f.appState.modelSettings.defaults).toEqual(f.settings.defaults);
  expect(window.document.querySelector("#newThreadPrompt").value).toBe("Keep my unsent draft");
  expect(f.onError).not.toHaveBeenCalled();
});

it("catches commits before subscription and drains a burst behind a stale read to the latest persisted state", async () => {
  const f = await rendererFixture();
  await f.publisher.publishReadiness([{ available: true }]); // No window listener yet.
  await f.start();
  expect(f.ongoing.isReady()).toBe(true);
  const oldSnapshot = structuredClone(f.settings);
  const stalled = deferred();
  f.read.mockImplementationOnce(() => stalled.promise);
  await f.publisher.publishCatalog({});
  await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(3));
  await f.publisher.publishReadiness([{ available: false }]);
  await f.publisher.publishCatalog({});
  stalled.resolve({ ok: true, json: async () => oldSnapshot });
  await vi.waitFor(() => expect(f.ongoing.isReady()).toBe(false));
  expect(f.read).toHaveBeenCalledTimes(4);
  expect(f.newThreadModelSelectionReady()).toBe(false);
  await f.publisher.publishReadiness([{ available: true }]);
  await vi.waitFor(() => expect(f.ongoing.isReady()).toBe(true));
});

it("recovers from a failed catalog reread on the next commit and unsubscribes on teardown", async () => {
  const f = await rendererFixture();
  f.read.mockRejectedValueOnce(new Error("Read failed"));
  await f.start();
  expect(f.onError).toHaveBeenCalledTimes(1);
  expect(f.ongoing.isReady()).toBe(false);
  await f.publisher.publishReadiness([{ available: true }]);
  await vi.waitFor(() => expect(f.ongoing.isReady()).toBe(true));
  watcher.stop();
  expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  const reads = f.read.mock.calls.length;
  await f.publisher.publishReadiness([{ available: false }]);
  await Promise.resolve();
  expect(f.read).toHaveBeenCalledTimes(reads);
});

it("wires both production publishers and the preload channel to a refresh after workspace initialization", async () => {
  const [main, preload, renderer] = await Promise.all([
    readFile(new URL("../desktop/main/index.mjs", import.meta.url), "utf8"),
    readFile(new URL("../desktop/preload/index.cjs", import.meta.url), "utf8"),
    readFile(new URL("../desktop/renderer/src/main.js", import.meta.url), "utf8"),
  ]);
  expect(main).toContain("publishAvailability: modelAvailability.publishReadiness");
  expect(main).toContain("const publishCatalog = modelAvailability.publishCatalog");
  expect(preload).toContain('onChanged: (callback) => subscribe("relayer:models-changed", callback)');
  expect(renderer.indexOf("const availabilityRefresh = watchModelAvailability")).toBeGreaterThan(renderer.indexOf("connectEvents();"));
  expect(renderer).toMatch(/subscribe: desktop.models.onChanged,[\s\S]*await refreshProviderSettings\(\);\s*await refreshProviderModelUi\(\);/);
});
