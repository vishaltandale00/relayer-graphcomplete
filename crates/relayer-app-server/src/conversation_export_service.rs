mod share_bindings;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::OnceLock;

use regex::Regex;

use relayer_graph_core::{
    AcceptedGraphClosure, ActionKind, ActionVariant, GraphAction, GraphEdge, GraphNode,
    InteractionContextAction, InteractionInput, NavigateRelation, RecordState, ResolvedLayer,
};

use crate::{
    conversation_export::{
        ConversationExportHeader, ConversationExportRecord, ConversationExportTurn,
        EXPORT_VERSION_V1, EXPORT_VERSION_V2, EXPORT_VERSION_V3, ExportAcceptedView, ExportAction,
        ExportActionKind, ExportActionVariant, ExportAdmittedExecutionModelPlan,
        ExportAdmittedExecutionModelRoute, ExportAttemptOutcome, ExportAuthoredDetailOmission,
        ExportCompletionReceipt, ExportCompletionStatus, ExportContextSource,
        ExportContextTargetSnapshot, ExportConversation, ExportEdge, ExportEdgeEnd,
        ExportEdgeRoute, ExportInputActionSnapshot, ExportInputControl, ExportInputOption,
        ExportInputSource, ExportInteractionContext, ExportLayer, ExportLayerLayout,
        ExportModelSelection, ExportNavigateRelation, ExportNode, ExportNodePlacement,
        ExportPermissionReceipt, ExportProducer, ExportRecordState, ExportResolvedLayer,
        ExportSubmittedInput, ExportSubmittedInputValue, ExportTurnManifestEntry, ExportTurnOrigin,
        ExportVisualAssetAssociation, ExportVisualAssetContent, ExportVisualAssetProvenance,
        MAX_EXPORT_BYTES, MAX_JSONL_LINE_BYTES, MAX_SHARE_SNAPSHOT_BYTES, validate_export_records,
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
    #[error("share export is unavailable for imported conversations")]
    ShareImportedConversation,
    #[error("share export requires at least one accepted completion")]
    ShareNoAcceptedCompletion,
    #[error("share title is required")]
    ShareTitleRequired,
    #[error("share title exceeds 120 characters")]
    ShareTitleTooLong,
    #[error("share snapshot exceeds the {MAX_SHARE_SNAPSHOT_BYTES}-byte transport limit")]
    ShareSnapshotTooLarge { bytes: usize },
}

fn is_converted_invoke(action: &GraphAction) -> bool {
    action.resolved_invoke_interaction_id.is_some() || action.converted_from_invoke
}

fn needs_current_snapshot(closure: &AcceptedGraphClosure) -> bool {
    closure.has_persistent_mutations
        || std::iter::once(&closure.root_action)
            .chain(closure.layers.iter().flat_map(|layer| &layer.actions))
            .any(is_converted_invoke)
        || closure
            .layers
            .iter()
            .flat_map(|layer| &layer.actions)
            .any(|action| action.kind == ActionKind::Navigate && action.source_layer_id.is_none())
}

// All accepted roots share one graph read transaction. No per-root fallback may
// mix presentations from different accepted revisions of a persistent node.
async fn snapshot_closures(
    runtime: &RuntimeClient,
    interactions: &[&Interaction],
) -> Result<Vec<Option<AcceptedGraphClosure>>, ConversationExportBuildError> {
    let root_ids = interactions
        .iter()
        .filter(|i| i.completion_status == "accepted")
        .map(|i| {
            i.graph_node_id.ok_or_else(|| {
                ConversationExportBuildError::Invalid(format!(
                    "accepted interaction {} has no graph node",
                    i.id
                ))
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    if root_ids.is_empty() {
        return Ok(vec![None; interactions.len()]);
    }
    let closures = runtime.accepted_graph_closures(&root_ids).await?;
    if closures.len() != root_ids.len() {
        return Err(ConversationExportBuildError::Invalid(
            "accepted snapshot root count mismatch".into(),
        ));
    }
    for (id, closure) in root_ids.iter().zip(&closures) {
        if closure.as_ref().map(|c| c.node_id.value()) != Some(*id) {
            return Err(ConversationExportBuildError::Invalid(
                "accepted snapshot root identity mismatch".into(),
            ));
        }
    }
    let mut accepted = closures.into_iter();
    Ok(interactions
        .iter()
        .map(|i| {
            if i.completion_status == "accepted" {
                accepted.next().expect("validated accepted snapshot count")
            } else {
                None
            }
        })
        .collect())
}

fn invocation_matches_snapshot(
    action: &GraphAction,
    result: &Interaction,
    closure: Option<&AcceptedGraphClosure>,
) -> bool {
    if is_converted_invoke(action) {
        action.kind == ActionKind::Navigate
            && action.relation == Some(NavigateRelation::Expand)
            && action.interaction_text.is_none()
            && closure.is_some_and(|c| {
                action.target_layer_id == Some(c.root_layer_id)
                    && (action.converted_from_invoke
                        || action.resolved_invoke_interaction_id.map(|id| id.value())
                            == result.graph_node_id)
            })
    } else {
        action.kind == ActionKind::Invoke
            && action.interaction_text.as_deref() == Some(result.text.as_str())
    }
}

// A presentation may change after the coherent graph read. Discard all partial
// output and retry the entire capture, never just the last asset or one root.
async fn capture_snapshot_with_retry<T, F, Fut>(
    mut capture: F,
) -> Result<T, ConversationExportBuildError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, ConversationExportBuildError>>,
{
    for attempt in 0..3 {
        let result = capture().await;
        if attempt < 2
            && matches!(&result, Err(ConversationExportBuildError::Runtime(RuntimeError::Remote { body, .. }))
            if body.pointer("/error/code").and_then(serde_json::Value::as_str) == Some("asset_snapshot_changed"))
        {
            continue;
        }
        return result;
    }
    unreachable!("bounded snapshot attempts return")
}

pub(crate) async fn build_conversation_export(
    product: &ProductService,
    runtime: &RuntimeClient,
    thread_id: ThreadId,
    producer: ExportProducer,
    exported_at: String,
) -> Result<Vec<u8>, ConversationExportBuildError> {
    capture_snapshot_with_retry(|| {
        build_conversation_export_once(
            product,
            runtime,
            thread_id,
            producer.clone(),
            exported_at.clone(),
        )
    })
    .await
}

async fn build_conversation_export_once(
    product: &ProductService,
    runtime: &RuntimeClient,
    thread_id: ThreadId,
    producer: ExportProducer,
    exported_at: String,
) -> Result<Vec<u8>, ConversationExportBuildError> {
    let detail = product.get_thread(thread_id).await?;
    let export_invocations = product.action_invocations_for_export(thread_id).await?;
    let imported_turns = product.imported_turn_export_records(thread_id).await?;
    // Import provenance survives even when this closure has no conversion or
    // layerless action: V3 can also carry completion-scoped repeated keys.
    let imported_current_snapshot = imported_turns
        .iter()
        .any(|turn| turn.export_version == EXPORT_VERSION_V3);
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
    let closures =
        snapshot_closures(runtime, &detail.interactions.iter().collect::<Vec<_>>()).await?;
    let mut context_inputs = Vec::with_capacity(detail.interactions.len());
    let mut submitted_evidence = Vec::with_capacity(detail.interactions.len());
    let mut settled_attempt_outcomes = Vec::with_capacity(detail.interactions.len());
    for interaction in &detail.interactions {
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
        settled_attempt_outcomes.push(settled_attempt_outcome(product, interaction).await?);
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
        if !invocation_matches_snapshot(
            action,
            &detail.interactions[result_index],
            closures[result_index].as_ref(),
        ) {
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
    // Decide the complete V3 policy before assets are collected. Ownership-only
    // V3 must fail closed on missing assets just like mutation-based V3.
    let context_owners = collect_context_owners(
        runtime,
        detail
            .interactions
            .iter()
            .zip(closures.iter())
            .filter_map(|(interaction, closure)| {
                closure.as_ref().map(|closure| (interaction, closure))
            })
            .collect(),
        detail
            .interactions
            .iter()
            .zip(context_inputs.iter())
            .filter(|(interaction, _)| !imported_turns.contains_key(&interaction.id))
            .filter_map(|(interaction, context)| {
                context.as_ref().map(|context| (interaction, context))
            })
            .collect(),
        &turn_sequences,
    )
    .await?;
    let current_snapshot = imported_current_snapshot
        || !context_owners.is_empty()
        || closures.iter().flatten().any(needs_current_snapshot);
    let context_icon_nodes = context_image_nodes(context_inputs.iter().flatten());
    let (authored_detail_assets, visual_asset_contents) = collect_visual_assets_with_context_icons(
        runtime,
        closures.iter().flatten(),
        &redactor,
        current_snapshot,
        &context_icon_nodes,
    )
    .await?;
    let header = ConversationExportRecord::Header(Box::new(ConversationExportHeader {
        export_version: if current_snapshot {
            EXPORT_VERSION_V3
        } else if visual_asset_contents.is_empty() {
            EXPORT_VERSION_V1
        } else {
            EXPORT_VERSION_V2
        },
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
        visual_asset_contents: Vec::new(),
    }));
    let mut records = vec![header];
    records.extend(
        visual_asset_contents
            .into_iter()
            .map(|content| ConversationExportRecord::VisualAssetContent(Box::new(content))),
    );
    for ((((interaction, closure), context_input), submitted_evidence), settled_attempt_outcome) in
        detail
            .interactions
            .iter()
            .zip(closures.iter())
            .zip(context_inputs.iter())
            .zip(submitted_evidence.iter())
            .zip(settled_attempt_outcomes.iter().copied())
    {
        records.push(ConversationExportRecord::Turn(Box::new(export_turn(
            interaction,
            TurnExportContext {
                portable_sequence: interaction.sequence,
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
                settled_attempt_outcome,
                authored_detail_assets: &authored_detail_assets,
            },
            &mut ids,
        )?)));
    }
    enrich_context_owners(&mut records, &context_owners, &ids);
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

/// Build the frozen public-share snapshot. This is intentionally a separate
/// boundary from the ordinary desktop export: only accepted interactions are
/// selected, public metadata exceptions are applied at the header, and the
/// completion receipt is reduced before bytes are serialized.
pub(crate) async fn build_share_conversation_export(
    product: &ProductService,
    runtime: &RuntimeClient,
    thread_id: ThreadId,
    producer: ExportProducer,
    exported_at: String,
    share_title: &str,
) -> Result<Vec<u8>, ConversationExportBuildError> {
    capture_snapshot_with_retry(|| {
        build_share_conversation_export_once(
            product,
            runtime,
            thread_id,
            producer.clone(),
            exported_at.clone(),
            share_title,
        )
    })
    .await
}

async fn build_share_conversation_export_once(
    product: &ProductService,
    runtime: &RuntimeClient,
    thread_id: ThreadId,
    producer: ExportProducer,
    exported_at: String,
    share_title: &str,
) -> Result<Vec<u8>, ConversationExportBuildError> {
    if share_title.trim().is_empty() {
        return Err(ConversationExportBuildError::ShareTitleRequired);
    }
    if share_title.chars().count() > 120 {
        return Err(ConversationExportBuildError::ShareTitleTooLong);
    }

    let detail = product.get_thread(thread_id).await?;
    if detail.thread.imported {
        return Err(ConversationExportBuildError::ShareImportedConversation);
    }
    let export_invocations = product.action_invocations_for_export(thread_id).await?;
    let selected = share_accepted_interactions(&detail.interactions, &export_invocations);
    if selected.is_empty() {
        return Err(ConversationExportBuildError::ShareNoAcceptedCompletion);
    }

    let project_path = detail.project.as_ref().map(|project| project.path.as_str());
    let redactor = ProjectPathRedactor::for_share(project_path);
    let selected_indexes = selected
        .iter()
        .enumerate()
        .map(|(index, interaction)| (interaction.id, index))
        .collect::<HashMap<_, _>>();
    let conversation_invocations = export_invocations
        .iter()
        .filter(|invocation| {
            selected_indexes.contains_key(&invocation.source_interaction_id)
                && selected_indexes.contains_key(&invocation.result_interaction_id)
        })
        .collect::<Vec<_>>();
    let invocations = conversation_invocations
        .iter()
        .copied()
        .map(|invocation| (invocation.result_interaction_id, invocation))
        .collect::<HashMap<_, _>>();
    let turn_sequences = selected
        .iter()
        .enumerate()
        .map(|(index, interaction)| (interaction.id, (index + 1) as i64))
        .collect::<HashMap<_, _>>();
    let imported_turn_sequences: HashMap<&str, i64> = HashMap::new();
    let imported_turns: HashMap<InteractionId, &crate::storage::ImportedTurnExportRecord> =
        HashMap::new();

    let mut ids = PortableIds::default();
    let mut closures = snapshot_closures(runtime, &selected)
        .await?
        .into_iter()
        .map(|closure| closure.expect("selected accepted snapshot"))
        .collect::<Vec<_>>();
    let mut context_inputs = Vec::with_capacity(selected.len());
    let mut submitted_evidence = Vec::with_capacity(selected.len());
    let mut settled_attempt_outcomes = Vec::with_capacity(selected.len());
    for interaction in &selected {
        let node_id = interaction.graph_node_id.ok_or_else(|| {
            ConversationExportBuildError::Invalid(format!(
                "accepted interaction {} has no graph node",
                interaction.id
            ))
        })?;
        let durable_input = product.interaction_input(interaction.id).await?;
        context_inputs.push(ContextInput::Runtime(RuntimeContextInput {
            input: runtime.interaction_input(node_id).await?,
            actions: runtime.interaction_context_actions(node_id).await?,
        }));
        // Keep this call in the same frozen builder pass as graph/context reads;
        // submitted-input evidence is part of the accepted turn snapshot.
        let _ = durable_input;
        submitted_evidence.push(product.submitted_input_evidence(interaction.id).await?);
        settled_attempt_outcomes.push(settled_attempt_outcome(product, interaction).await?);
    }

    for invocation in conversation_invocations {
        let source_index = *selected_indexes
            .get(&invocation.source_interaction_id)
            .ok_or_else(|| {
                ConversationExportBuildError::Invalid(format!(
                    "action invocation source interaction {} is outside the accepted snapshot",
                    invocation.source_interaction_id
                ))
            })?;
        let result_index = *selected_indexes
            .get(&invocation.result_interaction_id)
            .ok_or_else(|| {
                ConversationExportBuildError::Invalid(format!(
                    "action invocation result interaction {} is outside the accepted snapshot",
                    invocation.result_interaction_id
                ))
            })?;
        if source_index >= result_index {
            return Err(ConversationExportBuildError::Invalid(
                "action invocation does not point from an earlier accepted turn to a later accepted turn"
                    .into(),
            ));
        }
        let action = closures[source_index]
            .layers
            .iter()
            .flat_map(|layer| &layer.actions)
            .find(|action| action.id.value() == invocation.action_id)
            .ok_or_else(|| {
                ConversationExportBuildError::Invalid(format!(
                    "action invocation references action {} outside the source accepted view",
                    invocation.action_id
                ))
            })?;
        if !invocation_matches_snapshot(
            action,
            selected[result_index],
            Some(&closures[result_index]),
        ) {
            return Err(ConversationExportBuildError::Invalid(format!(
                "action invocation {} does not match its accepted invoke action",
                invocation.action_id
            )));
        }
    }

    let turns = selected
        .iter()
        .enumerate()
        .map(|(index, _)| {
            let portable_sequence = (index + 1) as i64;
            Ok(ExportTurnManifestEntry {
                id: turn_id(portable_sequence),
                sequence: sequence(portable_sequence)?,
            })
        })
        .collect::<Result<Vec<_>, ConversationExportBuildError>>()?;
    share_bindings::project_share_bindings(&mut closures, &mut ids)?;
    let context_owners = collect_context_owners(
        runtime,
        selected.iter().copied().zip(closures.iter()).collect(),
        selected
            .iter()
            .copied()
            .zip(context_inputs.iter())
            .collect(),
        &turn_sequences,
    )
    .await?;
    let current_snapshot =
        !context_owners.is_empty() || closures.iter().any(needs_current_snapshot);
    let context_icon_nodes = context_image_nodes(context_inputs.iter());
    let (authored_detail_assets, visual_asset_contents) = collect_visual_assets_with_context_icons(
        runtime,
        closures.iter(),
        &redactor,
        current_snapshot,
        &context_icon_nodes,
    )
    .await?;
    let header = ConversationExportRecord::Header(Box::new(ConversationExportHeader {
        export_version: if current_snapshot {
            EXPORT_VERSION_V3
        } else if visual_asset_contents.is_empty() {
            EXPORT_VERSION_V1
        } else {
            EXPORT_VERSION_V2
        },
        exported_at,
        producer,
        conversation: ExportConversation {
            id: "conversation:1".into(),
            // A chosen share title is an explicit public metadata exception;
            // it must not pass through path or credential redaction.
            title: share_title.to_owned(),
            created_at: detail.thread.created_at,
            project_name: detail.project.as_ref().map(|project| project.name.clone()),
            harness_configuration_name: detail.thread.harness_configuration_name,
            permission_profile_id: detail.thread.permission_profile_id,
        },
        turns,
        visual_asset_contents: Vec::new(),
    }));
    let mut records = vec![header];
    records.extend(
        visual_asset_contents
            .into_iter()
            .map(|content| ConversationExportRecord::VisualAssetContent(Box::new(content))),
    );
    for ((((interaction, closure), context_input), submitted_evidence), settled_attempt_outcome) in
        selected
            .iter()
            .zip(closures.iter())
            .zip(context_inputs.iter())
            .zip(submitted_evidence.iter())
            .zip(settled_attempt_outcomes.iter().copied())
    {
        let portable_sequence = *turn_sequences
            .get(&interaction.id)
            .expect("selected interaction has a portable sequence");
        records.push(ConversationExportRecord::Turn(Box::new(export_turn(
            interaction,
            TurnExportContext {
                portable_sequence,
                closure: Some(closure),
                context_input: Some(context_input),
                submitted_evidence,
                invocation: invocations.get(&interaction.id).copied(),
                imported: ImportedExportContext {
                    turn: imported_turns.get(&interaction.id).copied(),
                    turn_sequences: &imported_turn_sequences,
                },
                turn_sequences: &turn_sequences,
                redactor: &redactor,
                settled_attempt_outcome,
                authored_detail_assets: &authored_detail_assets,
            },
            &mut ids,
        )?)));
    }
    enrich_context_owners(&mut records, &context_owners, &ids);
    validate_export_records(&records)?;

    let mut body = Vec::new();
    for record in &records {
        let line = serde_json::to_vec(record)?;
        if line.len() > MAX_JSONL_LINE_BYTES {
            return Err(ConversationExportBuildError::ShareSnapshotTooLarge { bytes: line.len() });
        }
        let next_size = body.len().saturating_add(line.len()).saturating_add(1);
        if next_size > MAX_SHARE_SNAPSHOT_BYTES {
            return Err(ConversationExportBuildError::ShareSnapshotTooLarge { bytes: next_size });
        }
        body.extend_from_slice(&line);
        body.push(b'\n');
    }
    Ok(body)
}

// Layer ownership is immutable and read separately from the coherent content
// snapshot. Imported storage ownership is a materialization detail, so preserve
// its validated portable provenance instead of consulting local imported owners.
async fn collect_context_owners<'a>(
    runtime: &RuntimeClient,
    snapshots: Vec<(&'a Interaction, &'a AcceptedGraphClosure)>,
    contexts: Vec<(&'a Interaction, &'a ContextInput)>,
    sequences: &HashMap<InteractionId, i64>,
) -> Result<HashMap<i64, String>, ConversationExportBuildError> {
    let owners = snapshots
        .into_iter()
        .filter_map(|(interaction, closure)| {
            Some((
                interaction.graph_node_id?,
                (turn_id(*sequences.get(&interaction.id)?), closure),
            ))
        })
        .collect::<HashMap<_, _>>();
    let mut cached = HashMap::new();
    let mut result = HashMap::new();
    for (interaction, context) in contexts {
        let ContextInput::Runtime(context) = context else {
            continue;
        };
        let Some(viewer) = interaction.graph_node_id else {
            continue;
        };
        for action in &context.actions {
            let layer = action.target.source_layer_id.value();
            let owner = match cached.get(&layer) {
                Some(owner) => *owner,
                None => {
                    let receipt = runtime.get_layer_owner(viewer, layer).await?;
                    if receipt.layer_id != layer {
                        return Err(ConversationExportBuildError::Invalid(
                            "context owner receipt layer mismatch".into(),
                        ));
                    }
                    cached.insert(layer, receipt.owner_interaction_node_id);
                    receipt.owner_interaction_node_id
                }
            };
            if let Some((owner_turn, closure)) = owners.get(&owner)
                && closure.layers.iter().any(|resolved| {
                    resolved.layer.id == action.target.source_layer_id
                        && resolved.layer.nodes.contains(&action.target.node_id)
                })
            {
                result.insert(action.id.value(), owner_turn.clone());
            }
        }
    }
    Ok(result)
}

fn enrich_context_owners(
    records: &mut [ConversationExportRecord],
    owners: &HashMap<i64, String>,
    ids: &PortableIds,
) {
    let portable = owners
        .iter()
        .filter_map(|(action, owner)| Some((ids.action.get(action)?.as_str(), owner)))
        .collect::<HashMap<_, _>>();
    for record in records {
        let ConversationExportRecord::Turn(turn) = record else {
            continue;
        };
        for context in &mut turn.contexts {
            if let Some(owner) = portable.get(context.id.as_str()) {
                context.source.owner_turn_id = Some((*owner).clone());
            }
        }
    }
}

/// Only publish invoked work when its source ancestry is also in the accepted
/// snapshot. Otherwise export_turn would lose the invocation and call it a user turn.
fn share_accepted_interactions<'a>(
    interactions: &'a [Interaction],
    invocations: &[ActionInvocation],
) -> Vec<&'a Interaction> {
    let sources = invocations
        .iter()
        .map(|invocation| {
            (
                invocation.result_interaction_id,
                invocation.source_interaction_id,
            )
        })
        .collect::<HashMap<_, _>>();
    let mut included = HashSet::new();
    interactions
        .iter()
        .filter(|interaction| {
            interaction.completion_status == "accepted"
                && sources
                    .get(&interaction.id)
                    .is_none_or(|source| included.contains(source))
                && included.insert(interaction.id)
        })
        .collect()
}

#[cfg(test)]
async fn collect_visual_assets<'a>(
    runtime: &RuntimeClient,
    closures: impl IntoIterator<Item = &'a AcceptedGraphClosure>,
    redactor: &ProjectPathRedactor,
) -> Result<
    (
        HashMap<i64, Vec<ExportVisualAssetAssociation>>,
        Vec<ExportVisualAssetContent>,
    ),
    ConversationExportBuildError,
> {
    collect_visual_assets_for_snapshot(runtime, closures, redactor, false).await
}

fn context_image_nodes<'a>(inputs: impl IntoIterator<Item = &'a ContextInput>) -> Vec<GraphNode> {
    let mut nodes = Vec::new();
    for input in inputs {
        if let ContextInput::Runtime(runtime) = input {
            for context in &runtime.input.contexts {
                if icon_asset_pin(&context.target_node.icon).is_some() {
                    let target = &context.target_node;
                    nodes.push(GraphNode {
                        id: target.id,
                        client_key: None,
                        leased_action_id: None,
                        kind: target.kind.clone(),
                        icon: target.icon.clone(),
                        title: target.title.clone(),
                        detail: target.detail.clone(),
                        authored_detail: None,
                        artifact: None,
                        state: target.state,
                    });
                }
            }
        }
    }
    nodes
}

pub(super) fn icon_asset_pin(icon: &str) -> Option<serde_json::Value> {
    let value: serde_json::Value = serde_json::from_str(icon).ok()?;
    if value.get("kind")?.as_str()? != "image" {
        return None;
    }
    Some(
        serde_json::json!({"id": value.get("assetId")?, "digestSha256": value.get("digestSha256")?, "mediaType": value.get("mediaType")?, "representation": "image"}),
    )
}

#[cfg(test)]
async fn collect_visual_assets_for_snapshot<'a>(
    runtime: &RuntimeClient,
    closures: impl IntoIterator<Item = &'a AcceptedGraphClosure>,
    redactor: &ProjectPathRedactor,
    current_snapshot: bool,
) -> Result<
    (
        HashMap<i64, Vec<ExportVisualAssetAssociation>>,
        Vec<ExportVisualAssetContent>,
    ),
    ConversationExportBuildError,
> {
    collect_visual_assets_with_context_icons(runtime, closures, redactor, current_snapshot, &[])
        .await
}

async fn collect_visual_assets_with_context_icons<'a>(
    runtime: &RuntimeClient,
    closures: impl IntoIterator<Item = &'a AcceptedGraphClosure>,
    redactor: &ProjectPathRedactor,
    current_snapshot: bool,
    context_nodes: &[GraphNode],
) -> Result<
    (
        HashMap<i64, Vec<ExportVisualAssetAssociation>>,
        Vec<ExportVisualAssetContent>,
    ),
    ConversationExportBuildError,
> {
    let closures = closures.into_iter().collect::<Vec<_>>();
    let strict_snapshot = current_snapshot
        || closures
            .iter()
            .any(|closure| needs_current_snapshot(closure));
    let mut revisions = HashMap::new();
    for closure in &closures {
        if let Some(pins) = &closure.detail_asset_revisions {
            for (node, revision) in pins {
                if revisions
                    .insert(*node, *revision)
                    .is_some_and(|prior| prior != *revision)
                {
                    return Err(ConversationExportBuildError::Invalid(
                        "conflicting snapshot asset revisions".into(),
                    ));
                }
            }
        }
    }
    let mut icon_pins: HashMap<i64, Vec<serde_json::Value>> = HashMap::new();
    for closure in &closures {
        if let Some(pin) = closure.root_action.icon.as_deref().and_then(icon_asset_pin) {
            icon_pins
                .entry(closure.interaction.id.value())
                .or_default()
                .push(pin);
        }
        for layer in &closure.layers {
            for node in &layer.nodes {
                if let Some(pin) = icon_asset_pin(&node.icon) {
                    icon_pins.entry(node.id.value()).or_default().push(pin);
                }
            }
            for action in &layer.actions {
                if let Some(pin) = action.icon.as_deref().and_then(icon_asset_pin) {
                    icon_pins
                        .entry(action.source_node_id.value())
                        .or_default()
                        .push(pin);
                }
            }
        }
    }
    for node in context_nodes {
        if let Some(pin) = icon_asset_pin(&node.icon) {
            icon_pins.entry(node.id.value()).or_default().push(pin);
        }
    }
    let mut associations = HashMap::new();
    let mut visited_nodes = HashSet::new();
    let mut contents = BTreeMap::<String, ExportVisualAssetContent>::new();
    let mut referenced_contents = HashSet::new();
    let mut projected_content_bytes = 0usize;
    let mut accepted_nodes = Vec::new();
    for closure in closures {
        accepted_nodes.push(&closure.interaction);
        for layer in &closure.layers {
            accepted_nodes.extend(&layer.nodes);
        }
    }
    accepted_nodes.extend(context_nodes);
    for node in accepted_nodes {
        if !visited_nodes.insert(node.id) {
            continue;
        }
        let mut pins = icon_pins.remove(&node.id.value()).unwrap_or_default();
        let image_icon_present = !pins.is_empty();
        if let Some(detail) = node
            .authored_detail
            .as_ref()
            .filter(|detail| authored_detail_omission(detail, redactor).is_none())
        {
            let detail_pins = detail
                .get("assets")
                .and_then(serde_json::Value::as_array)
                .ok_or_else(|| {
                    ConversationExportBuildError::Invalid(
                        "authored detail asset pins are invalid".into(),
                    )
                })?;
            pins.extend(detail_pins.iter().cloned());
        }
        let mut unique_pins = BTreeMap::new();
        for pin in pins {
            let id = pin
                .get("id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_owned();
            if unique_pins
                .insert(id, pin.clone())
                .is_some_and(|previous| previous != pin)
            {
                return Err(ConversationExportBuildError::Invalid(
                    "conflicting icon and detail asset pins".into(),
                ));
            }
        }
        let pins = unique_pins.into_values().collect::<Vec<_>>();
        if pins.is_empty() {
            continue;
        }
        let mut node_assets = Vec::with_capacity(pins.len());
        let mut node_content_digests = Vec::with_capacity(pins.len());
        let mut legacy_metadata_only = false;
        for pin in &pins {
            let asset_id = pin
                .get("id")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    ConversationExportBuildError::Invalid(
                        "authored detail asset id is invalid".into(),
                    )
                })?;
            let expected_revision = revisions.get(&node.id).copied();
            if expected_revision.is_none()
                && strict_snapshot
                && !context_nodes.iter().any(|target| target.id == node.id)
            {
                return Err(ConversationExportBuildError::Invalid(
                    "runtime lacks coherent asset revision pins".into(),
                ));
            }
            let value = match runtime
                .read_detail_asset(node.id.value(), asset_id, true, expected_revision)
                .await
            {
                Ok(value) => value,
                Err(RuntimeError::Remote { status: 404, .. }) => {
                    if redactor.is_share() || strict_snapshot || image_icon_present {
                        return Err(ConversationExportBuildError::Invalid(
                            if redactor.is_share() {
                                "public visual asset metadata is unavailable"
                            } else {
                                "snapshot visual asset metadata is unavailable"
                            }
                            .into(),
                        ));
                    }
                    legacy_metadata_only = true;
                    break;
                }
                Err(error) => return Err(error.into()),
            };
            let digest = value
                .get("digestSha256")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    ConversationExportBuildError::Invalid(
                        "accepted visual asset digest is invalid".into(),
                    )
                })?;
            let media = value
                .get("mediaType")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    ConversationExportBuildError::Invalid(
                        "accepted visual asset media type is invalid".into(),
                    )
                })?;
            let length = value
                .get("byteLength")
                .and_then(serde_json::Value::as_u64)
                .and_then(|v| usize::try_from(v).ok())
                .ok_or_else(|| {
                    ConversationExportBuildError::Invalid(
                        "accepted visual asset length is invalid".into(),
                    )
                })?;
            if pin.get("digestSha256").and_then(serde_json::Value::as_str) != Some(digest)
                || pin.get("mediaType").and_then(serde_json::Value::as_str) != Some(media)
            {
                return Err(ConversationExportBuildError::Invalid(
                    "accepted visual asset does not match its package pin".into(),
                ));
            }
            let provenance = value
                .get("provenance")
                .and_then(serde_json::Value::as_object)
                .ok_or_else(|| {
                    ConversationExportBuildError::Invalid(
                        "accepted visual asset provenance is invalid".into(),
                    )
                })?;
            let association = ExportVisualAssetAssociation {
                asset_id: asset_id.into(),
                digest_sha256: digest.into(),
                media_type: media.into(),
                byte_length: length,
                provenance: ExportVisualAssetProvenance {
                    source: provenance
                        .get("source")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("user")
                        .into(),
                    file_name: portable_asset_filename(
                        provenance
                            .get("fileName")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("asset"),
                        redactor,
                    ),
                },
            };
            if let std::collections::btree_map::Entry::Vacant(entry) = contents.entry(digest.into())
            {
                if redactor.is_share() {
                    // Account for canonical base64 plus the serialized record envelope
                    // before asking the runtime to materialize the content body.
                    let envelope = ConversationExportRecord::VisualAssetContent(Box::new(
                        ExportVisualAssetContent {
                            digest_sha256: digest.into(),
                            media_type: media.into(),
                            byte_length: length,
                            content_base64: String::new(),
                        },
                    ));
                    projected_content_bytes = projected_content_bytes
                        .saturating_add(serde_json::to_vec(&envelope)?.len())
                        .saturating_add(
                            length.saturating_add(2).saturating_div(3).saturating_mul(4),
                        )
                        .saturating_add(1);
                    if projected_content_bytes > MAX_SHARE_SNAPSHOT_BYTES {
                        return Err(ConversationExportBuildError::ShareSnapshotTooLarge {
                            bytes: projected_content_bytes,
                        });
                    }
                }
                let payload = runtime
                    .read_detail_asset(node.id.value(), asset_id, false, expected_revision)
                    .await?;
                if payload
                    .get("digestSha256")
                    .and_then(serde_json::Value::as_str)
                    != Some(digest)
                    || payload.get("mediaType").and_then(serde_json::Value::as_str) != Some(media)
                    || payload
                        .get("byteLength")
                        .and_then(serde_json::Value::as_u64)
                        != Some(length as u64)
                {
                    return Err(ConversationExportBuildError::Invalid(
                        "accepted visual asset content does not match its metadata".into(),
                    ));
                }
                entry.insert(ExportVisualAssetContent {
                    digest_sha256: digest.into(),
                    media_type: media.into(),
                    byte_length: length,
                    content_base64: payload
                        .get("contentBase64")
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(|| {
                            ConversationExportBuildError::Invalid(
                                "accepted visual asset content is invalid".into(),
                            )
                        })?
                        .into(),
                });
            }
            let cached = &contents[digest];
            if cached.media_type != media || cached.byte_length != length {
                return Err(ConversationExportBuildError::Invalid(
                    "accepted visual asset digest has conflicting metadata".into(),
                ));
            }
            node_content_digests.push(digest.to_owned());
            node_assets.push(association);
        }
        if legacy_metadata_only {
            continue;
        }
        referenced_contents.extend(node_content_digests);
        node_assets.sort_by(|a, b| a.asset_id.cmp(&b.asset_id));
        associations.insert(node.id.value(), node_assets);
    }
    contents.retain(|digest, _| referenced_contents.contains(digest));
    Ok((associations, contents.into_values().collect()))
}

fn portable_asset_filename(value: &str, redactor: &ProjectPathRedactor) -> String {
    let redacted = redactor.text(value);
    if redacted.trim().is_empty() || redacted.len() > crate::conversation_export::MAX_STRING_BYTES {
        "asset".into()
    } else {
        redacted
    }
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

/// The outcome a recursive child's still-running attempt already took, if its execution
/// has settled. The attempt stays running only while the child's provider unwinds, so the
/// export reports the outcome settlement decided rather than an in-flight attempt.
pub(crate) async fn settled_attempt_outcome(
    product: &ProductService,
    interaction: &Interaction,
) -> Result<Option<&'static str>, ConversationExportBuildError> {
    let running = interaction
        .latest_attempt
        .as_ref()
        .is_some_and(|attempt| attempt.outcome == "running");
    // Only a status the snapshot already shows as settled decides the outcome. A child
    // that settles after the snapshot was read still exports as running, consistently.
    let settled_status = matches!(
        interaction.completion_status.as_str(),
        "accepted" | "failed" | "stopped"
    );
    if !running || !settled_status {
        return Ok(None);
    }
    Ok(product
        .completion_execution(interaction.id)
        .await?
        .filter(|execution| execution.phase == crate::storage::CompletionExecutionPhase::Settled)
        .map(|_| {
            crate::product::settled_recursive_attempt_outcome(&interaction.completion_status).0
        }))
}

struct TurnExportContext<'a> {
    /// The authority-free sequence written to the portable record. Ordinary
    /// exports use the durable interaction sequence; share snapshots compact
    /// the accepted subset into a frozen 1..N sequence.
    portable_sequence: i64,
    closure: Option<&'a AcceptedGraphClosure>,
    context_input: Option<&'a ContextInput>,
    submitted_evidence: &'a [SubmittedInputEvidence],
    invocation: Option<&'a ActionInvocation>,
    imported: ImportedExportContext<'a>,
    turn_sequences: &'a HashMap<InteractionId, i64>,
    redactor: &'a ProjectPathRedactor,
    /// The outcome a still-running attempt already took when its execution settled.
    settled_attempt_outcome: Option<&'static str>,
    authored_detail_assets: &'a HashMap<i64, Vec<ExportVisualAssetAssociation>>,
}

fn export_turn(
    interaction: &Interaction,
    context: TurnExportContext<'_>,
    ids: &mut PortableIds,
) -> Result<ConversationExportTurn, ConversationExportBuildError> {
    let TurnExportContext {
        portable_sequence,
        closure,
        context_input,
        submitted_evidence,
        invocation,
        imported,
        turn_sequences,
        redactor,
        settled_attempt_outcome,
        authored_detail_assets,
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
        .map(|closure| export_view_with_assets(closure, ids, redactor, authored_detail_assets))
        .transpose()?;
    let mut contexts = export_contexts(
        interaction,
        context_input,
        imported.turn.map(|record| &record.turn.contexts),
        ids,
        redactor,
    )?;
    if let Some(ContextInput::Runtime(input)) = context_input {
        for (context, native) in contexts.iter_mut().zip(&input.input.contexts) {
            if let Some(icon) = relayer_graph_core::image_icon(&native.target_node.icon) {
                context.target.icon_asset = Some(
                    authored_detail_assets
                        .get(&native.target_node.id.value())
                        .and_then(|assets| {
                            assets.iter().find(|asset| asset.asset_id == icon.asset_id)
                        })
                        .cloned()
                        .ok_or_else(|| {
                            ConversationExportBuildError::Invalid(
                                "context image icon bytes are unavailable".into(),
                            )
                        })?,
                );
            }
        }
    }
    if imported.turn.is_some() {
        for context in &mut contexts {
            if let Some(owner) = &context.source.owner_turn_id {
                context.source.owner_turn_id = Some(turn_id(
                    *imported.turn_sequences.get(owner.as_str()).ok_or_else(|| {
                        ConversationExportBuildError::Invalid(
                            "imported context owner is outside the snapshot".into(),
                        )
                    })?,
                ));
            }
        }
    }
    let submitted_inputs = export_submitted_inputs_with_root_sequence(
        interaction,
        submitted_evidence,
        imported.turn.map(|record| &record.turn.submitted_inputs),
        ids,
        redactor,
        portable_sequence,
    )?;
    let interaction_node_id = interaction
        .graph_node_id
        .map(|node_id| ids.node(node_id))
        .or_else(|| {
            (!submitted_inputs.is_empty()).then(|| format!("node:input-root-{portable_sequence}"))
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
        id: turn_id(portable_sequence),
        sequence: sequence(portable_sequence)?,
        created_at: interaction.created_at.clone(),
        text: redactor.text(&interaction.text),
        interaction_node_id,
        origin,
        completion: ExportCompletionReceipt {
            status,
            attempt_outcome: interaction
                .latest_attempt
                .as_ref()
                .map(|attempt| attempt_outcome(settled_attempt_outcome.unwrap_or(&attempt.outcome)))
                .transpose()?
                .or_else(|| imported_completion.and_then(|completion| completion.attempt_outcome)),
            harness_configuration_name: interaction.harness_configuration_name.clone(),
            harness_configuration_digest: (!redactor.is_share())
                .then(|| interaction.harness_configuration_digest.clone())
                .flatten(),
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
            effective_execution_digest: (!redactor.is_share())
                .then(|| interaction.effective_execution_digest.clone())
                .flatten(),
            effective_permission_receipt: (!redactor.is_share())
                .then_some(effective_permission_receipt)
                .flatten(),
            error: interaction
                .completion_error
                .as_deref()
                .map(|error| redactor.text(error)),
            attempt_admission_id: (!redactor.is_share())
                .then(|| {
                    interaction
                        .latest_attempt
                        .as_ref()
                        .and_then(|attempt| attempt.attempt_admission_id.clone())
                        .or_else(|| {
                            imported_completion
                                .and_then(|completion| completion.attempt_admission_id.clone())
                        })
                })
                .flatten(),
            admitted_model_plan: (!redactor.is_share())
                .then(|| {
                    interaction
                        .latest_attempt
                        .as_ref()
                        .and_then(|attempt| {
                            attempt.admitted_plan.as_ref().map(|plan| {
                                ExportAdmittedExecutionModelPlan {
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
                                }
                            })
                        })
                        .or_else(|| {
                            imported_completion
                                .and_then(|completion| completion.admitted_model_plan.clone())
                        })
                })
                .flatten(),
        },
        contexts,
        submitted_inputs,
        accepted_view,
    })
}

fn portable_context_detail_matches(native: &str, portable: &str) -> bool {
    native == portable
        || native
            == format!(
                "{portable}\n\n{}",
                relayer_graph_core::IMPORTED_AUTHORED_DETAIL_OMITTED_NOTE
            )
}

fn portable_icon_matches(left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    match (
        relayer_graph_core::image_icon(left),
        relayer_graph_core::image_icon(right),
    ) {
        (Some(left), Some(right)) => {
            serde_json::to_value(left).ok() == serde_json::to_value(right).ok()
        }
        _ => false,
    }
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
                || !portable_icon_matches(
                    &redactor.text(&normalized.target_node.icon),
                    &portable.target.icon,
                )
                || redactor.text(&normalized.target_node.title) != portable.target.title
                || !portable_context_detail_matches(
                    &redactor.text(&normalized.target_node.detail),
                    &portable.target.detail,
                )
            {
                return Err(ConversationExportBuildError::Invalid(format!(
                    "imported interaction {} context no longer matches its immutable portable snapshot (node={}, annotations={}, kind={}, icon={}, title={}, detail={})",
                    interaction.id,
                    normalized.target_node.id == action.target.node_id,
                    normalized.annotations == portable.annotations
                        && action.annotations == portable.annotations,
                    redactor.text(&normalized.target_node.kind) == portable.target.kind,
                    portable_icon_matches(
                        &redactor.text(&normalized.target_node.icon),
                        &portable.target.icon
                    ),
                    redactor.text(&normalized.target_node.title) == portable.target.title,
                    redactor.text(&normalized.target_node.detail) == portable.target.detail
                )));
            }
        }
        return Ok(imported
            .iter()
            .cloned()
            .zip(&runtime.input.contexts)
            .map(|(mut context, normalized)| {
                // Import may append the code-owned omitted-Detail notice. Export
                // the same accepted fallback in node and context projections.
                context.target.detail = redactor.text(&normalized.target_node.detail);
                context.target.icon = redactor.text(&normalized.target_node.icon);
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
                    icon_asset: None,
                    title: redactor.text(&normalized.target_node.title),
                    detail: redactor.text(&normalized.target_node.detail),
                    state: ExportRecordState::Accepted,
                },
                source: ExportContextSource {
                    owner_turn_id: None,
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

#[cfg(test)]
fn export_submitted_inputs(
    interaction: &Interaction,
    evidence: &[SubmittedInputEvidence],
    imported: Option<&Vec<ExportSubmittedInput>>,
    ids: &mut PortableIds,
    redactor: &ProjectPathRedactor,
) -> Result<Vec<ExportSubmittedInput>, ConversationExportBuildError> {
    export_submitted_inputs_with_root_sequence(
        interaction,
        evidence,
        imported,
        ids,
        redactor,
        interaction.sequence,
    )
}

fn export_submitted_inputs_with_root_sequence(
    interaction: &Interaction,
    evidence: &[SubmittedInputEvidence],
    imported: Option<&Vec<ExportSubmittedInput>>,
    ids: &mut PortableIds,
    redactor: &ProjectPathRedactor,
    portable_sequence: i64,
) -> Result<Vec<ExportSubmittedInput>, ConversationExportBuildError> {
    if evidence.is_empty() {
        let mut imported = imported.cloned().unwrap_or_default();
        for submitted in &mut imported {
            submitted.root_turn_id = turn_id(portable_sequence);
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
    let root_turn_id = turn_id(portable_sequence);
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
                id: format!("input-child:{portable_sequence}-{}", index + 1),
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
                icon_asset: None,
                title: redactor.text(&snapshot.title),
                detail: redactor.text(&snapshot.detail),
                state: ExportRecordState::Accepted,
            },
            source: ExportContextSource {
                owner_turn_id: None,
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
            if let (Some(materialized), Some(portable)) =
                (action.source_layer_id, &imported_action.source_layer_id)
            {
                // Inert source provenance may live outside the response closure.
                ids.bind_layer(materialized.value(), portable.clone())?;
            }
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

fn export_view_with_assets(
    closure: &AcceptedGraphClosure,
    ids: &mut PortableIds,
    redactor: &ProjectPathRedactor,
    assets: &HashMap<i64, Vec<ExportVisualAssetAssociation>>,
) -> Result<ExportAcceptedView, ConversationExportBuildError> {
    let mut view = export_view(closure, ids, redactor)?;
    if let Some(icon) = closure
        .root_action
        .icon
        .as_deref()
        .and_then(relayer_graph_core::image_icon)
    {
        let association = assets
            .get(&closure.interaction.id.value())
            .and_then(|assets| assets.iter().find(|asset| asset.asset_id == icon.asset_id))
            .cloned()
            .ok_or_else(|| {
                ConversationExportBuildError::Invalid(
                    "root image icon bytes are unavailable".into(),
                )
            })?;
        view.root_action.icon_asset = Some(association);
    }
    for (resolved, exported) in closure.layers.iter().zip(&mut view.layers) {
        for (node, portable) in resolved.nodes.iter().zip(&mut exported.nodes) {
            portable.authored_detail_assets =
                assets.get(&node.id.value()).cloned().unwrap_or_default();
        }
    }
    Ok(view)
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
            default_node_id: resolved
                .layer
                .default_node_id
                .map(|id| ids.node(id.value())),
            id: ids.layer(resolved.layer.id.value()),
            client_key: if redactor.is_share() {
                Some(ids.layer(resolved.layer.id.value()))
            } else {
                redactor.optional(resolved.layer.client_key.as_deref())
            },
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
                    edge_shape: layout.edge_shape.clone(),
                    edge_routes: layout
                        .edge_routes
                        .iter()
                        .map(|route| ExportEdgeRoute {
                            edge_id: ids.edge(route.edge_id.value()),
                            shape: route.shape.clone(),
                            ends: route
                                .ends
                                .iter()
                                .map(|end| ExportEdgeEnd {
                                    node_id: ids.node(end.node_id.value()),
                                    side: end.side.clone(),
                                })
                                .collect(),
                            waypoints: route.waypoints.clone(),
                        })
                        .collect(),
                }),
            // A share that dropped sensitive artifact details also drops the renderer, so
            // the layer reads consistently as an ordinary graph (PRD 6.6.11 fallback).
            renderer: resolved
                .layer
                .renderer
                .clone()
                .filter(|_| nodes.iter().all(|node| node.artifact.is_some())),
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
    let authored_detail_omitted = node
        .authored_detail
        .as_ref()
        .and_then(|detail| authored_detail_omission(detail, redactor));
    let authored_detail = node
        .authored_detail
        .as_ref()
        .and_then(|detail| portable_authored_detail(detail, redactor));
    Ok(ExportNode {
        id: ids.node(node.id.value()),
        client_key: if redactor.is_share() {
            Some(ids.node(node.id.value()))
        } else {
            redactor.optional(node.client_key.as_deref())
        },
        kind: redactor.text(&node.kind),
        icon: redactor.text(&node.icon),
        title: redactor.text(&node.title),
        detail: redactor.text(&node.detail),
        authored_detail,
        authored_detail_omitted,
        authored_detail_assets: Vec::new(),
        // A share drops artifact details that look sensitive; the node then reads as ordinary.
        artifact: node.artifact.clone().filter(|artifact| {
            !(redactor.is_share() && redactor.contains_sensitive_json(artifact))
        }),
        state: ExportRecordState::Accepted,
    })
}

fn portable_authored_detail(
    authored_detail: &serde_json::Value,
    redactor: &ProjectPathRedactor,
) -> Option<serde_json::Value> {
    authored_detail_omission(authored_detail, redactor)
        .is_none()
        .then(|| authored_detail.clone())
}

fn authored_detail_omission(
    authored_detail: &serde_json::Value,
    redactor: &ProjectPathRedactor,
) -> Option<ExportAuthoredDetailOmission> {
    let contains_private_path = if redactor.is_share() {
        redactor.contains_private_path_json(authored_detail)
    } else {
        json_contains_private_project_path(authored_detail, redactor)
    };
    if contains_private_path {
        Some(ExportAuthoredDetailOmission::PrivatePath)
    } else if redactor.is_share() && redactor.contains_sensitive_json(authored_detail) {
        Some(ExportAuthoredDetailOmission::SensitiveData)
    } else {
        None
    }
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
        converted_from_invoke: is_converted_invoke(action),
        id: ids.action(action.id.value()),
        client_key: if redactor.is_share() {
            Some(ids.action(action.id.value()))
        } else {
            redactor.optional(action.client_key.as_deref())
        },
        source_node_id: ids.node(action.source_node_id.value()),
        source_layer_id: action.source_layer_id.map(|id| ids.layer(id.value())),
        kind,
        relation,
        label: redactor.text(&action.label),
        variant,
        icon: redactor.optional(action.icon.as_deref()),
        icon_asset: None,
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
    scrub_sensitive: bool,
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
        Self {
            project_paths,
            scrub_sensitive: false,
        }
    }

    fn for_share(project_path: Option<&str>) -> Self {
        let mut redactor = Self::new(project_path);
        redactor.scrub_sensitive = true;
        redactor
    }

    fn is_share(&self) -> bool {
        self.scrub_sensitive
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
            // Markdown syntax is not visible to a reader and can otherwise
            // split a private path across emphasis, links, or inert HTML.
            if self.contains_private_path(&markdown_rendered_text(&replaced))
                || self.contains_markdown_private_path(&replaced)
            {
                return "[project-path]".to_owned();
            }
            return if self.scrub_sensitive {
                redact_share_secrets(&replaced)
            } else {
                replaced
            };
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
        let redacted = if self.contains_private_path(&redacted)
            || self.contains_private_path(&markdown_rendered_text(&redacted))
            || self.contains_markdown_private_path(&redacted)
        {
            "[project-path]".to_owned()
        } else {
            redacted
        };
        if self.scrub_sensitive {
            redact_share_secrets(&redacted)
        } else {
            redacted
        }
    }

    fn replace_raw(&self, value: &str) -> String {
        let redacted = self
            .project_paths
            .iter()
            .fold(value.to_owned(), |text, path| {
                text.replace(path, "[project-path]")
            });
        if self.scrub_sensitive {
            share_home_path_regex()
                .replace_all(&redacted, "[home-path]")
                .into_owned()
        } else {
            redacted
        }
    }

    fn contains_raw(&self, value: &str) -> bool {
        self.project_paths.iter().any(|path| value.contains(path))
            || (self.scrub_sensitive && share_home_path_regex().is_match(value))
    }

    /// The single private-path matcher shared by Markdown redaction and the
    /// authored-detail portability check. It matches the raw string and every
    /// bounded decoding round of HTML character references, percent-encoding,
    /// CSS escapes, and invisible code points.
    fn contains_private_path(&self, value: &str) -> bool {
        if self.project_paths.is_empty() && !self.scrub_sensitive {
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

    fn contains_markdown_private_path(&self, value: &str) -> bool {
        let without_subtrees = strip_dangerous_markdown_subtrees(value);
        let without_shallow_subtrees = strip_shallow_dangerous_markdown_subtrees(value);
        let without_images = strip_markdown_images(value);
        let skeletons = [
            markdown_security_skeleton(value),
            markdown_html_stripped_skeleton(value),
            security_skeleton(&without_subtrees),
            markdown_html_stripped_skeleton(&without_subtrees),
            security_skeleton(&without_shallow_subtrees),
            markdown_html_stripped_skeleton(&without_shallow_subtrees),
            security_skeleton(&without_images),
        ];
        skeletons.iter().any(|skeleton| {
            self.contains_private_path(skeleton)
                || self.project_paths.iter().any(|path| {
                    let projected_path = markdown_security_skeleton(path);
                    !projected_path.is_empty() && skeleton.contains(&projected_path)
                })
        })
    }

    fn optional(&self, value: Option<&str>) -> Option<String> {
        value.map(|value| self.text(value))
    }

    fn contains_sensitive_json(&self, value: &serde_json::Value) -> bool {
        if self.contains_private_path_json(value) {
            return true;
        }
        if !self.scrub_sensitive {
            return false;
        }
        let mut strings = String::new();
        collect_json_strings(value, &mut strings);
        if has_share_secret(&strings) {
            return true;
        }
        let rendered_text = authored_detail_rendered_text(value);
        has_share_secret(&rendered_text)
    }

    fn contains_private_path_json(&self, value: &serde_json::Value) -> bool {
        if json_contains_private_project_path(value, self) {
            return true;
        }
        if self.project_paths.is_empty() && !self.scrub_sensitive {
            return false;
        }
        let mut strings = String::new();
        collect_json_strings(value, &mut strings);
        self.contains_private_path(&strings)
            || self.contains_private_path(&authored_detail_rendered_text(value))
    }
}

/// Return the same contiguous text an authored-detail HTML component can expose
/// to a visitor. Checking serialized source strings alone is insufficient:
/// adjacent text nodes can reassemble a path or credential around inert tags.
fn authored_detail_rendered_text(value: &serde_json::Value) -> String {
    let mut rendered = String::new();
    let Some(components) = value
        .get("components")
        .and_then(serde_json::Value::as_array)
    else {
        return rendered;
    };
    for component in components {
        let Some(html) = component.get("html").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let mut inside_tag = false;
        for character in html.chars() {
            match character {
                '<' => inside_tag = true,
                '>' if inside_tag => inside_tag = false,
                _ if !inside_tag => rendered.push(character),
                _ => {}
            }
        }
    }
    let mut candidate = rendered;
    for _ in 0..NORMALIZATION_ROUNDS {
        let (decoded, changed) = decode_html_character_references_once(&candidate);
        candidate = decoded;
        if !changed {
            break;
        }
    }
    candidate
}

fn collect_json_strings(value: &serde_json::Value, output: &mut String) {
    match value {
        serde_json::Value::String(text) => output.push_str(text),
        serde_json::Value::Array(values) => {
            for value in values {
                collect_json_strings(value, output);
            }
        }
        serde_json::Value::Object(values) => {
            for value in values.values() {
                collect_json_strings(value, output);
            }
        }
        serde_json::Value::Null | serde_json::Value::Bool(_) | serde_json::Value::Number(_) => {}
    }
}

/// Share snapshots have a second, credential-oriented scrubber in addition to
/// the ordinary project-path redactor. Keep the replacements deliberately
/// opaque: the viewer is public and these values must not remain recoverable
/// from the serialized payload.
fn redact_share_secrets(value: &str) -> String {
    let mut redacted = pem_secret_regex()
        .replace_all(value, "[redacted-secret]")
        .into_owned();
    redacted = bearer_secret_regex()
        .replace_all(&redacted, "Bearer [redacted-secret]")
        .into_owned();
    redacted = jwt_secret_regex()
        .replace_all(&redacted, "$1[redacted-secret]")
        .into_owned();
    let redacted = provider_secret_regex()
        .replace_all(&redacted, "$1[redacted-secret]")
        .into_owned();
    if contains_raw_share_secret(&markdown_rendered_text(&redacted))
        || contains_markdown_share_secret(&redacted)
    {
        return "[redacted-secret]".into();
    }
    // Ordinary Markdown is decoded again by the renderer. Detect credentials
    // exposed by each bounded normalization step without rewriting safe Markdown.
    let mut candidate = redacted.clone();
    for _ in 0..NORMALIZATION_ROUNDS {
        let mut changed = false;
        for step in DECODING_STEPS {
            let (next, step_changed) = step(&candidate);
            if step_changed
                && (contains_raw_share_secret(&next)
                    || contains_raw_share_secret(&markdown_rendered_text(&next))
                    || contains_markdown_share_secret(&next))
            {
                return "[redacted-secret]".into();
            }
            changed |= step_changed;
            candidate = next;
        }
        if !changed {
            return redacted;
        }
    }
    "[redacted-secret]".into()
}

/// Approximate the security-relevant text projection produced by the Markdown
/// renderer. Inline HTML tags and Markdown emphasis delimiters are not visible
/// to a reader and therefore must not be allowed to split a credential. This is
/// intentionally conservative: false positives redact one public field, while
/// a false negative would disclose the reconstructed secret.
fn markdown_rendered_text(value: &str) -> String {
    let characters: Vec<char> = value.chars().collect();
    let mut rendered = String::with_capacity(value.len());
    let mut index = 0;
    while index < characters.len() {
        match characters[index] {
            '<' => {
                if let Some(end) = inline_html_end(&characters, index) {
                    index = end;
                } else {
                    rendered.push('<');
                    index += 1;
                }
            }
            ']' if characters.get(index + 1) == Some(&'(') => {
                let mut cursor = index + 2;
                let mut depth = 1usize;
                while cursor < characters.len() && depth > 0 {
                    match characters[cursor] {
                        '(' => depth = depth.saturating_add(1),
                        ')' => depth = depth.saturating_sub(1),
                        '\\' => cursor = cursor.saturating_add(1),
                        _ => {}
                    }
                    cursor += 1;
                }
                if depth == 0 {
                    index = cursor;
                } else {
                    rendered.push(']');
                    index += 1;
                }
            }
            ']' if characters.get(index + 1) == Some(&'[') => {
                if let Some(offset) = characters[index + 2..]
                    .iter()
                    .position(|character| *character == ']')
                {
                    index += 2 + offset + 1;
                } else {
                    rendered.push(']');
                    index += 1;
                }
            }
            '*' | '`' | '~' | '[' | ']' | '!' => index += 1,
            character => {
                rendered.push(character);
                index += 1;
            }
        }
    }
    rendered
}

/// A deliberately lossy security projection for ambiguous or malformed
/// Markdown. It removes punctuation that can be interpreted as presentation
/// syntax while retaining the characters used by private paths and provider
/// credentials. The relaxed credential matcher intentionally tolerates a
/// visible-label prefix; false positives redact one public field.
fn markdown_security_skeleton(value: &str) -> String {
    security_skeleton(&strip_closed_markdown_destinations(value))
}

fn markdown_html_stripped_skeleton(value: &str) -> String {
    let without_subtrees = strip_dangerous_markdown_subtrees(value);
    let without_images = strip_markdown_images(&without_subtrees);
    security_skeleton(&strip_grammar_html(&without_images))
}

fn security_skeleton(value: &str) -> String {
    value
        .chars()
        .filter(|character| {
            character.is_alphanumeric()
                || matches!(character, '/' | '\\' | '.' | '_' | ':' | '-' | '=' | '+')
                || character.is_whitespace()
        })
        .collect()
}

fn strip_grammar_html(value: &str) -> String {
    let characters: Vec<char> = value.chars().collect();
    let mut stripped = String::with_capacity(value.len());
    let mut index = 0;
    while index < characters.len() {
        if characters[index] == '<'
            && let Some(end) = inline_html_end(&characters, index)
        {
            index = end;
            continue;
        }
        stripped.push(characters[index]);
        index += 1;
    }
    stripped
}

fn strip_dangerous_markdown_subtrees(value: &str) -> String {
    let mut stripped = value.to_owned();
    for _ in 0..8 {
        let next = dangerous_markdown_subtree_regex()
            .replace_all(&stripped, "")
            .into_owned();
        if next == stripped {
            return stripped;
        }
        stripped = next;
    }
    stripped
}

fn strip_shallow_dangerous_markdown_subtrees(value: &str) -> String {
    dangerous_markdown_shallow_subtree_regex()
        .replace_all(value, "")
        .into_owned()
}

fn strip_markdown_images(value: &str) -> String {
    let characters: Vec<char> = value.chars().collect();
    let mut stripped = String::with_capacity(value.len());
    let mut index = 0;
    while index < characters.len() {
        if characters[index] != '!' || characters.get(index + 1) != Some(&'[') {
            stripped.push(characters[index]);
            index += 1;
            continue;
        }
        let mut cursor = index + 2;
        let mut bracket_depth = 1usize;
        while cursor < characters.len() && bracket_depth > 0 {
            match characters[cursor] {
                '[' => bracket_depth = bracket_depth.saturating_add(1),
                ']' => bracket_depth = bracket_depth.saturating_sub(1),
                '\\' => cursor = cursor.saturating_add(1),
                _ => {}
            }
            cursor += 1;
        }
        if bracket_depth != 0 {
            stripped.push('!');
            index += 1;
            continue;
        }
        let destination_end = match characters.get(cursor) {
            Some('(') => {
                let mut end = cursor + 1;
                let mut depth = 1usize;
                while end < characters.len() && depth > 0 {
                    match characters[end] {
                        '(' => depth = depth.saturating_add(1),
                        ')' => depth = depth.saturating_sub(1),
                        '\\' => end = end.saturating_add(1),
                        _ => {}
                    }
                    end += 1;
                }
                (depth == 0).then_some(end)
            }
            Some('[') => characters[cursor + 1..]
                .iter()
                .position(|character| *character == ']')
                .map(|offset| cursor + 1 + offset + 1),
            _ => None,
        };
        // A bare `![label]` can resolve through a later shortcut reference.
        // Removing it in this security-only projection is deliberately
        // fail-closed; the original bytes are preserved when no secret/path is
        // exposed by the projection.
        index = destination_end.unwrap_or(cursor);
    }
    stripped
}

fn dangerous_markdown_subtree_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(
            r"(?is)<(?:iframe|math|object|script|style|svg|template)\b[^>]*>.*</(?:iframe|math|object|script|style|svg|template)\s*>",
        )
        .expect("valid dangerous Markdown subtree regex")
    })
}

fn dangerous_markdown_shallow_subtree_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(
            r"(?is)<(?:iframe|math|object|script|style|svg|template)\b[^>]*>.*?</(?:iframe|math|object|script|style|svg|template)\s*>",
        )
        .expect("valid shallow dangerous Markdown subtree regex")
    })
}

/// Remove only closed inline-link destinations for the lossy security
/// projection. HTML-like regions and reference labels remain intact because
/// malformed forms can render visibly; the separate renderer projection
/// removes grammar-shaped tags and resolved destination syntax.
fn strip_closed_markdown_destinations(value: &str) -> String {
    let characters: Vec<char> = value.chars().collect();
    let mut stripped = String::with_capacity(value.len());
    let mut index = 0;
    while index < characters.len() {
        if characters[index] == ']' && characters.get(index + 1) == Some(&'(') {
            let mut cursor = index + 2;
            let mut depth = 1usize;
            while cursor < characters.len() {
                match characters[cursor] {
                    '\\' => cursor = cursor.saturating_add(1),
                    '(' => depth = depth.saturating_add(1),
                    ')' => {
                        depth = depth.saturating_sub(1);
                        if depth == 0 {
                            index = cursor + 1;
                            break;
                        }
                    }
                    _ => {}
                }
                cursor += 1;
            }
            if depth == 0 {
                continue;
            }
        }
        stripped.push(characters[index]);
        index += 1;
    }
    stripped
}

/// Return the byte-independent character offset after a complete HTML comment
/// or grammar-shaped tag. An unquoted nested `<`, or punctuation immediately
/// after a tag name, makes the construct malformed and therefore visible.
fn inline_html_end(characters: &[char], index: usize) -> Option<usize> {
    if characters[index..].starts_with(&['<', '!', '-', '-']) {
        return characters[index + 4..]
            .windows(3)
            .position(|window| window == ['-', '-', '>'])
            .map(|offset| index + 4 + offset + 3);
    }
    if characters[index..].starts_with(&['<', '?']) {
        return characters[index + 2..]
            .windows(2)
            .position(|window| window == ['?', '>'])
            .map(|offset| index + 2 + offset + 2);
    }
    if characters[index..].starts_with(&['<', '!']) {
        let mut cursor = index + 2;
        while cursor < characters.len() {
            if characters[cursor] == '>' {
                return Some(cursor + 1);
            }
            cursor += 1;
        }
        return None;
    }

    let closing = characters.get(index + 1) == Some(&'/');
    let name_start = if closing { index + 2 } else { index + 1 };
    if !characters
        .get(name_start)
        .is_some_and(|character| character.is_ascii_alphabetic())
    {
        return None;
    }
    let mut cursor = name_start + 1;
    while characters
        .get(cursor)
        .is_some_and(|character| character.is_ascii_alphanumeric() || *character == '-')
    {
        cursor += 1;
    }
    if closing {
        while characters
            .get(cursor)
            .is_some_and(|value| value.is_whitespace())
        {
            cursor += 1;
        }
        return (characters.get(cursor) == Some(&'>')).then_some(cursor + 1);
    }

    loop {
        while characters
            .get(cursor)
            .is_some_and(|value| value.is_whitespace())
        {
            cursor += 1;
        }
        match characters.get(cursor) {
            Some('>') => return Some(cursor + 1),
            Some('/') if characters.get(cursor + 1) == Some(&'>') => return Some(cursor + 2),
            Some(character)
                if character.is_ascii_alphabetic() || matches!(character, '_' | ':') => {}
            _ => return None,
        }

        cursor += 1;
        while characters.get(cursor).is_some_and(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':' | '.')
        }) {
            cursor += 1;
        }
        while characters
            .get(cursor)
            .is_some_and(|value| value.is_whitespace())
        {
            cursor += 1;
        }
        if characters.get(cursor) != Some(&'=') {
            continue;
        }
        cursor += 1;
        while characters
            .get(cursor)
            .is_some_and(|value| value.is_whitespace())
        {
            cursor += 1;
        }
        match characters.get(cursor).copied() {
            Some(quote @ ('\'' | '"')) => {
                cursor += 1;
                while let Some(character) = characters.get(cursor) {
                    if *character == quote {
                        cursor += 1;
                        break;
                    }
                    cursor += 1;
                }
                if characters.get(cursor.saturating_sub(1)) != Some(&quote) {
                    return None;
                }
            }
            Some(character)
                if !character.is_whitespace()
                    && !matches!(character, '"' | '\'' | '`' | '=' | '<' | '>') =>
            {
                cursor += 1;
                while characters.get(cursor).is_some_and(|character| {
                    !character.is_whitespace()
                        && !matches!(character, '"' | '\'' | '`' | '=' | '<' | '>')
                }) {
                    cursor += 1;
                }
            }
            _ => return None,
        }
    }
}

fn contains_relaxed_share_secret(value: &str) -> bool {
    pem_secret_regex().is_match(value)
        || relaxed_bearer_secret_regex().is_match(value)
        || relaxed_jwt_secret_regex().is_match(value)
        || relaxed_provider_secret_regex().is_match(value)
}

fn contains_markdown_share_secret(value: &str) -> bool {
    let without_subtrees = strip_dangerous_markdown_subtrees(value);
    let without_shallow_subtrees = strip_shallow_dangerous_markdown_subtrees(value);
    let without_images = strip_markdown_images(value);
    [
        markdown_security_skeleton(value),
        markdown_html_stripped_skeleton(value),
        security_skeleton(&without_subtrees),
        markdown_html_stripped_skeleton(&without_subtrees),
        security_skeleton(&without_shallow_subtrees),
        markdown_html_stripped_skeleton(&without_shallow_subtrees),
        security_skeleton(&without_images),
    ]
    .iter()
    .any(|candidate| contains_relaxed_share_secret(candidate))
}

fn contains_raw_share_secret(value: &str) -> bool {
    pem_secret_regex().is_match(value)
        || bearer_secret_regex().is_match(value)
        || jwt_secret_regex().is_match(value)
        || provider_secret_regex().is_match(value)
}

fn has_share_secret(value: &str) -> bool {
    redact_share_secrets(value) != value
}

fn share_home_path_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(
            r#"(?i)(?:/(?:Users|home)/[^/\r\n<>"]+(?:/[^\r\n<>"]*)?|[A-Z]:\\Users\\[^\\\r\n<>"]+(?:\\[^\r\n<>"]*)?)"#,
        )
        .expect("valid home-path redaction regex")
    })
}

fn pem_secret_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"(?s)-----BEGIN [A-Z0-9 ]+-----.*?-----END [A-Z0-9 ]+-----")
            .expect("valid PEM redaction regex")
    })
}

fn bearer_secret_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]+=*").expect("valid bearer redaction regex")
    })
}

fn jwt_secret_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(
            r"(^|[^A-Za-z0-9_-])(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,})",
        )
        .expect("valid JWT redaction regex")
    })
}

fn provider_secret_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(
            r"(?i)(^|[^A-Za-z0-9_])((?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[a-z](?:\.xox[a-z])?-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|(?:rk|sk)_(?:live|test)_[A-Za-z0-9]{12,}))",
        )
        .expect("valid provider secret redaction regex")
    })
}

fn relaxed_provider_secret_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(
            r"(?i)(?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[a-z](?:\.xox[a-z])?-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|(?:rk|sk)_(?:live|test)_[A-Za-z0-9]{12,})",
        )
        .expect("valid relaxed provider secret redaction regex")
    })
}

fn relaxed_bearer_secret_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"(?i)Bearer\s+[A-Za-z0-9._~+/-]+=*")
            .expect("valid relaxed bearer redaction regex")
    })
}

fn relaxed_jwt_secret_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}")
            .expect("valid relaxed JWT redaction regex")
    })
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
        export_submitted_inputs, export_turn, export_view_with_assets,
        portable_interaction_input_bytes,
    };

    #[test]
    fn export_view_omits_visual_asset_associations_when_content_is_unavailable() {
        let closure: relayer_graph_core::AcceptedGraphClosure = serde_json::from_value(
            serde_json::json!({
                "nodeId": 1,
                "interaction": {"id":1,"kind":"user-interaction","icon":"user","title":"Show","detail":"Show","state":"accepted"},
                "rootAction": {"id":1,"sourceNodeId":1,"kind":"navigate","relation":"expand","label":"Response","variant":"pill","targetLayerId":1,"state":"accepted"},
                "rootLayerId": 1,
                "layers": [{
                    "layer": {"id":1,"nodes":[2],"edges":[],"state":"accepted"},
                    "nodes": [{
                        "id":2,"kind":"concept","icon":"box","title":"Image","detail":"Fallback","state":"accepted",
                        "authoredDetail": {"version":1,"components":[],"mounts":[],"assets":[{"id":"image","digestSha256":"ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb","mediaType":"image/png","representation":"image"}],"integritySha256":"b".repeat(64)}
                    }],
                    "edges": [],
                    "actions": []
                }]
            }),
        )
        .unwrap();
        let view = export_view_with_assets(
            &closure,
            &mut PortableIds::default(),
            &ProjectPathRedactor::new(None),
            &Default::default(),
        )
        .unwrap();

        assert!(view.layers[0].nodes[0].authored_detail.is_some());
        assert!(view.layers[0].nodes[0].authored_detail_assets.is_empty());

        let mut private_keys = closure.clone();
        let key = "sk-proj-12345678901234567890 /Users/alice/private";
        private_keys.root_action.client_key = Some(key.into());
        private_keys.layers[0].layer.client_key = Some(key.into());
        private_keys.layers[0].nodes[0].client_key = Some(key.into());
        let public = super::export_view(
            &private_keys,
            &mut PortableIds::default(),
            &ProjectPathRedactor::for_share(None),
        )
        .unwrap();
        assert_eq!(
            public.root_action.client_key.as_deref(),
            Some(public.root_action.id.as_str())
        );
        assert_eq!(
            public.layers[0].layer.client_key.as_deref(),
            Some(public.layers[0].layer.id.as_str())
        );
        assert_eq!(
            public.layers[0].nodes[0].client_key.as_deref(),
            Some(public.layers[0].nodes[0].id.as_str())
        );
        assert!(!serde_json::to_string(&public).unwrap().contains(key));
    }
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

    #[tokio::test]
    async fn export_fetches_shared_digest_once_and_checks_each_node_metadata() {
        use serde_json::json;
        use std::sync::{
            Arc,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        };
        let changed = Arc::new(AtomicBool::new(false));
        let changed_server = changed.clone();
        let requests = Arc::new(AtomicUsize::new(0));
        let counted = requests.clone();
        let denied = Arc::new(AtomicBool::new(false));
        let deny = denied.clone();
        let metadata_requests = Arc::new(AtomicUsize::new(0));
        let metadata_counted = metadata_requests.clone();
        let missing = Arc::new(AtomicBool::new(false));
        let missing_metadata = missing.clone();
        let large = Arc::new(AtomicBool::new(false));
        let large_metadata = large.clone();
        let app = axum::Router::new().route("/api/control/interactions/9/layers/1/owner", axum::routing::get(|| async { axum::Json(json!({"layerId":1,"ownerInteractionNodeId":1})) })).route("/api/control/temporal-features", axum::routing::get(|| async { axum::Json(json!({"configVersion":1,"schemaRead":true,"rootCurrentWrite":true,"projectionUi":true,"invokeResolution":true,"providerRecursion":true})) })).route("/api/control/interaction-features", axum::routing::get(|| async { axum::Json(json!({"interactionGraph":false})) })).fallback(move |request: axum::extract::Request| {
            let counted = counted.clone();
            let changed_server = changed_server.clone();
            let deny = deny.clone();
            let metadata_counted = metadata_counted.clone();
            let missing_metadata = missing_metadata.clone();
            let large_metadata = large_metadata.clone();
            async move {
                assert!(request.uri().query().is_some_and(|query| query.contains("expectedRevision=")));
                if changed_server.swap(false, Ordering::SeqCst) {
                    return (axum::http::StatusCode::UNPROCESSABLE_ENTITY, axum::Json(json!({"error":{"code":"asset_snapshot_changed"}})));
                }
                if missing_metadata.load(Ordering::SeqCst) {
                    return (axum::http::StatusCode::NOT_FOUND, axum::Json(json!({"error":"missing"})));
                }
                if deny.load(Ordering::SeqCst) && request.uri().path().contains("/3/") {
                    return (axum::http::StatusCode::FORBIDDEN, axum::Json(json!({"error":"denied"})));
                }
                let metadata_only = request.uri().query().is_some_and(|query| query.split('&').any(|pair| pair == "metadataOnly=true"));
                if !metadata_only { counted.fetch_add(1, Ordering::SeqCst); } else { metadata_counted.fetch_add(1, Ordering::SeqCst); }
                let name = if request.uri().path().contains("/3/") { "   " } else { "a.png" };
                let mut value = json!({"digestSha256":"ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb","mediaType":"image/png","byteLength":1,"provenance":{"source":"user","fileName":name}});
                if !metadata_only { value["contentBase64"] = json!("YQ=="); }
                if large_metadata.load(Ordering::SeqCst) {
                    value["byteLength"] = json!(8 * 1024 * 1024);
                    if request.uri().path().contains("/3/") { value["digestSha256"] = json!("d".repeat(64)); }
                    if !metadata_only { value["contentBase64"] = json!("A".repeat(11_184_810) + "A="); }
                }
                (axum::http::StatusCode::OK, axum::Json(value))
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let directory = tempfile::tempdir().unwrap();
        let catalog = directory.path().join("catalog.json");
        std::fs::write(&catalog, json!({"schemaVersion":1,"configurations":[{"configuration":{"schemaVersion":1,"name":"test","implementation":"test","implementationVersion":1,"permissionBindings":{"auto":{}},"settings":{}},"digest":"sha256:test"}]}).to_string()).unwrap();
        let runtime = crate::runtime::RuntimeClient::open(
            &format!("http://{address}/"),
            "http://127.0.0.1:9/",
            "control".into(),
            "harness".into(),
            &catalog,
        )
        .await
        .unwrap();
        let node = json!({"id":2,"kind":"concept","icon":"box","title":"Image","detail":"Fallback","state":"accepted","authoredDetail":{"version":1,"components":[],"mounts":[],"assets":[{"id":"image","digestSha256":"ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb","mediaType":"image/png","representation":"image"}],"integritySha256":"b".repeat(64)}});
        let closure: relayer_graph_core::AcceptedGraphClosure = serde_json::from_value(json!({"detailAssetRevisions":{"2":0,"3":0},"nodeId":1,"interaction":{"id":1,"kind":"user-interaction","icon":"user","title":"Show","detail":"Show","state":"accepted"},"rootAction":{"id":1,"sourceNodeId":1,"kind":"navigate","relation":"expand","label":"Response","variant":"pill","targetLayerId":1,"state":"accepted"},"rootLayerId":1,"layers":[{"layer":{"id":1,"nodes":[2],"edges":[],"state":"accepted"},"nodes":[node],"edges":[],"actions":[]}]})).unwrap();
        let mut other = closure.clone();
        other.layers[0].nodes[0].id = relayer_graph_core::NodeId::new(3).unwrap();
        other.layers[0].layer.nodes = vec![relayer_graph_core::NodeId::new(3).unwrap()];
        let closures = [Some(closure.clone()), Some(closure), Some(other)];
        let (associations, content) = super::collect_visual_assets(
            &runtime,
            closures.iter().flatten(),
            &ProjectPathRedactor::new(None),
        )
        .await
        .unwrap();
        assert_eq!(associations.len(), 2);
        assert_eq!(content.len(), 1);
        assert_eq!(associations[&2][0].provenance.file_name, "a.png");
        assert_eq!(associations[&3][0].provenance.file_name, "asset");
        assert_eq!(
            requests.load(Ordering::SeqCst),
            1,
            "shared digests must be fetched once across distinct accepted nodes"
        );
        assert_eq!(metadata_requests.load(Ordering::SeqCst), 2);
        // Image icons carry bytes independently of an authored Detail package.
        let pinned_icon = json!({"kind":"image","assetId":"image","fit":"contain","framing":"none","digestSha256":"ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb","mediaType":"image/png"}).to_string();
        for mode in 0..3 {
            let action_only = mode == 1;
            let root_only = mode == 2;
            let mut image_closure = closures[0].as_ref().unwrap().clone();
            image_closure.layers[0].nodes[0].authored_detail = None;
            if root_only {
                image_closure.root_action.icon = Some(pinned_icon.clone());
                image_closure
                    .detail_asset_revisions
                    .as_mut()
                    .unwrap()
                    .insert(image_closure.interaction.id, 0);
            } else if action_only {
                let mut action = image_closure.root_action.clone();
                action.id = ActionId::new(22).unwrap();
                action.source_node_id = image_closure.layers[0].nodes[0].id;
                action.icon = Some(pinned_icon.clone());
                image_closure.layers[0].actions.push(action);
            } else {
                image_closure.layers[0].nodes[0].icon = pinned_icon.clone();
            }
            for redactor in [
                ProjectPathRedactor::new(None),
                ProjectPathRedactor::for_share(None),
            ] {
                let (icon_associations, icon_contents) =
                    super::collect_visual_assets(&runtime, [&image_closure], &redactor)
                        .await
                        .unwrap();
                assert_eq!(icon_contents.len(), 1);
                assert_eq!(
                    icon_associations[&if root_only { 1 } else { 2 }][0].asset_id,
                    "image"
                );
                let view = export_view_with_assets(
                    &image_closure,
                    &mut PortableIds::default(),
                    &redactor,
                    &icon_associations,
                )
                .unwrap();
                let wire = serde_json::to_value(&view).unwrap();
                let wire_icon = if root_only {
                    assert_eq!(wire["rootAction"]["iconAsset"]["assetId"], "image");
                    &wire["rootAction"]["icon"]
                } else if action_only {
                    &wire["layers"][0]["actions"][0]["icon"]
                } else {
                    &wire["layers"][0]["nodes"][0]["icon"]
                };
                assert_eq!(wire_icon["kind"], "image");
                assert_eq!(
                    wire_icon["digestSha256"],
                    "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb"
                );
                let reopened: crate::conversation_export::ExportAcceptedView =
                    serde_json::from_value(wire).unwrap();
                assert_eq!(reopened, view);
            }
            // Missing accepted icon bytes cannot take the legacy Detail omission route.
            missing.store(true, Ordering::SeqCst);
            assert!(
                super::collect_visual_assets(
                    &runtime,
                    [&image_closure],
                    &ProjectPathRedactor::new(None)
                )
                .await
                .is_err()
            );
            missing.store(false, Ordering::SeqCst);
        }

        let mut external_context_target = closures[0].as_ref().unwrap().layers[0].nodes[0].clone();
        external_context_target.id = NodeId::new(3).unwrap();
        external_context_target.authored_detail = None;
        external_context_target.icon = pinned_icon.clone();
        let (context_assets, context_content) = super::collect_visual_assets_with_context_icons(
            &runtime,
            [closures[0].as_ref().unwrap()],
            &ProjectPathRedactor::for_share(None),
            true,
            &[external_context_target],
        )
        .await
        .unwrap();
        assert_eq!(
            context_assets[&3][0].asset_id, "image",
            "an external context image target needs bytes even outside all exported layers"
        );
        assert_eq!(context_content.len(), 1);
        denied.store(true, Ordering::SeqCst);
        assert!(
            super::collect_visual_assets(
                &runtime,
                closures.iter().flatten(),
                &ProjectPathRedactor::new(None),
            )
            .await
            .is_err(),
            "a cached digest cannot bypass another node's rejected metadata read"
        );
        denied.store(false, Ordering::SeqCst);
        let mut sensitive = closures[0].as_ref().unwrap().clone();
        sensitive.layers[0].nodes[0]
            .authored_detail
            .as_mut()
            .unwrap()["components"] = json!([{"id":"secret","order":0,"html":"<span>sk-proj-1234</span><span>5678901234567890</span>","css":""}]);
        let (sensitive_associations, sensitive_content) = super::collect_visual_assets(
            &runtime,
            [&sensitive],
            &ProjectPathRedactor::for_share(None),
        )
        .await
        .unwrap();
        assert!(
            sensitive_associations.is_empty(),
            "assets for a share-authored detail omitted as sensitive must not be associated"
        );
        assert!(
            sensitive_content.is_empty(),
            "assets for an omitted detail must not become unreachable content records"
        );
        let sensitive_view = export_view_with_assets(
            &sensitive,
            &mut PortableIds::default(),
            &ProjectPathRedactor::for_share(None),
            &sensitive_associations,
        )
        .unwrap();
        let sensitive_node = &sensitive_view.layers[0].nodes[0];
        assert!(sensitive_node.authored_detail.is_none());
        assert_eq!(
            sensitive_node.authored_detail_omitted,
            Some(ExportAuthoredDetailOmission::SensitiveData)
        );
        assert!(sensitive_node.authored_detail_assets.is_empty());

        // Owner-only V3: no conversion or persistent mutation can independently
        // enable strict asset reads. Resolve ownership through the real client.
        let owner = Interaction {
            stop_requested: false,
            stop_error: None,
            id: InteractionId::from_database(1),
            thread_id: ThreadId::from_database(1),
            sequence: 1,
            text: "Source".into(),
            created_at: "1".into(),
            graph_node_id: Some(1),
            completion_status: "accepted".into(),
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
        let mut consumer = owner.clone();
        consumer.id = InteractionId::from_database(2);
        consumer.graph_node_id = Some(9);
        consumer.sequence = 2;
        let owner_closure = closures[0].as_ref().unwrap();
        assert!(!super::needs_current_snapshot(owner_closure));
        let context = ContextInput::Runtime(RuntimeContextInput {
            input: InteractionInput {
                interaction_permissions: None,
                interaction: InteractionInputNode::from(owner_closure.interaction.clone()),
                contexts: vec![],
                submitted_inputs: vec![],
            },
            actions: vec![InteractionContextAction {
                id: ActionId::new(90).unwrap(),
                type_id: "interaction.context".into(),
                source_node_id: NodeId::new(9).unwrap(),
                target: InteractionContextTarget {
                    node_id: NodeId::new(2).unwrap(),
                    source_interaction_node_id: NodeId::new(99).unwrap(),
                    source_layer_id: LayerId::new(1).unwrap(),
                },
                annotations: vec![],
                state: RecordState::Accepted,
            }],
        });
        let owners = super::collect_context_owners(
            &runtime,
            vec![(&owner, owner_closure)],
            vec![(&consumer, &context)],
            &std::collections::HashMap::from([(owner.id, 1), (consumer.id, 2)]),
        )
        .await
        .unwrap();
        assert_eq!(owners.get(&90).map(String::as_str), Some("turn:1"));
        missing.store(true, Ordering::SeqCst);
        assert!(matches!(super::collect_visual_assets_for_snapshot(
            &runtime, [owner_closure], &ProjectPathRedactor::new(None), !owners.is_empty(),
        ).await, Err(super::ConversationExportBuildError::Invalid(message))
            if message == "snapshot visual asset metadata is unavailable"));
        let (legacy_associations, legacy_contents) = super::collect_visual_assets(
            &runtime,
            closures.iter().flatten(),
            &ProjectPathRedactor::new(None),
        )
        .await
        .unwrap();
        assert!(legacy_associations.is_empty());
        assert!(legacy_contents.is_empty());
        assert!(matches!(super::collect_visual_assets(
            &runtime, closures.iter().flatten(), &ProjectPathRedactor::for_share(None),
        ).await, Err(super::ConversationExportBuildError::Invalid(message))
            if message == "public visual asset metadata is unavailable"));

        assert!(matches!(super::collect_visual_assets_for_snapshot(
            &runtime, closures.iter().flatten(), &ProjectPathRedactor::new(None), true,
        ).await, Err(super::ConversationExportBuildError::Invalid(message))
            if message == "snapshot visual asset metadata is unavailable"));

        let mut current_snapshot = closures[0].as_ref().unwrap().clone();
        current_snapshot.has_persistent_mutations = true;
        assert!(matches!(super::collect_visual_assets(
            &runtime, [&current_snapshot], &ProjectPathRedactor::new(None),
        ).await, Err(super::ConversationExportBuildError::Invalid(message))
            if message == "snapshot visual asset metadata is unavailable"));

        missing.store(false, Ordering::SeqCst);
        large.store(true, Ordering::SeqCst);
        requests.store(0, Ordering::SeqCst);
        let mut large_closures = closures.clone();
        large_closures[2].as_mut().unwrap().layers[0].nodes[0]
            .authored_detail
            .as_mut()
            .unwrap()["assets"][0]["digestSha256"] = json!("d".repeat(64));
        assert!(matches!(
            super::collect_visual_assets(
                &runtime,
                large_closures.iter().flatten(),
                &ProjectPathRedactor::for_share(None),
            )
            .await,
            Err(super::ConversationExportBuildError::ShareSnapshotTooLarge { .. })
        ));
        assert_eq!(
            requests.load(Ordering::SeqCst),
            1,
            "reject the second 8 MiB asset from metadata before fetching its body"
        );
        large.store(false, Ordering::SeqCst);
        changed.store(true, Ordering::SeqCst);
        let captures = AtomicUsize::new(0);
        let retry_redactor = ProjectPathRedactor::new(None);
        let retry = super::capture_snapshot_with_retry(|| {
            captures.fetch_add(1, Ordering::SeqCst);
            super::collect_visual_assets_for_snapshot(
                &runtime,
                closures.iter().flatten(),
                &retry_redactor,
                true,
            )
        })
        .await
        .unwrap();
        assert_eq!(
            captures.load(Ordering::SeqCst),
            2,
            "a stale read repeats the whole capture"
        );
        assert_eq!(retry.1.len(), 1);
        captures.store(0, Ordering::SeqCst);
        let exhausted = super::capture_snapshot_with_retry(|| {
            captures.fetch_add(1, Ordering::SeqCst);
            changed.store(true, Ordering::SeqCst);
            super::collect_visual_assets_for_snapshot(
                &runtime,
                closures.iter().flatten(),
                &retry_redactor,
                true,
            )
        })
        .await;
        assert!(matches!(
            exhausted,
            Err(super::ConversationExportBuildError::Runtime(
                crate::runtime::RuntimeError::Remote { status: 422, .. }
            ))
        ));
        assert_eq!(
            captures.load(Ordering::SeqCst),
            3,
            "continuous mutation stays bounded"
        );
        server.abort();
    }

    #[tokio::test]
    async fn export_builders_recapture_graph_after_asset_revision_conflict() {
        use base64::Engine as _;
        use serde_json::json;
        use sha2::{Digest, Sha256};
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("product.sqlite3");
        let product = crate::product::ProductService::new(
            crate::storage::SqliteProductStore::open(&database)
                .await
                .unwrap(),
            true,
        );
        let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}", database.display()))
            .await
            .unwrap();
        sqlx::query("INSERT INTO threads(id,title,created_at,updated_at,harness_configuration_name,permission_profile_id) VALUES(1,'Snapshot','1','1','test','auto')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO interactions(id,thread_id,sequence,text,created_at,graph_node_id,completion_status,harness_configuration_name,permission_profile_id) VALUES(1,1,1,'Show image','1',1,'accepted','test','auto')").execute(&pool).await.unwrap();
        pool.close().await;
        let interaction = json!({"id":1,"kind":"user-interaction","icon":"user","title":"Show image","detail":"Show image","state":"accepted"});
        let mut snapshots = Vec::new();
        let mut payloads = Vec::new();
        for (revision, label) in ["before-race", "after-race"].into_iter().enumerate() {
            let bytes = label.as_bytes();
            let digest = format!("{:x}", Sha256::digest(bytes));
            let mut package = json!({"version":1,"assets":[{"id":"image","digestSha256":digest,"mediaType":"image/png","representation":"image"}],
                "components":[{"id":"main","order":0,"html":format!("<p>{label}</p><img data-asset-mount=\"image-mount\">"),"css":""}],
                "mounts":[{"id":"image-mount","componentId":"main","kind":"asset","host":"img","assetId":"image"}]});
            package["integritySha256"] = format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&package).unwrap())
            )
            .into();
            snapshots.push(json!({"nodeId":1,"hasPersistentMutations":true,"detailAssetRevisions":{"2":revision},"interaction":interaction,
                "rootAction":{"id":1,"sourceNodeId":1,"kind":"navigate","relation":"expand","label":"Response","variant":"pill","targetLayerId":1,"state":"accepted"},"rootLayerId":1,
                "layers":[{"layer":{"id":1,"nodes":[2],"edges":[],"state":"accepted"},"nodes":[{"id":2,"kind":"concept","icon":"image","title":label,"detail":label,"state":"accepted","authoredDetail":package}],"edges":[],"actions":[]}]}));
            payloads.push(json!({"assetId":"image","digestSha256":digest,"mediaType":"image/png","byteLength":bytes.len(),"provenance":{"source":"user","fileName":"image.png"},"contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes)}));
        }
        let phase = Arc::new(AtomicUsize::new(0));
        let captures = Arc::new(AtomicUsize::new(0));
        let handler_phase = phase.clone();
        let handler_captures = captures.clone();
        let app = axum::Router::new().fallback(move |request: axum::extract::Request| {
            let phase = handler_phase.clone();
            let captures = handler_captures.clone();
            let snapshots = snapshots.clone();
            let payloads = payloads.clone();
            let interaction = interaction.clone();
            async move {
                assert_eq!(request.headers()["authorization"], "Bearer control");
                let value = match request.uri().path() {
                    "/api/control/temporal-features" => json!({"configVersion":1,"schemaRead":true,"rootCurrentWrite":true,"projectionUi":true,"invokeResolution":true,"providerRecursion":true}),
                    "/api/control/interaction-features" => json!({"interactionGraph":false}),
                    "/api/control/accepted-closures" => {
                        captures.fetch_add(1, Ordering::SeqCst);
                        json!({"closures":[snapshots[phase.load(Ordering::SeqCst)]]})
                    }
                    "/api/control/interactions/1/input" => {
                        json!({"interaction":interaction,"contexts":[]})
                    }
                    "/api/control/interactions/1/context-actions" => json!({"actions":[]}),
                    "/api/control/nodes/2/detail-assets/image" => {
                        let query = request.uri().query().unwrap();
                        if phase.swap(1, Ordering::SeqCst) == 0 {
                            assert!(query.contains("expectedRevision=0"));
                            return (
                                axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                                axum::Json(json!({"error":{"code":"asset_snapshot_changed"}})),
                            );
                        }
                        assert!(
                            query.contains("expectedRevision=1"),
                            "retry reused the old graph snapshot"
                        );
                        let mut payload = payloads[1].clone();
                        if query.contains("metadataOnly=true") {
                            payload.as_object_mut().unwrap().remove("contentBase64");
                        }
                        payload
                    }
                    other => panic!("unexpected runtime route {other}"),
                };
                (axum::http::StatusCode::OK, axum::Json(value))
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let catalog = directory.path().join("catalog.json");
        std::fs::write(&catalog, json!({"schemaVersion":1,"configurations":[{"configuration":{"schemaVersion":1,"name":"test","implementation":"test","implementationVersion":1,"permissionBindings":{"auto":{}},"settings":{}},"digest":"sha256:test"}]}).to_string()).unwrap();
        let runtime = crate::runtime::RuntimeClient::open(
            &format!("http://{address}/"),
            "http://127.0.0.1:9/",
            "control".into(),
            "harness".into(),
            &catalog,
        )
        .await
        .unwrap();
        for shared in [false, true] {
            phase.store(0, Ordering::SeqCst);
            captures.store(0, Ordering::SeqCst);
            let producer = crate::conversation_export::ExportProducer {
                desktop_version: "test".into(),
                build_commit: "test".into(),
                platform: "test".into(),
                architecture: "test".into(),
            };
            let bytes = if shared {
                super::build_share_conversation_export(
                    &product,
                    &runtime,
                    ThreadId::from_database(1),
                    producer,
                    "2".into(),
                    "Snapshot",
                )
                .await
            } else {
                super::build_conversation_export(
                    &product,
                    &runtime,
                    ThreadId::from_database(1),
                    producer,
                    "2".into(),
                )
                .await
            }
            .unwrap();
            assert_eq!(
                captures.load(Ordering::SeqCst),
                2,
                "both builders must recapture every root"
            );
            let records = crate::conversation_export::decode_export_jsonl(&bytes).unwrap();
            let text = String::from_utf8(bytes).unwrap();
            assert!(text.contains("after-race"));
            assert!(!text.contains("before-race"));
            assert!(records.iter().any(|record| matches!(record, crate::conversation_export::ConversationExportRecord::VisualAssetContent(asset)
                if asset.content_base64 == base64::engine::general_purpose::STANDARD.encode(b"after-race"))));
            assert!(
                !text.contains(&base64::engine::general_purpose::STANDARD.encode(b"before-race"))
            );
        }
        server.abort();
    }

    #[test]
    fn persistent_mutation_closures_require_current_snapshot_format() {
        let mut closure: relayer_graph_core::AcceptedGraphClosure = serde_json::from_value(serde_json::json!({
            "nodeId":1,"interaction":{"id":1,"kind":"user-interaction","icon":"user","title":"Question","detail":"Question","state":"accepted"},
            "rootAction":{"id":1,"sourceNodeId":1,"kind":"navigate","relation":"expand","label":"Response","variant":"pill","targetLayerId":1,"state":"accepted"},
            "rootLayerId":1,"layers":[]
        })).unwrap();
        assert!(!super::needs_current_snapshot(&closure));
        closure.has_persistent_mutations = true;
        assert!(super::needs_current_snapshot(&closure));
    }

    #[test]
    fn export_asset_filename_fallback_matches_archive_string_bounds() {
        let redactor = ProjectPathRedactor::new(None);
        for name in [
            String::new(),
            " \t\n".into(),
            "x".repeat(crate::conversation_export::MAX_STRING_BYTES + 1),
        ] {
            assert_eq!(super::portable_asset_filename(&name, &redactor), "asset");
        }
        assert_eq!(
            super::portable_asset_filename("kept.svg", &redactor),
            "kept.svg"
        );
    }

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
            artifact: None,
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
            artifact: None,
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
            artifact: None,
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
    fn share_redaction_scrubs_provider_keys_pem_blocks_jwts_and_bearer_values() {
        let redactor = ProjectPathRedactor::for_share(Some("/Users/x"));
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature-value";
        let value = format!(
            "sk-proj-12345678901234567890 {jwt} Bearer abc.def.ghi\n-----BEGIN PRIVATE KEY-----\nsecret bytes\n-----END PRIVATE KEY-----"
        );
        let redacted = redactor.text(&value);
        assert!(!redacted.contains("sk-proj-12345678901234567890"));
        assert!(!redacted.contains(jwt));
        assert!(!redacted.contains("secret bytes"));
        // The renderer-aware safety pass may conservatively collapse the whole
        // public field once several secret syntaxes are interleaved.
        assert!(redacted.contains("[redacted-secret]"));
        let adjacent = redactor.text("sk-proj-12345678901234567890 sk-proj-09876543210987654321");
        assert_eq!(adjacent.matches("[redacted-secret]").count(), 2);
        assert!(!adjacent.contains("sk-proj-"));
        let adjacent_jwts = redactor.text(&format!("{jwt} {jwt}"));
        assert_eq!(adjacent_jwts.matches("[redacted-secret]").count(), 2);
        assert!(!adjacent_jwts.contains("eyJ"));
    }

    #[test]
    fn share_redaction_scrubs_home_paths_without_a_selected_project() {
        let redactor = ProjectPathRedactor::for_share(None);
        for value in [
            "/Users/alice/.ssh/config",
            "/home/alice/.config/relayer",
            r"C:\Users\alice\AppData\Local\Relayer",
            "%2FUsers%2Falice%2Fsecret.txt",
            "/Users/alice/My Secret/password.txt",
            "/Users/alice/Bob's Secret/password.txt",
            "/Users/alice/`private backup`/password.txt",
            "/home/alice/My Secret/password.txt",
            "/home/alice/Bob's Secret/password.txt",
            "/home/alice/`private backup`/password.txt",
            r"C:\Users\Alice Smith\My Secret\password.txt",
            r"C:\Users\alice\Bob's Secret\password.txt",
            r"C:\Users\alice\`private backup`\password.txt",
        ] {
            let redacted = redactor.text(value);
            assert!(!redacted.contains("alice"), "{value} -> {redacted}");
            assert!(!redacted.contains("Secret"), "{value} -> {redacted}");
            assert!(
                !redacted.contains("private backup"),
                "{value} -> {redacted}"
            );
            assert!(!redacted.contains("password.txt"), "{value} -> {redacted}");
        }
        assert!(redactor.contains_private_path_json(&serde_json::json!({
            "a": "/Users/ali",
            "b": "ce/.ssh/config"
        })));
    }

    #[test]
    fn share_markdown_redaction_detects_credentials_exposed_by_rendering() {
        let redactor = ProjectPathRedactor::for_share(None);
        for secret in [
            "sk-proj-12345&#54;78901234567890",
            "sk-proj-12345&amp;#54;78901234567890",
            "sk-proj-12345%3678901234567890",
            "sk-proj-12345\u{200b}678901234567890",
            "sk-proj-12345**6**78901234567890",
            "sk-proj-12345<em>6</em>78901234567890",
            "sk-proj-12345[6](https://example.test)78901234567890",
            "sk-proj-12345<span title=\"&gt;\">6</span>78901234567890",
            "sk-proj-12345<span title=\">\">6</span>78901234567890",
            "s[k][x]-proj-12345678901234567890\n\n[x]: https://example.test",
            "s<!-- > -->k-proj-12345678901234567890",
            "[note]: nope s**k**-proj-12345678901234567890",
            "a < s**k**-proj-12345678901234567890",
            "a < s**k**-proj-12345678901234567890 >",
            "a < s<em>k</em>-proj-12345678901234567890 >",
            "<s<em>k</em>-proj-12345678901234567890>",
            "<s<!-- > -->k-proj-12345678901234567890>",
            "<s[k](https://example.test)-proj-12345678901234567890>",
            "<x s[k](https://example.test)-proj-12345678901234567890>",
            "<x s`k`-proj-12345678901234567890 >",
            "a < s[k](https://example.test)-proj-12345678901234567890 >",
            "[label](s**k**-proj-12345678901234567890",
            "[label](s<em>k</em>-proj-12345678901234567890",
            "[label][s**k**-proj-12345678901234567890",
            "[label][s**k**-proj-12345678901234567890]",
            "[label][s<em>k</em>-proj-12345678901234567890]",
            "[label][s<!-- > -->k-proj-12345678901234567890]",
            "[label](s<em>k</em>-proj-12345678901234567890 extra)",
            "s<span title=\"<\">k</span>-proj-12345678901234567890",
            "s<em title='x<y'>k</em>-proj-12345678901234567890",
            "s<?test?>k-proj-12345678901234567890",
            "s<!DOCTYPE html>k-proj-12345678901234567890",
            "s<!doctype html>k-proj-12345678901234567890",
            "s<![CDATA[hidden]]>k-proj-12345678901234567890",
            "s<!DOCTYPE \"unterminated>k-proj-12345678901234567890",
            "s<script>hidden</script>k-proj-12345678901234567890",
            "s<style>hidden</style>k-proj-12345678901234567890",
            "s<template>hidden</template>k-proj-12345678901234567890",
            "s<svg>hidden</svg>k-proj-12345678901234567890",
            "s![alt](https://example.test/img.png)k-proj-12345678901234567890",
            "<x s<script>hidden</script>k-proj-12345678901234567890>",
            "<x s![alt](https://example.test/img.png)k-proj-12345678901234567890>",
            "s<template>a<template>b</template>c</template>k-proj-12345678901234567890",
            "s<script>a</script>k-proj-12345678901234567890<script>b</script>",
            "s<template>a</template>k-proj-12345678901234567890<template>b</template>",
            "s<script>a</script><em>k</em>-proj-12345678901234567890<script>b</script>",
            "s![alt]k-proj-12345678901234567890\n\n[alt]: https://example.test/image.png",
            "a < B**earer** abc.def.ghi >",
            "a < e**yJ**hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.synthetic_signature >",
            "[label](e**yJ**hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.synthetic_signature",
        ] {
            let mut node = authored_node(serde_json::json!({}));
            node.authored_detail = None;
            node.detail = format!("Credential: {secret}");
            let exported = export_node(&node, &mut PortableIds::default(), &redactor).unwrap();
            assert!(!exported.detail.contains("sk-proj-"), "{secret}");
            assert!(exported.detail.contains("[redacted-secret]"), "{secret}");
        }
        let safe = "Q&amp;A [docs](https://example.test/?q=a%20b)";
        assert_eq!(redactor.text(safe), safe);
    }

    #[test]
    fn share_markdown_redaction_detects_private_paths_exposed_by_rendering() {
        let home_redactor = ProjectPathRedactor::for_share(None);
        assert_eq!(
            home_redactor.text("/Us**ers**/alice/.ssh/id_rsa"),
            "[project-path]"
        );
        assert_eq!(
            home_redactor.text("/Us**ers**/alice/.ssh/id_rsa /Us%65rs/bob/file"),
            "[project-path]"
        );

        let project_redactor = ProjectPathRedactor::for_share(Some("/opt/relayer-private"));
        assert_eq!(
            project_redactor.text("/opt/relayer-**private**/secret"),
            "[project-path]"
        );
        assert_eq!(
            home_redactor.text("a < /Us**ers**/alice/secret >"),
            "[project-path]"
        );
        let unicode_redactor = ProjectPathRedactor::for_share(Some("/opt/café"));
        assert_eq!(
            unicode_redactor.text("a < /opt/ca**fé**/secret >"),
            "[project-path]"
        );
        let punctuation_redactor = ProjectPathRedactor::for_share(Some("/opt/secret-project@prod"));
        assert_eq!(
            punctuation_redactor.text("a < /opt/secret-**project**@prod/file >"),
            "[project-path]"
        );
    }

    #[test]
    fn share_authored_detail_omits_sensitive_fragmented_rich_detail() {
        let package = serde_json::json!({
            "version": 1,
            "components": [{
                "id": "summary",
                "order": 0,
                "html": "<p><span>sk-proj-1234</span><span>5678901234567890</span></p>",
                "css": ""
            }],
            "mounts": [],
            "assets": [],
            "integritySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        });
        let exported = export_node(
            &authored_node(package),
            &mut PortableIds::default(),
            &ProjectPathRedactor::for_share(Some("/Users/x")),
        )
        .unwrap();

        assert!(exported.authored_detail.is_none());
        assert_eq!(
            exported.authored_detail_omitted,
            Some(ExportAuthoredDetailOmission::SensitiveData)
        );
        assert_eq!(exported.detail, "Portable fallback");
    }

    #[test]
    fn share_authored_detail_omits_project_path_reassembled_by_rendered_text() {
        let package = serde_json::json!({
            "version": 1,
            "components": [{
                "id": "summary",
                "order": 0,
                "html": "<p>/opt/relayer-<strong>private</strong>/secrets</p>",
                "css": ""
            }],
            "mounts": [],
            "assets": [],
            "integritySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        });
        let exported = export_node(
            &authored_node(package),
            &mut PortableIds::default(),
            &ProjectPathRedactor::for_share(Some("/opt/relayer-private")),
        )
        .unwrap();

        assert!(exported.authored_detail.is_none());
        assert_eq!(
            exported.authored_detail_omitted,
            Some(ExportAuthoredDetailOmission::PrivatePath)
        );
        assert_eq!(exported.detail, "Portable fallback");
    }

    #[test]
    fn share_selection_preserves_invocation_ancestry_while_parent_is_pending() {
        let interaction = |id, status: &str| Interaction {
            id: InteractionId::from_database(id),
            thread_id: ThreadId::from_database(1),
            sequence: id,
            text: format!("Turn {id}"),
            created_at: "2026-01-01T00:00:00Z".into(),
            graph_node_id: Some(id),
            completion_status: status.into(),
            harness_configuration_name: None,
            harness_configuration_digest: None,
            permission_profile_id: "auto".into(),
            model_selection: None,
            effective_execution_digest: None,
            effective_permission_receipt: None,
            completion_output: None,
            completion_error: None,
            stop_requested: false,
            stop_error: None,
            latest_attempt: None,
        };
        let invoke = |source, result| ActionInvocation {
            source_interaction_id: InteractionId::from_database(source),
            action_id: result,
            result_interaction_id: InteractionId::from_database(result),
            result_completion_status: "accepted".into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            agent_invoked: false,
        };
        let mut interactions = vec![
            interaction(1, "accepted"),
            interaction(2, "running"),
            interaction(3, "accepted"),
            interaction(4, "accepted"),
            interaction(5, "accepted"),
        ];
        let invocations = vec![invoke(2, 3), invoke(3, 4), invoke(1, 5)];
        let selected = super::share_accepted_interactions(&interactions, &invocations);
        assert_eq!(
            selected
                .iter()
                .map(|turn| turn.sequence)
                .collect::<Vec<_>>(),
            vec![1, 5]
        );
        interactions[1].completion_status = "accepted".into();
        let selected = super::share_accepted_interactions(&interactions, &invocations);
        assert_eq!(
            selected
                .iter()
                .map(|turn| turn.sequence)
                .collect::<Vec<_>>(),
            vec![1, 2, 3, 4, 5]
        );
    }

    #[test]
    fn share_turn_strips_attempt_receipts_and_digests_but_keeps_public_completion_fields() {
        let interaction_id = InteractionId::from_database(7);
        let interaction = Interaction {
            id: interaction_id,
            thread_id: ThreadId::from_database(1),
            sequence: 42,
            text: "Accepted text".into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            graph_node_id: None,
            completion_status: "accepted".into(),
            harness_configuration_name: Some("codex.basic".into()),
            harness_configuration_digest: Some("harness-secret-digest".into()),
            permission_profile_id: "default".into(),
            model_selection: None,
            effective_execution_digest: Some("execution-secret-digest".into()),
            effective_permission_receipt: Some(serde_json::json!({
                "schemaVersion": 1,
                "permissionProfileId": "default",
                "label": "Workspace",
                "authority": "local",
                "reviewer": "user",
                "bindingPresent": true,
                "unconfinedHostAccess": false,
                "disclosure": "private"
            })),
            completion_output: None,
            completion_error: None,
            stop_requested: false,
            stop_error: None,
            latest_attempt: None,
        };
        let turn_sequences = [(interaction_id, 1)].into_iter().collect();
        let mut ids = PortableIds::default();
        let exported = export_turn(
            &interaction,
            TurnExportContext {
                portable_sequence: 1,
                closure: None,
                context_input: None,
                submitted_evidence: &[],
                invocation: None,
                imported: ImportedExportContext {
                    turn: None,
                    turn_sequences: &Default::default(),
                },
                turn_sequences: &turn_sequences,
                redactor: &ProjectPathRedactor::for_share(Some("/Users/x")),
                settled_attempt_outcome: None,
                authored_detail_assets: &Default::default(),
            },
            &mut ids,
        )
        .unwrap();

        assert_eq!(exported.id, "turn:1");
        assert_eq!(exported.completion.status, ExportCompletionStatus::Accepted);
        assert_eq!(
            exported.completion.harness_configuration_name.as_deref(),
            Some("codex.basic")
        );
        assert_eq!(exported.completion.permission_profile_id, "default");
        assert!(exported.completion.harness_configuration_digest.is_none());
        assert!(exported.completion.effective_execution_digest.is_none());
        assert!(exported.completion.effective_permission_receipt.is_none());
        assert!(exported.completion.attempt_admission_id.is_none());
        assert!(exported.completion.admitted_model_plan.is_none());
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
            artifact: None,
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
            artifact: None,
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
                artifact: None,
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
            stop_requested: false,
            stop_error: None,
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
            stop_requested: false,
            stop_error: None,
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
            stop_requested: false,
            stop_error: None,
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
            artifact: None,
            state: RecordState::Accepted,
            leased_action_id: None,
        };
        let target = InteractionInputNode::from(target_node.clone());
        let runtime = RuntimeContextInput {
            input: InteractionInput {
                interaction_permissions: None,
                interaction: InteractionInputNode::from(GraphNode {
                    id: NodeId::new(10).unwrap(),
                    client_key: None,
                    kind: "user-interaction".into(),
                    icon: "user".into(),
                    title: "Use context".into(),
                    detail: "Use context".into(),
                    authored_detail: None,
                    artifact: None,
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
            stop_requested: false,
            stop_error: None,
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
            converted_from_invoke: false,
            resolved_invoke_interaction_id: None,
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

        let converted = GraphAction {
            kind: ActionKind::Navigate,
            relation: Some(relayer_graph_core::NavigateRelation::Expand),
            interaction_text: None,
            converted_from_invoke: false,
            resolved_invoke_interaction_id: Some(NodeId::new(5).unwrap()),
            ..action.clone()
        };
        let portable = export_action(
            &converted,
            &mut PortableIds::default(),
            &ProjectPathRedactor::new(None),
        )
        .unwrap();
        assert!(portable.converted_from_invoke);
        assert_eq!(portable.kind, super::ExportActionKind::Navigate);
        assert_eq!(
            portable.relation,
            Some(super::ExportNavigateRelation::Expand)
        );
        assert!(portable.target_layer_id.is_some());
        assert!(portable.interaction_text.is_none());
        assert!(exported.target_layer_id.is_none());
        assert_eq!(
            exported.interaction_text.as_deref(),
            Some("Continue from here")
        );
    }

    #[test]
    fn unanswered_input_action_exports_its_authored_payload() {
        let action = GraphAction {
            converted_from_invoke: false,
            resolved_invoke_interaction_id: None,
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
            converted_from_invoke: false,
            resolved_invoke_interaction_id: None,
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
            stop_requested: false,
            stop_error: None,
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
            agent_invoked: false,
        };
        let turn_sequences = [(source_id, 1), (result_id, 2)].into_iter().collect();
        let mut ids = PortableIds::default();
        ids.action.insert(41, "action:legacy".into());

        let exported = export_turn(
            &interaction,
            TurnExportContext {
                portable_sequence: interaction.sequence,
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
                settled_attempt_outcome: None,
                authored_detail_assets: &Default::default(),
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
