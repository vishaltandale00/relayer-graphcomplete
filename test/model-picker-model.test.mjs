import { describe, expect, it } from "vitest";

import {
  availablePickerFamilies,
  defaultFamilySelection,
  defaultFamilySelectionForProvider,
  firstAvailableSelection,
  familyModelSetup,
  harnessUsesConfigurationModel,
  isModelSelectionCatalogError,
  modelPickerContextCandidate,
  normalizePickerSelection,
  pickerSelectionIsAvailable,
  pickerSelectionPayload,
  reconcilePickerSelection,
  routablePickerFamilies,
  selectionForInteraction,
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
          { providerId: "codex", modelId: "one", position: 0, roles: [{ name: "orchestrator" }] },
          { providerId: "codex", modelId: "two", position: 1, roles: [] },
          { providerId: "future", modelId: "three", position: 2, roles: [] },
        ],
      },
      { id: 2, name: "Hidden family", enabled: false, position: 1, members: [{ providerId: "codex", modelId: "one", position: 0, roles: [{ name: "orchestrator" }] }] },
    ],
  };
}

describe("composer model picker selection", () => {
  it("routes the chosen family through the current, default, then first available harness", () => {
    const catalog = settings();
    catalog.providers[1].connected = true;
    catalog.families.push({
      id: 3, name: "Future", enabled: true, position: 2,
      members: [{ providerId: "future", modelId: "three", position: 0, roles: [{ name: "orchestrator" }] }],
    });
    catalog.harnesses.push(
      { id: "aaa-unavailable", available: false, compatibleProviderIds: ["future"] },
      { id: "both", available: true, compatibleProviderIds: ["codex", "future"] },
    );
    catalog.defaults.harnessId = "cooked";
    const routes = () => routablePickerFamilies(catalog, "codex-basic", { allowHarnessChange: true });
    expect(routes().map(family => [family.id, family.harnessId])).toEqual([[1, "codex-basic"], [3, "cooked"]]);
    expect(routablePickerFamilies(catalog, "both", { allowHarnessChange: true }).every(family => family.harnessId === "both")).toBe(true);
    catalog.harnesses.find(harness => harness.id === "cooked").available = false;
    expect(routes().find(family => family.id === 3).harnessId).toBe("both");
    expect(routablePickerFamilies(catalog, "codex-basic").map(family => family.id)).toEqual([1]);
    catalog.conversationCompatibility = { status: "compatible", harnessId: "codex-basic", providerId: "codex" };
    expect(routes().map(family => family.id)).toEqual([1]);
    catalog.conversationCompatibility = { status: "unrestricted" };
    catalog.providers[1].connected = false;
    expect(routes().map(family => family.id)).toEqual([1]);
  });

  it.each([
    { compatibleProviderIds: ["future"] },
    { modelCompatibility: [{ providerId: "codex", modelIds: ["two"] }] },
    { modelRules: { allow: [{ adapterId: "claude-subscription", modelIdRegex: ".*" }], deny: [] } },
    { modelRules: { allow: [], deny: [{ adapterId: "codex-subscription", modelIdExact: "one" }] } },
  ])("explains a mismatch under the harness compatibility policy %j", policy => {
    const catalog = settings();
    catalog.providers[0].adapterId = "codex-subscription";
    catalog.harnesses[0] = { id: "codex-basic", label: "Restricted harness", available: true, ...policy };
    expect(familyModelSetup(catalog, 1)).toMatchObject({
      reason: "harness-mismatch", label: "Harness mismatch", action: "family-settings", choiceName: null,
    });
    expect(familyModelSetup(catalog, 1).message).toContain("Codex cannot run with Restricted harness");
    // Disconnection and model availability remain their own recovery boundary, even if
    // this harness also refuses the model. A mismatch must not hide the underlying outage.
    catalog.providers[0].connected = false;
    expect(familyModelSetup(catalog, 1)).toMatchObject({ action: "settings", label: "Orchestrator unavailable" });
    catalog.providers[0].connected = true;
    catalog.providers[0].models[0].available = false;
    expect(familyModelSetup(catalog, 1)).toMatchObject({ action: "family-settings", label: "Orchestrator unavailable" });
  });

  it("requires an explicit model whenever a harness declares model rules", () => {
    const catalog = settings();
    const harness = catalog.harnesses.find((item) => item.id === "codex-basic");
    harness.modelRules = { allow: [], deny: [] };
    harness.modelCompatibility = [];
    harness.compatibleProviderIds = [];

    expect(harnessUsesConfigurationModel(catalog, "codex-basic")).toBe(false);
  });

  it("recognizes typed catalog rejections that require picker reconciliation", () => {
    expect(isModelSelectionCatalogError({ code: "model_unavailable" })).toBe(true);
    expect(isModelSelectionCatalogError({ code: "harness_model_incompatible" })).toBe(true);
    expect(isModelSelectionCatalogError({ code: "interaction_in_progress" })).toBe(false);
    expect(isModelSelectionCatalogError(new Error("network"))).toBe(false);
  });

  it("shows only enabled families with currently available compatible models", () => {
    const catalog = settings();
    const families = availablePickerFamilies(catalog, "codex-basic");
    expect(families.map(({ id }) => id)).toEqual([1]);
    expect(families[0].availableMembers).toEqual([
      { providerId: "codex", modelId: "one", position: 0, roles: [{ name: "orchestrator" }] },
    ]);
    expect(firstAvailableSelection(catalog, "codex-basic")).toEqual({
      harnessId: "codex-basic",
      familyId: 1,
      providerId: "codex",
      modelId: "one",
    });
  });

  it("keeps a configuration-owned model path for development harnesses without a provider catalog", async () => {
    const catalog = settings();
    catalog.harnesses.push({
      id: "prime-agent-basic",
      label: "Prime Agent Basic",
      available: true,
      compatibleProviderIds: [],
      modelCompatibility: [],
    });
    expect(harnessUsesConfigurationModel(catalog, "prime-agent-basic")).toBe(true);
    expect(normalizePickerSelection(catalog, { harnessId: "prime-agent-basic" }))
      .toEqual({ harnessId: "prime-agent-basic" });
    expect(pickerSelectionIsAvailable(catalog, { harnessId: "prime-agent-basic" })).toBe(true);
    expect(pickerSelectionPayload({ harnessId: "prime-agent-basic" }))
      .toEqual({ harnessId: "prime-agent-basic" });
    expect(modelSelectionLabels(catalog, { harnessId: "prime-agent-basic" })).toBeNull();

  });

  it("respects explicit cross-provider member order instead of the default provider", () => {
    const catalog = settings();
    catalog.defaults.providerId = "codex";
    catalog.providers.push({
      id: "second-provider",
      connected: true,
      models: [{ id: "preferred-first", visible: true, available: true }],
    });
    catalog.harnesses[0].compatibleProviderIds.push("second-provider");
    catalog.families[0].members = [
      { providerId: "second-provider", modelId: "preferred-first", position: 0, roles: [{ name: "orchestrator" }] },
      { providerId: "codex", modelId: "one", position: 1, roles: [] },
    ];
    expect(firstAvailableSelection(catalog, "codex-basic")).toMatchObject({
      providerId: "second-provider",
      modelId: "preferred-first",
    });
  });

  it("intersects a harness-specific model subset with family membership", () => {
    const catalog = settings();
    catalog.harnesses[0].modelCompatibility = [{
      providerId: "codex",
      modelIds: ["two"],
      preferredModelId: "two",
    }];
    catalog.providers[0].models[1].available = true;
    // The designated orchestrator is incompatible; an available specialist cannot replace it.
    expect(availablePickerFamilies(catalog, "codex-basic")).toEqual([]);
  });

  it("does not make Prime selectable when its model rules match no available family member", () => {
    const catalog = settings();
    catalog.providers[0].adapterId = "codex-subscription";
    catalog.harnesses.push({
      id: "prime-agent-basic",
      label: "Prime Agent Basic",
      available: true,
      modelRules: {
        allow: [{ adapterId: "openai-api", modelIdRegex: ".*" }],
        deny: [],
      },
      executionAccessContracts: ["secret@1"],
    });
    expect(availablePickerFamilies(catalog, "prime-agent-basic")).toEqual([]);
    expect(firstAvailableSelection(catalog, "prime-agent-basic")).toBeNull();
    expect(normalizePickerSelection(catalog, { harnessId: "prime-agent-basic" })).toBeNull();
    expect(pickerSelectionIsAvailable(catalog, { harnessId: "prime-agent-basic" })).toBe(false);
  });

  it("switches to a harness whose only usable family is not the configured default family", () => {
    const catalog = settings();
    catalog.defaults.familyId = 1;
    catalog.providers[0].adapterId = "codex-subscription";
    catalog.providers.push({
      id: "router",
      adapterId: "openrouter",
      connected: true,
      models: [{ id: "qwen", visible: true, available: true }],
    });
    catalog.families.push({
      id: 3,
      name: "OpenRouter",
      enabled: true,
      position: 2,
      members: [{ providerId: "router", modelId: "qwen", position: 0, roles: [{ name: "orchestrator" }] }],
    });
    catalog.harnesses.push({
      id: "prime-agent-basic",
      label: "Prime Agent Basic",
      available: true,
      modelRules: {
        allow: [{ adapterId: "openrouter", modelIdRegex: ".*" }],
        deny: [],
      },
      executionAccessContracts: ["secret@1"],
    });
    const current = normalizePickerSelection(catalog, null);
    expect(current).toMatchObject({ harnessId: "codex-basic", familyId: 1 });
    expect(availablePickerFamilies(catalog, "prime-agent-basic").map(({ id }) => id)).toEqual([3]);

  });

  it("keeps the first family's first available member authoritative over a later preferred model", () => {
    const catalog = settings();
    catalog.providers[0].models[1].available = true;
    catalog.families.push({
      id: 3,
      name: "Later family",
      enabled: true,
      position: 2,
      members: [
        { providerId: "codex", modelId: "one", position: 0, roles: [{ name: "orchestrator" }] },
        { providerId: "codex", modelId: "two", position: 1, roles: [] },
      ],
    });
    catalog.families[0].members = [
      { providerId: "codex", modelId: "one", position: 0, roles: [{ name: "orchestrator" }] },
    ];
    catalog.harnesses[0].modelCompatibility = [{
      providerId: "codex",
      modelIds: ["one", "two"],
      preferredModelId: "two",
    }];
    expect(firstAvailableSelection(catalog, "codex-basic")).toEqual({
      harnessId: "codex-basic",
      familyId: 1,
      providerId: "codex",
      modelId: "one",
    });
    expect(normalizePickerSelection(catalog, { harnessId: "codex-basic" }))
      .toEqual({
        harnessId: "codex-basic",
        familyId: 1,
        providerId: "codex",
        modelId: "one",
      });
  });

  it("inherits a prior family and resolves its designated orchestrator", () => {
    const catalog = settings();
    expect(selectionForInteraction(catalog, "codex-basic", {
      modelSelection: { familyId: 1, providerId: "codex", modelId: "one" },
    })).toMatchObject({ modelId: "one" });
    const stale = selectionForInteraction(catalog, "codex-basic", {
      modelFamilyId: 1,
      modelProviderId: "codex",
      providerModelId: "two",
    });
    expect(stale).toMatchObject({ familyId: 1, providerId: "codex", modelId: "one" });
    expect(selectionForNextInteraction(catalog, "codex-basic", {
      modelSelection: { familyId: 1, providerId: "codex", modelId: "two" },
    })).toEqual({
      harnessId: "codex-basic",
      familyId: 1,
      providerId: "codex",
      modelId: "one",
    });
    expect(pickerSelectionIsAvailable(catalog, stale)).toBe(true);
    expect(normalizePickerSelection(catalog, stale)).toMatchObject({ modelId: "one" });
  });

  it("preserves a removed family as blocked intent until the user explicitly chooses again", () => {
    const catalog = settings();
    catalog.families = [{
      id: 3,
      name: "Replacement",
      enabled: true,
      position: 0,
      members: [{ providerId: "codex", modelId: "one", position: 0, roles: [{ name: "orchestrator" }] }],
    }];
    const blocked = selectionForNextInteraction(catalog, "codex-basic", {
      modelSelection: { familyId: 99, providerId: "codex", modelId: "removed" },
    });
    expect(blocked).toEqual({
      harnessId: "codex-basic",
      familyId: 99,
      providerId: "codex",
      modelId: "removed",
    });
    const presentation = modelPickerFamilyPresentation(catalog, "codex-basic", blocked);
    expect(presentation.selectedFamily.id).toBe(3);
    expect(presentation.requiresExplicitSelection).toBe(true);
  });

  it("uses first available only when no explicit model was selected", () => {
    const catalog = settings();
    expect(normalizePickerSelection(catalog, { harnessId: "codex-basic" })).toMatchObject({
      familyId: 1,
      providerId: "codex",
      modelId: "one",
    });
    expect(reconcilePickerSelection(catalog, {
      harnessId: "codex-basic",
      familyId: 99,
      providerId: "codex",
      modelId: "removed",
    })).toEqual({
      harnessId: "codex-basic",
      familyId: 99,
      providerId: "codex",
      modelId: "removed",
    });
  });

  it("resolves only the configured default family without falling through to another family", () => {
    const catalog = settings();
    catalog.defaults.familyId = 2;
    expect(defaultFamilySelection(catalog, "codex-basic")).toBeNull();
    catalog.defaults.familyId = 1;
    expect(defaultFamilySelection(catalog, "codex-basic")).toMatchObject({
      familyId: 1,
      providerId: "codex",
      modelId: "one",
    });
    expect(defaultFamilySelectionForProvider(catalog, "codex-basic", "other-provider")).toBeNull();
    expect(defaultFamilySelectionForProvider(catalog, "codex-basic", "codex")).toMatchObject({
      familyId: 1,
      providerId: "codex",
    });
  });

  it("adopts new defaults when picker context explicitly replaces its prior selection", () => {
    const catalog = settings();
    catalog.defaults.harnessId = "prime-agent-basic";
    const currentSelection = { harnessId: "codex-basic" };
    expect(modelPickerContextCandidate({
      settings: catalog,
      mode: "new",
      pinnedHarnessId: null,
      currentSelection,
      nextSelection: null,
      replaceSelection: true,
    })).toEqual({ harnessId: "prime-agent-basic" });
    expect(modelPickerContextCandidate({
      settings: catalog,
      mode: "new",
      pinnedHarnessId: null,
      currentSelection,
      nextSelection: null,
      replaceSelection: false,
    })).toEqual({ harnessId: "codex-basic" });
  });

  it("resets a new-thread picker to the configured default family rather than family order", () => {
    const catalog = settings();
    catalog.families.push({
      id: 3,
      name: "Configured default",
      enabled: true,
      position: 2,
      members: [{ providerId: "codex", modelId: "one", position: 0, roles: [{ name: "orchestrator" }] }],
    });
    catalog.defaults.familyId = 3;
    const candidate = modelPickerContextCandidate({
      settings: catalog,
      mode: "new",
      pinnedHarnessId: null,
      currentSelection: { harnessId: "codex-basic", familyId: 1, providerId: "codex", modelId: "one" },
      nextSelection: null,
      replaceSelection: true,
    });
    expect(reconcilePickerSelection(catalog, candidate)).toMatchObject({
      harnessId: "codex-basic",
      familyId: 3,
      providerId: "codex",
      modelId: "one",
    });
  });

  it("serializes only product identities and never raw harness settings", () => {
    expect(pickerSelectionPayload({
      harnessId: "codex-basic",
      familyId: 1,
      providerId: "codex",
      modelId: "one",
    })).toEqual({
      harnessId: "codex-basic",
      modelSelection: { familyId: 1 },
    });
  });
});

describe("legacy conversation compatibility", () => {
  it("resolves historical choices to the designated route within conversation compatibility", () => {
    const catalog = settings();
    catalog.conversationCompatibility = { status: "compatible", providerId: "codex", harnessId: "codex-basic" };
    catalog.providers[1].connected = true;
    catalog.harnesses[0].compatibleProviderIds.push("future");
    expect(availablePickerFamilies(catalog, "codex-basic")[0].availableMembers.map(m => m.providerId)).toEqual(["codex"]);
    expect(pickerSelectionIsAvailable(catalog, { harnessId: "codex-basic", familyId: 1, providerId: "future", modelId: "three" })).toBe(true);
    expect(pickerSelectionIsAvailable(catalog, { harnessId: "codex-basic", familyId: 1, providerId: "codex", modelId: "one" })).toBe(true);
    expect(availablePickerFamilies(catalog, "cooked")).toEqual([]);
    catalog.conversationCompatibility = { status: "blocked", message: "History ownership cannot be verified." };
    expect(availablePickerFamilies(catalog, "codex-basic")).toEqual([]);
  });
});

it("blocks unavailable orchestrators without choosing a specialist or another family", () => {
  const catalog = settings();
  catalog.defaults.familyId = 1;
  catalog.providers[0].models[0].available = false;
  catalog.providers[0].models[1].available = true;
  catalog.families.push({ ...structuredClone(catalog.families[0]), id: 3, members: [{ providerId: "codex", modelId: "two", position: 0, roles: [{ name: "orchestrator" }] }] });
  expect(firstAvailableSelection(catalog, "codex-basic")).toBeNull();
  expect(normalizePickerSelection(catalog, { harnessId: "codex-basic", familyId: 1, providerId: "codex", modelId: "two" })).toBeNull();
  expect(modelPickerFamilyPresentation(catalog, "codex-basic", { harnessId: "codex-basic", familyId: 1 })).toMatchObject({ selectedFamily: null, modelSetup: { action: "family-settings", label: "Orchestrator unavailable" } });
});

it("judges the designated orchestrator against the requested harness", () => {
  const catalog = settings();
  catalog.defaults.familyId = 1;
  catalog.defaults.harnessId = "cooked";
  expect(firstAvailableSelection(catalog, "codex-basic")).toMatchObject({ familyId: 1, modelId: "one" });
  catalog.defaults.harnessId = "codex-basic";
  expect(firstAvailableSelection(catalog, "cooked")).toBeNull();
  catalog.providers[0].models = [];
  expect(firstAvailableSelection(catalog, "codex-basic")).toBeNull();
});
