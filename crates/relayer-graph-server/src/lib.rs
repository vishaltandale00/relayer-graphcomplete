use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use relayer_graph_core::query::{QueryError, preflight_public_request_json};
use relayer_graph_core::{
    ActionDraft, ActionId, ActionKind, AuthoredDetailUpdate, CompletionOutput, CurrentTransition,
    CurrentTransitionReceipt, EdgeDraft, GraphAction, GraphDatabase, GraphError, GraphNode,
    GraphWriter, ImportedConversationStage, ImportedTurn, InteractionContextAction,
    InteractionContextDraft, InteractionContextTarget, InteractionInput, InteractionInputNode,
    InteractionInvocation, LayerDraft, LayerId, LayerLayout, NodeDraft, NodeId, NodePlacement,
    PERSONAL_PRESENTATION_PROFILE_THREAD_ID, ProjectId, RecordState, TemporalFeatureConfig,
    ThreadId,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex},
};
use uuid::Uuid;

#[cfg(feature = "ladybug")]
pub mod search_index;

#[derive(Clone)]
pub struct ServerState {
    graph: GraphDatabase,
    sessions: Arc<Mutex<HashMap<String, RuntimeAuthority>>>,
    control_token: Arc<str>,
    temporal_features: TemporalFeatureConfig,
    visual_assets_bridge: Arc<Mutex<Option<VisualAssetsBridge>>>,
    visual_assets_admission: Arc<tokio::sync::Mutex<VisualAssetsHandoffPhase>>,
    visual_assets_gate: Arc<Mutex<HashMap<NodeId, Arc<tokio::sync::Mutex<u64>>>>>,
    http_client: reqwest::Client,
    #[cfg(feature = "ladybug")]
    search_index: Option<Arc<search_index::LadybugSearchIndex>>,
    #[cfg(all(feature = "ladybug", feature = "crash-test-support"))]
    search_cancellations: Arc<Mutex<VecDeque<search_index::QueryCancellation>>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum VisualAssetsHandoffPhase {
    Reversible,
    CutoverPending,
}

#[derive(Debug, Clone)]
struct VisualAssetsBridge {
    url: String,
    token: String,
    generation: u64,
}

fn completion_asset_gate(
    state: &ServerState,
    node_id: NodeId,
) -> Result<Arc<tokio::sync::Mutex<u64>>, ApiError> {
    Ok(state
        .visual_assets_gate
        .lock()
        .map_err(|_| ApiError::internal("visual-assets gate lock poisoned"))?
        .entry(node_id)
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(1)))
        .clone())
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum GraphSearchCapability {
    #[default]
    Disabled,
    QueryV1,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GraphCapabilityProfile {
    search: GraphSearchCapability,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RuntimeAuthority {
    node_id: NodeId,
    epoch: u64,
    profile: GraphCapabilityProfile,
}

impl ServerState {
    pub fn new(graph: GraphDatabase, control_token: impl Into<String>) -> Self {
        Self {
            graph,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            control_token: Arc::from(control_token.into()),
            temporal_features: TemporalFeatureConfig::default(),
            visual_assets_bridge: Arc::new(Mutex::new(None)),
            visual_assets_admission: Arc::new(tokio::sync::Mutex::new(
                VisualAssetsHandoffPhase::Reversible,
            )),
            visual_assets_gate: Arc::new(Mutex::new(HashMap::new())),
            http_client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .expect("visual-assets HTTP client configuration is valid"),
            #[cfg(feature = "ladybug")]
            search_index: None,
            #[cfg(all(feature = "ladybug", feature = "crash-test-support"))]
            search_cancellations: Arc::default(),
        }
    }

    pub fn with_temporal_features(mut self, temporal_features: TemporalFeatureConfig) -> Self {
        self.temporal_features = temporal_features;
        self
    }

    #[cfg(feature = "ladybug")]
    pub fn with_search_index(
        mut self,
        search_index: Arc<search_index::LadybugSearchIndex>,
    ) -> Self {
        self.graph = self.graph.with_search_index(search_index.clone());
        self.search_index = Some(search_index);
        self
    }

    #[cfg(all(feature = "ladybug", feature = "crash-test-support"))]
    #[doc(hidden)]
    pub fn with_contract_test_search_cancellation(
        self,
        cancellation: search_index::QueryCancellation,
    ) -> Self {
        self.search_cancellations
            .lock()
            .expect("search cancellation queue poisoned")
            .push_back(cancellation);
        self
    }

    #[cfg(feature = "ladybug")]
    fn search_cancellation(&self) -> search_index::QueryCancellation {
        #[cfg(feature = "crash-test-support")]
        if let Some(cancellation) = self
            .search_cancellations
            .lock()
            .expect("search cancellation queue poisoned")
            .pop_front()
        {
            return cancellation;
        }
        search_index::QueryCancellation::default()
    }
}

pub fn router(state: ServerState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route(
            "/api/control/temporal-features",
            get(control_temporal_features),
        )
        .route(
            "/api/control/visual-assets/bridge",
            axum::routing::put(register_visual_assets_bridge),
        )
        .route("/api/control/interactions", post(create_interaction))
        .route("/api/control/interactions/{id}", get(interaction_metadata))
        .route("/api/control/interactions/{id}/input", get(control_input))
        .route(
            "/api/control/interactions/{id}/input-children",
            get(control_input_children),
        )
        .route(
            "/api/control/interactions/{id}/context-actions",
            get(control_context_actions),
        )
        .route(
            "/api/control/context-occurrences/canonical",
            post(canonical_context_occurrence),
        )
        .route(
            "/api/control/input-action-occurrences/canonical",
            post(canonical_input_action_occurrence),
        )
        .route("/api/control/interactions/{id}/output", get(control_output))
        .route(
            "/api/control/interactions/{id}/current",
            get(control_current),
        )
        .route(
            "/api/control/interactions/{id}/current/transitions",
            post(control_transition_current),
        )
        .route(
            "/api/control/interactions/{id}/current/receipts",
            post(control_current_receipt),
        )
        .route(
            "/api/control/current-projections",
            get(control_current_projections).post(control_current_projection_page),
        )
        .route(
            "/api/control/personal-presentation",
            get(personal_presentation_contract),
        )
        .route(
            "/api/control/personal-presentation/versions",
            post(publish_personal_presentation_version),
        )
        .route(
            "/api/control/interactions/{id}/personal-presentation",
            get(control_personal_presentation).post(attach_personal_presentation),
        )
        .route(
            "/api/control/interactions/{id}/layers/{layer_id}",
            get(control_layer),
        )
        .route(
            "/api/control/interactions/{id}/layers/{layer_id}/owner",
            get(control_layer_owner),
        )
        .route(
            "/api/control/interactions/{id}/actions/{action_id}",
            get(control_action),
        )
        .route(
            "/api/control/conversation-imports",
            axum::routing::delete(remove_imported_conversation),
        )
        .route(
            "/api/control/conversation-import-stages",
            post(begin_imported_conversation),
        )
        .route(
            "/api/control/conversation-import-stages/{import_id}/visual-asset-contents",
            post(stage_imported_visual_asset_content)
                .layer(DefaultBodyLimit::max(17 * 1024 * 1024)),
        )
        .route(
            "/api/control/conversation-import-stages/{import_id}/turns",
            post(stage_imported_turn).layer(DefaultBodyLimit::max(17 * 1024 * 1024)),
        )
        .route(
            "/api/control/conversation-import-stages/{import_id}/finalize",
            post(finalize_imported_conversation),
        )
        .route(
            "/api/control/interactions/{id}/accepted-closure",
            get(accepted_closure),
        )
        .route(
            "/api/control/nodes/{node_id}/detail-assets/{asset_id}",
            get(control_detail_asset),
        )
        .route(
            "/api/control/visual-assets/imports/validate",
            post(validate_visual_asset_import).layer(DefaultBodyLimit::max(17 * 1024 * 1024)),
        )
        .route(
            "/api/control/capabilities",
            post(remint_capability).delete(revoke_capability),
        )
        .route(
            "/api/control/recursive-completions",
            post(prepare_recursive_completion),
        )
        .route("/api/graph/nodes", post(submit_node))
        .route(
            "/api/graph/detail-assets/resolve",
            post(resolve_detail_assets),
        )
        .route("/api/graph/visual-assets/scope", get(visual_assets_scope))
        .route(
            "/api/graph/visual-assets/operations",
            post(visual_assets_operation).layer(DefaultBodyLimit::max(12 * 1024 * 1024)),
        )
        .route("/api/graph/nodes/{id}", get(get_node))
        .route("/api/graph/nodes/{id}/neighbors", get(neighbors))
        .route("/api/graph/input", get(interaction_input))
        .route(
            "/api/graph/personal-presentation",
            get(graph_personal_presentation),
        )
        .route("/api/graph/edges", post(create_edge))
        .route("/api/graph/layers", post(submit_layer))
        .route("/api/graph/layers/{id}", get(get_layer))
        .route("/api/graph/layers/{id}/discard", post(discard_layer))
        .route("/api/graph/actions", post(add_action))
        .route("/api/graph/actions/{id}", get(get_action))
        .route("/api/graph/submit", post(submit_completion))
        .route("/api/graph/current", get(graph_current))
        .route(
            "/api/graph/completions/prepare",
            post(prepare_graph_completion),
        )
        .route("/api/graph/current/transitions", post(transition_current))
        .route("/api/graph/search", post(search))
        .route("/api/graph/nodes/{id}/output", get(completion_output))
        .with_state(state)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VisualAssetsBridgeRegistration {
    url: String,
    token: String,
    generation: u64,
}

async fn register_visual_assets_bridge(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<VisualAssetsBridgeRegistration>,
) -> Result<Json<Value>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    let mut handoff_phase = state.visual_assets_admission.lock().await;
    let url = reqwest::Url::parse(&input.url)
        .map_err(|_| ApiError::invalid("visual-assets bridge URL is invalid"))?;
    if input.generation == 0
        || input.token.len() < 32
        || url.scheme() != "http"
        || !url
            .host_str()
            .is_some_and(|host| host == "127.0.0.1" || host == "::1")
    {
        return Err(ApiError::invalid(
            "visual-assets bridge registration is invalid",
        ));
    }
    let existing = {
        let bridge = state
            .visual_assets_bridge
            .lock()
            .expect("visual-assets bridge mutex poisoned");
        if bridge
            .as_ref()
            .is_some_and(|current| input.generation <= current.generation)
        {
            return Err(ApiError::conflict(
                "visual_assets_bridge_generation_stale",
                "Visual-assets bridge generation must advance.",
            ));
        }
        bridge.clone()
    };
    if existing.is_some() {
        let active_nodes: HashSet<NodeId> = state
            .sessions
            .lock()
            .map_err(|_| ApiError::internal("session lock poisoned"))?
            .values()
            .map(|authority| authority.node_id)
            .collect();
        // Keep every completion gate until the swap or compensation finishes.
        // A concurrent terminal operation must not replace a rollback barrier.
        let mut pauses = Vec::with_capacity(active_nodes.len());
        for node_id in &active_nodes {
            pauses.push(VisualAssetsHandoffPause {
                node_id: *node_id,
                generation: completion_asset_gate(&state, *node_id)?.lock_owned().await,
                barrier: format!("bridge-{}-{}", input.generation, node_id.value()),
                acknowledged: false,
            });
        }
        for index in 0..pauses.len() {
            let pause = &mut pauses[index];
            match visual_assets_lifecycle(&state, pause.node_id, pause.operation()).await {
                Ok(generation) => {
                    *pause.generation = generation;
                    pause.acknowledged = true;
                }
                Err(error) => {
                    if *handoff_phase == VisualAssetsHandoffPhase::CutoverPending
                        || !restore_visual_assets_handoff(&state, &mut pauses[..=index]).await
                    {
                        return Err(visual_assets_handoff_recovery_required());
                    }
                    return Err(error);
                }
            }
        }
        // Retain the irreversible phase across failed registration attempts.
        // A later pause failure must not resume authority cut over by an earlier try.
        *handoff_phase = VisualAssetsHandoffPhase::CutoverPending;
        for node_id in &active_nodes {
            if state
                .graph
                .cutover_completion_authority(*node_id)
                .await
                .is_err()
            {
                // Some epochs may already be committed. Keep every barrier in
                // place and let registration retry finish the irreversible cutover.
                return Err(visual_assets_handoff_recovery_required());
            }
        }
        state
            .sessions
            .lock()
            .map_err(|_| ApiError::internal("session lock poisoned"))?
            .retain(|_, authority| !active_nodes.contains(&authority.node_id));
        state
            .visual_assets_gate
            .lock()
            .map_err(|_| ApiError::internal("visual-assets gate lock poisoned"))?
            .retain(|node_id, _| !active_nodes.contains(node_id));
    }
    {
        let mut bridge = state
            .visual_assets_bridge
            .lock()
            .expect("visual-assets bridge mutex poisoned");
        if bridge
            .as_ref()
            .is_some_and(|current| input.generation <= current.generation)
        {
            return Err(ApiError::conflict(
                "visual_assets_bridge_generation_stale",
                "Visual-assets bridge generation must advance.",
            ));
        }
        *bridge = Some(VisualAssetsBridge {
            url: input.url.trim_end_matches('/').to_owned(),
            token: input.token,
            generation: input.generation,
        });
    }
    *handoff_phase = VisualAssetsHandoffPhase::Reversible;
    Ok(Json(json!({"generation": input.generation})))
}

fn visual_assets_handoff_recovery_required() -> ApiError {
    ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        json!({"error": {
            "code": "visual_assets_bridge_recovery_required",
            "message": "Bridge replacement did not complete. The old bridge remains registered. Finish any pending terminal or revoke operation, then retry this registration to recover the handoff."
        }}),
    )
}

struct VisualAssetsHandoffPause {
    node_id: NodeId,
    generation: tokio::sync::OwnedMutexGuard<u64>,
    barrier: String,
    acknowledged: bool,
}

impl VisualAssetsHandoffPause {
    fn operation(&self) -> Value {
        // This pause is reversible; it must never take ownership of an unrelated
        // terminal/revoke barrier that compensation could accidentally resume.
        json!({"kind":"pause","expectedGeneration":*self.generation,"barrierId":self.barrier})
    }
}

async fn restore_visual_assets_handoff(
    state: &ServerState,
    pauses: &mut [VisualAssetsHandoffPause],
) -> bool {
    let mut restored = true;
    for pause in pauses.iter_mut().rev() {
        if !pause.acknowledged {
            // The failed request may have paused the host before losing its
            // acknowledgment. Replaying the exact barrier learns that generation.
            match visual_assets_lifecycle(state, pause.node_id, pause.operation()).await {
                Ok(generation) => {
                    *pause.generation = generation;
                    pause.acknowledged = true;
                }
                Err(_) => {
                    restored = false;
                    continue;
                }
            }
        }
        match visual_assets_lifecycle(
            state,
            pause.node_id,
            json!({"kind":"resume","assetGeneration":*pause.generation,"barrierId":pause.barrier}),
        )
        .await
        {
            Ok(generation) => *pause.generation = generation,
            Err(_) => restored = false,
        }
    }
    restored
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResolveDetailAssetsRequest {
    logical_ids: Vec<String>,
}

async fn visual_assets_scope(
    State(state): State<ServerState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let authority = session(&state, &headers)?;
    let writer = state
        .graph
        .writer_for_completion_authority(authority.node_id, authority.epoch)
        .await?;
    writer.require_active_authority().await?;
    let (project_id, thread_id) = writer.authority_scope();
    Ok(Json(json!({"scope": project_id.map_or_else(
        || json!({"kind":"thread","threadId":thread_id.value()}),
        |project_id| json!({"kind":"project","projectId":project_id.value()}),
    )})))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VisualAssetsOperationRequest {
    operation: Value,
}

async fn visual_assets_operation(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<VisualAssetsOperationRequest>,
) -> Result<Json<Value>, ApiError> {
    let authority = session(&state, &headers)?;
    let asset_gate = completion_asset_gate(&state, authority.node_id)?;
    let asset_generation_guard = asset_gate.lock().await;
    let asset_generation = *asset_generation_guard;
    let writer = state
        .graph
        .writer_for_completion_authority(authority.node_id, authority.epoch)
        .await?;
    writer.require_active_authority().await?;
    let operation = input
        .operation
        .as_object()
        .ok_or_else(|| ApiError::invalid("visual-assets operation must be an object"))?;
    let kind = operation
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::invalid("visual-assets operation kind is required"))?;
    let read_only = matches!(
        kind,
        "list-registries"
            | "list-tags"
            | "list-assets"
            | "find"
            | "inspect"
            | "download"
            | "resolve"
    );
    if !read_only
        && !matches!(
            kind,
            "add" | "create-tag" | "move-tag" | "associate" | "organize" | "archive"
        )
    {
        return Err(ApiError::invalid("visual-assets operation kind is invalid"));
    }
    let scope = operation
        .get("scope")
        .and_then(Value::as_object)
        .ok_or_else(|| ApiError::invalid("visual-assets operation scope is required"))?;
    let scope_kind = scope
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let (project_id, thread_id) = writer.authority_scope();
    let scope_allowed = match scope_kind {
        "library" => read_only && scope.len() == 1,
        "project" => {
            project_id.is_some_and(|id| {
                scope.get("projectId").and_then(Value::as_i64) == Some(id.value())
            }) && scope.len() == 2
        }
        "thread" => {
            scope.get("threadId").and_then(Value::as_i64) == Some(thread_id.value())
                && scope.len() == 2
        }
        _ => false,
    };
    if !scope_allowed {
        return Err(ApiError::capability_not_granted());
    }
    let bridge = state
        .visual_assets_bridge
        .lock()
        .expect("visual-assets bridge mutex poisoned")
        .clone()
        .ok_or_else(ApiError::visual_assets_unavailable)?;
    let authority_scope = project_id.map_or_else(
        || json!({"kind":"thread","threadId":thread_id.value()}),
        |project_id| json!({"kind":"project","projectId":project_id.value(),"threadId":thread_id.value()}),
    );
    let response = state.http_client.post(format!("{}/visual-assets/operations", bridge.url)).bearer_auth(&bridge.token).json(&json!({
        "version":1, "generation":bridge.generation, "assetGeneration":asset_generation,
        "authority":{"kind":"completion","interactionNodeId":authority.node_id.value(),"scope":authority_scope},
        "operation": input.operation,
    })).send().await.map_err(|_| ApiError::visual_assets_unavailable())?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|_| ApiError::visual_assets_unavailable())?;
    writer.require_active_authority().await?;
    if state
        .visual_assets_bridge
        .lock()
        .expect("visual-assets bridge mutex poisoned")
        .as_ref()
        .map(|current| current.generation)
        != Some(bridge.generation)
    {
        return Err(ApiError::conflict(
            "visual_assets_bridge_restarted",
            "Visual-assets authority changed during the operation.",
        ));
    }
    if !status.is_success() {
        return Err(ApiError(status, body));
    }
    Ok(Json(
        body.get("result")
            .cloned()
            .ok_or_else(ApiError::visual_assets_unavailable)?,
    ))
}

async fn resolve_detail_assets(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<ResolveDetailAssetsRequest>,
) -> Result<Json<Value>, ApiError> {
    let authority = session(&state, &headers)?;
    let asset_gate = completion_asset_gate(&state, authority.node_id)?;
    let asset_generation_guard = asset_gate.lock().await;
    let asset_generation = *asset_generation_guard;
    if input.logical_ids.len() > 32
        || input
            .logical_ids
            .iter()
            .any(|id| id.is_empty() || id.trim() != id || id.contains('\0') || id.len() > 128)
    {
        return Err(ApiError::invalid("visual asset identities are invalid"));
    }
    let writer = state
        .graph
        .writer_for_completion_authority(authority.node_id, authority.epoch)
        .await?;
    writer.require_active_authority().await?;
    let bridge = state
        .visual_assets_bridge
        .lock()
        .expect("visual-assets bridge mutex poisoned")
        .clone()
        .ok_or_else(ApiError::visual_assets_unavailable)?;
    let (project_id, thread_id) = writer.authority_scope();
    let scope = project_id.map_or_else(
        || json!({"kind":"thread","threadId":thread_id.value()}),
        |project_id| {
            json!({
                "kind":"project",
                "projectId":project_id.value(),
                "threadId":thread_id.value(),
            })
        },
    );
    let requested_scope = project_id.map_or_else(
        || json!({"kind":"thread","threadId":thread_id.value()}),
        |project_id| json!({"kind":"project","projectId":project_id.value()}),
    );
    let response = state
        .http_client
        .post(format!("{}/visual-assets/operations", bridge.url))
        .bearer_auth(&bridge.token)
        .json(&json!({
            "version": 1,
            "generation": bridge.generation,
            "assetGeneration": asset_generation,
            "authority": {
                "kind": "completion",
                "interactionNodeId": authority.node_id.value(),
                "scope": scope,
            },
            "operation": {"kind":"resolve","scope":requested_scope,"logicalIds":input.logical_ids},
        }))
        .send()
        .await
        .map_err(|_| ApiError::visual_assets_unavailable())?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|_| ApiError::visual_assets_unavailable())?;
    writer.require_active_authority().await?;
    let current_generation = state
        .visual_assets_bridge
        .lock()
        .expect("visual-assets bridge mutex poisoned")
        .as_ref()
        .map(|current| current.generation);
    if current_generation != Some(bridge.generation) {
        return Err(ApiError::conflict(
            "visual_assets_bridge_restarted",
            "Visual-assets authority changed while resolving assets.",
        ));
    }
    if !status.is_success() {
        return Err(ApiError(status, body));
    }
    let result = body
        .get("result")
        .cloned()
        .ok_or_else(ApiError::visual_assets_unavailable)?;
    Ok(Json(result))
}

#[cfg(feature = "ladybug")]
async fn search(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    // The complete public contract boundary precedes all transport authority
    // and store observations.
    let preflight = preflight_public_request_json(&body).map_err(ApiError::query_contract)?;
    let capability = capability(&state, &headers)?;
    if capability.profile.search != GraphSearchCapability::QueryV1 {
        return Err(ApiError::capability_not_granted());
    }
    let interaction_node_id = capability.node_id;
    let permit = state
        .graph
        .query_read_permit(interaction_node_id, capability.epoch)
        .await?;
    let prepared = permit
        .bind_prepared_public_query(preflight)
        .map_err(ApiError::query_contract)?;
    let index = state
        .search_index
        .as_ref()
        .cloned()
        .ok_or_else(ApiError::search_unavailable)?;
    let cancellation = state.search_cancellation();
    let mut cancel_on_drop = CancelSearchOnDrop(Some(cancellation.clone()));
    // Keep the query future alive after an HTTP request future is dropped. The
    // drop guard signals cancellation, and the detached query future owns the
    // select branch that interrupts its exact Ladybug job before it exits.
    let query = tokio::spawn(async move {
        index
            .execute_prepared(&permit, prepared, cancellation)
            .await
    });
    let result = query
        .await
        .map_err(|_| ApiError::internal("graph search task stopped unexpectedly"))?
        .map_err(|failure| match failure {
            search_index::GraphQueryFailure::Contract(error) => ApiError::query_contract(error),
            search_index::GraphQueryFailure::TargetNotReady { .. } => {
                ApiError::search_unavailable()
            }
        })?;
    cancel_on_drop.0 = None;
    Ok(Json(result.outcome.to_json()))
}

#[cfg(not(feature = "ladybug"))]
async fn search(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let preflight = preflight_public_request_json(&body).map_err(ApiError::query_contract)?;
    let capability = capability(&state, &headers)?;
    if capability.profile.search != GraphSearchCapability::QueryV1 {
        return Err(ApiError::capability_not_granted());
    }
    let permit = state
        .graph
        .query_read_permit(capability.node_id, capability.epoch)
        .await?;
    permit
        .bind_prepared_public_query(preflight)
        .map_err(ApiError::query_contract)?;
    Err(ApiError::search_unavailable())
}

#[cfg(feature = "ladybug")]
struct CancelSearchOnDrop(Option<search_index::QueryCancellation>);

#[cfg(feature = "ladybug")]
impl Drop for CancelSearchOnDrop {
    fn drop(&mut self) {
        if let Some(cancellation) = &self.0 {
            cancellation.cancel();
        }
    }
}

async fn begin_imported_conversation(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<ImportedConversationStage>,
) -> Result<Json<Value>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    state.graph.begin_imported_conversation(&input).await?;
    Ok(Json(json!({"staged": true})))
}

async fn stage_imported_visual_asset_content(
    State(state): State<ServerState>,
    Path(import_id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<relayer_graph_core::ImportedVisualAssetContent>,
) -> Result<Json<Value>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    state
        .graph
        .stage_imported_visual_asset_content(&import_id, &input)
        .await?;
    Ok(Json(json!({"staged": true})))
}

async fn stage_imported_turn(
    State(state): State<ServerState>,
    Path(import_id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<ImportedTurn>,
) -> Result<Json<Value>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    state.graph.stage_imported_turn(&import_id, &input).await?;
    Ok(Json(json!({"staged": true})))
}

async fn finalize_imported_conversation(
    State(state): State<ServerState>,
    Path(import_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    Ok(Json(json!(
        state
            .graph
            .finalize_imported_conversation(&import_id)
            .await?
    )))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveImportRequest {
    import_id: String,
}

async fn remove_imported_conversation(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<RemoveImportRequest>,
) -> Result<Json<Value>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    state
        .graph
        .remove_imported_conversation(&input.import_id)
        .await?;
    Ok(Json(json!({"removed": true})))
}

async fn accepted_closure(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path(id): Path<NodeId>,
) -> Result<Json<relayer_graph_core::AcceptedGraphClosure>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    let closure = state.graph.accepted_graph_closure(id).await?.ok_or_else(|| {
        ApiError(
            StatusCode::NOT_FOUND,
            json!({"error":{"code":"completion_not_found","message":"This node has no accepted completion output yet."}}),
        )
    })?;
    Ok(Json(closure))
}

async fn control_detail_asset(
    State(state): State<ServerState>,
    Path((node_id, asset_id)): Path<(NodeId, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    use base64::Engine as _;
    require_bearer(&headers, &state.control_token)?;
    let asset = state
        .graph
        .accepted_detail_asset(node_id, &asset_id)
        .await?;
    Ok(Json(json!({
        "assetId": asset.asset_id,
        "digestSha256": asset.digest_sha256,
        "mediaType": asset.media_type,
        "byteLength": asset.byte_length,
        "provenance": {
            "source": asset.provenance_source,
            "fileName": asset.provenance_file_name,
        },
        "contentBase64": base64::engine::general_purpose::STANDARD.encode(asset.content),
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ValidateVisualAssetImportRequest {
    project_id: Option<ProjectId>,
    thread_id: ThreadId,
    content: Value,
}

async fn validate_visual_asset_import(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<ValidateVisualAssetImportRequest>,
) -> Result<Json<Value>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    let bridge = state
        .visual_assets_bridge
        .lock()
        .expect("visual-assets bridge mutex poisoned")
        .clone()
        .ok_or_else(ApiError::visual_assets_unavailable)?;
    let scope = input.project_id.map_or_else(
        || json!({"kind":"thread","threadId":input.thread_id.value()}),
        |project_id| json!({"kind":"project","projectId":project_id.value(),"threadId":input.thread_id.value()}),
    );
    let response = state
        .http_client
        .post(format!("{}/visual-assets/operations", bridge.url))
        .bearer_auth(&bridge.token)
        .json(&json!({
            "version":1,"generation":bridge.generation,"authority":{"kind":"control","scope":scope},
            "operation":{"kind":"validate-import-content","content":input.content},
        }))
        .send()
        .await
        .map_err(|_| ApiError::visual_assets_unavailable())?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|_| ApiError::visual_assets_unavailable())?;
    // Do not admit a validation receipt while replacement is still fencing the
    // old bridge. Acquire admission only after the RPC, preserving the existing
    // admission-before-completion-gate ordering used by replacement and minting.
    let _admission = state.visual_assets_admission.lock().await;
    if state
        .visual_assets_bridge
        .lock()
        .expect("visual-assets bridge mutex poisoned")
        .as_ref()
        .map(|current| current.generation)
        != Some(bridge.generation)
    {
        return Err(ApiError::conflict(
            "visual_assets_bridge_restarted",
            "Visual-assets authority changed while validating imported content.",
        ));
    }
    if !status.is_success() {
        return Err(ApiError(status, body));
    }
    Ok(Json(
        body.get("result")
            .cloned()
            .ok_or_else(ApiError::visual_assets_unavailable)?,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AttachPersonalPresentationRequest {
    version_interaction_node_id: NodeId,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublishPersonalPresentationVersionRequest {
    version_interaction_node_id: NodeId,
}

async fn personal_presentation_contract(
    State(state): State<ServerState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    Ok(Json(json!({"schemaVersion": 1})))
}

async fn publish_personal_presentation_version(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<PublishPersonalPresentationVersionRequest>,
) -> Result<Json<relayer_graph_core::PublishedPersonalPresentationVersion>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    Ok(Json(
        state
            .graph
            .publish_personal_presentation_version(input.version_interaction_node_id)
            .await?,
    ))
}

async fn attach_personal_presentation(
    State(state): State<ServerState>,
    Path(id): Path<NodeId>,
    headers: HeaderMap,
    Json(input): Json<AttachPersonalPresentationRequest>,
) -> Result<Json<relayer_graph_core::PersonalPresentationAttachment>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    Ok(Json(
        state
            .graph
            .attach_personal_presentation(id, input.version_interaction_node_id)
            .await?,
    ))
}

async fn control_personal_presentation(
    State(state): State<ServerState>,
    Path(id): Path<NodeId>,
    headers: HeaderMap,
) -> Result<Json<relayer_graph_core::ResolvedPersonalPresentation>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    state
        .graph
        .personal_presentation_attachment(id)
        .await?
        .map(Json)
        .ok_or_else(|| {
            ApiError(
                StatusCode::NOT_FOUND,
                json!({"error":{"code":"personal_presentation_not_attached","message":"This interaction has no personal presentation attachment."}}),
            )
        })
}

async fn health() -> Json<Value> {
    Json(json!({"ok": true, "service": "relayer-graph"}))
}

async fn control_temporal_features(
    State(state): State<ServerState>,
    headers: HeaderMap,
) -> Result<Json<TemporalFeatureConfig>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    Ok(Json(state.temporal_features))
}

fn require_temporal_feature(enabled: bool, feature: &str) -> Result<(), ApiError> {
    if enabled {
        Ok(())
    } else {
        Err(ApiError(
            StatusCode::NOT_FOUND,
            json!({"error":{"code":"feature_disabled","message":format!("Temporal feature {feature} is disabled.")}}),
        ))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateInteractionRequest {
    project_id: Option<ProjectId>,
    thread_id: ThreadId,
    text: String,
    #[serde(default)]
    invocation: Option<InteractionInvocation>,
    #[serde(default)]
    contexts: Vec<InteractionContextDraft>,
    #[serde(default)]
    submitted_inputs: Vec<relayer_graph_core::SubmittedInputDraft>,
    #[serde(default)]
    input_identity: Option<String>,
    #[serde(default)]
    input_digest: Option<String>,
    #[serde(default = "default_mint_capability")]
    mint_capability: bool,
    #[serde(default)]
    personal_presentation_profile: bool,
    #[serde(default)]
    graph_capability_profile: GraphCapabilityProfile,
}

fn default_mint_capability() -> bool {
    true
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInteractionResponse {
    pub node: GraphNode,
    pub graph_token: String,
    #[serde(default)]
    pub context_actions: Vec<InteractionContextAction>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub input_children: Vec<relayer_graph_core::InteractionInputChild>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_identity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_digest: Option<String>,
}

async fn create_interaction(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<CreateInteractionRequest>,
) -> Result<Json<CreateInteractionResponse>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    if input.invocation.is_some()
        && (!input.contexts.is_empty() || !input.submitted_inputs.is_empty())
    {
        return Err(ApiError::invalid(
            "invocation and submitted interaction input cannot be prepared together",
        ));
    }
    let (interaction, context_actions, input_children) = if input.personal_presentation_profile {
        if input.project_id.is_some()
            || input.thread_id.value() != PERSONAL_PRESENTATION_PROFILE_THREAD_ID
            || input.invocation.is_some()
            || !input.contexts.is_empty()
            || !input.submitted_inputs.is_empty()
        {
            return Err(ApiError::invalid(
                "personal-presentation profile creation requires its reserved standalone thread and no invocation or contexts",
            ));
        }
        let (Some(identity), Some(digest)) = (
            input.input_identity.as_deref(),
            input.input_digest.as_deref(),
        ) else {
            return Err(ApiError::invalid(
                "personal-presentation profile creation requires inputIdentity and inputDigest",
            ));
        };
        (
            state
                .graph
                .create_personal_presentation_interaction(&input.text, identity, digest)
                .await?,
            Vec::new(),
            Vec::new(),
        )
    } else if let (Some(identity), Some(digest)) = (
        input.input_identity.as_deref(),
        input.input_digest.as_deref(),
    ) {
        if input.invocation.is_some() {
            return Err(ApiError::invalid(
                "identified context input cannot also be an invocation",
            ));
        }
        if input.submitted_inputs.is_empty() {
            let (node, actions) = state
                .graph
                .create_identified_interaction_with_context(
                    input.project_id,
                    input.thread_id,
                    &input.text,
                    identity,
                    digest,
                    &input.contexts,
                )
                .await?;
            (node, actions, Vec::new())
        } else {
            let (node, children) = state
                .graph
                .create_identified_interaction_with_inputs(
                    input.project_id,
                    input.thread_id,
                    &input.text,
                    relayer_graph_core::InteractionInputPreparation {
                        attempt_key: identity,
                        authority_digest: digest,
                        contexts: &input.contexts,
                        submitted_inputs: &input.submitted_inputs,
                    },
                )
                .await?;
            let actions = state.graph.interaction_context_actions(node.id).await?;
            (node, actions, children)
        }
    } else if input.input_identity.is_some() || input.input_digest.is_some() {
        return Err(ApiError::invalid(
            "inputIdentity and inputDigest must be supplied together",
        ));
    } else if !input.submitted_inputs.is_empty() {
        return Err(ApiError::invalid(
            "submittedInputs require inputIdentity and inputDigest",
        ));
    } else if input.contexts.is_empty() {
        (
            state
                .graph
                .create_interaction_with_invocation(
                    input.project_id,
                    input.thread_id,
                    &input.text,
                    input.invocation,
                )
                .await?,
            Vec::new(),
            Vec::new(),
        )
    } else {
        let (node, actions) = state
            .graph
            .create_interaction_with_context(
                input.project_id,
                input.thread_id,
                &input.text,
                &input.contexts,
            )
            .await?;
        (node, actions, Vec::new())
    };
    let graph_token = if input.mint_capability {
        Some(
            mint_capability_with_profile(
                &state,
                interaction.id,
                None,
                input.graph_capability_profile,
            )
            .await?,
        )
    } else {
        None
    };
    Ok(Json(CreateInteractionResponse {
        node: interaction,
        graph_token: graph_token.unwrap_or_default(),
        context_actions,
        input_children,
        input_identity: input.input_identity,
        input_digest: input.input_digest,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrepareRecursiveCompletionRequest {
    action_id: ActionId,
    parent_graph_token: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrepareRecursiveCompletionResponse {
    node: GraphNode,
}

async fn prepare_recursive_completion(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<PrepareRecursiveCompletionRequest>,
) -> Result<Json<PrepareRecursiveCompletionResponse>, ApiError> {
    require_temporal_feature(
        state.temporal_features.provider_recursion,
        "provider-recursion",
    )?;
    require_bearer(&headers, &state.control_token)?;
    let authority = session_for_token(&state, &input.parent_graph_token)?;
    let node = state
        .graph
        .writer_for_completion_authority(authority.node_id, authority.epoch)
        .await?
        .prepare_recursive_completion(input.action_id)
        .await?;
    Ok(Json(PrepareRecursiveCompletionResponse { node }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrepareGraphCompletionRequest {
    action_id: ActionId,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PrepareGraphCompletionResponse {
    interaction_node: NodeId,
}

async fn prepare_graph_completion(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<PrepareGraphCompletionRequest>,
) -> Result<Json<PrepareGraphCompletionResponse>, ApiError> {
    require_temporal_feature(
        state.temporal_features.provider_recursion,
        "provider-recursion",
    )?;
    let authority = session(&state, &headers)?;
    let node = state
        .graph
        .writer_for_completion_authority(authority.node_id, authority.epoch)
        .await?
        .prepare_recursive_completion(input.action_id)
        .await?;
    Ok(Json(PrepareGraphCompletionResponse {
        interaction_node: node.id,
    }))
}

async fn control_input(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path(id): Path<NodeId>,
) -> Result<Json<InteractionInput>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    Ok(Json(
        state
            .graph
            .writer_for_subgraph(id)
            .await?
            .interaction_input()
            .await?,
    ))
}

async fn control_input_children(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path(id): Path<NodeId>,
) -> Result<Json<Value>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    let children = state
        .graph
        .writer_for_subgraph(id)
        .await?
        .interaction_input_children()
        .await?;
    Ok(Json(json!({
        "children": children.into_iter().map(|child| json!({
            "id": child.id,
            "parentInteractionNodeId": child.parent_interaction_node_id,
            "presentingInteractionNodeId": child.occurrence.presenting_interaction_node_id,
            "presentingLayerId": child.occurrence.presenting_layer_id,
            "actionId": child.occurrence.action_id,
            "sourceNodeId": child.source_node_id,
            "action": child.action,
            "value": child.value,
        })).collect::<Vec<_>>()
    })))
}

async fn control_context_actions(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path(id): Path<NodeId>,
) -> Result<Json<Value>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    Ok(Json(json!({
        "actions": state.graph.interaction_context_actions(id).await?,
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CanonicalContextOccurrenceRequest {
    node_id: NodeId,
    source_interaction_node_id: NodeId,
    source_layer_id: LayerId,
}

async fn canonical_context_occurrence(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<CanonicalContextOccurrenceRequest>,
) -> Result<Json<InteractionInputNode>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    let target = InteractionContextTarget {
        node_id: input.node_id,
        source_interaction_node_id: input.source_interaction_node_id,
        source_layer_id: input.source_layer_id,
    };
    Ok(Json(
        state
            .graph
            .canonical_interaction_context_occurrence(&target)
            .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CanonicalInputActionOccurrenceRequest {
    destination_project_id: Option<ProjectId>,
    destination_thread_id: ThreadId,
    occurrence: relayer_graph_core::PresentingInputOccurrence,
}

async fn canonical_input_action_occurrence(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<CanonicalInputActionOccurrenceRequest>,
) -> Result<Json<GraphAction>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    Ok(Json(
        state
            .graph
            .canonical_input_action_occurrence(
                input.destination_project_id,
                input.destination_thread_id,
                &input.occurrence,
            )
            .await?,
    ))
}

async fn interaction_metadata(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path(id): Path<NodeId>,
) -> Result<Json<Value>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    let invocation = state.graph.interaction_invocation(id).await?;
    let input = state.graph.interaction_input_identity(id).await?;
    Ok(Json(json!({
        "nodeId": id,
        "invocation": invocation,
        "inputIdentity": input.as_ref().map(|value| value.0.as_str()),
        "inputDigest": input.as_ref().map(|value| value.1.as_str()),
    })))
}

async fn control_output(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path(id): Path<NodeId>,
) -> Result<Json<CompletionOutput>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    let output = state.graph.writer_for_subgraph(id).await?.completion_output().await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, json!({"error":{"code":"completion_not_found","message":"This node has no accepted completion output yet."}})))?;
    Ok(Json(output))
}

async fn control_current(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path(id): Path<NodeId>,
) -> Result<Json<relayer_graph_core::CompletionState>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    require_temporal_feature(state.temporal_features.schema_read, "schema-read")?;
    let current = state.graph.current_completion(id).await?;
    require_temporal_feature(
        current.temporal_features.schema_read,
        "completion-schema-read",
    )?;
    Ok(Json(current))
}

async fn control_transition_current(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path(id): Path<NodeId>,
    Json(input): Json<CurrentTransitionRequest>,
) -> Result<Json<CurrentTransitionReceipt>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    require_temporal_feature(
        state.temporal_features.root_current_write,
        "root-current-write",
    )?;
    let current = state.graph.current_completion(id).await?;
    require_temporal_feature(
        current.temporal_features.root_current_write,
        "completion-root-current-write",
    )?;
    if !matches!(
        input.transition,
        CurrentTransition::Stop { .. } | CurrentTransition::Fail { .. }
    ) {
        return Err(ApiError::invalid(
            "trusted control may only stop or fail a completion",
        ));
    }
    let gate = completion_asset_gate(&state, id)?;
    let mut generation = gate.lock().await;
    let barrier = format!("control-transition-{}-{}", id.value(), input.operation_key);
    *generation = visual_assets_lifecycle(
        &state,
        id,
        json!({"kind":"pause","expectedGeneration":*generation,"barrierId":barrier}),
    )
    .await?;
    let outcome = state
        .graph
        .writer_for_subgraph(id)
        .await?
        .transition_current(
            input.expected_revision,
            &input.operation_key,
            input.transition,
        )
        .await;
    match outcome {
        Ok(receipt) => {
            *generation = visual_assets_lifecycle(
                &state,
                id,
                json!({"kind":"finalize-revoke","assetGeneration":*generation,"barrierId":barrier}),
            )
            .await?;
            Ok(Json(receipt))
        }
        Err(error) => {
            *generation = visual_assets_lifecycle(
                &state,
                id,
                json!({"kind":"resume","assetGeneration":*generation,"barrierId":barrier}),
            )
            .await?;
            Err(error.into())
        }
    }
}

async fn control_current_receipt(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path(id): Path<NodeId>,
    Json(input): Json<CurrentReceiptRequest>,
) -> Result<Json<CurrentTransitionReceipt>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    require_temporal_feature(state.temporal_features.schema_read, "schema-read")?;
    let current = state.graph.current_completion(id).await?;
    require_temporal_feature(
        current.temporal_features.schema_read,
        "completion-schema-read",
    )?;
    let receipt = state
        .graph
        .current_transition_receipt(id, &input.operation_key)
        .await?
        .ok_or_else(|| ApiError(
            StatusCode::NOT_FOUND,
            json!({"error":{"code":"receipt_not_found","message":"No committed current transition has this operation key."}}),
        ))?;
    if receipt.request_digest != input.request_digest {
        return Err(ApiError(
            StatusCode::CONFLICT,
            json!({"error":{"code":"idempotency_conflict","message":"This operation key is committed with a different transition request digest."}}),
        ));
    }
    Ok(Json(receipt))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CurrentReceiptRequest {
    operation_key: String,
    request_digest: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionQuery {
    #[serde(default)]
    after: u64,
    #[serde(default = "default_projection_limit")]
    limit: u32,
}

fn default_projection_limit() -> u32 {
    100
}

async fn control_current_projections(
    State(state): State<ServerState>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<ProjectionQuery>,
) -> Result<Json<Value>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    require_temporal_feature(state.temporal_features.projection_ui, "projection-ui")?;
    let events = state
        .graph
        .current_projection_events(query.after, query.limit)
        .await?;
    let cursor = events.last().map_or(query.after, |event| event.sequence);
    Ok(Json(json!({"events": events, "cursor": cursor})))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectionPageRequest {
    completion_ids: Vec<NodeId>,
    #[serde(default)]
    after: u64,
    #[serde(default = "default_projection_limit")]
    limit: u32,
}

async fn control_current_projection_page(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<ProjectionPageRequest>,
) -> Result<Json<relayer_graph_core::CurrentProjectionPage>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    require_temporal_feature(state.temporal_features.projection_ui, "projection-ui")?;
    Ok(Json(
        state
            .graph
            .current_projection_page(&input.completion_ids, input.after, input.limit)
            .await?,
    ))
}

async fn control_layer(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path((id, layer_id)): Path<(NodeId, LayerId)>,
) -> Result<Json<Value>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    let layer = state
        .graph
        .writer_for_subgraph(id)
        .await?
        .get_layer(layer_id)
        .await?;
    Ok(Json(
        serde_json::to_value(layer).map_err(|error| ApiError::internal(&error.to_string()))?,
    ))
}

async fn control_layer_owner(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path((id, layer_id)): Path<(NodeId, LayerId)>,
) -> Result<Json<Value>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    let owner_interaction_node_id = state
        .graph
        .writer_for_subgraph(id)
        .await?
        .get_layer_owner(layer_id)
        .await?;
    Ok(Json(json!({
        "layerId": layer_id,
        "ownerInteractionNodeId": owner_interaction_node_id,
    })))
}

async fn control_action(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path((id, action_id)): Path<(NodeId, ActionId)>,
) -> Result<Json<Value>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    let writer = state.graph.writer_for_subgraph(id).await?;
    let action = accepted_action(&writer, action_id).await?;
    Ok(Json(json!({"action": action})))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemintCapabilityRequest {
    node_id: NodeId,
    #[serde(default)]
    graph_token: Option<String>,
    #[serde(default)]
    graph_capability_profile: GraphCapabilityProfile,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemintCapabilityResponse {
    graph_token: String,
}

async fn remint_capability(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<RemintCapabilityRequest>,
) -> Result<Json<RemintCapabilityResponse>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    state.graph.writer_for_subgraph(input.node_id).await?;
    Ok(Json(RemintCapabilityResponse {
        graph_token: mint_capability_with_profile(
            &state,
            input.node_id,
            input.graph_token,
            input.graph_capability_profile,
        )
        .await?,
    }))
}

#[cfg(test)]
async fn mint_capability(
    state: &ServerState,
    node_id: NodeId,
    requested_token: Option<String>,
) -> Result<String, ApiError> {
    mint_capability_with_profile(
        state,
        node_id,
        requested_token,
        GraphCapabilityProfile::default(),
    )
    .await
}

async fn mint_capability_with_profile(
    state: &ServerState,
    node_id: NodeId,
    requested_token: Option<String>,
    profile: GraphCapabilityProfile,
) -> Result<String, ApiError> {
    let handoff_phase = state.visual_assets_admission.lock().await;
    if *handoff_phase == VisualAssetsHandoffPhase::CutoverPending {
        return Err(visual_assets_handoff_recovery_required());
    }
    let graph_token = requested_token.unwrap_or_else(|| Uuid::new_v4().to_string());
    if graph_token.is_empty() {
        return Err(ApiError::invalid("graphToken must be non-empty"));
    }
    {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| ApiError::internal("session lock poisoned"))?;
        if let Some(active) = sessions.get(&graph_token) {
            if active.node_id != node_id || active.profile != profile {
                return Err(ApiError::conflict(
                    "capability_token_conflict",
                    "graphToken is already bound to a different interaction or capability profile",
                ));
            }
            return Ok(graph_token);
        }
    }
    let gate = completion_asset_gate(state, node_id)?;
    let mut asset_generation = gate.lock().await;
    let epoch = state.graph.activate_completion_authority(node_id).await?;
    // The epoch already invalidated prior tokens even if activation acknowledgment
    // is lost. Never let a requested old token replay a now-stale session entry.
    state
        .sessions
        .lock()
        .map_err(|_| ApiError::internal("session lock poisoned"))?
        .retain(|_, active| active.node_id != node_id);
    *asset_generation = visual_assets_lifecycle(
        state,
        node_id,
        json!({"kind":"activate","completionEpoch":epoch}),
    )
    .await?;
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| ApiError::internal("session lock poisoned"))?;
    sessions.insert(
        graph_token.clone(),
        RuntimeAuthority {
            node_id,
            epoch,
            profile,
        },
    );
    Ok(graph_token)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RevokeCapabilityRequest {
    #[serde(default)]
    graph_token: Option<String>,
    #[serde(default)]
    node_id: Option<NodeId>,
}

async fn revoke_capability(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<RevokeCapabilityRequest>,
) -> Result<Json<Value>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    let target_node = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| ApiError::internal("session lock poisoned"))?;
        match (&input.graph_token, input.node_id) {
            (Some(graph_token), None) => {
                sessions.get(graph_token).map(|authority| authority.node_id)
            }
            (None, Some(node_id)) => sessions
                .values()
                .any(|active| active.node_id == node_id)
                .then_some(node_id),
            _ => {
                return Err(ApiError::invalid(
                    "provide exactly one of graphToken or nodeId",
                ));
            }
        }
    };
    let mut revoked = 0;
    if let Some(node_id) = target_node {
        let gate = completion_asset_gate(&state, node_id)?;
        let mut generation = gate.lock().await;
        let barrier = format!("explicit-revoke-{}", node_id.value());
        *generation = visual_assets_lifecycle(
            &state,
            node_id,
            json!({"kind":"pause","expectedGeneration":*generation,"barrierId":barrier,"revocationTakeover":true}),
        )
        .await?;
        state.graph.cutover_completion_authority(node_id).await?;
        *generation = visual_assets_lifecycle(
            &state,
            node_id,
            json!({"kind":"finalize-revoke","assetGeneration":*generation,"barrierId":barrier}),
        )
        .await?;
        revoked = {
            let mut sessions = state
                .sessions
                .lock()
                .map_err(|_| ApiError::internal("session lock poisoned"))?;
            let before = sessions.len();
            sessions.retain(|_, active| active.node_id != node_id);
            before - sessions.len()
        };
    }
    Ok(Json(
        json!({"revoked": revoked > 0, "revokedCount": revoked}),
    ))
}

async fn visual_assets_lifecycle(
    state: &ServerState,
    node_id: NodeId,
    operation: Value,
) -> Result<u64, ApiError> {
    let Some(bridge) = state
        .visual_assets_bridge
        .lock()
        .expect("visual-assets bridge mutex poisoned")
        .clone()
    else {
        return Ok(operation
            .get("expectedGeneration")
            .or_else(|| operation.get("assetGeneration"))
            .and_then(Value::as_u64)
            .unwrap_or(1));
    };
    let response = state
        .http_client
        .post(format!("{}/visual-assets/operations", bridge.url))
        .bearer_auth(&bridge.token)
        .json(&json!({
            "version":1,"generation":bridge.generation,
            "authority":{"kind":"lifecycle","interactionNodeId":node_id.value()},
            "operation":operation,
        }))
        .send()
        .await
        .map_err(|_| ApiError::visual_assets_unavailable())?;
    if !response.status().is_success() {
        return Err(ApiError::visual_assets_unavailable());
    }
    let body: Value = response
        .json()
        .await
        .map_err(|_| ApiError::visual_assets_unavailable())?;
    body.pointer("/result/assetGeneration")
        .and_then(Value::as_u64)
        .ok_or_else(ApiError::visual_assets_unavailable)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubmitNodeRequest {
    #[serde(flatten)]
    draft: NodeDraft,
    /// Three-state: absent retains the draft's checkpointed package, `null`
    /// clears it, and a package replaces it.
    #[serde(default, deserialize_with = "deserialize_nullable_authored_detail")]
    authored_detail: Option<Option<Value>>,
}

fn deserialize_nullable_authored_detail<'de, D>(
    deserializer: D,
) -> Result<Option<Option<Value>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<Value>::deserialize(deserializer).map(Some)
}

impl SubmitNodeRequest {
    fn authored_detail_update(&self) -> AuthoredDetailUpdate<'_> {
        match &self.authored_detail {
            None => AuthoredDetailUpdate::Retain,
            Some(None) => AuthoredDetailUpdate::Clear,
            Some(Some(package)) => AuthoredDetailUpdate::Replace(package),
        }
    }
}

async fn submit_node(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<SubmitNodeRequest>,
) -> Result<Json<Value>, ApiError> {
    let authority = session(&state, &headers)?;
    let asset_gate = completion_asset_gate(&state, authority.node_id)?;
    let asset_generation_guard = asset_gate.lock().await;
    let asset_generation = *asset_generation_guard;
    let writer = state
        .graph
        .writer_for_completion_authority(authority.node_id, authority.epoch)
        .await?;
    let mut prepared_assets = None;
    if let Some(Some(package)) = &input.authored_detail
        && package
            .get("assets")
            .and_then(Value::as_array)
            .is_some_and(|assets| !assets.is_empty())
    {
        prepared_assets = Some(
            prepare_detail_assets(&state, &writer, authority, asset_generation, package).await?,
        );
    }
    let node = writer
        .submit_node_with_prepared_detail_assets(
            &input.draft,
            input.authored_detail_update(),
            prepared_assets.as_deref(),
        )
        .await?;
    Ok(Json(json!({"node": node})))
}

async fn prepare_detail_assets(
    state: &ServerState,
    writer: &GraphWriter,
    authority: RuntimeAuthority,
    asset_generation: u64,
    package: &Value,
) -> Result<Vec<relayer_graph_core::PreparedDetailAsset>, ApiError> {
    writer.require_active_authority().await?;
    let bridge = state
        .visual_assets_bridge
        .lock()
        .expect("visual-assets bridge mutex poisoned")
        .clone()
        .ok_or_else(ApiError::visual_assets_unavailable)?;
    let (project_id, thread_id) = writer.authority_scope();
    let scope = project_id.map_or_else(
        || json!({"kind":"thread","threadId":thread_id.value()}),
        |project_id| json!({"kind":"project","projectId":project_id.value(),"threadId":thread_id.value()}),
    );
    let requested_scope = project_id.map_or_else(
        || json!({"kind":"thread","threadId":thread_id.value()}),
        |project_id| json!({"kind":"project","projectId":project_id.value()}),
    );
    let response = state.http_client
        .post(format!("{}/visual-assets/operations", bridge.url))
        .bearer_auth(&bridge.token)
        .json(&json!({
            "version":1,
            "generation":bridge.generation,
            "assetGeneration":asset_generation,
            "authority":{"kind":"completion","interactionNodeId":authority.node_id.value(),"scope":scope},
            "operation":{"kind":"prepare-detail","scope":requested_scope,"package":package},
        }))
        .send().await.map_err(|_| ApiError::visual_assets_unavailable())?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|_| ApiError::visual_assets_unavailable())?;
    writer.require_active_authority().await?;
    if state
        .visual_assets_bridge
        .lock()
        .expect("visual-assets bridge mutex poisoned")
        .as_ref()
        .map(|current| current.generation)
        != Some(bridge.generation)
    {
        return Err(ApiError::conflict(
            "visual_assets_bridge_restarted",
            "Visual-assets authority changed while preparing assets.",
        ));
    }
    if !status.is_success() {
        return Err(ApiError(status, body));
    }
    let result = body
        .get("result")
        .ok_or_else(ApiError::visual_assets_unavailable)?;
    let detail_assets = result
        .pointer("/detail/assets")
        .and_then(Value::as_array)
        .ok_or_else(ApiError::visual_assets_unavailable)?;
    let contents = result
        .get("contents")
        .and_then(Value::as_array)
        .ok_or_else(ApiError::visual_assets_unavailable)?;
    let mut prepared = Vec::with_capacity(detail_assets.len());
    for asset in detail_assets {
        let digest = asset
            .get("digestSha256")
            .and_then(Value::as_str)
            .ok_or_else(ApiError::visual_assets_unavailable)?;
        let content = contents
            .iter()
            .find(|content| content.get("digestSha256").and_then(Value::as_str) == Some(digest))
            .ok_or_else(ApiError::visual_assets_unavailable)?;
        prepared.push(
            serde_json::from_value(json!({
                "assetId": asset.get("assetId"),
                "digestSha256": digest,
                "mediaType": asset.get("mediaType"),
                "byteLength": asset.get("byteLength"),
                "provenanceSource": asset.pointer("/provenance/source"),
                "provenanceFileName": asset.pointer("/provenance/fileName"),
                "content": content.get("contentBase64"),
            }))
            .map_err(|_| ApiError::visual_assets_unavailable())?,
        );
    }
    Ok(prepared)
}
async fn get_node(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path(id): Path<NodeId>,
) -> Result<Json<Value>, ApiError> {
    let authority = session(&state, &headers)?;
    let node = state
        .graph
        .writer_for_completion_authority(authority.node_id, authority.epoch)
        .await?
        .get_node(id)
        .await?;
    Ok(Json(json!({"node":node})))
}
async fn neighbors(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path(id): Path<NodeId>,
) -> Result<Json<Value>, ApiError> {
    let authority = session(&state, &headers)?;
    let nodes = state
        .graph
        .writer_for_completion_authority(authority.node_id, authority.epoch)
        .await?
        .neighbors(id)
        .await?;
    Ok(Json(json!({"nodes":nodes})))
}

async fn interaction_input(
    State(state): State<ServerState>,
    headers: HeaderMap,
) -> Result<Json<InteractionInput>, ApiError> {
    let authority = session(&state, &headers)?;
    Ok(Json(
        state
            .graph
            .writer_for_completion_authority(authority.node_id, authority.epoch)
            .await?
            .interaction_input()
            .await?,
    ))
}
async fn graph_personal_presentation(
    State(state): State<ServerState>,
    headers: HeaderMap,
) -> Result<Json<relayer_graph_core::ResolvedPersonalPresentation>, ApiError> {
    let authority = session(&state, &headers)?;
    state
        .graph
        .personal_presentation_attachment(authority.node_id)
        .await?
        .map(Json)
        .ok_or_else(|| {
            ApiError(
                StatusCode::NOT_FOUND,
                json!({"error":{"code":"personal_presentation_not_attached","message":"This interaction has no personal presentation attachment."}}),
            )
        })
}
async fn create_edge(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<EdgeDraft>,
) -> Result<Json<Value>, ApiError> {
    let authority = session(&state, &headers)?;
    let edge = state
        .graph
        .writer_for_completion_authority(authority.node_id, authority.epoch)
        .await?
        .create_edge(&input)
        .await?;
    Ok(Json(json!({"edge":edge})))
}
async fn submit_layer(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<LayerDraftRequest>,
) -> Result<Json<Value>, ApiError> {
    let authority = session(&state, &headers)?;
    let input = LayerDraft::from(input);
    let layer = state
        .graph
        .writer_for_completion_authority(authority.node_id, authority.epoch)
        .await?
        .submit_layer(&input)
        .await?;
    Ok(Json(json!({"layer":layer})))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayerDraftRequest {
    client_key: String,
    nodes: Vec<NodeId>,
    edges: Vec<relayer_graph_core::EdgeId>,
    #[serde(default)]
    layout: Option<LayerLayoutRequest>,
    #[serde(default)]
    size_justification: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayerLayoutRequest {
    #[serde(default)]
    version: Value,
    #[serde(default)]
    placements: Vec<NodePlacementRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodePlacementRequest {
    node_id: NodeId,
    #[serde(default)]
    x: Value,
    #[serde(default)]
    y: Value,
}

impl From<LayerDraftRequest> for LayerDraft {
    fn from(input: LayerDraftRequest) -> Self {
        Self {
            client_key: input.client_key,
            nodes: input.nodes,
            edges: input.edges,
            layout: input.layout.map(|layout| LayerLayout {
                version: repairable_layout_version(&layout.version),
                placements: layout
                    .placements
                    .into_iter()
                    .map(|placement| NodePlacement {
                        node_id: placement.node_id,
                        x: repairable_coordinate(&placement.x),
                        y: repairable_coordinate(&placement.y),
                    })
                    .collect(),
            }),
            size_justification: input.size_justification,
        }
    }
}

fn repairable_coordinate(value: &Value) -> f64 {
    value.as_f64().unwrap_or(f64::NAN)
}

fn repairable_layout_version(value: &Value) -> u32 {
    value
        .as_u64()
        .and_then(|version| u32::try_from(version).ok())
        .unwrap_or(0)
}
async fn get_layer(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path(id): Path<LayerId>,
) -> Result<Json<Value>, ApiError> {
    let authority = session(&state, &headers)?;
    let layer = state
        .graph
        .writer_for_completion_authority(authority.node_id, authority.epoch)
        .await?
        .get_layer(id)
        .await?;
    Ok(Json(json!(layer)))
}
async fn discard_layer(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path(id): Path<LayerId>,
) -> Result<Json<Value>, ApiError> {
    let authority = session(&state, &headers)?;
    let layer = state
        .graph
        .writer_for_completion_authority(authority.node_id, authority.epoch)
        .await?
        .discard_layer(id)
        .await?;
    Ok(Json(json!({"layer":layer})))
}
async fn add_action(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<ActionDraft>,
) -> Result<Json<Value>, ApiError> {
    let authority = session(&state, &headers)?;
    let action = state
        .graph
        .writer_for_completion_authority(authority.node_id, authority.epoch)
        .await?
        .add_action(&input)
        .await?;
    Ok(Json(json!({"action":action})))
}
async fn get_action(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path(id): Path<ActionId>,
) -> Result<Json<Value>, ApiError> {
    let authority = session(&state, &headers)?;
    let writer = state
        .graph
        .writer_for_completion_authority(authority.node_id, authority.epoch)
        .await?;
    let action = accepted_action(&writer, id).await?;
    Ok(Json(json!({"action": action})))
}

async fn accepted_action(writer: &GraphWriter, id: ActionId) -> Result<GraphAction, ApiError> {
    if let Some(output) = writer.completion_output().await? {
        let mut layers = VecDeque::from([output.root_layer]);
        let mut visited = HashSet::new();
        while let Some(layer) = layers.pop_front() {
            if !visited.insert(layer.layer.id) {
                continue;
            }
            for action in layer.actions {
                if action.id == id && action.state == RecordState::Accepted {
                    return Ok(action);
                }
                if action.kind == ActionKind::Navigate
                    && action.state == RecordState::Accepted
                    && let Some(target_layer_id) = action.target_layer_id
                    && !visited.contains(&target_layer_id)
                {
                    layers.push_back(writer.get_layer(target_layer_id).await?);
                }
            }
        }
    }
    // A completion that has not returned yet has no output, but it can already have
    // published an accepted invoke occurrence through a current advance. That published
    // occurrence is exactly what recursive child preparation derives authority from.
    writer.accepted_authored_action(id).await?.ok_or_else(|| {
        ApiError(
            StatusCode::NOT_FOUND,
            json!({"error":{"code":"action_not_found","message":"This completion has no accepted action with that identity."}}),
        )
    })
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompleteRequest {
    node_id: NodeId,
}
async fn submit_completion(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<CompleteRequest>,
) -> Result<Json<CompletionOutput>, ApiError> {
    let authority = session(&state, &headers)?;
    let gate = completion_asset_gate(&state, authority.node_id)?;
    let mut generation = gate.lock().await;
    let barrier = format!("complete-{}", authority.node_id.value());
    *generation = visual_assets_lifecycle(
        &state,
        authority.node_id,
        json!({"kind":"pause","expectedGeneration":*generation,"barrierId":barrier}),
    )
    .await?;
    let outcome = state
        .graph
        .writer_for_completion_authority(authority.node_id, authority.epoch)
        .await?
        .complete(input.node_id)
        .await;
    let output = match outcome {
        Ok(output) => {
            *generation = visual_assets_lifecycle(
                &state,
                authority.node_id,
                json!({"kind":"finalize-revoke","assetGeneration":*generation,"barrierId":barrier}),
            )
            .await?;
            output
        }
        Err(error) => {
            *generation = visual_assets_lifecycle(
                &state,
                authority.node_id,
                json!({"kind":"resume","assetGeneration":*generation,"barrierId":barrier}),
            )
            .await?;
            return Err(error.into());
        }
    };
    Ok(Json(output))
}

async fn graph_current(
    State(state): State<ServerState>,
    headers: HeaderMap,
) -> Result<Json<relayer_graph_core::CompletionState>, ApiError> {
    let authority = session(&state, &headers)?;
    require_temporal_feature(
        state.temporal_features.root_current_write,
        "root-current-write",
    )?;
    let current = state
        .graph
        .writer_for_completion_authority(authority.node_id, authority.epoch)
        .await?
        .current_completion()
        .await?;
    require_temporal_feature(
        current.temporal_features.root_current_write,
        "completion-root-current-write",
    )?;
    Ok(Json(current))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CurrentTransitionRequest {
    expected_revision: u64,
    operation_key: String,
    transition: CurrentTransition,
}

async fn transition_current(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<CurrentTransitionRequest>,
) -> Result<Json<CurrentTransitionReceipt>, ApiError> {
    let authority = session(&state, &headers)?;
    require_temporal_feature(
        state.temporal_features.root_current_write,
        "root-current-write",
    )?;
    let current = state.graph.current_completion(authority.node_id).await?;
    require_temporal_feature(
        current.temporal_features.root_current_write,
        "completion-root-current-write",
    )?;
    if !matches!(&input.transition, CurrentTransition::Advance { .. }) {
        let gate = completion_asset_gate(&state, authority.node_id)?;
        let barrier = format!(
            "transition-{}-{}",
            authority.node_id.value(),
            input.operation_key
        );
        let mut generation = gate.lock().await;
        *generation = visual_assets_lifecycle(
            &state,
            authority.node_id,
            json!({"kind":"pause","expectedGeneration":*generation,"barrierId":barrier}),
        )
        .await?;
        let outcome = state
            .graph
            .writer_for_completion_authority(authority.node_id, authority.epoch)
            .await?
            .transition_current(
                input.expected_revision,
                &input.operation_key,
                input.transition,
            )
            .await;
        match outcome {
            Ok(receipt) => {
                *generation = visual_assets_lifecycle(&state, authority.node_id, json!({"kind":"finalize-revoke","assetGeneration":*generation,"barrierId":barrier})).await?;
                return Ok(Json(receipt));
            }
            Err(error) => {
                *generation = visual_assets_lifecycle(
                    &state,
                    authority.node_id,
                    json!({"kind":"resume","assetGeneration":*generation,"barrierId":barrier}),
                )
                .await?;
                return Err(error.into());
            }
        }
    }
    Ok(Json(
        state
            .graph
            .writer_for_completion_authority(authority.node_id, authority.epoch)
            .await?
            .transition_current(
                input.expected_revision,
                &input.operation_key,
                input.transition,
            )
            .await?,
    ))
}
async fn completion_output(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path(id): Path<NodeId>,
) -> Result<Json<CompletionOutput>, ApiError> {
    let authority = session(&state, &headers)?;
    if id != authority.node_id {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            json!({"error":{"code":"forbidden","message":"This capability can only read its completion output."}}),
        ));
    }
    let output = state
        .graph
        .writer_for_completion_authority(authority.node_id, authority.epoch)
        .await?
        .completion_output()
        .await?
        .ok_or_else(|| ApiError(
            StatusCode::NOT_FOUND,
            json!({"error":{"code":"completion_not_found","message":"This node has no accepted completion output yet."}}),
        ))?;
    Ok(Json(output))
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("authorization")?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}
fn require_bearer(headers: &HeaderMap, expected: &str) -> Result<(), ApiError> {
    if bearer(headers) == Some(expected) {
        Ok(())
    } else {
        Err(ApiError(
            StatusCode::UNAUTHORIZED,
            json!({"error":{"code":"unauthorized","message":"A valid bearer token is required."}}),
        ))
    }
}
fn session(state: &ServerState, headers: &HeaderMap) -> Result<RuntimeAuthority, ApiError> {
    let token = bearer(headers).ok_or_else(|| {
        ApiError(
            StatusCode::UNAUTHORIZED,
            json!({"error":{"code":"unauthorized","message":"A graph capability token is required."}}),
        )
    })?;
    session_for_token(state, token)
}

fn capability(state: &ServerState, headers: &HeaderMap) -> Result<RuntimeAuthority, ApiError> {
    session(state, headers)
}

fn session_for_token(state: &ServerState, token: &str) -> Result<RuntimeAuthority, ApiError> {
    state
        .sessions
        .lock()
        .map_err(|_| ApiError::internal("session lock poisoned"))?
        .get(token)
        .copied()
        .ok_or_else(|| {
            ApiError(
                StatusCode::UNAUTHORIZED,
                json!({"error":{"code":"invalid_capability","message":"This graph capability is unknown or expired."}}),
            )
        })
}

pub struct ApiError(StatusCode, Value);
impl ApiError {
    fn visual_assets_unavailable() -> Self {
        Self(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error":{"code":"visual_assets_unavailable","message":"Visual assets are temporarily unavailable."}}),
        )
    }
    fn invalid(message: &str) -> Self {
        Self(
            StatusCode::UNPROCESSABLE_ENTITY,
            json!({"error":{"code":"invalid_request","message":message}}),
        )
    }

    fn conflict(code: &str, message: &str) -> Self {
        Self(
            StatusCode::CONFLICT,
            json!({"error":{"code":code,"message":message}}),
        )
    }

    fn internal(message: &str) -> Self {
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error":{"code":"internal","message":message}}),
        )
    }

    fn search_unavailable() -> Self {
        Self(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error":{"code":"search_unavailable","message":"Graph search is temporarily unavailable."}}),
        )
    }

    fn capability_not_granted() -> Self {
        Self(
            StatusCode::FORBIDDEN,
            json!({"error":{"code":"capability_not_granted","message":"This graph capability does not grant search access."}}),
        )
    }

    fn query_contract(error: QueryError) -> Self {
        Self(
            StatusCode::UNPROCESSABLE_ENTITY,
            json!({"error":{
                "code": error.code,
                "phase": error.phase,
                "path": error.path,
                "message": error.message,
            }}),
        )
    }
}
impl From<GraphError> for ApiError {
    fn from(error: GraphError) -> Self {
        match error {
            GraphError::Validation {
                code,
                path,
                message,
            } => Self(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"error":{"code":code,"path":path,"message":message,"issues":[{"code":code,"path":path,"message":message}]}}),
            ),
            GraphError::ValidationIssues { message, issues } => {
                let first = issues.first().expect("validation issues are non-empty");
                Self(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"error":{"code":first.code,"path":first.path,"message":message,"issues":issues}}),
                )
            }
            GraphError::NotFound(message) => Self(
                StatusCode::NOT_FOUND,
                json!({"error":{"code":"not_found","message":message}}),
            ),
            GraphError::Forbidden(message) => Self(
                StatusCode::FORBIDDEN,
                json!({"error":{"code":"forbidden","message":message}}),
            ),
            other => Self::internal(&other.to_string()),
        }
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(self.1)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use tower::ServiceExt;

    #[tokio::test]
    async fn reminted_capability_reactivates_assets_without_reviving_old_generation() {
        let host_state = Arc::new(Mutex::new((0_u64, 1_u64, true)));
        let observed = host_state.clone();
        let lose_activation_ack = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let fail_activation = lose_activation_ack.clone();
        let fake = Router::new().route(
            "/visual-assets/operations",
            post(move |Json(body): Json<Value>| {
                let observed = observed.clone();
                let fail_activation = fail_activation.clone();
                async move {
                    let mut host = observed.lock().unwrap();
                    let operation = &body["operation"];
                    match operation["kind"].as_str().unwrap() {
                        "activate" => {
                            let epoch = operation["completionEpoch"].as_u64().unwrap();
                            assert!(epoch > host.0);
                            if host.0 != 0 {
                                host.1 += 1;
                            }
                            host.0 = epoch;
                            host.2 = true;
                            if fail_activation.swap(false, std::sync::atomic::Ordering::SeqCst) {
                                return (
                                    StatusCode::SERVICE_UNAVAILABLE,
                                    Json(json!({"error":"lost activation acknowledgment"})),
                                );
                            }
                        }
                        "pause" => {
                            host.1 += 1;
                            host.2 = false;
                        }
                        "finalize-revoke" => {
                            host.2 = false;
                        }
                        "list-assets" => {
                            let status = if host.2 && body["assetGeneration"] == host.1 {
                                StatusCode::OK
                            } else {
                                StatusCode::FORBIDDEN
                            };
                            return (status, Json(json!({"result":{"items":[]}})));
                        }
                        _ => panic!("unexpected bridge operation"),
                    }
                    (
                        StatusCode::OK,
                        Json(json!({"result":{"assetGeneration":host.1}})),
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, fake).await.unwrap();
        });
        let graph = GraphDatabase::in_memory().await.unwrap();
        let node = graph
            .create_interaction(None, ThreadId::new(1).unwrap(), "Retry")
            .await
            .unwrap();
        let state = ServerState::new(graph, "control");
        let app = router(state.clone());
        let request = |method: &str, path: &str, token: &str, body: Value| {
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap()
        };
        assert_eq!(
            app.clone()
                .oneshot(request(
                    "PUT",
                    "/api/control/visual-assets/bridge",
                    "control",
                    json!({"url":format!("http://{address}"),"token":"x".repeat(32),"generation":1})
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        let mut old_token: Option<String> = None;
        for _ in 0..2 {
            let response = app
                .clone()
                .oneshot(request(
                    "POST",
                    "/api/control/capabilities",
                    "control",
                    json!({"nodeId":node.id}),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body: Value =
                serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                    .unwrap();
            let token = body["graphToken"].as_str().unwrap().to_owned();
            let list =
                json!({"operation":{"kind":"list-assets","scope":{"kind":"thread","threadId":1}}});
            assert_eq!(
                app.clone()
                    .oneshot(request(
                        "POST",
                        "/api/graph/visual-assets/operations",
                        &token,
                        list.clone()
                    ))
                    .await
                    .unwrap()
                    .status(),
                StatusCode::OK,
                "retry must receive active host authority at the generation used by graph requests"
            );
            if let Some(old) = old_token {
                assert!(
                    !app.clone()
                        .oneshot(request(
                            "POST",
                            "/api/graph/visual-assets/operations",
                            &old,
                            list
                        ))
                        .await
                        .unwrap()
                        .status()
                        .is_success()
                );
            }
            assert_eq!(
                app.clone()
                    .oneshot(request(
                        "DELETE",
                        "/api/control/capabilities",
                        "control",
                        json!({"graphToken":token})
                    ))
                    .await
                    .unwrap()
                    .status(),
                StatusCode::OK
            );
            old_token = Some(token);
        }
        let active_token = mint_capability(&state, node.id, None).await.ok().unwrap();
        lose_activation_ack.store(true, std::sync::atomic::Ordering::SeqCst);
        let failed = app
            .clone()
            .oneshot(request(
                "POST",
                "/api/control/capabilities",
                "control",
                json!({"nodeId":node.id,"graphToken":"unacknowledged-token"}),
            ))
            .await
            .unwrap();
        assert_eq!(failed.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(
            state.sessions.lock().unwrap().is_empty(),
            "failed activation must neither expose the pending token nor retain stale replay entries"
        );
        let acknowledged_later_epoch = host_state.lock().unwrap().0;
        let recovered = app
            .clone()
            .oneshot(request(
                "POST",
                "/api/control/capabilities",
                "control",
                json!({"nodeId":node.id,"graphToken":active_token}),
            ))
            .await
            .unwrap();
        assert_eq!(recovered.status(), StatusCode::OK);
        assert!(
            host_state.lock().unwrap().0 > acknowledged_later_epoch,
            "requested old token must reactivate at a newer epoch, not replay its stale session"
        );
        assert_eq!(
            app.oneshot(request(
                "POST",
                "/api/graph/visual-assets/operations",
                &active_token,
                json!({"operation":{"kind":"list-assets","scope":{"kind":"thread","threadId":1}}})
            ))
            .await
            .unwrap()
            .status(),
            StatusCode::OK
        );
        task.abort();
    }

    #[tokio::test]
    async fn rejected_terminal_submit_resumes_asset_authority_at_the_advanced_generation() {
        let observed = Arc::new(Mutex::new(Vec::<Value>::new()));
        let observed_handler = observed.clone();
        let pause_started = Arc::new(tokio::sync::Notify::new());
        let release_pause = Arc::new(tokio::sync::Notify::new());
        let pause_started_handler = pause_started.clone();
        let release_pause_handler = release_pause.clone();
        let fake = axum::Router::new().route("/visual-assets/operations", post(move |Json(body): Json<Value>| {
            let observed = observed_handler.clone();
            let pause_started = pause_started_handler.clone();
            let release_pause = release_pause_handler.clone();
            async move {
                observed.lock().unwrap().push(body.clone());
                let kind = body.pointer("/operation/kind").and_then(Value::as_str).unwrap_or_default();
                if kind == "pause" { pause_started.notify_one(); release_pause.notified().await; }
                let generation = if kind == "pause" { 2 } else { body.pointer("/operation/assetGeneration").and_then(Value::as_u64).unwrap_or(2) };
                Json(json!({"result": if kind == "list-assets" { json!({"items":[],"nextCursor":null}) } else { json!({"assetGeneration":generation}) }}))
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, fake).await.unwrap();
        });

        let graph = GraphDatabase::in_memory().await.unwrap();
        let interaction = graph
            .create_interaction(ProjectId::new(1), ThreadId::new(2).unwrap(), "Question")
            .await
            .unwrap();
        let state = ServerState::new(graph.clone(), "control");
        let token = mint_capability(&state, interaction.id, None)
            .await
            .ok()
            .unwrap();
        let authority = state.sessions.lock().unwrap().get(&token).copied().unwrap();
        let app = router(state);
        let registration = Request::builder()
            .method("PUT")
            .uri("/api/control/visual-assets/bridge")
            .header("authorization", "Bearer control")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"url":format!("http://{address}"),"token":"x".repeat(32),"generation":1})
                    .to_string(),
            ))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(registration).await.unwrap().status(),
            StatusCode::OK
        );
        let rejected = Request::builder()
            .method("POST")
            .uri("/api/graph/submit")
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(json!({"nodeId":999999}).to_string()))
            .unwrap();
        let pending = tokio::spawn(app.clone().oneshot(rejected));
        pause_started.notified().await;
        graph
            .writer_for_completion_authority(authority.node_id, authority.epoch)
            .await
            .unwrap()
            .require_active_authority()
            .await
            .unwrap();
        release_pause.notify_one();
        assert!(!pending.await.unwrap().unwrap().status().is_success());
        let repair = Request::builder().method("POST").uri("/api/graph/visual-assets/operations")
            .header("authorization", format!("Bearer {token}")).header("content-type", "application/json")
            .body(Body::from(json!({"operation":{"kind":"list-assets","scope":{"kind":"project","projectId":1}}}).to_string())).unwrap();
        assert_eq!(app.oneshot(repair).await.unwrap().status(), StatusCode::OK);
        let requests = observed.lock().unwrap();
        assert_eq!(
            requests[0]
                .pointer("/operation/kind")
                .and_then(Value::as_str),
            Some("pause")
        );
        assert_eq!(
            requests[1]
                .pointer("/operation/kind")
                .and_then(Value::as_str),
            Some("resume")
        );
        assert_eq!(
            requests[2].get("assetGeneration").and_then(Value::as_u64),
            Some(2)
        );
    }

    #[tokio::test]
    async fn lost_finalize_ack_retries_the_same_terminal_receipt_without_restoring_authority() {
        let observed = Arc::new(Mutex::new(Vec::<Value>::new()));
        let observed_handler = observed.clone();
        let finalize_attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let finalize_attempts_handler = finalize_attempts.clone();
        let fake = axum::Router::new().route(
            "/visual-assets/operations",
            post(move |Json(body): Json<Value>| {
                let observed = observed_handler.clone();
                let finalize_attempts = finalize_attempts_handler.clone();
                async move {
                    observed.lock().unwrap().push(body.clone());
                    let kind = body
                        .pointer("/operation/kind")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if kind == "finalize-revoke"
                        && finalize_attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                            == 0
                    {
                        return (
                            StatusCode::SERVICE_UNAVAILABLE,
                            Json(json!({"error":{"code":"ack_lost","message":"finalize committed but its acknowledgement was lost"}})),
                        );
                    }
                    let generation = if kind == "pause" {
                        2
                    } else {
                        body.pointer("/operation/assetGeneration")
                            .and_then(Value::as_u64)
                            .unwrap_or(2)
                    };
                    (
                        StatusCode::OK,
                        Json(json!({"result":{"assetGeneration":generation}})),
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, fake).await.unwrap();
        });

        let state = ServerState::new(GraphDatabase::in_memory().await.unwrap(), "control")
            .with_temporal_features(TemporalFeatureConfig {
                schema_read: true,
                root_current_write: true,
                projection_ui: true,
                ..TemporalFeatureConfig::default()
            });
        state
            .graph
            .set_temporal_features(state.temporal_features)
            .await
            .unwrap();
        let interaction = state
            .graph
            .create_interaction(ProjectId::new(1), ThreadId::new(2).unwrap(), "Question")
            .await
            .unwrap();
        let graph = state.graph.clone();
        let app = router(state);
        let registration = Request::builder()
            .method("PUT")
            .uri("/api/control/visual-assets/bridge")
            .header("authorization", "Bearer control")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"url":format!("http://{address}"),"token":"x".repeat(32),"generation":1})
                    .to_string(),
            ))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(registration).await.unwrap().status(),
            StatusCode::OK
        );
        let transition = || {
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/api/control/interactions/{}/current/transitions",
                    interaction.id.value()
                ))
                .header("authorization", "Bearer control")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"expectedRevision":0,"operationKey":"control-stop","transition":{"kind":"stop","reason":"cancelled_by_user"}}"#,
                ))
                .unwrap()
        };

        assert_eq!(
            app.clone().oneshot(transition()).await.unwrap().status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        let committed = graph
            .current_transition_receipt(interaction.id, "control-stop")
            .await
            .unwrap()
            .expect(
                "the graph terminal transition commits before the lost finalize acknowledgement",
            );
        let retried = app.clone().oneshot(transition()).await.unwrap();
        assert_eq!(retried.status(), StatusCode::OK);
        let retried: CurrentTransitionReceipt =
            serde_json::from_slice(&to_bytes(retried.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(retried, committed);

        let requests = observed.lock().unwrap();
        assert_eq!(
            requests
                .iter()
                .map(|request| request
                    .pointer("/operation/kind")
                    .and_then(Value::as_str)
                    .unwrap())
                .collect::<Vec<_>>(),
            vec!["pause", "finalize-revoke", "pause", "finalize-revoke"]
        );
        let barriers = requests
            .iter()
            .map(|request| {
                request
                    .pointer("/operation/barrierId")
                    .and_then(Value::as_str)
                    .unwrap()
            })
            .collect::<Vec<_>>();
        assert!(barriers.iter().all(|barrier| *barrier == barriers[0]));
    }

    #[tokio::test]
    async fn explicit_revoke_keeps_its_retry_target_until_finalize_is_acknowledged() {
        let finalize_attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let attempts = finalize_attempts.clone();
        let fake = axum::Router::new().route(
            "/visual-assets/operations",
            post(move |Json(body): Json<Value>| {
                let attempts = attempts.clone();
                async move {
                    let kind = body
                        .pointer("/operation/kind")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if kind == "finalize-revoke"
                        && attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0
                    {
                        return (
                            StatusCode::SERVICE_UNAVAILABLE,
                            Json(json!({"error":{"code":"ack_lost","message":"finalize acknowledgement lost"}})),
                        );
                    }
                    let generation = if kind == "pause" {
                        2
                    } else {
                        body.pointer("/operation/assetGeneration")
                            .and_then(Value::as_u64)
                            .unwrap_or(2)
                    };
                    (
                        StatusCode::OK,
                        Json(json!({"result":{"assetGeneration":generation}})),
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, fake).await.unwrap();
        });
        let graph = GraphDatabase::in_memory().await.unwrap();
        let interaction = graph
            .create_interaction(ProjectId::new(1), ThreadId::new(2).unwrap(), "Question")
            .await
            .unwrap();
        let state = ServerState::new(graph, "control");
        let app = router(state.clone());
        let registration = Request::builder()
            .method("PUT")
            .uri("/api/control/visual-assets/bridge")
            .header("authorization", "Bearer control")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"url":format!("http://{address}"),"token":"x".repeat(32),"generation":1})
                    .to_string(),
            ))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(registration).await.unwrap().status(),
            StatusCode::OK
        );
        let token = mint_capability(&state, interaction.id, None)
            .await
            .ok()
            .unwrap();
        let revoke = || {
            Request::builder()
                .method("DELETE")
                .uri("/api/control/capabilities")
                .header("authorization", "Bearer control")
                .header("content-type", "application/json")
                .body(Body::from(json!({"graphToken":token}).to_string()))
                .unwrap()
        };

        assert_eq!(
            app.clone().oneshot(revoke()).await.unwrap().status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert!(state.sessions.lock().unwrap().contains_key(&token));
        let retried = app.oneshot(revoke()).await.unwrap();
        assert_eq!(retried.status(), StatusCode::OK);
        let result: Value =
            serde_json::from_slice(&to_bytes(retried.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(result, json!({"revoked":true,"revokedCount":1}));
        assert!(!state.sessions.lock().unwrap().contains_key(&token));
    }

    #[tokio::test]
    async fn explicit_revoke_takes_over_an_unacknowledged_pause_barrier() {
        let pause_attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let attempts = pause_attempts.clone();
        let fake = axum::Router::new().route(
            "/visual-assets/operations",
            post(move |Json(body): Json<Value>| {
                let attempts = attempts.clone();
                async move {
                    let kind = body.pointer("/operation/kind").and_then(Value::as_str).unwrap_or_default();
                    if kind == "pause" && attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error":{"code":"ack_lost","message":"pause committed but acknowledgement was lost"}})));
                    }
                    let generation = if kind == "pause" { 2 } else { body.pointer("/operation/assetGeneration").and_then(Value::as_u64).unwrap_or(2) };
                    (StatusCode::OK, Json(json!({"result":{"assetGeneration":generation}})))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, fake).await.unwrap();
        });
        let graph = GraphDatabase::in_memory().await.unwrap();
        let interaction = graph
            .create_interaction(ProjectId::new(1), ThreadId::new(2).unwrap(), "Question")
            .await
            .unwrap();
        let state = ServerState::new(graph, "control");
        let app = router(state.clone());
        let registration = Request::builder()
            .method("PUT")
            .uri("/api/control/visual-assets/bridge")
            .header("authorization", "Bearer control")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"url":format!("http://{address}"),"token":"x".repeat(32),"generation":1})
                    .to_string(),
            ))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(registration).await.unwrap().status(),
            StatusCode::OK
        );
        let token = mint_capability(&state, interaction.id, None)
            .await
            .ok()
            .unwrap();
        let rejected = Request::builder()
            .method("POST")
            .uri("/api/graph/submit")
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(json!({"nodeId":999999}).to_string()))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(rejected).await.unwrap().status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        let revoke = Request::builder()
            .method("DELETE")
            .uri("/api/control/capabilities")
            .header("authorization", "Bearer control")
            .header("content-type", "application/json")
            .body(Body::from(json!({"graphToken":token}).to_string()))
            .unwrap();
        assert_eq!(app.oneshot(revoke).await.unwrap().status(), StatusCode::OK);
        assert!(!state.sessions.lock().unwrap().contains_key(&token));
    }

    #[tokio::test]
    async fn failed_bridge_generation_handoff_preserves_the_retryable_completion_epoch() {
        let graph = GraphDatabase::in_memory().await.unwrap();
        let interaction = graph
            .create_interaction(ProjectId::new(1), ThreadId::new(2).unwrap(), "Question")
            .await
            .unwrap();
        let state = ServerState::new(graph.clone(), "control");
        let app = router(state.clone());
        let register = |generation| {
            Request::builder().method("PUT")
            .uri("/api/control/visual-assets/bridge")
            .header("authorization", "Bearer control").header("content-type", "application/json")
            .body(Body::from(json!({"url":"http://127.0.0.1:43117","token":"x".repeat(32),"generation":generation}).to_string())).unwrap()
        };
        let token = mint_capability(&state, interaction.id, None)
            .await
            .ok()
            .unwrap();
        assert_eq!(
            app.clone().oneshot(register(1)).await.unwrap().status(),
            StatusCode::OK
        );
        let authority = state.sessions.lock().unwrap().get(&token).copied().unwrap();
        let writer = graph
            .writer_for_completion_authority(authority.node_id, authority.epoch)
            .await
            .unwrap();
        writer.require_active_authority().await.unwrap();

        assert_eq!(
            app.oneshot(register(2)).await.unwrap().status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        writer.require_active_authority().await.unwrap();
    }

    #[tokio::test]
    async fn failed_multi_completion_bridge_handoff_recovers_pauses_and_retryable_rollback() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        for (
            lost_pause_ack,
            fail_resume,
            lost_resume_ack,
            preexisting_pause,
            preexisting_revoked,
        ) in [
            (false, false, false, false, false),
            (true, false, false, false, false),
            (true, true, false, false, false),
            (true, true, true, false, false),
            (false, false, false, true, false),
            (false, false, false, false, true),
        ] {
            let authorities = Arc::new(Mutex::new(HashMap::<i64, (u64, bool, String)>::new()));
            let observed = authorities.clone();
            let pauses = Arc::new(AtomicUsize::new(0));
            let resume_failed = Arc::new(AtomicBool::new(false));
            let fake = Router::new().route(
                "/visual-assets/operations",
                post(move |Json(body): Json<Value>| {
                    let observed = observed.clone();
                    let pauses = pauses.clone();
                    let resume_failed = resume_failed.clone();
                    async move {
                        if body["operation"]["kind"] == "activate" {
                            return (
                                StatusCode::OK,
                                Json(json!({"result":{"assetGeneration":1}})),
                            );
                        }
                        let id = body["authority"]["interactionNodeId"].as_i64().unwrap();
                        let operation = &body["operation"];
                        let mut states = observed.lock().unwrap();
                        let (generation, paused, barrier) = states.entry(id).or_insert(
                            if preexisting_pause || preexisting_revoked {
                                (2, true, "terminal-or-revoke-owner".into())
                            } else {
                                (1, false, String::new())
                            },
                        );
                        let unavailable = || {
                            (
                                StatusCode::SERVICE_UNAVAILABLE,
                                Json(json!({"error":"injected"})),
                            )
                        };
                        match operation["kind"].as_str().unwrap() {
                            "pause" => {
                                let fail = pauses.fetch_add(1, Ordering::SeqCst) == 1;
                                if fail && !lost_pause_ack {
                                    return unavailable();
                                }
                                if preexisting_revoked {
                                    *barrier = operation["barrierId"].as_str().unwrap().into();
                                } else if *paused {
                                    if operation["barrierId"] != *barrier {
                                        let expected =
                                            operation["expectedGeneration"].as_u64().unwrap();
                                        if operation["revocationTakeover"] != true
                                            || (*generation != expected
                                                && *generation != expected + 1)
                                        {
                                            return unavailable();
                                        }
                                        *barrier = operation["barrierId"].as_str().unwrap().into();
                                    }
                                } else {
                                    assert_eq!(operation["expectedGeneration"], *generation);
                                    *generation += 1;
                                    *paused = true;
                                    *barrier = operation["barrierId"].as_str().unwrap().into();
                                }
                                if fail {
                                    return unavailable();
                                }
                            }
                            "resume" => {
                                assert_eq!(operation["assetGeneration"], *generation);
                                assert_eq!(operation["barrierId"], *barrier);
                                if preexisting_revoked {
                                    return unavailable();
                                }
                                if fail_resume && !resume_failed.swap(true, Ordering::SeqCst) {
                                    if lost_resume_ack {
                                        *paused = false;
                                    }
                                    return unavailable();
                                }
                                *paused = false;
                            }
                            "list-assets" => {
                                if *paused || body["assetGeneration"] != *generation {
                                    return unavailable();
                                }
                                return (
                                    StatusCode::OK,
                                    Json(json!({"result":{"items":[],"nextCursor":null}})),
                                );
                            }
                            other => panic!("unexpected operation {other}"),
                        }
                        (
                            StatusCode::OK,
                            Json(json!({"result":{"assetGeneration":generation}})),
                        )
                    }
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                axum::serve(listener, fake).await.unwrap();
            });
            let graph = GraphDatabase::in_memory().await.unwrap();
            let first = graph
                .create_interaction(None, ThreadId::new(1).unwrap(), "First")
                .await
                .unwrap();
            let second = graph
                .create_interaction(None, ThreadId::new(2).unwrap(), "Second")
                .await
                .unwrap();
            let state = ServerState::new(graph.clone(), "control");
            let app = router(state.clone());
            let registration = |generation| {
                Request::builder().method("PUT")
                .uri("/api/control/visual-assets/bridge").header("authorization", "Bearer control")
                .header("content-type", "application/json")
                .body(Body::from(json!({"url":format!("http://{address}"),"token":"x".repeat(32),"generation":generation}).to_string())).unwrap()
            };
            assert_eq!(
                app.clone().oneshot(registration(1)).await.unwrap().status(),
                StatusCode::OK
            );
            let mut tokens = Vec::new();
            for node in [first.id, second.id] {
                tokens.push(mint_capability(&state, node, None).await.ok().unwrap());
            }
            let response = app.clone().oneshot(registration(2)).await.unwrap();
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(
                state
                    .visual_assets_bridge
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .generation,
                1
            );
            for token in &tokens {
                let authority = state.sessions.lock().unwrap()[token];
                graph
                    .writer_for_completion_authority(authority.node_id, authority.epoch)
                    .await
                    .unwrap()
                    .require_active_authority()
                    .await
                    .unwrap();
            }
            if preexisting_pause {
                assert!(
                    authorities.lock().unwrap().values().all(
                        |(_, paused, barrier)| *paused && barrier == "terminal-or-revoke-owner"
                    ),
                    "handoff compensation must never resume or replace another lifecycle owner's barrier"
                );
            }
            if preexisting_revoked {
                assert!(
                    authorities
                        .lock()
                        .unwrap()
                        .values()
                        .all(|(_, paused, _)| *paused),
                    "compensation cannot revive revoked authority"
                );
            }
            if fail_resume || preexisting_pause || preexisting_revoked {
                let body: Value = serde_json::from_slice(
                    &to_bytes(response.into_body(), usize::MAX).await.unwrap(),
                )
                .unwrap();
                assert_eq!(
                    body["error"]["code"],
                    "visual_assets_bridge_recovery_required"
                );
            } else {
                for (token, thread_id) in tokens.iter().zip([1, 2]) {
                    let request = Request::builder().method("POST").uri("/api/graph/visual-assets/operations")
                        .header("authorization", format!("Bearer {token}")).header("content-type", "application/json")
                        .body(Body::from(json!({"operation":{"kind":"list-assets","scope":{"kind":"thread","threadId":thread_id}}}).to_string())).unwrap();
                    assert_eq!(
                        app.clone().oneshot(request).await.unwrap().status(),
                        StatusCode::OK,
                        "a failed later pause must not strand either completion against the old bridge"
                    );
                }
            }
            if preexisting_pause {
                server.abort();
                continue;
            }
            assert_eq!(
                app.oneshot(registration(2)).await.unwrap().status(),
                StatusCode::OK,
                "retry of the same handoff must recover any unacknowledged compensation"
            );
            assert!(state.sessions.lock().unwrap().is_empty());
            server.abort();
        }
    }

    #[tokio::test]
    async fn partial_bridge_epoch_cutover_stays_paused_until_registration_retry() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = Arc::new(AtomicUsize::new(0));
        let resumes = Arc::new(AtomicUsize::new(0));
        let counted_resumes = resumes.clone();
        let fake = Router::new().route(
            "/visual-assets/operations",
            post(move |Json(body): Json<Value>| {
                let calls = calls.clone();
                let resumes = counted_resumes.clone();
                async move {
                    if body["operation"]["kind"] == "activate" {
                        return (
                            StatusCode::OK,
                            Json(json!({"result":{"assetGeneration":1}})),
                        );
                    }
                    if body["operation"]["kind"] == "resume" {
                        resumes.fetch_add(1, Ordering::SeqCst);
                    }
                    // First attempt pauses twice. The second attempt loses its
                    // second pause response after one old epoch already committed.
                    if calls.fetch_add(1, Ordering::SeqCst) == 3 {
                        return (
                            StatusCode::SERVICE_UNAVAILABLE,
                            Json(json!({"error":"injected retry pause failure"})),
                        );
                    }
                    (
                        StatusCode::OK,
                        Json(json!({"result":{"assetGeneration":2}})),
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, fake).await.unwrap();
        });
        let file = tempfile::NamedTempFile::new().unwrap();
        let graph = GraphDatabase::open(file.path()).await.unwrap();
        let state = ServerState::new(graph.clone(), "control");
        let app = router(state.clone());
        let registration = |generation| {
            Request::builder().method("PUT")
            .uri("/api/control/visual-assets/bridge").header("authorization", "Bearer control")
            .header("content-type", "application/json")
            .body(Body::from(json!({"url":format!("http://{address}"),"token":"x".repeat(32),"generation":generation}).to_string())).unwrap()
        };
        assert_eq!(
            app.clone().oneshot(registration(1)).await.unwrap().status(),
            StatusCode::OK
        );
        let mut authorities = Vec::new();
        for thread in [1, 2] {
            let interaction = graph
                .create_interaction(None, ThreadId::new(thread).unwrap(), "Question")
                .await
                .unwrap();
            let token = mint_capability(&state, interaction.id, None)
                .await
                .ok()
                .unwrap();
            authorities.push(state.sessions.lock().unwrap()[&token]);
        }
        let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}", file.path().display()))
            .await
            .unwrap();
        // Abort the second real cutover transaction regardless of HashSet order.
        sqlx::raw_sql("CREATE TABLE test_original_epochs AS SELECT interaction_node_id,authority_epoch FROM completion_authorities;
            CREATE TRIGGER test_fail_second_cutover BEFORE UPDATE ON completion_authorities
            WHEN EXISTS(SELECT 1 FROM completion_authorities current JOIN test_original_epochs original USING(interaction_node_id) WHERE current.authority_epoch>original.authority_epoch)
            BEGIN SELECT RAISE(ABORT,'injected second cutover failure'); END;")
            .execute(&pool).await.unwrap();
        let response = app.clone().oneshot(registration(2)).await.unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(
            body["error"]["code"],
            "visual_assets_bridge_recovery_required"
        );
        assert_eq!(
            state
                .visual_assets_bridge
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .generation,
            1
        );
        let mut active = 0;
        for authority in &authorities {
            active += usize::from(
                graph
                    .writer_for_completion_authority(authority.node_id, authority.epoch)
                    .await
                    .unwrap()
                    .require_active_authority()
                    .await
                    .is_ok(),
            );
        }
        assert_eq!(
            active, 1,
            "fixture must fail after exactly one committed epoch cutover"
        );
        sqlx::query("DROP TRIGGER test_fail_second_cutover")
            .execute(&pool)
            .await
            .unwrap();
        let retry = app.clone().oneshot(registration(2)).await.unwrap();
        assert_eq!(retry.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            resumes.load(Ordering::SeqCst),
            0,
            "a later failed retry must not compensate a previously irreversible handoff"
        );
        assert!(
            mint_capability(&state, authorities[0].node_id, None)
                .await
                .is_err(),
            "unresolved cutover must not admit fresh authority"
        );
        assert_eq!(
            app.oneshot(registration(2)).await.unwrap().status(),
            StatusCode::OK
        );
        assert!(state.sessions.lock().unwrap().is_empty());
        for authority in authorities {
            assert!(
                graph
                    .writer_for_completion_authority(authority.node_id, authority.epoch)
                    .await
                    .unwrap()
                    .require_active_authority()
                    .await
                    .is_err()
            );
        }
        pool.close().await;
        server.abort();
    }

    #[tokio::test]
    async fn bridge_replacement_fences_new_completion_admission_until_the_swap_finishes() {
        let pause_started = Arc::new(tokio::sync::Notify::new());
        let release_pause = Arc::new(tokio::sync::Notify::new());
        let started = pause_started.clone();
        let release = release_pause.clone();
        let fake = axum::Router::new().route(
            "/visual-assets/operations",
            post(move |Json(body): Json<Value>| {
                let started = started.clone();
                let release = release.clone();
                async move {
                    if body.pointer("/operation/kind").and_then(Value::as_str) == Some("pause") {
                        started.notify_one();
                        release.notified().await;
                    }
                    Json(json!({"result":{"assetGeneration":2}}))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, fake).await.unwrap();
        });
        let graph = GraphDatabase::in_memory().await.unwrap();
        let first = graph
            .create_interaction(ProjectId::new(1), ThreadId::new(2).unwrap(), "First")
            .await
            .unwrap();
        let second = graph
            .create_interaction(ProjectId::new(1), ThreadId::new(2).unwrap(), "Second")
            .await
            .unwrap();
        let state = ServerState::new(graph, "control");
        let app = router(state.clone());
        let registration = |generation| {
            Request::builder().method("PUT")
            .uri("/api/control/visual-assets/bridge").header("authorization", "Bearer control")
            .header("content-type", "application/json")
            .body(Body::from(json!({"url":format!("http://{address}"),"token":"x".repeat(32),"generation":generation}).to_string())).unwrap()
        };
        assert_eq!(
            app.clone().oneshot(registration(1)).await.unwrap().status(),
            StatusCode::OK
        );
        mint_capability(&state, first.id, None).await.ok().unwrap();

        let replacement = tokio::spawn(app.clone().oneshot(registration(2)));
        pause_started.notified().await;
        let mint_state = state.clone();
        let admission =
            tokio::spawn(async move { mint_capability(&mint_state, second.id, None).await });
        tokio::task::yield_now().await;
        assert!(!admission.is_finished());
        release_pause.notify_one();
        assert_eq!(replacement.await.unwrap().unwrap().status(), StatusCode::OK);
        let second_token = admission.await.unwrap().ok().unwrap();
        assert_eq!(state.sessions.lock().unwrap().len(), 1);
        assert_eq!(
            state.sessions.lock().unwrap()[&second_token].node_id,
            second.id
        );
    }

    #[tokio::test]
    async fn import_content_validation_rejects_a_replaced_bridge_response() {
        let validation_started = Arc::new(tokio::sync::Notify::new());
        let release_validation = Arc::new(tokio::sync::Notify::new());
        let started = validation_started.clone();
        let release = release_validation.clone();
        let fake = axum::Router::new().route(
            "/visual-assets/operations",
            post(move |Json(body): Json<Value>| {
                let started = started.clone();
                let release = release.clone();
                async move {
                    assert_eq!(body["operation"]["kind"], "validate-import-content");
                    if body["generation"] == 1 {
                        started.notify_one();
                        release.notified().await;
                    }
                    Json(json!({"result":{"validated":true}}))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, fake).await.unwrap() });
        let app = router(ServerState::new(
            GraphDatabase::in_memory().await.unwrap(),
            "control",
        ));
        let registration = |generation| {
            Request::builder().method("PUT")
                .uri("/api/control/visual-assets/bridge")
                .header("authorization", "Bearer control").header("content-type", "application/json")
                .body(Body::from(json!({"url":format!("http://{address}"),"token":"x".repeat(32),"generation":generation}).to_string())).unwrap()
        };
        let validation = || {
            Request::builder()
                .method("POST")
                .uri("/api/control/visual-assets/imports/validate")
                .header("authorization", "Bearer control")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"projectId":null,"threadId":1,"content":{}}).to_string(),
                ))
                .unwrap()
        };
        assert_eq!(
            app.clone().oneshot(registration(1)).await.unwrap().status(),
            StatusCode::OK
        );
        let pending = tokio::spawn(app.clone().oneshot(validation()));
        validation_started.notified().await;
        assert_eq!(
            app.clone().oneshot(registration(2)).await.unwrap().status(),
            StatusCode::OK
        );
        release_validation.notify_one();
        let response = pending.await.unwrap().unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body["error"]["code"], "visual_assets_bridge_restarted");
        assert_eq!(
            app.oneshot(validation()).await.unwrap().status(),
            StatusCode::OK
        );
        server.abort();
    }

    #[tokio::test]
    async fn node_api_round_trips_and_preserves_the_canonical_authored_detail_package() {
        let graph = GraphDatabase::in_memory().await.unwrap();
        let interaction = graph
            .create_interaction(ProjectId::new(41), ThreadId::new(73).unwrap(), "Question")
            .await
            .unwrap();
        let state = ServerState::new(graph, "control");
        let graph_token = mint_capability(&state, interaction.id, None)
            .await
            .ok()
            .unwrap();
        let app = router(state);
        let package = json!({
            "version": 1,
            "components": [{"id":"overview","order":0,"html":"<p>Accepted</p>","css":"p{color:#fff}"}],
            "mounts": [],
            "assets": [],
            "integritySha256": "6c34582a24f665dfcf9efa843fdb254a646de79c505d76c80863f81ed8dfe659"
        });

        let submitted = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/graph/nodes")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {graph_token}"))
                    .body(Body::from(
                        json!({
                            "clientKey": "answer",
                            "kind": "concept",
                            "icon": "box",
                            "title": "Answer",
                            "detail": "Legacy fallback",
                            "authoredDetail": package
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(submitted.status(), StatusCode::OK);
        let submitted: Value =
            serde_json::from_slice(&to_bytes(submitted.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        let node_id = submitted["node"]["id"].as_i64().unwrap();
        assert_eq!(submitted["node"]["clientKey"], "answer");
        assert_eq!(submitted["node"]["authoredDetail"], package);

        let resubmitted = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/graph/nodes")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {graph_token}"))
                    .body(Body::from(
                        json!({
                            "clientKey": "answer",
                            "kind": "concept",
                            "icon": "box",
                            "title": "Revised answer",
                            "detail": "Revised fallback"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resubmitted.status(), StatusCode::OK);
        let resubmitted: Value =
            serde_json::from_slice(&to_bytes(resubmitted.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(resubmitted["node"]["id"], node_id);
        assert_eq!(resubmitted["node"]["title"], "Revised answer");
        assert_eq!(resubmitted["node"]["authoredDetail"], package);

        let retained = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/graph/nodes/{node_id}"))
                    .header("authorization", format!("Bearer {graph_token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(retained.status(), StatusCode::OK);
        let retained: Value =
            serde_json::from_slice(&to_bytes(retained.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(retained["node"]["clientKey"], "answer");
        assert_eq!(retained["node"]["title"], "Revised answer");
        assert_eq!(retained["node"]["authoredDetail"], package);

        // `authoredDetail: null` is the explicit clear; absence retains.
        let cleared = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/graph/nodes")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {graph_token}"))
                    .body(Body::from(
                        json!({
                            "clientKey": "answer",
                            "kind": "concept",
                            "icon": "box",
                            "title": "Markdown only",
                            "detail": "Markdown fallback",
                            "authoredDetail": null
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(cleared.status(), StatusCode::OK);
        let cleared: Value =
            serde_json::from_slice(&to_bytes(cleared.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(cleared["node"]["id"], node_id);
        assert_eq!(cleared["node"]["title"], "Markdown only");
        assert!(cleared["node"].get("authoredDetail").is_none());

        let fetched = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/graph/nodes/{node_id}"))
                    .header("authorization", format!("Bearer {graph_token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(fetched.status(), StatusCode::OK);
        let fetched: Value =
            serde_json::from_slice(&to_bytes(fetched.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(fetched["node"]["clientKey"], "answer");
        assert_eq!(fetched["node"]["title"], "Markdown only");
        assert!(fetched["node"].get("authoredDetail").is_none());
    }

    #[tokio::test]
    async fn graph_capability_can_discard_an_owned_orphan_layer() {
        let graph = GraphDatabase::in_memory().await.unwrap();
        let interaction = graph
            .create_interaction(ProjectId::new(41), ThreadId::new(73).unwrap(), "Question")
            .await
            .unwrap();
        let writer = graph.writer_for_subgraph(interaction.id).await.unwrap();
        let node = writer
            .submit_node(&NodeDraft {
                client_key: "abandoned-node".into(),
                kind: "concept".into(),
                icon: "box".into(),
                title: "Abandoned".into(),
                detail: "Preserve this draft".into(),
            })
            .await
            .unwrap();
        let layer = writer
            .submit_layer(&LayerDraft {
                client_key: "abandoned-layer".into(),
                nodes: vec![node.id],
                edges: vec![],
                layout: authored_layout(node.id),
                size_justification: None,
            })
            .await
            .unwrap();
        let state = ServerState::new(graph, "control");
        let graph_token = mint_capability(&state, interaction.id, None)
            .await
            .ok()
            .unwrap();
        let app = router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/graph/layers/{}/discard", layer.id.value()))
                    .header("authorization", format!("Bearer {graph_token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body["layer"]["id"], layer.id.value());
        assert_eq!(body["layer"]["state"], "stopped");
    }

    #[tokio::test]
    async fn staged_import_endpoints_require_control_authority_and_finalize_in_order() {
        let app = router(ServerState::new(
            GraphDatabase::in_memory().await.unwrap(),
            "control",
        ));
        let stage = serde_json::to_vec(&ImportedConversationStage {
            import_id: "import-stage-1".into(),
            source_sha256: "sha256:fixture".into(),
            project_id: None,
            thread_id: ThreadId::new(9001).unwrap(),
            created_at: "1770000000000".into(),
        })
        .unwrap();
        let denied = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/conversation-import-stages")
                    .header("content-type", "application/json")
                    .body(Body::from(stage.clone()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);

        let started = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/conversation-import-stages")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(stage))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(started.status(), StatusCode::OK);

        let turn = serde_json::to_vec(&ImportedTurn {
            source_turn_id: "turn:1".into(),
            text: "Failed turn".into(),
            interaction_node_id: None,
            invoke_origin: None,
            contexts: vec![],
            submitted_inputs: vec![],
            accepted_view: None,
        })
        .unwrap();
        let staged = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/conversation-import-stages/import-stage-1/turns")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(turn))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(staged.status(), StatusCode::OK);

        let finalized = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/conversation-import-stages/import-stage-1/finalize")
                    .header("authorization", "Bearer control")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(finalized.status(), StatusCode::OK);
        let receipt: relayer_graph_core::ImportedConversationReceipt =
            serde_json::from_slice(&to_bytes(finalized.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(receipt.turns.len(), 1);
        assert_eq!(receipt.turns[0].source_turn_id, "turn:1");
    }

    fn authored_layout(node_id: NodeId) -> Option<LayerLayout> {
        Some(LayerLayout::v1(vec![NodePlacement {
            node_id,
            x: 0.5,
            y: 0.5,
        }]))
    }

    #[tokio::test]
    async fn personal_presentation_attachment_requires_control_authority_and_resolves_graph() {
        let graph = GraphDatabase::in_memory().await.unwrap();
        let version_text = "Personal presentation V1";
        let version_digest =
            relayer_graph_core::interaction_input_digest(version_text, &[]).unwrap();
        let version = graph
            .create_personal_presentation_interaction(
                version_text,
                "relayer.personal-presentation:test-v1",
                &version_digest,
            )
            .await
            .unwrap();
        let version_writer = graph.writer_for_subgraph(version.id).await.unwrap();
        let preference = version_writer
            .submit_node(&NodeDraft {
                client_key: "decision-useful-center".into(),
                kind: "presentation-preference".into(),
                icon: "compass".into(),
                title: "Decision-useful center".into(),
                detail: "Foreground the conclusion or current status.".into(),
            })
            .await
            .unwrap();
        let layer = version_writer
            .submit_layer(&LayerDraft {
                client_key: "root".into(),
                nodes: vec![preference.id],
                edges: vec![],
                layout: authored_layout(preference.id),
                size_justification: None,
            })
            .await
            .unwrap();
        version_writer
            .add_action(&ActionDraft {
                client_key: "response".into(),
                source_node_id: version.id,
                source_layer_id: None,
                kind: ActionKind::Navigate,
                relation: Some(relayer_graph_core::NavigateRelation::Expand),
                label: "Personal presentation".into(),
                variant: relayer_graph_core::ActionVariant::Pill,
                icon: None,
                description: None,
                target_layer_id: Some(layer.id),
                interaction_text: None,
                input: None,
            })
            .await
            .unwrap();
        version_writer.complete(version.id).await.unwrap();
        graph
            .publish_personal_presentation_version(version.id)
            .await
            .unwrap();
        let target = graph
            .create_interaction(ProjectId::new(41), ThreadId::new(73).unwrap(), "Question")
            .await
            .unwrap();
        let app = router(ServerState::new(graph, "control"));
        let body = json!({"versionInteractionNodeId": version.id}).to_string();

        let denied = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/api/control/interactions/{}/personal-presentation",
                        target.id.value()
                    ))
                    .header("content-type", "application/json")
                    .body(Body::from(body.clone()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);

        let attached = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/api/control/interactions/{}/personal-presentation",
                        target.id.value()
                    ))
                    .header("authorization", "Bearer control")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(attached.status(), StatusCode::OK);

        let resolved = app
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/control/interactions/{}/personal-presentation",
                        target.id.value()
                    ))
                    .header("authorization", "Bearer control")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resolved.status(), StatusCode::OK);
        let resolved: Value =
            serde_json::from_slice(&to_bytes(resolved.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(
            resolved["attachment"]["versionInteractionNodeId"],
            version.id.value()
        );
        assert_eq!(resolved["graph"]["rootLayerId"], layer.id.value());
        assert_eq!(
            resolved["graph"]["layers"][0]["nodes"][0]["kind"],
            "presentation-preference"
        );
    }

    #[tokio::test]
    async fn control_prepares_context_and_capability_reads_normalized_input_only() {
        let graph = GraphDatabase::in_memory().await.unwrap();
        let source = graph
            .create_interaction(ProjectId::new(41), ThreadId::new(73).unwrap(), "Source")
            .await
            .unwrap();
        let source_writer = graph.writer_for_subgraph(source.id).await.unwrap();
        let target = source_writer
            .submit_node(&NodeDraft {
                client_key: "target".into(),
                kind: "concept".into(),
                icon: "box".into(),
                title: "Target".into(),
                detail: "Target detail".into(),
            })
            .await
            .unwrap();
        let layer = source_writer
            .submit_layer(&LayerDraft {
                client_key: "root".into(),
                nodes: vec![target.id],
                edges: vec![],
                layout: authored_layout(target.id),
                size_justification: None,
            })
            .await
            .unwrap();
        source_writer
            .add_action(&ActionDraft {
                client_key: "response".into(),
                source_node_id: source.id,
                source_layer_id: None,
                kind: ActionKind::Navigate,
                relation: Some(relayer_graph_core::NavigateRelation::Expand),
                label: "Response".into(),
                variant: relayer_graph_core::ActionVariant::Pill,
                icon: None,
                description: None,
                target_layer_id: Some(layer.id),
                interaction_text: None,
                input: None,
            })
            .await
            .unwrap();
        source_writer.complete(source.id).await.unwrap();

        let state = ServerState::new(graph, "control");
        let app = router(state.clone());
        let occurrence_body = json!({
            "nodeId": target.id,
            "sourceInteractionNodeId": source.id,
            "sourceLayerId": layer.id,
        });
        let denied_occurrence = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/context-occurrences/canonical")
                    .header("content-type", "application/json")
                    .body(Body::from(occurrence_body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(denied_occurrence.status(), StatusCode::UNAUTHORIZED);

        let canonical = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/context-occurrences/canonical")
                    .header("authorization", "Bearer control")
                    .header("content-type", "application/json")
                    .body(Body::from(occurrence_body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(canonical.status(), StatusCode::OK);
        let canonical: Value =
            serde_json::from_slice(&to_bytes(canonical.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(canonical["id"], target.id.value());
        assert_eq!(canonical["title"], "Target");

        let unknown_field = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/context-occurrences/canonical")
                    .header("authorization", "Bearer control")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "nodeId": target.id,
                            "sourceInteractionNodeId": source.id,
                            "sourceLayerId": layer.id,
                            "projectId": 41,
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unknown_field.status(), StatusCode::UNPROCESSABLE_ENTITY);

        let invalid_occurrence = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/context-occurrences/canonical")
                    .header("authorization", "Bearer control")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "nodeId": target.id,
                            "sourceInteractionNodeId": 999999,
                            "sourceLayerId": layer.id,
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            invalid_occurrence.status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        let invalid_occurrence: Value = serde_json::from_slice(
            &to_bytes(invalid_occurrence.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            invalid_occurrence["error"]["code"],
            "invalid_context_occurrence"
        );
        assert_eq!(invalid_occurrence["error"]["path"], "target");

        let created = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/interactions")
                    .header("authorization", "Bearer control")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "projectId": 41,
                            "threadId": 74,
                            "text": "",
                            "contexts": [{
                                "target": {
                                    "nodeId": target.id,
                                    "sourceInteractionNodeId": source.id,
                                    "sourceLayerId": layer.id
                                },
                                "annotations": ["  exact annotation  "]
                            }]
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(created.status(), StatusCode::OK);
        let created: CreateInteractionResponse =
            serde_json::from_slice(&to_bytes(created.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(created.context_actions[0].type_id, "interaction.context");

        let input = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/graph/input")
                    .header("authorization", format!("Bearer {}", created.graph_token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(input.status(), StatusCode::OK);
        let input: Value =
            serde_json::from_slice(&to_bytes(input.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(input["interaction"]["detail"], "");
        assert_eq!(input["contexts"][0]["type"], "interaction.context");
        assert_eq!(input["contexts"][0]["targetNode"]["id"], target.id.value());
        assert_eq!(
            input["contexts"][0]["annotations"][0],
            "  exact annotation  "
        );
        assert!(input["contexts"][0].get("id").is_none());
        assert!(input["contexts"][0].get("sourceNodeId").is_none());
        assert!(input["contexts"][0].get("target").is_none());
        assert!(input["contexts"][0].get("sourceLayerId").is_none());

        let diagnostic = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/control/interactions/{}/context-actions",
                        created.node.id.value()
                    ))
                    .header("authorization", "Bearer control")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let diagnostic: Value =
            serde_json::from_slice(&to_bytes(diagnostic.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert!(diagnostic["actions"][0]["id"].is_number());
        assert_eq!(
            diagnostic["actions"][0]["sourceNodeId"],
            created.node.id.value()
        );
        assert_eq!(
            diagnostic["actions"][0]["target"]["sourceInteractionNodeId"],
            source.id.value()
        );
        assert_eq!(
            diagnostic["actions"][0]["target"]["sourceLayerId"],
            layer.id.value()
        );

        let forged = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/graph/actions")
                    .header("authorization", format!("Bearer {}", created.graph_token))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "clientKey": "forged",
                            "sourceNodeId": created.node.id,
                            "kind": "interaction.context",
                            "label": "Context",
                            "targetLayerId": null,
                            "interactionText": null
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(forged.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let forged: Value =
            serde_json::from_slice(&to_bytes(forged.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(forged["error"]["code"], "control_only_action");
    }

    #[tokio::test]
    async fn temporal_current_routes_enforce_control_and_terminal_broker_boundaries() {
        let state = ServerState::new(GraphDatabase::in_memory().await.unwrap(), "control")
            .with_temporal_features(TemporalFeatureConfig {
                schema_read: true,
                root_current_write: true,
                projection_ui: true,
                ..TemporalFeatureConfig::default()
            });
        state
            .graph
            .set_temporal_features(state.temporal_features)
            .await
            .unwrap();
        let interaction = state
            .graph
            .create_interaction(ProjectId::new(41), ThreadId::new(73).unwrap(), "Question")
            .await
            .unwrap();
        let token = mint_capability(&state, interaction.id, None)
            .await
            .ok()
            .unwrap();
        let app = router(state);

        let current = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/graph/current")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(current.status(), StatusCode::OK);

        let failed = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/graph/current/transitions")
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"expectedRevision":0,"operationKey":"model-fail","transition":{"kind":"fail","reason":"provider_crashed"}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(failed.status(), StatusCode::FORBIDDEN);

        let stopped = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/graph/current/transitions")
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"expectedRevision":0,"operationKey":"model-stop","transition":{"kind":"stop","reason":"cancelled_by_user"}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(stopped.status(), StatusCode::OK);
        let stopped_receipt: CurrentTransitionReceipt =
            serde_json::from_slice(&to_bytes(stopped.into_body(), usize::MAX).await.unwrap())
                .unwrap();

        let conflicting_receipt = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/api/control/interactions/{}/current/receipts",
                        interaction.id.value()
                    ))
                    .header("authorization", "Bearer control")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"operationKey":"model-stop","requestDigest":"sha256:different"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(conflicting_receipt.status(), StatusCode::CONFLICT);

        let recovered_receipt = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/api/control/interactions/{}/current/receipts",
                        interaction.id.value()
                    ))
                    .header("authorization", "Bearer control")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "operationKey": "model-stop",
                            "requestDigest": stopped_receipt.request_digest,
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(recovered_receipt.status(), StatusCode::OK);

        let terminal_model_read = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/graph/current")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            terminal_model_read.status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );

        let terminal_output_read = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/graph/nodes/{}/output",
                        interaction.id.value()
                    ))
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(terminal_output_read.status(), StatusCode::NOT_FOUND);

        let control_current = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/control/interactions/{}/current",
                        interaction.id.value()
                    ))
                    .header("authorization", "Bearer control")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(control_current.status(), StatusCode::OK);
        let body: Value = serde_json::from_slice(
            &to_bytes(control_current.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(body["lifecycle"], "stopped");
        assert_eq!(body["headRevision"], 1);

        let projections = app
            .oneshot(
                Request::builder()
                    .uri("/api/control/current-projections?after=0&limit=10")
                    .header("authorization", "Bearer control")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(projections.status(), StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&to_bytes(projections.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body["events"].as_array().unwrap().len(), 2);
        assert_eq!(body["events"][1]["lifecycle"], "stopped");
    }

    #[tokio::test]
    async fn parent_capability_prepares_one_recursive_child_without_caller_scope() {
        let features = TemporalFeatureConfig {
            schema_read: true,
            root_current_write: true,
            projection_ui: true,
            invoke_resolution: true,
            provider_recursion: true,
            ..TemporalFeatureConfig::default()
        };
        let graph = GraphDatabase::in_memory().await.unwrap();
        graph.set_temporal_features(features).await.unwrap();
        let parent = graph
            .create_interaction(ProjectId::new(41), ThreadId::new(73).unwrap(), "Parent")
            .await
            .unwrap();
        let writer = graph.writer_for_subgraph(parent.id).await.unwrap();
        let source = writer
            .submit_node(&NodeDraft {
                client_key: "source".into(),
                kind: "concept".into(),
                icon: "box".into(),
                title: "Source".into(),
                detail: "Source".into(),
            })
            .await
            .unwrap();
        let layer = writer
            .submit_layer(&LayerDraft {
                client_key: "current".into(),
                nodes: vec![source.id],
                edges: vec![],
                layout: authored_layout(source.id),
                size_justification: None,
            })
            .await
            .unwrap();
        let invoke = writer
            .add_action(&ActionDraft {
                client_key: "child".into(),
                source_node_id: source.id,
                source_layer_id: Some(layer.id),
                kind: ActionKind::Invoke,
                relation: None,
                label: "Investigate".into(),
                variant: relayer_graph_core::ActionVariant::Pill,
                icon: None,
                description: None,
                target_layer_id: None,
                interaction_text: Some("Canonical child input".into()),
                input: None,
            })
            .await
            .unwrap();
        writer
            .transition_current(
                0,
                "publish-child",
                CurrentTransition::Advance { layer_id: layer.id },
            )
            .await
            .unwrap();
        let state = ServerState::new(graph, "control").with_temporal_features(features);
        let parent_token = mint_capability(&state, parent.id, None).await.ok().unwrap();
        let app = router(state);
        let denied = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/recursive-completions")
                    .header("authorization", format!("Bearer {parent_token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({ "actionId": invoke.id, "parentGraphToken": &parent_token })
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
        let request = || {
            Request::builder()
                .method("POST")
                .uri("/api/control/recursive-completions")
                .header("authorization", "Bearer control")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({ "actionId": invoke.id, "parentGraphToken": &parent_token }).to_string(),
                ))
                .unwrap()
        };

        let first = app.clone().oneshot(request()).await.unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        let first: PrepareRecursiveCompletionResponse =
            serde_json::from_slice(&to_bytes(first.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        let retry = app.clone().oneshot(request()).await.unwrap();
        assert_eq!(retry.status(), StatusCode::OK);
        let retry: PrepareRecursiveCompletionResponse =
            serde_json::from_slice(&to_bytes(retry.into_body(), usize::MAX).await.unwrap())
                .unwrap();

        let model_prepared = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/graph/completions/prepare")
                    .header("authorization", format!("Bearer {parent_token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "actionId": invoke.id }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(model_prepared.status(), StatusCode::OK);
        let model_prepared: PrepareGraphCompletionResponse = serde_json::from_slice(
            &to_bytes(model_prepared.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();

        assert_eq!(retry.node.id, first.node.id);
        assert_eq!(model_prepared.interaction_node, first.node.id);
        assert_eq!(first.node.detail, "Canonical child input");
        assert_eq!(first.node.leased_action_id, Some(invoke.id));
        assert_ne!(first.node.id, parent.id);
    }

    #[tokio::test]
    async fn external_interaction_requires_control_token_and_mints_scoped_graph_token() {
        let state = ServerState::new(GraphDatabase::in_memory().await.unwrap(), "control");
        let app = router(state.clone());
        let denied = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/interactions")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"projectId":41,"threadId":73,"text":"hello"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
        let allowed = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/interactions")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(
                        r#"{"projectId":41,"threadId":73,"text":"hello"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(allowed.status(), StatusCode::OK);
        let bytes = to_bytes(allowed.into_body(), usize::MAX).await.unwrap();
        let body: CreateInteractionResponse = serde_json::from_slice(&bytes).unwrap();
        assert!(!body.graph_token.is_empty());
        assert!(body.node.id.value() > 0);
        assert_eq!(body.node.leased_action_id, None);

        let node_id = state
            .sessions
            .lock()
            .unwrap()
            .get(&body.graph_token)
            .unwrap()
            .to_owned();
        assert_eq!(node_id.node_id, body.node.id);
    }

    #[tokio::test]
    async fn product_can_bind_before_mint_and_invalidate_a_crash_surviving_node_token() {
        let state = ServerState::new(GraphDatabase::in_memory().await.unwrap(), "control");
        let app = router(state.clone());
        let created = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/interactions")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(
                        r#"{"threadId":73,"text":"hello","mintCapability":false}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let created: CreateInteractionResponse =
            serde_json::from_slice(&to_bytes(created.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert!(created.graph_token.is_empty());
        assert!(state.sessions.lock().unwrap().is_empty());

        let token = "product-chosen-crash-token";
        let minted = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/capabilities")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(format!(
                        r#"{{"nodeId":{},"graphToken":"{token}"}}"#,
                        created.node.id.value()
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(minted.status(), StatusCode::OK);

        let repeated = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/capabilities")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(format!(
                        r#"{{"nodeId":{},"graphToken":"{token}"}}"#,
                        created.node.id.value()
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(repeated.status(), StatusCode::OK);

        let second = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/interactions")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(
                        r#"{"threadId":74,"text":"second","mintCapability":false}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let second: CreateInteractionResponse =
            serde_json::from_slice(&to_bytes(second.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        let conflict = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/capabilities")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(format!(
                        r#"{{"nodeId":{},"graphToken":"{token}"}}"#,
                        second.node.id.value()
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(conflict.status(), StatusCode::CONFLICT);
        assert_eq!(
            state
                .sessions
                .lock()
                .unwrap()
                .get(token)
                .map(|authority| authority.node_id),
            Some(created.node.id)
        );

        let invalidated = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/control/capabilities")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(format!(
                        r#"{{"nodeId":{}}}"#,
                        created.node.id.value()
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(invalidated.status(), StatusCode::OK);
        let rejected = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/graph/nodes/{}", created.node.id.value()))
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn control_issues_and_replays_typed_invocation_leases_with_derived_neighbors() {
        let graph = GraphDatabase::in_memory().await.unwrap();
        let source_interaction = graph
            .create_interaction(ProjectId::new(41), ThreadId::new(73).unwrap(), "Source")
            .await
            .unwrap();
        let writer = graph
            .writer_for_subgraph(source_interaction.id)
            .await
            .unwrap();
        let source = writer
            .submit_node(&NodeDraft {
                client_key: "source".into(),
                kind: "concept".into(),
                icon: "box".into(),
                title: "Source".into(),
                detail: "Accepted source".into(),
            })
            .await
            .unwrap();
        let layer = writer
            .submit_layer(&LayerDraft {
                client_key: "root".into(),
                nodes: vec![source.id],
                edges: vec![],
                layout: Some(LayerLayout {
                    version: 1,
                    placements: vec![NodePlacement {
                        node_id: source.id,
                        x: 0.5,
                        y: 0.5,
                    }],
                }),
                size_justification: None,
            })
            .await
            .unwrap();
        let invoke = writer
            .add_action(&ActionDraft {
                client_key: "continue".into(),
                source_node_id: source.id,
                source_layer_id: Some(layer.id),
                kind: ActionKind::Invoke,
                relation: None,
                label: "Continue".into(),
                variant: relayer_graph_core::ActionVariant::Pill,
                icon: None,
                description: None,
                target_layer_id: None,
                interaction_text: Some("Continue".into()),
                input: None,
            })
            .await
            .unwrap();
        writer
            .add_action(&ActionDraft {
                client_key: "response".into(),
                source_node_id: source_interaction.id,
                source_layer_id: None,
                kind: ActionKind::Navigate,
                relation: Some(relayer_graph_core::NavigateRelation::Expand),
                label: "Response".into(),
                variant: relayer_graph_core::ActionVariant::Pill,
                icon: None,
                description: None,
                target_layer_id: Some(layer.id),
                interaction_text: None,
                input: None,
            })
            .await
            .unwrap();
        writer.complete(source_interaction.id).await.unwrap();

        let app = router(ServerState::new(graph.clone(), "control"));
        let request_body = format!(
            r#"{{"projectId":41,"threadId":74,"text":"Result","invocation":{{"sourceInteractionNodeId":{},"sourceActionId":{}}}}}"#,
            source_interaction.id.value(),
            invoke.id.value()
        );
        let create = |body: String| {
            Request::builder()
                .method("POST")
                .uri("/api/control/interactions")
                .header("content-type", "application/json")
                .header("authorization", "Bearer control")
                .body(Body::from(body))
                .unwrap()
        };
        let first = app
            .clone()
            .oneshot(create(request_body.clone()))
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        let first: CreateInteractionResponse =
            serde_json::from_slice(&to_bytes(first.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(first.node.leased_action_id, Some(invoke.id));

        let replay = app.clone().oneshot(create(request_body)).await.unwrap();
        assert_eq!(replay.status(), StatusCode::OK);
        let replay: CreateInteractionResponse =
            serde_json::from_slice(&to_bytes(replay.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(replay.node, first.node);

        let stale = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/graph/nodes/{}/neighbors",
                        first.node.id.value()
                    ))
                    .header("authorization", format!("Bearer {}", first.graph_token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(stale.status(), StatusCode::UNAUTHORIZED);

        let neighbors = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/graph/nodes/{}/neighbors",
                        first.node.id.value()
                    ))
                    .header("authorization", format!("Bearer {}", replay.graph_token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(neighbors.status(), StatusCode::OK);
        let neighbors: Value =
            serde_json::from_slice(&to_bytes(neighbors.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(neighbors["nodes"][0]["id"], source.id.value());

        let result_writer = graph.writer_for_subgraph(first.node.id).await.unwrap();
        let result_node = result_writer
            .submit_node(&NodeDraft {
                client_key: "result".into(),
                kind: "concept".into(),
                icon: "box".into(),
                title: "Result".into(),
                detail: "Accepted result".into(),
            })
            .await
            .unwrap();
        let result_layer = result_writer
            .submit_layer(&LayerDraft {
                client_key: "result-root".into(),
                nodes: vec![result_node.id],
                edges: vec![],
                layout: Some(LayerLayout {
                    version: 1,
                    placements: vec![NodePlacement {
                        node_id: result_node.id,
                        x: 0.5,
                        y: 0.5,
                    }],
                }),
                size_justification: None,
            })
            .await
            .unwrap();
        result_writer
            .add_action(&ActionDraft {
                client_key: "response".into(),
                source_node_id: first.node.id,
                source_layer_id: None,
                kind: ActionKind::Navigate,
                relation: Some(relayer_graph_core::NavigateRelation::Expand),
                label: "Response".into(),
                variant: relayer_graph_core::ActionVariant::Pill,
                icon: None,
                description: None,
                target_layer_id: Some(result_layer.id),
                interaction_text: None,
                input: None,
            })
            .await
            .unwrap();
        let submitted = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/graph/submit")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {}", replay.graph_token))
                    .body(Body::from(format!(
                        r#"{{"nodeId":{}}}"#,
                        first.node.id.value()
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(submitted.status(), StatusCode::OK);
        let submitted: CompletionOutput =
            serde_json::from_slice(&to_bytes(submitted.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(submitted.root_layer.layer.id, result_layer.id);
        let resolved = writer.completion_output().await.unwrap().unwrap();
        assert_eq!(
            resolved
                .root_layer
                .actions
                .iter()
                .find(|action| action.id == invoke.id)
                .unwrap()
                .target_layer_id,
            Some(result_layer.id)
        );
        let owner = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/control/interactions/{}/layers/{}/owner",
                        source_interaction.id.value(),
                        result_layer.id.value()
                    ))
                    .header("authorization", "Bearer control")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(owner.status(), StatusCode::OK);
        let owner: Value =
            serde_json::from_slice(&to_bytes(owner.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(owner["layerId"], result_layer.id.value());
        assert_eq!(owner["ownerInteractionNodeId"], first.node.id.value());

        let invalid = app
            .oneshot(create(format!(
                r#"{{"projectId":41,"threadId":74,"text":"Result","invocation":{{"sourceInteractionNodeId":{},"sourceActionId":0}}}}"#,
                source_interaction.id.value()
            )))
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn control_authority_can_remint_a_capability_after_server_restart() {
        let graph = GraphDatabase::in_memory().await.unwrap();
        let first_app = router(ServerState::new(graph.clone(), "control"));
        let created = first_app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/interactions")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(
                        r#"{"projectId":41,"threadId":73,"text":"hello"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let created: CreateInteractionResponse =
            serde_json::from_slice(&to_bytes(created.into_body(), usize::MAX).await.unwrap())
                .unwrap();

        let restarted = router(ServerState::new(graph, "control"));
        let reminted = restarted
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/capabilities")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(format!(
                        r#"{{"nodeId":{}}}"#,
                        created.node.id.value()
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(reminted.status(), StatusCode::OK);
        let reminted: RemintCapabilityResponse =
            serde_json::from_slice(&to_bytes(reminted.into_body(), usize::MAX).await.unwrap())
                .unwrap();

        let readable = restarted
            .oneshot(
                Request::builder()
                    .uri(format!("/api/graph/nodes/{}", created.node.id.value()))
                    .header("authorization", format!("Bearer {}", reminted.graph_token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(readable.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn control_authority_can_revoke_a_graph_capability() {
        let state = ServerState::new(GraphDatabase::in_memory().await.unwrap(), "control");
        let app = router(state.clone());
        let created = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/interactions")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(
                        r#"{"projectId":41,"threadId":73,"text":"hello"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let created: CreateInteractionResponse =
            serde_json::from_slice(&to_bytes(created.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        let resolved_before_revoke = *state
            .sessions
            .lock()
            .unwrap()
            .get(&created.graph_token)
            .unwrap();
        let in_flight = state
            .graph
            .writer_for_completion_authority(
                resolved_before_revoke.node_id,
                resolved_before_revoke.epoch,
            )
            .await
            .unwrap();

        let revoked = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/control/capabilities")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(format!(
                        r#"{{"graphToken":"{}"}}"#,
                        created.graph_token
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(revoked.status(), StatusCode::OK);
        let stale_in_flight = in_flight
            .submit_node(&NodeDraft {
                client_key: "stale-after-revoke".into(),
                kind: "concept".into(),
                icon: "box".into(),
                title: "Stale".into(),
                detail: "Revocation must cut over already resolved authority.".into(),
            })
            .await
            .unwrap_err();
        assert!(matches!(
            stale_in_flight,
            GraphError::Validation {
                code: "authority_generation_expired",
                ..
            }
        ));

        let denied = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/graph/nodes/{}", created.node.id.value()))
                    .header("authorization", format!("Bearer {}", created.graph_token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn invalid_interaction_can_be_retried_with_the_same_external_ids() {
        let app = router(ServerState::new(
            GraphDatabase::in_memory().await.unwrap(),
            "control",
        ));
        let invalid = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/interactions")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(r#"{"projectId":41,"threadId":73,"text":""}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::UNPROCESSABLE_ENTITY);

        let retry = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/interactions")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(
                        r#"{"projectId":41,"threadId":73,"text":"valid"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(retry.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn layer_api_returns_typed_layout_repairs_and_round_trips_valid_layout() {
        let graph = GraphDatabase::in_memory().await.unwrap();
        let interaction = graph
            .create_interaction(ProjectId::new(41), ThreadId::new(73).unwrap(), "hello")
            .await
            .unwrap();
        let writer = graph.writer_for_subgraph(interaction.id).await.unwrap();
        let answer = writer
            .submit_node(&NodeDraft {
                client_key: "answer".into(),
                kind: "concept".into(),
                icon: "box".into(),
                title: "Answer".into(),
                detail: "Answer detail".into(),
            })
            .await
            .unwrap();
        let state = ServerState::new(graph, "control");
        let graph_token = mint_capability(&state, interaction.id, None)
            .await
            .ok()
            .unwrap();
        let app = router(state);

        let missing = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/graph/layers")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {graph_token}"))
                    .body(Body::from(format!(
                        r#"{{"clientKey":"root","nodes":[{}],"edges":[]}}"#,
                        answer.id.value()
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let missing: Value =
            serde_json::from_slice(&to_bytes(missing.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(missing["error"]["code"], "missing_layer_layout");
        assert_eq!(missing["error"]["path"], "layout");

        let malformed = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/graph/layers")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {graph_token}"))
                    .body(Body::from(format!(
                        r#"{{"clientKey":"root","nodes":[{}],"edges":[],"layout":{{"version":1,"placements":[{{"nodeId":{},"x":null,"y":"not-a-number"}}]}}}}"#,
                        answer.id.value(), answer.id.value()
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(malformed.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let malformed: Value =
            serde_json::from_slice(&to_bytes(malformed.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(malformed["error"]["code"], "non_finite_layout_coordinate");
        assert_eq!(
            malformed["error"]["issues"][0]["path"],
            "layout.placements[0].x"
        );
        assert_eq!(
            malformed["error"]["issues"][1]["path"],
            "layout.placements[0].y"
        );

        let out_of_range = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/graph/layers")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {graph_token}"))
                    .body(Body::from(format!(
                        r#"{{"clientKey":"root","nodes":[{}],"edges":[],"layout":{{"version":1,"placements":[{{"nodeId":{},"x":-0.01,"y":1.01}}]}}}}"#,
                        answer.id.value(), answer.id.value()
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(out_of_range.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let out_of_range: Value = serde_json::from_slice(
            &to_bytes(out_of_range.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            out_of_range["error"]["issues"][0]["path"],
            "layout.placements[0].x"
        );
        assert_eq!(
            out_of_range["error"]["issues"][1]["path"],
            "layout.placements[0].y"
        );

        let valid = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/graph/layers")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {graph_token}"))
                    .body(Body::from(format!(
                        r#"{{"clientKey":"root","nodes":[{}],"edges":[],"layout":{{"version":1,"placements":[{{"nodeId":{},"x":0.25,"y":0.75}}]}}}}"#,
                        answer.id.value(), answer.id.value()
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(valid.status(), StatusCode::OK);
        let valid: Value =
            serde_json::from_slice(&to_bytes(valid.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        let layer_id = valid["layer"]["id"].as_i64().unwrap();
        assert_eq!(valid["layer"]["clientKey"], "root");
        assert_eq!(valid["layer"]["layout"]["version"], 1);
        assert_eq!(valid["layer"]["layout"]["placements"][0]["x"], 0.25);

        writer
            .add_action(&ActionDraft {
                client_key: "continue".into(),
                source_node_id: answer.id,
                source_layer_id: LayerId::new(layer_id),
                kind: ActionKind::Invoke,
                relation: None,
                label: "Continue".into(),
                variant: relayer_graph_core::ActionVariant::Pill,
                icon: None,
                description: None,
                target_layer_id: None,
                interaction_text: Some("Continue from here".into()),
                input: None,
            })
            .await
            .unwrap();
        writer
            .add_action(&ActionDraft {
                client_key: "response".into(),
                source_node_id: interaction.id,
                source_layer_id: None,
                kind: ActionKind::Navigate,
                relation: Some(relayer_graph_core::NavigateRelation::Expand),
                label: "Response".into(),
                variant: relayer_graph_core::ActionVariant::Pill,
                icon: None,
                description: None,
                target_layer_id: LayerId::new(layer_id),
                interaction_text: None,
                input: None,
            })
            .await
            .unwrap();
        let completed = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/graph/submit")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {graph_token}"))
                    .body(Body::from(format!(
                        r#"{{"nodeId":{}}}"#,
                        interaction.id.value()
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(completed.status(), StatusCode::OK);
        let completed: Value =
            serde_json::from_slice(&to_bytes(completed.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(
            completed["rootLayer"]["layer"]["layout"],
            valid["layer"]["layout"]
        );
        assert_eq!(completed["rootLayer"]["layer"]["clientKey"], "root");
        assert_eq!(completed["rootLayer"]["nodes"][0]["clientKey"], "answer");
        assert_eq!(
            completed["rootLayer"]["actions"][0]["clientKey"],
            "continue"
        );
        assert_eq!(
            completed["rootLayer"]["actions"][0]["sourceLayerClientKey"],
            "root"
        );

        let terminal_broker_read = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/graph/layers/{layer_id}"))
                    .header("authorization", format!("Bearer {graph_token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            terminal_broker_read.status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        let read = app
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/control/interactions/{}/layers/{layer_id}",
                        interaction.id.value()
                    ))
                    .header("authorization", "Bearer control")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(read.status(), StatusCode::OK);
        let read: Value =
            serde_json::from_slice(&to_bytes(read.into_body(), usize::MAX).await.unwrap()).unwrap();
        assert_eq!(read["layer"]["layout"], valid["layer"]["layout"]);
    }

    #[tokio::test]
    async fn action_api_defaults_older_authors_and_returns_repairable_variant_errors() {
        let graph = GraphDatabase::in_memory().await.unwrap();
        let interaction = graph
            .create_interaction(ProjectId::new(41), ThreadId::new(73).unwrap(), "hello")
            .await
            .unwrap();
        let writer = graph.writer_for_subgraph(interaction.id).await.unwrap();
        let source = writer
            .submit_node(&NodeDraft {
                client_key: "source".into(),
                kind: "concept".into(),
                icon: "box".into(),
                title: "Source".into(),
                detail: "Source detail".into(),
            })
            .await
            .unwrap();
        let source_layer = writer
            .submit_layer(&LayerDraft {
                client_key: "source-layer".into(),
                nodes: vec![source.id],
                edges: vec![],
                layout: authored_layout(source.id),
                size_justification: None,
            })
            .await
            .unwrap();
        let state = ServerState::new(graph, "control");
        let graph_token = mint_capability(&state, interaction.id, None)
            .await
            .ok()
            .unwrap();
        let app = router(state);

        let older = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/graph/actions")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {graph_token}"))
                    .body(Body::from(format!(
                        r#"{{"clientKey":"older","sourceNodeId":{},"sourceLayerId":{},"kind":"invoke","label":"Continue","interactionText":"Continue from here"}}"#,
                        source.id.value(), source_layer.id.value()
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(older.status(), StatusCode::OK);
        let older: Value =
            serde_json::from_slice(&to_bytes(older.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(older["action"]["variant"], "pill");
        assert!(older["action"]["icon"].is_null());
        assert!(older["action"]["description"].is_null());

        let unsupported = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/graph/actions")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {graph_token}"))
                    .body(Body::from(format!(
                        r#"{{"clientKey":"unsupported","sourceNodeId":{},"sourceLayerId":{},"kind":"invoke","label":"Continue","variant":"banner","interactionText":"Continue from here"}}"#,
                        source.id.value(), source_layer.id.value()
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unsupported.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let unsupported: Value =
            serde_json::from_slice(&to_bytes(unsupported.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(unsupported["error"]["code"], "unsupported_action_variant");
        assert_eq!(unsupported["error"]["path"], "variant");

        let missing_prompt = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/graph/actions")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {graph_token}"))
                    .body(Body::from(format!(
                        r#"{{"clientKey":"missing-prompt","sourceNodeId":{},"sourceLayerId":{},"kind":"input","label":"Choose","control":"text"}}"#,
                        source.id.value(), source_layer.id.value()
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing_prompt.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let missing_prompt: Value = serde_json::from_slice(
            &to_bytes(missing_prompt.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            missing_prompt["error"]["code"],
            "input_action_prompt_required"
        );
        assert_eq!(missing_prompt["error"]["path"], "prompt");

        let missing_control = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/graph/actions")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {graph_token}"))
                    .body(Body::from(format!(
                        r#"{{"clientKey":"missing-control","sourceNodeId":{},"sourceLayerId":{},"kind":"input","label":"Choose","prompt":"Choose a value"}}"#,
                        source.id.value(), source_layer.id.value()
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing_control.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let missing_control: Value = serde_json::from_slice(
            &to_bytes(missing_control.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            missing_control["error"]["code"],
            "input_action_control_unsupported"
        );
        assert_eq!(missing_control["error"]["path"], "control");

        let explicit_empty_options = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/graph/actions")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {graph_token}"))
                    .body(Body::from(format!(
                        r#"{{"clientKey":"empty-options","sourceNodeId":{},"sourceLayerId":{},"kind":"input","label":"Explain","control":"text","prompt":"Explain","options":[]}}"#,
                        source.id.value(), source_layer.id.value()
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            explicit_empty_options.status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        let explicit_empty_options: Value = serde_json::from_slice(
            &to_bytes(explicit_empty_options.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            explicit_empty_options["error"]["code"],
            "input_action_options_unexpected"
        );
        assert_eq!(explicit_empty_options["error"]["path"], "options");

        let omitted_options = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/graph/actions")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {graph_token}"))
                    .body(Body::from(format!(
                        r#"{{"clientKey":"omitted-options","sourceNodeId":{},"sourceLayerId":{},"kind":"input","label":"Explain","control":"text","prompt":"Explain"}}"#,
                        source.id.value(), source_layer.id.value()
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(omitted_options.status(), StatusCode::OK);

        let negative_minimum = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/graph/actions")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {graph_token}"))
                    .body(Body::from(format!(
                        r#"{{"clientKey":"negative-minimum","sourceNodeId":{},"sourceLayerId":{},"kind":"input","label":"Choose","control":"multi_select","prompt":"Choose","options":[{{"key":"one","label":"One"}},{{"key":"two","label":"Two"}}],"minimumSelections":-1}}"#,
                        source.id.value(), source_layer.id.value()
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(negative_minimum.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let negative_minimum: Value = serde_json::from_slice(
            &to_bytes(negative_minimum.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            negative_minimum["error"]["code"],
            "input_action_minimum_invalid"
        );
        assert_eq!(negative_minimum["error"]["path"], "minimumSelections");

        for minimum in 1..=2 {
            let valid_minimum = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/graph/actions")
                        .header("content-type", "application/json")
                        .header("authorization", format!("Bearer {graph_token}"))
                        .body(Body::from(format!(
                            r#"{{"clientKey":"valid-minimum-{minimum}","sourceNodeId":{},"sourceLayerId":{},"kind":"input","label":"Choose","control":"multi_select","prompt":"Choose","options":[{{"key":"one","label":"One"}},{{"key":"two","label":"Two"}}],"minimumSelections":{minimum}}}"#,
                            source.id.value(), source_layer.id.value()
                        )))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(valid_minimum.status(), StatusCode::OK);
        }
    }

    #[tokio::test]
    async fn action_api_returns_repairable_error_for_a_second_root_key() {
        let graph = GraphDatabase::in_memory().await.unwrap();
        let interaction = graph
            .create_interaction(ProjectId::new(41), ThreadId::new(73).unwrap(), "hello")
            .await
            .unwrap();
        let writer = graph.writer_for_subgraph(interaction.id).await.unwrap();
        let answer = writer
            .submit_node(&NodeDraft {
                client_key: "answer".into(),
                kind: "concept".into(),
                icon: "box".into(),
                title: "Answer".into(),
                detail: "Answer detail".into(),
            })
            .await
            .unwrap();
        let layer = writer
            .submit_layer(&LayerDraft {
                client_key: "root-layer".into(),
                nodes: vec![answer.id],
                edges: vec![],
                layout: authored_layout(answer.id),
                size_justification: None,
            })
            .await
            .unwrap();
        let state = ServerState::new(graph, "control");
        let graph_token = mint_capability(&state, interaction.id, None)
            .await
            .ok()
            .unwrap();
        let app = router(state);
        let action_body = |client_key: &str, label: &str| {
            serde_json::to_vec(&json!({
                "clientKey": client_key,
                "sourceNodeId": interaction.id,
                "kind": "navigate",
                "relation": "expand",
                "label": label,
                "targetLayerId": layer.id,
            }))
            .unwrap()
        };

        let first = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/graph/actions")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {graph_token}"))
                    .body(Body::from(action_body("response", "Response")))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        let first: Value =
            serde_json::from_slice(&to_bytes(first.into_body(), usize::MAX).await.unwrap())
                .unwrap();

        let rejected = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/graph/actions")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {graph_token}"))
                    .body(Body::from(action_body("duplicate", "Duplicate")))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let rejected: Value =
            serde_json::from_slice(&to_bytes(rejected.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(rejected["error"]["code"], "root_action_already_exists");
        assert_eq!(rejected["error"]["path"], "clientKey");
        assert!(
            rejected["error"]["message"]
                .as_str()
                .unwrap()
                .contains("response")
        );

        let replayed = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/graph/actions")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {graph_token}"))
                    .body(Body::from(action_body("response", "Updated response")))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(replayed.status(), StatusCode::OK);
        let replayed: Value =
            serde_json::from_slice(&to_bytes(replayed.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(replayed["action"]["id"], first["action"]["id"]);
        assert_eq!(replayed["action"]["label"], "Updated response");
    }

    #[tokio::test]
    async fn action_read_is_scoped_to_the_source_interactions_accepted_closure() {
        let graph = GraphDatabase::in_memory().await.unwrap();
        let interaction = graph
            .create_interaction(ProjectId::new(41), ThreadId::new(73).unwrap(), "hello")
            .await
            .unwrap();
        let writer = graph.writer_for_subgraph(interaction.id).await.unwrap();
        let answer = writer
            .submit_node(&NodeDraft {
                client_key: "answer".into(),
                kind: "concept".into(),
                icon: "compass".into(),
                title: "Answer".into(),
                detail: "Accepted detail".into(),
            })
            .await
            .unwrap();
        let layer = writer
            .submit_layer(&LayerDraft {
                client_key: "root".into(),
                nodes: vec![answer.id],
                edges: vec![],
                layout: authored_layout(answer.id),
                size_justification: None,
            })
            .await
            .unwrap();
        let invoke = writer
            .add_action(&ActionDraft {
                client_key: "continue".into(),
                source_node_id: answer.id,
                source_layer_id: Some(layer.id),
                kind: ActionKind::Invoke,
                relation: None,
                label: "Continue".into(),
                variant: relayer_graph_core::ActionVariant::Pill,
                icon: None,
                description: None,
                target_layer_id: None,
                interaction_text: Some("Continue from here".into()),
                input: None,
            })
            .await
            .unwrap();
        writer
            .add_action(&ActionDraft {
                client_key: "response".into(),
                source_node_id: interaction.id,
                source_layer_id: None,
                kind: ActionKind::Navigate,
                relation: Some(relayer_graph_core::NavigateRelation::Expand),
                label: "Response".into(),
                variant: relayer_graph_core::ActionVariant::Pill,
                icon: None,
                description: None,
                target_layer_id: Some(layer.id),
                interaction_text: None,
                input: None,
            })
            .await
            .unwrap();
        writer.complete(interaction.id).await.unwrap();

        let state = ServerState::new(graph, "control");
        let app = router(state);
        let readable = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/control/interactions/{}/actions/{}",
                        interaction.id.value(),
                        invoke.id.value()
                    ))
                    .header("authorization", "Bearer control")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(readable.status(), StatusCode::OK);
        let readable: Value =
            serde_json::from_slice(&to_bytes(readable.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(readable["action"]["id"], invoke.id.value());
        assert_eq!(readable["action"]["kind"], "invoke");

        let absent = app
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/control/interactions/{}/actions/99999",
                        interaction.id.value()
                    ))
                    .header("authorization", "Bearer control")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(absent.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn product_identifiers_must_be_positive_and_project_is_optional() {
        let app = router(ServerState::new(
            GraphDatabase::in_memory().await.unwrap(),
            "control",
        ));
        let invalid = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/interactions")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(
                        r#"{"projectId":0,"threadId":73,"text":"invalid project"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::UNPROCESSABLE_ENTITY);

        let standalone = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/interactions")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(
                        r#"{"threadId":73,"text":"standalone interaction"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(standalone.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn control_materializes_submitted_input_and_capability_reads_only_semantics() {
        let graph = GraphDatabase::in_memory().await.unwrap();
        let presenting = graph
            .create_interaction(ProjectId::new(41), ThreadId::new(73).unwrap(), "Source")
            .await
            .unwrap();
        let writer = graph.writer_for_subgraph(presenting.id).await.unwrap();
        let source = writer
            .submit_node(&NodeDraft {
                client_key: "choice".into(),
                kind: "concept".into(),
                icon: "box".into(),
                title: "Choice".into(),
                detail: "Choose evidence".into(),
            })
            .await
            .unwrap();
        let layer = writer
            .submit_layer(&LayerDraft {
                client_key: "root".into(),
                nodes: vec![source.id],
                edges: vec![],
                layout: authored_layout(source.id),
                size_justification: None,
            })
            .await
            .unwrap();
        let input_action = relayer_graph_core::InputAction {
            control: relayer_graph_core::InputControl::SingleSelect,
            prompt: "Choose evidence".into(),
            options: vec![relayer_graph_core::InputOption {
                key: "logs".into(),
                label: "Logs".into(),
                unsupported_fields: Default::default(),
            }],
            minimum_selections: None,
            unsupported_fields: Default::default(),
        };
        let action = writer
            .add_action(&ActionDraft {
                client_key: "evidence".into(),
                source_node_id: source.id,
                source_layer_id: Some(layer.id),
                kind: ActionKind::Input,
                relation: None,
                label: "Choose".into(),
                variant: relayer_graph_core::ActionVariant::Pill,
                icon: None,
                description: None,
                target_layer_id: None,
                interaction_text: None,
                input: Some(input_action.clone()),
            })
            .await
            .unwrap();
        writer
            .add_action(&ActionDraft {
                client_key: "response".into(),
                source_node_id: presenting.id,
                source_layer_id: None,
                kind: ActionKind::Navigate,
                relation: Some(relayer_graph_core::NavigateRelation::Expand),
                label: "Response".into(),
                variant: relayer_graph_core::ActionVariant::Pill,
                icon: None,
                description: None,
                target_layer_id: Some(layer.id),
                interaction_text: None,
                input: None,
            })
            .await
            .unwrap();
        writer.complete(presenting.id).await.unwrap();
        let submitted = relayer_graph_core::SubmittedInputDraft {
            occurrence: relayer_graph_core::PresentingInputOccurrence {
                presenting_interaction_node_id: presenting.id,
                presenting_layer_id: layer.id,
                action_id: action.id,
            },
            action: input_action,
            value: relayer_graph_core::SubmittedInputValue::Selected {
                selected: vec![relayer_graph_core::InputOption {
                    key: "logs".into(),
                    label: "Logs".into(),
                    unsupported_fields: Default::default(),
                }],
            },
        };
        let digest = relayer_graph_core::interaction_input_authority_digest(
            "",
            std::slice::from_ref(&submitted),
        )
        .unwrap();
        let body = json!({
            "projectId": 41, "threadId": 74, "text": "", "inputIdentity": "attempt:1",
            "inputDigest": digest, "submittedInputs": [submitted],
        })
        .to_string();
        let app = router(ServerState::new(graph, "control"));
        let canonical_body = |destination_project_id, destination_thread_id| {
            json!({
                "destinationProjectId": destination_project_id,
                "destinationThreadId": destination_thread_id,
                "occurrence": {
                    "presentingInteractionNodeId": presenting.id,
                    "presentingLayerId": layer.id,
                    "actionId": action.id
                }
            })
            .to_string()
        };
        let canonical = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/input-action-occurrences/canonical")
                    .header("authorization", "Bearer control")
                    .header("content-type", "application/json")
                    .body(Body::from(canonical_body(41, 74)))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(canonical.status(), StatusCode::OK);
        let wrong_project = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/input-action-occurrences/canonical")
                    .header("authorization", "Bearer control")
                    .header("content-type", "application/json")
                    .body(Body::from(canonical_body(42, 73)))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(wrong_project.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let wrong_project_body: Value = serde_json::from_slice(
            &to_bytes(wrong_project.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            wrong_project_body["error"]["code"],
            "input_occurrence_not_visible"
        );
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/interactions")
                    .header("authorization", "Bearer control")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let response_body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(
            status,
            StatusCode::OK,
            "{}",
            String::from_utf8_lossy(&response_body)
        );
        let created: CreateInteractionResponse = serde_json::from_slice(&response_body).unwrap();
        assert_eq!(created.input_children.len(), 1);

        let child = serde_json::to_value(&created.input_children[0]).unwrap();
        assert_eq!(child["sourceNodeId"], source.id.value());
        assert_eq!(child["attemptKey"], "attempt:1");
        let normalized = app
            .oneshot(
                Request::builder()
                    .uri("/api/graph/input")
                    .header("authorization", format!("Bearer {}", created.graph_token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(normalized.status(), StatusCode::OK);
        let normalized: Value =
            serde_json::from_slice(&to_bytes(normalized.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(normalized["interaction"]["detail"], "");
        assert_eq!(
            normalized["submittedInputs"][0]["action"]["prompt"],
            "Choose evidence"
        );
        assert_eq!(
            normalized["submittedInputs"][0]["value"]["selected"][0]["label"],
            "Logs"
        );
        assert!(normalized["submittedInputs"][0].get("attemptKey").is_none());
        assert!(normalized["submittedInputs"][0].get("occurrence").is_none());
    }
}

#[cfg(all(test, not(feature = "ladybug")))]
mod no_ladybug_search_tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use tower::ServiceExt;

    async fn body(response: Response) -> Value {
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
    }

    #[tokio::test]
    async fn search_fails_closed_without_ladybug_after_selector_authority() {
        let graph = GraphDatabase::in_memory().await.unwrap();
        let interaction = graph
            .create_interaction(None, ThreadId::new(73).unwrap(), "Search")
            .await
            .unwrap();
        let state = ServerState::new(graph, "control");
        let graph_token = mint_capability_with_profile(
            &state,
            interaction.id,
            None,
            GraphCapabilityProfile {
                search: GraphSearchCapability::QueryV1,
            },
        )
        .await
        .ok()
        .unwrap();
        let app = router(state);
        let valid = r#"{"queryContractVersion":1,"query":"MATCH (n:Content) RETURN n","parameters":{},"budget":{}}"#;

        let unavailable = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/graph/search")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {graph_token}"))
                    .body(Body::from(valid))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unavailable.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            body(unavailable).await["error"]["code"],
            "search_unavailable"
        );

        let unauthorized = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/graph/search")
                    .header("content-type", "application/json")
                    .body(Body::from(valid))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let malformed_precedes_authority = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/graph/search")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"queryContractVersion":1,"query":"broken""#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            malformed_precedes_authority.status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(
            body(malformed_precedes_authority).await["error"]["phase"],
            "envelope"
        );

        for (request, code, phase) in [
            (
                r#"{"queryContractVersion":2,"query":"MATCH (n:Content) RETURN n","parameters":{},"budget":{}}"#,
                "unsupported_query_contract_version",
                "envelope",
            ),
            (
                r#"{"queryContractVersion":1,"query":"CREATE (n:Content)","parameters":{},"budget":{}}"#,
                "query_construct_forbidden",
                "parse",
            ),
            (
                r#"{"queryContractVersion":1,"query":"MATCH (n:Unknown) RETURN n","parameters":{},"budget":{}}"#,
                "unknown_label",
                "plan",
            ),
        ] {
            let preflight_precedes_missing_authority_and_index = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/graph/search")
                        .header("content-type", "application/json")
                        .body(Body::from(request))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                preflight_precedes_missing_authority_and_index.status(),
                StatusCode::UNPROCESSABLE_ENTITY
            );
            let error = body(preflight_precedes_missing_authority_and_index).await;
            assert_eq!(error["error"]["code"], code);
            assert_eq!(error["error"]["phase"], phase);
        }

        let explicit_current_target = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/graph/search")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {graph_token}"))
                    .body(Body::from(
                        r#"{"queryContractVersion":1,"target":{"scope":"thread","id":73},"query":"MATCH (n:Content) RETURN n","parameters":{},"budget":{}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            explicit_current_target.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            body(explicit_current_target).await["error"]["code"],
            "search_unavailable"
        );
    }
}
