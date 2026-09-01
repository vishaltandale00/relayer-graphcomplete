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
    pub(crate) configuration_revision: u32,
    pub(crate) model_rules: Option<HarnessModelRules>,
    pub(crate) execution_access_contracts: Vec<String>,
    pub(crate) family_policy: Option<FamilyPolicyReference>,
    pub(crate) usable_now: bool,
    pub(crate) usable_provider_ids: Vec<ProviderId>,
    pub(crate) usable_family_ids: Vec<ModelFamilyId>,
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
    pub(crate) configuration_digest: String,
    pub(crate) model_compatibility: Vec<HarnessModelCompatibility>,
    pub(crate) configuration_revision: u32,
    pub(crate) model_rules: Option<HarnessModelRules>,
    pub(crate) execution_access_contracts: Vec<String>,
    pub(crate) family_policy: Option<FamilyPolicyReference>,
    pub(crate) runtime_available: bool,
    pub(crate) unavailable_reason: Option<UnavailableReason>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessRuntimeAvailabilityUpdate {
    pub(crate) harness_id: String,
    pub(crate) configuration_digest: String,
    pub(crate) generation: u64,
    pub(crate) available: bool,
    pub(crate) unavailable_reason: Option<UnavailableReason>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExecutionHarnessPolicy {
    pub(crate) configuration_revision: u32,
    pub(crate) configuration_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) model_rules: Option<HarnessModelRules>,
    pub(crate) execution_access_contracts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessModelRule {
    pub(crate) adapter_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) model_id_exact: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) model_id_regex: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessModelRules {
    #[serde(default)]
    pub(crate) allow: Vec<HarnessModelRule>,
    #[serde(default)]
    pub(crate) deny: Vec<HarnessModelRule>,
}

#[derive(Debug)]
pub(crate) struct UpdateHarnessModelRulesCommand {
    pub(crate) harness_id: String,
    pub(crate) expected_revision: u32,
    pub(crate) rules: HarnessModelRules,
}

pub(crate) fn validate_harness_model_rules(rules: &HarnessModelRules) -> Result<(), CatalogError> {
    if rules.allow.len() + rules.deny.len() > 100 {
        return Err(CatalogError::invalid(
            "harness_model_rules_too_large",
            "A harness configuration cannot contain more than 100 model rules.",
        ));
    }
    let mut unique = HashSet::new();
    for (effect, entries) in [("allow", &rules.allow), ("deny", &rules.deny)] {
        for rule in entries {
            validate_stable_id(&rule.adapter_id, "adapterId")?;
            let (kind, pattern) = match (&rule.model_id_exact, &rule.model_id_regex) {
                (Some(exact), None) => {
                    validate_stable_id(exact, "modelIdExact")?;
                    ("exact", exact.as_str())
                }
                (None, Some(pattern)) if !pattern.is_empty() && pattern.len() <= 500 => {
                    // Rust regex character classes such as `\w` are Unicode-aware while
                    // JavaScript's corresponding classes remain ASCII-only even with /u.
                    // Reject escaped alphabetic shorthands so persisted rules have identical
                    // meaning in product validation and the renderer's local projection.
                    if pattern
                        .as_bytes()
                        .windows(2)
                        .any(|pair| pair[0] == b'\\' && pair[1].is_ascii_alphabetic())
                    {
                        return Err(CatalogError::invalid(
                            "harness_model_regex_invalid",
                            "A model regex uses an escaped character class outside the supported cross-runtime subset.",
                        ));
                    }
                    if regex_uses_unsupported_class_syntax(pattern) {
                        return Err(CatalogError::invalid(
                            "harness_model_regex_invalid",
                            "A model regex uses character-class set syntax outside the supported cross-runtime subset.",
                        ));
                    }
                    if pattern.contains("(?")
                        || [
                            "\\1", "\\2", "\\3", "\\4", "\\5", "\\6", "\\7", "\\8", "\\9", "\\k",
                            "\\A", "\\z", "\\Z", "\\G",
                        ]
                        .iter()
                        .any(|unsupported| pattern.contains(unsupported))
                    {
                        return Err(CatalogError::invalid(
                            "harness_model_regex_invalid",
                            "A model regex uses syntax outside the supported cross-runtime subset.",
                        ));
                    }
                    regex::Regex::new(pattern).map_err(|error| {
                        CatalogError::invalid(
                            "harness_model_regex_invalid",
                            format!("Invalid model regex: {error}"),
                        )
                    })?;
                    ("regex", pattern.as_str())
                }
                _ => {
                    return Err(CatalogError::invalid(
                        "harness_model_rule_invalid",
                        "Each model rule requires exactly one exact or regex matcher.",
                    ));
                }
            };
            if !unique.insert((effect, rule.adapter_id.as_str(), kind, pattern)) {
                return Err(CatalogError::invalid(
                    "harness_model_rule_duplicate",
                    "A harness configuration cannot contain duplicate model rules.",
                ));
            }
        }
    }
    Ok(())
}

fn regex_uses_unsupported_class_syntax(pattern: &str) -> bool {
    // ECMAScript /u and Rust regex disagree on class set algebra. Until the renderer can consume
    // the Rust matcher directly, accept only ordinary, non-nested character classes.
    if pattern.contains("&&") || pattern.contains("--") || pattern.contains("~~") {
        return true;
    }
    let mut escaped = false;
    let mut in_class = false;
    for character in pattern.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        match character {
            '[' if in_class => return true,
            '[' => in_class = true,
            ']' => in_class = false,
            _ => {}
        }
    }
    false
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FamilyPolicyReference {
    pub(crate) id: String,
    pub(crate) version: u32,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderDefinition {
    pub(crate) id: ProviderId,
    pub(crate) adapter_id: String,
    pub(crate) label: String,
    pub(crate) endpoint: Option<String>,
    pub(crate) access_contract: String,
    pub(crate) credential_reference: Option<String>,
    pub(crate) lifecycle_state: String,
    pub(crate) removed_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Provider {
    pub(crate) id: ProviderId,
    pub(crate) adapter_id: String,
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
    pub(crate) revision: u32,
    pub(crate) managed_policy: Option<ManagedFamilyPolicy>,
    pub(crate) enabled: bool,
    pub(crate) position: usize,
    pub(crate) members: Vec<ModelFamilyMember>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedFamilyPolicy {
    pub(crate) provider_id: ProviderId,
    pub(crate) policy_id: String,
    pub(crate) policy_version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelSettingsDefaults {
    pub(crate) harness_id: String,
    pub(crate) provider_id: ProviderId,
    pub(crate) family_id: Option<ModelFamilyId>,
    #[serde(skip_serializing)]
    pub(crate) modified: bool,
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
pub(crate) struct ProviderOnboardingProvider {
    pub(crate) id: ProviderId,
    pub(crate) label: String,
    pub(crate) adapter_id: String,
    pub(crate) access_contract: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderOnboardingModel {
    pub(crate) provider_id: ProviderId,
    pub(crate) model_id: String,
    pub(crate) label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderOnboardingFamily {
    pub(crate) id: ModelFamilyId,
    pub(crate) name: String,
    pub(crate) revision: u32,
    pub(crate) members: Vec<ModelFamilyMember>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderOnboardingManagedFamily {
    pub(crate) provider_id: ProviderId,
    pub(crate) policy_id: String,
    pub(crate) policy_version: u32,
    pub(crate) name: String,
    pub(crate) members: Vec<ModelFamilyMember>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderOnboardingHarness {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) configuration_revision: u32,
    pub(crate) selectable: bool,
    pub(crate) selected_initially: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) matching_access_contract: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) incompatibility_reason: Option<UnavailableReason>,
    pub(crate) existing_custom_families: Vec<ProviderOnboardingFamily>,
    pub(crate) existing_managed_families: Vec<ProviderOnboardingFamily>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) managed_family_candidate: Option<ProviderOnboardingManagedFamily>,
    pub(crate) eligible_models: Vec<ProviderOnboardingModel>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderOnboardingProjection {
    pub(crate) provider: ProviderOnboardingProvider,
    pub(crate) app_default_harness_id: String,
    pub(crate) initial_harness_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) app_default_reason: Option<UnavailableReason>,
    pub(crate) harnesses: Vec<ProviderOnboardingHarness>,
    pub(crate) projection_revision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) blocking_reason: Option<UnavailableReason>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProviderOnboardingFamilyIntent {
    Existing {
        family_id: ModelFamilyId,
    },
    Managed {
        policy_id: String,
        policy_version: u32,
    },
    Create {
        name: String,
        members: Vec<ModelFamilyMember>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CompleteProviderOnboardingCommand {
    pub(crate) provider_id: ProviderId,
    pub(crate) harness_id: String,
    pub(crate) expected_projection_revision: String,
    pub(crate) family: ProviderOnboardingFamilyIntent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderOnboardingResolution {
    pub(crate) family_id: ModelFamilyId,
    pub(crate) family_revision: u32,
    pub(crate) resolvable_members: Vec<ModelFamilyMember>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderOnboardingCompletion {
    pub(crate) defaults: ModelSettingsDefaults,
    pub(crate) resolution: ProviderOnboardingResolution,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderOnboardingStatus {
    pub(crate) complete: bool,
    pub(crate) defaults: ModelSettingsDefaults,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) resolution: Option<ProviderOnboardingResolution>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) blocking_reason: Option<UnavailableReason>,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExecutionModelSelection {
    pub(crate) family_id: ModelFamilyId,
    pub(crate) provider_id: ProviderId,
    pub(crate) adapter_id: String,
    pub(crate) access_contract: String,
    pub(crate) model_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExecutionModelRoute {
    pub(crate) provider_id: ProviderId,
    pub(crate) adapter_id: String,
    pub(crate) access_contract: String,
    pub(crate) model_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExecutionModelPlan {
    pub(crate) family_id: ModelFamilyId,
    pub(crate) family_revision: i64,
    pub(crate) orchestrator: ExecutionModelRoute,
    pub(crate) roster: Vec<ExecutionModelRoute>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AdmittedExecutionModelRoute {
    pub(crate) provider_id: ProviderId,
    pub(crate) adapter_id: String,
    pub(crate) access_contract: String,
    pub(crate) model_id: String,
    pub(crate) adapter_implementation_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AdmittedExecutionModelPlan {
    pub(crate) family_id: ModelFamilyId,
    pub(crate) family_revision: i64,
    pub(crate) orchestrator: AdmittedExecutionModelRoute,
    pub(crate) roster: Vec<AdmittedExecutionModelRoute>,
    pub(crate) harness_policy_digest: String,
    pub(crate) digest: String,
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
    pub(crate) family_id: Option<ModelFamilyId>,
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
    // U+2028/U+2029 are ECMAScript line terminators but Rust regex dot matches them. Excluding
    // them from stable catalog IDs makes dot matching identical over the valid model-ID domain.
    if value.chars().count() > 200
        || value
            .chars()
            .any(|character| character.is_control() || matches!(character, '\u{2028}' | '\u{2029}'))
    {
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

    #[test]
    fn harness_rule_validation_rejects_invalid_regex_and_duplicate_entries() {
        let valid = HarnessModelRule {
            adapter_id: "openai-api".into(),
            model_id_exact: None,
            model_id_regex: Some("^gpt-[0-9]+$".into()),
        };
        validate_harness_model_rules(&HarnessModelRules {
            allow: vec![valid.clone()],
            deny: Vec::new(),
        })
        .unwrap();
        assert_eq!(
            validate_harness_model_rules(&HarnessModelRules {
                allow: vec![HarnessModelRule {
                    model_id_regex: Some("(".into()),
                    ..valid.clone()
                }],
                deny: Vec::new(),
            })
            .unwrap_err()
            .code(),
            "harness_model_regex_invalid"
        );
        for pattern in ["^[a-z&&[^q]]+$", "^[a-z--q]+$", "^[a-z~~q]+$"] {
            assert_eq!(
                validate_harness_model_rules(&HarnessModelRules {
                    allow: vec![HarnessModelRule {
                        model_id_regex: Some(pattern.into()),
                        ..valid.clone()
                    }],
                    deny: Vec::new(),
                })
                .unwrap_err()
                .code(),
                "harness_model_regex_invalid"
            );
        }
        assert!(validate_stable_id("model\u{2028}id", "modelId").is_err());
        assert!(validate_stable_id("model\u{2029}id", "modelId").is_err());
        assert_eq!(
            validate_harness_model_rules(&HarnessModelRules {
                allow: vec![HarnessModelRule {
                    model_id_regex: Some("^\\w+$".into()),
                    ..valid.clone()
                }],
                deny: Vec::new(),
            })
            .unwrap_err()
            .code(),
            "harness_model_regex_invalid"
        );
        assert_eq!(
            validate_harness_model_rules(&HarnessModelRules {
                allow: vec![valid.clone(), valid],
                deny: Vec::new(),
            })
            .unwrap_err()
            .code(),
            "harness_model_rule_duplicate"
        );
    }
}
