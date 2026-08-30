use super::SqliteProductStore;
use crate::product::{AcceptedInteractionCompletion, InteractionId};
use crate::storage::{
    CompletionExecution, CompletionExecutionBinding, CompletionExecutionPhase,
    CompletionExecutionReserveOutcome, CompletionExecutionRestartSettlement, StorageError,
};
use serde_json::Value;
use sqlx::{Row, sqlite::SqliteRow};

impl SqliteProductStore {
    pub(crate) async fn interrupted_recursive_completion_executions(
        &self,
    ) -> Result<Vec<CompletionExecution>, StorageError> {
        let rows = sqlx::query(
            "SELECT ce.interaction_id,ce.graph_completion_id,ce.harness_configuration_name,
                    ce.harness_configuration_digest,ce.model_execution_digest,
                    ce.permission_origin_digest,ce.phase,ce.attachment_json,ce.settlement_json,
                    ce.safe_reason,ce.created_at,ce.updated_at
             FROM completion_executions ce
             JOIN action_invocations ai ON ai.result_interaction_id=ce.interaction_id
             WHERE ce.phase IN ('launching','attached')
               AND ai.authoritative=1 AND ai.graph_lease_required=1
             ORDER BY ce.interaction_id",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(execution_from_row).collect()
    }

    pub(crate) async fn get_completion_execution(
        &self,
        interaction_id: InteractionId,
    ) -> Result<Option<CompletionExecution>, StorageError> {
        fetch_execution(&self.pool, interaction_id).await
    }

    pub(crate) async fn reserve_completion_execution(
        &self,
        binding: CompletionExecutionBinding<'_>,
        timestamp: &str,
    ) -> Result<CompletionExecutionReserveOutcome, StorageError> {
        validate_binding(&binding)?;
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        if let Some(existing) = fetch_execution(&mut *transaction, binding.interaction_id).await? {
            require_binding(&existing, &binding)?;
            transaction.commit().await?;
            return Ok(CompletionExecutionReserveOutcome::Existing(existing));
        }

        let bound: Option<(i64, String, String, String)> = sqlx::query_as(
            "SELECT graph_node_id,harness_configuration_name,harness_configuration_digest,effective_execution_digest
             FROM interactions
             WHERE id=?1 AND completion_status IN ('submitted','running')
               AND graph_node_id IS NOT NULL
               AND harness_configuration_name IS NOT NULL
               AND harness_configuration_digest IS NOT NULL
               AND effective_execution_digest IS NOT NULL
               AND effective_permission_receipt_json IS NOT NULL",
        )
        .bind(binding.interaction_id.value())
        .fetch_optional(&mut *transaction)
        .await?;
        let Some((graph_completion_id, harness_name, harness_digest, model_digest)) = bound else {
            return Err(conflict("interaction is not durably bound for execution"));
        };
        if graph_completion_id != binding.graph_completion_id
            || harness_name != binding.harness_configuration_name
            || harness_digest != binding.harness_configuration_digest
            || model_digest != binding.model_execution_digest
        {
            return Err(conflict(
                "execution identity does not match the durable interaction binding",
            ));
        }

        let inserted = sqlx::query(
            "INSERT INTO completion_executions(
                 interaction_id,graph_completion_id,harness_configuration_name,
                 harness_configuration_digest,model_execution_digest,permission_origin_digest,
                 phase,created_at,updated_at
             ) VALUES (?1,?2,?3,?4,?5,?6,'reserved',?7,?7)",
        )
        .bind(binding.interaction_id.value())
        .bind(binding.graph_completion_id)
        .bind(binding.harness_configuration_name)
        .bind(binding.harness_configuration_digest)
        .bind(binding.model_execution_digest)
        .bind(binding.permission_origin_digest)
        .bind(timestamp)
        .execute(&mut *transaction)
        .await;
        if let Err(sqlx::Error::Database(error)) = &inserted
            && error.is_unique_violation()
        {
            return Err(conflict(
                "graph completion is already bound to another product interaction",
            ));
        }
        inserted?;
        let execution = fetch_execution(&mut *transaction, binding.interaction_id)
            .await?
            .ok_or_else(|| StorageError::Serialization("reserved execution disappeared".into()))?;
        transaction.commit().await?;
        Ok(CompletionExecutionReserveOutcome::Created(execution))
    }

    /// Atomically claims the only transition that authorizes a provider launch.
    pub(crate) async fn claim_completion_execution_launching(
        &self,
        interaction_id: InteractionId,
        permission_origin_digest: &str,
        timestamp: &str,
    ) -> Result<bool, StorageError> {
        let result = sqlx::query(
            "UPDATE completion_executions SET phase='launching',updated_at=?1
             WHERE interaction_id=?2 AND permission_origin_digest=?3 AND phase='reserved'",
        )
        .bind(timestamp)
        .bind(interaction_id.value())
        .bind(permission_origin_digest)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 1 {
            return Ok(true);
        }
        let existing = self
            .get_completion_execution(interaction_id)
            .await?
            .ok_or_else(|| conflict("completion execution does not exist"))?;
        if existing.permission_origin_digest != permission_origin_digest {
            return Err(conflict("execution binding identity does not match"));
        }
        Ok(false)
    }

    pub(crate) async fn attach_completion_execution(
        &self,
        interaction_id: InteractionId,
        permission_origin_digest: &str,
        attachment: &Value,
        timestamp: &str,
    ) -> Result<bool, StorageError> {
        let encoded = encode_json(attachment)?;
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let existing = fetch_execution(&mut *transaction, interaction_id)
            .await?
            .ok_or_else(|| conflict("completion execution does not exist"))?;
        require_origin(&existing, permission_origin_digest)?;
        if let Some(stored) = existing.attachment.as_ref() {
            if stored == attachment {
                transaction.commit().await?;
                return Ok(false);
            }
            return Err(conflict(
                "provider attachment does not match durable history",
            ));
        }
        if existing.phase == CompletionExecutionPhase::Reserved {
            return Err(conflict(
                "provider attachment cannot precede launch ownership",
            ));
        }
        let next_phase = if existing.phase == CompletionExecutionPhase::Launching {
            "attached"
        } else {
            phase_name(existing.phase)
        };
        let result = sqlx::query(
            "UPDATE completion_executions SET attachment_json=?1,phase=?2,updated_at=?3
             WHERE interaction_id=?4 AND attachment_json IS NULL AND phase=?5",
        )
        .bind(encoded)
        .bind(next_phase)
        .bind(timestamp)
        .bind(interaction_id.value())
        .bind(phase_name(existing.phase))
        .execute(&mut *transaction)
        .await?;
        if result.rows_affected() != 1 {
            return Err(conflict(
                "provider attachment compare-and-swap lost ownership",
            ));
        }
        transaction.commit().await?;
        Ok(true)
    }

    pub(crate) async fn settle_completion_execution(
        &self,
        interaction_id: InteractionId,
        permission_origin_digest: &str,
        settlement: Option<&Value>,
        safe_reason: Option<&str>,
        timestamp: &str,
    ) -> Result<bool, StorageError> {
        if settlement.is_none() && safe_reason.is_none() {
            return Err(conflict(
                "settlement requires a result or safe failure reason",
            ));
        }
        let encoded = settlement.map(encode_json).transpose()?;
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let existing = fetch_execution(&mut *transaction, interaction_id)
            .await?
            .ok_or_else(|| conflict("completion execution does not exist"))?;
        require_origin(&existing, permission_origin_digest)?;
        if existing.phase == CompletionExecutionPhase::Settled {
            if existing.settlement.as_ref() == settlement
                && existing.safe_reason.as_deref() == safe_reason
            {
                transaction.commit().await?;
                return Ok(false);
            }
            return Err(conflict("settlement does not match durable history"));
        }
        if existing.phase == CompletionExecutionPhase::Reserved {
            return Err(conflict(
                "completion execution cannot settle before launch ownership",
            ));
        }
        let result = sqlx::query(
            "UPDATE completion_executions
             SET settlement_json=?1,safe_reason=?2,phase='settled',updated_at=?3
             WHERE interaction_id=?4 AND phase=?5 AND settlement_json IS NULL AND safe_reason IS NULL",
        )
        .bind(encoded)
        .bind(safe_reason)
        .bind(timestamp)
        .bind(interaction_id.value())
        .bind(phase_name(existing.phase))
        .execute(&mut *transaction)
        .await?;
        if result.rows_affected() != 1 {
            return Err(conflict("settlement compare-and-swap lost ownership"));
        }
        transaction.commit().await?;
        Ok(true)
    }

    /// Atomically projects one live recursive success into the product interaction and
    /// settles its provider execution. Exact retries are idempotent.
    pub(crate) async fn finalize_completion_execution_accepted(
        &self,
        completion: AcceptedInteractionCompletion<'_>,
        permission_origin_digest: &str,
        timestamp: &str,
    ) -> Result<bool, StorageError> {
        let output = encode_json(completion.output)?;
        let permission_receipt = encode_json(completion.effective_permission_receipt)?;
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let existing = fetch_execution(&mut *transaction, completion.interaction_id)
            .await?
            .ok_or_else(|| conflict("completion execution does not exist"))?;
        require_origin(&existing, permission_origin_digest)?;
        if existing.graph_completion_id != completion.graph_node_id
            || existing.harness_configuration_name != completion.harness_configuration_name
            || existing.harness_configuration_digest != completion.harness_configuration_digest
            || existing.model_execution_digest != completion.effective_execution_digest
        {
            return Err(conflict(
                "accepted completion does not match its durable execution binding",
            ));
        }
        let execution_changed = match existing.phase {
            CompletionExecutionPhase::Launching | CompletionExecutionPhase::Attached => {
                let result = sqlx::query(
                    "UPDATE completion_executions
                     SET settlement_json=?1,safe_reason=NULL,phase='settled',updated_at=?2
                     WHERE interaction_id=?3 AND permission_origin_digest=?4 AND phase=?5
                       AND settlement_json IS NULL AND safe_reason IS NULL",
                )
                .bind(&output)
                .bind(timestamp)
                .bind(completion.interaction_id.value())
                .bind(permission_origin_digest)
                .bind(phase_name(existing.phase))
                .execute(&mut *transaction)
                .await?;
                if result.rows_affected() != 1 {
                    return Err(conflict(
                        "accepted settlement compare-and-swap lost ownership",
                    ));
                }
                true
            }
            CompletionExecutionPhase::Settled => {
                if existing.settlement.as_ref() != Some(completion.output)
                    || existing.safe_reason.is_some()
                {
                    return Err(conflict(
                        "accepted settlement does not match durable history",
                    ));
                }
                false
            }
            CompletionExecutionPhase::Reserved => {
                return Err(conflict(
                    "completion execution cannot settle before launch ownership",
                ));
            }
        };
        let interaction = sqlx::query(
            "UPDATE interactions
             SET completion_status='accepted',completion_output_json=?1,completion_error=NULL
             WHERE id=?2 AND graph_node_id=?3 AND completion_status='running'
               AND harness_configuration_name=?4 AND harness_configuration_digest=?5
               AND effective_execution_digest=?6 AND effective_permission_receipt_json=?7",
        )
        .bind(&output)
        .bind(completion.interaction_id.value())
        .bind(completion.graph_node_id)
        .bind(completion.harness_configuration_name)
        .bind(completion.harness_configuration_digest)
        .bind(completion.effective_execution_digest)
        .bind(permission_receipt)
        .execute(&mut *transaction)
        .await?;
        if interaction.rows_affected() == 0 {
            let stored: Option<(String, Option<String>, Option<String>)> = sqlx::query_as(
                "SELECT completion_status,completion_output_json,completion_error
                 FROM interactions WHERE id=?1",
            )
            .bind(completion.interaction_id.value())
            .fetch_optional(&mut *transaction)
            .await?;
            if stored.as_ref() != Some(&("accepted".into(), Some(output.clone()), None)) {
                return Err(conflict(
                    "product interaction changed during accepted settlement",
                ));
            }
        }
        sqlx::query(
            "UPDATE interaction_attempts
             SET finished_at=?1,outcome='accepted',failure_category=NULL,effect_boundary='graph_write'
             WHERE interaction_id=?2 AND outcome='running'",
        )
        .bind(timestamp)
        .bind(completion.interaction_id.value())
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(execution_changed || interaction.rows_affected() == 1)
    }

    /// Atomically projects one live recursive failure into the product interaction and
    /// settles its provider execution. Exact retries are idempotent.
    pub(crate) async fn finalize_completion_execution_failed(
        &self,
        interaction_id: InteractionId,
        permission_origin_digest: &str,
        harness_configuration_name: &str,
        safe_reason: &str,
        timestamp: &str,
    ) -> Result<bool, StorageError> {
        if safe_reason.is_empty() {
            return Err(conflict("failed settlement requires a safe reason"));
        }
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let existing = fetch_execution(&mut *transaction, interaction_id)
            .await?
            .ok_or_else(|| conflict("completion execution does not exist"))?;
        require_origin(&existing, permission_origin_digest)?;
        if existing.harness_configuration_name != harness_configuration_name {
            return Err(conflict(
                "failed completion does not match its durable harness binding",
            ));
        }
        let execution_changed = match existing.phase {
            CompletionExecutionPhase::Launching | CompletionExecutionPhase::Attached => {
                let result = sqlx::query(
                    "UPDATE completion_executions
                     SET settlement_json=NULL,safe_reason=?1,phase='settled',updated_at=?2
                     WHERE interaction_id=?3 AND permission_origin_digest=?4 AND phase=?5
                       AND settlement_json IS NULL AND safe_reason IS NULL",
                )
                .bind(safe_reason)
                .bind(timestamp)
                .bind(interaction_id.value())
                .bind(permission_origin_digest)
                .bind(phase_name(existing.phase))
                .execute(&mut *transaction)
                .await?;
                if result.rows_affected() != 1 {
                    return Err(conflict(
                        "failed settlement compare-and-swap lost ownership",
                    ));
                }
                true
            }
            CompletionExecutionPhase::Settled => {
                if existing.settlement.is_some()
                    || existing.safe_reason.as_deref() != Some(safe_reason)
                {
                    return Err(conflict("failed settlement does not match durable history"));
                }
                false
            }
            CompletionExecutionPhase::Reserved => {
                return Err(conflict(
                    "completion execution cannot settle before launch ownership",
                ));
            }
        };
        let interaction = sqlx::query(
            "UPDATE interactions
             SET completion_status='failed',harness_configuration_name=COALESCE(harness_configuration_name,?1),
                 completion_output_json=NULL,completion_error=?2
             WHERE id=?3 AND graph_node_id=?4
               AND completion_status IN ('not_started','running','submitted','waiting_for_approval')",
        )
        .bind(harness_configuration_name)
        .bind(safe_reason)
        .bind(interaction_id.value())
        .bind(existing.graph_completion_id)
        .execute(&mut *transaction)
        .await?;
        if interaction.rows_affected() == 0 {
            let stored: Option<(String, Option<String>, Option<String>)> = sqlx::query_as(
                "SELECT completion_status,completion_output_json,completion_error
                 FROM interactions WHERE id=?1",
            )
            .bind(interaction_id.value())
            .fetch_optional(&mut *transaction)
            .await?;
            if stored.as_ref() != Some(&("failed".into(), None, Some(safe_reason.to_owned()))) {
                return Err(conflict(
                    "product interaction changed during failed settlement",
                ));
            }
        }
        sqlx::query(
            "UPDATE interaction_attempts
             SET finished_at=?1,outcome='execution_failed',failure_category='recursive_completion',effect_boundary='unknown'
             WHERE interaction_id=?2 AND outcome='running'",
        )
        .bind(timestamp)
        .bind(interaction_id.value())
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(execution_changed || interaction.rows_affected() == 1)
    }

    /// Atomically makes an interrupted recursive execution non-launchable and projects the
    /// canonical graph terminal state into the product interaction.
    pub(crate) async fn reconcile_completion_execution_on_restart(
        &self,
        interaction_id: InteractionId,
        permission_origin_digest: &str,
        settlement: CompletionExecutionRestartSettlement,
        timestamp: &str,
    ) -> Result<bool, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let existing = fetch_execution(&mut *transaction, interaction_id)
            .await?
            .ok_or_else(|| conflict("completion execution does not exist"))?;
        require_origin(&existing, permission_origin_digest)?;
        if existing.phase == CompletionExecutionPhase::Settled {
            transaction.commit().await?;
            return Ok(false);
        }
        if !matches!(
            existing.phase,
            CompletionExecutionPhase::Launching | CompletionExecutionPhase::Attached
        ) {
            return Err(conflict(
                "only a launched completion execution can be reconciled after restart",
            ));
        }

        let previous_phase = phase_name(existing.phase);
        let (settlement_json, safe_reason, status, output, error, attempt_outcome, failure) =
            match settlement {
                CompletionExecutionRestartSettlement::Accepted { output } => (
                    Some(encode_json(&output)?),
                    None,
                    "accepted",
                    Some(encode_json(&output)?),
                    None,
                    "accepted",
                    None,
                ),
                CompletionExecutionRestartSettlement::Failed { safe_reason } => {
                    if safe_reason.is_empty() {
                        return Err(conflict("restart failure requires a safe reason"));
                    }
                    (
                        None,
                        Some(safe_reason.clone()),
                        "failed",
                        None,
                        Some(safe_reason),
                        "execution_failed",
                        Some("application_restart"),
                    )
                }
            };
        let fence = sqlx::query(
            "UPDATE completion_executions
             SET settlement_json=?1,safe_reason=?2,phase='settled',updated_at=?3
             WHERE interaction_id=?4 AND permission_origin_digest=?5 AND phase=?6
               AND settlement_json IS NULL AND safe_reason IS NULL",
        )
        .bind(settlement_json)
        .bind(safe_reason)
        .bind(timestamp)
        .bind(interaction_id.value())
        .bind(permission_origin_digest)
        .bind(previous_phase)
        .execute(&mut *transaction)
        .await?;
        if fence.rows_affected() != 1 {
            return Err(conflict(
                "restart reconciliation compare-and-swap lost ownership",
            ));
        }
        let interaction = sqlx::query(
            "UPDATE interactions
             SET completion_status=?1,completion_output_json=?2,completion_error=?3
             WHERE id=?4 AND graph_node_id=?5
               AND completion_status IN ('not_started','running','submitted','waiting_for_approval')",
        )
        .bind(status)
        .bind(output)
        .bind(error)
        .bind(interaction_id.value())
        .bind(existing.graph_completion_id)
        .execute(&mut *transaction)
        .await?;
        if interaction.rows_affected() != 1 {
            return Err(conflict(
                "product interaction changed during restart reconciliation",
            ));
        }
        sqlx::query(
            "UPDATE interaction_attempts
             SET finished_at=?1,outcome=?2,failure_category=?3,effect_boundary=?4
             WHERE interaction_id=?5 AND outcome='running'",
        )
        .bind(timestamp)
        .bind(attempt_outcome)
        .bind(failure)
        .bind(if status == "accepted" {
            "graph_write"
        } else {
            "unknown"
        })
        .bind(interaction_id.value())
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(true)
    }
}

fn validate_binding(binding: &CompletionExecutionBinding<'_>) -> Result<(), StorageError> {
    if binding.graph_completion_id <= 0
        || binding.harness_configuration_name.is_empty()
        || binding.harness_configuration_digest.is_empty()
        || binding.model_execution_digest.is_empty()
        || binding.permission_origin_digest.is_empty()
    {
        return Err(conflict("execution binding identity is incomplete"));
    }
    Ok(())
}

fn require_binding(
    existing: &CompletionExecution,
    binding: &CompletionExecutionBinding<'_>,
) -> Result<(), StorageError> {
    if existing.graph_completion_id == binding.graph_completion_id
        && existing.harness_configuration_name == binding.harness_configuration_name
        && existing.harness_configuration_digest == binding.harness_configuration_digest
        && existing.model_execution_digest == binding.model_execution_digest
        && existing.permission_origin_digest == binding.permission_origin_digest
    {
        Ok(())
    } else {
        Err(conflict(
            "execution binding identity does not match durable history",
        ))
    }
}

fn require_origin(
    existing: &CompletionExecution,
    permission_origin_digest: &str,
) -> Result<(), StorageError> {
    if existing.permission_origin_digest == permission_origin_digest {
        Ok(())
    } else {
        Err(conflict("execution binding identity does not match"))
    }
}

async fn fetch_execution<'e, E>(
    executor: E,
    interaction_id: InteractionId,
) -> Result<Option<CompletionExecution>, StorageError>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    sqlx::query(
        "SELECT interaction_id,graph_completion_id,harness_configuration_name,
                harness_configuration_digest,model_execution_digest,permission_origin_digest,
                phase,attachment_json,settlement_json,safe_reason,created_at,updated_at
         FROM completion_executions WHERE interaction_id=?1",
    )
    .bind(interaction_id.value())
    .fetch_optional(executor)
    .await?
    .as_ref()
    .map(execution_from_row)
    .transpose()
}

fn execution_from_row(row: &SqliteRow) -> Result<CompletionExecution, StorageError> {
    Ok(CompletionExecution {
        interaction_id: InteractionId::from_database(row.try_get(0)?),
        graph_completion_id: row.try_get(1)?,
        harness_configuration_name: row.try_get(2)?,
        harness_configuration_digest: row.try_get(3)?,
        model_execution_digest: row.try_get(4)?,
        permission_origin_digest: row.try_get(5)?,
        phase: parse_phase(&row.try_get::<String, _>(6)?)?,
        attachment: decode_json(row.try_get(7)?)?,
        settlement: decode_json(row.try_get(8)?)?,
        safe_reason: row.try_get(9)?,
        created_at: row.try_get(10)?,
        updated_at: row.try_get(11)?,
    })
}

fn parse_phase(value: &str) -> Result<CompletionExecutionPhase, StorageError> {
    match value {
        "reserved" => Ok(CompletionExecutionPhase::Reserved),
        "launching" => Ok(CompletionExecutionPhase::Launching),
        "attached" => Ok(CompletionExecutionPhase::Attached),
        "settled" => Ok(CompletionExecutionPhase::Settled),
        _ => Err(StorageError::Serialization(format!(
            "stored completion execution phase is invalid: {value}"
        ))),
    }
}

fn phase_name(value: CompletionExecutionPhase) -> &'static str {
    match value {
        CompletionExecutionPhase::Reserved => "reserved",
        CompletionExecutionPhase::Launching => "launching",
        CompletionExecutionPhase::Attached => "attached",
        CompletionExecutionPhase::Settled => "settled",
    }
}

fn encode_json(value: &Value) -> Result<String, StorageError> {
    serde_json::to_string(value).map_err(|error| StorageError::Serialization(error.to_string()))
}

fn decode_json(value: Option<String>) -> Result<Option<Value>, StorageError> {
    value
        .map(|value| {
            serde_json::from_str(&value)
                .map_err(|error| StorageError::Serialization(error.to_string()))
        })
        .transpose()
}

fn conflict(message: impl Into<String>) -> StorageError {
    StorageError::CompletionExecutionConflict(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{CompletionExecutionReserveOutcome, NewThreadRecord};
    use serde_json::json;
    use std::path::Path;

    async fn bound_execution(path: &Path) -> (SqliteProductStore, InteractionId) {
        let store = SqliteProductStore::open(path).await.unwrap();
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                title: "Durable execution",
                project_id: None,
                initial_message: "Complete",
                harness_configuration_name: "codex-basic",
                permission_profile_id: "auto",
                model_selection: None,
                timestamp: "1",
            })
            .await
            .unwrap();
        sqlx::query(
            "UPDATE interactions SET completion_status='submitted',graph_node_id=41,
             harness_configuration_name='codex-basic',
             harness_configuration_digest='sha256:config',
             effective_execution_digest='sha256:model',
             effective_permission_receipt_json='{}' WHERE id=?1",
        )
        .bind(thread.root_interaction_id.value())
        .execute(&store.pool)
        .await
        .unwrap();
        (store, thread.root_interaction_id)
    }

    fn binding(interaction_id: InteractionId) -> CompletionExecutionBinding<'static> {
        CompletionExecutionBinding {
            interaction_id,
            graph_completion_id: 41,
            harness_configuration_name: "codex-basic",
            harness_configuration_digest: "sha256:config",
            model_execution_digest: "sha256:model",
            permission_origin_digest: "sha256:permission-origin",
        }
    }

    async fn bound_recursive_execution(path: &Path) -> (SqliteProductStore, InteractionId) {
        let (store, source_id) = bound_execution(path).await;
        sqlx::query(
            "UPDATE interactions SET completion_status='accepted',completion_output_json=?1
             WHERE id=?2",
        )
        .bind(json!({"nodeId": 41}).to_string())
        .bind(source_id.value())
        .execute(&store.pool)
        .await
        .unwrap();
        let child_id = sqlx::query(
            "INSERT INTO interactions(
                 thread_id,sequence,text,created_at,graph_node_id,completion_status,
                 harness_configuration_name,harness_configuration_digest,permission_profile_id,
                 effective_execution_digest,effective_permission_receipt_json
             ) SELECT thread_id,2,'Recursive child','2',42,'submitted','codex-basic',
                      'sha256:config',permission_profile_id,'sha256:model','{}'
                 FROM interactions WHERE id=?1",
        )
        .bind(source_id.value())
        .execute(&store.pool)
        .await
        .unwrap()
        .last_insert_rowid();
        sqlx::query(
            "INSERT INTO action_invocations(
                 source_interaction_id,action_id,result_interaction_id,created_at,
                 graph_lease_required,authoritative
             ) VALUES (?1,9,?2,'2',1,1)",
        )
        .bind(source_id.value())
        .bind(child_id)
        .execute(&store.pool)
        .await
        .unwrap();
        (store, InteractionId::from_database(child_id))
    }

    fn recursive_binding(interaction_id: InteractionId) -> CompletionExecutionBinding<'static> {
        CompletionExecutionBinding {
            graph_completion_id: 42,
            ..binding(interaction_id)
        }
    }

    #[tokio::test]
    async fn reserve_is_durable_and_exact_retry_ignores_transient_capabilities() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("product.sqlite3");
        let (store, interaction_id) = bound_execution(&path).await;
        assert!(matches!(
            store
                .reserve_completion_execution(binding(interaction_id), "2")
                .await
                .unwrap(),
            CompletionExecutionReserveOutcome::Created(_)
        ));
        assert!(
            store
                .claim_completion_execution_launching(
                    interaction_id,
                    "sha256:permission-origin",
                    "3"
                )
                .await
                .unwrap()
        );
        assert!(
            store
                .settle_completion_execution(
                    interaction_id,
                    "sha256:permission-origin",
                    None,
                    Some("provider outcome is unknown after restart"),
                    "4"
                )
                .await
                .unwrap()
        );
        store.pool.close().await;

        let reopened = SqliteProductStore::open(&path).await.unwrap();
        assert!(matches!(
            reopened
                .reserve_completion_execution(binding(interaction_id), "3")
                .await
                .unwrap(),
            CompletionExecutionReserveOutcome::Existing(_)
        ));
        let stored = reopened
            .get_completion_execution(interaction_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.created_at, "2");
        assert_eq!(stored.updated_at, "4");
        assert_eq!(stored.phase, CompletionExecutionPhase::Settled);
        assert_eq!(
            stored.safe_reason.as_deref(),
            Some("provider outcome is unknown after restart")
        );
        // Provider attachment is independent of semantic settlement and may arrive later.
        assert!(
            reopened
                .attach_completion_execution(
                    interaction_id,
                    "sha256:permission-origin",
                    &json!({"providerExecutionId": "opaque-41"}),
                    "5"
                )
                .await
                .unwrap()
        );
        assert_eq!(
            reopened
                .get_completion_execution(interaction_id)
                .await
                .unwrap()
                .unwrap()
                .phase,
            CompletionExecutionPhase::Settled
        );
        // No capability token participates in the storage API or persisted schema.
        let token_column: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('completion_executions') WHERE name LIKE '%token%'",
        )
        .fetch_one(&reopened.pool)
        .await
        .unwrap();
        assert_eq!(token_column, 0);
    }

    #[tokio::test]
    async fn reserve_rejects_conflicting_binding_identity() {
        let directory = tempfile::tempdir().unwrap();
        let (store, interaction_id) =
            bound_execution(&directory.path().join("product.sqlite3")).await;
        store
            .reserve_completion_execution(binding(interaction_id), "2")
            .await
            .unwrap();
        let mut conflicting = binding(interaction_id);
        conflicting.permission_origin_digest = "sha256:other-origin";
        assert!(matches!(
            store.reserve_completion_execution(conflicting, "3").await,
            Err(StorageError::CompletionExecutionConflict(_))
        ));
    }

    #[tokio::test]
    async fn live_acceptance_atomically_projects_interaction_and_execution() {
        let directory = tempfile::tempdir().unwrap();
        let (store, interaction_id) =
            bound_recursive_execution(&directory.path().join("product.sqlite3")).await;
        store
            .reserve_completion_execution(recursive_binding(interaction_id), "2")
            .await
            .unwrap();
        store
            .claim_completion_execution_launching(interaction_id, "sha256:permission-origin", "3")
            .await
            .unwrap();
        sqlx::query("UPDATE interactions SET completion_status='running' WHERE id=?1")
            .bind(interaction_id.value())
            .execute(&store.pool)
            .await
            .unwrap();
        let output = json!({"rootLayer":{"layer":{"id":77}}});
        let permission_receipt = json!({});
        let accepted = AcceptedInteractionCompletion {
            interaction_id,
            graph_node_id: 42,
            harness_configuration_name: "codex-basic",
            harness_configuration_digest: "sha256:config",
            effective_execution_digest: "sha256:model",
            effective_permission_receipt: &permission_receipt,
            output: &output,
        };
        assert!(
            store
                .finalize_completion_execution_accepted(accepted, "sha256:permission-origin", "4",)
                .await
                .unwrap()
        );
        let execution = store
            .get_completion_execution(interaction_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(execution.phase, CompletionExecutionPhase::Settled);
        assert_eq!(execution.settlement, Some(output.clone()));
        let interaction: (String, Option<String>) = sqlx::query_as(
            "SELECT completion_status,completion_output_json FROM interactions WHERE id=?1",
        )
        .bind(interaction_id.value())
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(interaction, ("accepted".into(), Some(output.to_string())));
    }

    #[tokio::test]
    async fn live_settlement_rolls_back_execution_when_product_projection_conflicts() {
        let directory = tempfile::tempdir().unwrap();
        let (store, interaction_id) =
            bound_recursive_execution(&directory.path().join("product.sqlite3")).await;
        store
            .reserve_completion_execution(recursive_binding(interaction_id), "2")
            .await
            .unwrap();
        store
            .claim_completion_execution_launching(interaction_id, "sha256:permission-origin", "3")
            .await
            .unwrap();
        sqlx::query(
            "UPDATE interactions SET completion_status='failed',completion_error='other' WHERE id=?1",
        )
        .bind(interaction_id.value())
        .execute(&store.pool)
        .await
        .unwrap();
        let output = json!({"rootLayer":{"layer":{"id":77}}});
        let permission_receipt = json!({});
        let result = store
            .finalize_completion_execution_accepted(
                AcceptedInteractionCompletion {
                    interaction_id,
                    graph_node_id: 42,
                    harness_configuration_name: "codex-basic",
                    harness_configuration_digest: "sha256:config",
                    effective_execution_digest: "sha256:model",
                    effective_permission_receipt: &permission_receipt,
                    output: &output,
                },
                "sha256:permission-origin",
                "4",
            )
            .await;
        assert!(matches!(
            result,
            Err(StorageError::CompletionExecutionConflict(_))
        ));
        assert_eq!(
            store
                .get_completion_execution(interaction_id)
                .await
                .unwrap()
                .unwrap()
                .phase,
            CompletionExecutionPhase::Launching
        );
    }

    #[tokio::test]
    async fn live_failure_atomically_projects_interaction_and_execution() {
        let directory = tempfile::tempdir().unwrap();
        let (store, interaction_id) =
            bound_recursive_execution(&directory.path().join("product.sqlite3")).await;
        store
            .reserve_completion_execution(recursive_binding(interaction_id), "2")
            .await
            .unwrap();
        store
            .claim_completion_execution_launching(interaction_id, "sha256:permission-origin", "3")
            .await
            .unwrap();
        sqlx::query("UPDATE interactions SET completion_status='running' WHERE id=?1")
            .bind(interaction_id.value())
            .execute(&store.pool)
            .await
            .unwrap();
        assert!(
            store
                .finalize_completion_execution_failed(
                    interaction_id,
                    "sha256:permission-origin",
                    "codex-basic",
                    "provider_failed",
                    "4",
                )
                .await
                .unwrap()
        );
        let execution = store
            .get_completion_execution(interaction_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(execution.phase, CompletionExecutionPhase::Settled);
        assert_eq!(execution.safe_reason.as_deref(), Some("provider_failed"));
        let interaction: (String, Option<String>) = sqlx::query_as(
            "SELECT completion_status,completion_error FROM interactions WHERE id=?1",
        )
        .bind(interaction_id.value())
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(
            interaction,
            ("failed".into(), Some("provider_failed".into()))
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn only_one_racer_wins_provider_launch_ownership() {
        let directory = tempfile::tempdir().unwrap();
        let (store, interaction_id) =
            bound_execution(&directory.path().join("product.sqlite3")).await;
        store
            .reserve_completion_execution(binding(interaction_id), "2")
            .await
            .unwrap();
        let mut claims = tokio::task::JoinSet::new();
        for _ in 0..16 {
            let store = store.clone();
            claims.spawn(async move {
                store
                    .claim_completion_execution_launching(
                        interaction_id,
                        "sha256:permission-origin",
                        "3",
                    )
                    .await
                    .unwrap()
            });
        }
        let mut winners = 0;
        while let Some(result) = claims.join_next().await {
            winners += usize::from(result.unwrap());
        }
        assert_eq!(winners, 1);
    }

    #[tokio::test]
    async fn attachment_and_settlement_are_idempotent_but_not_replaceable() {
        let directory = tempfile::tempdir().unwrap();
        let (store, interaction_id) =
            bound_execution(&directory.path().join("product.sqlite3")).await;
        store
            .reserve_completion_execution(binding(interaction_id), "2")
            .await
            .unwrap();
        assert!(
            store
                .claim_completion_execution_launching(
                    interaction_id,
                    "sha256:permission-origin",
                    "3"
                )
                .await
                .unwrap()
        );
        let attachment = json!({"session": "opaque-provider-id"});
        assert!(
            store
                .attach_completion_execution(
                    interaction_id,
                    "sha256:permission-origin",
                    &attachment,
                    "4"
                )
                .await
                .unwrap()
        );
        assert!(
            !store
                .attach_completion_execution(
                    interaction_id,
                    "sha256:permission-origin",
                    &json!({"session": "opaque-provider-id"}),
                    "5"
                )
                .await
                .unwrap()
        );
        assert!(matches!(
            store
                .attach_completion_execution(
                    interaction_id,
                    "sha256:permission-origin",
                    &json!({"session": "different"}),
                    "5"
                )
                .await,
            Err(StorageError::CompletionExecutionConflict(_))
        ));

        let settlement = json!({"accepted": {"nodeId": 41}});
        assert!(
            store
                .settle_completion_execution(
                    interaction_id,
                    "sha256:permission-origin",
                    Some(&settlement),
                    None,
                    "6"
                )
                .await
                .unwrap()
        );
        assert!(
            !store
                .settle_completion_execution(
                    interaction_id,
                    "sha256:permission-origin",
                    Some(&json!({"accepted": {"nodeId": 41}})),
                    None,
                    "7"
                )
                .await
                .unwrap()
        );
        assert!(matches!(
            store
                .settle_completion_execution(
                    interaction_id,
                    "sha256:permission-origin",
                    None,
                    Some("different failure"),
                    "7"
                )
                .await,
            Err(StorageError::CompletionExecutionConflict(_))
        ));
        let stored = store
            .get_completion_execution(interaction_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.phase, CompletionExecutionPhase::Settled);
        assert_eq!(stored.attachment, Some(attachment));
        assert_eq!(stored.settlement, Some(settlement));
        assert_eq!(stored.updated_at, "6");
    }

    #[tokio::test]
    async fn restart_reconciliation_makes_launched_recursive_execution_non_replayable() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("product.sqlite3");
        let (store, interaction_id) = bound_recursive_execution(&path).await;
        store
            .reserve_completion_execution(recursive_binding(interaction_id), "3")
            .await
            .unwrap();
        assert!(
            store
                .claim_completion_execution_launching(
                    interaction_id,
                    "sha256:permission-origin",
                    "4"
                )
                .await
                .unwrap()
        );
        assert_eq!(
            store
                .interrupted_recursive_completion_executions()
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(
            store
                .reconcile_completion_execution_on_restart(
                    interaction_id,
                    "sha256:permission-origin",
                    CompletionExecutionRestartSettlement::Failed {
                        safe_reason: "application_restart".into(),
                    },
                    "5",
                )
                .await
                .unwrap()
        );
        store.pool.close().await;

        let reopened = SqliteProductStore::open(&path).await.unwrap();
        assert!(
            reopened
                .interrupted_recursive_completion_executions()
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            !reopened
                .claim_completion_execution_launching(
                    interaction_id,
                    "sha256:permission-origin",
                    "6"
                )
                .await
                .unwrap()
        );
        assert!(matches!(
            reopened
                .reserve_completion_execution(recursive_binding(interaction_id), "6")
                .await
                .unwrap(),
            CompletionExecutionReserveOutcome::Existing(CompletionExecution {
                phase: CompletionExecutionPhase::Settled,
                ..
            })
        ));
        let interaction = reopened
            .get_interaction(interaction_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(interaction.graph_node_id, Some(42));
        assert_eq!(interaction.completion_status, "failed");
        assert_eq!(
            interaction.completion_error.as_deref(),
            Some("application_restart")
        );
    }

    #[tokio::test]
    async fn restart_reconciliation_atomically_recovers_canonical_acceptance() {
        let directory = tempfile::tempdir().unwrap();
        let (store, interaction_id) =
            bound_recursive_execution(&directory.path().join("product.sqlite3")).await;
        store
            .reserve_completion_execution(recursive_binding(interaction_id), "3")
            .await
            .unwrap();
        store
            .claim_completion_execution_launching(interaction_id, "sha256:permission-origin", "4")
            .await
            .unwrap();
        let output = json!({"nodeId": 42, "accepted": true});
        assert!(
            store
                .reconcile_completion_execution_on_restart(
                    interaction_id,
                    "sha256:permission-origin",
                    CompletionExecutionRestartSettlement::Accepted {
                        output: output.clone(),
                    },
                    "5",
                )
                .await
                .unwrap()
        );
        let execution = store
            .get_completion_execution(interaction_id)
            .await
            .unwrap()
            .unwrap();
        let interaction = store
            .get_interaction(interaction_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(execution.phase, CompletionExecutionPhase::Settled);
        assert_eq!(execution.settlement, Some(output.clone()));
        assert_eq!(interaction.completion_status, "accepted");
        assert_eq!(interaction.completion_output, Some(output));
    }
}
