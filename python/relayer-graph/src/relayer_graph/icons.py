"""The curated Relayer icon vocabulary accepted by GraphComplete."""
from types import MappingProxyType

# Keep this list aligned with relayer-graph-core and the renderer module. It is
# intentionally smaller than Lucide's complete export surface.
RELAYER_ICON_NAMES = (
    "alert-circle", "alert-triangle", "archive", "arrow-right-circle",
    "arrow-right-left", "bar-chart-3", "bell", "book-open", "book-open-text",
    "boxes", "brain", "blocks", "bolt", "bot", "box", "braces",
    "check-circle", "clipboard-check", "clipboard", "cloud", "code", "cog",
    "columns-3", "component", "compass", "copy", "credit-card", "cpu",
    "database-backup", "database", "file", "file-code-2", "file-code",
    "file-edit", "file-output", "file-search", "file-text", "folder-git-2",
    "folder-tree", "folder", "folders", "frame", "function-square",
    "git-branch", "git-branch-plus", "git-commit", "git-compare", "git-graph",
    "git-merge", "git-pull-request", "globe", "grid-3x3", "hard-drive",
    "heart", "help-circle", "info", "key", "layers", "library", "layout",
    "layout-panel-left", "layout-template", "layout-grid", "link-2", "link",
    "list-checks", "list-tree", "list", "list-ordered", "loader", "lock",
    "mail", "message-circle-question", "messages-square", "menu", "mic",
    "monitor", "network", "package", "palette", "panels-top-left",
    "pencil-line", "pie-chart", "play-circle", "plug", "puzzle", "radio",
    "rotate-ccw", "route", "rss", "satellite", "scroll-text", "search",
    "send", "server", "server-cog", "settings", "share-2", "shield-alert",
    "shield-check", "shield", "smartphone", "sprout", "square-dashed-kanban",
    "square", "star", "table", "terminal", "upload", "user", "users",
    "webhook", "wifi", "workflow", "wrench", "zap",
)

RELAYER_ICON_ALIASES = MappingProxyType({
    "circle-alert": "alert-circle",
    "circle-help": "help-circle",
    "file-pen": "file-edit",
    "messagecirclequestion": "message-circle-question",
    "messagessquare": "messages-square",
})

_RELAYER_ICON_NAME_SET = frozenset(RELAYER_ICON_NAMES)


def normalize_relayer_icon_name(name: str) -> str:
    """Normalize casing plus spaces/underscores without broadening the vocabulary."""
    return "-".join(name.strip().lower().replace("_", " ").replace("-", " ").split())


def resolve_relayer_icon_name(name: str | None) -> str | None:
    """Return a canonical icon name or ``None`` for an unsupported name."""
    if name is None:
        return None
    normalized = normalize_relayer_icon_name(name)
    if normalized in _RELAYER_ICON_NAME_SET:
        return normalized
    return RELAYER_ICON_ALIASES.get(normalized)


def is_supported_relayer_icon(name: str | None) -> bool:
    """Whether a name is accepted by the GraphComplete authoring boundary."""
    return resolve_relayer_icon_name(name) is not None
