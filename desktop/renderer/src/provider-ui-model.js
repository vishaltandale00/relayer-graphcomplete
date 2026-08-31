const PROVIDER_LIFECYCLES = new Set(["active", "removal_pending", "tombstoned"]);
const CONNECTION_MODES = new Set(["secret-fields", "managed-login", "existing-runtime-auth"]);

function compareLabel(left, right) {
  return String(left).localeCompare(String(right), undefined, { sensitivity: "base" });
}

export function normalizeProviderDescriptor(descriptor) {
  if (!descriptor || typeof descriptor.adapterId !== "string" || !descriptor.adapterId.trim()) {
    throw new Error("Provider adapter ID is required.");
  }
  if (typeof descriptor.label !== "string" || !descriptor.label.trim()) {
    throw new Error(`Provider adapter ${descriptor.adapterId} requires a label.`);
  }
  if (!CONNECTION_MODES.has(descriptor.connection?.mode)) {
    throw new Error(`Provider adapter ${descriptor.adapterId} has an invalid connection mode.`);
  }
  const fields = (descriptor.connection.fields ?? []).map((field) => {
    if (!field?.id || !field?.label || !["secret", "text"].includes(field.kind)) {
      throw new Error(`Provider adapter ${descriptor.adapterId} has an invalid connection field.`);
    }
    return { ...field, required: field.required !== false };
  });
  return {
    ...descriptor,
    connection: { ...descriptor.connection, fields },
    endpointEditableDuringCreation: descriptor.endpointEditableDuringCreation === true,
  };
}

export function providerDescriptorGroups(descriptors) {
  const normalized = descriptors.map(normalizeProviderDescriptor).sort((left, right) => (
    compareLabel(left.label, right.label)
  ));
  return {
    subscriptions: normalized.filter((item) => item.connection.mode !== "secret-fields"),
    api: normalized.filter((item) => item.connection.mode === "secret-fields"),
  };
}

export function providerDefinitionStatus(definition) {
  const persistedLifecycle = definition?.lifecycleState;
  const needsModelSetup = persistedLifecycle === "active"
    && definition?.connected === true
    && definition?.unavailableReason?.code === "provider_no_eligible_execution_models";
  if (needsModelSetup) {
    return {
      lifecycle: "active",
      label: "Connected",
      reason: "No usable models available",
      usable: true,
      warning: true,
      recovery: "refresh_models",
    };
  }
  const lifecycle = PROVIDER_LIFECYCLES.has(persistedLifecycle)
    ? (persistedLifecycle === "active" && definition?.connected === false ? "unavailable" : persistedLifecycle)
    : definition?.connected === false ? "unavailable" : "active";
  if (lifecycle === "removal_pending") return { lifecycle, label: "Removing", reason: "Waiting for active chats to finish", usable: false };
  if (lifecycle === "tombstoned") return { lifecycle, label: "Removed provider", usable: false };
  const code = definition?.unavailableReason?.code;
  if (lifecycle === "unavailable" && code === "provider_temporarily_unavailable") {
    return { lifecycle: "temporarily_unavailable", label: "Temporarily unavailable", reason: "Provider could not be reached", usable: false, warning: true };
  }
  if (lifecycle === "unavailable") {
    const rejected = /credential|auth|key|token/iu.test(`${code} ${definition?.unavailableReason?.message ?? ""}`);
    return { lifecycle, label: "Connection unavailable", reason: rejected ? "API key was rejected" : "Connection needs attention", usable: false, warning: true };
  }
  return { lifecycle, label: "Connected", usable: true, warning: false };
}

export function providerFamilyRecoveryResult(providerStatus, providerId) {
  const definition = providerStatus?.definitions?.find(({ id }) => String(id) === String(providerId));
  if (!definition) return { recovered: false, message: "Provider refresh completed, but default family setup could not be confirmed." };
  if (definition.unavailableReason) {
    return { recovered: false, message: definition.unavailableReason.message };
  }
  return { recovered: true, message: "Provider models and default family refreshed." };
}

export function providerLabelError(label, definitions, currentId = null) {
  const normalized = String(label ?? "").trim().toLocaleLowerCase();
  if (!normalized) return "Enter a connection name.";
  const duplicate = definitions.some((definition) => (
    String(definition.id) !== String(currentId)
    && definition.lifecycleState !== "tombstoned"
    && String(definition.label).trim().toLocaleLowerCase() === normalized
  ));
  return duplicate ? "Active connection names must be unique." : null;
}

export function providerConnectionErrors(descriptor, values, definitions = []) {
  const errors = {};
  const labelError = providerLabelError(values.label, definitions);
  if (labelError) errors.label = labelError;
  if (descriptor.endpointEditableDuringCreation) {
    try {
      const endpoint = new URL(String(values.endpoint ?? ""));
      if (endpoint.protocol !== "https:") {
        errors.endpoint = "Use an HTTPS endpoint.";
      }
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        errors.endpoint = "The endpoint cannot contain credentials, query parameters, or a fragment.";
      }
    } catch {
      errors.endpoint = "Enter a valid endpoint URL.";
    }
  }
  for (const field of descriptor.connection.fields) {
    if (field.required && !String(values.fields?.[field.id] ?? "").trim()) {
      errors[field.id] = `Enter ${field.label}.`;
    }
  }
  return errors;
}

export function firstRunGateState({ hasCompletedOnboarding, providers, defaultResolution }) {
  if (hasCompletedOnboarding) return { blocked: false, reason: null };
  if (providers.some((provider) => providerDefinitionStatus(provider).recovery === "refresh_models")) {
    return { blocked: true, reason: "Refresh models and set up defaults for the connected provider." };
  }
  if (!providers.some((provider) => providerDefinitionStatus(provider).usable)) {
    return { blocked: true, reason: "Connect a working provider to continue." };
  }
  if (!defaultResolution?.familyId) {
    return { blocked: true, reason: "Choose or create a default model family to continue." };
  }
  if (!defaultResolution?.providerDefinitionId || !defaultResolution?.modelId) {
    return { blocked: true, reason: "The default model family has no model available for the default harness." };
  }
  return { blocked: false, reason: null };
}

export function providerCreationPayload(descriptor, values, { connectionId } = {}) {
  return {
    ...(connectionId ? { connectionId } : {}),
    adapterId: descriptor.adapterId,
    label: values.label.trim(),
    endpoint: descriptor.endpointEditableDuringCreation
      ? new URL(values.endpoint).toString().replace(/\/$/, "")
      : descriptor.defaultEndpoint,
    fields: Object.fromEntries(descriptor.connection.fields.map((field) => [
      field.id,
      String(values.fields?.[field.id] ?? ""),
    ])),
  };
}

export function providerEditErrors(descriptor, values) {
  const errors = {};
  if (descriptor.endpointEditableDuringCreation) {
    try {
      const endpoint = new URL(String(values.endpoint ?? ""));
      if (endpoint.protocol !== "https:") errors.endpoint = "Use an HTTPS endpoint.";
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        errors.endpoint = "The endpoint cannot contain credentials, query parameters, or a fragment.";
      }
    } catch {
      errors.endpoint = "Enter a valid endpoint URL.";
    }
  }
  return errors;
}

export function providerEditPayload(descriptor, values) {
  return {
    endpoint: descriptor.endpointEditableDuringCreation
      ? new URL(values.endpoint).toString().replace(/\/$/, "")
      : descriptor.defaultEndpoint,
    fields: Object.fromEntries(descriptor.connection.fields.map((field) => [
      field.id,
      String(values.fields?.[field.id] ?? ""),
    ])),
  };
}

export function providerRemovalConsequences(definition, modelSettings = {}) {
  const families = modelSettings.families ?? [];
  const providers = modelSettings.providers ?? [];
  const affected = families.filter((family) => (
    family.managedPolicy?.providerId === definition.id
    || (family.members ?? []).some((member) => member.providerId === definition.id)
  ));
  const deleted = [definition.label];
  const updated = [];
  for (const family of affected) {
    const remaining = (family.members ?? []).filter((member) => member.providerId !== definition.id);
    if (family.kind === "system" || remaining.length === 0) deleted.push(family.name);
    else updated.push(family.name);
  }
  const defaultFamily = families.find((family) => String(family.id) === String(modelSettings.defaults?.familyId));
  const usableRemaining = (defaultFamily?.members ?? [])
    .filter((member) => member.providerId !== definition.id)
    .some((member) => {
      const owner = providers.find((provider) => provider.id === member.providerId);
      const model = owner?.models?.find((candidate) => candidate.id === member.modelId);
      return owner?.connected !== false && model?.visible !== false && model?.available !== false;
    });
  const removesDefault = defaultFamily && affected.some((family) => String(family.id) === String(defaultFamily.id));
  return Object.freeze({
    blocked: Boolean(removesDefault && !usableRemaining),
    deleted: Object.freeze(deleted),
    updated: Object.freeze(updated),
  });
}
