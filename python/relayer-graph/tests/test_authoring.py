from __future__ import annotations

import json
import os
import pickle
import sys
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from relayer_graph import (APIError, ConfigurationError, EdgeObject, GraphNode, GraphSession,
                           LayerLayoutObject, LayerObject, NodeObject,
                           NodePlacementObject,
                           RELAYER_ICON_NAMES, RelayerGraphClient, ValidationError,
                           is_supported_relayer_icon, resolve_relayer_icon_name)


class Handler(BaseHTTPRequestHandler):
    requests = []
    next_id = 10

    def log_message(self, *args):
        pass

    def _reply(self, value, status=200):
        encoded = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))) or b"{}")
        Handler.requests.append((self.path, dict(self.headers), body))
        Handler.next_id += 1
        if self.path.endswith("/nodes") and body["title"] == "server-error":
            self._reply({"error": {"message": "database failed"}}, 500)
        elif self.path.endswith("/nodes") and not body["title"].strip():
            self._reply({"error": {"message": "title is required", "issues": [{
                "code": "node_title_required", "path": "node.title",
                "message": "Add a short title and submit the node again."
            }]}}, 422)
        elif self.path.endswith("/nodes"):
            self._reply({"node": {"id": Handler.next_id, "kind": body["kind"], "icon": body["icon"], "title": body["title"], "detail": body["detail"], "state": "draft"}})
        elif self.path.endswith("/edges"):
            self._reply({"edge": {"id": Handler.next_id, "endpoints": body["endpoints"], "state": "draft"}})
        elif self.path.endswith("/layers"):
            self._reply({"layer": {"id": Handler.next_id, "nodes": body["nodes"], "edges": body["edges"], "layout": body["layout"], "state": "draft"}})
        elif self.path.endswith("/discard"):
            layer_id = int(self.path.split("/")[-2])
            self._reply({"layer": {"id": layer_id, "nodes": [1], "edges": [], "state": "stopped"}})
        else:
            self._reply({"ok": True})

    def do_GET(self):
        Handler.requests.append((self.path, dict(self.headers), None))
        if self.path.endswith("/input"):
            self._reply({
                "interaction": {"id": 7, "kind": "user-interaction", "icon": "user", "title": "Compare", "detail": "Compare", "state": "accepted"},
                "contexts": [{
                    "type": "interaction.context",
                    "targetNode": {"id": 4, "kind": "concept", "icon": "box", "title": "Boundary", "detail": "Evidence", "state": "accepted"},
                    "annotations": ["First", "Second"],
                }],
                "submittedInputs": [{
                    "action": {"control": "text", "prompt": "Explain the tradeoff"},
                    "value": {"text": "Preserve this exactly"},
                }],
            })
        elif self.path.endswith("/output"):
            self._reply({"nodeId": 7, "rootAction": {}, "rootLayer": {}})
        else:
            self._reply({"error": {"message": "not found"}}, 404)


class AuthoringClientTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join()

    def setUp(self):
        Handler.requests.clear()
        self.client = RelayerGraphClient(self.url, "secret", 7)

    async def test_objects_receive_server_ids_and_compose_a_layer(self):
        queue = NodeObject("queue", "Queue", "Waiting work", client_key="queue")
        worker = NodeObject("worker", "Worker", "Claims work", client_key="worker")
        await self.client.submit_node(queue); await self.client.submit_node(worker)
        edge = EdgeObject((queue, worker), client_key="queue-worker")
        await self.client.create_edge(edge)
        layout = LayerLayoutObject((
            NodePlacementObject(queue, 0.25, 0.5),
            NodePlacementObject(worker, 0.75, 0.5),
        ))
        layer = LayerObject((queue, worker), (edge,), layout, client_key="root")
        await self.client.submit_layer(layer)
        self.assertIsNotNone(queue.ref); self.assertIsNotNone(edge.ref); self.assertIsNotNone(layer.ref)
        self.assertEqual(Handler.requests[-1][2]["nodes"], [queue.ref.id, worker.ref.id])
        self.assertEqual(Handler.requests[-1][2]["layout"], {
            "version": 1,
            "placements": [
                {"nodeId": queue.ref.id, "x": 0.25, "y": 0.5},
                {"nodeId": worker.ref.id, "x": 0.75, "y": 0.5},
            ],
        })
        self.assertEqual(layer.ref.layout.version, 1)
        self.assertEqual(Handler.requests[0][1]["Authorization"], "Bearer secret")

    async def test_submit_and_completion_output_use_the_active_interaction(self):
        await self.client.submit()
        self.assertEqual(Handler.requests[-1][0], "/api/graph/submit")
        self.assertEqual(Handler.requests[-1][2], {"nodeId": 7})
        output = await self.client.get_completion_output()
        self.assertEqual(output["nodeId"], 7)
        self.assertEqual(Handler.requests[-1][0], "/api/graph/nodes/7/output")

    async def test_interaction_input_is_typed_and_preserves_annotation_order(self):
        input = await self.client.get_interaction_input()
        self.assertEqual(input.interaction.id, 7)
        self.assertEqual(input.contexts[0].type, "interaction.context")
        self.assertEqual(input.contexts[0].target_node.title, "Boundary")
        self.assertEqual(input.contexts[0].annotations, ("First", "Second"))
        self.assertEqual(input.submitted_inputs[0].action["control"], "text")
        self.assertEqual(input.submitted_inputs[0].value["text"], "Preserve this exactly")
        self.assertEqual(Handler.requests[-1][0], "/api/graph/input")

    async def test_discard_layer_posts_to_recovery_endpoint_and_refreshes_reference(self):
        layout = LayerLayoutObject((NodePlacementObject(1, 0.5, 0.5),))
        layer = LayerObject((1,), (), layout, client_key="abandoned")
        await self.client.submit_layer(layer)
        draft_id = layer.ref.id

        stopped = await self.client.discard_layer(layer)

        self.assertEqual(
            Handler.requests[-1][0], f"/api/graph/layers/{draft_id}/discard"
        )
        self.assertEqual(stopped.state, "stopped")
        self.assertEqual(layer.ref, stopped)

    async def test_action_retries_use_the_caller_owned_key(self):
        await self.client.add_invoke_action(7, "Ask", "Continue", source_layer=8, client_key="ask-again")
        await self.client.add_invoke_action(7, "Ask", "Continue", source_layer=8, client_key="ask-again")
        self.assertEqual(
            [request[2]["clientKey"] for request in Handler.requests[-2:]],
            ["ask-again", "ask-again"],
        )

    async def test_input_action_is_sent_as_structured_authoring_data(self):
        await self.client.add_input_action(
            7,
            "Choose evidence",
            "Which evidence should be emphasized?",
            control="multi_select",
            source_layer=8,
            client_key="evidence-input",
            options=(("logs", "Logs"), ("traces", "Traces")),
            minimum_selections=1,
        )
        self.assertEqual(
            Handler.requests[-1][2],
            {
                "clientKey": "evidence-input",
                "sourceNodeId": 7,
                "sourceLayerId": 8,
                "kind": "input",
                "label": "Choose evidence",
                "control": "multi_select",
                "prompt": "Which evidence should be emphasized?",
                "options": [
                    {"key": "logs", "label": "Logs"},
                    {"key": "traces", "label": "Traces"},
                ],
                "minimumSelections": 1,
                "variant": "pill",
                "icon": None,
                "description": None,
            },
        )
        self.assertEqual(
            {key: Handler.requests[-1][2][key] for key in ("variant", "icon", "description")},
            {"variant": "pill", "icon": None, "description": None},
        )

    async def test_card_action_presentation_is_canonical_request_data(self):
        await self.client.add_navigate_action(
            7,
            "Compare approaches",
            9,
            relation="expand",
            source_layer=8,
            client_key="compare",
            variant="card",
            icon="git-compare",
            description="Lay out the tradeoffs before choosing.",
        )
        self.assertEqual(
            {
                key: Handler.requests[-1][2][key]
                for key in ("variant", "icon", "description", "targetLayerId", "relation", "sourceLayerId")
            },
            {
                "variant": "card",
                "icon": "git-compare",
                "description": "Lay out the tradeoffs before choosing.",
                "targetLayerId": 9,
                "relation": "expand",
                "sourceLayerId": 8,
            },
        )

    async def test_validation_errors_preserve_server_guidance(self):
        with self.assertRaisesRegex(ValidationError, "title is required") as raised:
            await self.client.submit_node(NodeObject("box", "", "detail"))
        self.assertEqual(raised.exception.issues[0].code, "node_title_required")
        self.assertIn("submit the node again", raised.exception.issues[0].message)

    async def test_large_layer_justification_is_request_only_authoring_data(self):
        layer = LayerObject(
            (1, 2, 3, 4, 5, 6),
            (),
            LayerLayoutObject(tuple(
                NodePlacementObject(node_id, index / 5, 0.5)
                for index, node_id in enumerate(range(1, 7))
            )),
            client_key="large",
        )
        await self.client.submit_layer(
            layer,
            size_justification="These six concepts must stay together for comparison.",
        )
        self.assertEqual(
            Handler.requests[-1][2]["sizeJustification"],
            "These six concepts must stay together for comparison.",
        )

    async def test_unsubmitted_layout_reference_fails_before_transport(self):
        pending = NodeObject("box", "Pending", "Not submitted")
        layer = LayerObject(
            (1,), (),
            LayerLayoutObject((NodePlacementObject(pending, 0.5, 0.5),)),
        )
        with self.assertRaisesRegex(ValueError, "must be submitted"):
            await self.client.submit_layer(layer)
        self.assertEqual(Handler.requests, [])

    async def test_internal_server_errors_are_not_classified_as_validation_errors(self):
        with self.assertRaisesRegex(APIError, "database failed") as raised:
            await self.client.submit_node(NodeObject("box", "server-error", "detail"))
        self.assertNotIsInstance(raised.exception, ValidationError)
        self.assertEqual(raised.exception.status, 500)

    async def test_from_env_and_unsubmitted_reference_guard(self):
        previous = os.environ.copy()
        try:
            os.environ.update({
                "RELAYER_GRAPH_URL": self.url,
                "RELAYER_GRAPH_TOKEN": "environment-token",
                "RELAYER_NODE_ID": "9",
            })
            client = RelayerGraphClient.from_env()
            self.assertEqual((client.url, client.token, client.node_id), (self.url, "environment-token", 9))
        finally:
            os.environ.clear()
            os.environ.update(previous)

        orphan = NodeObject("box", "Orphan", "Not submitted")
        with self.assertRaisesRegex(ValueError, "must be submitted"):
            await self.client.create_edge(orphan, 7)

    async def test_current_session_uses_the_prime_agent_host_scope(self):
        requests = []

        async def host_request(request_type):
            requests.append(request_type)
            return {"url": self.url, "token": "run-token", "nodeId": 11}

        previous = sys.modules.get("rlm")
        sys.modules["rlm"] = types.SimpleNamespace(host_request=host_request)
        try:
            graph = await GraphSession.current(timeout=4.0)
        finally:
            if previous is None:
                del sys.modules["rlm"]
            else:
                sys.modules["rlm"] = previous

        self.assertEqual(requests, ["relayer.graph.current"])
        self.assertEqual((graph.url, graph.token, graph.node_id, graph.timeout), (self.url, "run-token", 11, 4.0))
        with self.assertRaisesRegex(TypeError, "run-scoped"):
            pickle.dumps(graph)

    async def test_current_session_rejects_an_invalid_host_scope(self):
        async def host_request(_request_type):
            return {"url": self.url, "token": "", "nodeId": 0}

        previous = sys.modules.get("rlm")
        sys.modules["rlm"] = types.SimpleNamespace(host_request=host_request)
        try:
            with self.assertRaisesRegex(ConfigurationError, "invalid graph scope"):
                await GraphSession.current()
        finally:
            if previous is None:
                del sys.modules["rlm"]
            else:
                sys.modules["rlm"] = previous


class IconVocabularyTests(unittest.TestCase):
    def test_exports_curated_names_without_duplicates(self):
        self.assertIn("compass", RELAYER_ICON_NAMES)
        self.assertEqual(len(RELAYER_ICON_NAMES), len(set(RELAYER_ICON_NAMES)))

    def test_graph_node_parses_nullable_lease_identity(self):
        leased = GraphNode.from_dict({
            "id": 7, "leasedActionId": 11, "kind": "user-interaction", "icon": "user",
            "title": "Result", "detail": "Result", "state": "accepted",
        })
        ordinary = GraphNode.from_dict({
            "id": 8, "leasedActionId": None, "kind": "user-interaction", "icon": "user",
            "title": "Question", "detail": "Question", "state": "accepted",
        })
        self.assertEqual(leased.leased_action_id, 11)
        self.assertIsNone(ordinary.leased_action_id)
        positional = GraphNode(9, "concept", "box", "Legacy", "Legacy", "accepted")
        self.assertIsNone(positional.leased_action_id)

    def test_resolves_aliases_without_accepting_arbitrary_lucide_names(self):
        self.assertEqual(resolve_relayer_icon_name("CIRCLE_ALERT"), "alert-circle")
        self.assertEqual(resolve_relayer_icon_name("file pen"), "file-edit")
        self.assertFalse(is_supported_relayer_icon("alarm-clock"))
        self.assertFalse(is_supported_relayer_icon("🧭"))


if __name__ == "__main__":
    unittest.main()
