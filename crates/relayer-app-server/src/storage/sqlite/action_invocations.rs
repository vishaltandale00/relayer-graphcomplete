use super::{SqliteProductStore, catalog, interactions};
use crate::product::{
    ActionInvocation, CatalogError, Interaction, InteractionId, InteractionModelSelection,
    ModelFamilyId, ProviderId, ThreadId,
};
use crate::storage::{ActionInvocationInsertOutcome, StorageError};
use sqlx::{Row, SqliteConnection, sqlite::SqliteRow};

impl SqliteProductStore {
    pub(crate) async fn invocation_graph_source(
        &self,
        result_interaction_id: InteractionId,
    ) -> Result<Option<(i64, i64)>, StorageError> {
        sqlx::query_as(
            "SELECT source.graph_node_id,ai.action_id FROM action_invocations ai JOIN interactions source ON source.id=ai.source_interaction_id WHERE ai.result_interaction_id=?1 AND source.completion_status='accepted' AND source.graph_node_id IS NOT NULL",
        )
        .bind(result_interaction_id.value())
        .fetch_optional(&self.pool)
        .await
        .map_err(Into::into)
    }

    pub(crate) async fn interrupted_interactions(&self) -> Result<Vec<Interaction>, StorageError> {
        let rows = sqlx::query(
            "SELECT i.id,i.thread_id,i.sequence,i.text,i.created_at,i.graph_node_id,i.completion_status,i.harness_configuration_name,i.harness_configuration_digest,i.completion_output_json,i.completion_error,i.permission_profile_id,i.effective_execution_digest,i.effective_permission_receipt_json,i.model_provider_id,i.provider_model_id,i.model_family_id FROM interactions i WHERE i.completion_status IN ('not_started','running','submitted') ORDER BY i.id",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(interactions::interaction_from_row)
            .collect()
    }

    pub(crate) async fn recover_interaction_accepted(
        &self,
        interaction_id: InteractionId,
        output: &serde_json::Value,
    ) -> Result<bool, StorageError> {
        let output = serde_json::to_string(output)
            .map_err(|error| StorageError::Serialization(error.to_string()))?;
        let result = sqlx::query("UPDATE interactions SET completion_status='accepted',completion_output_json=?1,completion_error=NULL WHERE id=?2 AND graph_node_id IS NOT NULL AND harness_configuration_name IS NOT NULL AND harness_configuration_digest IS NOT NULL AND effective_execution_digest IS NOT NULL AND effective_permission_receipt_json IS NOT NULL AND completion_status IN ('not_started','running','submitted')")
            .bind(output)
            .bind(interaction_id.value())
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() == 1)
    }

    pub(crate) async fn permits_unselected_action_execution(
        &self,
        result_interaction_id: InteractionId,
    ) -> Result<bool, StorageError> {
        sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM action_invocations ai JOIN interactions source ON source.id=ai.source_interaction_id JOIN interactions result ON result.id=ai.result_interaction_id AND result.thread_id=source.thread_id WHERE result.id=?1 AND result.model_provider_id IS NULL AND result.provider_model_id IS NULL AND result.model_family_id IS NULL AND source.completion_status='accepted' AND source.graph_node_id IS NOT NULL AND source.model_provider_id IS NULL AND source.provider_model_id IS NULL AND source.model_family_id IS NULL)",
        )
        .bind(result_interaction_id.value())
        .fetch_one(&self.pool)
        .await
        .map_err(Into::into)
    }

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

        let source = sqlx::query("SELECT i.thread_id,t.permission_profile_id,t.harness_configuration_name,i.model_provider_id,i.provider_model_id,i.model_family_id,i.completion_status,i.graph_node_id FROM interactions i JOIN threads t ON t.id=i.thread_id WHERE i.id=?1")
            .bind(source_interaction_id.value())
            .fetch_one(&mut *transaction)
            .await?;
        let thread_id = ThreadId::from_database(source.try_get("thread_id")?);
        let permission_profile_id: String = source.try_get("permission_profile_id")?;
        let harness_id: String = source.try_get("harness_configuration_name")?;
        let model_provider_id: Option<String> = source.try_get("model_provider_id")?;
        let provider_model_id: Option<String> = source.try_get("provider_model_id")?;
        let model_family_id: Option<i64> = source.try_get("model_family_id")?;
        let interaction_in_progress: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM interactions WHERE thread_id=?1 AND completion_status IN ('not_started','running','submitted'))",
        )
        .bind(thread_id.value())
        .fetch_one(&mut *transaction)
        .await?;
        if interaction_in_progress {
            return Err(StorageError::Catalog(CatalogError::invalid(
                "interaction_in_progress",
                "Wait for the active interaction to finish.",
            )));
        }
        let source_accepted: bool = source.try_get::<String, _>("completion_status")? == "accepted"
            && source.try_get::<Option<i64>, _>("graph_node_id")?.is_some();
        let model_selection = match (model_provider_id, provider_model_id, model_family_id) {
            (Some(provider_id), Some(model_id), Some(family_id)) if family_id > 0 => {
                Some(InteractionModelSelection {
                    family_id: ModelFamilyId::from_database(family_id),
                    provider_id: ProviderId::from_database(provider_id),
                    model_id,
                })
            }
            // Accepted pre-selector interactions have no provider/model columns. Their pinned
            // thread harness remains the only execution authority; ordinary callers still
            // cannot supply a raw harness override.
            (None, None, None) if source_accepted => None,
            _ => {
                return Err(StorageError::Catalog(CatalogError::invalid(
                    "source_model_selection_missing",
                    "The source interaction has no model selection to inherit.",
                )));
            }
        };
        if let Some(selection) = model_selection.as_ref() {
            catalog::validate_execution_model_selection_on(
                &mut transaction,
                &harness_id,
                selection,
            )
            .await?;
        }
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
        let interaction = Interaction {
            id: InteractionId::from_database(result.last_insert_rowid()),
            thread_id,
            sequence,
            text: text.to_owned(),
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
        "SELECT ai.source_interaction_id,ai.action_id,ai.result_interaction_id,ai.created_at
         FROM action_invocations ai
         JOIN interactions source ON source.id=ai.source_interaction_id
         JOIN threads source_thread ON source_thread.id=source.thread_id
         JOIN threads requested_thread ON requested_thread.id=?1
         WHERE source.thread_id=?1
            OR (requested_thread.project_id IS NOT NULL
                AND source_thread.project_id=requested_thread.project_id)
         ORDER BY source_thread.id,source.sequence,ai.action_id",
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
        "SELECT id,thread_id,sequence,text,created_at,graph_node_id,completion_status,harness_configuration_name,harness_configuration_digest,completion_output_json,completion_error,permission_profile_id,effective_execution_digest,effective_permission_receipt_json,model_provider_id,provider_model_id,model_family_id FROM interactions WHERE id=?1",
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
    use crate::storage::NewThreadRecord;
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
        seed_test_model_selection(&store).await;
        let model_selection = InteractionModelSelection {
            family_id: ModelFamilyId::from_database(1),
            provider_id: ProviderId::parse("codex").unwrap(),
            model_id: "test-model".into(),
        };
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                title: "Action source",
                project_id: None,
                initial_message: "Original prompt",
                harness_configuration_name: "codex-basic",
                permission_profile_id: "auto",
                model_selection: Some(&model_selection),
                timestamp: "1",
            })
            .await
            .unwrap();
        mark_interaction_accepted(&store, thread.root_interaction_id).await;

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
        assert_eq!(replay_interaction.model_selection, Some(model_selection));
        assert!(
            reopened
                .fail_interaction_completion(replay_interaction.id, "codex-basic", "test failure")
                .await
                .unwrap()
        );
        assert!(
            !reopened
                .fail_interaction_completion(replay_interaction.id, "codex-basic", "late failure")
                .await
                .unwrap()
        );
        assert!(
            !reopened
                .fail_interaction_completion(
                    thread.root_interaction_id,
                    "codex-basic",
                    "must not overwrite accepted",
                )
                .await
                .unwrap()
        );
        reopened.pool.close().await;
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn migrated_source_without_model_selection_preserves_action_execution() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "relayer-legacy-action-invocation-{}-{unique}.sqlite3",
            std::process::id()
        ));
        let store = SqliteProductStore::open(&path).await.unwrap();
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                title: "Legacy source",
                project_id: None,
                initial_message: "Original prompt",
                harness_configuration_name: "codex-basic",
                permission_profile_id: "auto",
                model_selection: None,
                timestamp: "1",
            })
            .await
            .unwrap();
        mark_interaction_accepted(&store, thread.root_interaction_id).await;

        let outcome = store
            .insert_action_invocation(thread.root_interaction_id, 41, "Migrated follow-up")
            .await
            .unwrap();
        let interaction = match outcome {
            ActionInvocationInsertOutcome::Created { interaction, .. } => interaction,
            ActionInvocationInsertOutcome::Existing { .. } => panic!("first invocation existed"),
        };
        assert_eq!(interaction.model_selection, None);
        assert!(
            store
                .permits_unselected_action_execution(interaction.id)
                .await
                .unwrap()
        );
        assert!(
            !store
                .permits_unselected_action_execution(thread.root_interaction_id)
                .await
                .unwrap()
        );
        assert_eq!(store.list_interactions(thread.id).await.unwrap().len(), 2);

        store.pool.close().await;
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn configuration_owned_source_can_invoke_without_a_model_selection() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "relayer-configuration-action-invocation-{}-{unique}.sqlite3",
            std::process::id()
        ));
        let store = SqliteProductStore::open(&path).await.unwrap();
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                title: "Configuration-owned source",
                project_id: None,
                initial_message: "Original prompt",
                harness_configuration_name: "prime-agent-basic",
                permission_profile_id: "auto",
                model_selection: None,
                timestamp: "1",
            })
            .await
            .unwrap();
        mark_interaction_accepted(&store, thread.root_interaction_id).await;

        let outcome = store
            .insert_action_invocation(
                thread.root_interaction_id,
                41,
                "Configuration-owned follow-up",
            )
            .await
            .unwrap();
        let interaction = match outcome {
            ActionInvocationInsertOutcome::Created { interaction, .. } => interaction,
            ActionInvocationInsertOutcome::Existing { .. } => panic!("first invocation existed"),
        };
        assert_eq!(interaction.model_selection, None);

        store.pool.close().await;
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn historical_action_survives_family_deletion() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "relayer-deleted-family-action-invocation-{}-{unique}.sqlite3",
            std::process::id()
        ));
        let store = SqliteProductStore::open(&path).await.unwrap();
        seed_test_model_selection(&store).await;
        sqlx::query("INSERT INTO model_families(id,name,kind,enabled,position) VALUES (2,'Historical','custom',1,1)")
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO model_family_members(family_id,position,provider_id,model_id) VALUES (2,0,'codex','test-model')")
            .execute(&store.pool)
            .await
            .unwrap();
        let model_selection = InteractionModelSelection {
            family_id: ModelFamilyId::from_database(2),
            provider_id: ProviderId::parse("codex").unwrap(),
            model_id: "test-model".into(),
        };
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                title: "Historical source",
                project_id: None,
                initial_message: "Original prompt",
                harness_configuration_name: "codex-basic",
                permission_profile_id: "auto",
                model_selection: Some(&model_selection),
                timestamp: "1",
            })
            .await
            .unwrap();
        mark_interaction_accepted(&store, thread.root_interaction_id).await;
        assert!(
            store
                .delete_model_family(ModelFamilyId::from_database(2))
                .await
                .unwrap()
        );

        let outcome = store
            .insert_action_invocation(thread.root_interaction_id, 41, "Historical follow-up")
            .await
            .unwrap();
        let interaction = match outcome {
            ActionInvocationInsertOutcome::Created { interaction, .. } => interaction,
            ActionInvocationInsertOutcome::Existing { .. } => panic!("first invocation existed"),
        };
        assert_eq!(interaction.model_selection, Some(model_selection));

        store.pool.close().await;
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn historical_action_can_reuse_a_hidden_available_model() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "relayer-hidden-model-action-invocation-{}-{unique}.sqlite3",
            std::process::id()
        ));
        let store = SqliteProductStore::open(&path).await.unwrap();
        seed_test_model_selection(&store).await;
        let model_selection = InteractionModelSelection {
            family_id: ModelFamilyId::from_database(1),
            provider_id: ProviderId::parse("codex").unwrap(),
            model_id: "test-model".into(),
        };
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                title: "Historical hidden model",
                project_id: None,
                initial_message: "Original prompt",
                harness_configuration_name: "codex-basic",
                permission_profile_id: "auto",
                model_selection: Some(&model_selection),
                timestamp: "1",
            })
            .await
            .unwrap();
        mark_interaction_accepted(&store, thread.root_interaction_id).await;
        sqlx::query(
            "UPDATE provider_models SET visible=0 WHERE provider_id='codex' AND model_id='test-model'",
        )
        .execute(&store.pool)
        .await
        .unwrap();

        let selection_error = store
            .validate_model_selection(&crate::product::ValidateModelSelectionCommand {
                harness_id: "codex-basic".into(),
                family_id: model_selection.family_id,
                provider_id: model_selection.provider_id.clone(),
                model_id: model_selection.model_id.clone(),
            })
            .await
            .err()
            .unwrap();
        match selection_error {
            StorageError::Catalog(error) => assert_eq!(error.code(), "model_hidden"),
            other => panic!("unexpected error: {other}"),
        }

        let outcome = store
            .insert_action_invocation(thread.root_interaction_id, 41, "Historical follow-up")
            .await
            .unwrap();
        let interaction = match outcome {
            ActionInvocationInsertOutcome::Created { interaction, .. } => interaction,
            ActionInvocationInsertOutcome::Existing { .. } => panic!("first invocation existed"),
        };
        assert_eq!(interaction.model_selection, Some(model_selection));

        store.pool.close().await;
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn stale_provider_catalog_blocks_action_before_insertion() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "relayer-stale-catalog-action-invocation-{}-{unique}.sqlite3",
            std::process::id()
        ));
        let store = SqliteProductStore::open(&path).await.unwrap();
        seed_test_model_selection(&store).await;
        let model_selection = InteractionModelSelection {
            family_id: ModelFamilyId::from_database(1),
            provider_id: ProviderId::parse("codex").unwrap(),
            model_id: "test-model".into(),
        };
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                title: "Stale source",
                project_id: None,
                initial_message: "Original prompt",
                harness_configuration_name: "codex-basic",
                permission_profile_id: "auto",
                model_selection: Some(&model_selection),
                timestamp: "1",
            })
            .await
            .unwrap();
        mark_interaction_accepted(&store, thread.root_interaction_id).await;
        sqlx::query("UPDATE model_providers SET refreshed_at='0' WHERE id='codex'")
            .execute(&store.pool)
            .await
            .unwrap();

        let error = store
            .insert_action_invocation(thread.root_interaction_id, 41, "Must not persist")
            .await
            .err()
            .unwrap();
        match error {
            StorageError::Catalog(error) => assert_eq!(error.code(), "provider_catalog_stale"),
            other => panic!("unexpected error: {other}"),
        }
        assert_eq!(store.list_interactions(thread.id).await.unwrap().len(), 1);

        store.pool.close().await;
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn active_turn_blocks_a_second_action_interaction() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "relayer-active-turn-action-invocation-{}-{unique}.sqlite3",
            std::process::id()
        ));
        let store = SqliteProductStore::open(&path).await.unwrap();
        seed_test_model_selection(&store).await;
        let model_selection = InteractionModelSelection {
            family_id: ModelFamilyId::from_database(1),
            provider_id: ProviderId::parse("codex").unwrap(),
            model_id: "test-model".into(),
        };
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                title: "Action source",
                project_id: None,
                initial_message: "Original prompt",
                harness_configuration_name: "codex-basic",
                permission_profile_id: "auto",
                model_selection: Some(&model_selection),
                timestamp: "1",
            })
            .await
            .unwrap();
        mark_interaction_accepted(&store, thread.root_interaction_id).await;
        sqlx::query("INSERT INTO interactions(thread_id,sequence,text,created_at,completion_status,permission_profile_id,model_provider_id,provider_model_id,model_family_id) VALUES (?1,2,'Running turn','2','running','auto','codex','test-model',1)")
            .bind(thread.id.value())
            .execute(&store.pool)
            .await
            .unwrap();

        let error = store
            .insert_action_invocation(thread.root_interaction_id, 41, "Must wait")
            .await
            .err()
            .unwrap();
        match error {
            StorageError::Catalog(error) => assert_eq!(error.code(), "interaction_in_progress"),
            other => panic!("unexpected error: {other}"),
        }
        assert_eq!(store.list_interactions(thread.id).await.unwrap().len(), 2);

        store.pool.close().await;
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn hidden_available_model_remains_runnable_for_historical_actions() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "relayer-hidden-model-action-invocation-{}-{unique}.sqlite3",
            std::process::id()
        ));
        let store = SqliteProductStore::open(&path).await.unwrap();
        seed_test_model_selection(&store).await;
        let model_selection = InteractionModelSelection {
            family_id: ModelFamilyId::from_database(1),
            provider_id: ProviderId::parse("codex").unwrap(),
            model_id: "test-model".into(),
        };
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                title: "Historical hidden model",
                project_id: None,
                initial_message: "Original prompt",
                harness_configuration_name: "codex-basic",
                permission_profile_id: "auto",
                model_selection: Some(&model_selection),
                timestamp: "1",
            })
            .await
            .unwrap();
        mark_interaction_accepted(&store, thread.root_interaction_id).await;
        sqlx::query("UPDATE provider_models SET visible=0 WHERE provider_id='codex' AND model_id='test-model'")
            .execute(&store.pool)
            .await
            .unwrap();

        let outcome = store
            .insert_action_invocation(thread.root_interaction_id, 41, "Historical follow-up")
            .await
            .unwrap();
        let interaction = match outcome {
            ActionInvocationInsertOutcome::Created { interaction, .. } => interaction,
            ActionInvocationInsertOutcome::Existing { .. } => panic!("first invocation existed"),
        };
        assert_eq!(interaction.model_selection, Some(model_selection));

        store.pool.close().await;
        std::fs::remove_file(path).unwrap();
    }

    async fn seed_test_model_selection(store: &SqliteProductStore) {
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
        sqlx::query("INSERT INTO provider_models(provider_id,model_id,label,provider_order,visible,available,provider_default,metadata_json) VALUES ('codex','test-model','Test model',0,1,1,1,'{}')")
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE product_harnesses SET available=1,unavailable_reason_code=NULL,unavailable_reason_message=NULL WHERE configuration_name='codex-basic'")
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO model_families(id,name,kind,system_key,enabled,position) VALUES (1,'Codex','system','codex',1,0)")
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO model_family_members(family_id,position,provider_id,model_id) VALUES (1,0,'codex','test-model')")
            .execute(&store.pool)
            .await
            .unwrap();
    }

    async fn mark_interaction_accepted(store: &SqliteProductStore, id: InteractionId) {
        sqlx::query(
            "UPDATE interactions SET completion_status='accepted',graph_node_id=COALESCE(graph_node_id,777) WHERE id=?1",
        )
            .bind(id.value())
            .execute(&store.pool)
            .await
            .unwrap();
    }
}
