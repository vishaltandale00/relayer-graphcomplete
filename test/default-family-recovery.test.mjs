import { readFile } from "node:fs/promises";

import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defaultFamilyRecoveryPresentation,
  defaultHarnessError,
} from "../desktop/renderer/src/model-family-model.js";
import {
  defaultFamilyModelSetup,
  defaultFamilyRecoveryError,
  firstAvailableSelection,
  requireDefaultModelSelection,
  isModelSelectionCatalogError,
  pickerSelectionIsAvailable,
} from "../desktop/renderer/src/model-picker-model.js";
import { createProviderModelsRefreshedHandler } from "../desktop/renderer/src/provider-ui-model.js";
import { createLiveModelRouteResolver } from "../desktop/eval-main/live-credentials.mjs";
import {
  composerSendTitle,
  createModelPicker,
  modelPickerFamilyPresentation,
  modelPickerMarkup,
  selectionForNextInteraction,
} from "../desktop/renderer/src/model-picker.js";

// PROV-008 (Q15). This is the app server's real /api/model-settings response after a refresh
// reported provider_no_eligible_execution_models for the default family's provider. The Rust
// flow test a_default_family_without_eligible_models_needs_model_setup_until_a_refresh_restores_it
// asserts that the server still returns exactly this.
const recoveringResponse = await readFile(
  new URL("./fixtures/model-settings-default-family-recovery.json", import.meta.url),
  "utf8",
);
const recovering = () => JSON.parse(recoveringResponse);
// The same flow after the provider then disconnected (rejected credentials).
const disconnectedResponse = await readFile(
  new URL("./fixtures/model-settings-default-family-disconnected.json", import.meta.url),
  "utf8",
);
const disconnected = () => JSON.parse(disconnectedResponse);

// recovering() after an eligible refresh restored the default family.
function restored() {
  const settings = recovering();
  settings.defaultFamilyRecovery = null;
  settings.familiesNeedingModelSetup = [];
  const codex = settings.providers.find((provider) => provider.id === "codex");
  codex.unavailableReason = null;
  settings.families.unshift({
    id: 1,
    name: "Codex defaults",
    kind: "system",
    enabled: true,
    position: 0,
    revision: 1,
    managedPolicy: { providerId: "codex", policyId: "codex-default-family", policyVersion: 1 },
    members: [{ providerId: "codex", modelId: "gpt-5.6-sol", position: 0, roles: [{ name: "orchestrator" }] }],
  });
  return settings;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const source = (path) => readFile(new URL(`../desktop/renderer/${path}`, import.meta.url), "utf8");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mountPicker(settings, { mode = "new", ...options } = {}) {
  vi.stubGlobal("requestAnimationFrame", (callback) => { callback(); return 0; });
  const window = new Window({ url: "http://127.0.0.1/" });
  vi.stubGlobal("document", window.document);
  window.document.body.innerHTML = modelPickerMarkup({ mode });
  const root = window.document.querySelector(`[data-model-picker="${mode}"]`);
  const picker = createModelPicker({ root, mode, settings, ...options });
  return { root, picker, document: window.document };
}

// The same server response after the user explicitly chose Work as the default during recovery.
// The Rust flow test asserts that the server then reports only familiesNeedingModelSetup.
function recoveringWithWorkDefault() {
  const settings = recovering();
  settings.defaults = { ...settings.defaults, providerId: "work", familyId: 2 };
  settings.defaultFamilyRecovery = null;
  return settings;
}

describe("default family that needs model setup (PROV-008)", () => {
  it.each(["new", "ongoing"])("cycles compatible families in place with focused arrows in the %s composer", (mode) => {
    const settings = restored();
    settings.families.push({
      ...structuredClone(settings.families[0]),
      id: 99,
      name: "Unavailable family",
      members: [{ providerId: "codex", modelId: "missing", position: 0, roles: [{ name: "orchestrator" }] }],
    });
    const changed = vi.fn();
    const takeover = vi.fn();
    const { root, picker, document } = mountPicker(settings, {
      mode,
      pinnedHarnessId: mode === "ongoing" ? "codex-basic" : null,
      onSelectionChange: changed,
      onUserTakeover: takeover,
    });
    picker.open();
    expect(root.querySelector(".model-family-field [data-family-cycle]")).toBeNull();
    expect(root.querySelector("[data-family-roster] [data-family-cycle]")).not.toBeNull();
    expect([...root.querySelector("[data-model-family]").options].map((option) => option.value)).toEqual(["1", "2"]);
    expect(root.querySelector('[data-family-cycle="previous"]').getAttribute("aria-label")).toBe("Previous model family");
    expect(root.querySelector('[data-family-cycle="next"]').getAttribute("aria-label")).toBe("Next model family");
    for (const [direction, familyId, providerId, memberCount] of [
      ["next", 2, "work", 5], ["next", 1, "codex", 1],
      ["previous", 2, "work", 5], ["previous", 1, "codex", 1],
    ]) {
      root.querySelector(`[data-family-cycle="${direction}"]`).click();
      expect(picker.getSelection()).toMatchObject({ harnessId: "codex-basic", familyId, providerId, modelId: "gpt-5.6-sol" });
      expect(root.querySelector("[data-model-family]").value).toBe(String(familyId));
      expect(root.querySelectorAll("[data-family-member]")).toHaveLength(memberCount);
      expect(root.querySelector(".model-family-members").textContent).toContain("orchestrator");
      expect(root.querySelector("[data-model-picker-popover]").classList.contains("hidden")).toBe(false);
      expect(document.activeElement).toBe(root.querySelector(`[data-family-cycle="${direction}"]`));
    }
    expect(changed).toHaveBeenCalledTimes(4);
    expect(takeover).toHaveBeenCalledTimes(4);
    settings.families = [settings.families[0]];
    picker.setContext({ settings });
    changed.mockClear();
    expect([...root.querySelectorAll("[data-family-cycle]")].every((button) => button.disabled)).toBe(true);
    root.querySelector('[data-family-cycle="next"]').click();
    expect(changed).not.toHaveBeenCalled();
    expect(picker.getSelection()).toMatchObject({ familyId: 1, providerId: "codex" });
  });

  it("cycles explicitly out of recovery into the only usable family and keeps keyboard focus", () => {
    const { root, picker, document } = mountPicker(recovering());
    picker.open();
    expect(picker.isReady()).toBe(false);
    expect([...root.querySelectorAll("[data-family-cycle]")].every((button) => !button.disabled)).toBe(true);
    root.querySelector('[data-family-cycle="previous"]').click();
    expect(picker.getSelection()).toMatchObject({ familyId: 2, providerId: "work", modelId: "gpt-5.6-sol" });
    expect(root.querySelectorAll("[data-family-member]")).toHaveLength(5);
    expect(root.querySelector("[data-model-picker-popover]").classList.contains("hidden")).toBe(false);
    expect([...root.querySelectorAll("[data-family-cycle]")].every((button) => button.disabled)).toBe(true);
    expect(document.activeElement).toBe(root.querySelector("[data-model-family]"));
  });

  it.each(["new", "ongoing"])("handles horizontal roster swipes once per gesture without hijacking other input in the %s composer", (mode) => {
    const settings = restored();
    settings.families.push({ ...structuredClone(settings.families[0]), id: 3, name: "Third family", position: 2 });
    const changed = vi.fn();
    const { root, picker, document } = mountPicker(settings, {
      mode,
      pinnedHarnessId: mode === "ongoing" ? "codex-basic" : null,
      onSelectionChange: changed,
    });
    const wheel = (options, timeStamp, selector = "[data-family-member]") => {
      const event = new document.defaultView.WheelEvent("wheel", { bubbles: true, cancelable: true, ...options });
      Object.defineProperty(event, "timeStamp", { value: timeStamp });
      // Happy DOM omits WheelEvent's inherited MouseEvent modifier properties.
      Object.defineProperty(event, "ctrlKey", { value: options.ctrlKey ?? false });
      root.querySelector(selector).dispatchEvent(event);
      return event;
    };
    picker.open();
    expect(wheel({ deltaX: 10, deltaY: 100 }, 0).defaultPrevented).toBe(false);
    expect(wheel({ deltaX: 80, ctrlKey: true }, 1).defaultPrevented).toBe(false);
    wheel({ deltaX: 12 }, 10);
    wheel({ deltaX: 20 }, 26);
    expect(changed).not.toHaveBeenCalled();
    expect(wheel({ deltaX: 20 }, 42).defaultPrevented).toBe(true);
    expect(picker.getSelection()).toMatchObject({ harnessId: "codex-basic", familyId: 2, providerId: "work" });
    // Momentum, including a mostly vertical tail, belongs to the same gesture.
    wheel({ deltaX: 90 }, 58);
    expect(wheel({ deltaX: 1, deltaY: 3 }, 90).defaultPrevented).toBe(false);
    wheel({ deltaX: -4 }, 100);
    expect(changed).toHaveBeenCalledTimes(1);
    // Deliberate reversal must work before an idle timeout, unlike tiny bounce tails.
    wheel({ deltaX: -20 }, 116);
    wheel({ deltaX: -40 }, 132);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(picker.getSelection()).toMatchObject({ familyId: 1, providerId: "codex" });
    wheel({ deltaX: 60 }, 148);
    expect(changed).toHaveBeenCalledTimes(3);
    wheel({ deltaX: -60 }, 164);
    expect(picker.getSelection()).toMatchObject({ familyId: 1 });
    wheel({ deltaX: 3, deltaMode: 1 }, 650);
    expect(picker.getSelection()).toMatchObject({ familyId: 2, providerId: "work" });
    wheel({ deltaX: -1, deltaMode: 2 }, 850);
    expect(picker.getSelection()).toMatchObject({ familyId: 1, providerId: "codex" });
    expect(changed).toHaveBeenCalledTimes(6);
    expect(wheel({ deltaX: 80 }, 855, ".model-family-field").defaultPrevented).toBe(false);
    picker.close();
    expect(wheel({ deltaX: 80 }, 860).defaultPrevented).toBe(false);
    picker.open("advanced");
    expect(wheel({ deltaX: 80 }, 865).defaultPrevented).toBe(false);
    picker.open("model");
    wheel({ deltaX: 60 }, 870);
    expect(changed).toHaveBeenCalledTimes(7);
    expect(picker.getSelection()).toMatchObject({ familyId: 2, providerId: "work" });
    expect(root.querySelectorAll("[data-family-member]")).toHaveLength(5);
    expect(root.querySelector("[data-model-picker-popover]").classList.contains("hidden")).toBe(false);
    settings.families = [settings.families.find((family) => family.id === 2)];
    picker.setContext({ settings });
    changed.mockClear();
    wheel({ deltaX: 80 }, 1100);
    expect(changed).not.toHaveBeenCalled();
    expect(picker.getSelection()).toMatchObject({ familyId: 2, providerId: "work" });
    picker.dispose();
    expect(wheel({ deltaX: 80 }, 1300).defaultPrevented).toBe(false);
  });

  it.each([false, true])("slides family navigation and settles partial drags with reduced motion = %s", (reducedMotion) => {
    vi.useFakeTimers();
    const { root, picker, document } = mountPicker(restored());
    document.defaultView.matchMedia = () => ({ matches: reducedMotion });
    const animations = [];
    document.defaultView.HTMLElement.prototype.animate = vi.fn(function(frames, options) {
      const animation = { cancel: vi.fn() };
      animations.push({ element: this, frames, options, animation });
      return animation;
    });
    picker.open();
    const event = new document.defaultView.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: 20 });
    root.querySelector("[data-family-member]").dispatchEvent(event);
    expect(picker.getSelection().familyId).toBe(1);
    expect(root.querySelector(".model-family-members").style.transform).toBe(reducedMotion ? "" : "translateX(-20px)");
    vi.advanceTimersByTime(120);
    expect(root.querySelector(".model-family-members").style.transform).toBe("");
    root.querySelector('[data-family-cycle="next"]').click();
    expect(picker.getSelection().familyId).toBe(2);
    if (reducedMotion) {
      expect(animations).toHaveLength(0);
      expect(root.querySelector("[data-family-outgoing]")).toBeNull();
    } else {
      const outgoing = root.querySelector("[data-family-outgoing]");
      expect(outgoing.inert).toBe(true);
      expect(outgoing.getAttribute("aria-hidden")).toBe("true");
      expect(animations.at(-1).frames[0].transform).toBe("translateX(100%)");
      expect(animations.at(-2).frames[1].transform).toBe("translateX(-100%)");
      expect(animations[0].animation.cancel).toHaveBeenCalledOnce();
      animations.at(-2).animation.onfinish();
      expect(outgoing.isConnected).toBe(false);
      root.querySelector('[data-family-cycle="previous"]').click();
      expect(picker.getSelection().familyId).toBe(1);
      expect(animations.at(-1).frames[0].transform).toBe("translateX(-100%)");
      // Rapid navigation cancels the old motion and removes its inert visual copy.
      root.querySelector('[data-family-cycle="next"]').click();
      expect(root.querySelectorAll("[data-family-outgoing]")).toHaveLength(1);
      picker.close();
      expect(animations.at(-1).animation.cancel).toHaveBeenCalledOnce();
      expect(root.querySelector("[data-family-outgoing]")).toBeNull();
    }
    picker.dispose();
  });

  it.each(["new", "ongoing"])("shows the complete read-only family roster and roles in the %s composer", (mode) => {
    const settings = restored();
    const family = settings.families.find((item) => item.id === 1);
    const provider = settings.providers.find((item) => item.id === "codex");
    provider.models.push(
      { id: "heavy-review", label: "Heavy reviewer", available: true, visible: true },
      { id: "heavy-code", label: "Heavy implementer", available: false, visible: true },
    );
    family.members.push(
      { providerId: "codex", modelId: "heavy-code", position: 2, roles: [] },
      { providerId: "codex", modelId: "heavy-review", position: 1, roles: [
        { name: "reviewer", description: 'Check evidence & "assumptions"' },
        { name: "security <img src=x onerror=alert(1)>", description: '" onmouseover="alert(1)' },
      ] },
    );
    const changed = vi.fn();
    const { root, picker, document } = mountPicker(settings, {
      mode,
      pinnedHarnessId: mode === "ongoing" ? "codex-basic" : null,
      onSelectionChange: changed,
    });
    picker.open();
    const rows = [...root.querySelectorAll(".model-family-member")];
    expect(rows.map((row) => row.querySelector("strong").textContent)).toEqual([
      provider.models.find((model) => model.id === "gpt-5.6-sol").label,
      "Heavy reviewer",
      "Heavy implementer",
    ]);
    expect(rows[0].textContent).toContain("orchestrator");
    expect(rows.map((row) => row.querySelector(".model-family-member-provider").textContent)).toEqual([provider.label, provider.label, provider.label]);
    expect([...rows[1].querySelectorAll(".model-family-role")].map((role) => [role.textContent, role.title])).toEqual([
      ["reviewer", 'Check evidence & "assumptions"'],
      ["security <img src=x onerror=alert(1)>", '" onmouseover="alert(1)'],
    ]);
    expect(rows[2].textContent).toContain("Unavailable");
    expect(rows[2].textContent).toContain("No role assigned");
    expect(root.querySelector(".model-family-members").getAttribute("aria-label")).toBe("Family models and roles");
    expect(root.querySelectorAll("[data-model-option], .model-family-members [role=radio], .model-family-members script, .model-family-members img, .model-family-members [onmouseover]")).toHaveLength(0);
    expect(root.querySelectorAll(".model-family-members button[type=button]")).toHaveLength(3);
    const selection = picker.getSelection();
    for (let index = 0; index < rows.length; index += 1) {
      picker.open();
      root.querySelectorAll("[data-family-member]")[index].click();
      expect(picker.getSelection()).toEqual(selection);
      expect(changed).not.toHaveBeenCalled();
      expect(root.querySelector("[data-model-picker-popover]").classList.contains("hidden")).toBe(true);
      expect(root.querySelector("[data-model-picker-trigger]").getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(root.querySelector("[data-model-picker-trigger]"));
    }
    picker.open();

    settings.harnesses.find((harness) => harness.id === "codex-basic").modelCompatibility[0].modelIds = ["gpt-5.6-sol", "heavy-code"];
    picker.setContext({ settings });
    expect(root.querySelectorAll(".model-family-member")).toHaveLength(3);
    expect(root.querySelectorAll(".model-family-member")[1].textContent).toContain("Unavailable");
    expect(picker.getSelection()).toEqual(selection);

    provider.models.find((model) => model.id === "gpt-5.6-sol").available = false;
    family.members[0].roles.push({ name: "planner" });
    picker.setContext({ settings });
    expect(picker.isReady()).toBe(false);
    expect(root.querySelectorAll(".model-family-member")).toHaveLength(3);
    expect(root.querySelector(".model-family-member").textContent).toContain("planner");
    expect(root.querySelector(".model-family-member").textContent).toContain("Unavailable");
    root.querySelector("[data-family-member]").click();
    expect(picker.isReady()).toBe(false);
    expect(root.querySelector("[data-model-picker-popover]").classList.contains("hidden")).toBe(true);
    picker.open();

    const select = root.querySelector("[data-model-family]");
    select.value = "2";
    select.dispatchEvent(new document.defaultView.Event("change", { bubbles: true }));
    expect(picker.getSelection()).toMatchObject({ familyId: 2, providerId: "work", modelId: "gpt-5.6-sol" });
    expect(root.querySelectorAll(".model-family-member")).toHaveLength(5);
    expect(root.querySelector(".model-family-members").textContent).not.toContain("Heavy reviewer");
    expect(root.querySelector("[data-model-picker-popover]").classList.contains("hidden")).toBe(true);
    expect(document.activeElement).toBe(root.querySelector("[data-model-picker-trigger]"));
  });

  it("keeps the default family selected and names its provider's recovery", () => {
    const settings = recovering();
    expect(settings.defaults.familyId).toBe(settings.defaultFamilyRecovery.familyId);
    expect(defaultFamilyModelSetup(settings)).toMatchObject({
      familyId: settings.defaults.familyId,
      familyName: "Codex defaults",
      providerId: "codex",
      providerLabel: "Codex",
      label: "Needs model setup",
      actionLabel: "Refresh models",
      actionName: "Refresh models for Codex",
    });
    expect(defaultFamilyModelSetup(settings).message).toBe(
      "Codex defaults needs model setup. Codex has no models eligible for agent execution.",
    );
    expect(settings.familiesNeedingModelSetup).toEqual([settings.defaultFamilyRecovery]);
    expect(defaultFamilyModelSetup({
      ...settings,
      defaultFamilyRecovery: null,
      familiesNeedingModelSetup: [],
    })).toBeNull();
  });

  it("does not pre-show another provider's family, but still offers it as an explicit choice", () => {
    const settings = recovering();
    const presentation = modelPickerFamilyPresentation(settings, "codex-basic", null);
    expect(presentation.selectedFamily).toBeNull();
    expect(presentation.modelSetup?.familyId).toBe(settings.defaults.familyId);
    expect(presentation.families.map((family) => family.name)).toEqual(["Work defaults"]);

    const chosen = { harnessId: "codex-basic", familyId: 2, providerId: "work", modelId: "gpt-5.6-sol" };
    expect(pickerSelectionIsAvailable(settings, chosen)).toBe(true);
    expect(modelPickerFamilyPresentation(settings, "codex-basic", chosen).modelSetup).toBeNull();
  });

  it("shows Needs model setup in the composer with an exact-provider Refresh models action", async () => {
    const onRefreshModels = vi.fn(async () => {});
    const { root, picker } = mountPicker(recovering(), { onRefreshModels });
    const trigger = root.querySelector("[data-model-picker-trigger]");
    expect(root.querySelector("[data-model-picker-label]").textContent).toBe("Needs model setup");
    expect(trigger.title).toBe(
      "Codex defaults needs model setup. Codex has no models eligible for agent execution.",
    );
    expect(picker.isReady()).toBe(false);
    expect(picker.modelSetup()).toMatchObject({ providerId: "codex" });

    picker.open();
    const panel = root.querySelector('[data-model-picker-panel="model"]');
    expect(panel.textContent).toContain("Needs model setup");
    expect(panel.querySelector("[data-model-option]")).toBeNull();
    const refresh = panel.querySelector("[data-model-picker-refresh]");
    expect(refresh.textContent).toBe("Refresh models");
    expect(refresh.getAttribute("aria-label")).toBe("Refresh models for Codex");
    refresh.focus();
    refresh.click();
    await vi.waitFor(() => expect(onRefreshModels).toHaveBeenCalledWith("codex"));
    // The panel re-renders, and focus returns to the refresh action rather than the page.
    await vi.waitFor(() => expect(
      root.ownerDocument.activeElement?.hasAttribute("data-model-picker-refresh"),
    ).toBe(true));
    picker.dispose();
  });

  it("names a thread's non-default family that needs model setup", () => {
    const settings = recoveringWithWorkDefault();
    const interaction = {
      modelSelection: { familyId: 1, providerId: "codex", modelId: "gpt-5.6-sol" },
    };
    const selection = selectionForNextInteraction(settings, "codex-basic", interaction);
    expect(selection).toMatchObject({ familyId: 1, providerId: "codex" });
    const { root, picker } = mountPicker(settings, {
      mode: "ongoing",
      pinnedHarnessId: "codex-basic",
      selection,
      onRefreshModels: async () => {},
    });
    expect(root.querySelector("[data-model-picker-label]").textContent).toBe("Needs model setup");
    expect(picker.modelSetup()).toMatchObject({ familyId: 1, providerId: "codex" });
    picker.open();
    expect(root.querySelector("[data-model-picker-refresh]").getAttribute("aria-label"))
      .toBe("Refresh models for Codex");
    picker.dispose();
  });

  it("offers Open Settings instead of a refresh the host cannot run", () => {
    const onOpenSettings = vi.fn();
    const { root, picker } = mountPicker(recovering(), { onRefreshModels: null, onOpenSettings });
    picker.open();
    const panel = root.querySelector('[data-model-picker-panel="model"]');
    expect(panel.textContent).toContain("Needs model setup");
    expect(panel.querySelector("[data-model-picker-refresh]")).toBeNull();
    panel.querySelector("[data-model-picker-settings]").click();
    // The Settings defaults show the recovery and the other providers to choose from.
    expect(onOpenSettings).toHaveBeenCalledExactlyOnceWith("models");
    picker.dispose();
  });

  it("shows a disconnected provider's state, with Open Settings, and never another family", () => {
    const settings = disconnected();
    const modelSetup = defaultFamilyModelSetup(settings);
    expect(modelSetup).toMatchObject({
      familyId: 1,
      providerId: "codex",
      action: "settings",
      label: "Provider not connected",
      message: "Codex is not connected, so Codex defaults cannot run. The provider rejected the saved credentials.",
      actionLabel: "Open Settings",
      actionName: "Reconnect Codex in Settings",
    });
    expect(modelPickerFamilyPresentation(settings, "codex-basic", null).selectedFamily).toBeNull();
    expect(composerSendTitle({ ready: false, modelSetup, readyTitle: "Send" })).toBe(
      "Provider not connected. Reconnect Codex in Settings to send.",
    );

    const onOpenSettings = vi.fn();
    const onRefreshModels = vi.fn();
    const { root, picker } = mountPicker(settings, { onOpenSettings, onRefreshModels });
    expect(root.querySelector("[data-model-picker-label]").textContent).toBe("Provider not connected");
    picker.open();
    const panel = root.querySelector('[data-model-picker-panel="model"]');
    expect(panel.querySelector("[data-model-picker-refresh]")).toBeNull();
    const open = panel.querySelector("[data-model-picker-settings]");
    expect(open.getAttribute("aria-label")).toBe("Reconnect Codex in Settings");
    open.click();
    // A reconnect happens on the provider's card, under Providers.
    expect(onOpenSettings).toHaveBeenCalledExactlyOnceWith("providers");
    expect(onRefreshModels).not.toHaveBeenCalled();
    picker.dispose();

    expect(defaultFamilyRecoveryPresentation(settings)).toMatchObject({
      providerId: "codex",
      action: "providers",
      title: "Provider not connected",
      actionLabel: "Open Providers",
      actionName: "Reconnect Codex under Providers",
    });
    expect(defaultHarnessError(settings)).toBeNull();
  });

  it("announces the recovery once through a separate live region", () => {
    const { root, picker } = mountPicker(recovering(), { onRefreshModels: async () => {} });
    picker.open();
    const status = root.querySelector("[data-model-picker-status]");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).toBe(
      "Codex defaults needs model setup. Codex has no models eligible for agent execution.",
    );
    expect(status.querySelector("button")).toBeNull();
    expect(root.querySelector('[data-model-picker-panel="model"] [role="status"]')).toBeNull();
    picker.dispose();
  });

  it("marks a refresh in progress as busy and returns focus to the first restored model", async () => {
    const pending = deferred();
    let picker;
    const onRefreshModels = vi.fn(async () => {
      await pending.promise;
      picker.setContext({ settings: restored() });
    });
    const mounted = mountPicker(recovering(), { onRefreshModels });
    ({ picker } = mounted);
    const { root } = mounted;
    picker.open();
    const refresh = root.querySelector("[data-model-picker-refresh]");
    refresh.focus();
    refresh.click();
    await vi.waitFor(() => expect(onRefreshModels).toHaveBeenCalledWith("codex"));
    const busy = root.querySelector("[data-model-picker-refresh]");
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.getAttribute("aria-label")).toBe("Refreshing models for Codex");
    expect(busy.textContent).toBe("Refreshing…");
    expect(root.ownerDocument.activeElement).toBe(busy);

    pending.resolve();
    await vi.waitFor(() => expect(root.querySelector("[data-model-picker-refresh]")).toBeNull());
    expect(picker.isReady()).toBe(true);
    expect(root.ownerDocument.activeElement).toBe(root.querySelector("[data-model-family]"));
    picker.dispose();
  });

  it("leaves focus where the user moved it during a refresh", async () => {
    const pending = deferred();
    const { root, picker, document } = mountPicker(recovering(), {
      onRefreshModels: () => pending.promise,
    });
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    picker.open();
    const refresh = root.querySelector("[data-model-picker-refresh]");
    refresh.focus();
    refresh.click();
    elsewhere.focus();
    pending.resolve();
    await vi.waitFor(() => expect(
      root.querySelector("[data-model-picker-refresh]").getAttribute("aria-busy"),
    ).toBe("false"));
    expect(document.activeElement).toBe(elsewhere);
    picker.dispose();
  });

  it.each([false, true])("restores a thread's model roster after refresh (legacy=%s)", async (legacy) => {
    const compatibility = legacy
      ? { status: "compatible", providerId: "codex", harnessId: "codex-basic" }
      : { status: "unrestricted" };
    // The thread's last model is not in the restored roster. Exercise the actual refresh
    // callback and context update together so legacy filtering cannot bypass PROV-008.
    const selection = { harnessId: "codex-basic", familyId: 1, providerId: "codex", modelId: "gpt-5.6-terra" };
    const onRefreshModels = vi.fn(async () => {
      picker.setContext({ settings: { ...restored(), conversationCompatibility: compatibility } });
    });
    const { root, picker } = mountPicker({ ...recovering(), conversationCompatibility: compatibility }, {
      mode: "ongoing",
      pinnedHarnessId: "codex-basic",
      selection,
      onRefreshModels,
    });
    expect(picker.modelSetup()).toMatchObject({ familyId: 1, providerId: "codex" });
    expect(picker.isReady()).toBe(false);
    picker.open();
    const refresh = root.querySelector("[data-model-picker-refresh]");
    expect(refresh.getAttribute("aria-label")).toBe("Refresh models for Codex");
    refresh.click();
    await vi.waitFor(() => expect(onRefreshModels).toHaveBeenCalledExactlyOnceWith("codex"));
    expect(picker.isReady()).toBe(true);
    expect(picker.getSelection()).toEqual({
      harnessId: "codex-basic",
      familyId: 1,
      providerId: "codex",
      modelId: "gpt-5.6-sol",
    });
    if (legacy) {
      const notice = root.querySelector("[data-model-picker-error]");
      expect(notice.textContent).toBe("Only models from the original provider are available.");
      expect(notice.classList.contains("model-picker-warning")).toBe(true);
      expect(notice.getAttribute("role")).toBe("status");
    }
    picker.dispose();
  });

  it.each([
    { status: "compatible", providerId: "work", harnessId: "codex-basic" },
    { status: "compatible", providerId: "codex", harnessId: "prime-agent-basic" },
    { status: "blocked", message: "History ownership cannot be verified." },
  ])("does not offer family recovery outside the verified route: %j", (conversationCompatibility) => {
    const onRefreshModels = vi.fn();
    const { root, picker } = mountPicker({ ...recovering(), conversationCompatibility }, {
      mode: "ongoing",
      pinnedHarnessId: "codex-basic",
      selection: { harnessId: "codex-basic", familyId: 1, providerId: "codex", modelId: "gpt-5.6-terra" },
      onRefreshModels,
    });
    picker.open();
    expect(picker.modelSetup()).toBeNull();
    expect(picker.isReady()).toBe(false);
    expect(root.querySelector("[data-model-picker-refresh]")).toBeNull();
    expect(onRefreshModels).not.toHaveBeenCalled();
    picker.dispose();
  });

  it("refreshes thread state after a model refresh only when a thread is open", async () => {
    const calls = [];
    const handler = (currentThreadId) => createProviderModelsRefreshedHandler({
      currentThreadId: () => currentThreadId,
      refreshProviderSettings: async () => { calls.push("providers"); },
      refreshModelUi: async () => { calls.push("models"); },
      refreshThreadState: async (threadId) => { calls.push(`thread:${threadId}`); },
    });
    // From the New Thread composer, a thread refresh would select and open a saved thread.
    await handler(null)();
    expect(calls).toEqual(["providers", "models"]);
    calls.length = 0;
    await handler(7)();
    expect(calls).toEqual(["providers", "models", "thread:7"]);
  });

  it("keeps Eval from falling through to another family while the default recovers", () => {
    const settings = recovering();
    // Work defaults is healthy, but Eval resolves the default family, which is recovering.
    expect(firstAvailableSelection(settings, "codex-basic")).toBeNull();
    const error = defaultFamilyRecoveryError(settings);
    expect(error.code).toBe("provider_no_eligible_execution_models");
    expect(error.message).toBe(
      "The default model family is unavailable. Codex defaults needs model setup. Codex has no models eligible for agent execution.",
    );
    const offline = defaultFamilyRecoveryError(disconnected());
    expect(offline.code).toBe("provider_unavailable");
    expect(defaultFamilyRecoveryError(restored())).toBeNull();
    expect(firstAvailableSelection(restored(), "codex-basic")).toMatchObject({ familyId: 1 });
  });

  it("gives Claude Eval the recovery code when the default selection is refused", async () => {
    // /api/model-selection/default returns null while the default family is tombstoned.
    const resolve = createLiveModelRouteResolver({
      readModelSettings: async () => recovering(),
      readDefaultModelSelection: async () => null,
    });
    await expect(resolve({ implementation: "claude.basic", name: "claude-basic" }))
      .rejects.toMatchObject({ code: "provider_no_eligible_execution_models" });

    expect(() => requireDefaultModelSelection(null, recovering(), "no model"))
      .toThrow(expect.objectContaining({ code: "provider_no_eligible_execution_models" }));
    expect(() => requireDefaultModelSelection(null, restored(), "no model")).toThrow("no model");
    const selection = { harnessId: "claude-basic", familyId: 1, providerId: "codex", modelId: "gpt-5.6-sol" };
    expect(requireDefaultModelSelection(selection, recovering(), "no model")).toBe(selection);
  });

  it("says why Send is blocked", () => {
    const modelSetup = defaultFamilyModelSetup(recovering());
    expect(composerSendTitle({ ready: false, modelSetup, readyTitle: "Send" })).toBe(
      "Needs model setup. Refresh models for Codex to send.",
    );
    expect(composerSendTitle({ ready: true, modelSetup: null, readyTitle: "Send" })).toBe("Send");
    expect(composerSendTitle({ ready: false, modelSetup: null, readyTitle: "Send" })).toBe(
      "Choose an available model in Settings before sending",
    );
  });

  it("shows the recovery in the Settings default section instead of a harness error", () => {
    const settings = recovering();
    expect(defaultFamilyRecoveryPresentation(settings)).toEqual({
      providerId: "codex",
      action: "refresh",
      title: "Needs model setup",
      message: "Codex defaults needs model setup. Codex has no models eligible for agent execution.",
      actionLabel: "Refresh models",
      actionName: "Refresh models for Codex",
      busyName: "Refreshing models for Codex",
    });
    expect(defaultHarnessError(settings)).toBeNull();
    // With the default provider as the only provider, the harness has no usable route either.
    const onlyProvider = {
      ...settings,
      providers: settings.providers.filter((provider) => provider.id === "codex"),
      families: [],
      harnesses: settings.harnesses.map((harness) => ({ ...harness, usableNow: false, usableFamilyIds: [] })),
    };
    expect(defaultFamilyRecoveryPresentation(onlyProvider)?.providerId).toBe("codex");
    expect(defaultHarnessError(onlyProvider)).toBeNull();

    const withoutRecovery = { ...settings, defaultFamilyRecovery: null, familiesNeedingModelSetup: [] };
    expect(defaultFamilyRecoveryPresentation(withoutRecovery)).toBeNull();
    expect(defaultHarnessError(withoutRecovery)).toBe(
      "No eligible model in the default family can use this harness.",
    );
  });

  it("counts every typed family rejection as one that refreshes model settings", () => {
    for (const code of [
      "model_family_removed",
      "model_family_unresolvable",
      "provider_no_eligible_execution_models",
    ]) {
      expect(isModelSelectionCatalogError({ code })).toBe(true);
    }
  });

  it("wires every Refresh models action to the existing provider refresh", async () => {
    const [html, settingsSource, composer, workspace, graph, main, threads, refresh] = await Promise.all([
      source("index.html"),
      source("src/model-family-settings.js"),
      source("src/composer-model-picker.js"),
      source("src/product-workspace/workspace.js"),
      source("src/graph.js"),
      source("src/main.js"),
      source("src/threads.js"),
      source("src/provider-models-refresh.js"),
    ]);
    expect(refresh).toContain("await desktop.models.refresh(providerId);");
    expect(html).toContain('id="defaultFamilyRecovery"');
    expect(html).toContain('id="refreshDefaultFamilyModels"');
    expect(settingsSource).toContain("defaultFamilyRecoveryPresentation(settings)");
    expect(refresh).toContain("return desktop?.models?.refresh ? refreshProviderModels : null;");
    expect(composer).toContain("onRefreshModels: providerModelsRefreshAction(),");
    expect(graph).toContain("onRefreshModels: providerModelsRefreshAction(),");
    expect(threads).toContain("if (!isModelSelectionCatalogError(error)) return;");
    expect(workspace).toContain("send.title = composerSendTitle({");
    expect(threads).toContain('$("#createThread").title = composerSendTitle({');
    expect(main).toContain("setProviderModelsRefreshedHandler(createProviderModelsRefreshedHandler({");
    expect(main).toContain("currentThreadId: () => viewState.currentThreadId,");
    const [evalService, liveCredentials] = await Promise.all([
      readFile(new URL("../desktop/eval-main/eval-service.mjs", import.meta.url), "utf8"),
      readFile(new URL("../desktop/eval-main/live-credentials.mjs", import.meta.url), "utf8"),
    ]);
    for (const evalSource of [evalService, liveCredentials]) {
      expect(evalSource).toContain("defaultFamilyRecoveryError(");
      expect(evalSource).toContain("requireDefaultModelSelection(");
    }
    // Picker "Open Settings" opens the tab the recovery needs.
    for (const opener of [graph, main]) {
      expect(opener).toContain('onOpenSettings: (tab = "models") => {');
      expect(opener).toContain("setSettingsTab(tab);");
    }
  });
});

// A behavioural test of the Settings default section, on the real renderer markup and module.
describe("Settings default section recovery (PROV-008)", () => {
  async function mountSettings({ responses, refresh }) {
    vi.resetModules();
    const window = new Window({ url: "http://127.0.0.1/" });
    const html = await source("index.html");
    window.document.write(html.replace(/<script[\s\S]*?<\/script>/g, ""));
    window.relayerDesktop = refresh ? { models: { refresh } } : {};
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", window.document);
    vi.stubGlobal("location", window.location);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    let response = 0;
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => responses[Math.min(response++, responses.length - 1)],
    })));
    const settings = await import("../desktop/renderer/src/model-family-settings.js");
    const refreshModule = await import("../desktop/renderer/src/provider-models-refresh.js");
    refreshModule.setProviderModelsRefreshedHandler(() => settings.refreshModelFamilySettings());
    await settings.initializeModelFamilySettings();
    return window.document;
  }

  it("refreshes the exact provider, marks the action busy, and moves focus once restored", async () => {
    const pending = deferred();
    const refresh = vi.fn(() => pending.promise);
    const document = await mountSettings({ responses: [recovering(), restored()], refresh });
    const row = document.querySelector("#defaultFamilyRecovery");
    const button = document.querySelector("#refreshDefaultFamilyModels");
    expect(row.classList.contains("hidden")).toBe(false);
    expect(row.getAttribute("role")).toBeNull();
    expect(document.querySelector("#defaultFamilyRecoveryMessage").getAttribute("role")).toBe("status");
    expect(button.getAttribute("aria-label")).toBe("Refresh models for Codex");

    button.focus();
    button.click();
    expect(refresh).toHaveBeenCalledWith("codex");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("Refreshing models for Codex");
    button.click();
    expect(refresh).toHaveBeenCalledOnce();

    pending.resolve();
    await vi.waitFor(() => expect(row.classList.contains("hidden")).toBe(true));
    await vi.waitFor(() => expect(document.activeElement).toBe(document.querySelector("#defaultProviderSelect")));
  });

  it("points to the default provider choice when the host cannot refresh", async () => {
    const document = await mountSettings({ responses: [recovering()], refresh: null });
    expect(document.querySelector("#refreshDefaultFamilyModels").classList.contains("hidden")).toBe(true);
    expect(document.querySelector("#defaultFamilyRecoveryHint").textContent).toBe(
      "Choose another default provider above to send meanwhile.",
    );
  });

  it("sends a disconnected provider to Providers instead of refreshing", async () => {
    const refresh = vi.fn();
    const document = await mountSettings({ responses: [disconnected()], refresh });
    const providersTab = document.querySelector('[data-settings-tab="providers"]');
    const opened = vi.fn();
    providersTab.addEventListener("click", opened);
    const button = document.querySelector("#refreshDefaultFamilyModels");
    expect(button.textContent).toBe("Open Providers");
    expect(button.getAttribute("aria-label")).toBe("Reconnect Codex under Providers");
    button.focus();
    button.click();
    expect(opened).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
    // Focus leaves the Models tab with the user, instead of staying on a hidden button.
    expect(document.activeElement).toBe(providersTab);
  });
});

// Committing a family closes the picker and restores focus in both composers.
describe("family selection dismissal", () => {
  it.each([
    ["new", true], ["new", false], ["ongoing", true], ["ongoing", false],
  ])("closes the %s picker when already-selected=%s", (mode, alreadySelected) => {
    const settings = restored();
    settings.families.push({ ...structuredClone(settings.families[0]), id: 3, name: "Another family", position: 2 });
    const { root, picker, document } = mountPicker(settings, { mode, pinnedHarnessId: settings.defaults.harnessId });
    root.querySelector("[data-model-picker-trigger]").click();
    const select = root.querySelector("[data-model-family]");
    expect(root.querySelector("[data-model-option]")).toBeNull();
    select.value = alreadySelected ? "1" : "3";
    select.dispatchEvent(new document.defaultView.Event("change"));
    expect(picker.getSelection().familyId).toBe(alreadySelected ? 1 : 3);
    expect(root.querySelector("[data-model-picker-popover]").classList.contains("hidden")).toBe(true);
    expect(document.activeElement).toBe(root.querySelector("[data-model-picker-trigger]"));
    picker.dispose();
  });
});
