import { EdgeObject, LayerObject, NodeObject, RelayerGraphClient, type CompletionOutput, type GraphCapability, type GraphNode } from "@relayer/graph-client";
import type { Harness, HarnessConfiguration, HarnessFactory, HarnessSessionState } from "@relayer/harness-host";

export const taskSystemFixtureConfiguration: HarnessConfiguration = {
  schemaVersion: 1,
  name: "fixture-task-system",
  implementation: "fixture.task-system",
  implementationVersion: 1,
  settings: {},
};

class TaskSystemFixtureHarness implements Harness {
  constructor(private graph: RelayerGraphClient) {}

  setGraphCapability(graph: GraphCapability): void {
    this.graph = new RelayerGraphClient(graph);
  }

  state(): HarnessSessionState {
    return {};
  }

  async complete(interaction: GraphNode): Promise<CompletionOutput> {
    const queue = new NodeObject("queue", "Incoming queue", "Every task first enters the incoming queue. The queue preserves extra work while both workers are busy.", "concept", "queue");
    const workers = new NodeObject("workers", "Two-worker pool", "An available worker claims the next queued task. At most two tasks run concurrently; additional tasks wait until a worker finishes.", "concept", "workers");
    const results = new NodeObject("database", "Results store", "When a worker completes a task, it writes the output to the results store. The freed worker then claims the next task from the queue.", "concept", "results");
    await this.graph.submitNode(queue);
    await this.graph.submitNode(workers);
    await this.graph.submitNode(results);
    const queueWorkers = new EdgeObject([queue, workers], "queue-workers");
    const workersResults = new EdgeObject([workers, results], "workers-results");
    await this.graph.createEdge(queueWorkers);
    await this.graph.createEdge(workersResults);
    const layer = new LayerObject([queue, workers, results], [queueWorkers, workersResults], "root-layer");
    await this.graph.submitLayer(layer);
    await this.graph.addAction(interaction.id, { kind: "navigate", label: "Response", target: layer, response: true, clientKey: "response" });
    return this.graph.submit(interaction.id);
  }
}

export const taskSystemFixtureFactory: HarnessFactory = (context) => new TaskSystemFixtureHarness(new RelayerGraphClient(context.graph));
