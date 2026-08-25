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
pub(crate) use sqlite::SqliteProductStore;
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
}
