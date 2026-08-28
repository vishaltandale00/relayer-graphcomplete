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

const repositoryRoot = resolve(import.meta.dirname, "..");
const services = [];
const directories = [];

afterEach(async () => {
  for (const service of services.splice(0).reverse()) await service.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("Eval managed Codex runtime", () => {
  it("defers platform validation until a runtime is requested", async () => {
    const createInstaller = vi.fn(() => { throw new Error("unsupported linux target"); });
    const runtime = createEvalManagedCodexRuntime({
      root: "/eval/managed-runtimes",
      enableMaintenance: false,
      environment: { PATH: "/usr/bin" },
      createInstaller,
    });

    expect(runtime.activeOperations()).toEqual([]);
    await expect(runtime.pruneInactiveInstallations()).resolves.toEqual({ removed: [], failures: [] });
    expect(createInstaller).not.toHaveBeenCalled();
    await expect(runtime.resolve()).rejects.toThrow("unsupported linux target");
    expect(createInstaller).toHaveBeenCalledOnce();
  });

  it("uses an explicit development executable without validating managed-runtime platform support", async () => {
    const createInstaller = vi.fn(() => { throw new Error("unsupported linux target"); });
    const runtime = createEvalManagedCodexRuntime({
      root: "/eval/managed-runtimes",
      developmentExecutable: "/usr/local/bin/codex",
      environment: { PATH: "/usr/bin" },
      createInstaller,
    });

    await expect(runtime.resolve()).resolves.toMatchObject({
      executable: "/usr/local/bin/codex",
      environment: { PATH: "/usr/local/codex-path:/usr/bin" },
    });
    expect(createInstaller).not.toHaveBeenCalled();
  });

  it("runs packaged maintenance through the managed installer before a runtime is requested", async () => {
    const pruneInactiveInstallations = vi.fn(async () => ({ removed: ["old"], failures: [] }));
    const createInstaller = vi.fn(() => ({ pruneInactiveInstallations }));
    const runtime = createEvalManagedCodexRuntime({ root: "/eval/managed-runtimes", createInstaller });

    await expect(runtime.pruneInactiveInstallations()).resolves.toEqual({ removed: ["old"], failures: [] });
    expect(createInstaller).toHaveBeenCalledOnce();
    expect(pruneInactiveInstallations).toHaveBeenCalledOnce();
  });

  it("caches one successful installation result for all Eval consumers", async () => {
    const ensure = vi.fn(async () => ({
      runtimeId: "codex",
      version: "0.150.1",
      executable: "/managed/installations/current/vendor/target/bin/codex",
    }));
    const runtime = createEvalManagedCodexRuntime({
      root: "/eval/managed-runtimes",
      environment: { PATH: "/usr/bin" },
      createInstaller: () => ({ ensure, activeOperations: () => [], cancelAll: async () => {} }),
    });

    const [first, second] = await Promise.all([runtime.resolve(), runtime.resolve()]);
    expect(first).toBe(second);
    expect(await runtime.resolve()).toBe(first);
    expect(ensure).toHaveBeenCalledOnce();
    expect(first.environment.PATH).toBe("/managed/installations/current/vendor/target/codex-path:/usr/bin");
  });

  it("leases exact Codex managed-runtime access to the Eval harness broker", async () => {
    const resolveRuntime = vi.fn(async () => ({
      executable: "/managed/codex",
      environment: Object.freeze({ PATH: "/managed/codex-path:/usr/bin" }),
    }));
    const acquire = createEvalCodexExecutionLease(resolveRuntime);
    const lease = await acquire("codex");
    expect(lease).toMatchObject({
      definition: { id: "codex", adapterId: "codex-subscription", accessContract: "managed-runtime@1" },
      descriptor: { adapterId: "codex-subscription", accessContract: "managed-runtime@1", implementationVersion: "1" },
    });
    await expect(lease.runtime.executionAccess()).resolves.toEqual({
      kind: "managed-runtime",
      environment: { PATH: "/managed/codex-path:/usr/bin" },
    });
    await expect(acquire("other")).rejects.toThrow("no execution adapter");
    await expect(lease.release()).resolves.toBeUndefined();
  });

  it("publishes the connected managed Codex catalog once for fresh Eval profiles", async () => {
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
            expect(method).toBe("model/list");
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

    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(requests[0]).toMatchObject({
      url: "http://127.0.0.1:43123/api/model-settings", method: "GET",
      headers: { Cookie: "relayer_session=write-token" },
    });
    expect(requests[1]).toMatchObject({
      url: "http://127.0.0.1:43123/api/model-settings/defaults", method: "PUT",
      body: { harnessId: "codex-layered-personal-presentation-v0" },
    });
    expect(requests[2]).toMatchObject({
      url: "http://127.0.0.1:43123/api/internal/provider-definitions", method: "PUT",
      headers: { Authorization: "Bearer write-token" },
      body: [{ id: "codex", adapterId: "codex-subscription", accessContract: "managed-runtime@1" }],
    });
    expect(requests[3]).toMatchObject({
      url: "http://127.0.0.1:43123/api/internal/provider-catalog", method: "PUT",
      body: { providerId: "codex", connected: true, models: [{ id: "gpt-5.6-sol", providerDefault: true }] },
    });
    expect(requests[4]).toMatchObject({
      url: "http://127.0.0.1:43123/api/model-settings/defaults", method: "PUT",
      body: { harnessId: "fixture-task-system" },
    });
    expect(close).toHaveBeenCalledOnce();
    expect(credentialEnvironments).toEqual([{
      PATH: "/managed/codex-path:/usr/bin",
      RELAYER_CODEX_BINARY: "/managed/codex",
    }]);
  });

  it("materializes a selectable managed family without changing Eval's fixture default", async () => {
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
    const provision = createEvalCodexCatalogProvisioner({
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

    await provision("codex-layered-personal-presentation-v0");

    const response = await fetch(new URL("/api/model-settings", productSession.origin), {
      headers: { Cookie: `${productSession.cookie.name}=${productSession.cookie.value}` },
    });
    expect(response.ok).toBe(true);
    const settings = await response.json();
    expect(settings.defaults.harnessId).toBe("fixture-task-system");
    expect(settings.families).toEqual([
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

  it("normalizes and deduplicates the helper PATH", () => {
    const executable = "/runtime/vendor/target/bin/codex";
    expect(managedCodexHelperDirectory(executable)).toBe("/runtime/vendor/target/codex-path");
    expect(withManagedCodexPath({
      Path: "/runtime/vendor/target/codex-path:/usr/bin",
    }, executable, { platform: "linux" })).toEqual({
      PATH: "/runtime/vendor/target/codex-path:/usr/bin",
    });
    expect(withManagedCodexPath({
      PATH: "C:\\ambiguous\\bin",
      Path: "C:\\Windows\\System32",
    }, "C:\\runtime\\vendor\\target\\bin\\codex.exe", { platform: "win32" })).toEqual({
      Path: expect.stringMatching(/^.*codex-path;C:\\Windows\\System32$/),
    });
  });
});
