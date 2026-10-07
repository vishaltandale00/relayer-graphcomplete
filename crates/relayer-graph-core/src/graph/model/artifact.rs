//! Artifact details on a node and the `artifact` layer renderer (PRD 11.11, ADR 0014).
//!
//! Graph-core checks shape only. It has no filesystem, so the graph server asks
//! the harness host to resolve file paths and take fingerprints before a node
//! reaches the writer.

use serde_json::{Map, Value};

use crate::{GraphError, GraphNode, ValidationIssue};

/// The only non-default layer renderer.
pub const ARTIFACT_RENDERER: &str = "artifact";

/// Kinds a node may declare in this release (P1).
pub const ARTIFACT_KINDS: &[&str] = &["website", "pdf", "video", "image", "markdown", "url"];

/// File extensions each file kind accepts, lowercase and with the dot.
pub fn artifact_extensions(kind: &str) -> &'static [&'static str] {
    match kind {
        "website" => &[".html", ".htm"],
        "pdf" => &[".pdf"],
        "video" => &[".mp4", ".webm", ".mov"],
        "image" => &[".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"],
        "markdown" => &[".md", ".markdown"],
        _ => &[],
    }
}

/// Whether a kind reads a file from the thread folder (and so carries a fingerprint).
pub fn is_file_artifact_kind(kind: &str) -> bool {
    !artifact_extensions(kind).is_empty()
}

const VIEWPORTS: &[&str] = &["desktop", "tablet", "phone"];
const MAX_PATH_BYTES: usize = 512;
const MAX_ROUTE_BYTES: usize = 2048;

fn issue(code: &'static str, path: &str, message: impl Into<String>) -> GraphError {
    GraphError::validation(code, path, message)
}

fn keys_within(
    object: &Map<String, Value>,
    allowed: &[&str],
    path: &str,
) -> Result<(), GraphError> {
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(issue(
            "artifact_field_unknown",
            &format!("{path}.{key}"),
            format!(
                "Remove `{key}`; {path} accepts only {}.",
                allowed.join(", ")
            ),
        ));
    }
    Ok(())
}

/// A relative path inside the thread folder: no absolute path, no `..`, no backslash.
pub fn validate_relative_path(value: &Value, path: &str) -> Result<String, GraphError> {
    let text = value
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| {
            issue(
                "artifact_path_invalid",
                path,
                "Give a relative path inside the thread folder, such as site/index.html.",
            )
        })?;
    if text.starts_with('/') || text.contains('\\') || text.contains('\0') || text.contains(':') {
        return Err(issue(
            "artifact_path_not_relative",
            path,
            format!("\"{text}\" must be relative to the thread folder, such as site/index.html."),
        ));
    }
    if text.split('/').any(|part| part == "..") {
        return Err(issue(
            "artifact_path_outside_thread",
            path,
            format!("\"{text}\" leaves the thread folder. Keep artifacts inside it."),
        ));
    }
    if text.len() > MAX_PATH_BYTES {
        return Err(issue(
            "artifact_path_invalid",
            path,
            "Artifact paths are limited to 512 bytes.",
        ));
    }
    Ok(text.to_owned())
}

fn validate_url(value: &Value, path: &str) -> Result<(), GraphError> {
    let text = value.as_str().unwrap_or_default();
    let lower = text.to_ascii_lowercase();
    let loopback = ["http://localhost", "http://127.0.0.1"]
        .iter()
        .any(|prefix| {
            lower == *prefix
                || lower.starts_with(&format!("{prefix}:"))
                || lower.starts_with(&format!("{prefix}/"))
        });
    if !(lower.starts_with("https://") && text.len() > "https://".len()) && !loopback {
        return Err(issue(
            "artifact_url_scheme",
            path,
            "Use an https URL, or plain http only for localhost or 127.0.0.1.",
        ));
    }
    if text.len() > MAX_ROUTE_BYTES || text.chars().any(char::is_whitespace) {
        return Err(issue(
            "artifact_url_invalid",
            path,
            "Give one URL without spaces, at most 2048 bytes.",
        ));
    }
    Ok(())
}

fn validate_part(kind: &str, part: &Map<String, Value>) -> Result<(), GraphError> {
    let allowed: &[&str] = match kind {
        "website" | "url" => &["route"],
        "pdf" => &["page"],
        "video" => &["start", "end"],
        "markdown" => &["heading"],
        _ => &[],
    };
    keys_within(part, allowed, "artifact.part")?;
    if let Some(route) = part.get("route") {
        let route = route.as_str().unwrap_or_default();
        if !(route.starts_with('/') || route.starts_with('#') || route.starts_with('?'))
            || route.len() > MAX_ROUTE_BYTES
        {
            return Err(issue(
                "artifact_part_invalid",
                "artifact.part.route",
                "A route starts with /, # or ? (for example /pricing or #/cart) and is at most 2048 bytes.",
            ));
        }
    }
    if let Some(page) = part.get("page")
        && !page.as_u64().is_some_and(|page| page >= 1)
    {
        return Err(issue(
            "artifact_part_invalid",
            "artifact.part.page",
            "A PDF page is a whole number from 1.",
        ));
    }
    if part.contains_key("start") || part.contains_key("end") {
        let start = part.get("start").and_then(Value::as_f64);
        let end = part.get("end").and_then(Value::as_f64);
        if !matches!((start, end), (Some(start), Some(end)) if start >= 0.0 && end > start) {
            return Err(issue(
                "artifact_part_invalid",
                "artifact.part",
                "A video segment needs start and end in seconds, with end after start.",
            ));
        }
    }
    if let Some(heading) = part.get("heading")
        && !heading
            .as_str()
            .is_some_and(|text| !text.trim().is_empty() && text.len() <= 256)
    {
        return Err(issue(
            "artifact_part_invalid",
            "artifact.part.heading",
            "Give the heading text to open at.",
        ));
    }
    Ok(())
}

/// Validate one node's `artifact` record. `require_fingerprint` is true once the
/// graph server has asked the host to fingerprint a file artifact.
pub fn validate_artifact(value: &Value, require_fingerprint: bool) -> Result<(), GraphError> {
    let object = value.as_object().ok_or_else(|| {
        issue(
            "artifact_invalid",
            "artifact",
            "Artifact details must be one object with kind and source.",
        )
    })?;
    keys_within(
        object,
        &["kind", "source", "part", "viewport", "fingerprint"],
        "artifact",
    )?;
    let kind = object
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !ARTIFACT_KINDS.contains(&kind) {
        return Err(issue(
            "artifact_kind_unsupported",
            "artifact.kind",
            format!(
                "Use one of {} for artifact.kind.",
                ARTIFACT_KINDS.join(", ")
            ),
        ));
    }
    let source = object
        .get("source")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            issue(
                "artifact_source_invalid",
                "artifact.source",
                "Artifact details need a source object.",
            )
        })?;
    if kind == "url" {
        keys_within(source, &["url"], "artifact.source")?;
        validate_url(
            source.get("url").unwrap_or(&Value::Null),
            "artifact.source.url",
        )?;
    } else {
        keys_within(source, &["file", "root"], "artifact.source")?;
        let file = validate_relative_path(
            source.get("file").unwrap_or(&Value::Null),
            "artifact.source.file",
        )?;
        let extension = file
            .rsplit_once('.')
            .map(|(_, ext)| format!(".{}", ext.to_ascii_lowercase()));
        if !extension.is_some_and(|ext| artifact_extensions(kind).contains(&ext.as_str())) {
            return Err(issue(
                "artifact_type_unsupported",
                "artifact.source.file",
                format!(
                    "\"{file}\" is not a supported {kind} file ({}).",
                    artifact_extensions(kind).join(", ")
                ),
            ));
        }
        match (kind, source.get("root")) {
            ("website", Some(root)) => {
                let root = validate_relative_path(root, "artifact.source.root")?;
                let root = root.trim_end_matches('/');
                if !(root == "." || file.starts_with(&format!("{root}/"))) {
                    return Err(issue(
                        "artifact_entry_outside_root",
                        "artifact.source.file",
                        "The website's entry file must sit inside its site root.",
                    ));
                }
            }
            ("website", None) => {
                return Err(issue(
                    "artifact_root_required",
                    "artifact.source.root",
                    "A website names its site root folder, the folder its pages, styles and scripts load from.",
                ));
            }
            (_, Some(_)) => {
                return Err(issue(
                    "artifact_field_unknown",
                    "artifact.source.root",
                    "Only websites take a site root.",
                ));
            }
            (_, None) => {}
        }
    }
    if let Some(part) = object.get("part") {
        let part = part.as_object().ok_or_else(|| {
            issue(
                "artifact_part_invalid",
                "artifact.part",
                "artifact.part must be an object.",
            )
        })?;
        validate_part(kind, part)?;
    }
    if let Some(viewport) = object.get("viewport")
        && (!matches!(kind, "website" | "url")
            || !viewport
                .as_str()
                .is_some_and(|value| VIEWPORTS.contains(&value)))
    {
        return Err(issue(
            "artifact_viewport_invalid",
            "artifact.viewport",
            "Only websites and URLs take a viewport: desktop, tablet or phone.",
        ));
    }
    let fingerprint = object.get("fingerprint");
    if is_file_artifact_kind(kind) && require_fingerprint {
        let valid = fingerprint
            .and_then(Value::as_str)
            .and_then(|value| value.strip_prefix("sha256:"))
            .is_some_and(|hex| {
                hex.len() == 64
                    && hex
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            });
        if !valid {
            return Err(issue(
                "artifact_fingerprint_missing",
                "artifact.fingerprint",
                "File artifacts are fingerprinted by Relayer when submitted; resubmit the node.",
            ));
        }
    } else if !is_file_artifact_kind(kind) && fingerprint.is_some() {
        return Err(issue(
            "artifact_field_unknown",
            "artifact.fingerprint",
            "URL artifacts carry no fingerprint.",
        ));
    }
    Ok(())
}

/// The layer rules: an `artifact` layer has exactly one member node, which has
/// artifact details and no edges; an artifact node appears only in such a layer.
pub(crate) fn validate_layer_renderer(
    renderer: Option<&str>,
    nodes: &[GraphNode],
    edge_count: usize,
) -> Result<(), GraphError> {
    match renderer {
        None => {
            if let Some(node) = nodes.iter().find(|node| node.artifact.is_some()) {
                return Err(GraphError::validation_issues(vec![ValidationIssue::new(
                    "artifact_node_outside_artifact_layer",
                    "renderer",
                    format!(
                        "Node {} has artifact details. Put it alone in a layer whose renderer is \"artifact\", and open that layer with a navigate action.",
                        node.id
                    ),
                )]));
            }
            Ok(())
        }
        Some(ARTIFACT_RENDERER) => {
            if nodes.len() != 1 || nodes[0].artifact.is_none() {
                return Err(issue(
                    "artifact_layer_member_count",
                    "nodes",
                    format!(
                        "An artifact layer holds exactly one node with artifact details; this one has {} node(s){}.",
                        nodes.len(),
                        if nodes.len() == 1 {
                            " without artifact details"
                        } else {
                            ""
                        }
                    ),
                ));
            }
            if edge_count != 0 {
                return Err(issue(
                    "artifact_layer_edges",
                    "edges",
                    "An artifact layer has no edges.",
                ));
            }
            Ok(())
        }
        Some(other) => Err(issue(
            "layer_renderer_unsupported",
            "renderer",
            format!(
                "Unknown layer renderer \"{other}\". Omit renderer for a graph, or use \"artifact\"."
            ),
        )),
    }
}
