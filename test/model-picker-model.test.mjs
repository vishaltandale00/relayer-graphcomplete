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
    it("routes catalog-owned and configuration-owned harnesses explicitly", async () => {
    const cases = [
      {
        label: "requires an explicit model whenever a harness declares model rules",
        run: async () => {
          const catalog = settings();
          const harness = catalog.harnesses.find((item) => item.id === "codex-basic");
          harness.modelRules = { allow: [], deny: [] };
          harness.modelCompatibility = [];
          harness.compatibleProviderIds = [];

          expect(harnessUsesConfigurationModel(catalog, "codex-basic")).toBe(false);
        },
      },
      {
        label: "keeps a configuration-owned model path for development harnesses without a provider catalog",
        run: async () => {
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
          const validate = async () => { throw new Error("model validation must not run"); };
          await expect(validateCandidateHarness(
            catalog,
            normalizePickerSelection(catalog, { harnessId: "codex-basic" }),
            "prime-agent-basic",
            validate,
          )).resolves.toEqual({ selection: { harnessId: "prime-agent-basic" }, error: null });
        },
      },
    ];
    const outcomes = await Promise.allSettled(cases.map(async ({ label, run }) => {
      try {
        await run();
        return label;
      } catch (error) {
        throw new Error(`Case failed: ${label}`, { cause: error });
      }
    }));
    expect(outcomes).toEqual(["requires an explicit model whenever a harness declares model rules", "keeps a configuration-owned model path for development harnesses without a provider catalog"].map((value) => ({ status: "fulfilled", value })));
  });

it("recognizes typed catalog rejections that require picker reconciliation", () => {
    expect(isModelSelectionCatalogError({ code: "model_unavailable" })).toBe(true);
    expect(isModelSelectionCatalogError({ code: "harness_model_incompatible" })).toBe(true);
    expect(isModelSelectionCatalogError({ code: "interaction_in_progress" })).toBe(false);
    expect(isModelSelectionCatalogError(new Error("network"))).toBe(false);
  });

  it("filters available families through catalog and harness policy", async () => {
    const cases = [
      {
        label: "shows only enabled families with currently available compatible models",
        run: async () => {
          const catalog = settings();
          const families = availablePickerFamilies(catalog, "codex-basic");
          expect(families.map(({ id }) => id)).toEqual([1]);
          expect(families[0].availableMembers).toEqual([
            { providerId: "codex", modelId: "one", position: 0 },
          ]);
          expect(firstAvailableSelection(catalog, "codex-basic")).toEqual({
            harnessId: "codex-basic",
            familyId: 1,
            providerId: "codex",
            modelId: "one",
          });
        },
      },
      {
        label: "intersects a harness-specific model subset with family membership",
        run: async () => {
          const catalog = settings();
          catalog.harnesses[0].modelCompatibility = [{
            providerId: "codex",
            modelIds: ["two"],
            preferredModelId: "two",
          }];
          catalog.providers[0].models[1].available = true;
          expect(availablePickerFamilies(catalog, "codex-basic")[0].availableMembers).toEqual([
            { providerId: "codex", modelId: "two", position: 1 },
          ]);
        },
      },
      {
        label: "does not make Prime selectable when its model rules match no available family member",
        run: async () => {
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
        },
      },
    ];
    const outcomes = await Promise.allSettled(cases.map(async ({ label, run }) => {
      try {
        await run();
        return label;
      } catch (error) {
        throw new Error(`Case failed: ${label}`, { cause: error });
      }
    }));
    expect(outcomes).toEqual(["shows only enabled families with currently available compatible models", "intersects a harness-specific model subset with family membership", "does not make Prime selectable when its model rules match no available family member"].map((value) => ({ status: "fulfilled", value })));
  });

  it("keeps authored family and member order authoritative", async () => {
    const cases = [
      {
        label: "respects explicit cross-provider member order instead of the default provider",
        run: async () => {
          const catalog = settings();
          catalog.defaults.providerId = "codex";
          catalog.providers.push({
            id: "second-provider",
            connected: true,
            models: [{ id: "preferred-first", visible: true, available: true }],
          });
          catalog.harnesses[0].compatibleProviderIds.push("second-provider");
          catalog.families[0].members = [
            { providerId: "second-provider", modelId: "preferred-first", position: 0 },
            { providerId: "codex", modelId: "one", position: 1 },
          ];
          expect(firstAvailableSelection(catalog, "codex-basic")).toMatchObject({
            providerId: "second-provider",
            modelId: "preferred-first",
          });
        },
      },
      {
        label: "switches to a harness whose only usable family is not the configured default family",
        run: async () => {
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
            members: [{ providerId: "router", modelId: "qwen", position: 0 }],
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
          expect(selectCandidateHarness(catalog, current, "prime-agent-basic")).toEqual({
            selection: { harnessId: "prime-agent-basic", familyId: null, providerId: null, modelId: null },
            error: null,
          });
        },
      },
      {
        label: "keeps the first family's first available member authoritative over a later preferred model",
        run: async () => {
          const catalog = settings();
          catalog.providers[0].models[1].available = true;
          catalog.families.push({
            id: 3,
            name: "Later family",
            enabled: true,
            position: 2,
            members: [
              { providerId: "codex", modelId: "one", position: 0 },
              { providerId: "codex", modelId: "two", position: 1 },
            ],
          });
          catalog.families[0].members = [
            { providerId: "codex", modelId: "one", position: 0 },
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
        },
      },
    ];
    const outcomes = await Promise.allSettled(cases.map(async ({ label, run }) => {
      try {
        await run();
        return label;
      } catch (error) {
        throw new Error(`Case failed: ${label}`, { cause: error });
      }
    }));
    expect(outcomes).toEqual(["respects explicit cross-provider member order instead of the default provider", "switches to a harness whose only usable family is not the configured default family", "keeps the first family's first available member authoritative over a later preferred model"].map((value) => ({ status: "fulfilled", value })));
  });

  it("preserves explicit model intent and falls back only when intent is absent", async () => {
    const cases = [
      {
        label: "inherits an available prior model and reselects within its family when stale",
        run: async () => {
          const catalog = settings();
          expect(selectionForInteraction(catalog, "codex-basic", {
            modelSelection: { familyId: 1, providerId: "codex", modelId: "one" },
          })).toMatchObject({ modelId: "one" });
          const stale = selectionForInteraction(catalog, "codex-basic", {
            modelFamilyId: 1,
            modelProviderId: "codex",
            providerModelId: "two",
          });
          expect(stale).toMatchObject({ familyId: 1, providerId: "codex", modelId: "two" });
          expect(selectionForNextInteraction(catalog, "codex-basic", {
            modelSelection: { familyId: 1, providerId: "codex", modelId: "two" },
          })).toEqual({
            harnessId: "codex-basic",
            familyId: 1,
            providerId: "codex",
            modelId: "one",
          });
          expect(pickerSelectionIsAvailable(catalog, stale)).toBe(false);
          expect(normalizePickerSelection(catalog, stale)).toBeNull();
        },
      },
      {
        label: "preserves a removed family as blocked intent until the user explicitly chooses again",
        run: async () => {
          const catalog = settings();
          catalog.families = [{
            id: 3,
            name: "Replacement",
            enabled: true,
            position: 0,
            members: [{ providerId: "codex", modelId: "one", position: 0 }],
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
        },
      },
      {
        label: "uses first available only when no explicit model was selected",
        run: async () => {
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
        },
      },
    ];
    const outcomes = await Promise.allSettled(cases.map(async ({ label, run }) => {
      try {
        await run();
        return label;
      } catch (error) {
        throw new Error(`Case failed: ${label}`, { cause: error });
      }
    }));
    expect(outcomes).toEqual(["inherits an available prior model and reselects within its family when stale", "preserves a removed family as blocked intent until the user explicitly chooses again", "uses first available only when no explicit model was selected"].map((value) => ({ status: "fulfilled", value })));
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

  it("rolls back candidate harness selection across local and trusted validation failures", async () => {
    const cases = [
      {
        label: "rolls back the complete selection when a candidate harness has no models",
        run: async () => {
          const catalog = settings();
          const current = normalizePickerSelection(catalog, null);
          expect(selectCandidateHarness(catalog, current, "cooked")).toEqual({
            selection: current,
            error: NO_MODELS_FOR_HARNESS,
          });
        },
      },
      {
        label: "rolls back a stale candidate when trusted server validation rejects it",
        run: async () => {
          const catalog = settings();
          catalog.harnesses.push({
            id: "stale",
            label: "Stale",
            available: true,
            compatibleProviderIds: ["codex"],
          });
          const current = normalizePickerSelection(catalog, null);
          const validateSelection = async () => { throw new Error("stale catalog"); };
          await expect(validateCandidateHarness(catalog, current, "stale", validateSelection)).resolves.toEqual({
            selection: current,
            error: NO_MODELS_FOR_HARNESS,
          });
        },
      },
    ];
    const outcomes = await Promise.allSettled(cases.map(async ({ label, run }) => {
      try {
        await run();
        return label;
      } catch (error) {
        throw new Error(`Case failed: ${label}`, { cause: error });
      }
    }));
    expect(outcomes).toEqual(["rolls back the complete selection when a candidate harness has no models", "rolls back a stale candidate when trusted server validation rejects it"].map((value) => ({ status: "fulfilled", value })));
  });

  it("adopts authoritative defaults only when picker context is replaced", async () => {
    const cases = [
      {
        label: "adopts new defaults when picker context explicitly replaces its prior selection",
        run: async () => {
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
        },
      },
      {
        label: "resets a new-thread picker to the configured default family rather than family order",
        run: async () => {
          const catalog = settings();
          catalog.families.push({
            id: 3,
            name: "Configured default",
            enabled: true,
            position: 2,
            members: [{ providerId: "codex", modelId: "one", position: 0 }],
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
        },
      },
    ];
    const outcomes = await Promise.allSettled(cases.map(async ({ label, run }) => {
      try {
        await run();
        return label;
      } catch (error) {
        throw new Error(`Case failed: ${label}`, { cause: error });
      }
    }));
    expect(outcomes).toEqual(["adopts new defaults when picker context explicitly replaces its prior selection", "resets a new-thread picker to the configured default family rather than family order"].map((value) => ({ status: "fulfilled", value })));
  });

it("serializes only product identities and never raw harness settings", () => {
    expect(pickerSelectionPayload({
      harnessId: "codex-basic",
      familyId: 1,
      providerId: "codex",
      modelId: "one",
    })).toEqual({
      harnessId: "codex-basic",
      modelSelection: {
        familyId: 1,
        providerId: "codex",
        modelId: "one",
      },
    });
  });
});
