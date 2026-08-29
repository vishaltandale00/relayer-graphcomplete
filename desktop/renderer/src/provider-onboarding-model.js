function sameModel(left, right) {
  return left.providerId === right.providerId && left.modelId === right.modelId;
}

function reconcileFamily(options, family) {
  if (!family) return null;
  if (family.kind === "existing") {
    const choices = [...(options.existingCustomFamilies ?? []), ...(options.existingManagedFamilies ?? [])];
    return choices.some(({ id }) => String(id) === String(family.familyId)) ? family : null;
  }
  if (family.kind === "managed") {
    const candidate = options.managedFamilyCandidate;
    return candidate
      && candidate.policyId === family.policyId
      && candidate.policyVersion === family.policyVersion
      ? family
      : null;
  }
  if (family.kind === "create") {
    const eligible = options.eligibleModels ?? [];
    return {
      ...family,
      members: (family.members ?? []).filter((member) => eligible.some((model) => sameModel(member, model))),
    };
  }
  return null;
}

export function reconcileProviderOnboardingState(projection, previous = null) {
  return Object.freeze({
    family: projection?.familyOptions
      ? reconcileFamily(projection.familyOptions, previous?.family ?? previous)
      : null,
  });
}

export function resumableProviderDefinitions(providerStatus) {
  return (providerStatus?.definitions ?? []).filter((definition) => (
    definition.connected === true && definition.lifecycleState === "active"
  ));
}

export function providerOnboardingCompletionIntent({ providerId, projection, family }) {
  if (!providerId || !projection?.projectionRevision || !projection?.familyOptions || !family) return null;
  if (family.kind === "create" && (!family.name?.trim() || !family.members?.length)) return null;
  return {
    providerId,
    expectedProjectionRevision: projection.projectionRevision,
    family: family.kind === "create" ? { ...family, name: family.name.trim() } : family,
  };
}

export function setProviderOnboardingControlsBusy(controls, busy) {
  for (const control of controls) {
    if (busy) {
      control.dataset.onboardingDisabledBeforeBusy = String(control.disabled);
      control.disabled = true;
    } else if (control.dataset.onboardingDisabledBeforeBusy !== undefined) {
      control.disabled = control.dataset.onboardingDisabledBeforeBusy === "true";
      delete control.dataset.onboardingDisabledBeforeBusy;
    }
  }
}

export function createProviderConnectionCancellationState() {
  let connectionId = null;
  return Object.freeze({
    begin(value) {
      const next = String(value || "");
      if (connectionId !== null) return connectionId === next;
      connectionId = next;
      return true;
    },
    current() {
      return connectionId;
    },
    matches(value) {
      return connectionId !== null && connectionId === value;
    },
    transition(from, to) {
      if (connectionId === null || connectionId !== String(from || "")) return false;
      connectionId = String(to || "");
      return true;
    },
    complete(value) {
      if (value === undefined || connectionId === value) connectionId = null;
    },
    async cancel(cancelConnection) {
      const attemptedConnectionId = connectionId;
      if (!attemptedConnectionId) return Object.freeze({ cancelled: false, connectionId: null });
      try {
        const result = await cancelConnection(attemptedConnectionId);
        const cancelled = result?.cancelled === true;
        if (cancelled && connectionId === attemptedConnectionId) connectionId = null;
        return Object.freeze({ cancelled, connectionId: attemptedConnectionId });
      } catch (error) {
        return Object.freeze({ cancelled: false, connectionId: attemptedConnectionId, error });
      }
    },
  });
}
