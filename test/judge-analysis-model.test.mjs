import { describe, expect, it } from "vitest";
import {
  buildJudgeAnalysis,
  evidenceIdsForReview,
  scoreForRatings,
  subjectForSelection,
} from "../desktop/eval-renderer/judge-model.js";

function fixture() {
  return {
    id: "run-1",
    status: "failed",
    judgeConfigurationName: "simulated-user",
    executions: [{
      id: "execution-1",
      testCaseId: "project-case",
      harnessConfigurationName: "codex-high",
      status: "failed",
      turns: [{
        interactionId: 11,
        threadId: 4,
        threadDefinitionId: "architecture",
        turnIndex: 1,
        threadTurnIndex: 1,
        prompt: "Think deeper.",
        deterministicPassed: true,
        judgeResults: [{
          id: "judge-1",
          status: "partial",
          error: "Review ended before final submission.",
          coverage: {
            complete: false,
            missingSubjects: [
              { kind: "node", layerId: "layer-a", subjectId: "node-2" },
              { kind: "navigate_action", layerId: "layer-a", nodeId: "node-2", subjectId: "action-2" },
              { kind: "turn", subjectId: "11" },
            ],
          },
          references: {
            screenshots: [
              "screenshots/shot-layer/metadata.json",
              "screenshots/shot-node/metadata.json",
              "screenshots/shot-unused/metadata.json",
            ],
          },
          review: {
            inventory: {
              turn: { turnId: "11" },
              layers: [{ layerId: "layer-a", depth: 0 }, { layerId: "layer-b", depth: 1 }],
              nodes: [
                { layerId: "layer-a", nodeId: "node-1", actionIds: [] },
                { layerId: "layer-a", nodeId: "node-2", actionIds: ["action-2"] },
              ],
              actions: [{ layerId: "layer-a", nodeId: "node-2", actionId: "action-2", actionKind: "navigate", relation: "reference", targetLayerId: "layer-b" }],
            },
            layers: [{ subject: { layerId: "layer-a" }, history: { current: {
              layerId: "layer-a",
              ratings: { cohesion: 4, coverage: null },
              evidence: { viewport: ["shot-layer"] },
              summary: "Clear layer.", findings: [],
            } } }],
            nodes: [
              { subject: { layerId: "layer-a", nodeId: "node-1" }, history: { current: {
                layerId: "layer-a", nodeId: "node-1", ratings: { substance: 3, presentation: 4 },
                evidence: { context: ["shot-layer"], detail: ["shot-node"] },
                summary: "Useful node.", findings: [{ type: "strength", text: "Grounded.", evidence: ["shot-node"] }], actions: [],
              } } },
            ],
            coverage: { complete: false },
          },
        }],
      }, {
        interactionId: 12,
        threadId: 5,
        threadDefinitionId: "implementation",
        turnIndex: 2,
        threadTurnIndex: 0,
        prompt: "Implement it.",
        deterministicPassed: false,
        deterministicChecks: [{ name: "clean", passed: false, detail: "Workspace was dirty." }],
        judgeResults: [],
      }].reverse(),
    }],
  };
}

describe("judge analysis view model", () => {
  it("keeps chronological turns, literal subject coverage, scoped evidence, and the active imported judge", () => {
    const analysis = buildJudgeAnalysis(fixture(), "execution-1");
    expect(analysis.turns.map((turn) => turn.interactionId), "chronological turn order").toEqual(["11", "12"]);
    expect(analysis.turns.map((turn) => turn.position), "turn positions").toEqual([0, 1]);
    expect(analysis.turns[0].state, "partial review stays partial").toBe("partial");
    expect(analysis.turns[0].reviewed, "partial review is not complete").toBe(false);
    expect(analysis.turns[0].layers.map((layer) => layer.layerId), "inventory layers survive").toEqual(["layer-a", "layer-b"]);
    expect(analysis.turns[0].layers[0].nodes[0].reviewed, "reviewed node is marked").toBe(true);
    expect(analysis.turns[0].layers[0].nodes[1].reviewed, "missing node stays unreviewed").toBe(false);
    expect(analysis.turns[0].layers[0].nodes[1].actions[0].reviewed, "missing action stays unreviewed").toBe(false);
    expect(analysis.turns[0].layers[0].nodes[1].actions[0].relation, "action relation survives").toBe("reference");
    expect(analysis.turns[1], "deterministically failed turn is skipped with its reason")
      .toMatchObject({ state: "skipped", stateReason: "Workspace was dirty." });

    const turn = analysis.turns[0];
    const node = subjectForSelection(turn, { kind: "node", layerId: "layer-a", nodeId: "node-1" });
    expect(node.evidenceIds, "evidence is filtered to the selected subject").toEqual(["shot-layer", "shot-node"]);
    expect(turn.allEvidenceIds, "all-turn inventory remains lazily available").toEqual(["shot-layer", "shot-node", "shot-unused"]);
    expect(evidenceIdsForReview(node.review), "review evidence matches the subject scope").toEqual(["shot-layer", "shot-node"]);

    expect(scoreForRatings({ cohesion: 4, presentation: null }), "a null criterion does not zero the score").toBe(4);
    expect(scoreForRatings({ cohesion: null }), "all-null ratings stay null").toBeNull();
    expect(scoreForRatings(null), "missing ratings stay null").toBeNull();

    const run = fixture();
    const judgedTurn = run.executions[0].turns.find((candidate) => candidate.interactionId === 11);
    judgedTurn.deterministicJudge = {
      status: "completed",
      passed: true,
      provenance: { sourceSha256: "sha256:owner-export" },
      checks: [{ name: "accepted", passed: true }],
    };
    run.judgeConfigurationName = "deterministic-graph-contract";
    let selected = buildJudgeAnalysis(run, "execution-1").turns[0];
    expect(selected.result, "active imported judge wins over stale results").toBe(judgedTurn.deterministicJudge);
    expect(selected.provenance.sourceSha256, "imported judge keeps its provenance").toBe("sha256:owner-export");

    run.judgeConfigurationName = "simulated-user";
    selected = buildJudgeAnalysis(run, "execution-1").turns[0];
    expect(selected.result.id, "switching back restores the simulated-user result").toBe("judge-1");
  });

  it("projects recursive v2 and v6 reviews with scores, semantics, histories, and criterion judgments", () => {
    const run = fixture();
    const turn = run.executions[0].turns.find((candidate) => candidate.interactionId === 11);
    turn.judgeResults = [{
      id: "recursive-judge",
      status: "completed",
      review: {
        schemaVersion: 2,
        contractId: "recursive-presentation-judge-v2",
        inventory: {
          turn: { turnId: "11" },
          layers: [{ layerId: "root", depth: 0 }, { layerId: "child", depth: 1 }],
          nodes: [{ layerId: "root", nodeId: "root-node" }, { layerId: "child", nodeId: "child-node" }],
          actions: [{ layerId: "root", nodeId: "root-node", actionId: "expand", actionKind: "navigate", relation: "expand", targetLayerId: "child" }],
        },
        layers: [
          { subject: { layerId: "root" }, history: { current: {
            layerId: "root",
            depth: 0,
            nodeScores: [{ nodeId: "root-node", content: 4, actionAllocation: 3, actionDelivery: 4, recursiveQuality: 3 }, null, null, null, null, null, null, null],
            nodeSemantics: [{ nodeId: "root-node", delivered: "Delivered the root.", effectOnLayer: "Compressed the child." }, null, null, null, null, null, null, null],
            layerRatings: { coverage: 3 },
            layerSummary: "Root compression.",
            evidence: ["shot-root"],
          } } },
          { subject: { layerId: "child" }, history: { current: { layerId: "child", depth: 1, layerRatings: { coverage: 4 }, layerSummary: "Child result.", evidence: ["shot-child"] } } },
        ],
        nodes: [{ subject: { layerId: "root", nodeId: "root-node" }, history: { current: {
          layerId: "root",
          nodeId: "root-node",
          score: { nodeId: "root-node", content: 4, actionAllocation: 3, actionDelivery: 4, recursiveQuality: 3 },
          semantic: { delivered: "Delivered the root.", effectOnLayer: "Compressed the child.", evidence: ["shot-root", "shot-child"] },
          evidence: { context: ["shot-root"], detail: ["shot-root"] },
          allocationSteps: [],
          missingActionOpportunities: [{
            allocationStep: 1,
            preferredChoice: "expand",
            importance: "material",
            unansweredQuestion: "How does the repair work?",
            expectedContribution: "Explain the causal mechanism.",
            artifactEvidence: ["src/change.ts"],
            evidence: ["shot-missing-action"],
          }],
          actions: [{ actionId: "expand", kind: "expand", allocationStep: 0, labelAndPlacement: "Clear.", delivery: "Delivered.", recursiveContribution: "Useful.", targetLayerId: "child", reusedLayerId: null, evidence: ["shot-root", "shot-child"] }],
          findings: [],
        } } }],
        turn: {
          rootLayerResult: { layerId: "root", layerSummary: "Root compression." },
          ratings: { presentation_quality: 3 }, summary: "Recursive result.", evidence: { representative: ["shot-root"] }, findings: [],
        },
        coverage: { complete: true },
      },
    }];

    const recursive = buildJudgeAnalysis(run, "execution-1").turns[0];
    expect(recursive.recursive, "v2 review is recognized as recursive").toBe(true);
    expect(recursive.layers.map((layer) => layer.layerId), "child layers stay readable beside the root").toEqual(["child", "root"]);
    expect(recursive.layers[1].review, "historical layer review survives").toMatchObject({ ratings: { coverage: 3 }, summary: "Root compression." });
    expect(recursive.layers[1].review.nodeScores, "sparse node score vectors survive").toHaveLength(8);
    expect(recursive.layers[1].review.nodeSemantics[0].effectOnLayer, "node semantics survive").toBe("Compressed the child.");
    expect(recursive.review.rootLayerResult.layerId, "root layer result is projected").toBe("root");
    expect(recursive.layers[1].nodes[0].review, "node scores are projected").toMatchObject({
      ratings: { content: 4, actionAllocation: 3, actionDelivery: 4, recursiveQuality: 3 },
      summary: "Compressed the child.",
    });
    expect(recursive.layers[1].nodes[0].actions[0].review.summary, "action delivery survives").toContain("Delivered.");
    expect(recursive.layers[1].nodes[0].review.missingActionOpportunities[0], "missing action opportunities survive").toMatchObject({
      importance: "material",
      unansweredQuestion: "How does the repair work?",
    });
    expect(recursive.layers[1].nodes[0].evidenceIds, "opportunity evidence joins node evidence").toContain("shot-missing-action");

    const judgment = (score, reason, evidence) => ({ score, reason, evidence });
    turn.judgeResults = [{
      id: "recursive-input-judge",
      status: "completed",
      review: {
        schemaVersion: 6,
        contractId: "recursive-presentation-judge-v6",
        inventory: {
          turn: { turnId: "11" },
          layers: [{ layerId: "root", depth: 0 }],
          nodes: [{ layerId: "root", nodeId: "root-node", actionIds: ["input-a"] }],
          actions: [{ layerId: "root", nodeId: "root-node", actionId: "input-a", actionKind: "input" }],
        },
        layers: [],
        nodes: [{ subject: { layerId: "root", nodeId: "root-node" }, history: { current: {
          layerId: "root",
          nodeId: "root-node",
          evidence: { context: ["shot-root"], detail: ["shot-input"] },
          score: { nodeId: "root-node" },
          semantic: { delivered: "A question is visible.", effectOnLayer: "Collects a decision.", evidence: ["shot-root"] },
          allocationSteps: [],
          actions: [{
            actionId: "input-a",
            kind: "input",
            allocationStep: 0,
            labelAndPlacement: "Placed at the blocked decision.",
            delivery: null,
            recursiveContribution: null,
            targetLayerId: null,
            reusedLayerId: null,
            evidence: ["shot-input"],
            inputActionJudgments: {
              prompt_answerability: judgment(7, "One concrete question.", ["shot-prompt"]),
              option_set_quality: judgment(8, "Text correctly has no options.", ["shot-options"]),
              control_fit: judgment(6, "Free text fits.", ["shot-control"]),
            },
          }],
          findings: [],
        } } }],
        turn: null,
        coverage: { complete: false },
      },
    }];

    const action = buildJudgeAnalysis(run, "execution-1").turns[0].layers[0].nodes[0].actions[0];
    expect(action.review, "v6 input-action criterion judgments are projected").toMatchObject({
      ratings: { prompt_answerability: 7, option_set_quality: 8, control_fit: 6 },
      criterionJudgments: {
        prompt_answerability: { reason: "One concrete question." },
        option_set_quality: { reason: "Text correctly has no options." },
        control_fit: { reason: "Free text fits." },
      },
    });
    expect(action.evidenceIds, "criterion screenshots join action evidence").toEqual(["shot-input", "shot-prompt", "shot-options", "shot-control"]);
  });
});
