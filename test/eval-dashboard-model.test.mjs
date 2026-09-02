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
  it("gates run construction on judge compatibility, recursive isolation, and explicit paid authorization", () => {
    const cases = [{
      id: "input-roundtrip",
      requiredJudgeConfigurationIds: ["simulated-user"],
    }, { id: "ordinary" }];
    expect(judgeConfigurationCompatibleWithCases(cases, ["ordinary"], "deterministic"),
      "ordinary cases accept any judge").toBe(true);
    expect(judgeConfigurationCompatibleWithCases(cases, ["input-roundtrip"], "deterministic"),
      "required judges are enforced").toBe(false);
    expect(judgeConfigurationCompatibleWithCases(cases, ["input-roundtrip"], "simulated-user"),
      "required judges stay compatible").toBe(true);

    expect(isolateRecursiveCompleteSelection(
      ["empty-project.task-system.single-turn", "empty-project.recursive-complete.comparison"],
      ["fixture-task-system"],
    ), "recursive pair isolates from ordinary harnesses").toEqual({
      testCaseIds: ["empty-project.recursive-complete.comparison"],
      harnessConfigurationNames: [
        "codex-eval-complete-disabled",
        "codex-eval-complete-enabled",
      ],
    });
    const pairSelection = {
      testCaseIds: ["empty-project.recursive-complete.comparison"],
      harnessConfigurationNames: [
        "codex-eval-complete-disabled",
        "codex-eval-complete-enabled",
      ],
      judgeConfigurationName: "deterministic-graph-contract",
    };
    expect(authorizeRecursiveCompleteSelection(pairSelection, () => false),
      "declined authorization blocks the recursive pair").toBeNull();
    expect(authorizeRecursiveCompleteSelection(pairSelection, (message) => {
      expect(message, "authorization names the paid child execution").toContain("additional agent-authored child execution");
      return true;
    }), "confirmed authorization carries live credentials").toEqual({
      ...pairSelection,
      liveAuthorization: {
        confirmed: true,
        credentialReference: "connected-product-provider",
        rootProviderExecutions: 2,
        agentAuthoredChildren: true,
      },
    });

    const quartet = [
      "codex-eval-lantern-search-disabled-recursion-disabled",
      "codex-eval-lantern-search-query-v1-recursion-disabled",
      "codex-eval-lantern-search-disabled-recursion-enabled",
      "codex-eval-lantern-search-query-v1-recursion-enabled",
    ];
    expect(isolateRecursiveCompleteSelection(
      ["empty-project.task-system.single-turn", "empty-project.recursive-graph-memory.launch-readiness"],
      ["codex-basic"],
      quartet.map((name) => ({ name })),
    ), "four-cell experiment isolates into its quartet").toEqual({
      testCaseIds: ["empty-project.recursive-graph-memory.launch-readiness"],
      harnessConfigurationNames: quartet,
    });
    const quartetSelection = {
      testCaseIds: ["empty-project.recursive-graph-memory.launch-readiness"],
      harnessConfigurationNames: quartet,
      judgeConfigurationName: "deterministic-graph-contract",
    };
    expect(authorizeRecursiveCompleteSelection(quartetSelection, (message) => {
      expect(message, "authorization names the twelve paid roots").toContain("twelve paid/live Codex root turns");
      expect(message, "authorization names model-controlled children").toContain("additional model-controlled paid child executions");
      return true;
    }), "quartet authorization covers twelve roots and children").toEqual({
      ...quartetSelection,
      liveAuthorization: {
        confirmed: true,
        credentialReference: "connected-product-provider",
        rootProviderExecutions: 12,
        agentAuthoredChildren: true,
      },
    });
    expect(isolateRecursiveCompleteSelection(
      ["empty-project.recursive-graph-memory.launch-readiness"],
      [],
      quartet.slice(0, 3).map((name) => ({ name })),
    ), "incomplete quartets isolate to nothing").toEqual({
      testCaseIds: ["empty-project.recursive-graph-memory.launch-readiness"],
      harnessConfigurationNames: [],
    });

    const run = { bundleRef: "runs/run-1/bundle.json" };
    const execution = {
      status: "passed",
      threadIds: [41],
      turns: [{ threadId: 41, interactionId: 51, status: "accepted" }],
    };
    const exportability = [
      ["durable terminal coverage is exportable", run, execution, true],
      ["missing bundle blocks export", { bundleRef: null }, execution, false],
      ["running executions block export", run, { ...execution, status: "running" }, false],
      ["nonterminal turns block export", run, {
        ...execution,
        turns: [{ threadId: 41, interactionId: 51, status: "submitted" }],
      }, false],
      ["uncovered threads block export", run, { ...execution, threadIds: [41, 42] }, false],
    ];
    expect(exportability, "annotation export eligibility corpus").toHaveLength(5);
    for (const [label, exportRun, exportExecution, eligible] of exportability) {
      expect(annotatedExecutionExportable(exportRun, exportExecution), label).toBe(eligible);
    }
  });

  it("projects run copy and execution cells independently across lifecycle states", () => {
    expect(runPanelCopy({ kind: "imported-conversation" }), "imported runs read as conversation review").toEqual({
      title: "Conversation review",
      description: "Open the immutable external conversation in the read-only production workspace or review its eligible judge results.",
    });
    expect(runPanelCopy({ kind: "local-eval" }), "local matrix runs keep case and harness language").toEqual({
      title: "Test cases",
      description: "Open the judge review or the read-only production workspace for one case × harness execution.",
    });

    expect(projectExecutionCell({ kind: "local-eval" }, {
      id: "execution-1",
      status: "failed",
      lifecycle: { status: "complete", durationMs: 12_000 },
      outcomeGrade: { status: "complete", qualified: false, score: 72 },
      presentationGrade: { status: "complete", applicable: true, score: 3.25 },
    }), "lifecycle, outcome, and presentation project independently").toMatchObject({
      lifecycle: { status: "complete", label: "Complete", durationMs: 12_000 },
      substance: { status: "complete", label: "72", score: 72, qualified: false },
      presentation: { status: "complete", label: "3.3", score: 3.25, applicable: true },
    });

    expect(projectExecutionCell({}, {
      id: "vanilla",
      lifecycle: { status: "complete" },
      outcomeGrade: { status: "unjudged", score: null, qualified: null },
      presentationGrade: { status: "not_applicable", score: null },
    }), "vanilla presentation is N/A while unjudged substance stays non-numeric").toMatchObject({
      substance: { label: "Unjudged", score: null },
      presentation: { label: "N/A", score: null, applicable: false },
    });

    expect(projectExecutionCell({}, {
      status: "queued",
      outcomeGrade: { status: "pending", score: null },
      presentationGrade: { status: "pending", applicable: true, score: null },
    }), "queued phase stays separate from grade status").toMatchObject({
      lifecycle: { status: "queued" },
      substance: { label: "Pending" },
      presentation: { label: "Pending" },
    });
    expect(projectExecutionCell({}, {
      status: "error",
      outcomeGrade: { status: "failed", score: null },
      presentationGrade: { status: "unjudged", applicable: true, score: null },
    }), "failed phase stays separate from unjudged presentation").toMatchObject({
      lifecycle: { status: "failed" },
      substance: { label: "Failed" },
      presentation: { label: "Unjudged" },
    });

    expect(projectExecutionCell({}, {
      status: "passed",
      presentationGrade: {
        status: "partial",
        score: null,
        comparability: { status: "incompatible", contractIds: ["v5", "v6"], reason: "Changed rubric." },
      },
    }), "incompatible rubrics are labeled instead of scored").toMatchObject({
      presentation: { status: "partial", score: null, label: "Non-comparable rubric versions" },
    });
  });

  it("projects dossiers with substance, presentation, mechanism, and recursion kept apart", () => {
    const lanternExecution = {
      id: "lantern",
      lifecycle: { status: "complete" },
      checks: [{ name: "graph-search-disabled", passed: true, detail: "No search was observed." }],
      outcomeGrade: {
        status: "unjudged",
        qualified: null,
        score: null,
        reviewRequired: true,
        criteria: [{ criterionId: "prior-retention", name: "Prior retention" }],
      },
      presentationGrade: { status: "unjudged", applicable: true, score: null },
    };
    expect(projectExecutionCell({ kind: "local-eval" }, lanternExecution),
      "mechanism checks never manufacture human qualification").toMatchObject({
      substance: { label: "Human review", qualified: null, score: null },
    });
    expect(projectExecutionDossier({ kind: "local-eval" }, lanternExecution),
      "dossier keeps mechanism checks beside human criteria").toMatchObject({
      substance: {
        gates: [],
        criteria: [{ id: "prior-retention" }],
      },
      mechanism: {
        checks: [{ id: "graph-search-disabled", passed: true, detail: "No search was observed." }],
      },
    });

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
    expect(projectExecutionDossier(run, execution), "complete dossier carries every projection and action eligibility").toMatchObject({
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

    const legacy = projectExecutionDossier({ kind: "local-eval" }, {
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
    expect(legacy.lifecycle.status, "legacy executions still complete their lifecycle").toBe("complete");
    expect(legacy.substance, "legacy checks never become numeric scores").toMatchObject({ score: null, label: "1/2 checks", qualified: false });
    expect(legacy.substance.gates.map((gate) => [gate.id, gate.passed]), "legacy checks stay ordered").toEqual([
      ["build", true],
      ["tests", false],
    ]);
    expect(legacy.case.prompt, "legacy prompt survives").toBe("Fix it.");
    expect(legacy.presentation, "legacy presentation stays unjudged").toMatchObject({ score: null, label: "Unjudged" });

    const recursive = projectExecutionDossier({ kind: "local-eval" }, {
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
    expect(recursive.recursiveComplete, "agent-authored authority and child evidence project separately").toEqual({
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
    expect(recursive.actions.traceable, "recursive children remain traceable").toBe(true);
  });
});
