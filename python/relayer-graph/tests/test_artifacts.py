"""PRD 11.11: Python agents declare artifact nodes and artifact layers."""
from __future__ import annotations

import asyncio
import json
import sys
import types
import unittest
from unittest.mock import patch

from collections.abc import Mapping

from relayer_graph import GraphAuthoringValidationError, GraphAuthoringWriteError, GraphSession, RelayerGraphClient
from relayer_graph.authoring import GraphLayer, GraphNode, LayerObject, NodeObject, _layer_payload
from relayer_graph.exceptions import ValidationError

FINGERPRINT = "sha256:" + "0" * 64
SITE = {"kind": "website", "source": {"file": "site/index.html", "root": "site"}, "part": {"route": "#pricing"}, "viewport": "phone"}


class ArtifactAuthoringTest(unittest.TestCase):
    def test_for_artifact_builds_one_node_artifact_layer(self) -> None:
        node = NodeObject("globe", "Landing page", "The site", client_key="landing")
        node.artifact = {"kind": "website", "source": {"file": "site/index.html", "root": "site"}}
        payload = _layer_payload(LayerObject.for_artifact(42, "viewer"), None)
        self.assertEqual(payload["renderer"], "artifact")
        self.assertEqual(payload["nodes"], [42])
        self.assertEqual(payload["edges"], [])
        self.assertEqual(payload["defaultNodeId"], 42)
        self.assertEqual(payload["layout"]["placements"], [{"nodeId": 42, "x": 0.5, "y": 0.5}])

    def test_graph_layers_omit_renderer(self) -> None:
        layer = LayerObject.for_artifact(1)
        layer.renderer = None
        self.assertNotIn("renderer", _layer_payload(layer, None))

    def test_responses_keep_artifact_and_renderer(self) -> None:
        node = GraphNode.from_dict({"id": 7, "kind": "concept", "icon": "globe", "title": "Site", "detail": "x", "state": "draft",
                                    "artifact": {"kind": "url", "source": {"url": "https://example.com"}}})
        self.assertEqual(node.artifact["kind"], "url")
        layer = GraphLayer.from_dict({"id": 3, "nodes": [7], "edges": [], "state": "draft", "renderer": "artifact"})
        self.assertEqual(layer.renderer, "artifact")


def _assemble(graph, artifact):
    author = graph.authoring("site-v1")
    answer, viewer = author.layer("answer"), author.layer("site-viewer")
    overview = answer.node("overview", icon="info", title="Launch", detail="The launch site is ready.")
    site = viewer.artifact_node("site", icon="globe", title="Landing page", detail="Check pricing on a phone.", artifact=artifact)
    answer.action("open-site", overview, kind="navigate", relation="expand", label="Open the site", target=viewer)
    answer.layout([(overview, .5, .5)], edge_shape="default", default_node=overview)
    return author, answer, viewer, site


class ScopedArtifactAuthoringTest(unittest.IsolatedAsyncioTestCase):
    def wire(self, reject=lambda body: False):
        requests = []
        async def request(method, path, body=None):
            requests.append((path, body))
            if reject(body):
                raise ValidationError("Keep artifact files inside the thread folder", status=422,
                                      details={"error": {"code": "artifact_path_outside_thread"}})
            record_id = 10 + len(requests)
            if path.endswith("/nodes"):
                artifact = body.get("artifact")
                return {"node": {**body, "id": record_id, "state": "draft",
                                 **({"artifact": {**artifact, "fingerprint": FINGERPRINT}} if artifact else {})}}
            if path.endswith("/layers"):
                return {"layer": {**body, "id": record_id, "state": "draft"}}
            return {"action": {**body, "id": record_id}}
        return requests, request

    async def test_writes_artifact_node_and_one_node_artifact_layer(self) -> None:
        graph = RelayerGraphClient("http://unused", "run", 1)
        requests, graph._request = self.wire()
        artifact = json.loads(json.dumps(SITE))
        author, answer, viewer, site = _assemble(graph, artifact)
        pending = asyncio.create_task(author.write(answer))
        await asyncio.sleep(0)
        # Both are captured before the first await; late edits cannot change the request.
        artifact["source"]["file"] = "late/index.html"
        viewer.object.renderer = None
        written = await pending
        nodes = {body["title"]: body for path, body in requests if path.endswith("/nodes")}
        self.assertNotIn("artifact", nodes["Launch"])
        self.assertEqual(nodes["Landing page"]["artifact"], SITE)
        record = next(node for node in written.nodes if node.title == "Landing page")
        self.assertEqual(record.artifact["fingerprint"], FINGERPRINT)
        layers = [body for path, body in requests if path.endswith("/layers")]
        viewer = next(layer for layer in layers if layer.get("renderer") == "artifact")
        self.assertEqual((viewer["nodes"], viewer["edges"], viewer["defaultNodeId"]), ([record.id], [], record.id))
        self.assertEqual(viewer["layout"]["placements"], [{"nodeId": record.id, "x": 0.5, "y": 0.5}])
        self.assertEqual([layer for layer in layers if "renderer" in layer], [viewer])
        viewer_record = next(layer for layer in written.layers if layer.renderer == "artifact")
        action = next(body for path, body in requests if path.endswith("/actions"))
        self.assertEqual(action["targetLayerId"], viewer_record.id)

    async def test_server_rejected_artifact_draft_is_repairable_with_same_keys(self) -> None:
        graph = RelayerGraphClient("http://unused", "run", 1)
        rejecting = True
        requests, graph._request = self.wire(lambda body: rejecting and body.get("title") == "Landing page")
        author, answer, _, site = _assemble(graph, {"kind": "website", "source": {"file": "../outside/index.html", "root": "../outside"}})
        with self.assertRaises(GraphAuthoringWriteError) as caught:
            await author.write(answer)
        failure = caught.exception.failures[0]
        self.assertEqual((failure.path, failure.outcome), ('layers["site-viewer"].nodes["site"]', "rejected"))
        rejecting = False
        author, answer, _, repaired = _assemble(graph, SITE)
        self.assertEqual(repaired.client_key, site.client_key)
        written = await author.write(answer)
        self.assertTrue(any(layer.renderer == "artifact" for layer in written.layers))

    async def test_capture_refuses_artifact_mappings_without_running_them(self) -> None:
        graph = RelayerGraphClient("http://unused", "run", 1)
        requests, graph._request = self.wire()
        ran = []
        class Recording(Mapping):
            def __getitem__(self, key): ran.append(key); return SITE[key]
            def __iter__(self): ran.append("iter"); return iter(SITE)
            def __len__(self): return len(SITE)
        class Subclass(dict):
            def items(self): ran.append("items"); return super().items()
        for artifact in (Recording(), Subclass(SITE), {**SITE, "part": Recording()}):
            author, answer, _, _ = _assemble(graph, artifact)
            with self.assertRaises(GraphAuthoringValidationError):
                await author.write(answer)
        self.assertEqual((ran, requests), ([], []))

    async def test_prime_bridge_receives_artifact_and_renderer(self) -> None:
        graph = GraphSession("http://unused", "run", 1)
        payloads = []
        async def host_request(method, payload):
            payloads.append((method, payload))
            if method == "relayer.graph.visual-authoring":
                return {"ok": True, "value": {**payload["node"], "id": 10 + len(payloads), "state": "draft"}}
            return {"ok": True, "value": {**payload["layer"], "id": 10 + len(payloads), "state": "draft"}}
        async def request(method, path, body=None):
            return {"action": {**body, "id": 99}}
        graph._request = request
        author, answer, _, _ = _assemble(graph, SITE)
        with patch.dict(sys.modules, {"rlm": types.SimpleNamespace(host_request=host_request)}):
            await author.write(answer)
        nodes = {payload["node"]["title"]: payload["node"] for method, payload in payloads if "node" in payload}
        self.assertEqual(nodes["Landing page"]["artifact"], SITE)
        self.assertNotIn("artifact", nodes["Launch"])
        layers = [payload["layer"] for method, payload in payloads if method == "relayer.graph.submit-layer"]
        self.assertEqual([layer.get("renderer") for layer in layers].count("artifact"), 1)


if __name__ == "__main__":
    unittest.main()
