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
    const handle = { completionId: 41, current: { snapshot: vi.fn() }, result: Promise.resolve(layer) } satisfies CompletionHandle;
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
    let resultReads = 0;
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ interactionNode: 41 });
        return new Response(JSON.stringify({ completionId: 41 }), { status: 201 });
      }
      if (url.endsWith("/current")) {
        return new Response(JSON.stringify({
          completionId: 41,
          lifecycle: "active",
          headRevision: 2,
          currentLayerId: 6,
          finalLayerId: null,
        }), { status: 200 });
      }
      resultReads += 1;
      return resultReads === 1
        ? new Response(JSON.stringify({ current: {} }), { status: 202 })
        : new Response(JSON.stringify(layer), { status: 200 });
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
    expect(resultReads).toBe(2);
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
