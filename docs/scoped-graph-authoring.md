# Scoped draft authoring

Issue #654's first implementation slice adds `graph.authoring(snapshotKey)` to
both SDKs. It assembles ordinary node, edge, layer, and action objects and writes
one selected ready closure. Content, relationships, layout, and graph acceptance
remain the caller's and GraphComplete's responsibilities (PRD §11.1–11.6,
ADR0005, ADR0008 temporal current).

```ts
import { RelayerGraphClient, html, detailCapability } from "@relayer/graph-client";
const graph = RelayerGraphClient.fromEnv();
const author = graph.authoring("finding-v1");
const answer = author.layer("answer");
const evidence = author.layer("evidence");
const finding = answer.node("finding", {icon:"info",title:"Finding",detail:"Supported finding"});
const proof = evidence.node("proof", {icon:"file",title:"Proof",detail:"Evidence"});
const expansion = answer.action("evidence", finding, {
  kind:"navigate",relation:"expand",label:"Evidence",target:evidence,
});
finding.detailAuthoring.setComponent("main", html`<button gc=${detailCapability.expand("evidence", expansion)}>Evidence</button>`);
answer.layout([[finding,.5,.5]], {edgeShape:"default",defaultNode:finding});
evidence.layout([[proof,.5,.5]], {edgeShape:"default"});
const written = await author.write(answer);
// Explicitly attach the response and use the existing acceptance boundary.
await graph.addAction(graph.capability.nodeId, {
  kind:"navigate",relation:"expand",label:"Response",target:written.rootLayer,clientKey:"response",
});
await graph.submit();
```

In Prime, the equivalent uses the existing canonical host compiler:

```python
from relayer_graph import GraphSession, html, action_capability

graph = await GraphSession.current()
author = graph.authoring("finding-v1")
answer, evidence = author.layer("answer"), author.layer("evidence")
finding = answer.node("finding", icon="info", title="Finding", detail="Supported finding")
proof = evidence.node("proof", icon="file", title="Proof", detail="Evidence")
expansion = answer.action("evidence", finding, kind="navigate", relation="expand",
                          label="Evidence", target=evidence)
finding.detail_authoring.set_component("main", html(
    ["<button gc=", ">Evidence</button>"], action_capability("evidence", expansion)))
answer.layout([(finding,.5,.5)], edge_shape="default", default_node=finding)
evidence.layout([(proof,.5,.5)], edge_shape="default")
written = await author.write(answer)
await graph.add_navigate_action(graph.node_id, "Response", written.root_layer,
                                relation="expand", client_key="response")
await graph.submit()
```

Ordinary Python `RelayerGraphClient` supports semantic drafts; visual Node Details
continue to require `GraphSession`. A layer's `.object` is the actual containing
`LayerObject`. `action` returns the actual declaration used to bind visual controls;
the client captures its fields privately for transport. No alternate compiler or
public compiled-package submission API is introduced.

## Artifact layers

An artifact layer (PRD §6.6, §11.11, ADR 0014) holds exactly one artifact node and
no edges. `layer.artifactNode(localKey, fields)` / `layer.artifact_node(local_key, ...)`
is the scoped equivalent of `LayerObject.forArtifact` / `LayerObject.for_artifact`:
it declares the layer's one node with its `artifact` details, centers it, makes it
the default node, and sets the layer's `artifact` renderer. Target the layer from
an ordinary node's navigate action.

```ts
const viewer = author.layer("site-viewer");
viewer.artifactNode("site", {icon:"globe",title:"Landing page",detail:"Check pricing on a phone",
  artifact:{kind:"website",source:{file:"site/index.html",root:"site"},viewport:"phone"}});
answer.action("open-site", finding, {kind:"navigate",relation:"expand",label:"Open the site",target:viewer});
```

`layer.node` also accepts optional `artifact` details. The scoped API adds no
local artifact shape checks. Artifact details must be plain data (in Python, an
exact `dict` of ordinary values), so capture runs no author code; otherwise the
client captures them as on the direct path, and graph-core rejects malformed
artifacts or artifact layers with repairable issues at the node or layer path.

## Identity and repair

Names are nonempty, trimmed, NUL-free Unicode strings. Keys are the versioned
lossless encoding `ga1:` plus unpadded base64url of UTF-8 compact JSON
`[snapshotKey, layerKey, objectKind, localKey]`. Kinds are `n`, `e`, `l`, and `a`;
a layer has an empty local key. TS and Python use the same encoding. The total
key must fit the existing 128-byte compiler identity limit; shorten names rather
than silently hashing them. Names do not determine content or layout.

Duplicate declarations fail locally. To repair a draft, assemble fresh objects
with the same snapshot and local keys. Changed edge endpoints or action source
provenance require a new key. This history check is client-local; Rust still
validates identity, visibility, ownership, and state. Accepted changes need a new
snapshot. `layer.include(acceptedNodeOrEdge)` references an explicit accepted
record without submitting it again. An accepted navigation target is a read-only
traversal boundary. An accepted record itself grants no authority.

## Capture and writes

`write(root)` captures every selected ready layer and its node envelopes, detail
programs, actions, accepted IDs, layout, routes, and clear/retain state before its
first internal await. In Python, this starts when the coroutine is awaited or
scheduled. Reference cycles are visited once. Unrelated declarations are excluded;
no factories are evaluated and no layer decomposition or placement is invented.
Declare each layer's explicit layout, edge shape, default node, and any private
six-to-eight-node size justification yourself.

The writer submits nodes, then edges, layers, and actions, with at most two
requests running per stage. This is bounded transport, not an agent scheduler.
Same-client overlapping scoped identities are rejected while a write runs.
An existing direct submission of the exact node object joins its already captured
request; a direct call for a scoped queued node waits without starting that queue
entry. These guarantees do not extend to independent clients or arbitrary mixed
low-level edge/layer/action mutations.

A failed stage stops new scheduling and settles already started requests.
`GraphAuthoringWriteError` retains completed record IDs, scoped failure paths,
original causes, rejected versus unknown outcomes, and unstarted paths. Valid
drafts remain available for explicit repair. No aggregate error or unscheduled
cancellation is counted as an additional origin incident in metric 2. Python's
existing client-side diagnostic coverage remains partial; Rust rejections and
Prime's canonical compiler diagnostics retain their existing measurement paths.
Python cancellation drains started writes before releasing identity claims.

`write` returns draft records and preserves advisory preview metadata; it does
not accept or publish. `publishCurrent` and `finish` belong to a later slice with
freshness, frozen retry, and unknown-outcome guards. Existing current transitions
and acceptance APIs remain explicit. Codex, shared Claude, and Prime now receive a runnable named-field recipe.
JavaScript authoring can consult the exported `detailAuthoringReference()` before
styling; Prime receives the same generated reference in its recipe. A first useful
graph speed/quality experiment remains separate work. No speed improvement is
claimed by this SDK change.

## Repair feedback and executable recipes

A rejected string node icon retains the server status, code, path, issues, and
origin error. Its local SDK message identifies the captured `node.icon` value
(bounded to 128 characters), explains the positional constructor, and points to
named fields and supported-icon discovery. It reads no live builder or arbitrary
icon object. Error measurement and compiler constraints remain unchanged.

Harness recipes preserve the exact supplied SDK URL and shell quoting. A saved
program edit must still match once. After a known graph rejection, an unpatchable
program may be reconstructed as a fresh graph-only draft with the same snapshot
and keys. Successful workspace effects are not replayed. Unknown submission
outcomes remain for host reconciliation; a fresh draft is not an automatic retry.
