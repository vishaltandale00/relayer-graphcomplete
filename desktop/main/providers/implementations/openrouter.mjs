import {
  EXECUTION_ELIGIBLE,
  MODEL_CAPABILITY_UNKNOWN,
  MODEL_NOT_EXECUTION_ELIGIBLE,
  SecretApiProviderAdapter,
  bearerHeaders,
} from "./api-provider-adapter.mjs";

function openRouterModelEligibility(model) {
  const outputs = model?.architecture?.output_modalities;
  if (!Array.isArray(outputs) || outputs.some((value) => typeof value !== "string")) {
    return MODEL_CAPABILITY_UNKNOWN;
  }
  return outputs.includes("text") ? EXECUTION_ELIGIBLE : MODEL_NOT_EXECUTION_ELIGIBLE;
}

function tokenCapabilities(model) {
  const contextWindow = model?.top_provider?.context_length;
  const maxOutputTokens = model?.top_provider?.max_completion_tokens;
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 1
    || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) return null;
  const parameters = model?.supported_parameters;
  const reasoning = Array.isArray(parameters) && parameters.every((value) => typeof value === "string")
    ? parameters.includes("reasoning") || parameters.includes("reasoning_effort")
    : undefined;
  const inputs = model?.architecture?.input_modalities;
  const imageInput = Array.isArray(inputs) && inputs.every((value) => typeof value === "string")
    ? inputs.includes("image") : undefined;
  return { contextWindow, maxOutputTokens, ...(imageInput === undefined ? {} : { imageInput }), ...(reasoning === undefined ? {} : { reasoning, reasoningEffort: parameters.includes("reasoning_effort") }) };
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
  create: ({ definition, fetch, secrets, environment }) => new SecretApiProviderAdapter({
    definition, fetch, credentials: { apiKey: secrets?.["api-key"] }, headers: bearerHeaders,
    connectionProbePath: usesCanonicalEndpoint(definition.endpoint) ? "/key" : null,
    verifyConnectionBeforeDiscovery: usesCanonicalEndpoint(definition.endpoint),
    modelCapabilities: tokenCapabilities,
    modelEligibility: openRouterModelEligibility,
    requireCatalogBeforeExecution: true,
    environment,
  }),
});
