from __future__ import annotations

import asyncio
import json
import os
import pickle
import sys
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import HTTPRedirectHandler, Request

from relayer_graph import (APIError, CompletionCurrentSnapshot, CompletionInputGraph, CompletionTerminalError, CompletionWatch, ConfigurationError, EdgeObject, GraphNode, GraphSession,
                           EdgeEndObject, EdgeRouteObject, LayerLayoutObject, LayerObject, NodeObject,
                           NodePlacementObject,
                           RELAYER_ICON_NAMES, RelayerGraphClient, TransportError, ValidationError,
                           complete, is_supported_relayer_icon, resolve_relayer_icon_name)
from relayer_graph.completion import _OPENER


class Handler(BaseHTTPRequestHandler):
    requests = []
    next_id = 10
    # The port of a second server with this handler: the same host, another origin.
    other_port = 0
    # interactionNode -> (status, error) the broker answers when asked to start that child.
    # Bytes are sent as a raw non-JSON body.
    refused_starts = {
        86: (400, "x" * 200),
        87: (400, "The child was refused.\x7f"),
        88: (502, b"<html><body>502 Bad Gateway: /private/runtime/provider-secret</body></html>"),
        93: (409, "The harness configuration changed while this child was launching."),
        94: (422, "The source interaction has no model selection to inherit."),
        95: (500, "/private/runtime/provider-secret"),
        97: (400, "The child was refused.\nInjected: a second line"),
        98: (400, "x" * 201),
        # 101 characters but 202 UTF-16 units, which is how the TypeScript client measures it.
        99: (400, "\U0001F6AB" * 101),
    }

    def log_message(self, *args):
        pass

    def _reply(self, value, status=200):
        raw = isinstance(value, bytes)
        encoded = value if raw else json.dumps(value).encode()
        self.send_response(status)
        self.send_header("content-type", "text/html" if raw else "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))) or b"{}")
        Handler.requests.append((self.path, dict(self.headers), body))
        Handler.next_id += 1
        if self.path == "/api/completions" and body["interactionNode"] in Handler.refused_starts:
            status, error = Handler.refused_starts[body["interactionNode"]]
            self._reply(error if isinstance(error, bytes) else {"error": error}, status)
        elif self.path == "/api/graph/thread-icon":
            self._reply({"valid": body["icon"] == "compass"})
        elif self.path == "/api/completions":
            self._reply({"completionId": body["interactionNode"]}, 201)
        elif self.path == "/api/completions/80/stop":
            self._reply({"cancelled": True, "completionId": 80, "lifecycle": "stopped"}, 201)
        elif self.path == "/api/completions/91/stop":
            self._reply({
                "cancelled": True, "completionId": 91, "lifecycle": "stopped",
                "revision": 4, "reason": body["reason"],
            })
        elif self.path.endswith("/nodes") and body["title"] == "server-error":
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
            self._reply({"layer": {"id": Handler.next_id, "nodes": body["nodes"], "edges": body["edges"], "layout": body["layout"], "defaultNodeId": body.get("defaultNodeId"), "state": "draft"}})
        elif self.path.endswith("/discard"):
            layer_id = int(self.path.split("/")[-2])
            self._reply({"layer": {"id": layer_id, "nodes": [1], "edges": [], "state": "stopped"}})
        elif self.path.endswith("/current/transitions"):
            transition = body["transition"]
            self._reply({
                "completionId": 7,
                "revision": body["expectedRevision"] + 1,
                "lifecycle": "active",
                "currentLayerId": transition["layerId"],
                "finalLayerId": None,
                "operationKey": body["operationKey"],
                "requestDigest": "sha256:request",
                "snapshotDigest": "sha256:snapshot",
                "projectionSequence": 2,
            })
        elif self.path.endswith("/completions/prepare"):
            self._reply({"interactionNode": 91})
        else:
            self._reply({"ok": True})

    def do_GET(self):
        Handler.requests.append((self.path, dict(self.headers), None))
        child_92 = lambda revision, lifecycle="active": {
            "completionId": 92, "lifecycle": lifecycle, "headRevision": revision,
            "currentLayerId": 5, "finalLayerId": None,
        }
        child = lambda completion_id, lifecycle: {
            "completionId": completion_id, "lifecycle": lifecycle, "headRevision": 2,
            "currentLayerId": 5, "finalLayerId": None,
        }
        # Each redirect lands on child 77's current: on another host, on another port, or in the same origin.
        redirects = {
            "/api/completions/79/current": f"localhost:{self.server.server_port}",
            "/api/completions/76/current": f"127.0.0.1:{Handler.other_port}",
            "/api/completions/78/current": f"127.0.0.1:{self.server.server_port}",
        }
        if self.path in redirects:
            self.send_response(307)
            self.send_header("location", f"http://{redirects[self.path]}/api/completions/77/current")
            self.send_header("content-length", "0")
            self.end_headers()
        elif self.path == "/api/completions/80/current":
            self._reply(child(80, "active"), 201)
        elif self.path == "/api/completions/81/result":
            self._reply({"current": child(81, "failed"), "reason": "execution"}, 409)
        elif self.path == "/api/completions/75/result":
            self._reply({"current": child(75, "failed"), "reason": ""}, 409)
        elif self.path == "/api/completions/82/result":
            self._reply({"current": child(82, "stopped"), "reason": 42}, 409)
        elif self.path == "/api/completions/83/result":
            self._reply({"current": child(83, "active"), "reason": "execution"}, 409)
        elif self.path.startswith("/api/completions/85/result"):
            self._reply(b"<html><body>502 Bad Gateway: /private/runtime/provider-secret</body></html>", 502)
        elif self.path.startswith("/api/completions/96/result"):
            self._reply({"error": "completion does not belong to this execution"}, 400)
        elif self.path.startswith("/api/completions/89/result"):
            # A graph runtime conflict passes through without a current.
            self._reply({"error": {
                "code": "idempotency_conflict",
                "message": "This operation key is committed with a different transition request digest.",
            }}, 409)
        elif self.path == "/api/completions/92/result":
            self._reply({"current": child_92(3)}, 202)
        elif self.path == "/api/completions/92/result?afterRevision=3":
            # The first wait outlasts the broker's hold and comes back unchanged.
            waits = [path for path, _, _ in Handler.requests if path == self.path]
            self._reply({"current": child_92(3 if len(waits) == 1 else 4)}, 202)
        elif self.path == "/api/completions/92/result?afterRevision=4":
            self._reply({"current": child_92(6, "failed"), "reason": "execution"}, 409)
        elif self.path == "/api/completions/91/current":
            self._reply({
                "completionId": 91, "lifecycle": "active", "headRevision": 2,
                "currentLayerId": 8, "finalLayerId": None,
            })
        elif self.path == "/api/completions/91/result":
            self._reply({"current": {
                "completionId": 91, "lifecycle": "active", "headRevision": 3,
                "currentLayerId": 8, "finalLayerId": None,
            }}, 202)
        elif self.path == "/api/completions/91/result?afterRevision=3":
            self._reply({"layer": {"id": 9}, "nodes": [], "edges": [], "actions": []})
        elif self.path.endswith("/input"):
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
        elif self.path.endswith("/current"):
            self._reply({
                "completionId": 7,
                "lifecycle": "active",
                "headRevision": 0,
                "currentLayerId": None,
                "finalLayerId": None,
            })
        else:
            self._reply({"error": {"message": "not found"}}, 404)


class AuthoringClientTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"
        cls.other_server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.other_thread = threading.Thread(target=cls.other_server.serve_forever, daemon=True)
        cls.other_thread.start()
        Handler.other_port = cls.other_server.server_port

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join()
        cls.other_server.shutdown(); cls.other_server.server_close(); cls.other_thread.join()

    def setUp(self):
        Handler.requests.clear()
        self.client = RelayerGraphClient(self.url, "secret", 7)

    async def test_optional_thread_icon_proposal_uses_scoped_transport(self):
        self.assertFalse(await self.client.propose_thread_icon(None))
        self.assertFalse(await self.client.propose_thread_icon({}))
        self.assertEqual(Handler.requests, [])
        self.assertFalse(await self.client.propose_thread_icon("invalid"))
        self.assertTrue(await self.client.propose_thread_icon("compass"))
        self.assertEqual(Handler.requests[-1][0], "/api/graph/thread-icon")
        self.assertEqual(Handler.requests[-1][2], {"icon": "compass"})

    def test_routes_send_only_what_they_set(self):
        from relayer_graph.authoring import _route_payload
        self.assertEqual(_route_payload(EdgeRouteObject(4, shape="straight")), {"edgeId": 4, "shape": "straight"})
        self.assertEqual(
            _route_payload(EdgeRouteObject(4, ends=(EdgeEndObject(1, "top"), EdgeEndObject(2)), waypoints=({"x": 0.5, "y": 0.1}, (0.2, 0.3)))),
            {"edgeId": 4, "ends": [{"nodeId": 1, "side": "top"}, {"nodeId": 2}], "waypoints": [{"x": 0.5, "y": 0.1}, {"x": 0.2, "y": 0.3}]},
        )

    async def test_objects_receive_server_ids_and_compose_a_layer(self):
        queue = NodeObject("queue", "Queue", "Waiting work", client_key="queue")
        worker = NodeObject("worker", "Worker", "Claims work", client_key="worker")
        await self.client.submit_node(queue); await self.client.submit_node(worker)
        edge = EdgeObject((queue, worker), client_key="queue-worker")
        await self.client.create_edge(edge)
        layout = LayerLayoutObject((
            NodePlacementObject(queue, 0.25, 0.5),
            NodePlacementObject(worker, 0.75, 0.5),
        ), "elbow-horizontal", (
            EdgeRouteObject(edge, ends=(EdgeEndObject(worker, "top"), EdgeEndObject(queue)), waypoints=((0.5, 0.1),)),
        ))
        layer = LayerObject((queue, worker), (edge,), layout, client_key="root", default_node=worker)
        await self.client.submit_layer(layer)
        self.assertIsNotNone(queue.ref); self.assertIsNotNone(edge.ref); self.assertIsNotNone(layer.ref)
        self.assertEqual(Handler.requests[-1][2]["nodes"], [queue.ref.id, worker.ref.id])
        self.assertEqual(Handler.requests[-1][2]["layout"], {
            "version": 1,
            "placements": [
                {"nodeId": queue.ref.id, "x": 0.25, "y": 0.5},
                {"nodeId": worker.ref.id, "x": 0.75, "y": 0.5},
            ],
            "edgeShape": "elbow-horizontal",
            "edgeRoutes": [{
                "edgeId": edge.ref.id,
                "ends": [{"nodeId": worker.ref.id, "side": "top"}, {"nodeId": queue.ref.id}],
                "waypoints": [{"x": 0.5, "y": 0.1}],
            }],
        })
        self.assertEqual(layer.ref.layout.version, 1)
        self.assertEqual(layer.ref.layout.edge_shape, "elbow-horizontal")
        self.assertEqual(Handler.requests[-1][2]["defaultNodeId"], worker.ref.id)
        self.assertEqual(layer.ref.default_node_id, worker.ref.id)
        self.assertEqual(Handler.requests[0][1]["Authorization"], "Bearer secret")

    async def test_submit_and_completion_output_use_the_active_interaction(self):
        await self.client.submit()
        self.assertEqual(Handler.requests[-1][0], "/api/graph/submit")
        self.assertEqual(Handler.requests[-1][2], {"nodeId": 7})
        output = await self.client.get_completion_output()
        self.assertEqual(output["nodeId"], 7)
        self.assertEqual(Handler.requests[-1][0], "/api/graph/nodes/7/output")

    async def test_current_handle_reads_and_advances_with_explicit_cas_identity(self):
        current = await self.client.get_current()
        self.assertEqual(current["headRevision"], 0)
        receipt = await self.client.advance_current(
            19, expected_revision=0, operation_key="publish-progress"
        )
        self.assertEqual(receipt["revision"], 1)
        self.assertEqual(Handler.requests[-1][0], "/api/graph/current/transitions")
        self.assertEqual(Handler.requests[-1][2], {
            "expectedRevision": 0,
            "operationKey": "publish-progress",
            "transition": {"kind": "advance", "layerId": 19},
        })

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
        layout = LayerLayoutObject((NodePlacementObject(1, 0.5, 0.5),), "default")
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
        await self.client.add_invoke_action(7, "Ask", "Continue", source_layer=8, client_key="ask-again", input_actions=(21, 22))
        await self.client.add_invoke_action(7, "Ask", "Continue", source_layer=8, client_key="ask-again", input_actions=(21, 22))
        self.assertEqual(
            [request[2]["clientKey"] for request in Handler.requests[-2:]],
            ["ask-again", "ask-again"],
        )
        self.assertEqual([request[2]['inputActionIds'] for request in Handler.requests[-2:]], [[21, 22], [21, 22]])
        self.assertEqual([request[2]['reusable'] for request in Handler.requests[-2:]], [False, False])
        await self.client.add_invoke_action(7, "Compare", "Continue", source_layer=8, client_key="compare", reusable=True)
        self.assertTrue(Handler.requests[-1][2]['reusable'])

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

        await self.client.add_input_action(
            7,
            "Explain",
            "Explain the tradeoff",
            control="text",
            source_layer=8,
            client_key="text-input",
        )
        self.assertNotIn("options", Handler.requests[-1][2])

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
            ), "default"),
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
            LayerLayoutObject((NodePlacementObject(pending, 0.5, 0.5),), "default"),
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

    async def test_prepares_a_canonical_child_pointer_from_a_persisted_invoke(self):
        prepared = await self.client.prepare_complete({"action": {"id": 44}}, "stable-child")
        self.assertEqual(prepared.interaction_node, 91)
        path, headers, body = Handler.requests[-1]
        self.assertEqual(path, "/api/graph/completions/prepare")
        self.assertEqual(headers["Authorization"], f"Bearer {self.client.token}")
        self.assertEqual(body, {"actionId": 44, "invocationKey": "stable-child"})

    async def test_omitted_invocation_keys_create_independent_calls(self):
        await self.client.prepare_complete(44)
        first = Handler.requests[-1][2]
        await self.client.prepare_complete(44)
        second = Handler.requests[-1][2]
        self.assertEqual(first["actionId"], 44)
        self.assertEqual(second["actionId"], 44)
        self.assertRegex(first["invocationKey"], r"^[a-f0-9-]{36}$")
        self.assertNotEqual(first["invocationKey"], second["invocationKey"])

    async def test_complete_returns_a_live_handle_before_broker_settlement(self):
        previous = os.environ.copy()
        try:
            os.environ["RELAYER_COMPLETE_URL"] = self.url + "/api/completions"
            os.environ["RELAYER_COMPLETE_TOKEN"] = "broker-token"
            handle = complete(CompletionInputGraph(91))
            self.assertEqual(handle.completion_id, 91)
            current = await handle.current.snapshot()
            self.assertEqual((current.lifecycle, current.revision, current.current_layer_id), ("active", 2, 8))
            result = await handle.result
            self.assertEqual(result["layer"]["id"], 9)
        finally:
            os.environ.clear()
            os.environ.update(previous)

    async def test_complete_observes_nothing_until_the_child_result_is_awaited(self):
        previous = os.environ.copy()
        try:
            os.environ["RELAYER_COMPLETE_URL"] = self.url + "/api/completions"
            os.environ["RELAYER_COMPLETE_TOKEN"] = "broker-token"
            handle = complete(CompletionInputGraph(91))
            await handle.current.snapshot()
            self.assertEqual(
                [path for path, _, _ in Handler.requests if "/result" in path], []
            )
            await handle.result
            self.assertEqual(
                [path for path, _, _ in Handler.requests if "/result" in path],
                ["/api/completions/91/result", "/api/completions/91/result?afterRevision=3"],
            )
        finally:
            os.environ.clear()
            os.environ.update(previous)

    async def test_complete_awaits_one_observation_however_often_the_result_is_read(self):
        previous = os.environ.copy()
        try:
            os.environ["RELAYER_COMPLETE_URL"] = self.url + "/api/completions"
            os.environ["RELAYER_COMPLETE_TOKEN"] = "broker-token"
            handle = complete(CompletionInputGraph(91))
            first, second = await asyncio.gather(handle.result, handle.result)
            self.assertIs(first, second)
            self.assertEqual(
                len([path for path, _, _ in Handler.requests if "/result" in path]), 2
            )
        finally:
            os.environ.clear()
            os.environ.update(previous)

    async def test_stop_asks_the_broker_to_stop_the_child_it_invoked(self):
        previous = os.environ.copy()
        try:
            os.environ["RELAYER_COMPLETE_URL"] = self.url + "/api/completions"
            os.environ["RELAYER_COMPLETE_TOKEN"] = "broker-token"
            handle = complete(CompletionInputGraph(91))
            await handle.stop("the parent no longer needs this branch")
            path, headers, body = Handler.requests[-1]
            self.assertEqual(path, "/api/completions/91/stop")
            self.assertEqual(headers["Authorization"], "Bearer broker-token")
            self.assertEqual(body, {"reason": "the parent no longer needs this branch"})
        finally:
            os.environ.clear()
            os.environ.update(previous)

    async def test_next_waits_for_the_childs_current_to_move_past_what_the_parent_saw(self):
        previous = os.environ.copy()
        try:
            os.environ["RELAYER_COMPLETE_URL"] = self.url + "/api/completions"
            os.environ["RELAYER_COMPLETE_TOKEN"] = "broker-token"
            handle = complete(CompletionInputGraph(92))
            first = await handle.current.next()
            moved = await handle.current.next(first.revision)
            ended = await handle.current.next(moved.revision)
            self.assertEqual(
                [(first.revision, first.lifecycle), (moved.revision, moved.lifecycle), (ended.revision, ended.lifecycle)],
                [(3, "active"), (4, "active"), (6, "failed")],
            )
            self.assertEqual(
                [path for path, _, _ in Handler.requests if "/92/result" in path],
                [
                    "/api/completions/92/result",
                    "/api/completions/92/result?afterRevision=3",
                    "/api/completions/92/result?afterRevision=3",
                    "/api/completions/92/result?afterRevision=4",
                ],
            )
        finally:
            os.environ.clear()
            os.environ.update(previous)

    async def test_a_refused_child_launch_keeps_the_brokers_safe_detail(self):
        previous = os.environ.copy()
        try:
            os.environ["RELAYER_COMPLETE_URL"] = self.url + "/api/completions"
            os.environ["RELAYER_COMPLETE_TOKEN"] = "broker-token"
            for node, message in (
                (94, "HTTP 422: The source interaction has no model selection to inherit."),
                # Exactly the longest detail the broker's message may have.
                (86, "HTTP 400: " + "x" * 200),
            ):
                with self.subTest(node=node):
                    with self.assertRaises(TransportError) as raised:
                        await complete(CompletionInputGraph(node)).result
                    self.assertEqual(str(raised.exception), f"completion broker returned {message}")
        finally:
            os.environ.clear()
            os.environ.update(previous)

    async def test_a_refused_child_launch_withholds_broker_detail_that_is_not_safe_to_repeat(self):
        previous = os.environ.copy()
        try:
            os.environ["RELAYER_COMPLETE_URL"] = self.url + "/api/completions"
            os.environ["RELAYER_COMPLETE_TOKEN"] = "broker-token"
            # Server failures (one without a JSON body), control characters, and overlong messages.
            for node, status in ((95, 500), (88, 502), (97, 400), (87, 400), (98, 400), (99, 400)):
                with self.subTest(node=node):
                    with self.assertRaises(TransportError) as raised:
                        await complete(CompletionInputGraph(node)).result
                    self.assertEqual(str(raised.exception), f"completion broker returned HTTP {status}")
        finally:
            os.environ.clear()
            os.environ.update(previous)

    async def test_a_refused_observation_keeps_the_brokers_safe_detail(self):
        previous = os.environ.copy()
        try:
            os.environ["RELAYER_COMPLETE_URL"] = self.url + "/api/completions"
            os.environ["RELAYER_COMPLETE_TOKEN"] = "broker-token"
            for node, message in (
                (96, "HTTP 400: completion does not belong to this execution"),
                # A refusal whose error is not a string names only its status.
                (89, "HTTP 409"),
                # So does a refusal without a JSON body, such as a proxy's error page.
                (85, "HTTP 502"),
            ):
                handle = complete(CompletionInputGraph(node))
                for name, observe in (("result", lambda: handle.result), ("next", handle.current.next)):
                    with self.subTest(node=node, observe=name):
                        with self.assertRaises(TransportError) as raised:
                            await observe()
                        self.assertEqual(str(raised.exception), f"completion broker returned {message}")
        finally:
            os.environ.clear()
            os.environ.update(previous)

    async def test_result_rejects_with_a_terminal_error_only_for_a_stopped_or_failed_child(self):
        previous = os.environ.copy()
        try:
            os.environ["RELAYER_COMPLETE_URL"] = self.url + "/api/completions"
            os.environ["RELAYER_COMPLETE_TOKEN"] = "broker-token"
            for node, lifecycle, reason in (
                (81, "failed", "execution"),
                (75, "failed", ""),
                # A reason that is not a string is not repeated.
                (82, "stopped", "completion_failed"),
            ):
                with self.subTest(node=node):
                    with self.assertRaises(CompletionTerminalError) as raised:
                        await complete(CompletionInputGraph(node)).result
                    self.assertEqual(
                        (raised.exception.completion_id, raised.exception.lifecycle, raised.exception.reason),
                        (node, lifecycle, reason),
                    )
            # A conflict whose current is still active is a broker refusal, not a terminal state.
            with self.assertRaises(TransportError) as raised:
                await complete(CompletionInputGraph(83)).result
            self.assertEqual(str(raised.exception), "completion broker returned HTTP 409")
        finally:
            os.environ.clear()
            os.environ.update(previous)

    async def test_current_and_stop_accept_only_the_status_the_broker_answers_them_with(self):
        previous = os.environ.copy()
        try:
            os.environ["RELAYER_COMPLETE_URL"] = self.url + "/api/completions"
            os.environ["RELAYER_COMPLETE_TOKEN"] = "broker-token"
            handle = complete(CompletionInputGraph(80))
            for name, call in (("snapshot", handle.current.snapshot), ("stop", lambda: handle.stop("done"))):
                with self.subTest(call=name):
                    with self.assertRaises(TransportError) as raised:
                        await call()
                    self.assertEqual(str(raised.exception), "completion broker returned HTTP 201")
        finally:
            os.environ.clear()
            os.environ.update(previous)

    async def test_a_redirect_carries_the_broker_token_only_within_the_brokers_origin(self):
        previous = os.environ.copy()
        try:
            os.environ["RELAYER_COMPLETE_URL"] = self.url + "/api/completions"
            os.environ["RELAYER_COMPLETE_TOKEN"] = "broker-token"
            port, other_port = self.server.server_port, self.other_server.server_port
            for node, host, authorization in (
                (79, f"localhost:{port}", None),
                (76, f"127.0.0.1:{other_port}", None),
                (78, f"127.0.0.1:{port}", "Bearer broker-token"),
            ):
                with self.subTest(node=node):
                    Handler.requests.clear()
                    await complete(CompletionInputGraph(node)).current.snapshot()
                    [(_, headers, _)] = [r for r in Handler.requests if r[0] == "/api/completions/77/current"]
                    self.assertEqual(headers["Host"], host)
                    self.assertEqual(headers.get("Authorization"), authorization)
        finally:
            os.environ.clear()
            os.environ.update(previous)

    def test_a_redirect_to_another_scheme_does_not_carry_the_broker_token(self):
        # The client's own redirect handler decides before the redirected request is sent, so no TLS broker is needed.
        [redirects] = [handler for handler in _OPENER.handlers if isinstance(handler, HTTPRedirectHandler)]
        port = self.server.server_port
        request = Request(f"http://127.0.0.1:{port}/api/completions/79/current", headers={"authorization": "Bearer broker-token"})
        redirected = redirects.redirect_request(
            request, None, 307, "Temporary Redirect", {}, f"https://127.0.0.1:{port}/api/completions/77/current"
        )
        self.assertEqual(redirected.full_url, f"https://127.0.0.1:{port}/api/completions/77/current")
        self.assertFalse(redirected.has_header("Authorization"))

    @staticmethod
    def _held_children():
        """Children whose next() calls stay open until the test resolves or fails them by id:after_revision."""
        releases: dict[str, asyncio.Future] = {}
        asked: list[str] = []

        class Current:
            def __init__(self, completion_id):
                self.completion_id = completion_id

            async def next(self, after_revision=None):
                key = f"{self.completion_id}:{'-' if after_revision is None else after_revision}"
                asked.append(key)
                releases[key] = asyncio.get_running_loop().create_future()
                return await releases[key]

        class Child:
            def __init__(self, completion_id):
                self.completion_id = completion_id
                self.current = Current(completion_id)

        return releases, asked, Child

    async def test_a_watch_reports_each_childs_change_as_its_own_event(self):
        def snapshot(completion_id, revision, lifecycle="active"):
            return CompletionCurrentSnapshot(completion_id, lifecycle, revision, revision, None)

        async def turns():
            for _ in range(5):
                await asyncio.sleep(0)

        releases, asked, Child = self._held_children()
        watch = CompletionWatch([Child(1), Child(2)])
        first = asyncio.ensure_future(watch.changes())
        await turns()
        releases["1:-"].set_result(snapshot(1, 0))
        self.assertEqual([(child.completion_id, current.revision) for child, current in await first], [(1, 0)])

        # Child 2's first request is still open, so it is not asked again.
        second = asyncio.ensure_future(watch.changes())
        await turns()
        releases["2:-"].set_result(snapshot(2, 0))
        releases["1:0"].set_result(snapshot(1, 1))
        await turns()
        self.assertEqual(
            sorted((child.completion_id, current.revision) for child, current in await second),
            [(1, 1), (2, 0)],
        )

        third = asyncio.ensure_future(watch.changes())
        await turns()
        releases["1:1"].set_result(snapshot(1, 2, "succeeded"))
        releases["2:0"].set_result(snapshot(2, 1, "failed"))
        await turns()
        self.assertEqual(sorted(current.lifecycle for _, current in await third), ["failed", "succeeded"])
        self.assertTrue(watch.settled)
        self.assertEqual(await watch.changes(), [])
        self.assertEqual(asked, ["1:-", "2:-", "1:0", "1:1", "2:0"])

    async def test_overlapping_watch_calls_each_return_their_own_event(self):
        async def turns():
            for _ in range(5):
                await asyncio.sleep(0)

        releases, asked, Child = self._held_children()
        watch = CompletionWatch([Child(1), Child(2)])
        first = asyncio.ensure_future(watch.changes())
        second = asyncio.ensure_future(watch.changes())
        await turns()
        releases["1:-"].set_result(CompletionCurrentSnapshot(1, "active", 0, 0, None))
        self.assertEqual([(child.completion_id, current.revision) for child, current in await first], [(1, 0)])

        # The second call starts after the first returns, so it waits for the next event.
        await turns()
        releases["2:-"].set_result(CompletionCurrentSnapshot(2, "active", 0, 0, None))
        self.assertEqual([(child.completion_id, current.revision) for child, current in await second], [(2, 0)])
        self.assertEqual(asked, ["1:-", "2:-", "1:0"])

    async def test_a_watch_reports_a_child_it_can_no_longer_observe_once_and_keeps_its_sibling(self):
        async def turns():
            for _ in range(5):
                await asyncio.sleep(0)

        releases, asked, Child = self._held_children()
        watch = CompletionWatch([Child(1), Child(2)])
        first = asyncio.ensure_future(watch.changes())
        await turns()
        releases["1:-"].set_result(CompletionCurrentSnapshot(1, "active", 0, 0, None))
        await first

        # Child 1's observation fails while child 2 moves; both reach the parent together.
        second = asyncio.ensure_future(watch.changes())
        await turns()
        releases["1:0"].set_exception(TransportError("completion broker returned HTTP 500"))
        releases["2:-"].set_result(CompletionCurrentSnapshot(2, "active", 0, 0, None))
        await turns()
        reported = sorted(await second, key=lambda change: change[0].completion_id)
        self.assertEqual([child.completion_id for child, _ in reported], [1, 2])
        self.assertIsInstance(reported[0][1], TransportError)
        self.assertEqual(str(reported[0][1]), "completion broker returned HTTP 500")
        self.assertEqual(reported[1][1].revision, 0)
        self.assertFalse(watch.settled)

        # Child 1 is not asked again; child 2's later events still arrive and settle the watch.
        third = asyncio.ensure_future(watch.changes())
        await turns()
        releases["2:0"].set_result(CompletionCurrentSnapshot(2, "succeeded", 1, 1, 1))
        self.assertEqual([(child.completion_id, current.lifecycle) for child, current in await third], [(2, "succeeded")])
        self.assertTrue(watch.settled)
        self.assertEqual(await watch.changes(), [])
        self.assertEqual(asked, ["1:-", "2:-", "1:0", "2:0"])

    async def test_a_watch_reports_a_child_whose_start_the_broker_refuses(self):
        previous = os.environ.copy()
        try:
            os.environ["RELAYER_COMPLETE_URL"] = self.url + "/api/completions"
            os.environ["RELAYER_COMPLETE_TOKEN"] = "broker-token"
            releases, _, Child = self._held_children()
            refused = complete(CompletionInputGraph(93))
            watch = CompletionWatch([refused, Child(2)])

            [(child, error)] = await watch.changes()
            self.assertIs(child, refused)
            self.assertIsInstance(error, TransportError)
            self.assertEqual(
                str(error),
                "completion broker returned HTTP 409: The harness configuration changed while this child was launching.",
            )

            later = asyncio.ensure_future(watch.changes())
            await asyncio.sleep(0)
            releases["2:-"].set_result(CompletionCurrentSnapshot(2, "failed", 0, 0, None))
            self.assertEqual([(child.completion_id, current.lifecycle) for child, current in await later], [(2, "failed")])
            self.assertTrue(watch.settled)
        finally:
            os.environ.clear()
            os.environ.update(previous)

    async def test_a_watch_reports_a_cancelled_observation_without_raising(self):
        async def turns():
            for _ in range(5):
                await asyncio.sleep(0)

        releases, asked, Child = self._held_children()
        watch = CompletionWatch([Child(1), Child(2)])
        first = asyncio.ensure_future(watch.changes())
        await turns()
        releases["1:-"].set_result(CompletionCurrentSnapshot(1, "succeeded", 0, 0, 0))
        releases["2:-"].cancel()
        await turns()
        reported = sorted(await first, key=lambda change: change[0].completion_id)
        self.assertEqual(reported[0][1].lifecycle, "succeeded")
        self.assertIsInstance(reported[1][1], TransportError)
        self.assertTrue(watch.settled)
        self.assertEqual(asked, ["1:-", "2:-"])

    async def test_completion_current_rejects_coerced_identity_fields(self):
        with self.assertRaisesRegex(TransportError, "invalid revision"):
            CompletionCurrentSnapshot.from_dict({
                "completionId": 91,
                "lifecycle": "active",
                "headRevision": "2",
                "currentLayerId": 8,
                "finalLayerId": None,
            })

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
        self.assertTrue(is_supported_relayer_icon("alarm-clock"))
        self.assertFalse(is_supported_relayer_icon("🧭"))


if __name__ == "__main__":
    unittest.main()
