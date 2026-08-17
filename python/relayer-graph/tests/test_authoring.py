from __future__ import annotations

import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from relayer_graph import APIError, EdgeObject, LayerObject, NodeObject, RelayerGraphClient, ValidationError


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
            self._reply({"error": {"message": "title is required"}}, 422)
        elif self.path.endswith("/nodes"):
            self._reply({"node": {"id": Handler.next_id, "kind": body["kind"], "icon": body["icon"], "title": body["title"], "detail": body["detail"], "state": "draft"}})
        elif self.path.endswith("/edges"):
            self._reply({"edge": {"id": Handler.next_id, "endpoints": body["endpoints"], "state": "draft"}})
        elif self.path.endswith("/layers"):
            self._reply({"layer": {"id": Handler.next_id, "nodes": body["nodes"], "edges": body["edges"], "state": "draft"}})
        else:
            self._reply({"ok": True})

    def do_GET(self):
        Handler.requests.append((self.path, dict(self.headers), None))
        if self.path.endswith("/output"):
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
        layer = LayerObject((queue, worker), (edge,), client_key="root")
        await self.client.submit_layer(layer)
        self.assertIsNotNone(queue.ref); self.assertIsNotNone(edge.ref); self.assertIsNotNone(layer.ref)
        self.assertEqual(Handler.requests[-1][2]["nodes"], [queue.ref.id, worker.ref.id])
        self.assertEqual(Handler.requests[0][1]["Authorization"], "Bearer secret")

    async def test_submit_and_completion_output_use_the_active_interaction(self):
        await self.client.submit()
        self.assertEqual(Handler.requests[-1][0], "/api/graph/submit")
        self.assertEqual(Handler.requests[-1][2], {"nodeId": 7})
        output = await self.client.get_completion_output()
        self.assertEqual(output["nodeId"], 7)
        self.assertEqual(Handler.requests[-1][0], "/api/graph/nodes/7/output")

    async def test_action_retries_use_the_caller_owned_key(self):
        await self.client.add_invoke_action(7, "Ask", "Continue", client_key="ask-again")
        await self.client.add_invoke_action(7, "Ask", "Continue", client_key="ask-again")
        self.assertEqual(
            [request[2]["clientKey"] for request in Handler.requests[-2:]],
            ["ask-again", "ask-again"],
        )

    async def test_validation_errors_preserve_server_guidance(self):
        with self.assertRaisesRegex(ValidationError, "title is required"):
            await self.client.submit_node(NodeObject("box", "", "detail"))

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


if __name__ == "__main__":
    unittest.main()
