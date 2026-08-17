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
await client.add_navigate_action(node_id, "Response", layer, response=True, client_key="response")
await client.submit(node_id)
```

Reuse stable prior node IDs returned by `get_node` or `get_neighbors`. A model turn is complete only after `submit(node_id)` succeeds.
