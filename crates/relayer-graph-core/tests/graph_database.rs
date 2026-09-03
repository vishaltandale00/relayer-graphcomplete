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
                        }),
                    },
                    nodes: vec![ImportedNode {
                        id: "node-1".into(),
                        client_key: None,
                        kind: "concept".into(),
                        icon: "box".into(),
                        title: "Queue".into(),
                        detail: "A queue".into(),
                        authored_detail: None,
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
        interaction_node_id: None,
        invoke_origin: None,
        contexts: vec![],
        submitted_inputs: vec![],
        accepted_view: Some(ImportedAcceptedView {
            interaction_node_id: "interaction-1".into(),
            root_action: ImportedAction {
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
                    id: "layer-1".into(),
                    client_key: Some("authored-layer-1".into()),
                    nodes: vec!["node-1".into()],
                    edges: vec![],
                    layout: None,
                },
                nodes: vec![ImportedNode {
                    id: "node-1".into(),
                    client_key: Some("authored-node-1".into()),
                    kind: "concept".into(),
                    icon: "box".into(),
                    title: "Path".into(),
                    detail: "Invoke this path".into(),
                    authored_detail: None,
                }],
                edges: vec![],
                actions: vec![ImportedAction {
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
                    id: "layer-2".into(),
                    client_key: None,
                    nodes: vec!["node-2".into()],
                    edges: vec![],
                    layout: None,
                },
                nodes: vec![ImportedNode {
                    id: "node-2".into(),
                    client_key: None,
                    kind: "concept".into(),
                    icon: "box".into(),
                    title: "Destination".into(),
                    detail: "Imported result".into(),
                    authored_detail: None,
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
    });
    // Two input actions, both genuinely authored by node-1.
    for id in ["input-action-1", "input-action-2"] {
        resolved.actions.push(ImportedAction {
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
        ..honest.clone()
    };
    input.turns.push(ImportedTurn {
        source_turn_id: "turn-2".into(),
        text: "".into(),
        interaction_node_id: Some("input-root-2".into()),
        invoke_origin: None,
        contexts: vec![],
        submitted_inputs: vec![honest, forged],
        accepted_view: None,
    });

    let receipt = database.import_accepted_conversation(&input).await.unwrap();

    // The fabricated answer is dropped, and dropping it is visible rather than silent.
    assert_eq!(receipt.skipped_submitted_inputs.len(), 1);
    let skipped = &receipt.skipped_submitted_inputs[0];
    assert_eq!(skipped.submitted_input_id, "input-child-forged");
    assert_eq!(skipped.source_turn_id, "turn-2");
    assert_eq!(skipped.code, "input_option_unknown");
    assert_eq!(skipped.path, "submittedInputs[1].value");

    // The honest answer on the same turn still imports, and nothing the file claimed
    // about the fabricated option reached the projection.
    let root = NodeId::new(receipt.turns[1].graph_node_id.unwrap()).unwrap();
    let writer = database.writer_for_subgraph(root).await.unwrap();
    let projected = writer.interaction_input().await.unwrap();
    assert_eq!(
        projected.submitted_inputs,
        vec![SubmittedInput { action, value }]
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
            input: None,
        })
        .await
        .unwrap();
    writer.complete(interaction.id).await.unwrap();
    layer
}

#[tokio::test]
async fn personal_presentation_attachment_is_control_owned_one_shot_and_hidden_from_completion() {
    let file = tempfile::NamedTempFile::new().unwrap();
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
    let file = tempfile::NamedTempFile::new().unwrap();
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
    let file = tempfile::NamedTempFile::new().unwrap();
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
    let database = GraphDatabase::in_memory().await.unwrap();
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
    let writer = database.writer_for_subgraph(parent.id).await.unwrap();
    let source = node(&writer, "recursive-source").await;
    let current = single_node_layer(&writer, "recursive-current", &source).await;
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
    let database = GraphDatabase::in_memory().await.unwrap();
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
    let writer = database.writer_for_subgraph(parent.id).await.unwrap();
    let source = node(&writer, "gated-source").await;
    let current = single_node_layer(&writer, "gated-current", &source).await;
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
    let (database, presenting) = setup(Some(project(90)), thread(90)).await;
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
async fn accepted_authored_detail_survives_caller_mutation_and_database_reopen() {
    let file = tempfile::NamedTempFile::new().unwrap();
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
            "digestSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "mediaType": "image/png",
            "representation": "image"
        }],
        "integritySha256": "d9080b60296e82a0084b817742756b226fee981d41c37a7e27983a3bcb682b25"
    });
    let answer = writer
        .submit_node_with_authored_detail(
            &NodeDraft {
                client_key: "answer".into(),
                kind: "concept".into(),
                icon: "box".into(),
                title: "Architecture".into(),
                detail: "Legacy fallback".into(),
            },
            Some(&authored_detail),
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
