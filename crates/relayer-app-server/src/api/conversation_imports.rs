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
        (None, ConversationExportRecord::VisualAssetContent(_)) => {
            Err("the first JSONL record must be the single header".into())
        }
        (Some(_), ConversationExportRecord::Header(_)) => {
            Err("only the first JSONL record may be a header".into())
        }
        (Some(stager), ConversationExportRecord::VisualAssetContent(content)) => stager
            .push_visual_asset_content(&content, product)
            .await
            .map_err(|error| error.to_string()),
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
pub(crate) mod tests {
    use std::{
        fs,
        path::Path,
        process::{Child, Command, Stdio},
        sync::OnceLock,
    };

    use axum::{
        Router,
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
    use sha2::{Digest, Sha256};
    use tower::ServiceExt;

    use super::{append_line_bytes, checked_total_bytes, stage_jsonl};
    use crate::{
        conversation_export::{
            ConversationExportHeader, ConversationExportRecord, ConversationExportTurn,
            EXPORT_VERSION_V1, EXPORT_VERSION_V2, ExportAcceptedView, ExportAction,
            ExportActionKind, ExportActionVariant, ExportAdmittedExecutionModelPlan,
            ExportAdmittedExecutionModelRoute, ExportCompletionReceipt, ExportCompletionStatus,
            ExportContextSource, ExportContextTargetSnapshot, ExportConversation,
            ExportInputActionSnapshot, ExportInputControl, ExportInputOption, ExportInputSource,
            ExportInteractionContext, ExportLayer, ExportModelSelection, ExportNavigateRelation,
            ExportNode, ExportProducer, ExportRecordState, ExportResolvedLayer,
            ExportSubmittedInput, ExportSubmittedInputValue, ExportTurnManifestEntry,
            ExportTurnOrigin, ExportVisualAssetAssociation, ExportVisualAssetContent,
            ExportVisualAssetProvenance, MAX_EXPORT_BYTES, MAX_JSONL_LINE_BYTES,
            admitted_model_plan_digest, decode_export_jsonl,
        },
        product::ProductService,
        runtime::RuntimeClient,
        storage::SqliteProductStore,
    };

    fn records(text: String) -> Vec<ConversationExportRecord> {
        vec![
            ConversationExportRecord::Header(Box::new(ConversationExportHeader {
                invocations: Vec::new(),
                bound_inputs: Vec::new(),
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
                visual_asset_contents: Vec::new(),
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
                    attempt_outcome: None,
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

    fn sort_submitted_inputs_canonically(turn: &mut ConversationExportTurn) {
        turn.submitted_inputs.sort_by_key(|submitted| {
            serde_json::to_vec(&(
                &submitted.source.interaction_node_id,
                &submitted.source.layer_id,
                &submitted.source.action_id,
                &submitted.source.node_id,
                &submitted.action,
                &submitted.value,
            ))
            .unwrap()
        });
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
            attempt_outcome: None,
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
            reusable: None,
            input_action_ids: Vec::new(),
            converted_from_invoke: false,
            id: id.into(),
            client_key: None,
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
            icon_asset: None,
            description: None,
            target_layer_id: target_layer_id.map(Into::into),
            interaction_text: (kind == ExportActionKind::Invoke)
                .then_some("Continue this path".into()),
            input: None,
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
                default_node_id: None,
                id: layer_id.into(),
                client_key: None,
                nodes: vec![node_id.into()],
                edges: vec![],
                layout: None,
                state: ExportRecordState::Accepted,
                renderer: None,
            },
            nodes: vec![ExportNode {
                id: node_id.into(),
                client_key: None,
                kind: "concept".into(),
                icon: "file".into(),
                title: title.into(),
                detail: format!("Accepted detail for {title}"),
                authored_detail: None,
                authored_detail_omitted: None,
                authored_detail_assets: Vec::new(),
                state: ExportRecordState::Accepted,
                artifact: None,
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
                invocations: Vec::new(),
                bound_inputs: Vec::new(),
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
                visual_asset_contents: Vec::new(),
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

    async fn runtime_with_visual_assets(
        graph: relayer_graph_core::GraphDatabase,
        root: &Path,
        visual_assets_bridge: Option<(String, String)>,
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
        if let Some((url, token)) = visual_assets_bridge {
            reqwest::Client::new()
                .put(format!("http://{address}/api/control/visual-assets/bridge"))
                .bearer_auth("graph-control")
                .json(&serde_json::json!({"url": url, "token": token, "generation": 1}))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
        }
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
        relayer_graph_core::GraphDatabase,
        tokio::task::JoinHandle<()>,
    ) {
        app_with_visual_assets(allow_conversation_import, None).await
    }

    async fn app_with_visual_assets(
        allow_conversation_import: bool,
        visual_assets_bridge: Option<(String, String)>,
    ) -> (
        tempfile::TempDir,
        Router,
        SqliteProductStore,
        relayer_graph_core::GraphDatabase,
        tokio::task::JoinHandle<()>,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteProductStore::open(directory.path().join("router-product.sqlite"))
            .await
            .unwrap();
        let product = ProductService::new(store.clone(), true);
        let graph = relayer_graph_core::GraphDatabase::in_memory()
            .await
            .unwrap();
        let (runtime, graph_task) =
            runtime_with_visual_assets(graph.clone(), directory.path(), visual_assets_bridge).await;
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
                completion_broker_origin: None,
                runtime: Some(runtime),
                permission_catalog,
                default_harness_configuration: "codex-basic".into(),
                allow_harness_override: true,
                eval_mode: false,
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
        (directory, router, store, graph, graph_task)
    }

    pub(crate) struct ChildGuard(Child);

    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    pub(crate) fn real_visual_assets_host() -> (tempfile::TempDir, ChildGuard, String, String) {
        let directory = tempfile::tempdir().unwrap();
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        static HOST_PACKAGES_BUILT: OnceLock<Result<(), String>> = OnceLock::new();
        if let Err(error) = HOST_PACKAGES_BUILT.get_or_init(|| {
            for workspace in [
                "@relayer/graph-client",
                "@relayer/visual-assets",
                "@relayer/harness-host",
            ] {
                let output = Command::new("npm")
                    .args(["run", "build", "-w", workspace])
                    .current_dir(&root)
                    .output()
                    .map_err(|error| format!("could not build {workspace}: {error}"))?;
                if !output.status.success() {
                    return Err(format!(
                        "building {workspace} for the real visual-assets host failed:\n{}\n{}",
                        String::from_utf8_lossy(&output.stdout),
                        String::from_utf8_lossy(&output.stderr)
                    ));
                }
            }
            Ok(())
        }) {
            panic!("{error}");
        }
        let ready_file = directory.path().join("visual-assets-host-url.txt");
        let state_file = directory.path().join("host-state.json");
        let catalog_file = directory.path().join("catalog.json");
        let token = "test-visual-assets-bridge-token-32-bytes".to_owned();
        let source = r#"
            import { rename, writeFile } from "node:fs/promises";
            import { createFileVisualAssetsLibrary } from "@relayer/visual-assets";
            import { startHarnessHost } from "@relayer/harness-host";
            const [stateFile, catalogFile, readyFile, token] = process.argv.slice(1);
            const library = await createFileVisualAssetsLibrary({
              authority: { projects: [], standaloneThreadIds: Array.from({ length: 100000 }, (_, index) => index + 1) },
              initialAssets: [],
            }, catalogFile);
            const running = await startHarnessHost({
              implementations: {},
              stateFile,
              controlToken: "unused-test-control-token",
              visualAssets: { token, generation: 1, library },
            });
            const readyFileTemp = `${readyFile}.tmp`;
            await writeFile(readyFileTemp, running.url, "utf8");
            await rename(readyFileTemp, readyFile);
            process.on("SIGTERM", () => { void running.close().then(() => process.exit(0)); });
        "#;
        let mut child = Command::new("node")
            .arg("--input-type=module")
            .arg("-e")
            .arg(source)
            .arg(&state_file)
            .arg(&catalog_file)
            .arg(&ready_file)
            .arg(&token)
            .current_dir(root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("start the real visual-assets host");
        for _ in 0..100 {
            if ready_file.exists() {
                let url = fs::read_to_string(&ready_file).unwrap();
                return (directory, ChildGuard(child), url, token);
            }
            if let Some(status) = child.try_wait().unwrap() {
                panic!("real visual-assets host exited during startup: {status}");
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();
        panic!("real visual-assets host did not become ready");
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
        let (_directory, enabled, _store, _graph, enabled_graph) = app(true).await;
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

        let (_directory, disabled, _store, _graph, disabled_graph) = app(false).await;
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

        let (_directory, app, _store, _graph, graph_task) = app(true).await;
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
            icon_asset: None,
            title: "Source".into(),
            detail: "Accepted detail for Source".into(),
            state: ExportRecordState::Accepted,
        };
        let context = |id: &str, annotations: &[&str]| ExportInteractionContext {
            id: id.into(),
            target: target.clone(),
            source: ExportContextSource {
                owner_turn_id: None,
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
        let options = vec![
            ExportInputOption {
                key: "failed".into(),
                label: "Failed value".into(),
                unsupported_fields: Default::default(),
            },
            ExportInputOption {
                key: "stopped".into(),
                label: "Stopped value".into(),
                unsupported_fields: Default::default(),
            },
        ];
        let input_action = |id: &str,
                            control: ExportInputControl,
                            prompt: &str,
                            action_options: Vec<ExportInputOption>,
                            minimum_selections: Option<u32>| {
            let mut action = export_action(
                id,
                "node:source",
                Some("layer:source"),
                ExportActionKind::Input,
                None,
            );
            action.input = Some(ExportInputActionSnapshot {
                control,
                prompt: prompt.into(),
                options: action_options,
                minimum_selections,
                unsupported_fields: Default::default(),
            });
            action
        };
        accepted.accepted_view.as_mut().unwrap().layers[0]
            .actions
            .extend([
                input_action(
                    "action:input-shared",
                    ExportInputControl::SingleSelect,
                    "Choose outcome",
                    options.clone(),
                    None,
                ),
                input_action(
                    "action:input-text",
                    ExportInputControl::Text,
                    "Explain outcome",
                    vec![],
                    None,
                ),
                input_action(
                    "action:input-multi",
                    ExportInputControl::MultiSelect,
                    "Choose evidence",
                    options.clone(),
                    Some(2),
                ),
            ]);
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
                        attempt_outcome: None,
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
                                unsupported_fields: Default::default(),
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
                                unsupported_fields: Default::default(),
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
                                unsupported_fields: Default::default(),
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

        let (_directory, app, _store, _graph, graph_task) = app(true).await;
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
    async fn unanswered_input_action_round_trips_through_app_import() {
        let mut records = resolved_invoke_records();
        let expected = ExportInputActionSnapshot {
            control: ExportInputControl::MultiSelect,
            prompt: "Choose the evidence to inspect".into(),
            options: vec![
                ExportInputOption {
                    key: "logs".into(),
                    label: "Logs".into(),
                    unsupported_fields: Default::default(),
                },
                ExportInputOption {
                    key: "traces".into(),
                    label: "Traces".into(),
                    unsupported_fields: Default::default(),
                },
            ],
            minimum_selections: Some(2),
            unsupported_fields: Default::default(),
        };
        let mut input_action = export_action(
            "action:input-unanswered",
            "node:source",
            Some("layer:source"),
            ExportActionKind::Input,
            None,
        );
        input_action.label = "Choose evidence".into();
        input_action.input = Some(expected.clone());
        let ConversationExportRecord::Turn(source) = &mut records[1] else {
            unreachable!()
        };
        source.accepted_view.as_mut().unwrap().layers[0]
            .actions
            .push(input_action);

        let (_directory, app, _store, _graph, graph_task) = app(true).await;
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
        let reexported = app
            .oneshot(request_uri(
                "GET",
                &format!(
                    "/api/threads/{}/export",
                    published["threadId"].as_i64().unwrap()
                ),
                "write-token",
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(reexported.status(), StatusCode::OK);
        let bytes = to_bytes(reexported.into_body(), MAX_EXPORT_BYTES)
            .await
            .unwrap();
        let reexported = decode_export_jsonl(&bytes).unwrap();
        let ConversationExportRecord::Turn(source) = &reexported[1] else {
            unreachable!()
        };
        let action = source
            .accepted_view
            .as_ref()
            .unwrap()
            .layers
            .iter()
            .flat_map(|layer| &layer.actions)
            .find(|action| action.id == "action:input-unanswered")
            .unwrap();
        assert_eq!(action.label, "Choose evidence");
        assert_eq!(action.input.as_ref(), Some(&expected));
        graph_task.abort();
    }

    fn forged_input_records(status: ExportCompletionStatus) -> Vec<ConversationExportRecord> {
        let mut records = resolved_invoke_records();
        let action_snapshot = ExportInputActionSnapshot {
            control: ExportInputControl::Text,
            prompt: "Explain the destination".into(),
            options: vec![],
            minimum_selections: None,
            unsupported_fields: Default::default(),
        };
        let mut input_action = export_action(
            "action:input",
            "node:source",
            Some("layer:source"),
            ExportActionKind::Input,
            None,
        );
        input_action.input = Some(action_snapshot.clone());
        let ConversationExportRecord::Turn(source) = &mut records[1] else {
            unreachable!()
        };
        source.accepted_view.as_mut().unwrap().layers[0]
            .actions
            .push(input_action);
        let ConversationExportRecord::Header(header) = &mut records[0] else {
            unreachable!()
        };
        header.turns.push(ExportTurnManifestEntry {
            id: "turn:3".into(),
            sequence: 3,
        });
        let accepted_view =
            (status == ExportCompletionStatus::Accepted).then(|| ExportAcceptedView {
                interaction_node_id: "node:interaction-3".into(),
                root_action: export_action(
                    "action:root-3",
                    "node:interaction-3",
                    None,
                    ExportActionKind::Navigate,
                    Some("layer:third"),
                ),
                root_layer_id: "layer:third".into(),
                layers: vec![export_layer("layer:third", "node:third", "Third", vec![])],
            });
        records.push(ConversationExportRecord::Turn(Box::new(
            ConversationExportTurn {
                id: "turn:3".into(),
                sequence: 3,
                created_at: "1769000003000".into(),
                text: "".into(),
                interaction_node_id: Some("node:interaction-3".into()),
                origin: ExportTurnOrigin::User,
                completion: if status == ExportCompletionStatus::Accepted {
                    accepted_receipt()
                } else {
                    ExportCompletionReceipt {
                        status,
                        attempt_outcome: None,
                        harness_configuration_name: Some("codex-basic".into()),
                        harness_configuration_digest: None,
                        model_selection: None,
                        permission_profile_id: "auto".into(),
                        effective_execution_digest: None,
                        effective_permission_receipt: None,
                        error: Some("fixture failure".into()),
                        attempt_admission_id: None,
                        admitted_model_plan: None,
                    }
                },
                contexts: vec![],
                submitted_inputs: vec![ExportSubmittedInput {
                    id: "input-child:rejected".into(),
                    root_turn_id: "turn:3".into(),
                    // Every ID is real, but this action was never presented in the
                    // destination occurrence. Graph authority must reject the splice.
                    source: ExportInputSource {
                        interaction_node_id: "node:interaction-2".into(),
                        layer_id: "layer:destination".into(),
                        action_id: "action:input".into(),
                        node_id: "node:source".into(),
                    },
                    action: action_snapshot,
                    value: ExportSubmittedInputValue::Text {
                        text: "Forged occurrence".into(),
                    },
                }],
                accepted_view,
            },
        )));
        records
    }

    const IMPORT_ASSET_SVG: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="#fff"/></svg>"##;

    fn canonical_json(value: &serde_json::Value) -> String {
        match value {
            serde_json::Value::Null => "null".into(),
            serde_json::Value::Bool(value) => value.to_string(),
            serde_json::Value::Number(value) => value.to_string(),
            serde_json::Value::String(value) => serde_json::to_string(value).unwrap(),
            serde_json::Value::Array(values) => format!(
                "[{}]",
                values
                    .iter()
                    .map(canonical_json)
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            serde_json::Value::Object(values) => {
                let mut keys = values.keys().collect::<Vec<_>>();
                keys.sort();
                format!(
                    "{{{}}}",
                    keys.into_iter()
                        .map(|key| format!(
                            "{}:{}",
                            serde_json::to_string(key).unwrap(),
                            canonical_json(&values[key])
                        ))
                        .collect::<Vec<_>>()
                        .join(",")
                )
            }
        }
    }

    fn mixed_v2_visual_asset_and_input_records() -> Vec<ConversationExportRecord> {
        let mut records = forged_input_records(ExportCompletionStatus::Accepted);
        let digest = format!("{:x}", Sha256::digest(IMPORT_ASSET_SVG));
        let pin = serde_json::json!({
            "id": "asset:diagram",
            "digestSha256": digest,
            "mediaType": "image/svg+xml",
            "representation": "image"
        });
        let mut package = serde_json::json!({
            "version": 1,
            "components": [{
                "id": "visual",
                "order": 0,
                "html": "<img data-gc-asset=\"asset-mount\">",
                "css": ""
            }],
            "mounts": [{
                "id": "asset-mount",
                "componentId": "visual",
                "kind": "asset",
                "host": "img",
                "assetId": "asset:diagram"
            }],
            "assets": [pin]
        });
        let integrity = format!("{:x}", Sha256::digest(canonical_json(&package).as_bytes()));
        package["integritySha256"] = serde_json::Value::String(integrity);
        let ConversationExportRecord::Header(header) = &mut records[0] else {
            unreachable!()
        };
        header.export_version = EXPORT_VERSION_V2;

        let ConversationExportRecord::Turn(source) = &mut records[1] else {
            unreachable!()
        };
        let view = source.accepted_view.as_mut().unwrap();
        let input_action = view.layers[0]
            .actions
            .iter()
            .find(|action| action.id == "action:input")
            .unwrap()
            .clone();
        let node = &mut view.layers[0].nodes[0];
        node.authored_detail = Some(package);
        node.authored_detail_assets = vec![ExportVisualAssetAssociation {
            asset_id: "asset:diagram".into(),
            digest_sha256: digest.clone(),
            media_type: "image/svg+xml".into(),
            byte_length: IMPORT_ASSET_SVG.len(),
            provenance: ExportVisualAssetProvenance {
                source: "user".into(),
                file_name: "diagram.svg".into(),
            },
        }];
        let mut distinct_action = input_action.clone();
        distinct_action.id = "action:input-distinct".into();
        view.layers[0].actions.push(distinct_action);

        let action_snapshot = input_action.input.unwrap();
        let source = ExportInputSource {
            interaction_node_id: "node:interaction-1".into(),
            layer_id: "layer:source".into(),
            action_id: "action:input".into(),
            node_id: "node:source".into(),
        };
        let valid = |id: &str, input_source: ExportInputSource, text: &str| ExportSubmittedInput {
            id: id.into(),
            root_turn_id: "turn:3".into(),
            source: input_source,
            action: action_snapshot.clone(),
            value: ExportSubmittedInputValue::Text { text: text.into() },
        };
        let mut duplicate_source = source.clone();
        duplicate_source.action_id = "action:input-distinct".into();
        let unresolved_source = ExportInputSource {
            interaction_node_id: "node:missing-interaction".into(),
            layer_id: "layer:missing".into(),
            action_id: "action:missing".into(),
            node_id: "node:missing".into(),
        };
        let ConversationExportRecord::Turn(consumer) = &mut records[3] else {
            unreachable!()
        };
        consumer.submitted_inputs.extend([
            valid("input-child:first-valid", source.clone(), "First answer"),
            valid("input-child:duplicate", source, "First answer"),
            valid(
                "input-child:distinct-valid",
                duplicate_source,
                "Distinct answer",
            ),
            valid(
                "input-child:unresolved",
                unresolved_source,
                "Unresolved answer",
            ),
        ]);
        sort_submitted_inputs_canonically(consumer);

        let content = ExportVisualAssetContent {
            digest_sha256: digest,
            media_type: "image/svg+xml".into(),
            byte_length: IMPORT_ASSET_SVG.len(),
            content_base64: BASE64_STANDARD.encode(IMPORT_ASSET_SVG),
        };
        records.insert(
            1,
            ConversationExportRecord::VisualAssetContent(Box::new(content)),
        );
        records
    }

    #[tokio::test]
    async fn rejected_imported_input_is_reported_and_absent_from_reexport() {
        let records = forged_input_records(ExportCompletionStatus::Failed);

        let (_directory, app, _store, _graph, graph_task) = app(true).await;
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
        assert_eq!(
            published["skippedSubmittedInputs"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            published["skippedSubmittedInputs"][0]["submittedInputId"],
            "input-child:rejected"
        );
        assert_eq!(
            published["skippedSubmittedInputs"][0]["code"],
            "input_action_not_in_occurrence"
        );
        assert_eq!(
            published["skippedSubmittedInputs"][0]["path"],
            "submittedInputs[0].source.actionId"
        );

        let reexported = app
            .oneshot(request_uri(
                "GET",
                &format!(
                    "/api/threads/{}/export",
                    published["threadId"].as_i64().unwrap()
                ),
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
        let ConversationExportRecord::Turn(rejected_turn) = &reexported[3] else {
            unreachable!()
        };
        assert!(rejected_turn.submitted_inputs.is_empty());
        graph_task.abort();
    }

    #[tokio::test]
    async fn duplicate_imported_input_is_reported_after_publish_and_absent_from_reexport() {
        let mut records = forged_input_records(ExportCompletionStatus::Accepted);
        let action = {
            let ConversationExportRecord::Turn(source) = &mut records[1] else {
                unreachable!()
            };
            let input_action = source.accepted_view.as_mut().unwrap().layers[0]
                .actions
                .iter()
                .find(|action| action.id == "action:input")
                .unwrap()
                .clone();
            let mut distinct = input_action.clone();
            distinct.id = "action:input-distinct".into();
            source.accepted_view.as_mut().unwrap().layers[0]
                .actions
                .push(distinct);
            input_action.input.unwrap()
        };
        let provenance_rejection = {
            let ConversationExportRecord::Turn(rejected) = &mut records[3] else {
                unreachable!()
            };
            let mut input = rejected.submitted_inputs.pop().unwrap();
            input.id = "input-child:spliced".into();
            input
        };
        let mut same_turn_input = export_action(
            "action:input-same-turn",
            "node:third",
            Some("layer:third"),
            ExportActionKind::Input,
            None,
        );
        same_turn_input.input = Some(action.clone());
        let mut future_input = export_action(
            "action:input-future",
            "node:future",
            Some("layer:future"),
            ExportActionKind::Input,
            None,
        );
        future_input.input = Some(action.clone());
        let ConversationExportRecord::Turn(consumer) = &mut records[3] else {
            unreachable!()
        };
        consumer.accepted_view.as_mut().unwrap().layers[0]
            .actions
            .push(same_turn_input);
        let future_layer = export_layer(
            "layer:future",
            "node:future",
            "Future question",
            vec![future_input],
        );
        let header = match &mut records[0] {
            ConversationExportRecord::Header(header) => header,
            _ => unreachable!(),
        };
        header.turns.push(ExportTurnManifestEntry {
            id: "turn:4".into(),
            sequence: 4,
        });
        records.push(ConversationExportRecord::Turn(Box::new(
            ConversationExportTurn {
                id: "turn:4".into(),
                sequence: 4,
                created_at: "1769000004000".into(),
                text: "Future question".into(),
                interaction_node_id: None,
                origin: ExportTurnOrigin::User,
                completion: accepted_receipt(),
                contexts: vec![],
                submitted_inputs: vec![],
                accepted_view: Some(ExportAcceptedView {
                    interaction_node_id: "node:interaction-4".into(),
                    root_action: export_action(
                        "action:root-4",
                        "node:interaction-4",
                        None,
                        ExportActionKind::Navigate,
                        Some("layer:future"),
                    ),
                    root_layer_id: "layer:future".into(),
                    layers: vec![future_layer],
                }),
            },
        )));

        let value = ExportSubmittedInputValue::Text {
            text: "A real answer".into(),
        };
        let answer = |id: &str, source: ExportInputSource| ExportSubmittedInput {
            id: id.into(),
            root_turn_id: "turn:3".into(),
            source,
            action: action.clone(),
            value: value.clone(),
        };
        let ConversationExportRecord::Turn(rejected) = &mut records[3] else {
            unreachable!()
        };
        rejected.submitted_inputs = vec![
            answer(
                "input-child:first-valid",
                ExportInputSource {
                    interaction_node_id: "node:interaction-1".into(),
                    layer_id: "layer:source".into(),
                    action_id: "action:input".into(),
                    node_id: "node:source".into(),
                },
            ),
            answer(
                "input-child:duplicate",
                ExportInputSource {
                    interaction_node_id: "node:interaction-1".into(),
                    layer_id: "layer:source".into(),
                    action_id: "action:input".into(),
                    node_id: "node:source".into(),
                },
            ),
            answer(
                "input-child:distinct-valid",
                ExportInputSource {
                    interaction_node_id: "node:interaction-1".into(),
                    layer_id: "layer:source".into(),
                    action_id: "action:input-distinct".into(),
                    node_id: "node:source".into(),
                },
            ),
            provenance_rejection,
            answer(
                "input-child:same-turn",
                ExportInputSource {
                    interaction_node_id: "node:interaction-3".into(),
                    layer_id: "layer:third".into(),
                    action_id: "action:input-same-turn".into(),
                    node_id: "node:third".into(),
                },
            ),
            answer(
                "input-child:later-turn",
                ExportInputSource {
                    interaction_node_id: "node:interaction-4".into(),
                    layer_id: "layer:future".into(),
                    action_id: "action:input-future".into(),
                    node_id: "node:future".into(),
                },
            ),
            answer(
                "input-child:unresolved",
                ExportInputSource {
                    interaction_node_id: "node:missing-interaction".into(),
                    layer_id: "layer:missing".into(),
                    action_id: "action:missing".into(),
                    node_id: "node:missing".into(),
                },
            ),
        ];
        sort_submitted_inputs_canonically(rejected);
        let path_by_id = match &records[3] {
            ConversationExportRecord::Turn(turn) => turn
                .submitted_inputs
                .iter()
                .enumerate()
                .map(|(index, input)| {
                    let suffix = match input.id.as_str() {
                        "input-child:duplicate" | "input-child:unresolved" => "source",
                        "input-child:spliced" => "source.actionId",
                        _ => "source.interactionNodeId",
                    };
                    (
                        input.id.as_str(),
                        format!("submittedInputs[{index}].{suffix}"),
                    )
                })
                .collect::<std::collections::HashMap<_, _>>(),
            _ => unreachable!(),
        };

        let (_directory, app, _store, _graph, graph_task) = app(true).await;
        let staged = app
            .clone()
            .oneshot(request("POST", "write-token", Body::from(jsonl(&records))))
            .await
            .unwrap();
        if staged.status() != StatusCode::OK {
            panic!("staging failed: {}", response_json(staged).await);
        }
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
        let skipped = published["skippedSubmittedInputs"].as_array().unwrap();
        assert_eq!(skipped.len(), 5);
        let skipped_by_id = skipped
            .iter()
            .map(|record| (record["submittedInputId"].as_str().unwrap(), record))
            .collect::<std::collections::HashMap<_, _>>();
        for (id, code) in [
            ("input-child:duplicate", "input_attachment_duplicate"),
            ("input-child:spliced", "input_action_not_in_occurrence"),
            ("input-child:same-turn", "input_occurrence_not_visible"),
            ("input-child:later-turn", "input_occurrence_not_visible"),
            ("input-child:unresolved", "input_occurrence_not_visible"),
        ] {
            assert_eq!(skipped_by_id[id]["code"], code);
            assert_eq!(skipped_by_id[id]["sourceTurnId"], "turn:3");
            assert_eq!(skipped_by_id[id]["path"], path_by_id[id]);
        }

        let reexported = app
            .oneshot(request_uri(
                "GET",
                &format!(
                    "/api/threads/{}/export",
                    published["threadId"].as_i64().unwrap()
                ),
                "write-token",
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(reexported.status(), StatusCode::OK);
        let bytes = to_bytes(reexported.into_body(), MAX_EXPORT_BYTES)
            .await
            .unwrap();
        let reexported = decode_export_jsonl(&bytes).unwrap();
        let ConversationExportRecord::Turn(imported) = &reexported[3] else {
            unreachable!()
        };
        assert_eq!(imported.submitted_inputs.len(), 2);
        assert_eq!(
            imported
                .submitted_inputs
                .iter()
                .map(|input| input.id.as_str())
                .collect::<Vec<_>>(),
            vec!["input-child:first-valid", "input-child:distinct-valid"]
        );
        graph_task.abort();
    }

    #[tokio::test]
    async fn image_icons_node_layer_root_and_context_survive_http_import_and_reexport_without_details()
     {
        let mut records = mixed_v2_visual_asset_and_input_records();
        let ConversationExportRecord::Turn(source) = &mut records[2] else {
            unreachable!()
        };
        let view = source.accepted_view.as_mut().unwrap();
        let node = &mut view.layers[0].nodes[0];
        let association = node.authored_detail_assets[0].clone();
        let icon = serde_json::json!({"kind":"image","assetId":association.asset_id,"digestSha256":association.digest_sha256,"mediaType":association.media_type,"fit":"contain","framing":"none"}).to_string();
        node.icon = icon.clone();
        // Omission of an unrelated private Detail package cannot drop the icon.
        node.authored_detail = None;
        node.authored_detail_omitted =
            Some(crate::conversation_export::ExportAuthoredDetailOmission::SensitiveData);
        let target = ExportContextTargetSnapshot {
            id: node.id.clone(),
            kind: node.kind.clone(),
            icon: icon.clone(),
            icon_asset: Some(association.clone()),
            title: node.title.clone(),
            detail: node.detail.clone(),
            state: ExportRecordState::Accepted,
        };
        view.layers[0].actions[0].icon = Some(icon.clone());
        view.root_action.icon = Some(icon.clone());
        view.root_action.icon_asset = Some(association.clone());
        let interaction_node = view.interaction_node_id.clone();
        let layer_id = view.layers[0].layer.id.clone();
        let ConversationExportRecord::Turn(consumer) = &mut records[4] else {
            unreachable!()
        };
        consumer.contexts.push(ExportInteractionContext {
            id: "action:image-context".into(),
            target,
            source: ExportContextSource {
                owner_turn_id: None,
                interaction_node_id: interaction_node,
                layer_id,
            },
            annotations: vec![],
        });
        let (_assets_directory, _assets_host, assets_url, assets_token) = real_visual_assets_host();
        let (_directory, app, _store, _graph, graph_task) =
            app_with_visual_assets(true, Some((assets_url, assets_token))).await;
        let staged = app
            .clone()
            .oneshot(request("POST", "write-token", Body::from(jsonl(&records))))
            .await
            .unwrap();
        let status = staged.status();
        let staged = response_json(staged).await;
        assert_eq!(status, StatusCode::OK, "{staged}");
        let published = app
            .clone()
            .oneshot(request(
                "PUT",
                "write-token",
                Body::from(serde_json::json!({"importId":staged["importId"]}).to_string()),
            ))
            .await
            .unwrap();
        let status = published.status();
        let published = response_json(published).await;
        assert_eq!(status, StatusCode::OK, "{published}");
        let thread_id = published["threadId"].as_i64().unwrap();
        let interaction_id = published["turns"][0]["interactionId"].as_i64().unwrap();
        let layer_id = published["turns"][0]["rootLayerId"].as_i64().unwrap();
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
        let thread = response_json(thread).await;
        let owner_node_id =
            thread["interactions"][0]["completionOutput"]["rootAction"]["sourceNodeId"]
                .as_i64()
                .unwrap();
        let uri = format!(
            "/api/threads/{thread_id}/interactions/{interaction_id}/nodes/{owner_node_id}/detail-assets/{}?layerId={layer_id}",
            association.asset_id
        );
        let root_asset = app
            .clone()
            .oneshot(request_uri("GET", &uri, "read-token", Body::empty()))
            .await
            .unwrap();
        let status = root_asset.status();
        let root_asset = response_json(root_asset).await;
        assert_eq!(status, StatusCode::OK, "{root_asset}");
        assert_eq!(root_asset["digestSha256"], association.digest_sha256);
        let wrong = app.clone().oneshot(request_uri("GET", &format!("/api/threads/{thread_id}/interactions/{interaction_id}/nodes/{owner_node_id}/detail-assets/wrong-asset?layerId={layer_id}"), "read-token", Body::empty())).await.unwrap();
        assert_eq!(wrong.status(), StatusCode::FORBIDDEN);
        let exported = app
            .oneshot(request_uri(
                "GET",
                &format!(
                    "/api/threads/{}/export",
                    published["threadId"].as_i64().unwrap()
                ),
                "write-token",
                Body::empty(),
            ))
            .await
            .unwrap();
        let status = exported.status();
        let bytes = to_bytes(exported.into_body(), MAX_EXPORT_BYTES)
            .await
            .unwrap();
        assert_eq!(
            status,
            StatusCode::OK,
            "{}",
            String::from_utf8_lossy(&bytes)
        );
        let exported = decode_export_jsonl(&bytes).unwrap();
        assert_eq!(
            exported
                .iter()
                .filter(|r| matches!(r, ConversationExportRecord::VisualAssetContent(_)))
                .count(),
            1
        );
        let source = exported
            .iter()
            .find_map(|r| match r {
                ConversationExportRecord::Turn(t) if t.id == "turn:1" => Some(t),
                _ => None,
            })
            .unwrap();
        let view = source.accepted_view.as_ref().unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&view.root_action.icon.clone().unwrap())
                .unwrap()["digestSha256"],
            association.digest_sha256
        );
        assert_eq!(view.root_action.icon_asset.as_ref(), Some(&association));
        assert_eq!(
            view.layers[0].nodes[0].authored_detail_assets,
            vec![association.clone()]
        );
        assert!(view.layers[0].nodes[0].authored_detail.is_none());
        assert!(view.layers[0].actions.iter().any(|a| {
            a.icon
                .as_deref()
                .and_then(|v| serde_json::from_str::<serde_json::Value>(v).ok())
                == serde_json::from_str::<serde_json::Value>(&icon).ok()
        }));
        let consumer = exported
            .iter()
            .find_map(|r| match r {
                ConversationExportRecord::Turn(t) if t.id == "turn:3" => Some(t),
                _ => None,
            })
            .unwrap();
        assert_eq!(
            consumer.contexts[0].target.icon_asset.as_ref(),
            Some(&association)
        );
        graph_task.abort();
    }

    #[tokio::test]
    async fn mixed_v2_assets_and_recoverable_inputs_survive_http_publish_and_strict_reexport() {
        let records = mixed_v2_visual_asset_and_input_records();
        let ConversationExportRecord::Turn(source) = &records[2] else {
            unreachable!()
        };
        let original_node = &source.accepted_view.as_ref().unwrap().layers[0].nodes[0];
        let expected_package = original_node.authored_detail.clone().unwrap();
        let expected_associations = original_node.authored_detail_assets.clone();

        let (_assets_directory, _assets_host, assets_url, assets_token) = real_visual_assets_host();
        let (_directory, app, _store, _graph, graph_task) =
            app_with_visual_assets(true, Some((assets_url, assets_token))).await;
        let staged = app
            .clone()
            .oneshot(request("POST", "write-token", Body::from(jsonl(&records))))
            .await
            .unwrap();
        if staged.status() != StatusCode::OK {
            panic!(
                "mixed V2 asset/input staging failed: {}",
                response_json(staged).await
            );
        }
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
        if published.status() != StatusCode::OK {
            panic!(
                "mixed V2 asset/input publish failed: {}",
                response_json(published).await
            );
        }
        let published = response_json(published).await;
        let skipped = published["skippedSubmittedInputs"].as_array().unwrap();
        assert_eq!(skipped.len(), 3);
        let skipped_ids = skipped
            .iter()
            .map(|item| item["submittedInputId"].as_str().unwrap())
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(
            skipped_ids,
            [
                "input-child:duplicate",
                "input-child:rejected",
                "input-child:unresolved"
            ]
            .into_iter()
            .collect()
        );

        let reexported = app
            .oneshot(request_uri(
                "GET",
                &format!(
                    "/api/threads/{}/export",
                    published["threadId"].as_i64().unwrap()
                ),
                "write-token",
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(reexported.status(), StatusCode::OK);
        let bytes = to_bytes(reexported.into_body(), MAX_EXPORT_BYTES)
            .await
            .unwrap();
        // Decoding uses the strict ordinary-export validator. A V2 archive that
        // lost its package, association, or canonical content fails here.
        let reexported = decode_export_jsonl(&bytes).unwrap();
        let content = reexported
            .iter()
            .filter_map(|record| match record {
                ConversationExportRecord::VisualAssetContent(content) => Some(content),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(content.len(), 1);
        let ConversationExportRecord::VisualAssetContent(expected_content) = &records[1] else {
            unreachable!()
        };
        assert_eq!(content[0].as_ref(), expected_content.as_ref());

        let ConversationExportRecord::Turn(reexported_source) = reexported
            .iter()
            .find(|record| matches!(record, ConversationExportRecord::Turn(turn) if turn.id == "turn:1"))
            .unwrap()
        else {
            unreachable!()
        };
        let imported_node = &reexported_source.accepted_view.as_ref().unwrap().layers[0].nodes[0];
        assert_eq!(
            imported_node.authored_detail.as_ref(),
            Some(&expected_package)
        );
        assert_eq!(imported_node.authored_detail_assets, expected_associations);

        let ConversationExportRecord::Turn(reexported_consumer) = reexported
            .iter()
            .find(|record| matches!(record, ConversationExportRecord::Turn(turn) if turn.id == "turn:3"))
            .unwrap()
        else {
            unreachable!()
        };
        assert_eq!(reexported_consumer.submitted_inputs.len(), 2);
        assert_eq!(
            reexported_consumer
                .submitted_inputs
                .iter()
                .map(|input| input.id.as_str())
                .collect::<Vec<_>>(),
            ["input-child:first-valid", "input-child:distinct-valid"]
        );
        graph_task.abort();
    }

    #[tokio::test]
    async fn mixed_v2_asset_failures_reject_staging_and_clean_up_with_recoverable_inputs() {
        let mut corrupt = mixed_v2_visual_asset_and_input_records();
        let ConversationExportRecord::VisualAssetContent(content) = &mut corrupt[1] else {
            unreachable!()
        };
        let mut corrupt_bytes = IMPORT_ASSET_SVG.to_vec();
        corrupt_bytes[0] = b'!';
        content.content_base64 = BASE64_STANDARD.encode(corrupt_bytes);

        let mut missing = mixed_v2_visual_asset_and_input_records();
        missing.remove(1);

        let mut duplicate = mixed_v2_visual_asset_and_input_records();
        duplicate.insert(2, duplicate[1].clone());

        let mut unreachable = mixed_v2_visual_asset_and_input_records();
        let unreachable_bytes =
            br#"<svg xmlns="http://www.w3.org/2000/svg"><circle cx="1" cy="1" r="1"/></svg>"#;
        unreachable.insert(
            2,
            ConversationExportRecord::VisualAssetContent(Box::new(ExportVisualAssetContent {
                digest_sha256: format!("{:x}", Sha256::digest(unreachable_bytes)),
                media_type: "image/svg+xml".into(),
                byte_length: unreachable_bytes.len(),
                content_base64: BASE64_STANDARD.encode(unreachable_bytes),
            })),
        );

        let mut mismatched_pin = mixed_v2_visual_asset_and_input_records();
        let ConversationExportRecord::Turn(source) = &mut mismatched_pin[2] else {
            unreachable!()
        };
        source.accepted_view.as_mut().unwrap().layers[0].nodes[0].authored_detail_assets[0]
            .asset_id = "asset:wrong".into();

        let cases = [
            (
                "corrupt content before turns",
                corrupt,
                "visual_asset_content_corrupt",
            ),
            (
                "missing pinned content",
                missing,
                "visual_asset_content_missing",
            ),
            (
                "duplicate content digest",
                duplicate,
                "visual_asset_content_duplicate",
            ),
            (
                "unreachable digest",
                unreachable,
                "visual_asset_content_unreachable",
            ),
            (
                "association disagrees with package pin",
                mismatched_pin,
                "authored_detail_asset_pin_mismatch",
            ),
        ];
        let (_assets_directory, _assets_host, assets_url, assets_token) = real_visual_assets_host();
        let (_directory, app, store, _graph, graph_task) =
            app_with_visual_assets(true, Some((assets_url, assets_token))).await;
        for (name, records, expected_error) in cases {
            let response = app
                .clone()
                .oneshot(request("POST", "write-token", Body::from(jsonl(&records))))
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::UNPROCESSABLE_ENTITY,
                "{name}"
            );
            let error = response_json(response).await;
            assert!(
                error.to_string().contains(expected_error),
                "{name}: {error}"
            );
            assert!(
                store
                    .list_published_conversation_imports()
                    .await
                    .unwrap()
                    .is_empty(),
                "{name} published partial state"
            );
            assert!(
                store
                    .staged_conversation_import_ids()
                    .await
                    .unwrap()
                    .is_empty(),
                "{name} retained product staging state"
            );
        }
        // The HTTP POST path validates and cleans product staging before the
        // publish endpoint can begin any graph import transaction.
        graph_task.abort();
    }

    #[tokio::test]
    async fn rejected_child_snapshot_cannot_poison_non_input_action_materialization() {
        for (case, non_input_action_id) in [
            ("navigate", "action:navigate-extra"),
            ("invoke", "action:invoke"),
            ("response-root", "action:root-1"),
        ] {
            let mut records = forged_input_records(ExportCompletionStatus::Accepted);
            let input_action = {
                let ConversationExportRecord::Turn(source) = &mut records[1] else {
                    unreachable!()
                };
                source.accepted_view.as_mut().unwrap().layers[0]
                    .actions
                    .iter()
                    .find(|action| action.id == "action:input")
                    .unwrap()
                    .input
                    .clone()
                    .unwrap()
            };
            if case == "navigate" {
                let ConversationExportRecord::Turn(source) = &mut records[1] else {
                    unreachable!()
                };
                let view = source.accepted_view.as_mut().unwrap();
                view.layers[0].actions.push(export_action(
                    non_input_action_id,
                    "node:source",
                    Some("layer:source"),
                    ExportActionKind::Navigate,
                    Some("layer:navigate-target"),
                ));
                view.layers.push(export_layer(
                    "layer:navigate-target",
                    "node:navigate-target",
                    "Navigate target",
                    vec![],
                ));
            }

            let value = ExportSubmittedInputValue::Text {
                text: "Keep this valid sibling".into(),
            };
            let submitted = |id: &str, action_id: &str| ExportSubmittedInput {
                id: id.into(),
                root_turn_id: "turn:3".into(),
                source: ExportInputSource {
                    interaction_node_id: "node:interaction-1".into(),
                    layer_id: "layer:source".into(),
                    action_id: action_id.into(),
                    node_id: if action_id == "action:root-1" {
                        "node:interaction-1".into()
                    } else {
                        "node:source".into()
                    },
                },
                action: input_action.clone(),
                value: value.clone(),
            };
            let ConversationExportRecord::Turn(consumer) = &mut records[3] else {
                unreachable!()
            };
            consumer.text = "Keep this accepted turn".into();
            consumer.submitted_inputs = vec![
                submitted("input-child:valid", "action:input"),
                submitted("input-child:poison", non_input_action_id),
            ];
            sort_submitted_inputs_canonically(consumer);

            let (_directory, app, _store, _graph, graph_task) = app(true).await;
            let staged = app
                .clone()
                .oneshot(request("POST", "write-token", Body::from(jsonl(&records))))
                .await
                .unwrap();
            assert_eq!(
                staged.status(),
                StatusCode::OK,
                "{case}: stage should defer invalid provenance to graph-core"
            );
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
            if published.status() != StatusCode::OK {
                panic!(
                    "{case}: one poisoned child must not abort valid conversation content: {}",
                    response_json(published).await
                );
            }
            let published = response_json(published).await;
            let skipped = published["skippedSubmittedInputs"].as_array().unwrap();
            assert_eq!(skipped.len(), 1, "{case}");
            assert_eq!(
                skipped[0]["submittedInputId"], "input-child:poison",
                "{case}"
            );

            let reexported = app
                .oneshot(request_uri(
                    "GET",
                    &format!(
                        "/api/threads/{}/export",
                        published["threadId"].as_i64().unwrap()
                    ),
                    "write-token",
                    Body::empty(),
                ))
                .await
                .unwrap();
            assert_eq!(reexported.status(), StatusCode::OK, "{case}");
            let bytes = to_bytes(reexported.into_body(), MAX_EXPORT_BYTES)
                .await
                .unwrap();
            let reexported = decode_export_jsonl(&bytes).unwrap();
            let ConversationExportRecord::Turn(source) = &reexported[1] else {
                unreachable!()
            };
            match case {
                "response-root" => {
                    assert_eq!(
                        source.accepted_view.as_ref().unwrap().root_action.kind,
                        ExportActionKind::Navigate,
                        "{case}"
                    );
                }
                "invoke" => assert!(
                    source.accepted_view.as_ref().unwrap().layers[0]
                        .actions
                        .iter()
                        .any(|action| action.kind == ExportActionKind::Invoke),
                    "{case}"
                ),
                "navigate" => assert!(
                    source.accepted_view.as_ref().unwrap().layers[0]
                        .actions
                        .iter()
                        .any(|action| action.kind == ExportActionKind::Navigate),
                    "{case}"
                ),
                _ => unreachable!(),
            }
            let ConversationExportRecord::Turn(imported) = &reexported[3] else {
                unreachable!()
            };
            assert_eq!(imported.text, "Keep this accepted turn", "{case}");
            assert_eq!(imported.submitted_inputs.len(), 1, "{case}");
            assert_eq!(
                imported.submitted_inputs[0].id, "input-child:valid",
                "{case}"
            );
            graph_task.abort();
        }
    }

    #[tokio::test]
    async fn accepted_turn_with_only_rejected_input_is_cleaned_up_before_publish() {
        let records = forged_input_records(ExportCompletionStatus::Accepted);
        let (_directory, app, store, graph, graph_task) = app(true).await;
        let staged = app
            .clone()
            .oneshot(request("POST", "write-token", Body::from(jsonl(&records))))
            .await
            .unwrap();
        assert_eq!(staged.status(), StatusCode::OK);
        let staged = response_json(staged).await;
        let import_id = staged["importId"].as_str().unwrap().to_owned();
        let thread_id = staged["threadId"].as_i64().unwrap();
        let published = app
            .oneshot(request(
                "PUT",
                "write-token",
                Body::from(serde_json::json!({"importId": staged["importId"]}).to_string()),
            ))
            .await
            .unwrap();
        assert_eq!(published.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let failure = response_json(published).await;
        assert_eq!(failure["code"], "invalid_input");
        assert!(
            failure["error"]
                .as_str()
                .unwrap()
                .starts_with("interaction_input_empty at turns[2].text:")
        );
        assert!(
            store
                .list_published_conversation_imports()
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            store
                .staged_conversation_import_ids()
                .await
                .unwrap()
                .is_empty()
        );
        graph
            .begin_imported_conversation(&relayer_graph_core::ImportedConversationStage {
                inert_invocations: Vec::new(),
                standalone_inputs: Vec::new(),
                import_id: import_id.clone(),
                source_sha256: "sha256:cleanup-probe".into(),
                project_id: None,
                thread_id: relayer_graph_core::ThreadId::new(thread_id).unwrap(),
                created_at: "1770000000000".into(),
            })
            .await
            .expect("graph import identity must be reusable after cleanup");
        graph
            .remove_imported_conversation(&import_id)
            .await
            .unwrap();
        graph_task.abort();
    }

    #[tokio::test]
    async fn hostile_jsonl_corpus_never_panics_or_publishes_partial_state() {
        let (_directory, app, store, _graph, graph_task) = app(true).await;
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

        // The import-only policy defers graph authority but preserves portable
        // structure. These hostile streams must fail during stage and leave no state.
        let input_case = |mutate: fn(&mut ExportSubmittedInput)| {
            let mut candidate = forged_input_records(ExportCompletionStatus::Failed);
            let ConversationExportRecord::Turn(turn) = &mut candidate[3] else {
                unreachable!()
            };
            mutate(&mut turn.submitted_inputs[0]);
            jsonl(&candidate)
        };
        cases.push(input_case(|input| input.id = "bad".into()));
        cases.push(input_case(|input| input.action.prompt.clear()));

        let mut duplicate_child = forged_input_records(ExportCompletionStatus::Failed);
        let ConversationExportRecord::Turn(turn) = &mut duplicate_child[3] else {
            unreachable!()
        };
        let mut duplicate = turn.submitted_inputs[0].clone();
        duplicate.source.action_id = "action:another-occurrence".into();
        turn.submitted_inputs.push(duplicate);
        sort_submitted_inputs_canonically(turn);
        cases.push(jsonl(&duplicate_child));

        let mut unsorted_children = forged_input_records(ExportCompletionStatus::Failed);
        let ConversationExportRecord::Turn(turn) = &mut unsorted_children[3] else {
            unreachable!()
        };
        let mut other_child = turn.submitted_inputs[0].clone();
        other_child.id = "input-child:aaa".into();
        other_child.source.action_id = "action:another-occurrence".into();
        turn.submitted_inputs.push(other_child);
        sort_submitted_inputs_canonically(turn);
        turn.submitted_inputs.reverse();
        cases.push(jsonl(&unsorted_children));

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
                    attempt_outcome: None,
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
        let (_directory, app, store, _graph, graph_task) = app(true).await;
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
