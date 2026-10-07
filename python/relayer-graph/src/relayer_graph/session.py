"""Prime Agent entry point for the graph scope of the current run."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, replace
from typing import Any, Mapping

from .authoring import (GraphLayer, GraphNode, LayerObject, NodeObject, NodeReference,
                        RelayerGraphClient, _graph_error, _layer_payload, _node_id)
from .exceptions import ConfigurationError, ValidationError
from .detail import NodeDetailAuthoring
from .preview import host_preview


@dataclass
class _VisualSubmission:
    payload: Any
    task: asyncio.Task[GraphNode] | None = None


class GraphSession(RelayerGraphClient):
    """A graph client bound to the current ``complete()`` execution."""

    def __init__(self, url: str, token: str, node_id: int, *, timeout: float = 30.0) -> None:
        super().__init__(url, token, node_id, timeout=timeout)
        self._visual_submissions: dict[NodeDetailAuthoring, _VisualSubmission] = {}

    @classmethod
    async def current(cls, *, timeout: float = 30.0) -> "GraphSession":
        """Acquire the graph scope attached to the active Prime Agent run."""
        try:
            from rlm import host_request
        except ImportError as error:
            raise ConfigurationError(
                "GraphSession.current() is only available inside a Prime Agent IPython run"
            ) from error

        value: Any = await host_request("relayer.graph.current")
        if not isinstance(value, Mapping):
            raise ConfigurationError("relayer.graph.current returned an invalid graph scope")
        url = value.get("url")
        token = value.get("token")
        node_id = value.get("nodeId")
        if (
            not isinstance(url, str)
            or not url
            or not isinstance(token, str)
            or not token
            or isinstance(node_id, bool)
            or not isinstance(node_id, int)
            or node_id < 1
        ):
            raise ConfigurationError("relayer.graph.current returned an invalid graph scope")
        return cls(url, token, node_id, timeout=timeout)

    def _visual_payload(self, operation: str, node: NodeObject) -> Any:
        self.bind_node(node)
        # Serialize now: nested Python mutations cannot change an in-flight program.
        import json
        payload = json.loads(json.dumps({
            "version": 1, "objectId": node.detail_authoring._object_id, "token": self.token, "nodeId": self.node_id,
            "operation": operation,
            "node": {"clientKey": node.client_key, "icon": node.icon,
                     "title": node.title, "detail": node.detail, "kind": node.kind,
                     **({"artifact": node.artifact} if node.artifact is not None else {})},
            "detail": node.detail_authoring.to_wire(node),
        }))
        return payload

    async def _visual_authoring(self, operation: str, node: NodeObject, payload: Any = None, *, authoring: NodeDetailAuthoring | None = None) -> Any:
        from rlm import host_request
        authoring = node.detail_authoring if authoring is None else authoring
        if payload is None:
            payload = self._visual_payload(operation, node)
        result = await host_request("relayer.graph.visual-authoring", payload)
        if result.get("frozen") is True:
            authoring._frozen = True
        if result.get("ok") is not True:
            # Include compiler locations in the displayed exception as well as retaining
            # the exact structured response for programmatic repair.
            import json
            message = result.get("message", "Visual authoring failed")
            if result.get("issues"):
                message += "\n" + json.dumps(result["issues"], ensure_ascii=False)
            raise ValidationError(message, status=422, details=result)
        return result["value"]

    async def checkpoint_node_detail(self, node: NodeObject) -> Any:
        self.bind_node(node)
        return await self._visual_authoring("checkpoint", node)

    async def replace_node_presentation(self, node: NodeReference, expected_revision: int,
                                        presentation: NodeObject) -> None:
        """Stage a compiled full replacement; never submit the semantic node envelope."""
        payload = self._visual_payload("replace", presentation)
        payload["replacement"] = {"nodeId": _node_id(node), "expectedRevision": expected_revision}
        await self._visual_authoring("replace", presentation, payload)

    async def submit_node(self, node: NodeObject) -> GraphNode:
        key = node.detail_authoring
        submission = self._visual_submissions.get(key)
        if submission is not None:
            # Recheck the exact owner and scope against the frozen envelope, not
            # mutable fields that cannot change the already registered request.
            key._bind(node, self.url, self.node_id, captured_key=submission.payload["node"]["clientKey"])
            if submission.task is not None:
                return await asyncio.shield(submission.task)
        else:
            self.bind_node(node)
            if key._finalizing:
                raise ValueError("detail_finalization_in_progress")
            submission = _VisualSubmission(self._visual_payload("submit", node))
            self._visual_submissions[key] = submission
        key._finalizing = True

        async def submit() -> GraphNode:
            try:
                value = await self._visual_authoring("submit", node, submission.payload, authoring=key)
                node.ref = GraphNode.from_dict(value)
                # The host wrote any draft preview into the turn's preview folder.
                preview = host_preview(value.get("preview"))
                return node.ref if preview is None else replace(node.ref, preview=preview)
            except BaseException as error:
                # Only an explicit mutable rejection releases the frozen envelope.
                # Lost responses and frozen host failures replay the exact payload.
                mutable_rejection = (isinstance(error, ValidationError)
                                     and isinstance(error.details, Mapping)
                                     and error.details.get("frozen") is False)
                if mutable_rejection:
                    key._frozen = False
                    self._visual_submissions.pop(key, None)
                else:
                    key._frozen = True
                    submission.task = None
                raise
            finally:
                key._finalizing = False

        task = asyncio.create_task(submit())
        task.add_done_callback(lambda done: None if done.cancelled() else done.exception())
        submission.task = task
        return await asyncio.shield(task)

    async def submit_layer(self, layer: LayerObject, *, size_justification: str | None = None) -> GraphLayer:
        """Submit a layer through the host, which writes its draft preview where this run can read it."""
        from rlm import host_request
        payload = {"version": 1, "token": self.token, "nodeId": self.node_id,
                   "layer": _layer_payload(layer, size_justification)}
        result = await host_request("relayer.graph.submit-layer", payload)
        if not isinstance(result, Mapping) or result.get("ok") is not True:
            details = result if isinstance(result, Mapping) else {}
            status = details.get("httpStatus")
            raise _graph_error(status if isinstance(status, int) and not isinstance(status, bool) else 500,
                               {"error": details.get("error")})
        value = result["value"]
        layer.ref = GraphLayer.from_dict(value)
        preview = host_preview(value.get("preview"))
        return layer.ref if preview is None else replace(layer.ref, preview=preview)

    def __getstate__(self) -> None:
        raise TypeError("GraphSession is run-scoped and cannot be serialized")

    def __reduce__(self) -> None:
        raise TypeError("GraphSession is run-scoped and cannot be serialized")
