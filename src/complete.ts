import {
  CompletionTerminalError,
  type CompletionCurrentSnapshot,
  type CompletionHandle,
  type CompletionInputGraph,
  type CompletionRuntime,
  type ResolvedGraphLayer,
} from "./contracts.js";

let configuredRuntime: CompletionRuntime | undefined;

/** Bind the process-local runtime behind canonical Complete. */
export function configureCompletionRuntime(runtime: CompletionRuntime): () => void {
  if (configuredRuntime !== undefined) {
    throw new Error("GraphComplete completion runtime is already configured");
  }
  configuredRuntime = runtime;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (configuredRuntime === runtime) configuredRuntime = undefined;
  };
}

/** Canonical external boundary for one already-prepared interaction pointer. */
export function complete(inputGraph: CompletionInputGraph): CompletionHandle {
  if (!Number.isSafeInteger(inputGraph.interactionNode) || inputGraph.interactionNode < 1) {
    throw new Error("complete() requires an already-prepared interactionNode");
  }
  return (configuredRuntime ?? completionRuntimeFromEnvironment()).complete(inputGraph);
}

function completionRuntimeFromEnvironment(environment: NodeJS.ProcessEnv = process.env): CompletionRuntime {
  const url = environment.RELAYER_COMPLETE_URL?.replace(/\/$/u, "");
  const token = environment.RELAYER_COMPLETE_TOKEN;
  if (!url || !token) throw new Error("GraphComplete completion runtime is not configured");
  return Object.freeze({
    complete(inputGraph: CompletionInputGraph): CompletionHandle {
      const completionId = inputGraph.interactionNode;
      const started = brokerRequest(url, token, "", {
        method: "POST",
        body: JSON.stringify({ interactionNode: completionId }),
      }).then((response) => {
        if (response.status !== 200 && response.status !== 201) throw brokerError(response);
        return response.json() as Promise<{ completionId: number }>;
      }).then((response) => {
        if (response.completionId !== completionId) {
          throw new Error("Completion broker returned a different completion identity");
        }
      });
      const snapshot = async (): Promise<CompletionCurrentSnapshot> => {
        await started;
        const response = await brokerRequest(url, token, `/${completionId}/current`);
        if (response.status !== 200) throw brokerError(response);
        return normalizeCurrent(await response.json());
      };
      const result = started.then(() => observeResult(url, token, completionId));
      return Object.freeze({
        completionId,
        current: Object.freeze({ snapshot }),
        result,
      });
    },
  });
}

async function observeResult(url: string, token: string, completionId: number): Promise<ResolvedGraphLayer> {
  for (;;) {
    const response = await brokerRequest(url, token, `/${completionId}/result`);
    const value = await response.json() as unknown;
    if (response.status === 200) return value as ResolvedGraphLayer;
    if (response.status === 202) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    if (response.status === 409 && isRecord(value) && isRecord(value.current)) {
      const current = normalizeCurrent(value.current);
      const lifecycle = current.lifecycle;
      if (lifecycle === "stopped" || lifecycle === "failed") {
        throw new CompletionTerminalError(
          completionId,
          lifecycle,
          current,
          typeof value.reason === "string" ? value.reason : "completion_failed",
        );
      }
    }
    throw new Error(`Completion broker returned HTTP ${response.status}`);
  }
}

function brokerRequest(url: string, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${url}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
}

function normalizeCurrent(value: unknown): CompletionCurrentSnapshot {
  const lifecycle = isRecord(value) ? String(value.lifecycle) : "";
  const revision = isRecord(value) ? value.headRevision ?? value.revision : undefined;
  if (!isRecord(value)
    || !Number.isSafeInteger(value.completionId)
    || Number(value.completionId) < 1
    || !["active", "succeeded", "stopped", "failed"].includes(lifecycle)
    || !Number.isSafeInteger(revision)
    || Number(revision) < 0
    || !isNullableGraphId(value.currentLayerId)
    || !isNullableGraphId(value.finalLayerId)
    || !(value.safeReason === undefined || value.safeReason === null || typeof value.safeReason === "string")) {
    throw new Error("Completion broker returned an invalid current snapshot");
  }
  return {
    completionId: value.completionId as number,
    lifecycle: lifecycle as CompletionCurrentSnapshot["lifecycle"],
    revision: revision as number,
    currentLayerId: value.currentLayerId as number | null,
    finalLayerId: value.finalLayerId as number | null,
    ...(typeof value.safeReason === "string" ? { safeReason: value.safeReason } : {}),
  };
}

function isNullableGraphId(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && Number(value) > 0);
}

function brokerError(response: Response): Error {
  return new Error(`Completion broker returned HTTP ${response.status}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
