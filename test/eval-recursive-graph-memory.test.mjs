import { describe, expect, it } from "vitest";

import { gradeRecursiveGraphMemoryExecution } from "../desktop/eval-main/eval-service.mjs";

function output(nodeId, layerId, actions = []) {
  return {
    nodeId,
    rootAction: {
      id: nodeId * 100,
      sourceNodeId: nodeId,
      sourceLayerId: null,
      kind: "navigate",
      relation: "expand",
      label: "Response",
      variant: "pill",
      targetLayerId: layerId,
      state: "accepted",
    },
    rootLayer: {
      layer: {
        id: layerId,
        nodes: [nodeId * 10],
        edges: [],
        layout: { version: 1, placements: [{ nodeId: nodeId * 10, x: 0.5, y: 0.5 }] },
        state: "accepted",
      },
      nodes: [{ id: nodeId * 10, kind: "concept", icon: "box", title: `Turn ${nodeId}`, detail: "Decision evidence", state: "accepted" }],
      edges: [],
      actions,
    },
  };
}

const reference = (id, nodeId, sourceLayerId, targetLayerId) => ({
  id,
  sourceNodeId: nodeId * 10,
  sourceLayerId,
  kind: "navigate",
  relation: "reference",
  label: "Supporting brief",
  variant: "pill",
  targetLayerId,
  state: "accepted",
});

const searchQuery = "MATCH (layer:Layer)-[:CONTAINS]->(content:Content) WHERE content.title = $topic RETURN layer LIMIT 1";

const search = (sequence, topic, layerId) => ({
  sequence,
  method: "POST",
  path: "/api/graph/search",
  status: 200,
  queryContractVersion: 1,
  query: searchQuery,
  parameters: { topic: { type: "string", value: topic } },
  budget: { resultRows: 1 },
  resultTruncated: false,
  searchLayerIds: [layerId],
});

async function gradeFixture(mutate = () => {}) {
  const outputs = [
    output(1, 101),
    output(2, 102, [reference(201, 2, 102, 101)]),
    output(3, 103, [
      reference(301, 3, 103, 101),
      reference(302, 3, 103, 102),
      {
        id: 303,
        sourceNodeId: 30,
        sourceLayerId: 103,
        kind: "invoke",
        relation: null,
        label: "Red-team stop condition",
        variant: "pill",
        targetLayerId: 201,
        state: "accepted",
      },
    ]),
  ];
  outputs[0].rootLayer.nodes[0].title = "Offline recovery covenant";
  outputs[1].rootLayer.nodes[0].title = "Constrained recovery revision";
  outputs[2].rootLayer.nodes[0].title = "Red-team stop condition";
  outputs[2].rootLayer.nodes[0].detail = "Launch stops if any stale grant survives a verified rotation and rollback cycle.";
  const interactions = outputs.map((completionOutput, index) => ({
    interaction: { id: index + 1, graphNodeId: index + 1, completionOutput },
  }));
  const events = [
    [{ sequence: 10, method: "POST", path: "/api/graph/submit", status: 200, completionNodeId: 1 }],
    [
      search(20, "Offline recovery covenant", 101),
      { sequence: 21, method: "POST", path: "/api/graph/actions", status: 200, recordId: 201, actionKind: "navigate", actionRelation: "reference", actionSourceNodeId: 20, actionSourceLayerId: 102, actionTargetLayerId: 101 },
      { sequence: 22, method: "POST", path: "/api/graph/submit", status: 200, completionNodeId: 2 },
    ],
    [
      search(30, "Offline recovery covenant", 101),
      search(31, "Constrained recovery revision", 102),
      { sequence: 32, method: "POST", path: "/api/graph/actions", status: 200, recordId: 301, actionKind: "navigate", actionRelation: "reference", actionSourceNodeId: 30, actionSourceLayerId: 103, actionTargetLayerId: 101 },
      { sequence: 33, method: "POST", path: "/api/graph/actions", status: 200, recordId: 302, actionKind: "navigate", actionRelation: "reference", actionSourceNodeId: 30, actionSourceLayerId: 103, actionTargetLayerId: 102 },
      { sequence: 35, method: "POST", path: "/api/graph/submit", status: 200, completionNodeId: 3 },
    ],
  ];
  const execution = {
    harnessConfiguration: {
      graphCapabilityProfile: { search: "query-v1" },
      complete: { agentAuthored: true },
    },
    turns: [0, 1, 2].map(() => ({ candidateTrace: { completionBrokerAvailable: true } })),
    semanticChildren: [{
      sourceInteractionId: 3,
      sourceActionId: 303,
      rootLayerId: 201,
      acceptedRootNodes: [{
        id: 2001,
        title: "Red-team stop condition",
        detail: "Launch stops if any stale grant survives a verified rotation and rollback cycle.",
      }],
    }],
  };
  mutate({ outputs, interactions, events, execution });
  const turnIndex = new Map(execution.turns.map((turn, index) => [turn, index]));
  return gradeRecursiveGraphMemoryExecution({
    execution,
    interactions,
    loadGraphOperations: (turn) => events[turnIndex.get(turn)],
  });
}

const failedChecks = (grade) => grade.turns.flatMap((turn) => turn.checks).filter((check) => !check.passed);
const checkPassed = (grade, turnIndex, name) => (
  grade.turns[turnIndex].checks.find((check) => check.name === name)?.passed
);

describe("recursive graph-memory Eval evidence", () => {
  it("accepts clean search-and-retain evidence across capability cells and declared safe variants", async () => {
    const baseline = await gradeFixture();
    expect(failedChecks(baseline), JSON.stringify(failedChecks(baseline), null, 2)).toEqual([]);
    expect(baseline.turns[2].evidence, "final turn names its searches and required prior roots").toMatchObject({
      successfulSearchCount: 2,
      searchedLayerIds: [101, 102],
      requiredPriorRoots: [101, 102],
    });
    expect(baseline.turns, "every turn is graded").toHaveLength(3);

    const capabilityCells = [
      ["search-disabled recursion-disabled", "disabled", false],
      ["search-query-v1 recursion-disabled", "query-v1", false],
      ["search-disabled recursion-enabled", "disabled", true],
      ["search-query-v1 recursion-enabled", "query-v1", true],
    ];
    expect(capabilityCells, "capability 2x2 inventory").toHaveLength(4);
    for (const [label, searchMode, agentAuthored] of capabilityCells) {
      const grade = await gradeFixture(({ outputs, events, execution }) => {
        execution.harnessConfiguration = {
          graphCapabilityProfile: { search: searchMode },
          complete: { agentAuthored },
        };
        execution.turns.forEach((turn) => {
          turn.candidateTrace.completionBrokerAvailable = agentAuthored;
        });
        if (searchMode === "disabled") {
          for (const turnEvents of events) {
            for (let index = turnEvents.length - 1; index >= 0; index -= 1) {
              if (turnEvents[index].path === "/api/graph/search") turnEvents.splice(index, 1);
            }
          }
        }
        if (!agentAuthored) {
          execution.semanticChildren = [];
          const invoke = outputs[2].rootLayer.actions.find((action) => action.kind === "invoke");
          invoke.targetLayerId = null;
        }
      });
      const failures = failedChecks(grade);
      expect(failures, `${label}: ${JSON.stringify(failures, null, 2)}`).toEqual([]);
    }

    const acceptedVariants = [
      ["server-default row budget when the query omits an override", ({ events }) => {
        delete events[1][0].budget;
        delete events[2][0].budget;
        delete events[2][1].budget;
      }],
      ["final optional graph-query semicolon", ({ events }) => {
        events[1][0].query += ";  ";
        events[2][0].query += ";";
        events[2][1].query += ";";
      }],
      ["zero recorded children in a recursion-enabled cell", ({ execution }) => {
        execution.semanticChildren = [];
      }],
    ];
    expect(acceptedVariants, "accepted variant inventory").toHaveLength(3);
    for (const [label, mutate] of acceptedVariants) {
      const grade = await gradeFixture(mutate);
      const failures = failedChecks(grade);
      expect(failures, `${label}: ${JSON.stringify(failures, null, 2)}`).toEqual([]);
    }
    const observational = await gradeFixture(({ execution }) => {
      execution.semanticChildren = [];
    });
    expect(checkPassed(observational, 2, "semantic-child-observation"),
      "recursion-enabled cells may observe zero children").toBe(true);
  });

  it("rejects the full search, reference, and recursion-authority mutation corpus", async () => {
    const cases = [
      ["unbounded search budget", ({ events }) => { events[1][0].budget.resultRows = 6; }, 1, "prior-work-search"],
      ["unrelated search topic", ({ events }) => {
        events[2][1].parameters.topic.value = "Unrelated launch note";
      }, 2, "prior-work-search"],
      ["search after the referencing action", ({ events }) => { events[2][1].sequence = 34; }, 2, "search-reference-submit-order"],
      ["extra unrelated search", ({ events }) => {
        events[2].splice(2, 0, search(31.5, "Unrelated launch note", 999));
      }, 2, "prior-work-search"],
      ["non-final query semicolon", ({ events }) => { events[1][0].query += "; LIMIT 1"; }, 1, "prior-work-search"],
      ["unaudited prior-work reference", ({ events }) => { events[2][3].recordId = 999; }, 2, "prior-work-references"],
      ["invoke action detached from the observed child", ({ execution }) => {
        execution.semanticChildren[0].sourceActionId = 999;
      }, 2, "final-child-attached"],
      ["extra semantic child", ({ execution }) => {
        execution.semanticChildren.push({ sourceInteractionId: 3, sourceActionId: 999, rootLayerId: 999, acceptedRootNodes: [] });
      }, 2, "final-child-attached"],
      ["resolved invoke while recursion is off", ({ execution }) => {
        execution.harnessConfiguration.complete.agentAuthored = false;
        execution.turns.forEach((turn) => { turn.candidateTrace.completionBrokerAvailable = false; });
        execution.semanticChildren = [];
      }, 2, "recursion-disabled-no-resolved-invoke"],
    ];
    expect(cases, "mutation corpus inventory").toHaveLength(9);
    for (const [label, mutate, turnIndex, checkName] of cases) {
      const grade = await gradeFixture(mutate);
      expect.soft(checkPassed(grade, turnIndex, checkName), `${label} must fail ${checkName}`).toBe(false);
    }
  });
});
