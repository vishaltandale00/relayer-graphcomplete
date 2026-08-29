"""Canonical semantic Complete handle for agent-authored recursive work."""
from __future__ import annotations

import asyncio
import json
import os
import socket
from dataclasses import dataclass
from typing import Any, Awaitable, Mapping
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .authoring import CompletionInputGraph
from .exceptions import ConfigurationError, TransportError


@dataclass(frozen=True, slots=True)
class CompletionCurrentSnapshot:
    completion_id: int
    lifecycle: str
    revision: int
    current_layer_id: int | None
    final_layer_id: int | None
    safe_reason: str | None = None

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "CompletionCurrentSnapshot":
        completion_id = _positive_int(value.get("completionId"), "completionId")
        lifecycle = value.get("lifecycle")
        if lifecycle not in {"active", "succeeded", "stopped", "failed"}:
            raise TransportError("completion broker returned an invalid lifecycle")
        revision = value.get("headRevision", value.get("revision"))
        if type(revision) is not int or revision < 0:
            raise TransportError("completion broker returned an invalid revision")
        safe_reason = value.get("safeReason")
        if safe_reason is not None and not isinstance(safe_reason, str):
            raise TransportError("completion broker returned an invalid safe reason")
        return cls(
            completion_id,
            lifecycle,
            revision,
            _optional_graph_id(value.get("currentLayerId"), "currentLayerId"),
            _optional_graph_id(value.get("finalLayerId"), "finalLayerId"),
            safe_reason,
        )


class CompletionTerminalError(RuntimeError):
    def __init__(self, current: CompletionCurrentSnapshot, reason: str) -> None:
        super().__init__(f"Completion {current.completion_id} {current.lifecycle}: {reason}")
        self.completion_id = current.completion_id
        self.lifecycle = current.lifecycle
        self.current = current
        self.reason = reason


class CompletionCurrent:
    def __init__(self, transport: "_CompletionTransport") -> None:
        self._transport = transport

    async def snapshot(self) -> CompletionCurrentSnapshot:
        await self._transport.started
        value = await self._transport.request("GET", f"/{self._transport.completion_id}/current")
        return CompletionCurrentSnapshot.from_dict(value)


class CompletionHandle:
    """One live semantic child: its identity, its durable current, and its awaited result."""

    def __init__(self, transport: "_CompletionTransport") -> None:
        self._transport = transport
        self._observation: "asyncio.Task[Mapping[str, Any]] | None" = None
        self.completion_id = transport.completion_id
        self.current = CompletionCurrent(transport)

    @property
    def result(self) -> Awaitable[Mapping[str, Any]]:
        """Observation starts on the first read, so an unawaited child costs nothing."""
        if self._observation is None:
            self._observation = asyncio.get_running_loop().create_task(
                self._transport.observe_result()
            )
        return self._observation

    async def stop(self, reason: str) -> None:
        """Stop this child from the execution that invoked it.

        Only the direct parent may stop a completion. The child keeps its retained
        current and reports stopped; the parent's own invoke stays navigable.
        """
        await self._transport.started
        await self._transport.request(
            "POST", f"/{self.completion_id}/stop", {"reason": reason}
        )


def complete(input_graph: CompletionInputGraph) -> CompletionHandle:
    if not isinstance(input_graph, CompletionInputGraph) or input_graph.interaction_node < 1:
        raise ValueError("complete() requires an already-prepared CompletionInputGraph")
    return CompletionHandle(_CompletionTransport(input_graph.interaction_node))


class _CompletionTransport:
    def __init__(self, completion_id: int) -> None:
        self.completion_id = completion_id
        self.url = ""
        self.token = ""
        self.started = asyncio.get_running_loop().create_task(self._start())
        # A fire-and-forget child is never awaited, so absorb its start failure rather
        # than leaving asyncio to report a never-retrieved task exception.
        self.started.add_done_callback(_absorb_unobserved_failure)

    async def _start(self) -> None:
        self.url, self.token = await _current_broker()
        value = await self.request("POST", "", {"interactionNode": self.completion_id})
        if value.get("completionId") != self.completion_id:
            raise TransportError("completion broker returned a different completion identity")

    async def observe_result(self) -> Mapping[str, Any]:
        """Observe this child until it settles, one request per delivered revision.

        The broker holds each observation open until the completion advances past the
        last revision this caller saw, so waiting never polls on a timer.
        """
        await self.started
        after_revision: int | None = None
        while True:
            path = f"/{self.completion_id}/result"
            if after_revision is not None:
                path = f"{path}?afterRevision={after_revision}"
            status, value = await self.request_with_status("GET", path)
            if status == 200:
                return value
            if status == 202:
                current = value.get("current") if isinstance(value, Mapping) else None
                if not isinstance(current, Mapping):
                    raise TransportError("completion broker delivered an observation without a current")
                after_revision = CompletionCurrentSnapshot.from_dict(current).revision
                continue
            if status == 409:
                current = CompletionCurrentSnapshot.from_dict(value["current"])
                raise CompletionTerminalError(current, str(value.get("reason") or "completion_failed"))
            raise TransportError(f"completion broker returned HTTP {status}")

    async def request(self, method: str, path: str, body: Any = None) -> Mapping[str, Any]:
        status, value = await self.request_with_status(method, path, body)
        if status not in (200, 201):
            raise TransportError(f"completion broker returned HTTP {status}")
        return value

    async def request_with_status(self, method: str, path: str, body: Any = None) -> tuple[int, Mapping[str, Any]]:
        encoded = None if body is None else json.dumps(body, separators=(",", ":")).encode()
        headers = {"accept": "application/json", "authorization": f"Bearer {self.token}"}
        if encoded is not None:
            headers["content-type"] = "application/json"

        def send() -> tuple[int, Mapping[str, Any]]:
            request = Request(self.url + path, data=encoded, method=method, headers=headers)
            try:
                with urlopen(request, timeout=30.0) as response:
                    return response.status, json.loads(response.read() or b"{}")
            except HTTPError as error:
                try:
                    return error.code, json.loads(error.read() or b"{}")
                finally:
                    error.close()
            except (URLError, socket.timeout, TimeoutError, OSError) as error:
                raise TransportError(f"could not reach the completion broker at {self.url}") from error

        return await asyncio.to_thread(send)


def _absorb_unobserved_failure(task: "asyncio.Task[Any]") -> None:
    if not task.cancelled():
        task.exception()


async def _current_broker() -> tuple[str, str]:
    url = os.environ.get("RELAYER_COMPLETE_URL")
    token = os.environ.get("RELAYER_COMPLETE_TOKEN")
    if url and token:
        return url.rstrip("/"), token
    try:
        from rlm import host_request
    except ImportError as error:
        raise ConfigurationError("the current execution has no completion broker") from error
    value: Any = await host_request("relayer.complete.current")
    if not isinstance(value, Mapping) or not isinstance(value.get("url"), str) or not isinstance(value.get("token"), str):
        raise ConfigurationError("relayer.complete.current returned an invalid completion broker")
    return value["url"].rstrip("/"), value["token"]


def _positive_int(value: Any, field: str) -> int:
    if type(value) is not int or value < 1:
        raise TransportError(f"completion broker returned an invalid {field}")
    return value


def _optional_graph_id(value: Any, field: str) -> int | None:
    return None if value is None else _positive_int(value, field)
