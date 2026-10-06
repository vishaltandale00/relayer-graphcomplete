import { describe, expect, it } from "vitest";
import { graphTimingFromTrace } from "../desktop/eval-main/graph-timing.mjs";

const T0 = Date.parse("2026-10-05T16:00:00.000Z");
const at = (seconds) => new Date(T0 + seconds * 1000).toISOString();
const op = (method, path, status, seconds) => ({ schemaVersion: 1, method, path, status, sequence: 1, observedAt: at(seconds), interactionNodeId: 21 });
const command = (text, exitCode, seconds) => ({
  type: "provider.event", observedAt: at(seconds),
  data: { method: "item/completed", params: { item: { id: "x", type: "commandExecution", command: text, exitCode } } },
});
const heredoc = (body) => `node --input-type=module <<'RELAYER_GRAPH_PROGRAM'\n${body}\nRELAYER_GRAPH_PROGRAM`;

describe("time to first graph from a candidate trace", () => {
  it("measures send to first visible graph and to accepted, and counts repairs", () => {
    const timing = graphTimingFromTrace({
      sentAt: T0, ledgerComplete: true, eventsComplete: true,
      graphOperations: [
        op("GET", "/api/graph/input", 200, 1),
        op("POST", "/api/graph/nodes", 200, 60),
        op("POST", "/api/graph/nodes", 400, 61), // one rejected write
        op("POST", "/api/graph/layers", 200, 62),
        { ...op("POST", "/api/graph/current/transitions", 200, 70), transitionKind: "advance" }, // first visible graph
        op("POST", "/api/graph/actions", 422, 80), // another rejection
        op("POST", "/api/graph/submit", 409, 90), // rejected submit is not acceptance
        op("POST", "/api/graph/submit", 200, 100.25),
      ],
      events: [
        command(heredoc("full program"), 1, 61),
        command(heredoc("import { rerunGraphProgram } from 'x';\nawait rerunGraphProgram([])"), 1, 80),
        command(heredoc("import { rerunGraphProgram } from 'x';\nawait rerunGraphProgram([])"), 0, 100),
        command("rg -n detailCapability", 0, 30), // not a graph program
      ],
    });
    expect(timing).toEqual({
      schemaVersion: 1,
      sentAt: at(0),
      firstGraphAt: at(70),
      acceptedAt: at(100.25),
      firstGraphSeconds: 70,
      acceptedSeconds: 100.3,
      graphWriteRejections: 3,
      programRuns: { programs: 1, patches: 2, failed: 2 },
    });
  });

  it("reports nulls, not zeros, when nothing was published or no programs were seen", () => {
    const timing = graphTimingFromTrace({ sentAt: "not a time", ledgerComplete: true, eventsComplete: true, graphOperations: [op("POST", "/api/graph/nodes", 200, 5)], events: [] });
    expect(timing).toMatchObject({ sentAt: null, firstGraphAt: null, acceptedAt: null, firstGraphSeconds: null, acceptedSeconds: null, graphWriteRejections: 0, programRuns: null });
  });

  it("treats a terminal submit as the first visible graph when nothing was advanced before it", () => {
    const timing = graphTimingFromTrace({ sentAt: T0, ledgerComplete: true, eventsComplete: true, graphOperations: [op("POST", "/api/graph/submit", 200, 42)], events: [] });
    expect(timing.firstGraphSeconds).toBe(42);
    expect(timing.acceptedSeconds).toBe(42);
  });
  it("distinguishes advance, temporal return, stop and legacy unknown transitions", () => {
    const measure = (operations) => graphTimingFromTrace({ sentAt: String(T0), events: [],
      graphOperations: operations, ledgerComplete: true, eventsComplete: true });
    const transition = (kind, seconds) => ({ ...op("POST", "/api/graph/current/transitions", 200, seconds), transitionKind: kind });
    expect(measure([transition("stop", 4)])).toMatchObject({ firstGraphSeconds: null, acceptedSeconds: null });
    expect(measure([transition(undefined, 4)])).toMatchObject({ firstGraphSeconds: null, acceptedSeconds: null });
    expect(measure([transition("return", 8), transition("advance", 5)])).toMatchObject({ firstGraphSeconds: 5, acceptedSeconds: 8 });
  });

  it("keeps partial and missing evidence unknown independently", () => {
    expect(graphTimingFromTrace({ sentAt: T0, graphOperations: [op("POST", "/api/graph/submit", 200, 5)], events: [] }))
      .toMatchObject({ firstGraphSeconds: null, acceptedSeconds: null, graphWriteRejections: null, programRuns: null });
  });

  it("keeps absent command exit outcomes unknown", () => {
    expect(graphTimingFromTrace({ sentAt: T0, eventsComplete: true, ledgerComplete: true, graphOperations: [],
      events: [command(heredoc("probe"), undefined, 3)] }).programRuns.failed).toBeNull();
  });

});
