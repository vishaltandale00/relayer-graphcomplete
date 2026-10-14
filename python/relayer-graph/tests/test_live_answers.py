import asyncio
import unittest
from relayer_graph import RelayerGraphClient

class LiveAnswerTests(unittest.IsolatedAsyncioTestCase):
    async def test_cursor_terminal_and_polling_timeout(self):
        graph = RelayerGraphClient("http://graph.test", "scoped", 1)
        calls = []
        async def request(method, path, **_options):
            calls.append((method, path))
            return {"current": {"lifecycle": "active"}, "answers": [], "nextSequence": 4}
        graph._request = request
        self.assertEqual((await graph.wait_for_live_answers(3, 0))["answers"], [])
        self.assertEqual(calls, [("GET", "/api/graph/live-answers?afterSequence=3")])
        for cursor in (-1, True, 0.5):
            with self.assertRaises(ValueError): await graph.get_live_answers(cursor)
        async def stopped(method, path, **_options): return {"current": {"lifecycle": "stopped"}, "answers": []}
        graph._request = stopped
        self.assertEqual((await graph.wait_for_live_answers())["current"]["lifecycle"], "stopped")

    async def test_deadline_and_caller_cancellation_cover_pending_transport(self):
        graph = RelayerGraphClient("http://graph.test", "scoped", 1)
        reached = asyncio.Event()
        async def request(method, path, **_options):
            reached.set()
            await asyncio.Event().wait()
        graph._request = request
        with self.assertRaises(TimeoutError): await graph.wait_for_live_answers(timeout_seconds=0.01)
        reached.clear()
        pending = asyncio.create_task(graph.wait_for_live_answers())
        await reached.wait()
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError): await pending

    async def test_real_socket_budget_settles_workers_after_timeout_and_cancellation(self):
        import contextlib
        import json
        import threading
        import urllib.request
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        from unittest.mock import patch

        for scenario in ("initial", "after-empty", "cancel"):
            with self.subTest(scenario=scenario):
                release = threading.Event()
                entered = threading.Event()
                workers = set()
                socket_budgets = []
                request_count = 0

                class Handler(BaseHTTPRequestHandler):
                    def log_message(self, *_args):
                        pass

                    def do_GET(self):
                        nonlocal request_count
                        request_count += 1
                        if self.path == "/ordinary":
                            body = {"ordinary": True}
                        elif scenario == "after-empty" and request_count == 1:
                            body = {"current": {"lifecycle": "active"}, "answers": [], "nextSequence": 4}
                        else:
                            release.wait(1)
                            body = {"current": {"lifecycle": "stopped"}, "answers": []}
                        encoded = json.dumps(body).encode()
                        try:
                            self.send_response(200)
                            self.send_header("Content-Length", str(len(encoded)))
                            self.end_headers()
                            self.wfile.write(encoded)
                        except (BrokenPipeError, ConnectionResetError):
                            pass

                real_open = urllib.request.urlopen

                @contextlib.contextmanager
                def observed_open(request, *, timeout):
                    worker = threading.get_ident()
                    workers.add(worker)
                    socket_budgets.append(timeout)
                    entered.set()
                    try:
                        with real_open(request, timeout=timeout) as response:
                            yield response
                    finally:
                        workers.remove(worker)

                server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
                server.daemon_threads = True
                thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
                thread.start()
                graph = RelayerGraphClient(f"http://127.0.0.1:{server.server_port}", "scoped", 1, timeout=0.8)
                try:
                    with patch("relayer_graph.authoring.urlopen", observed_open):
                        if scenario == "cancel":
                            pending = asyncio.create_task(graph.wait_for_live_answers(timeout_seconds=0.12))
                            self.assertTrue(await asyncio.to_thread(entered.wait, 0.5))
                            pending.cancel()
                            with self.assertRaises(asyncio.CancelledError):
                                await pending
                        elif scenario == "after-empty":
                            page = await graph.wait_for_live_answers(3, 0.35)
                            self.assertEqual(page["nextSequence"], 4)
                            self.assertGreaterEqual(request_count, 2)
                        else:
                            with self.assertRaises(TimeoutError):
                                await graph.wait_for_live_answers(timeout_seconds=0.08)

                        # Observe the real urllib worker, not just cancellation of
                        # its asyncio waiter. On the old client it stays alive
                        # until release below, using the unrelated 0.8s timeout.
                        async def settled():
                            while workers:
                                await asyncio.sleep(0.005)
                        await asyncio.wait_for(settled(), 0.4)
                        self.assertTrue(socket_budgets)
                        self.assertTrue(all(0 < budget <= 0.35 for budget in socket_budgets))
                        self.assertEqual(graph.timeout, 0.8)
                        self.assertEqual(await graph._request("GET", "/ordinary"), {"ordinary": True})
                        self.assertEqual(socket_budgets[-1], 0.8)
                finally:
                    release.set()
                    server.shutdown()
                    server.server_close()
                    thread.join()

    async def test_transport_dispatch_deadline_edges(self):
        import io
        import json
        import socket
        import time
        from unittest.mock import patch
        from relayer_graph import TransportError

        graph = RelayerGraphClient("http://graph.test", "scoped", 1, timeout=0.01)
        with patch("relayer_graph.authoring.urlopen") as opening:
            with self.assertRaises(TimeoutError):
                await graph._request("GET", "/queued", deadline=time.monotonic() - 1)
            opening.assert_not_called()

        with patch("relayer_graph.authoring.urlopen", side_effect=socket.timeout("client timeout")) as opening:
            with self.assertRaises(TransportError):
                await graph._request("GET", "/early", deadline=time.monotonic() + 1)
            self.assertEqual(opening.call_args.kwargs["timeout"], 0.01)

        # Control executor dispatch for the zero-budget admission boundary;
        # real threads/socket settlement are covered by the stalled-server test.
        async def immediate_worker(function):
            return function()
        page = {"current": {"lifecycle": "stopped"}, "answers": []}
        with patch("relayer_graph.authoring.asyncio.to_thread", immediate_worker), patch(
            "relayer_graph.authoring.urlopen", return_value=io.BytesIO(json.dumps(page).encode())
        ) as opening:
            self.assertEqual(await graph.wait_for_live_answers(timeout_seconds=0), page)
            opening.assert_called_once()
            self.assertGreater(opening.call_args.kwargs["timeout"], 0)
            self.assertLessEqual(opening.call_args.kwargs["timeout"], 0.001)
