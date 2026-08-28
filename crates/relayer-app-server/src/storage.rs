mod sqlite;

use crate::conversation_export::{
    ConversationExportHeader, ConversationExportTurn, ExportTurnOrigin,
};
use crate::{
    approval::ApprovalReceipt,
    product::{
        ActionInvocation, Interaction, InteractionModelSelection, Project, ProjectId, Thread,
        ThreadId,
    },
};
pub(crate) use sqlite::{PersonalPresentationPin, SqliteProductStore};
use thiserror::Error;

pub(crate) struct ProductStateSnapshot {
    pub(crate) projects: Vec<Project>,
    pub(crate) threads: Vec<Thread>,
    pub(crate) selected_thread_id: Option<ThreadId>,
    pub(crate) interactions: Vec<Interaction>,
    pub(crate) action_invocations: Vec<ActionInvocation>,
    pub(crate) approvals: Vec<ApprovalReceipt>,
}

pub(crate) struct ThreadSnapshot {
    pub(crate) thread: Option<Thread>,
    pub(crate) project: Option<Project>,
    pub(crate) interactions: Vec<Interaction>,
    pub(crate) action_invocations: Vec<ActionInvocation>,
    pub(crate) approvals: Vec<ApprovalReceipt>,
}

pub(crate) struct NewThreadRecord<'a> {
    pub(crate) title: &'a str,
    pub(crate) project_id: Option<ProjectId>,
    pub(crate) initial_message: &'a str,
    pub(crate) harness_configuration_name: &'a str,
    pub(crate) permission_profile_id: &'a str,
    pub(crate) model_selection: Option<&'a InteractionModelSelection>,
    pub(crate) timestamp: &'a str,
}

pub(crate) struct NewInteractionInput<'a> {
    pub(crate) text: &'a str,
    pub(crate) input_identity: &'a str,
    pub(crate) input_digest: &'a str,
    pub(crate) contexts: &'a [crate::product::InteractionContextIntent],
    pub(crate) context_confirmation_ids: &'a [String],
}

pub(crate) struct NewNodeContextDraft<'a> {
    pub(crate) id: &'a str,
    pub(crate) target: &'a crate::product::InteractionContextTarget,
    pub(crate) target_node: &'a relayer_graph_core::InteractionInputNode,
    pub(crate) text: &'a str,
}

pub(crate) struct NewActionInputAttachment<'a> {
    pub(crate) occurrence: &'a relayer_graph_core::PresentingInputOccurrence,
    pub(crate) source_node_id: i64,
    pub(crate) action: &'a relayer_graph_core::InputAction,
    pub(crate) value: &'a crate::product::ActionInputValue,
}

#[derive(Debug)]
pub(crate) enum InteractionInputInsertOutcome {
    Created(crate::product::Interaction),
    Existing(crate::product::Interaction),
}

pub(crate) enum ActionInvocationInsertOutcome {
    Created {
        invocation: ActionInvocation,
        interaction: Interaction,
    },
    Existing {
        invocation: ActionInvocation,
        interaction: Interaction,
    },
}

#[derive(Debug, Clone)]
pub(crate) struct StagedConversationImport {
    pub(crate) id: String,
    pub(crate) source_sha256: String,
    pub(crate) header: ConversationExportHeader,
    pub(crate) thread_id: ThreadId,
    pub(crate) turns: Vec<StagedConversationTurnSummary>,
}

#[derive(Debug, Clone)]
pub(crate) struct StagedConversationTurnSummary {
    pub(crate) source_turn_id: String,
    pub(crate) sequence: u32,
    pub(crate) interaction_id: crate::product::InteractionId,
    pub(crate) completion_status: crate::conversation_export::ExportCompletionStatus,
}

pub(crate) struct ConversationImportRecord {
    pub(crate) id: String,
    pub(crate) source_sha256: String,
    pub(crate) header: ConversationExportHeader,
    pub(crate) thread_id: ThreadId,
    pub(crate) turns: Vec<(String, crate::product::InteractionId, Option<i64>, String)>,
}

pub(crate) struct ImportedTurnExportRecord {
    pub(crate) interaction_id: crate::product::InteractionId,
    pub(crate) source_turn_id: String,
    pub(crate) origin: ExportTurnOrigin,
    pub(crate) turn: ConversationExportTurn,
}

pub(crate) struct NewConversationImport<'a> {
    pub(crate) id: &'a str,
    pub(crate) source_sha256: &'a str,
    pub(crate) header: &'a ConversationExportHeader,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CompletionExecutionBinding<'a> {
    pub(crate) interaction_id: crate::product::InteractionId,
    pub(crate) graph_completion_id: i64,
    pub(crate) harness_configuration_name: &'a str,
    pub(crate) harness_configuration_digest: &'a str,
    pub(crate) model_execution_digest: &'a str,
    /// Digest of the durable permission receipt and invocation origin. Transient graph
    /// capability tokens must never be included in this identity.
    pub(crate) permission_origin_digest: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CompletionExecutionPhase {
    Reserved,
    Launching,
    Attached,
    Settled,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CompletionExecution {
    pub(crate) interaction_id: crate::product::InteractionId,
    pub(crate) graph_completion_id: i64,
    pub(crate) harness_configuration_name: String,
    pub(crate) harness_configuration_digest: String,
    pub(crate) model_execution_digest: String,
    pub(crate) permission_origin_digest: String,
    pub(crate) phase: CompletionExecutionPhase,
    pub(crate) attachment: Option<serde_json::Value>,
    pub(crate) settlement: Option<serde_json::Value>,
    pub(crate) safe_reason: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum CompletionExecutionReserveOutcome {
    Created(CompletionExecution),
    Existing(CompletionExecution),
}

pub(crate) enum CompletionExecutionRestartSettlement {
    Accepted { output: serde_json::Value },
    Failed { safe_reason: String },
}

#[derive(Debug, Error)]
pub(crate) enum StorageError {
    #[error("database operation failed: {0}")]
    Database(#[from] sqlx::Error),
    #[error("database migration failed: {0}")]
    Migration(#[from] sqlx::migrate::MigrateError),
    #[error("product database schema is incompatible: {0}")]
    IncompatibleSchema(String),
    #[error("stored product JSON is invalid: {0}")]
    Serialization(String),
    #[error("product catalog is invalid: {0}")]
    Catalog(#[from] crate::product::CatalogError),
    #[error("stored approval conflicts with an existing durable record: {0}")]
    ApprovalConflict(String),
    #[error("annotation write conflicts with durable history: {0}")]
    AnnotationConflict(String),
    #[error("node-context draft conflict: {message}")]
    ContextDraftConflict { code: &'static str, message: String },
    #[error("completion execution conflict: {0}")]
    CompletionExecutionConflict(String),
    #[error("personal presentation conflict: {0}")]
    PersonalPresentationConflict(String),
    #[error("action-input draft conflict: {message}")]
    ActionInputDraftConflict { code: &'static str, message: String },
}
