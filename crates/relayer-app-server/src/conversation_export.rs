//! Portable, authority-free conversation export contract.
//!
//! V1 is a JSONL stream containing one [`ConversationExportRecord::Header`]
//! followed by the exact ordered [`ConversationExportRecord::Turn`] records
//! declared by that header. This module owns only the portable contract and
//! inference-free validation; snapshot construction and persistence live at
//! higher product boundaries.

use std::collections::{HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const EXPORT_VERSION_V1: u32 = 1;
pub const MAX_EXPORT_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_JSONL_LINE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_TURNS: usize = 10_000;
pub const MAX_LAYERS_PER_TURN: usize = 10_000;
pub const MAX_NODES_PER_LAYER: usize = 8;
pub const MAX_EDGES_PER_LAYER: usize = 28;
pub const MAX_ACTIONS_PER_LAYER: usize = 64;
pub const MAX_STRING_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_PERMISSION_RECEIPT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "recordType", rename_all = "camelCase")]
pub enum ConversationExportRecord {
    Header(Box<ConversationExportHeader>),
    Turn(Box<ConversationExportTurn>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationExportHeader {
    pub export_version: u32,
    pub exported_at: String,
    pub producer: ExportProducer,
    pub conversation: ExportConversation,
    pub turns: Vec<ExportTurnManifestEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProducer {
    pub desktop_version: String,
    pub build_commit: String,
    pub platform: String,
    pub architecture: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportConversation {
    pub id: String,
    pub title: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
    pub harness_configuration_name: String,
    pub permission_profile_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTurnManifestEntry {
    pub id: String,
    pub sequence: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationExportTurn {
    pub id: String,
    pub sequence: u32,
    pub created_at: String,
    pub text: String,
    pub origin: ExportTurnOrigin,
    pub completion: ExportCompletionReceipt,
    pub accepted_view: Option<ExportAcceptedView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExportTurnOrigin {
    User,
    Action {
        source_turn_id: String,
        source_action_id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportCompletionStatus {
    NotStarted,
    Running,
    Submitted,
    Accepted,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCompletionReceipt {
    pub status: ExportCompletionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness_configuration_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness_configuration_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_selection: Option<ExportModelSelection>,
    pub permission_profile_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_execution_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_permission_receipt: Option<ExportPermissionReceipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportModelSelection {
    pub provider_id: String,
    pub model_id: String,
    pub model_family_id: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPermissionReceipt {
    pub schema_version: u32,
    pub permission_profile_id: String,
    pub label: String,
    pub authority: String,
    pub reviewer: String,
    pub binding_present: bool,
    pub unconfined_host_access: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disclosure: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportAcceptedView {
    pub interaction_node_id: String,
    pub root_action: ExportAction,
    pub root_layer_id: String,
    pub layers: Vec<ExportResolvedLayer>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResolvedLayer {
    pub layer: ExportLayer,
    pub nodes: Vec<ExportNode>,
    pub edges: Vec<ExportEdge>,
    pub actions: Vec<ExportAction>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportLayer {
    pub id: String,
    pub nodes: Vec<String>,
    pub edges: Vec<String>,
    pub state: ExportRecordState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportNode {
    pub id: String,
    pub kind: String,
    pub icon: String,
    pub title: String,
    pub detail: String,
    pub state: ExportRecordState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportEdge {
    pub id: String,
    pub endpoints: [String; 2],
    pub state: ExportRecordState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportRecordState {
    Accepted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportActionKind {
    Navigate,
    Invoke,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportNavigateRelation {
    Expand,
    Reference,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportActionVariant {
    Chip,
    Pill,
    Wide,
    Card,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportAction {
    pub id: String,
    pub source_node_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_layer_id: Option<String>,
    pub kind: ExportActionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relation: Option<ExportNavigateRelation>,
    pub label: String,
    pub variant: ExportActionVariant,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_layer_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interaction_text: Option<String>,
    pub state: ExportRecordState,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{code} at {path}: {message}")]
pub struct ExportValidationError {
    pub code: &'static str,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Error)]
pub enum ExportReadError {
    #[error("conversation export exceeds the V1 {MAX_EXPORT_BYTES}-byte file limit")]
    FileTooLarge,
    #[error("JSONL line {line} is empty")]
    EmptyLine { line: usize },
    #[error("JSONL line {line} exceeds the V1 {MAX_JSONL_LINE_BYTES}-byte line limit")]
    LineTooLarge { line: usize },
    #[error("invalid JSONL record on line {line}: {source}")]
    Json {
        line: usize,
        #[source]
        source: serde_json::Error,
    },
    #[error(transparent)]
    Contract(#[from] ExportValidationError),
}

impl ExportValidationError {
    fn new(code: &'static str, path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code,
            path: path.into(),
            message: message.into(),
        }
    }
}

pub fn decode_export_record_line(
    line: &[u8],
    line_number: usize,
) -> Result<ConversationExportRecord, ExportReadError> {
    if line.is_empty() {
        return Err(ExportReadError::EmptyLine { line: line_number });
    }
    if line.len() > MAX_JSONL_LINE_BYTES {
        return Err(ExportReadError::LineTooLarge { line: line_number });
    }
    serde_json::from_slice(line).map_err(|source| ExportReadError::Json {
        line: line_number,
        source,
    })
}

pub fn decode_export_jsonl(input: &[u8]) -> Result<Vec<ConversationExportRecord>, ExportReadError> {
    if input.len() > MAX_EXPORT_BYTES {
        return Err(ExportReadError::FileTooLarge);
    }
    let mut records = Vec::new();
    let mut lines = input.split(|byte| *byte == b'\n').peekable();
    let mut index = 0;
    while let Some(line) = lines.next() {
        let is_terminal_empty = line.is_empty() && index > 0 && lines.peek().is_none();
        if is_terminal_empty {
            continue;
        }
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        records.push(decode_export_record_line(line, index + 1)?);
        index += 1;
    }
    validate_export_records(&records)?;
    Ok(records)
}

pub fn validate_export_records(
    records: &[ConversationExportRecord],
) -> Result<(), ExportValidationError> {
    let Some(ConversationExportRecord::Header(header)) = records.first() else {
        return Err(ExportValidationError::new(
            "header_required",
            "record[0]",
            "The first JSONL record must be the single header.",
        ));
    };
    if records[1..]
        .iter()
        .any(|record| matches!(record, ConversationExportRecord::Header(_)))
    {
        return Err(ExportValidationError::new(
            "duplicate_header",
            "records",
            "Only the first JSONL record may be a header.",
        ));
    }
    let mut validator = ConversationExportValidator::new(header)?;
    if records.len() != header.turns.len() + 1 {
        return Err(ExportValidationError::new(
            "turn_inventory_mismatch",
            "records",
            format!(
                "Header declares {} turns but the stream contains {} turn records.",
                header.turns.len(),
                records.len().saturating_sub(1)
            ),
        ));
    }
    for record in &records[1..] {
        let ConversationExportRecord::Turn(turn) = record else {
            unreachable!("additional headers were rejected above")
        };
        validator.push_turn(turn)?;
    }
    validator.finish()
}

/// Inference-free V1 validator for readers that consume one JSONL turn at a time.
///
/// The validator retains the bounded header inventory, prior invoke provenance,
/// portable IDs, and fixed-size SHA-256 definition fingerprints. It never retains
/// a complete turn or accepted graph payload after [`Self::push_turn`] returns.
pub struct ConversationExportValidator {
    manifest: Vec<ExportTurnManifestEntry>,
    next_turn: usize,
    prior_invokes: HashMap<String, HashSet<String>>,
    interaction_ids: HashSet<String>,
    root_action_ids: HashSet<String>,
    layers_by_id: HashMap<String, [u8; 32]>,
    nodes_by_id: HashMap<String, [u8; 32]>,
    edges_by_id: HashMap<String, [u8; 32]>,
    actions_by_id: HashMap<String, [u8; 32]>,
}

impl ConversationExportValidator {
    pub fn new(header: &ConversationExportHeader) -> Result<Self, ExportValidationError> {
        validate_header(header)?;
        Ok(Self {
            manifest: header.turns.clone(),
            next_turn: 0,
            prior_invokes: HashMap::new(),
            interaction_ids: HashSet::new(),
            root_action_ids: HashSet::new(),
            layers_by_id: HashMap::new(),
            nodes_by_id: HashMap::new(),
            edges_by_id: HashMap::new(),
            actions_by_id: HashMap::new(),
        })
    }

    pub fn push_turn(
        &mut self,
        turn: &ConversationExportTurn,
    ) -> Result<(), ExportValidationError> {
        let path = format!("record[{}]", self.next_turn + 1);
        let Some(manifest) = self.manifest.get(self.next_turn) else {
            return Err(ExportValidationError::new(
                "turn_inventory_mismatch",
                "records",
                format!(
                    "Header declares {} turns but the stream contains at least {} turn records.",
                    self.manifest.len(),
                    self.next_turn + 1
                ),
            ));
        };
        if turn.id != manifest.id || turn.sequence != manifest.sequence {
            return Err(ExportValidationError::new(
                "turn_manifest_mismatch",
                path,
                format!(
                    "Expected turn {} at sequence {}, received {} at sequence {}.",
                    manifest.id, manifest.sequence, turn.id, turn.sequence
                ),
            ));
        }
        validate_turn(turn, &path, &self.prior_invokes)?;
        if let Some(view) = &turn.accepted_view {
            if !self
                .interaction_ids
                .insert(view.interaction_node_id.clone())
            {
                return Err(ExportValidationError::new(
                    "duplicate_interaction_node_id",
                    format!("{path}.acceptedView.interactionNodeId"),
                    "Each turn must have a distinct canonical interaction node ID.",
                ));
            }
            if !self.root_action_ids.insert(view.root_action.id.clone())
                || self.actions_by_id.contains_key(&view.root_action.id)
            {
                return Err(ExportValidationError::new(
                    "duplicate_root_action_id",
                    format!("{path}.acceptedView.rootAction.id"),
                    "Each turn must have a distinct root action ID that is not a layer action.",
                ));
            }
            register_immutable_view_records(
                view,
                &path,
                &mut self.layers_by_id,
                &mut self.nodes_by_id,
                &mut self.edges_by_id,
                &mut self.actions_by_id,
                &self.root_action_ids,
            )?;
        }
        self.prior_invokes.insert(
            turn.id.clone(),
            turn.accepted_view
                .iter()
                .flat_map(|view| &view.layers)
                .flat_map(|layer| &layer.actions)
                .filter(|action| action.kind == ExportActionKind::Invoke)
                .map(|action| action.id.clone())
                .collect(),
        );
        self.next_turn += 1;
        Ok(())
    }

    pub fn finish(self) -> Result<(), ExportValidationError> {
        if self.next_turn != self.manifest.len() {
            return Err(ExportValidationError::new(
                "turn_inventory_mismatch",
                "records",
                format!(
                    "Header declares {} turns but the stream contains {} turn records.",
                    self.manifest.len(),
                    self.next_turn
                ),
            ));
        }
        Ok(())
    }
}

fn register_immutable_view_records(
    view: &ExportAcceptedView,
    path: &str,
    layers_by_id: &mut HashMap<String, [u8; 32]>,
    nodes_by_id: &mut HashMap<String, [u8; 32]>,
    edges_by_id: &mut HashMap<String, [u8; 32]>,
    actions_by_id: &mut HashMap<String, [u8; 32]>,
    root_action_ids: &HashSet<String>,
) -> Result<(), ExportValidationError> {
    for resolved in &view.layers {
        register_definition(
            layers_by_id,
            &resolved.layer.id,
            resolved,
            path,
            "layer_identity_conflict",
        )?;
        for node in &resolved.nodes {
            register_definition(nodes_by_id, &node.id, node, path, "node_identity_conflict")?;
        }
        for edge in &resolved.edges {
            register_definition(edges_by_id, &edge.id, edge, path, "edge_identity_conflict")?;
        }
        for action in &resolved.actions {
            if root_action_ids.contains(&action.id) {
                return Err(ExportValidationError::new(
                    "root_action_repeated",
                    format!("{path}.acceptedView.action[{}]", action.id),
                    "A root action cannot also appear as a resolved layer action.",
                ));
            }
            register_definition(
                actions_by_id,
                &action.id,
                action,
                path,
                "action_identity_conflict",
            )?;
        }
    }
    Ok(())
}

fn register_definition<T: Serialize>(
    definitions: &mut HashMap<String, [u8; 32]>,
    id: &str,
    value: &T,
    path: &str,
    code: &'static str,
) -> Result<(), ExportValidationError> {
    let fingerprint: [u8; 32] = Sha256::digest(serde_json::to_vec(value).map_err(|error| {
        ExportValidationError::new(code, path, format!("Could not fingerprint {id}: {error}."))
    })?)
    .into();
    if let Some(existing) = definitions.insert(id.to_owned(), fingerprint)
        && existing != fingerprint
    {
        return Err(ExportValidationError::new(
            code,
            path,
            format!("Portable ID {id} has conflicting immutable definitions."),
        ));
    }
    Ok(())
}

fn validate_header(header: &ConversationExportHeader) -> Result<(), ExportValidationError> {
    if header.export_version != EXPORT_VERSION_V1 {
        return Err(ExportValidationError::new(
            "unsupported_export_version",
            "header.exportVersion",
            format!(
                "V1 readers support exportVersion 1, received {}.",
                header.export_version
            ),
        ));
    }
    require_id(
        &header.conversation.id,
        "conversation",
        "header.conversation.id",
    )?;
    for (path, value) in [
        ("header.exportedAt", &header.exported_at),
        (
            "header.producer.desktopVersion",
            &header.producer.desktop_version,
        ),
        ("header.producer.buildCommit", &header.producer.build_commit),
        ("header.producer.platform", &header.producer.platform),
        (
            "header.producer.architecture",
            &header.producer.architecture,
        ),
        ("header.conversation.title", &header.conversation.title),
        (
            "header.conversation.createdAt",
            &header.conversation.created_at,
        ),
        (
            "header.conversation.harnessConfigurationName",
            &header.conversation.harness_configuration_name,
        ),
        (
            "header.conversation.permissionProfileId",
            &header.conversation.permission_profile_id,
        ),
    ] {
        require_string(value, path)?;
    }
    if let Some(project_name) = &header.conversation.project_name {
        require_string(project_name, "header.conversation.projectName")?;
    }
    if header.turns.is_empty() || header.turns.len() > MAX_TURNS {
        return Err(ExportValidationError::new(
            "turn_count_out_of_bounds",
            "header.turns",
            format!("A V1 export must declare 1 to {MAX_TURNS} turns."),
        ));
    }
    let mut ids = HashSet::new();
    for (index, turn) in header.turns.iter().enumerate() {
        require_id(&turn.id, "turn", format!("header.turns[{index}].id"))?;
        let expected_sequence = u32::try_from(index + 1).expect("MAX_TURNS fits u32");
        if turn.sequence != expected_sequence {
            return Err(ExportValidationError::new(
                "turn_sequence_invalid",
                format!("header.turns[{index}].sequence"),
                format!("Turn sequence must be contiguous from 1; expected {expected_sequence}."),
            ));
        }
        if !ids.insert(&turn.id) {
            return Err(ExportValidationError::new(
                "duplicate_turn_id",
                format!("header.turns[{index}].id"),
                format!("Turn ID {} is declared more than once.", turn.id),
            ));
        }
    }
    Ok(())
}

fn validate_turn(
    turn: &ConversationExportTurn,
    path: &str,
    prior_invokes: &HashMap<String, HashSet<String>>,
) -> Result<(), ExportValidationError> {
    require_string(&turn.created_at, format!("{path}.createdAt"))?;
    require_string(&turn.text, format!("{path}.text"))?;
    require_string(
        &turn.completion.permission_profile_id,
        format!("{path}.completion.permissionProfileId"),
    )?;
    validate_optional_strings(&turn.completion, path)?;
    if let Some(selection) = &turn.completion.model_selection {
        require_string(
            &selection.provider_id,
            format!("{path}.completion.modelSelection.providerId"),
        )?;
        require_string(
            &selection.model_id,
            format!("{path}.completion.modelSelection.modelId"),
        )?;
        if selection.model_family_id <= 0 {
            return Err(ExportValidationError::new(
                "model_family_id_invalid",
                format!("{path}.completion.modelSelection.modelFamilyId"),
                "Model family ID must be a positive producer-local identifier.",
            ));
        }
    }
    if let Some(receipt) = &turn.completion.effective_permission_receipt {
        let bytes = serde_json::to_vec(receipt).map_err(|error| {
            ExportValidationError::new(
                "permission_receipt_invalid",
                format!("{path}.completion.effectivePermissionReceipt"),
                error.to_string(),
            )
        })?;
        if bytes.len() > MAX_PERMISSION_RECEIPT_BYTES {
            return Err(ExportValidationError::new(
                "permission_receipt_too_large",
                format!("{path}.completion.effectivePermissionReceipt"),
                format!("Permission receipt exceeds {MAX_PERMISSION_RECEIPT_BYTES} bytes."),
            ));
        }
        if receipt.schema_version != 1
            || receipt.permission_profile_id != turn.completion.permission_profile_id
        {
            return Err(ExportValidationError::new(
                "permission_receipt_mismatch",
                format!("{path}.completion.effectivePermissionReceipt"),
                "The normalized V1 permission receipt must match completion.permissionProfileId.",
            ));
        }
        for (field, value) in [
            ("permissionProfileId", &receipt.permission_profile_id),
            ("label", &receipt.label),
            ("authority", &receipt.authority),
            ("reviewer", &receipt.reviewer),
        ] {
            require_string(
                value,
                format!("{path}.completion.effectivePermissionReceipt.{field}"),
            )?;
        }
        if let Some(disclosure) = &receipt.disclosure {
            require_string(
                disclosure,
                format!("{path}.completion.effectivePermissionReceipt.disclosure"),
            )?;
        }
    }
    match &turn.origin {
        ExportTurnOrigin::User => {}
        ExportTurnOrigin::Action {
            source_turn_id,
            source_action_id,
        } => {
            require_id(
                source_turn_id,
                "turn",
                format!("{path}.origin.sourceTurnId"),
            )?;
            require_id(
                source_action_id,
                "action",
                format!("{path}.origin.sourceActionId"),
            )?;
            let source_is_prior_invoke = prior_invokes
                .get(source_turn_id)
                .is_some_and(|actions| actions.contains(source_action_id));
            if !source_is_prior_invoke {
                return Err(ExportValidationError::new(
                    "action_origin_unresolved",
                    format!("{path}.origin"),
                    "An action-created turn must reference an invoke action in an earlier exported turn.",
                ));
            }
        }
    }
    match (turn.completion.status, &turn.accepted_view) {
        (ExportCompletionStatus::Accepted, Some(view)) => validate_accepted_view(view, path),
        (ExportCompletionStatus::Accepted, None) => Err(ExportValidationError::new(
            "accepted_view_missing",
            format!("{path}.acceptedView"),
            "An accepted turn must include its immutable accepted view.",
        )),
        (_, Some(_)) => Err(ExportValidationError::new(
            "accepted_view_unexpected",
            format!("{path}.acceptedView"),
            "Only an accepted turn may include an accepted view.",
        )),
        (_, None) => Ok(()),
    }
}

fn validate_optional_strings(
    completion: &ExportCompletionReceipt,
    path: &str,
) -> Result<(), ExportValidationError> {
    for (field, value) in [
        (
            "harnessConfigurationName",
            completion.harness_configuration_name.as_ref(),
        ),
        (
            "harnessConfigurationDigest",
            completion.harness_configuration_digest.as_ref(),
        ),
        (
            "effectiveExecutionDigest",
            completion.effective_execution_digest.as_ref(),
        ),
        ("error", completion.error.as_ref()),
    ] {
        if let Some(value) = value {
            require_string(value, format!("{path}.completion.{field}"))?;
        }
    }
    Ok(())
}

fn validate_accepted_view(
    view: &ExportAcceptedView,
    turn_path: &str,
) -> Result<(), ExportValidationError> {
    let path = format!("{turn_path}.acceptedView");
    require_id(
        &view.interaction_node_id,
        "node",
        format!("{path}.interactionNodeId"),
    )?;
    require_id(&view.root_layer_id, "layer", format!("{path}.rootLayerId"))?;
    if view.layers.is_empty() || view.layers.len() > MAX_LAYERS_PER_TURN {
        return Err(ExportValidationError::new(
            "layer_count_out_of_bounds",
            format!("{path}.layers"),
            format!("An accepted view must contain 1 to {MAX_LAYERS_PER_TURN} layers."),
        ));
    }
    validate_root_action(&view.root_action, view, &path)?;

    let mut layers = HashMap::new();
    for (index, resolved) in view.layers.iter().enumerate() {
        let layer_path = format!("{path}.layers[{index}]");
        require_id(
            &resolved.layer.id,
            "layer",
            format!("{layer_path}.layer.id"),
        )?;
        if layers
            .insert(resolved.layer.id.as_str(), resolved)
            .is_some()
        {
            return Err(ExportValidationError::new(
                "duplicate_layer_id",
                format!("{layer_path}.layer.id"),
                format!(
                    "Layer {} appears more than once in the accepted view.",
                    resolved.layer.id
                ),
            ));
        }
        validate_layer(resolved, &layer_path)?;
    }
    if !layers.contains_key(view.root_layer_id.as_str()) {
        return Err(ExportValidationError::new(
            "root_layer_missing",
            format!("{path}.rootLayerId"),
            "The root layer is absent from the accepted view.",
        ));
    }

    let mut pending = VecDeque::from([view.root_layer_id.as_str()]);
    let mut visited = HashSet::new();
    let mut nodes_by_id = HashMap::<&str, &ExportNode>::new();
    let mut edges_by_id = HashMap::<&str, &ExportEdge>::new();
    let mut actions_by_id = HashMap::<&str, &ExportAction>::new();
    let mut expand_adjacency = HashMap::<&str, Vec<&str>>::new();
    let mut target_relations = HashMap::<&str, ExportNavigateRelation>::new();
    target_relations.insert(view.root_layer_id.as_str(), ExportNavigateRelation::Expand);
    while let Some(layer_id) = pending.pop_front() {
        if !visited.insert(layer_id) {
            continue;
        }
        let resolved = layers[layer_id];
        for node in &resolved.nodes {
            if let Some(existing) = nodes_by_id.insert(&node.id, node)
                && existing != node
            {
                return Err(ExportValidationError::new(
                    "node_identity_conflict",
                    format!("{path}.node[{}]", node.id),
                    "A portable node ID must have one immutable definition within an accepted view.",
                ));
            }
        }
        for edge in &resolved.edges {
            if let Some(existing) = edges_by_id.insert(&edge.id, edge)
                && existing != edge
            {
                return Err(ExportValidationError::new(
                    "edge_identity_conflict",
                    format!("{path}.edge[{}]", edge.id),
                    "A portable edge ID must have one immutable definition within an accepted view.",
                ));
            }
        }
        for action in &resolved.actions {
            validate_action(action, &format!("{path}.action[{}]", action.id))?;
            if let Some(existing) = actions_by_id.insert(&action.id, action)
                && existing != action
            {
                return Err(ExportValidationError::new(
                    "action_identity_conflict",
                    format!("{path}.action[{}]", action.id),
                    "A portable action ID must have one immutable definition within an accepted view.",
                ));
            }
            if action.id == view.root_action.id {
                return Err(ExportValidationError::new(
                    "root_action_repeated",
                    format!("{path}.action[{}]", action.id),
                    "The root action is represented once outside resolved layers.",
                ));
            }
            if !resolved.layer.nodes.contains(&action.source_node_id) {
                return Err(ExportValidationError::new(
                    "action_source_outside_layer",
                    format!("{path}.action[{}].sourceNodeId", action.id),
                    "A resolved layer action source must be a member of that layer.",
                ));
            }
            let Some(source_layer_id) = action.source_layer_id.as_deref() else {
                return Err(ExportValidationError::new(
                    "action_source_layer_missing",
                    format!("{path}.action[{}].sourceLayerId", action.id),
                    "Every non-root action must retain its exact source-layer provenance.",
                ));
            };
            if let Some(source_layer) = layers.get(source_layer_id)
                && !source_layer.layer.nodes.contains(&action.source_node_id)
            {
                return Err(ExportValidationError::new(
                    "action_source_provenance_invalid",
                    format!("{path}.action[{}].sourceLayerId", action.id),
                    "When a source-provenance layer is in this view, it must contain the action source node.",
                ));
            }
            if action.kind == ExportActionKind::Navigate {
                let target = action
                    .target_layer_id
                    .as_deref()
                    .expect("validated navigate target");
                if !layers.contains_key(target) {
                    return Err(ExportValidationError::new(
                        "navigate_target_unresolved",
                        format!("{path}.action[{}].targetLayerId", action.id),
                        format!("Navigate target {target} is absent from the accepted view."),
                    ));
                }
                let relation = action.relation.expect("validated navigate relation");
                if let Some(existing) = target_relations.insert(target, relation)
                    && existing != relation
                {
                    return Err(ExportValidationError::new(
                        "mixed_target_relations",
                        format!("{path}.action[{}].relation", action.id),
                        format!("Layer {target} is targeted as both expand and reference."),
                    ));
                }
                if relation == ExportNavigateRelation::Expand {
                    expand_adjacency.entry(layer_id).or_default().push(target);
                }
                pending.push_back(target);
            }
        }
    }
    if visited.len() != layers.len() {
        return Err(ExportValidationError::new(
            "incomplete_navigation_closure",
            format!("{path}.layers"),
            format!(
                "{} layer(s) are outside the root navigation closure.",
                layers.len() - visited.len()
            ),
        ));
    }
    if has_cycle(view.root_layer_id.as_str(), &expand_adjacency) {
        return Err(ExportValidationError::new(
            "expand_cycle",
            format!("{path}.layers"),
            "Expand navigation must be acyclic.",
        ));
    }
    Ok(())
}

fn validate_root_action(
    action: &ExportAction,
    view: &ExportAcceptedView,
    path: &str,
) -> Result<(), ExportValidationError> {
    validate_action(action, &format!("{path}.rootAction"))?;
    if action.source_node_id != view.interaction_node_id
        || action.source_layer_id.is_some()
        || action.kind != ExportActionKind::Navigate
        || action.relation != Some(ExportNavigateRelation::Expand)
        || action.target_layer_id.as_deref() != Some(view.root_layer_id.as_str())
    {
        return Err(ExportValidationError::new(
            "invalid_root_action",
            format!("{path}.rootAction"),
            "The root action must be an accepted expand from the interaction node to rootLayerId with no source layer.",
        ));
    }
    Ok(())
}

fn validate_layer(resolved: &ExportResolvedLayer, path: &str) -> Result<(), ExportValidationError> {
    if resolved.nodes.is_empty() || resolved.nodes.len() > MAX_NODES_PER_LAYER {
        return Err(ExportValidationError::new(
            "layer_node_count",
            format!("{path}.nodes"),
            format!("A layer must contain 1 to {MAX_NODES_PER_LAYER} nodes."),
        ));
    }
    if resolved.edges.len() > MAX_EDGES_PER_LAYER || resolved.actions.len() > MAX_ACTIONS_PER_LAYER
    {
        return Err(ExportValidationError::new(
            "layer_member_limit",
            path,
            "Layer edge or action count exceeds the V1 bound.",
        ));
    }
    let node_ids = resolved
        .nodes
        .iter()
        .map(|node| node.id.clone())
        .collect::<Vec<_>>();
    let edge_ids = resolved
        .edges
        .iter()
        .map(|edge| edge.id.clone())
        .collect::<Vec<_>>();
    if resolved.layer.nodes != node_ids || resolved.layer.edges != edge_ids {
        return Err(ExportValidationError::new(
            "layer_membership_mismatch",
            path,
            "Resolved node and edge order must exactly match the layer snapshot membership.",
        ));
    }
    if node_ids.iter().collect::<HashSet<_>>().len() != node_ids.len()
        || edge_ids.iter().collect::<HashSet<_>>().len() != edge_ids.len()
    {
        return Err(ExportValidationError::new(
            "duplicate_layer_member",
            path,
            "A node or edge may appear only once in a layer.",
        ));
    }
    let members = node_ids.iter().map(String::as_str).collect::<HashSet<_>>();
    for (index, node) in resolved.nodes.iter().enumerate() {
        require_id(&node.id, "node", format!("{path}.nodes[{index}].id"))?;
        require_string(&node.kind, format!("{path}.nodes[{index}].kind"))?;
        require_string(&node.icon, format!("{path}.nodes[{index}].icon"))?;
        require_string(&node.title, format!("{path}.nodes[{index}].title"))?;
        require_string(&node.detail, format!("{path}.nodes[{index}].detail"))?;
    }
    for (index, edge) in resolved.edges.iter().enumerate() {
        require_id(&edge.id, "edge", format!("{path}.edges[{index}].id"))?;
        if edge.endpoints[0] == edge.endpoints[1]
            || edge
                .endpoints
                .iter()
                .any(|endpoint| !members.contains(endpoint.as_str()))
        {
            return Err(ExportValidationError::new(
                "edge_outside_layer",
                format!("{path}.edges[{index}].endpoints"),
                "An edge must connect two distinct nodes in its layer.",
            ));
        }
    }
    if !is_connected(&node_ids, &resolved.edges) {
        return Err(ExportValidationError::new(
            "disconnected_layer",
            format!("{path}.edges"),
            "Every node in a multi-node layer must be connected.",
        ));
    }
    let mut action_ids = HashSet::new();
    for action in &resolved.actions {
        if !action_ids.insert(&action.id) {
            return Err(ExportValidationError::new(
                "duplicate_action_id",
                format!("{path}.actions"),
                format!("Action {} appears more than once in one layer.", action.id),
            ));
        }
    }
    Ok(())
}

fn validate_action(action: &ExportAction, path: &str) -> Result<(), ExportValidationError> {
    require_id(&action.id, "action", format!("{path}.id"))?;
    require_id(
        &action.source_node_id,
        "node",
        format!("{path}.sourceNodeId"),
    )?;
    if let Some(source_layer_id) = &action.source_layer_id {
        require_id(source_layer_id, "layer", format!("{path}.sourceLayerId"))?;
    }
    require_string(&action.label, format!("{path}.label"))?;
    if let Some(value) = &action.icon {
        require_string(value, format!("{path}.icon"))?;
    }
    if let Some(value) = &action.description {
        require_string(value, format!("{path}.description"))?;
    }
    match action.kind {
        ExportActionKind::Navigate
            if action.relation.is_some()
                && action.target_layer_id.is_some()
                && action.interaction_text.is_none() => {}
        ExportActionKind::Invoke
            if action.relation.is_none()
                && action.target_layer_id.is_none()
                && action
                    .interaction_text
                    .as_deref()
                    .is_some_and(|text| !text.trim().is_empty()) => {}
        _ => {
            return Err(ExportValidationError::new(
                "invalid_action_shape",
                path,
                "Navigate actions require relation and targetLayerId; invoke actions require interactionText.",
            ));
        }
    }
    if action.variant == ExportActionVariant::Card
        && action
            .description
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
    {
        return Err(ExportValidationError::new(
            "card_description_missing",
            format!("{path}.description"),
            "Card actions require a description.",
        ));
    }
    if action.variant != ExportActionVariant::Card && action.description.is_some() {
        return Err(ExportValidationError::new(
            "action_description_unexpected",
            format!("{path}.description"),
            "Only card actions may contain a description.",
        ));
    }
    Ok(())
}

fn require_id(
    value: &str,
    kind: &str,
    path: impl Into<String>,
) -> Result<(), ExportValidationError> {
    let valid = value
        .strip_prefix(&format!("{kind}:"))
        .is_some_and(|suffix| {
            !suffix.is_empty()
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        });
    if !valid || value.len() > 128 {
        return Err(ExportValidationError::new(
            "portable_id_invalid",
            path,
            format!("Expected an authority-free {kind}:<local-id> identifier."),
        ));
    }
    Ok(())
}

fn require_string(value: &str, path: impl Into<String>) -> Result<(), ExportValidationError> {
    let path = path.into();
    if value.trim().is_empty() {
        return Err(ExportValidationError::new(
            "string_empty",
            path,
            "Value must not be empty.",
        ));
    }
    if value.len() > MAX_STRING_BYTES {
        return Err(ExportValidationError::new(
            "string_too_large",
            path,
            format!("String exceeds {MAX_STRING_BYTES} UTF-8 bytes."),
        ));
    }
    Ok(())
}

fn is_connected(node_ids: &[String], edges: &[ExportEdge]) -> bool {
    if node_ids.len() <= 1 {
        return true;
    }
    let mut adjacency = HashMap::<&str, Vec<&str>>::new();
    for id in node_ids {
        adjacency.entry(id).or_default();
    }
    for edge in edges {
        adjacency
            .entry(&edge.endpoints[0])
            .or_default()
            .push(&edge.endpoints[1]);
        adjacency
            .entry(&edge.endpoints[1])
            .or_default()
            .push(&edge.endpoints[0]);
    }
    let mut pending = vec![node_ids[0].as_str()];
    let mut visited = HashSet::new();
    while let Some(node) = pending.pop() {
        if visited.insert(node) {
            pending.extend(adjacency.get(node).into_iter().flatten().copied());
        }
    }
    visited.len() == node_ids.len()
}

fn has_cycle<'a>(root: &'a str, adjacency: &HashMap<&'a str, Vec<&'a str>>) -> bool {
    fn visit<'a>(
        node: &'a str,
        adjacency: &HashMap<&'a str, Vec<&'a str>>,
        visiting: &mut HashSet<&'a str>,
        visited: &mut HashSet<&'a str>,
    ) -> bool {
        if visiting.contains(node) {
            return true;
        }
        if !visited.insert(node) {
            return false;
        }
        visiting.insert(node);
        let cyclic = adjacency
            .get(node)
            .into_iter()
            .flatten()
            .any(|child| visit(child, adjacency, visiting, visited));
        visiting.remove(node);
        cyclic
    }
    visit(root, adjacency, &mut HashSet::new(), &mut HashSet::new())
}
