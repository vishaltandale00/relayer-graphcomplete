import { describe, expect, it } from "vitest";

import {
  availablePickerFamilies,
  defaultFamilySelection,
  defaultFamilySelectionForProvider,
  firstAvailableSelection,
  harnessUsesConfigurationModel,
  isModelSelectionCatalogError,
  modelPickerContextCandidate,
  NO_MODELS_FOR_HARNESS,
  normalizePickerSelection,
  pickerSelectionIsAvailable,
  pickerSelectionPayload,
  reconcilePickerSelection,
  selectCandidateHarness,
  selectionForInteraction,
  validateCandidateHarness,
} from "../desktop/renderer/src/model-picker-model.js";
import {
  modelPickerFamilyPresentation,
  modelSelectionLabels,
  selectionForNextInteraction,
} from "../desktop/renderer/src/model-picker.js";

function settings() {
  return {
    defaults: { harnessId: "codex-basic", providerId: "codex" },
    harnesses: [
      { id: "codex-basic", label: "Codex Basic", available: true, compatibleProviderIds: ["codex"] },
      { id: "cooked", label: "Cooked", available: true, compatibleProviderIds: ["future"] },
    ],
    providers: [
      {
        id: "codex",
        connected: true,
        models: [
          { id: "one", visible: true, available: true },
          { id: "two", visible: true, available: false },
          { id: "hidden", visible: false, available: true },
        ],
      },
      { id: "future", connected: false, models: [{ id: "three", visible: true, available: true }] },
    ],
    families: [
      {
        id: 1,
        name: "Codex",
        enabled: true,
        position: 0,
        members: [
          { providerId: "codex", modelId: "one", position: 0 },
          { providerId: "codex", modelId: "two", position: 1 },
          { providerId: "future", modelId: "three", position: 2 },
        ],
      },
      { id: 2, name: "Hidden family", enabled: false, position: 1, members: [{ providerId: "codex", modelId: "one", position: 0 }] },
    ],
  };
}

describe("composer model picker selection", () => {
  it("shows only enabled, available, harness-compatible members in authoritative order", () => {
    const catalog = settings();
    const families = availablePickerFamilies(catalog, "codex-basic");
    expect(families.map(({ id }) => id), "only enabled families with available members show")
      .toEqual([1]);
    expect(families[0].availableMembers, "only available compatible members show").toEqual([
      { providerId: "codex", modelId: "one", position: 0 },
    ]);
    expect(firstAvailableSelection(catalog, "codex-basic"), "first available selection").toEqual({
      harnessId: "codex-basic",
      familyId: 1,
      providerId: "codex",
      modelId: "one",
    });

    const ordered = settings();
    ordered.defaults.providerId = "codex";
    ordered.providers.push({
      id: "second-provider",
      connected: true,
      models: [{ id: "preferred-first", visible: true, available: true }],
    });
    ordered.harnesses[0].compatibleProviderIds.push("second-provider");
    ordered.families[0].members = [
      { providerId: "second-provider", modelId: "preferred-first", position: 0 },
      { providerId: "codex", modelId: "one", position: 1 },
    ];
    expect(firstAvailableSelection(ordered, "codex-basic"), "explicit cross-provider member order beats the default provider")
      .toMatchObject({
        providerId: "second-provider",
        modelId: "preferred-first",
      });

    const subset = settings();
    subset.harnesses[0].modelCompatibility = [{
      providerId: "codex",
      modelIds: ["two"],
      preferredModelId: "two",
    }];
    subset.providers[0].models[1].available = true;
    expect(availablePickerFamilies(subset, "codex-basic")[0].availableMembers, "harness model subset intersects family membership")
      .toEqual([
        { providerId: "codex", modelId: "two", position: 1 },
      ]);

    const preferred = settings();
    preferred.providers[0].models[1].available = true;
    preferred.families.push({
      id: 3,
      name: "Later family",
      enabled: true,
      position: 2,
      members: [
        { providerId: "codex", modelId: "one", position: 0 },
        { providerId: "codex", modelId: "two", position: 1 },
      ],
    });
    preferred.families[0].members = [
      { providerId: "codex", modelId: "one", position: 0 },
    ];
    preferred.harnesses[0].modelCompatibility = [{
      providerId: "codex",
      modelIds: ["one", "two"],
      preferredModelId: "two",
    }];
    expect(firstAvailableSelection(preferred, "codex-basic"), "first family's first available member beats a later preferred model")
      .toEqual({
        harnessId: "codex-basic",
        familyId: 1,
        providerId: "codex",
        modelId: "one",
      });
    expect(normalizePickerSelection(preferred, { harnessId: "codex-basic" }), "normalized default follows the same authority")
      .toEqual({
        harnessId: "codex-basic",
        familyId: 1,
        providerId: "codex",
        modelId: "one",
      });

    const defaultFamily = settings();
    defaultFamily.defaults.familyId = 2;
    expect(defaultFamilySelection(defaultFamily, "codex-basic"), "disabled configured default family does not fall through")
      .toBeNull();
    defaultFamily.defaults.familyId = 1;
    expect(defaultFamilySelection(defaultFamily, "codex-basic"), "configured default family resolves")
      .toMatchObject({
        familyId: 1,
        providerId: "codex",
        modelId: "one",
      });
    expect(defaultFamilySelectionForProvider(defaultFamily, "codex-basic", "other-provider"), "unknown provider resolves nothing")
      .toBeNull();
    expect(defaultFamilySelectionForProvider(defaultFamily, "codex-basic", "codex"), "configured provider resolves the default family")
      .toMatchObject({
        familyId: 1,
        providerId: "codex",
      });
  });

  it("reconciles selections across stale intents, harness switches, and picker context replacement", async () => {
    const catalog = settings();
    expect(selectionForInteraction(catalog, "codex-basic", {
      modelSelection: { familyId: 1, providerId: "codex", modelId: "one" },
    }), "available prior model is inherited").toMatchObject({ modelId: "one" });
    const stale = selectionForInteraction(catalog, "codex-basic", {
      modelFamilyId: 1,
      modelProviderId: "codex",
      providerModelId: "two",
    });
    expect(stale, "stale prior model reselects within its family").toMatchObject({ familyId: 1, providerId: "codex", modelId: "two" });
    expect(selectionForNextInteraction(catalog, "codex-basic", {
      modelSelection: { familyId: 1, providerId: "codex", modelId: "two" },
    }), "next interaction drops the unavailable member").toEqual({
      harnessId: "codex-basic",
      familyId: 1,
      providerId: "codex",
      modelId: "one",
    });
    expect(pickerSelectionIsAvailable(catalog, stale), "stale selection is unavailable").toBe(false);
    expect(normalizePickerSelection(catalog, stale), "stale selection normalizes to nothing").toBeNull();

    const removed = settings();
    removed.families = [{
      id: 3,
      name: "Replacement",
      enabled: true,
      position: 0,
      members: [{ providerId: "codex", modelId: "one", position: 0 }],
    }];
    const blocked = selectionForNextInteraction(removed, "codex-basic", {
      modelSelection: { familyId: 99, providerId: "codex", modelId: "removed" },
    });
    expect(blocked, "removed family persists as blocked intent").toEqual({
      harnessId: "codex-basic",
      familyId: 99,
      providerId: "codex",
      modelId: "removed",
    });
    const presentation = modelPickerFamilyPresentation(removed, "codex-basic", blocked);
    expect(presentation.selectedFamily.id, "presentation falls back to a selectable family").toBe(3);
    expect(presentation.requiresExplicitSelection, "blocked intent requires an explicit choice").toBe(true);

    const implicit = settings();
    expect(normalizePickerSelection(implicit, { harnessId: "codex-basic" }), "first available applies only without an explicit model")
      .toMatchObject({
        familyId: 1,
        providerId: "codex",
        modelId: "one",
      });
    expect(reconcilePickerSelection(implicit, {
      harnessId: "codex-basic",
      familyId: 99,
      providerId: "codex",
      modelId: "removed",
    }), "explicit removed selection survives reconciliation").toEqual({
      harnessId: "codex-basic",
      familyId: 99,
      providerId: "codex",
      modelId: "removed",
    });

    const switchCatalog = settings();
    switchCatalog.defaults.familyId = 1;
    switchCatalog.providers[0].adapterId = "codex-subscription";
    switchCatalog.providers.push({
      id: "router",
      adapterId: "openrouter",
      connected: true,
      models: [{ id: "qwen", visible: true, available: true }],
    });
    switchCatalog.families.push({
      id: 3,
      name: "OpenRouter",
      enabled: true,
      position: 2,
      members: [{ providerId: "router", modelId: "qwen", position: 0 }],
    });
    switchCatalog.harnesses.push({
      id: "prime-agent-basic",
      label: "Prime Agent Basic",
      available: true,
      modelRules: {
        allow: [{ adapterId: "openrouter", modelIdRegex: ".*" }],
        deny: [],
      },
      executionAccessContracts: ["secret@1"],
    });
    const current = normalizePickerSelection(switchCatalog, null);
    expect(current, "current selection anchors the configured default family")
      .toMatchObject({ harnessId: "codex-basic", familyId: 1 });
    expect(availablePickerFamilies(switchCatalog, "prime-agent-basic").map(({ id }) => id), "candidate harness sees only its usable family")
      .toEqual([3]);
    expect(selectCandidateHarness(switchCatalog, current, "prime-agent-basic"), "switching clears the prior family route").toEqual({
      selection: { harnessId: "prime-agent-basic", familyId: null, providerId: null, modelId: null },
      error: null,
    });

    const rollbackCatalog = settings();
    const rollbackCurrent = normalizePickerSelection(rollbackCatalog, null);
    expect(selectCandidateHarness(rollbackCatalog, rollbackCurrent, "cooked"), "candidate without models rolls back completely")
      .toEqual({
        selection: rollbackCurrent,
        error: NO_MODELS_FOR_HARNESS,
      });

    const staleCatalog = settings();
    staleCatalog.harnesses.push({
      id: "stale",
      label: "Stale",
      available: true,
      compatibleProviderIds: ["codex"],
    });
    const staleCurrent = normalizePickerSelection(staleCatalog, null);
    const validateSelection = async () => { throw new Error("stale catalog"); };
    await expect(validateCandidateHarness(staleCatalog, staleCurrent, "stale", validateSelection), "trusted validation rejection rolls back")
      .resolves.toEqual({
        selection: staleCurrent,
        error: NO_MODELS_FOR_HARNESS,
      });

    const contextCatalog = settings();
    contextCatalog.defaults.harnessId = "prime-agent-basic";
    const currentSelection = { harnessId: "codex-basic" };
    expect(modelPickerContextCandidate({
      settings: contextCatalog,
      mode: "new",
      pinnedHarnessId: null,
      currentSelection,
      nextSelection: null,
      replaceSelection: true,
    }), "explicit replacement adopts the new default").toEqual({ harnessId: "prime-agent-basic" });
    expect(modelPickerContextCandidate({
      settings: contextCatalog,
      mode: "new",
      pinnedHarnessId: null,
      currentSelection,
      nextSelection: null,
      replaceSelection: false,
    }), "without replacement the prior selection stays").toEqual({ harnessId: "codex-basic" });

    const resetCatalog = settings();
    resetCatalog.families.push({
      id: 3,
      name: "Configured default",
      enabled: true,
      position: 2,
      members: [{ providerId: "codex", modelId: "one", position: 0 }],
    });
    resetCatalog.defaults.familyId = 3;
    const candidate = modelPickerContextCandidate({
      settings: resetCatalog,
      mode: "new",
      pinnedHarnessId: null,
      currentSelection: { harnessId: "codex-basic", familyId: 1, providerId: "codex", modelId: "one" },
      nextSelection: null,
      replaceSelection: true,
    });
    expect(reconcilePickerSelection(resetCatalog, candidate), "new-thread reset follows the configured default family, not family order")
      .toMatchObject({
        harnessId: "codex-basic",
        familyId: 3,
        providerId: "codex",
        modelId: "one",
      });

    expect(pickerSelectionPayload({
      harnessId: "codex-basic",
      familyId: 1,
      providerId: "codex",
      modelId: "one",
    }), "payload serializes only product identities").toEqual({
      harnessId: "codex-basic",
      modelSelection: {
        familyId: 1,
        providerId: "codex",
        modelId: "one",
      },
    });
  });

  it("recognizes typed catalog errors, rule-driven explicit selection, and configuration-owned harnesses", async () => {
    const catalogErrorCases = [
      ["model_unavailable", true],
      ["harness_model_incompatible", true],
      ["interaction_in_progress", false],
    ];
    expect(catalogErrorCases, "typed catalog rejection inventory").toHaveLength(3);
    for (const [code, expected] of catalogErrorCases) {
      expect.soft(isModelSelectionCatalogError({ code }), `code ${code}`).toBe(expected);
    }
    expect(isModelSelectionCatalogError(new Error("network")), "plain errors are not catalog rejections").toBe(false);

    const ruled = settings();
    const ruledHarness = ruled.harnesses.find((item) => item.id === "codex-basic");
    ruledHarness.modelRules = { allow: [], deny: [] };
    ruledHarness.modelCompatibility = [];
    ruledHarness.compatibleProviderIds = [];
    expect(harnessUsesConfigurationModel(ruled, "codex-basic"), "declared model rules require an explicit model")
      .toBe(false);

    const owned = settings();
    owned.harnesses.push({
      id: "prime-agent-basic",
      label: "Prime Agent Basic",
      available: true,
      compatibleProviderIds: [],
      modelCompatibility: [],
    });
    expect(harnessUsesConfigurationModel(owned, "prime-agent-basic"), "provider-less development harness owns its model")
      .toBe(true);
    expect(normalizePickerSelection(owned, { harnessId: "prime-agent-basic" }), "configuration-owned selection carries no model route")
      .toEqual({ harnessId: "prime-agent-basic" });
    expect(pickerSelectionIsAvailable(owned, { harnessId: "prime-agent-basic" }), "configuration-owned selection is available")
      .toBe(true);
    expect(pickerSelectionPayload({ harnessId: "prime-agent-basic" }), "configuration-owned payload")
      .toEqual({ harnessId: "prime-agent-basic" });
    expect(modelSelectionLabels(owned, { harnessId: "prime-agent-basic" }), "configuration-owned selection has no model labels")
      .toBeNull();
    const validate = async () => { throw new Error("model validation must not run"); };
    await expect(validateCandidateHarness(
      owned,
      normalizePickerSelection(owned, { harnessId: "codex-basic" }),
      "prime-agent-basic",
      validate,
    ), "configuration-owned harness skips model validation").resolves.toEqual({ selection: { harnessId: "prime-agent-basic" }, error: null });

    const unmatched = settings();
    unmatched.providers[0].adapterId = "codex-subscription";
    unmatched.harnesses.push({
      id: "prime-agent-basic",
      label: "Prime Agent Basic",
      available: true,
      modelRules: {
        allow: [{ adapterId: "openai-api", modelIdRegex: ".*" }],
        deny: [],
      },
      executionAccessContracts: ["secret@1"],
    });
    expect(availablePickerFamilies(unmatched, "prime-agent-basic"), "rules matching no member hide every family")
      .toEqual([]);
    expect(firstAvailableSelection(unmatched, "prime-agent-basic"), "rules matching no member offer no selection")
      .toBeNull();
    expect(normalizePickerSelection(unmatched, { harnessId: "prime-agent-basic" }), "unmatched rules normalize to nothing")
      .toBeNull();
    expect(pickerSelectionIsAvailable(unmatched, { harnessId: "prime-agent-basic" }), "unmatched rules are unavailable")
      .toBe(false);
  });
});
