"""Prime Agent entry point for the graph scope of the current run."""
from __future__ import annotations

from typing import Any, Mapping

from .authoring import RelayerGraphClient
from .exceptions import ConfigurationError


class GraphSession(RelayerGraphClient):
    """A graph client bound to the current ``complete()`` execution."""

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

    def __getstate__(self) -> None:
        raise TypeError("GraphSession is run-scoped and cannot be serialized")

    def __reduce__(self) -> None:
        raise TypeError("GraphSession is run-scoped and cannot be serialized")
