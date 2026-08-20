use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use thiserror::Error;

const REQUIRED_PROFILES: [(&str, &str, &str); 3] = [
    ("ask", "bounded", "user"),
    ("auto", "bounded", "automatic"),
    ("full", "unrestricted", "none"),
];

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PermissionProfile {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) authority: String,
    pub(crate) reviewer: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PermissionCatalogFile {
    schema_version: u32,
    profiles: Vec<PermissionProfile>,
    enabled_profiles: Vec<String>,
    default_profile: String,
}

#[derive(Debug, Clone)]
pub(crate) struct PermissionCatalog {
    profiles: HashMap<String, PermissionProfile>,
    enabled: HashSet<String>,
    default_profile: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PermissionProfileAvailability {
    #[serde(flatten)]
    pub(crate) profile: PermissionProfile,
    pub(crate) enabled: bool,
    pub(crate) available: bool,
    pub(crate) unavailable_reason: Option<String>,
}

pub(crate) struct ResolvedPermission<'a> {
    pub(crate) profile: &'a PermissionProfile,
}

impl PermissionCatalog {
    pub(crate) async fn load(path: &std::path::Path) -> Result<Self, PermissionError> {
        let value: PermissionCatalogFile = serde_json::from_slice(&tokio::fs::read(path).await?)?;
        Self::parse(value)
    }

    fn parse(value: PermissionCatalogFile) -> Result<Self, PermissionError> {
        if value.schema_version != 1 {
            return Err(PermissionError::Configuration(format!(
                "unsupported permission catalog schema {}",
                value.schema_version
            )));
        }
        let mut profiles = HashMap::new();
        for profile in value.profiles {
            validate_identifier(&profile.id, "permission profile ID")?;
            if profile.label.trim().is_empty() {
                return Err(PermissionError::Configuration(format!(
                    "permission profile {} has an empty label",
                    profile.id
                )));
            }
            let id = profile.id.clone();
            if profiles.insert(id.clone(), profile).is_some() {
                return Err(PermissionError::Configuration(format!(
                    "duplicate permission profile {id}"
                )));
            }
        }
        if profiles.len() != REQUIRED_PROFILES.len() {
            return Err(PermissionError::Configuration(
                "the base permission catalog must define exactly ask, auto, and full".into(),
            ));
        }
        for (id, authority, reviewer) in REQUIRED_PROFILES {
            let profile = profiles.get(id).ok_or_else(|| {
                PermissionError::Configuration(format!(
                    "the base permission catalog is missing {id}"
                ))
            })?;
            if profile.authority != authority || profile.reviewer != reviewer {
                return Err(PermissionError::Configuration(format!(
                    "permission profile {id} must use authority {authority} and reviewer {reviewer}"
                )));
            }
        }
        let enabled = value.enabled_profiles.into_iter().collect::<HashSet<_>>();
        if enabled.is_empty() || enabled.iter().any(|id| !profiles.contains_key(id)) {
            return Err(PermissionError::Configuration(
                "enabledProfiles must contain only defined permission profiles".into(),
            ));
        }
        if !enabled.contains(&value.default_profile) {
            return Err(PermissionError::Configuration(
                "defaultProfile must be enabled by desktop policy".into(),
            ));
        }
        Ok(Self {
            profiles,
            enabled,
            default_profile: value.default_profile,
        })
    }

    pub(crate) fn default_profile(&self) -> &str {
        &self.default_profile
    }

    pub(crate) fn profile(&self, requested: &str) -> Result<&PermissionProfile, PermissionError> {
        let profile = self
            .profiles
            .get(requested)
            .ok_or_else(|| PermissionError::Selection {
                code: "permission_profile_unknown",
                profile_id: requested.to_owned(),
                message: format!("Unknown permission profile: {requested}"),
            })?;
        if !self.enabled.contains(requested) {
            return Err(PermissionError::Selection {
                code: "permission_profile_disabled",
                profile_id: requested.to_owned(),
                message: format!("Permission profile {requested} is disabled by desktop policy"),
            });
        }
        Ok(profile)
    }

    pub(crate) fn resolve<'a>(
        &'a self,
        bindings: &'a Map<String, Value>,
        requested: &str,
    ) -> Result<ResolvedPermission<'a>, PermissionError> {
        let profile = self.profile(requested)?;
        bindings
            .get(requested)
            .and_then(Value::as_object)
            .ok_or_else(|| PermissionError::Selection {
                code: "permission_profile_unsupported",
                profile_id: requested.to_owned(),
                message: format!(
                    "The selected harness does not support permission profile {requested}"
                ),
            })?;
        Ok(ResolvedPermission { profile })
    }

    pub(crate) fn availability(
        &self,
        bindings: Option<&Map<String, Value>>,
    ) -> Vec<PermissionProfileAvailability> {
        REQUIRED_PROFILES
            .iter()
            .filter_map(|(id, _, _)| self.profiles.get(*id))
            .cloned()
            .map(|profile| {
                let enabled = self.enabled.contains(&profile.id);
                let bound = bindings
                    .and_then(|bindings| bindings.get(&profile.id))
                    .is_some_and(Value::is_object);
                PermissionProfileAvailability {
                    unavailable_reason: (!enabled)
                        .then_some("disabled_by_desktop_policy".into())
                        .or_else(|| bindings.is_none().then_some("runtime_unavailable".into()))
                        .or_else(|| (!bound).then_some("unsupported_by_harness".into())),
                    enabled,
                    available: enabled && bound,
                    profile,
                }
            })
            .collect()
    }
}

fn validate_identifier(value: &str, label: &str) -> Result<(), PermissionError> {
    let valid = !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    if valid {
        Ok(())
    } else {
        Err(PermissionError::Configuration(format!(
            "invalid {label}: {value}"
        )))
    }
}

#[derive(Debug, Error)]
pub(crate) enum PermissionError {
    #[error("permission configuration error: {0}")]
    Configuration(String),
    #[error("{message}")]
    Selection {
        code: &'static str,
        profile_id: String,
        message: String,
    },
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog(enabled: &[&str], default_profile: &str) -> PermissionCatalogFile {
        PermissionCatalogFile {
            schema_version: 1,
            profiles: vec![
                PermissionProfile {
                    id: "ask".into(),
                    label: "Ask for approval".into(),
                    authority: "bounded".into(),
                    reviewer: "user".into(),
                },
                PermissionProfile {
                    id: "auto".into(),
                    label: "Approve for me".into(),
                    authority: "bounded".into(),
                    reviewer: "automatic".into(),
                },
                PermissionProfile {
                    id: "full".into(),
                    label: "Full access".into(),
                    authority: "unrestricted".into(),
                    reviewer: "none".into(),
                },
            ],
            enabled_profiles: enabled.iter().map(|value| (*value).to_owned()).collect(),
            default_profile: default_profile.into(),
        }
    }

    #[test]
    fn validates_the_three_profile_product_contract_and_disabled_full_access() {
        let parsed = PermissionCatalog::parse(catalog(&["ask", "auto"], "auto")).unwrap();
        let bindings = serde_json::json!({ "ask": {}, "auto": {}, "full": {} })
            .as_object()
            .unwrap()
            .clone();
        assert!(parsed.resolve(&bindings, "auto").is_ok());
        assert!(matches!(
            parsed.resolve(&bindings, "full"),
            Err(PermissionError::Selection {
                code: "permission_profile_disabled",
                ..
            })
        ));
    }

    #[test]
    fn rejects_a_fourth_base_profile() {
        let mut value = catalog(&["ask", "auto", "full"], "auto");
        value.profiles.push(PermissionProfile {
            id: "fixture".into(),
            label: "Fixture".into(),
            authority: "bounded".into(),
            reviewer: "none".into(),
        });
        assert!(PermissionCatalog::parse(value).is_err());
    }
}
