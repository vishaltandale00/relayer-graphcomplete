import {
  RelayerGraphClient,
  LayerLayoutObject,
  LayerObject,
  NodeObject,
  NodePlacementObject,
  html,
  css,
  type GraphNode,
  type GraphCapability,
} from "@relayer/graph-client";
import { renderInteractionInput, type Harness, type HarnessConfiguration, type HarnessFactory, type HarnessRunContext } from "@relayer/harness-host";

export const nodeDetailHarnessConfiguration: HarnessConfiguration = {
  schemaVersion: 1,
  name: "fixture-node-detail",
  implementation: "fixture.node-detail",
  implementationVersion: 1,
  graphCapabilityProfile: { search: "query-v1" },
  permissionBindings: { ask: {}, auto: {}, full: {} },
  settings: {},
};

const SESSION_ID = "fixture.node-detail.session.v1";

class NodeDetailHarness implements Harness {
  traceSupport() {
    return {
      prompt: "full" as const,
      messages: "full" as const,
      reasoningSummaries: "none" as const,
      modelCalls: "none" as const,
      toolCalls: "summary" as const,
      usage: "none" as const,
      childStreams: "none" as const,
      nativeArtifacts: "none" as const,
    };
  }

  state() {
    return { graphMemorySessionId: SESSION_ID };
  }

  async complete(context: HarnessRunContext): Promise<void> {
    const graph = new RelayerGraphClient(context.graph.acquireCapability() as GraphCapability);
    const prompt = renderInteractionInput(context.interactionInput);
    context.trace.emit({ type: "prompt", data: { text: prompt, kind: "fixture-input" } });
    context.trace.emit({ type: "tool.call.started", data: { tool: "fixture.node-detail" } });

    const node = new NodeObject(
      "layout-template",
      "Accepted Visual Node Detail",
      "The accepted package mounts inside the sidebar through the constrained runtime.",
      "fixture.node-detail",
      "fixture-node-detail.accepted",
    );
    node.detailAuthoring.setComponent(
      "primary",
      html`<section><h2>Accepted detail</h2><p>This content is compiled with the node.</p></section>`,
      css`section { display: grid; gap: 0.5rem } h2, p { margin: 0 }`,
    );
    node.detailAuthoring.setComponent(
      "status",
      html`<aside><strong>Status</strong><span>Ready for constrained rendering</span></aside>`,
      css`aside { display: flex; justify-content: space-between; gap: 1rem }`,
    );
    node.detailAuthoring.setComponent(
      "facts",
      html`<dl><dt>Package</dt><dd>Accepted</dd></dl>`,
      css`dl { display: grid; grid-template-columns: auto 1fr; gap: 0.5rem } dt, dd { margin: 0 }`,
    );
    const submitted: GraphNode = await graph.submitNode(node);
    const layer = new LayerObject(
      [node],
      [],
      new LayerLayoutObject([new NodePlacementObject(node, 0.5, 0.5)]),
      "fixture-node-detail.root",
    );
    await graph.submitLayer(layer);
    await graph.addAction(context.inputGraph.id, {
      kind: "navigate",
      relation: "expand",
      label: "Response",
      target: layer,
      clientKey: "fixture-node-detail.response",
    });
    await graph.submit(context.inputGraph.id);
    context.trace.emit({ type: "tool.call.completed", data: { tool: "fixture.node-detail", status: "completed" } });
    context.trace.emit({
      type: "message",
      data: { role: "assistant", text: `Accepted node ${submitted.id} has a compiled Node Detail.` },
    });
  }
}

export const nodeDetailFixtureFactory: HarnessFactory = () => new NodeDetailHarness();
