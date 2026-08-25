export const NO_MODELS_FOR_HARNESS = "No available models for this harness";

const MODEL_SELECTION_CATALOG_ERRORS = new Set([
  "harness_unknown",
  "harness_not_product_visible",
  "harness_unavailable",
  "provider_unknown",
  "provider_disconnected",
  "model_selection_unknown",
  "model_hidden",
  "model_unavailable",
  "model_family_disabled",
  "harness_model_incompatible",
  "model_not_in_family",
]);

export function isModelSelectionCatalogError(error) {
  return MODEL_SELECTION_CATALOG_ERRORS.has(error?.code);
}

function harnessFor(settings, harnessId) {
  return settings.harnesses.find((harness) => harness.id === harnessId);
}

export function harnessUsesConfigurationModel(settings, harnessId) {
  const harness = harnessFor(settings, harnessId);
  return Boolean(
    harness
    && harness.available !== false
    && (harness.modelCompatibility?.length ?? 0) === 0
    && (harness.compatibleProviderIds?.length ?? 0) === 0
  );
}

function providerModel(settings, providerId, modelId) {
  return settings.providers
    .find((provider) => provider.id === providerId)
    ?.models?.find((model) => model.id === modelId);
}

function harnessRuleMatches(rule, adapterId, modelId) {
  if (rule.adapterId !== adapterId) return false;
  if (rule.modelIdExact != null) return rule.modelIdExact === modelId;
  try {
    return typeof rule.modelIdRegex === "string" && new RegExp(rule.modelIdRegex, "u").test(modelId);
  } catch {
    return false;
  }
}

function harnessSupportsModel(harness, provider, modelId) {
  const providerId = provider?.id;
  const rules = harness?.modelRules;
  if (rules) {
    const adapterId = provider?.adapterId;
    if ((rules.deny ?? []).some((rule) => harnessRuleMatches(rule, adapterId, modelId))) return false;
    return !(rules.allow ?? []).length
      || rules.allow.some((rule) => harnessRuleMatches(rule, adapterId, modelId));
  }
  const compatibility = harness?.modelCompatibility?.find((item) => item.providerId === providerId);
  if (compatibility) {
    return !Array.isArray(compatibility.modelIds) || compatibility.modelIds.includes(modelId);
  }
  return !Array.isArray(harness?.compatibleProviderIds)
    || harness.compatibleProviderIds.includes(providerId);
}

export function availableFamilyMembers(settings, family, harnessId) {
  const harness = harnessFor(settings, harnessId);
  if (!harness || harness.available === false) return [];
  return [...(family.members ?? [])]
    .sort((left, right) => left.position - right.position)
    .filter((member) => {
      const provider = settings.providers.find((item) => item.id === member.providerId);
      if (!harnessSupportsModel(harness, provider, member.modelId)) return false;
      const model = providerModel(settings, member.providerId, member.modelId);
      return provider?.connected !== false
        && model?.visible !== false
        && model?.available !== false;
    });
}

export function availablePickerFamilies(settings, harnessId) {
  return [...(settings.families ?? [])]
    .filter((family) => family.enabled)
    .sort((left, right) => left.position - right.position)
    .map((family) => ({
      ...family,
      availableMembers: availableFamilyMembers(settings, family, harnessId),
    }))
    .filter((family) => family.availableMembers.length > 0);
}

export function firstAvailableSelection(settings, harnessId) {
  const families = availablePickerFamilies(settings, harnessId);
  const family = families.find((item) => String(item.id) === String(settings.defaults?.familyId))
    ?? families[0];
  const member = family?.availableMembers[0];
  if (!family || !member) return null;
  return {
    harnessId,
    familyId: family.id,
    providerId: member.providerId,
    modelId: member.modelId,
  };
}

export function normalizePickerSelection(settings, candidate) {
  const harnessId = candidate?.harnessId ?? settings.defaults.harnessId;
  const families = availablePickerFamilies(settings, harnessId);
  if (families.length === 0) {
    return harnessUsesConfigurationModel(settings, harnessId) ? { harnessId } : null;
  }
  const requestedFamilyId = candidate?.familyId ?? settings.defaults?.familyId;
  const requestedFamily = requestedFamilyId == null
    ? null
    : families.find((item) => String(item.id) === String(requestedFamilyId));
  if (requestedFamilyId != null && !requestedFamily) return null;
  const hasExplicitModel = candidate?.familyId != null
    && typeof candidate?.providerId === "string"
    && typeof candidate?.modelId === "string";
  if (hasExplicitModel && !requestedFamily) return null;
  const family = requestedFamily ?? families[0];
  const requestedMember = family.availableMembers.find((item) => (
    item.providerId === candidate?.providerId && item.modelId === candidate?.modelId
  ));
  if (hasExplicitModel && !requestedMember) return null;
  const member = requestedMember ?? family.availableMembers[0];
  return {
    harnessId,
    familyId: family.id,
    providerId: member.providerId,
    modelId: member.modelId,
  };
}

export function defaultFamilySelection(settings, harnessId = settings.defaults?.harnessId) {
  const familyId = settings.defaults?.familyId;
  if (familyId == null) return null;
  return normalizePickerSelection(settings, { harnessId, familyId });
}

export function defaultFamilySelectionForProvider(settings, harnessId, providerId) {
  const selection = defaultFamilySelection(settings, harnessId);
  return String(selection?.providerId) === String(providerId) ? selection : null;
}

export function reconcilePickerSelection(settings, candidate) {
  const harnessId = candidate?.harnessId ?? settings.defaults.harnessId;
  const normalized = normalizePickerSelection(settings, { ...candidate, harnessId });
  if (normalized) return normalized;
  if (
    candidate?.familyId != null
    && typeof candidate.providerId === "string"
    && typeof candidate.modelId === "string"
  ) {
    return {
      harnessId,
      familyId: candidate.familyId,
      providerId: candidate.providerId,
      modelId: candidate.modelId,
    };
  }
  return null;
}

export function pickerSelectionIsAvailable(settings, candidate) {
  if (candidate?.harnessId && candidate.familyId == null) {
    return harnessUsesConfigurationModel(settings, candidate.harnessId);
  }
  if (
    !candidate
    || candidate.familyId == null
    || typeof candidate.providerId !== "string"
    || typeof candidate.modelId !== "string"
  ) return false;
  return normalizePickerSelection(settings, candidate) !== null;
}

export function selectionForInteraction(settings, harnessId, interaction) {
  const selected = interaction?.modelSelection;
  return reconcilePickerSelection(settings, {
    harnessId,
    familyId: selected?.familyId ?? interaction?.modelFamilyId,
    providerId: selected?.providerId ?? interaction?.modelProviderId,
    modelId: selected?.modelId ?? interaction?.providerModelId,
  });
}

export function resolveUnsentModelIntent(settings, candidate) {
  const harnessId = candidate?.harnessId ?? settings.defaults.harnessId;
  if (candidate?.familyId == null) {
    return { selection: normalizePickerSelection(settings, { harnessId }), blockedFamilyId: null };
  }
  const family = (settings.families ?? []).find((item) => (
    String(item.id) === String(candidate.familyId) && item.enabled
  ));
  if (!family) return { selection: null, blockedFamilyId: candidate.familyId };
  const availableMembers = availableFamilyMembers(settings, family, harnessId);
  const exact = availableMembers.find((member) => (
    member.providerId === candidate.providerId && member.modelId === candidate.modelId
  ));
  const member = exact ?? availableMembers[0];
  if (!member) return { selection: null, blockedFamilyId: family.id };
  return {
    selection: {
      harnessId,
      familyId: family.id,
      providerId: member.providerId,
      modelId: member.modelId,
    },
    blockedFamilyId: null,
  };
}

export function selectCandidateHarness(settings, currentSelection, harnessId) {
  const selection = normalizePickerSelection(settings, { harnessId });
  if (selection) return { selection, error: null };
  return { selection: currentSelection, error: NO_MODELS_FOR_HARNESS };
}

export async function validateCandidateHarness(
  settings,
  currentSelection,
  harnessId,
  validateSelection,
) {
  const candidate = selectCandidateHarness(settings, currentSelection, harnessId);
  if (candidate.error) return candidate;
  if (candidate.selection.familyId == null) return candidate;
  try {
    await validateSelection(candidate.selection);
    return candidate;
  } catch {
    return { selection: currentSelection, error: NO_MODELS_FOR_HARNESS };
  }
}

export function pickerSelectionPayload(selection) {
  if (!selection) return null;
  if (selection.familyId == null) return { harnessId: selection.harnessId };
  return {
    harnessId: selection.harnessId,
    modelSelection: {
      familyId: selection.familyId,
      providerId: selection.providerId,
      modelId: selection.modelId,
    },
  };
}
