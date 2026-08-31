"""Typed public wire contract for bounded graph search."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Mapping, TypedDict, Union


class GraphQueryBudget(TypedDict, total=False):
    queryBytes: int
    astDepth: int
    variables: int
    patternParts: int
    traversalHops: int
    examinedExpansions: int
    intermediateRows: int
    wallTimeMs: int
    resultRows: int
    encodedResultBytes: int


class GraphQueryScalarTypeDescriptor(TypedDict):
    kind: Literal["null", "boolean", "integer", "float", "string", "node", "layer", "relationship", "path"]


class GraphQueryListTypeDescriptor(TypedDict):
    kind: Literal["list"]
    elementType: "GraphQueryTypeDescriptor"


class GraphQueryRecordTypeField(TypedDict):
    name: str
    type: "GraphQueryTypeDescriptor"


class GraphQueryRecordTypeDescriptor(TypedDict):
    kind: Literal["record"]
    fields: list[GraphQueryRecordTypeField]


GraphQueryTypeDescriptor = Union[GraphQueryScalarTypeDescriptor,
                                 GraphQueryListTypeDescriptor,
                                 GraphQueryRecordTypeDescriptor]


class GraphQueryNullValue(TypedDict):
    type: Literal["null"]


class GraphQueryBooleanValue(TypedDict):
    type: Literal["boolean"]
    value: bool


class GraphQueryIntegerValue(TypedDict):
    type: Literal["integer"]
    # Signed 64-bit integers intentionally remain decimal strings in Python.
    value: str


class GraphQueryFloatValue(TypedDict):
    type: Literal["float"]
    value: float


class GraphQueryStringValue(TypedDict):
    type: Literal["string"]
    value: str


class GraphQueryProperty(TypedDict):
    name: str
    value: "GraphQueryValue"


class GraphQueryNodeValue(TypedDict):
    type: Literal["node"]
    id: str
    kind: Literal["Content"]
    properties: list[GraphQueryProperty]


class GraphQueryLayerValue(TypedDict):
    type: Literal["layer"]
    id: str
    kind: Literal["Layer"]
    properties: list[GraphQueryProperty]


class GraphQueryRelationshipValue(TypedDict):
    type: Literal["relationship"]
    id: str
    kind: Literal["CONNECTED", "CONTAINS", "EXPANDS", "REFERENCES"]
    start: str
    end: str
    directed: bool
    properties: list[GraphQueryProperty]


class GraphQueryPathValue(TypedDict):
    type: Literal["path"]
    vertices: list[Union[GraphQueryNodeValue, GraphQueryLayerValue]]
    relationships: list[GraphQueryRelationshipValue]


class GraphQueryListValue(TypedDict):
    type: Literal["list"]
    elementType: GraphQueryTypeDescriptor
    values: list["GraphQueryValue"]


class GraphQueryRecordField(TypedDict):
    name: str
    value: "GraphQueryValue"


class GraphQueryRecordValue(TypedDict):
    type: Literal["record"]
    fields: list[GraphQueryRecordField]


GraphQueryValue = Union[GraphQueryNullValue, GraphQueryBooleanValue,
                        GraphQueryIntegerValue, GraphQueryFloatValue,
                        GraphQueryStringValue, GraphQueryNodeValue,
                        GraphQueryLayerValue, GraphQueryRelationshipValue,
                        GraphQueryPathValue, GraphQueryListValue,
                        GraphQueryRecordValue]


class GraphSearchResult(TypedDict):
    queryContractVersion: Literal[1]
    columns: list[str]
    rows: list[list[GraphQueryValue]]
    truncated: bool


class GraphSearchTarget(TypedDict):
    """A known logical dataset selector. It conveys no authority."""

    scope: Literal["thread", "project"]
    id: int


@dataclass(frozen=True, slots=True)
class GraphSearchRequest:
    """Search input; omission selects the current interaction's thread."""

    query: str
    parameters: Mapping[str, GraphQueryValue] = field(default_factory=dict)
    budget: GraphQueryBudget = field(default_factory=GraphQueryBudget)
    target: GraphSearchTarget | None = None
    query_contract_version: Literal[1] = 1

    def to_wire(self) -> dict[str, object]:
        request: dict[str, object] = {
            "queryContractVersion": self.query_contract_version,
            "query": self.query,
            "parameters": dict(self.parameters),
            "budget": dict(self.budget),
        }
        if self.target is not None:
            request = {
                "queryContractVersion": self.query_contract_version,
                "target": {"scope": self.target["scope"], "id": self.target["id"]},
                "query": self.query,
                "parameters": dict(self.parameters),
                "budget": dict(self.budget),
            }
        return request
