# relayer-graph Python client

A dependency-free asynchronous client for the GraphComplete Rust graph service.

```python
from relayer_graph import (
    EdgeObject, LayerLayoutObject, LayerObject, NodeObject,
    NodePlacementObject, RelayerGraphClient,
)

async with RelayerGraphClient.from_env() as graph:
    intro = NodeObject("book", "Introduction", "Useful markdown detail")
    detail = NodeObject("code", "Implementation", "How the concept works")
    await graph.submit_node(intro)
    await graph.submit_node(detail)
    connection = EdgeObject((intro, detail))
    await graph.create_edge(connection)
    layout = LayerLayoutObject((
        NodePlacementObject(intro, 0.25, 0.5),
        NodePlacementObject(detail, 0.75, 0.5),
    ))
    layer = LayerObject((intro, detail), (connection,), layout)
    await graph.submit_layer(layer)
    await graph.add_navigate_action(
        graph.node_id,
        "Response",
        layer,
        relation="expand",
        client_key="response",
    )
    output = await graph.submit()
```

Configuration is read from `RELAYER_GRAPH_URL`, `RELAYER_GRAPH_TOKEN`, and
`RELAYER_NODE_ID`. The client uses only Python's standard library.

Inside a Prime Agent IPython run, acquire the current call's host-owned scope instead:

```python
from relayer_graph import GraphSession

graph = await GraphSession.current()
```

`GraphSession.current()` uses Prime Agent's typed `rlm.host_request` bridge. The
credential is selected by the host-side run context, so Python cannot request a
different interaction by supplying an ID or token.
The returned client is intentionally not serializable, so Prime Agent's kernel
snapshot skips it instead of persisting an expired graph credential.

Every newly submitted layer requires a version-1 layout with exactly one
normalized placement per member node. Coordinates range from `0` through `1`
and express semantic relative position, independent of the viewport. Accepted
layers created before layouts were introduced remain readable with `layout=None`.
