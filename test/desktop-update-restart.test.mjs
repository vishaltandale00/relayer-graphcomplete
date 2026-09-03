import { describe, expect, it, vi } from "vitest";

import { settleShutdownWithin } from "../desktop/main/services/update-restart.mjs";

describe("update restart shutdown budget", () => {
  it("waits for a shutdown that settles inside the budget", async () => {
    const shutdown = vi.fn(async () => {});
    const onTimeout = vi.fn();

    const result = await settleShutdownWithin({ shutdown, budgetMs: 1_000, onTimeout });

    expect(result).toEqual({ timedOut: false });
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  // Preview canary runs 33679270867, 33685634720 and 33703554650 each hung here:
  // the install only runs once this resolves, so an unbounded shutdown left the
  // app sitting on a verified update with no feedback and no restart.
  it("continues the restart when a service never closes", async () => {
    const onTimeout = vi.fn();
    let released;
    const shutdown = vi.fn(() => new Promise((resolve) => { released = resolve; }));

    const result = await settleShutdownWithin({ shutdown, budgetMs: 20, onTimeout });

    expect(result).toEqual({ timedOut: true });
    expect(onTimeout).toHaveBeenCalledWith(20);
    released();
  });

  it("continues the restart when shutdown rejects, and reports it", async () => {
    const failure = new Error("account service refused to close");
    const onError = vi.fn();

    const result = await settleShutdownWithin({
      shutdown: async () => { throw failure; },
      budgetMs: 1_000,
      onError,
    });

    expect(result).toEqual({ timedOut: false });
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("clears its timer so a settled shutdown leaves nothing pending", async () => {
    const clearTimeoutImpl = vi.fn(clearTimeout);

    await settleShutdownWithin({ shutdown: async () => {}, budgetMs: 1_000, clearTimeoutImpl });

    expect(clearTimeoutImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses a missing shutdown or a nonsense budget", async () => {
    await expect(settleShutdownWithin({ budgetMs: 10 })).rejects.toThrow("shutdown function is required");
    await expect(settleShutdownWithin({ shutdown: async () => {}, budgetMs: 0 })).rejects.toThrow("positive shutdown budget");
  });
});
