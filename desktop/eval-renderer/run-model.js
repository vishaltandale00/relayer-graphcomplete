export function runPanelCopy(run) {
  if (run?.kind === "imported-conversation") {
    return {
      title: "Conversation review",
      description: "Open the immutable external conversation in the read-only production workspace or review its eligible judge results.",
    };
  }
  return {
    title: "Test cases",
    description: "Open the judge review or the read-only production workspace for one case × harness execution.",
  };
}

export const recursiveCompleteCaseId = "empty-project.recursive-complete.comparison";
export const recursiveCompleteHarnessPair = Object.freeze([
  "codex-eval-complete-disabled",
  "codex-eval-complete-enabled",
]);

export function isolateRecursiveCompleteSelection(testCaseIds, harnessConfigurationNames) {
  if (!testCaseIds.includes(recursiveCompleteCaseId)) {
    return { testCaseIds: [...testCaseIds], harnessConfigurationNames: [...harnessConfigurationNames] };
  }
  return {
    testCaseIds: [recursiveCompleteCaseId],
    harnessConfigurationNames: [...recursiveCompleteHarnessPair],
  };
}

export function authorizeRecursiveCompleteSelection(selection, confirmLiveRun) {
  if (!selection.testCaseIds.includes(recursiveCompleteCaseId)) return structuredClone(selection);
  const confirmed = confirmLiveRun(
    "Run two live Codex root cells for the agent-authored Complete comparison? The enabled root may launch additional agent-authored child execution. All of these use paid/live inference through the connected product provider.",
  );
  if (!confirmed) return null;
  return {
    ...structuredClone(selection),
    liveAuthorization: {
      confirmed: true,
      credentialReference: "connected-product-provider",
      rootProviderExecutions: 2,
      agentAuthoredChildren: true,
    },
  };
}

const asArray = (value) => Array.isArray(value) ? value : [];

function finiteScore(value) {
  return Number.isFinite(value) ? value : null;
}

function scoreLabel(value) {
  const score = finiteScore(value);
  if (score === null) return null;
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

function legacyLifecycleStatus(status) {
  if (status === "queued") return "queued";
  if (status === "running" || status === "judging") return "running";
  if (status === "error" || status === "interrupted") return "failed";
  if (["passed", "failed", "imported", "complete", "completed"].includes(status)) return "complete";
  return "queued";
}

function judgmentStatus(grade, lifecycleStatus, hasLegacyEvidence) {
  if (typeof grade?.status === "string") return grade.status;
  if (lifecycleStatus === "queued" || lifecycleStatus === "running") return "pending";
  return hasLegacyEvidence ? "complete" : "unjudged";
}

function judgmentLabel(status) {
  return ({
    queued: "Queued",
    pending: "Pending",
    running: "Running",
    judging: "Judging",
    complete: "Complete",
    completed: "Complete",
    failed: "Failed",
    partial: "Partial",
    unjudged: "Unjudged",
    not_applicable: "N/A",
  })[status] ?? "Unjudged";
}

function evidenceRefLabel(reference) {
  if (typeof reference === "string") return reference;
  return reference?.label ?? reference?.ref ?? reference?.id ?? JSON.stringify(reference);
}

function criterionProjection(item, index) {
  const score = finiteScore(item?.score ?? item?.rating);
  return {
    id: item?.id ?? item?.criterionId ?? `criterion-${index + 1}`,
    label: item?.label ?? item?.name ?? item?.id ?? item?.criterionId ?? `Criterion ${index + 1}`,
    status: item?.status ?? (score === null ? "unjudged" : "scored"),
    score,
    detail: item?.detail ?? item?.summary ?? item?.reason ?? item?.rationale ?? "",
    evidenceRefs: asArray(item?.evidenceRefs).map(evidenceRefLabel),
  };
}

function gateProjection(item, index) {
  const status = item?.status === "completed"
    ? item?.passed === true ? "passed" : item?.passed === false ? "failed" : "unjudged"
    : item?.status ?? (item?.passed === true ? "passed" : item?.passed === false ? "failed" : "unjudged");
  return {
    id: item?.id ?? item?.gateId ?? item?.name ?? `gate-${index + 1}`,
    label: item?.label ?? item?.name ?? item?.id ?? item?.gateId ?? `Gate ${index + 1}`,
    passed: typeof item?.passed === "boolean" ? item.passed : item?.status === "passed",
    status,
    detail: item?.detail ?? item?.summary ?? item?.reason ?? "",
    evidenceRefs: asArray(item?.evidenceRefs).map(evidenceRefLabel),
  };
}

function caseSnapshotProjection(execution) {
  const snapshot = execution?.caseSnapshot ?? {};
  const task = snapshot.task ?? snapshot.visibleTask ?? snapshot.artifacts?.task ?? {};
  const repository = snapshot.repository ?? snapshot.fixture ?? snapshot.artifacts?.workspace ?? {};
  return {
    id: snapshot.id ?? snapshot.testCaseId ?? execution?.testCaseId ?? "Unknown case",
    name: snapshot.name ?? snapshot.title ?? execution?.testCaseId ?? "Unknown case",
    prompt: snapshot.prompt ?? snapshot.visiblePrompt ?? task.prompt ?? task.instruction ?? task.text ?? execution?.turns?.[0]?.prompt ?? "",
    version: snapshot.version ?? snapshot.caseVersion ?? (snapshot.schemaVersion ? `schema v${snapshot.schemaVersion}` : null),
    authoringStatus: snapshot.authoringStatus ?? null,
    digest: execution?.caseSnapshotDigest ?? snapshot.digest ?? snapshot.caseDigest ?? null,
    repository: repository.name ?? repository.repository ?? repository.url ?? repository.repositoryUrl ?? repository.source ?? snapshot.repositoryName ?? null,
    commit: repository.commit ?? repository.upstreamCommit ?? repository.revision ?? snapshot.repositoryCommit ?? null,
  };
}

export function projectExecutionCell(run, execution) {
  if (!execution) {
    return {
      id: null,
      lifecycle: { status: "queued", label: "Queued" },
      substance: { status: "unjudged", label: "Unjudged", score: null, qualified: null },
      presentation: { status: "unjudged", label: "Unjudged", score: null, applicable: true },
    };
  }
  const lifecycleStatus = execution.lifecycle?.status ?? legacyLifecycleStatus(execution.status);
  const checks = asArray(execution.checks);
  const outcomeStatus = judgmentStatus(execution.outcomeGrade, lifecycleStatus, checks.length > 0);
  const outcomeScore = finiteScore(execution.outcomeGrade?.score);
  const qualified = typeof execution.outcomeGrade?.qualified === "boolean"
    ? execution.outcomeGrade.qualified
    : run?.kind === "imported-conversation"
      ? null
      : checks.length ? checks.every((check) => check.passed) : null;
  const legacyCheckLabel = checks.length
    ? `${checks.filter((check) => check.passed).length}/${checks.length} checks`
    : null;
  const hasLegacyPresentation = asArray(execution.turns).some((turn) => asArray(turn?.judgeResults).length > 0);
  const applicable = execution.presentationGrade?.status === "not_applicable"
    ? false
    : typeof execution.presentationGrade?.applicable === "boolean"
    ? execution.presentationGrade.applicable
    : typeof execution.caseSnapshot?.presentation?.graphApplicable === "boolean"
      ? execution.caseSnapshot.presentation.graphApplicable
    : run?.kind !== "imported-conversation" || hasLegacyPresentation;
  const presentationStatus = applicable
    ? judgmentStatus(execution.presentationGrade, lifecycleStatus, hasLegacyPresentation)
    : "not_applicable";
  const presentationScore = applicable ? finiteScore(execution.presentationGrade?.score) : null;
  return {
    id: execution.id ?? null,
    lifecycle: {
      status: lifecycleStatus,
      label: judgmentLabel(lifecycleStatus),
      startedAt: execution.lifecycle?.startedAt ?? null,
      completedAt: execution.lifecycle?.completedAt ?? null,
      durationMs: Number.isFinite(execution.lifecycle?.durationMs) ? execution.lifecycle.durationMs : null,
    },
    substance: {
      status: outcomeStatus,
      label: outcomeScore === null ? legacyCheckLabel ?? judgmentLabel(outcomeStatus) : scoreLabel(outcomeScore),
      score: outcomeScore,
      qualified,
    },
    presentation: {
      status: presentationStatus,
      label: presentationScore === null ? judgmentLabel(presentationStatus) : scoreLabel(presentationScore),
      score: presentationScore,
      applicable,
    },
  };
}

export function projectExecutionDossier(run, execution) {
  if (!execution) return null;
  const cell = projectExecutionCell(run, execution);
  const outcome = execution.outcomeGrade ?? {};
  const presentation = execution.presentationGrade ?? {};
  const legacyGates = asArray(execution.checks).map((check) => ({ ...check, id: check.name }));
  const declaredGates = asArray(outcome.mandatoryGates).length
    ? asArray(outcome.mandatoryGates)
    : asArray(outcome.gates);
  const gates = declaredGates.length ? declaredGates : legacyGates;
  const semanticChildren = asArray(execution.semanticChildren);
  const traceable = [...asArray(execution.turns), ...semanticChildren]
    .some((turn) => Boolean(turn?.candidateTrace));
  const hasJudgeOutput = asArray(execution.turns).some((turn) => (
    turn?.deterministicJudge || asArray(turn?.judgeResults).length > 0
  ));
  return {
    id: execution.id,
    case: caseSnapshotProjection(execution),
    harness: {
      name: execution.harnessConfigurationName ?? "Unknown harness",
      implementation: execution.harnessConfiguration?.implementation ?? null,
      digest: execution.harnessConfigurationDigest ?? null,
    },
    lifecycle: cell.lifecycle,
    substance: {
      ...cell.substance,
      verifierId: outcome.verifierId ?? execution.caseSnapshot?.artifacts?.verifier?.verifierId ?? null,
      verifierDigest: outcome.verifierDigest ?? execution.caseSnapshot?.artifacts?.verifier?.contentDigest ?? null,
      rubricVersion: outcome.rubricVersion ?? execution.caseSnapshot?.artifacts?.outcomeRubric?.rubricVersion ?? null,
      gates: gates.map(gateProjection),
      criteria: asArray(outcome.criteria).map(criterionProjection),
      evidenceRefs: asArray(outcome.evidenceRefs).map(evidenceRefLabel),
    },
    presentation: {
      ...cell.presentation,
      comprehensionScore: finiteScore(presentation.comprehensionScore),
      renderedScore: finiteScore(presentation.renderedScore),
      rawScore: finiteScore(presentation.rawScore),
      scoreCeiling: [1, 2, 3, 4].includes(presentation.scoreCeiling) ? presentation.scoreCeiling : null,
      decay: Number.isFinite(presentation.depthDecay)
        ? presentation.depthDecay
        : Number.isFinite(presentation.decay) ? presentation.decay : null,
      layers: asArray(presentation.layers),
      aggregation: presentation.aggregation ?? null,
      aggregationMethod: presentation.aggregationMethod ?? null,
      worstLayer: presentation.worstLayer ?? null,
      hasMateriallyMisleadingLayer: typeof presentation.hasMateriallyMisleadingLayer === "boolean"
        ? presentation.hasMateriallyMisleadingLayer
        : Number.isInteger(presentation.materiallyMisleadingLayerCount)
          ? presentation.materiallyMisleadingLayerCount > 0
          : null,
      materiallyMisleadingLayerCount: Number.isInteger(presentation.materiallyMisleadingLayerCount)
        ? presentation.materiallyMisleadingLayerCount
        : null,
      evidenceRefs: (asArray(presentation.evidenceRefs).length
        ? asArray(presentation.evidenceRefs)
        : asArray(presentation.layers).flatMap((layer) => asArray(layer?.evidenceRefs)))
        .map(evidenceRefLabel),
    },
    recursiveComplete: {
      declared: execution.harnessConfiguration?.complete !== undefined,
      configured: execution.harnessConfiguration?.complete?.agentAuthored === true,
      brokerAvailable: execution.turns?.[0]?.candidateTrace?.completionBrokerAvailable ?? null,
      children: semanticChildren.map((child) => ({
        interactionId: child.interactionId,
        graphNodeId: child.graphNodeId,
        sourceInteractionId: child.sourceInteractionId,
        sourceActionId: child.sourceActionId,
        status: child.status,
        traceStatus: child.candidateTrace?.status ?? "disabled",
        projectionCount: asArray(child.projectionObservations).length,
      })),
    },
    error: execution.error ?? null,
    promotable: execution.promotable !== false,
    actions: {
      traceable,
      judgeReviewable: hasJudgeOutput || run?.kind !== "imported-conversation",
      workspaceReviewable: asArray(execution.threadIds).length > 0,
      annotationExportable: annotatedExecutionExportable(run, execution),
      importedJudgeEligible: run?.kind === "imported-conversation"
        && asArray(execution.turns).some((turn) => turn.status === "accepted"),
    },
  };
}

export function annotatedExecutionExportable(run, execution) {
  const executionTerminal = ["passed", "failed", "imported"].includes(execution?.status);
  const threadIds = [...new Set(execution?.threadIds || [])];
  const covered = new Set((execution?.turns || []).map((turn) => String(turn?.threadId)));
  const turnsFinalized = execution?.turns?.length > 0
    && execution.turns.every((turn) => (
      turn?.threadId != null
      && turn?.interactionId != null
      && threadIds.some((threadId) => String(threadId) === String(turn.threadId))
      && ["accepted", "failed", "stopped"].includes(turn.status)
    ))
    && threadIds.every((threadId) => covered.has(String(threadId)));
  return executionTerminal
    && turnsFinalized
    && threadIds.length > 0
    && typeof run?.bundleRef === "string"
    && run.bundleRef.length > 0;
}
