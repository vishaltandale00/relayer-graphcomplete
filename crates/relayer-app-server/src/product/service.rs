use super::{
    Interaction, ProductCapabilities, ProductState, Project, ProjectId, Thread, ThreadId,
    ThreadView,
};
use crate::storage::{SqliteProductStore, StorageError};
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
}

pub(crate) struct ProjectWriteOutcome {
    pub(crate) project: Project,
    pub(crate) created: bool,
}

pub(crate) struct ThreadDetail {
    pub(crate) thread: Thread,
    pub(crate) interactions: Vec<Interaction>,
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
}

impl ProductService {
    pub(crate) fn new(storage: SqliteProductStore) -> Self {
        Self { storage }
    }

    pub(crate) fn capabilities(&self) -> ProductCapabilities {
        ProductCapabilities::default()
    }

    pub(crate) async fn load_state(
        &self,
        requested_thread_id: Option<ThreadId>,
    ) -> Result<ProductState, ProductError> {
        let projects = self.storage.list_projects().await?;
        let threads = self.storage.list_threads().await?;
        let selected_id = requested_thread_id
            .filter(|id| threads.iter().any(|thread| thread.id == *id))
            .or_else(|| threads.first().map(|thread| thread.id));
        let interactions = match selected_id {
            Some(thread_id) => self.storage.list_interactions(thread_id).await?,
            None => Vec::new(),
        };
        let threads = threads
            .into_iter()
            .map(|thread| ThreadView {
                active: selected_id == Some(thread.id),
                thread,
            })
            .collect();
        Ok(ProductState {
            projects,
            threads,
            interactions,
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
            .insert_thread_with_initial_interaction(&title, command.project_id, message, &now())
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn get_thread(&self, id: ThreadId) -> Result<ThreadDetail, ProductError> {
        let thread = self
            .storage
            .get_thread(id)
            .await?
            .ok_or_else(|| ProductError::NotFound(format!("thread {id}")))?;
        let interactions = self.storage.list_interactions(id).await?;
        Ok(ThreadDetail {
            thread,
            interactions,
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
            .insert_interaction(thread_id, text, &now())
            .await
            .map_err(Into::into)
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
