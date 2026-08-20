use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use thiserror::Error;

pub(crate) const MAX_MODELS_PER_FAMILY: usize = 5;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct ProviderId(String);

impl ProviderId {
    pub(crate) fn parse(value: impl Into<String>) -> Result<Self, CatalogError> {
        let value = value.into();
        validate_stable_id(&value, "providerId")?;
        Ok(Self(value))
    }

    pub(crate) fn from_database(value: String) -> Self {
        debug_assert!(!value.trim().is_empty());
        Self(value)
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct ModelFamilyId(i64);

impl ModelFamilyId {
    pub(crate) fn try_from_value(value: i64) -> Result<Self, CatalogError> {
        if value > 0 {
            Ok(Self(value))
        } else {
            Err(CatalogError::Invalid {
                code: "model_family_id_invalid",
                message: "familyId must be a positive integer".into(),
            })
        }
    }

    pub(crate) fn from_database(value: i64) -> Self {
        debug_assert!(value > 0);
        Self(value)
    }

    pub(crate) fn value(self) -> i64 {
        self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UnavailableReason {
    pub(crate) code: String,
    pub(crate) message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProductHarness {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) available: bool,
    pub(crate) unavailable_reason: Option<UnavailableReason>,
    pub(crate) compatible_provider_ids: Vec<ProviderId>,
    pub(crate) model_compatibility: Vec<HarnessModelCompatibility>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessModelCompatibility {
    pub(crate) provider_id: ProviderId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) model_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) preferred_model_id: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct RuntimeProductHarness {
    pub(crate) id: String,
    pub(crate) model_compatibility: Vec<HarnessModelCompatibility>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderModel {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) visible: bool,
    pub(crate) available: bool,
    pub(crate) unavailable_reason: Option<UnavailableReason>,
    pub(crate) provider_default: bool,
    pub(crate) replacement_model_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CatalogModelSnapshot {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) order: usize,
    pub(crate) visible: bool,
    pub(crate) available: bool,
    pub(crate) unavailable_reason: Option<UnavailableReason>,
    #[serde(default)]
    pub(crate) provider_default: bool,
    pub(crate) replacement_model_id: Option<String>,
    #[serde(default)]
    pub(crate) metadata: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemFamilySnapshot {
    pub(crate) key: String,
    pub(crate) name: String,
    pub(crate) model_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderCatalogSnapshot {
    pub(crate) provider_id: ProviderId,
    pub(crate) label: String,
    pub(crate) connected: bool,
    pub(crate) unavailable_reason: Option<UnavailableReason>,
    pub(crate) models: Vec<CatalogModelSnapshot>,
    pub(crate) system_family: Option<SystemFamilySnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Provider {
    pub(crate) id: ProviderId,
    pub(crate) label: String,
    pub(crate) connected: bool,
    pub(crate) unavailable_reason: Option<UnavailableReason>,
    pub(crate) models: Vec<ProviderModel>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ModelFamilyKind {
    System,
    Custom,
}

impl ModelFamilyKind {
    pub(crate) fn from_database(value: &str) -> Result<Self, CatalogError> {
        match value {
            "system" => Ok(Self::System),
            "custom" => Ok(Self::Custom),
            _ => Err(CatalogError::StoredInvariant(
                "model family has an unknown kind".into(),
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelFamilyMember {
    pub(crate) provider_id: ProviderId,
    pub(crate) model_id: String,
    #[serde(default)]
    pub(crate) position: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelFamily {
    pub(crate) id: ModelFamilyId,
    pub(crate) name: String,
    pub(crate) kind: ModelFamilyKind,
    pub(crate) enabled: bool,
    pub(crate) position: usize,
    pub(crate) members: Vec<ModelFamilyMember>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelSettingsDefaults {
    pub(crate) harness_id: String,
    pub(crate) provider_id: ProviderId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelSettings {
    pub(crate) defaults: ModelSettingsDefaults,
    pub(crate) harnesses: Vec<ProductHarness>,
    pub(crate) providers: Vec<Provider>,
    pub(crate) families: Vec<ModelFamily>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelSelection {
    pub(crate) harness_id: String,
    pub(crate) family_id: ModelFamilyId,
    pub(crate) provider_id: ProviderId,
    pub(crate) model_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InteractionModelSelection {
    pub(crate) family_id: ModelFamilyId,
    pub(crate) provider_id: ProviderId,
    pub(crate) model_id: String,
}

impl From<ModelSelection> for InteractionModelSelection {
    fn from(selection: ModelSelection) -> Self {
        Self {
            family_id: selection.family_id,
            provider_id: selection.provider_id,
            model_id: selection.model_id,
        }
    }
}

#[derive(Debug)]
pub(crate) struct UpdateModelSettingsDefaultsCommand {
    pub(crate) harness_id: Option<String>,
    pub(crate) provider_id: Option<ProviderId>,
}

#[derive(Debug)]
pub(crate) struct CreateModelFamilyCommand {
    pub(crate) name: String,
    pub(crate) enabled: bool,
    pub(crate) members: Vec<ModelFamilyMember>,
}

#[derive(Debug)]
pub(crate) struct UpdateModelFamilyCommand {
    pub(crate) id: ModelFamilyId,
    pub(crate) name: Option<String>,
    pub(crate) enabled: bool,
    pub(crate) members: Option<Vec<ModelFamilyMember>>,
}

#[derive(Debug)]
pub(crate) struct ReorderModelFamiliesCommand {
    pub(crate) family_ids: Vec<ModelFamilyId>,
}

#[derive(Debug)]
pub(crate) struct ValidateModelSelectionCommand {
    pub(crate) harness_id: String,
    pub(crate) family_id: ModelFamilyId,
    pub(crate) provider_id: ProviderId,
    pub(crate) model_id: String,
}

#[derive(Debug, Error)]
pub(crate) enum CatalogError {
    #[error("{message}")]
    Invalid { code: &'static str, message: String },
    #[error(transparent)]
    Selection(Box<ModelSelectionFailure>),
    #[error("{0}")]
    StoredInvariant(String),
}

#[derive(Debug, Error)]
#[error("{message}")]
pub(crate) struct ModelSelectionFailure {
    code: &'static str,
    message: String,
    harness_id: String,
    family_id: ModelFamilyId,
    provider_id: ProviderId,
    model_id: String,
}

impl CatalogError {
    pub(crate) fn invalid(code: &'static str, message: impl Into<String>) -> Self {
        Self::Invalid {
            code,
            message: message.into(),
        }
    }

    pub(crate) fn selection(
        code: &'static str,
        message: impl Into<String>,
        command: &ValidateModelSelectionCommand,
    ) -> Self {
        Self::Selection(Box::new(ModelSelectionFailure {
            code,
            message: message.into(),
            harness_id: command.harness_id.clone(),
            family_id: command.family_id,
            provider_id: command.provider_id.clone(),
            model_id: command.model_id.clone(),
        }))
    }

    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Invalid { code, .. } => code,
            Self::Selection(failure) => failure.code,
            Self::StoredInvariant(_) => "catalog_invariant_failed",
        }
    }

    pub(crate) fn selection_context(
        &self,
    ) -> (Option<&str>, Option<i64>, Option<&str>, Option<&str>) {
        match self {
            Self::Selection(failure) => (
                Some(failure.harness_id.as_str()),
                Some(failure.family_id.value()),
                Some(failure.provider_id.as_str()),
                Some(failure.model_id.as_str()),
            ),
            _ => (None, None, None, None),
        }
    }
}

pub(crate) fn validate_family(
    name: &str,
    members: &[ModelFamilyMember],
) -> Result<String, CatalogError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CatalogError::invalid(
            "model_family_name_required",
            "model family name must be non-empty",
        ));
    }
    if name.chars().count() > 80 {
        return Err(CatalogError::invalid(
            "model_family_name_too_long",
            "model family name must contain at most 80 characters",
        ));
    }
    if members.is_empty() {
        return Err(CatalogError::invalid(
            "model_family_empty",
            "model family must contain at least one model",
        ));
    }
    if members.len() > MAX_MODELS_PER_FAMILY {
        return Err(CatalogError::invalid(
            "model_family_too_large",
            format!("model family cannot contain more than {MAX_MODELS_PER_FAMILY} models"),
        ));
    }
    let mut unique = HashSet::new();
    for member in members {
        validate_stable_id(member.provider_id.as_str(), "providerId")?;
        validate_stable_id(&member.model_id, "modelId")?;
        if !unique.insert((member.provider_id.as_str(), member.model_id.as_str())) {
            return Err(CatalogError::invalid(
                "model_family_duplicate_model",
                "model family cannot contain the same provider model twice",
            ));
        }
    }
    Ok(name.to_owned())
}

pub(crate) fn validate_stable_id(value: &str, label: &str) -> Result<(), CatalogError> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed != value {
        return Err(CatalogError::invalid(
            "stable_id_invalid",
            format!("{label} must be a non-empty string without surrounding whitespace"),
        ));
    }
    if value.chars().count() > 200 || value.chars().any(char::is_control) {
        return Err(CatalogError::invalid(
            "stable_id_invalid",
            format!("{label} is not a valid stable identifier"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(provider: &str, model: &str) -> ModelFamilyMember {
        ModelFamilyMember {
            provider_id: ProviderId::parse(provider).unwrap(),
            model_id: model.into(),
            position: 0,
        }
    }

    #[test]
    fn family_membership_is_provider_specific_unique_and_capped() {
        validate_family(
            "Cross-provider",
            &[member("codex", "same"), member("future", "same")],
        )
        .unwrap();
        assert_eq!(
            validate_family(
                "Duplicate",
                &[member("codex", "same"), member("codex", "same")]
            )
            .unwrap_err()
            .code(),
            "model_family_duplicate_model"
        );
        assert_eq!(
            validate_family(
                "Too many",
                &[
                    member("codex", "1"),
                    member("codex", "2"),
                    member("codex", "3"),
                    member("codex", "4"),
                    member("codex", "5"),
                    member("codex", "6"),
                ],
            )
            .unwrap_err()
            .code(),
            "model_family_too_large"
        );
    }
}
