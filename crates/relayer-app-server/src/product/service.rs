use super::{
    ActionInvocation, Annotation, AnnotationAnchor, AnnotationState, BeginInteractionAttempt,
    CatalogError, CreateModelFamilyCommand, FamilyPolicyReference, Interaction, InteractionId,
    InteractionModelSelection, MAX_ANNOTATION_SNAPSHOT_THREADS, ModelFamily, ModelFamilyId,
    ModelFamilyKind, ModelSelection, ModelSettings, ModelSettingsDefaults, NewAnnotationRevision,
    ProductCapabilities, ProductState, Project, ProjectId, ProviderCatalogSnapshot,
    ReorderModelFamiliesCommand, SystemFamilySnapshot, Thread, ThreadId, ThreadView,
    UpdateModelFamilyCommand, UpdateModelSettingsDefaultsCommand, ValidateModelSelectionCommand,
    validate_family, validate_revision_content,
};
use crate::approval::{ApprovalReceipt, ApprovalRequest, ApprovalResolution};
use crate::storage::{
    ActionInvocationInsertOutcome, ConversationImportRecord, NewConversationImport,
    NewInteractionInput, NewThreadRecord, SqliteProductStore, StagedConversationImport,
    StorageError,
};
use std::collections::HashSet;
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

pub(crate) struct RetryInteractionCommand<'a> {
    pub(crate) expected_attempt_id: i64,
    pub(crate) text: &'a str,
    pub(crate) input_identity: &'a str,
    pub(crate) contexts: &'a [super::InteractionContextIntent],
    pub(crate) model_selection: &'a InteractionModelSelection,
    pub(crate) harness_configuration_name: &'a str,
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

pub(crate) struct FailedInteractionCompletion<'a> {
    pub(crate) attempt_id: i64,
    pub(crate) interaction_id: InteractionId,
    pub(crate) harness_configuration_name: &'a str,
    pub(crate) error: &'a str,
    pub(crate) outcome: &'a str,
    pub(crate) failure_category: &'a str,
    pub(crate) effect_boundary: &'a str,
    pub(crate) return_to_unsent: bool,
    pub(crate) graph_node_id: Option<i64>,
}

pub(crate) struct PreparedInteractionBinding<'a> {
    pub(crate) interaction_id: InteractionId,
    pub(crate) graph_node_id: i64,
    pub(crate) harness_configuration_name: &'a str,
    pub(crate) harness_configuration_digest: &'a str,
    pub(crate) effective_execution_digest: &'a str,
    pub(crate) effective_permission_receipt: &'a serde_json::Value,
}

pub(crate) struct ProjectWriteOutcome {
    pub(crate) project: Project,
    pub(crate) created: bool,
}

pub(crate) struct ThreadDetail {
    pub(crate) thread: Thread,
    pub(crate) project: Option<Project>,
    pub(crate) interactions: Vec<Interaction>,
    pub(crate) action_invocations: Vec<ActionInvocation>,
    pub(crate) approvals: Vec<ApprovalReceipt>,
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
    pub(crate) async fn update_harness_model_rules(
        &self,
        command: super::UpdateHarnessModelRulesCommand,
    ) -> Result<u32, ProductError> {
        super::validate_stable_id(&command.harness_id, "harnessId")?;
        super::validate_harness_model_rules(&command.rules)?;
        self.storage
            .update_harness_model_rules(&command)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn provider_definitions(
        &self,
    ) -> Result<Vec<super::ProviderDefinition>, ProductError> {
        self.storage
            .load_provider_definitions()
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn sync_provider_definitions(
        &self,
        definitions: Vec<super::ProviderDefinition>,
    ) -> Result<(), ProductError> {
        let mut ids = std::collections::HashSet::new();
        for definition in &definitions {
            super::validate_stable_id(definition.id.as_str(), "providerId")?;
            super::validate_stable_id(&definition.adapter_id, "adapterId")?;
            if definition.label.trim().is_empty() || !ids.insert(definition.id.as_str()) {
                return Err(super::CatalogError::invalid(
                    "provider_definition_invalid",
                    "Provider definitions require unique ids and non-empty labels.",
                )
                .into());
            }
        }
        self.storage
            .sync_provider_definitions(&definitions)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn create_provider_with_catalog(
        &self,
        definition: super::ProviderDefinition,
        mut snapshot: ProviderCatalogSnapshot,
    ) -> Result<(), ProductError> {
        if definition.id != snapshot.provider_id || definition.lifecycle_state != "active" {
            return Err(super::CatalogError::invalid(
                "provider_definition_invalid",
                "Staged provider identity must match its catalog and be active.",
            )
            .into());
        }
        super::validate_stable_id(definition.id.as_str(), "providerId")?;
        super::validate_stable_id(&definition.adapter_id, "adapterId")?;
        if !snapshot.connected {
            return Err(super::CatalogError::invalid(
                "provider_disconnected",
                "A provider must be connected before it can be created.",
            )
            .into());
        }
        if !snapshot.models.iter().any(|model| model.visible) {
            return Err(super::CatalogError::invalid(
                "provider_catalog_empty",
                "A provider must expose at least one visible model before it can be created.",
            )
            .into());
        }
        let managed_policy = self
            .apply_default_harness_family_policy(&definition, &mut snapshot)
            .await?;
        validate_provider_snapshot(&snapshot, managed_policy.as_ref())?;
        self.storage
            .create_provider_with_catalog(&definition, &snapshot, managed_policy.as_ref(), &now())
            .await
            .map_err(Into::into)
    }

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

    pub(crate) async fn list_annotations(
        &self,
        thread_id: ThreadId,
    ) -> Result<Vec<Annotation>, ProductError> {
        if self.storage.get_thread(thread_id).await?.is_none() {
            return Err(ProductError::NotFound(format!("thread {thread_id}")));
        }
        self.storage
            .list_annotations(thread_id)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn snapshot_annotations(
        &self,
        thread_ids: &[ThreadId],
    ) -> Result<Vec<(ThreadId, Vec<Annotation>)>, ProductError> {
        if thread_ids.is_empty() || thread_ids.len() > MAX_ANNOTATION_SNAPSHOT_THREADS {
            return Err(ProductError::Invalid(format!(
                "annotation snapshot must request 1 to {MAX_ANNOTATION_SNAPSHOT_THREADS} threads"
            )));
        }
        if thread_ids
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != thread_ids.len()
        {
            return Err(ProductError::Invalid(
                "annotation snapshot thread IDs must be unique".into(),
            ));
        }
        self.storage
            .snapshot_annotations(thread_ids)
            .await?
            .ok_or_else(|| ProductError::NotFound("annotation snapshot thread".into()))
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn create_annotation(
        &self,
        thread_id: ThreadId,
        anchor: AnnotationAnchor,
        author_id: &str,
        author_display_name: &str,
        comment: &str,
        rating: Option<u8>,
        navigation_context: &serde_json::Value,
        evidence_refs: &[String],
    ) -> Result<Annotation, ProductError> {
        self.ensure_annotation_anchor_thread(thread_id, &anchor)
            .await?;
        let comment = validate_revision_content(
            comment,
            rating,
            AnnotationState::Active,
            navigation_context,
            evidence_refs,
        )
        .map_err(ProductError::Invalid)?;
        let timestamp = now();
        self.storage
            .create_annotation(
                thread_id,
                &anchor,
                NewAnnotationRevision {
                    author_id,
                    author_display_name,
                    comment: &comment,
                    rating,
                    state: AnnotationState::Active,
                    navigation_context,
                    evidence_refs,
                    created_at: &timestamp,
                },
            )
            .await
            .map_err(Into::into)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn revise_annotation(
        &self,
        thread_id: ThreadId,
        annotation_id: i64,
        expected_revision: i64,
        author_id: &str,
        author_display_name: &str,
        comment: &str,
        rating: Option<u8>,
        navigation_context: &serde_json::Value,
        evidence_refs: &[String],
    ) -> Result<Annotation, ProductError> {
        if annotation_id <= 0 || expected_revision <= 0 {
            return Err(ProductError::Invalid(
                "annotation ID and expected revision must be positive integers".into(),
            ));
        }
        let comment = validate_revision_content(
            comment,
            rating,
            AnnotationState::Active,
            navigation_context,
            evidence_refs,
        )
        .map_err(ProductError::Invalid)?;
        let timestamp = now();
        self.storage
            .append_annotation_revision(
                thread_id,
                annotation_id,
                expected_revision,
                NewAnnotationRevision {
                    author_id,
                    author_display_name,
                    comment: &comment,
                    rating,
                    state: AnnotationState::Active,
                    navigation_context,
                    evidence_refs,
                    created_at: &timestamp,
                },
            )
            .await
            .map_err(Into::into)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn retract_annotation(
        &self,
        thread_id: ThreadId,
        annotation_id: i64,
        expected_revision: i64,
        author_id: &str,
        author_display_name: &str,
        navigation_context: &serde_json::Value,
        evidence_refs: &[String],
    ) -> Result<Annotation, ProductError> {
        if annotation_id <= 0 || expected_revision <= 0 {
            return Err(ProductError::Invalid(
                "annotation ID and expected revision must be positive integers".into(),
            ));
        }
        validate_revision_content(
            "",
            None,
            AnnotationState::Retracted,
            navigation_context,
            evidence_refs,
        )
        .map_err(ProductError::Invalid)?;
        let timestamp = now();
        self.storage
            .append_annotation_revision(
                thread_id,
                annotation_id,
                expected_revision,
                NewAnnotationRevision {
                    author_id,
                    author_display_name,
                    comment: "",
                    rating: None,
                    state: AnnotationState::Retracted,
                    navigation_context,
                    evidence_refs,
                    created_at: &timestamp,
                },
            )
            .await
            .map_err(Into::into)
    }

    async fn ensure_annotation_anchor_thread(
        &self,
        thread_id: ThreadId,
        anchor: &AnnotationAnchor,
    ) -> Result<(), ProductError> {
        anchor.validate_ids().map_err(ProductError::Invalid)?;
        if self.storage.get_thread(thread_id).await?.is_none() {
            return Err(ProductError::NotFound(format!("thread {thread_id}")));
        }
        if let Some(interaction_id) = anchor.interaction_id() {
            let interaction = self
                .get_interaction(
                    interaction_id.map_err(|error| ProductError::Invalid(error.to_string()))?,
                )
                .await?;
            if interaction.thread_id != thread_id {
                return Err(ProductError::Invalid(
                    "annotation interaction does not belong to this thread".into(),
                ));
            }
        }
        Ok(())
    }

    pub(crate) async fn model_settings(&self) -> Result<ModelSettings, ProductError> {
        self.storage.load_model_settings().await.map_err(Into::into)
    }

    pub(crate) async fn provider_onboarding_projection(
        &self,
        provider_id: &super::ProviderId,
        app_default_harness_id: &str,
        permission_available_harnesses: &HashSet<String>,
    ) -> Result<super::ProviderOnboardingProjection, ProductError> {
        self.storage
            .provider_onboarding_projection(
                provider_id,
                app_default_harness_id,
                permission_available_harnesses,
            )
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn complete_provider_onboarding(
        &self,
        command: &super::CompleteProviderOnboardingCommand,
        app_default_harness_id: &str,
        permission_available_harnesses: &HashSet<String>,
    ) -> Result<super::ProviderOnboardingCompletion, ProductError> {
        self.storage
            .complete_provider_onboarding(
                command,
                app_default_harness_id,
                permission_available_harnesses,
            )
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn complete_default_provider_onboarding(
        &self,
        provider_id: &super::ProviderId,
        app_default_harness_id: &str,
        permission_available_harnesses: &HashSet<String>,
    ) -> Result<Option<super::ProviderOnboardingCompletion>, ProductError> {
        let projection = self
            .provider_onboarding_projection(
                provider_id,
                app_default_harness_id,
                permission_available_harnesses,
            )
            .await?;
        let mut candidates = projection
            .harnesses
            .iter()
            .filter(|harness| harness.selectable)
            .filter_map(|harness| {
                harness
                    .managed_family_candidate
                    .as_ref()
                    .map(|family| (harness, family))
            })
            .collect::<Vec<_>>();
        let Some((_, policy)) = candidates.first().copied() else {
            return Ok(None);
        };
        if candidates.iter().any(|(_, candidate)| {
            candidate.policy_id != policy.policy_id
                || candidate.policy_version != policy.policy_version
        }) {
            return Ok(None);
        }
        candidates.sort_by(|(left, _), (right, _)| left.id.cmp(&right.id));
        let (harness, policy) = candidates
            .iter()
            .copied()
            .find(|(harness, _)| harness.id == projection.app_default_harness_id)
            .unwrap_or(candidates[0]);
        self.complete_provider_onboarding(
            &super::CompleteProviderOnboardingCommand {
                provider_id: provider_id.clone(),
                harness_id: harness.id.clone(),
                expected_projection_revision: projection.projection_revision,
                family: super::ProviderOnboardingFamilyIntent::Managed {
                    policy_id: policy.policy_id.clone(),
                    policy_version: policy.policy_version,
                },
            },
            app_default_harness_id,
            permission_available_harnesses,
        )
        .await
        .map(Some)
    }

    pub(crate) async fn provider_onboarding_status(
        &self,
        permission_available_harnesses: &HashSet<String>,
    ) -> Result<super::ProviderOnboardingStatus, ProductError> {
        self.storage
            .provider_onboarding_status(permission_available_harnesses)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn execution_harness_policy(
        &self,
        harness_id: &str,
    ) -> Result<super::ExecutionHarnessPolicy, ProductError> {
        self.storage
            .load_execution_harness_policy(harness_id)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn harness_uses_configuration_model(
        &self,
        harness_id: &str,
    ) -> Result<bool, ProductError> {
        let settings = self.storage.load_model_settings().await?;
        Ok(settings.harnesses.iter().any(|harness| {
            harness.id == harness_id
                && harness.available
                && harness.model_rules.is_none()
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
        let definition = self
            .storage
            .load_provider_definitions()
            .await?
            .into_iter()
            .find(|definition| definition.id == snapshot.provider_id)
            .ok_or_else(|| {
                ProductError::NotFound(format!("provider {}", snapshot.provider_id.as_str()))
            })?;
        if definition.lifecycle_state != "active" {
            return Err(super::CatalogError::invalid(
                "provider_not_active",
                "Only active provider definitions can publish model catalogs.",
            )
            .into());
        }
        let managed_policy = self
            .apply_default_harness_family_policy(&definition, &mut snapshot)
            .await?;
        validate_provider_snapshot(&snapshot, managed_policy.as_ref())?;
        match self
            .storage
            .publish_provider_catalog(&snapshot, managed_policy.as_ref(), &now())
            .await
        {
            Ok(()) => Ok(()),
            Err(error) => {
                eprintln!(
                    "managed catalog reconciliation for provider {} failed; the prior family/default transaction was retained and the next refresh will retry: {error}",
                    snapshot.provider_id.as_str()
                );
                Err(error.into())
            }
        }
    }

    async fn apply_default_harness_family_policy(
        &self,
        definition: &super::ProviderDefinition,
        snapshot: &mut ProviderCatalogSnapshot,
    ) -> Result<Option<FamilyPolicyReference>, ProductError> {
        // Provider adapters may report normalized metadata, but never author family membership.
        snapshot.system_family = None;
        if !snapshot.connected {
            return Ok(None);
        }
        let settings = self.storage.load_model_settings().await?;
        let policy = settings
            .harnesses
            .iter()
            .find(|harness| harness.id == settings.defaults.harness_id)
            .and_then(|harness| harness.family_policy.clone());
        let Some(policy) = policy.filter(|policy| {
            super::model_policy::applies_to_adapter(policy, &definition.adapter_id)
        }) else {
            return Ok(None);
        };
        let members = match super::model_policy::derive_managed_family_members(&policy, snapshot) {
            Ok(members) => members,
            Err(error) => {
                eprintln!(
                    "managed family policy {}@{} for provider {} could not be applied; the prior family/default remains and the next refresh will retry: {error}",
                    policy.id,
                    policy.version,
                    snapshot.provider_id.as_str()
                );
                return Err(error.into());
            }
        };
        if members.is_empty() {
            let error = super::CatalogError::invalid(
                "family_policy_empty",
                format!(
                    "Model-family policy {}@{} did not resolve any visible default models.",
                    policy.id, policy.version
                ),
            );
            eprintln!(
                "managed family policy {}@{} for provider {} produced no members; the prior family/default remains and the next refresh will retry",
                policy.id,
                policy.version,
                snapshot.provider_id.as_str()
            );
            return Err(error.into());
        }
        snapshot.system_family = Some(SystemFamilySnapshot {
            key: format!("{}@{}", policy.id, policy.version),
            name: format!("{} defaults", snapshot.label),
            model_ids: members.into_iter().map(|member| member.model_id).collect(),
        });
        Ok(Some(policy))
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
        let defaults = self.storage.load_model_settings().await?.defaults;
        if defaults.family_id == Some(command.id) && !command.enabled {
            return Err(CatalogError::invalid(
                "default_family_disable_blocked",
                "Change the default model family before disabling it.",
            )
            .into());
        }
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
                    if *members == current.members {
                        command.members = None;
                    }
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
        if self.storage.load_model_settings().await?.defaults.family_id == Some(id) {
            return Err(CatalogError::invalid(
                "default_family_removal_blocked",
                "Change the default model family before removing it.",
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
    ) -> Result<super::ExecutionModelSelection, ProductError> {
        self.storage
            .validate_execution_model_selection(harness_id, selection)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn resolve_execution_model_plan(
        &self,
        harness_id: &str,
        selection: &InteractionModelSelection,
    ) -> Result<(super::ExecutionModelPlan, super::ExecutionModelSelection), ProductError> {
        self.storage
            .resolve_execution_model_plan(harness_id, selection)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn first_available_model(
        &self,
        harness_id: &str,
    ) -> Result<Option<ModelSelection>, ProductError> {
        let settings = self.storage.load_model_settings().await?;
        let Some(default_id) = settings.defaults.family_id else {
            return Ok(None);
        };
        let families = settings
            .families
            .iter()
            .filter(move |family| family.id == default_id && family.enabled);
        for family in families {
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
            approvals: snapshot.approvals,
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
        let path = stored_project_path(&canonical_path)?;
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
            project: snapshot.project,
            interactions: snapshot.interactions,
            action_invocations: snapshot.action_invocations,
            approvals: snapshot.approvals,
        })
    }

    pub(crate) async fn create_interaction(
        &self,
        thread_id: ThreadId,
        text: &str,
        model_selection: Option<&InteractionModelSelection>,
        allow_unselected_model: bool,
    ) -> Result<Interaction, ProductError> {
        let text = required(text, "text")?;
        if self.storage.thread_is_imported(thread_id).await? {
            return Err(ProductError::Invalid(
                "imported conversations are immutable".into(),
            ));
        }
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

    pub(crate) async fn create_identified_interaction(
        &self,
        thread_id: ThreadId,
        text: &str,
        input_identity: &str,
        contexts: &[super::InteractionContextIntent],
        model_selection: Option<&InteractionModelSelection>,
        allow_unselected_model: bool,
    ) -> Result<crate::storage::InteractionInputInsertOutcome, ProductError> {
        let input_identity = required(input_identity, "inputId")?;
        let input_digest = validated_interaction_input_digest(text, contexts)?;
        if self.storage.thread_is_imported(thread_id).await? {
            return Err(ProductError::Invalid(
                "imported conversations are immutable".into(),
            ));
        }
        self.storage
            .insert_interaction_input(
                thread_id,
                crate::storage::NewInteractionInput {
                    text,
                    input_identity,
                    input_digest: &input_digest,
                    contexts,
                },
                model_selection,
                self.runtime_available && !allow_unselected_model,
                self.runtime_available,
            )
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn interaction_input(
        &self,
        interaction_id: InteractionId,
    ) -> Result<Option<super::DurableInteractionInput>, ProductError> {
        self.storage
            .interaction_input(interaction_id)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn interrupted_interactions(&self) -> Result<Vec<Interaction>, ProductError> {
        self.storage
            .interrupted_interactions()
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn restore_identified_interaction_submitted(
        &self,
        interaction_id: InteractionId,
        error: &str,
    ) -> Result<bool, ProductError> {
        self.storage
            .restore_identified_interaction_submitted(interaction_id, error)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn discard_unbound_interaction_input(
        &self,
        interaction_id: InteractionId,
    ) -> Result<bool, ProductError> {
        self.storage
            .discard_unbound_interaction_input(interaction_id)
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
        let source = self.get_interaction(source_interaction_id).await?;
        if self.storage.thread_is_imported(source.thread_id).await? {
            return Err(ProductError::Invalid(
                "imported conversation actions cannot execute".into(),
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

    pub(crate) async fn stage_conversation_import(
        &self,
        input: NewConversationImport<'_>,
    ) -> Result<StagedConversationImport, ProductError> {
        self.storage
            .stage_conversation_import(input)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn append_conversation_import_turn(
        &self,
        import_id: &str,
        turn: &crate::conversation_export::ConversationExportTurn,
    ) -> Result<crate::storage::StagedConversationTurnSummary, ProductError> {
        self.storage
            .append_conversation_import_turn(import_id, turn)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn finalize_conversation_import_digest(
        &self,
        import_id: &str,
        source_sha256: &str,
    ) -> Result<(), ProductError> {
        self.storage
            .finalize_conversation_import_digest(import_id, source_sha256)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn staged_conversation_import(
        &self,
        import_id: &str,
    ) -> Result<StagedConversationImport, ProductError> {
        self.storage
            .staged_conversation_import(import_id)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn imported_turn_export_records(
        &self,
        thread_id: ThreadId,
    ) -> Result<Vec<crate::storage::ImportedTurnExportRecord>, ProductError> {
        self.storage
            .imported_turn_export_records(thread_id)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn staged_conversation_turn(
        &self,
        import_id: &str,
        source_turn_id: &str,
    ) -> Result<crate::conversation_export::ConversationExportTurn, ProductError> {
        self.storage
            .staged_conversation_turn(import_id, source_turn_id)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn prepare_conversation_import_turn(
        &self,
        import_id: &str,
        source_turn_id: &str,
        graph_node_id: Option<i64>,
        output: Option<&serde_json::Value>,
    ) -> Result<(), ProductError> {
        self.storage
            .prepare_conversation_import_turn(import_id, source_turn_id, graph_node_id, output)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn publish_conversation_import(
        &self,
        import_id: &str,
        published_at: &str,
    ) -> Result<(), ProductError> {
        self.storage
            .publish_conversation_import(import_id, published_at)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn remove_conversation_import(
        &self,
        import_id: &str,
    ) -> Result<(), ProductError> {
        self.storage
            .remove_conversation_import(import_id)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn list_published_conversation_imports(
        &self,
    ) -> Result<Vec<ConversationImportRecord>, ProductError> {
        self.storage
            .list_published_conversation_imports()
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn permits_unselected_action_execution(
        &self,
        interaction_id: InteractionId,
    ) -> Result<bool, ProductError> {
        self.storage
            .permits_unselected_action_execution(interaction_id)
            .await
            .map_err(Into::into)
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

    pub(crate) async fn action_invocations_for_export(
        &self,
        thread_id: ThreadId,
    ) -> Result<Vec<ActionInvocation>, ProductError> {
        self.storage
            .action_invocations_for_export(thread_id)
            .await
            .map_err(Into::into)
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

    pub(crate) async fn get_interaction_by_graph_node_id(
        &self,
        graph_node_id: i64,
    ) -> Result<Interaction, ProductError> {
        self.storage
            .get_interaction_by_graph_node_id(graph_node_id)
            .await?
            .ok_or_else(|| ProductError::NotFound(format!("graph interaction {graph_node_id}")))
    }

    pub(crate) async fn claim_interaction_running(
        &self,
        interaction_id: super::InteractionId,
        harness_configuration_name: &str,
    ) -> Result<bool, ProductError> {
        self.ensure_interaction_mutable(interaction_id).await?;
        self.storage
            .claim_interaction_running(interaction_id, harness_configuration_name)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn claim_interaction_retry(
        &self,
        interaction_id: super::InteractionId,
        command: RetryInteractionCommand<'_>,
    ) -> Result<bool, ProductError> {
        let input_identity = required(command.input_identity, "inputId")?;
        let input_digest = validated_interaction_input_digest(command.text, command.contexts)?;
        self.storage
            .claim_interaction_retry(
                interaction_id,
                command.expected_attempt_id,
                NewInteractionInput {
                    text: command.text,
                    input_identity,
                    input_digest: &input_digest,
                    contexts: command.contexts,
                },
                command.model_selection,
                command.harness_configuration_name,
            )
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn restore_leased_interaction_submitted(
        &self,
        interaction_id: super::InteractionId,
        error: &str,
    ) -> Result<bool, ProductError> {
        self.storage
            .restore_leased_interaction_submitted(interaction_id, error)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn claim_interaction_preparing(
        &self,
        interaction_id: super::InteractionId,
    ) -> Result<bool, ProductError> {
        self.storage
            .claim_interaction_preparing(interaction_id)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn bind_prepared_interaction(
        &self,
        binding: PreparedInteractionBinding<'_>,
    ) -> Result<bool, ProductError> {
        self.storage
            .bind_prepared_interaction(binding)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn invocation_graph_source(
        &self,
        interaction_id: InteractionId,
    ) -> Result<Option<(i64, i64)>, ProductError> {
        self.storage
            .invocation_graph_source(interaction_id)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn invocation_requires_graph_lease(
        &self,
        interaction_id: InteractionId,
    ) -> Result<bool, ProductError> {
        self.storage
            .invocation_requires_graph_lease(interaction_id)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn terminate_legacy_action_invocation(
        &self,
        interaction_id: InteractionId,
        error: &str,
    ) -> Result<bool, ProductError> {
        self.storage
            .terminate_legacy_action_invocation(interaction_id, error)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn recover_interaction_accepted(
        &self,
        interaction_id: InteractionId,
        output: &serde_json::Value,
    ) -> Result<bool, ProductError> {
        self.storage
            .recover_interaction_accepted(interaction_id, output)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn accept_interaction_completion(
        &self,
        completion: AcceptedInteractionCompletion<'_>,
    ) -> Result<(), ProductError> {
        self.ensure_interaction_mutable(completion.interaction_id)
            .await?;
        self.storage
            .accept_interaction_completion(completion)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn accept_interaction_completion_with_attempt(
        &self,
        attempt_id: i64,
        completion: AcceptedInteractionCompletion<'_>,
    ) -> Result<(), ProductError> {
        self.storage
            .accept_interaction_completion_with_attempt(attempt_id, completion, &now())
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn fail_interaction_completion_with_attempt(
        &self,
        failure: FailedInteractionCompletion<'_>,
    ) -> Result<(), ProductError> {
        self.storage
            .fail_interaction_completion_with_attempt(failure, &now())
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn fail_interaction_completion(
        &self,
        interaction_id: super::InteractionId,
        harness_configuration_name: &str,
        error: &str,
    ) -> Result<bool, ProductError> {
        self.ensure_interaction_mutable(interaction_id).await?;
        self.storage
            .fail_interaction_completion(interaction_id, harness_configuration_name, error)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn begin_interaction_attempt(
        &self,
        receipt: BeginInteractionAttempt<'_>,
    ) -> Result<i64, ProductError> {
        self.storage
            .begin_interaction_attempt(receipt, &now())
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn record_model_attempt_admission_failure(
        &self,
        receipt: BeginInteractionAttempt<'_>,
        failure_category: &str,
        execution_lease_reconciled: bool,
    ) -> Result<i64, ProductError> {
        self.storage
            .record_model_attempt_admission_failure(
                receipt,
                failure_category,
                execution_lease_reconciled,
                &now(),
            )
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn record_pre_execution_model_failure(
        &self,
        failure: super::PreExecutionModelFailure<'_>,
    ) -> Result<i64, ProductError> {
        self.storage
            .record_pre_execution_model_failure(failure, &now())
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn execution_lease_debt(
        &self,
        attempt_id: i64,
    ) -> Result<Option<super::ExecutionLeaseDebt>, ProductError> {
        self.storage
            .execution_lease_debt(attempt_id)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn unreconciled_execution_lease_debts(
        &self,
    ) -> Result<Vec<super::ExecutionLeaseDebt>, ProductError> {
        self.storage
            .unreconciled_execution_lease_debts()
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn acknowledge_execution_lease_reconciled(
        &self,
        attempt_id: i64,
        execution_lease_id: &str,
    ) -> Result<bool, ProductError> {
        self.storage
            .acknowledge_execution_lease_reconciled(attempt_id, execution_lease_id, &now())
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn return_interaction_to_unsent(
        &self,
        interaction_id: super::InteractionId,
        harness_configuration_name: &str,
    ) -> Result<(), ProductError> {
        self.storage
            .return_interaction_to_unsent(interaction_id, harness_configuration_name)
            .await
            .map_err(Into::into)
    }

    async fn ensure_interaction_mutable(
        &self,
        interaction_id: InteractionId,
    ) -> Result<(), ProductError> {
        let interaction = self.get_interaction(interaction_id).await?;
        if self
            .storage
            .thread_is_imported(interaction.thread_id)
            .await?
        {
            return Err(ProductError::Invalid(
                "imported conversations are immutable".into(),
            ));
        }
        Ok(())
    }

    pub(crate) async fn get_approval(
        &self,
        request_id: &str,
    ) -> Result<ApprovalReceipt, ProductError> {
        self.storage
            .get_approval(request_id)
            .await?
            .ok_or_else(|| ProductError::NotFound(format!("approval request {request_id}")))
    }

    pub(crate) async fn record_approval_request(
        &self,
        request: &ApprovalRequest,
    ) -> Result<ApprovalReceipt, ProductError> {
        self.storage
            .record_approval_request(request)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn record_approval_resolution(
        &self,
        resolution: &ApprovalResolution,
        harness_live: bool,
    ) -> Result<ApprovalReceipt, ProductError> {
        self.storage
            .record_approval_resolution(resolution, harness_live)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn abort_pending_approvals(
        &self,
        interaction_id: Option<InteractionId>,
        rationale: &str,
    ) -> Result<u64, ProductError> {
        self.storage
            .abort_pending_approvals(interaction_id, rationale, &now())
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn project_path(&self, project_id: ProjectId) -> Result<String, ProductError> {
        self.project(project_id).await.map(|project| project.path)
    }

    pub(crate) async fn project(&self, project_id: ProjectId) -> Result<Project, ProductError> {
        self.storage
            .get_project(project_id)
            .await?
            .ok_or_else(|| ProductError::NotFound(format!("project {project_id}")))
    }
}

fn stored_project_path(canonical_path: &std::path::Path) -> Result<String, ProductError> {
    canonical_path.to_str().map(str::to_owned).ok_or_else(|| {
        ProductError::Invalid("project path cannot be represented safely as UTF-8".into())
    })
}

fn validated_interaction_input_digest(
    text: &str,
    contexts: &[super::InteractionContextIntent],
) -> Result<String, ProductError> {
    if text.trim().is_empty()
        && !contexts
            .iter()
            .flat_map(|context| &context.annotations)
            .any(|annotation| !annotation.trim().is_empty())
    {
        return Err(ProductError::Invalid(
            "An interaction needs message text or at least one context annotation.".into(),
        ));
    }
    let mut targets = std::collections::HashSet::new();
    let mut graph_contexts = Vec::with_capacity(contexts.len());
    for context in contexts {
        if context.target.node_id <= 0
            || context.target.source_interaction_node_id <= 0
            || context.target.source_layer_id <= 0
        {
            return Err(ProductError::Invalid(
                "context provenance IDs must be positive".into(),
            ));
        }
        if !targets.insert(context.target.node_id) {
            return Err(ProductError::Invalid(
                "a context target can only be attached once".into(),
            ));
        }
        if context
            .annotations
            .iter()
            .any(|annotation| annotation.trim().is_empty())
        {
            return Err(ProductError::Invalid(
                "context annotations must contain non-whitespace text".into(),
            ));
        }
        graph_contexts.push(relayer_graph_core::InteractionContextDraft {
            target: relayer_graph_core::InteractionContextTarget {
                node_id: relayer_graph_core::NodeId::new(context.target.node_id)
                    .expect("validated positive node ID"),
                source_interaction_node_id: relayer_graph_core::NodeId::new(
                    context.target.source_interaction_node_id,
                )
                .expect("validated positive source node ID"),
                source_layer_id: relayer_graph_core::LayerId::new(context.target.source_layer_id)
                    .expect("validated positive layer ID"),
            },
            annotations: context.annotations.clone(),
        });
    }
    relayer_graph_core::interaction_input_digest(text, &graph_contexts)
        .map_err(|error| ProductError::Invalid(error.to_string()))
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

fn validate_provider_snapshot(
    snapshot: &ProviderCatalogSnapshot,
    managed_policy: Option<&FamilyPolicyReference>,
) -> Result<(), CatalogError> {
    super::catalog::validate_stable_id(snapshot.provider_id.as_str(), "providerId")?;
    if snapshot.label.trim().is_empty() {
        return Err(CatalogError::invalid(
            "provider_label_required",
            "provider label must be non-empty",
        ));
    }
    let mut ids = std::collections::HashSet::new();
    let mut orders = std::collections::HashSet::new();
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
    }
    // Multiple normalized defaults are valid. Product-owned family policies
    // decide which ordered subset becomes a managed family.
    if let Some(family) = &snapshot.system_family {
        if family.model_ids.len() > 5 {
            return Err(CatalogError::invalid(
                "system_family_size_invalid",
                "system family cannot contain more than five models",
            ));
        }
        if family.model_ids.is_empty() {
            return Ok(());
        }
        if family.key.trim().is_empty() || family.name.trim().is_empty() {
            return Err(CatalogError::invalid(
                "system_family_identity_invalid",
                "system family key and name must be non-empty",
            ));
        }
        let Some(policy) = managed_policy else {
            return Err(CatalogError::invalid(
                "system_family_policy_required",
                "managed family membership requires an active product policy",
            ));
        };
        let expected = super::model_policy::derive_managed_family_members(policy, snapshot)?;
        if family
            .model_ids
            .iter()
            .map(String::as_str)
            .ne(expected.iter().map(|member| member.model_id.as_str()))
        {
            return Err(CatalogError::invalid(
                "system_family_members_invalid",
                "managed family must match its active product policy",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::product::{
        CatalogModelSnapshot, FamilyPolicyReference, HarnessModelCompatibility, HarnessModelRule,
        HarnessModelRules, ModelFamilyMember, ProviderDefinition, ProviderId,
        RuntimeProductHarness, UnavailableReason,
    };
    use std::sync::atomic::{AtomicU64, Ordering};

    static MANAGED_POLICY_TEST_ID: AtomicU64 = AtomicU64::new(0);

    #[test]
    #[cfg(unix)]
    fn rejects_a_non_utf8_canonical_project_path_instead_of_storing_a_lossy_path() {
        use std::os::unix::ffi::OsStringExt;

        let path =
            std::path::PathBuf::from(std::ffi::OsString::from_vec(b"/project-\xff".to_vec()));
        let error = stored_project_path(&path).unwrap_err();
        assert!(matches!(
            error,
            ProductError::Invalid(message)
                if message == "project path cannot be represented safely as UTF-8"
        ));
    }

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
        let mut harnesses = runtime_harnesses();
        harnesses.push(RuntimeProductHarness {
            id: "model-selecting-prime".into(),
            configuration_digest: "sha256:model-selecting-prime".into(),
            model_compatibility: vec![],
            configuration_revision: 1,
            model_rules: Some(HarnessModelRules {
                allow: vec![HarnessModelRule {
                    adapter_id: "openai-api".into(),
                    model_id_exact: None,
                    model_id_regex: Some(".*".into()),
                }],
                deny: vec![],
            }),
            execution_access_contracts: vec!["secret@1".into()],
            family_policy: None,
            runtime_available: true,
            unavailable_reason: None,
        });
        storage
            .initialize_model_catalog("prime-agent-basic", &harnesses)
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
        assert!(
            !service
                .harness_uses_configuration_model("model-selecting-prime")
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
                family_id: None,
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

    #[tokio::test]
    async fn staged_provider_requires_connected_catalog_with_a_visible_model() {
        let (path, storage, service) = managed_policy_service(1).await;
        let (definition, snapshot) = staged_codex_catalog();

        let mut disconnected = snapshot.clone();
        disconnected.connected = false;
        disconnected.unavailable_reason = Some(UnavailableReason {
            code: "credentials_revoked".into(),
            message: "Reconnect this provider.".into(),
        });
        assert!(
            service
                .create_provider_with_catalog(definition.clone(), disconnected)
                .await
                .unwrap_err()
                .to_string()
                .contains("must be connected")
        );

        let mut hidden = snapshot;
        for model in &mut hidden.models {
            model.visible = false;
        }
        assert!(
            service
                .create_provider_with_catalog(definition, hidden)
                .await
                .unwrap_err()
                .to_string()
                .contains("at least one visible model")
        );
        assert!(
            service
                .provider_definitions()
                .await
                .unwrap()
                .iter()
                .all(|provider| provider.id.as_str() != "onboarding-codex")
        );

        drop(service);
        drop(storage);
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn staged_codex_provider_uses_its_managed_default_then_policy_migrates_it() {
        let (path, storage, service) = managed_policy_service(1).await;
        let (definition, snapshot) = staged_codex_catalog();
        service
            .create_provider_with_catalog(definition, snapshot.clone())
            .await
            .unwrap();
        let connected = service.model_settings().await.unwrap();
        assert_ne!(connected.defaults.provider_id.as_str(), "onboarding-codex");
        assert!(connected.families.iter().any(|family| {
            family.managed_policy.as_ref().is_some_and(|policy| {
                policy.provider_id.as_str() == "onboarding-codex" && policy.policy_version == 1
            })
        }));
        let permissions = HashSet::from(["codex-basic".to_owned()]);
        let status = service
            .provider_onboarding_status(&permissions)
            .await
            .unwrap();
        assert!(!status.complete);
        let completion = service
            .complete_default_provider_onboarding(
                &ProviderId::parse("onboarding-codex").unwrap(),
                "codex-basic",
                &permissions,
            )
            .await
            .unwrap();
        assert!(completion.is_some());
        let first = service.model_settings().await.unwrap();
        let first_default = first
            .defaults
            .family_id
            .expect("managed onboarding default");
        assert_eq!(first.defaults.provider_id.as_str(), "onboarding-codex");
        assert_eq!(
            first
                .families
                .iter()
                .find(|family| family.id == first_default)
                .unwrap()
                .managed_policy
                .as_ref()
                .unwrap()
                .policy_version,
            1
        );

        let mut empty_policy_output = snapshot.clone();
        for model in &mut empty_policy_output.models {
            model.provider_default = false;
        }
        assert!(
            service
                .publish_provider_catalog(empty_policy_output)
                .await
                .is_err()
        );
        assert_eq!(
            service.model_settings().await.unwrap().defaults.family_id,
            Some(first_default)
        );

        storage
            .initialize_model_catalog("codex-basic", &managed_runtime_harnesses(99))
            .await
            .unwrap();
        assert!(
            service
                .publish_provider_catalog(snapshot.clone())
                .await
                .is_err()
        );
        let retained = service.model_settings().await.unwrap();
        assert_eq!(retained.defaults.family_id, Some(first_default));
        assert_eq!(
            retained
                .families
                .iter()
                .find(|family| family.id == first_default)
                .unwrap()
                .managed_policy
                .as_ref()
                .unwrap()
                .policy_version,
            1
        );

        storage
            .initialize_model_catalog("codex-basic", &managed_runtime_harnesses(2))
            .await
            .unwrap();
        let mut v2_snapshot = snapshot;
        for (order, id) in ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]
            .into_iter()
            .enumerate()
        {
            v2_snapshot.models.push(CatalogModelSnapshot {
                id: id.into(),
                label: id.into(),
                order: order + 2,
                visible: true,
                available: true,
                unavailable_reason: None,
                provider_default: false,
                replacement_model_id: None,
                metadata: serde_json::json!({}),
            });
        }
        service.publish_provider_catalog(v2_snapshot).await.unwrap();
        let migrated = service.model_settings().await.unwrap();
        let migrated_default = migrated.defaults.family_id.unwrap();
        assert_ne!(migrated_default, first_default);
        assert_eq!(
            migrated
                .families
                .iter()
                .find(|family| family.id == migrated_default)
                .unwrap()
                .managed_policy
                .as_ref()
                .unwrap()
                .policy_version,
            2
        );
        assert_eq!(
            migrated
                .families
                .iter()
                .find(|family| family.id == migrated_default)
                .unwrap()
                .members
                .iter()
                .map(|member| member.model_id.as_str())
                .collect::<Vec<_>>(),
            vec!["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "default"]
        );
        assert!(
            !migrated
                .families
                .iter()
                .any(|family| family.id == first_default)
        );

        drop(service);
        drop(storage);
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn policy_version_change_never_replaces_a_custom_default() {
        let (path, storage, service) = managed_policy_service(1).await;
        let (definition, snapshot) = staged_codex_catalog();
        service
            .create_provider_with_catalog(definition, snapshot.clone())
            .await
            .unwrap();
        let custom = service
            .create_model_family(CreateModelFamilyCommand {
                name: "My models".into(),
                enabled: true,
                members: vec![ModelFamilyMember {
                    provider_id: ProviderId::parse("onboarding-codex").unwrap(),
                    model_id: "second".into(),
                    position: 0,
                }],
            })
            .await
            .unwrap();
        let unchanged = service
            .update_model_family(UpdateModelFamilyCommand {
                id: custom.id,
                name: None,
                enabled: custom.enabled,
                members: Some(custom.members.clone()),
            })
            .await
            .unwrap();
        assert_eq!(unchanged.revision, custom.revision);
        service
            .update_model_settings_defaults(UpdateModelSettingsDefaultsCommand {
                harness_id: None,
                provider_id: None,
                family_id: Some(custom.id),
            })
            .await
            .unwrap();
        storage
            .initialize_model_catalog("codex-basic", &managed_runtime_harnesses(2))
            .await
            .unwrap();
        service.publish_provider_catalog(snapshot).await.unwrap();
        assert_eq!(
            service.model_settings().await.unwrap().defaults.family_id,
            Some(custom.id)
        );

        drop(service);
        drop(storage);
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn managed_policy_never_replaces_an_explicit_provider_default() {
        let (path, storage, service) = managed_policy_service(1).await;
        let (mut custom_definition, mut custom_snapshot) = staged_codex_catalog();
        custom_definition.id = ProviderId::parse("custom-openai").unwrap();
        custom_definition.adapter_id = "openai-api".into();
        custom_definition.label = "Custom OpenAI".into();
        custom_definition.endpoint = Some("https://api.openai.com/v1".into());
        custom_definition.access_contract = "secret@1".into();
        custom_definition.credential_reference = Some("provider:custom-openai".into());
        custom_snapshot.provider_id = custom_definition.id.clone();
        custom_snapshot.label = custom_definition.label.clone();
        custom_snapshot.system_family = None;
        service
            .create_provider_with_catalog(custom_definition, custom_snapshot)
            .await
            .unwrap();
        service
            .update_model_settings_defaults(UpdateModelSettingsDefaultsCommand {
                harness_id: None,
                provider_id: Some(ProviderId::parse("custom-openai").unwrap()),
                family_id: None,
            })
            .await
            .unwrap();
        let (definition, snapshot) = staged_codex_catalog();
        service
            .create_provider_with_catalog(definition, snapshot.clone())
            .await
            .unwrap();
        let first = service.model_settings().await.unwrap();
        assert_eq!(first.defaults.family_id, None);
        assert_eq!(first.defaults.provider_id.as_str(), "custom-openai");

        storage
            .initialize_model_catalog("codex-basic", &managed_runtime_harnesses(2))
            .await
            .unwrap();
        service.publish_provider_catalog(snapshot).await.unwrap();
        let migrated = service.model_settings().await.unwrap();
        assert_eq!(migrated.defaults.provider_id.as_str(), "custom-openai");
        assert_eq!(migrated.defaults.family_id, None);
        assert!(migrated.families.iter().any(|family| {
            family
                .managed_policy
                .as_ref()
                .is_some_and(|policy| policy.policy_version == 2)
        }));

        drop(service);
        drop(storage);
        std::fs::remove_file(path).unwrap();
    }

    async fn managed_policy_service(
        version: u32,
    ) -> (std::path::PathBuf, SqliteProductStore, ProductService) {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let test_id = MANAGED_POLICY_TEST_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "relayer-managed-policy-{}-{unique}-{test_id}.sqlite3",
            std::process::id()
        ));
        let storage = SqliteProductStore::open(&path).await.unwrap();
        storage
            .initialize_model_catalog("codex-basic", &managed_runtime_harnesses(version))
            .await
            .unwrap();
        let service = ProductService::new(storage.clone(), true);
        (path, storage, service)
    }

    fn staged_codex_catalog() -> (ProviderDefinition, ProviderCatalogSnapshot) {
        let provider_id = ProviderId::parse("onboarding-codex").unwrap();
        (
            ProviderDefinition {
                id: provider_id.clone(),
                adapter_id: "codex-subscription".into(),
                label: "Work Codex".into(),
                endpoint: None,
                access_contract: "managed-runtime@1".into(),
                credential_reference: None,
                lifecycle_state: "active".into(),
                removed_at: None,
            },
            ProviderCatalogSnapshot {
                provider_id,
                label: "Work Codex".into(),
                connected: true,
                unavailable_reason: None,
                models: vec![
                    CatalogModelSnapshot {
                        id: "default".into(),
                        label: "Default".into(),
                        order: 0,
                        visible: true,
                        available: true,
                        unavailable_reason: None,
                        provider_default: true,
                        replacement_model_id: None,
                        metadata: serde_json::json!({}),
                    },
                    CatalogModelSnapshot {
                        id: "second".into(),
                        label: "Second".into(),
                        order: 1,
                        visible: true,
                        available: true,
                        unavailable_reason: None,
                        provider_default: false,
                        replacement_model_id: None,
                        metadata: serde_json::json!({}),
                    },
                ],
                system_family: Some(SystemFamilySnapshot {
                    key: "adapter-authored-ignored".into(),
                    name: "Adapter family".into(),
                    model_ids: vec!["second".into()],
                }),
            },
        )
    }

    fn managed_runtime_harnesses(version: u32) -> Vec<RuntimeProductHarness> {
        vec![RuntimeProductHarness {
            id: "codex-basic".into(),
            configuration_digest: format!("sha256:codex-basic-{version}"),
            model_compatibility: vec![],
            configuration_revision: version,
            model_rules: Some(HarnessModelRules {
                allow: vec![
                    HarnessModelRule {
                        adapter_id: "codex-subscription".into(),
                        model_id_exact: None,
                        model_id_regex: Some(".*".into()),
                    },
                    HarnessModelRule {
                        adapter_id: "openai-api".into(),
                        model_id_exact: None,
                        model_id_regex: Some(".*".into()),
                    },
                ],
                deny: vec![],
            }),
            execution_access_contracts: vec!["managed-runtime@1".into()],
            family_policy: Some(FamilyPolicyReference {
                id: super::super::model_policy::CODEX_DEFAULT_FAMILY_POLICY_ID.into(),
                version,
            }),
            runtime_available: true,
            unavailable_reason: None,
        }]
    }

    fn runtime_harnesses() -> Vec<RuntimeProductHarness> {
        vec![
            RuntimeProductHarness {
                id: "prime-agent-basic".into(),
                configuration_digest: "sha256:prime-agent-basic".into(),
                model_compatibility: vec![],
                configuration_revision: 1,
                model_rules: None,
                execution_access_contracts: vec![],
                family_policy: None,
                runtime_available: true,
                unavailable_reason: None,
            },
            RuntimeProductHarness {
                id: "codex-basic".into(),
                configuration_digest: "sha256:codex-basic".into(),
                model_compatibility: vec![HarnessModelCompatibility {
                    provider_id: ProviderId::parse("codex").unwrap(),
                    model_ids: None,
                    preferred_model_id: None,
                }],
                configuration_revision: 1,
                model_rules: None,
                execution_access_contracts: vec![],
                family_policy: None,
                runtime_available: true,
                unavailable_reason: None,
            },
        ]
    }
}
