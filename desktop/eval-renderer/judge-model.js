const asArray = (value) => Array.isArray(value) ? value : [];

function id(value) {
  return value === null || value === undefined ? null : String(value);
}

function current(record) {
  return record?.history?.current ?? record?.review ?? null;
}

function presentationReview(review, kind) {
  if (!review || typeof review !== "object") return review;
  if (kind === "layer" && review.layerRatings) {
    return {
      ...review,
      ratings: review.layerRatings,
      summary: review.layerSummary,
      evidence: { viewport: asArray(review.evidence) },
      findings: asArray(review.findings),
    };
  }
  if (kind === "node" && review.score) {
    const { nodeId: _nodeId, ...ratings } = review.score;
    return {
      ...review,
      ratings,
      summary: review.semantic?.effectOnLayer || review.semantic?.delivered || "",
      findings: asArray(review.findings),
    };
  }
  if (kind === "action" && review.kind && "allocationStep" in review) {
    return {
      ...review,
      ratings: {},
      summary: [review.labelAndPlacement, review.delivery, review.recursiveContribution].filter(Boolean).join(" "),
      findings: [],
    };
  }
  return review;
}

function recordKey(layerId, nodeId) {
  return `${id(layerId)}:${id(nodeId)}`;
}

function actionKey(layerId, nodeId, actionId) {
  return `${recordKey(layerId, nodeId)}:${id(actionId)}`;
}

function screenshotIdFromReference(reference) {
  if (typeof reference !== "string") return null;
  const match = reference.match(/screenshots\/([^/]+)\/metadata\.json$/);
  return match?.[1] ?? null;
}

function collectEvidence(value, output = new Set()) {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") output.add(item);
      else collectEvidence(item, output);
    }
    return output;
  }
  for (const evidence of Object.values(value)) collectEvidence(evidence, output);
  return output;
}

export function evidenceIdsForReview(review) {
  if (!review || typeof review !== "object") return [];
  const evidence = collectEvidence(review.evidence);
  for (const finding of asArray(review.findings)) collectEvidence(finding?.evidence, evidence);
  collectEvidence(review.structure?.evidence, evidence);
  return [...evidence];
}

export function scoreForRatings(ratings) {
  const numeric = Object.values(ratings || {}).filter((rating) => Number.isFinite(rating));
  if (!numeric.length) return null;
  return Math.round((numeric.reduce((sum, rating) => sum + rating, 0) / numeric.length) * 10) / 10;
}

export function stateLabel(state) {
  return ({
    completed: "Complete",
    partial: "Partial",
    failed: "Failed",
    running: "Judging",
    skipped: "Skipped",
    unjudged: "Not judged",
  })[state] ?? "Not judged";
}

function turnState(turn, result) {
  if (result?.status === "completed") return "completed";
  if (result?.status === "partial") return "partial";
  if (result?.status === "failed") return "failed";
  if (result?.status === "running") return "running";
  if (turn.judgeEligible === false) return "skipped";
  if (turn.deterministicPassed === false) return "skipped";
  return "unjudged";
}

function missingReason(turn, result) {
  if (result?.error) return result.error;
  if (turn.judgeEligible === false) {
    return `This ${turn.status || "unaccepted"} turn has no accepted graph and is not result-judge eligible.`;
  }
  if (turn.deterministicPassed !== false) return null;
  const failures = asArray(turn.deterministicChecks).filter((check) => !check.passed);
  if (!failures.length) return "This turn did not pass the deterministic gate.";
  return failures.map((check) => check.detail || check.name).filter(Boolean).join(" ");
}

function missingSubjectKeys(result) {
  const keys = new Set();
  for (const subject of asArray(result?.coverage?.missingSubjects ?? result?.review?.coverage?.missingSubjects)) {
    if (subject?.kind === "layer") keys.add(`layer:${id(subject.subjectId)}`);
    if (subject?.kind === "node") keys.add(`node:${recordKey(subject.layerId, subject.subjectId)}`);
    if (subject?.kind?.endsWith("_action")) {
      keys.add(`action:${actionKey(subject.layerId, subject.nodeId, subject.subjectId)}`);
    }
    if (subject?.kind === "turn") keys.add("turn");
  }
  return keys;
}

function normalizeTurn(turn, position, judgeConfigurationName) {
  const simulatedResult = asArray(turn.judgeResults).at(-1) ?? null;
  const result = judgeConfigurationName === "deterministic-graph-contract"
    ? turn.deterministicJudge ?? null
    : simulatedResult ?? turn.deterministicJudge ?? null;
  const review = result?.review ?? null;
  const inventory = review?.inventory ?? { layers: [], nodes: [], actions: [] };
  const layerRecords = new Map(asArray(review?.layers).map((entry) => [id(entry?.subject?.layerId ?? current(entry)?.layerId), entry]));
  const nodeRecords = new Map(asArray(review?.nodes).map((entry) => [
    recordKey(entry?.subject?.layerId ?? current(entry)?.layerId, entry?.subject?.nodeId ?? current(entry)?.nodeId),
    entry,
  ]));
  const actionSubjects = asArray(inventory.actions);
  const missing = missingSubjectKeys(result);

  const rawLayers = asArray(inventory.layers).length
    ? asArray(inventory.layers)
    : asArray(review?.layers).map((entry, index) => ({
      layerId: entry?.subject?.layerId ?? current(entry)?.layerId,
      depth: entry?.subject?.depth ?? index,
      incomingActionIds: entry?.subject?.incomingActionIds ?? [],
    }));

  const rawNodes = asArray(inventory.nodes).length
    ? asArray(inventory.nodes)
    : asArray(review?.nodes).map((entry) => ({
      layerId: entry?.subject?.layerId ?? current(entry)?.layerId,
      nodeId: entry?.subject?.nodeId ?? current(entry)?.nodeId,
      actionIds: entry?.subject?.actionIds ?? [],
    }));

  const layers = rawLayers.map((subject, layerIndex) => {
    const layerId = id(subject.layerId);
    const layerReview = presentationReview(current(layerRecords.get(layerId)), "layer");
    const nodes = rawNodes.filter((node) => id(node.layerId) === layerId).map((node, nodeIndex) => {
      const nodeId = id(node.nodeId);
      const rawNodeReview = current(nodeRecords.get(recordKey(layerId, nodeId)));
      const nodeReview = presentationReview(rawNodeReview, "node");
      const actions = actionSubjects
        .filter((action) => id(action.layerId) === layerId && id(action.nodeId) === nodeId)
        .map((action, actionIndex) => {
          const actionId = id(action.actionId);
          const rawActionReview = asArray(rawNodeReview?.actions).find((candidate) => id(candidate.actionId) === actionId) ?? null;
          const actionReview = presentationReview(rawActionReview, "action");
          return {
            kind: "action",
            actionId,
            actionKind: action.actionKind ?? actionReview?.kind ?? "action",
            relation: action.relation ?? null,
            targetLayerId: id(action.targetLayerId),
            position: actionIndex,
            review: actionReview,
            reviewed: Boolean(actionReview) && !missing.has(`action:${actionKey(layerId, nodeId, actionId)}`),
            evidenceIds: evidenceIdsForReview(actionReview),
          };
        });
      return {
        kind: "node",
        layerId,
        nodeId,
        position: nodeIndex,
        review: nodeReview,
        reviewed: Boolean(nodeReview) && !missing.has(`node:${recordKey(layerId, nodeId)}`),
        evidenceIds: evidenceIdsForReview(nodeReview),
        actions,
      };
    });
    return {
      kind: "layer",
      layerId,
      depth: subject.depth ?? layerIndex,
      position: layerIndex,
      review: layerReview,
      reviewed: Boolean(layerReview) && !missing.has(`layer:${layerId}`),
      evidenceIds: evidenceIdsForReview(layerReview),
      nodes,
    };
  });

  const referencedScreenshots = asArray(result?.references?.screenshots)
    .map(screenshotIdFromReference)
    .filter(Boolean);
  const reviewedEvidence = [
    ...evidenceIdsForReview(review?.turn),
    ...layers.flatMap((layer) => [
      ...layer.evidenceIds,
      ...layer.nodes.flatMap((node) => [
        ...node.evidenceIds,
        ...node.actions.flatMap((action) => action.evidenceIds),
      ]),
    ]),
  ];

  const recursive = review?.schemaVersion === 2 || review?.contractId === "recursive-presentation-judge-v2";
  if (recursive) layers.sort((left, right) => right.depth - left.depth || left.position - right.position);
  return {
    kind: "turn",
    position,
    turnIndex: Number.isInteger(turn.turnIndex) ? turn.turnIndex : position,
    threadTurnIndex: Number.isInteger(turn.threadTurnIndex) ? turn.threadTurnIndex : null,
    interactionId: id(turn.interactionId),
    threadId: id(turn.threadId),
    threadDefinitionId: turn.threadDefinitionId ?? null,
    prompt: turn.prompt ?? "",
    completionStatus: turn.status ?? null,
    state: turnState(turn, result),
    stateLabel: stateLabel(turnState(turn, result)),
    stateReason: missingReason(turn, result),
    deterministicPassed: turn.deterministicPassed,
    judgeResultId: id(result?.id),
    result,
    provenance: result?.provenance ?? null,
    review: review?.turn ?? review?.turnReview ?? null,
    reviewed: Boolean(review?.turn) && !missing.has("turn"),
    evidenceIds: evidenceIdsForReview(review?.turn),
    allEvidenceIds: [...new Set(referencedScreenshots.length ? referencedScreenshots : reviewedEvidence)],
    layers,
    recursive,
    coverage: result?.coverage ?? review?.coverage ?? null,
  };
}

export function buildJudgeAnalysis(run, executionId) {
  const execution = asArray(run?.executions).find((candidate) => id(candidate.id) === id(executionId));
  if (!execution) throw new Error(`Execution ${executionId} is not part of run ${run?.id ?? "unknown"}.`);
  const turns = asArray(execution.turns)
    .map((turn, sourcePosition) => ({ turn, sourcePosition }))
    .sort((left, right) => (
      (Number.isInteger(left.turn.turnIndex) ? left.turn.turnIndex : left.sourcePosition)
      - (Number.isInteger(right.turn.turnIndex) ? right.turn.turnIndex : right.sourcePosition)
    ))
    .map(({ turn }, position) => normalizeTurn(turn, position, run.judgeConfigurationName));
  return {
    runId: id(run.id),
    runStatus: run.status ?? "unknown",
    judgeConfigurationName: run.judgeConfigurationName ?? "judge",
    execution: {
      id: id(execution.id),
      testCaseId: execution.testCaseId ?? "Test case",
      harnessConfigurationName: execution.harnessConfigurationName ?? "Harness",
      status: execution.status ?? "unknown",
    },
    turns,
  };
}

export function subjectForSelection(turn, selection) {
  if (!turn || !selection || selection.kind === "turn") return turn;
  const layer = turn.layers.find((candidate) => candidate.layerId === id(selection.layerId));
  if (!layer || selection.kind === "layer") return layer ?? turn;
  const node = layer.nodes.find((candidate) => candidate.nodeId === id(selection.nodeId));
  if (!node || selection.kind === "node") return node ?? layer;
  return node.actions.find((candidate) => candidate.actionId === id(selection.actionId)) ?? node;
}
