import { harnessUsesConfigurationModel } from "./model-picker-model.js";
import { providerModelsNewestFirst } from "./provider-model-order.js";

export const MAX_MODELS_PER_FAMILY = 5;

export function createFamilyVisibilityGate() {
  let pending = false;
  return Object.freeze({
    begin() {
      if (pending) return false;
      pending = true;
      return true;
    },
    end() {
      pending = false;
    },
    isPending() {
      return pending;
    },
  });
}

export function reconcileSavedFamily(family, saved) {
  return {
    ...family,
    id: saved.id,
    name: saved.name,
    kind: saved.kind,
    enabled: saved.enabled,
    position: saved.position,
    draft: false,
    editing: false,
    validationErrors: {},
  };
}

export function createModelFamilyDraft(providerCatalog, sequence = Date.now(), defaultProviderId = null) {
  const provider = providerCatalog.find((item) => (
    item.id === defaultProviderId && item.connected !== false
  )) ?? providerCatalog.find((item) => item.connected !== false);
  const member = nextAvailableModelMember(providerCatalog, [], provider?.id);
  return {
    id: `draft-${sequence}`,
    name: "",
    kind: "custom",
    enabled: true,
    draft: true,
    models: member ? [member] : [],
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

export function preserveFamilyEditAfterRefresh(families, activeFamilyOrFamilies) {
  const next = [...families];
  const activeFamilies = Array.isArray(activeFamilyOrFamilies)
    ? activeFamilyOrFamilies
    : [activeFamilyOrFamilies].filter(Boolean);
  const preservedIndexes = [];
  let editSnapshot = null;
  for (const activeFamily of activeFamilies) {
    if (!activeFamily?.draft && !activeFamily?.editing) continue;
    if (activeFamily.draft) {
      if (next.some((family) => String(family.id) === String(activeFamily.id))) continue;
      next.push(structuredClone(activeFamily));
      preservedIndexes.push(next.length - 1);
      continue;
    }
    const index = next.findIndex((family) => String(family.id) === String(activeFamily.id));
    if (index < 0) continue;
    editSnapshot ??= structuredClone(next[index]);
    next[index] = {
      ...next[index],
      ...structuredClone(activeFamily),
      id: next[index].id,
      kind: next[index].kind,
      position: next[index].position,
      editing: true,
    };
    preservedIndexes.push(index);
  }
  return {
    families: next,
    selectedIndex: preservedIndexes[0] ?? -1,
    preservedIndexes,
    editSnapshot,
  };
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

export function nextAvailableModelMember(providerCatalog, existingMembers, providerId = null, exceptIndex = -1) {
  const used = new Set((existingMembers ?? [])
    .filter((_member, index) => index !== exceptIndex)
    .map((member) => `${member.providerId}\0${member.modelId}`));
  for (const owner of providerCatalog ?? []) {
    if (providerId && owner.id !== providerId) continue;
    if (owner.connected === false) continue;
    const model = providerModelsNewestFirst(owner.models).find((candidate) => (
      candidate.visible !== false
      && candidate.available !== false
      && !used.has(`${owner.id}\0${candidate.id}`)
    ));
    if (model) return modelMember(owner, model);
  }
  return null;
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
  if (selected.usableNow !== true
    && !harnessUsesConfigurationModel(settings, selected.id)) {
    return "No currently connected provider and eligible model can use this harness.";
  }
  if (!defaultHarnessIsSelectable(settings, selected.id)) {
    return "No eligible model in the default family can use this harness.";
  }
  return null;
}

export function usableDefaultHarnesses(settings) {
  return settings.harnesses.filter((harness) => defaultHarnessIsSelectable(settings, harness.id));
}

export function defaultHarnessIsSelectable(settings, harnessId) {
  const harness = settings.harnesses.find((item) => item.id === harnessId);
  if (!harness) return false;
  if (harnessUsesConfigurationModel(settings, harness.id)) return true;
  if (harness.usableNow !== true) return false;
  const familyId = settings.defaults?.familyId;
  return familyId == null || (harness.usableFamilyIds ?? []).some(
    (usableFamilyId) => String(usableFamilyId) === String(familyId),
  );
}

export function availableModels(providerCatalog, providerId) {
  return providerCatalog.find((provider) => provider.id === providerId)?.models ?? [];
}

export function unavailableReasonMessage(reason) {
  if (!reason) return null;
  return typeof reason === "string" ? reason : reason.message ?? null;
}
