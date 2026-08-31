import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  ACTIVE_PROVIDER_ADAPTER_IDS,
  ACTIVE_PROVIDER_ADAPTER_MODULES,
  productionProviderAdapterRegistry,
  productionProviderRuntimeDependencies,
  resolveLegacyCodexHome,
} from "../desktop/main/providers/provider-adapter-registry.mjs";
import {
  createProviderAdapterRegistry,
  normalizeProviderEndpoint,
} from "../desktop/main/providers/provider-adapter-contract.mjs";
import { ProviderDefinitionService } from "../desktop/main/providers/provider-definition-service.mjs";
import { createProviderDiagnosticsLog } from "../desktop/main/providers/provider-diagnostics-log.mjs";
import {
  createProviderRuntimeStateRemover,
  providerRuntimeDirectory,
} from "../desktop/main/providers/provider-runtime-state.mjs";
import { ModelCatalogService } from "../desktop/main/models/model-catalog-service.mjs";
import { toProductCatalogSnapshot } from "../desktop/main/models/model-catalog-adapter.mjs";
import { withProviderRetry } from "../desktop/main/providers/provider-retry.mjs";
import { ProviderHttpError } from "../desktop/main/providers/implementations/api-provider-adapter.mjs";
import {
  CLAUDE_SUBSCRIPTION_MODELS,
  ClaudeCliManagedRuntime,
} from "../desktop/main/providers/implementations/claude-subscription.mjs";

const expectedAdapters = [
  "codex-subscription",
  "claude-subscription",
  "openai-api",
  "anthropic-api",
  "openrouter",
  "vercel-ai-router",
];

function definition(adapterId, endpoint, id = "test-provider") {
  return { id, adapterId, label: "Test provider", endpoint, credentialReference: `provider:${id}` };
}

const codexRuntime = Object.freeze({
  runtimeId: "codex", version: "0.150.1", executable: "/managed/codex",
});
const claudeRuntime = Object.freeze({
  runtimeId: "claude", version: "0.3.250", executable: "/managed/claude",
  moduleUrl: "file:///managed/claude/sdk.mjs",
});

function runtimeForAdapter(adapterId) {
  return adapterId === "anthropic-api" || adapterId === "claude-subscription"
    ? claudeRuntime
    : codexRuntime;
}

describe("authoritative provider adapter registry", () => {
  it("contains exactly the six initial production adapters with valid contracts", async () => {
    expect(ACTIVE_PROVIDER_ADAPTER_IDS).toEqual(expectedAdapters);
    expect(productionProviderAdapterRegistry.list().map(({ adapterId }) => adapterId)).toEqual(expectedAdapters);
    expect(Object.keys(ACTIVE_PROVIDER_ADAPTER_MODULES)).toEqual(expectedAdapters);
    for (const modulePath of Object.values(ACTIVE_PROVIDER_ADAPTER_MODULES)) {
      await expect(access(join(import.meta.dirname, "../desktop/main", modulePath))).resolves.toBeUndefined();
    }
    expect(productionProviderAdapterRegistry.list().map(({ accessContract }) => accessContract)).toEqual([
      "managed-runtime@1", "managed-runtime@1", "secret@1", "secret@1", "secret@1", "secret@1",
    ]);
    expect(productionProviderAdapterRegistry.get("claude-subscription").catalog.source).toBe("code-manifest");
    expect(CLAUDE_SUBSCRIPTION_MODELS.map(({ id }) => id)).toEqual([
      "sonnet", "opus", "fable",
    ]);
    expect(() => productionProviderAdapterRegistry.get("future-provider")).toThrow("Unknown provider adapter");
  });

  it("rejects duplicate and invalid descriptors", () => {
    const descriptor = {
      adapterId: "fake", implementationVersion: "1", label: "Fake", accessContract: "secret@1",
      defaultEndpoint: "https://example.test/v1", endpointEditableDuringCreation: true,
      connection: { mode: "secret-fields", fields: [{ id: "key", label: "Key", kind: "secret" }] },
      create() {},
    };
    expect(() => createProviderAdapterRegistry([descriptor, descriptor])).toThrow("Duplicate provider adapter");
    expect(() => createProviderAdapterRegistry([{ ...descriptor, implementationVersion: "v1" }])).toThrow("positive integer");
  });

  it("requires and routes an explicit managed runtime for every active adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-provider-dependencies-"));
    for (const adapterId of expectedAdapters) {
      const id = `${adapterId}-work`;
      const managedRuntime = runtimeForAdapter(adapterId);
      const dependencies = await productionProviderRuntimeDependencies({ id, adapterId }, {
        runtimeRoot: root,
        managedRuntime,
        environment: {
          PATH: "/safe/bin",
          HOME: "/Users/tester",
          USERPROFILE: "C:\\Users\\tester",
          OPENAI_API_KEY: "ambient-openai-secret",
          ANTHROPIC_API_KEY: "ambient-anthropic-secret",
          UNRELATED_TOKEN: "ambient-unrelated-secret",
        },
      });
      expect(dependencies.managedRuntime).toEqual(managedRuntime);
      expect(dependencies.environment).toMatchObject({
        PATH: managedRuntime.runtimeId === "codex" ? "/codex-path:/safe/bin" : "/safe/bin",
        HOME: "/Users/tester",
        USERPROFILE: "C:\\Users\\tester",
      });
      expect(dependencies.environment).not.toHaveProperty("OPENAI_API_KEY");
      expect(dependencies.environment).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(dependencies.environment).not.toHaveProperty("UNRELATED_TOKEN");
      if (managedRuntime.runtimeId === "codex") {
        expect(dependencies.environment).toMatchObject({
          CODEX_HOME: join(root, id, "codex-home"),
          RELAYER_CODEX_BINARY: managedRuntime.executable,
        });
      } else {
        expect(dependencies.environment.CLAUDE_CONFIG_DIR).toBe(join(root, id, "claude-home"));
      }
    }
    await expect(productionProviderRuntimeDependencies({
      id: "openai-work", adapterId: "openai-api",
    }, { runtimeRoot: root, environment: {}, codexBinary: "/ambient/codex" }))
      .rejects.toThrow("managed runtime");
    await expect(productionProviderRuntimeDependencies({
      id: "claude-work", adapterId: "claude-subscription",
    }, { runtimeRoot: root, environment: {}, managedRuntime: codexRuntime }))
      .rejects.toThrow("requires the claude managed runtime");
  });

  it("uses one conventional Windows Path for Claude authentication", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-provider-claude-windows-path-"));
    const dependencies = await productionProviderRuntimeDependencies({
      id: "claude-work", adapterId: "claude-subscription",
    }, {
      runtimeRoot: root,
      managedRuntime: claudeRuntime,
      platform: "win32",
      environment: {
        PATH: "C:\\ambiguous\\bin",
        Path: "C:\\Windows\\System32;C:\\Program Files\\nodejs",
      },
    });
    let spawnedEnvironment;
    const spawnProcess = vi.fn(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      queueMicrotask(() => {
        child.stdout.emit("data", JSON.stringify({ loggedIn: true }));
        child.emit("exit", 0);
      });
      return child;
    });
    const runtime = new ClaudeCliManagedRuntime({
      environment: dependencies.environment,
      executable: dependencies.executable,
      spawnProcess: (...args) => {
        spawnedEnvironment = args[2].env;
        return spawnProcess(...args);
      },
    });

    await expect(runtime.account()).resolves.toMatchObject({ status: "connected" });
    expect(spawnedEnvironment.Path).toBe("C:\\Windows\\System32;C:\\Program Files\\nodejs");
    expect(spawnedEnvironment).not.toHaveProperty("PATH");
    expect(Object.keys(spawnedEnvironment).filter((key) => key.toLowerCase() === "path")).toEqual(["Path"]);
  });

  it("preserves the legacy Codex home only for the migrated default definition across restarts", async () => {
    const profile = await mkdtemp(join(tmpdir(), "relayer-legacy-codex-home-"));
    const runtimeRoot = join(profile, "provider-runtimes");
    const legacyHome = join(profile, "codex-home");
    const conflictingIsolatedHome = join(runtimeRoot, "codex", "codex-home");
    await mkdir(legacyHome, { recursive: true });
    await mkdir(conflictingIsolatedHome, { recursive: true });
    await writeFile(join(legacyHome, "auth.json"), "legacy-session");
    await writeFile(join(conflictingIsolatedHome, "auth.json"), "unrelated-isolated-session");

    const context = {
      runtimeRoot,
      legacyCodexHome: legacyHome,
      environment: { PATH: "/safe/bin" },
      managedRuntime: codexRuntime,
    };
    const migrated = { id: "codex", adapterId: "codex-subscription" };
    const firstStart = await productionProviderRuntimeDependencies(migrated, context);
    const restarted = await productionProviderRuntimeDependencies(migrated, context);

    expect(firstStart.environment.CODEX_HOME).toBe(legacyHome);
    expect(restarted.environment.CODEX_HOME).toBe(legacyHome);
    await expect(readFile(join(legacyHome, "auth.json"), "utf8")).resolves.toBe("legacy-session");
    await expect(readFile(join(conflictingIsolatedHome, "auth.json"), "utf8"))
      .resolves.toBe("unrelated-isolated-session");

    const newDefinition = await productionProviderRuntimeDependencies({
      id: "new-codex-connection", adapterId: "codex-subscription",
    }, context);
    expect(newDefinition.environment.CODEX_HOME)
      .toBe(join(runtimeRoot, "new-codex-connection", "codex-home"));
  });

  it("resolves both legacy Codex home locations with the prior override precedence", () => {
    expect(resolveLegacyCodexHome("/profile", {})).toBe(join("/profile", "codex-home"));
    expect(resolveLegacyCodexHome("/profile", { RELAYER_CODEX_HOME: "/custom/codex" }))
      .toBe("/custom/codex");
    expect(resolveLegacyCodexHome("/profile", { RELAYER_CODEX_HOME: "" }))
      .toBe(join("/profile", "codex-home"));
  });

  it("normalizes safe endpoints and rejects embedded authority or query data", () => {
    expect(normalizeProviderEndpoint("https://example.test/v1///")).toBe("https://example.test/v1");
    expect(() => normalizeProviderEndpoint("https://key@example.test/v1")).toThrow("credentials");
    expect(() => normalizeProviderEndpoint("https://example.test/v1?api_key=secret")).toThrow("query string");
    expect(() => normalizeProviderEndpoint("http://example.test/v1")).toThrow("HTTPS");
    expect(normalizeProviderEndpoint("http://127.0.0.1:8123/v1", { allowDevelopmentLoopback: true }))
      .toBe("http://127.0.0.1:8123/v1");
  });
});

describe("secret-backed API adapters", () => {
  it.each([
    ["openai-api", [{ id: "gpt-5.4" }, { id: "text-embedding-3-large" }], "gpt-5.4"],
    ["anthropic-api", [{ id: "claude-sonnet-4-20250514" }, { id: "embedding-model" }], "claude-sonnet-4-20250514"],
    ["openrouter", [
      { id: "openai/gpt-5.4", architecture: { output_modalities: ["text"] } },
      { id: "openai/text-embedding-3-large", architecture: { output_modalities: ["embeddings"] } },
    ], "openai/gpt-5.4"],
    ["vercel-ai-router", [{ id: "openai/gpt-5.4", type: "language" }, { id: "openai/sora", type: "video" }], "openai/gpt-5.4"],
  ])("%s preserves catalog diagnostics but admits only capability-proven agent models", async (
    adapterId,
    models,
    eligibleId,
  ) => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [...models, { id: "unknown-model" }] }),
    }));
    const descriptor = productionProviderAdapterRegistry.get(adapterId);
    const adapter = productionProviderAdapterRegistry.create(
      definition(adapterId, descriptor.defaultEndpoint),
      { fetch, secrets: { "api-key": "secret" }, managedRuntime: runtimeForAdapter(adapterId), environment: {} },
    );

    const snapshot = await adapter.connect();
    const product = toProductCatalogSnapshot(snapshot);

    expect(snapshot.models.map(({ id, visible }) => ({ id, visible }))).toEqual(
      models.concat({ id: "unknown-model" }).map(({ id }) => ({ id, visible: true })),
    );
    expect(snapshot.models.filter(({ availability }) => availability === "available").map(({ id }) => id))
      .toEqual([eligibleId]);
    expect(product.models.filter(({ available }) => !available)).toEqual([
      expect.objectContaining({
        unavailableReason: {
          code: "provider_model_not_execution_eligible",
          message: "This provider model is not eligible for agent execution.",
        },
      }),
      expect.objectContaining({
        id: "unknown-model",
        unavailableReason: {
          code: "provider_model_capability_unknown",
          message: "This provider model has no recognized agent-execution capability evidence.",
        },
      }),
    ]);
  });

  it("keeps a provider connected when discovery has zero execution-eligible models", async () => {
    const descriptor = productionProviderAdapterRegistry.get("openai-api");
    const adapter = productionProviderAdapterRegistry.create(
      definition("openai-api", descriptor.defaultEndpoint),
      {
        fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: "text-embedding-3-large" }] }) }),
        secrets: { "api-key": "secret" },
        managedRuntime: codexRuntime,
        environment: {},
      },
    );

    const snapshot = await adapter.connect();

    expect(snapshot.provider.status).toBe("available");
    expect(snapshot.models).toEqual([expect.objectContaining({
      id: "text-embedding-3-large",
      visible: true,
      availability: "unavailable",
      unavailableReasonCode: "provider_model_not_execution_eligible",
    })]);
  });

  it("rejects an expired OpenRouter key before accepting its public model catalog", async () => {
    const fetch = vi.fn(async (url) => url.endsWith("/key")
      ? { ok: false, status: 401 }
      : {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: "deepseek/deepseek-v4-pro-0813", architecture: { output_modalities: ["text"] } }] }),
        });
    const descriptor = productionProviderAdapterRegistry.get("openrouter");
    const adapter = productionProviderAdapterRegistry.create(
      definition("openrouter", descriptor.defaultEndpoint),
      { fetch, secrets: { "api-key": "expired" }, managedRuntime: codexRuntime, environment: {} },
    );

    await expect(adapter.connect()).resolves.toMatchObject({
      provider: { status: "unavailable", unavailableReason: "Provider credentials were rejected." },
      models: [],
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://openrouter.ai/api/v1/key"]);
  });

  it("uses the catalog contract without the proprietary key probe for a custom OpenRouter endpoint", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "z-ai/glm-5.3", architecture: { output_modalities: ["text"] } }] }),
    }));
    const adapter = productionProviderAdapterRegistry.create(
      definition("openrouter", "https://router.example.test/v1"),
      { fetch, secrets: { "api-key": "secret" }, managedRuntime: codexRuntime, environment: {} },
    );

    await expect(adapter.connect()).resolves.toMatchObject({ provider: { status: "available" } });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://router.example.test/v1/models"]);
  });

  it("rejects Anthropic capability models even when their IDs start with claude", async () => {
    const descriptor = productionProviderAdapterRegistry.get("anthropic-api");
    const adapter = productionProviderAdapterRegistry.create(
      definition("anthropic-api", descriptor.defaultEndpoint),
      {
        fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: "claude-embedding" }] }) }),
        secrets: { "api-key": "secret" },
        managedRuntime: claudeRuntime,
        environment: {},
      },
    );

    await expect(adapter.connect()).resolves.toMatchObject({
      models: [{ id: "claude-embedding", availability: "unavailable", unavailableReasonCode: "provider_model_not_execution_eligible" }],
    });
  });

  it("admits only reviewed Claude text-family IDs and rejects unrecognized Claude capabilities", async () => {
    const descriptor = productionProviderAdapterRegistry.get("anthropic-api");
    const adapter = productionProviderAdapterRegistry.create(
      definition("anthropic-api", descriptor.defaultEndpoint),
      {
        fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [
          { id: "claude-sonnet-4-20250514" },
          { id: "claude-3-5-haiku-20241022" },
          { id: "claude-realtime" },
          { id: "claude-batch" },
          { id: "claude-sonnet-realtime" },
          { id: "claude-opus-batch" },
          { id: "claude-haiku-audio" },
          { id: "claude-3-realtime" },
          { id: "claude-1-batch" },
        ] }) }),
        secrets: { "api-key": "secret" },
        managedRuntime: claudeRuntime,
        environment: {},
      },
    );

    const snapshot = await adapter.connect();
    expect(snapshot.models.filter(({ availability }) => availability === "available").map(({ id }) => id))
      .toEqual(["claude-sonnet-4-20250514", "claude-3-5-haiku-20241022"]);
    expect(snapshot.models.filter(({ availability }) => availability === "unavailable").map(({ id, unavailableReasonCode }) => ({ id, unavailableReasonCode })))
      .toEqual([
        { id: "claude-realtime", unavailableReasonCode: "provider_model_capability_unknown" },
        { id: "claude-batch", unavailableReasonCode: "provider_model_capability_unknown" },
        { id: "claude-sonnet-realtime", unavailableReasonCode: "provider_model_capability_unknown" },
        { id: "claude-opus-batch", unavailableReasonCode: "provider_model_capability_unknown" },
        { id: "claude-haiku-audio", unavailableReasonCode: "provider_model_capability_unknown" },
        { id: "claude-3-realtime", unavailableReasonCode: "provider_model_capability_unknown" },
        { id: "claude-1-batch", unavailableReasonCode: "provider_model_capability_unknown" },
      ]);
  });

  it("fails closed for an unknown model that merely uses an OpenAI agent-family prefix", async () => {
    const descriptor = productionProviderAdapterRegistry.get("openai-api");
    const adapter = productionProviderAdapterRegistry.create(
      definition("openai-api", descriptor.defaultEndpoint),
      {
        fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: "gpt-made-up" }] }) }),
        secrets: { "api-key": "secret" },
        managedRuntime: codexRuntime,
        environment: {},
      },
    );

    await expect(adapter.connect()).resolves.toMatchObject({
      provider: { status: "available" },
      models: [{
        id: "gpt-made-up",
        availability: "unavailable",
        unavailableReasonCode: "provider_model_capability_unknown",
      }],
    });
  });

  it("keeps a provider connected when every discovered model is provider-hidden and ineligible", async () => {
    const descriptor = productionProviderAdapterRegistry.get("openai-api");
    const adapter = productionProviderAdapterRegistry.create(
      definition("openai-api", descriptor.defaultEndpoint),
      {
        fetch: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: "text-embedding-3-large", hidden: true }] }),
        }),
        secrets: { "api-key": "secret" },
        managedRuntime: codexRuntime,
        environment: {},
      },
    );

    await expect(adapter.connect()).resolves.toMatchObject({
      provider: { status: "available" },
      models: [{
        id: "text-embedding-3-large",
        visible: false,
        availability: "unavailable",
        unavailableReasonCode: "provider_model_not_execution_eligible",
      }],
    });
  });

  for (const [adapterId, expectedEndpoint, expectedHeader] of [
    ["openai-api", "https://api.openai.com/v1/models", "authorization"],
    ["anthropic-api", "https://api.anthropic.com/v1/models", "x-api-key"],
    ["openrouter", "https://openrouter.ai/api/v1/models", "authorization"],
    ["vercel-ai-router", "https://ai-gateway.vercel.sh/v1/models", "authorization"],
  ]) {
    it(`${adapterId} discovers stable model ids through the common contract`, async () => {
      const modelId = adapterId === "openai-api" ? "gpt-5.4" : "model-stable";
      const fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: modelId, name: "Model Stable" }] }),
      }));
      const descriptor = productionProviderAdapterRegistry.get(adapterId);
      const adapter = productionProviderAdapterRegistry.create(
        definition(adapterId, descriptor.defaultEndpoint),
        { fetch, secrets: { "api-key": "sk-not-logged" }, managedRuntime: runtimeForAdapter(adapterId), environment: { PATH: "/safe/bin" } },
      );

      const snapshot = await adapter.connect();

      const expectedUrls = adapterId === "openrouter"
        ? ["https://openrouter.ai/api/v1/key", expectedEndpoint]
        : [expectedEndpoint];
      expect(fetch.mock.calls.map(([url]) => url)).toEqual(expectedUrls);
      expect(Object.keys(fetch.mock.calls.at(-1)[1].headers).map((key) => key.toLowerCase())).toContain(expectedHeader);
      expect(snapshot.models[0]).toMatchObject({ id: modelId, executionModel: modelId });
      expect(snapshot.systemFamily.modelIds).toEqual([]);
    });
  }

  it("carries OpenRouter's exact per-model token capabilities into execution access", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [
        {
          id: "z-ai/glm-5.3",
          name: "GLM 5.3",
          context_length: 202_752,
          top_provider: { context_length: 196_608, max_completion_tokens: 131_072 },
        },
        {
          id: "small-output-model",
          name: "Small output model",
          context_length: 32_768,
          top_provider: { context_length: 32_768, max_completion_tokens: 2_048 },
        },
        { id: "unknown-limits", name: "Unknown limits" },
      ] }),
    }));
    const descriptor = productionProviderAdapterRegistry.get("openrouter");
    const adapter = productionProviderAdapterRegistry.create(
      definition("openrouter", descriptor.defaultEndpoint),
      { fetch, secrets: { "api-key": "sk-not-logged" }, managedRuntime: codexRuntime, environment: {} },
    );

    await adapter.connect();

    expect(adapter.executionAccess()).toMatchObject({
      modelCapabilities: {
        "z-ai/glm-5.3": { contextWindow: 196_608, maxOutputTokens: 131_072 },
        "small-output-model": { contextWindow: 32_768, maxOutputTokens: 2_048 },
      },
    });
    expect(adapter.executionAccess().modelCapabilities).not.toHaveProperty("unknown-limits");
  });

  it("carries Vercel AI Gateway's exact per-model token capabilities into execution access", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [
        {
          id: "deepseek/deepseek-v4-pro-0813",
          name: "DeepSeek V4 Pro 0813",
          type: "language",
          context_window: 1_000_000,
          max_tokens: 384_000,
        },
        {
          id: "unknown-limits",
          name: "Unknown limits",
          type: "language",
        },
      ] }),
    }));
    const descriptor = productionProviderAdapterRegistry.get("vercel-ai-router");
    const adapter = productionProviderAdapterRegistry.create(
      definition("vercel-ai-router", descriptor.defaultEndpoint),
      { fetch, secrets: { "api-key": "sk-not-logged" }, managedRuntime: codexRuntime, environment: {} },
    );

    await adapter.connect();

    expect(adapter.executionAccess()).toMatchObject({
      modelCapabilities: {
        "deepseek/deepseek-v4-pro-0813": { contextWindow: 1_000_000, maxOutputTokens: 384_000 },
      },
    });
    expect(adapter.executionAccess().modelCapabilities).not.toHaveProperty("unknown-limits");
  });

  it("refreshes OpenRouter discovery before execution when startup did not populate capabilities", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{
        id: "z-ai/glm-5.3",
        context_length: 202_752,
        top_provider: { context_length: 196_608, max_completion_tokens: 131_072 },
      }] }),
    }));
    const descriptor = productionProviderAdapterRegistry.get("openrouter");
    const adapter = productionProviderAdapterRegistry.create(
      definition("openrouter", descriptor.defaultEndpoint),
      { fetch, secrets: { "api-key": "sk-not-logged" }, managedRuntime: codexRuntime, environment: {} },
    );

    const access = await adapter.executionAccess();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${descriptor.defaultEndpoint}/key`,
      `${descriptor.defaultEndpoint}/models`,
    ]);
    expect(access.modelCapabilities["z-ai/glm-5.3"]).toEqual({
      contextWindow: 196_608,
      maxOutputTokens: 131_072,
    });
  });

  it("refreshes Vercel discovery before execution when startup did not populate capabilities", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{
        id: "deepseek/deepseek-v4-pro-0813",
        type: "language",
        context_window: 1_000_000,
        max_tokens: 384_000,
      }] }),
    }));
    const descriptor = productionProviderAdapterRegistry.get("vercel-ai-router");
    const adapter = productionProviderAdapterRegistry.create(
      definition("vercel-ai-router", descriptor.defaultEndpoint),
      { fetch, secrets: { "api-key": "sk-not-logged" }, managedRuntime: codexRuntime, environment: {} },
    );

    const access = await adapter.executionAccess();

    expect(fetch).toHaveBeenCalledOnce();
    expect(access.modelCapabilities["deepseek/deepseek-v4-pro-0813"]).toEqual({
      contextWindow: 1_000_000,
      maxOutputTokens: 384_000,
    });
  });

  it("fails one bounded OpenRouter rediscovery when credentials are rejected", async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 401 }));
    const descriptor = productionProviderAdapterRegistry.get("openrouter");
    const adapter = productionProviderAdapterRegistry.create(
      definition("openrouter", descriptor.defaultEndpoint),
      { fetch, secrets: { "api-key": "rejected" }, managedRuntime: codexRuntime, environment: {} },
    );

    await expect(adapter.executionAccess()).rejects.toThrow("credentials were rejected");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ["openai-api", codexRuntime],
    ["openrouter", codexRuntime],
    ["vercel-ai-router", codexRuntime],
    ["anthropic-api", claudeRuntime],
  ])("%s carries its provisioned runtime into secret execution access", async (adapterId, managedRuntime) => {
    const descriptor = productionProviderAdapterRegistry.get(adapterId);
    const environment = managedRuntime.runtimeId === "codex"
      ? { CODEX_HOME: "/isolated/codex", RELAYER_CODEX_BINARY: managedRuntime.executable }
      : { CLAUDE_CONFIG_DIR: "/isolated/claude" };
    const adapter = productionProviderAdapterRegistry.create(
      definition(adapterId, descriptor.defaultEndpoint),
      {
        fetch: vi.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: "model", context_length: 32_768, top_provider: { context_length: 32_768, max_completion_tokens: 8_192 } }] }),
        })),
        secrets: { "api-key": "secret" },
        managedRuntime,
        environment,
      },
    );

    expect(await adapter.executionAccess()).toMatchObject({
      kind: "secret",
      endpoint: descriptor.defaultEndpoint,
      fields: { "api-key": "secret" },
      runtime: { ...managedRuntime, environment },
    });
  });

  it("rejects malformed or empty discovery without manual model entry", async () => {
    const descriptor = productionProviderAdapterRegistry.get("openai-api");
    const adapter = productionProviderAdapterRegistry.create(
      definition("openai-api", descriptor.defaultEndpoint),
      { fetch: async () => ({ ok: true, json: async () => ({ data: [] }) }), secrets: { "api-key": "secret" }, managedRuntime: codexRuntime, environment: {} },
    );
    await expect(adapter.connect()).rejects.toThrow("visible models");
  });

  it("publishes rejected API credentials as disconnected while staged creation still rejects", async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 401 }));
    const descriptor = productionProviderAdapterRegistry.get("openai-api");
    const adapter = productionProviderAdapterRegistry.create(
      definition("openai-api", descriptor.defaultEndpoint, "revoked-api"),
      { fetch, secrets: { "api-key": "opaque" }, managedRuntime: codexRuntime, environment: {} },
    );
    const published = [];
    const catalog = new ModelCatalogService({
      adapters: [adapter], publishSnapshot: async (snapshot) => { published.push(snapshot); },
    });
    await expect(catalog.explicitRefresh("revoked-api")).resolves.toMatchObject({
      provider: { status: "unavailable", unavailableReason: "Provider credentials were rejected." },
      models: [],
    });
    expect(published).toEqual([expect.objectContaining({
      providerId: "revoked-api",
      connected: false,
      unavailableReason: { code: "provider_unavailable", message: "Provider credentials were rejected." },
    })]);

    const definitions = [];
    const credentialSet = vi.fn(async () => {});
    const setup = new ProviderDefinitionService({
      registry: productionProviderAdapterRegistry,
      definitionStore: {
        async load() { return definitions; },
        async createWithCatalog(candidate) { definitions.push(candidate); },
      },
      credentialStore: { set: credentialSet, async delete() {} },
      runtimeDependencies: async () => ({ fetch, managedRuntime: codexRuntime, environment: {} }),
      idGenerator: () => "revoked-staged",
    });
    await expect(setup.connect({
      adapterId: "openai-api", label: "Revoked", fields: { "api-key": "opaque" },
    })).rejects.toThrow("Provider credentials were rejected");
    expect(definitions).toEqual([]);
    expect(credentialSet).not.toHaveBeenCalled();
    await catalog.close();
  });
});

describe("managed subscription isolation", () => {
  it("rejects logout while the exact provider has an active execution lease", async () => {
    const logout = vi.fn(async () => ({ status: "disconnected" }));
    const descriptor = {
      adapterId: "fake-managed", implementationVersion: "1", label: "Managed", accessContract: "managed-runtime@1",
      defaultEndpoint: null, connection: { mode: "managed-login", fields: [] },
      create: () => { throw new Error("initial runtime should be reused"); },
    };
    const service = new ProviderDefinitionService({
      registry: createProviderAdapterRegistry([descriptor]),
      definitionStore: { async load() { return [{
        id: "managed-work", adapterId: "fake-managed", label: "Work", endpoint: null,
        accessContract: "managed-runtime@1", credentialReference: null, lifecycleState: "active",
      }]; } },
      credentialStore: {},
      initialRuntimes: new Map([["managed-work", { credentials: { logout } }]]),
    });

    const lease = await service.acquireExecution("managed-work");
    await expect(service.logout("managed-work")).rejects.toThrow("interactions are running");
    expect(logout).not.toHaveBeenCalled();
    await lease.release();
    await expect(service.logout("managed-work")).resolves.toEqual({ status: "disconnected" });
  });

  it("reconnects a signed-out managed provider without creating a new definition identity", async () => {
    let accountStatus = "disconnected";
    const published = [];
    const definition = {
      id: "managed-work", adapterId: "fake-managed", label: "Work", endpoint: null,
      accessContract: "managed-runtime@1", credentialReference: null, lifecycleState: "active",
    };
    const runtime = {
      providerId: definition.id,
      credentials: {
        login: vi.fn(async () => ({ authUrl: "https://login.example.test/work" })),
        account: vi.fn(async () => ({ status: accountStatus })),
      },
      discover: vi.fn(async () => ({
        provider: { id: definition.id, label: definition.label, status: "available" },
        models: [{ visible: true }],
        systemFamily: { id: definition.id, label: definition.label, modelIds: [] },
      })),
    };
    const prepareRuntime = vi.fn(async () => {});
    const service = new ProviderDefinitionService({
      registry: createProviderAdapterRegistry([{
        adapterId: "fake-managed", implementationVersion: "1", label: "Managed", accessContract: "managed-runtime@1",
        defaultEndpoint: null, connection: { mode: "managed-login", fields: [] }, create: () => runtime,
      }]),
      definitionStore: {
        async load() { return [definition]; },
        createWithCatalog: vi.fn(async () => { throw new Error("reconnect must not create a definition"); }),
      },
      credentialStore: {},
      initialRuntimes: new Map([[definition.id, runtime]]),
      prepareRuntime,
      publishCatalog: async (snapshot) => { published.push(snapshot); },
    });

    const pending = await service.reconnect(definition.id);
    expect(pending).toMatchObject({
      status: "pending", connectionId: definition.id,
      providerDefinition: { id: definition.id },
    });
    expect(pending.login.authUrl).toBe("https://login.example.test/work");
    expect(prepareRuntime).toHaveBeenCalledWith(expect.objectContaining({
      adapterId: "fake-managed",
      providerDefinition: expect.objectContaining({ id: definition.id }),
    }));
    await expect(service.completeConnection(definition.id)).resolves.toMatchObject({ status: "pending" });
    accountStatus = "connected";
    await expect(service.completeConnection(definition.id)).resolves.toMatchObject({
      status: "connected", providerDefinition: { id: definition.id },
    });
    expect(published).toHaveLength(1);
    await expect(service.list()).resolves.toEqual([expect.objectContaining({ id: definition.id })]);
  });

  it.each(["reconnect", "recoverUnavailable"])(
    "%s leaves unrelated provider leases available while runtime preparation is deferred",
    async (operationName) => {
      const definitions = [
        {
          id: "managed-repair", adapterId: "fake-managed", label: "Repair", endpoint: null,
          accessContract: "managed-runtime@1", credentialReference: null, lifecycleState: "active",
        },
        {
          id: "managed-ready", adapterId: "fake-managed", label: "Ready", endpoint: null,
          accessContract: "managed-runtime@1", credentialReference: null, lifecycleState: "active",
        },
      ];
      let finishPreparation;
      let markPreparationStarted;
      const preparation = new Promise((resolve) => { finishPreparation = resolve; });
      const preparationStarted = new Promise((resolve) => { markPreparationStarted = resolve; });
      const repairRuntime = {
        credentials: { login: vi.fn(async () => ({ authUrl: "https://login.example.test/repair" })) },
        discover: vi.fn(async () => ({ models: [{ visible: true }] })),
      };
      const readyRuntime = {};
      const service = new ProviderDefinitionService({
        registry: createProviderAdapterRegistry([{
          adapterId: "fake-managed", implementationVersion: "1", label: "Managed", accessContract: "managed-runtime@1",
          defaultEndpoint: null, connection: { mode: "managed-login", fields: [] }, create: () => repairRuntime,
        }]),
        definitionStore: { async load() { return definitions; } },
        credentialStore: {},
        initialRuntimes: new Map([
          ["managed-repair", repairRuntime],
          ["managed-ready", readyRuntime],
        ]),
        prepareRuntime: () => {
          markPreparationStarted();
          return preparation;
        },
      });

      const repairing = service[operationName]("managed-repair");
      await preparationStarted;
      const acquisition = service.acquireExecution("managed-ready").then((lease) => ({ kind: "lease", lease }));
      const first = await Promise.race([
        acquisition,
        new Promise((resolve) => setImmediate(() => resolve({ kind: "blocked" }))),
      ]);
      expect(first.kind).toBe("lease");
      await first.lease.release();

      const targetLease = operationName === "reconnect"
        ? await service.acquireExecution("managed-repair")
        : null;
      finishPreparation();
      if (targetLease) {
        await expect(repairing).rejects.toThrow("interactions are running");
        await targetLease.release();
      } else {
        await expect(repairing).resolves.toBeDefined();
      }
      await service.close();
    },
  );

  it("cancels and drains reconnect runtime preparation before service close completes", async () => {
    const definition = {
      id: "managed-work", adapterId: "fake-managed", label: "Work", endpoint: null,
      accessContract: "managed-runtime@1", credentialReference: null, lifecycleState: "active",
    };
    let finishPreparation;
    const preparation = new Promise((resolve) => { finishPreparation = resolve; });
    const login = vi.fn(async () => ({ authUrl: "https://login.example.test/work" }));
    const closeRuntime = vi.fn(async () => {});
    const service = new ProviderDefinitionService({
      registry: createProviderAdapterRegistry([{
        adapterId: "fake-managed", implementationVersion: "1", label: "Managed", accessContract: "managed-runtime@1",
        defaultEndpoint: null, connection: { mode: "managed-login", fields: [] }, create: () => { throw new Error("unused"); },
      }]),
      definitionStore: { async load() { return [definition]; } },
      credentialStore: {},
      initialRuntimes: new Map([[definition.id, { credentials: { login }, close: closeRuntime }]]),
      prepareRuntime: () => preparation,
    });

    const reconnecting = service.reconnect(definition.id);
    await new Promise((resolve) => setImmediate(resolve));
    let closed = false;
    const closing = service.close().then(() => { closed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    finishPreparation();

    await expect(reconnecting).rejects.toThrow("shutting down");
    await closing;
    expect(login).not.toHaveBeenCalled();
    expect(closeRuntime).toHaveBeenCalledOnce();
  });

  it("cleans a terminal reconnect account failure so the same definition can reconnect again", async () => {
    const definition = {
      id: "managed-work", adapterId: "fake-managed", label: "Work", endpoint: null,
      accessContract: "managed-runtime@1", credentialReference: null, lifecycleState: "active",
    };
    const failedRuntime = {
      credentials: {
        login: vi.fn(async () => ({ authUrl: "https://login.example.test/work" })),
        account: vi.fn(async () => { throw new Error("managed account check failed"); }),
      },
      close: vi.fn(async () => {}),
    };
    const replacementRuntime = {
      providerId: definition.id,
      credentials: {
        login: vi.fn(async () => ({ authUrl: "https://login.example.test/work" })),
        account: vi.fn(async () => ({ status: "connected" })),
      },
      discover: vi.fn(async () => ({
        provider: { id: definition.id, label: definition.label, status: "available" },
        models: [{ visible: true }],
        systemFamily: { id: definition.id, label: definition.label, modelIds: [] },
      })),
    };
    const create = vi.fn(() => replacementRuntime);
    const removed = vi.fn(async () => {});
    const service = new ProviderDefinitionService({
      registry: createProviderAdapterRegistry([{
        adapterId: "fake-managed", implementationVersion: "1", label: "Managed", accessContract: "managed-runtime@1",
        defaultEndpoint: null, connection: { mode: "managed-login", fields: [] }, create,
      }]),
      definitionStore: { async load() { return [definition]; } },
      credentialStore: {},
      initialRuntimes: new Map([[definition.id, failedRuntime]]),
      onRuntimeRemoved: removed,
      publishCatalog: vi.fn(async () => {}),
    });

    await expect(service.reconnect(definition.id)).resolves.toMatchObject({ status: "pending" });
    await expect(service.completeConnection(definition.id)).rejects.toThrow("managed account check failed");
    expect(failedRuntime.close).toHaveBeenCalledOnce();
    expect(removed).toHaveBeenCalledWith(expect.objectContaining({ id: definition.id }));

    await expect(service.reconnect(definition.id)).resolves.toMatchObject({
      status: "pending", connectionId: definition.id,
    });
    expect(create).toHaveBeenCalledOnce();
    await expect(service.completeConnection(definition.id)).resolves.toMatchObject({
      status: "connected", providerDefinition: { id: definition.id },
    });
  });

  it("logs out only the exact managed provider definition through the generic service", async () => {
    const accounts = new Map([["managed-work", "connected"], ["managed-personal", "connected"]]);
    const descriptor = {
      adapterId: "fake-managed", implementationVersion: "1", label: "Managed", accessContract: "managed-runtime@1",
      defaultEndpoint: null, connection: { mode: "managed-login", fields: [] },
      create: () => { throw new Error("initial runtimes should be reused"); },
    };
    const runtime = (id) => ({ credentials: {
      account: async () => ({ status: accounts.get(id) }),
      logout: async () => { accounts.set(id, "disconnected"); return { status: "disconnected" }; },
    } });
    const changed = [];
    const service = new ProviderDefinitionService({
      registry: createProviderAdapterRegistry([descriptor]),
      definitionStore: { async load() { return [
        { id: "managed-work", adapterId: "fake-managed", label: "Work", endpoint: null, accessContract: "managed-runtime@1", credentialReference: null, lifecycleState: "active" },
        { id: "managed-personal", adapterId: "fake-managed", label: "Personal", endpoint: null, accessContract: "managed-runtime@1", credentialReference: null, lifecycleState: "active" },
      ]; } },
      credentialStore: {},
      initialRuntimes: new Map([["managed-work", runtime("managed-work")], ["managed-personal", runtime("managed-personal")]]),
      onRuntimeChanged: async ({ id }) => { changed.push(id); },
    });

    await expect(service.logout("managed-work")).resolves.toMatchObject({ status: "disconnected" });
    expect(accounts).toEqual(new Map([["managed-work", "disconnected"], ["managed-personal", "connected"]]));
    expect(changed).toEqual(["managed-work"]);
  });

  it("reports a managed provider disconnected even when post-logout catalog publication fails", async () => {
    const descriptor = {
      adapterId: "fake-managed", implementationVersion: "1", label: "Managed", accessContract: "managed-runtime@1",
      defaultEndpoint: null, connection: { mode: "managed-login", fields: [] },
      create: () => { throw new Error("initial runtime should be reused"); },
    };
    const diagnostics = { write: vi.fn(async () => {}) };
    const service = new ProviderDefinitionService({
      registry: createProviderAdapterRegistry([descriptor]),
      definitionStore: { async load() { return [{
        id: "managed-work", adapterId: "fake-managed", label: "Work", endpoint: null,
        accessContract: "managed-runtime@1", credentialReference: null, lifecycleState: "active",
      }]; } },
      credentialStore: {},
      initialRuntimes: new Map([["managed-work", { credentials: {
        logout: async () => ({ status: "disconnected" }),
      } }]]),
      providerStatuses: async () => new Map([["managed-work", { connected: true, unavailableReason: null }]]),
      onRuntimeChanged: async () => { throw new Error("catalog publication unavailable"); },
      diagnostics,
    });

    await expect(service.logout("managed-work")).resolves.toEqual({ status: "disconnected" });
    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({
        id: "managed-work",
        connected: false,
        unavailableReason: expect.objectContaining({ code: "provider_logged_out" }),
      }),
    ]);
    expect(diagnostics.write).toHaveBeenCalledWith(expect.objectContaining({
      category: "provider_logout_catalog_refresh_failed",
      providerId: "managed-work",
    }));
  });

  it("refuses ambient subscription executable discovery", () => {
    expect(() => productionProviderAdapterRegistry.create({
      id: "codex-ambient", adapterId: "codex-subscription", label: "Codex", endpoint: null,
    }, { environment: { PATH: "/ambient/bin" }, managedRuntime: codexRuntime }))
      .toThrow("requires the provisioned managed runtime executable");
    expect(() => new ClaudeCliManagedRuntime({ environment: { PATH: "/ambient/bin" } }))
      .toThrow("managed runtime executable is required");
  });

  it("fails closed before handing out a revoked Codex managed runtime", async () => {
    const provider = productionProviderAdapterRegistry.create({
      id: "codex-revoked", adapterId: "codex-subscription", label: "Codex Revoked", endpoint: null,
    }, { environment: { PATH: "", RELAYER_CODEX_BINARY: codexRuntime.executable }, managedRuntime: codexRuntime });
    provider.credentials.account = async () => ({ status: "disconnected", account: null });
    await expect(provider.executionAccess()).rejects.toThrow("not connected");
  });

  it("hands subscription harnesses the exact provisioned runtime descriptor", async () => {
    const codexEnvironment = {
      CODEX_HOME: "/isolated/codex",
      RELAYER_CODEX_BINARY: codexRuntime.executable,
    };
    const codex = productionProviderAdapterRegistry.create({
      id: "codex-connected", adapterId: "codex-subscription", label: "Codex", endpoint: null,
    }, { environment: codexEnvironment, managedRuntime: codexRuntime });
    codex.credentials.account = async () => ({ status: "connected", account: {} });
    await expect(codex.executionAccess()).resolves.toEqual({
      kind: "managed-runtime", ...codexRuntime, environment: codexEnvironment,
    });

    const claudeEnvironment = { CLAUDE_CONFIG_DIR: "/isolated/claude" };
    const claude = productionProviderAdapterRegistry.create({
      id: "claude-connected", adapterId: "claude-subscription", label: "Claude", endpoint: null,
    }, {
      managedRuntime: claudeRuntime,
      runtimeFactory: async () => ({
        environment: claudeEnvironment,
        account: async () => ({ status: "connected", account: {} }),
        close: async () => {},
      }),
    });
    await expect(claude.executionAccess()).resolves.toEqual({
      kind: "managed-runtime", ...claudeRuntime, environment: claudeEnvironment,
    });
  });

  it("production Claude composition fails unavailable when its definition-scoped CLI is missing", async () => {
    const provider = productionProviderAdapterRegistry.create({
      id: "claude-missing", adapterId: "claude-subscription", label: "Claude Missing", endpoint: null,
    }, {
      executable: "/definitely/missing/relayer-claude",
      managedRuntime: { ...claudeRuntime, executable: "/definitely/missing/relayer-claude" },
    });
    await expect(provider.credentials.account()).resolves.toMatchObject({ status: "unavailable" });
    await expect(provider.credentials.login()).rejects.toThrow("login is unavailable");
    await expect(provider.executionAccess()).rejects.toThrow("not connected");
  });

  it("keeps Claude browser login pending when auth status returns logged-out JSON with exit code one", async () => {
    const spawnProcess = vi.fn(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      queueMicrotask(() => {
        child.stdout.emit("data", JSON.stringify({
          loggedIn: false,
          authMethod: "none",
          apiProvider: "firstParty",
        }));
        child.emit("exit", 1);
      });
      return child;
    });
    const runtime = new ClaudeCliManagedRuntime({ executable: "/bin/claude", spawnProcess });

    await expect(runtime.account()).resolves.toMatchObject({
      status: "disconnected",
      account: { loggedIn: false, authMethod: "none", apiProvider: "firstParty" },
    });
  });

  it("keeps multiple Claude definitions in definition-scoped runtimes", async () => {
    const accounts = new Map();
    const runtimeFactory = vi.fn(async (created) => {
      accounts.set(created.id, "connected");
      return {
        account: async () => ({ status: accounts.get(created.id) }),
        login: async () => { accounts.set(created.id, "connected"); },
        logout: async () => { accounts.set(created.id, "disconnected"); },
        close: async () => {},
      };
    });
    const dependencies = {
      runtimeFactory,
      discoverModels: async () => [{ id: "claude-model", label: "Claude model" }],
      managedRuntime: claudeRuntime,
    };
    const first = productionProviderAdapterRegistry.create({
      id: "claude-work", adapterId: "claude-subscription", label: "Claude Work", endpoint: null,
    }, dependencies);
    const second = productionProviderAdapterRegistry.create({
      id: "claude-personal", adapterId: "claude-subscription", label: "Claude Personal", endpoint: null,
    }, dependencies);

    await first.catalog.discover();
    await second.catalog.discover();
    await first.credentials.logout();

    expect(await first.credentials.account()).toMatchObject({ status: "disconnected" });
    expect(await second.credentials.account()).toMatchObject({ status: "connected" });
    expect(runtimeFactory.mock.calls.map(([created]) => created.id)).toEqual(["claude-work", "claude-personal"]);
  });
});

describe("retry and local diagnostics", () => {
  it("retries only transient classes with bounded deterministic jitter", async () => {
    const delays = [];
    const operation = vi.fn()
      .mockRejectedValueOnce(new ProviderHttpError("busy", { status: 429 }))
      .mockRejectedValueOnce(new ProviderHttpError("down", { status: 503 }))
      .mockResolvedValue("ok");
    await expect(withProviderRetry(operation, {
      random: () => 0.5,
      sleep: async (delay) => { delays.push(delay); },
    })).resolves.toBe("ok");
    expect(delays).toEqual([250, 500]);
    await expect(withProviderRetry(async () => {
      throw new ProviderHttpError("bad key", { status: 401 });
    }, { sleep: vi.fn() })).rejects.toThrow("bad key");
  });

  it("stops retry when cancelled", async () => {
    const controller = new AbortController();
    const sleep = vi.fn(async (_delay, signal) => {
      controller.abort(new Error("cancelled"));
      signal.throwIfAborted();
    });
    await expect(withProviderRetry(async () => {
      throw new ProviderHttpError("busy", { status: 429 });
    }, { signal: controller.signal, sleep })).rejects.toThrow("cancelled");
  });

  it("bounds and redacts the rotating diagnostic log", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-provider-log-"));
    const path = join(root, "provider.log");
    const log = createProviderDiagnosticsLog({ path, maximumBytes: 512 });
    for (let index = 0; index < 20; index += 1) {
      await log.write({ code: `failure-${index}`, apiKey: "sk-super-secret-value", message: "Bearer hidden-value" });
    }
    const contents = await readFile(path, "utf8");
    expect(Buffer.byteLength(contents)).toBeLessThanOrEqual(512);
    expect(contents).not.toContain("super-secret");
    expect(contents).not.toContain("hidden-value");
    expect(contents).toContain("failure-19");
  });

  it("serializes concurrent writes and never persists arbitrary error text", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-provider-log-concurrent-"));
    const path = join(root, "provider.log");
    const log = createProviderDiagnosticsLog({ path, maximumBytes: 16 * 1024 });
    await Promise.all(Array.from({ length: 40 }, (_, index) => log.write({
      code: `failure-${index}`,
      error: `opaque-private-value-${index}`,
    })));
    const contents = await readFile(path, "utf8");
    const events = contents.trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toHaveLength(40);
    expect(new Set(events.map(({ code }) => code)).size).toBe(40);
    expect(contents).not.toContain("opaque-private-value");
  });
});

describe("managed provider runtime cleanup", () => {
  it("derives cleanup eligibility from a registry descriptor instead of adapter names", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-provider-runtime-custom-"));
    await mkdir(join(root, "future-work"), { recursive: true });
    const registry = createProviderAdapterRegistry([{
      adapterId: "future-subscription", implementationVersion: "1", label: "Future",
      accessContract: "managed-runtime@1", defaultEndpoint: null,
      connection: { mode: "existing-runtime-auth", fields: [] }, create: () => ({}),
    }]);
    const removeRuntimeState = createProviderRuntimeStateRemover({ runtimeRoot: root, registry });
    await expect(removeRuntimeState({
      id: "future-work", adapterId: "future-subscription", accessContract: "managed-runtime@1",
    })).resolves.toBe(true);
    await expect(access(join(root, "future-work"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deletes only the exact definition-scoped directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-provider-runtime-"));
    const work = join(root, "claude-work");
    const personal = join(root, "claude-personal");
    await mkdir(join(work, "claude-home"), { recursive: true });
    await mkdir(join(personal, "claude-home"), { recursive: true });
    await writeFile(join(work, "claude-home", "auth.json"), "work");
    await writeFile(join(personal, "claude-home", "auth.json"), "personal");

    const removeRuntimeState = createProviderRuntimeStateRemover({
      runtimeRoot: root, registry: productionProviderAdapterRegistry,
    });
    await expect(removeRuntimeState({
      id: "claude-work", adapterId: "claude-subscription", accessContract: "managed-runtime@1",
    })).resolves.toBe(true);
    await expect(access(work)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(personal, "claude-home", "auth.json"), "utf8")).resolves.toBe("personal");
    await expect(removeRuntimeState({ id: "api", adapterId: "openai-api" })).resolves.toBe(false);
  });

  it("deletes definition-scoped runtime state for an API adapter after its definition is removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-provider-runtime-api-remove-"));
    await mkdir(join(root, "openai-work", "codex-home"), { recursive: true });
    const removeRuntimeState = createProviderRuntimeStateRemover({
      runtimeRoot: root,
      registry: productionProviderAdapterRegistry,
    });

    await expect(removeRuntimeState({
      id: "openai-work",
      adapterId: "openai-api",
      accessContract: "secret@1",
    })).resolves.toBe(true);
    await expect(access(join(root, "openai-work"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects traversal and non-definition paths", () => {
    expect(() => providerRuntimeDirectory("/tmp/provider-runtimes", {
      id: "../escape", adapterId: "codex-subscription",
      accessContract: "managed-runtime@1",
    }, productionProviderAdapterRegistry)).toThrow("stable provider definition id");
    expect(() => providerRuntimeDirectory("/tmp/provider-runtimes", {
      id: "/absolute", adapterId: "claude-subscription",
      accessContract: "managed-runtime@1",
    }, productionProviderAdapterRegistry)).toThrow("stable provider definition id");
  });

  it("reconciles crash-orphan directories while retaining active managed definitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-provider-runtime-reconcile-"));
    for (const name of ["codex-active", "openai-active", "claude-orphan", "api-artifact"]) {
      await mkdir(join(root, name), { recursive: true });
      await writeFile(join(root, name, "state"), name);
    }
    const removeRuntimeState = createProviderRuntimeStateRemover({
      runtimeRoot: root, registry: productionProviderAdapterRegistry,
    });
    await expect(removeRuntimeState.reconcile([
      {
        id: "codex-active", adapterId: "codex-subscription", accessContract: "managed-runtime@1",
        lifecycleState: "active",
      },
      {
        id: "openai-active", adapterId: "openai-api", accessContract: "secret@1",
        lifecycleState: "active",
      },
    ])).resolves.toEqual(["api-artifact", "claude-orphan"]);
    await expect(readFile(join(root, "codex-active", "state"), "utf8")).resolves.toBe("codex-active");
    await expect(readFile(join(root, "openai-active", "state"), "utf8")).resolves.toBe("openai-active");
    await expect(access(join(root, "claude-orphan"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(root, "api-artifact"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("provider definition lifecycle", () => {
  function serviceFixture({
    failDiscovery = false,
    failDiscoveryEndpoint = null,
    diagnostics = null,
    removeRuntimeState = async () => false,
    setTimer,
    clearTimer,
  } = {}) {
    let stored = [];
    const credentials = new Map();
    const closes = [];
    const descriptor = {
      adapterId: "fake-api", implementationVersion: "1", label: "Fake", accessContract: "secret@1",
      defaultEndpoint: "https://example.test/v1", endpointEditableDuringCreation: true,
      connection: { mode: "secret-fields", fields: [{ id: "api-key", label: "API key", kind: "secret" }] },
      create: ({ definition: created }) => ({
        async discover() {
          if (failDiscovery || created.endpoint === failDiscoveryEndpoint) throw new Error("discovery failed");
          return { models: [{ visible: true }], provider: { id: created.id } };
        },
        async close() { closes.push(created.id); },
      }),
    };
    const service = new ProviderDefinitionService({
      registry: createProviderAdapterRegistry([descriptor]),
      definitionStore: {
        async load() { return structuredClone(stored); },
        async save(value) { stored = structuredClone(value); },
        async createWithCatalog(candidate) { stored.push(structuredClone(candidate)); },
      },
      credentialStore: {
        async set(key, value) { credentials.set(key, structuredClone(value)); },
        async get(key) { return credentials.get(key) ?? null; },
        async delete(key) { return credentials.delete(key); },
      },
      idGenerator: (() => { let id = 0; return () => `provider-${++id}`; })(),
      diagnostics,
      removeRuntimeState,
      ...(setTimer ? { setTimer } : {}),
      ...(clearTimer ? { clearTimer } : {}),
    });
    return { service, definitions: () => stored, credentials, closes };
  }

  it("persists only after discovery and stores a credential reference instead of secret bytes", async () => {
    const fixture = serviceFixture({ failDiscoveryEndpoint: "https://broken.example/v1" });
    const created = await fixture.service.connect({
      adapterId: "fake-api", label: "Work", endpoint: "https://example.test/v1", fields: { "api-key": "secret" },
    });
    expect(created).toMatchObject({ status: "connected", providerDefinition: { id: "provider-1" } });
    expect(JSON.stringify(fixture.definitions())).not.toContain('"api-key":"secret"');
    expect(created.providerDefinition.credentialReference).toBe("provider:provider-1");

    const failed = serviceFixture({ failDiscovery: true });
    await expect(failed.service.connect({
      adapterId: "fake-api", label: "Broken", fields: { "api-key": "secret" },
    })).rejects.toThrow("discovery failed");
    expect(failed.definitions()).toEqual([]);
    expect(failed.credentials.size).toBe(0);
  });

  it("writes credentials only after discovery and removes them when the atomic product commit fails", async () => {
    const order = [];
    const deleted = [];
    const descriptor = {
      adapterId: "ordered-api", implementationVersion: "1", label: "Ordered", accessContract: "secret@1",
      defaultEndpoint: "https://example.test/v1", connection: {
        mode: "secret-fields", fields: [{ id: "key", label: "Key", kind: "secret" }],
      },
      create: () => ({ discover: async () => {
        order.push("discover");
        return { models: [{ visible: true }] };
      } }),
    };
    const service = new ProviderDefinitionService({
      registry: createProviderAdapterRegistry([descriptor]),
      definitionStore: {
        async load() { return []; },
        async createWithCatalog() { order.push("commit"); throw new Error("commit failed"); },
      },
      credentialStore: {
        async set(reference) { order.push("credential"); expect(reference).toBe("provider:ordered"); },
        async delete(reference) { deleted.push(reference); },
      },
      idGenerator: () => "ordered",
    });
    await expect(service.connect({ adapterId: "ordered-api", label: "Ordered", fields: { key: "opaque" } }))
      .rejects.toThrow("commit failed");
    expect(order).toEqual(["discover", "credential", "commit"]);
    expect(deleted).toEqual(["provider:ordered"]);
    await expect(service.list()).resolves.toEqual([]);
  });

  it("compensates runtime registration before a failed staged create and leaves no active definition", async () => {
    const fixture = serviceFixture({ failDiscoveryEndpoint: "https://broken.example/v1" });
    const unregistered = [];
    fixture.service.onRuntimeReady = async () => { throw new Error("runtime registration failed"); };
    fixture.service.onRuntimeRemoved = async ({ id }) => { unregistered.push(id); };
    await expect(fixture.service.connect({
      adapterId: "fake-api", label: "Broken registration", fields: { "api-key": "opaque" },
    })).rejects.toThrow("runtime registration failed");
    expect(fixture.definitions()).toEqual([]);
    expect(fixture.credentials.size).toBe(0);
    expect(fixture.closes).toEqual(["provider-1"]);
    expect(unregistered).toEqual(["provider-1"]);
  });

  it("joins authoritative connection state into generic provider listings", async () => {
    const fixture = serviceFixture();
    const created = await fixture.service.connect({
      adapterId: "fake-api", label: "Revoked", fields: { "api-key": "opaque" },
    });
    fixture.service.providerStatuses = async () => new Map([[created.providerDefinition.id, {
      connected: false,
      unavailableReason: { code: "credentials_revoked", message: "Reconnect this provider." },
    }]]);
    await expect(fixture.service.list()).resolves.toEqual([expect.objectContaining({
      id: created.providerDefinition.id,
      connected: false,
      unavailableReason: { code: "credentials_revoked", message: "Reconnect this provider." },
    })]);
  });

  it("validates and atomically edits an API connection without replacing its identity or active lease", async () => {
    let stored = [{
      id: "stable-api", adapterId: "editable-api", label: "Work", endpoint: "https://old.example/v1",
      accessContract: "secret@1", credentialReference: "provider:stable-api", lifecycleState: "active", removedAt: null,
    }];
    let savedSecrets = { key: "old-key" };
    const runtimes = [];
    const store = {
      async load() { return structuredClone(stored); },
      async updateWithCatalog(definition, catalog) {
        expect(catalog.models).toEqual([{ visible: true }]);
        stored = [structuredClone(definition)];
      },
    };
    const service = new ProviderDefinitionService({
      registry: createProviderAdapterRegistry([{
        adapterId: "editable-api", implementationVersion: "1", label: "Editable", accessContract: "secret@1",
        defaultEndpoint: "https://old.example/v1", endpointEditableDuringCreation: true,
        connection: { mode: "secret-fields", fields: [{ id: "key", label: "API key", kind: "secret" }] },
        create: ({ definition, secrets }) => {
          const runtime = {
            endpoint: definition.endpoint, secrets: structuredClone(secrets),
            discover: vi.fn(async () => ({ models: [{ visible: true }] })),
            close: vi.fn(async () => {}),
          };
          runtimes.push(runtime);
          return runtime;
        },
      }]),
      definitionStore: store,
      credentialStore: {
        async get() { return structuredClone(savedSecrets); },
        async set(_reference, value) { savedSecrets = structuredClone(value); },
        async delete() {},
      },
    });

    const oldLease = await service.acquireExecution("stable-api");
    await expect(service.edit("stable-api", {
      endpoint: "https://new.example/v1", fields: {},
    })).resolves.toMatchObject({ id: "stable-api", endpoint: "https://new.example/v1" });
    const newLease = await service.acquireExecution("stable-api");
    expect(oldLease.runtime.endpoint).toBe("https://old.example/v1");
    expect(newLease.runtime.endpoint).toBe("https://new.example/v1");
    expect(newLease.runtime.secrets).toEqual({ key: "old-key" });
    expect(stored[0].id).toBe("stable-api");
    await oldLease.release();
    expect(oldLease.runtime.close).toHaveBeenCalledOnce();
    await newLease.release();
  });

  it("leaves saved API configuration, credentials, catalog, and runtime unchanged when edit validation fails", async () => {
    const fixture = serviceFixture({ failDiscoveryEndpoint: "https://broken.example/v1" });
    const created = await fixture.service.connect({
      adapterId: "fake-api", label: "Stable", endpoint: "https://example.test/v1", fields: { "api-key": "old" },
    });
    await expect(fixture.service.edit(created.providerDefinition.id, {
      endpoint: "https://broken.example/v1", fields: { "api-key": "replacement" },
    })).rejects.toThrow("discovery failed");
    await expect(fixture.service.list()).resolves.toEqual([
      expect.objectContaining({ id: created.providerDefinition.id, endpoint: "https://example.test/v1" }),
    ]);
    expect(fixture.credentials.get(`provider:${created.providerDefinition.id}`)).toEqual({ "api-key": "old" });
  });

  it("retries the saved connection in place and publishes only a broad outage state", async () => {
    const fixture = serviceFixture();
    const created = await fixture.service.connect({
      adapterId: "fake-api", label: "Stable", endpoint: "https://example.test/v1", fields: { "api-key": "old" },
    });
    const runtime = fixture.service.runtimes.get(created.providerDefinition.id);
    runtime.discover = async () => { throw Object.assign(new Error("raw upstream body"), { status: 503 }); };

    await expect(fixture.service.retryConnection(created.providerDefinition.id)).resolves.toMatchObject({
      status: "provider_temporarily_unavailable",
      providerDefinition: { id: created.providerDefinition.id },
    });
    await expect(fixture.service.list()).resolves.toEqual([
      expect.objectContaining({
        id: created.providerDefinition.id,
        connected: false,
        unavailableReason: {
          code: "provider_temporarily_unavailable",
          message: "Provider could not be reached",
        },
      }),
    ]);
    expect(fixture.credentials.get(`provider:${created.providerDefinition.id}`)).toEqual({ "api-key": "old" });
  });

  it("logs only sanitized failure metadata and cleans orphaned crash-window credentials", async () => {
    const events = [];
    const failed = serviceFixture({
      failDiscovery: true,
      diagnostics: { write: async (event) => { events.push(event); } },
    });
    await expect(failed.service.connect({ adapterId: "fake-api", label: "Broken", fields: { key: "opaque" } }))
      .rejects.toThrow("discovery failed");
    expect(JSON.stringify(events)).not.toContain("discovery failed");
    expect(events[0]).toMatchObject({ category: "provider_connection_failed", code: "unknown" });

    const deleted = [];
    const restarted = new ProviderDefinitionService({
      registry: failed.service.registry,
      definitionStore: { async load() { return []; } },
      credentialStore: {
        async listReferences() { return ["provider:orphan"]; },
        async delete(reference) { deleted.push(reference); },
      },
    });
    await restarted.reconcileStartup();
    expect(deleted).toEqual(["provider:orphan"]);
  });

  it("uses bounded retry during staged catalog discovery without retrying auth failures", async () => {
    let attempts = 0;
    const delays = [];
    let stored = [];
    const descriptor = {
      adapterId: "retry-api", implementationVersion: "1", label: "Retry", accessContract: "secret@1",
      defaultEndpoint: "https://example.test/v1", connection: { mode: "secret-fields", fields: [{ id: "key", label: "Key", kind: "secret" }] },
      create: () => ({ discover: async () => {
        attempts += 1;
        if (attempts < 3) throw new ProviderHttpError("busy", { status: 503 });
        return { models: [{ visible: true }] };
      } }),
    };
    const service = new ProviderDefinitionService({
      registry: createProviderAdapterRegistry([descriptor]),
      definitionStore: { async load() { return stored; }, async save(value) { stored = structuredClone(value); } },
      credentialStore: { async set() {}, async delete() {}, async get() { return {}; } },
      retry: { random: () => 0.5, sleep: async (delay) => { delays.push(delay); } },
      idGenerator: () => "retry-provider",
    });
    await expect(service.connect({ adapterId: "retry-api", label: "Retry", fields: { key: "hidden" } }))
      .resolves.toMatchObject({ status: "connected" });
    expect(attempts).toBe(3);
    expect(delays).toEqual([250, 500]);
  });

  it("enforces active label uniqueness and drains admitted work before tombstoning", async () => {
    const removals = [];
    const fixture = serviceFixture({ removeRuntimeState: async (candidate) => { removals.push(candidate.id); } });
    const first = await fixture.service.connect({ adapterId: "fake-api", label: "Work", fields: { "api-key": "one" } });
    await expect(fixture.service.connect({ adapterId: "fake-api", label: "work", fields: { "api-key": "two" } }))
      .rejects.toThrow("already uses");
    const providerId = first.providerDefinition.id;
    const admission = await fixture.service.acquireExecution(providerId);
    const pending = await fixture.service.remove(providerId);
    expect(pending.lifecycleState).toBe("removal_pending");
    await expect(fixture.service.acquireExecution(providerId)).rejects.toThrow("unavailable");
    expect(fixture.credentials.size).toBe(1);
    expect(removals).toEqual([]);
    await admission.release();
    expect(fixture.definitions()[0]).toMatchObject({ lifecycleState: "tombstoned", credentialReference: null });
    expect(fixture.credentials.size).toBe(0);
    expect(removals).toEqual([providerId]);
  });

  it("keeps removal pending after final tombstone persistence fails and reconciles cleanup on restart", async () => {
    const removals = [];
    const fixture = serviceFixture({ removeRuntimeState: async ({ id }) => { removals.push(id); } });
    const created = await fixture.service.connect({
      adapterId: "fake-api", label: "Durable", fields: { "api-key": "opaque" },
    });
    const originalSave = fixture.service.definitionStore.save.bind(fixture.service.definitionStore);
    fixture.service.definitionStore.save = async (definitions) => {
      if (definitions.some(({ lifecycleState }) => lifecycleState === "tombstoned")) {
        throw new Error("durable attempt still running");
      }
      await originalSave(definitions);
    };

    await expect(fixture.service.remove(created.providerDefinition.id)).resolves.toMatchObject({
      lifecycleState: "removal_pending",
    });
    expect(fixture.definitions()[0]).toMatchObject({
      lifecycleState: "removal_pending", credentialReference: `provider:${created.providerDefinition.id}`,
    });
    expect(fixture.credentials.size).toBe(0);
    expect(fixture.closes).toEqual([created.providerDefinition.id]);
    expect(removals).toEqual([created.providerDefinition.id]);
    await fixture.service.close();

    const restarted = new ProviderDefinitionService({
      registry: fixture.service.registry,
      definitionStore: {
        async load() { return structuredClone(fixture.definitions()); },
        async save(value) { fixture.definitions().splice(0, Infinity, ...structuredClone(value)); },
      },
      credentialStore: {
        async get(key) { return fixture.credentials.get(key) ?? null; },
        async delete(key) { return fixture.credentials.delete(key); },
        async listReferences() { return [...fixture.credentials.keys()]; },
      },
      removeRuntimeState: async ({ id }) => { removals.push(id); },
    });
    await restarted.reconcileStartup();
    expect(fixture.definitions()[0]).toMatchObject({ lifecycleState: "tombstoned", credentialReference: null });
    expect(fixture.credentials.size).toBe(0);
    expect(removals).toEqual([created.providerDefinition.id, created.providerDefinition.id]);
  });

  it("keeps cleanup failures removing and retries them automatically", async () => {
    let retryCleanup;
    let cleanupAttempts = 0;
    const fixture = serviceFixture({
      removeRuntimeState: async () => {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) throw new Error("private cleanup detail");
      },
      setTimer(callback, delay) {
        expect(delay).toBe(5_000);
        retryCleanup = callback;
        return { unref() {} };
      },
      clearTimer() {},
    });
    const created = await fixture.service.connect({
      adapterId: "fake-api", label: "Cleanup", fields: { "api-key": "opaque" },
    });

    await expect(fixture.service.remove(created.providerDefinition.id)).resolves.toMatchObject({
      lifecycleState: "removal_pending",
    });
    expect(retryCleanup).toBeTypeOf("function");
    retryCleanup();
    await vi.waitFor(() => {
      expect(fixture.definitions()[0]).toMatchObject({ lifecycleState: "tombstoned", credentialReference: null });
    });
    expect(cleanupAttempts).toBe(2);
  });

  it("rolls back cached rename and removal state when authoritative persistence rejects", async () => {
    const fixture = serviceFixture();
    const created = await fixture.service.connect({
      adapterId: "fake-api", label: "Stable", fields: { "api-key": "one" },
    });
    fixture.service.definitionStore.save = async () => { throw new Error("authoritative guard rejected"); };
    await expect(fixture.service.rename(created.providerDefinition.id, "Changed"))
      .rejects.toThrow("authoritative guard rejected");
    await expect(fixture.service.remove(created.providerDefinition.id))
      .rejects.toThrow("authoritative guard rejected");
    await expect(fixture.service.list()).resolves.toEqual([
      expect.objectContaining({ label: "Stable", lifecycleState: "active" }),
    ]);
    const lease = await fixture.service.acquireExecution(created.providerDefinition.id);
    await lease.release();
  });

  it("completes or cancels managed login without persisting pending setup", async () => {
    let accountStatus = "disconnected";
    let stored = [];
    const close = vi.fn(async () => {});
    const registry = createProviderAdapterRegistry([{
      adapterId: "fake-managed", implementationVersion: "1", label: "Managed",
      accessContract: "managed-runtime@1", defaultEndpoint: null,
      connection: { mode: "managed-login", fields: [] },
      create: ({ definition: created }) => ({
        credentials: {
          login: async () => ({ loginId: "login-1", authUrl: "https://login.example.test" }),
          account: async () => ({ status: accountStatus }),
        },
        catalog: { discover: async () => ({ provider: { id: created.id }, models: [{ visible: true }] }) },
        close,
      }),
    }]);
    const removals = [];
    const service = new ProviderDefinitionService({
      registry,
      definitionStore: { async load() { return structuredClone(stored); }, async save(value) { stored = structuredClone(value); } },
      credentialStore: { async set() {}, async get() { return {}; }, async delete() {} },
      idGenerator: (() => { let id = 0; return () => `managed-${++id}`; })(),
      removeRuntimeState: async (candidate) => { removals.push(candidate.id); },
    });
    const pending = await service.connect({ adapterId: "fake-managed", label: "Managed Work" });
    expect(pending).toMatchObject({ status: "pending", connectionId: "managed-1", login: { loginId: "login-1" } });
    expect(stored).toEqual([]);
    await expect(service.completeConnection(pending.connectionId)).resolves.toMatchObject({ status: "pending" });
    accountStatus = "connected";
    await expect(service.completeConnection(pending.connectionId)).resolves.toMatchObject({
      status: "connected", providerDefinition: { id: "managed-1" },
    });
    expect(stored).toHaveLength(1);

    const cancelled = await service.connect({ adapterId: "fake-managed", label: "Managed Personal" });
    expect(await service.cancelConnection(cancelled.connectionId)).toBe(true);
    expect(stored).toHaveLength(1);
    expect(close).toHaveBeenCalledOnce();
    expect(removals).toEqual(["managed-2"]);
  });

  it("serializes cancellation behind managed discovery so it cannot delete a committed runtime", async () => {
    let releaseDiscovery;
    const discoveryGate = new Promise((resolve) => { releaseDiscovery = resolve; });
    let stored = [];
    const close = vi.fn(async () => {});
    const service = new ProviderDefinitionService({
      registry: createProviderAdapterRegistry([{
        adapterId: "racing-managed", implementationVersion: "1", label: "Managed",
        accessContract: "managed-runtime@1", defaultEndpoint: null,
        connection: { mode: "managed-login", fields: [] },
        create: ({ definition: created }) => ({
          credentials: {
            login: async () => ({ loginId: "login-race" }),
            account: async () => ({ status: "connected" }),
          },
          catalog: { discover: async () => {
            await discoveryGate;
            return { provider: { id: created.id }, models: [{ visible: true }] };
          } },
          close,
        }),
      }]),
      definitionStore: {
        async load() { return structuredClone(stored); },
        async createWithCatalog(candidate) { stored.push(structuredClone(candidate)); },
      },
      credentialStore: { async delete() {} },
      idGenerator: () => "managed-race",
    });
    const pending = await service.connect({ adapterId: "racing-managed", label: "Race" });
    const completion = service.completeConnection(pending.connectionId);
    const cancellation = service.cancelConnection(pending.connectionId);
    releaseDiscovery();
    await expect(completion).resolves.toMatchObject({ status: "connected" });
    await expect(cancellation).resolves.toBe(false);
    expect(stored).toHaveLength(1);
    expect(close).not.toHaveBeenCalled();
  });

  it("does not persist or destroy credentials after managed runtime registration fails", async () => {
    let stored = [];
    const removed = [];
    const closed = vi.fn(async () => {});
    const service = new ProviderDefinitionService({
      registry: createProviderAdapterRegistry([{
        adapterId: "failed-managed", implementationVersion: "1", label: "Managed",
        accessContract: "managed-runtime@1", defaultEndpoint: null,
        connection: { mode: "managed-login", fields: [] },
        create: ({ definition: created }) => ({
          credentials: {
            login: async () => ({ loginId: "login-failed" }),
            account: async () => ({ status: "connected" }),
          },
          catalog: { discover: async () => ({
            provider: { id: created.id }, models: [{ visible: true }],
          }) },
          close: closed,
        }),
      }]),
      definitionStore: {
        async load() { return structuredClone(stored); },
        async createWithCatalog(candidate) { stored.push(structuredClone(candidate)); },
      },
      credentialStore: { async delete() {} },
      idGenerator: () => "managed-failed",
      onRuntimeReady: async () => { throw new Error("registration failed"); },
      onRuntimeRemoved: async ({ id }) => { removed.push(id); },
    });
    const pending = await service.connect({ adapterId: "failed-managed", label: "Failed" });
    await expect(service.completeConnection(pending.connectionId)).rejects.toThrow("registration failed");
    expect(stored).toEqual([]);
    expect(closed).toHaveBeenCalledOnce();
    expect(removed).toEqual(["managed-failed"]);
  });

  it("finalizes removal-pending definitions on startup", async () => {
    const fixture = serviceFixture();
    await fixture.service.connect({ adapterId: "fake-api", label: "Old", fields: { "api-key": "secret" } });
    fixture.definitions()[0].lifecycleState = "removal_pending";
    const removals = [];
    const restarted = new ProviderDefinitionService({
      registry: fixture.service.registry,
      definitionStore: {
        async load() { return structuredClone(fixture.definitions()); },
        async save(value) { fixture.definitions().splice(0, Infinity, ...structuredClone(value)); },
      },
      credentialStore: {
        async get(key) { return fixture.credentials.get(key) ?? null; },
        async delete(key) { return fixture.credentials.delete(key); },
      },
      removeRuntimeState: async (candidate) => { removals.push(candidate.id); },
    });
    await restarted.reconcileStartup();
    expect(fixture.definitions()[0]).toMatchObject({ lifecycleState: "tombstoned", credentialReference: null });
    expect(fixture.credentials.size).toBe(0);
    expect(removals).toEqual(["provider-1"]);
  });

  it("registers persisted providers before startup refresh and supports manual refresh", async () => {
    let discoveries = 0;
    const snapshot = (providerId) => ({
      provider: { id: providerId, label: providerId, adapterId: "fake-api", status: "available" },
      fetchedAt: new Date().toISOString(),
      models: [{
        id: "model-1", label: "Model 1", description: "", visible: true, executionModel: "model-1",
        availability: "available", unavailableReason: null, availabilityNotice: null, isDefault: false,
        replacementModelId: null, upgradeInfo: null, supportedEfforts: [], defaultEffort: null,
        inputModalities: ["text"], supportsPersonality: false, serviceTiers: [], defaultServiceTier: null,
      }],
      systemFamily: { id: `${providerId}-default`, label: "Default", modelIds: [] },
    });
    const registry = createProviderAdapterRegistry([{
      adapterId: "fake-api", implementationVersion: "1", label: "Fake", accessContract: "secret@1",
      defaultEndpoint: "https://example.test/v1", connection: {
        mode: "secret-fields", fields: [{ id: "key", label: "Key", kind: "secret" }],
      },
      create: ({ definition: created }) => ({
        providerId: created.id,
        discover: async () => { discoveries += 1; return snapshot(created.id); },
      }),
    }]);
    const published = [];
    const seed = { providerId: "seed", discover: async () => snapshot("seed") };
    const modelCatalog = new ModelCatalogService({ adapters: [seed], publishSnapshot: async (value) => { published.push(value); } });
    const service = new ProviderDefinitionService({
      registry,
      definitionStore: { async load() { return [{
        id: "persisted", adapterId: "fake-api", label: "Persisted", endpoint: "https://example.test/v1",
        accessContract: "secret@1", credentialReference: "provider:persisted", lifecycleState: "active", removedAt: null,
      }]; } },
      credentialStore: { async get() { return { key: "opaque" }; } },
      onRuntimeReady: (_definition, runtime) => modelCatalog.register(runtime.catalog ?? runtime),
      onRuntimeRemoved: (definition) => modelCatalog.unregister(definition.id),
    });
    await service.activate();
    await modelCatalog.startup();
    expect(discoveries).toBe(1);
    expect(published.some(({ providerId }) => providerId === "persisted")).toBe(true);
    await modelCatalog.explicitRefresh("persisted");
    expect(discoveries).toBe(2);
  });

  it("continues activation when one persisted provider has revoked credentials", async () => {
    const ready = [];
    const diagnostics = [];
    const registry = createProviderAdapterRegistry([{
      adapterId: "fake-api", implementationVersion: "1", label: "Fake", accessContract: "secret@1",
      defaultEndpoint: "https://example.test/v1", connection: {
        mode: "secret-fields", fields: [{ id: "key", label: "Key", kind: "secret" }],
      },
      create: ({ definition: created }) => ({ providerId: created.id, discover: async () => ({}) }),
    }]);
    const persisted = ["revoked", "healthy"].map((id) => ({
      id, adapterId: "fake-api", label: id, endpoint: "https://example.test/v1", accessContract: "secret@1",
      credentialReference: `provider:${id}`, lifecycleState: "active", removedAt: null,
    }));
    const service = new ProviderDefinitionService({
      registry,
      definitionStore: { async load() { return persisted; } },
      credentialStore: { async get(reference) { return reference.endsWith("healthy") ? { key: "valid" } : null; } },
      diagnostics: { write: async (event) => { diagnostics.push(event); } },
      onRuntimeReady: (definition) => { ready.push(definition.id); },
    });
    await expect(service.activate()).resolves.toBeUndefined();
    expect(ready).toEqual(["healthy"]);
    expect(diagnostics).toEqual([expect.objectContaining({
      category: "provider_activation_failed", providerId: "revoked", code: "unknown",
    })]);
    await expect(service.acquireExecution("revoked")).rejects.toThrow("credentials are unavailable");
  });

  it("marks a persisted provider unavailable when startup activation cannot load its credential", async () => {
    const unavailable = [];
    const descriptor = {
      adapterId: "fake-api", implementationVersion: "1", label: "Fake", accessContract: "secret@1",
      defaultEndpoint: "https://example.test/v1", connection: {
        mode: "secret-fields", fields: [{ id: "key", label: "Key", kind: "secret" }],
      },
      create: vi.fn(),
    };
    const service = new ProviderDefinitionService({
      registry: createProviderAdapterRegistry([descriptor]),
      definitionStore: { async load() { return [{
        id: "missing", adapterId: "fake-api", label: "Missing", endpoint: "https://example.test/v1",
        accessContract: "secret@1", credentialReference: "provider:missing", lifecycleState: "active",
      }]; } },
      credentialStore: { async get() { return null; } },
      providerStatuses: async () => new Map([["missing", { connected: true, unavailableReason: null }]]),
      onRuntimeUnavailable: async (definition, error) => { unavailable.push({ definition, error }); },
    });

    await service.activate();
    expect(descriptor.create).not.toHaveBeenCalled();
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0].definition.id).toBe("missing");
    expect(unavailable[0].error.message).toContain("credentials are unavailable");
    await expect(service.list()).resolves.toEqual([expect.objectContaining({
      id: "missing",
      connected: false,
      unavailableReason: expect.objectContaining({ code: "provider_activation_failed" }),
    })]);
  });

  it("does not cache a lazy runtime whose catalog registration failed", async () => {
    const closed = [];
    let creations = 0;
    let registrations = 0;
    const registry = createProviderAdapterRegistry([{
      adapterId: "lazy-api", implementationVersion: "1", label: "Lazy", accessContract: "secret@1",
      defaultEndpoint: "https://example.test/v1", connection: {
        mode: "secret-fields", fields: [{ id: "key", label: "Key", kind: "secret" }],
      },
      create: () => {
        creations += 1;
        const generation = creations;
        return { close: async () => { closed.push(generation); } };
      },
    }]);
    const service = new ProviderDefinitionService({
      registry,
      definitionStore: { async load() { return [{
        id: "lazy", adapterId: "lazy-api", label: "Lazy", endpoint: "https://example.test/v1",
        accessContract: "secret@1", credentialReference: "provider:lazy", lifecycleState: "active",
      }]; } },
      credentialStore: { async get() { return { key: "opaque" }; } },
      onRuntimeReady: async () => {
        registrations += 1;
        if (registrations === 1) throw new Error("registration failed");
      },
    });
    await service.activate();
    expect(closed).toEqual([1]);
    const lease = await service.acquireExecution("lazy");
    expect(creations).toBe(2);
    expect(registrations).toBe(2);
    await lease.release();
  });
});

describe("background model catalog refresh", () => {
  function completeSnapshot(providerId) {
    return {
      provider: { id: providerId, label: providerId, status: "available", unavailableReason: null },
      models: [{
        id: "model-1", label: "Model 1", description: "", visible: true, executionModel: "model-1",
        availability: "available", unavailableReason: null, availabilityNotice: null, isDefault: false,
        replacementModelId: null, upgradeInfo: null, supportedEfforts: [], defaultEffort: null,
        inputModalities: ["text"], supportsPersonality: false, serviceTiers: [], defaultServiceTier: null,
      }],
      systemFamily: { id: `${providerId}-default`, label: "Default", modelIds: [] },
    };
  }

  it("boots best-effort with a revoked provider and refreshes healthy providers", async () => {
    const published = [];
    const service = new ModelCatalogService({
      adapters: [
        { providerId: "revoked", discover: async () => { throw new ProviderHttpError("revoked", { status: 401 }); } },
        { providerId: "healthy", discover: async () => completeSnapshot("healthy") },
      ],
      publishSnapshot: async (snapshot) => { published.push(snapshot); },
      setTimer: () => ({ unref() {} }),
    });
    const results = await service.startup();
    expect(results.map(({ status }) => status)).toEqual(["rejected", "fulfilled"]);
    expect(published.map(({ providerId }) => providerId)).toEqual(["healthy"]);
    await service.close();
  });

  it("uses an unref non-overlapping timer, retains the last snapshot on failure, and cancels on close", async () => {
    const callbacks = [];
    const cleared = [];
    const unref = vi.fn();
    let calls = 0;
    let rejectBackground;
    const backgroundFailure = new Promise((_resolve, reject) => { rejectBackground = reject; });
    const published = [];
    const service = new ModelCatalogService({
      adapters: [{ providerId: "scheduled", discover: async () => {
        calls += 1;
        if (calls === 1) return completeSnapshot("scheduled");
        return backgroundFailure;
      } }],
      publishSnapshot: async (snapshot) => { published.push(snapshot); },
      setTimer: (callback) => { const token = { callback, unref }; callbacks.push(token); return token; },
      clearTimer: (token) => { cleared.push(token); },
      backgroundIntervalMs: 10,
    });
    await service.startup();
    expect(unref).toHaveBeenCalledOnce();
    const tick = callbacks[0].callback();
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toBe(2);
    expect(callbacks).toHaveLength(1);
    rejectBackground(new Error("temporarily unavailable"));
    await tick;
    expect(published).toHaveLength(1);
    expect(callbacks).toHaveLength(2);
    await service.close();
    expect(cleared).toEqual([callbacks[1]]);
  });
});
