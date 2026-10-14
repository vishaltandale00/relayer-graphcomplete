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

