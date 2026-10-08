---
name: relayer-graph
description: Author nodes, edges, layers, and actions in the GraphComplete Rust graph engine from Python or IPython.
license: Apache-2.0
---

# Relayer Graph

The current turn supplies a graph URL, capability token, and interaction-node ID. Construct the client explicitly or use `from_env()`:

```python
from relayer_graph import RelayerGraphClient
client = RelayerGraphClient(
    graph_url,
    graph_token,
    node_id,
)
```

Before authoring, call `await client.get_interaction_input()` to recover the
current message plus every attached target node and its ordered annotations.
Treat them as one input with no product-defined semantic precedence. Native
recursive children should use this same capability read instead of relying on
prompt text inherited from the root. Interaction context is graph-control-owned;
do not create, modify, or delete it.

Accepted response nodes may offer optional input actions for the user's next ordinary interaction.
Use `add_input_action` with `control="text"`, `"single_select"`, or `"multi_select"`.
Select controls use stable unique `(key, label)` options; multi-select may set
`minimum_selections`. Input actions do not invoke work and are not required on every node.

Create and submit reusable objects before referencing them:

```python
from relayer_graph import (
    EdgeObject, LayerLayoutObject, LayerObject, NodeObject, NodePlacementObject,
)

first = NodeObject("one", "First concept", "Useful markdown detail", client_key="first-concept")
second = NodeObject("two", "Second concept", "Useful markdown detail", client_key="second-concept")
await client.submit_node(first)
await client.submit_node(second)
edge = EdgeObject((first, second), client_key="first-second")
await client.create_edge(edge)
layout = LayerLayoutObject((
    NodePlacementObject(first, 0.25, 0.5),
    NodePlacementObject(second, 0.75, 0.5),
), "elbow-horizontal")
layer = LayerObject((first, second), (edge,), layout, client_key="response-layer")
await client.submit_layer(layer)
await client.add_navigate_action(
    node_id,
    "Response",
    layer,
    relation="expand",
    client_key="response",
)
await client.submit(node_id)
```

Every persisted node, edge, layer, and action uses an explicit deterministic
`client_key`; rerun the whole authoring program with the same keys after a
partial failure. The interaction root uses one `relation="expand"` navigate action without
`source_layer`. Every action authored from a response node includes the exact
`source_layer`. Layers with six to eight nodes also pass a private
`size_justification` to `submit_layer`; larger layers are rejected.

Every new layer has a version-1 `LayerLayoutObject` with exactly one
`NodePlacementObject` per layer node. Use normalized coordinates from `0`
through `1`; place a one-node layer at `(0.5, 0.5)`. Choose positions from the
meaning: keep flow or time consistent, anchor hierarchy, group related nodes,
align comparisons, and avoid accidental overlap or edge crossings. Coordinates
describe the accepted graph and must not depend on the current viewport.

<!-- Mirrors packages/harness-host/src/implementations/layer-edge-shape-guidance.ts. -->
Every layer layout also names the layer's edge shape, which draws all of its
edges: pass it as `LayerLayoutObject(placements, edge_shape, edge_routes=())`. Edges never show
a direction. Choose the shape from the layer's structure:

- "default": no strong structural reason; the design chooses.
- "arc-outward": a hub and its spokes, or loose relationships around a centre.
- "arc-circle": a cycle, or a ring of peers that each connect to their neighbours.
- "elbow-horizontal": a left-to-right pipeline or sequence of stages.
- "elbow-vertical": a top-down hierarchy or breakdown.
- "straight": comparisons, grids, or dense layers.

List the placements in reading order; keyboard and screen-reader users follow
that order. Position the nodes so they read in that order too, and for an elbow
shape run the reading order along its axis: left to right for
"elbow-horizontal", top to bottom for "elbow-vertical".

Edge routes are optional and most layers need none. Add a route only for an
edge the layer's shape would draw badly: a loop-back along a row of nodes, an
edge that skips a node, or one that would cross another node. A route may give
that one edge its own shape, the side of each of its two nodes where it attaches
("top", "right", "bottom", "left"), and up to 4 waypoints: layout coordinates
from 0 through 1 that the edge passes through, listed from the route's first end
to its second. Try sides first; for example, attach both ends of a loop-back at
"top" to arc it over the row. Pick sides that face where the edge goes. Add
waypoints only when sides are not enough. A
route's ends are just the edge's two nodes, not a direction.

<!-- Mirrors packages/harness-host/src/implementations/artifact-layer-guidance.ts. -->
Artifacts: when your work produced something the user should see as itself,
such as a website, a PDF, a video, an image, a Markdown or Office document in the
thread folder, or a deployed site, give it an artifact layer. Relayer opens that
layer full screen in its artifact viewer instead of a graph. Create the files
first, then author the artifact node and its layer, and open the layer from an
ordinary node with a navigate action:

```python
site = NodeObject("globe", "Landing page", "The launch site. Check the pricing section on a phone.", client_key="landing-page")
site.artifact = {"kind": "website", "source": {"file": "site/index.html", "root": "site"},
                 "part": {"route": "#pricing"}, "viewport": "phone"}
await graph.submit_node(site)
site_viewer = LayerObject.for_artifact(site, "landing-page-viewer")
await graph.submit_layer(site_viewer)
await graph.add_navigate_action(overview_node, "Open the site", site_viewer, relation="expand",
                                source_layer=root_layer, client_key="open-landing-page")
```

Kinds: "website" (an entry .html file plus its site root folder), "pdf",
"video" (.mp4, .webm, .mov), "image" (.png, .jpg, .gif, .webp, .svg),
"markdown" (.md), "docx", "xlsx" and "pptx" (Office), and "url" (https, or http
only on localhost). File paths are
relative to the thread folder and must stay inside it. A part opens the artifact
at one place: a route for websites, web apps and URLs, a page for PDFs (from 1), start and
end seconds for a video segment, a heading for Markdown, or a slide for a deck. A viewport
("desktop", "tablet", "phone") applies to websites, web apps and URLs only. Show two views
of one artifact as two artifact nodes, each in its own artifact layer. An
artifact layer holds exactly that one node and no edges; never put an artifact
node in a graph layer. Relayer fingerprints the files when you submit the node
and again when your answer is accepted. Make artifact layers only for things the
user should look at.

A web app you can run, such as a dev server, is kind "app": `source.url` is its
loopback address, and `server` names the command that starts it in the thread
folder. Relayer reuses a server that already answers, or runs the command after
the user approves it once per thread. A website or web app may set a starting
state that Relayer applies on every open; web apps may also seed cookies. Seeds
hold test values only, never real credentials or personal data.

Office documents are kind "docx" (Word), "xlsx" (Excel) or "pptx" (PowerPoint);
a deck can open at a slide (`"part": {"slide": 3}`, from 1). Save spreadsheets
with their calculated values, for example by recalculating in LibreOffice before
you finish, because Relayer shows saved values and never recalculates: formulas
without them render blank. Charts in a deck may draw wrongly, so export a PDF
next to any deck with charts and point the artifact at the PDF.

```python
app = NodeObject("server", "Order desk", "The running checkout app.", client_key="order-desk")
app.artifact = {"kind": "app", "source": {"url": "http://127.0.0.1:5173/"},
                "server": {"command": "npm run dev", "idleTimeoutMinutes": 60},
                "seed": {"localStorage": {"cart": "[]"}, "cookies": [{"name": "session", "value": "demo-user"}]}}
```

```python
from relayer_graph import EdgeEndObject, EdgeRouteObject

loop_back = EdgeRouteObject(
    feedback_edge,
    ends=(EdgeEndObject(last, "top"), EdgeEndObject(first, "top")),
    waypoints=((0.9, 0.1), (0.1, 0.1)),
)
layout = LayerLayoutObject(placements, "elbow-horizontal", (loop_back,))
```

Reuse stable prior node IDs returned by `get_node` or `get_neighbors`. A model turn is complete only after `submit(node_id)` succeeds.

Use `await client.discard_layer(layer)` only to recover from submission guidance
that identifies a genuinely abandoned orphan draft layer. Discard preserves the
layer as terminal stopped history and does not cascade to its nodes, edges,
actions, or child layers. Do not invent navigation merely to make abandoned
drafts reachable.
