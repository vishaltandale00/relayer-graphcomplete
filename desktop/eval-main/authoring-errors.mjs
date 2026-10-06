import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const WRITE = /^\/api\/graph\/(?:nodes|edges|layers|actions|submit|current\/transitions)(?:\/|$)/;
const ASSET_WRITES = new Set(["add", "create-tag", "move-tag", "associate", "organize", "archive"]);
export function unavailableAuthoringErrors(reason = "not_recorded") {
  return { schemaVersion: 1, coverage: "unavailable", total: null, observed: null, byCause: {}, reasons: [reason] };
}

/** Count origin records only. Shell exits and client echoes of HTTP errors are not incidents. */
export function authoringErrorsFromOperations(operations, { complete = true } = {}) {
  const seen = new Set();
  const byCause = {};
  let observed = 0;
  for (const operation of operations) {
    let key;
    let cause;
    if (operation.path === "/api/graph/authoring-errors" && operation.status === 202 && operation.authoringError) {
      key = `client:${operation.authoringError.id}`;
      cause = operation.authoringError.phase;
    } else if ((operation.method === "POST" && (WRITE.test(operation.path)
      || (operation.path === "/api/graph/visual-assets/operations" && ASSET_WRITES.has(operation.visualAssetOperationKind)))) && operation.status >= 400 && operation.status < 500 && ![401, 408, 429].includes(operation.status)) {
      key = `server:${operation.sequence}`;
      cause = "server_rejection";
    } else continue;
    if (seen.has(key)) continue;
    seen.add(key);
    observed += 1;
    byCause[cause] = (byCause[cause] ?? 0) + 1;
  }
  // v1 is explicitly a lower bound: unknown methods, Python pre-transport validation,
  // older/pinned clients, and lost diagnostic delivery are not proven covered.
  return { schemaVersion: 1, coverage: "partial", total: null, observed, byCause,
    reasons: ["client_capture_not_exhaustive", ...(complete ? [] : ["ledger_truncated"])] };
}

export async function authoringErrorsFromTraceDirectory(directory, descriptor, interactionNodeId) {
  const ledger = descriptor?.graphOperations;
  if (!ledger || ledger.format !== "relayer-graph-operations-v1" || ledger.ref !== "graph-operations.jsonl") {
    return unavailableAuthoringErrors("ledger_unavailable");
  }
  const bytes = await readFile(join(directory, ledger.ref));
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (bytes.byteLength !== ledger.byteLength || digest !== ledger.sha256) throw new Error("Authoring error ledger failed digest validation.");
  const lines = bytes.toString("utf8").split("\n").filter(Boolean);
  if (lines.length !== ledger.eventCount) throw new Error("Authoring error ledger event count mismatch.");
  const operations = lines.map((line) => JSON.parse(line));
  if (operations.some((event) => event.schemaVersion !== 1 || event.interactionNodeId !== interactionNodeId
    || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || typeof event.path !== "string"
    || typeof event.method !== "string" || !Number.isSafeInteger(event.status)
    || (event.authoringError && (typeof event.authoringError.id !== "string"
      || !["client", "compiler"].includes(event.authoringError.phase))))) {
    throw new Error("Authoring error ledger contains an invalid receipt.");
  }
  const metric = authoringErrorsFromOperations(operations, { complete: ledger.status === "complete" && ledger.truncated === false });
  if (ledger.authoringDiagnosticsDiscarded > 0) metric.reasons.push("diagnostics_truncated");
  return metric;
}
