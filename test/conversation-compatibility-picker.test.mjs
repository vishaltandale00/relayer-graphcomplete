import { readFile } from "node:fs/promises";

import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createModelPicker, modelPickerMarkup, modelPickerModelSetup } from "../desktop/renderer/src/model-picker.js";

// The app server's /api/model-settings response after the default provider disconnected. Every
// provider is disconnected and no family awaits model setup, so the picker shows its empty state.
// Only the conversation's compatibility status varies below.
const disconnected = JSON.parse(await readFile(
  new URL("./fixtures/model-settings-default-family-disconnected.json", import.meta.url),
  "utf8",
));

// The same server's response while the default family awaits model setup (PROV-008): its provider
// stays connected and the picker offers that provider's model refresh.
const recovering = JSON.parse(await readFile(
  new URL("./fixtures/model-settings-default-family-recovery.json", import.meta.url),
  "utf8",
));

afterEach(() => vi.unstubAllGlobals());

function openPicker(conversationCompatibility) {
  vi.stubGlobal("requestAnimationFrame", (callback) => { callback(); return 0; });
  const window = new Window({ url: "http://127.0.0.1/" });
  vi.stubGlobal("document", window.document);
  window.document.body.innerHTML = modelPickerMarkup({ mode: "ongoing" });
  const root = window.document.querySelector('[data-model-picker="ongoing"]');
  const settings = structuredClone(disconnected);
  for (const provider of settings.providers) provider.connected = false;
  const picker = createModelPicker({
    root,
    mode: "ongoing",
    settings: {
      ...settings,
      defaultFamilyRecovery: null,
      familiesNeedingModelSetup: [],
      conversationCompatibility,
    },
    pinnedHarnessId: "codex-basic",
    selection: { harnessId: "codex-basic", familyId: 1, providerId: "codex", modelId: "gpt-5.6-terra" },
  });
  picker.open();
  return { root, picker };
}

describe("model picker for a continuation conversation (CONT-005)", () => {
  it.each([
    [{ status: "unrestricted", threadId: 1, harnessId: "codex-basic" }, "No available models", "Connect an available provider in Settings."],
    [{ status: "portable", threadId: 1, harnessId: "codex-basic" }, "No available models", "Connect an available provider in Settings."],
    [{ status: "compatible", threadId: 1, harnessId: "codex-basic", providerId: "codex" }, "No compatible route available", "Reconnect the original provider or enable a compatible model in Settings."],
    [{ status: "blocked", threadId: 1, harnessId: "codex-basic", message: "History ownership cannot be verified." }, "No compatible route available", "History ownership cannot be verified."],
    // The empty-state heading treats an unknown or missing status as restricted. Connected-route
    // filtering for those statuses is covered in model-picker-model.test.mjs.
    [{ threadId: 1, harnessId: "codex-basic" }, "No compatible route available", "Connect an available provider in Settings."],
    [{ status: "future-status", threadId: 1, harnessId: "codex-basic" }, "No compatible route available", "Connect an available provider in Settings."],
  ])("contains only a legacy conversation to its original route: %j", (compatibility, heading, guidance) => {
    const { root, picker } = openPicker(compatibility);
    const empty = root.querySelector(".model-picker-empty");
    expect(empty?.querySelector("strong")?.textContent).toBe(heading);
    expect(empty?.querySelector("span")?.textContent).toBe(guidance);
    picker.dispose();
  });
});

describe("model setup recovery for an unrecognised compatibility status", () => {
  const selection = { harnessId: "codex-basic", familyId: 1, providerId: "codex", modelId: "gpt-5.6-terra" };
  it.each([
    [{ status: "unrestricted", threadId: 1, harnessId: "codex-basic" }, true],
    [{ status: "portable", threadId: 1, harnessId: "codex-basic" }, true],
    [{ threadId: 1, harnessId: "codex-basic" }, false],
    [{ status: "future-status", threadId: 1, harnessId: "codex-basic" }, false],
  ])("offers the provider refresh only for an open route: %j", (conversationCompatibility, offered) => {
    const setup = modelPickerModelSetup({ ...structuredClone(recovering), conversationCompatibility }, selection);
    expect(setup !== null).toBe(offered);
  });
});
