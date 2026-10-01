import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { createHarnessReadinessCoordinator } from "../main/services/harness-readiness.mjs";

import { createLiveCredentialValidator, createLiveModelRouteResolver } from "./live-credentials.mjs";

const reference = "connected-product-provider";
const model = { harnessId: "codex-basic", familyId: 1, providerId: "router", modelId: "model-a" };

function modelSettings({ providerId = "router", adapterId = "openrouter", connected = true, models = [{ id: "model-a", visible: true, available: true }] } = {}) {
  return {
    harnesses: [{ id: "codex-basic", available: true, compatibleProviderIds: [providerId] }],
    defaults: { harnessId: "codex-basic", familyId: 1 },
    families: [{ id: 1, enabled: true, position: 0, members: [{ providerId, modelId: "model-a", position: 0 }] }],
    providers: [{ id: providerId, adapterId, connected, models }],
  };
}

function resolver(settings, overrides = {}) {
  return createLiveModelRouteResolver({
    readModelSettings: async () => settings,
    readDefaultModelSelection: async () => model,
    ...overrides,
  });
}

describe("live Eval credential validation", () => {
  it("pins the selected connected API route without requiring a Codex subscription", async () => {
    const ensureCodexModelCatalog = vi.fn();
    const resolveModelRoute = resolver(modelSettings(), { ensureCodexModelCatalog });
    const validate = createLiveCredentialValidator({ resolveModelRoute });

    await expect(validate({ name: "codex-basic", implementation: "codex.basic" }, reference)).resolves.toEqual({
      selectedModel: model,
      productModelSelection: true,
      providerAdapterId: "openrouter",
    });
    expect(ensureCodexModelCatalog).not.toHaveBeenCalled();
  });

  it("validates and preserves a configuration-owned Codex model instead of requiring a product family", async () => {
    const configuration = parse(await readFile(new URL("../../harnesses/codex-layered-navigation-luna.yaml", import.meta.url), "utf8"));
    const settings = {
      harnesses: [{ id: "codex-layered-navigation-luna", available: false, compatibleProviderIds: [], modelCompatibility: [] }],
      providers: [],
      families: [],
    };
    const readiness = createHarnessReadinessCoordinator({
      configurations: new Map([[configuration.name, configuration]]),
      digestConfiguration: () => "sha256:luna-fixture",
      runtimeRequirements: { "codex.basic": { recipeId: "codex-test" } },
      prepareRecipe: async () => ({ executable: "/managed/codex" }),
      checkers: { "codex.basic": async () => ({ available: true }) },
      publishAvailability: async (updates) => {
        for (const update of updates) settings.harnesses[0].available = update.available;
      },
    });
    await readiness.evaluate({
      trigger: "connect",
      providerDefinition: { id: "codex", adapterId: "codex-subscription", accessContract: "managed-runtime@1" },
      models: [{ id: "gpt-5.6-luna", visible: true, availability: "available" }],
    });
    const ensureCodexModelCatalog = vi.fn();
    const close = vi.fn(async () => {});
    const createCredentials = vi.fn(() => ({ account: async () => ({ status: "connected", account: { type: "chatgpt" } }), close }));
    const validate = createLiveCredentialValidator({
      resolveModelRoute: createLiveModelRouteResolver({
        readModelSettings: async () => settings,
        ensureCodexModelCatalog,
      }),
      resolveCodexRuntime: async () => ({ executable: "/managed/codex", environment: {} }),
      createCredentials,
    });
    await expect(validate(configuration, reference)).resolves.toEqual({
      selectedModel: null,
      productModelSelection: false,
      providerAdapterId: "codex-subscription",
      configurationModel: "gpt-5.6-luna",
    });
    expect(ensureCodexModelCatalog).not.toHaveBeenCalled();
    expect(createCredentials).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects a configuration-owned model pin that differs from the admitted harness model", async () => {
    const validate = createLiveCredentialValidator({
      resolveModelRoute: async () => ({
        selectedModel: null,
        productModelSelection: false,
        configurationModel: "gpt-5.6-sol",
        provider: { id: "codex", adapterId: "codex-subscription", connected: true },
      }),
      resolveCodexRuntime: async () => ({ executable: "/managed/codex", environment: {} }),
    });
    await expect(validate({
      name: "codex-layered-navigation-luna",
      implementation: "codex.basic",
      settings: { model: "gpt-5.6-luna" },
    }, reference)).rejects.toThrow("selected live Eval model route is invalid");
  });

  it("bootstraps the Codex catalog for a selected subscription and validates the managed account", async () => {
    const ensureCodexModelCatalog = vi.fn();
    const codexModel = { ...model, providerId: "codex" };
    const settings = modelSettings({ providerId: "codex", adapterId: "codex-subscription" });
    const readModelSettings = vi.fn(async () => settings);
    const close = vi.fn(async () => {});
    const account = vi.fn(async () => ({ status: "connected", account: { type: "chatgpt" } }));
    const createCredentials = vi.fn(() => ({ account, close }));
    const validate = createLiveCredentialValidator({
      resolveModelRoute: createLiveModelRouteResolver({
        readModelSettings,
        ensureCodexModelCatalog,
      }),
      resolveCodexRuntime: async () => ({ executable: "/managed/codex", environment: { CODEX_HOME: "/managed/home" } }),
      createCredentials,
    });

    await expect(validate({ name: "codex-basic", implementation: "codex.basic" }, reference)).resolves.toEqual({
      selectedModel: codexModel,
      productModelSelection: true,
      providerAdapterId: "codex-subscription",
    });
    expect(ensureCodexModelCatalog).toHaveBeenCalledWith("codex-basic");
    expect(readModelSettings).toHaveBeenCalledTimes(2);
    expect(createCredentials).toHaveBeenCalledWith({
      CODEX_HOME: "/managed/home",
      RELAYER_CODEX_BINARY: "/managed/codex",
    });
    expect(account).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("bootstraps Codex on first use when no route is selected, then rereads the catalog", async () => {
    const ensureCodexModelCatalog = vi.fn(async () => {});
    const available = modelSettings({ providerId: "codex", adapterId: "codex-subscription" });
    const readModelSettings = vi.fn().mockResolvedValueOnce({ ...available, families: [] }).mockResolvedValueOnce(available);
    const route = await createLiveModelRouteResolver({ readModelSettings, ensureCodexModelCatalog })({
      name: "codex-basic", implementation: "codex.basic",
    });
    expect(route.selectedModel).toEqual({ ...model, providerId: "codex" });
    expect(ensureCodexModelCatalog).toHaveBeenCalledOnce();
    expect(readModelSettings).toHaveBeenCalledTimes(2);
  });

  it("rejects a selected model missing from the connected provider catalog", async () => {
    const validate = createLiveCredentialValidator({
      resolveModelRoute: resolver(modelSettings({ models: [] })),
    });
    await expect(validate({ name: "codex-basic", implementation: "codex.basic" }, reference))
      .rejects.toThrow("selected live Eval model route is unavailable");
  });

  it("rejects a route resolved for a different harness", async () => {
    const validate = createLiveCredentialValidator({
      resolveModelRoute: async () => ({
        selectedModel: { ...model, harnessId: "other-harness" },
        productModelSelection: true,
        provider: { id: "router", adapterId: "openrouter", connected: true, models: [{ id: "model-a", visible: true, available: true }] },
      }),
    });
    await expect(validate({ name: "codex-basic", implementation: "codex.basic" }, reference))
      .rejects.toThrow("selected live Eval model route is invalid");
  });

  it("pins Claude's product-selected route after reading the current provider catalog", async () => {
    const readDefaultModelSelection = vi.fn(async () => ({ harnessId: "claude-basic", providerId: "anthropic", modelId: "claude" }));
    const settings = {
      providers: [{ id: "anthropic", adapterId: "anthropic-api", connected: true, models: [{ id: "claude", visible: true, available: true }] }],
    };
    const validate = createLiveCredentialValidator({ resolveModelRoute: createLiveModelRouteResolver({
      readModelSettings: async () => settings,
      readDefaultModelSelection,
    }) });
    await expect(validate({ name: "claude-basic", implementation: "claude.basic" }, reference)).resolves.toEqual({
      selectedModel: { harnessId: "claude-basic", providerId: "anthropic", modelId: "claude" },
      productModelSelection: true,
      providerAdapterId: "anthropic-api",
    });
  });

  it("refreshes Prime before reading settings and pins the refreshed route", async () => {
    const order = [];
    const selectPrimeModel = vi.fn(async () => { order.push("select"); return { harnessId: "prime-agent-deep", providerId: "router", modelId: "model-a" }; });
    const readModelSettings = vi.fn(async () => { order.push("settings"); return modelSettings(); });
    const validate = createLiveCredentialValidator({ resolveModelRoute: createLiveModelRouteResolver({
      readModelSettings,
      selectPrimeModel,
    }) });
    await expect(validate({ name: "prime-agent-deep", implementation: "prime.agent" }, reference)).resolves.toEqual({
      selectedModel: { harnessId: "prime-agent-deep", providerId: "router", modelId: "model-a" },
      productModelSelection: true,
      providerAdapterId: "openrouter",
    });
    expect(order).toEqual(["select", "settings"]);
  });

  it("masks failed Prime route details", async () => {
    const validate = createLiveCredentialValidator({ resolveModelRoute: createLiveModelRouteResolver({
      readModelSettings: async () => modelSettings(),
      selectPrimeModel: async () => { throw new Error("secret provider detail"); },
    }) });
    await expect(validate({ name: "prime-agent-deep", implementation: "prime.agent" }, reference))
      .rejects.toThrow("selected live Eval model route is unavailable");
  });

  it("rejects an injected route whose selected model is absent from its provider snapshot", async () => {
    const validate = createLiveCredentialValidator({ resolveModelRoute: async () => ({
      selectedModel: model,
      productModelSelection: true,
      provider: { id: "router", adapterId: "openrouter", connected: true, models: [] },
    }) });
    await expect(validate({ name: "codex-basic", implementation: "codex.basic" }, reference))
      .rejects.toThrow("selected live Eval model route is unavailable");
  });

  it("checks the managed Codex account for the built-in live judge without inventing a model pin", async () => {
    const close = vi.fn(async () => {});
    const validate = createLiveCredentialValidator({
      resolveModelRoute: resolver({ providers: [] }),
      resolveCodexRuntime: async () => ({ executable: "/managed/codex", environment: {} }),
      createCredentials: () => ({ account: async () => ({ status: "connected", account: { type: "chatgpt" } }), close }),
    });
    await expect(validate({ name: "simulated-user", implementation: "codex.basic" }, reference)).resolves.toEqual({
      selectedModel: null,
      productModelSelection: false,
      providerAdapterId: "codex-subscription",
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects a connected Codex API-key account on the subscription adapter", async () => {
    const close = vi.fn(async () => {});
    const validate = createLiveCredentialValidator({
      resolveModelRoute: resolver(modelSettings({ adapterId: "codex-subscription" })),
      resolveCodexRuntime: async () => ({ executable: "/managed/codex", environment: {} }),
      createCredentials: () => ({ account: async () => ({ status: "connected", account: { type: "apiKey" } }), close }),
    });
    await expect(validate({ name: "codex-basic", implementation: "codex.basic" }, reference))
      .rejects.toThrow("Codex credential is not connected");
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(["disconnected", "unavailable"])("rejects a %s Codex account and closes its adapter", async (status) => {
    const close = vi.fn(async () => {});
    const validate = createLiveCredentialValidator({
      resolveModelRoute: resolver(modelSettings({ adapterId: "codex-subscription" })),
      resolveCodexRuntime: async () => ({ executable: "/managed/codex", environment: {} }),
      createCredentials: () => ({ account: async () => ({ status, error: "secret detail" }), close }),
    });
    await expect(validate({ name: "codex-basic", implementation: "codex.basic" }, reference))
      .rejects.toThrow("Codex credential is not connected");
    expect(close).toHaveBeenCalledOnce();
  });

  it("fails closed for invalid references, configurations, and unsupported routes", async () => {
    const resolveModelRoute = vi.fn();
    const validate = createLiveCredentialValidator({ resolveModelRoute });
    await expect(validate({ name: "codex-basic", implementation: "codex.basic" }, "raw-secret"))
      .rejects.toThrow("credential reference is unavailable");
    await expect(validate({ name: "", implementation: "codex.basic" }, reference))
      .rejects.toThrow("configuration is invalid");
    await expect(validate({ name: "fixture", implementation: "fixture.task-system" }, reference))
      .rejects.toThrow("selected provider credential is unavailable");
    expect(resolveModelRoute).toHaveBeenCalledOnce();
  });
});
