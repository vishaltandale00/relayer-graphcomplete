import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copySystemFamily,
  createFamilyVisibilityGate,
  createModelFamilyDraft,
  defaultHarnessError,
  MAX_MODELS_PER_FAMILY,
  modelMember,
  moveItem,
  preserveFamilyEditAfterRefresh,
  reconcileSavedFamily,
  validateCustomFamily,
} from "../desktop/renderer/src/model-family-model.js";
import {
  createModelFamily,
  deleteModelFamily,
  loadModelSettings,
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

describe("model family settings model", () => {
  it("reconciles a persisted create before a follow-up refresh", () => {
    const draft = createModelFamilyDraft([codexProvider], 7);
    draft.name = "Coding";
    const saved = reconcileSavedFamily(draft, {
      id: 42,
      name: "Coding",
      kind: "custom",
      enabled: true,
      position: 3,
    });
    expect(saved).toMatchObject({
      id: 42,
      name: "Coding",
      kind: "custom",
      enabled: true,
      position: 3,
      draft: false,
      editing: false,
    });
    expect(saved.models).toEqual(draft.models);
  });

  it("serializes visibility updates for each family", () => {
    const gate = createFamilyVisibilityGate();
    expect(gate.begin(7)).toBe(true);
    expect(gate.begin("7")).toBe(false);
    expect(gate.isPending(7)).toBe(true);
    gate.end("7");
    expect(gate.begin(7)).toBe(true);
  });

  it("starts a custom family with the first available model from a connected provider", () => {
    const draft = createModelFamilyDraft([codexProvider], 7);
    expect(draft).toMatchObject({ id: "draft-7", kind: "custom", enabled: true, draft: true });
    expect(draft.models).toEqual([expect.objectContaining({
      providerId: "codex",
      modelId: "gpt-5.6-sol",
    })]);
  });

  it("starts a new family from the saved default provider without constraining later membership", () => {
    const other = {
      id: "other",
      label: "Other",
      connected: true,
      models: [{ id: "other-first", label: "Other first", available: true }],
    };
    const draft = createModelFamilyDraft([other, codexProvider], 8, "codex");
    expect(draft.models[0]).toMatchObject({ providerId: "codex", modelId: "gpt-5.6-sol" });
  });

  it("rejects empty, duplicate, zero-member, duplicate-member, and oversized custom families", () => {
    expect(validateCustomFamily({ id: "new", name: " ", models: [] }, []))
      .toEqual({ name: "Enter a family name.", models: "Add at least one model." });

    const member = { providerId: "codex", modelId: "gpt-5.6-sol" };
    expect(validateCustomFamily(
      { id: "new", name: "Coding", models: [member, member] },
      [{ id: "existing", name: "coding", models: [member] }],
    )).toEqual({
      name: "A family with this name already exists.",
      models: "Each provider model can appear only once.",
    });

    expect(validateCustomFamily({
      id: "new",
      name: "Large",
      models: Array.from({ length: MAX_MODELS_PER_FAMILY + 1 }, (_, index) => ({
        providerId: "codex",
        modelId: `model-${index}`,
      })),
    })).toEqual({ models: "Remove 1 model." });
  });

  it("preserves explicit order and copies system membership into an editable custom draft", () => {
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    const source = {
      name: "Codex",
      kind: "system",
      models: Array.from({ length: 6 }, (_, index) => ({ providerId: "codex", modelId: `m-${index}` })),
    };
    const copy = copySystemFamily(source, 9);
    expect(copy).toMatchObject({ id: "draft-9", name: "Copy of Codex", kind: "custom", draft: true });
    expect(copy.models).toHaveLength(MAX_MODELS_PER_FAMILY);
  });

  it("treats the same model id from different providers as distinct family members", () => {
    expect(validateCustomFamily({
      id: "cross-provider",
      name: "Coding",
      models: [
        { providerId: "codex", modelId: "shared-name" },
        { providerId: "future-provider", modelId: "shared-name" },
      ],
    })).toEqual({});
  });

  it("marks disconnected-provider and hidden-model family members unavailable", () => {
    expect(modelMember(
      { id: "offline", label: "Offline", connected: false },
      { id: "model", label: "Model", visible: true, available: true },
    )).toMatchObject({ available: false, unavailableReason: "This provider is not connected." });
    expect(modelMember(
      { id: "codex", label: "Codex", connected: true },
      { id: "hidden", label: "Hidden", visible: false, available: true },
    )).toMatchObject({ available: false, unavailableReason: "This model is hidden by the provider." });
  });

  it("preserves unsaved draft and edit state across provider catalog refreshes", () => {
    const serverFamilies = [{ id: 1, name: "Server", kind: "custom", position: 0, models: [] }];
    const edited = preserveFamilyEditAfterRefresh(serverFamilies, {
      id: 1,
      name: "Unsaved name",
      kind: "custom",
      position: 0,
      editing: true,
      models: [{ providerId: "codex", modelId: "gpt-5.6-sol" }],
    });
    expect(edited.families[0]).toMatchObject({ name: "Unsaved name", editing: true });
    expect(edited.editSnapshot).toMatchObject({ name: "Server" });

    const draft = preserveFamilyEditAfterRefresh(serverFamilies, {
      id: "draft-1",
      name: "Draft",
      kind: "custom",
      draft: true,
      models: [],
    });
    expect(draft.selectedIndex).toBe(1);
    expect(draft.families[1]).toMatchObject({ name: "Draft", draft: true });

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
    expect(offScreen.preservedIndexes).toEqual([0, 1]);
    expect(offScreen.families).toEqual([
      expect.objectContaining({ id: 1, name: "Edited off screen", editing: true }),
      expect.objectContaining({ id: "draft-2", name: "Draft off screen", draft: true }),
    ]);
  });

  it("surfaces an unavailable saved harness instead of selecting another", () => {
    const settings = {
      defaults: { harnessId: "codex-basic" },
      harnesses: [
        { id: "codex-basic", available: false, unavailableReason: {
          code: "harness_no_available_models",
          message: "No available models for this harness.",
        } },
        { id: "other", available: true },
      ],
    };
    expect(defaultHarnessError(settings)).toBe("No available models for this harness.");
    expect(settings.defaults.harnessId).toBe("codex-basic");
  });
});

describe("model settings API boundary", () => {
  it("uses the catalog and granular persistence routes", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetchMock);

    await loadModelSettings();
    await saveModelDefaults({ harnessId: "codex-basic", providerId: "codex" });
    await validateModelSelection({ harnessId: "codex-basic", familyId: 1, providerId: "codex", modelId: "gpt-5" });
    await createModelFamily({ name: "Coding", enabled: true, members: [] });
    await updateModelFamily(12, { name: "Coding", enabled: false, members: [] });
    await deleteModelFamily(12);
    await saveModelFamilyOrder([12, 4]);

    expect(fetchMock.mock.calls.map(([path, options]) => [path, options?.method ?? "GET"])).toEqual([
      ["/api/model-settings", "GET"],
      ["/api/model-settings/defaults", "PUT"],
      ["/api/model-selection/validate", "POST"],
      ["/api/model-families", "POST"],
      ["/api/model-families/12", "PUT"],
      ["/api/model-families/12", "DELETE"],
      ["/api/model-families/order", "PUT"],
    ]);
  });
});

describe("model family settings layout", () => {
  it("ships one-family snap scrolling, a scrollable hover/focus list, and light/narrow styles", async () => {
    const [html, css] = await Promise.all([
      readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/styles.css", import.meta.url), "utf8"),
    ]);
    expect(html).toContain("Models and harnesses");
    expect(html).toContain("<h3>Defaults</h3>");
    expect(html).toContain("<b>Harness</b>");
    expect(html).toContain("<b>Provider</b>");
    const defaultsIndex = html.indexOf('class="model-defaults"');
    const dividerIndex = html.indexOf('class="model-settings-divider"');
    const familyHeadingIndex = html.indexOf('class="model-families-heading"');
    const familyControlsIndex = html.indexOf('class="family-carousel-controls"');
    const newFamilyIndex = html.indexOf('id="newModelFamily"');
    const carouselIndex = html.indexOf('id="familyCarousel"');
    expect(defaultsIndex).toBeLessThan(dividerIndex);
    expect(dividerIndex).toBeLessThan(familyHeadingIndex);
    expect(familyHeadingIndex).toBeLessThan(familyControlsIndex);
    expect(familyControlsIndex).toBeLessThan(carouselIndex);
    expect(newFamilyIndex).toBeLessThan(carouselIndex);
    expect(html).toContain('id="familyCarousel"');
    expect(html).toContain('id="familyJumpList" role="listbox"');
    expect(css).toContain(".family-slide{flex:0 0 100%");
    expect(css).toContain("scroll-snap-type:x mandatory");
    expect(css).toContain(".current-family-control:hover .family-jump-list,.current-family-control:focus-within .family-jump-list");
    expect(css).toContain("max-height:190px;overflow-y:auto");
    expect(css).toContain('@media(max-width:760px)');
    expect(css).toContain('html[data-theme="light"] .family-card');
    expect(css).toContain(".model-settings-divider{height:1px");
    expect(css).toContain(".model-families-heading{display:grid;grid-template-columns:1fr auto 1fr");
    expect(css).toContain(".model-families-heading .family-carousel-controls{margin:0}");
    expect(html).not.toContain("Families contain up to 5 models");
    const settingsSource = await readFile(new URL("../desktop/renderer/src/model-family-settings.js", import.meta.url), "utf8");
    expect(settingsSource).toContain("owner?.connected === false || model.visible === false || model.available === false");
    expect(settingsSource).toContain('data-family-delete="${index}"');
    expect(settingsSource).toContain("await deleteModelFamily(family.id);");
    expect(settingsSource).toContain("if (settings.families.some((family) => family.draft || family.editing)) return;");
    expect(settingsSource).toContain("if (savingFamily) return;");
    expect(settingsSource).toContain("reconcileSavedFamily(family, saved)");
    expect(settingsSource).toContain("Saved, but could not refresh:");
    expect(settingsSource).toContain("familyVisibilityGate.isPending(family.id)");
    expect(settingsSource).toContain('$("#defaultHarnessSelect").disabled = savingDefaults');
    expect(settingsSource).toContain("await preparePermissionProfiles(candidate)");
    expect(settingsSource).toContain("await saveModelDefaults({ [field]: candidate })");
    expect(settingsSource).toContain("resetNewThreadModelPicker();");
    expect(settingsSource).toContain("refreshNewThreadModelPicker();");
    expect(settingsSource).toContain('$("#familyNameInput").value = current.name;');
    expect(settingsSource).not.toContain('value="${escapeHtml(family.name)}"');
    expect(settingsSource).toContain("if (savingOrder) return;");
    expect(settingsSource).toContain('savingOrder || index === 0 ? "disabled"');
    expect(settingsSource).toContain('savingOrder || index === settings.families.length - 1 ? "disabled"');
  });
});
