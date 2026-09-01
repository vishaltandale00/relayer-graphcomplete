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
  const needsExecutionSetup = persistedLifecycle === "active"
    && definition?.connected === true
    && definition?.unavailableReason?.code === "provider_no_available_execution_configurations";
  if (needsExecutionSetup) {
    return {
      lifecycle: "needs_execution_setup",
      label: "Needs execution setup",
      usable: false,
      recovery: "repair_execution",
    };
  }
  const needsModelSetup = persistedLifecycle === "active"
    && definition?.connected === true
    && definition?.unavailableReason?.code === "provider_no_eligible_execution_models";
  if (needsModelSetup) {
    return {
      lifecycle: "needs_model_setup",
      label: "Needs model setup",
      usable: false,
      recovery: "refresh_models",
    };
  }
  const lifecycle = PROVIDER_LIFECYCLES.has(persistedLifecycle)
    ? (persistedLifecycle === "active" && definition?.connected === false ? "unavailable" : persistedLifecycle)
    : definition?.connected === false ? "unavailable" : "active";
  if (lifecycle === "removal_pending") return { lifecycle, label: "Finishing removal", usable: false };
  if (lifecycle === "tombstoned") return { lifecycle, label: "Removed provider", usable: false };
  if (lifecycle === "unavailable") return { lifecycle, label: "Connection unavailable", usable: false };
  return { lifecycle, label: "Connected", usable: true };
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
  if (providers.some((provider) => providerDefinitionStatus(provider).recovery === "repair_execution")) {
    return { blocked: true, reason: "Repair execution configurations for the connected provider." };
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
