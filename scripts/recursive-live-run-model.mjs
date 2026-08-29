/**
 * Deterministic analysis for the recursive Complete live run.
 *
 * The runner owns process boot and paid inference. Everything that decides whether a run
 * passed lives here so it can be proven without a provider.
 */

/**
 * The fixed synthetic task for Check 1.
 *
 * It is demanding enough that a capable agent delegates by its own judgment. It never
 * instructs delegation, because a run that only proves obedience proves nothing.
 */
export const RECURSIVE_LIVE_RUN_TASK = [
  "Compare three real approaches to running untrusted agent code on a developer laptop:",
  "OS-level sandboxing, container isolation, and a separate virtual machine.",
  "For each approach, cover the isolation boundary it actually enforces, the escape it",
  "does not prevent, and the developer-experience cost of adopting it.",
  "Ground every claim in a named mechanism rather than a general principle, and end with",
  "a recommendation for a team shipping a desktop agent product.",
].join(" ");

const TERMINAL_LIFECYCLES = new Set(["succeeded", "stopped", "failed"]);

/**
 * Orders raw projection events by their durable outbox sequence, dropping repeats.
 *
 * The runner pages the projection feed, so the same event can arrive twice across pages.
 */
export function orderedRevisions(events) {
  const seen = new Set();
  return [...events]
    .filter((event) => {
      if (seen.has(event.sequence)) return false;
      seen.add(event.sequence);
      return true;
    })
    .sort((left, right) => left.sequence - right.sequence);
}

/**
 * Reports every way one completion's published sequence departs from the contract.
 *
 * `CurrentTransition::Advance` enforces accessibility, publication, and the snapshot digest
 * per revision inside the graph engine. The run asserts the observable consequence: each
 * revision is numbered, follows its predecessor, and publishes a layer while active.
 */
export function revisionFindings(completionId, revisions) {
  const findings = [];
  let previous;
  for (const revision of revisions) {
    if (!Number.isSafeInteger(revision.revision) || revision.revision < 0) {
      findings.push(`completion ${completionId} published an unnumbered revision`);
      continue;
    }
    if (previous === undefined) {
      previous = revision;
      continue;
    }
    if (TERMINAL_LIFECYCLES.has(previous.lifecycle)) {
      findings.push(
        `completion ${completionId} published revision ${revision.revision} after settling ${previous.lifecycle}`,
      );
    }
    if (revision.revision <= previous.revision) {
      findings.push(
        `completion ${completionId} revision ${revision.revision} does not advance past ${previous.revision}`,
      );
    }
    if (revision.previousRevision !== previous.revision) {
      findings.push(
        `completion ${completionId} revision ${revision.revision} is not reachable from ${previous.revision}`,
      );
    }
    if (revision.lifecycle === "active" && revision.currentLayerId === null) {
      findings.push(
        `completion ${completionId} revision ${revision.revision} advanced without publishing a layer`,
      );
    }
    previous = revision;
  }
  return findings;
}

/** Groups an ordered event list into one sequence per completion, preserving order. */
export function revisionsByCompletion(events) {
  const sequences = new Map();
  for (const event of orderedRevisions(events)) {
    const existing = sequences.get(event.completionId);
    if (existing === undefined) sequences.set(event.completionId, [event]);
    else existing.push(event);
  }
  return sequences;
}

/**
 * Identifies the semantic children of one root.
 *
 * Child creation is a deterministic fact, not an inference from provider chatter: a
 * completion is a child exactly when its graph invocation names the root as its source.
 */
export function semanticChildren(rootCompletionId, completionMetadata) {
  return completionMetadata
    .filter((metadata) => metadata.invocation?.sourceInteractionNodeId === rootCompletionId)
    .map((metadata) => metadata.nodeId)
    .sort((left, right) => left - right);
}

/** Milliseconds from the interaction request to the first current that published a layer. */
export function timeToFirstObservableGraph(startedAtMs, observations) {
  const first = observations.find((observation) => observation.currentLayerId !== null);
  return first === undefined ? null : first.observedAtMs - startedAtMs;
}

/**
 * Assembles one run's durable record.
 *
 * `passed` covers only what a machine can decide. Semantic coherence is the judge's call
 * and blocks merge separately; a green deterministic run is not a graded run.
 */
export function summarizeRun({
  recursionEnabled,
  rootCompletionId,
  startedAtMs,
  settledAtMs,
  completionStatus,
  events,
  observations = [],
  completionMetadata = [],
}) {
  const sequences = revisionsByCompletion(events);
  const findings = [...sequences].flatMap(([completionId, revisions]) =>
    revisionFindings(completionId, revisions));
  const children = semanticChildren(rootCompletionId, completionMetadata);
  if (recursionEnabled && children.length === 0) {
    findings.push("no semantic child was created by the agent's own decision");
  }
  const rootRevisions = sequences.get(rootCompletionId) ?? [];
  if (recursionEnabled && rootRevisions.filter((revision) => revision.lifecycle === "active").length < 2) {
    findings.push("the root current pointer did not advance observably while work proceeded");
  }
  if (completionStatus !== "accepted") {
    findings.push(`the root completion settled ${completionStatus} rather than accepted`);
  }
  return {
    recursionEnabled,
    rootCompletionId,
    completionStatus,
    semanticChildren: children,
    revisions: [...sequences].map(([completionId, revisions]) => ({
      completionId,
      revisions: revisions.map((revision) => ({
        sequence: revision.sequence,
        revision: revision.revision,
        previousRevision: revision.previousRevision,
        lifecycle: revision.lifecycle,
        currentLayerId: revision.currentLayerId,
      })),
    })),
    timings: {
      timeToFirstObservableGraphMs: timeToFirstObservableGraph(startedAtMs, observations),
      totalTaskMs: settledAtMs - startedAtMs,
    },
    findings,
    passed: findings.length === 0,
    // Semantic coherence is graded separately and blocks merge on its own.
    judge: { verdict: "not-run", reason: "Gate 2 grades this run; Check 1 does not." },
  };
}

/**
 * Compares the enabled and disabled runs of the same build.
 *
 * Time to first observable graph is expected to favour recursion trivially. Total task
 * time is the number that can fail, because publishing intermediate accepted states costs.
 */
export function compareRuns(enabled, disabled) {
  return {
    timeToFirstObservableGraphMs: {
      enabled: enabled.timings.timeToFirstObservableGraphMs,
      disabled: disabled.timings.timeToFirstObservableGraphMs,
    },
    totalTaskMs: {
      enabled: enabled.timings.totalTaskMs,
      disabled: disabled.timings.totalTaskMs,
      overheadMs: enabled.timings.totalTaskMs - disabled.timings.totalTaskMs,
    },
  };
}
