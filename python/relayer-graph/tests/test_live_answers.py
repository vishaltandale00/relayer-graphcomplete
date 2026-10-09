import asyncio
import unittest
from relayer_graph import RelayerGraphClient

class LiveAnswerTests(unittest.IsolatedAsyncioTestCase):
    async def test_cursor_terminal_and_polling_timeout(self):
        graph = RelayerGraphClient("http://graph.test", "scoped", 1)
        calls = []
        async def request(method, path):
            calls.append((method, path))
            return {"current": {"lifecycle": "active"}, "answers": [], "nextSequence": 4}
        graph._request = request
        self.assertEqual((await graph.wait_for_live_answers(3, 0))["answers"], [])
        self.assertEqual(calls, [("GET", "/api/graph/live-answers?afterSequence=3")])
        for cursor in (-1, True, 0.5):
            with self.assertRaises(ValueError): await graph.get_live_answers(cursor)
        async def stopped(method, path): return {"current": {"lifecycle": "stopped"}, "answers": []}
        graph._request = stopped
        self.assertEqual((await graph.wait_for_live_answers())["current"]["lifecycle"], "stopped")

    async def test_deadline_and_caller_cancellation_cover_pending_transport(self):
        graph = RelayerGraphClient("http://graph.test", "scoped", 1)
        reached = asyncio.Event()
        async def request(method, path):
            reached.set()
            await asyncio.Event().wait()
        graph._request = request
        with self.assertRaises(TimeoutError): await graph.wait_for_live_answers(timeout_seconds=0.01)
        reached.clear()
        pending = asyncio.create_task(graph.wait_for_live_answers())
        await reached.wait()
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError): await pending
