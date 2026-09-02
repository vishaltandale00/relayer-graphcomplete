import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import {
  createManagedRuntimeResolver,
} from "../desktop/main/managed-runtimes/resolver.mjs";

async function rejectionOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

describe("managed runtime process resolver", () => {
  it("keeps startup vendor-free, coalesces probes, routes validation, and evicts rejected probes", async () => {
    const source = await readFile(new URL("../desktop/main/index.mjs", import.meta.url), "utf8");
    expect(source, "desktop startup never bootstraps legacy managed runtimes").not.toContain("bootstrapLegacyManagedRuntimes");
    expect(source, "desktop startup never carries a managed runtime migration version").not.toContain("managedRuntimeMigrationVersion");

    const installed = vi.fn(async () => ({ runtimeId: "codex", recipeId: "codex@0.147.0", version: "0.147.0" }));
    const prepare = vi.fn(async () => ({ runtimeId: "codex", recipeId: "codex@0.147.0", version: "0.147.0" }));
    const resolver = createManagedRuntimeResolver({ installed, prepare });

    const [first, second] = await Promise.all([
      resolver.get("codex@0.147.0"),
      resolver.get("codex@0.147.0"),
    ]);
    expect(first, "concurrent gets share one coalesced probe").toBe(second);
    expect(installed, "coalesced gets probe only once").toHaveBeenCalledOnce();

    await expect(resolver.prepare("codex@0.147.0"), "prepare resolves the prepared descriptor")
      .resolves.toMatchObject({ recipeId: "codex@0.147.0" });
    await expect(resolver.get("codex@0.147.0"), "get after prepare uses the replaced cache")
      .resolves.toMatchObject({ recipeId: "codex@0.147.0" });
    expect(prepare, "prepare ran exactly once").toHaveBeenCalledOnce();
    expect(installed, "prepare never re-probes the installed generation").toHaveBeenCalledOnce();

    const descriptor = { runtimeId: "prime", recipeId: "prime@0.8.1", version: "0.8.1" };
    const validate = vi.fn(async () => descriptor);
    const validationInstalled = vi.fn();
    const validationPrepare = vi.fn();
    const validatingResolver = createManagedRuntimeResolver({
      validate, installed: validationInstalled, prepare: validationPrepare,
    });
    await expect(validatingResolver.validate("prime@0.8.1"), "startup receipt validation routes directly")
      .resolves.toBe(descriptor);
    expect(validate, "validation receives the requested recipe").toHaveBeenCalledWith("prime@0.8.1");
    expect(validationInstalled, "validation never probes the installed generation").not.toHaveBeenCalled();
    expect(validationPrepare, "validation never prepares a runtime").not.toHaveBeenCalled();

    const flakyInstalled = vi.fn()
      .mockRejectedValueOnce(new Error("missing"))
      .mockResolvedValueOnce({ runtimeId: "claude", recipeId: "claude@0.3.250", version: "0.3.250" });
    const flakyResolver = createManagedRuntimeResolver({ installed: flakyInstalled, prepare: vi.fn() });
    expect((await rejectionOf(flakyResolver.get("claude@0.3.250")))?.message ?? "promise resolved instead of rejecting", "a rejected probe surfaces to the caller").toMatch("missing");
    await expect(flakyResolver.get("claude@0.3.250"), "the rejected probe is evicted and retried")
      .resolves.toMatchObject({ recipeId: "claude@0.3.250" });
    expect(flakyInstalled, "eviction forces a fresh probe").toHaveBeenCalledTimes(2);
  });
});
