use relayer_graph_core::*;

fn thread() -> ThreadId {
    ThreadId::new(1).unwrap()
}

#[tokio::test]
async fn sealed_source_requires_keyed_durable_invocation_without_leased_conversion() {
    let database = GraphDatabase::in_memory().await.unwrap();
    let parent = database
        .create_interaction(None, thread(), "Delegate")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(parent.id).await.unwrap();
    let source = writer
        .submit_node(&NodeDraft {
            client_key: "task".into(),
            kind: "concept".into(),
            icon: "box".into(),
            title: "Task".into(),
            detail: "Task".into(),
        })
        .await
        .unwrap();
    let action = writer
        .add_action(&ActionDraft {
            client_key: "call".into(),
            source_node_id: source.id,
            source_layer_id: Some(
                writer
                    .submit_layer(&LayerDraft {
                        client_key: "task-layer".into(),
                        nodes: vec![source.id],
                        edges: vec![],
                        layout: Some(LayerLayout::v1(
                            vec![NodePlacement {
                                node_id: source.id,
                                x: 0.5,
                                y: 0.5,
                            }],
                            "default",
                        )),
                        size_justification: None,
                        default_node_id: None,
                    })
                    .await
                    .unwrap()
                    .id,
            ),
            kind: ActionKind::Invoke,
            relation: None,
            label: "Investigate".into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: Some("Investigate this task".into()),
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .unwrap();
    assert!(
        matches!(writer.prepare_recursive_completion(action.id).await,Err(GraphError::Validation {code:"invocation_key_required",path,..}) if path=="invocationKey")
    );
    assert!(
        writer
            .action_invocations(action.id)
            .await
            .unwrap()
            .is_empty()
    );
    let (child, invocation) = writer
        .prepare_recursive_invocation(action.id, "call-1")
        .await
        .unwrap();
    assert_eq!(child.leased_action_id, None);
    assert_eq!(invocation.parent_node_id, source.id);
    let contract = database
        .writer_for_subgraph(child.id)
        .await
        .unwrap()
        .interaction_input()
        .await
        .unwrap()
        .completion_contract
        .unwrap();
    assert_eq!(
        contract.input.invocation_references[0].invocation_id,
        invocation.id
    );
    assert_eq!(
        contract.input.invocation_references[0].parent_node_id,
        source.id
    );
    assert!(
        contract
            .authorities
            .iter()
            .all(|grant| !matches!(grant, InteractionPermission::InvokeResolve { .. }))
    );
    assert_eq!(
        invocation.action_snapshot["instruction"],
        "Investigate this task"
    );
}

#[tokio::test]
async fn trusted_preparation_seals_exact_input_and_recovery_keeps_original_policy() {
    let file = tempfile::NamedTempFile::new().unwrap();
    let database = GraphDatabase::open(file.path()).await.unwrap();
    let digest = interaction_input_digest("Explain", &[]).unwrap();
    let (node, _) = database
        .create_identified_interaction_with_context(
            None,
            thread(),
            "Explain",
            "stable-input",
            &digest,
            &[],
        )
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(node.id).await.unwrap();
    let input = writer.interaction_input().await.unwrap();
    let contract = input.completion_contract.unwrap();
    assert_eq!(input.completion_contract_status, "sealed");
    assert_eq!(contract.input.text, "Explain");
    assert_eq!(contract.interaction_node_id, node.id);
    contract.validate().unwrap();
    assert!(
        !serde_json::to_string(&contract)
            .unwrap()
            .contains("enabled")
    );
    database
        .set_interaction_permissions_enabled(true)
        .await
        .unwrap();
    let (recovered, _) = database
        .create_identified_interaction_with_context(
            None,
            thread(),
            "Explain",
            "stable-input",
            &digest,
            &[],
        )
        .await
        .unwrap();
    assert_eq!(recovered.id, node.id);
    assert_eq!(
        writer
            .interaction_input()
            .await
            .unwrap()
            .completion_contract
            .as_ref(),
        Some(&contract)
    );
    database.close().await;
    let reopened = GraphDatabase::open(file.path()).await.unwrap();
    assert_eq!(
        reopened
            .writer_for_subgraph(node.id)
            .await
            .unwrap()
            .interaction_input()
            .await
            .unwrap()
            .completion_contract,
        Some(contract)
    );
}

#[tokio::test]
async fn contract_storage_is_immutable_and_corruption_blocks_capability_activation() {
    for corruption in [
        "missing",
        "version",
        "missing-version",
        "digest",
        "unknown",
        "identity",
        "input",
    ] {
        let file = tempfile::NamedTempFile::new().unwrap();
        let database = GraphDatabase::open(file.path()).await.unwrap();
        let node = database
            .create_interaction(None, thread(), "Explain")
            .await
            .unwrap();
        let contract = database
            .writer_for_subgraph(node.id)
            .await
            .unwrap()
            .interaction_input()
            .await
            .unwrap()
            .completion_contract
            .unwrap();
        let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}", file.path().display()))
            .await
            .unwrap();
        assert!(
            sqlx::query("UPDATE completion_contracts SET description='{}'")
                .execute(&pool)
                .await
                .is_err()
        );
        assert!(
            sqlx::query("DELETE FROM completion_contracts")
                .execute(&pool)
                .await
                .is_err()
        );
        assert!(
            sqlx::query("UPDATE completion_states SET completion_contract_digest=NULL")
                .execute(&pool)
                .await
                .is_err()
        );
        sqlx::query("DROP TRIGGER completion_contract_update_guard")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DROP TRIGGER completion_contract_delete_guard")
            .execute(&pool)
            .await
            .unwrap();
        if corruption == "missing" {
            sqlx::query("DELETE FROM completion_contracts")
                .execute(&pool)
                .await
                .unwrap();
        } else {
            let mut value = serde_json::to_value(&contract).unwrap();
            match corruption {
                "version" => value["schemaVersion"] = 99.into(),
                "missing-version" => {
                    value.as_object_mut().unwrap().remove("schemaVersion");
                }
                "digest" => value["digest"] = "forged".into(),
                "unknown" => value["hiddenAuthority"] = true.into(),
                "identity" => {
                    value["interactionNodeId"] =
                        serde_json::to_value(NodeId::new(99).unwrap()).unwrap()
                }
                "input" => value["input"]["text"] = "forged".into(),
                _ => unreachable!(),
            }
            sqlx::query("UPDATE completion_contracts SET description=?1")
                .bind(value.to_string())
                .execute(&pool)
                .await
                .unwrap();
        }
        assert!(
            database
                .activate_completion_authority(node.id)
                .await
                .is_err(),
            "{corruption}"
        );
        assert!(
            database
                .writer_for_subgraph(node.id)
                .await
                .unwrap()
                .interaction_input()
                .await
                .is_err(),
            "{corruption}"
        );
    }
}

#[tokio::test]
async fn sealed_advance_requires_a_returnable_root_and_return_keeps_exact_current() {
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
        .create_interaction(None, thread(), "Explain")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let node = writer
        .submit_node(&NodeDraft {
            client_key: "answer".into(),
            kind: "concept".into(),
            icon: "box".into(),
            title: "Answer".into(),
            detail: "Answer".into(),
        })
        .await
        .unwrap();
    let layer = writer
        .submit_layer(&LayerDraft {
            client_key: "response".into(),
            nodes: vec![node.id],
            edges: vec![],
            layout: Some(LayerLayout::v1(
                vec![NodePlacement {
                    node_id: node.id,
                    x: 0.5,
                    y: 0.5,
                }],
                "default",
            )),
            size_justification: None,
            default_node_id: None,
        })
        .await
        .unwrap();
    assert!(matches!(
        writer
            .transition_current(
                0,
                "missing-root",
                CurrentTransition::Advance { layer_id: layer.id }
            )
            .await,
        Err(GraphError::Validation {
            code: "root_action_count",
            ..
        })
    ));
    assert_eq!(writer.current_completion().await.unwrap().head_revision, 0);
    assert_eq!(
        writer.get_layer(layer.id).await.unwrap().layer.state,
        RecordState::Draft
    );
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
    writer
        .transition_current(
            0,
            "advance",
            CurrentTransition::Advance { layer_id: layer.id },
        )
        .await
        .unwrap();
    assert!(writer.completion_output().await.unwrap().is_none());
    let current = writer.get_layer(layer.id).await.unwrap();
    let returned = writer
        .transition_current(
            1,
            "return",
            CurrentTransition::Return { layer_id: layer.id },
        )
        .await
        .unwrap();
    assert_eq!(returned.final_layer_id, Some(layer.id));
    assert_eq!(writer.get_layer(layer.id).await.unwrap(), current);
}
