import { describe, expect, it, vi } from "vitest";

import { createEvalManagedCodexRuntime } from "../desktop/eval-main/managed-codex-runtime.mjs";
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

  it("normalizes and deduplicates the helper PATH", () => {
    const executable = "/runtime/vendor/target/bin/codex";
    expect(managedCodexHelperDirectory(executable)).toBe("/runtime/vendor/target/codex-path");
    expect(withManagedCodexPath({
      Path: "/runtime/vendor/target/codex-path:/usr/bin",
    }, executable, { platform: "linux" })).toEqual({
      PATH: "/runtime/vendor/target/codex-path:/usr/bin",
    });
  });
});
