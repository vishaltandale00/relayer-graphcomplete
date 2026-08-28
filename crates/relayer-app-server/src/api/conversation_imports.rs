use axum::{Json, body::Body, extract::State, http::HeaderMap};
use http_body_util::BodyExt;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::{ApiState, auth::authorize_write, error::ApiError};
use crate::{
    conversation_export::{ConversationExportRecord, decode_export_record_line},
    conversation_import_service::ConversationImportStager,
};

pub(super) async fn import(
    State(state): State<ApiState>,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<crate::conversation_import_service::ConversationImportReceipt>, ApiError> {
    authorize_write(&state, &headers)?;
    if !state.allow_conversation_import {
        return Err(ApiError::forbidden(
            "conversation import is available only in Relayer Eval",
        ));
    }
    Ok(Json(stage_jsonl(body, &state.product).await?))
}

async fn stage_jsonl(
    mut body: Body,
    product: &crate::product::ProductService,
) -> Result<crate::conversation_import_service::ConversationImportReceipt, ApiError> {
    let mut total = 0usize;
    let mut line_number = 0usize;
    let mut pending = Vec::new();
    let mut digest = Sha256::new();
    let mut stager = None;
    while let Some(frame) = body.frame().await {
        let frame = match frame {
            Ok(frame) => frame,
            Err(error) => {
                return Err(abort_or_invalid(
                    stager.as_ref(),
                    format!("could not read conversation import: {error}"),
                    product,
                )
                .await);
            }
        };
        let Ok(data) = frame.into_data() else {
            continue;
        };
        total = match checked_total_bytes(total, data.len()) {
            Ok(total) => total,
            Err(error) => {
                return Err(abort_or_invalid(stager.as_ref(), error, product).await);
            }
        };
        digest.update(&data);
        let mut remaining = data.as_ref();
        while let Some(index) = remaining.iter().position(|byte| *byte == b'\n') {
            if let Err(error) = append_line_bytes(&mut pending, &remaining[..index]) {
                return Err(abort_or_invalid(stager.as_ref(), error, product).await);
            }
            line_number += 1;
            if pending.last() == Some(&b'\r') {
                pending.pop();
            }
            if let Err(error) = process_line(&pending, line_number, &mut stager, product).await {
                return Err(abort_or_invalid(stager.as_ref(), error, product).await);
            }
            pending.clear();
            remaining = &remaining[index + 1..];
        }
        if let Err(error) = append_line_bytes(&mut pending, remaining) {
            return Err(abort_or_invalid(stager.as_ref(), error, product).await);
        }
    }
    if !pending.is_empty() {
        if pending.last() == Some(&b'\r') {
            pending.pop();
        }
        line_number += 1;
        if let Err(error) = process_line(&pending, line_number, &mut stager, product).await {
            return Err(abort_or_invalid(stager.as_ref(), error, product).await);
        }
    } else if line_number == 0 {
        return Err(ApiError::invalid(
            decode_export_record_line(&[], 1).unwrap_err().to_string(),
        ));
    }
    let Some(mut stager) = stager else {
        return Err(ApiError::invalid("conversation export header is missing"));
    };
    let source_sha256 = format!("sha256:{:x}", digest.finalize());
    match stager.finish(source_sha256, product).await {
        Ok(receipt) => Ok(receipt),
        Err(error) => {
            let cleanup = stager.abort(error.to_string(), product).await;
            Err(cleanup.into())
        }
    }
}

fn checked_total_bytes(total: usize, frame_len: usize) -> Result<usize, String> {
    let next = total
        .checked_add(frame_len)
        .ok_or_else(|| "conversation import is too large".to_owned())?;
    if next > crate::conversation_export::MAX_EXPORT_BYTES {
        return Err("conversation export exceeds the V1 file limit".into());
    }
    Ok(next)
}

fn append_line_bytes(pending: &mut Vec<u8>, bytes: &[u8]) -> Result<(), String> {
    if pending.len().saturating_add(bytes.len()) > crate::conversation_export::MAX_JSONL_LINE_BYTES
    {
        return Err("conversation export line exceeds the V1 line limit".into());
    }
    pending.extend_from_slice(bytes);
    Ok(())
}

async fn process_line(
    line: &[u8],
    line_number: usize,
    stager: &mut Option<ConversationImportStager>,
    product: &crate::product::ProductService,
) -> Result<(), String> {
    let record = decode_export_record_line(line, line_number).map_err(|error| error.to_string())?;
    match (stager.as_mut(), record) {
        (None, ConversationExportRecord::Header(header)) => {
            *stager = Some(
                ConversationImportStager::begin(*header, product)
                    .await
                    .map_err(|error| error.to_string())?,
            );
            Ok(())
        }
        (None, ConversationExportRecord::Turn(_)) => {
            Err("the first JSONL record must be the single header".into())
        }
        (Some(_), ConversationExportRecord::Header(_)) => {
            Err("only the first JSONL record may be a header".into())
        }
        (Some(stager), ConversationExportRecord::Turn(turn)) => stager
            .push_turn(&turn, product)
            .await
            .map_err(|error| error.to_string()),
    }
}

async fn abort_or_invalid(
    stager: Option<&ConversationImportStager>,
    operation: String,
    product: &crate::product::ProductService,
) -> ApiError {
    match stager {
        Some(stager) => stager.abort(operation, product).await.into(),
        None => ApiError::invalid(operation),
    }
}

pub(super) async fn list(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize_write(&state, &headers)?;
    if !state.allow_conversation_import {
        return Err(ApiError::forbidden(
            "conversation import is available only in Relayer Eval",
        ));
    }
    let records = state.product.list_published_conversation_imports().await?;
    Ok(Json(
        serde_json::json!({"imports": records.into_iter().map(|record| serde_json::json!({
        "importId": record.id, "sourceSha256": record.source_sha256,
        "header": record.header, "threadId": record.thread_id.value(),
        "turns": record.turns.into_iter().map(|(source_turn_id, interaction_id, graph_node_id, completion_status)| serde_json::json!({
            "sourceTurnId": source_turn_id, "interactionId": interaction_id.value(), "graphNodeId": graph_node_id, "completionStatus": completion_status,
        })).collect::<Vec<_>>()
    })).collect::<Vec<_>>()}),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ImportIdentity {
    import_id: String,
}

pub(super) async fn publish(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(input): Json<ImportIdentity>,
) -> Result<Json<crate::conversation_import_service::ConversationImportReceipt>, ApiError> {
    authorize_write(&state, &headers)?;
    if !state.allow_conversation_import {
        return Err(ApiError::forbidden(
            "conversation import is available only in Relayer Eval",
        ));
    }
    let runtime = state
        .runtime
        .as_ref()
        .ok_or_else(|| ApiError::invalid("GraphComplete runtime is unavailable"))?;
    Ok(Json(
        crate::conversation_import_service::materialize_and_publish_conversation(
            &input.import_id,
            &state.product,
            runtime,
        )
        .await?,
    ))
}

pub(super) async fn remove(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(input): Json<ImportIdentity>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize_write(&state, &headers)?;
    if !state.allow_conversation_import {
        return Err(ApiError::forbidden(
            "conversation import is available only in Relayer Eval",
        ));
    }
    let runtime = state
        .runtime
        .as_ref()
        .ok_or_else(|| ApiError::invalid("GraphComplete runtime is unavailable"))?;
    crate::conversation_import_service::remove_conversation(
        &input.import_id,
        &state.product,
        runtime,
    )
    .await?;
    Ok(Json(serde_json::json!({"removed": true})))
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

    use axum::{
        Router,
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use sha2::{Digest, Sha256};
    use tower::ServiceExt;

    use super::{append_line_bytes, checked_total_bytes, stage_jsonl};
    use crate::{
        conversation_export::{
            ConversationExportHeader, ConversationExportRecord, ConversationExportTurn,
            EXPORT_VERSION_V1, ExportAcceptedView, ExportAction, ExportActionKind,
            ExportActionVariant, ExportAdmittedExecutionModelPlan,
            ExportAdmittedExecutionModelRoute, ExportCompletionReceipt, ExportCompletionStatus,
            ExportContextSource, ExportContextTargetSnapshot, ExportConversation,
            ExportInputActionSnapshot, ExportInputControl, ExportInputOption, ExportInputSource,
            ExportInteractionContext, ExportLayer, ExportModelSelection, ExportNavigateRelation,
            ExportNode, ExportProducer, ExportRecordState, ExportResolvedLayer,
            ExportSubmittedInput, ExportSubmittedInputValue, ExportTurnManifestEntry,
            ExportTurnOrigin, MAX_EXPORT_BYTES, MAX_JSONL_LINE_BYTES, admitted_model_plan_digest,
            decode_export_jsonl,
        },
        product::ProductService,
        runtime::RuntimeClient,
        storage::SqliteProductStore,
    };

    fn records(text: String) -> Vec<ConversationExportRecord> {
        vec![
            ConversationExportRecord::Header(Box::new(ConversationExportHeader {
                export_version: EXPORT_VERSION_V1,
                exported_at: "1770000000000".into(),
                producer: ExportProducer {
                    desktop_version: "0.2.12".into(),
                    build_commit: "test-commit".into(),
                    platform: "darwin".into(),
                    architecture: "arm64".into(),
                },
                conversation: ExportConversation {
                    id: "conversation:streaming".into(),
                    title: "Large import".into(),
                    created_at: "1769000000000".into(),
                    project_name: None,
                    harness_configuration_name: "codex-basic".into(),
                    permission_profile_id: "auto".into(),
                },
                turns: vec![ExportTurnManifestEntry {
                    id: "turn:1".into(),
                    sequence: 1,
                }],
            })),
            ConversationExportRecord::Turn(Box::new(ConversationExportTurn {
                id: "turn:1".into(),
                sequence: 1,
                created_at: "1769000001000".into(),
                text,
                interaction_node_id: None,
                origin: ExportTurnOrigin::User,
                completion: ExportCompletionReceipt {
                    status: ExportCompletionStatus::NotStarted,
                    harness_configuration_name: None,
                    harness_configuration_digest: None,
                    model_selection: None,
                    permission_profile_id: "auto".into(),
                    effective_execution_digest: None,
                    effective_permission_receipt: None,
                    error: None,
                    attempt_admission_id: None,
                    admitted_model_plan: None,
                },
                contexts: vec![],
                submitted_inputs: vec![],
                accepted_view: None,
            })),
        ]
    }

    fn jsonl(records: &[ConversationExportRecord]) -> Vec<u8> {
        let mut bytes = Vec::new();
        for record in records {
            serde_json::to_writer(&mut bytes, record).unwrap();
            bytes.push(b'\n');
        }
        bytes
    }

    fn accepted_receipt() -> ExportCompletionReceipt {
        let route = ExportAdmittedExecutionModelRoute {
            provider_id: "codex".into(),
            adapter_id: "codex-subscription".into(),
            access_contract: "managed-runtime@1".into(),
            model_id: "gpt-test".into(),
            adapter_implementation_version: "7".into(),
        };
        let mut admitted_plan = ExportAdmittedExecutionModelPlan {
            family_id: 1,
            family_revision: 4,
            orchestrator: route.clone(),
            roster: vec![route],
            harness_policy_digest: format!("sha256:{}", "c".repeat(64)),
            digest: String::new(),
        };
        admitted_plan.digest = admitted_model_plan_digest(&admitted_plan).unwrap();
        ExportCompletionReceipt {
            status: ExportCompletionStatus::Accepted,
            harness_configuration_name: Some("codex-basic".into()),
            harness_configuration_digest: None,
            model_selection: Some(ExportModelSelection {
                provider_id: "codex".into(),
                model_id: "gpt-test".into(),
                model_family_id: 1,
            }),
            permission_profile_id: "auto".into(),
            effective_execution_digest: None,
            effective_permission_receipt: None,
            error: None,
            attempt_admission_id: Some("admission-imported".into()),
            admitted_model_plan: Some(admitted_plan),
        }
    }

    fn export_action(
        id: &str,
        source_node_id: &str,
        source_layer_id: Option<&str>,
        kind: ExportActionKind,
        target_layer_id: Option<&str>,
    ) -> ExportAction {
        ExportAction {
            id: id.into(),
            source_node_id: source_node_id.into(),
            source_layer_id: source_layer_id.map(Into::into),
            kind,
            relation: (kind == ExportActionKind::Navigate)
                .then_some(ExportNavigateRelation::Expand),
            label: if kind == ExportActionKind::Invoke {
                "Continue"
            } else {
                "Response"
            }
            .into(),
            variant: ExportActionVariant::Pill,
            icon: None,
            description: None,
            target_layer_id: target_layer_id.map(Into::into),
            interaction_text: (kind == ExportActionKind::Invoke)
                .then_some("Continue this path".into()),
            state: ExportRecordState::Accepted,
        }
    }

    fn export_layer(
        layer_id: &str,
        node_id: &str,
        title: &str,
        actions: Vec<ExportAction>,
    ) -> ExportResolvedLayer {
        ExportResolvedLayer {
            layer: ExportLayer {
                id: layer_id.into(),
                nodes: vec![node_id.into()],
                edges: vec![],
                layout: None,
                state: ExportRecordState::Accepted,
            },
            nodes: vec![ExportNode {
                id: node_id.into(),
                kind: "concept".into(),
                icon: "file".into(),
                title: title.into(),
                detail: format!("Accepted detail for {title}"),
                state: ExportRecordState::Accepted,
            }],
            edges: vec![],
            actions,
        }
    }

    fn resolved_invoke_records() -> Vec<ConversationExportRecord> {
        let source_layer_id = "layer:source";
        let destination_layer_id = "layer:destination";
        let invoke = export_action(
            "action:invoke",
            "node:source",
            Some(source_layer_id),
            ExportActionKind::Invoke,
            None,
        );
        vec![
            ConversationExportRecord::Header(Box::new(ConversationExportHeader {
                export_version: EXPORT_VERSION_V1,
                exported_at: "1770000000000".into(),
                producer: ExportProducer {
                    desktop_version: "0.2.12".into(),
                    build_commit: "test-commit".into(),
                    platform: "darwin".into(),
                    architecture: "arm64".into(),
                },
                conversation: ExportConversation {
                    id: "conversation:resolved-invoke".into(),
                    title: "Resolved invoke import".into(),
                    created_at: "1769000000000".into(),
                    project_name: None,
                    harness_configuration_name: "codex-basic".into(),
                    permission_profile_id: "auto".into(),
                },
                turns: vec![
                    ExportTurnManifestEntry {
                        id: "turn:1".into(),
                        sequence: 1,
                    },
                    ExportTurnManifestEntry {
                        id: "turn:2".into(),
                        sequence: 2,
                    },
                ],
            })),
            ConversationExportRecord::Turn(Box::new(ConversationExportTurn {
                id: "turn:1".into(),
                sequence: 1,
                created_at: "1769000001000".into(),
                text: "Choose a path".into(),
                interaction_node_id: None,
                origin: ExportTurnOrigin::User,
                completion: accepted_receipt(),
                contexts: vec![],
                submitted_inputs: vec![],
                accepted_view: Some(ExportAcceptedView {
                    interaction_node_id: "node:interaction-1".into(),
                    root_action: export_action(
                        "action:root-1",
                        "node:interaction-1",
                        None,
                        ExportActionKind::Navigate,
                        Some(source_layer_id),
                    ),
                    root_layer_id: source_layer_id.into(),
                    layers: vec![export_layer(
                        source_layer_id,
                        "node:source",
                        "Source",
                        vec![invoke],
                    )],
                }),
            })),
            ConversationExportRecord::Turn(Box::new(ConversationExportTurn {
                id: "turn:2".into(),
                sequence: 2,
                created_at: "1769000002000".into(),
                text: "Continue this path".into(),
                interaction_node_id: None,
                origin: ExportTurnOrigin::Action {
                    source_turn_id: "turn:1".into(),
                    source_action_id: "action:invoke".into(),
                },
                completion: accepted_receipt(),
                contexts: vec![],
                submitted_inputs: vec![],
                accepted_view: Some(ExportAcceptedView {
                    interaction_node_id: "node:interaction-2".into(),
                    root_action: export_action(
                        "action:root-2",
                        "node:interaction-2",
                        None,
                        ExportActionKind::Navigate,
                        Some(destination_layer_id),
                    ),
                    root_layer_id: destination_layer_id.into(),
                    layers: vec![export_layer(
                        destination_layer_id,
                        "node:destination",
                        "Destination",
                        vec![],
                    )],
                }),
            })),
        ]
    }

    async fn product() -> (tempfile::TempDir, ProductService) {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteProductStore::open(directory.path().join("product.sqlite"))
            .await
            .unwrap();
        (directory, ProductService::new(store, true))
    }

    async fn runtime(
        graph: relayer_graph_core::GraphDatabase,
        root: &Path,
    ) -> (RuntimeClient, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                relayer_graph_server::router(relayer_graph_server::ServerState::new(
                    graph,
                    "graph-control",
                )),
            )
            .await
            .unwrap();
        });
        let catalog = root.join("router-catalog.json");
        fs::write(
            &catalog,
            serde_json::json!({
                "schemaVersion": 1,
                "configurations": [{
                    "configuration": {
                        "schemaVersion": 1,
                        "name": "codex-basic",
                        "implementation": "test",
                        "implementationVersion": 1,
                        "permissionBindings": { "auto": {} },
                        "settings": {}
                    },
                    "digest": "sha256:test"
                }]
            })
            .to_string(),
        )
        .unwrap();
        let runtime = RuntimeClient::open(
            &format!("http://{address}/"),
            "http://127.0.0.1:9/",
            "graph-control".into(),
            "harness-control".into(),
            &catalog,
        )
        .await
        .unwrap();
        (runtime, task)
    }

    async fn app(
        allow_conversation_import: bool,
    ) -> (
        tempfile::TempDir,
        Router,
        SqliteProductStore,
        tokio::task::JoinHandle<()>,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteProductStore::open(directory.path().join("router-product.sqlite"))
            .await
            .unwrap();
        let product = ProductService::new(store.clone(), true);
        let (runtime, graph_task) = runtime(
            relayer_graph_core::GraphDatabase::in_memory()
                .await
                .unwrap(),
            directory.path(),
        )
        .await;
        let permission_catalog = crate::permissions::PermissionCatalog::load(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../permissions/desktop.json"),
        )
        .await
        .unwrap();
        let router = crate::api::router(
            product,
            ("write-token".into(), Some("read-token".into())),
            directory.path().to_path_buf(),
            crate::api::ApiRuntime {
                execution_lease_reconciler: None,
                runtime: Some(runtime),
                permission_catalog,
                default_harness_configuration: "codex-basic".into(),
                allow_harness_override: true,
                allow_conversation_import,
                standalone_workspaces_directory: directory.path().join("workspaces"),
                export_producer: ExportProducer {
                    desktop_version: "0.2.12".into(),
                    build_commit: "test-commit".into(),
                    platform: "darwin".into(),
                    architecture: "arm64".into(),
                },
            },
        );
        (directory, router, store, graph_task)
    }

    fn request(method: &str, cookie: &str, body: impl Into<Body>) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri("/api/internal/conversation-imports")
            .header("content-type", "application/json")
            .header("cookie", format!("relayer_control={cookie}"))
            .body(body.into())
            .unwrap()
    }

    fn request_uri(method: &str, uri: &str, cookie: &str, body: impl Into<Body>) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .header("cookie", format!("relayer_control={cookie}"))
            .body(body.into())
            .unwrap()
    }

    async fn response_json(response: axum::response::Response) -> serde_json::Value {
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
    }

    #[tokio::test]
    async fn stages_valid_jsonl_larger_than_axums_default_body_limit() {
        let (_directory, product) = product().await;
        let bytes = jsonl(&records("x".repeat(2 * 1024 * 1024 + 1)));
        let expected_digest = format!("sha256:{:x}", Sha256::digest(&bytes));
        let receipt = match stage_jsonl(Body::from(bytes), &product).await {
            Ok(receipt) => receipt,
            Err(_) => panic!("valid framed JSONL import should stage"),
        };

        assert_eq!(receipt.source_sha256, expected_digest);
        assert_eq!(receipt.turns.len(), 1);
        assert!(
            product
                .list_published_conversation_imports()
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            product
                .staged_conversation_turn(&receipt.import_id, "turn:1")
                .await
                .unwrap()
                .text
                .len(),
            2 * 1024 * 1024 + 1
        );
    }

    #[test]
    fn streaming_bounds_reject_over_limit_lengths_without_file_sized_buffering() {
        assert_eq!(
            checked_total_bytes(MAX_EXPORT_BYTES, 0).unwrap(),
            MAX_EXPORT_BYTES
        );
        assert!(checked_total_bytes(MAX_EXPORT_BYTES, 1).is_err());
        assert!(checked_total_bytes(usize::MAX, 1).is_err());

        let mut pending = vec![b'x'; MAX_JSONL_LINE_BYTES];
        assert!(append_line_bytes(&mut pending, b"x").is_err());
        assert_eq!(pending.len(), MAX_JSONL_LINE_BYTES);
    }

    #[tokio::test]
    async fn import_router_enforces_write_cookie_and_feature_gate_for_every_verb() {
        let (_directory, enabled, _store, enabled_graph) = app(true).await;
        let body = jsonl(&records("router fixture".into()));

        for method in ["GET", "POST", "PUT", "DELETE"] {
            let denied = enabled
                .clone()
                .oneshot(request(
                    method,
                    "read-token",
                    if method == "POST" {
                        Body::from(body.clone())
                    } else {
                        Body::from(r#"{"importId":"missing"}"#)
                    },
                ))
                .await
                .unwrap();
            assert_eq!(denied.status(), StatusCode::FORBIDDEN, "{method}");
            assert_eq!(response_json(denied).await["code"], "read_only_session");
        }

        let listed = enabled
            .clone()
            .oneshot(request("GET", "write-token", Body::empty()))
            .await
            .unwrap();
        assert_eq!(listed.status(), StatusCode::OK);
        let staged = enabled
            .clone()
            .oneshot(request("POST", "write-token", Body::from(body.clone())))
            .await
            .unwrap();
        assert_eq!(staged.status(), StatusCode::OK);
        let staged = response_json(staged).await;
        let import_id = staged["importId"].as_str().unwrap();
        let published = enabled
            .clone()
            .oneshot(request(
                "PUT",
                "write-token",
                Body::from(serde_json::json!({"importId": import_id}).to_string()),
            ))
            .await
            .unwrap();
        assert_eq!(published.status(), StatusCode::OK);

        let cancel_stage = enabled
            .clone()
            .oneshot(request("POST", "write-token", Body::from(body)))
            .await
            .unwrap();
        assert_eq!(cancel_stage.status(), StatusCode::OK);
        let cancel_stage = response_json(cancel_stage).await;
        let canceled = enabled
            .oneshot(request(
                "DELETE",
                "write-token",
                Body::from(serde_json::json!({"importId": cancel_stage["importId"]}).to_string()),
            ))
            .await
            .unwrap();
        assert_eq!(canceled.status(), StatusCode::OK);
        enabled_graph.abort();

        let (_directory, disabled, _store, disabled_graph) = app(false).await;
        for method in ["GET", "POST", "PUT", "DELETE"] {
            let response = disabled
                .clone()
                .oneshot(request(
                    method,
                    "write-token",
                    if method == "POST" {
                        Body::from(jsonl(&records("disabled".into())))
                    } else {
                        Body::from(r#"{"importId":"missing"}"#)
                    },
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{method}");
            assert_eq!(response_json(response).await["code"], "forbidden");
        }
        disabled_graph.abort();
    }

    #[tokio::test]
    async fn export_shape_imports_as_resolved_read_only_invoke_destination() {
        let records = resolved_invoke_records();
        let ConversationExportRecord::Turn(source_turn) = &records[1] else {
            unreachable!()
        };
        let authored_invoke = &source_turn.accepted_view.as_ref().unwrap().layers[0].actions[0];
        assert_eq!(authored_invoke.kind, ExportActionKind::Invoke);
        assert!(authored_invoke.target_layer_id.is_none());

        let (_directory, app, _store, graph_task) = app(true).await;
        let staged = app
            .clone()
            .oneshot(request("POST", "write-token", Body::from(jsonl(&records))))
            .await
            .unwrap();
        assert_eq!(staged.status(), StatusCode::OK);
        let staged = response_json(staged).await;
        let published = app
            .clone()
            .oneshot(request(
                "PUT",
                "write-token",
                Body::from(serde_json::json!({"importId": staged["importId"]}).to_string()),
            ))
            .await
            .unwrap();
        assert_eq!(published.status(), StatusCode::OK);
        let published = response_json(published).await;
        let thread_id = published["threadId"].as_i64().unwrap();
        let source_interaction_id = published["turns"][0]["interactionId"].as_i64().unwrap();
        let destination_interaction_id = published["turns"][1]["interactionId"].as_i64().unwrap();
        let destination_root_layer_id = published["turns"][1]["rootLayerId"].as_i64().unwrap();

        let thread = app
            .clone()
            .oneshot(request_uri(
                "GET",
                &format!("/api/threads/{thread_id}"),
                "read-token",
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(thread.status(), StatusCode::OK);
        let thread = response_json(thread).await;
        let invoke = thread["interactions"][0]["completionOutput"]["rootLayer"]["actions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|action| action["kind"] == "invoke")
            .unwrap();
        let action_id = invoke["id"].as_i64().unwrap();
        assert_eq!(
            invoke["targetLayerId"].as_i64(),
            Some(destination_root_layer_id)
        );

        let destination = app
            .clone()
            .oneshot(request_uri(
                "GET",
                &format!(
                    "/api/threads/{thread_id}/interactions/{source_interaction_id}/actions/{action_id}/destination"
                ),
                "read-token",
                Body::empty(),
            ))
            .await
            .unwrap();
        if destination.status() != StatusCode::OK {
            panic!(
                "destination response: {}",
                String::from_utf8_lossy(
                    &axum::body::to_bytes(destination.into_body(), usize::MAX)
                        .await
                        .unwrap()
                )
            );
        }
        let destination = response_json(destination).await;
        assert_eq!(destination["interactionId"], destination_interaction_id);
        assert_eq!(destination["rootLayerId"], destination_root_layer_id);
        assert_eq!(destination["targetLayerId"], destination_root_layer_id);

        let reexported = app
            .clone()
            .oneshot(request_uri(
                "GET",
                &format!("/api/threads/{thread_id}/export"),
                "write-token",
                Body::empty(),
            ))
            .await
            .unwrap();
        if reexported.status() != StatusCode::OK {
            panic!("re-export failed: {}", response_json(reexported).await);
        }
        let reexported_bytes = to_bytes(reexported.into_body(), MAX_EXPORT_BYTES)
            .await
            .unwrap();
        let reexported_records = decode_export_jsonl(&reexported_bytes).unwrap();
        let ConversationExportRecord::Turn(reexported_source) = &reexported_records[1] else {
            unreachable!()
        };
        let reexported_invoke = reexported_source
            .accepted_view
            .as_ref()
            .unwrap()
            .layers
            .iter()
            .flat_map(|layer| &layer.actions)
            .find(|action| action.kind == ExportActionKind::Invoke)
            .unwrap();
        let ConversationExportRecord::Turn(reexported_destination) = &reexported_records[2] else {
            unreachable!()
        };
        assert_eq!(
            reexported_source.completion.attempt_admission_id,
            source_turn.completion.attempt_admission_id
        );
        assert_eq!(
            reexported_source.completion.admitted_model_plan,
            source_turn.completion.admitted_model_plan
        );
        assert_eq!(reexported_invoke.id, "action:invoke");
        assert_eq!(reexported_invoke.target_layer_id, None);
        assert_eq!(
            reexported_destination.origin,
            ExportTurnOrigin::Action {
                source_turn_id: reexported_source.id.clone(),
                source_action_id: reexported_invoke.id.clone(),
            }
        );

        let restaged = app
            .clone()
            .oneshot(request("POST", "write-token", Body::from(reexported_bytes)))
            .await
            .unwrap();
        assert_eq!(restaged.status(), StatusCode::OK);
        let restaged = response_json(restaged).await;
        let republished = app
            .clone()
            .oneshot(request(
                "PUT",
                "write-token",
                Body::from(serde_json::json!({"importId":restaged["importId"]}).to_string()),
            ))
            .await
            .unwrap();
        assert_eq!(republished.status(), StatusCode::OK);
        let republished = response_json(republished).await;
        let round_trip_thread_id = republished["threadId"].as_i64().unwrap();
        let round_trip_source_id = republished["turns"][0]["interactionId"].as_i64().unwrap();
        let round_trip_destination_id = republished["turns"][1]["interactionId"].as_i64().unwrap();
        let round_trip_thread = app
            .clone()
            .oneshot(request_uri(
                "GET",
                &format!("/api/threads/{round_trip_thread_id}"),
                "read-token",
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(round_trip_thread.status(), StatusCode::OK);
        let round_trip_thread = response_json(round_trip_thread).await;
        let round_trip_invoke =
            round_trip_thread["interactions"][0]["completionOutput"]["rootLayer"]["actions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|action| action["kind"] == "invoke")
                .unwrap();
        let round_trip_action_id = round_trip_invoke["id"].as_i64().unwrap();
        let round_trip_target = round_trip_invoke["targetLayerId"].as_i64().unwrap();
        let round_trip_destination = app
            .oneshot(request_uri(
                "GET",
                &format!(
                    "/api/threads/{round_trip_thread_id}/interactions/{round_trip_source_id}/actions/{round_trip_action_id}/destination"
                ),
                "read-token",
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(round_trip_destination.status(), StatusCode::OK);
        let round_trip_destination = response_json(round_trip_destination).await;
        assert_eq!(
            round_trip_destination["interactionId"],
            round_trip_destination_id
        );
        assert_eq!(round_trip_destination["targetLayerId"], round_trip_target);
        graph_task.abort();
    }

    #[tokio::test]
    async fn imported_eval_thread_exposes_context_for_accepted_failed_and_stopped_turns() {
        let mut records = resolved_invoke_records();
        let target = ExportContextTargetSnapshot {
            id: "node:source".into(),
            kind: "concept".into(),
            icon: "file".into(),
            title: "Source".into(),
            detail: "Accepted detail for Source".into(),
            state: ExportRecordState::Accepted,
        };
        let context = |id: &str, annotations: &[&str]| ExportInteractionContext {
            id: id.into(),
            target: target.clone(),
            source: ExportContextSource {
                interaction_node_id: "node:interaction-1".into(),
                layer_id: "layer:source".into(),
            },
            annotations: annotations.iter().map(|value| (*value).into()).collect(),
        };
        let ConversationExportRecord::Header(header) = &mut records[0] else {
            unreachable!()
        };
        header.turns.extend([
            ExportTurnManifestEntry {
                id: "turn:3".into(),
                sequence: 3,
            },
            ExportTurnManifestEntry {
                id: "turn:4".into(),
                sequence: 4,
            },
        ]);
        let ConversationExportRecord::Turn(accepted) = &mut records[1] else {
            unreachable!()
        };
        accepted.interaction_node_id = Some("node:interaction-1".into());
        accepted.contexts = vec![context("action:context-accepted", &["First", "Second"])];
        accepted.accepted_view.as_mut().unwrap().layers[0]
            .actions
            .extend([
                export_action(
                    "action:input-shared",
                    "node:source",
                    Some("layer:source"),
                    ExportActionKind::Input,
                    None,
                ),
                export_action(
                    "action:input-text",
                    "node:source",
                    Some("layer:source"),
                    ExportActionKind::Input,
                    None,
                ),
                export_action(
                    "action:input-multi",
                    "node:source",
                    Some("layer:source"),
                    ExportActionKind::Input,
                    None,
                ),
            ]);
        let options = vec![
            ExportInputOption {
                key: "failed".into(),
                label: "Failed value".into(),
            },
            ExportInputOption {
                key: "stopped".into(),
                label: "Stopped value".into(),
            },
        ];
        for (sequence, status, suffix) in [
            (3, ExportCompletionStatus::Failed, "failed"),
            (4, ExportCompletionStatus::Stopped, "stopped"),
        ] {
            records.push(ConversationExportRecord::Turn(Box::new(
                ConversationExportTurn {
                    id: format!("turn:{sequence}"),
                    sequence,
                    created_at: format!("176900000{sequence}000"),
                    text: if suffix == "failed" {
                        String::new()
                    } else {
                        format!("{suffix} turn")
                    },
                    interaction_node_id: Some(format!("node:interaction-{suffix}")),
                    origin: ExportTurnOrigin::User,
                    completion: ExportCompletionReceipt {
                        status,
                        harness_configuration_name: Some("codex-basic".into()),
                        harness_configuration_digest: None,
                        model_selection: None,
                        permission_profile_id: "auto".into(),
                        effective_execution_digest: None,
                        effective_permission_receipt: None,
                        error: Some(format!("{suffix} completion")),
                        attempt_admission_id: None,
                        admitted_model_plan: None,
                    },
                    contexts: vec![context(&format!("action:context-{suffix}"), &["Preserved"])],
                    submitted_inputs: vec![
                        ExportSubmittedInput {
                            id: format!("input-child:{suffix}-multi"),
                            root_turn_id: format!("turn:{sequence}"),
                            source: ExportInputSource {
                                interaction_node_id: "node:interaction-1".into(),
                                layer_id: "layer:source".into(),
                                action_id: "action:input-multi".into(),
                                node_id: "node:source".into(),
                            },
                            action: ExportInputActionSnapshot {
                                control: ExportInputControl::MultiSelect,
                                prompt: "Choose evidence".into(),
                                options: options.clone(),
                                minimum_selections: Some(2),
                            },
                            value: ExportSubmittedInputValue::Selected {
                                selected: options.clone(),
                            },
                        },
                        ExportSubmittedInput {
                            id: format!("input-child:{suffix}-single"),
                            root_turn_id: format!("turn:{sequence}"),
                            source: ExportInputSource {
                                interaction_node_id: "node:interaction-1".into(),
                                layer_id: "layer:source".into(),
                                action_id: "action:input-shared".into(),
                                node_id: "node:source".into(),
                            },
                            action: ExportInputActionSnapshot {
                                control: ExportInputControl::SingleSelect,
                                prompt: "Choose outcome".into(),
                                options: options.clone(),
                                minimum_selections: None,
                            },
                            value: ExportSubmittedInputValue::Selected {
                                selected: vec![
                                    options
                                        .iter()
                                        .find(|option| option.key == suffix)
                                        .unwrap()
                                        .clone(),
                                ],
                            },
                        },
                        ExportSubmittedInput {
                            id: format!("input-child:{suffix}-text"),
                            root_turn_id: format!("turn:{sequence}"),
                            source: ExportInputSource {
                                interaction_node_id: "node:interaction-1".into(),
                                layer_id: "layer:source".into(),
                                action_id: "action:input-text".into(),
                                node_id: "node:source".into(),
                            },
                            action: ExportInputActionSnapshot {
                                control: ExportInputControl::Text,
                                prompt: "Explain outcome".into(),
                                options: vec![],
                                minimum_selections: None,
                            },
                            value: ExportSubmittedInputValue::Text {
                                text: format!("{suffix} explanation"),
                            },
                        },
                    ],
                    accepted_view: None,
                },
            )));
        }

        let (_directory, app, _store, graph_task) = app(true).await;
        let staged = app
            .clone()
            .oneshot(request("POST", "write-token", Body::from(jsonl(&records))))
            .await
            .unwrap();
        assert_eq!(staged.status(), StatusCode::OK);
        let staged = response_json(staged).await;
        let published = app
            .clone()
            .oneshot(request(
                "PUT",
                "write-token",
                Body::from(serde_json::json!({"importId": staged["importId"]}).to_string()),
            ))
            .await
            .unwrap();
        assert_eq!(published.status(), StatusCode::OK);
        let published = response_json(published).await;
        let thread_id = published["threadId"].as_i64().unwrap();
        let thread = app
            .clone()
            .oneshot(request_uri(
                "GET",
                &format!("/api/threads/{thread_id}/interactions"),
                "read-token",
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(thread.status(), StatusCode::OK);
        let interactions = response_json(thread).await["interactions"]
            .as_array()
            .unwrap()
            .clone();
        for index in [0, 2, 3] {
            assert_eq!(interactions[index]["contexts"].as_array().unwrap().len(), 1);
            assert_eq!(
                interactions[index]["contexts"][0]["targetNode"]["title"],
                "Source"
            );
            assert!(interactions[index]["contexts"][0]["id"].as_i64().is_some());
            assert_eq!(
                interactions[index]["contexts"][0]["type"],
                "interaction.context"
            );
            assert!(
                interactions[index]["contexts"][0]["target"]["nodeId"]
                    .as_i64()
                    .is_some()
            );
        }
        assert_eq!(
            interactions[0]["contexts"][0]["annotations"],
            serde_json::json!(["First", "Second"])
        );
        assert_eq!(interactions[2]["completionStatus"], "failed");
        assert_eq!(interactions[3]["completionStatus"], "stopped");
        for (index, expected) in [(2, "failed"), (3, "stopped")] {
            let submitted = interactions[index]["submittedInputs"].as_array().unwrap();
            assert_eq!(submitted.len(), 3);
            let single = submitted
                .iter()
                .find(|input| input["action"]["control"] == "single_select")
                .unwrap();
            assert_eq!(single["value"]["selected"][0]["key"], expected);
        }
        let failed_diagnostics = app
            .clone()
            .oneshot(request_uri(
                "GET",
                &format!(
                    "/api/threads/{thread_id}/interactions/{}/input-children",
                    interactions[2]["id"].as_i64().unwrap()
                ),
                "read-token",
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(failed_diagnostics.status(), StatusCode::OK);
        let failed_diagnostics = response_json(failed_diagnostics).await;
        assert_eq!(
            failed_diagnostics["children"][0]["value"]["selected"][0]["key"],
            "failed"
        );
        let diagnostic_json = failed_diagnostics.to_string();
        assert!(!diagnostic_json.contains("attemptKey"));
        assert!(!diagnostic_json.contains("authorityDigest"));
        assert!(!diagnostic_json.contains("semanticDigest"));

        let reexported = app
            .oneshot(request_uri(
                "GET",
                &format!("/api/threads/{thread_id}/export"),
                "write-token",
                Body::empty(),
            ))
            .await
            .unwrap();
        if reexported.status() != StatusCode::OK {
            panic!("re-export failed: {}", response_json(reexported).await);
        }
        let bytes = to_bytes(reexported.into_body(), MAX_EXPORT_BYTES)
            .await
            .unwrap();
        let reexported = decode_export_jsonl(&bytes).unwrap();
        let ConversationExportRecord::Turn(accepted) = &reexported[1] else {
            unreachable!()
        };
        let ConversationExportRecord::Turn(failed) = &reexported[3] else {
            unreachable!()
        };
        let ConversationExportRecord::Turn(stopped) = &reexported[4] else {
            unreachable!()
        };
        assert_eq!(accepted.contexts[0].id, "action:context-accepted");
        assert_eq!(accepted.contexts[0].annotations, ["First", "Second"]);
        assert_eq!(failed.contexts[0].target, accepted.contexts[0].target);
        assert_eq!(stopped.contexts[0].target, accepted.contexts[0].target);
        assert_eq!(failed.completion.status, ExportCompletionStatus::Failed);
        assert_eq!(stopped.completion.status, ExportCompletionStatus::Stopped);
        assert_eq!(failed.submitted_inputs.len(), 3);
        assert_eq!(stopped.submitted_inputs.len(), 3);
        let failed_single = failed
            .submitted_inputs
            .iter()
            .find(|input| input.source.action_id == "action:input-shared")
            .unwrap();
        let stopped_single = stopped
            .submitted_inputs
            .iter()
            .find(|input| input.source.action_id == "action:input-shared")
            .unwrap();
        assert_ne!(failed_single.value, stopped_single.value);
        graph_task.abort();
    }

    #[tokio::test]
    async fn hostile_jsonl_corpus_never_panics_or_publishes_partial_state() {
        let (_directory, app, store, graph_task) = app(true).await;
        let valid = jsonl(&records("hostile corpus baseline".into()));
        let mut cases = vec![
            Vec::new(),
            b"{".to_vec(),
            b"[]\n".to_vec(),
            b"{\"recordType\":\"turn\"}\n".to_vec(),
            valid[..valid.len() / 3].to_vec(),
            valid[..valid.len() - 2].to_vec(),
        ];

        let fixture = records("ordering".into());
        cases.push(jsonl(&[fixture[1].clone(), fixture[0].clone()]));
        cases.push(jsonl(&[fixture[0].clone(), fixture[0].clone()]));

        let mut duplicate_manifest = records("duplicate manifest".into());
        let ConversationExportRecord::Header(header) = &mut duplicate_manifest[0] else {
            unreachable!()
        };
        header.turns.push(ExportTurnManifestEntry {
            id: "turn:1".into(),
            sequence: 2,
        });
        cases.push(jsonl(&duplicate_manifest));

        let mut unresolved_origin = records("first".into());
        let ConversationExportRecord::Header(header) = &mut unresolved_origin[0] else {
            unreachable!()
        };
        header.turns.push(ExportTurnManifestEntry {
            id: "turn:2".into(),
            sequence: 2,
        });
        unresolved_origin.push(ConversationExportRecord::Turn(Box::new(
            ConversationExportTurn {
                id: "turn:2".into(),
                sequence: 2,
                created_at: "1769000002000".into(),
                text: "unresolved action".into(),
                interaction_node_id: None,
                origin: ExportTurnOrigin::Action {
                    source_turn_id: "turn:1".into(),
                    source_action_id: "action:missing".into(),
                },
                completion: ExportCompletionReceipt {
                    status: ExportCompletionStatus::NotStarted,
                    harness_configuration_name: None,
                    harness_configuration_digest: None,
                    model_selection: None,
                    permission_profile_id: "auto".into(),
                    effective_execution_digest: None,
                    effective_permission_receipt: None,
                    error: None,
                    attempt_admission_id: None,
                    admitted_model_plan: None,
                },
                contexts: vec![],
                submitted_inputs: vec![],
                accepted_view: None,
            },
        )));
        cases.push(jsonl(&unresolved_origin));
        cases.push(vec![b'x'; MAX_JSONL_LINE_BYTES + 1]);

        for (index, case) in cases.into_iter().enumerate() {
            let response = app
                .clone()
                .oneshot(request("POST", "write-token", Body::from(case)))
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::UNPROCESSABLE_ENTITY,
                "hostile corpus case {index}"
            );
            assert!(
                store
                    .list_published_conversation_imports()
                    .await
                    .unwrap()
                    .is_empty(),
                "hostile corpus case {index} published state"
            );
            assert!(
                store
                    .staged_conversation_import_ids()
                    .await
                    .unwrap()
                    .is_empty(),
                "hostile corpus case {index} retained staging state"
            );
        }
        graph_task.abort();
    }

    #[tokio::test]
    async fn seeded_generated_jsonl_mutations_never_publish_or_retain_staging() {
        let (_directory, app, store, graph_task) = app(true).await;
        let valid = jsonl(&records("seeded mutation baseline".into()));
        let newline = valid.iter().position(|byte| *byte == b'\n').unwrap();
        let header = valid[..=newline].to_vec();
        let turn = valid[newline + 1..].to_vec();
        let mut seed = 0x5eed_cafe_f00d_ba5eu64;

        for case_index in 0..96 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let mutation = usize::try_from(seed % 5).unwrap();
            let mut candidate = match mutation {
                0 => {
                    let end = usize::try_from(seed).unwrap_or(0) % (valid.len() - 1);
                    valid[..end].to_vec()
                }
                1 => {
                    let mut bytes = valid.clone();
                    let index = usize::try_from(seed).unwrap_or(0) % bytes.len();
                    bytes[index] = 0xff;
                    bytes
                }
                2 => {
                    let garbage_len = usize::try_from((seed >> 8) % 64 + 1).unwrap();
                    let mut bytes = header.clone();
                    bytes.extend((0..garbage_len).map(|offset| {
                        let shifted = seed.rotate_left(u32::try_from(offset % 64).unwrap());
                        u8::try_from(shifted & 0x7f).unwrap()
                    }));
                    bytes.push(0xff);
                    bytes.push(b'\n');
                    bytes.extend_from_slice(&turn);
                    bytes
                }
                3 => {
                    let mut bytes = if seed & 1 == 0 {
                        header.clone()
                    } else {
                        turn.clone()
                    };
                    bytes.extend_from_slice(&valid);
                    bytes
                }
                _ => {
                    let mut bytes = header.clone();
                    bytes.extend_from_slice(&turn);
                    bytes.extend_from_slice(&turn);
                    bytes
                }
            };
            if candidate.is_empty() && case_index & 1 == 1 {
                candidate.push(0xff);
            }

            let response = app
                .clone()
                .oneshot(request("POST", "write-token", Body::from(candidate)))
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::UNPROCESSABLE_ENTITY,
                "seeded mutation {case_index} using strategy {mutation}"
            );
            assert!(
                store
                    .list_published_conversation_imports()
                    .await
                    .unwrap()
                    .is_empty(),
                "seeded mutation {case_index} published state"
            );
            assert!(
                store
                    .staged_conversation_import_ids()
                    .await
                    .unwrap()
                    .is_empty(),
                "seeded mutation {case_index} retained staging state"
            );
        }
        graph_task.abort();
    }
}
