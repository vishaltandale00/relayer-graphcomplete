use super::{SqliteProductStore, interactions};
use crate::product::{ActionInvocation, Interaction, InteractionId, ThreadId};
use crate::storage::{ActionInvocationInsertOutcome, StorageError};
use sqlx::{Row, SqliteConnection, sqlite::SqliteRow};

impl SqliteProductStore {
    pub(crate) async fn get_action_invocation(
        &self,
        source_interaction_id: InteractionId,
        action_id: i64,
    ) -> Result<Option<(ActionInvocation, Interaction)>, StorageError> {
        let mut connection = self.pool.acquire().await?;
        existing(&mut connection, source_interaction_id, action_id).await
    }

    pub(crate) async fn recover_interrupted_action_invocations(
        &self,
        error: &str,
    ) -> Result<u64, StorageError> {
        // One-shot actions cannot be resumed yet. Make interrupted work terminal so the UI does
        // not poll forever; future retry semantics can replace this startup recovery policy.
        let result = sqlx::query(
            "UPDATE interactions SET completion_status='failed',completion_error=?1 WHERE id IN (SELECT result_interaction_id FROM action_invocations) AND completion_status IN ('not_started','running','submitted')",
        )
        .bind(error)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }

    pub(crate) async fn insert_action_invocation(
        &self,
        source_interaction_id: InteractionId,
        action_id: i64,
        text: &str,
    ) -> Result<ActionInvocationInsertOutcome, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        if let Some((invocation, interaction)) =
            existing(&mut transaction, source_interaction_id, action_id).await?
        {
            transaction.commit().await?;
            return Ok(ActionInvocationInsertOutcome::Existing {
                invocation,
                interaction,
            });
        }

        let source = sqlx::query("SELECT thread_id FROM interactions WHERE id=?1")
            .bind(source_interaction_id.value())
            .fetch_one(&mut *transaction)
            .await?;
        let thread_id = ThreadId::from_database(source.try_get("thread_id")?);
        let previous_timestamp: String =
            sqlx::query_scalar("SELECT updated_at FROM threads WHERE id=?1")
                .bind(thread_id.value())
                .fetch_one(&mut *transaction)
                .await?;
        let timestamp = interactions::monotonic_timestamp(&previous_timestamp);
        let sequence: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(sequence),0)+1 FROM interactions WHERE thread_id=?1",
        )
        .bind(thread_id.value())
        .fetch_one(&mut *transaction)
        .await?;
        let result = sqlx::query(
            "INSERT INTO interactions(thread_id,sequence,text,created_at) VALUES (?1,?2,?3,?4)",
        )
        .bind(thread_id.value())
        .bind(sequence)
        .bind(text)
        .bind(&timestamp)
        .execute(&mut *transaction)
        .await?;
        let interaction = Interaction {
            id: InteractionId::from_database(result.last_insert_rowid()),
            thread_id,
            sequence,
            text: text.to_owned(),
            graph_node_id: None,
            completion_status: "not_started".into(),
            harness_configuration_name: None,
            harness_configuration_digest: None,
            completion_output: None,
            completion_error: None,
            created_at: timestamp.clone(),
        };
        sqlx::query(
            "INSERT INTO action_invocations(source_interaction_id,action_id,result_interaction_id,created_at) VALUES (?1,?2,?3,?4)",
        )
        .bind(source_interaction_id.value())
        .bind(action_id)
        .bind(interaction.id.value())
        .bind(&timestamp)
        .execute(&mut *transaction)
        .await?;
        sqlx::query("UPDATE threads SET updated_at=?1 WHERE id=?2")
            .bind(&timestamp)
            .bind(thread_id.value())
            .execute(&mut *transaction)
            .await?;
        let invocation = ActionInvocation {
            source_interaction_id,
            action_id,
            result_interaction_id: interaction.id,
            created_at: timestamp,
        };
        transaction.commit().await?;
        Ok(ActionInvocationInsertOutcome::Created {
            invocation,
            interaction,
        })
    }
}

pub(super) async fn fetch_action_invocations(
    connection: &mut SqliteConnection,
    thread_id: ThreadId,
) -> Result<Vec<ActionInvocation>, StorageError> {
    let rows = sqlx::query(
        "SELECT ai.source_interaction_id,ai.action_id,ai.result_interaction_id,ai.created_at FROM action_invocations ai JOIN interactions source ON source.id=ai.source_interaction_id WHERE source.thread_id=?1 ORDER BY source.sequence,ai.action_id",
    )
    .bind(thread_id.value())
    .fetch_all(connection)
    .await?;
    rows.iter().map(invocation_from_row).collect()
}

async fn existing(
    connection: &mut SqliteConnection,
    source_interaction_id: InteractionId,
    action_id: i64,
) -> Result<Option<(ActionInvocation, Interaction)>, StorageError> {
    let Some(row) = sqlx::query(
        "SELECT source_interaction_id,action_id,result_interaction_id,created_at FROM action_invocations WHERE source_interaction_id=?1 AND action_id=?2",
    )
    .bind(source_interaction_id.value())
    .bind(action_id)
    .fetch_optional(&mut *connection)
    .await?
    else {
        return Ok(None);
    };
    let invocation = invocation_from_row(&row)?;
    let interaction = sqlx::query(
        "SELECT id,thread_id,sequence,text,created_at,graph_node_id,completion_status,harness_configuration_name,harness_configuration_digest,completion_output_json,completion_error FROM interactions WHERE id=?1",
    )
    .bind(invocation.result_interaction_id.value())
    .fetch_one(&mut *connection)
    .await?;
    Ok(Some((
        invocation,
        interactions::interaction_from_row(&interaction)?,
    )))
}

fn invocation_from_row(row: &SqliteRow) -> Result<ActionInvocation, StorageError> {
    Ok(ActionInvocation {
        source_interaction_id: InteractionId::from_database(row.try_get(0)?),
        action_id: row.try_get(1)?,
        result_interaction_id: InteractionId::from_database(row.try_get(2)?),
        created_at: row.try_get(3)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[tokio::test]
    async fn one_shot_invocation_is_atomic_idempotent_and_durable() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "relayer-action-invocation-{}-{unique}.sqlite3",
            std::process::id()
        ));
        let store = SqliteProductStore::open(&path).await.unwrap();
        let thread = store
            .insert_thread_with_initial_interaction(
                "Action source",
                None,
                "Original prompt",
                "codex-basic",
                "1",
            )
            .await
            .unwrap();

        let mut attempts = tokio::task::JoinSet::new();
        for _ in 0..12 {
            let store = store.clone();
            attempts.spawn(async move {
                store
                    .insert_action_invocation(thread.root_interaction_id, 41, "Authored follow-up")
                    .await
                    .unwrap()
            });
        }
        let mut result_ids = Vec::new();
        let mut created = 0;
        while let Some(outcome) = attempts.join_next().await {
            match outcome.unwrap() {
                ActionInvocationInsertOutcome::Created { interaction, .. } => {
                    created += 1;
                    result_ids.push(interaction.id);
                }
                ActionInvocationInsertOutcome::Existing { interaction, .. } => {
                    result_ids.push(interaction.id);
                }
            }
        }
        assert_eq!(created, 1);
        assert!(result_ids.windows(2).all(|pair| pair[0] == pair[1]));
        assert_eq!(store.list_interactions(thread.id).await.unwrap().len(), 2);

        drop(store);
        let reopened = SqliteProductStore::open(&path).await.unwrap();
        let replay = reopened
            .insert_action_invocation(thread.root_interaction_id, 41, "Different text is ignored")
            .await
            .unwrap();
        let replay_interaction = match replay {
            ActionInvocationInsertOutcome::Existing {
                invocation,
                interaction,
            } => {
                assert_eq!(invocation.result_interaction_id, result_ids[0]);
                interaction
            }
            ActionInvocationInsertOutcome::Created { .. } => {
                panic!("persisted invocation was created twice")
            }
        };
        assert_eq!(replay_interaction.id, result_ids[0]);
        assert_eq!(replay_interaction.text, "Authored follow-up");
        reopened.pool.close().await;
        std::fs::remove_file(path).unwrap();
    }
}
