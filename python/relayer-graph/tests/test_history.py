import unittest
from relayer_graph import RelayerGraphClient


class HistoryTests(unittest.IsolatedAsyncioTestCase):
    async def test_bounded_history_and_inert_input_transport(self):
        graph = RelayerGraphClient("http://graph.test", "current", 99)
        calls = []
        async def request(method, path):
            calls.append((method, path))
            return {"entries": [], "nextBeforeNodeId": None}
        graph._request = request
        await graph.get_history()
        await graph.get_history(before_node_id=42, limit=8)
        await graph.get_historical_input(41, 7)
        self.assertEqual(calls, [
            ("GET", "/api/graph/history?limit=20"),
            ("GET", "/api/graph/history?limit=8&beforeNodeId=42"),
            ("GET", "/api/graph/nodes/41/input?afterAnswerSequence=7"),
        ])
        for invalid in (True, -1, 1.5):
            with self.assertRaises(ValueError): await graph.get_history(before_node_id=invalid)
            with self.assertRaises(ValueError): await graph.get_historical_input(41, invalid)
        for invalid in (0, 51, True):
            with self.assertRaises(ValueError): await graph.get_history(limit=invalid)
        self.assertEqual(len(calls), 3)
