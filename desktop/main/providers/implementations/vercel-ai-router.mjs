import { SecretApiProviderAdapter, bearerHeaders } from "./api-provider-adapter.mjs";

export const vercelAiRouterDescriptor = Object.freeze({
  adapterId: "vercel-ai-router",
  implementationVersion: "1",
  label: "Vercel AI Gateway",
  accessContract: "secret@1",
  defaultEndpoint: "https://ai-gateway.vercel.sh/v1",
  endpointEditableDuringCreation: true,
  connection: { mode: "secret-fields", fields: [{ id: "api-key", label: "API key", kind: "secret", required: true }] },
  catalog: { source: "provider-discovery" },
  create: ({ definition, fetch, secrets }) => new SecretApiProviderAdapter({
    definition, fetch, credentials: { apiKey: secrets?.["api-key"] }, headers: bearerHeaders,
  }),
});
