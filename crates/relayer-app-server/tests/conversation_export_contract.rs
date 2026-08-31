use relayer_app_server::conversation_export::*;

fn action(
    id: &str,
    source_node_id: &str,
    source_layer_id: Option<&str>,
    relation: Option<ExportNavigateRelation>,
    target_layer_id: Option<&str>,
) -> ExportAction {
    ExportAction {
        id: id.into(),
        source_node_id: source_node_id.into(),
        source_layer_id: source_layer_id.map(Into::into),
        kind: ExportActionKind::Navigate,
        relation,
        label: "Open".into(),
        variant: ExportActionVariant::Pill,
        icon: None,
        description: None,
        target_layer_id: target_layer_id.map(Into::into),
        interaction_text: None,
        input: None,
        state: ExportRecordState::Accepted,
    }
}

fn invoke(id: &str, source_node_id: &str, source_layer_id: &str) -> ExportAction {
    ExportAction {
        id: id.into(),
        source_node_id: source_node_id.into(),
        source_layer_id: Some(source_layer_id.into()),
        kind: ExportActionKind::Invoke,
        relation: None,
        label: "Follow up".into(),
        variant: ExportActionVariant::Pill,
        icon: None,
        description: None,
        target_layer_id: None,
        interaction_text: Some("Continue".into()),
        input: None,
        state: ExportRecordState::Accepted,
    }
}

fn input(id: &str, source_node_id: &str, source_layer_id: &str) -> ExportAction {
    ExportAction {
        id: id.into(),
        source_node_id: source_node_id.into(),
        source_layer_id: Some(source_layer_id.into()),
        kind: ExportActionKind::Input,
        relation: None,
        label: "Respond".into(),
        variant: ExportActionVariant::Pill,
        icon: None,
        description: None,
        target_layer_id: None,
        interaction_text: None,
        input: Some(ExportInputActionSnapshot {
            control: ExportInputControl::Text,
            prompt: "Explain".into(),
            options: vec![],
            minimum_selections: None,
            unsupported_fields: Default::default(),
        }),
        state: ExportRecordState::Accepted,
    }
}

fn option(key: &str, label: &str) -> ExportInputOption {
    ExportInputOption {
        key: key.into(),
        label: label.into(),
        unsupported_fields: Default::default(),
    }
}

fn layer(id: &str, node_id: &str, actions: Vec<ExportAction>) -> ExportResolvedLayer {
    ExportResolvedLayer {
        layer: ExportLayer {
            id: id.into(),
            nodes: vec![node_id.into()],
            edges: vec![],
            layout: Some(ExportLayerLayout {
                version: 1,
                placements: vec![ExportNodePlacement {
                    node_id: node_id.into(),
                    x: 0.5,
                    y: 0.5,
                }],
            }),
            state: ExportRecordState::Accepted,
        },
        nodes: vec![ExportNode {
            id: node_id.into(),
            kind: "concept".into(),
            icon: "file".into(),
            title: format!("Node {node_id}"),
            detail: "Durable accepted detail".into(),
            state: ExportRecordState::Accepted,
        }],
        edges: vec![],
        actions,
    }
}

fn accepted_view() -> ExportAcceptedView {
    ExportAcceptedView {
        interaction_node_id: "node:interaction-1".into(),
        root_action: action(
            "action:root-1",
            "node:interaction-1",
            None,
            Some(ExportNavigateRelation::Expand),
            Some("layer:1"),
        ),
        root_layer_id: "layer:1".into(),
        layers: vec![layer(
            "layer:1",
            "node:1",
            vec![invoke("action:invoke-1", "node:1", "layer:1")],
        )],
    }
}

fn context(id: &str, annotations: &[&str]) -> ExportInteractionContext {
    ExportInteractionContext {
        id: id.into(),
        target: ExportContextTargetSnapshot {
            id: "node:1".into(),
            kind: "concept".into(),
            icon: "file".into(),
            title: "Node node:1".into(),
            detail: "Durable accepted detail".into(),
            state: ExportRecordState::Accepted,
        },
        source: ExportContextSource {
            interaction_node_id: "node:source-interaction".into(),
            layer_id: "layer:source".into(),
        },
        annotations: annotations.iter().map(|value| (*value).into()).collect(),
    }
}

fn receipt(status: ExportCompletionStatus) -> ExportCompletionReceipt {
    ExportCompletionReceipt {
        status,
        attempt_outcome: None,
        harness_configuration_name: Some("codex-basic".into()),
        harness_configuration_digest: Some(format!("sha256:{}", "a".repeat(64))),
        model_selection: Some(ExportModelSelection {
            provider_id: "codex".into(),
            model_id: "gpt-test".into(),
            model_family_id: 1,
        }),
        permission_profile_id: "auto".into(),
        effective_execution_digest: Some(format!("sha256:{}", "b".repeat(64))),
        effective_permission_receipt: Some(ExportPermissionReceipt {
            schema_version: 1,
            permission_profile_id: "auto".into(),
            label: "Approve for me".into(),
            authority: "bounded".into(),
            reviewer: "automatic".into(),
            binding_present: true,
            unconfined_host_access: false,
            disclosure: None,
        }),
        error: None,
        attempt_admission_id: None,
        admitted_model_plan: None,
    }
}

fn records() -> Vec<ConversationExportRecord> {
    vec![
        ConversationExportRecord::Header(Box::new(ConversationExportHeader {
            export_version: EXPORT_VERSION_V1,
            exported_at: "1770000000000".into(),
            producer: ExportProducer {
                desktop_version: "0.2.12".into(),
                build_commit: "test-commit".into(),
                platform: "darwin".into(),
                architecture: "arm64".into(),
            },
            conversation: ExportConversation {
                id: "conversation:1".into(),
                title: "Debug bad response".into(),
                created_at: "1769000000000".into(),
                project_name: Some("fixture".into()),
                harness_configuration_name: "codex-basic".into(),
                permission_profile_id: "auto".into(),
            },
            turns: vec![ExportTurnManifestEntry {
                id: "turn:1".into(),
                sequence: 1,
            }],
        })),
        ConversationExportRecord::Turn(Box::new(ConversationExportTurn {
            id: "turn:1".into(),
            sequence: 1,
            created_at: "1769000001000".into(),
            text: "Review this tokenizer".into(),
            interaction_node_id: None,
            origin: ExportTurnOrigin::User,
            completion: receipt(ExportCompletionStatus::Accepted),
            contexts: vec![],
            submitted_inputs: vec![],
            accepted_view: Some(accepted_view()),
        })),
    ]
}

fn two_turn_records() -> Vec<ConversationExportRecord> {
    let mut fixture = records();
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.turns.push(ExportTurnManifestEntry {
        id: "turn:2".into(),
        sequence: 2,
    });
    fixture.push(ConversationExportRecord::Turn(Box::new(
        ConversationExportTurn {
            id: "turn:2".into(),
            sequence: 2,
            created_at: "1769000002000".into(),
            text: "Continue".into(),
            interaction_node_id: None,
            origin: ExportTurnOrigin::Action {
                source_turn_id: "turn:1".into(),
                source_action_id: "action:invoke-1".into(),
            },
            completion: receipt(ExportCompletionStatus::Accepted),
            contexts: vec![],
            submitted_inputs: vec![],
            accepted_view: Some(ExportAcceptedView {
                interaction_node_id: "node:interaction-2".into(),
                root_action: action(
                    "action:root-2",
                    "node:interaction-2",
                    None,
                    Some(ExportNavigateRelation::Expand),
                    Some("layer:2"),
                ),
                root_layer_id: "layer:2".into(),
                layers: vec![layer(
                    "layer:2",
                    "node:1",
                    vec![invoke("action:invoke-1", "node:1", "layer:1")],
                )],
            }),
        },
    )));
    fixture
}

fn validate_incrementally(
    records: &[ConversationExportRecord],
) -> Result<(), ExportValidationError> {
    let ConversationExportRecord::Header(header) = &records[0] else {
        panic!("parity fixture must start with a header")
    };
    let mut validator = ConversationExportValidator::new(header)?;
    for record in &records[1..] {
        let ConversationExportRecord::Turn(turn) = record else {
            panic!("parity fixture must contain only turns after its header")
        };
        validator.push_turn(turn)?;
    }
    validator.finish()
}

fn assert_validation_parity(records: &[ConversationExportRecord]) {
    assert_eq!(
        validate_export_records(records).map_err(|error| error.code),
        validate_incrementally(records).map_err(|error| error.code),
    );
}

fn assert_rejected_with_parity(records: &[ConversationExportRecord], code: &'static str) {
    assert_eq!(validate_export_records(records).unwrap_err().code, code);
    assert_eq!(validate_incrementally(records).unwrap_err().code, code);
}

#[test]
fn serializes_exactly_header_and_turn_records_and_round_trips() {
    let records = records();
    validate_export_records(&records).unwrap();
    let lines = records
        .iter()
        .map(|record| serde_json::to_string(record).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&lines[0]).unwrap()["recordType"],
        "header"
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&lines[1]).unwrap()["recordType"],
        "turn"
    );
    assert_eq!(
        lines
            .iter()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect::<Vec<ConversationExportRecord>>(),
        records
    );
    assert!(lines.iter().all(|line| {
        !line.contains("personalPresentation")
            && !line.contains("personal-presentation")
            && !line.contains("Decision-useful center")
    }));
    assert!(
        serde_json::from_str::<ConversationExportRecord>(r#"{"recordType":"artifact"}"#).is_err()
    );
}

#[test]
fn accepted_input_action_requires_its_authored_payload() {
    let mut fixture = records();
    let ConversationExportRecord::Turn(turn) = &mut fixture[1] else {
        unreachable!()
    };
    let mut missing_payload = input("action:input", "node:1", "layer:1");
    missing_payload.input = None;
    turn.accepted_view.as_mut().unwrap().layers[0]
        .actions
        .push(missing_payload);

    assert_rejected_with_parity(&fixture, "invalid_action_shape");
}

#[test]
fn older_turns_without_context_fields_decode_as_empty_context() {
    let ConversationExportRecord::Turn(turn) = &records()[1] else {
        unreachable!()
    };
    let mut value = serde_json::to_value(turn.as_ref()).unwrap();
    let object = value.as_object_mut().unwrap();
    object.remove("contexts");
    object.remove("interactionNodeId");
    let decoded: ConversationExportTurn = serde_json::from_value(value).unwrap();
    assert!(decoded.contexts.is_empty());
    assert!(decoded.interaction_node_id.is_none());
}

#[test]
fn context_round_trip_preserves_order_nonaccepted_turns_and_shared_snapshots() {
    let mut fixture = records();
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.turns.push(ExportTurnManifestEntry {
        id: "turn:2".into(),
        sequence: 2,
    });
    let ConversationExportRecord::Turn(first) = &mut fixture[1] else {
        unreachable!()
    };
    first.interaction_node_id = Some("node:interaction-1".into());
    first.contexts = vec![context("action:context-1", &["First", "Second"])];
    fixture.push(ConversationExportRecord::Turn(Box::new(
        ConversationExportTurn {
            id: "turn:2".into(),
            sequence: 2,
            created_at: "1769000002000".into(),
            text: "The completion failed".into(),
            interaction_node_id: Some("node:interaction-2".into()),
            origin: ExportTurnOrigin::User,
            completion: receipt(ExportCompletionStatus::Failed),
            contexts: vec![context("action:context-2", &["Still inspect this"])],
            submitted_inputs: vec![],
            accepted_view: None,
        },
    )));

    validate_export_records(&fixture).unwrap();
    let ConversationExportRecord::Turn(first) = &fixture[1] else {
        unreachable!()
    };
    assert_eq!(first.contexts[0].annotations, ["First", "Second"]);

    let mut annotation_only = fixture.clone();
    if let ConversationExportRecord::Turn(first) = &mut annotation_only[1] {
        first.text.clear();
    }
    validate_export_records(&annotation_only).unwrap();
    if let ConversationExportRecord::Turn(first) = &mut annotation_only[1] {
        first.contexts[0].annotations.clear();
    }
    assert_rejected_with_parity(&annotation_only, "interaction_input_empty");

    let mut drifted = fixture.clone();
    let ConversationExportRecord::Turn(second) = &mut drifted[2] else {
        unreachable!()
    };
    second.contexts[0].target.detail = "Snapshot drift".into();
    assert_rejected_with_parity(&drifted, "context_target_snapshot_drift");
}

#[test]
fn preserves_legacy_missing_layout_and_rejects_invalid_portable_layouts() {
    let mut legacy = records();
    let ConversationExportRecord::Turn(turn) = &mut legacy[1] else {
        unreachable!()
    };
    turn.accepted_view.as_mut().unwrap().layers[0].layer.layout = None;
    validate_export_records(&legacy).unwrap();

    let mut unsupported = records();
    let ConversationExportRecord::Turn(turn) = &mut unsupported[1] else {
        unreachable!()
    };
    turn.accepted_view.as_mut().unwrap().layers[0]
        .layer
        .layout
        .as_mut()
        .unwrap()
        .version = 2;
    assert_rejected_with_parity(&unsupported, "unsupported_layout_version");

    let mut outside = records();
    let ConversationExportRecord::Turn(turn) = &mut outside[1] else {
        unreachable!()
    };
    turn.accepted_view.as_mut().unwrap().layers[0]
        .layer
        .layout
        .as_mut()
        .unwrap()
        .placements[0]
        .node_id = "node:outside".into();
    assert_rejected_with_parity(&outside, "layout_node_outside_layer");

    let mut invalid_coordinate = records();
    let ConversationExportRecord::Turn(turn) = &mut invalid_coordinate[1] else {
        unreachable!()
    };
    turn.accepted_view.as_mut().unwrap().layers[0]
        .layer
        .layout
        .as_mut()
        .unwrap()
        .placements[0]
        .x = 1.1;
    assert_rejected_with_parity(&invalid_coordinate, "layout_coordinate_invalid");
}

#[test]
fn requires_the_exact_ordered_header_inventory() {
    let mut missing = records();
    missing.pop();
    assert_eq!(
        validate_export_records(&missing).unwrap_err().code,
        "turn_inventory_mismatch"
    );

    let mut mismatch = records();
    let ConversationExportRecord::Turn(turn) = &mut mismatch[1] else {
        unreachable!()
    };
    turn.id = "turn:2".into();
    assert_eq!(
        validate_export_records(&mismatch).unwrap_err().code,
        "turn_manifest_mismatch"
    );

    let mut duplicate_header = records();
    duplicate_header.push(duplicate_header[0].clone());
    assert_eq!(
        validate_export_records(&duplicate_header).unwrap_err().code,
        "duplicate_header"
    );
}

#[test]
fn preserves_actual_completion_status_without_inventing_acceptance() {
    for (status, wire_name) in [
        (ExportCompletionStatus::NotStarted, "not_started"),
        (ExportCompletionStatus::Running, "running"),
        (ExportCompletionStatus::Submitted, "submitted"),
        (
            ExportCompletionStatus::WaitingForApproval,
            "waiting_for_approval",
        ),
        (ExportCompletionStatus::Failed, "failed"),
        (ExportCompletionStatus::Stopped, "stopped"),
    ] {
        let mut fixture = records();
        let ConversationExportRecord::Turn(turn) = &mut fixture[1] else {
            unreachable!()
        };
        turn.completion.status = status;
        turn.accepted_view = None;
        assert!(
            validate_export_records(&fixture).is_ok(),
            "status {status:?}"
        );
        assert_eq!(serde_json::to_value(status).unwrap(), wire_name);
    }

    let mut cancelled = records();
    let ConversationExportRecord::Turn(turn) = &mut cancelled[1] else {
        unreachable!()
    };
    turn.completion.status = ExportCompletionStatus::Stopped;
    turn.completion.attempt_outcome = Some(ExportAttemptOutcome::Cancelled);
    turn.accepted_view = None;
    let encoded = serde_json::to_value(&cancelled[1]).unwrap();
    assert_eq!(encoded["completion"]["status"], "stopped");
    assert_eq!(encoded["completion"]["attemptOutcome"], "cancelled");
    let decoded: ConversationExportRecord = serde_json::from_value(encoded).unwrap();
    let ConversationExportRecord::Turn(decoded) = decoded else {
        unreachable!()
    };
    assert_eq!(
        decoded.completion.attempt_outcome,
        Some(ExportAttemptOutcome::Cancelled)
    );

    for (status, outcome) in [
        (
            ExportCompletionStatus::Accepted,
            ExportAttemptOutcome::ModelFailed,
        ),
        (
            ExportCompletionStatus::Accepted,
            ExportAttemptOutcome::Running,
        ),
        (
            ExportCompletionStatus::Running,
            ExportAttemptOutcome::Accepted,
        ),
    ] {
        let mut impossible = records();
        let ConversationExportRecord::Turn(turn) = &mut impossible[1] else {
            unreachable!()
        };
        turn.completion.status = status;
        turn.completion.attempt_outcome = Some(outcome);
        if status != ExportCompletionStatus::Accepted {
            turn.accepted_view = None;
        }
        assert_rejected_with_parity(&impossible, "attempt_outcome_status_mismatch");
    }

    for (status, outcome) in [
        (
            ExportCompletionStatus::Accepted,
            Some(ExportAttemptOutcome::Accepted),
        ),
        (ExportCompletionStatus::Accepted, None),
        (
            ExportCompletionStatus::Running,
            Some(ExportAttemptOutcome::Running),
        ),
        (
            ExportCompletionStatus::Failed,
            Some(ExportAttemptOutcome::ModelFailed),
        ),
    ] {
        let mut valid = records();
        let ConversationExportRecord::Turn(turn) = &mut valid[1] else {
            unreachable!()
        };
        turn.completion.status = status;
        turn.completion.attempt_outcome = outcome;
        if status != ExportCompletionStatus::Accepted {
            turn.accepted_view = None;
        }
        validate_export_records(&valid).unwrap();
        validate_incrementally(&valid).unwrap();
    }

    let mut accepted_without_view = records();
    let ConversationExportRecord::Turn(turn) = &mut accepted_without_view[1] else {
        unreachable!()
    };
    turn.accepted_view = None;
    assert_eq!(
        validate_export_records(&accepted_without_view)
            .unwrap_err()
            .code,
        "accepted_view_missing"
    );
}

#[test]
fn accepts_complete_reference_cycles_but_rejects_expand_cycles_and_missing_targets() {
    let mut reference_cycle = records();
    let ConversationExportRecord::Turn(turn) = &mut reference_cycle[1] else {
        unreachable!()
    };
    let view = turn.accepted_view.as_mut().unwrap();
    view.layers[0].actions = vec![action(
        "action:1-to-2",
        "node:1",
        Some("layer:1"),
        Some(ExportNavigateRelation::Reference),
        Some("layer:2"),
    )];
    view.layers.push(layer(
        "layer:2",
        "node:2",
        vec![action(
            "action:2-to-2",
            "node:2",
            Some("layer:2"),
            Some(ExportNavigateRelation::Reference),
            Some("layer:2"),
        )],
    ));
    assert!(validate_export_records(&reference_cycle).is_ok());

    let mut expand_cycle = reference_cycle.clone();
    let ConversationExportRecord::Turn(turn) = &mut expand_cycle[1] else {
        unreachable!()
    };
    for layer in &mut turn.accepted_view.as_mut().unwrap().layers {
        layer.actions[0].relation = Some(ExportNavigateRelation::Expand);
    }
    turn.accepted_view.as_mut().unwrap().layers[1].actions[0].target_layer_id =
        Some("layer:1".into());
    assert_eq!(
        validate_export_records(&expand_cycle).unwrap_err().code,
        "expand_cycle"
    );

    let mut missing = records();
    let ConversationExportRecord::Turn(turn) = &mut missing[1] else {
        unreachable!()
    };
    turn.accepted_view.as_mut().unwrap().layers[0].actions[0] = action(
        "action:missing",
        "node:1",
        Some("layer:1"),
        Some(ExportNavigateRelation::Reference),
        Some("layer:missing"),
    );
    assert_eq!(
        validate_export_records(&missing).unwrap_err().code,
        "navigate_target_unresolved"
    );
}

#[test]
fn allows_reused_action_provenance_and_requires_action_origins_to_name_prior_invokes() {
    let mut fixture = records();
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.turns.push(ExportTurnManifestEntry {
        id: "turn:2".into(),
        sequence: 2,
    });
    fixture.push(ConversationExportRecord::Turn(Box::new(
        ConversationExportTurn {
            id: "turn:2".into(),
            sequence: 2,
            created_at: "1769000002000".into(),
            text: "Continue".into(),
            interaction_node_id: None,
            origin: ExportTurnOrigin::Action {
                source_turn_id: "turn:1".into(),
                source_action_id: "action:invoke-1".into(),
            },
            completion: receipt(ExportCompletionStatus::Accepted),
            contexts: vec![],
            submitted_inputs: vec![],
            accepted_view: Some(ExportAcceptedView {
                interaction_node_id: "node:interaction-2".into(),
                root_action: action(
                    "action:root-2",
                    "node:interaction-2",
                    None,
                    Some(ExportNavigateRelation::Expand),
                    Some("layer:2"),
                ),
                root_layer_id: "layer:2".into(),
                layers: vec![layer(
                    "layer:2",
                    "node:1",
                    vec![invoke("action:invoke-1", "node:1", "layer:1")],
                )],
            }),
        },
    )));
    assert!(validate_export_records(&fixture).is_ok());

    let ConversationExportRecord::Turn(turn) = &mut fixture[2] else {
        unreachable!()
    };
    turn.origin = ExportTurnOrigin::Action {
        source_turn_id: "turn:1".into(),
        source_action_id: "action:root-1".into(),
    };
    assert_eq!(
        validate_export_records(&fixture).unwrap_err().code,
        "action_origin_unresolved"
    );
}

#[test]
fn rejects_conflicting_reused_portable_id_definitions() {
    let mut fixture = records();
    let ConversationExportRecord::Turn(turn) = &mut fixture[1] else {
        unreachable!()
    };
    let view = turn.accepted_view.as_mut().unwrap();
    view.layers[0].actions = vec![action(
        "action:to-2",
        "node:1",
        Some("layer:1"),
        Some(ExportNavigateRelation::Reference),
        Some("layer:2"),
    )];
    let mut second = layer("layer:2", "node:1", vec![]);
    second.nodes[0].detail = "Conflicting definition".into();
    view.layers.push(second);
    assert_eq!(
        validate_export_records(&fixture).unwrap_err().code,
        "node_identity_conflict"
    );
}

#[test]
fn incremental_validation_matches_batch_for_stream_order_and_cross_turn_semantics() {
    let valid = two_turn_records();
    assert_validation_parity(&valid);

    let mut manifest_mismatch = valid.clone();
    let ConversationExportRecord::Turn(turn) = &mut manifest_mismatch[1] else {
        unreachable!()
    };
    turn.id = "turn:wrong".into();
    assert_rejected_with_parity(&manifest_mismatch, "turn_manifest_mismatch");

    let mut out_of_order = valid.clone();
    out_of_order.swap(1, 2);
    assert_rejected_with_parity(&out_of_order, "turn_manifest_mismatch");

    let mut unresolved_reference = valid.clone();
    let ConversationExportRecord::Turn(turn) = &mut unresolved_reference[1] else {
        unreachable!()
    };
    turn.accepted_view.as_mut().unwrap().layers[0].actions[0] = action(
        "action:missing",
        "node:1",
        Some("layer:1"),
        Some(ExportNavigateRelation::Reference),
        Some("layer:missing"),
    );
    assert_rejected_with_parity(&unresolved_reference, "navigate_target_unresolved");

    let mut unresolved_provenance = valid.clone();
    let ConversationExportRecord::Turn(turn) = &mut unresolved_provenance[2] else {
        unreachable!()
    };
    turn.origin = ExportTurnOrigin::Action {
        source_turn_id: "turn:1".into(),
        source_action_id: "action:root-1".into(),
    };
    assert_rejected_with_parity(&unresolved_provenance, "action_origin_unresolved");

    let mut identity_conflict = valid.clone();
    let ConversationExportRecord::Turn(turn) = &mut identity_conflict[2] else {
        unreachable!()
    };
    turn.accepted_view.as_mut().unwrap().layers[0].nodes[0].detail =
        "Conflicting later definition".into();
    assert_rejected_with_parity(&identity_conflict, "node_identity_conflict");

    let mut missing = valid.clone();
    missing.pop();
    assert_rejected_with_parity(&missing, "turn_inventory_mismatch");

    let mut trailing = valid.clone();
    trailing.push(trailing[2].clone());
    assert_rejected_with_parity(&trailing, "turn_inventory_mismatch");
}

#[test]
fn admitted_model_plan_is_an_immutable_non_secret_export_snapshot() {
    let mut fixture = records();
    let ConversationExportRecord::Turn(turn) = &mut fixture[1] else {
        unreachable!()
    };
    turn.completion.attempt_admission_id = Some("admission-1".into());
    let mut plan = ExportAdmittedExecutionModelPlan {
        family_id: 1,
        family_revision: 4,
        orchestrator: ExportAdmittedExecutionModelRoute {
            provider_id: "codex".into(),
            adapter_id: "openai-api".into(),
            access_contract: "secret@1".into(),
            model_id: "gpt-test".into(),
            adapter_implementation_version: "7".into(),
        },
        roster: vec![ExportAdmittedExecutionModelRoute {
            provider_id: "codex".into(),
            adapter_id: "openai-api".into(),
            access_contract: "secret@1".into(),
            model_id: "gpt-test".into(),
            adapter_implementation_version: "7".into(),
        }],
        harness_policy_digest: format!("sha256:{}", "c".repeat(64)),
        digest: String::new(),
    };
    plan.digest = admitted_model_plan_digest(&plan).unwrap();
    turn.completion.admitted_model_plan = Some(plan);
    validate_export_records(&fixture).unwrap();
    let mut jsonl = Vec::new();
    for record in &fixture {
        serde_json::to_writer(&mut jsonl, record).unwrap();
        jsonl.push(b'\n');
    }
    let decoded = decode_export_jsonl(&jsonl).unwrap();
    assert_eq!(decoded, fixture);
    let encoded = String::from_utf8(jsonl).unwrap();
    assert!(encoded.contains("\"attemptAdmissionId\":\"admission-1\""));
    assert!(encoded.contains("\"accessContract\":\"secret@1\""));
    assert!(!encoded.contains("api-key"));
}

#[test]
fn admitted_model_plan_requires_its_selected_family_and_orchestrator() {
    let mut fixture = records();
    let ConversationExportRecord::Turn(turn) = &mut fixture[1] else {
        unreachable!()
    };
    turn.completion.attempt_admission_id = Some("admission-1".into());
    let route = ExportAdmittedExecutionModelRoute {
        provider_id: "codex".into(),
        adapter_id: "openai-api".into(),
        access_contract: "secret@1".into(),
        model_id: "gpt-test".into(),
        adapter_implementation_version: "7".into(),
    };
    let mut plan = ExportAdmittedExecutionModelPlan {
        family_id: 1,
        family_revision: 4,
        orchestrator: route.clone(),
        roster: vec![route],
        harness_policy_digest: format!("sha256:{}", "c".repeat(64)),
        digest: String::new(),
    };
    plan.digest = admitted_model_plan_digest(&plan).unwrap();
    turn.completion.admitted_model_plan = Some(plan);

    turn.completion.model_selection = None;
    assert_rejected_with_parity(&fixture, "admitted_model_selection_missing");

    for selection in [
        ExportModelSelection {
            provider_id: "other-provider".into(),
            model_id: "gpt-test".into(),
            model_family_id: 1,
        },
        ExportModelSelection {
            provider_id: "codex".into(),
            model_id: "other-model".into(),
            model_family_id: 1,
        },
        ExportModelSelection {
            provider_id: "codex".into(),
            model_id: "gpt-test".into(),
            model_family_id: 2,
        },
    ] {
        let ConversationExportRecord::Turn(turn) = &mut fixture[1] else {
            unreachable!()
        };
        turn.completion.model_selection = Some(selection);
        assert_rejected_with_parity(&fixture, "admitted_model_selection_mismatch");
    }

    let ConversationExportRecord::Turn(turn) = &mut fixture[1] else {
        unreachable!()
    };
    turn.completion.model_selection = Some(ExportModelSelection {
        provider_id: "codex".into(),
        model_id: "gpt-test".into(),
        model_family_id: 1,
    });
    turn.completion
        .admitted_model_plan
        .as_mut()
        .unwrap()
        .family_revision += 1;
    assert_rejected_with_parity(&fixture, "admitted_model_plan_digest_mismatch");
}

#[test]
fn submitted_inputs_round_trip_as_turn_owned_authority_free_children() {
    let mut fixture = two_turn_records();
    let ConversationExportRecord::Turn(source_turn) = &mut fixture[1] else {
        unreachable!()
    };
    let source_actions = &mut source_turn.accepted_view.as_mut().unwrap().layers[0].actions;
    source_actions.extend([
        input("action:text", "node:1", "layer:1"),
        input("action:single", "node:1", "layer:1"),
        input("action:multi", "node:1", "layer:1"),
    ]);

    let ConversationExportRecord::Turn(consuming_turn) = &mut fixture[2] else {
        unreachable!()
    };
    consuming_turn.text.clear();
    consuming_turn.interaction_node_id = Some("node:input-root-2".into());
    consuming_turn.origin = ExportTurnOrigin::User;
    consuming_turn.completion = receipt(ExportCompletionStatus::Failed);
    consuming_turn.accepted_view = None;
    let source = |action_id: &str| ExportInputSource {
        interaction_node_id: "node:interaction-1".into(),
        layer_id: "layer:1".into(),
        action_id: action_id.into(),
        node_id: "node:1".into(),
    };
    let single_options = vec![option("red", "Red"), option("blue", "Blue")];
    let multi_options = vec![option("a", "Alpha"), option("b", "Beta")];
    consuming_turn.submitted_inputs = vec![
        ExportSubmittedInput {
            id: "input-child:text".into(),
            root_turn_id: "turn:2".into(),
            source: source("action:text"),
            action: ExportInputActionSnapshot {
                control: ExportInputControl::Text,
                prompt: "Explain".into(),
                options: vec![],
                minimum_selections: None,
                unsupported_fields: Default::default(),
            },
            value: ExportSubmittedInputValue::Text {
                text: "Because".into(),
            },
        },
        ExportSubmittedInput {
            id: "input-child:single".into(),
            root_turn_id: "turn:2".into(),
            source: source("action:single"),
            action: ExportInputActionSnapshot {
                control: ExportInputControl::SingleSelect,
                prompt: "Choose one".into(),
                options: single_options.clone(),
                minimum_selections: None,
                unsupported_fields: Default::default(),
            },
            value: ExportSubmittedInputValue::Selected {
                selected: vec![single_options[1].clone()],
            },
        },
        ExportSubmittedInput {
            id: "input-child:multi".into(),
            root_turn_id: "turn:2".into(),
            source: source("action:multi"),
            action: ExportInputActionSnapshot {
                control: ExportInputControl::MultiSelect,
                prompt: "Choose several".into(),
                options: multi_options.clone(),
                minimum_selections: Some(2),
                unsupported_fields: Default::default(),
            },
            value: ExportSubmittedInputValue::Selected {
                selected: multi_options,
            },
        },
    ];
    consuming_turn.submitted_inputs.sort_by_key(|input| {
        serde_json::to_vec(&(
            &input.source.interaction_node_id,
            &input.source.layer_id,
            &input.source.action_id,
            &input.source.node_id,
            &input.action,
            &input.value,
        ))
        .unwrap()
    });

    validate_export_records(&fixture).unwrap();
    let mut jsonl = Vec::new();
    for record in &fixture {
        serde_json::to_writer(&mut jsonl, record).unwrap();
        jsonl.push(b'\n');
    }
    assert_eq!(decode_export_jsonl(&jsonl).unwrap(), fixture);

    let mut blank_activation_label = fixture.clone();
    let ConversationExportRecord::Turn(turn) = &mut blank_activation_label[1] else {
        unreachable!()
    };
    turn.accepted_view.as_mut().unwrap().layers[0].actions[0].label = "  ".into();
    assert_rejected_with_parity(&blank_activation_label, "string_empty");

    let encoded = String::from_utf8(jsonl.clone()).unwrap();
    let unsupported_control_jsonl =
        encoded.replacen("\"control\":\"single_select\"", "\"control\":\"slider\"", 1);
    let ExportReadError::Contract(error) =
        decode_export_jsonl(unsupported_control_jsonl.as_bytes()).unwrap_err()
    else {
        panic!("unknown controls must reach contract validation")
    };
    assert_eq!(error.code, "input_action_control_unsupported");
    let unsupported_control = unsupported_control_jsonl
        .lines()
        .enumerate()
        .map(|(index, line)| decode_export_record_line(line.as_bytes(), index + 1).unwrap())
        .collect::<Vec<_>>();
    assert_rejected_with_parity(&unsupported_control, "input_action_control_unsupported");

    let mut unresolved = fixture.clone();
    let ConversationExportRecord::Turn(turn) = &mut unresolved[2] else {
        unreachable!()
    };
    turn.submitted_inputs[0].source.action_id = "action:missing".into();
    assert_rejected_with_parity(&unresolved, "submitted_input_source_unresolved");

    let mut invalid_single_minimum = fixture.clone();
    let ConversationExportRecord::Turn(turn) = &mut invalid_single_minimum[2] else {
        unreachable!()
    };
    let single = turn
        .submitted_inputs
        .iter_mut()
        .find(|input| input.action.control == ExportInputControl::SingleSelect)
        .unwrap();
    single.action.minimum_selections = Some(1);
    assert_rejected_with_parity(&invalid_single_minimum, "input_action_minimum_unexpected");

    let single_only = || {
        let mut records = fixture.clone();
        let ConversationExportRecord::Turn(turn) = &mut records[2] else {
            unreachable!()
        };
        turn.submitted_inputs
            .retain(|input| input.action.control == ExportInputControl::SingleSelect);
        records
    };
    let mut oversized_prompt = single_only();
    let ConversationExportRecord::Turn(turn) = &mut oversized_prompt[2] else {
        unreachable!()
    };
    turn.submitted_inputs[0].action.prompt = "p".repeat(2_001);
    assert_rejected_with_parity(&oversized_prompt, "input_action_prompt_too_long");

    let mut blank_prompt = single_only();
    let ConversationExportRecord::Turn(turn) = &mut blank_prompt[2] else {
        unreachable!()
    };
    turn.submitted_inputs[0].action.prompt = "  ".into();
    assert_rejected_with_parity(&blank_prompt, "input_action_prompt_required");

    let mut missing_options = single_only();
    let ConversationExportRecord::Turn(turn) = &mut missing_options[2] else {
        unreachable!()
    };
    turn.submitted_inputs[0].action.options.clear();
    assert_rejected_with_parity(&missing_options, "input_action_options_required");

    let mut too_many_options = single_only();
    let ConversationExportRecord::Turn(turn) = &mut too_many_options[2] else {
        unreachable!()
    };
    turn.submitted_inputs[0].action.options = (0..51)
        .map(|index| option(&format!("key-{index}"), &format!("Option {index}")))
        .collect();
    assert_rejected_with_parity(&too_many_options, "input_action_option_count");

    let mut invalid_key = single_only();
    let ConversationExportRecord::Turn(turn) = &mut invalid_key[2] else {
        unreachable!()
    };
    turn.submitted_inputs[0].action.options[0].key = " untrimmed".into();
    assert_rejected_with_parity(&invalid_key, "input_action_option_key_invalid");

    let mut duplicate_key = single_only();
    let ConversationExportRecord::Turn(turn) = &mut duplicate_key[2] else {
        unreachable!()
    };
    turn.submitted_inputs[0].action.options[1].key =
        turn.submitted_inputs[0].action.options[0].key.clone();
    assert_rejected_with_parity(&duplicate_key, "input_action_option_key_duplicate");

    let mut blank_label = single_only();
    let ConversationExportRecord::Turn(turn) = &mut blank_label[2] else {
        unreachable!()
    };
    turn.submitted_inputs[0].action.options[0].label = "\t".into();
    assert_rejected_with_parity(&blank_label, "input_action_option_label_required");

    let mut oversized_label = single_only();
    let ConversationExportRecord::Turn(turn) = &mut oversized_label[2] else {
        unreachable!()
    };
    turn.submitted_inputs[0].action.options[0].label = "l".repeat(513);
    assert_rejected_with_parity(&oversized_label, "input_action_option_label_too_long");

    let multi_only = || {
        let mut records = fixture.clone();
        let ConversationExportRecord::Turn(turn) = &mut records[2] else {
            unreachable!()
        };
        turn.submitted_inputs
            .retain(|input| input.action.control == ExportInputControl::MultiSelect);
        records
    };

    let mut canonical_selection = multi_only();
    let ConversationExportRecord::Turn(turn) = &mut canonical_selection[2] else {
        unreachable!()
    };
    turn.submitted_inputs[0].action.options = vec![option("é", "Accent"), option("z", "Zed")];
    turn.submitted_inputs[0].value = ExportSubmittedInputValue::Selected {
        selected: vec![option("z", "Zed"), option("é", "Accent")],
    };
    validate_export_records(&canonical_selection).unwrap();
    validate_incrementally(&canonical_selection).unwrap();

    let mut reversed_selection = canonical_selection;
    let ConversationExportRecord::Turn(turn) = &mut reversed_selection[2] else {
        unreachable!()
    };
    let ExportSubmittedInputValue::Selected { selected } = &mut turn.submitted_inputs[0].value
    else {
        unreachable!()
    };
    selected.reverse();
    let batch_error = validate_export_records(&reversed_selection).unwrap_err();
    assert_eq!(batch_error.code, "input_selection_order_invalid");
    assert_eq!(
        batch_error.path,
        "record[2].submittedInputs[0].value.selected"
    );
    let incremental_error = validate_incrementally(&reversed_selection).unwrap_err();
    assert_eq!(incremental_error.code, batch_error.code);
    assert_eq!(incremental_error.path, batch_error.path);

    let mut invalid_minimum = multi_only();
    let ConversationExportRecord::Turn(turn) = &mut invalid_minimum[2] else {
        unreachable!()
    };
    turn.submitted_inputs[0].action.minimum_selections = Some(3);
    assert_rejected_with_parity(&invalid_minimum, "input_action_minimum_invalid");

    let mut duplicate_selection = multi_only();
    let ConversationExportRecord::Turn(turn) = &mut duplicate_selection[2] else {
        unreachable!()
    };
    let duplicate = turn.submitted_inputs[0].action.options[0].clone();
    let ExportSubmittedInputValue::Selected { selected } = &mut turn.submitted_inputs[0].value
    else {
        unreachable!()
    };
    selected.push(duplicate);
    assert_rejected_with_parity(&duplicate_selection, "input_option_duplicate");

    let mut unknown_selection = multi_only();
    let ConversationExportRecord::Turn(turn) = &mut unknown_selection[2] else {
        unreachable!()
    };
    let known = turn.submitted_inputs[0].action.options[1].clone();
    turn.submitted_inputs[0].value = ExportSubmittedInputValue::Selected {
        selected: vec![option("missing", "Missing"), known],
    };
    assert_rejected_with_parity(&unknown_selection, "input_option_unknown");

    let mut too_few_selections = multi_only();
    let ConversationExportRecord::Turn(turn) = &mut too_few_selections[2] else {
        unreachable!()
    };
    let selected = turn.submitted_inputs[0].action.options[0].clone();
    turn.submitted_inputs[0].value = ExportSubmittedInputValue::Selected {
        selected: vec![selected],
    };
    assert_rejected_with_parity(&too_few_selections, "input_selection_count");

    let text_only = || {
        let mut records = fixture.clone();
        let ConversationExportRecord::Turn(turn) = &mut records[2] else {
            unreachable!()
        };
        turn.submitted_inputs
            .retain(|input| input.action.control == ExportInputControl::Text);
        records
    };
    let mut unknown_action_field = text_only();
    let ConversationExportRecord::Turn(turn) = &mut unknown_action_field[2] else {
        unreachable!()
    };
    turn.submitted_inputs[0]
        .action
        .unsupported_fields
        .insert("sliderMin".into(), serde_json::Value::from(1));
    assert_rejected_with_parity(&unknown_action_field, "input_action_payload_unexpected");

    let mut unknown_option_field = single_only();
    let ConversationExportRecord::Turn(turn) = &mut unknown_option_field[2] else {
        unreachable!()
    };
    turn.submitted_inputs[0].action.options[0]
        .unsupported_fields
        .insert("imageUrl".into(), serde_json::Value::from("banner.png"));
    assert_rejected_with_parity(&unknown_option_field, "input_action_payload_unexpected");

    let mut blank_text = text_only();
    let ConversationExportRecord::Turn(turn) = &mut blank_text[2] else {
        unreachable!()
    };
    turn.submitted_inputs[0].value = ExportSubmittedInputValue::Text { text: " ".into() };
    assert_rejected_with_parity(&blank_text, "input_text_blank");

    let mut maximum_text = text_only();
    let ConversationExportRecord::Turn(turn) = &mut maximum_text[2] else {
        unreachable!()
    };
    turn.submitted_inputs[0].value = ExportSubmittedInputValue::Text {
        text: "x".repeat(MAX_STRING_BYTES),
    };
    validate_export_records(&maximum_text).unwrap();
    validate_incrementally(&maximum_text).unwrap();

    let mut oversized_text = maximum_text;
    let ConversationExportRecord::Turn(turn) = &mut oversized_text[2] else {
        unreachable!()
    };
    turn.submitted_inputs[0].value = ExportSubmittedInputValue::Text {
        text: "x".repeat(MAX_STRING_BYTES + 1),
    };
    let batch_error = validate_export_records(&oversized_text).unwrap_err();
    assert_eq!(batch_error.code, "string_too_large");
    assert_eq!(batch_error.path, "record[2].submittedInputs[0].value.text");
    let incremental_error = validate_incrementally(&oversized_text).unwrap_err();
    assert_eq!(incremental_error.code, batch_error.code);
    assert_eq!(incremental_error.path, batch_error.path);

    let mut text_with_options = text_only();
    let ConversationExportRecord::Turn(turn) = &mut text_with_options[2] else {
        unreachable!()
    };
    turn.submitted_inputs[0].action.options = vec![option("extra", "Extra")];
    assert_rejected_with_parity(&text_with_options, "input_action_options_unexpected");

    let mut text_with_selected = text_only();
    let ConversationExportRecord::Turn(turn) = &mut text_with_selected[2] else {
        unreachable!()
    };
    turn.submitted_inputs[0].value = ExportSubmittedInputValue::Selected { selected: vec![] };
    assert_rejected_with_parity(&text_with_selected, "input_action_snapshot_mismatch");

    let mut select_with_text = single_only();
    let ConversationExportRecord::Turn(turn) = &mut select_with_text[2] else {
        unreachable!()
    };
    turn.submitted_inputs[0].value = ExportSubmittedInputValue::Text {
        text: "wrong shape".into(),
    };
    assert_rejected_with_parity(&select_with_text, "input_action_snapshot_mismatch");
}
