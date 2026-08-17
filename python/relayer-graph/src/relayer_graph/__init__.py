"""Object-based Python client for the GraphComplete Rust graph engine."""

from .authoring import (EdgeObject, GraphAuthoringClient, GraphEdge, GraphLayer,
                        GraphNode, LayerObject, NodeObject, RelayerGraphClient)
from .exceptions import (APIError, AuthenticationError, ConfigurationError, NotFound,
                         RelayerGraphError, TransportError, ValidationError)

Client = RelayerGraphClient
GraphClient = RelayerGraphClient

__all__ = [
    "Client", "GraphClient", "RelayerGraphClient", "GraphAuthoringClient",
    "NodeObject", "EdgeObject", "LayerObject", "GraphNode", "GraphEdge", "GraphLayer",
    "RelayerGraphError", "ConfigurationError", "TransportError", "APIError",
    "AuthenticationError", "NotFound", "ValidationError",
]
