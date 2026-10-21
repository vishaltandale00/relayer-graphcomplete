//! Completion-epoch instruction delivery receipts. This is an in-memory issuance
//! cache, not evidence of model comprehension or a durable cache across restarts.
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};

use axum::{Json, extract::State, http::HeaderMap};
use relayer_graph_core::{
    NodeId,
    query::{
        Expression, PreparedPublicQuery, PreparedQuery, PublicQueryRequest, QueryCode, QueryError,
        preflight_public_request_json,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{ApiError, ServerState, capability};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum RetrievalPurpose {
    Authority,
    Authoring,
    Presentation,
    Navigation,
    Search,
    Preview,
    Repair,
    Delegation,
    Verification,
    Recovery,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RetrievalReason {
    purpose: RetrievalPurpose,
    detail: String,
}
impl RetrievalReason {
    pub(super) fn validate(&self) -> Result<(), ApiError> {
        validate_summary(&self.detail, "reason.detail")
    }
}
fn validate_summary(value: &str, path: &str) -> Result<(), ApiError> {
    if value.trim().chars().count() < 8
        || value.chars().count() > 240
        || value.chars().any(char::is_control)
    {
        return Err(ApiError::invalid(&format!(
            "{path} must contain 8 to 240 characters describing the operational purpose in one short line."
        )));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RetrievalRequest {
    request_key: String,
    node_ids: Vec<NodeId>,
    reason: RetrievalReason,
    #[serde(default)]
    reread_reason: Option<String>,
}
impl RetrievalRequest {
    fn validate(&self) -> Result<(), ApiError> {
        if self.request_key.trim().is_empty()
            || self.request_key.chars().count() > 128
            || self.request_key.chars().any(char::is_control)
        {
            return Err(ApiError::invalid(
                "requestKey must be a nonempty stable identifier of at most 128 characters.",
            ));
        }
        if !(1..=8).contains(&self.node_ids.len())
            || self.node_ids.iter().collect::<HashSet<_>>().len() != self.node_ids.len()
        {
            return Err(ApiError::invalid(
                "A retrieval must request 1 to 8 distinct instruction node IDs.",
            ));
        }
        self.reason.validate()?;
        if let Some(reason) = &self.reread_reason {
            validate_summary(reason, "rereadReason")?;
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RetrievalEntry {
    node_id: NodeId,
    key: String,
    title: String,
    delivery: &'static str,
    body_characters: usize,
    body_bytes: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    first_request_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RetrievalResponse {
    version_key: String,
    digest: String,
    request_key: String,
    replayed: bool,
    reason: RetrievalReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    reread_reason: Option<String>,
    entries: Vec<RetrievalEntry>,
}
struct SavedRequest {
    request: RetrievalRequest,
    response: RetrievalResponse,
}
#[derive(Default)]
struct CompletionRetrievals {
    issued: HashMap<NodeId, String>,
    requests: HashMap<String, SavedRequest>,
}
type ScopeKey = (NodeId, u64, String);
type Scope = Arc<tokio::sync::Mutex<CompletionRetrievals>>;
#[derive(Default)]
pub(super) struct InstructionRetrievals {
    scopes: Mutex<HashMap<ScopeKey, Scope>>,
}
impl InstructionRetrievals {
    fn scope(&self, node: NodeId, epoch: u64, digest: &str) -> Result<Scope, ApiError> {
        let mut scopes = self
            .scopes
            .lock()
            .map_err(|_| ApiError::internal("instruction retrieval receipt lock poisoned"))?;
        Ok(scopes
            .entry((node, epoch, digest.to_owned()))
            .or_default()
            .clone())
    }
    pub(super) fn forget(&self, node: NodeId) -> Result<(), ApiError> {
        self.scopes
            .lock()
            .map_err(|_| ApiError::internal("instruction retrieval receipt lock poisoned"))?
            .retain(|(id, _, _), _| *id != node);
        Ok(())
    }
}

pub(super) async fn retrieve(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<RetrievalRequest>,
) -> Result<Json<RetrievalResponse>, ApiError> {
    input.validate()?;
    let authority = capability(&state, &headers)?;
    let manifest = state
        .graph
        .instruction_graph(authority.node_id, authority.epoch)
        .await?;
    if manifest.retrieval_contract_version != 2 {
        return Err(ApiError::invalid(
            "Reasoned retrieval requires instruction retrieval contract 2.",
        ));
    }
    let scope =
        state
            .instruction_retrievals
            .scope(authority.node_id, authority.epoch, &manifest.digest)?;
    let mut receipt = scope.lock().await;
    let writer = state
        .graph
        .writer_for_completion_authority(authority.node_id, authority.epoch)
        .await?;
    writer.require_active_authority().await?;
    if let Some(saved) = receipt.requests.get(&input.request_key) {
        if saved.request != input {
            return Err(ApiError::conflict(
                "instruction_request_key_conflict",
                "requestKey is already bound to a different retrieval payload in this completion epoch.",
            ));
        }
        let mut response = saved.response.clone();
        response.replayed = true;
        writer.require_active_authority().await?;
        return Ok(Json(response));
    }
    let (_, nodes) = state
        .graph
        .instruction_retrieval_nodes(authority.node_id, authority.epoch, &input.node_ids)
        .await?;
    let mut entries = Vec::with_capacity(nodes.len());
    let mut body_characters = 0;
    for node in nodes {
        let pointer = manifest
            .modules
            .iter()
            .find(|entry| entry.node_id == node.id)
            .expect("core authorized the module");
        let first_request_key = receipt.issued.get(&node.id).cloned();
        let include_body = first_request_key.is_none() || input.reread_reason.is_some();
        let characters = if include_body {
            node.detail.chars().count()
        } else {
            0
        };
        let bytes = if include_body { node.detail.len() } else { 0 };
        body_characters += characters;
        entries.push(RetrievalEntry {
            node_id: node.id,
            key: pointer.key.clone(),
            title: pointer.title.clone(),
            delivery: if !include_body {
                "already-returned"
            } else if first_request_key.is_some() {
                "reread"
            } else {
                "body"
            },
            body_characters: characters,
            body_bytes: bytes,
            first_request_key,
            detail: include_body.then_some(node.detail),
        });
    }
    if body_characters > 8000 {
        return Err(ApiError::invalid(
            "A retrieval may return at most 8000 instruction body characters. Request fewer relevant chunks.",
        ));
    }
    writer.require_active_authority().await?;
    for entry in &entries {
        if entry.detail.is_some() {
            receipt
                .issued
                .entry(entry.node_id)
                .or_insert_with(|| input.request_key.clone());
        }
    }
    let response = RetrievalResponse {
        version_key: manifest.version_key,
        digest: manifest.digest,
        request_key: input.request_key.clone(),
        replayed: false,
        reason: input.reason.clone(),
        reread_reason: input.reread_reason.clone(),
        entries,
    };
    receipt.requests.insert(
        input.request_key.clone(),
        SavedRequest {
            request: input,
            response: response.clone(),
        },
    );
    Ok(Json(response))
}

// Serde's flattened map buffers preserve duplicate keys until PublicQueryRequest's
// own strict field/parameter deserializers consume them. Do not extract `reason`
// through serde_json::Value: that would collapse duplicate query fields.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReasonedSearch {
    #[serde(default)]
    reason: Option<RetrievalReason>,
    #[serde(flatten)]
    query: PublicQueryRequest,
}
pub(super) fn search_preflight(
    body: &[u8],
) -> Result<(PreparedPublicQuery, Option<RetrievalReason>), ApiError> {
    match preflight_public_request_json(body) {
        Ok(prepared) => Ok((prepared, None)),
        Err(original) => {
            let envelope: ReasonedSearch = serde_json::from_slice(body).map_err(|error| {
                ApiError::query_contract(QueryError::new(
                    QueryCode::InvalidRequest,
                    "request",
                    error.to_string(),
                ))
            })?;
            if envelope.reason.is_none() {
                return Err(ApiError::query_contract(original));
            }
            let bytes = serde_json::to_vec(&envelope.query)
                .map_err(|error| ApiError::internal(&error.to_string()))?;
            Ok((
                preflight_public_request_json(&bytes).map_err(ApiError::query_contract)?,
                envelope.reason,
            ))
        }
    }
}
pub(super) fn enforce_metadata_projection(prepared: &PreparedQuery) -> Result<(), ApiError> {
    if prepared.plan().projection.columns.iter().any(|column|!matches!(&column.expression,Expression::Property{property} if matches!(property.name.as_str(),"title"|"kind"|"state"|"icon"))) {
        return Err(ApiError::invalid("Instruction retrieval contract 2 search returns only direct title, kind, state, or icon properties. Retrieve selected instruction bodies through the reasoned retrieve endpoint."));
    }
    Ok(())
}
pub(super) fn search_receipt(result: &mut Value, reason: Option<RetrievalReason>) {
    if let Some(reason) = reason {
        result["instructionSearchReceipt"] = serde_json::json!({"reason":reason});
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use relayer_graph_core::{
        GraphDatabase, InstructionGraphDefinition, InstructionGraphManifest,
        InstructionModuleDefinition, ThreadId,
    };
    use sha2::{Digest, Sha256};
    use tower::ServiceExt;
    async fn fixture(details: Vec<String>) -> (ServerState, String, InstructionGraphManifest) {
        let graph = GraphDatabase::in_memory().await.unwrap();
        let modules = details
            .into_iter()
            .enumerate()
            .map(|(i, detail)| InstructionModuleDefinition {
                key: format!("chunk-{i}"),
                title: format!("Chunk {i}"),
                detail,
                prerequisites: vec![],
            })
            .collect::<Vec<_>>();
        let definition = InstructionGraphDefinition {
            retrieval_contract_version: 2,
            digest: format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&modules).unwrap())
            ),
            modules,
        };
        let manifest = graph
            .ensure_instruction_graph("v2", definition)
            .await
            .unwrap();
        let task = graph
            .create_interaction(None, ThreadId::new(1).unwrap(), "Task")
            .await
            .unwrap();
        graph
            .attach_instruction_graph(task.id, "v2", &manifest.digest)
            .await
            .unwrap();
        let state = ServerState::new(graph, "control");
        let token = crate::mint_capability(&state, task.id, None)
            .await
            .unwrap_or_else(|e| panic!("{}", e.1));
        (state, token, manifest)
    }
    async fn call(
        app: &Router,
        method: &str,
        path: &str,
        token: &str,
        body: Value,
    ) -> (StatusCode, Value) {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| serde_json::json!({"message":String::from_utf8_lossy(&bytes)})),
        )
    }
    fn request(key: &str, ids: &[NodeId]) -> Value {
        serde_json::json!({"requestKey":key,"nodeIds":ids,"reason":{"purpose":"authoring","detail":"Need the exact public authoring API."}})
    }
    #[tokio::test]
    async fn retrieval_v2_epoch_dedup_replay_explicit_reread_and_legacy_body_denial() {
        let (state, token, manifest) =
            fixture(vec!["é".repeat(10), "Second small chunk".into()]).await;
        let app = crate::router(state.clone());
        let first = manifest.modules[0].node_id;
        let second = manifest.modules[1].node_id;
        let (status, index) = call(
            &app,
            "GET",
            "/api/graph/instruction-graph",
            &token,
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(index["retrievalContractVersion"], 2);
        assert!(!index.to_string().contains("é"));
        for path in [
            format!("/api/graph/instruction-graph/nodes/{first}"),
            format!(
                "/api/graph/instruction-graph/layers/{}",
                manifest.root_layer_id
            ),
        ] {
            assert_eq!(
                call(&app, "GET", &path, &token, Value::Null).await.0,
                StatusCode::UNPROCESSABLE_ENTITY
            );
        }
        let mut missing = request("first", &[first]);
        missing.as_object_mut().unwrap().remove("reason");
        assert_eq!(
            call(
                &app,
                "POST",
                "/api/graph/instruction-graph/retrieve",
                &token,
                missing
            )
            .await
            .0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
        let mut invalid = request("first", &[first]);
        invalid["reason"]["detail"] = Value::String("short".into());
        assert_eq!(
            call(
                &app,
                "POST",
                "/api/graph/instruction-graph/retrieve",
                &token,
                invalid
            )
            .await
            .0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
        let first_request = request("first", &[first]);
        let (status, body) = call(
            &app,
            "POST",
            "/api/graph/instruction-graph/retrieve",
            &token,
            first_request.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["entries"][0]["delivery"], "body");
        assert_eq!(body["entries"][0]["bodyCharacters"], 10);
        assert_eq!(body["entries"][0]["bodyBytes"], 20);
        let (_, duplicate) = call(
            &app,
            "POST",
            "/api/graph/instruction-graph/retrieve",
            &token,
            request("other-program", &[first]),
        )
        .await;
        assert_eq!(duplicate["entries"][0]["delivery"], "already-returned");
        assert_eq!(duplicate["entries"][0]["bodyCharacters"], 0);
        assert_eq!(duplicate["entries"][0]["bodyBytes"], 0);
        assert!(duplicate["entries"][0].get("detail").is_none());
        assert_eq!(duplicate["entries"][0]["firstRequestKey"], "first");
        let (_, replay) = call(
            &app,
            "POST",
            "/api/graph/instruction-graph/retrieve",
            &token,
            first_request.clone(),
        )
        .await;
        assert_eq!(replay["replayed"], true);
        assert_eq!(replay["entries"][0]["detail"], body["entries"][0]["detail"]);
        assert_eq!(
            call(
                &app,
                "POST",
                "/api/graph/instruction-graph/retrieve",
                &token,
                request("first", &[second])
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        let left = request("native-helper-a", &[second]);
        let right = request("native-helper-b", &[second]);
        let (a, b) = tokio::join!(
            call(
                &app,
                "POST",
                "/api/graph/instruction-graph/retrieve",
                &token,
                left
            ),
            call(
                &app,
                "POST",
                "/api/graph/instruction-graph/retrieve",
                &token,
                right
            )
        );
        assert_eq!(a.0, StatusCode::OK);
        assert_eq!(b.0, StatusCode::OK);
        assert_eq!(
            [a.1, b.1]
                .iter()
                .filter(|response| response["entries"][0]["delivery"] == "body")
                .count(),
            1
        );
        let mut recovery = request("recovery", &[first]);
        recovery["rereadReason"] =
            Value::String("The native helper did not receive the prior body.".into());
        let (_, body) = call(
            &app,
            "POST",
            "/api/graph/instruction-graph/retrieve",
            &token,
            recovery,
        )
        .await;
        assert_eq!(body["entries"][0]["delivery"], "reread");
        assert_eq!(body["entries"][0]["bodyBytes"], 20);
        let authority = state.sessions.lock().unwrap().get(&token).copied().unwrap();
        state
            .graph
            .cutover_completion_authority(authority.node_id)
            .await
            .unwrap();
        assert_eq!(
            call(
                &app,
                "POST",
                "/api/graph/instruction-graph/retrieve",
                &token,
                first_request.clone()
            )
            .await
            .0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
        let renewed = crate::mint_capability(&state, authority.node_id, None)
            .await
            .unwrap_or_else(|e| panic!("{}", e.1));
        let (status, fresh) = call(
            &app,
            "POST",
            "/api/graph/instruction-graph/retrieve",
            &renewed,
            first_request,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(fresh["replayed"], false);
        assert_eq!(fresh["entries"][0]["delivery"], "body");
        // A request suspended after validating an older epoch must never evict
        // the new generation's issuance state when it eventually resumes.
        let _late_old_scope = state
            .instruction_retrievals
            .scope(authority.node_id, authority.epoch, &manifest.digest)
            .unwrap_or_else(|error| panic!("{}", error.1));
        let (_, retained) = call(
            &app,
            "POST",
            "/api/graph/instruction-graph/retrieve",
            &renewed,
            request("new-program", &[first]),
        )
        .await;
        assert_eq!(retained["entries"][0]["delivery"], "already-returned");
    }
    #[tokio::test]
    async fn retrieval_v2_failed_batches_do_not_consume_body_or_request_keys() {
        let (state, token, manifest) = fixture(vec!["x".repeat(2400); 4]).await;
        let app = crate::router(state.clone());
        let ids = manifest
            .modules
            .iter()
            .map(|m| m.node_id)
            .collect::<Vec<_>>();
        assert_eq!(
            call(
                &app,
                "POST",
                "/api/graph/instruction-graph/retrieve",
                &token,
                request("batch", &ids)
            )
            .await
            .0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
        let (status, first) = call(
            &app,
            "POST",
            "/api/graph/instruction-graph/retrieve",
            &token,
            request("batch", &ids[..3]),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            first["entries"]
                .as_array()
                .unwrap()
                .iter()
                .all(|e| e["delivery"] == "body")
        );
        let (_, remaining) = call(
            &app,
            "POST",
            "/api/graph/instruction-graph/retrieve",
            &token,
            request("rest", &ids),
        )
        .await;
        assert_eq!(
            remaining["entries"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|e| e["delivery"] == "body")
                .count(),
            1
        );
        let foreign = state
            .graph
            .create_interaction(None, ThreadId::new(2).unwrap(), "Foreign")
            .await
            .unwrap();
        assert_eq!(
            call(
                &app,
                "POST",
                "/api/graph/instruction-graph/retrieve",
                &token,
                request("mixed", &[ids[0], foreign.id])
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        let mut justified = request("too-much-reread", &ids);
        justified["rereadReason"] =
            Value::String("Recheck the exact APIs after losing tool output.".into());
        assert_eq!(
            call(
                &app,
                "POST",
                "/api/graph/instruction-graph/retrieve",
                &token,
                justified
            )
            .await
            .0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
        let (_, still_seen) = call(
            &app,
            "POST",
            "/api/graph/instruction-graph/retrieve",
            &token,
            request("still-seen", &ids[..1]),
        )
        .await;
        assert_eq!(still_seen["entries"][0]["delivery"], "already-returned");
    }
    #[test]
    fn reasoned_search_preserves_duplicate_field_and_parameter_rejection() {
        let valid=br#"{"queryContractVersion":1,"query":"MATCH (n:Content) RETURN n.title AS title","reason":{"purpose":"search","detail":"Find the relevant authoring topic."}}"#;
        assert!(search_preflight(valid).is_ok());
        assert!(
            validate_summary(
                &format!("{}Check the exact signature.", " ".repeat(240)),
                "reason.detail"
            )
            .is_err()
        );

        for body in [
            r#"{"queryContractVersion":1,"query":"MATCH (n:Content) RETURN n.title","query":"MATCH (n:Content) RETURN n.detail","reason":{"purpose":"search","detail":"Find the relevant authoring topic."}}"#,
            r#"{"queryContractVersion":1,"query":"MATCH (n:Content) WHERE n.title=$x RETURN n.title","parameters":{"x":{"type":"string","value":"A"},"x":{"type":"string","value":"B"}},"reason":{"purpose":"search","detail":"Find the relevant authoring topic."}}"#,
            r#"{"queryContractVersion":1,"query":"MATCH (n:Content) RETURN n.title","reason":{"purpose":"search","detail":"Find the relevant authoring topic."},"reason":{"purpose":"repair","detail":"Overwrite the retrieval purpose."}}"#,
            r#"{"queryContractVersion":1,"query":"MATCH (n:Content) RETURN n.title","database":"foreign","reason":{"purpose":"search","detail":"Find the relevant authoring topic."}}"#,
        ] {
            assert!(search_preflight(body.as_bytes()).is_err(), "{body}");
        }
        for query in [
            "MATCH (n:Content) RETURN n",
            "MATCH (n:Content) RETURN n.detail",
            "MATCH (n:Content) RETURN {body:n.detail} AS result",
            "MATCH (n:Content) RETURN collect(n) AS result",
            "MATCH (n:Content) RETURN [n.detail] AS result",
        ] {
            let prepared=relayer_graph_core::query::prepare_request_json(serde_json::json!({"queryContractVersion":1,"target":{"scope":"thread","id":1},"query":query}).to_string().as_bytes()).unwrap();
            assert!(enforce_metadata_projection(&prepared).is_err(), "{query}");
        }
        let prepared=relayer_graph_core::query::prepare_request_json(br#"{"queryContractVersion":1,"target":{"scope":"thread","id":1},"query":"MATCH (n:Content) RETURN n.title AS title, n.kind AS kind"}"#).unwrap();
        assert!(enforce_metadata_projection(&prepared).is_ok());
    }
}
