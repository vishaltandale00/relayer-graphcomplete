import { detailCapability, html, type ActionObject, EdgeObject, LayerLayoutObject, LayerObject, NodeObject, NodePlacementObject, RelayerGraphClient } from "@relayer/graph-client";
import { renderInteractionInput, type Harness, type HarnessConfiguration, type HarnessFactory, type HarnessRunContext, type HarnessSessionState, type HarnessTraceSupport } from "@relayer/harness-host";
import { readFile } from "node:fs/promises";

export const taskSystemFixtureConfiguration: HarnessConfiguration = {
  schemaVersion: 1,
  name: "fixture-task-system",
  implementation: "fixture.task-system",
  implementationVersion: 1,
  permissionBindings: { ask: {}, auto: {}, full: {} },
  settings: {},
};

class TaskSystemFixtureHarness implements Harness {
  traceSupport(): HarnessTraceSupport {
    return {
      prompt: "full",
      messages: "full",
      reasoningSummaries: "none",
      modelCalls: "none",
      toolCalls: "summary",
      usage: "none",
      childStreams: "none",
      nativeArtifacts: "none",
    };
  }

  state(): HarnessSessionState {
    return {};
  }

  async complete(context: HarnessRunContext): Promise<void> {
    const graph = new RelayerGraphClient(context.graph.acquireCapability());
    const rereadInput = await graph.getInteractionInput();
    if (renderInteractionInput(rereadInput) !== renderInteractionInput(context.interactionInput)) {
      throw new Error("Harness run context does not match the interaction input re-read from its graph capability");
    }
    context.trace.emit({ type: "prompt", data: { text: renderInteractionInput(context.interactionInput), kind: "fixture-input" } });
    context.trace.emit({ type: "tool.call.started", data: { tool: "fixture.graph-authoring" } });
    await waitForInvokeEvidenceRelease(context.inputGraph.leasedActionId
      ?? rereadInput.completionContract?.input.invocationReferences[0]?.sourceActionId);
    const interaction = context.inputGraph;
    const queue = new NodeObject("list", "Incoming queue", "Every task first enters the incoming queue. The queue preserves extra work while both workers are busy.", "concept", "queue");
    const workers = new NodeObject("users", "Two-worker pool", "An available worker claims the next queued task. At most two tasks run concurrently; additional tasks wait until a worker finishes.", "concept", "workers");
    const results = new NodeObject("database", "Results store", "When a worker completes a task, it writes the output to the results store. The freed worker then claims the next task from the queue.", "concept", "results");
    const waiting = new NodeObject("list", "Waiting tasks", "Tasks remain ordered in the queue until one of the two workers becomes available.", "detail", "waiting-tasks");
    const claim = new NodeObject("arrow-right-circle", "Next claim", "Immediately after a worker finishes, it claims the next waiting task and frees queue capacity.", "detail", "next-claim");
    const queueWorkers = new EdgeObject([queue, workers], "queue-workers");
    const workersResults = new EdgeObject([workers, results], "workers-results");
    const layer = new LayerObject(
      [queue, workers, results],
      [queueWorkers, workersResults],
      new LayerLayoutObject([
        new NodePlacementObject(queue, 0.15, 0.5),
        new NodePlacementObject(workers, 0.5, 0.5),
        new NodePlacementObject(results, 0.85, 0.5),
      ], "default"),
      "root-layer",
    );
    const nextImprovement = {
      kind: "invoke",
      sourceLayer: layer,
      label: "Plan the next improvement",
      interactionText: "Propose the most useful next improvement to this task system.",
      clientKey: "next-improvement",
    } satisfies ActionObject;
    const compiledInvoke = rereadInput.interactionPermissions?.enabled === true;
    if (compiledInvoke) {
      results.detailAuthoring.setComponent("continuation", html`<p>Completed tasks remain in the results store.</p><button gc=${detailCapability.invoke("continue", nextImprovement)}>Plan the next improvement</button>`);
    }
    await graph.submitNode(queue);
    await graph.submitNode(workers);
    await graph.submitNode(results);
    await graph.submitNode(waiting);
    await graph.submitNode(claim);
    const waitingClaim = new EdgeObject([waiting, claim], "waiting-claim");
    await graph.createEdge(waitingClaim);
    const claimResults = new EdgeObject([claim, results], "claim-results");
    if (compiledInvoke) await graph.createEdge(claimResults);
    const queueDetail = new LayerObject(
      compiledInvoke ? [waiting, claim, results] : [waiting, claim],
      compiledInvoke ? [waitingClaim, claimResults] : [waitingClaim],
      new LayerLayoutObject([
        new NodePlacementObject(waiting, 0.25, 0.5),
        new NodePlacementObject(claim, 0.75, 0.5),
        ...(compiledInvoke ? [new NodePlacementObject(results, 0.5, 0.8)] : []),
      ], "default"),
      "queue-detail-layer",
    );
    await graph.submitLayer(queueDetail);
    await graph.createEdge(queueWorkers);
    await graph.createEdge(workersResults);
    await graph.submitLayer(layer);
    await graph.addAction(queue, { kind: "navigate", relation: "expand", sourceLayer: layer, label: "See queue behavior", target: queueDetail, clientKey: "queue-detail" });
    await graph.addAction(results, nextImprovement);
    await graph.addAction(interaction.id, { kind: "navigate", relation: "expand", label: "Response", target: layer, clientKey: "response" });
    for (const requirement of rereadInput.completionContract?.returnRequirements ?? []) {
      if (requirement.kind !== "navigate.response") continue;
      const snapshot = await graph.getNodePresentation(requirement.nodeId);
      const response = { kind: "navigate", relation: "reference", label: "Updated task-system analysis", target: layer, clientKey: `integrated-response-${interaction.id}-${requirement.nodeId}` } as const;
      await graph.addAction(requirement.nodeId, response);
      if (snapshot.node.authoredDetail) {
        const prior = snapshot.node;
        const replacement = new NodeObject(prior.icon, prior.title, prior.detail, prior.kind, prior.clientKey);
        replacement.detailAuthoring.setComponent("integrated-analysis", html`<section><p>The task-system analysis now incorporates the next improvement.</p><button gc=${detailCapability.reference("response", response)}>Updated task-system analysis</button></section>`);
        for (const action of snapshot.actions) {
          if (action.kind !== "invoke" || !action.clientKey || !action.sourceLayerClientKey || !action.interactionText) throw new Error("Unexpected task-system fixture attached source action");
          const sourceLayer = new LayerObject([replacement], [], new LayerLayoutObject([new NodePlacementObject(replacement, 0.5, 0.5)], "default"), action.sourceLayerClientKey);
          const retained = { kind: "invoke", sourceLayer, label: action.label, interactionText: action.interactionText, clientKey: action.clientKey } as const;
          replacement.detailAuthoring.setComponent(`retained-${action.id}`, html`<section><button gc=${detailCapability.invoke(`retained-${action.id}`, retained)}>Plan the next improvement</button></section>`);
        }
        await graph.replaceNodePresentation(requirement.nodeId, snapshot.revision, replacement);
      }
    }
    await graph.submit(interaction.id);
    context.trace.emit({ type: "tool.call.completed", data: { tool: "fixture.graph-authoring", status: "completed" } });
    context.trace.emit({ type: "message", data: { role: "assistant", text: "Authored and accepted the task-system graph." } });
  }
}

export const taskSystemFixtureFactory: HarnessFactory = () => new TaskSystemFixtureHarness();

async function waitForInvokeEvidenceRelease(leasedActionId: number | null | undefined): Promise<void> {
  const gatePath = process.env.RELAYER_FIXTURE_INVOKE_GATE_FILE;
  if (leasedActionId == null || !gatePath) return;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await readFile(gatePath, "utf8").catch(() => "")) === "release") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for the deterministic invoke evidence gate.");
}
