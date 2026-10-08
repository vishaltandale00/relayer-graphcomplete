"""PRD 11.11: Python agents declare artifact nodes and artifact layers."""
from __future__ import annotations

import unittest

from relayer_graph.authoring import GraphLayer, GraphNode, LayerObject, NodeObject, _layer_payload


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


if __name__ == "__main__":
    unittest.main()
