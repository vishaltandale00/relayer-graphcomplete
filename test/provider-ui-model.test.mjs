import { describe, expect, it } from "vitest";

import {
  firstRunGateState,
  normalizeProviderDescriptor,
  providerConnectionErrors,
  providerCreationPayload,
  providerDefinitionStatus,
  providerDescriptorGroups,
  providerFamilyRecoveryResult,
  providerLabelError,
} from "../desktop/renderer/src/provider-ui-model.js";

const descriptors = [
  {
    adapterId: "openai-api",
    label: "OpenAI API",
    accessContract: "secret@1",
    defaultEndpoint: "https://api.openai.com/v1",
    endpointEditableDuringCreation: true,
    connection: { mode: "secret-fields", fields: [{ id: "apiKey", label: "API key", kind: "secret", required: true }] },
  },
  {
    adapterId: "codex-subscription",
    label: "Codex subscription",
    accessContract: "managed-runtime@1",
    defaultEndpoint: null,
    endpointEditableDuringCreation: false,
    connection: { mode: "managed-login", fields: [] },
  },
];

describe("provider renderer model", () => {
  it("normalizes registry descriptors and validates connection forms", () => {
    const groups = providerDescriptorGroups(descriptors);
    expect(groups.subscriptions.map((item) => item.adapterId), "managed subscriptions group separately")
      .toEqual(["codex-subscription"]);
    expect(groups.api.map((item) => item.adapterId), "secret adapters group together").toEqual(["openai-api"]);

    const malformed = [
      ["unknown connection mode", { adapterId: "bad", label: "Bad", connection: { mode: "oauth" } }, "invalid connection mode"],
      ["invalid field kind", { adapterId: "bad", label: "Bad", connection: { mode: "secret-fields", fields: [{ id: "token", label: "Token", kind: "html" }] } }, "invalid connection field"],
    ];
    expect(malformed, "malformed descriptor inventory").toHaveLength(2);
    for (const [label, descriptor, message] of malformed) {
      expect.soft(() => normalizeProviderDescriptor(descriptor), label).toThrow(message);
    }

    const definitions = [
      { id: "work", label: "OpenAI Work", lifecycleState: "active" },
      { id: "pending", label: "Company Proxy", lifecycleState: "removal_pending" },
      { id: "old", label: "OpenAI Personal", lifecycleState: "tombstoned" },
    ];
    expect(providerLabelError("openai work", definitions), "active names collide case-insensitively")
      .toBe("Active connection names must be unique.");
    expect(providerLabelError("company proxy", definitions), "removal-pending names still collide")
      .toBe("Active connection names must be unique.");
    expect(providerLabelError("openai personal", definitions), "tombstoned names are reusable").toBeNull();
    expect(providerLabelError("OPENAI WORK", definitions, "work"), "a definition keeps its own name").toBeNull();

    const descriptor = normalizeProviderDescriptor(descriptors[0]);
    expect(providerConnectionErrors(descriptor, {
      label: "OpenAI Work",
      endpoint: "https://proxy.example/v1?key=secret",
      fields: { apiKey: "" },
    }), "embedded credentials and missing secrets are both reported").toEqual({
      endpoint: "The endpoint cannot contain credentials, query parameters, or a fragment.",
      apiKey: "Enter API key.",
    });
    expect(providerConnectionErrors(descriptor, {
      label: "OpenAI Work",
      endpoint: "http://127.0.0.1:8080/v1",
      fields: { apiKey: "sk-test" },
    }), "plain HTTP stays rejected").toEqual({ endpoint: "Use an HTTPS endpoint." });

    expect(providerCreationPayload(descriptor, {
      label: " OpenAI Work ",
      endpoint: "https://proxy.example/v1/",
      fields: { apiKey: "sk-test" },
    }), "payload trims the label, normalizes the endpoint, and carries no descriptor authority").toEqual({
      adapterId: "openai-api",
      label: "OpenAI Work",
      endpoint: "https://proxy.example/v1",
      fields: { apiKey: "sk-test" },
    });
    expect(providerCreationPayload(descriptor, {
      label: "OpenAI Work",
      endpoint: "https://proxy.example/v1",
      fields: { apiKey: "sk-test" },
    }, { connectionId: "attempt-1" }), "renderer-owned connection attempt id passes through").toMatchObject({
      connectionId: "attempt-1",
      adapterId: "openai-api",
    });
  });

  it("hard-gates first run on provider and default family resolution", () => {
    expect(firstRunGateState({ hasCompletedOnboarding: false, providers: [], defaultResolution: null }),
      "no provider blocks first run").toEqual({ blocked: true, reason: "Connect a working provider to continue." });
    expect(firstRunGateState({
      hasCompletedOnboarding: false,
      providers: [{ lifecycleState: "active" }],
      defaultResolution: null,
    }).reason, "a provider without a family names the family gap").toContain("default model family");
    expect(firstRunGateState({
      hasCompletedOnboarding: false,
      providers: [{ lifecycleState: "active" }],
      defaultResolution: { familyId: 7 },
    }).reason, "a family without a model names the model gap").toContain("no model available");
    expect(firstRunGateState({
      hasCompletedOnboarding: false,
      providers: [{ lifecycleState: "active" }],
      defaultResolution: { familyId: 7, providerDefinitionId: "work", modelId: "gpt-5.2" },
    }), "a fully resolved default unblocks first run").toEqual({ blocked: false, reason: null });
    expect(firstRunGateState({ hasCompletedOnboarding: true, providers: [], defaultResolution: null }),
      "completed onboarding never re-gates").toEqual({ blocked: false, reason: null });

    expect(firstRunGateState({
      hasCompletedOnboarding: false,
      providers: [{
        lifecycleState: "active",
        connected: true,
        unavailableReason: { code: "provider_no_eligible_execution_models", message: "No supported text models." },
      }],
      defaultResolution: null,
    }), "a zero-eligible provider is directed to model refresh, not another connection").toEqual({
      blocked: true,
      reason: "Refresh models and set up defaults for the connected provider.",
    });

    const provider = {
      lifecycleState: "active",
      connected: true,
      unavailableReason: {
        code: "provider_no_available_execution_configurations",
        message: "This provider currently has no available execution configurations.",
      },
    };
    expect(providerDefinitionStatus(provider), "no-ready-route providers need execution setup").toMatchObject({
      lifecycle: "needs_execution_setup",
      recovery: "repair_execution",
      usable: false,
    });
    expect(firstRunGateState({
      hasCompletedOnboarding: false,
      providers: [provider],
      defaultResolution: null,
    }), "a no-ready-route provider is directed to execution repair").toEqual({
      blocked: true,
      reason: "Repair execution configurations for the connected provider.",
    });
  });

  it("reports definition status and family recovery outcomes", () => {
    const recoveryCases = [
      ["still ineligible", { definitions: [{
        id: "work",
        unavailableReason: { code: "provider_no_eligible_execution_models", message: "No supported text models." },
      }] }, { recovered: false, message: "No supported text models." }],
      ["recovered", { definitions: [{ id: "work", unavailableReason: null }] }, {
        recovered: true, message: "Provider models and default family refreshed.",
      }],
      ["credentials rejected", { definitions: [{
        id: "work",
        unavailableReason: { code: "provider_unavailable", message: "Provider credentials were rejected." },
      }] }, { recovered: false, message: "Provider credentials were rejected." }],
      ["missing definition", { definitions: [] }, {
        recovered: false,
        message: "Provider refresh completed, but default family setup could not be confirmed.",
      }],
    ];
    expect(recoveryCases, "family recovery outcome inventory").toHaveLength(4);
    for (const [label, status, expected] of recoveryCases) {
      expect.soft(providerFamilyRecoveryResult(status, "work"), label).toEqual(expected);
    }

    expect(providerDefinitionStatus({ lifecycleState: "removal_pending" }), "removal-pending stays unusable")
      .toMatchObject({ usable: false, label: "Finishing removal" });
    expect(providerDefinitionStatus({ lifecycleState: "tombstoned" }), "tombstoned stays unusable")
      .toMatchObject({ usable: false, label: "Removed provider" });
  });
});
