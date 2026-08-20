export const MAX_MODELS_PER_FAMILY = 5;

export function createModelFamilyDraft(providerCatalog, sequence = Date.now(), defaultProviderId = null) {
  const provider = providerCatalog.find((item) => (
    item.id === defaultProviderId && item.connected !== false
  )) ?? providerCatalog.find((item) => item.connected !== false);
  const model = provider?.models?.find((item) => item.visible !== false && item.available !== false);
  return {
    id: `draft-${sequence}`,
    name: "",
    kind: "custom",
    enabled: true,
    draft: true,
    models: model ? [modelMember(provider, model)] : [],
  };
}

export function copySystemFamily(family, sequence = Date.now()) {
  return {
    id: `draft-${sequence}`,
    name: `Copy of ${family.name}`,
    kind: "custom",
    enabled: true,
    draft: true,
    models: family.models.map((member) => ({ ...member })).slice(0, MAX_MODELS_PER_FAMILY),
  };
}

export function preserveFamilyEditAfterRefresh(families, activeFamily) {
  const next = [...families];
  if (!activeFamily?.draft && !activeFamily?.editing) {
    return { families: next, selectedIndex: -1, editSnapshot: null };
  }
  if (activeFamily.draft) {
    next.push(structuredClone(activeFamily));
    return { families: next, selectedIndex: next.length - 1, editSnapshot: null };
  }
  const selectedIndex = next.findIndex((family) => String(family.id) === String(activeFamily.id));
  if (selectedIndex < 0) return { families: next, selectedIndex: -1, editSnapshot: null };
  const editSnapshot = structuredClone(next[selectedIndex]);
  next[selectedIndex] = {
    ...next[selectedIndex],
    ...structuredClone(activeFamily),
    id: next[selectedIndex].id,
    kind: next[selectedIndex].kind,
    position: next[selectedIndex].position,
    editing: true,
  };
  return { families: next, selectedIndex, editSnapshot };
}

export function modelMember(provider, model) {
  const providerUnavailable = provider.connected === false;
  const hidden = model.visible === false;
  const unavailable = model.available === false;
  return {
    providerId: provider.id,
    providerLabel: provider.label,
    modelId: model.id,
    modelLabel: model.label,
    available: !providerUnavailable && !hidden && !unavailable,
    unavailableReason: providerUnavailable
      ? unavailableReasonMessage(provider.unavailableReason) || "This provider is not connected."
      : hidden
        ? "This model is hidden by the provider."
        : unavailableReasonMessage(model.unavailableReason),
  };
}

export function validateCustomFamily(family, families = []) {
  const errors = {};
  const name = family.name.trim();
  if (!name) errors.name = "Enter a family name.";
  else if (families.some((candidate) => candidate.id !== family.id
    && candidate.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
    errors.name = "A family with this name already exists.";
  }

  if (family.models.length === 0) errors.models = "Add at least one model.";
  else if (family.models.length > MAX_MODELS_PER_FAMILY) {
    errors.models = `Remove ${family.models.length - MAX_MODELS_PER_FAMILY} model${family.models.length - MAX_MODELS_PER_FAMILY === 1 ? "" : "s"}.`;
  } else {
    const identities = new Set();
    const duplicate = family.models.some((member) => {
      const identity = `${member.providerId}\0${member.modelId}`;
      if (identities.has(identity)) return true;
      identities.add(identity);
      return false;
    });
    if (duplicate) errors.models = "Each provider model can appear only once.";
  }
  return errors;
}

export function moveItem(items, fromIndex, toIndex) {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0
    || fromIndex >= items.length || toIndex >= items.length) return [...items];
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

export function replaceMemberProvider(member, provider, model) {
  return model ? modelMember(provider, model) : {
    providerId: provider.id,
    providerLabel: provider.label,
    modelId: "",
    modelLabel: "Choose a model",
    available: false,
    unavailableReason: "Choose a model.",
  };
}

export function replaceMemberModel(member, provider, model) {
  return modelMember(provider, model);
}

export function defaultHarnessError(settings) {
  const selected = settings.harnesses.find(
    (harness) => harness.id === settings.defaults.harnessId,
  );
  if (!selected) return "The default harness is no longer configured.";
  if (selected.available === false) {
    return unavailableReasonMessage(selected.unavailableReason) || "No available models for this harness.";
  }
  return null;
}

export function availableModels(providerCatalog, providerId) {
  return providerCatalog.find((provider) => provider.id === providerId)?.models ?? [];
}

export function unavailableReasonMessage(reason) {
  if (!reason) return null;
  return typeof reason === "string" ? reason : reason.message ?? null;
}
