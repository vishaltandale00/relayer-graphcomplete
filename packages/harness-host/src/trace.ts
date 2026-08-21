import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type {
  HarnessTraceAttachmentInput,
  HarnessTraceDescriptor,
  HarnessTraceEvent,
  HarnessTraceEventInput,
  HarnessTracePolicy,
  HarnessTraceSink,
  HarnessTraceSpan,
  HarnessTraceStatus,
  HarnessTraceStream,
  HarnessTraceSupport,
  HarnessTraceTerminalStatus,
  JsonObject,
  JsonValue,
  TraceAttachmentRef,
  TraceCoverage,
} from "./types.js";

export const NO_HARNESS_TRACE_SUPPORT: HarnessTraceSupport = Object.freeze({
  prompt: "none",
  messages: "none",
  reasoningSummaries: "none",
  modelCalls: "none",
  toolCalls: "none",
  usage: "none",
  childStreams: "none",
  nativeArtifacts: "none",
});

export const NO_HARNESS_TRACE_POLICY: HarnessTracePolicy = Object.freeze({
  mode: "off",
  requiredFeatures: Object.freeze({}),
  includeNativeArtifacts: false,
  maxBytesPerTurn: 1,
  maxEventsPerTurn: 1,
});

export interface HarnessTraceStoreOptions {
  readonly directory: string;
  readonly policy: HarnessTracePolicy;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

export interface HarnessTraceStartInput {
  readonly threadId: number;
  readonly interactionNodeId: number;
  readonly productInteractionId?: number;
  readonly implementation: string;
  readonly configurationName: string;
  readonly support: HarnessTraceSupport;
}

export interface HarnessTraceExportCorrelation {
  readonly runId: string;
  readonly executionId: string;
  readonly interactionId: string;
  readonly harnessConfigurationName: string;
  readonly model?: string;
}

export interface ActiveHarnessTrace {
  readonly sink: HarnessTraceSink;
  seal(status: Exclude<HarnessTraceStatus, "disabled">, reason?: string): Promise<HarnessTraceDescriptor>;
}

interface StoredTrace {
  readonly directory: string;
  readonly descriptor: HarnessTraceDescriptor;
  readonly manifest: JsonObject;
}

interface BufferedAttachment extends TraceAttachmentRef {
  readonly content: Uint8Array;
  readonly sensitivity: "normal" | "sensitive";
  readonly native: boolean;
}

const coverageRank: Readonly<Record<TraceCoverage, number>> = { none: 0, summary: 1, full: 2 };
const HOST_EVENT_TYPES = new Set(["run.started", "run.completed", "stream.started", "stream.completed", "span.started", "span.completed"]);
const SENSITIVE_KEYS = /^(?:authorization|proxy-authorization|cookie|set-cookie|api[_-]?key|secret|password|token|graph[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|thinking|thought|reasoning[_-]?content|thinking[_-]?signature|thought[_-]?signature|encrypted[_-]?(?:content|reasoning)|size[_-]?justification|environment|env)$/i;
const MAX_STRING_LENGTH = 128_000;

export class HarnessTraceStore {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly tracesByProductInteraction = new Map<number, StoredTrace>();

  constructor(private readonly options: HarnessTraceStoreOptions) {
    validateTracePolicy(options.policy);
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  start(input: HarnessTraceStartInput): ActiveHarnessTrace {
    validateTraceSupport(input.support);
    validateRequiredCoverage(this.options.policy, input.support);
    if (this.options.policy.mode === "off") return disabledTrace(this.options.policy);
    return new BufferedHarnessTrace(this, input, this.options.policy, this.now, this.createId);
  }

  storageDirectory(): string {
    return this.options.directory;
  }

  async export(
    productInteractionId: number,
    targetDirectory: string,
    correlation: HarnessTraceExportCorrelation,
  ): Promise<HarnessTraceDescriptor> {
    const stored = this.tracesByProductInteraction.get(productInteractionId);
    if (stored === undefined) throw new Error(`No candidate trace exists for product interaction ${productInteractionId}`);
    const target = resolve(targetDirectory);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await cp(stored.directory, target, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
    const manifestFile = join(target, "manifest.json");
    const manifest = {
      ...stored.manifest,
      correlation: redactJson(correlation).value,
    } satisfies JsonObject;
    await atomicWrite(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    this.tracesByProductInteraction.delete(productInteractionId);
    return stored.descriptor;
  }

  record(productInteractionId: number | undefined, stored: StoredTrace): void {
    if (productInteractionId === undefined) return;
    this.tracesByProductInteraction.set(productInteractionId, stored);
  }
}

class BufferedHarnessTrace implements ActiveHarnessTrace, HarnessTraceSink {
  readonly sink: HarnessTraceSink = this;
  readonly rootStreamId: string;
  private readonly traceId: string;
  private readonly createdAt: string;
  private readonly events: HarnessTraceEvent[] = [];
  private readonly attachments: BufferedAttachment[] = [];
  private readonly streamIds = new Set<string>();
  private readonly openStreams = new Set<string>();
  private readonly spanStreams = new Map<string, string>();
  private readonly openSpans = new Set<string>();
  private sequence = 0;
  private byteLength = 0;
  private sealed = false;
  private sealing = false;
  private truncated = false;
  private discardedEvents = 0;
  private discardedBytes = 0;
  private redactionCount = 0;

  constructor(
    private readonly store: HarnessTraceStore,
    private readonly input: HarnessTraceStartInput,
    readonly policy: HarnessTracePolicy,
    private readonly now: () => Date,
    private readonly createId: () => string,
  ) {
    this.traceId = createId();
    this.rootStreamId = createId();
    this.createdAt = now().toISOString();
    this.streamIds.add(this.rootStreamId);
    this.openStreams.add(this.rootStreamId);
    this.emitHost({
      type: "run.started",
      streamId: this.rootStreamId,
      data: {
        traceId: this.traceId,
        threadId: input.threadId,
        interactionNodeId: input.interactionNodeId,
        ...(input.productInteractionId === undefined ? {} : { productInteractionId: input.productInteractionId }),
        configurationName: input.configurationName,
      },
    });
    this.emitHost({
      type: "stream.started",
      streamId: this.rootStreamId,
      data: { name: "completion", kind: "agent" },
    });
  }

  emit(event: Omit<HarnessTraceEventInput, "streamId">): void {
    this.emitForStream(this.rootStreamId, event);
  }

  openStream(input: Parameters<HarnessTraceSink["openStream"]>[0]): HarnessTraceStream {
    this.assertWritable();
    const parentStreamId = input.parentStreamId ?? this.rootStreamId;
    if (!this.streamIds.has(parentStreamId)) throw new Error(`Trace stream parent does not exist: ${parentStreamId}`);
    const id = this.createId();
    this.streamIds.add(id);
    this.openStreams.add(id);
    this.emitHost({
      type: "stream.started",
      streamId: id,
      data: {
        name: input.name,
        kind: input.kind,
        parentStreamId,
        ...(input.providerStreamId === undefined ? {} : { providerStreamId: input.providerStreamId }),
      },
    });
    return this.stream(id);
  }

  openSpan(input: Parameters<HarnessTraceSink["openSpan"]>[0]): HarnessTraceSpan {
    return this.openSpanForStream(this.rootStreamId, input);
  }

  async attach(input: HarnessTraceAttachmentInput): Promise<TraceAttachmentRef> {
    this.assertWritable();
    if (input.native && !this.policy.includeNativeArtifacts) throw new Error("Native trace artifacts are disabled by policy");
    if (input.native && input.sanitized !== true) throw new Error("Native trace artifacts require an approved adapter sanitizer");
    if (input.name.trim() === "" || input.mediaType.trim() === "") throw new Error("Trace attachments require a name and media type");
    if (input.content instanceof Uint8Array && input.sanitized !== true) {
      throw new Error("Binary trace attachments require an approved adapter sanitizer");
    }
    let content = typeof input.content === "string" ? Buffer.from(input.content, "utf8") : Buffer.from(input.content);
    if (typeof input.content === "string") {
      const redacted = redactString(input.content);
      this.redactionCount += redacted.count;
      content = Buffer.from(redacted.value, "utf8");
    }
    if (this.byteLength + content.byteLength > this.policy.maxBytesPerTurn) {
      this.truncated = true;
      this.discardedBytes += content.byteLength;
      throw new Error(`Trace attachment exceeds the ${this.policy.maxBytesPerTurn}-byte turn limit`);
    }
    const attachment: BufferedAttachment = {
      id: this.createId(),
      name: basename(input.name),
      mediaType: input.mediaType,
      byteLength: content.byteLength,
      content,
      sensitivity: input.sensitivity,
      native: input.native === true,
    };
    this.byteLength += content.byteLength;
    this.attachments.push(attachment);
    return attachmentRef(attachment);
  }

  async seal(status: Exclude<HarnessTraceStatus, "disabled">, reason?: string): Promise<HarnessTraceDescriptor> {
    if (this.sealed || this.sealing) throw new Error("Candidate trace is already sealed");
    this.sealing = true;
    try {
      const terminalStatus: HarnessTraceTerminalStatus = status === "complete" ? "completed" : status === "failed" ? "failed" : "partial";
      for (const spanId of [...this.openSpans]) this.endSpan(spanId, terminalStatus, reason === undefined ? {} : { reason });
      for (const streamId of [...this.openStreams].filter((id) => id !== this.rootStreamId)) {
        this.closeStream(streamId, terminalStatus, reason === undefined ? {} : { reason });
      }
      if (this.truncated) {
        this.emitHost({
          type: "truncated",
          streamId: this.rootStreamId,
          data: { discardedEvents: this.discardedEvents, discardedBytes: this.discardedBytes },
        }, true);
      }
      this.closeStream(this.rootStreamId, terminalStatus, reason === undefined ? {} : { reason });
      this.emitHost({
        type: "run.completed",
        streamId: this.rootStreamId,
        data: { status, ...(reason === undefined ? {} : { reason }) },
      }, true);
      this.sealed = true;
      const eventsData = this.events.map((event) => JSON.stringify(event)).join("\n") + "\n";
      const eventsBytes = Buffer.from(eventsData, "utf8");
      const eventsSha = sha256(eventsBytes);
      const achievedCoverage = achievedTraceCoverage(this.input.support, status, this.truncated);
      const traceDirectory = join(resolve(this.storeDirectory()), this.traceId);
      const attachmentManifest: JsonObject[] = [];
      await mkdir(join(traceDirectory, "attachments"), { recursive: true, mode: 0o700 });
      await atomicWrite(join(traceDirectory, "events.jsonl"), eventsData);
      for (const attachment of this.attachments) {
        const suffix = safeAttachmentSuffix(attachment.name);
        const file = join("attachments", `${attachment.id}${suffix}`);
        await atomicWrite(join(traceDirectory, file), attachment.content);
        attachmentManifest.push({
          ...attachmentRef(attachment),
          ref: file,
          sha256: sha256(attachment.content),
          sensitivity: attachment.sensitivity,
          native: attachment.native,
        });
      }
      const descriptor: HarnessTraceDescriptor = {
        status,
        format: "relayer-harness-trace-v1",
        traceId: this.traceId,
        sha256: eventsSha,
        byteLength: eventsBytes.byteLength,
        eventCount: this.events.length,
        coverage: achievedCoverage,
        ...(this.truncated ? { truncated: true } : {}),
        ...(this.redactionCount > 0 ? { redactionCount: this.redactionCount } : {}),
        ...(reason === undefined ? {} : { error: reason }),
      };
      const manifest: JsonObject = {
        schemaVersion: 1,
        format: "relayer-harness-trace-v1",
        traceId: this.traceId,
        createdAt: this.createdAt,
        completedAt: this.now().toISOString(),
        status,
        terminalReason: reason ?? null,
        implementation: this.input.implementation,
        configurationName: this.input.configurationName,
        threadId: this.input.threadId,
        interactionNodeId: this.input.interactionNodeId,
        productInteractionId: this.input.productInteractionId ?? null,
        declaredCoverage: redactTraceData(this.input.support),
        achievedCoverage: redactTraceData(achievedCoverage),
        policy: redactTraceData(this.policy),
        redactionPolicyVersion: 1,
        redactionCount: this.redactionCount,
        truncation: this.truncated ? { discardedEvents: this.discardedEvents, discardedBytes: this.discardedBytes } : null,
        artifacts: {
          events: { ref: "events.jsonl", sha256: eventsSha, byteLength: eventsBytes.byteLength, eventCount: this.events.length },
          attachments: attachmentManifest,
        },
      };
      await atomicWrite(join(traceDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      this.store.record(this.input.productInteractionId, { directory: traceDirectory, descriptor, manifest });
      return descriptor;
    } finally {
      this.sealing = false;
    }
  }

  private storeDirectory(): string {
    return this.store.storageDirectory();
  }

  private stream(id: string): HarnessTraceStream {
    return {
      id,
      emit: (event) => this.emitForStream(id, event),
      openSpan: (input) => this.openSpanForStream(id, input),
      close: (status, data) => this.closeStream(id, status, data ?? {}),
    };
  }

  private emitForStream(streamId: string, event: Omit<HarnessTraceEventInput, "streamId">): void {
    this.assertWritable();
    if (!this.openStreams.has(streamId)) throw new Error(`Trace stream is not open: ${streamId}`);
    if (HOST_EVENT_TYPES.has(event.type)) throw new Error(`Trace event type ${event.type} is host-owned`);
    if (event.spanId !== undefined && this.spanStreams.get(event.spanId) !== streamId) {
      throw new Error(`Trace span does not belong to stream ${streamId}: ${event.spanId}`);
    }
    this.append({ ...event, streamId });
  }

  private openSpanForStream(streamId: string, input: Parameters<HarnessTraceSink["openSpan"]>[0]): HarnessTraceSpan {
    this.assertWritable();
    if (!this.openStreams.has(streamId)) throw new Error(`Trace stream is not open: ${streamId}`);
    if (input.parentSpanId !== undefined && this.spanStreams.get(input.parentSpanId) !== streamId) {
      throw new Error(`Trace span parent does not belong to stream ${streamId}: ${input.parentSpanId}`);
    }
    const id = this.createId();
    this.spanStreams.set(id, streamId);
    this.openSpans.add(id);
    this.emitHost({
      type: "span.started",
      streamId,
      spanId: id,
      ...(input.parentSpanId === undefined ? {} : { parentSpanId: input.parentSpanId }),
      data: {
        name: input.name,
        kind: input.kind,
        ...(input.providerSpanId === undefined ? {} : { providerSpanId: input.providerSpanId }),
      },
    });
    return {
      id,
      emit: (event) => this.emitForStream(streamId, { ...event, spanId: id }),
      end: (status, data) => this.endSpan(id, status, data ?? {}),
    };
  }

  private endSpan(spanId: string, status: HarnessTraceTerminalStatus, data: JsonObject): void {
    this.assertWritable();
    const streamId = this.spanStreams.get(spanId);
    if (streamId === undefined || !this.openSpans.has(spanId)) throw new Error(`Trace span is not open: ${spanId}`);
    this.openSpans.delete(spanId);
    this.emitHost({ type: "span.completed", streamId, spanId, data: { status, ...data } });
  }

  private closeStream(streamId: string, status: HarnessTraceTerminalStatus, data: JsonObject): void {
    this.assertWritable();
    if (!this.openStreams.has(streamId)) throw new Error(`Trace stream is not open: ${streamId}`);
    if ([...this.openSpans].some((spanId) => this.spanStreams.get(spanId) === streamId)) {
      throw new Error(`Trace stream ${streamId} still has open spans`);
    }
    if (streamId !== this.rootStreamId) {
      const openChild = this.events.some((event) => event.type === "stream.started" && event.data.parentStreamId === streamId && this.openStreams.has(event.streamId));
      if (openChild) throw new Error(`Trace stream ${streamId} still has open child streams`);
    }
    this.openStreams.delete(streamId);
    this.emitHost({ type: "stream.completed", streamId, data: { status, ...data } });
  }

  private emitHost(event: HarnessTraceEventInput & { readonly streamId: string }, force = false): void {
    this.append(event, force);
  }

  private append(event: HarnessTraceEventInput & { readonly streamId: string }, force = false): void {
    const redacted = redactJson(event.data);
    this.redactionCount += redacted.count;
    const envelope: HarnessTraceEvent = {
      schemaVersion: 1,
      sequence: this.sequence + 1,
      observedAt: this.now().toISOString(),
      type: event.type,
      streamId: event.streamId,
      implementation: this.input.implementation,
      data: redacted.value as JsonObject,
      ...(event.occurredAt === undefined ? {} : { occurredAt: event.occurredAt }),
      ...(event.providerEventId === undefined ? {} : { providerEventId: event.providerEventId }),
      ...(event.spanId === undefined ? {} : { spanId: event.spanId }),
      ...(event.parentSpanId === undefined ? {} : { parentSpanId: event.parentSpanId }),
    };
    const bytes = Buffer.byteLength(`${JSON.stringify(envelope)}\n`);
    if (force) {
      while (this.events.length > 0 && (this.events.length >= this.policy.maxEventsPerTurn || this.byteLength + bytes > this.policy.maxBytesPerTurn)) {
        const removed = this.events.pop()!;
        const removedBytes = Buffer.byteLength(`${JSON.stringify(removed)}\n`);
        this.byteLength -= removedBytes;
        this.discardedEvents += 1;
        this.discardedBytes += removedBytes;
        this.truncated = true;
      }
    }
    if (this.events.length >= this.policy.maxEventsPerTurn || this.byteLength + bytes > this.policy.maxBytesPerTurn) {
      this.truncated = true;
      this.discardedEvents += 1;
      this.discardedBytes += bytes;
      return;
    }
    this.sequence += 1;
    this.byteLength += bytes;
    this.events.push(envelope);
  }

  private assertWritable(): void {
    if (this.sealed) throw new Error("Candidate trace is sealed");
  }
}

export function createNoopHarnessTraceSink(policy: HarnessTracePolicy = NO_HARNESS_TRACE_POLICY): HarnessTraceSink {
  const stream = (id: string): HarnessTraceStream => ({
    id,
    emit: () => undefined,
    openSpan: () => span("noop-span"),
    close: () => undefined,
  });
  const span = (id: string): HarnessTraceSpan => ({ id, emit: () => undefined, end: () => undefined });
  return {
    policy,
    rootStreamId: "noop-root",
    emit: () => undefined,
    openStream: () => stream("noop-stream"),
    openSpan: () => span("noop-span"),
    attach: async (input) => ({
      id: "noop-attachment",
      name: basename(input.name),
      mediaType: input.mediaType,
      byteLength: typeof input.content === "string" ? Buffer.byteLength(input.content) : input.content.byteLength,
    }),
  };
}

export function validateTracePolicy(policy: HarnessTracePolicy): void {
  if (!["off", "best-effort", "required"].includes(policy.mode)) throw new Error(`Unsupported harness trace mode: ${policy.mode}`);
  if (!Number.isSafeInteger(policy.maxBytesPerTurn) || policy.maxBytesPerTurn < 1) throw new Error("Harness trace maxBytesPerTurn must be a positive integer");
  if (!Number.isSafeInteger(policy.maxEventsPerTurn) || policy.maxEventsPerTurn < 1) throw new Error("Harness trace maxEventsPerTurn must be a positive integer");
  for (const [feature, coverage] of Object.entries(policy.requiredFeatures)) {
    if (!(feature in NO_HARNESS_TRACE_SUPPORT) || !isCoverage(coverage)) throw new Error(`Invalid required harness trace feature: ${feature}`);
  }
}

export function validateTraceSupport(support: HarnessTraceSupport): void {
  for (const feature of Object.keys(NO_HARNESS_TRACE_SUPPORT) as (keyof HarnessTraceSupport)[]) {
    if (!isCoverage(support[feature])) throw new Error(`Invalid harness trace coverage for ${feature}`);
  }
}

export function validateRequiredCoverage(policy: HarnessTracePolicy, support: HarnessTraceSupport): void {
  if (policy.mode !== "required") return;
  const missing = Object.entries(policy.requiredFeatures).flatMap(([feature, required]) => {
    const actual = support[feature as keyof HarnessTraceSupport];
    return required !== undefined && coverageRank[actual] < coverageRank[required] ? [`${feature} requires ${required}; harness provides ${actual}`] : [];
  });
  if (missing.length > 0) throw new Error(`Harness trace requirements are unsupported before inference: ${missing.join("; ")}`);
}

export function redactTraceData(value: unknown): JsonValue {
  return redactJson(value).value;
}

function disabledTrace(policy: HarnessTracePolicy): ActiveHarnessTrace {
  return {
    sink: createNoopHarnessTraceSink(policy),
    seal: async () => ({ status: "disabled", format: "relayer-harness-trace-v1", coverage: NO_HARNESS_TRACE_SUPPORT }),
  };
}

function achievedTraceCoverage(support: HarnessTraceSupport, status: Exclude<HarnessTraceStatus, "disabled">, truncated: boolean): HarnessTraceSupport {
  if (status === "complete" && !truncated) return support;
  return Object.fromEntries(Object.entries(support).map(([feature, coverage]) => [
    feature,
    coverage === "full" ? "summary" : coverage === "summary" && status === "failed" ? "none" : coverage,
  ])) as unknown as HarnessTraceSupport;
}

function isCoverage(value: unknown): value is TraceCoverage {
  return value === "none" || value === "summary" || value === "full";
}

function attachmentRef(attachment: BufferedAttachment): TraceAttachmentRef {
  return { id: attachment.id, name: attachment.name, mediaType: attachment.mediaType, byteLength: attachment.byteLength };
}

function safeAttachmentSuffix(name: string): string {
  const suffix = extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(suffix) ? suffix : "";
}

function redactJson(value: unknown, key?: string): { readonly value: JsonValue; readonly count: number } {
  if (key !== undefined && SENSITIVE_KEYS.test(key)) return { value: "[redacted]", count: 1 };
  if (value === null || typeof value === "boolean" || typeof value === "number") return { value, count: 0 };
  if (typeof value === "string") return redactString(value);
  if (typeof value === "bigint") return { value: value.toString(), count: 0 };
  if (value instanceof Uint8Array) return { value: `[binary ${value.byteLength} bytes omitted]`, count: 1 };
  if (Array.isArray(value)) {
    let count = 0;
    const entries = value.map((entry) => {
      const redacted = redactJson(entry);
      count += redacted.count;
      return redacted.value;
    });
    return { value: entries, count };
  }
  if (typeof value === "object" && value !== null) {
    let count = 0;
    const entries: Record<string, JsonValue> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (entryValue === undefined || typeof entryValue === "function" || typeof entryValue === "symbol") continue;
      const redacted = redactJson(entryValue, entryKey);
      count += redacted.count;
      entries[entryKey] = redacted.value;
    }
    return { value: entries, count };
  }
  return { value: String(value), count: 0 };
}

function redactString(input: string): { readonly value: string; readonly count: number } {
  let value = input;
  let count = 0;
  const replace = (pattern: RegExp, replacement: string) => {
    value = value.replace(pattern, () => {
      count += 1;
      return replacement;
    });
  };
  replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]");
  replace(/\b(?:RELAYER_GRAPH_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|LANGFUSE_SECRET_KEY)\s*=\s*[^\s'\"`]+/gi, "credential=[redacted]");
  replace(/\b(?:sizeJustification|size_justification)\s*(?::|=)\s*[\"'][^\"']*[\"']/gi, "sizeJustification=[private rationale omitted]");
  replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted-api-key]");
  if (value.length > MAX_STRING_LENGTH) {
    value = `${value.slice(0, MAX_STRING_LENGTH)}\n[content truncated]`;
    count += 1;
  }
  return { value, count };
}

async function atomicWrite(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function sha256(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
