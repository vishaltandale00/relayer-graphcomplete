"""Advisory draft previews returned by graph writes (PRD §11.10)."""
from __future__ import annotations

import base64
import binascii
import os
import re
from dataclasses import dataclass
from typing import Any, Literal

PreviewStatus = Literal["rendered", "cached", "failed", "limit_reached"]


@dataclass(frozen=True, slots=True)
class GraphPreview:
    """An image of a draft write. It never affects acceptance."""
    status: PreviewStatus
    path: str | None = None
    width: int | None = None
    height: int | None = None


_FAILED = GraphPreview("failed")


def materialize_preview(value: Any, directory: str | None, target: str) -> GraphPreview | None:
    """Write a returned PNG into the host's preview folder; otherwise report ``failed``."""
    if value is None:
        return None
    if not isinstance(value, dict):
        return _FAILED
    status = value.get("status")
    if status in ("failed", "limit_reached"):
        return GraphPreview(status)
    if status not in ("rendered", "cached"):
        return _FAILED
    width, height = value.get("width"), value.get("height")
    digest = re.match(r"^sha256:([0-9a-f]{16})", str(value.get("fingerprint", "")))
    if digest is None or not directory or not _positive(width) or not _positive(height):
        return _FAILED
    try:
        content = base64.b64decode(str(value.get("pngBase64", "")), validate=True)
        path = os.path.join(directory, f"{target}-{digest.group(1)}.png")
        # The host owns the per-turn folder and deletes it when the turn ends.
        with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "wb") as file:
            file.write(content)
    except (OSError, binascii.Error):
        return _FAILED
    return GraphPreview(status, path, width, height)


def host_preview(value: Any) -> GraphPreview | None:
    """Read a preview the Prime host already wrote into the turn's preview folder."""
    if value is None:
        return None
    if not isinstance(value, dict):
        return _FAILED
    status = value.get("status")
    if status in ("failed", "limit_reached"):
        return GraphPreview(status)
    path, width, height = value.get("path"), value.get("width"), value.get("height")
    if status not in ("rendered", "cached") or not isinstance(path, str) or not path \
            or not _positive(width) or not _positive(height):
        return _FAILED
    return GraphPreview(status, path, width, height)


def _positive(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0
