import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { constants, closeSync, openSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { GraphCapability } from "./types.js";

// Client reports are unattested; the graph token establishes attribution, not incident truth.
// The SDK sends fixed codes rather than arguments, authored text, stacks, or credentials.
const reported = new WeakMap<object, string>();
const originErrors = new WeakSet<object>();
const pending = new Set<Promise<void>>();
interface Attempt { readonly scope: GraphCapability; readonly reported: WeakMap<object, string> }
const scopes = new AsyncLocalStorage<Attempt>();
const transportErrors = new WeakSet<object>();
export function markAuthoringTransportError(error: unknown): void {
  if (error instanceof Error) transportErrors.add(error);
}
// Fixed slots bound SDK-produced spool bytes to 256 KiB in the existing turn-owned folder.
// Authored processes can populate it: these are still unattested client reports.
const SPOOL_SLOTS = 256;
const SPOOL_BYTES = 1_024;
interface Diagnostic { schemaVersion: 1; id: string; phase: "client" | "compiler"; codes: string[] }
function spoolPath(directory: string, slot: number): string { return join(directory, `authoring-error-${slot}.json`); }
function saveDiagnostic(scope: GraphCapability, body: string): void {
  if (scope.programDirectory === undefined || Buffer.byteLength(body) > SPOOL_BYTES) return;
  for (let slot = 0; slot < SPOOL_SLOTS; slot += 1) {
    let descriptor: number;
    try {
      // Never recreate a removed turn directory or follow an authored file symlink.
      descriptor = openSync(spoolPath(scope.programDirectory, slot), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      return;
    }
    try { writeFileSync(descriptor, body); } finally { closeSync(descriptor); }
    return;
  }
}
function validDiagnostic(value: unknown): value is Diagnostic {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every(key => ["schemaVersion", "id", "phase", "codes"].includes(key))
    && item.schemaVersion === 1 && typeof item.id === "string" && /^[0-9a-f-]{36}$/.test(item.id)
    && ["client", "compiler"].includes(String(item.phase)) && Array.isArray(item.codes)
    && item.codes.length > 0 && item.codes.length <= 16 && item.codes.every(code =>
      (item.phase === "client" ? ["invalid_arguments", "client_validation"] : ["compiler_validation", "unsafe_css", "detail_template_nested"]).includes(code));
}
/** Host cleanup only: deliver surviving reports before revoking this completion's capability. */
export async function flushAuthoringErrors(scope: GraphCapability): Promise<void> {
  if (!scope.authoringErrors || scope.programDirectory === undefined) return;
  // One deadline for the entire drain; reporting never blocks completion indefinitely.
  const signal = AbortSignal.timeout(1_000);
  try {
    for (let slot = 0; slot < SPOOL_SLOTS && !signal.aborted; slot += 1) {
      let file;
      try {
        file = await open(spoolPath(scope.programDirectory, slot), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        if (!(await file.stat()).isFile()) continue;
        const buffer = Buffer.alloc(SPOOL_BYTES + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > SPOOL_BYTES) continue;
        const body = buffer.subarray(0, bytesRead).toString("utf8");
        if (!validDiagnostic(JSON.parse(body))) continue;
        await fetch(`${scope.url}/api/graph/authoring-errors`, {
          method: "POST", headers: { authorization: `Bearer ${scope.token}`, "content-type": "application/json" }, body, signal,
        });
      } catch (error) {
        // SDK slots fill from zero and remain until host cleanup. Normal turns have no spool;
        // avoid hundreds of asynchronous filesystem hops before sealing their trace.
        if (file === undefined && slot === 0 && (error as NodeJS.ErrnoException).code === "ENOENT") return;
        // Invalid bytes, other missing slots and failed delivery remain partial capture.
      }
      finally { await file?.close().catch(() => undefined); }
    }
  } catch { /* Diagnostics cannot replace completion's original outcome. */ }
}
export function reportAuthoringError(scope: GraphCapability, error: unknown, compilerCodes?: readonly string[]): void {
  if (!scope.authoringErrors || !(error instanceof Error) || transportErrors.has(error)) return;
  try {
    const issues = compilerCodes?.map((code) => ({ code })) ?? (error as Error & { issues?: readonly { code: string }[] }).issues;
    const codes = issues === undefined
      ? [error instanceof TypeError ? "invalid_arguments" : "client_validation"]
      : issues.map((issue) => ["unsafe_css", "detail_template_nested"].includes(issue.code) ? issue.code : "compiler_validation");
    if (codes.length === 0) codes.push("compiler_validation");
    const incidents = scopes.getStore()?.reported ?? reported;
    let id = incidents.get(error);
    if (id !== undefined) return;
    id = randomUUID();
    incidents.set(error, id);
    const body = JSON.stringify({ schemaVersion: 1, id, phase: issues === undefined ? "client" : "compiler", codes: [...new Set(codes)].slice(0, 16) });
    // Persist before starting asynchronous transport: a synchronous throw can terminate Node.
    try { saveDiagnostic(scope, body); } catch { /* Spool failure does not replace the original error. */ }
    const work = fetch(`${scope.url}/api/graph/authoring-errors`, {
      method: "POST", headers: { authorization: `Bearer ${scope.token}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(1_000),
      body,
    }).then(() => undefined, () => undefined);
    pending.add(work);
    void work.finally(() => pending.delete(work));
  } catch { /* Diagnostics cannot mask the original failure. */ }
}

export function reportEnvironmentAuthoringError(error: unknown, compilerCodes?: readonly string[]): void {
  const active = scopes.getStore();
  if (active !== undefined) {
    reportAuthoringError(active.scope, error, compilerCodes);
    if (active.scope.authoringErrors && error instanceof Error) originErrors.add(error);
    return;
  }
  const { RELAYER_GRAPH_URL: url, RELAYER_GRAPH_TOKEN: token, RELAYER_NODE_ID: nodeId, RELAYER_GRAPH_AUTHORING_ERRORS: enabled, RELAYER_GRAPH_PROGRAM_DIR: programDirectory } = process.env;
  if (enabled === "1" && url && token) {
    reportAuthoringError({ url, token, nodeId: Number(nodeId), authoringErrors: true, ...(programDirectory ? { programDirectory } : {}) }, error, compilerCodes);
    if (error instanceof Error) originErrors.add(error);
  }
}

/** Diagnostics never replace the original error or turn a rejected write into success. */
export function observeAuthoringMethods<T extends object>(client: T, scope: GraphCapability, isServerError: (error: unknown) => boolean): T {
  if (!scope.authoringErrors) return client;
  const promises = new WeakMap<Promise<unknown>, Promise<unknown>>();
  const methods = new Map<string, unknown>();
  const authoring = new Set(["authoring", "layer", "node", "artifactNode", "edge", "action", "include", "layout", "write", "bindNode", "checkpointNodeDetail", "submitNode", "createEdge", "createEdges", "submitLayer", "addAction", "discardLayer", "replaceNodePresentation", "advanceCurrent", "returnCurrent", "stopCurrent", "prepareComplete", "proposeThreadIcon", "submit"]);
  return new Proxy(client, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      if (typeof property !== "string" || !authoring.has(property)) return value.bind(target);
      if (methods.has(property)) return methods.get(property);
      const wrapped = (...args: unknown[]) => {
        const attempt: Attempt = { scope, reported: new WeakMap() };
        const fail = (error: unknown): never => {
          if (!isServerError(error) && !(error instanceof Error && originErrors.has(error))) scopes.run(attempt, () => reportAuthoringError(scope, error));
          throw error;
        };
        try {
          const result: unknown = scopes.run(attempt, () => value.apply(target, args));
          if (!(result instanceof Promise)) return result;
          let observed = promises.get(result);
          if (observed === undefined) { observed = result.catch(fail); promises.set(result, observed); }
          return observed;
        } catch (error) { return fail(error); }
      };
      methods.set(property, wrapped);
      return wrapped;
    },
  });
}
