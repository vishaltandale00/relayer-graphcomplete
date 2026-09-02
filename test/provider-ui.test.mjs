import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import {
  bindRovingRadioGroup,
  harnessConfigurationsMarkup,
  onboardingFamilyOptionsMarkup,
  onboardingHarnessOptionsMarkup,
  providerConnectionFormMarkup,
  providerDefinitionsMarkup,
  providerLogoMarkup,
  providerOptionsMarkup,
  rovingRadioIndex,
} from "../desktop/renderer/src/provider-ui.js";
import { normalizeProviderDescriptor } from "../desktop/renderer/src/provider-ui-model.js";

const openAi = normalizeProviderDescriptor({
  adapterId: "openai-api",
  label: "OpenAI API",
  defaultEndpoint: "https://api.openai.com/v1",
  endpointEditableDuringCreation: true,
  connection: { mode: "secret-fields", fields: [{ id: "apiKey", label: "API key", kind: "secret", required: true }] },
});

describe("provider and harness renderer markup", () => {
  it("renders branded provider options and typed connection forms", () => {
    const logos = [
      ["claude-subscription", "claude"],
      ["codex-subscription", "codex"],
      ["anthropic-api", "anthropic"],
      ["openai-api", "openai"],
      ["openrouter", "openrouter"],
      ["vercel-ai-router", "vercel"],
      ["future-provider", "generic"],
    ];
    expect(logos, "branded logo inventory").toHaveLength(7);
    for (const [adapterId, logo] of logos) {
      expect.soft(providerLogoMarkup(adapterId), `${adapterId} renders the ${logo} mark`)
        .toContain(`data-provider-logo="${logo}"`);
    }

    const options = providerOptionsMarkup([openAi, {
      adapterId: "fake-test",
      label: "Fake deterministic provider",
      connection: { mode: "existing-runtime-auth", fields: [] },
    }]);
    expect(options, "a fake registry adapter renders through the generic onboarding option")
      .toContain('data-provider-adapter="fake-test"');
    expect(options, "fake adapter labels stay visible").toContain("Fake deterministic provider");
    expect(options, "known adapters keep their branded logo").toContain('data-provider-logo="openai"');
    expect(options, "unknown adapters fall back to the generic logo").toContain('data-provider-logo="generic"');
    expect(options, "provider options never leak switch controls").not.toContain("switch");

    expect(options, "providers render as an accessible radiogroup")
      .toContain('role="radiogroup" aria-label="Providers"');
    expect(options.match(/<button type="button" class="provider-option" role="radio"/g),
      "every provider choice is a native keyboard-reachable radio").toHaveLength(2);
    expect(options.match(/tabindex="0"/g), "exactly one radio is the tab stop").toHaveLength(1);
    expect(options.match(/tabindex="-1"/g), "the other radio stays out of tab order").toHaveLength(1);
    expect(options, "no inline click handlers").not.toContain("onclick=");

    const form = providerConnectionFormMarkup(openAi, {
      label: "OpenAI Work",
      endpoint: "not a url",
      fields: { apiKey: "" },
    }, [], true);
    expect(form, "typed secrets render as password fields").toContain('type="password"');
    expect(form, "the connection name field stays visible").toContain("Connection name");
    expect(form, "validation errors announce via alert role").toContain('role="alert"');
    expect(form, "invalid endpoints are explained").toContain("Enter a valid endpoint URL.");
    expect(form, "the endpoint field points at its error").toContain('aria-invalid="true" aria-describedby="endpointError"');
    expect(form, "the endpoint error owns the alert").toContain('id="endpointError" role="alert"');
    expect(form, "an empty secret does not pre-render a broken field")
      .not.toContain('type="text" value="" required  aria-invalid="true" aria-describedby="apiKeyError"');
  });

  it("walks the roving radio keyboard contract", () => {
    const moves = [
      ["ArrowRight advances", "ArrowRight", 1, 2],
      ["ArrowDown wraps forward", "ArrowDown", 2, 0],
      ["ArrowLeft wraps backward", "ArrowLeft", 0, 2],
      ["ArrowUp moves back", "ArrowUp", 2, 1],
      ["Home jumps to the first", "Home", 2, 0],
      ["End jumps to the last", "End", 0, 2],
      ["other keys do nothing", "Enter", 0, null],
    ];
    expect(moves, "roving radio navigation inventory").toHaveLength(7);
    for (const [label, key, current, expected] of moves) {
      expect.soft(rovingRadioIndex(key, current, 3), label).toBe(expected);
    }

    const radios = [0, 1, 2].map((index) => ({
      attributes: new Map([["aria-checked", String(index === 0)]]),
      tabIndex: index === 0 ? 0 : -1,
      focusCount: 0,
      closest() { return this; },
      focus() { this.focusCount += 1; },
      setAttribute(name, value) { this.attributes.set(name, value); },
      getAttribute(name) { return this.attributes.get(name); },
    }));
    const group = { querySelectorAll: () => radios, onkeydown: null };
    const moved = [];
    bindRovingRadioGroup(group, { onMove: (radio) => moved.push(radios.indexOf(radio)) });
    let prevented = false;
    group.onkeydown({ key: "End", target: radios[0], preventDefault: () => { prevented = true; } });
    expect(prevented, "navigation prevents default scrolling").toBe(true);
    expect(radios.map(({ tabIndex }) => tabIndex), "the single tab stop moves").toEqual([-1, -1, 0]);
    expect(radios.map((radio) => radio.getAttribute("aria-checked")), "the checked state moves")
      .toEqual(["false", "false", "true"]);
    expect(radios[2].focusCount, "focus follows the tab stop").toBe(1);
    expect(moved, "move callbacks see the destination radio").toEqual([2]);

    const radio = {
      tabIndex: 0,
      click: vi.fn(),
      focus: vi.fn(),
      closest() { return this; },
    };
    const activationGroup = { querySelectorAll: () => [radio], onkeydown: null };
    bindRovingRadioGroup(activationGroup);
    const space = { key: " ", target: radio, preventDefault: vi.fn() };
    activationGroup.onkeydown(space);
    expect(space.preventDefault, "Space activation prevents default scrolling").toHaveBeenCalledOnce();
    expect(radio.click, "Space activates the focused radio").toHaveBeenCalledOnce();
    expect(radio.focus, "Space preserves focus").toHaveBeenCalledOnce();
    const enter = { key: "Enter", target: radio, preventDefault: vi.fn() };
    activationGroup.onkeydown(enter);
    expect(radio.click, "Enter activates the focused radio").toHaveBeenCalledTimes(2);
    expect(radio.focus, "Enter preserves focus").toHaveBeenCalledTimes(2);
  });

  it("renders onboarding projections without silent selection", async () => {
    const source = await readFile(new URL("../desktop/renderer/src/auth.js", import.meta.url), "utf8");
    const committed = source.indexOf('if (result.status !== "connected") return;');
    const disableCancel = source.indexOf("setConnectionCancellationAvailable(false);", committed);
    const refreshStatus = source.indexOf("providerStatus = await desktop.providers.status();", committed);
    const prepareDefaults = source.indexOf("await prepareFamilyStep(connectedDefinition);", committed);
    expect(committed, "the provider commit gate exists").toBeGreaterThan(-1);
    expect(disableCancel, "Cancel is disabled once the commit precedes deferred default setup").toBeGreaterThan(committed);
    expect(disableCancel, "Cancel is disabled before the status refresh").toBeLessThan(refreshStatus);
    expect(disableCancel, "Cancel is disabled before default preparation").toBeLessThan(prepareDefaults);

    const projection = {
      appDefaultHarnessId: "codex-basic",
      harnesses: [
        { id: "codex-basic", label: "Codex", selectable: false, incompatibilityReason: { code: "access_contract_mismatch", message: "Requires managed access." } },
        { id: "universal", label: "Universal", selectable: true, selectedInitially: false, matchingAccessContract: "secret@1" },
      ],
    };
    const withoutSelection = onboardingHarnessOptionsMarkup(projection, null);
    expect(withoutSelection, "the incompatible app default stays visible but disabled")
      .toContain('data-onboarding-harness="codex-basic" disabled');
    expect(withoutSelection, "the incompatibility reason is shown").toContain("Requires managed access.");
    expect(withoutSelection, "no harness is silently checked").not.toContain('aria-checked="true"');
    const explicitlySelected = onboardingHarnessOptionsMarkup(projection, "universal");
    expect(explicitlySelected, "only an authoritative compatible choice is selected")
      .toContain('aria-checked="true" tabindex="0" data-onboarding-harness="universal"');

    const harness = {
      label: "Universal",
      existingCustomFamilies: [{ id: 12, name: "Work", members: [{ providerId: "work", modelId: "large" }] }],
      existingManagedFamilies: [],
      managedFamilyCandidate: { name: "Provider defaults", members: [{ providerId: "work", modelId: "large" }] },
      eligibleModels: [
        { providerId: "work", modelId: "large", label: "Large" },
        { providerId: "work", modelId: "small", label: "Small" },
      ],
    };
    const unselected = onboardingFamilyOptionsMarkup(harness, {});
    expect(unselected, "existing families render as their own kind").toContain('data-onboarding-family-kind="existing"');
    expect(unselected, "managed candidates render as their own kind").toContain('data-onboarding-family-kind="managed"');
    expect(unselected, "create renders as its own kind").toContain('data-onboarding-family-kind="create"');
    expect(unselected, "existing families are grouped visibly").toContain("Existing custom families");
    expect(unselected, "managed candidates are labelled visibly").toContain("Managed family candidate");
    expect(unselected, "radios never masquerade as checkboxes").not.toContain('type="checkbox"');
    const creating = onboardingFamilyOptionsMarkup(harness, { kind: "create", name: "Work choices", members: [] });
    expect(creating.match(/type="checkbox"/g), "create offers every eligible model").toHaveLength(2);
    expect(creating, "create never silently checks a model").not.toContain("checked />");
  });

  it("renders definition status actions and usable harness configurations only", () => {
    const duplicates = providerDefinitionsMarkup([
      { id: "work", adapterId: "openai-api", adapterLabel: "OpenAI API", label: "OpenAI Work", endpoint: "https://api.openai.com/v1", accessContract: "secret@1", lifecycleState: "active" },
      { id: "personal", adapterId: "openai-api", adapterLabel: "OpenAI API", label: "OpenAI Personal", endpoint: "https://api.openai.com/v1", accessContract: "secret@1", lifecycleState: "active" },
    ], { providerId: "work" });
    expect(duplicates, "duplicate model paths stay distinguishable by work label").toContain("OpenAI Work");
    expect(duplicates, "duplicate model paths stay distinguishable by personal label").toContain("OpenAI Personal");
    expect(duplicates, "the default provider cannot be removed outright")
      .toContain("Change the default provider before removing");
    expect(duplicates, "default removal is disabled").toContain('data-provider-remove="work" disabled');

    const managed = providerDefinitionsMarkup([
      { id: "claude-work", adapterId: "claude-subscription", label: "Claude Work", lifecycleState: "active" },
      { id: "openai-work", adapterId: "openai-api", label: "OpenAI Work", lifecycleState: "active" },
    ], {}, [
      { adapterId: "claude-subscription", connection: { mode: "managed-login" } },
      { adapterId: "openai-api", connection: { mode: "secret-fields" } },
    ]);
    expect(managed, "managed subscriptions offer exact-definition sign out").toContain('data-provider-logout="claude-work"');
    expect(managed, "secret adapters never offer sign out").not.toContain('data-provider-logout="openai-work"');

    const signedOut = providerDefinitionsMarkup([{
      id: "claude-work", adapterId: "claude-subscription", label: "Claude Work",
      lifecycleState: "active", connected: false,
      unavailableReason: { code: "provider_logged_out", message: "The provider is signed out." },
    }], {}, [{ adapterId: "claude-subscription", connection: { mode: "managed-login" } }]);
    expect(signedOut, "an unavailable managed definition offers reconnect").toContain('data-provider-reconnect="claude-work"');
    expect(signedOut, "a signed-out definition never offers sign out again").not.toContain('data-provider-logout="claude-work"');

    const needsModels = providerDefinitionsMarkup([{
      id: "openai-work", adapterId: "openai-api", label: "OpenAI Work",
      lifecycleState: "active", connected: true,
      unavailableReason: {
        code: "provider_no_eligible_execution_models",
        message: "No supported text models are available. Refresh models or update this provider.",
      },
    }], {}, [{ adapterId: "openai-api", connection: { mode: "secret-fields" } }]);
    expect(needsModels, "zero-eligible providers are flagged for model setup").toContain("Needs model setup");
    expect(needsModels, "the model gap message is shown").toContain("No supported text models are available.");
    expect(needsModels, "model recovery is provider-scoped").toContain('data-provider-family-recovery="openai-work"');
    expect(needsModels, "model refresh is offered").toContain("Refresh models");
    expect(needsModels, "connected providers do not offer reconnect").not.toContain('data-provider-reconnect="openai-work"');

    const needsExecution = providerDefinitionsMarkup([{
      id: "openai-work", adapterId: "openai-api", label: "OpenAI Work",
      lifecycleState: "active", connected: true,
      unavailableReason: {
        code: "provider_no_available_execution_configurations",
        message: "This provider currently has no available execution configurations.",
      },
    }], {}, [{ adapterId: "openai-api", connection: { mode: "secret-fields" } }]);
    expect(needsExecution, "no-ready-route providers are flagged for execution setup").toContain("Needs execution setup");
    expect(needsExecution, "execution repair is offered").toContain("Repair execution configurations");
    expect(needsExecution, "repair never names a failed harness").not.toContain("codex-basic");
    expect(needsExecution, "repair never names other harnesses").not.toContain("prime-agent");

    const harnesses = harnessConfigurationsMarkup({
      defaults: { harnessId: "codex-basic" },
      providers: [{
        id: "codex-work",
        adapterId: "codex-subscription",
        label: "Codex subscription",
        connected: true,
        models: [{ id: "gpt-5.6", label: "GPT-5.6", visible: true, available: true }],
      }],
      families: [{
        id: 1,
        name: "Codex models",
        enabled: true,
        members: [{ providerId: "codex-work", modelId: "gpt-5.6", position: 0 }],
      }],
      harnesses: [{
        id: "codex-basic",
        label: "Codex Basic",
        available: true,
        configurationRevision: 3,
        executionAccessContracts: ["managed-runtime@1"],
        modelRules: {
          allow: [{ adapterId: "codex-subscription", modelIdRegex: ".*" }],
          deny: [],
        },
        usableNow: true,
        usableProviderIds: ["codex-work"],
        usableFamilyIds: [1],
      }, {
        id: "claude-basic",
        label: "Claude Basic",
        available: true,
        configurationRevision: 1,
        executionAccessContracts: ["managed-runtime@1"],
        modelRules: {
          allow: [{ adapterId: "claude-subscription", modelIdExact: "sonnet" }],
          deny: [],
        },
        usableNow: false,
        usableProviderIds: [],
        usableFamilyIds: [],
      }],
    });
    expect(harnesses, "usable harnesses render").toContain('data-harness-configuration="codex-basic"');
    expect(harnesses, "unusable harnesses stay hidden").not.toContain('data-harness-configuration="claude-basic"');
    expect(harnesses, "provider labels stay out of the harness summary").not.toContain("Codex subscription");
    expect(harnesses, "family names stay out of the harness summary").not.toContain("Codex models");
    expect(harnesses, "the default harness is labelled").toContain("Default harness");
    for (const [label, leaked] of [
      ["advanced configuration stays hidden", "Advanced configuration"],
      ["other-harness configuration stays hidden", "Configure other harnesses"],
      ["rule editors stay hidden", "data-harness-rules-edit"],
      ["no action buttons leak", "<button"],
      ["availability chips stay hidden", "Available"],
      ["execution access details stay hidden", "Execution access"],
      ["revision numbers stay hidden", "Revision"],
      ["access contract strings stay hidden", "managed-runtime@1"],
      ["adapter ids stay hidden", "codex-subscription"],
      ["model rule regexes stay hidden", "model regex"],
      ["raw regex bodies stay hidden", ".*"],
    ]) {
      expect.soft(harnesses, label).not.toContain(leaked);
    }

    const empty = harnessConfigurationsMarkup({
      defaults: { harnessId: "claude-basic" },
      providers: [],
      families: [],
      harnesses: [{ id: "claude-basic", label: "Claude Basic", available: true }],
    });
    expect(empty, "the empty state explains itself").toContain("No harnesses are usable right now");
    expect(empty, "the empty state offers the one next step").toContain("Connect a provider");
    expect(empty.match(/family-empty/g), "exactly one empty state renders").toHaveLength(1);
    expect(empty, "the empty state has no action buttons").not.toContain("<button");
    expect(empty, "the empty state hides advanced configuration").not.toContain("Advanced configuration");
    expect(empty, "the empty state hides harness names").not.toContain("Claude Basic");
    expect(empty, "the empty state hides availability chips").not.toContain("Available");
    expect(empty, "the empty state hides execution access details").not.toContain("Execution access");
  });
});
