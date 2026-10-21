"""Trusted instruction-publication and reasoned-delivery wire types.

Field spelling follows the server's JSON receipts. Publication identity and
delivery state are owned by the server, never a Python-side instruction cache.
"""
from __future__ import annotations

from typing import Literal, NotRequired, TypedDict


InstructionRetrievalPurpose = Literal[
    "authority", "authoring", "presentation", "navigation", "search", "preview",
    "repair", "delegation", "verification", "recovery",
]


class InstructionRetrievalReason(TypedDict):
    purpose: InstructionRetrievalPurpose
    detail: str


class InstructionModulePointer(TypedDict):
    key: str
    title: str
    nodeId: int
    prerequisites: list[int]


class InstructionGraphManifest(TypedDict):
    versionKey: str
    digest: str
    retrievalContractVersion: NotRequired[int]
    threadId: int
    interactionNodeId: int
    rootLayerId: int
    modules: list[InstructionModulePointer]


class InstructionRetrievalEntry(TypedDict):
    nodeId: int
    key: str
    title: str
    delivery: Literal["body", "already-returned", "reread"]
    bodyCharacters: int
    bodyBytes: int
    firstRequestKey: NotRequired[str]
    detail: NotRequired[str]


class InstructionRetrievalReceipt(TypedDict):
    versionKey: str
    digest: str
    requestKey: str
    replayed: bool
    reason: InstructionRetrievalReason
    rereadReason: NotRequired[str]
    entries: list[InstructionRetrievalEntry]
