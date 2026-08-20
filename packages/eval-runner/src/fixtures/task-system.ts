import { EdgeObject, LayerObject, NodeObject, RelayerGraphClient } from "@relayer/graph-client";
import type { Harness, HarnessConfiguration, HarnessFactory, HarnessRunContext, HarnessSessionState } from "@relayer/harness-host";

export const taskSystemFixtureConfiguration: HarnessConfiguration = {
  schemaVersion: 1,
  name: "fixture-task-system",
  implementation: "fixture.task-system",
  implementationVersion: 1,
  settings: {},
};

class TaskSystemFixtureHarness implements Harness {
  state(): HarnessSessionState {
    return {};
  }

  async complete(context: HarnessRunContext): Promise<void> {
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
    await graph.addAction(queue, { kind: "navigate", label: "See queue behavior", target: queueDetail, clientKey: "queue-detail" });
    await graph.addAction(interaction.id, { kind: "navigate", label: "Response", target: layer, response: true, clientKey: "response" });
    await graph.submit(interaction.id);
  }
}

export const taskSystemFixtureFactory: HarnessFactory = () => new TaskSystemFixtureHarness();
