import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import { graphTimingFromTraceDirectory } from "../desktop/eval-main/eval-service.mjs";

it("reads integrity-bound exported traces independently and preserves unknown evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "graph-timing-"));
  const sentAt = Date.parse("2026-10-05T16:00:00Z");
  const events = JSON.stringify({ type: "provider.event", data: { method: "item/completed", params: {
    item: { type: "commandExecution", command: "RELAYER_GRAPH_PROGRAM", exitCode: 1 } } } }) + "\n";
  const ledger = JSON.stringify({ schemaVersion: 1, sequence: 1, method: "POST", path: "/api/graph/current/transitions", status: 200,
    transitionKind: "return", observedAt: new Date(sentAt + 5000).toISOString() }) + "\n";
  const artifact = (bytes) => ({ status: "complete", truncated: false, byteLength: Buffer.byteLength(bytes),
    eventCount: 1, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` });
  const descriptor = { ...artifact(events), format: "relayer-harness-trace-v1", traceId: "fixture-trace", coverage: { toolCalls: "full" }, graphOperations: artifact(ledger) };
  try {
    await writeFile(join(directory, "manifest.json"), JSON.stringify({ schemaVersion: 1, format: descriptor.format, traceId: descriptor.traceId, status: "complete", truncated: false, achievedCoverage: { toolCalls: "full" }, artifacts: { events: { ...artifact(events), ref: "events.jsonl" } } }));
    await writeFile(join(directory, "events.jsonl"), events);
    await writeFile(join(directory, "graph-operations.jsonl"), ledger);
    expect(await graphTimingFromTraceDirectory(directory, sentAt, descriptor)).toMatchObject({
      firstGraphSeconds: 5, acceptedSeconds: 5, graphWriteRejections: 0,
      programRuns: { programs: 1, patches: 0, failed: 1 },
    });
    expect(await graphTimingFromTraceDirectory(directory, sentAt, { ...descriptor,
      status: "partial", graphOperations: { ...descriptor.graphOperations, status: "partial", truncated: true } })).toMatchObject({
      firstGraphSeconds: null, acceptedSeconds: null, graphWriteRejections: null,
      programRuns: { failed: 1 },
    });
    await writeFile(join(directory, "events.jsonl"), "corrupt");
    expect(await graphTimingFromTraceDirectory(directory, sentAt, descriptor)).toMatchObject({ acceptedSeconds: 5, programRuns: null });
    await rm(join(directory, "graph-operations.jsonl"));
    expect(await graphTimingFromTraceDirectory(directory, sentAt, descriptor)).toMatchObject({ graphWriteRejections: null });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
