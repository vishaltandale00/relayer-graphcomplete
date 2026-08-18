# relayer-graph Python client

A dependency-free asynchronous client for the GraphComplete Rust graph service.

```python
from relayer_graph import EdgeObject, LayerObject, NodeObject, RelayerGraphClient

async with RelayerGraphClient.from_env() as graph:
    intro = NodeObject("book", "Introduction", "Useful markdown detail")
    detail = NodeObject("code", "Implementation", "How the concept works")
    await graph.submit_node(intro)
    await graph.submit_node(detail)
    connection = EdgeObject((intro, detail))
    await graph.create_edge(connection)
    layer = LayerObject((intro, detail), (connection,))
    await graph.submit_layer(layer)
    await graph.add_navigate_action(graph.node_id, "Response", layer, response=True, client_key="response")
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
