import { afterEach, describe, expect, it, vi } from "vitest";
import { CompletionTerminalError, complete, configureCompletionRuntime } from "../src/index.js";
import type {
  CompletionCurrentSnapshot,
  CompletionHandle,
  CompletionInputGraph,
  CompletionRuntime,
  ResolvedGraphLayer,
} from "../src/index.js";

const inputGraph: CompletionInputGraph = { interactionNode: 41 };
const layer: ResolvedGraphLayer = {
  layer: {
    id: 7,
    nodes: [8],
    edges: [],
    layout: { version: 1, placements: [{ nodeId: 8, x: 0.5, y: 0.5 }] },
    state: "accepted",
  },
  nodes: [{ id: 8, kind: "answer", icon: "info", title: "Answer", detail: "Done", state: "accepted" }],
  edges: [],
  actions: [],
};

function activeCurrent(revision: number): Record<string, unknown> {
  return {
    completionId: 41,
    lifecycle: "active",
    headRevision: revision,
    currentLayerId: 6,
    finalLayerId: null,
  };
}

/** Stubs the broker with a scripted sequence of result observations. */
function stubBroker(
  observations: readonly Response[],
  overrides: { readonly start?: Response; readonly stop?: (body: unknown) => Response } = {},
): string[] {
  vi.stubEnv("RELAYER_COMPLETE_URL", "http://127.0.0.1:43125/api/completions");
  vi.stubEnv("RELAYER_COMPLETE_TOKEN", "broker-token");
  const requests: string[] = [];
  const remaining = [...observations];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    requests.push(`${init?.method ?? "GET"} ${url}`);
    if (String(url).endsWith("/stop")) {
      const stop = overrides.stop ?? (() => new Response("{}", { status: 200 }));
      return stop(JSON.parse(String(init?.body ?? "null")));
    }
    if (init?.method === "POST") {
      return overrides.start ?? new Response(JSON.stringify({ completionId: 41 }), { status: 201 });
    }
    const next = remaining.shift();
    if (next === undefined) throw new Error(`unscripted broker request: ${url}`);
    return next;
  }));
  return requests;
}

describe("complete", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("owns one completion runtime binding through terminal states, competing owners, and idempotent release", async () => {
    expect(() => complete(inputGraph), "no runtime owns the process binding yet")
      .toThrow("completion runtime is not configured");

    const current: CompletionCurrentSnapshot = {
      completionId: 41,
      lifecycle: "stopped",
      revision: 3,
      currentLayerId: 6,
      finalLayerId: null,
      safeReason: "cancelled",
    };
    const terminal = new CompletionTerminalError(41, "stopped", current, "cancelled");
    const terminalHandle: CompletionHandle = {
      completionId: 41,
      current: { snapshot: async () => current },
      result: Promise.reject(terminal),
      stop: async () => {},
    };
    const releaseTerminal = configureCompletionRuntime({ complete: () => terminalHandle });
    try {
      await expect(complete(inputGraph).result, "stopped terminal state surfaces without a fabricated layer")
        .rejects.toBe(terminal);
      expect(terminal, "terminal error carries the snapshot and reason").toMatchObject({
        completionId: 41,
        lifecycle: "stopped",
        current,
        reason: "cancelled",
      });
    } finally {
      releaseTerminal();
    }

    let resolveResult!: (result: ResolvedGraphLayer) => void;
    const result = new Promise<ResolvedGraphLayer>((resolve) => { resolveResult = resolve; });
    const snapshot: CompletionCurrentSnapshot = {
      completionId: 41,
      lifecycle: "active",
      revision: 2,
      currentLayerId: 6,
      finalLayerId: null,
    };
    const handle: CompletionHandle = Object.freeze({
      completionId: 41,
      current: Object.freeze({ snapshot: vi.fn(async () => snapshot) }),
      result,
      stop: vi.fn(async () => {}),
    });
    const runtimeComplete = vi.fn(() => handle);
    const release = configureCompletionRuntime({ complete: runtimeComplete });
    try {
      const returned = complete(inputGraph);
      expect(returned, "exact prepared handle returned").toBe(handle);
      expect(runtimeComplete, "runtime receives the input graph").toHaveBeenCalledWith(inputGraph);
      await expect(returned.current.snapshot(), "snapshot exposed from the runtime handle").resolves.toBe(snapshot);
      resolveResult(layer);
      await expect(returned.result, "result exposed from the runtime handle").resolves.toBe(layer);

      const second: CompletionRuntime = { complete: () => handle };
      expect(() => configureCompletionRuntime(second), "competing runtime owner rejected")
        .toThrow("already configured");
    } finally {
      release();
      release();
    }

    const releaseSecond = configureCompletionRuntime({ complete: () => handle } satisfies CompletionRuntime);
    releaseSecond();
    expect(() => complete(inputGraph), "binding released for the next owner")
      .toThrow("completion runtime is not configured");
  });

  it("observes broker results lazily, carries revisions forward, and never fabricates or leaks detail", async () => {
    vi.stubEnv("RELAYER_COMPLETE_URL", "http://127.0.0.1:43125/api/completions");
    vi.stubEnv("RELAYER_COMPLETE_TOKEN", "broker-token");
    const scopedRequests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      scopedRequests.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "POST") {
        expect(JSON.parse(String(init.body)), "start body carries the input pointer").toEqual({ interactionNode: 41 });
        return new Response(JSON.stringify({ completionId: 41 }), { status: 201 });
      }
      if (url.endsWith("/current")) {
        return new Response(JSON.stringify(activeCurrent(2)), { status: 200 });
      }
      return new Response(JSON.stringify(layer), { status: 200 });
    }));

    const scopedHandle = complete(inputGraph);
    expect(scopedHandle.completionId, "prepared completion ID returned synchronously").toBe(41);
    await expect(scopedHandle.current.snapshot(), "execution-scoped current snapshot").resolves.toMatchObject({
      completionId: 41,
      lifecycle: "active",
      revision: 2,
    });
    await expect(scopedHandle.result, "result resolved through the broker").resolves.toEqual(layer);
    expect(scopedRequests[0], "start uses the execution-scoped broker").toBe("POST http://127.0.0.1:43125/api/completions");

    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ completionId: 41 }), { status: 201 });
      }
      if (String(url).endsWith("/current")) {
        return new Response(JSON.stringify({
          completionId: 41,
          lifecycle: "active",
          headRevision: "2",
          currentLayerId: 6,
          finalLayerId: null,
        }), { status: 200 });
      }
      return new Response(JSON.stringify(layer), { status: 200 });
    }));
    const malformedHandle = complete(inputGraph);
    await expect(malformedHandle.current.snapshot(), "malformed snapshot rejected instead of coercing identity fields")
      .rejects.toThrow("invalid current snapshot");
    await expect(malformedHandle.result, "result unaffected by the malformed snapshot").resolves.toEqual(layer);

    const lazyRequests = stubBroker([new Response(JSON.stringify(layer), { status: 200 })]);
    const lazyHandle = complete(inputGraph);
    await Promise.resolve();
    expect(lazyRequests.filter((request) => request.includes("/result")), "nothing observed until the result is awaited").toEqual([]);
    await expect(lazyHandle.result, "lazy observation resolves the layer").resolves.toEqual(layer);
    expect(lazyRequests.filter((request) => request.includes("/result")), "one observation after await").toHaveLength(1);

    const revisionRequests = stubBroker([
      new Response(JSON.stringify({ current: activeCurrent(3) }), { status: 202 }),
      new Response(JSON.stringify({ current: activeCurrent(4) }), { status: 202 }),
      new Response(JSON.stringify(layer), { status: 200 }),
    ]);
    await expect(complete(inputGraph).result, "revision chain resolves").resolves.toEqual(layer);
    expect(revisionRequests.filter((request) => request.includes("/result")), "each observed revision carried forward").toEqual([
      "GET http://127.0.0.1:43125/api/completions/41/result",
      "GET http://127.0.0.1:43125/api/completions/41/result?afterRevision=3",
      "GET http://127.0.0.1:43125/api/completions/41/result?afterRevision=4",
    ]);

    const sharedRequests = stubBroker([new Response(JSON.stringify(layer), { status: 200 })]);
    const sharedHandle = complete(inputGraph);
    await Promise.all([sharedHandle.result, sharedHandle.result, sharedHandle.result]);
    expect(sharedRequests.filter((request) => request.includes("/result")), "repeated reads await one observation").toHaveLength(1);

    const silentRequests = stubBroker([], { start: new Response("{}", { status: 500 }) });
    complete(inputGraph);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(silentRequests, "unawaited handle stays silent instead of raising an unhandled rejection")
      .toEqual(["POST http://127.0.0.1:43125/api/completions"]);

    stubBroker([], {
      start: new Response(JSON.stringify({ error: "The source interaction has no model selection to inherit." }), {
        status: 422,
        headers: { "content-type": "application/json" },
      }),
    });
    await expect(complete(inputGraph).result, "safe broker detail preserved for rejected child launch").rejects.toThrow(
      "Completion broker returned HTTP 422: The source interaction has no model selection to inherit.",
    );

    stubBroker([], {
      start: new Response(JSON.stringify({ error: "/private/runtime/provider-secret" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    });
    await expect(complete(inputGraph).result, "server failure detail never exposed").rejects.toThrow(/^Completion broker returned HTTP 500$/u);
  });

  it("stops the child it invoked through the broker and surfaces broker refusal", async () => {
    const bodies: unknown[] = [];
    const stopRequests = stubBroker([], {
      stop: (body) => {
        bodies.push(body);
        return new Response(JSON.stringify({ cancelled: true, lifecycle: "stopped" }), { status: 200 });
      },
    });

    await complete(inputGraph).stop("the parent no longer needs this branch");

    expect(stopRequests, "stop posts to the started completion").toEqual([
      "POST http://127.0.0.1:43125/api/completions",
      "POST http://127.0.0.1:43125/api/completions/41/stop",
    ]);
    expect(bodies, "stop carries the exact reason").toEqual([{ reason: "the parent no longer needs this branch" }]);

    stubBroker([], { stop: () => new Response("{}", { status: 400 }) });
    await expect(complete(inputGraph).stop("no longer needed"), "broker refusal rejects the stop")
      .rejects.toThrow("HTTP 400");
  });
});
