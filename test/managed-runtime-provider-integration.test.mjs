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

async function rejectionOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

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
  it("carries every Codex-shaped adapter through the broker with ephemeral auth.json", { timeout: 30_000 }, async () => {
    for (const adapterId of ["openai-api", "openrouter", "vercel-ai-router"]) {
      let submitted;
      const codexHome = await mkdtemp(join(tmpdir(), "relayer-codex-int-"));
      try {
        const providerId = `${adapterId}-work`;
        const definition = {
          id: providerId, adapterId, label: `${adapterId} Work`,
          endpoint: "https://api.provider.test/v1", accessContract: "secret@1", credentialReference: `provider:${providerId}`,
          lifecycleState: "active", removedAt: null,
        };
        const adapter = productionProviderAdapterRegistry.create(definition, {
          fetch: vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
              data: [{
                id: "gpt-test",
                type: "language",
                architecture: { output_modalities: ["text"] },
                top_provider: { context_length: 128_000, max_completion_tokens: 8_192 },
                context_window: 128_000,
                max_tokens: 8_192,
              }],
            }),
          })),
          secrets: { "api-key": "secret" },
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
            expect(authFile, `${adapterId} turn sees the ephemeral auth.json`).toEqual({ auth_mode: "apikey", OPENAI_API_KEY: "secret" });
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

        expect(acquired.access, `${adapterId} access never leaks the runtime object`).not.toHaveProperty("runtime");
        expect(submitted.codexPathOverride, `${adapterId} turn uses the managed executable`).toBe("/managed/codex");
        expect(submitted.environment.CODEX_HOME, `${adapterId} turn uses the ephemeral CODEX_HOME`).toBe(codexHome);
        expect(submitted.environment.OPENAI_API_KEY, `${adapterId} turn receives the secret`).toBe("secret");
        expect(await rejectionOf(readFile(join(codexHome, "auth.json"), "utf8")), `${adapterId} auth.json is removed after the turn`).toMatchObject({ code: "ENOENT" });
        await acquired.release();
      } finally {
        await rm(codexHome, { recursive: true, force: true });
      }
    }
  });

  it("walks the Connect lifecycle: ordering, cancellation, admission, close, and queue fairness", { timeout: 30_000 }, async () => {
    const ordered = fixture();
    await expect(ordered.service.connect({
      connectionId: "connect-1",
      harnessId: "codex-basic",
      adapterId: "fake-api",
      label: "Work",
      fields: { "api-key": "secret" },
    }), "Connect succeeds").resolves.toMatchObject({ status: "connected" });
    expect(ordered.order, "runtime preparation precedes provider creation, discovery, and commits").toEqual([
      "ensure-runtime",
      "create-provider",
      "discover-models",
      "commit-credential",
      "commit-provider",
    ]);

    const prepareInstallation = deferred();
    const duringPrepare = fixture({ prepareRuntime: () => prepareInstallation.promise });
    const cancelledDuringPrepare = duringPrepare.service.connect({
      connectionId: "connect-cancelled",
      harnessId: "claude-basic",
      adapterId: "fake-api",
      label: "Cancelled",
      fields: { "api-key": "secret" },
    });
    await vi.waitFor(() => expect(duringPrepare.order, "cancellation starts once runtime preparation runs").toEqual(["ensure-runtime"]));
    await expect(duringPrepare.service.cancelConnection("connect-cancelled"),
      "cancelling does not cancel the installer-owned operation").resolves.toBe(true);
    prepareInstallation.resolve({ runtimeId: "claude" });
    expect((await rejectionOf(cancelledDuringPrepare))?.message ?? "promise resolved instead of rejecting", "the cancelled connection rejects").toMatch("Provider connection was cancelled");
    expect(duringPrepare.create, "cancellation during prepare never creates the provider").not.toHaveBeenCalled();
    expect(duringPrepare.definitions, "cancellation during prepare never commits a provider").toEqual([]);

    const immediateInstallation = deferred();
    const immediate = fixture({ prepareRuntime: () => immediateInstallation.promise });
    const cancelledImmediately = immediate.service.connect({
      connectionId: "connect-immediate-cancel",
      harnessId: "codex-basic",
      adapterId: "fake-api",
      label: "Cancelled immediately",
      fields: { "api-key": "secret" },
    });
    await expect(immediate.service.cancelConnection("connect-immediate-cancel"),
      "an immediate cancellation is admitted").resolves.toBe(true);
    immediateInstallation.resolve({ runtimeId: "codex" });
    expect((await rejectionOf(cancelledImmediately))?.message ?? "promise resolved instead of rejecting", "a cancellation before queued work starts still rejects").toMatch("Provider connection was cancelled");
    expect(immediate.create, "immediate cancellation never creates the provider").not.toHaveBeenCalled();

    const racingInstallation = deferred();
    const racing = fixture({ prepareRuntime: () => racingInstallation.promise });
    const first = racing.service.connect({
      connectionId: "same-label-first",
      adapterId: "fake-api",
      label: "Shared name",
      fields: { "api-key": "first" },
    });
    const second = racing.service.connect({
      connectionId: "same-label-second",
      adapterId: "fake-api",
      label: "Shared name",
      fields: { "api-key": "second" },
    });
    await vi.waitFor(() => expect(racing.order, "same-label connections share one runtime wait").toEqual(["ensure-runtime"]));
    racingInstallation.resolve({ runtimeId: "codex" });
    await expect(first, "exactly one same-label connection wins").resolves.toMatchObject({
      status: "connected",
      providerDefinition: { id: "same-label-first" },
    });
    expect((await rejectionOf(second))?.message ?? "promise resolved instead of rejecting", "the same-label loser is rejected").toMatch(/preparing provider connection|already uses that name/);
    expect(new Set(racing.definitions.map(({ id }) => id)), "only the winner is committed")
      .toEqual(new Set(["same-label-first"]));

    const closingInstallation = deferred();
    const closing = fixture({ prepareRuntime: () => closingInstallation.promise });
    const closedDuringPrepare = closing.service.connect({
      connectionId: "close-during-prepare",
      adapterId: "fake-api",
      label: "Closing",
      fields: { "api-key": "secret" },
    });
    await vi.waitFor(() => expect(closing.order, "close starts once runtime preparation runs").toEqual(["ensure-runtime"]));
    let serviceClosed = false;
    const closingPromise = closing.service.close().then(() => { serviceClosed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(serviceClosed, "close waits for the in-flight preparation to drain").toBe(false);
    closingInstallation.resolve({ runtimeId: "codex" });
    expect((await rejectionOf(closedDuringPrepare))?.message ?? "promise resolved instead of rejecting", "closing cancels the in-flight connection").toMatch("Provider connection was cancelled");
    await closingPromise;
    expect(closing.create, "close never creates the provider").not.toHaveBeenCalled();
    expect((await rejectionOf(closing.service.connect({
      connectionId: "after-close",
      adapterId: "fake-api",
      label: "After close",
    })))?.message ?? "promise resolved instead of rejecting", "Connect after close is rejected").toMatch("shutting down");

    const loginStarted = deferred();
    const managedLoginClose = vi.fn(async () => {});
    let loginAttempt = 0;
    const managedLoginService = new ProviderDefinitionService({
      registry: createProviderAdapterRegistry([{
        adapterId: "fake-managed",
        implementationVersion: "1",
        label: "Fake managed",
        accessContract: "managed-runtime@1",
        defaultEndpoint: null,
        connection: { mode: "managed-login", fields: [] },
        create: vi.fn(() => ({
          credentials: {
            login: vi.fn(() => (loginAttempt++ === 0
              ? loginStarted.promise
              : Promise.resolve({ verificationUri: "https://example.test/login" }))),
          },
          close: managedLoginClose,
        })),
      }]),
      definitionStore: { async load() { return []; } },
      credentialStore: {},
    });
    const managedLoginConnection = managedLoginService.connect({
      connectionId: "managed-login-cancel",
      adapterId: "fake-managed",
      label: "Managed login",
      fields: {},
    });
    await vi.waitFor(() => expect(loginAttempt, "managed login starts before cancellation").toBe(1));
    await expect(managedLoginService.cancelConnection("managed-login-cancel"),
      "a managed-login onboarding can be cancelled while login starts").resolves.toBe(true);
    loginStarted.resolve({ verificationUri: "https://example.test/login" });
    expect((await rejectionOf(managedLoginConnection))?.message ?? "promise resolved instead of rejecting", "the cancelled managed login rejects").toMatch("Provider connection was cancelled");
    expect(managedLoginClose, "cancelling closes the managed login").toHaveBeenCalledTimes(1);
    await expect(managedLoginService.connect({
      connectionId: "managed-login-cancel",
      adapterId: "fake-managed",
      label: "Managed login",
      fields: {},
    }), "a retry after cancelled login is admitted and unpublished").resolves.toMatchObject({ status: "pending" });
    await expect(managedLoginService.cancelConnection("managed-login-cancel"),
      "the retried login can be cancelled again").resolves.toBe(true);
    expect(managedLoginClose, "every login attempt is closed on cancellation").toHaveBeenCalledTimes(2);

    const discovery = deferred();
    const duringDiscovery = fixture({ discover: () => discovery.promise });
    const cancelledDuringDiscovery = duringDiscovery.service.connect({
      connectionId: "connect-discovery-cancel",
      harnessId: "codex-basic",
      adapterId: "fake-api",
      label: "Cancelled during discovery",
      fields: { "api-key": "secret" },
    });
    await vi.waitFor(() => expect(duringDiscovery.order, "discovery is running when cancellation arrives").toContain("discover-models"));
    await expect(duringDiscovery.service.cancelConnection("connect-discovery-cancel"),
      "cancellation during discovery is admitted").resolves.toBe(true);
    discovery.resolve({ models: [{ visible: true }] });
    expect((await rejectionOf(cancelledDuringDiscovery))?.message ?? "promise resolved instead of rejecting", "the discovery-cancelled connection rejects").toMatch("Provider connection was cancelled");
    expect(duringDiscovery.order, "discovery cancellation never commits credentials").not.toContain("commit-credential");
    expect(duringDiscovery.order, "discovery cancellation never commits the provider").not.toContain("commit-provider");
    expect(duringDiscovery.definitions, "discovery cancellation leaves no definition").toEqual([]);

    const credentialCommit = deferred();
    const commitRace = fixture({ credentialSet: () => credentialCommit.promise });
    const racingCommit = commitRace.service.connect({
      connectionId: "connect-commit-race",
      harnessId: "codex-basic",
      adapterId: "fake-api",
      label: "Commit race",
      fields: { "api-key": "secret" },
    });
    await vi.waitFor(() => expect(commitRace.order, "the credential commit has started").toContain("commit-credential"));
    await expect(commitRace.service.cancelConnection("connect-commit-race"),
      "cancellation after the atomic commit started reports false").resolves.toBe(false);
    credentialCommit.resolve();
    await expect(racingCommit, "the commit race finishes connected").resolves.toMatchObject({ status: "connected" });
    expect(commitRace.order, "the provider commit completes despite the late cancellation").toContain("commit-provider");

    const slowInstallation = deferred();
    const queueFairness = fixture({ prepareRuntime: ({ providerDefinition }) => (
      providerDefinition.id === "slow-connect" ? slowInstallation.promise : Promise.resolve()
    ) });
    await queueFairness.service.connect({
      connectionId: "existing", adapterId: "fake-api", label: "Existing", fields: { "api-key": "secret" },
    });
    const slowConnect = queueFairness.service.connect({
      connectionId: "slow-connect", adapterId: "fake-api", label: "Slow", fields: { "api-key": "secret" },
    });
    await vi.waitFor(() => expect(queueFairness.order.filter((item) => item === "ensure-runtime"),
      "both connections reach runtime preparation").toHaveLength(2));
    const lease = await queueFairness.service.acquireExecution("existing");
    await lease.release();
    expect(lease, "the provider queue stays usable while a runtime download is in flight").toBeDefined();
    slowInstallation.resolve();
    await expect(slowConnect, "the slow connection completes after its download").resolves.toMatchObject({ status: "connected" });
  });
});
