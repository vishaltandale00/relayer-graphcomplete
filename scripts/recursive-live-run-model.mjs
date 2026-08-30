import { resolve } from "node:path";

/**
 * Deterministic analysis for the recursive Complete live run.
 *
 * The runner owns process boot and paid inference. Everything that decides whether a run
 * passed lives here so it can be proven without a provider.
 */

/** Every provider definition the live run knows how to lease an execution from. */
export const LIVE_RUN_AUTH = Object.freeze({
  openrouter: { adapterId: "openrouter", contract: "secret@1", endpoint: "https://openrouter.ai/api/v1" },
  "openai-api": { adapterId: "openai-api", contract: "secret@1", endpoint: "https://api.openai.com/v1" },
  "anthropic-api": { adapterId: "anthropic-api", contract: "secret@1", endpoint: "https://api.anthropic.com/v1" },
  "codex-subscription": { adapterId: "codex-subscription", contract: "managed-runtime@1" },
});

/** Harness implementations that run a task through the managed Codex executable. */
const CODEX_IMPLEMENTATIONS = new Set(["codex.basic"]);

/** Names the profiles a credentials document defines, for an error a human can act on. */
export function liveRunProfileNames(document) {
  const runs = document?.runs;
  return runs === null || typeof runs !== "object" || Array.isArray(runs) ? [] : Object.keys(runs);
}

/**
 * Validates one named run profile against the harness it selects.
 *
 * Errors name the field and never quote its value, because the value may be the key. A
 * subscription carries no key at all: the provider CLI holds that login inside its own home.
 */
export function resolveRunProfile(document, name, { implementation, path = "live-run.local.json" }) {
  const profile = document?.runs?.[name];
  if (profile === null || typeof profile !== "object" || Array.isArray(profile)) {
    const known = liveRunProfileNames(document);
    throw new Error(`${path} has no run profile ${name}.${known.length === 0 ? "" : ` It defines: ${known.join(", ")}.`}`);
  }
  const required = (field, value) => {
    const trimmed = String(value ?? "").trim();
    if (!trimmed) throw new Error(`${path} run ${name} needs ${field}.`);
    return trimmed;
  };
  const kind = String(profile.auth?.kind ?? "").trim();
  const auth = LIVE_RUN_AUTH[kind];
  if (auth === undefined) {
    throw new Error(`${path} run ${name} needs auth.kind set to one of: ${Object.keys(LIVE_RUN_AUTH).join(", ")}.`);
  }
  const apiKey = String(profile.auth?.apiKey ?? "").trim();
  if (auth.contract === "secret@1" && !apiKey) {
    throw new Error(`${path} run ${name} needs auth.apiKey for ${kind}.`);
  }
  if (auth.contract === "managed-runtime@1" && apiKey) {
    throw new Error(`${path} run ${name} must leave auth.apiKey null for ${kind}; its login lives in codexHome.`);
  }
  const codex = CODEX_IMPLEMENTATIONS.has(implementation);
  if (!codex && auth.contract === "managed-runtime@1") {
    throw new Error(`${path} run ${name} selects ${implementation}, which accepts a key rather than a ${kind} login.`);
  }
  return {
    ...auth,
    name,
    harness: required("harness", profile.harness),
    implementation,
    // The Codex harness declares compatibility with the built-in `codex` provider, so the
    // definition keeps that id while its adapter varies.
    providerId: String(profile.providerId ?? "codex").trim(),
    modelId: required("modelId", profile.modelId),
    ...(codex
      ? {
        codexExecutable: resolve(required("codexExecutable", profile.codexExecutable)),
        codexHome: resolve(required("codexHome", profile.codexHome)),
      }
      : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(auth.endpoint === undefined
      ? {}
      : { endpoint: String(profile.auth?.endpoint ?? "").trim() || auth.endpoint }),
  };
}

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
const PRE_TERMINAL_PRODUCT_STATUSES = new Set([
  "not_started", "running", "submitted", "preparing", "draft", "waiting_for_approval",
]);
const TEMPORAL_FEATURE_KEYS = [
  "schemaRead", "rootCurrentWrite", "projectionUi", "invokeResolution", "providerRecursion",
];

/** Normalizes requested/effective temporal feature documents for exact comparison. */
export function normalizedTemporalFeatures(features = {}, { requireExplicit = false } = {}) {
  if (features === null || typeof features !== "object" || Array.isArray(features)) {
    throw new Error("Temporal features must be an object");
  }
  const unknown = Object.keys(features).filter((key) => !["configVersion", ...TEMPORAL_FEATURE_KEYS].includes(key));
  if (unknown.length > 0) throw new Error(`Temporal features contain unsupported fields: ${unknown.join(", ")}`);
  const configVersion = features.configVersion ?? 1;
  if (!Number.isSafeInteger(configVersion) || configVersion < 1) {
    throw new Error("Temporal features need a positive configVersion");
  }
  const normalized = { configVersion };
  for (const key of TEMPORAL_FEATURE_KEYS) {
    if (requireExplicit && features[key] === undefined) {
      throw new Error(`Effective temporal features omitted ${key}`);
    }
    if (features[key] !== undefined && typeof features[key] !== "boolean") {
      throw new Error(`Temporal feature ${key} must be boolean`);
    }
    normalized[key] = features[key] ?? false;
  }
  return normalized;
}

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
  requestedTemporalFeatures = {},
  actualTemporalFeatures = {},
  expectedAttachmentProvider,
  rootCompletionId,
  startedAtMs,
  settledAtMs,
  completionStatus,
  events,
  observations = [],
  completionMetadata = [],
  completionExecutions = [],
  traces = [],
}) {
  const normalizedRequestedTemporalFeatures = normalizedTemporalFeatures(requestedTemporalFeatures);
  const normalizedActualTemporalFeatures = normalizedTemporalFeatures(actualTemporalFeatures, { requireExplicit: true });
  const sequences = revisionsByCompletion(events);
  const findings = [...sequences].flatMap(([completionId, revisions]) =>
    revisionFindings(completionId, revisions));
  const children = semanticChildren(rootCompletionId, completionMetadata);
  const relevantCompletionIds = [rootCompletionId, ...children];
  if (recursionEnabled && children.length === 0) {
    findings.push("no semantic child was created by the agent's own decision");
  }
  if (!recursionEnabled && children.length > 0) {
    findings.push("recursion-disabled execution created a semantic child");
  }
  const observedActiveRoot = observations.filter((observation) => observation.source === "live"
    && observation.completionId === rootCompletionId
    && observation.lifecycle === "active"
    && PRE_TERMINAL_PRODUCT_STATUSES.has(observation.rootStatus));
  const observedActiveRootSequences = new Set(observedActiveRoot.map((observation) => observation.sequence));
  const observedActiveRootPolls = new Set(observedActiveRoot.map((observation) => observation.pollSequence));
  if (recursionEnabled && (observedActiveRootSequences.size < 2 || observedActiveRootPolls.size < 2)) {
    findings.push("the root current pointer did not advance observably while work proceeded");
  }
  for (const completionId of children) {
    const metadata = completionMetadata.find((candidate) => candidate.nodeId === completionId);
    const revisions = sequences.get(completionId) ?? [];
    if (revisions[0]?.revision !== 0) {
      findings.push(`child completion ${completionId} did not publish revision 0`);
    }
    if (!revisions.some((revision) => revision.revision > 0)) {
      findings.push(`child completion ${completionId} did not advance past revision 0`);
    }
    const terminal = revisions.at(-1);
    if (terminal?.lifecycle !== "succeeded" || terminal.currentLayerId === null) {
      findings.push(`child completion ${completionId} did not publish a succeeded terminal layer`);
    }
    const execution = completionExecutions.find((candidate) => (
      candidate.completionId === completionId && candidate.sourceCompletionId === rootCompletionId
    ));
    if (execution === undefined) {
      findings.push(`child completion ${completionId} has no durable execution record`);
    } else if (execution.phase !== "settled"
      || execution.attachment?.present !== true
      || execution.attachment?.schemaVersion !== 1
      || (expectedAttachmentProvider !== undefined
        && execution.attachment?.provider !== expectedAttachmentProvider)
      || execution.settlement?.present !== true
      || execution.settlement?.valid !== true
      || execution.settlement?.completionStatus !== "accepted"
      || execution.settlement?.safeReason !== undefined) {
      findings.push(`child completion ${completionId} was not durably attached and settled accepted`);
    } else if (metadata?.invocation?.sourceActionId !== execution.sourceActionId) {
      findings.push(`child completion ${completionId} invocation action did not match durable execution`);
    }
  }
  if (!recursionEnabled && completionExecutions.length > 0) {
    findings.push("recursion-disabled execution reached the completion broker");
  }
  for (const completionId of relevantCompletionIds) {
    const trace = traces.find((candidate) => candidate.completionId === completionId);
    if (trace === undefined || trace.status !== "complete" || trace.truncated === true || trace.coverageComplete !== true) {
      findings.push(`completion ${completionId} has no complete untruncated full-coverage candidate trace`);
    } else if (recursionEnabled && trace.completionBrokerAvailable !== true) {
      findings.push(`completion ${completionId} trace reported completion broker unavailable while recursion was enabled`);
    }
  }
  const rootTrace = traces.find((candidate) => candidate.completionId === rootCompletionId);
  if (!recursionEnabled && rootTrace !== undefined && rootTrace.completionBrokerAvailable !== false) {
    findings.push(
      `root trace reported completion broker ${rootTrace.completionBrokerAvailable ? "available" : "unavailable"} while recursion was disabled`,
    );
  }
  if (JSON.stringify(normalizedRequestedTemporalFeatures) !== JSON.stringify(normalizedActualTemporalFeatures)) {
    findings.push("the graph runtime temporal features did not match the requested feature set");
  }
  if (completionStatus !== "accepted") {
    findings.push(`the root completion settled ${completionStatus} rather than accepted`);
  }
  return {
    recursionEnabled,
    requestedTemporalFeatures: normalizedRequestedTemporalFeatures,
    actualTemporalFeatures: normalizedActualTemporalFeatures,
    ...(expectedAttachmentProvider === undefined ? {} : { expectedAttachmentProvider }),
    rootCompletionId,
    completionStatus,
    semanticChildren: children,
    completionExecutions,
    traces,
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
 * A single ordered pair is diagnostic only: provider load, model nondeterminism, warmup,
 * and unequal delegated work prevent it from establishing a performance effect.
 */
export function compareRuns(enabled, disabled) {
  return {
    interpretation: "diagnostic-only; an order-balanced repeated portfolio is required for a performance claim",
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
