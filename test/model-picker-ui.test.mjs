import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  followupRequestBody,
  markFollowupSendSucceeded,
  newThreadRequestBody,
  stableFollowupInputId,
} from "../desktop/renderer/src/interaction-request-model.js";
import {
  createModelPickerRequestGate,
  interactionModelSelection,
  modelPickerClickIsOutside,
  modelPickerCycleIndex,
  modelPickerKeyIntent,
  modelPickerMarkup,
  modelSelectionLabels,
} from "../desktop/renderer/src/model-picker.js";
import { productWorkspaceMarkup } from "../desktop/renderer/src/product-workspace/view.js";
import { escapeHtmlAttribute } from "../desktop/renderer/src/ui.js";

const settings = {
  families: [{ id: 7, name: "Codex latest", enabled: true, position: 0 }],
  providers: [{
    id: "codex",
    label: "Codex",
    models: [{ id: "gpt-5", label: "GPT-5", available: true, visible: true }],
  }],
};

describe("composer model picker UI contract", () => {
  it("places Model immediately before Submit in both composers", async () => {
    const index = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");
    const newModel = index.indexOf('id="newModelControl"');
    const newSubmit = index.indexOf('id="createThread"');
    expect(newModel).toBeGreaterThan(index.indexOf('id="permissionButton"'));
    expect(newModel).toBeLessThan(newSubmit);

    const ongoing = productWorkspaceMarkup();
    expect(ongoing.indexOf('data-model-picker="ongoing"')).toBeLessThan(
      ongoing.indexOf('id="sendInteraction"'),
    );
  });

  it("renders Model and Advanced tabs for new and ongoing pickers", () => {
    for (const mode of ["new", "ongoing"]) {
      const markup = modelPickerMarkup({ mode });
      expect(markup).toContain('data-model-picker-tab="model"');
      expect(markup).toContain('data-model-picker-tab="advanced"');
      expect(markup).toContain(`data-model-picker="${mode}"`);
    }
  });

  it("maps escape, tab arrows, and option arrows deterministically", () => {
    const tabTarget = { matches: (selector) => selector === '[role="tab"]' };
    expect(modelPickerKeyIntent({ key: "Escape", target: {} }, "model")).toBe("close");
    expect(modelPickerKeyIntent({ key: "ArrowRight", target: tabTarget }, "model")).toBe("advanced");
    expect(modelPickerKeyIntent({ key: "ArrowLeft", target: tabTarget }, "model")).toBe("advanced");
    expect(modelPickerKeyIntent({ key: "Home", target: tabTarget }, "advanced")).toBe("model");
    expect(modelPickerKeyIntent({ key: "End", target: tabTarget }, "model")).toBe("advanced");
    expect(modelPickerCycleIndex(0, 3, "ArrowUp")).toBe(2);
    expect(modelPickerCycleIndex(2, 3, "ArrowDown")).toBe(0);
    expect(modelPickerCycleIndex(0, 0, "ArrowDown")).toBeNull();
  });

  it("distinguishes inside clicks from outside-click dismissal", () => {
    const inside = {};
    const outside = {};
    const root = { contains: (target) => target === inside };
    expect(modelPickerClickIsOutside(root, inside)).toBe(false);
    expect(modelPickerClickIsOutside(root, outside)).toBe(true);
  });

  it("escapes connector identities for HTML attribute context", () => {
    expect(escapeHtmlAttribute('provider&model"quoted\'')).toBe(
      "provider&amp;model&quot;quoted&#39;",
    );
  });

  it("ignores stale asynchronous Advanced harness validation results", () => {
    const gate = createModelPickerRequestGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
    gate.invalidate();
    expect(gate.isCurrent(second)).toBe(false);
  });

  it("returns focus to the trigger when Escape closes the picker", async () => {
    const source = await readFile(new URL("../desktop/renderer/src/model-picker.js", import.meta.url), "utf8");
    expect(source).toContain('close({ returnFocus: true });');
    expect(source).toContain("if (returnFocus) trigger.focus();");
  });

  it("uses canonical nested interaction identities with a migration fallback", () => {
    expect(interactionModelSelection({
      modelSelection: { familyId: 7, providerId: "codex", modelId: "gpt-5" },
      modelFamilyId: 99,
    })).toEqual({ familyId: 7, providerId: "codex", modelId: "gpt-5" });
    expect(interactionModelSelection({
      modelFamilyId: 7,
      modelProviderId: "codex",
      providerModelId: "gpt-5",
    })).toEqual({ familyId: 7, providerId: "codex", modelId: "gpt-5" });
    expect(modelSelectionLabels(settings, {
      familyId: 7,
      providerId: "codex",
      modelId: "gpt-5",
    })).toMatchObject({ compact: "Codex latest · GPT-5", provider: "Codex" });
    expect(modelSelectionLabels(settings, {
      familyId: 404,
      providerId: "codex",
      modelId: "gpt-5",
    })).toMatchObject({ compact: "Codex · GPT-5", family: null });
  });

  it("sends product identities and never exposes the pinned harness on follow-ups", () => {
    const pickerPayload = {
      harnessId: "codex-basic",
      modelSelection: { familyId: 7, providerId: "codex", modelId: "gpt-5" },
    };
    expect(newThreadRequestBody({
      title: "A thread",
      initialMessage: "Hello",
      permissionProfileId: "ask",
      projectId: 12,
      pickerPayload,
    })).toEqual({
      title: "A thread",
      initialMessage: "Hello",
      permissionProfileId: "ask",
      projectId: 12,
      ...pickerPayload,
    });
    expect(followupRequestBody("Next", pickerPayload.modelSelection, "send-1")).toEqual({
      text: "Next",
      inputId: "send-1",
      contexts: [],
      modelSelection: pickerPayload.modelSelection,
    });
    expect(followupRequestBody("Next", pickerPayload.modelSelection, "send-2")).not.toHaveProperty("harnessId");
    expect(JSON.stringify(pickerPayload)).not.toContain("harnessConfigurationName");
  });

  it("reuses a draft send identity through failure and rotates on success or content change", () => {
    const selection = { familyId: 7, providerId: "codex", modelId: "gpt-5" };
    const first = stableFollowupInputId(3, "Next", selection, []);
    expect(stableFollowupInputId(3, "Next", selection, [])).toBe(first);
    const changed = stableFollowupInputId(3, "Changed", selection, []);
    expect(changed).not.toBe(first);
    markFollowupSendSucceeded(changed);
    expect(stableFollowupInputId(3, "Changed", selection, [])).not.toBe(changed);
  });

  it("delegates the one trusted pre-inference refresh to the product backend", async () => {
    const [threads, main] = await Promise.all([
      readFile(new URL("../desktop/renderer/src/threads.js", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/src/main.js", import.meta.url), "utf8"),
    ]);
    expect(threads).not.toContain("desktop.models.refresh");
    expect(threads).not.toContain("refreshModelCatalogBeforeSend");
    expect(threads).toContain('await request("/api/threads", {');
    expect(threads).toContain("/actions/${encodeURIComponent(action.id)}/invoke");
    expect(threads).toContain("await refreshAfterModelSelectionRejection(error, true)");
    expect(threads).toContain("await refreshAfterModelSelectionRejection(error);");
    expect(threads).toContain("productApiAvailable && !newThreadModelSelectionReady()");
    expect(threads).toContain("if (productApiAvailable && !pickerPayload)");
    expect(main).toContain("if (productApiAvailable) await initializeModelFamilySettings();");
    expect(main).toContain("if (productApiAvailable && !newThreadModelSelectionReady())");
  });

  it("server-validates Advanced harness candidates before committing them", async () => {
    const [picker, composerPicker, permissions] = await Promise.all([
      readFile(new URL("../desktop/renderer/src/model-picker.js", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/src/composer-model-picker.js", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/src/permission-profiles.js", import.meta.url), "utf8"),
    ]);
    expect(picker).toContain("await validateCandidateHarness(");
    expect(picker.indexOf("await validateCandidateHarness(")).toBeLessThan(
      picker.indexOf("commit(result.selection);"),
    );
    expect(picker.indexOf("validatingHarness = true;")).toBeLessThan(
      picker.indexOf("await validateCandidateHarness("),
    );
    expect(picker).toContain("onSelectionChange(null);");
    expect(picker.indexOf("await prepareHarnessChange(candidateHarnessId)")).toBeLessThan(
      picker.indexOf("commit(result.selection);"),
    );
    expect(composerPicker).toContain("prepareHarnessChange: preparePermissionProfiles");
    expect(permissions).toContain("/api/permission-profiles?harnessId=${encodeURIComponent(harnessId)}");
  });

  it("reloads renderer model state after provider account changes", async () => {
    const main = await readFile(new URL("../desktop/renderer/src/main.js", import.meta.url), "utf8");
    expect(main).toContain("async function refreshProviderModelUi()");
    expect(main).toContain("await refreshModelFamilySettings();");
    expect(main).toContain("refreshNewThreadModelPicker();");
    expect(main).toContain("await preparePermissionProfiles(");
    expect(main.indexOf("await preparePermissionProfiles(")).toBeLessThan(
      main.indexOf("resetNewThreadModelPicker();"),
    );
  });

  it("routes every model setup failure to Models and harnesses", async () => {
    const graph = await readFile(new URL("../desktop/renderer/src/graph.js", import.meta.url), "utf8");
    const threads = await readFile(new URL("../desktop/renderer/src/threads.js", import.meta.url), "utf8");
    const modelTab = 'setSettingsTab("models");';
    expect(graph.indexOf(modelTab)).toBeLessThan(graph.indexOf('querySelector("#settingsButton")?.click();'));
    expect(threads.match(/setSettingsTab\("models"\);/g)).toHaveLength(2);
  });

  it("defines a viewport-safe narrow layout and light-mode surface", async () => {
    const styles = await readFile(new URL("../desktop/renderer/styles.css", import.meta.url), "utf8");
    expect(styles).toContain(".model-picker-popover{position:fixed;left:12px;right:12px;bottom:72px;width:auto");
    expect(styles).toContain('html[data-theme="light"] .model-picker-popover{background:#fff');
  });
});
