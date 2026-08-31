from __future__ import annotations

import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from relayer_graph import (APIError, GraphQueryError, GraphSearchRequest,
                           RelayerGraphClient)
from relayer_graph.query_errors_generated import (GRAPH_QUERY_CONTRACT_VERSION,
                                                  GRAPH_QUERY_ERROR_PHASES)


GOLDEN = json.loads((Path(__file__).parents[3] / "packages" / "graph-client" /
                     "test" / "graph-search-wire-golden.json").read_text())
ERROR_CONTRACT = json.loads((Path(__file__).parents[3] / "docs" /
                             "graph-query-v1-errors.json").read_text())


class SearchHandler(BaseHTTPRequestHandler):
    response = GOLDEN["result"]
    status = 200
    requests: list[tuple[str, dict[str, object]]] = []

    def log_message(self, *_args: object) -> None:
        pass

    def do_POST(self) -> None:
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))))
        SearchHandler.requests.append((self.path, body))
        encoded = json.dumps(SearchHandler.response, separators=(",", ":")).encode()
        self.send_response(SearchHandler.status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


class GraphSearchClientTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), SearchHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.client = RelayerGraphClient(
            f"http://127.0.0.1:{cls.server.server_port}", "secret", 7
        )

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self) -> None:
        SearchHandler.response = GOLDEN["result"]
        SearchHandler.status = 200
        SearchHandler.requests.clear()

    async def test_shared_golden_preserves_recursive_values_order_and_truncation(self) -> None:
        request = GraphSearchRequest(
            GOLDEN["request"]["query"],
            parameters=GOLDEN["request"]["parameters"],
            budget=GOLDEN["request"]["budget"],
        )

        result = await self.client.search(request)

        self.assertEqual(result, GOLDEN["result"])
        self.assertEqual(result["columns"], [
            "null", "boolean", "integer", "float", "string", "node", "layer",
            "relationship", "path", "list", "record",
        ])
        self.assertEqual(result["rows"][0][2]["value"], "9223372036854775807")
        self.assertEqual([value["type"] for value in result["rows"][0]], [
            "null", "boolean", "integer", "float", "string", "node", "layer",
            "relationship", "path", "list", "record",
        ])
        self.assertTrue(result["truncated"])

    async def test_request_has_optional_resolved_target_but_no_authority_override_surface(self) -> None:
        request = GraphSearchRequest(
            GOLDEN["request"]["query"],
            parameters=GOLDEN["request"]["parameters"],
            budget=GOLDEN["request"]["budget"],
            target={"scope": "project", "id": 99,
                    "credential": "nested-leak", "database": "graph.db"},  # type: ignore[typeddict-unknown-key]
        )

        await self.client.search(request)

        path, body = SearchHandler.requests[-1]
        self.assertEqual(path, "/api/graph/search")
        self.assertEqual(body, {
            **GOLDEN["request"],
            "target": {"scope": "project", "id": 99},
        })
        self.assertEqual(list(body), [
            "queryContractVersion", "target", "query", "parameters", "budget",
        ])
        for forbidden in ("project", "projectId", "thread",
                          "threadId", "permit", "token", "authority"):
            self.assertNotIn(forbidden, body)

        await self.client.search(GraphSearchRequest(GOLDEN["request"]["query"]))
        self.assertNotIn("target", SearchHandler.requests[-1][1])

    async def test_contract_error_and_api_unavailability_are_distinct(self) -> None:
        request = GraphSearchRequest(GOLDEN["request"]["query"])
        SearchHandler.response = GOLDEN["contractError"]
        SearchHandler.status = 422

        with self.assertRaises(GraphQueryError) as raised:
            await self.client.search(request)
        self.assertEqual(
            (raised.exception.status, raised.exception.code,
             raised.exception.phase, raised.exception.path),
            (422, "query_syntax_invalid", "parse", "query"),
        )

        SearchHandler.response = GOLDEN["unavailableError"]
        SearchHandler.status = 503
        with self.assertRaises(APIError) as unavailable:
            await self.client.search(request)
        self.assertNotIsInstance(unavailable.exception, GraphQueryError)
        self.assertEqual(unavailable.exception.status, 503)

        for response in (
            {"error": {"code": "search_unavailable", "phase": "execute",
                       "path": "search", "message": "offline"}},
            {"error": {"code": "future_query_failure", "phase": "execute",
                       "path": "query", "message": "future"}},
            {"error": {"code": "query_syntax_invalid", "phase": "execute",
                       "path": "query", "message": "wrong phase"}},
        ):
            SearchHandler.response = response
            SearchHandler.status = 503
            with self.assertRaises(APIError) as generic:
                await self.client.search(request)
            self.assertNotIsInstance(generic.exception, GraphQueryError)

    def test_generated_error_discriminator_matches_the_shared_v1_artifact(self) -> None:
        self.assertEqual(ERROR_CONTRACT["queryContractVersion"], 1)
        self.assertEqual(
            GRAPH_QUERY_CONTRACT_VERSION,
            ERROR_CONTRACT["queryContractVersion"],
        )
        self.assertEqual(
            GRAPH_QUERY_ERROR_PHASES,
            {item["code"]: item["phase"] for item in ERROR_CONTRACT["errors"]},
        )

    async def test_success_requires_exact_query_contract_v1(self) -> None:
        request = GraphSearchRequest(GOLDEN["request"]["query"])
        for response in (
            {**GOLDEN["result"], "queryContractVersion": 2},
            {"columns": [], "rows": [], "truncated": False},
            {**GOLDEN["result"], "queryContractVersion": "1"},
            {**GOLDEN["result"], "queryContractVersion": True},
            {**GOLDEN["result"], "queryContractVersion": 1.0},
            {**GOLDEN["result"], "queryContractVersion": 1.5},
        ):
            SearchHandler.response = response
            SearchHandler.status = 200
            with self.assertRaises(APIError) as raised:
                await self.client.search(request)
            self.assertNotIsInstance(raised.exception, GraphQueryError)
            self.assertEqual(raised.exception.status, 200)


if __name__ == "__main__":
    unittest.main()
