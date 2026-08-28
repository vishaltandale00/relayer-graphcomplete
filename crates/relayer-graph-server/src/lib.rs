use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use relayer_graph_core::{
    ActionDraft, ActionId, ActionKind, CompletionOutput, CurrentTransition,
    CurrentTransitionReceipt, EdgeDraft, GraphAction, GraphDatabase, GraphError, GraphNode,
    GraphWriter, ImportedConversationStage, ImportedTurn, InteractionContextAction,
    InteractionContextDraft, InteractionContextTarget, InteractionInput, InteractionInputNode,
    InteractionInvocation, LayerDraft, LayerId, LayerLayout, NodeDraft, NodeId, NodePlacement,
    ProjectId, RecordState, TemporalFeatureConfig, ThreadId,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex},
};
use uuid::Uuid;

#[derive(Clone)]
pub struct ServerState {
    graph: GraphDatabase,
    sessions: Arc<Mutex<HashMap<String, RuntimeAuthority>>>,
    control_token: Arc<str>,
    temporal_features: TemporalFeatureConfig,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RuntimeAuthority {
    node_id: NodeId,
    epoch: u64,
}

impl ServerState {
    pub fn new(graph: GraphDatabase, control_token: impl Into<String>) -> Self {
        Self {
            graph,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            control_token: Arc::from(control_token.into()),
            temporal_features: TemporalFeatureConfig::default(),
        }
    }

    pub fn with_temporal_features(mut self, temporal_features: TemporalFeatureConfig) -> Self {
        self.temporal_features = temporal_features;
        self
    }
}

pub fn router(state: ServerState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route(
            "/api/control/temporal-features",
            get(control_temporal_features),
        )
        .route("/api/control/interactions", post(create_interaction))
        .route("/api/control/interactions/{id}", get(interaction_metadata))
        .route("/api/control/interactions/{id}/input", get(control_input))
        .route(
            "/api/control/interactions/{id}/context-actions",
            get(control_context_actions),
        )
        .route(
            "/api/control/context-occurrences/canonical",
            post(canonical_context_occurrence),
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
            "/api/control/capabilities",
            post(remint_capability).delete(revoke_capability),
        )
        .route(
            "/api/control/recursive-completions",
            post(prepare_recursive_completion),
        )
        .route("/api/graph/nodes", post(submit_node))
        .route("/api/graph/nodes/{id}", get(get_node))
        .route("/api/graph/nodes/{id}/neighbors", get(neighbors))
        .route("/api/graph/input", get(interaction_input))
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
        .route("/api/graph/nodes/{id}/output", get(completion_output))
        .with_state(state)
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
    input_identity: Option<String>,
    #[serde(default)]
    input_digest: Option<String>,
    #[serde(default = "default_mint_capability")]
    mint_capability: bool,
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
    if input.invocation.is_some() && !input.contexts.is_empty() {
        return Err(ApiError::invalid(
            "invocation and contexts cannot be prepared together yet",
        ));
    }
    let (interaction, context_actions) = if let (Some(identity), Some(digest)) = (
        input.input_identity.as_deref(),
        input.input_digest.as_deref(),
    ) {
        if input.invocation.is_some() {
            return Err(ApiError::invalid(
                "identified context input cannot also be an invocation",
            ));
        }
        state
            .graph
            .create_identified_interaction_with_context(
                input.project_id,
                input.thread_id,
                &input.text,
                identity,
                digest,
                &input.contexts,
            )
            .await?
    } else if input.input_identity.is_some() || input.input_digest.is_some() {
        return Err(ApiError::invalid(
            "inputIdentity and inputDigest must be supplied together",
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
        )
    } else {
        state
            .graph
            .create_interaction_with_context(
                input.project_id,
                input.thread_id,
                &input.text,
                &input.contexts,
            )
            .await?
    };
    let graph_token = if input.mint_capability {
        Some(mint_capability(&state, interaction.id, None).await?)
    } else {
        None
    };
    Ok(Json(CreateInteractionResponse {
        node: interaction,
        graph_token: graph_token.unwrap_or_default(),
        context_actions,
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
    Ok(Json(
        state
            .graph
            .writer_for_subgraph(id)
            .await?
            .transition_current(
                input.expected_revision,
                &input.operation_key,
                input.transition,
            )
            .await?,
    ))
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
        graph_token: mint_capability(&state, input.node_id, input.graph_token).await?,
    }))
}

async fn mint_capability(
    state: &ServerState,
    node_id: NodeId,
    requested_token: Option<String>,
) -> Result<String, ApiError> {
    let graph_token = requested_token.unwrap_or_else(|| Uuid::new_v4().to_string());
    if graph_token.is_empty() {
        return Err(ApiError::invalid("graphToken must be non-empty"));
    }
    {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| ApiError::internal("session lock poisoned"))?;
        if let Some(active) = sessions.get(&graph_token)
            && active.node_id != node_id
        {
            return Err(ApiError::conflict(
                "capability_token_conflict",
                "graphToken is already bound to a different interaction",
            ));
        }
    }
    let epoch = state.graph.activate_completion_authority(node_id).await?;
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| ApiError::internal("session lock poisoned"))?;
    sessions.retain(|_, active| active.node_id != node_id);
    sessions.insert(graph_token.clone(), RuntimeAuthority { node_id, epoch });
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
    let (revoked, revoked_node) = {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| ApiError::internal("session lock poisoned"))?;
        match (input.graph_token, input.node_id) {
            (Some(graph_token), None) => match sessions.remove(&graph_token) {
                Some(authority) => (1, Some(authority.node_id)),
                None => (0, None),
            },
            (None, Some(node_id)) => {
                let before = sessions.len();
                sessions.retain(|_, active| active.node_id != node_id);
                (before - sessions.len(), Some(node_id))
            }
            _ => {
                return Err(ApiError::invalid(
                    "provide exactly one of graphToken or nodeId",
                ));
            }
        }
    };
    if revoked > 0 {
        state
            .graph
            .cutover_completion_authority(revoked_node.expect("revocation has a node"))
            .await?;
    }
    Ok(Json(
        json!({"revoked": revoked > 0, "revokedCount": revoked}),
    ))
}

async fn submit_node(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<NodeDraft>,
) -> Result<Json<Value>, ApiError> {
    let authority = session(&state, &headers)?;
    let node = state
        .graph
        .writer_for_completion_authority(authority.node_id, authority.epoch)
        .await?
        .submit_node(&input)
        .await?;
    Ok(Json(json!({"node": node})))
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
    let output = writer.completion_output().await?.ok_or_else(|| {
        ApiError(
            StatusCode::NOT_FOUND,
            json!({"error":{"code":"completion_not_found","message":"This node has no accepted completion output yet."}}),
        )
    })?;
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
    Err(ApiError(
        StatusCode::NOT_FOUND,
        json!({"error":{"code":"action_not_found","message":"This accepted completion does not contain that action."}}),
    ))
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
    let output = state
        .graph
        .writer_for_completion_authority(authority.node_id, authority.epoch)
        .await?
        .complete(input.node_id)
        .await?;
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
        assert_eq!(
            terminal_output_read.status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );

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
        assert_eq!(valid["layer"]["layout"]["version"], 1);
        assert_eq!(valid["layer"]["layout"]["placements"][0]["x"], 0.25);

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
}
