import { isDeepStrictEqual } from "node:util";

export const instructionGraphTreatments = Object.freeze({
  "codex-instruction-graph-v1": Object.freeze({ name: "codex-instruction-graph-v1", promptProfile: "instruction-graph-v1", versionKey: "codex-instruction-graph-v1", readProtocol: 1 }),
  "codex-instruction-graph-v2": Object.freeze({ name: "codex-instruction-graph-v2", promptProfile: "instruction-graph-v2", versionKey: "codex-instruction-graph-v2", readProtocol: 2 }),
});
export const instructionGraphControlName = "codex-full-prompt-control";
export const instructionGraphHarnessPair = Object.freeze([instructionGraphControlName, "codex-instruction-graph-v1"]);
export const isInstructionGraphTreatment = (name) => Object.hasOwn(instructionGraphTreatments, name);

export function instructionGraphRouteIdentity(route) {
  const result = structuredClone(route);
  if (result?.selectedModel) delete result.selectedModel.harnessId;
  return result;
}

export async function preflightInstructionGraphComparison({ names, configurations, validateLiveCredential, credentialReference }) {
  if (typeof validateLiveCredential !== "function") throw new Error("Instruction-graph comparison has no trusted credential validator.");
  const routes = new Map();
  let control;
  for (const name of names) {
    const route = await validateLiveCredential(configurations.get(name), credentialReference,
      control ? { familyId: control.selectedModel.familyId } : {});
    if (route?.productModelSelection !== true || route.selectedModel?.familyId == null
      || route.selectedModel.harnessId !== name || !route.selectedModel.providerId || !route.selectedModel.modelId
      || !route.providerAdapterId) throw new Error("Instruction-graph preflight did not resolve an exact provider/model route for both harnesses.");
    if (control && !isDeepStrictEqual(instructionGraphRouteIdentity(control), instructionGraphRouteIdentity(route))) {
      throw new Error("Instruction-graph preflight routes differ in family, provider or model.");
    }
    control ??= route;
    routes.set(name, structuredClone(route));
  }
  return routes;
}

function normalized(configuration) {
  const result = structuredClone(configuration);
  delete result.name;
  delete result.revision;
  delete result.settings?.promptProfile;
  delete result.settings?.instructionGraphVersionKey;
  delete result.settings?.instructionGraphDigest;
  return result;
}

export function validateInstructionGraphComparison({ names, configurations, cases, targetKey, authorization, externalCaseIds = [] }) {
  const selectedTreatments = names?.filter(isInstructionGraphTreatment) ?? [];
  if (selectedTreatments.length === 0) return null;
  const spec = instructionGraphTreatments[selectedTreatments[0]];
  const pair = [instructionGraphControlName, spec.name];
  if (targetKey !== "macos-arm64") throw new Error("Instruction-graph Eval requires the qualified macOS Apple Silicon graph-search target.");
  if (!isDeepStrictEqual(names, pair)) throw new Error(`Instruction-graph Eval requires the exact ordered pair ${pair.join(", ")}.`);
  const [control, treatment] = names.map((name) => configurations.get(name));
  if (!control || !treatment || control.implementation !== "codex.basic"
    || control.settings?.promptProfile !== "layered-navigation-multi-agent-v1"
    || treatment.settings?.promptProfile !== spec.promptProfile
    || treatment.settings?.instructionGraphVersionKey !== spec.versionKey
    || !/^[a-f0-9]{64}$/.test(treatment.settings?.instructionGraphDigest ?? "")
    || control.settings?.instructionGraphVersionKey !== undefined || control.settings?.instructionGraphDigest !== undefined
    || control.complete?.agentAuthored !== true
    || control.graphCapabilityProfile?.search !== "query-v1"
    || control.settings?.personalPresentationVersion !== "personal-presentation-v6"
    || !isDeepStrictEqual(normalized(control), normalized(treatment))) {
    throw new Error("Instruction-graph configurations must match the frozen full-prompt control outside their names, revisions and instruction-delivery prompt profiles.");
  }
  if (cases.length === 0 || cases.some((definition) => !Array.isArray(definition?.prompts)
    || definition.prompts.length === 0 || definition.requiredHarnessConfigurationNames
    || definition.id === "empty-project.recursive-graph-memory.launch-readiness" || externalCaseIds.includes(definition.id))) {
    throw new Error("Instruction-graph comparison requires ordinary cases with fixed prompt sequences; run specialized comparisons separately.");
  }
  const rootProviderExecutions = cases.reduce((total, definition) => total + definition.prompts.length * 2, 0);
  if (authorization?.confirmed !== true || authorization.credentialReference !== "connected-product-provider"
    || authorization.rootProviderExecutions !== rootProviderExecutions || authorization.agentAuthoredChildren !== true
    || !Number.isFinite(authorization.declaredCostCapUsd) || authorization.declaredCostCapUsd <= 0) {
    throw new Error(`Instruction-graph comparison requires explicit authorization for ${rootProviderExecutions} live roots and additional model-controlled agent-authored child execution.`);
  }
  return {
    kind: "instruction-graph-pair",
    schemaVersion: 2,
    treatment: { ...spec, digest: treatment.settings.instructionGraphDigest },
    harnessPair: pair,
    controlledFields: ["task", "implementation", "settings except instruction delivery profile and exact corpus pin", "graphCapabilityProfile", "permissionBindings", "providerModelSelection", "complete.agentAuthored"],
    variedField: "settings.promptProfile",
    instructionPinFields: ["settings.instructionGraphVersionKey", "settings.instructionGraphDigest"],
    rootProviderExecutions,
    expectedTurnsByCase: Object.fromEntries(cases.map((definition) => [definition.id, definition.prompts.length])),
    qualityEquivalence: "unproven",
    tokenUsage: { status: "unknown", totalInputTokens: null, reason: "No validated aggregate of provider usage across root and native child executions is available. Consult Candidate Trace for recorded provider usage." },
    passed: null,
  };
}

export function finalizeInstructionGraphComparison(executions, caseIds, expectedTurnsByCase, comparison = {}) {
  const spec = comparison.treatment ?? instructionGraphTreatments["codex-instruction-graph-v1"];
  // Older saved comparisons did not record their pair and used codex-basic.
  const pair = comparison.harnessPair ?? ["codex-basic", spec.name];
  const checks = caseIds.flatMap((caseId) => {
    const cells = executions.filter((execution) => execution.testCaseId === caseId);
    const [control, treatment] = cells;
    const observed = (execution) => execution?.turns?.map((turn) => ({
      prompt: turn.prompt, modelSelection: turn.modelSelection,
      permissionProfileId: turn.permissionProfileId, effectivePermissionReceipt: turn.effectivePermissionReceipt,
      personalPresentationVersionId: turn.personalPresentationVersionId,
      personalPresentationVersionKey: turn.personalPresentationVersionKey,
    }));
    const passed = cells.length === 2
      && isDeepStrictEqual(cells.map(({ harnessConfigurationName }) => harnessConfigurationName), pair)
      && control?.modelResolution?.selectedModel != null
      && isDeepStrictEqual(instructionGraphRouteIdentity(control?.modelResolution), instructionGraphRouteIdentity(treatment?.modelResolution))
      && control?.turns?.length > 0 && control.turns.length === treatment?.turns?.length
      && control.turns.length === expectedTurnsByCase?.[caseId]
      && cells.every((cell) => cell.turns.every((turn) => turn.status === "accepted"
        && turn.personalPresentationVersionKey === "personal-presentation-v6"
        && Number.isSafeInteger(turn.personalPresentationVersionId)
        && turn.candidateTrace?.status === "complete" && turn.candidateTrace?.completionBrokerAvailable === true))
      && cells.every((cell) => {
        const route = comparison.preflight?.[cell.harnessConfigurationName]?.selectedModel;
        return !route || cell.turns.every((turn) => turn.modelSelection?.familyId === route.familyId
          && turn.modelSelection?.providerId === route.providerId && turn.modelSelection?.modelId === route.modelId);
      })
      && cells.every((cell) => (cell.semanticChildren ?? []).every((child) => child.status === "accepted"
        && child.candidateTrace?.status === "complete" && child.candidateTrace?.completionBrokerAvailable === true))
      && isDeepStrictEqual(observed(control), observed(treatment));
    const controlledCheck = { name: `instruction-graph:controlled-pair:${caseId}`, passed,
      detail: passed ? "Both instruction-delivery cells recorded matching task, provider/model, permissions and V6 presentation pins. Quality equivalence requires separate review."
        : "The instruction-delivery cells lack complete accepted matched evidence or drifted in their provider/model, task, permissions or V6 pins." };
    const treatmentSessions = [...(treatment?.turns ?? []), ...(treatment?.semanticChildren ?? [])];
    const expected = treatment?.harnessConfiguration?.settings;
    const retrievalPassed = treatmentSessions.length > 0 && treatmentSessions.every((turn) => {
      const metric = turn.instructionMetrics;
      return metric?.instructionDelivery?.versionKey === expected?.instructionGraphVersionKey
        && metric?.instructionDelivery?.digest === expected?.instructionGraphDigest
        && expected?.instructionGraphVersionKey === spec.versionKey
        && (comparison.treatment?.digest === undefined || expected.instructionGraphDigest === comparison.treatment.digest)
        && metric?.instructionRetrieval?.status === "recorded"
        && metric.instructionRetrieval.successfulReads > 0
        && (spec.readProtocol === 1 || (metric.instructionRetrieval.readProtocol === 2
          && metric.instructionRetrieval.reasonCoverage === "complete"));
    });
    return [controlledCheck, { name: `instruction-graph:retrieval:${caseId}`, passed: retrievalPassed,
      detail: retrievalPassed ? "Each captured treatment graph session recorded the exact configured instruction pin and a successful instruction-node or instruction-layer read. Incorporation remains a quality-review question."
        : "Treatment delivery or instruction-node/layer retrieval is missing, unverified or pinned to a different corpus." }];
  });
  return { passed: checks.length > 0 && checks.every((check) => check.passed), checks, qualityEquivalence: "unproven" };
}
