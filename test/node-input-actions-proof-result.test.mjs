import { describe, expect, it, vi } from "vitest";

import {
  closeNodeInputProofResources,
  completeNodeInputProof,
} from "../scripts/node-input-actions-proof-result.mjs";

describe("node-input Electron proof result boundary", () => {
  it("records failure and returns a failing exit when product reset fails after a passing scenario", async () => {
    const closed = [];
    const records = [];
    const result = await completeNodeInputProof({
      runScenario: vi.fn(async () => {}),
      cleanup: () => closeNodeInputProofResources([
        {
          name: "product",
          close: async () => {
            closed.push("product");
            throw new Error("product reset failed");
          },
        },
        { name: "catalog", close: async () => { closed.push("catalog"); } },
        { name: "runtime", close: async () => { closed.push("runtime"); } },
      ]),
      recordResult: async (record) => { records.push(record); },
    });

    expect(closed).toEqual(["product", "catalog", "runtime"]);
    expect(result.exitCode).toBe(1);
    expect(result.result).toMatchObject({ passed: false });
    expect(result.result.error).toContain("product reset failed");
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ passed: false });
    expect(records[0].error).toContain("teardown has not completed");
    expect(records[1]).toEqual(result.result);
    expect(records).not.toContainEqual({ passed: true });
  });

  it("promotes a provisional failure to passed only after scenario and teardown succeed", async () => {
    const events = [];
    const result = await completeNodeInputProof({
      runScenario: async () => { events.push("scenario"); },
      cleanup: async () => { events.push("cleanup"); },
      recordResult: async (record) => { events.push({ ...record }); },
    });

    expect(events).toEqual([
      "scenario",
      { passed: false, error: "Node-input Electron proof teardown has not completed." },
      "cleanup",
      { passed: true },
    ]);
    expect(result).toEqual({ result: { passed: true }, exitCode: 0 });
  });
});
