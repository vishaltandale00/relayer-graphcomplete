use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;

use crate::{ActionId, GraphError, NodeId, RecordState};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: NodeId,
    #[serde(default)]
    pub leased_action_id: Option<ActionId>,
    pub kind: String,
    pub icon: String,
    pub title: String,
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authored_detail: Option<serde_json::Value>,
    pub state: RecordState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionInvocation {
    pub source_interaction_node_id: NodeId,
    pub source_action_id: ActionId,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeDraft {
    pub client_key: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    pub icon: String,
    pub title: String,
    pub detail: String,
}

impl NodeDraft {
    pub(crate) fn validate(&self) -> Result<&'static str, GraphError> {
        super::require_nonempty(&self.client_key, "clientKey")?;
        super::require_nonempty(&self.kind, "kind")?;
        super::require_nonempty(&self.icon, "icon")?;
        super::require_nonempty(&self.title, "title")?;
        super::require_nonempty(&self.detail, "detail")?;
        super::resolve_icon_name(&self.icon)
            .ok_or_else(|| {
                GraphError::validation(
                    "unsupported_icon",
                    "icon",
                    format!(
                        "Unsupported icon {:?}. Choose a name from the curated Relayer icon vocabulary: {}.",
                        self.icon,
                        super::RELAYER_ICON_NAMES.join(", ")
                    ),
                )
            })
    }
}

fn default_kind() -> String {
    "concept".into()
}

pub(crate) fn validate_authored_detail(value: &Value) -> Result<(), GraphError> {
    let object = value.as_object().ok_or_else(|| {
        GraphError::validation(
            "authored_detail_invalid",
            "authoredDetail",
            "Authored Node Detail must be one canonical package object.",
        )
    })?;
    let expected_keys = [
        "assets",
        "components",
        "integritySha256",
        "mounts",
        "version",
    ];
    if object.len() != expected_keys.len()
        || expected_keys.iter().any(|key| !object.contains_key(*key))
    {
        return Err(GraphError::validation(
            "authored_detail_invalid",
            "authoredDetail",
            "Authored Node Detail must use the exact canonical package fields.",
        ));
    }
    if object.get("version").and_then(Value::as_u64) != Some(1)
        || !object.get("components").is_some_and(Value::is_array)
        || !object.get("mounts").is_some_and(Value::is_array)
        || !object.get("assets").is_some_and(Value::is_array)
    {
        return Err(GraphError::validation(
            "authored_detail_invalid",
            "authoredDetail",
            "Authored Node Detail package collections and version are invalid.",
        ));
    }
    validate_authored_detail_schema(object)?;
    let integrity = object
        .get("integritySha256")
        .and_then(Value::as_str)
        .filter(|digest| is_lower_hex_digest(digest))
        .ok_or_else(|| {
            GraphError::validation(
                "authored_detail_integrity_invalid",
                "authoredDetail.integritySha256",
                "Authored Node Detail integrity must be one lowercase SHA-256 digest.",
            )
        })?;
    let mut content = object.clone();
    content.remove("integritySha256");
    let canonical = canonical_json(&Value::Object(content));
    if canonical.len() > 512 * 1024 {
        return Err(GraphError::validation(
            "authored_detail_too_large",
            "authoredDetail",
            "Authored Node Detail exceeds the canonical package byte limit.",
        ));
    }
    let actual = format!("{:x}", Sha256::digest(canonical.as_bytes()));
    if integrity != actual {
        return Err(GraphError::validation(
            "authored_detail_integrity_mismatch",
            "authoredDetail.integritySha256",
            "Authored Node Detail canonical integrity does not match its package content.",
        ));
    }
    Ok(())
}

fn validate_authored_detail_schema(
    object: &serde_json::Map<String, Value>,
) -> Result<(), GraphError> {
    let components = object["components"].as_array().expect("checked above");
    let assets = object["assets"].as_array().expect("checked above");
    let mounts = object["mounts"].as_array().expect("checked above");
    if components.len() > 64 || mounts.len() > 128 || assets.len() > 32 {
        return authored_detail_schema_error(
            "Authored Node Detail package counts exceed V1 limits.",
        );
    }
    let mut component_ids = HashSet::new();
    for (index, component) in components.iter().enumerate() {
        let Some(component) = component.as_object() else {
            return authored_detail_schema_error("Authored Node Detail component is invalid.");
        };
        if !has_exact_keys(component, &["css", "html", "id", "order"])
            || !component
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(is_bounded_identity)
            || component.get("order").and_then(Value::as_u64) != Some(index as u64)
            || !component.get("html").is_some_and(Value::is_string)
            || !component.get("css").is_some_and(Value::is_string)
            || !component_ids.insert(component["id"].as_str().expect("checked").to_owned())
        {
            return authored_detail_schema_error(
                "Authored Node Detail component identity or order is invalid.",
            );
        }
    }
    let mut asset_ids = HashSet::new();
    for asset in assets {
        let Some(asset) = asset.as_object() else {
            return authored_detail_schema_error("Authored Node Detail asset is invalid.");
        };
        let media_type = asset.get("mediaType").and_then(Value::as_str);
        if !has_exact_keys(
            asset,
            &["digestSha256", "id", "mediaType", "representation"],
        ) || !asset
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(is_bounded_identity)
            || !asset
                .get("digestSha256")
                .and_then(Value::as_str)
                .is_some_and(is_lower_hex_digest)
            || !matches!(
                media_type,
                Some("image/jpeg" | "image/png" | "image/svg+xml")
            )
            || asset.get("representation").and_then(Value::as_str) != Some("image")
            || !asset_ids.insert(asset["id"].as_str().expect("checked").to_owned())
        {
            return authored_detail_schema_error(
                "Authored Node Detail asset schema is invalid or unsupported.",
            );
        }
    }
    let mut mount_ids = HashSet::new();
    for mount in mounts {
        let Some(mount) = mount.as_object() else {
            return authored_detail_schema_error("Authored Node Detail mount is invalid.");
        };
        let identity_valid = mount
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(is_bounded_identity)
            && mount
                .get("componentId")
                .and_then(Value::as_str)
                .is_some_and(|id| component_ids.contains(id))
            && mount
                .get("host")
                .and_then(Value::as_str)
                .is_some_and(is_bounded_identity)
            && mount_ids.insert(
                mount
                    .get("id")
                    .and_then(Value::as_str)
                    .expect("checked")
                    .to_owned(),
            );
        let kind_valid = match mount.get("kind").and_then(Value::as_str) {
            Some("asset") => {
                has_exact_keys(mount, &["assetId", "componentId", "host", "id", "kind"])
                    && mount
                        .get("assetId")
                        .and_then(Value::as_str)
                        .is_some_and(|id| asset_ids.contains(id))
            }
            Some("capability") => {
                has_exact_keys(mount, &["capability", "componentId", "host", "id", "kind"])
                    && mount.get("capability").is_some_and(valid_capability)
            }
            _ => false,
        };
        if !identity_valid || !kind_valid {
            return authored_detail_schema_error(
                "Authored Node Detail mount schema or reference is invalid.",
            );
        }
    }
    Ok(())
}

fn valid_capability(value: &Value) -> bool {
    let Some(capability) = value.as_object() else {
        return false;
    };
    match capability.get("kind").and_then(Value::as_str) {
        Some("link") => {
            has_exact_keys(capability, &["href", "kind"])
                && capability.get("href").is_some_and(Value::is_string)
        }
        Some("expand" | "reference" | "invoke" | "input") => {
            has_exact_keys(capability, &["action", "kind"])
                && capability
                    .get("action")
                    .and_then(Value::as_object)
                    .is_some_and(|action| {
                        has_exact_keys(action, &["clientKey", "sourceLayer", "sourceNode"])
                            && action
                                .get("clientKey")
                                .and_then(Value::as_str)
                                .is_some_and(is_bounded_identity)
                            && action
                                .get("sourceLayer")
                                .is_some_and(valid_stable_reference)
                            && action.get("sourceNode").is_some_and(valid_stable_reference)
                    })
        }
        _ => false,
    }
}

fn valid_stable_reference(value: &Value) -> bool {
    let Some(reference) = value.as_object() else {
        return false;
    };
    !reference.is_empty()
        && reference
            .keys()
            .all(|key| matches!(key.as_str(), "id" | "clientKey"))
        && reference
            .get("id")
            .is_none_or(|id| id.as_u64().is_some_and(|id| id > 0))
        && reference
            .get("clientKey")
            .is_none_or(|key| key.as_str().is_some_and(is_bounded_identity))
}

fn has_exact_keys(object: &serde_json::Map<String, Value>, expected: &[&str]) -> bool {
    object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key))
}

fn is_bounded_identity(value: &str) -> bool {
    !value.is_empty() && value.trim() == value && !value.contains('\0') && value.len() <= 128
}

fn authored_detail_schema_error(message: &str) -> Result<(), GraphError> {
    Err(GraphError::validation(
        "authored_detail_invalid",
        "authoredDetail",
        message,
    ))
}

fn is_lower_hex_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).expect("JSON strings serialize"),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("JSON object keys serialize"),
                        canonical_json(&values[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::GraphNode;

    #[test]
    fn legacy_node_payloads_default_missing_lease_identity() {
        let node: GraphNode = serde_json::from_str(
            r#"{
                "id": 1,
                "kind": "concept",
                "icon": "box",
                "title": "Legacy node",
                "detail": "Created before interaction leases",
                "state": "accepted"
            }"#,
        )
        .unwrap();

        assert_eq!(node.leased_action_id, None);
        assert_eq!(node.authored_detail, None);
    }
}
