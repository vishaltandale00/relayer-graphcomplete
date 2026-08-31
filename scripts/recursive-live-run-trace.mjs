import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

/** Export complete root/child traces and retain only the safe broker-scope observation inline. */
export async function exportTraceEvidence({
  runtime,
  interactions,
  directory,
  refPrefix,
  correlation,
  timeoutMs = 30_000,
  pollIntervalMs = 50,
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > timeoutMs) {
    throw new Error("Candidate trace export requires bounded positive timing values");
  }
  return Promise.all(interactions.map(async (interaction) => {
    const target = join(directory, String(interaction.id));
    const expectedCorrelation = {
      ...correlation,
      interactionId: String(interaction.id),
    };
    const deadline = Date.now() + timeoutMs;
    let descriptor;
    for (;;) {
      try {
        descriptor = await runtime.exportCandidateTrace(interaction.id, target, expectedCorrelation);
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== `No candidate trace exists for product interaction ${interaction.id}`
          || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, deadline - Date.now())));
      }
    }
    const eventsBytes = await readFile(join(target, "events.jsonl"));
    const lines = eventsBytes.toString("utf8").trim().split("\n").filter(Boolean);
    const eventsSha256 = sha256(eventsBytes);
    const manifest = JSON.parse(await readFile(join(target, "manifest.json"), "utf8"));
    const eventsArtifact = manifest?.artifacts?.events;
    if (descriptor.format !== "relayer-harness-trace-v1"
      || descriptor.sha256 !== eventsSha256
      || descriptor.byteLength !== eventsBytes.byteLength
      || descriptor.eventCount !== lines.length
      || manifest?.schemaVersion !== 1
      || manifest?.format !== descriptor.format
      || manifest?.status !== descriptor.status
      || manifest?.traceId !== descriptor.traceId
      || manifest?.productInteractionId !== interaction.id
      || manifest?.interactionNodeId !== interaction.graphNodeId
      || Object.entries(expectedCorrelation).some(([key, value]) => manifest?.correlation?.[key] !== value)
      || eventsArtifact?.ref !== "events.jsonl"
      || eventsArtifact?.sha256 !== eventsSha256
      || eventsArtifact?.byteLength !== eventsBytes.byteLength
      || eventsArtifact?.eventCount !== lines.length) {
      throw new Error(`Candidate trace ${interaction.id} manifest or event integrity did not match its descriptor`);
    }
    const scopeEvents = lines.map((line) => JSON.parse(line)).filter((event) => event.type === "execution.scope");
    const markers = [...new Set(scopeEvents.map((event) => event.data?.completionBrokerAvailable)
      .filter((value) => typeof value === "boolean"))];
    if (markers.length !== 1) {
      throw new Error(`Candidate trace ${interaction.id} did not record one consistent broker-scope marker`);
    }
    const requiredCoverage = ["prompt", "messages", "reasoningSummaries", "modelCalls", "toolCalls", "usage"];
    return {
      productInteractionId: interaction.id,
      completionId: interaction.graphNodeId,
      status: descriptor.status,
      format: descriptor.format,
      sha256: descriptor.sha256,
      byteLength: descriptor.byteLength,
      eventCount: descriptor.eventCount,
      coverage: descriptor.coverage,
      coverageComplete: requiredCoverage.every((feature) => descriptor.coverage?.[feature] === "full"),
      ...(descriptor.truncated ? { truncated: true } : {}),
      completionBrokerAvailable: markers[0],
      ref: `${refPrefix}/${interaction.id}/manifest.json`,
    };
  }));
}
