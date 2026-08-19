"""Object-based Python client for the GraphComplete Rust graph engine."""

from .authoring import (ActionVariant, EdgeObject, GraphAuthoringClient, GraphEdge,
                        GraphLayer, GraphNode, LayerObject, NodeObject,
                        RelayerGraphClient)
from .exceptions import (APIError, AuthenticationError, ConfigurationError, NotFound,
                         RelayerGraphError, TransportError, ValidationError)
from .icons import (RELAYER_ICON_ALIASES, RELAYER_ICON_NAMES,
                    is_supported_relayer_icon, normalize_relayer_icon_name,
                    resolve_relayer_icon_name)

Client = RelayerGraphClient
GraphClient = RelayerGraphClient

__all__ = [
    "Client", "GraphClient", "RelayerGraphClient", "GraphAuthoringClient",
    "NodeObject", "EdgeObject", "LayerObject", "GraphNode", "GraphEdge", "GraphLayer",
    "ActionVariant",
    "RelayerGraphError", "ConfigurationError", "TransportError", "APIError",
    "AuthenticationError", "NotFound", "ValidationError",
    "RELAYER_ICON_NAMES", "RELAYER_ICON_ALIASES", "normalize_relayer_icon_name",
    "resolve_relayer_icon_name", "is_supported_relayer_icon",
]
