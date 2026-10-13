"""Shared action declarations for visual mounts and ordinary graph writes."""
from __future__ import annotations
from dataclasses import dataclass
from typing import Any
from .authoring import LayerObject, LayerReference, NodeObject


def _layer_declaration(layer: LayerReference, owner: NodeObject | None = None, *, _repair_source: NodeObject | None = None) -> Any:
    if not isinstance(layer, LayerObject):
        if owner is not None:
            raise ValueError("A visual action needs its exact authored source LayerObject")
        return layer if isinstance(layer, int) else layer.id
    if owner is not None and not any(node is (_repair_source if _repair_source is not None else owner) for node in layer.nodes):
        raise ValueError("The source layer must contain the exact owning NodeObject")
    return {"clientKey": layer.client_key, "nodes": [
        node.client_key for node in layer.nodes if isinstance(node, NodeObject)
    ]}


@dataclass(frozen=True, slots=True)
class ActionObject:
    kind: str
    label: str
    source_layer: LayerObject | None
    client_key: str
    target: LayerReference | None = None
    relation: str | None = None
    interaction_text: str | None = None
    control: str | None = None
    prompt: str | None = None
    options: tuple[tuple[str, str], ...] = ()
    minimum_selections: int | None = None
    variant: str = "pill"
    icon: str | None = None
    description: str | None = None
    input_actions: tuple[int | ActionObject, ...] = ()
    reusable: bool = False

    def to_detail_wire(self, owner: NodeObject, *, _repair_source: NodeObject | None = None) -> dict[str, Any]:
        value: dict[str, Any] = {
            "kind": self.kind, "label": self.label, "clientKey": self.client_key,
            "variant": self.variant,
        }
        if self.source_layer is not None:
            value["sourceLayer"] = _layer_declaration(self.source_layer, owner, _repair_source=_repair_source)
        elif self.kind != "navigate":
            raise ValueError("Invoke and input visual actions require a source layer")
        if self.icon is not None:
            value["icon"] = self.icon
        if self.description is not None:
            value["description"] = self.description
        if self.kind == "navigate":
            if self.target is None:
                raise ValueError("Navigate needs a target layer")
            value.update(relation=self.relation, target=_layer_declaration(self.target))
        elif self.kind == "invoke":
            value["interactionText"] = self.interaction_text
            if not isinstance(self.reusable, bool):
                raise ValueError("Invoke reusable must be a boolean")
            value["reusable"] = self.reusable
            if self.input_actions:
                references: list[Any] = []
                seen: set[int | str] = set()
                for entry in self.input_actions:
                    if type(entry) is int and entry > 0:
                        identity: int | str = entry
                        reference: Any = entry
                    elif type(entry) is ActionObject and entry.kind == "input":
                        _layer_declaration(entry.source_layer, owner, _repair_source=_repair_source)
                        identity = entry.client_key
                        reference = {"inputActionClientKey": entry.client_key}
                    else:
                        raise ValueError("Invoke references must name Input declarations or positive action IDs")
                    if identity in seen:
                        raise ValueError("Duplicate Invoke Input reference")
                    seen.add(identity)
                    references.append(reference)
                value["inputActions"] = references
        elif self.kind == "input":
            value.update(control=self.control, prompt=self.prompt)
            if self.control != "text":
                value["options"] = [{"key": key, "label": label} for key, label in self.options]
            if self.minimum_selections is not None:
                value["minimumSelections"] = self.minimum_selections
        else:
            raise ValueError("Unknown graph action kind")
        return value
