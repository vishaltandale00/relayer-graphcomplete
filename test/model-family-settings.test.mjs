import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copySystemFamily,
  createFamilyVisibilityGate,
  createModelFamilyDraft,
  defaultHarnessIsSelectable,
  defaultHarnessError,
  usableDefaultHarnesses,
  MAX_MODELS_PER_FAMILY,
  modelMember,
  moveItem,
  preserveFamilyEditAfterRefresh,
  reconcileSavedFamily,
  validateCustomFamily,
} from "../desktop/renderer/src/model-family-model.js";
import {
  createModelFamily,
  completeProviderOnboarding,
  deleteModelFamily,
  loadModelSettings,
  loadProviderOnboardingProjection,
  loadProviderOnboardingStatus,
  saveModelDefaults,
  saveModelFamilyOrder,
  updateModelFamily,
  validateModelSelection,
} from "../desktop/renderer/src/model-settings-api.js";

const codexProvider = {
  id: "codex",
  label: "Codex",
  connected: true,
  models: [
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", available: true },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", available: true },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe("model family settings", () => {
  it("drafts, validates, orders, and preserves model families across catalog refreshes", () => {
    const draft = createModelFamilyDraft([codexProvider], 7);
    expect(draft, "custom draft starts with the first connected model").toMatchObject({ id: "draft-7", kind: "custom", enabled: true, draft: true });
    expect(draft.models, "draft seed model").toEqual([expect.objectContaining({
      providerId: "codex",
      modelId: "gpt-5.6-sol",
    })]);

    draft.name = "Coding";
    const saved = reconcileSavedFamily(draft, {
      id: 42,
      name: "Coding",
      kind: "custom",
      enabled: true,
      position: 3,
    });
    expect(saved, "persisted create reconciles before a follow-up refresh").toMatchObject({
      id: 42,
      name: "Coding",
      kind: "custom",
      enabled: true,
      position: 3,
      draft: false,
      editing: false,
    });
    expect(saved.models, "reconciled family keeps draft members").toEqual(draft.models);

    const other = {
      id: "other",
      label: "Other",
      connected: true,
      models: [{ id: "other-first", label: "Other first", available: true }],
    };
    const defaultProviderDraft = createModelFamilyDraft([other, codexProvider], 8, "codex");
    expect(defaultProviderDraft.models[0], "new family seeds from the saved default provider")
      .toMatchObject({ providerId: "codex", modelId: "gpt-5.6-sol" });

    const gate = createFamilyVisibilityGate();
    expect(gate.begin(7), "visibility gate opens for the first family").toBe(true);
    expect(gate.begin(8), "visibility gate serializes concurrent families").toBe(false);
    expect(gate.isPending(8), "blocked family stays pending").toBe(true);
    gate.end(7);
    expect(gate.begin(8), "pending family proceeds after the prior update").toBe(true);

    const sharedMember = { providerId: "codex", modelId: "gpt-5.6-sol" };
    const validationCases = [
      ["empty name and zero members", { id: "new", name: " ", models: [] }, [], {
        name: "Enter a family name.",
        models: "Add at least one model.",
      }],
      ["duplicate name and duplicate member", { id: "new", name: "Coding", models: [sharedMember, sharedMember] }, [
        { id: "existing", name: "coding", models: [sharedMember] },
      ], {
        name: "A family with this name already exists.",
        models: "Each provider model can appear only once.",
      }],
      ["oversized family", {
        id: "new",
        name: "Large",
        models: Array.from({ length: MAX_MODELS_PER_FAMILY + 1 }, (_, index) => ({
          providerId: "codex",
          modelId: `model-${index}`,
        })),
      }, [], { models: "Remove 1 model." }],
      ["same model id from different providers is valid", {
        id: "cross-provider",
        name: "Coding",
        models: [
          { providerId: "codex", modelId: "shared-name" },
          { providerId: "future-provider", modelId: "shared-name" },
        ],
      }, [], {}],
    ];
    expect(validationCases, "custom family validation inventory").toHaveLength(4);
    for (const [label, family, otherFamilies, expected] of validationCases) {
      expect.soft(validateCustomFamily(family, otherFamilies), label).toEqual(expected);
    }

    expect(moveItem(["a", "b", "c"], 2, 0), "explicit family order").toEqual(["c", "a", "b"]);
    const source = {
      name: "Codex",
      kind: "system",
      models: Array.from({ length: 6 }, (_, index) => ({ providerId: "codex", modelId: `m-${index}` })),
    };
    const copy = copySystemFamily(source, 9);
    expect(copy, "system family copies into an editable custom draft").toMatchObject({ id: "draft-9", name: "Copy of Codex", kind: "custom", draft: true });
    expect(copy.models, "copy is capped at the family model limit").toHaveLength(MAX_MODELS_PER_FAMILY);

    expect(modelMember(
      { id: "offline", label: "Offline", connected: false },
      { id: "model", label: "Model", visible: true, available: true },
    ), "disconnected provider member").toMatchObject({ available: false, unavailableReason: "This provider is not connected." });
    expect(modelMember(
      { id: "codex", label: "Codex", connected: true },
      { id: "hidden", label: "Hidden", visible: false, available: true },
    ), "hidden model member").toMatchObject({ available: false, unavailableReason: "This model is hidden by the provider." });

    const serverFamilies = [{ id: 1, name: "Server", kind: "custom", position: 0, models: [] }];
    const edited = preserveFamilyEditAfterRefresh(serverFamilies, {
      id: 1,
      name: "Unsaved name",
      kind: "custom",
      position: 0,
      editing: true,
      models: [{ providerId: "codex", modelId: "gpt-5.6-sol" }],
    });
    expect(edited.families[0], "unsaved edit survives refresh").toMatchObject({ name: "Unsaved name", editing: true });
    expect(edited.editSnapshot, "edit snapshot keeps the server name").toMatchObject({ name: "Server" });

    const preservedDraft = preserveFamilyEditAfterRefresh(serverFamilies, {
      id: "draft-1",
      name: "Draft",
      kind: "custom",
      draft: true,
      models: [],
    });
    expect(preservedDraft.selectedIndex, "draft stays selected").toBe(1);
    expect(preservedDraft.families[1], "draft survives refresh").toMatchObject({ name: "Draft", draft: true });

    const offScreen = preserveFamilyEditAfterRefresh(serverFamilies, [
      {
        id: 1,
        name: "Edited off screen",
        kind: "custom",
        position: 0,
        editing: true,
        models: [{ providerId: "codex", modelId: "gpt-5.6-sol" }],
      },
      {
        id: "draft-2",
        name: "Draft off screen",
        kind: "custom",
        draft: true,
        models: [],
      },
    ]);
    expect(offScreen.preservedIndexes, "off-screen edits and drafts preserved").toEqual([0, 1]);
    expect(offScreen.families, "off-screen family state").toEqual([
      expect.objectContaining({ id: 1, name: "Edited off screen", editing: true }),
      expect.objectContaining({ id: "draft-2", name: "Draft off screen", draft: true }),
    ]);
  });

  it("offers only executable default harnesses and surfaces the saved one when blocked", () => {
    const unavailableSaved = {
      defaults: { harnessId: "codex-basic" },
      harnesses: [
        { id: "codex-basic", available: false, unavailableReason: {
          code: "harness_no_available_models",
          message: "No available models for this harness.",
        } },
        { id: "other", available: true },
      ],
    };
    expect(defaultHarnessError(unavailableSaved), "unavailable saved harness surfaces its reason")
      .toBe("No available models for this harness.");
    expect(unavailableSaved.defaults.harnessId, "unavailable saved harness is not silently replaced")
      .toBe("codex-basic");

    const usableNow = {
      defaults: { harnessId: "claude-basic" },
      harnesses: [
        { id: "codex-basic", usableNow: true },
        {
          id: "claude-basic",
          available: true,
          usableNow: false,
          compatibleProviderIds: ["anthropic"],
          modelCompatibility: [],
        },
      ],
    };
    expect(usableDefaultHarnesses(usableNow), "only currently usable harnesses are offered")
      .toEqual([usableNow.harnesses[0]]);
    expect(defaultHarnessError(usableNow), "not-yet-usable saved harness surfaces its reason").toBe(
      "No currently connected provider and eligible model can use this harness.",
    );
    expect(usableNow.defaults.harnessId, "not-yet-usable saved harness is not replaced").toBe("claude-basic");

    const configurationOwned = {
      defaults: { harnessId: "codex-layered-navigation-luna" },
      harnesses: [
        {
          id: "codex-layered-navigation-luna",
          available: true,
          usableNow: false,
          compatibleProviderIds: [],
          modelCompatibility: [],
        },
      ],
    };
    expect(usableDefaultHarnesses(configurationOwned), "configuration-owned harness stays offered")
      .toEqual(configurationOwned.harnesses);
    expect(defaultHarnessIsSelectable(configurationOwned, configurationOwned.defaults.harnessId), "configuration-owned harness stays selectable")
      .toBe(true);
    expect(defaultHarnessError(configurationOwned), "configuration-owned harness has no error").toBeNull();

    const familyGated = {
      defaults: { harnessId: "codex-basic", familyId: 11 },
      harnesses: [
        {
          id: "codex-basic", usableNow: true, usableFamilyIds: [11],
          compatibleProviderIds: ["openai"], modelCompatibility: [],
        },
        {
          id: "claude-basic", usableNow: true, usableFamilyIds: [12],
          compatibleProviderIds: ["anthropic"], modelCompatibility: [],
        },
      ],
    };
    expect(usableDefaultHarnesses(familyGated), "ordinary defaults require an executable saved family")
      .toEqual([familyGated.harnesses[0]]);
    expect(defaultHarnessIsSelectable(familyGated, "claude-basic"), "family-incompatible harness is not selectable")
      .toBe(false);
  });

  it("persists model settings through granular routes and ships the family settings layout", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await loadModelSettings();
      await saveModelDefaults({ harnessId: "codex-basic", providerId: "codex" });
      await validateModelSelection({ harnessId: "codex-basic", familyId: 1, providerId: "codex", modelId: "gpt-5" });
      await createModelFamily({ name: "Coding", enabled: true, members: [] });
      await updateModelFamily(12, { name: "Coding", enabled: false, members: [] });
      await deleteModelFamily(12);
      await saveModelFamilyOrder([12, 4]);
      await loadProviderOnboardingProjection("anthropic work");
      await completeProviderOnboarding({
        providerId: "anthropic-work", harnessId: "claude-basic", expectedProjectionRevision: "revision-3",
        family: { kind: "existing", familyId: 12 },
      });
      await loadProviderOnboardingStatus();

      expect(fetchMock.mock.calls.map(([path, options]) => [path, options?.method ?? "GET"]), "catalog and granular persistence routes")
        .toEqual([
          ["/api/model-settings", "GET"],
          ["/api/model-settings/defaults", "PUT"],
          ["/api/model-selection/validate", "POST"],
          ["/api/model-families", "POST"],
          ["/api/model-families/12", "PUT"],
          ["/api/model-families/12", "DELETE"],
          ["/api/model-families/order", "PUT"],
          ["/api/provider-onboarding/projection?providerId=anthropic%20work", "GET"],
          ["/api/provider-onboarding/complete", "POST"],
          ["/api/provider-onboarding/status", "GET"],
        ]);
      expect(JSON.parse(fetchMock.mock.calls.at(-2)[1].body), "onboarding completion body").toEqual({
        providerId: "anthropic-work", harnessId: "claude-basic", expectedProjectionRevision: "revision-3",
        family: { kind: "existing", familyId: 12 },
      });
    } finally {
      vi.unstubAllGlobals();
    }

    const [html, css] = await Promise.all([
      readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/styles.css", import.meta.url), "utf8"),
    ]);
    expect(html, "settings tabs").toContain('data-settings-tab="providers"');
    expect(html).toContain('data-settings-tab="models"');
    expect(html).toContain('data-settings-tab="harnesses"');
    expect(html, "model family sections").toContain("Model families");
    expect(html).toContain("<h3>Defaults</h3>");
    expect(html).toContain("<b>Harness</b>");
    expect(html).toContain("<b>Provider</b>");
    const defaultsIndex = html.indexOf('class="model-defaults"');
    const dividerIndex = html.indexOf('class="model-settings-divider"');
    const familyHeadingIndex = html.indexOf('class="model-families-heading"');
    const familyControlsIndex = html.indexOf('class="family-carousel-controls"');
    const newFamilyIndex = html.indexOf('id="newModelFamily"');
    const carouselIndex = html.indexOf('id="familyCarousel"');
    expect(defaultsIndex, "defaults precede the divider").toBeLessThan(dividerIndex);
    expect(dividerIndex, "divider precedes the family heading").toBeLessThan(familyHeadingIndex);
    expect(familyHeadingIndex, "family heading precedes controls").toBeLessThan(familyControlsIndex);
    expect(familyControlsIndex, "controls precede the carousel").toBeLessThan(carouselIndex);
    expect(newFamilyIndex, "new family button precedes the carousel").toBeLessThan(carouselIndex);
    expect(html, "family carousel present").toContain('id="familyCarousel"');
    expect(html, "family jump list present").toContain('id="familyJumpList" role="listbox"');
    expect(css, "one-family snap scrolling").toContain(".family-slide{flex:0 0 100%");
    expect(css).toContain("scroll-snap-type:x mandatory");
    expect(css, "hover/focus jump list").toContain(".current-family-control:hover .family-jump-list,.current-family-control:focus-within .family-jump-list");
    expect(css, "scrollable jump list").toContain("max-height:190px;overflow-y:auto");
    expect(css, "narrow viewport styles").toContain('@media(max-width:760px)');
    expect(css, "light theme styles").toContain('html[data-theme="light"] .family-card');
    expect(css, "settings divider").toContain(".model-settings-divider{height:1px");
    expect(css, "family heading grid").toContain(".model-families-heading{display:grid;grid-template-columns:1fr auto 1fr");
    expect(css, "embedded carousel controls").toContain(".model-families-heading .family-carousel-controls{margin:0}");
    expect(html, "retired copy removed").not.toContain("Families contain up to 5 models");

    const settingsSource = await readFile(new URL("../desktop/renderer/src/model-family-settings.js", import.meta.url), "utf8");
    expect(settingsSource, "member availability gate").toContain("owner?.connected === false || model.visible === false || model.available === false");
    expect(settingsSource, "family delete control").toContain('data-family-delete="${index}"');
    expect(settingsSource, "delete route call").toContain("await deleteModelFamily(family.id);");
    expect(settingsSource, "dirty-state refresh guard").toContain("if (settings.families.some((family) => family.draft || family.editing)) return;");
    expect(settingsSource, "save-in-flight guard").toContain("if (savingFamily) return;");
    expect(settingsSource, "saved family reconciliation").toContain("reconcileSavedFamily(family, saved)");
    expect(settingsSource, "candidate id comparison").toContain("String(candidate.id) === String(familyId)");
    expect(settingsSource, "no index-based reconciliation splice").not.toContain("settings.families[selectedFamilyIndex] = reconcileSavedFamily");
    expect(settingsSource, "refresh failure surface").toContain("Saved, but could not refresh:");
    expect(settingsSource, "visibility gate check").toContain("familyVisibilityGate.isPending()");
    expect(settingsSource, "settings refresh gate").toContain("const settingsRefreshGate = createLatestRequestGate();");
    expect(settingsSource, "stale refresh rejection").toContain("if (!settingsRefreshGate.isCurrent(refreshToken)) return false;");
    expect(settingsSource, "invalid default detection").toContain("const invalidDefault = defaultHarnessIsSelectable(");
    expect(settingsSource, "disabled default select while saving").toContain('$("#defaultHarnessSelect").disabled = savingDefaults');
    expect(settingsSource, "permission profile preparation").toContain("await preparePermissionProfiles(candidate)");
    expect(settingsSource, "granular default persistence").toContain("await saveModelDefaults({ [field]: candidate })");
    expect(settingsSource, "picker reset on default change").toContain("resetNewThreadModelPicker();");
    expect(settingsSource, "picker refresh on settings change").toContain("refreshNewThreadModelPicker();");
    expect(settingsSource, "family name input binding").toContain('$("#familyNameInput").value = current.name;');
    expect(settingsSource, "no attribute-injected family name").not.toContain('value="${escapeHtml(family.name)}"');
    expect(settingsSource, "order save guard").toContain("if (savingOrder) return;");
    expect(settingsSource, "first position disabled").toContain('savingOrder || index === 0 ? "disabled"');
    expect(settingsSource, "last position disabled").toContain('savingOrder || index === settings.families.length - 1 ? "disabled"');
  }, 10_000);
});
