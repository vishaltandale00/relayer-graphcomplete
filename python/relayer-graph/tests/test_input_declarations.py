import asyncio
import unittest
from dataclasses import replace
from relayer_graph import ActionObject, GraphNode, GraphLayer, LayerObject, LayerLayoutObject, NodeObject, RelayerGraphClient


class InputDeclarations(unittest.IsolatedAsyncioTestCase):
    def fixture(self):
        graph = RelayerGraphClient("http://graph.test", "token", 1)
        node = NodeObject("compass", "Vacation", "Choose", client_key="vacation")
        node.ref = GraphNode(10, "concept", "compass", "Vacation", "Choose", "draft")
        layer = LayerObject([node], [], LayerLayoutObject([], "default"), client_key="vacations")
        layer.ref = GraphLayer(20, [10], [], "draft")
        field = ActionObject("input", "Destination", layer, "destination", control="text", prompt="Destination")
        invoke = ActionObject("invoke", "Analyze", layer, "analyze", interaction_text="Analyze destination", input_actions=(field,))
        return graph, node, field, invoke

    async def test_lowering_and_shared_pending_consumers(self):
        graph, node, field, invoke = self.fixture()
        bodies = []
        gate = asyncio.Event()
        async def request(method, path, body):
            bodies.append(body)
            if body["kind"] == "input":
                await gate.wait()
            return {"action": {**body, "id": 30 if body["kind"] == "input" else 40}}
        graph._request = request
        first = asyncio.create_task(graph.add_action(node, invoke))
        second = asyncio.create_task(graph.add_action(node, replace(invoke, client_key="other", reusable=True)))
        await asyncio.sleep(0)
        gate.set()
        await asyncio.gather(first, second)
        self.assertEqual([body["kind"] for body in bodies].count("input"), 1)
        self.assertEqual([body["inputActionIds"] for body in bodies if body["kind"] == "invoke"], [[30], [30]])
        self.assertEqual(field.to_detail_wire(node)["kind"], "input")
        self.assertEqual(invoke.to_detail_wire(node)["inputActions"], [{"inputActionClientKey": "destination"}])
        self.assertEqual(graph._pending_inputs, {})

    async def test_rejects_invalid_dependencies_before_writes(self):
        for failure in (True, 0, replace(self.fixture()[2], prompt=""), "destination"):
            graph, node, field, invoke = self.fixture()
            bodies = []
            async def request(method, path, body):
                bodies.append(body)
                return {"action": {"id": 30}}
            graph._request = request
            with self.assertRaises(ValueError):
                await graph.add_action(node, replace(invoke, input_actions=(field, failure)))
            self.assertEqual(bodies, [])

    async def test_dependency_transport_failure_recovers_stable_key(self):
        graph, node, field, invoke = self.fixture()
        bodies = []
        async def request(method, path, body):
            bodies.append(body)
            if len(bodies) == 1:
                raise RuntimeError("Lost response")
            return {"action": {**body, "id": 30 if body["kind"] == "input" else 40}}
        graph._request = request
        with self.assertRaisesRegex(RuntimeError, "Lost response"):
            await graph.add_action(node, invoke)
        await graph.add_action(node, invoke)
        self.assertEqual([body["clientKey"] for body in bodies], ["destination", "destination", "analyze"])

    async def test_cancelled_consumer_does_not_cache_late_failure(self):
        graph, node, field, invoke = self.fixture()
        started, release = asyncio.Event(), asyncio.Event()
        bodies = []
        async def request(method, path, body):
            bodies.append(body)
            if len(bodies) == 1:
                started.set()
                await release.wait()
                raise RuntimeError("Late failure")
            return {"action": {**body, "id": 30 if body["kind"] == "input" else 40}}
        graph._request = request
        consumer = asyncio.create_task(graph.add_action(node, invoke))
        await started.wait()
        pending = next(iter(graph._pending_inputs.values()))[1]
        consumer.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await consumer
        release.set()
        with self.assertRaisesRegex(RuntimeError, "Late failure"):
            await pending
        self.assertEqual(graph._pending_inputs, {})
        await graph.add_action(node, invoke)
        self.assertEqual([body["clientKey"] for body in bodies], ["destination", "destination", "analyze"])

    async def test_freezes_mutable_invoke_icon_before_input_write(self):
        graph, node, field, invoke = self.fixture()
        icon = {"kind": "image", "assetId": "original"}
        bodies = []
        async def request(method, path, body):
            bodies.append(body)
            icon["assetId"] = "changed"
            return {"action": {**body, "id": 30 if body["kind"] == "input" else 40}}
        graph._request = request
        await graph.add_action(node, replace(invoke, icon=icon))
        self.assertEqual(bodies[1]["icon"]["assetId"], "original")
