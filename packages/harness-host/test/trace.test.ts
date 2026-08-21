import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HarnessTraceStore, NO_HARNESS_TRACE_SUPPORT } from "../src/trace.js";
import type { HarnessTracePolicy, HarnessTraceSupport } from "../src/types.js";

const fullSupport: HarnessTraceSupport = {
  prompt: "full",
  messages: "full",
  reasoningSummaries: "summary",
  modelCalls: "full",
  toolCalls: "full",
  usage: "full",
  childStreams: "summary",
  nativeArtifacts: "none",
};

const policy = (overrides: Partial<HarnessTracePolicy> = {}): HarnessTracePolicy => ({
  mode: "required",
  requiredFeatures: {},
  includeNativeArtifacts: false,
  maxBytesPerTurn: 1_000_000,
  maxEventsPerTurn: 1_000,
  ...overrides,
});

describe("HarnessTraceStore", () => {
  it("rejects unsupported required coverage before a trace starts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-trace-preflight-"));
    try {
      const store = new HarnessTraceStore({
        directory,
        policy: policy({ requiredFeatures: { modelCalls: "full" } }),
      });
      expect(() => store.start({
        threadId: 1,
        interactionNodeId: 2,
        productInteractionId: 3,
        implementation: "fixture.none",
        configurationName: "fixture-none",
        support: NO_HARNESS_TRACE_SUPPORT,
      })).toThrow("before inference");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("seals nested portable events, redacts secrets, and exports exactly once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-trace-store-"));
    const target = join(directory, "exported", "candidate-trace");
    try {
      let nextId = 0;
      const store = new HarnessTraceStore({ directory: join(directory, "spool"), policy: policy(), createId: () => `id-${++nextId}` });
      const active = store.start({
        threadId: 1,
        interactionNodeId: 2,
        productInteractionId: 3,
        implementation: "fixture.trace",
        configurationName: "fixture-trace",
        support: fullSupport,
      });
      active.sink.emit({ type: "prompt", data: { text: "Explain it", authorization: "Bearer secret-token" } });
      const child = active.sink.openStream({ name: "Evidence worker", kind: "worker", providerStreamId: "provider-child" });
      const tool = child.openSpan({ name: "Search", kind: "tool", providerSpanId: "provider-tool" });
      tool.emit({ type: "tool.call.started", data: { query: "evidence", sizeJustification: "private layer reason" } });
      tool.end("completed", { result: "Bearer another-secret" });
      child.close("completed");
      await active.sink.attach({ name: "note.txt", mediaType: "text/plain", content: "OPENAI_API_KEY=sk-secretsecretsecret", sensitivity: "sensitive" });
      await expect(active.sink.attach({ name: "native.json", mediaType: "application/json", content: "{}", sensitivity: "normal", native: true, sanitized: true })).rejects.toThrow("disabled");
      const descriptor = await active.seal("complete");

      expect(descriptor).toMatchObject({ status: "complete", eventCount: expect.any(Number), redactionCount: expect.any(Number) });
      await store.export(3, target, {
        runId: "run-1",
        executionId: "execution-1",
        interactionId: "3",
        harnessConfigurationName: "fixture-trace",
      });
      const manifest = JSON.parse(await readFile(join(target, "manifest.json"), "utf8"));
      const events = await readFile(join(target, "events.jsonl"), "utf8");
      const attachment = await readFile(join(target, "attachments", "id-5.txt"), "utf8");
      expect(manifest).toMatchObject({
        format: "relayer-harness-trace-v1",
        correlation: { runId: "run-1", executionId: "execution-1", interactionId: "3" },
      });
      expect(events).toContain("stream.started");
      expect(events).toContain("span.completed");
      expect(events).not.toContain("secret-token");
      expect(events).not.toContain("private layer reason");
      expect(attachment).not.toContain("secretsecretsecret");
      await expect(store.export(3, join(directory, "second"), {
        runId: "run-1", executionId: "execution-1", interactionId: "3", harnessConfigurationName: "fixture-trace",
      })).rejects.toThrow("No candidate trace exists");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("records truncation and lowers achieved coverage without breaking sealing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-trace-cap-"));
    try {
      const store = new HarnessTraceStore({ directory, policy: policy({ maxEventsPerTurn: 2 }) });
      const active = store.start({
        threadId: 1,
        interactionNodeId: 2,
        implementation: "fixture.trace",
        configurationName: "fixture-trace",
        support: fullSupport,
      });
      active.sink.emit({ type: "message", data: { text: "discarded by the cap" } });
      const descriptor = await active.seal("complete");
      expect(descriptor.truncated).toBe(true);
      expect(descriptor.eventCount).toBeLessThanOrEqual(2);
      expect(descriptor.coverage.messages).toBe("summary");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
