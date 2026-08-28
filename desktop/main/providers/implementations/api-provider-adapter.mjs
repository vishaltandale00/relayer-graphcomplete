import { ModelCatalogAdapter, sanitizeModelCatalogSnapshot } from "../../models/model-catalog-adapter.mjs";
import { managedRuntimeExecutionDetails, requireManagedRuntime } from "./managed-runtime-contract.mjs";

export class ProviderHttpError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
    this.code = code;
  }
}

function requiredSecret(values, field) {
  const value = values?.[field];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required.`);
  return value;
}

function normalizeModel(value, index) {
  const id = typeof value?.id === "string" ? value.id : null;
  if (!id) throw new Error(`Provider catalog model ${index} has no stable id.`);
  const label = typeof value.name === "string" && value.name.trim() !== ""
    ? value.name
    : typeof value.display_name === "string" && value.display_name.trim() !== ""
      ? value.display_name
      : id;
  return {
    id,
    catalogId: id,
    executionModel: id,
    label,
    description: typeof value.description === "string" ? value.description : "",
    visible: value.hidden !== true,
    availability: "available",
    unavailableReason: null,
    availabilityNotice: null,
    isDefault: value.is_default === true,
    replacementModelId: null,
    upgradeInfo: null,
    supportedEfforts: [],
    defaultEffort: null,
    inputModalities: ["text"],
    supportsPersonality: false,
    serviceTiers: [],
    defaultServiceTier: null,
  };
}

function modelArray(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.models)) return payload.models;
  throw new Error("Provider returned a malformed model catalog.");
}

export class SecretApiProviderAdapter extends ModelCatalogAdapter {
  constructor({
    definition,
    fetch: fetchImplementation = globalThis.fetch,
    credentials,
    headers,
    modelsPath = "/models",
    modelCapabilities = () => null,
    requireCatalogBeforeExecution = false,
    managedRuntime,
    runtimeId,
    environment,
  }) {
    super({ providerId: definition.id, providerLabel: definition.label });
    if (typeof fetchImplementation !== "function") throw new Error("API provider adapter requires fetch().");
    this.definition = definition;
    this.fetch = fetchImplementation;
    this.credentials = Object.freeze({ ...credentials });
    this.headers = headers;
    this.modelsPath = modelsPath;
    this.readModelCapabilities = modelCapabilities;
    this.modelCapabilities = Object.freeze({});
    this.requireCatalogBeforeExecution = requireCatalogBeforeExecution;
    this.catalogDiscovered = false;
    this.managedRuntime = requireManagedRuntime(managedRuntime, runtimeId);
    this.runtimeExecution = managedRuntimeExecutionDetails(this.managedRuntime, environment);
  }

  async discover({ signal } = {}) {
    signal?.throwIfAborted();
    const endpoint = `${this.definition.endpoint}${this.modelsPath}`;
    let response;
    try {
      response = await this.fetch(endpoint, {
        method: "GET",
        headers: Object.freeze({ Accept: "application/json", ...this.headers(this.credentials) }),
        signal,
      });
    } catch (error) {
      signal?.throwIfAborted();
      throw new ProviderHttpError("Provider catalog request failed.", { code: error?.code ?? "transport" });
    }
    if (!response?.ok) {
      if (response?.status === 401 || response?.status === 403) {
        return sanitizeModelCatalogSnapshot({
          provider: {
            id: this.providerId,
            label: this.providerLabel,
            status: "unavailable",
            unavailableReason: "Provider credentials were rejected.",
          },
          models: [],
          systemFamily: { id: this.providerId, label: this.providerLabel, modelIds: [] },
        });
      }
      throw new ProviderHttpError(`Provider catalog request failed with HTTP ${response?.status ?? "unknown"}.`, {
        status: Number.isInteger(response?.status) ? response.status : null,
      });
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Provider returned a malformed model catalog.");
    }
    const providerModels = modelArray(payload);
    const models = providerModels.map(normalizeModel);
    if (!models.some(({ visible }) => visible)) throw new Error("Provider did not report any visible models.");
    const snapshot = sanitizeModelCatalogSnapshot({
      provider: { id: this.providerId, label: this.providerLabel, status: "available", unavailableReason: null },
      models,
      // Families are product-owned. This compatibility field remains empty until
      // the catalog transport no longer carries the legacy system-family shape.
      systemFamily: { id: this.providerId, label: this.providerLabel, modelIds: [] },
    });
    this.modelCapabilities = Object.freeze(Object.fromEntries(providerModels.flatMap((model) => {
      const capabilities = this.readModelCapabilities(model);
      if (capabilities === null) return [];
      return [[model.id, Object.freeze({ ...capabilities })]];
    })));
    this.catalogDiscovered = true;
    return snapshot;
  }

  async connect(options) {
    return this.discover(options);
  }

  executionAccess({ signal } = {}) {
    if (this.requireCatalogBeforeExecution && !this.catalogDiscovered) {
      return this.discover({ signal }).then((snapshot) => {
        if (snapshot.provider.status !== "available") {
          throw new Error(snapshot.provider.unavailableReason ?? "Provider catalog is unavailable for execution.");
        }
        return this.executionAccess({ signal });
      });
    }
    return Object.freeze({
      kind: "secret",
      endpoint: this.definition.endpoint,
      fields: Object.freeze({ "api-key": this.credentials.apiKey }),
      ...(Object.keys(this.modelCapabilities).length === 0 ? {} : { modelCapabilities: this.modelCapabilities }),
      runtime: this.runtimeExecution,
    });
  }
}

export function bearerHeaders(values) {
  return { Authorization: `Bearer ${requiredSecret(values, "apiKey")}` };
}

export function anthropicHeaders(values) {
  return { "x-api-key": requiredSecret(values, "apiKey"), "anthropic-version": "2023-06-01" };
}

export const apiKeyField = Object.freeze({ id: "api-key", label: "API key", kind: "secret", required: true });
