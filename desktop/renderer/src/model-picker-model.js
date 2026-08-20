export const NO_MODELS_FOR_HARNESS = "No available models for this harness";

function harnessFor(settings, harnessId) {
  return settings.harnesses.find((harness) => harness.id === harnessId);
}

function providerModel(settings, providerId, modelId) {
  return settings.providers
    .find((provider) => provider.id === providerId)
    ?.models?.find((model) => model.id === modelId);
}

function harnessSupportsModel(harness, providerId, modelId) {
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
      if (!harnessSupportsModel(harness, member.providerId, member.modelId)) return false;
      const provider = settings.providers.find((item) => item.id === member.providerId);
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
  const family = availablePickerFamilies(settings, harnessId)[0];
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
  if (families.length === 0) return null;
  const family = families.find((item) => String(item.id) === String(candidate?.familyId))
    ?? families[0];
  const member = family.availableMembers.find((item) => (
    item.providerId === candidate?.providerId && item.modelId === candidate?.modelId
  )) ?? family.availableMembers[0];
  return {
    harnessId,
    familyId: family.id,
    providerId: member.providerId,
    modelId: member.modelId,
  };
}

export function selectionForInteraction(settings, harnessId, interaction) {
  const selected = interaction?.modelSelection;
  return normalizePickerSelection(settings, {
    harnessId,
    familyId: selected?.familyId ?? interaction?.modelFamilyId,
    providerId: selected?.providerId ?? interaction?.modelProviderId,
    modelId: selected?.modelId ?? interaction?.providerModelId,
  });
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
  try {
    await validateSelection(candidate.selection);
    return candidate;
  } catch {
    return { selection: currentSelection, error: NO_MODELS_FOR_HARNESS };
  }
}

export function pickerSelectionPayload(selection) {
  if (!selection) return null;
  return {
    harnessId: selection.harnessId,
    modelSelection: {
      familyId: selection.familyId,
      providerId: selection.providerId,
      modelId: selection.modelId,
    },
  };
}
