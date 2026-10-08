use relayer_graph_core::*;

async fn response(writer: &GraphWriter, interaction: NodeId, key: &str) -> (GraphNode, GraphLayer) {
    let node = writer
        .submit_node(&NodeDraft {
            client_key: format!("{key}-node"),
            kind: "concept".into(),
            icon: "search".into(),
            title: key.into(),
            detail: format!("Response for {key}"),
        })
        .await
        .unwrap();
    let layer = writer
        .submit_layer(&LayerDraft {
            default_node_id: Some(node.id),
            client_key: format!("{key}-layer"),
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
        })
        .await
        .unwrap();
    writer
        .add_action(&ActionDraft {
            client_key: "root-response".into(),
            source_node_id: interaction,
            source_layer_id: None,
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Expand),
            label: key.into(),
            variant: Default::default(),
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
    (node, layer)
}

#[tokio::test]
async fn portable_inventory_retains_stopped_and_failed_currents_without_staged_parent_effects() {
    let database = GraphDatabase::in_memory().await.unwrap();
    database
        .set_temporal_features(TemporalFeatureConfig {
            config_version: 1,
            schema_read: true,
            root_current_write: true,
            projection_ui: true,
            invoke_resolution: true,
            provider_recursion: true,
        })
        .await
        .unwrap();
    let parent = database
        .create_interaction(None, ThreadId::new(511).unwrap(), "Enclosing analysis")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(parent.id).await.unwrap();
    let (parent_node, parent_layer) = response(&writer, parent.id, "Parent").await;
    let invoke = writer
        .add_action(&callable(parent_node.id, parent_layer.id))
        .await
        .unwrap();
    let (stopped, _) = writer
        .prepare_recursive_invocation(invoke.id, "stopped")
        .await
        .unwrap();
    let (failed, _) = writer
        .prepare_recursive_invocation(invoke.id, "failed")
        .await
        .unwrap();
    writer
        .transition_current(
            0,
            "parent-return",
            CurrentTransition::Return {
                layer_id: parent_layer.id,
            },
        )
        .await
        .unwrap();
    for (child, stop) in [(stopped, true), (failed, false)] {
        let child_writer = database.writer_for_subgraph(child.id).await.unwrap();
        let (_, current) = response(
            &child_writer,
            child.id,
            if stop {
                "Stopped contribution"
            } else {
                "Failed contribution"
            },
        )
        .await;
        let mut link = callable(parent_node.id, parent_layer.id);
        link.client_key = if stop { "staged-stop" } else { "staged-fail" }.into();
        link.kind = ActionKind::Navigate;
        link.reusable = None;
        link.relation = Some(NavigateRelation::Reference);
        link.interaction_text = None;
        link.target_layer_id = Some(current.id);
        let staged = child_writer.add_action(&link).await.unwrap();
        child_writer
            .transition_current(
                0,
                "publish-current",
                CurrentTransition::Advance {
                    layer_id: current.id,
                },
            )
            .await
            .unwrap();
        child_writer
            .transition_current(
                1,
                "settle-attempt",
                if stop {
                    CurrentTransition::Stop {
                        reason: "cancelled_by_user".into(),
                    }
                } else {
                    CurrentTransition::Fail {
                        reason: "provider_timeout".into(),
                    }
                },
            )
            .await
            .unwrap();
        let snapshot = database
            .conversation_graph_snapshot(&[parent.id])
            .await
            .unwrap();
        let call = snapshot
            .invocations
            .iter()
            .find(|call| call.invocation.child_interaction_node_id == child.id)
            .unwrap();
        assert_eq!(
            call.invocation.state.lifecycle,
            if stop {
                CompletionLifecycle::Stopped
            } else {
                CompletionLifecycle::Failed
            }
        );
        assert_eq!(call.invocation.state.current_layer_id, Some(current.id));
        assert_eq!(call.invocation.state.final_layer_id, None);
        assert!(call.invocation.state.safe_reason.is_some());
        assert_eq!(call.current.as_ref().unwrap().root_layer_id, current.id);
        assert!(
            !snapshot
                .closures
                .iter()
                .flatten()
                .flat_map(|closure| &closure.layers)
                .flat_map(|layer| &layer.actions)
                .any(|action| action.id == staged.id)
        );
    }
}
fn callable(node: NodeId, layer: LayerId) -> ActionDraft {
    ActionDraft {
        client_key: "callable".into(),
        source_node_id: node,
        source_layer_id: Some(layer),
        kind: ActionKind::Invoke,
        relation: None,
        label: "Investigate".into(),
        variant: Default::default(),
        icon: None,
        description: None,
        target_layer_id: None,
        interaction_text: Some("Investigate the evidence".into()),
        reusable: Some(true),
        input_action_ids: Vec::new(),
        input: None,
    }
}

#[tokio::test]
async fn default_single_call_is_atomic_recoverable_and_survives_stop_and_reopen() {
    let file = tempfile::NamedTempFile::new().unwrap();
    let database = GraphDatabase::open(file.path()).await.unwrap();
    let parent = database
        .create_interaction(None, ThreadId::new(73).unwrap(), "Single call")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(parent.id).await.unwrap();
    let (node, layer) = response(&writer, parent.id, "Analysis").await;
    let mut wire = serde_json::json!({"clientKey":"single", "sourceNodeId":node.id, "sourceLayerId":layer.id,
        "kind":"invoke", "label":"Investigate", "targetLayerId":null, "interactionText":"Inspect evidence"});
    let draft: ActionDraft = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(draft.reusable, Some(false));
    let action = writer.add_action(&draft).await.unwrap();
    assert_eq!(action.reusable, Some(false));
    let (child, first) = writer
        .prepare_recursive_invocation(action.id, "one")
        .await
        .unwrap();
    assert_eq!(first.action_snapshot["reusable"], false);
    assert_eq!(
        writer
            .prepare_recursive_invocation(action.id, "one")
            .await
            .unwrap()
            .1
            .id,
        first.id
    );
    let error = writer
        .prepare_recursive_invocation(action.id, "another")
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        GraphError::Validation {
            code: "invoke_single_call_already_prepared",
            ..
        }
    ));
    database
        .writer_for_subgraph(child.id)
        .await
        .unwrap()
        .transition_current(
            0,
            "stop",
            CurrentTransition::Stop {
                reason: "cancelled_by_user".into(),
            },
        )
        .await
        .unwrap();
    writer
        .transition_current(
            0,
            "parent-return",
            CurrentTransition::Return { layer_id: layer.id },
        )
        .await
        .unwrap();
    let reopened = GraphDatabase::open(file.path()).await.unwrap();
    let trusted = reopened.writer_for_subgraph(parent.id).await.unwrap();
    assert_eq!(
        trusted
            .prepare_user_invocation(action.id, "one")
            .await
            .unwrap()
            .1
            .id,
        first.id
    );
    assert!(matches!(
        trusted
            .prepare_user_invocation(action.id, "new-user-call")
            .await
            .unwrap_err(),
        GraphError::Validation {
            code: "invoke_single_call_already_prepared",
            ..
        }
    ));
    assert_eq!(
        trusted.action_invocations(action.id).await.unwrap().len(),
        1
    );
    wire["reusable"] = serde_json::json!(true);
    assert_eq!(
        serde_json::from_value::<ActionDraft>(wire)
            .unwrap()
            .reusable,
        Some(true)
    );
}

#[tokio::test]
async fn user_invocation_arguments_are_validated_sealed_per_call_and_exactly_recovered() {
    let file = tempfile::NamedTempFile::new().unwrap();
    let database = GraphDatabase::open(file.path()).await.unwrap();
    let parent = database
        .create_interaction(None, ThreadId::new(73).unwrap(), "Choose a review topic")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(parent.id).await.unwrap();
    let (node, layer) = response(&writer, parent.id, "Analysis").await;
    let invoke = writer
        .add_action(&callable(node.id, layer.id))
        .await
        .unwrap();
    let question = InputAction {
        control: InputControl::Text,
        prompt: "Review topic".into(),
        options: vec![],
        minimum_selections: None,
        unsupported_fields: Default::default(),
    };
    let mut field = callable(node.id, layer.id);
    field.client_key = "review-topic".into();
    field.kind = ActionKind::Input;
    field.reusable = None;
    field.interaction_text = None;
    field.input = Some(question.clone());
    let field = writer.add_action(&field).await.unwrap();
    let mut bound = callable(node.id, layer.id);
    for invalid in [invoke.id, ActionId::new(999_999).unwrap()] {
        bound.input_action_ids = vec![invalid];
        assert!(writer.add_action(&bound).await.is_err());
    }
    bound.input_action_ids = vec![field.id, field.id];
    assert!(writer.add_action(&bound).await.is_err());
    bound.input_action_ids = vec![field.id];
    writer.add_action(&bound).await.unwrap();
    let mut shared = bound.clone();
    shared.client_key = "shared-input-consumer".into();
    let shared = writer.add_action(&shared).await.unwrap();
    let other = writer
        .submit_node(&NodeDraft {
            client_key: "other-input-node".into(),
            kind: "concept".into(),
            icon: "search".into(),
            title: "Other input".into(),
            detail: "Separate source Node".into(),
        })
        .await
        .unwrap();
    let mut cross_node = bound.clone();
    cross_node.client_key = "cross-node-binding".into();
    cross_node.source_node_id = other.id;
    assert!(writer.add_action(&cross_node).await.is_err());
    let mut unrelated = callable(node.id, layer.id);
    unrelated.client_key = "unrelated-input".into();
    unrelated.kind = ActionKind::Input;
    unrelated.reusable = None;
    unrelated.interaction_text = None;
    unrelated.input = Some(question.clone());
    let unrelated = writer.add_action(&unrelated).await.unwrap();
    let mut changed_field = callable(node.id, layer.id);
    changed_field.client_key = "review-topic".into();
    writer.add_action(&changed_field).await.unwrap();
    assert!(
        writer.complete(parent.id).await.is_err(),
        "Return must revalidate a repaired draft input's kind"
    );
    changed_field.kind = ActionKind::Input;
    changed_field.reusable = None;
    changed_field.interaction_text = None;
    changed_field.input = Some(question.clone());
    assert_eq!(
        writer.add_action(&changed_field).await.unwrap().id,
        field.id
    );
    writer.complete(parent.id).await.unwrap();
    let accepted_invoke = writer
        .get_layer(layer.id)
        .await
        .unwrap()
        .actions
        .into_iter()
        .find(|action| action.id == invoke.id)
        .unwrap();
    let mut argument = SubmittedInputDraft {
        occurrence: PresentingInputOccurrence {
            presenting_interaction_node_id: parent.id,
            presenting_layer_id: layer.id,
            action_id: field.id,
        },
        action: question,
        value: SubmittedInputValue::Text {
            text: "Latency".into(),
        },
    };
    let mut forged = argument.clone();
    assert!(
        writer
            .prepare_user_invocation(invoke.id, "missing-input")
            .await
            .is_err()
    );
    assert!(
        writer
            .prepare_recursive_invocation(invoke.id, "missing-recursive-input")
            .await
            .is_err()
    );
    assert!(
        writer
            .prepare_user_invocation_with_inputs(
                invoke.id,
                "duplicate-input",
                &[argument.clone(), argument.clone()]
            )
            .await
            .is_err()
    );
    assert_eq!(accepted_invoke.input_action_ids, vec![field.id]);
    let mut extra = argument.clone();
    extra.occurrence.action_id = unrelated.id;
    assert!(
        writer
            .prepare_user_invocation_with_inputs(
                invoke.id,
                "extra-input",
                &[argument.clone(), extra]
            )
            .await
            .is_err()
    );
    forged.action.prompt = "Forged question".into();
    assert!(
        writer
            .prepare_user_invocation_with_inputs(invoke.id, "forged-call", &[forged])
            .await
            .is_err()
    );
    assert!(
        writer
            .action_invocations(invoke.id)
            .await
            .unwrap()
            .is_empty()
    );
    let (child, first) = writer
        .prepare_user_invocation_with_inputs(invoke.id, "topic-call", &[argument.clone()])
        .await
        .unwrap();
    let (_, recovered) = writer
        .prepare_user_invocation_with_inputs(invoke.id, "topic-call", &[argument.clone()])
        .await
        .unwrap();
    assert_eq!(first.id, recovered.id);
    let contract = database
        .writer_for_subgraph(child.id)
        .await
        .unwrap()
        .interaction_input()
        .await
        .unwrap()
        .completion_contract
        .unwrap();
    assert_eq!(contract.input.answers.len(), 1);
    assert_eq!(contract.input.answers[0].source_action_id, field.id);
    assert_eq!(contract.input.answers[0].value, argument.value);
    let (shared_child, _) = writer
        .prepare_user_invocation_with_inputs(shared.id, "shared-input-call", &[argument.clone()])
        .await
        .unwrap();
    assert_ne!(shared_child.id, child.id);
    argument.value = SubmittedInputValue::Text {
        text: "Reliability".into(),
    };
    assert!(matches!(
        writer
            .prepare_user_invocation_with_inputs(invoke.id, "topic-call", &[argument.clone()])
            .await,
        Err(GraphError::Validation {
            code: "invocation_key_conflict",
            ..
        })
    ));
    let (second_child, second) = writer
        .prepare_user_invocation_with_inputs(invoke.id, "second-topic-call", &[argument])
        .await
        .unwrap();
    assert_ne!(first.id, second.id);
    assert_ne!(child.id, second_child.id);
    assert_eq!(
        writer
            .get_layer(layer.id)
            .await
            .unwrap()
            .actions
            .iter()
            .find(|action| action.id == invoke.id)
            .unwrap(),
        &accepted_invoke
    );
    drop(writer);
    drop(database);
    let reopened = GraphDatabase::open(file.path()).await.unwrap();
    let writer = reopened.writer_for_subgraph(parent.id).await.unwrap();
    assert_eq!(
        writer
            .get_layer(layer.id)
            .await
            .unwrap()
            .actions
            .iter()
            .find(|action| action.id == invoke.id)
            .unwrap()
            .input_action_ids,
        vec![field.id]
    );
}

#[tokio::test]
async fn invocation_listing_hides_foreign_draft_until_advance_accepts_the_source() {
    let database = GraphDatabase::in_memory().await.unwrap();
    database
        .set_temporal_features(TemporalFeatureConfig {
            config_version: 1,
            schema_read: true,
            root_current_write: true,
            projection_ui: true,
            invoke_resolution: true,
            provider_recursion: true,
        })
        .await
        .unwrap();
    let project = Some(ProjectId::new(71).unwrap());
    let owner = database
        .create_interaction(project, ThreadId::new(71).unwrap(), "Own private work")
        .await
        .unwrap();
    let reader = database
        .create_interaction(project, ThreadId::new(72).unwrap(), "Read published work")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(owner.id).await.unwrap();
    let other = database.writer_for_subgraph(reader.id).await.unwrap();
    let (node, layer) = response(&writer, owner.id, "Private").await;
    let action = writer
        .add_action(&callable(node.id, layer.id))
        .await
        .unwrap();
    writer
        .prepare_recursive_invocation(action.id, "private-call")
        .await
        .unwrap();
    assert_eq!(writer.action_invocations(action.id).await.unwrap().len(), 1);
    assert!(matches!(
        other.action_invocations(action.id).await,
        Err(GraphError::Forbidden(_))
    ));
    writer
        .transition_current(
            0,
            "publish-source",
            CurrentTransition::Advance { layer_id: layer.id },
        )
        .await
        .unwrap();
    let visible = other.action_invocations(action.id).await.unwrap();
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0].source_action_id, action.id);
}

#[tokio::test]
async fn distinct_calls_seal_source_node_and_return_independently_after_parent() {
    let file = tempfile::NamedTempFile::new().unwrap();
    let database = GraphDatabase::open(file.path()).await.unwrap();
    database
        .set_temporal_features(TemporalFeatureConfig {
            config_version: 1,
            schema_read: true,
            root_current_write: true,
            projection_ui: true,
            invoke_resolution: true,
            provider_recursion: true,
        })
        .await
        .unwrap();
    let parent = database
        .create_interaction(None, ThreadId::new(51).unwrap(), "Compare investigations")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(parent.id).await.unwrap();
    let (node, layer) = response(&writer, parent.id, "Parent").await;
    let action = writer
        .add_action(&callable(node.id, layer.id))
        .await
        .unwrap();
    assert!(matches!(
        writer.prepare_recursive_completion(action.id).await,
        Err(GraphError::Validation {
            code: "invocation_key_required",
            ..
        })
    ));
    let (child_a, call_a) = writer
        .prepare_recursive_invocation(action.id, "call-a")
        .await
        .unwrap();
    let (child_b, call_b) = writer
        .prepare_recursive_invocation(action.id, "call-b")
        .await
        .unwrap();
    assert_ne!(call_a.id, call_b.id);
    assert_ne!(child_a.id, child_b.id);
    assert_eq!(call_a.parent_node_id, node.id);
    assert_eq!(call_a.source_completion_id, parent.id);
    let (same, receipt) = writer
        .prepare_recursive_invocation(action.id, "call-a")
        .await
        .unwrap();
    assert_eq!(same.id, child_a.id);
    assert_eq!(receipt.id, call_a.id);
    assert_eq!(child_a.leased_action_id, None);
    let child_writer = database.writer_for_subgraph(child_a.id).await.unwrap();
    let contract = child_writer
        .interaction_input()
        .await
        .unwrap()
        .completion_contract
        .unwrap();
    assert_eq!(
        contract.input.invocation_references[0].parent_node_id,
        node.id
    );
    assert_eq!(
        contract.input.invocation_references[0].source_action_id,
        action.id
    );
    assert!(
        contract
            .authorities
            .contains(&InteractionPermission::NavigateAdd { node_id: node.id })
    );
    assert_eq!(
        contract.return_requirements,
        vec![CompletionReturnRequirement::NavigateResponse { node_id: node.id }]
    );
    let (_, returned) = response(&child_writer, child_a.id, "Revised overall analysis A").await;
    assert!(matches!(
        child_writer
            .transition_current(
                0,
                "unpublished-parent",
                CurrentTransition::Return {
                    layer_id: returned.id
                }
            )
            .await,
        Err(GraphError::Validation {
            code: "invocation_parent_unpublished",
            ..
        })
    ));
    writer
        .transition_current(
            0,
            "parent-return",
            CurrentTransition::Return { layer_id: layer.id },
        )
        .await
        .unwrap();
    assert_eq!(
        database
            .durable_invocation(child_a.id)
            .await
            .unwrap()
            .unwrap()
            .state
            .lifecycle,
        CompletionLifecycle::Active
    );
    assert!(matches!(
        child_writer
            .transition_current(
                0,
                "missing-integration",
                CurrentTransition::Return {
                    layer_id: returned.id
                }
            )
            .await,
        Err(GraphError::Validation {
            code: "attached_response_navigation_required",
            ..
        })
    ));
    let mut integration = callable(node.id, layer.id);
    integration.client_key = "revised-analysis-a".into();
    integration.kind = ActionKind::Navigate;
    integration.reusable = None;
    integration.relation = Some(NavigateRelation::Reference);
    integration.interaction_text = None;
    integration.target_layer_id = Some(returned.id);
    let link_a = child_writer.add_action(&integration).await.unwrap();
    child_writer
        .transition_current(
            0,
            "child-current",
            CurrentTransition::Advance {
                layer_id: returned.id,
            },
        )
        .await
        .unwrap();
    let portable = database
        .conversation_graph_snapshot(&[parent.id])
        .await
        .unwrap();
    assert_eq!(portable.invocations.len(), 2);
    let call_current = portable
        .invocations
        .iter()
        .find(|snapshot| snapshot.invocation.id == call_a.id)
        .unwrap();
    assert_eq!(
        call_current.invocation.state.current_layer_id,
        Some(returned.id)
    );
    assert_eq!(call_current.invocation.state.final_layer_id, None);
    assert_eq!(
        call_current.current.as_ref().unwrap().root_layer_id,
        returned.id
    );
    assert!(
        !portable
            .closures
            .iter()
            .flatten()
            .flat_map(|closure| &closure.layers)
            .flat_map(|layer| &layer.actions)
            .any(|action| action.id == link_a.id)
    );
    assert!(
        !call_current
            .current
            .as_ref()
            .unwrap()
            .layers
            .iter()
            .flat_map(|layer| &layer.actions)
            .any(|action| action.id == link_a.id)
    );
    assert!(
        !writer
            .get_layer(layer.id)
            .await
            .unwrap()
            .actions
            .iter()
            .any(|item| item.id == link_a.id)
    );
    let fixture = sqlx::SqlitePool::connect(&format!("sqlite://{}", file.path().display()))
        .await
        .unwrap();
    sqlx::query(&format!("CREATE TRIGGER reject_integrated_return BEFORE INSERT ON completions WHEN NEW.interaction_node_id={} BEGIN SELECT RAISE(ABORT, 'forced integrated Return failure'); END", child_a.id.value())).execute(&fixture).await.unwrap();
    assert!(
        child_writer
            .transition_current(
                1,
                "child-return",
                CurrentTransition::Return {
                    layer_id: returned.id
                }
            )
            .await
            .is_err()
    );
    assert!(
        !writer
            .get_layer(layer.id)
            .await
            .unwrap()
            .actions
            .iter()
            .any(|item| item.id == link_a.id)
    );
    let retained = database
        .durable_invocation(child_a.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retained.state.lifecycle, CompletionLifecycle::Active);
    assert_eq!(retained.state.current_layer_id, Some(returned.id));
    assert_eq!(retained.state.head_revision, 1);
    sqlx::query("DROP TRIGGER reject_integrated_return")
        .execute(&fixture)
        .await
        .unwrap();
    fixture.close().await;
    child_writer
        .transition_current(
            1,
            "child-return",
            CurrentTransition::Return {
                layer_id: returned.id,
            },
        )
        .await
        .unwrap();
    let finished = database
        .durable_invocation(child_a.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(finished.state.final_layer_id, Some(returned.id));
    assert_eq!(finished.state.lifecycle, CompletionLifecycle::Succeeded);
    assert_eq!(
        database
            .durable_invocation(child_b.id)
            .await
            .unwrap()
            .unwrap()
            .state
            .lifecycle,
        CompletionLifecycle::Active
    );
    let later_writer = database.writer_for_subgraph(child_b.id).await.unwrap();
    let (later_node, later_layer) = response(
        &later_writer,
        child_b.id,
        "Revised overall analysis A and B",
    )
    .await;
    let mut prior = integration.clone();
    prior.client_key = "retain-earlier-contribution".into();
    prior.source_node_id = later_node.id;
    prior.source_layer_id = Some(later_layer.id);
    later_writer.add_action(&prior).await.unwrap();
    let specialist = later_writer
        .submit_node(&NodeDraft {
            client_key: "specialist-b".into(),
            kind: "concept".into(),
            icon: "search".into(),
            title: "Specialist B detail".into(),
            detail: "Evidence incorporated into the enclosing analysis.".into(),
        })
        .await
        .unwrap();
    let detail = later_writer
        .submit_layer(&LayerDraft {
            client_key: "specialist-b-detail".into(),
            nodes: vec![specialist.id],
            edges: vec![],
            layout: Some(LayerLayout::v1(
                vec![NodePlacement {
                    node_id: specialist.id,
                    x: 0.5,
                    y: 0.5,
                }],
                "default",
            )),
            size_justification: None,
            default_node_id: Some(specialist.id),
        })
        .await
        .unwrap();
    let mut nested = prior.clone();
    nested.client_key = "specialist-details".into();
    nested.relation = Some(NavigateRelation::Expand);
    nested.target_layer_id = Some(detail.id);
    later_writer.add_action(&nested).await.unwrap();
    integration.client_key = "revised-analysis-b".into();
    integration.target_layer_id = Some(later_layer.id);
    let link_b = later_writer.add_action(&integration).await.unwrap();
    later_writer
        .transition_current(
            0,
            "later-child-return",
            CurrentTransition::Return {
                layer_id: later_layer.id,
            },
        )
        .await
        .unwrap();
    let source = writer.get_layer(layer.id).await.unwrap();
    let reusable = source
        .actions
        .iter()
        .find(|item| item.id == action.id)
        .unwrap();
    assert_eq!(reusable.kind, ActionKind::Invoke);
    assert_eq!(reusable.target_layer_id, None);
    assert!(source.actions.iter().any(|item| item.id == link_a.id));
    assert!(source.actions.iter().any(|item| item.id == link_b.id));
    assert!(
        later_writer
            .get_layer(later_layer.id)
            .await
            .unwrap()
            .actions
            .iter()
            .any(|item| item.target_layer_id == Some(returned.id))
    );
    assert_eq!(
        later_writer.get_layer(detail.id).await.unwrap().nodes[0].id,
        specialist.id
    );
    assert_eq!(writer.action_invocations(action.id).await.unwrap().len(), 2);
    assert!(
        writer
            .prepare_recursive_invocation(action.id, "new-after-return")
            .await
            .is_err()
    );
}

#[tokio::test]
async fn reused_key_recovers_frozen_child_across_own_draft_repairs() {
    let file = tempfile::NamedTempFile::new().unwrap();
    let database = GraphDatabase::open(file.path()).await.unwrap();
    let parent = database
        .create_interaction(None, ThreadId::new(52).unwrap(), "Investigate")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(parent.id).await.unwrap();
    let (node, layer) = response(&writer, parent.id, "Parent").await;
    let mut draft = callable(node.id, layer.id);
    let action = writer.add_action(&draft).await.unwrap();
    let (child, original) = writer
        .prepare_recursive_invocation(action.id, "stable-call")
        .await
        .unwrap();
    let original_input = database
        .writer_for_subgraph(child.id)
        .await
        .unwrap()
        .interaction_input()
        .await
        .unwrap();
    let repaired_layer = writer
        .submit_layer(&LayerDraft {
            client_key: "repaired-source".into(),
            default_node_id: Some(node.id),
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
        })
        .await
        .unwrap();
    let field = writer
        .add_action(&ActionDraft {
            client_key: "later-binding".into(),
            kind: ActionKind::Input,
            reusable: None,
            interaction_text: None,
            input: Some(InputAction {
                control: InputControl::Text,
                prompt: "Later question".into(),
                options: vec![],
                minimum_selections: None,
                unsupported_fields: Default::default(),
            }),
            ..draft.clone()
        })
        .await
        .unwrap();
    draft.interaction_text = Some("Changed instruction".into());
    draft.label = "Repaired label".into();
    draft.source_layer_id = Some(repaired_layer.id);
    draft.reusable = Some(false);
    draft.input_action_ids = vec![field.id];
    assert_eq!(writer.add_action(&draft).await.unwrap().id, action.id);
    let (recovered_child, recovered) = writer
        .prepare_recursive_invocation(action.id, "stable-call")
        .await
        .unwrap();
    assert_eq!(recovered_child, child);
    assert_eq!(recovered, original);
    assert_eq!(
        database
            .writer_for_subgraph(child.id)
            .await
            .unwrap()
            .interaction_input()
            .await
            .unwrap(),
        original_input
    );
    assert_eq!(
        original_input
            .completion_contract
            .as_ref()
            .unwrap()
            .input
            .text,
        "Investigate the evidence"
    );
    assert_eq!(original.action_snapshot["label"], "Investigate");
    assert_eq!(
        original.action_snapshot["presentingLayerId"],
        layer.id.value()
    );
    assert_eq!(original.action_snapshot["activator"], "agent");
    assert_eq!(original.action_snapshot["reusable"], true);
    assert!(original.action_snapshot.get("inputActionIds").is_none());
    assert!(matches!(
        writer
            .prepare_recursive_invocation(action.id, "fresh-call")
            .await,
        Err(GraphError::Validation {
            code: "invoke_single_call_already_prepared",
            ..
        })
    ));
    let other = writer
        .add_action(&ActionDraft {
            client_key: "another-action".into(),
            ..callable(node.id, layer.id)
        })
        .await
        .unwrap();
    assert!(matches!(
        writer
            .prepare_recursive_invocation(other.id, "stable-call")
            .await,
        Err(GraphError::Validation {
            code: "invocation_key_conflict",
            ..
        })
    ));
    // A repair to another kind cannot resurrect a callable from its old snapshot.
    writer
        .add_action(&ActionDraft {
            kind: ActionKind::Input,
            reusable: None,
            interaction_text: None,
            input_action_ids: vec![],
            input: field.input.clone(),
            ..draft.clone()
        })
        .await
        .unwrap();
    assert!(matches!(
        writer
            .prepare_recursive_invocation(action.id, "stable-call")
            .await,
        Err(GraphError::Forbidden(_))
    ));
    writer.add_action(&draft).await.unwrap();
    drop(writer);
    drop(database);
    let reopened = GraphDatabase::open(file.path()).await.unwrap();
    let writer = reopened.writer_for_subgraph(parent.id).await.unwrap();
    assert_eq!(
        writer
            .prepare_recursive_invocation(action.id, "stable-call")
            .await
            .unwrap()
            .1,
        original
    );
    assert_eq!(writer.action_invocations(action.id).await.unwrap().len(), 1);
    writer
        .transition_current(
            0,
            "stop-source",
            CurrentTransition::Stop {
                reason: "cancelled_by_user".into(),
            },
        )
        .await
        .unwrap();
    assert!(
        writer
            .prepare_recursive_invocation(action.id, "stable-call")
            .await
            .is_err()
    );
}

#[tokio::test]
async fn conversation_inventory_excludes_calls_from_reused_nodes_in_other_threads() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("shared-inventory.sqlite3");
    let database = GraphDatabase::open(&path).await.unwrap();
    let project = Some(ProjectId::new(910).unwrap());
    let parent = database
        .create_interaction(project, ThreadId::new(911).unwrap(), "Public conversation")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(parent.id).await.unwrap();
    let (node, layer) = response(&writer, parent.id, "Public").await;
    let invoke = writer
        .add_action(&callable(node.id, layer.id))
        .await
        .unwrap();
    let mut single_definition = callable(node.id, layer.id);
    single_definition.client_key = "global-single".into();
    single_definition.reusable = Some(false);
    let single = writer.add_action(&single_definition).await.unwrap();
    writer.complete(parent.id).await.unwrap();
    let (_, own) = writer
        .prepare_user_invocation(invoke.id, "public-call")
        .await
        .unwrap();

    let other = database
        .create_interaction(project, ThreadId::new(912).unwrap(), "Private conversation")
        .await
        .unwrap();
    let other_writer = database.writer_for_subgraph(other.id).await.unwrap();
    let (_, other_layer) = response(&other_writer, other.id, "Private").await;
    other_writer
        .submit_layer(&LayerDraft {
            client_key: "Private-layer".into(),
            default_node_id: Some(node.id),
            nodes: vec![node.id],
            edges: vec![],
            size_justification: None,
            layout: Some(LayerLayout::v1(
                vec![NodePlacement {
                    node_id: node.id,
                    x: 0.5,
                    y: 0.5,
                }],
                "default",
            )),
        })
        .await
        .unwrap();
    other_writer.complete(other.id).await.unwrap();
    assert_eq!(
        other_writer.get_layer(other_layer.id).await.unwrap().nodes[0].id,
        node.id
    );
    let (_, foreign) = other_writer
        .prepare_user_invocation_in_layer(invoke.id, "private-call", &[], Some(other_layer.id))
        .await
        .unwrap();
    let (_, private_single) = other_writer
        .prepare_user_invocation_in_layer(
            single.id,
            "private-single-secret",
            &[],
            Some(other_layer.id),
        )
        .await
        .unwrap();
    // Historical accepted Layers can omit a later canonical whole-Node Invoke.
    // Reconstruct only that projection omission, keeping the accepted definition
    // and native call unchanged; it must not mint another single activation.
    let fixture_pool = sqlx::SqlitePool::connect(&format!("sqlite://{}", path.display()))
        .await
        .unwrap();
    sqlx::query("DELETE FROM layer_actions WHERE layer_id=?1 AND action_id=?2")
        .bind(layer.id.value())
        .bind(single.id.value())
        .execute(&fixture_pool)
        .await
        .unwrap();
    fixture_pool.close().await;
    assert!(
        !writer
            .get_layer(layer.id)
            .await
            .unwrap()
            .actions
            .iter()
            .any(|action| action.id == single.id)
    );
    let public = database
        .conversation_graph_snapshot(&[parent.id])
        .await
        .unwrap();
    assert_eq!(public.invocations.len(), 1);
    assert_eq!(public.invocations[0].invocation.id, own.id);
    assert_eq!(public.exhausted_action_ids, Some(vec![single.id]));
    assert!(
        !serde_json::to_string(&public)
            .unwrap()
            .contains("private-single-secret")
    );
    let private = database
        .conversation_graph_snapshot(&[other.id])
        .await
        .unwrap();
    assert_eq!(private.invocations.len(), 2);
    assert!(
        private
            .invocations
            .iter()
            .any(|call| call.invocation.id == foreign.id)
    );
    assert!(
        private
            .invocations
            .iter()
            .any(|call| call.invocation.id == private_single.id)
    );
    assert_eq!(private.exhausted_action_ids, Some(vec![single.id]));
}

#[tokio::test]
async fn draft_invoke_cannot_downgrade_multiple_frozen_calls_to_single() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("invoke-policy.sqlite3");
    let database = GraphDatabase::open(&path).await.unwrap();
    let parent = database
        .create_interaction(None, ThreadId::new(913).unwrap(), "Compare two cases")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(parent.id).await.unwrap();
    let (node, layer) = response(&writer, parent.id, "Comparison").await;
    let draft = callable(node.id, layer.id);
    let invoke = writer.add_action(&draft).await.unwrap();
    writer
        .prepare_recursive_invocation(invoke.id, "first")
        .await
        .unwrap();
    writer
        .prepare_recursive_invocation(invoke.id, "second")
        .await
        .unwrap();
    let mut downgrade = draft.clone();
    downgrade.reusable = Some(false);
    let refusal = writer.add_action(&downgrade).await.unwrap_err();
    assert!(matches!(
        refusal,
        GraphError::Validation {
            code: "invoke_reuse_policy_conflict",
            ..
        }
    ));
    assert_eq!(
        writer
            .get_layer(layer.id)
            .await
            .unwrap()
            .actions
            .iter()
            .find(|action| action.id == invoke.id)
            .unwrap()
            .reusable,
        Some(true)
    );
    writer.complete(parent.id).await.unwrap();
    database.close().await;
    let reopened = GraphDatabase::open(&path).await.unwrap();
    let inventory = reopened
        .conversation_graph_snapshot(&[parent.id])
        .await
        .unwrap();
    assert_eq!(inventory.invocations.len(), 2);
    assert!(
        inventory
            .invocations
            .iter()
            .all(|call| call.source_action.reusable == Some(true))
    );
}

#[tokio::test]
async fn user_call_freezes_the_activated_layer_separately_from_definition_provenance() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("presenting-layer.sqlite3");
    let database = GraphDatabase::open(&path).await.unwrap();
    let parent = database
        .create_interaction(None, ThreadId::new(914).unwrap(), "Two presentations")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(parent.id).await.unwrap();
    let (node, authored) = response(&writer, parent.id, "Root").await;
    let invoke = writer
        .add_action(&callable(node.id, authored.id))
        .await
        .unwrap();
    let alternate = writer
        .submit_layer(&LayerDraft {
            client_key: "alternate".into(),
            default_node_id: Some(node.id),
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
        })
        .await
        .unwrap();
    let mut link = callable(node.id, authored.id);
    link.client_key = "alternate-view".into();
    link.kind = ActionKind::Navigate;
    link.relation = Some(NavigateRelation::Reference);
    link.target_layer_id = Some(alternate.id);
    link.interaction_text = None;
    link.reusable = None;
    writer.add_action(&link).await.unwrap();
    writer.complete(parent.id).await.unwrap();
    let (_, first) = writer
        .prepare_user_invocation_in_layer(invoke.id, "first", &[], Some(authored.id))
        .await
        .unwrap();
    let (_, second) = writer
        .prepare_user_invocation_in_layer(invoke.id, "second", &[], Some(alternate.id))
        .await
        .unwrap();
    for (call, presentation) in [(&first, authored.id), (&second, alternate.id)] {
        assert_eq!(
            call.action_snapshot["sourceLayerId"],
            serde_json::json!(authored.id)
        );
        assert_eq!(
            call.action_snapshot["presentingLayerId"],
            serde_json::json!(presentation)
        );
        assert_eq!(call.action_snapshot["activator"], "human");
        assert_eq!(call.action_snapshot["state"], "accepted");
    }
    let conflict = writer
        .prepare_user_invocation_in_layer(invoke.id, "second", &[], Some(authored.id))
        .await
        .unwrap_err();
    assert!(matches!(
        conflict,
        GraphError::Validation {
            code: "invocation_key_conflict",
            ..
        }
    ));
    assert!(matches!(
        writer
            .prepare_user_invocation_in_layer(
                invoke.id,
                "bad",
                &[],
                Some(LayerId::new(99999).unwrap())
            )
            .await,
        Err(GraphError::Validation {
            code: "invalid_invocation_presentation",
            ..
        })
    ));
    database.close().await;
    let reopened = GraphDatabase::open(&path).await.unwrap();
    let inventory = reopened
        .conversation_graph_snapshot(&[parent.id])
        .await
        .unwrap();
    assert_eq!(inventory.invocations.len(), 2);
    assert_eq!(
        inventory.invocations[1].invocation.action_snapshot,
        second.action_snapshot
    );
}
