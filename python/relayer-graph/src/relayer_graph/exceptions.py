"""Exceptions raised by :mod:`relayer_graph`."""
from __future__ import annotations
from typing import Any


class RelayerGraphError(Exception):
    """Base error for client, transport, and service failures."""


class ConfigurationError(RelayerGraphError):
    """Required client configuration is absent or invalid."""


class TransportError(RelayerGraphError):
    """The service could not be reached or returned invalid data."""


class APIError(RelayerGraphError):
    def __init__(self, message: str, *, status: int, details: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.details = details


class AuthenticationError(APIError):
    pass


class NotFound(APIError):
    pass


class ValidationError(APIError):
    pass


class VersionConflict(APIError):
    """An optimistic mutation was based on a stale graph version."""

    def __init__(self, message: str, *, status: int = 409, current_version: int | str | None = None,
                 changed_node_ids: tuple[str, ...] = (), details: Any = None) -> None:
        super().__init__(message, status=status, details=details)
        self.current_version = current_version
        self.changed_node_ids = changed_node_ids
