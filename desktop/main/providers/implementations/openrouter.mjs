import {
  EXECUTION_ELIGIBLE,
  MODEL_CAPABILITY_UNKNOWN,
  MODEL_NOT_EXECUTION_ELIGIBLE,
  SecretApiProviderAdapter,
  bearerHeaders,
  orderModelsByReleaseTimestamp,
} from "./api-provider-adapter.mjs";

function openRouterModelEligibility(model) {
  const outputs = model?.architecture?.output_modalities;
  if (!Array.isArray(outputs) || outputs.some((value) => typeof value !== "string")) {
    return MODEL_CAPABILITY_UNKNOWN;
  }
  return outputs.includes("text") ? EXECUTION_ELIGIBLE : MODEL_NOT_EXECUTION_ELIGIBLE;
}

export function newestOpenRouterModelsFirst(models) {
  return orderModelsByReleaseTimestamp(models, (model) => (
    typeof model?.created === "number" ? model.created : Number.NaN
  ));
}

function tokenCapabilities(model) {
  const contextWindow = model?.top_provider?.context_length;
  const maxOutputTokens = model?.top_provider?.max_completion_tokens;
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 1
    || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) return null;
  return { contextWindow, maxOutputTokens };
}

function usesCanonicalEndpoint(endpoint) {
  return endpoint.replace(/\/+$/, "") === "https://openrouter.ai/api/v1";
}

export const openRouterDescriptor = Object.freeze({
  adapterId: "openrouter",
  implementationVersion: "2",
  label: "OpenRouter",
  accessContract: "secret@1",
  definitionRuntimeState: true,
  defaultEndpoint: "https://openrouter.ai/api/v1",
  endpointEditableDuringCreation: true,
  connection: { mode: "secret-fields", fields: [{ id: "api-key", label: "API key", kind: "secret", required: true }] },
  catalog: { source: "provider-discovery" },
  create: ({ definition, fetch, secrets, managedRuntime, environment }) => new SecretApiProviderAdapter({
    definition, fetch, credentials: { apiKey: secrets?.["api-key"] }, headers: bearerHeaders,
    connectionProbePath: usesCanonicalEndpoint(definition.endpoint) ? "/key" : null,
    verifyConnectionBeforeDiscovery: usesCanonicalEndpoint(definition.endpoint),
    modelCapabilities: tokenCapabilities,
    modelEligibility: openRouterModelEligibility,
    newestModelsFirst: newestOpenRouterModelsFirst,
    requireCatalogBeforeExecution: true,
    managedRuntime, runtimeId: "codex", environment,
  }),
});
