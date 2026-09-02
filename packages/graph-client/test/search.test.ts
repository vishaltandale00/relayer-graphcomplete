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

function client(): RelayerGraphClient {
  return new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "secret", nodeId: 7 });
}

describe("graph search client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips the golden wire contract through hygienic requests", async () => {
    // Checkpoint: the golden result survives with every tagged value and deterministic order.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(golden.result), { status: 200 })));
    const result = await client().search(golden.request);
    expect(result, "golden round trip").toEqual(golden.result);
    expect(result.columns, "canonical column order").toEqual(["null", "boolean", "integer", "float", "string", "node", "layer", "relationship", "path", "list", "record"]);
    expect(result.rows[0]?.[2], "int64 stays a tagged string").toEqual({ type: "integer", value: "9223372036854775807" });
    expect(result.rows[0]?.[8]?.type, "path value tag").toBe("path");
    expect(result.rows[0]?.[9]?.type, "list value tag").toBe("list");
    expect(result.rows[0]?.[10]?.type, "record value tag").toBe("record");
    expect(result.truncated, "truncation flag").toBe(true);

    // Checkpoint: hostile request fields are stripped, the target is resolved, and AbortSignal forwards.
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
      target: {
        scope: "project", id: 99, credential: "nested-leak", database: "graph.db",
      } as NonNullable<GraphSearchRequest["target"]> & Record<string, unknown>,
      projectId: 99,
      threadId: 88, permit: "forged", token: "leak",
    } satisfies GraphSearchRequest & Record<string, unknown>;
    await client().search(hostile, { signal: controller.signal });
    expect(serialized, "authority fields stripped").toEqual({ ...golden.request, target: { scope: "project", id: 99 } });
    expect(Object.keys(serialized ?? {}), "exact wire keys").toEqual(["queryContractVersion", "target", "query", "parameters", "budget"]);
    expect(actualSignal, "abort signal forwarded").toBe(controller.signal);

    const minimal: GraphSearchRequest = {
      queryContractVersion: 1,
      query: golden.request.query,
    };
    await client().search(minimal);
    expect(serialized, "minimal request defaults").toEqual({
      queryContractVersion: 1,
      query: golden.request.query,
      parameters: {},
      budget: {},
    });
  });

  it("fails closed on non-conforming errors and responses", async () => {
    // Checkpoint: 422 contract errors map to GraphQueryError with phase and path.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(golden.contractError), { status: 422 })));
    const contract = await client().search(golden.request).catch((error: unknown) => error);
    expect(contract, "contract error class").toBeInstanceOf(GraphQueryError);
    expect(contract, "contract error shape").toMatchObject({ status: 422, code: "query_syntax_invalid", phase: "parse", path: "query" });

    // Checkpoint: availability failures stay API errors and never become query errors.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(golden.unavailableError), { status: 503 })));
    const unavailable = await client().search(golden.request).catch((caught: unknown) => caught);
    expect(unavailable, "unavailable error class").toBeInstanceOf(GraphApiError);
    expect(unavailable, "unavailable is not a query error").not.toBeInstanceOf(GraphQueryError);
    expect(unavailable, "unavailable error shape").toMatchObject({ status: 503, code: "search_unavailable" });

    const availabilityCases: Array<[label: string, body: unknown]> = [
      ["execute-phase unavailable", { error: { code: "search_unavailable", phase: "execute", path: "search", message: "offline" } }],
      ["future failure code", { error: { code: "future_query_failure", phase: "execute", path: "query", message: "future" } }],
      ["query code with the wrong phase", { error: { code: "query_syntax_invalid", phase: "execute", path: "query", message: "wrong phase" } }],
    ];
    expect(availabilityCases, "availability corpus").toHaveLength(3);
    for (const [label, body] of availabilityCases) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 503 })));
      const actual = await client().search(golden.request).catch((caught: unknown) => caught);
      expect.soft(actual, `${label}: api error class`).toBeInstanceOf(GraphApiError);
      expect.soft(actual, `${label}: not a query error`).not.toBeInstanceOf(GraphQueryError);
    }

    // Checkpoint: successful responses must be exactly query contract v1.
    const versionCases: Array<[label: string, body: unknown]> = [
      ["future contract version", { ...golden.result, queryContractVersion: 2 }],
      ["missing contract version", { columns: [], rows: [], truncated: false }],
      ["string contract version", { ...golden.result, queryContractVersion: "1" }],
      ["boolean contract version", { ...golden.result, queryContractVersion: true }],
      ["fractional contract version", { ...golden.result, queryContractVersion: 1.5 }],
    ];
    expect(versionCases, "contract version corpus").toHaveLength(5);
    for (const [label, body] of versionCases) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
      const actual = await client().search(golden.request).catch((caught: unknown) => caught);
      expect.soft(actual, `${label}: api error class`).toBeInstanceOf(GraphApiError);
      expect.soft(actual, `${label}: not a query error`).not.toBeInstanceOf(GraphQueryError);
      expect.soft(actual, `${label}: invalid response shape`).toMatchObject({
        status: 200,
        code: "invalid_search_response",
        path: "queryContractVersion",
      });
    }
  });
});
