import asyncio
import base64
import hashlib
import sys
import types
import unittest
from unittest.mock import patch
from relayer_graph import (ActionObject, EdgeEndObject, EdgeObject, EdgeRouteObject,
    GraphPreview, GraphSession, NodeObject, LayerObject, LayerLayoutObject, NodePlacementObject,
    html, action_capability, external_link, VisualAssetFile, GraphVisualAssets)
from relayer_graph.authoring import GraphEdge, GraphNode, _layer_payload
from relayer_graph.visual_assets import _decode_file
from relayer_graph.exceptions import AuthenticationError, ValidationError


class VisualAuthoringTests(unittest.IsolatedAsyncioTestCase):
    async def test_presentation_read_and_frozen_policy_versions(self):
        from relayer_graph import InteractionInput
        node = {"id": 1, "kind": "interaction", "icon": "box", "title": "Ask", "detail": "Ask", "state": "accepted"}
        for policy in (None, {"version": "1", "enabled": True, "permissions": [{"kind": "navigate.add", "nodeId": 2}]},
                       {"version": "2", "enabled": True, "permissions": [{"kind": "navigate.add", "nodeId": 2}, {"kind": "invoke.resolve", "actionId": 3}]},
                       {"version": "2", "enabled": False, "permissions": []}):
            graph = GraphSession("http://unused", "run", 1)
            async def request(method, path, body=None):
                self.assertEqual(method, "GET")
                if path == "/api/graph/input":
                    return {"interaction": node, **({} if policy is None else {"interactionPermissions": policy})}
                self.assertEqual(path, "/api/graph/nodes/2/presentation")
                return {"node": {**node, "id": 2, "clientKey": "persistent"}, "revision": 4, "actions": []}
            graph._request = request
            self.assertEqual((await graph.get_interaction_input()).interaction_permissions, policy)
            self.assertEqual((await graph.get_node_presentation(2))["node"]["clientKey"], "persistent")

    async def test_session_binding_snapshot_and_frozen_submission(self):
        node = NodeObject('box', 'Answer', 'Fallback', client_key='answer')
        layer = LayerObject([node], [], LayerLayoutObject([NodePlacementObject(node, .5, .5)], "default"), client_key='root')
        action = ActionObject('invoke', 'Continue', layer, 'continue', interaction_text='Continue')
        node.detail_authoring.set_component('main', html(['<button gc=', '>Continue</button>'], action_capability('continue', action)))
        requests = []
        async def host_request(method, payload=None):
            if method == 'relayer.graph.current':
                return {'url': 'http://unused', 'token': 'original-run', 'nodeId': 1}
            requests.append(payload)
            self.assertEqual(payload['token'], 'original-run')
            self.assertEqual(payload['detail']['components'][0]['markup']['values'][0]['action']['sourceLayer'], {'clientKey': 'root', 'nodes': ['answer']})
            return {'ok': True, 'frozen': True, 'value': {'id': 2, 'kind': 'concept', 'icon': 'box', 'title': 'Answer', 'detail': 'Fallback', 'state': 'draft', 'authoredDetail': {'version': 1}}}
        with patch.dict(sys.modules, {'rlm': types.SimpleNamespace(host_request=host_request)}):
            session = await GraphSession.current()
            await session.submit_node(node)
        self.assertEqual(node.ref.authored_detail, {'version': 1})
        with self.assertRaisesRegex(ValueError, 'detail_finalized'):
            node.detail_authoring.clear()

    async def test_concurrent_submit_locks_builder_and_joins_same_request(self):
        node = NodeObject('box', 'Answer', 'Fallback', client_key='answer')
        node.detail_authoring.set_component('main', html('<p>Original</p>'))
        entered, release = asyncio.Event(), asyncio.Event()
        calls = []
        async def host_request(method, payload):
            calls.append(payload)
            entered.set()
            await release.wait()
            return {'ok': True, 'frozen': True, 'value': {'id': 2, 'kind': 'concept', 'icon': 'box', 'title': 'Answer', 'detail': 'Fallback', 'state': 'draft'}}
        with patch.dict(sys.modules, {'rlm': types.SimpleNamespace(host_request=host_request)}):
            graph = GraphSession('http://unused', 'run', 1)
            first = asyncio.create_task(graph.submit_node(node))
            await entered.wait()
            node.client_key = "mutated-after-snapshot"
            node.detail_authoring._object_id = "mutated-after-snapshot"
            second = asyncio.create_task(graph.submit_node(node))
            with self.assertRaisesRegex(ValueError, 'in_progress'):
                node.detail_authoring.clear()
            release.set()
            left, right = await asyncio.gather(first, second)
            self.assertIs(left, right)
            self.assertEqual(calls[0]["node"]["clientKey"], "answer")
            self.assertIs(await graph.submit_node(node), left)
            graph.node_id = 2
            with self.assertRaisesRegex(ValueError, "scope_mismatch"):
                await graph.submit_node(node)
            self.assertEqual(len(calls), 1)
            graph.node_id = 1
            replacement = NodeObject('box', 'Replacement', 'Different', client_key='answer')
            replacement.detail_authoring._object_id = calls[0]["objectId"]
            replacement.detail_authoring.set_component('main', html('<p>Replacement</p>'))
            await graph.submit_node(replacement)
            self.assertEqual(len(calls), 2)
            self.assertEqual(calls[1]['node']['title'], 'Replacement')

    async def test_host_result_freezes_captured_builder_after_live_field_replacement(self):
        node = NodeObject('box', 'Original', 'Fallback', client_key='answer')
        other = NodeObject('box', 'Other', 'Fallback', client_key='other')
        original_authoring = node.detail_authoring
        original_authoring.set_component('main', html('<p>Original</p>'))
        async def host_request(method, payload):
            node.detail_authoring = other.detail_authoring
            return {'ok': True, 'frozen': True, 'value': {'id': 2, 'kind': 'concept', 'icon': 'box', 'title': 'Original', 'detail': 'Fallback', 'state': 'draft'}}
        with patch.dict(sys.modules, {'rlm': types.SimpleNamespace(host_request=host_request)}):
            await GraphSession('http://unused', 'run', 1).submit_node(node)
        node.detail_authoring = original_authoring
        with self.assertRaisesRegex(ValueError, "detail_finalized"):
            original_authoring.set_component('main', html('<p>Changed</p>'))
        other.detail_authoring.set_component('main', html('<p>Other</p>'))

    async def test_locked_failures_replay_exact_envelope_despite_live_mutation(self):
        for failure_kind in ("transport", "frozen-host"):
            with self.subTest(failure_kind=failure_kind):
                node = NodeObject('box', 'Original', 'Fallback', client_key='answer')
                node.detail_authoring.set_component('main', html('<p>Original</p>'))
                calls = []
                async def host_request(method, payload):
                    calls.append(payload)
                    if len(calls) == 1:
                        if failure_kind == "transport":
                            raise RuntimeError("lost response")
                        return {"ok": False, "frozen": True, "message": "lost graph response"}
                    return {'ok': True, 'frozen': True, 'value': {'id': 2, 'kind': 'concept', 'icon': 'box', 'title': 'Original', 'detail': 'Fallback', 'state': 'draft'}}
                with patch.dict(sys.modules, {'rlm': types.SimpleNamespace(host_request=host_request)}):
                    graph = GraphSession('http://unused', 'run', 1)
                    with self.assertRaises((RuntimeError, ValidationError)):
                        await graph.submit_node(node)
                    node.client_key, node.title = "changed", "Changed"
                    node.detail_authoring._object_id = "changed"
                    with self.assertRaisesRegex(ValueError, "detail_finalized"):
                        node.detail_authoring.clear()
                    graph.node_id = 2
                    with self.assertRaisesRegex(ValueError, "scope_mismatch"):
                        await graph.submit_node(node)
                    self.assertEqual(len(calls), 1)
                    graph.node_id = 1
                    result = await graph.submit_node(node)
                    self.assertEqual(calls[0], calls[1])
                    self.assertEqual(calls[1]["node"]["clientKey"], "answer")
                    self.assertEqual(result.title, "Original")

    async def test_checkpoint_and_submit_errors_preserve_guidance_and_allow_repair(self):
        for operation in ('checkpoint_node_detail', 'submit_node'):
            with self.subTest(operation=operation):
                node = NodeObject('box', 'Answer', 'Fallback', client_key='answer')
                node.detail_authoring.set_component('main', html('<script>bad</script>'))
                failure = {'ok': False, 'frozen': False, 'message': 'Invalid authored detail',
                    'issues': [{'code': 'forbidden_element', 'componentId': 'main',
                                'message': 'Remove script', 'location': {'line': 1, 'column': 1}}]}
                replies = [failure, {'ok': True, 'frozen': True, 'value': {
                    'id': 2, 'kind': 'concept', 'icon': 'box', 'title': 'Answer',
                    'detail': 'Fallback', 'state': 'draft'}}]
                async def host_request(method, payload):
                    return replies.pop(0)
                with patch.dict(sys.modules, {'rlm': types.SimpleNamespace(host_request=host_request)}):
                    graph = GraphSession('http://unused', 'run', 1)
                    with self.assertRaises(ValidationError) as caught:
                        await getattr(graph, operation)(node)
                    self.assertEqual(caught.exception.status, 422)
                    self.assertEqual(caught.exception.details, failure)
                    self.assertIn('Remove script', str(caught.exception))
                    self.assertIn('main', str(caught.exception))
                    node.detail_authoring.set_component('main', html('<p>Repaired</p>'))
                    await graph.submit_node(node)
                    self.assertEqual(node.ref.id, 2)

    async def test_submit_node_keeps_the_preview_the_host_wrote(self):
        node = NodeObject('box', 'Answer', 'Fallback', client_key='answer')
        node.detail_authoring.set_component('main', html('<p>Answer</p>'))
        value = {'id': 2, 'kind': 'concept', 'icon': 'box', 'title': 'Answer', 'detail': 'Fallback', 'state': 'draft',
                 'preview': {'status': 'rendered', 'path': '/tmp/previews-1/node-2-abababababababab.png',
                             'width': 380, 'height': 640}}
        async def host_request(method, payload):
            return {'ok': True, 'frozen': True, 'value': value}
        with patch.dict(sys.modules, {'rlm': types.SimpleNamespace(host_request=host_request)}):
            submitted = await GraphSession('http://unused', 'run', 1).submit_node(node)
        self.assertEqual(submitted.preview, GraphPreview('rendered', '/tmp/previews-1/node-2-abababababababab.png', 380, 640))
        self.assertEqual(submitted.id, 2)

    async def test_submit_layer_goes_through_the_host_and_keeps_its_preview(self):
        first, second = NodeObject('box', 'First', 'One', client_key='first'), NodeObject('box', 'Second', 'Two', client_key='second')
        first.ref, second.ref = (GraphNode(id, 'concept', 'box', title, title, 'draft') for id, title in ((5, 'First'), (6, 'Second')))
        edge = EdgeObject((first, second), client_key='edge')
        edge.ref = GraphEdge(9, (5, 6), 'draft')
        layer = LayerObject([first, second], [edge], LayerLayoutObject(
            [NodePlacementObject(first, .25, .5), NodePlacementObject(second, .75, .5)], 'elbow-horizontal',
            (EdgeRouteObject(edge, ends=(EdgeEndObject(first, 'top'), EdgeEndObject(second, 'top')), waypoints=((.5, .1),)),)),
            client_key='root', default_node=second)
        requests, replies = [], [
            {'ok': False, 'httpStatus': 422, 'error': {'code': 'validation_failed', 'message': 'Layer is invalid',
                                                     'issues': [{'code': 'overlap', 'path': 'layout', 'message': 'Spread the nodes out'}]}},
            {'ok': True, 'value': {'id': 30, 'nodes': [5, 6], 'edges': [9], 'state': 'draft', 'defaultNodeId': 6,
                                   'preview': {'status': 'cached', 'path': '/tmp/previews-1/layer-30-abababababababab.png',
                                               'width': 1176, 'height': 812}}},
            {'ok': True, 'value': {'id': 30, 'nodes': [5, 6], 'edges': [9], 'state': 'draft', 'preview': {'status': 'limit_reached'}}},
        ]
        async def host_request(method, payload):
            requests.append((method, payload))
            # Prime's kernel replies {**result, "status": "ok"} and rlm strips "status".
            reply = {**replies.pop(0), 'status': 'ok'}
            return {key: value for key, value in reply.items() if key != 'status'}
        async def direct(method, path, body=None):
            raise AssertionError('Prime submits layers through the host')
        with patch.dict(sys.modules, {'rlm': types.SimpleNamespace(host_request=host_request)}):
            graph = GraphSession('http://unused', 'run', 1)
            graph._request = direct
            with self.assertRaises(ValidationError) as caught:
                await graph.submit_layer(layer, size_justification='private')
            self.assertEqual(caught.exception.status, 422)
            self.assertEqual(caught.exception.issues[0].message, 'Spread the nodes out')
            submitted = await graph.submit_layer(layer, size_justification='private')
            limited = await graph.submit_layer(layer)
            replies.append({'ok': False, 'httpStatus': 401, 'error': {'code': 'unauthorized', 'message': 'Token expired'}})
            with self.assertRaises(AuthenticationError):
                await graph.submit_layer(layer)
        self.assertEqual([method for method, _ in requests], ['relayer.graph.submit-layer'] * 4)
        self.assertEqual(requests[0][1], {'version': 1, 'token': 'run', 'nodeId': 1,
                                          'layer': _layer_payload(layer, 'private')})
        self.assertEqual(requests[0][1]['layer']['layout']['edgeRoutes'][0]['ends'][0], {'nodeId': 5, 'side': 'top'})
        self.assertEqual(submitted.preview, GraphPreview('cached', '/tmp/previews-1/layer-30-abababababababab.png', 1176, 812))
        self.assertEqual(submitted.default_node_id, 6)
        self.assertEqual(layer.ref.id, 30)
        self.assertEqual(limited.preview, GraphPreview('limit_reached'))

    async def test_owner_identity_and_clear_are_explicit(self):
        owner = NodeObject('box', 'Answer', 'Fallback', client_key='answer')
        impostor = NodeObject('box', 'Answer', 'Fallback', client_key='answer')
        layer = LayerObject([impostor], [], LayerLayoutObject([], "default"), client_key='root')
        action = ActionObject('invoke', 'Continue', layer, 'continue', interaction_text='Continue')
        with self.assertRaisesRegex(ValueError, 'exact owning'):
            action.to_detail_wire(owner)
        owner.detail_authoring.set_component('main', html(['<button gc=', '>Continue</button>'], action_capability('continue', action)))
        with self.assertRaisesRegex(ValueError, 'exact owning'):
            await GraphSession('http://unused', 'run', 1).submit_node(owner)
        owner.detail_authoring.clear()
        with self.assertRaisesRegex(TypeError, "owning node"):
            type(owner.detail_authoring)()
        owner = NodeObject('box', 'Answer', 'Fallback', client_key='answer')

        self.assertEqual(owner.detail_authoring.to_wire(owner), {'clear': False, 'components': []})
        owner.detail_authoring.clear()
        self.assertEqual(owner.detail_authoring.to_wire(owner), {'clear': True, 'components': []})
        owner.detail_authoring.set_component('main', html('<p>Replaced</p>'))
        self.assertFalse(owner.detail_authoring.to_wire(owner)['clear'])

    async def test_asset_file_integrity_and_authenticated_routes(self):
        content = b'asset bytes'
        wire = {'name': 'a.png', 'mediaType': 'image/png', 'contentBase64': base64.b64encode(content).decode(), 'expectedDigest': 'sha256:' + hashlib.sha256(content).hexdigest()}
        self.assertEqual(_decode_file(wire).read(), content)
        with self.assertRaisesRegex(ValueError, 'Corrupt'):
            _decode_file({**wire, 'expectedDigest': 'sha256:wrong'})
        seen = []
        class Client:
            async def _request(self, method, path, body=None):
                seen.append((method, path, body))
                return {'id': 'asset'}
        assets = GraphVisualAssets(Client())
        await assets.add(file=VisualAssetFile('a.png', 'image/png', content), scope={'kind': 'thread', 'threadId': 1}, name='A')
        self.assertEqual(seen[0][1], '/api/graph/visual-assets/operations')
        self.assertEqual(seen[0][2]['operation']['file']['contentBase64'], wire['contentBase64'])
