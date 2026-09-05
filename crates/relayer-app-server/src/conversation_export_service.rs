use std::collections::HashMap;

use relayer_graph_core::{
    AcceptedGraphClosure, ActionKind, ActionVariant, GraphAction, GraphEdge, GraphNode,
    InteractionContextAction, InteractionInput, NavigateRelation, RecordState, ResolvedLayer,
};

use crate::{
    conversation_export::{
        ConversationExportHeader, ConversationExportRecord, ConversationExportTurn,
        EXPORT_VERSION_V1, ExportAcceptedView, ExportAction, ExportActionKind, ExportActionVariant,
        ExportAdmittedExecutionModelPlan, ExportAdmittedExecutionModelRoute, ExportAttemptOutcome,
        ExportAuthoredDetailOmission, ExportCompletionReceipt, ExportCompletionStatus,
        ExportContextSource, ExportContextTargetSnapshot, ExportConversation, ExportEdge,
        ExportInputActionSnapshot, ExportInputControl, ExportInputOption, ExportInputSource,
        ExportInteractionContext, ExportLayer, ExportLayerLayout, ExportModelSelection,
        ExportNavigateRelation, ExportNode, ExportNodePlacement, ExportPermissionReceipt,
        ExportProducer, ExportRecordState, ExportResolvedLayer, ExportSubmittedInput,
        ExportSubmittedInputValue, ExportTurnManifestEntry, ExportTurnOrigin, MAX_EXPORT_BYTES,
        MAX_JSONL_LINE_BYTES, validate_export_records,
    },
    product::{
        ActionInvocation, DurableInteractionInput, Interaction, InteractionId, ProductError,
        ProductService, SubmittedInputEvidence, ThreadId,
    },
    runtime::{RuntimeClient, RuntimeError},
};

#[derive(Debug, thiserror::Error)]
pub(crate) enum ConversationExportBuildError {
    #[error(transparent)]
    Product(#[from] ProductError),
    #[error(transparent)]
    Runtime(#[from] RuntimeError),
    #[error("invalid durable conversation export state: {0}")]
    Invalid(String),
    #[error(transparent)]
    Contract(#[from] crate::conversation_export::ExportValidationError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

pub(crate) async fn build_conversation_export(
    product: &ProductService,
    runtime: &RuntimeClient,
    thread_id: ThreadId,
    producer: ExportProducer,
    exported_at: String,
) -> Result<Vec<u8>, ConversationExportBuildError> {
    let detail = product.get_thread(thread_id).await?;
    let export_invocations = product.action_invocations_for_export(thread_id).await?;
    let imported_turns = product.imported_turn_export_records(thread_id).await?;
    let project_path = detail.project.as_ref().map(|project| project.path.as_str());
    let redactor = ProjectPathRedactor::new(project_path);
    let project_name = detail
        .project
        .as_ref()
        .map(|project| redactor.text(&project.name));
    let interaction_indexes = detail
        .interactions
        .iter()
        .enumerate()
        .map(|(index, interaction)| (interaction.id, index))
        .collect::<HashMap<_, _>>();
    // Thread detail intentionally carries project-visible invocation projections for navigation.
    // A portable conversation export, however, may only encode provenance whose source and result
    // turns are both members of this conversation.
    let conversation_invocations = export_invocations
        .iter()
        .filter(|invocation| {
            interaction_indexes.contains_key(&invocation.source_interaction_id)
                && interaction_indexes.contains_key(&invocation.result_interaction_id)
        })
        .collect::<Vec<_>>();
    let invocations = conversation_invocations
        .iter()
        .copied()
        .map(|invocation| (invocation.result_interaction_id, invocation))
        .collect::<HashMap<_, _>>();
    let turn_sequences = detail
        .interactions
        .iter()
        .map(|interaction| (interaction.id, interaction.sequence))
        .collect::<HashMap<_, _>>();
    let imported_turn_sequences = imported_turns
        .iter()
        .map(|record| {
            let sequence = turn_sequences
                .get(&record.interaction_id)
                .copied()
                .ok_or_else(|| {
                    ConversationExportBuildError::Invalid(format!(
                        "imported turn {} is outside the conversation snapshot",
                        record.source_turn_id
                    ))
                })?;
            if record.turn.id != record.source_turn_id {
                return Err(ConversationExportBuildError::Invalid(format!(
                    "stored imported turn {} has inconsistent source identity",
                    record.source_turn_id
                )));
            }
            Ok((record.source_turn_id.as_str(), sequence))
        })
        .collect::<Result<HashMap<_, _>, ConversationExportBuildError>>()?;
    let imported_turns = imported_turns
        .iter()
        .map(|record| (record.interaction_id, record))
        .collect::<HashMap<_, _>>();
    let mut ids = PortableIds::default();
    let mut closures = Vec::with_capacity(detail.interactions.len());
    let mut context_inputs = Vec::with_capacity(detail.interactions.len());
    let mut submitted_evidence = Vec::with_capacity(detail.interactions.len());
    for interaction in &detail.interactions {
        let closure = if interaction.completion_status == "accepted" {
            let node_id = interaction.graph_node_id.ok_or_else(|| {
                ConversationExportBuildError::Invalid(format!(
                    "accepted interaction {} has no graph node",
                    interaction.id
                ))
            })?;
            let closure = runtime.accepted_graph_closure(node_id).await?;
            if closure.node_id.value() != node_id {
                return Err(ConversationExportBuildError::Invalid(format!(
                    "accepted graph closure root {} does not match interaction graph node {node_id}",
                    closure.node_id
                )));
            }
            Some(closure)
        } else {
            None
        };
        closures.push(closure);
        let durable_input = product.interaction_input(interaction.id).await?;
        let context_input = match interaction.graph_node_id {
            Some(node_id) => Some(ContextInput::Runtime(RuntimeContextInput {
                input: runtime.interaction_input(node_id).await?,
                actions: runtime.interaction_context_actions(node_id).await?,
            })),
            None => durable_input
                .filter(|input| !input.contexts.is_empty())
                .map(ContextInput::Durable),
        };
        context_inputs.push(context_input);
        submitted_evidence.push(product.submitted_input_evidence(interaction.id).await?);
    }
    for invocation in conversation_invocations {
        let source_index = *interaction_indexes
            .get(&invocation.source_interaction_id)
            .ok_or_else(|| {
                ConversationExportBuildError::Invalid(format!(
                    "action invocation source interaction {} is outside the conversation snapshot",
                    invocation.source_interaction_id
                ))
            })?;
        let result_index = *interaction_indexes
            .get(&invocation.result_interaction_id)
            .ok_or_else(|| {
                ConversationExportBuildError::Invalid(format!(
                    "action invocation result interaction {} is outside the conversation snapshot",
                    invocation.result_interaction_id
                ))
            })?;
        if source_index >= result_index {
            return Err(ConversationExportBuildError::Invalid(
                "action invocation does not point from an earlier turn to a later turn".into(),
            ));
        }
        let action = closures[source_index]
            .as_ref()
            .and_then(|closure| {
                closure
                    .layers
                    .iter()
                    .flat_map(|layer| &layer.actions)
                    .find(|action| action.id.value() == invocation.action_id)
            })
            .ok_or_else(|| {
                ConversationExportBuildError::Invalid(format!(
                    "action invocation references action {} outside the source accepted view",
                    invocation.action_id
                ))
            })?;
        if action.kind != ActionKind::Invoke
            || action.interaction_text.as_deref()
                != Some(detail.interactions[result_index].text.as_str())
        {
            return Err(ConversationExportBuildError::Invalid(format!(
                "action invocation {} does not match its accepted invoke action",
                invocation.action_id
            )));
        }
    }

    let turns = detail
        .interactions
        .iter()
        .map(|interaction| {
            Ok(ExportTurnManifestEntry {
                id: turn_id(interaction.sequence),
                sequence: sequence(interaction.sequence)?,
            })
        })
        .collect::<Result<Vec<_>, ConversationExportBuildError>>()?;
    let header = ConversationExportRecord::Header(Box::new(ConversationExportHeader {
        export_version: EXPORT_VERSION_V1,
        exported_at,
        producer,
        conversation: ExportConversation {
            id: "conversation:1".into(),
            title: redactor.text(&detail.thread.title),
            created_at: detail.thread.created_at,
            project_name,
            harness_configuration_name: detail.thread.harness_configuration_name,
            permission_profile_id: detail.thread.permission_profile_id,
        },
        turns,
    }));
    let mut records = vec![header];
    for (((interaction, closure), context_input), submitted_evidence) in detail
        .interactions
        .iter()
        .zip(closures.iter())
        .zip(context_inputs.iter())
        .zip(submitted_evidence.iter())
    {
        records.push(ConversationExportRecord::Turn(Box::new(export_turn(
            interaction,
            TurnExportContext {
                closure: closure.as_ref(),
                context_input: context_input.as_ref(),
                submitted_evidence,
                invocation: invocations.get(&interaction.id).copied(),
                imported: ImportedExportContext {
                    turn: imported_turns.get(&interaction.id).copied(),
                    turn_sequences: &imported_turn_sequences,
                },
                turn_sequences: &turn_sequences,
                redactor: &redactor,
            },
            &mut ids,
        )?)));
    }
    validate_export_records(&records)?;
    let mut body = Vec::new();
    for record in &records {
        let line = serde_json::to_vec(record)?;
        if line.len() > MAX_JSONL_LINE_BYTES {
            return Err(ConversationExportBuildError::Invalid(format!(
                "serialized JSONL record exceeds {MAX_JSONL_LINE_BYTES} bytes"
            )));
        }
        if body.len().saturating_add(line.len()).saturating_add(1) > MAX_EXPORT_BYTES {
            return Err(ConversationExportBuildError::Invalid(format!(
                "serialized conversation export exceeds {MAX_EXPORT_BYTES} bytes"
            )));
        }
        body.extend_from_slice(&line);
        body.push(b'\n');
    }
    Ok(body)
}

struct ImportedExportContext<'a> {
    turn: Option<&'a crate::storage::ImportedTurnExportRecord>,
    turn_sequences: &'a HashMap<&'a str, i64>,
}

struct RuntimeContextInput {
    input: InteractionInput,
    actions: Vec<InteractionContextAction>,
}

enum ContextInput {
    Runtime(RuntimeContextInput),
    Durable(DurableInteractionInput),
}

struct TurnExportContext<'a> {
    closure: Option<&'a AcceptedGraphClosure>,
    context_input: Option<&'a ContextInput>,
    submitted_evidence: &'a [SubmittedInputEvidence],
    invocation: Option<&'a ActionInvocation>,
    imported: ImportedExportContext<'a>,
    turn_sequences: &'a HashMap<InteractionId, i64>,
    redactor: &'a ProjectPathRedactor,
}

fn export_turn(
    interaction: &Interaction,
    context: TurnExportContext<'_>,
    ids: &mut PortableIds,
) -> Result<ConversationExportTurn, ConversationExportBuildError> {
    let TurnExportContext {
        closure,
        context_input,
        submitted_evidence,
        invocation,
        imported,
        turn_sequences,
        redactor,
    } = context;
    if let (Some(node_id), Some(imported_turn)) = (
        interaction.graph_node_id,
        imported.turn.map(|record| &record.turn),
    ) && let Some(portable_id) = imported_turn.interaction_node_id.as_ref().or_else(|| {
        imported_turn
            .accepted_view
            .as_ref()
            .map(|view| &view.interaction_node_id)
    }) {
        ids.bind_node(node_id, portable_id.clone())?;
    }
    if let (Some(closure), Some(imported_view)) = (
        closure,
        imported
            .turn
            .and_then(|record| record.turn.accepted_view.as_ref()),
    ) {
        seed_imported_action_ids(interaction.id, closure, imported_view, ids)?;
    }
    let accepted_view = closure
        .map(|closure| export_view(closure, ids, redactor))
        .transpose()?;
    let contexts = export_contexts(
        interaction,
        context_input,
        imported.turn.map(|record| &record.turn.contexts),
        ids,
        redactor,
    )?;
    let submitted_inputs = export_submitted_inputs(
        interaction,
        submitted_evidence,
        imported.turn.map(|record| &record.turn.submitted_inputs),
        ids,
        redactor,
    )?;
    let interaction_node_id = interaction
        .graph_node_id
        .map(|node_id| ids.node(node_id))
        .or_else(|| {
            (!submitted_inputs.is_empty())
                .then(|| format!("node:input-root-{}", interaction.sequence))
        });
    let origin = match invocation {
        Some(invocation) => {
            let source_action_id = ids.action.get(&invocation.action_id).cloned().ok_or_else(|| {
                ConversationExportBuildError::Invalid(format!(
                    "action invocation for interaction {} references action {} outside its source accepted view",
                    interaction.id, invocation.action_id
                ))
            })?;
            ExportTurnOrigin::Action {
                source_turn_id: turn_id(*turn_sequences.get(&invocation.source_interaction_id).ok_or_else(|| {
                    ConversationExportBuildError::Invalid(format!(
                        "action invocation source interaction {} is outside the conversation snapshot",
                        invocation.source_interaction_id
                    ))
                })?),
                source_action_id,
            }
        }
        None => match imported.turn.map(|record| &record.origin) {
            Some(ExportTurnOrigin::Action {
                source_turn_id,
                source_action_id,
            }) => ExportTurnOrigin::Action {
                source_turn_id: turn_id(*imported.turn_sequences.get(source_turn_id.as_str()).ok_or_else(
                    || {
                        ConversationExportBuildError::Invalid(format!(
                            "imported action origin for interaction {} references turn {} outside the conversation snapshot",
                            interaction.id, source_turn_id
                        ))
                    },
                )?),
                source_action_id: source_action_id.clone(),
            },
            _ => ExportTurnOrigin::User,
        },
    };
    let status = completion_status(&interaction.completion_status)?;
    let mut effective_permission_receipt = interaction
        .effective_permission_receipt
        .clone()
        .map(serde_json::from_value::<ExportPermissionReceipt>)
        .transpose()
        .map_err(|error| {
            ConversationExportBuildError::Invalid(format!(
                "interaction {} has an invalid normalized permission receipt: {error}",
                interaction.id
            ))
        })?;
    if let Some(receipt) = &mut effective_permission_receipt {
        receipt.label = redactor.text(&receipt.label);
        receipt.authority = redactor.text(&receipt.authority);
        receipt.reviewer = redactor.text(&receipt.reviewer);
        receipt.disclosure = redactor.optional(receipt.disclosure.as_deref());
    }
    let imported_completion = interaction
        .latest_attempt
        .is_none()
        .then(|| imported.turn.map(|record| &record.turn.completion))
        .flatten();
    Ok(ConversationExportTurn {
        id: turn_id(interaction.sequence),
        sequence: sequence(interaction.sequence)?,
        created_at: interaction.created_at.clone(),
        text: redactor.text(&interaction.text),
        interaction_node_id,
        origin,
        completion: ExportCompletionReceipt {
            status,
            attempt_outcome: interaction
                .latest_attempt
                .as_ref()
                .map(|attempt| attempt_outcome(&attempt.outcome))
                .transpose()?
                .or_else(|| imported_completion.and_then(|completion| completion.attempt_outcome)),
            harness_configuration_name: interaction.harness_configuration_name.clone(),
            harness_configuration_digest: interaction.harness_configuration_digest.clone(),
            model_selection: interaction
                .model_selection
                .as_ref()
                .map(|selection| ExportModelSelection {
                    provider_id: selection.provider_id.as_str().into(),
                    model_id: selection.model_id.clone(),
                    model_family_id: selection.family_id.value(),
                })
                .or_else(|| {
                    imported_completion.and_then(|completion| completion.model_selection.clone())
                }),
            permission_profile_id: interaction.permission_profile_id.clone(),
            effective_execution_digest: interaction.effective_execution_digest.clone(),
            effective_permission_receipt,
            error: interaction
                .completion_error
                .as_deref()
                .map(|error| redactor.text(error)),
            attempt_admission_id: interaction
                .latest_attempt
                .as_ref()
                .and_then(|attempt| attempt.attempt_admission_id.clone())
                .or_else(|| {
                    imported_completion
                        .and_then(|completion| completion.attempt_admission_id.clone())
                }),
            admitted_model_plan: interaction
                .latest_attempt
                .as_ref()
                .and_then(|attempt| {
                    attempt
                        .admitted_plan
                        .as_ref()
                        .map(|plan| ExportAdmittedExecutionModelPlan {
                            family_id: plan.family_id.value(),
                            family_revision: plan.family_revision,
                            orchestrator: ExportAdmittedExecutionModelRoute {
                                provider_id: plan.orchestrator.provider_id.as_str().into(),
                                adapter_id: plan.orchestrator.adapter_id.clone(),
                                access_contract: plan.orchestrator.access_contract.clone(),
                                model_id: plan.orchestrator.model_id.clone(),
                                adapter_implementation_version: plan
                                    .orchestrator
                                    .adapter_implementation_version
                                    .clone(),
                            },
                            roster: plan
                                .roster
                                .iter()
                                .map(|route| ExportAdmittedExecutionModelRoute {
                                    provider_id: route.provider_id.as_str().into(),
                                    adapter_id: route.adapter_id.clone(),
                                    access_contract: route.access_contract.clone(),
                                    model_id: route.model_id.clone(),
                                    adapter_implementation_version: route
                                        .adapter_implementation_version
                                        .clone(),
                                })
                                .collect(),
                            harness_policy_digest: plan.harness_policy_digest.clone(),
                            digest: plan.digest.clone(),
                        })
                })
                .or_else(|| {
                    imported_completion
                        .and_then(|completion| completion.admitted_model_plan.clone())
                }),
        },
        contexts,
        submitted_inputs,
        accepted_view,
    })
}

fn export_contexts(
    interaction: &Interaction,
    input: Option<&ContextInput>,
    imported: Option<&Vec<ExportInteractionContext>>,
    ids: &mut PortableIds,
    redactor: &ProjectPathRedactor,
) -> Result<Vec<ExportInteractionContext>, ConversationExportBuildError> {
    let Some(input) = input else {
        if imported.is_some_and(|contexts| !contexts.is_empty()) {
            return Err(ConversationExportBuildError::Invalid(format!(
                "imported interaction {} lost its graph context materialization",
                interaction.id
            )));
        }
        return Ok(Vec::new());
    };
    let ContextInput::Runtime(runtime) = input else {
        let ContextInput::Durable(durable) = input else {
            unreachable!()
        };
        if imported.is_some_and(|contexts| !contexts.is_empty()) {
            return Err(ConversationExportBuildError::Invalid(format!(
                "imported interaction {} lost its graph context materialization",
                interaction.id
            )));
        }
        return Err(ConversationExportBuildError::Invalid(format!(
            "interaction {} has {} durable context attachment(s) whose graph authority is not yet bound; retry export after interaction recovery",
            interaction.id,
            durable.contexts.len()
        )));
    };
    if runtime.input.interaction.id.value() != interaction.graph_node_id.unwrap_or_default()
        || runtime.input.contexts.len() != runtime.actions.len()
    {
        return Err(ConversationExportBuildError::Invalid(format!(
            "interaction {} graph context diagnostics are inconsistent",
            interaction.id
        )));
    }
    if let Some(imported) = imported.filter(|contexts| !contexts.is_empty()) {
        if imported.len() != runtime.input.contexts.len() {
            return Err(ConversationExportBuildError::Invalid(format!(
                "imported interaction {} context inventory no longer matches its portable record",
                interaction.id
            )));
        }
        for ((portable, normalized), action) in imported
            .iter()
            .zip(&runtime.input.contexts)
            .zip(&runtime.actions)
        {
            if normalized.target_node.id != action.target.node_id
                || normalized.annotations != portable.annotations
                || action.annotations != portable.annotations
                || redactor.text(&normalized.target_node.kind) != portable.target.kind
                || redactor.text(&normalized.target_node.icon) != portable.target.icon
                || redactor.text(&normalized.target_node.title) != portable.target.title
                || redactor.text(&normalized.target_node.detail) != portable.target.detail
            {
                return Err(ConversationExportBuildError::Invalid(format!(
                    "imported interaction {} context no longer matches its immutable portable snapshot",
                    interaction.id
                )));
            }
        }
        return Ok(imported
            .iter()
            .cloned()
            .map(|mut context| {
                context.annotations = context
                    .annotations
                    .iter()
                    .map(|annotation| redactor.text(annotation))
                    .collect();
                context
            })
            .collect());
    }

    runtime
        .input
        .contexts
        .iter()
        .zip(&runtime.actions)
        .map(|(normalized, action)| {
            if normalized.target_node.id != action.target.node_id
                || normalized.annotations != action.annotations
            {
                return Err(ConversationExportBuildError::Invalid(format!(
                    "interaction {} context input and provenance disagree",
                    interaction.id
                )));
            }
            ensure_accepted(
                normalized.target_node.state,
                "context target",
                normalized.target_node.id.value(),
            )?;
            ensure_accepted(action.state, "context action", action.id.value())?;
            Ok(ExportInteractionContext {
                id: ids.action(action.id.value()),
                target: ExportContextTargetSnapshot {
                    id: ids.node(normalized.target_node.id.value()),
                    kind: redactor.text(&normalized.target_node.kind),
                    icon: redactor.text(&normalized.target_node.icon),
                    title: redactor.text(&normalized.target_node.title),
                    detail: redactor.text(&normalized.target_node.detail),
                    state: ExportRecordState::Accepted,
                },
                source: ExportContextSource {
                    interaction_node_id: ids.node(action.target.source_interaction_node_id.value()),
                    layer_id: ids.layer(action.target.source_layer_id.value()),
                },
                annotations: normalized
                    .annotations
                    .iter()
                    .map(|annotation| redactor.text(annotation))
                    .collect(),
            })
        })
        .collect()
}

fn export_submitted_inputs(
    interaction: &Interaction,
    evidence: &[SubmittedInputEvidence],
    imported: Option<&Vec<ExportSubmittedInput>>,
    ids: &mut PortableIds,
    redactor: &ProjectPathRedactor,
) -> Result<Vec<ExportSubmittedInput>, ConversationExportBuildError> {
    if evidence.is_empty() {
        let mut imported = imported.cloned().unwrap_or_default();
        for submitted in &mut imported {
            submitted.root_turn_id = turn_id(interaction.sequence);
            redact_submitted_input(submitted, redactor);
        }
        imported.sort_by_key(submitted_input_sort_key);
        return Ok(imported);
    }
    if imported.is_some_and(|inputs| !inputs.is_empty()) {
        return Err(ConversationExportBuildError::Invalid(format!(
            "interaction {} has both native and imported submitted input evidence",
            interaction.id
        )));
    }
    let root_turn_id = turn_id(interaction.sequence);
    let mut evidence = evidence.to_vec();
    evidence.sort_by_key(|input| input.occurrence.clone());
    let mut exported = evidence
        .into_iter()
        .enumerate()
        .map(|(index, input)| {
            if !matches!(
                input.attempt_state.as_str(),
                "reserved" | "preparing" | "bound" | "running" | "accepted" | "failed" | "stopped"
            ) {
                return Err(ConversationExportBuildError::Invalid(format!(
                    "interaction {} has unknown submitted input attempt state {}",
                    interaction.id, input.attempt_state
                )));
            }
            let minimum_selections = input
                .action
                .minimum_selections
                .map(|minimum| {
                    u32::try_from(minimum).map_err(|_| {
                        ConversationExportBuildError::Invalid(format!(
                            "interaction {} input minimum exceeds portable range",
                            interaction.id
                        ))
                    })
                })
                .transpose()?;
            let option_keys = injective_portable_option_keys(
                input
                    .action
                    .options
                    .iter()
                    .map(|option| option.key.as_str()),
                redactor,
            );
            let action = ExportInputActionSnapshot {
                control: match input.action.control {
                    relayer_graph_core::InputControl::Text => ExportInputControl::Text,
                    relayer_graph_core::InputControl::SingleSelect => {
                        ExportInputControl::SingleSelect
                    }
                    relayer_graph_core::InputControl::MultiSelect => {
                        ExportInputControl::MultiSelect
                    }
                    relayer_graph_core::InputControl::Unsupported => {
                        return Err(ConversationExportBuildError::Invalid(format!(
                            "interaction {} has an unsupported accepted input control",
                            interaction.id
                        )));
                    }
                },
                prompt: redactor.text(&input.action.prompt),
                options: input
                    .action
                    .options
                    .into_iter()
                    .map(|option| ExportInputOption {
                        key: option_keys
                            .get(&option.key)
                            .expect("accepted option key was indexed")
                            .clone(),
                        label: redactor.text(&option.label),
                        unsupported_fields: Default::default(),
                    })
                    .collect(),
                minimum_selections,
                unsupported_fields: Default::default(),
            };
            let value = match input.value {
                relayer_graph_core::SubmittedInputValue::Text { text } => {
                    ExportSubmittedInputValue::Text {
                        text: redactor.text(&text),
                    }
                }
                relayer_graph_core::SubmittedInputValue::Selected { selected } => {
                    let mut selected = selected
                        .into_iter()
                        .map(|option| ExportInputOption {
                            key: option_keys
                                .get(&option.key)
                                .cloned()
                                .unwrap_or_else(|| redactor.text(&option.key)),
                            label: redactor.text(&option.label),
                            unsupported_fields: Default::default(),
                        })
                        .collect::<Vec<_>>();
                    selected.sort_by(|left, right| left.key.as_bytes().cmp(right.key.as_bytes()));
                    ExportSubmittedInputValue::Selected { selected }
                }
            };
            Ok(ExportSubmittedInput {
                id: format!("input-child:{}-{}", interaction.sequence, index + 1),
                root_turn_id: root_turn_id.clone(),
                source: ExportInputSource {
                    interaction_node_id: ids
                        .node(input.occurrence.presenting_interaction_node_id.value()),
                    layer_id: ids.layer(input.occurrence.presenting_layer_id.value()),
                    action_id: ids.action(input.occurrence.action_id.value()),
                    node_id: ids.node(input.source_node_id),
                },
                action,
                value,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    exported.sort_by_key(submitted_input_sort_key);
    Ok(exported)
}

fn redact_submitted_input(input: &mut ExportSubmittedInput, redactor: &ProjectPathRedactor) {
    input.action.prompt = redactor.text(&input.action.prompt);
    let option_keys = injective_portable_option_keys(
        input
            .action
            .options
            .iter()
            .map(|option| option.key.as_str()),
        redactor,
    );
    for option in &mut input.action.options {
        option.key = option_keys
            .get(&option.key)
            .expect("portable option key was indexed")
            .clone();
        option.label = redactor.text(&option.label);
    }
    match &mut input.value {
        ExportSubmittedInputValue::Text { text } => *text = redactor.text(text),
        ExportSubmittedInputValue::Selected { selected } => {
            for option in &mut *selected {
                option.key = option_keys
                    .get(&option.key)
                    .cloned()
                    .unwrap_or_else(|| redactor.text(&option.key));
                option.label = redactor.text(&option.label);
            }
            selected.sort_by(|left, right| left.key.as_bytes().cmp(right.key.as_bytes()));
        }
    }
}

pub(crate) fn portable_interaction_input_bytes(
    project_path: Option<&str>,
    text: &str,
    contexts: &[crate::product::InteractionContextIntent],
    submitted_inputs: &[relayer_graph_core::SubmittedInputDraft],
    context_snapshots: &[relayer_graph_core::InteractionInputNode],
) -> Result<usize, serde_json::Error> {
    const PORTABLE_TURN_ENVELOPE_BYTES: usize = 1_024;
    const PORTABLE_INPUT_IDENTITY_BYTES: usize = 512;
    // Imported history may bind every context identity to the V1 128-byte maximum. The
    // estimator's numeric stand-ins are shorter, so reserve the full four-field identity budget.
    const PORTABLE_CONTEXT_IDENTITY_BYTES: usize = 4 * 128;

    let redactor = ProjectPathRedactor::new(project_path);
    let text = redactor.text(text);
    let contexts = contexts
        .iter()
        .zip(context_snapshots)
        .enumerate()
        .map(|(index, (context, snapshot))| ExportInteractionContext {
            id: format!(
                "action:{}-{}-{}-{}",
                context.target.source_interaction_node_id,
                context.target.source_layer_id,
                context.target.node_id,
                index + 1
            ),
            target: ExportContextTargetSnapshot {
                id: format!("node:{}", context.target.node_id),
                kind: redactor.text(&snapshot.kind),
                icon: redactor.text(&snapshot.icon),
                title: redactor.text(&snapshot.title),
                detail: redactor.text(&snapshot.detail),
                state: ExportRecordState::Accepted,
            },
            source: ExportContextSource {
                interaction_node_id: format!("node:{}", context.target.source_interaction_node_id),
                layer_id: format!("layer:{}", context.target.source_layer_id),
            },
            annotations: context
                .annotations
                .iter()
                .map(|annotation| redactor.text(annotation))
                .collect(),
        })
        .collect::<Vec<_>>();
    let submitted_inputs = submitted_inputs
        .iter()
        .cloned()
        .map(|mut input| {
            input.action.prompt = redactor.text(&input.action.prompt);
            let option_keys = injective_portable_option_keys(
                input
                    .action
                    .options
                    .iter()
                    .map(|option| option.key.as_str()),
                &redactor,
            );
            for option in &mut input.action.options {
                option.key = option_keys
                    .get(&option.key)
                    .expect("submitted option key was indexed")
                    .clone();
                option.label = redactor.text(&option.label);
            }
            match &mut input.value {
                relayer_graph_core::SubmittedInputValue::Text { text } => {
                    *text = redactor.text(text)
                }
                relayer_graph_core::SubmittedInputValue::Selected { selected } => {
                    for option in &mut *selected {
                        option.key = option_keys
                            .get(&option.key)
                            .cloned()
                            .unwrap_or_else(|| redactor.text(&option.key));
                        option.label = redactor.text(&option.label);
                    }
                    selected.sort_by(|left, right| left.key.as_bytes().cmp(right.key.as_bytes()));
                }
            }
            input
        })
        .collect::<Vec<_>>();

    Ok(serde_json::to_vec(&(&text, &contexts, &submitted_inputs))?
        .len()
        .saturating_add(PORTABLE_TURN_ENVELOPE_BYTES)
        .saturating_add(
            submitted_inputs
                .len()
                .saturating_mul(PORTABLE_INPUT_IDENTITY_BYTES),
        )
        .saturating_add(
            contexts
                .len()
                .saturating_mul(PORTABLE_CONTEXT_IDENTITY_BYTES),
        ))
}

fn submitted_input_sort_key(input: &ExportSubmittedInput) -> Vec<u8> {
    serde_json::to_vec(&(
        &input.source.interaction_node_id,
        &input.source.layer_id,
        &input.source.action_id,
        &input.source.node_id,
        &input.action,
        &input.value,
    ))
    .expect("portable submitted input sort key serializes")
}

fn seed_imported_action_ids(
    interaction_id: InteractionId,
    closure: &AcceptedGraphClosure,
    imported: &ExportAcceptedView,
    ids: &mut PortableIds,
) -> Result<(), ConversationExportBuildError> {
    ids.bind_action(
        closure.root_action.id.value(),
        imported.root_action.id.clone(),
    )?;
    if closure.layers.len() != imported.layers.len() {
        return Err(ConversationExportBuildError::Invalid(format!(
            "imported interaction {interaction_id} graph closure no longer matches its portable accepted view"
        )));
    }
    for (resolved, imported_resolved) in closure.layers.iter().zip(&imported.layers) {
        ids.bind_layer(
            resolved.layer.id.value(),
            imported_resolved.layer.id.clone(),
        )?;
        if resolved.nodes.len() != imported_resolved.nodes.len()
            || resolved.edges.len() != imported_resolved.edges.len()
        {
            return Err(ConversationExportBuildError::Invalid(format!(
                "imported interaction {interaction_id} graph record inventory no longer matches its portable accepted view"
            )));
        }
        for (node, imported_node) in resolved.nodes.iter().zip(&imported_resolved.nodes) {
            ids.bind_node(node.id.value(), imported_node.id.clone())?;
        }
        for (edge, imported_edge) in resolved.edges.iter().zip(&imported_resolved.edges) {
            ids.bind_edge(edge.id.value(), imported_edge.id.clone())?;
        }
        if resolved.actions.len() != imported_resolved.actions.len() {
            return Err(ConversationExportBuildError::Invalid(format!(
                "imported interaction {interaction_id} action inventory no longer matches its portable accepted view"
            )));
        }
        for (action, imported_action) in resolved.actions.iter().zip(&imported_resolved.actions) {
            let expected_kind = match action.kind {
                ActionKind::Navigate => ExportActionKind::Navigate,
                ActionKind::Invoke => ExportActionKind::Invoke,
                ActionKind::Input => ExportActionKind::Input,
                ActionKind::InteractionContext => continue,
            };
            if imported_action.kind != expected_kind {
                return Err(ConversationExportBuildError::Invalid(format!(
                    "imported interaction {interaction_id} action order no longer matches its portable accepted view"
                )));
            }
            ids.bind_action(action.id.value(), imported_action.id.clone())?;
        }
    }
    Ok(())
}

fn export_view(
    closure: &AcceptedGraphClosure,
    ids: &mut PortableIds,
    redactor: &ProjectPathRedactor,
) -> Result<ExportAcceptedView, ConversationExportBuildError> {
    let interaction_node_id = ids.node(closure.node_id.value());
    let root_action = export_action(&closure.root_action, ids, redactor)?;
    let root_layer_id = ids.layer(closure.root_layer_id.value());
    let layers = closure
        .layers
        .iter()
        .map(|layer| export_layer(layer, ids, redactor))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ExportAcceptedView {
        interaction_node_id,
        root_action,
        root_layer_id,
        layers,
    })
}

fn export_layer(
    resolved: &ResolvedLayer,
    ids: &mut PortableIds,
    redactor: &ProjectPathRedactor,
) -> Result<ExportResolvedLayer, ConversationExportBuildError> {
    ensure_accepted(resolved.layer.state, "layer", resolved.layer.id.value())?;
    let nodes = resolved
        .nodes
        .iter()
        .map(|node| export_node(node, ids, redactor))
        .collect::<Result<Vec<_>, _>>()?;
    let edges = resolved
        .edges
        .iter()
        .map(|edge| export_edge(edge, ids))
        .collect::<Result<Vec<_>, _>>()?;
    let actions = resolved
        .actions
        .iter()
        .map(|action| export_action(action, ids, redactor))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ExportResolvedLayer {
        layer: ExportLayer {
            id: ids.layer(resolved.layer.id.value()),
            client_key: resolved.layer.client_key.clone(),
            nodes: resolved
                .layer
                .nodes
                .iter()
                .map(|id| ids.node(id.value()))
                .collect(),
            edges: resolved
                .layer
                .edges
                .iter()
                .map(|id| ids.edge(id.value()))
                .collect(),
            layout: resolved
                .layer
                .layout
                .as_ref()
                .map(|layout| ExportLayerLayout {
                    version: layout.version,
                    placements: layout
                        .placements()
                        .iter()
                        .map(|placement| ExportNodePlacement {
                            node_id: ids.node(placement.node_id.value()),
                            x: placement.x,
                            y: placement.y,
                        })
                        .collect(),
                }),
            state: ExportRecordState::Accepted,
        },
        nodes,
        edges,
        actions,
    })
}

fn export_node(
    node: &GraphNode,
    ids: &mut PortableIds,
    redactor: &ProjectPathRedactor,
) -> Result<ExportNode, ConversationExportBuildError> {
    ensure_accepted(node.state, "node", node.id.value())?;
    let authored_detail = node
        .authored_detail
        .as_ref()
        .and_then(|detail| portable_authored_detail(detail, redactor));
    let authored_detail_omitted = (node.authored_detail.is_some() && authored_detail.is_none())
        .then_some(ExportAuthoredDetailOmission::PrivatePath);
    Ok(ExportNode {
        id: ids.node(node.id.value()),
        client_key: node.client_key.clone(),
        kind: redactor.text(&node.kind),
        icon: redactor.text(&node.icon),
        title: redactor.text(&node.title),
        detail: redactor.text(&node.detail),
        authored_detail,
        authored_detail_omitted,
        state: ExportRecordState::Accepted,
    })
}

fn portable_authored_detail(
    authored_detail: &serde_json::Value,
    redactor: &ProjectPathRedactor,
) -> Option<serde_json::Value> {
    (!json_contains_private_project_path(authored_detail, redactor))
        .then(|| authored_detail.clone())
}

fn json_contains_private_project_path(
    value: &serde_json::Value,
    redactor: &ProjectPathRedactor,
) -> bool {
    match value {
        serde_json::Value::String(text) => redactor.contains_private_path(text),
        serde_json::Value::Array(values) => values
            .iter()
            .any(|value| json_contains_private_project_path(value, redactor)),
        serde_json::Value::Object(values) => values
            .values()
            .any(|value| json_contains_private_project_path(value, redactor)),
        _ => false,
    }
}

fn export_edge(
    edge: &GraphEdge,
    ids: &mut PortableIds,
) -> Result<ExportEdge, ConversationExportBuildError> {
    ensure_accepted(edge.state, "edge", edge.id.value())?;
    Ok(ExportEdge {
        id: ids.edge(edge.id.value()),
        endpoints: [
            ids.node(edge.endpoints[0].value()),
            ids.node(edge.endpoints[1].value()),
        ],
        state: ExportRecordState::Accepted,
    })
}

fn export_action(
    action: &GraphAction,
    ids: &mut PortableIds,
    redactor: &ProjectPathRedactor,
) -> Result<ExportAction, ConversationExportBuildError> {
    ensure_accepted(action.state, "action", action.id.value())?;
    let kind = match action.kind {
        ActionKind::Navigate => ExportActionKind::Navigate,
        ActionKind::Invoke => ExportActionKind::Invoke,
        ActionKind::Input => ExportActionKind::Input,
        ActionKind::InteractionContext => {
            return Err(ConversationExportBuildError::Invalid(
                "interaction context actions are not exported as graph actions".into(),
            ));
        }
    };
    let relation = action.relation.map(|relation| match relation {
        NavigateRelation::Expand => ExportNavigateRelation::Expand,
        NavigateRelation::Reference => ExportNavigateRelation::Reference,
    });
    let variant = match action.variant {
        ActionVariant::Chip => ExportActionVariant::Chip,
        ActionVariant::Pill => ExportActionVariant::Pill,
        ActionVariant::Wide => ExportActionVariant::Wide,
        ActionVariant::Card => ExportActionVariant::Card,
        ActionVariant::Unsupported(ref value) => {
            return Err(ConversationExportBuildError::Invalid(format!(
                "accepted action {} has unsupported variant {value}",
                action.id
            )));
        }
    };
    Ok(ExportAction {
        id: ids.action(action.id.value()),
        client_key: action.client_key.clone(),
        source_node_id: ids.node(action.source_node_id.value()),
        source_layer_id: action.source_layer_id.map(|id| ids.layer(id.value())),
        kind,
        relation,
        label: redactor.text(&action.label),
        variant,
        icon: redactor.optional(action.icon.as_deref()),
        description: redactor.optional(action.description.as_deref()),
        // Invoke resolution is a runtime projection. Portable history keeps the authored
        // invoke shape; the following turn's origin carries the durable provenance link.
        target_layer_id: if action.kind == ActionKind::Navigate {
            action.target_layer_id.map(|id| ids.layer(id.value()))
        } else {
            None
        },
        interaction_text: redactor.optional(action.interaction_text.as_deref()),
        input: action
            .input
            .as_ref()
            .map(|input| export_input_action(input, redactor))
            .transpose()?,
        state: ExportRecordState::Accepted,
    })
}

fn export_input_action(
    input: &relayer_graph_core::InputAction,
    redactor: &ProjectPathRedactor,
) -> Result<ExportInputActionSnapshot, ConversationExportBuildError> {
    let control = match input.control {
        relayer_graph_core::InputControl::Text => ExportInputControl::Text,
        relayer_graph_core::InputControl::SingleSelect => ExportInputControl::SingleSelect,
        relayer_graph_core::InputControl::MultiSelect => ExportInputControl::MultiSelect,
        relayer_graph_core::InputControl::Unsupported => {
            return Err(ConversationExportBuildError::Invalid(
                "accepted input action has an unsupported control".into(),
            ));
        }
    };
    let option_keys = injective_portable_option_keys(
        input.options.iter().map(|option| option.key.as_str()),
        redactor,
    );
    Ok(ExportInputActionSnapshot {
        control,
        prompt: redactor.text(&input.prompt),
        options: input
            .options
            .iter()
            .map(|option| ExportInputOption {
                key: option_keys
                    .get(&option.key)
                    .expect("accepted option key was indexed")
                    .clone(),
                label: redactor.text(&option.label),
                unsupported_fields: Default::default(),
            })
            .collect(),
        minimum_selections: input
            .minimum_selections
            .map(u32::try_from)
            .transpose()
            .map_err(|_| {
                ConversationExportBuildError::Invalid(
                    "accepted input action minimum exceeds portable range".into(),
                )
            })?,
        unsupported_fields: Default::default(),
    })
}

fn ensure_accepted(
    state: RecordState,
    kind: &str,
    id: i64,
) -> Result<(), ConversationExportBuildError> {
    if state == RecordState::Accepted {
        Ok(())
    } else {
        Err(ConversationExportBuildError::Invalid(format!(
            "{kind} {id} is not accepted"
        )))
    }
}

fn completion_status(value: &str) -> Result<ExportCompletionStatus, ConversationExportBuildError> {
    match value {
        "not_started" => Ok(ExportCompletionStatus::NotStarted),
        "running" => Ok(ExportCompletionStatus::Running),
        "submitted" => Ok(ExportCompletionStatus::Submitted),
        "waiting_for_approval" => Ok(ExportCompletionStatus::WaitingForApproval),
        "accepted" => Ok(ExportCompletionStatus::Accepted),
        "failed" => Ok(ExportCompletionStatus::Failed),
        "stopped" => Ok(ExportCompletionStatus::Stopped),
        other => Err(ConversationExportBuildError::Invalid(format!(
            "unknown completion status {other}"
        ))),
    }
}

fn attempt_outcome(value: &str) -> Result<ExportAttemptOutcome, ConversationExportBuildError> {
    match value {
        "running" => Ok(ExportAttemptOutcome::Running),
        "accepted" => Ok(ExportAttemptOutcome::Accepted),
        "model_failed" => Ok(ExportAttemptOutcome::ModelFailed),
        "execution_failed" => Ok(ExportAttemptOutcome::ExecutionFailed),
        "cancelled" => Ok(ExportAttemptOutcome::Cancelled),
        other => Err(ConversationExportBuildError::Invalid(format!(
            "unknown attempt outcome {other}"
        ))),
    }
}

fn sequence(value: i64) -> Result<u32, ConversationExportBuildError> {
    u32::try_from(value).map_err(|_| {
        ConversationExportBuildError::Invalid(format!("invalid interaction sequence {value}"))
    })
}

fn turn_id(sequence: i64) -> String {
    format!("turn:{sequence}")
}

struct ProjectPathRedactor {
    project_paths: Vec<String>,
}

impl ProjectPathRedactor {
    fn new(project_path: Option<&str>) -> Self {
        let mut project_paths = Vec::new();
        if let Some(path) = project_path.filter(|path| !path.is_empty()) {
            project_paths.push(path.to_owned());
            if let Some(suffix) = path.strip_prefix("/private/var/") {
                project_paths.push(format!("/var/{suffix}"));
            } else if let Some(suffix) = path.strip_prefix("/var/") {
                project_paths.push(format!("/private/var/{suffix}"));
            }
            if let Some(suffix) = path.strip_prefix("/private/tmp/") {
                project_paths.push(format!("/tmp/{suffix}"));
            } else if let Some(suffix) = path.strip_prefix("/tmp/") {
                project_paths.push(format!("/private/tmp/{suffix}"));
            }
        }
        project_paths.sort_by_key(|path| std::cmp::Reverse(path.len()));
        project_paths.dedup();
        Self { project_paths }
    }

    /// Redact every configured private path from Markdown-class text.
    ///
    /// Raw occurrences are replaced in place and every other byte is kept
    /// exactly. When a path survives only behind an encoding, each
    /// whitespace-delimited token that hides one is replaced whole, so
    /// unrelated text is never decoded or rewritten; if a match still spans
    /// tokens, the whole value collapses to the marker rather than leaking.
    fn text(&self, value: &str) -> String {
        let replaced = self.replace_raw(value);
        if !self.contains_private_path(&replaced) {
            return replaced;
        }
        let mut redacted = String::with_capacity(replaced.len());
        let mut rest = replaced.as_str();
        while let Some(character) = rest.chars().next() {
            if character.is_whitespace() {
                redacted.push(character);
                rest = &rest[character.len_utf8()..];
                continue;
            }
            let token_end = rest.find(char::is_whitespace).unwrap_or(rest.len());
            let (token, after) = rest.split_at(token_end);
            if self.contains_private_path(token) {
                redacted.push_str("[project-path]");
            } else {
                redacted.push_str(token);
            }
            rest = after;
        }
        if self.contains_private_path(&redacted) {
            "[project-path]".to_owned()
        } else {
            redacted
        }
    }

    fn replace_raw(&self, value: &str) -> String {
        self.project_paths
            .iter()
            .fold(value.to_owned(), |text, path| {
                text.replace(path, "[project-path]")
            })
    }

    fn contains_raw(&self, value: &str) -> bool {
        self.project_paths.iter().any(|path| value.contains(path))
    }

    /// The single private-path matcher shared by Markdown redaction and the
    /// authored-detail portability check. It matches the raw string and every
    /// bounded decoding round of HTML character references, percent-encoding,
    /// CSS escapes, and invisible code points.
    fn contains_private_path(&self, value: &str) -> bool {
        if self.project_paths.is_empty() {
            return false;
        }
        let mut candidate = value.to_owned();
        for _ in 0..NORMALIZATION_ROUNDS {
            if self.contains_raw(&candidate) {
                return true;
            }
            let mut changed = false;
            // Check after every individual step: a later decoder in the same
            // round may legitimately consume bytes (CSS `\w` -> `w`) that a
            // path exposed by an earlier decoder still needed.
            for step in DECODING_STEPS {
                let (next, step_changed) = step(&candidate);
                if step_changed && self.contains_raw(&next) {
                    return true;
                }
                changed |= step_changed;
                candidate = next;
            }
            if !changed {
                return false;
            }
        }
        // A path hidden behind an impractically deep chain of encodings must not
        // escape merely because the bounded decoder stopped making progress.
        true
    }

    fn optional(&self, value: Option<&str>) -> Option<String> {
        value.map(|value| self.text(value))
    }
}

const NORMALIZATION_ROUNDS: usize = 16;

/// Every decoding an authored string can hide a private path behind, applied
/// one step at a time so a match exposed by one step is never consumed by the
/// next before it is checked.
type DecodingStep = fn(&str) -> (String, bool);

const DECODING_STEPS: [DecodingStep; 4] = [
    strip_invisible_code_points,
    decode_html_character_references_once,
    percent_decode_once,
    decode_css_escapes_once,
];

/// Code points that render as nothing and so can split a path without
/// changing what a reader sees: Unicode format controls (general category Cf,
/// which includes zero-width spaces and joiners, bidi marks and isolates, the
/// soft hyphen, the byte-order mark, and tag characters), the combining
/// grapheme joiner, and the variation selectors.
fn is_invisible_code_point(character: char) -> bool {
    matches!(
        u32::from(character),
        0x00AD
            | 0x034F
            | 0x0600..=0x0605
            | 0x061C
            | 0x06DD
            | 0x070F
            | 0x0890..=0x0891
            | 0x08E2
            | 0x180E
            | 0x200B..=0x200F
            | 0x202A..=0x202E
            | 0x2060..=0x2064
            | 0x2066..=0x206F
            | 0xFE00..=0xFE0F
            | 0xFEFF
            | 0xFFF9..=0xFFFB
            | 0x110BD
            | 0x110CD
            | 0x13430..=0x1343F
            | 0x1BCA0..=0x1BCA3
            | 0x1D173..=0x1D17A
            | 0xE0001
            | 0xE0020..=0xE007F
            | 0xE0100..=0xE01EF
    )
}

fn strip_invisible_code_points(value: &str) -> (String, bool) {
    let visible: String = value
        .chars()
        .filter(|character| !is_invisible_code_point(*character))
        .collect();
    let changed = visible.len() != value.len();
    (visible, changed)
}

fn percent_decode_once(value: &str) -> (String, bool) {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut changed = false;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let Some(byte) = hex_pair(bytes[index + 1], bytes[index + 2])
        {
            decoded.push(byte);
            index += 3;
            changed = true;
            continue;
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    (String::from_utf8_lossy(&decoded).into_owned(), changed)
}

fn hex_pair(high: u8, low: u8) -> Option<u8> {
    let high = char::from(high).to_digit(16)?;
    let low = char::from(low).to_digit(16)?;
    u8::try_from(high * 16 + low).ok()
}

fn css_newline_len(rest: &str) -> Option<usize> {
    if rest.starts_with("\r\n") {
        Some(2)
    } else if matches!(rest.chars().next(), Some('\n' | '\r' | '\u{c}')) {
        Some(1)
    } else {
        None
    }
}

/// Decode CSS escapes the way a stylesheet tokenizer would: hex escapes of one
/// to six digits swallow one following whitespace (CRLF counts as one), an
/// escaped newline is a line continuation, and any other escaped code point is
/// itself.
fn decode_css_escapes_once(value: &str) -> (String, bool) {
    let mut decoded = String::with_capacity(value.len());
    let mut changed = false;
    let mut index = 0;
    while index < value.len() {
        let character = value[index..]
            .chars()
            .next()
            .expect("index is on a char boundary");
        if character != '\\' {
            decoded.push(character);
            index += character.len_utf8();
            continue;
        }
        let rest = &value[index + 1..];
        if let Some(newline_len) = css_newline_len(rest) {
            index += 1 + newline_len;
            changed = true;
            continue;
        }
        let hex_len = rest
            .bytes()
            .take(6)
            .take_while(u8::is_ascii_hexdigit)
            .count();
        if hex_len > 0 {
            let code_point = u32::from_str_radix(&rest[..hex_len], 16)
                .ok()
                .and_then(char::from_u32)
                .filter(|code_point| *code_point != '\0')
                .unwrap_or('\u{fffd}');
            decoded.push(code_point);
            let after_hex = &rest[hex_len..];
            let whitespace_len = css_newline_len(after_hex).unwrap_or(usize::from(matches!(
                after_hex.as_bytes().first(),
                Some(b' ' | b'\t')
            )));
            index += 1 + hex_len + whitespace_len;
            changed = true;
            continue;
        }
        match rest.chars().next() {
            Some(escaped) => {
                decoded.push(escaped);
                index += 1 + escaped.len_utf8();
                changed = true;
            }
            None => {
                decoded.push('\\');
                index += 1;
            }
        }
    }
    (decoded, changed)
}

fn decode_html_character_references_once(value: &str) -> (String, bool) {
    let mut decoded = String::with_capacity(value.len());
    let mut remaining = value;
    let mut changed = false;
    while let Some(offset) = remaining.find('&') {
        decoded.push_str(&remaining[..offset]);
        let entity = &remaining[offset..];
        if let Some((character, consumed)) = decode_html_character_reference(&entity[1..]) {
            decoded.push(character);
            remaining = &entity[consumed + 1..];
            changed = true;
            continue;
        }
        decoded.push('&');
        remaining = &entity[1..];
    }
    decoded.push_str(remaining);
    (decoded, changed)
}

fn decode_html_character_reference(entity: &str) -> Option<(char, usize)> {
    if let Some(numeric) = entity.strip_prefix('#') {
        let (digits, radix, prefix_len) = numeric
            .strip_prefix('x')
            .or_else(|| numeric.strip_prefix('X'))
            .map_or((numeric, 10, 1), |digits| (digits, 16, 2));
        let digit_count = digits
            .bytes()
            .take_while(|byte| match radix {
                10 => byte.is_ascii_digit(),
                16 => byte.is_ascii_hexdigit(),
                _ => unreachable!(),
            })
            .count();
        if digit_count == 0 {
            return None;
        }
        let character = u32::from_str_radix(&digits[..digit_count], radix)
            .ok()
            .and_then(char::from_u32)?;
        let numeric_len = prefix_len + digit_count;
        let consumed = numeric_len + usize::from(entity.as_bytes().get(numeric_len) == Some(&b';'));
        return Some((character, consumed));
    }
    // Lowercase a bounded ASCII-safe prefix: entity names are ASCII, and
    // `to_ascii_lowercase` preserves byte offsets, so `;` positions line up.
    let prefix: String = entity
        .chars()
        .take(32)
        .collect::<String>()
        .to_ascii_lowercase();
    if let Some(end) = prefix.find(';').filter(|end| *end <= 31)
        && let Some(character) = decode_named_html_character(&prefix[..end])
    {
        return Some((character, end + 1));
    }
    // HTML also decodes a handful of legacy names without a semicolon.
    let legacy = ["amp", "lt", "gt", "quot", "nbsp"]
        .into_iter()
        .find(|name| prefix.starts_with(name))?;
    Some((decode_named_html_character(legacy)?, legacy.len()))
}

fn decode_named_html_character(name: &str) -> Option<char> {
    let character = match name {
        "amp" => '&',
        "apos" => '\'',
        "ast" => '*',
        "bsol" => '\\',
        "colon" => ':',
        "comma" => ',',
        "commat" => '@',
        "dollar" => '$',
        "equals" => '=',
        "excl" => '!',
        "grave" => '`',
        "gt" => '>',
        "hyphen" | "minus" => '-',
        "lbrack" | "lsqb" => '[',
        "lpar" => '(',
        "lowbar" => '_',
        "lrm" => '\u{200e}',
        "lt" => '<',
        "nbsp" => '\u{a0}',
        "negativemediumspace"
        | "negativethickspace"
        | "negativethinspace"
        | "negativeverythinspace"
        | "zerowidthspace" => '\u{200b}',
        "nobreak" | "wj" => '\u{2060}',
        "num" => '#',
        "percnt" => '%',
        "period" => '.',
        "plus" => '+',
        "quest" => '?',
        "quot" => '"',
        "rbrack" | "rsqb" => ']',
        "rlm" => '\u{200f}',
        "rpar" => ')',
        "semi" => ';',
        "shy" => '\u{ad}',
        "sol" => '/',
        "vert" => '|',
        "zwj" => '\u{200d}',
        "zwnj" => '\u{200c}',
        _ => return None,
    };
    Some(character)
}

fn injective_portable_option_keys<'a>(
    keys: impl IntoIterator<Item = &'a str>,
    redactor: &ProjectPathRedactor,
) -> HashMap<String, String> {
    let mut portable = HashMap::new();
    let mut used = std::collections::HashSet::new();
    for key in keys {
        let base = bounded_portable_option_key(&redactor.text(key), 128);
        let mut candidate = base.clone();
        let mut ordinal = 2;
        while !used.insert(candidate.clone()) {
            candidate = suffixed_portable_option_key(&base, ordinal);
            ordinal += 1;
        }
        portable.insert(key.to_owned(), candidate);
    }
    portable
}

fn suffixed_portable_option_key(base: &str, ordinal: usize) -> String {
    let suffix = format!("~{ordinal}");
    let maximum_base_bytes = 128_usize.saturating_sub(suffix.len());
    format!(
        "{}{}",
        bounded_portable_option_key(base, maximum_base_bytes),
        suffix
    )
}

fn bounded_portable_option_key(base: &str, maximum_bytes: usize) -> String {
    let mut end = base.len().min(maximum_bytes);
    while !base.is_char_boundary(end) {
        end -= 1;
    }
    base[..end].trim_end().to_owned()
}

#[derive(Default)]
struct PortableIds {
    node: HashMap<i64, String>,
    edge: HashMap<i64, String>,
    layer: HashMap<i64, String>,
    action: HashMap<i64, String>,
}

impl PortableIds {
    fn node(&mut self, raw: i64) -> String {
        next_id(&mut self.node, raw, "node")
    }
    fn edge(&mut self, raw: i64) -> String {
        next_id(&mut self.edge, raw, "edge")
    }
    fn layer(&mut self, raw: i64) -> String {
        next_id(&mut self.layer, raw, "layer")
    }
    fn action(&mut self, raw: i64) -> String {
        next_id(&mut self.action, raw, "action")
    }

    fn bind_node(
        &mut self,
        raw: i64,
        portable: String,
    ) -> Result<(), ConversationExportBuildError> {
        bind_id(&mut self.node, raw, portable, "node")
    }

    fn bind_action(
        &mut self,
        raw: i64,
        portable: String,
    ) -> Result<(), ConversationExportBuildError> {
        bind_id(&mut self.action, raw, portable, "action")
    }

    fn bind_layer(
        &mut self,
        raw: i64,
        portable: String,
    ) -> Result<(), ConversationExportBuildError> {
        bind_id(&mut self.layer, raw, portable, "layer")
    }

    fn bind_edge(
        &mut self,
        raw: i64,
        portable: String,
    ) -> Result<(), ConversationExportBuildError> {
        bind_id(&mut self.edge, raw, portable, "edge")
    }
}

fn bind_id(
    ids: &mut HashMap<i64, String>,
    raw: i64,
    portable: String,
    kind: &str,
) -> Result<(), ConversationExportBuildError> {
    if let Some(existing) = ids.get(&raw) {
        if existing == &portable {
            return Ok(());
        }
        return Err(ConversationExportBuildError::Invalid(format!(
            "imported {kind} {raw} has conflicting portable IDs"
        )));
    }
    if ids.values().any(|existing| existing == &portable) {
        return Err(ConversationExportBuildError::Invalid(format!(
            "portable {kind} ID {portable} identifies multiple imported records"
        )));
    }
    ids.insert(raw, portable);
    Ok(())
}

fn next_id(ids: &mut HashMap<i64, String>, raw: i64, kind: &str) -> String {
    if let Some(id) = ids.get(&raw) {
        return id.clone();
    }
    let mut next = ids.len() + 1;
    let id = loop {
        let candidate = format!("{kind}:{next}");
        if !ids.values().any(|existing| existing == &candidate) {
            break candidate;
        }
        next += 1;
    };
    ids.insert(raw, id.clone());
    id
}

#[cfg(test)]
mod tests {
    use super::{
        ContextInput, ImportedExportContext, PortableIds, ProjectPathRedactor, RuntimeContextInput,
        TurnExportContext, completion_status, export_action, export_contexts, export_node,
        export_submitted_inputs, export_turn, portable_interaction_input_bytes,
    };
    use crate::{
        conversation_export::{
            ExportAuthoredDetailOmission, ExportCompletionStatus, ExportTurnOrigin,
        },
        product::{
            ActionInvocation, DurableInteractionInput, Interaction, InteractionContextIntent,
            InteractionContextTarget as ProductInteractionContextTarget, InteractionId,
            SubmittedInputEvidence, ThreadId,
        },
    };
    use relayer_graph_core::{
        ActionId, ActionKind, ActionVariant, GraphAction, GraphNode, InputAction, InputControl,
        InputOption, InteractionContext, InteractionContextAction, InteractionContextTarget,
        InteractionInput, InteractionInputNode, LayerId, NodeId, PresentingInputOccurrence,
        RecordState, SubmittedInputValue,
    };

    #[test]
    fn exports_approval_lifecycle_completion_statuses() {
        assert_eq!(
            completion_status("waiting_for_approval").unwrap(),
            ExportCompletionStatus::WaitingForApproval
        );
        assert_eq!(
            completion_status("stopped").unwrap(),
            ExportCompletionStatus::Stopped
        );
    }

    #[test]
    fn degrades_authored_detail_containing_a_windows_project_path() {
        let project_path = r#"C:\Users\Vishal\"quoted project"#;
        let package = serde_json::json!({
            "version": 1,
            "components": [{
                "id":"summary",
                "order":0,
                "html":format!("<code>{project_path}\\src\\main.rs</code>"),
                "css":format!("/* {project_path} */")
            }],
            "mounts": [],
            "assets": [],
            "integritySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        });
        let node = GraphNode {
            id: NodeId::new(1).unwrap(),
            client_key: Some("private-detail".into()),
            leased_action_id: None,
            kind: "concept".into(),
            icon: "box".into(),
            title: "Private detail".into(),
            detail: "Fallback".into(),
            authored_detail: Some(package.clone()),
            state: RecordState::Accepted,
        };

        let exported = export_node(
            &node,
            &mut PortableIds::default(),
            &ProjectPathRedactor::new(Some(project_path)),
        )
        .unwrap();

        assert!(exported.authored_detail.is_none());
        assert_eq!(exported.detail, "Fallback");
    }

    #[test]
    fn preserves_unrelated_html_entities_in_authored_detail() {
        let package = serde_json::json!({
            "version": 1,
            "components": [{
                "id":"summary",
                "order":0,
                "html":"<pre><code>&lt;tag&gt;&amp;text</code></pre>",
                "css":""
            }],
            "mounts": [],
            "assets": [],
            "integritySha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        });
        let node = GraphNode {
            id: NodeId::new(1).unwrap(),
            client_key: Some("portable-detail".into()),
            leased_action_id: None,
            kind: "concept".into(),
            icon: "box".into(),
            title: "Portable detail".into(),
            detail: "Fallback".into(),
            authored_detail: Some(package.clone()),
            state: RecordState::Accepted,
        };

        for project_path in [None, Some("/private/project")] {
            let exported = export_node(
                &node,
                &mut PortableIds::default(),
                &ProjectPathRedactor::new(project_path),
            )
            .unwrap();

            assert_eq!(exported.authored_detail.as_ref(), Some(&package));
            assert_eq!(exported.authored_detail_omitted, None);
            assert_eq!(exported.detail, "Fallback");
        }
    }

    fn authored_node(package: serde_json::Value) -> GraphNode {
        GraphNode {
            id: NodeId::new(1).unwrap(),
            client_key: Some("encoded-detail".into()),
            leased_action_id: None,
            kind: "concept".into(),
            icon: "box".into(),
            title: "Encoded detail".into(),
            detail: "Portable fallback".into(),
            authored_detail: Some(package),
            state: RecordState::Accepted,
        }
    }

    #[test]
    fn degrades_authored_detail_hidden_behind_sibling_encodings_and_records_the_omission() {
        let project_path = "/Users/x";
        let encodings: [(&str, serde_json::Value); 8] = [
            (
                "uppercase legacy entity",
                serde_json::json!({"html":"<code>&AMP;#47;Users&AMP;#47;x/src</code>","css":""}),
            ),
            (
                "semicolon-less legacy entity",
                serde_json::json!({"html":"<code>&amp#47;Users&amp#47;x/src</code>","css":""}),
            ),
            (
                "css hex escapes",
                serde_json::json!({"html":"<p>Path</p>","css":"p::before{content:\"\\2f Users\\2f x\"}"}),
            ),
            (
                "css escapes split by CRLF",
                serde_json::json!({"html":"<p>Path</p>","css":"p::before{content:\"\\2f\r\nUsers\\2fx\"}"}),
            ),
            (
                "zero-width space inside the path",
                serde_json::json!({"html":"<code>/Users\u{200b}/x</code>","css":""}),
            ),
            (
                "left-to-right mark inside the path",
                serde_json::json!({"html":"<code>/Users\u{200e}/x</code>","css":""}),
            ),
            (
                "invisible named character references",
                serde_json::json!({"html":"<code>/Users&ZeroWidthSpace;/x and /Users&lrm;/x</code>","css":""}),
            ),
            (
                "percent-encoded query parameter",
                serde_json::json!({"html":"<a data-gc-capability=\"open\">Open</a>","css":""}),
            ),
        ];
        for (label, component) in encodings {
            let mut package = serde_json::json!({
                "version": 1,
                "components": [{"id":"summary","order":0,"html":component["html"],"css":component["css"]}],
                "mounts": [],
                "assets": [],
                "integritySha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
            });
            if label.starts_with("percent") {
                package["mounts"] = serde_json::json!([{
                    "id":"open","componentId":"summary","kind":"capability","host":"a",
                    "capability":{"kind":"link","href":"https://e.example/?file=%2FUsers%2Fx%2Fsrc"}
                }]);
            }
            let exported = export_node(
                &authored_node(package),
                &mut PortableIds::default(),
                &ProjectPathRedactor::new(Some(project_path)),
            )
            .unwrap();

            assert!(exported.authored_detail.is_none(), "{label} must degrade");
            assert_eq!(
                exported.authored_detail_omitted,
                Some(ExportAuthoredDetailOmission::PrivatePath),
                "{label} must record the omission"
            );
            assert_eq!(
                exported.detail, "Portable fallback",
                "{label} keeps the fallback"
            );
            let serialized = serde_json::to_string(&exported).unwrap();
            assert!(
                !serialized.contains("Users/x"),
                "{label} must not leak the path"
            );
        }
    }

    #[test]
    fn keeps_encoded_text_that_is_not_a_private_path() {
        let redactor = ProjectPathRedactor::new(Some("/Users/x"));
        for text in [
            "Q&amp;A with &lt;tags&gt; and 100%25 coverage",
            "url(\"data:image/svg+xml,%3Csvg%3E\")",
            "p::before{content:\"\\2014\"}",
            "/Users/y is a different tree",
        ] {
            assert!(!redactor.contains_private_path(text), "{text}");
            assert_eq!(redactor.text(text), text);
        }
    }

    #[test]
    fn markdown_redaction_removes_encoded_private_paths_through_the_shared_matcher() {
        let redactor = ProjectPathRedactor::new(Some("/Users/x"));
        assert_eq!(redactor.text("see /Users/x/src"), "see [project-path]/src");
        // Only the offending tokens change; unrelated encoded text keeps its exact bytes.
        assert_eq!(
            redactor.text("Q&amp;A \\*kept\\* [l](https://e.example/?q=a%20b) see &#47;Users&#47;x&#47;src and %2FUsers%2Fx too"),
            "Q&amp;A \\*kept\\* [l](https://e.example/?q=a%20b) see [project-path] and [project-path] too"
        );
        assert_eq!(redactor.text("/Users\u{200b}/x"), "[project-path]");
        assert_eq!(redactor.text("/Users\u{200e}/x"), "[project-path]");
        // A path that only assembles across tokens collapses the whole value.
        let spaced = ProjectPathRedactor::new(Some("/Users/x/My Project"));
        assert_eq!(
            spaced.text("see %2FUsers%2Fx%2FMy Project now"),
            "[project-path]"
        );
        assert_eq!(
            spaced.text("see %2FUsers%2Fx%2FMy%20Project now"),
            "see [project-path] now"
        );
    }

    #[test]
    fn degrades_authored_detail_without_mutating_its_fallback() {
        let project_path = r#"C:\p"#;
        let package = serde_json::json!({
            "version": 1,
            "components": [
                {"id":project_path,"order":0,"html":"<p>Private</p>","css":""},
                {"id":"[project-path]","order":1,"html":"<p>Portable</p>","css":""}
            ],
            "mounts": [],
            "assets": [],
            "integritySha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        });
        let node = GraphNode {
            id: NodeId::new(1).unwrap(),
            client_key: Some("private-detail".into()),
            leased_action_id: None,
            kind: "concept".into(),
            icon: "box".into(),
            title: "Private detail".into(),
            detail: "Portable fallback".into(),
            authored_detail: Some(package),
            state: RecordState::Accepted,
        };

        let exported = export_node(
            &node,
            &mut PortableIds::default(),
            &ProjectPathRedactor::new(Some(project_path)),
        )
        .unwrap();

        assert!(exported.authored_detail.is_none());
        assert_eq!(exported.detail, "Portable fallback");
    }

    #[test]
    fn degrades_authored_detail_containing_an_html_entity_encoded_project_path() {
        let project_path = "/private/A&B";
        let package = serde_json::json!({
            "version": 1,
            "components": [{
                "id":"summary",
                "order":0,
                "html":"<code>/private/A&amp;B/src/main.rs</code>",
                "css":""
            }],
            "mounts": [],
            "assets": [],
            "integritySha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
        });
        let node = GraphNode {
            id: NodeId::new(1).unwrap(),
            client_key: Some("private-detail".into()),
            leased_action_id: None,
            kind: "concept".into(),
            icon: "box".into(),
            title: "Private detail".into(),
            detail: "Portable fallback".into(),
            authored_detail: Some(package),
            state: RecordState::Accepted,
        };

        let exported = export_node(
            &node,
            &mut PortableIds::default(),
            &ProjectPathRedactor::new(Some(project_path)),
        )
        .unwrap();

        assert!(exported.authored_detail.is_none());
        assert_eq!(exported.detail, "Portable fallback");
        assert!(
            !serde_json::to_string(&exported)
                .unwrap()
                .contains("/private/A&amp;B")
        );
    }

    #[test]
    fn degrades_nested_numeric_and_named_html_character_references() {
        for (project_path, html) in [
            (
                "/private/A&B",
                "&lt;code&gt;&amp;#47;private&amp;#47;A&amp;amp;B/src/main.rs&lt;/code&gt;",
            ),
            (
                "/private/A&B",
                "<code>&sol;private&sol;A&amp;B/src/main.rs</code>",
            ),
            (
                "/private/A&B",
                "<code>&#x2f;private&#47;A&amp;B/src/main.rs</code>",
            ),
            (
                "/private/A&B",
                "<code>&amp;#47private&amp;#47A&amp;B/src/main.rs</code>",
            ),
            (
                r"C:\workspace",
                r"<code>C&#58&#92workspace\src\main.rs</code>",
            ),
        ] {
            let node = GraphNode {
                id: NodeId::new(1).unwrap(),
                client_key: Some("private-detail".into()),
                leased_action_id: None,
                kind: "concept".into(),
                icon: "box".into(),
                title: "Private detail".into(),
                detail: "Portable fallback".into(),
                authored_detail: Some(serde_json::json!({
                    "version": 1,
                    "components": [{"id":"summary","order":0,"html":html,"css":""}],
                    "mounts": [],
                    "assets": [],
                    "integritySha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
                })),
                state: RecordState::Accepted,
            };

            let exported = export_node(
                &node,
                &mut PortableIds::default(),
                &ProjectPathRedactor::new(Some(project_path)),
            )
            .unwrap();

            assert!(
                exported.authored_detail.is_none(),
                "retained encoded HTML: {html}"
            );
            assert_eq!(exported.detail, "Portable fallback");
        }
    }

    #[test]
    fn exports_native_submitted_input_with_redacted_snapshot_and_portable_provenance() {
        let interaction = Interaction {
            id: InteractionId::from_database(7),
            thread_id: ThreadId::from_database(1),
            sequence: 2,
            text: "".into(),
            created_at: "2".into(),
            graph_node_id: None,
            completion_status: "failed".into(),
            harness_configuration_name: None,
            harness_configuration_digest: None,
            permission_profile_id: "auto".into(),
            model_selection: None,
            effective_execution_digest: None,
            effective_permission_receipt: None,
            completion_output: None,
            completion_error: Some("failed".into()),
            latest_attempt: None,
        };
        let evidence = vec![SubmittedInputEvidence {
            occurrence: PresentingInputOccurrence {
                presenting_interaction_node_id: NodeId::new(10).unwrap(),
                presenting_layer_id: LayerId::new(30).unwrap(),
                action_id: ActionId::new(40).unwrap(),
            },
            source_node_id: 20,
            action: InputAction {
                control: InputControl::SingleSelect,
                prompt: "Choose /private/tmp/project/file".into(),
                options: vec![
                    InputOption {
                        key: "/tmp/project/target".into(),
                        label: "From /tmp/project".into(),
                        unsupported_fields: Default::default(),
                    },
                    InputOption {
                        key: "/private/tmp/project/target".into(),
                        label: "From /private/tmp/project".into(),
                        unsupported_fields: Default::default(),
                    },
                ],
                minimum_selections: None,
                unsupported_fields: Default::default(),
            },
            value: SubmittedInputValue::Selected {
                selected: vec![
                    InputOption {
                        key: "/private/tmp/project/target".into(),
                        label: "From /private/tmp/project".into(),
                        unsupported_fields: Default::default(),
                    },
                    InputOption {
                        key: "/tmp/project/target".into(),
                        label: "From /tmp/project".into(),
                        unsupported_fields: Default::default(),
                    },
                ],
            },
            attempt_state: "failed".into(),
        }];
        let mut ids = PortableIds::default();
        let exported = export_submitted_inputs(
            &interaction,
            &evidence,
            None,
            &mut ids,
            &ProjectPathRedactor::new(Some("/private/tmp/project")),
        )
        .unwrap();
        assert_eq!(exported[0].root_turn_id, "turn:2");
        assert_eq!(exported[0].source.interaction_node_id, "node:1");
        assert_eq!(exported[0].source.node_id, "node:2");
        assert_eq!(exported[0].source.layer_id, "layer:1");
        assert_eq!(exported[0].source.action_id, "action:1");
        assert_eq!(exported[0].action.prompt, "Choose [project-path]/file");
        assert_eq!(exported[0].action.options[0].key, "[project-path]/target");
        assert_eq!(exported[0].action.options[1].key, "[project-path]/target~2");
        assert_eq!(
            serde_json::to_value(&exported).unwrap()[0]["value"]["selected"],
            serde_json::json!([
                {"key":"[project-path]/target","label":"From [project-path]"},
                {"key":"[project-path]/target~2","label":"From [project-path]"}
            ])
        );
        let json = serde_json::to_string(&exported).unwrap();
        assert!(!json.contains("private/tmp/project"));
        assert!(!json.contains("/tmp/project"));
        assert!(!json.contains("authority"));
        assert!(!json.contains("digest"));

        let mut raw_ids = PortableIds::default();
        let raw_imported = export_submitted_inputs(
            &interaction,
            &evidence,
            None,
            &mut raw_ids,
            &ProjectPathRedactor::new(None),
        )
        .unwrap();
        let reexported = export_submitted_inputs(
            &interaction,
            &[],
            Some(&raw_imported),
            &mut PortableIds::default(),
            &ProjectPathRedactor::new(Some("/private/tmp/project")),
        )
        .unwrap();
        assert_eq!(reexported[0].action.options[0].key, "[project-path]/target");
        assert_eq!(
            reexported[0].action.options[1].key,
            "[project-path]/target~2"
        );
        assert_eq!(
            serde_json::to_value(&reexported).unwrap()[0]["value"]["selected"],
            serde_json::json!([
                {"key":"[project-path]/target","label":"From [project-path]"},
                {"key":"[project-path]/target~2","label":"From [project-path]"}
            ])
        );
    }

    #[test]
    fn native_submitted_inputs_sort_by_materialized_portable_identity() {
        let interaction = Interaction {
            id: InteractionId::from_database(7),
            thread_id: ThreadId::from_database(1),
            sequence: 2,
            text: "".into(),
            created_at: "2".into(),
            graph_node_id: None,
            completion_status: "failed".into(),
            harness_configuration_name: None,
            harness_configuration_digest: None,
            permission_profile_id: "auto".into(),
            model_selection: None,
            effective_execution_digest: None,
            effective_permission_receipt: None,
            completion_output: None,
            completion_error: Some("failed".into()),
            latest_attempt: None,
        };
        let evidence = [
            (40, "second portable action"),
            (41, "tenth portable action"),
        ]
        .into_iter()
        .map(|(action_id, text)| SubmittedInputEvidence {
            occurrence: PresentingInputOccurrence {
                presenting_interaction_node_id: NodeId::new(10).unwrap(),
                presenting_layer_id: LayerId::new(30).unwrap(),
                action_id: ActionId::new(action_id).unwrap(),
            },
            source_node_id: 20,
            action: InputAction {
                control: InputControl::Text,
                prompt: "Explain".into(),
                options: vec![],
                minimum_selections: None,
                unsupported_fields: Default::default(),
            },
            value: SubmittedInputValue::Text { text: text.into() },
            attempt_state: "failed".into(),
        })
        .collect::<Vec<_>>();
        let mut ids = PortableIds::default();
        ids.bind_action(40, "action:2".into()).unwrap();
        ids.bind_action(41, "action:10".into()).unwrap();

        let exported = export_submitted_inputs(
            &interaction,
            &evidence,
            None,
            &mut ids,
            &ProjectPathRedactor::new(None),
        )
        .unwrap();

        assert_eq!(
            exported
                .iter()
                .map(|input| input.source.action_id.as_str())
                .collect::<Vec<_>>(),
            ["action:10", "action:2"]
        );
    }

    #[test]
    fn exports_context_diagnostics_with_ordered_annotations_and_authority_free_ids() {
        let interaction = Interaction {
            id: InteractionId::from_database(7),
            thread_id: ThreadId::from_database(1),
            sequence: 1,
            text: "Use context".into(),
            created_at: "1".into(),
            graph_node_id: Some(10),
            completion_status: "failed".into(),
            harness_configuration_name: None,
            harness_configuration_digest: None,
            permission_profile_id: "auto".into(),
            model_selection: None,
            effective_execution_digest: None,
            effective_permission_receipt: None,
            completion_output: None,
            completion_error: Some("failed".into()),
            latest_attempt: None,
        };
        let target_node = GraphNode {
            id: NodeId::new(20).unwrap(),
            client_key: Some("target".into()),
            kind: "concept".into(),
            icon: "file".into(),
            title: "Target".into(),
            detail: "Immutable".into(),
            authored_detail: Some(serde_json::json!({
                "version": 1,
                "components": [{
                    "id":"summary",
                    "order":0,
                    "html":"<code>/workspace/project/private.txt</code>",
                    "css":""
                }],
                "mounts": [],
                "assets": [],
                "integritySha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
            })),
            state: RecordState::Accepted,
            leased_action_id: None,
        };
        let target = InteractionInputNode::from(target_node.clone());
        let runtime = RuntimeContextInput {
            input: InteractionInput {
                interaction: InteractionInputNode::from(GraphNode {
                    id: NodeId::new(10).unwrap(),
                    client_key: None,
                    kind: "user-interaction".into(),
                    icon: "user".into(),
                    title: "Use context".into(),
                    detail: "Use context".into(),
                    authored_detail: None,
                    state: RecordState::Accepted,
                    leased_action_id: None,
                }),
                contexts: vec![InteractionContext {
                    type_id: "interaction.context".into(),
                    target_node: target.clone(),
                    annotations: vec!["Inspect /workspace/project/src".into(), "Second".into()],
                }],
                submitted_inputs: vec![],
            },
            actions: vec![InteractionContextAction {
                id: ActionId::new(30).unwrap(),
                type_id: "interaction.context".into(),
                source_node_id: NodeId::new(10).unwrap(),
                target: InteractionContextTarget {
                    node_id: target.id,
                    source_interaction_node_id: NodeId::new(40).unwrap(),
                    source_layer_id: LayerId::new(50).unwrap(),
                },
                annotations: vec!["Inspect /workspace/project/src".into(), "Second".into()],
                state: RecordState::Accepted,
            }],
        };

        let long_action_id = format!("action:{}", "a".repeat(121));
        let long_target_id = format!("node:{}", "t".repeat(123));
        let long_source_id = format!("node:{}", "s".repeat(123));
        let long_layer_id = format!("layer:{}", "l".repeat(122));
        let mut ids = PortableIds::default();
        ids.bind_action(30, long_action_id.clone()).unwrap();
        ids.bind_node(20, long_target_id.clone()).unwrap();
        ids.bind_node(40, long_source_id.clone()).unwrap();
        ids.bind_layer(50, long_layer_id.clone()).unwrap();
        let exported = export_contexts(
            &interaction,
            Some(&ContextInput::Runtime(runtime)),
            None,
            &mut ids,
            &ProjectPathRedactor::new(Some("/workspace/project")),
        )
        .unwrap();
        assert_eq!(exported[0].id, long_action_id);
        assert_eq!(exported[0].target.id, long_target_id);
        assert_eq!(exported[0].source.interaction_node_id, long_source_id);
        assert_eq!(exported[0].source.layer_id, long_layer_id);
        assert_eq!(
            exported[0].annotations,
            ["Inspect [project-path]/src", "Second"]
        );
        let exported_target = export_node(
            &target_node,
            &mut ids,
            &ProjectPathRedactor::new(Some("/workspace/project")),
        )
        .unwrap();
        assert!(exported_target.authored_detail.is_none());
        assert_eq!(exported_target.detail, exported[0].target.detail);
        assert_eq!(exported_target.id, exported[0].target.id);
        assert_eq!(exported_target.kind, exported[0].target.kind);
        assert_eq!(exported_target.icon, exported[0].target.icon);
        assert_eq!(exported_target.title, exported[0].target.title);
        let intent = InteractionContextIntent {
            target: ProductInteractionContextTarget {
                node_id: 20,
                source_interaction_node_id: 40,
                source_layer_id: 50,
            },
            annotations: vec!["Inspect /workspace/project/src".into(), "Second".into()],
        };
        let estimated = portable_interaction_input_bytes(
            Some("/workspace/project"),
            "",
            &[intent],
            &[],
            &[target],
        )
        .unwrap();
        let actual = serde_json::to_vec(&(
            &"",
            &exported,
            &Vec::<relayer_graph_core::SubmittedInputDraft>::new(),
        ))
        .unwrap()
        .len()
        .saturating_add(1_024);
        assert!(estimated >= actual, "{estimated} < {actual}");
    }

    #[test]
    fn rejects_unbound_durable_contexts_until_graph_authority_is_bound() {
        let interaction = Interaction {
            id: InteractionId::from_database(8),
            thread_id: ThreadId::from_database(1),
            sequence: 2,
            text: "Preserved draft".into(),
            created_at: "2".into(),
            graph_node_id: None,
            completion_status: "submitted".into(),
            harness_configuration_name: None,
            harness_configuration_digest: None,
            permission_profile_id: "auto".into(),
            model_selection: None,
            effective_execution_digest: None,
            effective_permission_receipt: None,
            completion_output: None,
            completion_error: None,
            latest_attempt: None,
        };
        // Unbound durable intent has not passed graph core's accepted-reachability and scope
        // checks. Reject all such targets, including cross-project, unreachable, or nonaccepted
        // occurrences, rather than trying to infer authority from caller-supplied IDs.
        let durable = ContextInput::Durable(DurableInteractionInput {
            input_identity: "send-unbound".into(),
            input_digest: "sha256:unbound".into(),
            contexts: vec![InteractionContextIntent {
                target: ProductInteractionContextTarget {
                    node_id: 20,
                    source_interaction_node_id: 40,
                    source_layer_id: 50,
                },
                annotations: vec!["Compare /workspace/project/private.txt".into()],
            }],
            submitted_inputs: vec![],
            submitted_input_draft_revision: None,
            semantic_digest: None,
        });

        let error = export_contexts(
            &interaction,
            Some(&durable),
            None,
            &mut PortableIds::default(),
            &ProjectPathRedactor::new(Some("/workspace/project")),
        )
        .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("graph authority is not yet bound")
        );
        assert!(
            error
                .to_string()
                .contains("retry export after interaction recovery")
        );
    }

    #[test]
    fn resolved_invoke_exports_its_authored_shape() {
        let action = GraphAction {
            id: ActionId::new(1).unwrap(),
            client_key: Some("continue".into()),
            source_node_id: NodeId::new(2).unwrap(),
            source_layer_id: Some(LayerId::new(3).unwrap()),
            source_layer_client_key: Some("source".into()),
            kind: ActionKind::Invoke,
            relation: None,
            label: "Continue".into(),
            variant: ActionVariant::Pill,
            icon: None,
            description: None,
            target_layer_id: Some(LayerId::new(4).unwrap()),
            interaction_text: Some("Continue from here".into()),
            input: None,
            state: RecordState::Accepted,
        };

        let exported = export_action(
            &action,
            &mut PortableIds::default(),
            &ProjectPathRedactor::new(None),
        )
        .unwrap();

        assert!(exported.target_layer_id.is_none());
        assert_eq!(
            exported.interaction_text.as_deref(),
            Some("Continue from here")
        );
    }

    #[test]
    fn unanswered_input_action_exports_its_authored_payload() {
        let action = GraphAction {
            id: ActionId::new(1).unwrap(),
            client_key: Some("choose".into()),
            source_node_id: NodeId::new(2).unwrap(),
            source_layer_id: Some(LayerId::new(3).unwrap()),
            source_layer_client_key: Some("source".into()),
            kind: ActionKind::Input,
            relation: None,
            label: "Choose".into(),
            variant: ActionVariant::Pill,
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: None,
            input: Some(InputAction {
                control: InputControl::SingleSelect,
                prompt: "Choose /private/tmp/project/target".into(),
                options: vec![
                    InputOption {
                        key: "/private/tmp/project/target".into(),
                        label: "Use /private/tmp/project target".into(),
                        unsupported_fields: Default::default(),
                    },
                    InputOption {
                        key: "/tmp/project/target".into(),
                        label: "Use /tmp/project target".into(),
                        unsupported_fields: Default::default(),
                    },
                ],
                minimum_selections: None,
                unsupported_fields: Default::default(),
            }),
            state: RecordState::Accepted,
        };

        let exported = export_action(
            &action,
            &mut PortableIds::default(),
            &ProjectPathRedactor::new(Some("/private/tmp/project")),
        )
        .unwrap();

        let input = exported.input.unwrap();
        assert_eq!(
            input.control,
            crate::conversation_export::ExportInputControl::SingleSelect
        );
        assert_eq!(input.prompt, "Choose [project-path]/target");
        assert_eq!(input.options[0].key, "[project-path]/target");
        assert_eq!(input.options[1].key, "[project-path]/target~2");
        assert_eq!(input.options[0].label, "Use [project-path] target");
        assert_eq!(input.options[1].label, "Use [project-path] target");
    }

    #[test]
    fn expanding_path_redaction_keeps_option_keys_within_the_portable_limit() {
        let authored_key = format!("/a{}", "x".repeat(126));
        let authored_key_with_internal_space = format!("/a{} {}", "x".repeat(113), "y".repeat(12));
        assert_eq!(authored_key.len(), 128);
        assert_eq!(authored_key_with_internal_space.len(), 128);
        let action = GraphAction {
            id: ActionId::new(1).unwrap(),
            client_key: Some("choose".into()),
            source_node_id: NodeId::new(2).unwrap(),
            source_layer_id: Some(LayerId::new(3).unwrap()),
            source_layer_client_key: Some("source".into()),
            kind: ActionKind::Input,
            relation: None,
            label: "Choose".into(),
            variant: ActionVariant::Pill,
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: None,
            input: Some(InputAction {
                control: InputControl::SingleSelect,
                prompt: "Choose".into(),
                options: vec![
                    InputOption {
                        key: authored_key,
                        label: "Expanded path".into(),
                        unsupported_fields: Default::default(),
                    },
                    InputOption {
                        key: authored_key_with_internal_space,
                        label: "Expanded path with internal space".into(),
                        unsupported_fields: Default::default(),
                    },
                ],
                minimum_selections: None,
                unsupported_fields: Default::default(),
            }),
            state: RecordState::Accepted,
        };

        let exported = export_action(
            &action,
            &mut PortableIds::default(),
            &ProjectPathRedactor::new(Some("/a")),
        )
        .unwrap();
        let input = exported.input.unwrap();
        let option_key = &input.options[0].key;
        let option_key_with_exposed_space = &input.options[1].key;

        assert_eq!(option_key.len(), 128);
        assert!(option_key.starts_with("[project-path]"));
        assert_eq!(option_key_with_exposed_space.len(), 127);
        assert_eq!(
            option_key_with_exposed_space.trim(),
            option_key_with_exposed_space
        );
    }

    #[test]
    fn historical_mapping_exports_its_action_origin() {
        let source_id = InteractionId::from_database(1);
        let result_id = InteractionId::from_database(2);
        let interaction = Interaction {
            id: result_id,
            thread_id: ThreadId::from_database(1),
            sequence: 2,
            text: "Historical result".into(),
            created_at: "2".into(),
            graph_node_id: None,
            completion_status: "failed".into(),
            harness_configuration_name: None,
            harness_configuration_digest: None,
            permission_profile_id: "auto".into(),
            model_selection: None,
            effective_execution_digest: None,
            effective_permission_receipt: None,
            completion_output: None,
            completion_error: Some("superseded".into()),
            latest_attempt: None,
        };
        let invocation = ActionInvocation {
            source_interaction_id: source_id,
            action_id: 41,
            result_interaction_id: result_id,
            created_at: "2".into(),
            result_completion_status: "failed".into(),
        };
        let turn_sequences = [(source_id, 1), (result_id, 2)].into_iter().collect();
        let mut ids = PortableIds::default();
        ids.action.insert(41, "action:legacy".into());

        let exported = export_turn(
            &interaction,
            TurnExportContext {
                closure: None,
                context_input: None,
                submitted_evidence: &[],
                invocation: Some(&invocation),
                imported: ImportedExportContext {
                    turn: None,
                    turn_sequences: &Default::default(),
                },
                turn_sequences: &turn_sequences,
                redactor: &ProjectPathRedactor::new(None),
            },
            &mut ids,
        )
        .unwrap();

        assert_eq!(
            exported.origin,
            ExportTurnOrigin::Action {
                source_turn_id: "turn:1".into(),
                source_action_id: "action:legacy".into(),
            }
        );
    }
}
