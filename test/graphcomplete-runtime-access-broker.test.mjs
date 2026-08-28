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
  it("keeps two definitions on one adapter isolated and releases each lease exactly once", async () => {
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

    expect(acquireProviderExecution.mock.calls).toEqual([
      ["openai-work"],
      ["openai-personal"],
    ]);
    expect(workAccess.access).toMatchObject({
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
    expect(personalAccess.access).toMatchObject({
      providerId: "openai-personal",
      adapterId: "openai-api",
      adapterImplementationVersion: "3",
      contract: "secret@1",
    });
    expect(workAccess.access).not.toBe(personalAccess.access);

    await Promise.all([
      workAccess.release(), workAccess.release(),
      personalAccess.release(), personalAccess.release(),
    ]);
    expect(work.release).toHaveBeenCalledOnce();
    expect(personal.release).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent releases but retries after a rejected release", async () => {
    const fixture = providerLease({ providerId: "openai-work" });
    const failure = new Error("removal finalization failed");
    fixture.lease.release = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    const broker = createProviderExecutionAccessBroker(async () => fixture.lease);
    const acquired = await broker.acquire(
      { providerId: "openai-work", adapterId: "openai-api", modelId: "gpt-5" },
      ["secret@1"],
      new AbortController().signal,
    );

    const first = acquired.release();
    await expect(Promise.all([first, acquired.release()])).rejects.toBe(failure);
    expect(fixture.lease.release).toHaveBeenCalledOnce();
    await expect(acquired.release()).resolves.toBeUndefined();
    expect(fixture.lease.release).toHaveBeenCalledTimes(2);
    await expect(acquired.release()).resolves.toBeUndefined();
    expect(fixture.lease.release).toHaveBeenCalledTimes(2);
  });

  it.each([
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
  ])("rolls back once when the $name does not match", async ({
    selection,
    fixture,
    acceptedContracts = ["secret@1"],
  }) => {
    const broker = createProviderExecutionAccessBroker(async () => fixture.lease);

    await expect(broker.acquire(
      selection,
      acceptedContracts,
      new AbortController().signal,
    )).rejects.toThrow();

    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("passes cancellation to capability resolution and rolls back a failed resolution once", async () => {
    const fixture = providerLease({ providerId: "managed", adapterId: "codex-subscription" });
    const error = new Error("account disconnected");
    fixture.lease.definition.accessContract = "managed-runtime@1";
    fixture.lease.descriptor.accessContract = "managed-runtime@1";
    fixture.lease.runtime.executionAccess = vi.fn(async () => { throw error; });
    const broker = createProviderExecutionAccessBroker(async () => fixture.lease);
    const controller = new AbortController();

    await expect(broker.acquire(
      { providerId: "managed", adapterId: "codex-subscription", modelId: "gpt-5" },
      ["managed-runtime@1"],
      controller.signal,
    )).rejects.toBe(error);

    expect(fixture.lease.runtime.executionAccess).toHaveBeenCalledWith({ signal: controller.signal });
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("preserves the complete Claude managed runtime descriptor", async () => {
    const fixture = providerLease({
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
    const broker = createProviderExecutionAccessBroker(async () => fixture.lease);

    const acquired = await broker.acquire(
      { providerId: "claude-work", adapterId: "claude-subscription", modelId: "sonnet" },
      ["managed-runtime@1"],
      new AbortController().signal,
    );

    expect(acquired.access).toMatchObject({
      runtimeId: "claude",
      version: "2.1.0",
      executable: "/managed/claude",
      moduleUrl: "file:///managed/claude/sdk.mjs",
      environment: { CLAUDE_CONFIG_DIR: "/isolated/claude" },
    });
    await acquired.release();
  });
});
