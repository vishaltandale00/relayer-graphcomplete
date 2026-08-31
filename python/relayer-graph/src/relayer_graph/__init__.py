"""Object-based Python client for the GraphComplete Rust graph engine."""

from .authoring import (ActionVariant, CompletionInputGraph, EdgeObject, GraphAuthoringClient, GraphEdge,
                        GraphLayer, GraphNode, InteractionContext, InteractionInput,
                        InteractionInputNode, SubmittedInput,
                        LayerLayout, LayerLayoutObject,
                        InputControl, InputOption, LayerObject, NavigateRelation, NodeObject, NodePlacement,
                        NodePlacementObject, RelayerGraphClient)
from .exceptions import (APIError, AuthenticationError, ConfigurationError, NotFound,
                         RelayerGraphError, TransportError, ValidationError,
                         ValidationIssue)
from .icons import (RELAYER_ICON_ALIASES, RELAYER_ICON_NAMES,
                    is_supported_relayer_icon, normalize_relayer_icon_name,
                    resolve_relayer_icon_name)
from .session import GraphSession
from .completion import (CompletionCurrent, CompletionCurrentSnapshot, CompletionHandle,
                         CompletionTerminalError, complete)

Client = RelayerGraphClient
GraphClient = RelayerGraphClient

__all__ = [
    "Client", "GraphClient", "RelayerGraphClient", "GraphAuthoringClient",
    "GraphSession",
    "NodeObject", "EdgeObject", "LayerObject", "NodePlacementObject", "LayerLayoutObject",
    "GraphNode", "GraphEdge", "GraphLayer", "InteractionContext", "InteractionInput", "InteractionInputNode", "SubmittedInput",
    "NodePlacement", "LayerLayout",
    "ActionVariant", "NavigateRelation", "InputControl", "InputOption",
    "CompletionInputGraph",
    "complete", "CompletionHandle", "CompletionCurrent", "CompletionCurrentSnapshot",
    "CompletionTerminalError",
    "RelayerGraphError", "ConfigurationError", "TransportError", "APIError",
    "AuthenticationError", "NotFound", "ValidationError", "ValidationIssue",
    "RELAYER_ICON_NAMES", "RELAYER_ICON_ALIASES", "normalize_relayer_icon_name",
    "resolve_relayer_icon_name", "is_supported_relayer_icon",
]
