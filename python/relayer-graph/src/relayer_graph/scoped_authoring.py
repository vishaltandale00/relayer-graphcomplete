"""Named draft assembly over the ordinary client and Prime's canonical visual bridge."""
from __future__ import annotations

import asyncio
import base64
import json
import math
from dataclasses import dataclass, replace
from typing import Any, Callable, Awaitable, Sequence

from .actions import ActionObject
from .authoring import (EdgeEndObject, EdgeObject, EdgeRouteObject, GraphEdge,
                        GraphLayer, GraphNode, LayerLayoutObject, LayerObject,
                        NodeObject, NodePlacementObject, RelayerGraphClient)
from .exceptions import APIError, ValidationError


class GraphAuthoringValidationError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class CompletedAuthoringWrite:
    path: str
    kind: str
    id: int


@dataclass(frozen=True, slots=True)
class FailedAuthoringWrite:
    path: str
    outcome: str
    cause: BaseException


class GraphAuthoringWriteError(Exception):
    def __init__(self, completed: Sequence[CompletedAuthoringWrite],
                 failures: Sequence[FailedAuthoringWrite], unstarted: Sequence[str]) -> None:
        self.completed = tuple(completed)
        self.failures = tuple(failures)
        self.unstarted = tuple(unstarted)
        super().__init__("Scoped graph write failed at " + ", ".join(item.path for item in failures)
                         + "; valid drafts are retained")


@dataclass(frozen=True, slots=True)
class GraphWriteResult:
    """A draft write result, not acceptance or a content lock."""
    root_layer: GraphLayer
    nodes: tuple[GraphNode, ...]
    edges: tuple[GraphEdge, ...]
    layers: tuple[GraphLayer, ...]
    actions: tuple[dict[str, Any], ...]


def _name(value: str) -> str:
    if (type(value) is not str or not value or value.strip(" \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff") != value or "\0" in value
            or any(0xD800 <= ord(character) <= 0xDFFF for character in value)):
        raise GraphAuthoringValidationError("Authoring names must be nonempty, trimmed, NUL-free Unicode strings")
    return value


def _identity(snapshot: str, layer: str, kind: str, local: str) -> str:
    encoded = json.dumps([snapshot, layer, kind, local], ensure_ascii=False, separators=(",", ":")).encode()
    key = "ga1:" + base64.urlsafe_b64encode(encoded).decode().rstrip("=")
    if len(key.encode()) > 128:
        raise GraphAuthoringValidationError("Scoped identity exceeds 128 UTF-8 bytes; shorten the snapshot, layer, or local name")
    return key


def _path(layer: str, kind: str = "", local: str = "") -> str:
    value = "layers[" + json.dumps(layer, ensure_ascii=False) + "]"
    return value if not local else value + "." + kind + "[" + json.dumps(local, ensure_ascii=False) + "]"


def _copy(value: Any, ancestors: set[int] | None = None) -> Any:
    ancestors = set() if ancestors is None else ancestors
    if type(value) in (dict, list, tuple):
        if id(value) in ancestors:
            raise GraphAuthoringValidationError("Authoring values cannot contain cycles")
        ancestors.add(id(value))
        try:
            if type(value) is dict:
                if any(type(key) is not str for key in value):
                    raise GraphAuthoringValidationError("Authoring data needs string keys")
                return {key: _copy(item, ancestors) for key, item in value.items()}
            return tuple(_copy(item, ancestors) for item in value)
        finally:
            ancestors.remove(id(value))
    if value is None or type(value) in (str, bool, int, float):
        return value
    raise GraphAuthoringValidationError("Authoring values must be ordinary data, not factories")


def _same(left: Sequence[Any], right: Sequence[Any]) -> bool:
    return len(left) == len(right) and all(a is b for a, b in zip(left, right))


class ScopedAuthoringLayer:
    def __init__(self, owner: ScopedGraphAuthoring, key: str) -> None:
        self._owner = owner
        self._key = key
        self._nodes: dict[str, NodeObject] = {}
        self._edges: dict[str, EdgeObject] = {}
        self._endpoints: dict[str, tuple[Any, Any]] = {}
        self._actions: dict[str, tuple[NodeObject, ActionObject]] = {}
        self._members: list[Any] = []
        self._connections: list[Any] = []
        self._ready = False
        self._size_justification: str | None = None
        # Allocate the actual provenance object before binding any visual control.
        self.object = LayerObject([], [], LayerLayoutObject([], "default"),
                                  _identity(owner.snapshot_key, key, "l", ""))

    def node(self, local_key: str, *, icon: Any, title: str, detail: str,
             kind: str = "concept") -> NodeObject:
        key = _name(local_key)
        if key in self._nodes:
            raise GraphAuthoringValidationError("Duplicate node " + _path(self._key, "nodes", key))
        if any(type(value) is not str for value in (title, detail, kind)):
            raise GraphAuthoringValidationError("Node title, detail, and kind must be strings")
        node = NodeObject(icon, title, detail, kind, _identity(self._owner.snapshot_key, self._key, "n", key))
        self._nodes[key] = node
        self._members.append(node)
        self.object.nodes = list(self._members)
        return node

    def include(self, record: GraphNode | GraphEdge) -> None:
        if type(record) not in (GraphNode, GraphEdge) or record.state != "accepted" or type(record.id) is not int or record.id < 1:
            raise GraphAuthoringValidationError("include requires an explicit accepted node or edge; it never resubmits drafts")
        members = self._connections if isinstance(record, GraphEdge) else self._members
        if any(type(item) is type(record) and item.id == record.id for item in members):
            raise GraphAuthoringValidationError("Duplicate accepted membership")
        members.append(record)
        self.object.nodes = list(self._members)
        self.object.edges = list(self._connections)

    def edge(self, local_key: str, left: Any, right: Any) -> EdgeObject:
        key = _name(local_key)
        if key in self._edges:
            raise GraphAuthoringValidationError("Duplicate edge " + _path(self._key, "edges", key))
        if not all(any(node is endpoint for node in self._members) for endpoint in (left, right)):
            raise GraphAuthoringValidationError("Edge endpoints must be explicit members of their layer")
        edge = EdgeObject((left, right), _identity(self._owner.snapshot_key, self._key, "e", key))
        self._edges[key] = edge
        self._endpoints[key] = (left, right)
        self._connections.append(edge)
        self.object.edges = list(self._connections)
        return edge

    def action(self, local_key: str, source: NodeObject, **fields: Any) -> ActionObject:
        key = _name(local_key)
        if key in self._actions:
            raise GraphAuthoringValidationError("Duplicate action " + _path(self._key, "actions", key))
        if not any(source is node for node in self._nodes.values()):
            raise GraphAuthoringValidationError("An action needs its exact declared owning node in this layer")
        if any(field in fields for field in ("source_layer", "client_key")):
            raise GraphAuthoringValidationError("The scoped module supplies identity and source provenance")
        target = fields.get("target")
        if isinstance(target, ScopedAuthoringLayer):
            fields["target"] = target.object
        action = ActionObject(source_layer=self.object,
                              client_key=_identity(self._owner.snapshot_key, self._key, "a", key), **fields)
        self._actions[key] = (source, action)
        return action

    def layout(self, placements: Sequence[tuple[Any, float, float]], *, edge_shape: Any,
               edge_routes: Sequence[EdgeRouteObject] = (), default_node: Any = None,
               size_justification: str | None = None) -> None:
        self.object.layout = LayerLayoutObject([NodePlacementObject(*item) for item in placements], edge_shape, edge_routes)
        self.object.default_node = default_node
        self._size_justification = size_justification
        self._ready = True


class ScopedGraphAuthoring:
    def __init__(self, client: RelayerGraphClient, snapshot_key: str) -> None:
        self._client = client
        self._snapshot_key = _name(snapshot_key)
        self._layers: dict[str, ScopedAuthoringLayer] = {}
        self._objects: dict[int, ScopedAuthoringLayer] = {}
        self._writing = False

    @property
    def snapshot_key(self) -> str:
        return self._snapshot_key

    def layer(self, local_key: str) -> ScopedAuthoringLayer:
        key = _name(local_key)
        if key in self._layers:
            raise GraphAuthoringValidationError("Duplicate layer " + key)
        layer = ScopedAuthoringLayer(self, key)
        self._layers[key] = layer
        self._objects[id(layer.object)] = layer
        return layer

    def _remember(self, key: str, context: str) -> None:
        previous = self._client._scoped_identities.get(key)
        if previous is not None and previous != context:
            raise GraphAuthoringValidationError("A scoped edge or action changed its identity-owning context; use a new key")
        self._client._scoped_identities[key] = context

    async def write(self, root: ScopedAuthoringLayer) -> GraphWriteResult:
        if self._writing or self._objects.get(id(root.object)) is not root:
            raise GraphAuthoringValidationError("The root must belong to this idle authoring scope")
        self._writing = True
        reservations = []
        claimed: set[str] = set()
        completed: list[CompletedAuthoringWrite] = []
        failures: list[FailedAuthoringWrite] = []
        try:
            layers: list[tuple[ScopedAuthoringLayer, LayerObject, str | None]] = []
            actions: list[tuple[str, NodeObject, ActionObject, ActionObject]] = []
            accepted: dict[int, int] = {}
            visited: set[int] = set()

            def visit(layer: ScopedAuthoringLayer) -> None:
                if id(layer.object) in visited:
                    return
                visited.add(id(layer.object))
                if not layer._ready:
                    raise GraphAuthoringValidationError("Unfinished layout at " + _path(layer._key))
                if layer.object.client_key != _identity(self.snapshot_key, layer._key, "l", ""):
                    raise GraphAuthoringValidationError("A declared layer identity changed")
                if not _same(layer.object.nodes, layer._members) or not _same(layer.object.edges, layer._connections):
                    raise GraphAuthoringValidationError("Use declarations to change layer membership")
                for record in [*layer._members, *layer._connections]:
                    if not isinstance(record, (NodeObject, EdgeObject)):
                        if type(record) not in (GraphNode, GraphEdge) or record.state != "accepted" or type(record.id) is not int or record.id < 1:
                            raise GraphAuthoringValidationError("Accepted membership changed before capture")
                        accepted[id(record)] = record.id
                placements = [NodePlacementObject(item.node, item.x, item.y) for item in layer.object.layout.placements]
                if (len(placements) != len(layer._members) or len({id(item.node) for item in placements}) != len(placements)
                        or any(not any(item.node is node for node in layer._members)
                               or any(type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1
                                      for value in (item.x, item.y)) for item in placements)):
                    raise GraphAuthoringValidationError("Layout needs one explicit normalized placement per member at " + _path(layer._key))
                if layer.object.default_node is not None and not any(layer.object.default_node is node for node in layer._members):
                    raise GraphAuthoringValidationError("The default node must be an explicit layer member")
                routes = []
                for route in layer.object.layout.edge_routes:
                    if not any(route.edge is edge for edge in layer._connections):
                        raise GraphAuthoringValidationError("Route edge must be an explicit layer member")
                    ends = None if route.ends is None else tuple(EdgeEndObject(end.node, end.side) for end in route.ends)
                    if ends is not None and (len(ends) != 2 or any(not any(end.node is node for node in layer._members) for end in ends)):
                        raise GraphAuthoringValidationError("Route ends must be explicit layer members")
                    routes.append(EdgeRouteObject(route.edge, route.shape, ends, _copy(route.waypoints)))
                captured = LayerObject(list(layer._members), list(layer._connections),
                                       LayerLayoutObject(placements, layer.object.layout.edge_shape, routes),
                                       layer.object.client_key, layer.object.default_node, renderer=layer.object.renderer)
                layers.append((layer, captured, layer._size_justification))
                for key, node in layer._nodes.items():
                    if node.client_key != _identity(self.snapshot_key, layer._key, "n", key):
                        raise GraphAuthoringValidationError("A declared node identity changed")
                for key, edge in layer._edges.items():
                    endpoints = layer._endpoints[key]
                    if edge.client_key != _identity(self.snapshot_key, layer._key, "e", key) or not _same(edge.endpoints, endpoints):
                        raise GraphAuthoringValidationError("Changed edge endpoints require a new edge key")
                    context = sorted("key:" + node.client_key if isinstance(node, NodeObject) else "id:" + str(accepted[id(node)]) for node in endpoints)
                    self._remember(edge.client_key, json.dumps(context))
                for key, (source, action) in layer._actions.items():
                    if action.client_key != _identity(self.snapshot_key, layer._key, "a", key) or action.source_layer is not layer.object:
                        raise GraphAuthoringValidationError("Repair must retain the action's identity and exact containing source layer")
                    self._remember(action.client_key, json.dumps([layer.object.client_key, source.client_key]))
                    target = action.target
                    if action.kind == "navigate":
                        if isinstance(target, LayerObject):
                            child = self._objects.get(id(target))
                            if child is None:
                                raise GraphAuthoringValidationError("Navigation targets must be declared in this scope or explicitly accepted layers")
                            visit(child)
                        elif type(target) is not GraphLayer or target.state != "accepted" or type(target.id) is not int or target.id < 1:
                            raise GraphAuthoringValidationError("Navigation needs an explicit accepted layer record")
                        else:
                            target = target.id
                    inputs = []
                    for reference in action.input_actions:
                        if type(reference) is int and reference > 0:
                            inputs.append(reference)
                            continue
                        if type(reference) is dict and "id" in reference:
                            if reference.get("kind") != "input" or reference.get("state") != "accepted" or type(reference["id"]) is not int or reference["id"] < 1:
                                raise GraphAuthoringValidationError("Invoke needs an explicit accepted Input action record")
                            inputs.append(reference["id"])
                            continue
                        declared = next(((owner, candidate) for owner, candidate in layer._actions.values() if candidate is reference), None)
                        if declared is None or declared[0] is not source or reference.kind != "input":
                            raise GraphAuthoringValidationError("Invoke Inputs must be declared on the same source Node and scoped Layer")
                        inputs.append(replace(reference, options=_copy(reference.options), icon=_copy(reference.icon)))
                    actions.append((_path(layer._key, "actions", key), source, action, replace(action, target=target, options=_copy(action.options), icon=_copy(action.icon), input_actions=tuple(inputs))))

            visit(root)
            keys = {key for layer, _, _ in layers for key in [layer.object.client_key,
                    *(node.client_key for node in layer._nodes.values()), *(edge.client_key for edge in layer._edges.values()),
                    *(action.client_key for _, action in layer._actions.values())]}
            if keys & self._client._scoped_writes:
                raise GraphAuthoringValidationError("An overlapping scoped write is running; await it before repairing the same identities")
            claimed = keys
            self._client._scoped_writes.update(claimed)
            node_results: dict[int, GraphNode] = {}
            edge_results: dict[int, GraphEdge] = {}
            layer_results: dict[int, GraphLayer] = {}
            action_results: list[dict[str, Any]] = []
            stages: list[list[tuple[str, str, Callable[[], Awaitable[Any]]]]] = [[], [], [], []]
            node_ref = lambda node: node_results[id(node)] if id(node) in node_results else accepted[id(node)]
            edge_ref = lambda edge: edge_results[id(edge)] if id(edge) in edge_results else accepted[id(edge)]

            # Capture every selected program synchronously before starting any task.
            for layer, _, _ in layers:
                for key, node in layer._nodes.items():
                    reservation = self._client._capture_node_write(node)
                    reservations.append(reservation)
                    async def submit_node(node: NodeObject = node, reservation: Any = reservation) -> GraphNode:
                        result = await reservation.run()
                        node_results[id(node)] = result
                        return result
                    stages[0].append((_path(layer._key, "nodes", key), "node", submit_node))
                for key, edge in layer._edges.items():
                    endpoints = layer._endpoints[key]
                    captured_key = edge.client_key
                    async def submit_edge(edge: EdgeObject = edge, endpoints: Any = endpoints, captured_key: str = captured_key) -> GraphEdge:
                        result = await self._client.create_edge(EdgeObject(tuple(node_ref(node) for node in endpoints), captured_key))
                        edge_results[id(edge)] = result
                        edge.ref = result
                        return result
                    stages[1].append((_path(layer._key, "edges", key), "edge", submit_edge))
            for layer, captured, justification in layers:
                async def submit_layer(layer: ScopedAuthoringLayer = layer, captured: LayerObject = captured,
                                       justification: str | None = justification) -> GraphLayer:
                    layout = LayerLayoutObject([NodePlacementObject(node_ref(item.node), item.x, item.y) for item in captured.layout.placements],
                        captured.layout.edge_shape, [EdgeRouteObject(edge_ref(route.edge), route.shape,
                            None if route.ends is None else tuple(EdgeEndObject(node_ref(end.node), end.side) for end in route.ends),
                            route.waypoints) for route in captured.layout.edge_routes])
                    result = await self._client.submit_layer(LayerObject([node_ref(node) for node in captured.nodes],
                        [edge_ref(edge) for edge in captured.edges], layout, captured.client_key,
                        None if captured.default_node is None else node_ref(captured.default_node), renderer=captured.renderer), size_justification=justification)
                    layer_results[id(layer.object)] = result
                    layer.object.ref = result
                    return result
                stages[2].append((_path(layer._key), "layer", submit_layer))
            for action_path, source, original, action in actions:
                async def submit_action(source: NodeObject = source, original: ActionObject = original, action: ActionObject = action) -> Any:
                    fields = replace(action, source_layer=layer_results[id(action.source_layer)],
                                     target=layer_results[id(action.target)] if id(action.target) in layer_results else action.target,
                                     input_actions=tuple(entry if type(entry) is int else replace(entry, source_layer=layer_results[id(entry.source_layer)]) for entry in action.input_actions))
                    response = await self._client._add_captured_action(node_ref(source), original, fields)
                    result = dict(response["action"])
                    action_results.append(result)
                    return result
                stages[3].append((action_path, "action", submit_action))
            for index, stage in enumerate(stages):
                cursor = 0
                stopped = False
                async def worker() -> None:
                    nonlocal cursor
                    while not stopped and not failures and cursor < len(stage):
                        job_path, kind, run = stage[cursor]
                        cursor += 1
                        try:
                            value = await run()
                            record_id = value["id"] if kind == "action" else value.id
                            if type(record_id) is not int or record_id < 1:
                                raise ValueError("Write response lacks a valid record identity")
                            completed.append(CompletedAuthoringWrite(job_path, kind, record_id))
                        except Exception as error:
                            rejected = isinstance(error, (GraphAuthoringValidationError, ValidationError)) or isinstance(error, APIError) and isinstance(error.status, int) and 400 <= error.status < 500
                            # Older bridge failures carry a frozen program but no HTTP outcome.
                            # A frozen package alone cannot prove a rejected server write.
                            if isinstance(error, ValidationError) and type(error.details) is dict and error.details.get("frozen") is True and type(error.details.get("httpStatus")) is not int:
                                rejected = False
                            failures.append(FailedAuthoringWrite(job_path, "rejected" if rejected else "unknown", error))
                running = asyncio.gather(*(worker() for _ in range(min(2, len(stage)))))
                cancelled = False
                while not running.done():
                    try:
                        await asyncio.shield(running)
                    except asyncio.CancelledError:
                        # Repeated cancellation cannot release claims while transport is live.
                        stopped = True
                        cancelled = True
                running.result()
                if cancelled:
                    raise asyncio.CancelledError()
                if failures:
                    unstarted = [job[0] for job in stage[cursor:]] + [job[0] for later in stages[index + 1:] for job in later]
                    error = GraphAuthoringWriteError(completed, failures, unstarted)
                    raise error from failures[0].cause
            return GraphWriteResult(layer_results[id(root.object)], tuple(node_results.values()),
                                    tuple(edge_results.values()), tuple(layer_results.values()), tuple(action_results))
        finally:
            for reservation in reservations:
                reservation.cancel()
            self._client._scoped_writes.difference_update(claimed)
            self._writing = False
