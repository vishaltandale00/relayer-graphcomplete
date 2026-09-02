import { describe, expect, it, vi } from "vitest";

import {
  closeNodeInputProofResources,
  completeNodeInputProof,
} from "../scripts/node-input-actions-proof-result.mjs";

describe("node-input Electron proof result boundary", () => {
  it("keeps the verdict provisional until scenario and teardown both succeed", async () => {
    const closed = [];
    const records = [];
    const failed = await completeNodeInputProof({
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

    expect(closed, "teardown closes every resource despite the failure").toEqual(["product", "catalog", "runtime"]);
    expect(failed.exitCode, "teardown failure keeps a failing exit").toBe(1);
    expect(failed.result, "teardown failure keeps the verdict failed").toMatchObject({ passed: false });
    expect(failed.result.error, "teardown failure surfaces its error").toContain("product reset failed");
    expect(records, "provisional and final records both persisted").toHaveLength(2);
    expect(records[0], "provisional record starts failed").toMatchObject({ passed: false });
    expect(records[0].error, "provisional record names incomplete teardown").toContain("teardown has not completed");
    expect(records[1], "final record carries the failed verdict").toEqual(failed.result);
    expect(records, "no passing verdict leaks from a failed teardown").not.toContainEqual({ passed: true });

    const events = [];
    const passed = await completeNodeInputProof({
      runScenario: async () => { events.push("scenario"); },
      cleanup: async () => { events.push("cleanup"); },
      recordResult: async (record) => { events.push({ ...record }); },
    });

    expect(events, "provisional failure promotes only after scenario and teardown succeed").toEqual([
      "scenario",
      { passed: false, error: "Node-input Electron proof teardown has not completed." },
      "cleanup",
      { passed: true },
    ]);
    expect(passed, "successful boundary exits cleanly").toEqual({ result: { passed: true }, exitCode: 0 });
  });
});
