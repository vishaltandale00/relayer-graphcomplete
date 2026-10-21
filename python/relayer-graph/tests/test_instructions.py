import json
import sys
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import AsyncMock, patch

from relayer_graph import APIError, GraphQueryError, GraphSearchRequest, GraphSession, RelayerGraphClient


class InstructionHandler(BaseHTTPRequestHandler):
    response = {}
    status = 200
    requests = []

    def log_message(self, *_args):
        pass

    def respond(self, body):
        type(self).requests.append((self.command, self.path, body, self.headers.get("authorization")))
        encoded = json.dumps(type(self).response).encode()
        self.send_response(type(self).status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        self.respond(None)

    def do_POST(self):
        self.respond(json.loads(self.rfile.read(int(self.headers["content-length"]))))


class InstructionClientTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), InstructionHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        InstructionHandler.requests.clear()
        InstructionHandler.status = 200
        self.graph = RelayerGraphClient(self.url, "fixture-token", 7)

    async def test_manifest_and_delivery_receipts_preserve_server_replay_suppression_and_reread(self):
        manifest = {"versionKey": "prime-agent-instruction-graph-v2", "digest": "a" * 64,
                    "retrievalContractVersion": 2, "modules": [{"key": "authority", "nodeId": 99, "prerequisites": []}]}
        InstructionHandler.response = manifest
        self.assertEqual(await self.graph.get_instruction_graph(), manifest)
        reason = {"purpose": "authoring", "detail": "Publish the actual task finding"}
        for delivery, replayed, reread in [("body", False, None), ("already-returned", False, None),
                                           ("body", True, None), ("reread", False, "Distinct native helper context")]:
            receipt = {"versionKey": manifest["versionKey"], "digest": manifest["digest"],
                       "requestKey": "exact-request", "replayed": replayed, "reason": reason,
                       "entries": [{"nodeId": 99, "delivery": delivery, "bodyCharacters": 0 if delivery == "already-returned" else 4}]}
            if delivery != "already-returned":
                receipt["entries"][0]["detail"] = "Text"
            InstructionHandler.response = receipt
            # Distinct Python instances must not manufacture their own delivery cache.
            client = RelayerGraphClient(self.url, "fixture-token", 7)
            result = await client.retrieve_instructions(request_key="exact-request", node_ids=[99], reason=reason, reread_reason=reread)
            self.assertEqual(result, receipt)
            _, path, body, authorization = InstructionHandler.requests[-1]
            self.assertEqual(path, "/api/graph/instruction-graph/retrieve")
            self.assertEqual(authorization, "Bearer fixture-token")
            self.assertEqual(body, {"requestKey": "exact-request", "nodeIds": [99], "reason": reason,
                                    **({"rereadReason": reread} if reread else {})})

    async def test_reasoned_search_uses_scoped_route_and_rejects_target_without_transport(self):
        result = {"queryContractVersion": 1, "columns": ["title"], "rows": [], "truncated": False}
        InstructionHandler.response = result
        reason = {"purpose": "search", "detail": "Locate the exact CSS topic"}
        query = GraphSearchRequest("MATCH (n:Content) WHERE n.title = $title RETURN n.title AS title",
                                   parameters={"title": {"type": "string", "value": "CSS"}})
        self.assertEqual(await self.graph.search_instructions(query, reason=reason), result)
        _, path, body, _ = InstructionHandler.requests[-1]
        self.assertEqual(path, "/api/graph/instruction-graph/search")
        self.assertEqual(body, {**query.to_wire(), "reason": reason})
        before = len(InstructionHandler.requests)
        with self.assertRaisesRegex(ValueError, "target selector"):
            await self.graph.search_instructions(GraphSearchRequest(query.query, target={"scope": "thread", "id": 999}), reason=reason)
        self.assertEqual(len(InstructionHandler.requests), before)

    async def test_query_errors_unavailability_and_wrong_response_versions_stay_distinct(self):
        query = GraphSearchRequest("MATCH (n:Content) RETURN n.title AS title")
        InstructionHandler.response = {"error": {"code": "query_syntax_invalid", "phase": "parse", "path": "query", "message": "Rejected"}}
        InstructionHandler.status = 422
        with self.assertRaises(GraphQueryError) as error:
            await self.graph.search_instructions(query)
        self.assertEqual((error.exception.code, error.exception.phase), ("query_syntax_invalid", "parse"))
        InstructionHandler.status = 503
        InstructionHandler.response = {"error": {"code": "search_unavailable", "message": "Unavailable"}}
        with self.assertRaises(APIError) as error:
            await self.graph.search_instructions(query)
        self.assertNotIsInstance(error.exception, GraphQueryError)
        InstructionHandler.status = 200
        InstructionHandler.response = {"queryContractVersion": True, "rows": []}
        with self.assertRaisesRegex(APIError, "query contract version 1"):
            await self.graph.search_instructions(query)

    async def test_prime_compiler_reference_is_a_bounded_named_host_read(self):
        reference = {"cssProperties": ["display", "gap"], "limits": {"maxComponents": 64}}
        request = AsyncMock(return_value=reference)
        with patch.dict(sys.modules, {"rlm": types.SimpleNamespace(host_request=request)}):
            graph = GraphSession("http://graph.test", "fixture-token", 7)
            self.assertEqual(await graph.detail_authoring_reference(), reference)
        request.assert_awaited_once_with("relayer.graph.detail-authoring-reference")
