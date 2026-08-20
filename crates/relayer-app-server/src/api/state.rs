use super::{
    ApiState,
    auth::authorize_read,
    error::ApiError,
    types::{CapabilitiesResponse, ProductStateResponse},
};
use crate::permissions::PermissionProfileAvailability;
use crate::product::{ProductCapabilities, ThreadId};
use axum::{Json, extract::Query, extract::State, http::HeaderMap};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StateQuery {
    thread_id: Option<i64>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PermissionProfilesResponse {
    default_profile: String,
    profiles: Vec<PermissionProfileAvailability>,
}

pub(super) async fn health() -> Json<Value> {
    Json(json!({
        "ok": true,
        "service": "relayer-app-server",
        "capabilities": CapabilitiesResponse::from(ProductCapabilities::default()),
    }))
}

pub(super) async fn capabilities(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<CapabilitiesResponse>, ApiError> {
    authorize_read(&state, &headers)?;
    Ok(Json(state.product.capabilities().into()))
}

pub(super) async fn permission_profiles(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<PermissionProfilesResponse>, ApiError> {
    authorize_read(&state, &headers)?;
    let bindings = match &state.runtime {
        Some(runtime) => Some(runtime.permission_bindings(&state.default_harness_configuration)?),
        None => None,
    };
    let profiles = state.permission_catalog.availability(bindings);
    Ok(Json(PermissionProfilesResponse {
        default_profile: state.permission_catalog.default_profile().to_owned(),
        profiles,
    }))
}

pub(super) async fn product_state(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<StateQuery>,
) -> Result<Json<ProductStateResponse>, ApiError> {
    authorize_read(&state, &headers)?;
    let thread_id = query.thread_id.map(ThreadId::try_from).transpose()?;
    Ok(Json(state.product.load_state(thread_id).await?.into()))
}
