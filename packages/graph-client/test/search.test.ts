import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GraphApiError,
  GraphQueryError,
  RelayerGraphClient,
  type GraphSearchRequest,
  type GraphSearchResult,
} from "../src/index.js";

const golden = JSON.parse(readFileSync(new URL("./graph-search-wire-golden.json", import.meta.url), "utf8")) as {
  request: GraphSearchRequest;
  result: GraphSearchResult;
  contractError: unknown;
  unavailableError: unknown;
};

describe("current-thread graph search client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves every tagged recursive value and deterministic result order", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(golden.result), { status: 200 })));
    const result = await client().search(golden.request);

    expect(result).toEqual(golden.result);
    expect(result.columns).toEqual(["null", "boolean", "integer", "float", "string", "node", "layer", "relationship", "path", "list", "record"]);
    expect(result.rows[0]?.[2]).toEqual({ type: "integer", value: "9223372036854775807" });
    expect(result.rows[0]?.[8]?.type).toBe("path");
    expect(result.rows[0]?.[9]?.type).toBe("list");
    expect(result.rows[0]?.[10]?.type).toBe("record");
    expect(result.truncated).toBe(true);
  });

  it("serializes only the four public fields and forwards AbortSignal", async () => {
    let serialized: Record<string, unknown> | undefined;
    let actualSignal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      serialized = JSON.parse(String(init.body)) as Record<string, unknown>;
      actualSignal = init.signal;
      return new Response(JSON.stringify(golden.result), { status: 200 });
    }));
    const controller = new AbortController();
    const hostile = {
      ...golden.request,
      target: { scope: "project", id: 99 }, scope: "project", projectId: 99,
      threadId: 88, permit: "forged", token: "leak",
    } as GraphSearchRequest;

    await client().search(hostile, { signal: controller.signal });

    expect(serialized).toEqual(golden.request);
    expect(Object.keys(serialized ?? {})).toEqual(["queryContractVersion", "query", "parameters", "budget"]);
    expect(actualSignal).toBe(controller.signal);

    await client().search({
      queryContractVersion: 1,
      query: golden.request.query,
    } as GraphSearchRequest);
    expect(serialized).toEqual({
      queryContractVersion: 1,
      query: golden.request.query,
      parameters: {},
      budget: {},
    });
  });

  it("normalizes contract errors without misclassifying API availability", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(golden.contractError), { status: 422 })));
    const contract = await client().search(golden.request).catch((error: unknown) => error);
    expect(contract).toBeInstanceOf(GraphQueryError);
    expect(contract).toMatchObject({ status: 422, code: "query_syntax_invalid", phase: "parse", path: "query" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(golden.unavailableError), { status: 503 })));
    const unavailable = await client().search(golden.request).catch((error: unknown) => error);
    expect(unavailable).toBeInstanceOf(GraphApiError);
    expect(unavailable).not.toBeInstanceOf(GraphQueryError);
    expect(unavailable).toMatchObject({ status: 503, code: "search_unavailable" });

    for (const error of [
      { error: { code: "search_unavailable", phase: "execute", path: "search", message: "offline" } },
      { error: { code: "future_query_failure", phase: "execute", path: "query", message: "future" } },
      { error: { code: "query_syntax_invalid", phase: "execute", path: "query", message: "wrong phase" } },
    ]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(error), { status: 503 })));
      const actual = await client().search(golden.request).catch((caught: unknown) => caught);
      expect(actual).toBeInstanceOf(GraphApiError);
      expect(actual).not.toBeInstanceOf(GraphQueryError);
    }
  });
});

function client(): RelayerGraphClient {
  return new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "secret", nodeId: 7 });
}
