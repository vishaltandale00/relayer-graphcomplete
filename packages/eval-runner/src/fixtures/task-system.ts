import { EdgeObject, LayerObject, NodeObject, RelayerGraphClient } from "@relayer/graph-client";
import type { Harness, HarnessConfiguration, HarnessFactory, HarnessRunContext, HarnessSessionState, HarnessTraceSupport } from "@relayer/harness-host";
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
    context.trace.emit({ type: "prompt", data: { text: context.inputGraph.detail, kind: "fixture-input" } });
    context.trace.emit({ type: "tool.call.started", data: { tool: "fixture.graph-authoring" } });
    await waitForInvokeEvidenceRelease(context.inputGraph.leasedActionId);
    const graph = new RelayerGraphClient(context.graph.acquireCapability());
    const interaction = context.inputGraph;
    const queue = new NodeObject("list", "Incoming queue", "Every task first enters the incoming queue. The queue preserves extra work while both workers are busy.", "concept", "queue");
    const workers = new NodeObject("users", "Two-worker pool", "An available worker claims the next queued task. At most two tasks run concurrently; additional tasks wait until a worker finishes.", "concept", "workers");
    const results = new NodeObject("database", "Results store", "When a worker completes a task, it writes the output to the results store. The freed worker then claims the next task from the queue.", "concept", "results");
    const waiting = new NodeObject("list", "Waiting tasks", "Tasks remain ordered in the queue until one of the two workers becomes available.", "detail", "waiting-tasks");
    const claim = new NodeObject("arrow-right-circle", "Next claim", "Immediately after a worker finishes, it claims the next waiting task and frees queue capacity.", "detail", "next-claim");
    await graph.submitNode(queue);
    await graph.submitNode(workers);
    await graph.submitNode(results);
    await graph.submitNode(waiting);
    await graph.submitNode(claim);
    const waitingClaim = new EdgeObject([waiting, claim], "waiting-claim");
    await graph.createEdge(waitingClaim);
    const queueDetail = new LayerObject([waiting, claim], [waitingClaim], "queue-detail-layer");
    await graph.submitLayer(queueDetail);
    const queueWorkers = new EdgeObject([queue, workers], "queue-workers");
    const workersResults = new EdgeObject([workers, results], "workers-results");
    await graph.createEdge(queueWorkers);
    await graph.createEdge(workersResults);
    const layer = new LayerObject([queue, workers, results], [queueWorkers, workersResults], "root-layer");
    await graph.submitLayer(layer);
    await graph.addAction(queue, { kind: "navigate", relation: "expand", sourceLayer: layer, label: "See queue behavior", target: queueDetail, clientKey: "queue-detail" });
    await graph.addAction(results, {
      kind: "invoke",
      sourceLayer: layer,
      label: "Plan the next improvement",
      interactionText: "Propose the most useful next improvement to this task system.",
      clientKey: "next-improvement",
    });
    await graph.addAction(interaction.id, { kind: "navigate", relation: "expand", label: "Response", target: layer, clientKey: "response" });
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
