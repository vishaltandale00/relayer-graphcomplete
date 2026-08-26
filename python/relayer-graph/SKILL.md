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
))
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

Reuse stable prior node IDs returned by `get_node` or `get_neighbors`. A model turn is complete only after `submit(node_id)` succeeds.

Use `await client.discard_layer(layer)` only to recover from submission guidance
that identifies a genuinely abandoned orphan draft layer. Discard preserves the
layer as terminal stopped history and does not cascade to its nodes, edges,
actions, or child layers. Do not invent navigation merely to make abandoned
drafts reachable.
