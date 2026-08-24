use std::collections::HashMap;

use relayer_graph_core::{
    AcceptedGraphClosure, ActionKind, ActionVariant, GraphAction, GraphEdge, GraphNode,
    NavigateRelation, RecordState, ResolvedLayer,
};

use crate::{
    conversation_export::{
        ConversationExportHeader, ConversationExportRecord, ConversationExportTurn,
        EXPORT_VERSION_V1, ExportAcceptedView, ExportAction, ExportActionKind, ExportActionVariant,
        ExportCompletionReceipt, ExportCompletionStatus, ExportConversation, ExportEdge,
        ExportLayer, ExportModelSelection, ExportNavigateRelation, ExportNode,
        ExportPermissionReceipt, ExportProducer, ExportRecordState, ExportResolvedLayer,
        ExportTurnManifestEntry, ExportTurnOrigin, MAX_EXPORT_BYTES, MAX_JSONL_LINE_BYTES,
        validate_export_records,
    },
    product::{
        ActionInvocation, Interaction, InteractionId, ProductError, ProductService, ThreadId,
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
    let project_path = detail.project.as_ref().map(|project| project.path.as_str());
    let redactor = ProjectPathRedactor::new(project_path);
    let project_name = detail
        .project
        .as_ref()
        .map(|project| redactor.text(&project.name));
    let invocations = detail
        .action_invocations
        .iter()
        .map(|invocation| (invocation.result_interaction_id, invocation))
        .collect::<HashMap<_, _>>();
    let turn_sequences = detail
        .interactions
        .iter()
        .map(|interaction| (interaction.id, interaction.sequence))
        .collect::<HashMap<_, _>>();
    let mut ids = PortableIds::default();
    let mut closures = Vec::with_capacity(detail.interactions.len());
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
    }
    let interaction_indexes = detail
        .interactions
        .iter()
        .enumerate()
        .map(|(index, interaction)| (interaction.id, index))
        .collect::<HashMap<_, _>>();
    for invocation in &detail.action_invocations {
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
    for (interaction, closure) in detail.interactions.iter().zip(closures.iter()) {
        records.push(ConversationExportRecord::Turn(Box::new(export_turn(
            interaction,
            closure.as_ref(),
            invocations.get(&interaction.id).copied(),
            &turn_sequences,
            &mut ids,
            &redactor,
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

fn export_turn(
    interaction: &Interaction,
    closure: Option<&AcceptedGraphClosure>,
    invocation: Option<&ActionInvocation>,
    turn_sequences: &HashMap<InteractionId, i64>,
    ids: &mut PortableIds,
    redactor: &ProjectPathRedactor,
) -> Result<ConversationExportTurn, ConversationExportBuildError> {
    let accepted_view = closure
        .map(|closure| export_view(closure, ids, redactor))
        .transpose()?;
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
        None => ExportTurnOrigin::User,
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
    Ok(ConversationExportTurn {
        id: turn_id(interaction.sequence),
        sequence: sequence(interaction.sequence)?,
        created_at: interaction.created_at.clone(),
        text: redactor.text(&interaction.text),
        origin,
        completion: ExportCompletionReceipt {
            status,
            harness_configuration_name: interaction.harness_configuration_name.clone(),
            harness_configuration_digest: interaction.harness_configuration_digest.clone(),
            model_selection: interaction.model_selection.as_ref().map(|selection| {
                ExportModelSelection {
                    provider_id: selection.provider_id.as_str().into(),
                    model_id: selection.model_id.clone(),
                    model_family_id: selection.family_id.value(),
                }
            }),
            permission_profile_id: interaction.permission_profile_id.clone(),
            effective_execution_digest: interaction.effective_execution_digest.clone(),
            effective_permission_receipt,
            error: interaction
                .completion_error
                .as_deref()
                .map(|error| redactor.text(error)),
        },
        accepted_view,
    })
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
    Ok(ExportNode {
        id: ids.node(node.id.value()),
        kind: redactor.text(&node.kind),
        icon: redactor.text(&node.icon),
        title: redactor.text(&node.title),
        detail: redactor.text(&node.detail),
        state: ExportRecordState::Accepted,
    })
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
        state: ExportRecordState::Accepted,
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

    fn text(&self, value: &str) -> String {
        self.project_paths
            .iter()
            .fold(value.to_owned(), |text, path| {
                text.replace(path, "[project-path]")
            })
    }

    fn optional(&self, value: Option<&str>) -> Option<String> {
        value.map(|value| self.text(value))
    }
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
}

fn next_id(ids: &mut HashMap<i64, String>, raw: i64, kind: &str) -> String {
    if let Some(id) = ids.get(&raw) {
        return id.clone();
    }
    let id = format!("{kind}:{}", ids.len() + 1);
    ids.insert(raw, id.clone());
    id
}

#[cfg(test)]
mod tests {
    use super::{PortableIds, ProjectPathRedactor, completion_status, export_action};
    use crate::conversation_export::ExportCompletionStatus;
    use relayer_graph_core::{
        ActionId, ActionKind, ActionVariant, GraphAction, LayerId, NodeId, RecordState,
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
    fn resolved_invoke_exports_its_authored_shape() {
        let action = GraphAction {
            id: ActionId::new(1).unwrap(),
            source_node_id: NodeId::new(2).unwrap(),
            source_layer_id: Some(LayerId::new(3).unwrap()),
            kind: ActionKind::Invoke,
            relation: None,
            label: "Continue".into(),
            variant: ActionVariant::Pill,
            icon: None,
            description: None,
            target_layer_id: Some(LayerId::new(4).unwrap()),
            interaction_text: Some("Continue from here".into()),
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
}
