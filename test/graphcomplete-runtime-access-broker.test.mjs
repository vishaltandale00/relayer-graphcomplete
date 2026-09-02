import { describe, expect, it, vi } from "vitest";

import {
  createProviderExecutionAccessBroker,
} from "../desktop/main/services/graphcomplete-runtime.mjs";

function providerLease({
  providerId,
  adapterId = "openai-api",
  accessContract = "secret@1",
  implementationVersion = "3",
  resolved = {
    kind: "secret",
    endpoint: "https://api.example.test/v1",
    fields: { "api-key": "secret" },
    runtime: {
      runtimeId: "codex",
      version: "0.150.1",
      executable: "/managed/codex",
      environment: { CODEX_HOME: "/isolated/codex" },
    },
  },
} = {}) {
  const release = vi.fn(async () => {});
  const executionAccess = vi.fn(async () => resolved);
  return {
    lease: {
      definition: {
        id: providerId,
        adapterId,
        accessContract,
        endpoint: accessContract === "secret@1" ? "https://api.example.test/v1" : null,
      },
      descriptor: { adapterId, accessContract, implementationVersion },
      runtime: { executionAccess },
      release,
    },
    release,
    executionAccess,
  };
}

describe("desktop provider execution access broker", () => {
  it("isolates parallel definitions, preserves validated descriptors and capabilities, and releases exactly once", async () => {
    const work = providerLease({ providerId: "openai-work" });
    const personal = providerLease({ providerId: "openai-personal" });
    const leases = new Map([
      ["openai-work", work.lease],
      ["openai-personal", personal.lease],
    ]);
    const acquireProviderExecution = vi.fn(async (providerId) => leases.get(providerId));
    const broker = createProviderExecutionAccessBroker(acquireProviderExecution);
    const signal = new AbortController().signal;

    const [workAccess, personalAccess] = await Promise.all([
      broker.acquire(
        { providerId: "openai-work", adapterId: "openai-api", modelId: "gpt-5" },
        ["secret@1"],
        signal,
      ),
      broker.acquire(
        { providerId: "openai-personal", adapterId: "openai-api", modelId: "gpt-5-mini" },
        ["secret@1"],
        signal,
      ),
    ]);

    expect(acquireProviderExecution.mock.calls, "one lease acquired per definition").toEqual([
      ["openai-work"],
      ["openai-personal"],
    ]);
    expect(workAccess.access, "work access carries the resolved runtime").toMatchObject({
      providerId: "openai-work",
      adapterId: "openai-api",
      adapterImplementationVersion: "3",
      contract: "secret@1",
      runtime: {
        runtimeId: "codex",
        version: "0.150.1",
        executable: "/managed/codex",
        environment: { CODEX_HOME: "/isolated/codex" },
      },
    });
    expect(personalAccess.access, "personal access keeps its own identity").toMatchObject({
      providerId: "openai-personal",
      adapterId: "openai-api",
      adapterImplementationVersion: "3",
      contract: "secret@1",
    });
    expect(workAccess.access, "accesses are not shared across definitions").not.toBe(personalAccess.access);

    await Promise.all([
      workAccess.release(), workAccess.release(),
      personalAccess.release(), personalAccess.release(),
    ]);
    expect(work.release, "work lease released exactly once").toHaveBeenCalledOnce();
    expect(personal.release, "personal lease released exactly once").toHaveBeenCalledOnce();

    const capabilitiesFixture = providerLease({
      providerId: "openrouter-work",
      adapterId: "openrouter",
      resolved: {
        kind: "secret",
        endpoint: "https://api.example.test/v1",
        fields: { "api-key": "secret" },
        modelCapabilities: {
          "z-ai/glm-5.3": { contextWindow: 202_752, maxOutputTokens: 131_072 },
        },
      },
    });
    const capabilitiesBroker = createProviderExecutionAccessBroker(async () => capabilitiesFixture.lease);
    const capabilitiesAcquired = await capabilitiesBroker.acquire(
      { providerId: "openrouter-work", adapterId: "openrouter", modelId: "z-ai/glm-5.3" },
      ["secret@1"],
      new AbortController().signal,
    );
    expect(capabilitiesAcquired.access.modelCapabilities, "validated per-model capabilities preserved").toEqual({
      "z-ai/glm-5.3": { contextWindow: 202_752, maxOutputTokens: 131_072 },
    });
    expect(
      Object.isFrozen(capabilitiesAcquired.access.modelCapabilities["z-ai/glm-5.3"]),
      "capabilities never treated as mutable credentials",
    ).toBe(true);
    await capabilitiesAcquired.release();

    const claudeFixture = providerLease({
      providerId: "claude-work",
      adapterId: "claude-subscription",
      accessContract: "managed-runtime@1",
      resolved: {
        kind: "managed-runtime",
        runtimeId: "claude",
        version: "2.1.0",
        executable: "/managed/claude",
        moduleUrl: "file:///managed/claude/sdk.mjs",
        environment: { CLAUDE_CONFIG_DIR: "/isolated/claude" },
      },
    });
    const claudeBroker = createProviderExecutionAccessBroker(async () => claudeFixture.lease);
    const claudeAccess = await claudeBroker.acquire(
      { providerId: "claude-work", adapterId: "claude-subscription", modelId: "sonnet" },
      ["managed-runtime@1"],
      new AbortController().signal,
    );
    expect(claudeAccess.access, "complete Claude managed runtime descriptor preserved").toMatchObject({
      runtimeId: "claude",
      version: "2.1.0",
      executable: "/managed/claude",
      moduleUrl: "file:///managed/claude/sdk.mjs",
      environment: { CLAUDE_CONFIG_DIR: "/isolated/claude" },
    });
    await claudeAccess.release();

    const coalescingFixture = providerLease({ providerId: "openai-work" });
    const failure = new Error("removal finalization failed");
    coalescingFixture.lease.release = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    const coalescingBroker = createProviderExecutionAccessBroker(async () => coalescingFixture.lease);
    const coalesced = await coalescingBroker.acquire(
      { providerId: "openai-work", adapterId: "openai-api", modelId: "gpt-5" },
      ["secret@1"],
      new AbortController().signal,
    );

    const firstRelease = coalesced.release();
    await expect(Promise.all([firstRelease, coalesced.release()]), "concurrent releases coalesce into one attempt")
      .rejects.toBe(failure);
    expect(coalescingFixture.lease.release, "coalesced concurrent releases call the lease once").toHaveBeenCalledOnce();
    await expect(coalesced.release(), "release retried after a rejected release").resolves.toBeUndefined();
    expect(coalescingFixture.lease.release, "retry reaches the lease a second time").toHaveBeenCalledTimes(2);
    await expect(coalesced.release(), "release is idempotent once settled").resolves.toBeUndefined();
    expect(coalescingFixture.lease.release, "settled release never calls the lease again").toHaveBeenCalledTimes(2);
  });

  it("rolls back exactly once for every mismatched admission and forwards cancellation to resolution", async () => {
    const cases = [
      {
        name: "provider definition",
        selection: { providerId: "expected", adapterId: "openai-api", modelId: "gpt-5" },
        fixture: providerLease({ providerId: "other" }),
      },
      {
        name: "adapter descriptor",
        selection: { providerId: "expected", adapterId: "anthropic-api", modelId: "claude" },
        fixture: providerLease({ providerId: "expected", adapterId: "openai-api" }),
      },
      {
        name: "accepted contract",
        selection: { providerId: "expected", adapterId: "openai-api", modelId: "gpt-5" },
        fixture: providerLease({ providerId: "expected" }),
        acceptedContracts: ["managed-runtime@1"],
      },
      {
        name: "tagged capability",
        selection: { providerId: "expected", adapterId: "openai-api", modelId: "gpt-5" },
        fixture: providerLease({
          providerId: "expected",
          resolved: { kind: "managed-runtime", environment: {} },
        }),
      },
      {
        name: "provider endpoint",
        selection: { providerId: "expected", adapterId: "openai-api", modelId: "gpt-5" },
        fixture: providerLease({
          providerId: "expected",
          resolved: {
            kind: "secret",
            endpoint: "https://different-account.example.test/v1",
            fields: { "api-key": "secret" },
          },
        }),
      },
      {
        name: "malformed model capabilities",
        selection: { providerId: "openrouter-work", adapterId: "openrouter", modelId: "z-ai/glm-5.3" },
        fixture: providerLease({
          providerId: "openrouter-work",
          adapterId: "openrouter",
          resolved: {
            kind: "secret",
            endpoint: "https://api.example.test/v1",
            fields: { "api-key": "secret" },
            modelCapabilities: {
              "z-ai/glm-5.3": { contextWindow: 202_752, maxOutputTokens: "unbounded" },
            },
          },
        }),
      },
    ];
    expect(cases, "mismatched admission inventory").toHaveLength(6);
    for (const {
      name,
      selection,
      fixture,
      acceptedContracts = ["secret@1"],
    } of cases) {
      const broker = createProviderExecutionAccessBroker(async () => fixture.lease);
      await expect(broker.acquire(
        selection,
        acceptedContracts,
        new AbortController().signal,
      ), `rollback when the ${name} does not match`).rejects.toThrow();
      expect(fixture.release, `${name} rollback releases the lease once`).toHaveBeenCalledOnce();
    }

    const cancellationFixture = providerLease({ providerId: "managed", adapterId: "codex-subscription" });
    const error = new Error("account disconnected");
    cancellationFixture.lease.definition.accessContract = "managed-runtime@1";
    cancellationFixture.lease.descriptor.accessContract = "managed-runtime@1";
    cancellationFixture.lease.runtime.executionAccess = vi.fn(async () => { throw error; });
    const cancellationBroker = createProviderExecutionAccessBroker(async () => cancellationFixture.lease);
    const controller = new AbortController();

    await expect(cancellationBroker.acquire(
      { providerId: "managed", adapterId: "codex-subscription", modelId: "gpt-5" },
      ["managed-runtime@1"],
      controller.signal,
    ), "failed resolution surfaces the original error").rejects.toBe(error);

    expect(cancellationFixture.lease.runtime.executionAccess, "cancellation forwarded to capability resolution")
      .toHaveBeenCalledWith({ signal: controller.signal });
    expect(cancellationFixture.release, "failed resolution rolls back once").toHaveBeenCalledOnce();
  });
});
