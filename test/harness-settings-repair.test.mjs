import { readFile } from "node:fs/promises";
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
  repair().focus();
  const first = repair().onclick();
  expect(refresh).toHaveBeenCalledWith("router");
  expect(repair().getAttribute("aria-disabled")).toBe("true");
  expect(document.activeElement).toBe(repair());
  await repair().onclick();
  expect(refresh).toHaveBeenCalledOnce();
  if (failure === "refresh failure") finish.reject(new Error("Runtime download failed."));
  else finish.resolve();
  await first;
  expect(document.querySelector("#toast").textContent).toBe(failure === "refresh failure" ? "Runtime download failed." : "Prime setup is unavailable.");
  expect(repair().getAttribute("aria-disabled")).toBe("false");
  expect(document.activeElement).toBe(repair());
  const second = repair().onclick();
  if (failure === "refresh failure") {
    const elsewhere = document.createElement("button"); document.body.append(elsewhere); elsewhere.focus();
  }
  Object.assign(settings.harnesses[1], { available: true, usableNow: true, repairProviderIds: [] });
  finish.resolve();
  await second;
  expect(repair()).toBeNull();
  if (failure === "readiness failure") expect(document.activeElement).toBe(document.querySelector("#harnessConfigurationList"));
  else expect(document.activeElement).toBe(document.body.lastElementChild);
  expect(availablePickerFamilies(settings, "prime-agent-basic")).toHaveLength(1);
  expect(settings.defaults).toEqual({ harnessId: "codex-basic", familyId: 1 });
});


it.each([...([true, false].flatMap(available => ["repair first", "notification first"].map(order => [available, order]))), [true, "notification error"]])
  ("awaits current settings during overlapping Repair reads (available=%s, %s)", async (available, order) => {
    window = new Window({ url: "http://localhost/" });
    const html = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");
    window.document.write(html.replace(/<script[\s\S]*?<\/script>/g, ""));
    for (const name of ["window", "document", "location"]) vi.stubGlobal(name, name === "window" ? window : window[name]);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    window.relayerDesktop = { models: { refresh: vi.fn(async () => {}) } };
    const initial = JSON.parse(await readFile(new URL("./fixtures/model-settings-default-family-recovery.json", import.meta.url), "utf8"));
    const harness = initial.harnesses.find(({ id }) => id === "codex-basic");
    Object.assign(harness, { available: false, permissionAvailable: true, repairProviderIds: ["codex"], unavailableReason: { code: "runtime_missing", message: "Still unavailable." } });
    const current = structuredClone(initial);
    Object.assign(current.harnesses.find(({ id }) => id === "codex-basic"), { available, repairProviderIds: available ? [] : ["codex"] });
    let fetches = 0; const reads = [];
    const response = value => new Response(JSON.stringify(value), { status: 200 });
    vi.stubGlobal("fetch", vi.fn(async () => {
      fetches += 1;
      if (fetches === 1) return response(initial);
      if (fetches <= 3) {
        const readNumber = fetches;
        return new Promise(resolve => reads.push(() => resolve(order === "notification error" && readNumber === 3
          ? new Response(JSON.stringify({ error: "Notification reload failed." }), { status: 503 }) : response(current))));
      }
      throw new Error("Repair must join the current read, not start an extra one.");
    }));
    const settings = await import("../desktop/renderer/src/model-family-settings.js");
    const { setProviderModelsRefreshedHandler } = await import("../desktop/renderer/src/provider-models-refresh.js");
    setProviderModelsRefreshedHandler(() => settings.refreshModelFamilySettings());
    await settings.initializeModelFamilySettings();
    const repair = document.querySelector('[data-harness-repair="codex-basic"]');
    repair.focus(); const repairing = repair.onclick();
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    const notification = settings.refreshModelFamilySettings().catch(error => error);
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    if (order === "notification first") { reads[1](); await notification; reads[0](); await repairing; }
    else {
      let settled = false; const operation = repairing.then(() => { settled = true; });
      reads[0](); await new Promise(resolve => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      reads[1](); await notification; await operation;
    }
    if (order === "notification error") expect((await notification).message).toBe("Notification reload failed.");
    expect(document.querySelector("#toast").textContent).toBe(order === "notification error" ? "Notification reload failed." : available ? "Codex Basic repaired." : "Still unavailable.");
    expect(document.querySelector('[data-harness-repair="codex-basic"]') === null).toBe(order === "notification error" ? false : available);
    expect(window.relayerDesktop.models.refresh).toHaveBeenCalledOnce();
  });
