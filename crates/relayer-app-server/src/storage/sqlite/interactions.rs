use super::{
    SqliteProductStore, catalog, context_drafts::ensure_context_confirmation_restore_safe,
};
use crate::product::{
    AcceptedInteractionCompletion, Interaction, InteractionId, InteractionModelSelection,
    ModelFamilyId, PreparedInteractionBinding, ProviderId, ThreadId, ValidateModelSelectionCommand,
};
use crate::storage::{NewInteractionInput, StorageError};
use sqlx::{Row, SqliteConnection, sqlite::SqliteRow};
use std::time::{SystemTime, UNIX_EPOCH};

impl SqliteProductStore {
    pub(crate) async fn get_interaction_by_graph_node_id(
        &self,
        graph_node_id: i64,
    ) -> Result<Option<Interaction>, StorageError> {
        let row = sqlx::query(
            "SELECT i.id,i.thread_id,i.sequence,i.text,i.created_at,i.graph_node_id,i.completion_status,i.harness_configuration_name,i.harness_configuration_digest,i.completion_output_json,i.completion_error,i.permission_profile_id,i.effective_execution_digest,i.effective_permission_receipt_json,i.model_provider_id,i.provider_model_id,i.model_family_id,a.id,a.attempt_number,a.started_at,a.finished_at,a.family_id,a.family_revision,a.harness_configuration_name,a.harness_configuration_revision,a.harness_configuration_digest,a.provider_id,a.adapter_id,a.adapter_implementation_version,a.model_id,a.access_contract,a.outcome,a.failure_category,a.effect_boundary,a.attempt_admission_id,a.admitted_plan_json,a.admitted_plan_digest FROM interactions i LEFT JOIN interaction_attempts a ON a.id=(SELECT latest.id FROM interaction_attempts latest WHERE latest.interaction_id=i.id ORDER BY latest.attempt_number DESC LIMIT 1) WHERE i.graph_node_id=?1",
        )
        .bind(graph_node_id)
        .fetch_optional(&self.pool)
        .await?;
        row.as_ref().map(interaction_from_row).transpose()
    }

    pub(crate) async fn recover_interrupted_interactions(
        &self,
        error: &str,
        preserve_identified: bool,
    ) -> Result<u64, StorageError> {
        // Ordinary running completions cannot resume across a backend restart. Preserve
        // not_started rows: they are durable user drafts, including recoverable model failures.
        // Finalize the attempt in the same transaction: an interrupted harness has an unknown
        // effect boundary and therefore must never be silently replayed after restart.
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let finished_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time is before unix epoch")
            .as_millis()
            .to_string();
        sqlx::query("UPDATE interaction_attempts SET finished_at=?1,outcome='execution_failed',failure_category='application_restart',effect_boundary='unknown' WHERE outcome='running'")
            .bind(finished_at)
            .execute(&mut *transaction)
            .await?;
        let result = sqlx::query(
            "UPDATE interactions SET completion_status='failed',completion_error=?1 WHERE completion_status IN ('running','submitted') AND (?2=0 OR input_identity IS NULL) AND id NOT IN (SELECT result_interaction_id FROM action_invocations WHERE authoritative=1) AND thread_id IN (SELECT id FROM threads WHERE conversation_import_id IS NULL)",
        )
        .bind(error)
        .bind(preserve_identified)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(result.rows_affected())
    }

    pub(crate) async fn get_interaction(
        &self,
        interaction_id: InteractionId,
    ) -> Result<Option<Interaction>, StorageError> {
        let mut connection = self.pool.acquire().await?;
        sqlx::query(
            "SELECT i.id,i.thread_id,i.sequence,i.text,i.created_at,i.graph_node_id,i.completion_status,i.harness_configuration_name,i.harness_configuration_digest,i.completion_output_json,i.completion_error,i.permission_profile_id,i.effective_execution_digest,i.effective_permission_receipt_json,i.model_provider_id,i.provider_model_id,i.model_family_id,a.id,a.attempt_number,a.started_at,a.finished_at,a.family_id,a.family_revision,a.harness_configuration_name,a.harness_configuration_revision,a.harness_configuration_digest,a.provider_id,a.adapter_id,a.adapter_implementation_version,a.model_id,a.access_contract,a.outcome,a.failure_category,a.effect_boundary,a.attempt_admission_id,a.admitted_plan_json,a.admitted_plan_digest FROM interactions i JOIN threads t ON t.id=i.thread_id LEFT JOIN interaction_attempts a ON a.id=(SELECT latest.id FROM interaction_attempts latest WHERE latest.interaction_id=i.id ORDER BY latest.attempt_number DESC LIMIT 1) WHERE i.id=?1 AND (t.conversation_import_id IS NULL OR EXISTS(SELECT 1 FROM conversation_imports ci WHERE ci.id=t.conversation_import_id AND ci.state='published'))",
        )
        .bind(interaction_id.value())
        .fetch_optional(&mut *connection)
        .await?
        .as_ref()
        .map(interaction_from_row)
            .transpose()
    }

    #[cfg(test)]
    pub(crate) async fn list_interactions(
        &self,
        thread_id: ThreadId,
    ) -> Result<Vec<Interaction>, StorageError> {
        let mut connection = self.pool.acquire().await?;
        fetch_interactions(&mut connection, thread_id).await
    }

    pub(crate) async fn insert_interaction(
        &self,
        thread_id: ThreadId,
        text: &str,
        model_selection: Option<&InteractionModelSelection>,
        require_model_selection: bool,
        enforce_single_active_interaction: bool,
    ) -> Result<Interaction, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let (previous_timestamp, permission_profile_id, harness_id): (String, String, String) =
            sqlx::query_as("SELECT updated_at,permission_profile_id,harness_configuration_name FROM threads WHERE id=?1")
                .bind(thread_id.value())
                .fetch_one(&mut *transaction)
                .await?;
        if enforce_single_active_interaction {
            let interaction_in_progress: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM interactions WHERE thread_id=?1 AND completion_status IN ('not_started','running','submitted'))",
            )
            .bind(thread_id.value())
            .fetch_one(&mut *transaction)
            .await?;
            if interaction_in_progress {
                return Err(StorageError::Catalog(
                    crate::product::CatalogError::invalid(
                        "interaction_in_progress",
                        "Wait for the active interaction to finish.",
                    ),
                ));
            }
        }
        let model_selection = match model_selection {
            Some(selection) => Some(selection.clone()),
            None => sqlx::query(
                "SELECT model_provider_id,provider_model_id,model_family_id FROM interactions WHERE thread_id=?1 ORDER BY sequence DESC LIMIT 1",
            )
            .bind(thread_id.value())
            .fetch_optional(&mut *transaction)
            .await?
            .as_ref()
            .map(|row| interaction_model_selection_from_row(row, 0, 1, 2))
            .transpose()?
            .flatten(),
        };
        if let Some(selection) = model_selection.as_ref() {
            let command = ValidateModelSelectionCommand {
                harness_id: harness_id.clone(),
                family_id: selection.family_id,
                provider_id: selection.provider_id.clone(),
                model_id: selection.model_id.clone(),
            };
            catalog::validate_model_selection_on(&mut transaction, &command).await?;
        } else if require_model_selection {
            return Err(StorageError::Catalog(
                crate::product::CatalogError::invalid(
                    "model_selection_required",
                    "The previous interaction has no model selection to inherit.",
                ),
            ));
        }
        let timestamp = monotonic_timestamp(&previous_timestamp);
        let sequence: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(sequence),0)+1 FROM interactions WHERE thread_id=?1",
        )
        .bind(thread_id.value())
        .fetch_one(&mut *transaction)
        .await?;
        let result = sqlx::query(
            "INSERT INTO interactions(thread_id,sequence,text,created_at,permission_profile_id,model_provider_id,provider_model_id,model_family_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        )
        .bind(thread_id.value())
        .bind(sequence)
        .bind(text)
        .bind(&timestamp)
        .bind(&permission_profile_id)
        .bind(model_selection.as_ref().map(|selection| selection.provider_id.as_str()))
        .bind(model_selection.as_ref().map(|selection| selection.model_id.as_str()))
        .bind(model_selection.as_ref().map(|selection| selection.family_id.value()))
        .execute(&mut *transaction)
        .await?;
        sqlx::query("UPDATE threads SET updated_at=?1 WHERE id=?2")
            .bind(&timestamp)
            .bind(thread_id.value())
            .execute(&mut *transaction)
            .await?;
        let interaction = Interaction {
            id: InteractionId::from_database(result.last_insert_rowid()),
            thread_id,
            sequence,
            text: text.to_owned(),
            created_at: timestamp,
            graph_node_id: None,
            completion_status: "not_started".into(),
            harness_configuration_name: None,
            harness_configuration_digest: None,
            permission_profile_id,
            model_selection,
            effective_execution_digest: None,
            effective_permission_receipt: None,
            completion_output: None,
            completion_error: None,
            latest_attempt: None,
        };
        transaction.commit().await?;
        Ok(interaction)
    }

    #[cfg(test)]
    pub(crate) async fn mark_interaction_running(
        &self,
        interaction_id: InteractionId,
        harness_configuration_name: &str,
    ) -> Result<(), StorageError> {
        sqlx::query("UPDATE interactions SET completion_status='running',harness_configuration_name=?1,harness_configuration_digest=NULL,effective_execution_digest=NULL,effective_permission_receipt_json=NULL,completion_output_json=NULL,completion_error=NULL WHERE id=?2 AND thread_id IN (SELECT id FROM threads WHERE conversation_import_id IS NULL)")
            .bind(harness_configuration_name)
            .bind(interaction_id.value())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub(crate) async fn claim_interaction_running(
        &self,
        interaction_id: InteractionId,
        harness_configuration_name: &str,
    ) -> Result<bool, StorageError> {
        let result = sqlx::query("UPDATE interactions SET completion_status='running',completion_error=NULL WHERE id=?1 AND completion_status='submitted' AND graph_node_id IS NOT NULL AND harness_configuration_name=?2 AND harness_configuration_digest IS NOT NULL AND effective_execution_digest IS NOT NULL AND effective_permission_receipt_json IS NOT NULL")
            .bind(interaction_id.value())
            .bind(harness_configuration_name)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() == 1)
    }

    pub(crate) async fn restore_leased_interaction_submitted(
        &self,
        interaction_id: InteractionId,
        error: &str,
    ) -> Result<bool, StorageError> {
        let result = sqlx::query(
            "UPDATE interactions
             SET completion_status='submitted',completion_error=?1
             WHERE id=?2 AND completion_status='running'
               AND EXISTS (
                 SELECT 1 FROM action_invocations
                 WHERE result_interaction_id=interactions.id AND graph_lease_required=1 AND authoritative=1
               )",
        )
        .bind(error)
        .bind(interaction_id.value())
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    pub(crate) async fn restore_identified_interaction_submitted(
        &self,
        interaction_id: InteractionId,
        error: &str,
    ) -> Result<bool, StorageError> {
        let result = sqlx::query(
            "UPDATE interactions SET completion_status='submitted',completion_error=?1
             WHERE id=?2 AND completion_status='running' AND input_identity IS NOT NULL AND input_digest IS NOT NULL",
        ).bind(error).bind(interaction_id.value()).execute(&self.pool).await?;
        Ok(result.rows_affected() == 1)
    }

    pub(crate) async fn recover_identified_interaction_submitted(
        &self,
        interaction_id: InteractionId,
        error: &str,
    ) -> Result<bool, StorageError> {
        let result = sqlx::query(
            "UPDATE interactions SET completion_status='submitted',completion_error=?1
             WHERE id=?2 AND input_identity IS NOT NULL AND input_digest IS NOT NULL
               AND completion_status IN ('not_started','running','submitted','waiting_for_approval')",
        ).bind(error).bind(interaction_id.value()).execute(&self.pool).await?;
        Ok(result.rows_affected() == 1)
    }

    pub(crate) async fn claim_interaction_preparing(
        &self,
        interaction_id: InteractionId,
    ) -> Result<bool, StorageError> {
        let result = sqlx::query("UPDATE interactions SET completion_status='submitted',completion_error=NULL WHERE id=?1 AND completion_status='not_started' AND graph_node_id IS NULL")
            .bind(interaction_id.value())
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() == 1)
    }

    pub(crate) async fn bind_prepared_interaction(
        &self,
        binding: PreparedInteractionBinding<'_>,
    ) -> Result<bool, StorageError> {
        let receipt = serde_json::to_string(binding.effective_permission_receipt)
            .map_err(|error| StorageError::Serialization(error.to_string()))?;
        let result = sqlx::query("UPDATE interactions SET graph_node_id=?1,harness_configuration_name=?2,harness_configuration_digest=?3,effective_execution_digest=?4,effective_permission_receipt_json=?5,completion_output_json=NULL,completion_error=NULL WHERE id=?6 AND completion_status='submitted' AND graph_node_id IS NULL")
            .bind(binding.graph_node_id)
            .bind(binding.harness_configuration_name)
            .bind(binding.harness_configuration_digest)
            .bind(binding.effective_execution_digest)
            .bind(receipt)
            .bind(binding.interaction_id.value())
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() == 1)
    }

    pub(crate) async fn claim_interaction_retry(
        &self,
        interaction_id: InteractionId,
        expected_attempt_id: i64,
        input: NewInteractionInput<'_>,
        model_selection: &InteractionModelSelection,
        harness_configuration_name: &str,
    ) -> Result<bool, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let mut confirmation_ids = input.context_confirmation_ids.to_vec();
        confirmation_ids.sort();
        if confirmation_ids.iter().any(|id| id.trim().is_empty())
            || confirmation_ids.windows(2).any(|ids| ids[0] == ids[1])
        {
            return Err(StorageError::IncompatibleSchema(
                "context confirmation IDs must be non-empty and unique".into(),
            ));
        }
        let attempt: Option<(String, String)> = sqlx::query_as(
            "SELECT outcome,effect_boundary FROM interaction_attempts WHERE id=?1 AND interaction_id=?2",
        )
        .bind(expected_attempt_id)
        .bind(interaction_id.value())
        .fetch_optional(&mut *transaction)
        .await?;
        if !matches!(attempt.as_ref(), Some((outcome, _)) if outcome == "model_failed") {
            return Err(StorageError::Catalog(
                crate::product::CatalogError::invalid(
                    "interaction_retry_not_recoverable",
                    "Only a model failure can be retried in place.",
                ),
            ));
        }
        let retry_row = sqlx::query("SELECT thread_id,completion_status,input_identity,input_digest,model_provider_id,provider_model_id,model_family_id,harness_configuration_name FROM interactions WHERE id=?1")
            .bind(interaction_id.value())
            .fetch_one(&mut *transaction)
            .await?;
        let thread_id: i64 = retry_row.try_get("thread_id")?;
        let status: String = retry_row.try_get("completion_status")?;
        if status != "not_started" {
            let exact_replay = retry_row
                .try_get::<Option<String>, _>("input_identity")?
                .as_deref()
                == Some(input.input_identity)
                && retry_row
                    .try_get::<Option<String>, _>("input_digest")?
                    .as_deref()
                    == Some(input.input_digest)
                && retry_row
                    .try_get::<Option<String>, _>("model_provider_id")?
                    .as_deref()
                    == Some(model_selection.provider_id.as_str())
                && retry_row
                    .try_get::<Option<String>, _>("provider_model_id")?
                    .as_deref()
                    == Some(model_selection.model_id.as_str())
                && retry_row.try_get::<Option<i64>, _>("model_family_id")?
                    == Some(model_selection.family_id.value())
                && retry_row
                    .try_get::<Option<String>, _>("harness_configuration_name")?
                    .as_deref()
                    == Some(harness_configuration_name);
            if exact_replay {
                let consumed: Vec<String> = sqlx::query_scalar(
                    "SELECT draft_id FROM node_context_draft_resolutions WHERE consumed_interaction_id=?1 ORDER BY draft_id",
                )
                .bind(interaction_id.value())
                .fetch_all(&mut *transaction)
                .await?;
                if consumed != confirmation_ids {
                    return Err(StorageError::IncompatibleSchema(
                        "interaction retry identity was reused with different context confirmations"
                            .into(),
                    ));
                }
                transaction.commit().await?;
                return Ok(false);
            }
            return Err(StorageError::Catalog(
                crate::product::CatalogError::invalid(
                    "interaction_retry_stale",
                    "This draft has already changed. Refresh it before sending again.",
                ),
            ));
        }
        let latest_attempt_id: Option<i64> = sqlx::query_scalar(
            "SELECT id FROM interaction_attempts WHERE interaction_id=?1 ORDER BY attempt_number DESC LIMIT 1",
        )
        .bind(interaction_id.value())
        .fetch_optional(&mut *transaction)
        .await?;
        if latest_attempt_id != Some(expected_attempt_id) {
            return Err(StorageError::Catalog(
                crate::product::CatalogError::invalid(
                    "interaction_retry_stale",
                    "This draft has a newer attempt. Refresh it before sending again.",
                ),
            ));
        }
        let command = ValidateModelSelectionCommand {
            harness_id: harness_configuration_name.to_owned(),
            family_id: model_selection.family_id,
            provider_id: model_selection.provider_id.clone(),
            model_id: model_selection.model_id.clone(),
        };
        catalog::validate_model_selection_on(&mut transaction, &command).await?;
        let result = sqlx::query(
            "UPDATE interactions SET text=?1,model_provider_id=?2,provider_model_id=?3,model_family_id=?4,completion_status='submitted',harness_configuration_name=?5,harness_configuration_digest=NULL,effective_execution_digest=NULL,effective_permission_receipt_json=NULL,completion_output_json=NULL,completion_error=NULL,input_identity=?6,input_digest=?7 WHERE id=?8 AND completion_status='not_started' AND NOT EXISTS(SELECT 1 FROM interactions later WHERE later.thread_id=interactions.thread_id AND later.sequence>interactions.sequence)",
        )
        .bind(input.text)
        .bind(model_selection.provider_id.as_str())
        .bind(&model_selection.model_id)
        .bind(model_selection.family_id.value())
        .bind(harness_configuration_name)
        .bind(input.input_identity)
        .bind(input.input_digest)
        .bind(interaction_id.value())
        .execute(&mut *transaction)
        .await?;
        if result.rows_affected() == 1 {
            sqlx::query("DELETE FROM interaction_context_intents WHERE interaction_id=?1")
                .bind(interaction_id.value())
                .execute(&mut *transaction)
                .await?;
            for (context_position, context) in input.contexts.iter().enumerate() {
                sqlx::query("INSERT INTO interaction_context_intents(interaction_id,position,target_node_id,source_interaction_node_id,source_layer_id) VALUES (?1,?2,?3,?4,?5)")
                    .bind(interaction_id.value()).bind(context_position as i64).bind(context.target.node_id).bind(context.target.source_interaction_node_id).bind(context.target.source_layer_id)
                    .execute(&mut *transaction).await?;
                for (annotation_position, annotation) in context.annotations.iter().enumerate() {
                    sqlx::query("INSERT INTO interaction_context_annotations(interaction_id,context_position,position,text) VALUES (?1,?2,?3,?4)")
                        .bind(interaction_id.value()).bind(context_position as i64).bind(annotation_position as i64).bind(annotation)
                        .execute(&mut *transaction).await?;
                }
            }
            let mut submitted_annotations = input
                .contexts
                .iter()
                .flat_map(|context| {
                    context.annotations.iter().map(|annotation| {
                        (
                            context.target.node_id,
                            context.target.source_interaction_node_id,
                            context.target.source_layer_id,
                            annotation.as_str(),
                        )
                    })
                })
                .collect::<Vec<_>>();
            for draft_id in &confirmation_ids {
                let row = sqlx::query("SELECT target_node_id,source_interaction_node_id,source_layer_id,composer_text FROM node_context_draft_resolutions WHERE draft_id=?1 AND thread_id=?2 AND outcome='confirmed' AND dismissed_at IS NULL AND consumed_interaction_id IS NULL")
                    .bind(draft_id)
                    .bind(thread_id)
                    .fetch_optional(&mut *transaction)
                    .await?
                    .ok_or_else(|| StorageError::ContextDraftConflict {
                        code: "context_confirmation_not_pending",
                        message: "A submitted context confirmation is no longer pending.".into(),
                    })?;
                let target = (
                    row.try_get::<i64, _>("target_node_id")?,
                    row.try_get::<i64, _>("source_interaction_node_id")?,
                    row.try_get::<i64, _>("source_layer_id")?,
                    row.try_get::<String, _>("composer_text")?,
                );
                let Some(position) = submitted_annotations.iter().position(|candidate| {
                    candidate.0 == target.0
                        && candidate.1 == target.1
                        && candidate.2 == target.2
                        && candidate.3 == target.3
                }) else {
                    return Err(StorageError::ContextDraftConflict {
                        code: "context_confirmation_payload_mismatch",
                        message: "A submitted context confirmation does not match the interaction contexts."
                            .into(),
                    });
                };
                submitted_annotations.swap_remove(position);
                sqlx::query("UPDATE node_context_draft_resolutions SET consumed_interaction_id=?1 WHERE draft_id=?2 AND thread_id=?3 AND consumed_interaction_id IS NULL")
                    .bind(interaction_id.value())
                    .bind(draft_id)
                    .bind(thread_id)
                    .execute(&mut *transaction)
                    .await?;
            }
        }
        if result.rows_affected() == 0 {
            return Err(StorageError::Catalog(
                crate::product::CatalogError::invalid(
                    "interaction_retry_stale",
                    "This draft is no longer the latest interaction. Refresh it before sending again.",
                ),
            ));
        }
        transaction.commit().await?;
        Ok(true)
    }

    pub(crate) async fn accept_interaction_completion(
        &self,
        completion: AcceptedInteractionCompletion<'_>,
    ) -> Result<(), StorageError> {
        let result = sqlx::query("UPDATE interactions SET completion_status='accepted',completion_output_json=?1,completion_error=NULL WHERE id=?2 AND graph_node_id=?3 AND completion_status='running' AND harness_configuration_name=?4 AND harness_configuration_digest=?5 AND effective_execution_digest=?6 AND effective_permission_receipt_json=?7")
            .bind(serde_json::to_string(completion.output).map_err(|error| StorageError::Serialization(error.to_string()))?)
            .bind(completion.interaction_id.value())
            .bind(completion.graph_node_id)
            .bind(completion.harness_configuration_name)
            .bind(completion.harness_configuration_digest)
            .bind(completion.effective_execution_digest)
            .bind(serde_json::to_string(completion.effective_permission_receipt).map_err(|error| StorageError::Serialization(error.to_string()))?)
            .execute(&self.pool)
            .await?;
        if result.rows_affected() != 1 {
            let imported: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM interactions JOIN threads ON threads.id=interactions.thread_id WHERE interactions.id=?1 AND threads.conversation_import_id IS NOT NULL)")
                .bind(completion.interaction_id.value())
                .fetch_one(&self.pool)
                .await?;
            if imported {
                return Ok(());
            }
            return Err(StorageError::IncompatibleSchema(
                "prepared interaction identity changed before acceptance".into(),
            ));
        }
        Ok(())
    }

    pub(crate) async fn accept_interaction_completion_with_attempt(
        &self,
        attempt_id: i64,
        completion: AcceptedInteractionCompletion<'_>,
        timestamp: &str,
    ) -> Result<(), StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let attempt = sqlx::query("UPDATE interaction_attempts SET finished_at=?1,outcome='accepted',failure_category=NULL,effect_boundary='graph_write' WHERE id=?2 AND interaction_id=?3 AND outcome='running'")
            .bind(timestamp)
            .bind(attempt_id)
            .bind(completion.interaction_id.value())
            .execute(&mut *transaction)
            .await?;
        if attempt.rows_affected() != 1 {
            return Err(StorageError::IncompatibleSchema(
                "interaction attempt was already terminal, missing, or owned by another interaction".into(),
            ));
        }
        let interaction = sqlx::query("UPDATE interactions SET graph_node_id=?1,completion_status='accepted',harness_configuration_name=?2,harness_configuration_digest=?3,effective_execution_digest=?4,effective_permission_receipt_json=?5,completion_output_json=?6,completion_error=NULL WHERE id=?7 AND completion_status='running'")
            .bind(completion.graph_node_id)
            .bind(completion.harness_configuration_name)
            .bind(completion.harness_configuration_digest)
            .bind(completion.effective_execution_digest)
            .bind(serde_json::to_string(completion.effective_permission_receipt).map_err(|error| StorageError::Serialization(error.to_string()))?)
            .bind(serde_json::to_string(completion.output).map_err(|error| StorageError::Serialization(error.to_string()))?)
            .bind(completion.interaction_id.value())
            .execute(&mut *transaction)
            .await?;
        if interaction.rows_affected() != 1 {
            return Err(StorageError::IncompatibleSchema(
                "interaction was not running while accepting its attempt".into(),
            ));
        }
        transaction.commit().await?;
        Ok(())
    }

    pub(crate) async fn fail_interaction_completion_with_attempt(
        &self,
        failure: crate::product::FailedInteractionCompletion<'_>,
        timestamp: &str,
    ) -> Result<(), StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let attempt = sqlx::query("UPDATE interaction_attempts SET finished_at=?1,outcome=?2,failure_category=?3,effect_boundary=?4 WHERE id=?5 AND interaction_id=?6 AND outcome='running'")
            .bind(timestamp)
            .bind(failure.outcome)
            .bind(failure.failure_category)
            .bind(failure.effect_boundary)
            .bind(failure.attempt_id)
            .bind(failure.interaction_id.value())
            .execute(&mut *transaction)
            .await?;
        if attempt.rows_affected() != 1 {
            return Err(StorageError::IncompatibleSchema(
                "interaction attempt was already terminal, missing, or owned by another interaction".into(),
            ));
        }
        let interaction = if failure.return_to_unsent {
            sqlx::query("UPDATE interactions SET graph_node_id=NULL,completion_status='not_started',harness_configuration_name=?1,harness_configuration_digest=NULL,effective_execution_digest=NULL,effective_permission_receipt_json=NULL,completion_output_json=NULL,completion_error=NULL WHERE id=?2 AND completion_status='running'")
                .bind(failure.harness_configuration_name)
                .bind(failure.interaction_id.value())
                .execute(&mut *transaction)
                .await?
        } else {
            sqlx::query("UPDATE interactions SET graph_node_id=?1,completion_status='failed',harness_configuration_name=?2,completion_error=?3 WHERE id=?4 AND completion_status='running'")
                .bind(failure.graph_node_id)
                .bind(failure.harness_configuration_name)
                .bind(failure.error)
                .bind(failure.interaction_id.value())
                .execute(&mut *transaction)
                .await?
        };
        if interaction.rows_affected() != 1 {
            return Err(StorageError::IncompatibleSchema(
                "interaction was not running while finalizing its attempt".into(),
            ));
        }
        if failure.return_to_unsent {
            ensure_context_confirmation_restore_safe(
                &mut transaction,
                failure.interaction_id.value(),
            )
            .await?;
            sqlx::query("UPDATE node_context_draft_resolutions SET consumed_interaction_id=NULL WHERE consumed_interaction_id=?1")
                .bind(failure.interaction_id.value())
                .execute(&mut *transaction)
                .await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    pub(crate) async fn fail_interaction_completion(
        &self,
        interaction_id: InteractionId,
        harness_configuration_name: &str,
        error: &str,
    ) -> Result<bool, StorageError> {
        let result = sqlx::query("UPDATE interactions SET completion_status='failed',harness_configuration_name=COALESCE(harness_configuration_name,?1),completion_error=?2 WHERE id=?3 AND completion_status IN ('not_started','running','submitted','waiting_for_approval') AND thread_id IN (SELECT id FROM threads WHERE conversation_import_id IS NULL)")
            .bind(harness_configuration_name)
            .bind(error)
            .bind(interaction_id.value())
            .execute(&self.pool)
            .await?;
        if result.rows_affected() == 1 {
            return Ok(true);
        }
        let status: Option<String> =
            sqlx::query_scalar("SELECT completion_status FROM interactions WHERE id=?1")
                .bind(interaction_id.value())
                .fetch_optional(&self.pool)
                .await?;
        match status.as_deref() {
            Some("accepted" | "failed") => Ok(false),
            Some(other) => Err(StorageError::IncompatibleSchema(format!(
                "interaction {interaction_id} has unexpected failure-transition state {other}"
            ))),
            None => Err(StorageError::IncompatibleSchema(format!(
                "interaction {interaction_id} disappeared before failure transition"
            ))),
        }
    }

    pub(crate) async fn return_interaction_to_unsent(
        &self,
        interaction_id: InteractionId,
        harness_configuration_name: &str,
    ) -> Result<(), StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let restored = sqlx::query("UPDATE interactions SET completion_status='not_started',harness_configuration_name=?1,harness_configuration_digest=NULL,effective_execution_digest=NULL,effective_permission_receipt_json=NULL,completion_output_json=NULL,completion_error=NULL WHERE id=?2 AND completion_status='running'")
            .bind(harness_configuration_name).bind(interaction_id.value()).execute(&mut *transaction).await?;
        if restored.rows_affected() != 1 {
            return Err(StorageError::IncompatibleSchema(
                "interaction was not running while returning its draft to unsent".into(),
            ));
        }
        ensure_context_confirmation_restore_safe(&mut transaction, interaction_id.value()).await?;
        sqlx::query("UPDATE node_context_draft_resolutions SET consumed_interaction_id=NULL WHERE consumed_interaction_id=?1")
            .bind(interaction_id.value())
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(())
    }
}

pub(super) async fn fetch_interactions(
    connection: &mut SqliteConnection,
    thread_id: ThreadId,
) -> Result<Vec<Interaction>, StorageError> {
    let rows = sqlx::query(
        "SELECT i.id,i.thread_id,i.sequence,i.text,i.created_at,i.graph_node_id,i.completion_status,i.harness_configuration_name,i.harness_configuration_digest,i.completion_output_json,i.completion_error,i.permission_profile_id,i.effective_execution_digest,i.effective_permission_receipt_json,i.model_provider_id,i.provider_model_id,i.model_family_id,a.id,a.attempt_number,a.started_at,a.finished_at,a.family_id,a.family_revision,a.harness_configuration_name,a.harness_configuration_revision,a.harness_configuration_digest,a.provider_id,a.adapter_id,a.adapter_implementation_version,a.model_id,a.access_contract,a.outcome,a.failure_category,a.effect_boundary,a.attempt_admission_id,a.admitted_plan_json,a.admitted_plan_digest FROM interactions i LEFT JOIN interaction_attempts a ON a.id=(SELECT latest.id FROM interaction_attempts latest WHERE latest.interaction_id=i.id ORDER BY latest.attempt_number DESC LIMIT 1) WHERE i.thread_id=?1 ORDER BY i.sequence ASC",
    )
    .bind(thread_id.value())
    .fetch_all(connection)
    .await?;
    rows.iter().map(interaction_from_row).collect()
}

pub(super) fn monotonic_timestamp(previous: &str) -> String {
    let current = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time is before unix epoch")
        .as_millis();
    previous
        .parse::<u128>()
        .map_or(current, |previous| previous.max(current))
        .to_string()
}

pub(super) fn interaction_from_row(row: &SqliteRow) -> Result<Interaction, StorageError> {
    Ok(Interaction {
        id: InteractionId::from_database(row.try_get(0)?),
        thread_id: ThreadId::from_database(row.try_get(1)?),
        sequence: row.try_get(2)?,
        text: row.try_get(3)?,
        created_at: row.try_get(4)?,
        graph_node_id: row.try_get(5)?,
        completion_status: row.try_get(6)?,
        harness_configuration_name: row.try_get(7)?,
        harness_configuration_digest: row.try_get(8)?,
        completion_output: row
            .try_get::<Option<String>, _>(9)?
            .map(|value| serde_json::from_str(&value))
            .transpose()
            .map_err(|error| StorageError::Serialization(error.to_string()))?,
        completion_error: row.try_get(10)?,
        latest_attempt: row
            .try_get::<Option<i64>, _>(17)?
            .map(|id| {
                let admitted_plan: Option<crate::product::AdmittedExecutionModelPlan> = row
                    .try_get::<Option<String>, _>(35)?
                    .map(|value| serde_json::from_str(&value))
                    .transpose()
                    .map_err(|error| sqlx::Error::Decode(Box::new(error)))?;
                let admitted_plan_digest: Option<String> = row.try_get(36)?;
                if admitted_plan.as_ref().map(|plan| &plan.digest) != admitted_plan_digest.as_ref()
                {
                    return Err(sqlx::Error::Decode(
                        "stored admitted model-plan digest does not match its snapshot".into(),
                    ));
                }
                Ok::<_, sqlx::Error>(crate::product::InteractionAttempt {
                    id,
                    attempt_number: row.try_get(18)?,
                    started_at: row.try_get(19)?,
                    finished_at: row.try_get(20)?,
                    family_id: ModelFamilyId::from_database(row.try_get(21)?),
                    family_revision: row.try_get(22)?,
                    harness_configuration_name: row.try_get(23)?,
                    harness_configuration_revision: row.try_get(24)?,
                    harness_configuration_digest: row.try_get(25)?,
                    provider_id: ProviderId::from_database(row.try_get(26)?),
                    adapter_id: row.try_get(27)?,
                    adapter_implementation_version: row.try_get(28)?,
                    model_id: row.try_get(29)?,
                    access_contract: row.try_get(30)?,
                    outcome: row.try_get(31)?,
                    failure_category: row.try_get(32)?,
                    effect_boundary: row.try_get(33)?,
                    attempt_admission_id: row.try_get(34)?,
                    admitted_plan,
                })
            })
            .transpose()?,
        permission_profile_id: row.try_get(11)?,
        effective_execution_digest: row.try_get(12)?,
        effective_permission_receipt: row
            .try_get::<Option<String>, _>(13)?
            .map(|value| serde_json::from_str(&value))
            .transpose()
            .map_err(|error| StorageError::Serialization(error.to_string()))?,
        model_selection: interaction_model_selection_from_row(row, 14, 15, 16)?,
    })
}

pub(super) fn interaction_model_selection_from_row(
    row: &SqliteRow,
    provider_index: usize,
    model_index: usize,
    family_index: usize,
) -> Result<Option<InteractionModelSelection>, StorageError> {
    let provider_id = row.try_get::<Option<String>, _>(provider_index)?;
    let model_id = row.try_get::<Option<String>, _>(model_index)?;
    let family_id = row.try_get::<Option<i64>, _>(family_index)?;
    match (provider_id, model_id, family_id) {
        (None, None, None) => Ok(None),
        (Some(provider_id), Some(model_id), Some(family_id)) if family_id > 0 => {
            Ok(Some(InteractionModelSelection {
                family_id: ModelFamilyId::from_database(family_id),
                provider_id: ProviderId::from_database(provider_id),
                model_id,
            }))
        }
        _ => Err(StorageError::IncompatibleSchema(
            "interaction model selection is partially populated or invalid".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::NewThreadRecord;

    #[tokio::test]
    async fn omitted_model_is_inherited_inside_the_sequence_allocation_transaction() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "relayer-interaction-inheritance-{}-{unique}.sqlite3",
            std::process::id()
        ));
        let store = SqliteProductStore::open(&path).await.unwrap();
        seed_test_models(&store).await;
        let first_model = selection("first-model");
        let second_model = selection("second-model");
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                title: "Atomic inheritance",
                project_id: None,
                initial_message: "First",
                harness_configuration_name: "codex-basic",
                permission_profile_id: "auto",
                model_selection: Some(&first_model),
                timestamp: "1",
            })
            .await
            .unwrap();

        let queued = store
            .insert_interaction(thread.id, "Queued", Some(&second_model), true, true)
            .await
            .err()
            .unwrap();
        match queued {
            StorageError::Catalog(error) => assert_eq!(error.code(), "interaction_in_progress"),
            other => panic!("unexpected error: {other}"),
        }
        mark_interaction_accepted(&store, thread.root_interaction_id).await;

        let explicit = store
            .insert_interaction(thread.id, "Explicit", Some(&second_model), true, true)
            .await
            .unwrap();
        mark_interaction_accepted(&store, explicit.id).await;
        let inherited = store
            .insert_interaction(thread.id, "Inherited", None, true, true)
            .await
            .unwrap();

        assert_eq!(explicit.sequence, 2);
        assert_eq!(inherited.sequence, 3);
        assert_eq!(inherited.model_selection, Some(second_model));
        store.pool.close().await;
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn last_successful_catalog_snapshot_remains_usable_until_replaced() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "relayer-stale-catalog-interaction-{}-{unique}.sqlite3",
            std::process::id()
        ));
        let store = SqliteProductStore::open(&path).await.unwrap();
        seed_test_models(&store).await;
        let model = selection("first-model");
        sqlx::query("UPDATE model_providers SET refreshed_at='0' WHERE id='codex'")
            .execute(&store.pool)
            .await
            .unwrap();

        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                title: "Last-known catalog thread",
                project_id: None,
                initial_message: "First",
                harness_configuration_name: "codex-basic",
                permission_profile_id: "auto",
                model_selection: Some(&model),
                timestamp: "1",
            })
            .await
            .unwrap();
        mark_interaction_accepted(&store, thread.root_interaction_id).await;
        store
            .insert_interaction(thread.id, "Last-known follow-up", None, true, true)
            .await
            .unwrap();
        assert_eq!(store.list_interactions(thread.id).await.unwrap().len(), 2);

        store.pool.close().await;
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn retry_claim_updates_the_same_draft_once_and_preserves_the_failed_receipt() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "relayer-interaction-retry-{}-{unique}.sqlite3",
            std::process::id()
        ));
        let store = SqliteProductStore::open(&path).await.unwrap();
        seed_test_models(&store).await;
        let first_model = selection("first-model");
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                title: "Retry in place",
                project_id: None,
                initial_message: "Original prompt",
                harness_configuration_name: "codex-basic",
                permission_profile_id: "auto",
                model_selection: Some(&first_model),
                timestamp: "1",
            })
            .await
            .unwrap();
        let attempt_id = sqlx::query("INSERT INTO interaction_attempts(interaction_id,attempt_number,started_at,finished_at,family_id,family_revision,harness_configuration_name,harness_configuration_revision,harness_configuration_digest,provider_id,adapter_id,adapter_implementation_version,model_id,access_contract,outcome,failure_category,effect_boundary) VALUES (?1,1,'2','3',1,1,'codex-basic',1,'sha256:old','codex','codex-subscription',1,'first-model','managed-runtime@1','model_failed','model_unavailable','none')")
            .bind(thread.root_interaction_id.value())
            .execute(&store.pool)
            .await
            .unwrap()
            .last_insert_rowid();
        let next_model = selection("second-model");
        let contexts = vec![crate::product::InteractionContextIntent {
            target: crate::product::InteractionContextTarget {
                node_id: 8,
                source_interaction_node_id: 3,
                source_layer_id: 4,
            },
            annotations: vec!["new context".into()],
        }];
        let edited_input = || NewInteractionInput {
            text: "Edited prompt",
            input_identity: "retry-input",
            input_digest: "sha256:retry-input",
            contexts: &contexts,
            context_confirmation_ids: &[],
        };
        let first = store.claim_interaction_retry(
            thread.root_interaction_id,
            attempt_id,
            edited_input(),
            &next_model,
            "codex-basic",
        );
        let second = store.claim_interaction_retry(
            thread.root_interaction_id,
            attempt_id,
            edited_input(),
            &next_model,
            "codex-basic",
        );
        let (first, second) = tokio::join!(first, second);
        assert_eq!(
            [first.unwrap(), second.unwrap()]
                .into_iter()
                .filter(|claimed| *claimed)
                .count(),
            1
        );
        let conflicting_contexts = vec![crate::product::InteractionContextIntent {
            target: crate::product::InteractionContextTarget {
                node_id: 9,
                source_interaction_node_id: 3,
                source_layer_id: 4,
            },
            annotations: vec!["conflicting edit".into()],
        }];
        let conflicting = store
            .claim_interaction_retry(
                thread.root_interaction_id,
                attempt_id,
                NewInteractionInput {
                    text: "A different edit",
                    input_identity: "retry-input-conflict",
                    input_digest: "sha256:retry-input-conflict",
                    contexts: &conflicting_contexts,
                    context_confirmation_ids: &[],
                },
                &next_model,
                "codex-basic",
            )
            .await;
        assert!(matches!(
            conflicting,
            Err(StorageError::Catalog(
                crate::product::CatalogError::Invalid {
                    code: "interaction_retry_stale",
                    ..
                }
            ))
        ));

        let interaction = store
            .get_interaction(thread.root_interaction_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(interaction.id, thread.root_interaction_id);
        assert_eq!(interaction.text, "Edited prompt");
        assert_eq!(interaction.completion_status, "submitted");
        assert_eq!(interaction.model_selection, Some(next_model));
        assert_eq!(
            store
                .interaction_input(thread.root_interaction_id)
                .await
                .unwrap(),
            Some(crate::product::DurableInteractionInput {
                input_identity: "retry-input".into(),
                input_digest: "sha256:retry-input".into(),
                contexts,
            })
        );
        let receipt = interaction.latest_attempt.unwrap();
        assert_eq!(receipt.id, attempt_id);
        assert_eq!(receipt.model_id, "first-model");
        assert_eq!(receipt.outcome, "model_failed");
        assert_eq!(receipt.effect_boundary, "none");

        store.pool.close().await;
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn restart_recovery_preserves_every_imported_completion_status() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "relayer-import-recovery-{}-{unique}.sqlite3",
            std::process::id()
        ));
        let store = SqliteProductStore::open(&path).await.unwrap();
        sqlx::query("INSERT INTO conversation_imports(id,source_sha256,export_version,producer_json,header_json,state,created_at) VALUES ('import-1','sha256:abc',1,'{}','{}','published','1')")
            .execute(&store.pool).await.unwrap();
        let thread = sqlx::query("INSERT INTO threads(title,created_at,updated_at,conversation_import_id) VALUES ('Imported','1','1','import-1')")
            .execute(&store.pool).await.unwrap().last_insert_rowid();
        for (sequence, status) in ["not_started", "running", "submitted", "accepted", "failed"]
            .into_iter()
            .enumerate()
        {
            sqlx::query("INSERT INTO interactions(thread_id,sequence,text,created_at,completion_status) VALUES (?1,?2,'Imported','1',?3)")
                .bind(thread).bind((sequence + 1) as i64).bind(status)
                .execute(&store.pool).await.unwrap();
        }

        assert_eq!(
            store
                .recover_interrupted_interactions("interrupted", false)
                .await
                .unwrap(),
            0
        );
        let statuses = sqlx::query_scalar::<_, String>(
            "SELECT completion_status FROM interactions WHERE thread_id=?1 ORDER BY sequence",
        )
        .bind(thread)
        .fetch_all(&store.pool)
        .await
        .unwrap();
        assert_eq!(
            statuses,
            vec!["not_started", "running", "submitted", "accepted", "failed"]
        );
        let ids = sqlx::query_scalar::<_, i64>(
            "SELECT id FROM interactions WHERE thread_id=?1 ORDER BY sequence",
        )
        .bind(thread)
        .fetch_all(&store.pool)
        .await
        .unwrap();
        assert!(
            !store
                .claim_interaction_running(InteractionId::from_database(ids[0]), "blocked")
                .await
                .unwrap()
        );
        store
            .mark_interaction_running(InteractionId::from_database(ids[3]), "blocked")
            .await
            .unwrap();
        store
            .accept_interaction_completion(AcceptedInteractionCompletion {
                interaction_id: InteractionId::from_database(ids[4]),
                graph_node_id: 999,
                harness_configuration_name: "blocked",
                harness_configuration_digest: "sha256:blocked",
                effective_execution_digest: "sha256:blocked",
                effective_permission_receipt: &serde_json::json!({}),
                output: &serde_json::json!({}),
            })
            .await
            .unwrap();
        store
            .fail_interaction_completion(InteractionId::from_database(ids[3]), "blocked", "blocked")
            .await
            .unwrap();
        let preserved = sqlx::query_scalar::<_, String>(
            "SELECT completion_status FROM interactions WHERE thread_id=?1 ORDER BY sequence",
        )
        .bind(thread)
        .fetch_all(&store.pool)
        .await
        .unwrap();
        assert_eq!(preserved, statuses);
        store.pool.close().await;
        std::fs::remove_file(path).unwrap();
    }

    fn selection(model_id: &str) -> InteractionModelSelection {
        InteractionModelSelection {
            family_id: ModelFamilyId::from_database(1),
            provider_id: ProviderId::parse("codex").unwrap(),
            model_id: model_id.into(),
        }
    }

    async fn seed_test_models(store: &SqliteProductStore) {
        refresh_test_provider(store).await;
        for (order, model_id) in ["first-model", "second-model"].iter().enumerate() {
            sqlx::query("INSERT INTO provider_models(provider_id,model_id,label,provider_order,visible,available,provider_default,metadata_json) VALUES ('codex',?1,?1,?2,1,1,0,'{}')")
                .bind(model_id)
                .bind(order as i64)
                .execute(&store.pool)
                .await
                .unwrap();
        }
        sqlx::query("UPDATE product_harnesses SET available=1,unavailable_reason_code=NULL,unavailable_reason_message=NULL WHERE configuration_name='codex-basic'")
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO model_families(id,name,kind,system_key,enabled,position) VALUES (1,'Codex','system','codex',1,0)")
            .execute(&store.pool)
            .await
            .unwrap();
        for (position, model_id) in ["first-model", "second-model"].iter().enumerate() {
            sqlx::query("INSERT INTO model_family_members(family_id,position,provider_id,model_id) VALUES (1,?1,'codex',?2)")
                .bind(position as i64)
                .bind(model_id)
                .execute(&store.pool)
                .await
                .unwrap();
        }
    }

    async fn refresh_test_provider(store: &SqliteProductStore) {
        let refreshed_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
            .to_string();
        sqlx::query("UPDATE model_providers SET connected=1,unavailable_reason_code=NULL,unavailable_reason_message=NULL,refreshed_at=?1 WHERE id='codex'")
            .bind(refreshed_at)
            .execute(&store.pool)
            .await
            .unwrap();
    }

    async fn mark_interaction_accepted(store: &SqliteProductStore, id: InteractionId) {
        sqlx::query("UPDATE interactions SET completion_status='accepted' WHERE id=?1")
            .bind(id.value())
            .execute(&store.pool)
            .await
            .unwrap();
    }
}
