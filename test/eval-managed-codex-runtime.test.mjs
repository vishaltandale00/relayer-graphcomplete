import { describe, expect, it, vi } from "vitest";

import {
  createEvalCodexExecutionLease,
  createEvalManagedCodexRuntime,
} from "../desktop/eval-main/managed-codex-runtime.mjs";
import {
  managedCodexHelperDirectory,
  withManagedCodexPath,
} from "../desktop/shared/codex-runtime-environment.mjs";

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
