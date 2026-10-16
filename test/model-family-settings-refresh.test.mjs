import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../desktop/renderer/src/composer-model-picker.js", () => ({ refreshNewThreadModelPicker() {}, resetNewThreadModelPicker() {} }));
vi.mock("../desktop/renderer/src/permission-profiles.js", () => ({ preparePermissionProfiles: async () => () => {} }));
vi.mock("../desktop/renderer/src/harness-settings.js", () => ({ renderHarnessSettings() {} }));

let window;
afterEach(async () => { await window?.happyDOM.close(); vi.unstubAllGlobals(); vi.resetModules(); });

it.each(["started", "edited", "cancelled"])("preserves a family draft %s while provider refresh is in flight", async (action) => {
  window = new Window({ url: "http://localhost/" });
  window.document.body.innerHTML = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");
  for (const name of ["window", "document", "location"]) vi.stubGlobal(name, name === "window" ? window : window[name]);
  vi.stubGlobal("requestAnimationFrame", (callback) => { callback(); return 0; });
  const provider = { id: "codex", label: "Codex", connected: true, models: [{ id: "model", label: "Model", available: true }] };
  const settings = { providers: [provider], harnesses: [], defaults: { providerId: "codex" }, families: [{ id: 1, kind: "system", name: "Codex", enabled: true, position: 0, members: [{ providerId: "codex", modelId: "model", position: 0, roles: [{ name: "orchestrator" }] }] }] };
  let completeRefresh;
  let deferRefresh = false;
  let saved;
  vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
    if (options.method === "POST") {
      saved = JSON.parse(options.body);
      settings.families.push({ ...saved, id: 2, kind: "custom", position: 1 });
      return { ok: true, json: async () => settings.families[1] };
    }
    if (deferRefresh) { deferRefresh = false; return new Promise((resolve) => { completeRefresh = () => resolve({ ok: true, json: async () => structuredClone(settings) }); }); }
    return { ok: true, json: async () => structuredClone(settings) };
  }));
  const { initializeModelFamilySettings, refreshModelFamilySettings } = await import("../desktop/renderer/src/model-family-settings.js");
  await initializeModelFamilySettings();
  if (action !== "started") window.document.querySelector("#newModelFamily").click();
  deferRefresh = true;
  const refresh = refreshModelFamilySettings();
  if (action === "started") window.document.querySelector("#newModelFamily").click();
  const input = window.document.querySelector("#familyNameInput");
  input.value = "My eval models";
  input.dispatchEvent(new window.Event("input"));
  if (action === "cancelled") window.document.querySelector("#cancelFamilyEdit").click();
  completeRefresh();
  await refresh;
  if (action === "cancelled") {
    expect(window.document.querySelector("#saveFamilyEdit")).toBeNull();
    expect(window.document.querySelector("#familyPosition").textContent).toBe("1 / 1");
    return;
  }
  expect(window.document.querySelector("#familyNameInput")?.value).toBe("My eval models");
  window.document.querySelector("[data-member-orchestrator]").checked = true;
  window.document.querySelector("[data-member-orchestrator]").dispatchEvent(new window.Event("change"));
  await window.document.querySelector("#saveFamilyEdit").onclick();
  expect(saved).toEqual({ name: "My eval models", enabled: true, members: [{ providerId: "codex", modelId: "model", roles: [{ name: "orchestrator" }] }] });
});

it("edits multiple roles, saves and reopens them, and focuses unavailable default-family recovery", async () => {
  window = new Window({ url: "http://localhost/" });
  window.document.body.innerHTML = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");
  for (const name of ["window", "document", "location"]) vi.stubGlobal(name, name === "window" ? window : window[name]);
  vi.stubGlobal("requestAnimationFrame", (callback) => { callback(); return 0; });
  const settings = {
    defaults: { harnessId: "codex-basic", providerId: "codex", familyId: 2 },
    harnesses: [{ id: "codex-basic", available: true, compatibleProviderIds: ["codex"], usableNow: true, usableFamilyIds: [1,2] }],
    providers: [{ id: "codex", label: "Codex", connected: true, models: [{ id: "one", available: true }, { id: "two", available: true }] }],
    families: [
      { id: 1, kind: "system", name: "Managed", enabled: true, position: 0, members: [{ providerId: "codex", modelId: "one", position: 0, roles: [{ name: "orchestrator" }] }] },
      { id: 2, kind: "custom", name: "Custom", enabled: true, position: 1, members: [{ providerId: "codex", modelId: "two", position: 0, roles: [{ name: "orchestrator" }] }] },
    ],
  };
  let saved;
  vi.stubGlobal("fetch", vi.fn(async (_url, options = {}) => {
    if (options.method === "PUT") {
      saved = JSON.parse(options.body);
      settings.families[1] = { ...settings.families[1], ...saved };
      return { ok: true, json: async () => structuredClone(settings.families[1]) };
    }
    return { ok: true, json: async () => structuredClone(settings) };
  }));
  const { initializeModelFamilySettings, refreshModelFamilySettings } = await import("../desktop/renderer/src/model-family-settings.js");
  await initializeModelFamilySettings();
  window.document.querySelector('[data-family-edit="1"]').click();
  for (const [name, description] of [["coding", "Implement changes"], ["research", "Find sources"]]) {
    window.document.querySelector('[data-role-add="0"]').click();
    const names = window.document.querySelectorAll('[data-role-name]');
    const descriptions = window.document.querySelectorAll('[data-role-description]');
    names[names.length - 1].value = name;
    names[names.length - 1].dispatchEvent(new window.Event("input"));
    descriptions[descriptions.length - 1].value = description;
    descriptions[descriptions.length - 1].dispatchEvent(new window.Event("input"));
  }
  await window.document.querySelector("#saveFamilyEdit").onclick();
  expect(saved.members[0].roles).toEqual([{ name: "orchestrator" }, { name: "coding", description: "Implement changes" }, { name: "research", description: "Find sources" }]);
  await refreshModelFamilySettings();
  window.document.querySelector('[data-family-edit="1"]').click();
  expect([...window.document.querySelectorAll('[data-role-name]')].map((input) => input.value)).toEqual(["coding", "research"]);
  window.document.querySelector("#cancelFamilyEdit").click();
  settings.providers[0].models[1].available = false;
  await refreshModelFamilySettings();
  const action = window.document.querySelector("#refreshDefaultFamilyModels");
  expect(action.classList.contains("hidden")).toBe(false);
  expect(action.textContent).toBe("Open Model Families");
  await action.onclick();
  expect(window.document.querySelector("#currentFamilyName").textContent).toBe("Custom");
  expect(window.document.activeElement).toBe(window.document.querySelector('[data-family-edit="1"]'));
  settings.providers[0].models[1].available = true;
  settings.harnesses[0].available = false;
  settings.harnesses.push({ id: "compatible", label: "Compatible", available: true, compatibleProviderIds: ["codex"], usableNow: true, usableFamilyIds: [2] });
  await refreshModelFamilySettings();
  const harness = window.document.querySelector("#defaultHarnessSelect");
  expect(harness.disabled).toBe(false);
  expect(harness.querySelector('option[value="compatible"]')?.disabled).toBe(false);
});
