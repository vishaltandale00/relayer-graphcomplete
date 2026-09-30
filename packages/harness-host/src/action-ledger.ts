import { redactTraceData } from "./trace.js";

/**
 * #584 / PRD CONT-013: the bounded record of what one native turn did. Each adapter maps its
 * own native events into it; it is never derived from a trace, which the product keeps off.
 * It holds short, redacted summaries only: never tool output, transcripts, or secrets.
 */
export type HarnessActionKind = "command" | "file_change" | "web" | "mcp_tool" | "native_subagent" | "other";
export type HarnessActionStatus = "completed" | "failed" | "interrupted";

export interface HarnessAction {
  readonly kind: HarnessActionKind;
  /** At most `MAX_ACTION_SUMMARY_BYTES` UTF-8 bytes, redacted, on one line. */
  readonly summary: string;
  readonly status: HarnessActionStatus;
  readonly exitCode?: number;
}

export interface HarnessActionLedger {
  /** Actions in the order they were first observed, at most `MAX_ACTION_LEDGER_ENTRIES`. */
  readonly entries: readonly HarnessAction[];
  /** Distinct actions observed after the ledger was full. */
  readonly omitted: number;
}

export interface HarnessActionObservation {
  readonly kind: HarnessActionKind;
  readonly summary: string;
}

export interface HarnessActionSettlement extends HarnessActionObservation {
  readonly status: HarnessActionStatus;
  readonly exitCode?: number;
}

/**
 * Adapter-facing sink for one turn's native actions, keyed by the provider's own identity for
 * the action. It never throws into the adapter, and it ignores everything once the host has
 * settled the turn, so a force-stopped turn that keeps reporting cannot change its ledger.
 */
export interface HarnessActionRecorder {
  /** A native action started. A repeated start of the same key is ignored. */
  started(key: string, action: HarnessActionObservation): void;
  /** A native action ended. An end without a start records the action as it ended. */
  ended(key: string, action: HarnessActionSettlement): void;
}

export const MAX_ACTION_LEDGER_ENTRIES = 64;
export const MAX_ACTION_SUMMARY_BYTES = 512;

const ACTION_KINDS: ReadonlySet<string> = new Set(["command", "file_change", "web", "mcp_tool", "native_subagent", "other"]);
const ACTION_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "interrupted"]);
const TRUNCATION_MARK = " …";

interface RecordedAction {
  kind: HarnessActionKind;
  summary: string;
  status: HarnessActionStatus | "running";
  exitCode?: number;
}

/** The host's per-turn ledger. `seal()` closes it; an action still running then was interrupted. */
export class HarnessActionLedgerRecorder implements HarnessActionRecorder {
  private readonly recorded: RecordedAction[] = [];
  private readonly byKey = new Map<string, RecordedAction | "omitted">();
  private omitted = 0;
  private sealedLedger: HarnessActionLedger | undefined;

  started(key: string, action: HarnessActionObservation): void {
    if (this.sealedLedger !== undefined || this.byKey.has(key)) return;
    try {
      this.admit(key, { kind: actionKind(action.kind), summary: actionSummary(action.summary, action.kind), status: "running" });
    } catch {
      // The ledger is best effort and must never change how the native turn runs.
    }
  }

  ended(key: string, action: HarnessActionSettlement): void {
    if (this.sealedLedger !== undefined) return;
    try {
      const existing = this.byKey.get(key);
      if (existing === "omitted") return;
      const status = ACTION_STATUSES.has(action.status) ? action.status : "failed";
      const exitCode = actionExitCode(action.exitCode);
      if (existing === undefined) {
        this.admit(key, {
          kind: actionKind(action.kind),
          summary: actionSummary(action.summary, action.kind),
          status,
          ...(exitCode === undefined ? {} : { exitCode }),
        });
        return;
      }
      // An action reports its outcome once; a late duplicate end does not rewrite it.
      if (existing.status !== "running") return;
      existing.status = status;
      // The start names the action. The end names it only when the start could not, as a
      // Codex web search reports its query only when it ends.
      if (existing.summary === fallbackSummary(existing.kind)) existing.summary = actionSummary(action.summary, existing.kind);
      if (exitCode !== undefined) existing.exitCode = exitCode;
    } catch {
      // The ledger is best effort and must never change how the native turn runs.
    }
  }

  /** Closes the ledger once. Later observations are ignored. */
  seal(): HarnessActionLedger {
    this.sealedLedger ??= Object.freeze({
      entries: Object.freeze(this.recorded.map((entry) => Object.freeze({
        kind: entry.kind,
        summary: entry.summary,
        status: entry.status === "running" ? "interrupted" : entry.status,
        ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
      }))),
      omitted: this.omitted,
    });
    return this.sealedLedger;
  }

  private admit(key: string, entry: RecordedAction): void {
    if (this.recorded.length >= MAX_ACTION_LEDGER_ENTRIES) {
      this.byKey.set(key, "omitted");
      this.omitted += 1;
      return;
    }
    this.recorded.push(entry);
    this.byKey.set(key, entry);
  }
}

/**
 * A summary is redacted with the trace redaction rules, reduced to one line, and cut to
 * `MAX_ACTION_SUMMARY_BYTES` UTF-8 bytes on a character boundary. Adapters apply their own
 * redaction first; this is the shared backstop.
 */
export function actionSummary(value: string, kind: HarnessActionKind): string {
  const redacted = redactTraceData(typeof value === "string" ? value : "");
  const text = typeof redacted === "string" ? redacted : "";
  // Control characters and line breaks become spaces, so a summary stays on one line.
  const oneLine = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (oneLine === "") return fallbackSummary(kind);
  return truncateUtf8(oneLine, MAX_ACTION_SUMMARY_BYTES);
}

/** The first line of a possibly multi-line command or program, marked when more follows. */
export function firstLineSummary(value: unknown): string {
  if (typeof value !== "string") return "";
  const lines = value.trim().split(/\r?\n|\r/u);
  const first = lines[0]?.trim() ?? "";
  return lines.length > 1 ? `${first}${TRUNCATION_MARK}` : first;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const budget = maxBytes - Buffer.byteLength(TRUNCATION_MARK, "utf8");
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > budget) break;
    bytes += size;
    end += character.length;
  }
  return `${value.slice(0, end).trimEnd()}${TRUNCATION_MARK}`;
}

function fallbackSummary(kind: HarnessActionKind): string {
  switch (kind) {
    case "command": return "command";
    case "file_change": return "file change";
    case "web": return "web request";
    case "mcp_tool": return "MCP tool call";
    case "native_subagent": return "native subagent";
    default: return "action";
  }
}

function actionKind(kind: string): HarnessActionKind {
  return ACTION_KINDS.has(kind) ? kind as HarnessActionKind : "other";
}

function actionExitCode(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647
    ? value
    : undefined;
}
