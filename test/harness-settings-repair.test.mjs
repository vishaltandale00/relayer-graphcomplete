import { Window } from "happy-dom";
import { afterEach, expect, it, vi } from "vitest";

let window;
afterEach(async () => { await window?.happyDOM.close(); vi.unstubAllGlobals(); vi.resetModules(); });

it.each(["refresh failure", "readiness failure"])("repairs Prime through the exact router and retains retry after %s", async (failure) => {
  window = new Window({ url: "http://localhost/" });
  window.document.body.innerHTML = '<div id="harnessConfigurationList"></div><div id="toast" class="hidden"></div>';
  for (const name of ["window", "document", "location"]) vi.stubGlobal(name, name === "window" ? window : window[name]);
  let finish;
  const refresh = vi.fn(() => new Promise((resolve, reject) => { finish = { resolve, reject }; }));
  window.relayerDesktop = { models: { refresh } };
  const { appState } = await import("../desktop/renderer/src/state.js");
  const { setProviderModelsRefreshedHandler } = await import("../desktop/renderer/src/provider-models-refresh.js");
  const { renderHarnessSettings } = await import("../desktop/renderer/src/harness-settings.js");
  const { availablePickerFamilies } = await import("../desktop/renderer/src/model-picker-model.js");
  const settings = { defaults: { harnessId: "codex-basic", familyId: 1 },
    providers: [{ id: "router", adapterId: "openrouter", connected: true, models: [{ id: "qwen", visible: true, available: true }] }],
    families: [{ id: 1, enabled: true, members: [{ providerId: "router", modelId: "qwen" }] }],
    harnesses: [
      { id: "codex-basic", label: "Codex Basic", available: true, usableNow: true },
      { id: "prime-agent-basic", label: "Prime Agent Basic", available: false, permissionAvailable: true,
        repairProviderIds: ["router"], modelRules: { allow: [{ adapterId: "openrouter", modelIdRegex: ".*" }], deny: [] },
        unavailableReason: { message: "Prime setup is unavailable." } },
    ],
  };
  appState.modelSettings = settings;
  setProviderModelsRefreshedHandler(async () => renderHarnessSettings());
  renderHarnessSettings();
  const repair = () => document.querySelector('[data-harness-repair="prime-agent-basic"]');
  expect(availablePickerFamilies(settings, "prime-agent-basic")).toEqual([]);
  const first = repair().onclick();
  expect(refresh).toHaveBeenCalledWith("router");
  expect(repair().disabled).toBe(true);
  await repair().onclick();
  expect(refresh).toHaveBeenCalledOnce();
  if (failure === "refresh failure") finish.reject(new Error("Runtime download failed."));
  else finish.resolve();
  await first;
  expect(document.querySelector("#toast").textContent).toBe(failure === "refresh failure" ? "Runtime download failed." : "Prime setup is unavailable.");
  expect(repair().disabled).toBe(false);
  const second = repair().onclick();
  Object.assign(settings.harnesses[1], { available: true, usableNow: true, repairProviderIds: [] });
  finish.resolve();
  await second;
  expect(repair()).toBeNull();
  expect(availablePickerFamilies(settings, "prime-agent-basic")).toHaveLength(1);
  expect(settings.defaults).toEqual({ harnessId: "codex-basic", familyId: 1 });
});
