# relayer-graph Python client

A dependency-free asynchronous client for the GraphComplete Rust graph service.

```python
from relayer_graph import (
    EdgeObject, LayerLayoutObject, LayerObject, NodeObject,
    NodePlacementObject, RelayerGraphClient,
)

async with RelayerGraphClient.from_env() as graph:
    intro = NodeObject("book", "Introduction", "Useful markdown detail", client_key="intro")
    detail = NodeObject("code", "Implementation", "How the concept works", client_key="implementation")
    await graph.submit_node(intro)
    await graph.submit_node(detail)
    connection = EdgeObject((intro, detail), client_key="intro-implementation")
    await graph.create_edge(connection)
    layout = LayerLayoutObject((
        NodePlacementObject(intro, 0.25, 0.5),
        NodePlacementObject(detail, 0.75, 0.5),
    ), "elbow-horizontal")
    layer = LayerObject((intro, detail), (connection,), layout, client_key="response-layer")
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

Input-plus-Invoke uses an explicit declaration reference, not the field's position:

```python
from relayer_graph import ActionObject

destination = ActionObject("input", "Destination", layer, "destination",
                           control="text", prompt="Destination")
analyze = ActionObject("invoke", "Analyze", layer, "analyze",
                       interaction_text="Analyze the confirmed destination",
                       input_actions=(destination,))
# After submitting node and layer, this writes or recovers the Input first:
await graph.add_action(node, analyze)
```

Mount these same objects in visual markup with `action_capability`. Referenced
Inputs must be mounted on the same owning Node. Compilation alone does not create
actions. Use `reusable=True` only for intentionally repeatable workflows; the
default remains one call. A late write failure can leave draft Inputs; retry with
the same keys. Existing positive numeric Input IDs also remain supported.

Configuration is read from `RELAYER_GRAPH_URL`, `RELAYER_GRAPH_TOKEN`, and
`RELAYER_NODE_ID`. The client uses only Python's standard library.

Supply an explicit, deterministic `client_key` for every persisted node, edge,
layer, and action. Rerunning the whole authoring program with those same keys
updates its logical drafts instead of creating duplicate records.

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

If submission reports an intentionally abandoned orphan draft layer, discard
that layer explicitly before retrying submission:

```python
await graph.discard_layer(abandoned_layer)
```

Discard preserves the layer as terminal stopped history. It does not delete or
change the layer's nodes, edges, actions, or child layers, and it rejects layers
that are accepted, owned by another interaction, or still reachable from the
current root action.

For named scoped assembly, use `graph.authoring(snapshot_key)` and
`await author.write(root_layer)`. See [scoped draft authoring](../../docs/scoped-graph-authoring.md)
for the TS/Python recipes, captured-write behavior, stable identity and repair
rules, and the explicit acceptance step. Writing a scope returns drafts.

`GraphSession.extend_node_presentation(node_id, expected_revision, additions)` stages new typed components for an authorized rich attached node. The additions use that persistent node’s exact `client_key` and distinct component/control keys. The host retains accepted HTML, CSS, controls, provenance and pinned assets; it checks the combined package limits. Include all new controls in one additions builder. Repeating the call composes against accepted detail and replaces this completion’s pending presentation. The existing full-replacement endpoint and graph authority remain decisive. Staging is invisible until Return; stale revisions or key conflicts require rereading or an explicit full replacement.
