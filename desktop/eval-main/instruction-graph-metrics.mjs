import { instructionGraphTreatments } from "./instruction-graph-comparison.mjs";

const counters = ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"];
const count = (value) => Number.isSafeInteger(value) && value >= 0;

const reasonPurposes = new Set(["authority", "authoring", "presentation", "navigation", "search", "preview", "repair", "delegation", "verification", "recovery"]);
function validSummary(value) {
  return typeof value === "string" && [...value.trim()].length >= 8
    && [...value].length <= 240 && !/\p{Cc}/u.test(value);
}
function validReason(reason) {
  return reason && reasonPurposes.has(reason.purpose) && validSummary(reason.detail);
}

function reasonedRetrievalMetrics(graphOperations, ledgerComplete) {
  const successful = graphOperations.filter((operation) => operation.method === "POST"
    && operation.path === "/api/graph/instruction-graph/retrieve" && operation.status >= 200 && operation.status < 300);
  const searches = graphOperations.filter((operation) => operation.method === "POST"
    && operation.path === "/api/graph/instruction-graph/search" && operation.status >= 200 && operation.status < 300);
  const receipts = successful.map((operation) => operation.instructionRetrieval
    ? { ...operation.instructionRetrieval, sequence: operation.sequence ?? null } : undefined);
  const valid = ledgerComplete && receipts.every((receipt) => receipt
    && typeof receipt.requestKey === "string" && receipt.requestKey.length > 0 && typeof receipt.replayed === "boolean"
    && validReason(receipt.reason) && (receipt.rereadReason === undefined || validSummary(receipt.rereadReason))
    && Array.isArray(receipt.entries) && receipt.entries.length > 0 && receipt.entries.every((entry) =>
      Number.isSafeInteger(entry.nodeId) && entry.nodeId > 0 && typeof entry.key === "string" && entry.key.length > 0
      && ["body", "already-returned", "reread"].includes(entry.delivery) && count(entry.bodyCharacters)
      && (entry.bodyBytes === undefined || count(entry.bodyBytes))
      && (entry.delivery !== "already-returned" || (entry.bodyCharacters === 0 && (entry.bodyBytes === undefined || entry.bodyBytes === 0)))
      && (entry.delivery !== "reread" || receipt.rereadReason !== undefined)))
    && searches.every((operation) => validReason(operation.instructionSearchReceipt?.reason));
  const entries = valid ? receipts.flatMap((receipt) => receipt.entries.map((entry) => ({ ...entry, replayed: receipt.replayed }))) : [];
  const bodies = entries.filter((entry) => entry.delivery !== "already-returned");
  return {
    readProtocol: 2,
    reasonCoverage: valid ? "complete" : "unknown",
    successfulReads: valid ? bodies.length : null,
    uniqueModulesRead: valid ? new Set(bodies.map((entry) => entry.nodeId)).size : null,
    uniqueReadRequests: valid ? new Set(receipts.map((receipt) => receipt.requestKey)).size : null,
    firstBodyResponses: valid ? bodies.filter((entry) => entry.delivery === "body" && !entry.replayed).length : null,
    replayBodyResponses: valid ? bodies.filter((entry) => entry.replayed).length : null,
    rereadBodyResponses: valid ? bodies.filter((entry) => entry.delivery === "reread" && !entry.replayed).length : null,
    duplicateMetadataResponses: valid ? entries.filter((entry) => entry.delivery === "already-returned").length : null,
    returnedBodyCharacters: valid ? bodies.reduce((sum, entry) => sum + entry.bodyCharacters, 0) : null,
    returnedBodyBytes: valid && bodies.every((entry) => count(entry.bodyBytes)) ? bodies.reduce((sum, entry) => sum + entry.bodyBytes, 0) : null,
    readReasons: valid ? receipts.map(({ requestKey, replayed, reason, rereadReason, entries, sequence }) => ({ requestKey, replayed, sequence,
      reason: { purpose: reason.purpose, detail: reason.detail }, ...(rereadReason === undefined ? {} : { rereadReason }),
      entries: entries.map(({ nodeId, key, delivery, bodyCharacters, bodyBytes }) => ({ nodeId, key, delivery, bodyCharacters, ...(bodyBytes === undefined ? {} : { bodyBytes }) })),
    })) : null,
    searchReasons: valid ? searches.map((operation) => ({ sequence: operation.sequence ?? null,
      reason: { purpose: operation.instructionSearchReceipt.reason.purpose, detail: operation.instructionSearchReceipt.reason.detail } })) : null,
  };
}

/** Native session cumulative receipts are observations, not a complete task cost ledger. */
export function instructionMetricsFromTrace(events, { complete = false, graphOperations = [], ledgerComplete = false } = {}) {
  const prompts = events.filter((event) => event.type === "prompt");
  const prompt = prompts.length === 1 ? prompts[0].data : null;
  const readProtocol = instructionGraphTreatments[prompt?.instructionGraphVersionKey]?.readProtocol ?? null;
  const actualPromptCharacters = complete && count(prompt?.actualPromptCharacters) ? prompt.actualPromptCharacters : null;
  const actualPromptUtf8Bytes = complete && count(prompt?.actualPromptUtf8Bytes) ? prompt.actualPromptUtf8Bytes : null;
  const updates = events.filter((event) => event.type === "provider.event" && event.data?.method === "thread/tokenUsage/updated")
    .map((event) => event.data.params);
  const streams = new Set(updates.map((params) => params?.threadId ?? null));
  const totals = updates.map((params) => params?.tokenUsage?.total);
  const valid = complete && updates.length > 0 && streams.size === 1
    && updates.every((params) => typeof params?.threadId === "string" && params.threadId.length > 0) && totals.every((total, index) => total
    && count(total.inputTokens) && count(total.outputTokens)
    && counters.every((key) => total[key] === undefined || (count(total[key])
      && (index === 0 || totals[index - 1]?.[key] === undefined || total[key] >= totals[index - 1][key]))));
  const last = totals.at(-1);
  return {
    schemaVersion: 1,
    actualPromptCharacters,
    actualPromptUtf8Bytes,
    instructionDelivery: complete && typeof prompt?.instructionGraphVersionKey === "string"
      && /^[a-f0-9]{64}$/.test(prompt.instructionGraphDigest ?? "")
      ? { versionKey: prompt.instructionGraphVersionKey, digest: prompt.instructionGraphDigest } : null,
    instructionRetrieval: {
      status: ledgerComplete ? "recorded" : "unknown",
      successfulReads: ledgerComplete ? graphOperations.filter((operation) => operation.method === "GET"
        && /^\/api\/graph\/instruction-graph\/(nodes|layers)\/[1-9][0-9]*$/.test(operation.path)
        && operation.status >= 200 && operation.status < 300).length : null,
      reasonCoverage: "unknown",
      readProtocol,
      ...(readProtocol === 2 ? reasonedRetrievalMetrics(graphOperations, ledgerComplete) : {}),
      successfulSearches: ledgerComplete ? graphOperations.filter((operation) => operation.method === "POST"
        && operation.path === "/api/graph/instruction-graph/search"
        && operation.status >= 200 && operation.status < 300).length : null,
    },
    providerSessionUsage: {
      status: valid ? "recorded" : "unknown",
      scope: "native-session-cumulative-receipt",
      counters: valid ? Object.fromEntries(counters.filter((key) => count(last[key])).map((key) => [key, last[key]])) : null,
      nativeChildCoverage: "unknown",
      reason: valid ? null : !complete ? "trace_incomplete" : updates.length === 0 ? "usage_not_reported" : "usage_ambiguous_or_invalid",
    },
  };
}

export function aggregateInstructionMetrics(execution, { expectedRootTurns = execution.turns?.length ?? 0 } = {}) {
  const turns = [...(execution.turns ?? []), ...(execution.semanticChildren ?? [])];
  const promptCharacters = turns.map((turn) => turn.instructionMetrics?.actualPromptCharacters);
  const sessions = turns.map((turn) => turn.instructionMetrics?.providerSessionUsage);
  const recorded = sessions.filter((usage) => usage?.status === "recorded");
  const retrievals = turns.map((turn) => turn.instructionMetrics?.instructionRetrieval);
  const completeRetrievals = turns.length > 0 && (execution.turns?.length ?? 0) === expectedRootTurns
    && retrievals.every((metric) => metric?.readProtocol === 2 && metric.reasonCoverage === "complete");
  const sumRetrieval = (key) => completeRetrievals && retrievals.every((metric) => count(metric[key]))
    ? retrievals.reduce((sum, metric) => sum + metric[key], 0) : null;
  return {
    instructionRetrieval: {
      reasonCoverage: completeRetrievals ? "complete" : "unknown",
      returnedBodyCharacters: sumRetrieval("returnedBodyCharacters"),
      returnedBodyBytes: sumRetrieval("returnedBodyBytes"),
      uniqueModuleReadsByGraphSession: sumRetrieval("uniqueModulesRead"),
      replayBodyResponses: sumRetrieval("replayBodyResponses"),
      rereadBodyResponses: sumRetrieval("rereadBodyResponses"),
      duplicateMetadataResponses: sumRetrieval("duplicateMetadataResponses"),
    },
    actualPromptCharacters: turns.length > 0 && (execution.turns?.length ?? 0) === expectedRootTurns && promptCharacters.every(count) ? promptCharacters.reduce((sum, value) => sum + value, 0) : null,
    observedInputTokens: recorded.length ? recorded.reduce((sum, usage) => sum + usage.counters.inputTokens, 0) : null,
    observedOutputTokens: recorded.length ? recorded.reduce((sum, usage) => sum + usage.counters.outputTokens, 0) : null,
    recordedSessions: recorded.length,
    expectedGraphSessions: expectedRootTurns + (execution.semanticChildren?.length ?? 0),
    totalInputTokens: null,
    coverage: "unknown",
    reason: "Provider-native child usage coverage is not established; observed session counters are not a whole-task total.",
    latencyScope: "evaluation-cell-including-grading",
    latencyMs: Number.isFinite(execution.lifecycle?.durationMs) ? execution.lifecycle.durationMs : null,
    graphWriteRejections: turns.length > 0 && turns.every((turn) => count(turn.timing?.graphWriteRejections))
      ? turns.reduce((sum, turn) => sum + turn.timing.graphWriteRejections, 0) : null,
  };
}
