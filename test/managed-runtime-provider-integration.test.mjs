import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProviderAdapterRegistry } from "../desktop/main/providers/provider-adapter-contract.mjs";
import { ProviderDefinitionService } from "../desktop/main/providers/provider-definition-service.mjs";
import { productionProviderAdapterRegistry } from "../desktop/main/providers/provider-adapter-registry.mjs";
import { createProviderExecutionAccessBroker } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { CodexBasicHarness } from "../packages/harness-host/src/implementations/codex-basic.ts";
import { createNoopHarnessTraceSink } from "../packages/harness-host/src/trace.ts";

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

function fixture({ prepareRuntime = async () => ({ runtimeId: "codex" }), discover, credentialSet } = {}) {
  const order = [];
  const definitions = [];
  const create = vi.fn(() => {
    order.push("create-provider");
    return {
      discover: async () => {
        order.push("discover-models");
        if (discover) return discover();
        return { models: [{ visible: true }] };
      },
      close: vi.fn(async () => {}),
    };
  });
  const service = new ProviderDefinitionService({
    registry: createProviderAdapterRegistry([{
      adapterId: "fake-api",
      implementationVersion: "1",
      label: "Fake API",
      accessContract: "secret@1",
      defaultEndpoint: "https://example.test/v1",
      endpointEditableDuringCreation: true,
      connection: {
        mode: "secret-fields",
        fields: [{ id: "api-key", label: "API key", kind: "secret", required: true }],
      },
      create,
    }]),
    definitionStore: {
      async load() { return definitions; },
      async createWithCatalog(candidate) {
        order.push("commit-provider");
        definitions.push(candidate);
      },
    },
    credentialStore: {
      async set() {
        order.push("commit-credential");
        await credentialSet?.();
      },
      async delete() {},
    },
    prepareRuntime: async (...args) => {
      order.push("ensure-runtime");
      return prepareRuntime(...args);
    },
  });
  return { service, create, definitions, order };
}

describe("managed runtime provider Connect boundary", () => {
  it.each(["openai-api", "openrouter", "vercel-ai-router"])(
    "carries %s runtime access through the broker into Codex with ephemeral auth.json",
    async (adapterId) => {
    let submitted;
    const codexHome = await mkdtemp(join(tmpdir(), "relayer-codex-int-"));
    const providerId = `${adapterId}-work`;
    const definition = {
      id: providerId, adapterId, label: `${adapterId} Work`,
      endpoint: "https://api.provider.test/v1", accessContract: "secret@1", credentialReference: `provider:${providerId}`,
      lifecycleState: "active", removedAt: null,
    };
    const adapter = productionProviderAdapterRegistry.create(definition, {
      fetch: vi.fn(), secrets: { "api-key": "secret" },
    });
    const broker = createProviderExecutionAccessBroker(async () => ({
      definition,
      descriptor: productionProviderAdapterRegistry.get(adapterId),
      runtime: adapter,
      release: async () => {},
    }));
    const acquired = await broker.acquire(
      { providerId, adapterId, modelId: "gpt-test" },
      ["secret@1"],
      new AbortController().signal,
    );
    const harness = new CodexBasicHarness({
      threadId: 1, permissionProfileId: "auto", workingDirectory: process.cwd(),
      permissionBinding: { sandboxMode: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "auto_review", networkAccessEnabled: true },
      configuration: {
        schemaVersion: 1, name: "codex-basic", implementation: "codex.basic", implementationVersion: 1,
        permissionBindings: { auto: { sandboxMode: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "auto_review", networkAccessEnabled: true } },
        settings: {},
      },
    }, {
      runAppServerTurn: async (options) => {
        submitted = options;
        const authFile = JSON.parse(await readFile(join(codexHome, "auth.json"), "utf8"));
        expect(authFile).toEqual({ auth_mode: "apikey", OPENAI_API_KEY: "secret" });
        options.onThreadId("thread-1");
        return { threadId: "thread-1", turnId: "turn-1", status: "completed" };
      },
      resolveCodexRuntime: async () => ({
        executable: "/managed/codex",
        environment: { CODEX_HOME: codexHome, RELAYER_CODEX_BINARY: "/managed/codex" },
      }),
    });
    const inputGraph = { id: 1, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" };
    await harness.complete({
      origin: { kind: "root" },
      inputGraph, interactionInput: { interaction: inputGraph, contexts: [] },
      model: { providerId, adapterId, modelId: "gpt-test" },
      access: acquired.access,
      graph: { interactionNodeId: 1, acquireCapability: () => ({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 }) },
      approvals: { request: async () => { throw new Error("unused"); } },
      trace: createNoopHarnessTraceSink(),
    });

    expect(acquired.access).not.toHaveProperty("runtime");
    expect(submitted.codexPathOverride).toBe("/managed/codex");
    expect(submitted.environment.CODEX_HOME).toBe(codexHome);
    expect(submitted.environment.OPENAI_API_KEY).toBe("secret");
    await expect(readFile(join(codexHome, "auth.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await acquired.release();
    await rm(codexHome, { recursive: true, force: true });
  });

  it("finishes managed runtime preparation before provider authentication or discovery", async () => {
    const subject = fixture();

    await expect(subject.service.connect({
      connectionId: "connect-1",
      harnessId: "codex-basic",
      adapterId: "fake-api",
      label: "Work",
      fields: { "api-key": "secret" },
    })).resolves.toMatchObject({ status: "connected" });

    expect(subject.order).toEqual([
      "ensure-runtime",
      "create-provider",
      "discover-models",
      "commit-credential",
      "commit-provider",
    ]);
  });

  it("cancels onboarding without cancelling the installer-owned operation or committing a provider", async () => {
    const installation = deferred();
    const subject = fixture({ prepareRuntime: () => installation.promise });
    const connection = subject.service.connect({
      connectionId: "connect-cancelled",
      harnessId: "claude-basic",
      adapterId: "fake-api",
      label: "Cancelled",
      fields: { "api-key": "secret" },
    });
    await vi.waitFor(() => expect(subject.order).toEqual(["ensure-runtime"]));

    await expect(subject.service.cancelConnection("connect-cancelled")).resolves.toBe(true);
    installation.resolve({ runtimeId: "claude" });

    await expect(connection).rejects.toThrow("Provider connection was cancelled");
    expect(subject.create).not.toHaveBeenCalled();
    expect(subject.definitions).toEqual([]);
  });

  it("honors cancellation sent immediately after Connect before its queued work starts", async () => {
    const installation = deferred();
    const subject = fixture({ prepareRuntime: () => installation.promise });
    const connection = subject.service.connect({
      connectionId: "connect-immediate-cancel",
      harnessId: "codex-basic",
      adapterId: "fake-api",
      label: "Cancelled immediately",
      fields: { "api-key": "secret" },
    });

    await expect(subject.service.cancelConnection("connect-immediate-cancel")).resolves.toBe(true);
    installation.resolve({ runtimeId: "codex" });

    await expect(connection).rejects.toThrow("Provider connection was cancelled");
    expect(subject.create).not.toHaveBeenCalled();
  });

  it("admits exactly one winner when same-label connections begin together", async () => {
    const installation = deferred();
    const subject = fixture({ prepareRuntime: () => installation.promise });
    const first = subject.service.connect({
      connectionId: "same-label-first",
      adapterId: "fake-api",
      label: "Shared name",
      fields: { "api-key": "first" },
    });
    const second = subject.service.connect({
      connectionId: "same-label-second",
      adapterId: "fake-api",
      label: "Shared name",
      fields: { "api-key": "second" },
    });

    await vi.waitFor(() => expect(subject.order).toEqual(["ensure-runtime"]));
    installation.resolve({ runtimeId: "codex" });

    await expect(first).resolves.toMatchObject({
      status: "connected",
      providerDefinition: { id: "same-label-first" },
    });
    await expect(second).rejects.toThrow(/preparing provider connection|already uses that name/);
    expect(new Set(subject.definitions.map(({ id }) => id))).toEqual(new Set(["same-label-first"]));
  });

  it("cancels and drains a runtime preparation before service close completes", async () => {
    const installation = deferred();
    const subject = fixture({ prepareRuntime: () => installation.promise });
    const connection = subject.service.connect({
      connectionId: "close-during-prepare",
      adapterId: "fake-api",
      label: "Closing",
      fields: { "api-key": "secret" },
    });
    await vi.waitFor(() => expect(subject.order).toEqual(["ensure-runtime"]));

    let closed = false;
    const closing = subject.service.close().then(() => { closed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    installation.resolve({ runtimeId: "codex" });

    await expect(connection).rejects.toThrow("Provider connection was cancelled");
    await closing;
    expect(subject.create).not.toHaveBeenCalled();
    await expect(subject.service.connect({
      connectionId: "after-close",
      adapterId: "fake-api",
      label: "After close",
    })).rejects.toThrow("shutting down");
  });

  it("closes managed login and does not publish it when onboarding is cancelled while login starts", async () => {
    const loginStarted = deferred();
    const close = vi.fn(async () => {});
    let attempt = 0;
    const service = new ProviderDefinitionService({
      registry: createProviderAdapterRegistry([{
        adapterId: "fake-managed",
        implementationVersion: "1",
        label: "Fake managed",
        accessContract: "managed-runtime@1",
        defaultEndpoint: null,
        connection: { mode: "managed-login", fields: [] },
        create: vi.fn(() => ({
          credentials: {
            login: vi.fn(() => (attempt++ === 0
              ? loginStarted.promise
              : Promise.resolve({ verificationUri: "https://example.test/login" }))),
          },
          close,
        })),
      }]),
      definitionStore: { async load() { return []; } },
      credentialStore: {},
    });
    const connection = service.connect({
      connectionId: "managed-login-cancel",
      adapterId: "fake-managed",
      label: "Managed login",
      fields: {},
    });
    await vi.waitFor(() => expect(attempt).toBe(1));

    await expect(service.cancelConnection("managed-login-cancel")).resolves.toBe(true);
    loginStarted.resolve({ verificationUri: "https://example.test/login" });

    await expect(connection).rejects.toThrow("Provider connection was cancelled");
    expect(close).toHaveBeenCalledTimes(1);
    await expect(service.connect({
      connectionId: "managed-login-cancel",
      adapterId: "fake-managed",
      label: "Managed login",
      fields: {},
    })).resolves.toMatchObject({ status: "pending" });
    await expect(service.cancelConnection("managed-login-cancel")).resolves.toBe(true);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("does not commit a secret provider when onboarding is cancelled during discovery", async () => {
    const discovery = deferred();
    const subject = fixture({ discover: () => discovery.promise });
    const connection = subject.service.connect({
      connectionId: "connect-discovery-cancel",
      harnessId: "codex-basic",
      adapterId: "fake-api",
      label: "Cancelled during discovery",
      fields: { "api-key": "secret" },
    });
    await vi.waitFor(() => expect(subject.order).toContain("discover-models"));

    await expect(subject.service.cancelConnection("connect-discovery-cancel")).resolves.toBe(true);
    discovery.resolve({ models: [{ visible: true }] });

    await expect(connection).rejects.toThrow("Provider connection was cancelled");
    expect(subject.order).not.toContain("commit-credential");
    expect(subject.order).not.toContain("commit-provider");
    expect(subject.definitions).toEqual([]);
  });

  it("does not report cancellation once the atomic provider commit has started", async () => {
    const credentialCommit = deferred();
    const subject = fixture({ credentialSet: () => credentialCommit.promise });
    const connection = subject.service.connect({
      connectionId: "connect-commit-race",
      harnessId: "codex-basic",
      adapterId: "fake-api",
      label: "Commit race",
      fields: { "api-key": "secret" },
    });
    await vi.waitFor(() => expect(subject.order).toContain("commit-credential"));

    await expect(subject.service.cancelConnection("connect-commit-race")).resolves.toBe(false);
    credentialCommit.resolve();

    await expect(connection).resolves.toMatchObject({ status: "connected" });
    expect(subject.order).toContain("commit-provider");
  });

  it("does not hold the provider queue while a runtime download is in progress", async () => {
    const installation = deferred();
    const subject = fixture({ prepareRuntime: ({ providerDefinition }) => (
      providerDefinition.id === "slow-connect" ? installation.promise : Promise.resolve()
    ) });
    await subject.service.connect({
      connectionId: "existing", adapterId: "fake-api", label: "Existing", fields: { "api-key": "secret" },
    });
    const connecting = subject.service.connect({
      connectionId: "slow-connect", adapterId: "fake-api", label: "Slow", fields: { "api-key": "secret" },
    });
    await vi.waitFor(() => expect(subject.order.filter((item) => item === "ensure-runtime")).toHaveLength(2));

    const lease = await subject.service.acquireExecution("existing");
    await lease.release();
    installation.resolve();
    await expect(connecting).resolves.toMatchObject({ status: "connected" });
  });
});
