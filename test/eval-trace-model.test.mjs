import { describe, expect, it } from "vitest";

import {
  buildGraphOperationsViewModel,
  renderGraphOperationsMarkup,
} from "../desktop/eval-renderer/trace-model.js";

describe("Eval candidate trace graph-operation model", () => {
  it("preserves exact search contract evidence and response order", () => {
    const model = buildGraphOperationsViewModel({
      graphOperationsEvidence: { status: "complete", error: null },
      graphOperations: [
        {
          sequence: 18,
          method: "POST",
          path: "/api/graph/search",
          status: 200,
          queryContractVersion: 1,
          query: "MATCH (l:Layer) WHERE l.id = $root RETURN l AS layer",
          parameters: {
            root: { type: "integer", value: 41 },
            anchor: { type: "string", value: "unique anchor" },
          },
          budget: { maxRows: 5, maxBytes: 16384 },
          searchLayerIds: [41, 52],
        },
        {
          sequence: 19,
          method: "POST",
          path: "/api/graph/search",
          status: 403,
          queryContractVersion: 1,
          query: "MATCH (l:Layer) RETURN l AS layer",
          parameters: {},
          budget: {},
          errorCodes: ["capability_not_granted"],
        },
      ],
    });

    expect(model).toMatchObject({ status: "complete", error: null, operationCount: 2 });
    expect(model.operations[0]).toEqual({
      sequence: 18,
      method: "POST",
      path: "/api/graph/search",
      status: 200,
      errorCodes: [],
      search: {
        queryContractVersion: 1,
        query: "MATCH (l:Layer) WHERE l.id = $root RETURN l AS layer",
        parameters: [
          { name: "anchor", type: "string", value: "unique anchor" },
          { name: "root", type: "integer", value: 41 },
        ],
        budget: { maxRows: 5, maxBytes: 16384 },
        returnedLayerIds: [41, 52],
        responseOrderSequence: 18,
      },
    });
    expect(model.operations[1]).toMatchObject({
      status: 403,
      errorCodes: ["capability_not_granted"],
      search: { responseOrderSequence: 19, returnedLayerIds: [] },
    });
    const markup = renderGraphOperationsMarkup(model);
    expect(markup).toContain("Query contract version");
    expect(markup).toContain("MATCH (l:Layer) WHERE l.id = $root RETURN l AS layer");
    expect(markup).toContain("Tagged parameters");
    expect(markup).toContain("$anchor");
    expect(markup).toContain("integer");
    expect(markup).toContain("Budget");
    expect(markup).toContain("HTTP 403");
    expect(markup).toContain("capability_not_granted");
    expect(markup).toContain("layer:41");
    expect(markup).toContain("Response-order sequence");
    expect(markup).toContain("#18");
    expect(markup).not.toContain("href=");
  });

  it("represents missing evidence explicitly for every trace", () => {
    expect(buildGraphOperationsViewModel({
      graphOperationsEvidence: {
        status: "unavailable",
        error: "Candidate trace lacks a complete graph-operation ledger.",
      },
      graphOperations: [],
    })).toEqual({
      status: "unavailable",
      error: "Candidate trace lacks a complete graph-operation ledger.",
      operationCount: 0,
      operations: [],
    });
  });
});
