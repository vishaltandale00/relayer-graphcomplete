function sameModel(left, right) {
  return left.providerId === right.providerId && left.modelId === right.modelId;
}

function reconcileFamily(harness, family) {
  if (!family) return null;
  if (family.kind === "existing") {
    const choices = [...(harness.existingCustomFamilies ?? []), ...(harness.existingManagedFamilies ?? [])];
    return choices.some(({ id }) => String(id) === String(family.familyId)) ? family : null;
  }
  if (family.kind === "managed") {
    const candidate = harness.managedFamilyCandidate;
    return candidate
      && candidate.policyId === family.policyId
      && candidate.policyVersion === family.policyVersion
      ? family
      : null;
  }
  if (family.kind === "create") {
    const eligible = harness.eligibleModels ?? [];
    return {
      ...family,
      members: (family.members ?? []).filter((member) => eligible.some((model) => sameModel(member, model))),
    };
  }
  return null;
}

export function reconcileProviderOnboardingState(projection, previous = null) {
  const priorHarness = previous?.harnessId;
  const priorStillSelectable = projection.harnesses.some(({ id, selectable }) => (
    id === priorHarness && selectable
  ));
  const harnessId = priorStillSelectable ? priorHarness : projection.initialHarnessId;
  const harness = projection.harnesses.find(({ id }) => id === harnessId);
  return Object.freeze({
    harnessId,
    family: harnessId === priorHarness && harness ? reconcileFamily(harness, previous.family) : null,
  });
}

export function resumableProviderDefinitions(providerStatus) {
  return (providerStatus?.definitions ?? []).filter((definition) => (
    definition.connected === true && definition.lifecycleState === "active"
  ));
}

export function providerOnboardingRecoveryAction(projection) {
  if (projection?.blockingReason?.code !== "provider_no_eligible_execution_models") return null;
  return Object.freeze({
    kind: "refresh_models",
    label: "Refresh models and set up defaults",
  });
}

export function createProviderOnboardingProjectionGate() {
  let revision = 0;
  return Object.freeze({
    begin(providerId) {
      return Object.freeze({ revision: ++revision, providerId: String(providerId) });
    },
    isCurrent(request, providerId) {
      return request?.revision === revision && request.providerId === String(providerId);
    },
  });
}

export async function resolveProviderOnboardingStep({
  gate,
  request,
  providerId,
  activeProviderId,
  preserveIntent,
  completeDefault,
  loadProjection,
}) {
  if (!preserveIntent) {
    const completed = await completeDefault(providerId);
    if (!gate.isCurrent(request, activeProviderId())) return { kind: "stale" };
    if (completed) return { kind: "complete" };
  }
  const projection = await loadProjection(providerId);
  if (!gate.isCurrent(request, activeProviderId())) return { kind: "stale" };
  return { kind: "projection", projection };
}

export function providerOnboardingCompletionIntent({ providerId, projection, harnessId, family }) {
  if (!providerId || !projection?.projectionRevision || !harnessId || !family) return null;
  if (family.kind === "create" && (!family.name?.trim() || !family.members?.length)) return null;
  return {
    providerId,
    harnessId,
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
