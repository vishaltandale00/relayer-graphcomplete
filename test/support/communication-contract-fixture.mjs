import { assetRef, detailCapability, html } from "@relayer/graph-client";

// Accepted context with a real retained source-layer control and optional pinned rich detail.
export async function seedCommunicationSource(graph, rich, withAsset = rich) {
  const author = graph.authoring("attached-source");
  const layer = author.layer("source");
  const evidenceLayer = author.layer("evidence");
  const node = layer.node("source", { icon: "info", title: "Saved evidence", detail: "Keep this accepted evidence and its existing navigation." });
  const evidence = evidenceLayer.node("evidence", { icon: "info", title: "Original evidence", detail: "Evidence behind the saved finding." });
  const action = layer.action("evidence", node, { kind: "navigate", relation: "expand", label: "Original evidence", target: evidenceLayer });
  let asset;
  if (withAsset) {
    const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#2563eb"/></svg>');
    asset = await graph.visualAssets.add({ scope: await graph.visualAssets.scope(), name: "Saved evidence image", file: { name: "evidence.svg", mediaType: "image/svg+xml", async read() { return bytes; } } });
  }
  if (rich) {
    node.detailAuthoring.setComponent("saved", asset ? html`<article><h2>Saved evidence</h2><p>Keep this explanation.</p><img alt="Saved evidence" asset=${assetRef(asset.id)}><button gc=${detailCapability.expand("saved-evidence", action)}>Original evidence</button></article>` : html`<article><h2>Saved evidence</h2><p>Keep this explanation.</p><button gc=${detailCapability.expand("saved-evidence", action)}>Original evidence</button></article>`);
  }
  layer.layout([[node, .5, .5]], { edgeShape: "default", defaultNode: node });
  evidenceLayer.layout([[evidence, .5, .5]], { edgeShape: "default", defaultNode: evidence });
  const written = await author.write(layer);
  await graph.addAction(graph.capability.nodeId, { kind: "navigate", relation: "expand", label: "Saved evidence", target: written.rootLayer, clientKey: "root-response" });
  const accepted = await graph.submit();
  return { nodeId: node.ref.id, layerId: written.rootLayer.id, interactionNodeId: graph.capability.nodeId, accepted: accepted.rootLayer };
}
