use super::{
    ApiState,
    auth::{authorize_provider_publish, authorize_read, authorize_write},
    error::ApiError,
};
use crate::product::{
    CreateModelFamilyCommand, ModelFamily, ModelFamilyId, ModelFamilyMember, ModelSelection,
    ModelSettings, ModelSettingsDefaults, ProviderCatalogSnapshot, ProviderId,
    ReorderModelFamiliesCommand, UpdateModelFamilyCommand, UpdateModelSettingsDefaultsCommand,
    ValidateModelSelectionCommand,
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DefaultsRequest {
    harness_id: Option<String>,
    provider_id: Option<String>,
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

pub(super) async fn get(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<ModelSettings>, ApiError> {
    authorize_read(&state, &headers)?;
    Ok(Json(state.product.model_settings().await?))
}

pub(super) async fn update_defaults(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<DefaultsRequest>,
) -> Result<Json<ModelSettingsDefaults>, ApiError> {
    authorize_write(&state, &headers)?;
    if request.harness_id.is_none() && request.provider_id.is_none() {
        return Err(ApiError::invalid(
            "At least one of harnessId or providerId is required.",
        ));
    }
    Ok(Json(
        state
            .product
            .update_model_settings_defaults(UpdateModelSettingsDefaultsCommand {
                harness_id: request.harness_id,
                provider_id: request.provider_id.map(ProviderId::parse).transpose()?,
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
