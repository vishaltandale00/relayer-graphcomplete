import {
  RelayerGraphClient,
  LayerLayoutObject,
  LayerObject,
  NodeObject,
  NodePlacementObject,
  assetRef,
  detailCapability,
  html,
  css,
  type GraphNode,
  type GraphCapability,
} from "@relayer/graph-client";
import {
  renderInteractionInput,
  type Harness,
  type HarnessConfiguration,
  type HarnessFactory,
  type HarnessRunContext,
} from "@relayer/harness-host";
import { readFile, writeFile } from "node:fs/promises";

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
const FIXTURE_VISUAL = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 120" role="img"><rect width="320" height="120" rx="18" fill="#172554"/><circle cx="62" cy="60" r="30" fill="#38bdf8"/><path d="M122 42h150v14H122zm0 28h104v10H122z" fill="#e0f2fe"/></svg>`;

export const NODE_DETAIL_EVAL_CASE_ID =
  "empty-project.visual-node-detail.single-turn";

export const nodeDetailEvalCase = Object.freeze({
  id: NODE_DETAIL_EVAL_CASE_ID,
  name: "Visual Node Detail · accepted package",
  description:
    "Loads a deterministic accepted package with authored layout and every currently supported Node Detail capability in the production review workspace.",
  defaultSelected: false,
  requiredHarnessConfigurationNames: Object.freeze([
    nodeDetailHarnessConfiguration.name,
  ]),
  prompts: Object.freeze([
    "Create the deterministic accepted visual Node Detail fixture for product and Eval review.",
  ]),
});

class NodeDetailHarness implements Harness {
  constructor(private readonly temporalEvidenceGatePath?: string) {}

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
    try {
      const graph = new RelayerGraphClient(
        context.graph.acquireCapability() as GraphCapability,
      );
      const prompt = renderInteractionInput(context.interactionInput);
      context.trace.emit({
        type: "prompt",
        data: { text: prompt, kind: "fixture-input" },
      });
      context.trace.emit({
        type: "tool.call.started",
        data: { tool: "fixture.node-detail" },
      });
      const milestone = async (stage: string) => {
        if (this.temporalEvidenceGatePath) {
          await writeFile(this.temporalEvidenceGatePath, JSON.stringify({ stage }), "utf8");
        }
      };
      await milestone("started");
      const visualAssetScope = await graph.visualAssets.scope();
      await milestone("scope-resolved");
      const visualAsset = await graph.visualAssets.add({
        scope: visualAssetScope,
        name: "Accepted detail status illustration",
        tagIds: [],
        file: {
          name: "accepted-detail-status.svg",
          mediaType: "image/svg+xml",
          async read() {
            return new TextEncoder().encode(FIXTURE_VISUAL);
          },
        },
      });

      await milestone("asset-added");
      const expanded = new NodeObject(
        "panels-top-left",
        "Expanded implementation notes",
        "The expand capability opens this authored child layer.",
        "fixture.node-detail",
        "fixture-node-detail.expanded",
      );
      const referenced = new NodeObject(
        "book-open",
        "Referenced evidence",
        "The reference capability opens this shared evidence layer without changing its meaning.",
        "fixture.node-detail",
        "fixture-node-detail.referenced",
      );
      const expandedLayer = new LayerObject(
        [expanded],
        [],
        new LayerLayoutObject([new NodePlacementObject(expanded, 0.5, 0.5)]),
        "fixture-node-detail.expanded-layer",
      );
      const referencedLayer = new LayerObject(
        [referenced],
        [],
        new LayerLayoutObject([new NodePlacementObject(referenced, 0.5, 0.5)]),
        "fixture-node-detail.referenced-layer",
      );
      const node = new NodeObject(
        "layout-template",
        "Accepted Visual Node Detail",
        "The accepted package mounts inside the sidebar through the constrained runtime with pinned visual content.",
        "fixture.node-detail",
        "fixture-node-detail.accepted",
      );
      const layer = new LayerObject(
        [node],
        [],
        new LayerLayoutObject([new NodePlacementObject(node, 0.5, 0.5)]),
        "fixture-node-detail.root",
      );
      const expandAction = {
        kind: "navigate" as const,
        relation: "expand" as const,
        label: "Open implementation notes",
        sourceLayer: layer,
        target: expandedLayer,
        clientKey: "fixture-node-detail.expand",
      };
      const referenceAction = {
        kind: "navigate" as const,
        relation: "reference" as const,
        label: "Open referenced evidence",
        sourceLayer: layer,
        target: referencedLayer,
        clientKey: "fixture-node-detail.reference",
      };
      const invokeAction = {
        kind: "invoke" as const,
        label: "Investigate follow-up",
        interactionText:
          "Investigate the accepted visual Node Detail fixture further.",
        sourceLayer: layer,
        clientKey: "fixture-node-detail.invoke",
      };
      const inputAction = {
        kind: "input" as const,
        label: "Review note",
        control: "text" as const,
        prompt: "Add a review note",
        sourceLayer: layer,
        clientKey: "fixture-node-detail.input",
      };
      node.detailAuthoring.setComponent(
        "primary",
        html`<section class="summary">
          <p class="eyebrow">Deterministic Eval fixture</p>
          <h2>Accepted detail</h2>
          <p>
            This authored layout is compiled with the node and mounted by the
            shared production runtime.
          </p>
        </section>`,
        css`
          .summary {
            display: grid;
            gap: 0.5rem;
            padding: 0.75rem;
            border: 1px solid #94a3b8;
            border-radius: 0.75rem;
          }
          .eyebrow {
            color: #475569;
            font-size: 0.75rem;
            text-transform: uppercase;
            letter-spacing: 0.08em;
          }
          h2,
          p {
            margin: 0;
          }
        `,
      );
      node.detailAuthoring.setComponent(
        "status",
        html`<aside>
          <strong>Status</strong><span>Ready for constrained rendering</span>
        </aside>`,
        css`
          aside {
            display: flex;
            justify-content: space-between;
            gap: 1rem;
          }
        `,
      );
      node.detailAuthoring.setComponent(
        "facts",
        html`<dl>
          <dt>Package</dt>
          <dd>Accepted</dd>
        </dl>`,
        css`
          dl {
            display: grid;
            grid-template-columns: auto 1fr;
            gap: 0.5rem;
          }
          dt,
          dd {
            margin: 0;
          }
        `,
      );
      node.detailAuthoring.setComponent(
        "visual",
        html`<figure>
          <img
            alt="Accepted detail status illustration"
            asset=${assetRef(visualAsset.id)}
          />
          <figcaption>
            Pinned content resolved through the active Eval completion scope.
          </figcaption>
        </figure>`,
        css`
          figure {
            display: grid;
            gap: 0.5rem;
            margin: 0;
          }
          img {
            display: block;
            width: 100%;
            height: auto;
            border-radius: 0.75rem;
          }
          figcaption {
            color: #475569;
            font-size: 0.8rem;
          }
        `,
      );
      node.detailAuthoring.setComponent(
        "navigation",
        html`<nav aria-label="Fixture navigation">
          <button gc=${detailCapability.expand("expand-notes", expandAction)}>
            Open implementation notes</button
          ><button
            gc=${detailCapability.reference("reference-evidence", referenceAction)}
          >
            Open referenced evidence
          </button>
        </nav>`,
        css`
          nav {
            display: grid;
            grid-template-columns: 1fr;
            gap: 0.5rem;
          }
          button {
            min-height: 2.25rem;
            text-align: left;
          }
        `,
      );
      node.detailAuthoring.setComponent(
        "actions",
        html`<section class="actions">
          <a
            gc=${detailCapability.externalLink("fixture-docs", "https://example.com/relayer-node-detail")}
            >Open fixture documentation</a
          ><button
            gc=${detailCapability.invoke("invoke-follow-up", invokeAction)}
          >
            Investigate follow-up</button
          ><label
            >Review note
            <input
              gc=${detailCapability.input("review-note", inputAction)}
              aria-label="Review note"
          /></label>
        </section>`,
        css`
          .actions {
            display: grid;
            gap: 0.75rem;
          }
          label {
            display: grid;
            gap: 0.25rem;
          }
          input {
            min-width: 0;
          }
        `,
      );
      await graph.submitNode(expanded);
      await milestone("expanded-submitted");
      await graph.submitNode(referenced);
      await milestone("referenced-submitted");
      const submitted: GraphNode = await graph.submitNode(node);
      await milestone("detail-submitted");
      await graph.submitLayer(expandedLayer);
      await milestone("expanded-layer-submitted");
      await graph.submitLayer(referencedLayer);
      await milestone("referenced-layer-submitted");
      const submittedLayer = await graph.submitLayer(layer);
      await milestone("main-layer-submitted");
      await graph.addAction(node, expandAction);
      await graph.addAction(node, referenceAction);
      await graph.addAction(node, invokeAction);
      await graph.addAction(node, inputAction);
      await graph.addAction(context.inputGraph.id, {
        kind: "navigate",
        relation: "expand",
        label: "Response",
        target: layer,
        clientKey: "fixture-node-detail.response",
      });
      if (this.temporalEvidenceGatePath) {
        const draftOnly = await graph.submitNode(
          new NodeObject(
            "file",
            "Unpublished draft detail",
            "This node is intentionally outside the accepted current layer.",
            "fixture.node-detail",
            "fixture-node-detail.draft-only",
          ),
        );
        await writeFile(this.temporalEvidenceGatePath, JSON.stringify({ stage: "before-advance" }), "utf8");
        const current = await graph.getCurrent();
        const advanced = await graph.advanceCurrent(
          layer,
          current.headRevision,
          "fixture-node-detail-advance",
        );
        await waitForTemporalEvidenceRelease(this.temporalEvidenceGatePath, {
          stage: "advanced",
          nodeId: submitted.id,
          draftNodeId: draftOnly.id,
          layerId: submittedLayer.id,
          assetId: visualAsset.id,
        });
        await graph.returnCurrent(
          layer,
          advanced.revision,
          "fixture-node-detail-return",
        );
      } else {
        await graph.submit(context.inputGraph.id);
      }
      context.trace.emit({
        type: "tool.call.completed",
        data: { tool: "fixture.node-detail", status: "completed" },
      });
      context.trace.emit({
        type: "message",
        data: {
          role: "assistant",
          text: `Accepted node ${submitted.id} has a compiled Node Detail.`,
        },
      });
    } catch (error) {
      if (this.temporalEvidenceGatePath) {
        await writeFile(this.temporalEvidenceGatePath, JSON.stringify({
          stage: "failed",
          error: error instanceof Error ? error.stack : String(error),
        }), "utf8");
      }
      throw error;
    }
  }
}

export const nodeDetailFixtureFactory: HarnessFactory = () =>
  new NodeDetailHarness();
export const nodeDetailFixtureFactoryWithTemporalGate = (
  gatePath: string,
): HarnessFactory => () => new NodeDetailHarness(gatePath);

async function waitForTemporalEvidenceRelease(
  gatePath: string | undefined,
  evidence: Record<string, string | number>,
): Promise<void> {
  if (!gatePath) return;
  await writeFile(gatePath, JSON.stringify(evidence), "utf8");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await readFile(gatePath, "utf8").catch(() => "")) === "release")
      return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    "Timed out waiting for the deterministic Node Detail temporal evidence gate.",
  );
}
