/**
 * Curated Relayer icon rendering for the vanilla desktop workspace.
 *
 * The allowlist is the product grammar. Lucide is only the drawing library;
 * exposing its entire catalog here would silently broaden what authors can
 * persist. Unknown names can still occur in legacy accepted graphs and render
 * as a neutral circle rather than breaking replay.
 */
export const RELAYER_ICON_NAMES = Object.freeze([
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
]);

export const RELAYER_ICON_ALIASES = Object.freeze({
  "circle-alert": "alert-circle",
  "circle-help": "help-circle",
  "file-pen": "file-edit",
  messagecirclequestion: "message-circle-question",
  messagessquare: "messages-square",
});

export const RELAYER_ICON_FALLBACK = "circle";

const relayerIconNameSet = new Set(RELAYER_ICON_NAMES);

export function normalizeRelayerIconName(name) {
  return String(name ?? "").trim().toLowerCase().replace(/[-_\s]+/g, "-").replace(/^-|-$/g, "");
}

export function resolveRelayerIconName(name) {
  const normalized = normalizeRelayerIconName(name);
  if (relayerIconNameSet.has(normalized)) return normalized;
  return Object.hasOwn(RELAYER_ICON_ALIASES, normalized)
    ? RELAYER_ICON_ALIASES[normalized]
    : null;
}

export function relayerIconDescriptor(name) {
  const canonicalName = resolveRelayerIconName(name);
  const renderedName = canonicalName ?? RELAYER_ICON_FALLBACK;
  return Object.freeze({
    canonicalName,
    renderedName,
    lucideExportName: toPascalCase(renderedName),
    usesFallback: canonicalName === null,
  });
}

export function createRelayerIcon(name, attributes = {}) {
  const descriptor = relayerIconDescriptor(name);
  const lucide = assertRelayerIconRendererReady();
  const iconNode = lucide[descriptor.lucideExportName] ?? lucide.Circle;
  return lucide.createElement(iconNode, {
    "aria-hidden": "true",
    focusable: "false",
    ...attributes,
    "data-relayer-icon": descriptor.renderedName,
  });
}

export function assertRelayerIconRendererReady() {
  const lucide = globalThis.lucide;
  if (typeof lucide?.createElement !== "function" || !lucide.Circle) {
    throw new Error("The vendored Lucide renderer must load before Relayer icons are created.");
  }
  return lucide;
}

function toPascalCase(name) {
  return name.replace(/(\w)(\w*)(_|-|\s*)/g, (_match, first, rest) =>
    first.toUpperCase() + rest.toLowerCase());
}
