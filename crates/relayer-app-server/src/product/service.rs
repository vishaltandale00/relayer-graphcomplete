use super::{
    ActionInvocation, CatalogError, CreateModelFamilyCommand, Interaction, InteractionId,
    InteractionModelSelection, ModelFamily, ModelFamilyId, ModelFamilyKind, ModelSelection,
    ModelSettings, ModelSettingsDefaults, ProductCapabilities, ProductState, Project, ProjectId,
    ProviderCatalogSnapshot, ReorderModelFamiliesCommand, Thread, ThreadId, ThreadView,
    UpdateModelFamilyCommand, UpdateModelSettingsDefaultsCommand, ValidateModelSelectionCommand,
    validate_family,
};
use crate::storage::{
    ActionInvocationInsertOutcome, NewThreadRecord, SqliteProductStore, StorageError,
};
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
    pub(crate) model_selection: Option<InteractionModelSelection>,
    pub(crate) allow_unselected_model: bool,
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
    Catalog(#[from] CatalogError),
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

    pub(crate) async fn model_settings(&self) -> Result<ModelSettings, ProductError> {
        self.storage.load_model_settings().await.map_err(Into::into)
    }

    pub(crate) async fn harness_uses_configuration_model(
        &self,
        harness_id: &str,
    ) -> Result<bool, ProductError> {
        let settings = self.storage.load_model_settings().await?;
        Ok(settings.harnesses.iter().any(|harness| {
            harness.id == harness_id
                && harness.available
                && harness.model_compatibility.is_empty()
                && harness.compatible_provider_ids.is_empty()
        }))
    }

    pub(crate) async fn update_model_settings_defaults(
        &self,
        command: UpdateModelSettingsDefaultsCommand,
    ) -> Result<ModelSettingsDefaults, ProductError> {
        let settings = self.storage.load_model_settings().await?;
        if let Some(harness_id) = command.harness_id.as_ref() {
            let harness = settings
                .harnesses
                .iter()
                .find(|harness| &harness.id == harness_id)
                .ok_or_else(|| {
                    CatalogError::invalid("harness_unknown", "Unknown product harness.")
                })?;
            if !harness.available {
                return Err(CatalogError::invalid(
                    "harness_unavailable",
                    "The selected harness is unavailable.",
                )
                .into());
            }
        }
        if let Some(provider_id) = command.provider_id.as_ref() {
            let provider = settings
                .providers
                .iter()
                .find(|provider| &provider.id == provider_id)
                .ok_or_else(|| CatalogError::invalid("provider_unknown", "Unknown provider."))?;
            if !provider.connected {
                return Err(CatalogError::invalid(
                    "provider_disconnected",
                    "The selected provider is not connected.",
                )
                .into());
            }
        }
        self.storage
            .update_model_settings_defaults(&command)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn publish_provider_catalog(
        &self,
        mut snapshot: ProviderCatalogSnapshot,
    ) -> Result<(), ProductError> {
        if !snapshot.connected && snapshot.unavailable_reason.is_none() {
            snapshot.unavailable_reason = Some(super::UnavailableReason {
                code: "provider_disconnected".into(),
                message: "The provider is not connected.".into(),
            });
        }
        validate_provider_snapshot(&snapshot)?;
        self.storage
            .publish_provider_catalog(&snapshot, &now())
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn create_model_family(
        &self,
        mut command: CreateModelFamilyCommand,
    ) -> Result<ModelFamily, ProductError> {
        command.name = validate_family(&command.name, &command.members)?;
        self.ensure_unique_family_name(&command.name, None).await?;
        normalize_member_positions(&mut command.members);
        self.ensure_known_models(&command.members).await?;
        self.storage
            .create_model_family(&command)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn update_model_family(
        &self,
        mut command: UpdateModelFamilyCommand,
    ) -> Result<ModelFamily, ProductError> {
        let current = self
            .storage
            .get_model_family(command.id)
            .await?
            .ok_or_else(|| {
                ProductError::NotFound(format!("model family {}", command.id.value()))
            })?;
        match current.kind {
            ModelFamilyKind::System => {
                if command.name.is_some() || command.members.is_some() {
                    return Err(CatalogError::invalid(
                        "system_family_read_only",
                        "System model-family names and membership are read-only.",
                    )
                    .into());
                }
            }
            ModelFamilyKind::Custom => {
                let name = command.name.as_deref().unwrap_or(&current.name);
                let members = command.members.as_deref().unwrap_or(&current.members);
                command.name = Some(validate_family(name, members)?);
                self.ensure_unique_family_name(
                    command.name.as_deref().expect("validated family name"),
                    Some(command.id),
                )
                .await?;
                if let Some(members) = &mut command.members {
                    normalize_member_positions(members);
                    self.ensure_known_models(members).await?;
                }
            }
        }
        self.storage
            .update_model_family(&command)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn delete_model_family(&self, id: ModelFamilyId) -> Result<(), ProductError> {
        let current = self
            .storage
            .get_model_family(id)
            .await?
            .ok_or_else(|| ProductError::NotFound(format!("model family {}", id.value())))?;
        if current.kind == ModelFamilyKind::System {
            return Err(CatalogError::invalid(
                "system_family_read_only",
                "System model families cannot be deleted.",
            )
            .into());
        }
        if !self.storage.delete_model_family(id).await? {
            return Err(ProductError::NotFound(format!(
                "model family {}",
                id.value()
            )));
        }
        Ok(())
    }

    pub(crate) async fn reorder_model_families(
        &self,
        command: ReorderModelFamiliesCommand,
    ) -> Result<(), ProductError> {
        self.storage.reorder_model_families(&command).await?;
        Ok(())
    }

    pub(crate) async fn resolve_model_selection(
        &self,
        command: ValidateModelSelectionCommand,
    ) -> Result<ModelSelection, ProductError> {
        self.storage.validate_model_selection(&command).await?;
        Ok(ModelSelection {
            harness_id: command.harness_id,
            family_id: command.family_id,
            provider_id: command.provider_id,
            model_id: command.model_id,
        })
    }

    pub(crate) async fn validate_interaction_model_selection(
        &self,
        harness_id: &str,
        selection: &InteractionModelSelection,
    ) -> Result<(), ProductError> {
        self.resolve_model_selection(ValidateModelSelectionCommand {
            harness_id: harness_id.to_owned(),
            family_id: selection.family_id,
            provider_id: selection.provider_id.clone(),
            model_id: selection.model_id.clone(),
        })
        .await
        .map(|_| ())
    }

    pub(crate) async fn validate_execution_model_selection(
        &self,
        harness_id: &str,
        selection: &InteractionModelSelection,
    ) -> Result<(), ProductError> {
        self.storage
            .validate_execution_model_selection(harness_id, selection)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn first_available_model(
        &self,
        harness_id: &str,
    ) -> Result<Option<ModelSelection>, ProductError> {
        let settings = self.storage.load_model_settings().await?;
        for family in settings.families.iter().filter(|family| family.enabled) {
            for member in &family.members {
                let command = ValidateModelSelectionCommand {
                    harness_id: harness_id.to_owned(),
                    family_id: family.id,
                    provider_id: member.provider_id.clone(),
                    model_id: member.model_id.clone(),
                };
                if self
                    .storage
                    .validate_model_selection(&command)
                    .await
                    .is_ok()
                {
                    return Ok(Some(ModelSelection {
                        harness_id: command.harness_id,
                        family_id: command.family_id,
                        provider_id: command.provider_id,
                        model_id: command.model_id,
                    }));
                }
            }
        }
        Ok(None)
    }

    async fn ensure_known_models(
        &self,
        members: &[super::ModelFamilyMember],
    ) -> Result<(), ProductError> {
        let settings = self.storage.load_model_settings().await?;
        for member in members {
            let known = settings.providers.iter().any(|provider| {
                provider.id == member.provider_id
                    && provider
                        .models
                        .iter()
                        .any(|model| model.id == member.model_id)
            });
            if !known {
                return Err(CatalogError::invalid(
                    "provider_model_unknown",
                    format!(
                        "Unknown provider model {}/{}.",
                        member.provider_id.as_str(),
                        member.model_id
                    ),
                )
                .into());
            }
        }
        Ok(())
    }

    async fn ensure_unique_family_name(
        &self,
        name: &str,
        except_id: Option<ModelFamilyId>,
    ) -> Result<(), ProductError> {
        let duplicate = self
            .storage
            .load_model_settings()
            .await?
            .families
            .into_iter()
            .any(|family| Some(family.id) != except_id && family.name.eq_ignore_ascii_case(name));
        if duplicate {
            return Err(CatalogError::invalid(
                "model_family_name_duplicate",
                "A model family with this name already exists.",
            )
            .into());
        }
        Ok(())
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
        match command.model_selection.as_ref() {
            Some(selection) => {
                self.validate_interaction_model_selection(
                    &command.harness_configuration_name,
                    selection,
                )
                .await?;
            }
            None if self.runtime_available && !command.allow_unselected_model => {
                return Err(CatalogError::invalid(
                    "model_selection_required",
                    "A model selection is required before creating a thread.",
                )
                .into());
            }
            None => {}
        }
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
        let timestamp = now();
        self.storage
            .insert_thread_with_initial_interaction(NewThreadRecord {
                title: &title,
                project_id: command.project_id,
                initial_message: message,
                harness_configuration_name: &command.harness_configuration_name,
                permission_profile_id: &command.permission_profile_id,
                model_selection: command.model_selection.as_ref(),
                timestamp: &timestamp,
            })
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
        model_selection: Option<&InteractionModelSelection>,
        allow_unselected_model: bool,
    ) -> Result<Interaction, ProductError> {
        let text = required(text, "text")?;
        if self.storage.get_thread(thread_id).await?.is_none() {
            return Err(ProductError::NotFound(format!("thread {thread_id}")));
        }
        self.storage
            .insert_interaction(
                thread_id,
                text,
                model_selection,
                self.runtime_available && !allow_unselected_model,
                self.runtime_available,
            )
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
        if let Some(existing) = self
            .get_action_invocation(source_interaction_id, action_id)
            .await?
        {
            return Ok(existing);
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

fn normalize_member_positions(members: &mut [super::ModelFamilyMember]) {
    for (position, member) in members.iter_mut().enumerate() {
        member.position = position;
    }
}

fn validate_provider_snapshot(snapshot: &ProviderCatalogSnapshot) -> Result<(), CatalogError> {
    super::catalog::validate_stable_id(snapshot.provider_id.as_str(), "providerId")?;
    if snapshot.label.trim().is_empty() {
        return Err(CatalogError::invalid(
            "provider_label_required",
            "provider label must be non-empty",
        ));
    }
    let mut ids = std::collections::HashSet::new();
    let mut orders = std::collections::HashSet::new();
    let mut provider_defaults = 0;
    for model in &snapshot.models {
        super::catalog::validate_stable_id(&model.id, "modelId")?;
        if !ids.insert(model.id.as_str()) {
            return Err(CatalogError::invalid(
                "provider_model_duplicate",
                "provider snapshot contains a duplicate model ID",
            ));
        }
        if !orders.insert(model.order) {
            return Err(CatalogError::invalid(
                "provider_model_order_duplicate",
                "provider snapshot contains duplicate model ordering",
            ));
        }
        if model.label.trim().is_empty() {
            return Err(CatalogError::invalid(
                "model_label_required",
                "model label must be non-empty",
            ));
        }
        if model.available && model.unavailable_reason.is_some() {
            return Err(CatalogError::invalid(
                "model_availability_invalid",
                "available models cannot carry an unavailable reason",
            ));
        }
        if !model.available && model.unavailable_reason.is_none() {
            return Err(CatalogError::invalid(
                "model_availability_invalid",
                "an unavailable model must include an unavailable reason",
            ));
        }
        provider_defaults += usize::from(model.provider_default);
    }
    if provider_defaults > 1 {
        return Err(CatalogError::invalid(
            "provider_default_duplicate",
            "provider snapshot cannot declare more than one default model",
        ));
    }
    if let Some(family) = &snapshot.system_family {
        if family.model_ids.len() > 5 {
            return Err(CatalogError::invalid(
                "system_family_size_invalid",
                "system family cannot contain more than five models",
            ));
        }
        if family.model_ids.is_empty() {
            if snapshot.connected && snapshot.models.iter().any(|model| model.visible) {
                return Err(CatalogError::invalid(
                    "system_family_size_invalid",
                    "a connected provider with visible models must publish its system family",
                ));
            }
            return Ok(());
        }
        if family.key.trim().is_empty() || family.name.trim().is_empty() {
            return Err(CatalogError::invalid(
                "system_family_identity_invalid",
                "system family key and name must be non-empty",
            ));
        }
        let mut visible = snapshot
            .models
            .iter()
            .filter(|model| model.visible)
            .collect::<Vec<_>>();
        visible.sort_by_key(|model| model.order);
        let expected = visible.into_iter().take(5).map(|model| model.id.as_str());
        if !family.model_ids.iter().map(String::as_str).eq(expected) {
            return Err(CatalogError::invalid(
                "system_family_members_invalid",
                "system family must contain the first five visible provider models in provider order",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::product::{HarnessModelCompatibility, ProviderId, RuntimeProductHarness};

    #[tokio::test]
    async fn configuration_model_exemption_is_scoped_to_the_selected_harness() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "relayer-configuration-model-harness-{}-{unique}.sqlite3",
            std::process::id()
        ));
        let storage = SqliteProductStore::open(&path).await.unwrap();
        storage
            .initialize_model_catalog("prime-agent-basic", &runtime_harnesses())
            .await
            .unwrap();
        let service = ProductService::new(storage.clone(), true);

        assert!(
            service
                .harness_uses_configuration_model("prime-agent-basic")
                .await
                .unwrap()
        );
        assert!(
            !service
                .harness_uses_configuration_model("codex-basic")
                .await
                .unwrap()
        );

        drop(service);
        drop(storage);
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn runtime_default_changes_until_the_user_modifies_defaults() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "relayer-runtime-default-harness-{}-{unique}.sqlite3",
            std::process::id()
        ));
        let storage = SqliteProductStore::open(&path).await.unwrap();
        storage
            .initialize_model_catalog("prime-agent-basic", &runtime_harnesses())
            .await
            .unwrap();
        assert_eq!(
            storage
                .load_model_settings()
                .await
                .unwrap()
                .defaults
                .harness_id,
            "prime-agent-basic"
        );

        storage
            .initialize_model_catalog("codex-basic", &runtime_harnesses())
            .await
            .unwrap();
        assert_eq!(
            storage
                .load_model_settings()
                .await
                .unwrap()
                .defaults
                .harness_id,
            "codex-basic"
        );

        storage
            .update_model_settings_defaults(&UpdateModelSettingsDefaultsCommand {
                harness_id: Some("prime-agent-basic".into()),
                provider_id: None,
            })
            .await
            .unwrap();
        storage
            .initialize_model_catalog("codex-basic", &runtime_harnesses())
            .await
            .unwrap();
        assert_eq!(
            storage
                .load_model_settings()
                .await
                .unwrap()
                .defaults
                .harness_id,
            "prime-agent-basic"
        );

        drop(storage);
        std::fs::remove_file(path).unwrap();
    }

    fn runtime_harnesses() -> Vec<RuntimeProductHarness> {
        vec![
            RuntimeProductHarness {
                id: "prime-agent-basic".into(),
                model_compatibility: vec![],
            },
            RuntimeProductHarness {
                id: "codex-basic".into(),
                model_compatibility: vec![HarnessModelCompatibility {
                    provider_id: ProviderId::parse("codex").unwrap(),
                    model_ids: None,
                    preferred_model_id: None,
                }],
            },
        ]
    }
}
