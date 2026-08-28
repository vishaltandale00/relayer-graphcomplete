use relayer_graph_core::{
    ImportedAcceptedView, ImportedAction, ImportedConversationReceipt, ImportedConversationStage,
    ImportedEdge, ImportedInputSource, ImportedInteractionContext, ImportedInvokeOrigin,
    ImportedLayer, ImportedNode, ImportedResolvedLayer, ImportedSubmittedInput, ImportedTurn,
};
use serde::Serialize;
use thiserror::Error;
use uuid::Uuid;

use crate::{
    conversation_export::{
        ConversationExportHeader, ConversationExportTurn, ConversationExportValidator,
        ExportAction, ExportActionKind, ExportActionVariant, ExportNavigateRelation,
    },
    product::{ProductError, ProductService},
    runtime::{RuntimeClient, RuntimeError},
    storage::{NewConversationImport, StagedConversationImport},
};

#[derive(Debug, Error)]
pub(crate) enum ConversationImportError {
    #[error(transparent)]
    Read(#[from] crate::conversation_export::ExportReadError),
    #[error(transparent)]
    Product(#[from] ProductError),
    #[error(transparent)]
    Runtime(#[from] RuntimeError),
    #[error("invalid conversation import: {0}")]
    Input(String),
    #[error("conversation import cleanup failed after {operation}: {cleanup}")]
    Cleanup { operation: String, cleanup: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationImportReceipt {
    pub import_id: String,
    pub source_sha256: String,
    pub thread_id: i64,
    pub title: String,
    pub producer: crate::conversation_export::ExportProducer,
    pub turns: Vec<ConversationImportTurnReceipt>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationImportTurnReceipt {
    pub source_turn_id: String,
    pub sequence: u32,
    pub interaction_id: i64,
    pub graph_node_id: Option<i64>,
    pub root_layer_id: Option<i64>,
    pub completion_status: crate::conversation_export::ExportCompletionStatus,
}

pub(crate) struct ConversationImportStager {
    staged: StagedConversationImport,
    validator: Option<ConversationExportValidator>,
}

impl ConversationImportStager {
    pub(crate) async fn begin(
        header: ConversationExportHeader,
        product: &ProductService,
    ) -> Result<Self, ConversationImportError> {
        let validator = ConversationExportValidator::new(&header)
            .map_err(crate::conversation_export::ExportReadError::from)?;
        let import_id = Uuid::new_v4().to_string();
        let staged = product
            .stage_conversation_import(NewConversationImport {
                id: &import_id,
                source_sha256: "pending",
                header: &header,
            })
            .await?;
        Ok(Self {
            staged,
            validator: Some(validator),
        })
    }

    pub(crate) async fn push_turn(
        &mut self,
        turn: &ConversationExportTurn,
        product: &ProductService,
    ) -> Result<(), ConversationImportError> {
        self.validator
            .as_mut()
            .expect("unfinished import validator")
            .push_turn(turn)
            .map_err(crate::conversation_export::ExportReadError::from)?;
        let summary = product
            .append_conversation_import_turn(&self.staged.id, turn)
            .await?;
        self.staged.turns.push(summary);
        Ok(())
    }

    pub(crate) async fn finish(
        &mut self,
        source_sha256: String,
        product: &ProductService,
    ) -> Result<ConversationImportReceipt, ConversationImportError> {
        self.validator
            .take()
            .expect("unfinished import validator")
            .finish()
            .map_err(crate::conversation_export::ExportReadError::from)?;
        product
            .finalize_conversation_import_digest(&self.staged.id, &source_sha256)
            .await?;
        Ok(staged_receipt(&self.staged, source_sha256))
    }

    pub(crate) async fn abort(
        &self,
        operation: impl ToString,
        product: &ProductService,
    ) -> ConversationImportError {
        let operation = operation.to_string();
        match product.remove_conversation_import(&self.staged.id).await {
            Ok(()) => ConversationImportError::Input(operation),
            Err(cleanup) => ConversationImportError::Cleanup {
                operation,
                cleanup: cleanup.to_string(),
            },
        }
    }
}

pub(crate) async fn materialize_conversation(
    import_id: &str,
    product: &ProductService,
    runtime: &RuntimeClient,
) -> Result<ConversationImportReceipt, ConversationImportError> {
    let staged = product.staged_conversation_import(import_id).await?;
    let graph_stage = ImportedConversationStage {
        import_id: import_id.to_owned(),
        source_sha256: staged.source_sha256.clone(),
        project_id: None,
        thread_id: relayer_graph_core::ThreadId::new(staged.thread_id.value())
            .expect("stored thread ID is positive"),
        created_at: staged.header.exported_at.clone(),
    };
    if let Err(operation) = runtime.begin_imported_conversation(&graph_stage).await {
        return cleanup_failed_materialization(import_id, operation.to_string(), product, runtime)
            .await;
    }
    for summary in &staged.turns {
        let turn = match product
            .staged_conversation_turn(import_id, &summary.source_turn_id)
            .await
        {
            Ok(turn) => turn,
            Err(operation) => {
                return cleanup_failed_materialization(
                    import_id,
                    operation.to_string(),
                    product,
                    runtime,
                )
                .await;
            }
        };
        let graph_turn = import_turn(turn);
        if let Err(operation) = runtime.stage_imported_turn(import_id, &graph_turn).await {
            return cleanup_failed_materialization(
                import_id,
                operation.to_string(),
                product,
                runtime,
            )
            .await;
        }
    }
    let graph = match runtime.finalize_imported_conversation(import_id).await {
        Ok(receipt) => receipt,
        Err(operation) => {
            return cleanup_failed_materialization(
                import_id,
                operation.to_string(),
                product,
                runtime,
            )
            .await;
        }
    };
    let receipt_matches = graph.turns.len() == staged.turns.len()
        && graph
            .turns
            .iter()
            .zip(&staged.turns)
            .all(|(graph_turn, staged_turn)| {
                graph_turn.source_turn_id == staged_turn.source_turn_id
            });
    if !receipt_matches {
        let operation = ConversationImportError::Input(
            "graph import receipt does not match the staged turn inventory".into(),
        );
        if let Err(cleanup) = runtime.remove_imported_conversation(import_id).await {
            return Err(ConversationImportError::Cleanup {
                operation: operation.to_string(),
                cleanup: cleanup.to_string(),
            });
        }
        product.remove_conversation_import(import_id).await?;
        return Err(operation);
    }
    for turn in &graph.turns {
        let output = turn
            .output
            .as_ref()
            .map(|output| serde_json::to_value(output).expect("completion output serializes"));
        if let Err(operation) = product
            .prepare_conversation_import_turn(
                import_id,
                &turn.source_turn_id,
                turn.graph_node_id,
                output.as_ref(),
            )
            .await
        {
            if let Err(cleanup) = runtime.remove_imported_conversation(import_id).await {
                return Err(ConversationImportError::Cleanup {
                    operation: operation.to_string(),
                    cleanup: cleanup.to_string(),
                });
            }
            if let Err(cleanup) = product.remove_conversation_import(import_id).await {
                return Err(ConversationImportError::Cleanup {
                    operation: operation.to_string(),
                    cleanup: cleanup.to_string(),
                });
            }
            return Err(operation.into());
        }
    }
    Ok(materialized_receipt(&staged, &graph))
}

async fn cleanup_failed_materialization<T>(
    import_id: &str,
    operation: String,
    product: &ProductService,
    runtime: &RuntimeClient,
) -> Result<T, ConversationImportError> {
    if let Err(cleanup) = runtime.remove_imported_conversation(import_id).await {
        return Err(ConversationImportError::Cleanup {
            operation,
            cleanup: cleanup.to_string(),
        });
    }
    if let Err(cleanup) = product.remove_conversation_import(import_id).await {
        return Err(ConversationImportError::Cleanup {
            operation,
            cleanup: cleanup.to_string(),
        });
    }
    Err(ConversationImportError::Input(operation))
}

pub(crate) async fn publish_conversation(
    import_id: &str,
    product: &ProductService,
) -> Result<(), ConversationImportError> {
    let published_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| ConversationImportError::Input(error.to_string()))?
        .as_millis()
        .to_string();
    product
        .publish_conversation_import(import_id, &published_at)
        .await?;
    Ok(())
}

pub(crate) async fn materialize_and_publish_conversation(
    import_id: &str,
    product: &ProductService,
    runtime: &RuntimeClient,
) -> Result<ConversationImportReceipt, ConversationImportError> {
    let receipt = materialize_conversation(import_id, product, runtime).await?;
    if let Err(operation) = publish_conversation(import_id, product).await {
        if let Err(cleanup) = runtime.remove_imported_conversation(import_id).await {
            return Err(ConversationImportError::Cleanup {
                operation: operation.to_string(),
                cleanup: cleanup.to_string(),
            });
        }
        if let Err(cleanup) = product.remove_conversation_import(import_id).await {
            return Err(ConversationImportError::Cleanup {
                operation: operation.to_string(),
                cleanup: cleanup.to_string(),
            });
        }
        return Err(operation);
    }
    Ok(receipt)
}

pub(crate) async fn remove_conversation(
    import_id: &str,
    product: &ProductService,
    runtime: &RuntimeClient,
) -> Result<(), ConversationImportError> {
    if let Err(operation) = runtime.remove_imported_conversation(import_id).await {
        return Err(operation.into());
    }
    if let Err(cleanup) = product.remove_conversation_import(import_id).await {
        return Err(ConversationImportError::Cleanup {
            operation: "removed staged graph import".into(),
            cleanup: cleanup.to_string(),
        });
    }
    Ok(())
}

fn staged_receipt(
    staged: &StagedConversationImport,
    source_sha256: String,
) -> ConversationImportReceipt {
    ConversationImportReceipt {
        import_id: staged.id.clone(),
        source_sha256,
        thread_id: staged.thread_id.value(),
        title: staged.header.conversation.title.clone(),
        producer: staged.header.producer.clone(),
        turns: staged
            .turns
            .iter()
            .map(|turn| ConversationImportTurnReceipt {
                source_turn_id: turn.source_turn_id.clone(),
                sequence: turn.sequence,
                interaction_id: turn.interaction_id.value(),
                graph_node_id: None,
                root_layer_id: None,
                completion_status: turn.completion_status,
            })
            .collect(),
    }
}

fn materialized_receipt(
    staged: &StagedConversationImport,
    graph: &ImportedConversationReceipt,
) -> ConversationImportReceipt {
    let mut receipt = staged_receipt(staged, staged.source_sha256.clone());
    for (turn, graph_turn) in receipt.turns.iter_mut().zip(&graph.turns) {
        turn.graph_node_id = graph_turn.graph_node_id;
        turn.root_layer_id = graph_turn.root_layer_id;
    }
    receipt
}

fn import_turn(turn: ConversationExportTurn) -> ImportedTurn {
    let invoke_origin = match turn.origin {
        crate::conversation_export::ExportTurnOrigin::User => None,
        crate::conversation_export::ExportTurnOrigin::Action {
            source_turn_id,
            source_action_id,
        } => Some(ImportedInvokeOrigin {
            source_turn_id,
            source_action_id,
        }),
    };
    ImportedTurn {
        source_turn_id: turn.id,
        text: turn.text,
        interaction_node_id: turn.interaction_node_id,
        invoke_origin,
        contexts: turn
            .contexts
            .into_iter()
            .map(|context| ImportedInteractionContext {
                id: context.id,
                target: ImportedNode {
                    id: context.target.id,
                    kind: context.target.kind,
                    icon: context.target.icon,
                    title: context.target.title,
                    detail: context.target.detail,
                },
                source_interaction_node_id: context.source.interaction_node_id,
                source_layer_id: context.source.layer_id,
                annotations: context.annotations,
            })
            .collect(),
        submitted_inputs: turn
            .submitted_inputs
            .into_iter()
            .map(|submitted| ImportedSubmittedInput {
                id: submitted.id,
                root_turn_id: submitted.root_turn_id,
                source: ImportedInputSource {
                    interaction_node_id: submitted.source.interaction_node_id,
                    layer_id: submitted.source.layer_id,
                    action_id: submitted.source.action_id,
                    node_id: submitted.source.node_id,
                },
                action: relayer_graph_core::InputAction {
                    control: match submitted.action.control {
                        crate::conversation_export::ExportInputControl::Text => {
                            relayer_graph_core::InputControl::Text
                        }
                        crate::conversation_export::ExportInputControl::SingleSelect => {
                            relayer_graph_core::InputControl::SingleSelect
                        }
                        crate::conversation_export::ExportInputControl::MultiSelect => {
                            relayer_graph_core::InputControl::MultiSelect
                        }
                    },
                    prompt: submitted.action.prompt,
                    options: submitted
                        .action
                        .options
                        .into_iter()
                        .map(|option| relayer_graph_core::InputOption {
                            key: option.key,
                            label: option.label,
                        })
                        .collect(),
                    minimum_selections: submitted
                        .action
                        .minimum_selections
                        .map(|minimum| minimum as usize),
                },
                value: match submitted.value {
                    crate::conversation_export::ExportSubmittedInputValue::Text { text } => {
                        relayer_graph_core::SubmittedInputValue::Text { text }
                    }
                    crate::conversation_export::ExportSubmittedInputValue::Selected {
                        selected,
                    } => relayer_graph_core::SubmittedInputValue::Selected {
                        selected: selected
                            .into_iter()
                            .map(|option| relayer_graph_core::InputOption {
                                key: option.key,
                                label: option.label,
                            })
                            .collect(),
                    },
                },
            })
            .collect(),
        accepted_view: turn.accepted_view.map(|view| ImportedAcceptedView {
            interaction_node_id: view.interaction_node_id,
            root_action: import_action(view.root_action),
            root_layer_id: view.root_layer_id,
            layers: view
                .layers
                .into_iter()
                .map(|resolved| ImportedResolvedLayer {
                    layer: ImportedLayer {
                        id: resolved.layer.id,
                        nodes: resolved.layer.nodes,
                        edges: resolved.layer.edges,
                        layout: resolved.layer.layout.map(|layout| {
                            relayer_graph_core::ImportedLayerLayout {
                                version: layout.version,
                                placements: layout
                                    .placements
                                    .into_iter()
                                    .map(|placement| relayer_graph_core::ImportedNodePlacement {
                                        node_id: placement.node_id,
                                        x: placement.x,
                                        y: placement.y,
                                    })
                                    .collect(),
                            }
                        }),
                    },
                    nodes: resolved
                        .nodes
                        .into_iter()
                        .map(|node| ImportedNode {
                            id: node.id,
                            kind: node.kind,
                            icon: node.icon,
                            title: node.title,
                            detail: node.detail,
                        })
                        .collect(),
                    edges: resolved
                        .edges
                        .into_iter()
                        .map(|edge| ImportedEdge {
                            id: edge.id,
                            endpoints: edge.endpoints,
                        })
                        .collect(),
                    actions: resolved.actions.into_iter().map(import_action).collect(),
                })
                .collect(),
        }),
    }
}

fn import_action(action: ExportAction) -> ImportedAction {
    ImportedAction {
        id: action.id,
        source_node_id: action.source_node_id,
        source_layer_id: action.source_layer_id,
        kind: match action.kind {
            ExportActionKind::Navigate => "navigate",
            ExportActionKind::Invoke => "invoke",
            ExportActionKind::Input => "input",
        }
        .into(),
        relation: action.relation.map(|relation| {
            match relation {
                ExportNavigateRelation::Expand => "expand",
                ExportNavigateRelation::Reference => "reference",
            }
            .into()
        }),
        label: action.label,
        variant: match action.variant {
            ExportActionVariant::Chip => "chip",
            ExportActionVariant::Pill => "pill",
            ExportActionVariant::Wide => "wide",
            ExportActionVariant::Card => "card",
        }
        .into(),
        icon: action.icon,
        description: action.description,
        target_layer_id: action.target_layer_id,
        interaction_text: action.interaction_text,
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

    use relayer_graph_core::GraphDatabase;

    use super::{ConversationImportStager, materialize_conversation, remove_conversation};
    use crate::{
        conversation_export::{
            ConversationExportHeader, ConversationExportTurn, EXPORT_VERSION_V1,
            ExportCompletionReceipt, ExportCompletionStatus, ExportContextSource,
            ExportContextTargetSnapshot, ExportConversation, ExportInteractionContext,
            ExportProducer, ExportRecordState, ExportTurnManifestEntry, ExportTurnOrigin,
        },
        product::ProductService,
        runtime::RuntimeClient,
        storage::SqliteProductStore,
    };

    fn header() -> ConversationExportHeader {
        ConversationExportHeader {
            export_version: EXPORT_VERSION_V1,
            exported_at: "1770000000000".into(),
            producer: ExportProducer {
                desktop_version: "0.2.12".into(),
                build_commit: "test-commit".into(),
                platform: "darwin".into(),
                architecture: "arm64".into(),
            },
            conversation: ExportConversation {
                id: "conversation:reconciliation".into(),
                title: "Interrupted import".into(),
                created_at: "1769000000000".into(),
                project_name: None,
                harness_configuration_name: "codex-basic".into(),
                permission_profile_id: "auto".into(),
            },
            turns: vec![ExportTurnManifestEntry {
                id: "turn:1".into(),
                sequence: 1,
            }],
        }
    }

    fn turn() -> ConversationExportTurn {
        ConversationExportTurn {
            id: "turn:1".into(),
            sequence: 1,
            created_at: "1769000001000".into(),
            text: "Why did this happen?".into(),
            interaction_node_id: None,
            origin: ExportTurnOrigin::User,
            completion: ExportCompletionReceipt {
                status: ExportCompletionStatus::Failed,
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
            },
            contexts: vec![],
            submitted_inputs: vec![],
            accepted_view: None,
        }
    }

    async fn product(path: &Path) -> ProductService {
        ProductService::new(SqliteProductStore::open(path).await.unwrap(), true)
    }

    async fn stage(product: &ProductService) -> String {
        let mut stager = ConversationImportStager::begin(header(), product)
            .await
            .unwrap();
        stager.push_turn(&turn(), product).await.unwrap();
        stager
            .finish("sha256:fixture".into(), product)
            .await
            .unwrap()
            .import_id
    }

    async fn runtime(
        graph: GraphDatabase,
        catalog_root: &Path,
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
        let catalog = catalog_root.join("catalog.json");
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

    #[tokio::test]
    async fn staged_product_cleanup_is_foreign_key_safe_and_durable() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("product.sqlite");
        let product = product(&database).await;
        let import_id = stage(&product).await;

        product
            .remove_conversation_import(&import_id)
            .await
            .unwrap();
        drop(product);

        let reopened = SqliteProductStore::open(&database).await.unwrap();
        assert!(
            reopened
                .staged_conversation_import_ids()
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn product_only_stage_survives_restart_for_reconciliation() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("product.sqlite");
        let product = product(&database).await;
        let import_id = stage(&product).await;
        drop(product);

        let reopened_store = SqliteProductStore::open(&database).await.unwrap();
        assert_eq!(
            reopened_store
                .staged_conversation_import_ids()
                .await
                .unwrap(),
            vec![import_id.clone()]
        );
        let reopened = ProductService::new(reopened_store, true);
        let (runtime, graph_task) =
            runtime(GraphDatabase::in_memory().await.unwrap(), directory.path()).await;
        remove_conversation(&import_id, &reopened, &runtime)
            .await
            .unwrap();
        graph_task.abort();
    }

    #[tokio::test]
    async fn graph_commit_before_product_publish_reconciles_after_restart() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("product.sqlite");
        let product = product(&database).await;
        let import_id = stage(&product).await;
        let (runtime, graph_task) =
            runtime(GraphDatabase::in_memory().await.unwrap(), directory.path()).await;

        materialize_conversation(&import_id, &product, &runtime)
            .await
            .unwrap();
        drop(product);

        let reopened_store = SqliteProductStore::open(&database).await.unwrap();
        assert_eq!(
            reopened_store
                .staged_conversation_import_ids()
                .await
                .unwrap(),
            vec![import_id.clone()]
        );
        let reopened = ProductService::new(reopened_store, true);
        remove_conversation(&import_id, &reopened, &runtime)
            .await
            .unwrap();
        graph_task.abort();
    }

    #[tokio::test]
    async fn failed_import_materializes_ordered_context_as_read_only_graph_input() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("product.sqlite");
        let product = product(&database).await;
        let mut imported_turn = turn();
        imported_turn.interaction_node_id = Some("node:input".into());
        imported_turn.contexts = vec![ExportInteractionContext {
            id: "action:context".into(),
            target: ExportContextTargetSnapshot {
                id: "node:target".into(),
                kind: "concept".into(),
                icon: "file".into(),
                title: "Portable target".into(),
                detail: "No local path or database ID".into(),
                state: ExportRecordState::Accepted,
            },
            source: ExportContextSource {
                interaction_node_id: "node:foreign-source".into(),
                layer_id: "layer:foreign-source".into(),
            },
            annotations: vec!["First".into(), "Second".into()],
        }];
        let mut stager = ConversationImportStager::begin(header(), &product)
            .await
            .unwrap();
        stager.push_turn(&imported_turn, &product).await.unwrap();
        let import_id = stager
            .finish("sha256:context".into(), &product)
            .await
            .unwrap()
            .import_id;
        let (runtime, graph_task) =
            runtime(GraphDatabase::in_memory().await.unwrap(), directory.path()).await;

        let receipt = materialize_conversation(&import_id, &product, &runtime)
            .await
            .unwrap();
        let graph_node_id = receipt.turns[0].graph_node_id.unwrap();
        assert_eq!(
            receipt.turns[0].completion_status,
            ExportCompletionStatus::Failed
        );
        let input = runtime.interaction_input(graph_node_id).await.unwrap();
        assert_eq!(input.contexts.len(), 1);
        assert_eq!(input.contexts[0].annotations, ["First", "Second"]);
        assert_eq!(input.contexts[0].target_node.title, "Portable target");
        assert!(
            runtime
                .completion_output(graph_node_id)
                .await
                .unwrap()
                .is_none()
        );

        remove_conversation(&import_id, &product, &runtime)
            .await
            .unwrap();
        graph_task.abort();
    }

    #[tokio::test]
    async fn graph_delete_failure_retains_product_marker_for_retry() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("product.sqlite");
        let product = product(&database).await;
        let import_id = stage(&product).await;
        let catalog = directory.path().join("unavailable-catalog.json");
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
        let unavailable = RuntimeClient::open(
            "http://127.0.0.1:9/",
            "http://127.0.0.1:10/",
            "graph-control".into(),
            "harness-control".into(),
            &catalog,
        )
        .await
        .unwrap();

        assert!(
            remove_conversation(&import_id, &product, &unavailable)
                .await
                .is_err()
        );
        drop(product);
        let reopened_store = SqliteProductStore::open(&database).await.unwrap();
        assert_eq!(
            reopened_store
                .staged_conversation_import_ids()
                .await
                .unwrap(),
            vec![import_id.clone()]
        );
        let reopened = ProductService::new(reopened_store, true);
        let (available, graph_task) =
            runtime(GraphDatabase::in_memory().await.unwrap(), directory.path()).await;
        remove_conversation(&import_id, &reopened, &available)
            .await
            .unwrap();
        graph_task.abort();
    }
}
