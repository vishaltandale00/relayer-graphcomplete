import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
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
    const work = fetch(`${scope.url}/api/graph/authoring-errors`, {
      method: "POST", headers: { authorization: `Bearer ${scope.token}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(1_000),
      body: JSON.stringify({ schemaVersion: 1, id, phase: issues === undefined ? "client" : "compiler", codes: [...new Set(codes)].slice(0, 16) }),
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
  const { RELAYER_GRAPH_URL: url, RELAYER_GRAPH_TOKEN: token, RELAYER_NODE_ID: nodeId, RELAYER_GRAPH_AUTHORING_ERRORS: enabled } = process.env;
  if (enabled === "1" && url && token) {
    reportAuthoringError({ url, token, nodeId: Number(nodeId), authoringErrors: true }, error, compilerCodes);
    if (error instanceof Error) originErrors.add(error);
  }
}

/** Diagnostics never replace the original error or turn a rejected write into success. */
export function observeAuthoringMethods<T extends object>(client: T, scope: GraphCapability, isServerError: (error: unknown) => boolean): T {
  if (!scope.authoringErrors) return client;
  const promises = new WeakMap<Promise<unknown>, Promise<unknown>>();
  const methods = new Map<string, unknown>();
  const authoring = new Set(["bindNode", "checkpointNodeDetail", "submitNode", "createEdge", "createEdges", "submitLayer", "addAction", "discardLayer", "replaceNodePresentation", "advanceCurrent", "returnCurrent", "stopCurrent", "prepareComplete", "proposeThreadIcon", "submit"]);
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
