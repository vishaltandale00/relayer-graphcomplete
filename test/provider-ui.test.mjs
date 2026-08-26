import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import {
  bindRovingRadioGroup,
  harnessConfigurationsMarkup,
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
  it("keeps incompatible first-run providers connected while offering a recovery path", async () => {
    const [html, auth] = await Promise.all([
      readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/src/auth.js", import.meta.url), "utf8"),
    ]);
    expect(html).toContain('id="providerFamilyBack">← Connect another provider</button>');
    expect(auth).toContain('$("#providerFamilyBack").onclick');
    expect(auth).toContain("loadProviderOnboardingProjection");
    expect(auth).toContain('data-onboarding-harness=');
    expect(auth).toContain("Relayer will not choose a model for you.");
    expect(auth).toContain("const harnessTabStopId = onboardingHarness ?? onboardingProjection.harnesses[0]?.id");
    expect(auth).toContain("const modelTabStopId = onboardingModel ?? models[0]?.id");
    expect(auth).toContain('data-onboarding-model="${CSS.escape(onboardingModel)}"');
    expect(auth).toContain('$("#finishProviderSetup").disabled = Boolean(busy) || !onboardingModel');
    expect(auth).not.toContain("onboardingModel = models[0]?.id");
  });

  it("renders branded marks for every packaged provider adapter and a generic future fallback", () => {
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
});
