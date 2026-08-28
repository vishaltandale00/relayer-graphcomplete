import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import {
  createManagedRuntimeResolver,
} from "../desktop/main/managed-runtimes/resolver.mjs";

describe("managed runtime process resolver", () => {
  it("keeps ordinary desktop startup free of vendor installation and latest checks", async () => {
    const source = await readFile(new URL("../desktop/main/index.mjs", import.meta.url), "utf8");

    expect(source).not.toContain("bootstrapLegacyManagedRuntimes");
    expect(source).not.toContain("managedRuntimeMigrationVersion");
  });

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
      .mockResolvedValueOnce({ runtimeId: "claude", version: "0.3.250" });
    const resolver = createManagedRuntimeResolver({ installed, ensure: vi.fn() });

    await expect(resolver.get("claude", "0.3.200")).rejects.toThrow("missing");
    await expect(resolver.get("claude", "0.3.250")).resolves.toMatchObject({ version: "0.3.250" });
    expect(installed).toHaveBeenCalledTimes(2);
  });
});
