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

describe("recursive graph-memory Eval evidence", () => {
  it("requires each follow-up to search and retain every required prior root plus one final semantic child", async () => {
    const grade = await gradeFixture();
    const failed = grade.turns.flatMap((turn) => turn.checks).filter((check) => !check.passed);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(grade.turns[2].evidence).toMatchObject({
      successfulSearchCount: 2,
      searchedLayerIds: [101, 102],
      requiredPriorRoots: [101, 102],
    });
    expect(grade.turns).toHaveLength(3);
  });

  it("rejects unbounded, unrelated, or post-reference searches", async () => {
    const excessiveBudget = await gradeFixture(({ events }) => { events[1][0].budget.resultRows = 6; });
    expect(excessiveBudget.turns[1].checks.find(({ name }) => name === "prior-work-search")?.passed).toBe(false);

    const unrelatedTopic = await gradeFixture(({ events }) => {
      events[2][1].parameters.topic.value = "Unrelated launch note";
    });
    expect(unrelatedTopic.turns[2].checks.find(({ name }) => name === "prior-work-search")?.passed).toBe(false);

    const lateSearch = await gradeFixture(({ events }) => { events[2][1].sequence = 34; });
    expect(lateSearch.turns[2].checks.find(({ name }) => name === "search-reference-submit-order")?.passed).toBe(false);

    const extraSearch = await gradeFixture(({ events }) => {
      events[2].splice(2, 0, search(31.5, "Unrelated launch note", 999));
    });
    expect(extraSearch.turns[2].checks.find(({ name }) => name === "prior-work-search")?.passed).toBe(false);
  });

  it("rejects unaudited references, action mismatches, and extra semantic children", async () => {
    const wrongReference = await gradeFixture(({ events }) => { events[2][3].recordId = 999; });
    expect(wrongReference.turns[2].checks.find(({ name }) => name === "prior-work-references")?.passed).toBe(false);

    const wrongInvoke = await gradeFixture(({ execution }) => { execution.semanticChildren[0].sourceActionId = 999; });
    expect(wrongInvoke.turns[2].checks.find(({ name }) => name === "final-child-attached")?.passed).toBe(false);

    const extraChild = await gradeFixture(({ execution }) => {
      execution.semanticChildren.push({ sourceInteractionId: 3, sourceActionId: 999, rootLayerId: 999, acceptedRootNodes: [] });
    });
    expect(extraChild.turns[2].checks.find(({ name }) => name === "final-child-attached")?.passed).toBe(false);
  });

  it.each([
    { search: "disabled", agentAuthored: false },
    { search: "query-v1", agentAuthored: false },
    { search: "disabled", agentAuthored: true },
  ])("grades capability-conditional mechanics for search=$search recursion=$agentAuthored", async ({ search: searchMode, agentAuthored }) => {
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

    const failed = grade.turns.flatMap((turn) => turn.checks).filter((check) => !check.passed);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
  });

  it("allows recursion-enabled cells to record zero children while failing a resolved invoke in recursion-off", async () => {
    const noChild = await gradeFixture(({ execution }) => {
      execution.semanticChildren = [];
    });
    expect(noChild.turns[2].checks.find(({ name }) => name === "semantic-child-observation")?.passed).toBe(true);

    const resolvedWithoutAuthority = await gradeFixture(({ execution }) => {
      execution.harnessConfiguration.complete.agentAuthored = false;
      execution.turns.forEach((turn) => { turn.candidateTrace.completionBrokerAvailable = false; });
      execution.semanticChildren = [];
    });
    expect(resolvedWithoutAuthority.turns[2].checks.find(({ name }) => name === "recursion-disabled-no-resolved-invoke")?.passed).toBe(false);
  });

  it("accepts the safe server-default row budget when the natural query omits an override", async () => {
    const grade = await gradeFixture(({ events }) => {
      delete events[1][0].budget;
      delete events[2][0].budget;
      delete events[2][1].budget;
    });
    expect(grade.turns[1].checks.find(({ name }) => name === "prior-work-search")?.passed).toBe(true);
    expect(grade.turns[2].checks.find(({ name }) => name === "prior-work-search")?.passed).toBe(true);
  });

  it("accepts only a final optional graph-query semicolon", async () => {
    const finalSemicolon = await gradeFixture(({ events }) => {
      events[1][0].query += ";  ";
      events[2][0].query += ";";
      events[2][1].query += ";";
    });
    expect(finalSemicolon.turns[1].checks.find(({ name }) => name === "prior-work-search")?.passed).toBe(true);
    expect(finalSemicolon.turns[2].checks.find(({ name }) => name === "prior-work-search")?.passed).toBe(true);

    const nonFinalSemicolon = await gradeFixture(({ events }) => {
      events[1][0].query += "; LIMIT 1";
    });
    expect(nonFinalSemicolon.turns[1].checks.find(({ name }) => name === "prior-work-search")?.passed).toBe(false);
  });
});
