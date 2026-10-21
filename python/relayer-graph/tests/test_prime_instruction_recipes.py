import ast
import base64
import json
import re
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from relayer_graph import RelayerGraphClient


CORPUS = json.loads((Path(__file__).parents[3] / "fixtures" / "prime-instruction-graph-v2.json").read_text())


def recipe(key):
    detail = next(module["detail"] for module in CORPUS["modules"] if module["key"] == key)
    return re.findall(r"```python\n(.*?)```", detail, re.S)[0]


async def execute(code, values):
    compiled = compile(code, "<prime-instruction-recipe>", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
    result = eval(compiled, values)
    if result is not None:
        await result


class PrimeInstructionRecipeTests(unittest.IsolatedAsyncioTestCase):
    def test_every_published_python_example_has_valid_top_level_await_syntax(self):
        for module in CORPUS["modules"]:
            for code in re.findall(r"```python\n(.*?)```", module["detail"], re.S):
                with self.subTest(module=module["key"]):
                    compile(code, module["key"], "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)

    async def test_asset_recipe_registers_actual_bytes_and_binds_mapping_id(self):
        graph = RelayerGraphClient("http://graph.test", "fixture-token", 1)
        requests = []
        async def request(method, path, body=None):
            requests.append((path, body))
            if path.endswith("/scope"):
                return {"scope": {"kind": "project", "projectId": 1}}
            if body["operation"]["kind"] == "add":
                return {"id": "registered-image"}
            return {"items": []}
        graph._request = request
        values = {"graph": graph, "image_bytes": b"actual-caller-read-image"}
        await execute(recipe("visual-assets"), values)
        addition = next(body["operation"] for _, body in requests if body and body["operation"]["kind"] == "add")
        self.assertEqual(base64.b64decode(addition["file"]["contentBase64"]), values["image_bytes"])
        self.assertEqual(values["asset"]["id"], "registered-image")
        self.assertEqual(values["image"].to_wire(None)["values"], [{"kind": "asset", "logicalId": "registered-image"}])

    async def test_publish_then_return_uses_real_python_writer_and_preserves_prior_current(self):
        for prior_id in [None, 50]:
            with self.subTest(prior=prior_id):
                calls, ids = [], {}
                current = {"lifecycle": "active", "currentLayerId": prior_id, "headRevision": 2}
                def record(path, body, kind):
                    record_id = ids.setdefault((path, body.get("clientKey")), 100 + len(ids))
                    return {kind: {**body, "id": record_id, "state": "draft"}}
                async def host(name, body=None):
                    if name == "relayer.graph.current":
                        return {"url": "http://graph.test", "token": "fixture-token", "nodeId": 7}
                    if name == "relayer.graph.visual-authoring":
                        calls.append(("visual", body))
                        return {"ok": True, "frozen": True, "value": record("nodes", body["node"], "node")["node"]}
                    if name == "relayer.graph.submit-layer":
                        calls.append(("layer", body["layer"]))
                        return {"ok": True, "value": record("layers", body["layer"], "layer")["layer"]}
                    raise AssertionError(name)
                async def request(client, method, path, body=None, **_options):
                    calls.append((path, body))
                    if path == "/api/graph/current":
                        return dict(current)
                    if path == "/api/graph/layers/50":
                        return {"layer": {"id": 50, "nodes": [51], "edges": [], "state": "accepted"}}
                    if path.endswith("/actions"):
                        return record(path, body, "action")
                    if path.endswith("/transitions"):
                        current.update(currentLayerId=body["transition"]["layerId"], headRevision=current["headRevision"] + 1)
                        return dict(current)
                    raise AssertionError(path)
                with patch.dict(sys.modules, {"rlm": types.SimpleNamespace(host_request=host)}), patch.object(RelayerGraphClient, "_request", request):
                    values = {}
                    await execute(recipe("publish-current").replace("INTERACTION_NODE_ID", "7"), values)
                    # Return the exact accepted Current, without a second writer invocation.
                    writes = len([path for path, _ in calls if path in ("visual", "layer")])
                    await execute(recipe("finish-current"), values)
                    self.assertEqual(writes, len([path for path, _ in calls if path in ("visual", "layer")]))
                transitions = [body for path, body in calls if path.endswith("/transitions")]
                self.assertEqual([body["transition"]["kind"] for body in transitions], ["advance", "return"])
                self.assertEqual(transitions[0]["transition"]["layerId"], transitions[1]["transition"]["layerId"])
                references = [body for path, body in calls if path.endswith("/actions") and body.get("relation") == "reference"]
                self.assertEqual([body["targetLayerId"] for body in references], [] if prior_id is None else [prior_id])
