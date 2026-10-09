"""Object-based Python client for the GraphComplete Rust graph engine."""

from .authoring import (ActionVariant, CompletionContract, CompletionInputGraph, EdgeObject, GraphAuthoringClient, GraphEdge,
                        GraphInvocation, GraphLayer, GraphNode, InteractionContext, InteractionInput, InteractionPermissions,
                        InteractionInputNode, SubmittedInput,
                        EdgeEnd, EdgeEndObject, EdgeRoute, EdgeRouteObject, LayerLayout, LayerLayoutObject,
                        InputControl, InputOption, LayerObject, NavigateRelation, NodeObject, NodePlacement,
                        NodePlacementObject, RelayerGraphClient)
from .exceptions import (APIError, AuthenticationError, ConfigurationError,
                         GraphQueryError, NotFound, RelayerGraphError,
                         TransportError, ValidationError, ValidationIssue)
from .edge_shapes import EDGE_SHAPES, MAX_EDGE_ROUTE_WAYPOINTS, NODE_SIDES, EdgeShape, NodeSide
from .icons import (RELAYER_ICON_ALIASES, RELAYER_ICON_NAMES,
                    is_supported_relayer_icon, normalize_relayer_icon_name,
                    resolve_relayer_icon_name)
from .session import GraphSession
from .completion import (CompletionCurrent, CompletionCurrentSnapshot, CompletionHandle,
                         CompletionTerminalError, CompletionWatch, complete)
from .query import (GraphQueryBooleanValue, GraphQueryBudget,
                    GraphQueryFloatValue, GraphQueryIntegerValue,
                    GraphQueryLayerValue, GraphQueryListValue,
                    GraphQueryNodeValue, GraphQueryNullValue,
                    GraphQueryPathValue, GraphQueryRecordValue,
                    GraphQueryRelationshipValue, GraphQueryStringValue,
                    GraphQueryTypeDescriptor, GraphQueryValue,
                    GraphSearchRequest, GraphSearchResult, GraphSearchTarget)

Client = RelayerGraphClient
GraphClient = RelayerGraphClient

__all__ = [
    "Client", "GraphClient", "RelayerGraphClient", "GraphAuthoringClient",
    "GraphSession",
    "NodeObject", "EdgeObject", "LayerObject", "NodePlacementObject", "LayerLayoutObject",
    "GraphNode", "GraphEdge", "GraphLayer", "InteractionContext", "InteractionInput", "InteractionPermissions", "InteractionInputNode", "SubmittedInput",
    "NodePlacement", "LayerLayout", "EDGE_SHAPES", "EdgeShape", "NODE_SIDES", "NodeSide",
    "MAX_EDGE_ROUTE_WAYPOINTS", "EdgeEndObject", "EdgeRouteObject", "EdgeEnd", "EdgeRoute",
    "ActionVariant", "NavigateRelation", "InputControl", "InputOption",
    "CompletionInputGraph",
    "CompletionContract",
    "GraphInvocation",
    "complete", "CompletionHandle", "CompletionCurrent", "CompletionCurrentSnapshot", "CompletionWatch",
    "CompletionTerminalError",
    "RelayerGraphError", "ConfigurationError", "TransportError", "APIError",
    "AuthenticationError", "NotFound", "ValidationError", "ValidationIssue",
    "GraphQueryError", "GraphSearchRequest", "GraphSearchResult", "GraphSearchTarget",
    "GraphQueryBudget", "GraphQueryTypeDescriptor", "GraphQueryValue",
    "GraphQueryNullValue", "GraphQueryBooleanValue", "GraphQueryIntegerValue",
    "GraphQueryFloatValue", "GraphQueryStringValue", "GraphQueryNodeValue",
    "GraphQueryLayerValue", "GraphQueryRelationshipValue", "GraphQueryPathValue",
    "GraphQueryListValue", "GraphQueryRecordValue",
    "GraphIcons", "IconDiscoveryItem",
    "RELAYER_ICON_NAMES", "RELAYER_ICON_ALIASES", "normalize_relayer_icon_name",
    "resolve_relayer_icon_name", "is_supported_relayer_icon",
]

from .actions import ActionObject
from .detail import NodeDetailAuthoring, DetailTemplate, html, asset_ref, external_link, action_capability
from .visual_assets import GraphVisualAssets, VisualAssetFile

__all__ += ["ActionObject", "NodeDetailAuthoring", "DetailTemplate", "html", "asset_ref", "external_link", "action_capability", "GraphVisualAssets", "VisualAssetFile"]

from .image_icons import ImageIcon, GraphIcon, image_icon, image_icon_detail, symbol_icon_detail

from .icon_discovery import GraphIcons, IconDiscoveryItem

__all__ += ["ImageIcon", "GraphIcon", "image_icon", "image_icon_detail", "symbol_icon_detail"]
from .preview import GraphPreview
__all__ += ["GraphPreview"]

from .scoped_authoring import (ScopedGraphAuthoring, ScopedAuthoringLayer, GraphWriteResult,
                              GraphAuthoringValidationError, GraphAuthoringWriteError,
                              CompletedAuthoringWrite, FailedAuthoringWrite)
__all__ += ["ScopedGraphAuthoring", "ScopedAuthoringLayer", "GraphWriteResult",
            "GraphAuthoringValidationError", "GraphAuthoringWriteError",
            "CompletedAuthoringWrite", "FailedAuthoringWrite"]
