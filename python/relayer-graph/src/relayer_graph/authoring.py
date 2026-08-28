"""Object-based client for the GraphComplete Rust graph engine."""
from __future__ import annotations

import asyncio
import json
import os
import socket
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .exceptions import (APIError, AuthenticationError, ConfigurationError, NotFound,
                         TransportError, ValidationError, ValidationIssue)


@dataclass(frozen=True, slots=True)
class GraphNode:
    id: int
    kind: str
    icon: str
    title: str
    detail: str
    state: str
    leased_action_id: int | None = None

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "GraphNode":
        leased_action_id = value.get("leasedActionId")
        return cls(int(value["id"]), str(value["kind"]), str(value["icon"]),
                   str(value["title"]), str(value["detail"]), str(value["state"]),
                   None if leased_action_id is None else int(leased_action_id))


@dataclass(frozen=True, slots=True)
class InteractionInputNode:
    id: int
    kind: str
    icon: str
    title: str
    detail: str
    state: str

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "InteractionInputNode":
        return cls(int(value["id"]), str(value["kind"]), str(value["icon"]),
                   str(value["title"]), str(value["detail"]), str(value["state"]))


@dataclass(frozen=True, slots=True)
class GraphEdge:
    id: int
    endpoints: tuple[int, int]
    state: str

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "GraphEdge":
        endpoints = value["endpoints"]
        return cls(int(value["id"]), (int(endpoints[0]), int(endpoints[1])), str(value["state"]))


@dataclass(frozen=True, slots=True)
class InteractionContext:
    target_node: InteractionInputNode
    annotations: tuple[str, ...]
    type: Literal["interaction.context"] = "interaction.context"

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "InteractionContext":
        return cls(
            InteractionInputNode.from_dict(value["targetNode"]),
            tuple(str(annotation) for annotation in value.get("annotations", ())),
        )


@dataclass(frozen=True, slots=True)
class InteractionInput:
    interaction: InteractionInputNode
    contexts: tuple[InteractionContext, ...]

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "InteractionInput":
        return cls(
            InteractionInputNode.from_dict(value["interaction"]),
            tuple(InteractionContext.from_dict(item) for item in value.get("contexts", ())),
        )


@dataclass(frozen=True, slots=True)
class NodePlacement:
    node_id: int
    x: float
    y: float

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "NodePlacement":
        return cls(int(value["nodeId"]), float(value["x"]), float(value["y"]))


@dataclass(frozen=True, slots=True)
class LayerLayout:
    version: int
    placements: tuple[NodePlacement, ...]

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "LayerLayout":
        return cls(
            int(value["version"]),
            tuple(NodePlacement.from_dict(item) for item in value["placements"]),
        )


@dataclass(frozen=True, slots=True)
class GraphLayer:
    id: int
    nodes: tuple[int, ...]
    edges: tuple[int, ...]
    state: str
    layout: LayerLayout | None = None

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "GraphLayer":
        layout = value.get("layout")
        return cls(
            int(value["id"]), tuple(map(int, value["nodes"])),
            tuple(map(int, value["edges"])), str(value["state"]),
            None if layout is None else LayerLayout.from_dict(layout),
        )


@dataclass(slots=True)
class NodeObject:
    icon: str
    title: str
    detail: str
    kind: str = "concept"
    client_key: str = field(default_factory=lambda: str(uuid.uuid4()))
    ref: GraphNode | None = field(default=None, init=False)


@dataclass(slots=True)
class EdgeObject:
    endpoints: tuple["NodeReference", "NodeReference"]
    client_key: str = field(default_factory=lambda: str(uuid.uuid4()))
    ref: GraphEdge | None = field(default=None, init=False)


@dataclass(slots=True)
class NodePlacementObject:
    node: "NodeReference"
    x: float
    y: float


@dataclass(slots=True)
class LayerLayoutObject:
    placements: Sequence[NodePlacementObject]
    version: Literal[1] = field(default=1, init=False)


@dataclass(slots=True)
class LayerObject:
    nodes: Sequence["NodeReference"]
    edges: Sequence["EdgeReference"]
    layout: LayerLayoutObject
    client_key: str = field(default_factory=lambda: str(uuid.uuid4()))
    ref: GraphLayer | None = field(default=None, init=False)


NodeReference = int | GraphNode | NodeObject
EdgeReference = int | GraphEdge | EdgeObject
LayerReference = int | GraphLayer | LayerObject
ActionVariant = Literal["chip", "pill", "wide", "card"]
NavigateRelation = Literal["expand", "reference"]


@dataclass(frozen=True, slots=True)
class CompletionInputGraph:
    interaction_node: int

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "CompletionInputGraph":
        node = value.get("interactionNode")
        if isinstance(node, bool) or not isinstance(node, int) or node < 1:
            raise ValidationError("completion input graph has an invalid interactionNode")
        return cls(node)


class RelayerGraphClient:
    def __init__(self, url: str, token: str, node_id: int, *, timeout: float = 30.0) -> None:
        if not url or not token or node_id < 1:
            raise ConfigurationError("url, token, and a positive node_id are required")
        self.url = url.rstrip("/")
        self.token = token
        self.node_id = node_id
        self.timeout = timeout

    async def __aenter__(self) -> "RelayerGraphClient":
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        return None

    @classmethod
    def from_env(cls, *, timeout: float = 30.0) -> "RelayerGraphClient":
        try:
            return cls(os.environ["RELAYER_GRAPH_URL"], os.environ["RELAYER_GRAPH_TOKEN"],
                       int(os.environ["RELAYER_NODE_ID"]), timeout=timeout)
        except (KeyError, ValueError) as error:
            raise ConfigurationError("RELAYER_GRAPH_URL, RELAYER_GRAPH_TOKEN, and RELAYER_NODE_ID are required") from error

    async def get_node(self, node: NodeReference) -> GraphNode:
        value = await self._request("GET", f"/api/graph/nodes/{_node_id(node)}")
        return GraphNode.from_dict(value["node"])

    async def get_neighbors(self, node: NodeReference) -> tuple[GraphNode, ...]:
        value = await self._request("GET", f"/api/graph/nodes/{_node_id(node)}/neighbors")
        return tuple(GraphNode.from_dict(item) for item in value["nodes"])

    async def get_interaction_input(self) -> InteractionInput:
        return InteractionInput.from_dict(await self._request("GET", "/api/graph/input"))

    async def submit_node(self, node: NodeObject) -> GraphNode:
        value = await self._request("POST", "/api/graph/nodes", {
            "clientKey": node.client_key, "kind": node.kind, "icon": node.icon,
            "title": node.title, "detail": node.detail,
        })
        node.ref = GraphNode.from_dict(value["node"])
        return node.ref

    async def create_edge(self, left: NodeReference | EdgeObject, right: NodeReference | None = None,
                          *, client_key: str | None = None) -> GraphEdge:
        edge = left if isinstance(left, EdgeObject) else EdgeObject((left, _required(right)), client_key or str(uuid.uuid4()))
        value = await self._request("POST", "/api/graph/edges", {
            "clientKey": edge.client_key, "endpoints": [_node_id(item) for item in edge.endpoints],
        })
        edge.ref = GraphEdge.from_dict(value["edge"])
        return edge.ref

    async def submit_layer(self, layer: LayerObject, *, size_justification: str | None = None) -> GraphLayer:
        """Submit a layer. Layers with 6-8 nodes require a private justification."""
        value = await self._request("POST", "/api/graph/layers", {
            "clientKey": layer.client_key,
            "nodes": [_node_id(item) for item in layer.nodes],
            "edges": [_edge_id(item) for item in layer.edges],
            "layout": {
                "version": layer.layout.version,
                "placements": [
                    {"nodeId": _node_id(item.node), "x": item.x, "y": item.y}
                    for item in layer.layout.placements
                ],
            },
            "sizeJustification": size_justification,
        })
        layer.ref = GraphLayer.from_dict(value["layer"])
        return layer.ref

    async def add_navigate_action(self, source: NodeReference, label: str, target: LayerReference,
                                  *, relation: NavigateRelation, client_key: str,
                                  source_layer: LayerReference | None = None,
                                  variant: ActionVariant = "pill", icon: str | None = None,
                                  description: str | None = None) -> Mapping[str, Any]:
        """Add expansion or supporting-reference navigation.

        Omit ``source_layer`` only for the interaction node's root expansion.
        At any layer, add navigation only when opening it materially improves
        understanding or support. The service returns direct repair guidance
        when the action violates the current layer's authoring contract.
        """
        return await self._request("POST", "/api/graph/actions", {
            "clientKey": client_key, "sourceNodeId": _node_id(source),
            "sourceLayerId": None if source_layer is None else _layer_id(source_layer),
            "kind": "navigate", "relation": relation, "label": label,
            "targetLayerId": _layer_id(target),
            **_action_presentation(variant, icon, description),
        })

    async def add_invoke_action(self, source: NodeReference, label: str, interaction_text: str,
                                *, source_layer: LayerReference, client_key: str,
                                variant: ActionVariant = "pill",
                                icon: str | None = None,
                                description: str | None = None) -> Mapping[str, Any]:
        return await self._request("POST", "/api/graph/actions", {
            "clientKey": client_key, "sourceNodeId": _node_id(source),
            "sourceLayerId": _layer_id(source_layer),
            "kind": "invoke", "label": label, "interactionText": interaction_text,
            **_action_presentation(variant, icon, description),
        })

    async def get_layer(self, layer: LayerReference) -> Mapping[str, Any]:
        return await self._request("GET", f"/api/graph/layers/{_layer_id(layer)}")

    async def discard_layer(self, layer: LayerReference) -> GraphLayer:
        """Preserve an abandoned draft layer as stopped without changing its contents."""
        value = await self._request(
            "POST", f"/api/graph/layers/{_layer_id(layer)}/discard"
        )
        stopped = GraphLayer.from_dict(value["layer"])
        if isinstance(layer, LayerObject):
            layer.ref = stopped
        return stopped

    async def submit(self, interaction_node: NodeReference | None = None) -> Mapping[str, Any]:
        interaction_id = self.node_id if interaction_node is None else _node_id(interaction_node)
        return await self._request("POST", "/api/graph/submit", {"nodeId": interaction_id})

    async def get_completion_output(self, interaction_node: NodeReference | None = None) -> Mapping[str, Any]:
        interaction_id = self.node_id if interaction_node is None else _node_id(interaction_node)
        return await self._request("GET", f"/api/graph/nodes/{interaction_id}/output")

    async def get_current(self) -> Mapping[str, Any]:
        """Read this completion's durable current head."""
        return await self._request("GET", "/api/graph/current")

    async def prepare_complete(self, action: int | Mapping[str, Any]) -> CompletionInputGraph:
        """Prepare or exactly recover one semantic child from a published invoke action."""
        action_id = _action_id(action)
        value = await self._request(
            "POST", "/api/graph/completions/prepare", {"actionId": action_id}
        )
        return CompletionInputGraph.from_dict(value)

    async def advance_current(self, layer: LayerReference, *, expected_revision: int,
                              operation_key: str) -> Mapping[str, Any]:
        """Atomically publish a coherent owned layer and move the current pointer."""
        return await self._transition_current(
            expected_revision, operation_key,
            {"kind": "advance", "layerId": _layer_id(layer)},
        )

    async def return_current(self, layer: LayerReference, *, expected_revision: int,
                             operation_key: str) -> Mapping[str, Any]:
        """Atomically publish and establish the completion's successful final current."""
        return await self._transition_current(
            expected_revision, operation_key,
            {"kind": "return", "layerId": _layer_id(layer)},
        )

    async def stop_current(self, *, expected_revision: int, operation_key: str,
                           reason: Literal["cancelled_by_user"]) -> Mapping[str, Any]:
        """Stop this completion while preserving its last published current."""
        return await self._transition_current(
            expected_revision, operation_key, {"kind": "stop", "reason": reason}
        )

    async def _transition_current(self, expected_revision: int, operation_key: str,
                                  transition: Mapping[str, Any]) -> Mapping[str, Any]:
        return await self._request("POST", "/api/graph/current/transitions", {
            "expectedRevision": expected_revision,
            "operationKey": operation_key,
            "transition": transition,
        })

    async def _request(self, method: str, path: str, body: Any = None) -> Any:
        encoded = None if body is None else json.dumps(body, separators=(",", ":")).encode()
        headers = {"accept": "application/json", "authorization": f"Bearer {self.token}"}
        if encoded is not None:
            headers["content-type"] = "application/json"

        def send() -> Any:
            try:
                with urlopen(Request(self.url + path, data=encoded, method=method, headers=headers), timeout=self.timeout) as response:
                    return json.loads(response.read() or b"{}")
            except HTTPError as error:
                try:
                    raw = error.read()
                finally:
                    error.close()
                details = json.loads(raw or b"{}")
                item = details.get("error", {}) if isinstance(details, Mapping) else {}
                message = item.get("message", f"Graph request failed with HTTP {error.code}")
                error_type = (
                    AuthenticationError if error.code in (401, 403)
                    else NotFound if error.code == 404
                    else ValidationError if error.code in (400, 409, 422)
                    else APIError
                )
                issues = tuple(
                    ValidationIssue.from_dict(issue)
                    for issue in item.get("issues", ())
                    if isinstance(issue, Mapping)
                )
                if error_type is ValidationError:
                    raise ValidationError(
                        str(message), status=error.code, details=details, issues=issues
                    ) from error
                raise error_type(str(message), status=error.code, details=details) from error
            except (URLError, socket.timeout, TimeoutError, OSError) as error:
                raise TransportError(f"could not reach Relayer Graph at {self.url}: {error}") from error

        return await asyncio.to_thread(send)


def _node_id(value: NodeReference) -> int:
    if isinstance(value, int):
        return value
    if isinstance(value, NodeObject):
        if value.ref is None:
            raise ValueError(f"NodeObject {value.client_key} must be submitted first")
        return value.ref.id
    return value.id


def _edge_id(value: EdgeReference) -> int:
    if isinstance(value, int):
        return value
    if isinstance(value, EdgeObject):
        if value.ref is None:
            raise ValueError(f"EdgeObject {value.client_key} must be created first")
        return value.ref.id
    return value.id


def _layer_id(value: LayerReference) -> int:
    if isinstance(value, int):
        return value
    if isinstance(value, LayerObject):
        if value.ref is None:
            raise ValueError(f"LayerObject {value.client_key} must be submitted first")
        return value.ref.id
    return value.id


def _required(value: NodeReference | None) -> NodeReference:
    if value is None:
        raise ValueError("create_edge requires two node references")
    return value


def _action_id(value: int | Mapping[str, Any]) -> int:
    if isinstance(value, bool):
        raise ValueError("action ID must be a positive integer")
    if isinstance(value, int):
        action_id = value
    else:
        action = value.get("action", value)
        action_id = action.get("id") if isinstance(action, Mapping) else None
    if isinstance(action_id, bool) or not isinstance(action_id, int) or action_id < 1:
        raise ValueError("action must contain a positive persisted ID")
    return action_id


def _action_presentation(variant: ActionVariant, icon: str | None,
                         description: str | None) -> dict[str, Any]:
    return {"variant": variant, "icon": icon, "description": description}


# Backwards-compatible name used by the first authoring-client prototype.
GraphAuthoringClient = RelayerGraphClient
