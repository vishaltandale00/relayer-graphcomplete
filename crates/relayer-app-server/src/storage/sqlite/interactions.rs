use super::{SqliteProductStore, catalog};
use crate::product::{
    AcceptedInteractionCompletion, Interaction, InteractionId, InteractionModelSelection,
    ModelFamilyId, ProviderId, ThreadId, ValidateModelSelectionCommand,
};
use crate::storage::StorageError;
use sqlx::{Row, SqliteConnection, sqlite::SqliteRow};
use std::time::{SystemTime, UNIX_EPOCH};

impl SqliteProductStore {
    pub(crate) async fn get_interaction(
        &self,
        interaction_id: InteractionId,
    ) -> Result<Option<Interaction>, StorageError> {
        let mut connection = self.pool.acquire().await?;
        sqlx::query(
            "SELECT id,thread_id,sequence,text,created_at,graph_node_id,completion_status,harness_configuration_name,harness_configuration_digest,completion_output_json,completion_error,permission_profile_id,effective_execution_digest,effective_permission_receipt_json,model_provider_id,provider_model_id,model_family_id FROM interactions WHERE id=?1",
        )
        .bind(interaction_id.value())
        .fetch_optional(&mut *connection)
        .await?
        .as_ref()
        .map(interaction_from_row)
        .transpose()
    }

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
    ) -> Result<Interaction, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let (previous_timestamp, permission_profile_id, harness_id): (String, String, String) =
            sqlx::query_as("SELECT updated_at,permission_profile_id,harness_configuration_name FROM threads WHERE id=?1")
                .bind(thread_id.value())
                .fetch_one(&mut *transaction)
                .await?;
        if let Some(selection) = model_selection {
            catalog::validate_model_selection_on(
                &mut transaction,
                &ValidateModelSelectionCommand {
                    harness_id,
                    family_id: selection.family_id,
                    provider_id: selection.provider_id.clone(),
                    model_id: selection.model_id.clone(),
                },
            )
            .await?;
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
        .bind(model_selection.map(|selection| selection.provider_id.as_str()))
        .bind(model_selection.map(|selection| selection.model_id.as_str()))
        .bind(model_selection.map(|selection| selection.family_id.value()))
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
            model_selection: model_selection.cloned(),
            effective_execution_digest: None,
            effective_permission_receipt: None,
            completion_output: None,
            completion_error: None,
        };
        transaction.commit().await?;
        Ok(interaction)
    }

    pub(crate) async fn mark_interaction_running(
        &self,
        interaction_id: InteractionId,
        harness_configuration_name: &str,
    ) -> Result<(), StorageError> {
        sqlx::query("UPDATE interactions SET completion_status='running',harness_configuration_name=?1,harness_configuration_digest=NULL,effective_execution_digest=NULL,effective_permission_receipt_json=NULL,completion_output_json=NULL,completion_error=NULL WHERE id=?2")
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
        let result = sqlx::query("UPDATE interactions SET completion_status='running',harness_configuration_name=?1,harness_configuration_digest=NULL,effective_execution_digest=NULL,effective_permission_receipt_json=NULL,completion_output_json=NULL,completion_error=NULL WHERE id=?2 AND completion_status='not_started'")
            .bind(harness_configuration_name)
            .bind(interaction_id.value())
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() == 1)
    }

    pub(crate) async fn accept_interaction_completion(
        &self,
        completion: AcceptedInteractionCompletion<'_>,
    ) -> Result<(), StorageError> {
        sqlx::query("UPDATE interactions SET graph_node_id=?1,completion_status='accepted',harness_configuration_name=?2,harness_configuration_digest=?3,effective_execution_digest=?4,effective_permission_receipt_json=?5,completion_output_json=?6,completion_error=NULL WHERE id=?7")
            .bind(completion.graph_node_id)
            .bind(completion.harness_configuration_name)
            .bind(completion.harness_configuration_digest)
            .bind(completion.effective_execution_digest)
            .bind(serde_json::to_string(completion.effective_permission_receipt).map_err(|error| StorageError::Serialization(error.to_string()))?)
            .bind(serde_json::to_string(completion.output).map_err(|error| StorageError::Serialization(error.to_string()))?)
            .bind(completion.interaction_id.value())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub(crate) async fn fail_interaction_completion(
        &self,
        interaction_id: InteractionId,
        harness_configuration_name: &str,
        error: &str,
    ) -> Result<(), StorageError> {
        sqlx::query("UPDATE interactions SET completion_status='failed',harness_configuration_name=?1,completion_error=?2 WHERE id=?3")
            .bind(harness_configuration_name)
            .bind(error)
            .bind(interaction_id.value())
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

pub(super) async fn fetch_interactions(
    connection: &mut SqliteConnection,
    thread_id: ThreadId,
) -> Result<Vec<Interaction>, StorageError> {
    let rows = sqlx::query(
        "SELECT id,thread_id,sequence,text,created_at,graph_node_id,completion_status,harness_configuration_name,harness_configuration_digest,completion_output_json,completion_error,permission_profile_id,effective_execution_digest,effective_permission_receipt_json,model_provider_id,provider_model_id,model_family_id FROM interactions WHERE thread_id=?1 ORDER BY sequence ASC",
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

fn interaction_model_selection_from_row(
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
