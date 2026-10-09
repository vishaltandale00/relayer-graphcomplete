import asyncio
import base64
import json
import sys
import types
import unittest
from dataclasses import replace
from unittest.mock import patch
from relayer_graph import (GraphAuthoringWriteError, GraphAuthoringValidationError,
    GraphNode, GraphLayer, GraphSession, RelayerGraphClient, EdgeRouteObject, html, action_capability)
from relayer_graph.exceptions import ValidationError


class Wire:
    def __init__(self):
        self.requests = []
        self.ids = {}

    def reply(self, path, body):
        key = (path, body.get("clientKey"))
        record_id = self.ids.setdefault(key, 10 + len(self.ids))
        if path.endswith("/nodes"):
            return {"node": {**body, "id": record_id, "state": "draft"}}
        if path.endswith("/edges"):
            return {"edge": {**body, "id": record_id, "state": "draft"}}
        if path.endswith("/layers"):
            return {"layer": {**body, "id": record_id, "state": "draft"}}
        return {"action": {**body, "id": record_id}}

    async def request(self, method, path, body=None):
        self.requests.append((path, body))
        return self.reply(path, body)


class ScopedAuthoringTests(unittest.IsolatedAsyncioTestCase):
    async def test_scoped_artifact_captures_renderer_and_metadata_before_queued_writes(self):
        wire = Wire()
        entered, release = asyncio.Event(), asyncio.Event()
        fingerprint = "a" * 64
        async def request(method, path, body=None):
            wire.requests.append((path, body))
            if path.endswith("/nodes"):
                entered.set()
                await release.wait()
            reply = wire.reply(path, body)
            if path.endswith("/nodes") and "artifact" in body:
                reply["node"]["artifact"] = {**body["artifact"], "fingerprint": fingerprint}
            return reply
        graph = RelayerGraphClient("http://graph.test", "token", 1)
        graph._request = request
        author = graph.authoring("artifact-capture")
        root, viewer = author.layer("answer"), author.layer("viewer")
        summary = root.node("summary", icon="info", title="Site", detail="Open the site")
        artifact = viewer.node("site", icon="globe", title="Site", detail="Website")
        source = {"file": "site/index.html", "root": "site"}
        artifact.artifact = {"kind": "website", "source": source, "part": {"route": "#pricing"}, "viewport": "phone"}
        viewer.object.renderer = "artifact"
        root.action("open", summary, kind="navigate", relation="expand", label="Open site", target=viewer)
        root.layout([(summary, .5, .5)], edge_shape="default")
        viewer.layout([(artifact, .5, .5)], edge_shape="default", default_node=artifact)
        pending = asyncio.create_task(author.write(root))
        await entered.wait()
        source["file"] = "late/index.html"
        artifact.artifact["part"]["route"] = "#late"
        viewer.object.renderer = None
        release.set()
        written = await pending
        expected = {"kind": "website", "source": {"file": "site/index.html", "root": "site"}, "part": {"route": "#pricing"}, "viewport": "phone"}
        artifact_write = next(body for path, body in wire.requests if "artifact" in body)
        self.assertEqual(artifact_write["artifact"], expected)
        viewer_write = next(body for path, body in wire.requests if path.endswith("/layers") and body["clientKey"] == viewer.object.client_key)
        self.assertEqual(viewer_write["renderer"], "artifact")
        self.assertEqual(viewer_write["nodes"], [artifact.ref.id])
        self.assertEqual(viewer_write["defaultNodeId"], artifact.ref.id)
        self.assertEqual(viewer.object.ref.renderer, "artifact")
        self.assertEqual(artifact.ref.artifact, {**expected, "fingerprint": fingerprint})
        self.assertEqual(next(action for action in written.actions if action["label"] == "Open site")["targetLayerId"], viewer.object.ref.id)

    async def test_scoped_input_binding_captures_fields_before_queued_transport(self):
        wire = Wire()
        entered, release = asyncio.Event(), asyncio.Event()
        async def request(method, path, body=None):
            wire.requests.append((path, body))
            if path.endswith("/nodes"):
                entered.set()
                await release.wait()
            return wire.reply(path, body)
        graph = RelayerGraphClient("http://graph.test", "token", 1)
        graph._request = request
        author = graph.authoring("inputs")
        layer = author.layer("plan")
        node = layer.node("plan", icon="compass", title="Plan", detail="Inputs")
        options = [("lisbon", "Lisbon")]
        field = layer.action("destination", node, kind="input", label="Destination", control="single_select", prompt="Destination", options=options)
        invoke = layer.action("analyze", node, kind="invoke", label="Analyze", interaction_text="Analyze", input_actions=(field,))
        layer.layout([(node, .5, .5)], edge_shape="default")
        pending = asyncio.create_task(author.write(layer))
        await entered.wait()
        options[0] = ("lisbon", "Late option")
        object.__setattr__(field, "label", "Late Input")
        object.__setattr__(field, "source_layer", object())
        object.__setattr__(invoke, "input_actions", (999,))
        object.__setattr__(invoke, "interaction_text", "Late instruction")
        release.set()
        result = await pending
        invocation = next(body for path, body in wire.requests if body.get("kind") == "invoke")
        input_write = next(body for path, body in wire.requests if body.get("kind") == "input")
        self.assertEqual(input_write["label"], "Destination")
        self.assertEqual(input_write["options"], [{"key": "lisbon", "label": "Lisbon"}])
        self.assertEqual(invocation["interactionText"], "Analyze")
        self.assertEqual(invocation["inputActionIds"], [next(action["id"] for action in result.actions if action["kind"] == "input")])
        self.assertEqual(invocation["sourceLayerId"], input_write["sourceLayerId"])
        self.assertFalse(invocation["reusable"])

    async def test_scoped_accepted_input_record_uses_captured_canonical_id(self):
        wire = Wire()
        entered, release = asyncio.Event(), asyncio.Event()
        async def request(method, path, body=None):
            wire.requests.append((path, body))
            if path.endswith("/nodes"):
                entered.set()
                await release.wait()
            return wire.reply(path, body)
        graph = RelayerGraphClient("http://graph.test", "token", 1)
        graph._request = request
        author = graph.authoring("accepted-input")
        layer = author.layer("plan")
        node = layer.node("plan", icon="compass", title="Plan", detail="Inputs")
        accepted = {"id": 99, "kind": "input", "state": "accepted", "sourceNodeId": 10}
        layer.action("analyze", node, kind="invoke", label="Analyze", interaction_text="Analyze", input_actions=(accepted,))
        layer.layout([(node, .5, .5)], edge_shape="default")
        pending = asyncio.create_task(author.write(layer))
        await entered.wait()
        accepted["id"] = 999
        accepted["state"] = "draft"
        release.set()
        await pending
        self.assertFalse(any(body.get("kind") == "input" for _, body in wire.requests))
        self.assertEqual(next(body for _, body in wire.requests if body.get("kind") == "invoke")["inputActionIds"], [99])

    async def test_rejects_forged_cross_source_and_cross_layer_inputs_before_transport(self):
        for invalid_binding in ("forged", "cross-source", "cross-layer", "changed-layer"):
            with self.subTest(binding=invalid_binding):
                wire = Wire()
                graph = RelayerGraphClient("http://graph.test", "token", 1)
                graph._request = wire.request
                author = graph.authoring("invalid-" + invalid_binding)
                layer = author.layer("plan")
                node = layer.node("plan", icon="compass", title="Plan", detail="Inputs")
                field = layer.action("destination", node, kind="input", label="Destination", control="text", prompt="Destination")
                binding = field
                if invalid_binding == "forged":
                    binding = replace(field)
                if invalid_binding == "cross-source":
                    other = layer.node("other", icon="info", title="Other", detail="Other")
                    binding = layer.action("other-input", other, kind="input", label="Other", control="text", prompt="Other")
                    layer.layout([(node, .2, .5), (other, .8, .5)], edge_shape="default")
                else:
                    layer.layout([(node, .5, .5)], edge_shape="default")
                if invalid_binding == "cross-layer":
                    other = author.layer("other")
                    owner = other.node("owner", icon="info", title="Other", detail="Other")
                    binding = other.action("input", owner, kind="input", label="Other", control="text", prompt="Other")
                    other.layout([(owner, .5, .5)], edge_shape="default")
                if invalid_binding == "changed-layer":
                    object.__setattr__(field, "source_layer", author.layer("other").object)
                layer.action("analyze", node, kind="invoke", label="Analyze", interaction_text="Analyze", input_actions=(binding,))
                message = "exact containing source layer" if invalid_binding == "changed-layer" else "same source Node and scoped Layer"
                with self.assertRaisesRegex(GraphAuthoringValidationError, message):
                    await author.write(layer)
                self.assertEqual(wire.requests, [])

    async def test_captures_prime_program_and_aliases_before_queued_transport(self):
        graph = GraphSession("http://unused", "run", 1)
        wire = Wire()
        graph._request = wire.request
        entered, release = asyncio.Event(), asyncio.Event()
        payloads = []
        async def host_request(method, payload):
            payloads.append((method, payload))
            if method == "relayer.graph.visual-authoring":
                entered.set()
                await release.wait()
                node = wire.reply("/api/graph/nodes", payload["node"])["node"]
                return {"ok": True, "frozen": True, "value": {**node, "preview": {"status": "limit_reached"}}}
            layer = wire.reply("/api/graph/layers", payload["layer"])["layer"]
            return {"ok": True, "value": {**layer, "preview": {"status": "failed"}}}
        author = graph.authoring("finding-v1")
        root, evidence = author.layer("answer"), author.layer("evidence")
        nodes = [root.node(key, icon="info", title=key, detail=key) for key in ("a", "b", "c")]
        proof = evidence.node("proof", icon="file", title="Proof", detail="Proof")
        action = root.action("evidence", nodes[0], kind="navigate", relation="expand", label="Evidence", target=evidence)
        nodes[0].detail_authoring.set_component("main", html(["<button gc=", ">Evidence</button>"], action_capability("evidence", action)))
        nodes[2].detail_authoring.set_component("main", html("<p>Original queued</p>"))
        options = [("yes", "Original")]
        root.action("input", nodes[0], kind="input", label="Choice", control="single_select", prompt="Choose", options=options)
        accepted_target = GraphLayer(901, (), (), "accepted")
        root.action("accepted", nodes[0], kind="navigate", relation="reference", label="Accepted", target=accepted_target)
        edge = root.edge("relationship", nodes[0], nodes[1])
        waypoints = [{"x": .4, "y": .3}]
        route = EdgeRouteObject(edge, waypoints=waypoints)
        root.layout([(node, .2 + index * .3, .5) for index, node in enumerate(nodes)], edge_shape="default", edge_routes=[route], default_node=nodes[0])
        evidence.layout([(proof, .5, .5)], edge_shape="default")
        with patch.dict(sys.modules, {"rlm": types.SimpleNamespace(host_request=host_request)}):
            pending = asyncio.create_task(author.write(root))
            await entered.wait()
            joined = asyncio.create_task(graph.submit_node(nodes[2]))
            nodes[2].title = "Late title"
            nodes[2].detail_authoring.set_component("main", html("<p>Late queued</p>"))
            root.object.nodes = [nodes[2]]
            root.object.layout.placements[0].x = .9
            edge.endpoints = (nodes[2], nodes[0])
            waypoints[0]["x"] = .9
            options[0] = ("yes", "Late")
            object.__setattr__(accepted_target, "id", 999)
            release.set()
            written = await pending
            self.assertIs(await joined, next(node for node in written.nodes if node.title == "c"))
        node_payloads = [payload for method, payload in payloads if method == "relayer.graph.visual-authoring"]
        self.assertEqual(len(node_payloads), 4)
        self.assertEqual(node_payloads[2]["node"]["title"], "c")
        self.assertEqual(node_payloads[2]["detail"]["components"][0]["markup"]["strings"], ["<p>Original queued</p>"])
        mount_action = node_payloads[0]["detail"]["components"][0]["markup"]["values"][0]["action"]
        self.assertEqual(mount_action["clientKey"], action.client_key)
        self.assertEqual(mount_action["sourceLayer"]["nodes"], [node.client_key for node in nodes])
        root_payload = next(payload["layer"] for method, payload in payloads if method == "relayer.graph.submit-layer" and payload["layer"]["clientKey"] == root.object.client_key)
        self.assertEqual(root_payload["nodes"], [node.ref.id for node in nodes])
        self.assertEqual(root_payload["layout"]["placements"][0]["x"], .2)
        self.assertEqual(written.root_layer.state, "draft")
        self.assertEqual(written.root_layer.preview.status, "failed")
        self.assertTrue(all(node.preview.status == "limit_reached" for node in written.nodes))
        action_payload = next(body for path, body in wire.requests if body.get("label") == "Evidence")
        self.assertEqual(next(body for path, body in wire.requests if body.get("label") == "Accepted")["targetLayerId"], 901)
        self.assertEqual(next(body for path, body in wire.requests if body.get("label") == "Choice")["options"], [{"key": "yes", "label": "Original"}])
        self.assertEqual(root_payload["layout"]["edgeRoutes"][0]["waypoints"], [{"x": .4, "y": .3}])
        self.assertEqual(action_payload["sourceLayerId"], written.root_layer.id)
        self.assertEqual(action_payload["targetLayerId"], evidence.object.ref.id)
        self.assertEqual(action_payload["clientKey"], action.client_key)
        # Same UTF-8 namespace as TypeScript, including non-ASCII names.
        named = graph.authoring("π").layer("答案").node("証", icon="info", title="T", detail="D")
        encoded = json.dumps(["π", "答案", "n", "証"], ensure_ascii=False, separators=(",", ":")).encode()
        self.assertEqual(named.client_key, "ga1:" + base64.urlsafe_b64encode(encoded).decode().rstrip("="))

    async def test_partial_failure_settles_started_writes_and_allows_repair(self):
        graph = RelayerGraphClient("http://unused", "run", 1)
        wire = Wire()
        entered, release = asyncio.Event(), asyncio.Event()
        fail = True
        active = maximum = 0
        async def request(method, path, body=None):
            nonlocal active, maximum
            wire.requests.append((path, body))
            active += 1
            maximum = max(maximum, active)
            try:
                if fail and body.get("title") == "A":
                    await entered.wait()
                    raise ValidationError("Unsupported icon", status=422, details={"error": {"code": "unsupported_icon"}})
                if fail and body.get("title") == "B":
                    entered.set()
                    await release.wait()
                return wire.reply(path, body)
            finally:
                active -= 1
        graph._request = request
        def assemble():
            author = graph.authoring("repair")
            layer = author.layer("answer")
            nodes = [layer.node(key, icon="info", title=key, detail=key) for key in ("A", "B", "C")]
            layer.layout([(node, .2 + index * .3, .5) for index, node in enumerate(nodes)], edge_shape="default")
            return author, layer, nodes
        author, layer, nodes = assemble()
        pending = asyncio.create_task(author.write(layer))
        await entered.wait()
        joined = asyncio.create_task(graph.submit_node(nodes[2]))
        release.set()
        with self.assertRaises(GraphAuthoringWriteError) as caught:
            await pending
        with self.assertRaisesRegex(Exception, "not scheduled"):
            await joined
        self.assertEqual(maximum, 2)
        self.assertEqual(len(wire.requests), 2)
        self.assertEqual(caught.exception.completed[0].path, 'layers["answer"].nodes["B"]')
        self.assertEqual(caught.exception.failures[0].outcome, "rejected")
        self.assertEqual(caught.exception.unstarted, ('layers["answer"].nodes["C"]', 'layers["answer"]'))
        fail = False
        repaired, layer, fresh = assemble()
        await repaired.write(layer)
        self.assertEqual([node.client_key for node in fresh], [node.client_key for node in nodes])
        self.assertEqual(fresh[1].ref.id, nodes[1].ref.id)
        # Cancellation did not poison the queued node's ordinary retry.
        nodes[2].title = "Repaired queued"
        self.assertEqual((await graph.submit_node(nodes[2])).title, "Repaired queued")

    async def test_reference_cycles_and_accepted_boundaries_exclude_unrelated_layers(self):
        graph = RelayerGraphClient("http://unused", "run", 1)
        wire = Wire()
        graph._request = wire.request
        author = graph.authoring("references")
        root, left, right = [author.layer(key) for key in ("answer", "left", "right")]
        author.layer("unrelated")
        history = GraphNode(900, "concept", "file", "History", "History", "accepted")
        root.include(history)
        answer = root.node("answer", icon="info", title="Answer", detail="Answer")
        l = left.node("left", icon="info", title="Left", detail="Left")
        r = right.node("right", icon="info", title="Right", detail="Right")
        root.edge("history", answer, history)
        root.action("context", answer, kind="navigate", relation="reference", label="Context", target=left)
        left.action("next", l, kind="navigate", relation="reference", label="Next", target=right)
        right.action("back", r, kind="navigate", relation="reference", label="Back", target=left)
        right.action("accepted", r, kind="navigate", relation="reference", label="Accepted", target=GraphLayer(901, (), (), "accepted"))
        root.layout([(answer, .2, .5), (history, .8, .5)], edge_shape="straight")
        left.layout([(l, .5, .5)], edge_shape="default")
        right.layout([(r, .5, .5)], edge_shape="default")
        written = await author.write(root)
        self.assertEqual(len(written.layers), 3)
        self.assertEqual(len(written.nodes), 3)
        self.assertIn(900, next(body for path, body in wire.requests if path.endswith("/edges"))["endpoints"])
        self.assertIn(901, [body["targetLayerId"] for path, body in wire.requests if path.endswith("/actions")])
        with self.assertRaises(GraphAuthoringValidationError):
            root.include(written.nodes[0])
        repair = graph.authoring("references")
        layer = repair.layer("answer")
        a = layer.node("answer", icon="info", title="Answer", detail="Answer")
        b = layer.node("new", icon="info", title="New", detail="New")
        layer.edge("history", a, b)
        layer.layout([(a, .2, .5), (b, .8, .5)], edge_shape="default")
        with self.assertRaisesRegex(GraphAuthoringValidationError, "identity-owning context"):
            await repair.write(layer)

    async def test_repeated_cancellation_retains_claims_until_started_transport_settles(self):
        graph = RelayerGraphClient("http://unused", "run", 1)
        wire = Wire()
        entered, release = asyncio.Event(), asyncio.Event()
        async def request(method, path, body=None):
            wire.requests.append((path, body))
            entered.set()
            await release.wait()
            return wire.reply(path, body)
        graph._request = request
        def assemble():
            author = graph.authoring("cancel")
            layer = author.layer("answer")
            nodes = [layer.node(key, icon="info", title=key, detail=key) for key in ("A", "B", "C")]
            layer.layout([(node, .2 + index * .3, .5) for index, node in enumerate(nodes)], edge_shape="default")
            return author, layer
        author, layer = assemble()
        pending = asyncio.create_task(author.write(layer))
        await entered.wait()
        pending.cancel()
        await asyncio.sleep(0)
        pending.cancel()
        await asyncio.sleep(0)
        self.assertFalse(pending.done())
        fresh, repair = assemble()
        with self.assertRaisesRegex(GraphAuthoringValidationError, "overlapping"):
            await fresh.write(repair)
        release.set()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        self.assertEqual(len(wire.requests), 2)
        self.assertFalse(graph._scoped_writes)
        await fresh.write(repair)

    async def test_ordinary_client_rejects_visual_details_before_any_transport(self):
        graph = RelayerGraphClient("http://unused", "run", 1)
        wire = Wire()
        graph._request = wire.request
        author = graph.authoring("ordinary")
        layer = author.layer("answer")
        node = layer.node("a", icon="info", title="A", detail="A")
        node.detail_authoring.set_component("main", html("<p>A</p>"))
        layer.layout([(node, .5, .5)], edge_shape="default")
        with self.assertRaisesRegex(Exception, "GraphSession.current"):
            await author.write(layer)
        self.assertFalse(wire.requests)

    async def test_frozen_unknown_replays_exact_payload_and_known_rejection_retains_cause(self):
        for known in (False, True):
            with self.subTest(known=known):
                graph = GraphSession("http://unused", "run", 1)
                author = graph.authoring("outcome")
                root = author.layer("answer")
                node = root.node("a", icon="info", title="Original", detail="Original")
                node.detail_authoring.set_component("main", html("<p>Original</p>"))
                root.layout([(node, .5, .5)], edge_shape="default")
                payloads = []
                async def host_request(method, payload):
                    if method == "relayer.graph.submit-layer":
                        return {"ok": True, "value": {**payload["layer"], "id": 20, "state": "draft"}}
                    payloads.append(payload)
                    if len(payloads) == 1:
                        return {"ok": False, "frozen": True, "message": "lost response",
                                **({"httpStatus": 422, "error": {"code": "unsupported_icon", "message": "Unsupported icon", "path": "icon"}} if known else {})}
                    return {"ok": True, "frozen": True, "value": {**payload["node"], "id": 10, "state": "draft"}}
                with patch.dict(sys.modules, {"rlm": types.SimpleNamespace(host_request=host_request)}):
                    with self.assertRaises(GraphAuthoringWriteError) as caught:
                        await author.write(root)
                    self.assertEqual(caught.exception.failures[0].outcome, "rejected" if known else "unknown")
                    if known:
                        self.assertEqual(caught.exception.failures[0].cause.details["error"]["code"], "unsupported_icon")
                    else:
                        node.title = "Late"
                        with self.assertRaisesRegex(ValueError, "detail_finalized"):
                            node.detail_authoring.clear()
                        written = await author.write(root)
                        self.assertEqual(payloads[0], payloads[1])
                        self.assertEqual(written.nodes[0].title, "Original")
