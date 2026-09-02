import { describe, expect, it } from "vitest";

import {
  createProviderConnectionCancellationState,
  createProviderOnboardingProjectionGate,
  providerOnboardingCompletionIntent,
  providerOnboardingRecoveryAction,
  reconcileProviderOnboardingState,
  resolveProviderOnboardingStep,
  resumableProviderDefinitions,
  setProviderOnboardingControlsBusy,
} from "../desktop/renderer/src/provider-onboarding-model.js";

const projection = {
  projectionRevision: "sha256:projection",
  initialHarnessId: null,
  harnesses: [
    { id: "packaged-default", selectable: false },
    { id: "compatible", selectable: true },
  ],
};

const compatibleWithChoices = {
  ...projection,
  harnesses: projection.harnesses.map((harness) => harness.id === "compatible" ? {
    ...harness,
    existingCustomFamilies: [{ id: 12 }],
    existingManagedFamilies: [],
    managedFamilyCandidate: { policyId: "managed", policyVersion: 3 },
    eligibleModels: [{ providerId: "work", modelId: "large" }],
  } : harness),
};

describe("provider onboarding renderer state", () => {
  it("reconciles harness and family intent against authoritative projections", () => {
    expect(providerOnboardingRecoveryAction({
      blockingReason: {
        code: "provider_no_eligible_execution_models",
        message: "No supported text models are available.",
      },
    }), "zero eligible models offers an exact-provider refresh").toEqual({
      kind: "refresh_models", label: "Refresh models and set up defaults",
    });
    expect(providerOnboardingRecoveryAction({
      blockingReason: { code: "harness_unavailable", message: "Install the harness." },
    }), "non-provider blockers offer no provider recovery").toBeNull();
    expect(providerOnboardingRecoveryAction({
      blockingReason: {
        code: "provider_no_available_execution_configurations",
        message: "No execution configuration is ready.",
      },
    }), "no ready route offers execution repair").toEqual({
      kind: "repair_execution", label: "Repair execution configurations",
    });

    expect(reconcileProviderOnboardingState(projection),
      "an incompatible app default never selects an alternate harness")
      .toEqual({ harnessId: null, family: null });

    const initiallyCompatible = {
      ...projection,
      initialHarnessId: "compatible",
      harnesses: projection.harnesses.map((harness) => harness.id === "compatible" ? {
        ...harness,
        existingCustomFamilies: [{ id: 12 }],
      } : harness),
    };
    expect(reconcileProviderOnboardingState(initiallyCompatible),
      "only the authoritative initial harness is selected").toEqual({ harnessId: "compatible", family: null });
    const family = { kind: "existing", familyId: 12 };
    expect(reconcileProviderOnboardingState(initiallyCompatible, { harnessId: "compatible", family }),
      "an explicit compatible choice survives refresh").toEqual({ harnessId: "compatible", family });

    expect(reconcileProviderOnboardingState(compatibleWithChoices, {
      harnessId: "compatible",
      family: { kind: "existing", familyId: 99 },
    }).family, "a stale existing family id is dropped").toBeNull();
    expect(reconcileProviderOnboardingState(compatibleWithChoices, {
      harnessId: "compatible",
      family: { kind: "managed", policyId: "managed", policyVersion: 2 },
    }).family, "an out-of-date managed policy version is dropped").toBeNull();
    expect(reconcileProviderOnboardingState(compatibleWithChoices, {
      harnessId: "compatible",
      family: {
        kind: "create",
        name: "Work",
        members: [
          { providerId: "work", modelId: "large" },
          { providerId: "work", modelId: "removed" },
        ],
      },
    }).family, "create intent keeps only still-eligible members").toEqual({
      kind: "create",
      name: "Work",
      members: [{ providerId: "work", modelId: "large" }],
    });

    expect(reconcileProviderOnboardingState({
      ...projection,
      harnesses: projection.harnesses.map((harness) => ({ ...harness, selectable: false })),
    }, { harnessId: "compatible", family: { kind: "existing", familyId: 12 } }),
    "an unavailable harness clears both harness and family intent").toEqual({ harnessId: null, family: null });

    expect(resumableProviderDefinitions({ definitions: [
      { id: "work", connected: true, lifecycleState: "active" },
      { id: "signed-out", connected: false, lifecycleState: "active" },
      { id: "draining", connected: true, lifecycleState: "removal_pending" },
      { id: "removed", connected: true, lifecycleState: "tombstoned" },
    ] }), "only persisted connected active definitions resume").toEqual([
      { id: "work", connected: true, lifecycleState: "active" },
    ]);

    const base = { providerId: "work", projection, harnessId: "compatible" };
    expect(providerOnboardingCompletionIntent({
      ...base,
      family: { kind: "create", name: "Work", members: [] },
    }), "custom families require explicit members").toBeNull();
    expect(providerOnboardingCompletionIntent({
      ...base,
      family: { kind: "create", name: "  Work choices  ", members: [{ providerId: "work", modelId: "large" }] },
    }), "completion pins the optimistic projection revision and trims the name").toEqual({
      providerId: "work",
      harnessId: "compatible",
      expectedProjectionRevision: "sha256:projection",
      family: { kind: "create", name: "Work choices", members: [{ providerId: "work", modelId: "large" }] },
    });
  });

  it("drops stale provider step responses through the projection gate", async () => {
    const gate = createProviderOnboardingProjectionGate();
    const first = gate.begin("provider-a");
    const second = gate.begin("provider-b");
    expect(gate.isCurrent(first, "provider-a"), "an out-of-order projection is rejected").toBe(false);
    expect(gate.isCurrent(second, "provider-a"), "a superseded provider is not current").toBe(false);
    expect(gate.isCurrent(second, "provider-b"), "the latest provider request is current").toBe(true);

    let activeProvider = "provider-a";
    let resolveDefault;
    const firstRequest = gate.begin(activeProvider);
    const staleDefault = resolveProviderOnboardingStep({
      gate,
      request: firstRequest,
      providerId: "provider-a",
      activeProviderId: () => activeProvider,
      preserveIntent: false,
      completeDefault: () => new Promise((resolve) => { resolveDefault = resolve; }),
      loadProjection: async () => ({ provider: { id: "provider-a" } }),
    });
    activeProvider = "provider-b";
    gate.begin(activeProvider);
    resolveDefault(true);
    await expect(staleDefault, "a stale default-completion response is dropped").resolves.toEqual({ kind: "stale" });

    let resolveProjection;
    const secondRequest = gate.begin(activeProvider);
    const staleProjection = resolveProviderOnboardingStep({
      gate,
      request: secondRequest,
      providerId: "provider-b",
      activeProviderId: () => activeProvider,
      preserveIntent: true,
      completeDefault: async () => false,
      loadProjection: () => new Promise((resolve) => { resolveProjection = resolve; }),
    });
    activeProvider = "provider-a";
    gate.begin(activeProvider);
    resolveProjection({ provider: { id: "provider-b" } });
    await expect(staleProjection, "a stale projection response is dropped").resolves.toEqual({ kind: "stale" });
  });

  it("owns connection submission, cancellation, and busy controls", async () => {
    const state = createProviderConnectionCancellationState();
    expect(state.begin("request-1"), "the first Connect wins ownership").toBe(true);
    expect(state.transition("request-2", "authorization-2"), "a foreign submission cannot hand off").toBe(false);
    expect(state.current(), "foreign handoffs leave ownership untouched").toBe("request-1");
    expect(state.transition("request-1", "authorization-1"), "the owned submission hands off to managed login").toBe(true);
    expect(state.current(), "handoff moves ownership to the managed-login id").toBe("authorization-1");
    expect(state.matches("authorization-1"), "the managed-login id matches").toBe(true);

    let finishConnection;
    const connection = new Promise((resolve) => { finishConnection = resolve; });
    const lateState = createProviderConnectionCancellationState();
    lateState.begin("connection-1");
    let onboardingContinued = false;
    const connecting = connection.then(() => {
      if (!lateState.matches("connection-1")) return;
      lateState.complete("connection-1");
      onboardingContinued = true;
    });
    await expect(lateState.cancel(async () => ({ cancelled: false })),
      "Cancel after commit reports the provider's own result").resolves.toEqual({
      cancelled: false,
      connectionId: "connection-1",
    });
    expect(lateState.current(), "Cancel keeps the committed connection live").toBe("connection-1");
    finishConnection();
    await connecting;
    expect(onboardingContinued, "the original onboarding continues after Cancel").toBe(true);
    expect(lateState.current(), "completion clears the connection id").toBeNull();

    let resolveFirst;
    const firstResponse = new Promise((resolve) => { resolveFirst = resolve; });
    const duplicateState = createProviderConnectionCancellationState();
    const submit = (connectionId) => {
      if (!duplicateState.begin(connectionId)) return Promise.resolve("ignored");
      return firstResponse.then(() => {
        if (!duplicateState.matches(connectionId)) return "discarded";
        duplicateState.complete(connectionId);
        return "continued";
      });
    };
    const first = submit("connection-1");
    await expect(submit("connection-2"), "a duplicate Connect is ignored").resolves.toBe("ignored");
    expect(duplicateState.current(), "the duplicate does not replace the first winner").toBe("connection-1");
    resolveFirst();
    await expect(first, "the first winner continues").resolves.toBe("continued");
    expect(duplicateState.current(), "the winner clears ownership on completion").toBeNull();

    const controls = [
      { disabled: false, dataset: {} },
      { disabled: true, dataset: {} },
      { disabled: false, dataset: {} },
    ];
    setProviderOnboardingControlsBusy(controls, true);
    expect(controls.map(({ disabled }) => disabled), "busy disables every edit control").toEqual([true, true, true]);
    setProviderOnboardingControlsBusy(controls, false);
    expect(controls.map(({ disabled }) => disabled), "unbusy restores prior disabled states").toEqual([false, true, false]);
    expect(controls.every(({ dataset }) => dataset.onboardingDisabledBeforeBusy === undefined),
      "busy bookkeeping leaves no residue").toBe(true);
  });
});
