//! Artifact details on a node and the `artifact` layer renderer (PRD 11.11, ADR 0014).
//!
//! Graph-core checks shape only. It has no filesystem, so the graph server asks
//! the harness host to resolve file paths and take fingerprints before a node
//! reaches the writer.

use serde_json::{Map, Value};

use crate::{GraphError, GraphNode, ValidationIssue};

/// The only non-default layer renderer.
pub const ARTIFACT_RENDERER: &str = "artifact";

/// Kinds a node may declare: P1 files and URLs, and P2 web apps started by a server invoke.
pub const ARTIFACT_KINDS: &[&str] = &["website", "pdf", "video", "image", "markdown", "url", "app"];

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
const MAX_COMMAND_BYTES: usize = 1024;
const DEFAULT_IDLE_MINUTES: u64 = 60;
const MAX_IDLE_MINUTES: u64 = 24 * 60;
const MAX_SEED_BYTES: usize = 16 * 1024;
const MAX_SEED_ENTRIES: usize = 64;

/// The idle timeout a server invoke uses when the node names none (PRD 6.6.6).
pub fn server_idle_minutes(server: &Value) -> u64 {
    server
        .get("idleTimeoutMinutes")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_IDLE_MINUTES)
}

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
    validate_url_allowing(value, path, true)
}

/// A web app runs on this machine, so its address must be loopback http.
fn validate_loopback_url(value: &Value, path: &str) -> Result<(), GraphError> {
    validate_url_allowing(value, path, false)
}

fn validate_url_allowing(value: &Value, path: &str, https: bool) -> Result<(), GraphError> {
    let text = value.as_str().unwrap_or_default();
    let lower = text.to_ascii_lowercase();
    // The authority is everything between `://` and the path; userinfo is never allowed,
    // so `http://localhost:@example.com/` cannot pass as loopback.
    let (scheme, rest) = lower.split_once("://").unwrap_or_default();
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = authority.split(':').next().unwrap_or_default();
    let loopback = scheme == "http" && matches!(host, "localhost" | "127.0.0.1");
    if authority.contains('@')
        || authority.is_empty()
        || !((https && scheme == "https") || loopback)
    {
        return Err(issue(
            "artifact_url_scheme",
            path,
            if https {
                "Use an https URL, or plain http only for localhost or 127.0.0.1."
            } else {
                "A web app's address is plain http on localhost or 127.0.0.1, such as http://127.0.0.1:5173/."
            },
        ));
    }
    // A real parse catches what the scheme check cannot: an empty host or an invalid port.
    let parsed = url::Url::parse(text).ok().filter(|parsed| {
        parsed.username().is_empty()
            && parsed.password().is_none()
            && parsed.host_str().is_some_and(|host| !host.is_empty())
    });
    if parsed.is_none() {
        return Err(issue(
            "artifact_url_invalid",
            path,
            "Give a complete URL with a host, such as https://example.com/ or http://127.0.0.1:5173/.",
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

/// The server invoke (PRD 6.6.6): a start command run in the thread folder, the
/// loopback address that answers once it is ready, and an idle timeout in minutes.
fn validate_server(value: &Value) -> Result<(), GraphError> {
    let server = value.as_object().ok_or_else(|| {
        issue(
            "artifact_server_invalid",
            "artifact.server",
            "artifact.server must be an object with a command.",
        )
    })?;
    keys_within(
        server,
        &["command", "readyUrl", "idleTimeoutMinutes"],
        "artifact.server",
    )?;
    let command = server
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default();
    // The approval card shows this exact string, so nothing in it may hide or reorder
    // text: no control, format or bidi characters, and no whitespace but a plain space.
    let hidden = |c: char| {
        c.is_control()
            || (c.is_whitespace() && c != ' ')
            || matches!(
                c,
                '\u{00AD}'
                    | '\u{061C}'
                    | '\u{180E}'
                    | '\u{200B}'..='\u{200F}'
                    | '\u{202A}'..='\u{202E}'
                    | '\u{2060}'..='\u{206F}'
                    | '\u{FEFF}'
                    | '\u{E0000}'..='\u{E007F}'
            )
    };
    if command.trim().is_empty() || command.len() > MAX_COMMAND_BYTES || command.chars().any(hidden)
    {
        return Err(issue(
            "artifact_server_invalid",
            "artifact.server.command",
            "Give one shell command line that starts the app in the thread folder, such as npm run dev.",
        ));
    }
    if let Some(ready) = server.get("readyUrl") {
        validate_loopback_url(ready, "artifact.server.readyUrl")?;
    }
    if let Some(minutes) = server.get("idleTimeoutMinutes")
        && !minutes
            .as_u64()
            .is_some_and(|minutes| (1..=MAX_IDLE_MINUTES).contains(&minutes))
    {
        return Err(issue(
            "artifact_server_invalid",
            "artifact.server.idleTimeoutMinutes",
            "The idle timeout is a whole number of minutes from 1 to 1440 (default 60).",
        ));
    }
    Ok(())
}

/// Starting state (PRD 6.6.7): local storage, and for web apps cookies, for the artifact's
/// own origin. A website is served from Relayer's own scheme, which takes no cookies.
fn validate_seed(kind: &str, value: &Value) -> Result<(), GraphError> {
    let seed = value.as_object().ok_or_else(|| {
        issue(
            "artifact_seed_invalid",
            "artifact.seed",
            "artifact.seed must be an object with localStorage and/or cookies.",
        )
    })?;
    keys_within(seed, &["localStorage", "cookies"], "artifact.seed")?;
    if serde_json::to_vec(value).map_or(usize::MAX, |bytes| bytes.len()) > MAX_SEED_BYTES {
        return Err(issue(
            "artifact_seed_invalid",
            "artifact.seed",
            "A starting state is at most 16 KiB. Keep test values small.",
        ));
    }
    if let Some(storage) = seed.get("localStorage") {
        let entries = storage.as_object().filter(|entries| {
            entries.len() <= MAX_SEED_ENTRIES && entries.values().all(Value::is_string)
        });
        if entries.is_none() {
            return Err(issue(
                "artifact_seed_invalid",
                "artifact.seed.localStorage",
                "localStorage is an object of at most 64 string values, such as {\"cart\": \"[]\"}.",
            ));
        }
    }
    if let Some(cookies) = seed.get("cookies") {
        if kind != "app" {
            return Err(issue(
                "artifact_seed_invalid",
                "artifact.seed.cookies",
                "Only web apps take seeded cookies; a website can seed localStorage.",
            ));
        }
        let valid = cookies.as_array().is_some_and(|cookies| {
            cookies.len() <= MAX_SEED_ENTRIES
                && cookies.iter().all(|cookie| {
                    let Some(cookie) = cookie.as_object() else {
                        return false;
                    };
                    let name = cookie
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let text = |key: &str| {
                        cookie.get(key).is_none_or(|value| {
                            value
                                .as_str()
                                .is_some_and(|text| !text.contains([';', '\n', '\r', '\0']))
                        })
                    };
                    cookie
                        .keys()
                        .all(|key| matches!(key.as_str(), "name" | "value" | "path"))
                        && !name.is_empty()
                        && name
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
                        && cookie.get("value").is_some_and(Value::is_string)
                        && text("value")
                        && text("path")
                })
        });
        if !valid {
            return Err(issue(
                "artifact_seed_invalid",
                "artifact.seed.cookies",
                "cookies is a list of at most 64 {name, value, path?} objects; names use letters, digits, -, _ and .",
            ));
        }
    }
    Ok(())
}

fn validate_part(kind: &str, part: &Map<String, Value>) -> Result<(), GraphError> {
    let allowed: &[&str] = match kind {
        "website" | "url" | "app" => &["route"],
        "pdf" => &["page"],
        "video" => &["start", "end"],
        "markdown" => &["heading"],
        _ => &[],
    };
    keys_within(part, allowed, "artifact.part")?;
    if let Some(route) = part.get("route") {
        let route = route.as_str().unwrap_or_default();
        // `//host` and `/\host` would leave the artifact's own address.
        if !(route.starts_with('/') || route.starts_with('#') || route.starts_with('?'))
            || route.starts_with("//")
            || route.chars().any(char::is_whitespace)
            || route.starts_with("/\\")
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
        &[
            "kind",
            "source",
            "part",
            "viewport",
            "fingerprint",
            "server",
            "seed",
        ],
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
    } else if kind == "app" {
        keys_within(source, &["url"], "artifact.source")?;
        validate_loopback_url(
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
    match (kind, object.get("server")) {
        ("app", Some(server)) => validate_server(server)?,
        ("app", None) => {
            return Err(issue(
                "artifact_server_required",
                "artifact.server",
                "A web app names its server invoke: the command that starts it, such as {\"command\": \"npm run dev\"}.",
            ));
        }
        (_, Some(_)) => {
            return Err(issue(
                "artifact_field_unknown",
                "artifact.server",
                "Only web apps (kind app) take a server invoke.",
            ));
        }
        (_, None) => {}
    }
    if let Some(seed) = object.get("seed") {
        if !matches!(kind, "website" | "app") {
            return Err(issue(
                "artifact_field_unknown",
                "artifact.seed",
                "Only websites and web apps take a starting state.",
            ));
        }
        validate_seed(kind, seed)?;
    }
    if let Some(viewport) = object.get("viewport")
        && (!matches!(kind, "website" | "url" | "app")
            || !viewport
                .as_str()
                .is_some_and(|value| VIEWPORTS.contains(&value)))
    {
        return Err(issue(
            "artifact_viewport_invalid",
            "artifact.viewport",
            "Only websites, web apps and URLs take a viewport: desktop, tablet or phone.",
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
            "URL and web app artifacts carry no fingerprint.",
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
    let members = nodes
        .iter()
        .map(|node| (node.id.to_string(), node.artifact.is_some()))
        .collect::<Vec<_>>();
    validate_renderer_members(renderer, &members, edge_count)
}

/// The same rules for any layer's members, given each node's id and whether it has
/// artifact details; conversation import checks imported layers with it.
pub(crate) fn validate_renderer_members(
    renderer: Option<&str>,
    members: &[(String, bool)],
    edge_count: usize,
) -> Result<(), GraphError> {
    match renderer {
        None => {
            if let Some((id, _)) = members.iter().find(|(_, artifact)| *artifact) {
                return Err(GraphError::validation_issues(vec![ValidationIssue::new(
                    "artifact_node_outside_artifact_layer",
                    "renderer",
                    format!(
                        "Node {id} has artifact details. Put it alone in a layer whose renderer is \"artifact\", and open that layer with a navigate action."
                    ),
                )]));
            }
            Ok(())
        }
        Some(ARTIFACT_RENDERER) => {
            if members.len() != 1 || !members[0].1 {
                return Err(issue(
                    "artifact_layer_member_count",
                    "nodes",
                    format!(
                        "An artifact layer holds exactly one node with artifact details; this one has {} node(s){}.",
                        members.len(),
                        if members.len() == 1 {
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
