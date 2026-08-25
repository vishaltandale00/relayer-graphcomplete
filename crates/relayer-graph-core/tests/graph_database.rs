use relayer_graph_core::*;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

fn project(value: i64) -> ProjectId {
    ProjectId::new(value).unwrap()
}

fn thread(value: i64) -> ThreadId {
    ThreadId::new(value).unwrap()
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
    ))
}

async fn setup(project_id: Option<ProjectId>, thread_id: ThreadId) -> (GraphDatabase, GraphNode) {
    let database = GraphDatabase::in_memory().await.unwrap();
    let interaction = database
        .create_interaction(project_id, thread_id, "Explain the queue")
        .await
        .unwrap();
    (database, interaction)
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
            invoke_origin: None,
            accepted_view: Some(ImportedAcceptedView {
                interaction_node_id: interaction_node_id.into(),
                root_action: ImportedAction {
                    id: "action-1".into(),
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
                },
                root_layer_id: "layer-1".into(),
                layers: vec![ImportedResolvedLayer {
                    layer: ImportedLayer {
                        id: "layer-1".into(),
                        nodes: vec!["node-1".into()],
                        edges: vec![],
                        layout: Some(ImportedLayerLayout {
                            version: 1,
                            placements: vec![ImportedNodePlacement {
                                node_id: "node-1".into(),
                                x: 0.25,
                                y: 0.75,
                            }],
                        }),
                    },
                    nodes: vec![ImportedNode {
                        id: "node-1".into(),
                        kind: "concept".into(),
                        icon: "box".into(),
                        title: "Queue".into(),
                        detail: "A queue".into(),
                    }],
                    edges: vec![],
                    actions: vec![],
                }],
            }),
        }],
    }
}

fn imported_invoke_conversation() -> ImportedConversation {
    let source = ImportedTurn {
        source_turn_id: "turn-1".into(),
        text: "Choose a path".into(),
        invoke_origin: None,
        accepted_view: Some(ImportedAcceptedView {
            interaction_node_id: "interaction-1".into(),
            root_action: ImportedAction {
                id: "root-action-1".into(),
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
            },
            root_layer_id: "layer-1".into(),
            layers: vec![ImportedResolvedLayer {
                layer: ImportedLayer {
                    id: "layer-1".into(),
                    nodes: vec!["node-1".into()],
                    edges: vec![],
                    layout: None,
                },
                nodes: vec![ImportedNode {
                    id: "node-1".into(),
                    kind: "concept".into(),
                    icon: "box".into(),
                    title: "Path".into(),
                    detail: "Invoke this path".into(),
                }],
                edges: vec![],
                actions: vec![ImportedAction {
                    id: "invoke-action-1".into(),
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
                }],
            }],
        }),
    };
    let destination = ImportedTurn {
        source_turn_id: "turn-2".into(),
        text: "Continue this path".into(),
        invoke_origin: Some(ImportedInvokeOrigin {
            source_turn_id: "turn-1".into(),
            source_action_id: "invoke-action-1".into(),
        }),
        accepted_view: Some(ImportedAcceptedView {
            interaction_node_id: "interaction-2".into(),
            root_action: ImportedAction {
                id: "root-action-2".into(),
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
            },
            root_layer_id: "layer-2".into(),
            layers: vec![ImportedResolvedLayer {
                layer: ImportedLayer {
                    id: "layer-2".into(),
                    nodes: vec!["node-2".into()],
                    edges: vec![],
                    layout: None,
                },
                nodes: vec![ImportedNode {
                    id: "node-2".into(),
                    kind: "concept".into(),
                    icon: "box".into(),
                    title: "Destination".into(),
                    detail: "Imported result".into(),
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
    let input = imported_conversation("interaction-1");
    let receipt = database.import_accepted_conversation(&input).await.unwrap();
    let turn = &receipt.turns[0];
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
        })
        .await
        .unwrap();
    writer.complete(interaction.id).await.unwrap();
    layer
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
    ] {
        assert!(
            issues
                .iter()
                .any(|issue| issue.code == code && issue.path == path),
            "missing {code} at {path}: {issues:?}"
        );
    }
}

#[tokio::test]
async fn invalid_layout_retry_preserves_the_last_valid_draft() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let answer = node(&writer, "answer").await;
    let valid = writer
        .submit_layer(&LayerDraft {
            client_key: "root".into(),
            nodes: vec![answer.id],
            edges: vec![],
            layout: Some(LayerLayout::v1(vec![NodePlacement {
                node_id: answer.id,
                x: 0.25,
                y: 0.75,
            }])),
            size_justification: None,
        })
        .await
        .unwrap();
    let invalid = writer
        .submit_layer(&LayerDraft {
            client_key: "root".into(),
            nodes: vec![answer.id],
            edges: vec![],
            layout: Some(LayerLayout::v1(vec![NodePlacement {
                node_id: answer.id,
                x: 2.0,
                y: 0.5,
            }])),
            size_justification: None,
        })
        .await;
    assert!(invalid.is_err());

    let preserved = writer.get_layer(valid.id).await.unwrap();
    assert_eq!(preserved.layer.layout, valid.layout);
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
            client_key: "abandoned".into(),
            nodes: vec![abandoned_node.id],
            edges: vec![],
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
    let file = tempfile::NamedTempFile::new().unwrap();
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
async fn coordinate_free_accepted_history_remains_readable_after_restart() {
    use sqlx::{Connection, SqliteConnection};

    let file = tempfile::NamedTempFile::new().unwrap();
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
async fn different_threads_can_write_through_the_same_pool() {
    let file = tempfile::NamedTempFile::new().unwrap();
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
    let file = tempfile::NamedTempFile::new().unwrap();
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
    let file = tempfile::NamedTempFile::new().unwrap();
    let database = GraphDatabase::open(file.path()).await.unwrap();
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
    assert_eq!(resolved.kind, ActionKind::Invoke);
    assert_eq!(resolved.relation, None);
    assert_eq!(resolved.source_node_id, source_node.id);
    assert_eq!(resolved.source_layer_id, unresolved.source_layer_id);
    assert_eq!(resolved.label, unresolved.label);
    assert_eq!(resolved.variant, unresolved.variant);
    assert_eq!(resolved.icon, unresolved.icon);
    assert_eq!(resolved.description, unresolved.description);
    assert_eq!(resolved.interaction_text, unresolved.interaction_text);
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

    drop(writer);
    drop(first_writer);
    drop(second_writer);
    drop(reused_writer);
    database.close().await;
    let reopened = GraphDatabase::open(file.path()).await.unwrap();
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
    let file = tempfile::NamedTempFile::new().unwrap();
    let database = GraphDatabase::open(file.path()).await.unwrap();
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
