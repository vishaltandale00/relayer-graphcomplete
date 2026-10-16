import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ projection: null, saved: vi.fn(), completed: vi.fn(), status: null }));
vi.mock("../desktop/renderer/src/state.js", () => ({
  productApiAvailable: true,
  desktop: { providers: { status: async () => mocks.status, completeOnboarding: () => mocks.completed() } },
}));
vi.mock("../desktop/renderer/src/model-settings-api.js", () => ({
  completeDefaultProviderOnboarding: async () => null,
  loadProviderOnboardingProjection: async () => mocks.projection,
  completeProviderOnboarding: (intent) => mocks.saved(intent),
}));
let window;
afterEach(async () => { await window?.happyDOM.close(); vi.unstubAllGlobals(); vi.resetModules(); });

it("requires explicit designation, switches and removes orchestrators, and submits exact membership roles", async () => {
  window = new Window({ url: "http://localhost/" });
  window.document.body.innerHTML = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");
  for (const name of ["window", "document", "location"]) vi.stubGlobal(name, name === "window" ? window : window[name]);
  vi.stubGlobal("requestAnimationFrame", (callback) => { callback(); return 0; });
  mocks.status = { hasCompletedOnboarding: false, adapters: [], definitions: [{ id: "work", label: "Work", connected: true, lifecycleState: "active" }] };
  mocks.projection = { projectionRevision: "sha256:roles", initialHarnessId: "codex-basic", harnesses: [{ id: "codex-basic", label: "Codex", selectable: true, existingCustomFamilies: [], existingManagedFamilies: [], eligibleModels: [{ providerId: "work", modelId: "one", label: "One" }, { providerId: "work", modelId: "two", label: "Two" }] }] };
  mocks.saved.mockResolvedValue({});
  const { refreshAccount } = await import("../desktop/renderer/src/auth.js");
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
  change(orchestrator("two"));
  expect(orchestrator("one").checked).toBe(false);
  expect(finish().disabled).toBe(false);
  change(member("two"), false);
  expect(finish().disabled).toBe(true);
  change(orchestrator("one"));
  await finish().onclick();
  expect(mocks.saved).toHaveBeenCalledWith({ providerId: "work", harnessId: "codex-basic", expectedProjectionRevision: "sha256:roles", family: { kind: "create", name: "Work default", members: [{ providerId: "work", modelId: "one", roles: [{ name: "orchestrator" }] }] } });
  expect(mocks.completed).toHaveBeenCalledOnce();
});
