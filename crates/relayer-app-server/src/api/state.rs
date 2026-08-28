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
    current_projection_after: Option<u64>,
    current_projection_completion_id: Option<i64>,
    current_projection_interaction_id: Option<i64>,
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
    let mut seen_completion_ids = std::collections::HashSet::new();
    let mut completion_ids = Vec::new();
    if let Some(requested_interaction) = query.current_projection_interaction_id
        && let Some(requested) = product_state
            .interactions
            .iter()
            .find(|interaction| interaction.id.value() == requested_interaction)
            .and_then(|interaction| interaction.graph_node_id)
    {
        seen_completion_ids.insert(requested);
        completion_ids.push(requested);
    }
    if let Some(requested) = query.current_projection_completion_id
        && product_state
            .interactions
            .iter()
            .any(|interaction| interaction.graph_node_id == Some(requested))
        && seen_completion_ids.insert(requested)
    {
        completion_ids.push(requested);
    }
    completion_ids.extend(
        product_state
            .interactions
            .iter()
            .rev()
            .filter_map(|interaction| interaction.graph_node_id)
            .filter(|completion_id| seen_completion_ids.insert(*completion_id))
            .take(200usize.saturating_sub(completion_ids.len())),
    );
    let current_projection = match (&state.runtime, completion_ids.is_empty()) {
        (_, true) | (None, false) => None,
        (Some(runtime), false) if runtime.temporal_features().projection_ui => Some(
            runtime
                .current_projection_page(
                    &completion_ids,
                    query.current_projection_after.unwrap_or(0),
                    500,
                )
                .await?,
        ),
        (Some(_), false) => None,
    };
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
        .with_current_projection(current_projection)
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
