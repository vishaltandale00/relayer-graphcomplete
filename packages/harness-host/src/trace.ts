import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { isAlias, isMap, isNode, isScalar, isSeq, parseAllDocuments, parseDocument, Scalar } from "yaml";
import type { Node } from "yaml";
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
const ACCOUNT_VALUE_KEYS = /^(?:credits|balance|rate[_-]?limits)$/i;
const ACCOUNT_CONTEXT_KEYS = /^__relayer_provider_account_metadata__$/;
const IDENTITY_VALUE_KEYS = /^(?:id|name|(?:owner[_-]?)?(?:email|e-mail)|(?:account|organization|org|tenant|profile|team|workspace|login|session)[_-]?(?:id|name)|login|subject|sub|principal|handle|phone[_-]?(?:number)?|avatar[_-]?(?:url)?|picture|domain|display[_-]?name|(?:server|machine|host|installation|device|environment|hardware)[_-]?(?:id|name)|user[_-]?(?:id|name)|ip[_-]?address|mac[_-]?address|serial[_-]?(?:number|id))$/i;
const IDENTITY_CONTEXT_KEYS = /^__relayer_provider_(?:machine|account)_metadata__$/;
const MAX_STRING_LENGTH = 128_000;
const MAX_YAML_DOCUMENTS = 32;
const MAX_YAML_NODES = 20_000;
const MAX_YAML_KEY_ALIASES = 64;
const MAX_YAML_FALLBACK_KEY_LENGTH = 1_024;
const MAX_SHELL_WORD_LENGTH = 16_384;
const SHELL_OPTION_PREFIX = String.raw`(?:(?:--|[-+][A-Za-z]+)[ \t]+)*`;
const SHELL_DECLARATION_PREFIX = String.raw`(?:(?:builtin|command)[ \t]+${SHELL_OPTION_PREFIX})?(?:declare|typeset|export|readonly|local)[ \t]+${SHELL_OPTION_PREFIX}`;
const SHELL_ENV_OPTION_ARGUMENT = String.raw`(?:[^ \t'"\\;|&()$\x60]+|\\.|'[^'\r\n]*'|"(?:\\.|[^"\\$\x60\r\n])*")+`;
const SHELL_ENV_OPTION_PREFIX = String.raw`(?:(?:(?:--|-|-[i0v]+)[ \t]+)|(?:-[i0v]*[uPSC]${SHELL_ENV_OPTION_ARGUMENT}[ \t]+)|(?:-[i0v]*[uPSC][ \t]+${SHELL_ENV_OPTION_ARGUMENT}[ \t]+)|(?:(?:--unset|--chdir|--split-string)[ \t]+${SHELL_ENV_OPTION_ARGUMENT}[ \t]+)|(?:(?:--unset|--chdir|--split-string)=${SHELL_ENV_OPTION_ARGUMENT}[ \t]+))*`;
const SHELL_ENV_COMMAND = String.raw`(?:command[ \t]+${SHELL_OPTION_PREFIX})?(?:env|/usr/bin/env|/bin/env)`;
const SHELL_ENV_PREFIX = String.raw`${SHELL_ENV_COMMAND}[ \t]+${SHELL_ENV_OPTION_PREFIX}`;
const SHELL_EXEC_PREFIX = String.raw`exec[ \t]+(?:(?:(?:--|-[cl]+)[ \t]+)|(?:-[cl]*a${SHELL_ENV_OPTION_ARGUMENT}[ \t]+)|(?:-[cl]*a[ \t]+${SHELL_ENV_OPTION_ARGUMENT}[ \t]+))*`;
// Supported env-wrapper contract: shell time/noglob/nocorrect, exec, coproc,
// nohup, nice, external time, and macOS caffeinate. Other wrappers are not
// inferred as env authority without an explicit grammar here.
const SHELL_NICE_PREFIX = String.raw`(?:nice|/usr/bin/nice|/bin/nice)[ \t]+(?:(?:(?:--|-n[+-]?[0-9]+|-[+-]?[0-9]+)[ \t]+)|(?:-n[ \t]+${SHELL_ENV_OPTION_ARGUMENT}[ \t]+))*`;
const SHELL_EXTERNAL_TIME_PREFIX = String.raw`(?:/usr/bin/time|/bin/time)[ \t]+(?:(?:(?:--|-[alhp]+)[ \t]+)|(?:-a?o${SHELL_ENV_OPTION_ARGUMENT}[ \t]+)|(?:-o[ \t]+${SHELL_ENV_OPTION_ARGUMENT}[ \t]+))*`;
const SHELL_CAFFEINATE_PREFIX = String.raw`(?:caffeinate|/usr/bin/caffeinate)[ \t]+(?:(?:-[dimsu]+[ \t]+)|(?:-[dimsu]*[tw](?:[+-]?[0-9]+|\$\$)[ \t]+)|(?:-[tw][ \t]+${SHELL_ENV_OPTION_ARGUMENT}[ \t]+))*`;
const SHELL_PRECOMMAND_PREFIX = String.raw`(?:(?:time(?:[ \t]+-p)?[ \t]+)|(?:(?:noglob|nocorrect)[ \t]+${SHELL_OPTION_PREFIX})|(?:(?:nohup|/usr/bin/nohup|/bin/nohup)[ \t]+(?:--[ \t]+)?)|(?:coproc[ \t]+)|(?:${SHELL_EXEC_PREFIX})|(?:${SHELL_NICE_PREFIX})|(?:${SHELL_EXTERNAL_TIME_PREFIX})|(?:${SHELL_CAFFEINATE_PREFIX}))*`;
const SHELL_ASSIGNMENT_COMMAND_PREFIX = String.raw`${SHELL_PRECOMMAND_PREFIX}(?:${SHELL_DECLARATION_PREFIX}|${SHELL_ENV_PREFIX})`;
const SHELL_COMMAND_BOUNDARY = String.raw`(?:^|[;\n]|&&|\|\||[(){}|!&]|\b(?:if|while|until|then|do|else|elif)\b)`;
const SHELL_LINE_START_PREFIX = new RegExp(`^[ \\t]*(?:${SHELL_ASSIGNMENT_COMMAND_PREFIX})?$`);
const SHELL_QUOTED_DECLARATION_PREFIX = new RegExp(`${SHELL_COMMAND_BOUNDARY}[ \\t]*${SHELL_ASSIGNMENT_COMMAND_PREFIX}(['"])$`);
const SHELL_AMBIGUOUS_ENV_COMMAND = new RegExp(`${SHELL_COMMAND_BOUNDARY}[ \\t]*${SHELL_PRECOMMAND_PREFIX}${SHELL_ENV_COMMAND}[ \\t]+`, "g");
const SHELL_AMBIGUOUS_SUPPORTED_WRAPPER_ENV = new RegExp(`${SHELL_COMMAND_BOUNDARY}[ \\t]*(?:exec|nice|/usr/bin/nice|/bin/nice|/usr/bin/time|/bin/time|caffeinate|/usr/bin/caffeinate)[ \\t]+-[^;\\n]*[ \\t]+${SHELL_ENV_COMMAND}[ \\t]+`, "g");
const LOCAL_USERNAME = basename(homedir());
const ESCAPED_LOCAL_USERNAME = LOCAL_USERNAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const LOCAL_HOME = resolve(homedir());
const ESCAPED_LOCAL_HOME = LOCAL_HOME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const REDACTED_LOCAL_HOME = join(dirname(LOCAL_HOME), "[redacted]");
const LOCAL_HOSTNAME = hostname();
const ESCAPED_LOCAL_HOSTNAME = LOCAL_HOSTNAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const LOCAL_FILE_OWNER_PATTERN = LOCAL_USERNAME.length > 1
  ? new RegExp(`(^|\\n)([bcdlps-][rwxStTs-]{9}[+@.]?\\s+\\d+\\s+)${ESCAPED_LOCAL_USERNAME}(?=\\s+)`, "g")
  : undefined;
const LOCAL_LOGIN_LINE_PATTERN = LOCAL_USERNAME.length > 1
  ? new RegExp(`(^|\\n)${ESCAPED_LOCAL_USERNAME}(?=\\r?(?:\\n|$))`, "g")
  : undefined;
const LOCAL_IDENTITY_OUTPUT_PATTERN = LOCAL_USERNAME.length > 1
  ? new RegExp(`\\b((?:e?uid)=\\d+\\()${ESCAPED_LOCAL_USERNAME}(?=\\))`, "gi")
  : undefined;
const LOCAL_SHELL_IDENTITY_PATTERN = LOCAL_USERNAME.length > 1
  ? new RegExp(`\\b${ESCAPED_LOCAL_USERNAME}(?=@[A-Za-z0-9._-]+)`, "g")
  : undefined;
const LOCAL_SHELL_HOSTNAME_PATTERN = LOCAL_HOSTNAME.length > 1
  ? new RegExp(`(?<=@)${ESCAPED_LOCAL_HOSTNAME}(?![A-Za-z0-9._-])`, "gi")
  : undefined;
const LOCAL_HOSTNAME_LINE_PATTERN = LOCAL_HOSTNAME.length > 1
  ? new RegExp(`(^|\\n)${ESCAPED_LOCAL_HOSTNAME}(?=\\r?(?:\\n|$))`, "gi")
  : undefined;
const LOCAL_HOME_PATTERN = LOCAL_HOME !== "/"
  ? new RegExp(`(?<![A-Za-z0-9._-])${ESCAPED_LOCAL_HOME}(?=[\\\\/\\s'\"\u0060]|$)`, "g")
  : undefined;

export class HarnessTraceStore {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly tracesByProductInteraction = new Map<number, StoredTrace>();
  private readonly startupCleanup: Promise<Error | undefined>;
  private readonly storageOperations = new Set<Promise<void>>();
  private closed = false;
  private forced = false;
  private closePromise: Promise<void> | undefined;
  private forceClosePromise: Promise<void> | undefined;

  constructor(private readonly options: HarnessTraceStoreOptions) {
    validateTracePolicy(options.policy);
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.startupCleanup = this.cleanupAbandonedSpool().then(
      () => undefined,
      (error) => error instanceof Error ? error : new Error(String(error)),
    );
  }

  start(input: HarnessTraceStartInput): ActiveHarnessTrace {
    if (this.closed) throw new Error("Harness trace store is closed");
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
    // Export is an explicit post-run handoff and remains available after the
    // execution host has closed, but it still participates in the IO fence.
    return this.runStorageOperation(async () => {
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
      try {
        await rm(stored.directory, { recursive: true, force: true });
      } catch (error) {
        await rm(target, { recursive: true, force: true });
        throw error;
      }
      this.tracesByProductInteraction.delete(productInteractionId);
      return stored.descriptor;
    }, true);
  }

  record(productInteractionId: number | undefined, stored: StoredTrace): void {
    if (productInteractionId === undefined) return;
    this.tracesByProductInteraction.set(productInteractionId, stored);
  }

  async prepareStorage(): Promise<void> {
    await this.ready();
    if (this.closed) throw new Error("Harness trace store is closed");
  }

  async ready(): Promise<void> {
    const cleanupError = await this.startupCleanup;
    if (cleanupError !== undefined) throw cleanupError;
  }

  close(): Promise<void> {
    this.closed = true;
    if (this.closePromise === undefined) this.closePromise = this.drainStorage();
    return this.closePromise;
  }

  private async drainStorage(): Promise<void> {
    await this.ready();
    await Promise.all([...this.storageOperations]);
  }

  forceClose(): Promise<void> {
    this.forced = true;
    this.closed = true;
    if (this.forceClosePromise === undefined) this.forceClosePromise = this.drainStorage();
    return this.forceClosePromise;
  }

  async runStorageOperation<T>(operation: () => Promise<T>, allowAfterClose = false): Promise<T> {
    let release!: () => void;
    const fence = new Promise<void>((resolveFence) => { release = resolveFence; });
    this.storageOperations.add(fence);
    try {
      await this.ready();
      if (this.closed && (!allowAfterClose || this.forced)) throw new Error("Harness trace store is closed");
      return await operation();
    } finally {
      release();
      this.storageOperations.delete(fence);
    }
  }

  private async cleanupAbandonedSpool(): Promise<void> {
    const root = resolve(this.options.directory);
    await validateSpoolAncestorChain(root);
    await mkdir(dirname(root), { recursive: true, mode: 0o700 });
    const parent = await spoolPathIdentity(dirname(root));
    await assertSpoolParentIdentity(root, parent);
    let original: Awaited<ReturnType<typeof validateSpoolDirectory>>;
    try {
      await assertSpoolParentIdentity(root, parent);
      await mkdir(root, { mode: 0o700 });
      await validateSpoolDirectory(root);
      await assertSpoolParentIdentity(root, parent);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      original = await validateSpoolDirectory(root);
    }

    const quarantine = `${root}.cleanup-${randomUUID()}`;
    await assertSpoolParentIdentity(root, parent);
    await rename(root, quarantine);
    await assertSpoolParentIdentity(root, parent);
    const moved = await validateSpoolDirectory(quarantine);
    if (moved.device !== original.device
      || moved.inode !== original.inode
      || dirname(moved.realPath) !== dirname(original.realPath)) {
      throw new Error(`Harness trace spool identity changed during startup cleanup: ${root}`);
    }
    await assertSpoolParentIdentity(root, parent);
    await mkdir(root, { mode: 0o700 });
    const fresh = await validateSpoolDirectory(root);
    if (dirname(fresh.realPath) !== dirname(original.realPath)) {
      throw new Error(`Harness trace spool parent identity changed during startup cleanup: ${root}`);
    }
    // Removing the atomically detached directory never follows entry symlinks;
    // a concurrent replacement of the quarantine path is removed as a link.
    await assertSpoolParentIdentity(root, parent);
    await rm(quarantine, { recursive: true, force: true });
  }
}

interface SpoolPathIdentity {
  readonly device: number;
  readonly inode: number;
  readonly realPath: string;
}

async function validateSpoolAncestorChain(root: string): Promise<void> {
  const ancestors: string[] = [];
  for (let path = dirname(root);;) {
    ancestors.push(path);
    const parent = dirname(path);
    if (parent === path) break;
    path = parent;
  }
  for (const path of ancestors.reverse()) {
    let details;
    try {
      details = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (details.isSymbolicLink()) {
      const parentDetails = await lstat(dirname(path));
      const trustedSystemAlias = process.platform !== "win32"
        && details.uid === 0
        && parentDetails.uid === 0
        && (parentDetails.mode & 0o022) === 0;
      if (!trustedSystemAlias || !(await stat(path)).isDirectory()) {
        throw new Error(`Harness trace spool ancestor must not be a symbolic link: ${path}`);
      }
      continue;
    }
    if (!details.isDirectory()) {
      throw new Error(`Harness trace spool ancestor must be a directory: ${path}`);
    }
  }
}

async function spoolPathIdentity(path: string): Promise<SpoolPathIdentity> {
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`Harness trace spool parent must be a real directory: ${path}`);
  }
  return { device: details.dev, inode: details.ino, realPath: await realpath(path) };
}

async function assertSpoolParentIdentity(root: string, expected: SpoolPathIdentity): Promise<void> {
  await validateSpoolAncestorChain(root);
  const observed = await spoolPathIdentity(dirname(root));
  if (observed.device !== expected.device
    || observed.inode !== expected.inode
    || observed.realPath !== expected.realPath) {
    throw new Error(`Harness trace spool parent identity changed during startup cleanup: ${root}`);
  }
}

async function validateSpoolDirectory(path: string): Promise<{
  readonly device: number;
  readonly inode: number;
  readonly realPath: string;
}> {
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`Harness trace spool must be a real directory: ${path}`);
  }
  if (process.platform !== "win32") {
    const currentUid = process.getuid?.();
    if (currentUid !== undefined && details.uid !== currentUid) {
      throw new Error(`Harness trace spool must be owned by the current user: ${path}`);
    }
    if ((details.mode & 0o777) !== 0o700) {
      throw new Error(`Harness trace spool permissions must be 0700: ${path}`);
    }
  }
  return { device: details.dev, inode: details.ino, realPath: await realpath(path) };
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
      return this.store.runStorageOperation(async () => {
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
      });
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
    const redacted = redactJson(event.data, undefined, providerEventRedactionContext(event));
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

function providerEventRedactionContext(event: HarnessTraceEventInput): readonly string[] {
  if (event.type !== "provider.event") return [];
  const method = typeof event.data.method === "string" ? event.data.method : undefined;
  if (method !== undefined && /^(?:remoteControl|machine|device|host|installation|environment)(?:\/|$)/i.test(method)) {
    return ["__relayer_provider_machine_metadata__"];
  }
  if (method !== undefined && /^account\//i.test(method)) {
    return ["__relayer_provider_account_metadata__"];
  }
  return [];
}

function isCredentialName(name: string): boolean {
  const normalized = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase();
  const parts = normalized.split("_").filter(Boolean);
  const tokenAccounting = parts.some((part) => part === "token" || part === "tokens")
    && parts.some((part) => ["usage", "count", "limit", "input", "output", "total", "cached", "reasoning", "billed"].includes(part))
    && !parts.some((part) => ["access", "refresh", "auth", "bearer", "secret", "api"].includes(part));
  if (tokenAccounting) return false;
  if (parts.some((part) => ["auth", "token", "secret", "password", "passwd", "passphrase", "passphrases", "authorization", "cookie", "credential"].includes(part))) {
    return true;
  }
  const keyQualifiers = new Set(["api", "private", "signing", "access", "secret", "encryption", "ssh"]);
  return parts.includes("key") && parts.some((part) => keyQualifiers.has(part));
}

function decodedQuotedKey(token: string): string | undefined {
  if (token.length > MAX_YAML_FALLBACK_KEY_LENGTH) return undefined;
  try {
    const document = parseDocument(token, { prettyErrors: false, strict: true });
    return document.errors.length === 0 && isScalar(document.contents) && typeof document.contents.value === "string"
      ? document.contents.value
      : undefined;
  } catch {
    return undefined;
  }
}

function scanStructuredCredentialKeys(input: string): { readonly credential: boolean; readonly mustOmit: boolean } {
  let credential = false;
  let mustOmit = false;
  const inspect = (token: string) => {
    const quoted = token.startsWith('"') || token.startsWith("'");
    const name = quoted ? decodedQuotedKey(token) : token;
    if (name === undefined) {
      if (quoted) mustOmit = true;
      return;
    }
    if (!isCredentialName(name)) return;
    credential = true;
    if (token.startsWith("'") && !/^'[A-Za-z_][A-Za-z0-9_-]*'$/.test(token)) mustOmit = true;
  };
  const candidate = /(?:^|[\n\r\[\]{},])[ \t]*(?:(?:-[ \t]+)*\?[ \t]+)?(?:(?:!<[^>\r\n]{1,512}>|![^\s,\[\]{}]+|&[A-Za-z0-9_-]+)[ \t]+)*("(?:\\.|[^"\\\r\n])*"|'(?:''|[^'\r\n])*'|[A-Za-z_][A-Za-z0-9_-]*)[ \t]*:/gm;
  for (const match of input.matchAll(candidate)) {
    const token = match[1];
    if (token === undefined) continue;
    inspect(token);
  }
  const explicit = /(?:^|\n)[ \t]*(?:-[ \t]+)*\?[ \t]+(?:(?:!<[^>\r\n]{1,512}>|![^\s,\[\]{}]+|&[A-Za-z0-9_-]+)[ \t]+)*("(?:\\.|[^"\\\r\n])*"|'(?:''|[^'\r\n])*'|[A-Za-z_][A-Za-z0-9_-]*)(?:[ \t]+#[^\r\n]*)?[ \t]*(?:\r?\n|\r)[ \t]*:/gm;
  for (const match of input.matchAll(explicit)) {
    const token = match[1];
    if (token === undefined) continue;
    inspect(token);
  }
  return { credential, mustOmit };
}

function looksLikeYamlCollectionStream(input: string): boolean {
  let yamlPreamble = false;
  for (const line of input.split(/\r?\n|\r/)) {
    const trimmed = line.trimStart();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("%") || /^(?:---|\.\.\.)(?:[ \t]*(?:#.*)?)?$/.test(trimmed)) {
      yamlPreamble = true;
      continue;
    }
    const withoutProperties = trimmed.replace(/^(?:(?:!<[^>\r\n]{1,512}>|![^\s,\[\]{}]+|&[A-Za-z0-9_-]+)[ \t]+)*/, "");
    return yamlPreamble || /^(?:[\[{?-]|"(?:\\.|[^"\\])*"[ \t]*:|'(?:''|[^'])*'[ \t]*:|[A-Za-z_][A-Za-z0-9_-]*[ \t]*:)/.test(withoutProperties);
  }
  return yamlPreamble;
}

function redactStructuredYaml(input: string): { readonly value: string; readonly count: number } | undefined {
  const fallbackScan = scanStructuredCredentialKeys(input);
  if (input.length > MAX_STRING_LENGTH) {
    return fallbackScan.credential || fallbackScan.mustOmit
      ? { value: "[structured content omitted]", count: 1 }
      : undefined;
  }
  if (!looksLikeYamlCollectionStream(input)) {
    return fallbackScan.mustOmit ? { value: "[structured content omitted]", count: 1 } : undefined;
  }
  let containsCredential = false;
  try {
    const documents = parseAllDocuments(input, { prettyErrors: false, strict: true });
    if (documents.length === 0) return undefined;
    if (documents.length > MAX_YAML_DOCUMENTS) return { value: "[structured content omitted]", count: 1 };
    const sensitivePairs: Array<{ value: unknown | null }> = [];
    let credentialInCollectionKey = false;
    let nodeCount = 0;
    let aliasCount = 0;
    for (const document of documents) {
      if (!isMap(document.contents) && !isSeq(document.contents)) continue;
      const pending: Array<{ readonly node: Node; readonly insideKey: boolean }> = [{ node: document.contents, insideKey: false }];
      while (pending.length > 0) {
        const { node, insideKey } = pending.pop()!;
        nodeCount += 1;
        if (nodeCount > MAX_YAML_NODES) return { value: "[structured content omitted]", count: 1 };
        if (insideKey && isScalar(node) && typeof node.value === "string" && isCredentialName(node.value)) {
          containsCredential = true;
          credentialInCollectionKey = true;
        }
        if (insideKey && isAlias(node)) {
          aliasCount += 1;
          if (aliasCount > MAX_YAML_KEY_ALIASES) return { value: "[structured content omitted]", count: 1 };
          const resolved = node.resolve(document);
          if (resolved !== undefined) pending.push({ node: resolved, insideKey: true });
          continue;
        }
        if (isMap(node)) {
          nodeCount += node.items.length * 2;
          if (nodeCount > MAX_YAML_NODES) return { value: "[structured content omitted]", count: 1 };
          for (const pair of node.items) {
            let key: unknown = pair.key;
            if (isAlias(key)) {
              aliasCount += 1;
              if (aliasCount > MAX_YAML_KEY_ALIASES) return { value: "[structured content omitted]", count: 1 };
              key = key.resolve(document);
            }
            if (isScalar(key) && typeof key.value === "string" && isCredentialName(key.value)) {
              containsCredential = true;
              if (insideKey) {
                credentialInCollectionKey = true;
              } else {
                sensitivePairs.push(pair);
              }
            }
            if (isNode(key) && (isMap(key) || isSeq(key))) pending.push({ node: key, insideKey: true });
            if (isNode(pair.value) && (insideKey || isMap(pair.value) || isSeq(pair.value))) {
              pending.push({ node: pair.value, insideKey });
            }
          }
        } else if (isSeq(node)) {
          nodeCount += node.items.length;
          if (nodeCount > MAX_YAML_NODES) return { value: "[structured content omitted]", count: 1 };
          for (const item of node.items) {
            if (isNode(item) && (insideKey || isMap(item) || isSeq(item))) pending.push({ node: item, insideKey });
          }
        }
      }
    }
    if (credentialInCollectionKey) return { value: "[structured content omitted]", count: 1 };
    for (const pair of sensitivePairs) {
      if (!isNode(pair.value)) continue;
      const pending: Node[] = [pair.value];
      while (pending.length > 0) {
        const node = pending.pop()!;
        nodeCount += 1;
        if (nodeCount > MAX_YAML_NODES) return { value: "[structured content omitted]", count: 1 };
        if (isAlias(node)) {
          aliasCount += 1;
          return { value: "[structured content omitted]", count: 1 };
        }
        if (isMap(node)) {
          nodeCount += node.items.length * 2;
          if (nodeCount > MAX_YAML_NODES) return { value: "[structured content omitted]", count: 1 };
          for (const item of node.items) {
            if (isNode(item.key)) pending.push(item.key);
            if (isNode(item.value)) pending.push(item.value);
          }
        } else if (isSeq(node)) {
          nodeCount += node.items.length;
          if (nodeCount > MAX_YAML_NODES) return { value: "[structured content omitted]", count: 1 };
          for (const item of node.items) if (isNode(item)) pending.push(item);
        }
      }
    }
    if (documents.some((document) => document.errors.length > 0)) {
      return containsCredential || fallbackScan.mustOmit ? { value: "[structured content omitted]", count: 1 } : undefined;
    }
    let count = 0;
    for (const pair of sensitivePairs) {
      if (isScalar(pair.value) && pair.value.value === "[redacted]") continue;
      const replacement = new Scalar("[redacted]");
      replacement.type = Scalar.QUOTE_DOUBLE;
      if (isNode(pair.value)) {
        if (pair.value.comment !== undefined) replacement.comment = pair.value.comment;
        if (pair.value.commentBefore !== undefined) replacement.commentBefore = pair.value.commentBefore;
        if (pair.value.spaceBefore !== undefined) replacement.spaceBefore = pair.value.spaceBefore;
        if ("anchor" in pair.value && typeof pair.value.anchor === "string") replacement.anchor = pair.value.anchor;
      }
      pair.value = replacement;
      count += 1;
    }
    if (count === 0) return sensitivePairs.length === 0 ? undefined : { value: input, count: 0 };
    return { value: documents.map((document) => document.toString()).join(""), count };
  } catch {
    return containsCredential ? { value: "[structured content omitted]", count: 1 } : undefined;
  }
}

function shellWordEnd(input: string, start: number): number {
  const isSeparator = (character: string): boolean => character === " " || character === "\t" || character === "\n";
  let index = start;
  let quote: "'" | '"' | undefined;
  let quoteEscapes = false;
  while (index < input.length) {
    const character = input[index]!;
    if (index - start >= MAX_SHELL_WORD_LENGTH) {
      return quote === undefined && (isSeparator(character) || /[;|&<>()]/.test(character)) ? index : input.length;
    }
    if (quote !== undefined) {
      if (quoteEscapes && character === "\\") {
        index = Math.min(input.length, index + 2);
      } else if (quote === '"' && ((character === "$" && ["(", "{", "["].includes(input[index + 1] ?? ""))
        || character === "`")) {
        return input.length;
      } else if (character === quote) {
        quote = undefined;
        quoteEscapes = false;
        index += 1;
      } else {
        index += 1;
      }
      continue;
    }
    if (character === "\\") {
      index = Math.min(input.length, index + 2);
      continue;
    }
    if (character === "$" && input[index + 1] === "'") {
      quote = "'";
      quoteEscapes = true;
      index += 2;
      continue;
    }
    if ((character === "$" && ["(", "{", "["].includes(input[index + 1] ?? ""))
      || ((character === "<" || character === ">") && ["(", character].includes(input[index + 1] ?? ""))
      || character === "`"
      || character === "(") return input.length;
    if (character === "'" || character === '"') {
      quote = character;
      quoteEscapes = character !== "'";
      index += 1;
      continue;
    }
    if (isSeparator(character) || /[;|&<>()]/.test(character)) break;
    index += 1;
  }
  return quote === undefined ? index : input.length;
}

function shellSubscriptEnd(input: string, start: number): number | undefined {
  let index = start;
  let depth = 0;
  let quote: "'" | '"' | undefined;
  let quoteEscapes = false;
  while (index < input.length && index - start < MAX_SHELL_WORD_LENGTH) {
    const character = input[index]!;
    if (quote !== undefined) {
      if (quoteEscapes && character === "\\") {
        index = Math.min(input.length, index + 2);
      } else if (quote === '"' && ((character === "$" && ["(", "{", "["].includes(input[index + 1] ?? ""))
        || character === "`")) {
        return undefined;
      } else if (character === quote) {
        quote = undefined;
        quoteEscapes = false;
        index += 1;
      } else {
        index += 1;
      }
      continue;
    }
    if (character === "\\") {
      index = Math.min(input.length, index + 2);
      continue;
    }
    if (character === "$" && input[index + 1] === "'") {
      quote = "'";
      quoteEscapes = true;
      index += 2;
      continue;
    }
    if ((character === "$" && ["(", "{", "["].includes(input[index + 1] ?? "")) || character === "`") {
      return undefined;
    }
    if (character === "'" || character === '"') {
      quote = character;
      quoteEscapes = character !== "'";
      index += 1;
      continue;
    }
    if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return undefined;
}

function hasBoundedComplexSubscriptAssignment(input: string, start: number, closingQuote?: "'" | '"'): boolean {
  const end = Math.min(input.length, start + MAX_SHELL_WORD_LENGTH);
  for (let index = start + 1; index < end; index += 1) {
    if (input[index] !== "]") continue;
    const operatorStart = closingQuote === undefined ? index + 1 : index + 2;
    if (closingQuote !== undefined && input[index + 1] !== closingQuote) continue;
    if (input[operatorStart] === "=" || input.slice(operatorStart, operatorStart + 2) === "+=") return true;
  }
  return false;
}

function declarationQuoteBefore(input: string, matchIndex: number): "'" | '"' | undefined {
  const prefix = input.slice(Math.max(0, matchIndex - 1_024), matchIndex);
  const match = SHELL_QUOTED_DECLARATION_PREFIX.exec(prefix);
  return match?.[1] as "'" | '"' | undefined;
}

interface BoundedShellWord {
  readonly raw: string;
  readonly value: string | undefined;
}

function simpleShellWordValue(raw: string): string | undefined {
  let value = "";
  let index = 0;
  while (index < raw.length) {
    const character = raw[index];
    if (character === "\\") {
      if (index + 1 >= raw.length) return undefined;
      if (raw[index + 1] !== "\n") value += raw[index + 1];
      index += 2;
      continue;
    }
    if (character === "'") {
      const closing = raw.indexOf("'", index + 1);
      if (closing === -1) return undefined;
      value += raw.slice(index + 1, closing);
      index = closing + 1;
      continue;
    }
    if (character === '"') {
      index += 1;
      while (index < raw.length && raw[index] !== '"') {
        if (raw[index] === "$" || raw[index] === "`") return undefined;
        if (raw[index] === "\\") {
          if (index + 1 >= raw.length) return undefined;
          const escaped = raw[index + 1];
          if (escaped === "$" || escaped === "`" || escaped === '"' || escaped === "\\") value += escaped;
          else if (escaped !== "\n") value += `\\${escaped}`;
          index += 2;
        } else {
          value += raw[index];
          index += 1;
        }
      }
      if (raw[index] !== '"') return undefined;
      index += 1;
      continue;
    }
    if (character === "$" || character === "`") return undefined;
    value += character;
    index += 1;
  }
  return value;
}

function isShellParenExpansionStart(input: string, index: number): boolean {
  return input[index + 1] === "(" && (input[index] === "$" || input[index] === "<" || input[index] === ">");
}

function boundedShellWords(input: string): readonly BoundedShellWord[] | undefined {
  const words: BoundedShellWord[] = [];
  let index = 0;
  while (index < input.length) {
    while (input[index] === " " || input[index] === "\t") index += 1;
    if (index === input.length) break;
    const start = index;
    const contexts: Array<{ readonly kind: "single" | "double" | "backtick" } | { readonly kind: "command"; depth: number }> = [];
    while (index < input.length) {
      const character = input[index];
      const context = contexts.at(-1);
      if (context?.kind === "single") {
        if (character === "'") contexts.pop();
        index += 1;
        continue;
      }
      if (character === "\\") {
        index += Math.min(2, input.length - index);
        continue;
      }
      if (context?.kind === "backtick") {
        if (character === "`") contexts.pop();
        index += 1;
        continue;
      }
      if (context?.kind === "double") {
        if (character === '"') {
          contexts.pop();
          index += 1;
          continue;
        }
        if (isShellParenExpansionStart(input, index)) {
          contexts.push({ kind: "command", depth: 1 });
          index += 2;
          continue;
        }
        if (character === "`") contexts.push({ kind: "backtick" });
        index += 1;
        continue;
      }
      if (context?.kind === "command") {
        if (character === "'") contexts.push({ kind: "single" });
        else if (character === '"') contexts.push({ kind: "double" });
        else if (character === "`") contexts.push({ kind: "backtick" });
        else if (isShellParenExpansionStart(input, index)) {
          contexts.push({ kind: "command", depth: 1 });
          index += 2;
          continue;
        } else if (character === "(") context.depth += 1;
        else if (character === ")") {
          context.depth -= 1;
          if (context.depth === 0) contexts.pop();
        }
        index += 1;
        continue;
      }
      if (character === "'") {
        contexts.push({ kind: "single" });
        index += 1;
        continue;
      }
      if (character === '"') {
        contexts.push({ kind: "double" });
        index += 1;
        continue;
      }
      if (character === "`") {
        contexts.push({ kind: "backtick" });
        index += 1;
        continue;
      }
      if (isShellParenExpansionStart(input, index)) {
        contexts.push({ kind: "command", depth: 1 });
        index += 2;
        continue;
      }
      if (character === " " || character === "\t") break;
      if (character === ";" || character === "\n" || character === "|" || character === "&") return undefined;
      index += 1;
    }
    if (contexts.length > 0 || index - start > MAX_SHELL_WORD_LENGTH) return undefined;
    const raw = input.slice(start, index);
    words.push({ raw, value: simpleShellWordValue(raw) });
  }
  return words;
}

function envWordsRemainInAssignmentRegion(words: readonly BoundedShellWord[]): { readonly ambiguous: boolean } | undefined {
  let index = 0;
  let parsingOptions = true;
  let ambiguous = false;
  while (index < words.length) {
    const boundedWord = words[index];
    const word = boundedWord?.value;
    if (word === undefined) {
      if (boundedWord === undefined) return undefined;
      if (/^[^=]+=/.test(boundedWord.raw)) parsingOptions = false;
      ambiguous = true;
      index += 1;
      continue;
    }
    if (parsingOptions && (word === "-" || /^-[i0v]+$/.test(word))) {
      index += 1;
      continue;
    }
    if (parsingOptions && word === "--") {
      parsingOptions = false;
      index += 1;
      continue;
    }
    if (parsingOptions && /^(?:--unset|--chdir|--split-string)$/.test(word)) {
      if (index + 1 >= words.length) return undefined;
      ambiguous ||= words[index + 1]?.value === undefined;
      index += 2;
      continue;
    }
    if (parsingOptions && /^(?:--unset|--chdir|--split-string)=/.test(word)) {
      index += 1;
      continue;
    }
    if (parsingOptions) {
      const valueOption = /^-[i0v]*[uPSC](.*)$/.exec(word);
      if (valueOption !== null) {
        if (valueOption[1] === "") {
          if (index + 1 >= words.length) return undefined;
          ambiguous ||= words[index + 1]?.value === undefined;
          index += 2;
        } else {
          index += 1;
        }
        continue;
      }
    }
    parsingOptions = false;
    if (!/^[^=]+=/.test(word)) return undefined;
    index += 1;
  }
  return { ambiguous };
}

function topLevelShellSyntax(input: string): string {
  const masked = input.split("");
  const contexts: Array<{ readonly kind: "single" | "double" | "backtick" } | { readonly kind: "command"; depth: number }> = [];
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const context = contexts.at(-1);
    if (context?.kind === "single") {
      masked[index] = "x";
      if (character === "'") contexts.pop();
      continue;
    }
    if (character === "\\") {
      masked[index] = "x";
      if (index + 1 < input.length) masked[++index] = "x";
      continue;
    }
    if (context?.kind === "backtick") {
      masked[index] = "x";
      if (character === "`") contexts.pop();
      continue;
    }
    if (context?.kind === "double") {
      masked[index] = "x";
      if (character === '"') contexts.pop();
      else if (isShellParenExpansionStart(input, index)) {
        contexts.push({ kind: "command", depth: 1 });
        if (index + 1 < input.length) masked[++index] = "x";
      } else if (character === "`") contexts.push({ kind: "backtick" });
      continue;
    }
    if (context?.kind === "command") {
      masked[index] = "x";
      if (character === "'") contexts.push({ kind: "single" });
      else if (character === '"') contexts.push({ kind: "double" });
      else if (character === "`") contexts.push({ kind: "backtick" });
      else if (isShellParenExpansionStart(input, index)) {
        contexts.push({ kind: "command", depth: 1 });
        if (index + 1 < input.length) masked[++index] = "x";
      } else if (character === "(") context.depth += 1;
      else if (character === ")") {
        context.depth -= 1;
        if (context.depth === 0) contexts.pop();
      }
      continue;
    }
    if (character === "'") {
      masked[index] = "x";
      contexts.push({ kind: "single" });
    } else if (character === '"') {
      masked[index] = "x";
      contexts.push({ kind: "double" });
    } else if (character === "`") {
      masked[index] = "x";
      contexts.push({ kind: "backtick" });
    } else if (isShellParenExpansionStart(input, index)) {
      masked[index] = "x";
      contexts.push({ kind: "command", depth: 1 });
      if (index + 1 < input.length) masked[++index] = "x";
    }
  }
  return masked.join("");
}

const SUPPORTED_SHELL_COMMAND_WORDS = new Set([
  "exec", "time", "noglob", "nocorrect", "coproc", "nohup", "/usr/bin/nohup", "/bin/nohup",
  "nice", "/usr/bin/nice", "/bin/nice", "/usr/bin/time", "/bin/time", "caffeinate", "/usr/bin/caffeinate",
  "env", "/usr/bin/env", "/bin/env", "command", "builtin",
]);

function isSupportedShellOptionWord(value: string): boolean {
  return value === "--"
    || /^(?:-[cl]+|-[cl]*a[^ \t]+)$/.test(value)
    || /^(?:-[alhp]+|-a?o[^ \t]+)$/.test(value)
    || /^(?:-n[+-]?[0-9]+|-[+-]?[0-9]+)$/.test(value)
    || /^(?:-[dimsu]+|-[dimsu]*[tw](?:[+-]?[0-9]+))$/.test(value)
    || /^(?:-[anoptvw]|-V)$/.test(value);
}

function normalizeSupportedCommandSpellings(input: string, syntax: string): string {
  const normalized = syntax.split("");
  for (const match of syntax.matchAll(/[^ \t;\n|&(){}!]+/g)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const value = simpleShellWordValue(input.slice(start, end));
    if (value === undefined || (!SUPPORTED_SHELL_COMMAND_WORDS.has(value) && !isSupportedShellOptionWord(value))) continue;
    const replacement = value.padEnd(end - start, " ");
    for (let index = start; index < end; index += 1) normalized[index] = replacement[index - start] ?? " ";
  }
  return normalized.join("");
}

function completeWordsBeforeFirstExpansion(input: string): string | undefined {
  let quote: "'" | '"' | undefined;
  let wordStart = 0;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quote === "'") {
      if (character === "'") quote = undefined;
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = undefined;
      else if (character === "`" || isShellParenExpansionStart(input, index)) return input.slice(0, wordStart);
      continue;
    }
    if (character === "'") quote = "'";
    else if (character === '"') quote = '"';
    else if (character === "`" || isShellParenExpansionStart(input, index)) return input.slice(0, wordStart);
    else if (character === " " || character === "\t") wordStart = index + 1;
  }
  return undefined;
}

function semanticEnvRegionBefore(input: string, position: number): { readonly failClosed: boolean } | undefined {
  const prefix = input.slice(0, position);
  const syntax = normalizeSupportedCommandSpellings(prefix, topLevelShellSyntax(prefix));
  let result: { readonly failClosed: boolean } | undefined;
  for (const match of syntax.matchAll(SHELL_AMBIGUOUS_ENV_COMMAND)) {
    const commandEnd = (match.index ?? 0) + match[0].length;
    const commandRegion = prefix.slice(commandEnd);
    if (commandRegion.length > MAX_SHELL_WORD_LENGTH) return { failClosed: true };
    const words = boundedShellWords(commandRegion);
    if (words !== undefined) {
      const region = envWordsRemainInAssignmentRegion(words);
      if (region !== undefined) result = { failClosed: region.ambiguous };
      continue;
    }
    const completePrefix = completeWordsBeforeFirstExpansion(commandRegion);
    if (completePrefix === undefined) continue;
    const completeWords = boundedShellWords(completePrefix);
    if (completeWords !== undefined && envWordsRemainInAssignmentRegion(completeWords) !== undefined) return { failClosed: true };
  }
  if (result === undefined) {
    for (const match of syntax.matchAll(SHELL_AMBIGUOUS_SUPPORTED_WRAPPER_ENV)) {
      const commandEnd = (match.index ?? 0) + match[0].length;
      const commandRegion = prefix.slice(commandEnd);
      if (commandRegion.length > MAX_SHELL_WORD_LENGTH) return { failClosed: true };
      const words = boundedShellWords(commandRegion);
      if (words !== undefined && envWordsRemainInAssignmentRegion(words) !== undefined) return { failClosed: true };
    }
  }
  return result;
}

function semanticEnvQuoteBefore(input: string, matchIndex: number): { readonly quote: "'" | '"'; readonly failClosed: boolean } | undefined {
  const quote = input[matchIndex - 1];
  if (quote !== "'" && quote !== '"') return undefined;
  const region = semanticEnvRegionBefore(input, matchIndex - 1);
  return region === undefined ? undefined : { quote, failClosed: region.failClosed };
}

function envAssignmentName(raw: string, value: string | undefined): string | undefined {
  if (value !== undefined) {
    const equals = value.indexOf("=");
    return equals > 0 ? value.slice(0, equals) : undefined;
  }
  const equals = raw.indexOf("=");
  if (equals <= 0) return undefined;
  let nameToken = raw.slice(0, equals);
  const openingQuote = nameToken[0];
  if ((openingQuote === "'" || openingQuote === '"') && nameToken.at(-1) !== openingQuote) nameToken += openingQuote;
  return simpleShellWordValue(nameToken);
}

function shellAssignmentSeparator(raw: string): number | undefined {
  const contexts: Array<{ readonly kind: "single" | "double" | "backtick" } | { readonly kind: "command"; depth: number }> = [];
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    const context = contexts.at(-1);
    if (context?.kind === "single") {
      if (character === "=" && !contexts.some((item) => item.kind === "command" || item.kind === "backtick")) return index;
      if (character === "'") contexts.pop();
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (context?.kind === "backtick") {
      if (character === "`") contexts.pop();
      continue;
    }
    if (context?.kind === "double") {
      if (character === "=" && !contexts.some((item) => item.kind === "command" || item.kind === "backtick")) return index;
      if (character === '"') contexts.pop();
      else if (isShellParenExpansionStart(raw, index)) {
        contexts.push({ kind: "command", depth: 1 });
        index += 1;
      } else if (character === "`") contexts.push({ kind: "backtick" });
      continue;
    }
    if (context?.kind === "command") {
      if (character === "'") contexts.push({ kind: "single" });
      else if (character === '"') contexts.push({ kind: "double" });
      else if (character === "`") contexts.push({ kind: "backtick" });
      else if (isShellParenExpansionStart(raw, index)) {
        contexts.push({ kind: "command", depth: 1 });
        index += 1;
      } else if (character === "(") context.depth += 1;
      else if (character === ")") {
        context.depth -= 1;
        if (context.depth === 0) contexts.pop();
      }
      continue;
    }
    if (character === "=") return index;
    if (character === "'") contexts.push({ kind: "single" });
    else if (character === '"') contexts.push({ kind: "double" });
    else if (character === "`") contexts.push({ kind: "backtick" });
    else if (isShellParenExpansionStart(raw, index)) {
      contexts.push({ kind: "command", depth: 1 });
      index += 1;
    }
  }
  return undefined;
}

function boundedEnvWordEnd(input: string, start: number): number | undefined {
  const contexts: Array<{ readonly kind: "single" | "double" | "backtick" } | { readonly kind: "command"; depth: number }> = [];
  const end = Math.min(input.length, start + MAX_SHELL_WORD_LENGTH);
  for (let index = start; index < end; index += 1) {
    const character = input[index];
    const context = contexts.at(-1);
    if (context?.kind === "single") {
      if (character === "'") contexts.pop();
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (context?.kind === "backtick") {
      if (character === "`") contexts.pop();
      continue;
    }
    if (context?.kind === "double") {
      if (character === '"') contexts.pop();
      else if (isShellParenExpansionStart(input, index)) {
        contexts.push({ kind: "command", depth: 1 });
        index += 1;
      } else if (character === "`") contexts.push({ kind: "backtick" });
      continue;
    }
    if (context?.kind === "command") {
      if (character === "'") contexts.push({ kind: "single" });
      else if (character === '"') contexts.push({ kind: "double" });
      else if (character === "`") contexts.push({ kind: "backtick" });
      else if (isShellParenExpansionStart(input, index)) {
        contexts.push({ kind: "command", depth: 1 });
        index += 1;
      } else if (character === "(") context.depth += 1;
      else if (character === ")") {
        context.depth -= 1;
        if (context.depth === 0) contexts.pop();
      }
      continue;
    }
    if (character === " " || character === "\t" || character === "\n" || character === ";" || character === "|" || character === "&") return index;
    if (character === "'") contexts.push({ kind: "single" });
    else if (character === '"') contexts.push({ kind: "double" });
    else if (character === "`") contexts.push({ kind: "backtick" });
    else if (isShellParenExpansionStart(input, index)) {
      contexts.push({ kind: "command", depth: 1 });
      index += 1;
    }
  }
  return contexts.length === 0 && end === input.length ? end : undefined;
}

function redactEnvCredentialAssignments(input: string): { readonly value: string; readonly count: number } {
  const boundary = /(^|[ \t]+)/gm;
  const parts: string[] = [];
  let cursor = 0;
  let count = 0;
  for (const match of input.matchAll(boundary)) {
    const wordStart = (match.index ?? 0) + match[0].length;
    if (wordStart < cursor || wordStart >= input.length) continue;
    const wordEnd = boundedEnvWordEnd(input, wordStart);
    if (wordEnd === undefined || wordEnd <= wordStart) continue;
    const raw = input.slice(wordStart, wordEnd);
    const word = simpleShellWordValue(raw);
    const assignmentSeparator = shellAssignmentSeparator(raw);
    if (assignmentSeparator === undefined) {
      if (word !== undefined) continue;
      const region = semanticEnvRegionBefore(input, wordStart);
      if (region === undefined) continue;
      parts.push(input.slice(cursor, wordStart), "credential=[redacted]");
      cursor = input.length;
      count += 1;
      break;
    }
    if (assignmentSeparator === 0) continue;
    const name = envAssignmentName(raw, word);
    if (word !== undefined && name === undefined) continue;
    if (name !== undefined && (!isCredentialName(name) || word?.slice((word.indexOf("=") ?? -1) + 1) === "[redacted]")) continue;
    const region = semanticEnvRegionBefore(input, wordStart);
    if (region === undefined) continue;
    parts.push(input.slice(cursor, wordStart), name === undefined ? "credential=[redacted]" : `${name}=[redacted]`);
    cursor = region.failClosed || name === undefined || word === undefined ? input.length : wordEnd;
    count += 1;
    if (region.failClosed || name === undefined || word === undefined) break;
  }
  if (count === 0) return { value: input, count: 0 };
  parts.push(input.slice(cursor));
  return { value: parts.join(""), count };
}

function redactInlineShellCredentialAssignments(input: string): { readonly value: string; readonly count: number } {
  const candidate = /\b([A-Za-z_][A-Za-z0-9_-]*)/g;
  const parts: string[] = [];
  let cursor = 0;
  let count = 0;
  for (const match of input.matchAll(candidate)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex < cursor) continue;
    const name = match[1];
    if (name === undefined || input[matchIndex - 1] === "$" || !isCredentialName(name)) continue;
    let lhsEnd = matchIndex + match[0].length;
    let malformedSubscript = false;
    while (input[lhsEnd] === "[") {
      const subscriptEnd = shellSubscriptEnd(input, lhsEnd);
      if (subscriptEnd === undefined) {
        malformedSubscript = true;
        break;
      }
      lhsEnd = subscriptEnd;
    }
    const lineStart = input.lastIndexOf("\n", matchIndex - 1) + 1;
    const lineStartAssignment = SHELL_LINE_START_PREFIX.test(input.slice(lineStart, matchIndex));
    const safeDeclarationQuote = declarationQuoteBefore(input, matchIndex);
    const semanticEnvQuote = safeDeclarationQuote === undefined ? semanticEnvQuoteBefore(input, matchIndex) : undefined;
    const declarationQuote = safeDeclarationQuote ?? semanticEnvQuote?.quote;
    if ((input[matchIndex - 1] === "'" || input[matchIndex - 1] === '"') && declarationQuote === undefined) continue;
    if (malformedSubscript) {
      if (!hasBoundedComplexSubscriptAssignment(input, lhsEnd, declarationQuote)) continue;
      const replacementStart = declarationQuote === undefined ? matchIndex : matchIndex - 1;
      const replacement = lineStartAssignment || declarationQuote !== undefined ? `${name}=[redacted]` : "credential=[redacted]";
      parts.push(input.slice(cursor, replacementStart), replacement);
      cursor = input.length;
      count += 1;
      break;
    }
    const quotedEnvAssignment = semanticEnvQuote !== undefined && input[lhsEnd] === "=";
    const operatorStart = declarationQuote === undefined || quotedEnvAssignment ? lhsEnd : lhsEnd + 1;
    if (declarationQuote !== undefined && !quotedEnvAssignment && input[lhsEnd] !== declarationQuote) continue;
    const operatorMatch = declarationQuote === undefined
      ? /^[ \t]*(\+?=)[ \t]*/.exec(input.slice(operatorStart))
      : /^(\+?=)[ \t]*/.exec(input.slice(operatorStart));
    const operator = operatorMatch?.[1];
    if (operator === undefined || operatorMatch === null) continue;
    const lhs = input.slice(matchIndex, lhsEnd);
    if (semanticEnvQuote?.failClosed === true) {
      parts.push(input.slice(cursor, matchIndex - 1), `${lhs}${operator}[redacted]`);
      cursor = input.length;
      count += 1;
      break;
    }
    const valueStart = operatorStart + operatorMatch[0].length;
    const valueEnd = shellWordEnd(input, valueStart);
    if (valueEnd === valueStart || input.slice(valueStart, valueEnd) === "[redacted]") continue;
    const replacement = lineStartAssignment || declarationQuote !== undefined
      ? `${lhs}${operator}[redacted]`
      : "credential=[redacted]";
    parts.push(input.slice(cursor, declarationQuote === undefined ? matchIndex : matchIndex - 1), replacement);
    cursor = quotedEnvAssignment ? shellWordEnd(input, matchIndex - 1) : valueEnd;
    count += 1;
  }
  if (count === 0) return { value: input, count: 0 };
  parts.push(input.slice(cursor));
  return { value: parts.join(""), count };
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

function redactJson(value: unknown, key?: string, ancestors: readonly string[] = []): { readonly value: JsonValue; readonly count: number } {
  if (key !== undefined && (SENSITIVE_KEYS.test(key) || isCredentialName(key))) {
    return { value: "[redacted]", count: 1 };
  }
  if (key !== undefined
    && ACCOUNT_VALUE_KEYS.test(key)
    && ancestors.some((ancestor) => ACCOUNT_CONTEXT_KEYS.test(ancestor))) {
    return { value: "[redacted]", count: 1 };
  }
  if (key !== undefined
    && IDENTITY_VALUE_KEYS.test(key)
    && ancestors.some((ancestor) => IDENTITY_CONTEXT_KEYS.test(ancestor))) {
    return { value: "[redacted]", count: 1 };
  }
  const currentPath = key === undefined ? ancestors : [...ancestors, key];
  if (value === null || typeof value === "boolean" || typeof value === "number") return { value, count: 0 };
  if (typeof value === "string") return redactString(value);
  if (typeof value === "bigint") return { value: value.toString(), count: 0 };
  if (value instanceof Uint8Array) return { value: `[binary ${value.byteLength} bytes omitted]`, count: 1 };
  if (Array.isArray(value)) {
    let count = 0;
    const entries = value.map((entry) => {
      const redacted = redactJson(entry, undefined, currentPath);
      count += redacted.count;
      return redacted.value;
    });
    return { value: entries, count };
  }
  if (typeof value === "object" && value !== null) {
    let count = 0;
    const entries = Object.create(null) as Record<string, JsonValue>;
    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (entryValue === undefined || typeof entryValue === "function" || typeof entryValue === "symbol") continue;
      const redacted = redactJson(entryValue, entryKey, currentPath);
      const redactedKey = redactString(entryKey);
      count += redacted.count + redactedKey.count;
      let outputKey = redactedKey.value;
      if (Object.hasOwn(entries, outputKey)) {
        let collision = 2;
        while (Object.hasOwn(entries, `${outputKey} [redacted-key-collision-${collision}]`)) collision += 1;
        outputKey = `${outputKey} [redacted-key-collision-${collision}]`;
        count += 1;
      }
      entries[outputKey] = redacted.value;
    }
    return { value: entries, count };
  }
  return { value: String(value), count: 0 };
}

function redactPrivateKeyBlocks(input: string): { readonly value: string; readonly count: number } {
  const markerPattern = /-----(BEGIN|END) ([A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?)-----/g;
  const parts: string[] = [];
  let cursor = 0;
  let count = 0;
  let marker: RegExpExecArray | null;
  outer: while ((marker = markerPattern.exec(input)) !== null) {
    if (marker[1] !== "BEGIN") continue;
    const blockStart = marker.index;
    const labels = [marker[2]!];
    let blockEnd: number | undefined;
    while ((marker = markerPattern.exec(input)) !== null) {
      const kind = marker[1]!;
      const label = marker[2]!;
      if (kind === "BEGIN") {
        labels.push(label);
        continue;
      }
      const activeLabel = labels.at(-1)!;
      if (label === activeLabel) {
        labels.pop();
        if (labels.length === 0) {
          blockEnd = marker.index + marker[0].length;
          break;
        }
        continue;
      }
      // A footer for an outer block while an inner block is still open is
      // crossed armor. No later boundary is trustworthy, so omit through EOF.
      if (labels.includes(label)) {
        parts.push(input.slice(cursor, blockStart), "[redacted-private-key-block]");
        count += 1;
        cursor = input.length;
        break outer;
      }
      // An unrelated footer cannot close any active block. Keep scanning for
      // the exact active label; if it never arrives, the EOF fallback applies.
    }
    parts.push(input.slice(cursor, blockStart), "[redacted-private-key-block]");
    count += 1;
    if (blockEnd === undefined) {
      cursor = input.length;
      break;
    }
    cursor = blockEnd;
  }
  if (count === 0) return { value: input, count: 0 };
  parts.push(input.slice(cursor));
  return { value: parts.join(""), count };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeJwtSegment(segment: string, maxDecodedBytes: number): unknown | undefined {
  if (segment.length % 4 === 1) return undefined;
  const decoded = Buffer.from(segment, "base64url");
  if (decoded.byteLength === 0 || decoded.byteLength > maxDecodedBytes || decoded.toString("base64url") !== segment) return undefined;
  try {
    return JSON.parse(decoded.toString("utf8"));
  } catch {
    return undefined;
  }
}

function isStructurallyValidJwt(candidate: string): boolean {
  const segments = candidate.split(".");
  if (segments.length !== 3) return false;
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  if (encodedHeader === undefined || encodedPayload === undefined || encodedSignature === undefined) return false;
  const header = decodeJwtSegment(encodedHeader, 2_048);
  const payload = decodeJwtSegment(encodedPayload, 16_384);
  if (!isJsonObject(header) || typeof header.alg !== "string" || header.alg.length === 0 || !isJsonObject(payload)) return false;
  if (encodedSignature.length < 16 || encodedSignature.length % 4 === 1) return false;
  const signature = Buffer.from(encodedSignature, "base64url");
  return signature.byteLength >= 12 && signature.toString("base64url") === encodedSignature;
}

function redactStandaloneJwts(input: string): { readonly value: string; readonly count: number } {
  let count = 0;
  const value = input.replace(
    /(?<![A-Za-z0-9_.-])([A-Za-z0-9_-]{2,2048}\.[A-Za-z0-9_-]{2,16384}\.[A-Za-z0-9_-]{16,8192})(?![A-Za-z0-9_.-])/g,
    (candidate) => {
      if (!isStructurallyValidJwt(candidate)) return candidate;
      count += 1;
      return "[redacted-jwt]";
    },
  );
  return { value, count };
}

function isSignedQueryCredentialName(name: string): boolean {
  let decoded = name;
  try {
    decoded = decodeURIComponent(name.replace(/\+/g, " "));
  } catch {
    // Keep the raw spelling so malformed percent escapes cannot hide an
    // otherwise recognizable credential name.
  }
  const normalized = decoded.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
  return normalized === "sig" || normalized === "signature" || normalized.endsWith("_signature") || isCredentialName(decoded);
}

function redactSignedQueryCredentials(input: string): { readonly value: string; readonly count: number } {
  let count = 0;
  const value = input.replace(/([?&])([^=?&#\s'"`]{1,256})=(\[redacted\]|[^&#\s'"`()\[\]{},;]+)/g, (match, separator, name, credential) => {
    if (!isSignedQueryCredentialName(name) || credential === "[redacted]") return match;
    count += 1;
    return `${separator}${name}=[redacted]`;
  });
  return { value, count };
}

function redactString(input: string): { readonly value: string; readonly count: number } {
  const structured = redactStructuredYaml(input);
  let value = structured?.value ?? input;
  let count = structured?.count ?? 0;
  const replace = (pattern: RegExp, replacement: string) => {
    value = value.replace(pattern, () => {
      count += 1;
      return replacement;
    });
  };
  const replaceWith = (pattern: RegExp, replacement: (...matches: string[]) => string) => {
    value = value.replace(pattern, (...matches) => {
      count += 1;
      return replacement(...matches);
    });
  };
  replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]");
  replaceWith(/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^@\s/'"`]+@/g, (_match, scheme) => `${scheme}[redacted]@`);
  value = value.replace(/(^|\n)([ \t]*)([<>])([ \t]*)(authorization|proxy-authorization|cookie|set-cookie)([ \t]*:[ \t]*)([^\r\n]*)(?:(?:\r?\n)[ \t]*\3[ \t]{2,}[^\r\n]*)*/gi, (match, lineStart, indent, direction, afterDirection, name, separator, headerValue) => {
    if (headerValue.trim() === "[redacted]" && !match.slice(match.indexOf(headerValue) + headerValue.length).includes("\n")) return match;
    count += 1;
    return `${lineStart}${indent}${direction}${afterDirection}${name}${separator}[redacted]`;
  });
  value = value.replace(/(^|\n)([ \t]*(?:[<>][ \t]*)?)(authorization|proxy-authorization|cookie|set-cookie)([ \t]*:[ \t]*)([^\r\n]*)/gi, (match, lineStart, prefix, name, separator, headerValue) => {
    if (headerValue.trim() === "[redacted]") return match;
    count += 1;
    return `${lineStart}${prefix}${name}${separator}[redacted]`;
  });
  const envAssignments = redactEnvCredentialAssignments(value);
  value = envAssignments.value;
  count += envAssignments.count;
  const inlineAssignments = redactInlineShellCredentialAssignments(value);
  value = inlineAssignments.value;
  count += inlineAssignments.count;
  if (structured === undefined) {
    value = value.replace(/("(?:\\.|[^"\\\r\n])*"|'[A-Za-z_][A-Za-z0-9_-]*')(\s*:\s*)("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*')/g, (match, keyToken, separator, quotedValue) => {
    const name = decodedQuotedKey(keyToken);
    if (name === undefined || !isCredentialName(name)) return match;
    count += 1;
    const valueQuote = quotedValue[0];
    return `${keyToken}${separator}${valueQuote}[redacted]${valueQuote}`;
  });
  value = value.replace(/([\[{,][ \t]*)(\?[ \t]+)?(?:("(?:\\.|[^"\\\r\n])*"|'[A-Za-z_][A-Za-z0-9_-]*')|([A-Za-z_][A-Za-z0-9_-]*))([ \t]*:[ \t]*)("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|\[redacted\]|[^,}\]\r\n]*)/g, (match, prefix, explicitKey, quotedKey, plainName, separator, scalar) => {
    const name = quotedKey === undefined ? plainName : decodedQuotedKey(quotedKey);
    const trimmedScalar = scalar.trim();
    if (name === undefined
      || !isCredentialName(name)
      || trimmedScalar === "[redacted]"
      || trimmedScalar === '"[redacted]"'
      || trimmedScalar === "'[redacted]'") return match;
    count += 1;
    const renderedKey = quotedKey ?? name;
    return `${prefix}${explicitKey ?? ""}${renderedKey}${separator}[redacted]`;
  });
  const lines = value.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter((line) => line !== "") ?? [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    const explicitKey = /^([ \t]*)((?:-[ \t]+)*)\?[ \t]+(?:((?:"(?:\\.|[^"\\\r\n])*"|'[A-Za-z_][A-Za-z0-9_-]*'))|([A-Za-z_][A-Za-z0-9_-]*))(?:[ \t]+#[^\r\n]*)?[ \t]*(\r\n|\n|\r|$)$/.exec(lines[index]!);
    const name = explicitKey?.[3] === undefined ? explicitKey?.[4] : decodedQuotedKey(explicitKey[3]);
    if (explicitKey === null || name === undefined || !isCredentialName(name)) continue;
    let valueIndex = index + 1;
    while (valueIndex < lines.length && /^[ \t]*(?:#[^\r\n]*)?(?:\r\n|\n|\r|$)$/.test(lines[valueIndex]!)) valueIndex += 1;
    if (valueIndex >= lines.length) continue;
    const valueHeader = /^([ \t]*)(:[ \t]*)([^\r\n]*)(\r\n|\n|\r|$)$/.exec(lines[valueIndex]!);
    const keyIndentation = explicitKey[1]!.length + (explicitKey[2]?.length ?? 0);
    if (valueHeader === null || valueHeader[1]!.length !== keyIndentation) continue;
    const scalar = valueHeader[3]!;
    if (scalar.trim() === "[redacted]") continue;
    if (/^[ \t]*[|>]/.test(scalar)) {
      let end = valueIndex + 1;
      while (end < lines.length) {
        const content = lines[end]!.replace(/(?:\r\n|\n|\r)$/, "");
        if (content.trim() !== "" && (/^[ \t]*/.exec(content)?.[0].length ?? 0) <= keyIndentation) break;
        end += 1;
      }
      lines.splice(valueIndex, end - valueIndex, `${valueHeader[1]!}${valueHeader[2]!}[redacted]${valueHeader[4]!}`);
    } else {
      lines[valueIndex] = `${valueHeader[1]!}${valueHeader[2]!}[redacted]${valueHeader[4]!}`;
    }
    count += 1;
  }
  for (let index = 0; index < lines.length; index += 1) {
    const header = /^([ \t]*)((?:-[ \t]+)*)(?:("(?:\\.|[^"\\\r\n])*"|'[A-Za-z_][A-Za-z0-9_-]*')|([A-Za-z_][A-Za-z0-9_-]*))([ \t]*:[ \t]*)([|>])(?:[^\r\n]*)(\r\n|\n|\r|$)$/.exec(lines[index]!);
    const name = header?.[3] === undefined ? header?.[4] : decodedQuotedKey(header[3]);
    if (header === null || name === undefined || !isCredentialName(name)) continue;
    const indentation = header[1]!.length + (header[2]?.length ?? 0);
    let end = index + 1;
    while (end < lines.length) {
      const content = lines[end]!.replace(/(?:\r\n|\n|\r)$/, "");
      if (content.trim() !== "" && (/^[ \t]*/.exec(content)?.[0].length ?? 0) <= indentation) break;
      end += 1;
    }
    const renderedKey = header[3] ?? name;
    lines.splice(index, end - index, `${header[1]!}${header[2] ?? ""}${renderedKey}${header[5]!}[redacted]${header[7]!}`);
    count += 1;
  }
  value = lines.join("");
  value = value.replace(/(^|\n)([ \t]*)((?:-[ \t]+)*)(?:("(?:\\.|[^"\\\r\n])*"|'[A-Za-z_][A-Za-z0-9_-]*')|([A-Za-z_][A-Za-z0-9_-]*))([ \t]*:[ \t]*)([^\r\n]*)/g, (match, lineStart, indentation, sequenceMarker, quotedKey, plainName, separator, scalar) => {
    const name = quotedKey === undefined ? plainName : decodedQuotedKey(quotedKey);
    if (name === undefined || !isCredentialName(name)) return match;
    if (["[redacted]", '"[redacted]"', "'[redacted]'"].includes(scalar.trim())) return match;
    count += 1;
    const renderedKey = quotedKey ?? name;
    return `${lineStart}${indentation}${sequenceMarker ?? ""}${renderedKey}${separator}[redacted]`;
  });
  }
  const privateKeyBlocks = redactPrivateKeyBlocks(value);
  value = privateKeyBlocks.value;
  count += privateKeyBlocks.count;
  const standaloneJwts = redactStandaloneJwts(value);
  value = standaloneJwts.value;
  count += standaloneJwts.count;
  const signedQueryCredentials = redactSignedQueryCredentials(value);
  value = signedQueryCredentials.value;
  count += signedQueryCredentials.count;
  replace(/\b(?:sizeJustification|size_justification)\s*(?::|=)\s*[\"'][^\"']*[\"']/gi, "sizeJustification=[private rationale omitted]");
  replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted-api-key]");
  replace(/(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36}(?![A-Za-z0-9_])|github_pat_[A-Za-z0-9_]{82}(?![A-Za-z0-9_]))/g, "[redacted-github-token]");
  replace(/(?<![A-Za-z0-9_])(?:xox[a-z](?:\.xox[a-z])?|xapp|xwfp)-[A-Za-z0-9-]{10,}(?![A-Za-z0-9_-])/gi, "[redacted-slack-token]");
  replace(/(?<![A-Za-z0-9_])gl(?:pat|oas|dt|rt|rtr|cbt|ptt|ft|imt|agent|wt|soat|ffct)-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g, "[redacted-gitlab-token]");
  replace(/(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9_])/g, "[redacted-npm-token]");
  replace(/(?<![A-Za-z0-9_])[sr]k_(?:live|test)_[A-Za-z0-9]{24,}(?![A-Za-z0-9_])/g, "[redacted-stripe-key]");
  replace(/(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{34}(?![A-Za-z0-9_])/g, "[redacted-hugging-face-token]");
  replace(/(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, "[redacted-google-api-key]");
  if (LOCAL_HOME_PATTERN !== undefined) replace(LOCAL_HOME_PATTERN, REDACTED_LOCAL_HOME);
  replaceWith(/\b([A-Za-z]):\/Users\/[^/\s'"`]+/gi, (_match, drive) => `${drive}:/Users/[redacted]`);
  replace(/\/Users\/[^/\s'"`]+/g, "/Users/[redacted]");
  replaceWith(/\b([A-Za-z]):\\Users\\[^\\\s'"`]+/gi, (_match, drive) => `${drive}:\\Users\\[redacted]`);
  replaceWith(/\/(private\/)?var\/folders\/(?!\[redacted\](?:\/|$))[^/\s'"`]+\/[^/\s'"`]+/g, (_match, privatePrefix) => `/${privatePrefix ?? ""}var/folders/[redacted]`);
  if (LOCAL_FILE_OWNER_PATTERN !== undefined) {
    replaceWith(LOCAL_FILE_OWNER_PATTERN, (_match, lineStart, fileMetadata) => `${lineStart}${fileMetadata}[redacted-user]`);
  }
  if (LOCAL_LOGIN_LINE_PATTERN !== undefined) {
    replaceWith(LOCAL_LOGIN_LINE_PATTERN, (_match, lineStart) => `${lineStart}[redacted-user]`);
  }
  if (LOCAL_IDENTITY_OUTPUT_PATTERN !== undefined) {
    replaceWith(LOCAL_IDENTITY_OUTPUT_PATTERN, (_match, prefix) => `${prefix}[redacted-user]`);
  }
  if (LOCAL_SHELL_IDENTITY_PATTERN !== undefined) replace(LOCAL_SHELL_IDENTITY_PATTERN, "[redacted-user]");
  if (LOCAL_SHELL_HOSTNAME_PATTERN !== undefined) replace(LOCAL_SHELL_HOSTNAME_PATTERN, "[redacted-host]");
  if (LOCAL_HOSTNAME_LINE_PATTERN !== undefined) {
    replaceWith(LOCAL_HOSTNAME_LINE_PATTERN, (_match, lineStart) => `${lineStart}[redacted-host]`);
  }
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
