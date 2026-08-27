import { describe, expect, it, vi } from "vitest";

import { confirmManagedRuntimeQuit } from "../desktop/main/managed-runtimes/quit-guard.mjs";

describe("managed runtime quit guard", () => {
  it("does not interrupt a runtime download when the user keeps Relayer open", async () => {
    const cancelAll = vi.fn();
    const showMessageBox = vi.fn(async () => ({ response: 0 }));

    await expect(confirmManagedRuntimeQuit({
      installer: { activeOperations: () => ["claude"], cancelAll },
      dialog: { showMessageBox },
    })).resolves.toBe(false);

    expect(cancelAll).not.toHaveBeenCalled();
    expect(showMessageBox.mock.calls[0][0]).toMatchObject({
      buttons: ["Keep downloading", "Quit anyway"],
      defaultId: 0,
      cancelId: 0,
    });
  });

  it("cancels and cleans active downloads only after explicit quit confirmation", async () => {
    const cancelAll = vi.fn(async () => {});
    const showMessageBox = vi.fn(async () => ({ response: 1 }));
    const reason = new DOMException("Relayer quit during managed runtime installation.", "AbortError");

    await expect(confirmManagedRuntimeQuit({
      installer: { activeOperations: () => ["codex"], cancelAll },
      dialog: { showMessageBox },
      reason,
    })).resolves.toBe(true);

    expect(cancelAll).toHaveBeenCalledWith(reason);
  });

  it("allows quit without prompting when no runtime operation is active", async () => {
    const showMessageBox = vi.fn();
    await expect(confirmManagedRuntimeQuit({
      installer: { activeOperations: () => [], cancelAll: vi.fn() },
      dialog: { showMessageBox },
    })).resolves.toBe(true);
    expect(showMessageBox).not.toHaveBeenCalled();
  });

  it("bypasses the user prompt and cancels downloads for a fatal service shutdown", async () => {
    const cancelAll = vi.fn(async () => {});
    const showMessageBox = vi.fn();
    const reason = new Error("fatal service failure");

    await expect(confirmManagedRuntimeQuit({
      installer: { activeOperations: () => ["codex"], cancelAll },
      dialog: { showMessageBox },
      fatal: true,
      reason,
    })).resolves.toBe(true);

    expect(showMessageBox).not.toHaveBeenCalled();
    expect(cancelAll).toHaveBeenCalledWith(reason);
  });
});
