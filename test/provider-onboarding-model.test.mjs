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

describe("provider onboarding renderer state", () => {
  it("offers an exact-provider refresh when setup is blocked by zero eligible execution models", () => {
    expect(providerOnboardingRecoveryAction({
      blockingReason: {
        code: "provider_no_eligible_execution_models",
        message: "No supported text models are available.",
      },
    })).toEqual({ kind: "refresh_models", label: "Refresh models and set up defaults" });
    expect(providerOnboardingRecoveryAction({
      blockingReason: { code: "harness_unavailable", message: "Install the harness." },
    })).toBeNull();
    expect(providerOnboardingRecoveryAction({
      blockingReason: {
        code: "provider_no_available_execution_configurations",
        message: "No execution configuration is ready.",
      },
    })).toEqual({ kind: "repair_execution", label: "Repair execution configurations" });
  });

  it("rejects an out-of-order projection and binds recovery to the rendered provider", () => {
    const gate = createProviderOnboardingProjectionGate();
    const first = gate.begin("provider-a");
    const second = gate.begin("provider-b");
    expect(gate.isCurrent(first, "provider-a")).toBe(false);
    expect(gate.isCurrent(second, "provider-a")).toBe(false);
    expect(gate.isCurrent(second, "provider-b")).toBe(true);
  });

  it("drops stale default-completion and projection responses at the production onboarding seam", async () => {
    const gate = createProviderOnboardingProjectionGate();
    let activeProvider = "provider-a";
    let resolveDefault;
    const first = gate.begin(activeProvider);
    const staleDefault = resolveProviderOnboardingStep({
      gate,
      request: first,
      providerId: "provider-a",
      activeProviderId: () => activeProvider,
      preserveIntent: false,
      completeDefault: () => new Promise((resolve) => { resolveDefault = resolve; }),
      loadProjection: async () => ({ provider: { id: "provider-a" } }),
    });
    activeProvider = "provider-b";
    gate.begin(activeProvider);
    resolveDefault(true);
    await expect(staleDefault).resolves.toEqual({ kind: "stale" });

    let resolveProjection;
    const second = gate.begin(activeProvider);
    const staleProjection = resolveProviderOnboardingStep({
      gate,
      request: second,
      providerId: "provider-b",
      activeProviderId: () => activeProvider,
      preserveIntent: true,
      completeDefault: async () => false,
      loadProjection: () => new Promise((resolve) => { resolveProjection = resolve; }),
    });
    activeProvider = "provider-a";
    gate.begin(activeProvider);
    resolveProjection({ provider: { id: "provider-b" } });
    await expect(staleProjection).resolves.toEqual({ kind: "stale" });
  });

  it("does not silently choose an alternate harness when the app default is incompatible", () => {
    expect(reconcileProviderOnboardingState(projection)).toEqual({ harnessId: null, family: null });
  });

  it("uses only the authoritative initial harness and preserves an explicit compatible choice on refresh", () => {
    const initiallyCompatible = {
      ...projection,
      initialHarnessId: "compatible",
      harnesses: projection.harnesses.map((harness) => harness.id === "compatible" ? {
        ...harness,
        existingCustomFamilies: [{ id: 12 }],
      } : harness),
    };
    expect(reconcileProviderOnboardingState(initiallyCompatible)).toEqual({
      harnessId: "compatible",
      family: null,
    });
    const family = { kind: "existing", familyId: 12 };
    expect(reconcileProviderOnboardingState(initiallyCompatible, { harnessId: "compatible", family })).toEqual({
      harnessId: "compatible",
      family,
    });
  });

  it("reconciles preserved family intent against the refreshed authoritative choices", () => {
    const withChoices = {
      ...projection,
      harnesses: projection.harnesses.map((harness) => harness.id === "compatible" ? {
        ...harness,
        existingCustomFamilies: [{ id: 12 }],
        existingManagedFamilies: [],
        managedFamilyCandidate: { policyId: "managed", policyVersion: 3 },
        eligibleModels: [{ providerId: "work", modelId: "large" }],
      } : harness),
    };
    expect(reconcileProviderOnboardingState(withChoices, {
      harnessId: "compatible",
      family: { kind: "existing", familyId: 99 },
    }).family).toBeNull();
    expect(reconcileProviderOnboardingState(withChoices, {
      harnessId: "compatible",
      family: { kind: "managed", policyId: "managed", policyVersion: 2 },
    }).family).toBeNull();
    expect(reconcileProviderOnboardingState(withChoices, {
      harnessId: "compatible",
      family: {
        kind: "create",
        name: "Work",
        members: [
          { providerId: "work", modelId: "large" },
          { providerId: "work", modelId: "removed" },
        ],
      },
    }).family).toEqual({
      kind: "create",
      name: "Work",
      members: [{ providerId: "work", modelId: "large" }],
    });
  });

  it("offers every persisted connected definition for interrupted onboarding", () => {
    expect(resumableProviderDefinitions({ definitions: [
      { id: "work", connected: true, lifecycleState: "active" },
      { id: "signed-out", connected: false, lifecycleState: "active" },
      { id: "draining", connected: true, lifecycleState: "removal_pending" },
      { id: "removed", connected: true, lifecycleState: "tombstoned" },
    ] })).toEqual([{ id: "work", connected: true, lifecycleState: "active" }]);
  });

  it("clears family intent when a refreshed projection makes its harness unavailable", () => {
    expect(reconcileProviderOnboardingState({
      ...projection,
      harnesses: projection.harnesses.map((harness) => ({ ...harness, selectable: false })),
    }, { harnessId: "compatible", family: { kind: "existing", familyId: 12 } })).toEqual({
      harnessId: null,
      family: null,
    });
  });

  it("requires explicit custom members and preserves the optimistic projection revision", () => {
    const base = { providerId: "work", projection, harnessId: "compatible" };
    expect(providerOnboardingCompletionIntent({
      ...base,
      family: { kind: "create", name: "Work", members: [] },
    })).toBeNull();
    expect(providerOnboardingCompletionIntent({
      ...base,
      family: { kind: "create", name: "  Work choices  ", members: [{ providerId: "work", modelId: "large" }] },
    })).toEqual({
      providerId: "work",
      harnessId: "compatible",
      expectedProjectionRevision: "sha256:projection",
      family: { kind: "create", name: "Work choices", members: [{ providerId: "work", modelId: "large" }] },
    });
  });

  it("disables every edit control while busy and restores prior disabled states", () => {
    const controls = [
      { disabled: false, dataset: {} },
      { disabled: true, dataset: {} },
      { disabled: false, dataset: {} },
    ];
    setProviderOnboardingControlsBusy(controls, true);
    expect(controls.map(({ disabled }) => disabled)).toEqual([true, true, true]);
    setProviderOnboardingControlsBusy(controls, false);
    expect(controls.map(({ disabled }) => disabled)).toEqual([false, true, false]);
    expect(controls.every(({ dataset }) => dataset.onboardingDisabledBeforeBusy === undefined)).toBe(true);
  });

  it("keeps the original connection live when Cancel reaches the provider after commit begins", async () => {
    let finishConnection;
    const connection = new Promise((resolve) => { finishConnection = resolve; });
    const state = createProviderConnectionCancellationState();
    state.begin("connection-1");
    let onboardingContinued = false;
    const connecting = connection.then(() => {
      if (!state.matches("connection-1")) return;
      state.complete("connection-1");
      onboardingContinued = true;
    });

    await expect(state.cancel(async () => ({ cancelled: false }))).resolves.toEqual({
      cancelled: false,
      connectionId: "connection-1",
    });
    expect(state.current()).toBe("connection-1");
    finishConnection();
    await connecting;

    expect(onboardingContinued).toBe(true);
    expect(state.current()).toBeNull();
  });

  it("ignores a duplicate Connect submission without replacing the first winner", async () => {
    let resolveFirst;
    const firstResponse = new Promise((resolve) => { resolveFirst = resolve; });
    const state = createProviderConnectionCancellationState();
    const submit = (connectionId) => {
      if (!state.begin(connectionId)) return Promise.resolve("ignored");
      return firstResponse.then(() => {
        if (!state.matches(connectionId)) return "discarded";
        state.complete(connectionId);
        return "continued";
      });
    };

    const first = submit("connection-1");
    await expect(submit("connection-2")).resolves.toBe("ignored");
    expect(state.current()).toBe("connection-1");
    resolveFirst();

    await expect(first).resolves.toBe("continued");
    expect(state.current()).toBeNull();
  });

  it("hands an owned Connect submission off to its managed-login connection", () => {
    const state = createProviderConnectionCancellationState();
    expect(state.begin("request-1")).toBe(true);

    expect(state.transition("request-2", "authorization-2")).toBe(false);
    expect(state.current()).toBe("request-1");
    expect(state.transition("request-1", "authorization-1")).toBe(true);
    expect(state.current()).toBe("authorization-1");
    expect(state.matches("authorization-1")).toBe(true);
  });
});
