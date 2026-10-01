import { CodexCredentialAdapter } from "../main/credentials/codex-credential-adapter.mjs";
import {
  defaultFamilyRecoveryError,
  firstAvailableSelection,
  harnessUsesConfigurationModel,
  requireDefaultModelSelection,
} from "../renderer/src/model-picker-model.js";

const CONNECTED_PRODUCT_PROVIDER = "connected-product-provider";
const CODEX_JUDGE_CONFIGURATION_NAMES = new Set(["simulated-user", "simulated-user-sol-high"]);
const SUPPORTED_PROVIDER_ADAPTERS = new Set([
  "codex-subscription",
  "claude-subscription",
  "openai-api",
  "anthropic-api",
  "openrouter",
  "vercel-ai-router",
]);

export function createLiveModelRouteResolver({
  readModelSettings,
  readDefaultModelSelection,
  ensureCodexModelCatalog = async () => {},
  selectPrimeModel,
} = {}) {
  if (typeof readModelSettings !== "function") {
    throw new TypeError("Live Eval model route resolution requires product model settings.");
  }

  return async function resolveLiveModelRoute(configuration) {
    const implementation = configuration?.implementation;
    const harnessName = configuration?.name;
    if (typeof harnessName !== "string" || harnessName.trim() === "") {
      throw new Error("The live Eval harness configuration is invalid.");
    }

    if (implementation === "codex.basic") {
      if (CODEX_JUDGE_CONFIGURATION_NAMES.has(harnessName)) {
        return {
          selectedModel: null,
          productModelSelection: false,
          provider: { id: "codex", adapterId: "codex-subscription", connected: true },
        };
      }
      let settings = await readModelSettings();
      const configurationModel = configuration?.settings?.model;
      if (typeof configurationModel === "string" && configurationModel.trim() !== ""
        && harnessUsesConfigurationModel(settings, harnessName)) {
        return {
          selectedModel: null,
          productModelSelection: false,
          configurationModel: configurationModel.trim(),
          provider: { id: "codex", adapterId: "codex-subscription", connected: true },
        };
      }
      let selectedModel = firstAvailableSelection(settings, harnessName);
      let provider = providerForSelection(settings, selectedModel);
      // Preserve the legacy first-use Codex catalog bootstrap, but do not
      // require a subscription when this harness already resolves to an API provider.
      if (!selectedModel || provider?.adapterId === "codex-subscription") {
        await ensureCodexModelCatalog(harnessName);
        settings = await readModelSettings();
        selectedModel = firstAvailableSelection(settings, harnessName);
        provider = providerForSelection(settings, selectedModel);
      }
      // A recovering default family is refused, never replaced by another family (PROV-008).
      const recoveryError = selectedModel ? null : defaultFamilyRecoveryError(settings);
      if (recoveryError) throw recoveryError;
      return routeForSelection({
        settings,
        selectedModel,
        provider,
        productModelSelection: !harnessUsesConfigurationModel(settings, harnessName),
        expectedHarnessId: harnessName,
      });
    }

    if (implementation === "claude.basic") {
      if (typeof readDefaultModelSelection !== "function") {
        throw new Error("Claude Eval has no product model-selection reader.");
      }
      const settings = await readModelSettings();
      // A recovering default family is refused with its code (PROV-008).
      const selectedModel = requireDefaultModelSelection(
        await readDefaultModelSelection(harnessName),
        settings,
        "The selected provider has no available model.",
      );
      return routeForSelection({
        settings,
        selectedModel,
        provider: providerForSelection(settings, selectedModel),
        productModelSelection: true,
        expectedHarnessId: harnessName,
      });
    }

    if (implementation === "prime.agent") {
      if (typeof selectPrimeModel !== "function") {
        throw new Error("Prime Eval has no connected model-selection route.");
      }
      const selectedModel = await selectPrimeModel(harnessName);
      const settings = await readModelSettings();
      return routeForSelection({
        settings,
        selectedModel,
        provider: providerForSelection(settings, selectedModel),
        productModelSelection: true,
        expectedHarnessId: harnessName,
      });
    }

    throw new Error("The live Eval harness has no trusted model-selection route.");
  };
}

export function createLiveCredentialValidator({
  resolveCodexRuntime,
  createCredentials = (environment) => new CodexCredentialAdapter({ environment }),
  resolveModelRoute,
} = {}) {
  return async function validateLiveCredential(configuration, credentialReference) {
    if (credentialReference !== CONNECTED_PRODUCT_PROVIDER) {
      throw new Error("The live Eval credential reference is unavailable.");
    }
    if (!configuration || typeof configuration !== "object"
      || typeof configuration.name !== "string" || configuration.name.trim() === ""
      || typeof configuration.implementation !== "string" || configuration.implementation.trim() === "") {
      throw new Error("The live Eval harness configuration is invalid.");
    }

    let route;
    try {
      if (typeof resolveModelRoute !== "function") {
        throw new Error("No model-selection route is configured.");
      }
      route = await resolveModelRoute(configuration);
    } catch {
      throw new Error("The selected live Eval model route is unavailable.");
    }
    validateResolvedRoute(route, configuration);

    if (route.provider.adapterId === "codex-subscription") {
      await validateCodexAccount({ resolveCodexRuntime, createCredentials });
    }

    return {
      selectedModel: route.selectedModel === null ? null : {
        harnessId: route.selectedModel.harnessId,
        ...(route.selectedModel.familyId === undefined ? {} : { familyId: route.selectedModel.familyId }),
        providerId: route.selectedModel.providerId,
        modelId: route.selectedModel.modelId,
      },
      productModelSelection: route.productModelSelection,
      providerAdapterId: route.provider.adapterId,
      ...(route.configurationModel === undefined ? {} : { configurationModel: route.configurationModel }),
    };
  };
}

function routeForSelection({ settings, selectedModel, provider, productModelSelection, expectedHarnessId }) {
  if (!selectedModel || typeof selectedModel.providerId !== "string"
    || typeof selectedModel.modelId !== "string" || selectedModel.modelId.trim() === ""
    || selectedModel.harnessId !== expectedHarnessId) {
    throw new Error("The selected provider has no available model.");
  }
  const resolvedProvider = provider ?? providerForSelection(settings, selectedModel);
  const model = resolvedProvider?.models?.find(({ id }) => id === selectedModel.modelId);
  if (!resolvedProvider || resolvedProvider.connected !== true || !model
    || model?.visible === false || model?.available === false) {
    throw new Error("The selected provider credential or model is unavailable.");
  }
  return { selectedModel, productModelSelection, provider: resolvedProvider };
}

function providerForSelection(settings, selectedModel) {
  if (!selectedModel || typeof selectedModel.providerId !== "string") return null;
  return settings?.providers?.find(({ id }) => id === selectedModel.providerId) ?? null;
}

function validateResolvedRoute(route, configuration) {
  const selectedModel = route?.selectedModel;
  const provider = route?.provider;
  if (!provider || provider.connected !== true || !SUPPORTED_PROVIDER_ADAPTERS.has(provider.adapterId)) {
    throw new Error("The selected provider credential is unavailable.");
  }
  if (typeof route.productModelSelection !== "boolean") {
    throw new Error("The selected model route is invalid.");
  }
  if (selectedModel === null) {
    const expectedModel = configuration?.settings?.model;
    const builtInJudge = configuration?.implementation === "codex.basic"
      && CODEX_JUDGE_CONFIGURATION_NAMES.has(configuration.name);
    if (builtInJudge && route.configurationModel === undefined
      && provider.adapterId === "codex-subscription" && route.productModelSelection === false) return;
    if (configuration?.implementation !== "codex.basic"
      || provider.adapterId !== "codex-subscription" || route.productModelSelection !== false
      || typeof expectedModel !== "string" || expectedModel.trim() === ""
      || route.configurationModel !== expectedModel.trim()) {
      throw new Error("The selected live Eval model route is invalid.");
    }
    return;
  }
  if (!selectedModel || selectedModel.providerId !== provider.id
    || typeof selectedModel.modelId !== "string" || selectedModel.modelId.trim() === ""
    || selectedModel.harnessId !== configuration?.name || route.productModelSelection !== true) {
    throw new Error("The selected live Eval model route is invalid.");
  }
  const model = provider.models?.find(({ id }) => id === selectedModel.modelId);
  if (!model || model.visible === false || model.available === false) {
    throw new Error("The selected live Eval model route is unavailable.");
  }
}

async function validateCodexAccount({ resolveCodexRuntime, createCredentials }) {
  if (typeof resolveCodexRuntime !== "function") {
    throw new Error("The live Eval Codex credential is unavailable.");
  }
  let credentials;
  try {
    const runtime = await resolveCodexRuntime();
    credentials = createCredentials({
      ...runtime.environment,
      RELAYER_CODEX_BINARY: runtime.executable,
    });
    const account = await credentials.account();
    if (account?.status !== "connected" || account?.account?.type !== "chatgpt") throw new Error("Codex ChatGPT subscription is disconnected.");
  } catch {
    throw new Error("The live Eval Codex credential is not connected.");
  } finally {
    await credentials?.close().catch(() => undefined);
  }
}
