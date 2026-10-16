use relayer_graph_core::*;

include!("support/live_answer_question.rs");

#[tokio::test]
async fn fresh_completion_recovers_stopped_work_exact_inputs_and_live_answers_after_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("history.sqlite");
    let database = GraphDatabase::open(&path).await.unwrap();
    let (earlier, answer) = question(&database).await;
    let original = earlier.interaction_input().await.unwrap();
    let receipt = database
        .accept_live_answer(earlier.node_id(), ThreadId::new(1).unwrap(), &answer)
        .await
        .unwrap();
    let current_layer = earlier.current_completion().await.unwrap().current_layer_id;
    earlier
        .transition_current(
            1,
            "stop",
            CurrentTransition::Stop {
                reason: "cancelled_by_user".into(),
            },
        )
        .await
        .unwrap();
    let node = database
        .writer_for_subgraph(earlier.node_id())
        .await
        .unwrap()
        .get_layer(current_layer.unwrap())
        .await
        .unwrap()
        .nodes[0]
        .id;
    let contexts = [InteractionContextDraft {
        target: InteractionContextTarget {
            node_id: node,
            source_interaction_node_id: earlier.node_id(),
            source_layer_id: current_layer.unwrap(),
        },
        annotations: vec!["Keep the city offline".into()],
    }];
    let (accepted_question, accepted_occurrence) = question(&database).await;
    accepted_question
        .complete(accepted_question.node_id())
        .await
        .unwrap();
    let submitted = [SubmittedInputDraft {
        occurrence: accepted_occurrence.occurrence.clone(),
        action: receipt.question,
        value: answer.value.clone(),
    }];
    let digest = interaction_input_authority_digest("Use my correction", &submitted).unwrap();
    let (correction, _) = database
        .create_identified_interaction_with_inputs(
            None,
            ThreadId::new(1).unwrap(),
            "Use my correction",
            InteractionInputPreparation {
                attempt_key: "correction",
                authority_digest: &digest,
                contexts: &contexts,
                submitted_inputs: &submitted,
            },
        )
        .await
        .unwrap();
    let exact_correction = database
        .writer_for_subgraph(correction.id)
        .await
        .unwrap()
        .interaction_input()
        .await
        .unwrap();
    let next = database
        .create_interaction(None, ThreadId::new(1).unwrap(), "Continue")
        .await
        .unwrap();
    let epoch = database
        .activate_completion_authority(next.id)
        .await
        .unwrap();
    database.close().await;
    let database = GraphDatabase::open(&path).await.unwrap();
    let reader = database
        .writer_for_completion_authority(next.id, epoch)
        .await
        .unwrap();
    let page = reader.completion_history(None, 8).await.unwrap();
    let stopped = page
        .entries
        .iter()
        .find(|entry| entry.interaction_node_id == earlier.node_id())
        .unwrap();
    assert_eq!(stopped.lifecycle, Some(CompletionLifecycle::Stopped));
    assert_eq!(stopped.current_layer_id, current_layer);
    assert_eq!(stopped.returned_layer_id, None);
    let recovered = reader
        .historical_interaction_input(earlier.node_id(), 0)
        .await
        .unwrap();
    assert_eq!(recovered.input, original);
    assert_eq!(recovered.live_answers[0].value, answer.value);
    assert_eq!(recovered.live_answers[0].occurrence, answer.occurrence);
    assert_eq!(
        reader
            .historical_interaction_input(correction.id, 0)
            .await
            .unwrap()
            .input,
        exact_correction
    );
    assert!(
        !serde_json::to_string(&recovered)
            .unwrap()
            .contains("authorityEpoch")
    );
    assert!(
        reader
            .historical_interaction_input(earlier.node_id(), 1)
            .await
            .unwrap()
            .live_answers
            .is_empty()
    );
}

#[tokio::test]
async fn history_is_bounded_paginated_and_uses_only_the_callers_active_thread_authority() {
    let database = GraphDatabase::in_memory().await.unwrap();
    let thread = ThreadId::new(1).unwrap();
    let mut ids = Vec::new();
    for index in 0..53 {
        ids.push(
            database
                .create_interaction(None, thread, &format!("Turn {index}"))
                .await
                .unwrap()
                .id,
        );
    }
    let current = database
        .create_interaction(None, thread, "Current")
        .await
        .unwrap();
    let epoch = database
        .activate_completion_authority(current.id)
        .await
        .unwrap();
    let reader = database
        .writer_for_completion_authority(current.id, epoch)
        .await
        .unwrap();
    let first = reader.completion_history(None, 50).await.unwrap();
    assert_eq!(first.entries.len(), 50);
    let second = reader
        .completion_history(first.next_before_node_id, 50)
        .await
        .unwrap();
    assert_eq!(second.entries.len(), 3);
    assert_eq!(second.entries.last().unwrap().interaction_node_id, ids[0]);
    assert!(second.next_before_node_id.is_none());
    assert!(reader.completion_history(None, 51).await.is_err());
    let foreign = database
        .create_interaction(None, ThreadId::new(2).unwrap(), "Secret")
        .await
        .unwrap();
    assert!(
        reader
            .historical_interaction_input(foreign.id, 0)
            .await
            .is_err()
    );
    assert!(
        reader
            .completion_history(Some(foreign.id), 20)
            .await
            .is_err()
    );
    let draft = reader
        .submit_node(&NodeDraft {
            client_key: "private".into(),
            kind: "concept".into(),
            icon: "box".into(),
            title: "Private".into(),
            detail: "Private".into(),
        })
        .await
        .unwrap();
    assert!(
        reader
            .historical_interaction_input(draft.id, 0)
            .await
            .is_err()
    );
    database
        .activate_completion_authority(current.id)
        .await
        .unwrap();
    assert!(reader.completion_history(None, 20).await.is_err());
    assert!(
        reader
            .historical_interaction_input(ids[0], 0)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn discovery_keeps_failed_semantic_children_and_their_source_pointers() {
    let database = GraphDatabase::in_memory().await.unwrap();
    let (parent, _, invoke) = question_with_invoke(&database, Some(false)).await;
    let (child, invocation) = parent
        .prepare_recursive_invocation(invoke.unwrap(), "inspect")
        .await
        .unwrap();
    database
        .writer_for_subgraph(child.id)
        .await
        .unwrap()
        .transition_current(
            0,
            "failed",
            CurrentTransition::Fail {
                reason: "execution".into(),
            },
        )
        .await
        .unwrap();
    let reader = database
        .create_interaction(None, ThreadId::new(1).unwrap(), "Continue the analysis")
        .await
        .unwrap();
    let reader = database.writer_for_subgraph(reader.id).await.unwrap();
    let page = reader.completion_history(None, 8).await.unwrap();
    let failed = page
        .entries
        .iter()
        .find(|entry| entry.interaction_node_id == child.id)
        .unwrap();
    assert_eq!(failed.lifecycle, Some(CompletionLifecycle::Failed));
    assert_eq!(failed.parent_node_id, Some(invocation.parent_node_id));
    assert_eq!(failed.source_completion_id, Some(parent.node_id()));
    assert!(failed.returned_layer_id.is_none());
    let active = page
        .entries
        .iter()
        .find(|entry| entry.interaction_node_id == parent.node_id())
        .unwrap();
    assert_eq!(active.lifecycle, Some(CompletionLifecycle::Active));
    assert!(active.current_layer_id.is_some());
}

#[tokio::test]
async fn historical_supplemental_answers_page_without_changing_the_sealed_input() {
    let database = GraphDatabase::in_memory().await.unwrap();
    let (parent, first, _, extra) = question_with_extra_inputs(&database, None, 51).await;
    let sealed = parent.interaction_input().await.unwrap();
    let mut request = first.clone();
    for (index, action_id) in std::iter::once(first.occurrence.action_id)
        .chain(extra)
        .enumerate()
    {
        request.occurrence.action_id = action_id;
        request.operation_key = format!("answer-{index}");
        request.value = SubmittedInputValue::Text {
            text: format!("City {index}"),
        };
        database
            .accept_live_answer(parent.node_id(), ThreadId::new(1).unwrap(), &request)
            .await
            .unwrap();
    }
    parent
        .transition_current(
            1,
            "stop",
            CurrentTransition::Stop {
                reason: "cancelled_by_user".into(),
            },
        )
        .await
        .unwrap();
    let next = database
        .create_interaction(None, ThreadId::new(1).unwrap(), "Continue")
        .await
        .unwrap();
    let reader = database.writer_for_subgraph(next.id).await.unwrap();
    let page = reader
        .historical_interaction_input(parent.node_id(), 0)
        .await
        .unwrap();
    assert_eq!(page.input, sealed);
    assert_eq!(page.live_answers.len(), 50);
    assert_eq!(page.next_answer_sequence, Some(50));
    let tail = reader
        .historical_interaction_input(parent.node_id(), 50)
        .await
        .unwrap();
    assert_eq!(
        tail.live_answers
            .iter()
            .map(|answer| answer.sequence)
            .collect::<Vec<_>>(),
        vec![51, 52]
    );
    assert!(tail.next_answer_sequence.is_none());
}

#[tokio::test]
async fn prepared_children_stay_private_to_their_parent_until_the_callable_is_published() {
    let database = GraphDatabase::in_memory().await.unwrap();
    database
        .set_interaction_permissions_enabled(true)
        .await
        .unwrap();
    let root = database
        .create_interaction(None, ThreadId::new(1).unwrap(), "Investigate")
        .await
        .unwrap();
    let parent = database.writer_for_subgraph(root.id).await.unwrap();
    let node = parent
        .submit_node(&NodeDraft {
            client_key: "task".into(),
            kind: "concept".into(),
            icon: "box".into(),
            title: "Task".into(),
            detail: "Private draft analysis".into(),
        })
        .await
        .unwrap();
    let layer: LayerDraft = serde_json::from_value(serde_json::json!({"clientKey":"layer","nodes":[node.id],"edges":[],"layout":{"version":1,"placements":[{"nodeId":node.id,"x":0.5,"y":0.5}],"edgeShape":"default"}})).unwrap();
    let layer = parent.submit_layer(&layer).await.unwrap();
    let action: ActionDraft = serde_json::from_value(serde_json::json!({"clientKey":"invoke","sourceNodeId":node.id,"sourceLayerId":layer.id,"kind":"invoke","label":"Investigate","variant":"pill","interactionText":"Private draft instruction","reusable":true})).unwrap();
    let action = parent.add_action(&action).await.unwrap();
    let (child, _) = parent
        .prepare_recursive_invocation(action.id, "private")
        .await
        .unwrap();
    let mut repaired: ActionDraft = serde_json::from_value(serde_json::json!({"clientKey":"repaired-invoke","sourceNodeId":node.id,"sourceLayerId":layer.id,"kind":"invoke","label":"Investigate","variant":"pill","interactionText":"Never published instruction"})).unwrap();
    let original_action = parent.add_action(&repaired).await.unwrap();
    let (unpublished_child, _) = parent
        .prepare_recursive_invocation(original_action.id, "repaired")
        .await
        .unwrap();
    repaired.interaction_text = Some("Published replacement instruction".into());
    parent.add_action(&repaired).await.unwrap();

    let sibling = database
        .create_interaction(None, ThreadId::new(1).unwrap(), "Other work")
        .await
        .unwrap();
    let reader = database.writer_for_subgraph(sibling.id).await.unwrap();
    assert!(
        !reader
            .completion_history(None, 20)
            .await
            .unwrap()
            .entries
            .iter()
            .any(|entry| entry.interaction_node_id == child.id)
    );
    assert!(
        reader
            .historical_interaction_input(child.id, 0)
            .await
            .is_err()
    );
    assert!(reader.completion_history(Some(child.id), 20).await.is_err());
    assert_eq!(
        parent
            .historical_interaction_input(child.id, 0)
            .await
            .unwrap()
            .input
            .interaction
            .detail,
        "Private draft instruction"
    );
    let response: ActionDraft = serde_json::from_value(serde_json::json!({"clientKey":"response","sourceNodeId":root.id,"kind":"navigate","relation":"expand","label":"Analysis","variant":"pill","targetLayerId":layer.id})).unwrap();
    parent.add_action(&response).await.unwrap();
    parent
        .transition_current(
            0,
            "publish",
            CurrentTransition::Advance { layer_id: layer.id },
        )
        .await
        .unwrap();
    assert!(
        reader
            .completion_history(None, 20)
            .await
            .unwrap()
            .entries
            .iter()
            .any(|entry| entry.interaction_node_id == child.id)
    );
    assert_eq!(
        reader
            .historical_interaction_input(child.id, 0)
            .await
            .unwrap()
            .input
            .interaction
            .detail,
        "Private draft instruction"
    );
    assert!(
        !reader
            .completion_history(None, 20)
            .await
            .unwrap()
            .entries
            .iter()
            .any(|entry| entry.interaction_node_id == unpublished_child.id)
    );
    assert!(
        reader
            .historical_interaction_input(unpublished_child.id, 0)
            .await
            .is_err()
    );
    parent
        .transition_current(
            1,
            "return",
            CurrentTransition::Return { layer_id: layer.id },
        )
        .await
        .unwrap();
    let reuse = database
        .create_interaction(None, ThreadId::new(1).unwrap(), "Reuse accepted callable")
        .await
        .unwrap();
    let reuse_writer = database.writer_for_subgraph(reuse.id).await.unwrap();
    let reused_layer = reuse_writer
        .submit_layer(&LayerDraft {
            client_key: "reused".into(),
            ..layer_draft_for_history(node.id)
        })
        .await
        .unwrap();
    let response: ActionDraft = serde_json::from_value(serde_json::json!({"clientKey":"response","sourceNodeId":reuse.id,"kind":"navigate","relation":"expand","label":"Response","variant":"pill","targetLayerId":reused_layer.id})).unwrap();
    reuse_writer.add_action(&response).await.unwrap();
    reuse_writer.complete(reuse.id).await.unwrap();
    let (reused_child, reused_call) = reuse_writer
        .prepare_user_invocation_in_layer(action.id, "reused-call", &[], Some(reused_layer.id))
        .await
        .unwrap();
    assert_eq!(reused_call.source_completion_id, reuse.id);
    assert!(
        reader
            .historical_interaction_input(reused_child.id, 0)
            .await
            .is_ok()
    );
    // Retained control APIs can resolve a one-shot lease after a keyed call was
    // prepared. The lease has a different child identity from the durable call.
    for action_id in [action.id, original_action.id] {
        let leased = database
            .create_interaction_with_invocation(
                None,
                ThreadId::new(1).unwrap(),
                "ignored",
                Some(InteractionInvocation {
                    source_interaction_node_id: root.id,
                    source_action_id: action_id,
                }),
            )
            .await
            .unwrap();
        let writer = database.writer_for_subgraph(leased.id).await.unwrap();
        let answer = writer
            .submit_node(&NodeDraft {
                client_key: "answer".into(),
                kind: "concept".into(),
                icon: "box".into(),
                title: "Answer".into(),
                detail: "Resolved work".into(),
            })
            .await
            .unwrap();
        let result: LayerDraft = serde_json::from_value(serde_json::json!({"clientKey":"result","nodes":[answer.id],"edges":[],"layout":{"version":1,"placements":[{"nodeId":answer.id,"x":0.5,"y":0.5}],"edgeShape":"default"}})).unwrap();
        let result = writer.submit_layer(&result).await.unwrap();
        let response: ActionDraft = serde_json::from_value(serde_json::json!({"clientKey":"response","sourceNodeId":leased.id,"kind":"navigate","relation":"expand","label":"Response","variant":"pill","targetLayerId":result.id})).unwrap();
        writer.add_action(&response).await.unwrap();
        writer.complete(leased.id).await.unwrap();
        assert_eq!(
            parent
                .get_layer(layer.id)
                .await
                .unwrap()
                .actions
                .iter()
                .find(|a| a.id == action_id)
                .unwrap()
                .kind,
            ActionKind::Navigate
        );
    }
    let history = reader.completion_history(None, 20).await.unwrap();
    assert!(
        history
            .entries
            .iter()
            .any(|entry| entry.interaction_node_id == child.id)
    );
    assert!(reader.completion_history(Some(child.id), 20).await.is_ok());
    assert!(
        history
            .entries
            .iter()
            .any(|entry| entry.interaction_node_id == reused_child.id)
    );
    assert!(
        reader
            .completion_history(Some(reused_child.id), 20)
            .await
            .is_ok()
    );
    assert_eq!(
        reader
            .historical_interaction_input(reused_child.id, 0)
            .await
            .unwrap()
            .input
            .interaction
            .detail,
        "Private draft instruction"
    );
    assert_eq!(
        reader
            .historical_interaction_input(child.id, 0)
            .await
            .unwrap()
            .input
            .interaction
            .detail,
        "Private draft instruction"
    );
    assert!(
        !history
            .entries
            .iter()
            .any(|entry| entry.interaction_node_id == unpublished_child.id)
    );
    assert!(
        reader
            .historical_interaction_input(unpublished_child.id, 0)
            .await
            .is_err()
    );
    assert!(
        reader
            .completion_history(Some(unpublished_child.id), 20)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn history_isolates_projects_even_when_thread_ids_are_reused() {
    let database = GraphDatabase::in_memory().await.unwrap();
    let thread = ThreadId::new(1).unwrap();
    let projects = [None, ProjectId::new(1), ProjectId::new(2)];
    let mut previous = Vec::new();
    for project in projects {
        previous.push(
            database
                .create_interaction(project, thread, "Private history")
                .await
                .unwrap(),
        );
    }
    for (index, project) in projects.into_iter().enumerate() {
        let current = database
            .create_interaction(project, thread, "Reader")
            .await
            .unwrap();
        let reader = database.writer_for_subgraph(current.id).await.unwrap();
        let page = reader.completion_history(None, 1).await.unwrap();
        assert_eq!(page.entries.len(), 1);
        let all = reader.completion_history(None, 50).await.unwrap();
        assert!(
            all.entries
                .iter()
                .any(|entry| entry.interaction_node_id == previous[index].id)
        );
        for (foreign_index, foreign) in previous.iter().enumerate() {
            if foreign_index == index {
                continue;
            }
            assert!(
                !all.entries
                    .iter()
                    .any(|entry| entry.interaction_node_id == foreign.id)
            );
            assert!(
                reader
                    .completion_history(Some(foreign.id), 1)
                    .await
                    .is_err()
            );
            assert!(
                reader
                    .historical_interaction_input(foreign.id, 0)
                    .await
                    .is_err()
            );
        }
        assert_eq!(
            reader
                .historical_interaction_input(previous[index].id, 0)
                .await
                .unwrap()
                .input
                .interaction
                .id,
            previous[index].id
        );
    }
}

fn layer_draft_for_history(node: NodeId) -> LayerDraft {
    serde_json::from_value(serde_json::json!({"clientKey":"result","nodes":[node],"edges":[],"layout":{"version":1,"placements":[{"nodeId":node,"x":0.5,"y":0.5}],"edgeShape":"default"}})).unwrap()
}
