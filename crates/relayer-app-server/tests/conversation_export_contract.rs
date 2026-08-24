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
        state: ExportRecordState::Accepted,
    }
}

fn layer(id: &str, node_id: &str, actions: Vec<ExportAction>) -> ExportResolvedLayer {
    ExportResolvedLayer {
        layer: ExportLayer {
            id: id.into(),
            nodes: vec![node_id.into()],
            edges: vec![],
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

fn receipt(status: ExportCompletionStatus) -> ExportCompletionReceipt {
    ExportCompletionReceipt {
        status,
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
            origin: ExportTurnOrigin::User,
            completion: receipt(ExportCompletionStatus::Accepted),
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
            origin: ExportTurnOrigin::Action {
                source_turn_id: "turn:1".into(),
                source_action_id: "action:invoke-1".into(),
            },
            completion: receipt(ExportCompletionStatus::Accepted),
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
    assert!(
        serde_json::from_str::<ConversationExportRecord>(r#"{"recordType":"artifact"}"#).is_err()
    );
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
            origin: ExportTurnOrigin::Action {
                source_turn_id: "turn:1".into(),
                source_action_id: "action:invoke-1".into(),
            },
            completion: receipt(ExportCompletionStatus::Accepted),
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
