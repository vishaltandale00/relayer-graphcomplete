import {
  RelayerGraphClient,
  NodeObject,
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
  private nodeId: number | undefined;

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

    if (this.nodeId === undefined) {
      const node = new NodeObject(
        "■",
        "Accepted Visual Node Detail",
        "The accepted package mounts inside the sidebar through the constrained runtime.",
        "fixture.node-detail",
        "fixture-node-detail.accepted",
      );
      node.detailAuthoring.setComponent(
        "primary",
        html`<p>Link: <a href="https://relayer.example/digest">open bound link</a></p>`,
        css`p { color: black } a { text-decoration: underline }`,
      );
      node.detailAuthoring.setComponent(
        "image",
        html`<img alt="pinned pixel">`,
        css`img { border: none }`,
      );
      node.detailAuthoring.setComponent(
        "input",
        html`<input type="text" placeholder="accepted">`,
        css`input { border: 1px solid black }`,
      );
      const submitted: GraphNode = await graph.submitNode(node);
      this.nodeId = submitted.id;
      context.trace.emit({
        type: "message",
        data: { role: "assistant", text: `Accepted node ${this.nodeId} has a compiled Node Detail.` },
      });
      return;
    }

    context.trace.emit({
      type: "message",
      data: { role: "assistant", text: `Node ${this.nodeId} remains inspected through the accepted-package seam.` },
    });
  }
}

export const nodeDetailFixtureFactory: HarnessFactory = () => new NodeDetailHarness();
