/**
 * The curated icon vocabulary accepted by GraphComplete.
 *
 * Keep this list aligned with `relayer-graph-core` and the renderer module.
 * It is intentionally smaller than Lucide's complete export surface.
 */
export const RELAYER_ICON_NAMES = [
  "alert-circle",
  "alert-triangle",
  "archive",
  "arrow-right-circle",
  "arrow-right-left",
  "bar-chart-3",
  "bell",
  "book-open",
  "book-open-text",
  "boxes",
  "brain",
  "blocks",
  "bolt",
  "bot",
  "box",
  "braces",
  "check-circle",
  "clipboard-check",
  "clipboard",
  "cloud",
  "code",
  "cog",
  "columns-3",
  "component",
  "compass",
  "copy",
  "credit-card",
  "cpu",
  "database-backup",
  "database",
  "file",
  "file-code-2",
  "file-code",
  "file-edit",
  "file-output",
  "file-search",
  "file-text",
  "folder-git-2",
  "folder-tree",
  "folder",
  "folders",
  "frame",
  "function-square",
  "git-branch",
  "git-branch-plus",
  "git-commit",
  "git-compare",
  "git-graph",
  "git-merge",
  "git-pull-request",
  "globe",
  "grid-3x3",
  "hard-drive",
  "heart",
  "help-circle",
  "info",
  "key",
  "layers",
  "library",
  "layout",
  "layout-panel-left",
  "layout-template",
  "layout-grid",
  "link-2",
  "link",
  "list-checks",
  "list-tree",
  "list",
  "list-ordered",
  "loader",
  "lock",
  "mail",
  "message-circle-question",
  "messages-square",
  "menu",
  "mic",
  "monitor",
  "network",
  "package",
  "palette",
  "panels-top-left",
  "pencil-line",
  "pie-chart",
  "play-circle",
  "plug",
  "puzzle",
  "radio",
  "rotate-ccw",
  "route",
  "rss",
  "satellite",
  "scroll-text",
  "search",
  "send",
  "server",
  "server-cog",
  "settings",
  "share-2",
  "shield-alert",
  "shield-check",
  "shield",
  "smartphone",
  "sprout",
  "square-dashed-kanban",
  "square",
  "star",
  "table",
  "terminal",
  "upload",
  "user",
  "users",
  "webhook",
  "wifi",
  "workflow",
  "wrench",
  "zap",
] as const;

export type RelayerIconName = typeof RELAYER_ICON_NAMES[number];

export const RELAYER_ICON_ALIASES = Object.freeze({
  "circle-alert": "alert-circle",
  "circle-help": "help-circle",
  "file-pen": "file-edit",
  messagecirclequestion: "message-circle-question",
  messagessquare: "messages-square",
} satisfies Readonly<Record<string, RelayerIconName>>);

const relayerIconNameSet: ReadonlySet<string> = new Set(RELAYER_ICON_NAMES);

export function normalizeRelayerIconName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_\s]+/g, "-").replace(/^-|-$/g, "");
}

export function resolveRelayerIconName(name?: string | null): RelayerIconName | null {
  if (name === undefined || name === null) return null;
  const normalized = normalizeRelayerIconName(name);
  if (relayerIconNameSet.has(normalized)) return normalized as RelayerIconName;
  return Object.hasOwn(RELAYER_ICON_ALIASES, normalized)
    ? RELAYER_ICON_ALIASES[normalized as keyof typeof RELAYER_ICON_ALIASES]
    : null;
}

export function isRelayerIconName(name?: string | null): name is RelayerIconName {
  return name !== undefined && name !== null && relayerIconNameSet.has(name);
}

export function isSupportedRelayerIcon(name?: string | null): boolean {
  return resolveRelayerIconName(name) !== null;
}
