import { describe, expect, it } from "vitest";

import {
  annotatedExecutionExportable,
  authorizeRecursiveCompleteSelection,
  isolateRecursiveCompleteSelection,
  judgeConfigurationCompatibleWithCases,
  projectExecutionCell,
  projectExecutionDossier,
  runPanelCopy,
} from "../desktop/eval-renderer/run-model.js";

describe("Eval dashboard run presentation", () => {
  it("filters judge choices against selected case requirements", () => {
    const cases = [{
      id: "input-roundtrip",
      requiredJudgeConfigurationIds: ["simulated-user"],
    }, { id: "ordinary" }];
    expect(judgeConfigurationCompatibleWithCases(cases, ["ordinary"], "deterministic"))
      .toBe(true);
    expect(judgeConfigurationCompatibleWithCases(cases, ["input-roundtrip"], "deterministic"))
      .toBe(false);
    expect(judgeConfigurationCompatibleWithCases(cases, ["input-roundtrip"], "simulated-user"))
      .toBe(true);
  });

  it("isolates the recursive pair and requires an explicit paid child-aware authorization", () => {
    expect(isolateRecursiveCompleteSelection(
      ["empty-project.task-system.single-turn", "empty-project.recursive-complete.comparison"],
      ["fixture-task-system"],
    )).toEqual({
      testCaseIds: ["empty-project.recursive-complete.comparison"],
      harnessConfigurationNames: [
        "codex-eval-complete-disabled",
        "codex-eval-complete-enabled",
      ],
    });
    const selection = {
      testCaseIds: ["empty-project.recursive-complete.comparison"],
      harnessConfigurationNames: [
        "codex-eval-complete-disabled",
        "codex-eval-complete-enabled",
      ],
      judgeConfigurationName: "deterministic-graph-contract",
    };
    expect(authorizeRecursiveCompleteSelection(selection, () => false)).toBeNull();
    expect(authorizeRecursiveCompleteSelection(selection, (message) => {
      expect(message).toContain("additional agent-authored child execution");
      return true;
    })).toEqual({
      ...selection,
      liveAuthorization: {
        confirmed: true,
        credentialReference: "connected-product-provider",
        rootProviderExecutions: 2,
        agentAuthoredChildren: true,
      },
    });
  });

  it("presents imported runs as external conversation review", () => {
    expect(runPanelCopy({ kind: "imported-conversation" })).toEqual({
      title: "Conversation review",
      description: "Open the immutable external conversation in the read-only production workspace or review its eligible judge results.",
    });
  });

  it("retains case and harness language for local matrix runs", () => {
    expect(runPanelCopy({ kind: "local-eval" })).toEqual({
      title: "Test cases",
      description: "Open the judge review or the read-only production workspace for one case × harness execution.",
    });
  });

  it("enables annotation export only for durable terminal execution coverage", () => {
    const run = { bundleRef: "runs/run-1/bundle.json" };
    const execution = {
      status: "passed",
      threadIds: [41],
      turns: [{ threadId: 41, interactionId: 51, status: "accepted" }],
    };
    expect(annotatedExecutionExportable(run, execution)).toBe(true);
    expect(annotatedExecutionExportable({ bundleRef: null }, execution)).toBe(false);
    expect(annotatedExecutionExportable(run, { ...execution, status: "running" })).toBe(false);
    expect(annotatedExecutionExportable(run, {
      ...execution,
      turns: [{ threadId: 41, interactionId: 51, status: "submitted" }],
    })).toBe(false);
    expect(annotatedExecutionExportable(run, {
      ...execution,
      threadIds: [41, 42],
    })).toBe(false);
  });

  it("projects lifecycle, outcome, and presentation independently", () => {
    const cell = projectExecutionCell({ kind: "local-eval" }, {
      id: "execution-1",
      status: "failed",
      lifecycle: { status: "complete", durationMs: 12_000 },
      outcomeGrade: { status: "complete", qualified: false, score: 72 },
      presentationGrade: { status: "complete", applicable: true, score: 3.25 },
    });
    expect(cell).toMatchObject({
      lifecycle: { status: "complete", label: "Complete", durationMs: 12_000 },
      substance: { status: "complete", label: "72", score: 72, qualified: false },
      presentation: { status: "complete", label: "3.3", score: 3.25, applicable: true },
    });
  });

  it("shows vanilla presentation as not applicable and preserves unjudged as nonzero", () => {
    expect(projectExecutionCell({}, {
      id: "vanilla",
      lifecycle: { status: "complete" },
      outcomeGrade: { status: "unjudged", score: null, qualified: null },
      presentationGrade: { status: "not_applicable", score: null },
    })).toMatchObject({
      substance: { label: "Unjudged", score: null },
      presentation: { label: "N/A", score: null, applicable: false },
    });
  });

  it("keeps queued and failed execution phases separate from grade status", () => {
    expect(projectExecutionCell({}, {
      status: "queued",
      outcomeGrade: { status: "pending", score: null },
      presentationGrade: { status: "pending", applicable: true, score: null },
    })).toMatchObject({
      lifecycle: { status: "queued" },
      substance: { label: "Pending" },
      presentation: { label: "Pending" },
    });
    expect(projectExecutionCell({}, {
      status: "error",
      outcomeGrade: { status: "failed", score: null },
      presentationGrade: { status: "unjudged", applicable: true, score: null },
    })).toMatchObject({
      lifecycle: { status: "failed" },
      substance: { label: "Failed" },
      presentation: { label: "Unjudged" },
    });
  });

  it("labels an incompatible presentation-rubric projection instead of showing a score", () => {
    expect(projectExecutionCell({}, {
      status: "passed",
      presentationGrade: {
        status: "partial",
        score: null,
        comparability: { status: "incompatible", contractIds: ["v5", "v6"], reason: "Changed rubric." },
      },
    })).toMatchObject({
      presentation: { status: "partial", score: null, label: "Non-comparable rubric versions" },
    });
  });

  it("projects a complete execution dossier with evidence and action eligibility", () => {
    const run = { kind: "local-eval", bundleRef: "runs/run-1/bundle.json" };
    const execution = {
      id: "execution-1",
      testCaseId: "case-1",
      status: "passed",
      lifecycle: { status: "complete", startedAt: "start", completedAt: "end", durationMs: 5000 },
      caseSnapshot: {
        schemaVersion: 1,
        id: "case-1",
        name: "Fresh feature",
        artifacts: {
          task: { text: "Add saved filters." },
          workspace: { source: "example/repo", revision: "abc123" },
        },
      },
      caseSnapshotDigest: "sha256:case",
      harnessConfigurationName: "codex-basic",
      harnessConfiguration: { implementation: "codex.basic" },
      harnessConfigurationDigest: "sha256:harness",
      outcomeGrade: {
        status: "complete",
        qualified: true,
        score: 91,
        mandatoryGates: [{ gateId: "build", name: "Build", status: "completed", passed: true, detail: "Build passed.", evidenceRefs: ["build.log"] }],
        criteria: [{ criterionId: "behavior", rating: 4, rationale: "Behavior works.", evidenceRefs: [{ ref: "tests.json" }] }],
        evidenceRefs: ["outcome.json"],
      },
      presentationGrade: {
        status: "complete",
        applicable: true,
        score: 3.6,
        comprehensionScore: 3,
        renderedScore: 4,
        rawScore: 3.35,
        scoreCeiling: 6,
        scoreScaleMaximum: 8,
        depthDecay: 0.5,
        layers: [{ layerId: "layer-1", score: 4 }, { layerId: "layer-2", score: 2 }],
        aggregation: [{ layerId: "layer-1", assignedWeight: 0.67 }, { layerId: "layer-2", assignedWeight: 0.33 }],
        worstLayer: { layerId: "layer-2", score: 2 },
        hasMateriallyMisleadingLayer: false,
        evidenceRefs: ["judge.json"],
      },
      threadIds: [41],
      turns: [{ threadId: 41, interactionId: 51, status: "accepted", candidateTrace: { status: "complete" }, judgeResults: [{ status: "completed" }] }],
    };
    expect(projectExecutionDossier(run, execution)).toMatchObject({
      case: { name: "Fresh feature", prompt: "Add saved filters.", repository: "example/repo", commit: "abc123" },
      harness: { name: "codex-basic", implementation: "codex.basic", digest: "sha256:harness" },
      substance: {
        score: 91,
        qualified: true,
        gates: [{ id: "build", passed: true, evidenceRefs: ["build.log"] }],
        criteria: [{ id: "behavior", score: 4, evidenceRefs: ["tests.json"] }],
        evidenceRefs: ["outcome.json"],
      },
      presentation: {
        score: 3.6,
        scoreCeiling: 6,
        comprehensionScore: 3,
        renderedScore: 4,
        rawScore: 3.35,
        decay: 0.5,
        layers: [{ layerId: "layer-1", score: 4 }, { layerId: "layer-2", score: 2 }],
        aggregation: [{ layerId: "layer-1", assignedWeight: 0.67 }, { layerId: "layer-2", assignedWeight: 0.33 }],
        worstLayer: { layerId: "layer-2", score: 2 },
        hasMateriallyMisleadingLayer: false,
        evidenceRefs: ["judge.json"],
      },
      actions: { traceable: true, judgeReviewable: true, workspaceReviewable: true, annotationExportable: true },
    });
  });

  it("projects legacy executions without manufacturing numeric scores", () => {
    const dossier = projectExecutionDossier({ kind: "local-eval" }, {
      id: "legacy",
      testCaseId: "legacy-case",
      status: "failed",
      passed: false,
      checks: [
        { name: "build", passed: true, detail: "Build passed." },
        { name: "tests", passed: false, detail: "Tests failed." },
      ],
      turns: [{ prompt: "Fix it." }],
    });
    expect(dossier.lifecycle.status).toBe("complete");
    expect(dossier.substance).toMatchObject({ score: null, label: "1/2 checks", qualified: false });
    expect(dossier.substance.gates.map((gate) => [gate.id, gate.passed])).toEqual([
      ["build", true],
      ["tests", false],
    ]);
    expect(dossier.case.prompt).toBe("Fix it.");
    expect(dossier.presentation).toMatchObject({ score: null, label: "Unjudged" });
  });

  it("projects agent-authored Complete authority and semantic child evidence separately from human turns", () => {
    const dossier = projectExecutionDossier({ kind: "local-eval" }, {
      id: "recursive",
      testCaseId: "empty-project.recursive-complete.comparison",
      harnessConfiguration: {
        implementation: "codex.basic",
        complete: { agentAuthored: true },
      },
      turns: [{
        interactionId: 10,
        candidateTrace: { status: "complete", completionBrokerAvailable: true },
      }],
      semanticChildren: [{
        interactionId: 11,
        graphNodeId: 101,
        sourceInteractionId: 10,
        sourceActionId: 77,
        status: "accepted",
        candidateTrace: { status: "complete" },
        projectionObservations: [{ revision: 0 }, { revision: 1 }],
      }],
    });
    expect(dossier.recursiveComplete).toEqual({
      declared: true,
      configured: true,
      brokerAvailable: true,
      children: [{
        interactionId: 11,
        graphNodeId: 101,
        sourceInteractionId: 10,
        sourceActionId: 77,
        status: "accepted",
        traceStatus: "complete",
        projectionCount: 2,
      }],
    });
    expect(dossier.actions.traceable).toBe(true);
  });
});
