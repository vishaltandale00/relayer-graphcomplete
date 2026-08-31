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
  it("validates the authoritative registry and rejects malformed or duplicate descriptors", async () => {
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
    const descriptor = {
      adapterId: "fake", implementationVersion: "1", label: "Fake", accessContract: "secret@1",
      defaultEndpoint: "https://example.test/v1", endpointEditableDuringCreation: true,
      connection: { mode: "secret-fields", fields: [{ id: "key", label: "Key", kind: "secret" }] },
      create() {},
    };
    expect(() => createProviderAdapterRegistry([descriptor, descriptor])).toThrow("Duplicate provider adapter");
    expect(() => createProviderAdapterRegistry([{ ...descriptor, implementationVersion: "v1" }])).toThrow("positive integer");
  });

  it("routes every managed adapter through its explicit runtime environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-provider-dependencies-"));
    const routed = await Promise.allSettled(expectedAdapters.map(async (adapterId) => {
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
      return [adapterId, {
        managedRuntime: dependencies.managedRuntime,
        environment: dependencies.environment,
      }];
    }));
    const rejected = await Promise.allSettled([
      productionProviderRuntimeDependencies({ id: "openai-work", adapterId: "openai-api" }, {
        runtimeRoot: root, environment: {}, codexBinary: "/ambient/codex",
      }),
      productionProviderRuntimeDependencies({ id: "claude-work", adapterId: "claude-subscription" }, {
        runtimeRoot: root, environment: {}, managedRuntime: codexRuntime,
      }),
    ]);
    const windowsDependencies = await productionProviderRuntimeDependencies({
      id: "claude-work", adapterId: "claude-subscription",
    }, {
      runtimeRoot: root,
      managedRuntime: claudeRuntime,
      platform: "win32",
      environment: { PATH: "C:\\ambiguous\\bin", Path: "C:\\Windows\\System32;C:\\Program Files\\nodejs" },
    });
    let spawnedEnvironment;
    const runtime = new ClaudeCliManagedRuntime({
      environment: windowsDependencies.environment,
      executable: windowsDependencies.executable,
      spawnProcess: (...args) => {
        spawnedEnvironment = args[2].env;
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = vi.fn();
        queueMicrotask(() => {
          child.stdout.emit("data", JSON.stringify({ loggedIn: true }));
          child.emit("exit", 0);
        });
        return child;
      },
    });
    const account = await runtime.account();
    const observed = Object.fromEntries(routed.map((result, index) => (
      result.status === "fulfilled" ? result.value : [expectedAdapters[index], { error: result.reason.message }]
    )));
    const expected = Object.fromEntries(expectedAdapters.map((adapterId) => {
      const id = `${adapterId}-work`;
      const managedRuntime = runtimeForAdapter(adapterId);
      return [adapterId, {
        managedRuntime,
        environment: expect.objectContaining({
          PATH: managedRuntime.runtimeId === "codex" ? "/codex-path:/safe/bin" : "/safe/bin",
          HOME: "/Users/tester",
          USERPROFILE: "C:\\Users\\tester",
          ...(managedRuntime.runtimeId === "codex"
            ? { CODEX_HOME: join(root, id, "codex-home"), RELAYER_CODEX_BINARY: managedRuntime.executable }
            : { CLAUDE_CONFIG_DIR: join(root, id, "claude-home") }),
        }),
      }];
    }));
    expect({
      observed,
      ambientSecrets: Object.values(observed).flatMap(({ environment }) => (
        ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "UNRELATED_TOKEN"].filter((key) => key in environment)
      )),
      rejected: rejected.map((result) => result.reason.message),
      windows: {
        account: account.status,
        path: spawnedEnvironment.Path,
        pathKeys: Object.keys(spawnedEnvironment).filter((key) => key.toLowerCase() === "path"),
      },
    }).toEqual({
      observed: expected,
      ambientSecrets: [],
      rejected: [
        expect.stringContaining("managed runtime"),
        expect.stringContaining("requires the claude managed runtime"),
      ],
      windows: {
        account: "connected",
        path: "C:\\Windows\\System32;C:\\Program Files\\nodejs",
        pathKeys: ["Path"],
      },
    });
  });

  it("preserves only the migrated default Codex home with legacy override precedence", async () => {
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
  function adapterFixture(adapterId, { models = [], endpoint, fetch, secret = "secret" } = {}) {
    const descriptor = productionProviderAdapterRegistry.get(adapterId);
    const managedRuntime = runtimeForAdapter(adapterId);
    const environment = managedRuntime.runtimeId === "codex"
      ? { CODEX_HOME: `/isolated/${adapterId}/codex`, RELAYER_CODEX_BINARY: managedRuntime.executable }
      : { CLAUDE_CONFIG_DIR: `/isolated/${adapterId}/claude` };
    const request = fetch ?? vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: models }),
    }));
    const adapter = productionProviderAdapterRegistry.create(
      definition(adapterId, endpoint ?? descriptor.defaultEndpoint),
      {
        fetch: request,
        secrets: { "api-key": secret },
        managedRuntime,
        environment,
      },
    );
    return { adapter, descriptor, fetch: request };
  }

  it("all four secret-backed adapters satisfy the common discovery and execution-access contract", async () => {
    const roster = [
      ["openai-api", "https://api.openai.com/v1/models", "authorization", "gpt-5.4"],
      ["anthropic-api", "https://api.anthropic.com/v1/models", "x-api-key", "claude-sonnet-4-20250514"],
      ["openrouter", "https://openrouter.ai/api/v1/models", "authorization", "openai/gpt-5.4"],
      ["vercel-ai-router", "https://ai-gateway.vercel.sh/v1/models", "authorization", "openai/gpt-5.4"],
    ];
    const settled = await Promise.allSettled(roster.map(async (
      [adapterId, expectedEndpoint, expectedHeader, modelId],
    ) => {
      const model = adapterId === "openrouter"
        ? { id: modelId, architecture: { output_modalities: ["text"] } }
        : adapterId === "vercel-ai-router" ? { id: modelId, type: "language" } : { id: modelId };
      const fixture = adapterFixture(adapterId, { models: [model] });
      const snapshot = await fixture.adapter.connect();
      const access = await fixture.adapter.executionAccess();
      return [adapterId, {
        urls: fixture.fetch.mock.calls.map(([url]) => url),
        header: Object.keys(fixture.fetch.mock.calls.at(-1)[1].headers).map((key) => key.toLowerCase()),
        model: snapshot.models[0] && {
          id: snapshot.models[0].id,
          executionModel: snapshot.models[0].executionModel,
        },
        family: snapshot.systemFamily.modelIds,
        access: {
          kind: access.kind,
          endpoint: access.endpoint,
          fields: access.fields,
          runtime: access.runtime,
        },
        expectedEndpoint,
        expectedHeader,
      }];
    }));
    const observed = Object.fromEntries(settled.map((result, index) => (
      result.status === "fulfilled"
        ? result.value
        : [roster[index][0], { error: result.reason.message }]
    )));

    expect(observed).toEqual(Object.fromEntries(roster.map((
      [adapterId, expectedEndpoint, expectedHeader, modelId],
    ) => [adapterId, {
      urls: adapterId === "openrouter"
        ? ["https://openrouter.ai/api/v1/key", expectedEndpoint]
        : [expectedEndpoint],
      header: expect.arrayContaining([expectedHeader]),
      model: { id: modelId, executionModel: modelId },
      family: [],
      access: {
        kind: "secret",
        endpoint: productionProviderAdapterRegistry.get(adapterId).defaultEndpoint,
        fields: { "api-key": "secret" },
        runtime: {
          ...runtimeForAdapter(adapterId),
          environment: runtimeForAdapter(adapterId).runtimeId === "codex"
            ? { CODEX_HOME: `/isolated/${adapterId}/codex`, RELAYER_CODEX_BINARY: runtimeForAdapter(adapterId).executable }
            : { CLAUDE_CONFIG_DIR: `/isolated/${adapterId}/claude` },
        },
      },
      expectedEndpoint,
      expectedHeader,
    }])));
  });

  it("openai admits capability-proven models and rejects invented family prefixes", async () => {
    const { adapter } = adapterFixture("openai-api", { models: [
      { id: "gpt-5.4" },
      { id: "text-embedding-3-large" },
      { id: "gpt-made-up" },
    ] });
    const snapshot = await adapter.connect();
    const product = toProductCatalogSnapshot(snapshot);
    expect({
      models: snapshot.models.map(({ id, availability, unavailableReasonCode }) => ({
      id, availability, unavailableReasonCode: unavailableReasonCode ?? null,
      })),
      diagnostics: product.models.filter(({ available }) => !available).map(({ id, unavailableReason }) => ({ id, unavailableReason })),
    }).toEqual({
      models: [
      { id: "gpt-5.4", availability: "available", unavailableReasonCode: null },
      { id: "text-embedding-3-large", availability: "unavailable", unavailableReasonCode: "provider_model_not_execution_eligible" },
      { id: "gpt-made-up", availability: "unavailable", unavailableReasonCode: "provider_model_capability_unknown" },
      ],
      diagnostics: [
        { id: "text-embedding-3-large", unavailableReason: { code: "provider_model_not_execution_eligible", message: "This provider model is not eligible for agent execution." } },
        { id: "gpt-made-up", unavailableReason: { code: "provider_model_capability_unknown", message: "This provider model has no recognized agent-execution capability evidence." } },
      ],
    });
  });

  it("anthropic admits only reviewed text families", async () => {
    const { adapter } = adapterFixture("anthropic-api", { models: [
      { id: "claude-sonnet-4-20250514" },
      { id: "claude-3-5-haiku-20241022" },
      { id: "claude-embedding" },
      { id: "claude-realtime" },
      { id: "claude-batch" },
      { id: "claude-sonnet-realtime" },
      { id: "claude-opus-batch" },
      { id: "claude-haiku-audio" },
      { id: "claude-3-realtime" },
      { id: "claude-1-batch" },
    ] });
    const snapshot = await adapter.connect();
    expect(snapshot.models.map(({ id, availability, unavailableReasonCode }) => ({
      id, availability, unavailableReasonCode: unavailableReasonCode ?? null,
    }))).toEqual([
      { id: "claude-sonnet-4-20250514", availability: "available", unavailableReasonCode: null },
      { id: "claude-3-5-haiku-20241022", availability: "available", unavailableReasonCode: null },
      { id: "claude-embedding", availability: "unavailable", unavailableReasonCode: "provider_model_not_execution_eligible" },
      { id: "claude-realtime", availability: "unavailable", unavailableReasonCode: "provider_model_capability_unknown" },
      { id: "claude-batch", availability: "unavailable", unavailableReasonCode: "provider_model_capability_unknown" },
      { id: "claude-sonnet-realtime", availability: "unavailable", unavailableReasonCode: "provider_model_capability_unknown" },
      { id: "claude-opus-batch", availability: "unavailable", unavailableReasonCode: "provider_model_capability_unknown" },
      { id: "claude-haiku-audio", availability: "unavailable", unavailableReasonCode: "provider_model_capability_unknown" },
      { id: "claude-3-realtime", availability: "unavailable", unavailableReasonCode: "provider_model_capability_unknown" },
      { id: "claude-1-batch", availability: "unavailable", unavailableReasonCode: "provider_model_capability_unknown" },
    ]);
  });

  it("OpenRouter enforces capability and credential-probe policy", async () => {
    const production = adapterFixture("openrouter", { models: [
      {
        id: "z-ai/glm-5.3",
        architecture: { output_modalities: ["text"] },
        context_length: 202_752,
        top_provider: { context_length: 196_608, max_completion_tokens: 131_072 },
      },
      { id: "embedding", architecture: { output_modalities: ["embeddings"] } },
      {
        id: "small-output-model",
        architecture: { output_modalities: ["text"] },
        context_length: 32_768,
        top_provider: { context_length: 32_768, max_completion_tokens: 2_048 },
      },
      { id: "unknown-limits", architecture: { output_modalities: ["text"] } },
      { id: "unknown-model" },
    ] });
    const expired = adapterFixture("openrouter", {
      secret: "expired",
      fetch: vi.fn(async () => ({ ok: false, status: 401 })),
    });
    const custom = adapterFixture("openrouter", {
      endpoint: "https://router.example.test/v1",
      models: [{ id: "z-ai/glm-5.3", architecture: { output_modalities: ["text"] } }],
    });
    const [connected, rejected, customConnected] = await Promise.all([
      production.adapter.connect(),
      expired.adapter.connect(),
      custom.adapter.connect(),
    ]);
    expect({
      production: {
        urls: production.fetch.mock.calls.map(([url]) => url),
        models: connected.models.map(({ id, availability, unavailableReasonCode }) => ({
          id, availability, unavailableReasonCode: unavailableReasonCode ?? null,
        })),
        diagnostics: toProductCatalogSnapshot(connected).models
          .filter(({ available }) => !available)
          .map(({ id, unavailableReason }) => ({ id, unavailableReason })),
        capabilities: production.adapter.executionAccess().modelCapabilities,
      },
      rejected: {
        provider: rejected.provider,
        models: rejected.models,
        urls: expired.fetch.mock.calls.map(([url]) => url),
      },
      custom: {
        status: customConnected.provider.status,
        urls: custom.fetch.mock.calls.map(([url]) => url),
      },
    }).toMatchObject({
      production: {
        urls: ["https://openrouter.ai/api/v1/key", "https://openrouter.ai/api/v1/models"],
        models: [
          { id: "z-ai/glm-5.3", availability: "available", unavailableReasonCode: null },
          { id: "embedding", availability: "unavailable", unavailableReasonCode: "provider_model_not_execution_eligible" },
          { id: "small-output-model", availability: "available", unavailableReasonCode: null },
          { id: "unknown-limits", availability: "available", unavailableReasonCode: null },
          { id: "unknown-model", availability: "unavailable", unavailableReasonCode: "provider_model_capability_unknown" },
        ],
        diagnostics: [
          { id: "embedding", unavailableReason: { code: "provider_model_not_execution_eligible", message: "This provider model is not eligible for agent execution." } },
          { id: "unknown-model", unavailableReason: { code: "provider_model_capability_unknown", message: "This provider model has no recognized agent-execution capability evidence." } },
        ],
        capabilities: {
          "z-ai/glm-5.3": { contextWindow: 196_608, maxOutputTokens: 131_072 },
          "small-output-model": { contextWindow: 32_768, maxOutputTokens: 2_048 },
        },
      },
      rejected: {
        provider: { status: "unavailable", unavailableReason: "Provider credentials were rejected." },
        models: [],
        urls: ["https://openrouter.ai/api/v1/key"],
      },
      custom: { status: "available", urls: ["https://router.example.test/v1/models"] },
    });
  });

  it("Vercel preserves exact execution capabilities while rejecting non-language models", async () => {
    const { adapter } = adapterFixture("vercel-ai-router", { models: [
      {
        id: "deepseek/deepseek-v4-pro-0813",
        type: "language",
        context_window: 1_000_000,
        max_tokens: 384_000,
      },
      { id: "openai/sora", type: "video" },
      { id: "unknown-limits", type: "language" },
    ] });
    const snapshot = await adapter.connect();
    expect({
      models: snapshot.models.map(({ id, availability, unavailableReasonCode }) => ({
        id, availability, unavailableReasonCode: unavailableReasonCode ?? null,
      })),
      diagnostics: toProductCatalogSnapshot(snapshot).models
        .filter(({ available }) => !available)
        .map(({ id, unavailableReason }) => ({ id, unavailableReason })),
      capabilities: adapter.executionAccess().modelCapabilities,
    }).toEqual({
      models: [
        { id: "deepseek/deepseek-v4-pro-0813", availability: "available", unavailableReasonCode: null },
        { id: "openai/sora", availability: "unavailable", unavailableReasonCode: "provider_model_not_execution_eligible" },
        { id: "unknown-limits", availability: "available", unavailableReasonCode: null },
      ],
      diagnostics: [{
        id: "openai/sora",
        unavailableReason: { code: "provider_model_not_execution_eligible", message: "This provider model is not eligible for agent execution." },
      }],
      capabilities: {
        "deepseek/deepseek-v4-pro-0813": { contextWindow: 1_000_000, maxOutputTokens: 384_000 },
      },
    });
  });

  it("zero eligible models preserves provider connectivity and complete diagnostics", async () => {
    const { adapter } = adapterFixture("openai-api", { models: [
      { id: "text-embedding-3-large" },
      { id: "embedding-hidden", hidden: true },
    ] });
    const product = toProductCatalogSnapshot(await adapter.connect());
    expect(product).toMatchObject({
      connected: true,
      models: [
        { id: "text-embedding-3-large", visible: true, available: false },
        { id: "embedding-hidden", visible: false, available: false },
      ],
    });
    expect(product.models.map(({ unavailableReason }) => unavailableReason)).toEqual([
      { code: "provider_model_not_execution_eligible", message: "This provider model is not eligible for agent execution." },
      { code: "provider_model_not_execution_eligible", message: "This provider model is not eligible for agent execution." },
    ]);
  });

  it("execution performs one bounded capability rediscovery and fails closed when rejected", async () => {
    const openrouter = adapterFixture("openrouter", { models: [{
      id: "z-ai/glm-5.3",
      architecture: { output_modalities: ["text"] },
      top_provider: { context_length: 196_608, max_completion_tokens: 131_072 },
    }] });
    const vercel = adapterFixture("vercel-ai-router", { models: [{
      id: "deepseek/deepseek-v4-pro-0813",
      type: "language",
      context_window: 1_000_000,
      max_tokens: 384_000,
    }] });
    const rejected = adapterFixture("openrouter", {
      secret: "rejected",
      fetch: vi.fn(async () => ({ ok: false, status: 401 })),
    });
    const settled = await Promise.allSettled([
      openrouter.adapter.executionAccess(),
      vercel.adapter.executionAccess(),
      rejected.adapter.executionAccess(),
    ]);
    expect({
      openrouter: settled[0].value.modelCapabilities,
      openrouterCalls: openrouter.fetch.mock.calls.map(([url]) => url),
      vercel: settled[1].value.modelCapabilities,
      vercelCalls: vercel.fetch.mock.calls.map(([url]) => url),
      rejected: settled[2].reason.message,
      rejectedCalls: rejected.fetch.mock.calls.length,
    }).toEqual({
      openrouter: { "z-ai/glm-5.3": { contextWindow: 196_608, maxOutputTokens: 131_072 } },
      openrouterCalls: ["https://openrouter.ai/api/v1/key", "https://openrouter.ai/api/v1/models"],
      vercel: { "deepseek/deepseek-v4-pro-0813": { contextWindow: 1_000_000, maxOutputTokens: 384_000 } },
      vercelCalls: ["https://ai-gateway.vercel.sh/v1/models"],
      rejected: expect.stringContaining("credentials were rejected"),
      rejectedCalls: 1,
    });
  });

  it("rejects malformed or empty discovery without manual model entry", async () => {
    const { adapter } = adapterFixture("openai-api");
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
  it("enforces exact-definition leases across logout and reconnect", async () => {
    const accounts = new Map([["managed-work", "connected"], ["managed-personal", "connected"]]);
    const definitions = [
      { id: "managed-work", adapterId: "fake-managed", label: "Work", endpoint: null, accessContract: "managed-runtime@1", credentialReference: null, lifecycleState: "active" },
      { id: "managed-personal", adapterId: "fake-managed", label: "Personal", endpoint: null, accessContract: "managed-runtime@1", credentialReference: null, lifecycleState: "active" },
    ];
    const runtime = (id) => ({
      providerId: id,
      credentials: {
        login: async () => ({ authUrl: `https://login.example.test/${id}` }),
        account: async () => ({ status: accounts.get(id) }),
        logout: async () => { accounts.set(id, "disconnected"); return { status: "disconnected" }; },
      },
      discover: async () => ({
        provider: { id, label: id, status: "available" },
        models: [{ visible: true }],
        systemFamily: { id, label: id, modelIds: [] },
      }),
    });
    const runtimes = new Map(definitions.map(({ id }) => [id, runtime(id)]));
    const service = new ProviderDefinitionService({
      registry: createProviderAdapterRegistry([{
        adapterId: "fake-managed", implementationVersion: "1", label: "Managed", accessContract: "managed-runtime@1",
        defaultEndpoint: null, connection: { mode: "managed-login", fields: [] },
        create: ({ definition: created }) => runtimes.get(created.id),
      }]),
      definitionStore: {
        async load() { return definitions; },
        createWithCatalog: vi.fn(async () => { throw new Error("reconnect must preserve identity"); }),
      },
      credentialStore: {},
      initialRuntimes: runtimes,
      prepareRuntime: vi.fn(async () => {}),
    });

    const lease = await service.acquireExecution("managed-work");
    await expect(service.logout("managed-work")).rejects.toThrow("interactions are running");
    await lease.release();
    await service.logout("managed-work");
    const pending = await service.reconnect("managed-work");
    await expect(service.completeConnection(pending.connectionId)).resolves.toMatchObject({ status: "pending" });
    accounts.set("managed-work", "connected");
    const connected = await service.completeConnection(pending.connectionId);

    expect({
      connected: connected.providerDefinition.id,
      accounts,
      definitions: (await service.list()).map(({ id }) => id),
    }).toEqual({
      connected: "managed-work",
      accounts: new Map([["managed-work", "connected"], ["managed-personal", "connected"]]),
      definitions: ["managed-work", "managed-personal"],
    });
  });

  it("keeps unrelated execution leases available during reconnect and recovery", async () => {
    const results = await Promise.allSettled(["reconnect", "recoverUnavailable"].map(async (operationName) => {
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
      return operationName;
    }));
    expect(results).toEqual([
      { status: "fulfilled", value: "reconnect" },
      { status: "fulfilled", value: "recoverUnavailable" },
    ]);
  });

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

  it("issues execution access only from an exact provisioned and unrevoked runtime", async () => {
    const codexEnvironment = { CODEX_HOME: "/isolated/codex", RELAYER_CODEX_BINARY: codexRuntime.executable };
    const exactCodex = productionProviderAdapterRegistry.create({
      id: "codex-connected", adapterId: "codex-subscription", label: "Codex", endpoint: null,
    }, { environment: codexEnvironment, managedRuntime: codexRuntime });
    exactCodex.credentials.account = async () => ({ status: "connected", account: {} });
    const revokedCodex = productionProviderAdapterRegistry.create({
      id: "codex-revoked", adapterId: "codex-subscription", label: "Codex Revoked", endpoint: null,
    }, { environment: { RELAYER_CODEX_BINARY: codexRuntime.executable }, managedRuntime: codexRuntime });
    revokedCodex.credentials.account = async () => ({ status: "disconnected", account: null });
    const missingClaude = productionProviderAdapterRegistry.create({
      id: "claude-missing", adapterId: "claude-subscription", label: "Claude Missing", endpoint: null,
    }, {
      executable: "/definitely/missing/relayer-claude",
      managedRuntime: { ...claudeRuntime, executable: "/definitely/missing/relayer-claude" },
    });
    const settled = await Promise.allSettled([
      exactCodex.executionAccess(),
      revokedCodex.executionAccess(),
      missingClaude.executionAccess(),
    ]);
    const ambientErrors = [
      () => productionProviderAdapterRegistry.create({
        id: "codex-ambient", adapterId: "codex-subscription", label: "Codex", endpoint: null,
      }, { environment: { PATH: "/ambient/bin" }, managedRuntime: codexRuntime }),
      () => new ClaudeCliManagedRuntime({ environment: { PATH: "/ambient/bin" } }),
    ].map((operation) => {
      try { operation(); return null; } catch (error) { return error.message; }
    });

    expect({
      exact: settled[0].value,
      revoked: settled[1].reason.message,
      missingClaude: settled[2].reason.message,
      ambientErrors,
    }).toEqual({
      exact: { kind: "managed-runtime", ...codexRuntime, environment: codexEnvironment },
      revoked: expect.stringContaining("not connected"),
      missingClaude: expect.stringContaining("not connected"),
      ambientErrors: [
        expect.stringContaining("requires the provisioned managed runtime executable"),
        expect.stringContaining("managed runtime executable is required"),
      ],
    });
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
  it("retries only transient failures with bounded jitter and prompt cancellation", async () => {
    const delays = [];
    const transient = vi.fn()
      .mockRejectedValueOnce(new ProviderHttpError("busy", { status: 429 }))
      .mockRejectedValueOnce(new ProviderHttpError("down", { status: 503 }))
      .mockResolvedValue("ok");
    const controller = new AbortController();
    const settled = await Promise.allSettled([
      withProviderRetry(transient, {
        random: () => 0.5,
        sleep: async (delay) => { delays.push(delay); },
      }),
      withProviderRetry(async () => { throw new ProviderHttpError("bad key", { status: 401 }); }),
      withProviderRetry(async () => { throw new ProviderHttpError("busy", { status: 429 }); }, {
        signal: controller.signal,
        sleep: async (_delay, signal) => {
          controller.abort(new Error("cancelled"));
          signal.throwIfAborted();
        },
      }),
    ]);
    expect({
      statuses: settled.map(({ status }) => status),
      success: settled[0].value,
      auth: settled[1].reason.message,
      cancelled: settled[2].reason.message,
      delays,
    }).toEqual({
      statuses: ["fulfilled", "rejected", "rejected"],
      success: "ok",
      auth: "bad key",
      cancelled: "cancelled",
      delays: [250, 500],
    });
  });

  it("writes one bounded redacted serialized diagnostic stream", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-provider-log-"));
    const path = join(root, "provider.log");
    const log = createProviderDiagnosticsLog({ path, maximumBytes: 16 * 1024 });
    await Promise.all(Array.from({ length: 40 }, (_, index) => log.write({
      code: `failure-${index}`,
      apiKey: "sk-super-secret-value",
      message: "Bearer hidden-value",
      error: `opaque-private-value-${index}`,
    })));
    const concurrentContents = await readFile(path, "utf8");
    const concurrentEvents = concurrentContents.trim().split("\n").map((line) => JSON.parse(line));
    await Promise.all(Array.from({ length: 20 }, (_, index) => log.write({
      code: `rotation-${index}`,
      message: "x".repeat(4_000),
      apiKey: "sk-super-secret-value",
    })));
    const rotatedContents = await readFile(path, "utf8");
    expect({
      concurrentCodes: concurrentEvents.map(({ code }) => code),
      concurrentUnique: new Set(concurrentEvents.map(({ code }) => code)).size,
      bounded: Buffer.byteLength(rotatedContents) <= 16 * 1024,
      rotatedCodes: rotatedContents.trim().split("\n").map((line) => JSON.parse(line).code),
      leaked: ["super-secret", "hidden-value", "opaque-private-value"].some((value) => (
        concurrentContents.includes(value) || rotatedContents.includes(value)
      )),
    }).toEqual({
      concurrentCodes: Array.from({ length: 40 }, (_, index) => `failure-${index}`),
      concurrentUnique: 40,
      bounded: true,
      rotatedCodes: expect.arrayContaining(["rotation-19"]),
      leaked: false,
    });
  });

});

describe("managed provider runtime cleanup", () => {
  it("removes only registry-authorized definition-scoped runtime state", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-provider-runtime-"));
    const registry = createProviderAdapterRegistry([
      ...productionProviderAdapterRegistry.list(),
      {
        adapterId: "future-subscription", implementationVersion: "1", label: "Future",
        accessContract: "managed-runtime@1", defaultEndpoint: null,
        connection: { mode: "existing-runtime-auth", fields: [] }, create: () => ({}),
      },
    ]);
    for (const directory of ["future-work", "claude-work/claude-home", "claude-personal/claude-home", "openai-work/codex-home"]) {
      await mkdir(join(root, directory), { recursive: true });
    }
    await writeFile(join(root, "claude-work/claude-home/auth.json"), "work");
    await writeFile(join(root, "claude-personal/claude-home/auth.json"), "personal");
    const removeRuntimeState = createProviderRuntimeStateRemover({ runtimeRoot: root, registry });
    const removals = await Promise.all([
      removeRuntimeState({ id: "future-work", adapterId: "future-subscription", accessContract: "managed-runtime@1" }),
      removeRuntimeState({ id: "claude-work", adapterId: "claude-subscription", accessContract: "managed-runtime@1" }),
      removeRuntimeState({ id: "openai-work", adapterId: "openai-api", accessContract: "secret@1" }),
    ]);
    const invalid = ["../escape", "/absolute"].map((id) => {
      try {
        providerRuntimeDirectory(root, { id, adapterId: "codex-subscription", accessContract: "managed-runtime@1" }, registry);
        return null;
      } catch (error) {
        return error.message;
      }
    });
    expect({
      removals,
      workExists: await access(join(root, "claude-work")).then(() => true, () => false),
      apiExists: await access(join(root, "openai-work")).then(() => true, () => false),
      personal: await readFile(join(root, "claude-personal/claude-home/auth.json"), "utf8"),
      invalid,
    }).toEqual({
      removals: [true, true, true],
      workExists: false,
      apiExists: false,
      personal: "personal",
      invalid: [expect.stringContaining("stable provider definition id"), expect.stringContaining("stable provider definition id")],
    });
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
    failCommit = false,
    failRuntimeRegistration = false,
    diagnostics = null,
    removeRuntimeState = async () => false,
  } = {}) {
    let stored = [];
    const credentials = new Map();
    const closes = [];
    const events = [];
    const descriptor = {
      adapterId: "fake-api", implementationVersion: "1", label: "Fake", accessContract: "secret@1",
      defaultEndpoint: "https://example.test/v1", endpointEditableDuringCreation: true,
      connection: { mode: "secret-fields", fields: [{ id: "api-key", label: "API key", kind: "secret" }] },
      create: ({ definition: created }) => ({
        async discover() {
          events.push("discover");
          if (failDiscovery) throw new Error("discovery failed");
          return { models: [{ visible: true }], provider: { id: created.id } };
        },
        async close() { closes.push(created.id); events.push("close"); },
      }),
    };
    const service = new ProviderDefinitionService({
      registry: createProviderAdapterRegistry([descriptor]),
      definitionStore: {
        async load() { return structuredClone(stored); },
        async save(value) { stored = structuredClone(value); },
        async createWithCatalog(candidate) {
          events.push("commit");
          if (failCommit) throw new Error("commit failed");
          stored.push(structuredClone(candidate));
        },
      },
      credentialStore: {
        async set(key, value) { events.push("credential"); credentials.set(key, structuredClone(value)); },
        async get(key) { return credentials.get(key) ?? null; },
        async delete(key) { events.push("credential-delete"); return credentials.delete(key); },
      },
      idGenerator: (() => { let id = 0; return () => `provider-${++id}`; })(),
      diagnostics,
      removeRuntimeState,
      onRuntimeReady: failRuntimeRegistration
        ? async () => { events.push("runtime-ready"); throw new Error("runtime registration failed"); }
        : undefined,
      onRuntimeRemoved: failRuntimeRegistration
        ? async () => { events.push("runtime-removed"); }
        : undefined,
    });
    return { service, definitions: () => stored, credentials, closes, events };
  }

  it("commits provider creation atomically or compensates every precommit resource", async () => {
    const scenarios = {
      success: serviceFixture(),
      discovery: serviceFixture({ failDiscovery: true }),
      commit: serviceFixture({ failCommit: true }),
      runtime: serviceFixture({ failRuntimeRegistration: true }),
    };
    const settled = await Promise.allSettled(Object.entries(scenarios).map(([label, fixture]) => (
      fixture.service.connect({
        adapterId: "fake-api",
        label,
        endpoint: "https://example.test/v1",
        fields: { "api-key": "secret" },
      })
    )));
    const observed = Object.fromEntries(Object.entries(scenarios).map(([label, fixture], index) => [label, {
      status: settled[index].status,
      error: settled[index].status === "rejected" ? settled[index].reason.message : null,
      definitions: fixture.definitions().map(({ id, credentialReference }) => ({ id, credentialReference })),
      credentialCount: fixture.credentials.size,
      secretPersisted: JSON.stringify(fixture.definitions()).includes('"api-key":"secret"'),
      closes: fixture.closes,
      events: fixture.events,
    }]));
    expect(observed).toEqual({
      success: {
        status: "fulfilled",
        error: null,
        definitions: [{ id: "provider-1", credentialReference: "provider:provider-1" }],
        credentialCount: 1,
        secretPersisted: false,
        closes: [],
        events: ["discover", "credential", "commit"],
      },
      discovery: {
        status: "rejected",
        error: "discovery failed",
        definitions: [],
        credentialCount: 0,
        secretPersisted: false,
        closes: ["provider-1"],
        events: ["discover", "close"],
      },
      commit: {
        status: "rejected",
        error: "commit failed",
        definitions: [],
        credentialCount: 0,
        secretPersisted: false,
        closes: ["provider-1"],
        events: ["discover", "credential", "commit", "close", "credential-delete"],
      },
      runtime: {
        status: "rejected",
        error: "runtime registration failed",
        definitions: [],
        credentialCount: 0,
        secretPersisted: false,
        closes: ["provider-1"],
        events: ["discover", "runtime-ready", "runtime-removed", "close"],
      },
    });
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

  it("retains runtime and credentials when authoritative tombstoning fails, then reconciles on restart", async () => {
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

    await expect(fixture.service.remove(created.providerDefinition.id)).rejects.toThrow("durable attempt still running");
    expect(fixture.definitions()[0]).toMatchObject({
      lifecycleState: "removal_pending", credentialReference: `provider:${created.providerDefinition.id}`,
    });
    expect(fixture.credentials.size).toBe(1);
    expect(fixture.closes).toEqual([]);
    expect(removals).toEqual([]);

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
    expect(removals).toEqual([created.providerDefinition.id]);
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

  it("owns managed login from pending authorization through completion or cancellation", async () => {
    async function exercise(mode) {
      let stored = [];
      let accountStatus = "disconnected";
      let discoveryGate = Promise.resolve();
      const closed = [];
      const removed = [];
      const service = new ProviderDefinitionService({
        registry: createProviderAdapterRegistry([{
          adapterId: "fake-managed", implementationVersion: "1", label: "Managed",
          accessContract: "managed-runtime@1", defaultEndpoint: null,
          connection: { mode: "managed-login", fields: [] },
          create: ({ definition: created }) => ({
            credentials: {
              login: async () => ({ loginId: `login-${created.id}` }),
              account: async () => ({ status: accountStatus }),
            },
            catalog: { discover: async () => {
              await discoveryGate;
              return { provider: { id: created.id }, models: [{ visible: true }] };
            } },
            close: async () => { closed.push(created.id); },
          }),
        }]),
        definitionStore: {
          async load() { return structuredClone(stored); },
          async save(value) { stored = structuredClone(value); },
          async createWithCatalog(candidate) { stored.push(structuredClone(candidate)); },
        },
        credentialStore: { async set() {}, async get() { return {}; }, async delete() {} },
        idGenerator: () => `managed-${mode}`,
        removeRuntimeState: async ({ id }) => { removed.push(id); },
      });
      const pending = await service.connect({ adapterId: "fake-managed", label: mode });
      if (mode === "complete") {
        const pendingResult = await service.completeConnection(pending.connectionId);
        const persistedWhilePending = stored.length;
        accountStatus = "connected";
        const connected = await service.completeConnection(pending.connectionId);
        return { pending: pendingResult.status, persistedWhilePending, connected: connected.providerDefinition.id, stored: stored.length };
      }
      if (mode === "cancel") {
        return { cancelled: await service.cancelConnection(pending.connectionId), stored: stored.length, closed, removed };
      }
      let releaseDiscovery;
      discoveryGate = new Promise((resolve) => { releaseDiscovery = resolve; });
      accountStatus = "connected";
      const completion = service.completeConnection(pending.connectionId);
      const cancellation = service.cancelConnection(pending.connectionId);
      releaseDiscovery();
      const [connected, cancelled] = await Promise.all([completion, cancellation]);
      return { connected: connected.status, cancelled, stored: stored.length, closed };
    }

    const modes = ["complete", "cancel", "race"];
    const settled = await Promise.allSettled(modes.map(exercise));
    expect(Object.fromEntries(settled.map((result, index) => [
      modes[index],
      result.status === "fulfilled" ? result.value : { error: result.reason.message },
    ]))).toEqual({
      complete: { pending: "pending", persistedWhilePending: 0, connected: "managed-complete", stored: 1 },
      cancel: { cancelled: true, stored: 0, closed: ["managed-cancel"], removed: ["managed-cancel"] },
      race: { connected: "connected", cancelled: false, stored: 1, closed: [] },
    });
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

  it("reconciles all persisted provider states before startup refresh", async () => {
    const definition = (id, lifecycleState = "active") => ({
      id, adapterId: "fake-api", label: id, endpoint: "https://example.test/v1",
      accessContract: "secret@1", credentialReference: `provider:${id}`, lifecycleState, removedAt: null,
    });
    let stored = [
      definition("removal", "removal_pending"),
      definition("healthy"),
      definition("revoked"),
      definition("missing"),
    ];
    const credentials = new Map([
      ["provider:removal", { key: "old" }],
      ["provider:healthy", { key: "valid" }],
    ]);
    const discoveries = [];
    const published = [];
    const removed = [];
    const unavailable = [];
    const diagnostics = [];
    const snapshot = (providerId) => ({
      provider: { id: providerId, label: providerId, status: "available" },
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
      defaultEndpoint: "https://example.test/v1",
      connection: { mode: "secret-fields", fields: [{ id: "key", label: "Key", kind: "secret" }] },
      create: ({ definition: created }) => ({
        providerId: created.id,
        discover: async () => { discoveries.push(created.id); return snapshot(created.id); },
      }),
    }]);
    const modelCatalog = new ModelCatalogService({
      adapters: [],
      publishSnapshot: async (value) => { published.push(value); },
    });
    const service = new ProviderDefinitionService({
      registry,
      definitionStore: {
        async load() { return structuredClone(stored); },
        async save(value) { stored = structuredClone(value); },
      },
      credentialStore: {
        async get(reference) { return credentials.get(reference) ?? null; },
        async delete(reference) { return credentials.delete(reference); },
      },
      diagnostics: { write: async (event) => { diagnostics.push(event); } },
      providerStatuses: async () => new Map([
        ["healthy", { connected: true, unavailableReason: null }],
        ["revoked", { connected: true, unavailableReason: null }],
        ["missing", { connected: true, unavailableReason: null }],
      ]),
      removeRuntimeState: async ({ id }) => { removed.push(id); },
      onRuntimeReady: (_definition, runtime) => modelCatalog.register(runtime.catalog ?? runtime),
      onRuntimeRemoved: (candidate) => modelCatalog.unregister(candidate.id),
      onRuntimeUnavailable: async (candidate, error) => { unavailable.push([candidate.id, error.message]); },
    });

    await service.reconcileStartup();
    await service.activate();
    await modelCatalog.startup();
    await modelCatalog.explicitRefresh("healthy");
    const listed = await service.list();
    const revokedLease = await service.acquireExecution("revoked").then(
      () => null,
      (error) => error.message,
    );
    expect({
      lifecycle: Object.fromEntries(stored.map(({ id, lifecycleState, credentialReference }) => (
        [id, { lifecycleState, credentialReference }]
      ))),
      credentials: [...credentials.keys()],
      removed,
      unavailable: unavailable.map(([id]) => id),
      unavailableListings: listed.filter(({ connected }) => !connected).map(({ id }) => id),
      diagnostics: diagnostics.map(({ providerId, category }) => ({ providerId, category })),
      discoveries,
      published: published.map(({ providerId }) => providerId),
      revokedLease,
    }).toEqual({
      lifecycle: {
        removal: { lifecycleState: "tombstoned", credentialReference: null },
        healthy: { lifecycleState: "active", credentialReference: "provider:healthy" },
        revoked: { lifecycleState: "active", credentialReference: "provider:revoked" },
        missing: { lifecycleState: "active", credentialReference: "provider:missing" },
      },
      credentials: ["provider:healthy"],
      removed: ["removal"],
      unavailable: ["revoked", "missing"],
      unavailableListings: ["revoked", "missing"],
      diagnostics: [
        { providerId: "revoked", category: "provider_activation_failed" },
        { providerId: "missing", category: "provider_activation_failed" },
      ],
      discoveries: ["healthy", "healthy"],
      published: ["healthy", "healthy"],
      revokedLease: expect.stringContaining("credentials are unavailable"),
    });
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

  it("runs one non-overlapping best-effort refresh lifecycle and cancels it on close", async () => {
    const callbacks = [];
    const cleared = [];
    const unref = vi.fn();
    let calls = 0;
    let rejectBackground;
    const backgroundFailure = new Promise((_resolve, reject) => { rejectBackground = reject; });
    const published = [];
    const service = new ModelCatalogService({
      adapters: [
        { providerId: "revoked", discover: async () => { throw new ProviderHttpError("revoked", { status: 401 }); } },
        { providerId: "healthy", discover: async () => {
          calls += 1;
          if (calls === 1) return completeSnapshot("healthy");
          return backgroundFailure;
        } },
      ],
      publishSnapshot: async (snapshot) => { published.push(snapshot); },
      setTimer: (callback) => { const token = { callback, unref }; callbacks.push(token); return token; },
      clearTimer: (token) => { cleared.push(token); },
      backgroundIntervalMs: 10,
    });
    const startup = await service.startup();
    expect(startup.map(({ status }) => status)).toEqual(["rejected", "fulfilled"]);
    expect(published.map(({ providerId }) => providerId)).toEqual(["healthy"]);
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
