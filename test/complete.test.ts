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
  it("returns the configured runtime handle immediately for the exact prepared pointer", async () => {
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

      expect(returned).toBe(handle);
      expect(runtimeComplete).toHaveBeenCalledWith(inputGraph);
      await expect(returned.current.snapshot()).resolves.toBe(snapshot);
      resolveResult(layer);
      await expect(returned.result).resolves.toBe(layer);
    } finally {
      release();
    }
  });

  it("fails synchronously when no completion runtime owns the process binding", () => {
    expect(() => complete(inputGraph)).toThrow("completion runtime is not configured");
  });

  it("rejects competing runtime owners and releases the exact binding idempotently", () => {
    const handle = {
      completionId: 41,
      current: { snapshot: vi.fn() },
      result: Promise.resolve(layer),
      stop: vi.fn(),
    } satisfies CompletionHandle;
    const first: CompletionRuntime = { complete: () => handle };
    const second: CompletionRuntime = { complete: () => handle };
    const release = configureCompletionRuntime(first);
    try {
      expect(() => configureCompletionRuntime(second)).toThrow("already configured");
    } finally {
      release();
      release();
    }
    const releaseSecond = configureCompletionRuntime(second);
    releaseSecond();
  });

  it("exposes stopped and failed terminal state without fabricating a result layer", async () => {
    const current: CompletionCurrentSnapshot = {
      completionId: 41,
      lifecycle: "stopped",
      revision: 3,
      currentLayerId: 6,
      finalLayerId: null,
      safeReason: "cancelled",
    };
    const terminal = new CompletionTerminalError(41, "stopped", current, "cancelled");
    const handle: CompletionHandle = {
      completionId: 41,
      current: { snapshot: async () => current },
      result: Promise.reject(terminal),
      stop: async () => {},
    };
    const release = configureCompletionRuntime({ complete: () => handle });
    try {
      await expect(complete(inputGraph).result).rejects.toBe(terminal);
      expect(terminal).toMatchObject({ completionId: 41, lifecycle: "stopped", current, reason: "cancelled" });
    } finally {
      release();
    }
  });

  it("uses the execution-scoped broker while returning the prepared completion ID synchronously", async () => {
    vi.stubEnv("RELAYER_COMPLETE_URL", "http://127.0.0.1:43125/api/completions");
    vi.stubEnv("RELAYER_COMPLETE_TOKEN", "broker-token");
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ interactionNode: 41 });
        return new Response(JSON.stringify({ completionId: 41 }), { status: 201 });
      }
      if (url.endsWith("/current")) {
        return new Response(JSON.stringify(activeCurrent(2)), { status: 200 });
      }
      return new Response(JSON.stringify(layer), { status: 200 });
    }));

    const handle = complete(inputGraph);

    expect(handle.completionId).toBe(41);
    await expect(handle.current.snapshot()).resolves.toMatchObject({
      completionId: 41,
      lifecycle: "active",
      revision: 2,
    });
    await expect(handle.result).resolves.toEqual(layer);
    expect(requests[0]).toBe("POST http://127.0.0.1:43125/api/completions");
  });

  it("preserves a safe broker error detail when child launch is rejected", async () => {
    stubBroker([], {
      start: new Response(JSON.stringify({ error: "The source interaction has no model selection to inherit." }), {
        status: 422,
        headers: { "content-type": "application/json" },
      }),
    });

    await expect(complete(inputGraph).result).rejects.toThrow(
      "Completion broker returned HTTP 422: The source interaction has no model selection to inherit.",
    );
  });

  it("does not expose broker detail from a server failure", async () => {
    stubBroker([], {
      start: new Response(JSON.stringify({ error: "/private/runtime/provider-secret" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    });

    await expect(complete(inputGraph).result).rejects.toThrow(/^Completion broker returned HTTP 500$/u);
  });

  it("observes nothing until the child result is actually awaited", async () => {
    const requests = stubBroker([new Response(JSON.stringify(layer), { status: 200 })]);

    const handle = complete(inputGraph);
    await Promise.resolve();

    expect(requests.filter((request) => request.includes("/result"))).toEqual([]);
    await expect(handle.result).resolves.toEqual(layer);
    expect(requests.filter((request) => request.includes("/result"))).toHaveLength(1);
  });

  it("carries each observed revision forward instead of polling on a timer", async () => {
    const requests = stubBroker([
      new Response(JSON.stringify({ current: activeCurrent(3) }), { status: 202 }),
      new Response(JSON.stringify({ current: activeCurrent(4) }), { status: 202 }),
      new Response(JSON.stringify(layer), { status: 200 }),
    ]);

    await expect(complete(inputGraph).result).resolves.toEqual(layer);

    expect(requests.filter((request) => request.includes("/result"))).toEqual([
      "GET http://127.0.0.1:43125/api/completions/41/result",
      "GET http://127.0.0.1:43125/api/completions/41/result?afterRevision=3",
      "GET http://127.0.0.1:43125/api/completions/41/result?afterRevision=4",
    ]);
  });

  it("awaits the same observation once however often the result is read", async () => {
    const requests = stubBroker([new Response(JSON.stringify(layer), { status: 200 })]);

    const handle = complete(inputGraph);
    await Promise.all([handle.result, handle.result, handle.result]);

    expect(requests.filter((request) => request.includes("/result"))).toHaveLength(1);
  });

  it("leaves an unawaited handle silent rather than raising an unhandled rejection", async () => {
    const requests = stubBroker([], { start: new Response("{}", { status: 500 }) });

    complete(inputGraph);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requests).toEqual(["POST http://127.0.0.1:43125/api/completions"]);
  });

  it("stops the child it invoked through the execution-scoped broker", async () => {
    const bodies: unknown[] = [];
    const requests = stubBroker([], {
      stop: (body) => {
        bodies.push(body);
        return new Response(JSON.stringify({ cancelled: true, lifecycle: "stopped" }), { status: 200 });
      },
    });

    await complete(inputGraph).stop("the parent no longer needs this branch");

    expect(requests).toEqual([
      "POST http://127.0.0.1:43125/api/completions",
      "POST http://127.0.0.1:43125/api/completions/41/stop",
    ]);
    expect(bodies).toEqual([{ reason: "the parent no longer needs this branch" }]);
  });

  it("rejects a stop that the broker refuses", async () => {
    stubBroker([], { stop: () => new Response("{}", { status: 400 }) });

    await expect(complete(inputGraph).stop("no longer needed")).rejects.toThrow("HTTP 400");
  });

  it("rejects malformed broker current snapshots instead of coercing identity fields", async () => {
    vi.stubEnv("RELAYER_COMPLETE_URL", "http://127.0.0.1:43125/api/completions");
    vi.stubEnv("RELAYER_COMPLETE_TOKEN", "broker-token");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ completionId: 41 }), { status: 201 });
      }
      if (String(_url).endsWith("/current")) {
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

    const handle = complete(inputGraph);
    await expect(handle.current.snapshot()).rejects.toThrow("invalid current snapshot");
    await expect(handle.result).resolves.toEqual(layer);
  });
});
