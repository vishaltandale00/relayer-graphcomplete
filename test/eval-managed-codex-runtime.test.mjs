import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { taskSystemFixtureFactory } from "@relayer/eval-runner";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createEvalCodexCatalogProvisioner,
  createEvalCodexExecutionLease,
  createEvalManagedCodexRuntime,
} from "../desktop/eval-main/managed-codex-runtime.mjs";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import {
  managedCodexHelperDirectory,
  withManagedCodexPath,
} from "../desktop/shared/codex-runtime-environment.mjs";

async function rejectionOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const services = [];
const directories = [];

afterEach(async () => {
  for (const service of services.splice(0).reverse()) await service.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("Eval managed Codex runtime", () => {
  it("defers platform validation, honors development executables, caches one install, and leases exact access", async () => {
    const unsupported = vi.fn(() => { throw new Error("unsupported linux target"); });
    const deferredRuntime = createEvalManagedCodexRuntime({
      root: "/eval/managed-runtimes",
      enableMaintenance: false,
      environment: { PATH: "/usr/bin" },
      createInstaller: unsupported,
    });

    expect(deferredRuntime.activeOperations(), "operations are empty before any installer exists").toEqual([]);
    await expect(deferredRuntime.pruneInactiveInstallations(), "maintenance is a no-op without an installer")
      .resolves.toEqual({ removed: [], failures: [] });
    expect(unsupported, "nothing constructs an installer until a runtime is requested").not.toHaveBeenCalled();
    expect((await rejectionOf(deferredRuntime.resolve()))?.message ?? "promise resolved instead of rejecting", "platform validation surfaces at resolve time").toMatch("unsupported linux target");
    expect(unsupported, "resolve constructed the installer exactly once").toHaveBeenCalledOnce();

    const developmentInstaller = vi.fn(() => { throw new Error("unsupported linux target"); });
    const developmentRuntime = createEvalManagedCodexRuntime({
      root: "/eval/managed-runtimes",
      developmentExecutable: "/usr/local/bin/codex",
      environment: { PATH: "/usr/bin" },
      createInstaller: developmentInstaller,
    });
    await expect(developmentRuntime.resolve(), "a development executable bypasses managed resolution")
      .resolves.toMatchObject({
        executable: "/usr/local/bin/codex",
        environment: { PATH: "/usr/local/codex-path:/usr/bin" },
      });
    expect(developmentInstaller, "development executables never validate platform support").not.toHaveBeenCalled();

    const pruneInactiveInstallations = vi.fn(async () => ({ removed: ["old"], failures: [] }));
    const maintenanceRuntime = createEvalManagedCodexRuntime({
      root: "/eval/managed-runtimes",
      createInstaller: vi.fn(() => ({ pruneInactiveInstallations })),
    });
    await expect(maintenanceRuntime.pruneInactiveInstallations(), "packaged maintenance routes through the installer")
      .resolves.toEqual({ removed: ["old"], failures: [] });
    expect(pruneInactiveInstallations, "maintenance invoked the installer once").toHaveBeenCalledOnce();

    const prepare = vi.fn(async () => ({
      runtimeId: "codex",
      recipeId: "codex@0.147.0",
      version: "0.147.0",
      executable: "/managed/installations/current/vendor/target/bin/codex",
    }));
    const cachedRuntime = createEvalManagedCodexRuntime({
      root: "/eval/managed-runtimes",
      environment: { PATH: "/usr/bin" },
      createInstaller: () => ({ prepare, activeOperations: () => [], cancelAll: async () => {} }),
    });
    const [first, second] = await Promise.all([cachedRuntime.resolve(), cachedRuntime.resolve()]);
    expect(first, "concurrent consumers share one resolution").toBe(second);
    expect(await cachedRuntime.resolve(), "later consumers reuse the cached result").toBe(first);
    expect(prepare, "the exact recipe prepared once").toHaveBeenCalledOnce();
    expect(prepare, "preparation requested the pinned recipe").toHaveBeenCalledWith("codex@0.147.0");
    expect(first.environment.PATH, "the resolved PATH carries the helper directory")
      .toBe("/managed/installations/current/vendor/target/codex-path:/usr/bin");

    const resolveRuntime = vi.fn(async () => ({
      executable: "/managed/codex",
      environment: Object.freeze({ PATH: "/managed/codex-path:/usr/bin" }),
    }));
    const acquire = createEvalCodexExecutionLease(resolveRuntime);
    const lease = await acquire("codex");
    expect(lease, "the lease exposes the managed Codex provider identity").toMatchObject({
      definition: { id: "codex", adapterId: "codex-subscription", accessContract: "managed-runtime@1" },
      descriptor: { adapterId: "codex-subscription", accessContract: "managed-runtime@1", implementationVersion: "1" },
    });
    await expect(lease.runtime.executionAccess(), "execution access is a managed-runtime environment grant")
      .resolves.toEqual({
        kind: "managed-runtime",
        environment: { PATH: "/managed/codex-path:/usr/bin" },
      });
    expect((await rejectionOf(acquire("other")))?.message ?? "promise resolved instead of rejecting", "unknown providers get no execution adapter").toMatch("no execution adapter");
    await expect(lease.release(), "the lease releases cleanly").resolves.toBeUndefined();

    const executable = "/runtime/vendor/target/bin/codex";
    expect(managedCodexHelperDirectory(executable), "helper directory sits beside the vendor bin dir")
      .toBe("/runtime/vendor/target/codex-path");
    expect(withManagedCodexPath({
      Path: "/runtime/vendor/target/codex-path:/usr/bin",
    }, executable, { platform: "linux" }), "an already-present helper PATH deduplicates and normalizes the key").toEqual({
      PATH: "/runtime/vendor/target/codex-path:/usr/bin",
    });
    expect(withManagedCodexPath({
      PATH: "C:\\ambiguous\\bin",
      Path: "C:\\Windows\\System32",
    }, "C:\\runtime\\vendor\\target\\bin\\codex.exe", { platform: "win32" }), "win32 keeps the case-variant Path key").toEqual({
      Path: expect.stringMatching(/^.*codex-path;C:\\Windows\\System32$/),
    });
  });

  it("publishes the managed Codex catalog once and materializes a selectable family on a live product server", { timeout: 60_000 }, async () => {
    const close = vi.fn(async () => undefined);
    const credentialEnvironments = [];
    const requests = [];
    const fetchImpl = vi.fn(async (url, options = {}) => {
      const request = {
        url: String(url),
        ...options,
        ...(options.body === undefined ? {} : { body: JSON.parse(options.body) }),
      };
      requests.push(request);
      return {
        ok: true,
        json: async () => request.url.endsWith("/api/model-settings")
          ? { defaults: { harnessId: "fixture-task-system" }, families: [] }
          : {},
      };
    });
    const provision = createEvalCodexCatalogProvisioner({
      productSession: {
        origin: "http://127.0.0.1:43123",
        cookie: { name: "relayer_session", value: "write-token" },
      },
      resolveRuntime: async () => ({
        executable: "/managed/codex",
        environment: { PATH: "/managed/codex-path:/usr/bin" },
      }),
      fetchImpl,
      createCredentials: (environment) => {
        credentialEnvironments.push(environment);
        return {
          account: async () => ({ status: "connected", account: { id: "account" } }),
          request: async (method) => {
            expect(method, "catalog listing uses model/list").toBe("model/list");
            return { data: [{ id: "catalog-sol", model: "gpt-5.6-sol", displayName: "Sol", isDefault: true, supportedReasoningEfforts: [] }], nextCursor: null };
          },
          close,
        };
      },
    });

    await Promise.all([
      provision("codex-layered-personal-presentation-v0"),
      provision("codex-layered-personal-presentation-v1"),
    ]);

    expect(fetchImpl, "concurrent provisions collapse into one publish sequence").toHaveBeenCalledTimes(5);
    expect(requests[0], "settings are read with the session cookie").toMatchObject({
      url: "http://127.0.0.1:43123/api/model-settings", method: "GET",
      headers: { Cookie: "relayer_session=write-token" },
    });
    expect(requests[1], "the requested harness becomes the provisional default").toMatchObject({
      url: "http://127.0.0.1:43123/api/model-settings/defaults", method: "PUT",
      body: { harnessId: "codex-layered-personal-presentation-v0" },
    });
    expect(requests[2], "the managed Codex provider definition is published").toMatchObject({
      url: "http://127.0.0.1:43123/api/internal/provider-definitions", method: "PUT",
      headers: { Authorization: "Bearer write-token" },
      body: [{ id: "codex", adapterId: "codex-subscription", accessContract: "managed-runtime@1" }],
    });
    expect(requests[3], "the connected catalog is published with the default model").toMatchObject({
      url: "http://127.0.0.1:43123/api/internal/provider-catalog", method: "PUT",
      body: { providerId: "codex", connected: true, models: [{ id: "gpt-5.6-sol", providerDefault: true }] },
    });
    expect(requests[4], "the prior fixture default is restored afterwards").toMatchObject({
      url: "http://127.0.0.1:43123/api/model-settings/defaults", method: "PUT",
      body: { harnessId: "fixture-task-system" },
    });
    expect(close, "credentials close exactly once").toHaveBeenCalledOnce();
    expect(credentialEnvironments, "credentials receive the managed runtime environment").toEqual([{
      PATH: "/managed/codex-path:/usr/bin",
      RELAYER_CODEX_BINARY: "/managed/codex",
    }]);

    const dataDirectory = await mkdtemp(join(tmpdir(), "relayer-eval-codex-catalog-"));
    directories.push(dataDirectory);
    const runtime = new GraphCompleteRuntimeService({
      userDataDirectory: dataDirectory,
      graphServerBinary: join(repositoryRoot, "target", "debug", "relayer-graph-server"),
      configurationPaths: [
        join(repositoryRoot, "harnesses", "fixture-task-system.yaml"),
        join(repositoryRoot, "harnesses", "codex-layered-personal-presentation-v0.yaml"),
      ],
      additionalImplementations: { "fixture.task-system": taskSystemFixtureFactory },
    });
    services.push(runtime);
    const runtimeSession = await runtime.start();
    const product = new RelayerAppServerService({
      userDataDirectory: dataDirectory,
      binaryPath: join(repositoryRoot, "target", "debug", "relayer-app-server"),
      webDirectory: join(repositoryRoot, "desktop", "renderer"),
      permissionCatalogPath: join(repositoryRoot, "permissions", "desktop.json"),
      runtimeSession,
      defaultHarnessConfiguration: "fixture-task-system",
      allowHarnessOverride: true,
    });
    services.push(product);
    const productSession = await product.start();
    const liveProvision = createEvalCodexCatalogProvisioner({
      productSession,
      resolveRuntime: async () => ({ executable: "/managed/codex", environment: {} }),
      createCredentials: () => ({
        account: async () => ({ status: "connected", account: { id: "account" } }),
        request: async () => ({
          data: [{
            id: "catalog-sol",
            model: "gpt-5.6-sol",
            displayName: "Sol",
            isDefault: true,
            supportedReasoningEfforts: [],
          }],
          nextCursor: null,
        }),
        close: async () => {},
      }),
    });

    await liveProvision("codex-layered-personal-presentation-v0");

    const response = await fetch(new URL("/api/model-settings", productSession.origin), {
      headers: { Cookie: `${productSession.cookie.name}=${productSession.cookie.value}` },
    });
    expect(response.ok, "the live product server answers model-settings").toBe(true);
    const settings = await response.json();
    expect(settings.defaults.harnessId, "the Eval fixture default stays the default").toBe("fixture-task-system");
    expect(settings.families, "the managed family is materialized and selectable").toEqual([
      expect.objectContaining({
        kind: "system",
        enabled: true,
        managedPolicy: {
          providerId: "codex",
          policyId: "codex-default-family",
          policyVersion: 2,
        },
        members: [{ position: 0, providerId: "codex", modelId: "gpt-5.6-sol" }],
      }),
    ]);
  });
});
