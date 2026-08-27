import { describe, expect, it, vi } from "vitest";

import {
  bootstrapLegacyManagedRuntimes,
  createManagedRuntimeResolver,
} from "../desktop/main/managed-runtimes/resolver.mjs";

describe("managed runtime process resolver", () => {
  it("coalesces active-generation probes and replaces the cache after prepare", async () => {
    const installed = vi.fn(async () => ({ runtimeId: "codex", version: "0.150.0" }));
    const ensure = vi.fn(async () => ({ runtimeId: "codex", version: "0.151.0" }));
    const resolver = createManagedRuntimeResolver({ installed, ensure });

    const [first, second] = await Promise.all([
      resolver.get("codex", "0.147.0"),
      resolver.get("codex", "0.147.0"),
    ]);
    expect(first).toBe(second);
    expect(installed).toHaveBeenCalledOnce();

    await expect(resolver.prepare("codex", "0.147.0")).resolves.toMatchObject({ version: "0.151.0" });
    await expect(resolver.get("codex", "0.147.0")).resolves.toMatchObject({ version: "0.151.0" });
    expect(ensure).toHaveBeenCalledOnce();
    expect(installed).toHaveBeenCalledOnce();
  });

  it("evicts a rejected active-generation probe", async () => {
    const installed = vi.fn()
      .mockRejectedValueOnce(new Error("missing"))
      .mockResolvedValueOnce({ runtimeId: "claude", version: "0.3.247" });
    const resolver = createManagedRuntimeResolver({ installed, ensure: vi.fn() });

    await expect(resolver.get("claude", "0.3.200")).rejects.toThrow("missing");
    await expect(resolver.get("claude", "0.3.200")).resolves.toMatchObject({ version: "0.3.247" });
    expect(installed).toHaveBeenCalledTimes(2);
  });

  it("bootstraps only missing active-provider runtimes during the one-time legacy migration", async () => {
    const resolver = {
      get: vi.fn(async (runtimeId) => {
        if (runtimeId === "codex") throw new Error("not managed yet");
        return { runtimeId };
      }),
      prepare: vi.fn(async (runtimeId) => ({ runtimeId, version: "latest" })),
    };
    const definitions = [
      { adapterId: "openai-api", lifecycleState: "active" },
      { adapterId: "codex-subscription", lifecycleState: "active" },
      { adapterId: "claude-subscription", lifecycleState: "active" },
      { adapterId: "anthropic-api", lifecycleState: "tombstoned" },
    ];

    await expect(bootstrapLegacyManagedRuntimes({
      definitions,
      resolver,
      requirementForAdapter: (adapterId) => adapterId.includes("claude") || adapterId.includes("anthropic")
        ? { runtimeId: "claude", minimumVersion: "0.3.200" }
        : { runtimeId: "codex", minimumVersion: "0.147.0" },
    })).resolves.toEqual([{ runtimeId: "codex", version: "latest" }]);

    expect(resolver.get).toHaveBeenCalledTimes(2);
    expect(resolver.prepare).toHaveBeenCalledOnce();
  });
});
