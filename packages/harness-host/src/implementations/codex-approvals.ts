import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import {
  HarnessApprovalRequestTerminatedError,
  type HarnessApprovalChannel,
} from "../approval-coordinator.js";
import type { HarnessApprovalDecision, HarnessApprovalRequestInput } from "../approval.js";
import type { JsonObject, JsonValue } from "../types.js";

export interface CodexApprovalBridgeContext {
  readonly approvals: HarnessApprovalChannel;
  readonly workingDirectory: string;
  readonly sandboxPolicy: JsonObject;
  readonly trustedGraphAuthoringLauncher?: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly items: ReadonlyMap<string, JsonObject>;
  readonly signal?: AbortSignal;
}

export interface CodexServerRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params: unknown;
}

/**
 * Converts the pinned Codex 0.147 app-server approval requests into Relayer's
 * provider-neutral protocol. Unsupported or under-specified shapes receive a
 * provider denial without manufacturing reusable authority.
 */
export async function answerCodexServerRequest(
  request: CodexServerRequest,
  context: CodexApprovalBridgeContext,
): Promise<unknown> {
  switch (request.method) {
    case "item/commandExecution/requestApproval":
      return answerV2Command(request, context);
    case "item/fileChange/requestApproval":
      return answerV2FileChange(request, context);
    case "execCommandApproval":
      return answerLegacyCommand(request, context);
    case "applyPatchApproval":
      return answerLegacyPatch(request, context);
    case "item/permissions/requestApproval":
      return answerPermissions(request, context);
    case "mcpServer/elicitation/request":
      return { action: "decline", content: null, _meta: null };
    case "item/tool/requestUserInput":
      return answerToolUserInput(request, context);
    default:
      throw new Error(`Unsupported Codex app-server request: ${request.method}`);
  }
}

const MAX_CODEX_PERMISSION_ENTRIES = 256;
const MAX_CODEX_PERMISSION_TEXT_LENGTH = 4_096;

interface ParsedCodexPermissions {
  readonly permissions: JsonObject;
  readonly scopeKey: string;
  readonly summary: string;
}

async function answerPermissions(request: CodexServerRequest, context: CodexApprovalBridgeContext): Promise<unknown> {
  const denied = { permissions: {}, scope: "turn" } as const;
  if (!validProviderRequestId(request.id)) return denied;
  const params = optionalRecord(request.params);
  if (params === undefined || !hasExactKeys(params, [
    "threadId",
    "turnId",
    "itemId",
    "environmentId",
    "startedAtMs",
    "cwd",
    "reason",
    "permissions",
  ])) return denied;
  if (!sameTurn(params, context)) return denied;

  const itemId = boundedString(params.itemId);
  const cwd = validAbsolutePath(boundedString(params.cwd));
  const environmentId = params.environmentId === null || params.environmentId === undefined
    ? null
    : boundedString(params.environmentId);
  const reason = params.reason === null || params.reason === undefined
    ? "Codex requested additional permissions for the current turn."
    : boundedString(params.reason);
  if (environmentId === undefined) return denied;
  if (itemId === undefined
    || cwd === undefined
    || reason === undefined
    || !positiveSafeInteger(params.startedAtMs)) return denied;

  const parsed = parseCodexPermissions(params.permissions, { cwd, environmentId });
  if (parsed === undefined) return denied;
  const input: HarnessApprovalRequestInput = {
    providerItemId: providerItemId(request, itemId),
    title: "Grant Codex permissions for this turn",
    reason,
    action: {
      kind: "other",
      action: `Grant ${parsed.summary} to Codex for the current turn`,
      workingDirectory: cwd,
    },
    scopeKeys: [parsed.scopeKey],
    scopeDescription: `Codex grants ${parsed.summary} only for the current turn. Approve always reuses this exact scope only in the live Relayer harness session.`,
  };

  try {
    const decision = await requestApproval(input, context);
    return decision.decision === "deny"
      ? denied
      : { permissions: parsed.permissions, scope: "turn" };
  } catch (error) {
    if (error instanceof HarnessApprovalRequestTerminatedError) return denied;
    throw error;
  }
}

function parseCodexPermissions(
  value: unknown,
  correlation: { readonly cwd: string; readonly environmentId: string | null },
): ParsedCodexPermissions | undefined {
  const profile = optionalRecord(value);
  if (profile === undefined || !hasExactKeys(profile, ["network", "fileSystem"])) return undefined;
  const permissions: Record<string, JsonValue> = {};
  const summaries: string[] = [];

  if (profile.network !== null && profile.network !== undefined) {
    const network = optionalRecord(profile.network);
    if (network === undefined || !hasExactKeys(network, ["enabled"]) || network.enabled !== true) {
      return undefined;
    }
    permissions.network = { enabled: true };
    summaries.push("unrestricted network access");
  }

  if (profile.fileSystem !== null && profile.fileSystem !== undefined) {
    const fileSystem = parseCodexFileSystemPermissions(profile.fileSystem);
    if (fileSystem === undefined) return undefined;
    if (fileSystem.hasAuthority) {
      permissions.fileSystem = fileSystem.permissions;
      summaries.push(fileSystem.summary);
    }
  }

  if (summaries.length === 0) return undefined;
  const summary = summaries.join("; ");
  if (summary.length > MAX_CODEX_PERMISSION_TEXT_LENGTH) return undefined;
  return {
    permissions,
    scopeKey: scopeKey("permissions", { ...correlation, permissions }),
    summary,
  };
}

function parseCodexFileSystemPermissions(value: unknown): {
  readonly permissions: JsonObject;
  readonly hasAuthority: boolean;
  readonly summary: string;
} | undefined {
  const fileSystem = optionalRecord(value);
  if (fileSystem === undefined
    || !hasRequiredAndOnlyKeys(fileSystem, ["read", "write"], ["globScanMaxDepth", "entries"])) {
    return undefined;
  }
  const read = parseAbsolutePathList(fileSystem.read);
  const write = parseAbsolutePathList(fileSystem.write);
  if (read === undefined || write === undefined) return undefined;

  const permissions: Record<string, JsonValue> = { read, write };
  if (fileSystem.globScanMaxDepth !== undefined) {
    if (!positiveSafeInteger(fileSystem.globScanMaxDepth) || fileSystem.globScanMaxDepth > MAX_CODEX_PERMISSION_ENTRIES) {
      return undefined;
    }
    permissions.globScanMaxDepth = fileSystem.globScanMaxDepth;
  }

  let entries: readonly JsonObject[] | undefined;
  if (fileSystem.entries !== undefined) {
    if (!Array.isArray(fileSystem.entries) || fileSystem.entries.length > MAX_CODEX_PERMISSION_ENTRIES) return undefined;
    const parsed = fileSystem.entries.map(parseCodexFileSystemEntry);
    if (parsed.some((entry) => entry === undefined)) return undefined;
    entries = uniqueCanonical(parsed as JsonObject[]);
    if (!legacyPathsMatchEntries(read, write, entries)) return undefined;
    // Canonical entries are the effective 0.147 authority. Omit their legacy
    // duplicate roots so ordering or dual serialization cannot change a grant.
    permissions.read = null;
    permissions.write = null;
    permissions.entries = entries;
  }

  const readCount = entries === undefined ? read?.length ?? 0 : entries.filter((entry) => entry.access === "read").length;
  const writeCount = entries === undefined ? write?.length ?? 0 : entries.filter((entry) => entry.access === "write").length;
  if (readCount + writeCount === 0) {
    return { permissions, hasAuthority: false, summary: "no filesystem access" };
  }
  const parts = entries === undefined
    ? [
        ...(read ?? []).map((path) => `filesystem read access to ${path}`),
        ...(write ?? []).map((path) => `filesystem write access to ${path}`),
      ]
    : entries.map(describeCodexFileSystemEntry);
  const summary = parts.join(", ");
  return summary.length > MAX_CODEX_PERMISSION_TEXT_LENGTH
    ? undefined
    : { permissions, hasAuthority: true, summary };
}

function legacyPathsMatchEntries(
  read: readonly string[] | null,
  write: readonly string[] | null,
  entries: readonly JsonObject[],
): boolean {
  const entryPaths = (access: "read" | "write") => entries.flatMap((entry) => {
    if (entry.access !== access) return [];
    const path = optionalRecord(entry.path);
    return path?.type === "path" && typeof path.path === "string" ? [path.path] : [];
  });
  const matches = (legacy: readonly string[] | null, access: "read" | "write") => {
    if (legacy === null) return true;
    const canonicalLegacy = [...legacy].sort();
    const canonicalEntries = [...new Set(entryPaths(access))].sort();
    return canonicalJson(canonicalLegacy) === canonicalJson(canonicalEntries);
  };
  return matches(read, "read") && matches(write, "write");
}

function parseAbsolutePathList(value: unknown): readonly string[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > MAX_CODEX_PERMISSION_ENTRIES) return undefined;
  const paths = value.map((path) => validAbsolutePath(boundedString(path)));
  if (paths.some((path) => path === undefined)) return undefined;
  return [...new Set(paths as string[])].sort();
}

function parseCodexFileSystemEntry(value: unknown): JsonObject | undefined {
  const entry = optionalRecord(value);
  if (entry === undefined || !hasOnlyKeys(entry, ["path", "access"])) return undefined;
  if (entry.access !== "read" && entry.access !== "write" && entry.access !== "deny") return undefined;
  const path = parseCodexFileSystemPath(entry.path);
  if (path?.type === "glob_pattern" && entry.access !== "deny") return undefined;
  return path === undefined ? undefined : { path, access: entry.access };
}

function describeCodexFileSystemEntry(entry: JsonObject): string {
  const path = entry.path as JsonObject;
  let target: string;
  switch (path.type) {
    case "path":
      target = String(path.path);
      break;
    case "glob_pattern":
      target = `glob ${String(path.pattern)}`;
      break;
    case "special": {
      const special = path.value as JsonObject;
      switch (special.kind) {
        case "root": target = "the filesystem root"; break;
        case "minimal": target = "the minimal system paths"; break;
        case "project_roots": target = special.subpath === null
          ? "the project roots"
          : `project-roots subpath ${String(special.subpath)}`; break;
        case "tmpdir": target = "the system temporary directory"; break;
        case "slash_tmp": target = "/tmp"; break;
        default: target = "an unsupported filesystem target"; break;
      }
      break;
    }
    default:
      target = "an unsupported filesystem target";
  }
  return `filesystem ${String(entry.access)} rule for ${target}`;
}

function parseCodexFileSystemPath(value: unknown): JsonObject | undefined {
  const path = optionalRecord(value);
  if (path === undefined || typeof path.type !== "string") return undefined;
  switch (path.type) {
    case "path": {
      if (!hasOnlyKeys(path, ["type", "path"])) return undefined;
      const absolute = validAbsolutePath(boundedString(path.path));
      return absolute === undefined ? undefined : { type: "path", path: absolute };
    }
    case "glob_pattern": {
      if (!hasOnlyKeys(path, ["type", "pattern"])) return undefined;
      const pattern = boundedString(path.pattern);
      return pattern === undefined ? undefined : { type: "glob_pattern", pattern };
    }
    case "special": {
      if (!hasOnlyKeys(path, ["type", "value"])) return undefined;
      const special = optionalRecord(path.value);
      if (special === undefined || typeof special.kind !== "string") return undefined;
      switch (special.kind) {
        case "root":
        case "minimal":
        case "tmpdir":
        case "slash_tmp":
          return hasOnlyKeys(special, ["kind"])
            ? { type: "special", value: { kind: special.kind } }
            : undefined;
        case "project_roots": {
          if (!hasOnlyKeys(special, ["kind", "subpath"])) return undefined;
          const subpath = special.subpath === null ? null : boundedString(special.subpath);
          return subpath === undefined
            ? undefined
            : { type: "special", value: { kind: special.kind, subpath } };
        }
        default:
          // An `unknown` special path cannot be given stable reusable authority.
          return undefined;
      }
    }
    default:
      return undefined;
  }
}

function uniqueCanonical(values: readonly JsonObject[]): readonly JsonObject[] {
  const byCanonical = new Map(values.map((value) => [canonicalJson(value), value]));
  return [...byCanonical.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, value]) => value);
}

async function answerV2Command(request: CodexServerRequest, context: CodexApprovalBridgeContext): Promise<unknown> {
  const params = record(request.params);
  if (!sameTurn(params, context)) return { decision: "decline" };
  const itemId = string(params.itemId);
  const item = itemId === undefined ? undefined : context.items.get(itemId);
  if (item?.type !== "commandExecution") return { decision: "decline" };

  const network = optionalRecord(params.networkApprovalContext);
  if (network !== undefined) {
    const host = string(network.host);
    const protocol = string(network.protocol);
    const port = positivePort(network.port);
    // Codex 0.147 omits port, so its grouped destination cannot be represented
    // with the exact authority required by Relayer. Future complete shapes can
    // use this path only when the port is explicit.
    if (host === undefined || protocol === undefined || port === undefined) return { decision: "decline" };
    const input: HarnessApprovalRequestInput = {
      providerItemId: providerItemId(request, itemId),
      title: `Allow network access to ${host}:${port}`,
      reason: optionalString(params.reason) ?? "Codex requested managed network access.",
      action: {
        kind: "network",
        action: `Connect using ${protocol}`,
        networkDestination: `${host}:${port}`,
        ...(validAbsolutePath(optionalString(params.cwd)) === undefined ? {} : { workingDirectory: optionalString(params.cwd)! }),
      },
      scopeKeys: [scopeKey("network", {
        environmentId: nullableString(params.environmentId),
        host,
        protocol,
        port,
      })],
      scopeDescription: `Connect to ${host}:${port} using ${protocol} in this Codex session.`,
    };
    return answerV2Decision(input, context);
  }

  const source = string(item.source);
  // Unified exec can be PTY-backed, but this approval shape carries no tty bit.
  // Reusing it would silently broaden authority across terminal modes.
  if (source === undefined || source === "unifiedExecStartup" || source === "unifiedExecInteraction" || params.tty === true) {
    return { decision: "decline" };
  }
  const command = optionalString(params.command) ?? string(item.command);
  const cwd = optionalString(params.cwd) ?? string(item.cwd);
  const absoluteCwd = validAbsolutePath(cwd);
  if (command === undefined || absoluteCwd === undefined) return { decision: "decline" };
  if (optionalString(params.command) !== undefined && string(item.command) !== undefined && params.command !== item.command) {
    return { decision: "decline" };
  }
  if (optionalString(params.cwd) !== undefined && string(item.cwd) !== undefined && params.cwd !== item.cwd) {
    return { decision: "decline" };
  }
  if (!supportsOneRequestDecision(params.availableDecisions)) return { decision: "decline" };
  const additionalPermissions = params.additionalPermissions === undefined
    ? null
    : jsonValue(params.additionalPermissions);
  if (params.additionalPermissions !== undefined && additionalPermissions === undefined) return { decision: "decline" };
  if (additionalPermissions === null
    && absoluteCwd === resolve(context.workingDirectory)
    && context.trustedGraphAuthoringLauncher !== undefined
    && isExactGraphAuthoringLauncherCommand(command, context.trustedGraphAuthoringLauncher)) {
    return { decision: "accept" };
  }
  const input: HarnessApprovalRequestInput = {
    providerItemId: providerItemId(request, itemId),
    title: "Run command",
    reason: optionalString(params.reason) ?? "Codex needs approval to run this command.",
    action: { kind: "command", command, workingDirectory: absoluteCwd },
    scopeKeys: [scopeKey("command", {
      environmentId: nullableString(params.environmentId),
      command,
      cwd: absoluteCwd,
      sandboxPolicy: context.sandboxPolicy,
      additionalPermissions: additionalPermissions ?? null,
      source,
      tty: params.tty === false ? false : null,
    } satisfies JsonObject)],
    scopeDescription: `Run ${command} in ${absoluteCwd} with the displayed Codex sandbox authority for this session.`,
  };
  return answerV2Decision(input, context);
}

export function isExactGraphAuthoringLauncherCommand(command: string, launcherPath: string): boolean {
  if (!isAbsolute(launcherPath) || launcherPath.includes("\0") || launcherPath.includes("\n") || launcherPath.includes("\r")) {
    return false;
  }
  const prefix = `${JSON.stringify(launcherPath)} `;
  if (!command.startsWith(prefix)) return false;
  const opening = command.slice(prefix.length).match(/^<<'([A-Za-z_][A-Za-z0-9_]*)'[ \t]*\r?\n/);
  if (opening === null) return false;
  const delimiter = opening[1]!;
  const bodyAndClose = command.slice(prefix.length + opening[0].length);
  const lines = bodyAndClose.split(/\r?\n/);
  const closingLine = lines.pop();
  return closingLine === delimiter
    && lines.length > 0
    && !lines.some((line) => line === delimiter);
}

async function answerV2FileChange(request: CodexServerRequest, context: CodexApprovalBridgeContext): Promise<unknown> {
  const params = record(request.params);
  if (!sameTurn(params, context)) return { decision: "decline" };
  const itemId = string(params.itemId);
  const item = itemId === undefined ? undefined : context.items.get(itemId);
  if (item?.type !== "fileChange" || !Array.isArray(item.changes) || item.changes.length === 0) {
    return { decision: "decline" };
  }
  const changes = parseV2FileChanges(item.changes, context.workingDirectory);
  if (changes === undefined) return { decision: "decline" };
  const input: HarnessApprovalRequestInput = {
    providerItemId: providerItemId(request, itemId),
    title: changes.length === 1 ? "Apply file change" : `Apply ${changes.length} file changes`,
    reason: optionalString(params.reason) ?? "Codex needs approval to apply the proposed file changes.",
    action: {
      kind: "file_change",
      action: "Apply the proposed Codex patch",
      workingDirectory: context.workingDirectory,
      affectedFiles: changes.map(({ path }) => path),
    },
    scopeKeys: changes.map((change) => scopeKey("file", { path: change.path, kind: change.kind })),
    scopeDescription: `Apply changes to ${changes.map(({ path }) => path).join(", ")} in this Codex session.`,
  };
  return answerV2Decision(input, context);
}

async function answerLegacyCommand(request: CodexServerRequest, context: CodexApprovalBridgeContext): Promise<unknown> {
  const params = record(request.params);
  if (string(params.conversationId) !== context.threadId) return { decision: deniedLegacy("Wrong Codex thread.") };
  const command = stringArray(params.command);
  const cwd = string(params.cwd);
  const absoluteCwd = validAbsolutePath(cwd);
  if (command === undefined || command.length === 0 || absoluteCwd === undefined) {
    return { decision: deniedLegacy("Incomplete command authority.") };
  }
  const input: HarnessApprovalRequestInput = {
    providerItemId: providerItemId(request, string(params.callId)),
    title: "Run command",
    reason: optionalString(params.reason) ?? "Codex needs approval to run this command.",
    action: { kind: "command", command: displayArgv(command), workingDirectory: absoluteCwd },
    scopeKeys: [scopeKey("command", {
      environmentId: null,
      argv: command,
      cwd: absoluteCwd,
      sandboxPolicy: context.sandboxPolicy,
      additionalPermissions: null,
      source: "legacy",
      tty: false,
    } satisfies JsonObject)],
    scopeDescription: `Run ${displayArgv(command)} in ${absoluteCwd} with the displayed Codex sandbox authority for this session.`,
  };
  return answerLegacyDecision(input, context);
}

async function answerLegacyPatch(request: CodexServerRequest, context: CodexApprovalBridgeContext): Promise<unknown> {
  const params = record(request.params);
  if (string(params.conversationId) !== context.threadId) return { decision: deniedLegacy("Wrong Codex thread.") };
  const changesRecord = optionalRecord(params.fileChanges);
  if (changesRecord === undefined || Object.keys(changesRecord).length === 0) {
    return { decision: deniedLegacy("Incomplete file-change authority.") };
  }
  const changes = parseLegacyFileChanges(changesRecord, context.workingDirectory);
  if (changes === undefined) return { decision: deniedLegacy("Incomplete file-change authority.") };
  const input: HarnessApprovalRequestInput = {
    providerItemId: providerItemId(request, string(params.callId)),
    title: changes.length === 1 ? "Apply file change" : `Apply ${changes.length} file changes`,
    reason: optionalString(params.reason) ?? "Codex needs approval to apply the proposed file changes.",
    action: {
      kind: "file_change",
      action: "Apply the proposed Codex patch",
      workingDirectory: context.workingDirectory,
      affectedFiles: changes.map(({ path }) => path),
    },
    scopeKeys: changes.map((change) => scopeKey("file", { path: change.path, kind: change.kind })),
    scopeDescription: `Apply changes to ${changes.map(({ path }) => path).join(", ")} in this Codex session.`,
  };
  return answerLegacyDecision(input, context);
}

async function answerToolUserInput(request: CodexServerRequest, context: CodexApprovalBridgeContext): Promise<unknown> {
  const params = record(request.params);
  if (!sameTurn(params, context) || params.isBlocking !== true || !Array.isArray(params.questions) || params.questions.length !== 1) {
    return { answers: {} };
  }
  const itemId = string(params.itemId);
  const item = itemId === undefined ? undefined : context.items.get(itemId);
  const question = optionalRecord(params.questions[0]);
  if (item?.type !== "mcpToolCall" || question === undefined || question.isSecret === true) return { answers: {} };
  const questionId = string(question.id);
  const labels = approvalOptionLabels(question.options);
  if (questionId === undefined || labels === undefined) return { answers: {} };
  const server = string(item.server);
  const tool = string(item.tool);
  const argumentsValue = jsonValue(item.arguments);
  if (server === undefined || tool === undefined || argumentsValue === undefined) return { answers: {} };

  const input: HarnessApprovalRequestInput = {
    providerItemId: providerItemId(request, itemId),
    title: `Allow ${server}.${tool}`,
    reason: optionalString(question.question) ?? "Codex requested approval for an app tool call.",
    action: { kind: "other", action: `Call ${server}.${tool}` },
    scopeKeys: [scopeKey("mcp", {
      server,
      tool,
      arguments: argumentsValue,
      appContext: jsonValue(item.appContext) ?? null,
      readOnlyHint: typeof item.readOnlyHint === "boolean" ? item.readOnlyHint : null,
    })],
    scopeDescription: `Call ${server}.${tool} with the displayed exact arguments in this Codex session.`,
  };
  try {
    const decision = await requestApproval(input, context);
    const label = decision.decision === "deny" ? labels.decline : labels.accept;
    return { answers: { [questionId]: { answers: [label] } } };
  } catch (error) {
    if (error instanceof HarnessApprovalRequestTerminatedError) {
      return { answers: { [questionId]: { answers: [labels.cancel ?? labels.decline] } } };
    }
    throw error;
  }
}

async function answerV2Decision(input: HarnessApprovalRequestInput, context: CodexApprovalBridgeContext): Promise<unknown> {
  try {
    const decision = await requestApproval(input, context);
    return { decision: decision.decision === "deny" ? "decline" : "accept" };
  } catch (error) {
    if (error instanceof HarnessApprovalRequestTerminatedError) return { decision: "cancel" };
    throw error;
  }
}

async function answerLegacyDecision(input: HarnessApprovalRequestInput, context: CodexApprovalBridgeContext): Promise<unknown> {
  try {
    const decision = await requestApproval(input, context);
    return { decision: decision.decision === "deny" ? deniedLegacy(decision.rationale) : "approved" };
  } catch (error) {
    if (error instanceof HarnessApprovalRequestTerminatedError) return { decision: "abort" };
    throw error;
  }
}

function requestApproval(input: HarnessApprovalRequestInput, context: CodexApprovalBridgeContext): Promise<HarnessApprovalDecision> {
  return context.approvals.request(input, context.signal === undefined ? undefined : {
    signal: context.signal,
    terminationOutcome: "aborted",
    terminationRationale: "Codex cleared the provider approval request.",
  });
}

function parseV2FileChanges(values: readonly unknown[], cwd: string): readonly FileScope[] | undefined {
  const parsed: FileScope[] = [];
  for (const value of values) {
    const change = optionalRecord(value);
    const path = change === undefined ? undefined : string(change.path);
    const kind = change === undefined ? undefined : parseV2ChangeKind(change.kind, cwd);
    if (path === undefined || kind === undefined) return undefined;
    parsed.push({ path: absolutePath(path, cwd), kind });
  }
  return parsed;
}

function parseLegacyFileChanges(values: Record<string, unknown>, cwd: string): readonly FileScope[] | undefined {
  const parsed: FileScope[] = [];
  for (const [path, value] of Object.entries(values)) {
    const change = optionalRecord(value);
    const type = change === undefined ? undefined : string(change.type);
    if (type !== "add" && type !== "delete" && type !== "update") return undefined;
    const movePath = type === "update" && change !== undefined && change.move_path !== null && change.move_path !== undefined
      ? string(change.move_path)
      : undefined;
    if (type === "update" && change?.move_path !== null && change?.move_path !== undefined && movePath === undefined) return undefined;
    parsed.push({
      path: absolutePath(path, cwd),
      kind: type === "update" && movePath !== undefined ? { type, movePath: absolutePath(movePath, cwd) } : { type },
    });
  }
  return parsed;
}

function parseV2ChangeKind(value: unknown, cwd: string): JsonObject | undefined {
  const kind = optionalRecord(value);
  const type = kind === undefined ? undefined : string(kind.type);
  if (type === "add" || type === "delete") return { type };
  if (type !== "update") return undefined;
  if (kind?.move_path === null || kind?.move_path === undefined) return { type };
  const movePath = string(kind.move_path);
  return movePath === undefined ? undefined : { type, movePath: absolutePath(movePath, cwd) };
}

interface FileScope {
  readonly path: string;
  readonly kind: JsonObject;
}

function approvalOptionLabels(value: unknown): { readonly accept: string; readonly decline: string; readonly cancel?: string } | undefined {
  if (!Array.isArray(value)) return undefined;
  let accept: string | undefined;
  let decline: string | undefined;
  let cancel: string | undefined;
  for (const option of value) {
    const label = string(optionalRecord(option)?.label);
    if (label === undefined) return undefined;
    switch (label.trim().toLowerCase()) {
      case "accept": accept = label; break;
      case "decline": decline = label; break;
      case "cancel": cancel = label; break;
      default: break;
    }
  }
  return accept === undefined || decline === undefined ? undefined : { accept, decline, ...(cancel === undefined ? {} : { cancel }) };
}

function supportsOneRequestDecision(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!Array.isArray(value)) return false;
  return value.includes("accept") && value.includes("decline");
}

function sameTurn(params: Record<string, unknown>, context: CodexApprovalBridgeContext): boolean {
  return string(params.threadId) === context.threadId && string(params.turnId) === context.turnId;
}

function providerItemId(request: CodexServerRequest, itemId: string | undefined): string {
  return `${request.method}:${String(request.id)}:${itemId ?? "unknown"}`;
}

function scopeKey(kind: string, authority: JsonValue): string {
  const digest = createHash("sha256").update(canonicalJson(authority)).digest("hex");
  return `codex:${kind}:v1:sha256:${digest}`;
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Readonly<Record<string, JsonValue>>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function displayArgv(argv: readonly string[]): string {
  return argv.map((argument) => /^[A-Za-z0-9_./:@%+=,-]+$/.test(argument) ? argument : JSON.stringify(argument)).join(" ");
}

function deniedLegacy(rejection = "Denied in Relayer."): { readonly denied: { readonly rejection: string } } {
  return { denied: { rejection } };
}

function absolutePath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function validAbsolutePath(value: string | undefined): string | undefined {
  return value !== undefined && isAbsolute(value) ? value : undefined;
}

function positivePort(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 65_535 ? value : undefined;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function boundedString(value: unknown): string | undefined {
  return typeof value === "string"
    && value.trim() !== ""
    && value === value.trim()
    && value.length <= MAX_CODEX_PERMISSION_TEXT_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : undefined;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return hasRequiredAndOnlyKeys(value, expected, []);
}

function hasRequiredAndOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  return required.every((key) => Object.hasOwn(value, key)) && hasOnlyKeys(value, [...required, ...optional]);
}

function validProviderRequestId(value: unknown): boolean {
  return typeof value === "number"
    ? Number.isSafeInteger(value)
    : boundedString(value) !== undefined;
}

function record(value: unknown): Record<string, unknown> {
  return optionalRecord(value) ?? {};
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : string(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : string(value) ?? null;
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

function jsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const entries = value.map(jsonValue);
    return entries.every((entry) => entry !== undefined) ? entries as JsonValue[] : undefined;
  }
  const object = optionalRecord(value);
  if (object === undefined) return undefined;
  const result: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(object)) {
    const parsed = jsonValue(child);
    if (parsed === undefined) return undefined;
    result[key] = parsed;
  }
  return result;
}
