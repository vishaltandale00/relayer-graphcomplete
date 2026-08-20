use super::{
    ActionInvocation, Interaction, InteractionId, ProductCapabilities, ProductState, Project,
    ProjectId, Thread, ThreadId, ThreadView,
};
use crate::storage::{ActionInvocationInsertOutcome, SqliteProductStore, StorageError};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

#[derive(Debug)]
pub(crate) struct CreateProjectCommand {
    pub(crate) path: String,
    pub(crate) name: Option<String>,
    pub(crate) reuse_existing: bool,
}

#[derive(Debug)]
pub(crate) struct CreateThreadCommand {
    pub(crate) title: Option<String>,
    pub(crate) project_id: Option<ProjectId>,
    pub(crate) initial_message: String,
    pub(crate) harness_configuration_name: String,
    pub(crate) permission_profile_id: String,
}

pub(crate) struct AcceptedInteractionCompletion<'a> {
    pub(crate) interaction_id: InteractionId,
    pub(crate) graph_node_id: i64,
    pub(crate) harness_configuration_name: &'a str,
    pub(crate) harness_configuration_digest: &'a str,
    pub(crate) effective_execution_digest: &'a str,
    pub(crate) effective_permission_receipt: &'a serde_json::Value,
    pub(crate) output: &'a serde_json::Value,
}

pub(crate) struct ProjectWriteOutcome {
    pub(crate) project: Project,
    pub(crate) created: bool,
}

pub(crate) struct ThreadDetail {
    pub(crate) thread: Thread,
    pub(crate) interactions: Vec<Interaction>,
    pub(crate) action_invocations: Vec<ActionInvocation>,
}

pub(crate) struct InvokeActionOutcome {
    pub(crate) invocation: ActionInvocation,
    pub(crate) interaction: Interaction,
    pub(crate) created: bool,
}

#[derive(Debug, Error)]
pub(crate) enum ProductError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("invalid input: {0}")]
    Invalid(String),
    #[error("project already exists")]
    ProjectExists(Project),
    #[error("folder unavailable at {path}: {reason}")]
    FolderUnavailable { path: String, reason: String },
    #[error(transparent)]
    Storage(#[from] StorageError),
}

#[derive(Clone)]
pub(crate) struct ProductService {
    storage: SqliteProductStore,
    runtime_available: bool,
}

impl ProductService {
    pub(crate) fn new(storage: SqliteProductStore, runtime_available: bool) -> Self {
        Self {
            storage,
            runtime_available,
        }
    }

    pub(crate) fn capabilities(&self) -> ProductCapabilities {
        ProductCapabilities {
            graph: self.runtime_available,
            harness: self.runtime_available,
            ..ProductCapabilities::default()
        }
    }

    pub(crate) async fn load_state(
        &self,
        requested_thread_id: Option<ThreadId>,
    ) -> Result<ProductState, ProductError> {
        let snapshot = self.storage.load_product_state(requested_thread_id).await?;
        let threads = snapshot
            .threads
            .into_iter()
            .map(|thread| ThreadView {
                active: snapshot.selected_thread_id == Some(thread.id),
                thread,
            })
            .collect();
        Ok(ProductState {
            projects: snapshot.projects,
            threads,
            interactions: snapshot.interactions,
            action_invocations: snapshot.action_invocations,
            capabilities: self.capabilities(),
        })
    }

    pub(crate) async fn list_projects(&self) -> Result<Vec<Project>, ProductError> {
        self.storage.list_projects().await.map_err(Into::into)
    }

    pub(crate) async fn create_project(
        &self,
        command: CreateProjectCommand,
    ) -> Result<ProjectWriteOutcome, ProductError> {
        let supplied_path = required(&command.path, "path")?;
        let canonical_path = tokio::fs::canonicalize(supplied_path)
            .await
            .map_err(|error| ProductError::FolderUnavailable {
                path: supplied_path.to_owned(),
                reason: error.to_string(),
            })?;
        let metadata = tokio::fs::metadata(&canonical_path)
            .await
            .map_err(|error| ProductError::FolderUnavailable {
                path: supplied_path.to_owned(),
                reason: error.to_string(),
            })?;
        if !metadata.is_dir() {
            return Err(ProductError::Invalid(format!(
                "project path is not a directory: {}",
                canonical_path.display()
            )));
        }
        let path = canonical_path.to_string_lossy().into_owned();
        let name = command
            .name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .or_else(|| {
                canonical_path
                    .file_name()
                    .map(|value| value.to_string_lossy().into_owned())
            })
            .ok_or_else(|| ProductError::Invalid("project name cannot be determined".into()))?;
        let timestamp = now();
        let (project, created) = self
            .storage
            .insert_or_get_project(&name, &path, &timestamp)
            .await?;
        if !created && !command.reuse_existing {
            return Err(ProductError::ProjectExists(project));
        }
        Ok(ProjectWriteOutcome { project, created })
    }

    pub(crate) async fn list_threads(&self) -> Result<Vec<Thread>, ProductError> {
        self.storage.list_threads().await.map_err(Into::into)
    }

    pub(crate) async fn create_thread(
        &self,
        command: CreateThreadCommand,
    ) -> Result<Thread, ProductError> {
        let message = required(&command.initial_message, "initialMessage")?;
        if let Some(project_id) = command.project_id {
            self.storage
                .get_project(project_id)
                .await?
                .ok_or_else(|| ProductError::NotFound(format!("project {project_id}")))?;
        }
        let title = command
            .title
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(message)
            .chars()
            .take(120)
            .collect::<String>();
        self.storage
            .insert_thread_with_initial_interaction(
                &title,
                command.project_id,
                message,
                &command.harness_configuration_name,
                &command.permission_profile_id,
                &now(),
            )
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn get_thread(&self, id: ThreadId) -> Result<ThreadDetail, ProductError> {
        let snapshot = self.storage.load_thread(id).await?;
        let thread = snapshot
            .thread
            .ok_or_else(|| ProductError::NotFound(format!("thread {id}")))?;
        Ok(ThreadDetail {
            thread,
            interactions: snapshot.interactions,
            action_invocations: snapshot.action_invocations,
        })
    }

    pub(crate) async fn list_interactions(
        &self,
        thread_id: ThreadId,
    ) -> Result<Vec<Interaction>, ProductError> {
        if self.storage.get_thread(thread_id).await?.is_none() {
            return Err(ProductError::NotFound(format!("thread {thread_id}")));
        }
        self.storage
            .list_interactions(thread_id)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn create_interaction(
        &self,
        thread_id: ThreadId,
        text: &str,
    ) -> Result<Interaction, ProductError> {
        let text = required(text, "text")?;
        if self.storage.get_thread(thread_id).await?.is_none() {
            return Err(ProductError::NotFound(format!("thread {thread_id}")));
        }
        self.storage
            .insert_interaction(thread_id, text)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn invoke_action(
        &self,
        source_interaction_id: InteractionId,
        action_id: i64,
        text: &str,
    ) -> Result<InvokeActionOutcome, ProductError> {
        if action_id <= 0 {
            return Err(ProductError::Invalid(
                "action ID must be a positive integer".into(),
            ));
        }
        let text = required(text, "interactionText")?;
        let outcome = self
            .storage
            .insert_action_invocation(source_interaction_id, action_id, text)
            .await?;
        Ok(match outcome {
            ActionInvocationInsertOutcome::Created {
                invocation,
                interaction,
            } => InvokeActionOutcome {
                invocation,
                interaction,
                created: true,
            },
            ActionInvocationInsertOutcome::Existing {
                invocation,
                interaction,
            } => InvokeActionOutcome {
                invocation,
                interaction,
                created: false,
            },
        })
    }

    pub(crate) async fn get_action_invocation(
        &self,
        source_interaction_id: InteractionId,
        action_id: i64,
    ) -> Result<Option<InvokeActionOutcome>, ProductError> {
        Ok(self
            .storage
            .get_action_invocation(source_interaction_id, action_id)
            .await?
            .map(|(invocation, interaction)| InvokeActionOutcome {
                invocation,
                interaction,
                created: false,
            }))
    }

    pub(crate) async fn get_interaction(
        &self,
        interaction_id: super::InteractionId,
    ) -> Result<Interaction, ProductError> {
        self.storage
            .get_interaction(interaction_id)
            .await?
            .ok_or_else(|| ProductError::NotFound(format!("interaction {interaction_id}")))
    }

    pub(crate) async fn mark_interaction_running(
        &self,
        interaction_id: super::InteractionId,
        harness_configuration_name: &str,
    ) -> Result<(), ProductError> {
        self.storage
            .mark_interaction_running(interaction_id, harness_configuration_name)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn claim_interaction_running(
        &self,
        interaction_id: super::InteractionId,
        harness_configuration_name: &str,
    ) -> Result<bool, ProductError> {
        self.storage
            .claim_interaction_running(interaction_id, harness_configuration_name)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn accept_interaction_completion(
        &self,
        completion: AcceptedInteractionCompletion<'_>,
    ) -> Result<(), ProductError> {
        self.storage
            .accept_interaction_completion(completion)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn fail_interaction_completion(
        &self,
        interaction_id: super::InteractionId,
        harness_configuration_name: &str,
        error: &str,
    ) -> Result<(), ProductError> {
        self.storage
            .fail_interaction_completion(interaction_id, harness_configuration_name, error)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn project_path(&self, project_id: ProjectId) -> Result<String, ProductError> {
        self.storage
            .get_project(project_id)
            .await?
            .map(|project| project.path)
            .ok_or_else(|| ProductError::NotFound(format!("project {project_id}")))
    }
}

fn required<'a>(value: &'a str, name: &str) -> Result<&'a str, ProductError> {
    let value = value.trim();
    if value.is_empty() {
        Err(ProductError::Invalid(format!(
            "{name} must be a non-empty string"
        )))
    } else {
        Ok(value)
    }
}

fn now() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time is before unix epoch")
        .as_millis()
        .to_string()
}
