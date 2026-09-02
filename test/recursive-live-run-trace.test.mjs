import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { exportTraceEvidence } from "../scripts/recursive-live-run-trace.mjs";

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(events, {
  interactionNodeId = 202,
  corruptManifest = false,
  corruptDescriptor = false,
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "recursive-live-trace-"));
  directories.push(directory);
  const calls = [];
  const runtime = {
    async exportCandidateTrace(productInteractionId, target, correlation) {
      calls.push({ productInteractionId, target, correlation });
      await mkdir(target, { recursive: true });
      const encoded = `${events.map(JSON.stringify).join("\n")}\n`;
      const bytes = Buffer.from(encoded);
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      await writeFile(join(target, "events.jsonl"), bytes);
      await writeFile(join(target, "manifest.json"), `${JSON.stringify({
        schemaVersion: 1,
        format: "relayer-harness-trace-v1",
        status: "complete",
        traceId: "trace-1",
        productInteractionId,
        interactionNodeId: corruptManifest ? interactionNodeId + 1 : interactionNodeId,
        correlation,
        artifacts: {
          events: { ref: "events.jsonl", sha256: digest, byteLength: bytes.byteLength, eventCount: events.length },
        },
      })}\n`);
      return {
        status: "complete",
        format: "relayer-harness-trace-v1",
        traceId: "trace-1",
        sha256: corruptDescriptor ? "sha256:wrong" : digest,
        byteLength: bytes.byteLength,
        eventCount: events.length,
        coverage: {
          prompt: "full", messages: "full", reasoningSummaries: "full",
          modelCalls: "full", toolCalls: "full", usage: "full",
        },
      };
    },
  };
  return { directory, runtime, calls };
}

const brokerScope = { type: "execution.scope", data: { completionBrokerAvailable: true } };

describe("recursive live-run trace evidence", () => {
  it("exports product-attributed evidence, fails closed on every integrity break, and retries only an unsealed trace", async () => {
    const { directory, runtime, calls } = await fixture([
      brokerScope,
      { type: "prompt", data: { text: "task" } },
      { type: "message", data: { text: "answer" } },
    ]);

    const evidence = await exportTraceEvidence({
      runtime,
      interactions: [{ id: 29, graphNodeId: 202 }],
      directory,
      refPrefix: "traces/enabled",
      correlation: { runId: "run-1", arm: "enabled" },
    });

    expect(evidence, "product-attributed evidence exposes only the broker boolean inline").toEqual([
      expect.objectContaining({
        productInteractionId: 29,
        completionId: 202,
        status: "complete",
        coverageComplete: true,
        completionBrokerAvailable: true,
        ref: "traces/enabled/29/manifest.json",
      }),
    ]);
    expect(calls[0].correlation, "the export correlation names the interaction").toEqual({
      runId: "run-1",
      arm: "enabled",
      interactionId: "29",
    });
    expect(JSON.stringify(evidence), "prompt bytes stay in the trace file").not.toContain("task");
    expect(JSON.stringify(evidence), "answer bytes stay in the trace file").not.toContain("answer");

    const integrityCases = [
      ["a missing broker-scope marker", [{ type: "prompt", data: { text: "task" } }], {}, /broker-scope marker/],
      ["conflicting broker-scope markers", [
        brokerScope,
        { type: "execution.scope", data: { completionBrokerAvailable: false } },
      ], {}, /broker-scope marker/],
      ["a manifest identity mismatch", [brokerScope], { corruptManifest: true }, /manifest or event integrity/],
      ["an event-byte descriptor mismatch", [brokerScope], { corruptDescriptor: true }, /manifest or event integrity/],
    ];
    expect(integrityCases, "integrity break inventory").toHaveLength(4);
    for (const [label, events, options, expected] of integrityCases) {
      const broken = await fixture(events, { interactionNodeId: 101, ...options });
      await expect(exportTraceEvidence({
        runtime: broken.runtime,
        interactions: [{ id: 1, graphNodeId: 101 }],
        directory: broken.directory,
        refPrefix: "traces/enabled",
        correlation: {},
      }), `${label} fails closed`).rejects.toThrow(expected);
    }

    const pending = await fixture([brokerScope], { interactionNodeId: 101 });
    const exportTrace = pending.runtime.exportCandidateTrace.bind(pending.runtime);
    let attempts = 0;
    pending.runtime.exportCandidateTrace = async (...args) => {
      attempts += 1;
      if (attempts === 1) throw new Error("No candidate trace exists for product interaction 1");
      return exportTrace(...args);
    };

    await expect(exportTraceEvidence({
      runtime: pending.runtime,
      interactions: [{ id: 1, graphNodeId: 101 }],
      directory: pending.directory,
      refPrefix: "traces/enabled",
      correlation: {},
      timeoutMs: 100,
      pollIntervalMs: 1,
    }), "waits for a child trace that has not sealed yet").resolves.toHaveLength(1);
    expect(attempts, "retries only until the trace exists").toBe(2);

    let unrelatedAttempts = 0;
    pending.runtime.exportCandidateTrace = async () => {
      unrelatedAttempts += 1;
      throw new Error("Candidate trace integrity failed");
    };
    await expect(exportTraceEvidence({
      runtime: pending.runtime,
      interactions: [{ id: 2, graphNodeId: 102 }],
      directory: pending.directory,
      refPrefix: "traces/enabled",
      correlation: {},
      timeoutMs: 100,
      pollIntervalMs: 1,
    }), "an integrity failure never retries").rejects.toThrow("Candidate trace integrity failed");
    expect(unrelatedAttempts, "integrity failures propagate immediately").toBe(1);

    let timedAttempts = 0;
    pending.runtime.exportCandidateTrace = async () => {
      timedAttempts += 1;
      throw new Error("No candidate trace exists for product interaction 3");
    };
    await expect(exportTraceEvidence({
      runtime: pending.runtime,
      interactions: [{ id: 3, graphNodeId: 103 }],
      directory: pending.directory,
      refPrefix: "traces/enabled",
      correlation: {},
      timeoutMs: 1,
      pollIntervalMs: 1,
    }), "a never-sealed trace times out").rejects.toThrow("No candidate trace exists for product interaction 3");
    expect(timedAttempts, "the wait kept polling until the deadline").toBeGreaterThanOrEqual(1);
  }, 30_000);
});
