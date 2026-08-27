import { describe, expect, it } from "vitest";

import {
  firstRunGateState,
  normalizeProviderDescriptor,
  providerConnectionErrors,
  providerCreationPayload,
  providerDefinitionStatus,
  providerDescriptorGroups,
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
  it("groups registry descriptors by connection flow without adapter-specific branches", () => {
    const groups = providerDescriptorGroups(descriptors);
    expect(groups.subscriptions.map((item) => item.adapterId)).toEqual(["codex-subscription"]);
    expect(groups.api.map((item) => item.adapterId)).toEqual(["openai-api"]);
  });

  it("fails closed for malformed registry descriptors", () => {
    expect(() => normalizeProviderDescriptor({ adapterId: "bad", label: "Bad", connection: { mode: "oauth" } }))
      .toThrow("invalid connection mode");
    expect(() => normalizeProviderDescriptor({ adapterId: "bad", label: "Bad", connection: { mode: "secret-fields", fields: [{ id: "token", label: "Token", kind: "html" }] } }))
      .toThrow("invalid connection field");
  });

  it("keeps active and removal-pending names case-insensitively unique", () => {
    const definitions = [
      { id: "work", label: "OpenAI Work", lifecycleState: "active" },
      { id: "pending", label: "Company Proxy", lifecycleState: "removal_pending" },
      { id: "old", label: "OpenAI Personal", lifecycleState: "tombstoned" },
    ];
    expect(providerLabelError("openai work", definitions)).toBe("Active connection names must be unique.");
    expect(providerLabelError("company proxy", definitions)).toBe("Active connection names must be unique.");
    expect(providerLabelError("openai personal", definitions)).toBeNull();
    expect(providerLabelError("OPENAI WORK", definitions, "work")).toBeNull();
  });

  it("validates typed fields and safe editable endpoints while preserving form intent", () => {
    const descriptor = normalizeProviderDescriptor(descriptors[0]);
    expect(providerConnectionErrors(descriptor, {
      label: "OpenAI Work",
      endpoint: "https://proxy.example/v1?key=secret",
      fields: { apiKey: "" },
    })).toEqual({
      endpoint: "The endpoint cannot contain credentials, query parameters, or a fragment.",
      apiKey: "Enter API key.",
    });
    expect(providerConnectionErrors(descriptor, {
      label: "OpenAI Work",
      endpoint: "http://127.0.0.1:8080/v1",
      fields: { apiKey: "sk-test" },
    })).toEqual({ endpoint: "Use an HTTPS endpoint." });
  });

  it("builds a creation payload without implementation version or access-contract authority", () => {
    expect(providerCreationPayload(normalizeProviderDescriptor(descriptors[0]), {
      label: " OpenAI Work ",
      endpoint: "https://proxy.example/v1/",
      fields: { apiKey: "sk-test" },
    })).toEqual({
      adapterId: "openai-api",
      label: "OpenAI Work",
      endpoint: "https://proxy.example/v1",
      fields: { apiKey: "sk-test" },
    });
  });

  it("carries a renderer-owned connection attempt id without provider authority", () => {
    expect(providerCreationPayload(normalizeProviderDescriptor(descriptors[0]), {
      label: "OpenAI Work",
      endpoint: "https://proxy.example/v1",
      fields: { apiKey: "sk-test" },
    }, { connectionId: "attempt-1" })).toMatchObject({
      connectionId: "attempt-1",
      adapterId: "openai-api",
    });
  });

  it("hard-gates only first run and distinguishes provider from family resolution", () => {
    expect(firstRunGateState({ hasCompletedOnboarding: false, providers: [], defaultResolution: null }))
      .toEqual({ blocked: true, reason: "Connect a working provider to continue." });
    expect(firstRunGateState({
      hasCompletedOnboarding: false,
      providers: [{ lifecycleState: "active" }],
      defaultResolution: null,
    }).reason).toContain("default model family");
    expect(firstRunGateState({
      hasCompletedOnboarding: false,
      providers: [{ lifecycleState: "active" }],
      defaultResolution: { familyId: 7 },
    }).reason).toContain("no model available");
    expect(firstRunGateState({
      hasCompletedOnboarding: false,
      providers: [{ lifecycleState: "active" }],
      defaultResolution: { familyId: 7, providerDefinitionId: "work", modelId: "gpt-5.2" },
    })).toEqual({ blocked: false, reason: null });
    expect(firstRunGateState({ hasCompletedOnboarding: true, providers: [], defaultResolution: null }))
      .toEqual({ blocked: false, reason: null });
  });

  it("labels pending and tombstoned definitions as unusable", () => {
    expect(providerDefinitionStatus({ lifecycleState: "removal_pending" })).toMatchObject({ usable: false, label: "Finishing removal" });
    expect(providerDefinitionStatus({ lifecycleState: "tombstoned" })).toMatchObject({ usable: false, label: "Removed provider" });
  });
});
