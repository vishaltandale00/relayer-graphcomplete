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
  it("renders branded marks for packaged adapters and a generic fallback", () => {
    expect(providerLogoMarkup("claude-subscription")).toContain('data-provider-logo="claude"');
    expect(providerLogoMarkup("codex-subscription")).toContain('data-provider-logo="codex"');
    expect(providerLogoMarkup("anthropic-api")).toContain('data-provider-logo="anthropic"');
    expect(providerLogoMarkup("openai-api")).toContain('data-provider-logo="openai"');
    expect(providerLogoMarkup("openrouter")).toContain('data-provider-logo="openrouter"');
    expect(providerLogoMarkup("vercel-ai-router")).toContain('data-provider-logo="vercel"');
    expect(providerLogoMarkup("future-provider")).toContain('data-provider-logo="generic"');
  });

  it("renders a fake registry adapter through the generic onboarding option", () => {
    const markup = providerOptionsMarkup([openAi, {
      adapterId: "fake-test",
      label: "Fake deterministic provider",
      connection: { mode: "existing-runtime-auth", fields: [] },
    }]);
    expect(markup).toContain('data-provider-adapter="fake-test"');
    expect(markup).toContain("Fake deterministic provider");
    expect(markup).toContain('data-provider-logo="openai"');
    expect(markup).toContain('data-provider-logo="generic"');
    expect(markup).not.toContain("switch");
  });

  it("renders typed secrets as password fields and announces validation errors", () => {
    const markup = providerConnectionFormMarkup(openAi, {
      label: "OpenAI Work",
      endpoint: "not a url",
      fields: { apiKey: "" },
    }, [], true);
    expect(markup).toContain('type="password"');
    expect(markup).toContain("Connection name");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Enter a valid endpoint URL.");
    expect(markup).toContain('aria-invalid="true" aria-describedby="endpointError"');
    expect(markup).toContain('id="endpointError" role="alert"');
    expect(markup).not.toContain('type="text" value="" required  aria-invalid="true" aria-describedby="apiKeyError"');
  });

  it("uses native keyboard-reachable controls for every provider choice", () => {
    const markup = providerOptionsMarkup([openAi, {
      adapterId: "claude-subscription",
      label: "Claude subscription",
      connection: { mode: "managed-login", fields: [] },
    }]);
    expect(markup).toContain('role="radiogroup" aria-label="Providers"');
    expect(markup.match(/<button type="button" class="provider-option" role="radio"/g)).toHaveLength(2);
    expect(markup.match(/tabindex="0"/g)).toHaveLength(1);
    expect(markup.match(/tabindex="-1"/g)).toHaveLength(1);
    expect(markup).not.toContain("onclick=");
  });

  it("supports standard wrapping Arrow and absolute Home/End radio navigation", () => {
    expect(rovingRadioIndex("ArrowRight", 1, 3)).toBe(2);
    expect(rovingRadioIndex("ArrowDown", 2, 3)).toBe(0);
    expect(rovingRadioIndex("ArrowLeft", 0, 3)).toBe(2);
    expect(rovingRadioIndex("ArrowUp", 2, 3)).toBe(1);
    expect(rovingRadioIndex("Home", 2, 3)).toBe(0);
    expect(rovingRadioIndex("End", 0, 3)).toBe(2);
    expect(rovingRadioIndex("Enter", 0, 3)).toBeNull();
  });

  it("moves the single tab stop, checked state, and focus together", () => {
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
    expect(prevented).toBe(true);
    expect(radios.map(({ tabIndex }) => tabIndex)).toEqual([-1, -1, 0]);
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
    expect(radios[2].focusCount).toBe(1);
    expect(moved).toEqual([2]);
  });

  it("activates a focused radio with Space or Enter while preserving focus", () => {
    const radio = {
      tabIndex: 0,
      click: vi.fn(),
      focus: vi.fn(),
      closest() { return this; },
    };
    const group = { querySelectorAll: () => [radio], onkeydown: null };
    bindRovingRadioGroup(group);
    const space = { key: " ", target: radio, preventDefault: vi.fn() };
    group.onkeydown(space);
    expect(space.preventDefault).toHaveBeenCalledOnce();
    expect(radio.click).toHaveBeenCalledOnce();
    expect(radio.focus).toHaveBeenCalledOnce();
    const enter = { key: "Enter", target: radio, preventDefault: vi.fn() };
    group.onkeydown(enter);
    expect(radio.click).toHaveBeenCalledTimes(2);
    expect(radio.focus).toHaveBeenCalledTimes(2);
  });

  it("shows the incompatible app default but selects only an authoritative compatible initial harness", () => {
    const projection = {
      appDefaultHarnessId: "codex-basic",
      harnesses: [
        { id: "codex-basic", label: "Codex", selectable: false, incompatibilityReason: { code: "access_contract_mismatch", message: "Requires managed access." } },
        { id: "universal", label: "Universal", selectable: true, selectedInitially: false, matchingAccessContract: "secret@1" },
      ],
    };
    const withoutSelection = onboardingHarnessOptionsMarkup(projection, null);
    expect(withoutSelection).toContain('data-onboarding-harness="codex-basic" disabled');
    expect(withoutSelection).toContain("Requires managed access.");
    expect(withoutSelection).not.toContain('aria-checked="true"');
    const explicitlySelected = onboardingHarnessOptionsMarkup(projection, "universal");
    expect(explicitlySelected).toContain('aria-checked="true" tabindex="0" data-onboarding-harness="universal"');
  });

  it("separates existing, managed, and custom family choices without silently checking a model", () => {
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
    expect(unselected).toContain('data-onboarding-family-kind="existing"');
    expect(unselected).toContain('data-onboarding-family-kind="managed"');
    expect(unselected).toContain('data-onboarding-family-kind="create"');
    expect(unselected).toContain("Existing custom families");
    expect(unselected).toContain("Managed family candidate");
    expect(unselected).not.toContain('type="checkbox"');
    const creating = onboardingFamilyOptionsMarkup(harness, { kind: "create", name: "Work choices", members: [] });
    expect(creating.match(/type="checkbox"/g)).toHaveLength(2);
    expect(creating).not.toContain("checked />");
  });

  it("keeps duplicate model access paths distinguishable by provider definition labels", () => {
    const markup = providerDefinitionsMarkup([
      { id: "work", adapterId: "openai-api", adapterLabel: "OpenAI API", label: "OpenAI Work", endpoint: "https://api.openai.com/v1", accessContract: "secret@1", lifecycleState: "active" },
      { id: "personal", adapterId: "openai-api", adapterLabel: "OpenAI API", label: "OpenAI Personal", endpoint: "https://api.openai.com/v1", accessContract: "secret@1", lifecycleState: "active" },
    ], { providerId: "work" });
    expect(markup).toContain("OpenAI Work");
    expect(markup).toContain("OpenAI Personal");
    expect(markup).toContain("Change the default provider before removing");
    expect(markup).toContain('data-provider-remove="work" disabled');
  });

  it("offers exact-definition sign out only for managed subscriptions", () => {
    const markup = providerDefinitionsMarkup([
      { id: "claude-work", adapterId: "claude-subscription", label: "Claude Work", lifecycleState: "active" },
      { id: "openai-work", adapterId: "openai-api", label: "OpenAI Work", lifecycleState: "active" },
    ], {}, [
      { adapterId: "claude-subscription", connection: { mode: "managed-login" } },
      { adapterId: "openai-api", connection: { mode: "secret-fields" } },
    ]);
    expect(markup).toContain('data-provider-logout="claude-work"');
    expect(markup).not.toContain('data-provider-logout="openai-work"');
  });

  it("offers reconnect instead of sign out for an unavailable managed definition", () => {
    const markup = providerDefinitionsMarkup([{
      id: "claude-work", adapterId: "claude-subscription", label: "Claude Work",
      lifecycleState: "active", connected: false,
      unavailableReason: { code: "provider_logged_out", message: "The provider is signed out." },
    }], {}, [{ adapterId: "claude-subscription", connection: { mode: "managed-login" } }]);
    expect(markup).toContain('data-provider-reconnect="claude-work"');
    expect(markup).not.toContain('data-provider-logout="claude-work"');
  });

  it("presents harness rules separately with exact and regex matchers", () => {
    const markup = harnessConfigurationsMarkup([{
      id: "coding-default",
      label: "Coding default",
      revision: 3,
      executionAccessContracts: ["secret@1", "managed-runtime@1"],
      modelRules: {
        allow: [{ adapterId: "openai-api", modelIdExact: "gpt-5.2" }],
        deny: [{ adapterId: "anthropic-api", modelIdRegex: "-haiku-" }],
      },
    }]);
    expect(markup).toContain("secret@1, managed-runtime@1");
    expect(markup).toContain("openai-api · is gpt-5.2");
    expect(markup).toContain("anthropic-api · matches -haiku-");
    expect(markup).not.toContain("API key");
  });

  it("shows an actionable unavailable runtime in Settings without enabling edits", () => {
    const markup = harnessConfigurationsMarkup([{
      id: "prime-agent-basic",
      label: "Prime Agent Basic",
      available: false,
      unavailableReason: {
        code: "prime_agent_boundary_unsupported",
        message: "Prime Agent Ask and Auto require macOS. Choose another available harness on this device.",
      },
      executionAccessContracts: ["secret@1"],
    }]);
    expect(markup).toContain("Unavailable");
    expect(markup).toContain("Choose another available harness on this device.");
    expect(markup).toContain('data-harness-rules-edit="prime-agent-basic" disabled');
  });
});
