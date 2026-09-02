import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  followupRequestBody,
  markFollowupSendSucceeded,
  newThreadRequestBody,
  stableFollowupInputId,
} from "../desktop/renderer/src/interaction-request-model.js";
import {
  createModelPickerDismissWatcher,
  createModelPickerRequestGate,
  interactionModelSelection,
  modelPickerClickIsOutside,
  modelPickerCycleIndex,
  modelPickerFamilyPresentation,
  modelPickerKeyIntent,
  modelPickerMarkup,
  modelPickerMemberIsSelected,
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
  it("renders picker markup and resolves keyboard, click, and dismissal intents", () => {
    for (const mode of ["new", "ongoing"]) {
      const markup = modelPickerMarkup({ mode });
      expect(markup, `${mode} picker shows the Model tab`).toContain('data-model-picker-tab="model"');
      expect(markup, `${mode} picker shows the Advanced tab`).toContain('data-model-picker-tab="advanced"');
      expect(markup, `${mode} picker is tagged`).toContain(`data-model-picker="${mode}"`);
    }

    const catalog = {
      defaults: { harnessId: "codex-basic", familyId: 99 },
      harnesses: [{ id: "codex-basic", available: true, compatibleProviderIds: ["codex"] }],
      providers: [{
        id: "codex",
        connected: true,
        models: [{ id: "gpt-5", label: "GPT-5", available: true, visible: true }],
      }],
      families: [{
        id: 7,
        name: "Codex latest",
        enabled: true,
        position: 0,
        members: [{ providerId: "codex", modelId: "gpt-5", position: 0 }],
      }],
    };
    const presentation = modelPickerFamilyPresentation(catalog, "codex-basic", null);
    expect(presentation.selectedFamily.id, "invalid prior family presents another family for choice").toBe(7);
    expect(presentation.requiresExplicitSelection, "invalid prior family requires an explicit choice").toBe(true);
    const member = presentation.selectedFamily.availableMembers[0];
    expect(modelPickerMemberIsSelected(7, {
      familyId: 99,
      providerId: "codex",
      modelId: "gpt-5",
    }, member), "member from an invalid family is not marked selected").toBe(false);

    const tabTarget = { matches: (selector) => selector === '[role="tab"]' };
    const keyIntentCases = [
      ["escape closes", { key: "Escape", target: {} }, "model", "close"],
      ["arrow right moves from model to advanced", { key: "ArrowRight", target: tabTarget }, "model", "advanced"],
      ["arrow left moves from model to advanced", { key: "ArrowLeft", target: tabTarget }, "model", "advanced"],
      ["home moves from advanced to model", { key: "Home", target: tabTarget }, "advanced", "model"],
      ["end moves from model to advanced", { key: "End", target: tabTarget }, "model", "advanced"],
    ];
    expect(keyIntentCases, "key intent inventory").toHaveLength(5);
    for (const [label, event, activeTab, expected] of keyIntentCases) {
      expect.soft(modelPickerKeyIntent(event, activeTab), label).toBe(expected);
    }
    const cycleCases = [
      ["arrow up wraps to the last option", 0, 3, "ArrowUp", 2],
      ["arrow down wraps to the first option", 2, 3, "ArrowDown", 0],
      ["empty list has no cycle target", 0, 0, "ArrowDown", null],
    ];
    expect(cycleCases, "cycle index inventory").toHaveLength(3);
    for (const [label, current, count, key, expected] of cycleCases) {
      expect.soft(modelPickerCycleIndex(current, count, key), label).toBe(expected);
    }

    const inside = {};
    const outside = {};
    const root = { contains: (target) => target === inside };
    expect(modelPickerClickIsOutside(root, inside), "inside click stays open").toBe(false);
    expect(modelPickerClickIsOutside(root, outside), "outside click dismisses").toBe(true);

    const option = {};
    const watchedRoot = { contains: (target) => target === option };
    const watcher = createModelPickerDismissWatcher(watchedRoot);
    watcher.observe({ target: option });
    // Choosing a harness re-renders the Advanced panel, which detaches the clicked option
    // before the document-level dismissal listener sees the same click.
    watchedRoot.contains = () => false;
    expect(watcher.shouldDismiss(), "detached option click is not an outside click").toBe(false);
    watcher.observe({ target: {} });
    expect(watcher.shouldDismiss(), "later outside click still dismisses").toBe(true);

    expect(escapeHtmlAttribute('provider&model"quoted\''), "connector identities escape for attributes").toBe(
      "provider&amp;model&quot;quoted&#39;",
    );

    const gate = createModelPickerRequestGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(gate.isCurrent(first), "superseded validation is stale").toBe(false);
    expect(gate.isCurrent(second), "latest validation is current").toBe(true);
    gate.invalidate();
    expect(gate.isCurrent(second), "invalidation stales the latest validation").toBe(false);
  });

  it("sends canonical product identities and rotates draft send identities through failure", () => {
    expect(interactionModelSelection({
      modelSelection: { familyId: 7, providerId: "codex", modelId: "gpt-5" },
      modelFamilyId: 99,
    }), "canonical nested identities win").toEqual({ familyId: 7, providerId: "codex", modelId: "gpt-5" });
    expect(interactionModelSelection({
      modelFamilyId: 7,
      modelProviderId: "codex",
      providerModelId: "gpt-5",
    }), "flat identities migrate").toEqual({ familyId: 7, providerId: "codex", modelId: "gpt-5" });
    expect(modelSelectionLabels(settings, {
      familyId: 7,
      providerId: "codex",
      modelId: "gpt-5",
    }), "labels for a known family").toMatchObject({ compact: "Codex latest · GPT-5", provider: "Codex" });
    expect(modelSelectionLabels(settings, {
      familyId: 404,
      providerId: "codex",
      modelId: "gpt-5",
    }), "labels fall back for an unknown family").toMatchObject({ compact: "Codex · GPT-5", family: null });

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
    }), "new thread sends product identities").toEqual({
      title: "A thread",
      initialMessage: "Hello",
      permissionProfileId: "ask",
      projectId: 12,
      ...pickerPayload,
    });
    expect(followupRequestBody("Next", pickerPayload.modelSelection, "send-1"), "follow-up carries the model selection").toEqual({
      text: "Next",
      inputId: "send-1",
      contexts: [],
      contextConfirmationIds: [],
      modelSelection: pickerPayload.modelSelection,
    });
    expect(followupRequestBody("Next", pickerPayload.modelSelection, "send-2"), "follow-up never exposes the pinned harness")
      .not.toHaveProperty("harnessId");
    expect(followupRequestBody(
      "Next",
      pickerPayload.modelSelection,
      "send-3",
      [],
      [],
      7,
    ), "follow-up carries the draft revision").toMatchObject({ inputId: "send-3", inputDraftRevision: 7 });
    expect(JSON.stringify(pickerPayload), "picker payload keeps no harness configuration").not.toContain("harnessConfigurationName");

    const selection = { familyId: 7, providerId: "codex", modelId: "gpt-5" };
    const firstIdentity = stableFollowupInputId(3, "Next", selection, []);
    expect(stableFollowupInputId(3, "Next", selection, []), "unchanged input keeps its identity").toBe(firstIdentity);
    const changed = stableFollowupInputId(3, "Changed", selection, []);
    expect(changed, "content change rotates the identity").not.toBe(firstIdentity);
    const otherThread = stableFollowupInputId(4, "Next", selection, []);
    expect(otherThread, "another thread has its own identity").not.toBe(firstIdentity);
    expect(stableFollowupInputId(3, "Next", selection, [], ["confirmation-a"]), "confirmations rotate the identity")
      .not.toBe(firstIdentity);
    expect(stableFollowupInputId(3, "Next", selection, [], [], 2), "draft revisions rotate the identity").not.toBe(firstIdentity);
    expect(stableFollowupInputId(3, "Next", selection, [], [], 2), "identical revisions stay stable").toBe(
      stableFollowupInputId(3, "Next", selection, [], [], 2),
    );
    expect(stableFollowupInputId(3, "Next", selection, []), "failure reuses the original identity").toBe(firstIdentity);
    markFollowupSendSucceeded(changed);
    expect(stableFollowupInputId(3, "Changed", selection, []), "success rotates the identity").not.toBe(changed);
    expect(stableFollowupInputId(3, "Next", selection, []), "success does not disturb other drafts").toBe(firstIdentity);
    expect(stableFollowupInputId(4, "Next", selection, []), "success does not disturb other threads").toBe(otherThread);

    const contexts = [{
      target: { nodeId: 7, sourceInteractionNodeId: 3, sourceLayerId: 5 },
      annotations: ["Confirmed context"],
    }];
    const confirmationSend = stableFollowupInputId(
      3,
      "Confirmed follow-up",
      selection,
      contexts,
      ["confirmation-a"],
    );
    expect(stableFollowupInputId(
      3,
      "Confirmed follow-up",
      selection,
      contexts,
      ["confirmation-a"],
    ), "confirmed sends stay stable through failure").toBe(confirmationSend);
    markFollowupSendSucceeded(confirmationSend);
    expect(stableFollowupInputId(
      3,
      "Confirmed follow-up",
      selection,
      contexts,
      ["confirmation-a"],
    ), "confirmed sends rotate after success").not.toBe(confirmationSend);
  });

  it("keeps renderer source contracts for placement, dismissal, refresh, validation, and styling", async () => {
    const [indexHtml, picker, composerPicker, permissions, threads, main, graph, styles] = await Promise.all([
      readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/src/model-picker.js", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/src/composer-model-picker.js", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/src/permission-profiles.js", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/src/threads.js", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/src/main.js", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/src/graph.js", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/styles.css", import.meta.url), "utf8"),
    ]);

    const newModel = indexHtml.indexOf('id="newModelControl"');
    const newSubmit = indexHtml.indexOf('id="createThread"');
    expect(newModel, "new-thread Model control sits after permissions").toBeGreaterThan(indexHtml.indexOf('id="permissionButton"'));
    expect(newModel, "new-thread Model control sits immediately before Submit").toBeLessThan(newSubmit);
    const ongoing = productWorkspaceMarkup();
    expect(ongoing.indexOf('data-model-picker="ongoing"'), "ongoing Model picker sits before Submit")
      .toBeLessThan(ongoing.indexOf('id="sendInteraction"'));

    expect(picker, "dismissal watcher registers in the capture phase")
      .toContain('addEventListener("click", dismissWatcher.observe, true)');
    expect(picker.indexOf('addEventListener("click", dismissWatcher.observe, true)'), "capture registration precedes the outside-click handler")
      .toBeLessThan(picker.indexOf('addEventListener("click", outsideClick'));
    expect(picker, "Escape returns focus to the trigger").toContain('close({ returnFocus: true });');
    expect(picker, "returned focus is applied").toContain("if (returnFocus) trigger.focus();");

    expect(picker, "harness candidates validate before commit").toContain("await validateCandidateHarness(");
    expect(picker.indexOf("await validateCandidateHarness("), "validation precedes commit")
      .toBeLessThan(picker.indexOf("commit(result.selection);"));
    expect(picker.indexOf("validatingHarness = true;"), "validating flag precedes validation")
      .toBeLessThan(picker.indexOf("await validateCandidateHarness("));
    expect(picker, "rejected candidates clear the selection").toContain("onSelectionChange(null);");
    expect(picker.indexOf("await prepareHarnessChange(candidateHarnessId)"), "harness preparation precedes commit")
      .toBeLessThan(picker.indexOf("commit(result.selection);"));
    expect(composerPicker, "composer wires permission profiles as harness preparation")
      .toContain("prepareHarnessChange: preparePermissionProfiles");
    expect(permissions, "permission profiles load per harness")
      .toContain("/api/permission-profiles?harnessId=${encodeURIComponent(harnessId)}");

    expect(threads, "renderer threads never refresh the catalog directly").not.toContain("desktop.models.refresh");
    expect(threads, "renderer threads never call the pre-send refresh hook").not.toContain("refreshModelCatalogBeforeSend");
    expect(threads, "threads create through the product API").toContain('await request("/api/threads", {');
    expect(threads, "thread actions invoke through the product API").toContain("/actions/${encodeURIComponent(action.id)}/invoke");
    expect(threads, "rejection refreshes before retry").toContain("await refreshAfterModelSelectionRejection(error, true)");
    expect(threads, "rejection refreshes after failure").toContain("await refreshAfterModelSelectionRejection(error);");
    expect(threads, "catalog readiness gates new-thread selection").toContain("productApiAvailable && !newThreadModelSelectionReady()");
    expect(threads, "picker payload gates thread creation").toContain("if (productApiAvailable && !pickerPayload)");
    expect(main, "main initializes family settings through the product API")
      .toContain("if (productApiAvailable) await initializeModelFamilySettings();");
    expect(main, "main gates selection readiness through the product API")
      .toContain("if (productApiAvailable && !newThreadModelSelectionReady())");

    expect(main, "provider changes reload renderer model state").toContain("async function refreshProviderModelUi()");
    expect(main, "provider changes refresh family settings").toContain("await refreshModelFamilySettings();");
    expect(main, "provider changes refresh the new-thread picker").toContain("refreshNewThreadModelPicker();");
    expect(main, "onboarding completion reloads model UI before permission profiles").toContain(`setProviderOnboardingCompletionHandler(async () => {
    await refreshProviderModelUi();
    await loadPermissionProfiles(appState.modelSettings?.defaults?.harnessId);
    resetNewThreadModelPicker();`);
    expect(main, "permission profiles prepare before picker reset").toContain("await preparePermissionProfiles(");
    expect(main.indexOf("await preparePermissionProfiles("), "preparation precedes picker reset").toBeLessThan(
      main.indexOf("resetNewThreadModelPicker();"),
    );

    const modelTab = 'setSettingsTab("models");';
    expect(graph.indexOf(modelTab), "graph setup failures open the Models settings tab")
      .toBeLessThan(graph.indexOf('querySelector("#settingsButton")?.click();'));
    expect(threads.match(/setSettingsTab\("models"\);/g), "every thread model setup failure routes to Models")
      .toHaveLength(2);

    expect(styles, "narrow popover stays viewport-safe")
      .toContain(".model-picker-popover{position:fixed;left:12px;right:12px;bottom:72px;width:auto");
    expect(styles, "light theme surfaces the popover")
      .toContain('html[data-theme="light"] .model-picker-popover{background:#fff');
  }, 10_000);
});
