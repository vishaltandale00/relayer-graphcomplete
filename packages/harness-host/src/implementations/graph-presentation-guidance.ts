import { detailAuthoringReference } from "@relayer/graph-client";

export const NODE_ICON_GUIDANCE = `Choose recognizable icons for the subject using agent judgment. Familiar supported symbol strings remain valid without lookup. Discover symbols or registered images with graph.icons.discover({query, kind: "both", limit: 12}) in JavaScript or await graph.icons.discover(query, kind="both", limit=12) in Python. Filter kind with symbols/images/both; copy a returned item's icon into a node or action. Results are compact, bounded catalog metadata, separate from conversation Content. Optional graph.icons.inspect([item.icon], {contactSheet: true}) / await graph.icons.inspect([item["icon"]], contact_sheet=True) returns preview files or a small numbered contact sheet; native image inspection depends on the harness/model. Use meaningful symbols when communicative and sourced image assets for recognizable organisms, objects, logos, or other subjects. Register image bytes through visualAssets.add / visual_assets.add with name, description, and tags, then use {kind: "image", assetId: asset.id}; accepted output pins registered bytes. Image icons default to contain and preserve transparency; optionally set fit: "cover" and framing: "none" | "circle" | "rounded". Signal symbols describe status, warnings, confirmations, or pointers rather than the node's subject. Static Node Detail images use imageIconDetail(icon) / image_icon_detail(icon), or existing assetRef bindings. For a static bundled symbol, await symbolIconDetail(graph, "waves") / await symbol_icon_detail(graph, "waves") registers its pinned SVG preview in the current scope and returns the same ordinary image component. Pass the returned html and css to the node Detail builder.`;

export const GRAPH_PRESENTATION_GUIDANCE = `Graph presentation guidance:
Available presentation capabilities: authored HTML/CSS can express layout, diagrams, comparisons, and other visual explanations without image files. Graph actions provide navigation and supported controls. The visual-assets API can discover, register, and bind images when needed. Asset inspection resolves metadata and preview files; seeing those files requires the selected harness and model to support native image inspection. Use the language-specific public API recipes below.
- Give every interaction's root response action a concise task-specific label and a supported catalog icon, including follow-ups and annotation-only or input-only interactions. These present the interaction's response in the breadcrumb. Choose them from the task and supplied context even when the root message is empty; avoid generic labels such as "Layer", "Response", or "Answer". Set label and icon when authoring the root navigate action, before advancing current or final submission. Do not edit the canonical interaction node or its input text.
- Each layer should explain its scope as a coherent whole. The root layer should let the user understand the overall problem or task, the material work or logic, and the result, evidence, or limitations that matter. A child layer should do the same for the narrower scope it owns.
- Choose "expand" when another layer should deepen one part of the current explanation. Each expansion should add a useful level of detail rather than merely restating its parent.
- Choose "reference" for supporting evidence or reusable context that helps the current explanation but is not part of its decomposition. A layer reached as a reference may author only further reference actions; it must not author expand or invoke actions.
- Choose "invoke" when the useful next step requires a new agent interaction. Do not use invoke as a substitute for explanation that belongs in the current graph.
- Choose "input" when the user should provide a bounded text, single-select, or multi-select value for their next ordinary interaction. Input is optional authored UI, not an invoke, navigation target, required field, or independent task. Use stable option keys and concise prompts; do not add one to every node.
- In this presentation-choice guidance only, choosing "stop" means leaving the node without a further action because expand, reference, and invoke would not materially improve understanding or help the user proceed. It is not GraphComplete's stopped lifecycle state and does not stop the interaction: you must still finish the response with a successful graph.submit call.`;

export const CURRENT_WORKSPACE_GUIDANCE = `You may be working in a graph with other live agents. Treat the graph as a live, user-facing workspace rather than only a final response format. Your current pointer communicates where your work presently stands before completion; advance it when the first useful finding or consequential question is ready, then when the user would gain a materially more useful view. Advancing current does not complete the interaction. Final graph submission completes it. The graph is the user's interface: write every node about the user's task, such as findings, decisions, open questions, and progress in the task's own terms. Never expose execution mechanics in graph content, such as layers or layer numbers, revisions, pointers, completions, child agents, or internal identifiers.
Publication contract: construct nodes, layers, and actions with stable client keys. Bind detail controls to the same action objects and exact containing source layer before checkpointing details. Submit nodes, edges, and layers, then register ALL actions for the closure, including the interaction root expand action. Only after those writes may you advance current to the root layer. Do not advance child layers before connecting them. Advancing current accepts the published closure. It is not a draft preview. Accepted node identity, title, semantic text, layer topology, and existing actions remain immutable. Reuse alone grants no action authority. Only an exact frozen attached-node navigation grant permits the exception: stage new navigate actions and any supported full presentation replacement for that attached node, preserving existing controls. Only terminal submission publishes these additions and replacements; Advance never does. Otherwise author new records for changed content while preserving access to prior current. A fresh object with the same key can repair a draft, but cannot edit an accepted record. Publish useful working state before the work finishes; final graph.submit remains required. Do not fabricate findings or publish empty status merely to advance.
Public visual authoring reference (generated from the compiler; no source inspection needed): ${JSON.stringify(detailAuthoringReference())}
${NODE_ICON_GUIDANCE}
Use CSS custom properties and the listed properties/functions; allowed names still have value and selector validation. Inline SVG, canvas, scripts, event handlers, arbitrary data attributes, raw URL attributes, background images, and gradients are unsupported. Use HTML/CSS shapes or registered image assets. Bind asset and control attributes through the public template API, not strings. Runtime control state comes from graph actions, not authored attributes: runtimeOwnedAttributes are prohibited even if also listed for an element. Checkpoint errors identify the component and rejected construct; repair that specific draft before publication.
Theme authoring: design readable light AND dark presentations in the same saved detail. Relayer owns the active theme; select it with [data-relayer-theme="light"] and [data-relayer-theme="dark"] in component CSS. The marker is on a runtime-owned inner scope, inside the protected detail host. For example, [data-relayer-theme="light"] .explanation { color: #182c34; background-color: #fafbf9; } and [data-relayer-theme="dark"] .explanation { color: #edf2f3; background-color: #121619; }. Relayer light uses pale neutral surfaces and dark text; dark uses charcoal surfaces and light text. These palette examples are guidance, not mandatory colors or a layout recipe. You control styling, layout, and visual composition. Cover text, surfaces, borders, chart marks and labels, controls, hover and keyboard focus with suitable contrast. Preserve meaning across modes, including semantic chart colors. Theme switching happens without generation or replacing controls. Keep each input/action on its existing stable capability mount and reposition/restyle it as needed; do not create duplicate inputs for the two themes. For different illustrations or static compositions, bind both variants as ordinary assets/content, give each a class, and use the theme selectors with display rules to show the matching variant. Share an asset across themes when it works in both. The theme marker is host-owned: do not author it into HTML or use operating-system prefers-color-scheme as the product theme. Missing theme-specific styles render the same authored presentation in both modes; they are not rejected or automatically recolored.`;

/** Mechanics only: presentation and graph decomposition remain model decisions. */
export function scopedAuthoringRecipeJs(interactionNodeId: number, clientModuleUrl: string): string {
  return `Use graph.authoring(snapshotKey) for new response drafts, with named node fields. Keep the snapshot and local keys stable when repairing a rejected draft; choose a new snapshot for a new accepted response. The writer handles dependency order and scoped client keys. It persists drafts; root attachment and acceptance remain explicit. Consult the compiler-generated Node Detail reference above before styling and after a CSS rejection; detailAuthoringReference() returns the same structured reference. Give graph-authoring native children this recipe and the exact supplied import URL.
The following runnable example demonstrates mechanics only. Replace its content and choose the topology, layout and controls for the task.

\`\`\`javascript
import { RelayerGraphClient, html, css, detailCapability, detailAuthoringReference } from ${JSON.stringify(clientModuleUrl)};
const graph = RelayerGraphClient.fromEnv();
// Inspect detailAuthoringReference() when consulting the compiler constraints.
const author = graph.authoring("response-v1");
const layer = author.layer("answer");
const childLayer = author.layer("details");
const node = layer.node("finding", { icon: "info", title: "Answer", detail: "Replace with the supported answer." });
const child = childLayer.node("detail", { icon: "info", title: "Details", detail: "Replace with useful depth." });
// Declare the action before binding it. The scoped API supplies identity and source layer.
const expand = layer.action("details", node, { kind: "navigate", relation: "expand", label: "Details", target: childLayer });
const sharedStyles = css\`section { display: grid; gap: 0.75rem; background-color: transparent; }\`;
node.detailAuthoring.setComponent("main", html\`<section><h2>Answer</h2><p>Replace with the supported answer.</p><button gc=\${detailCapability.expand("details-control", expand)}>Details</button></section>\`, sharedStyles);
child.detailAuthoring.setComponent("main", html\`<section><h2>Supporting evidence</h2><p>Explain the evidence behind the answer.</p></section>\`, sharedStyles);
layer.layout([[node, 0.5, 0.5]], { edgeShape: "default", defaultNode: node });
childLayer.layout([[child, 0.5, 0.5]], { edgeShape: "default", defaultNode: child });
const written = await author.write(layer);
await graph.addAction(${interactionNodeId}, { kind: "navigate", relation: "expand", label: "Answer", target: written.rootLayer, clientKey: "root-response" });
await graph.submit(${interactionNodeId});
\`\`\`
Add a connection with layer.edge("connection", first, second). Declare node controls before write with layer.action("details", node, { kind: "navigate", relation: "expand", label: "Details", target: childLayer }); bind that same returned action with detailCapability.expand("stable-control-key", action) in an unquoted gc= template interpolation, as shown above. The key and action are both required. For references use relation: "reference" and detailCapability.reference; for follow-ups use kind: "invoke", interactionText, and detailCapability.invoke. layer.node(localKey, fields) accepts only icon, title, detail, and optional kind and artifact (use artifactNode for artifact layers): do not pass clientKey or ref in fields. layer.action(localKey, sourceNode, fields) supplies sourceLayer, clientKey, and ref: do not author these fields. Declare actions before binding them, and reuse the returned action without cloning or adding identity fields. Set each selected layer's layout explicitly, including routes or sizeJustification when needed, with layer.layout(...); written.rootLayer is available only after author.write(...), and has no .layer wrapper. For specialized low-level calls, layer.object is the actual LayerObject. For an artifact layer (see the Artifacts guidance), give it its own scoped layer: const viewer = author.layer("site-viewer"); viewer.artifactNode("site", { icon: "globe", title, detail, artifact: { kind: "website", source: { file: "site/index.html", root: "site" } } }). artifactNode declares that layer's only node and sets its artifact renderer, centered layout and default node; add no other nodes or edges to it and do not call viewer.layout. Open it from an ordinary node with layer.action("open-site", node, { kind: "navigate", relation: "expand", label: "Open the site", target: viewer }). Accepted-node additions and replacements still use their existing authorized low-level APIs and presentation revisions.`;
}

export function scopedAuthoringRecipePython(interactionNodeId: number): string {
  return `Use graph.authoring(snapshot_key) for new response drafts with named fields. Keep snapshot and local keys stable for rejected-draft repair. Choose a new snapshot for a new accepted response. Give graph-authoring RLM children this recipe. The writer persists drafts; root attachment and acceptance remain explicit.
Before styling and after a CSS rejection, consult the compiler-generated Node Detail reference in Graph presentation guidance above. CSS uses complete rules with braces and the listed allowed properties.
This runnable example demonstrates mechanics only; its placeholder content and layout are not a recommended response design. Choose content, topology, layout and controls for the task.

\`\`\`python
from relayer_graph import GraphSession, html, action_capability
graph = await GraphSession.current()
author = graph.authoring("response-v1")
layer = author.layer("answer")
child_layer = author.layer("details")
node = layer.node("finding", icon="info", title="Answer", detail="Replace with the supported answer.")
child = child_layer.node("detail", icon="info", title="Details", detail="Replace with useful depth.")
expand = layer.action("details", node, kind="navigate", relation="expand", label="Details", target=child_layer)
shared_styles = "section { display: grid; gap: 0.75rem; background-color: transparent; }"
node.detail_authoring.set_component("main", html(["<section><h2>Answer</h2><p>Replace with the supported answer.</p><button gc=", ">Details</button></section>"], action_capability("details-control", expand)), shared_styles)
child.detail_authoring.set_component("main", html("<section><h2>Supporting evidence</h2><p>Explain the evidence behind the answer.</p></section>"), shared_styles)
layer.layout([(node, 0.5, 0.5)], edge_shape="default", default_node=node)
child_layer.layout([(child, 0.5, 0.5)], edge_shape="default", default_node=child)
written = await author.write(layer)
await graph.add_navigate_action(${interactionNodeId}, "Answer", written.root_layer, relation="expand", client_key="root-response")
await graph.submit(${interactionNodeId})
\`\`\`
Add connections with layer.edge("connection", first, second). Declare controls before write with layer.action("details", node, kind="navigate", relation="expand", label="Details", target=child_layer), then bind that same returned action with action_capability. Use relation="reference" for evidence and kind="invoke", interaction_text="..." for follow-ups. Node fields are icon, title, detail, and optional kind and artifact (use artifact_node for artifact layers); do not supply client_key or ref. The scoped API supplies action source_layer and identity; do not pass source_layer, client_key, or ref into layer.action. Declare actions before binding them. Set every selected layer's layout explicitly. layer.object exposes the actual LayerObject for specialized operations. For an artifact layer (see the Artifacts guidance), give it its own scoped layer: viewer = author.layer("site-viewer"); viewer.artifact_node("site", icon="globe", title=..., detail=..., artifact={"kind": "website", "source": {"file": "site/index.html", "root": "site"}}). artifact_node declares that layer's only node and sets its artifact renderer, centered layout and default node; add no other nodes or edges to it and do not call viewer.layout. Open it from an ordinary node with layer.action("open-site", node, kind="navigate", relation="expand", label="Open the site", target=viewer). Accepted-node additions and presentation replacement retain their existing grants and revisions.`;
}

export const CURRENT_COMMUNICATION_GUIDANCE_JS = "Your current layer is how you explain the work to the user while doing it. Once you have a useful finding, uncertainty, or question, publish it with graph.advanceCurrent and continue working. Update it when the user's understanding materially changes. When you call a subcompletion through complete(inputGraph), observe its current-pointer updates and read the graph they expose. Incorporate meaningful findings into your own current layer. Use current layers to ask consequential questions as they arise. Explain what decision depends on the answer and provide an appropriate input action.\nSubcompletion guidance applies only when the completion broker is available and you choose semantic child work; native helpers are not separate GraphComplete completions. When using that broker, create watchCompletions(children), await watch.changes(), and read each changed current.currentLayerId with graph.getLayer when it is non-null. Read the published evidence, not only its revision or terminal status. Missing current or observation errors mean unknown work, not invented findings. Questions may be published during work, but input answers arrive through the next ordinary interaction, not an automatic resume of this running completion. Do independent work, then return a useful question layer if dependent work needs that answer; do not wait indefinitely or assume an answer.";

/** The same communication contract expressed through Prime's supported Python APIs. */
export const CURRENT_COMMUNICATION_GUIDANCE_PYTHON = CURRENT_COMMUNICATION_GUIDANCE_JS
  .replaceAll("graph.advanceCurrent", "graph.advance_current")
  .replaceAll("complete(inputGraph)", "complete(input_graph)")
  .replaceAll("watchCompletions(children)", "CompletionWatch(children)")
  .replaceAll("current.currentLayerId", "current.current_layer_id")
  .replaceAll("graph.getLayer", "graph.get_layer")
  .replace("Read the published evidence", "Each change is a (child, current) pair; skip Exception values before reading current.current_layer_id. Read the published evidence");

export function currentCommunicationAuthoringRecipeJs(interactionNodeId: number, clientModuleUrl: string): string {
  return `Use graph.authoring(snapshotKey) for new response drafts with stable local keys. Give graph-authoring native children this recipe and the exact supplied import URL. Choose new snapshots for new accepted explanations. This runnable example shows early publication, further work, and final submission. Replace its placeholder evidence with actual task findings; do not publish an empty progress message.

\`\`\`javascript
import { RelayerGraphClient, GraphApiError, NodeObject, html, css, detailCapability } from ${JSON.stringify(clientModuleUrl)};
const graph = RelayerGraphClient.fromEnv();
let current;
try { current = await graph.getCurrent(); }
catch (error) {
  if (!(error instanceof GraphApiError) || error.code !== "feature_disabled") throw error;
  current = null; // Supported all-off compatibility mode: submit the final graph directly.
}
const contract = await graph.getContract();
async function stageResponseLinks(responseLayer) {
  for (const requirement of contract?.returnRequirements ?? []) {
    if (requirement.kind !== "navigate.response") throw new Error("Unsupported Return requirement");
    const snapshot = await graph.getNodePresentation(requirement.nodeId);
    const addition = { kind: "navigate", relation: "reference", label: "Task findings", target: responseLayer, clientKey: "response-${interactionNodeId}-" + requirement.nodeId };
    await graph.addAction(requirement.nodeId, addition);
    if (snapshot.node.authoredDetail) {
      const prior = snapshot.node;
      const additions = new NodeObject(prior.icon, prior.title, prior.detail, prior.kind, prior.clientKey);
      additions.detailAuthoring.setComponent("response-${interactionNodeId}", html\`<button gc=\${detailCapability.reference("response-control", addition)}>Task findings</button>\`);
      // The typed extension retains all accepted components, assets and control provenance.
      await graph.extendNodePresentation(requirement.nodeId, snapshot.revision, additions);
    }
  }
}
const author = graph.authoring("first-finding-${interactionNodeId}");
const layer = author.layer("finding");
const sharedStyles = css\`section { display: grid; gap: 0.75rem; background-color: transparent; }\`;
// The current closure preserves prior publications even after later Advances.
// Completion-specific keys avoid matching another interaction's accepted findings.
const pending = current?.currentLayerId == null ? [] : [current.currentLayerId];
const visited = new Set();
let firstPublished = false;
while (pending.length > 0) {
  const id = pending.pop();
  if (visited.has(id)) continue;
  visited.add(id);
  const published = await graph.getLayer(id);
  if (published.layer.state !== "accepted") throw new Error("Current history must be accepted");
  if (published.layer.clientKey === layer.object.clientKey) { firstPublished = true; break; }
  for (const action of published.actions) {
    if (action.kind === "navigate" && action.targetLayerId != null) pending.push(action.targetLayerId);
  }
}
// Skip every write in the committed phase; repair only the remaining drafts.
if (current !== null && !firstPublished) {
  const finding = layer.node("finding", { icon: "info", title: "Initial finding", detail: "Replace with supported evidence, remaining uncertainty, and the next useful step." });
  // This optional detail example demonstrates typed control binding, not required topology.
  const evidenceLayer = author.layer("evidence");
  const evidence = evidenceLayer.node("evidence", { icon: "info", title: "Evidence", detail: "Replace with useful support for the finding." });
  const expand = layer.action("evidence", finding, { kind: "navigate", relation: "expand", label: "Evidence", target: evidenceLayer });
  finding.detailAuthoring.setComponent("main", html\`<section><h2>Initial finding</h2><p>Replace with supported evidence and uncertainty.</p><button gc=\${detailCapability.expand("evidence-control", expand)}>Evidence</button></section>\`, sharedStyles);
  evidence.detailAuthoring.setComponent("main", html\`<section><h2>Evidence</h2><p>Replace with useful supporting detail.</p></section>\`, sharedStyles);
  evidenceLayer.layout([[evidence, 0.5, 0.5]], { edgeShape: "default", defaultNode: evidence });
  if (current.currentLayerId != null) {
    const prior = await graph.getLayer(current.currentLayerId);
    const earlier = layer.action("prior", finding, { kind: "navigate", relation: "reference", label: "Earlier findings", target: prior.layer });
    finding.detailAuthoring.setComponent("earlier", html\`<button gc=\${detailCapability.reference("earlier-control", earlier)}>Earlier findings</button>\`, sharedStyles);
  }
  layer.layout([[finding, 0.5, 0.5]], { edgeShape: "default", defaultNode: finding });
  const written = await author.write(layer);
  await graph.addAction(${interactionNodeId}, { kind: "navigate", relation: "expand", label: "Task findings", icon: "info", target: written.rootLayer, clientKey: "root-response" });
  await stageResponseLinks(written.rootLayer);
  await graph.advanceCurrent(written.rootLayer, current.headRevision, "first-finding-publication");
}
// Continue the underlying work. Read evidence and observe any semantic children.
// Publish further material findings or questions as new snapshots, preserving prior current.
if (current !== null) current = await graph.getCurrent();
const finalAuthor = graph.authoring("final-findings");
const finalLayer = finalAuthor.layer("summary");
const summary = finalLayer.node("summary", { icon: "info", title: "Result", detail: "Replace with the completed result or the consequential question requiring the user's answer." });
summary.detailAuthoring.setComponent("main", html\`<section><h2>Result</h2><p>Replace with the completed result or consequential question.</p></section>\`, sharedStyles);
if (current?.currentLayerId != null) {
  const prior = await graph.getLayer(current.currentLayerId);
  const earlier = finalLayer.action("prior", summary, { kind: "navigate", relation: "reference", label: "Earlier findings", target: prior.layer });
  summary.detailAuthoring.setComponent("main", html\`<section><h2>Result</h2><p>Replace with the completed result or consequential question.</p><button gc=\${detailCapability.reference("earlier-control", earlier)}>Earlier findings</button></section>\`, sharedStyles);
}
finalLayer.layout([[summary, 0.5, 0.5]], { edgeShape: "default", defaultNode: summary });
const finalWritten = await finalAuthor.write(finalLayer);
// Advance leaves the interaction's root response action draft; retarget that same stable action.
await graph.addAction(${interactionNodeId}, { kind: "navigate", relation: "expand", label: "Task findings", icon: "info", target: finalWritten.rootLayer, clientKey: "root-response" });
await stageResponseLinks(finalWritten.rootLayer);
await graph.submit(${interactionNodeId});
\`\`\`
Add a connection with layer.edge("connection", first, second). Declare node controls before write with layer.action("details", node, { kind: "navigate", relation: "expand", label: "Details", target: childLayer }); bind that same returned action with detailCapability.expand("stable-control-key", action) in an unquoted gc= template interpolation, as shown above. The key and action are both required. For references use relation: "reference" and detailCapability.reference; for follow-ups use kind: "invoke", interactionText, and detailCapability.invoke. layer.node(localKey, fields) accepts only icon, title, detail, and optional kind: do not pass clientKey or ref in fields. layer.action(localKey, sourceNode, fields) supplies sourceLayer, clientKey, and ref: do not author these fields. Declare actions before binding them, and reuse the returned action without cloning or adding identity fields. Set each selected layer's layout explicitly, including routes or sizeJustification when needed, with layer.layout(...); written.rootLayer is available only after author.write(...), and has no .layer wrapper. For specialized low-level calls, layer.object is the actual LayerObject. Accepted-node additions and replacements still use their existing authorized low-level APIs and presentation revisions.
The example reads the sealed contract and stages every required attached-node link to each exact candidate response root, including the final retarget. For rich accepted nodes, the typed presentation extension preserves existing components, assets and controls while compiling the new control. Advance validates these staged changes but only Return publishes them. Use unique component/control keys; stale revisions and extension conflicts require rereading or an explicit full replacement, never dropping existing content. The example probes current before writing. Only a typed feature_disabled rejection selects the submit-only compatibility path. Other errors propagate. On rerun while active, the completion-specific first-layer key in the reachable current closure identifies an already published phase (including after later advances); skip its writes and Advance, then repair only the final drafts. Do not rerun after a successful or unknown terminal submission; terminal recovery belongs to trusted supervision.
For real content, use the same scoped action and detailCapability binding APIs as the ordinary authoring contract. Register every action before publication. Accepted nodes and layers stay immutable. Each later current must retain navigation to the exact prior current. Refresh getCurrent after each successful advance; save each transition's layer, expected headRevision and stable operation key for exact retries. When asking a question, author an input action on its draft explanation node with layer.action("question", finding, { kind: "input", label: "Answer", control: "text", prompt: "A task-specific question" }), or an appropriate select control. Publishing the question does not consume the user's answer. A terminal submit ends all graph access.`;
}

export function currentCommunicationAuthoringRecipePython(interactionNodeId: number): string {
  return `Use graph.authoring(snapshot_key) for new response drafts with named fields. Keep snapshot and local keys stable for rejected-draft repair. Choose new snapshots for new accepted explanations. Give graph-authoring RLM children this recipe. The writer persists drafts; root attachment and acceptance remain explicit.
Before styling and after a CSS rejection, consult the compiler-generated Node Detail reference above. This runnable example shows early publication, further work, and final submission. Replace placeholder evidence with actual task findings; do not publish an empty progress message. Its placeholder content and layout are not a recommended response design. Choose content, topology, layout and controls for the task. Its optional detail branch demonstrates control binding, not required topology.

\`\`\`python
from relayer_graph import GraphSession, GraphLayer, NodeObject, ActionObject, APIError, html, action_capability
graph = await GraphSession.current()
try:
    current = await graph.get_current()
except APIError as error:
    if not isinstance(error.details, dict) or error.details.get("error", {}).get("code") != "feature_disabled":
        raise
    current = None  # Supported all-off compatibility mode: submit the final graph directly.
contract = await graph.get_contract()
async def stage_response_links(response_layer):
    for requirement in contract.return_requirements if contract is not None else ():
        if requirement["kind"] != "navigate.response":
            raise RuntimeError("Unsupported Return requirement")
        node_id = requirement["nodeId"]
        snapshot = await graph.get_node_presentation(node_id)
        addition = ActionObject("navigate", "Task findings", None, "response-${interactionNodeId}-" + str(node_id), target=response_layer, relation="reference")
        await graph.add_action(node_id, addition)
        if snapshot["node"].get("authoredDetail") is not None:
            prior = snapshot["node"]
            additions = NodeObject(prior["icon"], prior["title"], prior["detail"], prior["kind"], client_key=prior["clientKey"])
            additions.detail_authoring.set_component("response-${interactionNodeId}", html(["<button gc=", ">Task findings</button>"], action_capability("response-control", addition)))
            # The typed extension retains accepted components, assets and control provenance.
            await graph.extend_node_presentation(node_id, snapshot["revision"], additions)
author = graph.authoring("first-finding-${interactionNodeId}")
layer = author.layer("finding")
shared_styles = "section { display: grid; gap: 0.75rem; background-color: transparent; }"
# Follow the retained closure, not only the latest current; scope the key to this completion.
pending = [current["currentLayerId"]] if current is not None and current["currentLayerId"] is not None else []
visited = set()
first_published = False
while pending:
    layer_id = pending.pop()
    if layer_id in visited:
        continue
    visited.add(layer_id)
    published = await graph.get_layer(layer_id)
    if published["layer"]["state"] != "accepted":
        raise RuntimeError("Current history must be accepted")
    if published["layer"].get("clientKey") == layer.object.client_key:
        first_published = True
        break
    pending.extend(action["targetLayerId"] for action in published["actions"] if action["kind"] == "navigate" and action.get("targetLayerId") is not None)
# Skip every write in the committed phase; repair only the remaining drafts.
if current is not None and not first_published:
    finding = layer.node("finding", icon="info", title="Initial finding", detail="Replace with supported evidence, remaining uncertainty, and the next useful step.")
    evidence_layer = author.layer("evidence")
    evidence = evidence_layer.node("evidence", icon="info", title="Evidence", detail="Replace with useful support for the finding.")
    expand = layer.action("evidence", finding, kind="navigate", relation="expand", label="Evidence", target=evidence_layer)
    finding.detail_authoring.set_component("main", html(["<section><h2>Initial finding</h2><p>Replace with supported evidence and uncertainty.</p><button gc=", ">Evidence</button></section>"], action_capability("evidence-control", expand)), shared_styles)
    evidence.detail_authoring.set_component("main", html("<section><h2>Evidence</h2><p>Replace with useful supporting detail.</p></section>"), shared_styles)
    evidence_layer.layout([(evidence, 0.5, 0.5)], edge_shape="default", default_node=evidence)
    if current["currentLayerId"] is not None:
        prior = await graph.get_layer(current["currentLayerId"])
        earlier = layer.action("prior", finding, kind="navigate", relation="reference", label="Earlier findings", target=GraphLayer.from_dict(prior["layer"]))
        finding.detail_authoring.set_component("earlier", html(["<button gc=", ">Earlier findings</button>"], action_capability("earlier-control", earlier)), shared_styles)
    layer.layout([(finding, 0.5, 0.5)], edge_shape="default", default_node=finding)
    written = await author.write(layer)
    await graph.add_navigate_action(${interactionNodeId}, "Task findings", written.root_layer, relation="expand", client_key="root-response", icon="info")
    await stage_response_links(written.root_layer)
    await graph.advance_current(written.root_layer, expected_revision=current["headRevision"], operation_key="first-finding-publication")
# Continue the underlying work. Read evidence and observe any semantic children.
# Publish further material findings or questions as new snapshots, preserving prior current.
if current is not None:
    current = await graph.get_current()
final_author = graph.authoring("final-findings")
final_layer = final_author.layer("summary")
summary = final_layer.node("summary", icon="info", title="Result", detail="Replace with the completed result or the consequential question requiring the user's answer.")
summary.detail_authoring.set_component("main", html("<section><h2>Result</h2><p>Replace with the completed result or consequential question.</p></section>"), shared_styles)
if current is not None and current["currentLayerId"] is not None:
    prior = await graph.get_layer(current["currentLayerId"])
    earlier = final_layer.action("prior", summary, kind="navigate", relation="reference", label="Earlier findings", target=GraphLayer.from_dict(prior["layer"]))
    summary.detail_authoring.set_component("main", html(["<section><h2>Result</h2><p>Replace with the completed result or consequential question.</p><button gc=", ">Earlier findings</button></section>"], action_capability("earlier-control", earlier)), shared_styles)
final_layer.layout([(summary, 0.5, 0.5)], edge_shape="default", default_node=summary)
final_written = await final_author.write(final_layer)
# Advance leaves the interaction's root response action draft; retarget that same stable action.
await graph.add_navigate_action(${interactionNodeId}, "Task findings", final_written.root_layer, relation="expand", client_key="root-response", icon="info")
await stage_response_links(final_written.root_layer)
await graph.submit(${interactionNodeId})
\`\`\`
Add connections with layer.edge("connection", first, second). Declare controls before write with layer.action("details", node, kind="navigate", relation="expand", label="Details", target=child_layer), then bind that same returned action with action_capability. Use relation="reference" for evidence and kind="invoke", interaction_text="..." for follow-ups. Node fields are icon, title, detail, and optional kind; do not supply client_key or ref. The scoped API supplies action source_layer and identity; do not pass source_layer, client_key, or ref into layer.action. Declare actions before binding them. Set every selected layer's layout explicitly. layer.object exposes the actual LayerObject for specialized operations. Accepted-node additions and presentation replacement retain their existing grants and revisions.
The example reads the sealed contract and stages every required attached-node link to each exact candidate response root, including the final retarget. For rich accepted nodes, the typed presentation extension preserves existing components, assets and controls while compiling the new control. Advance validates these staged changes but only Return publishes them. Use unique component/control keys; stale revisions and extension conflicts require rereading or an explicit full replacement, never dropping existing content. The example probes current before writing. Only a typed feature_disabled rejection selects the submit-only compatibility path. Other errors propagate. On rerun while active, the completion-specific first-layer key in the reachable current closure identifies an already published phase (including after later advances); skip its writes and Advance, then repair only the final drafts. Do not rerun after a successful or unknown terminal submission; terminal recovery belongs to trusted supervision.
Accepted nodes and layers stay immutable. Each later current must retain navigation to the exact prior current. get_current returns a mapping with currentLayerId and headRevision; CompletionWatch snapshots use current_layer_id and revision. Refresh get_current after each successful advance; save each transition's layer, expected headRevision and stable operation key for exact retries. When asking a question, author an input action on its draft explanation node with layer.action("question", finding, kind="input", label="Answer", control="text", prompt="A task-specific question"), or an appropriate select control. Publishing the question does not consume the user's answer. A terminal submit ends all graph access.`;
}
