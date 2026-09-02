import { describe, expect, it, vi } from "vitest";

import { confirmManagedRuntimeQuit } from "../desktop/main/managed-runtimes/quit-guard.mjs";

describe("managed runtime quit guard", () => {
  it("walks every quit scenario: prompt shape, confirmation cancellation, idle quit, and fatal bypass", async () => {
    const reason = new DOMException("Relayer quit during managed runtime installation.", "AbortError");

    const keepOpenDialog = vi.fn(async () => ({ response: 0 }));
    const keepOpenCancel = vi.fn();
    await expect(confirmManagedRuntimeQuit({
      installer: { activeOperations: () => ["claude"], cancelAll: keepOpenCancel },
      dialog: { showMessageBox: keepOpenDialog },
    }), "keeping Relayer open resolves false").resolves.toBe(false);
    expect(keepOpenCancel, "keeping Relayer open never cancels downloads").not.toHaveBeenCalled();
    expect(keepOpenDialog.mock.calls[0][0], "download-in-progress prompt shape").toMatchObject({
      buttons: ["Keep downloading", "Quit anyway"],
      defaultId: 0,
      cancelId: 0,
    });

    const confirmedCancel = vi.fn(async () => {});
    await expect(confirmManagedRuntimeQuit({
      installer: { activeOperations: () => ["codex"], cancelAll: confirmedCancel },
      dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) },
      reason,
    }), "explicit quit confirmation resolves true").resolves.toBe(true);
    expect(confirmedCancel, "confirmed quit cancels with the quit reason").toHaveBeenCalledWith(reason);

    const idleDialog = vi.fn();
    await expect(confirmManagedRuntimeQuit({
      installer: { activeOperations: () => [], cancelAll: vi.fn() },
      dialog: { showMessageBox: idleDialog },
    }), "idle quit resolves true").resolves.toBe(true);
    expect(idleDialog, "idle quit never prompts").not.toHaveBeenCalled();

    const fatalCancel = vi.fn(async () => {});
    const fatalDialog = vi.fn();
    const fatalReason = new Error("fatal service failure");
    await expect(confirmManagedRuntimeQuit({
      installer: { activeOperations: () => ["codex"], cancelAll: fatalCancel },
      dialog: { showMessageBox: fatalDialog },
      fatal: true,
      reason: fatalReason,
    }), "fatal shutdown resolves true").resolves.toBe(true);
    expect(fatalDialog, "fatal shutdown bypasses the prompt").not.toHaveBeenCalled();
    expect(fatalCancel, "fatal shutdown still cancels downloads").toHaveBeenCalledWith(fatalReason);
  });
});
