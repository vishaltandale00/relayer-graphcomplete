use super::{
    ApiState,
    auth::{authorize_provider_publish, authorize_read, authorize_write},
    error::ApiError,
};
use crate::product::{
    CompleteProviderOnboardingCommand, CreateModelFamilyCommand, HarnessModelRule,
    HarnessModelRules, ModelFamily, ModelFamilyId, ModelFamilyMember, ModelSelection,
    ModelSettings, ModelSettingsDefaults, ProviderCatalogSnapshot, ProviderDefinition, ProviderId,
    ProviderOnboardingCompletion, ProviderOnboardingFamilyIntent, ProviderOnboardingProjection,
    ProviderOnboardingStatus, ReorderModelFamiliesCommand, UpdateHarnessModelRulesCommand,
    UpdateModelFamilyCommand, UpdateModelSettingsDefaultsCommand, ValidateModelSelectionCommand,
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use serde::Deserialize;
use std::collections::HashSet;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DefaultsRequest {
    harness_id: Option<String>,
    provider_id: Option<String>,
    family_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FamilyRequest {
    name: String,
    #[serde(default = "enabled_by_default")]
    enabled: bool,
    members: Vec<MemberRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UpdateFamilyRequest {
    name: Option<String>,
    enabled: bool,
    members: Option<Vec<MemberRequest>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MemberRequest {
    provider_id: String,
    model_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ReorderFamiliesRequest {
    family_ids: Vec<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ValidateSelectionRequest {
    harness_id: String,
    family_id: i64,
    provider_id: String,
    model_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DefaultSelectionQuery {
    harness_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StagedProviderRequest {
    definition: ProviderDefinition,
    catalog: ProviderCatalogSnapshot,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HarnessRulesRequest {
    expected_revision: u32,
    #[serde(default)]
    allow: Vec<HarnessModelRule>,
    #[serde(default)]
    deny: Vec<HarnessModelRule>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProviderOnboardingProjectionQuery {
    provider_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CompleteProviderOnboardingRequest {
    provider_id: String,
    harness_id: String,
    expected_projection_revision: String,
    family: ProviderOnboardingFamilyRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CompleteDefaultOnboardingRequest {
    provider_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum ProviderOnboardingFamilyRequest {
    Existing {
        family_id: i64,
    },
    Managed {
        policy_id: String,
        policy_version: u32,
    },
    Create {
        name: String,
        members: Vec<MemberRequest>,
    },
}

pub(super) async fn get(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<ModelSettings>, ApiError> {
    authorize_read(&state, &headers)?;
    Ok(Json(state.product.model_settings().await?))
}

pub(super) async fn provider_onboarding_projection(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<ProviderOnboardingProjectionQuery>,
) -> Result<Json<ProviderOnboardingProjection>, ApiError> {
    authorize_read(&state, &headers)?;
    let permission_available = permission_available_harnesses(&state).await?;
    Ok(Json(
        state
            .product
            .provider_onboarding_projection(
                &ProviderId::parse(query.provider_id)?,
                &state.default_harness_configuration,
                &permission_available,
            )
            .await?,
    ))
}

pub(super) async fn complete_provider_onboarding(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<CompleteProviderOnboardingRequest>,
) -> Result<Json<ProviderOnboardingCompletion>, ApiError> {
    authorize_write(&state, &headers)?;
    let family = match request.family {
        ProviderOnboardingFamilyRequest::Existing { family_id } => {
            ProviderOnboardingFamilyIntent::Existing {
                family_id: ModelFamilyId::try_from_value(family_id)?,
            }
        }
        ProviderOnboardingFamilyRequest::Managed {
            policy_id,
            policy_version,
        } => ProviderOnboardingFamilyIntent::Managed {
            policy_id,
            policy_version,
        },
        ProviderOnboardingFamilyRequest::Create {
            name,
            members: requested_members,
        } => ProviderOnboardingFamilyIntent::Create {
            name,
            members: members(requested_members)?,
        },
    };
    let permission_available = permission_available_harnesses(&state).await?;
    Ok(Json(
        state
            .product
            .complete_provider_onboarding(
                &CompleteProviderOnboardingCommand {
                    provider_id: ProviderId::parse(request.provider_id)?,
                    harness_id: request.harness_id,
                    expected_projection_revision: request.expected_projection_revision,
                    family,
                },
                &state.default_harness_configuration,
                &permission_available,
            )
            .await?,
    ))
}

pub(super) async fn complete_default_onboarding(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<CompleteDefaultOnboardingRequest>,
) -> Result<Json<Option<ProviderOnboardingCompletion>>, ApiError> {
    authorize_write(&state, &headers)?;
    let permission_available = permission_available_harnesses(&state).await?;
    Ok(Json(
        state
            .product
            .complete_default_provider_onboarding(
                &ProviderId::parse(request.provider_id)?,
                &state.default_harness_configuration,
                &permission_available,
            )
            .await?,
    ))
}

pub(super) async fn provider_onboarding_status(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<ProviderOnboardingStatus>, ApiError> {
    authorize_read(&state, &headers)?;
    let permission_available = permission_available_harnesses(&state).await?;
    Ok(Json(
        state
            .product
            .provider_onboarding_status(&permission_available)
            .await?,
    ))
}

pub(super) async fn update_defaults(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<DefaultsRequest>,
) -> Result<Json<ModelSettingsDefaults>, ApiError> {
    authorize_write(&state, &headers)?;
    if request.harness_id.is_none() && request.provider_id.is_none() && request.family_id.is_none()
    {
        return Err(ApiError::invalid(
            "At least one of harnessId, providerId, or familyId is required.",
        ));
    }
    Ok(Json(
        state
            .product
            .update_model_settings_defaults(UpdateModelSettingsDefaultsCommand {
                harness_id: request.harness_id,
                provider_id: request.provider_id.map(ProviderId::parse).transpose()?,
                family_id: request
                    .family_id
                    .map(ModelFamilyId::try_from_value)
                    .transpose()?,
            })
            .await?,
    ))
}

pub(super) async fn create_family(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<FamilyRequest>,
) -> Result<(StatusCode, Json<ModelFamily>), ApiError> {
    authorize_write(&state, &headers)?;
    let family = state
        .product
        .create_model_family(CreateModelFamilyCommand {
            name: request.name,
            enabled: request.enabled,
            members: members(request.members)?,
        })
        .await?;
    Ok((StatusCode::CREATED, Json(family)))
}

pub(super) async fn update_family(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(request): Json<UpdateFamilyRequest>,
) -> Result<Json<ModelFamily>, ApiError> {
    authorize_write(&state, &headers)?;
    Ok(Json(
        state
            .product
            .update_model_family(UpdateModelFamilyCommand {
                id: ModelFamilyId::try_from_value(id)?,
                name: request.name,
                enabled: request.enabled,
                members: request.members.map(members).transpose()?,
            })
            .await?,
    ))
}

pub(super) async fn delete_family(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    authorize_write(&state, &headers)?;
    state
        .product
        .delete_model_family(ModelFamilyId::try_from_value(id)?)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn reorder_families(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<ReorderFamiliesRequest>,
) -> Result<StatusCode, ApiError> {
    authorize_write(&state, &headers)?;
    let family_ids = request
        .family_ids
        .into_iter()
        .map(ModelFamilyId::try_from_value)
        .collect::<Result<Vec<_>, _>>()?;
    state
        .product
        .reorder_model_families(ReorderModelFamiliesCommand { family_ids })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn validate_selection(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<ValidateSelectionRequest>,
) -> Result<Json<ModelSelection>, ApiError> {
    authorize_write(&state, &headers)?;
    Ok(Json(
        state
            .product
            .resolve_model_selection(ValidateModelSelectionCommand {
                harness_id: request.harness_id,
                family_id: ModelFamilyId::try_from_value(request.family_id)?,
                provider_id: ProviderId::parse(request.provider_id)?,
                model_id: request.model_id,
            })
            .await?,
    ))
}

pub(super) async fn default_selection(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<DefaultSelectionQuery>,
) -> Result<Json<Option<ModelSelection>>, ApiError> {
    authorize_read(&state, &headers)?;
    Ok(Json(
        state
            .product
            .first_available_model(&query.harness_id)
            .await?,
    ))
}

pub(super) async fn publish_provider_catalog(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(snapshot): Json<ProviderCatalogSnapshot>,
) -> Result<StatusCode, ApiError> {
    authorize_provider_publish(&state, &headers)?;
    state.product.publish_provider_catalog(snapshot).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn publish_harness_readiness(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(updates): Json<Vec<crate::product::HarnessRuntimeAvailabilityUpdate>>,
) -> Result<StatusCode, ApiError> {
    authorize_provider_publish(&state, &headers)?;
    state
        .product
        .update_harness_runtime_availability(updates)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn provider_definitions(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ProviderDefinition>>, ApiError> {
    authorize_provider_publish(&state, &headers)?;
    Ok(Json(state.product.provider_definitions().await?))
}

pub(super) async fn sync_provider_definitions(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(definitions): Json<Vec<ProviderDefinition>>,
) -> Result<StatusCode, ApiError> {
    authorize_provider_publish(&state, &headers)?;
    state.product.sync_provider_definitions(definitions).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn create_provider_with_catalog(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<StagedProviderRequest>,
) -> Result<StatusCode, ApiError> {
    authorize_provider_publish(&state, &headers)?;
    state
        .product
        .create_provider_with_catalog(request.definition, request.catalog)
        .await?;
    Ok(StatusCode::CREATED)
}

pub(super) async fn update_harness_model_rules(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(request): Json<HarnessRulesRequest>,
) -> Result<StatusCode, ApiError> {
    authorize_write(&state, &headers)?;
    state
        .product
        .update_harness_model_rules(UpdateHarnessModelRulesCommand {
            harness_id: id,
            expected_revision: request.expected_revision,
            rules: HarnessModelRules {
                allow: request.allow,
                deny: request.deny,
            },
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

fn members(requests: Vec<MemberRequest>) -> Result<Vec<ModelFamilyMember>, ApiError> {
    requests
        .into_iter()
        .enumerate()
        .map(|(position, member)| {
            Ok(ModelFamilyMember {
                provider_id: ProviderId::parse(member.provider_id)?,
                model_id: member.model_id,
                position,
            })
        })
        .collect()
}

fn enabled_by_default() -> bool {
    true
}

async fn permission_available_harnesses(state: &ApiState) -> Result<HashSet<String>, ApiError> {
    let settings = state.product.model_settings().await?;
    let Some(runtime) = state.runtime.as_ref() else {
        return Ok(HashSet::new());
    };
    Ok(settings
        .harnesses
        .iter()
        .filter(|harness| runtime.has_configuration(&harness.id))
        .filter(|harness| {
            runtime
                .permission_bindings(&harness.id)
                .ok()
                .is_some_and(|bindings| {
                    state
                        .permission_catalog
                        .availability(Some(bindings))
                        .iter()
                        .any(|profile| profile.available)
                })
        })
        .map(|harness| harness.id.clone())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn onboarding_completion_request_requires_exact_tagged_family_intent() {
        let existing: CompleteProviderOnboardingRequest =
            serde_json::from_value(serde_json::json!({
                "providerId": "anthropic-work",
                "harnessId": "claude-basic",
                "expectedProjectionRevision": "sha256:preview",
                "family": { "kind": "existing", "familyId": 12 }
            }))
            .unwrap();
        assert!(matches!(
            existing.family,
            ProviderOnboardingFamilyRequest::Existing { family_id: 12 }
        ));

        let create: CompleteProviderOnboardingRequest = serde_json::from_value(serde_json::json!({
            "providerId": "anthropic-work",
            "harnessId": "claude-basic",
            "expectedProjectionRevision": "sha256:preview",
            "family": {
                "kind": "create",
                "name": "Anthropic Work default",
                "members": [{ "providerId": "anthropic-work", "modelId": "claude-sonnet-4" }]
            }
        }))
        .unwrap();
        assert!(matches!(
            create.family,
            ProviderOnboardingFamilyRequest::Create { members, .. }
                if members.len() == 1
                    && members[0].provider_id == "anthropic-work"
                    && members[0].model_id == "claude-sonnet-4"
        ));

        assert!(
            serde_json::from_value::<CompleteProviderOnboardingRequest>(serde_json::json!({
                "providerId": "anthropic-work",
                "harnessId": "claude-basic",
                "family": { "kind": "existing", "familyId": 12 }
            }))
            .is_err()
        );
    }
}
