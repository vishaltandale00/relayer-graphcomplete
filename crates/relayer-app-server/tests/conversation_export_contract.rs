use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use relayer_app_server::conversation_export::*;
use sha2::{Digest, Sha256};

fn action(
    id: &str,
    source_node_id: &str,
    source_layer_id: Option<&str>,
    relation: Option<ExportNavigateRelation>,
    target_layer_id: Option<&str>,
) -> ExportAction {
    ExportAction {
        converted_from_invoke: false,
        id: id.into(),
        client_key: None,
        source_node_id: source_node_id.into(),
        source_layer_id: source_layer_id.map(Into::into),
        kind: ExportActionKind::Navigate,
        relation,
        label: "Open".into(),
        variant: ExportActionVariant::Pill,
        icon: None,
        icon_asset: None,
        description: None,
        target_layer_id: target_layer_id.map(Into::into),
        interaction_text: None,
        input: None,
        input_action_ids: Vec::new(),
        reusable: None,
        state: ExportRecordState::Accepted,
    }
}

fn invoke(id: &str, source_node_id: &str, source_layer_id: &str) -> ExportAction {
    ExportAction {
        converted_from_invoke: false,
        id: id.into(),
        client_key: None,
        source_node_id: source_node_id.into(),
        source_layer_id: Some(source_layer_id.into()),
        kind: ExportActionKind::Invoke,
        relation: None,
        label: "Follow up".into(),
        variant: ExportActionVariant::Pill,
        icon: None,
        icon_asset: None,
        description: None,
        target_layer_id: None,
        interaction_text: Some("Continue".into()),
        input: None,
        input_action_ids: Vec::new(),
        reusable: None,
        state: ExportRecordState::Accepted,
    }
}

fn input(id: &str, source_node_id: &str, source_layer_id: &str) -> ExportAction {
    ExportAction {
        converted_from_invoke: false,
        id: id.into(),
        client_key: None,
        source_node_id: source_node_id.into(),
        source_layer_id: Some(source_layer_id.into()),
        kind: ExportActionKind::Input,
        relation: None,
        label: "Respond".into(),
        variant: ExportActionVariant::Pill,
        icon: None,
        icon_asset: None,
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
        input_action_ids: Vec::new(),
        reusable: None,
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
            default_node_id: None,
            id: id.into(),
            client_key: None,
            nodes: vec![node_id.into()],
            edges: vec![],
            layout: Some(ExportLayerLayout {
                version: 1,
                placements: vec![ExportNodePlacement {
                    node_id: node_id.into(),
                    x: 0.5,
                    y: 0.5,
                }],
                edge_shape: Some("elbow-horizontal".into()),
                edge_routes: Vec::new(),
            }),
            state: ExportRecordState::Accepted,
            renderer: None,
        },
        nodes: vec![ExportNode {
            id: node_id.into(),
            client_key: None,
            kind: "concept".into(),
            icon: "file".into(),
            title: format!("Node {node_id}"),
            detail: "Durable accepted detail".into(),
            authored_detail: Some(serde_json::json!({
                "version": 1,
                "components": [{"id":"summary","order":0,"html":"<p>Durable</p><a data-gc-capability=\"open\">Open</a>","css":""}],
                "mounts": [{"id":"open","componentId":"summary","kind":"capability","host":"a","capability":{"kind":"link","href":"https://example.com"}}],
                "assets": [],
                "integritySha256": "49b27b37e787326e0cc4bd1c62a67f65daf3a9184e1c7f792d8ec091b50456ad"
            })),
            authored_detail_omitted: None,
            authored_detail_assets: vec![],
            state: ExportRecordState::Accepted,
            artifact: None,
        }],
        edges: vec![],
        actions,
    }
}

#[test]
fn canonical_authored_detail_survives_export_record_serialization() {
    let records = records();
    validate_export_records(&records).unwrap();
    let encoded = serde_json::to_vec(&records[1]).unwrap();
    let decoded: ConversationExportRecord = serde_json::from_slice(&encoded).unwrap();
    let ConversationExportRecord::Turn(turn) = decoded else {
        panic!("second record must be a turn")
    };
    let view = turn.accepted_view.unwrap();
    let package = view.layers[0].nodes[0].authored_detail.as_ref().unwrap();
    assert_eq!(package["components"][0]["id"], "summary");
    assert_eq!(package["components"][0]["order"], 0);
    assert_eq!(package["mounts"][0]["capability"]["kind"], "link");
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
            icon_asset: None,
            title: "Node node:1".into(),
            detail: "Durable accepted detail".into(),
            state: ExportRecordState::Accepted,
        },
        source: ExportContextSource {
            owner_turn_id: None,
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
            visual_asset_contents: vec![],
            invocations: vec![],
            bound_inputs: vec![],
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

fn reusable_call(id: &str, child: &str) -> ExportInvocation {
    ExportInvocation {
        schema_version: 1,
        id: id.into(),
        activator: None,
        source: ExportInvocationSource {
            interaction_node_id: "node:interaction-1".into(),
            action_id: "action:invoke-1".into(),
            parent_node_id: "node:1".into(),
            layer_id: Some("layer:1".into()),
            presenting_layer_id: Some("layer:1".into()),
            capture_state: Some(ExportInvocationCaptureState::Accepted),
            instruction: "Continue".into(),
            label: "Follow up".into(),
            description: None,
            icon: None,
            icon_asset: None,
            icon_asset_omitted: false,
            variant: ExportActionVariant::Pill,
            input_action_ids: vec![],
            input_bindings_defined: true,
            reusable: None,
            parent_title: "Parent".into(),
            parent_detail: "Analysis".into(),
            state: "accepted".into(),
        },
        child_interaction_node_id: child.into(),
        result_turn_id: None,
        lifecycle: "active".into(),
        safe_reason: None,
        head_revision: 0,
        current_layer_id: None,
        returned_layer_id: None,
        arguments: vec![],
        current: None,
    }
}

fn accepted_callable_records(current_only: bool) -> Vec<ConversationExportRecord> {
    let mut fixture = records();
    let mut call = reusable_call("invocation:source-check", "node:source-check-child");
    if current_only {
        let ConversationExportRecord::Turn(turn) = &mut fixture[1] else {
            unreachable!()
        };
        let view = turn.accepted_view.take().unwrap();
        turn.completion = receipt(ExportCompletionStatus::Stopped);
        call.head_revision = 1;
        call.current_layer_id = Some(view.root_layer_id.clone());
        call.current = Some(ExportInvocationCurrent {
            root_layer_id: view.root_layer_id,
            layers: view.layers,
        });
    }
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.export_version = EXPORT_VERSION_V4;
    header.invocations = vec![call];
    fixture
}

#[test]
fn v4_accepted_callable_matches_canonical_definition_in_turn_or_current_inventory() {
    for current_only in [false, true] {
        let baseline = accepted_callable_records(current_only);
        validate_export_records(&baseline).unwrap();
        assert_validation_parity(&baseline);
        for field in [
            "instruction",
            "label",
            "presentation",
            "icon",
            "source-node",
            "authored-layer",
            "bindings",
            "reuse",
            "state",
            "kind",
        ] {
            let mut invalid = baseline.clone();
            let ConversationExportRecord::Header(header) = &mut invalid[0] else {
                unreachable!()
            };
            let source = &mut header.invocations[0].source;
            match field {
                "instruction" => source.instruction = "Forged instruction".into(),
                "label" => source.label = "Forged label".into(),
                "presentation" => {
                    source.variant = ExportActionVariant::Card;
                    source.description = Some("Forged card".into());
                }
                "icon" => source.icon = Some("circle".into()),
                "source-node" => source.parent_node_id = "node:another-parent".into(),
                "authored-layer" => source.layer_id = Some("layer:another-source".into()),
                "bindings" => source.input_action_ids = vec!["action:unexpected".into()],
                "reuse" => source.reusable = Some(false),
                "state" => source.state = "stopped".into(),
                "kind" => source.action_id = "action:root-1".into(),
                _ => unreachable!(),
            }
            if field == "bindings" {
                let question = input("action:unexpected", "node:1", "layer:1");
                let call = &mut header.invocations[0];
                call.arguments = vec![ExportInvocationArgument {
                    source: ExportInputSource {
                        interaction_node_id: call.source.interaction_node_id.clone(),
                        layer_id: "layer:1".into(),
                        action_id: question.id.clone(),
                        node_id: "node:1".into(),
                    },
                    action: question.input.clone().unwrap(),
                    value: ExportSubmittedInputValue::Text {
                        text: "A valid but undeclared answer".into(),
                    },
                }];
                header.bound_inputs.push(question);
            }
            // Current carries no root action, so use an included Input with the
            // same ID to test wrong-kind resolution in that inventory as well.
            if current_only && field == "kind" {
                let call = &mut header.invocations[0];
                call.source.action_id = "action:wrong-kind".into();
                call.current.as_mut().unwrap().layers[0].actions.push(input(
                    "action:wrong-kind",
                    "node:1",
                    "layer:1",
                ));
            }
            assert_rejected_with_parity(&invalid, "invocation_source_snapshot_mismatch");
        }
    }
}

#[test]
fn v4_known_captures_require_a_presenting_layer_but_historical_unknowns_remain_readable() {
    for capture in [
        ExportInvocationCaptureState::Draft,
        ExportInvocationCaptureState::Accepted,
    ] {
        let mut fixture = accepted_callable_records(false);
        let ConversationExportRecord::Header(header) = &mut fixture[0] else {
            unreachable!()
        };
        header.invocations[0].source.capture_state = Some(capture);
        header.invocations[0].source.presenting_layer_id = None;
        assert_rejected_with_parity(&fixture, "invocation_presenting_layer_missing");
        let ConversationExportRecord::Header(header) = &mut fixture[0] else {
            unreachable!()
        };
        header.invocations[0].source.capture_state = None;
        validate_export_records(&fixture).unwrap();
        assert_validation_parity(&fixture);
    }
}

#[test]
fn v4_draft_and_unknown_calls_retain_original_definitions_after_parent_repair() {
    for capture in [None, Some(ExportInvocationCaptureState::Draft)] {
        let mut fixture = accepted_callable_records(false);
        let ConversationExportRecord::Header(header) = &mut fixture[0] else {
            unreachable!()
        };
        let source = &mut header.invocations[0].source;
        source.capture_state = capture;
        source.instruction = "Earlier draft instruction".into();
        source.label = "Earlier draft label".into();
        source.reusable = Some(false);
        // Display state may already be accepted after repair. Capture state is
        // the separate provenance that prevents history from being rewritten.
        source.state = "accepted".into();
        if capture.is_none() {
            source.presenting_layer_id = None;
        }
        validate_export_records(&fixture).unwrap();
        assert_validation_parity(&fixture);
        let encoded = fixture
            .iter()
            .map(|record| serde_json::to_string(record).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(decode_export_jsonl(encoded.as_bytes()).unwrap(), fixture);
    }
}

#[test]
fn v4_empty_multi_select_preserves_native_unset_minimum_and_refuses_explicit_positive_minimum() {
    let mut fixture = accepted_callable_records(false);
    let mut question = input("action:optional", "node:1", "layer:1");
    question.input.as_mut().unwrap().control = ExportInputControl::MultiSelect;
    question.input.as_mut().unwrap().options = vec![option("a", "A")];
    let ConversationExportRecord::Turn(turn) = &mut fixture[1] else {
        unreachable!()
    };
    let layer = &mut turn.accepted_view.as_mut().unwrap().layers[0];
    layer
        .actions
        .iter_mut()
        .find(|action| action.kind == ExportActionKind::Invoke)
        .unwrap()
        .input_action_ids = vec![question.id.clone()];
    layer.actions.push(question.clone());
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    let call = &mut header.invocations[0];
    call.source.input_action_ids = vec![question.id.clone()];
    call.arguments = vec![ExportInvocationArgument {
        source: ExportInputSource {
            interaction_node_id: call.source.interaction_node_id.clone(),
            layer_id: "layer:1".into(),
            action_id: question.id.clone(),
            node_id: "node:1".into(),
        },
        action: question.input.unwrap(),
        value: ExportSubmittedInputValue::Selected { selected: vec![] },
    }];
    validate_export_records(&fixture).unwrap();
    assert_validation_parity(&fixture);
    let encoded = fixture
        .iter()
        .map(|record| serde_json::to_string(record).unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(decode_export_jsonl(encoded.as_bytes()).unwrap(), fixture);
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.invocations[0].arguments[0].action.minimum_selections = Some(1);
    assert_rejected_with_parity(&fixture, "invocation_argument_value_invalid");
}

#[test]
fn v4_aggregate_frozen_arguments_retain_the_existing_jsonl_header_byte_limit() {
    for count in [5, 6] {
        let mut fixture = accepted_callable_records(false);
        let question = input("action:large-answer", "node:1", "layer:1");
        let ConversationExportRecord::Turn(turn) = &mut fixture[1] else {
            unreachable!()
        };
        let layer = &mut turn.accepted_view.as_mut().unwrap().layers[0];
        let invoke = layer
            .actions
            .iter_mut()
            .find(|action| action.kind == ExportActionKind::Invoke)
            .unwrap();
        invoke.reusable = Some(true);
        invoke.input_action_ids = vec![question.id.clone()];
        layer.actions.push(question.clone());
        let ConversationExportRecord::Header(header) = &mut fixture[0] else {
            unreachable!()
        };
        header.invocations = (0..count)
            .map(|index| {
                let mut call = reusable_call(
                    &format!("invocation:large-{index}"),
                    &format!("node:large-child-{index}"),
                );
                call.source.reusable = Some(true);
                call.source.input_action_ids = vec![question.id.clone()];
                call.arguments = vec![ExportInvocationArgument {
                    source: ExportInputSource {
                        interaction_node_id: call.source.interaction_node_id.clone(),
                        layer_id: "layer:1".into(),
                        action_id: question.id.clone(),
                        node_id: "node:1".into(),
                    },
                    action: question.input.clone().unwrap(),
                    value: ExportSubmittedInputValue::Text {
                        text: "x".repeat(3 * 1024 * 1024),
                    },
                }];
                call
            })
            .collect();
        // Each argument is individually valid; only the encoded aggregate
        // header encounters the existing resource refusal. No invocation is lost.
        validate_export_records(&fixture).unwrap();
        assert_validation_parity(&fixture);
        let line = serde_json::to_vec(&fixture[0]).unwrap();
        if count == 5 {
            assert!(line.len() < MAX_JSONL_LINE_BYTES);
            assert_eq!(decode_export_record_line(&line, 1).unwrap(), fixture[0]);
        } else {
            assert!(line.len() > MAX_JSONL_LINE_BYTES);
            assert!(matches!(
                decode_export_record_line(&line, 1),
                Err(ExportReadError::LineTooLarge { line: 1 })
            ));
        }
    }
}

#[test]
fn v4_calls_preserve_distinct_identity_and_never_promote_retained_current_to_returned() {
    let mut fixture = records();
    let current = accepted_view();
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.export_version = EXPORT_VERSION_V4;
    let first = reusable_call("invocation:1", "node:call-1");
    let mut second = reusable_call("invocation:2", "node:call-2");
    second.lifecycle = "stopped".into();
    second.safe_reason = Some("cancelled".into());
    second.head_revision = 1;
    second.current_layer_id = Some(current.root_layer_id.clone());
    second.current = Some(ExportInvocationCurrent {
        root_layer_id: current.root_layer_id,
        layers: current.layers,
    });
    header.invocations = vec![first, second];
    assert_validation_parity(&fixture);
    let bytes = fixture
        .iter()
        .map(|record| serde_json::to_string(record).unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    let decoded = decode_export_jsonl(bytes.as_bytes()).unwrap();
    assert_eq!(decoded, fixture);
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.invocations[1].returned_layer_id = header.invocations[1].current_layer_id.clone();
    assert_rejected_with_parity(&fixture, "invocation_current_returned_mismatch");
}

#[test]
fn v4_rejects_forged_schema_duplicate_children_and_dangling_results() {
    let mut fixture = records();
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.export_version = EXPORT_VERSION_V4;
    header.invocations = vec![reusable_call("invocation:1", "node:call-1")];
    header.invocations[0].schema_version = 2;
    assert_rejected_with_parity(&fixture, "invocation_identity_invalid");
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.invocations[0].schema_version = 1;
    header
        .invocations
        .push(reusable_call("invocation:2", "node:call-1"));
    assert_rejected_with_parity(&fixture, "invocation_identity_invalid");
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.invocations.pop();
    header.invocations[0].result_turn_id = Some("turn:missing".into());
    assert_rejected_with_parity(&fixture, "invocation_result_unresolved");
}

#[test]
fn v4_preserves_explicit_single_or_reusable_policy_and_historical_omission() {
    for policy in [None, Some(false), Some(true)] {
        let mut fixture = records();
        let ConversationExportRecord::Header(header) = &mut fixture[0] else {
            unreachable!()
        };
        header.export_version = EXPORT_VERSION_V4;
        let mut call = reusable_call("invocation:policy", "node:policy-child");
        call.source.reusable = policy;
        header.invocations = vec![call];
        let ConversationExportRecord::Turn(turn) = &mut fixture[1] else {
            unreachable!()
        };
        turn.accepted_view.as_mut().unwrap().layers[0]
            .actions
            .iter_mut()
            .find(|action| action.kind == ExportActionKind::Invoke)
            .unwrap()
            .reusable = policy;
        assert_validation_parity(&fixture);
        let bytes = fixture
            .iter()
            .map(|record| serde_json::to_string(record).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(decode_export_jsonl(bytes.as_bytes()).unwrap(), fixture);
        if policy.is_some() {
            let ConversationExportRecord::Header(header) = &mut fixture[0] else {
                unreachable!()
            };
            header.invocations.clear();
            header.export_version = EXPORT_VERSION_V3;
            assert_rejected_with_parity(&fixture, "invoke_reuse_policy_version");
        }
    }
}

#[test]
fn v4_preserves_uncalled_explicit_input_bindings_and_rejects_wrong_source() {
    let mut fixture = records();
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.export_version = EXPORT_VERSION_V4;
    let ConversationExportRecord::Turn(turn) = &mut fixture[1] else {
        unreachable!()
    };
    let root = &mut turn.accepted_view.as_mut().unwrap().layers[0];
    root.actions
        .push(input("action:question", "node:1", "layer:1"));
    root.actions
        .iter_mut()
        .find(|action| action.kind == ExportActionKind::Invoke)
        .unwrap()
        .input_action_ids = vec!["action:question".into()];
    assert_validation_parity(&fixture);
    let ConversationExportRecord::Turn(turn) = &mut fixture[1] else {
        unreachable!()
    };
    turn.accepted_view.as_mut().unwrap().layers[0]
        .actions
        .iter_mut()
        .find(|action| action.kind == ExportActionKind::Invoke)
        .unwrap()
        .input_action_ids = vec!["action:root-1".into()];
    assert_rejected_with_parity(&fixture, "invoke_input_binding_unresolved");
}

// Mirror the public reader's resource-bound scenarios. Definitions outside Layer
// membership remain canonical; binding IDs are not Layer action membership.
#[test]
fn v4_bindings_are_not_layer_membership_but_prepared_arguments_are_bounded() {
    for count in [65, 256, 257] {
        let mut fixture = records();
        let inputs = (0..count)
            .map(|index| input(&format!("action:question-{index}"), "node:1", "layer:1"))
            .collect::<Vec<_>>();
        let ids = inputs
            .iter()
            .map(|input| input.id.clone())
            .collect::<Vec<_>>();
        let ConversationExportRecord::Header(header) = &mut fixture[0] else {
            unreachable!()
        };
        header.export_version = EXPORT_VERSION_V4;
        header.bound_inputs = inputs.clone();
        let ConversationExportRecord::Turn(turn) = &mut fixture[1] else {
            unreachable!()
        };
        let root = &mut turn.accepted_view.as_mut().unwrap().layers[0];
        root.actions
            .iter_mut()
            .find(|action| action.kind == ExportActionKind::Invoke)
            .unwrap()
            .input_action_ids = ids.clone();
        validate_export_records(&fixture).unwrap();
        assert_validation_parity(&fixture);
        let mut call = reusable_call("invocation:many", "node:call-many");
        call.source.input_action_ids = ids;
        call.arguments = inputs
            .iter()
            .map(|input| ExportInvocationArgument {
                source: ExportInputSource {
                    interaction_node_id: "node:interaction-1".into(),
                    layer_id: "layer:1".into(),
                    action_id: input.id.clone(),
                    node_id: input.source_node_id.clone(),
                },
                action: input.input.clone().unwrap(),
                value: ExportSubmittedInputValue::Text {
                    text: "Lisbon".into(),
                },
            })
            .collect();
        let ConversationExportRecord::Header(header) = &mut fixture[0] else {
            unreachable!()
        };
        header.invocations = vec![call];
        if count == 257 {
            assert_rejected_with_parity(&fixture, "invocation_arguments_invalid");
        } else {
            validate_export_records(&fixture).unwrap();
            assert_validation_parity(&fixture);
        }
    }
}

#[test]
fn v4_frozen_presentation_and_head_revision_match_portable_json_readers() {
    let mut fixture = records();
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.export_version = EXPORT_VERSION_V4;
    let mut call = reusable_call("invocation:card", "node:card-call");
    call.head_revision = MAX_PORTABLE_HEAD_REVISION;
    call.source.capture_state = Some(ExportInvocationCaptureState::Draft);
    call.source.variant = ExportActionVariant::Card;
    call.source.description = Some("Frozen card explanation".into());
    header.invocations = vec![call];
    validate_export_records(&fixture).unwrap();
    assert_validation_parity(&fixture);
    let mut unicode = fixture.clone();
    let ConversationExportRecord::Header(header) = &mut unicode[0] else {
        unreachable!()
    };
    header.conversation.title = "\u{feff}".into();
    header.invocations[0].source.instruction = "\u{feff}".into();
    header.invocations[0].source.description = Some("\u{feff}".into());
    let ConversationExportRecord::Turn(turn) = &mut unicode[1] else {
        unreachable!()
    };
    let invoke = turn.accepted_view.as_mut().unwrap().layers[0]
        .actions
        .iter_mut()
        .find(|action| action.kind == ExportActionKind::Invoke)
        .unwrap();
    invoke.interaction_text = Some("\u{feff}".into());
    invoke.variant = ExportActionVariant::Card;
    invoke.description = Some("\u{feff}".into());
    validate_export_records(&unicode).unwrap();
    assert_validation_parity(&unicode);
    for field in [
        "title",
        "canonicalInstruction",
        "canonicalDescription",
        "frozenInstruction",
        "frozenDescription",
    ] {
        let mut invalid = unicode.clone();
        if field.starts_with("canonical") {
            let ConversationExportRecord::Turn(turn) = &mut invalid[1] else {
                unreachable!()
            };
            let action = turn.accepted_view.as_mut().unwrap().layers[0]
                .actions
                .iter_mut()
                .find(|action| action.kind == ExportActionKind::Invoke)
                .unwrap();
            if field == "canonicalInstruction" {
                action.interaction_text = Some("\u{85}".into());
            } else {
                action.description = Some("\u{85}".into());
            }
        } else {
            let ConversationExportRecord::Header(header) = &mut invalid[0] else {
                unreachable!()
            };
            if field == "title" {
                header.conversation.title = "\u{85}".into();
            } else if field == "frozenInstruction" {
                header.invocations[0].source.instruction = "\u{85}".into();
            } else {
                header.invocations[0].source.description = Some("\u{85}".into());
            }
        }
        assert_rejected_with_parity(
            &invalid,
            if field == "canonicalInstruction" {
                "invalid_action_shape"
            } else {
                "string_empty"
            },
        );
    }
    for (change, code) in [
        ("head", "invocation_head_revision_invalid"),
        ("missing", "invocation_source_invalid"),
        ("pill", "invocation_source_invalid"),
        ("empty", "string_empty"),
    ] {
        let mut invalid = fixture.clone();
        let ConversationExportRecord::Header(header) = &mut invalid[0] else {
            unreachable!()
        };
        let call = &mut header.invocations[0];
        match change {
            "head" => call.head_revision += 1,
            "missing" => call.source.description = None,
            "pill" => call.source.variant = ExportActionVariant::Pill,
            _ => call.source.description = Some(" ".into()),
        }
        assert_rejected_with_parity(&invalid, code);
    }
}

#[test]
fn v4_call_history_is_not_a_canonical_action_replacement_or_an_authority_carrier() {
    let mut fixture = records();
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.export_version = EXPORT_VERSION_V4;
    let mut prior = reusable_call("invocation:1", "node:call-1");
    prior.source.capture_state = Some(ExportInvocationCaptureState::Draft);
    prior.source.instruction = "Earlier draft instruction".into();
    prior.source.label = "Earlier draft label".into();
    header.invocations = vec![prior];
    assert_validation_parity(&fixture);
    let mut json = serde_json::to_value(&fixture[0]).unwrap();
    json["invocations"][0]["authorities"] = serde_json::json!(["invoke.resolve"]);
    assert!(serde_json::from_value::<ConversationExportRecord>(json).is_err());
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.export_version = EXPORT_VERSION_V3;
    assert_rejected_with_parity(&fixture, "invocation_inventory_version");
}

#[test]
fn v4_arguments_must_exactly_answer_the_frozen_callable_bindings() {
    let mut fixture = records();
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.export_version = EXPORT_VERSION_V4;
    let mut call = reusable_call("invocation:1", "node:call-1");
    call.source.input_action_ids = vec!["action:question".into()];
    header.invocations = vec![call];
    assert_rejected_with_parity(&fixture, "invocation_argument_binding_mismatch");
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.invocations[0]
        .arguments
        .push(ExportInvocationArgument {
            source: ExportInputSource {
                interaction_node_id: "node:interaction-1".into(),
                layer_id: "layer:1".into(),
                action_id: "action:question".into(),
                node_id: "node:1".into(),
            },
            action: ExportInputActionSnapshot {
                control: ExportInputControl::Text,
                prompt: "Destination".into(),
                options: vec![],
                minimum_selections: None,
                unsupported_fields: Default::default(),
            },
            value: ExportSubmittedInputValue::Text {
                text: "Kyoto".into(),
            },
        });
    assert_validation_parity(&fixture);
    let mut foreign_node = fixture.clone();
    let ConversationExportRecord::Header(header) = &mut foreign_node[0] else {
        unreachable!()
    };
    header.invocations[0].arguments[0].source.node_id = "node:foreign".into();
    assert_rejected_with_parity(&foreign_node, "invocation_argument_binding_mismatch");
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.invocations[0].source.presenting_layer_id = Some("layer:1".into());
    assert_validation_parity(&fixture);
    for changed in ["layer", "interaction"] {
        let mut saved_occurrence = fixture.clone();
        let ConversationExportRecord::Header(header) = &mut saved_occurrence[0] else {
            unreachable!()
        };
        if changed == "layer" {
            header.invocations[0].arguments[0].source.layer_id = "layer:other".into();
        } else {
            header.invocations[0].arguments[0]
                .source
                .interaction_node_id = "node:other-interaction".into();
        }
        // The accepted Input answer may have been saved from another occurrence
        // of this same Node before Invoke is activated from the current Layer.
        assert_validation_parity(&saved_occurrence);
    }
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.invocations[0].source.input_action_ids.clear();
    assert_rejected_with_parity(&fixture, "invocation_argument_binding_mismatch");
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.invocations[0].source.input_bindings_defined = false;
    // Genuine pre-binding sources froze occurrence-based arguments. Their inert
    // history remains readable; omission cannot create native preparation authority.
    assert_rejected_with_parity(&fixture, "invocation_argument_binding_mismatch");
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.invocations[0].source.capture_state = None;
    header.invocations[0].source.presenting_layer_id = None;
    let mut second = header.invocations[0].arguments[0].clone();
    second.source.layer_id = "layer:historical-second-occurrence".into();
    header.invocations[0].arguments.push(second);
    assert_validation_parity(&fixture);
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.invocations[0].arguments[1].source.layer_id = "layer:1".into();
    assert_rejected_with_parity(&fixture, "invocation_argument_duplicate");
}

#[test]
fn v4_standalone_inputs_match_the_exact_frozen_argument_question_and_source() {
    let mut fixture = records();
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.export_version = EXPORT_VERSION_V4;
    let question = input("action:question", "node:1", "layer:1");
    let mut call = reusable_call("invocation:1", "node:call-1");
    call.source.input_action_ids = vec![question.id.clone()];
    call.arguments.push(ExportInvocationArgument {
        source: ExportInputSource {
            interaction_node_id: "node:interaction-1".into(),
            layer_id: "layer:1".into(),
            action_id: question.id.clone(),
            node_id: "node:1".into(),
        },
        action: question.input.clone().unwrap(),
        value: ExportSubmittedInputValue::Text {
            text: "Kyoto".into(),
        },
    });
    header.bound_inputs = vec![question];
    header.invocations = vec![call];
    assert_validation_parity(&fixture);
    for field in ["prompt", "source", "control"] {
        let mut invalid = fixture.clone();
        let ConversationExportRecord::Header(header) = &mut invalid[0] else {
            unreachable!()
        };
        match field {
            "prompt" => {
                header.bound_inputs[0].input.as_mut().unwrap().prompt = "Different question".into()
            }
            "source" => {
                header.bound_inputs[0].source_node_id = "node:2".into();
                let ConversationExportRecord::Turn(turn) = &mut invalid[1] else {
                    unreachable!()
                };
                let mut other = turn.accepted_view.as_ref().unwrap().layers[0].nodes[0].clone();
                other.id = "node:2".into();
                let layer = &mut turn.accepted_view.as_mut().unwrap().layers[0];
                layer.layer.nodes.push(other.id.clone());
                layer.nodes.push(other);
                layer.layer.edges.push("edge:other-source".into());
                layer.edges.push(ExportEdge {
                    id: "edge:other-source".into(),
                    endpoints: ["node:1".into(), "node:2".into()],
                    state: ExportRecordState::Accepted,
                });
                layer.layer.layout = None;
            }
            _ => {
                let question = header.bound_inputs[0].input.as_mut().unwrap();
                question.control = ExportInputControl::SingleSelect;
                question.options = vec![option("city", "Kyoto")];
            }
        }
        assert_rejected_with_parity(&invalid, "invocation_argument_snapshot_mismatch");
    }
    for historical in [false, true] {
        let mut prior = fixture.clone();
        let ConversationExportRecord::Header(header) = &mut prior[0] else {
            unreachable!()
        };
        header.bound_inputs[0].input.as_mut().unwrap().prompt = "Repaired parent question".into();
        if historical {
            header.invocations[0].source.input_action_ids.clear();
            header.invocations[0].source.input_bindings_defined = false;
            header.invocations[0].source.capture_state = None;
        } else {
            header.invocations[0].source.state = "draft".into();
            header.invocations[0].source.capture_state = Some(ExportInvocationCaptureState::Draft);
        }
        assert_validation_parity(&prior);
    }
    // The same immutable-input boundary applies when the canonical definition is
    // carried by an accepted Layer instead of the standalone inventory.
    let mut mounted = fixture.clone();
    let ConversationExportRecord::Header(header) = &mut mounted[0] else {
        unreachable!()
    };
    let question = header.bound_inputs.remove(0);
    let ConversationExportRecord::Turn(turn) = &mut mounted[1] else {
        unreachable!()
    };
    turn.accepted_view.as_mut().unwrap().layers[0]
        .actions
        .push(question);
    assert_validation_parity(&mounted);
    let ConversationExportRecord::Turn(turn) = &mut mounted[1] else {
        unreachable!()
    };
    turn.accepted_view.as_mut().unwrap().layers[0]
        .actions
        .last_mut()
        .unwrap()
        .input
        .as_mut()
        .unwrap()
        .prompt = "Repaired question".into();
    assert_rejected_with_parity(&mounted, "invocation_argument_snapshot_mismatch");
    let ConversationExportRecord::Header(header) = &mut mounted[0] else {
        unreachable!()
    };
    header.invocations[0].source.capture_state = Some(ExportInvocationCaptureState::Draft);
    assert_validation_parity(&mounted);
}

#[test]
fn v4_call_result_requires_an_accepted_turn_and_exact_returned_root() {
    let mut fixture = records();
    let mut view = accepted_view();
    view.interaction_node_id = "node:call-1".into();
    view.root_action.id = "action:call-root".into();
    view.root_action.source_node_id = view.interaction_node_id.clone();
    view.root_action.target_layer_id = Some("layer:call".into());
    view.root_layer_id = "layer:call".into();
    view.layers[0].layer.id = "layer:call".into();
    view.layers[0].actions.clear();
    let mut call = reusable_call("invocation:1", "node:call-1");
    call.lifecycle = "succeeded".into();
    call.result_turn_id = Some("turn:2".into());
    call.head_revision = 1;
    call.current_layer_id = Some(view.root_layer_id.clone());
    call.returned_layer_id = Some(view.root_layer_id.clone());
    call.current = Some(ExportInvocationCurrent {
        root_layer_id: view.root_layer_id.clone(),
        layers: view.layers.clone(),
    });
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.export_version = EXPORT_VERSION_V4;
    header.turns.push(ExportTurnManifestEntry {
        id: "turn:2".into(),
        sequence: 2,
    });
    header.invocations = vec![call];
    fixture.push(ConversationExportRecord::Turn(Box::new(
        ConversationExportTurn {
            id: "turn:2".into(),
            sequence: 2,
            created_at: "2".into(),
            text: "Continue".into(),
            interaction_node_id: Some("node:call-1".into()),
            origin: ExportTurnOrigin::Invocation {
                invocation_id: "invocation:1".into(),
            },
            completion: receipt(ExportCompletionStatus::Accepted),
            contexts: vec![],
            submitted_inputs: vec![],
            accepted_view: Some(view),
        },
    )));
    validate_export_records(&fixture).unwrap();
    assert_validation_parity(&fixture);
    // Rust Product required(text) trims Unicode White_Space, preserving BOM
    // and Unicode composition. Native frozen text itself is never rewritten.
    for instruction in [
        "\u{85}\u{2003} Continue [project]/private.txt \u{85}",
        "\u{feff}Continue [project]/private.txt\u{feff}",
        "Cafe\u{301}",
    ] {
        let mut whitespace = fixture.clone();
        let ConversationExportRecord::Header(header) = &mut whitespace[0] else {
            unreachable!()
        };
        header.invocations[0].source.capture_state = Some(ExportInvocationCaptureState::Draft);
        header.invocations[0].source.instruction = instruction.into();
        for text in [instruction, instruction.trim()] {
            let ConversationExportRecord::Turn(turn) = &mut whitespace[2] else {
                unreachable!()
            };
            turn.text = text.into();
            validate_export_records(&whitespace).unwrap();
            assert_validation_parity(&whitespace);
        }
        let ConversationExportRecord::Turn(turn) = &mut whitespace[2] else {
            unreachable!()
        };
        turn.text = if instruction.contains('\u{feff}') {
            "Continue [project]/private.txt".into()
        } else if instruction == "Cafe\u{301}" {
            "Café".into()
        } else {
            "A contradictory instruction".into()
        };
        assert_rejected_with_parity(&whitespace, "invocation_result_mismatch");
    }
    let mut wrong_root = fixture.clone();
    let ConversationExportRecord::Header(header) = &mut wrong_root[0] else {
        unreachable!()
    };
    let call = &mut header.invocations[0];
    call.current_layer_id = Some("layer:other-return".into());
    call.returned_layer_id = call.current_layer_id.clone();
    let current = call.current.as_mut().unwrap();
    current.root_layer_id = "layer:other-return".into();
    current.layers[0].layer.id = "layer:other-return".into();
    assert_rejected_with_parity(&wrong_root, "invocation_result_mismatch");
    let ConversationExportRecord::Turn(turn) = &mut fixture[2] else {
        unreachable!()
    };
    turn.completion = receipt(ExportCompletionStatus::Stopped);
    turn.accepted_view = None;
    assert_rejected_with_parity(&fixture, "invocation_result_mismatch");
}

#[test]
fn v4_lifecycle_reason_and_captured_activation_provenance_roundtrip() {
    let mut fixture = records();
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.export_version = EXPORT_VERSION_V4;
    let mut call = reusable_call("invocation:1", "node:call-1");
    call.activator = Some(ExportInvocationActivator::Agent);
    call.source.presenting_layer_id = Some("layer:alternate-occurrence".into());
    header.invocations = vec![call];
    assert_validation_parity(&fixture);
    let encoded = serde_json::to_string(&fixture[0]).unwrap();
    assert_eq!(
        serde_json::from_str::<ConversationExportRecord>(&encoded).unwrap(),
        fixture[0]
    );
    assert!(encoded.contains("\"activator\":\"agent\""));
    for field in ["activator", "captureState"] {
        let mut invalid = serde_json::to_value(&fixture[0]).unwrap();
        if field == "activator" {
            invalid["invocations"][0][field] = "unknown".into();
        } else {
            invalid["invocations"][0]["source"][field] = "unknown".into();
        }
        assert!(serde_json::from_value::<ConversationExportRecord>(invalid).is_err());
    }
    for (lifecycle, reason) in [
        ("active", Some("cancelled")),
        ("stopped", None),
        ("failed", None),
        ("failed", Some("")),
    ] {
        let mut invalid = fixture.clone();
        let ConversationExportRecord::Header(header) = &mut invalid[0] else {
            unreachable!()
        };
        header.invocations[0].lifecycle = lifecycle.into();
        header.invocations[0].safe_reason = reason.map(Into::into);
        assert_rejected_with_parity(
            &invalid,
            if reason == Some("") {
                "string_empty"
            } else {
                "invocation_lifecycle_reason_mismatch"
            },
        );
    }
}

fn records_with_visual_assets(bytes: &[u8], asset_ids: &[&str]) -> Vec<ConversationExportRecord> {
    let mut fixture = records();
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.export_version = EXPORT_VERSION_V2;
    let digest = format!("{:x}", Sha256::digest(bytes));
    let content = ExportVisualAssetContent {
        digest_sha256: digest.clone(),
        media_type: "image/svg+xml".into(),
        byte_length: bytes.len(),
        content_base64: BASE64_STANDARD.encode(bytes),
    };
    let ConversationExportRecord::Turn(turn) = &mut fixture[1] else {
        unreachable!()
    };
    let node = &mut turn.accepted_view.as_mut().unwrap().layers[0].nodes[0];
    node.authored_detail.as_mut().unwrap()["assets"] = serde_json::Value::Array(
        asset_ids
            .iter()
            .map(|asset_id| {
                serde_json::json!({
                    "id": asset_id,
                    "digestSha256": digest,
                    "mediaType": "image/svg+xml",
                    "representation": "image",
                })
            })
            .collect(),
    );
    node.authored_detail_assets = asset_ids
        .iter()
        .map(|asset_id| ExportVisualAssetAssociation {
            asset_id: (*asset_id).into(),
            digest_sha256: digest.clone(),
            media_type: "image/svg+xml".into(),
            byte_length: bytes.len(),
            provenance: ExportVisualAssetProvenance {
                source: "user".into(),
                file_name: format!("{asset_id}.svg"),
            },
        })
        .collect();
    fixture.insert(
        1,
        ConversationExportRecord::VisualAssetContent(Box::new(content)),
    );
    fixture
}

#[test]
fn upload_asset_content_bounds_match_materialization() {
    for size in [0, 8 * 1024 * 1024 + 1] {
        let fixture = records_with_visual_assets(&vec![7; size], &["asset-a"]);
        assert_rejected_with_parity(&fixture, "visual_asset_content_size_invalid");
        let jsonl = fixture
            .iter()
            .map(|record| serde_json::to_string(record).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            decode_export_jsonl(jsonl.as_bytes())
                .unwrap_err()
                .to_string()
                .contains("visual_asset_content_size_invalid")
        );
    }
    validate_incrementally(&records_with_visual_assets(
        &vec![7; 8 * 1024 * 1024],
        &["asset-a"],
    ))
    .unwrap();
}

#[test]
fn upload_asset_provenance_matches_materialization() {
    for source in ["user", "system", "provider"] {
        let mut fixture = records_with_visual_assets(SAFE_SVG, &["asset-a"]);
        let ConversationExportRecord::Turn(turn) = &mut fixture[2] else {
            unreachable!()
        };
        turn.accepted_view.as_mut().unwrap().layers[0].nodes[0].authored_detail_assets[0]
            .provenance
            .source = source.into();
        if source == "provider" {
            assert_rejected_with_parity(&fixture, "visual_asset_provenance_invalid");
        } else {
            validate_incrementally(&fixture).unwrap();
        }
    }
}

#[test]
fn upload_reused_asset_nodes_preserve_association_identity() {
    for mutation in ["unchanged", "order", "provenance", "context-only"] {
        let visual = records_with_visual_assets(SAFE_SVG, &["asset-a", "asset-b"]);
        let ConversationExportRecord::Turn(visual_turn) = &visual[2] else {
            unreachable!()
        };
        let visual_node = &visual_turn.accepted_view.as_ref().unwrap().layers[0].nodes[0];
        let mut fixture = two_turn_records();
        let ConversationExportRecord::Header(header) = &mut fixture[0] else {
            unreachable!()
        };
        header.export_version = EXPORT_VERSION_V2;
        for record in &mut fixture[1..] {
            let ConversationExportRecord::Turn(turn) = record else {
                unreachable!()
            };
            let node = &mut turn.accepted_view.as_mut().unwrap().layers[0].nodes[0];
            node.authored_detail = visual_node.authored_detail.clone();
            node.authored_detail_assets = visual_node.authored_detail_assets.clone();
        }
        let ConversationExportRecord::Turn(turn) = &mut fixture[2] else {
            unreachable!()
        };
        let node = &mut turn.accepted_view.as_mut().unwrap().layers[0].nodes[0];
        match mutation {
            "order" => node.authored_detail_assets.reverse(),
            "provenance" => {
                node.authored_detail_assets[0].provenance.file_name = "different.svg".into()
            }
            "context-only" => {
                node.authored_detail_assets.clear();
                node.authored_detail = None;
            }
            _ => {}
        }
        fixture.insert(1, visual[1].clone());
        if matches!(mutation, "order" | "provenance") {
            assert_rejected_with_parity(&fixture, "node_identity_conflict");
        } else {
            validate_incrementally(&fixture).unwrap();
        }
    }
}

const SAFE_SVG: &[u8] =
    br#"<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>"#;

#[test]
fn visual_asset_archive_is_optional_and_globally_deduplicated() {
    let legacy_json = serde_json::to_value(records()).unwrap();
    assert!(legacy_json[0].get("visualAssetContents").is_none());
    assert!(
        legacy_json[1]["acceptedView"]["layers"][0]["nodes"][0]
            .get("authoredDetailAssets")
            .is_none()
    );
    let legacy: Vec<ConversationExportRecord> = serde_json::from_value(legacy_json).unwrap();
    validate_export_records(&legacy).unwrap();

    let fixture = records_with_visual_assets(SAFE_SVG, &["asset-a", "asset-b"]);
    let ConversationExportRecord::VisualAssetContent(content) = &fixture[1] else {
        unreachable!()
    };
    assert_eq!(content.digest_sha256.len(), 64);
    validate_export_records(&fixture).unwrap();

    let mut legacy_pinned = fixture.clone();
    legacy_pinned.remove(1);
    let ConversationExportRecord::Turn(turn) = &mut legacy_pinned[1] else {
        unreachable!()
    };
    turn.accepted_view.as_mut().unwrap().layers[0].nodes[0]
        .authored_detail_assets
        .clear();
    validate_export_records(&legacy_pinned).unwrap();
}

#[test]
fn private_authored_detail_omission_cannot_retain_asset_bytes_or_associations() {
    let mut fixture = records();
    let ConversationExportRecord::Turn(turn) = &mut fixture[1] else {
        unreachable!()
    };
    let node = &mut turn.accepted_view.as_mut().unwrap().layers[0].nodes[0];
    node.authored_detail = None;
    node.authored_detail_omitted = Some(ExportAuthoredDetailOmission::PrivatePath);
    validate_export_records(&fixture).unwrap();

    let mut leaked = records_with_visual_assets(SAFE_SVG, &["private-asset"]);
    let ConversationExportRecord::Turn(turn) = &mut leaked[2] else {
        unreachable!()
    };
    let node = &mut turn.accepted_view.as_mut().unwrap().layers[0].nodes[0];
    node.authored_detail = None;
    node.authored_detail_omitted = Some(ExportAuthoredDetailOmission::PrivatePath);
    assert_eq!(
        validate_export_records(&leaked).unwrap_err().code,
        "authored_detail_asset_without_detail"
    );
}

#[test]
fn visual_asset_archive_rejects_corrupt_or_unbound_content_before_import() {
    let valid = records_with_visual_assets(SAFE_SVG, &["asset-a"]);

    let mut malformed_digest = valid.clone();
    let ConversationExportRecord::VisualAssetContent(content) = &mut malformed_digest[1] else {
        unreachable!()
    };
    content.digest_sha256 = "A".repeat(64);
    assert_eq!(
        validate_export_records(&malformed_digest).unwrap_err().code,
        "visual_asset_digest_invalid"
    );

    let mut malformed_base64 = valid.clone();
    let ConversationExportRecord::VisualAssetContent(content) = &mut malformed_base64[1] else {
        unreachable!()
    };
    content.content_base64 = "%%%".into();
    assert_eq!(
        validate_export_records(&malformed_base64).unwrap_err().code,
        "visual_asset_base64_invalid"
    );

    let mut wrong_length = valid.clone();
    let ConversationExportRecord::VisualAssetContent(content) = &mut wrong_length[1] else {
        unreachable!()
    };
    content.byte_length += 1;
    assert_eq!(
        validate_export_records(&wrong_length).unwrap_err().code,
        "visual_asset_content_corrupt"
    );

    let mut duplicate = valid.clone();
    duplicate.insert(2, duplicate[1].clone());
    assert_eq!(
        validate_export_records(&duplicate).unwrap_err().code,
        "visual_asset_content_duplicate"
    );

    let mut pin_mismatch = valid.clone();
    let ConversationExportRecord::Turn(turn) = &mut pin_mismatch[2] else {
        unreachable!()
    };
    turn.accepted_view.as_mut().unwrap().layers[0].nodes[0].authored_detail_assets[0].asset_id =
        "different".into();
    assert_eq!(
        validate_export_records(&pin_mismatch).unwrap_err().code,
        "authored_detail_asset_pin_mismatch"
    );

    let mut partial_inventory = records_with_visual_assets(SAFE_SVG, &["asset-a", "asset-b"]);
    let ConversationExportRecord::Turn(turn) = &mut partial_inventory[2] else {
        unreachable!()
    };
    turn.accepted_view.as_mut().unwrap().layers[0].nodes[0]
        .authored_detail_assets
        .pop();
    assert_eq!(
        validate_export_records(&partial_inventory)
            .unwrap_err()
            .code,
        "authored_detail_asset_inventory_mismatch"
    );

    let mut unreachable = valid.clone();
    let ConversationExportRecord::Turn(turn) = &mut unreachable[2] else {
        unreachable!()
    };
    let node = &mut turn.accepted_view.as_mut().unwrap().layers[0].nodes[0];
    node.authored_detail.as_mut().unwrap()["assets"] = serde_json::json!([]);
    node.authored_detail_assets.clear();
    assert_eq!(
        validate_export_records(&unreachable).unwrap_err().code,
        "visual_asset_content_unreachable"
    );

    for valid_svg in [
        br#"<svg xmlns='http://www.w3.org/2000/svg'><rect width='1' height='1'/></svg>"#.as_slice(),
        br##"<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/></svg>"##.as_slice(),
    ] {
        validate_export_records(&records_with_visual_assets(valid_svg, &["asset-a"])).unwrap();
    }
}

#[test]
fn separate_content_records_keep_two_legal_seven_mib_assets_below_the_line_limit() {
    let payloads = [vec![1_u8; 7 * 1024 * 1024], vec![2_u8; 7 * 1024 * 1024]];
    let mut fixture = records();
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.export_version = EXPORT_VERSION_V2;
    let ConversationExportRecord::Turn(turn) = &mut fixture[1] else {
        unreachable!()
    };
    let node = &mut turn.accepted_view.as_mut().unwrap().layers[0].nodes[0];
    let pins = payloads
        .iter()
        .enumerate()
        .map(|(index, bytes)| {
            let digest = format!("{:x}", Sha256::digest(bytes));
            serde_json::json!({
                "id": format!("asset-{index}"),
                "digestSha256": digest,
                "mediaType": "image/png",
                "representation": "image",
            })
        })
        .collect::<Vec<_>>();
    node.authored_detail.as_mut().unwrap()["assets"] = serde_json::Value::Array(pins.clone());
    node.authored_detail_assets = pins
        .iter()
        .enumerate()
        .map(|(index, pin)| ExportVisualAssetAssociation {
            asset_id: format!("asset-{index}"),
            digest_sha256: pin["digestSha256"].as_str().unwrap().into(),
            media_type: "image/png".into(),
            byte_length: payloads[index].len(),
            provenance: ExportVisualAssetProvenance {
                source: "user".into(),
                file_name: format!("asset-{index}.png"),
            },
        })
        .collect();
    for (index, bytes) in payloads.iter().enumerate().rev() {
        fixture.insert(
            1,
            ConversationExportRecord::VisualAssetContent(Box::new(ExportVisualAssetContent {
                digest_sha256: pins[index]["digestSha256"].as_str().unwrap().into(),
                media_type: "image/png".into(),
                byte_length: bytes.len(),
                content_base64: BASE64_STANDARD.encode(bytes),
            })),
        );
    }
    assert!(
        fixture[1..3]
            .iter()
            .all(|record| { serde_json::to_vec(record).unwrap().len() < MAX_JSONL_LINE_BYTES })
    );
    validate_export_records(&fixture).unwrap();
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
        match record {
            ConversationExportRecord::VisualAssetContent(content) => {
                validator.push_visual_asset_content(content)?
            }
            ConversationExportRecord::Turn(turn) => validator.push_turn(turn)?,
            ConversationExportRecord::Header(_) => panic!("parity fixture has duplicate header"),
        }
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

    // Layers accepted before edge shapes export without the field and read as "default".
    let mut shapeless = records();
    let ConversationExportRecord::Turn(turn) = &mut shapeless[1] else {
        unreachable!()
    };
    let layout = turn.accepted_view.as_mut().unwrap().layers[0]
        .layer
        .layout
        .as_mut()
        .unwrap();
    layout.edge_shape = None;
    let json = serde_json::to_value(&*layout).unwrap();
    assert!(json.get("edgeShape").is_none());
    assert_eq!(
        serde_json::from_value::<ExportLayerLayout>(json).unwrap(),
        *layout
    );
    validate_export_records(&shapeless).unwrap();

    let mut unknown_shape = records();
    let ConversationExportRecord::Turn(turn) = &mut unknown_shape[1] else {
        unreachable!()
    };
    turn.accepted_view.as_mut().unwrap().layers[0]
        .layer
        .layout
        .as_mut()
        .unwrap()
        .edge_shape = Some("arc-inward".into());
    assert_rejected_with_parity(&unknown_shape, "unsupported_edge_shape");

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

    let mut duplicate_occurrence = fixture.clone();
    let ConversationExportRecord::Turn(turn) = &mut duplicate_occurrence[2] else {
        unreachable!()
    };
    let mut duplicate = turn.submitted_inputs[0].clone();
    duplicate.id = "input-child:duplicate-occurrence".into();
    turn.submitted_inputs.push(duplicate);
    turn.submitted_inputs.sort_by_key(|input| {
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
    assert_rejected_with_parity(
        &duplicate_occurrence,
        "duplicate_submitted_input_occurrence",
    );

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

#[test]
fn visual_content_requires_v2_while_v1_turn_streams_remain_supported() {
    validate_incrementally(&records()).unwrap();
    let mut fixture = records_with_visual_assets(SAFE_SVG, &["asset-a"]);
    validate_incrementally(&fixture).unwrap();
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.export_version = 1;
    assert_rejected_with_parity(&fixture, "record_type_not_supported");
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.export_version = 5;
    assert_rejected_with_parity(&fixture, "unsupported_export_version");
}

fn converted_snapshot_records() -> Vec<ConversationExportRecord> {
    let mut fixture = two_turn_records();
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.export_version = EXPORT_VERSION_V3;
    let destination = layer("layer:2", "node:2", vec![]);
    let ConversationExportRecord::Turn(source) = &mut fixture[1] else {
        unreachable!()
    };
    let view = source.accepted_view.as_mut().unwrap();
    let converted = &mut view.layers[0].actions[0];
    converted.kind = ExportActionKind::Navigate;
    converted.relation = Some(ExportNavigateRelation::Expand);
    converted.target_layer_id = Some("layer:2".into());
    converted.interaction_text = None;
    converted.converted_from_invoke = true;
    view.layers.push(destination.clone());
    let ConversationExportRecord::Turn(result) = &mut fixture[2] else {
        unreachable!()
    };
    result.accepted_view.as_mut().unwrap().layers = vec![destination];
    fixture
}

#[test]
fn v3_current_conversion_snapshot_preserves_exact_origin_and_version_boundary() {
    let fixture = converted_snapshot_records();
    validate_export_records(&fixture).unwrap();
    validate_incrementally(&fixture).unwrap();
    for version in [EXPORT_VERSION_V1, EXPORT_VERSION_V2] {
        let mut older = fixture.clone();
        let ConversationExportRecord::Header(header) = &mut older[0] else {
            unreachable!()
        };
        header.export_version = version;
        assert_rejected_with_parity(&older, "converted_invoke_version");
    }
    let mut erased_origin = fixture.clone();
    let ConversationExportRecord::Turn(result) = &mut erased_origin[2] else {
        unreachable!()
    };
    result.origin = ExportTurnOrigin::User;
    assert_rejected_with_parity(&erased_origin, "converted_invoke_origin_missing");
    // A source presented after the result must not bypass reverse lineage checks.
    erased_origin.swap(1, 2);
    for (index, record) in erased_origin.iter_mut().enumerate().skip(1) {
        let ConversationExportRecord::Turn(turn) = record else {
            unreachable!()
        };
        turn.id = format!("turn:{index}");
        turn.sequence = index as u32;
    }
    assert_rejected_with_parity(&erased_origin, "converted_invoke_origin_missing");

    // A source-only export retains navigation to an external conversation's
    // result without inventing an included turn or invocation origin.
    let mut external_result = fixture.clone();
    external_result.pop();
    let ConversationExportRecord::Header(header) = &mut external_result[0] else {
        unreachable!()
    };
    header.turns.pop();
    validate_export_records(&external_result).unwrap();
    validate_incrementally(&external_result).unwrap();

    // The same source node/action can be presented by another accepted turn.
    // Its declared source need not be the first presenting turn in the stream.
    let mut reused = fixture.clone();
    let ConversationExportRecord::Turn(mut presentation) = reused[1].clone() else {
        unreachable!()
    };
    presentation.id = "turn:2".into();
    presentation.sequence = 2;
    presentation.interaction_node_id = Some("node:interaction3".into());
    let view = presentation.accepted_view.as_mut().unwrap();
    view.interaction_node_id = "node:interaction3".into();
    view.root_layer_id = "layer:3".into();
    view.root_action.id = "action:root3".into();
    view.root_action.source_node_id = "node:interaction3".into();
    view.root_action.target_layer_id = Some("layer:3".into());
    view.layers[0].layer.id = "layer:3".into();
    view.layers[0].layer.client_key = Some("reused-source".into());
    let ConversationExportRecord::Turn(result) = &mut reused[2] else {
        unreachable!()
    };
    result.id = "turn:3".into();
    result.sequence = 3;
    let ExportTurnOrigin::Action { source_turn_id, .. } = &mut result.origin else {
        unreachable!()
    };
    *source_turn_id = "turn:2".into();
    reused.insert(2, ConversationExportRecord::Turn(presentation));
    let ConversationExportRecord::Header(header) = &mut reused[0] else {
        unreachable!()
    };
    header.turns.push(ExportTurnManifestEntry {
        id: "turn:3".into(),
        sequence: 3,
    });
    validate_export_records(&reused).unwrap();
    validate_incrementally(&reused).unwrap();

    for later_occurrence in [false, true] {
        let mut ambiguous = reused.clone();
        let ConversationExportRecord::Turn(presentation) = &mut ambiguous[2] else {
            unreachable!()
        };
        let actions = &mut presentation.accepted_view.as_mut().unwrap().layers[0].actions;
        let mut other = actions[0].clone();
        other.id = "action:other-conversion".into();
        other.client_key = Some("other-conversion".into());
        actions.push(other);
        if later_occurrence {
            ambiguous.swap(2, 3);
            for (index, record) in ambiguous.iter_mut().enumerate().skip(2) {
                let ConversationExportRecord::Turn(turn) = record else {
                    unreachable!()
                };
                turn.id = format!("turn:{index}");
                turn.sequence = index as u32;
                if let ExportTurnOrigin::Action { source_turn_id, .. } = &mut turn.origin {
                    *source_turn_id = "turn:1".into();
                }
            }
        }
        assert_rejected_with_parity(&ambiguous, "converted_invoke_origin_ambiguous");
    }

    // Multiple external targets do not establish an included result's lineage.
    let ConversationExportRecord::Turn(source) = &mut external_result[1] else {
        unreachable!()
    };
    let actions = &mut source.accepted_view.as_mut().unwrap().layers[0].actions;
    let mut other = actions[0].clone();
    other.id = "action:external-conversion".into();
    other.client_key = Some("external-conversion".into());
    actions.push(other);
    validate_export_records(&external_result).unwrap();
    validate_incrementally(&external_result).unwrap();

    let mut wrong_destination = fixture.clone();
    let ConversationExportRecord::Turn(result) = &mut wrong_destination[2] else {
        unreachable!()
    };
    result.accepted_view.as_mut().unwrap().root_layer_id = "layer:wrong".into();
    assert_rejected_with_parity(&wrong_destination, "action_origin_unresolved");
    let mut wrong_shape = fixture;
    let ConversationExportRecord::Turn(source) = &mut wrong_shape[1] else {
        unreachable!()
    };
    source.accepted_view.as_mut().unwrap().layers[0].actions[0].relation =
        Some(ExportNavigateRelation::Reference);
    assert_rejected_with_parity(&wrong_shape, "converted_invoke_shape");
}

#[test]
fn v3_preserves_v2_visual_content_records() {
    let mut fixture = records_with_visual_assets(SAFE_SVG, &["asset-a"]);
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.export_version = EXPORT_VERSION_V3;
    validate_export_records(&fixture).unwrap();
    validate_incrementally(&fixture).unwrap();
}

#[test]
fn v3_node_owned_navigation_keeps_membership_and_legacy_provenance_boundaries() {
    let mut fixture = converted_snapshot_records();
    let ConversationExportRecord::Turn(source) = &mut fixture[1] else {
        unreachable!()
    };
    source.accepted_view.as_mut().unwrap().layers[0].actions[0].source_layer_id = None;
    validate_export_records(&fixture).unwrap();
    validate_incrementally(&fixture).unwrap();
    let mut wrong_source = fixture.clone();
    let ConversationExportRecord::Turn(source) = &mut wrong_source[1] else {
        unreachable!()
    };
    source.accepted_view.as_mut().unwrap().layers[0].actions[0].source_node_id =
        "node:absent".into();
    assert_rejected_with_parity(&wrong_source, "action_source_outside_layer");
    for version in [EXPORT_VERSION_V1, EXPORT_VERSION_V2, EXPORT_VERSION_V3] {
        let mut native_navigation = fixture.clone();
        let ConversationExportRecord::Header(header) = &mut native_navigation[0] else {
            unreachable!()
        };
        header.export_version = version;
        let ConversationExportRecord::Turn(source) = &mut native_navigation[1] else {
            unreachable!()
        };
        source.accepted_view.as_mut().unwrap().layers[0].actions[0].converted_from_invoke = false;
        let ConversationExportRecord::Turn(result) = &mut native_navigation[2] else {
            unreachable!()
        };
        result.origin = ExportTurnOrigin::User;
        if version == EXPORT_VERSION_V3 {
            validate_export_records(&native_navigation).unwrap();
        } else {
            assert_rejected_with_parity(&native_navigation, "action_source_layer_missing");
        }
    }
    let mut root_conversion = fixture;
    let ConversationExportRecord::Turn(source) = &mut root_conversion[1] else {
        unreachable!()
    };
    source
        .accepted_view
        .as_mut()
        .unwrap()
        .root_action
        .converted_from_invoke = true;
    assert_rejected_with_parity(&root_conversion, "invalid_root_action");
    for version in [EXPORT_VERSION_V1, EXPORT_VERSION_V2, EXPORT_VERSION_V3] {
        let mut ordinary = records();
        let ConversationExportRecord::Header(header) = &mut ordinary[0] else {
            unreachable!()
        };
        header.export_version = version;
        let ConversationExportRecord::Turn(source) = &mut ordinary[1] else {
            unreachable!()
        };
        source.accepted_view.as_mut().unwrap().layers[0].actions[0].source_layer_id = None;
        assert_rejected_with_parity(&ordinary, "action_source_layer_missing");
    }
}

#[test]
fn v3_current_closure_preserves_completion_scoped_authored_keys() {
    let mut fixture = converted_snapshot_records();
    for record in &mut fixture[1..] {
        let ConversationExportRecord::Turn(turn) = record else {
            unreachable!()
        };
        for resolved in &mut turn.accepted_view.as_mut().unwrap().layers {
            resolved.layer.client_key = Some("answer-layer".into());
            resolved.nodes[0].client_key = Some("answer-node".into());
            if resolved.layer.id == "layer:2" {
                let mut follow_up = invoke("action:second-follow-up", "node:2", "layer:2");
                follow_up.client_key = Some("follow-up".into());
                resolved.actions.push(follow_up);
            } else {
                resolved.actions[0].client_key = Some("follow-up".into());
            }
        }
    }
    validate_export_records(&fixture).unwrap();
    validate_incrementally(&fixture).unwrap();
    let mut ambiguous = fixture;
    let ConversationExportRecord::Turn(turn) = &mut ambiguous[1] else {
        unreachable!()
    };
    let layer = &mut turn.accepted_view.as_mut().unwrap().layers[0];
    let mut collision = layer.actions[0].clone();
    collision.id = "action:ambiguous".into();
    layer.actions.push(collision);
    assert_rejected_with_parity(&ambiguous, "duplicate_action_client_key");
}

#[test]
fn v3_reference_backlinks_preserve_legacy_arrival_and_expand_cycle_guards() {
    let mut fixture = records();
    fixture.truncate(2);
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.export_version = EXPORT_VERSION_V3;
    header.turns.truncate(1);
    let ConversationExportRecord::Turn(turn) = &mut fixture[1] else {
        unreachable!()
    };
    turn.accepted_view.as_mut().unwrap().layers[0]
        .actions
        .push(action(
            "action:back",
            "node:1",
            Some("layer:1"),
            Some(ExportNavigateRelation::Reference),
            Some("layer:1"),
        ));
    validate_export_records(&fixture).unwrap();
    validate_incrementally(&fixture).unwrap();
    for version in [EXPORT_VERSION_V1, EXPORT_VERSION_V2] {
        let mut older = fixture.clone();
        let ConversationExportRecord::Header(header) = &mut older[0] else {
            unreachable!()
        };
        header.export_version = version;
        assert_rejected_with_parity(&older, "mixed_target_relations");
    }
    let mut cycle = fixture.clone();
    let ConversationExportRecord::Turn(turn) = &mut cycle[1] else {
        unreachable!()
    };
    turn.accepted_view.as_mut().unwrap().layers[0]
        .actions
        .last_mut()
        .unwrap()
        .relation = Some(ExportNavigateRelation::Expand);
    assert_rejected_with_parity(&cycle, "expand_cycle");
    let ConversationExportRecord::Turn(turn) = &mut fixture[1] else {
        unreachable!()
    };
    let view = turn.accepted_view.as_mut().unwrap();
    view.layers[0].actions.last_mut().unwrap().target_layer_id = Some("layer:child".into());
    view.layers[0].actions.push(action(
        "action:child",
        "node:1",
        Some("layer:1"),
        Some(ExportNavigateRelation::Expand),
        Some("layer:child"),
    ));
    view.layers.push(layer("layer:child", "node:child", vec![]));
    validate_export_records(&fixture).unwrap();
    validate_incrementally(&fixture).unwrap();
    for version in [EXPORT_VERSION_V1, EXPORT_VERSION_V2] {
        let mut older = fixture.clone();
        let ConversationExportRecord::Header(header) = &mut older[0] else {
            unreachable!()
        };
        header.export_version = version;
        assert_rejected_with_parity(&older, "mixed_target_relations");
    }
}

#[test]
fn v3_rejects_expansion_cycles_in_reference_entered_components() {
    let mut fixture = records();
    fixture.truncate(2);
    let ConversationExportRecord::Header(header) = &mut fixture[0] else {
        unreachable!()
    };
    header.export_version = EXPORT_VERSION_V3;
    header.turns.truncate(1);
    let ConversationExportRecord::Turn(turn) = &mut fixture[1] else {
        unreachable!()
    };
    let view = turn.accepted_view.as_mut().unwrap();
    view.layers[0].actions = vec![action(
        "action:reference",
        "node:1",
        Some("layer:1"),
        Some(ExportNavigateRelation::Reference),
        Some("layer:child"),
    )];
    view.layers.push(layer(
        "layer:child",
        "node:child",
        vec![action(
            "action:cycle",
            "node:child",
            Some("layer:child"),
            Some(ExportNavigateRelation::Expand),
            Some("layer:child"),
        )],
    ));
    assert_rejected_with_parity(&fixture, "expand_cycle");
}

#[test]
fn context_owner_requires_v3_exact_prior_accepted_occurrence() {
    let mut fixture = two_turn_records();
    if let ConversationExportRecord::Header(header) = &mut fixture[0] {
        header.export_version = EXPORT_VERSION_V3;
    }
    if let ConversationExportRecord::Turn(turn) = &mut fixture[2] {
        turn.interaction_node_id = Some("node:interaction-2".into());
        let mut attachment = context("action:context-owner", &[]);
        attachment.source.layer_id = "layer:1".into();
        // Presenting occurrence deliberately differs from the immutable owner.
        attachment.source.interaction_node_id = "node:another-presenter".into();
        attachment.source.owner_turn_id = Some("turn:1".into());
        turn.contexts.push(attachment);
    }
    validate_export_records(&fixture).unwrap();
    let bytes = fixture
        .iter()
        .map(|record| serde_json::to_string(record).unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(decode_export_jsonl(bytes.as_bytes()).unwrap(), fixture);
    for version in [EXPORT_VERSION_V1, EXPORT_VERSION_V2] {
        let mut older = fixture.clone();
        if let ConversationExportRecord::Header(header) = &mut older[0] {
            header.export_version = version;
        }
        assert_rejected_with_parity(&older, "context_owner_version");
        if let ConversationExportRecord::Turn(turn) = &mut older[2] {
            turn.contexts[0].source.owner_turn_id = None;
        }
        validate_export_records(&older).unwrap();
    }
    for mutation in ["omitted", "future", "layer", "node"] {
        let mut invalid = fixture.clone();
        if let ConversationExportRecord::Turn(turn) = &mut invalid[2] {
            let context = &mut turn.contexts[0];
            match mutation {
                "omitted" => context.source.owner_turn_id = Some("turn:99".into()),
                "future" => context.source.owner_turn_id = Some("turn:2".into()),
                "layer" => context.source.layer_id = "layer:absent".into(),
                "node" => context.target.id = "node:absent".into(),
                _ => unreachable!(),
            }
        }
        assert_rejected_with_parity(&invalid, "context_owner_invalid");
    }
}

#[test]
fn reused_layer_cannot_claim_two_portable_owners() {
    let mut fixture = two_turn_records();
    let ConversationExportRecord::Turn(first) = &fixture[1] else {
        unreachable!()
    };
    let reused = first.accepted_view.as_ref().unwrap().layers[0].clone();
    if let ConversationExportRecord::Header(header) = &mut fixture[0] {
        header.export_version = EXPORT_VERSION_V3;
        header.turns.push(ExportTurnManifestEntry {
            id: "turn:3".into(),
            sequence: 3,
        });
    }
    if let ConversationExportRecord::Turn(second) = &mut fixture[2] {
        second.interaction_node_id = Some("node:interaction-2".into());
        let view = second.accepted_view.as_mut().unwrap();
        view.layers[0].actions.push(action(
            "action:reused-layer",
            "node:1",
            Some("layer:2"),
            Some(ExportNavigateRelation::Reference),
            Some("layer:1"),
        ));
        view.layers.push(reused);
        let mut attachment = context("action:owner-first", &[]);
        attachment.source.layer_id = "layer:1".into();
        attachment.source.owner_turn_id = Some("turn:1".into());
        second.contexts.push(attachment);
    }
    let mut attachment = context("action:owner-again", &[]);
    attachment.source.layer_id = "layer:1".into();
    attachment.source.owner_turn_id = Some("turn:1".into());
    fixture.push(ConversationExportRecord::Turn(Box::new(
        ConversationExportTurn {
            id: "turn:3".into(),
            sequence: 3,
            created_at: "1769000003000".into(),
            text: "Attached from reused layer".into(),
            interaction_node_id: Some("node:interaction-3".into()),
            origin: ExportTurnOrigin::User,
            completion: receipt(ExportCompletionStatus::Failed),
            contexts: vec![attachment],
            submitted_inputs: vec![],
            accepted_view: None,
        },
    )));
    validate_export_records(&fixture).unwrap();
    if let ConversationExportRecord::Turn(third) = &mut fixture[3] {
        third.contexts[0].source.owner_turn_id = Some("turn:2".into());
    }
    assert_rejected_with_parity(&fixture, "context_owner_conflict");
}

#[test]
fn typed_image_icons_require_exact_portable_asset_inventory_for_nodes_roots_and_contexts() {
    for carrier in ["node", "root", "context"] {
        let mut fixture = records_with_visual_assets(SAFE_SVG, &["asset-a"]);
        let ConversationExportRecord::Turn(turn) = &mut fixture[2] else {
            unreachable!()
        };
        turn.interaction_node_id = Some(
            turn.accepted_view
                .as_ref()
                .unwrap()
                .interaction_node_id
                .clone(),
        );
        let view = turn.accepted_view.as_mut().unwrap();
        let node = &mut view.layers[0].nodes[0];
        let asset = node.authored_detail_assets[0].clone();
        let icon = serde_json::json!({"kind":"image","assetId":asset.asset_id,"digestSha256":asset.digest_sha256,"mediaType":asset.media_type}).to_string();
        node.authored_detail = None;
        node.authored_detail_assets.clear();
        match carrier {
            "node" => {
                node.icon = icon.clone();
                node.authored_detail_assets.push(asset.clone());
            }
            "root" => {
                view.root_action.icon = Some(icon.clone());
                view.root_action.icon_asset = Some(asset.clone());
            }
            _ => {
                let mut attached = context("action:image-context", &[]);
                attached.target.id = "node:external-image".into();
                attached.target.icon = icon.clone();
                attached.target.icon_asset = Some(asset.clone());
                turn.contexts.push(attached);
            }
        }
        validate_export_records(&fixture).unwrap();
        validate_incrementally(&fixture).unwrap();
        let mut missing = fixture.clone();
        let ConversationExportRecord::Turn(turn) = &mut missing[2] else {
            unreachable!()
        };
        match carrier {
            "node" => turn.accepted_view.as_mut().unwrap().layers[0].nodes[0]
                .authored_detail_assets
                .clear(),
            "root" => turn.accepted_view.as_mut().unwrap().root_action.icon_asset = None,
            _ => turn.contexts[0].target.icon_asset = None,
        }
        assert_rejected_with_parity(
            &missing,
            if carrier == "node" {
                "authored_detail_asset_inventory_mismatch"
            } else {
                "icon_asset_inventory_mismatch"
            },
        );
        let mut corrupted_pin = fixture.clone();
        let ConversationExportRecord::Turn(turn) = &mut corrupted_pin[2] else {
            unreachable!()
        };
        let association = match carrier {
            "node" => {
                &mut turn.accepted_view.as_mut().unwrap().layers[0].nodes[0].authored_detail_assets
                    [0]
            }
            "root" => turn
                .accepted_view
                .as_mut()
                .unwrap()
                .root_action
                .icon_asset
                .as_mut()
                .unwrap(),
            _ => turn.contexts[0].target.icon_asset.as_mut().unwrap(),
        };
        association.digest_sha256 = "f".repeat(64);
        assert_rejected_with_parity(
            &corrupted_pin,
            if carrier == "node" {
                "authored_detail_asset_pin_mismatch"
            } else {
                "icon_asset_pin_mismatch"
            },
        );
    }
}

#[test]
fn edge_routes_export_with_their_edge_and_reject_invalid_portable_routes() {
    let routed = |route: ExportEdgeRoute| {
        let mut records = records();
        let ConversationExportRecord::Turn(turn) = &mut records[1] else {
            unreachable!()
        };
        let resolved = &mut turn.accepted_view.as_mut().unwrap().layers[0];
        let first = resolved.nodes[0].id.clone();
        let mut second = resolved.nodes[0].clone();
        second.id = "node:second".into();
        resolved.layer.nodes.push(second.id.clone());
        resolved.nodes.push(second);
        let layout = resolved.layer.layout.as_mut().unwrap();
        layout.placements.push(ExportNodePlacement {
            node_id: "node:second".into(),
            x: 0.8,
            y: 0.5,
        });
        layout.edge_routes = vec![route];
        resolved.edges.push(ExportEdge {
            id: "edge:routed".into(),
            endpoints: [first, "node:second".into()],
            state: ExportRecordState::Accepted,
        });
        resolved.layer.edges.push("edge:routed".into());
        records
    };
    let end = |node_id: &str, side: Option<&str>| ExportEdgeEnd {
        node_id: node_id.into(),
        side: side.map(Into::into),
    };
    let first = match &records()[1] {
        ConversationExportRecord::Turn(turn) => turn.accepted_view.as_ref().unwrap().layers[0]
            .nodes[0]
            .id
            .clone(),
        _ => unreachable!(),
    };
    let route = ExportEdgeRoute {
        edge_id: "edge:routed".into(),
        shape: Some("elbow-vertical".into()),
        ends: vec![end("node:second", Some("top")), end(&first, None)],
        waypoints: vec![relayer_graph_core::LayoutPoint { x: 0.5, y: 0.1 }],
    };
    assert_validation_parity(&routed(route.clone()));

    for (code, invalid) in [
        (
            "edge_route_outside_layer",
            ExportEdgeRoute {
                edge_id: "edge:elsewhere".into(),
                ..route.clone()
            },
        ),
        (
            "unsupported_edge_shape",
            ExportEdgeRoute {
                shape: Some("flow".into()),
                ..route.clone()
            },
        ),
        (
            "edge_route_ends_mismatch",
            ExportEdgeRoute {
                ends: vec![end(&first, None), end(&first, None)],
                ..route.clone()
            },
        ),
        (
            "unsupported_node_side",
            ExportEdgeRoute {
                ends: vec![end("node:second", Some("north")), end(&first, None)],
                ..route.clone()
            },
        ),
        (
            "edge_route_ends_required",
            ExportEdgeRoute {
                ends: vec![],
                ..route.clone()
            },
        ),
        (
            "too_many_waypoints",
            ExportEdgeRoute {
                waypoints: vec![relayer_graph_core::LayoutPoint { x: 0.5, y: 0.1 }; 5],
                ..route.clone()
            },
        ),
        (
            "layout_coordinate_invalid",
            ExportEdgeRoute {
                waypoints: vec![relayer_graph_core::LayoutPoint { x: 1.5, y: 0.1 }],
                ..route.clone()
            },
        ),
    ] {
        assert_rejected_with_parity(&routed(invalid), code);
    }
}
