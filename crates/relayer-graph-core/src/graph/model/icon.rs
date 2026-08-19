/// Icon names that GraphComplete authors may persist on new nodes.
///
/// This is intentionally a curated Relayer vocabulary rather than the full
/// Lucide catalog. Additions are product-contract changes and must also be
/// reflected in the TypeScript, Python, and renderer vocabularies.
pub const RELAYER_ICON_NAMES: &[&str] = &[
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
];

/// Compatibility spellings accepted at the authoring boundary and normalized
/// to the canonical names above before persistence.
pub const RELAYER_ICON_ALIASES: &[(&str, &str)] = &[
    ("circle-alert", "alert-circle"),
    ("circle-help", "help-circle"),
    ("file-pen", "file-edit"),
    ("messagecirclequestion", "message-circle-question"),
    ("messagessquare", "messages-square"),
];

pub fn normalize_icon_name(name: &str) -> String {
    let mut normalized = String::with_capacity(name.len());
    let mut pending_separator = false;
    for character in name.trim().chars().flat_map(char::to_lowercase) {
        if character == '-' || character == '_' || character.is_whitespace() {
            pending_separator = !normalized.is_empty();
        } else {
            if pending_separator && !normalized.ends_with('-') {
                normalized.push('-');
            }
            pending_separator = false;
            normalized.push(character);
        }
    }
    normalized
}

pub fn resolve_icon_name(name: &str) -> Option<&'static str> {
    let normalized = normalize_icon_name(name);
    if let Some(&canonical) = RELAYER_ICON_NAMES
        .iter()
        .find(|&&candidate| candidate == normalized)
    {
        return Some(canonical);
    }
    RELAYER_ICON_ALIASES
        .iter()
        .find_map(|&(alias, canonical)| (alias == normalized).then_some(canonical))
}

pub fn is_supported_icon(name: &str) -> bool {
    resolve_icon_name(name).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_canonical_names_and_compatibility_aliases() {
        assert_eq!(resolve_icon_name(" compass "), Some("compass"));
        assert_eq!(resolve_icon_name("Circle Alert"), Some("alert-circle"));
        assert_eq!(resolve_icon_name("FILE_PEN"), Some("file-edit"));
    }

    #[test]
    fn rejects_names_outside_the_curated_vocabulary() {
        assert!(!is_supported_icon("🧭"));
        assert!(!is_supported_icon("made-up-icon"));
    }
}
