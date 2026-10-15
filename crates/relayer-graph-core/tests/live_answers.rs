use relayer_graph_core::*;

include!("support/live_answer_question.rs");

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
        // Provider-bound reads lose authority at both Return and Stop. The
        // trusted Product read above and exact recovery below remain available.
        assert!(writer.live_answers(0).await.is_err());
        assert!(
            writer
                .live_answer_presentation(request.occurrence.presenting_layer_id)
                .await
                .is_err()
        );
        assert!(
            writer
                .live_answer_receipts(request.occurrence.presenting_layer_id)
                .await
                .is_err()
        );
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

#[tokio::test]
async fn live_answer_cursors_do_not_reveal_other_completions() {
    let database = GraphDatabase::in_memory().await.unwrap();
    let (first, first_request, _, first_extra) =
        question_with_extra_inputs(&database, None, 1).await;
    let (second, second_request, _, second_extra) =
        question_with_extra_inputs(&database, None, 1).await;
    let thread = ThreadId::new(1).unwrap();
    let first_answer = database
        .accept_live_answer(first.node_id(), thread, &first_request)
        .await
        .unwrap();
    let second_answer = database
        .accept_live_answer(second.node_id(), thread, &second_request)
        .await
        .unwrap();
    assert_eq!((first_answer.sequence, second_answer.sequence), (1, 1));
    let (third, third_request) = question(&database).await;
    let third_answer = database
        .accept_live_answer(third.node_id(), thread, &third_request)
        .await
        .unwrap();
    assert_eq!(third_answer.sequence, 1);
    let mut next_first = first_request.clone();
    next_first.operation_key = "next-first".into();
    next_first.occurrence.action_id = first_extra[0];
    let mut next_second = second_request.clone();
    next_second.operation_key = "next-second".into();
    next_second.occurrence.action_id = second_extra[0];
    let (next_first, next_second) = tokio::join!(
        database.accept_live_answer(first.node_id(), thread, &next_first),
        database.accept_live_answer(second.node_id(), thread, &next_second),
    );
    assert_eq!(
        (next_first.unwrap().sequence, next_second.unwrap().sequence),
        (2, 2)
    );
    for writer in [&first, &second] {
        let page = writer.live_answers(0).await.unwrap();
        assert_eq!(page.next_sequence, 2);
        assert_eq!(page.answers.len(), 2);
        assert!(
            page.answers
                .iter()
                .all(|answer| answer.completion_id == writer.node_id())
        );
        let later = writer.live_answers(1).await.unwrap();
        assert_eq!(later.answers.len(), 1);
        assert_eq!(later.answers[0].sequence, 2);
    }
    assert!(third.live_answers(1).await.unwrap().answers.is_empty());
}

#[tokio::test]
async fn delivered_occurrences_are_excluded_from_ordinary_drafts_but_unanswered_history_remains_editable()
 {
    for answered in [false, true] {
        let database = GraphDatabase::in_memory().await.unwrap();
        let (writer, request) = question(&database).await;
        let thread = ThreadId::new(1).unwrap();
        if answered {
            database
                .accept_live_answer(writer.node_id(), thread, &request)
                .await
                .unwrap();
        }
        writer
            .transition_current(
                1,
                "return",
                CurrentTransition::Return {
                    layer_id: request.occurrence.presenting_layer_id,
                },
            )
            .await
            .unwrap();
        let (_, ordinary, editable) = database
            .canonical_input_action_consumer_state(None, thread, &request.occurrence)
            .await
            .unwrap();
        assert_eq!((ordinary, editable), (!answered, !answered));
        assert_eq!(
            database
                .canonical_editable_input_action_occurrence(None, thread, &request.occurrence)
                .await
                .is_ok(),
            !answered
        );
        assert!(
            database
                .canonical_input_action_occurrence(None, thread, &request.occurrence)
                .await
                .is_ok()
        );
    }
}
