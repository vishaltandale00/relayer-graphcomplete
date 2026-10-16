import { defaultFamilyModelSetup, harnessUsesConfigurationModel } from "./model-picker-model.js";

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
    models: family.models.map((member) => ({ ...member, roles: structuredClone(member.roles ?? []) })).slice(0, MAX_MODELS_PER_FAMILY),
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
    roles: [],
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
  if (!errors.models && family.models.filter((member) => member.roles?.some((role) => role.name === "orchestrator")).length !== 1) {
    errors.roles = "Choose exactly one orchestrator.";
  }
  for (const member of family.models) {
    const names = new Set();
    if ((member.roles ?? []).length > 32 || (member.roles ?? []).some((role) => {
      const name = role.name.trim();
      if (!name || [...name].length > 80 || names.has(name.toLowerCase())
        || (name.toLowerCase() === "orchestrator" && name !== "orchestrator")
        || [...(role.description ?? "")].length > 240) return true;
      names.add(name.toLowerCase());
      return false;
    })) errors.roles = "Use unique role names and short descriptions. The reserved role is orchestrator.";
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
    roles: [],
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
  // The default family waiting for its provider's models is shown as that recovery instead.
  if (defaultFamilyModelSetup(settings)) return null;
  if (selected.usableNow !== true
    && !harnessUsesConfigurationModel(settings, selected.id)) {
    return "No currently connected provider and eligible model can use this harness.";
  }
  if (!defaultHarnessIsSelectable(settings, selected.id)) {
    return "No eligible model in the default family can use this harness.";
  }
  return null;
}

// The Settings default section's recovery state for a default family that needs model setup
// (PROV-008). Its action refreshes that exact provider.
export function defaultFamilyRecoveryPresentation(settings) {
  const modelSetup = defaultFamilyModelSetup(settings);
  if (!modelSetup) return null;
  const common = {
    providerId: modelSetup.providerId,
    title: modelSetup.label,
    message: modelSetup.message,
  };
  if (modelSetup.action === "refresh") {
    return {
      ...common,
      action: "refresh",
      actionLabel: modelSetup.actionLabel,
      actionName: modelSetup.actionName,
      busyName: modelSetup.busyName,
    };
  }
  if (!modelSetup.providerLabel) return {
    ...common,
    action: "families",
    actionLabel: "Open Model Families",
    actionName: modelSetup.actionName,
  };
  // A disconnected provider is reconnected from its card under Providers.
  return {
    ...common,
    action: "providers",
    actionLabel: "Open Providers",
    actionName: `Reconnect ${modelSetup.providerLabel} under Providers`,
  };
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

// A provider can be the default only with an enabled managed family that a harness can run,
// because choosing it also selects that family and, when needed, a harness (PROV-008). This
// mirrors the server: the current default harness stays if it can run the family; otherwise a
// harness must be available, run the family and have an enabled permission profile.
function harnessCanRunFamily(settings, familyId) {
  const runs = (harness) => harness.available !== false
    && harness.usableNow === true
    && (harness.usableFamilyIds ?? []).some((id) => String(id) === String(familyId));
  const current = settings.harnesses?.find((harness) => harness.id === settings.defaults?.harnessId);
  if (current && (harnessUsesConfigurationModel(settings, current.id) || runs(current))) return true;
  return (settings.harnesses ?? []).some((harness) => (
    harness.permissionAvailable === true
    && !harnessUsesConfigurationModel(settings, harness.id)
    && runs(harness)
  ));
}

// Connected providers that cannot be the default are sorted by the remedy: a provider with no
// enabled managed family needs a model refresh; one whose family no harness can run does not.
export function defaultProviderChoices(settings) {
  const selectable = [];
  const needsRefresh = [];
  const noHarness = [];
  for (const provider of settings.providers ?? []) {
    if (provider.connected === false) continue;
    const family = (settings.families ?? []).find((candidate) => (
      candidate.kind === "system"
      && candidate.enabled
      && String(candidate.managedPolicy?.providerId) === String(provider.id)
    ));
    if (!family) needsRefresh.push(provider);
    else if (!harnessCanRunFamily(settings, family.id)) noHarness.push(provider);
    else selectable.push(provider);
  }
  return { selectable, needsRefresh, noHarness };
}

const joinLabels = (providers) => providers.map((provider) => provider.label).join(", ");

export function defaultProviderHint({ needsRefresh = [], noHarness = [] } = {}, currentProviderId = null) {
  // The current default keeps its own family; a hint saying it cannot be the default would
  // contradict the selection.
  needsRefresh = needsRefresh.filter((provider) => String(provider.id) !== String(currentProviderId));
  noHarness = noHarness.filter((provider) => String(provider.id) !== String(currentProviderId));
  const lines = [];
  if (needsRefresh.length === 1) {
    lines.push(`${joinLabels(needsRefresh)} has no usable model family yet. Refresh its models to make it the default.`);
  } else if (needsRefresh.length) {
    lines.push(`${joinLabels(needsRefresh)} have no usable model family yet. Refresh their models to make one the default.`);
  }
  if (noHarness.length === 1) {
    lines.push(`No available harness can run ${joinLabels(noHarness)} models, so it cannot be the default.`);
  } else if (noHarness.length) {
    lines.push(`No available harness can run models from ${joinLabels(noHarness)}, so they cannot be the default.`);
  }
  return lines.length ? lines.join(" ") : null;
}

// A provider save can move the default harness to one that runs its family. The notice is built
// from the defaults the save returned, not from a later settings refresh.
export function defaultHarnessChangeNotice(previousDefaults, savedDefaults, settings) {
  const harnessId = savedDefaults?.harnessId;
  if (!previousDefaults || !harnessId || previousDefaults.harnessId === harnessId) return null;
  const harness = settings.harnesses?.find((item) => item.id === harnessId);
  const provider = settings.providers?.find((item) => item.id === savedDefaults.providerId);
  return `Saved. The default harness is now ${harness?.label ?? harnessId}, which can run ${provider?.label ?? savedDefaults.providerId} models.`;
}

export function availableModels(providerCatalog, providerId) {
  return providerCatalog.find((provider) => provider.id === providerId)?.models ?? [];
}

export function unavailableReasonMessage(reason) {
  if (!reason) return null;
  return typeof reason === "string" ? reason : reason.message ?? null;
}
