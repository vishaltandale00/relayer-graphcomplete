import { describe, expect, it } from "vitest";

import {
  buildGraphOperationsViewModel,
  renderGraphOperationsMarkup,
} from "../desktop/eval-renderer/trace-model.js";

describe("Eval candidate trace graph-operation model", () => {
  it("preserves exact search contract evidence and response order, and represents missing evidence explicitly", () => {
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

    expect(model, "complete ledger shape").toMatchObject({ status: "complete", error: null, operationCount: 2 });
    expect(model.operations[0], "search contract evidence and response order").toEqual({
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
    expect(model.operations[1], "forbidden search keeps error codes and its own response order").toMatchObject({
      status: 403,
      errorCodes: ["capability_not_granted"],
      search: { responseOrderSequence: 19, returnedLayerIds: [] },
    });
    const markup = renderGraphOperationsMarkup(model);
    for (const fragment of [
      "Query contract version",
      "MATCH (l:Layer) WHERE l.id = $root RETURN l AS layer",
      "Tagged parameters",
      "$anchor",
      "integer",
      "Budget",
      "HTTP 403",
      "capability_not_granted",
      "layer:41",
      "Response-order sequence",
      "#18",
    ]) {
      expect(markup, `rendered markup shows ${fragment}`).toContain(fragment);
    }
    expect(markup, "markup never renders links").not.toContain("href=");

    expect(buildGraphOperationsViewModel({
      graphOperationsEvidence: {
        status: "unavailable",
        error: "Candidate trace lacks a complete graph-operation ledger.",
      },
      graphOperations: [],
    }), "missing evidence is explicit for every trace").toEqual({
      status: "unavailable",
      error: "Candidate trace lacks a complete graph-operation ledger.",
      operationCount: 0,
      operations: [],
    });
  });
});
