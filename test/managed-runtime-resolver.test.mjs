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
    const installed = vi.fn(async () => ({ runtimeId: "codex", recipeId: "codex@0.147.0", version: "0.147.0" }));
    const prepare = vi.fn(async () => ({ runtimeId: "codex", recipeId: "codex@0.147.0", version: "0.147.0" }));
    const resolver = createManagedRuntimeResolver({ installed, prepare });

    const [first, second] = await Promise.all([
      resolver.get("codex@0.147.0"),
      resolver.get("codex@0.147.0"),
    ]);
    expect(first).toBe(second);
    expect(installed).toHaveBeenCalledOnce();

    await expect(resolver.prepare("codex@0.147.0")).resolves.toMatchObject({ recipeId: "codex@0.147.0" });
    await expect(resolver.get("codex@0.147.0")).resolves.toMatchObject({ recipeId: "codex@0.147.0" });
    expect(prepare).toHaveBeenCalledOnce();
    expect(installed).toHaveBeenCalledOnce();
  });

  it("routes startup receipt validation without invoking preparation or probe lookup", async () => {
    const descriptor = { runtimeId: "prime", recipeId: "prime@0.8.1", version: "0.8.1" };
    const validate = vi.fn(async () => descriptor);
    const installed = vi.fn();
    const prepare = vi.fn();
    const resolver = createManagedRuntimeResolver({ validate, installed, prepare });

    await expect(resolver.validate("prime@0.8.1")).resolves.toBe(descriptor);
    expect(validate).toHaveBeenCalledWith("prime@0.8.1");
    expect(installed).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("evicts a rejected active-generation probe", async () => {
    const installed = vi.fn()
      .mockRejectedValueOnce(new Error("missing"))
      .mockResolvedValueOnce({ runtimeId: "claude", recipeId: "claude@0.3.250", version: "0.3.250" });
    const resolver = createManagedRuntimeResolver({ installed, prepare: vi.fn() });

    await expect(resolver.get("claude@0.3.250")).rejects.toThrow("missing");
    await expect(resolver.get("claude@0.3.250")).resolves.toMatchObject({ recipeId: "claude@0.3.250" });
    expect(installed).toHaveBeenCalledTimes(2);
  });
});
