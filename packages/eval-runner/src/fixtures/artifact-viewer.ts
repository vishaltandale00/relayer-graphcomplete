// Deterministic artifact-viewer fixture (PRD 6.6, ART-001..008). It copies a small
// launch kit into the thread folder, then authors one graph whose nodes open
// artifact layers: a website (whole, a route on a phone), a PDF (whole, page 4),
// a video (whole, a segment), an image, Markdown (whole, a heading), a page with a
// script error, and a deployed https site. No model runs.
import { EdgeObject, LayerLayoutObject, LayerObject, NodeObject, NodePlacementObject, RelayerGraphClient, type ArtifactDetails } from "@relayer/graph-client";
import { renderInteractionInput, type Harness, type HarnessConfiguration, type HarnessFactory, type HarnessFactoryContext, type HarnessRunContext, type HarnessSessionState, type HarnessTraceSupport } from "@relayer/harness-host";
import { appendFile, copyFile, cp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const artifactViewerFixtureConfiguration: HarnessConfiguration = {
  schemaVersion: 1,
  name: "fixture-artifact-viewer",
  implementation: "fixture.artifact-viewer",
  implementationVersion: 1,
  permissionBindings: { ask: {}, auto: {}, full: {} },
  settings: {},
};

/** The checked-in launch kit; the desktop evidence script may point elsewhere. */
export function artifactViewerFixtureFolder(): string {
  return process.env.RELAYER_ARTIFACT_FIXTURE_DIR
    ?? resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../test/fixtures/artifact-viewer/thread-folder");
}

interface ArtifactView {
  readonly key: string;
  readonly icon: string;
  readonly title: string;
  readonly detail: string;
  readonly label: string;
  readonly artifact: ArtifactDetails;
}

interface Group {
  readonly key: string;
  readonly icon: string;
  readonly title: string;
  readonly detail: string;
  readonly views: readonly ArtifactView[];
}

const site = { file: "site/index.html", root: "site" } as const;

export const ARTIFACT_VIEWER_FIXTURE_GROUPS: readonly Group[] = [
  {
    key: "website", icon: "globe", title: "Landing page", detail: "The Tidewater site in `site/`: home, menu and subscriptions.",
    views: [
      { key: "site", icon: "globe", title: "Landing page", detail: "The whole site at desktop width.", label: "Open the site", artifact: { kind: "website", source: site } },
      { key: "site-phone", icon: "smartphone", title: "Pricing on a phone", detail: "The subscriptions section at phone width.", label: "Pricing on a phone", artifact: { kind: "website", source: site, part: { route: "#pricing" }, viewport: "phone" } },
    ],
  },
  {
    key: "brief", icon: "file-text", title: "Investor brief", detail: "A five-page PDF for the seed round.",
    views: [
      { key: "pdf", icon: "file-text", title: "Investor brief", detail: "The brief from page 1.", label: "Read the brief", artifact: { kind: "pdf", source: { file: "docs/investor-brief.pdf" } } },
      { key: "pdf-page", icon: "file-text", title: "Use of funds", detail: "Page 4: the plan.", label: "Use of funds (page 4)", artifact: { kind: "pdf", source: { file: "docs/investor-brief.pdf" }, part: { page: 4 } } },
    ],
  },
  {
    key: "promo", icon: "clapperboard", title: "Promo video", detail: "A 20-second promo in four chapters.",
    views: [
      { key: "video", icon: "clapperboard", title: "Promo video", detail: "The whole promo.", label: "Watch it", artifact: { kind: "video", source: { file: "media/promo.webm" } } },
      { key: "video-segment", icon: "video", title: "Ship chapter", detail: "Seconds 10 to 15.", label: "Ship chapter (0:10–0:15)", artifact: { kind: "video", source: { file: "media/promo.mp4" }, part: { start: 10, end: 15 } } },
    ],
  },
  {
    key: "brand", icon: "palette", title: "Brand assets", detail: "The hero image and the brand guide.",
    views: [
      { key: "hero", icon: "image", title: "Hero image", detail: "The 1600 by 900 hero.", label: "Hero image", artifact: { kind: "image", source: { file: "brand/hero.png" } } },
      { key: "guide", icon: "book-open", title: "Brand guide", detail: "Voice, colour, logo and packaging rules.", label: "Brand guide", artifact: { kind: "markdown", source: { file: "docs/brand-guide.md" } } },
      { key: "guide-colour", icon: "palette", title: "Brand colours", detail: "The colour section.", label: "Colours", artifact: { kind: "markdown", source: { file: "docs/brand-guide.md" }, part: { heading: "Colour" } } },
    ],
  },
  {
    key: "checks", icon: "triangle-alert", title: "Things to check", detail: "A menu board whose script fails, and the deployed preview.",
    views: [
      { key: "menu-board", icon: "triangle-alert", title: "Menu board", detail: "Its specials script throws.", label: "Menu board", artifact: { kind: "website", source: { file: "site-broken/index.html", root: "site-broken" } } },
      { key: "deployed", icon: "link", title: "Deployed site", detail: "The preview deployment over https.", label: "Deployed site", artifact: { kind: "url", source: { url: "https://example.com/" } } },
    ],
  },
];

class ArtifactViewerFixtureHarness implements Harness {
  constructor(private readonly context: HarnessFactoryContext) {}

  traceSupport(): HarnessTraceSupport {
    return { prompt: "full", messages: "full", reasoningSummaries: "none", modelCalls: "none", toolCalls: "summary", usage: "none", childStreams: "none", nativeArtifacts: "none" };
  }

  state(): HarnessSessionState {
    return {};
  }

  async complete(context: HarnessRunContext): Promise<void> {
    const graph = new RelayerGraphClient(context.graph.acquireCapability());
    context.trace.emit({ type: "prompt", data: { text: renderInteractionInput(context.interactionInput), kind: "fixture-input" } });
    await cp(artifactViewerFixtureFolder(), this.context.workingDirectory, { recursive: true, force: true });
    // ART-005: each artifact layer's advisory preview. Evidence runs may keep the images.
    const previews: { key: string; status: string; width: number | undefined; height: number | undefined }[] = [];
    const previewEvidence = process.env.RELAYER_ARTIFACT_PREVIEW_DIR;
    if (previewEvidence) await mkdir(previewEvidence, { recursive: true });
    const groups: { node: NodeObject; group: Group }[] = [];
    for (const group of ARTIFACT_VIEWER_FIXTURE_GROUPS) {
      const node = new NodeObject(group.icon, group.title, group.detail, "concept", group.key);
      await graph.submitNode(node);
      groups.push({ node, group });
    }
    const [hub, ...rest] = groups;
    const edges: EdgeObject[] = [];
    for (const { node, group } of rest) {
      const edge = new EdgeObject([hub!.node, node], `${hub!.group.key}-${group.key}`);
      await graph.createEdge(edge);
      edges.push(edge);
    }
    const spots = [[0.5, 0.2], [0.2, 0.75], [0.4, 0.85], [0.6, 0.85], [0.8, 0.75]] as const;
    const root = new LayerObject(
      groups.map(({ node }) => node),
      edges,
      new LayerLayoutObject(groups.map(({ node }, index) => new NodePlacementObject(node, spots[index]![0], spots[index]![1])), "arc-outward"),
      "launch-kit",
      hub!.node,
    );
    await graph.submitLayer(root);
    for (const { node, group } of groups) {
      for (const view of group.views) {
        const artifactNode = new NodeObject(view.icon, view.title, view.detail, "artifact", view.key);
        artifactNode.artifact = view.artifact;
        await graph.submitNode(artifactNode);
        const layer = LayerObject.forArtifact(artifactNode, `${view.key}-viewer`);
        const submitted = await graph.submitLayer(layer);
        previews.push({ key: view.key, status: submitted.preview?.status ?? "none", width: submitted.preview?.width, height: submitted.preview?.height });
        if (previewEvidence && submitted.preview?.path) await copyFile(submitted.preview.path, join(previewEvidence, `${view.key}.png`));
        await graph.addAction(node, { kind: "navigate", relation: "expand", sourceLayer: root, label: view.label, target: layer, variant: "pill", clientKey: `open-${view.key}` });
      }
    }
    // Polish the site after its node was submitted: acceptance must pin this version (ART-004).
    await appendFile(join(this.context.workingDirectory, "site", "styles.css"), "\n/* polished before finishing */\n");
    await graph.addAction(context.inputGraph.id, { kind: "navigate", relation: "expand", label: "Launch kit", icon: "rocket", target: root, clientKey: "response" });
    await graph.submit(context.inputGraph.id);
    if (previewEvidence) await writeFile(join(previewEvidence, "previews.json"), JSON.stringify(previews, null, 2));
    context.trace.emit({ type: "message", data: { role: "assistant", text: "Built the launch kit and opened each artifact in the viewer." } });
  }
}

export const artifactViewerFixtureFactory: HarnessFactory = (context) => new ArtifactViewerFixtureHarness(context);
