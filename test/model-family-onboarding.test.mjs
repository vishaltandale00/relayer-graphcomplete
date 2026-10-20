import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import { afterEach, expect, it, vi } from "vitest";
import { createModelAvailabilityPublisher } from "../desktop/main/models/model-availability-publisher.mjs";
import { watchModelAvailability } from "../desktop/renderer/src/model-availability-refresh.js";

const mocks = vi.hoisted(() => ({ projection: null, projectionRead: null, saved: vi.fn(), completed: vi.fn(), defaulted: vi.fn(async () => null), status: null, statusRead: null }));
vi.mock("../desktop/renderer/src/state.js", () => ({
  productApiAvailable: true,
  desktop: { providers: { status: async () => mocks.statusRead ? mocks.statusRead() : structuredClone(mocks.status), completeOnboarding: () => mocks.completed() } },
}));
vi.mock("../desktop/renderer/src/model-settings-api.js", () => ({
  completeDefaultProviderOnboarding: (providerId) => mocks.defaulted(providerId),
  loadProviderOnboardingProjection: async () => mocks.projectionRead ? mocks.projectionRead() : structuredClone(mocks.projection),
  completeProviderOnboarding: (intent) => mocks.saved(intent),
}));
let window;
let watcher;
afterEach(async () => { watcher?.stop(); watcher = null; mocks.projectionRead = null; mocks.statusRead = null; await window?.happyDOM.close(); vi.unstubAllGlobals(); vi.resetModules(); vi.clearAllMocks(); });

it("refreshes real onboarding from Preparing to ready or Repair without discarding a pending family choice", async () => {
  window = new Window({ url: "http://localhost/" });
  window.document.body.innerHTML = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");
  for (const name of ["window", "document", "location"]) vi.stubGlobal(name, name === "window" ? window : window[name]);
  vi.stubGlobal("requestAnimationFrame", (callback) => { callback(); return 0; });
  const reason = { code: "provider_no_available_execution_configurations", message: "Execution setup is unavailable." };
  mocks.status = { hasCompletedOnboarding: false, adapters: [], definitions: [{
    id: "work", label: "Work", connected: true, lifecycleState: "active", executionPreparing: true, unavailableReason: reason,
  }] };
  const readyProjection = { provider: { id: "work", label: "Work" }, projectionRevision: "ready", initialHarnessId: "codex-basic", harnesses: [{
    id: "codex-basic", label: "Codex", selectable: true,
    existingCustomFamilies: [{ id: 9, name: "Chosen family", members: [] }], existingManagedFamilies: [], eligibleModels: [],
  }] };
  mocks.projection = structuredClone(readyProjection);
  const auth = await import("../desktop/renderer/src/auth.js");
  await auth.refreshAccount();
  const options = () => window.document.querySelector("#providerSetupOptions");
  expect(options().textContent).toContain("Preparing");
  expect(options().textContent).not.toContain("Connected and ready");
  expect(options().querySelector("[data-resume-provider-onboarding]").disabled).toBe(true);
  let listener;
  const publisher = createModelAvailabilityPublisher({
    publishCatalog: async () => {}, publishReadiness: async () => {},
    getWindow: () => ({ webContents: { send: () => listener?.() } }),
  });
  watcher = watchModelAvailability({
    subscribe: (callback) => { listener = callback; return () => { listener = null; }; },
    refresh: auth.refreshProviderOnboarding,
    onError: (error) => { throw error; },
  });
  await watcher.ready;
  mocks.status.definitions[0].executionPreparing = false;
  mocks.status.definitions[0].unavailableReason = null;
  publisher.notifyReadinessProgress();
  await vi.waitFor(() => expect(options().querySelector("[data-resume-provider-onboarding]").disabled).toBe(false));
  options().querySelector("[data-resume-provider-onboarding]").click();
  await vi.waitFor(() => expect(window.document.querySelector('[data-onboarding-family-id="9"]')).not.toBeNull());
  window.document.querySelector('[data-onboarding-family-id="9"]').click();
  expect(window.document.querySelector("#finishProviderSetup").disabled).toBe(false);
  const defaultAttempts = mocks.defaulted.mock.calls.length;
  mocks.status.definitions[0].executionPreparing = true;
  mocks.status.definitions[0].unavailableReason = reason;
  mocks.projection = { ...structuredClone(readyProjection), initialHarnessId: null, blockingReason: reason,
    harnesses: [] };
  publisher.notifyReadinessProgress();
  await vi.waitFor(() => expect(window.document.querySelector("#authStatus").textContent).toContain("Preparing"));
  expect(window.document.querySelector("#refreshOnboardingProviderModels").classList.contains("hidden")).toBe(true);
  expect(window.document.querySelector("#finishProviderSetup").disabled).toBe(true);
  expect(window.document.querySelector('[data-onboarding-family-id="9"]').getAttribute("aria-checked")).toBe("true");
  mocks.status.definitions[0].executionPreparing = false;
  mocks.status.definitions[0].unavailableReason = null;
  mocks.projection = structuredClone(readyProjection);
  publisher.notifyReadinessProgress();
  await vi.waitFor(() => expect(window.document.querySelector("#finishProviderSetup").disabled).toBe(false));
  expect(window.document.querySelector('[data-onboarding-family-id="9"]').getAttribute("aria-checked")).toBe("true");
  expect(mocks.saved).not.toHaveBeenCalled();
  expect(mocks.completed).not.toHaveBeenCalled();
  expect(mocks.defaulted).toHaveBeenCalledTimes(defaultAttempts);
  mocks.status.definitions[0].unavailableReason = reason;
  mocks.projection = { ...structuredClone(readyProjection), initialHarnessId: null, blockingReason: reason,
    harnesses: [] };
  publisher.notifyReadinessProgress();
  await vi.waitFor(() => expect(window.document.querySelector("#refreshOnboardingProviderModels").classList.contains("hidden")).toBe(false));
  expect(window.document.querySelector("#refreshOnboardingProviderModels").textContent).toBe("Repair");
  expect(window.document.querySelector("#finishProviderSetup").disabled).toBe(true);
  expect(mocks.defaulted).toHaveBeenCalledTimes(defaultAttempts);
});

it("requires explicit designation, switches and removes orchestrators, and submits exact membership roles", async () => {
  window = new Window({ url: "http://localhost/" });
  window.document.body.innerHTML = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");
  for (const name of ["window", "document", "location"]) vi.stubGlobal(name, name === "window" ? window : window[name]);
  vi.stubGlobal("requestAnimationFrame", (callback) => { callback(); return 0; });
  mocks.status = { hasCompletedOnboarding: false, adapters: [], definitions: [{ id: "work", label: "Work", connected: true, lifecycleState: "active" }] };
  mocks.projection = { projectionRevision: "sha256:roles", initialHarnessId: "codex-basic", harnesses: [{ id: "codex-basic", label: "Codex", selectable: true, existingCustomFamilies: [], existingManagedFamilies: [], eligibleModels: [{ providerId: "work", modelId: "one", label: "One" }, { providerId: "work", modelId: "two", label: "Two" }] }] };
  mocks.saved.mockResolvedValue({});
  const { refreshAccount, refreshProviderOnboarding } = await import("../desktop/renderer/src/auth.js");
  await refreshAccount();
  window.document.querySelector('[data-resume-provider-onboarding="work"]').click();
  await vi.waitFor(() => expect(window.document.querySelector('[data-onboarding-family-kind="create"]')).not.toBeNull());
  window.document.querySelector('[data-onboarding-family-kind="create"]').click();
  const finish = () => window.document.querySelector("#finishProviderSetup");
  const member = (model) => window.document.querySelector(`[data-onboarding-member-model="${model}"]`);
  const orchestrator = (model) => window.document.querySelector(`[data-onboarding-orchestrator-model="${model}"]`);
  const change = (input, checked = true) => { input.checked = checked; input.dispatchEvent(new window.Event("change")); };
  change(member("one"));
  change(member("two"));
  expect(finish().disabled).toBe(true);
  expect([...window.document.querySelectorAll('[data-onboarding-orchestrator-model]')].some((input) => input.checked)).toBe(false);
  change(orchestrator("one"));
  expect(finish().disabled).toBe(false);
  const name = window.document.querySelector("#onboardingFamilyName");
  name.value = "Keep this draft";
  name.dispatchEvent(new window.Event("input"));
  name.focus();
  name.setSelectionRange(4, 8);
  const readyProjection = structuredClone(mocks.projection);
  mocks.status.definitions[0].executionPreparing = true;
  mocks.status.definitions[0].unavailableReason = { code: "provider_no_available_execution_configurations" };
  mocks.projection = { ...mocks.projection, harnesses: [], initialHarnessId: null };
  const defaultAttempts = mocks.defaulted.mock.calls.length;
  await refreshProviderOnboarding();
  expect(finish().disabled).toBe(true);
  expect(document.activeElement.id).toBe("onboardingFamilyName");
  expect([document.activeElement.selectionStart, document.activeElement.selectionEnd]).toEqual([4, 8]);
  mocks.status.definitions[0].executionPreparing = false;
  mocks.status.definitions[0].unavailableReason = null;
  mocks.projection = readyProjection;
  await refreshProviderOnboarding();
  expect(window.document.querySelector("#onboardingFamilyName").value).toBe("Keep this draft");
  expect(document.activeElement.id).toBe("onboardingFamilyName");
  expect([document.activeElement.selectionStart, document.activeElement.selectionEnd]).toEqual([4, 8]);
  expect(member("one").checked && member("two").checked && orchestrator("one").checked).toBe(true);
  expect(finish().disabled).toBe(false);
  expect(mocks.defaulted).toHaveBeenCalledTimes(defaultAttempts);
  change(orchestrator("two"));
  expect(orchestrator("one").checked).toBe(false);
  expect(finish().disabled).toBe(false);
  change(member("two"), false);
  expect(finish().disabled).toBe(true);
  change(orchestrator("one"));
  await finish().onclick();
  expect(mocks.saved).toHaveBeenCalledWith({ providerId: "work", harnessId: "codex-basic", expectedProjectionRevision: "sha256:roles", family: { kind: "create", name: "Keep this draft", members: [{ providerId: "work", modelId: "one", roles: [{ name: "orchestrator" }] }] } });
  expect(mocks.completed).toHaveBeenCalledOnce();
});

it.each(["status", "projection"])("keeps Back and a typed credential form intact when a background %s returns late", async (stage) => {
  window = new Window({ url: "http://localhost/" });
  window.document.body.innerHTML = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");
  for (const name of ["window", "document", "location"]) vi.stubGlobal(name, name === "window" ? window : window[name]);
  vi.stubGlobal("requestAnimationFrame", (callback) => { callback(); return 0; });
  mocks.status = { hasCompletedOnboarding: false,
    adapters: [{ adapterId: "openai-api", label: "OpenAI API", defaultEndpoint: "https://api.openai.com/v1", connection: {
      mode: "secret-fields", fields: [{ id: "apiKey", label: "API key", kind: "secret", required: true }],
    } }], definitions: [{ id: "work", label: "Work", connected: true, lifecycleState: "active" }] };
  mocks.projection = { provider: { id: "work", label: "Work" }, projectionRevision: "ready", initialHarnessId: null, harnesses: [] };
  const auth = await import("../desktop/renderer/src/auth.js");
  await auth.refreshAccount();
  window.document.querySelector('[data-resume-provider-onboarding="work"]').click();
  await vi.waitFor(() => expect(window.document.querySelector("#providerFamilyStep").classList.contains("hidden")).toBe(false));
  let resolve;
  const read = vi.fn(() => new Promise(done => { resolve = done; }));
  if (stage === "status") mocks.statusRead = read;
  else mocks.projectionRead = read;
  const pending = auth.refreshProviderOnboarding();
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  window.document.querySelector("#providerFamilyBack").click();
  window.document.querySelector('[data-provider-adapter="openai-api"]').click();
  const input = window.document.querySelector("#providerField-apiKey");
  input.value = "fixture-secret-not-a-real-credential";
  input.focus();
  input.setSelectionRange(2, 5);
  const duringTyping = auth.refreshProviderOnboarding();
  resolve(structuredClone(stage === "status" ? mocks.status : mocks.projection));
  await Promise.all([pending, duringTyping]);
  expect(window.document.querySelector("#providerFamilyStep").classList.contains("hidden")).toBe(true);
  expect(window.document.querySelector("#providerSetupForm").classList.contains("hidden")).toBe(false);
  expect(window.document.querySelector("#providerField-apiKey")).toBe(input);
  expect(input.value).toBe("fixture-secret-not-a-real-credential");
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5]);
  expect(mocks.defaulted).not.toHaveBeenCalled();
  expect(mocks.saved).not.toHaveBeenCalled();
  expect(mocks.completed).not.toHaveBeenCalled();
});
