import type { CompletionOutput } from "@relayer/graph-client";
import { checkBasicOutput, type EvalCheck, type GraphMemoryAuditEvent } from "./graph-checks.js";
import { isNaturalGraphMemoryQueryShape } from "./natural-graph-memory-query.js";

interface RecursiveInteraction {
  readonly id: number;
  readonly graphNodeId: number;
  readonly completionOutput?: CompletionOutput;
}

interface RecursiveChild {
  readonly sourceInteractionId: number | string;
  readonly sourceActionId: number;
  readonly rootLayerId: number;
  readonly acceptedRootNodes?: readonly { readonly title: string; readonly detail: string }[];
}

export interface RecursiveGraphMemoryGradingExecution {
  readonly harnessConfiguration?: {
    readonly graphCapabilityProfile?: { readonly search?: string };
    readonly complete?: { readonly agentAuthored?: boolean };
  };
  readonly turns: readonly { readonly candidateTrace?: { readonly completionBrokerAvailable?: boolean } }[];
  readonly semanticChildren?: readonly RecursiveChild[];
}

export async function gradeRecursiveGraphMemoryExecution(input: {
  readonly execution: RecursiveGraphMemoryGradingExecution;
  readonly interactions: readonly RecursiveInteraction[];
  readonly graphOperationsByTurn: readonly (readonly GraphMemoryAuditEvent[])[];
}): Promise<{ readonly turns: readonly { readonly checks: readonly EvalCheck[]; readonly evidence?: Readonly<Record<string, unknown>> }[] }> {
  const { execution, interactions, graphOperationsByTurn } = input;
  if (interactions.length !== 3) throw new Error("Recursive graph-memory grading requires exactly three product turns.");
  const productTurns = interactions;
  if (productTurns.some((interaction) => !interaction.completionOutput)) {
    throw new Error("Recursive graph-memory grading requires three completed graph outputs.");
  }
  const outputs = productTurns.map((interaction) => interaction.completionOutput!);
  const roots = outputs.map((output) => output.rootLayer.layer.id);
  const priorTopics = ["Offline recovery covenant", "Constrained recovery revision"];
  const searchEnabled = execution.harnessConfiguration?.graphCapabilityProfile?.search === "query-v1";
  const recursionEnabled = execution.harnessConfiguration?.complete?.agentAuthored === true;
  const turns = productTurns.map((interaction, index) => {
    const output = outputs[index]!;
    const checks: EvalCheck[] = [
      ...checkBasicOutput(output, interaction.graphNodeId),
      {
        name: "completion-broker-authority",
        passed: execution.turns[index]?.candidateTrace?.completionBrokerAvailable === recursionEnabled,
        detail: `Recursion is ${recursionEnabled ? "enabled" : "disabled"}; the portable Candidate Trace must record matching agent-authored Complete authority.`,
      },
    ];
    const requiredHeading = priorTopics[index];
    if (requiredHeading !== undefined) checks.push({
      name: "requested-decision-section",
      passed: output.rootLayer.nodes.filter((node) => node.title === requiredHeading).length === 1,
      detail: `Turn ${index + 1} must retain exactly one requested “${requiredHeading}” decision section in its accepted root.`,
    });
    if (index === 0) return { checks };

    const events = graphOperationsByTurn[index] ?? [];
    const searches = events.filter((event) => event.method === "POST" && event.path === "/api/graph/search" && event.status >= 200 && event.status < 300);
    const requiredPriorRoots = index === 1 ? [roots[0]!] : [roots[0]!, roots[1]!];
    const acceptedReferences = output.rootLayer.actions.filter((action) => (
      action.state === "accepted" && action.kind === "navigate" && action.relation === "reference"
      && action.sourceLayerId === output.rootLayer.layer.id && typeof action.targetLayerId === "number"
      && requiredPriorRoots.includes(action.targetLayerId)
    ));
    const acknowledgement = events.filter((event) => (
      event.method === "POST" && (event.path === "/api/graph/submit" || event.path === "/api/graph/current/transitions")
      && event.status >= 200 && event.status < 300
      && (event.path !== "/api/graph/submit" || event.completionNodeId === output.nodeId)
    )).at(-1);
    const evidenceByRoot = requiredPriorRoots.map((root, rootIndex) => {
      const search = searches.find((event) => matchesBoundedPriorWorkSearch(event, priorTopics[rootIndex]!, root));
      const acceptedReference = acceptedReferences.find((action) => action.targetLayerId === root);
      const referenceEvent = acceptedReference === undefined ? undefined : events.find((event) => (
        event.method === "POST" && event.path === "/api/graph/actions" && event.status >= 200 && event.status < 300
        && event.recordId === acceptedReference.id && event.actionKind === acceptedReference.kind
        && event.actionRelation === acceptedReference.relation && event.actionSourceNodeId === acceptedReference.sourceNodeId
        && event.actionSourceLayerId === acceptedReference.sourceLayerId && event.actionTargetLayerId === acceptedReference.targetLayerId
      ));
      return { root, search, acceptedReference, referenceEvent };
    });
    const matchedSearches = evidenceByRoot.map(({ search }) => search).filter((event) => event !== undefined);
    const exactSearchSet = matchedSearches.length === searches.length && new Set(matchedSearches).size === searches.length;
    const searchedLayerIds = evidenceByRoot.flatMap(({ search }) => search?.searchLayerIds ?? []);
    if (searchEnabled) {
      checks.push({ name: "prior-work-search", passed: exactSearchSet && evidenceByRoot.every(({ search }) => search !== undefined), detail: `Follow-up ${index} must use bounded parameterized search to recover ${requiredPriorRoots.length} required prior accepted root${requiredPriorRoots.length === 1 ? "" : "s"}.` }, {
        name: "prior-work-references", passed: evidenceByRoot.every(({ acceptedReference, referenceEvent }) => acceptedReference !== undefined && referenceEvent !== undefined), detail: "Every required searched root must remain attached to the accepted follow-up as typed supporting context.",
      }, {
        name: "search-reference-submit-order", passed: acknowledgement !== undefined && evidenceByRoot.every(({ search, referenceEvent }) => search !== undefined && referenceEvent !== undefined && search.sequence < referenceEvent.sequence && referenceEvent.sequence < acknowledgement.sequence), detail: "Candidate Trace must show successful search before the matching accepted references and final acknowledgement.",
      });
    } else checks.push({ name: "graph-search-disabled", passed: searches.length === 0, detail: `Search is disabled for this cell; observed ${searches.length} successful graph-search operation${searches.length === 1 ? "" : "s"}.` });

    if (index === 2) {
      const allChildren = execution.semanticChildren ?? [];
      const finalChildren = allChildren.filter((child) => String(child.sourceInteractionId) === String(interaction.id));
      const attachedFinalChildren = finalChildren.filter((child) => output.rootLayer.actions.some((action) => action.state === "accepted" && action.kind === "invoke" && action.id === child.sourceActionId && action.sourceLayerId === output.rootLayer.layer.id && action.targetLayerId === child.rootLayerId));
      const childStopConditions = finalChildren.flatMap((child) => child.acceptedRootNodes ?? []).filter((node) => node.title === "Red-team stop condition" && node.detail.trim() !== "");
      const parentStopConditions = output.rootLayer.nodes.filter((node) => node.title === "Red-team stop condition" && node.detail.trim() !== "");
      checks.push({ name: "final-red-team-stop-condition", passed: parentStopConditions.length === 1, detail: "Every cell must expose exactly one falsifiable Red-team stop condition in the final accepted memo." });
      if (recursionEnabled) checks.push({ name: "semantic-child-observation", passed: true, detail: `Recursion was available; observed ${allChildren.length} descendant execution${allChildren.length === 1 ? "" : "s"}, ${finalChildren.length} from the final turn. Child creation remains observed behavior.` }, {
        name: "final-child-attached", passed: attachedFinalChildren.length === finalChildren.length, detail: "Any claimed final specialist contribution must retain its settled result through an exact action-bound resolved invoke.",
      }, {
        name: "child-result-text-aligned", passed: finalChildren.length === 0 || childStopConditions.some((child) => parentStopConditions.length === 1 && child.detail === parentStopConditions[0]!.detail), detail: "The final memo and specialist result must expose the same falsifiable stop condition. This is semantic alignment evidence, not broker-delivery proof.",
      });
      else {
        const resolvedInvokes = outputs.flatMap((turn) => turn.rootLayer.actions).filter((action) => action.state === "accepted" && action.kind === "invoke" && action.targetLayerId !== null && action.targetLayerId !== undefined);
        checks.push({ name: "recursion-disabled-no-semantic-child", passed: allChildren.length === 0, detail: `Recursion is disabled for this cell; observed ${allChildren.length} semantic child execution${allChildren.length === 1 ? "" : "s"}.` }, {
          name: "recursion-disabled-no-resolved-invoke", passed: resolvedInvokes.length === 0, detail: `Recursion is disabled for this cell; observed ${resolvedInvokes.length} accepted resolved invoke action${resolvedInvokes.length === 1 ? "" : "s"}.`,
        });
      }
    }
    return { checks, evidence: { successfulSearchCount: searches.length, searchedLayerIds, requiredPriorRoots, referenceActionIds: evidenceByRoot.map(({ referenceEvent }) => referenceEvent?.recordId).filter((id): id is number => Number.isSafeInteger(id)) } };
  });
  return { turns };
}

function matchesBoundedPriorWorkSearch(event: GraphMemoryAuditEvent, topic: string, rootLayerId: number): boolean {
  if (event.queryContractVersion !== 1 || event.target !== undefined || event.resultTruncated !== false
    || typeof event.query !== "string" || event.parameters === undefined || event.parameters === null
    || typeof event.parameters !== "object"
    || Array.isArray(event.parameters) || (event.budget !== undefined && (event.budget === null || Array.isArray(event.budget)))
    || !Array.isArray(event.searchLayerIds) || event.searchLayerIds.length !== 1 || event.searchLayerIds[0] !== rootLayerId) return false;
  const entries = Object.entries(event.parameters);
  if (entries.length !== 1) return false;
  const [parameterName, parameter] = entries[0]!;
  if (parameter === null || typeof parameter !== "object" || Array.isArray(parameter)) return false;
  const value = parameter as Record<string, unknown>;
  if (value.type !== "string" || value.value !== topic) return false;
  if (event.budget !== undefined && typeof event.budget !== "object") return false;
  const budget = event.budget as Record<string, unknown> | undefined;
  const rows = budget?.resultRows;
  return (rows === undefined || (Number.isSafeInteger(rows) && (rows as number) >= 1 && (rows as number) <= 5))
    && isNaturalGraphMemoryQueryShape(event.query, parameterName, "iu");
}
