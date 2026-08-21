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

Create and submit reusable objects before referencing them:

```python
from relayer_graph import EdgeObject, LayerObject, NodeObject

first = NodeObject("one", "First concept", "Useful markdown detail")
second = NodeObject("two", "Second concept", "Useful markdown detail")
await client.submit_node(first)
await client.submit_node(second)
edge = EdgeObject((first, second))
await client.create_edge(edge)
layer = LayerObject((first, second), (edge,))
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

The interaction root uses one `relation="expand"` navigate action without
`source_layer`. Every action authored from a response node includes the exact
`source_layer`. Layers with six to eight nodes also pass a private
`size_justification` to `submit_layer`; larger layers are rejected.

Reuse stable prior node IDs returned by `get_node` or `get_neighbors`. A model turn is complete only after `submit(node_id)` succeeds.
