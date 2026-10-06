/**
 * Time to first graph for one Eval turn, read from the turn's candidate trace.
 *
 * "First graph" is backend publication, not browser appearance or usefulness: a successful
 * current transition (advance or return) or a successful terminal submit.
 * Repair counts come from two places. The graph-operation ledger gives writes
 * the server rejected. For harnesses that run stdin programs, the heredoc
 * commands in the trace give every program run (including small probes),
 * how many mention patch calls, and how many exited non-zero; a program that
 * fails in the client compiler never reaches the ledger, so both counts matter.
 * These command heuristics do not distinguish authoring attempts from probes.
 * This is a measurement of the run, not a grade; it never changes acceptance.
 */

const GRAPH_WRITE = /^\/api\/graph\/(nodes|edges|layers|actions|submit|current\/transitions)(\/|$)/;
const PROGRAM_MARK = "RELAYER_GRAPH_PROGRAM";
const PATCH_MARK = "rerunGraphProgram(";

function at(value) {
  const time = typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))
    ? Number(value) : Date.parse(String(value));
  return Number.isFinite(time) && Number.isFinite(new Date(time).getTime()) ? time : null;
}

function seconds(from, to) {
  return from === null || to === null || to < from ? null : Math.round((to - from) / 100) / 10;
}

function iso(time) {
  return time === null ? null : new Date(time).toISOString();
}

/**
 * @param {{ sentAt: number | string, events: readonly object[], graphOperations: readonly object[] }} input
 */
export function graphTimingFromTrace({ sentAt, events = [], graphOperations = [], ledgerComplete = false, eventsComplete = false }) {
  const sent = at(sentAt);
  let firstGraph = null;
  let accepted = null;
  let publicationUnknown = false;
  let rejections = ledgerComplete ? 0 : null;
  for (const operation of graphOperations) {
    if (operation.method !== "POST" || !GRAPH_WRITE.test(operation.path)) continue;
    const time = at(operation.observedAt);
    if (operation.status >= 400) { if (rejections !== null) rejections += 1; continue; }
    if (!Number.isInteger(operation.status) || operation.status < 200 || operation.status >= 300) continue;
    if (operation.path === "/api/graph/current/transitions" && !["advance", "return", "stop"].includes(operation.transitionKind)) {
      publicationUnknown = true;
      continue;
    }
    const returned = operation.path === "/api/graph/submit"
      || (operation.path === "/api/graph/current/transitions" && operation.transitionKind === "return");
    const visible = returned || (operation.path === "/api/graph/current/transitions" && operation.transitionKind === "advance");
    if (!visible) continue;
    if (time === null || sent === null || time < sent) { publicationUnknown = true; continue; }
    if (firstGraph === null || (time !== null && time < firstGraph)) firstGraph = time;
    if (returned && (accepted === null || (time !== null && time < accepted))) accepted = time;
  }
  let programRuns = null;
  for (const event of events) {
    if (event?.type !== "provider.event" || event.data?.method !== "item/completed") continue;
    const item = event.data.params?.item;
    if (item?.type !== "commandExecution" || typeof item.command !== "string" || !item.command.includes(PROGRAM_MARK)) continue;
    programRuns ??= { programs: 0, patches: 0, failed: 0 };
    programRuns[item.command.includes(PATCH_MARK) ? "patches" : "programs"] += 1;
    if (!Number.isInteger(item.exitCode)) programRuns.failed = null;
    else if (item.exitCode !== 0 && programRuns.failed !== null) programRuns.failed += 1;
  }
  return Object.freeze({
    schemaVersion: 1,
    sentAt: iso(sent),
    firstGraphAt: iso(ledgerComplete && !publicationUnknown ? firstGraph : null),
    acceptedAt: iso(ledgerComplete && !publicationUnknown ? accepted : null),
    firstGraphSeconds: seconds(sent, ledgerComplete && !publicationUnknown ? firstGraph : null),
    acceptedSeconds: seconds(sent, ledgerComplete && !publicationUnknown ? accepted : null),
    graphWriteRejections: rejections,
    programRuns: eventsComplete ? programRuns : null,
  });
}
