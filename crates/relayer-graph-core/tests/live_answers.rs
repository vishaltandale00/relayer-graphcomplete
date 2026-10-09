use relayer_graph_core::*;

async fn question(database: &GraphDatabase) -> (GraphWriter, LiveAnswerRequest) {
    let (writer, request, _) = question_with_invoke(database, None).await;
    (writer, request)
}

async fn question_with_invoke(
    database: &GraphDatabase,
    binding: Option<bool>,
) -> (GraphWriter, LiveAnswerRequest, Option<ActionId>) {
    let root = database
        .create_interaction(None, ThreadId::new(1).unwrap(), "Plan a trip")
        .await
        .unwrap();
    let authority_epoch = database
        .activate_completion_authority(root.id)
        .await
        .unwrap();
    let writer = database
        .writer_for_completion_authority(root.id, authority_epoch)
        .await
        .unwrap();
    let node = writer
        .submit_node(&NodeDraft {
            client_key: "question".into(),
            kind: "concept".into(),
            icon: "box".into(),
            title: "Which city?".into(),
            detail: "The itinerary depends on your city.".into(),
        })
        .await
        .unwrap();
    let layer = writer
        .submit_layer(&LayerDraft {
            client_key: "question-layer".into(),
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
    let action = writer
        .add_action(&ActionDraft {
            client_key: "city".into(),
            source_node_id: node.id,
            source_layer_id: Some(layer.id),
            kind: ActionKind::Input,
            relation: None,
            label: "City".into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: None,
            reusable: None,
            input_action_ids: vec![],
            input: Some(InputAction {
                control: InputControl::Text,
                prompt: "Which city?".into(),
                options: vec![],
                minimum_selections: None,
                unsupported_fields: Default::default(),
            }),
        })
        .await
        .unwrap();
    writer
        .add_action(&ActionDraft {
            client_key: "response".into(),
            source_node_id: root.id,
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
            input_action_ids: vec![],
            input: None,
        })
        .await
        .unwrap();
    let invoke = if let Some(bound) = binding {
        Some(
            writer
                .add_action(&ActionDraft {
                    client_key: "inspect".into(),
                    source_node_id: node.id,
                    source_layer_id: Some(layer.id),
                    kind: ActionKind::Invoke,
                    relation: None,
                    label: "Inspect".into(),
                    variant: Default::default(),
                    icon: None,
                    description: None,
                    target_layer_id: None,
                    interaction_text: Some("Inspect the boundary".into()),
                    reusable: Some(false),
                    input_action_ids: if bound { vec![action.id] } else { vec![] },
                    input: None,
                })
                .await
                .unwrap()
                .id,
        )
    } else {
        None
    };
    writer
        .transition_current(
            0,
            "ask-city",
            CurrentTransition::Advance { layer_id: layer.id },
        )
        .await
        .unwrap();
    (
        writer,
        LiveAnswerRequest {
            attempt_id: 1,
            authority_epoch,
            expected_revision: 1,
            operation_key: "answer-city".into(),
            occurrence: PresentingInputOccurrence {
                presenting_interaction_node_id: root.id,
                presenting_layer_id: layer.id,
                action_id: action.id,
            },
            value: SubmittedInputValue::Text {
                text: "Boston".into(),
            },
        },
        invoke,
    )
}

#[tokio::test]
async fn live_answers_are_supplemental_scoped_and_retry_safe_after_stop_and_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("graph.sqlite");
    let database = GraphDatabase::open(&path).await.unwrap();
    let (writer, request) = question(&database).await;
    let initial = writer.interaction_input().await.unwrap();
    let page = writer.live_answers(0).await.unwrap();
    assert!(page.answers.is_empty());
    assert_eq!(page.eligible_action_ids, vec![request.occurrence.action_id]);
    let answer = database
        .accept_live_answer(
            request.occurrence.presenting_interaction_node_id,
            ThreadId::new(1).unwrap(),
            &request,
        )
        .await
        .unwrap();
    assert_eq!(
        writer.live_answers(0).await.unwrap().answers[0].value,
        request.value
    );
    assert!(
        writer
            .live_answers(answer.sequence)
            .await
            .unwrap()
            .answers
            .is_empty()
    );
    assert_eq!(writer.interaction_input().await.unwrap(), initial);
    writer
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
        database
            .accept_live_answer(answer.completion_id, ThreadId::new(1).unwrap(), &request)
            .await
            .unwrap()
            .sequence,
        answer.sequence
    );
    let mut conflict = request.clone();
    conflict.value = SubmittedInputValue::Text {
        text: "Chicago".into(),
    };
    assert!(matches!(
        database
            .accept_live_answer(answer.completion_id, ThreadId::new(1).unwrap(), &conflict)
            .await,
        Err(GraphError::Validation {
            code: "live_answer_conflict",
            ..
        })
    ));
    let reopened = GraphDatabase::open(&path).await.unwrap();
    let page = reopened
        .writer_for_subgraph(answer.completion_id)
        .await
        .unwrap()
        .live_answers(0)
        .await
        .unwrap();
    assert_eq!(page.answers[0].sequence, answer.sequence);
    assert_eq!(
        reopened
            .writer_for_subgraph(answer.completion_id)
            .await
            .unwrap()
            .live_answer_receipts(request.occurrence.presenting_layer_id)
            .await
            .unwrap()[0]
            .operation_key,
        request.operation_key
    );
    assert!(page.eligible_action_ids.is_empty());
}

#[tokio::test]
async fn live_answers_reject_stale_foreign_invalid_and_duplicate_questions() {
    let database = GraphDatabase::in_memory().await.unwrap();
    let (writer, request) = question(&database).await;
    let root = request.occurrence.presenting_interaction_node_id;
    let thread = ThreadId::new(1).unwrap();
    let mut stale = request.clone();
    stale.authority_epoch += 1;
    assert!(
        database
            .accept_live_answer(root, thread, &stale)
            .await
            .is_err()
    );
    stale = request.clone();
    stale.expected_revision = 0;
    assert!(
        database
            .accept_live_answer(root, thread, &stale)
            .await
            .is_err()
    );
    assert!(
        database
            .accept_live_answer(root, ThreadId::new(2).unwrap(), &request)
            .await
            .is_err()
    );
    let mut invalid = request.clone();
    invalid.value = SubmittedInputValue::Text { text: " ".into() };
    assert!(
        database
            .accept_live_answer(root, thread, &invalid)
            .await
            .is_err()
    );
    assert!(writer.live_answers(0).await.unwrap().answers.is_empty());
    database
        .accept_live_answer(root, thread, &request)
        .await
        .unwrap();
    let mut duplicate = request.clone();
    duplicate.operation_key = "another-key".into();
    assert!(
        database
            .accept_live_answer(root, thread, &duplicate)
            .await
            .is_err()
    );
    assert_eq!(writer.live_answers(0).await.unwrap().answers.len(), 1);
}

#[tokio::test]
async fn answer_and_terminal_races_preserve_exact_receipts_and_never_change_sealed_input() {
    for stop in [false, true] {
        let database = GraphDatabase::in_memory().await.unwrap();
        let (writer, request) = question(&database).await;
        let root = request.occurrence.presenting_interaction_node_id;
        let initial = writer.interaction_input().await.unwrap();
        let terminal = if stop {
            CurrentTransition::Stop {
                reason: "cancelled_by_user".into(),
            }
        } else {
            CurrentTransition::Return {
                layer_id: request.occurrence.presenting_layer_id,
            }
        };
        let (answer, settled) = tokio::join!(
            database.accept_live_answer(root, ThreadId::new(1).unwrap(), &request),
            writer.transition_current(1, "settle", terminal)
        );
        settled.unwrap();
        let page = database
            .writer_for_subgraph(root)
            .await
            .unwrap()
            .live_answers(0)
            .await
            .unwrap();
        assert_ne!(page.current.lifecycle, CompletionLifecycle::Active);
        assert!(page.eligible_action_ids.is_empty());
        match answer {
            Ok(answer) => {
                assert_eq!(page.answers.len(), 1);
                assert_eq!(
                    database
                        .accept_live_answer(root, ThreadId::new(1).unwrap(), &request)
                        .await
                        .unwrap()
                        .sequence,
                    answer.sequence
                );
            }
            Err(GraphError::Validation {
                code: "terminal_completion",
                ..
            }) => assert!(page.answers.is_empty()),
            other => panic!("unexpected race verdict: {other:?}"),
        }
        assert_eq!(
            database
                .writer_for_subgraph(root)
                .await
                .unwrap()
                .interaction_input()
                .await
                .unwrap(),
            initial
        );
    }
}

#[tokio::test]
async fn authority_cutover_blocks_old_readers_and_stale_answer_admission() {
    let database = GraphDatabase::in_memory().await.unwrap();
    let (writer, request) = question(&database).await;
    let root = request.occurrence.presenting_interaction_node_id;
    let next_epoch = database.activate_completion_authority(root).await.unwrap();
    assert!(writer.live_answers(0).await.is_err());
    assert!(
        database
            .accept_live_answer(root, ThreadId::new(1).unwrap(), &request)
            .await
            .is_err()
    );
    let mut current = request;
    current.authority_epoch = next_epoch;
    database
        .accept_live_answer(root, ThreadId::new(1).unwrap(), &current)
        .await
        .unwrap();
    assert_eq!(
        database
            .writer_for_completion_authority(root, next_epoch)
            .await
            .unwrap()
            .live_answers(0)
            .await
            .unwrap()
            .answers
            .len(),
        1
    );
}

#[tokio::test]
async fn live_answers_reject_invoke_bound_questions_and_semantic_children() {
    let database = GraphDatabase::in_memory().await.unwrap();
    let (writer, request, _) = question_with_invoke(&database, Some(true)).await;
    assert!(
        writer
            .live_answers(0)
            .await
            .unwrap()
            .eligible_action_ids
            .is_empty()
    );
    assert!(matches!(
        database
            .accept_live_answer(
                request.occurrence.presenting_interaction_node_id,
                ThreadId::new(1).unwrap(),
                &request
            )
            .await,
        Err(GraphError::Validation {
            code: "live_question_unavailable",
            ..
        })
    ));
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
    let (writer, mut request, invoke) = question_with_invoke(&database, Some(false)).await;
    let (child, _) = writer
        .prepare_recursive_invocation(invoke.unwrap(), "inspect-child")
        .await
        .unwrap();
    request.occurrence.presenting_interaction_node_id = child.id;
    assert!(matches!(
        database
            .accept_live_answer(child.id, ThreadId::new(1).unwrap(), &request)
            .await,
        Err(GraphError::Validation {
            code: "live_answer_root_only",
            ..
        })
    ));
    assert!(
        database
            .writer_for_subgraph(child.id)
            .await
            .unwrap()
            .live_answers(0)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn human_invoke_roots_do_not_acquire_live_answer_authority() {
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
    let (writer, mut request, invoke) = question_with_invoke(&database, Some(false)).await;
    let root = request.occurrence.presenting_interaction_node_id;
    writer
        .transition_current(
            1,
            "settle",
            CurrentTransition::Return {
                layer_id: request.occurrence.presenting_layer_id,
            },
        )
        .await
        .unwrap();
    let trusted = database.writer_for_subgraph(root).await.unwrap();
    let (child, _) = trusted
        .prepare_user_invocation(invoke.unwrap(), "human-invoke")
        .await
        .unwrap();
    request.occurrence.presenting_interaction_node_id = child.id;
    assert!(matches!(
        database
            .accept_live_answer(child.id, ThreadId::new(1).unwrap(), &request)
            .await,
        Err(GraphError::Validation {
            code: "live_answer_root_only",
            ..
        })
    ));
}
