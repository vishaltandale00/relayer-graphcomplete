const ADAPTER_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const IMPLEMENTATION_VERSION = /^[1-9][0-9]*$/;
const ACCESS_CONTRACTS = new Set(["secret@1", "managed-runtime@1"]);
const CONNECTION_MODES = new Set(["secret-fields", "managed-login", "existing-runtime-auth"]);
const FIELD_KINDS = new Set(["secret", "text"]);

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string.`);
  return value.trim();
}

function optionalString(value, field) {
  if (value === undefined || value === null) return null;
  return requiredString(value, field);
}

export function normalizeProviderEndpoint(value, { allowDevelopmentLoopback = false } = {}) {
  const endpoint = requiredString(value, "endpoint");
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("endpoint must be an absolute URL.");
  }
  if (url.username || url.password) throw new Error("endpoint cannot contain credentials.");
  if (url.search || url.hash) throw new Error("endpoint cannot contain a query string or fragment.");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(allowDevelopmentLoopback && loopback && url.protocol === "http:")) {
    throw new Error("endpoint must use HTTPS.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

function sanitizeField(field, index) {
  const id = requiredString(field?.id, `connection.fields[${index}].id`);
  if (!ADAPTER_ID.test(id)) throw new Error(`connection.fields[${index}].id is invalid.`);
  const kind = requiredString(field?.kind, `connection.fields[${index}].kind`);
  if (!FIELD_KINDS.has(kind)) throw new Error(`connection.fields[${index}].kind is invalid.`);
  return Object.freeze({
    id,
    label: requiredString(field?.label, `connection.fields[${index}].label`),
    kind,
    required: field?.required !== false,
  });
}

export function validateProviderAdapterDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Provider adapter descriptor must be an object.");
  const adapterId = requiredString(value.adapterId, "adapterId");
  if (!ADAPTER_ID.test(adapterId)) throw new Error("adapterId is invalid.");
  const implementationVersion = requiredString(value.implementationVersion, "implementationVersion");
  if (!IMPLEMENTATION_VERSION.test(implementationVersion)) throw new Error("implementationVersion must be a positive integer string.");
  const accessContract = requiredString(value.accessContract, "accessContract");
  if (!ACCESS_CONTRACTS.has(accessContract)) throw new Error("accessContract is unsupported.");
  const mode = requiredString(value.connection?.mode, "connection.mode");
  if (!CONNECTION_MODES.has(mode)) throw new Error("connection.mode is unsupported.");
  const fields = Object.freeze((value.connection?.fields ?? []).map(sanitizeField));
  if (new Set(fields.map(({ id }) => id)).size !== fields.length) throw new Error(`Duplicate connection field in ${adapterId}.`);
  if (mode === "secret-fields" && !fields.some(({ kind }) => kind === "secret")) {
    throw new Error(`${adapterId} must declare at least one secret field.`);
  }
  const defaultEndpoint = optionalString(value.defaultEndpoint, "defaultEndpoint");
  if (defaultEndpoint !== null) normalizeProviderEndpoint(defaultEndpoint);
  if (accessContract === "secret@1" && mode !== "secret-fields") throw new Error("secret@1 requires secret-fields connection mode.");
  if (accessContract === "managed-runtime@1" && mode === "secret-fields") throw new Error("managed-runtime@1 cannot use secret-fields connection mode.");
  if (typeof value.create !== "function") throw new Error(`${adapterId} must define create().`);
  return Object.freeze({
    adapterId,
    implementationVersion,
    label: requiredString(value.label, "label"),
    accessContract,
    defaultEndpoint,
    endpointEditableDuringCreation: value.endpointEditableDuringCreation === true,
    connection: Object.freeze({ mode, fields }),
    catalog: Object.freeze({ source: value.catalog?.source === "code-manifest" ? "code-manifest" : "provider-discovery" }),
    create: value.create,
  });
}

export function validateProviderDefinition(value, descriptor, { allowDevelopmentLoopback = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Provider definition must be an object.");
  const id = requiredString(value.id, "providerDefinition.id");
  if (!ADAPTER_ID.test(id)) throw new Error("providerDefinition.id is invalid.");
  if (value.adapterId !== descriptor.adapterId) throw new Error("Provider definition adapterId does not match the selected adapter.");
  const endpoint = value.endpoint === null || value.endpoint === undefined
    ? descriptor.defaultEndpoint
    : normalizeProviderEndpoint(value.endpoint, { allowDevelopmentLoopback });
  if (descriptor.accessContract === "secret@1" && endpoint === null) throw new Error("API provider definitions require an endpoint.");
  if (descriptor.accessContract === "managed-runtime@1" && endpoint !== null) throw new Error("Managed-runtime provider definitions cannot define an endpoint.");
  return Object.freeze({
    id,
    adapterId: descriptor.adapterId,
    label: requiredString(value.label, "providerDefinition.label"),
    endpoint,
    accessContract: descriptor.accessContract,
    credentialReference: optionalString(value.credentialReference, "providerDefinition.credentialReference"),
  });
}

export function createProviderAdapterRegistry(descriptors) {
  if (!Array.isArray(descriptors) || descriptors.length === 0) throw new Error("Provider adapter registry requires descriptors.");
  const entries = new Map();
  for (const raw of descriptors) {
    const descriptor = validateProviderAdapterDescriptor(raw);
    if (entries.has(descriptor.adapterId)) throw new Error(`Duplicate provider adapter: ${descriptor.adapterId}`);
    entries.set(descriptor.adapterId, descriptor);
  }
  return Object.freeze({
    list: () => Object.freeze([...entries.values()]),
    get(adapterId) {
      const descriptor = entries.get(adapterId);
      if (!descriptor) throw new Error(`Unknown provider adapter: ${adapterId}`);
      return descriptor;
    },
    create(definition, dependencies = {}) {
      const descriptor = this.get(definition?.adapterId);
      const normalized = validateProviderDefinition(definition, descriptor, dependencies);
      return descriptor.create(Object.freeze({ definition: normalized, ...dependencies }));
    },
  });
}
