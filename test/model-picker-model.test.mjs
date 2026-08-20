import { describe, expect, it } from "vitest";

import {
  availablePickerFamilies,
  firstAvailableSelection,
  NO_MODELS_FOR_HARNESS,
  normalizePickerSelection,
  pickerSelectionPayload,
  selectCandidateHarness,
  selectionForInteraction,
  validateCandidateHarness,
} from "../desktop/renderer/src/model-picker-model.js";

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
  it("shows only enabled families with currently available compatible models", () => {
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
      { providerId: "second-provider", modelId: "preferred-first", position: 0 },
      { providerId: "codex", modelId: "one", position: 1 },
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
    expect(availablePickerFamilies(catalog, "codex-basic")[0].availableMembers).toEqual([
      { providerId: "codex", modelId: "two", position: 1 },
    ]);
  });

  it("inherits an available prior interaction model and falls back within its family", () => {
    const catalog = settings();
    expect(selectionForInteraction(catalog, "codex-basic", {
      modelSelection: { familyId: 1, providerId: "codex", modelId: "one" },
    })).toMatchObject({ modelId: "one" });
    expect(selectionForInteraction(catalog, "codex-basic", {
      modelFamilyId: 1,
      modelProviderId: "codex",
      providerModelId: "two",
    })).toMatchObject({ modelId: "one" });
  });

  it("rolls back the complete selection when a candidate harness has no models", () => {
    const catalog = settings();
    const current = normalizePickerSelection(catalog, null);
    expect(selectCandidateHarness(catalog, current, "cooked")).toEqual({
      selection: current,
      error: NO_MODELS_FOR_HARNESS,
    });
  });

  it("rolls back a stale candidate when trusted server validation rejects it", async () => {
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
