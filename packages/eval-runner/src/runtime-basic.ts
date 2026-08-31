import { Codex, type CodexOptions, type ThreadOptions, type TurnOptions } from "@openai/codex-sdk";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CompletionOutput, GraphCapability, GraphNode, ResolvedLayer } from "@relayer/graph-client";
import { digestHarnessConfiguration, startHarnessHost, type HarnessConfiguration, type HarnessFactory, type HarnessImplementationMap, type RunningHarnessHost } from "@relayer/harness-host";
import {
  graphMemorySearchBudget,
  graphMemorySearchParameters,
  graphMemorySearchQuery,
  graphMemorySearchTitle,
} from "./fixtures/graph-memory.js";
import type { TestExecutionPlan } from "./run-plan.js";

export const basicEvalCaseId = "empty-project.task-system.two-turn";
export const basicEvalPrompt = "A task system has an incoming queue, two workers, and a results store. Explain how a task moves through the system and what happens when both workers are busy.";
export const basicEvalFollowUpPrompt = "Follow up in the same thread: explain the task flow again, emphasizing what happens while both workers are busy and immediately after one worker finishes.";
export const replayRepairEvalCaseId = "graph-authoring.replay-repair";
export const graphMemoryEvalCaseId = "graph-memory.prior-accepted-reference";
const DEFAULT_EVAL_HARNESS_CLOSE_GRACE_MS = 30_000;
export const replayRepairEvalPrompt = `Explain, as a useful connected graph answer, why stable idempotency keys make retrying a partially persisted graph-authoring program safe.

This is a live graph-recovery evaluation. In one executable program, use explicit stable clientKey values and perform this exact recovery exercise through the ordinary Relayer graph client:
1. Define an author() function that creates two connected useful response nodes, their edge and root layer, one root response action, plus a separate one-node orphan draft layer. Return every persisted ID.
2. Call author() twice from newly constructed graph objects with the same stable keys, retaining both returned ID sets.
3. Call graph.submit() while the orphan is still draft. Require this call to fail specifically with code orphan_draft_layers; rethrow any other error or an unexpected success.
4. Call graph.discardLayer() on the orphan layer from the second pass, then call it again and retain both returned layer IDs.
5. Update one useful response node, using its same stable key, so its detail contains exactly one line beginning GRAPH_REPAIR_EVIDENCE= followed by compact JSON with this shape:
{"passes":[{"primaryNodeId":1,"secondaryNodeId":2,"edgeId":3,"rootLayerId":4,"rootActionId":5,"orphanNodeId":6,"orphanLayerId":7},{"primaryNodeId":1,"secondaryNodeId":2,"edgeId":3,"rootLayerId":4,"rootActionId":5,"orphanNodeId":6,"orphanLayerId":7}],"orphanSubmitErrorCode":"orphan_draft_layers","discardedLayerIds":[7,7]}
Use the actual returned numeric IDs, not these example values. Preserve the useful explanation around that evidence line, resubmit the stable-keyed root layer and root action if needed, then finish with a successful graph.submit().

Do not create fake navigation to the orphan. Do not delete graph records. The accepted answer should clearly explain stable client keys, retry after partial persistence, and idempotent recovery.`;

const graphMemoryPromptPair: readonly [string, string] = Object.freeze([
  `Explain when newly saved graph content becomes available to future requests. Include exactly one section titled ${graphMemorySearchTitle}.`,
  `Find your earlier ${graphMemorySearchTitle} explanation and link the original as supporting context in a concise follow-up. Do not recreate or paraphrase it.`,
]);

export function graphMemoryEvalPrompts(_testRunId?: string): readonly [string, string] {
  return graphMemoryPromptPair;
}

export function graphMemorySearchRequestMode(implementation: string): "exact" | "natural" {
  return implementation === "fixture.graph-memory" ? "exact" : "natural";
}
const repositoryRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

export function basicEvalPythonPath(existingPythonPath?: string): string {
  return [join(repositoryRoot, "python/relayer-graph/src"), existingPythonPath].filter(Boolean).join(delimiter);
}

export function selectStandalonePermissionProfile(configuration: HarnessConfiguration): string {
  const profiles = Object.keys(configuration.permissionBindings);
  if (profiles.includes("auto")) return "auto";
  if (profiles.length === 1) return profiles[0]!;
  throw new Error(`Standalone Eval cases need Auto or one unambiguous permission profile in ${configuration.name}.`);
}

export const basicEvalFacts = [
  { id: "enters-queue", description: "Tasks enter the incoming queue.", patterns: [/task.{0,30}(enter|arriv).{0,30}queue/i, /incoming queue/i] },
  { id: "worker-claims", description: "An available worker claims a queued task.", patterns: [/worker.{0,40}(claim|take|pull|pick)/i] },
  { id: "two-active-limit", description: "At most two tasks can be active.", patterns: [/(at most|maximum|max|up to).{0,15}two/i, /two.{0,20}(active|concurrent|workers)/i, /both.{0,30}busy.{0,30}no new task (starts|can start)/i] },
  { id: "wait-when-busy", description: "Additional tasks wait while both workers are busy.", patterns: [/(wait|remain|stay).{0,35}queue/i, /both workers.{0,35}busy/i] },
  { id: "write-result", description: "A completed task is written to the results store.", patterns: [/(result|output).{0,35}(store|write|save)/i, /(store|write|save).{0,35}(result|output)/i] },
  { id: "claim-next", description: "A freed worker claims the next queued task.", patterns: [/(free|available|finish).{0,45}(next|queue)/i, /(next).{0,35}(worker|claim|task)/i] },
] as const;

export interface EvalCheck { readonly name: string; readonly passed: boolean; readonly detail: string }
export interface RuntimeEvalTurn {
  readonly interactionNodeId: number;
  readonly prompt: string;
  readonly output: CompletionOutput;
  readonly checks: readonly EvalCheck[];
  readonly judge?: BasicJudge;
  readonly repairEvidence?: ReplayRepairEvidence;
  readonly graphMemoryEvidence?: GraphMemoryEvidence;
  readonly passed: boolean;
}
export interface RuntimeEvalArtifact {
  readonly schemaVersion: 3;
  readonly execution: TestExecutionPlan<BasicJudgeConfiguration>;
  readonly createdAt: string;
  readonly turns: readonly RuntimeEvalTurn[];
  readonly sessionChecks: readonly EvalCheck[];
  readonly deterministicPassed: boolean;
  readonly passed: boolean;
}
export interface BasicJudge { readonly factIds: readonly string[]; readonly graphUseful: boolean; readonly detailsUseful: boolean; readonly problems: readonly string[]; readonly verdict: "pass" | "fail" }
export interface BasicJudgeConfiguration { readonly name: "none" | "codex-structured" }
export interface BasicJudgeThread {
  run(input: string, options?: TurnOptions): Promise<{ readonly finalResponse: string }>;
}
export interface BasicJudgeThreadFactory {
  start(codexOptions: CodexOptions, threadOptions: ThreadOptions): BasicJudgeThread;
}

export interface ReplayRepairPass {
  readonly primaryNodeId: number;
  readonly secondaryNodeId: number;
  readonly edgeId: number;
  readonly rootLayerId: number;
  readonly rootActionId: number;
  readonly orphanNodeId: number;
  readonly orphanLayerId: number;
}

export interface ReportedReplayRepairEvidence {
  readonly passes: readonly [ReplayRepairPass, ReplayRepairPass];
  readonly orphanSubmitErrorCode: "orphan_draft_layers";
  readonly discardedLayerIds: readonly [number, number];
}

export interface ReplayRepairEvidence {
  readonly reported: ReportedReplayRepairEvidence;
  readonly stoppedLayer: ResolvedLayer;
  readonly stoppedLayerOwnerNodeId: number;
  readonly auditEvents: readonly ReplayRepairAuditEvent[];
}

export interface ReplayRepairAuditEvent {
  readonly sequence: number;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly recordKind?: "node" | "edge" | "layer" | "action";
  readonly recordId?: number;
  readonly recordState?: string;
  readonly errorCodes?: readonly string[];
  readonly completionNodeId?: number;
  readonly completionRootLayerId?: number;
  readonly searchLayerIds?: readonly number[];
  readonly resultTruncated?: boolean;
  readonly queryContractVersion?: number;
  readonly target?: Readonly<Record<string, unknown>>;
  readonly query?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly budget?: Readonly<Record<string, unknown>>;
  readonly actionKind?: string;
  readonly actionRelation?: string | null;
  readonly actionSourceNodeId?: number;
  readonly actionSourceLayerId?: number | null;
  readonly actionTargetLayerId?: number | null;
}

export interface GraphMemoryEvidence {
  readonly secondTurnStartSequence: number;
  readonly searchedLayerIds: readonly number[];
  readonly searchSequence?: number;
  readonly searchRequest?: {
    readonly queryContractVersion: number | undefined;
    readonly target?: Readonly<Record<string, unknown>>;
    readonly query: string | undefined;
    readonly parameters: Readonly<Record<string, unknown>> | undefined;
    readonly budget: Readonly<Record<string, unknown>> | undefined;
  };
  readonly draftDecoyLayerId?: number;
  readonly referenceActionId?: number;
  readonly referenceActionSequence?: number;
  readonly auditEvents: readonly ReplayRepairAuditEvent[];
}

export async function runBasicRuntimeEval(options: {
  outputDirectory: string;
  execution: TestExecutionPlan<BasicJudgeConfiguration>;
  implementations: HarnessImplementationMap;
  serverBinary?: string;
  serverReadyTimeoutMs?: number;
  harnessCloseGraceMs?: number;
  judgeCodexPathOverride?: string;
  judgeThreadFactory?: BasicJudgeThreadFactory;
}): Promise<RuntimeEvalArtifact> {
  if (![basicEvalCaseId, replayRepairEvalCaseId, graphMemoryEvalCaseId].includes(options.execution.testCaseId)) throw new Error(`Unsupported runtime-basic test case: ${options.execution.testCaseId}`);
  if (options.execution.harnessConfiguration.name !== options.execution.harnessConfigurationName) {
    throw new Error("Execution harness configuration name does not match its resolved snapshot");
  }
  if (digestHarnessConfiguration(options.execution.harnessConfiguration) !== options.execution.harnessConfigurationDigest) {
    throw new Error("Execution harness configuration digest does not match its resolved snapshot");
  }
  const workingDirectory = await mkdtemp(join(tmpdir(), "relayer-runtime-eval-"));
  const stateDirectory = join(workingDirectory, "state");
  const graphControlToken = randomUUID();
  const harnessControlToken = randomUUID();
  let graphProcess: Awaited<ReturnType<typeof startGraphServer>> | undefined;
  let graphAuditProxy: Awaited<ReturnType<typeof startGraphAuditProxy>> | undefined;
  let harnessHost: Awaited<ReturnType<typeof startHarnessHost>> | undefined;
  let operationError: unknown;
  try {
    graphProcess = await startGraphServer(options.serverBinary, join(stateDirectory, "graph.sqlite"), graphControlToken, options.serverReadyTimeoutMs);
    if (options.execution.testCaseId === replayRepairEvalCaseId || options.execution.testCaseId === graphMemoryEvalCaseId) {
      graphAuditProxy = await startGraphAuditProxy(graphProcess.url);
    }
    const projectId = 1;
    const threadId = 1;
    let harnessFactoryCalls = 0;
    const configuration = options.execution.harnessConfiguration;
    const permissionProfileId = selectStandalonePermissionProfile(configuration);
    const selectedFactory = options.implementations[configuration.implementation];
    if (selectedFactory === undefined) throw new Error(`Unknown eval harness implementation: ${configuration.implementation}`);
    const implementations = {
      ...options.implementations,
      [configuration.implementation]: ((context) => {
        harnessFactoryCalls += 1;
        return selectedFactory(context);
      }) satisfies HarnessFactory,
    };
    const runningHarnessHost = await startHarnessHost({ implementations, stateFile: join(stateDirectory, "harness-sessions.json"), controlToken: harnessControlToken });
    harnessHost = runningHarnessHost;

    const capabilities: GraphCapability[] = [];
    const turns: RuntimeEvalTurn[] = [];
    const sessionStateSnapshots: unknown[] = [];
    const turnStartSequences: number[] = [];
    const prompts = options.execution.testCaseId === replayRepairEvalCaseId
      ? [replayRepairEvalPrompt]
      : options.execution.testCaseId === graphMemoryEvalCaseId
        ? graphMemoryEvalPrompts(options.execution.testRunId)
        : [basicEvalPrompt, basicEvalFollowUpPrompt];
    for (const prompt of prompts) {
      turnStartSequences.push(graphAuditProxy?.events().at(-1)?.sequence ?? 0);
      const interaction = await requestJson<{ node: GraphNode; graphToken: string }>(`${graphProcess.url}/api/control/interactions`, graphControlToken, {
        projectId,
        threadId,
        text: prompt,
        graphCapabilityProfile: configuration.graphCapabilityProfile ?? { search: "disabled" },
      });
      const capability = { url: graphAuditProxy?.url ?? graphProcess.url, token: interaction.graphToken, nodeId: interaction.node.id };
      capabilities.push(capability);
      const complete = await completeWithCapabilityCleanup(async () => {
        await requestJson(`${runningHarnessHost.url}/sessions`, harnessControlToken, { threadId, configuration, permissionProfileId, workingDirectory }, 201);
        return requestJson<{ output: CompletionOutput }>(`${runningHarnessHost.url}/sessions/${threadId}/complete`, harnessControlToken, {
          interactionId: interaction.node.id,
          graph: capability,
        });
      }, capability, graphControlToken);
      sessionStateSnapshots.push(await readPersistedHarnessState(join(stateDirectory, "harness-sessions.json"), threadId));
      const isReplayRepair = options.execution.testCaseId === replayRepairEvalCaseId;
      const isGraphMemory = options.execution.testCaseId === graphMemoryEvalCaseId;
      const repairEvidence = isReplayRepair
        ? await readReplayRepairEvidence(complete.output, interaction.node.id, graphProcess.url, graphControlToken, graphAuditProxy?.events() ?? [])
        : undefined;
      const graphMemoryEvidence = isGraphMemory && turns.length === 1
          ? readGraphMemoryEvidence(
            turns[0]!.output,
            complete.output,
            graphAuditProxy?.events() ?? [],
            turnStartSequences[1] ?? 0,
          )
        : undefined;
      const checks = isReplayRepair
        ? checkReplayRepairOutput(complete.output, repairEvidence, interaction.node.id)
        : isGraphMemory
          ? turns.length === 0
            ? checkGraphMemoryFirstTurn(complete.output, interaction.node.id)
            : checkGraphMemorySecondTurn(
                complete.output,
                turns[0]!.output,
                graphMemoryEvidence,
                interaction.node.id,
                {
                  requireDraftDecoy: configuration.implementation === "fixture.graph-memory",
                  searchRequestMode: graphMemorySearchRequestMode(configuration.implementation),
                },
              )
          : checkBasicOutput(complete.output, interaction.node.id);
      const deterministicPassed = checks.every((check) => check.passed);
      const judge = options.execution.testCaseId === basicEvalCaseId && options.execution.judgeConfiguration.name === "codex-structured" && deterministicPassed
        ? await judgeOutput(complete.output, prompt, workingDirectory, {
            ...(options.judgeCodexPathOverride === undefined ? {} : { codexPathOverride: options.judgeCodexPathOverride }),
            ...(options.judgeThreadFactory === undefined ? {} : { threadFactory: options.judgeThreadFactory }),
          })
        : undefined;
      turns.push({
        interactionNodeId: interaction.node.id,
        prompt,
        output: complete.output,
        checks,
        ...(repairEvidence === undefined ? {} : { repairEvidence }),
        ...(graphMemoryEvidence === undefined ? {} : { graphMemoryEvidence }),
        ...(judge === undefined ? {} : { judge }),
        passed: deterministicPassed && (judge === undefined || judge.verdict === "pass"),
      });
    }
    const revokedCapabilities = await Promise.all(capabilities.map(async (capability) => {
      const response = await fetch(`${capability.url}/api/graph/nodes/${capability.nodeId}`, {
        headers: { authorization: `Bearer ${capability.token}` },
      });
      return response.status === 401;
    }));
    const uniqueInteractionNodes = new Set(capabilities.map((capability) => capability.nodeId));
    const uniqueCapabilityTokens = new Set(capabilities.map((capability) => capability.token));
    const sessionChecks: EvalCheck[] = [
      { name: "single-harness-object", passed: harnessFactoryCalls === 1, detail: `Harness factory called ${harnessFactoryCalls} time${harnessFactoryCalls === 1 ? "" : "s"} for ${prompts.length} interaction${prompts.length === 1 ? "" : "s"}.` },
      { name: "distinct-interaction-capabilities", passed: capabilities.length === prompts.length && uniqueInteractionNodes.size === prompts.length && uniqueCapabilityTokens.size === prompts.length, detail: "Each interaction used a distinct node and opaque capability token." },
      { name: "revoked-interaction-capabilities", passed: revokedCapabilities.every(Boolean), detail: "The eval runtime revoked every graph capability after its Complete call settled." },
      ...(options.execution.testCaseId === graphMemoryEvalCaseId
        ? [checkProviderSessionContinuity(sessionStateSnapshots, options.execution.harnessConfiguration.implementation)]
        : []),
    ];
    const deterministicPassed = sessionChecks.every((check) => check.passed) && turns.every((turn) => turn.checks.every((check) => check.passed));
    const passed = deterministicPassed && turns.every((turn) => turn.passed);
    const artifact: RuntimeEvalArtifact = {
      schemaVersion: 3,
      execution: structuredClone(options.execution),
      createdAt: new Date().toISOString(),
      turns,
      sessionChecks,
      deterministicPassed,
      passed,
    };
    const runDirectory = executionDirectory(options.outputDirectory, options.execution);
    await mkdir(runDirectory, { recursive: true });
    await writeFile(join(runDirectory, "result.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    await writeFile(join(runDirectory, "index.html"), renderArtifact(artifact), "utf8");
    return artifact;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    let workingDirectoryCanBeRemoved = harnessHost === undefined;
    let deferredHarnessClose: Promise<void> | undefined;
    let graphProcessStopped = graphProcess === undefined;
    for (const cleanup of [
      async () => {
        if (harnessHost !== undefined) {
          await closeHarnessHostForEval(
            harnessHost,
            options.harnessCloseGraceMs ?? DEFAULT_EVAL_HARNESS_CLOSE_GRACE_MS,
            () => { workingDirectoryCanBeRemoved = true; },
            (closing) => { deferredHarnessClose = closing; },
          );
        }
      },
      async () => graphAuditProxy?.close(),
      async () => {
        if (graphProcess !== undefined) await terminate(graphProcess.process);
        graphProcessStopped = true;
      },
      async () => {
        if (workingDirectoryCanBeRemoved && graphProcessStopped) {
          await rm(workingDirectory, { recursive: true, force: true });
        } else if (graphProcessStopped && deferredHarnessClose !== undefined) {
          void deferredHarnessClose
            .then(() => rm(workingDirectory, { recursive: true, force: true }))
            .catch(() => undefined);
        }
      },
    ]) {
      const result = await settle(cleanup);
      if (!result.ok) cleanupErrors.push(result.error);
    }
    if (cleanupErrors.length > 0) {
      if (operationError !== undefined) {
        throw new AggregateError([operationError, ...cleanupErrors], "Runtime Eval failed and cleanup also failed");
      }
      if (cleanupErrors.length === 1) throw cleanupErrors[0];
      throw new AggregateError(cleanupErrors, "Runtime Eval cleanup failed");
    }
  }
}

async function closeHarnessHostForEval(
  host: RunningHarnessHost,
  closeGraceMs: number,
  markDisconnected: () => void,
  deferUntilClosingSettles: (closing: Promise<void>) => void,
): Promise<void> {
  const closing = settle(() => host.close());
  if (!(await settlesWithin(closing.then(() => {}), closeGraceMs))) {
    const forced = await settle(() => host.forceClose());
    if (!forced.ok) {
      deferUntilClosingSettles(closing.then(() => {}));
      throw forced.error;
    }
    markDisconnected();
    const error = new Error(`Harness host did not close within ${closeGraceMs}ms and was forcibly disconnected`);
    (error as Error & { code: string }).code = "RELAYER_EVAL_HARNESS_CLOSE_TIMEOUT";
    throw error;
  }
  const result = await closing;
  markDisconnected();
  if (!result.ok) throw result.error;
}

export function checkBasicOutput(
  output: CompletionOutput,
  expectedInteractionNodeId = output.nodeId,
  options: { allowLegacyLayout?: boolean } = {},
): EvalCheck[] {
  const layer = output.rootLayer;
  const declaredNodeIds = layer.layer.nodes;
  const resolvedNodeIds = layer.nodes.map((node) => node.id);
  const declaredEdgeIds = layer.layer.edges;
  const resolvedEdgeIds = layer.edges.map((edge) => edge.id);
  const nodeIds = new Set(layer.nodes.map((node) => node.id));
  const layout = layer.layer.layout;
  const placements = layout?.placements ?? [];
  const placementIds = new Set(placements.map((placement) => placement.nodeId));
  const layoutComplete = layout?.version === 1
    && placements.length === nodeIds.size
    && placementIds.size === nodeIds.size
    && [...nodeIds].every((id) => placementIds.has(id))
    && placements.every(({ x, y }) => (
      Number.isFinite(x) && x >= 0 && x <= 1
      && Number.isFinite(y) && y >= 0 && y <= 1
    ));
  const adjacency = new Map(layer.nodes.map((node) => [node.id, new Set<number>()]));
  for (const edge of layer.edges) { adjacency.get(edge.endpoints[0])?.add(edge.endpoints[1]); adjacency.get(edge.endpoints[1])?.add(edge.endpoints[0]); }
  const visited = new Set<number>(); const pending = layer.nodes[0] === undefined ? [] : [layer.nodes[0].id];
  while (pending.length) { const id = pending.pop()!; if (visited.has(id)) continue; visited.add(id); pending.push(...(adjacency.get(id) ?? [])); }
  return [
    { name: "interaction-output", passed: output.nodeId === expectedInteractionNodeId && output.rootAction.sourceNodeId === expectedInteractionNodeId, detail: "Completion output and response action belong to the requested interaction." },
    { name: "accepted-closure", passed: output.rootAction.state === "accepted" && layer.layer.state === "accepted" && layer.nodes.every((node) => node.state === "accepted") && layer.edges.every((edge) => edge.state === "accepted") && layer.actions.every((action) => action.state === "accepted"), detail: "The response action and complete visible closure are accepted." },
    { name: "resolved-membership", passed: arraysEqual(declaredNodeIds, resolvedNodeIds) && arraysEqual(declaredEdgeIds, resolvedEdgeIds), detail: "Resolved records exactly match the accepted layer references." },
    {
      name: "authored-layout",
      passed: layoutComplete || (options.allowLegacyLayout === true && layout == null),
      detail: layout == null && options.allowLegacyLayout === true
        ? "The accepted legacy layer has no authored layout and remains compatible."
        : "The accepted layer has one finite normalized v1 placement per visible node.",
    },
    { name: "response-action", passed: output.rootAction.kind === "navigate" && output.rootAction.relation === "expand" && output.rootAction.sourceLayerId == null && output.rootAction.targetLayerId === layer.layer.id, detail: "Interaction has one accepted root expansion action." },
    { name: "visible-layer", passed: layer.nodes.length >= 1 && layer.nodes.length <= 8 && layer.nodes.every((node) => node.icon.trim() && node.title.trim() && node.detail.trim()), detail: `${layer.nodes.length} complete visible nodes.` },
    { name: "exact-edges", passed: layer.edges.every((edge) => edge.endpoints[0] !== edge.endpoints[1] && nodeIds.has(edge.endpoints[0]) && nodeIds.has(edge.endpoints[1])), detail: `${layer.edges.length} visible undirected edges stay inside the layer.` },
    { name: "connected", passed: visited.size === layer.nodes.length, detail: `${visited.size}/${layer.nodes.length} nodes connected.` },
  ];
}

export function checkGraphMemoryFirstTurn(
  output: CompletionOutput,
  expectedInteractionNodeId = output.nodeId,
): EvalCheck[] {
  const matching = output.rootLayer.nodes.filter((node) => node.title === graphMemorySearchTitle);
  const graphHasNoMachineMarker = output.rootLayer.nodes.every((node) => (
    !node.title.includes("GRAPH_MEMORY_ANCHOR:")
    && !node.detail.includes("GRAPH_MEMORY_ANCHOR:")
  ));
  return [
    ...checkBasicOutput(output, expectedInteractionNodeId),
    {
      name: "natural-memory-search-target",
      passed: matching.length === 1 && graphHasNoMachineMarker,
      detail: `The first accepted root contains one human-readable ${graphMemorySearchTitle} search target and no machine marker in visible content.`,
    },
  ];
}

export function readGraphMemoryEvidence(
  firstOutput: CompletionOutput,
  secondOutput: CompletionOutput,
  auditEvents: readonly ReplayRepairAuditEvent[],
  secondTurnStartSequence: number,
): GraphMemoryEvidence {
  const firstSubmit = auditEvents.find((event) => (
    event.method === "POST"
    && event.path === "/api/graph/submit"
    && event.status >= 200
    && event.status < 300
    && event.completionNodeId === firstOutput.nodeId
  ));
  const search = auditEvents.find((event) => (
    event.method === "POST" && event.path === "/api/graph/search" && event.status >= 200 && event.status < 300
    && event.sequence > secondTurnStartSequence
  ));
  const searchedLayerIds = search?.searchLayerIds ?? [];
  const reference = auditEvents.find((event) => (
    event.method === "POST"
    && event.path === "/api/graph/actions"
    && event.status >= 200
    && event.status < 300
    && event.actionKind === "navigate"
    && event.actionRelation === "reference"
    && event.actionTargetLayerId === firstOutput.rootLayer.layer.id
    && event.actionSourceLayerId === secondOutput.rootLayer.layer.id
  ));
  const draftDecoy = search === undefined ? undefined : auditEvents.filter((event) => (
    event.method === "POST"
    && event.path === "/api/graph/layers"
    && event.status >= 200
    && event.status < 300
    && event.recordKind === "layer"
    && event.recordState === "draft"
    && event.recordId !== firstOutput.rootLayer.layer.id
    && (firstSubmit === undefined || event.sequence > firstSubmit.sequence)
    && event.sequence < search.sequence
  )).at(-1);
  return {
    secondTurnStartSequence,
    searchedLayerIds,
    ...(search === undefined ? {} : { searchSequence: search.sequence }),
    ...(search === undefined ? {} : {
      searchRequest: {
        queryContractVersion: search.queryContractVersion,
        ...(search.target === undefined ? {} : { target: structuredClone(search.target) }),
        query: search.query,
        parameters: structuredClone(search.parameters),
        budget: structuredClone(search.budget),
      },
    }),
    ...(draftDecoy?.recordId === undefined ? {} : { draftDecoyLayerId: draftDecoy.recordId }),
    ...(reference?.recordId === undefined ? {} : { referenceActionId: reference.recordId }),
    ...(reference === undefined ? {} : { referenceActionSequence: reference.sequence }),
    auditEvents: structuredClone(auditEvents),
  };
}

export function checkGraphMemorySecondTurn(
  output: CompletionOutput,
  firstOutput: CompletionOutput,
  evidence: GraphMemoryEvidence | undefined,
  expectedInteractionNodeId = output.nodeId,
  options: {
    readonly requireDraftDecoy?: boolean;
    readonly searchRequestMode?: "exact" | "natural";
  } = {},
): EvalCheck[] {
  const requireDraftDecoy = options.requireDraftDecoy === true;
  const searchRequestMode = options.searchRequestMode ?? "exact";
  const base = checkBasicOutput(output, expectedInteractionNodeId);
  if (evidence === undefined) {
    return [
      ...base,
      { name: "search-returned-prior-root", passed: false, detail: "No authoritative graph-search audit evidence was captured." },
      ...(requireDraftDecoy
        ? [{ name: "draft-decoy-hidden", passed: false, detail: "No same-topic draft-isolation evidence was captured." }]
        : []),
      { name: "typed-reference-target", passed: false, detail: "No searched prior-layer identity was available for the accepted reference." },
      { name: "ack-search-submit-order", passed: false, detail: "No audited acknowledgement/search/submission ordering was available." },
    ];
  }
  const priorLayerId = firstOutput.rootLayer.layer.id;
  const acceptedReference = output.rootLayer.actions.find((action) => (
    action.id === evidence.referenceActionId
    && action.state === "accepted"
    && action.kind === "navigate"
    && action.relation === "reference"
    && action.sourceLayerId === output.rootLayer.layer.id
    && action.targetLayerId === priorLayerId
    && output.rootLayer.nodes.some((node) => node.id === action.sourceNodeId)
  ));
  const firstSubmit = evidence.auditEvents.find((event) => (
    event.method === "POST"
    && event.path === "/api/graph/submit"
    && event.status >= 200
    && event.status < 300
    && event.completionNodeId === firstOutput.nodeId
    && event.completionRootLayerId === priorLayerId
  ));
  const successfulSearches = evidence.auditEvents.filter((event) => (
    event.method === "POST"
    && event.path === "/api/graph/search"
    && event.status >= 200
    && event.status < 300
    && event.sequence > evidence.secondTurnStartSequence
  ));
  const secondSubmit = evidence.auditEvents.find((event) => (
    event.method === "POST"
    && event.path === "/api/graph/submit"
    && event.status >= 200
    && event.status < 300
    && event.completionNodeId === output.nodeId
    && event.completionRootLayerId === output.rootLayer.layer.id
  ));
  const search = successfulSearches[0];
  const draftDecoyDiscard = evidence.draftDecoyLayerId === undefined ? undefined : evidence.auditEvents.find((event) => (
    event.method === "POST"
    && event.path === `/api/graph/layers/${evidence.draftDecoyLayerId}/discard`
    && event.status >= 200
    && event.status < 300
    && event.recordKind === "layer"
    && event.recordId === evidence.draftDecoyLayerId
    && event.recordState === "stopped"
  ));
  const ordered = firstSubmit !== undefined
    && search !== undefined
    && evidence.searchSequence === search.sequence
    && evidence.referenceActionSequence !== undefined
    && secondSubmit !== undefined
    && firstSubmit.sequence < search.sequence
    && search.sequence < evidence.referenceActionSequence
    && evidence.referenceActionSequence < secondSubmit.sequence;
  return [
    ...base,
    {
      name: "search-returned-prior-root",
      passed: successfulSearches.length === 1
        && evidence.searchedLayerIds.length === 1
        && evidence.searchedLayerIds[0] === priorLayerId
        && successfulSearches[0]?.resultTruncated === false,
      detail: "The one audited graph.search call returned exactly the first accepted root Layer identity.",
    },
    {
      name: "search-request-contract",
      passed: successfulSearches.length === 1
        && (searchRequestMode === "exact"
          ? matchesRequiredGraphMemorySearch(evidence.searchRequest)
          : matchesNaturalGraphMemorySearch(evidence.searchRequest)),
      detail: searchRequestMode === "exact"
        ? "The deterministic fixture used the exact admitted conformance query, natural topic parameter, and bounded budget."
        : "The provider formulated one bounded parameterized query for the natural topic without a machine marker.",
    },
    ...(requireDraftDecoy ? [{
      name: "draft-decoy-hidden",
      passed: evidence.draftDecoyLayerId !== undefined
        && draftDecoyDiscard !== undefined
        && search !== undefined
        && search.resultTruncated === false
        && search.sequence < draftDecoyDiscard.sequence,
      detail: "A same-topic draft layer existed during search, was absent from its exact result, and was stopped only afterward.",
    }] : []),
    {
      name: "typed-reference-target",
      passed: acceptedReference !== undefined,
      detail: "The second accepted root contains the audited typed reference action targeting that exact searched Layer.",
    },
    {
      name: "ack-search-submit-order",
      passed: ordered,
      detail: "Server response order proves first submit acknowledgement before second-turn search, the matching reference action, and second submit acknowledgement.",
    },
  ];
}

function matchesRequiredGraphMemorySearch(
  request: GraphMemoryEvidence["searchRequest"],
): boolean {
  if (request?.queryContractVersion !== 1 || request.query !== graphMemorySearchQuery
    || request.target !== undefined
    || !isRecord(request.parameters) || !isRecord(request.budget)) return false;
  const parameterKeys = Object.keys(request.parameters);
  const topicParameter = request.parameters.topic;
  return parameterKeys.length === 1
    && parameterKeys[0] === "topic"
    && isRecord(topicParameter)
    && Object.keys(topicParameter).length === 2
    && topicParameter.type === "string"
    && topicParameter.value === graphMemorySearchTitle
    && Object.keys(request.budget).length === 1
    && request.budget.resultRows === graphMemorySearchBudget.resultRows;
}

function matchesNaturalGraphMemorySearch(
  request: GraphMemoryEvidence["searchRequest"],
): boolean {
  if (request?.queryContractVersion !== 1 || typeof request.query !== "string"
    || request.target !== undefined
    || !isRecord(request.parameters)
    || (request.budget !== undefined && !isRecord(request.budget))) return false;
  const parameterKeys = Object.keys(request.parameters);
  if (parameterKeys.length !== 1
    || (request.budget !== undefined && !matchesNaturalGraphMemoryBudget(request.budget))) return false;
  const parameterName = parameterKeys[0]!;
  const parameter = request.parameters[parameterName];
  return isRecord(parameter)
    && Object.keys(parameter).length === 2
    && parameter.type === "string"
    && parameter.value === graphMemorySearchTitle
    && isNaturalGraphMemoryQueryShape(request.query, parameterName)
    && !JSON.stringify({ query: request.query, parameters: request.parameters }).includes("GRAPH_MEMORY_ANCHOR:");
}

function matchesNaturalGraphMemoryBudget(budget: Readonly<Record<string, unknown>>): boolean {
  const resultRows = budget.resultRows;
  return resultRows === undefined
    || (Number.isSafeInteger(resultRows) && (resultRows as number) >= 1 && (resultRows as number) <= 8);
}

function isNaturalGraphMemoryQueryShape(query: string, parameterName: string): boolean {
  const identifier = "[A-Za-z_][A-Za-z0-9_]*";
  const layer = `(?<layer>${identifier})`;
  const content = `(?<content>${identifier})`;
  const relationship = `\\[\\s*(?:${identifier}\\s*)?:\\s*CONTAINS(?:\\s*\\{[^}]*\\})?\\s*\\]`;
  const contains = `\\s*-\\s*${relationship}\\s*->\\s*`;
  const containedBy = `\\s*<-\\s*${relationship}\\s*-\\s*`;
  const layerNode = `\\(\\s*${layer}\\s*:\\s*Layer\\s*\\)`;
  const contentNode = `\\(\\s*${content}\\s*:\\s*Content\\s*\\)`;
  const escapedParameter = parameterName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const titleProperty = "\\k<content>\\s*\\.\\s*title";
  const parameter = `\\$${escapedParameter}`;
  const predicate = `\\s+WHERE\\s+(?:${titleProperty}\\s*=\\s*${parameter}|${parameter}\\s*=\\s*${titleProperty})`;
  const projection = `\\s+RETURN\\s+(?:DISTINCT\\s+)?\\k<layer>(?:\\s+AS\\s+${identifier})?`;
  const orderingExpression = `${identifier}(?:\\s*\\.\\s*${identifier})?`;
  const ordering = `(?:\\s+ORDER\\s+BY\\s+${orderingExpression}(?:\\s+(?:ASC|DESC))?)?`;
  const limit = "(?:\\s+LIMIT\\s+[1-8])?\\s*;?\\s*$";
  const pathBinding = `(?:${identifier}\\s*=\\s*)?`;
  const forward = new RegExp(`^\\s*MATCH\\s+${pathBinding}${layerNode}${contains}${contentNode}${predicate}${projection}${ordering}${limit}`, "i");
  const reverse = new RegExp(`^\\s*MATCH\\s+${pathBinding}${contentNode}${containedBy}${layerNode}${predicate}${projection}${ordering}${limit}`, "i");
  return forward.test(query) || reverse.test(query);
}

export function parseReportedReplayRepairEvidence(output: CompletionOutput): ReportedReplayRepairEvidence | undefined {
  const prefix = "GRAPH_REPAIR_EVIDENCE=";
  const evidenceLines = output.rootLayer.nodes
    .flatMap((node) => node.detail.split(/\r?\n/))
    .filter((line) => line.startsWith(prefix));
  if (evidenceLines.length !== 1) return undefined;
  try {
    const value: unknown = JSON.parse(evidenceLines[0]!.slice(prefix.length));
    if (!isRecord(value) || !Array.isArray(value.passes) || value.passes.length !== 2 || value.orphanSubmitErrorCode !== "orphan_draft_layers" || !Array.isArray(value.discardedLayerIds) || value.discardedLayerIds.length !== 2) return undefined;
    const passes = value.passes.map(readReplayRepairPass);
    if (passes.some((pass) => pass === undefined) || !value.discardedLayerIds.every(isPositiveInteger)) return undefined;
    return {
      passes: passes as [ReplayRepairPass, ReplayRepairPass],
      orphanSubmitErrorCode: "orphan_draft_layers",
      discardedLayerIds: value.discardedLayerIds as [number, number],
    };
  } catch {
    return undefined;
  }
}

export function checkReplayRepairOutput(
  output: CompletionOutput,
  evidence: ReplayRepairEvidence | undefined,
  expectedInteractionNodeId = output.nodeId,
): EvalCheck[] {
  const base = checkBasicOutput(output, expectedInteractionNodeId);
  const text = output.rootLayer.nodes.map((node) => `${node.title}\n${node.detail}`).join("\n");
  if (evidence === undefined) {
    return [
      ...base,
      { name: "accepted-useful-output", passed: false, detail: "Accepted output must explain stable-key replay and include one machine-readable evidence line." },
      { name: "stable-object-replay", passed: false, detail: "No valid two-pass replay evidence was found." },
      { name: "single-root-action", passed: false, detail: "No replayed root-action identity was available." },
      { name: "orphan-validation-observed", passed: false, detail: "No required orphan_draft_layers validation evidence was found." },
      { name: "explicit-stopped-orphan", passed: false, detail: "No discarded-layer identity was available for authoritative graph lookup." },
      { name: "idempotent-discard", passed: false, detail: "No repeated discard result was available." },
    ];
  }
  const [first, second] = evidence.reported.passes;
  const replayKeys = Object.keys(first) as (keyof ReplayRepairPass)[];
  const stableReplay = replayKeys.every((key) => first[key] === second[key]);
  const expectedWrites: readonly [keyof ReplayRepairPass, ReplayRepairAuditEvent["recordKind"]][] = [
    ["primaryNodeId", "node"],
    ["secondaryNodeId", "node"],
    ["edgeId", "edge"],
    ["rootLayerId", "layer"],
    ["rootActionId", "action"],
    ["orphanNodeId", "node"],
    ["orphanLayerId", "layer"],
  ];
  const authoritativeReplay = expectedWrites.every(([key, kind]) => evidence.auditEvents.filter((event) => (
    event.status >= 200
    && event.status < 300
    && event.recordKind === kind
    && event.recordId === second[key]
  )).length >= 2);
  const rootMatchesAccepted = second.rootLayerId === output.rootLayer.layer.id
    && second.rootActionId === output.rootAction.id
    && output.rootLayer.layer.nodes.includes(second.primaryNodeId)
    && output.rootLayer.layer.nodes.includes(second.secondaryNodeId)
    && output.rootLayer.layer.edges.includes(second.edgeId);
  const discardedIdsMatch = evidence.reported.discardedLayerIds[0] === second.orphanLayerId
    && evidence.reported.discardedLayerIds[1] === second.orphanLayerId;
  const failedOrphanSubmit = evidence.auditEvents.find((event) => (
    event.method === "POST"
    && event.path === "/api/graph/submit"
    && event.status >= 400
    && event.errorCodes?.includes("orphan_draft_layers")
  ));
  const authoritativeDiscards = failedOrphanSubmit === undefined ? [] : evidence.auditEvents.filter((event) => (
    event.sequence > failedOrphanSubmit.sequence
    && event.method === "POST"
    && event.path === `/api/graph/layers/${second.orphanLayerId}/discard`
    && event.status >= 200
    && event.status < 300
    && event.recordKind === "layer"
    && event.recordId === second.orphanLayerId
    && event.recordState === "stopped"
  ));
  const successfulFinalSubmit = authoritativeDiscards.length < 2 ? undefined : evidence.auditEvents.find((event) => (
    event.sequence > authoritativeDiscards[1]!.sequence
    && event.method === "POST"
    && event.path === "/api/graph/submit"
    && event.status >= 200
    && event.status < 300
  ));
  const stoppedLayerMatches = evidence.stoppedLayer.layer.id === second.orphanLayerId
    && evidence.stoppedLayer.layer.state === "stopped"
    && evidence.stoppedLayerOwnerNodeId === expectedInteractionNodeId;
  const orphanNodePreserved = evidence.stoppedLayer.layer.nodes.includes(second.orphanNodeId)
    && evidence.stoppedLayer.nodes.some((node) => node.id === second.orphanNodeId && node.state === "draft");
  const useful = /stable.{0,30}(client|idempotency).{0,30}key/i.test(text)
    && /(retry|rerun|replay)/i.test(text)
    && /(partial|persist|draft)/i.test(text);
  return [
    ...base,
    { name: "accepted-useful-output", passed: useful, detail: "Accepted connected output explains stable keys and retry after partial persistence." },
    { name: "stable-object-replay", passed: stableReplay && authoritativeReplay && rootMatchesAccepted, detail: "The audit observed at least two successful writes for every reported stable node, edge, layer, orphan, and action ID, with accepted root membership matching those IDs." },
    { name: "single-root-action", passed: first.rootActionId === second.rootActionId && second.rootActionId === output.rootAction.id && authoritativeReplay && successfulFinalSubmit !== undefined, detail: "Audited root-action replay retained one identity and a later submission accepted that exact root action." },
    { name: "orphan-validation-observed", passed: failedOrphanSubmit !== undefined, detail: "The audit observed graph.submit fail with orphan_draft_layers before discard." },
    { name: "explicit-stopped-orphan", passed: stoppedLayerMatches && orphanNodePreserved, detail: "Control-authoritative graph reads show the reported orphan layer stopped under this interaction while its node remains draft." },
    { name: "idempotent-discard", passed: discardedIdsMatch && authoritativeDiscards.length >= 2 && successfulFinalSubmit !== undefined, detail: "The audit observed two successful post-validation discard calls return the same stopped orphan before final submission." },
  ];
}

async function readReplayRepairEvidence(
  output: CompletionOutput,
  interactionNodeId: number,
  graphUrl: string,
  graphControlToken: string,
  auditEvents: readonly ReplayRepairAuditEvent[],
): Promise<ReplayRepairEvidence | undefined> {
  const reported = parseReportedReplayRepairEvidence(output);
  if (reported === undefined) return undefined;
  const discardedLayerId = reported.discardedLayerIds[1];
  try {
    const stoppedLayer = await requestControlJson<ResolvedLayer>(
      `${graphUrl}/api/control/interactions/${interactionNodeId}/layers/${discardedLayerId}`,
      graphControlToken,
    );
    const owner = await requestControlJson<{ ownerInteractionNodeId: number }>(
      `${graphUrl}/api/control/interactions/${interactionNodeId}/layers/${discardedLayerId}/owner`,
      graphControlToken,
    );
    return { reported, stoppedLayer, stoppedLayerOwnerNodeId: owner.ownerInteractionNodeId, auditEvents };
  } catch {
    return undefined;
  }
}

function readReplayRepairPass(value: unknown): ReplayRepairPass | undefined {
  if (!isRecord(value)) return undefined;
  const keys = ["primaryNodeId", "secondaryNodeId", "edgeId", "rootLayerId", "rootActionId", "orphanNodeId", "orphanLayerId"] as const;
  if (Object.keys(value).length !== keys.length || !keys.every((key) => isPositiveInteger(value[key]))) return undefined;
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as unknown as ReplayRepairPass;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export async function startGraphAuditProxy(upstreamUrl: string, closeGraceMs = 250): Promise<{
  readonly url: string;
  readonly events: () => readonly ReplayRepairAuditEvent[];
  readonly close: () => Promise<void>;
}> {
  const upstream = new URL(upstreamUrl);
  const auditEvents: ReplayRepairAuditEvent[] = [];
  const sockets = new Set<Socket>();
  const requests = new Set<AbortController>();
  let sequence = 0;
  const server = createServer((request, response) => {
    const controller = new AbortController();
    requests.add(controller);
    void forwardAuditedGraphRequest(request, response, upstream, controller.signal, (event) => {
      if (event.path.startsWith("/api/graph/")) auditEvents.push({ ...event, sequence: ++sequence });
    }).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const invalidTarget = error instanceof InvalidAuditProxyTargetError;
      response.writeHead(invalidTarget ? 400 : 502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: invalidTarget ? "invalid_proxy_target" : "audit_proxy_failed", message: error instanceof Error ? error.message : String(error) } }));
    }).finally(() => requests.delete(controller));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    events: () => structuredClone(auditEvents),
    close: () => closeGraphAuditProxy(server, sockets, requests, closeGraceMs),
  };
}

class InvalidAuditProxyTargetError extends Error {}

async function closeGraphAuditProxy(
  server: ReturnType<typeof createServer>,
  sockets: Set<Socket>,
  requests: Set<AbortController>,
  closeGraceMs: number,
): Promise<void> {
  let closeError: Error | undefined;
  let closed = false;
  const closeResult = new Promise<void>((resolveClose) => {
    server.close((error) => {
      closeError = error;
      closed = true;
      resolveClose();
    });
  });
  server.closeIdleConnections();
  if (!(await settlesWithin(closeResult, closeGraceMs))) {
    for (const request of requests) request.abort();
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await settlesWithin(closeResult, closeGraceMs);
  }
  if (!closed) throw new Error(`Graph audit proxy did not close within ${closeGraceMs * 2}ms`);
  if (closeError !== undefined) throw closeError;
}

function settlesWithin(operation: Promise<void>, milliseconds: number): Promise<boolean> {
  return new Promise<boolean>((resolveSettled) => {
    const timer = setTimeout(() => resolveSettled(false), milliseconds);
    void operation.then(() => {
      clearTimeout(timer);
      resolveSettled(true);
    });
  });
}

async function forwardAuditedGraphRequest(
  request: IncomingMessage,
  response: ServerResponse,
  upstream: URL,
  signal: AbortSignal,
  record: (event: Omit<ReplayRepairAuditEvent, "sequence">) => void,
): Promise<void> {
  const method = request.method ?? "GET";
  const target = request.url ?? "/";
  if (!target.startsWith("/") || target.startsWith("//")) {
    throw new InvalidAuditProxyTargetError("Graph audit proxy accepts only origin-relative request targets.");
  }
  const requestUrl = new URL(target, upstream);
  if (requestUrl.origin !== upstream.origin) {
    throw new InvalidAuditProxyTargetError("Graph audit proxy request target escaped the configured upstream origin.");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const requestBody = Buffer.concat(chunks);
  const requestValue = parseJsonObject(requestBody);
  const headers = new Headers();
  for (const name of ["accept", "authorization", "content-type"] as const) {
    const value = request.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }
  const upstreamResponse = await fetch(requestUrl, {
    method,
    headers,
    signal,
    ...(requestBody.byteLength === 0 || method === "GET" || method === "HEAD" ? {} : { body: requestBody }),
  });
  const responseBytes = Buffer.from(await upstreamResponse.arrayBuffer());
  const contentType = upstreamResponse.headers.get("content-type");
  response.writeHead(upstreamResponse.status, contentType === null ? {} : { "content-type": contentType });
  response.end(responseBytes);
  const responseValue = parseJsonObject(responseBytes);
  record(sanitizeGraphAuditEvent(
    method,
    requestUrl.pathname,
    upstreamResponse.status,
    requestValue,
    responseValue,
  ));
}

function sanitizeGraphAuditEvent(
  method: string,
  path: string,
  status: number,
  request: Record<string, unknown> | undefined,
  response: Record<string, unknown> | undefined,
): Omit<ReplayRepairAuditEvent, "sequence"> {
  const event: Omit<ReplayRepairAuditEvent, "sequence"> = { method, path, status };
  if (method === "POST" && path === "/api/graph/nodes") return withRecord(event, "node", response?.node);
  if (method === "POST" && path === "/api/graph/edges") return withRecord(event, "edge", response?.edge);
  if (method === "POST" && path === "/api/graph/layers") return withRecord(event, "layer", response?.layer);
  if (method === "POST" && path === "/api/graph/actions") return withAction(event, response?.action);
  if (method === "POST" && /^\/api\/graph\/layers\/\d+\/discard$/.test(path)) return withRecord(event, "layer", response?.layer);
  if (method === "POST" && path === "/api/graph/search" && status >= 200 && status < 300) {
    return withSearchResult(withSearchRequest(event, request), response);
  }
  if (method === "POST" && path === "/api/graph/submit" && status >= 200 && status < 300) return withCompletion(event, response);
  const error = isRecord(response?.error) ? response.error : undefined;
  const issues = Array.isArray(error?.issues) ? error.issues : [];
  const errorCodes = [error?.code, ...issues.map((issue) => isRecord(issue) ? issue.code : undefined)]
    .filter((code): code is string => typeof code === "string");
  const withRequest = method === "POST" && path === "/api/graph/search"
    ? withSearchRequest(event, request)
    : event;
  return errorCodes.length === 0 ? withRequest : { ...withRequest, errorCodes: [...new Set(errorCodes)] };
}

function withSearchRequest(
  event: Omit<ReplayRepairAuditEvent, "sequence">,
  request: Record<string, unknown> | undefined,
): Omit<ReplayRepairAuditEvent, "sequence"> {
  if (!isRecord(request)) return event;
  return {
    ...event,
    ...(Number.isSafeInteger(request.queryContractVersion)
      ? { queryContractVersion: request.queryContractVersion as number }
      : {}),
    ...(isRecord(request.target) ? { target: structuredClone(request.target) } : {}),
    ...(typeof request.query === "string" ? { query: request.query } : {}),
    ...(isRecord(request.parameters) ? { parameters: structuredClone(request.parameters) } : {}),
    ...(isRecord(request.budget) ? { budget: structuredClone(request.budget) } : {}),
  };
}

function withAction(
  event: Omit<ReplayRepairAuditEvent, "sequence">,
  value: unknown,
): Omit<ReplayRepairAuditEvent, "sequence"> {
  const recorded = withRecord(event, "action", value);
  if (!isRecord(value)) return recorded;
  return {
    ...recorded,
    ...(typeof value.kind === "string" ? { actionKind: value.kind } : {}),
    ...(typeof value.relation === "string" || value.relation === null ? { actionRelation: value.relation } : {}),
    ...(isPositiveInteger(value.sourceNodeId) ? { actionSourceNodeId: value.sourceNodeId } : {}),
    ...(isPositiveInteger(value.sourceLayerId) || value.sourceLayerId === null ? { actionSourceLayerId: value.sourceLayerId } : {}),
    ...(isPositiveInteger(value.targetLayerId) || value.targetLayerId === null ? { actionTargetLayerId: value.targetLayerId } : {}),
  };
}

function withSearchResult(
  event: Omit<ReplayRepairAuditEvent, "sequence">,
  response: Record<string, unknown> | undefined,
): Omit<ReplayRepairAuditEvent, "sequence"> {
  if (!Array.isArray(response?.rows)) return event;
  const layerIds = response.rows.flatMap((row) => Array.isArray(row) ? row.flatMap((value) => {
    if (!isRecord(value) || value.type !== "layer" || typeof value.id !== "string") return [];
    const match = /^layer:([1-9]\d*)$/.exec(value.id);
    const id = match === null ? Number.NaN : Number(match[1]);
    return Number.isSafeInteger(id) ? [id] : [];
  }) : []);
  return {
    ...event,
    searchLayerIds: layerIds,
    ...(typeof response.truncated === "boolean" ? { resultTruncated: response.truncated } : {}),
  };
}

function withCompletion(
  event: Omit<ReplayRepairAuditEvent, "sequence">,
  response: Record<string, unknown> | undefined,
): Omit<ReplayRepairAuditEvent, "sequence"> {
  const rootLayer = isRecord(response?.rootLayer) && isRecord(response.rootLayer.layer)
    ? response.rootLayer.layer
    : undefined;
  return {
    ...event,
    ...(isPositiveInteger(response?.nodeId) ? { completionNodeId: response.nodeId } : {}),
    ...(isPositiveInteger(rootLayer?.id) ? { completionRootLayerId: rootLayer.id } : {}),
  };
}

function withRecord(
  event: Omit<ReplayRepairAuditEvent, "sequence">,
  recordKind: NonNullable<ReplayRepairAuditEvent["recordKind"]>,
  value: unknown,
): Omit<ReplayRepairAuditEvent, "sequence"> {
  if (!isRecord(value) || !isPositiveInteger(value.id)) return event;
  return {
    ...event,
    recordKind,
    recordId: value.id,
    ...(typeof value.state === "string" ? { recordState: value.state } : {}),
  };
}

function parseJsonObject(bytes: Buffer): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function checkNodeNavigation(output: CompletionOutput): EvalCheck[] {
  const visibleNodeIds = new Set(output.rootLayer.nodes.map((node) => node.id));
  const navigation = output.rootLayer.actions.find((action) => (
    action.kind === "navigate"
    && action.state === "accepted"
    && action.relation === "expand"
    && action.sourceLayerId === output.rootLayer.layer.id
    && Number.isInteger(action.targetLayerId)
    && visibleNodeIds.has(action.sourceNodeId)
  ));
  return [{
    name: "node-navigation",
    passed: navigation !== undefined,
    detail: navigation
      ? "A visible output node opens an accepted child layer."
      : "No visible output node opens a child layer.",
  }];
}

export function checkBasicFacts(output: CompletionOutput): EvalCheck[] {
  const text = output.rootLayer.nodes.map((node) => `${node.title}\n${node.detail}`).join("\n");
  return basicEvalFacts.map((fact) => ({
    name: `fact:${fact.id}`,
    passed: fact.patterns.some((pattern) => pattern.test(text)),
    detail: fact.description,
  }));
}

function arraysEqual(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

const judgeSchema = { type: "object", properties: { factIds: { type: "array", items: { type: "string" } }, graphUseful: { type: "boolean" }, detailsUseful: { type: "boolean" }, problems: { type: "array", items: { type: "string" } }, verdict: { type: "string", enum: ["pass", "fail"] } }, required: ["factIds", "graphUseful", "detailsUseful", "problems", "verdict"], additionalProperties: false } as const;
async function judgeOutput(
  output: CompletionOutput,
  promptText: string,
  workingDirectory: string,
  dependencies: {
    readonly codexPathOverride?: string;
    readonly threadFactory?: BasicJudgeThreadFactory;
  },
): Promise<BasicJudge> {
  const codexPathOverride = dependencies.codexPathOverride?.trim();
  if (!codexPathOverride) throw new Error("codex-structured judge requires an explicit managed Codex executable");
  const codexOptions = { codexPathOverride } satisfies CodexOptions;
  const threadOptions = { workingDirectory, skipGitRepoCheck: true, sandboxMode: "read-only", approvalPolicy: "never", networkAccessEnabled: false } satisfies ThreadOptions;
  const thread = (dependencies.threadFactory ?? defaultBasicJudgeThreadFactory).start(codexOptions, threadOptions);
  const turn = await thread.run(basicJudgePrompt(output, promptText), { outputSchema: judgeSchema });
  const value = JSON.parse(turn.finalResponse) as BasicJudge;
  const expected = new Set(basicEvalFacts.map((fact) => fact.id)); const actual = new Set(value.factIds);
  const valid = expected.size === actual.size && [...expected].every((id) => actual.has(id)) && value.graphUseful && value.detailsUseful && value.problems.length === 0;
  return { ...value, verdict: valid ? "pass" : "fail" };
}

const defaultBasicJudgeThreadFactory: BasicJudgeThreadFactory = {
  start(codexOptions, threadOptions) {
    return new Codex(codexOptions).startThread(threadOptions);
  },
};

export function basicJudgePrompt(output: CompletionOutput, promptText: string): string {
  const visible = judgeVisibleGraph(output);
  return `Grade this visible graph answer to: ${promptText}\nExpected facts:\n${basicEvalFacts.map((fact)=>`${fact.id}: ${fact.description}`).join("\n")}\nGraph: ${JSON.stringify(visible)}\nEdges are undirected. Each endpoint pair is an association, [a,b] means the same thing as [b,a], and endpoint order does not encode flow direction. Judge whether the connections usefully relate the concepts; do not infer sequencing from tuple order. Assess facts from node text and graph topology together. For this task, exactly two worker nodes shown busy while additional work remains queued clearly establishes the two-active-task limit unless the graph indicates another executor.\nList only fact IDs clearly present. Pass only when all six facts are present, graph connections are useful, details are useful, and there are no problems.`;
}

export function judgeVisibleGraph(output: CompletionOutput): { nodes: readonly { id: number; icon: string; title: string; detail: string }[]; edges: readonly (readonly [number, number])[] } {
  return { nodes: output.rootLayer.nodes.map(({ id, icon, title, detail }) => ({ id, icon, title, detail })), edges: output.rootLayer.edges.map((edge) => edge.endpoints) };
}

async function startGraphServer(binary: string | undefined, database: string, controlToken: string, readyTimeoutMs = 10_000): Promise<{ url: string; process: ChildProcessWithoutNullStreams }> {
  const executable = resolve(binary ?? process.env.RELAYER_GRAPH_SERVER_BIN ?? join(repositoryRoot, "target/debug/relayer-graph-server"));
  try { await access(executable); } catch { throw new Error(`Rust graph server not found at ${executable}. Run: cargo build -p relayer-graph-server`); }
  await mkdir(resolve(database, ".."), { recursive: true });
  const child = spawn(executable, ["--database", database, "--control-token", controlToken, "--port", "0"], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    const line = await firstLine(child, readyTimeoutMs);
    const ready = JSON.parse(line) as { url?: string };
    if (!ready.url) throw new Error(`Graph server returned an invalid readiness line: ${line}`);
    return { url: ready.url, process: child };
  } catch (error) {
    await terminate(child);
    throw error;
  }
}
function firstLine(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<string> { return new Promise((resolveLine,reject)=>{let value="";const timer=setTimeout(()=>{cleanup();reject(new Error(`Graph server did not become ready within ${timeoutMs}ms`));},timeoutMs);const onData=(chunk:Buffer)=>{value+=chunk.toString();const index=value.indexOf("\n");if(index>=0){cleanup();resolveLine(value.slice(0,index));}};const onExit=(code:number|null)=>{cleanup();reject(new Error(`Graph server exited before ready (${code})`));};const onError=(error:Error)=>{cleanup();reject(new Error(`Graph server could not start: ${error.message}`,{cause:error}));};const cleanup=()=>{clearTimeout(timer);child.stdout.off("data",onData);child.off("exit",onExit);child.off("error",onError);};child.stdout.on("data",onData);child.once("exit",onExit);child.once("error",onError);}); }
function onceExit(child: ChildProcessWithoutNullStreams): Promise<void> { if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(); return new Promise((resolveExit)=>child.once("exit",()=>resolveExit())); }
async function terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = onceExit(child);
  child.kill("SIGTERM");
  let timer: NodeJS.Timeout | undefined;
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(false), 1_000); }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (!graceful) {
    child.kill("SIGKILL");
    await exited;
  }
}
async function requestJson<T=unknown>(url:string,token:string,body:unknown,expected=200):Promise<T>{const response=await fetch(url,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(body)});const value=await response.json();if(response.status!==expected)throw new Error(`Request ${url} failed (${response.status}): ${JSON.stringify(value)}`);return value as T;}

async function requestControlJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const value: unknown = await response.json();
  if (!response.ok) throw new Error(`Request ${url} failed (${response.status}): ${JSON.stringify(value)}`);
  return value as T;
}

async function readPersistedHarnessState(stateFile: string, threadId: number): Promise<unknown> {
  const parsed: unknown = JSON.parse(await readFile(stateFile, "utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed.sessions)) return undefined;
  const session = parsed.sessions.find((value) => isRecord(value) && value.threadId === threadId);
  return isRecord(session) ? structuredClone(session.state) : undefined;
}

function checkProviderSessionContinuity(
  snapshots: readonly unknown[],
  implementation: string,
): EvalCheck {
  const serialized = snapshots.map((snapshot) => JSON.stringify(snapshot));
  const stable = serialized.length === 2
    && serialized[0] !== undefined
    && serialized[0] !== "{}"
    && serialized[0] === serialized[1];
  const codexThreadIds = snapshots.map((snapshot) => (
    isRecord(snapshot) && typeof snapshot.codexThreadId === "string" && snapshot.codexThreadId.trim() !== ""
      ? snapshot.codexThreadId
      : undefined
  ));
  const codexStable = implementation !== "codex.basic"
    || (codexThreadIds[0] !== undefined && codexThreadIds[0] === codexThreadIds[1]);
  return {
    name: "same-provider-session",
    passed: stable && codexStable,
    detail: implementation === "codex.basic"
      ? "Both interactions persisted the same non-empty Codex thread identity."
      : "Both interactions persisted the same non-empty deterministic fixture-session identity.",
  };
}

async function completeWithCapabilityCleanup<T>(operation: () => Promise<T>, capability: GraphCapability, controlToken: string): Promise<T> {
  const completion = await settle(operation);
  const cleanup = await settle(async () => {
    const response = await fetch(`${capability.url.replace(/\/$/, "")}/api/control/capabilities`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${controlToken}`, "content-type": "application/json" },
      body: JSON.stringify({ graphToken: capability.token }),
    });
    if (!response.ok) throw new Error(`Graph capability revocation failed with ${response.status}`);
  });
  if (!completion.ok && !cleanup.ok) throw new AggregateError([completion.error, cleanup.error], "Eval completion and graph capability cleanup failed");
  if (!completion.ok) throw completion.error;
  if (!cleanup.ok) throw cleanup.error;
  return completion.value;
}

async function settle<T>(operation: () => Promise<T>): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error };
  }
}

export function renderArtifact(artifact: RuntimeEvalArtifact): string {
  const data = JSON.stringify(artifact).replace(/</g, "\\u003c");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(artifact.execution.testCaseId)}</title>
  <style>
    body{margin:0;background:#111317;color:#edf0f5;font:14px system-ui}
    .bar{padding:18px 24px;border-bottom:1px solid #343842}
    .summary{display:flex;align-items:center;gap:8px}
    .turns{display:flex;align-items:center;gap:10px;margin-top:12px}
    button{background:#242832;border:1px solid #555b69;border-radius:8px;color:#edf0f5;padding:5px 10px;cursor:pointer}
    button:disabled{cursor:default;opacity:.4}
    .prompt{margin-top:10px;color:#c9cfda}
    .stage{height:64vh;position:relative}
    .node{position:absolute;width:180px;padding:14px;background:#1d2027;border:1px solid #555b69;border-radius:14px;transform:translate(-50%,-50%);cursor:grab}
    .node b{display:block;margin-top:7px}
    .node small{color:#aeb5c3}
    svg{position:absolute;inset:0;width:100%;height:100%}
    line{stroke:#7b8395;stroke-width:2}
    .checks{padding:18px 24px}
    .pass{color:#68d391}
    .fail{color:#fc8181}
  </style>
</head>
<body>
  <div class="bar">
    <div class="summary"><b>${escapeHtml(artifact.execution.testCaseId)}</b> · ${escapeHtml(artifact.execution.harnessConfigurationName)} · <span class="${artifact.passed ? "pass" : "fail"}">${artifact.passed ? "PASS" : "FAIL"}</span></div>
    <div class="turns"><button id="previous" aria-label="Previous turn">←</button><span id="turn-label"></span><button id="next" aria-label="Next turn">→</button></div>
    <div class="prompt" id="prompt"></div>
  </div>
  <div class="stage" id="stage"><svg id="edges"></svg></div>
  <div class="checks" id="checks"></div>
  <script>
    const artifact=${data};
    const stage=document.querySelector('#stage');
    const edgeCanvas=document.querySelector('#edges');
    const previous=document.querySelector('#previous');
    const next=document.querySelector('#next');
    let turnIndex=0;
    let nodes=[];
    let edges=[];

    previous.onclick=()=>{if(turnIndex>0){turnIndex-=1;render()}};
    next.onclick=()=>{if(turnIndex<artifact.turns.length-1){turnIndex+=1;render()}};

    function render(){
      const turn=artifact.turns[turnIndex];
      previous.disabled=turnIndex===0;
      next.disabled=turnIndex===artifact.turns.length-1;
      document.querySelector('#turn-label').textContent='Turn '+(turnIndex+1)+' of '+artifact.turns.length;
      document.querySelector('#prompt').textContent=turn.prompt;
      document.querySelectorAll('.node').forEach((node)=>node.remove());
      edgeCanvas.replaceChildren();
      const layout=turn.output.rootLayer.layer.layout;
      const authored=new Map((layout?.version===1?layout.placements:[]).map((placement)=>[String(placement.nodeId),placement]));
      const legacy=[...turn.output.rootLayer.nodes].sort((left,right)=>String(left.id).localeCompare(String(right.id)));
      nodes=turn.output.rootLayer.nodes.map((node)=>{
        const placement=authored.get(String(node.id));
        if(placement)return {...node,x:110+placement.x*740,y:80+placement.y*440};
        const index=legacy.findIndex((candidate)=>String(candidate.id)===String(node.id));
        const angle=-Math.PI/2+(index*2*Math.PI/Math.max(legacy.length,1));
        return {...node,x:480+(legacy.length===1?0:Math.cos(angle)*260),y:300+(legacy.length===1?0:Math.sin(angle)*180)};
      });
      edges=turn.output.rootLayer.edges;
      for(const node of nodes){
        const element=document.createElement('div');
        const icon=document.createElement('span');
        const title=document.createElement('b');
        const detail=document.createElement('small');
        element.className='node';
        element.dataset.id=node.id;
        icon.textContent=node.icon;
        title.textContent=node.title;
        detail.textContent=node.detail;
        element.append(icon,title,detail);
        stage.append(element);
        element.onpointerdown=(event)=>{
          element.setPointerCapture(event.pointerId);
          element.onpointermove=(move)=>{node.x=move.clientX;node.y=move.clientY-stage.getBoundingClientRect().top;draw()};
        };
      }
      const checks=document.querySelector('#checks');
      checks.replaceChildren();
      for(const check of [...artifact.sessionChecks,...turn.checks]){
        const row=document.createElement('div');
        row.className=check.passed?'pass':'fail';
        row.textContent=(check.passed?'✓ ':'✕ ')+check.name+' — '+check.detail;
        checks.append(row);
      }
      draw();
    }

    function draw(){
      for(const node of nodes){
        const element=stage.querySelector('[data-id="'+node.id+'"]');
        element.style.left=node.x+'px';
        element.style.top=node.y+'px';
      }
      edgeCanvas.replaceChildren(...edges.map((edge)=>{
        const left=nodes.find((node)=>node.id===edge.endpoints[0]);
        const right=nodes.find((node)=>node.id===edge.endpoints[1]);
        const line=document.createElementNS('http://www.w3.org/2000/svg','line');
        line.setAttribute('x1',left.x);line.setAttribute('y1',left.y);line.setAttribute('x2',right.x);line.setAttribute('y2',right.y);
        return line;
      }));
    }

    render();
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export function executionDirectory(
  outputDirectory: string,
  execution: Pick<TestExecutionPlan<unknown>, "testRunId" | "testCaseId" | "harnessConfigurationName">,
): string {
  return join(resolve(outputDirectory), execution.testRunId, execution.testCaseId, execution.harnessConfigurationName);
}
