export const NO_MODELS_FOR_HARNESS = "No available models for this harness";

// A refresh that finds no eligible models tombstones the provider's managed family. The
// app server keeps it as the default and refuses Send with this code (PROV-008).
export const MODEL_SETUP_RECOVERY_CODE = "provider_no_eligible_execution_models";

const MODEL_SELECTION_CATALOG_ERRORS = new Set([
  "conversation_route_incompatible",
  "harness_unknown",
  "harness_not_product_visible",
  "harness_unavailable",
  "provider_unknown",
  "provider_disconnected",
  "model_selection_unknown",
  "model_hidden",
  "model_unavailable",
  "model_family_disabled",
  "model_family_removed",
  "model_family_unresolvable",
  MODEL_SETUP_RECOVERY_CODE,
  "harness_model_incompatible",
  "model_not_in_family",
]);

export function isModelSelectionCatalogError(error) {
  return MODEL_SELECTION_CATALOG_ERRORS.has(error?.code);
}

// A managed family a zero-eligible refresh keeps selected, as the default or a thread's last
// selection, and the action that restores it (PROV-008). The server's reason follows the
// provider: while it is connected, Refresh models can restore the family; once it disconnects,
// only a reconnect in Settings can. Null for any other family.
export function familyModelSetup(settings, familyId) {
  if (familyId == null) return null;
  const recovery = [settings?.defaultFamilyRecovery, ...(settings?.familiesNeedingModelSetup ?? [])]
    .find((candidate) => candidate?.reason && String(candidate.familyId) === String(familyId));
  if (!recovery) return null;
  const provider = settings.providers?.find((item) => String(item.id) === String(recovery.providerId));
  const providerLabel = provider?.label ?? recovery.providerId;
  const identity = {
    familyId: recovery.familyId,
    familyName: recovery.familyName,
    providerId: recovery.providerId,
    providerLabel,
  };
  if (recovery.reason.code === MODEL_SETUP_RECOVERY_CODE) {
    return {
      ...identity,
      action: "refresh",
      label: "Needs model setup",
      message: `${recovery.familyName} needs model setup. ${providerLabel} has no models eligible for agent execution.`,
      actionLabel: "Refresh models",
      actionName: `Refresh models for ${providerLabel}`,
      busyName: `Refreshing models for ${providerLabel}`,
    };
  }
  const detail = recovery.reason.message ? ` ${recovery.reason.message}` : "";
  return {
    ...identity,
    action: "settings",
    label: "Provider not connected",
    message: `${providerLabel} is not connected, so ${recovery.familyName} cannot run.${detail}`,
    actionLabel: "Open Settings",
    actionName: `Reconnect ${providerLabel} in Settings`,
  };
}

export function defaultFamilyModelSetup(settings) {
  return familyModelSetup(settings, settings?.defaults?.familyId);
}

// An automatic caller's default selection. While the default family recovers, the refusal carries
// its code; otherwise a missing selection fails with the caller's own message.
export function requireDefaultModelSelection(selection, settings, missingMessage) {
  if (selection) return selection;
  throw defaultFamilyRecoveryError(settings) ?? new Error(missingMessage);
}

// The typed error an automatic caller, such as Eval, reports while the default family recovers.
export function defaultFamilyRecoveryError(settings) {
  const recovery = settings?.defaultFamilyRecovery;
  const modelSetup = defaultFamilyModelSetup(settings);
  if (!recovery || !modelSetup) return null;
  const error = new Error(`The default model family is unavailable. ${modelSetup.message}`);
  error.code = recovery.reason.code;
  return error;
}

function harnessFor(settings, harnessId) {
  return settings.harnesses.find((harness) => harness.id === harnessId);
}

// Only a legacy conversation is contained to its original route (#597). A portable
// continuation conversation (ADR 0014) is offered every route an unrestricted one is. Any
// other or missing status is restricted, so an unknown state never widens routes.
export function compatibilityRestrictsRoute(compatibility) {
  if (!compatibility) return false;
  return compatibility.status !== "unrestricted" && compatibility.status !== "portable";
}

// A restricted conversation exposes routes only as a verified legacy owner ("compatible").
// "blocked" and any unknown or missing status expose none.
export function compatibilityExposesNoRoute(compatibility) {
  return compatibilityRestrictsRoute(compatibility) && compatibility.status !== "compatible";
}

export function harnessUsesConfigurationModel(settings, harnessId) {
  if (compatibilityRestrictsRoute(settings.conversationCompatibility)) return false;
  const harness = harnessFor(settings, harnessId);
  return Boolean(
    harness
    && harness.available !== false
    && harness.modelRules == null
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
  const compatibility = settings.conversationCompatibility;
  if (compatibilityExposesNoRoute(compatibility) || (compatibility?.status === "compatible" && compatibility.harnessId !== harnessId)) return [];
  const harness = harnessFor(settings, harnessId);
  if (!harness || harness.available === false) return [];
  return [...(family.members ?? [])]
    .sort((left, right) => left.position - right.position)
    .filter((member) => {
      if (compatibility?.status === "compatible" && member.providerId !== compatibility.providerId) return false;
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

// Automatic selection resolves the default family. While that family is in recovery it refuses,
// rather than running another family the user did not choose (PROV-008).
export function firstAvailableSelection(settings, harnessId) {
  if (defaultFamilyModelSetup(settings)) return null;
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

export function modelPickerContextCandidate({
  settings,
  mode,
  pinnedHarnessId,
  currentSelection,
  nextSelection,
  replaceSelection = false,
}) {
  const harnessId = mode === "ongoing"
    ? pinnedHarnessId
    : nextSelection?.harnessId
      ?? (replaceSelection ? null : currentSelection?.harnessId)
      ?? settings?.defaults?.harnessId;
  const candidate = replaceSelection ? nextSelection : currentSelection ?? nextSelection;
  return { ...candidate, harnessId };
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
  const selection = normalizePickerSelection(settings, { ...currentSelection, harnessId });
  if (selection) return { selection, error: null };
  if (harnessUsesConfigurationModel(settings, harnessId)) {
    return { selection: { harnessId, familyId: null, providerId: null, modelId: null }, error: null };
  }
  if (availablePickerFamilies(settings, harnessId).length > 0) {
    return { selection: { harnessId, familyId: null, providerId: null, modelId: null }, error: null };
  }
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
