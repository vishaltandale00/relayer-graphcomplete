import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  ACTIVE_PROVIDER_ADAPTER_IDS,
  ACTIVE_PROVIDER_ADAPTER_MODULES,
  productionProviderAdapterRegistry,
  productionHarnessRuntimeDescriptor,
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

function managedDescriptor(adapterId, overrides = {}) {
  return {
    adapterId, implementationVersion: "1", label: "Managed", accessContract: "managed-runtime@1",
    defaultEndpoint: null, connection: { mode: "managed-login", fields: [] }, ...overrides,
  };
}

function spawnClaudeChild(payload, exitCode) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  queueMicrotask(() => {
    child.stdout.emit("data", JSON.stringify(payload));
    child.emit("exit", exitCode);
  });
  return child;
}

function serviceFixture({ failDiscovery = false, diagnostics = null, removeRuntimeState = async () => false } = {}) {
  let stored = [];
  const credentials = new Map();
  const closes = [];
  const descriptor = {
    adapterId: "fake-api", implementationVersion: "1", label: "Fake", accessContract: "secret@1",
    defaultEndpoint: "https://example.test/v1", endpointEditableDuringCreation: true,
    connection: { mode: "secret-fields", fields: [{ id: "api-key", label: "API key", kind: "secret" }] },
    create: ({ definition: created }) => ({
      async discover() {
        if (failDiscovery) throw new Error("discovery failed");
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
  });
  return { service, definitions: () => stored, credentials, closes };
}

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

describe("authoritative provider adapter registry", () => {
  it("locks the six-adapter registry contract and rejects malformed entries", async () => {
    expect(productionHarnessRuntimeDescriptor({
      runtimeId: "claude",
      version: "0.3.250",
      executable: "/managed/claude",
      modulePath: "/managed/claude/sdk.mjs",
    }, {
      environment: {
        PATH: "/safe/bin",
        HOME: "/Users/tester",
        ANTHROPIC_API_KEY: "ambient-secret",
      },
    }), "installed runtime shape normalizes module paths and strips ambient secrets").toEqual({
      runtimeId: "claude",
      version: "0.3.250",
      executable: "/managed/claude",
      moduleUrl: "file:///managed/claude/sdk.mjs",
      environment: { PATH: "/safe/bin", HOME: "/Users/tester" },
    });

    expect(ACTIVE_PROVIDER_ADAPTER_IDS, "active adapter ids").toEqual(expectedAdapters);
    expect(productionProviderAdapterRegistry.list().map(({ adapterId }) => adapterId),
      "registry listing order").toEqual(expectedAdapters);
    expect(Object.keys(ACTIVE_PROVIDER_ADAPTER_MODULES), "adapter module map keys").toEqual(expectedAdapters);
    for (const modulePath of Object.values(ACTIVE_PROVIDER_ADAPTER_MODULES)) {
      await expect(access(join(import.meta.dirname, "../desktop/main", modulePath)),
        `module ${modulePath} ships`).resolves.toBeUndefined();
    }
    expect(productionProviderAdapterRegistry.list().map(({ accessContract }) => accessContract),
      "access contracts follow the adapter order").toEqual([
      "managed-runtime@1", "managed-runtime@1", "secret@1", "secret@1", "secret@1", "secret@1",
    ]);
    expect(productionProviderAdapterRegistry.get("claude-subscription").catalog.source,
      "Claude catalog comes from the code manifest").toBe("code-manifest");
    expect(CLAUDE_SUBSCRIPTION_MODELS.map(({ id }) => id), "Claude code-manifest models").toEqual([
      "sonnet", "opus", "fable",
    ]);
    expect(() => productionProviderAdapterRegistry.get("future-provider"),
      "unknown adapters reject").toThrow("Unknown provider adapter");

    const descriptor = {
      adapterId: "fake", implementationVersion: "1", label: "Fake", accessContract: "secret@1",
      defaultEndpoint: "https://example.test/v1", endpointEditableDuringCreation: true,
      connection: { mode: "secret-fields", fields: [{ id: "key", label: "Key", kind: "secret" }] },
      create() {},
    };
    const invalidDescriptors = [
      ["duplicate descriptors", [descriptor, descriptor], "Duplicate provider adapter"],
      ["non-positive implementation version", [{ ...descriptor, implementationVersion: "v1" }], "positive integer"],
    ];
    expect(invalidDescriptors, "registry rejection inventory").toHaveLength(2);
    for (const [label, descriptors, message] of invalidDescriptors) {
      expect.soft(() => createProviderAdapterRegistry(descriptors), label).toThrow(message);
    }

    const acceptedEndpoints = [
      ["trailing slashes normalize", "https://example.test/v1///", undefined, "https://example.test/v1"],
      ["development loopback stays allowed", "http://127.0.0.1:8123/v1", { allowDevelopmentLoopback: true }, "http://127.0.0.1:8123/v1"],
    ];
    for (const [label, endpoint, options, expected] of acceptedEndpoints) {
      expect.soft(normalizeProviderEndpoint(endpoint, options), label).toBe(expected);
    }
    const rejectedEndpoints = [
      ["embedded credentials reject", "https://key@example.test/v1", "credentials"],
      ["query strings reject", "https://example.test/v1?api_key=secret", "query string"],
      ["plain HTTP rejects", "http://example.test/v1", "HTTPS"],
    ];
    expect(rejectedEndpoints, "endpoint rejection inventory").toHaveLength(3);
    for (const [label, endpoint, message] of rejectedEndpoints) {
      expect.soft(() => normalizeProviderEndpoint(endpoint), label).toThrow(message);
    }
  });

  it("routes every adapter through an explicit provisioned managed runtime", async () => {
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
      expect(dependencies.managedRuntime, `${adapterId} passes the managed runtime through`).toEqual(managedRuntime);
      expect(dependencies.environment, `${adapterId} keeps conventional paths`).toMatchObject({
        PATH: managedRuntime.runtimeId === "codex" ? "/codex-path:/safe/bin" : "/safe/bin",
        HOME: "/Users/tester",
        USERPROFILE: "C:\\Users\\tester",
      });
      expect(dependencies.environment, `${adapterId} strips ambient OpenAI secrets`).not.toHaveProperty("OPENAI_API_KEY");
      expect(dependencies.environment, `${adapterId} strips ambient Anthropic secrets`).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(dependencies.environment, `${adapterId} strips unrelated tokens`).not.toHaveProperty("UNRELATED_TOKEN");
      if (managedRuntime.runtimeId === "codex") {
        expect(dependencies.environment, `${adapterId} isolates CODEX_HOME per definition`).toMatchObject({
          CODEX_HOME: join(root, id, "codex-home"),
          RELAYER_CODEX_BINARY: managedRuntime.executable,
        });
      } else {
        expect(dependencies.environment.CLAUDE_CONFIG_DIR, `${adapterId} isolates CLAUDE_CONFIG_DIR per definition`)
          .toBe(join(root, id, "claude-home"));
      }
    }
    await expect(productionProviderRuntimeDependencies({
      id: "openai-work", adapterId: "openai-api",
    }, { runtimeRoot: root, environment: {}, codexBinary: "/ambient/codex" }),
    "an ambient codex binary never substitutes the managed runtime").rejects.toThrow("managed runtime");
    await expect(productionProviderRuntimeDependencies({
      id: "claude-work", adapterId: "claude-subscription",
    }, { runtimeRoot: root, environment: {}, managedRuntime: codexRuntime }),
    "a mismatched managed runtime rejects").rejects.toThrow("requires the claude managed runtime");

    const windowsRoot = await mkdtemp(join(tmpdir(), "relayer-provider-claude-windows-path-"));
    const windowsDependencies = await productionProviderRuntimeDependencies({
      id: "claude-work", adapterId: "claude-subscription",
    }, {
      runtimeRoot: windowsRoot,
      managedRuntime: claudeRuntime,
      platform: "win32",
      environment: {
        PATH: "C:\\ambiguous\\bin",
        Path: "C:\\Windows\\System32;C:\\Program Files\\nodejs",
      },
    });
    let spawnedEnvironment;
    const spawnProcess = vi.fn(() => spawnClaudeChild({ loggedIn: true }, 0));
    const runtime = new ClaudeCliManagedRuntime({
      environment: windowsDependencies.environment,
      executable: windowsDependencies.executable,
      spawnProcess: (...args) => {
        spawnedEnvironment = args[2].env;
        return spawnProcess(...args);
      },
    });
    await expect(runtime.account(), "Claude authentication succeeds with the conventional Windows env")
      .resolves.toMatchObject({ status: "connected" });
    expect(spawnedEnvironment.Path, "the conventional Windows Path wins")
      .toBe("C:\\Windows\\System32;C:\\Program Files\\nodejs");
    expect(spawnedEnvironment, "the POSIX PATH key never ships on Windows").not.toHaveProperty("PATH");
    expect(Object.keys(spawnedEnvironment).filter((key) => key.toLowerCase() === "path"),
      "exactly one path-like variable survives").toEqual(["Path"]);

    const profile = await mkdtemp(join(tmpdir(), "relayer-legacy-codex-home-"));
    const runtimeRoot = join(profile, "provider-runtimes");
    const legacyHome = join(profile, "codex-home");
    const conflictingIsolatedHome = join(runtimeRoot, "codex", "codex-home");
    await mkdir(legacyHome, { recursive: true });
    await mkdir(conflictingIsolatedHome, { recursive: true });
    await writeFile(join(legacyHome, "auth.json"), "legacy-session");
    await writeFile(join(conflictingIsolatedHome, "auth.json"), "unrelated-isolated-session");
    const legacyContext = {
      runtimeRoot,
      legacyCodexHome: legacyHome,
      environment: { PATH: "/safe/bin" },
      managedRuntime: codexRuntime,
    };
    const migrated = { id: "codex", adapterId: "codex-subscription" };
    const firstStart = await productionProviderRuntimeDependencies(migrated, legacyContext);
    const restarted = await productionProviderRuntimeDependencies(migrated, legacyContext);
    expect(firstStart.environment.CODEX_HOME, "the migrated default keeps the legacy home").toBe(legacyHome);
    expect(restarted.environment.CODEX_HOME, "restarts keep the legacy home").toBe(legacyHome);
    await expect(readFile(join(legacyHome, "auth.json"), "utf8"), "the legacy session survives").resolves.toBe("legacy-session");
    await expect(readFile(join(conflictingIsolatedHome, "auth.json"), "utf8"),
      "unrelated isolated homes stay untouched").resolves.toBe("unrelated-isolated-session");
    const newDefinition = await productionProviderRuntimeDependencies({
      id: "new-codex-connection", adapterId: "codex-subscription",
    }, legacyContext);
    expect(newDefinition.environment.CODEX_HOME, "new definitions stay isolated").toBe(
      join(runtimeRoot, "new-codex-connection", "codex-home"),
    );
    expect(resolveLegacyCodexHome("/profile", {}), "the default legacy home is profile-scoped")
      .toBe(join("/profile", "codex-home"));
    expect(resolveLegacyCodexHome("/profile", { RELAYER_CODEX_HOME: "/custom/codex" }),
      "an explicit override wins").toBe("/custom/codex");
    expect(resolveLegacyCodexHome("/profile", { RELAYER_CODEX_HOME: "" }),
      "an empty override falls back").toBe(join("/profile", "codex-home"));

    expect(() => productionProviderAdapterRegistry.create({
      id: "codex-ambient", adapterId: "codex-subscription", label: "Codex", endpoint: null,
    }, { environment: { PATH: "/ambient/bin" }, managedRuntime: codexRuntime }),
    "ambient Codex executable discovery rejects").toThrow("requires the provisioned managed runtime executable");
    expect(() => new ClaudeCliManagedRuntime({ environment: { PATH: "/ambient/bin" } }),
      "ambient Claude executable discovery rejects").toThrow("managed runtime executable is required");

    const revoked = productionProviderAdapterRegistry.create({
      id: "codex-revoked", adapterId: "codex-subscription", label: "Codex Revoked", endpoint: null,
    }, { environment: { PATH: "", RELAYER_CODEX_BINARY: codexRuntime.executable }, managedRuntime: codexRuntime });
    revoked.credentials.account = async () => ({ status: "disconnected", account: null });
    await expect(revoked.executionAccess(), "a revoked Codex subscription fails closed before execution")
      .rejects.toThrow("not connected");

    const codexEnvironment = {
      CODEX_HOME: "/isolated/codex",
      RELAYER_CODEX_BINARY: codexRuntime.executable,
    };
    const codex = productionProviderAdapterRegistry.create({
      id: "codex-connected", adapterId: "codex-subscription", label: "Codex", endpoint: null,
    }, { environment: codexEnvironment, managedRuntime: codexRuntime });
    codex.credentials.account = async () => ({ status: "connected", account: {} });
    await expect(codex.executionAccess(), "Codex harnesses receive the exact provisioned descriptor").resolves.toEqual({
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
    await expect(claude.executionAccess(), "Claude harnesses receive the exact provisioned descriptor").resolves.toEqual({
      kind: "managed-runtime", ...claudeRuntime, environment: claudeEnvironment,
    });

    const missing = productionProviderAdapterRegistry.create({
      id: "claude-missing", adapterId: "claude-subscription", label: "Claude Missing", endpoint: null,
    }, {
      executable: "/definitely/missing/relayer-claude",
      managedRuntime: { ...claudeRuntime, executable: "/definitely/missing/relayer-claude" },
    });
    await expect(missing.credentials.account(), "a missing definition-scoped CLI reports unavailable")
      .resolves.toMatchObject({ status: "unavailable" });
    await expect(missing.credentials.login(), "a missing definition-scoped CLI cannot log in")
      .rejects.toThrow("login is unavailable");
    await expect(missing.executionAccess(), "a missing definition-scoped CLI cannot execute")
      .rejects.toThrow("not connected");

    const loggedOut = new ClaudeCliManagedRuntime({
      executable: "/bin/claude",
      spawnProcess: vi.fn(() => spawnClaudeChild({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }, 1)),
    });
    await expect(loggedOut.account(), "logged-out JSON with exit code one stays a clean disconnected")
      .resolves.toMatchObject({
        status: "disconnected",
        account: { loggedIn: false, authMethod: "none", apiProvider: "firstParty" },
      });

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
    const scopedDependencies = {
      runtimeFactory,
      discoverModels: async () => [{ id: "claude-model", label: "Claude model" }],
      managedRuntime: claudeRuntime,
    };
    const firstClaude = productionProviderAdapterRegistry.create({
      id: "claude-work", adapterId: "claude-subscription", label: "Claude Work", endpoint: null,
    }, scopedDependencies);
    const secondClaude = productionProviderAdapterRegistry.create({
      id: "claude-personal", adapterId: "claude-subscription", label: "Claude Personal", endpoint: null,
    }, scopedDependencies);
    await firstClaude.catalog.discover();
    await secondClaude.catalog.discover();
    await firstClaude.credentials.logout();
    expect(await firstClaude.credentials.account(), "logging out touches only its own runtime")
      .toMatchObject({ status: "disconnected" });
    expect(await secondClaude.credentials.account(), "the other definition stays connected")
      .toMatchObject({ status: "connected" });
    expect(runtimeFactory.mock.calls.map(([created]) => created.id),
      "each Claude definition materializes its own runtime").toEqual(["claude-work", "claude-personal"]);
  }, 30_000);

  it("discovers stable model ids through the common contract for each secret adapter", async () => {
    const contractRows = [
      ["openai-api", "https://api.openai.com/v1/models", "authorization"],
      ["anthropic-api", "https://api.anthropic.com/v1/models", "x-api-key"],
      ["openrouter", "https://openrouter.ai/api/v1/models", "authorization"],
      ["vercel-ai-router", "https://ai-gateway.vercel.sh/v1/models", "authorization"],
    ];
    expect(contractRows, "common contract discovery inventory").toHaveLength(4);
    for (const [adapterId, expectedEndpoint, expectedHeader] of contractRows) {
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
      expect(fetch.mock.calls.map(([url]) => url), `${adapterId} hits the exact discovery urls`).toEqual(expectedUrls);
      expect(Object.keys(fetch.mock.calls.at(-1)[1].headers).map((key) => key.toLowerCase()),
        `${adapterId} authenticates with ${expectedHeader}`).toContain(expectedHeader);
      expect(snapshot.models[0], `${adapterId} reports stable model ids`).toMatchObject({ id: modelId, executionModel: modelId });
      expect(snapshot.systemFamily.modelIds, `${adapterId} discovers no implicit system family`).toEqual([]);
    }
  }, 15_000);

  it("admits only capability-proven agent models", async () => {
    const notEligible = {
      code: "provider_model_not_execution_eligible",
      message: "This provider model is not eligible for agent execution.",
    };
    const capabilityUnknown = {
      code: "provider_model_capability_unknown",
      message: "This provider model has no recognized agent-execution capability evidence.",
    };
    const eligibilityCases = [
      {
        label: "openai-api admits proven agent models only",
        adapterId: "openai-api",
        models: [{ id: "gpt-5.4" }, { id: "text-embedding-3-large" }],
        extraModels: [{ id: "unknown-model" }],
        available: ["gpt-5.4"],
        unavailable: [
          { id: "text-embedding-3-large", reason: notEligible },
          { id: "unknown-model", reason: capabilityUnknown },
        ],
      },
      {
        label: "anthropic-api admits proven agent models only",
        adapterId: "anthropic-api",
        models: [{ id: "claude-sonnet-4-20250514" }, { id: "embedding-model" }],
        extraModels: [{ id: "unknown-model" }],
        available: ["claude-sonnet-4-20250514"],
        unavailable: [
          { id: "embedding-model", reason: notEligible },
          { id: "unknown-model", reason: capabilityUnknown },
        ],
      },
      {
        label: "openrouter admits proven agent models only",
        adapterId: "openrouter",
        models: [
          { id: "openai/gpt-5.4", architecture: { output_modalities: ["text"] } },
          { id: "openai/text-embedding-3-large", architecture: { output_modalities: ["embeddings"] } },
        ],
        extraModels: [{ id: "unknown-model" }],
        available: ["openai/gpt-5.4"],
        unavailable: [
          { id: "openai/text-embedding-3-large", reason: notEligible },
          { id: "unknown-model", reason: capabilityUnknown },
        ],
      },
      {
        label: "vercel-ai-router admits proven agent models only",
        adapterId: "vercel-ai-router",
        models: [{ id: "openai/gpt-5.4", type: "language" }, { id: "openai/sora", type: "video" }],
        extraModels: [{ id: "unknown-model" }],
        available: ["openai/gpt-5.4"],
        unavailable: [
          { id: "openai/sora", reason: notEligible },
          { id: "unknown-model", reason: capabilityUnknown },
        ],
      },
      {
        label: "claude-prefixed capability models stay ineligible",
        adapterId: "anthropic-api",
        models: [{ id: "claude-embedding" }],
        available: [],
        unavailable: [{ id: "claude-embedding", reason: notEligible }],
      },
      {
        label: "only reviewed Claude text-family IDs are admitted",
        adapterId: "anthropic-api",
        models: [
          { id: "claude-sonnet-4-20250514" },
          { id: "claude-3-5-haiku-20241022" },
          { id: "claude-realtime" },
          { id: "claude-batch" },
          { id: "claude-sonnet-realtime" },
          { id: "claude-opus-batch" },
          { id: "claude-haiku-audio" },
          { id: "claude-3-realtime" },
          { id: "claude-1-batch" },
        ],
        available: ["claude-sonnet-4-20250514", "claude-3-5-haiku-20241022"],
        unavailable: [
          { id: "claude-realtime", reason: capabilityUnknown },
          { id: "claude-batch", reason: capabilityUnknown },
          { id: "claude-sonnet-realtime", reason: capabilityUnknown },
          { id: "claude-opus-batch", reason: capabilityUnknown },
          { id: "claude-haiku-audio", reason: capabilityUnknown },
          { id: "claude-3-realtime", reason: capabilityUnknown },
          { id: "claude-1-batch", reason: capabilityUnknown },
        ],
      },
      {
        label: "an unknown OpenAI-prefix model fails closed",
        adapterId: "openai-api",
        models: [{ id: "gpt-made-up" }],
        available: [],
        unavailable: [{ id: "gpt-made-up", reason: capabilityUnknown }],
      },
      {
        label: "provider-hidden models stay invisible and ineligible",
        adapterId: "openai-api",
        models: [{ id: "text-embedding-3-large", hidden: true }],
        available: [],
        unavailable: [{ id: "text-embedding-3-large", reason: notEligible, visible: false }],
      },
      {
        label: "zero execution-eligible models keep the provider connected",
        adapterId: "openai-api",
        models: [{ id: "text-embedding-3-large" }],
        available: [],
        unavailable: [{ id: "text-embedding-3-large", reason: notEligible }],
      },
    ];
    expect(eligibilityCases, "model eligibility inventory").toHaveLength(9);
    for (const { label, adapterId, models, extraModels = [], available, unavailable } of eligibilityCases) {
      const allModels = [...models, ...extraModels];
      const fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: allModels }),
      }));
      const descriptor = productionProviderAdapterRegistry.get(adapterId);
      const adapter = productionProviderAdapterRegistry.create(
        definition(adapterId, descriptor.defaultEndpoint),
        { fetch, secrets: { "api-key": "secret" }, managedRuntime: runtimeForAdapter(adapterId), environment: {} },
      );

      const snapshot = await adapter.connect();
      const product = toProductCatalogSnapshot(snapshot);

      expect.soft(snapshot.provider.status, `${label}: the provider stays connected`).toBe("available");
      expect.soft(snapshot.models.map(({ id, visible }) => ({ id, visible })),
        `${label}: discovery diagnostics stay visible for every model`).toEqual(
        allModels.map(({ id, hidden }) => ({ id, visible: hidden ? false : true })),
      );
      expect.soft(snapshot.models.filter(({ availability }) => availability === "available").map(({ id }) => id),
        `${label}: only capability-proven models are available`).toEqual(available);
      expect.soft(snapshot.models
        .filter(({ availability }) => availability === "unavailable")
        .map(({ id, unavailableReasonCode }) => ({ id, unavailableReasonCode })),
        `${label}: unavailable models carry reason codes`).toEqual(
        unavailable.map(({ id, reason }) => ({ id, unavailableReasonCode: reason.code })),
      );
      expect.soft(product.models.filter(({ available: usable }) => !usable)
        .map(({ id, unavailableReason }) => ({ id, unavailableReason })),
        `${label}: the product catalog carries full unavailability reasons`).toEqual(
        unavailable.map(({ id, reason }) => ({ id, unavailableReason: reason })),
      );
      for (const { id, visible } of unavailable) {
        if (visible === false) {
          expect.soft(snapshot.models.find((model) => model.id === id).visible,
            `${label}: ${id} stays hidden`).toBe(false);
        }
      }
    }

    const emptyDescriptor = productionProviderAdapterRegistry.get("openai-api");
    const emptyAdapter = productionProviderAdapterRegistry.create(
      definition("openai-api", emptyDescriptor.defaultEndpoint),
      { fetch: async () => ({ ok: true, json: async () => ({ data: [] }) }), secrets: { "api-key": "secret" }, managedRuntime: codexRuntime, environment: {} },
    );
    await expect(emptyAdapter.connect(), "empty discovery rejects without manual model entry")
      .rejects.toThrow("visible models");
  }, 30_000);

  it("verifies gateway credentials before discovery and carries per-model capabilities into execution", async () => {
    const expiredKeyFetch = vi.fn(async (url) => url.endsWith("/key")
      ? { ok: false, status: 401 }
      : {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: "deepseek/deepseek-v4-pro-0813", architecture: { output_modalities: ["text"] } }] }),
        });
    const openrouterDescriptor = productionProviderAdapterRegistry.get("openrouter");
    const expiredAdapter = productionProviderAdapterRegistry.create(
      definition("openrouter", openrouterDescriptor.defaultEndpoint),
      { fetch: expiredKeyFetch, secrets: { "api-key": "expired" }, managedRuntime: codexRuntime, environment: {} },
    );
    await expect(expiredAdapter.connect(), "an expired OpenRouter key rejects before the public catalog")
      .resolves.toMatchObject({
        provider: { status: "unavailable", unavailableReason: "Provider credentials were rejected." },
        models: [],
      });
    expect(expiredKeyFetch.mock.calls.map(([url]) => url), "the key probe runs alone before rejection")
      .toEqual(["https://openrouter.ai/api/v1/key"]);

    const customFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "z-ai/glm-5.3", architecture: { output_modalities: ["text"] } }] }),
    }));
    const customAdapter = productionProviderAdapterRegistry.create(
      definition("openrouter", "https://router.example.test/v1"),
      { fetch: customFetch, secrets: { "api-key": "secret" }, managedRuntime: codexRuntime, environment: {} },
    );
    await expect(customAdapter.connect(), "a custom OpenRouter endpoint stays available through the catalog contract")
      .resolves.toMatchObject({ provider: { status: "available" } });
    expect(customFetch.mock.calls.map(([url]) => url), "custom endpoints skip the proprietary key probe")
      .toEqual(["https://router.example.test/v1/models"]);

    const openrouterCapabilities = vi.fn(async () => ({
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
    const openrouterCapabilitiesAdapter = productionProviderAdapterRegistry.create(
      definition("openrouter", openrouterDescriptor.defaultEndpoint),
      { fetch: openrouterCapabilities, secrets: { "api-key": "sk-not-logged" }, managedRuntime: codexRuntime, environment: {} },
    );
    await openrouterCapabilitiesAdapter.connect();
    expect(openrouterCapabilitiesAdapter.executionAccess(),
      "OpenRouter token capabilities reach execution access").toMatchObject({
      modelCapabilities: {
        "z-ai/glm-5.3": { contextWindow: 196_608, maxOutputTokens: 131_072 },
        "small-output-model": { contextWindow: 32_768, maxOutputTokens: 2_048 },
      },
    });
    expect((await openrouterCapabilitiesAdapter.executionAccess()).modelCapabilities,
      "OpenRouter models without limits stay out of execution access").not.toHaveProperty("unknown-limits");

    const vercelCapabilities = vi.fn(async () => ({
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
    const vercelDescriptor = productionProviderAdapterRegistry.get("vercel-ai-router");
    const vercelCapabilitiesAdapter = productionProviderAdapterRegistry.create(
      definition("vercel-ai-router", vercelDescriptor.defaultEndpoint),
      { fetch: vercelCapabilities, secrets: { "api-key": "sk-not-logged" }, managedRuntime: codexRuntime, environment: {} },
    );
    await vercelCapabilitiesAdapter.connect();
    expect(vercelCapabilitiesAdapter.executionAccess(),
      "Vercel token capabilities reach execution access").toMatchObject({
      modelCapabilities: {
        "deepseek/deepseek-v4-pro-0813": { contextWindow: 1_000_000, maxOutputTokens: 384_000 },
      },
    });
    expect((await vercelCapabilitiesAdapter.executionAccess()).modelCapabilities,
      "Vercel models without limits stay out of execution access").not.toHaveProperty("unknown-limits");

    const openrouterRefreshFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{
        id: "z-ai/glm-5.3",
        context_length: 202_752,
        top_provider: { context_length: 196_608, max_completion_tokens: 131_072 },
      }] }),
    }));
    const openrouterRefreshAdapter = productionProviderAdapterRegistry.create(
      definition("openrouter", openrouterDescriptor.defaultEndpoint),
      { fetch: openrouterRefreshFetch, secrets: { "api-key": "sk-not-logged" }, managedRuntime: codexRuntime, environment: {} },
    );
    const openrouterAccess = await openrouterRefreshAdapter.executionAccess();
    expect(openrouterRefreshFetch, "unpopulated OpenRouter startup rediscovers before execution").toHaveBeenCalledTimes(2);
    expect(openrouterRefreshFetch.mock.calls.map(([url]) => url),
      "OpenRouter rediscovery hits the key probe then the catalog").toEqual([
      `${openrouterDescriptor.defaultEndpoint}/key`,
      `${openrouterDescriptor.defaultEndpoint}/models`,
    ]);
    expect(openrouterAccess.modelCapabilities["z-ai/glm-5.3"],
      "OpenRouter rediscovery populates capabilities").toEqual({
      contextWindow: 196_608,
      maxOutputTokens: 131_072,
    });

    const vercelRefreshFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{
        id: "deepseek/deepseek-v4-pro-0813",
        type: "language",
        context_window: 1_000_000,
        max_tokens: 384_000,
      }] }),
    }));
    const vercelRefreshAdapter = productionProviderAdapterRegistry.create(
      definition("vercel-ai-router", vercelDescriptor.defaultEndpoint),
      { fetch: vercelRefreshFetch, secrets: { "api-key": "sk-not-logged" }, managedRuntime: codexRuntime, environment: {} },
    );
    const vercelAccess = await vercelRefreshAdapter.executionAccess();
    expect(vercelRefreshFetch, "Vercel rediscovery uses the single catalog call").toHaveBeenCalledOnce();
    expect(vercelAccess.modelCapabilities["deepseek/deepseek-v4-pro-0813"],
      "Vercel rediscovery populates capabilities").toEqual({
      contextWindow: 1_000_000,
      maxOutputTokens: 384_000,
    });

    const rejectedRediscoveryFetch = vi.fn(async () => ({ ok: false, status: 401 }));
    const rejectedRediscoveryAdapter = productionProviderAdapterRegistry.create(
      definition("openrouter", openrouterDescriptor.defaultEndpoint),
      { fetch: rejectedRediscoveryFetch, secrets: { "api-key": "rejected" }, managedRuntime: codexRuntime, environment: {} },
    );
    await expect(rejectedRediscoveryAdapter.executionAccess(),
      "rejected credentials fail one bounded rediscovery").rejects.toThrow("credentials were rejected");
    expect(rejectedRediscoveryFetch, "bounded rediscovery stops after one call").toHaveBeenCalledOnce();

    const secretAccessRows = [
      ["openai-api", codexRuntime],
      ["openrouter", codexRuntime],
      ["vercel-ai-router", codexRuntime],
      ["anthropic-api", claudeRuntime],
    ];
    expect(secretAccessRows, "secret access isolation inventory").toHaveLength(4);
    for (const [adapterId, managedRuntime] of secretAccessRows) {
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
      expect(await adapter.executionAccess(), `${adapterId} hands out only secret material`).toEqual(
        expect.objectContaining({
          kind: "secret",
          endpoint: descriptor.defaultEndpoint,
          fields: { "api-key": "secret" },
        }),
      );
      expect(await adapter.executionAccess(), `${adapterId} never leaks managed runtime material`)
        .not.toHaveProperty("runtime");
    }

    const revokedFetch = vi.fn(async () => ({ ok: false, status: 401 }));
    const revokedDescriptor = productionProviderAdapterRegistry.get("openai-api");
    const revokedAdapter = productionProviderAdapterRegistry.create(
      definition("openai-api", revokedDescriptor.defaultEndpoint, "revoked-api"),
      { fetch: revokedFetch, secrets: { "api-key": "opaque" }, managedRuntime: codexRuntime, environment: {} },
    );
    const published = [];
    const catalog = new ModelCatalogService({
      adapters: [revokedAdapter], publishSnapshot: async (snapshot) => { published.push(snapshot); },
    });
    await expect(catalog.explicitRefresh("revoked-api"),
      "rejected API credentials publish as disconnected").resolves.toMatchObject({
      provider: { status: "unavailable", unavailableReason: "Provider credentials were rejected." },
      models: [],
    });
    expect(published, "the disconnected snapshot carries the authoritative reason").toEqual([expect.objectContaining({
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
      runtimeDependencies: async () => ({ fetch: revokedFetch, managedRuntime: codexRuntime, environment: {} }),
      idGenerator: () => "revoked-staged",
    });
    await expect(setup.connect({
      adapterId: "openai-api", label: "Revoked", fields: { "api-key": "opaque" },
    }), "staged creation still rejects rejected credentials").rejects.toThrow("Provider credentials were rejected");
    expect(definitions, "rejected staged creation persists nothing").toEqual([]);
    expect(credentialSet, "rejected staged creation stores no credentials").not.toHaveBeenCalled();
    await catalog.close();
  }, 30_000);
});

describe("managed subscription isolation", () => {
  it("guards managed logout and reconnect with leases, deferred preparation, and failure cleanup", async () => {
    const logout = vi.fn(async () => ({ status: "disconnected" }));
    const leaseService = new ProviderDefinitionService({
      registry: createProviderAdapterRegistry([managedDescriptor("fake-managed", {
        create: () => { throw new Error("initial runtime should be reused"); },
      })]),
      definitionStore: { async load() { return [{
        id: "managed-work", adapterId: "fake-managed", label: "Work", endpoint: null,
        accessContract: "managed-runtime@1", credentialReference: null, lifecycleState: "active",
      }]; } },
      credentialStore: {},
      initialRuntimes: new Map([["managed-work", { credentials: { logout } }]]),
    });

    const lease = await leaseService.acquireExecution("managed-work");
    await expect(leaseService.logout("managed-work"),
      "an active execution lease blocks logout for the exact provider").rejects.toThrow("interactions are running");
    expect(logout, "the blocked logout never reaches the runtime").not.toHaveBeenCalled();
    await lease.release();
    await expect(leaseService.logout("managed-work"), "logout succeeds once the lease releases")
      .resolves.toEqual({ status: "disconnected" });

    const accounts = new Map([["managed-work", "connected"], ["managed-personal", "connected"]]);
    const scopedRuntime = (id) => ({ credentials: {
      account: async () => ({ status: accounts.get(id) }),
      logout: async () => { accounts.set(id, "disconnected"); return { status: "disconnected" }; },
    } });
    const changed = [];
    const scopedService = new ProviderDefinitionService({
      registry: createProviderAdapterRegistry([managedDescriptor("fake-managed", {
        create: () => { throw new Error("initial runtimes should be reused"); },
      })]),
      definitionStore: { async load() { return [
        { id: "managed-work", adapterId: "fake-managed", label: "Work", endpoint: null, accessContract: "managed-runtime@1", credentialReference: null, lifecycleState: "active" },
        { id: "managed-personal", adapterId: "fake-managed", label: "Personal", endpoint: null, accessContract: "managed-runtime@1", credentialReference: null, lifecycleState: "active" },
      ]; } },
      credentialStore: {},
      initialRuntimes: new Map([
        ["managed-work", scopedRuntime("managed-work")],
        ["managed-personal", scopedRuntime("managed-personal")],
      ]),
      onRuntimeChanged: async ({ id }) => { changed.push(id); },
    });
    await expect(scopedService.logout("managed-work"), "logout targets the exact definition")
      .resolves.toMatchObject({ status: "disconnected" });
    expect(accounts, "only the targeted definition signs out").toEqual(
      new Map([["managed-work", "disconnected"], ["managed-personal", "connected"]]),
    );
    expect(changed, "only the targeted definition reports a change").toEqual(["managed-work"]);

    const diagnostics = { write: vi.fn(async () => {}) };
    const publicationService = new ProviderDefinitionService({
      registry: createProviderAdapterRegistry([managedDescriptor("fake-managed", {
        create: () => { throw new Error("initial runtime should be reused"); },
      })]),
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
    await expect(publicationService.logout("managed-work"),
      "logout stays disconnected even when catalog publication fails").resolves.toEqual({ status: "disconnected" });
    await expect(publicationService.list(), "the listing reflects the logout").resolves.toEqual([
      expect.objectContaining({
        id: "managed-work",
        connected: false,
        unavailableReason: expect.objectContaining({ code: "provider_logged_out" }),
      }),
    ]);
    expect(diagnostics.write, "the publication failure is diagnosed").toHaveBeenCalledWith(expect.objectContaining({
      category: "provider_logout_catalog_refresh_failed",
      providerId: "managed-work",
    }));

    let accountStatus = "disconnected";
    const published = [];
    const reconnectDefinition = {
      id: "managed-work", adapterId: "fake-managed", label: "Work", endpoint: null,
      accessContract: "managed-runtime@1", credentialReference: null, lifecycleState: "active",
    };
    const reconnectRuntime = {
      providerId: reconnectDefinition.id,
      credentials: {
        login: vi.fn(async () => ({ authUrl: "https://login.example.test/work" })),
        account: vi.fn(async () => ({ status: accountStatus })),
      },
      discover: vi.fn(async () => ({
        provider: { id: reconnectDefinition.id, label: reconnectDefinition.label, status: "available" },
        models: [{ visible: true }],
        systemFamily: { id: reconnectDefinition.id, label: reconnectDefinition.label, modelIds: [] },
      })),
    };
    const prepareRuntime = vi.fn(async () => {});
    const reconnectService = new ProviderDefinitionService({
      registry: createProviderAdapterRegistry([managedDescriptor("fake-managed", { create: () => reconnectRuntime })]),
      definitionStore: {
        async load() { return [reconnectDefinition]; },
        createWithCatalog: vi.fn(async () => { throw new Error("reconnect must not create a definition"); }),
      },
      credentialStore: {},
      initialRuntimes: new Map([[reconnectDefinition.id, reconnectRuntime]]),
      prepareRuntime,
      publishCatalog: async (snapshot) => { published.push(snapshot); },
    });
    const pending = await reconnectService.reconnect(reconnectDefinition.id);
    expect(pending, "reconnect keeps the definition identity").toMatchObject({
      status: "pending", connectionId: reconnectDefinition.id,
      providerDefinition: { id: reconnectDefinition.id },
    });
    expect(pending.login.authUrl, "reconnect opens the managed login").toBe("https://login.example.test/work");
    expect(prepareRuntime, "reconnect defers runtime preparation for the same definition").toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: "fake-managed",
        providerDefinition: expect.objectContaining({ id: reconnectDefinition.id }),
      }),
    );
    await expect(reconnectService.completeConnection(reconnectDefinition.id),
      "a still-disconnected account keeps the connection pending").resolves.toMatchObject({ status: "pending" });
    accountStatus = "connected";
    await expect(reconnectService.completeConnection(reconnectDefinition.id),
      "a connected account completes the reconnect").resolves.toMatchObject({
      status: "connected", providerDefinition: { id: reconnectDefinition.id },
    });
    expect(published, "reconnect publishes exactly one catalog snapshot").toHaveLength(1);
    await expect(reconnectService.list(), "the listing keeps the original definition").resolves.toEqual([
      expect.objectContaining({ id: reconnectDefinition.id }),
    ]);

    for (const operationName of ["reconnect", "recoverUnavailable"]) {
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
        registry: createProviderAdapterRegistry([managedDescriptor("fake-managed", { create: () => repairRuntime })]),
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
      expect(first.kind, `${operationName} leaves unrelated provider leases available`).toBe("lease");
      await first.lease.release();

      const targetLease = operationName === "reconnect"
        ? await service.acquireExecution("managed-repair")
        : null;
      finishPreparation();
      if (targetLease) {
        await expect(repairing, `${operationName} yields to a lease on the exact target`)
          .rejects.toThrow("interactions are running");
        await targetLease.release();
      } else {
        await expect(repairing, `${operationName} completes once preparation finishes`).resolves.toBeDefined();
      }
      await service.close();
    }

    const closeDefinition = {
      id: "managed-work", adapterId: "fake-managed", label: "Work", endpoint: null,
      accessContract: "managed-runtime@1", credentialReference: null, lifecycleState: "active",
    };
    let finishClosePreparation;
    const closePreparation = new Promise((resolve) => { finishClosePreparation = resolve; });
    const login = vi.fn(async () => ({ authUrl: "https://login.example.test/work" }));
    const closeRuntime = vi.fn(async () => {});
    const closingService = new ProviderDefinitionService({
      registry: createProviderAdapterRegistry([managedDescriptor("fake-managed", {
        create: () => { throw new Error("unused"); },
      })]),
      definitionStore: { async load() { return [closeDefinition]; } },
      credentialStore: {},
      initialRuntimes: new Map([[closeDefinition.id, { credentials: { login }, close: closeRuntime }]]),
      prepareRuntime: () => closePreparation,
    });

    const reconnecting = closingService.reconnect(closeDefinition.id);
    await new Promise((resolve) => setImmediate(resolve));
    let closed = false;
    const closing = closingService.close().then(() => { closed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed, "close waits for the running preparation").toBe(false);
    finishClosePreparation();
    await expect(reconnecting, "close cancels the in-flight reconnect").rejects.toThrow("shutting down");
    await closing;
    expect(login, "a drained reconnect never opens the login").not.toHaveBeenCalled();
    expect(closeRuntime, "close still closes the runtime exactly once").toHaveBeenCalledOnce();

    const terminalDefinition = {
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
      providerId: terminalDefinition.id,
      credentials: {
        login: vi.fn(async () => ({ authUrl: "https://login.example.test/work" })),
        account: vi.fn(async () => ({ status: "connected" })),
      },
      discover: vi.fn(async () => ({
        provider: { id: terminalDefinition.id, label: terminalDefinition.label, status: "available" },
        models: [{ visible: true }],
        systemFamily: { id: terminalDefinition.id, label: terminalDefinition.label, modelIds: [] },
      })),
    };
    const create = vi.fn(() => replacementRuntime);
    const removed = vi.fn(async () => {});
    const terminalService = new ProviderDefinitionService({
      registry: createProviderAdapterRegistry([managedDescriptor("fake-managed", { create })]),
      definitionStore: { async load() { return [terminalDefinition]; } },
      credentialStore: {},
      initialRuntimes: new Map([[terminalDefinition.id, failedRuntime]]),
      onRuntimeRemoved: removed,
      publishCatalog: vi.fn(async () => {}),
    });
    await expect(terminalService.reconnect(terminalDefinition.id), "reconnect starts pending")
      .resolves.toMatchObject({ status: "pending" });
    await expect(terminalService.completeConnection(terminalDefinition.id),
      "a terminal account failure surfaces").rejects.toThrow("managed account check failed");
    expect(failedRuntime.close, "the failed runtime is closed").toHaveBeenCalledOnce();
    expect(removed, "the failed runtime is removed").toHaveBeenCalledWith(
      expect.objectContaining({ id: terminalDefinition.id }),
    );
    await expect(terminalService.reconnect(terminalDefinition.id),
      "the same definition can reconnect after cleanup").resolves.toMatchObject({
      status: "pending", connectionId: terminalDefinition.id,
    });
    expect(create, "the replacement runtime is created exactly once").toHaveBeenCalledOnce();
    await expect(terminalService.completeConnection(terminalDefinition.id),
      "the replacement runtime completes the connection").resolves.toMatchObject({
      status: "connected", providerDefinition: { id: terminalDefinition.id },
    });
  }, 45_000);

  it("completes or cancels staged managed login without persisting pending setup", async () => {
    let accountStatus = "disconnected";
    let stored = [];
    const close = vi.fn(async () => {});
    const registry = createProviderAdapterRegistry([managedDescriptor("fake-managed", {
      create: ({ definition: created }) => ({
        credentials: {
          login: async () => ({ loginId: "login-1", authUrl: "https://login.example.test" }),
          account: async () => ({ status: accountStatus }),
        },
        catalog: { discover: async () => ({ provider: { id: created.id }, models: [{ visible: true }] }) },
        close,
      }),
    })]);
    const removals = [];
    const service = new ProviderDefinitionService({
      registry,
      definitionStore: { async load() { return structuredClone(stored); }, async save(value) { stored = structuredClone(value); } },
      credentialStore: { async set() {}, async get() { return {}; }, async delete() {} },
      idGenerator: (() => { let id = 0; return () => `managed-${++id}`; })(),
      removeRuntimeState: async (candidate) => { removals.push(candidate.id); },
    });
    const pending = await service.connect({ adapterId: "fake-managed", label: "Managed Work" });
    expect(pending, "managed login starts pending with a login id").toMatchObject({
      status: "pending", connectionId: "managed-1", login: { loginId: "login-1" },
    });
    expect(stored, "pending setup persists nothing").toEqual([]);
    await expect(service.completeConnection(pending.connectionId),
      "a disconnected account keeps setup pending").resolves.toMatchObject({ status: "pending" });
    accountStatus = "connected";
    await expect(service.completeConnection(pending.connectionId),
      "a connected account commits the definition").resolves.toMatchObject({
      status: "connected", providerDefinition: { id: "managed-1" },
    });
    expect(stored, "only the committed setup persists").toHaveLength(1);

    const cancelled = await service.connect({ adapterId: "fake-managed", label: "Managed Personal" });
    expect(await service.cancelConnection(cancelled.connectionId), "cancellation reports success").toBe(true);
    expect(stored, "cancelled setup persists nothing").toHaveLength(1);
    expect(close, "cancelled setup closes its runtime").toHaveBeenCalledOnce();
    expect(removals, "cancelled setup removes its runtime state").toEqual(["managed-2"]);

    let releaseDiscovery;
    const discoveryGate = new Promise((resolve) => { releaseDiscovery = resolve; });
    let racingStored = [];
    const racingClose = vi.fn(async () => {});
    const racingService = new ProviderDefinitionService({
      registry: createProviderAdapterRegistry([managedDescriptor("racing-managed", {
        create: ({ definition: created }) => ({
          credentials: {
            login: async () => ({ loginId: "login-race" }),
            account: async () => ({ status: "connected" }),
          },
          catalog: { discover: async () => {
            await discoveryGate;
            return { provider: { id: created.id }, models: [{ visible: true }] };
          } },
          close: racingClose,
        }),
      })]),
      definitionStore: {
        async load() { return structuredClone(racingStored); },
        async createWithCatalog(candidate) { racingStored.push(structuredClone(candidate)); },
      },
      credentialStore: { async delete() {} },
      idGenerator: () => "managed-race",
    });
    const racingPending = await racingService.connect({ adapterId: "racing-managed", label: "Race" });
    const completion = racingService.completeConnection(racingPending.connectionId);
    const cancellation = racingService.cancelConnection(racingPending.connectionId);
    releaseDiscovery();
    await expect(completion, "discovery completes the connection").resolves.toMatchObject({ status: "connected" });
    await expect(cancellation, "cancellation serializes behind discovery and loses").resolves.toBe(false);
    expect(racingStored, "the committed runtime survives the race").toHaveLength(1);
    expect(racingClose, "a committed runtime is never closed by cancellation").not.toHaveBeenCalled();

    let failedStored = [];
    const removed = [];
    const failedClose = vi.fn(async () => {});
    const failedService = new ProviderDefinitionService({
      registry: createProviderAdapterRegistry([managedDescriptor("failed-managed", {
        create: ({ definition: created }) => ({
          credentials: {
            login: async () => ({ loginId: "login-failed" }),
            account: async () => ({ status: "connected" }),
          },
          catalog: { discover: async () => ({
            provider: { id: created.id }, models: [{ visible: true }],
          }) },
          close: failedClose,
        }),
      })]),
      definitionStore: {
        async load() { return structuredClone(failedStored); },
        async createWithCatalog(candidate) { failedStored.push(structuredClone(candidate)); },
      },
      credentialStore: { async delete() {} },
      idGenerator: () => "managed-failed",
      onRuntimeReady: async () => { throw new Error("registration failed"); },
      onRuntimeRemoved: async ({ id }) => { removed.push(id); },
    });
    const failedPending = await failedService.connect({ adapterId: "failed-managed", label: "Failed" });
    await expect(failedService.completeConnection(failedPending.connectionId),
      "registration failure surfaces").rejects.toThrow("registration failed");
    expect(failedStored, "failed registration persists nothing").toEqual([]);
    expect(failedClose, "failed registration closes the runtime").toHaveBeenCalledOnce();
    expect(removed, "failed registration removes the runtime").toEqual(["managed-failed"]);
  }, 30_000);
});

describe("retry and local diagnostics", () => {
  it("bounds provider IO with transient-only retry and a redacted rotating log", async () => {
    const delays = [];
    const operation = vi.fn()
      .mockRejectedValueOnce(new ProviderHttpError("busy", { status: 429 }))
      .mockRejectedValueOnce(new ProviderHttpError("down", { status: 503 }))
      .mockResolvedValue("ok");
    await expect(withProviderRetry(operation, {
      random: () => 0.5,
      sleep: async (delay) => { delays.push(delay); },
    }), "transient classes retry with bounded deterministic jitter").resolves.toBe("ok");
    expect(delays, "the jitter schedule is exact").toEqual([250, 500]);
    await expect(withProviderRetry(async () => {
      throw new ProviderHttpError("bad key", { status: 401 });
    }, { sleep: vi.fn() }), "auth failures never retry").rejects.toThrow("bad key");

    const controller = new AbortController();
    const sleep = vi.fn(async (_delay, signal) => {
      controller.abort(new Error("cancelled"));
      signal.throwIfAborted();
    });
    await expect(withProviderRetry(async () => {
      throw new ProviderHttpError("busy", { status: 429 });
    }, { signal: controller.signal, sleep }), "cancellation stops retry").rejects.toThrow("cancelled");

    const root = await mkdtemp(join(tmpdir(), "relayer-provider-log-"));
    const path = join(root, "provider.log");
    const log = createProviderDiagnosticsLog({ path, maximumBytes: 512 });
    for (let index = 0; index < 20; index += 1) {
      await log.write({ code: `failure-${index}`, apiKey: "sk-super-secret-value", message: "Bearer hidden-value" });
    }
    const contents = await readFile(path, "utf8");
    expect(Buffer.byteLength(contents), "the log rotates at its byte bound").toBeLessThanOrEqual(512);
    expect(contents, "secret api keys are redacted").not.toContain("super-secret");
    expect(contents, "secret bearer tokens are redacted").not.toContain("hidden-value");
    expect(contents, "the newest failure survives rotation").toContain("failure-19");

    const concurrentRoot = await mkdtemp(join(tmpdir(), "relayer-provider-log-concurrent-"));
    const concurrentPath = join(concurrentRoot, "provider.log");
    const concurrentLog = createProviderDiagnosticsLog({ path: concurrentPath, maximumBytes: 16 * 1024 });
    await Promise.all(Array.from({ length: 40 }, (_, index) => concurrentLog.write({
      code: `failure-${index}`,
      error: `opaque-private-value-${index}`,
    })));
    const concurrentContents = await readFile(concurrentPath, "utf8");
    const events = concurrentContents.trim().split("\n").map((line) => JSON.parse(line));
    expect(events, "concurrent writes serialize without loss").toHaveLength(40);
    expect(new Set(events.map(({ code }) => code)).size, "every concurrent event stays unique").toBe(40);
    expect(concurrentContents, "arbitrary error text never persists").not.toContain("opaque-private-value");
  }, 15_000);
});

describe("managed provider runtime cleanup", () => {
  it("removes only definition-scoped runtime state and reconciles orphans", async () => {
    const customRoot = await mkdtemp(join(tmpdir(), "relayer-provider-runtime-custom-"));
    await mkdir(join(customRoot, "future-work"), { recursive: true });
    const registry = createProviderAdapterRegistry([managedDescriptor("future-subscription", {
      connection: { mode: "existing-runtime-auth", fields: [] },
      create: () => ({}),
    })]);
    const customRemover = createProviderRuntimeStateRemover({ runtimeRoot: customRoot, registry });
    await expect(customRemover({
      id: "future-work", adapterId: "future-subscription", accessContract: "managed-runtime@1",
    }), "cleanup eligibility comes from the registry descriptor, not adapter names").resolves.toBe(true);
    await expect(access(join(customRoot, "future-work")), "the custom runtime directory is gone")
      .rejects.toMatchObject({ code: "ENOENT" });

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
    }), "the exact definition-scoped directory is removed").resolves.toBe(true);
    await expect(access(work), "the removed definition directory is gone").rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(personal, "claude-home", "auth.json"), "utf8"),
      "sibling definitions stay untouched").resolves.toBe("personal");
    await expect(removeRuntimeState({ id: "api", adapterId: "openai-api" }),
      "a definition without managed state removes nothing").resolves.toBe(false);

    const apiRoot = await mkdtemp(join(tmpdir(), "relayer-provider-runtime-api-remove-"));
    await mkdir(join(apiRoot, "openai-work", "codex-home"), { recursive: true });
    const apiRemover = createProviderRuntimeStateRemover({
      runtimeRoot: apiRoot,
      registry: productionProviderAdapterRegistry,
    });
    await expect(apiRemover({
      id: "openai-work",
      adapterId: "openai-api",
      accessContract: "secret@1",
    }), "API adapters keep definition-scoped state removable").resolves.toBe(true);
    await expect(access(join(apiRoot, "openai-work")), "the API runtime directory is gone")
      .rejects.toMatchObject({ code: "ENOENT" });

    const traversalCases = [
      ["parent traversal", { id: "../escape", adapterId: "codex-subscription", accessContract: "managed-runtime@1" }],
      ["absolute paths", { id: "/absolute", adapterId: "claude-subscription", accessContract: "managed-runtime@1" }],
    ];
    expect(traversalCases, "path traversal inventory").toHaveLength(2);
    for (const [label, candidate] of traversalCases) {
      expect.soft(() => providerRuntimeDirectory("/tmp/provider-runtimes", candidate, productionProviderAdapterRegistry),
        label).toThrow("stable provider definition id");
    }

    const reconcileRoot = await mkdtemp(join(tmpdir(), "relayer-provider-runtime-reconcile-"));
    for (const name of ["codex-active", "openai-active", "claude-orphan", "api-artifact"]) {
      await mkdir(join(reconcileRoot, name), { recursive: true });
      await writeFile(join(reconcileRoot, name, "state"), name);
    }
    const reconciler = createProviderRuntimeStateRemover({
      runtimeRoot: reconcileRoot, registry: productionProviderAdapterRegistry,
    });
    await expect(reconciler.reconcile([
      {
        id: "codex-active", adapterId: "codex-subscription", accessContract: "managed-runtime@1",
        lifecycleState: "active",
      },
      {
        id: "openai-active", adapterId: "openai-api", accessContract: "secret@1",
        lifecycleState: "active",
      },
    ]), "reconciliation reports exactly the removed orphans").resolves.toEqual(["api-artifact", "claude-orphan"]);
    await expect(readFile(join(reconcileRoot, "codex-active", "state"), "utf8"),
      "active managed definitions keep their state").resolves.toBe("codex-active");
    await expect(readFile(join(reconcileRoot, "openai-active", "state"), "utf8"),
      "active API definitions keep their state").resolves.toBe("openai-active");
    await expect(access(join(reconcileRoot, "claude-orphan")), "orphan managed directories are removed")
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(reconcileRoot, "api-artifact")), "stray API artifacts are removed")
      .rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);
});

describe("provider definition lifecycle", () => {
  it("stages provider creation discovery-first and compensates every failure", async () => {
    const fixture = serviceFixture();
    const created = await fixture.service.connect({
      adapterId: "fake-api", label: "Work", endpoint: "https://example.test/v1", fields: { "api-key": "secret" },
    });
    expect(created, "a discovered provider connects").toMatchObject({
      status: "connected", providerDefinition: { id: "provider-1" },
    });
    expect(JSON.stringify(fixture.definitions()), "definitions never carry secret bytes")
      .not.toContain('"api-key":"secret"');
    expect(created.providerDefinition.credentialReference, "definitions carry a credential reference")
      .toBe("provider:provider-1");

    fixture.service.providerStatuses = async () => new Map([[created.providerDefinition.id, {
      connected: false,
      unavailableReason: { code: "credentials_revoked", message: "Reconnect this provider." },
    }]]);
    await expect(fixture.service.list(), "listings join authoritative connection state").resolves.toEqual([
      expect.objectContaining({
        id: created.providerDefinition.id,
        connected: false,
        unavailableReason: { code: "credentials_revoked", message: "Reconnect this provider." },
      }),
    ]);

    const failed = serviceFixture({ failDiscovery: true });
    await expect(failed.service.connect({
      adapterId: "fake-api", label: "Broken", fields: { "api-key": "secret" },
    }), "failed discovery surfaces the provider error").rejects.toThrow("discovery failed");
    expect(failed.definitions(), "failed discovery persists nothing").toEqual([]);
    expect(failed.credentials.size, "failed discovery stores no credentials").toBe(0);

    const order = [];
    const deleted = [];
    const orderedService = new ProviderDefinitionService({
      registry: createProviderAdapterRegistry([{
        adapterId: "ordered-api", implementationVersion: "1", label: "Ordered", accessContract: "secret@1",
        defaultEndpoint: "https://example.test/v1", connection: {
          mode: "secret-fields", fields: [{ id: "key", label: "Key", kind: "secret" }],
        },
        create: () => ({ discover: async () => {
          order.push("discover");
          return { models: [{ visible: true }] };
        } }),
      }]),
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
    await expect(orderedService.connect({ adapterId: "ordered-api", label: "Ordered", fields: { key: "opaque" } }),
      "a failed atomic commit surfaces").rejects.toThrow("commit failed");
    expect(order, "credentials are written only after discovery and before commit")
      .toEqual(["discover", "credential", "commit"]);
    expect(deleted, "a failed commit deletes the staged credential").toEqual(["provider:ordered"]);
    await expect(orderedService.list(), "a failed commit leaves no definition").resolves.toEqual([]);

    const unregistered = [];
    const registrationFixture = serviceFixture();
    registrationFixture.service.onRuntimeReady = async () => { throw new Error("runtime registration failed"); };
    registrationFixture.service.onRuntimeRemoved = async ({ id }) => { unregistered.push(id); };
    await expect(registrationFixture.service.connect({
      adapterId: "fake-api", label: "Broken registration", fields: { "api-key": "opaque" },
    }), "failed runtime registration surfaces").rejects.toThrow("runtime registration failed");
    expect(registrationFixture.definitions(), "failed registration leaves no definition").toEqual([]);
    expect(registrationFixture.credentials.size, "failed registration stores no credentials").toBe(0);
    expect(registrationFixture.closes, "failed registration closes the staged runtime").toEqual(["provider-1"]);
    expect(unregistered, "failed registration unregisters the runtime").toEqual(["provider-1"]);

    const events = [];
    const sanitized = serviceFixture({
      failDiscovery: true,
      diagnostics: { write: async (event) => { events.push(event); } },
    });
    await expect(sanitized.service.connect({ adapterId: "fake-api", label: "Broken", fields: { key: "opaque" } }),
      "sanitized logging still surfaces discovery failures").rejects.toThrow("discovery failed");
    expect(JSON.stringify(events), "diagnostics never carry raw error text").not.toContain("discovery failed");
    expect(events[0], "diagnostics carry sanitized metadata").toMatchObject({
      category: "provider_connection_failed", code: "unknown",
    });
    const orphaned = [];
    const restarted = new ProviderDefinitionService({
      registry: sanitized.service.registry,
      definitionStore: { async load() { return []; } },
      credentialStore: {
        async listReferences() { return ["provider:orphan"]; },
        async delete(reference) { orphaned.push(reference); },
      },
    });
    await restarted.reconcileStartup();
    expect(orphaned, "startup cleans crash-window orphan credentials").toEqual(["provider:orphan"]);

    let attempts = 0;
    const delays = [];
    let stored = [];
    const retryService = new ProviderDefinitionService({
      registry: createProviderAdapterRegistry([{
        adapterId: "retry-api", implementationVersion: "1", label: "Retry", accessContract: "secret@1",
        defaultEndpoint: "https://example.test/v1", connection: { mode: "secret-fields", fields: [{ id: "key", label: "Key", kind: "secret" }] },
        create: () => ({ discover: async () => {
          attempts += 1;
          if (attempts < 3) throw new ProviderHttpError("busy", { status: 503 });
          return { models: [{ visible: true }] };
        } }),
      }]),
      definitionStore: { async load() { return stored; }, async save(value) { stored = structuredClone(value); } },
      credentialStore: { async set() {}, async delete() {}, async get() { return {}; } },
      retry: { random: () => 0.5, sleep: async (delay) => { delays.push(delay); } },
      idGenerator: () => "retry-provider",
    });
    await expect(retryService.connect({ adapterId: "retry-api", label: "Retry", fields: { key: "hidden" } }),
      "staged discovery retries transient failures").resolves.toMatchObject({ status: "connected" });
    expect(attempts, "staged discovery uses bounded retry").toBe(3);
    expect(delays, "staged discovery uses the deterministic jitter schedule").toEqual([250, 500]);
  }, 30_000);

  it("drains admitted work before tombstoning and reconciles durable removal failures", async () => {
    const removals = [];
    const fixture = serviceFixture({ removeRuntimeState: async (candidate) => { removals.push(candidate.id); } });
    const first = await fixture.service.connect({ adapterId: "fake-api", label: "Work", fields: { "api-key": "one" } });
    await expect(fixture.service.connect({ adapterId: "fake-api", label: "work", fields: { "api-key": "two" } }),
      "active labels stay case-insensitively unique").rejects.toThrow("already uses");
    const providerId = first.providerDefinition.id;
    const admission = await fixture.service.acquireExecution(providerId);
    const pending = await fixture.service.remove(providerId);
    expect(pending.lifecycleState, "removal defers while work is admitted").toBe("removal_pending");
    await expect(fixture.service.acquireExecution(providerId), "pending removal stops new admissions")
      .rejects.toThrow("unavailable");
    expect(fixture.credentials.size, "pending removal keeps credentials until drained").toBe(1);
    expect(removals, "pending removal deletes nothing until drained").toEqual([]);
    await admission.release();
    expect(fixture.definitions()[0], "draining tombstones the definition").toMatchObject({
      lifecycleState: "tombstoned", credentialReference: null,
    });
    expect(fixture.credentials.size, "draining deletes the credential").toBe(0);
    expect(removals, "draining removes the runtime state").toEqual([providerId]);

    const durableRemovals = [];
    const durableFixture = serviceFixture({ removeRuntimeState: async ({ id }) => { durableRemovals.push(id); } });
    const durable = await durableFixture.service.connect({
      adapterId: "fake-api", label: "Durable", fields: { "api-key": "opaque" },
    });
    const originalSave = durableFixture.service.definitionStore.save.bind(durableFixture.service.definitionStore);
    durableFixture.service.definitionStore.save = async (definitions) => {
      if (definitions.some(({ lifecycleState }) => lifecycleState === "tombstoned")) {
        throw new Error("durable attempt still running");
      }
      await originalSave(definitions);
    };
    await expect(durableFixture.service.remove(durable.providerDefinition.id),
      "a failed tombstone surfaces").rejects.toThrow("durable attempt still running");
    expect(durableFixture.definitions()[0], "a failed tombstone leaves removal pending").toMatchObject({
      lifecycleState: "removal_pending", credentialReference: `provider:${durable.providerDefinition.id}`,
    });
    expect(durableFixture.credentials.size, "a failed tombstone keeps the credential").toBe(1);
    expect(durableFixture.closes, "a failed tombstone keeps the runtime open").toEqual([]);
    expect(durableRemovals, "a failed tombstone deletes no runtime state").toEqual([]);
    const reconciled = new ProviderDefinitionService({
      registry: durableFixture.service.registry,
      definitionStore: {
        async load() { return structuredClone(durableFixture.definitions()); },
        async save(value) { durableFixture.definitions().splice(0, Infinity, ...structuredClone(value)); },
      },
      credentialStore: {
        async get(key) { return durableFixture.credentials.get(key) ?? null; },
        async delete(key) { return durableFixture.credentials.delete(key); },
        async listReferences() { return [...durableFixture.credentials.keys()]; },
      },
      removeRuntimeState: async ({ id }) => { durableRemovals.push(id); },
    });
    await reconciled.reconcileStartup();
    expect(durableFixture.definitions()[0], "restart finalizes the pending tombstone").toMatchObject({
      lifecycleState: "tombstoned", credentialReference: null,
    });
    expect(durableFixture.credentials.size, "restart deletes the durable credential").toBe(0);
    expect(durableRemovals, "restart removes the durable runtime state").toEqual([durable.providerDefinition.id]);

    const rollbackFixture = serviceFixture();
    const stable = await rollbackFixture.service.connect({
      adapterId: "fake-api", label: "Stable", fields: { "api-key": "one" },
    });
    rollbackFixture.service.definitionStore.save = async () => { throw new Error("authoritative guard rejected"); };
    await expect(rollbackFixture.service.rename(stable.providerDefinition.id, "Changed"),
      "rejected rename persistence surfaces").rejects.toThrow("authoritative guard rejected");
    await expect(rollbackFixture.service.remove(stable.providerDefinition.id),
      "rejected removal persistence surfaces").rejects.toThrow("authoritative guard rejected");
    await expect(rollbackFixture.service.list(), "rejected persistence rolls back cached state").resolves.toEqual([
      expect.objectContaining({ label: "Stable", lifecycleState: "active" }),
    ]);
    const rollbackLease = await rollbackFixture.service.acquireExecution(stable.providerDefinition.id);
    await rollbackLease.release();

    const finalizeFixture = serviceFixture();
    await finalizeFixture.service.connect({ adapterId: "fake-api", label: "Old", fields: { "api-key": "secret" } });
    finalizeFixture.definitions()[0].lifecycleState = "removal_pending";
    const finalizeRemovals = [];
    const finalizing = new ProviderDefinitionService({
      registry: finalizeFixture.service.registry,
      definitionStore: {
        async load() { return structuredClone(finalizeFixture.definitions()); },
        async save(value) { finalizeFixture.definitions().splice(0, Infinity, ...structuredClone(value)); },
      },
      credentialStore: {
        async get(key) { return finalizeFixture.credentials.get(key) ?? null; },
        async delete(key) { return finalizeFixture.credentials.delete(key); },
      },
      removeRuntimeState: async (candidate) => { finalizeRemovals.push(candidate.id); },
    });
    await finalizing.reconcileStartup();
    expect(finalizeFixture.definitions()[0], "startup finalizes removal-pending definitions").toMatchObject({
      lifecycleState: "tombstoned", credentialReference: null,
    });
    expect(finalizeFixture.credentials.size, "startup deletes the pending credential").toBe(0);
    expect(finalizeRemovals, "startup removes the pending runtime state").toEqual(["provider-1"]);
  }, 30_000);

  it("activates persisted providers best-effort and refreshes catalogs without overlap", async () => {
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
    expect(discoveries, "persisted providers register before startup refresh").toBe(1);
    expect(published.some(({ providerId }) => providerId === "persisted"),
      "startup publishes the persisted provider").toBe(true);
    await modelCatalog.explicitRefresh("persisted");
    expect(discoveries, "manual refresh rediscovers on demand").toBe(2);

    const ready = [];
    const diagnostics = [];
    const partialRegistry = createProviderAdapterRegistry([{
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
    const partialService = new ProviderDefinitionService({
      registry: partialRegistry,
      definitionStore: { async load() { return persisted; } },
      credentialStore: { async get(reference) { return reference.endsWith("healthy") ? { key: "valid" } : null; } },
      diagnostics: { write: async (event) => { diagnostics.push(event); } },
      onRuntimeReady: (definition) => { ready.push(definition.id); },
    });
    await expect(partialService.activate(), "activation continues past one revoked provider")
      .resolves.toBeUndefined();
    expect(ready, "only the healthy provider activates").toEqual(["healthy"]);
    expect(diagnostics, "the revoked provider is diagnosed").toEqual([expect.objectContaining({
      category: "provider_activation_failed", providerId: "revoked", code: "unknown",
    })]);
    await expect(partialService.acquireExecution("revoked"), "revoked providers cannot execute")
      .rejects.toThrow("credentials are unavailable");

    const unavailable = [];
    const missingDescriptor = {
      adapterId: "fake-api", implementationVersion: "1", label: "Fake", accessContract: "secret@1",
      defaultEndpoint: "https://example.test/v1", connection: {
        mode: "secret-fields", fields: [{ id: "key", label: "Key", kind: "secret" }],
      },
      create: vi.fn(),
    };
    const missingService = new ProviderDefinitionService({
      registry: createProviderAdapterRegistry([missingDescriptor]),
      definitionStore: { async load() { return [{
        id: "missing", adapterId: "fake-api", label: "Missing", endpoint: "https://example.test/v1",
        accessContract: "secret@1", credentialReference: "provider:missing", lifecycleState: "active",
      }]; } },
      credentialStore: { async get() { return null; } },
      providerStatuses: async () => new Map([["missing", { connected: true, unavailableReason: null }]]),
      onRuntimeUnavailable: async (definition, error) => { unavailable.push({ definition, error }); },
    });
    await missingService.activate();
    expect(missingDescriptor.create, "a missing credential never instantiates the adapter").not.toHaveBeenCalled();
    expect(unavailable, "the missing credential reports unavailable").toHaveLength(1);
    expect(unavailable[0].definition.id, "the unavailable report names the definition").toBe("missing");
    expect(unavailable[0].error.message, "the unavailable report names the credential gap")
      .toContain("credentials are unavailable");
    await expect(missingService.list(), "listings show the activation failure").resolves.toEqual([
      expect.objectContaining({
        id: "missing",
        connected: false,
        unavailableReason: expect.objectContaining({ code: "provider_activation_failed" }),
      }),
    ]);

    const closedGenerations = [];
    let creations = 0;
    let registrations = 0;
    const lazyRegistry = createProviderAdapterRegistry([{
      adapterId: "lazy-api", implementationVersion: "1", label: "Lazy", accessContract: "secret@1",
      defaultEndpoint: "https://example.test/v1", connection: {
        mode: "secret-fields", fields: [{ id: "key", label: "Key", kind: "secret" }],
      },
      create: () => {
        creations += 1;
        const generation = creations;
        return { close: async () => { closedGenerations.push(generation); } };
      },
    }]);
    const lazyService = new ProviderDefinitionService({
      registry: lazyRegistry,
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
    await lazyService.activate();
    expect(closedGenerations, "a failed registration closes its generation").toEqual([1]);
    const lazyLease = await lazyService.acquireExecution("lazy");
    expect(creations, "a failed registration is never cached").toBe(2);
    expect(registrations, "the next admission registers again").toBe(2);
    await lazyLease.release();

    const bootPublished = [];
    const bootService = new ModelCatalogService({
      adapters: [
        { providerId: "revoked", discover: async () => { throw new ProviderHttpError("revoked", { status: 401 }); } },
        { providerId: "healthy", discover: async () => completeSnapshot("healthy") },
      ],
      publishSnapshot: async (snapshot) => { bootPublished.push(snapshot); },
      setTimer: () => ({ unref() {} }),
    });
    const results = await bootService.startup();
    expect(results.map(({ status }) => status), "startup boots best-effort across providers")
      .toEqual(["rejected", "fulfilled"]);
    expect(bootPublished.map(({ providerId }) => providerId), "only healthy providers publish on boot")
      .toEqual(["healthy"]);
    await bootService.close();

    const callbacks = [];
    const cleared = [];
    const unref = vi.fn();
    let calls = 0;
    let rejectBackground;
    const backgroundFailure = new Promise((_resolve, reject) => { rejectBackground = reject; });
    const timerPublished = [];
    const timerService = new ModelCatalogService({
      adapters: [{ providerId: "scheduled", discover: async () => {
        calls += 1;
        if (calls === 1) return completeSnapshot("scheduled");
        return backgroundFailure;
      } }],
      publishSnapshot: async (snapshot) => { timerPublished.push(snapshot); },
      setTimer: (callback) => { const token = { callback, unref }; callbacks.push(token); return token; },
      clearTimer: (token) => { cleared.push(token); },
      backgroundIntervalMs: 10,
    });
    await timerService.startup();
    expect(unref, "the background timer never holds the process").toHaveBeenCalledOnce();
    const tick = callbacks[0].callback();
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls, "the tick rediscovers the provider").toBe(2);
    expect(callbacks, "a running tick never overlaps with a new timer").toHaveLength(1);
    rejectBackground(new Error("temporarily unavailable"));
    await tick;
    expect(timerPublished, "a failed tick retains the last snapshot").toHaveLength(1);
    expect(callbacks, "the next timer arms after the tick settles").toHaveLength(2);
    await timerService.close();
    expect(cleared, "close cancels the pending timer").toEqual([callbacks[1]]);
  }, 30_000);
});
