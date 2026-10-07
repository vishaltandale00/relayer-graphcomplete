// Artifact layers (PRD 6.6, 11.11). Written once for every harness;
// python/relayer-graph/SKILL.md mirrors it.

const SHARED = `Kinds: "website" (an entry .html file plus its site root folder), "pdf", "video" (.mp4, .webm, .mov), "image" (.png, .jpg, .gif, .webp, .svg), "markdown" (.md), and "url" (https, or http only on localhost). File paths are relative to the thread folder and must stay inside it. A part opens the artifact at one place: a route for websites and URLs ("/pricing", "#/cart"), a page for PDFs (from 1), start and end seconds for a video segment, or a heading for Markdown. A viewport ("desktop", "tablet", "phone") applies to websites and URLs only. Show two views of one artifact as two artifact nodes, each in its own artifact layer. An artifact layer holds exactly that one node and no edges; never put an artifact node in a graph layer. Relayer fingerprints the files when you submit the node and again when your answer is accepted. A web app you can run, such as a dev server, is kind "app": source.url is its loopback address (http://127.0.0.1:5173/), and server names the command that starts it in the thread folder: { command: "npm run dev", readyUrl: "http://127.0.0.1:5173/" (optional, defaults to source.url), idleTimeoutMinutes: 60 (optional) }. When the user opens it, Relayer reuses a server that already answers, or runs the command after the user approves it once per thread, so you need not leave a server running. A website or web app may set a starting state that Relayer applies on every open: seed: { localStorage: { "cart": "[]" } }, and for web apps also cookies: [{ name: "session", value: "demo-user" }]. Seeds hold test values only, never real credentials or personal data. The node's title names the artifact; its detail says what it is and what to look at. Make artifact layers only for things the user should look at, not for every file you touched.`;

export const ARTIFACT_LAYER_GUIDANCE = `Artifacts: when your work produced something the user should see as itself, such as a website, a PDF, a video, an image or a Markdown document in the thread folder, or a deployed site, give it an artifact layer. Relayer opens that layer full screen in its artifact viewer instead of a graph. Create the files first, then author the artifact node and its layer, and open the layer from an ordinary node with a navigate action:
const site = new NodeObject("globe", "Landing page", "The launch site. Check the pricing section on a phone.", "concept", "landing-page");
site.artifact = { kind: "website", source: { file: "site/index.html", root: "site" }, part: { route: "#pricing" }, viewport: "phone" };
await graph.submitNode(site);
const siteViewer = LayerObject.forArtifact(site, "landing-page-viewer");
await graph.submitLayer(siteViewer);
await graph.addAction(overviewNode, { kind: "navigate", relation: "expand", sourceLayer: rootLayer, label: "Open the site", target: siteViewer, variant: "pill", clientKey: "open-landing-page" });
${SHARED}`;

export const ARTIFACT_LAYER_GUIDANCE_PYTHON = `Artifacts: when your work produced something the user should see as itself, such as a website, a PDF, a video, an image or a Markdown document in the thread folder, or a deployed site, give it an artifact layer. Relayer opens that layer full screen in its artifact viewer instead of a graph. Create the files first, then author the artifact node and its layer, and open the layer from an ordinary node with a navigate action:
site = NodeObject("globe", "Landing page", "The launch site. Check the pricing section on a phone.", client_key="landing-page")
site.artifact = {"kind": "website", "source": {"file": "site/index.html", "root": "site"}, "part": {"route": "#pricing"}, "viewport": "phone"}
await graph.submit_node(site)
site_viewer = LayerObject.for_artifact(site, "landing-page-viewer")
await graph.submit_layer(site_viewer)
await graph.add_navigate_action(overview_node, "Open the site", site_viewer, relation="expand", source_layer=root_layer, client_key="open-landing-page")
${SHARED}`;
