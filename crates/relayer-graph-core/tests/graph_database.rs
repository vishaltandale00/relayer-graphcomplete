use relayer_graph_core::*;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

fn project(value: i64) -> ProjectId {
    ProjectId::new(value).unwrap()
}

fn thread(value: i64) -> ThreadId {
    ThreadId::new(value).unwrap()
}

// Tests of pre-contract permission versions must actually reconstruct historical
// state. Public preparation cannot remove or rewrite a sealed contract.
async fn emulate_legacy_contract(pool: &sqlx::SqlitePool, interaction: NodeId) {
    sqlx::query("DROP TRIGGER completion_contract_marker_guard")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("DROP TRIGGER completion_contract_delete_guard")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE completion_states SET completion_contract_digest=NULL WHERE interaction_node_id=?1",
    )
    .bind(interaction.value())
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM completion_contracts WHERE interaction_node_id=?1")
        .bind(interaction.value())
        .execute(pool)
        .await
        .unwrap();
}

fn authored_layout(nodes: impl IntoIterator<Item = NodeId>) -> Option<LayerLayout> {
    let nodes = nodes.into_iter().collect::<Vec<_>>();
    let last = nodes.len().saturating_sub(1).max(1) as f64;
    Some(LayerLayout::v1(
        nodes
            .into_iter()
            .enumerate()
            .map(|(index, node_id)| NodePlacement {
                node_id,
                x: if last == 1.0 && index == 0 {
                    0.5
                } else {
                    index as f64 / last
                },
                y: 0.5,
            })
            .collect(),
        "default",
    ))
}

#[tokio::test]
async fn personal_presentation_thread_is_reserved_from_ordinary_creation() {
    let database = GraphDatabase::in_memory().await.unwrap();
    let reserved = thread(PERSONAL_PRESENTATION_PROFILE_THREAD_ID);
    let ordinary = database
        .create_interaction(None, reserved, "ordinary")
        .await
        .unwrap_err();
    assert!(matches!(
        ordinary,
        GraphError::Validation {
            code: "reserved_personal_presentation_thread",
            ..
        }
    ));
    let imported = database
        .begin_imported_conversation(&ImportedConversationStage {
            inert_invocations: Vec::new(),
            standalone_inputs: Vec::new(),
            import_id: "reserved-import".into(),
            source_sha256: "sha256:test".into(),
            project_id: None,
            thread_id: reserved,
            created_at: "2026-08-28T00:00:00Z".into(),
        })
        .await
        .unwrap_err();
    assert!(matches!(
        imported,
        GraphError::Validation {
            code: "reserved_personal_presentation_thread",
            ..
        }
    ));

    let submitted = SubmittedInputDraft {
        occurrence: PresentingInputOccurrence {
            presenting_interaction_node_id: NodeId::new(1).unwrap(),
            presenting_layer_id: LayerId::new(1).unwrap(),
            action_id: ActionId::new(1).unwrap(),
        },
        action: InputAction {
            control: InputControl::Text,
            prompt: "Profile input".into(),
            options: vec![],
            minimum_selections: None,
            unsupported_fields: Default::default(),
        },
        value: SubmittedInputValue::Text {
            text: "ordinary".into(),
        },
    };
    let submitted_digest =
        interaction_input_authority_digest("", std::slice::from_ref(&submitted)).unwrap();
    let submitted_error = database
        .create_identified_interaction_with_inputs(
            None,
            reserved,
            "",
            InteractionInputPreparation {
                attempt_key: "relayer.personal-presentation:personal-presentation-v0",
                authority_digest: &submitted_digest,
                contexts: &[],
                submitted_inputs: &[submitted],
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(
        submitted_error,
        GraphError::Validation {
            code: "reserved_personal_presentation_thread",
            path,
            ..
        } if path == "threadId"
    ));

    let digest = interaction_input_digest("profile", &[]).unwrap();
    let profile = database
        .create_personal_presentation_interaction(
            "profile",
            "relayer.personal-presentation:personal-presentation-v0",
            &digest,
        )
        .await
        .unwrap();
    let ordinary = database
        .create_interaction(None, thread(1), "ordinary")
        .await
        .unwrap();
    let ordinary_writer = database.writer_for_subgraph(ordinary.id).await.unwrap();
    assert!(ordinary_writer.get_node(profile.id).await.is_err());
}

async fn setup(project_id: Option<ProjectId>, thread_id: ThreadId) -> (GraphDatabase, GraphNode) {
    let database = GraphDatabase::in_memory().await.unwrap();
    let interaction = database
        .create_interaction(project_id, thread_id, "Explain the queue")
        .await
        .unwrap();
    (database, interaction)
}

async fn personal_presentation_interaction(
    database: &GraphDatabase,
    text: &str,
    identity: &str,
) -> GraphNode {
    let digest = interaction_input_digest(text, &[]).unwrap();
    database
        .create_personal_presentation_interaction(text, identity, &digest)
        .await
        .unwrap()
}

fn imported_conversation(interaction_node_id: &str) -> ImportedConversation {
    ImportedConversation {
        import_id: "import-1".into(),
        source_sha256: "sha256:abc".into(),
        project_id: None,
        thread_id: thread(9001),
        created_at: "2026-08-24T00:00:00Z".into(),
        turns: vec![ImportedTurn {
            source_turn_id: "turn-1".into(),
            text: "Explain the queue".into(),
            interaction_node_id: None,
            invoke_origin: None,
            contexts: vec![],
            submitted_inputs: vec![],
            accepted_view: Some(ImportedAcceptedView {
                interaction_node_id: interaction_node_id.into(),
                root_action: ImportedAction {
                    reusable: None,
                    input_action_ids: Vec::new(),
                    icon_asset: None,
                    converted_from_invoke: false,
                    id: "action-1".into(),
                    client_key: None,
                    source_node_id: interaction_node_id.into(),
                    source_layer_id: None,
                    kind: "navigate".into(),
                    relation: Some("expand".into()),
                    label: "Response".into(),
                    variant: "pill".into(),
                    icon: None,
                    description: None,
                    target_layer_id: Some("layer-1".into()),
                    interaction_text: None,
                    input: None,
                },
                root_layer_id: "layer-1".into(),
                layers: vec![ImportedResolvedLayer {
                    layer: ImportedLayer {
                        default_node_id: None,
                        id: "layer-1".into(),
                        client_key: None,
                        nodes: vec!["node-1".into()],
                        edges: vec![],
                        layout: Some(ImportedLayerLayout {
                            version: 1,
                            placements: vec![ImportedNodePlacement {
                                node_id: "node-1".into(),
                                x: 0.25,
                                y: 0.75,
                            }],
                            edge_shape: None,
                            edge_routes: Vec::new(),
                        }),
                        renderer: None,
                    },
                    nodes: vec![ImportedNode {
                        id: "node-1".into(),
                        client_key: None,
                        kind: "concept".into(),
                        icon: "box".into(),
                        title: "Queue".into(),
                        detail: "A queue".into(),
                        authored_detail: None,
                        authored_detail_omitted: false,
                        authored_detail_assets: Vec::new(),
                        artifact: None,
                    }],
                    edges: vec![],
                    actions: vec![],
                }],
            }),
        }],
    }
}

fn rename_simple_imported_turn(
    mut turn: ImportedTurn,
    turn_id: &str,
    interaction_id: &str,
    layer_id: &str,
    node_id: &str,
) -> ImportedTurn {
    turn.source_turn_id = turn_id.into();
    let view = turn.accepted_view.as_mut().unwrap();
    view.interaction_node_id = interaction_id.into();
    view.root_layer_id = layer_id.into();
    view.root_action.id = format!("root-action-{interaction_id}");
    view.root_action.source_node_id = interaction_id.into();
    view.root_action.target_layer_id = Some(layer_id.into());
    for layer in &mut view.layers {
        layer.layer.id = layer_id.into();
        layer.layer.nodes = vec![node_id.into()];
        if let Some(layout) = &mut layer.layer.layout {
            for placement in &mut layout.placements {
                placement.node_id = node_id.into();
            }
        }
        for node in &mut layer.nodes {
            node.id = node_id.into();
        }
        for action in &mut layer.actions {
            action.source_node_id = node_id.into();
            action.source_layer_id = Some(layer_id.into());
        }
    }
    if let Some(interaction_node_id) = &mut turn.interaction_node_id {
        *interaction_node_id = format!("input-root-{interaction_id}");
    }
    turn
}

fn imported_invoke_conversation() -> ImportedConversation {
    let source = ImportedTurn {
        source_turn_id: "turn-1".into(),
        text: "Choose a path".into(),
        interaction_node_id: None,
        invoke_origin: None,
        contexts: vec![],
        submitted_inputs: vec![],
        accepted_view: Some(ImportedAcceptedView {
            interaction_node_id: "interaction-1".into(),
            root_action: ImportedAction {
                reusable: None,
                input_action_ids: Vec::new(),
                icon_asset: None,
                converted_from_invoke: false,
                id: "root-action-1".into(),
                client_key: Some("authored-root-action-1".into()),
                source_node_id: "interaction-1".into(),
                source_layer_id: None,
                kind: "navigate".into(),
                relation: Some("expand".into()),
                label: "Response".into(),
                variant: "pill".into(),
                icon: None,
                description: None,
                target_layer_id: Some("layer-1".into()),
                interaction_text: None,
                input: None,
            },
            root_layer_id: "layer-1".into(),
            layers: vec![ImportedResolvedLayer {
                layer: ImportedLayer {
                    default_node_id: None,
                    id: "layer-1".into(),
                    client_key: Some("authored-layer-1".into()),
                    nodes: vec!["node-1".into()],
                    edges: vec![],
                    layout: None,
                    renderer: None,
                },
                nodes: vec![ImportedNode {
                    id: "node-1".into(),
                    client_key: Some("authored-node-1".into()),
                    kind: "concept".into(),
                    icon: "box".into(),
                    title: "Path".into(),
                    detail: "Invoke this path".into(),
                    authored_detail: None,
                    authored_detail_omitted: false,
                    authored_detail_assets: Vec::new(),
                    artifact: None,
                }],
                edges: vec![],
                actions: vec![ImportedAction {
                    reusable: None,
                    input_action_ids: Vec::new(),
                    icon_asset: None,
                    converted_from_invoke: false,
                    id: "invoke-action-1".into(),
                    client_key: Some("authored-invoke-action-1".into()),
                    source_node_id: "node-1".into(),
                    source_layer_id: Some("layer-1".into()),
                    kind: "invoke".into(),
                    relation: None,
                    label: "Continue".into(),
                    variant: "pill".into(),
                    icon: None,
                    description: None,
                    target_layer_id: None,
                    interaction_text: Some("Continue this path".into()),
                    input: None,
                }],
            }],
        }),
    };
    let destination = ImportedTurn {
        source_turn_id: "turn-2".into(),
        text: "Continue this path".into(),
        interaction_node_id: None,
        invoke_origin: Some(ImportedInvokeOrigin {
            source_turn_id: "turn-1".into(),
            source_action_id: "invoke-action-1".into(),
        }),
        contexts: vec![],
        submitted_inputs: vec![],
        accepted_view: Some(ImportedAcceptedView {
            interaction_node_id: "interaction-2".into(),
            root_action: ImportedAction {
                reusable: None,
                input_action_ids: Vec::new(),
                icon_asset: None,
                converted_from_invoke: false,
                id: "root-action-2".into(),
                client_key: None,
                source_node_id: "interaction-2".into(),
                source_layer_id: None,
                kind: "navigate".into(),
                relation: Some("expand".into()),
                label: "Response".into(),
                variant: "pill".into(),
                icon: None,
                description: None,
                target_layer_id: Some("layer-2".into()),
                interaction_text: None,
                input: None,
            },
            root_layer_id: "layer-2".into(),
            layers: vec![ImportedResolvedLayer {
                layer: ImportedLayer {
                    default_node_id: None,
                    id: "layer-2".into(),
                    client_key: None,
                    nodes: vec!["node-2".into()],
                    edges: vec![],
                    layout: None,
                    renderer: None,
                },
                nodes: vec![ImportedNode {
                    id: "node-2".into(),
                    client_key: None,
                    kind: "concept".into(),
                    icon: "box".into(),
                    title: "Destination".into(),
                    detail: "Imported result".into(),
                    authored_detail: None,
                    authored_detail_omitted: false,
                    authored_detail_assets: Vec::new(),
                    artifact: None,
                }],
                edges: vec![],
                actions: vec![],
            }],
        }),
    };
    ImportedConversation {
        import_id: "import-invoke".into(),
        source_sha256: "sha256:invoke".into(),
        project_id: None,
        thread_id: thread(9002),
        created_at: "2026-08-24T00:00:00Z".into(),
        turns: vec![source, destination],
    }
}

#[tokio::test]
async fn imported_conversation_is_materialized_read_only_and_removable() {
    let database = GraphDatabase::in_memory().await.unwrap();
    database
        .set_interaction_permissions_enabled(true)
        .await
        .unwrap();
    database
        .remove_imported_conversation("missing-import")
        .await
        .unwrap();
    let mut input = imported_conversation("interaction-1");
    input.turns[0].accepted_view.as_mut().unwrap().layers[0]
        .layer
        .default_node_id = Some("interaction-1".into());
    assert!(matches!(
        database
            .import_accepted_conversation(&input)
            .await
            .unwrap_err(),
        GraphError::Validation {
            code: "default_node_outside_layer",
            ..
        }
    ));
    input.turns[0].accepted_view.as_mut().unwrap().layers[0]
        .layer
        .default_node_id = Some("node-1".into());
    let receipt = database.import_accepted_conversation(&input).await.unwrap();
    let turn = &receipt.turns[0];
    let restored = &turn.output.as_ref().unwrap().root_layer;
    assert_eq!(restored.layer.default_node_id, Some(restored.nodes[0].id));
    assert!(turn.output.is_some());
    let layout = turn
        .output
        .as_ref()
        .unwrap()
        .root_layer
        .layer
        .layout
        .as_ref()
        .unwrap();
    assert_eq!(layout.version, 1);
    assert_eq!(layout.placements()[0].x, 0.25);
    assert_eq!(layout.placements()[0].y, 0.75);

    let writer = database
        .writer_for_subgraph(NodeId::new(turn.graph_node_id.unwrap()).unwrap())
        .await
        .unwrap();
    assert!(writer.live_answers(0).await.is_err());
    let root = NodeId::new(turn.graph_node_id.unwrap()).unwrap();
    assert!(matches!(
        database
            .accept_live_answer(
                root,
                input.thread_id,
                &LiveAnswerRequest {
                    attempt_id: 1,
                    authority_epoch: 1,
                    expected_revision: 1,
                    operation_key: "imported-answer".into(),
                    occurrence: PresentingInputOccurrence {
                        presenting_interaction_node_id: root,
                        presenting_layer_id: restored.layer.id,
                        action_id: ActionId::new(1).unwrap()
                    },
                    value: SubmittedInputValue::Text {
                        text: "Cannot answer imported work".into()
                    },
                }
            )
            .await,
        Err(GraphError::Validation {
            code: "live_answer_root_only",
            ..
        })
    ));
    assert!(
        writer
            .authorize_interaction_permission(&InteractionPermission::NavigateAdd {
                node_id: turn.output.as_ref().unwrap().root_layer.nodes[0].id
            })
            .await
            .is_err()
    );
    assert_eq!(
        database
            .interaction_permissions(NodeId::new(turn.graph_node_id.unwrap()).unwrap())
            .await
            .unwrap(),
        None
    );
    let error = writer
        .submit_node(&NodeDraft {
            client_key: "mutation".into(),
            kind: "concept".into(),
            icon: "box".into(),
            title: "Mutation".into(),
            detail: "Must not be written".into(),
        })
        .await
        .unwrap_err();
    assert!(matches!(error, GraphError::Forbidden(_)));

    database
        .remove_imported_conversation(&input.import_id)
        .await
        .unwrap();
    assert!(
        database
            .writer_for_subgraph(NodeId::new(turn.graph_node_id.unwrap()).unwrap())
            .await
            .is_err()
    );
    database
        .remove_imported_conversation(&input.import_id)
        .await
        .unwrap();
}

#[tokio::test]
async fn imported_stage_without_publications_can_be_removed() {
    let database = GraphDatabase::in_memory().await.unwrap();
    database
        .begin_imported_conversation(&ImportedConversationStage {
            inert_invocations: Vec::new(),
            standalone_inputs: Vec::new(),
            import_id: "empty-stage".into(),
            source_sha256: "source-digest".into(),
            project_id: None,
            thread_id: ThreadId::new(7001).unwrap(),
            created_at: "2026-09-25T00:00:00Z".into(),
        })
        .await
        .unwrap();

    database
        .remove_imported_conversation("empty-stage")
        .await
        .unwrap();
    // Reusing the same import identity and thread proves the staged row was
    // removed even though there were no graph publications to inspect.
    database
        .begin_imported_conversation(&ImportedConversationStage {
            inert_invocations: Vec::new(),
            standalone_inputs: Vec::new(),
            import_id: "empty-stage".into(),
            source_sha256: "source-digest".into(),
            project_id: None,
            thread_id: ThreadId::new(7001).unwrap(),
            created_at: "2026-09-25T00:00:00Z".into(),
        })
        .await
        .unwrap();
    database
        .remove_imported_conversation("empty-stage")
        .await
        .unwrap();
}

#[tokio::test]
async fn imported_conversation_reconnects_the_canonical_authored_detail_to_its_node() {
    let database = GraphDatabase::in_memory().await.unwrap();
    let mut input = imported_conversation("interaction-1");
    input.turns[0].accepted_view.as_mut().unwrap().layers[0].nodes[0].authored_detail = Some(
        serde_json::json!({
            "version": 1,
            "components": [{"id":"overview","order":0,"html":"<p>Accepted</p>","css":"p{color:#fff}"}],
            "mounts": [],
            "assets": [],
            "integritySha256": "6c34582a24f665dfcf9efa843fdb254a646de79c505d76c80863f81ed8dfe659"
        }),
    );
    let accepted_node = input.turns[0].accepted_view.as_ref().unwrap().layers[0].nodes[0].clone();
    input.turns[0].contexts.push(ImportedInteractionContext {
        id: "context-action".into(),
        target: ImportedNode {
            authored_detail: None,
            ..accepted_node
        },
        source_interaction_node_id: "source-interaction".into(),
        source_layer_id: "source-layer".into(),
        annotations: vec!["Legacy context projection omits authored detail".into()],
    });

    let receipt = database.import_accepted_conversation(&input).await.unwrap();
    let node = &receipt.turns[0].output.as_ref().unwrap().root_layer.nodes[0];

    assert_eq!(
        node.authored_detail.as_ref().unwrap()["components"][0]["id"],
        "overview"
    );
}

#[tokio::test]
async fn imported_conversation_notes_an_authored_detail_the_export_omitted() {
    let database = GraphDatabase::in_memory().await.unwrap();
    let mut input = imported_conversation("interaction-1");
    let layer = &mut input.turns[0].accepted_view.as_mut().unwrap().layers[0];
    let original_detail = layer.nodes[0].detail.clone();
    layer.nodes[0].authored_detail_omitted = true;
    // Context snapshots of the same node never carry the marker; the import
    // identity check must still treat both as one portable node.
    let accepted_node = layer.nodes[0].clone();
    input.turns[0].contexts.push(ImportedInteractionContext {
        id: "context-action".into(),
        target: ImportedNode {
            authored_detail_omitted: false,
            authored_detail_assets: Vec::new(),
            ..accepted_node
        },
        source_interaction_node_id: "source-interaction".into(),
        source_layer_id: "source-layer".into(),
        annotations: vec![],
    });

    let receipt = database.import_accepted_conversation(&input).await.unwrap();
    let node = &receipt.turns[0].output.as_ref().unwrap().root_layer.nodes[0];

    assert_eq!(node.authored_detail, None);
    assert_eq!(
        node.detail,
        format!("{original_detail}\n\n{IMPORTED_AUTHORED_DETAIL_OMITTED_NOTE}")
    );
}

/// The answer graph from `imported_conversation` with a node that opens an artifact layer.
fn imported_artifact_conversation() -> ImportedConversation {
    let mut input = imported_conversation("interaction-1");
    let view = input.turns[0].accepted_view.as_mut().unwrap();
    view.layers[0].actions.push(ImportedAction {
        id: "open-site".into(),
        source_node_id: "node-1".into(),
        source_layer_id: Some("layer-1".into()),
        label: "Open the site".into(),
        target_layer_id: Some("layer-site".into()),
        ..view.root_action.clone()
    });
    let site = ImportedNode {
        id: "node-site".into(),
        title: "Landing page".into(),
        artifact: Some(
            serde_json::json!({"kind": "url", "source": {"url": "https://example.com/"}}),
        ),
        ..view.layers[0].nodes[0].clone()
    };
    view.layers.push(ImportedResolvedLayer {
        layer: ImportedLayer {
            default_node_id: None,
            id: "layer-site".into(),
            client_key: None,
            nodes: vec!["node-site".into()],
            edges: vec![],
            layout: None,
            renderer: Some("artifact".into()),
        },
        nodes: vec![site],
        edges: vec![],
        actions: vec![],
    });
    input
}

#[tokio::test]
async fn imported_artifact_layers_keep_their_identity_and_never_answer_directly() {
    // A note on an artifact makes it a context target; that copy carries no artifact details.
    let mut input = imported_artifact_conversation();
    let site = input.turns[0].accepted_view.as_ref().unwrap().layers[1].nodes[0].clone();
    let expected_artifact = site.artifact.clone();
    input.turns[0].contexts.push(ImportedInteractionContext {
        id: "context-note".into(),
        target: ImportedNode {
            artifact: None,
            ..site
        },
        source_interaction_node_id: "source-interaction".into(),
        source_layer_id: "source-layer".into(),
        annotations: vec!["The logo flickers here".into()],
    });
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("imported-artifact.sqlite3");
    let database = GraphDatabase::open(&path).await.unwrap();
    let imported = database.import_accepted_conversation(&input).await.unwrap();
    let interaction = NodeId::new(imported.turns[0].graph_node_id.unwrap()).unwrap();
    let root_layer = LayerId::new(imported.turns[0].root_layer_id.unwrap()).unwrap();
    database.close().await;
    let reopened = GraphDatabase::open(&path).await.unwrap();
    let writer = reopened.writer_for_subgraph(interaction).await.unwrap();
    let root = writer.get_layer(root_layer).await.unwrap();
    let artifact_layer = root
        .actions
        .iter()
        .find(|action| action.label == "Open the site")
        .unwrap()
        .target_layer_id
        .unwrap();
    let artifact = writer.get_layer(artifact_layer).await.unwrap();
    assert_eq!(artifact.layer.renderer.as_deref(), Some("artifact"));
    assert_eq!(artifact.nodes.len(), 1);
    assert_eq!(artifact.nodes[0].artifact, expected_artifact);
    // Portable data remains inert: import/reopen does not seal execution authority.
    assert!(
        writer
            .interaction_input()
            .await
            .unwrap()
            .completion_contract
            .is_none()
    );
    assert!(matches!(
        writer.complete(interaction).await,
        Err(GraphError::Forbidden(_))
    ));
    assert!(matches!(
        writer
            .transition_current(
                0,
                "imported-advance",
                CurrentTransition::Advance {
                    layer_id: root_layer,
                }
            )
            .await,
        Err(GraphError::Forbidden(_))
    ));
    assert!(
        reopened
            .activate_completion_authority(interaction)
            .await
            .is_err()
    );

    // The answer opens on a graph: an edited export cannot make the artifact its root.
    let mut input = imported_artifact_conversation();
    let view = input.turns[0].accepted_view.as_mut().unwrap();
    view.root_layer_id = "layer-site".into();
    view.root_action.target_layer_id = Some("layer-site".into());
    let database = GraphDatabase::in_memory().await.unwrap();
    match database
        .import_accepted_conversation(&input)
        .await
        .unwrap_err()
    {
        GraphError::Validation { code, .. } => assert_eq!(code, "artifact_layer_as_response"),
        other => panic!("expected a validation error, got {other:?}"),
    }
}

#[tokio::test]
async fn imported_context_snapshots_deduplicate_and_remain_inert_on_nonaccepted_turns() {
    let database = GraphDatabase::in_memory().await.unwrap();
    let mut input = imported_conversation("interaction-1");
    let target = ImportedNode {
        id: "node-1".into(),
        client_key: None,
        kind: "concept".into(),
        icon: "box".into(),
        title: "Queue".into(),
        detail: "A queue".into(),
        authored_detail: None,
        authored_detail_omitted: false,
        authored_detail_assets: Vec::new(),
        artifact: None,
    };
    input.turns[0].interaction_node_id = Some("interaction-1".into());
    input.turns[0].contexts = vec![ImportedInteractionContext {
        id: "context-action-1".into(),
        target: target.clone(),
        source_interaction_node_id: "foreign-interaction".into(),
        source_layer_id: "foreign-layer".into(),
        annotations: vec!["First note".into(), "Second note".into()],
    }];
    input.turns.push(ImportedTurn {
        source_turn_id: "turn-2".into(),
        text: "Failed after preparation".into(),
        interaction_node_id: Some("interaction-2".into()),
        invoke_origin: None,
        contexts: vec![ImportedInteractionContext {
            id: "context-action-2".into(),
            target,
            source_interaction_node_id: "another-foreign-interaction".into(),
            source_layer_id: "another-foreign-layer".into(),
            annotations: vec!["Failure still keeps this".into()],
        }],
        submitted_inputs: vec![],
        accepted_view: None,
    });

    let receipt = database.import_accepted_conversation(&input).await.unwrap();
    assert_eq!(receipt.turns.len(), 2);
    assert!(receipt.turns[0].output.is_some());
    assert!(receipt.turns[1].output.is_none());
    let first_id = NodeId::new(receipt.turns[0].graph_node_id.unwrap()).unwrap();
    let second_id = NodeId::new(receipt.turns[1].graph_node_id.unwrap()).unwrap();
    let first = database
        .writer_for_subgraph(first_id)
        .await
        .unwrap()
        .interaction_input()
        .await
        .unwrap();
    let second_writer = database.writer_for_subgraph(second_id).await.unwrap();
    let second = second_writer.interaction_input().await.unwrap();
    assert_eq!(first.contexts[0].annotations, ["First note", "Second note"]);
    assert_eq!(second.contexts[0].annotations, ["Failure still keeps this"]);
    assert_eq!(
        first.contexts[0].target_node,
        second.contexts[0].target_node
    );
    assert!(second_writer.completion_output().await.unwrap().is_none());
    assert!(matches!(
        second_writer
            .submit_node(&NodeDraft {
                client_key: "forbidden".into(),
                kind: "concept".into(),
                icon: "box".into(),
                title: "Forbidden".into(),
                detail: "Imported context is inert".into(),
            })
            .await,
        Err(GraphError::Forbidden(_))
    ));
}

#[tokio::test]
async fn imported_unanswered_input_action_keeps_its_authored_payload() {
    let database = GraphDatabase::in_memory().await.unwrap();
    let mut conversation = imported_conversation("interaction-1");
    let expected = InputAction {
        control: InputControl::SingleSelect,
        prompt: "Choose a destination".into(),
        options: vec![InputOption {
            key: "home".into(),
            label: "Home".into(),
            unsupported_fields: Default::default(),
        }],
        minimum_selections: None,
        unsupported_fields: Default::default(),
    };
    conversation.turns[0].accepted_view.as_mut().unwrap().layers[0]
        .actions
        .push(ImportedAction {
            reusable: None,
            input_action_ids: Vec::new(),
            icon_asset: None,
            converted_from_invoke: false,
            id: "unanswered-input".into(),
            client_key: None,
            source_node_id: "node-1".into(),
            source_layer_id: Some("layer-1".into()),
            kind: "input".into(),
            relation: None,
            label: "Choose".into(),
            variant: "pill".into(),
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: None,
            input: Some(expected.clone()),
        });

    let receipt = database
        .import_accepted_conversation(&conversation)
        .await
        .unwrap();
    let output = receipt.turns[0].output.as_ref().unwrap();
    let imported = output
        .root_layer
        .actions
        .iter()
        .find(|action| action.kind == ActionKind::Input)
        .unwrap();
    assert_eq!(imported.input.as_ref(), Some(&expected));
    assert!(receipt.skipped_submitted_inputs.is_empty());

    let error = database
        .canonical_input_action_occurrence(
            None,
            thread(9001),
            &PresentingInputOccurrence {
                presenting_interaction_node_id: NodeId::new(
                    receipt.turns[0].graph_node_id.unwrap(),
                )
                .unwrap(),
                presenting_layer_id: output.root_layer.layer.id,
                action_id: imported.id,
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        GraphError::Validation { code, path, .. }
            if code == "input_action_not_in_occurrence" && path == "attachments[0].actionId"
    ));
}

#[tokio::test]
async fn imported_submitted_inputs_are_semantic_inert_turn_owned_and_removable() {
    let database = GraphDatabase::in_memory().await.unwrap();
    let mut input = imported_conversation("interaction-1");
    input.turns[0].accepted_view.as_mut().unwrap().layers[0]
        .actions
        .push(ImportedAction {
            reusable: None,
            input_action_ids: Vec::new(),
            icon_asset: None,
            converted_from_invoke: false,
            id: "input-action-1".into(),
            client_key: None,
            source_node_id: "node-1".into(),
            source_layer_id: Some("layer-1".into()),
            kind: "input".into(),
            relation: None,
            label: "".into(),
            variant: "pill".into(),
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: None,
            input: None,
        });
    input.turns.push(ImportedTurn {
        source_turn_id: "turn-2".into(),
        text: "".into(),
        interaction_node_id: Some("input-root-2".into()),
        invoke_origin: None,
        contexts: vec![],
        submitted_inputs: vec![ImportedSubmittedInput {
            id: "input-child-1".into(),
            root_turn_id: "turn-2".into(),
            source: ImportedInputSource {
                interaction_node_id: "interaction-1".into(),
                layer_id: "layer-1".into(),
                action_id: "input-action-1".into(),
                node_id: "node-1".into(),
            },
            action: InputAction {
                control: InputControl::SingleSelect,
                prompt: "Choose".into(),
                options: vec![InputOption {
                    key: "one".into(),
                    label: "One".into(),
                    unsupported_fields: Default::default(),
                }],
                minimum_selections: None,
                unsupported_fields: Default::default(),
            },
            value: SubmittedInputValue::Selected {
                selected: vec![InputOption {
                    key: "one".into(),
                    label: "One".into(),
                    unsupported_fields: Default::default(),
                }],
            },
        }],
        accepted_view: None,
    });

    let receipt = database.import_accepted_conversation(&input).await.unwrap();
    let root = NodeId::new(receipt.turns[1].graph_node_id.unwrap()).unwrap();
    let writer = database.writer_for_subgraph(root).await.unwrap();
    let projected = writer.interaction_input().await.unwrap();
    assert_eq!(
        projected.submitted_inputs,
        vec![SubmittedInput {
            action: input.turns[1].submitted_inputs[0].action.clone(),
            value: input.turns[1].submitted_inputs[0].value.clone(),
        }]
    );
    assert!(matches!(
        writer
            .submit_node(&NodeDraft {
                client_key: "forbidden".into(),
                kind: "concept".into(),
                icon: "box".into(),
                title: "Forbidden".into(),
                detail: "Imported input is inert".into(),
            })
            .await,
        Err(GraphError::Forbidden(_))
    ));
    drop(writer);
    database
        .remove_imported_conversation(&input.import_id)
        .await
        .unwrap();
    assert!(database.writer_for_subgraph(root).await.is_err());
}

#[tokio::test]
async fn imported_submitted_input_provenance_must_be_one_exact_accepted_occurrence() {
    let database = GraphDatabase::in_memory().await.unwrap();
    let mut input = imported_conversation("interaction-1");
    let view = input.turns[0].accepted_view.as_mut().unwrap();
    // A second accepted node in the same layer. It is a perfectly valid node that
    // simply never authored the input action.
    let resolved = &mut view.layers[0];
    resolved.layer.nodes.push("node-2".into());
    resolved
        .layer
        .layout
        .as_mut()
        .unwrap()
        .placements
        .push(ImportedNodePlacement {
            node_id: "node-2".into(),
            x: 0.75,
            y: 0.25,
        });
    resolved.nodes.push(ImportedNode {
        id: "node-2".into(),
        client_key: None,
        kind: "concept".into(),
        icon: "box".into(),
        title: "Worker".into(),
        detail: "A worker".into(),
        authored_detail: None,
        authored_detail_omitted: false,
        authored_detail_assets: Vec::new(),
        artifact: None,
    });
    // Two input actions, both genuinely authored by node-1.
    for id in ["input-action-1", "input-action-2"] {
        resolved.actions.push(ImportedAction {
            reusable: None,
            input_action_ids: Vec::new(),
            icon_asset: None,
            converted_from_invoke: false,
            id: id.into(),
            client_key: None,
            source_node_id: "node-1".into(),
            source_layer_id: Some("layer-1".into()),
            kind: "input".into(),
            relation: None,
            label: "".into(),
            variant: "pill".into(),
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: None,
            input: None,
        });
    }

    let action = InputAction {
        control: InputControl::SingleSelect,
        prompt: "Choose".into(),
        options: vec![InputOption {
            key: "one".into(),
            label: "One".into(),
            unsupported_fields: Default::default(),
        }],
        minimum_selections: None,
        unsupported_fields: Default::default(),
    };
    let value = SubmittedInputValue::Selected {
        selected: vec![InputOption {
            key: "one".into(),
            label: "One".into(),
            unsupported_fields: Default::default(),
        }],
    };
    let honest = ImportedSubmittedInput {
        id: "input-child-honest".into(),
        root_turn_id: "turn-2".into(),
        source: ImportedInputSource {
            interaction_node_id: "interaction-1".into(),
            layer_id: "layer-1".into(),
            action_id: "input-action-1".into(),
            node_id: "node-1".into(),
        },
        action: action.clone(),
        value: value.clone(),
    };
    // A distinct occurrence, so the unique index over
    // (parent, interaction, layer, action) cannot catch this incidentally -- the
    // provenance check is the only thing standing between this and the database.
    // Every identifier resolves on its own; only the tuple is a lie, claiming a node
    // that never asked the question.
    let spliced = ImportedSubmittedInput {
        id: "input-child-spliced".into(),
        source: ImportedInputSource {
            action_id: "input-action-2".into(),
            node_id: "node-2".into(),
            ..honest.source.clone()
        },
        ..honest.clone()
    };
    input.turns.push(ImportedTurn {
        source_turn_id: "turn-2".into(),
        text: "".into(),
        interaction_node_id: Some("input-root-2".into()),
        invoke_origin: None,
        contexts: vec![],
        submitted_inputs: vec![honest, spliced],
        accepted_view: None,
    });

    let receipt = database.import_accepted_conversation(&input).await.unwrap();

    // The spliced answer is dropped, and dropping it is visible rather than silent.
    assert_eq!(receipt.skipped_submitted_inputs.len(), 1);
    let skipped = &receipt.skipped_submitted_inputs[0];
    assert_eq!(skipped.submitted_input_id, "input-child-spliced");
    assert_eq!(skipped.source_turn_id, "turn-2");
    assert_eq!(skipped.code, "input_action_not_in_occurrence");
    assert_eq!(skipped.path, "submittedInputs[1].source.nodeId");

    // The honest answer on the same turn still imports.
    let root = NodeId::new(receipt.turns[1].graph_node_id.unwrap()).unwrap();
    let writer = database.writer_for_subgraph(root).await.unwrap();
    let projected = writer.interaction_input().await.unwrap();
    assert_eq!(
        projected.submitted_inputs,
        vec![SubmittedInput { action, value }]
    );
}

#[tokio::test]
async fn imported_submitted_input_value_must_satisfy_the_accepted_action() {
    let database = GraphDatabase::in_memory().await.unwrap();
    let mut input = imported_conversation("interaction-1");
    let resolved = &mut input.turns[0].accepted_view.as_mut().unwrap().layers[0];
    // Two input actions, both genuinely authored by node-1, so each answer below
    // carries provenance that actually happened.
    for id in ["input-action-1", "input-action-2"] {
        resolved.actions.push(ImportedAction {
            reusable: None,
            input_action_ids: Vec::new(),
            icon_asset: None,
            converted_from_invoke: false,
            id: id.into(),
            client_key: None,
            source_node_id: "node-1".into(),
            source_layer_id: Some("layer-1".into()),
            kind: "input".into(),
            relation: None,
            label: "".into(),
            variant: "pill".into(),
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: None,
            input: None,
        });
    }

    let action = InputAction {
        control: InputControl::SingleSelect,
        prompt: "Choose".into(),
        options: vec![InputOption {
            key: "one".into(),
            label: "One".into(),
            unsupported_fields: Default::default(),
        }],
        minimum_selections: None,
        unsupported_fields: Default::default(),
    };
    let value = SubmittedInputValue::Selected {
        selected: vec![InputOption {
            key: "one".into(),
            label: "One".into(),
            unsupported_fields: Default::default(),
        }],
    };
    let honest = ImportedSubmittedInput {
        id: "input-child-honest".into(),
        root_turn_id: "turn-2".into(),
        source: ImportedInputSource {
            interaction_node_id: "interaction-1".into(),
            layer_id: "layer-1".into(),
            action_id: "input-action-1".into(),
            node_id: "node-1".into(),
        },
        action: action.clone(),
        value: value.clone(),
    };
    // Provenance here is entirely honest: node-1 really did author input-action-2 in
    // this layer. Only the answer is fabricated -- an option key and label the accepted
    // action never offered. The live send path rejects exactly this as
    // `input_option_unknown`, so import must not accept it either.
    let fallback_action = InputAction {
        control: InputControl::SingleSelect,
        prompt: "Rejected-only legacy question".into(),
        options: vec![InputOption {
            key: "fallback".into(),
            label: "Fallback".into(),
            unsupported_fields: Default::default(),
        }],
        minimum_selections: None,
        unsupported_fields: Default::default(),
    };
    let forged = ImportedSubmittedInput {
        id: "input-child-forged".into(),
        source: ImportedInputSource {
            action_id: "input-action-2".into(),
            ..honest.source.clone()
        },
        value: SubmittedInputValue::Selected {
            selected: vec![InputOption {
                key: "two".into(),
                label: "Wire the money".into(),
                unsupported_fields: Default::default(),
            }],
        },
        action: fallback_action.clone(),
        ..honest.clone()
    };
    let authored_text = InputAction {
        control: InputControl::Text,
        prompt: "Authored question".into(),
        options: vec![],
        minimum_selections: None,
        unsupported_fields: Default::default(),
    };
    resolved.actions.push(ImportedAction {
        reusable: None,
        input_action_ids: Vec::new(),
        icon_asset: None,
        converted_from_invoke: false,
        id: "input-action-authored-text".into(),
        client_key: None,
        source_node_id: "node-1".into(),
        source_layer_id: Some("layer-1".into()),
        kind: "input".into(),
        relation: None,
        label: "Authored text".into(),
        variant: "pill".into(),
        icon: None,
        description: None,
        target_layer_id: None,
        interaction_text: None,
        input: Some(authored_text.clone()),
    });
    let conflicting_snapshot = InputAction {
        control: InputControl::SingleSelect,
        prompt: "Conflicting child snapshot".into(),
        options: vec![InputOption {
            key: "choice".into(),
            label: "Choice".into(),
            unsupported_fields: Default::default(),
        }],
        minimum_selections: None,
        unsupported_fields: Default::default(),
    };
    let authored_text_source = ImportedInputSource {
        interaction_node_id: "interaction-1".into(),
        layer_id: "layer-1".into(),
        action_id: "input-action-authored-text".into(),
        node_id: "node-1".into(),
    };
    let conflicting_child = ImportedSubmittedInput {
        id: "input-child-conflicting-authored-snapshot".into(),
        root_turn_id: "turn-2".into(),
        source: authored_text_source.clone(),
        action: conflicting_snapshot.clone(),
        value: SubmittedInputValue::Selected {
            selected: conflicting_snapshot.options.clone(),
        },
    };
    let authored_text_value = SubmittedInputValue::Text {
        text: "Keep the authored control".into(),
    };
    let legitimate_child = ImportedSubmittedInput {
        id: "input-child-authored-text".into(),
        root_turn_id: "turn-2".into(),
        source: authored_text_source,
        action: authored_text.clone(),
        value: authored_text_value.clone(),
    };
    input.turns.push(ImportedTurn {
        source_turn_id: "turn-2".into(),
        text: "".into(),
        interaction_node_id: Some("input-root-2".into()),
        invoke_origin: None,
        contexts: vec![],
        submitted_inputs: vec![honest, forged, conflicting_child, legitimate_child],
        accepted_view: None,
    });

    let receipt = database.import_accepted_conversation(&input).await.unwrap();

    // The fabricated answer is dropped, and dropping it is visible rather than silent.
    assert_eq!(receipt.skipped_submitted_inputs.len(), 2);
    let skipped = &receipt.skipped_submitted_inputs[0];
    assert_eq!(skipped.submitted_input_id, "input-child-forged");
    assert_eq!(skipped.source_turn_id, "turn-2");
    assert_eq!(skipped.code, "input_option_unknown");
    assert_eq!(skipped.path, "submittedInputs[1].value");
    let conflicting = &receipt.skipped_submitted_inputs[1];
    assert_eq!(
        conflicting.submitted_input_id,
        "input-child-conflicting-authored-snapshot"
    );
    assert_eq!(conflicting.code, "input_action_snapshot_mismatch");
    assert_eq!(conflicting.path, "submittedInputs[2].action");

    // The honest answer on the same turn still imports, and nothing the file claimed
    // about the fabricated option reached the projection.
    let root = NodeId::new(receipt.turns[1].graph_node_id.unwrap()).unwrap();
    let writer = database.writer_for_subgraph(root).await.unwrap();
    let projected = writer.interaction_input().await.unwrap();
    assert_eq!(
        projected.submitted_inputs,
        vec![
            SubmittedInput { action, value },
            SubmittedInput {
                action: authored_text.clone(),
                value: authored_text_value,
            },
        ]
    );
    let accepted_actions = &receipt.turns[0].output.as_ref().unwrap().root_layer.actions;
    let fallback_payloads = accepted_actions
        .iter()
        .filter(|candidate| candidate.client_key.as_deref() == Some("input-action-2"))
        .collect::<Vec<_>>();
    assert_eq!(fallback_payloads.len(), 1);
    let fallback_payload = fallback_payloads[0];
    assert_eq!(fallback_payload.input.as_ref(), Some(&fallback_action));
    let authored_action = accepted_actions
        .iter()
        .find(|candidate| candidate.input.as_ref() == Some(&authored_text))
        .unwrap();
    assert_eq!(authored_action.input.as_ref(), Some(&authored_text));
}

#[tokio::test]
async fn imported_submitted_input_requires_an_earlier_presenting_turn() {
    let database = GraphDatabase::in_memory().await.unwrap();
    let mut input = imported_conversation("interaction-1");
    let input_action = InputAction {
        control: InputControl::Text,
        prompt: "What should happen?".into(),
        options: vec![],
        minimum_selections: None,
        unsupported_fields: Default::default(),
    };
    input.turns[0].accepted_view.as_mut().unwrap().layers[0]
        .actions
        .push(ImportedAction {
            reusable: None,
            input_action_ids: Vec::new(),
            icon_asset: None,
            converted_from_invoke: false,
            id: "input-action-1".into(),
            client_key: None,
            source_node_id: "node-1".into(),
            source_layer_id: Some("layer-1".into()),
            kind: "input".into(),
            relation: None,
            label: "".into(),
            variant: "pill".into(),
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: None,
            input: Some(input_action.clone()),
        });

    let mut same_turn = rename_simple_imported_turn(
        imported_conversation("interaction-2").turns.remove(0),
        "turn-2",
        "interaction-2",
        "layer-2",
        "node-2",
    );
    same_turn.accepted_view.as_mut().unwrap().layers[0]
        .actions
        .push(ImportedAction {
            reusable: None,
            input_action_ids: Vec::new(),
            icon_asset: None,
            converted_from_invoke: false,
            id: "input-action-2".into(),
            client_key: None,
            source_node_id: "node-2".into(),
            source_layer_id: Some("layer-2".into()),
            kind: "input".into(),
            relation: None,
            label: "".into(),
            variant: "pill".into(),
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: None,
            input: Some(input_action.clone()),
        });
    let later = rename_simple_imported_turn(
        imported_conversation("interaction-3").turns.remove(0),
        "turn-3",
        "interaction-3",
        "layer-3",
        "node-3",
    );
    let mut later = later;
    later.accepted_view.as_mut().unwrap().layers[0]
        .actions
        .push(ImportedAction {
            reusable: None,
            input_action_ids: Vec::new(),
            icon_asset: None,
            converted_from_invoke: false,
            id: "input-action-3".into(),
            client_key: None,
            source_node_id: "node-3".into(),
            source_layer_id: Some("layer-3".into()),
            kind: "input".into(),
            relation: None,
            label: "".into(),
            variant: "pill".into(),
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: None,
            input: Some(input_action.clone()),
        });

    let value = SubmittedInputValue::Text {
        text: "Use the earlier answer".into(),
    };
    let submitted = |id: &str, interaction: &str, layer: &str, action: &str, node: &str| {
        ImportedSubmittedInput {
            id: id.into(),
            root_turn_id: "turn-2".into(),
            source: ImportedInputSource {
                interaction_node_id: interaction.into(),
                layer_id: layer.into(),
                action_id: action.into(),
                node_id: node.into(),
            },
            action: input_action.clone(),
            value: value.clone(),
        }
    };
    input.turns.push(ImportedTurn {
        source_turn_id: "turn-2".into(),
        text: "Consume inputs".into(),
        interaction_node_id: Some("interaction-2".into()),
        invoke_origin: None,
        contexts: vec![],
        submitted_inputs: vec![
            submitted(
                "input-earlier",
                "interaction-1",
                "layer-1",
                "input-action-1",
                "node-1",
            ),
            submitted(
                "input-same-turn",
                "interaction-2",
                "layer-2",
                "input-action-2",
                "node-2",
            ),
            submitted(
                "input-later-turn",
                "interaction-3",
                "layer-3",
                "input-action-3",
                "node-3",
            ),
        ],
        accepted_view: same_turn.accepted_view,
    });
    input.turns.push(later);

    let receipt = database.import_accepted_conversation(&input).await.unwrap();
    assert_eq!(receipt.skipped_submitted_inputs.len(), 2);
    assert_eq!(
        receipt
            .skipped_submitted_inputs
            .iter()
            .map(|skipped| (skipped.submitted_input_id.as_str(), skipped.code.as_str()))
            .collect::<Vec<_>>(),
        vec![
            ("input-same-turn", "input_occurrence_not_visible"),
            ("input-later-turn", "input_occurrence_not_visible"),
        ]
    );
    let root = NodeId::new(receipt.turns[1].graph_node_id.unwrap()).unwrap();
    let writer = database.writer_for_subgraph(root).await.unwrap();
    assert_eq!(
        writer.interaction_input().await.unwrap().submitted_inputs,
        vec![SubmittedInput {
            action: input_action,
            value,
        }]
    );
}

#[tokio::test]
async fn imported_duplicate_input_occurrence_drops_only_extra_answer_per_turn() {
    let database = GraphDatabase::in_memory().await.unwrap();
    let mut input = imported_conversation("interaction-1");
    let action = InputAction {
        control: InputControl::SingleSelect,
        prompt: "Choose".into(),
        options: vec![InputOption {
            key: "one".into(),
            label: "One".into(),
            unsupported_fields: Default::default(),
        }],
        minimum_selections: None,
        unsupported_fields: Default::default(),
    };
    let action_two = InputAction {
        control: InputControl::Text,
        prompt: "Add a note".into(),
        options: vec![],
        minimum_selections: None,
        unsupported_fields: Default::default(),
    };
    let source_layer = &mut input.turns[0].accepted_view.as_mut().unwrap().layers[0];
    for (id, snapshot) in [
        ("input-action-1", action.clone()),
        ("input-action-2", action_two.clone()),
    ] {
        source_layer.actions.push(ImportedAction {
            reusable: None,
            input_action_ids: Vec::new(),
            icon_asset: None,
            converted_from_invoke: false,
            id: id.into(),
            client_key: None,
            source_node_id: "node-1".into(),
            source_layer_id: Some("layer-1".into()),
            kind: "input".into(),
            relation: None,
            label: "".into(),
            variant: "pill".into(),
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: None,
            input: Some(snapshot),
        });
    }
    let valid_value = SubmittedInputValue::Selected {
        selected: vec![InputOption {
            key: "one".into(),
            label: "One".into(),
            unsupported_fields: Default::default(),
        }],
    };
    let invalid_value = SubmittedInputValue::Selected {
        selected: vec![InputOption {
            key: "unknown".into(),
            label: "Unknown".into(),
            unsupported_fields: Default::default(),
        }],
    };
    let note_value = SubmittedInputValue::Text {
        text: "Keep this distinct occurrence".into(),
    };
    let submitted =
        |id: &str, action_id: &str, snapshot: InputAction, value: SubmittedInputValue| {
            ImportedSubmittedInput {
                id: id.into(),
                root_turn_id: "turn-2".into(),
                source: ImportedInputSource {
                    interaction_node_id: "interaction-1".into(),
                    layer_id: "layer-1".into(),
                    action_id: action_id.into(),
                    node_id: "node-1".into(),
                },
                action: snapshot,
                value,
            }
        };
    let mut second_consumer = rename_simple_imported_turn(
        imported_conversation("interaction-3").turns.remove(0),
        "turn-3",
        "interaction-3",
        "layer-3",
        "node-3",
    );
    second_consumer.interaction_node_id = Some("interaction-3".into());
    second_consumer.submitted_inputs = vec![ImportedSubmittedInput {
        id: "input-other-turn".into(),
        root_turn_id: "turn-3".into(),
        source: ImportedInputSource {
            interaction_node_id: "interaction-1".into(),
            layer_id: "layer-1".into(),
            action_id: "input-action-1".into(),
            node_id: "node-1".into(),
        },
        action: action.clone(),
        value: valid_value.clone(),
    }];
    input.turns.push(ImportedTurn {
        source_turn_id: "turn-2".into(),
        text: "Two answers".into(),
        interaction_node_id: Some("input-root-2".into()),
        invoke_origin: None,
        contexts: vec![],
        submitted_inputs: vec![
            submitted(
                "input-invalid-first",
                "input-action-1",
                action.clone(),
                invalid_value,
            ),
            submitted(
                "input-valid",
                "input-action-1",
                action.clone(),
                valid_value.clone(),
            ),
            submitted(
                "input-duplicate",
                "input-action-1",
                action.clone(),
                valid_value.clone(),
            ),
            submitted(
                "input-distinct",
                "input-action-2",
                action_two.clone(),
                note_value.clone(),
            ),
        ],
        accepted_view: None,
    });
    input.turns.push(second_consumer);

    let receipt = database.import_accepted_conversation(&input).await.unwrap();
    assert_eq!(receipt.skipped_submitted_inputs.len(), 2);
    assert_eq!(
        receipt
            .skipped_submitted_inputs
            .iter()
            .map(|skipped| (skipped.submitted_input_id.as_str(), skipped.code.as_str()))
            .collect::<Vec<_>>(),
        vec![
            ("input-invalid-first", "input_option_unknown"),
            ("input-duplicate", "input_attachment_duplicate"),
        ]
    );
    assert_eq!(receipt.skipped_submitted_inputs[1].source_turn_id, "turn-2");
    assert_eq!(
        receipt.skipped_submitted_inputs[1].path,
        "submittedInputs[2].source"
    );

    let first_root = NodeId::new(receipt.turns[1].graph_node_id.unwrap()).unwrap();
    let first = database
        .writer_for_subgraph(first_root)
        .await
        .unwrap()
        .interaction_input()
        .await
        .unwrap();
    assert_eq!(
        first.submitted_inputs,
        vec![
            SubmittedInput {
                action: action.clone(),
                value: valid_value.clone(),
            },
            SubmittedInput {
                action: action_two,
                value: note_value,
            },
        ]
    );
    let second_root = NodeId::new(receipt.turns[2].graph_node_id.unwrap()).unwrap();
    let second = database
        .writer_for_subgraph(second_root)
        .await
        .unwrap()
        .interaction_input()
        .await
        .unwrap();
    assert_eq!(
        second.submitted_inputs,
        vec![SubmittedInput {
            action,
            value: valid_value,
        }]
    );
}

#[tokio::test]
async fn invalid_legacy_child_snapshot_does_not_poison_a_later_valid_answer() {
    let database = GraphDatabase::in_memory().await.unwrap();
    let mut input = imported_conversation("interaction-1");
    let legacy_input = InputAction {
        control: InputControl::Text,
        prompt: "Legacy question".into(),
        options: vec![],
        minimum_selections: None,
        unsupported_fields: Default::default(),
    };
    input.turns[0].accepted_view.as_mut().unwrap().layers[0]
        .actions
        .push(ImportedAction {
            reusable: None,
            input_action_ids: Vec::new(),
            icon_asset: None,
            converted_from_invoke: false,
            id: "legacy-input-action".into(),
            client_key: None,
            source_node_id: "node-1".into(),
            source_layer_id: Some("layer-1".into()),
            kind: "input".into(),
            relation: None,
            label: "Legacy input".into(),
            variant: "pill".into(),
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: None,
            input: None,
        });

    let invalid_snapshot = InputAction {
        control: InputControl::SingleSelect,
        prompt: "Untrusted snapshot".into(),
        options: vec![InputOption {
            key: "known".into(),
            label: "Known".into(),
            unsupported_fields: Default::default(),
        }],
        minimum_selections: None,
        unsupported_fields: Default::default(),
    };
    let valid_value = SubmittedInputValue::Text {
        text: "Keep this answer".into(),
    };
    let submitted =
        |id: &str, action: InputAction, value: SubmittedInputValue| ImportedSubmittedInput {
            id: id.into(),
            root_turn_id: "turn-2".into(),
            source: ImportedInputSource {
                interaction_node_id: "interaction-1".into(),
                layer_id: "layer-1".into(),
                action_id: "legacy-input-action".into(),
                node_id: "node-1".into(),
            },
            action,
            value,
        };
    input.turns.push(ImportedTurn {
        source_turn_id: "turn-2".into(),
        text: "Keep this consuming turn".into(),
        interaction_node_id: Some("input-root-2".into()),
        invoke_origin: None,
        contexts: vec![],
        submitted_inputs: vec![
            submitted(
                "input-invalid-first-snapshot",
                invalid_snapshot,
                SubmittedInputValue::Selected {
                    selected: vec![InputOption {
                        key: "unknown".into(),
                        label: "Unknown".into(),
                        unsupported_fields: Default::default(),
                    }],
                },
            ),
            submitted(
                "input-valid-later-snapshot",
                legacy_input.clone(),
                valid_value.clone(),
            ),
        ],
        accepted_view: None,
    });

    let receipt = database.import_accepted_conversation(&input).await.unwrap();
    assert_eq!(receipt.skipped_submitted_inputs.len(), 1);
    assert_eq!(
        receipt.skipped_submitted_inputs[0].submitted_input_id,
        "input-invalid-first-snapshot"
    );
    let root = NodeId::new(receipt.turns[1].graph_node_id.unwrap()).unwrap();
    let writer = database.writer_for_subgraph(root).await.unwrap();
    assert_eq!(
        writer.interaction_input().await.unwrap().submitted_inputs,
        vec![SubmittedInput {
            action: legacy_input,
            value: valid_value,
        }]
    );
}

#[tokio::test]
async fn reused_legacy_input_uses_presenting_layer_for_snapshot_preference() {
    let database = GraphDatabase::in_memory().await.unwrap();
    let mut input = imported_conversation("interaction-1");
    let legacy_input = InputAction {
        control: InputControl::Text,
        prompt: "Legacy question".into(),
        options: vec![],
        minimum_selections: None,
        unsupported_fields: Default::default(),
    };
    input.turns[0].accepted_view.as_mut().unwrap().layers[0]
        .actions
        .push(ImportedAction {
            reusable: None,
            input_action_ids: Vec::new(),
            icon_asset: None,
            converted_from_invoke: false,
            id: "legacy-input-action".into(),
            client_key: None,
            source_node_id: "node-1".into(),
            source_layer_id: Some("layer-1".into()),
            kind: "input".into(),
            relation: None,
            label: "Legacy input".into(),
            variant: "pill".into(),
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: None,
            input: None,
        });

    // I2 presents the same node-owned action in B, retaining A as its authored
    // source layer. B does not navigate to A; it is the actual presentation.
    let mut reuse = input.turns[0].clone();
    reuse.source_turn_id = "turn-2".into();
    reuse.interaction_node_id = None;
    let view = reuse.accepted_view.as_mut().unwrap();
    view.interaction_node_id = "interaction-2".into();
    view.root_layer_id = "layer-B".into();
    view.root_action.id = "root-action-interaction-2".into();
    view.root_action.source_node_id = "interaction-2".into();
    view.root_action.target_layer_id = Some("layer-B".into());
    let resolved = &mut view.layers[0];
    resolved.layer.id = "layer-B".into();
    resolved.layer.nodes = vec!["node-1".into()];
    if let Some(layout) = &mut resolved.layer.layout {
        for placement in &mut layout.placements {
            placement.node_id = "node-1".into();
        }
    }
    resolved.actions[0].source_layer_id = Some("layer-1".into());

    let valid_value = SubmittedInputValue::Text {
        text: "Keep the genuine answer".into(),
    };
    let forged_action = InputAction {
        control: InputControl::SingleSelect,
        prompt: "Self-valid forged snapshot".into(),
        options: vec![InputOption {
            key: "known".into(),
            label: "Known".into(),
            unsupported_fields: Default::default(),
        }],
        minimum_selections: None,
        unsupported_fields: Default::default(),
    };
    let submitted = |id: &str, layer_id: &str, action: InputAction, value: SubmittedInputValue| {
        ImportedSubmittedInput {
            id: id.into(),
            root_turn_id: "turn-3".into(),
            source: ImportedInputSource {
                interaction_node_id: "interaction-2".into(),
                layer_id: layer_id.into(),
                action_id: "legacy-input-action".into(),
                node_id: "node-1".into(),
            },
            action,
            value,
        }
    };
    let consumer = ImportedTurn {
        source_turn_id: "turn-3".into(),
        text: "Consume reused input".into(),
        interaction_node_id: Some("interaction-3".into()),
        invoke_origin: None,
        contexts: vec![],
        submitted_inputs: vec![
            submitted(
                "input-genuine-B",
                "layer-B",
                legacy_input.clone(),
                valid_value.clone(),
            ),
            submitted(
                "input-forged-A",
                "layer-1",
                forged_action,
                SubmittedInputValue::Selected {
                    selected: vec![InputOption {
                        key: "known".into(),
                        label: "Known".into(),
                        unsupported_fields: Default::default(),
                    }],
                },
            ),
        ],
        accepted_view: None,
    };
    input.turns.push(reuse);
    input.turns.push(consumer);

    let receipt = database.import_accepted_conversation(&input).await.unwrap();
    assert_eq!(receipt.skipped_submitted_inputs.len(), 1);
    assert_eq!(
        receipt.skipped_submitted_inputs[0].submitted_input_id,
        "input-forged-A"
    );
    assert_eq!(
        receipt.skipped_submitted_inputs[0].code,
        "input_action_not_in_occurrence"
    );
    assert_eq!(
        receipt.skipped_submitted_inputs[0].path,
        "submittedInputs[1].source.actionId"
    );
    let root = NodeId::new(receipt.turns[2].graph_node_id.unwrap()).unwrap();
    let writer = database.writer_for_subgraph(root).await.unwrap();
    assert_eq!(
        writer.interaction_input().await.unwrap().submitted_inputs,
        vec![SubmittedInput {
            action: legacy_input.clone(),
            value: valid_value,
        }]
    );
    let reused = receipt.turns[1].output.as_ref().unwrap();
    let accepted = reused
        .root_layer
        .actions
        .iter()
        .find(|action| action.label == "Legacy input")
        .unwrap();
    assert_eq!(accepted.input.as_ref(), Some(&legacy_input));
    assert_eq!(
        accepted.source_layer_id,
        Some(LayerId::new(receipt.turns[0].root_layer_id.unwrap()).unwrap())
    );
}

#[tokio::test]
async fn wrong_occurrence_legacy_snapshot_cannot_poison_exact_sibling() {
    let database = GraphDatabase::in_memory().await.unwrap();
    let mut input = imported_conversation("interaction-1");
    let legacy_input = InputAction {
        control: InputControl::Text,
        prompt: "Legacy question".into(),
        options: vec![],
        minimum_selections: None,
        unsupported_fields: Default::default(),
    };
    input.turns[0].accepted_view.as_mut().unwrap().layers[0]
        .actions
        .push(ImportedAction {
            reusable: None,
            input_action_ids: Vec::new(),
            icon_asset: None,
            converted_from_invoke: false,
            id: "legacy-input-action".into(),
            client_key: None,
            source_node_id: "node-1".into(),
            source_layer_id: Some("layer-1".into()),
            kind: "input".into(),
            relation: None,
            label: "Legacy input".into(),
            variant: "pill".into(),
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: None,
            input: None,
        });

    let wrong_occurrence_snapshot = InputAction {
        control: InputControl::SingleSelect,
        prompt: "Wrong occurrence snapshot".into(),
        options: vec![InputOption {
            key: "known".into(),
            label: "Known".into(),
            unsupported_fields: Default::default(),
        }],
        minimum_selections: None,
        unsupported_fields: Default::default(),
    };
    let exact_value = SubmittedInputValue::Text {
        text: "Keep this exact answer".into(),
    };
    let submitted = |id: &str,
                     interaction_node_id: &str,
                     layer_id: &str,
                     node_id: &str,
                     action: InputAction,
                     value: SubmittedInputValue| ImportedSubmittedInput {
        id: id.into(),
        root_turn_id: "turn-2".into(),
        source: ImportedInputSource {
            interaction_node_id: interaction_node_id.into(),
            layer_id: layer_id.into(),
            action_id: "legacy-input-action".into(),
            node_id: node_id.into(),
        },
        action,
        value,
    };
    input.turns.push(ImportedTurn {
        source_turn_id: "turn-2".into(),
        text: "Keep this consuming turn".into(),
        interaction_node_id: Some("input-root-2".into()),
        invoke_origin: None,
        contexts: vec![],
        submitted_inputs: vec![
            submitted(
                "input-a-wrong-occurrence",
                // The root and layer are earlier and materialized, but the claimed
                // source node is an existing root rather than the action's node.
                "interaction-1",
                "layer-1",
                "interaction-1",
                wrong_occurrence_snapshot,
                SubmittedInputValue::Selected {
                    selected: vec![InputOption {
                        key: "known".into(),
                        label: "Known".into(),
                        unsupported_fields: Default::default(),
                    }],
                },
            ),
            submitted(
                "input-b-exact-occurrence",
                "interaction-1",
                "layer-1",
                "node-1",
                legacy_input.clone(),
                exact_value.clone(),
            ),
        ],
        accepted_view: None,
    });

    let receipt = database.import_accepted_conversation(&input).await.unwrap();
    assert_eq!(receipt.skipped_submitted_inputs.len(), 1);
    assert_eq!(
        receipt.skipped_submitted_inputs[0].submitted_input_id,
        "input-a-wrong-occurrence"
    );
    let root = NodeId::new(receipt.turns[1].graph_node_id.unwrap()).unwrap();
    let writer = database.writer_for_subgraph(root).await.unwrap();
    assert_eq!(
        writer.interaction_input().await.unwrap().submitted_inputs,
        vec![SubmittedInput {
            action: legacy_input,
            value: exact_value,
        }]
    );
}

async fn assert_chronologically_invalid_legacy_snapshot_is_ignored(scenario: &str) {
    let database = GraphDatabase::in_memory().await.unwrap();
    let mut input = imported_conversation("interaction-1");
    let mut presenting_turn = input.turns.remove(0);
    presenting_turn.interaction_node_id = Some("interaction-1".into());
    if scenario == "later-turn" {
        presenting_turn.source_turn_id = "turn-3".into();
    }

    let legacy_input = InputAction {
        control: InputControl::Text,
        prompt: "Legacy question".into(),
        options: vec![],
        minimum_selections: None,
        unsupported_fields: Default::default(),
    };
    presenting_turn.accepted_view.as_mut().unwrap().layers[0]
        .actions
        .push(ImportedAction {
            reusable: None,
            input_action_ids: Vec::new(),
            icon_asset: None,
            converted_from_invoke: false,
            id: "legacy-input-action".into(),
            client_key: None,
            source_node_id: "node-1".into(),
            source_layer_id: Some("layer-1".into()),
            kind: "input".into(),
            relation: None,
            label: "Legacy input".into(),
            variant: "pill".into(),
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: None,
            input: None,
        });

    let conflicting_snapshot = InputAction {
        control: InputControl::SingleSelect,
        prompt: "Chronologically invalid snapshot".into(),
        options: vec![InputOption {
            key: "known".into(),
            label: "Known".into(),
            unsupported_fields: Default::default(),
        }],
        minimum_selections: None,
        unsupported_fields: Default::default(),
    };
    let poison_value = SubmittedInputValue::Selected {
        selected: vec![InputOption {
            key: "known".into(),
            label: "Known".into(),
            unsupported_fields: Default::default(),
        }],
    };
    let valid_value = SubmittedInputValue::Text {
        text: "Keep this later answer".into(),
    };
    let submitted = |id: &str,
                     root_turn_id: &str,
                     action: InputAction,
                     value: SubmittedInputValue| ImportedSubmittedInput {
        id: id.into(),
        root_turn_id: root_turn_id.into(),
        source: ImportedInputSource {
            interaction_node_id: "interaction-1".into(),
            layer_id: "layer-1".into(),
            action_id: "legacy-input-action".into(),
            node_id: "node-1".into(),
        },
        action,
        value,
    };
    let poison = submitted(
        "input-chronology-poison",
        if scenario == "same-turn" {
            "turn-1"
        } else {
            "turn-2"
        },
        conflicting_snapshot,
        poison_value,
    );
    let answer_turn_id = if scenario == "same-turn" {
        "turn-2"
    } else {
        "turn-4"
    };
    let answer = submitted(
        "input-exact-later-answer",
        answer_turn_id,
        legacy_input.clone(),
        valid_value.clone(),
    );
    let make_consumer = |source_turn_id: &str,
                         interaction_node_id: &str,
                         text: &str,
                         submitted_inputs: Vec<ImportedSubmittedInput>| {
        ImportedTurn {
            source_turn_id: source_turn_id.into(),
            text: text.into(),
            interaction_node_id: Some(interaction_node_id.into()),
            invoke_origin: None,
            contexts: vec![],
            submitted_inputs,
            accepted_view: None,
        }
    };

    let answer_position = if scenario == "same-turn" {
        presenting_turn.submitted_inputs = vec![poison];
        input.turns.push(presenting_turn);
        input.turns.push(make_consumer(
            "turn-2",
            "input-root-2",
            "Keep this consuming turn",
            vec![answer],
        ));
        1
    } else {
        input.turns.push(make_consumer(
            "turn-1",
            "input-root-1",
            "Earlier placeholder turn",
            vec![],
        ));
        input.turns.push(make_consumer(
            "turn-2",
            "input-root-2",
            "Later than the consumer's turn",
            vec![poison],
        ));
        input.turns.push(presenting_turn);
        input.turns.push(make_consumer(
            "turn-4",
            "input-root-4",
            "Keep this consuming turn",
            vec![answer],
        ));
        3
    };

    let receipt = database.import_accepted_conversation(&input).await.unwrap();
    assert_eq!(receipt.skipped_submitted_inputs.len(), 1, "{scenario}");
    assert_eq!(
        receipt.skipped_submitted_inputs[0].submitted_input_id, "input-chronology-poison",
        "{scenario}"
    );
    let root = NodeId::new(receipt.turns[answer_position].graph_node_id.unwrap()).unwrap();
    let writer = database.writer_for_subgraph(root).await.unwrap();
    assert_eq!(
        writer.interaction_input().await.unwrap().submitted_inputs,
        vec![SubmittedInput {
            action: legacy_input,
            value: valid_value,
        }],
        "{scenario}"
    );
}

#[tokio::test]
async fn same_turn_legacy_snapshot_cannot_poison_later_answer() {
    assert_chronologically_invalid_legacy_snapshot_is_ignored("same-turn").await;
}

#[tokio::test]
async fn later_turn_legacy_snapshot_cannot_poison_later_answer() {
    assert_chronologically_invalid_legacy_snapshot_is_ignored("later-turn").await;
}

#[tokio::test]
async fn imported_action_origin_reconstructs_resolved_invoke_navigation() {
    let database = GraphDatabase::in_memory().await.unwrap();
    let receipt = database
        .import_accepted_conversation(&imported_invoke_conversation())
        .await
        .unwrap();
    let source = &receipt.turns[0];
    let destination = &receipt.turns[1];
    let source_writer = database
        .writer_for_subgraph(NodeId::new(source.graph_node_id.unwrap()).unwrap())
        .await
        .unwrap();
    let source_layer = source_writer
        .get_layer(LayerId::new(source.root_layer_id.unwrap()).unwrap())
        .await
        .unwrap();
    let invoke = source_layer
        .actions
        .iter()
        .find(|action| action.kind == ActionKind::Invoke)
        .unwrap();

    assert_eq!(
        source_layer.layer.client_key.as_deref(),
        Some("authored-layer-1")
    );
    assert_eq!(
        source_layer.nodes[0].client_key.as_deref(),
        Some("authored-node-1")
    );
    assert_eq!(
        invoke.client_key.as_deref(),
        Some("authored-invoke-action-1")
    );
    assert_eq!(
        invoke.source_layer_client_key.as_deref(),
        Some("authored-layer-1")
    );

    assert_eq!(
        invoke.target_layer_id.map(LayerId::value),
        destination.root_layer_id
    );
    assert_eq!(
        source_writer
            .get_layer_owner(invoke.target_layer_id.unwrap())
            .await
            .unwrap()
            .value(),
        destination.graph_node_id.unwrap()
    );
}

#[tokio::test]
async fn imported_bound_controls_and_call_evidence_reopen_without_execution_authority() {
    use base64::Engine as _;
    use sha2::Digest as _;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("inert-calls.sqlite3");
    let database = GraphDatabase::open(&path).await.unwrap();
    let mut input = imported_invoke_conversation();
    input.turns.truncate(1);
    let layer = &mut input.turns[0].accepted_view.as_mut().unwrap().layers[0];
    let mut field = layer.actions[0].clone();
    field.id = "input:destination".into();
    field.client_key = Some("destination-input".into());
    field.kind = "input".into();
    field.interaction_text = None;
    field.input = Some(InputAction {
        control: InputControl::Text,
        prompt: "Destination".into(),
        options: vec![],
        minimum_selections: None,
        unsupported_fields: Default::default(),
    });
    layer.actions[0].input_action_ids = vec![field.id.clone()];
    let mut standalone = field.clone();
    standalone.id = "input:outside-closure".into();
    standalone.client_key = Some("outside-closure-input".into());
    standalone.source_layer_id = Some("layer:outside-closure".into());
    layer.actions[0]
        .input_action_ids
        .push(standalone.id.clone());
    // Input definition deliberately follows Invoke in the stream.
    layer.actions.push(field);
    let bytes = b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>";
    let digest = format!("{:x}", sha2::Sha256::digest(bytes));
    standalone.icon = Some(serde_json::json!({"kind":"image","assetId":"bound-input-icon","digestSha256":digest,"mediaType":"image/svg+xml"}).to_string());
    standalone.icon_asset = Some(ImportedDetailAsset {
        asset_id: "bound-input-icon".into(),
        digest_sha256: digest.clone(),
        media_type: "image/svg+xml".into(),
        byte_length: bytes.len(),
        provenance_source: "system".into(),
        provenance_file_name: "input.svg".into(),
    });
    let evidence = vec![
        serde_json::json!({"schemaVersion":1,"id":"invocation:1","lifecycle":"active","childInteractionNodeId":"node:unbound-child","current":{"iconAsset":{"digestSha256":digest}}}),
    ];
    database
        .begin_imported_conversation(&ImportedConversationStage {
            import_id: input.import_id.clone(),
            source_sha256: input.source_sha256.clone(),
            project_id: input.project_id,
            thread_id: input.thread_id,
            created_at: input.created_at.clone(),
            inert_invocations: evidence.clone(),
            standalone_inputs: vec![standalone],
        })
        .await
        .unwrap();
    database
        .stage_imported_visual_asset_content(
            &input.import_id,
            &ImportedVisualAssetContent {
                digest_sha256: digest.clone(),
                media_type: "image/svg+xml".into(),
                byte_length: bytes.len(),
                content_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
            },
        )
        .await
        .unwrap();
    database
        .stage_imported_turn(&input.import_id, &input.turns[0])
        .await
        .unwrap();
    let receipt = database
        .finalize_imported_conversation(&input.import_id)
        .await
        .unwrap();
    drop(database);
    let reopened = GraphDatabase::open(&path).await.unwrap();
    let inspection = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(SqliteConnectOptions::new().filename(&path))
        .await
        .unwrap();
    let retained: Vec<u8> = sqlx::query_scalar(
        "SELECT content FROM inert_import_asset_contents WHERE import_id=?1 AND digest_sha256=?2",
    )
    .bind(&input.import_id)
    .bind(&digest)
    .fetch_one(&inspection)
    .await
    .unwrap();
    assert_eq!(retained, bytes);
    let standalone_id: i64 = sqlx::query_scalar("SELECT id FROM actions WHERE client_key='outside-closure-input' AND source_layer_id IS NULL")
        .fetch_one(&inspection).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM layer_actions WHERE action_id=?1")
            .bind(standalone_id)
            .fetch_one(&inspection)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM durable_invocations")
            .fetch_one(&inspection)
            .await
            .unwrap(),
        0
    );
    inspection.close().await;
    assert_eq!(
        reopened
            .imported_invocation_evidence(input.thread_id)
            .await
            .unwrap(),
        evidence
    );
    let writer = reopened
        .writer_for_subgraph(NodeId::new(receipt.turns[0].graph_node_id.unwrap()).unwrap())
        .await
        .unwrap();
    let layer = writer
        .get_layer(LayerId::new(receipt.turns[0].root_layer_id.unwrap()).unwrap())
        .await
        .unwrap();
    let invoke = layer
        .actions
        .iter()
        .find(|action| action.kind == ActionKind::Invoke)
        .unwrap();
    let field = layer
        .actions
        .iter()
        .find(|action| action.kind == ActionKind::Input)
        .unwrap();
    assert_eq!(
        invoke.input_action_ids,
        vec![field.id, ActionId::new(standalone_id).unwrap()]
    );
    let icon = writer
        .accepted_detail_asset(invoke.source_node_id, "bound-input-icon")
        .await
        .unwrap();
    assert_eq!(icon.content, bytes);
    assert_eq!(icon.digest_sha256, digest);
    assert_eq!(invoke.target_layer_id, None);
    assert!(matches!(
        writer
            .prepare_user_invocation(invoke.id, "must-not-execute")
            .await,
        Err(GraphError::Forbidden(_))
    ));
    assert!(matches!(
        writer
            .prepare_recursive_invocation(invoke.id, "must-not-execute")
            .await,
        Err(GraphError::Forbidden(_))
    ));
    assert!(
        reopened
            .activate_completion_authority(
                NodeId::new(receipt.turns[0].graph_node_id.unwrap()).unwrap()
            )
            .await
            .is_err()
    );
}

#[tokio::test]
async fn imported_invoke_reuse_declaration_reopens_exactly_without_execution_authority() {
    for reusable in [None, Some(false), Some(true)] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("imported-reuse.sqlite3");
        let database = GraphDatabase::open(&path).await.unwrap();
        let mut input = imported_invoke_conversation();
        input.turns.truncate(1);
        input.turns[0].accepted_view.as_mut().unwrap().layers[0].actions[0].reusable = reusable;
        let imported = database.import_accepted_conversation(&input).await.unwrap();
        let root = NodeId::new(imported.turns[0].graph_node_id.unwrap()).unwrap();
        let layer_id = LayerId::new(imported.turns[0].root_layer_id.unwrap()).unwrap();
        drop(database);
        let reopened = GraphDatabase::open(&path).await.unwrap();
        let writer = reopened.writer_for_subgraph(root).await.unwrap();
        let layer = writer.get_layer(layer_id).await.unwrap();
        let invoke = layer
            .actions
            .iter()
            .find(|action| action.kind == ActionKind::Invoke)
            .unwrap();
        assert_eq!(invoke.reusable, reusable);
        assert!(matches!(
            writer
                .prepare_user_invocation(invoke.id, "must-not-execute")
                .await,
            Err(GraphError::Forbidden(_))
        ));
    }
}

#[tokio::test]
async fn inert_import_rejects_invalid_bound_input_references() {
    for bindings in [
        vec!["missing-input".to_owned()],
        vec!["invoke-action-1".to_owned()],
        vec!["invoke-action-1".to_owned(), "invoke-action-1".to_owned()],
    ] {
        let database = GraphDatabase::in_memory().await.unwrap();
        let mut input = imported_invoke_conversation();
        input.turns.truncate(1);
        input.turns[0].accepted_view.as_mut().unwrap().layers[0].actions[0].input_action_ids =
            bindings;
        assert!(matches!(
            database.import_accepted_conversation(&input).await,
            Err(GraphError::Validation { .. })
        ));
    }
}

fn imported_converted_invoke_conversation() -> ImportedConversation {
    let mut input = imported_invoke_conversation();
    let action = &mut input.turns[0].accepted_view.as_mut().unwrap().layers[0].actions[0];
    action.kind = "navigate".into();
    action.relation = Some("expand".into());
    action.target_layer_id = Some("layer-2".into());
    action.interaction_text = None;
    action.converted_from_invoke = true;
    action.source_layer_id = None;
    let mut context_node =
        input.turns[0].accepted_view.as_ref().unwrap().layers[0].nodes[0].clone();
    context_node.client_key = None;
    input.turns[1].contexts.push(ImportedInteractionContext {
        id: "context-1".into(),
        target: context_node,
        source_interaction_node_id: "interaction-1".into(),
        source_layer_id: "layer-1".into(),
        annotations: vec![],
    });
    input.turns[1].accepted_view.as_mut().unwrap().layers[0].nodes[0].client_key =
        Some("authored-node-1".into());
    input.turns[1].accepted_view.as_mut().unwrap().layers[0]
        .layer
        .client_key = Some("authored-layer-1".into());
    input
}

#[tokio::test]
async fn imported_converted_invoke_reopens_as_inert_navigation_and_is_removable() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("graph.sqlite");
    let database = GraphDatabase::open(&path).await.unwrap();
    database
        .set_interaction_permissions_enabled(true)
        .await
        .unwrap();
    let input = imported_converted_invoke_conversation();
    let receipt = database.import_accepted_conversation(&input).await.unwrap();
    let source = NodeId::new(receipt.turns[0].graph_node_id.unwrap()).unwrap();
    let layer = LayerId::new(receipt.turns[0].root_layer_id.unwrap()).unwrap();
    database.close().await;
    let database = GraphDatabase::open(&path).await.unwrap();
    let writer = database.writer_for_subgraph(source).await.unwrap();
    let resolved = writer.get_layer(layer).await.unwrap();
    let action = &resolved.actions[0];
    assert_eq!(action.kind, ActionKind::Navigate);
    assert_eq!(action.relation, Some(NavigateRelation::Expand));
    assert_eq!(
        action.target_layer_id.map(LayerId::value),
        receipt.turns[1].root_layer_id
    );
    assert!(action.converted_from_invoke);
    assert_eq!(action.source_layer_id, None);
    assert_eq!(
        resolved.nodes[0].client_key.as_deref(),
        Some("authored-node-1")
    );
    assert_eq!(
        resolved.layer.client_key.as_deref(),
        Some("authored-layer-1")
    );
    let destination = writer
        .get_layer(action.target_layer_id.unwrap())
        .await
        .unwrap();
    assert_eq!(
        destination.nodes[0].client_key,
        resolved.nodes[0].client_key
    );
    assert_eq!(destination.layer.client_key, resolved.layer.client_key);
    assert_eq!(action.resolved_invoke_interaction_id, None);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&path)
                .foreign_keys(true),
        )
        .await
        .unwrap();
    for statement in [
        "UPDATE imported_action_conversions SET target_layer_id=target_layer_id WHERE action_id=?1",
        "DELETE FROM imported_action_conversions WHERE action_id=?1",
    ] {
        assert!(
            sqlx::query(statement)
                .bind(action.id.value())
                .execute(&pool)
                .await
                .is_err()
        );
    }
    let native_receipts: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM invoke_resolution_transitions")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(native_receipts, 0);
    let stored_key: (String, String) = sqlx::query_as("SELECT n.client_key,k.client_key FROM nodes n JOIN imported_node_client_keys k ON k.node_id=n.id WHERE n.id=?1")
        .bind(resolved.nodes[0].id.value()).fetch_one(&pool).await.unwrap();
    assert_eq!(stored_key, ("node-1".into(), "authored-node-1".into()));
    for (table, column, id) in [
        (
            "imported_node_client_keys",
            "node_id",
            resolved.nodes[0].id.value(),
        ),
        (
            "imported_layer_client_keys",
            "layer_id",
            resolved.layer.id.value(),
        ),
    ] {
        for statement in [
            format!("UPDATE {table} SET client_key='changed' WHERE {column}=?1"),
            format!("DELETE FROM {table} WHERE {column}=?1"),
            format!(
                "INSERT INTO {table}({column},import_id,client_key) VALUES (?1,'wrong-import','tampered')"
            ),
        ] {
            let error = sqlx::query(&statement)
                .bind(id)
                .execute(&pool)
                .await
                .unwrap_err();
            assert!(error.to_string().contains("imported_"), "{error}");
        }
    }
    pool.close().await;
    assert_eq!(
        database.interaction_permissions(source).await.unwrap(),
        None
    );
    assert!(
        writer
            .authorize_interaction_permission(&InteractionPermission::NavigateAdd {
                node_id: action.source_node_id,
            })
            .await
            .is_err()
    );
    assert!(
        database
            .create_interaction_with_invocation(
                None,
                thread(999),
                "Retry imported action",
                Some(InteractionInvocation {
                    source_interaction_node_id: source,
                    source_action_id: action.id,
                })
            )
            .await
            .is_err()
    );
    database
        .remove_imported_conversation(&input.import_id)
        .await
        .unwrap();
    // Removal cascades the inert provenance; the same import can then be restored.
    database.import_accepted_conversation(&input).await.unwrap();
}

#[tokio::test]
async fn imported_external_source_provenance_preserves_compiled_keys_without_response_topology() {
    use sha2::{Digest, Sha256};
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("graph.sqlite");
    let database = GraphDatabase::open(&path).await.unwrap();
    let mut input = imported_converted_invoke_conversation();
    input.project_id = Some(project(1));
    let resolved = &mut input.turns[0].accepted_view.as_mut().unwrap().layers[0];
    resolved.actions[0].source_layer_id = Some("external-layer".into());
    let mut package = serde_json::json!({"version":1,"assets":[],
    "components":[{"id":"main","order":0,"css":"", "html":"<button data-gc-mount=\"continue\">Continue</button>"}],
    "mounts":[{"id":"continue","componentId":"main","host":"button","kind":"capability", "capability":{"kind":"invoke", "action":{
        "clientKey":"authored-invoke-action-1", "sourceNode":{"clientKey":"authored-node-1"}, "sourceLayer":{"clientKey":"original-outside-layer"}
    }}}]});
    package["integritySha256"] = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&package).unwrap())
    )
    .into();
    resolved.nodes[0].authored_detail = Some(package.clone());
    let receipt = database.import_accepted_conversation(&input).await.unwrap();
    database.close().await;
    let database = GraphDatabase::open(&path).await.unwrap();
    let writer = database
        .writer_for_subgraph(NodeId::new(receipt.turns[0].graph_node_id.unwrap()).unwrap())
        .await
        .unwrap();
    let closure = database
        .accepted_graph_closure(NodeId::new(receipt.turns[0].graph_node_id.unwrap()).unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        closure.layers.len(),
        2,
        "provenance placeholders never enter the response closure"
    );
    let root = writer
        .get_layer(LayerId::new(receipt.turns[0].root_layer_id.unwrap()).unwrap())
        .await
        .unwrap();
    assert_eq!(root.nodes[0].authored_detail, Some(package.clone()));
    assert_eq!(
        root.actions[0].source_layer_client_key.as_deref(),
        Some("original-outside-layer")
    );
    let provenance = root.actions[0].source_layer_id.unwrap();
    let native = database
        .create_interaction(Some(project(1)), thread(9099), "Native after import")
        .await
        .unwrap();
    let native_writer = database.writer_for_subgraph(native.id).await.unwrap();
    let answer = node(&native_writer, "answer").await;
    let native_layer = single_node_layer(&native_writer, "response", &answer).await;
    root_expand(&native_writer, &native, &native_layer).await;
    let error = native_writer
        .add_action(&ActionDraft {
            client_key: "reject-provenance-target".into(),
            source_node_id: answer.id,
            source_layer_id: Some(native_layer.id),
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Reference),
            label: "Invalid target".into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: Some(provenance),
            interaction_text: None,
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        GraphError::Validation {
            code: "unknown_target_layer",
            ..
        }
    ));
    assert!(matches!(
        writer.get_layer(provenance).await,
        Err(GraphError::NotFound(_))
    ));
    assert!(matches!(
        native_writer.get_layer(provenance).await,
        Err(GraphError::NotFound(_))
    ));
    assert!(matches!(
        native_writer.get_layer_owner(provenance).await,
        Err(GraphError::NotFound(_))
    ));
    native_writer.complete(native.id).await.unwrap();
    assert_eq!(
        database
            .accepted_graph_closure(native.id)
            .await
            .unwrap()
            .unwrap()
            .layers
            .len(),
        1
    );
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&path)
                .foreign_keys(true),
        )
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT import_id FROM imported_provenance_layers WHERE layer_id=?1"
        )
        .bind(provenance.value())
        .fetch_one(&pool)
        .await
        .unwrap(),
        input.import_id
    );
    for statement in [
        "UPDATE imported_provenance_layers SET import_id=import_id WHERE layer_id=?1",
        "DELETE FROM imported_provenance_layers WHERE layer_id=?1",
    ] {
        let error = sqlx::query(statement)
            .bind(provenance.value())
            .execute(&pool)
            .await
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("immutable_imported_provenance_layer")
        );
    }
    let error = sqlx::query("INSERT INTO actions(project_id,thread_id,source_node_id,source_layer_id,kind,relation,label,target_layer_id,state,owner_interaction_id,client_key) VALUES (1,9099,?1,?2,'navigate','reference','Forged target',?3,'draft',?4,'forged')")
        .bind(answer.id.value()).bind(native_layer.id.value()).bind(provenance.value()).bind(native.id.value())
        .execute(&pool).await.unwrap_err();
    assert!(
        error
            .to_string()
            .contains("imported_provenance_layer_is_not_target")
    );
    let error = sqlx::query("INSERT INTO layer_nodes(layer_id,node_id,position) VALUES (?1,?2,0)")
        .bind(provenance.value())
        .bind(root.nodes[0].id.value())
        .execute(&pool)
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("imported_provenance_layer_has_no_topology")
    );
    database
        .remove_imported_conversation(&input.import_id)
        .await
        .unwrap();

    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM imported_provenance_layers")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    pool.close().await;

    // A second compiled binding to the same action cannot relabel its provenance.
    package.as_object_mut().unwrap().remove("integritySha256");
    package["components"][0]["html"] = "<button data-gc-mount=\"continue\">Continue</button><button data-gc-mount=\"other\">Other</button>".into();
    let mut other = package["mounts"][0].clone();
    other["id"] = "other".into();
    other["capability"]["action"]["sourceLayer"]["clientKey"] = "conflicting-layer".into();
    package["mounts"].as_array_mut().unwrap().push(other);
    package["integritySha256"] = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&package).unwrap())
    )
    .into();
    input.turns[0].accepted_view.as_mut().unwrap().layers[0].nodes[0].authored_detail =
        Some(package);
    let error = database
        .import_accepted_conversation(&input)
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        GraphError::Validation {
            code: "imported_source_layer_key_conflict",
            ..
        }
    ));
}

#[tokio::test]
async fn imported_converted_invoke_rejects_malformed_or_redirected_history_atomically() {
    let database = GraphDatabase::in_memory().await.unwrap();
    for invalid in [
        "target",
        "missing-target",
        "provenance-target",
        "kind",
        "relation",
        "text",
        "root",
        "duplicate",
    ] {
        let mut input = imported_converted_invoke_conversation();
        let action = &mut input.turns[0].accepted_view.as_mut().unwrap().layers[0].actions[0];
        match invalid {
            "target" => action.target_layer_id = Some("layer-1".into()),
            "missing-target" => action.target_layer_id = Some("layer-missing".into()),
            "provenance-target" => {
                action.target_layer_id = Some("external-layer".into());
                action.source_layer_id = Some("external-layer".into());
            }
            "kind" => action.kind = "invoke".into(),
            "relation" => action.relation = Some("reference".into()),
            "text" => action.interaction_text = Some("Run again".into()),
            "root" => {
                input.turns[0]
                    .accepted_view
                    .as_mut()
                    .unwrap()
                    .root_action
                    .converted_from_invoke = true
            }
            "duplicate" => {
                let mut duplicate =
                    input.turns[0].accepted_view.as_ref().unwrap().layers[0].clone();
                duplicate.actions[0].converted_from_invoke = false;
                input.turns[1]
                    .accepted_view
                    .as_mut()
                    .unwrap()
                    .layers
                    .push(duplicate);
            }
            _ => unreachable!(),
        }
        assert!(
            database.import_accepted_conversation(&input).await.is_err(),
            "{invalid}"
        );
    }
    // A graph closure need not carry the destination Product turn's provenance.
    let mut valid = imported_converted_invoke_conversation();
    valid.turns[1].invoke_origin = None;
    database.import_accepted_conversation(&valid).await.unwrap();
}

#[tokio::test]
async fn imported_cross_role_node_collision_rolls_back_atomically() {
    let database = GraphDatabase::in_memory().await.unwrap();
    let invalid = imported_conversation("node-1");
    let error = database
        .import_accepted_conversation(&invalid)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("collides"));

    let valid = imported_conversation("interaction-1");
    database
        .import_accepted_conversation(&valid)
        .await
        .expect("failed import must not retain its import identity");
}

async fn node(writer: &GraphWriter, key: &str) -> GraphNode {
    writer
        .submit_node(&NodeDraft {
            client_key: key.into(),
            kind: "concept".into(),
            icon: "box".into(),
            title: key.into(),
            detail: format!("detail {key}"),
        })
        .await
        .unwrap()
}

async fn single_node_layer(writer: &GraphWriter, key: &str, node: &GraphNode) -> GraphLayer {
    writer
        .submit_layer(&LayerDraft {
            default_node_id: None,
            client_key: key.into(),
            nodes: vec![node.id],
            edges: vec![],
            layout: authored_layout([node.id]),
            size_justification: None,
        })
        .await
        .unwrap()
}

async fn root_expand(
    writer: &GraphWriter,
    interaction: &GraphNode,
    target: &GraphLayer,
) -> GraphAction {
    writer
        .add_action(&ActionDraft {
            client_key: "response".into(),
            source_node_id: interaction.id,
            source_layer_id: None,
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Expand),
            label: "Response".into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: Some(target.id),
            interaction_text: None,
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .unwrap()
}

async fn accepted_invoke(
    database: &GraphDatabase,
    interaction: &GraphNode,
) -> (GraphNode, GraphAction) {
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let source = node(&writer, "invoke-source").await;
    let layer = single_node_layer(&writer, "invoke-layer", &source).await;
    let action = writer
        .add_action(&ActionDraft {
            client_key: "invoke".into(),
            source_node_id: source.id,
            source_layer_id: Some(layer.id),
            kind: ActionKind::Invoke,
            relation: None,
            label: "Continue".into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: Some("Continue this answer".into()),
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .unwrap();
    root_expand(&writer, interaction, &layer).await;
    writer.complete(interaction.id).await.unwrap();
    (source, action)
}

async fn navigate(
    writer: &GraphWriter,
    key: &str,
    source: &GraphNode,
    source_layer: &GraphLayer,
    target: &GraphLayer,
    relation: NavigateRelation,
) -> GraphAction {
    writer
        .add_action(&ActionDraft {
            client_key: key.into(),
            source_node_id: source.id,
            source_layer_id: Some(source_layer.id),
            kind: ActionKind::Navigate,
            relation: Some(relation),
            label: key.into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: Some(target.id),
            interaction_text: None,
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .unwrap()
}

async fn accept_single_node(
    writer: &GraphWriter,
    interaction: GraphNode,
    node: GraphNode,
) -> GraphLayer {
    let layer = writer
        .submit_layer(&LayerDraft {
            default_node_id: None,
            client_key: "root".into(),
            nodes: vec![node.id],
            edges: vec![],
            layout: authored_layout([node.id]),
            size_justification: None,
        })
        .await
        .unwrap();
    writer
        .add_action(&ActionDraft {
            client_key: "response".into(),
            source_node_id: interaction.id,
            source_layer_id: None,
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Expand),
            label: "Response".into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: Some(layer.id),
            interaction_text: None,
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .unwrap();
    writer.complete(interaction.id).await.unwrap();
    layer
}

#[tokio::test]
async fn personal_presentation_attachment_is_control_owned_one_shot_and_hidden_from_completion() {
    let temporary = tempfile::tempdir().unwrap();
    let file = tempfile::NamedTempFile::new_in(temporary.path()).unwrap();
    let database = GraphDatabase::open(file.path()).await.unwrap();
    let version = personal_presentation_interaction(
        &database,
        "Personal presentation version V1",
        "relayer.personal-presentation:test-v1",
    )
    .await;
    let version_writer = database.writer_for_subgraph(version.id).await.unwrap();
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
    let preference_root = accept_single_node(&version_writer, version.clone(), preference).await;
    database
        .publish_personal_presentation_version(version.id)
        .await
        .unwrap();
    assert!(matches!(
        database
            .attach_personal_presentation(version.id, version.id)
            .await,
        Err(GraphError::NotFound(_))
    ));
    assert!(
        database
            .personal_presentation_attachment(version.id)
            .await
            .unwrap()
            .is_none()
    );

    let target = database
        .create_interaction(Some(project(1)), thread(1), "Explain the queue")
        .await
        .unwrap();
    let first = database
        .attach_personal_presentation(target.id, version.id)
        .await
        .unwrap();
    let replay = database
        .attach_personal_presentation(target.id, version.id)
        .await
        .unwrap();
    assert_eq!(first, replay);
    assert_eq!(first.interaction_node_id, target.id);
    assert_eq!(first.version_interaction_node_id, version.id);
    assert_eq!(first.root_layer_id, preference_root.id);

    let resolved = database
        .personal_presentation_attachment(target.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(resolved.attachment, first);
    assert_eq!(resolved.graph.root_layer_id, preference_root.id);
    assert_eq!(
        resolved.graph.layers[0].nodes[0].kind,
        "presentation-preference"
    );

    let fixture = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(file.path())
                .foreign_keys(true),
        )
        .await
        .unwrap();
    sqlx::query(
        "UPDATE personal_presentation_versions SET retired=1 WHERE version_interaction_node_id=?1",
    )
    .bind(version.id.value())
    .execute(&fixture)
    .await
    .unwrap();
    assert_eq!(
        database
            .attach_personal_presentation(target.id, version.id)
            .await
            .unwrap(),
        first
    );
    let new_target = database
        .create_interaction(Some(project(1)), thread(1), "New interaction")
        .await
        .unwrap();
    assert!(matches!(
        database
            .attach_personal_presentation(new_target.id, version.id)
            .await,
        Err(GraphError::Validation {
            code: "personal_presentation_version_retired",
            ..
        })
    ));

    let target_writer = database.writer_for_subgraph(target.id).await.unwrap();
    let answer = node(&target_writer, "answer").await;
    accept_single_node(&target_writer, target.clone(), answer).await;
    let response = database
        .accepted_graph_closure(target.id)
        .await
        .unwrap()
        .unwrap();
    assert!(
        response
            .layers
            .iter()
            .all(|layer| layer.layer.id != preference_root.id)
    );

    let other_version = personal_presentation_interaction(
        &database,
        "Personal presentation version V2",
        "relayer.personal-presentation:test-v2",
    )
    .await;
    let other_writer = database
        .writer_for_subgraph(other_version.id)
        .await
        .unwrap();
    let other_preference = node(&other_writer, "other-preference").await;
    accept_single_node(&other_writer, other_version.clone(), other_preference).await;
    database
        .publish_personal_presentation_version(other_version.id)
        .await
        .unwrap();
    let replacement = database
        .attach_personal_presentation(target.id, other_version.id)
        .await
        .unwrap_err();
    assert!(
        replacement
            .to_string()
            .contains("already pins another personal presentation version")
    );
}

#[tokio::test]
async fn interaction_context_is_control_authored_ordered_and_excluded_from_completion() {
    let database = GraphDatabase::in_memory().await.unwrap();
    let source = database
        .create_interaction(Some(project(1)), thread(1), "Source")
        .await
        .unwrap();
    let source_writer = database.writer_for_subgraph(source.id).await.unwrap();
    let target = node(&source_writer, "accepted-target").await;
    let source_layer = accept_single_node(&source_writer, source.clone(), target.clone()).await;

    let drafts = [InteractionContextDraft {
        target: InteractionContextTarget {
            node_id: target.id,
            source_interaction_node_id: source.id,
            source_layer_id: source_layer.id,
        },
        annotations: vec![
            "  preserve exact whitespace  ".into(),
            "Second\nline".into(),
        ],
    }];
    let input_digest =
        relayer_graph_core::interaction_input_digest("Compare this", &drafts).unwrap();
    let (interaction, actions) = database
        .create_identified_interaction_with_context(
            Some(project(1)),
            thread(2),
            "Compare this",
            "product:41",
            &input_digest,
            &drafts,
        )
        .await
        .unwrap();
    assert_eq!(actions.len(), 1);
    assert_eq!(actions[0].type_id, "interaction.context");
    let (replayed, replayed_actions) = database
        .create_identified_interaction_with_context(
            Some(project(1)),
            thread(2),
            "Compare this",
            "product:41",
            &input_digest,
            &drafts,
        )
        .await
        .unwrap();
    assert_eq!(replayed.id, interaction.id);
    assert_eq!(replayed_actions, actions);
    for replay_project in [Some(project(2)), None] {
        let scope_conflict = database
            .create_identified_interaction_with_context(
                replay_project,
                thread(2),
                "Compare this",
                "product:41",
                &input_digest,
                &drafts,
            )
            .await
            .unwrap_err();
        assert!(matches!(
            scope_conflict,
            GraphError::Validation {
                code: "interaction_input_conflict",
                path,
                ..
            } if path == "projectId"
        ));
    }
    let changed_digest = relayer_graph_core::interaction_input_digest("Changed", &drafts).unwrap();
    let conflict = database
        .create_identified_interaction_with_context(
            Some(project(1)),
            thread(2),
            "Changed",
            "product:41",
            &changed_digest,
            &drafts,
        )
        .await
        .unwrap_err();
    assert!(matches!(
        conflict,
        GraphError::Validation {
            code: "interaction_input_conflict",
            ..
        }
    ));
    let forged_digest = database
        .create_identified_interaction_with_context(
            Some(project(1)),
            thread(2),
            "Compare this",
            "product:42",
            "sha256:v1:forged",
            &drafts,
        )
        .await
        .unwrap_err();
    assert!(matches!(
        forged_digest,
        GraphError::Validation {
            code: "interaction_input_digest_mismatch",
            ..
        }
    ));

    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let input = writer.interaction_input().await.unwrap();
    assert_eq!(input.interaction.id, interaction.id);
    assert_eq!(input.contexts.len(), 1);
    assert_eq!(input.contexts[0].target_node.id, target.id);
    assert_eq!(input.contexts[0].target_node.title, target.title);
    assert_eq!(input.contexts[0].target_node.state, RecordState::Accepted);
    assert_eq!(
        input.contexts[0].annotations,
        ["  preserve exact whitespace  ", "Second\nline"]
    );

    let answer = node(&writer, "answer").await;
    let answer_layer = single_node_layer(&writer, "answer-layer", &answer).await;
    let reserved_key = writer
        .add_action(&ActionDraft {
            client_key: "\0interaction.context:0".into(),
            source_node_id: interaction.id,
            source_layer_id: None,
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Expand),
            label: "Response".into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: Some(answer_layer.id),
            interaction_text: None,
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(
        reserved_key,
        GraphError::Validation {
            code: "reserved_action_client_key",
            ..
        }
    ));
    writer
        .add_action(&ActionDraft {
            client_key: "interaction.context:0".into(),
            source_node_id: interaction.id,
            source_layer_id: None,
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Expand),
            label: "Response".into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: Some(answer_layer.id),
            interaction_text: None,
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .expect("context control identity must not consume an LM client key");
    let output = writer.complete(interaction.id).await.unwrap();
    assert_eq!(output.root_layer.actions.len(), 0);
    assert_eq!(
        writer.complete(interaction.id).await.unwrap(),
        output,
        "legacy graph.submit remains retry-safe while temporal current is dark"
    );
    assert_eq!(writer.completion_output().await.unwrap(), Some(output));
    assert_eq!(writer.interaction_input().await.unwrap().contexts.len(), 1);
}

#[tokio::test]
async fn interaction_context_accepts_published_current_before_turn_completion() {
    let (database, source) = setup(None, thread(1)).await;
    let writer = database.writer_for_subgraph(source.id).await.unwrap();
    let target = node(&writer, "working-answer").await;
    let layer = single_node_layer(&writer, "working-current", &target).await;
    root_expand(&writer, &source, &layer).await;
    let occurrence = InteractionContextTarget {
        node_id: target.id,
        source_interaction_node_id: source.id,
        source_layer_id: layer.id,
    };
    assert!(
        database
            .canonical_interaction_context_occurrence(&occurrence)
            .await
            .is_err()
    );
    writer
        .transition_current(
            0,
            "publish-answer",
            CurrentTransition::Advance { layer_id: layer.id },
        )
        .await
        .unwrap();
    let accepted = database
        .canonical_interaction_context_occurrence(&occurrence)
        .await
        .unwrap();
    assert_eq!(accepted.state, RecordState::Accepted);
    assert!(writer.completion_output().await.unwrap().is_none());

    let later = node(&writer, "later-answer").await;
    let later_layer = single_node_layer(&writer, "later-current", &later).await;
    root_expand(&writer, &source, &later_layer).await;
    writer
        .add_action(&ActionDraft {
            client_key: "retain-annotated-current".into(),
            source_node_id: later.id,
            source_layer_id: Some(later_layer.id),
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Reference),
            label: "Earlier accepted result".into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: Some(layer.id),
            interaction_text: None,
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .unwrap();
    writer
        .transition_current(
            1,
            "publish-later",
            CurrentTransition::Advance {
                layer_id: later_layer.id,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        database
            .canonical_interaction_context_occurrence(&occurrence)
            .await
            .unwrap(),
        accepted
    );
    let wrong_source = database
        .create_interaction(None, thread(1), "Unrelated turn")
        .await
        .unwrap();
    assert!(
        database
            .canonical_interaction_context_occurrence(&InteractionContextTarget {
                source_interaction_node_id: wrong_source.id,
                ..occurrence.clone()
            })
            .await
            .is_err()
    );
    let (followup, _) = database
        .create_interaction_with_context(
            None,
            thread(1),
            "Use this",
            &[InteractionContextDraft {
                target: occurrence,
                annotations: vec!["Keep this accepted result".into()],
            }],
        )
        .await
        .unwrap();
    let input = database
        .writer_for_subgraph(followup.id)
        .await
        .unwrap()
        .interaction_input()
        .await
        .unwrap();
    assert_eq!(input.contexts[0].target_node, accepted);
    assert_eq!(
        input.contexts[0].annotations,
        vec!["Keep this accepted result"]
    );
}

#[tokio::test]
async fn interaction_context_rejects_duplicate_invalid_and_empty_input_atomically() {
    let database = GraphDatabase::in_memory().await.unwrap();
    let source = database
        .create_interaction(Some(project(1)), thread(1), "Source")
        .await
        .unwrap();
    let source_writer = database.writer_for_subgraph(source.id).await.unwrap();
    let target = node(&source_writer, "target").await;
    let source_layer = accept_single_node(&source_writer, source.clone(), target.clone()).await;
    let other = database
        .create_interaction(Some(project(1)), thread(3), "Other source")
        .await
        .unwrap();
    let other_writer = database.writer_for_subgraph(other.id).await.unwrap();
    let other_node = node(&other_writer, "other").await;
    let other_layer = accept_single_node(&other_writer, other.clone(), other_node.clone()).await;

    let occurrence = InteractionContextDraft {
        target: InteractionContextTarget {
            node_id: target.id,
            source_interaction_node_id: source.id,
            source_layer_id: source_layer.id,
        },
        annotations: vec!["Use this".into()],
    };
    let mut accepted_target = target.clone();
    accepted_target.state = RecordState::Accepted;
    assert_eq!(
        database
            .canonical_interaction_context_occurrence(&occurrence.target)
            .await
            .unwrap(),
        InteractionInputNode::from(accepted_target)
    );

    let unreachable = InteractionContextTarget {
        node_id: other_node.id,
        source_interaction_node_id: source.id,
        source_layer_id: other_layer.id,
    };
    let unreachable_error = database
        .canonical_interaction_context_occurrence(&unreachable)
        .await
        .unwrap_err();
    assert!(matches!(
        unreachable_error,
        GraphError::Validation {
            code: "invalid_context_occurrence",
            ref path,
            ..
        } if path == "target"
    ));

    let missing_source = database
        .canonical_interaction_context_occurrence(&InteractionContextTarget {
            source_interaction_node_id: NodeId::new(999_999).unwrap(),
            ..occurrence.target.clone()
        })
        .await
        .unwrap_err();
    assert!(matches!(
        missing_source,
        GraphError::Validation {
            code: "invalid_context_occurrence",
            ref path,
            ..
        } if path == "target"
    ));
    let duplicate = database
        .create_interaction_with_context(
            Some(project(1)),
            thread(2),
            "Duplicate",
            &[occurrence.clone(), occurrence.clone()],
        )
        .await
        .unwrap_err();
    assert!(matches!(
        duplicate,
        GraphError::Validation {
            code: "duplicate_context_target",
            ..
        }
    ));

    let invalid = database
        .create_interaction_with_context(
            Some(project(1)),
            thread(2),
            "Invalid occurrence",
            &[InteractionContextDraft {
                target: InteractionContextTarget {
                    source_interaction_node_id: other.id,
                    ..occurrence.target.clone()
                },
                annotations: vec!["Use this".into()],
            }],
        )
        .await
        .unwrap_err();
    assert!(matches!(
        invalid,
        GraphError::Validation {
            code: "invalid_context_occurrence",
            ..
        }
    ));
    let invalid_root = database
        .set_temporal_features(TemporalFeatureConfig {
            root_current_write: true,
            ..TemporalFeatureConfig::default()
        })
        .await
        .unwrap_err();
    assert!(matches!(
        invalid_root,
        GraphError::Validation {
            code: "invalid_temporal_feature_dependency",
            ..
        }
    ));

    let unreachable_create = database
        .create_interaction_with_context(
            Some(project(1)),
            thread(2),
            "Unreachable occurrence",
            &[InteractionContextDraft {
                target: unreachable,
                annotations: vec!["Use this".into()],
            }],
        )
        .await
        .unwrap_err();
    assert!(matches!(
        unreachable_create,
        GraphError::Validation {
            code: "invalid_context_occurrence",
            ..
        }
    ));

    let empty = database
        .create_interaction_with_context(
            Some(project(1)),
            thread(2),
            "",
            &[InteractionContextDraft {
                annotations: vec![],
                ..occurrence
            }],
        )
        .await
        .unwrap_err();
    assert!(matches!(
        empty,
        GraphError::Validation {
            code: "missing_interaction_input",
            ..
        }
    ));

    let next = database
        .create_interaction(Some(project(1)), thread(2), "Next valid interaction")
        .await
        .unwrap();
    assert!(
        database
            .writer_for_subgraph(next.id)
            .await
            .unwrap()
            .interaction_input()
            .await
            .unwrap()
            .contexts
            .is_empty()
    );
}

#[tokio::test]
async fn interaction_context_has_no_eight_target_cap() {
    let database = GraphDatabase::in_memory().await.unwrap();
    let mut drafts = Vec::new();
    for index in 0..9 {
        let source = database
            .create_interaction(Some(project(1)), thread(10 + index), "Source")
            .await
            .unwrap();
        let writer = database.writer_for_subgraph(source.id).await.unwrap();
        let target = node(&writer, &format!("target-{index}")).await;
        let layer = accept_single_node(&writer, source.clone(), target.clone()).await;
        drafts.push(InteractionContextDraft {
            target: InteractionContextTarget {
                node_id: target.id,
                source_interaction_node_id: source.id,
                source_layer_id: layer.id,
            },
            annotations: vec![],
        });
    }
    let (interaction, actions) = database
        .create_interaction_with_context(Some(project(1)), thread(99), "Use all", &drafts)
        .await
        .unwrap();
    assert_eq!(actions.len(), 9);
    assert_eq!(
        database
            .writer_for_subgraph(interaction.id)
            .await
            .unwrap()
            .interaction_input()
            .await
            .unwrap()
            .contexts
            .len(),
        9
    );
}

#[tokio::test]
async fn root_action_replay_updates_same_key_and_rejects_a_different_key_without_persisting_it() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let first = node(&writer, "first-answer").await;
    let first_layer = single_node_layer(&writer, "first-layer", &first).await;

    let original = root_expand(&writer, &interaction, &first_layer).await;
    let conflict = writer
        .add_action(&ActionDraft {
            client_key: "another-response".into(),
            source_node_id: interaction.id,
            source_layer_id: None,
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Expand),
            label: "Conflicting response".into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: Some(first_layer.id),
            interaction_text: None,
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .unwrap_err();
    match conflict {
        GraphError::Validation {
            code,
            path,
            message,
        } => {
            assert_eq!(code, "root_action_already_exists");
            assert_eq!(path, "clientKey");
            assert!(message.contains(&original.id.to_string()));
            assert!(message.contains("response"));
        }
        other => panic!("expected root-action validation error, got {other:?}"),
    }

    let replayed = writer
        .add_action(&ActionDraft {
            client_key: "response".into(),
            source_node_id: interaction.id,
            source_layer_id: None,
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Expand),
            label: "Updated response".into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: Some(first_layer.id),
            interaction_text: None,
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .unwrap();
    assert_eq!(replayed.id, original.id);
    assert_eq!(replayed.label, "Updated response");

    let output = writer.complete(interaction.id).await.unwrap();
    assert_eq!(output.root_layer.layer.id, first_layer.id);
}

#[tokio::test]
async fn concurrent_root_action_writes_allow_exactly_one_client_key() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let setup_writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let answer = node(&setup_writer, "answer").await;
    let layer = single_node_layer(&setup_writer, "root-layer", &answer).await;
    let first_writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let second_writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let draft = |client_key: &str| ActionDraft {
        client_key: client_key.into(),
        source_node_id: interaction.id,
        source_layer_id: None,
        kind: ActionKind::Navigate,
        relation: Some(NavigateRelation::Expand),
        label: client_key.into(),
        variant: ActionVariant::default(),
        icon: None,
        description: None,
        target_layer_id: Some(layer.id),
        interaction_text: None,
        reusable: None,
        input_action_ids: Vec::new(),
        input: None,
    };
    let first_draft = draft("first-root");
    let second_draft = draft("second-root");

    let (first, second) = tokio::join!(
        first_writer.add_action(&first_draft),
        second_writer.add_action(&second_draft)
    );
    let results = [first, second];
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(
                result,
                Err(GraphError::Validation {
                    code: "root_action_already_exists",
                    ..
                })
            ))
            .count(),
        1
    );
}

#[tokio::test]
async fn product_identifiers_are_external_inputs() {
    let (database, interaction) = setup(Some(project(41)), thread(73)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    assert_eq!(writer.node_id(), interaction.id);
}

#[tokio::test]
async fn current_advance_is_atomic_durable_and_idempotent() {
    let temporary = tempfile::tempdir().unwrap();
    let file = tempfile::NamedTempFile::new_in(temporary.path()).unwrap();
    let database = GraphDatabase::open(file.path()).await.unwrap();
    let interaction = database
        .create_interaction(Some(project(1)), thread(1), "Publish useful work")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();

    let initial = writer.current_completion().await.unwrap();
    assert_eq!(initial.completion_id, interaction.id);
    assert_eq!(initial.head_revision, 0);
    assert_eq!(initial.current_layer_id, None);
    assert_eq!(initial.lifecycle, CompletionLifecycle::Active);

    let answer = node(&writer, "working-answer").await;
    let layer = single_node_layer(&writer, "working-current", &answer).await;
    root_expand(&writer, &interaction, &layer).await;
    let first = writer
        .transition_current(
            0,
            "advance-working-current",
            CurrentTransition::Advance { layer_id: layer.id },
        )
        .await
        .unwrap();
    assert_eq!(first.revision, 1);
    assert_eq!(first.current_layer_id, Some(layer.id));
    assert_eq!(
        writer.get_layer(layer.id).await.unwrap().layer.state,
        RecordState::Accepted
    );

    let replay = writer
        .transition_current(
            0,
            "advance-working-current",
            CurrentTransition::Advance { layer_id: layer.id },
        )
        .await
        .unwrap();
    assert_eq!(replay, first);

    drop(writer);
    database.close().await;
    let reopened = GraphDatabase::open(file.path()).await.unwrap();
    let recovered = reopened
        .writer_for_subgraph(interaction.id)
        .await
        .unwrap()
        .current_completion()
        .await
        .unwrap();
    assert_eq!(recovered.head_revision, 1);
    assert_eq!(recovered.current_layer_id, Some(layer.id));
    assert_eq!(recovered.lifecycle, CompletionLifecycle::Active);
}

#[tokio::test]
async fn returning_the_existing_current_appends_a_terminal_revision_without_cloning_graph() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let answer = node(&writer, "answer").await;
    let layer = single_node_layer(&writer, "current", &answer).await;
    root_expand(&writer, &interaction, &layer).await;
    writer
        .transition_current(
            0,
            "advance-current",
            CurrentTransition::Advance { layer_id: layer.id },
        )
        .await
        .unwrap();
    root_expand(&writer, &interaction, &layer).await;

    let returned = writer
        .transition_current(
            1,
            "return-current",
            CurrentTransition::Return { layer_id: layer.id },
        )
        .await
        .unwrap();
    assert_eq!(returned.revision, 2);
    assert_eq!(returned.lifecycle, CompletionLifecycle::Succeeded);
    assert_eq!(returned.current_layer_id, Some(layer.id));
    assert_eq!(returned.final_layer_id, Some(layer.id));
    let state = writer.current_completion().await.unwrap();
    assert_eq!(state.lifecycle, CompletionLifecycle::Succeeded);
    assert_eq!(state.head_revision, 2);
    assert_eq!(
        writer
            .completion_output()
            .await
            .unwrap()
            .unwrap()
            .root_layer
            .layer
            .id,
        layer.id
    );

    let replay = writer
        .transition_current(
            1,
            "return-current",
            CurrentTransition::Return { layer_id: layer.id },
        )
        .await
        .unwrap();
    assert_eq!(replay, returned);
}

#[tokio::test]
async fn app_server_failure_reasons_are_canonical() {
    // The app server fails recursive children with these reasons. A reason the
    // graph rejects is retried forever and never terminalizes the completion.
    let database = GraphDatabase::in_memory().await.unwrap();
    database
        .set_temporal_features(TemporalFeatureConfig {
            schema_read: true,
            root_current_write: true,
            ..TemporalFeatureConfig::default()
        })
        .await
        .unwrap();
    for reason in [
        "provider_start_failed",
        "provider_attachment_persist_failed",
        "graph_observation_failed",
        "capability_activation_failed",
        "preparation_failed",
    ] {
        let interaction = database
            .create_interaction(Some(project(1)), thread(1), reason)
            .await
            .unwrap();
        let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
        let failed = writer
            .transition_current(
                0,
                reason,
                CurrentTransition::Fail {
                    reason: reason.into(),
                },
            )
            .await
            .unwrap_or_else(|error| panic!("{reason} was rejected: {error}"));
        assert_eq!(failed.lifecycle, CompletionLifecycle::Failed);
    }
}

#[tokio::test]
async fn projection_outbox_preserves_each_revision_and_terminal_current() {
    let database = GraphDatabase::in_memory().await.unwrap();
    let compatibility_completion = database
        .create_interaction(Some(project(1)), thread(1), "Compatibility root")
        .await
        .unwrap();
    database
        .set_temporal_features(TemporalFeatureConfig {
            schema_read: true,
            root_current_write: true,
            projection_ui: true,
            ..TemporalFeatureConfig::default()
        })
        .await
        .unwrap();
    let interaction = database
        .create_interaction(Some(project(1)), thread(1), "Explain the queue")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let answer = node(&writer, "progress").await;
    let layer = single_node_layer(&writer, "progress-current", &answer).await;
    root_expand(&writer, &interaction, &layer).await;
    let advanced = writer
        .transition_current(
            0,
            "advance-progress",
            CurrentTransition::Advance { layer_id: layer.id },
        )
        .await
        .unwrap();
    let unsafe_reason = writer
        .transition_current(
            1,
            "unsafe-stop-reason",
            CurrentTransition::Stop {
                reason: "raw private tool trace".into(),
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(
        unsafe_reason,
        GraphError::Validation {
            code: "invalid_terminal_reason",
            ..
        }
    ));
    let stopped = writer
        .transition_current(
            1,
            "stop-progress",
            CurrentTransition::Stop {
                reason: "cancelled_by_user".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(stopped.lifecycle, CompletionLifecycle::Stopped);
    assert_eq!(stopped.current_layer_id, Some(layer.id));

    let events = database.current_projection_events(0, 100).await.unwrap();
    assert!(
        events
            .iter()
            .all(|event| event.completion_id != compatibility_completion.id)
    );
    let events = events
        .into_iter()
        .filter(|event| event.completion_id == interaction.id)
        .collect::<Vec<_>>();
    assert_eq!(events.len(), 3);
    assert_eq!(events[0].revision, 0);
    assert_eq!(events[0].lifecycle, CompletionLifecycle::Active);
    assert_eq!(events[0].current_layer_id, None);
    assert_eq!(events[1].sequence, advanced.projection_sequence);
    assert_eq!(events[1].revision, 1);
    assert_eq!(events[1].lifecycle, CompletionLifecycle::Active);
    assert_eq!(events[1].current_layer_id, Some(layer.id));
    assert_eq!(events[2].sequence, stopped.projection_sequence);
    assert_eq!(events[2].revision, 2);
    assert_eq!(events[2].lifecycle, CompletionLifecycle::Stopped);
    assert_eq!(events[2].current_layer_id, Some(layer.id));
    assert_eq!(events[2].safe_reason.as_deref(), Some("cancelled_by_user"));

    let first_page = database
        .current_projection_page(&[interaction.id], 0, 1)
        .await
        .unwrap();
    assert_eq!(first_page.states.len(), 1);
    assert_eq!(first_page.states[0].completion_id, interaction.id);
    assert_eq!(first_page.states[0].head_revision, stopped.revision);
    assert_eq!(first_page.states[0].lifecycle, CompletionLifecycle::Stopped);
    assert_eq!(
        first_page.states[0].safe_reason.as_deref(),
        Some("cancelled_by_user")
    );
    assert_eq!(first_page.events.len(), 1);
    assert!(first_page.has_more);
    let remaining = database
        .current_projection_page(&[interaction.id], first_page.cursor, 10)
        .await
        .unwrap();
    assert_eq!(remaining.events.len(), 2);
    assert!(!remaining.has_more);

    let replay = writer
        .transition_current(
            1,
            "stop-progress",
            CurrentTransition::Stop {
                reason: "cancelled_by_user".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(replay, stopped);
    assert_eq!(
        database
            .current_projection_events(0, 100)
            .await
            .unwrap()
            .len(),
        3
    );
}

#[tokio::test]
async fn temporal_rollout_flags_default_off_and_enforce_stage_dependencies() {
    let temporary = tempfile::tempdir().unwrap();
    let file = tempfile::NamedTempFile::new_in(temporary.path()).unwrap();
    let database = GraphDatabase::open(file.path()).await.unwrap();
    assert_eq!(
        database.temporal_features().await.unwrap(),
        TemporalFeatureConfig::default()
    );
    let invalid = database
        .set_temporal_features(TemporalFeatureConfig {
            projection_ui: true,
            ..TemporalFeatureConfig::default()
        })
        .await
        .unwrap_err();
    assert!(matches!(
        invalid,
        GraphError::Validation {
            code: "invalid_temporal_feature_dependency",
            ..
        }
    ));
    let root = TemporalFeatureConfig {
        schema_read: true,
        root_current_write: true,
        ..TemporalFeatureConfig::default()
    };
    database.set_temporal_features(root).await.unwrap();
    assert_eq!(database.temporal_features().await.unwrap(), root);
    let interaction = database
        .create_interaction(Some(project(9)), thread(9), "Rollout-bound root")
        .await
        .unwrap();
    assert_eq!(
        database
            .current_completion(interaction.id)
            .await
            .unwrap()
            .temporal_features,
        root
    );
    drop(database);

    let reopened = GraphDatabase::open(file.path()).await.unwrap();
    assert_eq!(reopened.temporal_features().await.unwrap(), root);
    assert_eq!(
        reopened
            .current_completion(interaction.id)
            .await
            .unwrap()
            .temporal_features,
        root
    );
}

#[tokio::test]
async fn published_active_invoke_prepares_one_recursive_completion_with_canonical_input() {
    let file = tempfile::NamedTempFile::new().unwrap();
    let database = GraphDatabase::open(file.path()).await.unwrap();
    database
        .set_temporal_features(TemporalFeatureConfig {
            schema_read: true,
            root_current_write: true,
            projection_ui: true,
            invoke_resolution: true,
            provider_recursion: true,
            ..TemporalFeatureConfig::default()
        })
        .await
        .unwrap();
    let parent = database
        .create_interaction(Some(project(1)), thread(1), "Parent task")
        .await
        .unwrap();
    let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}", file.path().display()))
        .await
        .unwrap();
    emulate_legacy_contract(&pool, parent.id).await;
    pool.close().await;
    let writer = database.writer_for_subgraph(parent.id).await.unwrap();
    let source = node(&writer, "recursive-source").await;
    let current = single_node_layer(&writer, "recursive-current", &source).await;
    root_expand(&writer, &parent, &current).await;
    let invoke = writer
        .add_action(&ActionDraft {
            client_key: "recursive-child".into(),
            source_node_id: source.id,
            source_layer_id: Some(current.id),
            kind: ActionKind::Invoke,
            relation: None,
            label: "Investigate".into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: Some("Investigate the published branch".into()),
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .unwrap();
    writer
        .transition_current(
            0,
            "publish-recursive-child",
            CurrentTransition::Advance {
                layer_id: current.id,
            },
        )
        .await
        .unwrap();

    let parent_epoch = database
        .activate_completion_authority(parent.id)
        .await
        .unwrap();
    let recursive_writer = database
        .writer_for_completion_authority(parent.id, parent_epoch)
        .await
        .unwrap();
    let child = recursive_writer
        .prepare_recursive_completion(invoke.id)
        .await
        .unwrap();
    let later_source = node(&writer, "later-parent-current").await;
    let later_current = single_node_layer(&writer, "later-current", &later_source).await;
    root_expand(&writer, &parent, &later_current).await;
    writer
        .add_action(&ActionDraft {
            client_key: "retain-prior-current".into(),
            source_node_id: later_source.id,
            source_layer_id: Some(later_current.id),
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Reference),
            label: "Prior current".into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: Some(current.id),
            interaction_text: None,
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .unwrap();
    writer
        .transition_current(
            1,
            "advance-after-child-launch",
            CurrentTransition::Advance {
                layer_id: later_current.id,
            },
        )
        .await
        .unwrap();
    let retry = recursive_writer
        .prepare_recursive_completion(invoke.id)
        .await
        .unwrap();

    assert_eq!(retry.id, child.id);
    assert_eq!(child.detail, "Investigate the published branch");
    assert_eq!(child.leased_action_id, Some(invoke.id));
    let child_current = database.current_completion(child.id).await.unwrap();
    assert_eq!(child_current.lifecycle, CompletionLifecycle::Active);
    assert_eq!(child_current.head_revision, 0);
    assert_ne!(child.id, parent.id);
}

#[tokio::test]
async fn active_invoke_cannot_prepare_a_child_when_parent_recursion_gate_is_off() {
    let file = tempfile::NamedTempFile::new().unwrap();
    let database = GraphDatabase::open(file.path()).await.unwrap();
    database
        .set_temporal_features(TemporalFeatureConfig {
            schema_read: true,
            root_current_write: true,
            projection_ui: true,
            invoke_resolution: true,
            provider_recursion: false,
            ..TemporalFeatureConfig::default()
        })
        .await
        .unwrap();
    let parent = database
        .create_interaction(Some(project(1)), thread(1), "Parent task")
        .await
        .unwrap();
    let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}", file.path().display()))
        .await
        .unwrap();
    emulate_legacy_contract(&pool, parent.id).await;
    pool.close().await;
    let writer = database.writer_for_subgraph(parent.id).await.unwrap();
    let source = node(&writer, "gated-source").await;
    let current = single_node_layer(&writer, "gated-current", &source).await;
    root_expand(&writer, &parent, &current).await;
    let invoke = writer
        .add_action(&ActionDraft {
            client_key: "gated-child".into(),
            source_node_id: source.id,
            source_layer_id: Some(current.id),
            kind: ActionKind::Invoke,
            relation: None,
            label: "Investigate".into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: Some("Investigate the gated branch".into()),
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .unwrap();
    writer
        .transition_current(
            0,
            "publish-gated-child",
            CurrentTransition::Advance {
                layer_id: current.id,
            },
        )
        .await
        .unwrap();

    let parent_epoch = database
        .activate_completion_authority(parent.id)
        .await
        .unwrap();
    let error = database
        .writer_for_completion_authority(parent.id, parent_epoch)
        .await
        .unwrap()
        .prepare_recursive_completion(invoke.id)
        .await
        .unwrap_err();

    assert!(matches!(
        error,
        GraphError::Validation {
            code: "invalid_invocation_source",
            ..
        }
    ));
}

#[tokio::test]
async fn remint_cuts_over_broker_epoch_and_terminal_state_denies_model_reads() {
    let database = GraphDatabase::in_memory().await.unwrap();
    database
        .set_temporal_features(TemporalFeatureConfig {
            schema_read: true,
            root_current_write: true,
            ..TemporalFeatureConfig::default()
        })
        .await
        .unwrap();
    let interaction = database
        .create_interaction(Some(project(1)), thread(1), "Explain the queue")
        .await
        .unwrap();
    let first_epoch = database
        .activate_completion_authority(interaction.id)
        .await
        .unwrap();
    let first = database
        .writer_for_completion_authority(interaction.id, first_epoch)
        .await
        .unwrap();
    let second_epoch = database
        .activate_completion_authority(interaction.id)
        .await
        .unwrap();
    let second = database
        .writer_for_completion_authority(interaction.id, second_epoch)
        .await
        .unwrap();

    let expired = first
        .submit_node(&NodeDraft {
            client_key: "expired".into(),
            kind: "concept".into(),
            icon: "box".into(),
            title: "Expired".into(),
            detail: "Old broker generations cannot commit.".into(),
        })
        .await
        .unwrap_err();
    assert!(matches!(
        expired,
        GraphError::Validation {
            code: "authority_generation_expired",
            ..
        }
    ));

    let answer = node(&second, "authorized").await;
    let layer = single_node_layer(&second, "authorized-current", &answer).await;
    root_expand(&second, &interaction, &layer).await;
    let model_failure = second
        .transition_current(
            0,
            "model-owned-failure",
            CurrentTransition::Fail {
                reason: "provider_crashed".into(),
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(model_failure, GraphError::Forbidden(_)));
    second
        .transition_current(
            0,
            "advance-authorized",
            CurrentTransition::Advance { layer_id: layer.id },
        )
        .await
        .unwrap();
    let abandoned = node(&second, "abandoned").await;
    let abandoned_layer = single_node_layer(&second, "abandoned-layer", &abandoned).await;
    second.discard_layer(abandoned_layer.id).await.unwrap();

    let third_epoch = database
        .activate_completion_authority(interaction.id)
        .await
        .unwrap();
    let third = database
        .writer_for_completion_authority(interaction.id, third_epoch)
        .await
        .unwrap();
    let accepted_probe = second
        .submit_node(&NodeDraft {
            client_key: "authorized".into(),
            kind: "concept".into(),
            icon: "box".into(),
            title: "authorized".into(),
            detail: "detail authorized".into(),
        })
        .await
        .unwrap_err();
    assert!(matches!(
        accepted_probe,
        GraphError::Validation {
            code: "authority_generation_expired",
            ..
        }
    ));
    let stopped_probe = second.discard_layer(abandoned_layer.id).await.unwrap_err();
    assert!(matches!(
        stopped_probe,
        GraphError::Validation {
            code: "authority_generation_expired",
            ..
        }
    ));

    third
        .transition_current(
            1,
            "stop-authorized",
            CurrentTransition::Stop {
                reason: "cancelled_by_user".into(),
            },
        )
        .await
        .unwrap();

    let terminal_read = third.get_node(answer.id).await.unwrap_err();
    assert!(matches!(
        terminal_read,
        GraphError::Validation {
            code: "authority_generation_expired",
            ..
        }
    ));
    assert!(third.completion_output().await.unwrap().is_none());
    assert!(database.current_completion(interaction.id).await.is_ok());
}

#[tokio::test]
async fn accepts_connected_layer_and_returns_exact_view() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let a = node(&writer, "a").await;
    let b = node(&writer, "b").await;
    let edge = writer
        .create_edge(&EdgeDraft {
            client_key: "ab".into(),
            endpoints: [a.id, b.id],
        })
        .await
        .unwrap();
    let layer = writer
        .submit_layer(&LayerDraft {
            default_node_id: None,
            client_key: "root".into(),
            nodes: vec![a.id, b.id],
            edges: vec![edge.id],
            layout: authored_layout([a.id, b.id]),
            size_justification: None,
        })
        .await
        .unwrap();
    writer
        .add_action(&ActionDraft {
            client_key: "response".into(),
            source_node_id: interaction.id,
            source_layer_id: None,
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Expand),
            label: "Response".into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: Some(layer.id),
            interaction_text: None,
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .unwrap();
    let output = writer.complete(interaction.id).await.unwrap();
    assert_eq!(output.node_id, interaction.id);
    assert_eq!(output.root_layer.nodes.len(), 2);
    assert_eq!(output.root_layer.edges[0].endpoints, [a.id, b.id]);
    assert_eq!(output.root_layer.layer.layout, layer.layout);
    assert_eq!(output.root_layer.layer.state, RecordState::Accepted);
    let error = writer
        .submit_node(&NodeDraft {
            client_key: "late-write".into(),
            kind: "concept".into(),
            icon: "lock".into(),
            title: "Late write".into(),
            detail: "This must not be added after acceptance.".into(),
        })
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("already has an accepted completion")
    );
}

#[tokio::test]
async fn rejects_disconnected_layer_with_repair_message() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let a = node(&writer, "a").await;
    let b = node(&writer, "b").await;
    let error = writer
        .submit_layer(&LayerDraft {
            default_node_id: None,
            client_key: "root".into(),
            nodes: vec![a.id, b.id],
            edges: vec![],
            layout: authored_layout([a.id, b.id]),
            size_justification: None,
        })
        .await
        .unwrap_err();
    assert!(error.to_string().contains("Add edges"));
}

#[tokio::test]
async fn rejects_missing_and_malformed_layouts_with_repairable_field_paths() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let a = node(&writer, "a").await;
    let b = node(&writer, "b").await;
    let edge = writer
        .create_edge(&EdgeDraft {
            client_key: "ab".into(),
            endpoints: [a.id, b.id],
        })
        .await
        .unwrap();

    let missing = writer
        .submit_layer(&LayerDraft {
            default_node_id: None,
            client_key: "missing-layout".into(),
            nodes: vec![a.id, b.id],
            edges: vec![edge.id],
            layout: None,
            size_justification: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(
        missing,
        GraphError::ValidationIssues { ref issues, .. }
            if issues.iter().any(|issue| issue.code == "missing_layer_layout" && issue.path == "layout")
    ));

    let unknown = NodeId::new(999_999).unwrap();
    let malformed = writer
        .submit_layer(&LayerDraft {
            default_node_id: None,
            client_key: "malformed-layout".into(),
            nodes: vec![a.id, b.id],
            edges: vec![edge.id],
            layout: Some(LayerLayout {
                version: 7,
                placements: vec![
                    NodePlacement {
                        node_id: a.id,
                        x: f64::NAN,
                        y: -0.1,
                    },
                    NodePlacement {
                        node_id: a.id,
                        x: 0.4,
                        y: 0.6,
                    },
                    NodePlacement {
                        node_id: unknown,
                        x: 0.5,
                        y: 1.1,
                    },
                ],
                edge_shape: Some("sideways".into()),
                edge_routes: Vec::new(),
            }),
            size_justification: None,
        })
        .await
        .unwrap_err();
    let GraphError::ValidationIssues { issues, .. } = malformed else {
        panic!("expected repairable layout issues");
    };
    for (code, path) in [
        ("unsupported_layout_version", "layout.version"),
        ("non_finite_layout_coordinate", "layout.placements[0].x"),
        ("layout_coordinate_out_of_range", "layout.placements[0].y"),
        ("duplicate_layout_placement", "layout.placements[1].nodeId"),
        ("layout_node_outside_layer", "layout.placements[2].nodeId"),
        ("layout_coordinate_out_of_range", "layout.placements[2].y"),
        ("missing_layout_placement", "layout.placements"),
        ("unsupported_edge_shape", "layout.edgeShape"),
    ] {
        assert!(
            issues
                .iter()
                .any(|issue| issue.code == code && issue.path == path),
            "missing {code} at {path}: {issues:?}"
        );
    }

    // The agent must choose an edge shape; "default" is an explicit choice.
    let mut shapeless = authored_layout([a.id, b.id]).unwrap();
    shapeless.edge_shape = None;
    let missing_shape = writer
        .submit_layer(&LayerDraft {
            default_node_id: None,
            client_key: "shapeless-layout".into(),
            nodes: vec![a.id, b.id],
            edges: vec![edge.id],
            layout: Some(shapeless),
            size_justification: None,
        })
        .await
        .unwrap_err();
    let GraphError::ValidationIssues { issues, .. } = missing_shape else {
        panic!("expected a repairable missing edge shape");
    };
    assert!(
        issues.iter().any(|issue| issue.code == "missing_edge_shape"
            && issue.path == "layout.edgeShape"
            && issue.message.contains("elbow-horizontal")),
        "{issues:?}"
    );
}

#[tokio::test]
async fn edge_routes_are_validated_on_submit_and_read_back_exactly() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let [a, b, c] = [
        node(&writer, "a").await,
        node(&writer, "b").await,
        node(&writer, "c").await,
    ];
    let edge = |client_key: &str, left: NodeId, right: NodeId| EdgeDraft {
        client_key: client_key.into(),
        endpoints: [left, right],
    };
    let ab = writer.create_edge(&edge("ab", a.id, b.id)).await.unwrap();
    let bc = writer.create_edge(&edge("bc", b.id, c.id)).await.unwrap();
    let ca = writer.create_edge(&edge("ca", c.id, a.id)).await.unwrap();
    let end = |node_id: NodeId, side: Option<&str>| EdgeEnd {
        node_id,
        side: side.map(Into::into),
    };
    let point = |x: f64, y: f64| LayoutPoint { x, y };
    let submit = |routes: Vec<EdgeRoute>| {
        let draft = LayerDraft {
            default_node_id: None,
            client_key: "routed".into(),
            nodes: vec![a.id, b.id, c.id],
            edges: vec![ab.id, bc.id],
            layout: Some(
                authored_layout([a.id, b.id, c.id])
                    .unwrap()
                    .with_edge_routes(routes),
            ),
            size_justification: None,
        };
        let writer = &writer;
        async move { writer.submit_layer(&draft).await }
    };

    let GraphError::ValidationIssues { issues, .. } = submit(vec![
        EdgeRoute {
            edge_id: ca.id,
            shape: None,
            ends: vec![],
            waypoints: vec![],
        },
        EdgeRoute {
            edge_id: ab.id,
            shape: Some("flow".into()),
            ends: vec![],
            waypoints: vec![point(0.5, 0.5)],
        },
        EdgeRoute {
            edge_id: ab.id,
            shape: None,
            ends: vec![end(a.id, Some("north")), end(b.id, None)],
            waypoints: vec![point(0.1, 0.1); 5]
                .into_iter()
                .chain([point(1.5, 0.2)])
                .collect(),
        },
    ])
    .await
    .unwrap_err() else {
        panic!("expected repairable route issues");
    };
    for (code, path) in [
        ("edge_route_outside_layer", "layout.edgeRoutes[0].edgeId"),
        ("unsupported_edge_shape", "layout.edgeRoutes[1].shape"),
        ("edge_route_ends_required", "layout.edgeRoutes[1].ends"),
        ("duplicate_edge_route", "layout.edgeRoutes[2].edgeId"),
        ("unsupported_node_side", "layout.edgeRoutes[2].ends[0].side"),
        ("too_many_waypoints", "layout.edgeRoutes[2].waypoints"),
        (
            "layout_coordinate_out_of_range",
            "layout.edgeRoutes[2].waypoints[5].x",
        ),
    ] {
        assert!(
            issues
                .iter()
                .any(|issue| issue.code == code && issue.path == path),
            "missing {code} at {path}: {issues:?}"
        );
    }

    // Ends must be the edge's own two nodes.
    let mismatch = submit(vec![EdgeRoute {
        edge_id: ab.id,
        shape: None,
        ends: vec![end(a.id, None), end(c.id, None)],
        waypoints: vec![],
    }])
    .await
    .unwrap_err();
    assert!(matches!(
        mismatch,
        GraphError::ValidationIssues { ref issues, .. }
            if issues.iter().any(|issue| issue.code == "edge_route_ends_mismatch" && issue.path == "layout.edgeRoutes[0].ends")
    ));

    let routes = vec![EdgeRoute {
        edge_id: bc.id,
        shape: Some("elbow-vertical".into()),
        ends: vec![end(c.id, Some("top")), end(b.id, Some("bottom"))],
        waypoints: vec![point(0.9, 0.1), point(0.2, 0.1)],
    }];
    let layer = submit(routes.clone()).await.unwrap();
    let stored = writer
        .get_layer(layer.id)
        .await
        .unwrap()
        .layer
        .layout
        .unwrap();
    assert_eq!(stored.edge_routes, routes);
    assert_eq!(stored, layer.layout.unwrap());
}

#[tokio::test]
async fn invalid_layout_retry_preserves_the_last_valid_draft() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let answer = node(&writer, "answer").await;
    let valid = writer
        .submit_layer(&LayerDraft {
            default_node_id: None,
            client_key: "root".into(),
            nodes: vec![answer.id],
            edges: vec![],
            layout: Some(LayerLayout::v1(
                vec![NodePlacement {
                    node_id: answer.id,
                    x: 0.25,
                    y: 0.75,
                }],
                "elbow-vertical",
            )),
            size_justification: None,
        })
        .await
        .unwrap();
    let invalid = writer
        .submit_layer(&LayerDraft {
            default_node_id: None,
            client_key: "root".into(),
            nodes: vec![answer.id],
            edges: vec![],
            layout: Some(LayerLayout::v1(
                vec![NodePlacement {
                    node_id: answer.id,
                    x: 2.0,
                    y: 0.5,
                }],
                "default",
            )),
            size_justification: None,
        })
        .await;
    assert!(invalid.is_err());
    let unsupported_shape = writer
        .submit_layer(&LayerDraft {
            default_node_id: None,
            client_key: "root".into(),
            nodes: vec![answer.id],
            edges: vec![],
            layout: Some(LayerLayout::v1(
                vec![NodePlacement {
                    node_id: answer.id,
                    x: 0.5,
                    y: 0.5,
                }],
                "flow",
            )),
            size_justification: None,
        })
        .await;
    assert!(unsupported_shape.is_err());

    let preserved = writer.get_layer(valid.id).await.unwrap();
    assert_eq!(preserved.layer.layout, valid.layout);
    assert_eq!(
        preserved.layer.layout.unwrap().edge_shape.as_deref(),
        Some("elbow-vertical")
    );
}

#[tokio::test]
async fn rejects_unsupported_node_icons_with_repair_guidance() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let error = writer
        .submit_node(&NodeDraft {
            client_key: "unsupported-icon".into(),
            kind: "concept".into(),
            icon: "🧭".into(),
            title: "Direction".into(),
            detail: "A useful explanation.".into(),
        })
        .await
        .unwrap_err();

    assert!(matches!(
        error,
        GraphError::Validation {
            code: "unsupported_icon",
            ref path,
            ..
        } if path == "icon"
    ));
    assert!(error.to_string().contains("compass"));
}

#[tokio::test]
async fn normalizes_supported_icon_aliases_before_persistence() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let submitted = writer
        .submit_node(&NodeDraft {
            client_key: "alias-icon".into(),
            kind: "concept".into(),
            icon: " Circle Alert ".into(),
            title: "Attention".into(),
            detail: "A useful warning.".into(),
        })
        .await
        .unwrap();

    assert_eq!(submitted.icon, "alert-circle");
    assert_eq!(
        writer.get_node(submitted.id).await.unwrap().icon,
        "alert-circle"
    );
}

#[tokio::test]
async fn resubmitting_draft_node_updates_same_object_but_accepted_is_immutable() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let first = node(&writer, "a").await;
    let changed = writer
        .submit_node(&NodeDraft {
            client_key: "a".into(),
            kind: "concept".into(),
            icon: "compass".into(),
            title: "changed".into(),
            detail: "changed detail".into(),
        })
        .await
        .unwrap();
    assert_eq!(first.id, changed.id);
    accept_single_node(&writer, interaction, changed).await;
    assert!(matches!(
        writer
            .submit_node(&NodeDraft {
                client_key: "a".into(),
                kind: "concept".into(),
                icon: "search".into(),
                title: "x".into(),
                detail: "x".into(),
            })
            .await,
        Err(GraphError::Validation {
            code: "immutable_node",
            ..
        })
    ));
}

#[tokio::test]
async fn accepts_recursive_navigate_subgraph() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let parent = node(&writer, "parent").await;
    let child = node(&writer, "child").await;
    let nested = writer
        .submit_layer(&LayerDraft {
            default_node_id: None,
            client_key: "nested".into(),
            nodes: vec![child.id],
            edges: vec![],
            layout: authored_layout([child.id]),
            size_justification: None,
        })
        .await
        .unwrap();
    let root = writer
        .submit_layer(&LayerDraft {
            default_node_id: None,
            client_key: "root".into(),
            nodes: vec![parent.id],
            edges: vec![],
            layout: authored_layout([parent.id]),
            size_justification: None,
        })
        .await
        .unwrap();
    writer
        .add_action(&ActionDraft {
            client_key: "deeper".into(),
            source_node_id: parent.id,
            source_layer_id: Some(root.id),
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Expand),
            label: "Details".into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: Some(nested.id),
            interaction_text: None,
            reusable: None,
            input_action_ids: Vec::new(),
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
            relation: Some(NavigateRelation::Expand),
            label: "Response".into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: Some(root.id),
            interaction_text: None,
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .unwrap();
    writer.complete(interaction.id).await.unwrap();
    assert_eq!(
        writer.get_layer(nested.id).await.unwrap().layer.state,
        RecordState::Accepted
    );
}

#[tokio::test]
async fn large_layers_require_a_private_bounded_justification() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let mut nodes = Vec::new();
    for index in 0..9 {
        nodes.push(node(&writer, &format!("node-{index}")).await);
    }
    let mut edges = Vec::new();
    for index in 1..nodes.len() {
        edges.push(
            writer
                .create_edge(&EdgeDraft {
                    client_key: format!("edge-{index}"),
                    endpoints: [nodes[index - 1].id, nodes[index].id],
                })
                .await
                .unwrap(),
        );
    }

    let missing = writer
        .submit_layer(&LayerDraft {
            default_node_id: None,
            client_key: "large".into(),
            nodes: nodes[..6].iter().map(|node| node.id).collect(),
            edges: edges[..5].iter().map(|edge| edge.id).collect(),
            layout: authored_layout(nodes[..6].iter().map(|node| node.id)),
            size_justification: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(
        missing,
        GraphError::ValidationIssues { ref issues, .. }
            if issues.iter().any(|issue| issue.code == "large_layer_justification_required")
    ));

    let unicode_too_short = writer
        .submit_layer(&LayerDraft {
            default_node_id: None,
            client_key: "unicode-too-short".into(),
            nodes: nodes[..6].iter().map(|node| node.id).collect(),
            edges: edges[..5].iter().map(|edge| edge.id).collect(),
            layout: authored_layout(nodes[..6].iter().map(|node| node.id)),
            size_justification: Some("🚀".repeat(5)),
        })
        .await
        .unwrap_err();
    assert!(matches!(
        unicode_too_short,
        GraphError::ValidationIssues { ref issues, .. }
            if issues.iter().any(|issue| issue.code == "large_layer_justification_required")
    ));

    let unicode_within_limit = writer
        .submit_layer(&LayerDraft {
            default_node_id: None,
            client_key: "unicode-within-limit".into(),
            nodes: nodes[..6].iter().map(|node| node.id).collect(),
            edges: edges[..5].iter().map(|edge| edge.id).collect(),
            layout: authored_layout(nodes[..6].iter().map(|node| node.id)),
            size_justification: Some("🚀".repeat(126)),
        })
        .await
        .unwrap();
    assert_eq!(unicode_within_limit.nodes.len(), 6);

    let unicode_too_long = writer
        .submit_layer(&LayerDraft {
            default_node_id: None,
            client_key: "unicode-too-long".into(),
            nodes: nodes[..6].iter().map(|node| node.id).collect(),
            edges: edges[..5].iter().map(|edge| edge.id).collect(),
            layout: authored_layout(nodes[..6].iter().map(|node| node.id)),
            size_justification: Some("🚀".repeat(501)),
        })
        .await
        .unwrap_err();
    assert!(matches!(
        unicode_too_long,
        GraphError::ValidationIssues { ref issues, .. }
            if issues.iter().any(|issue| issue.code == "large_layer_justification_too_long")
    ));

    let accepted = writer
        .submit_layer(&LayerDraft {
            default_node_id: None,
            client_key: "large".into(),
            nodes: nodes[..6].iter().map(|node| node.id).collect(),
            edges: edges[..5].iter().map(|edge| edge.id).collect(),
            layout: authored_layout(nodes[..6].iter().map(|node| node.id)),
            size_justification: Some(
                "These six peer states must remain visible together for direct comparison.".into(),
            ),
        })
        .await
        .unwrap();
    assert_eq!(accepted.nodes.len(), 6);

    let too_large = writer
        .submit_layer(&LayerDraft {
            default_node_id: None,
            client_key: "too-large".into(),
            nodes: nodes.iter().map(|node| node.id).collect(),
            edges: edges.iter().map(|edge| edge.id).collect(),
            layout: authored_layout(nodes.iter().map(|node| node.id)),
            size_justification: Some("All nine nodes are peers.".into()),
        })
        .await
        .unwrap_err();
    assert!(matches!(
        too_large,
        GraphError::ValidationIssues { ref issues, .. }
            if issues.iter().any(|issue| issue.code == "layer_node_count")
    ));
}

#[tokio::test]
async fn reference_can_target_a_visible_prior_accepted_layer_without_reaccepting_it() {
    let project_id = project(1);
    let (database, prior_interaction) = setup(Some(project_id), thread(1)).await;
    let prior_writer = database
        .writer_for_subgraph(prior_interaction.id)
        .await
        .unwrap();
    let evidence = node(&prior_writer, "evidence").await;
    let evidence_layer = single_node_layer(&prior_writer, "evidence-layer", &evidence).await;
    root_expand(&prior_writer, &prior_interaction, &evidence_layer).await;
    prior_writer.complete(prior_interaction.id).await.unwrap();

    let interaction = database
        .create_interaction(Some(project_id), thread(2), "Use the prior evidence")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let answer = node(&writer, "answer").await;
    let root = single_node_layer(&writer, "root", &answer).await;
    navigate(
        &writer,
        "Evidence",
        &answer,
        &root,
        &evidence_layer,
        NavigateRelation::Reference,
    )
    .await;
    root_expand(&writer, &interaction, &root).await;

    let output = writer.complete(interaction.id).await.unwrap();
    assert_eq!(
        output.root_layer.actions[0].relation,
        Some(NavigateRelation::Reference)
    );
    assert_eq!(
        writer
            .get_layer(evidence_layer.id)
            .await
            .unwrap()
            .layer
            .state,
        RecordState::Accepted
    );
}

#[tokio::test]
async fn reference_layers_can_reference_each_other_in_cycles() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let root_node = node(&writer, "root-node").await;
    let evidence_a = node(&writer, "evidence-a").await;
    let evidence_b = node(&writer, "evidence-b").await;
    let root = single_node_layer(&writer, "root", &root_node).await;
    let layer_a = single_node_layer(&writer, "evidence-a-layer", &evidence_a).await;
    let layer_b = single_node_layer(&writer, "evidence-b-layer", &evidence_b).await;
    root_expand(&writer, &interaction, &root).await;
    navigate(
        &writer,
        "First evidence",
        &root_node,
        &root,
        &layer_a,
        NavigateRelation::Reference,
    )
    .await;
    navigate(
        &writer,
        "Related evidence",
        &evidence_a,
        &layer_a,
        &layer_b,
        NavigateRelation::Reference,
    )
    .await;
    navigate(
        &writer,
        "Back to first evidence",
        &evidence_b,
        &layer_b,
        &layer_a,
        NavigateRelation::Reference,
    )
    .await;

    writer.complete(interaction.id).await.unwrap();
    let closure = database
        .accepted_graph_closure(interaction.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(closure.root_layer_id, root.id);
    assert_eq!(closure.layers.len(), 3);
    assert_eq!(closure.layers[0].layer.id, root.id);
    assert!(
        closure
            .layers
            .iter()
            .any(|layer| layer.layer.id == layer_a.id)
    );
    assert!(
        closure
            .layers
            .iter()
            .any(|layer| layer.layer.id == layer_b.id)
    );
    assert_eq!(
        writer.get_layer(layer_b.id).await.unwrap().layer.state,
        RecordState::Accepted
    );
}

#[tokio::test]
async fn expand_paths_reject_cycles_with_repair_guidance() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let first = node(&writer, "first").await;
    let second = node(&writer, "second").await;
    let first_layer = single_node_layer(&writer, "first-layer", &first).await;
    let second_layer = single_node_layer(&writer, "second-layer", &second).await;
    root_expand(&writer, &interaction, &first_layer).await;
    navigate(
        &writer,
        "Deeper",
        &first,
        &first_layer,
        &second_layer,
        NavigateRelation::Expand,
    )
    .await;
    navigate(
        &writer,
        "Loop",
        &second,
        &second_layer,
        &first_layer,
        NavigateRelation::Expand,
    )
    .await;

    let error = writer.complete(interaction.id).await.unwrap_err();
    assert!(matches!(
        error,
        GraphError::Validation {
            code: "expand_cycle",
            ..
        }
    ));
    assert!(error.to_string().contains("Change one link to reference"));
}

#[tokio::test]
async fn reference_layers_cannot_author_expand_or_invoke_actions() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let root_node = node(&writer, "root-node").await;
    let evidence = node(&writer, "evidence").await;
    let child = node(&writer, "child").await;
    let root = single_node_layer(&writer, "root", &root_node).await;
    let evidence_layer = single_node_layer(&writer, "evidence-layer", &evidence).await;
    let child_layer = single_node_layer(&writer, "child-layer", &child).await;
    root_expand(&writer, &interaction, &root).await;
    navigate(
        &writer,
        "Evidence",
        &root_node,
        &root,
        &evidence_layer,
        NavigateRelation::Reference,
    )
    .await;

    let error = writer
        .add_action(&ActionDraft {
            client_key: "invalid-expand".into(),
            source_node_id: evidence.id,
            source_layer_id: Some(evidence_layer.id),
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Expand),
            label: "Invalid expand".into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: Some(child_layer.id),
            interaction_text: None,
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        GraphError::Validation {
            code: "reference_layer_authoring_restricted",
            ..
        }
    ));
}

#[tokio::test]
async fn completion_rejects_mixed_relations_to_one_new_target() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let root_node = node(&writer, "root-node").await;
    let target_node = node(&writer, "target-node").await;
    let root = single_node_layer(&writer, "root", &root_node).await;
    let target = single_node_layer(&writer, "target", &target_node).await;
    root_expand(&writer, &interaction, &root).await;
    navigate(
        &writer,
        "Expand target",
        &root_node,
        &root,
        &target,
        NavigateRelation::Expand,
    )
    .await;
    navigate(
        &writer,
        "Reference target",
        &root_node,
        &root,
        &target,
        NavigateRelation::Reference,
    )
    .await;

    let mixed = writer.complete(interaction.id).await.unwrap_err();
    assert!(matches!(
        mixed,
        GraphError::Validation {
            code: "mixed_target_relations",
            ..
        }
    ));
}

#[tokio::test]
async fn completion_rejects_orphan_current_draft_layers() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let root_node = node(&writer, "root-node").await;
    let orphan_node = node(&writer, "orphan-node").await;
    let root = single_node_layer(&writer, "root", &root_node).await;
    single_node_layer(&writer, "orphan", &orphan_node).await;
    root_expand(&writer, &interaction, &root).await;

    let error = writer.complete(interaction.id).await.unwrap_err();
    assert!(matches!(
        error,
        GraphError::Validation {
            code: "orphan_draft_layers",
            ..
        }
    ));
}

#[tokio::test]
async fn discard_layer_is_non_recursive_idempotent_and_unblocks_completion() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let root_node = node(&writer, "root-node").await;
    let abandoned_node = node(&writer, "abandoned-node").await;
    let child_node = node(&writer, "child-node").await;
    let root = single_node_layer(&writer, "root", &root_node).await;
    let abandoned = single_node_layer(&writer, "abandoned", &abandoned_node).await;
    let child = single_node_layer(&writer, "child", &child_node).await;
    let abandoned_action = navigate(
        &writer,
        "abandoned-child",
        &abandoned_node,
        &abandoned,
        &child,
        NavigateRelation::Expand,
    )
    .await;
    root_expand(&writer, &interaction, &root).await;

    let stopped = writer.discard_layer(abandoned.id).await.unwrap();
    assert_eq!(stopped.state, RecordState::Stopped);
    assert_eq!(writer.discard_layer(abandoned.id).await.unwrap(), stopped);

    let preserved = writer.get_layer(abandoned.id).await.unwrap();
    assert_eq!(preserved.layer.state, RecordState::Stopped);
    assert_eq!(preserved.nodes[0].state, RecordState::Draft);
    assert_eq!(preserved.actions[0].id, abandoned_action.id);
    assert_eq!(preserved.actions[0].state, RecordState::Draft);
    assert_eq!(
        writer.get_layer(child.id).await.unwrap().layer.state,
        RecordState::Draft
    );

    let error = writer.complete(interaction.id).await.unwrap_err();
    assert!(matches!(
        error,
        GraphError::Validation {
            code: "orphan_draft_layers",
            ..
        }
    ));
    writer.discard_layer(child.id).await.unwrap();
    writer.complete(interaction.id).await.unwrap();
    assert_eq!(
        writer.get_node(abandoned_node.id).await.unwrap().state,
        RecordState::Draft
    );
}

#[tokio::test]
async fn discard_layer_rejects_reachable_accepted_and_foreign_layers() {
    let project_id = project(1);
    let (database, interaction) = setup(Some(project_id), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let root_node = node(&writer, "root-node").await;
    let root = single_node_layer(&writer, "root", &root_node).await;
    root_expand(&writer, &interaction, &root).await;

    let reachable = writer.discard_layer(root.id).await.unwrap_err();
    assert!(matches!(
        reachable,
        GraphError::Validation {
            code: "reachable_layer",
            ..
        }
    ));
    writer.complete(interaction.id).await.unwrap();
    let accepted = writer.discard_layer(root.id).await.unwrap_err();
    assert!(matches!(
        accepted,
        GraphError::Validation {
            code: "immutable_layer",
            ..
        }
    ));

    let other_interaction = database
        .create_interaction(Some(project_id), thread(2), "Other")
        .await
        .unwrap();
    let other_writer = database
        .writer_for_subgraph(other_interaction.id)
        .await
        .unwrap();
    assert!(matches!(
        other_writer.discard_layer(root.id).await.unwrap_err(),
        GraphError::Forbidden(_)
    ));
}

#[tokio::test]
async fn discarded_layer_identity_is_terminal() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let abandoned_node = node(&writer, "abandoned-node").await;
    let abandoned = single_node_layer(&writer, "abandoned", &abandoned_node).await;
    writer.discard_layer(abandoned.id).await.unwrap();

    let error = writer
        .submit_layer(&LayerDraft {
            default_node_id: None,
            client_key: "abandoned".into(),
            nodes: vec![abandoned_node.id],
            edges: vec![],
            layout: authored_layout([abandoned_node.id]),
            size_justification: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        GraphError::Validation {
            code: "discarded_layer",
            ..
        }
    ));
}

#[tokio::test]
async fn completion_rejects_navigation_to_a_discarded_layer() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let root_node = node(&writer, "root-node").await;
    let discarded_node = node(&writer, "discarded-node").await;
    let root = single_node_layer(&writer, "root", &root_node).await;
    let discarded = single_node_layer(&writer, "discarded", &discarded_node).await;
    navigate(
        &writer,
        "discarded-target",
        &root_node,
        &root,
        &discarded,
        NavigateRelation::Expand,
    )
    .await;
    writer.discard_layer(discarded.id).await.unwrap();
    root_expand(&writer, &interaction, &root).await;

    let error = writer.complete(interaction.id).await.unwrap_err();
    assert!(matches!(
        error,
        GraphError::Validation {
            code: "discarded_layer_target",
            ..
        }
    ));
}

#[tokio::test]
async fn project_threads_share_accepted_nodes() {
    let project_id = project(1);
    let (database, interaction) = setup(Some(project_id), thread(1)).await;
    let shared = {
        let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
        let shared = node(&writer, "shared").await;
        accept_single_node(&writer, interaction, shared.clone()).await;
        shared
    };
    let next = database
        .create_interaction(Some(project_id), thread(2), "continue")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(next.id).await.unwrap();
    assert_eq!(writer.get_node(shared.id).await.unwrap().title, "shared");
}

#[tokio::test]
async fn standalone_threads_do_not_share_accepted_nodes() {
    let (database, interaction) = setup(None, thread(1)).await;
    let private = {
        let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
        let private = node(&writer, "private").await;
        accept_single_node(&writer, interaction, private.clone()).await;
        private
    };
    let other = database
        .create_interaction(None, thread(2), "other standalone thread")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(other.id).await.unwrap();
    assert!(matches!(
        writer.get_node(private.id).await,
        Err(GraphError::Forbidden(_))
    ));
}

#[tokio::test]
async fn draft_records_are_private_to_the_active_subgraph() {
    let project_id = project(1);
    let (database, interaction) = setup(Some(project_id), thread(1)).await;
    let draft = {
        let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
        node(&writer, "private").await
    };
    let other = database
        .create_interaction(Some(project_id), thread(2), "other turn")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(other.id).await.unwrap();
    assert!(matches!(
        writer.get_node(draft.id).await,
        Err(GraphError::Forbidden(_))
    ));
}

#[tokio::test]
async fn creating_the_same_edge_object_twice_is_idempotent() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let a = node(&writer, "a").await;
    let b = node(&writer, "b").await;
    let draft = EdgeDraft {
        client_key: "ab".into(),
        endpoints: [a.id, b.id],
    };
    let first = writer.create_edge(&draft).await.unwrap();
    let second = writer.create_edge(&draft).await.unwrap();
    assert_eq!(first, second);
}

#[tokio::test]
async fn action_keys_are_scoped_to_their_source_nodes() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let first = node(&writer, "first-source").await;
    let second = node(&writer, "second-source").await;
    let first_layer = writer
        .submit_layer(&LayerDraft {
            default_node_id: None,
            client_key: "first-layer".into(),
            nodes: vec![first.id],
            edges: vec![],
            layout: authored_layout([first.id]),
            size_justification: None,
        })
        .await
        .unwrap();
    let second_layer = writer
        .submit_layer(&LayerDraft {
            default_node_id: None,
            client_key: "second-layer".into(),
            nodes: vec![second.id],
            edges: vec![],
            layout: authored_layout([second.id]),
            size_justification: None,
        })
        .await
        .unwrap();
    let first_action = writer
        .add_action(&ActionDraft {
            client_key: "follow-up".into(),
            source_node_id: first.id,
            source_layer_id: Some(first_layer.id),
            kind: ActionKind::Invoke,
            relation: None,
            label: "Ask".into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: Some("Ask about the first node".into()),
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .unwrap();
    let second_action = writer
        .add_action(&ActionDraft {
            client_key: "follow-up".into(),
            source_node_id: second.id,
            source_layer_id: Some(second_layer.id),
            kind: ActionKind::Invoke,
            relation: None,
            label: "Ask".into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: Some("Ask about the second node".into()),
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .unwrap();

    assert_ne!(first_action.id, second_action.id);
    assert_eq!(first_action.source_node_id, first.id);
    assert_eq!(second_action.source_node_id, second.id);
}

#[tokio::test]
async fn invoke_actions_reject_whitespace_only_interaction_text() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let source = node(&writer, "source").await;
    let error = writer
        .add_action(&ActionDraft {
            client_key: "empty-follow-up".into(),
            source_node_id: source.id,
            source_layer_id: None,
            kind: ActionKind::Invoke,
            relation: None,
            label: "Ask".into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: Some("  \n\t".into()),
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .unwrap_err();

    assert!(matches!(
        error,
        GraphError::ValidationIssues { ref issues, .. }
            if issues.iter().any(|issue| issue.code == "missing_interaction_text")
    ));
}

#[tokio::test]
async fn invoke_actions_cannot_author_resolution_targets() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let source = node(&writer, "source-with-target").await;
    let layer = single_node_layer(&writer, "source-with-target-layer", &source).await;
    let error = writer
        .add_action(&ActionDraft {
            client_key: "forged-resolution".into(),
            source_node_id: source.id,
            source_layer_id: Some(layer.id),
            kind: ActionKind::Invoke,
            relation: None,
            label: "Continue".into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: Some(layer.id),
            interaction_text: Some("Continue".into()),
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .unwrap_err();

    assert!(matches!(
        error,
        GraphError::ValidationIssues { ref issues, .. }
            if issues.iter().any(|issue| issue.code == "unexpected_target_layer")
    ));
}

#[tokio::test]
async fn action_presentation_grammar_round_trips_in_authored_order() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let source = node(&writer, "source").await;
    let source_layer = writer
        .submit_layer(&LayerDraft {
            default_node_id: None,
            client_key: "root".into(),
            nodes: vec![source.id],
            edges: vec![],
            layout: authored_layout([source.id]),
            size_justification: None,
        })
        .await
        .unwrap();
    let presentations = [
        ("chip", ActionVariant::Chip, None, Some("Circle Alert")),
        ("pill", ActionVariant::Pill, None, None),
        ("wide", ActionVariant::Wide, None, None),
        (
            "first-card",
            ActionVariant::Card,
            Some("Supporting detail for the first card"),
            None,
        ),
        (
            "second-card",
            ActionVariant::Card,
            Some("Supporting detail for the second card"),
            None,
        ),
    ];

    for (key, variant, description, icon) in presentations {
        writer
            .add_action(&ActionDraft {
                client_key: key.into(),
                source_node_id: source.id,
                source_layer_id: Some(source_layer.id),
                kind: ActionKind::Invoke,
                relation: None,
                label: format!("Action {key}"),
                variant,
                icon: icon.map(str::to_owned),
                description: description.map(str::to_owned),
                target_layer_id: None,
                interaction_text: Some(format!("Run {key}")),
                reusable: None,
                input_action_ids: Vec::new(),
                input: None,
            })
            .await
            .unwrap();
    }

    accept_single_node(&writer, interaction, source).await;
    let output = writer.completion_output().await.unwrap().unwrap();
    assert_eq!(
        output
            .root_layer
            .actions
            .iter()
            .map(|action| action.variant.clone())
            .collect::<Vec<_>>(),
        vec![
            ActionVariant::Chip,
            ActionVariant::Pill,
            ActionVariant::Wide,
            ActionVariant::Card,
            ActionVariant::Card,
        ]
    );
    assert_eq!(
        output.root_layer.actions[0].icon.as_deref(),
        Some("alert-circle")
    );
    assert_eq!(
        output.root_layer.actions[3].description.as_deref(),
        Some("Supporting detail for the first card")
    );
    assert_eq!(
        output.root_layer.actions[4].description.as_deref(),
        Some("Supporting detail for the second card")
    );
}

#[tokio::test]
async fn input_actions_round_trip_all_controls_and_reject_malformed_options() {
    let (database, interaction) = setup(Some(project(88)), thread(88)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let source = node(&writer, "input-source").await;
    let layer = single_node_layer(&writer, "input-layer", &source).await;

    let cases = [
        InputAction {
            control: InputControl::Text,
            prompt: "Describe the evidence".into(),
            options: vec![],
            minimum_selections: None,
            unsupported_fields: Default::default(),
        },
        InputAction {
            control: InputControl::SingleSelect,
            prompt: "Choose a direction".into(),
            options: vec![
                InputOption {
                    key: "left".into(),
                    label: "Left".into(),
                    unsupported_fields: Default::default(),
                },
                InputOption {
                    key: "right".into(),
                    label: "Right".into(),
                    unsupported_fields: Default::default(),
                },
            ],
            minimum_selections: None,
            unsupported_fields: Default::default(),
        },
        InputAction {
            control: InputControl::MultiSelect,
            prompt: "Choose signals".into(),
            options: vec![
                InputOption {
                    key: "logs".into(),
                    label: "Logs".into(),
                    unsupported_fields: Default::default(),
                },
                InputOption {
                    key: "traces".into(),
                    label: "Traces".into(),
                    unsupported_fields: Default::default(),
                },
            ],
            minimum_selections: Some(2),
            unsupported_fields: Default::default(),
        },
    ];
    for (index, input) in cases.into_iter().enumerate() {
        writer
            .add_action(&ActionDraft {
                client_key: format!("input-{index}"),
                source_node_id: source.id,
                source_layer_id: Some(layer.id),
                kind: ActionKind::Input,
                relation: None,
                label: format!("Input {index}"),
                variant: ActionVariant::Pill,
                icon: None,
                description: None,
                target_layer_id: None,
                interaction_text: None,
                reusable: None,
                input_action_ids: Vec::new(),
                input: Some(input),
            })
            .await
            .unwrap();
    }
    root_expand(&writer, &interaction, &layer).await;
    writer.complete(interaction.id).await.unwrap();
    let accepted = writer.get_layer(layer.id).await.unwrap();
    assert_eq!(
        accepted
            .actions
            .iter()
            .filter_map(|action| action.input.as_ref().map(|input| input.control))
            .collect::<Vec<_>>(),
        vec![
            InputControl::Text,
            InputControl::SingleSelect,
            InputControl::MultiSelect,
        ]
    );
    let canonical = database
        .canonical_input_action_occurrence(
            Some(project(88)),
            thread(88),
            &PresentingInputOccurrence {
                presenting_interaction_node_id: interaction.id,
                presenting_layer_id: layer.id,
                action_id: accepted.actions[0].id,
            },
        )
        .await
        .unwrap();
    assert_eq!(canonical.input.unwrap().prompt, "Describe the evidence");

    let (database, interaction) = setup(None, thread(89)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let source = node(&writer, "bad-input-source").await;
    let layer = single_node_layer(&writer, "bad-input-layer", &source).await;
    let error = writer
        .add_action(&ActionDraft {
            client_key: "bad-input".into(),
            source_node_id: source.id,
            source_layer_id: Some(layer.id),
            kind: ActionKind::Input,
            relation: None,
            label: "Bad input".into(),
            variant: ActionVariant::Pill,
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: None,
            reusable: None,
            input_action_ids: Vec::new(),
            input: Some(InputAction {
                control: InputControl::MultiSelect,
                prompt: "Choose".into(),
                options: vec![
                    InputOption {
                        key: "same".into(),
                        label: "One".into(),
                        unsupported_fields: Default::default(),
                    },
                    InputOption {
                        key: "same".into(),
                        label: "Two".into(),
                        unsupported_fields: Default::default(),
                    },
                ],
                minimum_selections: Some(3),
                unsupported_fields: Default::default(),
            }),
        })
        .await
        .unwrap_err();
    let GraphError::ValidationIssues { issues, .. } = error else {
        panic!("expected ordered validation issues");
    };
    assert!(
        issues
            .iter()
            .any(|issue| issue.code == "input_action_option_key_duplicate")
    );
    assert!(
        issues
            .iter()
            .any(|issue| issue.code == "input_action_minimum_invalid")
    );

    let unsupported: ActionDraft = serde_json::from_value(serde_json::json!({
        "clientKey": "unsupported-input",
        "sourceNodeId": source.id,
        "sourceLayerId": layer.id,
        "kind": "input",
        "label": "Unsupported input",
        "variant": "pill",
        "targetLayerId": null,
        "interactionText": null,
        "control": "slider",
        "prompt": "Choose a value",
        "sliderMin": 1
    }))
    .unwrap();
    let error = writer.add_action(&unsupported).await.unwrap_err();
    let GraphError::ValidationIssues { issues, .. } = error else {
        panic!("expected a stable unsupported-control validation issue");
    };
    assert!(issues.iter().any(|issue| {
        issue.code == "input_action_control_unsupported" && issue.path == "control"
    }));
    assert!(issues.iter().any(|issue| {
        issue.code == "input_action_payload_unexpected" && issue.path == "sliderMin"
    }));

    let option_extension: ActionDraft = serde_json::from_value(serde_json::json!({
        "clientKey": "extended-option-input",
        "sourceNodeId": source.id,
        "sourceLayerId": layer.id,
        "kind": "input",
        "label": "Extended option input",
        "variant": "pill",
        "targetLayerId": null,
        "interactionText": null,
        "control": "single_select",
        "prompt": "Choose a value",
        "options": [{"key":"one","label":"One","imageUrl":"https://example.invalid/one.png"}]
    }))
    .unwrap();
    let error = writer.add_action(&option_extension).await.unwrap_err();
    let GraphError::ValidationIssues { issues, .. } = error else {
        panic!("expected a stable option-payload validation issue");
    };
    assert!(issues.iter().any(|issue| {
        issue.code == "input_action_payload_unexpected" && issue.path == "options[0].imageUrl"
    }));
}

#[tokio::test]
async fn canonical_input_occurrence_uses_project_scope_with_standalone_thread_fallback() {
    let (database, interaction) = setup(Some(project(89)), thread(89)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let source = node(&writer, "thread-bound-input-source").await;
    let layer = single_node_layer(&writer, "thread-bound-input-layer", &source).await;
    let action = writer
        .add_action(&ActionDraft {
            client_key: "thread-bound-input".into(),
            source_node_id: source.id,
            source_layer_id: Some(layer.id),
            kind: ActionKind::Input,
            relation: None,
            label: "Bound input".into(),
            variant: ActionVariant::Pill,
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: None,
            reusable: None,
            input_action_ids: Vec::new(),
            input: Some(InputAction {
                control: InputControl::Text,
                prompt: "Explain".into(),
                options: vec![],
                minimum_selections: None,
                unsupported_fields: Default::default(),
            }),
        })
        .await
        .unwrap();
    root_expand(&writer, &interaction, &layer).await;
    writer.complete(interaction.id).await.unwrap();
    let occurrence = PresentingInputOccurrence {
        presenting_interaction_node_id: interaction.id,
        presenting_layer_id: layer.id,
        action_id: action.id,
    };

    database
        .canonical_input_action_occurrence(Some(project(89)), thread(90), &occurrence)
        .await
        .unwrap();
    let wrong_action = PresentingInputOccurrence {
        action_id: relayer_graph_core::ActionId::new(action.id.value() + 1).unwrap(),
        ..occurrence.clone()
    };
    let error = database
        .canonical_input_action_occurrence(Some(project(89)), thread(90), &wrong_action)
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        GraphError::Validation { code, path, .. }
            if code == "input_action_not_in_occurrence" && path == "attachments[0].actionId"
    ));
    let error = database
        .canonical_input_action_occurrence(Some(project(90)), thread(89), &occurrence)
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        GraphError::Validation { code, path, .. }
            if code == "input_occurrence_not_visible" && path == "attachments[0]"
    ));

    let (standalone_database, standalone_interaction) = setup(None, thread(91)).await;
    let standalone_writer = standalone_database
        .writer_for_subgraph(standalone_interaction.id)
        .await
        .unwrap();
    let standalone_source = node(&standalone_writer, "standalone-input-source").await;
    let standalone_layer = single_node_layer(
        &standalone_writer,
        "standalone-input-layer",
        &standalone_source,
    )
    .await;
    let standalone_action = standalone_writer
        .add_action(&ActionDraft {
            client_key: "standalone-input".into(),
            source_node_id: standalone_source.id,
            source_layer_id: Some(standalone_layer.id),
            kind: ActionKind::Input,
            relation: None,
            label: "Standalone input".into(),
            variant: ActionVariant::Pill,
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: None,
            reusable: None,
            input_action_ids: Vec::new(),
            input: Some(InputAction {
                control: InputControl::Text,
                prompt: "Explain".into(),
                options: vec![],
                minimum_selections: None,
                unsupported_fields: Default::default(),
            }),
        })
        .await
        .unwrap();
    root_expand(
        &standalone_writer,
        &standalone_interaction,
        &standalone_layer,
    )
    .await;
    standalone_writer
        .complete(standalone_interaction.id)
        .await
        .unwrap();
    let standalone_occurrence = PresentingInputOccurrence {
        presenting_interaction_node_id: standalone_interaction.id,
        presenting_layer_id: standalone_layer.id,
        action_id: standalone_action.id,
    };
    standalone_database
        .canonical_input_action_occurrence(None, thread(91), &standalone_occurrence)
        .await
        .unwrap();
    let error = standalone_database
        .canonical_input_action_occurrence(None, thread(92), &standalone_occurrence)
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        GraphError::Validation { code, path, .. }
            if code == "input_occurrence_not_visible" && path == "attachments[0]"
    ));
}

#[tokio::test]
async fn submitted_input_children_are_canonical_isolated_and_retry_stable() {
    let file = tempfile::NamedTempFile::new().unwrap();
    let database = GraphDatabase::open(file.path()).await.unwrap();
    database
        .set_interaction_permissions_enabled(true)
        .await
        .unwrap();
    database
        .set_temporal_features(TemporalFeatureConfig {
            schema_read: true,
            root_current_write: true,
            ..TemporalFeatureConfig::default()
        })
        .await
        .unwrap();
    let presenting = database
        .create_interaction(Some(project(90)), thread(90), "Inputs")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(presenting.id).await.unwrap();
    let source = node(&writer, "input-source").await;
    let layer = single_node_layer(&writer, "input-layer", &source).await;
    for (key, input) in [
        (
            "text",
            InputAction {
                control: InputControl::Text,
                prompt: "Explain the tradeoff".into(),
                options: vec![],
                minimum_selections: None,
                unsupported_fields: Default::default(),
            },
        ),
        (
            "select",
            InputAction {
                control: InputControl::MultiSelect,
                prompt: "Choose evidence".into(),
                options: vec![
                    InputOption {
                        key: "logs".into(),
                        label: "Logs".into(),
                        unsupported_fields: Default::default(),
                    },
                    InputOption {
                        key: "traces".into(),
                        label: "Traces".into(),
                        unsupported_fields: Default::default(),
                    },
                ],
                minimum_selections: Some(1),
                unsupported_fields: Default::default(),
            },
        ),
    ] {
        writer
            .add_action(&ActionDraft {
                client_key: key.into(),
                source_node_id: source.id,
                source_layer_id: Some(layer.id),
                kind: ActionKind::Input,
                relation: None,
                label: key.into(),
                variant: ActionVariant::Pill,
                icon: None,
                description: None,
                target_layer_id: None,
                interaction_text: None,
                reusable: None,
                input_action_ids: Vec::new(),
                input: Some(input),
            })
            .await
            .unwrap();
    }
    root_expand(&writer, &presenting, &layer).await;
    writer.complete(presenting.id).await.unwrap();
    let accepted = writer.get_layer(layer.id).await.unwrap();
    let text_action = accepted
        .actions
        .iter()
        .find(|action| action.label == "text")
        .unwrap();
    let select_action = accepted
        .actions
        .iter()
        .find(|action| action.label == "select")
        .unwrap();
    let text = SubmittedInputDraft {
        occurrence: PresentingInputOccurrence {
            presenting_interaction_node_id: presenting.id,
            presenting_layer_id: layer.id,
            action_id: text_action.id,
        },
        action: text_action.input.clone().unwrap(),
        value: SubmittedInputValue::Text {
            text: "  Preserve this exactly.  ".into(),
        },
    };
    let select = SubmittedInputDraft {
        occurrence: PresentingInputOccurrence {
            presenting_interaction_node_id: presenting.id,
            presenting_layer_id: layer.id,
            action_id: select_action.id,
        },
        action: select_action.input.clone().unwrap(),
        value: SubmittedInputValue::Selected {
            selected: vec![
                InputOption {
                    key: "traces".into(),
                    label: "Traces".into(),
                    unsupported_fields: Default::default(),
                },
                InputOption {
                    key: "logs".into(),
                    label: "Logs".into(),
                    unsupported_fields: Default::default(),
                },
            ],
        },
    };
    let first_order = vec![select.clone(), text.clone()];
    let second_order = vec![text, select];
    let digest = interaction_input_authority_digest("", &first_order).unwrap();
    assert_eq!(
        digest,
        interaction_input_authority_digest("", &second_order).unwrap()
    );

    let (root, children) = database
        .create_identified_interaction_with_inputs(
            Some(project(90)),
            thread(91),
            "",
            InteractionInputPreparation {
                attempt_key: "attempt:90",
                authority_digest: &digest,
                contexts: &[],
                submitted_inputs: &first_order,
            },
        )
        .await
        .unwrap();
    let (replayed, replayed_children) = database
        .create_identified_interaction_with_inputs(
            Some(project(90)),
            thread(91),
            "",
            InteractionInputPreparation {
                attempt_key: "attempt:90",
                authority_digest: &digest,
                contexts: &[],
                submitted_inputs: &second_order,
            },
        )
        .await
        .unwrap();
    assert_eq!(replayed.id, root.id);
    assert_eq!(replayed_children, children);
    for replay_project in [Some(project(91)), None] {
        let scope_conflict = database
            .create_identified_interaction_with_inputs(
                replay_project,
                thread(91),
                "",
                InteractionInputPreparation {
                    attempt_key: "attempt:90",
                    authority_digest: &digest,
                    contexts: &[],
                    submitted_inputs: &second_order,
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(
            scope_conflict,
            GraphError::Validation {
                code: "interaction_input_attempt_conflict",
                path,
                ..
            } if path == "attemptKey"
        ));
    }
    assert_eq!(children.len(), 2);
    assert_eq!(children[0].parent_interaction_node_id, root.id);
    assert_eq!(children[0].source_node_id, source.id);
    let child_id = serde_json::to_value(children[0].id).unwrap();
    assert!(
        child_id
            .as_str()
            .unwrap()
            .starts_with("interaction-input-child:")
    );
    assert!(serde_json::from_value::<NodeId>(child_id).is_err());

    let normalized = database
        .writer_for_subgraph(root.id)
        .await
        .unwrap()
        .interaction_input()
        .await
        .unwrap();
    assert_eq!(normalized.interaction.detail, "");
    assert_eq!(normalized.submitted_inputs.len(), 2);
    let visible = serde_json::to_value(&normalized.submitted_inputs).unwrap();
    assert!(!visible.to_string().contains("actionId"));
    assert!(!visible.to_string().contains("presentingLayerId"));
    assert!(!visible.to_string().contains("attempt"));
    assert!(visible.to_string().contains("Preserve this exactly"));
    let contract = normalized.completion_contract.unwrap();
    assert!(contract.input.context.is_empty());
    assert_eq!(contract.input.answers.len(), 2);
    assert_eq!(
        contract.authorities,
        vec![InteractionPermission::NavigateAdd { node_id: source.id }]
    );
    assert_eq!(
        contract.return_requirements,
        vec![CompletionReturnRequirement::NavigateResponse { node_id: source.id }]
    );

    let changed_inputs = [second_order[0].clone()];
    let changed_digest = interaction_input_authority_digest("", &changed_inputs).unwrap();
    let conflict = database
        .create_identified_interaction_with_inputs(
            Some(project(90)),
            thread(91),
            "",
            InteractionInputPreparation {
                attempt_key: "attempt:90",
                authority_digest: &changed_digest,
                contexts: &[],
                submitted_inputs: &changed_inputs,
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(
        conflict,
        GraphError::Validation {
            code: "interaction_input_attempt_conflict",
            ..
        }
    ));

    let malformed = SubmittedInputDraft {
        occurrence: second_order[1].occurrence.clone(),
        action: second_order[1].action.clone(),
        value: SubmittedInputValue::Selected {
            selected: vec![InputOption {
                key: "unknown".into(),
                label: "Forged".into(),
                unsupported_fields: Default::default(),
            }],
        },
    };
    let malformed_digest =
        interaction_input_authority_digest("", std::slice::from_ref(&malformed)).unwrap();
    let malformed_inputs = [malformed];
    let error = database
        .create_identified_interaction_with_inputs(
            Some(project(90)),
            thread(92),
            "",
            InteractionInputPreparation {
                attempt_key: "attempt:bad",
                authority_digest: &malformed_digest,
                contexts: &[],
                submitted_inputs: &malformed_inputs,
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        GraphError::Validation {
            code: "input_option_unknown",
            ..
        }
    ));
    let repaired_inputs = [second_order[1].clone()];
    let repaired_digest = interaction_input_authority_digest("", &repaired_inputs).unwrap();
    database
        .create_identified_interaction_with_inputs(
            Some(project(90)),
            thread(92),
            "",
            InteractionInputPreparation {
                attempt_key: "attempt:bad",
                authority_digest: &repaired_digest,
                contexts: &[],
                submitted_inputs: &repaired_inputs,
            },
        )
        .await
        .expect("invalid child preparation must roll back the root and exact child set atomically");

    let second_interaction = database
        .create_interaction(Some(project(90)), thread(94), "Second input source")
        .await
        .unwrap();
    let second_writer = database
        .writer_for_subgraph(second_interaction.id)
        .await
        .unwrap();
    let second_source = node(&second_writer, "second-source").await;
    let second_layer = single_node_layer(&second_writer, "second-layer", &second_source).await;
    let second_field = second_writer
        .add_action(&ActionDraft {
            client_key: "second-field".into(),
            source_node_id: second_source.id,
            source_layer_id: Some(second_layer.id),
            kind: ActionKind::Input,
            relation: None,
            label: "Second question".into(),
            variant: ActionVariant::Pill,
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: None,
            reusable: None,
            input_action_ids: Vec::new(),
            input: Some(second_order[0].action.clone()),
        })
        .await
        .unwrap();
    root_expand(&second_writer, &second_interaction, &second_layer).await;
    second_writer.complete(second_interaction.id).await.unwrap();
    let mut combined_inputs = second_order.clone();
    combined_inputs.push(SubmittedInputDraft {
        occurrence: PresentingInputOccurrence {
            presenting_interaction_node_id: second_interaction.id,
            presenting_layer_id: second_layer.id,
            action_id: second_field.id,
        },
        action: second_order[0].action.clone(),
        value: SubmittedInputValue::Text {
            text: "Another source answer".into(),
        },
    });
    let contexts = [InteractionContextDraft {
        target: InteractionContextTarget {
            node_id: source.id,
            source_interaction_node_id: presenting.id,
            source_layer_id: layer.id,
        },
        annotations: vec!["Same node annotation".into()],
    }];
    let combined_digest = interaction_input_authority_digest("", &combined_inputs).unwrap();
    let (response_root, response_children) = database
        .create_identified_interaction_with_inputs(
            Some(project(90)),
            thread(95),
            "",
            InteractionInputPreparation {
                attempt_key: "attempt:combined",
                authority_digest: &combined_digest,
                contexts: &contexts,
                submitted_inputs: &combined_inputs,
            },
        )
        .await
        .unwrap();
    let answer_writer = database
        .writer_for_subgraph(response_root.id)
        .await
        .unwrap();
    let combined_contract = answer_writer
        .interaction_input()
        .await
        .unwrap()
        .completion_contract
        .unwrap();
    assert_eq!(combined_contract.input.answers.len(), 3);
    assert_eq!(combined_contract.input.context.len(), 1);
    assert_eq!(
        combined_contract.authorities,
        vec![
            InteractionPermission::NavigateAdd { node_id: source.id },
            InteractionPermission::NavigateAdd {
                node_id: second_source.id
            }
        ]
    );
    assert_eq!(
        combined_contract.return_requirements,
        vec![
            CompletionReturnRequirement::NavigateResponse { node_id: source.id },
            CompletionReturnRequirement::NavigateResponse {
                node_id: second_source.id
            }
        ]
    );
    answer_writer
        .authorize_interaction_permission(&InteractionPermission::NavigateAdd {
            node_id: source.id,
        })
        .await
        .unwrap();
    answer_writer
        .authorize_interaction_permission(&InteractionPermission::NavigateAdd {
            node_id: second_source.id,
        })
        .await
        .unwrap();
    let unrelated_interaction = database
        .create_interaction(Some(project(90)), thread(93), "Unrelated")
        .await
        .unwrap();
    let unrelated_writer = database
        .writer_for_subgraph(unrelated_interaction.id)
        .await
        .unwrap();
    let unrelated = node(&unrelated_writer, "unrelated").await;
    accept_single_node(&unrelated_writer, unrelated_interaction, unrelated.clone()).await;
    assert!(
        answer_writer
            .authorize_interaction_permission(&InteractionPermission::NavigateAdd {
                node_id: unrelated.id
            })
            .await
            .is_err()
    );

    let answer = node(&answer_writer, "input-answer").await;
    let response = single_node_layer(&answer_writer, "input-answer-layer", &answer).await;
    root_expand(&answer_writer, &response_root, &response).await;
    for transition in [
        CurrentTransition::Advance {
            layer_id: response.id,
        },
        CurrentTransition::Return {
            layer_id: response.id,
        },
    ] {
        assert!(matches!(
            answer_writer
                .transition_current(0, "missing-input-source-link", transition)
                .await,
            Err(GraphError::Validation {
                code: "attached_response_navigation_required",
                ..
            })
        ));
        assert_eq!(
            answer_writer
                .current_completion()
                .await
                .unwrap()
                .head_revision,
            0
        );
        assert_eq!(
            answer_writer
                .get_layer(response.id)
                .await
                .unwrap()
                .layer
                .state,
            RecordState::Draft
        );
    }
    let backlink = ActionDraft {
        client_key: "input-source-response".into(),
        source_node_id: source.id,
        source_layer_id: None,
        kind: ActionKind::Navigate,
        relation: Some(NavigateRelation::Reference),
        label: "Input response".into(),
        variant: ActionVariant::default(),
        icon: None,
        description: None,
        target_layer_id: Some(response.id),
        interaction_text: None,
        reusable: None,
        input_action_ids: Vec::new(),
        input: None,
    };
    assert!(
        answer_writer
            .add_action(&ActionDraft {
                source_node_id: unrelated.id,
                ..backlink.clone()
            })
            .await
            .is_err()
    );
    let exact_link = answer_writer.add_action(&backlink).await.unwrap();
    assert!(matches!(
        answer_writer
            .transition_current(
                0,
                "one-source-still-missing",
                CurrentTransition::Advance {
                    layer_id: response.id
                }
            )
            .await,
        Err(GraphError::Validation {
            code: "attached_response_navigation_required",
            ..
        })
    ));
    let second_link = answer_writer
        .add_action(&ActionDraft {
            client_key: "second-source-response".into(),
            source_node_id: second_source.id,
            ..backlink.clone()
        })
        .await
        .unwrap();
    answer_writer
        .transition_current(
            0,
            "linked-input-advance",
            CurrentTransition::Advance {
                layer_id: response.id,
            },
        )
        .await
        .unwrap();
    assert!(answer_writer.completion_output().await.unwrap().is_none());
    let returned = answer_writer
        .transition_current(
            1,
            "linked-input-return",
            CurrentTransition::Return {
                layer_id: response.id,
            },
        )
        .await
        .unwrap();
    assert_eq!(returned.final_layer_id, Some(response.id));

    database
        .set_interaction_permissions_enabled(false)
        .await
        .unwrap();
    database.close().await;
    let reopened = GraphDatabase::open(file.path()).await.unwrap();
    let (recovered, recovered_children) = reopened
        .create_identified_interaction_with_inputs(
            Some(project(90)),
            thread(91),
            "",
            InteractionInputPreparation {
                attempt_key: "attempt:90",
                authority_digest: &digest,
                contexts: &[],
                submitted_inputs: &second_order,
            },
        )
        .await
        .unwrap();
    assert_eq!(recovered.id, root.id);
    assert_eq!(recovered_children, children);
    let recovered_writer = reopened.writer_for_subgraph(root.id).await.unwrap();
    assert_eq!(
        recovered_writer
            .interaction_input()
            .await
            .unwrap()
            .completion_contract,
        Some(contract)
    );
    let (recovered_response, recovered_response_children) = reopened
        .create_identified_interaction_with_inputs(
            Some(project(90)),
            thread(95),
            "",
            InteractionInputPreparation {
                attempt_key: "attempt:combined",
                authority_digest: &combined_digest,
                contexts: &contexts,
                submitted_inputs: &combined_inputs,
            },
        )
        .await
        .unwrap();
    assert_eq!(recovered_response.id, response_root.id);
    assert_eq!(recovered_response_children, response_children);
    let recovered_response_writer = reopened
        .writer_for_subgraph(response_root.id)
        .await
        .unwrap();
    assert_eq!(
        recovered_response_writer
            .interaction_input()
            .await
            .unwrap()
            .completion_contract,
        Some(combined_contract)
    );
    assert_eq!(
        recovered_response_writer
            .current_completion()
            .await
            .unwrap()
            .head_revision,
        2
    );
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(SqliteConnectOptions::new().filename(file.path()))
        .await
        .unwrap();
    let restored: Vec<(i64, i64, i64)> = sqlx::query_as("SELECT id,source_node_id,target_layer_id FROM actions WHERE id IN (?1,?2) AND state='accepted' ORDER BY id")
        .bind(exact_link.id.value()).bind(second_link.id.value()).fetch_all(&pool).await.unwrap();
    assert_eq!(
        restored,
        vec![
            (
                exact_link.id.value(),
                source.id.value(),
                response.id.value()
            ),
            (
                second_link.id.value(),
                second_source.id.value(),
                response.id.value()
            )
        ]
    );
    pool.close().await;
}

#[tokio::test]
async fn action_presentation_errors_are_repairable() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let source = node(&writer, "source").await;

    let unsupported = writer
        .add_action(&ActionDraft {
            client_key: "unsupported".into(),
            source_node_id: source.id,
            source_layer_id: None,
            kind: ActionKind::Invoke,
            relation: None,
            label: "Unsupported".into(),
            variant: ActionVariant::Unsupported("banner".into()),
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: Some("Try it".into()),
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(
        unsupported,
        GraphError::Validation {
            code: "unsupported_action_variant",
            ref path,
            ..
        } if path == "variant"
    ));

    let missing_description = writer
        .add_action(&ActionDraft {
            client_key: "missing-description".into(),
            source_node_id: source.id,
            source_layer_id: None,
            kind: ActionKind::Invoke,
            relation: None,
            label: "Card".into(),
            variant: ActionVariant::Card,
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: Some("Try it".into()),
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(
        missing_description,
        GraphError::Validation {
            code: "missing_action_description",
            ref path,
            ..
        } if path == "description"
    ));
}

#[test]
fn older_authored_actions_default_to_the_pill_presentation() {
    let draft: ActionDraft = serde_json::from_value(serde_json::json!({
        "clientKey": "older-author",
        "sourceNodeId": 1,
        "kind": "invoke",
        "label": "Continue",
        "interactionText": "Continue from here"
    }))
    .unwrap();

    assert_eq!(draft.variant, ActionVariant::Pill);
    assert_eq!(draft.icon, None);
    assert_eq!(draft.description, None);
}

#[tokio::test]
async fn authored_user_interaction_nodes_cannot_open_new_write_scopes() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let authored = writer
        .submit_node(&NodeDraft {
            client_key: "authored-interaction".into(),
            kind: "user-interaction".into(),
            icon: "user".into(),
            title: "Not a canonical turn".into(),
            detail: "This node was authored inside another interaction.".into(),
        })
        .await
        .unwrap();
    accept_single_node(&writer, interaction, authored.clone()).await;

    assert!(matches!(
        database.writer_for_subgraph(authored.id).await,
        Err(GraphError::Forbidden(_))
    ));
}

#[tokio::test]
async fn completion_rejects_an_edge_accepted_by_a_concurrent_interaction() {
    let project_id = project(1);
    let (database, seed_a) = setup(Some(project_id), thread(1)).await;
    let first_node = {
        let writer = database.writer_for_subgraph(seed_a.id).await.unwrap();
        let value = node(&writer, "shared-a").await;
        accept_single_node(&writer, seed_a, value.clone()).await;
        value
    };
    let seed_b = database
        .create_interaction(Some(project_id), thread(2), "Create the second shared node")
        .await
        .unwrap();
    let second_node = {
        let writer = database.writer_for_subgraph(seed_b.id).await.unwrap();
        let value = node(&writer, "shared-b").await;
        accept_single_node(&writer, seed_b, value.clone()).await;
        value
    };
    let first_interaction = database
        .create_interaction(Some(project_id), thread(3), "Connect the shared nodes")
        .await
        .unwrap();
    let second_interaction = database
        .create_interaction(Some(project_id), thread(4), "Also connect the shared nodes")
        .await
        .unwrap();
    let first_writer = database
        .writer_for_subgraph(first_interaction.id)
        .await
        .unwrap();
    let second_writer = database
        .writer_for_subgraph(second_interaction.id)
        .await
        .unwrap();

    for (writer, interaction, key) in [
        (&first_writer, &first_interaction, "first-edge"),
        (&second_writer, &second_interaction, "second-edge"),
    ] {
        let edge = writer
            .create_edge(&EdgeDraft {
                client_key: key.into(),
                endpoints: [first_node.id, second_node.id],
            })
            .await
            .unwrap();
        let layer = writer
            .submit_layer(&LayerDraft {
                default_node_id: None,
                client_key: "root".into(),
                nodes: vec![first_node.id, second_node.id],
                edges: vec![edge.id],
                layout: authored_layout([first_node.id, second_node.id]),
                size_justification: None,
            })
            .await
            .unwrap();
        writer
            .add_action(&ActionDraft {
                client_key: "response".into(),
                source_node_id: interaction.id,
                source_layer_id: None,
                kind: ActionKind::Navigate,
                relation: Some(NavigateRelation::Expand),
                label: "Response".into(),
                variant: ActionVariant::default(),
                icon: None,
                description: None,
                target_layer_id: Some(layer.id),
                interaction_text: None,
                reusable: None,
                input_action_ids: Vec::new(),
                input: None,
            })
            .await
            .unwrap();
    }

    first_writer.complete(first_interaction.id).await.unwrap();
    assert!(matches!(
        second_writer.complete(second_interaction.id).await,
        Err(GraphError::Validation {
            code: "duplicate_edge",
            ..
        })
    ));
}

#[tokio::test]
async fn accepted_layers_keep_their_original_action_snapshot() {
    let project_id = project(1);
    let (database, referenced_interaction) = setup(Some(project_id), thread(1)).await;
    let viewer_interaction = database
        .create_interaction(Some(project_id), thread(2), "Show the other interaction")
        .await
        .unwrap();
    let viewer = database
        .writer_for_subgraph(viewer_interaction.id)
        .await
        .unwrap();
    let viewer_layer = viewer
        .submit_layer(&LayerDraft {
            default_node_id: None,
            client_key: "root".into(),
            nodes: vec![referenced_interaction.id],
            edges: vec![],
            layout: authored_layout([referenced_interaction.id]),
            size_justification: None,
        })
        .await
        .unwrap();
    viewer
        .add_action(&ActionDraft {
            client_key: "response".into(),
            source_node_id: viewer_interaction.id,
            source_layer_id: None,
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Expand),
            label: "Response".into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: Some(viewer_layer.id),
            interaction_text: None,
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .unwrap();
    let before = viewer.complete(viewer_interaction.id).await.unwrap();
    assert!(before.root_layer.actions.is_empty());

    let referenced = database
        .writer_for_subgraph(referenced_interaction.id)
        .await
        .unwrap();
    let answer = node(&referenced, "later-answer").await;
    accept_single_node(&referenced, referenced_interaction, answer).await;

    let after = viewer.completion_output().await.unwrap().unwrap();
    assert!(after.root_layer.actions.is_empty());
}

#[tokio::test]
async fn accepted_completion_survives_database_reopen() {
    let temporary = tempfile::tempdir().unwrap();
    let file = tempfile::NamedTempFile::new_in(temporary.path()).unwrap();
    let database = GraphDatabase::open(file.path()).await.unwrap();
    let interaction = database
        .create_interaction(Some(project(1)), thread(1), "Persist this answer")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let answer = node(&writer, "persisted").await;
    let layer = accept_single_node(&writer, interaction.clone(), answer).await;
    drop(writer);
    database.close().await;

    let reopened = GraphDatabase::open(file.path()).await.unwrap();
    let writer = reopened.writer_for_subgraph(interaction.id).await.unwrap();
    let output = writer.completion_output().await.unwrap().unwrap();
    assert_eq!(output.node_id, interaction.id);
    assert_eq!(output.root_layer.nodes[0].title, "persisted");
    assert_eq!(output.root_layer.layer.layout, layer.layout);
}

#[tokio::test]
async fn accepted_authored_detail_survives_caller_mutation_and_database_reopen() {
    let temporary = tempfile::tempdir().unwrap();
    let file = tempfile::NamedTempFile::new_in(temporary.path()).unwrap();
    let database = GraphDatabase::open(file.path()).await.unwrap();
    let interaction = database
        .create_interaction(Some(project(1)), thread(1), "Show the architecture")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let mut authored_detail = serde_json::json!({
        "version": 1,
        "components": [{
            "id": "overview",
            "order": 0,
            "html": "<section><img data-gc-asset=\"m_asset\"></section>",
            "css": "section{display:grid}"
        }],
        "mounts": [{
            "id": "m_asset",
            "componentId": "overview",
            "kind": "asset",
            "host": "img",
            "assetId": "architecture-diagram"
        }],
        "assets": [{
            "id": "architecture-diagram",
            "digestSha256": "a9ce00f55032b62526a3abfc5aa6019874beff5d18c90607d663840d14ed11f9",
            "mediaType": "image/png",
            "representation": "image"
        }],
        "integritySha256": "adf1296990ca1e4be5e4d90eb9f4a4fab14716a885efc524cc04018294fc17d1"
    });
    let prepared = PreparedDetailAsset {
        asset_id: "architecture-diagram".into(),
        digest_sha256: "a9ce00f55032b62526a3abfc5aa6019874beff5d18c90607d663840d14ed11f9".into(),
        media_type: "image/png".into(),
        byte_length: 13,
        provenance_source: "user".into(),
        provenance_file_name: "architecture.png".into(),
        content: b"trusted asset".to_vec(),
    };
    let answer = writer
        .submit_node_with_prepared_detail_assets(
            &NodeDraft {
                client_key: "answer".into(),
                kind: "concept".into(),
                icon: "box".into(),
                title: "Architecture".into(),
                detail: "Legacy fallback".into(),
            },
            AuthoredDetailUpdate::Replace(&authored_detail),
            Some(std::slice::from_ref(&prepared)),
        )
        .await
        .unwrap();
    authored_detail["components"][0]["html"] = serde_json::json!("mutated after submit");
    accept_single_node(&writer, interaction.clone(), answer.clone()).await;
    drop(writer);
    drop(database);

    let reopened = GraphDatabase::open(file.path()).await.unwrap();
    let persisted = reopened
        .writer_for_subgraph(interaction.id)
        .await
        .unwrap()
        .get_node(answer.id)
        .await
        .unwrap();
    assert_eq!(
        persisted.authored_detail.as_ref().unwrap()["components"][0]["html"],
        "<section><img data-gc-asset=\"m_asset\"></section>"
    );
    assert_eq!(persisted.detail, "Legacy fallback");
    let persisted_asset = reopened
        .accepted_detail_asset(answer.id, "architecture-diagram")
        .await
        .unwrap();
    assert_eq!(persisted_asset.content, b"trusted asset");
    assert_eq!(persisted_asset.provenance_source, "user");
    assert_eq!(persisted_asset.provenance_file_name, "architecture.png");
}

#[tokio::test]
async fn authored_detail_assets_require_an_exact_prepared_snapshot_before_draft_mutation() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let original = NodeDraft {
        client_key: "answer".into(),
        kind: "concept".into(),
        icon: "box".into(),
        title: "Original".into(),
        detail: "Original fallback".into(),
    };
    let checkpointed = writer.submit_node(&original).await.unwrap();
    let replacement = NodeDraft {
        title: "Replacement".into(),
        detail: "Replacement fallback".into(),
        ..original.clone()
    };
    let package = serde_json::json!({
        "version": 1,
        "components": [],
        "mounts": [],
        "assets": [{
            "id": "visual",
            "digestSha256": "a9ce00f55032b62526a3abfc5aa6019874beff5d18c90607d663840d14ed11f9",
            "mediaType": "image/png",
            "representation": "image"
        }],
        "integritySha256": "b18b2fd5072d9771b2454970111b3c78bb2660f044b2c15d83fa7cdaad80fe06"
    });

    for result in [
        writer
            .submit_node_with_authored_detail(&replacement, Some(&package))
            .await,
        writer
            .submit_node_with_authored_detail_update(
                &replacement,
                AuthoredDetailUpdate::Replace(&package),
            )
            .await,
    ] {
        assert!(matches!(
            result,
            Err(GraphError::Validation {
                code: "authored_detail_asset_snapshot_mismatch",
                ..
            })
        ));
        let unchanged = writer.get_node(checkpointed.id).await.unwrap();
        assert_eq!(unchanged.title, "Original");
        assert_eq!(unchanged.detail, "Original fallback");
        assert_eq!(unchanged.authored_detail, None);
    }

    let prepared = PreparedDetailAsset {
        asset_id: "visual".into(),
        digest_sha256: "a9ce00f55032b62526a3abfc5aa6019874beff5d18c90607d663840d14ed11f9".into(),
        media_type: "image/png".into(),
        byte_length: 13,
        provenance_source: "user".into(),
        provenance_file_name: "visual.png".into(),
        content: b"trusted asset".to_vec(),
    };
    let with_asset = writer
        .submit_node_with_prepared_detail_assets(
            &replacement,
            AuthoredDetailUpdate::Replace(&package),
            Some(std::slice::from_ref(&prepared)),
        )
        .await
        .unwrap();
    assert_eq!(with_asset.authored_detail.as_ref(), Some(&package));

    let asset_free_package = serde_json::json!({
        "version": 1,
        "components": [{"id":"summary","order":0,"html":"<p>Asset free</p>","css":""}],
        "mounts": [],
        "assets": [],
        "integritySha256": "c70e238c045d135d5560ce2f51a0a6768a7e8af712c118f5df3c3a04fe1ebbe0"
    });
    let asset_free = writer
        .submit_node_with_authored_detail(&replacement, Some(&asset_free_package))
        .await
        .unwrap();
    assert_eq!(
        asset_free.authored_detail.as_ref(),
        Some(&asset_free_package)
    );
    let retained = writer.submit_node(&original).await.unwrap();
    assert_eq!(retained.authored_detail.as_ref(), Some(&asset_free_package));
}

#[tokio::test]
async fn draft_resubmission_without_authored_detail_preserves_checkpointed_package() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let package = serde_json::json!({
        "version": 1,
        "components": [{"id":"summary","order":0,"html":"<p>Checkpointed</p>","css":""}],
        "mounts": [],
        "assets": [],
        "integritySha256": "546706eb23bcfd7a1ab4d17bbce3b21e92686f5a8b9316a45ba63c6919b8f4ac"
    });
    let checkpointed = writer
        .submit_node_with_authored_detail(
            &NodeDraft {
                client_key: "answer".into(),
                kind: "concept".into(),
                icon: "box".into(),
                title: "Checkpointed".into(),
                detail: "Legacy fallback".into(),
            },
            Some(&package),
        )
        .await
        .unwrap();

    let resubmitted = writer
        .submit_node(&NodeDraft {
            client_key: "answer".into(),
            kind: "concept".into(),
            icon: "box".into(),
            title: "Revised title".into(),
            detail: "Revised fallback".into(),
        })
        .await
        .unwrap();

    assert_eq!(resubmitted.id, checkpointed.id);
    assert_eq!(resubmitted.authored_detail.as_ref(), Some(&package));
    accept_single_node(&writer, interaction, resubmitted).await;
    let accepted = writer.get_node(checkpointed.id).await.unwrap();
    assert_eq!(accepted.authored_detail.as_ref(), Some(&package));
}

#[tokio::test]
async fn draft_resubmission_can_explicitly_clear_a_checkpointed_package() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let package = serde_json::json!({
        "version": 1,
        "components": [{"id":"summary","order":0,"html":"<p>Checkpointed</p>","css":""}],
        "mounts": [],
        "assets": [],
        "integritySha256": "546706eb23bcfd7a1ab4d17bbce3b21e92686f5a8b9316a45ba63c6919b8f4ac"
    });
    let draft = NodeDraft {
        client_key: "answer".into(),
        kind: "concept".into(),
        icon: "box".into(),
        title: "Checkpointed".into(),
        detail: "Legacy fallback".into(),
    };
    let checkpointed = writer
        .submit_node_with_authored_detail(&draft, Some(&package))
        .await
        .unwrap();

    let cleared = writer
        .submit_node_with_authored_detail_update(
            &NodeDraft {
                title: "Markdown only".into(),
                ..draft.clone()
            },
            AuthoredDetailUpdate::Clear,
        )
        .await
        .unwrap();
    assert_eq!(cleared.id, checkpointed.id);
    assert_eq!(cleared.title, "Markdown only");
    assert_eq!(cleared.authored_detail, None);

    // Retain after a clear stays cleared; a later package replaces it again.
    let retained = writer.submit_node(&draft).await.unwrap();
    assert_eq!(retained.authored_detail, None);
    let replaced = writer
        .submit_node_with_authored_detail_update(&draft, AuthoredDetailUpdate::Replace(&package))
        .await
        .unwrap();
    assert_eq!(replaced.authored_detail.as_ref(), Some(&package));

    let cleared_again = writer
        .submit_node_with_authored_detail_update(&draft, AuthoredDetailUpdate::Clear)
        .await
        .unwrap();
    accept_single_node(&writer, interaction, cleared_again).await;
    let accepted = writer.get_node(checkpointed.id).await.unwrap();
    assert_eq!(accepted.authored_detail, None);
}

#[tokio::test]
async fn authored_detail_rejects_a_package_with_corrupt_canonical_integrity() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let package = serde_json::json!({
        "version": 1,
        "components": [{"id":"summary","order":0,"html":"<p>Tampered</p>","css":""}],
        "mounts": [],
        "assets": [],
        "integritySha256": "6c34582a24f665dfcf9efa843fdb254a646de79c505d76c80863f81ed8dfe659"
    });

    let error = writer
        .submit_node_with_authored_detail(
            &NodeDraft {
                client_key: "tampered".into(),
                kind: "concept".into(),
                icon: "box".into(),
                title: "Tampered".into(),
                detail: "Legacy fallback".into(),
            },
            Some(&package),
        )
        .await
        .unwrap_err();

    assert!(matches!(
        error,
        GraphError::Validation { code: "authored_detail_integrity_mismatch", path, .. }
            if path == "authoredDetail.integritySha256"
    ));
}

#[tokio::test]
async fn authored_detail_rejects_rehashed_noncanonical_asset_schema() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let package = serde_json::json!({
        "version": 1,
        "components": [],
        "mounts": [],
        "assets": [{
            "id": "asset",
            "digestSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "mediaType": "image/gif",
            "representation": "image"
        }],
        "integritySha256": "e9263fa99f0603d9990363996c0220d5d4544df0c60c8becc5ce8d9eaa64d8ed"
    });

    let error = writer
        .submit_node_with_authored_detail(
            &NodeDraft {
                client_key: "unsupported".into(),
                kind: "concept".into(),
                icon: "box".into(),
                title: "Unsupported".into(),
                detail: "Legacy fallback".into(),
            },
            Some(&package),
        )
        .await
        .unwrap_err();

    assert!(matches!(
        error,
        GraphError::Validation { code: "authored_detail_invalid", path, .. }
            if path == "authoredDetail"
    ));
}

#[tokio::test]
async fn coordinate_free_accepted_history_remains_readable_after_restart() {
    use sqlx::{Connection, SqliteConnection};

    let temporary = tempfile::tempdir().unwrap();
    let file = tempfile::NamedTempFile::new_in(temporary.path()).unwrap();
    let database = GraphDatabase::open(file.path()).await.unwrap();
    let interaction = database
        .create_interaction(Some(project(1)), thread(1), "Read legacy history")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let answer = node(&writer, "legacy").await;
    let layer = accept_single_node(&writer, interaction.clone(), answer).await;
    drop(writer);
    database.close().await;

    let url = format!("sqlite://{}", file.path().display());
    let mut connection = SqliteConnection::connect(&url).await.unwrap();
    sqlx::query("DELETE FROM layer_placements WHERE layer_id=?1")
        .bind(layer.id.value())
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("UPDATE layers SET layout_schema_version=NULL WHERE id=?1")
        .bind(layer.id.value())
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();

    let reopened = GraphDatabase::open(file.path()).await.unwrap();
    let writer = reopened.writer_for_subgraph(interaction.id).await.unwrap();
    let output = writer.completion_output().await.unwrap().unwrap();
    assert_eq!(output.root_layer.nodes[0].title, "legacy");
    assert_eq!(output.root_layer.layer.layout, None);
}

#[tokio::test]
async fn shape_free_draft_from_before_edge_shapes_accepts_and_reads_after_restart() {
    use sqlx::{Connection, SqliteConnection};

    let temporary = tempfile::tempdir().unwrap();
    let file = tempfile::NamedTempFile::new_in(temporary.path()).unwrap();
    let database = GraphDatabase::open(file.path()).await.unwrap();
    let interaction = database
        .create_interaction(Some(project(1)), thread(1), "Finish an older draft")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let answer = node(&writer, "older draft").await;
    let draft = writer
        .submit_layer(&LayerDraft {
            default_node_id: None,
            client_key: "root".into(),
            nodes: vec![answer.id],
            edges: vec![],
            layout: authored_layout([answer.id]),
            size_justification: None,
        })
        .await
        .unwrap();
    drop(writer);
    database.close().await;

    // A draft saved by a build without edge shapes has no stored shape.
    let url = format!("sqlite://{}", file.path().display());
    let mut connection = SqliteConnection::connect(&url).await.unwrap();
    sqlx::query("UPDATE layers SET layout_edge_shape=NULL WHERE id=?1")
        .bind(draft.id.value())
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();

    let reopened = GraphDatabase::open(file.path()).await.unwrap();
    let writer = reopened.writer_for_subgraph(interaction.id).await.unwrap();
    writer
        .add_action(&ActionDraft {
            client_key: "response".into(),
            source_node_id: interaction.id,
            source_layer_id: None,
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Expand),
            label: "Response".into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: Some(draft.id),
            interaction_text: None,
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .unwrap();
    writer.complete(interaction.id).await.unwrap();
    drop(writer);
    reopened.close().await;

    let reopened = GraphDatabase::open(file.path()).await.unwrap();
    let writer = reopened.writer_for_subgraph(interaction.id).await.unwrap();
    let output = writer.completion_output().await.unwrap().unwrap();
    let layout = output.root_layer.layer.layout.unwrap();
    assert_eq!(layout.edge_shape, None);
    assert_eq!(layout.placements, draft.layout.unwrap().placements);
}

#[tokio::test]
async fn different_threads_can_write_through_the_same_pool() {
    let temporary = tempfile::tempdir().unwrap();
    let file = tempfile::NamedTempFile::new_in(temporary.path()).unwrap();
    let database = GraphDatabase::open(file.path()).await.unwrap();
    let first = database
        .create_interaction(Some(project(1)), thread(1), "First thread")
        .await
        .unwrap();
    let second = database
        .create_interaction(Some(project(1)), thread(2), "Second thread")
        .await
        .unwrap();
    let first_writer = database.writer_for_subgraph(first.id).await.unwrap();
    let second_writer = database.writer_for_subgraph(second.id).await.unwrap();

    let first_draft = NodeDraft {
        client_key: "first".into(),
        kind: "concept".into(),
        icon: "box".into(),
        title: "First".into(),
        detail: "First thread write".into(),
    };
    let second_draft = NodeDraft {
        client_key: "second".into(),
        kind: "concept".into(),
        icon: "terminal".into(),
        title: "Second".into(),
        detail: "Second thread write".into(),
    };
    let (first_result, second_result) = tokio::join!(
        first_writer.submit_node(&first_draft),
        second_writer.submit_node(&second_draft)
    );

    assert_eq!(first_result.unwrap().title, "First");
    assert_eq!(second_result.unwrap().title, "Second");
}

#[tokio::test]
async fn ordinary_and_leased_interactions_expose_immutable_lease_identity() {
    let (database, source_interaction) = setup(Some(project(1)), thread(1)).await;
    assert_eq!(source_interaction.leased_action_id, None);
    let (source_node, invoke) = accepted_invoke(&database, &source_interaction).await;
    let invocation = InteractionInvocation {
        source_interaction_node_id: source_interaction.id,
        source_action_id: invoke.id,
    };

    let leased = database
        .create_interaction_with_invocation(
            Some(project(1)),
            thread(2),
            "Continue this answer",
            Some(invocation),
        )
        .await
        .unwrap();
    let retry = database
        .create_interaction_with_invocation(
            Some(project(1)),
            thread(2),
            "This retry body is not allowed to mutate the result",
            Some(invocation),
        )
        .await
        .unwrap();

    assert_eq!(leased, retry);
    assert_eq!(leased.leased_action_id, Some(invoke.id));
    assert_eq!(leased.title, "Continue this answer");
    let neighbors = database
        .writer_for_subgraph(leased.id)
        .await
        .unwrap()
        .neighbors(leased.id)
        .await
        .unwrap();
    assert_eq!(neighbors.len(), 1);
    assert_eq!(neighbors[0].id, source_node.id);
    assert_eq!(neighbors[0].state, RecordState::Accepted);
    assert!(
        database
            .writer_for_subgraph(source_interaction.id)
            .await
            .unwrap()
            .neighbors(source_node.id)
            .await
            .unwrap()
            .iter()
            .all(|node| node.id != leased.id)
    );
}

#[tokio::test]
async fn lease_issuance_rejects_invalid_authority_kind_and_scope() {
    let (database, source_interaction) = setup(Some(project(1)), thread(1)).await;
    let source_writer = database
        .writer_for_subgraph(source_interaction.id)
        .await
        .unwrap();
    let draft_source = node(&source_writer, "draft-source").await;
    let draft_layer = single_node_layer(&source_writer, "draft-layer", &draft_source).await;
    let draft_invoke = source_writer
        .add_action(&ActionDraft {
            client_key: "draft-invoke".into(),
            source_node_id: draft_source.id,
            source_layer_id: Some(draft_layer.id),
            kind: ActionKind::Invoke,
            relation: None,
            label: "Continue".into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: Some("Continue".into()),
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .unwrap();
    let no_completion = database
        .create_interaction_with_invocation(
            Some(project(1)),
            thread(2),
            "Invalid",
            Some(InteractionInvocation {
                source_interaction_node_id: source_interaction.id,
                source_action_id: draft_invoke.id,
            }),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        no_completion,
        GraphError::Validation {
            code: "invalid_invocation_source",
            ..
        }
    ));

    root_expand(&source_writer, &source_interaction, &draft_layer).await;
    source_writer.complete(source_interaction.id).await.unwrap();
    let wrong_scope = database
        .create_interaction_with_invocation(
            Some(project(2)),
            thread(2),
            "Invalid",
            Some(InteractionInvocation {
                source_interaction_node_id: source_interaction.id,
                source_action_id: draft_invoke.id,
            }),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        wrong_scope,
        GraphError::Validation {
            code: "incompatible_invocation_scope",
            ..
        }
    ));

    let non_invoke = source_writer
        .completion_output()
        .await
        .unwrap()
        .unwrap()
        .root_action;
    let wrong_kind = database
        .create_interaction_with_invocation(
            Some(project(1)),
            thread(2),
            "Invalid",
            Some(InteractionInvocation {
                source_interaction_node_id: source_interaction.id,
                source_action_id: non_invoke.id,
            }),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        wrong_kind,
        GraphError::Validation {
            code: "action_not_in_source_completion" | "invalid_invocation_action",
            ..
        }
    ));

    let other_interaction = database
        .create_interaction(Some(project(1)), thread(3), "Other completion")
        .await
        .unwrap();
    let (_, other_invoke) = accepted_invoke(&database, &other_interaction).await;
    let mismatched = database
        .create_interaction_with_invocation(
            Some(project(1)),
            thread(4),
            "Invalid",
            Some(InteractionInvocation {
                source_interaction_node_id: source_interaction.id,
                source_action_id: other_invoke.id,
            }),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        mismatched,
        GraphError::Validation {
            code: "action_not_in_source_completion",
            ..
        }
    ));
}

#[tokio::test]
async fn reused_action_snapshot_leases_once_concurrently_and_replays_after_reopen() {
    let temporary = tempfile::tempdir().unwrap();
    let file = tempfile::NamedTempFile::new_in(temporary.path()).unwrap();
    let database = GraphDatabase::open(file.path()).await.unwrap();
    let source_interaction = database
        .create_interaction(Some(project(1)), thread(1), "Source")
        .await
        .unwrap();
    let (source_node, invoke) = accepted_invoke(&database, &source_interaction).await;
    let reused_interaction = database
        .create_interaction(Some(project(1)), thread(2), "Reuse the accepted source")
        .await
        .unwrap();
    let reused_writer = database
        .writer_for_subgraph(reused_interaction.id)
        .await
        .unwrap();
    let reused_layer = single_node_layer(&reused_writer, "reused-root", &source_node).await;
    root_expand(&reused_writer, &reused_interaction, &reused_layer).await;
    let reused_output = reused_writer.complete(reused_interaction.id).await.unwrap();
    assert!(
        reused_output
            .root_layer
            .actions
            .iter()
            .any(|action| action.id == invoke.id)
    );
    let invocation = InteractionInvocation {
        source_interaction_node_id: reused_interaction.id,
        source_action_id: invoke.id,
    };
    let first_database = database.clone();
    let second_database = database.clone();
    let (first, second) = tokio::join!(
        first_database.create_interaction_with_invocation(
            Some(project(1)),
            thread(3),
            "Result",
            Some(invocation),
        ),
        second_database.create_interaction_with_invocation(
            Some(project(1)),
            thread(3),
            "Result",
            Some(invocation),
        )
    );
    let leased = first.unwrap();
    assert_eq!(second.unwrap().id, leased.id);

    let different_source = database
        .create_interaction_with_invocation(
            Some(project(1)),
            thread(3),
            "Result",
            Some(InteractionInvocation {
                source_interaction_node_id: source_interaction.id,
                source_action_id: invoke.id,
            }),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        different_source,
        GraphError::Validation {
            code: "invocation_action_already_leased",
            ..
        }
    ));
    database.close().await;

    let reopened = GraphDatabase::open(file.path()).await.unwrap();
    let replay = reopened
        .create_interaction_with_invocation(Some(project(1)), thread(3), "Result", Some(invocation))
        .await
        .unwrap();
    assert_eq!(replay.id, leased.id);
    assert_eq!(replay.leased_action_id, Some(invoke.id));
    let neighbors = reopened
        .writer_for_subgraph(replay.id)
        .await
        .unwrap()
        .neighbors(replay.id)
        .await
        .unwrap();
    assert_eq!(neighbors.len(), 1);
    assert_eq!(neighbors[0].id, source_node.id);
    assert_eq!(neighbors[0].state, RecordState::Accepted);
}

#[tokio::test]
async fn leased_completion_atomically_resolves_invoke_once_and_survives_reopen() {
    leased_completion_atomically_resolves_invoke_once_and_survives_reopen_fixture(false).await;
}

#[tokio::test]
async fn typed_leased_completion_atomically_resolves_invoke_once_and_survives_reopen() {
    leased_completion_atomically_resolves_invoke_once_and_survives_reopen_fixture(true).await;
}

async fn leased_completion_atomically_resolves_invoke_once_and_survives_reopen_fixture(
    typed: bool,
) {
    let temporary = tempfile::tempdir().unwrap();
    let file = tempfile::NamedTempFile::new_in(temporary.path()).unwrap();
    let database = GraphDatabase::open(file.path()).await.unwrap();
    database
        .set_interaction_permissions_enabled(typed)
        .await
        .unwrap();
    let source_interaction = database
        .create_interaction(Some(project(1)), thread(1), "Source")
        .await
        .unwrap();
    let (source_node, unresolved) = accepted_invoke(&database, &source_interaction).await;
    let reused_interaction = database
        .create_interaction(Some(project(1)), thread(3), "Reuse")
        .await
        .unwrap();
    let reused_writer = database
        .writer_for_subgraph(reused_interaction.id)
        .await
        .unwrap();
    let reused_layer = single_node_layer(&reused_writer, "reused-root", &source_node).await;
    root_expand(&reused_writer, &reused_interaction, &reused_layer).await;
    reused_writer.complete(reused_interaction.id).await.unwrap();
    let leased = database
        .create_interaction_with_invocation(
            Some(project(1)),
            thread(2),
            "Result",
            Some(InteractionInvocation {
                source_interaction_node_id: source_interaction.id,
                source_action_id: unresolved.id,
            }),
        )
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(leased.id).await.unwrap();
    let answer = node(&writer, "result-answer").await;
    let root_layer = single_node_layer(&writer, "result-root", &answer).await;
    root_expand(&writer, &leased, &root_layer).await;

    let first_writer = database.writer_for_subgraph(leased.id).await.unwrap();
    let second_writer = database.writer_for_subgraph(leased.id).await.unwrap();
    let (first, second) = tokio::join!(
        first_writer.complete(leased.id),
        second_writer.complete(leased.id)
    );
    let output = first.unwrap();
    assert_eq!(second.unwrap(), output);
    assert_eq!(output.root_layer.layer.id, root_layer.id);

    let source_output = database
        .writer_for_subgraph(source_interaction.id)
        .await
        .unwrap()
        .completion_output()
        .await
        .unwrap()
        .unwrap();
    let resolved = source_output
        .root_layer
        .actions
        .iter()
        .find(|action| action.id == unresolved.id)
        .unwrap();
    assert_eq!(
        resolved.kind,
        if typed {
            ActionKind::Navigate
        } else {
            ActionKind::Invoke
        }
    );
    assert_eq!(resolved.relation, typed.then_some(NavigateRelation::Expand));
    assert_eq!(
        resolved.resolved_invoke_interaction_id,
        typed.then_some(leased.id)
    );
    assert_eq!(resolved.source_node_id, source_node.id);
    assert_eq!(resolved.source_layer_id, unresolved.source_layer_id);
    assert_eq!(resolved.label, unresolved.label);
    assert_eq!(resolved.variant, unresolved.variant);
    assert_eq!(resolved.icon, unresolved.icon);
    assert_eq!(resolved.description, unresolved.description);
    assert_eq!(
        resolved.interaction_text,
        if typed {
            None
        } else {
            unresolved.interaction_text.clone()
        }
    );
    assert_eq!(resolved.target_layer_id, Some(root_layer.id));
    assert_eq!(resolved.state, RecordState::Accepted);
    let reused_output = reused_writer.completion_output().await.unwrap().unwrap();
    assert_eq!(
        reused_output
            .root_layer
            .actions
            .iter()
            .find(|action| action.id == unresolved.id)
            .unwrap()
            .target_layer_id,
        Some(root_layer.id)
    );

    if typed {
        // The conversion receipt is durable authority provenance, not an editable
        // cache: removing or redirecting it must not erase the typed identity.
        let fixture = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(SqliteConnectOptions::new().filename(file.path()))
            .await
            .unwrap();
        for statement in [
            "UPDATE invoke_resolution_transitions SET target_layer_id=target_layer_id WHERE action_id=?1",
            "DELETE FROM invoke_resolution_transitions WHERE action_id=?1",
        ] {
            let error = sqlx::query(statement)
                .bind(unresolved.id.value())
                .execute(&fixture)
                .await
                .expect_err("conversion receipts must be immutable");
            assert!(error.to_string().contains("immutable_invoke_resolution"));
        }
        fixture.close().await;
    }

    drop(writer);
    drop(first_writer);
    drop(second_writer);
    drop(reused_writer);
    database.close().await;
    let reopened = GraphDatabase::open(file.path()).await.unwrap();
    reopened
        .set_interaction_permissions_enabled(false)
        .await
        .unwrap();
    let roots = reopened
        .resolved_invoke_roots(&[source_interaction.id, reused_interaction.id, leased.id])
        .await
        .unwrap();
    assert_eq!(roots.len(), if typed { 2 } else { 0 });
    if typed {
        assert!(roots.contains(&source_interaction.id));
        assert!(roots.contains(&reused_interaction.id));
    }
    let recovered = reopened
        .create_interaction_with_invocation(
            Some(project(1)),
            thread(2),
            "ignored",
            Some(InteractionInvocation {
                source_interaction_node_id: source_interaction.id,
                source_action_id: unresolved.id,
            }),
        )
        .await
        .unwrap();
    assert_eq!(recovered, leased);
    let replay = reopened
        .writer_for_subgraph(leased.id)
        .await
        .unwrap()
        .complete(leased.id)
        .await
        .unwrap();
    assert_eq!(replay, output);
    let reopened_source = reopened
        .writer_for_subgraph(source_interaction.id)
        .await
        .unwrap()
        .completion_output()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        reopened_source
            .root_layer
            .actions
            .iter()
            .find(|action| action.id == unresolved.id)
            .unwrap()
            .target_layer_id,
        Some(root_layer.id)
    );
}

#[tokio::test]
async fn leased_completion_storage_failure_rolls_back_closure_and_resolution() {
    leased_completion_storage_failure_rolls_back_closure_and_resolution_fixture(false).await;
}

#[tokio::test]
async fn typed_leased_completion_storage_failure_rolls_back_closure_and_resolution() {
    leased_completion_storage_failure_rolls_back_closure_and_resolution_fixture(true).await;
}

async fn leased_completion_storage_failure_rolls_back_closure_and_resolution_fixture(typed: bool) {
    let temporary = tempfile::tempdir().unwrap();
    let file = tempfile::NamedTempFile::new_in(temporary.path()).unwrap();
    let database = GraphDatabase::open(file.path()).await.unwrap();
    database
        .set_interaction_permissions_enabled(typed)
        .await
        .unwrap();
    let source_interaction = database
        .create_interaction(Some(project(1)), thread(1), "Source")
        .await
        .unwrap();
    let (_, invoke) = accepted_invoke(&database, &source_interaction).await;
    let leased = database
        .create_interaction_with_invocation(
            Some(project(1)),
            thread(2),
            "Result",
            Some(InteractionInvocation {
                source_interaction_node_id: source_interaction.id,
                source_action_id: invoke.id,
            }),
        )
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(leased.id).await.unwrap();
    let answer = node(&writer, "rollback-answer").await;
    let root_layer = single_node_layer(&writer, "rollback-root", &answer).await;
    root_expand(&writer, &leased, &root_layer).await;

    let fixture = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(file.path())
                .foreign_keys(true),
        )
        .await
        .unwrap();
    sqlx::query(&format!(
        "CREATE TRIGGER reject_result_completion BEFORE INSERT ON completions WHEN NEW.interaction_node_id={} BEGIN SELECT RAISE(ABORT, 'forced completion failure'); END",
        leased.id.value()
    ))
    .execute(&fixture)
    .await
    .unwrap();

    assert!(writer.complete(leased.id).await.is_err());
    assert!(writer.completion_output().await.unwrap().is_none());
    let draft_layer = writer.get_layer(root_layer.id).await.unwrap();
    assert_eq!(draft_layer.layer.state, RecordState::Draft);
    assert_eq!(draft_layer.nodes[0].state, RecordState::Draft);
    let source_output = database
        .writer_for_subgraph(source_interaction.id)
        .await
        .unwrap()
        .completion_output()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        source_output
            .root_layer
            .actions
            .iter()
            .find(|action| action.id == invoke.id)
            .unwrap()
            .target_layer_id,
        None
    );
}

#[tokio::test]
async fn typed_permissions_freeze_exact_combined_authority_and_reject_false_provenance() {
    let database = GraphDatabase::in_memory().await.unwrap();
    database
        .set_interaction_permissions_enabled(true)
        .await
        .unwrap();
    let source = database
        .create_interaction(Some(project(1)), thread(1), "Source")
        .await
        .unwrap();
    let (_, invoke) = accepted_invoke(&database, &source).await;
    let mut contexts = Vec::new();
    for index in 2..=3 {
        let interaction = database
            .create_interaction(Some(project(1)), thread(index), "Context")
            .await
            .unwrap();
        let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
        let target = node(&writer, "context").await;
        let layer = accept_single_node(&writer, interaction.clone(), target.clone()).await;
        contexts.push(InteractionContextDraft {
            target: InteractionContextTarget {
                node_id: target.id,
                source_interaction_node_id: interaction.id,
                source_layer_id: layer.id,
            },
            annotations: vec![],
        });
    }
    let origin = Some(InteractionInvocation {
        source_interaction_node_id: source.id,
        source_action_id: invoke.id,
    });
    let interaction = database
        .create_interaction_with_invocation_and_context(
            Some(project(1)),
            thread(4),
            "ignored",
            origin,
            &contexts,
        )
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let helper = database.writer_for_subgraph(interaction.id).await.unwrap();
    let permission = InteractionPermission::InvokeResolve {
        action_id: invoke.id,
    };
    helper
        .authorize_interaction_permission(&permission)
        .await
        .unwrap();
    let frozen = database
        .interaction_permissions(interaction.id)
        .await
        .unwrap();
    assert_eq!(
        frozen,
        Some(InteractionPermissions::V2 {
            enabled: true,
            permissions: vec![
                permission.clone(),
                InteractionPermission::NavigateAdd {
                    node_id: contexts[0].target.node_id
                },
                InteractionPermission::NavigateAdd {
                    node_id: contexts[1].target.node_id
                }
            ]
        })
    );
    database
        .set_interaction_permissions_enabled(false)
        .await
        .unwrap();
    assert!(
        database
            .create_interaction_with_invocation_and_context(
                Some(project(1)),
                thread(4),
                "ignored",
                origin,
                &contexts[..1]
            )
            .await
            .is_err()
    );
    assert_eq!(
        database
            .interaction_permissions(interaction.id)
            .await
            .unwrap(),
        frozen
    );
    for context in &contexts {
        writer
            .authorize_interaction_permission(&InteractionPermission::NavigateAdd {
                node_id: context.target.node_id,
            })
            .await
            .unwrap();
    }
    // The source interaction is visible but unattached; an arbitrary action ID is also denied.
    assert!(
        writer
            .authorize_interaction_permission(&InteractionPermission::NavigateAdd {
                node_id: source.id
            })
            .await
            .is_err()
    );
    assert!(
        writer
            .authorize_interaction_permission(&InteractionPermission::InvokeResolve {
                action_id: ActionId::new(invoke.id.value() + 1000).unwrap()
            })
            .await
            .is_err()
    );
    let answer = node(&writer, "answer").await;
    let layer = single_node_layer(&writer, "answer-layer", &answer).await;
    let draft = ActionDraft {
        client_key: "forbidden-persistent".into(),
        source_node_id: contexts[0].target.node_id,
        source_layer_id: Some(layer.id),
        kind: ActionKind::Navigate,
        relation: Some(NavigateRelation::Expand),
        label: "Open".into(),
        variant: ActionVariant::default(),
        icon: None,
        description: None,
        target_layer_id: Some(layer.id),
        interaction_text: None,
        reusable: None,
        input_action_ids: Vec::new(),
        input: None,
    };
    assert!(writer.add_action(&draft).await.is_err());
    root_expand(&writer, &interaction, &layer).await;
    for context in &contexts {
        let mut backlink = draft.clone();
        backlink.client_key = format!("response-{}", context.target.node_id);
        backlink.source_node_id = context.target.node_id;
        backlink.source_layer_id = None;
        writer.add_action(&backlink).await.unwrap();
    }
    writer.complete(interaction.id).await.unwrap();
    assert!(
        helper
            .authorize_interaction_permission(&permission)
            .await
            .is_err()
    );
    assert_eq!(
        database
            .interaction_permissions(interaction.id)
            .await
            .unwrap(),
        frozen
    );
    // Caller payloads cannot describe additional variants or future versions.
    for json in [
        r#"{"version":"future","enabled":true,"permissions":[]}"#,
        r#"{"version":"1","enabled":true,"permissions":[{"kind":"node.edit","nodeId":1}]}"#,
        r#"{"version":"1","enabled":true,"permissions":[{"kind":"navigate.add","nodeId":1,"invoke":true}]}"#,
    ] {
        assert!(serde_json::from_str::<InteractionPermissions>(json).is_err());
    }
}

#[tokio::test]
async fn typed_invoke_rejects_expand_cycle_atomically_and_stop_revokes_authority() {
    let database = GraphDatabase::in_memory().await.unwrap();
    database
        .set_interaction_permissions_enabled(true)
        .await
        .unwrap();
    let source = database
        .create_interaction(Some(project(1)), thread(1), "Source")
        .await
        .unwrap();
    let (source_node, invoke) = accepted_invoke(&database, &source).await;
    let interaction = database
        .create_interaction_with_invocation(
            Some(project(1)),
            thread(2),
            "ignored",
            Some(InteractionInvocation {
                source_interaction_node_id: source.id,
                source_action_id: invoke.id,
            }),
        )
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let layer = single_node_layer(&writer, "cycle", &source_node).await;
    root_expand(&writer, &interaction, &layer).await;
    assert!(matches!(
        writer.complete(interaction.id).await,
        Err(GraphError::Validation {
            code: "expand_cycle",
            ..
        })
    ));
    assert_eq!(
        writer.get_layer(layer.id).await.unwrap().layer.state,
        RecordState::Draft
    );
    let source_writer = database.writer_for_subgraph(source.id).await.unwrap();
    let unchanged = source_writer
        .completion_output()
        .await
        .unwrap()
        .unwrap()
        .root_layer
        .actions
        .into_iter()
        .find(|action| action.id == invoke.id)
        .unwrap();
    assert_eq!(unchanged.id, invoke.id);
    assert_eq!(unchanged.kind, ActionKind::Invoke);
    assert_eq!(unchanged.target_layer_id, None);
    assert_eq!(unchanged.resolved_invoke_interaction_id, None);
    let permission = InteractionPermission::InvokeResolve {
        action_id: invoke.id,
    };
    writer
        .authorize_interaction_permission(&permission)
        .await
        .unwrap();
    writer
        .transition_current(
            0,
            "stop",
            CurrentTransition::Stop {
                reason: "cancelled_by_user".into(),
            },
        )
        .await
        .unwrap();
    assert!(
        writer
            .authorize_interaction_permission(&permission)
            .await
            .is_err()
    );
    assert!(writer.complete(interaction.id).await.is_err());
}

#[tokio::test]
async fn typed_permission_storage_is_immutable_and_unknown_versions_fail_closed() {
    let temporary = tempfile::tempdir().unwrap();
    let file = tempfile::NamedTempFile::new_in(temporary.path()).unwrap();
    let database = GraphDatabase::open(file.path()).await.unwrap();
    database
        .set_interaction_permissions_enabled(true)
        .await
        .unwrap();
    let source = database
        .create_interaction(None, thread(1), "Source")
        .await
        .unwrap();
    let (_, invoke) = accepted_invoke(&database, &source).await;
    let interaction = database
        .create_interaction_with_invocation(
            None,
            thread(1),
            "ignored",
            Some(InteractionInvocation {
                source_interaction_node_id: source.id,
                source_action_id: invoke.id,
            }),
        )
        .await
        .unwrap();
    let fixture = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(file.path())
                .foreign_keys(true),
        )
        .await
        .unwrap();
    assert!(
        sqlx::query("UPDATE interaction_permissions SET description='{}'")
            .execute(&fixture)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("DELETE FROM interaction_permissions WHERE interaction_node_id=?1")
            .bind(interaction.id.value())
            .execute(&fixture)
            .await
            .is_err()
    );
    sqlx::query("DROP TRIGGER interaction_permissions_immutable")
        .execute(&fixture)
        .await
        .unwrap();
    emulate_legacy_contract(&fixture, interaction.id).await;
    sqlx::query("UPDATE interaction_permissions SET description=?1 WHERE interaction_node_id=?2")
        .bind(r#"{"version":"future","enabled":true,"permissions":[]}"#)
        .bind(interaction.id.value())
        .execute(&fixture)
        .await
        .unwrap();
    fixture.close().await;
    database.close().await;
    let reopened = GraphDatabase::open(file.path()).await.unwrap();
    let writer = reopened.writer_for_subgraph(interaction.id).await.unwrap();
    assert!(
        writer
            .authorize_interaction_permission(&InteractionPermission::InvokeResolve {
                action_id: invoke.id
            })
            .await
            .is_err()
    );
    let answer = node(&writer, "answer").await;
    let layer = single_node_layer(&writer, "root", &answer).await;
    root_expand(&writer, &interaction, &layer).await;
    assert!(writer.complete(interaction.id).await.is_err());
    assert_eq!(
        writer.get_layer(layer.id).await.unwrap().layer.state,
        RecordState::Draft
    );
}

#[tokio::test]
async fn typed_permissions_temporal_return_and_semantic_child_have_distinct_authority() {
    let file = tempfile::NamedTempFile::new().unwrap();
    let database = GraphDatabase::open(file.path()).await.unwrap();
    database
        .set_interaction_permissions_enabled(true)
        .await
        .unwrap();
    database
        .set_temporal_features(TemporalFeatureConfig {
            schema_read: true,
            root_current_write: true,
            projection_ui: true,
            invoke_resolution: true,
            provider_recursion: true,
            ..TemporalFeatureConfig::default()
        })
        .await
        .unwrap();
    let source = database
        .create_interaction(None, thread(1), "Source")
        .await
        .unwrap();
    let (source_node, invoke) = accepted_invoke(&database, &source).await;
    let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}", file.path().display()))
        .await
        .unwrap();
    emulate_legacy_contract(&pool, source.id).await;
    pool.close().await;
    let parent = database.writer_for_subgraph(source.id).await.unwrap();
    let child = parent
        .prepare_recursive_completion(invoke.id)
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(child.id).await.unwrap();
    let permission = InteractionPermission::InvokeResolve {
        action_id: invoke.id,
    };
    assert!(
        parent
            .authorize_interaction_permission(&permission)
            .await
            .is_err()
    );
    writer
        .authorize_interaction_permission(&permission)
        .await
        .unwrap();
    let answer = node(&writer, "answer").await;
    let layer = single_node_layer(&writer, "root", &answer).await;
    // A discarded sibling has an unpublished node-owned expansion back to the
    // leased source. It is not part of the current that Return accepts.
    let sibling = single_node_layer(&writer, "discarded-sibling", &answer).await;
    let back = single_node_layer(&writer, "discarded-back", &source_node).await;
    navigate(
        &writer,
        "unpublished-back",
        &answer,
        &sibling,
        &back,
        NavigateRelation::Expand,
    )
    .await;
    writer.discard_layer(sibling.id).await.unwrap();
    writer.discard_layer(back.id).await.unwrap();
    root_expand(&writer, &child, &layer).await;
    writer
        .transition_current(
            0,
            "publish",
            CurrentTransition::Advance { layer_id: layer.id },
        )
        .await
        .unwrap();
    writer
        .transition_current(
            1,
            "return",
            CurrentTransition::Return { layer_id: layer.id },
        )
        .await
        .unwrap();
    assert!(
        writer
            .authorize_interaction_permission(&permission)
            .await
            .is_err()
    );
    let resolved = parent
        .completion_output()
        .await
        .unwrap()
        .unwrap()
        .root_layer
        .actions
        .into_iter()
        .find(|action| action.id == invoke.id)
        .unwrap();
    assert_eq!(resolved.kind, ActionKind::Navigate);
    assert_eq!(resolved.resolved_invoke_interaction_id, Some(child.id));
}

#[tokio::test]
async fn typed_invoke_snapshots_same_completion_occurrences_and_rejects_reused_cycle() {
    invoke_occurrences_fixture(true).await;
}

#[tokio::test]
async fn typed_conversion_updates_legacy_occurrences_atomically() {
    invoke_occurrences_fixture(false).await;
}

async fn invoke_occurrences_fixture(source_typed: bool) {
    let temporary = tempfile::tempdir().unwrap();
    let file = tempfile::NamedTempFile::new_in(temporary.path()).unwrap();
    let database = GraphDatabase::open(file.path()).await.unwrap();
    database
        .set_interaction_permissions_enabled(source_typed)
        .await
        .unwrap();
    let source = database
        .create_interaction(None, thread(1), "Source")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(source.id).await.unwrap();
    let menu = node(&writer, "menu").await;
    let shared = node(&writer, "shared").await;
    let root = single_node_layer(&writer, "root", &menu).await;
    let first = single_node_layer(&writer, "first", &shared).await;
    let second = single_node_layer(&writer, "second", &shared).await;
    navigate(
        &writer,
        "first",
        &menu,
        &root,
        &first,
        NavigateRelation::Expand,
    )
    .await;
    navigate(
        &writer,
        "second",
        &menu,
        &root,
        &second,
        NavigateRelation::Expand,
    )
    .await;
    let invoke = writer
        .add_action(&ActionDraft {
            client_key: "invoke".into(),
            source_node_id: shared.id,
            source_layer_id: Some(first.id),
            kind: ActionKind::Invoke,
            relation: None,
            label: "Continue".into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: Some("Continue".into()),
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .unwrap();
    root_expand(&writer, &source, &root).await;
    writer.complete(source.id).await.unwrap();
    let initial_layers = if source_typed {
        vec![first.id, second.id]
    } else {
        vec![first.id]
    };
    if !source_typed {
        assert!(
            writer
                .get_layer(second.id)
                .await
                .unwrap()
                .actions
                .is_empty()
        );
    }
    for layer in &initial_layers {
        let actions = writer.get_layer(*layer).await.unwrap().actions;
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].id, invoke.id);
        assert_eq!(actions[0].source_layer_id, Some(first.id));
    }
    database
        .set_interaction_permissions_enabled(true)
        .await
        .unwrap();
    let child = database
        .create_interaction_with_invocation(
            None,
            thread(1),
            "ignored",
            Some(InteractionInvocation {
                source_interaction_node_id: source.id,
                source_action_id: invoke.id,
            }),
        )
        .await
        .unwrap();
    let child_writer = database.writer_for_subgraph(child.id).await.unwrap();
    let response = single_node_layer(&child_writer, "reused-response", &shared).await;
    root_expand(&child_writer, &child, &response).await;
    assert!(matches!(
        child_writer.complete(child.id).await,
        Err(GraphError::Validation {
            code: "expand_cycle",
            ..
        })
    ));
    for layer in initial_layers {
        let action = &writer.get_layer(layer).await.unwrap().actions[0];
        assert_eq!(action.kind, ActionKind::Invoke);
        assert_eq!(action.target_layer_id, None);
    }
    assert!(child_writer.completion_output().await.unwrap().is_none());
    if !source_typed {
        assert!(
            writer
                .get_layer(second.id)
                .await
                .unwrap()
                .actions
                .is_empty()
        );
        let answer = node(&child_writer, "answer").await;
        single_node_layer(&child_writer, "reused-response", &answer).await;
        let fixture = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(SqliteConnectOptions::new().filename(file.path()))
            .await
            .unwrap();
        sqlx::query("CREATE TRIGGER reject_conversion BEFORE INSERT ON completions BEGIN SELECT RAISE(ABORT, 'forced conversion rollback'); END")
            .execute(&fixture).await.unwrap();
        assert!(child_writer.complete(child.id).await.is_err());
        assert!(
            writer
                .get_layer(second.id)
                .await
                .unwrap()
                .actions
                .is_empty()
        );
        assert_eq!(
            writer.get_layer(first.id).await.unwrap().actions[0].kind,
            ActionKind::Invoke
        );
        assert!(child_writer.completion_output().await.unwrap().is_none());
        sqlx::query("DROP TRIGGER reject_conversion")
            .execute(&fixture)
            .await
            .unwrap();
        fixture.close().await;
        let completed = child_writer.complete(child.id).await.unwrap();
        assert_eq!(child_writer.complete(child.id).await.unwrap(), completed);
        let reopened = GraphDatabase::open(file.path()).await.unwrap();
        let writer = reopened.writer_for_subgraph(source.id).await.unwrap();
        for layer in [first.id, second.id] {
            let actions = writer.get_layer(layer).await.unwrap().actions;
            assert_eq!(
                actions.len(),
                1,
                "converted invoke must appear in every legacy occurrence"
            );
            assert_eq!(actions[0].id, invoke.id);
            assert_eq!(actions[0].kind, ActionKind::Navigate);
            assert_eq!(actions[0].source_layer_id, Some(first.id));
            assert_eq!(actions[0].target_layer_id, Some(response.id));
        }
    }
}

#[tokio::test]
async fn typed_imported_invoke_cannot_gain_authority_through_writable_occurrence() {
    let temporary = tempfile::tempdir().unwrap();
    let file = tempfile::NamedTempFile::new_in(temporary.path()).unwrap();
    let database = GraphDatabase::open(file.path()).await.unwrap();
    database
        .set_interaction_permissions_enabled(true)
        .await
        .unwrap();
    let mut imported = imported_invoke_conversation();
    imported.project_id = Some(project(1));
    imported.turns.truncate(1);
    let receipt = database
        .import_accepted_conversation(&imported)
        .await
        .unwrap();
    let original = database
        .writer_for_subgraph(NodeId::new(receipt.turns[0].graph_node_id.unwrap()).unwrap())
        .await
        .unwrap();
    let layer_id = LayerId::new(receipt.turns[0].root_layer_id.unwrap()).unwrap();
    let before = original.get_layer(layer_id).await.unwrap();
    let action = &before.actions[0];
    let presenting = database
        .create_interaction(Some(project(1)), thread(1), "Reuse imported source")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(presenting.id).await.unwrap();
    let reused = single_node_layer(&writer, "reuse", &before.nodes[0]).await;
    root_expand(&writer, &presenting, &reused).await;
    writer.complete(presenting.id).await.unwrap();
    assert_eq!(
        writer.get_layer(reused.id).await.unwrap().actions[0].id,
        action.id
    );
    let result = database
        .create_interaction_with_invocation(
            Some(project(1)),
            thread(2),
            "ignored",
            Some(InteractionInvocation {
                source_interaction_node_id: presenting.id,
                source_action_id: action.id,
            }),
        )
        .await;
    assert!(
        result.is_err(),
        "a writable presentation cannot grant authority over an imported invoke"
    );
    assert_eq!(original.get_layer(layer_id).await.unwrap(), before);

    // Persist the unsafe preparation that the previous implementation allowed.
    // This is a storage compatibility fixture, not a public mutation API.
    let old = database
        .create_interaction(Some(project(1)), thread(2), "Continue")
        .await
        .unwrap();
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(SqliteConnectOptions::new().filename(file.path()))
        .await
        .unwrap();
    sqlx::query("UPDATE nodes SET leased_action_id=?1,lease_source_interaction_id=?2 WHERE id=?3")
        .bind(action.id.value())
        .bind(presenting.id.value())
        .bind(old.id.value())
        .execute(&pool)
        .await
        .unwrap();
    // Simulate the pre-guard database that admitted this historical unsafe lease.
    sqlx::query("DROP TRIGGER interaction_permissions_no_delete")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM interaction_permissions WHERE interaction_node_id=?1")
        .bind(old.id.value())
        .execute(&pool)
        .await
        .unwrap();
    let permission = InteractionPermission::InvokeResolve {
        action_id: action.id,
    };
    sqlx::query("INSERT INTO interaction_permissions VALUES(?1,?2)")
        .bind(old.id.value())
        .bind(
            serde_json::to_string(&InteractionPermissions::V1 {
                enabled: true,
                permissions: vec![permission.clone()],
            })
            .unwrap(),
        )
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("CREATE TRIGGER interaction_permissions_no_delete BEFORE DELETE ON interaction_permissions BEGIN SELECT RAISE(ABORT, 'immutable_interaction_permissions'); END;").execute(&pool).await.unwrap();
    pool.close().await;
    let reopened = GraphDatabase::open(file.path()).await.unwrap();
    let old_writer = reopened.writer_for_subgraph(old.id).await.unwrap();
    assert!(
        old_writer
            .authorize_interaction_permission(&permission)
            .await
            .is_err()
    );
    let answer = node(&old_writer, "answer").await;
    let response = single_node_layer(&old_writer, "response", &answer).await;
    root_expand(&old_writer, &old, &response).await;
    assert!(old_writer.complete(old.id).await.is_err());
    assert!(old_writer.completion_output().await.unwrap().is_none());
    assert_eq!(
        old_writer.get_layer(response.id).await.unwrap().layer.state,
        RecordState::Draft
    );
    assert_eq!(original.get_layer(layer_id).await.unwrap(), before);
}

#[tokio::test]
async fn default_node_is_member_validated_and_survives_publication_and_reopen() {
    let temporary = tempfile::tempdir().unwrap();
    let file = tempfile::NamedTempFile::new_in(temporary.path()).unwrap();
    let database = GraphDatabase::open(file.path()).await.unwrap();
    let interaction = database
        .create_interaction(None, thread(901), "Choose a starting detail")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let first = node(&writer, "first").await;
    let second = node(&writer, "second").await;
    let outside = node(&writer, "outside").await;
    let edge = writer
        .create_edge(&EdgeDraft {
            client_key: "link".into(),
            endpoints: [first.id, second.id],
        })
        .await
        .unwrap();
    let mut draft = LayerDraft {
        client_key: "default-node-layer".into(),
        nodes: vec![first.id, second.id],
        edges: vec![edge.id],
        layout: authored_layout([first.id, second.id]),
        size_justification: None,
        default_node_id: Some(first.id),
    };
    let original = writer.submit_layer(&draft).await.unwrap();
    draft.default_node_id = Some(second.id);
    let repaired = writer.submit_layer(&draft).await.unwrap();
    assert_eq!(original.id, repaired.id);
    root_expand(&writer, &interaction, &repaired).await;
    draft.default_node_id = Some(outside.id);
    let error = writer.submit_layer(&draft).await.unwrap_err();
    assert!(
        matches!(error, GraphError::ValidationIssues { ref issues, .. } if issues.iter().any(|issue| issue.code == "default_node_outside_layer"))
    );
    assert_eq!(
        writer
            .get_layer(repaired.id)
            .await
            .unwrap()
            .layer
            .default_node_id,
        Some(second.id)
    );
    writer
        .transition_current(
            0,
            "publish-default",
            CurrentTransition::Advance {
                layer_id: repaired.id,
            },
        )
        .await
        .unwrap();
    draft.default_node_id = Some(first.id);
    assert!(writer.submit_layer(&draft).await.is_err());
    drop(writer);
    database.close().await;
    let reopened = GraphDatabase::open(file.path()).await.unwrap();
    let restored = reopened
        .writer_for_subgraph(interaction.id)
        .await
        .unwrap()
        .get_layer(repaired.id)
        .await
        .unwrap();
    assert_eq!(restored.layer.default_node_id, Some(second.id));
    assert_eq!(restored.layer.state, RecordState::Accepted);
}

#[tokio::test]
async fn attached_navigation_without_replacement_preserves_plain_detail_and_reference_cycle() {
    let database = GraphDatabase::in_memory().await.unwrap();
    database
        .set_interaction_permissions_enabled(true)
        .await
        .unwrap();
    let source = database
        .create_interaction(Some(project(1)), thread(1), "Source")
        .await
        .unwrap();
    let source_writer = database.writer_for_subgraph(source.id).await.unwrap();
    let persistent = node(&source_writer, "persistent").await;
    let source_layer = single_node_layer(&source_writer, "source-layer", &persistent).await;
    root_expand(&source_writer, &source, &source_layer).await;
    source_writer.complete(source.id).await.unwrap();
    let reuse = database
        .create_interaction(Some(project(1)), thread(3), "Reuse")
        .await
        .unwrap();
    let reuse_writer = database.writer_for_subgraph(reuse.id).await.unwrap();
    let reused = single_node_layer(&reuse_writer, "reused", &persistent).await;
    root_expand(&reuse_writer, &reuse, &reused).await;
    reuse_writer.complete(reuse.id).await.unwrap();
    let (interaction, _) = database
        .create_interaction_with_context(
            Some(project(1)),
            thread(2),
            "Add supporting reference",
            &[InteractionContextDraft {
                target: InteractionContextTarget {
                    node_id: persistent.id,
                    source_interaction_node_id: source.id,
                    source_layer_id: source_layer.id,
                },
                annotations: vec!["Add a reference".into()],
            }],
        )
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let answer = node(&writer, "answer").await;
    let response = single_node_layer(&writer, "response", &answer).await;
    root_expand(&writer, &interaction, &response).await;
    let draft = ActionDraft {
        client_key: "supporting-reference".into(),
        source_node_id: persistent.id,
        source_layer_id: None,
        kind: ActionKind::Navigate,
        relation: Some(NavigateRelation::Reference),
        label: "Supporting context".into(),
        variant: ActionVariant::default(),
        icon: None,
        description: None,
        target_layer_id: Some(source_layer.id),
        interaction_text: None,
        reusable: None,
        input_action_ids: Vec::new(),
        input: None,
    };
    let action = writer.add_action(&draft).await.unwrap();
    assert_eq!(writer.add_action(&draft).await.unwrap().id, action.id);
    assert!(
        source_writer
            .get_layer(source_layer.id)
            .await
            .unwrap()
            .actions
            .is_empty()
    );
    let candidates = [source.id, reuse.id, interaction.id];
    assert!(
        database
            .attached_navigation_roots(&candidates)
            .await
            .unwrap()
            .is_empty(),
        "draft additions do not invalidate accepted roots"
    );
    let mut backlink = draft.clone();
    backlink.client_key = "response-link".into();
    backlink.target_layer_id = Some(response.id);
    writer.add_action(&backlink).await.unwrap();
    writer.complete(interaction.id).await.unwrap();
    // Preserve the post-acceptance revision check through a fresh authorized
    // editor: terminal authoring capabilities no longer expose presentations.
    let (inspector, _) = database
        .create_interaction_with_context(
            Some(project(1)),
            thread(4),
            "Inspect",
            &[InteractionContextDraft {
                target: InteractionContextTarget {
                    node_id: persistent.id,
                    source_interaction_node_id: source.id,
                    source_layer_id: source_layer.id,
                },
                annotations: vec![],
            }],
        )
        .await
        .unwrap();
    assert_eq!(
        database
            .writer_for_subgraph(inspector.id)
            .await
            .unwrap()
            .get_node_presentation(persistent.id)
            .await
            .unwrap()["revision"],
        0
    );

    let mut affected = database
        .attached_navigation_roots(&candidates)
        .await
        .unwrap();
    affected.sort();
    let mut expected = vec![source.id, reuse.id];
    expected.sort();
    assert_eq!(
        affected, expected,
        "only roots containing accepted mutated occurrences refresh"
    );
    database
        .set_interaction_permissions_enabled(false)
        .await
        .unwrap();
    assert_eq!(
        database
            .attached_navigation_roots(&[source.id])
            .await
            .unwrap(),
        vec![source.id],
        "historical mutation remains authoritative with gate off"
    );
    for owner in [source.id, reuse.id, interaction.id] {
        assert!(
            database
                .accepted_graph_closure(owner)
                .await
                .unwrap()
                .unwrap()
                .has_persistent_mutations,
            "add-only mutation must prevent portable export of original, reused, and mutating closures"
        );
    }
    assert_eq!(
        reuse_writer.get_layer(reused.id).await.unwrap().actions[0].id,
        action.id
    );
    let updated = source_writer.get_layer(source_layer.id).await.unwrap();
    assert_eq!(updated.actions.len(), 2);
    assert_eq!(updated.actions[0].id, action.id);
    assert_eq!(updated.nodes[0].authored_detail, None);
    assert_eq!(updated.nodes[0].title, persistent.title);
    assert!(
        writer.get_node_presentation(persistent.id).await.is_err(),
        "terminal authoring capabilities cannot reread mutation presentations"
    );
}

#[tokio::test]
async fn attached_navigation_concurrent_replacements_preserve_controls_and_reopen_occurrences() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("attached.sqlite");
    let database = GraphDatabase::open(&path).await.unwrap();
    database
        .set_temporal_features(TemporalFeatureConfig {
            schema_read: true,
            root_current_write: true,
            ..TemporalFeatureConfig::default()
        })
        .await
        .unwrap();
    database
        .set_interaction_permissions_enabled(true)
        .await
        .unwrap();
    let source = database
        .create_interaction(Some(project(1)), thread(1), "Source")
        .await
        .unwrap();
    let source_writer = database.writer_for_subgraph(source.id).await.unwrap();
    let persistent = node(&source_writer, "persistent").await;
    let source_layer = single_node_layer(&source_writer, "source-layer", &persistent).await;
    let original = source_writer
        .add_action(&ActionDraft {
            client_key: "original".into(),
            source_node_id: persistent.id,
            source_layer_id: Some(source_layer.id),
            kind: ActionKind::Invoke,
            relation: None,
            label: "Existing control".into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: Some("Existing action".into()),
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .unwrap();
    root_expand(&source_writer, &source, &source_layer).await;
    source_writer.complete(source.id).await.unwrap();
    let reuse = database
        .create_interaction(Some(project(1)), thread(2), "Reuse")
        .await
        .unwrap();
    let reuse_writer = database.writer_for_subgraph(reuse.id).await.unwrap();
    let reused = single_node_layer(&reuse_writer, "reused", &persistent).await;
    root_expand(&reuse_writer, &reuse, &reused).await;
    reuse_writer.complete(reuse.id).await.unwrap();
    let mut edits = Vec::new();
    for index in 3..=5 {
        let (interaction, _) = database
            .create_interaction_with_context(
                Some(project(1)),
                thread(index),
                "Extend",
                &[InteractionContextDraft {
                    target: InteractionContextTarget {
                        node_id: persistent.id,
                        source_interaction_node_id: reuse.id,
                        source_layer_id: reused.id,
                    },
                    annotations: vec!["Add navigation".into()],
                }],
            )
            .await
            .unwrap();
        let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
        let answer = node(&writer, "answer").await;
        let response = single_node_layer(&writer, "response", &answer).await;
        root_expand(&writer, &interaction, &response).await;
        let action = writer
            .add_action(&ActionDraft {
                client_key: format!("addition-{index}"),
                source_node_id: persistent.id,
                source_layer_id: Some(reused.id),
                kind: ActionKind::Navigate,
                relation: Some(NavigateRelation::Expand),
                label: format!("Expansion {index}"),
                variant: ActionVariant::default(),
                icon: None,
                description: None,
                target_layer_id: Some(response.id),
                interaction_text: None,
                reusable: None,
                input_action_ids: Vec::new(),
                input: None,
            })
            .await
            .unwrap();
        let package = presentation_with_actions(&persistent, &[original.clone(), action.clone()]);
        let mut fake = package.clone();
        fake["components"][0]["html"] = format!(
            "<!-- {} -->",
            fake["components"][0]["html"].as_str().unwrap()
        )
        .into();
        fake.as_object_mut().unwrap().remove("integritySha256");
        {
            use sha2::{Digest, Sha256};
            fake["integritySha256"] =
                format!("{:x}", Sha256::digest(serde_json::to_vec(&fake).unwrap())).into();
        }
        assert!(
            writer
                .stage_node_presentation(persistent.id, 0, &fake, &[])
                .await
                .is_err()
        );
        for invalid in ["cross-component-duplicate", "incompatible-host"] {
            let mut malformed = package.clone();
            if invalid == "cross-component-duplicate" {
                malformed["components"]
                    .as_array_mut()
                    .unwrap()
                    .push(serde_json::json!({
                        "id": "other", "order": 1, "css": "",
                        "html": "<button data-gc-mount=\"control-0\">Duplicate</button>"
                    }));
            } else {
                malformed["components"][0]["html"] = package["components"][0]["html"]
                    .as_str()
                    .unwrap()
                    .replace("button", "textarea")
                    .into();
                for mount in malformed["mounts"].as_array_mut().unwrap() {
                    mount["host"] = "textarea".into();
                }
            }
            malformed.as_object_mut().unwrap().remove("integritySha256");
            {
                use sha2::{Digest, Sha256};
                malformed["integritySha256"] = format!(
                    "{:x}",
                    Sha256::digest(serde_json::to_vec(&malformed).unwrap())
                )
                .into();
            }
            assert!(
                writer
                    .stage_node_presentation(persistent.id, 0, &malformed, &[])
                    .await
                    .is_err(),
                "{invalid} must fail before publication"
            );
        }
        writer
            .stage_node_presentation(persistent.id, 0, &package, &[])
            .await
            .unwrap();
        assert_eq!(
            writer
                .interaction_input()
                .await
                .unwrap()
                .completion_contract_status,
            "sealed"
        );
        writer
            .transition_current(
                0,
                "advance-staged-presentation",
                CurrentTransition::Advance {
                    layer_id: response.id,
                },
            )
            .await
            .unwrap();
        assert!(writer.completion_output().await.unwrap().is_none());
        edits.push((interaction, writer, action, response));
    }
    edits[0].1.complete(edits[0].0.id).await.unwrap();
    assert!(matches!(
        edits[1].1.complete(edits[1].0.id).await,
        Err(GraphError::Validation {
            code: "stale_presentation_revision",
            ..
        })
    ));
    assert_eq!(
        edits[1]
            .1
            .get_layer(edits[1].3.id)
            .await
            .unwrap()
            .layer
            .state,
        RecordState::Accepted
    );
    let retained = edits[1].1.current_completion().await.unwrap();
    assert_eq!(retained.lifecycle, CompletionLifecycle::Active);
    assert_eq!(retained.current_layer_id, Some(edits[1].3.id));
    let current = edits[1]
        .1
        .get_node_presentation(persistent.id)
        .await
        .unwrap();
    assert_eq!(current["revision"], 1);
    let missing_old = presentation_with_actions(&persistent, &[edits[1].2.clone()]);
    assert!(
        edits[1]
            .1
            .stage_node_presentation(persistent.id, 1, &missing_old, &[])
            .await
            .is_err()
    );
    let reread_actions: Vec<GraphAction> =
        serde_json::from_value(current["actions"].clone()).unwrap();
    assert_eq!(
        reread_actions
            .iter()
            .map(|action| action.id)
            .collect::<std::collections::HashSet<_>>(),
        [original.id, edits[0].2.id, edits[1].2.id]
            .into_iter()
            .collect(),
        "reread includes accepted and caller drafts, but not a concurrent caller's draft"
    );
    let mut package = presentation_with_actions(&persistent, &reread_actions);
    let asset = PreparedDetailAsset {
        asset_id: "diagram".into(),
        digest_sha256: "a9ce00f55032b62526a3abfc5aa6019874beff5d18c90607d663840d14ed11f9".into(),
        media_type: "image/png".into(),
        byte_length: 13,
        provenance_source: "user".into(),
        provenance_file_name: "diagram.png".into(),
        content: b"trusted asset".to_vec(),
    };
    package["assets"] = serde_json::json!([{"id":asset.asset_id,"digestSha256":asset.digest_sha256,"mediaType":asset.media_type,"representation":"image"}]);
    package["mounts"].as_array_mut().unwrap().push(serde_json::json!({"id":"diagram-mount","componentId":"main","kind":"asset","host":"img","assetId":"diagram"}));
    package["components"][0]["html"] = format!(
        "{}<img data-asset-mount=\"diagram-mount\">",
        package["components"][0]["html"].as_str().unwrap()
    )
    .into();
    package.as_object_mut().unwrap().remove("integritySha256");
    {
        use sha2::{Digest, Sha256};
        package["integritySha256"] = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&package).unwrap())
        )
        .into();
    }
    assert!(
        edits[1]
            .1
            .stage_node_presentation(persistent.id, 1, &package, &[])
            .await
            .is_err()
    );
    edits[1]
        .1
        .stage_node_presentation(persistent.id, 1, &package, &[asset])
        .await
        .unwrap();
    let fixture = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&path)
                .foreign_keys(true),
        )
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM pending_node_presentations")
            .fetch_one(&fixture)
            .await
            .unwrap(),
        2,
        "accepted staging is consumed while stale repair drafts survive"
    );
    sqlx::query(&format!("CREATE TRIGGER reject_attached_completion BEFORE INSERT ON completions WHEN NEW.interaction_node_id={} BEGIN SELECT RAISE(ABORT, 'forced attached completion failure'); END",edits[1].0.id.value())).execute(&fixture).await.unwrap();
    assert!(edits[1].1.complete(edits[1].0.id).await.is_err());
    let unchanged = source_writer.get_layer(source_layer.id).await.unwrap();
    assert_eq!(unchanged.actions.len(), 2);
    assert_eq!(
        unchanged.nodes[0].authored_detail.as_ref(),
        current["node"].get("authoredDetail")
    );
    assert!(
        database
            .accepted_detail_asset(persistent.id, "diagram")
            .await
            .is_err()
    );
    assert_eq!(
        edits[1]
            .1
            .get_node_presentation(persistent.id)
            .await
            .unwrap()["revision"],
        1
    );
    assert_eq!(
        edits[1]
            .1
            .get_layer(edits[1].3.id)
            .await
            .unwrap()
            .layer
            .state,
        RecordState::Accepted
    );
    sqlx::query("DROP TRIGGER reject_attached_completion")
        .execute(&fixture)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM pending_node_presentations")
            .fetch_one(&fixture)
            .await
            .unwrap(),
        2,
        "rollback preserves repair payloads"
    );
    edits[1].1.complete(edits[1].0.id).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM pending_node_presentations")
            .fetch_one(&fixture)
            .await
            .unwrap(),
        1
    );
    edits[2]
        .1
        .transition_current(
            1,
            "stop",
            CurrentTransition::Stop {
                reason: "cancelled_by_user".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM pending_node_presentations")
            .fetch_one(&fixture)
            .await
            .unwrap(),
        0,
        "terminal stop releases unpublished staging"
    );
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM attached_navigation_actions m JOIN actions a ON a.id=m.action_id WHERE a.state='accepted'")
        .fetch_one(&fixture).await.unwrap(), 2, "accepted lightweight mutation provenance survives cleanup");
    fixture.close().await;
    let reopened = GraphDatabase::open(&path).await.unwrap();
    let mut affected = reopened
        .attached_navigation_roots(&[source.id, reuse.id, edits[0].0.id])
        .await
        .unwrap();
    affected.sort();
    let mut expected = vec![source.id, reuse.id];
    expected.sort();
    assert_eq!(
        affected, expected,
        "reopen selects both mutated root occurrences, not unrelated response roots"
    );

    assert_eq!(
        reopened
            .accepted_detail_asset(persistent.id, "diagram")
            .await
            .unwrap()
            .content,
        b"trusted asset"
    );
    for (interaction, layer) in [(source.id, source_layer.id), (reuse.id, reused.id)] {
        let view = reopened
            .writer_for_subgraph(interaction)
            .await
            .unwrap()
            .get_layer(layer)
            .await
            .unwrap();
        assert_eq!(view.actions.len(), 3);
        assert!(
            view.actions
                .iter()
                .any(|a| a.id == original.id && a.kind == ActionKind::Invoke)
        );
        assert_eq!(view.nodes[0].authored_detail, Some(package.clone()));
        assert_eq!(view.nodes[0].detail, persistent.detail);
        assert!(
            reopened
                .accepted_graph_closure(interaction)
                .await
                .unwrap()
                .unwrap()
                .has_persistent_mutations
        );
    }
    // A second accepted replacement can reclaim the bytes named by a captured
    // package. Both deferred reads must signal retry, never read the new asset
    // under the old package pin or report a missing old asset.
    let captured = reopened
        .accepted_graph_closures(&[source.id, reuse.id])
        .await
        .unwrap();
    let captured_revision = captured[0]
        .as_ref()
        .unwrap()
        .detail_asset_revisions
        .as_ref()
        .unwrap()[&persistent.id];
    let metadata = reopened
        .accepted_detail_asset_metadata_at_revision(
            persistent.id,
            "diagram",
            Some(captured_revision),
        )
        .await
        .unwrap();
    let (replacement, _) = reopened
        .create_interaction_with_context(
            Some(project(1)),
            thread(6),
            "Replace image",
            &[InteractionContextDraft {
                target: InteractionContextTarget {
                    node_id: persistent.id,
                    source_interaction_node_id: source.id,
                    source_layer_id: source_layer.id,
                },
                annotations: vec!["Add image navigation".into()],
            }],
        )
        .await
        .unwrap();
    let replacement_writer = reopened.writer_for_subgraph(replacement.id).await.unwrap();
    let answer = node(&replacement_writer, "new-image-answer").await;
    let response = single_node_layer(&replacement_writer, "new-image-layer", &answer).await;
    root_expand(&replacement_writer, &replacement, &response).await;
    replacement_writer
        .add_action(&ActionDraft {
            client_key: "new-image-link".into(),
            source_node_id: persistent.id,
            source_layer_id: Some(source_layer.id),
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Reference),
            label: "New image".into(),
            variant: ActionVariant::Pill,
            icon: None,
            description: None,
            target_layer_id: Some(response.id),
            interaction_text: None,
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .unwrap();
    let presentation = replacement_writer
        .get_node_presentation(persistent.id)
        .await
        .unwrap();
    let actions: Vec<GraphAction> =
        serde_json::from_value(presentation["actions"].clone()).unwrap();
    let mut replacement_package = presentation_with_actions(&persistent, &actions);
    let bytes = b"replacement asset";
    let digest = {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(bytes))
    };
    let replacement_asset = PreparedDetailAsset {
        asset_id: "diagram".into(),
        digest_sha256: digest.clone(),
        media_type: "image/png".into(),
        byte_length: bytes.len(),
        provenance_source: "user".into(),
        provenance_file_name: "replacement.png".into(),
        content: bytes.to_vec(),
    };
    replacement_package["assets"] = serde_json::json!([{"id":"diagram","digestSha256":digest,"mediaType":"image/png","representation":"image"}]);
    replacement_package["mounts"].as_array_mut().unwrap().push(serde_json::json!({"id":"diagram-mount","componentId":"main","kind":"asset","host":"img","assetId":"diagram"}));
    replacement_package["components"][0]["html"] = format!(
        "{}<img data-asset-mount=\"diagram-mount\">",
        replacement_package["components"][0]["html"]
            .as_str()
            .unwrap()
    )
    .into();
    replacement_package
        .as_object_mut()
        .unwrap()
        .remove("integritySha256");
    {
        use sha2::{Digest, Sha256};
        replacement_package["integritySha256"] = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&replacement_package).unwrap())
        )
        .into();
    }
    replacement_writer
        .stage_node_presentation(
            persistent.id,
            captured_revision,
            &replacement_package,
            &[replacement_asset],
        )
        .await
        .unwrap();
    replacement_writer.complete(replacement.id).await.unwrap();
    for result in [
        reopened
            .accepted_detail_asset_metadata_at_revision(
                persistent.id,
                "diagram",
                Some(captured_revision),
            )
            .await
            .map(|_| ()),
        reopened
            .accepted_detail_asset_at_revision(persistent.id, "diagram", Some(captured_revision))
            .await
            .map(|_| ()),
    ] {
        assert!(
            matches!(
                result,
                Err(GraphError::Validation {
                    code: "asset_snapshot_changed",
                    ..
                })
            ),
            "{result:?}"
        );
    }
    let fresh = reopened
        .accepted_graph_closures(&[source.id, reuse.id])
        .await
        .unwrap();
    let fresh_revision = fresh[0]
        .as_ref()
        .unwrap()
        .detail_asset_revisions
        .as_ref()
        .unwrap()[&persistent.id];
    let fresh_asset = reopened
        .accepted_detail_asset_at_revision(persistent.id, "diagram", Some(fresh_revision))
        .await
        .unwrap();
    assert_eq!(fresh_asset.content, bytes);
    assert_ne!(fresh_asset.digest_sha256, metadata.digest_sha256);
    assert_eq!(
        fresh[1]
            .as_ref()
            .unwrap()
            .detail_asset_revisions
            .as_ref()
            .unwrap()[&persistent.id],
        fresh_revision
    );
    let imported_fixture = sqlx::SqlitePool::connect(&format!("sqlite://{}", path.display()))
        .await
        .unwrap();
    sqlx::query("INSERT INTO graph_imports(import_id,source_sha256,project_id,thread_id,created_at) VALUES ('imported-boundary','fixture',1,2,'1')").execute(&imported_fixture).await.unwrap();
    assert!(
        reopened
            .attached_navigation_roots(&[reuse.id])
            .await
            .unwrap()
            .is_empty(),
        "imported roots never gain native refresh authority"
    );
    imported_fixture.close().await;
}

fn presentation_with_actions(node: &GraphNode, actions: &[GraphAction]) -> serde_json::Value {
    use sha2::{Digest, Sha256};
    let mut mounts = Vec::new();
    let mut html = String::new();
    for (index, action) in actions.iter().enumerate() {
        let id = format!("control-{index}");
        html.push_str(&format!("<button data-gc-mount=\"{id}\">Open</button>"));
        let kind = match action.kind {
            ActionKind::Invoke => "invoke",
            ActionKind::Input => "input",
            _ => {
                if action.relation == Some(NavigateRelation::Expand) {
                    "expand"
                } else {
                    "reference"
                }
            }
        };
        mounts.push(serde_json::json!({"id":id,"componentId":"main","host":"button","kind":"capability","capability":{"kind":kind,"action":{"clientKey":action.client_key,"sourceNode":{"id":node.id},"sourceLayer":{"id":action.source_layer_id}}}}));
    }
    let mut package = serde_json::json!({"version":1,"assets":[],"components":[{"id":"main","order":0,"css":"","html":html}],"mounts":mounts});
    package["integritySha256"] = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&package).unwrap())
    )
    .into();
    package
}

#[tokio::test]
async fn attached_navigation_advance_is_inert_and_terminal_cycles_are_atomic() {
    let database = GraphDatabase::in_memory().await.unwrap();
    database
        .set_temporal_features(TemporalFeatureConfig {
            schema_read: true,
            root_current_write: true,
            ..TemporalFeatureConfig::default()
        })
        .await
        .unwrap();
    database
        .set_interaction_permissions_enabled(true)
        .await
        .unwrap();
    let source = database
        .create_interaction(Some(project(1)), thread(1), "Source")
        .await
        .unwrap();
    let sw = database.writer_for_subgraph(source.id).await.unwrap();
    let persistent = node(&sw, "persistent").await;
    let original = single_node_layer(&sw, "original", &persistent).await;
    root_expand(&sw, &source, &original).await;
    sw.complete(source.id).await.unwrap();
    let (interaction, _) = database
        .create_interaction_with_context(
            Some(project(1)),
            thread(2),
            "Extend",
            &[InteractionContextDraft {
                target: InteractionContextTarget {
                    node_id: persistent.id,
                    source_interaction_node_id: source.id,
                    source_layer_id: original.id,
                },
                annotations: vec!["Extend".into()],
            }],
        )
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let response = single_node_layer(&writer, "response", &persistent).await;
    let mut draft = ActionDraft {
        client_key: "cycle".into(),
        source_node_id: persistent.id,
        source_layer_id: None,
        kind: ActionKind::Navigate,
        relation: Some(NavigateRelation::Expand),
        label: "Expand".into(),
        variant: ActionVariant::default(),
        icon: None,
        description: None,
        target_layer_id: Some(original.id),
        interaction_text: None,
        reusable: None,
        input_action_ids: Vec::new(),
        input: None,
    };
    let addition = writer.add_action(&draft).await.unwrap();
    root_expand(&writer, &interaction, &response).await;
    assert!(matches!(
        writer
            .transition_current(
                0,
                "advance",
                CurrentTransition::Advance {
                    layer_id: response.id,
                },
            )
            .await,
        Err(GraphError::Validation {
            code: "attached_response_navigation_required",
            ..
        })
    ));
    assert!(
        writer
            .get_layer(response.id)
            .await
            .unwrap()
            .actions
            .is_empty()
    );
    root_expand(&writer, &interaction, &response).await;
    let mut backlink = draft.clone();
    backlink.client_key = "required-response-link".into();
    backlink.relation = Some(NavigateRelation::Reference);
    backlink.target_layer_id = Some(response.id);
    writer.add_action(&backlink).await.unwrap();
    assert!(matches!(
        writer.complete(interaction.id).await,
        Err(GraphError::Validation {
            code: "expand_cycle",
            ..
        })
    ));
    assert!(sw.get_layer(original.id).await.unwrap().actions.is_empty());
    draft.relation = Some(NavigateRelation::Reference);
    assert_eq!(writer.add_action(&draft).await.unwrap().id, addition.id);
    writer
        .transition_current(
            0,
            "advance-repaired",
            CurrentTransition::Advance {
                layer_id: response.id,
            },
        )
        .await
        .unwrap();
    assert!(sw.get_layer(original.id).await.unwrap().actions.is_empty());
    assert!(
        writer
            .get_layer(response.id)
            .await
            .unwrap()
            .actions
            .is_empty()
    );
    // Returning an already published current must still validate new detached targets.
    let a = node(&writer, "detached-a").await;
    let b = node(&writer, "detached-b").await;
    let a_layer = single_node_layer(&writer, "detached-a-layer", &a).await;
    let b_layer = single_node_layer(&writer, "detached-b-layer", &b).await;
    let mut attached = draft.clone();
    attached.client_key = "detached-entry".into();
    attached.relation = Some(NavigateRelation::Expand);
    attached.target_layer_id = Some(a_layer.id);
    writer.add_action(&attached).await.unwrap();
    let mut internal = attached.clone();
    internal.client_key = "a-to-b".into();
    internal.source_node_id = a.id;
    internal.source_layer_id = Some(a_layer.id);
    internal.target_layer_id = Some(b_layer.id);
    writer.add_action(&internal).await.unwrap();
    internal.client_key = "b-to-a".into();
    internal.source_node_id = b.id;
    internal.source_layer_id = Some(b_layer.id);
    internal.target_layer_id = Some(a_layer.id);
    writer.add_action(&internal).await.unwrap();
    assert!(matches!(
        writer.complete(interaction.id).await,
        Err(GraphError::Validation {
            code: "expand_cycle",
            ..
        })
    ));
    assert_eq!(
        writer.get_layer(a_layer.id).await.unwrap().layer.state,
        RecordState::Draft
    );
    assert!(sw.get_layer(original.id).await.unwrap().actions.is_empty());
    internal.relation = Some(NavigateRelation::Reference);
    internal.target_layer_id = Some(original.id);
    writer.add_action(&internal).await.unwrap();
    writer.complete(interaction.id).await.unwrap();
    assert_eq!(
        sw.get_layer(original.id).await.unwrap().actions[0].id,
        addition.id
    );
    assert_eq!(
        writer.get_layer(response.id).await.unwrap().actions[0].id,
        addition.id
    );
}

#[tokio::test]
async fn attached_navigation_reference_targets_keep_reference_authoring_restrictions() {
    for advance_first in [false, true] {
        let database = GraphDatabase::in_memory().await.unwrap();
        database
            .set_temporal_features(TemporalFeatureConfig {
                schema_read: true,
                root_current_write: true,
                ..TemporalFeatureConfig::default()
            })
            .await
            .unwrap();
        database
            .set_interaction_permissions_enabled(true)
            .await
            .unwrap();
        let source = database
            .create_interaction(Some(project(1)), thread(1), "Source")
            .await
            .unwrap();
        let source_writer = database.writer_for_subgraph(source.id).await.unwrap();
        let persistent = node(&source_writer, "persistent").await;
        let original = single_node_layer(&source_writer, "original", &persistent).await;
        root_expand(&source_writer, &source, &original).await;
        source_writer.complete(source.id).await.unwrap();
        let (interaction, _) = database
            .create_interaction_with_context(
                Some(project(1)),
                thread(2),
                "Reference",
                &[InteractionContextDraft {
                    target: InteractionContextTarget {
                        node_id: persistent.id,
                        source_interaction_node_id: source.id,
                        source_layer_id: original.id,
                    },
                    annotations: vec![],
                }],
            )
            .await
            .unwrap();
        let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
        let answer = node(&writer, "answer").await;
        let response = single_node_layer(&writer, "response", &answer).await;
        root_expand(&writer, &interaction, &response).await;
        let evidence = node(&writer, "evidence").await;
        let target = single_node_layer(&writer, "target", &evidence).await;
        let mut addition = ActionDraft {
            client_key: "attached-reference".into(),
            source_node_id: persistent.id,
            source_layer_id: None,
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Reference),
            label: "Reference".into(),
            variant: Default::default(),
            icon: None,
            description: None,
            target_layer_id: Some(target.id),
            interaction_text: None,
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        };
        let mut control = ActionDraft {
            client_key: "evidence-control".into(),
            source_node_id: evidence.id,
            source_layer_id: Some(target.id),
            kind: ActionKind::Invoke,
            relation: None,
            label: "Investigate".into(),
            variant: Default::default(),
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: Some("Investigate".into()),
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        };
        writer.add_action(&control).await.unwrap();
        writer.add_action(&addition).await.unwrap();
        assert!(matches!(
            writer.complete(interaction.id).await,
            Err(GraphError::Validation {
                code: "reference_layer_authoring_restricted",
                ..
            })
        ));
        control.kind = ActionKind::Navigate;
        control.relation = Some(NavigateRelation::Reference);
        control.target_layer_id = Some(original.id);
        control.interaction_text = None;
        writer.add_action(&control).await.unwrap();
        writer
            .add_action(&ActionDraft {
                client_key: "response-expansion".into(),
                source_node_id: answer.id,
                source_layer_id: Some(response.id),
                kind: ActionKind::Navigate,
                relation: Some(NavigateRelation::Expand),
                label: "Evidence".into(),
                variant: Default::default(),
                icon: None,
                description: None,
                target_layer_id: Some(target.id),
                interaction_text: None,
                reusable: None,
                input_action_ids: Vec::new(),
                input: None,
            })
            .await
            .unwrap();
        // Two actual non-root arrivals still cannot disagree about relation.
        assert!(matches!(
            writer.complete(interaction.id).await,
            Err(GraphError::Validation {
                code: "mixed_target_relations",
                ..
            })
        ));
        addition.target_layer_id = Some(response.id);
        writer.add_action(&addition).await.unwrap();
        writer
            .add_action(&ActionDraft {
                client_key: "response-control-after-backlink".into(),
                source_node_id: answer.id,
                source_layer_id: Some(response.id),
                kind: ActionKind::Invoke,
                relation: None,
                label: "Investigate response".into(),
                variant: Default::default(),
                icon: None,
                description: None,
                target_layer_id: None,
                interaction_text: Some("Investigate response".into()),
                reusable: None,
                input_action_ids: Vec::new(),
                input: None,
            })
            .await
            .expect("a backlink to the established response root does not make it reference-only");
        if advance_first {
            writer
                .transition_current(
                    0,
                    "advance",
                    CurrentTransition::Advance {
                        layer_id: response.id,
                    },
                )
                .await
                .unwrap();
        }
        assert!(
            source_writer
                .get_layer(original.id)
                .await
                .unwrap()
                .actions
                .is_empty()
        );
        // A backlink to this completion's response does not redefine its authoring role.
        writer.complete(interaction.id).await.unwrap();
        let published = source_writer.get_layer(original.id).await.unwrap();
        assert_eq!(published.actions.len(), 1);
        assert_eq!(published.actions[0].target_layer_id, Some(response.id));
        assert_eq!(
            published.actions[0].relation,
            Some(NavigateRelation::Reference)
        );
        assert_eq!(
            writer.get_layer(response.id).await.unwrap().layer.state,
            RecordState::Accepted
        );
    }
}

#[tokio::test]
async fn required_attached_navigation_rejects_response_only_then_repairs_after_reopen() {
    for advance in [false, true] {
        let file = tempfile::NamedTempFile::new().unwrap();
        let database = GraphDatabase::open(file.path()).await.unwrap();
        database
            .set_interaction_permissions_enabled(true)
            .await
            .unwrap();
        database
            .set_temporal_features(TemporalFeatureConfig {
                schema_read: true,
                root_current_write: true,
                ..TemporalFeatureConfig::default()
            })
            .await
            .unwrap();
        let source = database
            .create_interaction(Some(project(1)), thread(1), "Sky")
            .await
            .unwrap();
        let sw = database.writer_for_subgraph(source.id).await.unwrap();
        let persistent = node(&sw, "sky").await;
        let original = single_node_layer(&sw, "sky-layer", &persistent).await;
        root_expand(&sw, &source, &original).await;
        sw.complete(source.id).await.unwrap();
        let (interaction, _) = database
            .create_interaction_with_context(
                Some(project(1)),
                thread(2),
                "Rayleigh?",
                &[InteractionContextDraft {
                    target: InteractionContextTarget {
                        node_id: persistent.id,
                        source_interaction_node_id: source.id,
                        source_layer_id: original.id,
                    },
                    annotations: vec!["I thought this had something to do with Rayleigh".into()],
                }],
            )
            .await
            .unwrap();
        let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
        let delivered = serde_json::to_value(writer.interaction_input().await.unwrap()).unwrap();
        assert_eq!(delivered["completionContractStatus"], "sealed");
        assert_eq!(
            delivered["completionContract"]["returnRequirements"][0]["kind"],
            "navigate.response"
        );
        assert_eq!(delivered["interactionPermissions"]["version"], "2");
        assert_eq!(
            delivered["interactionPermissions"]["permissions"][0]["nodeId"],
            persistent.id.value()
        );
        let answer = node(&writer, "rayleigh").await;
        let response = single_node_layer(&writer, "response", &answer).await;
        root_expand(&writer, &interaction, &response).await;
        if advance {
            assert!(matches!(
                writer
                    .transition_current(
                        0,
                        "advance",
                        CurrentTransition::Advance {
                            layer_id: response.id,
                        },
                    )
                    .await,
                Err(GraphError::Validation {
                    code: "attached_response_navigation_required",
                    ..
                })
            ));
        }
        let error = writer.complete(interaction.id).await.unwrap_err();
        assert!(
            matches!(
                &error,
                GraphError::Validation {
                    code: "attached_response_navigation_required",
                    ..
                }
            ),
            "{error:?}"
        );
        assert!(error.to_string().contains(&persistent.id.to_string()));
        assert!(writer.completion_output().await.unwrap().is_none());
        assert!(sw.get_layer(original.id).await.unwrap().actions.is_empty());
        assert_eq!(
            writer.get_layer(response.id).await.unwrap().layer.state,
            RecordState::Draft
        );
        drop(writer);
        drop(sw);
        database.close().await;
        let database = GraphDatabase::open(file.path()).await.unwrap();
        // Changing the process gate cannot erase the frozen acceptance obligation.
        database
            .set_interaction_permissions_enabled(false)
            .await
            .unwrap();
        let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
        let mut action = ActionDraft {
            client_key: "response-link".into(),
            source_node_id: persistent.id,
            source_layer_id: None,
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Reference),
            label: "Rayleigh explanation".into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: Some(original.id),
            interaction_text: None,
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        };
        let wrong = writer.add_action(&action).await.unwrap();
        assert!(matches!(
            writer.complete(interaction.id).await,
            Err(GraphError::Validation {
                code: "attached_response_navigation_required",
                ..
            })
        ));
        action.target_layer_id = Some(response.id);
        assert_eq!(writer.add_action(&action).await.unwrap().id, wrong.id);
        if advance {
            writer
                .transition_current(
                    0,
                    "advance-repaired",
                    CurrentTransition::Advance {
                        layer_id: response.id,
                    },
                )
                .await
                .unwrap();
            assert!(
                database
                    .writer_for_subgraph(source.id)
                    .await
                    .unwrap()
                    .get_layer(original.id)
                    .await
                    .unwrap()
                    .actions
                    .is_empty()
            );
        }
        writer.complete(interaction.id).await.unwrap();
        let sw = database.writer_for_subgraph(source.id).await.unwrap();
        let visible = sw.get_layer(original.id).await.unwrap();
        assert_eq!(visible.actions.len(), 1);
        assert_eq!(visible.actions[0].target_layer_id, Some(response.id));
    }
}

#[tokio::test]
async fn required_attached_navigation_covers_distinct_nodes_and_rich_controls() {
    let database = GraphDatabase::in_memory().await.unwrap();
    database
        .set_interaction_permissions_enabled(true)
        .await
        .unwrap();
    let source = database
        .create_interaction(Some(project(1)), thread(1), "Sources")
        .await
        .unwrap();
    let sw = database.writer_for_subgraph(source.id).await.unwrap();
    let plain = node(&sw, "plain").await;
    let rich = node(&sw, "rich").await;
    let package = presentation_with_actions(&rich, &[]);
    sw.submit_node_with_authored_detail(
        &NodeDraft {
            client_key: "rich".into(),
            kind: "concept".into(),
            icon: "box".into(),
            title: "rich".into(),
            detail: "detail rich".into(),
        },
        Some(&package),
    )
    .await
    .unwrap();
    let edge = sw
        .create_edge(&EdgeDraft {
            client_key: "sources".into(),
            endpoints: [plain.id, rich.id],
        })
        .await
        .unwrap();
    let original = sw
        .submit_layer(&LayerDraft {
            client_key: "sources".into(),
            nodes: vec![plain.id, rich.id],
            edges: vec![edge.id],
            layout: authored_layout([plain.id, rich.id]),
            size_justification: None,
            default_node_id: None,
        })
        .await
        .unwrap();
    root_expand(&sw, &source, &original).await;
    sw.complete(source.id).await.unwrap();
    let reuse = database
        .create_interaction(Some(project(1)), thread(2), "Reuse")
        .await
        .unwrap();
    let rw = database.writer_for_subgraph(reuse.id).await.unwrap();
    let reused = single_node_layer(&rw, "reused", &plain).await;
    root_expand(&rw, &reuse, &reused).await;
    rw.complete(reuse.id).await.unwrap();
    let contexts = [
        (plain.id, source.id, original.id),
        (rich.id, source.id, original.id),
        (plain.id, reuse.id, reused.id),
    ]
    .map(
        |(node_id, source_interaction_node_id, source_layer_id)| InteractionContextDraft {
            target: InteractionContextTarget {
                node_id,
                source_interaction_node_id,
                source_layer_id,
            },
            annotations: vec![],
        },
    );
    let duplicate = database
        .create_interaction_with_context(Some(project(1)), thread(3), "Explain", &contexts)
        .await
        .unwrap_err();
    assert!(matches!(
        duplicate,
        GraphError::Validation {
            code: "duplicate_context_target",
            ..
        }
    ));
    let (interaction, _) = database
        .create_interaction_with_context(Some(project(1)), thread(3), "Explain", &contexts[..2])
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let answer = node(&writer, "answer").await;
    let response = single_node_layer(&writer, "response", &answer).await;
    root_expand(&writer, &interaction, &response).await;
    let mut draft = ActionDraft {
        client_key: "response".into(),
        source_node_id: plain.id,
        source_layer_id: Some(original.id),
        kind: ActionKind::Navigate,
        relation: Some(NavigateRelation::Reference),
        label: "Response".into(),
        variant: Default::default(),
        icon: None,
        description: None,
        target_layer_id: Some(response.id),
        interaction_text: None,
        reusable: None,
        input_action_ids: Vec::new(),
        input: None,
    };
    writer.add_action(&draft).await.unwrap();
    let error = writer.complete(interaction.id).await.unwrap_err();
    assert!(matches!(
        &error,
        GraphError::Validation {
            code: "attached_response_navigation_required",
            ..
        }
    ));
    assert!(
        error.to_string().contains(&format!("[{}]", rich.id)),
        "{error}"
    );
    draft.source_node_id = rich.id;
    let addition = writer.add_action(&draft).await.unwrap();
    assert!(matches!(
        writer.complete(interaction.id).await,
        Err(GraphError::Validation {
            code: "attached_action_binding_required",
            ..
        })
    ));
    assert!(sw.get_layer(original.id).await.unwrap().actions.is_empty());
    assert_eq!(
        writer.get_layer(response.id).await.unwrap().layer.state,
        RecordState::Draft
    );
    writer
        .stage_node_presentation(
            rich.id,
            0,
            &presentation_with_actions(&rich, &[addition]),
            &[],
        )
        .await
        .unwrap();
    writer.complete(interaction.id).await.unwrap();
    let visible = sw.get_layer(original.id).await.unwrap();
    assert_eq!(
        visible.actions.len(),
        2,
        "one new action per persistent source, across reused occurrences"
    );
    assert_eq!(rw.get_layer(reused.id).await.unwrap().actions.len(), 1);
}

#[tokio::test]
async fn required_attached_navigation_preserves_old_and_disabled_preparations() {
    for version in ["1", "disabled", "absent"] {
        let file = tempfile::NamedTempFile::new().unwrap();
        let database = GraphDatabase::open(file.path()).await.unwrap();
        let source = database
            .create_interaction(Some(project(1)), thread(1), "Source")
            .await
            .unwrap();
        let sw = database.writer_for_subgraph(source.id).await.unwrap();
        let persistent = node(&sw, "source").await;
        let original = single_node_layer(&sw, "source", &persistent).await;
        root_expand(&sw, &source, &original).await;
        sw.complete(source.id).await.unwrap();
        database
            .set_interaction_permissions_enabled(version != "disabled")
            .await
            .unwrap();
        let (interaction, _) = database
            .create_interaction_with_context(
                Some(project(1)),
                thread(2),
                "Legacy",
                &[InteractionContextDraft {
                    target: InteractionContextTarget {
                        node_id: persistent.id,
                        source_interaction_node_id: source.id,
                        source_layer_id: original.id,
                    },
                    annotations: vec![],
                }],
            )
            .await
            .unwrap();
        // Storage fixture recreates an old frozen preparation; public callers cannot rewrite it.
        let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}", file.path().display()))
            .await
            .unwrap();
        emulate_legacy_contract(&pool, interaction.id).await;
        if version == "1" {
            sqlx::query("DROP TRIGGER interaction_permissions_immutable")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query(
                "UPDATE interaction_permissions SET description=?1 WHERE interaction_node_id=?2",
            )
            .bind(
                serde_json::to_string(&InteractionPermissions::V1 {
                    enabled: true,
                    permissions: vec![InteractionPermission::NavigateAdd {
                        node_id: persistent.id,
                    }],
                })
                .unwrap(),
            )
            .bind(interaction.id.value())
            .execute(&pool)
            .await
            .unwrap();
        } else if version == "absent" {
            sqlx::query("DROP TRIGGER interaction_permissions_no_delete")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM interaction_permissions WHERE interaction_node_id=?1")
                .bind(interaction.id.value())
                .execute(&pool)
                .await
                .unwrap();
        }
        pool.close().await;
        drop(sw);
        database.close().await;
        let database = GraphDatabase::open(file.path()).await.unwrap();
        database
            .set_interaction_permissions_enabled(true)
            .await
            .unwrap();
        let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
        let answer = node(&writer, "answer").await;
        let response = single_node_layer(&writer, "response", &answer).await;
        root_expand(&writer, &interaction, &response).await;
        writer.complete(interaction.id).await.unwrap();
        assert!(
            database
                .writer_for_subgraph(source.id)
                .await
                .unwrap()
                .get_layer(original.id)
                .await
                .unwrap()
                .actions
                .is_empty()
        );
    }
}

#[tokio::test]
async fn attached_navigation_review_cycles_follow_exposed_and_prospective_actions() {
    for route in ["unexposed", "exposed", "prospective"] {
        let file = tempfile::NamedTempFile::new().unwrap();
        let database = GraphDatabase::open(file.path()).await.unwrap();
        database
            .set_interaction_permissions_enabled(true)
            .await
            .unwrap();
        let source = database
            .create_interaction(Some(project(1)), thread(1), "Source")
            .await
            .unwrap();
        let sw = database.writer_for_subgraph(source.id).await.unwrap();
        let a = node(&sw, "a").await;
        let b = node(&sw, "b").await;
        let al = single_node_layer(&sw, "a-layer", &a).await;
        let bl = single_node_layer(&sw, "b-layer", &b).await;
        root_expand(&sw, &source, &bl).await;
        let mut edge = ActionDraft {
            client_key: "old-b-to-a".into(),
            source_node_id: b.id,
            source_layer_id: Some(bl.id),
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Expand),
            label: "Open A".into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: Some(al.id),
            interaction_text: None,
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        };
        sw.add_action(&edge).await.unwrap();
        sw.complete(source.id).await.unwrap();
        let reuse = database
            .create_interaction(Some(project(1)), thread(2), "Reuse B")
            .await
            .unwrap();
        let rw = database.writer_for_subgraph(reuse.id).await.unwrap();
        let reused = single_node_layer(&rw, "reuse-b", &b).await;
        root_expand(&rw, &reuse, &reused).await;
        rw.complete(reuse.id).await.unwrap();
        // Historical accepted occurrences retain their own published action inventory.
        let fixture = sqlx::SqlitePool::connect(&format!("sqlite:{}", file.path().display()))
            .await
            .unwrap();
        sqlx::query("DELETE FROM layer_actions WHERE layer_id=?1")
            .bind(reused.id.value())
            .execute(&fixture)
            .await
            .unwrap();
        fixture.close().await;
        assert!(rw.get_layer(reused.id).await.unwrap().actions.is_empty());
        let contexts = [(&a, &al), (&b, &bl)].map(|(n, l)| InteractionContextDraft {
            target: InteractionContextTarget {
                node_id: n.id,
                source_interaction_node_id: source.id,
                source_layer_id: l.id,
            },
            annotations: vec![],
        });
        let (edit, _) = database
            .create_interaction_with_context(Some(project(1)), thread(3), "Extend", &contexts)
            .await
            .unwrap();
        let writer = database.writer_for_subgraph(edit.id).await.unwrap();
        let answer = node(&writer, "answer").await;
        let response = single_node_layer(&writer, "response", &answer).await;
        root_expand(&writer, &edit, &response).await;
        for n in [&a, &b] {
            edge.client_key = "response".into();
            edge.source_node_id = n.id;
            edge.source_layer_id = None;
            edge.relation = Some(NavigateRelation::Reference);
            edge.target_layer_id = Some(response.id);
            writer.add_action(&edge).await.unwrap();
        }
        edge.client_key = "a-to-b".into();
        edge.source_node_id = a.id;
        edge.relation = Some(NavigateRelation::Expand);
        edge.target_layer_id = Some(if route == "exposed" { bl.id } else { reused.id });
        writer.add_action(&edge).await.unwrap();
        if route == "prospective" {
            edge.client_key = "new-b-to-a".into();
            edge.source_node_id = b.id;
            edge.target_layer_id = Some(al.id);
            writer.add_action(&edge).await.unwrap();
        }
        let result = writer.complete(edit.id).await;
        if route == "unexposed" {
            result.unwrap();
        } else {
            assert!(
                matches!(
                    result,
                    Err(GraphError::Validation {
                        code: "expand_cycle",
                        ..
                    })
                ),
                "{route}: {result:?}"
            );
            assert!(rw.get_layer(reused.id).await.unwrap().actions.is_empty());
            assert_eq!(
                writer.get_layer(response.id).await.unwrap().layer.state,
                RecordState::Draft
            );
        }
    }
}

#[tokio::test]
async fn attached_navigation_review_identity_releases_only_terminal_unpublished_drafts() {
    for terminal in ["stop", "fail", "accept"] {
        let database = GraphDatabase::in_memory().await.unwrap();
        database
            .set_temporal_features(TemporalFeatureConfig {
                schema_read: true,
                root_current_write: true,
                ..TemporalFeatureConfig::default()
            })
            .await
            .unwrap();
        database
            .set_interaction_permissions_enabled(true)
            .await
            .unwrap();
        let source = database
            .create_interaction(Some(project(1)), thread(1), "Source")
            .await
            .unwrap();
        let sw = database.writer_for_subgraph(source.id).await.unwrap();
        let persistent = node(&sw, "persistent").await;
        let original = single_node_layer(&sw, "original", &persistent).await;
        root_expand(&sw, &source, &original).await;
        sw.complete(source.id).await.unwrap();
        let mut edits = Vec::new();
        for index in 2..=3 {
            let (edit, _) = database
                .create_interaction_with_context(
                    Some(project(1)),
                    thread(index),
                    "Extend",
                    &[InteractionContextDraft {
                        target: InteractionContextTarget {
                            node_id: persistent.id,
                            source_interaction_node_id: source.id,
                            source_layer_id: original.id,
                        },
                        annotations: vec![],
                    }],
                )
                .await
                .unwrap();
            let writer = database.writer_for_subgraph(edit.id).await.unwrap();
            let answer = node(&writer, "answer").await;
            let response = single_node_layer(&writer, "response", &answer).await;
            root_expand(&writer, &edit, &response).await;
            let action = ActionDraft {
                client_key: "stable".into(),
                source_node_id: persistent.id,
                source_layer_id: None,
                kind: ActionKind::Navigate,
                relation: Some(NavigateRelation::Reference),
                label: "Response".into(),
                variant: ActionVariant::default(),
                icon: None,
                description: None,
                target_layer_id: Some(response.id),
                interaction_text: None,
                reusable: None,
                input_action_ids: Vec::new(),
                input: None,
            };
            edits.push((edit, writer, action));
        }
        edits[0].1.add_action(&edits[0].2).await.unwrap();
        assert!(matches!(
            edits[1].1.add_action(&edits[1].2).await,
            Err(GraphError::Validation {
                code: "action_identity_conflict",
                ..
            })
        ));
        if terminal == "accept" {
            edits[0].1.complete(edits[0].0.id).await.unwrap();
        } else {
            let transition = if terminal == "stop" {
                CurrentTransition::Stop {
                    reason: "cancelled_by_user".into(),
                }
            } else {
                CurrentTransition::Fail {
                    reason: "provider_start_failed".into(),
                }
            };
            edits[0]
                .1
                .transition_current(0, "terminal", transition)
                .await
                .unwrap();
        }
        let result = edits[1].1.add_action(&edits[1].2).await;
        if terminal == "accept" {
            assert!(matches!(
                result,
                Err(GraphError::Validation {
                    code: "action_identity_conflict",
                    ..
                })
            ));
        } else {
            result.unwrap();
            edits[1].1.complete(edits[1].0.id).await.unwrap();
        }
    }
}

#[tokio::test]
async fn image_icons_pin_registered_bytes_and_survive_detail_clear_and_reopen() {
    use sha2::{Digest, Sha256};
    let file = tempfile::NamedTempFile::new().unwrap();
    let database = GraphDatabase::open(file.path()).await.unwrap();
    let interaction = database
        .create_interaction(None, thread(1), "Coral")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let content = b"registered coral bytes".to_vec();
    let asset = PreparedDetailAsset {
        asset_id: "coral".into(),
        digest_sha256: format!("{:x}", Sha256::digest(&content)),
        media_type: "image/png".into(),
        byte_length: content.len(),
        provenance_source: "user".into(),
        provenance_file_name: "coral.png".into(),
        content: content.clone(),
    };
    let draft: NodeDraft = serde_json::from_value(serde_json::json!({"clientKey":"coral","icon":{"kind":"image","assetId":"coral","digestSha256":asset.digest_sha256,"mediaType":asset.media_type},"title":"Coral","detail":"Marine coral"})).unwrap();
    assert!(writer.submit_node(&draft).await.is_err());
    let package_for = |asset: &PreparedDetailAsset| {
        let mut package = serde_json::json!({"version":1,"components":[{"id":"visual","order":0,"html":"<img data-gc-asset=\"mount\">","css":""}],"mounts":[{"id":"mount","componentId":"visual","kind":"asset","host":"img","assetId":asset.asset_id}],"assets":[{"id":asset.asset_id,"digestSha256":asset.digest_sha256,"mediaType":asset.media_type,"representation":"image"}]});
        package["integritySha256"] = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&package).unwrap())
        )
        .into();
        package
    };
    let package = package_for(&asset);
    let symbol_draft = NodeDraft {
        icon: "box".into(),
        ..draft.clone()
    };
    let prior = writer
        .submit_node_with_prepared_visual_assets(
            &symbol_draft,
            AuthoredDetailUpdate::Replace(&package),
            Some(std::slice::from_ref(&asset)),
            None,
        )
        .await
        .unwrap();
    let mut conflicting = asset.clone();
    conflicting.content = b"different registered bytes".to_vec();
    conflicting.digest_sha256 = format!("{:x}", Sha256::digest(&conflicting.content));
    conflicting.byte_length = conflicting.content.len();
    let conflict_icon = serde_json::json!({"kind":"image","assetId":conflicting.asset_id,"digestSha256":conflicting.digest_sha256,"mediaType":conflicting.media_type}).to_string();
    let conflicting_draft = NodeDraft {
        icon: conflict_icon,
        ..draft.clone()
    };
    let error = writer
        .submit_node_with_prepared_visual_assets(
            &conflicting_draft,
            AuthoredDetailUpdate::Retain,
            None,
            Some(&conflicting),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(error, GraphError::Validation { code, .. } if code == "image_icon_content_conflict")
    );
    assert_eq!(
        writer.get_node(prior.id).await.unwrap().icon,
        "box",
        "failed icon pin preserves the last valid draft"
    );

    writer
        .submit_node_with_prepared_visual_assets(
            &draft,
            AuthoredDetailUpdate::Retain,
            None,
            Some(&asset),
        )
        .await
        .unwrap();
    let conflicting_package = package_for(&conflicting);
    let error = writer
        .submit_node_with_prepared_visual_assets(
            &draft,
            AuthoredDetailUpdate::Replace(&conflicting_package),
            Some(std::slice::from_ref(&conflicting)),
            Some(&asset),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(error, GraphError::Validation { code, .. } if code == "image_icon_content_conflict")
    );
    assert_eq!(
        writer
            .get_node(prior.id)
            .await
            .unwrap()
            .authored_detail
            .as_ref(),
        Some(&package),
        "failed Detail replacement preserves the matching prior package"
    );
    let node = writer
        .submit_node_with_prepared_visual_assets(
            &draft,
            AuthoredDetailUpdate::Clear,
            None,
            Some(&asset),
        )
        .await
        .unwrap();
    let source_layer = writer
        .submit_layer(&LayerDraft {
            client_key: "root".into(),
            default_node_id: None,
            nodes: vec![node.id],
            edges: vec![],
            layout: authored_layout([node.id]),
            size_justification: None,
        })
        .await
        .unwrap();
    let action = ActionDraft {
        client_key: "inspect-coral".into(),
        source_node_id: node.id,
        source_layer_id: Some(source_layer.id),
        kind: ActionKind::Invoke,
        relation: None,
        label: "Inspect coral".into(),
        variant: ActionVariant::Pill,
        icon: Some(draft.icon.clone()),
        description: None,
        target_layer_id: None,
        interaction_text: Some("Inspect coral".into()),
        reusable: None,
        input_action_ids: Vec::new(),
        input: None,
    };
    assert!(writer.add_action(&action).await.is_err());
    let symbol_action = ActionDraft {
        icon: None,
        ..action.clone()
    };
    assert!(
        writer
            .add_action_with_prepared_icon(&symbol_action, Some(&asset))
            .await
            .is_err()
    );
    let action_record = writer
        .add_action_with_prepared_icon(&action, Some(&asset))
        .await
        .unwrap();
    accept_single_node(&writer, interaction.clone(), node.clone()).await;
    assert_eq!(
        writer
            .accepted_detail_asset(node.id, "coral")
            .await
            .unwrap()
            .content,
        content
    );
    drop(writer);
    drop(database);
    let reopened = GraphDatabase::open(file.path()).await.unwrap();
    let reader = reopened.writer_for_subgraph(interaction.id).await.unwrap();
    assert_eq!(
        serde_json::to_value(reader.get_node(node.id).await.unwrap()).unwrap()["icon"]["assetId"],
        "coral"
    );
    assert_eq!(
        reader
            .accepted_detail_asset(node.id, "coral")
            .await
            .unwrap()
            .content,
        content
    );
    let reopened_action = reader
        .accepted_authored_action(action_record.id)
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(reopened_action).unwrap()["icon"]["fit"],
        serde_json::Value::Null
    );
    let closure = reopened
        .accepted_graph_closure(interaction.id)
        .await
        .unwrap()
        .unwrap();
    assert!(
        closure
            .detail_asset_revisions
            .as_ref()
            .unwrap()
            .contains_key(&interaction.id)
    );
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(SqliteConnectOptions::new().filename(file.path()))
        .await
        .unwrap();
    sqlx::query("UPDATE authored_detail_asset_contents SET content=?1 WHERE digest_sha256=?2")
        .bind(vec![0u8; content.len()])
        .bind(&asset.digest_sha256)
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        reader
            .accepted_detail_asset(node.id, "coral")
            .await
            .is_err()
    );
}

#[tokio::test]
async fn native_import_rejects_conflicting_or_missing_detail_icon_pin_inventory() {
    let package = serde_json::json!({
        "version":1,
        "components":[{"id":"overview","order":0,"html":"<section><img data-gc-asset=\"m_asset\"></section>","css":"section{display:grid}"}],
        "mounts":[{"id":"m_asset","componentId":"overview","kind":"asset","host":"img","assetId":"architecture-diagram"}],
        "assets":[{"id":"architecture-diagram","digestSha256":"a9ce00f55032b62526a3abfc5aa6019874beff5d18c90607d663840d14ed11f9","mediaType":"image/png","representation":"image"}],
        "integritySha256":"adf1296990ca1e4be5e4d90eb9f4a4fab14716a885efc524cc04018294fc17d1"
    });
    for (image_digest, expected_code) in [
        (Some("b".repeat(64)), "import_asset_pin_conflict"),
        (None, "import_detail_pin_missing"),
    ] {
        let database = GraphDatabase::in_memory().await.unwrap();
        let mut input = imported_conversation("interaction-1");
        let node = &mut input.turns[0].accepted_view.as_mut().unwrap().layers[0].nodes[0];
        node.authored_detail = Some(package.clone());
        let asset_id = if image_digest.is_some() {
            "architecture-diagram"
        } else {
            "coral"
        };
        let digest = image_digest.unwrap_or_else(|| "b".repeat(64));
        {
            node.icon = serde_json::to_string(&serde_json::json!({"kind":"image","assetId":asset_id,"digestSha256":digest,"mediaType":"image/png"})).unwrap();
            node.authored_detail_assets = vec![ImportedDetailAsset {
                asset_id: asset_id.into(),
                digest_sha256: digest,
                media_type: "image/png".into(),
                byte_length: 13,
                provenance_source: "user".into(),
                provenance_file_name: "diagram.png".into(),
            }];
        }
        let error = database
            .import_accepted_conversation(&input)
            .await
            .unwrap_err();
        assert!(
            matches!(error,GraphError::Validation{code,..} if code==expected_code),
            "{error}"
        );
    }
    // Legacy metadata-only Details intentionally preserve an unavailable-image
    // viewing fallback; this exception never applies to typed image icons.
    let database = GraphDatabase::in_memory().await.unwrap();
    let mut legacy = imported_conversation("interaction-1");
    legacy.turns[0].accepted_view.as_mut().unwrap().layers[0].nodes[0].authored_detail =
        Some(package.clone());
    let imported = database
        .import_accepted_conversation(&legacy)
        .await
        .unwrap();
    let node = &imported.turns[0].output.as_ref().unwrap().root_layer.nodes[0];
    assert_eq!(node.authored_detail.as_ref(), Some(&package));
    assert!(
        database
            .accepted_detail_asset(node.id, "architecture-diagram")
            .await
            .is_err()
    );
}

#[tokio::test]
async fn thread_icon_proposal_is_nonblocking_first_valid_and_accepted_only() {
    let database = GraphDatabase::in_memory().await.unwrap();
    let interaction = database
        .create_interaction(None, thread(501), "Topic")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    assert!(!writer.propose_thread_icon("🧭").await.unwrap());
    // Thread topics remain symbolic even though graph nodes support typed images.
    assert!(
        !writer
            .propose_thread_icon(r#"{"kind":"image","assetId":"coral"}"#)
            .await
            .unwrap()
    );
    assert!(writer.propose_thread_icon("Circle Alert").await.unwrap());
    assert!(writer.propose_thread_icon("compass").await.unwrap());
    assert!(writer.completion_output().await.unwrap().is_none());
    assert!(writer.complete(interaction.id).await.is_err());
    assert!(writer.completion_output().await.unwrap().is_none());
    let answer = node(&writer, "answer").await;
    let layer = single_node_layer(&writer, "response", &answer).await;
    root_expand(&writer, &interaction, &layer).await;
    let output = writer.complete(interaction.id).await.unwrap();
    assert_eq!(output.thread_icon_proposal.as_deref(), Some("alert-circle"));
    assert!(writer.propose_thread_icon("heart").await.is_err());
    assert_eq!(writer.completion_output().await.unwrap(), Some(output));

    let missing = database
        .create_interaction(None, thread(502), "Missing")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(missing.id).await.unwrap();
    assert!(!writer.propose_thread_icon("made-up-icon").await.unwrap());
    let answer = node(&writer, "answer").await;
    let layer = single_node_layer(&writer, "response", &answer).await;
    root_expand(&writer, &missing, &layer).await;
    assert_eq!(
        writer
            .complete(missing.id)
            .await
            .unwrap()
            .thread_icon_proposal,
        None
    );
}

#[tokio::test]
async fn thread_icon_proposal_survives_reopen_but_advance_and_stop_do_not_accept_it() {
    let temporary = tempfile::tempdir().unwrap();
    let file = tempfile::NamedTempFile::new_in(temporary.path()).unwrap();
    let database = GraphDatabase::open(file.path()).await.unwrap();
    let interaction = database
        .create_interaction(None, thread(503), "Topic")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    writer.propose_thread_icon("compass").await.unwrap();
    let answer = node(&writer, "answer").await;
    let layer = single_node_layer(&writer, "response", &answer).await;
    root_expand(&writer, &interaction, &layer).await;
    writer
        .transition_current(
            0,
            "advance",
            CurrentTransition::Advance { layer_id: layer.id },
        )
        .await
        .unwrap();
    assert!(writer.completion_output().await.unwrap().is_none());
    writer
        .transition_current(
            1,
            "return",
            CurrentTransition::Return { layer_id: layer.id },
        )
        .await
        .unwrap();
    drop(writer);
    database.close().await;
    let database = GraphDatabase::open(file.path()).await.unwrap();
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    assert_eq!(
        writer
            .completion_output()
            .await
            .unwrap()
            .unwrap()
            .thread_icon_proposal
            .as_deref(),
        Some("compass")
    );
    for (id, transition) in [
        (
            504,
            CurrentTransition::Stop {
                reason: "cancelled_by_user".into(),
            },
        ),
        (
            505,
            CurrentTransition::Fail {
                reason: "provider_crashed".into(),
            },
        ),
    ] {
        let terminal = database
            .create_interaction(None, thread(id), "Terminal")
            .await
            .unwrap();
        let writer = database.writer_for_subgraph(terminal.id).await.unwrap();
        writer.propose_thread_icon("brain").await.unwrap();
        writer
            .transition_current(0, "terminal", transition)
            .await
            .unwrap();
        assert!(writer.completion_output().await.unwrap().is_none());
        assert!(writer.propose_thread_icon("heart").await.is_err());
    }
}
