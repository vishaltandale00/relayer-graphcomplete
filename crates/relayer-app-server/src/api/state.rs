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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PermissionProfilesQuery {
    harness_id: Option<String>,
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
    let annotations = annotation_capability(&state, &headers);
    Ok(Json(
        CapabilitiesResponse::from(state.product.capabilities()).with_annotations(annotations),
    ))
}

pub(super) async fn permission_profiles(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<PermissionProfilesQuery>,
) -> Result<Json<PermissionProfilesResponse>, ApiError> {
    authorize_read(&state, &headers)?;
    let bindings = match &state.runtime {
        Some(runtime) => Some(
            runtime.permission_bindings(
                query
                    .harness_id
                    .as_deref()
                    .unwrap_or(&state.default_harness_configuration),
            )?,
        ),
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
    let mut product_state = state.product.load_state(thread_id).await?;
    let stale = super::threads::refresh_accepted_outputs(
        &state.product,
        state.runtime.as_ref(),
        &mut product_state.interactions,
        &product_state.action_invocations,
    )
    .await;
    let imported_thread_ids = product_state
        .threads
        .iter()
        .filter(|view| view.thread.imported)
        .map(|view| view.thread.id.value())
        .collect::<std::collections::HashSet<_>>();
    let product_interactions = std::mem::take(&mut product_state.interactions);
    let mut interactions = Vec::with_capacity(product_interactions.len());
    for interaction in product_interactions {
        let imported_thread = imported_thread_ids.contains(&interaction.thread_id.value());
        let projection_stale = stale.contains(&interaction.id.value());
        interactions.push(
            super::threads::project_interaction(
                &state,
                interaction,
                imported_thread,
                projection_stale,
            )
            .await?,
        );
    }
    let response = ProductStateResponse::from(product_state)
        .with_interactions(interactions)
        .with_annotations(annotation_capability(&state, &headers));
    Ok(Json(response))
}

fn annotation_capability(state: &ApiState, headers: &HeaderMap) -> bool {
    state
        .authenticator
        .annotation_token(headers)
        .is_some_and(|token| {
            state
                .annotation_sessions
                .lock()
                .expect("annotation session lock poisoned")
                .contains_key(token)
        })
}
